const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const IntegrationSync = require('../server/src/models/IntegrationSync');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const {
  OrchestrationService,
  calculateOverdueStatus,
  formatHubSpotDate,
  updateHubSpotDealWithRetry
} = require('../server/src/services/orchestrationService');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  await IntegrationSync.init();
  await CustomerMapping.init();
  await MilestoneInvoice.init();
  await WebhookEvent.init();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await IntegrationSync.deleteMany({});
  await CustomerMapping.deleteMany({});
  await MilestoneInvoice.deleteMany({});
  await WebhookEvent.deleteMany({});
});

/**
 * Creates controllable mock HubSpot Client
 */
function createMockHubSpotClient({
  dealStage = 'closedwon',
  dealAmount = 120000.0,
  companyId = 'comp_hs_100',
  contactId = 'cont_hs_200',
  dealName = 'Enterprise Software Deal',
  updateFails = false,
  rateLimitFailuresCount = 0
} = {}) {
  const calls = [];
  let updateAttempts = 0;

  return {
    calls,
    getDeal: async (dealId) => {
      calls.push({ method: 'GET', path: `/crm/v3/objects/deals/${dealId}` });
      return {
        statusCode: 200,
        data: {
          id: dealId,
          properties: {
            dealname: dealName,
            dealstage: dealStage,
            amount: dealAmount,
            company: 'Acme Corp',
            email: 'billing@acme.com'
          },
          associations: {
            companies: { results: [{ id: companyId }] },
            contacts: { results: [{ id: contactId }] }
          }
        }
      };
    },
    updateDeal: async (dealId, properties) => {
      calls.push({ method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}`, properties });
      updateAttempts++;

      if (updateFails) {
        return { statusCode: 500, data: { message: 'Internal HubSpot Server Error' } };
      }

      if (updateAttempts <= rateLimitFailuresCount) {
        return { statusCode: 429, data: { message: 'Rate limit exceeded (HTTP 429)' } };
      }

      return { statusCode: 200, data: { id: dealId, properties } };
    }
  };
}

let globalSoCounter = 1;
let globalInvCounter = 1;

/**
 * Creates controllable mock Zoho Books Client
 */
function createMockZohoClient({
  contacts = [],
  existingSalesOrders = [],
  existingInvoices = [],
  createSoFails = false,
  createInvFails = false,
  invBalance = 63000.0,
  invDueDate = '2026-11-30',
  omitInvBalance = false,
  taxPercentage = 5.0
} = {}) {
  const calls = [];

  return {
    calls,
    request: async ({ method, path, body }) => {
      calls.push({ method, path, body });

      // GET /contacts
      if (method === 'GET' && path.startsWith('/contacts')) {
        return { statusCode: 200, data: { code: 0, contacts } };
      }

      // POST /contacts
      if (method === 'POST' && path === '/contacts') {
        return {
          statusCode: 200,
          data: {
            code: 0,
            contact: {
              contact_id: 'cust_zoho_mock_auto',
              contact_name: body.contact_name || body.company_name
            }
          }
        };
      }

      // GET /salesorders?reference_number=...
      if (method === 'GET' && path.startsWith('/salesorders?reference_number=')) {
        return { statusCode: 200, data: { code: 0, salesorders: existingSalesOrders } };
      }

      // POST /salesorders
      if (method === 'POST' && path === '/salesorders') {
        if (createSoFails) {
          return { statusCode: 400, data: { code: 1001, message: 'Zoho Sales Order create failed' } };
        }
        const subtotal = body.line_items[0].rate;
        const taxRate = (taxPercentage !== undefined && taxPercentage !== null) ? Number(taxPercentage) : 5.0;
        const tax = Number((subtotal * (taxRate / 100)).toFixed(2));
        const total = Number((subtotal + tax).toFixed(2));
        return {
          statusCode: 200,
          data: {
            code: 0,
            salesorder: {
              salesorder_id: `so_mock_${globalSoCounter++}`,
              salesorder_number: 'SO-00001',
              reference_number: body.reference_number,
              customer_id: body.customer_id,
              sub_total: subtotal,
              tax_total: tax,
              total,
              status: 'draft',
              currency_code: 'AED',
              line_items: [
                {
                  line_item_id: 'so_item_mock_001',
                  name: body.line_items[0].name,
                  rate: subtotal
                }
              ]
            }
          }
        };
      }

      // POST /salesorders/:id/status/confirm
      if (method === 'POST' && path.includes('/status/confirm')) {
        return {
          statusCode: 200,
          data: {
            code: 0,
            salesorder: {
              status: 'confirmed'
            }
          }
        };
      }

      // GET /invoices?reference_number=...
      if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
        return { statusCode: 200, data: { code: 0, invoices: existingInvoices } };
      }

      // POST /invoices
      if (method === 'POST' && path === '/invoices') {
        if (createInvFails) {
          return { statusCode: 400, data: { code: 2001, message: 'Zoho Invoice create failed' } };
        }
        const subtotal = body.line_items[0].rate;
        const taxRate = (taxPercentage !== undefined && taxPercentage !== null) ? Number(taxPercentage) : 5.0;
        const tax = Number((subtotal * (taxRate / 100)).toFixed(2));
        const total = Number((subtotal + tax).toFixed(2));
        const inv = {
          invoice_id: `inv_mock_${globalInvCounter++}`,
          invoice_number: 'INV-00001',
          reference_number: body.reference_number,
          customer_id: body.customer_id,
          salesorder_id: body.salesorder_id,
          sub_total: subtotal,
          tax_total: tax,
          total,
          due_date: invDueDate,
          status: 'draft',
          currency_code: 'AED',
          line_items: [
            {
              line_item_id: 'inv_item_mock_001',
              salesorder_item_id: body.line_items[0].salesorder_item_id,
              rate: subtotal,
              quantity: 1
            }
          ]
        };
        if (!omitInvBalance) {
          inv.balance = taxRate === 0 ? total : invBalance;
        }
        return {
          statusCode: 200,
          data: {
            code: 0,
            invoice: inv
          }
        };
      }

      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

test('Phase 3 Step 4: HubSpot Deal Property Updates & End-to-End Orchestration', async (t) => {
  // 1. Successful Mocked Closed Won Orchestration
  await t.test('Scenario 1: Successful end-to-end orchestration for Closed Won deal', async () => {
    const mockHs = createMockHubSpotClient({ dealAmount: 120000.0 });
    const mockZoho = createMockZohoClient();

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_success_101',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'SYNCED');
    assert.equal(res.crmDealId, 'deal_success_101');
    assert.ok(res.zohoSalesOrderId);
    assert.ok(res.zohoInvoiceId);

    // Verify MongoDB IntegrationSync
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_success_101' });
    assert.ok(sync);
    assert.equal(sync.syncStatus, 'SYNCED');
    assert.equal(sync.salesOrderStatus, 'CONFIRMED');
    assert.equal(sync.salesOrderTotal, 126000.0);
    assert.equal(sync.percentageInvoiced, 50.0);
    assert.equal(sync.amountNotInvoiced, 63000.0);
    assert.equal(sync.amountInvoicedUnpaid, 63000.0);
    assert.equal(sync.amountCollected, 0.0);
    assert.equal(sync.percentageCollected, 0.0);
    assert.equal(sync.currencyCode, 'AED');

    // Verify HubSpot PATCH call was made with exact properties
    const updateCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.ok(updateCall, 'HubSpot PATCH call must be executed');
    assert.equal(updateCall.properties.integration_sync_status, 'SYNCED');
    assert.equal(updateCall.properties.zoho_sales_order_total, 126000.0);
    assert.equal(updateCall.properties.zoho_total_invoiced_amount, 63000.0);
    assert.equal(updateCall.properties.zoho_percentage_invoiced, 50.0);
    assert.equal(updateCall.properties.zoho_amount_not_invoiced, 63000.0);
    assert.equal(updateCall.properties.zoho_currency_code, 'AED');
    assert.equal(updateCall.properties.zoho_is_overdue, 'false');
    assert.equal(typeof updateCall.properties.zoho_is_overdue, 'string');
    assert.equal(updateCall.properties.integration_milestone_stage, 'M1_INVOICED');
  });

  // 2. Duplicate Webhook / Repeated Orchestration Idempotency
  await t.test('Scenario 2: Duplicate orchestration execution does not duplicate financial records', async () => {
    const mockHs = createMockHubSpotClient();
    const mockZoho = createMockZohoClient();

    // First execution
    await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_idempotent_202',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    const soPostsAfterFirst = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/salesorders').length;
    const invPostsAfterFirst = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;
    assert.equal(soPostsAfterFirst, 1);
    assert.equal(invPostsAfterFirst, 1);

    // Second execution (duplicate event or retry)
    const secondRes = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_idempotent_202',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(secondRes.status, 'SYNCED');

    // Zero new Sales Order or Invoice creation calls
    const soPostsAfterSecond = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/salesorders').length;
    const invPostsAfterSecond = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;
    assert.equal(soPostsAfterSecond, soPostsAfterFirst, '0 new Sales Orders created');
    assert.equal(invPostsAfterSecond, invPostsAfterFirst, '0 new Invoices created');

    // Verify only 1 MilestoneInvoice exists in MongoDB
    const invoices = await MilestoneInvoice.find({ crmDealId: 'deal_idempotent_202' });
    assert.equal(invoices.length, 1);
  });

  // 3. Deal No Longer Closed Won Before Processing
  await t.test('Scenario 3: Halts safely if deal is no longer Closed Won in HubSpot', async () => {
    const mockHs = createMockHubSpotClient({ dealStage: 'appointmentscheduled' });
    const mockZoho = createMockZohoClient();

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_not_closed_won',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'SKIPPED_NOT_CLOSED_WON');

    // Verify ZERO calls made to Zoho Books
    assert.equal(mockZoho.calls.length, 0, 'No Zoho calls should be made if stage is not closedwon');

    // Verify no Sales Order or Invoice was created
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_not_closed_won' });
    assert.equal(sync.salesOrderStatus, 'NONE');
  });

  // 4. Customer Mapping Failure Halts Downstream Operations
  await t.test('Scenario 4: Ambiguous customer mapping halts processing and notifies HubSpot', async () => {
    // 2 candidates returned from Zoho -> ambiguous!
    const mockZoho = createMockZohoClient({
      contacts: [
        { contact_id: 'cust_dup_1', contact_name: 'Acme One', company_name: 'Acme Corp' },
        { contact_id: 'cust_dup_2', contact_name: 'Acme Two', company_name: 'Acme Corp' }
      ]
    });
    const mockHs = createMockHubSpotClient();

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_ambiguous_cust',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'REQUIRES_MANUAL_MATCH');

    // Verify downstream Sales Order was NEVER created
    const soCalls = mockZoho.calls.filter((c) => c.path.startsWith('/salesorders'));
    assert.equal(soCalls.length, 0, 'Downstream Sales Order must not be created');

    // Verify HubSpot was notified of manual match required
    const updateCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.ok(updateCall);
    assert.equal(updateCall.properties.integration_sync_status, 'REQUIRES_MANUAL_MATCH');
  });

  // 5. Sales Order Creation Failure Halts Invoice Creation
  await t.test('Scenario 5: Sales Order failure stops downstream Invoice creation', async () => {
    const mockZoho = createMockZohoClient({ createSoFails: true });
    const mockHs = createMockHubSpotClient();

    await assert.rejects(
      async () => {
        await OrchestrationService.processClosedWonDeal({
          crmDealId: 'deal_so_fails',
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.match(err.message, /Sales Order|Zoho/i);
        return true;
      }
    );

    // Verify ZERO invoice calls were made
    const invCalls = mockZoho.calls.filter((c) => c.path.startsWith('/invoices'));
    assert.equal(invCalls.length, 0, 'Invoice creation must not be reached if SO fails');

    // Verify IntegrationSync is marked FAILED
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_so_fails' });
    assert.equal(sync.syncStatus, 'FAILED');
  });

  // 6. M1 Invoice Failure Preserves Error State
  await t.test('Scenario 6: Invoice failure preserves error state and pushes to HubSpot without SYNCED', async () => {
    const mockZoho = createMockZohoClient({ createInvFails: true });
    const mockHs = createMockHubSpotClient();

    await assert.rejects(
      async () => {
        await OrchestrationService.processClosedWonDeal({
          crmDealId: 'deal_inv_fails',
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.match(err.message, /Invoice|Zoho/i);
        return true;
      }
    );

    // Verify IntegrationSync is marked FAILED (never SYNCED)
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_inv_fails' });
    assert.equal(sync.syncStatus, 'FAILED');
    assert.notEqual(sync.syncStatus, 'SYNCED');

    // Verify HubSpot received FAILED status
    const updateCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.ok(updateCall);
    assert.equal(updateCall.properties.integration_sync_status, 'FAILED');
  });

  // 7. RECONCILIATION_REQUIRED Blocks Second POST & Preserves State
  await t.test('Scenario 7: RECONCILIATION_REQUIRED blocks second POST and does not mark SYNCED', async () => {
    // Seed deal in RECONCILIATION_REQUIRED state
    await IntegrationSync.create({
      crmDealId: 'deal_reconciliation_prot',
      salesOrderStatus: 'CONFIRMED',
      zohoSalesOrderId: 'so_confirmed_888',
      zohoSalesOrderNumber: 'SO-00888',
      zohoSalesOrderLineItemId: 'so_item_mock_001',
      zohoContactId: 'cust_888',
      syncStatus: 'RECONCILIATION_REQUIRED',
      salesOrderTotal: 126000.0,
      salesOrderSubtotal: 120000.0,
      currencyCode: 'AED'
    });

    await CustomerMapping.create({
      hubspotCompanyId: 'comp_hs_100',
      zohoContactId: 'cust_888',
      status: 'ACTIVE'
    });

    const mockZoho = {
      calls: [],
      request: async ({ method, path }) => {
        mockZoho.calls.push({ method, path });
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          // Lookup returns 0 matches
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST') {
          throw new Error('ILLEGAL POST during unresolved reconciliation');
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };
    const mockHs = createMockHubSpotClient();

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_reconciliation_prot',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'RECONCILIATION_REQUIRED');

    // Verify 0 POST calls were made to Zoho
    const postCalls = mockZoho.calls.filter((c) => c.method === 'POST');
    assert.equal(postCalls.length, 0);

    // Verify HubSpot was updated with RECONCILIATION_REQUIRED, never SYNCED
    const updateCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.ok(updateCall);
    assert.equal(updateCall.properties.integration_sync_status, 'RECONCILIATION_REQUIRED');
  });

  // 8. Successful Zoho Workflow Followed by HubSpot Update Failure
  await t.test('Scenario 8: Successful Zoho creation with HubSpot failure persists retryable state without deleting records', async () => {
    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient({ updateFails: true });

    await assert.rejects(
      async () => {
        await OrchestrationService.processClosedWonDeal({
          crmDealId: 'deal_hs_fails',
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.match(err.message, /HubSpot|500/i);
        return true;
      }
    );

    // Verify Zoho records were created successfully
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_hs_fails' });
    assert.ok(sync.zohoSalesOrderId);
    assert.equal(sync.salesOrderStatus, 'CONFIRMED');
    assert.equal(sync.syncStatus, 'HUBSPOT_SYNC_FAILED');

    const mDoc = await MilestoneInvoice.findOne({ crmDealId: 'deal_hs_fails', milestoneIndex: 1 });
    assert.ok(mDoc);
    assert.equal(mDoc.status, 'CREATED');
  });

  // 9. Retry of HubSpot Update Does NOT Recreate Zoho Invoices (0 Creation Calls)
  await t.test('Scenario 9: Retrying after HubSpot failure makes ZERO new Zoho creation calls', async () => {
    const mockZoho = createMockZohoClient();
    const mockHsFailing = createMockHubSpotClient({ updateFails: true });

    // Step A: First attempt creates customer, SO & M1 in Zoho, but fails updating HubSpot
    await assert.rejects(async () => {
      await OrchestrationService.processClosedWonDeal({
        crmDealId: 'deal_retry_zero_calls',
        injectedHubSpotClient: mockHsFailing,
        injectedZohoClient: mockZoho
      });
    });

    const custPostsFirst = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/contacts').length;
    const soPostsFirst = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/salesorders').length;
    const invPostsFirst = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;

    assert.equal(custPostsFirst, 1, 'Initial customer created');
    assert.equal(soPostsFirst, 1, 'Initial SO created');
    assert.equal(invPostsFirst, 1, 'Initial invoice created');

    const custCountBefore = await CustomerMapping.countDocuments({ hubspotCompanyId: 'comp_hs_100' });
    assert.equal(custCountBefore, 1);

    // Step B: Retry with healthy HubSpot client
    const mockHsHealthy = createMockHubSpotClient({ updateFails: false });
    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_retry_zero_calls',
      injectedHubSpotClient: mockHsHealthy,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'SYNCED');

    // CRUCIAL ASSERTIONS:
    // 1. Zero new customer creation POSTs
    const custPostsRetry = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/contacts').length;
    assert.equal(custPostsRetry, custPostsFirst, 'Retry must NOT recreate customer');
    const custCountAfter = await CustomerMapping.countDocuments({ hubspotCompanyId: 'comp_hs_100' });
    assert.equal(custCountAfter, 1, 'Customer mappings count must remain exactly 1');

    // 2. Zero new Sales Order creation POSTs
    const soPostsRetry = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/salesorders').length;
    assert.equal(soPostsRetry, soPostsFirst, 'Retry must NOT create another Sales Order');

    // 3. Zero new M1 invoice creation POSTs
    const invPostsRetry = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;
    assert.equal(invPostsRetry, invPostsFirst, 'Retry must NOT create another M1 invoice');

    // 4. Only the required HubSpot property update is performed
    const patchCalls = mockHsHealthy.calls.filter((c) => c.method === 'PATCH');
    assert.equal(patchCalls.length, 1, 'Only HubSpot property update must be performed on retry');

    // Verify IntegrationSync is now SYNCED
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_retry_zero_calls' });
    assert.equal(sync.syncStatus, 'SYNCED');
  });

  // 10. Correct HubSpot Financial Property Values
  await t.test('Scenario 10: Accurate financial calculations in integer minor units pushed to HubSpot', async () => {
    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient({ dealAmount: 120000.0 });

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_financial_check',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'SYNCED');
    const props = res.properties;

    // Financial assertions:
    assert.equal(props.zoho_sales_order_total, 126000.0);
    assert.equal(props.zoho_total_invoiced_amount, 63000.0);
    assert.equal(props.zoho_percentage_invoiced, 50.0);
    assert.equal(props.zoho_amount_not_invoiced, 63000.0);
    assert.equal(props.zoho_amount_invoiced_unpaid, 63000.0);
    assert.equal(props.zoho_total_collected_amount, 0.0);
    assert.equal(props.zoho_percentage_collected, 0.0);
    assert.equal(props.zoho_payment_status, 'UNPAID');
    assert.equal(props.zoho_currency_code, 'AED');
    assert.equal(props.zoho_is_overdue, 'false');
    assert.equal(typeof props.zoho_is_overdue, 'string');
  });

  // 10B. String Formatting for zoho_is_overdue Property
  await t.test('Scenario 10B: Proves zoho_is_overdue sends string "true" when overdue and "false" when not overdue, with typeof string', async () => {
    const mockHs = createMockHubSpotClient();

    // Case 1: Non-overdue deal (due date is in the future: 2026-11-30)
    const mockZohoFuture = createMockZohoClient({ invDueDate: '2026-11-30', invBalance: 63000.0 });
    const resFuture = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_overdue_false_str',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZohoFuture,
      referenceDate: new Date('2026-10-31T12:00:00Z')
    });

    assert.equal(resFuture.status, 'SYNCED');
    assert.equal(resFuture.properties.zoho_is_overdue, 'false');
    assert.equal(typeof resFuture.properties.zoho_is_overdue, 'string');

    // Verify the actual payload passed to HubSpot PATCH
    const patchCallFuture = mockHs.calls.find(
      (c) => c.method === 'PATCH' && c.path === '/crm/v3/objects/deals/deal_overdue_false_str'
    );
    assert.ok(patchCallFuture);
    assert.equal(patchCallFuture.properties.zoho_is_overdue, 'false');
    assert.equal(typeof patchCallFuture.properties.zoho_is_overdue, 'string');

    // Case 2: Overdue deal (due date is in the past: 2026-10-15 and balance > 0)
    const mockZohoPast = createMockZohoClient({ invDueDate: '2026-10-15', invBalance: 63000.0 });
    const resPast = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_overdue_true_str',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZohoPast,
      referenceDate: new Date('2026-10-31T12:00:00Z')
    });

    assert.equal(resPast.status, 'SYNCED');
    assert.equal(resPast.properties.zoho_is_overdue, 'true');
    assert.equal(typeof resPast.properties.zoho_is_overdue, 'string');

    // Verify the actual payload passed to HubSpot PATCH
    const patchCallPast = mockHs.calls.find(
      (c) => c.method === 'PATCH' && c.path === '/crm/v3/objects/deals/deal_overdue_true_str'
    );
    assert.ok(patchCallPast);
    assert.equal(patchCallPast.properties.zoho_is_overdue, 'true');
    assert.equal(typeof patchCallPast.properties.zoho_is_overdue, 'string');
  });

  // 11. Unknown Payment Information Safely Handled (Not Fabricated as Zero)
  await t.test('Scenario 11: Unknown payment information leaves collection fields unset and reports PAYMENT_INFO_UNAVAILABLE', async () => {
    const mockZoho = createMockZohoClient({ omitInvBalance: true });
    const mockHs = createMockHubSpotClient();

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_unknown_payment',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'SYNCED');
    const props = res.properties;

    // Collection amounts must NOT be fabricated as 0
    assert.equal(props.zoho_total_collected_amount, undefined);
    assert.equal(props.zoho_percentage_collected, undefined);
    assert.equal(props.zoho_payment_status, 'PAYMENT_INFO_UNAVAILABLE');

    // MongoDB sync record reflects PAYMENT_INFO_UNAVAILABLE
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_unknown_payment' });
    assert.equal(sync.paymentInfoStatus, 'PAYMENT_INFO_UNAVAILABLE');
  });

  // 12. HubSpot Rate Limiting & Retry Behavior
  await t.test('Scenario 12: Recovers from HubSpot HTTP 429 rate limit via bounded exponential backoff', async () => {
    const mockZoho = createMockZohoClient();
    // HubSpot fails first 2 attempts with 429, then succeeds on 3rd attempt
    const mockHs = createMockHubSpotClient({ rateLimitFailuresCount: 2 });

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_ratelimit_retry',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'SYNCED');

    // Verify 3 PATCH calls were made before succeeding
    const patchCalls = mockHs.calls.filter((c) => c.method === 'PATCH');
    assert.equal(patchCalls.length, 3);
  });

  // 13. Worker Restart and Repeated Orchestration Recovery
  await t.test('Scenario 13: Worker restart recovery resumes from checkpoint without duplicating SO', async () => {
    // Simulate server crash after SO confirmed but before invoice created
    await IntegrationSync.create({
      crmDealId: 'deal_crash_so_done',
      zohoContactId: 'cust_crash_1',
      zohoSalesOrderId: 'so_crashed_checkpoint_123',
      zohoSalesOrderNumber: 'SO-CHK-001',
      zohoSalesOrderLineItemId: 'so_item_mock_001',
      salesOrderStatus: 'CONFIRMED',
      salesOrderTotal: 126000.0,
      salesOrderSubtotal: 120000.0,
      currencyCode: 'AED',
      syncStatus: 'SALES_ORDER_CONFIRMED'
    });

    await CustomerMapping.create({
      hubspotCompanyId: 'comp_hs_100',
      zohoContactId: 'cust_crash_1',
      status: 'ACTIVE'
    });

    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient();

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_crash_so_done',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'SYNCED');

    // Sales Order was adopted, NOT recreated!
    const soPosts = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/salesorders');
    assert.equal(soPosts.length, 0, 'Must NOT recreate Sales Order if already confirmed');

    // Invoice was created
    const invPosts = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices');
    assert.equal(invPosts.length, 1);
  });

  // 14. Proof That M2 and M3 Are Never Created
  await t.test('Scenario 14: Verifies M2 and M3 milestones are NEVER created or scheduled', async () => {
    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient();

    await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_m1_only_proof',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    // Check all milestone invoices for this deal
    const m1 = await MilestoneInvoice.findOne({ crmDealId: 'deal_m1_only_proof', milestoneIndex: 1 });
    const m2 = await MilestoneInvoice.findOne({ crmDealId: 'deal_m1_only_proof', milestoneIndex: 2 });
    const m3 = await MilestoneInvoice.findOne({ crmDealId: 'deal_m1_only_proof', milestoneIndex: 3 });

    assert.ok(m1, 'M1 invoice must exist');
    assert.equal(m2, null, 'M2 invoice must NOT exist');
    assert.equal(m3, null, 'M3 invoice must NOT exist');

    // Only 1 invoice POST call occurred
    const invPosts = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices');
    assert.equal(invPosts.length, 1);
  });

  // 15. Due-Date Boundary and Timezone Tests
  await t.test('Scenario 15A: Invoice due date is today and still unpaid is NOT overdue', () => {
    // Due today: 2026-10-31, evaluated at midday UTC
    const dueDate = '2026-10-31';
    const referenceDate = new Date('2026-10-31T12:00:00Z');

    const isOverdue = calculateOverdueStatus({
      dueDate,
      balance: 63000.0,
      referenceDate
    });

    assert.equal(isOverdue, false, 'An invoice due today must not be overdue before the end of the day');
  });

  await t.test('Scenario 15B: Invoice due date was yesterday and still unpaid IS overdue', () => {
    // Due yesterday: 2026-10-30, evaluated on 2026-10-31
    const dueDate = '2026-10-30';
    const referenceDate = new Date('2026-10-31T01:00:00Z');

    const isOverdue = calculateOverdueStatus({
      dueDate,
      balance: 63000.0,
      referenceDate
    });

    assert.equal(isOverdue, true, 'An invoice whose due date has passed with balance > 0 must be overdue');
  });

  await t.test('Scenario 15C: Invoice due date is today and fully paid is NOT overdue', () => {
    const dueDate = '2026-10-31';
    const referenceDate = new Date('2026-10-31T12:00:00Z');

    const isOverdue = calculateOverdueStatus({
      dueDate,
      balance: 0,
      referenceDate
    });

    assert.equal(isOverdue, false, 'Fully paid invoice due today must never be marked overdue');
  });

  await t.test('Scenario 15D: Invoice due date was yesterday and fully paid is NEVER marked overdue', () => {
    const dueDate = '2026-10-15'; // 16 days in the past
    const referenceDate = new Date('2026-10-31T12:00:00Z');

    const isOverdue = calculateOverdueStatus({
      dueDate,
      balance: 0,
      referenceDate
    });

    assert.equal(isOverdue, false, 'Fully paid invoice in the past must never be marked overdue');
  });

  await t.test('Scenario 15E: Missing or invalid due date is safely handled as NOT overdue', () => {
    const referenceDate = new Date('2026-10-31T12:00:00Z');

    assert.equal(calculateOverdueStatus({ dueDate: null, balance: 63000.0, referenceDate }), false);
    assert.equal(calculateOverdueStatus({ dueDate: undefined, balance: 63000.0, referenceDate }), false);
    assert.equal(calculateOverdueStatus({ dueDate: '', balance: 63000.0, referenceDate }), false);
    assert.equal(calculateOverdueStatus({ dueDate: 'not-a-valid-date', balance: 63000.0, referenceDate }), false);
  });

  await t.test('Scenario 15F: Consistent UTC date interpretation across timezone boundaries', () => {
    // Due 2026-10-31: End of day UTC is 2026-10-31T23:59:59.999Z
    const dueDate = '2026-10-31';

    // 1 millisecond before UTC end-of-day: NOT overdue
    const beforeEndOfDay = new Date('2026-10-31T23:59:59.998Z');
    assert.equal(calculateOverdueStatus({ dueDate, balance: 500, referenceDate: beforeEndOfDay }), false);

    // 1 millisecond after UTC end-of-day: IS overdue
    const afterEndOfDay = new Date('2026-11-01T00:00:00.001Z');
    assert.equal(calculateOverdueStatus({ dueDate, balance: 500, referenceDate: afterEndOfDay }), true);
  });

  // 17. Concurrent Orchestration Lock
  await t.test('Scenario 17: Concurrent orchestration workers are locked (only one succeeds)', async () => {
    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient();

    // Worker A claims lease
    await OrchestrationService.acquireOrchestrationLock('deal_concurrent_test', 'worker_alpha_1', 60000);

    // Worker B attempts to process simultaneously with different worker ID
    await assert.rejects(
      async () => {
        await OrchestrationService.acquireOrchestrationLock('deal_concurrent_test', 'worker_beta_2', 60000);
      },
      (err) => {
        assert.equal(err.code, 'CONCURRENT_ORCHESTRATION_CONFLICT');
        return true;
      }
    );

    // Release lock
    await OrchestrationService.releaseOrchestrationLock('deal_concurrent_test', 'worker_alpha_1');

    // Worker B can now claim the lock
    const claimed = await OrchestrationService.acquireOrchestrationLock('deal_concurrent_test', 'worker_beta_2', 60000);
    assert.ok(claimed);
    assert.equal(claimed.orchestrationLockedBy, 'worker_beta_2');
    await OrchestrationService.releaseOrchestrationLock('deal_concurrent_test', 'worker_beta_2');
  });

  // 18. Abandoned Lease Recovery
  await t.test('Scenario 18: Expired orchestration lease can be safely recovered by a new worker', async () => {
    // Worker A acquired lease in past (expired)
    await IntegrationSync.create({
      crmDealId: 'deal_abandoned_lease',
      orchestrationLockedBy: 'crashed_worker_99',
      orchestrationLockedAt: new Date(Date.now() - 600000),
      orchestrationLeaseExpiresAt: new Date(Date.now() - 300000) // Expired 5 minutes ago!
    });

    // New worker B arrives -> safely takes over expired lease
    const recovered = await OrchestrationService.acquireOrchestrationLock('deal_abandoned_lease', 'worker_recovery_77', 60000);
    assert.ok(recovered);
    assert.equal(recovered.orchestrationLockedBy, 'worker_recovery_77');
    assert.ok(recovered.orchestrationLeaseExpiresAt > new Date());
  });

  // 18B. Stale-Worker Fencing Guard Rejection
  await t.test('Scenario 18B: Fencing guard aborts state update if worker lease expired or was preempted', async () => {
    // Worker A acquired lease that has expired
    await IntegrationSync.create({
      crmDealId: 'deal_fenced_worker',
      orchestrationLockedBy: 'worker_slow_stale',
      orchestrationLockedAt: new Date(Date.now() - 600000),
      orchestrationLeaseExpiresAt: new Date(Date.now() - 1000) // Stale/expired lease!
    });

    await MilestoneInvoice.create({
      crmDealId: 'deal_fenced_worker',
      syncId: new mongoose.Types.ObjectId(),
      milestoneIndex: 1,
      milestoneName: 'Signing',
      percentage: 50,
      subtotal: 60000.0,
      totalAmount: 63000.0,
      balance: 63000.0,
      status: 'CREATED'
    });

    const mockHs = createMockHubSpotClient();
    const mockZoho = createMockZohoClient();

    // Invoking orchestration with expired lease throws ORCHESTRATION_LEASE_FENCED
    await assert.rejects(
      async () => {
        await OrchestrationService.processClosedWonDeal({
          crmDealId: 'deal_fenced_worker',
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho,
          workerId: 'worker_slow_stale',
          leaseDurationMs: 1 // Instantly expires
        });
      },
      (err) => {
        // Fencing guard triggers when lease expired during execution
        assert.ok(err.code === 'ORCHESTRATION_LEASE_FENCED' || err.message.includes('Fencing Guard'));
        return true;
      }
    );
  });

  // 18C. Lease Renewal Failure When Expired or Not Owned
  await t.test('Scenario 18C: Lease renewal fails atomically when worker does not hold active lease', async () => {
    // Deal is locked by worker_alpha
    await IntegrationSync.create({
      crmDealId: 'deal_renewal_test',
      orchestrationLockedBy: 'worker_alpha',
      orchestrationLockedAt: new Date(),
      orchestrationLeaseExpiresAt: new Date(Date.now() + 60000)
    });

    // Worker Beta tries to renew Worker Alpha's lease -> rejected
    await assert.rejects(
      async () => {
        await OrchestrationService.renewOrchestrationLock('deal_renewal_test', 'worker_beta', 60000);
      },
      (err) => {
        assert.equal(err.code, 'ORCHESTRATION_LEASE_RENEWAL_FAILED');
        return true;
      }
    );

    // Expired lease cannot be renewed by original worker after expiration
    await IntegrationSync.updateOne(
      { crmDealId: 'deal_renewal_test' },
      { $set: { orchestrationLeaseExpiresAt: new Date(Date.now() - 1000) } }
    );

    await assert.rejects(
      async () => {
        await OrchestrationService.renewOrchestrationLock('deal_renewal_test', 'worker_alpha', 60000);
      },
      (err) => {
        assert.equal(err.code, 'ORCHESTRATION_LEASE_RENEWAL_FAILED');
        return true;
      }
    );
  });

  // 18D. Lease Release Cannot Release Another Worker's Lease
  await t.test('Scenario 18D: Worker release cannot clear lease held by a different worker', async () => {
    await IntegrationSync.create({
      crmDealId: 'deal_release_test',
      orchestrationLockedBy: 'worker_owner_100',
      orchestrationLockedAt: new Date(),
      orchestrationLeaseExpiresAt: new Date(Date.now() + 60000)
    });

    // Impostor worker attempts release
    await OrchestrationService.releaseOrchestrationLock('deal_release_test', 'impostor_worker_999');

    // Verify lease is STILL held by worker_owner_100!
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_release_test' });
    assert.equal(sync.orchestrationLockedBy, 'worker_owner_100');
    assert.ok(sync.orchestrationLeaseExpiresAt > new Date());
  });

  // 19. End-to-End QueueService Processing
  await t.test('Scenario 19: Processes queued WebhookEvent from durable queue', async () => {
    // Ingest event into queue
    await WebhookEvent.create({
      eventId: 'evt_queue_001',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: { objectId: 'deal_queued_303' }
    });

    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient();

    const queueRes = await OrchestrationService.processNextQueuedEvent({
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.ok(queueRes);
    assert.equal(queueRes.eventId, 'evt_queue_001');
    assert.equal(queueRes.crmDealId, 'deal_queued_303');
    assert.equal(queueRes.result.status, 'SYNCED');

    // Verify event is marked PROCESSED
    const eventDoc = await WebhookEvent.findOne({ eventId: 'evt_queue_001' });
    assert.equal(eventDoc.status, 'PROCESSED');
    assert.ok(eventDoc.processedAt);
  });

  // 20. End-to-End Tax and Currency ID Forwarding for Sales Order & Milestone 1
  await t.test('Scenario 20: End-to-end orchestration passes configured tax ID and currency ID to Sales Order and M1 Invoice', async () => {
    const originalTaxId = process.env.ZOHO_UAE_VAT_TAX_ID;
    const originalCurrencyId = process.env.ZOHO_AED_CURRENCY_ID;
    try {
      process.env.ZOHO_UAE_VAT_TAX_ID = 'tax_orch_uae_vat_5';
      process.env.ZOHO_AED_CURRENCY_ID = 'curr_orch_aed_id';

      const mockZoho = createMockZohoClient();
      const mockHs = createMockHubSpotClient({ dealAmount: 120000.0 });

      const res = await OrchestrationService.processClosedWonDeal({
        crmDealId: 'deal_orch_tax_forward_99',
        injectedHubSpotClient: mockHs,
        injectedZohoClient: mockZoho
      });

      assert.equal(res.status, 'SYNCED');
      assert.ok(res.zohoSalesOrderId);
      assert.ok(res.zohoInvoiceId);

      // Verify payload forwarded to Zoho POST /salesorders
      const soPost = mockZoho.calls.find((c) => c.method === 'POST' && c.path === '/salesorders');
      assert.ok(soPost, 'Must invoke POST /salesorders');
      assert.equal(soPost.body.currency_id, 'curr_orch_aed_id');
      assert.equal(soPost.body.line_items[0].tax_id, 'tax_orch_uae_vat_5');

      // Verify payload forwarded to Zoho POST /invoices
      const invPost = mockZoho.calls.find((c) => c.method === 'POST' && c.path === '/invoices');
      assert.ok(invPost, 'Must invoke POST /invoices');
      assert.equal(invPost.body.currency_id, 'curr_orch_aed_id');
      assert.equal(invPost.body.line_items[0].tax_id, 'tax_orch_uae_vat_5');
      assert.equal(invPost.body.line_items[0].tax_percentage, 5.0);

      // Verify persistence in MongoDB
      const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_orch_tax_forward_99' });
      assert.ok(syncDoc);
      assert.equal(syncDoc.salesOrderTotal, 126000.0);
      assert.equal(syncDoc.salesOrderTax, 6000.0);
      assert.equal(syncDoc.salesOrderSubtotal, 120000.0);

      const m1Doc = await MilestoneInvoice.findOne({ crmDealId: 'deal_orch_tax_forward_99', milestoneIndex: 1 });
      assert.ok(m1Doc);
      assert.equal(m1Doc.status, 'CREATED');
      assert.equal(m1Doc.totalAmount, 63000.0);
      assert.equal(m1Doc.taxAmount, 3000.0);
      assert.equal(m1Doc.subtotal, 60000.0);

      // Idempotency check: Re-process same deal does not create duplicate Sales Order or Invoice
      const soPostsBeforeRetry = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/salesorders').length;
      const invPostsBeforeRetry = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;

      const retryRes = await OrchestrationService.processClosedWonDeal({
        crmDealId: 'deal_orch_tax_forward_99',
        injectedHubSpotClient: mockHs,
        injectedZohoClient: mockZoho
      });
      assert.equal(retryRes.status, 'SYNCED');

      const soPostsAfterRetry = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/salesorders').length;
      const invPostsAfterRetry = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;

      assert.equal(soPostsAfterRetry, soPostsBeforeRetry, 'Zero extra Sales Order POSTs on retry');
      assert.equal(invPostsAfterRetry, invPostsBeforeRetry, 'Zero extra Invoice POSTs on retry');
    } finally {
      if (originalTaxId !== undefined) {
        process.env.ZOHO_UAE_VAT_TAX_ID = originalTaxId;
      } else {
        delete process.env.ZOHO_UAE_VAT_TAX_ID;
      }
      if (originalCurrencyId !== undefined) {
        process.env.ZOHO_AED_CURRENCY_ID = originalCurrencyId;
      } else {
        delete process.env.ZOHO_AED_CURRENCY_ID;
      }
    }
  });

  // 21. End-to-End Orchestration with 0% VAT (NovaTech Approved Test Scenario)
  await t.test('Scenario 21: End-to-end orchestration with explicit taxPercentage = 0 (0% VAT NovaTech)', async () => {
    const originalTaxId = process.env.ZOHO_UAE_VAT_TAX_ID;
    const originalVatPercentage = process.env.VAT_PERCENTAGE;
    try {
      process.env.ZOHO_UAE_VAT_TAX_ID = 'tax_uae_vat_configured';
      delete process.env.VAT_PERCENTAGE;

      const mockZoho = createMockZohoClient({ taxPercentage: 0 });
      const mockHs = createMockHubSpotClient({ dealAmount: 120000.0 });

      const res = await OrchestrationService.processClosedWonDeal({
        crmDealId: '360608312029',
        taxPercentage: 0,
        injectedHubSpotClient: mockHs,
        injectedZohoClient: mockZoho
      });

      assert.equal(res.status, 'SYNCED');
      assert.ok(res.zohoSalesOrderId);
      assert.ok(res.zohoInvoiceId);

      // Verify Sales Order payload
      const soPost = mockZoho.calls.find((c) => c.method === 'POST' && c.path === '/salesorders');
      assert.ok(soPost);
      assert.equal(soPost.body.line_items[0].rate, 120000.0);
      assert.equal(soPost.body.line_items[0].tax_id, undefined, 'SO line item has no tax_id when taxPercentage is 0');
      assert.match(soPost.body.notes, /VAT \(0%\): AED 0\.00/);

      // Verify M1 Invoice payload
      const invPost = mockZoho.calls.find((c) => c.method === 'POST' && c.path === '/invoices');
      assert.ok(invPost);
      assert.equal(invPost.body.line_items[0].rate, 60000.0);
      assert.equal(invPost.body.line_items[0].tax_id, undefined, 'Invoice line item has no tax_id when taxPercentage is 0');
      assert.equal(invPost.body.line_items[0].tax_percentage, undefined, 'Invoice line item has no tax_percentage when taxPercentage is 0');
      assert.match(invPost.body.notes, /VAT \(0%\): AED 0\.00/);

      // Verify MongoDB documents
      const syncDoc = await IntegrationSync.findOne({ crmDealId: '360608312029' });
      assert.ok(syncDoc);
      assert.equal(syncDoc.salesOrderSubtotal, 120000.0);
      assert.equal(syncDoc.salesOrderTax, 0.0);
      assert.equal(syncDoc.salesOrderTotal, 120000.0);
      assert.equal(syncDoc.syncStatus, 'SYNCED');

      const m1Doc = await MilestoneInvoice.findOne({ crmDealId: '360608312029', milestoneIndex: 1 });
      assert.ok(m1Doc);
      assert.equal(m1Doc.subtotal, 60000.0);
      assert.equal(m1Doc.taxAmount, 0.0);
      assert.equal(m1Doc.totalAmount, 60000.0);
      assert.equal(m1Doc.status, 'CREATED');

      // Verify HubSpot deal property updates
      const hsPatch = mockHs.calls.find((c) => c.method === 'PATCH');
      assert.ok(hsPatch);
      assert.equal(hsPatch.properties.zoho_sales_order_total, 120000.0);
      assert.equal(hsPatch.properties.zoho_total_invoiced_amount, 60000.0);
      assert.equal(hsPatch.properties.zoho_percentage_invoiced, 50.0);
      assert.equal(hsPatch.properties.zoho_amount_not_invoiced, 60000.0);
    } finally {
      if (originalTaxId !== undefined) {
        process.env.ZOHO_UAE_VAT_TAX_ID = originalTaxId;
      } else {
        delete process.env.ZOHO_UAE_VAT_TAX_ID;
      }
      if (originalVatPercentage !== undefined) {
        process.env.VAT_PERCENTAGE = originalVatPercentage;
      } else {
        delete process.env.VAT_PERCENTAGE;
      }
    }
  });

  // 22. End-to-End Orchestration via process.env.VAT_PERCENTAGE = '0'
  await t.test('Scenario 22: End-to-end orchestration picks up VAT_PERCENTAGE=0 from environment', async () => {
    const originalVatPercentage = process.env.VAT_PERCENTAGE;
    try {
      process.env.VAT_PERCENTAGE = '0';

      const mockZoho = createMockZohoClient({ taxPercentage: 0 });
      const mockHs = createMockHubSpotClient({ dealAmount: 120000.0 });

      // Call without explicit taxPercentage - should pick up process.env.VAT_PERCENTAGE
      const res = await OrchestrationService.processClosedWonDeal({
        crmDealId: 'deal_env_zero_vat_01',
        injectedHubSpotClient: mockHs,
        injectedZohoClient: mockZoho
      });

      assert.equal(res.status, 'SYNCED');
      const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_env_zero_vat_01' });
      assert.equal(syncDoc.salesOrderTotal, 120000.0);
      assert.equal(syncDoc.salesOrderTax, 0.0);
      assert.equal(syncDoc.salesOrderSubtotal, 120000.0);

      const m1Doc = await MilestoneInvoice.findOne({ crmDealId: 'deal_env_zero_vat_01', milestoneIndex: 1 });
      assert.equal(m1Doc.totalAmount, 60000.0);
      assert.equal(m1Doc.taxAmount, 0.0);
      assert.equal(m1Doc.subtotal, 60000.0);
    } finally {
      if (originalVatPercentage !== undefined) {
        process.env.VAT_PERCENTAGE = originalVatPercentage;
      } else {
        delete process.env.VAT_PERCENTAGE;
      }
    }
  });
});
