const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const CustomerMapping = require('../server/src/models/CustomerMapping');
const CustomerService = require('../server/src/services/customerService');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  await CustomerMapping.init();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await CustomerMapping.deleteMany({});
});

// Helper to create a mock Zoho client
function createMockZohoClient({ searchResults = [], createResult = null }) {
  const calls = [];
  return {
    calls,
    request: async ({ method, path, body }) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/contacts')) {
        return {
          statusCode: 200,
          data: { code: 0, message: 'success', contacts: searchResults }
        };
      }
      if (method === 'POST' && path === '/contacts') {
        return {
          statusCode: 200,
          data: {
            code: 0,
            message: 'success',
            contact: createResult || {
              contact_id: 'zoho_created_999',
              contact_name: body.contact_name,
              company_name: body.company_name
            }
          }
        };
      }
      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

// ==============================================================================
// STEP 3.1 AUTOMATED TESTS: CUSTOMER MAPPING & MATCHING
// ==============================================================================
test.describe('Phase 3 Step 1: Customer Mapping & Ambiguity Handling', () => {
  test('Rule 1: Rejects deals missing both company ID and contact ID without guessing', async () => {
    const res = await CustomerService.resolveCustomer({
      companyName: 'Unverified Company',
      contactEmail: 'unverified@example.com'
    });

    assert.equal(res.status, 'REQUIRES_MANUAL_MATCH');
    assert.match(res.reason, /Missing verified HubSpot Company ID/);

    // No mapping created
    const count = await CustomerMapping.countDocuments();
    assert.equal(count, 0);
  });

  test('Rule 2: Exactly 1 match in Zoho links existing customer (AUTOMATIC_EXACT)', async () => {
    const mockClient = createMockZohoClient({
      searchResults: [
        {
          contact_id: 'zoho_existing_001',
          contact_name: 'Alpha Industries LLC',
          company_name: 'Alpha Industries LLC',
          email: 'finance@alphaindustries.ae'
        }
      ]
    });

    const res = await CustomerService.resolveCustomer({
      hubspotCompanyId: 'hs_comp_101',
      companyName: 'Alpha Industries LLC',
      contactEmail: 'finance@alphaindustries.ae',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'RESOLVED');
    assert.equal(res.zohoContactId, 'zoho_existing_001');
    assert.equal(res.mappingType, 'AUTOMATIC_EXACT');
    assert.equal(res.fromCache, false);

    // Check MongoDB persistence
    const saved = await CustomerMapping.findOne({ hubspotCompanyId: 'hs_comp_101' });
    assert.ok(saved);
    assert.equal(saved.status, 'ACTIVE');
    assert.equal(saved.zohoContactId, 'zoho_existing_001');
    assert.equal(saved.mappingType, 'AUTOMATIC_EXACT');
  });

  test('Rule 3: 0 matches in Zoho creates a new customer (AUTO_CREATED) and supports optional email', async () => {
    const mockClient = createMockZohoClient({
      searchResults: [], // No matches
      createResult: {
        contact_id: 'zoho_new_777',
        contact_name: 'Beta Global Tech',
        company_name: 'Beta Global Tech'
      }
    });

    const res = await CustomerService.resolveCustomer({
      hubspotCompanyId: 'hs_comp_202',
      companyName: 'Beta Global Tech',
      contactName: 'Sarah Connor',
      contactEmail: null, // Email is optional
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'RESOLVED');
    assert.equal(res.zohoContactId, 'zoho_new_777');
    assert.equal(res.mappingType, 'AUTO_CREATED');

    // Verify POST was sent to Zoho
    const postCall = mockClient.calls.find((c) => c.method === 'POST');
    assert.ok(postCall);
    assert.equal(postCall.body.company_name, 'Beta Global Tech');
    assert.deepEqual(postCall.body.contact_persons, []); // No email, no crash

    const saved = await CustomerMapping.findOne({ hubspotCompanyId: 'hs_comp_202' });
    assert.ok(saved);
    assert.equal(saved.status, 'ACTIVE');
    assert.equal(saved.zohoContactId, 'zoho_new_777');
  });

  test('Rule 4: Multiple matches (>1) halts processing and flags record as AMBIGUOUS', async () => {
    const mockClient = createMockZohoClient({
      searchResults: [
        { contact_id: 'c_1', contact_name: 'Gamma Corp Branch 1', company_name: 'Gamma Corp', email: 'g1@gamma.com' },
        { contact_id: 'c_2', contact_name: 'Gamma Corp Branch 2', company_name: 'Gamma Corp', email: 'g2@gamma.com' }
      ]
    });

    const res = await CustomerService.resolveCustomer({
      hubspotCompanyId: 'hs_comp_303',
      companyName: 'Gamma Corp',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'REQUIRES_MANUAL_MATCH');
    assert.match(res.reason, /Found 2 matching contacts/);
    assert.equal(res.candidateMatches.length, 2);

    // Verify marked AMBIGUOUS in MongoDB with candidateMatches preserved
    const saved = await CustomerMapping.findOne({ hubspotCompanyId: 'hs_comp_303' });
    assert.ok(saved);
    assert.equal(saved.status, 'AMBIGUOUS');
    assert.equal(saved.candidateMatches.length, 2);
    assert.equal(saved.zohoContactId, null);
  });

  test('Rule 5: Subsequent lookups reuse local CustomerMapping without calling Zoho API', async () => {
    // Seed existing active mapping in MongoDB
    await CustomerMapping.create({
      hubspotCompanyId: 'hs_comp_cached_404',
      companyName: 'Cached Logistics FZE',
      zohoContactId: 'zoho_cached_555',
      zohoContactName: 'Cached Logistics FZE',
      status: 'ACTIVE',
      mappingType: 'AUTOMATIC_EXACT'
    });

    const mockClient = createMockZohoClient({});

    const res = await CustomerService.resolveCustomer({
      hubspotCompanyId: 'hs_comp_cached_404',
      companyName: 'Cached Logistics FZE',
      injectedZohoClient: mockClient
    });

    assert.equal(res.status, 'RESOLVED');
    assert.equal(res.zohoContactId, 'zoho_cached_555');
    assert.equal(res.fromCache, true);
    assert.equal(mockClient.calls.length, 0, 'Should make 0 calls to Zoho API when mapping exists in DB');
  });

  test('Rule 6: Multiple deals for same company resolve to the same Zoho contact', async () => {
    const mockClient = createMockZohoClient({
      searchResults: [
        { contact_id: 'zoho_shared_111', contact_name: 'Shared Enterprise', company_name: 'Shared Enterprise' }
      ]
    });

    // Deal 1 resolution
    const deal1Res = await CustomerService.resolveCustomer({
      hubspotCompanyId: 'hs_comp_shared',
      companyName: 'Shared Enterprise',
      injectedZohoClient: mockClient
    });
    assert.equal(deal1Res.zohoContactId, 'zoho_shared_111');

    // Deal 2 resolution for same company
    const deal2Res = await CustomerService.resolveCustomer({
      hubspotCompanyId: 'hs_comp_shared',
      companyName: 'Shared Enterprise',
      injectedZohoClient: mockClient
    });
    assert.equal(deal2Res.zohoContactId, 'zoho_shared_111');
    assert.equal(deal2Res.fromCache, true);

    // Exactly 1 customer mapping document exists
    const count = await CustomerMapping.countDocuments({ hubspotCompanyId: 'hs_comp_shared' });
    assert.equal(count, 1);
  });

  test('Rule 7: Manual disambiguation transitions AMBIGUOUS mapping to ACTIVE (MANUALLY_RESOLVED)', async () => {
    // Create an ambiguous mapping
    const ambiguous = await CustomerMapping.create({
      hubspotCompanyId: 'hs_comp_ambig_909',
      companyName: 'Delta Systems',
      status: 'AMBIGUOUS',
      candidateMatches: [
        { contactId: 'z_cand_1', contactName: 'Delta Systems Dubai' },
        { contactId: 'z_cand_2', contactName: 'Delta Systems Abu Dhabi' }
      ],
      reason: 'Multiple matches found'
    });

    // Admin selects z_cand_1
    const resolved = await CustomerService.resolveManualMatch({
      mappingId: ambiguous._id,
      chosenZohoContactId: 'z_cand_1',
      chosenZohoContactName: 'Delta Systems Dubai'
    });

    assert.equal(resolved.status, 'ACTIVE');
    assert.equal(resolved.mappingType, 'MANUALLY_RESOLVED');
    assert.equal(resolved.zohoContactId, 'z_cand_1');
    assert.equal(resolved.candidateMatches.length, 0);
    assert.ok(resolved.resolvedAt);
  });

  test('Rule 8: Candidate Validation - Rejects chosenZohoContactId not in candidateMatches', async () => {
    const ambiguous = await CustomerMapping.create({
      hubspotCompanyId: 'hs_comp_cand_check',
      companyName: 'Epsilon Tech',
      status: 'AMBIGUOUS',
      candidateMatches: [
        { contactId: 'valid_cand_1', contactName: 'Epsilon Dubai' },
        { contactId: 'valid_cand_2', contactName: 'Epsilon Global' }
      ]
    });

    await assert.rejects(
      async () => {
        await CustomerService.resolveManualMatch({
          mappingId: ambiguous._id,
          chosenZohoContactId: 'rogue_contact_999' // Not in candidateMatches
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_CANDIDATE_ID');
        assert.match(err.message, /not among the candidate matches/);
        return true;
      }
    );

    // Document must remain AMBIGUOUS
    const unchanged = await CustomerMapping.findById(ambiguous._id);
    assert.equal(unchanged.status, 'AMBIGUOUS');
    assert.equal(unchanged.zohoContactId, null);
  });

  test('Rule 9: Active Mapping Protection - Rejects attempts to overwrite already ACTIVE mapping', async () => {
    const active = await CustomerMapping.create({
      hubspotCompanyId: 'hs_comp_already_active',
      companyName: 'Zeta Holdings',
      status: 'ACTIVE',
      zohoContactId: 'z_original_001',
      mappingType: 'AUTOMATIC_EXACT',
      candidateMatches: [{ contactId: 'z_override_002', contactName: 'Zeta Alt' }]
    });

    await assert.rejects(
      async () => {
        await CustomerService.resolveManualMatch({
          mappingId: active._id,
          chosenZohoContactId: 'z_override_002'
        });
      },
      (err) => {
        assert.equal(err.code, 'MAPPING_ALREADY_ACTIVE');
        assert.match(err.message, /already ACTIVE and cannot be overwritten/);
        return true;
      }
    );

    // Document still has original zohoContactId
    const unchanged = await CustomerMapping.findById(active._id);
    assert.equal(unchanged.zohoContactId, 'z_original_001');
    assert.equal(unchanged.status, 'ACTIVE');
  });

  test('Rule 10: Atomic Resolution - Concurrent resolution attempts allow only one winner', async () => {
    const ambiguous = await CustomerMapping.create({
      hubspotCompanyId: 'hs_comp_race_test',
      companyName: 'Omega Dynamics',
      status: 'AMBIGUOUS',
      candidateMatches: [
        { contactId: 'omega_cand_1', contactName: 'Omega A' },
        { contactId: 'omega_cand_2', contactName: 'Omega B' }
      ]
    });

    // Fire two simultaneous resolution attempts for different candidates
    const results = await Promise.allSettled([
      CustomerService.resolveManualMatch({
        mappingId: ambiguous._id,
        chosenZohoContactId: 'omega_cand_1'
      }),
      CustomerService.resolveManualMatch({
        mappingId: ambiguous._id,
        chosenZohoContactId: 'omega_cand_2'
      })
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one must succeed, and one must be rejected with conflict
    assert.equal(fulfilled.length, 1, 'Exactly one concurrent attempt must succeed');
    assert.equal(rejected.length, 1, 'The other concurrent attempt must be rejected');
    assert.equal(rejected[0].reason.code, 'CONCURRENT_MODIFICATION_CONFLICT');

    // The winning document must be ACTIVE
    const finalDoc = await CustomerMapping.findById(ambiguous._id);
    assert.equal(finalDoc.status, 'ACTIVE');
    assert.ok(finalDoc.zohoContactId === 'omega_cand_1' || finalDoc.zohoContactId === 'omega_cand_2');
  });
});

