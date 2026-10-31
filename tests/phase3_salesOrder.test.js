const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const IntegrationSync = require('../server/src/models/IntegrationSync');
const SalesOrderService = require('../server/src/services/salesOrderService');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  await IntegrationSync.init();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await IntegrationSync.deleteMany({});
});

/**
 * Creates a controllable mock Zoho Books client.
 */
function createMockZohoClient({
  existingOrders = [],
  createResponse = null,
  confirmSuccess = true,
  currencyCode = 'AED'
} = {}) {
  const calls = [];

  return {
    calls,
    request: async ({ method, path, body }) => {
      calls.push({ method, path, body });

      // GET /salesorders?reference_number=...
      if (method === 'GET' && path.startsWith('/salesorders?reference_number=')) {
        return {
          statusCode: 200,
          data: { code: 0, message: 'success', salesorders: existingOrders }
        };
      }

      // POST /salesorders (create draft)
      if (method === 'POST' && path === '/salesorders') {
        if (createResponse) {
          return createResponse;
        }
        const subtotal = body.line_items[0].rate;
        const tax = Number((subtotal * 0.05).toFixed(2));
        const total = Number((subtotal + tax).toFixed(2));

        const so = {
          salesorder_id: 'so_mock_123',
          salesorder_number: 'SO-00010',
          reference_number: body.reference_number,
          sub_total: subtotal,
          tax_total: tax,
          total: total,
          status: 'draft',
          order_status: 'draft'
        };

        if (currencyCode !== null) {
          so.currency_code = currencyCode;
        }

        return {
          statusCode: 200,
          data: {
            code: 0,
            message: 'Sales Order has been created.',
            salesorder: so
          }
        };
      }

      // POST /salesorders/:id/status/confirmed
      if (method === 'POST' && path.includes('/status/confirmed')) {
        if (!confirmSuccess) {
          return {
            statusCode: 400,
            data: { code: 1001, message: 'Failed to confirm Sales Order' }
          };
        }
        return {
          statusCode: 200,
          data: { code: 0, message: 'Sales order status has been changed to Confirmed.' }
        };
      }

      // Reject any invoice endpoint call (Strict Requirement 10)
      if (path.includes('/invoices')) {
        throw new Error('ILLEGAL OPERATION: Invoice endpoints must not be called in Step 2');
      }

      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

// ==============================================================================
// PHASE 3 STEP 2 AUTOMATED TEST SUITE: SALES ORDER CREATION & CONFIRMATION
// ==============================================================================
test.describe('Phase 3 Step 2: Zoho Books Sales Order Workflow', () => {
  test('Rule 1: Rejects Sales Order creation if customer mapping is missing', async () => {
    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_no_cust_01',
          zohoContactId: null // Missing customer prerequisite
        });
      },
      (err) => {
        assert.equal(err.code, 'CUSTOMER_NOT_RESOLVED');
        return true;
      }
    );
  });

  test('Rule 2 & 8: Safe transaction sequence & precise AED 120,000 + 5% VAT calculations', async () => {
    const mockClient = createMockZohoClient();

    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_aed_120k',
      zohoContactId: 'cust_real_4001',
      dealName: 'Cloud Infrastructure Contract',
      amount: 120000.0,
      currencyCode: 'AED',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CONFIRMED');
    assert.equal(res.zohoSalesOrderId, 'so_mock_123');
    assert.equal(res.salesOrderSubtotal, 120000.0);
    assert.equal(res.salesOrderTax, 6000.0);
    assert.equal(res.salesOrderTotal, 126000.0);
    assert.equal(res.currencyCode, 'AED');

    // Verify API sequence: GET pre-flight -> POST draft -> POST confirmed
    assert.equal(mockClient.calls.length, 3);
    assert.equal(mockClient.calls[0].method, 'GET'); // Pre-flight
    assert.equal(mockClient.calls[1].method, 'POST'); // Draft
    assert.equal(mockClient.calls[1].path, '/salesorders');
    assert.equal(mockClient.calls[2].method, 'POST'); // Confirmed
    assert.match(mockClient.calls[2].path, /\/status\/confirmed$/);

    // Verify MongoDB state is CONFIRMED
    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_aed_120k' });
    assert.ok(dbRecord);
    assert.equal(dbRecord.salesOrderStatus, 'CONFIRMED');
    assert.equal(dbRecord.salesOrderTotal, 126000.0);
    assert.equal(dbRecord.amountNotInvoiced, 126000.0);
  });

  test('Rule 3: Stops and reports conflict if multiple matching Sales Orders exist in Zoho', async () => {
    const mockClient = createMockZohoClient({
      existingOrders: [
        { salesorder_id: 'so_1', reference_number: 'CRM_deal_dup' },
        { salesorder_id: 'so_2', reference_number: 'CRM_deal_dup' }
      ]
    });

    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_dup',
          zohoContactId: 'cust_real_4001',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'DUPLICATE_REMOTE_SALES_ORDERS');
        assert.match(err.message, /Multiple matching Sales Orders/);
        return true;
      }
    );

    // No POST should be fired
    const postCalls = mockClient.calls.filter((c) => c.method === 'POST');
    assert.equal(postCalls.length, 0);

    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_dup' });
    assert.equal(dbRecord.syncStatus, 'FAILED');
  });

  test('Rule 4 & 5: Crash recovery after draft creation adopts existing SO without duplicating draft', async () => {
    // Simulate Zoho already having 1 matching draft SO from a prior crashed run
    const mockClient = createMockZohoClient({
      existingOrders: [
        {
          salesorder_id: 'so_crashed_99',
          salesorder_number: 'SO-00099',
          reference_number: 'CRM_deal_crash_rec',
          sub_total: 120000.0,
          tax_total: 6000.0,
          total: 126000.0,
          currency_code: 'AED',
          status: 'draft',
          order_status: 'draft'
        }
      ]
    });

    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_crash_rec',
      zohoContactId: 'cust_real_4001',
      amount: 120000.0,
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CONFIRMED');
    assert.equal(res.zohoSalesOrderId, 'so_crashed_99');

    // Crucial Assertion: Did NOT call POST /salesorders (zero duplicate draft creation)
    const draftCreates = mockClient.calls.filter((c) => c.method === 'POST' && c.path === '/salesorders');
    assert.equal(draftCreates.length, 0);

    // It proceeded directly to confirmation
    const confirmCalls = mockClient.calls.filter((c) => c.path.includes('/status/confirmed'));
    assert.equal(confirmCalls.length, 1);
  });

  test('Rule 5: Failed confirmation leaves draft in MongoDB without creating duplicate', async () => {
    const mockClient = createMockZohoClient({
      confirmSuccess: false // Confirmation API fails
    });

    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_fail_confirm',
          zohoContactId: 'cust_real_4001',
          amount: 120000.0,
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'SALES_ORDER_CONFIRMATION_FAILED');
        return true;
      }
    );

    // Check that DRAFT was safely saved in MongoDB
    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_fail_confirm' });
    assert.ok(dbRecord);
    assert.equal(dbRecord.salesOrderStatus, 'DRAFT');
    assert.equal(dbRecord.zohoSalesOrderId, 'so_mock_123');
    assert.equal(dbRecord.syncStatus, 'FAILED');
  });

  test('Rule 6: Concurrent workers processing same deal are locked (only one succeeds with explicit IDs)', async () => {
    const mockClient = createMockZohoClient();

    // Fire two simultaneous calls for the same deal ID with explicit worker IDs
    const results = await Promise.allSettled([
      SalesOrderService.createAndConfirmSalesOrder({
        crmDealId: 'deal_concurrent_01',
        zohoContactId: 'cust_real_4001',
        workerId: 'worker_alpha',
        injectedZohoClient: mockClient
      }),
      SalesOrderService.createAndConfirmSalesOrder({
        crmDealId: 'deal_concurrent_01',
        zohoContactId: 'cust_real_4001',
        workerId: 'worker_beta',
        injectedZohoClient: mockClient
      })
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'DEAL_LOCKED_BY_ANOTHER_WORKER');
  });

  test('Rule 6C: Two concurrent executions with the SAME supplied worker ID are isolated via internal execution UUIDs', async () => {
    const mockClient = createMockZohoClient();

    // Both callers pass the exact same string 'worker_shared_alpha'
    // The service must generate composite unique execution UUIDs so they do not share the lock
    const results = await Promise.allSettled([
      SalesOrderService.createAndConfirmSalesOrder({
        crmDealId: 'deal_concurrent_same_id',
        zohoContactId: 'cust_real_4001',
        workerId: 'worker_shared_alpha',
        injectedZohoClient: mockClient
      }),
      SalesOrderService.createAndConfirmSalesOrder({
        crmDealId: 'deal_concurrent_same_id',
        zohoContactId: 'cust_real_4001',
        workerId: 'worker_shared_alpha',
        injectedZohoClient: mockClient
      })
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'DEAL_LOCKED_BY_ANOTHER_WORKER');
  });

  test('Rule 13: Zoho POST taking longer than original lease succeeds due to active heartbeat renewal', async () => {
    // Lease is 100ms, heartbeat is 25ms, Zoho POST takes 150ms (> leaseDurationMs)
    const mockClient = {
      calls: [],
      request: async ({ method, path, body }) => {
        if (method === 'GET' && path.startsWith('/salesorders?reference_number=')) {
          return { statusCode: 200, data: { code: 0, salesorders: [] } };
        }
        if (method === 'POST' && path === '/salesorders') {
          // Delay longer than original lease duration
          await new Promise((r) => setTimeout(r, 150));
          return {
            statusCode: 200,
            data: {
              code: 0,
              salesorder: {
                salesorder_id: 'so_heartbeat_long',
                salesorder_number: 'SO-HB-01',
                reference_number: body.reference_number,
                sub_total: 120000.0,
                tax_total: 6000.0,
                total: 126000.0,
                currency_code: 'AED',
                status: 'draft',
                order_status: 'draft'
              }
            }
          };
        }
        if (method === 'POST' && path.includes('/status/confirmed')) {
          return { statusCode: 200, data: { code: 0, message: 'Confirmed' } };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_heartbeat_extension',
      zohoContactId: 'cust_real_4001',
      leaseDurationMs: 100,
      heartbeatIntervalMs: 25,
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CONFIRMED');
    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_heartbeat_extension' });
    assert.equal(dbRecord.salesOrderStatus, 'CONFIRMED');
    assert.equal(dbRecord.syncStatus, 'SALES_ORDER_CONFIRMED');
  });

  test('Rule 14: Lease renewal prevents premature takeover by a competing worker', async () => {
    // Worker A runs with leaseDurationMs: 150ms, heartbeatIntervalMs: 30ms
    const slowClient = {
      request: async ({ method, path, body }) => {
        if (method === 'GET') {
          return { statusCode: 200, data: { code: 0, salesorders: [] } };
        }
        if (method === 'POST' && path === '/salesorders') {
          // Simulate slow POST lasting 220ms (longer than the initial 150ms lease)
          await new Promise((r) => setTimeout(r, 220));
          return {
            statusCode: 200,
            data: {
              code: 0,
              salesorder: {
                salesorder_id: 'so_hb_compete',
                salesorder_number: 'SO-COMP-01',
                sub_total: 120000.0,
                tax_total: 6000.0,
                total: 126000.0,
                currency_code: 'AED',
                status: 'draft',
                order_status: 'draft'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    // Start Worker A
    const workerAPromise = SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_prevent_takeover',
      zohoContactId: 'cust_real_4001',
      leaseDurationMs: 150,
      heartbeatIntervalMs: 30,
      injectedZohoClient: slowClient
    });

    // Wait 170ms (exceeds original 150ms lease)
    await new Promise((r) => setTimeout(r, 170));

    // Worker B attempts to take over
    await assert.rejects(
      async () => {
        await SalesOrderService.acquireDealLock('deal_prevent_takeover', 'worker_b_intruder');
      },
      (err) => {
        assert.equal(err.code, 'DEAL_LOCKED_BY_ANOTHER_WORKER');
        return true;
      }
    );

    // Ensure Worker A completes successfully
    const resA = await workerAPromise;
    assert.equal(resA.status, 'CONFIRMED');
  });

  test('Rule 15: A genuinely expired worker allows safe recovery by a new worker', async () => {
    // Seed record locked by a dead worker whose lease expired in the past
    await IntegrationSync.create({
      crmDealId: 'deal_expired_recovery',
      lockedBy: 'worker_dead_process_888',
      lockedAt: new Date(Date.now() - 60000),
      leaseExpiresAt: new Date(Date.now() - 1000), // Expired 1 second ago!
      syncStatus: 'PROCESSING'
    });

    const mockClient = createMockZohoClient();

    // Worker B arrives and claims the deal
    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_expired_recovery',
      zohoContactId: 'cust_real_4001',
      workerId: 'worker_healthy_recovery',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CONFIRMED');
    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_expired_recovery' });
    assert.equal(dbRecord.salesOrderStatus, 'CONFIRMED');
    assert.equal(dbRecord.syncStatus, 'SALES_ORDER_CONFIRMED');
  });

  test('Rule 16: Uncertain remote POST outcome (network error) reconciled safely via pre-flight lookup', async () => {
    let postAttempted = false;

    const mockClient = {
      calls: [],
      request: async ({ method, path, body }) => {
        // Track calls
        mockClient.calls.push({ method, path });

        // Pre-flight GET before POST: 0 results
        if (method === 'GET' && !postAttempted) {
          return { statusCode: 200, data: { code: 0, salesorders: [] } };
        }

        // POST /salesorders throws a network timeout error
        if (method === 'POST' && path === '/salesorders') {
          postAttempted = true;
          throw new Error('ETIMEDOUT: Connection dropped during POST to Zoho Books');
        }

        // Reconciliation GET after POST failure: Zoho DID create it!
        if (method === 'GET' && postAttempted) {
          return {
            statusCode: 200,
            data: {
              code: 0,
              salesorders: [
                {
                  salesorder_id: 'so_reconciled_after_timeout',
                  salesorder_number: 'SO-REC-01',
                  reference_number: 'CRM_deal_timeout_reconcile',
                  sub_total: 120000.0,
                  tax_total: 6000.0,
                  total: 126000.0,
                  currency_code: 'AED',
                  status: 'draft',
                  order_status: 'draft'
                }
              ]
            }
          };
        }

        // Confirmation of reconciled order
        if (method === 'POST' && path.includes('/status/confirmed')) {
          return { statusCode: 200, data: { code: 0, message: 'Confirmed' } };
        }

        return { statusCode: 200, data: { code: 0 } };
      }
    };

    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_timeout_reconcile',
      zohoContactId: 'cust_real_4001',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CONFIRMED');
    assert.equal(res.zohoSalesOrderId, 'so_reconciled_after_timeout');

    // Confirm that the reconciled order is stored in MongoDB as CONFIRMED
    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_timeout_reconcile' });
    assert.equal(dbRecord.zohoSalesOrderId, 'so_reconciled_after_timeout');
    assert.equal(dbRecord.salesOrderStatus, 'CONFIRMED');
    assert.equal(dbRecord.syncStatus, 'SALES_ORDER_CONFIRMED');
  });

  test('Rule 7A: Rejects returned Sales Order if currency_code is missing', async () => {
    const mockClient = createMockZohoClient({
      currencyCode: null // Zoho returned no currency_code
    });

    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_missing_currency',
          zohoContactId: 'cust_real_4001',
          amount: 120000.0,
          currencyCode: 'AED',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'SALES_ORDER_MISSING_CURRENCY');
        assert.match(err.message, /missing required 'currency_code'/);
        return true;
      }
    );
  });

  test('Rule 7B: Rejects returned Sales Order if currency_code is incorrect (USD instead of AED)', async () => {
    const mockClient = createMockZohoClient({
      currencyCode: 'USD' // Zoho returned USD instead of requested AED
    });

    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_bad_currency',
          zohoContactId: 'cust_real_4001',
          amount: 120000.0,
          currencyCode: 'AED',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'SALES_ORDER_CURRENCY_MISMATCH');
        assert.match(err.message, /Financial\/Currency Validation Failed/);
        return true;
      }
    );
  });

  test('Rule 8: Consistent final MongoDB status and idempotency never leaves document in PROCESSING', async () => {
    const mockClient = createMockZohoClient();

    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_status_consistency',
      zohoContactId: 'cust_real_4001',
      amount: 120000.0,
      currencyCode: 'AED',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CONFIRMED');

    let dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_status_consistency' });
    assert.equal(dbRecord.salesOrderStatus, 'CONFIRMED');
    assert.equal(dbRecord.syncStatus, 'SALES_ORDER_CONFIRMED');
    assert.notEqual(dbRecord.syncStatus, 'PROCESSING');

    // Second invocation (idempotency check)
    const cachedRes = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_status_consistency',
      zohoContactId: 'cust_real_4001',
      injectedZohoClient: mockClient
    });
    assert.equal(cachedRes.status, 'ALREADY_CONFIRMED');

    // Must remain SALES_ORDER_CONFIRMED and NOT PROCESSING
    dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_status_consistency' });
    assert.equal(dbRecord.salesOrderStatus, 'CONFIRMED');
    assert.equal(dbRecord.syncStatus, 'SALES_ORDER_CONFIRMED');
    assert.notEqual(dbRecord.syncStatus, 'PROCESSING');
  });

  test('Rule 9: Idempotency - Calling on already confirmed deal returns cached data with 0 API calls', async () => {
    // Seed confirmed deal in DB
    await IntegrationSync.create({
      crmDealId: 'deal_already_confirmed',
      zohoContactId: 'cust_real_4001',
      zohoSalesOrderId: 'so_existing_confirmed_55',
      zohoSalesOrderNumber: 'SO-00055',
      salesOrderTotal: 126000.0,
      salesOrderStatus: 'CONFIRMED',
      syncStatus: 'SALES_ORDER_CONFIRMED'
    });

    const mockClient = createMockZohoClient();

    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_already_confirmed',
      zohoContactId: 'cust_real_4001',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'ALREADY_CONFIRMED');
    assert.equal(res.fromCache, true);
    assert.equal(res.zohoSalesOrderId, 'so_existing_confirmed_55');
    assert.equal(mockClient.calls.length, 0, 'Must make zero Zoho API calls when already confirmed');
  });

  test('Rule 10: Strict invoice restriction - Zero calls made to invoice endpoints', async () => {
    const mockClient = createMockZohoClient();

    await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_invoice_check',
      zohoContactId: 'cust_real_4001',
      amount: 120000.0,
      injectedZohoClient: mockClient
    });

    // Verify no invoice calls exist
    const invoiceCalls = mockClient.calls.filter((c) => c.path.includes('/invoices'));
    assert.equal(invoiceCalls.length, 0);
  });

  test('Rule 11: Lease expiry and stale worker protection - fencing guard rejects write from preempted worker', async () => {
    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET') {
          return { statusCode: 200, data: { code: 0, salesorders: [] } };
        }
        if (method === 'POST' && path === '/salesorders') {
          // Simulate that while Zoho was processing, the worker's lease expired
          // and another worker preempted and claimed the record in MongoDB!
          await IntegrationSync.updateOne(
            { crmDealId: 'deal_stale_worker' },
            { $set: { lockedBy: 'worker_new_preempting_worker', leaseExpiresAt: new Date(Date.now() + 60000) } }
          );

          return {
            statusCode: 200,
            data: {
              code: 0,
              salesorder: {
                salesorder_id: 'so_stale_test',
                salesorder_number: 'SO-STALE-01',
                sub_total: 120000.0,
                tax_total: 6000.0,
                total: 126000.0,
                currency_code: 'AED',
                status: 'draft',
                order_status: 'draft'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_stale_worker',
          zohoContactId: 'cust_real_4001',
          workerId: 'worker_old_stale',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'WORKER_LEASE_FENCED');
        assert.match(err.message, /Fencing Guard/);
        return true;
      }
    );

    // Verify that the preempting worker's lock was NOT overwritten
    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_stale_worker' });
    assert.equal(dbRecord.lockedBy, 'worker_new_preempting_worker');
  });

  test('Rule 12: Monetary rounding and precision - rejects off-by-one-cent response', async () => {
    const mockClient = {
      calls: [],
      request: async ({ method, path }) => {
        if (method === 'GET') {
          return { statusCode: 200, data: { code: 0, salesorders: [] } };
        }
        if (method === 'POST' && path === '/salesorders') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              salesorder: {
                salesorder_id: 'so_off_by_one',
                salesorder_number: 'SO-0001',
                sub_total: 120000.0,
                tax_total: 6000.01, // 1 cent off! (6,000.01 instead of 6,000.00)
                total: 126000.01,
                currency_code: 'AED',
                status: 'draft',
                order_status: 'draft'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_off_by_one',
          zohoContactId: 'cust_real_4001',
          amount: 120000.0,
          currencyCode: 'AED',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'SALES_ORDER_FINANCIAL_VALIDATION_FAILED');
        assert.match(err.message, /Financial Validation Failed/);
        return true;
      }
    );
  });

  test('Rule 17: Forwarding configured ZOHO_UAE_VAT_TAX_ID and ZOHO_AED_CURRENCY_ID to Sales Order payload', async () => {
    const originalTaxId = process.env.ZOHO_UAE_VAT_TAX_ID;
    const originalCurrencyId = process.env.ZOHO_AED_CURRENCY_ID;
    try {
      process.env.ZOHO_UAE_VAT_TAX_ID = 'tax_custom_uae_vat_5_pct';
      process.env.ZOHO_AED_CURRENCY_ID = 'curr_custom_aed_id';

      const mockClient = createMockZohoClient();

      const res = await SalesOrderService.createAndConfirmSalesOrder({
        crmDealId: 'deal_tax_forwarding_01',
        zohoContactId: 'cust_real_4001',
        dealName: 'Cloud Infrastructure Contract',
        amount: 120000.0,
        currencyCode: 'AED',
        injectedZohoClient: mockClient
      });

      assert.equal(res.status, 'CONFIRMED');
      assert.equal(res.salesOrderSubtotal, 120000.0);
      assert.equal(res.salesOrderTax, 6000.0);
      assert.equal(res.salesOrderTotal, 126000.0);

      // Verify payload forwarded to Zoho POST /salesorders
      const postCall = mockClient.calls.find((c) => c.method === 'POST' && c.path === '/salesorders');
      assert.ok(postCall, 'Must invoke POST /salesorders');
      assert.equal(postCall.body.currency_id, 'curr_custom_aed_id');
      assert.equal(postCall.body.line_items[0].tax_id, 'tax_custom_uae_vat_5_pct');
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

  test('Rule 18: Missing tax configuration fails safely when Zoho returns 0 tax without confirmation', async () => {
    const mockClient = {
      calls: [],
      request: async ({ method, path, body }) => {
        mockClient.calls.push({ method, path, body });
        if (method === 'GET' && path.startsWith('/salesorders?reference_number=')) {
          return { statusCode: 200, data: { code: 0, salesorders: [] } };
        }
        if (method === 'POST' && path === '/salesorders') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              salesorder: {
                salesorder_id: 'so_zero_tax_123',
                salesorder_number: 'SO-ZERO-01',
                reference_number: body.reference_number,
                sub_total: 120000.0,
                tax_total: 0.0, // Zoho calculated 0 tax because tax_id was missing
                total: 120000.0,
                currency_code: 'AED',
                status: 'draft',
                order_status: 'draft'
              }
            }
          };
        }
        if (method === 'POST' && path.includes('/status/confirmed')) {
          return { statusCode: 200, data: { code: 0, message: 'Confirmed' } };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_missing_tax_zero_vat',
          zohoContactId: 'cust_real_4001',
          amount: 120000.0,
          currencyCode: 'AED',
          taxId: null,
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'SALES_ORDER_FINANCIAL_VALIDATION_FAILED');
        assert.match(err.message, /Financial Validation Failed/);
        return true;
      }
    );

    // Confirm that /status/confirmed was NEVER called (safety check)
    const confirmCalls = mockClient.calls.filter((c) => c.path.includes('/status/confirmed'));
    assert.equal(confirmCalls.length, 0, 'Must NOT call confirmation when financial validation fails');

    // Verify MongoDB status is FAILED and salesOrderStatus is NOT confirmed
    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_missing_tax_zero_vat' });
    assert.ok(dbRecord);
    assert.equal(dbRecord.syncStatus, 'FAILED');
    assert.equal(dbRecord.salesOrderStatus, 'NONE');
    assert.notEqual(dbRecord.salesOrderStatus, 'CONFIRMED');
  });

  test('Rule 19: Incorrect Zoho-calculated tax triggers financial validation failure without confirmation', async () => {
    const mockClient = {
      calls: [],
      request: async ({ method, path, body }) => {
        mockClient.calls.push({ method, path, body });
        if (method === 'GET' && path.startsWith('/salesorders?reference_number=')) {
          return { statusCode: 200, data: { code: 0, salesorders: [] } };
        }
        if (method === 'POST' && path === '/salesorders') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              salesorder: {
                salesorder_id: 'so_wrong_tax_456',
                salesorder_number: 'SO-WRONG-01',
                reference_number: body.reference_number,
                sub_total: 120000.0,
                tax_total: 5000.0, // Incorrect tax (expected 6000.0)
                total: 125000.0,
                currency_code: 'AED',
                status: 'draft',
                order_status: 'draft'
              }
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    await assert.rejects(
      async () => {
        await SalesOrderService.createAndConfirmSalesOrder({
          crmDealId: 'deal_wrong_tax_calc',
          zohoContactId: 'cust_real_4001',
          amount: 120000.0,
          currencyCode: 'AED',
          injectedZohoClient: mockClient
        });
      },
      (err) => {
        assert.equal(err.code, 'SALES_ORDER_FINANCIAL_VALIDATION_FAILED');
        assert.match(err.message, /Expected Subtotal=120000.00, Tax=6000.00, Gross=126000.00/);
        return true;
      }
    );

    const confirmCalls = mockClient.calls.filter((c) => c.path.includes('/status/confirmed'));
    assert.equal(confirmCalls.length, 0);

    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_wrong_tax_calc' });
    assert.equal(dbRecord.syncStatus, 'FAILED');
  });

  test('Rule 20: Idempotency after retry returns cached confirmed order without re-POSTing', async () => {
    const mockClient = createMockZohoClient();

    // First attempt creates and confirms
    const firstRes = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_retry_idempotency_01',
      zohoContactId: 'cust_real_4001',
      dealName: 'Cloud Infrastructure Contract',
      amount: 120000.0,
      currencyCode: 'AED',
      injectedZohoClient: mockClient
    });
    assert.equal(firstRes.status, 'CONFIRMED');
    const initialCallCount = mockClient.calls.length;

    // Retry invocation for identical deal
    const retryRes = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_retry_idempotency_01',
      zohoContactId: 'cust_real_4001',
      injectedZohoClient: mockClient
    });

    assert.equal(retryRes.status, 'ALREADY_CONFIRMED');
    assert.equal(retryRes.fromCache, true);
    assert.equal(retryRes.zohoSalesOrderId, firstRes.zohoSalesOrderId);
    // Zero new API calls on retry
    assert.equal(mockClient.calls.length, initialCallCount);
  });

  test('Rule 21: Explicit taxPercentage = 0 creates Sales Order without tax_id and verifies 0 tax', async () => {
    const mockClient = {
      calls: [],
      request: async ({ method, path, body }) => {
        mockClient.calls.push({ method, path, body });
        if (method === 'GET' && path.startsWith('/salesorders?reference_number=')) {
          return { statusCode: 200, data: { code: 0, message: 'success', salesorders: [] } };
        }
        if (method === 'POST' && path === '/salesorders') {
          const subtotal = body.line_items[0].rate;
          return {
            statusCode: 200,
            data: {
              code: 0,
              message: 'Sales Order has been created.',
              salesorder: {
                salesorder_id: 'so_zero_tax_approved',
                salesorder_number: 'SO-ZERO-01',
                reference_number: body.reference_number,
                currency_code: 'AED',
                sub_total: subtotal,
                tax_total: 0.0,
                total: subtotal,
                status: 'draft'
              }
            }
          };
        }
        if (method === 'POST' && path.includes('/status/confirmed')) {
          return { statusCode: 200, data: { code: 0, message: 'Sales order status changed to Confirmed.' } };
        }
        return { statusCode: 404, data: { code: 1, message: 'Not found' } };
      }
    };

    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_zero_tax_so_01',
      zohoContactId: 'cust_real_4001',
      dealName: 'NovaTech Zero VAT Deal',
      amount: 120000.0,
      currencyCode: 'AED',
      taxPercentage: 0,
      taxId: 'tax_should_be_ignored_when_zero',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CONFIRMED');
    assert.equal(res.salesOrderSubtotal, 120000.0);
    assert.equal(res.salesOrderTax, 0.0);
    assert.equal(res.salesOrderTotal, 120000.0);

    const postCall = mockClient.calls.find((c) => c.method === 'POST' && c.path === '/salesorders');
    assert.ok(postCall);
    assert.equal(postCall.body.line_items[0].rate, 120000.0);
    assert.equal(postCall.body.line_items[0].tax_id, undefined, 'No tax_id should be included when taxPercentage is 0');
    assert.match(postCall.body.notes, /VAT \(0%\): AED 0\.00/);

    const dbRecord = await IntegrationSync.findOne({ crmDealId: 'deal_zero_tax_so_01' });
    assert.ok(dbRecord);
    assert.equal(dbRecord.salesOrderSubtotal, 120000.0);
    assert.equal(dbRecord.salesOrderTax, 0.0);
    assert.equal(dbRecord.salesOrderTotal, 120000.0);
    assert.equal(dbRecord.salesOrderStatus, 'CONFIRMED');
  });

  test('Rule 22: Explicit taxPercentage = 5.0 preserves 5% VAT with tax_id', async () => {
    const mockClient = createMockZohoClient();
    const res = await SalesOrderService.createAndConfirmSalesOrder({
      crmDealId: 'deal_explicit_5pct_so_01',
      zohoContactId: 'cust_real_4001',
      dealName: 'NovaTech 5% VAT Deal',
      amount: 120000.0,
      currencyCode: 'AED',
      taxPercentage: 5.0,
      taxId: 'tax_uae_vat_5_pct',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'CONFIRMED');
    assert.equal(res.salesOrderSubtotal, 120000.0);
    assert.equal(res.salesOrderTax, 6000.0);
    assert.equal(res.salesOrderTotal, 126000.0);

    const postCall = mockClient.calls.find((c) => c.method === 'POST' && c.path === '/salesorders');
    assert.ok(postCall);
    assert.equal(postCall.body.line_items[0].tax_id, 'tax_uae_vat_5_pct');
    assert.match(postCall.body.notes, /5% VAT: AED 6000\.00/);
  });
});

