const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const app = require('../server/src/app');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const PaymentRecord = require('../server/src/models/PaymentRecord');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationLog = require('../server/src/models/IntegrationLog');
const PaymentService = require('../server/src/services/paymentService');
const WebhookService = require('../server/src/services/webhookService');

let mongoServer;
let globalDealCounter = 600;

function createMockHubSpotClient({ updateFails = false } = {}) {
  const calls = [];
  return {
    calls,
    getDeal: async (dealId) => {
      calls.push({ method: 'GET', path: `/crm/v3/objects/deals/${dealId}` });
      return {
        statusCode: 200,
        data: {
          id: dealId,
          properties: { dealname: `Deal ${dealId}`, dealstage: 'closedwon', amount: 120000.0 }
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
  payments = {},
  invoices = {},
  paymentFetchFails = false,
  invoiceFetchFails = false
} = {}) {
  const calls = [];
  return {
    calls,
    request: async ({ method, path }) => {
      calls.push({ method, path });

      if (method === 'GET' && path.startsWith('/customerpayments/')) {
        if (paymentFetchFails) {
          throw new Error('ETIMEDOUT: Connection dropped during GET /customerpayments');
        }
        const payId = path.split('/')[2];
        const pay = payments[payId];
        if (!pay) {
          return { statusCode: 404, data: { code: 1001, message: 'Payment not found' } };
        }
        return { statusCode: 200, data: { code: 0, payment: pay } };
      }

      if (method === 'GET' && path.startsWith('/invoices/')) {
        if (invoiceFetchFails) {
          throw new Error('ETIMEDOUT: Connection dropped during GET /invoices');
        }
        const invId = path.split('/')[2];
        const inv = invoices[invId];
        if (!inv) {
          return { statusCode: 404, data: { code: 1002, message: 'Invoice not found' } };
        }
        return { statusCode: 200, data: { code: 0, invoice: inv } };
      }

      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

async function setupDealWithInvoices(dealId, { m1Balance = 63000.0, m2Balance = null } = {}) {
  const sync = await IntegrationSync.create({
    crmDealId: dealId,
    zohoContactId: `cust_${dealId}`,
    zohoSalesOrderId: `so_${dealId}`,
    salesOrderTotal: 126000.0,
    salesOrderSubtotal: 120000.0,
    salesOrderStatus: 'CONFIRMED',
    syncStatus: m2Balance !== null ? 'M2_INVOICED' : 'M1_INVOICED',
    percentageInvoiced: m2Balance !== null ? 80.0 : 50.0,
    totalInvoicedAmount: m2Balance !== null ? 100800.0 : 63000.0,
    amountNotInvoiced: m2Balance !== null ? 25200.0 : 63000.0,
    amountInvoicedUnpaid: m2Balance !== null ? 100800.0 : 63000.0,
    currencyCode: 'AED'
  });

  const m1 = await MilestoneInvoice.create({
    crmDealId: dealId,
    syncId: sync._id,
    milestoneIndex: 1,
    milestoneName: 'Signing',
    percentage: 50,
    subtotal: 60000.0,
    taxAmount: 3000.0,
    totalAmount: 63000.0,
    balance: m1Balance,
    dueDate: new Date('2026-11-30'),
    zohoInvoiceId: `inv_m1_${dealId}`,
    zohoInvoiceNumber: 'INV-M1',
    zohoSalesOrderId: `so_${dealId}`,
    referenceNumber: `CRM_${dealId}_M1`,
    currencyCode: 'AED',
    status: m1Balance === 0 ? 'PAID' : (m1Balance < 63000.0 ? 'PARTIALLY_PAID' : 'CREATED')
  });

  let m2 = null;
  if (m2Balance !== null) {
    m2 = await MilestoneInvoice.create({
      crmDealId: dealId,
      syncId: sync._id,
      milestoneIndex: 2,
      milestoneName: 'Go-Live',
      percentage: 30,
      subtotal: 36000.0,
      taxAmount: 1800.0,
      totalAmount: 37800.0,
      balance: m2Balance,
      dueDate: new Date('2026-12-31'),
      zohoInvoiceId: `inv_m2_${dealId}`,
      zohoInvoiceNumber: 'INV-M2',
      zohoSalesOrderId: `so_${dealId}`,
      referenceNumber: `CRM_${dealId}_M2`,
      currencyCode: 'AED',
      status: m2Balance === 0 ? 'PAID' : (m2Balance < 37800.0 ? 'PARTIALLY_PAID' : 'CREATED')
    });
  }

  return { sync, m1, m2 };
}

test.describe('Phase 4: Zoho Books to CRM Reverse Sync (Payments)', () => {
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
    await PaymentRecord.deleteMany({});
    await WebhookEvent.deleteMany({});
    await IntegrationLog.deleteMany({});
  });

  // 1. Full Payment
  test('Scenario 1: Full payment on M1 invoice sets balance 0, status PAID, and updates HubSpot collection to 50%', async () => {
    const dealId = 'deal_pay_full';
    await setupDealWithInvoices(dealId);

    const mockZoho = createMockZohoClient({
      payments: {
        pay_full_1: {
          payment_id: 'pay_full_1',
          payment_number: 'PAY-1001',
          amount: 63000.0,
          date: '2026-11-05',
          payment_mode: 'Bank Transfer',
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 63000.0 }]
        }
      },
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 0.0,
          status: 'paid'
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const res = await PaymentService.processPaymentEvent({
      paymentPayload: { payment_id: 'pay_full_1' },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(res.success, true);
    assert.equal(res.allocationsProcessed, 1);

    // Verify MilestoneInvoice updated
    const mDoc = await MilestoneInvoice.findOne({ crmDealId: dealId, milestoneIndex: 1 });
    assert.equal(mDoc.balance, 0.0);
    assert.equal(mDoc.status, 'PAID');
    assert.ok(mDoc.paidAt);

    // Verify PaymentRecord saved
    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_full_1' });
    assert.ok(pDoc);
    assert.equal(pDoc.amount, 63000.0);
    assert.equal(pDoc.status, 'APPLIED');

    // Verify IntegrationSync financials
    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 63000.0);
    assert.equal(syncDoc.percentageCollected, 50.0); // 63k / 126k = 50%
    assert.equal(syncDoc.amountInvoicedUnpaid, 0.0);

    // Verify HubSpot properties PATCH
    const patchCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.ok(patchCall);
    assert.equal(patchCall.properties.zoho_total_collected_amount, 63000.0);
    assert.equal(patchCall.properties.zoho_percentage_collected, 50.0);
    assert.equal(patchCall.properties.zoho_amount_invoiced_unpaid, 0.0);
    assert.equal(patchCall.properties.zoho_payment_status, 'PAID');
    assert.equal(patchCall.properties.zoho_is_overdue, 'false');

    // Verify IntegrationLog persisted
    const logDoc = await IntegrationLog.findOne({ crmDealId: dealId });
    assert.ok(logDoc);
    assert.equal(logDoc.system, 'ZOHO_BOOKS');
    assert.equal(logDoc.isSuccess, true);
  });

  // 2. Partial Payment
  test('Scenario 2: Partial payment of AED 30,000 updates balance to 33,000, status PARTIALLY_PAID, collection percentage 23.81%', async () => {
    const dealId = 'deal_pay_partial';
    await setupDealWithInvoices(dealId);

    const mockZoho = createMockZohoClient({
      payments: {
        pay_part_1: {
          payment_id: 'pay_part_1',
          payment_number: 'PAY-1002',
          amount: 30000.0,
          date: '2026-11-05',
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 30000.0 }]
        }
      },
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 33000.0,
          status: 'partially_paid'
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const res = await PaymentService.processPaymentEvent({
      paymentPayload: { payment_id: 'pay_part_1' },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(res.success, true);

    const mDoc = await MilestoneInvoice.findOne({ crmDealId: dealId, milestoneIndex: 1 });
    assert.equal(mDoc.balance, 33000.0);
    assert.equal(mDoc.status, 'PARTIALLY_PAID');

    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 30000.0);
    assert.equal(syncDoc.amountInvoicedUnpaid, 33000.0);
    assert.equal(syncDoc.percentageCollected, 23.81); // 30,000 / 126,000 * 100 = 23.81%

    const patchCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.equal(patchCall.properties.zoho_total_collected_amount, 30000.0);
    assert.equal(patchCall.properties.zoho_percentage_collected, 23.81);
    assert.equal(patchCall.properties.zoho_amount_invoiced_unpaid, 33000.0);
    assert.equal(patchCall.properties.zoho_payment_status, 'PARTIALLY_PAID');
  });

  // 3. Multiple Partial Payments Against One Invoice
  test('Scenario 3: Multiple partial payments (30k then 33k) transition invoice from PARTIALLY_PAID to fully PAID without double counting', async () => {
    const dealId = 'deal_pay_multiple';
    await setupDealWithInvoices(dealId);

    const mockZoho = createMockZohoClient({
      payments: {
        pay_part_a: {
          payment_id: 'pay_part_a',
          amount: 30000.0,
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 30000.0 }]
        },
        pay_part_b: {
          payment_id: 'pay_part_b',
          amount: 33000.0,
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 33000.0 }]
        }
      },
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 33000.0
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    // Payment A: 30,000 applied
    await PaymentService.processPaymentEvent({
      paymentPayload: { payment_id: 'pay_part_a' },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    // Update Zoho invoice balance to 0 for Payment B
    mockZoho.request = async ({ method, path }) => {
      if (method === 'GET' && path === '/customerpayments/pay_part_b') {
        return {
          statusCode: 200,
          data: {
            code: 0,
            payment: {
              payment_id: 'pay_part_b',
              amount: 33000.0,
              invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 33000.0 }]
            }
          }
        };
      }
      if (method === 'GET' && path === `/invoices/inv_m1_${dealId}`) {
        return {
          statusCode: 200,
          data: { code: 0, invoice: { invoice_id: `inv_m1_${dealId}`, total: 63000.0, balance: 0.0 } }
        };
      }
      return { statusCode: 200, data: { code: 0 } };
    };

    // Payment B: 33,000 applied
    await PaymentService.processPaymentEvent({
      paymentPayload: { payment_id: 'pay_part_b' },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    const mDoc = await MilestoneInvoice.findOne({ crmDealId: dealId, milestoneIndex: 1 });
    assert.equal(mDoc.balance, 0.0);
    assert.equal(mDoc.status, 'PAID');

    const paymentRecordsCount = await PaymentRecord.countDocuments({ crmDealId: dealId, status: 'APPLIED' });
    assert.equal(paymentRecordsCount, 2);

    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 63000.0);
    assert.equal(syncDoc.amountInvoicedUnpaid, 0.0);
    assert.equal(syncDoc.percentageCollected, 50.0);
  });

  // 4. Duplicate Payment Event & Idempotency
  test('Scenario 4: Replaying identical payment event is idempotent and makes zero balance changes', async () => {
    const dealId = 'deal_pay_duplicate';
    await setupDealWithInvoices(dealId);

    const mockZoho = createMockZohoClient({
      payments: {
        pay_dup_101: {
          payment_id: 'pay_dup_101',
          amount: 63000.0,
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 63000.0 }]
        }
      },
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 0.0
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    // Call 1
    const res1 = await PaymentService.processPaymentEvent({
      paymentPayload: { payment_id: 'pay_dup_101' },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });
    assert.equal(res1.results[0].status, 'PAYMENT_APPLIED');

    // Call 2: Exact duplicate
    const res2 = await PaymentService.processPaymentEvent({
      paymentPayload: { payment_id: 'pay_dup_101' },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });
    assert.equal(res2.results[0].status, 'ALREADY_PROCESSED');

    // Verify PaymentRecord count remains 1
    const pCount = await PaymentRecord.countDocuments({ paymentId: 'pay_dup_101' });
    assert.equal(pCount, 1);

    // Verify amountCollected was not doubled to 126,000!
    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 63000.0, 'Amount collected must NOT double count');
  });

  // 5. Duplicate Webhook Ingestion (POST /api/webhooks/zoho)
  test('Scenario 5: Ingesting duplicate Zoho payment webhook payload returns HTTP 202 and deduplicates safely', async () => {
    const payload = {
      event_type: 'payment_created',
      payment: {
        payment_id: 'pay_hook_555',
        amount: 30000.0
      }
    };

    const res1 = await request(app)
      .post('/api/webhooks/zoho')
      .send(payload);

    assert.equal(res1.status, 202);
    assert.equal(res1.body.summary.accepted, 1);
    assert.equal(res1.body.summary.duplicates, 0);

    // Replay duplicate webhook
    const res2 = await request(app)
      .post('/api/webhooks/zoho')
      .send(payload);

    assert.equal(res2.status, 202);
    assert.equal(res2.body.summary.accepted, 0);
    assert.equal(res2.body.summary.duplicates, 1);

    const eventCount = await WebhookEvent.countDocuments({ source: 'ZOHO_BOOKS' });
    assert.equal(eventCount, 1);
  });

  // 6. Payment Reversal / Refund
  test('Scenario 6: Payment reversal restores invoice balance, reverts status to CREATED, and reduces collected amount', async () => {
    const dealId = 'deal_pay_reversal';
    await setupDealWithInvoices(dealId);

    // Seed payment
    await PaymentRecord.create({
      paymentId: 'pay_to_reverse',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 63000.0,
      amountMinor: 6300000,
      status: 'APPLIED'
    });

    await MilestoneInvoice.updateOne(
      { crmDealId: dealId, milestoneIndex: 1 },
      { $set: { balance: 0.0, status: 'PAID', paidAt: new Date() } }
    );

    await IntegrationSync.updateOne(
      { crmDealId: dealId },
      { $set: { amountCollected: 63000.0, amountInvoicedUnpaid: 0.0, percentageCollected: 50.0 } }
    );

    // Zoho returns restored balance of 63,000 on refund
    const mockZoho = createMockZohoClient({
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 63000.0,
          status: 'sent'
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const revRes = await PaymentService.processPaymentReversal({
      paymentId: 'pay_to_reverse',
      reason: 'Customer requested refund',
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(revRes.success, true);
    assert.equal(revRes.reversals[0].status, 'REVERSED');

    // Verify PaymentRecord marked REVERSED
    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_to_reverse' });
    assert.equal(pDoc.status, 'REVERSED');
    assert.equal(pDoc.reversalReason, 'Customer requested refund');
    assert.ok(pDoc.reversedAt);

    // Verify MilestoneInvoice reverted
    const mDoc = await MilestoneInvoice.findOne({ crmDealId: dealId, milestoneIndex: 1 });
    assert.equal(mDoc.balance, 63000.0);
    assert.equal(mDoc.status, 'CREATED');
    assert.equal(mDoc.paidAt, null);

    // Verify IntegrationSync updated
    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 0.0);
    assert.equal(syncDoc.amountInvoicedUnpaid, 63000.0);
    assert.equal(syncDoc.percentageCollected, 0.0);

    // Replay reversal is idempotent
    const repeatRev = await PaymentService.processPaymentReversal({
      paymentId: 'pay_to_reverse',
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });
    assert.equal(repeatRev.status, 'ALREADY_REVERSED');
  });

  // 7. Unknown Invoice Mapping
  test('Scenario 7: Payment referencing unmapped invoice fails safely with UNKNOWN_INVOICE_MAPPING', async () => {
    const mockZoho = createMockZohoClient({
      payments: {
        pay_unmapped: {
          payment_id: 'pay_unmapped',
          amount: 5000.0,
          invoices: [{ invoice_id: 'inv_orphan_99999', amount_applied: 5000.0 }]
        }
      }
    });

    await assert.rejects(
      async () => {
        await PaymentService.processPaymentEvent({
          paymentPayload: { payment_id: 'pay_unmapped' },
          injectedZohoClient: mockZoho
        });
      },
      (err) => {
        assert.equal(err.code, 'UNKNOWN_INVOICE_MAPPING');
        return true;
      }
    );
  });

  // 8. Missing or Invalid Payment Data
  test('Scenario 8: Missing payment_id fails safely with MISSING_PAYMENT_ID', async () => {
    await assert.rejects(
      async () => {
        await PaymentService.processPaymentEvent({
          paymentPayload: {}
        });
      },
      (err) => {
        assert.equal(err.code, 'MISSING_PAYMENT_ID');
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await PaymentService.processPaymentEvent({
          paymentPayload: null
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_PAYMENT_DATA');
        return true;
      }
    );
  });

  // 9. Zoho API Timeout and Retry
  test('Scenario 9: Zoho API timeout during payment verification halts safely without modifying records', async () => {
    const dealId = 'deal_pay_timeout';
    await setupDealWithInvoices(dealId);

    const crashingZoho = createMockZohoClient({ paymentFetchFails: true });

    await assert.rejects(
      async () => {
        await PaymentService.processPaymentEvent({
          paymentPayload: { payment_id: 'pay_timeout_1' },
          injectedZohoClient: crashingZoho
        });
      },
      (err) => {
        assert.equal(err.code, 'ZOHO_PAYMENT_VERIFICATION_FAILED');
        return true;
      }
    );

    // Verify 0 PaymentRecord created
    const pCount = await PaymentRecord.countDocuments({ paymentId: 'pay_timeout_1' });
    assert.equal(pCount, 0);
  });

  // 10. HubSpot Update Failure and Retry
  test('Scenario 10: HubSpot update failure throws, retry succeeds and prevents double counting', async () => {
    const dealId = 'deal_pay_hs_retry';
    await setupDealWithInvoices(dealId);

    const mockZoho = createMockZohoClient({
      payments: {
        pay_hs_retry: {
          payment_id: 'pay_hs_retry',
          amount: 63000.0,
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 63000.0 }]
        }
      },
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 0.0
        }
      }
    });

    const mockHsFailing = createMockHubSpotClient({ updateFails: true });

    // Attempt 1: Fails on HubSpot PATCH
    await assert.rejects(async () => {
      await PaymentService.processPaymentEvent({
        paymentPayload: { payment_id: 'pay_hs_retry' },
        injectedZohoClient: mockZoho,
        injectedHubSpotClient: mockHsFailing
      });
    });

    // Attempt 2: Healthy HubSpot
    const mockHsHealthy = createMockHubSpotClient({ updateFails: false });
    const retryRes = await PaymentService.processPaymentEvent({
      paymentPayload: { payment_id: 'pay_hs_retry' },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHsHealthy
    });

    assert.ok(retryRes);
    const pCount = await PaymentRecord.countDocuments({ paymentId: 'pay_hs_retry' });
    assert.equal(pCount, 1, 'PaymentRecord count must remain exactly 1');

    // Verify HubSpot PATCH was executed during retry recovery
    const patchCall = mockHsHealthy.calls.find((c) => c.method === 'PATCH');
    assert.ok(patchCall, 'HubSpot PATCH must be invoked on retry to recover pending update');
    assert.equal(patchCall.properties.zoho_total_collected_amount, 63000.0);

    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_hs_retry' });
    assert.equal(pDoc.hubspotSynced, true, 'PaymentRecord must be marked hubspotSynced: true');

    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 63000.0);
  });

  // 11. Polling / Reconciliation Fallback
  test('Scenario 11: syncPaymentsForDeal() reconciles payment found directly on Zoho invoice without webhook', async () => {
    const dealId = 'deal_pay_poll';
    await setupDealWithInvoices(dealId);

    const mockZoho = createMockZohoClient({
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 0.0,
          currency_code: 'AED',
          payments: [
            {
              payment_id: 'pay_discovered_via_poll',
              payment_number: 'PAY-POLL-01',
              amount: 63000.0,
              date: '2026-11-06'
            }
          ]
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const syncRes = await PaymentService.syncPaymentsForDeal({
      crmDealId: dealId,
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(syncRes.status, 'SYNCED');
    assert.equal(syncRes.newPaymentsReconciled, 1);

    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_discovered_via_poll' });
    assert.ok(pDoc);
    assert.equal(pDoc.amount, 63000.0);

    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 63000.0);
    assert.equal(syncDoc.percentageCollected, 50.0);

    // Repeated polling is idempotent
    const repeatSync = await PaymentService.syncPaymentsForDeal({
      crmDealId: dealId,
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });
    assert.equal(repeatSync.newPaymentsReconciled, 0);
  });

  // 12. Batch Sync All Active Deals Fallback
  test('Scenario 12: syncAllActiveDeals() evaluates multiple deals and processes payments on-demand', async () => {
    const dealA = 'deal_batch_pay_A';
    const dealB = 'deal_batch_pay_B';
    await setupDealWithInvoices(dealA);
    await setupDealWithInvoices(dealB);

    const mockZoho = createMockZohoClient({
      invoices: {
        [`inv_m1_${dealA}`]: {
          invoice_id: `inv_m1_${dealA}`,
          total: 63000.0,
          balance: 0.0,
          payments: [{ payment_id: 'pay_batch_a', amount: 63000.0 }]
        },
        [`inv_m1_${dealB}`]: {
          invoice_id: `inv_m1_${dealB}`,
          total: 63000.0,
          balance: 33000.0,
          payments: [{ payment_id: 'pay_batch_b', amount: 30000.0 }]
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const batchRes = await PaymentService.syncAllActiveDeals({
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(batchRes.synced, 2);
    assert.equal(batchRes.failed, 0);

    const syncA = await IntegrationSync.findOne({ crmDealId: dealA });
    assert.equal(syncA.amountCollected, 63000.0);

    const syncB = await IntegrationSync.findOne({ crmDealId: dealB });
    assert.equal(syncB.amountCollected, 30000.0);
  });

  // 13. Queue Processing of Zoho Payment Webhook
  test('Scenario 13: processNextQueuedPaymentEvent() processes pending ZOHO_BOOKS webhook from queue', async () => {
    const dealId = 'deal_pay_queue';
    await setupDealWithInvoices(dealId);

    await WebhookEvent.create({
      eventId: 'zoho_pay_evt_queue_99',
      source: 'ZOHO_BOOKS',
      eventType: 'payment_created',
      status: 'RECEIVED',
      payload: {
        payment_id: 'pay_from_queue',
        amount: 63000.0
      }
    });

    const mockZoho = createMockZohoClient({
      payments: {
        pay_from_queue: {
          payment_id: 'pay_from_queue',
          amount: 63000.0,
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 63000.0 }]
        }
      },
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 0.0
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const queueRes = await PaymentService.processNextQueuedPaymentEvent({
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.ok(queueRes);
    assert.equal(queueRes.eventId, 'zoho_pay_evt_queue_99');

    const evtDoc = await WebhookEvent.findOne({ eventId: 'zoho_pay_evt_queue_99' });
    assert.equal(evtDoc.status, 'PROCESSED');
    assert.ok(evtDoc.processedAt);
  });

  // 14. Unknown Payment Information Preserved (Not Fabricated as 0)
  test('Scenario 14: Unknown balance in Zoho Books preserves PAYMENT_INFO_UNAVAILABLE and leaves collected unset', async () => {
    const dealId = 'deal_pay_unknown';
    await setupDealWithInvoices(dealId);

    const mockZoho = createMockZohoClient({
      payments: {
        pay_unknown_bal: {
          payment_id: 'pay_unknown_bal',
          amount: 63000.0,
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 63000.0 }]
        }
      },
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: undefined // Omitted balance
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    await PaymentService.processPaymentEvent({
      paymentPayload: { payment_id: 'pay_unknown_bal' },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    const patchCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.ok(patchCall);
    assert.equal(patchCall.properties.zoho_total_collected_amount, undefined);
    assert.equal(patchCall.properties.zoho_percentage_collected, undefined);
    assert.equal(patchCall.properties.zoho_payment_status, 'PAYMENT_INFO_UNAVAILABLE');

    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.paymentInfoStatus, 'PAYMENT_INFO_UNAVAILABLE');
  });

  // =========================================================================
  // AUDIT AREA 1: PAYMENT REVERSAL LOGIC
  // =========================================================================
  test('Scenario 15A: Partial reversal of AED 10,000 on AED 30,000 payment restores balance to 43,000, leaves invoice PARTIALLY_PAID and status PARTIALLY_REVERSED', async () => {
    const dealId = 'deal_part_rev_test';
    await setupDealWithInvoices(dealId);

    // Initial 30,000 payment on 63,000 invoice (balance 33,000)
    await PaymentRecord.create({
      paymentId: 'pay_rev_multi',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 30000.0,
      amountMinor: 3000000,
      status: 'APPLIED',
      hubspotSynced: true
    });

    await MilestoneInvoice.updateOne(
      { crmDealId: dealId, milestoneIndex: 1 },
      { $set: { balance: 33000.0, status: 'PARTIALLY_PAID' } }
    );

    // Reverse AED 10,000
    const mockZoho = createMockZohoClient({
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 43000.0 // 33k + 10k restored
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const revRes = await PaymentService.processPaymentReversal({
      paymentId: 'pay_rev_multi',
      reversalId: 'rev_alloc_1',
      amount: 10000.0,
      reason: 'Partial reversal of allocation',
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(revRes.success, true);
    assert.equal(revRes.reversals[0].status, 'PARTIALLY_REVERSED');
    assert.equal(revRes.reversals[0].reversedAmount, 10000.0);

    // Verify PaymentRecord
    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_rev_multi' });
    assert.equal(pDoc.status, 'PARTIALLY_REVERSED');
    assert.equal(pDoc.totalReversedMinor, 1000000);
    assert.equal(pDoc.reversals.length, 1);
    assert.equal(pDoc.reversals[0].reversalId, 'rev_alloc_1');
    assert.equal(pDoc.reversals[0].amount, 10000.0);

    // Verify MilestoneInvoice is NOT marked CREATED / fully unpaid
    const mDoc = await MilestoneInvoice.findOne({ crmDealId: dealId, milestoneIndex: 1 });
    assert.equal(mDoc.balance, 43000.0);
    assert.equal(mDoc.status, 'PARTIALLY_PAID', 'Partial reversal must keep invoice PARTIALLY_PAID');

    // Verify IntegrationSync
    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 20000.0); // 30k - 10k
    assert.equal(syncDoc.amountInvoicedUnpaid, 43000.0);
    assert.equal(syncDoc.percentageCollected, 15.87); // 20k / 126k = 15.87%
  });

  test('Scenario 15B: Second partial reversal of AED 20,000 completes full reversal, restores balance to 63,000, and status becomes REVERSED', async () => {
    const dealId = 'deal_part_rev_test_2';
    await setupDealWithInvoices(dealId);

    // Seed partially reversed payment record (10,000 already reversed)
    await PaymentRecord.create({
      paymentId: 'pay_rev_multi_2',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 30000.0,
      amountMinor: 3000000,
      status: 'PARTIALLY_REVERSED',
      totalReversedMinor: 1000000,
      reversals: [
        {
          reversalId: 'rev_alloc_1',
          amount: 10000.0,
          amountMinor: 1000000,
          reversedAt: new Date(),
          reason: 'Initial partial reversal'
        }
      ],
      hubspotSynced: true
    });

    await MilestoneInvoice.updateOne(
      { crmDealId: dealId, milestoneIndex: 1 },
      { $set: { balance: 43000.0, status: 'PARTIALLY_PAID' } }
    );

    // Reverse remaining 20,000
    const mockZoho = createMockZohoClient({
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 63000.0 // fully restored
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const revRes = await PaymentService.processPaymentReversal({
      paymentId: 'pay_rev_multi_2',
      reversalId: 'rev_alloc_2',
      amount: 20000.0,
      reason: 'Final reversal of remainder',
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(revRes.reversals[0].status, 'REVERSED');

    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_rev_multi_2' });
    assert.equal(pDoc.status, 'REVERSED');
    assert.equal(pDoc.totalReversedMinor, 3000000);
    assert.equal(pDoc.reversals.length, 2);

    const mDoc = await MilestoneInvoice.findOne({ crmDealId: dealId, milestoneIndex: 1 });
    assert.equal(mDoc.balance, 63000.0);
    assert.equal(mDoc.status, 'CREATED', 'Full reversal restores invoice to CREATED');

    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 0.0);
    assert.equal(syncDoc.percentageCollected, 0.0);
    assert.equal(syncDoc.amountInvoicedUnpaid, 63000.0);
  });

  test('Scenario 15C: Replaying already-processed reversalId is idempotent and does not restore balance twice', async () => {
    const dealId = 'deal_dup_rev_test';
    await setupDealWithInvoices(dealId);

    await PaymentRecord.create({
      paymentId: 'pay_dup_rev',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 30000.0,
      amountMinor: 3000000,
      status: 'PARTIALLY_REVERSED',
      totalReversedMinor: 1000000,
      reversals: [
        {
          reversalId: 'rev_duplicate_id_99',
          amount: 10000.0,
          amountMinor: 1000000,
          reversedAt: new Date(),
          reason: 'First reversal'
        }
      ],
      hubspotSynced: true
    });

    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient();

    // Replay exact same reversalId
    const res = await PaymentService.processPaymentReversal({
      paymentId: 'pay_dup_rev',
      reversalId: 'rev_duplicate_id_99',
      amount: 10000.0,
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(res.status, 'ALREADY_PROCESSED');
    assert.equal(mockZoho.calls.length, 0, 'Must make zero Zoho API calls on duplicate reversal');
    assert.equal(mockHs.calls.length, 0, 'Must make zero HubSpot calls on duplicate reversal');
  });

  test('Scenario 15D: Reversal amount exceeding active payment balance is rejected with REVERSAL_EXCEEDS_PAYMENT_BALANCE', async () => {
    const dealId = 'deal_rev_excess_test';
    await setupDealWithInvoices(dealId);

    await PaymentRecord.create({
      paymentId: 'pay_excess_rev',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 10000.0,
      amountMinor: 1000000,
      status: 'APPLIED',
      hubspotSynced: true
    });

    await assert.rejects(
      async () => {
        await PaymentService.processPaymentReversal({
          paymentId: 'pay_excess_rev',
          amount: 25000.0 // exceeds 10,000
        });
      },
      (err) => {
        assert.equal(err.code, 'REVERSAL_EXCEEDS_PAYMENT_BALANCE');
        return true;
      }
    );
  });

  // =========================================================================
  // AUDIT AREA 2: REFUND HANDLING (SEPARATE FROM REVERSALS)
  // =========================================================================
  test('Scenario 16A: Partial refund of AED 10,000 reduces collected amount to 20,000, updates invoice balance to 43,000, and marks payment PARTIALLY_REFUNDED', async () => {
    const dealId = 'deal_refund_partial';
    await setupDealWithInvoices(dealId);

    // Initial 30,000 payment on 63,000 invoice (balance 33,000)
    await PaymentRecord.create({
      paymentId: 'pay_to_refund',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 30000.0,
      amountMinor: 3000000,
      status: 'APPLIED',
      hubspotSynced: true
    });

    await MilestoneInvoice.updateOne(
      { crmDealId: dealId, milestoneIndex: 1 },
      { $set: { balance: 33000.0, status: 'PARTIALLY_PAID' } }
    );

    const mockZoho = createMockZohoClient({
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 43000.0
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const refundRes = await PaymentService.processPaymentRefund({
      refundPayload: {
        refund_id: 'ref_001',
        payment_id: 'pay_to_refund',
        amount: 10000.0,
        reason: 'Customer requested partial refund on service reduction'
      },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(refundRes.success, true);
    assert.equal(refundRes.status, 'PARTIALLY_REFUNDED');
    assert.equal(refundRes.amount, 10000.0);

    // Verify PaymentRecord
    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_to_refund' });
    assert.equal(pDoc.status, 'PARTIALLY_REFUNDED');
    assert.equal(pDoc.totalRefundedMinor, 1000000);
    assert.equal(pDoc.refunds.length, 1);
    assert.equal(pDoc.refunds[0].refundId, 'ref_001');
    assert.equal(pDoc.refunds[0].amount, 10000.0);

    // Verify MilestoneInvoice
    const mDoc = await MilestoneInvoice.findOne({ crmDealId: dealId, milestoneIndex: 1 });
    assert.equal(mDoc.balance, 43000.0);
    assert.equal(mDoc.status, 'PARTIALLY_PAID');

    // Verify IntegrationSync
    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 20000.0);
    assert.equal(syncDoc.amountInvoicedUnpaid, 43000.0);
    assert.equal(syncDoc.percentageCollected, 15.87);

    // Verify HubSpot PATCH
    const patchCall = mockHs.calls.find((c) => c.method === 'PATCH');
    assert.ok(patchCall);
    assert.equal(patchCall.properties.zoho_total_collected_amount, 20000.0);
    assert.equal(patchCall.properties.zoho_amount_invoiced_unpaid, 43000.0);
  });

  test('Scenario 16B: Second partial refund of AED 5,000 against same payment further reduces collection to 15,000', async () => {
    const dealId = 'deal_refund_partial_2';
    await setupDealWithInvoices(dealId);

    await PaymentRecord.create({
      paymentId: 'pay_to_refund_2',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 30000.0,
      amountMinor: 3000000,
      status: 'PARTIALLY_REFUNDED',
      totalRefundedMinor: 1000000,
      refunds: [
        {
          refundId: 'ref_001',
          amount: 10000.0,
          amountMinor: 1000000,
          refundDate: new Date(),
          reason: 'First refund'
        }
      ],
      hubspotSynced: true
    });

    await MilestoneInvoice.updateOne(
      { crmDealId: dealId, milestoneIndex: 1 },
      { $set: { balance: 43000.0, status: 'PARTIALLY_PAID' } }
    );

    const mockZoho = createMockZohoClient({
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 48000.0 // 43k + 5k
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const refundRes = await PaymentService.processPaymentRefund({
      refundPayload: {
        refund_id: 'ref_002',
        payment_id: 'pay_to_refund_2',
        amount: 5000.0,
        reason: 'Second partial refund'
      },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(refundRes.status, 'PARTIALLY_REFUNDED');

    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_to_refund_2' });
    assert.equal(pDoc.totalRefundedMinor, 1500000);
    assert.equal(pDoc.refunds.length, 2);

    const syncDoc = await IntegrationSync.findOne({ crmDealId: dealId });
    assert.equal(syncDoc.amountCollected, 15000.0);
    assert.equal(syncDoc.amountInvoicedUnpaid, 48000.0);
  });

  test('Scenario 16C: Duplicate refund event with identical refund_id returns ALREADY_PROCESSED and deduplicates safely', async () => {
    const dealId = 'deal_dup_refund_test';
    await setupDealWithInvoices(dealId);

    await PaymentRecord.create({
      paymentId: 'pay_dup_ref',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 30000.0,
      amountMinor: 3000000,
      status: 'PARTIALLY_REFUNDED',
      totalRefundedMinor: 1000000,
      refunds: [
        {
          refundId: 'ref_unique_777',
          amount: 10000.0,
          amountMinor: 1000000,
          refundDate: new Date()
        }
      ],
      hubspotSynced: true
    });

    const mockZoho = createMockZohoClient();
    const mockHs = createMockHubSpotClient();

    const res = await PaymentService.processPaymentRefund({
      refundPayload: {
        refund_id: 'ref_unique_777',
        payment_id: 'pay_dup_ref',
        amount: 10000.0
      },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(res.status, 'ALREADY_PROCESSED');
    assert.equal(mockZoho.calls.length, 0);
    assert.equal(mockHs.calls.length, 0);
  });

  test('Scenario 16D: Full refund transitions payment status to REFUNDED and restores original invoice balance', async () => {
    const dealId = 'deal_full_refund_test';
    await setupDealWithInvoices(dealId);

    await PaymentRecord.create({
      paymentId: 'pay_full_ref',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 15000.0,
      amountMinor: 1500000,
      status: 'APPLIED',
      hubspotSynced: true
    });

    const mockZoho = createMockZohoClient({
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 63000.0
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    const res = await PaymentService.processPaymentRefund({
      refundPayload: {
        refund_id: 'ref_full_15k',
        payment_id: 'pay_full_ref',
        amount: 15000.0
      },
      injectedZohoClient: mockZoho,
      injectedHubSpotClient: mockHs
    });

    assert.equal(res.status, 'REFUNDED');

    const pDoc = await PaymentRecord.findOne({ paymentId: 'pay_full_ref' });
    assert.equal(pDoc.status, 'REFUNDED');
    assert.equal(pDoc.totalRefundedMinor, 1500000);

    const mDoc = await MilestoneInvoice.findOne({ crmDealId: dealId, milestoneIndex: 1 });
    assert.equal(mDoc.status, 'CREATED');
    assert.equal(mDoc.balance, 63000.0);
  });

  test('Scenario 16E: Refund amount exceeding active payment balance is rejected with REFUND_EXCEEDS_PAYMENT_BALANCE', async () => {
    const dealId = 'deal_excess_refund_test';
    await setupDealWithInvoices(dealId);

    await PaymentRecord.create({
      paymentId: 'pay_excess_ref',
      crmDealId: dealId,
      zohoInvoiceId: `inv_m1_${dealId}`,
      milestoneIndex: 1,
      amount: 10000.0,
      amountMinor: 1000000,
      status: 'APPLIED',
      hubspotSynced: true
    });

    await assert.rejects(
      async () => {
        await PaymentService.processPaymentRefund({
          refundPayload: {
            refund_id: 'ref_excess_999',
            payment_id: 'pay_excess_ref',
            amount: 50000.0
          }
        });
      },
      (err) => {
        assert.equal(err.code, 'REFUND_EXCEEDS_PAYMENT_BALANCE');
        return true;
      }
    );
  });

  // =========================================================================
  // AUDIT AREA 3: ZOHO WEBHOOK AUTHENTICITY AND SECURITY
  // =========================================================================
  test('Scenario 17A: When ZOHO_WEBHOOK_SECRET is set, request with missing token returns HTTP 401 UNAUTHORIZED_ZOHO_WEBHOOK', async () => {
    const originalSecret = process.env.ZOHO_WEBHOOK_SECRET;
    try {
      process.env.ZOHO_WEBHOOK_SECRET = 'valid_secret_12345';

      const res = await request(app)
        .post('/api/webhooks/zoho')
        .send({ payment: { payment_id: 'pay_auth_test_1' } });

      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'UNAUTHORIZED_ZOHO_WEBHOOK');
    } finally {
      if (originalSecret === undefined) {
        delete process.env.ZOHO_WEBHOOK_SECRET;
      } else {
        process.env.ZOHO_WEBHOOK_SECRET = originalSecret;
      }
    }
  });

  test('Scenario 17B: When ZOHO_WEBHOOK_SECRET is set, request with invalid token returns HTTP 401 UNAUTHORIZED_ZOHO_WEBHOOK', async () => {
    const originalSecret = process.env.ZOHO_WEBHOOK_SECRET;
    try {
      process.env.ZOHO_WEBHOOK_SECRET = 'valid_secret_12345';

      const res = await request(app)
        .post('/api/webhooks/zoho')
        .set('x-zoho-webhook-token', 'wrong_token')
        .send({ payment: { payment_id: 'pay_auth_test_2' } });

      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'UNAUTHORIZED_ZOHO_WEBHOOK');
    } finally {
      if (originalSecret === undefined) {
        delete process.env.ZOHO_WEBHOOK_SECRET;
      } else {
        process.env.ZOHO_WEBHOOK_SECRET = originalSecret;
      }
    }
  });

  test('Scenario 17C: When ZOHO_WEBHOOK_SECRET is set, request with valid X-Zoho-Webhook-Token returns HTTP 202', async () => {
    const originalSecret = process.env.ZOHO_WEBHOOK_SECRET;
    try {
      process.env.ZOHO_WEBHOOK_SECRET = 'valid_secret_12345';

      const res = await request(app)
        .post('/api/webhooks/zoho')
        .set('x-zoho-webhook-token', 'valid_secret_12345')
        .send({ payment: { payment_id: 'pay_auth_test_3' } });

      assert.equal(res.status, 202);
      assert.equal(res.body.summary.accepted, 1);
    } finally {
      if (originalSecret === undefined) {
        delete process.env.ZOHO_WEBHOOK_SECRET;
      } else {
        process.env.ZOHO_WEBHOOK_SECRET = originalSecret;
      }
    }
  });

  test('Scenario 17D: Malformed body or missing payment/refund identifier returns HTTP 400 INVALID_WEBHOOK_PAYLOAD', async () => {
    // Malformed body
    const res1 = await request(app)
      .post('/api/webhooks/zoho')
      .send({});
    assert.equal(res1.status, 400);
    assert.equal(res1.body.error, 'INVALID_WEBHOOK_PAYLOAD');

    // Missing payment/refund identifier
    const res2 = await request(app)
      .post('/api/webhooks/zoho')
      .send({ event_type: 'random_event', data: { foo: 'bar' } });
    assert.equal(res2.status, 400);
    assert.equal(res2.body.error, 'INVALID_WEBHOOK_PAYLOAD');
  });

  // =========================================================================
  // AUDIT AREA 4: PAYMENT AGGREGATION AND FINANCIAL CALCULATIONS
  // =========================================================================
  test('Scenario 18A: Reconcile exact Scenarios A, B, and C against AED 120k subtotal / 6k VAT / 126k gross contract', async () => {
    const dealId = 'deal_reconcile_abc';
    await setupDealWithInvoices(dealId); // M1: 63,000 gross, contract: 126,000 gross

    const { calculateAggregateFinancialMetrics } = require('../server/src/services/orchestrationService');

    // Scenario A: No payment
    const metricsA = await calculateAggregateFinancialMetrics(dealId, 126000.0);
    assert.equal(metricsA.amountCollected, 0.0, 'Scenario A: Collected must be 0');
    assert.equal(metricsA.amountInvoicedUnpaid, 63000.0, 'Scenario A: Outstanding must be 63,000');
    assert.equal(metricsA.percentageCollected, 0.0, 'Scenario A: Collection percentage must be 0%');
    assert.equal(metricsA.paymentStatus, 'UNPAID');

    // Scenario B: AED 30,000 payment
    await MilestoneInvoice.updateOne(
      { crmDealId: dealId, milestoneIndex: 1 },
      { $set: { balance: 33000.0, status: 'PARTIALLY_PAID' } }
    );
    const metricsB = await calculateAggregateFinancialMetrics(dealId, 126000.0);
    assert.equal(metricsB.amountCollected, 30000.0, 'Scenario B: Collected must be 30,000');
    assert.equal(metricsB.amountInvoicedUnpaid, 33000.0, 'Scenario B: Outstanding must be 33,000');
    assert.equal(metricsB.percentageCollected, 23.81, 'Scenario B: Collection percentage must be 23.81% (30k / 126k)');
    assert.equal(metricsB.paymentStatus, 'PARTIALLY_PAID');

    // Scenario C: Additional AED 33,000 payment
    await MilestoneInvoice.updateOne(
      { crmDealId: dealId, milestoneIndex: 1 },
      { $set: { balance: 0.0, status: 'PAID' } }
    );
    const metricsC = await calculateAggregateFinancialMetrics(dealId, 126000.0);
    assert.equal(metricsC.amountCollected, 63000.0, 'Scenario C: Total collected must be 63,000');
    assert.equal(metricsC.amountInvoicedUnpaid, 0.0, 'Scenario C: Outstanding must be 0');
    assert.equal(metricsC.percentageCollected, 50.0, 'Scenario C: Collection percentage must be 50.0% (63k / 126k)');
    assert.equal(metricsC.paymentStatus, 'PAID');
  });

  test('Scenario 18B: Multi-currency aggregation without exchange rate conversion throws CURRENCY_MISMATCH', async () => {
    const dealId = 'deal_currency_mismatch';
    const { sync } = await setupDealWithInvoices(dealId);

    // Create an invoice with USD currency
    await MilestoneInvoice.create({
      crmDealId: dealId,
      syncId: sync._id,
      milestoneIndex: 2,
      milestoneName: 'Go-Live',
      percentage: 30,
      subtotal: 10000.0,
      taxAmount: 500.0,
      totalAmount: 10500.0,
      balance: 10500.0,
      zohoInvoiceId: `inv_usd_${dealId}`,
      currencyCode: 'USD',
      status: 'CREATED'
    });

    const { calculateAggregateFinancialMetrics } = require('../server/src/services/orchestrationService');

    await assert.rejects(
      async () => {
        await calculateAggregateFinancialMetrics(dealId, 126000.0);
      },
      (err) => {
        assert.equal(err.code, 'CURRENCY_MISMATCH');
        return true;
      }
    );
  });

  test('Scenario 18C: Negative balance safeguard floors outstanding invoiced amount at zero', async () => {
    const dealId = 'deal_neg_balance';
    await setupDealWithInvoices(dealId);

    // If an external system pushed a negative balance
    await MilestoneInvoice.updateOne(
      { crmDealId: dealId, milestoneIndex: 1 },
      { $set: { balance: -100.0 } }
    );

    const { calculateAggregateFinancialMetrics } = require('../server/src/services/orchestrationService');
    const metrics = await calculateAggregateFinancialMetrics(dealId, 126000.0);
    assert.ok(metrics.amountInvoicedUnpaid >= 0, 'Outstanding invoiced amount must never be negative');
  });

  // =========================================================================
  // AUDIT AREA 5: DISTRIBUTED LEASE LOCKING & FENCING GUARD
  // =========================================================================
  test('Scenario 19: Preempted worker with expired lease fails with FENCING_GUARD_VIOLATION during payment processing', async () => {
    const dealId = 'deal_fencing_pay';
    await setupDealWithInvoices(dealId);

    const mockZoho = createMockZohoClient({
      payments: {
        pay_fence_1: {
          payment_id: 'pay_fence_1',
          amount: 63000.0,
          invoices: [{ invoice_id: `inv_m1_${dealId}`, amount_applied: 63000.0 }]
        }
      },
      invoices: {
        [`inv_m1_${dealId}`]: {
          invoice_id: `inv_m1_${dealId}`,
          total: 63000.0,
          balance: 0.0
        }
      }
    });

    const mockHs = createMockHubSpotClient();

    // Hook into mockZoho request to simulate a lease expiration / preemption by worker B
    const originalRequest = mockZoho.request;
    mockZoho.request = async (params) => {
      if (params.path.startsWith('/invoices/')) {
        // While worker A is waiting for Zoho, worker B preempts the lease
        await IntegrationSync.updateOne(
          { crmDealId: dealId },
          {
            $set: {
              orchestrationLockedBy: 'competing_worker_B',
              orchestrationLeaseExpiresAt: new Date(Date.now() + 60000)
            }
          }
        );
      }
      return originalRequest(params);
    };

    await assert.rejects(
      async () => {
        await PaymentService.processPaymentEvent({
          paymentPayload: { payment_id: 'pay_fence_1' },
          workerId: 'worker_A_stale',
          injectedZohoClient: mockZoho,
          injectedHubSpotClient: mockHs
        });
      },
      (err) => {
        assert.equal(err.code, 'FENCING_GUARD_VIOLATION');
        return true;
      }
    );
  });
});

