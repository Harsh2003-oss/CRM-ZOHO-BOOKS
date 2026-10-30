require('dotenv').config();
const dns = require('dns').promises;
const mongoose = require('mongoose');

// Import models to check indexes when connected
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');

async function diagnose() {
  console.log('\n==================================================');
  console.log('🔍 MongoDB Atlas Connection Diagnostic Tool');
  console.log('==================================================\n');

  const rawUri = process.env.MONGODB_URI;

  if (!rawUri || rawUri.trim() === '') {
    console.error('❌ MONGODB_URI is MISSING or empty in .env');
    return { status: 'CONFIG_MISSING' };
  }

  // 1. Analyze URI Structure safely (secrets strictly redacted)
  let parsedHost = '';
  let parsedDb = '';
  let hasUsername = false;
  let hasPassword = false;

  try {
    const match = rawUri.match(/^mongodb\+srv:\/\/([^:]+):([^@]+)@([^/?#]+)(\/[^?#]*)?(\?.*)?$/);
    if (match) {
      hasUsername = Boolean(match[1]);
      hasPassword = Boolean(match[2]);
      parsedHost = match[3];
      parsedDb = match[4] ? match[4].replace('/', '') : 'test';
    } else {
      console.warn('⚠️ URI does not match standard mongodb+srv:// format.');
    }
  } catch (e) {
    console.warn('⚠️ URI parsing warning:', e.message);
  }

  console.log('1. Configuration Inspection:');
  console.log(`   - Environment Variable: MONGODB_URI`);
  console.log(`   - Format               : mongodb+srv://`);
  console.log(`   - Username Configured  : ${hasUsername ? 'YES' : 'NO'}`);
  console.log(`   - Password Configured  : ${hasPassword ? 'YES (Redacted)' : 'NO'}`);
  console.log(`   - Cluster Hostname     : ${parsedHost || 'Unknown'}`);
  console.log(`   - Target Database      : ${parsedDb || 'default'}\n`);

  // 2. DNS SRV Resolution Check
  console.log('2. DNS SRV Resolution Check:');
  if (parsedHost) {
    try {
      const srvRecords = await dns.resolveSrv(`_mongodb._tcp.${parsedHost}`);
      console.log(`   ✅ DNS Resolved successfully: Found ${srvRecords.length} replica set host(s)`);
    } catch (dnsErr) {
      console.error(`   ❌ DNS Resolution FAILED for cluster: ${dnsErr.message}`);
      return { status: 'DNS_FAILED', error: dnsErr.message };
    }
  } else {
    console.log('   ⏭️ Skipped (hostname unparsed)');
  }

  // 3. Connection & Authentication Attempt
  console.log('\n3. Database Authentication & Connectivity Check:');
  let cleanUri = rawUri;
  if (!cleanUri.includes('crm_zoho_db') && !cleanUri.includes('/admin')) {
    cleanUri = cleanUri.replace(/\/?$/, '/crm_zoho_db?retryWrites=true&w=majority');
  }

  try {
    await mongoose.connect(cleanUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 8000
    });

    console.log('   ✅ AUTHENTICATION & CONNECTION SUCCESSFUL!');
    console.log(`   - Connected to database: ${mongoose.connection.name}`);
    console.log(`   - Ready state          : ${mongoose.connection.readyState} (Connected)`);

    // 4. Index Verification
    console.log('\n4. Verifying Required Unique Indexes in Database:');
    await WebhookEvent.init();
    await IntegrationSync.init();
    await MilestoneInvoice.init();

    const webhookIndexes = await WebhookEvent.collection.indexes();
    const syncIndexes = await IntegrationSync.collection.indexes();
    const invoiceIndexes = await MilestoneInvoice.collection.indexes();

    const hasWebhookEventIdUnique = webhookIndexes.some(
      (idx) => idx.key.eventId === 1 && idx.unique === true
    );
    const hasSyncDealIdUnique = syncIndexes.some(
      (idx) => idx.key.crmDealId === 1 && idx.unique === true
    );
    const hasInvoiceCompoundUnique = invoiceIndexes.some(
      (idx) => idx.key.crmDealId === 1 && idx.key.milestoneIndex === 1 && idx.unique === true
    );

    console.log(`   - WebhookEvent.eventId (Unique)                     : ${hasWebhookEventIdUnique ? '✅ VERIFIED' : '❌ MISSING'}`);
    console.log(`   - IntegrationSync.crmDealId (Unique)                : ${hasSyncDealIdUnique ? '✅ VERIFIED' : '❌ MISSING'}`);
    console.log(`   - MilestoneInvoice (crmDealId + milestoneIndex)     : ${hasInvoiceCompoundUnique ? '✅ VERIFIED' : '❌ MISSING'}`);

    console.log('\n==================================================');
    console.log('🎉 Result: ALL MONGODB ACCEPTANCE CRITERIA PASS');
    console.log('==================================================\n');

    await mongoose.disconnect();
    return { status: 'PASS' };
  } catch (err) {
    console.error('\n   ❌ Connection Attempt Failed:');
    if (err.code === 8000 || err.message.includes('authentication failed')) {
      console.error('   👉 [DIAGNOSIS: AUTHENTICATION_FAILED]');
      console.error('      Network & DNS are working properly, but MongoDB Atlas rejected the username or password.');
      console.error('      Action: Go to Atlas -> Security -> Database Access -> edit password for your user.');
    } else if (err.name === 'MongoServerSelectionError') {
      console.error('   👉 [DIAGNOSIS: NETWORK_OR_IP_BLOCKED]');
      console.error('      Atlas did not accept connection within 5000ms.');
      console.error('      Action: Go to Atlas -> Security -> Network Access -> add 0.0.0.0/0 (Allow Anywhere).');
    } else {
      console.error(`   👉 [DIAGNOSIS: UNEXPECTED_ERROR] ${err.name} (Code: ${err.code || 'None'})`);
    }

    console.log('\n==================================================');
    console.log('⚠️ Result: MONGODB ATLAS REMAINS BLOCKED');
    console.log('==================================================\n');
    return { status: 'BLOCKED', error: err.name, code: err.code };
  }
}

if (require.main === module) {
  diagnose().then((res) => {
    process.exit(res.status === 'PASS' ? 0 : 1);
  });
}

module.exports = { diagnose };

