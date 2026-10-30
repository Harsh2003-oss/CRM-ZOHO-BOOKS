const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const app = require('../server/src/app');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const { TokenBucketRateLimiter } = require('../server/src/utils/rateLimiter');
const { ZohoAuthManager } = require('../server/src/clients/zohoAuthManager');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  // Ensure indexes are built
  await WebhookEvent.init();
  await IntegrationSync.init();
  await MilestoneInvoice.init();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await WebhookEvent.deleteMany({});
  await IntegrationSync.deleteMany({});
  await MilestoneInvoice.deleteMany({});
});

// ==============================================================================
// 1. UNIQUE INDEXES & DUPLICATE PREVENTION
// ==============================================================================
test.describe('1. Duplicate Prevention & Schema Constraints', () => {
  test('WebhookEvent: Replaying identical eventId must fail with duplicate key error', async () => {
    const eventData = {
      eventId: 'evt_crm_test_1001',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      payload: { dealId: 'deal_123', stage: 'closedwon' }
    };

    // First insert succeeds
    const first = await WebhookEvent.create(eventData);
    assert.ok(first._id);

    // Duplicate insert must throw E11000
    await assert.rejects(
      async () => {
        await WebhookEvent.create(eventData);
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('IntegrationSync: Duplicate crmDealId must fail with unique constraint violation', async () => {
    const syncData = {
      crmDealId: 'deal_999',
      dealName: 'Enterprise Deal',
      salesOrderTotal: 120000
    };

    const first = await IntegrationSync.create(syncData);
    assert.ok(first._id);

    await assert.rejects(
      async () => {
        await IntegrationSync.create(syncData);
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  test('MilestoneInvoice: Compound index (crmDealId + milestoneIndex) prevents duplicate milestone invoices', async () => {
    const sync = await IntegrationSync.create({ crmDealId: 'deal_m_test' });

    const invoice1 = {
      crmDealId: 'deal_m_test',
      syncId: sync._id,
      milestoneIndex: 1,
      milestoneName: 'Signing',
      percentage: 50,
      subtotal: 60000,
      totalAmount: 60000
    };

    // First milestone 1 succeeds
    const first = await MilestoneInvoice.create(invoice1);
    assert.ok(first._id);

    // Attempting to create Milestone 1 again for the SAME deal must fail
    await assert.rejects(
      async () => {
        await MilestoneInvoice.create(invoice1);
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );

    // Creating Milestone 2 for the same deal succeeds
    const invoice2 = {
      crmDealId: 'deal_m_test',
      syncId: sync._id,
      milestoneIndex: 2,
      milestoneName: 'Go-Live',
      percentage: 30,
      subtotal: 36000,
      totalAmount: 36000
    };
    const second = await MilestoneInvoice.create(invoice2);
    assert.ok(second._id);
  });
});

// ==============================================================================
// 2. OAUTH REFRESH BEHAVIOR & TOKEN CACHING
// ==============================================================================
test.describe('2. OAuth Refresh Behavior', () => {
  test('Returns cached token when still valid within pre-expiry threshold', async () => {
    const authManager = new ZohoAuthManager();
    let networkCalls = 0;

    // Mock refreshToken method
    authManager.refreshToken = async () => {
      networkCalls++;
      authManager.accessToken = 'mock_access_token_123';
      authManager.expiresAt = Date.now() + 3600 * 1000; // 1 hour
      return authManager.accessToken;
    };

    // First call: triggers refresh
    const token1 = await authManager.getValidAccessToken();
    assert.equal(token1, 'mock_access_token_123');
    assert.equal(networkCalls, 1);

    // Second call: returns cached token without network call
    const token2 = await authManager.getValidAccessToken();
    assert.equal(token2, 'mock_access_token_123');
    assert.equal(networkCalls, 1);
  });

  test('Proactively refreshes when token expires within 5 minutes', async () => {
    const authManager = new ZohoAuthManager();
    let networkCalls = 0;

    authManager.refreshToken = async () => {
      networkCalls++;
      authManager.accessToken = `mock_token_${networkCalls}`;
      authManager.expiresAt = Date.now() + 3600 * 1000;
      return authManager.accessToken;
    };

    await authManager.getValidAccessToken();
    assert.equal(networkCalls, 1);

    // Simulate token expiring in 3 minutes (< 5 minute pre-expiry window)
    authManager.expiresAt = Date.now() + 3 * 60 * 1000;

    const refreshedToken = await authManager.getValidAccessToken();
    assert.equal(refreshedToken, 'mock_token_2');
    assert.equal(networkCalls, 2);
  });

  test('Concurrent requests share a single in-flight refresh promise (mutex locking)', async () => {
    const authManager = new ZohoAuthManager();
    let networkCalls = 0;

    authManager.refreshToken = async () => {
      networkCalls++;
      await new Promise((r) => setTimeout(r, 50));
      authManager.accessToken = 'mock_shared_token';
      authManager.expiresAt = Date.now() + 3600 * 1000;
      return authManager.accessToken;
    };

    // Fire 5 concurrent getValidAccessToken calls
    const results = await Promise.all([
      authManager.getValidAccessToken(),
      authManager.getValidAccessToken(),
      authManager.getValidAccessToken(),
      authManager.getValidAccessToken(),
      authManager.getValidAccessToken()
    ]);

    assert.equal(networkCalls, 1, 'Only 1 network call should occur for concurrent callers');
    results.forEach((token) => assert.equal(token, 'mock_shared_token'));
  });
});

// ==============================================================================
// 3. RATE LIMITING ENGINE
// ==============================================================================
test.describe('3. Rate Limiting Engine', () => {
  test('Token bucket allows instant consumption up to capacity', async () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 5,
      refillRatePerSec: 10,
      name: 'TestLimiter'
    });

    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire(1);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `Consuming within capacity should be instant, took ${elapsed}ms`);
  });

  test('Pausing limiter (simulating HTTP 429) delays subsequent acquisitions', async () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 5,
      refillRatePerSec: 10,
      name: 'PauseTest'
    });

    limiter.pause(100); // Pause for 100ms
    const start = Date.now();
    await limiter.acquire(1);
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 90, `Should wait at least 90ms when paused, took ${elapsed}ms`);
  });
});

// ==============================================================================
// 4. HEALTH CHECK ENDPOINT
// ==============================================================================
test.describe('4. Health Check Endpoint', () => {
  test('GET /api/health returns 503 degraded when a dependency is down', async () => {
    // Disconnect mongoose temporarily
    await mongoose.disconnect();

    const res = await request(app).get('/api/health');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.services.mongodb.status, 'disconnected');

    // Reconnect for next tests
    await mongoose.connect(mongod.getUri());
  });

  test('GET /api/health never reveals passwords or secret connection strings', async () => {
    const res = await request(app).get('/api/health');
    const jsonStr = JSON.stringify(res.body);

    assert.equal(jsonStr.includes('mongodb+srv:'), false, 'Should never leak MONGODB_URI');
    assert.equal(jsonStr.includes('pat-'), false, 'Should never leak HubSpot token');
    assert.equal(jsonStr.includes('ZOHO_CLIENT_SECRET'), false);
  });
});

