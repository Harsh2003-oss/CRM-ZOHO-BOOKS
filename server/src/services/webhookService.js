const crypto = require('crypto');
const WebhookEvent = require('../models/WebhookEvent');
const IntegrationSync = require('../models/IntegrationSync');

/**
 * Service to handle incoming HubSpot CRM Webhooks.
 * Decouples CRM from Zoho Books: returns immediate response while durably
 * persisting events in MongoDB for background execution.
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
    const propName = event.propertyName || 'dealstage';
    const propValue = event.propertyValue || event.dealstage || 'unknown';
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
      const propName = event.propertyName || 'dealstage';
      const propValue = String(event.propertyValue || event.dealstage || '').toLowerCase().trim();

      // We initiate workflow for Closed Won deals (M1) or Go-Live confirmation events (M2)
      const isClosedWon = propName === 'dealstage' && (propValue === 'closedwon' || propValue === 'closed won');
      const isGoLiveEvent =
        propName === 'confirmed_go_live_date' ||
        propName === 'go_live_date' ||
        (propName === 'milestone_stage' && (propValue === 'go_live_reached' || propValue === 'm2_go_live' || propValue === 'go-live'));

      const isActionable = isClosedWon || isGoLiveEvent;

      // Check for duplicate in WebhookEvent
      const existing = await WebhookEvent.findOne({ eventId });
      if (existing) {
        duplicates++;
        continue;
      }

      if (!isActionable) {
        // Save as IGNORED so we maintain an audit trail without queueing work
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
        continue;
      }

      // Valid Closed Won deal: persist as RECEIVED
      try {
        await WebhookEvent.create({
          eventId,
          source: 'CRM',
          eventType: event.subscriptionType || 'deal.propertyChange',
          status: 'RECEIVED',
          payload: event
        });

        // Upsert IntegrationSync record so the deal is tracked immediately
        if (dealId) {
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
}

module.exports = WebhookService;
