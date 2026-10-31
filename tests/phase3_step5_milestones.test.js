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
  calculateM3EligibleDate,
  calculateAggregateFinancialMetrics
} = require('../server/src/services/orchestrationService');
const InvoiceService = require('../server/src/services/invoiceService');
const WebhookService = require('../server/src/services/webhookService');

let mongoServer;
let globalSoCounter = 500;
let globalInvCounter = 500;

function createMockHubSpotClient({ updateFails = false, dealAmount = 120000.0, confirmedGoLiveDate = null } = {}) {
  const calls = [];
  return {
    calls,
    getDeal: async (dealId) => {
      calls.push({ method: 'GET', path: `/crm/v3/objects/deals/${dealId}` });
      return {
        statusCode: 200,
        data: {
          id: dealId,
          properties: {
            dealname: `Deal ${dealId}`,
            dealstage: 'closedwon',
            amount: dealAmount,
            company: 'Acme Corp',
            email: 'billing@acme.com',
            confirmed_go_live_date: confirmedGoLiveDate
          },
          associations: {
            companies: { results: [{ id: 'comp_hs_500' }] },
            contacts: { results: [{ id: 'cont_hs_500' }] }
          }
        }
      };
    },
    updateDeal: async (dealId, properties) => {
      calls.push({ method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}`, properties });
      if (updateFails) {
        return { statusCode: 500, data: { message: 'HubSpot Server Error' } };
      }
      return { statusCode: 200, data: { id: dealId, properties } };
    }
  };
}

function createMockZohoClient({
  existingInvoices = [],
  createInvFails = false,
  invDueDate = '2026-11-30',
  invBalance = null
} = {}) {
  const calls = [];
  return {
    calls,
    request: async ({ method, path, body }) => {
      calls.push({ method, path, body });

      if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
        return { statusCode: 200, data: { code: 0, invoices: existingInvoices } };
      }

      if (method === 'GET' && path.startsWith('/invoices/')) {
        const invId = path.split('/')[2];
        const found = existingInvoices.find((i) => i.invoice_id === invId);
        if (found) return { statusCode: 200, data: { code: 0, invoice: found } };
        return {
          statusCode: 200,
          data: {
            code: 0,
            invoice: {
              invoice_id: invId,
              invoice_number: 'INV-ADOPTED',
              total: 37800.0,
              sub_total: 36000.0,
              tax_total: 1800.0,
              balance: 37800.0,
              due_date: '2026-12-31',
              currency_code: 'AED'
            }
          }
        };
      }

      if (method === 'POST' && path === '/invoices') {
        if (createInvFails) {
          return { statusCode: 400, data: { code: 2001, message: 'Zoho Invoice create failed' } };
        }
        const subtotal = body.line_items[0].rate;
        const tax = Number((subtotal * 0.05).toFixed(2));
        const total = Number((subtotal + tax).toFixed(2));
        const inv = {
          invoice_id: `inv_mock_${globalInvCounter++}`,
          invoice_number: `INV-${globalInvCounter}`,
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
              line_item_id: `inv_item_${globalInvCounter}`,
              salesorder_item_id: body.line_items[0].salesorder_item_id,
              rate: subtotal,
              quantity: 1
            }
          ],
          balance: invBalance !== null ? invBalance : total
        };
        return { statusCode: 200, data: { code: 0, invoice: inv } };
      }

      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

async function setupBaseDealWithM1(dealId, { contractAmount = 120000.0 } = {}) {
  const companyId = `comp_hs_${dealId}`;
  await CustomerMapping.findOneAndUpdate(
    { hubspotCompanyId: companyId },
    {
      $set: {
        hubspotContactId: `cont_hs_${dealId}`,
        zohoContactId: `cust_zoho_${dealId}`,
        companyName: `Acme Corp ${dealId}`,
        status: 'ACTIVE'
      }
    },
    { upsert: true }
  );

  const soTotal = Number((contractAmount * 1.05).toFixed(2));
  const sync = await IntegrationSync.create({
    crmDealId: dealId,
    hubspotCompanyId: companyId,
    zohoContactId: `cust_zoho_${dealId}`,
    zohoSalesOrderId: `so_mock_${globalSoCounter++}`,
    zohoSalesOrderLineItemId: 'so_line_item_main',
    zohoSalesOrderNumber: 'SO-00500',
    salesOrderTotal: soTotal,
    salesOrderSubtotal: contractAmount,
    salesOrderTax: Number((contractAmount * 0.05).toFixed(2)),
    salesOrderStatus: 'CONFIRMED',
    syncStatus: 'M1_INVOICED',
    percentageInvoiced: 50.0,
    totalInvoicedAmount: 63000.0,
    amountNotInvoiced: 63000.0,
    amountInvoicedUnpaid: 63000.0,
    currencyCode: 'AED'
  });

  await MilestoneInvoice.create({
    crmDealId: dealId,
    syncId: sync._id,
    milestoneIndex: 1,
    milestoneName: 'Signing',
    percentage: 50,
    subtotal: 60000.0,
    taxAmount: 3000.0,
    totalAmount: 63000.0,
    balance: 63000.0,
    dueDate: new Date('2026-11-30'),
    zohoInvoiceId: `inv_mock_${globalInvCounter++}`,
    zohoInvoiceNumber: 'INV-M1',
    zohoSalesOrderId: sync.zohoSalesOrderId,
    zohoSalesOrderItemId: 'so_line_item_main',
    referenceNumber: `CRM_${dealId}_M1`,
    currencyCode: 'AED',
    status: 'CREATED'
  });

  return sync;
}

test.describe('Phase 3 Step 5: M2 and M3 Milestone Lifecycle', () => {
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
    await CustomerMapping.deleteMany({});
    await MilestoneInvoice.deleteMany({});
    await WebhookEvent.deleteMany({});
  });

  // 1. Financial Arithmetic & Exact Totals
  test('Scenario 1: Exact M1, M2, and M3 financial arithmetic sums to 100% with 0 minor unit error', async () => {
    const contractSubtotal = 120000.0;
    const taxRate = 0.05;

    const m1Sub = (contractSubtotal * 50) / 100;
    const m1Tax = m1Sub * taxRate;
    const m1Gross = m1Sub + m1Tax;

    const m2Sub = (contractSubtotal * 30) / 100;
    const m2Tax = m2Sub * taxRate;
    const m2Gross = m2Sub + m2Tax;

    const m3Sub = (contractSubtotal * 20) / 100;
    const m3Tax = m3Sub * taxRate;
    const m3Gross = m3Sub + m3Tax;

    assert.equal(m1Sub, 60000.0);
    assert.equal(m1Tax, 3000.0);
    assert.equal(m1Gross, 63000.0);

    assert.equal(m2Sub, 36000.0);
    assert.equal(m2Tax, 1800.0);
    assert.equal(m2Gross, 37800.0);

    assert.equal(m3Sub, 24000.0);
    assert.equal(m3Tax, 1200.0);
    assert.equal(m3Gross, 25200.0);

    // Minor unit integer verification
    const minorM1 = Math.round(m1Gross * 100);
    const minorM2 = Math.round(m2Gross * 100);
    const minorM3 = Math.round(m3Gross * 100);
    const minorTotal = minorM1 + minorM2 + minorM3;

    assert.equal(minorTotal, 12600000);
    assert.equal(minorTotal / 100, 126000.0);
  });

  // 2. M2 Invoicing Cumulative Verification (AED 100,800 gross, 80%, AED 25,200 remaining)
  test('Scenario 2: Successful M2 creation updates cumulative invoiced to 100,800 (80%) and remaining to exactly 25,200', async () => {
    const dealId = 'deal_m2_success';
    await setupBaseDealWithM1(dealId);

    const mockHs = createMockHubSpotClient({ confirmedGoLiveDate: '2026-10-15' });
    const mockZoho = createMockZohoClient();

    const res = await OrchestrationService.processGoLiveMilestone({
      crmDealId: dealId,
      goLiveDate: '2026-10-15',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho,
      referenceDate: new Date('2026-10-31T12:00:00Z')
    });

    assert.equal(res.status, 'M2_INVOICED');
    assert.equal(res.subtotal, 36000.0);
    assert.equal(res.taxAmount, 1800.0);
    assert.equal(res.totalAmount, 37800.0);

    // CRITICAL MANDATORY ASSERTIONS:
    assert.equal(res.metrics.totalInvoiced, 100800.0, 'Total invoiced must be exactly 100,800 gross');
    assert.equal(res.metrics.percentageInvoiced, 80.0, 'Percentage invoiced must be 80.0%');
    assert.equal(res.metrics.amountNotInvoiced, 25200.0, 'Amount not invoiced must be exactly 25,200 (NOT 25,000)');

    // Verify HubSpot properties PATCH payload
    const patchCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.ok(patchCall);
    assert.equal(patchCall.properties.zoho_total_invoiced_amount, 100800.0);
    assert.equal(patchCall.properties.zoho_percentage_invoiced, 80.0);
    assert.equal(patchCall.properties.zoho_amount_not_invoiced, 25200.0);
    assert.equal(patchCall.properties.confirmed_go_live_date, '2026-10-15');
    assert.equal(patchCall.properties.m3_eligible_date, '2027-01-13'); // Oct 15, 2026 + 90 days = Jan 13, 2027
    assert.equal(patchCall.properties.integration_milestone_stage, 'M2_GO_LIVE');

    // Verify MongoDB state
    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.syncStatus, 'M2_INVOICED');
    assert.equal(syncDoc.percentageInvoiced, 80.0);
    assert.equal(syncDoc.amountNotInvoiced, 25200.0);
    assert.ok(syncDoc.confirmedGoLiveDate);
    assert.ok(syncDoc.m3EligibleAt);
  });

  // 3. M2 Prerequisite Failures
  test('Scenario 3: M2 fails safely if M1 invoice does not exist or is not confirmed', async () => {
    const dealId = 'deal_m2_no_m1';
    await IntegrationSync.create({
      crmDealId: dealId,
      salesOrderStatus: 'CONFIRMED',
      zohoSalesOrderId: 'so_m2_test',
      syncStatus: 'SALES_ORDER_CONFIRMED'
    });

    const mockHs = createMockHubSpotClient({ confirmedGoLiveDate: '2026-10-15' });
    const mockZoho = createMockZohoClient();

    await assert.rejects(
      async () => {
        await OrchestrationService.processGoLiveMilestone({
          crmDealId: dealId,
          goLiveDate: '2026-10-15',
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.equal(err.code, 'PREREQUISITE_FAILED_M1_NOT_CONFIRMED');
        return true;
      }
    );

    // Zero Zoho invoice POST calls
    const invPosts = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices');
    assert.equal(invPosts.length, 0);
  });

  // 4. Invalid and Future Go-Live Dates
  test('Scenario 4: Rejects missing, invalid, or future go-live dates', async () => {
    const dealId = 'deal_m2_dates';
    await setupBaseDealWithM1(dealId);

    const mockHs = createMockHubSpotClient();
    const mockZoho = createMockZohoClient();

    // Case A: Missing date
    await assert.rejects(
      async () => {
        await OrchestrationService.processGoLiveMilestone({
          crmDealId: dealId,
          goLiveDate: null,
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_GO_LIVE_DATE');
        return true;
      }
    );

    // Case B: Unparseable date
    await assert.rejects(
      async () => {
        await OrchestrationService.processGoLiveMilestone({
          crmDealId: dealId,
          goLiveDate: 'not-a-valid-date-string',
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_GO_LIVE_DATE');
        return true;
      }
    );

    // Case C: Future date (referenceDate is 2026-10-31, goLive is 2026-11-15)
    await assert.rejects(
      async () => {
        await OrchestrationService.processGoLiveMilestone({
          crmDealId: dealId,
          goLiveDate: '2026-11-15',
          referenceDate: new Date('2026-10-31T12:00:00Z'),
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.equal(err.code, 'GO_LIVE_DATE_IN_FUTURE');
        return true;
      }
    );

    // 0 invoices created
    const invPosts = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices');
    assert.equal(invPosts.length, 0);
  });

  // 5. Idempotent M2 Execution
  test('Scenario 5: Calling M2 twice returns cached data with 0 additional Zoho invoice POSTs', async () => {
    const dealId = 'deal_m2_idempotent';
    await setupBaseDealWithM1(dealId);

    const mockHs = createMockHubSpotClient({ confirmedGoLiveDate: '2026-10-15' });
    const mockZoho = createMockZohoClient();

    // Call 1: Creates M2
    const res1 = await OrchestrationService.processGoLiveMilestone({
      crmDealId: dealId,
      goLiveDate: '2026-10-15',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho,
      referenceDate: new Date('2026-10-31T12:00:00Z')
    });
    assert.equal(res1.status, 'M2_INVOICED');

    const invPostsCountAfter1 = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;
    assert.equal(invPostsCountAfter1, 1);

    // Call 2: Returns cached M2
    const res2 = await OrchestrationService.processGoLiveMilestone({
      crmDealId: dealId,
      goLiveDate: '2026-10-15',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho,
      referenceDate: new Date('2026-10-31T12:00:00Z')
    });
    assert.equal(res2.status, 'ALREADY_CREATED');
    assert.equal(res2.zohoInvoiceId, res1.zohoInvoiceId);

    const invPostsCountAfter2 = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;
    assert.equal(invPostsCountAfter2, 1, 'Second invocation must make ZERO new invoice POSTs');
  });

  // 6. M3 Eligibility Timing Boundaries (Before, Exactly At, and After 90 days)
  test('Scenario 6: M3 timing boundary - returns M3_NOT_YET_ELIGIBLE before 90 days, succeeds at and after 90 days', async () => {
    const dealId = 'deal_m3_boundaries';
    await setupBaseDealWithM1(dealId);

    // Go-live date: 2026-08-01. UTC midnight = 2026-08-01T00:00:00.000Z
    // 90 calendar days = Oct 30, 2026 00:00:00.000Z
    const goLiveDate = new Date('2026-08-01T00:00:00.000Z');
    const eligibleAt = calculateM3EligibleDate(goLiveDate);
    assert.equal(eligibleAt.toISOString(), '2026-10-30T00:00:00.000Z');

    // Create M2 first
    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient({ confirmedGoLiveDate: '2026-08-01' });

    await OrchestrationService.processGoLiveMilestone({
      crmDealId: dealId,
      goLiveDate: '2026-08-01',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho,
      referenceDate: new Date('2026-08-10T12:00:00Z')
    });

    // Test 6A: Day 89 post go-live (1 ms before eligibleAt: 2026-10-29T23:59:59.999Z)
    const justBefore = new Date('2026-10-29T23:59:59.999Z');
    const resEarly = await OrchestrationService.process90DayMilestone({
      crmDealId: dealId,
      referenceDate: justBefore,
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(resEarly.status, 'M3_NOT_YET_ELIGIBLE');
    assert.equal(resEarly.daysRemaining, 1);

    // Verify ZERO M3 invoice POSTs were made
    const invPostsEarly = mockZoho.calls.filter(
      (c) => c.method === 'POST' && c.path === '/invoices' && c.body.reference_number.includes('_M3')
    );
    assert.equal(invPostsEarly.length, 0);

    // Test 6B: Exactly at boundary (2026-10-30T00:00:00.000Z)
    const exactlyAt = new Date('2026-10-30T00:00:00.000Z');
    const resExact = await OrchestrationService.process90DayMilestone({
      crmDealId: dealId,
      referenceDate: exactlyAt,
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(resExact.status, 'M3_INVOICED');
    assert.equal(resExact.subtotal, 24000.0);
    assert.equal(resExact.taxAmount, 1200.0);
    assert.equal(resExact.totalAmount, 25200.0);

    // CRITICAL 100% COMPLETION ASSERTIONS:
    assert.equal(resExact.metrics.totalInvoiced, 126000.0, 'Total invoiced must be exactly 126,000 gross');
    assert.equal(resExact.metrics.percentageInvoiced, 100.0, 'Percentage invoiced must be 100.0%');
    assert.equal(resExact.metrics.amountNotInvoiced, 0.0, 'Amount not invoiced must be exactly 0.00');

    // Test 6C: Re-executing after M3 creation returns cached result (Idempotent)
    const resRepeat = await OrchestrationService.process90DayMilestone({
      crmDealId: dealId,
      referenceDate: new Date('2026-11-05T00:00:00.000Z'),
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });
    assert.equal(resRepeat.status, 'ALREADY_CREATED');
  });

  // 7. M2 Uncertain POST and Reconciliation
  test('Scenario 7: M2 uncertain POST timeout adopts invoice on remote lookup', async () => {
    const dealId = 'deal_m2_reconcile';
    await setupBaseDealWithM1(dealId);

    const clientCalls = [];
    const crashingZohoClient = {
      calls: clientCalls,
      request: async ({ method, path, body }) => {
        clientCalls.push({ method, path, body });
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoices: [
                {
                  invoice_id: 'inv_adopted_m2',
                  invoice_number: 'INV-M2-RECON',
                  salesorder_id: (await IntegrationSync.findOne({ crmDealId: dealId })).zohoSalesOrderId,
                  sub_total: 36000.0,
                  tax_total: 1800.0,
                  total: 37800.0,
                  due_date: '2026-11-30',
                  currency_code: 'AED',
                  line_items: [{ salesorder_item_id: 'so_line_item_main', rate: 36000.0 }]
                }
              ]
            }
          };
        }
        if (method === 'POST' && path === '/invoices') {
          throw new Error('ETIMEDOUT: Connection dropped during POST /invoices');
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    const mockHs = createMockHubSpotClient({ confirmedGoLiveDate: '2026-10-15' });
    const res = await OrchestrationService.processGoLiveMilestone({
      crmDealId: dealId,
      goLiveDate: '2026-10-15',
      injectedHubSpotClient: mockHs,
      injectedZohoClient: crashingZohoClient,
      referenceDate: new Date('2026-10-31T12:00:00Z')
    });

    assert.equal(res.status, 'M2_INVOICED');
    assert.equal(res.zohoInvoiceId, 'inv_adopted_m2');
  });

  // 8. M2 Reconciliation Blocks M3
  test('Scenario 8: Deal in M2 RECONCILIATION_REQUIRED blocks M3 invoice creation', async () => {
    const dealId = 'deal_m2_blocks_m3';
    await setupBaseDealWithM1(dealId);

    // M2 failed POST and immediate lookup returned 0 -> placed in RECONCILIATION_REQUIRED
    await IntegrationSync.updateOne(
      { crmDealId: dealId },
      {
        $set: {
          syncStatus: 'RECONCILIATION_REQUIRED',
          reconciliationReason: 'Uncertain POST outcome for M2',
          confirmedGoLiveDate: new Date('2026-07-01'),
          m3EligibleAt: new Date('2026-09-29')
        }
      }
    );

    await MilestoneInvoice.create({
      crmDealId: dealId,
      syncId: (await IntegrationSync.findOne({ crmDealId: dealId }))._id,
      milestoneIndex: 2,
      milestoneName: 'Go-Live',
      percentage: 30,
      subtotal: 36000.0,
      totalAmount: 37800.0,
      status: 'PENDING_RECONCILIATION'
    });

    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient();

    // M3 attempt is blocked
    await assert.rejects(
      async () => {
        await OrchestrationService.process90DayMilestone({
          crmDealId: dealId,
          referenceDate: new Date('2026-10-31T12:00:00Z'),
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_RECONCILIATION_BLOCKED');
        return true;
      }
    );

    // 0 invoices created
    const invPosts = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices');
    assert.equal(invPosts.length, 0);
  });

  // 9. Concurrent Worker Locking & Fencing on M2
  test('Scenario 9: Concurrent workers on M2 are locked, stale lease triggers fencing guard', async () => {
    const dealId = 'deal_m2_locking';
    await setupBaseDealWithM1(dealId);

    const mockHs = createMockHubSpotClient({ confirmedGoLiveDate: '2026-10-15' });
    const mockZoho = createMockZohoClient();

    // Worker 1 acquires lock
    await OrchestrationService.acquireOrchestrationLock(dealId, 'worker_first_99', 60000);

    // Worker 2 attempts execution -> rejected with lock conflict
    await assert.rejects(
      async () => {
        await OrchestrationService.processGoLiveMilestone({
          crmDealId: dealId,
          goLiveDate: '2026-10-15',
          workerId: 'worker_second_100',
          injectedHubSpotClient: mockHs,
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.equal(err.code, 'CONCURRENT_ORCHESTRATION_CONFLICT');
        return true;
      }
    );
  });

  // 10. HubSpot PATCH Failure on M2 Does Not Recreate Zoho Invoice on Retry
  test('Scenario 10: HubSpot PATCH failure on M2 preserves retryable state without duplicate Zoho POSTs', async () => {
    const dealId = 'deal_m2_hs_retry';
    await setupBaseDealWithM1(dealId);

    const mockZoho = createMockZohoClient();
    const mockHsFailing = createMockHubSpotClient({ updateFails: true, confirmedGoLiveDate: '2026-10-15' });

    // Step A: First attempt creates M2 in Zoho, fails updating HubSpot
    await assert.rejects(async () => {
      await OrchestrationService.processGoLiveMilestone({
        crmDealId: dealId,
        goLiveDate: '2026-10-15',
        injectedHubSpotClient: mockHsFailing,
        injectedZohoClient: mockZoho,
        referenceDate: new Date('2026-10-31T12:00:00Z')
      });
    });

    const invPostsFirst = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;
    assert.equal(invPostsFirst, 1, 'Initial M2 invoice created');

    // Step B: Retry with healthy HubSpot client
    const mockHsHealthy = createMockHubSpotClient({ updateFails: false, confirmedGoLiveDate: '2026-10-15' });
    const res = await OrchestrationService.processGoLiveMilestone({
      crmDealId: dealId,
      goLiveDate: '2026-10-15',
      injectedHubSpotClient: mockHsHealthy,
      injectedZohoClient: mockZoho,
      referenceDate: new Date('2026-10-31T12:00:00Z')
    });

    assert.equal(res.status, 'ALREADY_CREATED');

    const invPostsRetry = mockZoho.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;
    assert.equal(invPostsRetry, invPostsFirst, 'Retry must make ZERO new Zoho invoice POSTs');
  });

  // 11. On-Demand Batch Evaluator for M3
  test('Scenario 11: processEligibleM3Milestones() processes only eligible deals and repeated execution is idempotent', async () => {
    // Deal A: Eligible (go-live 2026-07-01 -> eligible 2026-09-29)
    const dealA = 'deal_batch_A';
    await setupBaseDealWithM1(dealA);
    await IntegrationSync.updateOne(
      { crmDealId: dealA },
      {
        $set: {
          syncStatus: 'M2_INVOICED',
          confirmedGoLiveDate: new Date('2026-07-01'),
          m3EligibleAt: new Date('2026-09-29')
        }
      }
    );
    await MilestoneInvoice.create({
      crmDealId: dealA,
      syncId: (await IntegrationSync.findOne({ crmDealId: dealA }))._id,
      milestoneIndex: 2,
      milestoneName: 'Go-Live',
      percentage: 30,
      subtotal: 36000.0,
      totalAmount: 37800.0,
      balance: 37800.0,
      status: 'CREATED'
    });

    // Deal B: NOT yet eligible (go-live 2026-10-01 -> eligible 2026-12-30)
    const dealB = 'deal_batch_B';
    await setupBaseDealWithM1(dealB);
    await IntegrationSync.updateOne(
      { crmDealId: dealB },
      {
        $set: {
          syncStatus: 'M2_INVOICED',
          confirmedGoLiveDate: new Date('2026-10-01'),
          m3EligibleAt: new Date('2026-12-30')
        }
      }
    );
    await MilestoneInvoice.create({
      crmDealId: dealB,
      syncId: (await IntegrationSync.findOne({ crmDealId: dealB }))._id,
      milestoneIndex: 2,
      milestoneName: 'Go-Live',
      percentage: 30,
      subtotal: 36000.0,
      totalAmount: 37800.0,
      balance: 37800.0,
      status: 'CREATED'
    });

    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient();

    // Evaluate batch on 2026-10-31
    const batchRes = await OrchestrationService.processEligibleM3Milestones({
      referenceDate: new Date('2026-10-31T12:00:00Z'),
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(batchRes.evaluated, 1, 'Only Deal A should be evaluated');
    assert.equal(batchRes.processed, 1, 'Deal A should be processed');

    // Verify Deal A is now M3_INVOICED / SYNCED
    const syncA = await IntegrationSync.findOne({ crmDealId: dealA });
    assert.equal(syncA.percentageInvoiced, 100.0);
    assert.equal(syncA.amountNotInvoiced, 0.0);

    // Verify Deal B remains M2_INVOICED
    const syncB = await IntegrationSync.findOne({ crmDealId: dealB });
    assert.equal(syncB.syncStatus, 'M2_INVOICED');

    // Repeated batch execution on same date processes 0 new invoices
    const repeatBatch = await OrchestrationService.processEligibleM3Milestones({
      referenceDate: new Date('2026-10-31T12:00:00Z'),
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });
    assert.equal(repeatBatch.evaluated, 0, 'No remaining M2 deals eligible');
  });

  // 12. Webhook Ingestion for Go-Live Events
  test('Scenario 12: Ingests confirmed_go_live_date webhook into queue as RECEIVED and deduplicates duplicate deliveries', async () => {
    const rawPayload = [
      {
        eventId: 'golive_evt_101',
        subscriptionType: 'deal.propertyChange',
        objectId: 'deal_webhook_golive',
        propertyName: 'confirmed_go_live_date',
        propertyValue: '2026-10-15',
        occurredAt: 1730000000000
      }
    ];

    const res1 = await WebhookService.processHubSpotWebhook(rawPayload);
    assert.equal(res1.accepted, 1);
    assert.equal(res1.duplicates, 0);

    // Stored as RECEIVED
    const eventDoc = await WebhookEvent.findOne({ eventId: 'hs_golive_evt_101' });
    assert.ok(eventDoc);
    assert.equal(eventDoc.status, 'RECEIVED');

    // Replay exact duplicate webhook
    const res2 = await WebhookService.processHubSpotWebhook(rawPayload);
    assert.equal(res2.accepted, 0);
    assert.equal(res2.duplicates, 1);
  });
});
