const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const CustomerMapping = require('../server/src/models/CustomerMapping');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const PaymentRecord = require('../server/src/models/PaymentRecord');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationLog = require('../server/src/models/IntegrationLog');

let mongoServer;

describe('Phase 6: Seed Dataset Verification & Idempotency', () => {
  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGODB_URI = uri;
  });

  after(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  test('Seed script populates >= 15 customers and >= 20 deals with verified financial metrics', async () => {
    const seed = require('../scripts/seedDataset');
    await seed();

    // Reconnect to in-memory db for assertions
    await mongoose.connect(process.env.MONGODB_URI);

    const customerCount = await CustomerMapping.countDocuments();
    assert.ok(customerCount >= 15, `Expected >= 15 customers, found ${customerCount}`);

    const dealCount = await IntegrationSync.countDocuments();
    assert.ok(dealCount >= 20, `Expected >= 20 deals, found ${dealCount}`);

    const invoiceCount = await MilestoneInvoice.countDocuments();
    assert.ok(invoiceCount > 0, 'Expected seeded milestone invoices');

    const paymentCount = await PaymentRecord.countDocuments();
    assert.ok(paymentCount > 0, 'Expected seeded payment records');

    // Verify Deal 1 (Falcon HyperTech: AED 120k subtotal + 5% VAT = 126k gross)
    const deal1 = await IntegrationSync.findOne({ crmDealId: 'crm_demo_deal_001' });
    assert.ok(deal1, 'Deal 1 must exist');
    assert.equal(deal1.salesOrderTotal, 126000);
    assert.equal(deal1.totalInvoicedAmount, 100800); // M1 (63k) + M2 (37.8k)
    assert.equal(deal1.amountCollected, 63000);     // M1 paid
    assert.equal(deal1.amountInvoicedUnpaid, 37800); // M2 unpaid
    assert.equal(deal1.amountNotInvoiced, 25200);   // M3 not yet invoiced
    assert.equal(deal1.percentageInvoiced, 80);
    assert.equal(deal1.percentageCollected, 50);

    // Verify Deal 2 (Fully Invoiced & Fully Paid)
    const deal2 = await IntegrationSync.findOne({ crmDealId: 'crm_demo_deal_002' });
    assert.ok(deal2);
    assert.equal(deal2.totalInvoicedAmount, 126000);
    assert.equal(deal2.amountCollected, 126000);
    assert.equal(deal2.amountInvoicedUnpaid, 0);
    assert.equal(deal2.amountNotInvoiced, 0);
    assert.equal(deal2.percentageInvoiced, 100);
    assert.equal(deal2.percentageCollected, 100);

    // Verify Exception Deals exist
    const ambiguousDeal = await IntegrationSync.findOne({ crmDealId: 'crm_demo_deal_021' });
    assert.equal(ambiguousDeal.syncStatus, 'REQUIRES_MANUAL_MATCH');

    const reconcileDeal = await IntegrationSync.findOne({ crmDealId: 'crm_demo_deal_022' });
    assert.equal(reconcileDeal.syncStatus, 'RECONCILIATION_REQUIRED');

    const failedHubspotDeal = await IntegrationSync.findOne({ crmDealId: 'crm_demo_deal_023' });
    assert.equal(failedHubspotDeal.syncStatus, 'HUBSPOT_SYNC_FAILED');

    // Verify Ambiguous Customer Mapping exists with candidateMatches
    const ambiguousCustomer = await CustomerMapping.findOne({ status: 'AMBIGUOUS' });
    assert.ok(ambiguousCustomer, 'Must seed at least one AMBIGUOUS customer');
    assert.ok(ambiguousCustomer.candidateMatches.length >= 2, 'Must have at least 2 candidates');

    await mongoose.disconnect();
  });

  test('Running seed script a second time is 100% idempotent without duplicate key errors', async () => {
    const seed = require('../scripts/seedDataset');
    // Execute seed second time
    await seed();

    await mongoose.connect(process.env.MONGODB_URI);

    const customerCount = await CustomerMapping.countDocuments();
    assert.equal(customerCount, 16, 'Customer count must remain exactly 16 after second run');

    const dealCount = await IntegrationSync.countDocuments();
    assert.equal(dealCount, 23, 'Deal count must remain exactly 23 after second run');

    await mongoose.disconnect();
  });

  test('Seed script throws error and blocks execution if NODE_ENV is production without override', async () => {
    const seed = require('../scripts/seedDataset');
    const oldEnv = process.env.NODE_ENV;
    const oldAllow = process.env.ALLOW_PRODUCTION_SEED;
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_PRODUCTION_SEED;

    try {
      await assert.rejects(
        async () => {
          await seed();
        },
        /Seeding is blocked in production environment/
      );
    } finally {
      process.env.NODE_ENV = oldEnv;
      if (oldAllow) process.env.ALLOW_PRODUCTION_SEED = oldAllow;
    }
  });
});

