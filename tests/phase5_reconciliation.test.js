const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const app = require('../server/src/app');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const ProductMapping = require('../server/src/models/ProductMapping');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const PaymentRecord = require('../server/src/models/PaymentRecord');
const IntegrationLog = require('../server/src/models/IntegrationLog');
const DashboardService = require('../server/src/services/dashboardService');

let mongoServer;
const VALID_OPERATOR_KEY = 'test_secret_operator_key_999';

function createMockHubSpotClient(dealsMap = {}, companiesMap = {}) {
  return {
    getDeal: async (dealId) => {
      const deal = dealsMap[dealId];
      if (!deal) return { statusCode: 404, data: { message: 'Deal not found' } };
      return { statusCode: 200, data: deal };
    },
    searchClosedWonDeals: async () => {
      const closedWon = Object.values(dealsMap).filter(
        (d) => String(d.properties?.dealstage || '').toLowerCase() === 'closedwon'
      );
      return {
        statusCode: 200,
        data: { results: closedWon }
      };
    },
    getCompany: async (companyId) => {
      const comp = companiesMap[companyId];
      if (!comp) return { statusCode: 404, data: { message: 'Company not found' } };
      return { statusCode: 200, data: comp };
    }
  };
}

function createMockZohoClient() {
  return {
    request: async ({ method, path }) => {
      return { statusCode: 200, data: { code: 0, items: [], contacts: [] } };
    }
  };
}

test.describe('Phase 5: HubSpot Closed Won Deal Reconciliation Mechanism', () => {
  test.before(async () => {
    process.env.OPERATOR_API_KEY = VALID_OPERATOR_KEY;
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  test.after(async () => {
    delete process.env.OPERATOR_API_KEY;
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  test.beforeEach(async () => {
    await IntegrationSync.deleteMany({});
    await WebhookEvent.deleteMany({});
    await CustomerMapping.deleteMany({});
    await ProductMapping.deleteMany({});
    await MilestoneInvoice.deleteMany({});
    await PaymentRecord.deleteMany({});
    await IntegrationLog.deleteMany({});
  });

  // 1. Single Deal Reconciliation
  test('Scenario 1: Reconciling a single Closed Won deal creates IntegrationSync and WebhookEvent', async () => {
    const mockHs = createMockHubSpotClient({
      '360906792672': {
        id: '360906792672',
        properties: {
          dealname: 'BLUEPEAK_MANUAL_TEST_001',
          amount: '120000',
          dealstage: 'closedwon',
          deal_currency_code: 'AED'
        },
        associations: {
          companies: { results: [{ id: '358744099548' }] }
        }
      }
    }, {
      '358744099548': {
        id: '358744099548',
        properties: { name: 'BluePeak Solutions LLC' }
      }
    });

    const result = await DashboardService.reconcileHubSpotDeals({
      dealId: '360906792672',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: createMockZohoClient()
    });

    assert.equal(result.success, true);
    assert.equal(result.reconciledCount, 1);
    assert.equal(result.results[0].action, 'RECONCILED');
    assert.equal(result.results[0].crmDealId, '360906792672');
    assert.equal(result.results[0].customerName, 'BluePeak Solutions LLC');
    assert.equal(result.results[0].amount, 120000);

    // Verify IntegrationSync
    const syncDoc = await IntegrationSync.findOne({ crmDealId: '360906792672' });
    assert.ok(syncDoc);
    assert.equal(syncDoc.dealName, 'BLUEPEAK_MANUAL_TEST_001');
    assert.equal(syncDoc.customerName, 'BluePeak Solutions LLC');
    assert.equal(syncDoc.salesOrderTotal, 120000);
    assert.equal(syncDoc.amountNotInvoiced, 120000);
    assert.equal(syncDoc.currencyCode, 'AED');
    assert.equal(syncDoc.syncStatus, 'PENDING');
    assert.equal(syncDoc.salesOrderStatus, 'NONE');

    // Verify WebhookEvent created
    const evt = await WebhookEvent.findOne({ eventId: 'hs_reconciled_360906792672' });
    assert.ok(evt);
    assert.equal(evt.status, 'RECEIVED');
    assert.equal(evt.source, 'CRM');
  });

  // 2. Idempotency Check
  test('Scenario 2: Reconciling twice is strictly idempotent (no duplicates)', async () => {
    const mockHs = createMockHubSpotClient({
      '360906792672': {
        id: '360906792672',
        properties: {
          dealname: 'BLUEPEAK_MANUAL_TEST_001',
          amount: '120000',
          dealstage: 'closedwon'
        }
      }
    });

    // Run 1
    await DashboardService.reconcileHubSpotDeals({
      dealId: '360906792672',
      injectedHubSpotClient: mockHs
    });

    // Run 2
    const result2 = await DashboardService.reconcileHubSpotDeals({
      dealId: '360906792672',
      injectedHubSpotClient: mockHs
    });

    assert.equal(result2.success, true);

    const countSync = await IntegrationSync.countDocuments({ crmDealId: '360906792672' });
    assert.equal(countSync, 1);

    const countEvt = await WebhookEvent.countDocuments({ 'payload.objectId': '360906792672' });
    assert.equal(countEvt, 1);
  });

  // 3. Preservation of Existing Advanced Deals (NovaTech)
  test('Scenario 3: Preserves existing active and confirmed records (e.g. NovaTech) without modifying them', async () => {
    // Existing NovaTech record
    await IntegrationSync.create({
      crmDealId: 'hs_novatech_deal_001',
      dealName: 'NovaTech Enterprise Cloud Contract',
      customerName: 'NovaTech Global Ltd',
      zohoSalesOrderId: 'so_nova_999',
      zohoSalesOrderNumber: 'SO-00042',
      salesOrderTotal: 126000,
      salesOrderStatus: 'CONFIRMED',
      totalInvoicedAmount: 63000,
      amountNotInvoiced: 63000,
      syncStatus: 'M1_INVOICED',
      currencyCode: 'AED'
    });

    const mockHs = createMockHubSpotClient({
      'hs_novatech_deal_001': {
        id: 'hs_novatech_deal_001',
        properties: {
          dealname: 'NovaTech Modified from CRM',
          amount: '999999',
          dealstage: 'closedwon'
        }
      }
    });

    const result = await DashboardService.reconcileHubSpotDeals({
      dealId: 'hs_novatech_deal_001',
      injectedHubSpotClient: mockHs
    });

    assert.equal(result.results[0].action, 'PRESERVED_EXISTING');

    const preserved = await IntegrationSync.findOne({ crmDealId: 'hs_novatech_deal_001' });
    assert.equal(preserved.salesOrderTotal, 126000); // Original amount preserved
    assert.equal(preserved.syncStatus, 'M1_INVOICED'); // Original status preserved
    assert.equal(preserved.salesOrderStatus, 'CONFIRMED');
    assert.equal(preserved.zohoSalesOrderNumber, 'SO-00042');
  });

  // 4. Non-Closed-Won Deals Skipped
  test('Scenario 4: Deals in non-Closed-Won stages are safely skipped', async () => {
    const mockHs = createMockHubSpotClient({
      'deal_in_progress': {
        id: 'deal_in_progress',
        properties: {
          dealname: 'Early Stage Deal',
          dealstage: 'appointmentscheduled'
        }
      }
    });

    const result = await DashboardService.reconcileHubSpotDeals({
      dealId: 'deal_in_progress',
      injectedHubSpotClient: mockHs
    });

    assert.equal(result.reconciledCount, 0);
    assert.equal(result.results[0].action, 'SKIPPED_NOT_CLOSED_WON');

    const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_in_progress' });
    assert.equal(syncDoc, null);
  });

  // 5. Customer Mapping Ambiguity Safeguard
  test('Scenario 5: Ambiguous customer mapping sets REQUIRES_MANUAL_MATCH without guessing', async () => {
    await CustomerMapping.create({
      hubspotCompanyId: 'comp_ambig_1',
      status: 'AMBIGUOUS',
      reason: 'Found 2 matching contacts in Zoho Books'
    });

    const mockHs = createMockHubSpotClient({
      'deal_ambig_cust': {
        id: 'deal_ambig_cust',
        properties: {
          dealname: 'Ambiguous Customer Deal',
          amount: '150000',
          dealstage: 'closedwon'
        },
        associations: {
          companies: { results: [{ id: 'comp_ambig_1' }] }
        }
      }
    });

    const result = await DashboardService.reconcileHubSpotDeals({
      dealId: 'deal_ambig_cust',
      injectedHubSpotClient: mockHs
    });

    assert.equal(result.results[0].syncStatus, 'REQUIRES_MANUAL_MATCH');

    const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_ambig_cust' });
    assert.equal(syncDoc.syncStatus, 'REQUIRES_MANUAL_MATCH');
    assert.ok(syncDoc.failureReason.includes('Found 2 matching contacts'));
  });

  // 6. Product Mapping Safeguard
  test('Scenario 6: Product mapping safeguard flags REQUIRES_MANUAL_MATCH when product is unmapped', async () => {
    const oldRequire = process.env.REQUIRE_PRODUCT_MAPPING;
    try {
      process.env.REQUIRE_PRODUCT_MAPPING = 'true';
      delete process.env.DEFAULT_ZOHO_ITEM_ID;

      const mockHs = createMockHubSpotClient({
        'deal_unmapped_prod': {
          id: 'deal_unmapped_prod',
          properties: {
            dealname: 'Deal With Unknown SKU',
            amount: '200000',
            dealstage: 'closedwon',
            product_name: 'Custom Proprietary Module'
          }
        }
      });

      const result = await DashboardService.reconcileHubSpotDeals({
        dealId: 'deal_unmapped_prod',
        injectedHubSpotClient: mockHs,
        injectedZohoClient: createMockZohoClient() // returns 0 matching items
      });

      assert.equal(result.results[0].syncStatus, 'REQUIRES_MANUAL_MATCH');

      const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_unmapped_prod' });
      assert.equal(syncDoc.syncStatus, 'REQUIRES_MANUAL_MATCH');
      assert.ok(syncDoc.failureReason.includes('never guess an item') || syncDoc.failureReason.includes('Never guess an item') || syncDoc.failureReason.includes('Product mapping required'));
    } finally {
      process.env.REQUIRE_PRODUCT_MAPPING = oldRequire;
    }
  });

  // 7. Dashboard Overview Reflects Reconciled Deal
  test('Scenario 7: Reconciled deal is immediately reflected in Dashboard overview KPIs without invoices', async () => {
    const mockHs = createMockHubSpotClient({
      '360906792672': {
        id: '360906792672',
        properties: {
          dealname: 'BLUEPEAK_MANUAL_TEST_001',
          amount: '120000',
          dealstage: 'closedwon',
          deal_currency_code: 'AED'
        }
      }
    });

    await DashboardService.reconcileHubSpotDeals({
      dealId: '360906792672',
      injectedHubSpotClient: mockHs
    });

    const res = await request(app).get('/api/dashboard/summary');
    assert.equal(res.status, 200);

    const totals = res.body.data.totals;
    assert.equal(totals.totalContractValue, 120000);
    assert.equal(totals.amountNotInvoiced, 120000);
    assert.equal(totals.totalInvoiced, 0); // No invoices created
    assert.equal(totals.totalCollected, 0); // No payments created
    assert.equal(totals.dealsCount, 1);

    // Verify deals list in summary
    assert.ok(Array.isArray(res.body.data.deals));
    assert.equal(res.body.data.deals.length, 1);
    assert.equal(res.body.data.deals[0].crmDealId, '360906792672');
  });

  // 8. GET /api/dashboard/deals Endpoint
  test('Scenario 8: GET /api/dashboard/deals returns paginated deals with search', async () => {
    await IntegrationSync.create({
      crmDealId: '360906792672',
      dealName: 'BLUEPEAK_MANUAL_TEST_001',
      customerName: 'BluePeak Solutions LLC',
      salesOrderTotal: 120000,
      currencyCode: 'AED',
      syncStatus: 'PENDING'
    });

    const res = await request(app).get('/api/dashboard/deals?search=BluePeak');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.deals.length, 1);
    assert.equal(res.body.data.deals[0].crmDealId, '360906792672');
  });

  // 9. Operator Endpoint Authorization & Execution
  test('Scenario 9: POST /api/operator/reconcile-hubspot-deals requires operator authorization', async () => {
    // Unauthenticated
    const resNoAuth = await request(app)
      .post('/api/operator/reconcile-hubspot-deals')
      .send({ dealId: '360906792672' });
    assert.equal(resNoAuth.status, 401);

    // Authorized
    const resAuth = await request(app)
      .post('/api/operator/reconcile-hubspot-deals')
      .set('x-operator-key', VALID_OPERATOR_KEY)
      .send({ dealId: 'non_existent_deal' });
    assert.equal(resAuth.status, 404); // Deal not found in HubSpot
  });

  // 10. Financial Isolation: Zero Invoices and Payments Created
  test('Scenario 10: Reconciliation strictly produces zero invoices and zero payments', async () => {
    const mockHs = createMockHubSpotClient({
      'deal_no_invoices': {
        id: 'deal_no_invoices',
        properties: {
          dealname: 'Deal Without Invoices',
          amount: '80000',
          dealstage: 'closedwon'
        }
      }
    });

    await DashboardService.reconcileHubSpotDeals({
      dealId: 'deal_no_invoices',
      injectedHubSpotClient: mockHs
    });

    const invoiceCount = await MilestoneInvoice.countDocuments({});
    assert.equal(invoiceCount, 0, 'No MilestoneInvoice records should be created during reconciliation');

    const paymentCount = await PaymentRecord.countDocuments({});
    assert.equal(paymentCount, 0, 'No PaymentRecord records should be created during reconciliation');
  });
});

