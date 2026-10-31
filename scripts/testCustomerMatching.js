require('dotenv').config();
const { connectDB, disconnectDB } = require('../server/src/config/db');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const CustomerService = require('../server/src/services/customerService');

/**
 * Manual test script for Phase 3 Step 1: CustomerMapping and Customer Matching.
 * Connects directly to MongoDB Atlas, verifies partial indexes, tests matching rules,
 * and demonstrates ambiguity detection and resolution.
 */
async function runManualTest() {
  console.log('\n=============================================================');
  console.log('🧪 Phase 3 Step 1 Manual Verification: Customer Mapping');
  console.log('=============================================================\n');

  try {
    await connectDB();
    await CustomerMapping.init(); // Ensure indexes are built in MongoDB Atlas

    // 1. Verify indexes in MongoDB Atlas
    console.log('1. Checking Indexes in MongoDB Atlas:');
    const indexes = await CustomerMapping.collection.indexes();
    indexes.forEach((idx) => {
      console.log(`   - Index: ${JSON.stringify(idx.key)} (Unique: ${Boolean(idx.unique)})`);
    });

    // 2. Test Rule: Reject missing company and contact ID
    console.log('\n2. Testing Missing Company & Contact ID:');
    const missingRes = await CustomerService.resolveCustomer({
      companyName: 'Orphan Deal Inc'
    });
    console.log('   Result:', missingRes);
    if (missingRes.status !== 'REQUIRES_MANUAL_MATCH') {
      throw new Error('Failed: Expected REQUIRES_MANUAL_MATCH for missing IDs');
    }
    console.log('   ✅ PASS: Reliably rejected missing identity without guessing.');

    // 3. Test Rule: Create Ambiguous Customer Match
    console.log('\n3. Testing Multiple Matches Ambiguity Detection:');
    const testCompanyId = 'TEST_COMP_' + Date.now();
    const mockZohoClient = {
      request: async ({ method, path }) => {
        if (method === 'GET') {
          return {
            statusCode: 200,
            data: {
              code: 0,
              contacts: [
                { contact_id: 'z_cand_1', contact_name: 'Branch A (Dubai)', company_name: 'Acme FZE', email: 'a@acme.ae' },
                { contact_id: 'z_cand_2', contact_name: 'Branch B (Abu Dhabi)', company_name: 'Acme FZE', email: 'b@acme.ae' }
              ]
            }
          };
        }
        return { statusCode: 200, data: { code: 0 } };
      }
    };

    const ambigRes = await CustomerService.resolveCustomer({
      hubspotCompanyId: testCompanyId,
      companyName: 'Acme FZE',
      contactEmail: 'contact@acme.ae',
      injectedZohoClient: mockZohoClient
    });

    console.log('   Ambiguity Detection Result:', ambigRes);
    if (ambigRes.status !== 'REQUIRES_MANUAL_MATCH' || ambigRes.candidateMatches.length !== 2) {
      throw new Error('Failed: Ambiguity was not detected properly');
    }
    console.log('   ✅ PASS: Ambiguity detected. Workflow halted with candidate matches saved.');

    // 4. Test Rule: Candidate Validation - Rejects non-candidate ID
    console.log('\n4. Testing Candidate Validation on Manual Resolution:');
    const ambigDoc = await CustomerMapping.findOne({ hubspotCompanyId: testCompanyId });
    try {
      await CustomerService.resolveManualMatch({
        mappingId: ambigDoc._id,
        chosenZohoContactId: 'rogue_contact_999' // Invalid candidate
      });
      throw new Error('Failed: Should have rejected invalid candidate ID');
    } catch (err) {
      if (err.code === 'INVALID_CANDIDATE_ID') {
        console.log('   ✅ PASS: Safely rejected invalid candidate ID:', err.message);
      } else {
        throw err;
      }
    }

    // 5. Test Rule: Valid Manual Resolution by Administrator
    console.log('\n5. Testing Valid Manual Disambiguation Resolution:');
    const resolvedDoc = await CustomerService.resolveManualMatch({
      mappingId: ambigDoc._id,
      chosenZohoContactId: 'z_cand_1',
      chosenZohoContactName: 'Branch A (Dubai)'
    });

    console.log('   Resolved Doc Status     :', resolvedDoc.status);
    console.log('   Resolved Mapping Type   :', resolvedDoc.mappingType);
    console.log('   Assigned Zoho Contact ID:', resolvedDoc.zohoContactId);

    if (resolvedDoc.status !== 'ACTIVE' || resolvedDoc.zohoContactId !== 'z_cand_1') {
      throw new Error('Failed: Manual resolution did not update status to ACTIVE');
    }
    console.log('   ✅ PASS: Customer mapping safely resolved to chosen contact.');

    // 6. Test Rule: Active Mapping Protection - Rejects Overwrite
    console.log('\n6. Testing Active Mapping Protection:');
    try {
      await CustomerService.resolveManualMatch({
        mappingId: ambigDoc._id,
        chosenZohoContactId: 'z_cand_1'
      });
      throw new Error('Failed: Should have rejected manual resolution of already ACTIVE mapping');
    } catch (err) {
      if (err.code === 'MAPPING_ALREADY_ACTIVE') {
        console.log('   ✅ PASS: Safely prevented overwrite of already ACTIVE mapping:', err.message);
      } else {
        throw err;
      }
    }

    // 7. Test Rule: Subsequent Lookup uses cache (0 API calls)
    console.log('\n7. Testing Cached Resolution:');
    const cachedRes = await CustomerService.resolveCustomer({
      hubspotCompanyId: testCompanyId,
      companyName: 'Acme FZE'
    });
    console.log('   Cached Result:', cachedRes);
    if (!cachedRes.fromCache || cachedRes.zohoContactId !== 'z_cand_1') {
      throw new Error('Failed: Subsequent lookup did not return cached contact');
    }
    console.log('   ✅ PASS: Subsequent lookup resolved from MongoDB cache without API calls.');

    console.log('\n=============================================================');
    console.log('🎉 Phase 3 Step 1 Manual Verification 100% SUCCESSFUL!');
    console.log('=============================================================\n');
  } catch (err) {
    console.error('\n❌ Manual Test Failed:', err.message);
  } finally {
    await disconnectDB();
  }
}

if (require.main === module) {
  runManualTest();
}

module.exports = { runManualTest };

