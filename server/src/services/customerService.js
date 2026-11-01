const CustomerMapping = require('../models/CustomerMapping');
const { zohoClient } = require('../clients/zohoClient');

/**
 * CustomerService manages reliable customer matching between HubSpot CRM and Zoho Books.
 * Strictly adheres to assignment requirements:
 * 1. Exactly 1 match -> links customer.
 * 2. 0 matches -> auto-creates customer.
 * 3. > 1 matches -> halts automatic processing and marks REQUIRES_MANUAL_MATCH.
 * 4. Missing both Company ID and Contact ID -> halts with manual resolution required.
 */
class CustomerService {
  /**
   * Resolves or creates a Zoho Books customer for a HubSpot deal.
   * @param {Object} params
   * @param {string} [params.hubspotCompanyId] - Primary company identifier from HubSpot
   * @param {string} [params.hubspotContactId] - Primary contact identifier if company absent
   * @param {string} [params.companyName]      - Associated company name
   * @param {string} [params.contactName]      - Associated contact name
   * @param {string} [params.contactEmail]     - Contact email (optional)
   * @param {string} [params.crmDealId]        - Associated deal ID for audit logging
   * @param {Object} [params.injectedZohoClient] - Optional injected client for testing
   * @returns {Promise<{ status: 'RESOLVED'|'REQUIRES_MANUAL_MATCH'|'ERROR', zohoContactId?: string, mappingType?: string, reason?: string, candidateMatches?: Array }>}
   */
  static async resolveCustomer({
    hubspotCompanyId = null,
    hubspotContactId = null,
    companyName = '',
    contactName = '',
    contactEmail = null,
    crmDealId = null,
    injectedZohoClient = null
  } = {}) {
    const client = injectedZohoClient || zohoClient;

    // RULE 1: Never guess on unreliable identity if neither company ID nor contact ID exists
    if (!hubspotCompanyId && !hubspotContactId) {
      return {
        status: 'REQUIRES_MANUAL_MATCH',
        reason: 'Missing verified HubSpot Company ID and Contact ID. Manual association required.'
      };
    }

    // RULE 2: Check local CustomerMapping cache (by Company ID, Contact ID, or Email)
    let existingMapping = null;
    if (hubspotCompanyId) {
      existingMapping = await CustomerMapping.findOne({ hubspotCompanyId });
    }
    if (!existingMapping && hubspotContactId) {
      existingMapping = await CustomerMapping.findOne({ hubspotContactId });
    }
    if (!existingMapping && contactEmail && contactEmail.trim()) {
      existingMapping = await CustomerMapping.findOne({ contactEmail: contactEmail.trim().toLowerCase() });
    }

    if (existingMapping) {
      if (existingMapping.status === 'ACTIVE' && existingMapping.zohoContactId) {
        // Active-Org Validation: Ensure the cached contact is accessible in the current active Zoho organization
        let isContactAccessible = false;
        try {
          const verifyRes = await client.request({
            method: 'GET',
            path: `/contacts/${existingMapping.zohoContactId}`,
            crmDealId
          });
          if (verifyRes.statusCode === 200 && verifyRes.data?.contact) {
            isContactAccessible = true;
          }
        } catch (vErr) {
          isContactAccessible = false;
        }

        if (isContactAccessible) {
          return {
            status: 'RESOLVED',
            zohoContactId: existingMapping.zohoContactId,
            zohoContactName: existingMapping.zohoContactName,
            mappingType: existingMapping.mappingType,
            fromCache: true
          };
        } else {
          console.warn(`[CUSTOMER SERVICE] Cached contact ${existingMapping.zohoContactId} is not accessible in current Zoho organization. Invalidating stale cache and re-creating.`);
          await CustomerMapping.deleteOne({ _id: existingMapping._id });
          existingMapping = null;
        }
      }

      if (existingMapping && existingMapping.status === 'AMBIGUOUS') {
        return {
          status: 'REQUIRES_MANUAL_MATCH',
          reason: existingMapping.reason || 'Existing customer mapping is marked ambiguous and requires manual resolution.',
          candidateMatches: existingMapping.candidateMatches
        };
      }
    }

    // RULE 3: Search Zoho Books Contacts
    const candidateMap = new Map();

    // 3A. Search by email if email provided
    if (contactEmail && contactEmail.trim()) {
      try {
        const emailRes = await client.request({
          method: 'GET',
          path: `/contacts?email=${encodeURIComponent(contactEmail.trim())}`,
          crmDealId
        });

        if (emailRes.data?.contacts && Array.isArray(emailRes.data.contacts)) {
          emailRes.data.contacts.forEach((c) => candidateMap.set(c.contact_id, c));
        }
      } catch (err) {
        console.warn('[CUSTOMER SERVICE] Zoho email search warning:', err.message);
      }
    }

    // 3B. Search by company name if company name provided
    if (companyName && companyName.trim()) {
      try {
        const nameRes = await client.request({
          method: 'GET',
          path: `/contacts?company_name=${encodeURIComponent(companyName.trim())}`,
          crmDealId
        });

        if (nameRes.data?.contacts && Array.isArray(nameRes.data.contacts)) {
          nameRes.data.contacts.forEach((c) => candidateMap.set(c.contact_id, c));
        }
      } catch (err) {
        console.warn('[CUSTOMER SERVICE] Zoho company name search warning:', err.message);
      }
    }

    const candidates = Array.from(candidateMap.values());

    // RULE 4: Evaluate Candidate Matches

    // Case 4A: Multiple matches found -> STOP automatic processing
    if (candidates.length > 1) {
      const candidateList = candidates.map((c) => ({
        contactId: c.contact_id,
        contactName: c.contact_name,
        companyName: c.company_name,
        email: c.email,
        phone: c.phone
      }));

      await CustomerMapping.findOneAndUpdate(
        query,
        {
          $set: {
            hubspotCompanyId: hubspotCompanyId || null,
            hubspotContactId: hubspotContactId || null,
            companyName: companyName || '',
            contactName: contactName || '',
            contactEmail: contactEmail ? contactEmail.toLowerCase() : null,
            status: 'AMBIGUOUS',
            candidateMatches: candidateList,
            reason: `Found ${candidates.length} matching contacts in Zoho Books. Human decision required.`
          }
        },
        { upsert: true, returnDocument: 'after' }
      );

      return {
        status: 'REQUIRES_MANUAL_MATCH',
        reason: `Found ${candidates.length} matching contacts in Zoho Books. Human decision required.`,
        candidateMatches: candidateList
      };
    }

    // Case 4B: Exactly 1 match found -> Link existing customer
    if (candidates.length === 1) {
      const match = candidates[0];

      await CustomerMapping.findOneAndUpdate(
        query,
        {
          $set: {
            hubspotCompanyId: hubspotCompanyId || null,
            hubspotContactId: hubspotContactId || null,
            companyName: companyName || match.company_name || '',
            contactName: contactName || match.contact_name || '',
            contactEmail: contactEmail ? contactEmail.toLowerCase() : match.email || null,
            zohoContactId: match.contact_id,
            zohoContactName: match.contact_name,
            mappingType: 'AUTOMATIC_EXACT',
            status: 'ACTIVE',
            reason: null,
            candidateMatches: []
          }
        },
        { upsert: true, returnDocument: 'after' }
      );

      return {
        status: 'RESOLVED',
        zohoContactId: match.contact_id,
        zohoContactName: match.contact_name,
        mappingType: 'AUTOMATIC_EXACT',
        fromCache: false
      };
    }

    // Case 4C: 0 matches found -> Create new customer in Zoho Books
    const displayName = companyName || contactName || `Company ${hubspotCompanyId || hubspotContactId}`;
    const contactPersons = contactEmail
      ? [
          {
            first_name: contactName ? contactName.split(' ')[0] : 'Primary',
            last_name: contactName && contactName.split(' ').length > 1 ? contactName.split(' ').slice(1).join(' ') : 'Contact',
            email: contactEmail.toLowerCase(),
            is_primary_contact: true
          }
        ]
      : [];

    const createPayload = {
      contact_name: displayName,
      company_name: companyName || displayName,
      contact_persons: contactPersons,
      notes: `Synced from HubSpot CRM (Company ID: ${hubspotCompanyId || 'N/A'}, Contact ID: ${hubspotContactId || 'N/A'})`
    };

    if (process.env.ZOHO_AED_CURRENCY_ID) {
      createPayload.currency_id = process.env.ZOHO_AED_CURRENCY_ID;
    }

    const createRes = await client.request({
      method: 'POST',
      path: '/contacts',
      body: createPayload,
      crmDealId
    });

    if (!createRes.data || createRes.data.code !== 0 || !createRes.data.contact) {
      const errMsg = createRes.data?.message || 'Failed to create contact in Zoho Books';
      if (String(errMsg).toLowerCase().includes('already exists')) {
        try {
          const findRes = await client.request({
            method: 'GET',
            path: `/contacts?contact_name=${encodeURIComponent(displayName)}`,
            crmDealId
          });
          const existingContacts = findRes.data?.contacts || [];
          if (existingContacts.length > 0) {
            const foundContact = existingContacts[0];
            await CustomerMapping.findOneAndUpdate(
              query,
              {
                $set: {
                  hubspotCompanyId: hubspotCompanyId || null,
                  hubspotContactId: hubspotContactId || null,
                  companyName: companyName || foundContact.company_name || displayName,
                  contactName: contactName || foundContact.contact_name || displayName,
                  contactEmail: contactEmail ? contactEmail.toLowerCase() : foundContact.email || null,
                  zohoContactId: foundContact.contact_id,
                  zohoContactName: foundContact.contact_name,
                  mappingType: 'AUTOMATIC_EXACT',
                  status: 'ACTIVE',
                  reason: null,
                  candidateMatches: []
                }
              },
              { upsert: true, returnDocument: 'after' }
            );
            return {
              status: 'RESOLVED',
              zohoContactId: foundContact.contact_id,
              zohoContactName: foundContact.contact_name,
              mappingType: 'AUTOMATIC_EXACT',
              fromCache: false
            };
          }
        } catch (findErr) {
          console.warn('[CUSTOMER SERVICE] Could not search contact by name after duplicate error:', findErr.message);
        }
      }
      return {
        status: 'ERROR',
        reason: errMsg
      };
    }

    const createdContact = createRes.data.contact;

    const upsertQuery = {};
    if (hubspotCompanyId && hubspotContactId) {
      upsertQuery.$or = [{ hubspotCompanyId }, { hubspotContactId }];
    } else if (hubspotCompanyId) {
      upsertQuery.hubspotCompanyId = hubspotCompanyId;
    } else if (hubspotContactId) {
      upsertQuery.hubspotContactId = hubspotContactId;
    } else {
      upsertQuery.companyName = companyName || displayName;
    }

    await CustomerMapping.findOneAndUpdate(
      upsertQuery,
      {
        $set: {
          hubspotCompanyId: hubspotCompanyId || null,
          hubspotContactId: hubspotContactId || null,
          companyName: companyName || displayName,
          contactName: contactName || displayName,
          contactEmail: contactEmail ? contactEmail.toLowerCase() : null,
          zohoContactId: createdContact.contact_id,
          zohoContactName: createdContact.contact_name,
          mappingType: 'AUTO_CREATED',
          status: 'ACTIVE',
          reason: null,
          candidateMatches: []
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    return {
      status: 'RESOLVED',
      zohoContactId: createdContact.contact_id,
      zohoContactName: createdContact.contact_name,
      mappingType: 'AUTO_CREATED',
      fromCache: false
    };
  }

  /**
   * Allows an administrator to manually resolve an ambiguous customer match.
   * Enforces:
   * 1. Candidate validation: chosenZohoContactId must exist in candidateMatches.
   * 2. Active mapping protection: Rejects resolution if status is already ACTIVE.
   * 3. Atomic conditional update: Only succeeds if status is still AMBIGUOUS at write time.
   * @param {Object} params
   * @param {string} params.mappingId - MongoDB ObjectId of CustomerMapping
   * @param {string} params.chosenZohoContactId - ID of selected Zoho Contact from candidates
   * @param {string} [params.chosenZohoContactName]
   */
  static async resolveManualMatch({ mappingId, chosenZohoContactId, chosenZohoContactName = '' }) {
    if (!mappingId || !chosenZohoContactId) {
      throw new Error('Both mappingId and chosenZohoContactId are required to resolve manual match.');
    }

    // 1. Fetch current document to validate candidate matches and active state
    const mapping = await CustomerMapping.findById(mappingId);
    if (!mapping) {
      throw new Error(`CustomerMapping with ID ${mappingId} not found.`);
    }

    // Protection: Reject attempt to manually resolve an already ACTIVE mapping
    if (mapping.status === 'ACTIVE') {
      const err = new Error(`CustomerMapping ${mappingId} is already ACTIVE and cannot be overwritten.`);
      err.code = 'MAPPING_ALREADY_ACTIVE';
      throw err;
    }

    // Protection: Candidate validation - chosen ID must be in saved candidateMatches
    const candidate = mapping.candidateMatches?.find((c) => c.contactId === chosenZohoContactId);
    if (!candidate) {
      const err = new Error(`Selected Zoho Contact ID '${chosenZohoContactId}' is not among the candidate matches for mapping ${mappingId}.`);
      err.code = 'INVALID_CANDIDATE_ID';
      throw err;
    }

    const resolvedName = chosenZohoContactName || candidate.contactName || mapping.companyName || '';

    // 2. Atomic conditional update: only succeeds if status is still AMBIGUOUS at write time
    const updatedMapping = await CustomerMapping.findOneAndUpdate(
      {
        _id: mappingId,
        status: 'AMBIGUOUS' // Atomic guard against concurrent race conditions
      },
      {
        $set: {
          zohoContactId: chosenZohoContactId,
          zohoContactName: resolvedName,
          status: 'ACTIVE',
          mappingType: 'MANUALLY_RESOLVED',
          candidateMatches: [],
          reason: null,
          resolvedAt: new Date()
        }
      },
      { returnDocument: 'after' }
    );

    // If update returned null, a concurrent request already resolved or changed it
    if (!updatedMapping) {
      const err = new Error(`Conflict: CustomerMapping ${mappingId} was already resolved or modified by a concurrent operation.`);
      err.code = 'CONCURRENT_MODIFICATION_CONFLICT';
      throw err;
    }

    return updatedMapping;
  }
}

module.exports = CustomerService;

