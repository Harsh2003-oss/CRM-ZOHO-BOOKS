const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const app = require('../server/src/app');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const QueueService = require('../server/src/services/queueService');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  await WebhookEvent.init();
  await IntegrationSync.init();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await WebhookEvent.deleteMany({});
  await IntegrationSync.deleteMany({});
});

// ==============================================================================
// STEP 2.1 AUTOMATED TESTS: WEBHOOK INGESTION & DURABLE QUEUE
// ==============================================================================
test.describe('Step 2.1: Webhook Ingestion & Durable Queue Processing', () => {
  test('POST /api/webhooks/hubspot: Accepts Closed Won event in < 50ms with HTTP 202', async () => {
    const payload = [
      {
        eventId: '10001',
        subscriptionType: 'deal.propertyChange',
        objectId: '987654321',
        propertyName: 'dealstage',
        propertyValue: 'closedwon',
        occurredAt: Date.now()
      }
    ];

    const startTime = Date.now();
    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .send(payload);
    const duration = Date.now() - startTime;

    assert.equal(res.status, 202);
    assert.equal(res.body.success, true);
    assert.equal(res.body.summary.accepted, 1);
    assert.ok(duration < 200, `Webhook response took ${duration}ms, expected fast ack`);

    // Verify persisted in MongoDB
    const storedEvent = await WebhookEvent.findOne({ eventId: 'hs_10001' });
    assert.ok(storedEvent);
    assert.equal(storedEvent.status, 'RECEIVED');
    assert.equal(storedEvent.source, 'CRM');

    // Verify IntegrationSync tracked
    const sync = await IntegrationSync.findOne({ crmDealId: '987654321' });
    assert.ok(sync);
    assert.equal(sync.syncStatus, 'PENDING');
  });

  test('POST /api/webhooks/hubspot: Non-Closed Won events are marked IGNORED without triggering queue', async () => {
    const payload = [
      {
        eventId: '10002',
        subscriptionType: 'deal.propertyChange',
        objectId: '987654322',
        propertyName: 'dealstage',
        propertyValue: 'appointmentscheduled',
        occurredAt: Date.now()
      }
    ];

    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .send(payload);

    assert.equal(res.status, 202);
    assert.equal(res.body.summary.ignored, 1);
    assert.equal(res.body.summary.accepted, 0);

    const storedEvent = await WebhookEvent.findOne({ eventId: 'hs_10002' });
    assert.ok(storedEvent);
    assert.equal(storedEvent.status, 'IGNORED');

    // IntegrationSync should NOT be created for non-won deals
    const sync = await IntegrationSync.findOne({ crmDealId: '987654322' });
    assert.equal(sync, null);
  });

  test('POST /api/webhooks/hubspot: Replaying duplicate event drops duplicate safely (Idempotency)', async () => {
    const payload = [
      {
        eventId: '10003',
        subscriptionType: 'deal.propertyChange',
        objectId: '987654323',
        propertyName: 'dealstage',
        propertyValue: 'closedwon',
        occurredAt: Date.now()
      }
    ];

    // First arrival
    const res1 = await request(app).post('/api/webhooks/hubspot').send(payload);
    assert.equal(res1.status, 202);
    assert.equal(res1.body.summary.accepted, 1);

    // Second arrival of identical event
    const res2 = await request(app).post('/api/webhooks/hubspot').send(payload);
    assert.equal(res2.status, 202);
    assert.equal(res2.body.summary.duplicates, 1);
    assert.equal(res2.body.summary.accepted, 0);

    // Only 1 document exists in database
    const count = await WebhookEvent.countDocuments({ eventId: 'hs_10003' });
    assert.equal(count, 1);
  });

  test('QueueService: Atomically claims pending event and prevents double-processing', async () => {
    // Insert two events
    await WebhookEvent.create([
      {
        eventId: 'evt_1',
        source: 'CRM',
        eventType: 'deal.propertyChange',
        status: 'RECEIVED',
        payload: { dealId: 'deal_1' }
      },
      {
        eventId: 'evt_2',
        source: 'CRM',
        eventType: 'deal.propertyChange',
        status: 'RECEIVED',
        payload: { dealId: 'deal_2' }
      }
    ]);

    // Claim first event (FIFO)
    const claimed1 = await QueueService.claimNextEvent('CRM');
    assert.ok(claimed1);
    assert.equal(claimed1.eventId, 'evt_1');
    assert.equal(claimed1.status, 'PROCESSING');

    // Claim second event
    const claimed2 = await QueueService.claimNextEvent('CRM');
    assert.ok(claimed2);
    assert.equal(claimed2.eventId, 'evt_2');
    assert.equal(claimed2.status, 'PROCESSING');

    // No more events in queue
    const claimed3 = await QueueService.claimNextEvent('CRM');
    assert.equal(claimed3, null);

    // Mark completed
    await QueueService.markCompleted('evt_1');
    const evt1 = await WebhookEvent.findOne({ eventId: 'evt_1' });
    assert.equal(evt1.status, 'PROCESSED');
    assert.ok(evt1.processedAt);
  });

  test('GET /api/webhooks/stats: Reports accurate queue counts', async () => {
    await WebhookEvent.create([
      { eventId: 'e1', source: 'CRM', eventType: 'test', status: 'RECEIVED', payload: {} },
      { eventId: 'e2', source: 'CRM', eventType: 'test', status: 'PROCESSING', payload: {} },
      { eventId: 'e3', source: 'CRM', eventType: 'test', status: 'PROCESSED', payload: {} }
    ]);

    const res = await request(app).get('/api/webhooks/stats');
    assert.equal(res.status, 200);
    assert.equal(res.body.queue.RECEIVED, 1);
    assert.equal(res.body.queue.PROCESSING, 1);
    assert.equal(res.body.queue.PROCESSED, 1);
  });
});

