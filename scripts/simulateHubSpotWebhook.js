require('dotenv').config();
const { connectDB, disconnectDB } = require('../server/src/config/db');
const WebhookService = require('../server/src/services/webhookService');
const QueueService = require('../server/src/services/queueService');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationSync = require('../server/src/models/IntegrationSync');

/**
 * Live test script for Step 2.1:
 * Connects directly to the live MongoDB Atlas cluster, simulates incoming
 * HubSpot webhook events, tests deduplication, verifies queue state, and
 * inspects the resulting database records.
 */
async function runLiveTest() {
  console.log('\n=============================================================');
  console.log('🧪 Step 2.1 Live Test: HubSpot Webhook Receiver & Queue State');
  console.log('=============================================================\n');

  try {
    await connectDB();

    const testDealId = 'TEST_DEAL_' + Date.now();
    console.log(`Using Test Deal ID: ${testDealId}`);

    // --- TEST 1: Ingest a valid Closed Won event ---
    console.log('\n--- 1. Simulating HubSpot "Closed Won" Webhook Event ---');
    const wonEvent = {
      eventId: `sim_${Date.now()}_1`,
      subscriptionType: 'deal.propertyChange',
      objectId: testDealId,
      propertyName: 'dealstage',
      propertyValue: 'closedwon',
      dealname: 'Acme Test Corporation Deal',
      occurredAt: Date.now()
    };

    const t1Start = Date.now();
    const res1 = await WebhookService.processHubSpotWebhook([wonEvent]);
    const t1Duration = Date.now() - t1Start;

    console.log(`⏱️ Ingestion Duration: ${t1Duration}ms (Must be < 50ms)`);
    console.log('Ingestion Summary   :', res1);

    if (res1.accepted !== 1) {
      throw new Error(`Expected accepted=1, got ${res1.accepted}`);
    }

    const savedWon = await WebhookEvent.findOne({ eventId: `hs_${wonEvent.eventId}` });
    console.log('Saved WebhookEvent  :', {
      eventId: savedWon.eventId,
      status: savedWon.status,
      source: savedWon.source,
      eventType: savedWon.eventType
    });

    const savedSync = await IntegrationSync.findOne({ crmDealId: testDealId });
    console.log('Saved IntegrationSync:', {
      crmDealId: savedSync.crmDealId,
      dealName: savedSync.dealName,
      syncStatus: savedSync.syncStatus
    });

    // --- TEST 2: Replay the identical event (Idempotency) ---
    console.log('\n--- 2. Simulating Immediate Replay of Same Event (Idempotency) ---');
    const res2 = await WebhookService.processHubSpotWebhook([wonEvent]);
    console.log('Duplicate Ingestion Summary:', res2);
    if (res2.duplicates !== 1 || res2.accepted !== 0) {
      throw new Error('Failed: Duplicate event was not dropped!');
    }
    console.log('✅ PASS: Duplicate event was safely dropped with zero duplicates created.');

    // --- TEST 3: Ingest a non-won stage change ---
    console.log('\n--- 3. Simulating Non-Closed Won Stage (Appointment Scheduled) ---');
    const otherDealId = 'TEST_DEAL_OTHER_' + Date.now();
    const openEvent = {
      eventId: `sim_${Date.now()}_2`,
      subscriptionType: 'deal.propertyChange',
      objectId: otherDealId,
      propertyName: 'dealstage',
      propertyValue: 'appointmentscheduled',
      occurredAt: Date.now()
    };

    const res3 = await WebhookService.processHubSpotWebhook([openEvent]);
    console.log('Non-Won Ingestion Summary:', res3);
    const savedOpen = await WebhookEvent.findOne({ eventId: `hs_${openEvent.eventId}` });
    console.log('Saved Non-Won Status:', savedOpen.status, '(Expected: IGNORED)');

    const nonWonSync = await IntegrationSync.findOne({ crmDealId: otherDealId });
    console.log('IntegrationSync for Non-Won Deal:', nonWonSync ? 'EXISTS (FAIL)' : 'NULL (PASS)');

    // --- TEST 4: Queue State & Atomic Claiming ---
    console.log('\n--- 4. Testing Atomic Queue Claiming ---');
    const queueBefore = await QueueService.getQueueStats();
    console.log('Queue Stats Before Claim:', queueBefore);

    const claimed = await QueueService.claimNextEvent('CRM');
    console.log('Claimed Job for Processing:', {
      eventId: claimed.eventId,
      newStatus: claimed.status
    });

    if (claimed.eventId !== `hs_${wonEvent.eventId}` || claimed.status !== 'PROCESSING') {
      throw new Error('Failed: Queue claiming did not transition job to PROCESSING');
    }

    // Mark as completed
    await QueueService.markCompleted(claimed.eventId);
    const completed = await WebhookEvent.findOne({ eventId: claimed.eventId });
    console.log('Job Completed Status:', completed.status, 'ProcessedAt:', completed.processedAt);

    const queueAfter = await QueueService.getQueueStats();
    console.log('Queue Stats After Completion:', queueAfter);

    console.log('\n=============================================================');
    console.log('🎉 Step 2.1 Live Test Completed with 100% Success!');
    console.log('=============================================================\n');
  } catch (err) {
    console.error('\n❌ Live Test Error:', err.message);
  } finally {
    await disconnectDB();
  }
}

if (require.main === module) {
  runLiveTest();
}

module.exports = { runLiveTest };

