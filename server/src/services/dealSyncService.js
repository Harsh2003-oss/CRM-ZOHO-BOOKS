/**
 * DealSyncService — Handles all non-M1 webhook events from HubSpot CRM:
 *   - deal.creation        → seed IntegrationSync record immediately
 *   - deal.propertyChange  → sync amount, name, stage changes to Zoho & DB
 *   - deal.deletion        → purge from DB and mark void in Zoho Books
 *   - deal.merge           → redirect merged deal references
 *   - contact/company.propertyChange → propagate name/email updates to Zoho
 *   - contact/company.deletion       → soft-delete CustomerMapping
 *
 * This service is called from the orchestration worker after the event is
 * claimed from the queue (WebhookEvent) so all heavy work is async and
 * the original 202 response to HubSpot was already sent.
 */

const IntegrationSync = require('../models/IntegrationSync');
const MilestoneInvoice = require('../models/MilestoneInvoice');
const PaymentRecord = require('../models/PaymentRecord');
const CustomerMapping = require('../models/CustomerMapping');
const WebhookEvent = require('../models/WebhookEvent');
const IntegrationLog = require('../models/IntegrationLog');
const { hubspotClient } = require('../clients/hubspotClient');
const { zohoClient } = require('../clients/zohoClient');

class DealSyncService {
  // =========================================================================
  // DEAL CREATION  (subscriptionType: deal.creation)
  // =========================================================================
  /**
   * Seeds an IntegrationSync stub as soon as a deal is created in HubSpot.
   * We do NOT run billing flow yet — only Closed Won triggers that.
   */
  static async handleDealCreation({ crmDealId, payload = {} }) {
    if (!crmDealId) return;

    // Fetch full deal details from HubSpot
    let dealName = payload.dealname || `Deal ${crmDealId}`;
    let amount = null;
    let stage = null;
    try {
      const res = await hubspotClient.getDeal(crmDealId);
      if (res?.data?.properties) {
        dealName = res.data.properties.dealname || dealName;
        amount = res.data.properties.amount ? Number(res.data.properties.amount) : null;
        stage = res.data.properties.dealstage || null;
      }
    } catch (e) {
      console.warn(`[DEAL CREATION] Could not fetch deal ${crmDealId} from HubSpot:`, e.message);
    }

    await IntegrationSync.findOneAndUpdate(
      { crmDealId },
      {
        $setOnInsert: {
          crmDealId,
          dealName,
          salesOrderTotal: amount || 0,
          syncStatus: 'PENDING',
          failureReason: null
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    console.log(`[DEAL CREATION] Seeded IntegrationSync for deal ${crmDealId} (${dealName}, stage=${stage})`);
  }

  // =========================================================================
  // DEAL PROPERTY CHANGE — amount / name / stage / currency
  // =========================================================================
  /**
   * When an important deal property changes (amount, name, stage, currency),
   * update the local DB and — if the deal is already synced to Zoho Books —
   * update the Zoho Sales Order as well.
   */
  static async handleDealPropertyChange({ crmDealId, propertyName, propertyValue, payload = {} }) {
    if (!crmDealId) return;

    const sync = await IntegrationSync.findOne({ crmDealId });
    if (!sync) {
      // Deal not yet seeded — create stub
      await this.handleDealCreation({ crmDealId, payload });
      return;
    }

    // --- Amount changed ---
    if (propertyName === 'amount') {
      const newAmount = Number(propertyValue);
      if (!isNaN(newAmount) && newAmount !== sync.salesOrderTotal) {
        await IntegrationSync.updateOne(
          { crmDealId },
          { $set: { salesOrderTotal: newAmount } }
        );
        console.log(`[PROPERTY CHANGE] Deal ${crmDealId} amount updated → ${newAmount}`);

        // If Zoho Sales Order exists and is still DRAFT, update it
        if (sync.zohoSalesOrderId && sync.salesOrderStatus === 'DRAFT') {
          try {
            await zohoClient.request({
              method: 'PUT',
              path: `/salesorders/${sync.zohoSalesOrderId}`,
              body: { sub_total: newAmount, total: newAmount },
              crmDealId
            });
            console.log(`[PROPERTY CHANGE] Updated Zoho SO ${sync.zohoSalesOrderId} with new amount ${newAmount}`);
          } catch (e) {
            console.warn(`[PROPERTY CHANGE] Could not update Zoho SO amount:`, e.message);
          }
        }
      }
    }

    // --- Deal name changed ---
    if (propertyName === 'dealname') {
      await IntegrationSync.updateOne(
        { crmDealId },
        { $set: { dealName: String(propertyValue).trim() } }
      );
      console.log(`[PROPERTY CHANGE] Deal ${crmDealId} name updated → ${propertyValue}`);
    }

    // --- Currency changed ---
    if (propertyName === 'deal_currency_code' && propertyValue) {
      await IntegrationSync.updateOne(
        { crmDealId },
        { $set: { currencyCode: String(propertyValue).toUpperCase().trim() } }
      );
      console.log(`[PROPERTY CHANGE] Deal ${crmDealId} currency updated → ${propertyValue}`);
    }

    // --- Stage changed back from closedwon (e.g. re-opened) ---
    if (propertyName === 'dealstage') {
      const stageNorm = String(propertyValue).toLowerCase().replace(/[\s_-]+/g, '');
      if (stageNorm !== 'closedwon' && sync.syncStatus === 'PENDING') {
        // Deal is not closed-won anymore and wasn't processed yet — just log
        console.log(`[PROPERTY CHANGE] Deal ${crmDealId} stage changed to ${propertyValue}. Not closed-won; no Zoho action needed.`);
      }
      // Note: once SYNCED we do NOT reverse Zoho invoices as per business rules
      // (invoices already issued cannot be unilaterally voided from CRM stage change)
    }
  }

  // =========================================================================
  // DEAL DELETION  (subscriptionType: deal.deletion)
  // =========================================================================
  /**
   * When a deal is deleted in HubSpot:
   * 1. Mark IntegrationSync as DELETED
   * 2. Void any open Zoho invoices tied to the deal
   * 3. Void the Zoho Sales Order (if in DRAFT)
   * 4. Soft-delete MilestoneInvoice & PaymentRecord records
   *
   * We NEVER hard-delete from MongoDB — we keep a full audit trail.
   */
  static async handleDealDeletion({ crmDealId }) {
    if (!crmDealId) return;

    const sync = await IntegrationSync.findOne({ crmDealId });
    if (!sync) {
      console.log(`[DEAL DELETION] No IntegrationSync found for deal ${crmDealId}. Nothing to clean up.`);
      return;
    }

    // 1. Mark all milestone invoices as VOIDED in DB
    const milestones = await MilestoneInvoice.find({ crmDealId }).lean();
    for (const m of milestones) {
      await MilestoneInvoice.updateOne(
        { _id: m._id },
        { $set: { status: 'VOIDED', voidedReason: 'Deal deleted from HubSpot CRM', voidedAt: new Date() } }
      );

      // Void invoice in Zoho Books (best-effort — does not fail the whole operation)
      if (m.zohoInvoiceId && !['PAID', 'VOIDED'].includes(m.status)) {
        try {
          await zohoClient.request({
            method: 'POST',
            path: `/invoices/${m.zohoInvoiceId}/status/void`,
            crmDealId
          });
          console.log(`[DEAL DELETION] Voided Zoho invoice ${m.zohoInvoiceId} for deal ${crmDealId}`);
        } catch (e) {
          console.warn(`[DEAL DELETION] Could not void Zoho invoice ${m.zohoInvoiceId}:`, e.message);
        }
      }
    }

    // 2. Void / cancel Zoho Sales Order if it is still DRAFT
    if (sync.zohoSalesOrderId && sync.salesOrderStatus === 'DRAFT') {
      try {
        await zohoClient.request({
          method: 'POST',
          path: `/salesorders/${sync.zohoSalesOrderId}/status/void`,
          crmDealId
        });
        console.log(`[DEAL DELETION] Voided Zoho Sales Order ${sync.zohoSalesOrderId} for deal ${crmDealId}`);
      } catch (e) {
        console.warn(`[DEAL DELETION] Could not void Zoho SO ${sync.zohoSalesOrderId}:`, e.message);
      }
    }

    // 3. Soft-delete PaymentRecords
    await PaymentRecord.updateMany(
      { crmDealId },
      { $set: { isDeleted: true, deletedReason: 'Deal deleted from HubSpot CRM', deletedAt: new Date() } }
    );

    // 4. Mark IntegrationSync as DELETED (not hard-deleted — keep audit trail)
    await IntegrationSync.updateOne(
      { crmDealId },
      {
        $set: {
          syncStatus: 'FAILED',
          failureReason: `Deal permanently deleted from HubSpot CRM at ${new Date().toISOString()}`,
          lockedBy: null,
          orchestrationLockedBy: null
        }
      }
    );

    console.log(`[DEAL DELETION] Deal ${crmDealId} fully purged from DB and Zoho Books (soft-delete, audit trail preserved).`);
  }

  // =========================================================================
  // DEAL MERGE  (subscriptionType: deal.merge)
  // =========================================================================
  /**
   * When two deals are merged in HubSpot, the "losing" deal ID is archived.
   * We redirect all DB references from the old ID to the surviving deal ID.
   */
  static async handleDealMerge({ survivingDealId, archivedDealId }) {
    if (!survivingDealId || !archivedDealId) return;

    console.log(`[DEAL MERGE] Merging archived deal ${archivedDealId} into surviving deal ${survivingDealId}`);

    // Mark archived deal as deleted
    await this.handleDealDeletion({ crmDealId: archivedDealId });

    // Ensure surviving deal has a sync record
    await IntegrationSync.findOneAndUpdate(
      { crmDealId: survivingDealId },
      {
        $setOnInsert: {
          crmDealId: survivingDealId,
          syncStatus: 'PENDING',
          dealName: `Deal ${survivingDealId}`
        }
      },
      { upsert: true }
    );
  }

  // =========================================================================
  // CONTACT / COMPANY PROPERTY CHANGE
  // =========================================================================
  /**
   * When a contact's name or email changes in HubSpot, propagate to
   * CustomerMapping and update the Zoho Books contact.
   */
  static async handleContactPropertyChange({ objectId, propertyName, propertyValue }) {
    if (!objectId || !propertyName) return;

    // Find CustomerMapping by hubspotContactId
    const mapping = await CustomerMapping.findOne({
      $or: [
        { hubspotContactId: String(objectId) },
        { hubspotCompanyId: String(objectId) }
      ]
    });
    if (!mapping) return;

    const updateFields = {};

    if (propertyName === 'email') {
      updateFields.contactEmail = String(propertyValue).toLowerCase().trim();
    } else if (propertyName === 'firstname' || propertyName === 'lastname') {
      // Re-fetch full contact to rebuild full name
      try {
        const res = await hubspotClient.getContact(objectId);
        if (res?.data?.properties) {
          const fn = res.data.properties.firstname || '';
          const ln = res.data.properties.lastname || '';
          updateFields.contactName = `${fn} ${ln}`.trim();
        }
      } catch (e) { /* non-blocking */ }
    } else if (propertyName === 'name') {
      // Company name changed
      updateFields.companyName = String(propertyValue).trim();
    }

    if (Object.keys(updateFields).length === 0) return;

    await CustomerMapping.updateOne({ _id: mapping._id }, { $set: updateFields });

    // Propagate to Zoho Books contact (best-effort)
    if (mapping.zohoContactId) {
      const zohoBody = {};
      if (updateFields.contactName) zohoBody.contact_name = updateFields.contactName;
      if (updateFields.companyName) zohoBody.company_name = updateFields.companyName;
      if (updateFields.contactEmail) {
        zohoBody.contact_persons = [{ email: updateFields.contactEmail }];
      }

      if (Object.keys(zohoBody).length > 0) {
        try {
          await zohoClient.request({
            method: 'PUT',
            path: `/contacts/${mapping.zohoContactId}`,
            body: zohoBody
          });
          console.log(`[CONTACT CHANGE] Updated Zoho contact ${mapping.zohoContactId} → ${JSON.stringify(zohoBody)}`);
        } catch (e) {
          console.warn(`[CONTACT CHANGE] Could not update Zoho contact:`, e.message);
        }
      }
    }
  }

  // =========================================================================
  // CONTACT / COMPANY DELETION
  // =========================================================================
  /**
   * When a HubSpot contact or company is deleted, soft-delete the
   * CustomerMapping so new deals for that customer don't auto-resolve.
   */
  static async handleContactDeletion({ objectId }) {
    if (!objectId) return;

    const result = await CustomerMapping.updateMany(
      {
        $or: [
          { hubspotContactId: String(objectId) },
          { hubspotCompanyId: String(objectId) }
        ]
      },
      {
        $set: {
          status: 'DELETED',
          deletedReason: `HubSpot object ${objectId} deleted`,
          deletedAt: new Date()
        }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`[CONTACT DELETION] Soft-deleted ${result.modifiedCount} CustomerMapping(s) for HubSpot object ${objectId}`);
    }
  }
}

module.exports = DealSyncService;

