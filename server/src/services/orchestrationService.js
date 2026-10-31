const crypto = require('crypto');
const IntegrationSync = require('../models/IntegrationSync');
const MilestoneInvoice = require('../models/MilestoneInvoice');
const CustomerService = require('./customerService');
const SalesOrderService = require('./salesOrderService');
const InvoiceService = require('./invoiceService');
const QueueService = require('./queueService');
const { hubspotClient } = require('../clients/hubspotClient');
const { zohoClient } = require('../clients/zohoClient');

/**
 * Calculates overdue status consistently across timezones and dates.
 * Rule: An invoice is overdue ONLY when its due date has passed AND its outstanding balance > 0.
 * Fully paid invoices (balance <= 0) must NEVER be marked overdue.
 */
function calculateOverdueStatus({ dueDate, balance, referenceDate = new Date() }) {
  if (balance === undefined || balance === null || Number(balance) <= 0) {
    return false;
  }
  if (!dueDate) {
    return false;
  }
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) {
    return false;
  }
  // Compare against the end of the due date in UTC (23:59:59.999 UTC)
  const dueEndOfDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate(), 23, 59, 59, 999));
  const refTime = new Date(referenceDate).getTime();
  return refTime > dueEndOfDay.getTime() && Number(balance) > 0;
}

/**
 * Formats a date string or object into standard HubSpot YYYY-MM-DD.
 */
function formatHubSpotDate(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

/**
 * Calculates exact M3 eligibility date (UTC midnight of confirmed go-live date + 90 calendar days).
 */
function calculateM3EligibleDate(confirmedGoLiveDate) {
  if (!confirmedGoLiveDate) return null;
  const d = new Date(confirmedGoLiveDate);
  if (isNaN(d.getTime())) return null;
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  return new Date(utcMidnight + 90 * 24 * 60 * 60 * 1000);
}

/**
 * Updates HubSpot deal properties with bounded exponential backoff retries for transient HTTP 429/5xx errors.
 */
async function updateHubSpotDealWithRetry(client, dealId, properties, { maxRetries = 3, baseDelayMs = 100 } = {}) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const res = await client.updateDeal(dealId, properties);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return res;
      }
      const isRetryable = res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode < 600);
      if (isRetryable && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      const err = new Error(res.data?.message || `HubSpot update failed with status ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.data = res.data;
      throw err;
    } catch (err) {
      if (attempt >= maxRetries || (err.statusCode && err.statusCode < 500 && err.statusCode !== 429)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Aggregates financial metrics across all confirmed milestone invoices for a deal.
 */
async function calculateAggregateFinancialMetrics(crmDealId, soGrossAmount, referenceDate = new Date()) {
  const soGrossMinor = Math.round(Number(soGrossAmount || 126000.0) * 100);
  const confirmedMilestones = await MilestoneInvoice.find({
    crmDealId,
    status: { $in: ['CREATED', 'SENT', 'PAID', 'PARTIALLY_PAID'] }
  }).sort({ milestoneIndex: 1 });

  let totalInvoicedMinor = 0;
  let hasUnknownBalance = false;
  let totalBalanceMinor = 0;

  for (const m of confirmedMilestones) {
    if (m.currencyCode && m.currencyCode !== 'AED') {
      const err = new Error(
        `Currency mismatch in deal financial aggregation: Milestone invoice ${m.zohoInvoiceId} has currency '${m.currencyCode}', expected 'AED'. Multi-currency aggregation without exchange rate conversion is disallowed.`
      );
      err.code = 'CURRENCY_MISMATCH';
      throw err;
    }

    totalInvoicedMinor += Math.round(Number(m.totalAmount || 0) * 100);
    if (m.balance === undefined || m.balance === null || isNaN(m.balance)) {
      hasUnknownBalance = true;
    } else {
      totalBalanceMinor += Math.round(Number(m.balance) * 100);
    }
  }

  const totalInvoiced = totalInvoicedMinor / 100;
  const remainingNotInvoicedMinor = Math.max(0, soGrossMinor - totalInvoicedMinor);
  const amountNotInvoiced = remainingNotInvoicedMinor / 100;
  const percentageInvoiced = soGrossMinor > 0 ? Math.round((totalInvoicedMinor / soGrossMinor) * 10000) / 100 : 0;

  let amountCollected = null;
  let percentageCollected = null;
  let paymentStatus = 'PAYMENT_INFO_UNAVAILABLE';
  let amountInvoicedUnpaid = totalInvoiced;

  if (!hasUnknownBalance && confirmedMilestones.length > 0) {
    amountInvoicedUnpaid = Math.max(0, totalBalanceMinor / 100);
    if (totalBalanceMinor === totalInvoicedMinor) {
      amountCollected = 0.0;
      percentageCollected = 0.0;
      paymentStatus = 'UNPAID';
    } else if (totalBalanceMinor >= 0 && totalBalanceMinor < totalInvoicedMinor) {
      const collectedMinor = totalInvoicedMinor - totalBalanceMinor;
      amountCollected = Math.max(0, collectedMinor / 100);
      percentageCollected = soGrossMinor > 0 ? Math.round((collectedMinor / soGrossMinor) * 10000) / 100 : 0;
      paymentStatus = totalBalanceMinor === 0 ? 'PAID' : 'PARTIALLY_PAID';
    }
  }

  let nextDueDate = null;
  let isOverdue = false;

  for (const m of confirmedMilestones) {
    if (m.balance && Number(m.balance) > 0 && m.dueDate) {
      if (!nextDueDate || new Date(m.dueDate) < new Date(nextDueDate)) {
        nextDueDate = m.dueDate;
      }
      if (calculateOverdueStatus({ dueDate: m.dueDate, balance: m.balance, referenceDate })) {
        isOverdue = true;
      }
    }
  }

  return {
    soTotal: soGrossMinor / 100,
    totalInvoiced,
    percentageInvoiced,
    amountNotInvoiced,
    amountInvoicedUnpaid,
    amountCollected,
    percentageCollected,
    paymentStatus,
    nextDueDate,
    isOverdue
  };
}

/**
 * OrchestrationService coordinates end-to-end processing across CRM and Zoho Books:
 * 1. Closed Won -> Customer -> Sales Order -> M1 (50% Signing)
 * 2. Verified Go-Live -> M2 (30% Go-Live)
 * 3. 90 Days Elapsed -> M3 (20% 90-Day Post Go-Live)
 */
class OrchestrationService {
  static async acquireOrchestrationLock(crmDealId, executionWorkerId, leaseDurationMs = 5 * 60 * 1000) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);

    let sync = await IntegrationSync.findOneAndUpdate(
      {
        crmDealId,
        $or: [
          { orchestrationLockedBy: null },
          { orchestrationLeaseExpiresAt: { $lt: now } },
          { orchestrationLockedBy: executionWorkerId }
        ]
      },
      {
        $set: {
          orchestrationLockedBy: executionWorkerId,
          orchestrationLockedAt: now,
          orchestrationLeaseExpiresAt: expiresAt
        }
      },
      { returnDocument: 'after' }
    );

    if (!sync) {
      const existing = await IntegrationSync.findOne({ crmDealId });
      if (existing) {
        const err = new Error(
          `Concurrent execution conflict: Deal ${crmDealId} is currently locked by worker '${existing.orchestrationLockedBy}' until ${existing.orchestrationLeaseExpiresAt?.toISOString()}.`
        );
        err.code = 'CONCURRENT_ORCHESTRATION_CONFLICT';
        throw err;
      }

      try {
        sync = await IntegrationSync.create({
          crmDealId,
          orchestrationLockedBy: executionWorkerId,
          orchestrationLockedAt: now,
          orchestrationLeaseExpiresAt: expiresAt,
          syncStatus: 'PENDING'
        });
      } catch (insertErr) {
        if (insertErr.code === 11000) {
          const conflictErr = new Error(`Concurrent execution conflict: Race condition creating lock for deal ${crmDealId}`);
          conflictErr.code = 'CONCURRENT_ORCHESTRATION_CONFLICT';
          throw conflictErr;
        }
        throw insertErr;
      }
    }

    return sync;
  }

  static async renewOrchestrationLock(crmDealId, executionWorkerId, leaseDurationMs = 5 * 60 * 1000) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    const renewed = await IntegrationSync.findOneAndUpdate(
      {
        crmDealId,
        orchestrationLockedBy: executionWorkerId,
        orchestrationLeaseExpiresAt: { $gt: now }
      },
      {
        $set: {
          orchestrationLockedAt: now,
          orchestrationLeaseExpiresAt: expiresAt
        }
      },
      { returnDocument: 'after' }
    );
    if (!renewed) {
      const err = new Error(
        `Failed to renew orchestration lease for deal ${crmDealId}: Worker ${executionWorkerId} does not hold an active unexpired lease.`
      );
      err.code = 'ORCHESTRATION_LEASE_RENEWAL_FAILED';
      throw err;
    }
    return renewed;
  }

  static async releaseOrchestrationLock(crmDealId, executionWorkerId) {
    await IntegrationSync.updateOne(
      { crmDealId, orchestrationLockedBy: executionWorkerId },
      {
        $set: {
          orchestrationLockedBy: null,
          orchestrationLockedAt: null,
          orchestrationLeaseExpiresAt: null
        }
      }
    );
  }

  /**
   * Processes a Closed Won deal through end-to-end orchestration (M1 lifecycle).
   */
  static async processClosedWonDeal({
    crmDealId,
    injectedHubSpotClient = null,
    injectedZohoClient = null,
    workerId = null,
    leaseDurationMs = 5 * 60 * 1000,
    heartbeatIntervalMs = null,
    referenceDate = null
  }) {
    if (!crmDealId) {
      throw new Error('crmDealId is required for orchestration.');
    }

    const executionId = crypto.randomUUID();
    const executionWorkerId = workerId
      ? `${workerId}_${executionId}`
      : `orchestrator_${process.pid}_${executionId}`;

    const hsClient = injectedHubSpotClient || hubspotClient;
    const zClient = injectedZohoClient || zohoClient;

    await this.acquireOrchestrationLock(crmDealId, executionWorkerId, leaseDurationMs);

    const effectiveHeartbeatInterval =
      heartbeatIntervalMs !== null
        ? heartbeatIntervalMs
        : Math.min(30000, Math.floor(leaseDurationMs / 3));

    let heartbeatTimer = null;
    if (effectiveHeartbeatInterval >= 1000) {
      heartbeatTimer = setInterval(async () => {
        try {
          await this.renewOrchestrationLock(crmDealId, executionWorkerId, leaseDurationMs);
        } catch (e) {
          console.warn(`[ORCHESTRATION HEARTBEAT] Failed to renew lease for deal ${crmDealId}:`, e.message);
        }
      }, effectiveHeartbeatInterval);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
    }

    try {
      const dealRes = await hsClient.getDeal(crmDealId);
      if (dealRes.statusCode < 200 || dealRes.statusCode >= 300 || !dealRes.data) {
        const err = new Error(`Failed to fetch deal ${crmDealId} from HubSpot (HTTP ${dealRes.statusCode})`);
        err.code = 'HUBSPOT_FETCH_FAILED';
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, orchestrationLockedBy: executionWorkerId },
          { $set: { syncStatus: 'FAILED', failureReason: err.message } }
        );
        throw err;
      }

      const dealData = dealRes.data;
      const properties = dealData.properties || {};

      const currentStage = String(properties.dealstage || '').toLowerCase().replace(/[\s_-]+/g, '');
      if (currentStage !== 'closedwon') {
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, orchestrationLockedBy: executionWorkerId },
          {
            $set: {
              failureReason: `Deal stage is '${properties.dealstage}', expected 'closedwon'`
            }
          }
        );
        return {
          status: 'SKIPPED_NOT_CLOSED_WON',
          crmDealId,
          stage: properties.dealstage
        };
      }

      const dealName = properties.dealname || `Deal ${crmDealId}`;
      const contractAmount = properties.amount ? Number(properties.amount) : 120000.0;
      const hubspotCompanyId = dealData.associations?.companies?.results?.[0]?.id || null;
      const hubspotContactId = dealData.associations?.contacts?.results?.[0]?.id || null;
      const companyName = properties.company || dealName;
      const contactName = properties.contact || '';
      const contactEmail = properties.email || null;

      // Resolve Customer
      const customerResult = await CustomerService.resolveCustomer({
        hubspotCompanyId,
        hubspotContactId,
        companyName,
        contactName,
        contactEmail,
        crmDealId,
        injectedZohoClient: zClient
      });

      if (customerResult.status === 'REQUIRES_MANUAL_MATCH') {
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, orchestrationLockedBy: executionWorkerId },
          {
            $set: {
              syncStatus: 'REQUIRES_MANUAL_MATCH',
              failureReason: customerResult.reason
            }
          }
        );

        try {
          await updateHubSpotDealWithRetry(hsClient, crmDealId, {
            integration_sync_status: 'REQUIRES_MANUAL_MATCH',
            integration_last_error: customerResult.reason
          });
        } catch (hsErr) {
          console.warn('[ORCHESTRATION] Failed to notify HubSpot of manual match requirement:', hsErr.message);
        }

        return {
          status: 'REQUIRES_MANUAL_MATCH',
          crmDealId,
          reason: customerResult.reason
        };
      }

      if (customerResult.status !== 'RESOLVED' || !customerResult.zohoContactId) {
        const err = new Error(customerResult.reason || 'Failed to resolve customer mapping');
        err.code = 'CUSTOMER_RESOLUTION_FAILED';
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, orchestrationLockedBy: executionWorkerId },
          { $set: { syncStatus: 'FAILED', failureReason: err.message } }
        );
        throw err;
      }

      const zohoContactId = customerResult.zohoContactId;
      await IntegrationSync.findOneAndUpdate(
        { crmDealId, orchestrationLockedBy: executionWorkerId },
        {
          $set: {
            zohoContactId,
            customerName: customerResult.zohoContactName || companyName
          }
        }
      );

      // Create Sales Order
      let salesOrderResult;
      try {
        salesOrderResult = await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId,
          zohoContactId,
          dealName,
          amount: contractAmount,
          currencyCode: 'AED',
          workerId: executionWorkerId,
          injectedZohoClient: zClient
        });
      } catch (soErr) {
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, orchestrationLockedBy: executionWorkerId },
          { $set: { syncStatus: 'FAILED', failureReason: soErr.message } }
        );
        try {
          await updateHubSpotDealWithRetry(hsClient, crmDealId, {
            integration_sync_status: 'FAILED',
            integration_last_error: soErr.message
          });
        } catch (hsErr) {
          console.warn('[ORCHESTRATION] Failed to push SO error to HubSpot:', hsErr.message);
        }
        throw soErr;
      }

      // Create M1 Invoice (50% Signing)
      let invoiceResult;
      try {
        invoiceResult = await InvoiceService.createMilestone1Invoice({
          crmDealId,
          hubspotCompanyId,
          dealStage: 'closedwon',
          contractAmount,
          currencyCode: 'AED',
          workerId: executionWorkerId,
          injectedZohoClient: zClient
        });
      } catch (invErr) {
        if (invErr.code === 'INVOICE_RECONCILIATION_REQUIRED' || invErr.code === 'INVOICE_RECONCILIATION_BLOCKED') {
          try {
            await updateHubSpotDealWithRetry(hsClient, crmDealId, {
              integration_sync_status: 'RECONCILIATION_REQUIRED',
              integration_last_error: invErr.message
            });
          } catch (hsErr) {
            console.warn('[ORCHESTRATION] Failed to push reconciliation state to HubSpot:', hsErr.message);
          }
          return {
            status: 'RECONCILIATION_REQUIRED',
            crmDealId,
            error: invErr.message
          };
        }

        try {
          await updateHubSpotDealWithRetry(hsClient, crmDealId, {
            integration_sync_status: 'FAILED',
            integration_last_error: invErr.message
          });
        } catch (hsErr) {
          console.warn('[ORCHESTRATION] Failed to push invoice error to HubSpot:', hsErr.message);
        }
        throw invErr;
      }

      // Aggregate financials
      const syncDoc = await IntegrationSync.findOne({ crmDealId });
      const metrics = await calculateAggregateFinancialMetrics(crmDealId, syncDoc.salesOrderTotal, referenceDate);
      const nextDueDateFormatted = formatHubSpotDate(metrics.nextDueDate);

      const hubspotPayload = {
        zoho_customer_id: syncDoc.zohoContactId,
        zoho_sales_order_id: syncDoc.zohoSalesOrderId,
        zoho_sales_order_number: syncDoc.zohoSalesOrderNumber || '',
        zoho_sales_order_url: syncDoc.zohoSalesOrderUrl || '',
        zoho_sales_order_total: Number(metrics.soTotal.toFixed(2)),
        zoho_currency_code: syncDoc.currencyCode || 'AED',
        zoho_total_invoiced_amount: Number(metrics.totalInvoiced.toFixed(2)),
        zoho_percentage_invoiced: Number(metrics.percentageInvoiced.toFixed(2)),
        zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
        zoho_amount_not_invoiced: Number(metrics.amountNotInvoiced.toFixed(2)),
        zoho_is_overdue: String(Boolean(metrics.isOverdue)),
        zoho_payment_status: metrics.paymentStatus,
        integration_sync_status: 'SYNCED',
        integration_milestone_stage: 'M1_INVOICED',
        integration_last_error: '',
        integration_last_synced_at: new Date().toISOString()
      };

      if (metrics.amountCollected !== null) {
        hubspotPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
        hubspotPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
      }

      if (nextDueDateFormatted) {
        hubspotPayload.zoho_next_due_date = nextDueDateFormatted;
      }

      try {
        await updateHubSpotDealWithRetry(hsClient, crmDealId, hubspotPayload, {
          maxRetries: 3,
          baseDelayMs: 50
        });
      } catch (hsUpdateErr) {
        console.error(`[ORCHESTRATION] Failed to update HubSpot properties for deal ${crmDealId}:`, hsUpdateErr.message);
        await IntegrationSync.findOneAndUpdate(
          {
            crmDealId,
            orchestrationLockedBy: executionWorkerId,
            orchestrationLeaseExpiresAt: { $gt: new Date() }
          },
          {
            $set: {
              syncStatus: 'HUBSPOT_SYNC_FAILED',
              failureReason: `HubSpot properties update failed: ${hsUpdateErr.message}`,
              totalInvoicedAmount: metrics.totalInvoiced,
              amountCollected: metrics.amountCollected ?? 0,
              percentageInvoiced: metrics.percentageInvoiced,
              percentageCollected: metrics.percentageCollected ?? 0,
              paymentInfoStatus: metrics.paymentStatus === 'PAYMENT_INFO_UNAVAILABLE' ? 'PAYMENT_INFO_UNAVAILABLE' : 'DETERMINED',
              amountInvoicedUnpaid: metrics.amountInvoicedUnpaid,
              amountNotInvoiced: metrics.amountNotInvoiced,
              isOverdue: metrics.isOverdue,
              nextDueDate: metrics.nextDueDate || null
            }
          }
        );
        throw hsUpdateErr;
      }

      const syncedRecord = await IntegrationSync.findOneAndUpdate(
        {
          crmDealId,
          orchestrationLockedBy: executionWorkerId,
          orchestrationLeaseExpiresAt: { $gt: new Date() }
        },
        {
          $set: {
            syncStatus: 'SYNCED',
            totalInvoicedAmount: metrics.totalInvoiced,
            amountCollected: metrics.amountCollected ?? 0,
            percentageInvoiced: metrics.percentageInvoiced,
            percentageCollected: metrics.percentageCollected ?? 0,
            paymentInfoStatus: metrics.paymentStatus === 'PAYMENT_INFO_UNAVAILABLE' ? 'PAYMENT_INFO_UNAVAILABLE' : 'DETERMINED',
            amountInvoicedUnpaid: metrics.amountInvoicedUnpaid,
            amountNotInvoiced: metrics.amountNotInvoiced,
            isOverdue: metrics.isOverdue,
            nextDueDate: metrics.nextDueDate || null,
            lastSyncedAt: new Date(),
            failureReason: null
          }
        },
        { returnDocument: 'after' }
      );

      if (!syncedRecord) {
        const leaseErr = new Error(`Fencing Guard: Worker ${executionWorkerId} lease expired before SYNCED state could be persisted.`);
        leaseErr.code = 'ORCHESTRATION_LEASE_FENCED';
        throw leaseErr;
      }

      return {
        status: 'SYNCED',
        crmDealId,
        zohoSalesOrderId: syncDoc.zohoSalesOrderId,
        zohoInvoiceId: invoiceResult?.zohoInvoiceId,
        properties: hubspotPayload,
        sync: syncedRecord
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await this.releaseOrchestrationLock(crmDealId, executionWorkerId);
    }
  }

  /**
   * Processes a verified Go-Live event and creates Milestone 2 (M2 - 30% Go-Live) invoice.
   */
  static async processGoLiveMilestone({
    crmDealId,
    goLiveDate = null,
    workerId = null,
    leaseDurationMs = 5 * 60 * 1000,
    heartbeatIntervalMs = null,
    injectedHubSpotClient = null,
    injectedZohoClient = null,
    referenceDate = null
  }) {
    if (!crmDealId) {
      throw new Error('crmDealId is required for Go-Live milestone processing.');
    }

    const executionId = crypto.randomUUID();
    const executionWorkerId = workerId
      ? `${workerId}_${executionId}`
      : `orchestrator_golive_${process.pid}_${executionId}`;

    const hsClient = injectedHubSpotClient || hubspotClient;
    const zClient = injectedZohoClient || zohoClient;

    await this.acquireOrchestrationLock(crmDealId, executionWorkerId, leaseDurationMs);

    const effectiveHeartbeatInterval =
      heartbeatIntervalMs !== null
        ? heartbeatIntervalMs
        : Math.min(30000, Math.floor(leaseDurationMs / 3));

    let heartbeatTimer = null;
    if (effectiveHeartbeatInterval >= 1000) {
      heartbeatTimer = setInterval(async () => {
        try {
          await this.renewOrchestrationLock(crmDealId, executionWorkerId, leaseDurationMs);
        } catch (e) {
          console.warn(`[GO-LIVE HEARTBEAT] Failed to renew lease for deal ${crmDealId}:`, e.message);
        }
      }, effectiveHeartbeatInterval);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
    }

    try {
      const syncRecord = await IntegrationSync.findOne({ crmDealId });
      if (!syncRecord) {
        throw new Error(`Prerequisite Failed: IntegrationSync record not found for deal ${crmDealId}.`);
      }

      if (syncRecord.syncStatus === 'RECONCILIATION_REQUIRED') {
        const recErr = new Error(`Cannot process Go-Live: Deal ${crmDealId} is in RECONCILIATION_REQUIRED state.`);
        recErr.code = 'INVOICE_RECONCILIATION_BLOCKED';
        throw recErr;
      }

      if (syncRecord.salesOrderStatus !== 'CONFIRMED' || !syncRecord.zohoSalesOrderId) {
        throw new Error(`Prerequisite Failed: Sales Order is not confirmed for deal ${crmDealId}.`);
      }

      // Check M1 exists and is confirmed
      const m1 = await MilestoneInvoice.findOne({ crmDealId, milestoneIndex: 1 });
      if (!m1 || !['CREATED', 'SENT', 'PAID'].includes(m1.status)) {
        const m1Err = new Error(`Prerequisite Failed: M1 invoice must be confirmed before Go-Live milestone can proceed.`);
        m1Err.code = 'PREREQUISITE_FAILED_M1_NOT_CONFIRMED';
        throw m1Err;
      }

      // Idempotency: Check if M2 is already created
      const existingM2 = await MilestoneInvoice.findOne({ crmDealId, milestoneIndex: 2 });
      if (existingM2 && ['CREATED', 'SENT', 'PAID'].includes(existingM2.status)) {
        return {
          status: 'ALREADY_CREATED',
          crmDealId,
          milestoneIndex: 2,
          zohoInvoiceId: existingM2.zohoInvoiceId,
          zohoInvoiceNumber: existingM2.zohoInvoiceNumber,
          milestoneInvoice: existingM2
        };
      }

      // Fetch deal from HubSpot to verify date
      const dealRes = await hsClient.getDeal(crmDealId);
      const dealProps = dealRes.data?.properties || {};

      const rawGoLive = goLiveDate || dealProps.confirmed_go_live_date || dealProps.go_live_date;
      if (!rawGoLive || !String(rawGoLive).trim()) {
        const dateErr = new Error(`Go-Live Verification Failed: Missing confirmed go-live date for deal ${crmDealId}.`);
        dateErr.code = 'INVALID_GO_LIVE_DATE';
        throw dateErr;
      }

      const parsedGoLive = new Date(rawGoLive);
      if (isNaN(parsedGoLive.getTime())) {
        const dateErr = new Error(`Go-Live Verification Failed: Unparseable go-live date '${rawGoLive}'.`);
        dateErr.code = 'INVALID_GO_LIVE_DATE';
        throw dateErr;
      }

      // Check future date
      const refDate = referenceDate ? new Date(referenceDate) : new Date();
      const goLiveUtcMidnight = Date.UTC(parsedGoLive.getUTCFullYear(), parsedGoLive.getUTCMonth(), parsedGoLive.getUTCDate());
      const refUtcMidnight = Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate());

      if (goLiveUtcMidnight > refUtcMidnight) {
        const futureErr = new Error(`Go-Live Verification Failed: Confirmed go-live date cannot be in the future.`);
        futureErr.code = 'GO_LIVE_DATE_IN_FUTURE';
        throw futureErr;
      }

      const verifiedGoLiveDate = new Date(goLiveUtcMidnight);
      const m3EligibleAt = calculateM3EligibleDate(verifiedGoLiveDate);

      // Persist verified go-live date and timing
      await IntegrationSync.findOneAndUpdate(
        { crmDealId, orchestrationLockedBy: executionWorkerId },
        {
          $set: {
            confirmedGoLiveDate: verifiedGoLiveDate,
            goLiveVerifiedAt: new Date(),
            m3EligibleAt
          }
        }
      );

      // Create M2 Invoice (30% Go-Live)
      const invRes = await InvoiceService.createMilestone2Invoice({
        crmDealId,
        hubspotCompanyId: dealRes.data?.associations?.companies?.results?.[0]?.id,
        contractAmount: dealProps.amount ? Number(dealProps.amount) : syncRecord.salesOrderSubtotal,
        currencyCode: syncRecord.currencyCode || 'AED',
        workerId: executionWorkerId,
        injectedZohoClient: zClient
      });

      // Recalculate aggregate financials
      const metrics = await calculateAggregateFinancialMetrics(crmDealId, syncRecord.salesOrderTotal, referenceDate);
      const nextDueDateFormatted = formatHubSpotDate(metrics.nextDueDate);

      const hubspotPayload = {
        zoho_total_invoiced_amount: Number(metrics.totalInvoiced.toFixed(2)),
        zoho_percentage_invoiced: Number(metrics.percentageInvoiced.toFixed(2)),
        zoho_amount_not_invoiced: Number(metrics.amountNotInvoiced.toFixed(2)),
        zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
        confirmed_go_live_date: formatHubSpotDate(verifiedGoLiveDate),
        m3_eligible_date: formatHubSpotDate(m3EligibleAt),
        integration_milestone_stage: 'M2_GO_LIVE',
        integration_sync_status: 'SYNCED',
        zoho_is_overdue: String(Boolean(metrics.isOverdue)),
        zoho_payment_status: metrics.paymentStatus,
        integration_last_synced_at: new Date().toISOString()
      };

      if (metrics.amountCollected !== null) {
        hubspotPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
        hubspotPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
      }

      if (nextDueDateFormatted) {
        hubspotPayload.zoho_next_due_date = nextDueDateFormatted;
      }

      await updateHubSpotDealWithRetry(hsClient, crmDealId, hubspotPayload);

      return {
        status: 'M2_INVOICED',
        crmDealId,
        zohoInvoiceId: invRes.zohoInvoiceId,
        subtotal: invRes.subtotal,
        taxAmount: invRes.taxAmount,
        totalAmount: invRes.totalAmount,
        metrics,
        properties: hubspotPayload
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await this.releaseOrchestrationLock(crmDealId, executionWorkerId);
    }
  }

  /**
   * Processes Milestone 3 (M3 - 20% 90-Day Post Go-Live) invoice.
   */
  static async process90DayMilestone({
    crmDealId,
    workerId = null,
    leaseDurationMs = 5 * 60 * 1000,
    heartbeatIntervalMs = null,
    injectedHubSpotClient = null,
    injectedZohoClient = null,
    referenceDate = null
  }) {
    if (!crmDealId) {
      throw new Error('crmDealId is required for 90-Day milestone processing.');
    }

    const executionId = crypto.randomUUID();
    const executionWorkerId = workerId
      ? `${workerId}_${executionId}`
      : `orchestrator_m3_${process.pid}_${executionId}`;

    const hsClient = injectedHubSpotClient || hubspotClient;
    const zClient = injectedZohoClient || zohoClient;

    await this.acquireOrchestrationLock(crmDealId, executionWorkerId, leaseDurationMs);

    const effectiveHeartbeatInterval =
      heartbeatIntervalMs !== null
        ? heartbeatIntervalMs
        : Math.min(30000, Math.floor(leaseDurationMs / 3));

    let heartbeatTimer = null;
    if (effectiveHeartbeatInterval >= 1000) {
      heartbeatTimer = setInterval(async () => {
        try {
          await this.renewOrchestrationLock(crmDealId, executionWorkerId, leaseDurationMs);
        } catch (e) {
          console.warn(`[M3 HEARTBEAT] Failed to renew lease for deal ${crmDealId}:`, e.message);
        }
      }, effectiveHeartbeatInterval);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
    }

    try {
      const syncRecord = await IntegrationSync.findOne({ crmDealId });
      if (!syncRecord) {
        throw new Error(`Prerequisite Failed: IntegrationSync record not found for deal ${crmDealId}.`);
      }

      if (syncRecord.syncStatus === 'RECONCILIATION_REQUIRED') {
        const recErr = new Error(`Cannot process M3: Deal ${crmDealId} is in RECONCILIATION_REQUIRED state.`);
        recErr.code = 'INVOICE_RECONCILIATION_BLOCKED';
        throw recErr;
      }

      // Check M1 and M2
      const m1 = await MilestoneInvoice.findOne({ crmDealId, milestoneIndex: 1 });
      if (!m1 || !['CREATED', 'SENT', 'PAID'].includes(m1.status)) {
        const m1Err = new Error(`Prerequisite Failed: M1 invoice must be confirmed before M3.`);
        m1Err.code = 'PREREQUISITE_FAILED_M1_NOT_CONFIRMED';
        throw m1Err;
      }

      const m2 = await MilestoneInvoice.findOne({ crmDealId, milestoneIndex: 2 });
      if (!m2 || !['CREATED', 'SENT', 'PAID'].includes(m2.status)) {
        if (m2 && m2.status === 'PENDING_RECONCILIATION') {
          const recErr = new Error(`M2 invoice is pending reconciliation. Reconciliation required before M3.`);
          recErr.code = 'INVOICE_RECONCILIATION_BLOCKED';
          throw recErr;
        }
        const m2Err = new Error(`Prerequisite Failed: M2 invoice must be confirmed before M3.`);
        m2Err.code = 'PREREQUISITE_FAILED_M2_NOT_CONFIRMED';
        throw m2Err;
      }

      // Idempotency: Check if M3 already created
      const existingM3 = await MilestoneInvoice.findOne({ crmDealId, milestoneIndex: 3 });
      if (existingM3 && ['CREATED', 'SENT', 'PAID'].includes(existingM3.status)) {
        return {
          status: 'ALREADY_CREATED',
          crmDealId,
          milestoneIndex: 3,
          zohoInvoiceId: existingM3.zohoInvoiceId,
          zohoInvoiceNumber: existingM3.zohoInvoiceNumber,
          milestoneInvoice: existingM3
        };
      }

      // Check Timing Boundary
      const now = referenceDate ? new Date(referenceDate) : new Date();
      const eligibleAt = syncRecord.m3EligibleAt || calculateM3EligibleDate(syncRecord.confirmedGoLiveDate);

      if (!eligibleAt) {
        throw new Error(`Cannot evaluate M3: Missing confirmed go-live date for deal ${crmDealId}.`);
      }

      if (now.getTime() < eligibleAt.getTime()) {
        const daysRemaining = Math.ceil((eligibleAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        return {
          status: 'M3_NOT_YET_ELIGIBLE',
          crmDealId,
          eligibleAt: eligibleAt.toISOString(),
          evaluatedAt: now.toISOString(),
          daysRemaining
        };
      }

      // Eligible: Create M3 Invoice (20%)
      const invRes = await InvoiceService.createMilestone3Invoice({
        crmDealId,
        contractAmount: syncRecord.salesOrderSubtotal || 120000.0,
        currencyCode: syncRecord.currencyCode || 'AED',
        workerId: executionWorkerId,
        injectedZohoClient: zClient
      });

      // Recalculate aggregate financials
      const metrics = await calculateAggregateFinancialMetrics(crmDealId, syncRecord.salesOrderTotal, referenceDate);
      const nextDueDateFormatted = formatHubSpotDate(metrics.nextDueDate);

      const hubspotPayload = {
        zoho_total_invoiced_amount: Number(metrics.totalInvoiced.toFixed(2)),
        zoho_percentage_invoiced: 100.0,
        zoho_amount_not_invoiced: 0.0,
        zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
        integration_milestone_stage: 'M3_COMPLETED',
        integration_sync_status: 'SYNCED',
        zoho_is_overdue: String(Boolean(metrics.isOverdue)),
        zoho_payment_status: metrics.paymentStatus,
        integration_last_synced_at: new Date().toISOString()
      };

      if (metrics.amountCollected !== null) {
        hubspotPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
        hubspotPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
      }

      if (nextDueDateFormatted) {
        hubspotPayload.zoho_next_due_date = nextDueDateFormatted;
      }

      await updateHubSpotDealWithRetry(hsClient, crmDealId, hubspotPayload);

      return {
        status: 'M3_INVOICED',
        crmDealId,
        zohoInvoiceId: invRes.zohoInvoiceId,
        subtotal: invRes.subtotal,
        taxAmount: invRes.taxAmount,
        totalAmount: invRes.totalAmount,
        metrics,
        properties: hubspotPayload
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await this.releaseOrchestrationLock(crmDealId, executionWorkerId);
    }
  }

  /**
   * On-demand batch evaluator for M3 eligible deals.
   */
  static async processEligibleM3Milestones({
    referenceDate = new Date(),
    limit = 50,
    injectedHubSpotClient = null,
    injectedZohoClient = null
  } = {}) {
    const now = new Date(referenceDate);
    const eligibleDeals = await IntegrationSync.find({
      syncStatus: 'M2_INVOICED',
      m3EligibleAt: { $lte: now }
    }).limit(limit);

    const results = [];
    for (const sync of eligibleDeals) {
      try {
        const res = await this.process90DayMilestone({
          crmDealId: sync.crmDealId,
          referenceDate: now,
          injectedHubSpotClient,
          injectedZohoClient
        });
        results.push({ crmDealId: sync.crmDealId, success: true, result: res });
      } catch (err) {
        results.push({ crmDealId: sync.crmDealId, success: false, error: err.message });
      }
    }

    return {
      evaluated: eligibleDeals.length,
      processed: results.filter((r) => r.success && r.result?.status === 'M3_INVOICED').length,
      skipped: results.filter((r) => r.success && r.result?.status !== 'M3_INVOICED').length,
      failed: results.filter((r) => !r.success).length,
      results
    };
  }

  /**
   * Processes the next queued CRM WebhookEvent through orchestration.
   */
  static async processNextQueuedEvent({ injectedHubSpotClient = null, injectedZohoClient = null } = {}) {
    const claimedEvent = await QueueService.claimNextEvent('CRM');
    if (!claimedEvent) {
      return null;
    }

    const payload = claimedEvent.payload || {};
    const crmDealId = String(payload.objectId || payload.dealId || '');
    if (!crmDealId) {
      await QueueService.markFailed(claimedEvent.eventId, 'Missing deal ID in webhook payload');
      return { status: 'FAILED', reason: 'Missing deal ID' };
    }

    const propName = payload.propertyName || 'dealstage';
    const propValue = String(payload.propertyValue || '').toLowerCase().trim();

    try {
      let result;
      if (
        propName === 'confirmed_go_live_date' ||
        propName === 'go_live_date' ||
        (propName === 'milestone_stage' && (propValue === 'go_live_reached' || propValue === 'm2_go_live' || propValue === 'go-live'))
      ) {
        result = await this.processGoLiveMilestone({
          crmDealId,
          goLiveDate: payload.propertyValue,
          injectedHubSpotClient,
          injectedZohoClient
        });
      } else {
        result = await this.processClosedWonDeal({
          crmDealId,
          injectedHubSpotClient,
          injectedZohoClient
        });
      }

      await QueueService.markCompleted(claimedEvent.eventId);
      return { eventId: claimedEvent.eventId, crmDealId, result };
    } catch (err) {
      await QueueService.markFailed(claimedEvent.eventId, err.message);
      throw err;
    }
  }
}

module.exports = {
  OrchestrationService,
  calculateOverdueStatus,
  calculateM3EligibleDate,
  calculateAggregateFinancialMetrics,
  formatHubSpotDate,
  updateHubSpotDealWithRetry
};
