const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const ProductMapping = require('../server/src/models/ProductMapping');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const ProductService = require('../server/src/services/productService');
const { OrchestrationService } = require('../server/src/services/orchestrationService');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ProductMapping.init();
  await IntegrationSync.init();
  await CustomerMapping.init();
  await MilestoneInvoice.init();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await ProductMapping.deleteMany({});
  await IntegrationSync.deleteMany({});
  await CustomerMapping.deleteMany({});
  await MilestoneInvoice.deleteMany({});
});

function createMockZohoClient({ items = [] } = {}) {
  const calls = [];
  return {
    calls,
    request: async ({ method, path, body }) => {
      calls.push({ method, path, body });

      if (method === 'GET' && path.startsWith('/items')) {
        const url = new URL(`http://localhost${path}`);
        const nameQuery = url.searchParams.get('name');
        const skuQuery = url.searchParams.get('sku');

        let matched = items;
        if (skuQuery) {
          matched = items.filter((i) => i.sku === skuQuery);
        } else if (nameQuery) {
          matched = items.filter((i) => (i.name || i.item_name || '').toLowerCase().includes(nameQuery.toLowerCase()));
        }
        return { statusCode: 200, data: { code: 0, items: matched } };
      }

      if (method === 'GET' && path.startsWith('/contacts')) {
        return { statusCode: 200, data: { code: 0, contacts: [] } };
      }
      if (method === 'POST' && path === '/contacts') {
        return { statusCode: 200, data: { code: 0, contact: { contact_id: 'cust_mock_1', contact_name: 'Test Customer' } } };
      }
      if (method === 'GET' && path.startsWith('/salesorders')) {
        return { statusCode: 200, data: { code: 0, salesorders: [] } };
      }
      if (method === 'POST' && path === '/salesorders') {
        return {
          statusCode: 200,
          data: {
            code: 0,
            salesorder: {
              salesorder_id: 'so_mock_prod_1',
              salesorder_number: 'SO-PROD-001',
              reference_number: body.reference_number,
              customer_id: body.customer_id,
              sub_total: 120000,
              tax_total: 6000,
              total: 126000,
              status: 'draft',
              currency_code: 'AED',
              line_items: [{ line_item_id: 'so_item_1', item_id: body.line_items[0].item_id, rate: 120000 }]
            }
          }
        };
      }
      if (method === 'POST' && path.includes('/status/confirm')) {
        return { statusCode: 200, data: { code: 0, salesorder: { status: 'confirmed' } } };
      }
      if (method === 'GET' && path.startsWith('/invoices')) {
        return { statusCode: 200, data: { code: 0, invoices: [] } };
      }
      if (method === 'POST' && path === '/invoices') {
        return {
          statusCode: 200,
          data: {
            code: 0,
            invoice: {
              invoice_id: 'inv_mock_prod_1',
              invoice_number: 'INV-PROD-001',
              reference_number: body.reference_number,
              customer_id: body.customer_id,
              salesorder_id: body.salesorder_id,
              sub_total: 60000,
              tax_total: 3000,
              total: 63000,
              status: 'draft',
              due_date: '2026-11-30',
              balance: 63000,
              currency_code: 'AED',
              line_items: [{ line_item_id: 'inv_item_1', salesorder_item_id: 'so_item_1', rate: 60000 }]
            }
          }
        };
      }
      if (method === 'POST' && path.includes('/status/sent')) {
        return { statusCode: 200, data: { code: 0, invoice: { status: 'sent' } } };
      }
      return { statusCode: 200, data: { code: 0 } };
    }
  };
}

test.describe('Phase 3 Step 1B: Product Mapping & Catalog Resolution', () => {
  test('Rule 1: Rejects unmapped product when 0 matches in Zoho without guessing', async () => {
    const mockZoho = createMockZohoClient({ items: [] });

    const result = await ProductService.resolveProduct({
      productName: 'Custom Enterprise Addon',
      crmDealId: 'deal_unmapped_01',
      injectedZohoClient: mockZoho
    });

    assert.equal(result.status, 'REQUIRES_MANUAL_MATCH');
    assert.match(result.reason, /never guess an item/i);

    // Verifies audit record saved in DB
    const mapping = await ProductMapping.findOne({ productName: 'Custom Enterprise Addon' });
    assert.ok(mapping);
    assert.equal(mapping.status, 'UNMAPPED');
  });

  test('Rule 2: Exactly 1 match in Zoho catalog links item automatically (AUTOMATIC_EXACT)', async () => {
    const mockZoho = createMockZohoClient({
      items: [
        { item_id: 'item_zoho_1001', name: 'Cloud Platform License', sku: 'SKU-CLOUD-01', rate: 120000 }
      ]
    });

    const result = await ProductService.resolveProduct({
      productName: 'Cloud Platform License',
      crmDealId: 'deal_exact_02',
      injectedZohoClient: mockZoho
    });

    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.zohoItemId, 'item_zoho_1001');
    assert.equal(result.mappingType, 'AUTOMATIC_EXACT');
    assert.equal(result.fromCache, false);

    // Verify persisted in DB
    const mapping = await ProductMapping.findOne({ zohoItemId: 'item_zoho_1001' });
    assert.ok(mapping);
    assert.equal(mapping.status, 'ACTIVE');
  });

  test('Rule 3: Multiple matches (>1) in Zoho halts automatic processing and marks AMBIGUOUS', async () => {
    const mockZoho = createMockZohoClient({
      items: [
        { item_id: 'item_zoho_2001', name: 'Software Tier 1', sku: 'SKU-SW-01' },
        { item_id: 'item_zoho_2002', name: 'Software Tier 2', sku: 'SKU-SW-02' }
      ]
    });

    const result = await ProductService.resolveProduct({
      productName: 'Software',
      crmDealId: 'deal_ambig_03',
      injectedZohoClient: mockZoho
    });

    assert.equal(result.status, 'REQUIRES_MANUAL_MATCH');
    assert.match(result.reason, /human selection required/i);
    assert.equal(result.candidateMatches.length, 2);

    const mapping = await ProductMapping.findOne({ productName: 'Software' });
    assert.ok(mapping);
    assert.equal(mapping.status, 'AMBIGUOUS');
  });

  test('Rule 4: Subsequent lookups reuse local ProductMapping without calling Zoho catalog', async () => {
    await ProductMapping.create({
      productName: 'Cached Platform License',
      zohoItemId: 'item_cached_999',
      zohoItemName: 'Cached Platform License',
      status: 'ACTIVE',
      mappingType: 'AUTOMATIC_EXACT'
    });

    const mockZoho = createMockZohoClient({ items: [] }); // Empty Zoho catalog

    const result = await ProductService.resolveProduct({
      productName: 'Cached Platform License',
      injectedZohoClient: mockZoho
    });

    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.zohoItemId, 'item_cached_999');
    assert.equal(result.fromCache, true);
    assert.equal(mockZoho.calls.length, 0); // Zero remote API calls made
  });

  test('Rule 5: Deal with unmapped product halts orchestration and updates HubSpot deal', async () => {
    const mockZoho = createMockZohoClient({ items: [] });
    const mockHsCalls = [];
    const mockHs = {
      calls: mockHsCalls,
      getDeal: async (dealId) => ({
        statusCode: 200,
        data: {
          id: dealId,
          properties: {
            dealname: 'Enterprise Contract',
            dealstage: 'closedwon',
            amount: 120000,
            product_name: 'Unmapped Specialized Engine'
          },
          associations: {
            companies: { results: [{ id: 'comp_prod_test' }] }
          }
        }
      }),
      updateDeal: async (dealId, properties) => {
        mockHsCalls.push({ dealId, properties });
        return { statusCode: 200 };
      }
    };

    const res = await OrchestrationService.processClosedWonDeal({
      crmDealId: 'deal_orch_unmapped_prod',
      taxPercentage: 5.0,
      injectedHubSpotClient: mockHs,
      injectedZohoClient: mockZoho
    });

    assert.equal(res.status, 'REQUIRES_MANUAL_MATCH');
    assert.match(res.reason, /does not exist in Zoho Books catalog/i);

    // Verify HubSpot notified
    const lastHsCall = mockHsCalls[mockHsCalls.length - 1];
    assert.ok(lastHsCall);
    assert.equal(lastHsCall.properties.integration_sync_status, 'REQUIRES_MANUAL_MATCH');
    assert.match(lastHsCall.properties.integration_last_error, /never guess an item/i);

    // Verify Sales Order was NOT created
    const syncDoc = await IntegrationSync.findOne({ crmDealId: 'deal_orch_unmapped_prod' });
    assert.equal(syncDoc.syncStatus, 'REQUIRES_MANUAL_MATCH');
    assert.equal(syncDoc.zohoSalesOrderId, null);
  });
});

