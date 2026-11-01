/**
 * scripts/syncNovaTechM1InvoiceToHubSpot.js
 *
 * Targeted sync of confirmed M1 Invoice properties to HubSpot deal 360608312029.
 *
 * Exact properties to PATCH:
 * - zoho_amount_invoiced_unpaid: 60000
 * - zoho_amount_not_invoiced: 60000
 * - zoho_percentage_invoiced: 50
 * - zoho_percentage_collected: 0
 * - zoho_next_due_date: "2026-11-30"
 * - zoho_is_overdue: "false"
 * - integration_sync_status: "M1_INVOICED"
 * - integration_milestone_stage: "M1_INVOICED"
 *
 * Safety Rules:
 * - Zero calls to Zoho Books.
 * - Does NOT modify dealstage or amount.
 * - Does NOT create invoices, payments, or other records.
 * - Does NOT start worker or process queues.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { hubspotClient } = require('../server/src/clients/hubspotClient');
const { updateHubSpotDealWithRetry } = require('../server/src/services/orchestrationService');
const { connectDB, disconnectDB } = require('../server/src/config/db');
const IntegrationSync = require('../server/src/models/IntegrationSync');

const DEAL_ID = '360608312029';

const TARGET_PAYLOAD = {
  zoho_amount_invoiced_unpaid: 60000,
  zoho_amount_not_invoiced: 60000,
  zoho_percentage_invoiced: 50,
  zoho_percentage_collected: 0,
  zoho_next_due_date: '2026-11-30',
  zoho_is_overdue: 'false',
  integration_sync_status: 'M1_INVOICED',
  integration_milestone_stage: 'M1_INVOICED'
};

async function executeSync() {
  console.log('================================================================');
  console.log('🚀 LIVE TARGETED SYNC: NovaTech M1 Invoice Properties -> HubSpot');
  console.log('================================================================');
  console.log('Target Deal ID:  ', DEAL_ID);
  console.log('Payload Properties:');
  console.log(JSON.stringify(TARGET_PAYLOAD, null, 2));
  console.log('================================================================\n');

  // Step 1: Connect to MongoDB
  console.log('[STEP 1] Connecting to crm_zoho_db via shared connectDB()...');
  await connectDB();
  console.log('✔ Connected to database.\n');

  // Step 2: Execute PATCH
  console.log(`[STEP 2] Dispatching PATCH to HubSpot Deal ${DEAL_ID}...`);
  const patchRes = await updateHubSpotDealWithRetry(hubspotClient, DEAL_ID, TARGET_PAYLOAD, { maxRetries: 3 });
  console.log(`✔ HubSpot PATCH response: HTTP ${patchRes.statusCode}\n`);

  if (patchRes.statusCode < 200 || patchRes.statusCode >= 300) {
    throw new Error(`HubSpot update returned unexpected status: ${patchRes.statusCode}`);
  }

  // Step 3: Update MongoDB sync timestamp
  console.log('[STEP 3] Updating lastSyncedAt and lastSyncedValues in crm_zoho_db...');
  await IntegrationSync.updateOne(
    { crmDealId: DEAL_ID },
    {
      $set: {
        lastSyncedAt: new Date(),
        lastSyncedValues: TARGET_PAYLOAD
      }
    }
  );
  console.log('✔ MongoDB timestamp updated.\n');

  // Step 4: Read Deal Back from HubSpot (GET)
  console.log('[STEP 4] Reading back deal from HubSpot (GET /crm/v3/objects/deals/...)...');
  const queryProps = [
    'dealname',
    'dealstage',
    'amount',
    ...Object.keys(TARGET_PAYLOAD),
    'zoho_sales_order_id',
    'zoho_sales_order_number',
    'hs_lastmodifieddate'
  ].join(',');

  const getRes = await hubspotClient.request({
    method: 'GET',
    path: `/crm/v3/objects/deals/${DEAL_ID}?properties=${queryProps}`,
    crmDealId: DEAL_ID
  });

  console.log(`✔ HubSpot GET response: HTTP ${getRes.statusCode}`);
  const liveProps = getRes.data?.properties || {};

  console.log('\n================================================================');
  console.log('LIVE HUBSPOT POST-UPDATE VERIFICATION:');
  console.log('================================================================');
  console.log('Deal Name:                      ', liveProps.dealname);
  console.log('Deal Stage:                     ', liveProps.dealstage, liveProps.dealstage === 'qualifiedtobuy' ? '✔ (UNTOUCHED)' : '✖ MISMATCH');
  console.log('Deal Amount:                    ', liveProps.amount, liveProps.amount === '120000' ? '✔ (UNTOUCHED)' : '✖ MISMATCH');
  console.log('Sales Order ID:                 ', liveProps.zoho_sales_order_id);
  console.log('Sales Order Number:             ', liveProps.zoho_sales_order_number);
  console.log('----------------------------------------------------------------');
  console.log('zoho_amount_invoiced_unpaid:    ', liveProps.zoho_amount_invoiced_unpaid, liveProps.zoho_amount_invoiced_unpaid === '60000' ? '✔' : '✖');
  console.log('zoho_amount_not_invoiced:       ', liveProps.zoho_amount_not_invoiced, liveProps.zoho_amount_not_invoiced === '60000' ? '✔' : '✖');
  console.log('zoho_percentage_invoiced:       ', liveProps.zoho_percentage_invoiced, liveProps.zoho_percentage_invoiced === '50' ? '✔' : '✖');
  console.log('zoho_percentage_collected:      ', liveProps.zoho_percentage_collected, liveProps.zoho_percentage_collected === '0' ? '✔' : '✖');
  console.log('zoho_next_due_date:             ', liveProps.zoho_next_due_date, liveProps.zoho_next_due_date === '2026-11-30' ? '✔' : '✖');
  console.log('zoho_is_overdue:                ', liveProps.zoho_is_overdue, liveProps.zoho_is_overdue === 'false' ? '✔' : '✖');
  console.log('integration_sync_status:        ', liveProps.integration_sync_status, liveProps.integration_sync_status === 'M1_INVOICED' ? '✔' : '✖');
  console.log('integration_milestone_stage:    ', liveProps.integration_milestone_stage, liveProps.integration_milestone_stage === 'M1_INVOICED' ? '✔' : '✖');
  console.log('Last Modified Timestamp:        ', liveProps.hs_lastmodifieddate);
  console.log('================================================================\n');

  return { patchRes, getRes, liveProps };
}

if (require.main === module) {
  executeSync()
    .then(async () => {
      await disconnectDB();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('\n✖ SYNC FAILED:', err.message);
      if (err.data) console.error('  HubSpot Error Details:', JSON.stringify(err.data));
      await disconnectDB();
      process.exit(1);
    });
}

module.exports = { executeSync, TARGET_PAYLOAD };

