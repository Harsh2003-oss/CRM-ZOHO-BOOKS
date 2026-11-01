/**
 * scripts/repairNovaTechCustomerRef.js
 *
 * Tightly guarded repair of IntegrationSync.zohoContactId for NovaTech (Deal 360608312029).
 *
 * Safety Rules:
 * - Read-only by default (DRY RUN). Requires --execute flag to write.
 * - Reads authoritative zohoContactId from CustomerMapping in crm_zoho_db.
 * - Guarded filter matches on _id, crmDealId, zohoContactId === null, zohoSalesOrderId, and salesOrderStatus.
 * - Updates ONLY zohoContactId. Leaves all other fields, timestamps, and statuses untouched.
 * - Zero calls to Zoho Books or HubSpot.
 * - Does not create invoices or payments.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../server/src/config/db');

const TARGET = {
  crmDealId: '360608312029',
  hubspotCompanyId: '358741933767',
  expectedSalesOrderId: '4224694000000060001',
  expectedSalesOrderNumber: 'SO-00002',
  expectedAmount: 120000,
  expectedCurrency: 'AED'
};

async function repairCustomerRef({ isDryRun = true } = {}) {
  console.log('================================================================');
  console.log(`🔧 NOVATECH INTEGRATIONSYNC REPAIR [${isDryRun ? 'DRY RUN - READ ONLY' : 'EXECUTE'}]`);
  console.log('================================================================\n');

  // Step 1: Connect to crm_zoho_db
  console.log('[STEP 1] Connecting to crm_zoho_db via shared connectDB()...');
  await connectDB();
  const db = mongoose.connection;
  console.log('✔ Connected to database.\n');

  // Step 2: Read & Verify CustomerMapping
  console.log(`[STEP 2] Reading active CustomerMapping for company ${TARGET.hubspotCompanyId}...`);
  const mapping = await db.collection('customermappings').findOne({
    hubspotCompanyId: TARGET.hubspotCompanyId,
    status: 'ACTIVE'
  });

  if (!mapping) {
    throw new Error(`CRITICAL: Active CustomerMapping not found for company ${TARGET.hubspotCompanyId}.`);
  }
  if (!mapping.zohoContactId) {
    throw new Error(`CRITICAL: CustomerMapping is missing zohoContactId.`);
  }
  console.log(`✔ Found Active CustomerMapping:`);
  console.log(`  - _id:             ${mapping._id}`);
  console.log(`  - Company Name:    ${mapping.companyName}`);
  console.log(`  - Zoho Contact ID: ${mapping.zohoContactId}\n`);

  // Step 3: Read & Verify IntegrationSync
  console.log(`[STEP 3] Reading IntegrationSync for deal ${TARGET.crmDealId}...`);
  const sync = await db.collection('integrationsyncs').findOne({ crmDealId: TARGET.crmDealId });
  if (!sync) {
    throw new Error(`CRITICAL: IntegrationSync not found for deal ${TARGET.crmDealId}.`);
  }

  console.log('✔ Found IntegrationSync:');
  console.log(`  - _id:                 ${sync._id}`);
  console.log(`  - crmDealId:           ${sync.crmDealId}`);
  console.log(`  - zohoContactId:       ${sync.zohoContactId} (Currently null)`);
  console.log(`  - zohoSalesOrderId:    ${sync.zohoSalesOrderId}`);
  console.log(`  - zohoSalesOrderNumber:${sync.zohoSalesOrderNumber}`);
  console.log(`  - salesOrderStatus:    ${sync.salesOrderStatus}`);
  console.log(`  - salesOrderTotal:     ${sync.salesOrderTotal} ${sync.currencyCode}`);
  console.log(`  - syncStatus:          ${sync.syncStatus}\n`);

  // Safeguards
  if (sync.zohoContactId !== null && sync.zohoContactId === mapping.zohoContactId) {
    console.log('ℹ zohoContactId is already set to the matching CustomerMapping ID. No repair needed.');
    return { status: 'ALREADY_REPAIRED' };
  }
  if (sync.zohoContactId !== null && sync.zohoContactId !== mapping.zohoContactId) {
    throw new Error(`ABORT: Conflict detected. sync.zohoContactId is '${sync.zohoContactId}', expected null or '${mapping.zohoContactId}'.`);
  }
  if (sync.zohoSalesOrderId !== TARGET.expectedSalesOrderId) {
    throw new Error(`ABORT: Sales Order ID mismatch: got '${sync.zohoSalesOrderId}', expected '${TARGET.expectedSalesOrderId}'.`);
  }
  if (sync.zohoSalesOrderNumber !== TARGET.expectedSalesOrderNumber) {
    throw new Error(`ABORT: Sales Order Number mismatch: got '${sync.zohoSalesOrderNumber}', expected '${TARGET.expectedSalesOrderNumber}'.`);
  }
  if (sync.salesOrderTotal !== TARGET.expectedAmount) {
    throw new Error(`ABORT: Amount mismatch: got ${sync.salesOrderTotal}, expected ${TARGET.expectedAmount}.`);
  }
  if (sync.currencyCode !== TARGET.expectedCurrency) {
    throw new Error(`ABORT: Currency mismatch: got '${sync.currencyCode}', expected '${TARGET.expectedCurrency}'.`);
  }
  console.log('✔ All invariant safeguards passed.\n');

  // Step 4: Guarded Query Definition
  const guardedFilter = {
    _id: sync._id,
    crmDealId: TARGET.crmDealId,
    zohoContactId: null,
    zohoSalesOrderId: TARGET.expectedSalesOrderId,
    salesOrderStatus: 'CONFIRMED'
  };

  const updateOp = {
    $set: {
      zohoContactId: mapping.zohoContactId
    }
  };

  console.log('[STEP 4] Guarded Update Operation:');
  console.log('Filter:', JSON.stringify(guardedFilter, null, 2));
  console.log('Update:', JSON.stringify(updateOp, null, 2));
  console.log('');

  // Step 5: Execution Boundary
  if (isDryRun) {
    console.log('================================================================');
    console.log('🛑 DRY RUN COMPLETE: NO DATABASE WRITES PERFORMED');
    console.log(`   Proposed repair: IntegrationSync.zohoContactId -> '${mapping.zohoContactId}'`);
    console.log('================================================================\n');
    return {
      status: 'DRY_RUN_PASSED',
      before: sync.zohoContactId,
      after: mapping.zohoContactId,
      filter: guardedFilter,
      update: updateOp
    };
  }

  // Live Execution (Only reached when isDryRun === false)
  console.log('[STEP 5] EXECUTING GUARDED UPDATE ON crm_zoho_db...');
  const result = await db.collection('integrationsyncs').updateOne(guardedFilter, updateOp);
  console.log(`✔ Update result: matchedCount=${result.matchedCount}, modifiedCount=${result.modifiedCount}`);

  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error(`FAILED: Expected exactly 1 matched and 1 modified document, got matched=${result.matchedCount}, modified=${result.modifiedCount}.`);
  }

  const updatedDoc = await db.collection('integrationsyncs').findOne({ _id: sync._id });
  console.log(`✔ Verified updated zohoContactId: '${updatedDoc.zohoContactId}'`);
  console.log('\n================================================================');
  console.log('✔ REPAIR COMPLETED SUCCESSFULLY');
  console.log('================================================================\n');

  return { status: 'SUCCESS', updatedDoc };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute');
  const isDryRun = !isExecute;

  repairCustomerRef({ isDryRun })
    .then(async () => {
      await disconnectDB();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('\n✖ SCRIPT FAILED / ABORTED:', err.message);
      await disconnectDB();
      process.exit(1);
    });
}

module.exports = { repairCustomerRef, TARGET };

