const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const QueueService = require('../server/src/services/queueService');
const QueueWorker = require('../server/src/worker');

let mongod;

function createMockHubSpotClient({ dealStage = 'closedwon', dealAmount = 120000.0, failMode = null } = {}) {
  const calls = [];
  return {
    calls,
    getDeal: async (dealId) => {
      calls.push({ method: 'GET', path: `/crm/v3/objects/deals/${dealId}` });
      if (failMode === 'RATE_LIMIT_429') {
        const err = new Error('HubSpot API rate limit exceeded');
        err.statusCode = 429;
        err.code = 'RATE_LIMIT_EXCEEDED';
        throw err;
      }
      if (failMode === 'PERMANENT_400') {
        const err = new Error('Bad request: Deal schema invalid');
        err.statusCode = 400;
        err.isPermanent = true;
        throw err;
      }
      return {
        statusCode: 200,
        data: {
          id: dealId,
          properties: {
            dealname: 'Worker Test Deal',
            dealstage: dealStage,
            amount: dealAmount,
            company: 'NovaTech Industries'
          },
          associations: {
            companies: { results: [{ id: 'comp_worker_test' }] }
          }
        }
      };
    },
    updateDeal: async (dealId, properties) => {
      calls.push({ method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}`, properties });
      return { statusCode: 200, data: { id: dealId, properties } };
    }
  };
}

function createMockZohoClient({ slowDelayMs = 0, taxPercentage = null } = {}) {
  const calls = [];
  return {
    calls,
    request: async ({ method, path, body }) => {
      calls.push({ method, path, body });
      if (slowDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, slowDelayMs));
      }

      const effectiveTaxRate = taxPercentage !== null
        ? Number(taxPercentage)
        : (process.env.VAT_PERCENTAGE !== undefined && process.env.VAT_PERCENTAGE !== '' ? Number(process.env.VAT_PERCENTAGE) : 5.0);

      if (method === 'GET' && path.startsWith('/contacts')) {
        return { statusCode: 200, data: { code: 0, contacts: [] } };
      }
      if (method === 'POST' && path === '/contacts') {
        return { statusCode: 200, data: { code: 0, contact: { contact_id: 'cust_worker_1', contact_name: 'NovaTech' } } };
      }
      if (method === 'GET' && path.startsWith('/salesorders')) {
        return { statusCode: 200, data: { code: 0, salesorders: [] } };
      }
      if (method === 'POST' && path === '/salesorders') {
        const rate = body?.line_items?.[0]?.rate || 120000.0;
        const tax = Number((rate * (effectiveTaxRate / 100)).toFixed(2));
        const total = Number((rate + tax).toFixed(2));
        return {
          statusCode: 200,
          data: {
            code: 0,
            salesorder: {
              salesorder_id: 'so_worker_1',
              salesorder_number: 'SO-WORKER-001',
              reference_number: body.reference_number,
              customer_id: body.customer_id,
              sub_total: rate,
              tax_total: tax,
              total,
              status: 'draft',
              currency_code: 'AED',
              line_items: [{ line_item_id: 'so_item_1', name: 'Software License', rate }]
            }
          }
        };
      }
      if (method === 'POST' && path.includes('/status/confirm')) {
        return { statusCode: 200, data: { code: 0, salesorder: { status: 'confirmed' } } };
      }
      if (method === 'GET' && path.startsWith('/invoices')) {
        return { statusCode: 200, data: { code: 0, invoices: [] } };
      }
      if (method === 'POST' && path === '/invoices') {
        const rate = body?.line_items?.[0]?.rate || 60000.0;
        const tax = Number((rate * (effectiveTaxRate / 100)).toFixed(2));
        const total = Number((rate + tax).toFixed(2));
        return {
          statusCode: 200,
          data: {
            code: 0,
            invoice: {
              invoice_id: 'inv_worker_1',
              invoice_number: 'INV-WORKER-001',
              reference_number: body.reference_number,
              customer_id: body.customer_id,
              salesorder_id: body.salesorder_id,
              sub_total: rate,
              tax_total: tax,
              total,
              status: 'draft',
              due_date: '2026-11-30',
              balance: total,
              currency_code: 'AED',
              line_items: [{ line_item_id: 'inv_item_1', salesorder_item_id: body?.line_items?.[0]?.salesorder_item_id || 'so_item_1', rate, quantity: 1 }]
            }
          }
        };
      }
      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

test.describe('Dedicated Queue Worker Architecture & Safety Controls', () => {
  test.before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  });

  test.after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  test.beforeEach(async () => {
    await WebhookEvent.deleteMany({});
    await IntegrationSync.deleteMany({});
    await CustomerMapping.deleteMany({});
    await MilestoneInvoice.deleteMany({});
  });

  // 1. Worker Disabled by Default
  test('Scenario 1: Worker is disabled by default (WORKER_ENABLED=false) and exits without claiming events', async () => {
    await WebhookEvent.create({
      eventId: 'evt_disabled_test',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: { objectId: 'deal_1' }
    });

    const worker = new QueueWorker({ enabled: false });
    const result = await worker.start();

    assert.equal(result.status, 'STOPPED_PRE_FLIGHT');
    assert.match(result.reason, /disabled by default/i);
    assert.equal(result.processedCount, 0);

    // Event remains untouched in RECEIVED status
    const evt = await WebhookEvent.findOne({ eventId: 'evt_disabled_test' });
    assert.equal(evt.status, 'RECEIVED');
    assert.equal(evt.attempts, 0);
  });

  // 2. Refuses to Start Without Allowlist
  test('Scenario 2: Worker refuses to start when requireAllowlist is true and no allowlist is provided', async () => {
    const worker = new QueueWorker({
      enabled: true,
      requireAllowlist: true,
      allowedEventIds: []
    });

    const result = await worker.start();
    assert.equal(result.status, 'STOPPED_PRE_FLIGHT');
    assert.match(result.reason, /requires an explicit event allowlist/i);
    assert.equal(result.processedCount, 0);
  });

  // 3. Claims Only Allowed Events
  test('Scenario 3: Worker processes only explicitly allowed synthetic events and ignores non-allowed events', async () => {
    await WebhookEvent.create([
      {
        eventId: 'evt_allowed_target',
        source: 'CRM',
        eventType: 'deal.propertyChange',
        status: 'RECEIVED',
        payload: { objectId: 'deal_allowed_100', propertyName: 'dealstage', propertyValue: 'closedwon' }
      },
      {
        eventId: 'evt_disallowed_foreign',
        source: 'CRM',
        eventType: 'deal.propertyChange',
        status: 'RECEIVED',
        payload: { objectId: 'deal_foreign_200', propertyName: 'dealstage', propertyValue: 'closedwon' }
      }
    ]);

    const mockHs = createMockHubSpotClient();
    const mockZoho = createMockZohoClient();

    const worker = new QueueWorker({
      enabled: true,
      requireAllowlist: true,
      allowedEventIds: ['evt_allowed_target'],
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    const runResult = await worker.start({ maxEvents: 1 });
    assert.equal(runResult.status, 'COMPLETED');
    assert.equal(runResult.processedCount, 1);

    const allowedEvt = await WebhookEvent.findOne({ eventId: 'evt_allowed_target' });
    assert.equal(allowedEvt.status, 'PROCESSED');
    assert.equal(allowedEvt.attempts, 1);

    const disallowedEvt = await WebhookEvent.findOne({ eventId: 'evt_disallowed_foreign' });
    assert.equal(disallowedEvt.status, 'RECEIVED');
    assert.equal(disallowedEvt.attempts, 0);
  });

  // 4. Transitions through PROCESSING to PROCESSED
  test('Scenario 4: Claimed event transitions through atomic PROCESSING lease before reaching PROCESSED', async () => {
    await WebhookEvent.create({
      eventId: 'evt_transition_1',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: { objectId: 'deal_trans_1', propertyName: 'dealstage', propertyValue: 'closedwon' }
    });

    // Atomic claim check
    const claimed = await QueueService.claimNextEvent('CRM', {
      workerId: 'worker_alpha_1',
      leaseDurationMs: 60000,
      allowedEventIds: ['evt_transition_1']
    });

    assert.ok(claimed);
    assert.equal(claimed.status, 'PROCESSING');
    assert.equal(claimed.lockedBy, 'worker_alpha_1');
    assert.ok(claimed.leaseExpiresAt > new Date());
    assert.equal(claimed.attempts, 1);

    // Complete event
    await QueueService.markCompleted('evt_transition_1');
    const finalEvt = await WebhookEvent.findOne({ eventId: 'evt_transition_1' });
    assert.equal(finalEvt.status, 'PROCESSED');
    assert.equal(finalEvt.lockedBy, null);
    assert.ok(finalEvt.processedAt);
  });

  // 5. Duplicate Claim Prevention
  test('Scenario 5: Concurrent workers cannot double-claim the same event (Single-Worker Ownership)', async () => {
    await WebhookEvent.create({
      eventId: 'evt_concurrency_lock',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: { objectId: 'deal_conc_1' }
    });

    // Worker A claims event
    const workerAClaim = await QueueService.claimNextEvent('CRM', {
      workerId: 'worker_A',
      allowedEventIds: ['evt_concurrency_lock']
    });
    assert.ok(workerAClaim);
    assert.equal(workerAClaim.lockedBy, 'worker_A');

    // Worker B attempts to claim same event
    const workerBClaim = await QueueService.claimNextEvent('CRM', {
      workerId: 'worker_B',
      allowedEventIds: ['evt_concurrency_lock']
    });
    assert.equal(workerBClaim, null);
  });

  // 6. Retryable Error Handling & Exponential Backoff
  test('Scenario 6: Transient errors (HTTP 429) increment attempts and reschedule event with backoff', async () => {
    await WebhookEvent.create({
      eventId: 'evt_retryable_test',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: { objectId: 'deal_rate_limited' }
    });

    const mockHs = createMockHubSpotClient({ failMode: 'RATE_LIMIT_429' });
    const mockZoho = createMockZohoClient();

    const worker = new QueueWorker({
      enabled: true,
      allowedEventIds: ['evt_retryable_test'],
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho,
      baseRetryDelayMs: 2000,
      maxAttempts: 3
    });

    const result = await worker.processNext();
    assert.equal(result.processed, true);

    const evt = await WebhookEvent.findOne({ eventId: 'evt_retryable_test' });
    assert.equal(evt.status, 'RECEIVED'); // Re-queued for retry
    assert.equal(evt.attempts, 1);
    assert.ok(evt.nextAttemptAfter > new Date());
    assert.match(evt.error, /Retryable Attempt 1\/3/);
  });

  // 7. Permanent Error Handling
  test('Scenario 7: Permanent errors (HTTP 400) immediately mark event FAILED without retry', async () => {
    await WebhookEvent.create({
      eventId: 'evt_permanent_fail',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: { objectId: 'deal_perm_fail' }
    });

    const mockHs = createMockHubSpotClient({ failMode: 'PERMANENT_400' });
    const mockZoho = createMockZohoClient();

    const worker = new QueueWorker({
      enabled: true,
      allowedEventIds: ['evt_permanent_fail'],
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    const result = await worker.processNext();
    assert.equal(result.processed, true);

    const evt = await WebhookEvent.findOne({ eventId: 'evt_permanent_fail' });
    assert.equal(evt.status, 'FAILED');
    assert.equal(evt.attempts, 1);
    assert.match(evt.error, /Permanent Error/);
  });

  // 8. Graceful Shutdown
  test('Scenario 8: Graceful shutdown (worker.stop) awaits completion of in-flight task before exiting', async () => {
    await WebhookEvent.create({
      eventId: 'evt_slow_job',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: { objectId: 'deal_slow_1', propertyName: 'dealstage', propertyValue: 'closedwon' }
    });

    // Zoho mock with 100ms latency
    const mockHs = createMockHubSpotClient();
    const mockZoho = createMockZohoClient({ slowDelayMs: 80 });

    const worker = new QueueWorker({
      enabled: true,
      pollIntervalMs: 50,
      allowedEventIds: ['evt_slow_job'],
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    // Start worker in background
    const startPromise = worker.start();

    // Give it a brief instant to claim the event
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(worker.isProcessing, true);

    // Call stop while task is in-flight
    const stopResult = await worker.stop();
    assert.equal(stopResult.status, 'STOPPED');
    await startPromise;

    // Verify the in-flight job completed cleanly
    const evt = await WebhookEvent.findOne({ eventId: 'evt_slow_job' });
    assert.equal(evt.status, 'PROCESSED');
  });

  // 9. Stale-Job Recovery & Fencing Safeguards
  test('Scenario 9: Stale recovery honors fencing guards and never reclaims an event while orchestration lease is active', async () => {
    const expiredTime = new Date(Date.now() - 60000); // 1 minute ago
    const futureTime = new Date(Date.now() + 60000);  // 1 minute in future

    // Deal A: Event lease is expired, BUT IntegrationSync orchestration lock is ACTIVE
    await IntegrationSync.create({
      crmDealId: 'deal_fenced_active',
      syncStatus: 'PROCESSING',
      orchestrationLockedBy: 'zombie_worker_99',
      orchestrationLeaseExpiresAt: futureTime
    });

    await WebhookEvent.create({
      eventId: 'evt_fenced_skip',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'PROCESSING',
      lockedBy: 'zombie_worker_99',
      leaseExpiresAt: expiredTime,
      attempts: 1,
      payload: { objectId: 'deal_fenced_active' }
    });

    // Deal B: Event lease expired AND IntegrationSync lock is also expired
    await IntegrationSync.create({
      crmDealId: 'deal_fenced_expired',
      syncStatus: 'PENDING',
      orchestrationLockedBy: 'dead_worker_88',
      orchestrationLeaseExpiresAt: expiredTime
    });

    await WebhookEvent.create({
      eventId: 'evt_fenced_reclaim',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'PROCESSING',
      lockedBy: 'dead_worker_88',
      leaseExpiresAt: expiredTime,
      attempts: 1,
      payload: { objectId: 'deal_fenced_expired' }
    });

    const recovery = await QueueService.reclaimStaleProcessingEvents({
      allowedEventIds: ['evt_fenced_skip', 'evt_fenced_reclaim']
    });

    assert.equal(recovery.skippedActiveLease, 1);
    assert.equal(recovery.reclaimed, 1);

    // Event with active transaction lease remains in PROCESSING
    const skippedEvt = await WebhookEvent.findOne({ eventId: 'evt_fenced_skip' });
    assert.equal(skippedEvt.status, 'PROCESSING');

    // Event with expired transaction lease was safely reclaimed to RECEIVED
    const reclaimedEvt = await WebhookEvent.findOne({ eventId: 'evt_fenced_reclaim' });
    assert.equal(reclaimedEvt.status, 'RECEIVED');
    assert.equal(reclaimedEvt.lockedBy, null);
  });

  // 10. Database Isolation Verification
  test('Scenario 10: Test environment strictly operates on local loopback MongoMemoryServer and rejects live database', async () => {
    assert.equal(mongoose.connection.readyState, 1);
    assert.equal(mongoose.connection.host, '127.0.0.1');
    assert.notEqual(mongoose.connection.name, 'crm_zoho_db');
  });

  // 11. Empty Allowlist Fails Closed
  test('Scenario 11: QueueService.claimNextEvent with empty allowedEventIds array fails closed and claims no events', async () => {
    await WebhookEvent.create({
      eventId: 'evt_should_not_be_claimed',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: { objectId: 'deal_fail_closed' }
    });

    const claimed = await QueueService.claimNextEvent('CRM', { allowedEventIds: [] });
    assert.equal(claimed, null);

    const doc = await WebhookEvent.findOne({ eventId: 'evt_should_not_be_claimed' });
    assert.equal(doc.status, 'RECEIVED');
    assert.equal(doc.attempts, 0);
  });

  // 12. Protection of hs_manual_test_01 by Default Without Options or Env
  test('Scenario 12: QueueService.claimNextEvent excludes hs_manual_test_01 by default without any options or env variables', async () => {
    const originalEnv = process.env.WORKER_IGNORE_EVENT_IDS;
    delete process.env.WORKER_IGNORE_EVENT_IDS;

    try {
      // Seed hs_manual_test_01 as the oldest event
      await WebhookEvent.create([
        {
          eventId: 'hs_manual_test_01',
          source: 'CRM',
          eventType: 'deal.propertyChange',
          status: 'RECEIVED',
          payload: { objectId: 'DEAL_MANUAL_100' },
          createdAt: new Date(Date.now() - 10000)
        },
        {
          eventId: 'evt_legitimate_synthetic',
          source: 'CRM',
          eventType: 'deal.propertyChange',
          status: 'RECEIVED',
          payload: { objectId: 'deal_legit_200' },
          createdAt: new Date(Date.now() - 5000)
        }
      ]);

      // Direct call without options or env
      const claimed = await QueueService.claimNextEvent('CRM');
      assert.ok(claimed);
      assert.equal(claimed.eventId, 'evt_legitimate_synthetic');

      // hs_manual_test_01 was completely bypassed and remains untouched
      const protectedDoc = await WebhookEvent.findOne({ eventId: 'hs_manual_test_01' });
      assert.equal(protectedDoc.status, 'RECEIVED');
      assert.equal(protectedDoc.attempts, 0);
    } finally {
      if (originalEnv !== undefined) {
        process.env.WORKER_IGNORE_EVENT_IDS = originalEnv;
      }
    }
  });

  // 13. Explicitly Allowed Synthetic Event Claiming
  test('Scenario 13: QueueService.claimNextEvent with explicit allowedEventIds claims target event and leaves others', async () => {
    await WebhookEvent.create([
      {
        eventId: 'evt_alpha',
        source: 'CRM',
        eventType: 'deal.propertyChange',
        status: 'RECEIVED',
        payload: { objectId: 'deal_a' }
      },
      {
        eventId: 'evt_beta',
        source: 'CRM',
        eventType: 'deal.propertyChange',
        status: 'RECEIVED',
        payload: { objectId: 'deal_b' }
      }
    ]);

    const claimed = await QueueService.claimNextEvent('CRM', {
      allowedEventIds: ['evt_beta']
    });

    assert.ok(claimed);
    assert.equal(claimed.eventId, 'evt_beta');
    assert.equal(claimed.status, 'PROCESSING');

    const alphaDoc = await WebhookEvent.findOne({ eventId: 'evt_alpha' });
    assert.equal(alphaDoc.status, 'RECEIVED');
    assert.equal(alphaDoc.attempts, 0);
  });
});
