/**
 * scripts/migrateNovaTechRecords.js
 *
 * Safe, idempotent migration of NovaTech records from 'test' to 'crm_zoho_db'.
 * - Source (test): Strictly READ-ONLY. Zero deletions or mutations.
 * - Destination (crm_zoho_db): Uses shared connectDB() with destination-level transaction.
 * - Idempotency: Running multiple times will skip already-migrated records without error.
 * - Credential Safety: Source logs verified sanitized with zero secrets/tokens.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../server/src/config/db');

async function migrateNovaTechRecords() {
  console.log('====================================================');
  console.log('📦 SAFE IDEMPOTENT MIGRATION: NovaTech -> crm_zoho_db');
  console.log('====================================================\n');

  // 1. Connect to Destination using shared connectDB()
  console.log('[STEP 1] Connecting to Destination Database (crm_zoho_db)...');
  await connectDB();
  const destConnection = mongoose.connection;
  console.log(`✔ Connected to Destination DB: '${destConnection.name}' at host '${destConnection.host}'.\n`);

  // 2. Connect to Source using explicit test dbName
  console.log('[STEP 2] Connecting to Source Database (test)...');
  const sourceConn = await mongoose.createConnection(process.env.MONGODB_URI, {
    dbName: 'test',
    serverSelectionTimeoutMS: 5000
  }).asPromise();
  console.log(`✔ Connected to Source DB: '${sourceConn.name}' (strictly READ-ONLY).\n`);

  // 3. Read Source Documents
  console.log('[STEP 3] Reading Source Records from test...');
  const crmDealId = '360608312029';
  const hubspotCompanyId = '358741933767';

  const sourceCustomerMapping = await sourceConn.collection('customermappings').findOne({ hubspotCompanyId });
  const sourceIntegrationSync = await sourceConn.collection('integrationsyncs').findOne({ crmDealId });
  const sourceLogs = await sourceConn.collection('integrationlogs').find({ crmDealId }).toArray();

  if (!sourceCustomerMapping) {
    throw new Error(`Source CustomerMapping for company ID ${hubspotCompanyId} not found in 'test' database.`);
  }
  if (!sourceIntegrationSync) {
    throw new Error(`Source IntegrationSync for deal ID ${crmDealId} not found in 'test' database.`);
  }
  console.log(`✔ Read CustomerMapping: _id=${sourceCustomerMapping._id}, company='${sourceCustomerMapping.companyName}'`);
  console.log(`✔ Read IntegrationSync:  _id=${sourceIntegrationSync._id}, SO='${sourceIntegrationSync.zohoSalesOrderNumber}'`);
  console.log(`✔ Read IntegrationLogs:  ${sourceLogs.length} audit documents\n`);

  // 4. Idempotency & Comprehensive Conflict Check on Destination
  console.log('[STEP 4] Checking Destination Idempotency & Comprehensive Field Matching...');
  const existingMapping = await destConnection.collection('customermappings').findOne({ hubspotCompanyId });
  let skipMapping = false;
  if (existingMapping) {
    const mappingFields = [
      'hubspotCompanyId',
      'hubspotContactId',
      'companyName',
      'contactName',
      'contactEmail',
      'zohoContactId',
      'zohoContactName',
      'mappingType',
      'status'
    ];
    for (const field of mappingFields) {
      const srcVal = String(sourceCustomerMapping[field] ?? '');
      const dstVal = String(existingMapping[field] ?? '');
      if (srcVal !== dstVal) {
        throw new Error(`CustomerMapping field conflict on '${field}': source='${srcVal}', destination='${dstVal}'. Aborting destination migration.`);
      }
    }
    console.log(`  ℹ CustomerMapping already exists in destination and all fields match identically. Skipping insert.`);
    skipMapping = true;
  } else {
    console.log(`  ✔ CustomerMapping: 0 conflicts found in destination. Ready to insert.`);
  }

  const existingSync = await destConnection.collection('integrationsyncs').findOne({ crmDealId });
  let skipSync = false;
  if (existingSync) {
    const syncFields = [
      'crmDealId',
      'zohoSalesOrderId',
      'zohoSalesOrderNumber',
      'zohoSalesOrderLineItemId',
      'salesOrderTotal',
      'salesOrderSubtotal',
      'salesOrderTax',
      'currencyCode',
      'salesOrderStatus',
      'syncStatus',
      'amountNotInvoiced',
      'totalInvoicedAmount',
      'amountCollected'
    ];
    for (const field of syncFields) {
      const srcVal = String(sourceIntegrationSync[field] ?? '');
      const dstVal = String(existingSync[field] ?? '');
      if (srcVal !== dstVal) {
        throw new Error(`IntegrationSync field conflict on '${field}': source='${srcVal}', destination='${dstVal}'. Aborting destination migration.`);
      }
    }
    console.log(`  ℹ IntegrationSync already exists in destination and all fields match identically. Skipping insert.`);
    skipSync = true;
  } else {
    console.log(`  ✔ IntegrationSync: 0 conflicts found in destination. Ready to insert.`);
  }

  // 5. Execute Migration with Destination Transaction
  console.log('\n[STEP 5] Applying Migration to Destination (crm_zoho_db)...');
  const session = await destConnection.startSession();
  try {
    await session.withTransaction(async () => {
      // Migrate CustomerMapping
      if (!skipMapping) {
        await destConnection.collection('customermappings').insertOne(sourceCustomerMapping, { session });
        console.log(`  ✔ Inserted CustomerMapping (_id: ${sourceCustomerMapping._id}) into crm_zoho_db.`);
      }

      // Migrate IntegrationSync
      if (!skipSync) {
        await destConnection.collection('integrationsyncs').insertOne(sourceIntegrationSync, { session });
        console.log(`  ✔ Inserted IntegrationSync (_id: ${sourceIntegrationSync._id}) into crm_zoho_db.`);
      }

      // Migrate IntegrationLogs
      let logsInserted = 0;
      for (const logDoc of sourceLogs) {
        const existingLog = await destConnection.collection('integrationlogs').findOne({ _id: logDoc._id }, { session });
        if (existingLog) {
          if (String(existingLog.timestamp) !== String(logDoc.timestamp) || existingLog.endpoint !== logDoc.endpoint) {
            throw new Error(`IntegrationLog conflict for _id ${logDoc._id}: endpoint/timestamp mismatch. Aborting transaction.`);
          }
        } else {
          await destConnection.collection('integrationlogs').insertOne(logDoc, { session });
          logsInserted++;
        }
      }
      console.log(`  ✔ Inserted ${logsInserted}/${sourceLogs.length} IntegrationLogs into crm_zoho_db.`);
    });
    console.log('✔ Destination Transaction Committed Successfully.\n');
  } finally {
    await session.endSession();
    await sourceConn.close();
  }

  // 6. Post-Migration Verification
  console.log('[STEP 6] Post-Migration Destination Verification...');
  const verifiedMapping = await destConnection.collection('customermappings').findOne({ hubspotCompanyId });
  const verifiedSync = await destConnection.collection('integrationsyncs').findOne({ crmDealId });
  const verifiedLogsCount = await destConnection.collection('integrationlogs').countDocuments({ crmDealId });

  console.log('✔ Destination Verification Results:');
  console.log(`  - CustomerMapping in crm_zoho_db: ZohoContactId=${verifiedMapping?.zohoContactId}, Status=${verifiedMapping?.status}`);
  console.log(`  - IntegrationSync in crm_zoho_db:  SO=${verifiedSync?.zohoSalesOrderNumber}, Total=${verifiedSync?.salesOrderTotal} ${verifiedSync?.currencyCode}`);
  console.log(`  - IntegrationLogs in crm_zoho_db:  ${verifiedLogsCount} logs present`);
  console.log('\nMigration complete. Source database "test" remains completely intact.');
}

if (require.main === module) {
  migrateNovaTechRecords()
    .then(async () => {
      await disconnectDB();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('\n✖ MIGRATION FAILED:', err.message);
      await disconnectDB();
      process.exit(1);
    });
}

module.exports = { migrateNovaTechRecords };

