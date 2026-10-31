const crypto = require('crypto');
const IntegrationSync = require('../models/IntegrationSync');
const { zohoClient } = require('../clients/zohoClient');

/**
 * SalesOrderService handles deterministic, idempotent creation and confirmation
 * of Zoho Books Sales Orders for HubSpot deals.
 * Enforces strict financial assertions, pre-flight crash recovery, and worker concurrency leases.
 */
class SalesOrderService {
  /**
   * Acquires a lease-based lock on an IntegrationSync record to prevent concurrent workers
   * from processing the same CRM deal simultaneously.
   * @param {string} crmDealId
   * @param {string|null} workerId - execution worker ID (must be unique per execution)
   * @param {number} leaseDurationMs - default 5 minutes
   */
  static async acquireDealLock(crmDealId, workerId = null, leaseDurationMs = 5 * 60 * 1000) {
    const effectiveWorkerId = workerId || `worker_${process.pid}_${crypto.randomUUID()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);

    // 1. Try to claim existing unlocked, lease-expired, or already owned record
    let lockedSync = await IntegrationSync.findOneAndUpdate(
      {
        crmDealId,
        $or: [
          { lockedBy: null },
          { leaseExpiresAt: { $lt: now } }, // Expired lease recovery
          { lockedBy: effectiveWorkerId }
        ]
      },
      {
        $set: {
          lockedBy: effectiveWorkerId,
          lockedAt: now,
          leaseExpiresAt: expiresAt
        }
      },
      { returnDocument: 'after' }
    );

    // 2. If no record was updated, check if document exists or create a new locked record
    if (!lockedSync) {
      const exists = await IntegrationSync.findOne({ crmDealId });
      if (!exists) {
        try {
          lockedSync = await IntegrationSync.create({
            crmDealId,
            lockedBy: effectiveWorkerId,
            lockedAt: now,
            leaseExpiresAt: expiresAt,
            syncStatus: 'PROCESSING'
          });
        } catch (err) {
          if (err.code === 11000) {
            // Another worker won the insert race
            const conflictErr = new Error(`Concurrent execution conflict: Deal ${crmDealId} is currently locked by another worker.`);
            conflictErr.code = 'DEAL_LOCKED_BY_ANOTHER_WORKER';
            throw conflictErr;
          }
          throw err;
        }
      } else {
        // Document exists and is actively locked by another worker
        const conflictErr = new Error(`Concurrent execution conflict: Deal ${crmDealId} is currently locked by another worker.`);
        conflictErr.code = 'DEAL_LOCKED_BY_ANOTHER_WORKER';
        throw conflictErr;
      }
    }

    return lockedSync;
  }

  /**
   * Renews an active lease for a worker.
   * Strictly requires:
   * 1. crmDealId matches
   * 2. lockedBy matches effectiveWorkerId
   * 3. Current lease is not already expired (leaseExpiresAt > now)
   */
  static async renewDealLock(crmDealId, workerId, leaseDurationMs = 5 * 60 * 1000) {
    if (!crmDealId || !workerId) return null;
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + leaseDurationMs);

    return await IntegrationSync.findOneAndUpdate(
      {
        crmDealId,
        lockedBy: workerId,
        leaseExpiresAt: { $gt: now }
      },
      {
        $set: {
          leaseExpiresAt: newExpiresAt,
          lockedAt: now
        }
      },
      { returnDocument: 'after' }
    );
  }

  /**
   * Releases the worker lock on an IntegrationSync record.
   * Ensures a worker can ONLY release its own lock.
   */
  static async releaseDealLock(crmDealId, workerId) {
    if (!workerId) return;
    await IntegrationSync.findOneAndUpdate(
      { crmDealId, lockedBy: workerId },
      {
        $set: {
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null
        }
      }
    );
  }

  /**
   * Executes the complete safe Sales Order transaction sequence:
   * 1. Validate customer resolution prerequisite.
   * 2. Pre-flight search: 0 matches -> create draft, 1 match -> recover, >1 -> conflict error.
   * 3. Validate financial totals using integer minor units (Subtotal 120,000, VAT 6,000, Gross 126,000).
   * 4. Persist DRAFT status in MongoDB with fencing check.
   * 5. Confirm Sales Order.
   * 6. Verify confirmed status and persist CONFIRMED in MongoDB with fencing check.
   */
  static async createAndConfirmSalesOrder({
    crmDealId,
    zohoContactId,
    dealName = 'Enterprise Software Deal',
    amount = 120000.0,
    currencyCode = 'AED',
    currencyId = null,
    taxId = null,
    taxPercentage = 5.0,
    itemId = null,
    workerId = null,
    leaseDurationMs = 5 * 60 * 1000,
    heartbeatIntervalMs = null,
    injectedZohoClient = null
  }) {
    if (!crmDealId) {
      throw new Error('crmDealId is required to process Sales Order.');
    }

    // Always generate an internal unique execution ID even if caller provided workerId
    // Retains caller's prefix for tracing but guarantees zero shared worker IDs across concurrent callers
    const executionId = crypto.randomUUID();
    const executionWorkerId = workerId
      ? `${workerId}_${executionId}`
      : `worker_${process.pid}_${executionId}`;

    // Step 0: Check idempotency before acquiring lock (return cached result immediately)
    const existingSync = await IntegrationSync.findOne({ crmDealId });
    if (existingSync && existingSync.salesOrderStatus === 'CONFIRMED' && existingSync.zohoSalesOrderId) {
      if (existingSync.syncStatus !== 'SALES_ORDER_CONFIRMED') {
        await IntegrationSync.updateOne(
          { crmDealId },
          { $set: { syncStatus: 'SALES_ORDER_CONFIRMED' } }
        );
      }
      return {
        status: 'ALREADY_CONFIRMED',
        zohoSalesOrderId: existingSync.zohoSalesOrderId,
        zohoSalesOrderNumber: existingSync.zohoSalesOrderNumber,
        salesOrderTotal: existingSync.salesOrderTotal,
        fromCache: true
      };
    }

    // Requirement: Customer mapping must be successfully resolved
    if (!zohoContactId) {
      const err = new Error(`Cannot create Sales Order for deal ${crmDealId}: Zoho Customer ID is missing or unresolved.`);
      err.code = 'CUSTOMER_NOT_RESOLVED';
      throw err;
    }

    const client = injectedZohoClient || zohoClient;
    const deterministicRef = `CRM_${crmDealId}`;

    // Acquire atomic worker lease with unique execution worker ID
    await this.acquireDealLock(crmDealId, executionWorkerId, leaseDurationMs);

    // Transition sync status to PROCESSING
    await IntegrationSync.findOneAndUpdate(
      { crmDealId, lockedBy: executionWorkerId },
      { $set: { syncStatus: 'PROCESSING' } }
    );

    // Start background lease heartbeat to prevent expiration during long Zoho operations
    const effectiveHeartbeatInterval = heartbeatIntervalMs !== null
      ? heartbeatIntervalMs
      : Math.min(30000, Math.floor(leaseDurationMs / 3));

    let heartbeatTimer = null;
    if (effectiveHeartbeatInterval > 0) {
      heartbeatTimer = setInterval(async () => {
        try {
          await SalesOrderService.renewDealLock(crmDealId, executionWorkerId, leaseDurationMs);
        } catch (e) {
          console.warn(`[WORKER HEARTBEAT] Failed to renew lease for deal ${crmDealId}:`, e.message);
        }
      }, effectiveHeartbeatInterval);
      if (heartbeatTimer.unref) {
        heartbeatTimer.unref();
      }
    }

    try {
      // Precise mathematical calculation using integer minor units (fils / cents)
      const subtotalMinor = Math.round(Number(amount) * 100);
      const taxMinor = Math.round(subtotalMinor * (taxPercentage / 100));
      const grossMinor = subtotalMinor + taxMinor;

      const expectedSubtotal = subtotalMinor / 100;
      const expectedTax = taxMinor / 100;
      const expectedGross = grossMinor / 100;

      // Step 1: Pre-flight remote search using deterministic reference
      const searchRes = await client.request({
        method: 'GET',
        path: `/salesorders?reference_number=${encodeURIComponent(deterministicRef)}`,
        crmDealId
      });

      const matchedOrders = searchRes.data?.salesorders || [];

      // Requirement: Stop and report conflict if more than one match exists
      if (matchedOrders.length > 1) {
        const err = new Error(
          `Conflict: Multiple matching Sales Orders (${matchedOrders.length}) found in Zoho Books for reference ${deterministicRef}. Manual reconciliation required.`
        );
        err.code = 'DUPLICATE_REMOTE_SALES_ORDERS';
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, lockedBy: executionWorkerId },
          { $set: { syncStatus: 'FAILED', failureReason: err.message } }
        );
        throw err;
      }

      let targetSO = null;

      // Requirement: Exactly one match -> recover and adopt
      if (matchedOrders.length === 1) {
        targetSO = matchedOrders[0];
        console.log(`[SALES ORDER RECOVERY] Adopted existing remote Sales Order ${targetSO.salesorder_id} for deal ${crmDealId}`);
      } else {
        // Zero matches -> create draft
        const lineItem = {
          name: dealName || `Software Contract ${crmDealId}`,
          description: `HubSpot Deal ${crmDealId}`,
          rate: Number((subtotalMinor / 100).toFixed(2)),
          quantity: 1
        };

        if (itemId) {
          lineItem.item_id = itemId;
        }

        if (taxId) {
          lineItem.tax_id = taxId;
        }

        const createPayload = {
          customer_id: zohoContactId,
          reference_number: deterministicRef,
          date: new Date().toISOString().split('T')[0],
          line_items: [lineItem],
          notes: `Synced from HubSpot Deal ${crmDealId}. Subtotal: AED ${(subtotalMinor / 100).toFixed(2)}, 5% VAT: AED ${(taxMinor / 100).toFixed(2)}, Gross: AED ${(grossMinor / 100).toFixed(2)}.`
        };

        if (currencyId) {
          createPayload.currency_id = currencyId;
        }

        let createRes;
        try {
          createRes = await client.request({
            method: 'POST',
            path: '/salesorders',
            body: createPayload,
            crmDealId
          });
        } catch (postErr) {
          // Remote POST outcome uncertain (network timeout, socket reset, etc.)
          // Reconcile by querying deterministic reference number before failing
          console.warn(`[RECONCILIATION] POST /salesorders failed (${postErr.message}). Reconciling via remote reference ${deterministicRef}...`);
          const reconcileRes = await client.request({
            method: 'GET',
            path: `/salesorders?reference_number=${encodeURIComponent(deterministicRef)}`,
            crmDealId
          });

          const reconciledOrders = reconcileRes.data?.salesorders || [];
          if (reconciledOrders.length === 1) {
            console.log(`[RECONCILIATION SUCCESS] Adopted Sales Order ${reconciledOrders[0].salesorder_id} created despite POST error.`);
            targetSO = reconciledOrders[0];
          } else if (reconciledOrders.length > 1) {
            const conflictErr = new Error(`Conflict: Multiple matching Sales Orders (${reconciledOrders.length}) found during post-error reconciliation.`);
            conflictErr.code = 'DUPLICATE_REMOTE_SALES_ORDERS';
            await IntegrationSync.findOneAndUpdate(
              { crmDealId, lockedBy: executionWorkerId },
              { $set: { syncStatus: 'FAILED', failureReason: conflictErr.message } }
            );
            throw conflictErr;
          } else {
            await IntegrationSync.findOneAndUpdate(
              { crmDealId, lockedBy: executionWorkerId },
              { $set: { syncStatus: 'FAILED', failureReason: postErr.message } }
            );
            throw postErr;
          }
        }

        if (!targetSO) {
          if (!createRes.data || createRes.data.code !== 0 || !createRes.data.salesorder) {
            const errMsg = createRes.data?.message || 'Failed to create Sales Order in Zoho Books';
            const err = new Error(errMsg);
            err.code = 'ZOHO_CREATE_FAILED';
            await IntegrationSync.findOneAndUpdate(
              { crmDealId, lockedBy: executionWorkerId },
              { $set: { syncStatus: 'FAILED', failureReason: errMsg } }
            );
            throw err;
          }
          targetSO = createRes.data.salesorder;
        }
      }

      // Step 2A: Validate Currency (reject missing or mismatch)
      if (!targetSO.currency_code || typeof targetSO.currency_code !== 'string' || !targetSO.currency_code.trim()) {
        const err = new Error("Sales Order validation failed: Zoho Books response is missing required 'currency_code'.");
        err.code = 'SALES_ORDER_MISSING_CURRENCY';
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, lockedBy: executionWorkerId },
          { $set: { syncStatus: 'FAILED', failureReason: err.message } }
        );
        throw err;
      }

      const actualCurrency = targetSO.currency_code.trim();
      if (actualCurrency !== currencyCode) {
        const err = new Error(
          `Financial/Currency Validation Failed: Returned Currency '${actualCurrency}' does not match expected Currency '${currencyCode}'.`
        );
        err.code = 'SALES_ORDER_CURRENCY_MISMATCH';
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, lockedBy: executionWorkerId },
          { $set: { syncStatus: 'FAILED', failureReason: err.message } }
        );
        throw err;
      }

      // Step 2B: Validate Subtotal, VAT, and Gross Total using integer minor units (fils / cents)
      const actualSubtotalMinor = Math.round(Number(targetSO.sub_total || 0) * 100);
      const actualTaxMinor = Math.round(Number(targetSO.tax_total || 0) * 100);
      const actualGrossMinor = Math.round(Number(targetSO.total || 0) * 100);

      if (
        actualSubtotalMinor !== subtotalMinor ||
        actualTaxMinor !== taxMinor ||
        actualGrossMinor !== grossMinor
      ) {
        const err = new Error(
          `Financial Validation Failed: Returned Subtotal=${(actualSubtotalMinor / 100).toFixed(2)}, Tax=${(actualTaxMinor / 100).toFixed(2)}, Gross=${(actualGrossMinor / 100).toFixed(2)}. Expected Subtotal=${(subtotalMinor / 100).toFixed(2)}, Tax=${(taxMinor / 100).toFixed(2)}, Gross=${(grossMinor / 100).toFixed(2)}.`
        );
        err.code = 'SALES_ORDER_FINANCIAL_VALIDATION_FAILED';
        await IntegrationSync.findOneAndUpdate(
          { crmDealId, lockedBy: executionWorkerId },
          { $set: { syncStatus: 'FAILED', failureReason: err.message } }
        );
        throw err;
      }

      const actualSubtotal = actualSubtotalMinor / 100;
      const actualTax = actualTaxMinor / 100;
      const actualGross = actualGrossMinor / 100;

      // Step 3: Save draft Sales Order ID and status in MongoDB with FENCING GUARD
      const draftSync = await IntegrationSync.findOneAndUpdate(
        {
          crmDealId,
          lockedBy: executionWorkerId,
          leaseExpiresAt: { $gt: new Date() }
        },
        {
          $set: {
            zohoSalesOrderId: targetSO.salesorder_id,
            zohoSalesOrderNumber: targetSO.salesorder_number,
            zohoSalesOrderUrl: `https://books.zoho.${process.env.ZOHO_BOOKS_DOMAIN || 'in'}/app/${process.env.ZOHO_BOOKS_ORGANIZATION_ID}#/salesorders/${targetSO.salesorder_id}`,
            salesOrderTotal: actualGross,
            salesOrderSubtotal: actualSubtotal,
            salesOrderTax: actualTax,
            salesOrderStatus: 'DRAFT',
            syncStatus: 'SALES_ORDER_DRAFT',
            currencyCode: actualCurrency
          }
        },
        { returnDocument: 'after' }
      );

      if (!draftSync) {
        const staleErr = new Error(`Fencing Guard: Worker ${executionWorkerId} lease expired or was preempted by another worker. Draft write aborted.`);
        staleErr.code = 'WORKER_LEASE_FENCED';
        throw staleErr;
      }

      // Step 4: Confirm Sales Order if not already confirmed
      const isAlreadyConfirmed = targetSO.status === 'open' || targetSO.order_status === 'confirmed';

      if (!isAlreadyConfirmed) {
        const confirmRes = await client.request({
          method: 'POST',
          path: `/salesorders/${targetSO.salesorder_id}/status/confirmed`,
          crmDealId
        });

        if (!confirmRes.data || confirmRes.data.code !== 0) {
          const errMsg = confirmRes.data?.message || 'Failed to confirm Sales Order in Zoho Books';
          const err = new Error(errMsg);
          err.code = 'SALES_ORDER_CONFIRMATION_FAILED';
          await IntegrationSync.findOneAndUpdate(
            { crmDealId, lockedBy: executionWorkerId },
            { $set: { syncStatus: 'FAILED', failureReason: errMsg } }
          );
          throw err;
        }
      }

      // Step 5: Verify confirmed status and update MongoDB to CONFIRMED with FENCING GUARD
      const confirmedSync = await IntegrationSync.findOneAndUpdate(
        {
          crmDealId,
          lockedBy: executionWorkerId,
          leaseExpiresAt: { $gt: new Date() }
        },
        {
          $set: {
            salesOrderStatus: 'CONFIRMED',
            syncStatus: 'SALES_ORDER_CONFIRMED',
            amountNotInvoiced: actualGross,
            amountInvoicedUnpaid: 0,
            percentageInvoiced: 0,
            percentageCollected: 0,
            failureReason: null
          }
        },
        { returnDocument: 'after' }
      );

      if (!confirmedSync) {
        const staleErr = new Error(`Fencing Guard: Worker ${executionWorkerId} lease expired or was preempted by another worker. Confirmation write aborted.`);
        staleErr.code = 'WORKER_LEASE_FENCED';
        throw staleErr;
      }

      return {
        status: 'CONFIRMED',
        zohoSalesOrderId: targetSO.salesorder_id,
        zohoSalesOrderNumber: targetSO.salesorder_number,
        salesOrderTotal: actualGross,
        salesOrderSubtotal: actualSubtotal,
        salesOrderTax: actualTax,
        currencyCode: actualCurrency,
        sync: confirmedSync
      };
    } finally {
      // Clear lease heartbeat
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Always release worker lease for this specific worker ID
      await this.releaseDealLock(crmDealId, executionWorkerId);
    }
  }
}

module.exports = SalesOrderService;
