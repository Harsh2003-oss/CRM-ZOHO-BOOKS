const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.VAT_PERCENTAGE = '0'; // Explicit 0% VAT defense in depth

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../server/src/config/db');
const CustomerService = require('../server/src/services/customerService');
const SalesOrderService = require('../server/src/services/salesOrderService');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const WebhookEvent = require('../server/src/models/WebhookEvent');

async function executeNovaTechSalesOrderOnly() {
  const crmDealId = '360608312029';
  const hubspotCompanyId = '358741933767';
  const hubspotContactId = '581389407948';
  const companyName = 'NovaTech';
  const contactName = 'Arjun Mehta';
  const contactEmail = 'arjun.mehta@novatech.com';
  const dealName = 'MANUAL_TEST_001_NovaTech';
  const amount = 120000.00;
  const currencyCode = 'AED';
  const taxPercentage = 0;

  console.log('==================================================');
  console.log('🚀 LIVE EXECUTION: NovaTech Sales Order (Controlled)');
  console.log('==================================================');
  console.log(`CRM Deal ID:           ${crmDealId}`);
  console.log(`HubSpot Company ID:    ${hubspotCompanyId}`);
  console.log(`HubSpot Contact ID:    ${hubspotContactId}`);
  console.log(`Company Name:          ${companyName}`);
  console.log(`Contact Person:        ${contactName} <${contactEmail}>`);
  console.log(`Deal Amount:           AED ${amount.toLocaleString()}`);
  console.log(`Currency:              ${currencyCode}`);
  console.log(`Tax Percentage:        ${taxPercentage}% (VAT Disabled)`);
  console.log('==================================================\n');

  // Step 0: Connect to MongoDB Atlas
  console.log('[STEP 0] Connecting to MongoDB Atlas...');
  await connectDB();
  console.log('✔ Connected to MongoDB Atlas successfully.\n');

  // Step 1: Customer Resolution
  console.log('[STEP 1] Resolving NovaTech Customer in Zoho Books...');
  const customerResult = await CustomerService.resolveCustomer({
    hubspotCompanyId,
    hubspotContactId,
    companyName,
    contactName,
    contactEmail,
    crmDealId
  });

  if (customerResult.status !== 'RESOLVED' || !customerResult.zohoContactId) {
    const errorMsg = `Customer resolution failed with status '${customerResult.status}': ${customerResult.reason}`;
    console.error(`✖ ${errorMsg}`);
    throw new Error(errorMsg);
  }

  console.log('✔ Customer Resolution Complete:');
  console.log(`  - Zoho Contact ID:   ${customerResult.zohoContactId}`);
  console.log(`  - Zoho Contact Name: ${customerResult.zohoContactName}`);
  console.log(`  - Mapping Type:      ${customerResult.mappingType}`);
  console.log(`  - Resolved From Cache: ${customerResult.fromCache || false}\n`);

  // Step 2: Create & Confirm Sales Order Only (Tax: 0%)
  console.log('[STEP 2] Creating and Confirming Sales Order in Zoho Books...');
  const soResult = await SalesOrderService.createAndConfirmSalesOrder({
    crmDealId,
    zohoContactId: customerResult.zohoContactId,
    dealName,
    amount,
    currencyCode,
    taxPercentage
  });

  console.log('✔ Sales Order Processing Complete:');
  console.log(`  - Status:            ${soResult.status}`);
  console.log(`  - Sales Order ID:    ${soResult.zohoSalesOrderId}`);
  console.log(`  - Sales Order No:    ${soResult.zohoSalesOrderNumber}`);
  console.log(`  - Line Item ID:      ${soResult.zohoSalesOrderLineItemId || 'N/A'}`);
  console.log(`  - Currency:          ${soResult.currencyCode}`);
  console.log(`  - Subtotal:          AED ${(soResult.salesOrderSubtotal ?? soResult.salesOrderTotal)?.toLocaleString()}`);
  console.log(`  - Tax (0% VAT):      AED ${(soResult.salesOrderTax ?? 0)?.toLocaleString()}`);
  console.log(`  - Gross Total:       AED ${soResult.salesOrderTotal?.toLocaleString()}`);
  console.log(`  - From Cache:        ${soResult.fromCache || false}\n`);

  // Step 3: Post-Execution MongoDB Atlas Record Verification
  console.log('[STEP 3] Verifying MongoDB Atlas Records...');
  const mappingDoc = await CustomerMapping.findOne({ hubspotCompanyId });
  const syncDoc = await IntegrationSync.findOne({ crmDealId });
  const invoiceCount = await MilestoneInvoice.countDocuments({ crmDealId });
  const protectedEvent = await WebhookEvent.findOne({ eventId: 'hs_manual_test_01' });

  console.log('✔ CustomerMapping in Atlas:');
  console.log(`  - HubspotCompanyId:  ${mappingDoc?.hubspotCompanyId}`);
  console.log(`  - ZohoContactId:     ${mappingDoc?.zohoContactId}`);
  console.log(`  - Mapping Status:    ${mappingDoc?.status}`);
  console.log(`  - Mapping Type:      ${mappingDoc?.mappingType}`);

  console.log('✔ IntegrationSync in Atlas:');
  console.log(`  - CRM Deal ID:       ${syncDoc?.crmDealId}`);
  console.log(`  - Zoho Sales Order:  ${syncDoc?.zohoSalesOrderId} (${syncDoc?.zohoSalesOrderNumber})`);
  console.log(`  - Sales Order Status:${syncDoc?.salesOrderStatus}`);
  console.log(`  - Sync Status:       ${syncDoc?.syncStatus}`);
  console.log(`  - Subtotal:          AED ${syncDoc?.salesOrderSubtotal}`);
  console.log(`  - Tax:               AED ${syncDoc?.salesOrderTax}`);
  console.log(`  - Total:             AED ${syncDoc?.salesOrderTotal}`);
  console.log(`  - Lock Released:     ${syncDoc?.lockedBy === null ? 'YES (lockedBy: null)' : 'NO'}`);

  console.log('✔ Boundary Verification:');
  console.log(`  - Milestone Invoices Created: ${invoiceCount} (Must be 0)`);
  console.log(`  - Protected Event Status:     ${protectedEvent?.status} (Must be RECEIVED, attempts: ${protectedEvent?.attempts})`);

  if (invoiceCount !== 0) {
    console.error('CRITICAL: Invoice count is non-zero!');
  }

  console.log('\n==================================================');
  console.log('🛑 CONTROLLED STOP POINT REACHED: EXECUTION COMPLETE');
  console.log('==================================================\n');

  return {
    customerResult,
    soResult,
    mappingDoc,
    syncDoc,
    invoiceCount
  };
}

executeNovaTechSalesOrderOnly()
  .then(() => {
    return disconnectDB();
  })
  .then(() => {
    console.log('Disconnected from database. Exiting cleanly.');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n✖ EXECUTION FAILED:', err.message);
    if (err.code) console.error('  Error Code:', err.code);
    await disconnectDB();
    process.exit(1);
  });
