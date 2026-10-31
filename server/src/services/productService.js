const ProductMapping = require('../models/ProductMapping');
const { zohoClient } = require('../clients/zohoClient');

/**
 * ProductService manages deterministic mapping between CRM products/line items and Zoho Books catalog items.
 * Strictly adheres to assignment rule: "Map the CRM deal's products to Zoho Books items. Never guess an item."
 *
 * Rules:
 * 1. Checks local ProductMapping cache first.
 * 2. If not cached, searches Zoho Books catalog (/items) by name or SKU.
 * 3. Exactly 1 match in Zoho -> links item automatically (AUTOMATIC_EXACT).
 * 4. Multiple matches (>1) in Zoho -> marks AMBIGUOUS, requires human decision.
 * 5. 0 matches in Zoho:
 *    - If DEFAULT_ZOHO_ITEM_ID is configured in environment, uses that explicit item.
 *    - If product details were provided, halts with REQUIRES_MANUAL_MATCH (never guesses).
 * 6. If no product details exist on deal and REQUIRE_PRODUCT_MAPPING=true, halts with REQUIRES_MANUAL_MATCH.
 */
class ProductService {
  /**
   * Resolves a CRM product to a Zoho Books item.
   * @param {Object} params
   * @param {string} [params.hubspotProductId]
   * @param {string} [params.productName]
   * @param {string} [params.sku]
   * @param {string} [params.crmDealId]
   * @param {Object} [params.injectedZohoClient]
   * @returns {Promise<{ status: 'RESOLVED'|'REQUIRES_MANUAL_MATCH'|'NO_PRODUCT_SPECIFIED', zohoItemId?: string, zohoItemName?: string, rate?: number, reason?: string, candidateMatches?: Array }>}
   */
  static async resolveProduct({
    hubspotProductId = null,
    productName = '',
    sku = null,
    crmDealId = null,
    injectedZohoClient = null
  } = {}) {
    const client = injectedZohoClient || zohoClient;

    // RULE 1: If neither product ID, product name, nor SKU is specified:
    if (!hubspotProductId && !productName && !sku) {
      const defaultItemId = process.env.DEFAULT_ZOHO_ITEM_ID || process.env.ZOHO_DEFAULT_ITEM_ID || null;
      if (defaultItemId) {
        return {
          status: 'RESOLVED',
          zohoItemId: defaultItemId,
          zohoItemName: process.env.DEFAULT_ZOHO_ITEM_NAME || 'Default Enterprise Service',
          mappingType: 'CONFIGURED_DEFAULT'
        };
      }

      if (process.env.REQUIRE_PRODUCT_MAPPING === 'true') {
        return {
          status: 'REQUIRES_MANUAL_MATCH',
          reason: 'No CRM product or line item specified and no DEFAULT_ZOHO_ITEM_ID configured. Product mapping required.'
        };
      }

      return {
        status: 'NO_PRODUCT_SPECIFIED'
      };
    }

    // RULE 2: Check local ProductMapping cache in MongoDB
    const query = hubspotProductId
      ? { hubspotProductId }
      : (sku ? { sku } : { productName });

    const existingMapping = await ProductMapping.findOne(query);
    if (existingMapping) {
      if (existingMapping.status === 'ACTIVE' && existingMapping.zohoItemId) {
        return {
          status: 'RESOLVED',
          zohoItemId: existingMapping.zohoItemId,
          zohoItemName: existingMapping.zohoItemName,
          rate: existingMapping.rate,
          mappingType: existingMapping.mappingType,
          fromCache: true
        };
      }

      if (existingMapping.status === 'AMBIGUOUS') {
        return {
          status: 'REQUIRES_MANUAL_MATCH',
          reason: existingMapping.reason || `Product mapping for '${productName || hubspotProductId}' is ambiguous. Human decision required.`,
          candidateMatches: existingMapping.candidateMatches
        };
      }
    }

    // RULE 3: Search Zoho Books catalog
    const candidateMap = new Map();

    // 3A. Search by SKU if SKU provided
    if (sku && sku.trim()) {
      try {
        const skuRes = await client.request({
          method: 'GET',
          path: `/items?sku=${encodeURIComponent(sku.trim())}`,
          crmDealId
        });
        if (skuRes.data?.items && Array.isArray(skuRes.data.items)) {
          skuRes.data.items.forEach((item) => candidateMap.set(item.item_id, item));
        }
      } catch (err) {
        console.warn('[PRODUCT SERVICE] Zoho SKU search warning:', err.message);
      }
    }

    // 3B. Search by Item Name
    const searchName = productName ? productName.trim() : '';
    if (searchName && candidateMap.size === 0) {
      try {
        const nameRes = await client.request({
          method: 'GET',
          path: `/items?name=${encodeURIComponent(searchName)}`,
          crmDealId
        });
        if (nameRes.data?.items && Array.isArray(nameRes.data.items)) {
          nameRes.data.items.forEach((item) => candidateMap.set(item.item_id, item));
        }
      } catch (err) {
        console.warn('[PRODUCT SERVICE] Zoho item name search warning:', err.message);
      }
    }

    const candidates = Array.from(candidateMap.values());

    // RULE 4: Evaluate Candidates

    // Case 4A: Multiple matches found -> STOP, do not guess
    if (candidates.length > 1) {
      const candidateList = candidates.map((item) => ({
        itemId: item.item_id,
        itemName: item.name || item.item_name,
        sku: item.sku || '',
        rate: item.rate || 0
      }));

      await ProductMapping.findOneAndUpdate(
        query,
        {
          $set: {
            hubspotProductId: hubspotProductId || null,
            productName: productName || '',
            sku: sku || null,
            status: 'AMBIGUOUS',
            candidateMatches: candidateList,
            reason: `Found ${candidates.length} matching items in Zoho Books for '${productName || sku}'. Human selection required.`
          }
        },
        { upsert: true, returnDocument: 'after' }
      );

      return {
        status: 'REQUIRES_MANUAL_MATCH',
        reason: `Found ${candidates.length} matching items in Zoho Books for '${productName || sku}'. Human selection required.`,
        candidateMatches: candidateList
      };
    }

    // Case 4B: Exactly 1 match found -> Link item automatically
    if (candidates.length === 1) {
      const match = candidates[0];
      await ProductMapping.findOneAndUpdate(
        query,
        {
          $set: {
            hubspotProductId: hubspotProductId || null,
            productName: productName || match.name || '',
            sku: sku || match.sku || null,
            zohoItemId: match.item_id,
            zohoItemName: match.name || match.item_name || '',
            zohoItemSku: match.sku || '',
            rate: match.rate || 0,
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
        zohoItemId: match.item_id,
        zohoItemName: match.name || match.item_name,
        rate: match.rate,
        mappingType: 'AUTOMATIC_EXACT',
        fromCache: false
      };
    }

    // Case 4C: 0 matches found in Zoho Books catalog
    // Never guess! Check configured default or require manual mapping
    const defaultItemId = process.env.DEFAULT_ZOHO_ITEM_ID || process.env.ZOHO_DEFAULT_ITEM_ID || null;
    if (defaultItemId) {
      return {
        status: 'RESOLVED',
        zohoItemId: defaultItemId,
        zohoItemName: process.env.DEFAULT_ZOHO_ITEM_NAME || 'Default Enterprise Service',
        mappingType: 'CONFIGURED_DEFAULT'
      };
    }

    // Record as UNMAPPED to prevent silent ad-hoc guessing
    await ProductMapping.findOneAndUpdate(
      query,
      {
        $set: {
          hubspotProductId: hubspotProductId || null,
          productName: productName || '',
          sku: sku || null,
          status: 'UNMAPPED',
          reason: `No matching item found in Zoho Books catalog for '${productName || hubspotProductId || sku}'. Never guess an item.`
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    return {
      status: 'REQUIRES_MANUAL_MATCH',
      reason: `CRM product '${productName || hubspotProductId || sku}' does not exist in Zoho Books catalog. Never guess an item. Human mapping required.`
    };
  }
}

module.exports = ProductService;

