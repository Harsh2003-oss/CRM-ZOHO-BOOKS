const crypto = require('crypto');
const WebhookEvent = require('../models/WebhookEvent');
const IntegrationSync = require('../models/IntegrationSync');

/**
 * Service to handle incoming HubSpot CRM Webhooks.
 * Decouples CRM from Zoho Books: returns immediate response while durably
 * persisting events in MongoDB for background execution.
 *
 * Handles ALL HubSpot webhook subscription types:
 *   deal.creation              → seed IntegrationSync stub
 *   deal.propertyChange        → sync amount/name/stage/currency changes
 *   deal.deletion              → void Zoho records, soft-delete DB records
 *   deal.merge                 → redirect merged deal to surviving deal
 *   contact.creation           → seed CustomerMapping stub
 *   contact.propertyChange     → propagate name/email to Zoho contact
 *   contact.deletion           → soft-delete CustomerMapping
 *   company.creation           → seed CustomerMapping stub
 *   company.propertyChange     → propagate company name to Zoho
 *   company.deletion           → soft-delete CustomerMapping
 */
class WebhookService {
  /**
   * Generates a deterministic event ID to prevent duplicate event ingestion.
   */
  static generateEventId(event) {
    if (event.eventId) {
      return `hs_${event.eventId}`;
    }

    const objectId = event.objectId || event.dealId || event.id;
    const propName = event.propertyName || event.subscriptionType || 'unknown';
    const propValue = event.propertyValue || event.dealstage || event.subscriptionType || 'unknown';
    const occurredAt = event.occurredAt || event.timestamp || '';

    const raw = `${objectId}_${propName}_${propValue}_${occurredAt}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
    return `hs_${objectId}_${hash}`;
  }

  /**
   * Normalizes incoming payload into an array of events.
   * Handles both HubSpot standard webhook array and single webhook object.
   */
  static normalizePayload(body) {
    if (Array.isArray(body)) {
      return body;
    }
    if (body && typeof body === 'object') {
      return [body];
    }
    return [];
  }

  /**
   * Classifies a HubSpot webhook event into a processing category.
   * Returns: { category, isActionable }
   *   category:
   *     'CLOSED_WON'        → triggers M1 orchestration
   *     'GO_LIVE'           → triggers M2 orchestration
   *     'M3_TRIGGER'        → triggers M3 orchestration
   *     'DEAL_CREATION'     → seeds stub, no Zoho action
   *     'DEAL_UPDATE'       → property change on existing deal
   *     'DEAL_DELETION'     → delete from DB + void in Zoho
   *     'DEAL_MERGE'        → redirect archived deal to surviving
   *     'CONTACT_CREATION'  → seed customer stub
   *     'CONTACT_UPDATE'    → propagate name/email change
   *     'CONTACT_DELETION'  → soft-delete CustomerMapping
   *     'IGNORED'           → no action needed
   */
  static classifyEvent(event) {
    const subscriptionType = String(event.subscriptionType || '').toLowerCase();
    const propName = String(event.propertyName || '').toLowerCase();
    const propValue = String(event.propertyValue || event.dealstage || '').toLowerCase().trim();
    // Normalized version for matching patterns with spaces/dashes (e.g. "closed won" → "closedwon")
    const propValueNorm = propValue.replace(/[\s-]+/g, '');

    // --- DEAL EVENTS ---
    if (subscriptionType === 'deal.creation') {
      return { category: 'DEAL_CREATION', isActionable: true };
    }

    if (subscriptionType === 'deal.deletion') {
      return { category: 'DEAL_DELETION', isActionable: true };
    }

    if (subscriptionType === 'deal.merge') {
      return { category: 'DEAL_MERGE', isActionable: true };
    }

    if (subscriptionType === 'deal.propertychange' || subscriptionType === 'deal.propertyChange' || !subscriptionType || subscriptionType === 'deal.property_change') {
      // Stage → Closed Won
      if (propName === 'dealstage' && (propValueNorm === 'closedwon' || propValue === 'closed won')) {
        return { category: 'CLOSED_WON', isActionable: true };
      }
      // Go-Live date set
      if (propName === 'confirmed_go_live_date' || propName === 'go_live_date' ||
          (propName === 'milestone_stage' && (propValue === 'go_live_reached' || propValueNorm === 'golivereached' || propValue === 'm2_go_live' || propValueNorm === 'golife'))) {
        return { category: 'GO_LIVE', isActionable: true };
      }
      // M3 trigger
      if (propName === 'milestone_stage' && (propValue === '90_days_reached' || propValueNorm === '90daysreached' || propValue === 'm3_reached' || propValueNorm === 'm3reached' || propValue === '90_days' || propValue === 'm3' || propValue === 'm3_completed' || propValueNorm === 'm3completed')) {
        return { category: 'M3_TRIGGER', isActionable: true };
      }
      // Other deal property changes worth tracking (amount, name, currency)
      const trackedProps = ['amount', 'dealname', 'deal_currency_code', 'closedate', 'dealstage'];
      if (trackedProps.includes(propName)) {
        return { category: 'DEAL_UPDATE', isActionable: true };
      }
      // Unknown property change — still seed the deal record
      return { category: 'DEAL_UPDATE', isActionable: true };
    }

    // --- CONTACT EVENTS ---
    if (subscriptionType === 'contact.creation') {
      return { category: 'CONTACT_CREATION', isActionable: true };
    }
    if (subscriptionType === 'contact.deletion') {
      return { category: 'CONTACT_DELETION', isActionable: true };
    }
    if (subscriptionType.startsWith('contact.property')) {
      return { category: 'CONTACT_UPDATE', isActionable: true };
    }

    // --- COMPANY EVENTS ---
    if (subscriptionType === 'company.creation') {
      return { category: 'CONTACT_CREATION', isActionable: true }; // same handler as contact
    }
    if (subscriptionType === 'company.deletion') {
      return { category: 'CONTACT_DELETION', isActionable: true }; // same handler
    }
    if (subscriptionType.startsWith('company.property')) {
      return { category: 'CONTACT_UPDATE', isActionable: true };
    }

    return { category: 'IGNORED', isActionable: false };
  }

  /**
   * Ingests and persists webhook events with deduplication.
   * @param {Array|Object} rawBody
   * @returns {Promise<{ accepted: number, ignored: number, duplicates: number }>}
   */
  static async processHubSpotWebhook(rawBody) {
    const events = this.normalizePayload(rawBody);
    let accepted = 0;
    let ignored = 0;
    let duplicates = 0;

    for (const event of events) {
      const eventId = this.generateEventId(event);
      const dealId = String(event.objectId || event.dealId || event.id || '');

      const { category, isActionable } = this.classifyEvent(event);

      // Check for duplicate in WebhookEvent
      const existing = await WebhookEvent.findOne({ eventId });
      if (existing) {
        duplicates++;
        continue;
      }

      if (!isActionable || category === 'IGNORED') {
        // Save as IGNORED for audit trail
        try {
          await WebhookEvent.create({
            eventId,
            source: 'CRM',
            eventType: event.subscriptionType || 'deal.propertyChange',
            status: 'IGNORED',
            payload: event,
            processedAt: new Date()
          });
          ignored++;
        } catch (err) {
          if (err.code === 11000) duplicates++;
          else throw err;
        }
        // Still seed the deal in IntegrationSync for visibility
        if (dealId && category !== 'CONTACT_DELETION' && category !== 'CONTACT_UPDATE' && category !== 'CONTACT_CREATION') {
          try {
            await IntegrationSync.findOneAndUpdate(
              { crmDealId: dealId },
              {
                $setOnInsert: {
                  crmDealId: dealId,
                  syncStatus: 'PENDING',
                  dealName: event.dealname || `Deal ${dealId}`
                }
              },
              { upsert: true, returnDocument: 'after' }
            );
          } catch (syncErr) {
            // Non-blocking
          }
        }
        continue;
      }

      // Actionable event: persist as RECEIVED for queue processing
      try {
        await WebhookEvent.create({
          eventId,
          source: 'CRM',
          eventType: event.subscriptionType || category,
          status: 'RECEIVED',
          payload: { ...event, _category: category }
        });

        // Seed IntegrationSync stub for deal events so the deal is visible immediately
        const isDealEvent = ['CLOSED_WON', 'GO_LIVE', 'M3_TRIGGER', 'DEAL_CREATION', 'DEAL_UPDATE', 'DEAL_DELETION', 'DEAL_MERGE'].includes(category);
        if (dealId && isDealEvent) {
          await IntegrationSync.findOneAndUpdate(
            { crmDealId: dealId },
            {
              $setOnInsert: {
                crmDealId: dealId,
                syncStatus: 'PENDING',
                dealName: event.dealname || `Deal ${dealId}`
              }
            },
            { upsert: true, returnDocument: 'after' }
          );
        }

        accepted++;
      } catch (err) {
        if (err.code === 11000) {
          duplicates++;
        } else {
          throw err;
        }
      }
    }

    return { accepted, ignored, duplicates, total: events.length };
  }

  /**
   * Generates a deterministic event ID for incoming Zoho Books webhooks.
   */
  static generateZohoEventId(event) {
    if (event.eventId) return `zoho_${event.eventId}`;
    const rawPayment = event.payment || event;
    const rawRefund = event.refund || event;
    const refundId = String(rawRefund.refund_id || rawRefund.refundId || event.refund_id || '').trim();
    const paymentId = String(rawPayment.payment_id || rawPayment.paymentId || event.payment_id || event.id || '').trim();
    const eventType = String(event.event_type || event.event || (refundId ? 'payment_refunded' : 'payment_created')).trim();
    const occurredAt = event.occurredAt || event.timestamp || '';

    if (refundId) {
      const raw = `ref_${refundId}_${paymentId}_${occurredAt}`;
      const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
      return `zoho_ref_${refundId}_${hash}`;
    }

    const raw = `${paymentId}_${eventType}_${occurredAt}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
    return `zoho_pay_${paymentId || hash}_${hash}`;
  }

  /**
   * Ingests and persists incoming Zoho Books webhooks with deduplication.
   */
  static async processZohoWebhook(rawBody) {
    const events = this.normalizePayload(rawBody);
    if (!events || events.length === 0) {
      const err = new Error('Invalid webhook payload: Empty payload array or object.');
      err.code = 'INVALID_PAYLOAD';
      throw err;
    }

    let accepted = 0;
    let duplicates = 0;
    let ignored = 0;

    for (const event of events) {
      const rawPayment = event.payment || event;
      const rawRefund = event.refund || event;
      const paymentId = rawPayment.payment_id || rawPayment.paymentId || event.payment_id || event.id;
      const refundId = rawRefund.refund_id || rawRefund.refundId || event.refund_id;

      if (!paymentId && !refundId) {
        ignored++;
        continue;
      }

      const eventId = this.generateZohoEventId(event);
      const existing = await WebhookEvent.findOne({ eventId });
      if (existing) {
        duplicates++;
        continue;
      }

      const eventType = String(event.event_type || event.event || (refundId ? 'payment_refunded' : 'payment_created')).trim();

      try {
        await WebhookEvent.create({
          eventId,
          source: 'ZOHO_BOOKS',
          eventType,
          status: 'RECEIVED',
          payload: event
        });
        accepted++;
      } catch (err) {
        if (err.code === 11000) {
          duplicates++;
        } else {
          throw err;
        }
      }
    }

    if (accepted === 0 && duplicates === 0 && ignored > 0) {
      const err = new Error('No valid payment or refund identifier found in webhook payload.');
      err.code = 'INVALID_PAYLOAD';
      throw err;
    }

    return { accepted, ignored, duplicates, total: events.length };
  }
}

module.exports = WebhookService;

