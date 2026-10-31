const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const IntegrationSync = require('../server/src/models/IntegrationSync');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const InvoiceService = require('../server/src/services/invoiceService');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  await IntegrationSync.init();
  await CustomerMapping.init();
  await MilestoneInvoice.init();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await IntegrationSync.deleteMany({});
  await CustomerMapping.deleteMany({});
  await MilestoneInvoice.deleteMany({});
});

/**
 * Creates a controllable mock Zoho Books client for Invoice tests.
 */
function createMockZohoInvoiceClient({
  existingInvoices = [],
  salesOrderDetails = null,
  createResponse = null,
  currencyCode = 'AED',
  postFails = false,
  postError = null
} = {}) {
  const calls = [];

  return {
    calls,
    request: async ({ method, path, body }) => {
      calls.push({ method, path, body });

      // GET /salesorders/:id
      if (method === 'GET' && path.startsWith('/salesorders/')) {
        if (salesOrderDetails) {
          return { statusCode: 200, data: { code: 0, salesorder: salesOrderDetails } };
        }
        return {
          statusCode: 200,
          data: {
            code: 0,
            salesorder: {
              salesorder_id: 'so_123',
              line_items: [
                { line_item_id: 'so_item_999', name: 'Software Contract', rate: 120000.0 }
              ]
            }
          }
        };
      }

      // GET /invoices?reference_number=...
      if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
        return {
          statusCode: 200,
          data: { code: 0, message: 'success', invoices: existingInvoices }
        };
      }

      // POST /invoices
      if (method === 'POST' && path === '/invoices') {
        if (postError) {
          throw postError;
        }
        if (postFails) {
          return {
            statusCode: 400,
            data: { code: 2001, message: 'Failed to create invoice in Zoho Books' }
          };
        }
        if (createResponse) {
          return createResponse;
        }

        const subtotal = body.line_items[0].rate;
        const tax = Number((subtotal * 0.05).toFixed(2));
        const total = Number((subtotal + tax).toFixed(2));

        const inv = {
          invoice_id: 'inv_m1_mock_101',
          invoice_number: 'INV-00010',
          reference_number: body.reference_number,
          customer_id: body.customer_id,
          salesorder_id: body.salesorder_id,
          sub_total: subtotal,
          tax_total: tax,
          total: total,
          balance: total,
          status: 'draft',
          line_items: [
            {
              line_item_id: 'inv_item_mock_01',
              salesorder_item_id: body?.line_items?.[0]?.salesorder_item_id || 'so_item_999',
              name: body?.line_items?.[0]?.name || 'Software Contract',
              rate: subtotal,
              quantity: 1
            }
          ]
        };

        if (currencyCode !== null) {
          inv.currency_code = currencyCode;
        }

        return {
          statusCode: 200,
          data: {
            code: 0,
            message: 'Invoice has been created.',
            invoice: inv
          }
        };
      }

      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

/**
 * Helper to seed a valid, confirmed Sales Order and active CustomerMapping
 */
async function seedValidPrerequisites({
  crmDealId = 'deal_test_standard',
  zohoContactId = 'cust_zoho_4001',
  zohoSalesOrderId = 'so_valid_123',
  zohoSalesOrderLineItemId = 'so_item_999',
  salesOrderSubtotal = 120000.0,
  salesOrderTax = 6000.0,
  salesOrderTotal = 126000.0,
  salesOrderStatus = 'CONFIRMED',
  currencyCode = 'AED',
  customerStatus = 'ACTIVE'
} = {}) {
  const mapping = await CustomerMapping.create({
    hubspotCompanyId: `comp_${crmDealId}`,
    zohoContactId,
    status: customerStatus,
    companyName: 'Acme UAE Technologies'
  });

  const sync = await IntegrationSync.create({
    crmDealId,
    dealName: 'Cloud Infrastructure Contract',
    zohoContactId,
    zohoSalesOrderId,
    zohoSalesOrderNumber: 'SO-0001',
    zohoSalesOrderLineItemId,
    salesOrderSubtotal,
    salesOrderTax,
    salesOrderTotal,
    salesOrderStatus,
    currencyCode,
    syncStatus: 'SALES_ORDER_CONFIRMED'
  });

  return { mapping, sync };
}

// ==============================================================================
// PHASE 3 STEP 3 AUTOMATED TEST SUITE: M1 INVOICE CREATION ONLY
// ==============================================================================
test.describe('Phase 3 Step 3: Zoho Books M1 Invoice Workflow', () => {
  // 1. Missing Customer Mapping
  test('Prerequisite 1: Rejects M1 creation if CustomerMapping is missing or not ACTIVE', async () => {
    await IntegrationSync.create({
      crmDealId: 'deal_missing_cust',
      zohoContactId: 'cust_unmapped_99',
      salesOrderStatus: 'CONFIRMED',
      zohoSalesOrderId: 'so_123',
      salesOrderSubtotal: 120000.0,
      salesOrderTotal: 126000.0,
      currencyCode: 'AED'
    });

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_missing_cust',
          injectedZohoClient: createMockZohoInvoiceClient()
        });
      },
      (err) => {
        assert.equal(err.code, 'PREREQUISITE_FAILED_CUSTOMER_NOT_ACTIVE');
        return true;
      }
    );
  });

  // 2. Unconfirmed Sales Order
  test('Prerequisite 2: Rejects M1 creation if Sales Order is not CONFIRMED', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_unconfirmed_so',
      salesOrderStatus: 'DRAFT'
    });

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_unconfirmed_so',
          injectedZohoClient: createMockZohoInvoiceClient()
        });
      },
      (err) => {
        assert.equal(err.code, 'PREREQUISITE_FAILED_SALES_ORDER_NOT_CONFIRMED');
        return true;
      }
    );
  });

  // 3. Incorrect Sales Order Customer
  test('Prerequisite 3: Rejects M1 creation if Sales Order customer does not match CustomerMapping', async () => {
    await CustomerMapping.create({
      hubspotCompanyId: 'comp_mismatch',
      zohoContactId: 'cust_mapping_A',
      status: 'ACTIVE'
    });

    await IntegrationSync.create({
      crmDealId: 'deal_customer_mismatch',
      zohoContactId: 'cust_sync_B', // Different customer!
      salesOrderStatus: 'CONFIRMED',
      zohoSalesOrderId: 'so_123',
      salesOrderSubtotal: 120000.0,
      salesOrderTotal: 126000.0,
      currencyCode: 'AED'
    });

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_customer_mismatch',
          hubspotCompanyId: 'comp_mismatch',
          injectedZohoClient: createMockZohoInvoiceClient()
        });
      },
      (err) => {
        assert.equal(err.code, 'PREREQUISITE_FAILED_CUSTOMER_MISMATCH');
        return true;
      }
    );
  });

  // 4. Incorrect Currency
  test('Prerequisite 4: Rejects M1 creation if Sales Order currency does not match AED', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_bad_currency',
      currencyCode: 'USD'
    });

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_bad_currency',
          currencyCode: 'AED',
          injectedZohoClient: createMockZohoInvoiceClient()
        });
      },
      (err) => {
        assert.equal(err.code, 'PREREQUISITE_FAILED_CURRENCY_MISMATCH');
        return true;
      }
    );
  });

  // 14. Non-Closed Won Deal Stage Rejected
  test('Prerequisite 5: Rejects M1 creation if deal stage is not Closed Won', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_not_closed' });

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_not_closed',
          dealStage: 'appointmentscheduled',
          injectedZohoClient: createMockZohoInvoiceClient()
        });
      },
      (err) => {
        assert.equal(err.code, 'PREREQUISITE_FAILED_DEAL_NOT_CLOSED_WON');
        return true;
      }
    );
  });

  // 5. Correct M1 Calculation
  test('Requirement 5: Correct M1 calculation (Subtotal 60,000, Tax 3,000, Gross 63,000 AED)', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_calc_test' });
    const mockClient = createMockZohoInvoiceClient();

    const res = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_calc_test',
      contractAmount: 120000.0,
      currencyCode: 'AED',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CREATED');
    assert.equal(res.subtotal, 60000.0);
    assert.equal(res.taxAmount, 3000.0);
    assert.equal(res.totalAmount, 63000.0);
    assert.equal(res.currencyCode, 'AED');
  });

  // 6. Correct Sales Order ID Linkage
  test('Requirement 6: Correct Sales Order ID linkage in invoice payload', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_so_link',
      zohoSalesOrderId: 'so_target_linked_777'
    });
    const mockClient = createMockZohoInvoiceClient();

    await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_so_link',
      injectedZohoClient: mockClient
    });

    const createCall = mockClient.calls.find((c) => c.method === 'POST' && c.path === '/invoices');
    assert.ok(createCall);
    assert.equal(createCall.body.salesorder_id, 'so_target_linked_777');
  });

  // 7. Correct Sales Order Line-Item Linkage
  test('Requirement 7: Correct Sales Order line-item linkage via salesorder_item_id', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_line_item_link',
      zohoSalesOrderLineItemId: 'so_item_line_456'
    });
    const mockClient = createMockZohoInvoiceClient();

    await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_line_item_link',
      injectedZohoClient: mockClient
    });

    const createCall = mockClient.calls.find((c) => c.method === 'POST' && c.path === '/invoices');
    assert.ok(createCall);
    assert.equal(createCall.body.line_items[0].salesorder_item_id, 'so_item_line_456');
    assert.equal(createCall.body.line_items[0].rate, 60000.0);
  });

  // 8. Duplicate M1 Request (Idempotency)
  test('Requirement 8: Duplicate M1 request returns cached data with 0 Zoho API calls', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_idempotent_m1' });
    const mockClient = createMockZohoInvoiceClient();

    // First call: creates M1 invoice
    const firstCall = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_idempotent_m1',
      injectedZohoClient: mockClient
    });
    assert.equal(firstCall.status, 'CREATED');
    const callsAfterFirst = mockClient.calls.length;

    // Second call: must return cached result
    const secondCall = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_idempotent_m1',
      injectedZohoClient: mockClient
    });

    assert.equal(secondCall.status, 'ALREADY_CREATED');
    assert.equal(secondCall.fromCache, true);
    assert.equal(secondCall.zohoInvoiceId, firstCall.zohoInvoiceId);
    assert.equal(mockClient.calls.length, callsAfterFirst, 'Zero additional API calls made');
  });

  // 9. Uncertain Remote Invoice POST and Reconciliation
  test('Requirement 9: Uncertain remote invoice POST (timeout) reconciled safely via deterministic reference', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_timeout_reconcile' });

    let postAttempted = false;
    const mockClient = {
      calls: [],
      request: async ({ method, path, body }) => {
        mockClient.calls.push({ method, path });

        // Pre-flight GET: 0 invoices
        if (method === 'GET' && path.startsWith('/invoices?reference_number=') && !postAttempted) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }

        // POST throws network timeout
        if (method === 'POST' && path === '/invoices') {
          postAttempted = true;
          throw new Error('ETIMEDOUT: Connection dropped during POST to Zoho Books');
        }

        // Reconciliation GET after POST: Zoho created the invoice!
        if (method === 'GET' && path.startsWith('/invoices?reference_number=') && postAttempted) {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoices: [
                {
                  invoice_id: 'inv_reconciled_after_drop',
                  invoice_number: 'INV-REC-001',
                  reference_number: 'CRM_deal_timeout_reconcile_M1',
                  salesorder_id: 'so_valid_123',
                  line_items: [
                    {
                      line_item_id: 'inv_item_mock_01',
                      salesorder_item_id: 'so_item_999',
                      rate: 60000.0,
                      quantity: 1
                    }
                  ],
                  sub_total: 60000.0,
                  tax_total: 3000.0,
                  total: 63000.0,
                  balance: 63000.0,
                  currency_code: 'AED'
                }
              ]
            }
          };
        }

        return { statusCode: 200, data: { code: 0 } };
      }
    };

    const res = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_timeout_reconcile',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CREATED');
    assert.equal(res.zohoInvoiceId, 'inv_reconciled_after_drop');

    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_timeout_reconcile', milestoneIndex: 1 });
    assert.ok(mRecord);
    assert.equal(mRecord.zohoInvoiceId, 'inv_reconciled_after_drop');
  });

  // 9B. Prevention of a Second POST While Reconciliation is Unresolved
  test('Requirement 9B: Zero-result lookup after timeout transitions to RECONCILIATION_REQUIRED and blocks second POST', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_block_second_post' });

    let postCallsCount = 0;
    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        mockClient.calls.push({ method, path });

        // Pre-flight GET and post-error reconciliation GET always return 0 invoices
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }

        // POST /invoices throws network timeout
        if (method === 'POST' && path === '/invoices') {
          postCallsCount++;
          throw new Error('ETIMEDOUT: Connection dropped during POST');
        }

        return { statusCode: 200, data: { code: 0 } };
      }
    };

    // First call: times out, lookup returns 0 -> transitions to RECONCILIATION_REQUIRED
    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_block_second_post',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_RECONCILIATION_REQUIRED');
        return true;
      }
    );

    // Verify MongoDB state is durable RECONCILIATION_REQUIRED
    const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_block_second_post' });
    assert.equal(syncDoc.syncStatus, 'RECONCILIATION_REQUIRED');
    assert.match(syncDoc.reconciliationReason, /Uncertain POST outcome/);

    const mDoc = await MilestoneInvoice.findOne({ crmDealId: 'deal_block_second_post', milestoneIndex: 1 });
    assert.equal(mDoc.status, 'PENDING_RECONCILIATION');

    // Second call: must NOT issue another POST! Must reject with INVOICE_RECONCILIATION_BLOCKED
    const postCallsBefore = postCallsCount;
    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_block_second_post',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_RECONCILIATION_BLOCKED');
        return true;
      }
    );

    // Crucial assertion: ZERO new POST calls were made
    assert.equal(postCallsCount, postCallsBefore, 'Automated POST must be blocked while reconciliation is unresolved');
  });

  // 9C. Delayed Remote Invoice Creation Adopted After Initial Timeout
  test('Requirement 9C: Delayed remote invoice creation adopted cleanly on subsequent check', async () => {
    // Seed deal in RECONCILIATION_REQUIRED state (simulating earlier timeout)
    await seedValidPrerequisites({ crmDealId: 'deal_delayed_adopt' });
    await IntegrationSync.updateOne(
      { crmDealId: 'deal_delayed_adopt' },
      {
        $set: {
          syncStatus: 'RECONCILIATION_REQUIRED',
          reconciliationReason: 'Earlier POST timed out',
          reconciliationRequestedAt: new Date()
        }
      }
    );
    await MilestoneInvoice.create({
      crmDealId: 'deal_delayed_adopt',
      syncId: new mongoose.Types.ObjectId(),
      milestoneIndex: 1,
      milestoneName: 'Signing',
      percentage: 50,
      subtotal: 60000.0,
      totalAmount: 63000.0,
      status: 'PENDING_RECONCILIATION'
    });

    // Mock client: Zoho committed the invoice after the delay
    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        mockClient.calls.push({ method, path });
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoices: [
                {
                  invoice_id: 'inv_delayed_success_888',
                  invoice_number: 'INV-DELAY-001',
                  reference_number: 'CRM_deal_delayed_adopt_M1',
                  salesorder_id: 'so_valid_123',
                  line_items: [
                    {
                      line_item_id: 'inv_item_mock_01',
                      salesorder_item_id: 'so_item_999',
                      rate: 60000.0,
                      quantity: 1
                    }
                  ],
                  sub_total: 60000.0,
                  tax_total: 3000.0,
                  total: 63000.0,
                  balance: 63000.0,
                  currency_code: 'AED'
                }
              ]
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    // Subsequent call adopts the delayed invoice without sending POST
    const res = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_delayed_adopt',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CREATED');
    assert.equal(res.zohoInvoiceId, 'inv_delayed_success_888');

    // Verify reconciliation state is resolved and cleared in MongoDB
    const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_delayed_adopt' });
    assert.equal(syncDoc.syncStatus, 'M1_INVOICED');
    assert.equal(syncDoc.reconciliationReason, null);

    const mDoc = await MilestoneInvoice.findOne({ crmDealId: 'deal_delayed_adopt', milestoneIndex: 1 });
    assert.equal(mDoc.status, 'CREATED');
    assert.equal(mDoc.zohoInvoiceId, 'inv_delayed_success_888');

    // Verify 0 POST calls were made
    const postCalls = mockClient.calls.filter((c) => c.method === 'POST');
    assert.equal(postCalls.length, 0);
  });

  // 9D. Process Restart During Reconciliation
  test('Requirement 9D: Process restart preserves RECONCILIATION_REQUIRED and prevents duplicate POST', async () => {
    // Seed deal in RECONCILIATION_REQUIRED state
    await seedValidPrerequisites({ crmDealId: 'deal_process_restart' });
    await IntegrationSync.updateOne(
      { crmDealId: 'deal_process_restart' },
      {
        $set: {
          syncStatus: 'RECONCILIATION_REQUIRED',
          reconciliationReason: 'Server restarted while POST was pending',
          reconciliationRequestedAt: new Date()
        }
      }
    );

    // Mock client: Zoho lookup returns 0 invoices
    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        mockClient.calls.push({ method, path });
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST') {
          throw new Error('ILLEGAL POST: Must not send POST during unresolved reconciliation');
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    // Even after process restart, calling createMilestone1Invoice enforces reconciliation mode and blocks POST
    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_process_restart',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_RECONCILIATION_BLOCKED');
        return true;
      }
    );
  });

  // 9E. Safe Operator-Resolution Path
  test('Requirement 9E: Safe operator-resolution path clears reconciliation state and permits clean retry', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_operator_resolve' });
    await IntegrationSync.updateOne(
      { crmDealId: 'deal_operator_resolve' },
      {
        $set: {
          syncStatus: 'RECONCILIATION_REQUIRED',
          reconciliationReason: 'Operator inspection needed',
          reconciliationRequestedAt: new Date()
        }
      }
    );

    // Operator confirms no remote invoice exists in Zoho Books
    const resolveResult = await InvoiceService.resolveReconciliation({
      crmDealId: 'deal_operator_resolve',
      resolution: 'NO_REMOTE_INVOICE_CONFIRMED'
    });

    assert.equal(resolveResult.status, 'RECONCILIATION_CLEARED');

    // Verify status was reset to SALES_ORDER_CONFIRMED
    const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_operator_resolve' });
    assert.equal(syncDoc.syncStatus, 'SALES_ORDER_CONFIRMED');
    assert.equal(syncDoc.reconciliationReason, null);

    // Subsequent clean creation can now proceed
    const mockClient = createMockZohoInvoiceClient();
    const res = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_operator_resolve',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CREATED');
    assert.equal(res.zohoInvoiceId, 'inv_m1_mock_101');
  });

  // 10. Multiple Remote Invoice Matches Conflict
  test('Requirement 10: Stops and reports conflict if multiple matching invoices exist in Zoho', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_duplicate_remote' });

    const mockClient = createMockZohoInvoiceClient({
      existingInvoices: [
        { invoice_id: 'inv_dup_1', reference_number: 'CRM_deal_duplicate_remote_M1' },
        { invoice_id: 'inv_dup_2', reference_number: 'CRM_deal_duplicate_remote_M1' }
      ]
    });

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_duplicate_remote',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'DUPLICATE_REMOTE_INVOICES');
        return true;
      }
    );

    // Verify no POST was sent
    const postCalls = mockClient.calls.filter((c) => c.method === 'POST');
    assert.equal(postCalls.length, 0);
  });

  // 11. Failed Invoice Creation Leaves Error State Without Duplication
  test('Requirement 11: Failed invoice creation leaves error state without creating invalid Milestone record', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_fail_create' });
    const mockClient = createMockZohoInvoiceClient({ postFails: true });

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_fail_create',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'ZOHO_INVOICE_CREATE_FAILED');
        return true;
      }
    );

    // Verify MilestoneInvoice was not created
    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_fail_create', milestoneIndex: 1 });
    assert.equal(mRecord, null);

    // Verify IntegrationSync is marked FAILED
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_fail_create' });
    assert.equal(sync.syncStatus, 'FAILED');
  });

  // 12. Proof That M2 and M3 Are Not Created
  test('Requirement 12: Proof that ONLY M1 is created; M2 and M3 are never created on Closed Won', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_m1_only' });
    const mockClient = createMockZohoInvoiceClient();

    await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_m1_only',
      injectedZohoClient: mockClient
    });

    // Check MilestoneInvoice records
    const m1 = await MilestoneInvoice.findOne({ crmDealId: 'deal_m1_only', milestoneIndex: 1 });
    const m2 = await MilestoneInvoice.findOne({ crmDealId: 'deal_m1_only', milestoneIndex: 2 });
    const m3 = await MilestoneInvoice.findOne({ crmDealId: 'deal_m1_only', milestoneIndex: 3 });

    assert.ok(m1, 'M1 must exist');
    assert.equal(m2, null, 'M2 must NOT be created on Closed Won');
    assert.equal(m3, null, 'M3 must NOT be created on Closed Won');

    // Verify only 1 POST /invoices call occurred
    const postCalls = mockClient.calls.filter((c) => c.method === 'POST' && c.path === '/invoices');
    assert.equal(postCalls.length, 1);
  });

  // 13. Exact MongoDB Persistence and Status Transitions
  test('Requirement 13: Exact MongoDB persistence and status transitions verified', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_exact_persist' });
    const mockClient = createMockZohoInvoiceClient();

    const res = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_exact_persist',
      contractAmount: 120000.0,
      currencyCode: 'AED',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CREATED');

    // MilestoneInvoice assertion
    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_exact_persist', milestoneIndex: 1 });
    assert.ok(mRecord);
    assert.equal(mRecord.milestoneName, 'Signing');
    assert.equal(mRecord.percentage, 50);
    assert.equal(mRecord.subtotal, 60000.0);
    assert.equal(mRecord.taxAmount, 3000.0);
    assert.equal(mRecord.totalAmount, 63000.0);
    assert.equal(mRecord.balance, 63000.0);
    assert.equal(mRecord.status, 'CREATED');
    assert.equal(mRecord.zohoInvoiceId, 'inv_m1_mock_101');
    assert.equal(mRecord.zohoSalesOrderId, 'so_valid_123');
    assert.equal(mRecord.zohoSalesOrderItemId, 'so_item_999');

    // IntegrationSync financial tracking assertion
    const syncRecord = await IntegrationSync.findOne({ crmDealId: 'deal_exact_persist' });
    assert.ok(syncRecord);
    assert.equal(syncRecord.percentageInvoiced, 50);
    assert.equal(syncRecord.amountNotInvoiced, 63000.0); // 126,000 - 63,000
    assert.equal(syncRecord.amountInvoicedUnpaid, 63000.0);
    assert.equal(syncRecord.percentageCollected, 0);
    assert.equal(syncRecord.syncStatus, 'M1_INVOICED');
  });

  // 15. Off-by-one cent validation
  test('Requirement 15: Rejects returned invoice if totals are off by one cent', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_off_by_one' });

    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST' && path === '/invoices') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoice: {
                invoice_id: 'inv_off_one',
                salesorder_id: 'so_valid_123',
                line_items: [
                  {
                    line_item_id: 'inv_item_mock_01',
                    salesorder_item_id: 'so_item_999',
                    rate: 60000.0,
                    quantity: 1
                  }
                ],
                sub_total: 60000.0,
                tax_total: 3000.01, // Off by 1 cent!
                total: 63000.01,
                currency_code: 'AED'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_off_by_one',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_FINANCIAL_VALIDATION_FAILED');
        assert.match(err.message, /Invoice Financial Validation Failed/);
        return true;
      }
    );
  });

  // 16. Sales Order Linkage Validation
  test('Requirement 16: Rejects returned invoice if salesorder_id does not match confirmed Sales Order', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_so_mismatch',
      zohoSalesOrderId: 'so_expected_123'
    });

    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST' && path === '/invoices') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoice: {
                invoice_id: 'inv_wrong_so',
                salesorder_id: 'so_unexpected_999', // Mismatched Sales Order!
                sub_total: 60000.0,
                tax_total: 3000.0,
                total: 63000.0,
                currency_code: 'AED'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_so_mismatch',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_SALES_ORDER_MISMATCH');
        assert.match(err.message, /Sales Order Linkage Failed/);
        return true;
      }
    );

    // Verify MilestoneInvoice is NOT marked as CREATED, but FAILED_VALIDATION
    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_so_mismatch', milestoneIndex: 1 });
    assert.ok(mRecord);
    assert.equal(mRecord.status, 'FAILED_VALIDATION');
    assert.notEqual(mRecord.status, 'CREATED');

    // Verify IntegrationSync is NOT marked as M1_INVOICED, but FAILED
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_so_mismatch' });
    assert.ok(sync);
    assert.equal(sync.syncStatus, 'FAILED');
    assert.notEqual(sync.syncStatus, 'M1_INVOICED');
  });

  // 17. Missing returned salesorder_item_id
  test('Requirement 17: Rejects returned invoice if line items are missing salesorder_item_id', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_missing_so_item_id',
      zohoSalesOrderId: 'so_valid_123',
      zohoSalesOrderLineItemId: 'so_item_999'
    });

    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST' && path === '/invoices') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoice: {
                invoice_id: 'inv_missing_item_id',
                salesorder_id: 'so_valid_123',
                line_items: [
                  {
                    line_item_id: 'inv_item_01',
                    name: 'Software Contract - Milestone 1',
                    rate: 60000.0,
                    quantity: 1
                  }
                ],
                sub_total: 60000.0,
                tax_total: 3000.0,
                total: 63000.0,
                currency_code: 'AED'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_missing_so_item_id',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_MISSING_SALES_ORDER_ITEM_ID');
        assert.match(err.message, /Sales Order Line-Item Linkage Failed/);
        return true;
      }
    );

    // Verify MilestoneInvoice is NOT marked as CREATED, but FAILED_VALIDATION
    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_missing_so_item_id', milestoneIndex: 1 });
    assert.ok(mRecord);
    assert.equal(mRecord.status, 'FAILED_VALIDATION');
    assert.notEqual(mRecord.status, 'CREATED');
    assert.equal(mRecord.zohoInvoiceId, 'inv_missing_item_id');
    assert.match(mRecord.failureReason, /INVOICE_MISSING_SALES_ORDER_ITEM_ID|salesorder_item_id/);

    // Verify IntegrationSync is NOT marked as M1_INVOICED, but FAILED
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_missing_so_item_id' });
    assert.ok(sync);
    assert.equal(sync.syncStatus, 'FAILED');
    assert.notEqual(sync.syncStatus, 'M1_INVOICED');
    assert.equal(sync.percentageInvoiced, 0);
  });

  // 18. Mismatched returned salesorder_item_id
  test('Requirement 18: Rejects returned invoice if salesorder_item_id does not match expected SO line item', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_mismatched_so_item_id',
      zohoSalesOrderId: 'so_valid_123',
      zohoSalesOrderLineItemId: 'so_item_999'
    });

    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST' && path === '/invoices') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoice: {
                invoice_id: 'inv_mismatched_item_id',
                salesorder_id: 'so_valid_123',
                line_items: [
                  {
                    line_item_id: 'inv_item_01',
                    salesorder_item_id: 'so_item_DIFFERENT_888',
                    name: 'Software Contract - Milestone 1',
                    rate: 60000.0,
                    quantity: 1
                  }
                ],
                sub_total: 60000.0,
                tax_total: 3000.0,
                total: 63000.0,
                currency_code: 'AED'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_mismatched_so_item_id',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_SALES_ORDER_ITEM_MISMATCH');
        assert.match(err.message, /Sales Order Line-Item Linkage Failed/);
        return true;
      }
    );

    // Verify MilestoneInvoice is NOT marked as CREATED, but FAILED_VALIDATION
    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_mismatched_so_item_id', milestoneIndex: 1 });
    assert.ok(mRecord);
    assert.equal(mRecord.status, 'FAILED_VALIDATION');
    assert.notEqual(mRecord.status, 'CREATED');

    // Verify IntegrationSync is NOT marked as M1_INVOICED, but FAILED
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_mismatched_so_item_id' });
    assert.ok(sync);
    assert.equal(sync.syncStatus, 'FAILED');
    assert.notEqual(sync.syncStatus, 'M1_INVOICED');
    assert.equal(sync.percentageInvoiced, 0);
  });

  // 19. Mismatched returned line item rate / amount
  test('Requirement 19: Rejects returned invoice if line item rate does not match expected M1 amount', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_mismatched_line_amount',
      zohoSalesOrderId: 'so_valid_123',
      zohoSalesOrderLineItemId: 'so_item_999'
    });

    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST' && path === '/invoices') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoice: {
                invoice_id: 'inv_mismatched_amount',
                salesorder_id: 'so_valid_123',
                line_items: [
                  {
                    line_item_id: 'inv_item_01',
                    salesorder_item_id: 'so_item_999',
                    name: 'Software Contract - Milestone 1',
                    rate: 55000.0, // Expected 60,000.0
                    quantity: 1
                  }
                ],
                sub_total: 60000.0,
                tax_total: 3000.0,
                total: 63000.0,
                currency_code: 'AED'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_mismatched_line_amount',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_LINE_ITEM_AMOUNT_MISMATCH');
        assert.match(err.message, /Sales Order Line-Item Amount Failed/);
        return true;
      }
    );

    // Verify MilestoneInvoice is NOT marked as CREATED, but FAILED_VALIDATION
    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_mismatched_line_amount', milestoneIndex: 1 });
    assert.ok(mRecord);
    assert.equal(mRecord.status, 'FAILED_VALIDATION');
    assert.notEqual(mRecord.status, 'CREATED');

    // Verify IntegrationSync is NOT marked as M1_INVOICED, but FAILED
    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_mismatched_line_amount' });
    assert.ok(sync);
    assert.equal(sync.syncStatus, 'FAILED');
    assert.notEqual(sync.syncStatus, 'M1_INVOICED');
  });

  // 20. Missing returned salesorder_id
  test('Requirement 20: Rejects returned invoice if salesorder_id is missing entirely', async () => {
    await seedValidPrerequisites({
      crmDealId: 'deal_missing_so_id',
      zohoSalesOrderId: 'so_valid_123'
    });

    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST' && path === '/invoices') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoice: {
                invoice_id: 'inv_missing_so_id',
                // salesorder_id missing
                line_items: [
                  {
                    line_item_id: 'inv_item_01',
                    salesorder_item_id: 'so_item_999',
                    name: 'Software Contract - Milestone 1',
                    rate: 60000.0,
                    quantity: 1
                  }
                ],
                sub_total: 60000.0,
                tax_total: 3000.0,
                total: 63000.0,
                currency_code: 'AED'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_missing_so_id',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_MISSING_SALES_ORDER_ID');
        assert.match(err.message, /Sales Order Linkage Failed/);
        return true;
      }
    );

    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_missing_so_id', milestoneIndex: 1 });
    assert.ok(mRecord);
    assert.equal(mRecord.status, 'FAILED_VALIDATION');
    assert.notEqual(mRecord.status, 'CREATED');

    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_missing_so_id' });
    assert.ok(sync);
    assert.equal(sync.syncStatus, 'FAILED');
    assert.notEqual(sync.syncStatus, 'M1_INVOICED');
  });

  test('Rule 19: Forwarding configured ZOHO_UAE_VAT_TAX_ID and ZOHO_AED_CURRENCY_ID to Milestone Invoice', async () => {
    const originalTaxId = process.env.ZOHO_UAE_VAT_TAX_ID;
    const originalCurrencyId = process.env.ZOHO_AED_CURRENCY_ID;
    try {
      process.env.ZOHO_UAE_VAT_TAX_ID = 'tax_inv_uae_vat_5';
      process.env.ZOHO_AED_CURRENCY_ID = 'curr_inv_aed_id';

      await seedValidPrerequisites({ crmDealId: 'deal_tax_forward_inv' });
      const mockClient = createMockZohoInvoiceClient();

      const res = await InvoiceService.createMilestone1Invoice({
        crmDealId: 'deal_tax_forward_inv',
        injectedZohoClient: mockClient
      });

      assert.equal(res.status, 'CREATED');
      assert.equal(res.subtotal, 60000.0);
      assert.equal(res.taxAmount, 3000.0);
      assert.equal(res.totalAmount, 63000.0);

      // Verify payload forwarded to POST /invoices
      const postCall = mockClient.calls.find((c) => c.method === 'POST' && c.path === '/invoices');
      assert.ok(postCall, 'Must call POST /invoices');
      assert.equal(postCall.body.currency_id, 'curr_inv_aed_id');
      assert.equal(postCall.body.line_items[0].tax_id, 'tax_inv_uae_vat_5');
      assert.equal(postCall.body.line_items[0].tax_percentage, 5.0);
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

  test('Rule 20: Mathematical verification across M1 (50%), M2 (30%), and M3 (20%) milestone invoices', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_milestone_math_all' });

    // Helper mock invoice generator for custom milestone
    function createCustomMilestoneMockClient(expectedSubtotal, expectedTax, expectedGross, milestoneIndex) {
      return {
        calls: [],
        request: async ({ method, path, body }) => {
          if (method === 'GET' && path.startsWith('/salesorders/')) {
            return {
              statusCode: 200,
              data: {
                code: 0,
                salesorder: {
                  salesorder_id: 'so_valid_123',
                  line_items: [{ line_item_id: 'so_item_999', name: 'Software Contract', rate: 120000.0 }]
                }
              }
            };
          }
          if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
            return { statusCode: 200, data: { code: 0, invoices: [] } };
          }
          if (method === 'POST' && path === '/invoices') {
            return {
              statusCode: 200,
              data: {
                code: 0,
                invoice: {
                  invoice_id: `inv_m${milestoneIndex}_mock`,
                  invoice_number: `INV-M${milestoneIndex}-01`,
                  reference_number: body.reference_number,
                  salesorder_id: 'so_valid_123',
                  sub_total: expectedSubtotal,
                  tax_total: expectedTax,
                  total: expectedGross,
                  balance: expectedGross,
                  currency_code: 'AED',
                  line_items: [
                    {
                      line_item_id: `inv_item_m${milestoneIndex}`,
                      salesorder_item_id: 'so_item_999',
                      rate: expectedSubtotal,
                      quantity: 1
                    }
                  ]
                }
              }
            };
          }
          return { statusCode: 200, data: { code: 0 } };
        }
      };
    }

    // M1: 50% Signing (Subtotal: 60,000, VAT: 3,000, Gross: 63,000)
    const m1Res = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_milestone_math_all',
      injectedZohoClient: createCustomMilestoneMockClient(60000.0, 3000.0, 63000.0, 1)
    });
    assert.equal(m1Res.subtotal, 60000.0);
    assert.equal(m1Res.taxAmount, 3000.0);
    assert.equal(m1Res.totalAmount, 63000.0);

    // M2: 30% Go-Live (Subtotal: 36,000, VAT: 1,800, Gross: 37,800)
    const m2Res = await InvoiceService.createMilestone2Invoice({
      crmDealId: 'deal_milestone_math_all',
      injectedZohoClient: createCustomMilestoneMockClient(36000.0, 1800.0, 37800.0, 2)
    });
    assert.equal(m2Res.subtotal, 36000.0);
    assert.equal(m2Res.taxAmount, 1800.0);
    assert.equal(m2Res.totalAmount, 37800.0);

    // M3: 20% 90-Days (Subtotal: 24,000, VAT: 1,200, Gross: 25,200)
    const m3Res = await InvoiceService.createMilestone3Invoice({
      crmDealId: 'deal_milestone_math_all',
      injectedZohoClient: createCustomMilestoneMockClient(24000.0, 1200.0, 25200.0, 3)
    });
    assert.equal(m3Res.subtotal, 24000.0);
    assert.equal(m3Res.taxAmount, 1200.0);
    assert.equal(m3Res.totalAmount, 25200.0);

    // Check Cumulative Sums
    const totalSubtotal = m1Res.subtotal + m2Res.subtotal + m3Res.subtotal;
    const totalTax = m1Res.taxAmount + m2Res.taxAmount + m3Res.taxAmount;
    const totalGross = m1Res.totalAmount + m2Res.totalAmount + m3Res.totalAmount;

    assert.equal(totalSubtotal, 120000.0);
    assert.equal(totalTax, 6000.0);
    assert.equal(totalGross, 126000.0);
  });

  test('Rule 21: Incorrect Zoho-calculated invoice tax fails validation without saving as CREATED', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_wrong_tax_invoice' });

    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET' && path.startsWith('/salesorders/')) {
          return {
            statusCode: 200,
            data: {
              code: 0,
              salesorder: {
                salesorder_id: 'so_valid_123',
                line_items: [{ line_item_id: 'so_item_999', name: 'Software Contract', rate: 120000.0 }]
              }
            }
          };
        }
        if (method === 'GET' && path.startsWith('/invoices?reference_number=')) {
          return { statusCode: 200, data: { code: 0, invoices: [] } };
        }
        if (method === 'POST' && path === '/invoices') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              invoice: {
                invoice_id: 'inv_wrong_tax_001',
                salesorder_id: 'so_valid_123',
                sub_total: 60000.0,
                tax_total: 2500.0, // Incorrect tax (expected 3000.0)
                total: 62500.0,
                currency_code: 'AED',
                line_items: [
                  {
                    line_item_id: 'inv_item_bad_tax',
                    salesorder_item_id: 'so_item_999',
                    rate: 60000.0,
                    quantity: 1
                  }
                ]
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await InvoiceService.createMilestone1Invoice({
          crmDealId: 'deal_wrong_tax_invoice',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'INVOICE_FINANCIAL_VALIDATION_FAILED');
        assert.match(err.message, /Expected Subtotal=60000.00, Tax=3000.00, Gross=63000.00/);
        return true;
      }
    );

    const mRecord = await MilestoneInvoice.findOne({ crmDealId: 'deal_wrong_tax_invoice', milestoneIndex: 1 });
    assert.ok(mRecord);
    assert.equal(mRecord.status, 'FAILED_VALIDATION');
    assert.notEqual(mRecord.status, 'CREATED');

    const sync = await IntegrationSync.findOne({ crmDealId: 'deal_wrong_tax_invoice' });
    assert.ok(sync);
    assert.equal(sync.syncStatus, 'FAILED');
  });

  test('Rule 22: Idempotency after retry returns cached milestone invoice without duplicate POST', async () => {
    await seedValidPrerequisites({ crmDealId: 'deal_retry_m1_idempotent' });
    const mockClient = createMockZohoInvoiceClient();

    // First call creates
    const firstRes = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_retry_m1_idempotent',
      injectedZohoClient: mockClient
    });
    assert.equal(firstRes.status, 'CREATED');
    const initialCalls = mockClient.calls.length;

    // Second call returns cached
    const secondRes = await InvoiceService.createMilestone1Invoice({
      crmDealId: 'deal_retry_m1_idempotent',
      injectedZohoClient: mockClient
    });
    assert.equal(secondRes.status, 'ALREADY_CREATED');
    assert.equal(secondRes.fromCache, true);
    assert.equal(secondRes.zohoInvoiceId, firstRes.zohoInvoiceId);
    assert.equal(mockClient.calls.length, initialCalls, 'Zero additional API calls on retry');
  });
});
