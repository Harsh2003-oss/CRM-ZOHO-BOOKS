const crypto = require('crypto');
const IntegrationSync = require('../models/IntegrationSync');
const CustomerMapping = require('../models/CustomerMapping');
const MilestoneInvoice = require('../models/MilestoneInvoice');
const SalesOrderService = require('./salesOrderService');
const { zohoClient } = require('../clients/zohoClient');

/**
 * InvoiceService handles deterministic, idempotent creation and linking
 * of milestone invoices (M1: 50% signing, M2: 30% go-live, M3: 20% 90 days) in Zoho Books.
 * Enforces strict prerequisite verification, integer minor units monetary math,
 * Sales Order line-item linking, pre-flight crash recovery, and worker concurrency leases.
 */
class InvoiceService {
  static MILESTONE_CONFIG = {
    1: { name: 'Signing', percentage: 50, refSuffix: 'M1', priorMilestones: [] },
    2: { name: 'Go-Live', percentage: 30, refSuffix: 'M2', priorMilestones: [1] },
    3: { name: '90 Days Post Go-Live', percentage: 20, refSuffix: 'M3', priorMilestones: [1, 2] }
  };

  /**
   * Generic milestone invoice creator supporting M1 (50%), M2 (30%), and M3 (20%).
   */
  static async createMilestoneInvoice({
    milestoneIndex = 1,
    crmDealId,
    hubspotCompanyId = null,
    dealStage = 'closedwon',
    contractAmount = 120000.0,
    currencyCode = 'AED',
    currencyId = null,
    taxId = null,
    taxPercentage = 5.0,
    workerId = null,
    leaseDurationMs = 5 * 60 * 1000,
    heartbeatIntervalMs = null,
    injectedZohoClient = null
  }) {
    if (!crmDealId) {
      throw new Error(`crmDealId is required to process M${milestoneIndex} Invoice.`);
    }

    const config = InvoiceService.MILESTONE_CONFIG[milestoneIndex];
    if (!config) {
      throw new Error(`Invalid milestoneIndex '${milestoneIndex}'. Must be 1, 2, or 3.`);
    }

    // =========================================================================
    // PREREQUISITE 1: Confirm CRM deal is Closed Won (required for all milestones)
    // =========================================================================
    const normalizedStage = String(dealStage || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (normalizedStage !== 'closedwon') {
      const err = new Error(
        `Prerequisite Failed: Deal ${crmDealId} is in stage '${dealStage}'. Milestone invoices can only be created for 'closedwon' deals.`
      );
      err.code = 'PREREQUISITE_FAILED_DEAL_NOT_CLOSED_WON';
      throw err;
    }

    // =========================================================================
    // PREREQUISITE 2: Confirm IntegrationSync record exists
    // =========================================================================
    const syncRecord = await IntegrationSync.findOne({ crmDealId });
    if (!syncRecord) {
      const err = new Error(`Prerequisite Failed: No IntegrationSync record found for deal ${crmDealId}.`);
      err.code = 'PREREQUISITE_FAILED_SYNC_RECORD_MISSING';
      throw err;
    }

    // =========================================================================
    // PREREQUISITE 3: Confirm CustomerMapping is ACTIVE
    // =========================================================================
    let customerMapping = null;
    const effectiveCompanyId = hubspotCompanyId || syncRecord.hubspotCompanyId;

    if (effectiveCompanyId) {
      customerMapping = await CustomerMapping.findOne({
        hubspotCompanyId: effectiveCompanyId,
        status: 'ACTIVE'
      });
    }

    if (!customerMapping && syncRecord.zohoContactId) {
      customerMapping = await CustomerMapping.findOne({
        zohoContactId: syncRecord.zohoContactId,
        status: 'ACTIVE'
      });
    }

    if (!customerMapping || customerMapping.status !== 'ACTIVE' || !customerMapping.zohoContactId) {
      const err = new Error(`Prerequisite Failed: CustomerMapping for deal ${crmDealId} is missing or not ACTIVE.`);
      err.code = 'PREREQUISITE_FAILED_CUSTOMER_NOT_ACTIVE';
      throw err;
    }

    // =========================================================================
    // PREREQUISITE 4: Confirm a valid confirmed Zoho Sales Order exists
    // =========================================================================
    if (syncRecord.salesOrderStatus !== 'CONFIRMED' || !syncRecord.zohoSalesOrderId) {
      const err = new Error(
        `Prerequisite Failed: Sales Order for deal ${crmDealId} is not CONFIRMED (status: '${syncRecord.salesOrderStatus}', id: '${syncRecord.zohoSalesOrderId}').`
      );
      err.code = 'PREREQUISITE_FAILED_SALES_ORDER_NOT_CONFIRMED';
      throw err;
    }

    // =========================================================================
    // PREREQUISITE 5: Confirm Sales Order belongs to expected customer
    // =========================================================================
    if (syncRecord.zohoContactId !== customerMapping.zohoContactId) {
      const err = new Error(
        `Prerequisite Failed: Sales Order customer '${syncRecord.zohoContactId}' does not match CustomerMapping customer '${customerMapping.zohoContactId}'.`
      );
      err.code = 'PREREQUISITE_FAILED_CUSTOMER_MISMATCH';
      throw err;
    }

    // =========================================================================
    // PREREQUISITE 6: Confirm Sales Order currency and contract amount
    // =========================================================================
    if (syncRecord.currencyCode !== currencyCode) {
      const err = new Error(
        `Prerequisite Failed: Sales Order currency '${syncRecord.currencyCode}' does not match expected currency '${currencyCode}'.`
      );
      err.code = 'PREREQUISITE_FAILED_CURRENCY_MISMATCH';
      throw err;
    }

    const contractSubtotalMinor = Math.round(Number(contractAmount) * 100);
    const soSubtotalMinor = Math.round(Number(syncRecord.salesOrderSubtotal) * 100);
    if (soSubtotalMinor !== contractSubtotalMinor) {
      const err = new Error(
        `Prerequisite Failed: Sales Order subtotal (${syncRecord.salesOrderSubtotal}) does not match expected contract amount (${contractAmount}).`
      );
      err.code = 'PREREQUISITE_FAILED_AMOUNT_MISMATCH';
      throw err;
    }

    // =========================================================================
    // PREREQUISITE 7: Check Reconciliation & Prior Milestones
    // =========================================================================
    for (const priorIndex of config.priorMilestones) {
      const priorM = await MilestoneInvoice.findOne({ crmDealId, milestoneIndex: priorIndex });
      if (!priorM || !['CREATED', 'SENT', 'PAID'].includes(priorM.status)) {
        const err = new Error(
          `Prerequisite Failed: Prior Milestone M${priorIndex} must be confirmed before creating M${milestoneIndex} invoice.`
        );
        err.code = 'PREREQUISITE_FAILED_PRIOR_MILESTONE_NOT_CONFIRMED';
        throw err;
      }
      if (priorM.status === 'PENDING_RECONCILIATION') {
        const err = new Error(
          `Prerequisite Failed: Prior Milestone M${priorIndex} is in PENDING_RECONCILIATION state. Reconciliation required before M${milestoneIndex}.`
        );
        err.code = 'INVOICE_RECONCILIATION_BLOCKED';
        throw err;
      }
    }

    // =========================================================================
    // PREREQUISITE 8: Check Idempotency - Confirm milestone not already created
    // =========================================================================
    const existingM = await MilestoneInvoice.findOne({ crmDealId, milestoneIndex });
    if (
      existingM &&
      existingM.zohoInvoiceId &&
      (existingM.status === 'CREATED' || existingM.status === 'SENT' || existingM.status === 'PAID')
    ) {
      return {
        status: 'ALREADY_CREATED',
        zohoInvoiceId: existingM.zohoInvoiceId,
        zohoInvoiceNumber: existingM.zohoInvoiceNumber,
        totalAmount: existingM.totalAmount,
        subtotal: existingM.subtotal,
        taxAmount: existingM.taxAmount,
        currencyCode: existingM.currencyCode,
        fromCache: true,
        milestoneInvoice: existingM
      };
    }

    // =========================================================================
    // DISTRIBUTED LOCKING: Generate unique execution UUID & acquire lease
    // =========================================================================
    const executionId = crypto.randomUUID();
    const executionWorkerId = workerId
      ? `${workerId}_${executionId}`
      : `worker_${process.pid}_${executionId}`;

    const client = injectedZohoClient || zohoClient;
    const deterministicRef = `CRM_${crmDealId}_${config.refSuffix}`;

    await SalesOrderService.acquireDealLock(crmDealId, executionWorkerId, leaseDurationMs);

    // Lease heartbeat renewal
    const effectiveHeartbeatInterval =
      heartbeatIntervalMs !== null
        ? heartbeatIntervalMs
        : Math.min(30000, Math.floor(leaseDurationMs / 3));

    let heartbeatTimer = null;
    if (effectiveHeartbeatInterval > 0) {
      heartbeatTimer = setInterval(async () => {
        try {
          await SalesOrderService.renewDealLock(crmDealId, executionWorkerId, leaseDurationMs);
        } catch (e) {
          console.warn(`[INVOICE HEARTBEAT] Failed to renew lease for deal ${crmDealId}:`, e.message);
        }
      }, effectiveHeartbeatInterval);
      if (heartbeatTimer.unref) {
        heartbeatTimer.unref();
      }
    }

    try {
      // =======================================================================
      // STEP 1: Identify Sales Order line item ID for line-item linking
      // =======================================================================
      let salesOrderItemId = syncRecord.zohoSalesOrderLineItemId;
      if (!salesOrderItemId) {
        const soRes = await client.request({
          method: 'GET',
          path: `/salesorders/${syncRecord.zohoSalesOrderId}`,
          crmDealId
        });

        const soData = soRes.data?.salesorder;
        if (!soData || !soData.line_items || soData.line_items.length === 0) {
          const err = new Error(
            `Prerequisite Failed: Sales Order ${syncRecord.zohoSalesOrderId} has no line items for linking.`
          );
          err.code = 'PREREQUISITE_FAILED_MISSING_LINE_ITEM';
          await IntegrationSync.findOneAndUpdate(
            { crmDealId, lockedBy: executionWorkerId },
            { $set: { syncStatus: 'FAILED', failureReason: err.message } }
          );
          throw err;
        }

        salesOrderItemId = soData.line_items[0].line_item_id;
        await IntegrationSync.updateOne(
          { crmDealId },
          { $set: { zohoSalesOrderLineItemId: salesOrderItemId } }
        );
      }

      // =======================================================================
      // STEP 2: Financial calculations using integer minor units (fils)
      // M1 = 50% (AED 60,000 subtotal, AED 3,000 VAT, AED 63,000 gross)
      // M2 = 30% (AED 36,000 subtotal, AED 1,800 VAT, AED 37,800 gross)
      // M3 = 20% (AED 24,000 subtotal, AED 1,200 VAT, AED 25,200 gross)
      // Subtotals sum exactly to AED 120,000.00 (100.0%)
      // =======================================================================
      const mSubtotalMinor = Math.round((contractSubtotalMinor * config.percentage) / 100);
      const mTaxMinor = Math.round((mSubtotalMinor * taxPercentage) / 100);
      const mGrossMinor = mSubtotalMinor + mTaxMinor;

      const expectedSubtotal = mSubtotalMinor / 100;
      const expectedTax = mTaxMinor / 100;
      const expectedGross = mGrossMinor / 100;

      // =======================================================================
      // STEP 3: Pre-flight remote search by deterministic reference number
      // =======================================================================
      const searchRes = await client.request({
        method: 'GET',
        path: `/invoices?reference_number=${encodeURIComponent(deterministicRef)}`,
        crmDealId
      });

      const matchedInvoices = searchRes.data?.invoices || [];

      if (matchedInvoices.length > 1) {
        const err = new Error(
          `Conflict: Multiple matching Invoices (${matchedInvoices.length}) found in Zoho Books for reference ${deterministicRef}. Manual reconciliation required.`
        );
        err.code = 'DUPLICATE_REMOTE_INVOICES';
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, lockedBy: executionWorkerId },
          { $set: { syncStatus: 'FAILED', failureReason: err.message } }
        );
        throw err;
      }

      let targetInvoice = null;

      if (matchedInvoices.length === 1) {
        targetInvoice = matchedInvoices[0];
        console.log(`[INVOICE RECOVERY] Adopted existing remote Invoice ${targetInvoice.invoice_id} for deal ${crmDealId}`);
      } else if (syncRecord.syncStatus === 'RECONCILIATION_REQUIRED') {
        const err = new Error(
          `Cannot create invoice: Deal ${crmDealId} is in RECONCILIATION_REQUIRED state. Pre-flight remote lookup returned 0 matching invoices. Operator resolution required before retry.`
        );
        err.code = 'INVOICE_RECONCILIATION_BLOCKED';
        throw err;
      } else {
        // =====================================================================
        // STEP 4: Create new Milestone invoice in Zoho Books
        // =====================================================================
        const configuredTaxId = taxId || process.env.ZOHO_BOOKS_UAE_VAT_TAX_ID || null;

        const lineItem = {
          salesorder_item_id: salesOrderItemId,
          name: `Milestone ${milestoneIndex}: ${config.percentage}% ${config.name}`,
          description: `${config.percentage}% Milestone invoice (${config.name}) for CRM Deal ${crmDealId}`,
          rate: expectedSubtotal,
          quantity: 1
        };

        if (configuredTaxId) {
          lineItem.tax_id = configuredTaxId;
          lineItem.tax_percentage = taxPercentage;
        }

        const createPayload = {
          customer_id: customerMapping.zohoContactId,
          salesorder_id: syncRecord.zohoSalesOrderId,
          reference_number: deterministicRef,
          date: new Date().toISOString().split('T')[0],
          due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          line_items: [lineItem],
          notes: `Milestone ${milestoneIndex}: ${config.percentage}% ${config.name} invoice for deal ${crmDealId}. Subtotal: AED ${(mSubtotalMinor / 100).toFixed(2)}, 5% VAT: AED ${(mTaxMinor / 100).toFixed(2)}, Gross: AED ${(mGrossMinor / 100).toFixed(2)}.`
        };

        if (currencyId) {
          createPayload.currency_id = currencyId;
        }

        let createRes;
        try {
          createRes = await client.request({
            method: 'POST',
            path: '/invoices',
            body: createPayload,
            crmDealId
          });
        } catch (postErr) {
          console.warn(`[RECONCILIATION] POST /invoices failed (${postErr.message}). Reconciling via remote reference ${deterministicRef}...`);
          const reconcileRes = await client.request({
            method: 'GET',
            path: `/invoices?reference_number=${encodeURIComponent(deterministicRef)}`,
            crmDealId
          });

          const reconciledInvoices = reconcileRes.data?.invoices || [];
          if (reconciledInvoices.length === 1) {
            console.log(`[RECONCILIATION SUCCESS] Adopted Invoice ${reconciledInvoices[0].invoice_id} created despite POST error.`);
            targetInvoice = reconciledInvoices[0];
          } else if (reconciledInvoices.length > 1) {
            const conflictErr = new Error(`Conflict: Multiple matching Invoices (${reconciledInvoices.length}) found during post-error reconciliation.`);
            conflictErr.code = 'DUPLICATE_REMOTE_INVOICES';
            await IntegrationSync.findOneAndUpdate(
              { crmDealId, lockedBy: executionWorkerId },
              { $set: { syncStatus: 'FAILED', failureReason: conflictErr.message } }
            );
            throw conflictErr;
          } else {
            await IntegrationSync.findOneAndUpdate(
              { crmDealId, lockedBy: executionWorkerId },
              {
                $set: {
                  syncStatus: 'RECONCILIATION_REQUIRED',
                  reconciliationMilestoneIndex: milestoneIndex,
                  reconciliationReason: `Uncertain POST outcome: ${postErr.message}. Immediate lookup returned 0. Remote invoice may still be committing.`,
                  reconciliationRequestedAt: new Date(),
                  failureReason: postErr.message
                }
              }
            );

            await MilestoneInvoice.findOneAndUpdate(
              { crmDealId, milestoneIndex },
              {
                $set: {
                  syncId: syncRecord._id,
                  milestoneName: config.name,
                  percentage: config.percentage,
                  subtotal: expectedSubtotal,
                  taxAmount: expectedTax,
                  totalAmount: expectedGross,
                  status: 'PENDING_RECONCILIATION',
                  referenceNumber: deterministicRef,
                  failureReason: postErr.message
                }
              },
              { upsert: true }
            );

            const timeoutErr = new Error(
              `POST /invoices encountered uncertain outcome (${postErr.message}). Immediate lookup returned 0. Deal placed in RECONCILIATION_REQUIRED state.`
            );
            timeoutErr.code = 'INVOICE_RECONCILIATION_REQUIRED';
            throw timeoutErr;
          }
        }

        if (!targetInvoice) {
          if (!createRes || !createRes.data || !createRes.data.invoice) {
            const err = new Error(createRes?.data?.message || 'Zoho Books returned an empty or invalid invoice response.');
            err.code = 'ZOHO_INVOICE_CREATE_FAILED';
            await IntegrationSync.findOneAndUpdate(
              { crmDealId, lockedBy: executionWorkerId },
              { $set: { syncStatus: 'FAILED', failureReason: err.message } }
            );
            throw err;
          }
          targetInvoice = createRes.data.invoice;
        }
      }

      // =======================================================================
      // STEP 4B: Strict Line-Item Association and Financial Verification
      // =======================================================================
      if (!targetInvoice.salesorder_id) {
        const err = new Error(
          `Sales Order Linkage Failed: Returned Invoice ${targetInvoice.invoice_id} is missing required 'salesorder_id'.`
        );
        err.code = 'INVOICE_MISSING_SALES_ORDER_ID';
        await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
        throw err;
      }

      if (targetInvoice.salesorder_id !== syncRecord.zohoSalesOrderId) {
        const err = new Error(
          `Sales Order Linkage Failed: Returned Invoice ${targetInvoice.invoice_id} has salesorder_id '${targetInvoice.salesorder_id}', expected '${syncRecord.zohoSalesOrderId}'.`
        );
        err.code = 'INVOICE_SALES_ORDER_MISMATCH';
        await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
        throw err;
      }

      if (!targetInvoice.line_items || !Array.isArray(targetInvoice.line_items) || targetInvoice.line_items.length === 0) {
        const err = new Error(
          `Sales Order Line-Item Linkage Failed: Returned Invoice ${targetInvoice.invoice_id} contains no line items.`
        );
        err.code = 'INVOICE_MISSING_LINE_ITEMS';
        await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
        throw err;
      }

      const matchingLineItem = targetInvoice.line_items.find(
        (item) => item.salesorder_item_id === salesOrderItemId
      );

      if (!matchingLineItem) {
        const hasAnySoItemId = targetInvoice.line_items.some((item) => item.salesorder_item_id);
        if (!hasAnySoItemId) {
          const err = new Error(
            `Sales Order Line-Item Linkage Failed: Returned Invoice ${targetInvoice.invoice_id} line items do not contain required 'salesorder_item_id' (expected '${salesOrderItemId}').`
          );
          err.code = 'INVOICE_MISSING_SALES_ORDER_ITEM_ID';
          await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
          throw err;
        } else {
          const returnedItemId = targetInvoice.line_items[0].salesorder_item_id;
          const err = new Error(
            `Sales Order Line-Item Linkage Failed: Returned Invoice line item is linked to salesorder_item_id '${returnedItemId}', expected '${salesOrderItemId}'.`
          );
          err.code = 'INVOICE_SALES_ORDER_ITEM_MISMATCH';
          await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
          throw err;
        }
      }

      const itemRateMinor = Math.round(Number(matchingLineItem.rate ?? matchingLineItem.item_total ?? 0) * 100);
      if (itemRateMinor !== mSubtotalMinor) {
        const err = new Error(
          `Sales Order Line-Item Amount Failed: Line item associated with salesorder_item_id '${salesOrderItemId}' has rate ${(itemRateMinor / 100).toFixed(2)}, expected M${milestoneIndex} subtotal ${(mSubtotalMinor / 100).toFixed(2)}.`
        );
        err.code = 'INVOICE_LINE_ITEM_AMOUNT_MISMATCH';
        await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
        throw err;
      }

      if (!targetInvoice.currency_code || typeof targetInvoice.currency_code !== 'string' || !targetInvoice.currency_code.trim()) {
        const err = new Error("Invoice validation failed: Zoho Books response is missing required 'currency_code'.");
        err.code = 'INVOICE_MISSING_CURRENCY';
        await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
        throw err;
      }

      const actualCurrency = targetInvoice.currency_code.trim();
      if (actualCurrency !== currencyCode) {
        const err = new Error(
          `Financial/Currency Validation Failed: Returned Currency '${actualCurrency}' does not match expected Currency '${currencyCode}'.`
        );
        err.code = 'INVOICE_CURRENCY_MISMATCH';
        await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
        throw err;
      }

      const actualSubtotalMinor = Math.round(Number(targetInvoice.sub_total || 0) * 100);
      const actualTaxMinor = Math.round(Number(targetInvoice.tax_total || 0) * 100);
      const actualGrossMinor = Math.round(Number(targetInvoice.total || 0) * 100);

      if (
        actualSubtotalMinor !== mSubtotalMinor ||
        actualTaxMinor !== mTaxMinor ||
        actualGrossMinor !== mGrossMinor
      ) {
        const err = new Error(
          `Invoice Financial Validation Failed: Returned Subtotal=${(actualSubtotalMinor / 100).toFixed(2)}, Tax=${(actualTaxMinor / 100).toFixed(2)}, Gross=${(actualGrossMinor / 100).toFixed(2)}. Expected Subtotal=${(mSubtotalMinor / 100).toFixed(2)}, Tax=${(mTaxMinor / 100).toFixed(2)}, Gross=${(mGrossMinor / 100).toFixed(2)}.`
        );
        err.code = 'INVOICE_FINANCIAL_VALIDATION_FAILED';
        await InvoiceService._handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, err.message, milestoneIndex);
        throw err;
      }

      // =======================================================================
      // STEP 5: Persist in MilestoneInvoice and update IntegrationSync
      // =======================================================================
      const milestoneRecord = await MilestoneInvoice.findOneAndUpdate(
        { crmDealId, milestoneIndex },
        {
          $set: {
            syncId: syncRecord._id,
            milestoneName: config.name,
            percentage: config.percentage,
            subtotal: expectedSubtotal,
            taxAmount: expectedTax,
            totalAmount: expectedGross,
            balance: (targetInvoice.balance !== undefined && targetInvoice.balance !== null && !isNaN(targetInvoice.balance))
              ? Number(targetInvoice.balance)
              : null,
            dueDate: targetInvoice.due_date ? new Date(targetInvoice.due_date) : null,
            zohoInvoiceId: targetInvoice.invoice_id,
            zohoInvoiceNumber: targetInvoice.invoice_number,
            zohoSalesOrderId: syncRecord.zohoSalesOrderId,
            zohoSalesOrderItemId: salesOrderItemId,
            referenceNumber: deterministicRef,
            currencyCode: actualCurrency,
            status: 'CREATED'
          }
        },
        { upsert: true, returnDocument: 'after' }
      );

      // Aggregate cumulative confirmed milestone invoices
      const confirmedMilestones = await MilestoneInvoice.find({
        crmDealId,
        status: { $in: ['CREATED', 'SENT', 'PAID', 'PARTIALLY_PAID'] }
      });

      const cumulativeGrossMinor = confirmedMilestones.reduce(
        (sum, m) => sum + Math.round(Number(m.totalAmount || 0) * 100),
        0
      );

      const soGrossMinor = Math.round(Number(syncRecord.salesOrderTotal) * 100);
      const remainingNotInvoicedMinor = Math.max(0, soGrossMinor - cumulativeGrossMinor);
      const remainingNotInvoiced = remainingNotInvoicedMinor / 100;
      const cumulativePercentage = soGrossMinor > 0 ? Math.round((cumulativeGrossMinor / soGrossMinor) * 10000) / 100 : 0;

      const nextSyncStatus = milestoneIndex === 1 ? 'M1_INVOICED' : (milestoneIndex === 2 ? 'M2_INVOICED' : 'M3_INVOICED');

      const updatedSync = await IntegrationSync.findOneAndUpdate(
        {
          crmDealId,
          lockedBy: executionWorkerId,
          leaseExpiresAt: { $gt: new Date() }
        },
        {
          $set: {
            totalInvoicedAmount: cumulativeGrossMinor / 100,
            percentageInvoiced: cumulativePercentage,
            amountNotInvoiced: remainingNotInvoiced,
            amountInvoicedUnpaid: cumulativeGrossMinor / 100,
            syncStatus: nextSyncStatus,
            reconciliationReason: null,
            reconciliationRequestedAt: null,
            reconciliationMilestoneIndex: null,
            failureReason: null
          }
        },
        { returnDocument: 'after' }
      );

      if (!updatedSync) {
        const staleErr = new Error(
          `Fencing Guard: Worker ${executionWorkerId} lease expired or was preempted by another worker. Invoice state write aborted.`
        );
        staleErr.code = 'WORKER_LEASE_FENCED';
        throw staleErr;
      }

      return {
        status: 'CREATED',
        milestoneIndex,
        zohoInvoiceId: targetInvoice.invoice_id,
        zohoInvoiceNumber: targetInvoice.invoice_number,
        subtotal: expectedSubtotal,
        taxAmount: expectedTax,
        totalAmount: expectedGross,
        currencyCode: actualCurrency,
        milestoneInvoice: milestoneRecord,
        sync: updatedSync
      };
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      await SalesOrderService.releaseDealLock(crmDealId, executionWorkerId);
    }
  }

  static async createMilestone1Invoice(params) {
    return this.createMilestoneInvoice({ ...params, milestoneIndex: 1 });
  }

  static async createMilestone2Invoice(params) {
    return this.createMilestoneInvoice({ ...params, milestoneIndex: 2 });
  }

  static async createMilestone3Invoice(params) {
    return this.createMilestoneInvoice({ ...params, milestoneIndex: 3 });
  }

  /**
   * Safe operator-resolution path for deals in RECONCILIATION_REQUIRED state.
   */
  static async resolveReconciliation({
    crmDealId,
    milestoneIndex = 1,
    resolution,
    chosenZohoInvoiceId = null,
    injectedZohoClient = null
  }) {
    if (!['NO_REMOTE_INVOICE_CONFIRMED', 'ADOPT_INVOICE'].includes(resolution)) {
      throw new Error(`Invalid resolution type '${resolution}'. Must be 'NO_REMOTE_INVOICE_CONFIRMED' or 'ADOPT_INVOICE'.`);
    }

    const syncRecord = await IntegrationSync.findOne({ crmDealId });
    if (!syncRecord || syncRecord.syncStatus !== 'RECONCILIATION_REQUIRED') {
      const err = new Error(`Cannot resolve reconciliation for deal ${crmDealId}: Deal is not in RECONCILIATION_REQUIRED state.`);
      err.code = 'DEAL_NOT_IN_RECONCILIATION_STATE';
      throw err;
    }

    const mIndex = milestoneIndex || syncRecord.reconciliationMilestoneIndex || 1;

    if (resolution === 'NO_REMOTE_INVOICE_CONFIRMED') {
      const fallbackStatus = mIndex === 1 ? 'SALES_ORDER_CONFIRMED' : (mIndex === 2 ? 'M1_INVOICED' : 'M2_INVOICED');
      await IntegrationSync.updateOne(
        { crmDealId },
        {
          $set: {
            syncStatus: fallbackStatus,
            reconciliationReason: null,
            reconciliationRequestedAt: null,
            reconciliationMilestoneIndex: null,
            failureReason: null
          }
        }
      );
      await MilestoneInvoice.deleteOne({ crmDealId, milestoneIndex: mIndex, status: 'PENDING_RECONCILIATION' });
      return { status: 'RECONCILIATION_CLEARED', crmDealId, milestoneIndex: mIndex, action: `RESET_TO_${fallbackStatus}` };
    }

    if (resolution === 'ADOPT_INVOICE') {
      if (!chosenZohoInvoiceId) {
        throw new Error("chosenZohoInvoiceId is required when resolution is 'ADOPT_INVOICE'.");
      }
      const client = injectedZohoClient || zohoClient;
      const invRes = await client.request({
        method: 'GET',
        path: `/invoices/${chosenZohoInvoiceId}`,
        crmDealId
      });
      const invoiceData = invRes.data?.invoice;
      if (!invoiceData) {
        throw new Error(`Invoice ${chosenZohoInvoiceId} could not be retrieved from Zoho Books.`);
      }

      await MilestoneInvoice.findOneAndUpdate(
        { crmDealId, milestoneIndex: mIndex },
        {
          $set: {
            zohoInvoiceId: invoiceData.invoice_id,
            zohoInvoiceNumber: invoiceData.invoice_number,
            totalAmount: Number(invoiceData.total || 0),
            subtotal: Number(invoiceData.sub_total || 0),
            taxAmount: Number(invoiceData.tax_total || 0),
            balance: Number(invoiceData.balance || 0),
            dueDate: invoiceData.due_date ? new Date(invoiceData.due_date) : null,
            currencyCode: invoiceData.currency_code || 'AED',
            status: 'CREATED'
          }
        },
        { upsert: true }
      );

      const targetStatus = mIndex === 1 ? 'M1_INVOICED' : (mIndex === 2 ? 'M2_INVOICED' : 'M3_INVOICED');
      const allConfirmed = await MilestoneInvoice.find({ crmDealId, status: { $in: ['CREATED', 'SENT', 'PAID', 'PARTIALLY_PAID'] } });
      const totalInvoicedMinor = allConfirmed.reduce((sum, inv) => sum + Math.round(Number(inv.totalAmount || 0) * 100), 0);
      const soGrossMinor = Math.round(Number(syncRecord.salesOrderTotal || 126000) * 100);
      const remainingNotInvoicedMinor = Math.max(0, soGrossMinor - totalInvoicedMinor);

      await IntegrationSync.updateOne(
        { crmDealId },
        {
          $set: {
            percentageInvoiced: Math.round((totalInvoicedMinor / soGrossMinor) * 10000) / 100,
            amountNotInvoiced: remainingNotInvoicedMinor / 100,
            totalInvoicedAmount: totalInvoicedMinor / 100,
            amountInvoicedUnpaid: totalInvoicedMinor / 100,
            syncStatus: targetStatus,
            reconciliationReason: null,
            reconciliationRequestedAt: null,
            reconciliationMilestoneIndex: null,
            failureReason: null
          }
        }
      );

      return { status: 'ADOPTED', crmDealId, milestoneIndex: mIndex, zohoInvoiceId: invoiceData.invoice_id };
    }
  }

  /**
   * Handles failure when a returned invoice has missing or mismatched Sales Order associations.
   */
  static async _handleAssociationFailure(crmDealId, executionWorkerId, deterministicRef, targetInvoice, failureReason, milestoneIndex = 1) {
    await IntegrationSync.findOneAndUpdate(
      { crmDealId, lockedBy: executionWorkerId },
      {
        $set: {
          syncStatus: 'FAILED',
          failureReason
        }
      }
    );

    if (targetInvoice && targetInvoice.invoice_id) {
      await MilestoneInvoice.findOneAndUpdate(
        { crmDealId, milestoneIndex },
        {
          $set: {
            zohoInvoiceId: targetInvoice.invoice_id,
            zohoInvoiceNumber: targetInvoice.invoice_number,
            zohoSalesOrderId: targetInvoice.salesorder_id || null,
            zohoSalesOrderItemId: targetInvoice.line_items?.[0]?.salesorder_item_id || null,
            totalAmount: Number(targetInvoice.total || 0),
            subtotal: Number(targetInvoice.sub_total || 0),
            taxAmount: Number(targetInvoice.tax_total || 0),
            balance: Number(targetInvoice.balance || 0),
            status: 'FAILED_VALIDATION',
            referenceNumber: deterministicRef,
            failureReason
          }
        },
        { upsert: true }
      );
    }
  }
}

module.exports = InvoiceService;
