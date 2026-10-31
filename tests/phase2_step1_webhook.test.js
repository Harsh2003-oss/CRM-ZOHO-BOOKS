const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const app = require('../server/src/app');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const QueueService = require('../server/src/services/queueService');
const {
  normalizeHubSpotUri,
  generateHubSpotSignatureV3,
  verifyHubSpotSignatureV3,
  getRequestUri
} = require('../server/src/utils/hubspotSignature');

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

// ==============================================================================
// HUBSPOT SIGNATURE V3 SPECIFICATION & SECURITY VERIFICATION TESTS
// ==============================================================================
test.describe('HubSpot Webhook Signature v3 Security & Verification', () => {
  const TEST_SECRET = 'test_app_client_secret_sec_999888777';
  const TEST_HOST = 'api.gateway.example.com';
  const TEST_PROTO = 'https';
  let origSecret;
  let origNodeEnv;

  test.beforeEach(() => {
    origSecret = process.env.HUBSPOT_CLIENT_SECRET;
    origNodeEnv = process.env.NODE_ENV;
    process.env.HUBSPOT_CLIENT_SECRET = TEST_SECRET;
  });

  test.afterEach(() => {
    if (origSecret !== undefined) {
      process.env.HUBSPOT_CLIENT_SECRET = origSecret;
    } else {
      delete process.env.HUBSPOT_CLIENT_SECRET;
    }
    process.env.NODE_ENV = origNodeEnv;
  });

  test('Unit: generateHubSpotSignatureV3 enforces required arguments', () => {
    assert.throws(() => {
      generateHubSpotSignatureV3({ method: 'POST', requestUri: 'https://a.com', timestamp: 123 });
    }, /clientSecret is required/);

    assert.throws(() => {
      generateHubSpotSignatureV3({ method: 'POST', clientSecret: 'secret', timestamp: 123 });
    }, /requestUri is required/);

    assert.throws(() => {
      generateHubSpotSignatureV3({ method: 'POST', requestUri: 'https://a.com', clientSecret: 'secret' });
    }, /timestamp is required/);
  });

  // --------------------------------------------------------------------------
  // REQUIREMENT 1: HUBSPOT URL NORMALIZATION TESTS
  // --------------------------------------------------------------------------
  test('Unit: normalizeHubSpotUri decodes all 12 specified characters (both upper and lower case) in path and query', () => {
    // Exact 12 characters specified by HubSpot Signature v3 specification:
    // %2F (/), %3A (:), %3F (?), %40 (@), %21 (!), %24 ($), %27 ('), %28 ((), %29 ()), %2A (*), %2C (,), %3B (;)
    const chars = [
      { encUpper: '%2F', encLower: '%2f', expected: '/' },
      { encUpper: '%3A', encLower: '%3a', expected: ':' },
      { encUpper: '%3F', encLower: '%3f', expected: '?' },
      { encUpper: '%40', encLower: '%40', expected: '@' },
      { encUpper: '%21', encLower: '%21', expected: '!' },
      { encUpper: '%24', encLower: '%24', expected: '$' },
      { encUpper: '%27', encLower: '%27', expected: "'" },
      { encUpper: '%28', encLower: '%28', expected: '(' },
      { encUpper: '%29', encLower: '%29', expected: ')' },
      { encUpper: '%2A', encLower: '%2a', expected: '*' },
      { encUpper: '%2C', encLower: '%2c', expected: ',' },
      { encUpper: '%3B', encLower: '%3b', expected: ';' }
    ];

    for (const { encUpper, encLower, expected } of chars) {
      // Test in path
      const pathUpper = `https://api.example.com/webhook${encUpper}target`;
      const pathLower = `https://api.example.com/webhook${encLower}target`;
      assert.equal(normalizeHubSpotUri(pathUpper), `https://api.example.com/webhook${expected}target`, `Failed for ${encUpper} in path`);
      assert.equal(normalizeHubSpotUri(pathLower), `https://api.example.com/webhook${expected}target`, `Failed for ${encLower} in path`);

      // Test in query string
      const queryUpper = `https://api.example.com/webhook?param=${encUpper}`;
      const queryLower = `https://api.example.com/webhook?param=${encLower}`;
      assert.equal(normalizeHubSpotUri(queryUpper), `https://api.example.com/webhook?param=${expected}`, `Failed for ${encUpper} in query`);
      assert.equal(normalizeHubSpotUri(queryLower), `https://api.example.com/webhook?param=${expected}`, `Failed for ${encLower} in query`);
    }
  });

  test('Unit: normalizeHubSpotUri preserves unrelated percent-encodings and query parameter order', () => {
    // %20 (space), %23 (#), %25 (%), %26 (&), %3D (=) must NOT be decoded or altered
    const rawUri = 'https://api.example.com/api/webhooks/hubspot?search=hello%20world&code=%23tag&pct=100%25&a=1&b=2';
    const normalized = normalizeHubSpotUri(rawUri);
    assert.equal(normalized, rawUri);

    // Mixed URI with both HubSpot specified chars and unrelated encodings
    const mixedUri = 'https://api.example.com/api/webhooks/hubspot/v1%2Fdeal?label=won%3Averified&msg=hello%20world&tag=%40urgent';
    const expectedMixed = 'https://api.example.com/api/webhooks/hubspot/v1/deal?label=won:verified&msg=hello%20world&tag=@urgent';
    assert.equal(normalizeHubSpotUri(mixedUri), expectedMixed);
  });

  // --------------------------------------------------------------------------
  // REQUIREMENT 3: INDEPENDENT TEST VECTORS (HARDCODED DIGESTS)
  // --------------------------------------------------------------------------
  test('Unit: Independent Test Vector 1 - matches hardcoded HMAC-SHA256 Base64 digest', () => {
    // Exact independent parameters:
    const method = 'POST';
    const fullUri = 'https://api.crmgateway.example.com/api/webhooks/hubspot?dealId=360608312029&env=production';
    const rawBody = '[{"eventId":"hs_test_vec_001","subscriptionType":"deal.propertyChange","objectId":"360608312029","propertyName":"dealstage","propertyValue":"closedwon","occurredAt":1730400000000}]';
    const timestamp = '1730400000000';
    const clientSecret = 'test-hubspot-client-secret-vector-key-777';

    // Hardcoded expected HMAC-SHA256 Base64 digest independently computed:
    // source = method + fullUri + rawBody + timestamp (length: 287 chars)
    // HMAC-SHA256(source, clientSecret) -> Base64
    const HARDCODED_EXPECTED_DIGEST = '8IjPSEr2cAH8VTOwcJJ+5FzEM5SCq5KXDCD64too1ro=';

    const computed = generateHubSpotSignatureV3({
      method,
      requestUri: fullUri,
      requestBody: rawBody,
      timestamp,
      clientSecret
    });

    assert.equal(computed, HARDCODED_EXPECTED_DIGEST, 'generateHubSpotSignatureV3 output must match hardcoded test vector 1');

    // Also verify verifyHubSpotSignatureV3 passes with the hardcoded digest
    const verification = verifyHubSpotSignatureV3({
      method,
      requestUri: fullUri,
      requestBody: rawBody,
      timestamp,
      signature: HARDCODED_EXPECTED_DIGEST,
      clientSecret,
      now: 1730400000000
    });
    assert.equal(verification.valid, true);
  });

  test('Unit: Independent Test Vector 2 - matches hardcoded digest with percent-encoding normalization', () => {
    // Test vector with %2F (/), %3A (:), and %40 (@) in raw URI
    const method = 'POST';
    const rawUriWithPercentEncodings = 'https://api.crmgateway.example.com/api/webhooks/hubspot/v1%2Fdeal?status=won%3Averified&tag=%40urgent';
    const rawBody = '[{"id":1}]';
    const timestamp = '1730400050000';
    const clientSecret = 'test-hubspot-client-secret-vector-key-777';

    // Hardcoded expected HMAC-SHA256 Base64 digest independently computed against normalized URI:
    // normalized URI: 'https://api.crmgateway.example.com/api/webhooks/hubspot/v1/deal?status=won:verified&tag=@urgent'
    // source: 'POSThttps://api.crmgateway.example.com/api/webhooks/hubspot/v1/deal?status=won:verified&tag=@urgent[{"id":1}]1730400050000'
    const HARDCODED_EXPECTED_DIGEST_2 = '1trSD5Y3dUBzdDJjZ0Ccy75f51fVd/7TnuANs5uF550=';

    const computed = generateHubSpotSignatureV3({
      method,
      requestUri: rawUriWithPercentEncodings,
      requestBody: rawBody,
      timestamp,
      clientSecret
    });

    assert.equal(computed, HARDCODED_EXPECTED_DIGEST_2, 'generateHubSpotSignatureV3 must normalize encoded URI and match hardcoded vector 2');

    const verification = verifyHubSpotSignatureV3({
      method,
      requestUri: rawUriWithPercentEncodings,
      requestBody: rawBody,
      timestamp,
      signature: HARDCODED_EXPECTED_DIGEST_2,
      clientSecret,
      now: 1730400050000
    });
    assert.equal(verification.valid, true);
  });

  test('Unit: verifyHubSpotSignatureV3 verifies genuine signatures and rejects mismatches', () => {
    const timestamp = Date.now();
    const uri = 'https://example.com/api/webhooks/hubspot';
    const body = '{"test":123}';
    const sig = generateHubSpotSignatureV3({
      method: 'POST',
      requestUri: uri,
      requestBody: body,
      timestamp,
      clientSecret: TEST_SECRET
    });

    // Valid
    const validResult = verifyHubSpotSignatureV3({
      method: 'POST',
      requestUri: uri,
      requestBody: body,
      timestamp,
      signature: sig,
      clientSecret: TEST_SECRET,
      now: timestamp
    });
    assert.equal(validResult.valid, true);

    // Invalid signature
    const invalidResult = verifyHubSpotSignatureV3({
      method: 'POST',
      requestUri: uri,
      requestBody: body,
      timestamp,
      signature: 'bad_signature_hash==',
      clientSecret: TEST_SECRET,
      now: timestamp
    });
    assert.equal(invalidResult.valid, false);
    assert.equal(invalidResult.error, 'INVALID_SIGNATURE');
  });

  test('POST /api/webhooks/hubspot: Accepts valid Signature v3 and persists event with HTTP 202', async () => {
    const timestamp = Date.now();
    const path = '/api/webhooks/hubspot';
    const fullUri = `${TEST_PROTO}://${TEST_HOST}${path}`;
    const payload = [
      {
        eventId: 'signed_v3_01',
        subscriptionType: 'deal.propertyChange',
        objectId: '99001122',
        propertyName: 'dealstage',
        propertyValue: 'closedwon',
        occurredAt: timestamp
      }
    ];
    const rawBody = JSON.stringify(payload);
    const signature = generateHubSpotSignatureV3({
      method: 'POST',
      requestUri: fullUri,
      requestBody: rawBody,
      timestamp,
      clientSecret: TEST_SECRET
    });

    const res = await request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', signature)
      .set('X-HubSpot-Request-Timestamp', String(timestamp))
      .set('Content-Type', 'application/json')
      .send(rawBody);

    assert.equal(res.status, 202);
    assert.equal(res.body.success, true);
    assert.equal(res.body.summary.accepted, 1);

    const stored = await WebhookEvent.findOne({ eventId: 'hs_signed_v3_01' });
    assert.ok(stored);
    assert.equal(stored.status, 'RECEIVED');
  });

  test('POST /api/webhooks/hubspot: Rejects request missing X-HubSpot-Signature-v3 header with HTTP 401', async () => {
    const timestamp = Date.now();
    const path = '/api/webhooks/hubspot';
    const payload = [{ eventId: 'missing_sig', propertyValue: 'closedwon' }];

    const res = await request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Request-Timestamp', String(timestamp))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
  });

  test('POST /api/webhooks/hubspot: Rejects request missing X-HubSpot-Request-Timestamp header with HTTP 401', async () => {
    const path = '/api/webhooks/hubspot';
    const payload = [{ eventId: 'missing_ts', propertyValue: 'closedwon' }];

    const res = await request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', 'some_sig==')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
  });

  test('POST /api/webhooks/hubspot: Rejects request with malformed non-numeric timestamp with HTTP 401', async () => {
    const path = '/api/webhooks/hubspot';
    const payload = [{ eventId: 'bad_ts', propertyValue: 'closedwon' }];

    const res = await request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', 'some_sig==')
      .set('X-HubSpot-Request-Timestamp', 'not-a-numeric-timestamp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
  });

  test('POST /api/webhooks/hubspot: Rejects expired timestamp (> 300,000ms ago) with HTTP 401 (Replay Attack Prevention)', async () => {
    const expiredTimestamp = Date.now() - 350000; // > 5 min ago
    const path = '/api/webhooks/hubspot';
    const fullUri = `${TEST_PROTO}://${TEST_HOST}${path}`;
    const payload = [{ eventId: 'expired_ts_01', propertyValue: 'closedwon' }];
    const rawBody = JSON.stringify(payload);

    const signature = generateHubSpotSignatureV3({
      method: 'POST',
      requestUri: fullUri,
      requestBody: rawBody,
      timestamp: expiredTimestamp,
      clientSecret: TEST_SECRET
    });

    const res = await request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', signature)
      .set('X-HubSpot-Request-Timestamp', String(expiredTimestamp))
      .set('Content-Type', 'application/json')
      .send(rawBody);

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
    assert.match(res.body.message, /outside the allowable freshness window/);
  });

  test('POST /api/webhooks/hubspot: Rejects future timestamp (> 300,000ms ahead) with HTTP 401', async () => {
    const futureTimestamp = Date.now() + 350000; // > 5 min ahead
    const path = '/api/webhooks/hubspot';
    const fullUri = `${TEST_PROTO}://${TEST_HOST}${path}`;
    const payload = [{ eventId: 'future_ts_01', propertyValue: 'closedwon' }];
    const rawBody = JSON.stringify(payload);

    const signature = generateHubSpotSignatureV3({
      method: 'POST',
      requestUri: fullUri,
      requestBody: rawBody,
      timestamp: futureTimestamp,
      clientSecret: TEST_SECRET
    });

    const res = await request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', signature)
      .set('X-HubSpot-Request-Timestamp', String(futureTimestamp))
      .set('Content-Type', 'application/json')
      .send(rawBody);

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
  });

  test('POST /api/webhooks/hubspot: Rejects invalid signature hash with HTTP 401', async () => {
    const timestamp = Date.now();
    const path = '/api/webhooks/hubspot';
    const payload = [{ eventId: 'tampered_sig', propertyValue: 'closedwon' }];
    const rawBody = JSON.stringify(payload);

    const res = await request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', 'invalidsignaturebase64digest==')
      .set('X-HubSpot-Request-Timestamp', String(timestamp))
      .set('Content-Type', 'application/json')
      .send(rawBody);

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
  });

  test('POST /api/webhooks/hubspot: Rejects altered payload body with HTTP 401', async () => {
    const timestamp = Date.now();
    const path = '/api/webhooks/hubspot';
    const fullUri = `${TEST_PROTO}://${TEST_HOST}${path}`;

    const originalPayload = [{ eventId: 'original_evt', amount: 1000 }];
    const tamperedPayload = [{ eventId: 'original_evt', amount: 999999 }];

    // Signature calculated for original payload
    const signature = generateHubSpotSignatureV3({
      method: 'POST',
      requestUri: fullUri,
      requestBody: JSON.stringify(originalPayload),
      timestamp,
      clientSecret: TEST_SECRET
    });

    // Attacker sends tampered payload with original signature
    const res = await request(app)
      .post(path)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', signature)
      .set('X-HubSpot-Request-Timestamp', String(timestamp))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(tamperedPayload));

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
  });

  test('POST /api/webhooks/hubspot: Rejects altered URL or query parameters with HTTP 401', async () => {
    const timestamp = Date.now();
    const basePath = '/api/webhooks/hubspot';
    // Signature calculated for URL with query param
    const signedUri = `${TEST_PROTO}://${TEST_HOST}${basePath}?verified=true`;
    const payload = [{ eventId: 'url_test', propertyValue: 'closedwon' }];
    const rawBody = JSON.stringify(payload);

    const signature = generateHubSpotSignatureV3({
      method: 'POST',
      requestUri: signedUri,
      requestBody: rawBody,
      timestamp,
      clientSecret: TEST_SECRET
    });

    // Request sent to different URL (without query param)
    const res = await request(app)
      .post(basePath)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', signature)
      .set('X-HubSpot-Request-Timestamp', String(timestamp))
      .set('Content-Type', 'application/json')
      .send(rawBody);

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
  });

  test('POST /api/webhooks/hubspot: Fails closed with HTTP 503 if secret missing in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.HUBSPOT_CLIENT_SECRET;
    delete process.env.HUBSPOT_WEBHOOK_SECRET;

    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify([{ eventId: 'prod_test' }]));

    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'SECURITY_CONFIG_ERROR');
  });

  test('POST /api/webhooks/hubspot: Accepts request with independently computed HMAC and percent-encoded characters in URL', async () => {
    const timestamp = Date.now();
    // Path and query containing %3A (:) and %40 (@)
    const rawPath = '/api/webhooks/hubspot?tag=%40urgent&stage=won%3Averified';
    const normalizedUri = `${TEST_PROTO}://${TEST_HOST}/api/webhooks/hubspot?tag=@urgent&stage=won:verified`;
    const payload = [{ eventId: 'encoded_uri_01', propertyValue: 'closedwon' }];
    const rawBody = JSON.stringify(payload);

    // Compute signature INDEPENDENTLY using core node crypto (without generateHubSpotSignatureV3)
    const independentSource = `POST${normalizedUri}${rawBody}${timestamp}`;
    const independentSignature = crypto
      .createHmac('sha256', TEST_SECRET)
      .update(independentSource, 'utf8')
      .digest('base64');

    const res = await request(app)
      .post(rawPath)
      .set('Host', TEST_HOST)
      .set('X-Forwarded-Proto', TEST_PROTO)
      .set('X-HubSpot-Signature-v3', independentSignature)
      .set('X-HubSpot-Request-Timestamp', String(timestamp))
      .set('Content-Type', 'application/json')
      .send(rawBody);

    assert.equal(res.status, 202);
    assert.equal(res.body.success, true);
    assert.equal(res.body.summary.accepted, 1);
  });

  test('Express Reverse-Proxy: Untrusted proxy ignores spoofed X-Forwarded-Proto and rejects forgery', async () => {
    const origTrust = app.get('trust proxy');
    try {
      // Explicitly set trust proxy to false (simulating untrusted direct deployment)
      app.set('trust proxy', false);

      const timestamp = Date.now();
      const path = '/api/webhooks/hubspot';
      const payload = [{ eventId: 'untrusted_proxy_01', propertyValue: 'closedwon' }];
      const rawBody = JSON.stringify(payload);

      // Client signs for https, but connects to unencrypted http port with spoofed X-Forwarded-Proto: https
      const spoofedSignature = generateHubSpotSignatureV3({
        method: 'POST',
        requestUri: `https://${TEST_HOST}${path}`,
        requestBody: rawBody,
        timestamp,
        clientSecret: TEST_SECRET
      });

      const res = await request(app)
        .post(path)
        .set('Host', TEST_HOST)
        .set('X-Forwarded-Proto', 'https')
        .set('X-HubSpot-Signature-v3', spoofedSignature)
        .set('X-HubSpot-Request-Timestamp', String(timestamp))
        .set('Content-Type', 'application/json')
        .send(rawBody);

      // Because proxy is untrusted, Express evaluates protocol as 'http', causing signature verification to fail (401)
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'UNAUTHORIZED_HUBSPOT_WEBHOOK');
    } finally {
      app.set('trust proxy', origTrust);
    }
  });
});

