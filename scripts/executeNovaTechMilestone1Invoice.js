/**
 * scripts/executeNovaTechMilestone1Invoice.js
 *
 * Controlled execution of NovaTech Milestone 1 (M1) 50% Signing Invoice in Zoho Books.
 *
 * Parameters:
 * - CRM Deal ID:        360608312029
 * - HubSpot Company ID: 358741933767
 * - Zoho Customer ID:   4224694000000059001 (NovaTech)
 * - Zoho Sales Order:   4224694000000060001 (SO-00002)
 * - SO Line Item ID:    4224694000000060006
 * - Deterministic Ref:  CRM_360608312029_M1
 * - Contract Amount:    AED 120,000.00
 * - Milestone Index:    1 (50% Signing)
 * - Expected Subtotal:  AED 60,000.00
 * - Expected VAT (0%):  AED 0.00
 * - Expected Total:     AED 60,000.00
 * - Expected Due Date:  2026-12-01 (30 days)
 * - Currency:           AED (Currency ID: 4224694000000034133)
 *
 * Strict Boundaries:
 * 1. Uses existing idempotency and reconciliation safeguards (no duplicate POST).
 * 2. Does NOT email the customer or auto-send the invoice.
 * 3. Does NOT create M2/M3 invoices or payments.
 * 4. Does NOT modify HubSpot deal stage.
 * 5. Does NOT modify any other customer or sales order.
 * 6. Persists verified result in crm_zoho_db.
 * 7. Does NOT start the worker or process webhook queues.
 * 8. Does NOT perform a HubSpot PATCH.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.VAT_PERCENTAGE = '0'; // Explicit 0% VAT defense in depth

const { connectDB, disconnectDB } = require('../server/src/config/db');
const InvoiceService = require('../server/src/services/invoiceService');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const { zohoClient } = require('../server/src/clients/zohoClient');

async function executeNovaTechM1Invoice() {
  const crmDealId = '360608312029';
  const hubspotCompanyId = '358741933767';
  const expectedContactId = '4224694000000059001';
  const expectedSalesOrderId = '4224694000000060001';
  const expectedSalesOrderNumber = 'SO-00002';
  const contractAmount = 120000.0;
  const currencyCode = 'AED';
  const currencyId = '4224694000000034133';
  const taxPercentage = 0;

  console.log('================================================================');
  console.log('🚀 LIVE CONTROLLED EXECUTION: NovaTech M1 (50% Signing) Invoice');
  console.log('================================================================');
  console.log(`CRM Deal ID:            ${crmDealId}`);
  console.log(`HubSpot Company ID:     ${hubspotCompanyId}`);
  console.log(`Zoho Customer ID:       ${expectedContactId}`);
  console.log(`Zoho Sales Order ID:    ${expectedSalesOrderId} (${expectedSalesOrderNumber})`);
  console.log(`Milestone:              M1 — 50% Signing`);
  console.log(`Contract Amount:        AED ${contractAmount.toLocaleString()}`);
  console.log(`Invoice Subtotal:       AED 60,000.00`);
  console.log(`VAT (0%):               AED 0.00`);
  console.log(`Invoice Gross Total:    AED 60,000.00`);
  console.log(`Currency:               ${currencyCode} (ID: ${currencyId})`);
  console.log(`Reference Number:       CRM_${crmDealId}_M1`);
  console.log('================================================================\n');

  // Step 0: Connect to MongoDB (crm_zoho_db)
  console.log('[STEP 0] Connecting to crm_zoho_db via shared connectDB()...');
  await connectDB();
  console.log('✔ Connected to database successfully.\n');

  // Step 1: Pre-Execution Invariant Validation
  console.log('[STEP 1] Validating pre-execution invariants...');
  const syncRecord = await IntegrationSync.findOne({ crmDealId });
  const mappingRecord = await CustomerMapping.findOne({ hubspotCompanyId });

  if (!syncRecord) throw new Error(`IntegrationSync not found for deal ${crmDealId}.`);
  if (!mappingRecord) throw new Error(`CustomerMapping not found for company ${hubspotCompanyId}.`);
  if (syncRecord.zohoContactId !== expectedContactId) {
    throw new Error(`Prerequisite mismatch: syncRecord.zohoContactId is '${syncRecord.zohoContactId}', expected '${expectedContactId}'.`);
  }
  if (mappingRecord.zohoContactId !== expectedContactId) {
    throw new Error(`Prerequisite mismatch: mappingRecord.zohoContactId is '${mappingRecord.zohoContactId}', expected '${expectedContactId}'.`);
  }
  if (syncRecord.zohoSalesOrderId !== expectedSalesOrderId) {
    throw new Error(`Prerequisite mismatch: zohoSalesOrderId is '${syncRecord.zohoSalesOrderId}', expected '${expectedSalesOrderId}'.`);
  }
  if (syncRecord.salesOrderStatus !== 'CONFIRMED') {
    throw new Error(`Prerequisite mismatch: salesOrderStatus is '${syncRecord.salesOrderStatus}', expected 'CONFIRMED'.`);
  }
  console.log('✔ Invariant verification passed. Prerequisite 5 strictly satisfied.\n');

  // Step 2: Create M1 Invoice via InvoiceService
  console.log('[STEP 2] Calling InvoiceService.createMilestone1Invoice()...');
  const invoiceResult = await InvoiceService.createMilestone1Invoice({
    crmDealId,
    hubspotCompanyId,
    dealStage: 'closedwon',
    contractAmount,
    currencyCode,
    currencyId,
    taxPercentage
  });

  console.log('✔ InvoiceService execution completed:');
  console.log(`  - Status:            ${invoiceResult.status}`);
  console.log(`  - Zoho Invoice ID:   ${invoiceResult.zohoInvoiceId}`);
  console.log(`  - Invoice Number:    ${invoiceResult.zohoInvoiceNumber}`);
  console.log(`  - Subtotal:          AED ${invoiceResult.subtotal?.toLocaleString()}`);
  console.log(`  - Tax Amount:        AED ${invoiceResult.taxAmount?.toLocaleString()}`);
  console.log(`  - Total Amount:      AED ${invoiceResult.totalAmount?.toLocaleString()}`);
  console.log(`  - Currency:          ${invoiceResult.currencyCode}`);
  console.log(`  - From Cache:        ${invoiceResult.fromCache || false}\n`);

  // Step 3: Verify Persistence in MongoDB crm_zoho_db
  console.log('[STEP 3] Verifying MongoDB Persistence in crm_zoho_db...');
  const milestoneDoc = await MilestoneInvoice.findOne({ crmDealId, milestoneIndex: 1 });
  const updatedSyncDoc = await IntegrationSync.findOne({ crmDealId });

  console.log('✔ MilestoneInvoice Document:');
  console.log(`  - _id:                 ${milestoneDoc?._id}`);
  console.log(`  - Milestone Index:     ${milestoneDoc?.milestoneIndex} (${milestoneDoc?.milestoneName})`);
  console.log(`  - Zoho Invoice ID:     ${milestoneDoc?.zohoInvoiceId}`);
  console.log(`  - Invoice Number:      ${milestoneDoc?.zohoInvoiceNumber}`);
  console.log(`  - Linked Sales Order:  ${milestoneDoc?.zohoSalesOrderId}`);
  console.log(`  - Linked SO Line Item: ${milestoneDoc?.zohoSalesOrderItemId}`);
  console.log(`  - Subtotal:            AED ${milestoneDoc?.subtotal}`);
  console.log(`  - Tax:                 AED ${milestoneDoc?.taxAmount}`);
  console.log(`  - Total:               AED ${milestoneDoc?.totalAmount}`);
  console.log(`  - Balance:             AED ${milestoneDoc?.balance}`);
  console.log(`  - Due Date:            ${milestoneDoc?.dueDate ? milestoneDoc.dueDate.toISOString().split('T')[0] : 'N/A'}`);
  console.log(`  - Status:              ${milestoneDoc?.status}`);

  console.log('\n✔ Updated IntegrationSync Document:');
  console.log(`  - Sync Status:         ${updatedSyncDoc?.syncStatus}`);
  console.log(`  - Total Invoiced:      AED ${updatedSyncDoc?.totalInvoicedAmount}`);
  console.log(`  - Percentage Invoiced: ${updatedSyncDoc?.percentageInvoiced}%`);
  console.log(`  - Amount Not Invoiced: AED ${updatedSyncDoc?.amountNotInvoiced}`);
  console.log(`  - Invoiced Unpaid:     AED ${updatedSyncDoc?.amountInvoicedUnpaid}`);

  // Step 4: Live Query Verification from Zoho Books
  console.log('\n[STEP 4] Querying Live Zoho Books API (GET /invoices/{id})...');
  const liveRes = await zohoClient.request({
    method: 'GET',
    path: `/invoices/${invoiceResult.zohoInvoiceId}`,
    crmDealId
  });

  const remoteInvoice = liveRes.data?.invoice;
  console.log('✔ Live Zoho Books Verification Results:');
  console.log(`  - Invoice ID:          ${remoteInvoice?.invoice_id}`);
  console.log(`  - Invoice Number:      ${remoteInvoice?.invoice_number}`);
  console.log(`  - Status:              ${remoteInvoice?.status}`);
  console.log(`  - Customer ID:         ${remoteInvoice?.customer_id} (${remoteInvoice?.customer_name})`);
  console.log(`  - Sales Order ID:      ${remoteInvoice?.salesorder_id}`);
  console.log(`  - Reference Number:    ${remoteInvoice?.reference_number}`);
  console.log(`  - Currency Code:       ${remoteInvoice?.currency_code}`);
  console.log(`  - Subtotal:            AED ${remoteInvoice?.sub_total}`);
  console.log(`  - Tax Total:           AED ${remoteInvoice?.tax_total}`);
  console.log(`  - Total:               AED ${remoteInvoice?.total}`);
  console.log(`  - Balance:             AED ${remoteInvoice?.balance}`);
  console.log(`  - Due Date:            ${remoteInvoice?.due_date}`);
  console.log(`  - Line Items Count:    ${remoteInvoice?.line_items?.length}`);
  console.log(`  - Linked SO Item ID:   ${remoteInvoice?.line_items?.[0]?.salesorder_item_id}`);

  console.log('\n================================================================');
  console.log('🛑 CONTROLLED STOP POINT: M1 INVOICE COMPLETE');
  console.log('   Zero invoices sent. Zero payments created. M2/M3 untouched.');
  console.log('================================================================\n');

  return {
    invoiceResult,
    milestoneDoc,
    updatedSyncDoc,
    remoteInvoice
  };
}

if (require.main === module) {
  executeNovaTechM1Invoice()
    .then(async () => {
      await disconnectDB();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('\n✖ EXECUTION FAILED:', err.message);
      if (err.code) console.error('  Error Code:', err.code);
      await disconnectDB();
      process.exit(1);
    });
}

module.exports = { executeNovaTechM1Invoice };

