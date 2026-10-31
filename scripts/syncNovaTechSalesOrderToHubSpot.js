/**
 * scripts/syncNovaTechSalesOrderToHubSpot.js
 *
 * Targeted sync of confirmed Zoho Sales Order properties to HubSpot deal 360608312029.
 *
 * Safety Rules:
 * - Read-only by default (DRY RUN). Requires explicit --execute flag to write.
 * - Reads authoritative data from crm_zoho_db via shared connectDB().
 * - Verifies all target HubSpot property schemas exist before assembling PATCH.
 * - Only syncs verified Sales Order properties (no dealstage, no missing properties).
 * - Zero calls to Zoho Books.
 * - Safeguards abort execution if any reference ID, currency, or total deviates.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { connectDB, disconnectDB } = require('../server/src/config/db');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const { hubspotClient } = require('../server/src/clients/hubspotClient');
const { updateHubSpotDealWithRetry } = require('../server/src/services/orchestrationService');

const EXPECTED = {
  crmDealId: '360608312029',
  zohoSalesOrderId: '4224694000000060001',
  zohoSalesOrderNumber: 'SO-00002',
  currencyCode: 'AED',
  salesOrderTotal: 120000
};

const TARGET_PROPERTIES = [
  'zoho_sales_order_id',
  'zoho_sales_order_number',
  'zoho_sales_order_url',
  'zoho_sales_order_total',
  'zoho_amount_not_invoiced',
  'integration_sync_status'
];

async function runSync({ isDryRun = true } = {}) {
  console.log('================================================================');
  console.log(`🔍 NOVATECH HUBSPOT SALES ORDER SYNC [${isDryRun ? 'DRY RUN - READ ONLY' : 'EXECUTE'}]`);
  console.log('================================================================\n');

  // Step 1: Connect to crm_zoho_db
  console.log('[STEP 1] Connecting to crm_zoho_db via shared connectDB()...');
  await connectDB();
  console.log('✔ Connected to database.\n');

  // Step 2: Read & Verify IntegrationSync Record
  console.log(`[STEP 2] Reading IntegrationSync for deal ${EXPECTED.crmDealId}...`);
  const syncDoc = await IntegrationSync.findOne({ crmDealId: EXPECTED.crmDealId });
  if (!syncDoc) {
    throw new Error(`CRITICAL: IntegrationSync record not found for deal ${EXPECTED.crmDealId}.`);
  }

  console.log('✔ Record loaded. Verifying record invariants:');
  console.log(`  - crmDealId:            '${syncDoc.crmDealId}' (Expected: '${EXPECTED.crmDealId}')`);
  console.log(`  - zohoSalesOrderId:     '${syncDoc.zohoSalesOrderId}' (Expected: '${EXPECTED.zohoSalesOrderId}')`);
  console.log(`  - zohoSalesOrderNumber: '${syncDoc.zohoSalesOrderNumber}' (Expected: '${EXPECTED.zohoSalesOrderNumber}')`);
  console.log(`  - currencyCode:         '${syncDoc.currencyCode}' (Expected: '${EXPECTED.currencyCode}')`);
  console.log(`  - salesOrderTotal:      ${syncDoc.salesOrderTotal} (Expected: ${EXPECTED.salesOrderTotal})`);
  console.log(`  - salesOrderStatus:     '${syncDoc.salesOrderStatus}'`);
  console.log(`  - syncStatus:           '${syncDoc.syncStatus}'`);

  if (syncDoc.crmDealId !== EXPECTED.crmDealId) {
    throw new Error(`ABORT: Deal ID mismatch: got '${syncDoc.crmDealId}', expected '${EXPECTED.crmDealId}'.`);
  }
  if (syncDoc.zohoSalesOrderId !== EXPECTED.zohoSalesOrderId) {
    throw new Error(`ABORT: Sales Order ID mismatch: got '${syncDoc.zohoSalesOrderId}', expected '${EXPECTED.zohoSalesOrderId}'.`);
  }
  if (syncDoc.zohoSalesOrderNumber !== EXPECTED.zohoSalesOrderNumber) {
    throw new Error(`ABORT: Sales Order Number mismatch: got '${syncDoc.zohoSalesOrderNumber}', expected '${EXPECTED.zohoSalesOrderNumber}'.`);
  }
  if (syncDoc.currencyCode !== EXPECTED.currencyCode) {
    throw new Error(`ABORT: Currency mismatch: got '${syncDoc.currencyCode}', expected '${EXPECTED.currencyCode}'.`);
  }
  if (Number(syncDoc.salesOrderTotal) !== EXPECTED.salesOrderTotal) {
    throw new Error(`ABORT: Total mismatch: got ${syncDoc.salesOrderTotal}, expected ${EXPECTED.salesOrderTotal}.`);
  }
  console.log('✔ All MongoDB record safeguards passed.\n');

  // Step 3: Verify HubSpot Property Schema Existence (Read-Only)
  console.log('[STEP 3] Verifying target HubSpot properties exist in CRM portal...');
  for (const propName of TARGET_PROPERTIES) {
    const res = await hubspotClient.getProperty(propName);
    if (res.statusCode !== 200) {
      throw new Error(`ABORT: Required property '${propName}' is missing in HubSpot (HTTP ${res.statusCode}).`);
    }
    console.log(`  ✔ Property '${propName}' verified (200 OK).`);
  }
  console.log('✔ All 6 target HubSpot properties exist in portal.\n');

  // Step 4: Assemble Strict Targeted Payload
  console.log('[STEP 4] Assembling strict PATCH payload...');
  const payload = {
    zoho_sales_order_id: syncDoc.zohoSalesOrderId,
    zoho_sales_order_number: syncDoc.zohoSalesOrderNumber,
    zoho_sales_order_url: syncDoc.zohoSalesOrderUrl || `https://books.zoho.in/app/60093852869#/salesorders/${syncDoc.zohoSalesOrderId}`,
    zoho_sales_order_total: Number(syncDoc.salesOrderTotal.toFixed(2)),
    zoho_amount_not_invoiced: Number((syncDoc.amountNotInvoiced || syncDoc.salesOrderTotal).toFixed(2)),
    integration_sync_status: syncDoc.syncStatus || 'SALES_ORDER_CONFIRMED'
  };

  // Verify payload contains ONLY the 6 approved fields and NO forbidden fields
  const payloadKeys = Object.keys(payload);
  const hasForbiddenKey = payloadKeys.some(k => !TARGET_PROPERTIES.includes(k));
  if (hasForbiddenKey || payload.dealstage) {
    throw new Error('CRITICAL: Payload contains unauthorized or forbidden keys.');
  }

  console.log('✔ Proposed PATCH Payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('');

  // Step 5: Execution Boundary
  if (isDryRun) {
    console.log('================================================================');
    console.log('🛑 DRY RUN COMPLETE: NO CALLS MADE TO HUBSPOT PATCH OR ZOHO BOOKS');
    console.log('   MongoDB records were not modified.');
    console.log('================================================================\n');
    return { status: 'DRY_RUN_PASSED', payload };
  }

  // Live Execution (Only reached when isDryRun === false)
  console.log('[STEP 5] EXECUTING LIVE PATCH TO HUBSPOT...');
  const updateRes = await updateHubSpotDealWithRetry(hubspotClient, EXPECTED.crmDealId, payload, { maxRetries: 3 });
  console.log(`✔ HubSpot Deal ${EXPECTED.crmDealId} updated successfully (HTTP ${updateRes.statusCode}).`);

  console.log('[STEP 6] Updating IntegrationSync timestamp in crm_zoho_db...');
  await IntegrationSync.updateOne(
    { crmDealId: EXPECTED.crmDealId },
    {
      $set: {
        lastSyncedAt: new Date(),
        lastSyncedValues: payload
      }
    }
  );
  console.log('✔ Timestamp updated in crm_zoho_db.');
  console.log('\n================================================================');
  console.log('✔ LIVE SYNC COMPLETED SUCCESSFULLY');
  console.log('================================================================\n');

  return { status: 'SUCCESS', payload };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute');
  const isDryRun = !isExecute;

  runSync({ isDryRun })
    .then(async () => {
      await disconnectDB();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('\n✖ SYNC FAILED / ABORTED:', err.message);
      await disconnectDB();
      process.exit(1);
    });
}

module.exports = { runSync, EXPECTED, TARGET_PROPERTIES };

