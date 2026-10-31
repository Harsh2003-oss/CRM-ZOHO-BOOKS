const IntegrationSync = require('../models/IntegrationSync');
const MilestoneInvoice = require('../models/MilestoneInvoice');
const PaymentRecord = require('../models/PaymentRecord');
const WebhookEvent = require('../models/WebhookEvent');
const IntegrationLog = require('../models/IntegrationLog');
const CustomerMapping = require('../models/CustomerMapping');
const { redactSensitiveData } = require('../utils/redact');

const {
  calculateAggregateFinancialMetrics,
  formatHubSpotDate,
  updateHubSpotDealWithRetry
} = require('./orchestrationService');
const CustomerService = require('./customerService');
const SalesOrderService = require('./salesOrderService');
const InvoiceService = require('./invoiceService');
const PaymentService = require('./paymentService');
const QueueService = require('./queueService');
const { hubspotClient } = require('../clients/hubspotClient');

class DashboardService {
  /**
   * Aggregates summary KPIs grouped by currency.
   * Never combines different currencies into a single total without conversion.
   */
  static async getSummaryMetrics({ currency = null } = {}) {
    const syncRecords = await IntegrationSync.find({});
    const byCurrency = {};

    for (const record of syncRecords) {
      const curr = record.currencyCode || 'AED';
      if (!byCurrency[curr]) {
        byCurrency[curr] = {
          currencyCode: curr,
          totalContractValueMinor: 0,
          confirmedSalesOrdersCount: 0,
          confirmedSalesOrdersTotalMinor: 0,
          totalInvoicedMinor: 0,
          totalCollectedMinor: 0,
          amountInvoicedUnpaidMinor: 0,
          amountNotInvoicedMinor: 0,
          unknownBalancesCount: 0,
          dealsAwaitingMilestonesCount: 0,
          dealsCount: 0,
          customerIdsWithOutstanding: new Set()
        };
      }

      const group = byCurrency[curr];
      group.dealsCount += 1;

      const soTotalMinor = Math.round(Number(record.salesOrderTotal || 0) * 100);
      group.totalContractValueMinor += soTotalMinor;

      if (record.salesOrderStatus === 'CONFIRMED') {
        group.confirmedSalesOrdersCount += 1;
        group.confirmedSalesOrdersTotalMinor += soTotalMinor;
      }

      group.totalInvoicedMinor += Math.round(Number(record.totalInvoicedAmount || 0) * 100);
      group.amountNotInvoicedMinor += Math.round(Number(record.amountNotInvoiced || 0) * 100);

      if (record.paymentInfoStatus === 'PAYMENT_INFO_UNAVAILABLE') {
        group.unknownBalancesCount += 1;
      } else {
        group.totalCollectedMinor += Math.round(Number(record.amountCollected || 0) * 100);
      }

      const unpaidMinor = Math.round(Number(record.amountInvoicedUnpaid || 0) * 100);
      group.amountInvoicedUnpaidMinor += unpaidMinor;

      if (unpaidMinor > 0 && record.zohoContactId) {
        group.customerIdsWithOutstanding.add(record.zohoContactId);
      }

      if (['M1_INVOICED', 'M2_INVOICED'].includes(record.syncStatus)) {
        group.dealsAwaitingMilestonesCount += 1;
      }
    }

    // Calculate overdue totals by currency
    const overdueMilestones = await MilestoneInvoice.find({
      status: { $in: ['CREATED', 'SENT', 'PARTIALLY_PAID'] },
      balance: { $gt: 0 },
      dueDate: { $lt: new Date() }
    });

    const overdueByCurrency = {};
    for (const om of overdueMilestones) {
      const c = om.currencyCode || 'AED';
      overdueByCurrency[c] = (overdueByCurrency[c] || 0) + Math.round(Number(om.balance || 0) * 100);
    }

    // Format currency groups into clean floating point totals
    const formattedGroups = {};
    for (const [curr, data] of Object.entries(byCurrency)) {
      formattedGroups[curr] = {
        currencyCode: curr,
        totalContractValue: data.totalContractValueMinor / 100,
        confirmedSalesOrdersCount: data.confirmedSalesOrdersCount,
        confirmedSalesOrdersTotal: data.confirmedSalesOrdersTotalMinor / 100,
        totalInvoiced: data.totalInvoicedMinor / 100,
        totalCollected: data.totalCollectedMinor / 100,
        amountInvoicedUnpaid: data.amountInvoicedUnpaidMinor / 100,
        amountNotInvoiced: data.amountNotInvoicedMinor / 100,
        totalOverdue: (overdueByCurrency[curr] || 0) / 100,
        customersWithOutstandingCount: data.customerIdsWithOutstanding.size,
        dealsAwaitingMilestonesCount: data.dealsAwaitingMilestonesCount,
        unknownBalancesCount: data.unknownBalancesCount,
        dealsCount: data.dealsCount
      };
    }

    // Operational integration counts
    const pendingEventsCount = await WebhookEvent.countDocuments({
      status: { $in: ['RECEIVED', 'PROCESSING'] }
    });
    const failedEventsCount = await WebhookEvent.countDocuments({ status: 'FAILED' });
    const retryableFailuresCount = await IntegrationSync.countDocuments({
      syncStatus: { $in: ['HUBSPOT_SYNC_FAILED', 'RECONCILIATION_REQUIRED', 'FAILED'] }
    });
    const ambiguousCustomersCount = await CustomerMapping.countDocuments({ status: 'AMBIGUOUS' });

    const latestSync = await IntegrationSync.findOne({}, { lastSyncedAt: 1 }).sort({ lastSyncedAt: -1 });

    const activeCurrency = currency || 'AED';
    const primaryTotals = formattedGroups[activeCurrency] || {
      currencyCode: activeCurrency,
      totalContractValue: 0,
      confirmedSalesOrdersCount: 0,
      confirmedSalesOrdersTotal: 0,
      totalInvoiced: 0,
      totalCollected: 0,
      amountInvoicedUnpaid: 0,
      amountNotInvoiced: 0,
      totalOverdue: 0,
      customersWithOutstandingCount: 0,
      dealsAwaitingMilestonesCount: 0,
      unknownBalancesCount: 0,
      dealsCount: 0
    };

    return {
      activeCurrency,
      totals: primaryTotals,
      byCurrency: formattedGroups,
      operationalCounts: {
        pendingEventsCount,
        failedEventsCount,
        retryableFailuresCount,
        ambiguousCustomersCount
      },
      lastSyncedAt: latestSync?.lastSyncedAt || null
    };
  }

  /**
   * Generates customer-level collections aging table with aging buckets:
   * Current, 1-30, 31-60, 61-90, 90+ days.
   * Supports search, pagination, partial payments, and excludes fully paid / unconfirmed invoices.
   */
  static async getCollectionsAging({
    page = 1,
    limit = 20,
    search = '',
    currency = 'AED',
    referenceDate = new Date()
  } = {}) {
    const refTime = new Date(referenceDate).getTime();

    // Query active unpaid milestones only
    const invoiceQuery = {
      currencyCode: currency,
      status: { $in: ['CREATED', 'SENT', 'PARTIALLY_PAID'] },
      balance: { $gt: 0 },
      zohoInvoiceId: { $ne: null }
    };

    const activeInvoices = await MilestoneInvoice.find(invoiceQuery).sort({ dueDate: 1 });

    // Group invoices by customer
    const customerMap = new Map();

    for (const inv of activeInvoices) {
      const syncRecord = await IntegrationSync.findOne({ crmDealId: inv.crmDealId });
      const customerId = syncRecord?.zohoContactId || `UNKNOWN_${inv.crmDealId}`;
      const customerName = syncRecord?.customerName || syncRecord?.dealName || `Customer (${customerId})`;
      const customerEmail = syncRecord?.customerEmail || '';

      if (!customerMap.has(customerId)) {
        customerMap.set(customerId, {
          customerId,
          customerName,
          customerEmail,
          currencyCode: currency,
          currentMinor: 0,
          days1To30Minor: 0,
          days31To60Minor: 0,
          days61To90Minor: 0,
          days90PlusMinor: 0,
          totalOutstandingMinor: 0,
          oldestUnpaidInvoice: null,
          relatedDeals: new Set(),
          invoices: []
        });
      }

      const cust = customerMap.get(customerId);
      const balanceMinor = Math.round(Number(inv.balance || 0) * 100);
      cust.totalOutstandingMinor += balanceMinor;
      cust.relatedDeals.add(inv.crmDealId);

      // Determine aging bucket
      const dueTime = inv.dueDate ? new Date(inv.dueDate).getTime() : refTime;
      const diffDays = Math.floor((refTime - dueTime) / (1000 * 60 * 60 * 24));

      if (diffDays <= 0) {
        cust.currentMinor += balanceMinor;
      } else if (diffDays <= 30) {
        cust.days1To30Minor += balanceMinor;
      } else if (diffDays <= 60) {
        cust.days31To60Minor += balanceMinor;
      } else if (diffDays <= 90) {
        cust.days61To90Minor += balanceMinor;
      } else {
        cust.days90PlusMinor += balanceMinor;
      }

      // Track oldest unpaid invoice
      if (
        !cust.oldestUnpaidInvoice ||
        (inv.dueDate && new Date(inv.dueDate) < new Date(cust.oldestUnpaidInvoice.dueDate))
      ) {
        cust.oldestUnpaidInvoice = {
          invoiceId: inv.zohoInvoiceId,
          invoiceNumber: inv.zohoInvoiceNumber,
          referenceNumber: inv.referenceNumber,
          dueDate: inv.dueDate,
          balance: inv.balance,
          status: inv.status
        };
      }

      cust.invoices.push({
        invoiceId: inv.zohoInvoiceId,
        invoiceNumber: inv.zohoInvoiceNumber,
        referenceNumber: inv.referenceNumber,
        milestoneName: inv.milestoneName,
        balance: inv.balance,
        totalAmount: inv.totalAmount,
        dueDate: inv.dueDate,
        status: inv.status,
        crmDealId: inv.crmDealId
      });
    }

    // Convert map to list and format numbers
    let customerList = Array.from(customerMap.values()).map((c) => ({
      customerId: c.customerId,
      customerName: c.customerName,
      customerEmail: c.customerEmail,
      currencyCode: c.currencyCode,
      current: c.currentMinor / 100,
      days1To30: c.days1To30Minor / 100,
      days31To60: c.days31To60Minor / 100,
      days61To90: c.days61To90Minor / 100,
      days90Plus: c.days90PlusMinor / 100,
      totalOutstanding: c.totalOutstandingMinor / 100,
      oldestUnpaidInvoice: c.oldestUnpaidInvoice,
      relatedDeals: Array.from(c.relatedDeals),
      invoicesCount: c.invoices.length,
      invoices: c.invoices
    }));

    // Search filter
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      customerList = customerList.filter(
        (c) =>
          c.customerName.toLowerCase().includes(q) ||
          c.customerEmail.toLowerCase().includes(q) ||
          c.relatedDeals.some((d) => d.toLowerCase().includes(q)) ||
          c.invoices.some(
            (i) =>
              (i.invoiceNumber && i.invoiceNumber.toLowerCase().includes(q)) ||
              (i.referenceNumber && i.referenceNumber.toLowerCase().includes(q))
          )
      );
    }

    // Overall summary of all matching aging buckets
    const agingSummaryTotals = customerList.reduce(
      (acc, c) => ({
        current: Number((acc.current + c.current).toFixed(2)),
        days1To30: Number((acc.days1To30 + c.days1To30).toFixed(2)),
        days31To60: Number((acc.days31To60 + c.days31To60).toFixed(2)),
        days61To90: Number((acc.days61To90 + c.days61To90).toFixed(2)),
        days90Plus: Number((acc.days90Plus + c.days90Plus).toFixed(2)),
        totalOutstanding: Number((acc.totalOutstanding + c.totalOutstanding).toFixed(2))
      }),
      { current: 0, days1To30: 0, days31To60: 0, days61To90: 0, days90Plus: 0, totalOutstanding: 0 }
    );

    // Sort by largest total outstanding descending
    customerList.sort((a, b) => b.totalOutstanding - a.totalOutstanding);

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const totalRecords = customerList.length;
    const totalPages = Math.ceil(totalRecords / limitNum) || 1;
    const startIndex = (pageNum - 1) * limitNum;
    const paginatedCustomers = customerList.slice(startIndex, startIndex + limitNum);

    return {
      currency,
      agingSummaryTotals,
      customers: paginatedCustomers,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages,
        hasMore: pageNum < totalPages
      }
    };
  }

  /**
   * Retrieves integration audit logs with sensitive field redaction and pagination.
   */
  static async getIntegrationLogs({
    page = 1,
    limit = 20,
    system = null,
    isSuccess = null,
    search = ''
  } = {}) {
    const query = {};
    if (system) query.system = system;
    if (isSuccess !== null && isSuccess !== undefined && isSuccess !== '') {
      query.isSuccess = String(isSuccess) === 'true';
    }

    if (search && search.trim()) {
      const q = search.trim();
      query.$or = [
        { crmDealId: { $regex: q, $options: 'i' } },
        { endpoint: { $regex: q, $options: 'i' } }
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [logs, totalRecords] = await Promise.all([
      IntegrationLog.find(query).sort({ timestamp: -1 }).skip(skip).limit(limitNum).lean(),
      IntegrationLog.countDocuments(query)
    ]);

    // Redact sensitive headers, tokens, and payloads
    const sanitizedLogs = logs.map((log) => ({
      ...log,
      requestBody: redactSensitiveData(log.requestBody),
      responseBody: redactSensitiveData(log.responseBody)
    }));

    return {
      logs: sanitizedLogs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limitNum) || 1
      }
    };
  }

  /**
   * Retrieves webhook events with queue status filtering and queue counts.
   */
  static async getIntegrationEvents({ page = 1, limit = 20, status = null, source = null } = {}) {
    const query = {};
    if (status) query.status = status;
    if (source) query.source = source;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [events, totalRecords, queueCounts] = await Promise.all([
      WebhookEvent.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      WebhookEvent.countDocuments(query),
      QueueService.getQueueStats()
    ]);

    const sanitizedEvents = events.map((evt) => ({
      ...evt,
      payload: redactSensitiveData(evt.payload)
    }));

    return {
      events: sanitizedEvents,
      queueStats: queueCounts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages: Math.ceil(totalRecords / limitNum) || 1
      }
    };
  }

  /**
   * Retrieves operational exceptions requiring operator attention.
   */
  static async getExceptions() {
    const [ambiguousCustomers, reconciliationRequired, hubspotSyncFailed, failedWebhookEvents] =
      await Promise.all([
        CustomerMapping.find({ status: 'AMBIGUOUS' }).lean(),
        IntegrationSync.find({ syncStatus: 'RECONCILIATION_REQUIRED' }).lean(),
        IntegrationSync.find({ syncStatus: 'HUBSPOT_SYNC_FAILED' }).lean(),
        WebhookEvent.find({ status: 'FAILED' }).limit(50).lean()
      ]);

    return {
      summary: {
        ambiguousCustomersCount: ambiguousCustomers.length,
        reconciliationRequiredCount: reconciliationRequired.length,
        hubspotSyncFailedCount: hubspotSyncFailed.length,
        failedWebhookEventsCount: failedWebhookEvents.length
      },
      ambiguousCustomers: ambiguousCustomers.map((c) => redactSensitiveData(c)),
      reconciliationRequired,
      hubspotSyncFailed,
      failedWebhookEvents: failedWebhookEvents.map((e) => redactSensitiveData(e))
    };
  }

  /**
   * Operator Action: Retries a failed or stalled webhook event.
   */
  static async retryWebhookEvent({ eventId, operator = null } = {}) {
    if (!eventId) throw new Error('eventId is required.');

    const event = await WebhookEvent.findOne({ eventId });
    if (!event) {
      const err = new Error(`WebhookEvent ${eventId} not found.`);
      err.code = 'EVENT_NOT_FOUND';
      throw err;
    }

    // Reset status to RECEIVED so worker can claim it
    await WebhookEvent.updateOne(
      { eventId },
      { $set: { status: 'RECEIVED', error: null, processedAt: null } }
    );

    let executionResult;
    if (event.source === 'ZOHO_BOOKS') {
      executionResult = await PaymentService.processNextQueuedPaymentEvent();
    } else {
      executionResult = await QueueService.claimNextEvent('CRM');
    }

    return {
      success: true,
      eventId,
      action: 'RETRY_INITIATED',
      operator: operator?.role || 'OPERATOR',
      executionResult
    };
  }

  /**
   * Operator Action: Retries HubSpot financial property synchronization for a deal.
   */
  static async retryHubSpotSync({ crmDealId, operator = null, injectedHubSpotClient = null } = {}) {
    if (!crmDealId) throw new Error('crmDealId is required.');

    const syncRecord = await IntegrationSync.findOne({ crmDealId });
    if (!syncRecord) {
      const err = new Error(`IntegrationSync record not found for deal ${crmDealId}.`);
      err.code = 'DEAL_NOT_FOUND';
      throw err;
    }

    const hsClient = injectedHubSpotClient || hubspotClient;
    const metrics = await calculateAggregateFinancialMetrics(crmDealId, syncRecord.salesOrderTotal);

    const hsPayload = {
      zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
      zoho_payment_status: metrics.paymentStatus,
      zoho_is_overdue: String(Boolean(metrics.isOverdue)),
      integration_last_synced_at: new Date().toISOString()
    };

    if (metrics.amountCollected !== null) {
      hsPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
      hsPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
    }

    if (metrics.nextDueDate) {
      hsPayload.zoho_next_due_date = formatHubSpotDate(metrics.nextDueDate);
    }

    await updateHubSpotDealWithRetry(hsClient, crmDealId, hsPayload, { maxRetries: 3 });

    await IntegrationSync.updateOne(
      { crmDealId },
      {
        $set: {
          syncStatus: 'SYNCED',
          failureReason: null,
          lastSyncedAt: new Date()
        }
      }
    );

    return {
      success: true,
      crmDealId,
      action: 'HUBSPOT_SYNC_RETRIED',
      metrics
    };
  }

  /**
   * Operator Action: Resolves an ambiguous customer mapping using validated candidates.
   */
  static async resolveAmbiguousCustomer({
    mappingId,
    chosenZohoContactId,
    chosenZohoContactName = '',
    reason = 'Operator manual resolution via dashboard',
    operator = null
  } = {}) {
    if (!mappingId || !chosenZohoContactId) {
      const err = new Error('mappingId and chosenZohoContactId are required.');
      err.code = 'MISSING_RESOLUTION_DATA';
      throw err;
    }

    const result = await CustomerService.resolveManualMatch({
      mappingId,
      chosenZohoContactId,
      chosenZohoContactName
    });

    return {
      success: true,
      action: 'CUSTOMER_MAPPING_RESOLVED',
      mapping: result
    };
  }

  /**
   * Operator Action: Retries supported reconciliation operations.
   */
  static async retryReconciliation({
    crmDealId,
    operator = null,
    injectedZohoClient = null,
    injectedHubSpotClient = null
  } = {}) {
    if (!crmDealId) throw new Error('crmDealId is required.');

    const syncRecord = await IntegrationSync.findOne({ crmDealId });
    if (!syncRecord) {
      const err = new Error(`IntegrationSync not found for deal ${crmDealId}.`);
      err.code = 'DEAL_NOT_FOUND';
      throw err;
    }

    let result;
    if (syncRecord.reconciliationMilestoneIndex) {
      // Reconcile milestone invoice
      result = await InvoiceService.createMilestoneInvoice({
        crmDealId,
        milestoneIndex: syncRecord.reconciliationMilestoneIndex,
        injectedZohoClient,
        injectedHubSpotClient
      });
    } else {
      // Reconcile sales order
      result = await SalesOrderService.confirmSalesOrder({
        crmDealId,
        injectedZohoClient,
        injectedHubSpotClient
      });
    }

    return {
      success: true,
      crmDealId,
      action: 'RECONCILIATION_COMPLETED',
      result
    };
  }

  /**
   * Operator Action: Triggers immediate payment reverse synchronization for a deal.
   */
  static async triggerPaymentSync({
    crmDealId,
    operator = null,
    injectedZohoClient = null,
    injectedHubSpotClient = null
  } = {}) {
    if (!crmDealId) throw new Error('crmDealId is required.');

    const result = await PaymentService.syncPaymentsForDeal({
      crmDealId,
      injectedZohoClient,
      injectedHubSpotClient
    });

    return {
      success: true,
      crmDealId,
      action: 'PAYMENT_SYNC_COMPLETED',
      result
    };
  }
}

module.exports = DashboardService;
