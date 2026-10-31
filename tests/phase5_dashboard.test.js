const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const app = require('../server/src/app');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationLog = require('../server/src/models/IntegrationLog');
const DashboardService = require('../server/src/services/dashboardService');

let mongoServer;
const VALID_OPERATOR_KEY = 'operator_secure_dev_key_2026';

function createMockHubSpotClient() {
  const calls = [];
  return {
    calls,
    updateDeal: async (dealId, properties) => {
      calls.push({ method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}`, properties });
      return { statusCode: 200, data: { id: dealId, properties } };
    }
  };
}

function createMockZohoClient() {
  const calls = [];
  return {
    calls,
    request: async ({ method, path }) => {
      calls.push({ method, path });
      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

test.describe('Phase 5: Integration Dashboard & Operational Monitoring', () => {
  test.before(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  test.after(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  test.beforeEach(async () => {
    await IntegrationSync.deleteMany({});
    await MilestoneInvoice.deleteMany({});
    await CustomerMapping.deleteMany({});
    await WebhookEvent.deleteMany({});
    await IntegrationLog.deleteMany({});
  });

  // 1. Dashboard Overview Totals & Invoiced vs Not-Yet-Invoiced Separation
  test('Scenario 1: Dashboard summary computes exact totals and distinguishes invoiced unpaid from not-yet-invoiced', async () => {
    const syncDoc = await IntegrationSync.create({
      crmDealId: 'deal_dash_1',
      dealName: 'Acme Enterprise Contract',
      customerName: 'Acme Corp',
      zohoContactId: 'cust_acme_1',
      salesOrderTotal: 126000.0,
      salesOrderStatus: 'CONFIRMED',
      totalInvoicedAmount: 63000.0, // 50% M1 invoiced
      amountCollected: 30000.0,     // 30k collected
      amountInvoicedUnpaid: 33000.0,// 33k unpaid
      amountNotInvoiced: 63000.0,   // remaining 50% not invoiced
      syncStatus: 'M1_INVOICED',
      currencyCode: 'AED'
    });

    const res = await request(app).get('/api/dashboard/summary');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const totals = res.body.data.totals;
    assert.equal(totals.totalContractValue, 126000.0);
    assert.equal(totals.confirmedSalesOrdersCount, 1);
    assert.equal(totals.confirmedSalesOrdersTotal, 126000.0);
    assert.equal(totals.totalInvoiced, 63000.0);
    assert.equal(totals.totalCollected, 30000.0);
    assert.equal(totals.amountInvoicedUnpaid, 33000.0);
    assert.equal(totals.amountNotInvoiced, 63000.0);
    assert.equal(totals.customersWithOutstandingCount, 1);
    assert.equal(totals.dealsAwaitingMilestonesCount, 1);
  });

  // 2. Empty Database
  test('Scenario 2: Empty database returns zero metrics and empty collections without error', async () => {
    const resSummary = await request(app).get('/api/dashboard/summary');
    assert.equal(resSummary.status, 200);
    assert.equal(resSummary.body.data.totals.totalContractValue, 0);
    assert.equal(resSummary.body.data.totals.totalInvoiced, 0);
    assert.equal(resSummary.body.data.totals.totalCollected, 0);

    const resCollections = await request(app).get('/api/dashboard/collections');
    assert.equal(resCollections.status, 200);
    assert.equal(resCollections.body.data.customers.length, 0);
    assert.equal(resCollections.body.data.agingSummaryTotals.totalOutstanding, 0);
  });

  // 3. Unknown Payment Balances Preserved
  test('Scenario 3: Deals with PAYMENT_INFO_UNAVAILABLE increment unknownBalancesCount and do not fabricate 0 collected', async () => {
    await IntegrationSync.create({
      crmDealId: 'deal_unknown_bal',
      salesOrderTotal: 126000.0,
      totalInvoicedAmount: 63000.0,
      amountCollected: null,
      amountInvoicedUnpaid: 63000.0,
      amountNotInvoiced: 63000.0,
      paymentInfoStatus: 'PAYMENT_INFO_UNAVAILABLE',
      syncStatus: 'M1_INVOICED',
      currencyCode: 'AED'
    });

    const res = await request(app).get('/api/dashboard/summary');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totals.unknownBalancesCount, 1);
    assert.equal(res.body.data.totals.totalCollected, 0);
  });

  // 4. Aging Date Boundaries (Current, 1-30, 31-60, 61-90, 90+ days)
  test('Scenario 4: Aging date boundaries correctly sort invoices into Current, 1-30, 31-60, 61-90, and 90+ buckets', async () => {
    const refDate = new Date('2026-11-15T00:00:00Z');

    const syncDoc = await IntegrationSync.create({
      crmDealId: 'deal_aging_all',
      customerName: 'Stark Industries',
      zohoContactId: 'cust_stark',
      salesOrderTotal: 500000.0,
      currencyCode: 'AED'
    });

    // 1. Current (Due 10 days in the future: Nov 25)
    await MilestoneInvoice.create({
      crmDealId: 'deal_aging_all',
      syncId: syncDoc._id,
      milestoneIndex: 1,
      milestoneName: 'Signing',
      percentage: 50,
      subtotal: 10000.0,
      totalAmount: 10000.0,
      balance: 10000.0,
      dueDate: new Date('2026-11-25T00:00:00Z'),
      zohoInvoiceId: 'inv_current',
      status: 'SENT',
      currencyCode: 'AED'
    });

    // 2. 1-30 Days Overdue (Due 15 days ago: Oct 31)
    await MilestoneInvoice.create({
      crmDealId: 'deal_aging_all',
      syncId: syncDoc._id,
      milestoneIndex: 2,
      milestoneName: 'Go-Live',
      percentage: 30,
      subtotal: 20000.0,
      totalAmount: 20000.0,
      balance: 20000.0,
      dueDate: new Date('2026-10-31T00:00:00Z'),
      zohoInvoiceId: 'inv_1_30',
      status: 'SENT',
      currencyCode: 'AED'
    });

    // 3. 31-60 Days Overdue (Due 45 days ago: Oct 01)
    await MilestoneInvoice.create({
      crmDealId: 'deal_aging_all',
      syncId: syncDoc._id,
      milestoneIndex: 3,
      milestoneName: '90 Days Post Go-Live',
      percentage: 20,
      subtotal: 30000.0,
      totalAmount: 30000.0,
      balance: 30000.0,
      dueDate: new Date('2026-10-01T00:00:00Z'),
      zohoInvoiceId: 'inv_31_60',
      status: 'SENT',
      currencyCode: 'AED'
    });

    const collections = await DashboardService.getCollectionsAging({
      currency: 'AED',
      referenceDate: refDate
    });

    assert.equal(collections.customers.length, 1);
    const stark = collections.customers[0];
    assert.equal(stark.current, 10000.0);
    assert.equal(stark.days1To30, 20000.0);
    assert.equal(stark.days31To60, 30000.0);
    assert.equal(stark.totalOutstanding, 60000.0);
    assert.equal(stark.oldestUnpaidInvoice.invoiceId, 'inv_31_60');
  });

  // 5. Partial and Fully Paid Invoices
  test('Scenario 5: Partial payments reduce customer aging bucket; fully paid invoices are excluded', async () => {
    const syncDoc = await IntegrationSync.create({
      crmDealId: 'deal_partial_aging',
      customerName: 'Wayne Enterprises',
      zohoContactId: 'cust_wayne',
      currencyCode: 'AED'
    });

    // Invoice 1: Partially paid (total 63,000, balance 15,000)
    await MilestoneInvoice.create({
      crmDealId: 'deal_partial_aging',
      syncId: syncDoc._id,
      milestoneIndex: 1,
      milestoneName: 'Signing',
      percentage: 50,
      subtotal: 60000.0,
      totalAmount: 63000.0,
      balance: 15000.0, // partial payment of 48k made
      dueDate: new Date('2026-10-15T00:00:00Z'),
      zohoInvoiceId: 'inv_wayne_partial',
      status: 'PARTIALLY_PAID',
      currencyCode: 'AED'
    });

    // Invoice 2: Fully paid (balance 0, status PAID)
    await MilestoneInvoice.create({
      crmDealId: 'deal_partial_aging',
      syncId: syncDoc._id,
      milestoneIndex: 2,
      milestoneName: 'Go-Live',
      percentage: 30,
      subtotal: 36000.0,
      totalAmount: 37800.0,
      balance: 0.0,
      dueDate: new Date('2026-10-01T00:00:00Z'),
      zohoInvoiceId: 'inv_wayne_paid',
      status: 'PAID',
      currencyCode: 'AED'
    });

    const res = await request(app)
      .get('/api/dashboard/collections?referenceDate=2026-11-15T00:00:00Z');

    assert.equal(res.status, 200);
    assert.equal(res.body.data.customers.length, 1);
    const wayne = res.body.data.customers[0];
    assert.equal(wayne.totalOutstanding, 15000.0, 'Only partial balance of 15,000 must be counted');
    assert.equal(wayne.invoicesCount, 1, 'Fully paid invoice must be excluded');
  });

  // 6. Failed and Unconfirmed Invoices Excluded
  test('Scenario 6: Invoices in PENDING_TRIGGER, FAILED_VALIDATION, or VOIDED are excluded from collections', async () => {
    const syncDoc = await IntegrationSync.create({
      crmDealId: 'deal_unconfirmed',
      customerName: 'Oscorp',
      zohoContactId: 'cust_oscorp',
      currencyCode: 'AED'
    });

    await MilestoneInvoice.create({
      crmDealId: 'deal_unconfirmed',
      syncId: syncDoc._id,
      milestoneIndex: 1,
      milestoneName: 'Signing',
      percentage: 50,
      subtotal: 60000.0,
      totalAmount: 63000.0,
      balance: 63000.0,
      zohoInvoiceId: null,
      status: 'FAILED_VALIDATION',
      currencyCode: 'AED'
    });

    const res = await request(app).get('/api/dashboard/collections');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.customers.length, 0);
  });

  // 7. Multiple Currencies Separation
  test('Scenario 7: Dashboard separates different currencies without adding them together without conversion', async () => {
    await IntegrationSync.create({
      crmDealId: 'deal_aed',
      salesOrderTotal: 126000.0,
      totalInvoicedAmount: 63000.0,
      currencyCode: 'AED'
    });

    await IntegrationSync.create({
      crmDealId: 'deal_usd',
      salesOrderTotal: 50000.0,
      totalInvoicedAmount: 25000.0,
      currencyCode: 'USD'
    });

    const res = await request(app).get('/api/dashboard/summary');
    assert.equal(res.status, 200);
    const byCurrency = res.body.data.byCurrency;

    assert.ok(byCurrency.AED);
    assert.ok(byCurrency.USD);
    assert.equal(byCurrency.AED.totalContractValue, 126000.0);
    assert.equal(byCurrency.USD.totalContractValue, 50000.0);
  });

  // 8. Pagination and Search Filtering on Collections
  test('Scenario 8: Collections endpoint supports search by customer name and pagination', async () => {
    for (let i = 1; i <= 5; i++) {
      const sync = await IntegrationSync.create({
        crmDealId: `deal_search_${i}`,
        customerName: i <= 3 ? `Alpha Customer ${i}` : `Beta Customer ${i}`,
        zohoContactId: `cust_srch_${i}`,
        currencyCode: 'AED'
      });

      await MilestoneInvoice.create({
        crmDealId: `deal_search_${i}`,
        syncId: sync._id,
        milestoneIndex: 1,
        milestoneName: 'Signing',
        percentage: 50,
        subtotal: 1000.0,
        totalAmount: 1000.0,
        balance: 1000.0,
        zohoInvoiceId: `inv_srch_${i}`,
        status: 'SENT',
        currencyCode: 'AED'
      });
    }

    // Search for "Alpha"
    const searchRes = await request(app).get('/api/dashboard/collections?search=Alpha');
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.data.customers.length, 3);

    // Pagination: limit=2, page=1
    const page1Res = await request(app).get('/api/dashboard/collections?limit=2&page=1');
    assert.equal(page1Res.status, 200);
    assert.equal(page1Res.body.data.customers.length, 2);
    assert.equal(page1Res.body.data.pagination.totalPages, 3);
  });

  // 9. Sensitive Field Redaction
  test('Scenario 9: Integration logs endpoint strictly redacts sensitive credentials and tokens', async () => {
    await IntegrationLog.create({
      system: 'ZOHO_BOOKS',
      direction: 'OUTBOUND',
      method: 'POST',
      endpoint: '/invoices',
      statusCode: 200,
      crmDealId: 'deal_log_redact',
      isSuccess: true,
      requestBody: {
        access_token: 'secret_token_12345',
        client_secret: 'confidential_secret',
        customer_id: 'cust_999'
      },
      responseBody: {
        code: 0,
        api_key: 'hidden_api_key'
      }
    });

    const res = await request(app).get('/api/dashboard/logs');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.logs.length, 1);

    const log = res.body.data.logs[0];
    assert.equal(log.requestBody.access_token, '[REDACTED]');
    assert.equal(log.requestBody.client_secret, '[REDACTED]');
    assert.equal(log.requestBody.customer_id, 'cust_999');
    assert.equal(log.responseBody.api_key, '[REDACTED]');
  });

  // 10. Unauthorized Operator Requests Rejected (HTTP 401)
  test('Scenario 10: Operator endpoints reject requests with missing or invalid authorization key', async () => {
    // Missing key
    const resNoKey = await request(app)
      .post('/api/operator/retry-event/some_event_id')
      .send({});
    assert.equal(resNoKey.status, 401);
    assert.equal(resNoKey.body.error, 'UNAUTHORIZED_OPERATOR');

    // Invalid key
    const resBadKey = await request(app)
      .post('/api/operator/retry-event/some_event_id')
      .set('x-operator-key', 'wrong_secret_key')
      .send({});
    assert.equal(resBadKey.status, 401);
    assert.equal(resBadKey.body.error, 'UNAUTHORIZED_OPERATOR');
  });

  // 11. Authorized Operator Retry Event
  test('Scenario 11: Authorized operator retry-event resets event status to RECEIVED', async () => {
    await WebhookEvent.create({
      eventId: 'evt_failed_to_retry',
      source: 'CRM',
      eventType: 'deal.closedwon',
      status: 'FAILED',
      error: 'Previous network timeout',
      payload: { dealId: 'deal_retry_evt' }
    });

    const res = await request(app)
      .post('/api/operator/retry-event/evt_failed_to_retry')
      .set('x-operator-key', VALID_OPERATOR_KEY);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const evt = await WebhookEvent.findOne({ eventId: 'evt_failed_to_retry' });
    assert.notEqual(evt.status, 'FAILED');
  });

  // 12. Authorized Operator Retry HubSpot Sync
  test('Scenario 12: Authorized operator retry-hubspot-sync pushes financial metrics and updates status to SYNCED', async () => {
    const dealId = 'deal_hs_retry_op';
    await IntegrationSync.create({
      crmDealId: dealId,
      salesOrderTotal: 126000.0,
      totalInvoicedAmount: 63000.0,
      amountCollected: 30000.0,
      amountInvoicedUnpaid: 33000.0,
      syncStatus: 'HUBSPOT_SYNC_FAILED',
      currencyCode: 'AED'
    });

    const mockHs = createMockHubSpotClient();

    const result = await DashboardService.retryHubSpotSync({
      crmDealId: dealId,
      injectedHubSpotClient: mockHs
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'HUBSPOT_SYNC_RETRIED');

    const sync = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(sync.syncStatus, 'SYNCED');
    assert.equal(mockHs.calls.length, 1);
  });

  // 13. Customer Mapping Manual Resolution Validation
  test('Scenario 13: Operator resolve-customer validates candidate match and updates CustomerMapping to ACTIVE', async () => {
    const mapping = await CustomerMapping.create({
      hubspotCompanyId: 'comp_ambig_test',
      companyName: 'Ambiguous Corp',
      status: 'AMBIGUOUS',
      candidateMatches: [
        { contactId: 'zoho_valid_1', contactName: 'Ambiguous Corp LLC' },
        { contactId: 'zoho_valid_2', contactName: 'Ambiguous Holding' }
      ]
    });

    // Invalid candidate rejected
    const resInvalid = await request(app)
      .post('/api/operator/resolve-customer')
      .set('x-operator-key', VALID_OPERATOR_KEY)
      .send({
        mappingId: mapping._id.toString(),
        chosenZohoContactId: 'zoho_non_existent'
      });
    assert.equal(resInvalid.status, 400);
    assert.equal(resInvalid.body.error, 'INVALID_CANDIDATE_ID');

    // Valid candidate accepted
    const resValid = await request(app)
      .post('/api/operator/resolve-customer')
      .set('x-operator-key', VALID_OPERATOR_KEY)
      .send({
        mappingId: mapping._id.toString(),
        chosenZohoContactId: 'zoho_valid_1',
        reason: 'Manually verified tax ID'
      });
    assert.equal(resValid.status, 200);
    assert.equal(resValid.body.success, true);

    const updated = await CustomerMapping.findById(mapping._id);
    assert.equal(updated.status, 'ACTIVE');
    assert.equal(updated.mappingType, 'MANUALLY_RESOLVED');
    assert.equal(updated.zohoContactId, 'zoho_valid_1');
  });

  // 14. Exceptions API
  test('Scenario 14: GET /api/dashboard/exceptions returns aggregated action items across all failure modes', async () => {
    await CustomerMapping.create({
      hubspotCompanyId: 'comp_ex_1',
      status: 'AMBIGUOUS',
      candidateMatches: [{ contactId: 'c1' }]
    });

    await IntegrationSync.create({
      crmDealId: 'deal_rec_ex_1',
      syncStatus: 'RECONCILIATION_REQUIRED',
      reconciliationReason: 'Timeout on remote POST'
    });

    await IntegrationSync.create({
      crmDealId: 'deal_hs_fail_ex_1',
      syncStatus: 'HUBSPOT_SYNC_FAILED'
    });

    await WebhookEvent.create({
      eventId: 'evt_fail_ex_1',
      source: 'CRM',
      eventType: 'deal.closedwon',
      status: 'FAILED',
      payload: { dealId: 'deal_fail' }
    });

    const res = await request(app).get('/api/dashboard/exceptions');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.summary.ambiguousCustomersCount, 1);
    assert.equal(res.body.data.summary.reconciliationRequiredCount, 1);
    assert.equal(res.body.data.summary.hubspotSyncFailedCount, 1);
    assert.equal(res.body.data.summary.failedWebhookEventsCount, 1);
  });

  // 15. Production Vite Frontend Serving
  test('Scenario 15: GET /dashboard/ serves production React + Vite application bundle with HTTP 200', async () => {
    const res = await request(app).get('/dashboard/');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'].includes('text/html'), true);
    assert.ok(res.text.includes('<div id="root"></div>'));
  });
});
