const crypto = require('crypto');
const IntegrationSync = require('../models/IntegrationSync');
const MilestoneInvoice = require('../models/MilestoneInvoice');
const PaymentRecord = require('../models/PaymentRecord');
const IntegrationLog = require('../models/IntegrationLog');
const QueueService = require('./queueService');
const {
  OrchestrationService,
  calculateAggregateFinancialMetrics,
  formatHubSpotDate,
  updateHubSpotDealWithRetry
} = require('./orchestrationService');
const { zohoClient } = require('../clients/zohoClient');
const { hubspotClient } = require('../clients/hubspotClient');

/**
 * PaymentService handles bidirectional reverse synchronization from Zoho Books to HubSpot CRM.
 * Processes payments, partial payments, multiple allocations, reversals, and refunds.
 * Enforces strict verification against Zoho Books, integer minor unit precision,
 * idempotent deduplication, and atomic deal locking.
 */
class PaymentService {
  /**
   * Processes an incoming Zoho customer payment event.
   * Verifies against Zoho Books, applies to MilestoneInvoice, recalculates financials,
   * updates HubSpot deal properties, and logs the transaction.
   */
  static async processPaymentEvent({
    paymentPayload,
    workerId = null,
    injectedZohoClient = null,
    injectedHubSpotClient = null,
    referenceDate = null
  }) {
    if (!paymentPayload || typeof paymentPayload !== 'object') {
      const err = new Error('Invalid payment payload: Payload must be a non-null object.');
      err.code = 'INVALID_PAYMENT_DATA';
      throw err;
    }

    const rawPayment = paymentPayload.payment || paymentPayload;
    const paymentId = String(
      rawPayment.payment_id || rawPayment.paymentId || paymentPayload.payment_id || paymentPayload.id || ''
    ).trim();

    if (!paymentId) {
      const err = new Error('Payment processing failed: Missing required payment_id in payload.');
      err.code = 'MISSING_PAYMENT_ID';
      throw err;
    }

    const zClient = injectedZohoClient || zohoClient;
    const hsClient = injectedHubSpotClient || hubspotClient;

    // =========================================================================
    // STEP 1: Verify payment against Zoho Books (never trust unverified payload)
    // =========================================================================
    let payRes;
    try {
      payRes = await zClient.request({
        method: 'GET',
        path: `/customerpayments/${paymentId}`
      });
    } catch (apiErr) {
      const err = new Error(`Zoho API Error verifying payment ${paymentId}: ${apiErr.message}`);
      err.code = 'ZOHO_PAYMENT_VERIFICATION_FAILED';
      throw err;
    }

    if (!payRes || payRes.statusCode !== 200 || !payRes.data?.payment) {
      const err = new Error(
        `Payment Verification Failed: Payment ${paymentId} could not be verified in Zoho Books (HTTP ${payRes?.statusCode}).`
      );
      err.code = 'PAYMENT_VERIFICATION_FAILED';
      throw err;
    }

    const verifiedPayment = payRes.data.payment;
    let invoiceAllocations = verifiedPayment.invoices || [];

    // Fallback: If verified payment has no invoices array but payload specified one
    if (invoiceAllocations.length === 0 && (rawPayment.invoice_id || paymentPayload.invoice_id)) {
      const fallbackInvId = rawPayment.invoice_id || paymentPayload.invoice_id;
      invoiceAllocations = [
        {
          invoice_id: fallbackInvId,
          amount_applied: Number(verifiedPayment.amount || rawPayment.amount || 0)
        }
      ];
    }

    if (invoiceAllocations.length === 0) {
      const err = new Error(`Payment Verification Failed: Payment ${paymentId} contains no invoice allocations.`);
      err.code = 'MISSING_INVOICE_ALLOCATIONS';
      throw err;
    }

    const results = [];

    // =========================================================================
    // STEP 2: Process each invoice allocation in the payment
    // =========================================================================
    for (const alloc of invoiceAllocations) {
      const zohoInvoiceId = alloc.invoice_id;
      if (!zohoInvoiceId) continue;

      // Match invoice to local MilestoneInvoice
      const milestone = await MilestoneInvoice.findOne({ zohoInvoiceId });
      if (!milestone) {
        const err = new Error(
          `Unknown Invoice Mapping: Invoice ${zohoInvoiceId} from payment ${paymentId} is not associated with any Milestone in the CRM.`
        );
        err.code = 'UNKNOWN_INVOICE_MAPPING';
        throw err;
      }

      const crmDealId = milestone.crmDealId;

      // Acquire distributed lock for this deal
      const executionId = crypto.randomUUID();
      const executionWorkerId = workerId
        ? `${workerId}_${executionId}`
        : `worker_pay_${process.pid}_${executionId}`;

      await OrchestrationService.acquireOrchestrationLock(crmDealId, executionWorkerId);

      try {
        // Idempotency and crash-recovery check:
        const existingRecord = await PaymentRecord.findOne({
          paymentId,
          zohoInvoiceId
        });

        if (existingRecord && existingRecord.status === 'APPLIED') {
          // If HubSpot was already updated successfully on this payment, it is completely done
          if (existingRecord.hubspotSynced) {
            results.push({
              status: 'ALREADY_PROCESSED',
              paymentId,
              zohoInvoiceId,
              crmDealId,
              amount: existingRecord.amount
            });
            continue;
          }

          // Crash-recovery: Payment was persisted to MongoDB in a prior attempt,
          // but the process crashed before completing the HubSpot update.
          // Recover by completing the pending HubSpot update without duplicate payment processing:
          const syncRecord = await IntegrationSync.findOne({ crmDealId });
          const metrics = await calculateAggregateFinancialMetrics(
            crmDealId,
            syncRecord.salesOrderTotal,
            referenceDate || new Date()
          );

          const hsPayload = {
            zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
            zoho_payment_status: metrics.paymentStatus,
            zoho_is_overdue: String(Boolean(metrics.isOverdue)),
            integration_last_synced_at: new Date().toISOString()
          };

          if (metrics.amountCollected !== null) {
            hsPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
            hsPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
          }

          if (metrics.nextDueDate) {
            hsPayload.zoho_next_due_date = formatHubSpotDate(metrics.nextDueDate);
          }

          await updateHubSpotDealWithRetry(hsClient, crmDealId, hsPayload, {
            maxRetries: 3,
            baseDelayMs: 50
          });

          await PaymentRecord.updateOne(
            { _id: existingRecord._id },
            { $set: { hubspotSynced: true, hubspotSyncedAt: new Date() } }
          );

          results.push({
            status: 'PAYMENT_APPLIED',
            paymentId,
            zohoInvoiceId,
            crmDealId,
            amount: existingRecord.amount,
            hubspotRecovered: true,
            metrics
          });
          continue;
        }

        // Fetch latest invoice from Zoho to get verified balance
        let invRes;
        try {
          invRes = await zClient.request({
            method: 'GET',
            path: `/invoices/${zohoInvoiceId}`,
            crmDealId
          });
        } catch (invErr) {
          const err = new Error(`Failed to fetch current balance for invoice ${zohoInvoiceId}: ${invErr.message}`);
          err.code = 'INVOICE_FETCH_FAILED';
          throw err;
        }

        const targetInvoice = invRes.data?.invoice;
        if (!targetInvoice) {
          const err = new Error(`Invoice ${zohoInvoiceId} returned empty or invalid response from Zoho.`);
          err.code = 'INVOICE_NOT_FOUND';
          throw err;
        }

        const currentBalance =
          targetInvoice.balance !== undefined && targetInvoice.balance !== null && !isNaN(targetInvoice.balance)
            ? Number(targetInvoice.balance)
            : null;

        const amountApplied = Number(alloc.amount_applied ?? verifiedPayment.amount ?? 0);
        const amountMinor = Math.round(amountApplied * 100);

        // Record payment in PaymentRecord (hubspotSynced starts false until PATCH succeeds)
        const paymentRecord = await PaymentRecord.findOneAndUpdate(
          { paymentId, zohoInvoiceId },
          {
            $set: {
              crmDealId,
              zohoInvoiceId,
              milestoneIndex: milestone.milestoneIndex,
              amount: amountApplied,
              amountMinor,
              currencyCode: verifiedPayment.currency_code || milestone.currencyCode || 'AED',
              paymentNumber: verifiedPayment.payment_number || null,
              paymentMode: verifiedPayment.payment_mode || 'Unknown',
              paymentDate: verifiedPayment.date ? new Date(verifiedPayment.date) : new Date(),
              status: 'APPLIED',
              hubspotSynced: false,
              hubspotSyncedAt: null,
              reversalReason: null,
              reversedAt: null,
              rawPayload: verifiedPayment
            }
          },
          { upsert: true, returnDocument: 'after' }
        );

        // Update MilestoneInvoice balance & status
        const milestoneUpdate = {
          balance: currentBalance
        };

        if (currentBalance !== null) {
          if (currentBalance === 0) {
            milestoneUpdate.status = 'PAID';
            milestoneUpdate.paidAt = verifiedPayment.date ? new Date(verifiedPayment.date) : new Date();
          } else if (currentBalance > 0 && currentBalance < milestone.totalAmount) {
            milestoneUpdate.status = 'PARTIALLY_PAID';
          } else if (currentBalance === milestone.totalAmount) {
            milestoneUpdate.status = 'CREATED';
            milestoneUpdate.paidAt = null;
          }
        }

        await MilestoneInvoice.updateOne({ _id: milestone._id }, { $set: milestoneUpdate });

        // Recalculate affected deal's financial metrics
        const syncRecord = await IntegrationSync.findOne({ crmDealId });
        const metrics = await calculateAggregateFinancialMetrics(
          crmDealId,
          syncRecord.salesOrderTotal,
          referenceDate || new Date()
        );

        // Update IntegrationSync in MongoDB with lease fencing check
        const updatedSync = await IntegrationSync.findOneAndUpdate(
          { crmDealId, orchestrationLockedBy: executionWorkerId },
          {
            $set: {
              totalInvoicedAmount: metrics.totalInvoiced,
              amountCollected: metrics.amountCollected ?? 0,
              percentageCollected: metrics.percentageCollected ?? 0,
              amountInvoicedUnpaid: metrics.amountInvoicedUnpaid,
              paymentInfoStatus: metrics.paymentStatus === 'PAYMENT_INFO_UNAVAILABLE' ? 'PAYMENT_INFO_UNAVAILABLE' : 'DETERMINED',
              isOverdue: metrics.isOverdue,
              nextDueDate: metrics.nextDueDate || null,
              lastSyncedAt: new Date()
            }
          },
          { returnDocument: 'after' }
        );

        if (!updatedSync) {
          const fencingErr = new Error(
            `Fencing guard violated: Worker lease expired or was preempted for deal ${crmDealId}.`
          );
          fencingErr.code = 'FENCING_GUARD_VIOLATION';
          throw fencingErr;
        }

        // Update HubSpot Deal Properties with Retry
        const hsPayload = {
          zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
          zoho_payment_status: metrics.paymentStatus,
          zoho_is_overdue: String(Boolean(metrics.isOverdue)),
          integration_last_synced_at: new Date().toISOString()
        };

        if (metrics.amountCollected !== null) {
          hsPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
          hsPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
        }

        if (metrics.nextDueDate) {
          hsPayload.zoho_next_due_date = formatHubSpotDate(metrics.nextDueDate);
        }

        await updateHubSpotDealWithRetry(hsClient, crmDealId, hsPayload, {
          maxRetries: 3,
          baseDelayMs: 50
        });

        // Mark payment as confirmed synced to HubSpot
        await PaymentRecord.updateOne(
          { _id: paymentRecord._id },
          { $set: { hubspotSynced: true, hubspotSyncedAt: new Date() } }
        );

        // Persist Audit Log in IntegrationLog
        try {
          await IntegrationLog.create({
            system: 'ZOHO_BOOKS',
            direction: 'INBOUND_WEBHOOK',
            method: 'POST',
            endpoint: '/api/webhooks/zoho',
            statusCode: 200,
            crmDealId,
            requestBody: paymentPayload,
            responseBody: { paymentId, zohoInvoiceId, amountApplied, status: 'APPLIED', metrics },
            isSuccess: true
          });
        } catch (logErr) {
          console.warn('[PAYMENT LOG ERROR] Non-fatal log creation error:', logErr.message);
        }

        results.push({
          status: 'PAYMENT_APPLIED',
          paymentId,
          zohoInvoiceId,
          crmDealId,
          amount: amountApplied,
          currentBalance,
          metrics,
          paymentRecord
        });
      } finally {
        await OrchestrationService.releaseOrchestrationLock(crmDealId, executionWorkerId);
      }
    }

    return {
      success: true,
      paymentId,
      allocationsProcessed: results.length,
      results
    };
  }

  /**
   * Processes a payment reversal (void / delete / partial reversal).
   * Supports specific reversal IDs, partial reversal amounts, and idempotent replay.
   * Updates PaymentRecord, fetches restored invoice balance from Zoho,
   * updates MilestoneInvoice, recalculates financial metrics, and pushes updates to HubSpot.
   */
  static async processPaymentReversal({
    paymentId,
    reversalId = null,
    amount = null,
    reason = 'Payment reversed in Zoho Books',
    workerId = null,
    injectedZohoClient = null,
    injectedHubSpotClient = null,
    referenceDate = null
  }) {
    if (!paymentId) {
      throw new Error('paymentId is required for reversal.');
    }

    const existingRecords = await PaymentRecord.find({ paymentId });
    if (!existingRecords || existingRecords.length === 0) {
      const err = new Error(`Cannot reverse payment ${paymentId}: Payment record not found.`);
      err.code = 'PAYMENT_NOT_FOUND';
      throw err;
    }

    // Check if this specific reversalId was already processed
    if (reversalId) {
      const alreadyReversed = existingRecords.some((r) =>
        r.reversals && r.reversals.some((rev) => rev.reversalId === reversalId)
      );
      if (alreadyReversed) {
        return {
          status: 'ALREADY_PROCESSED',
          reversalId,
          paymentId,
          message: `Reversal ${reversalId} was already applied.`
        };
      }
    }

    // Filter active records that have remaining reversible balance
    const activeRecords = existingRecords.filter((r) =>
      ['APPLIED', 'PARTIALLY_REVERSED', 'PARTIALLY_REFUNDED'].includes(r.status)
    );

    if (activeRecords.length === 0) {
      return {
        status: 'ALREADY_REVERSED',
        paymentId,
        message: 'Payment was already completely reversed or refunded.'
      };
    }

    const zClient = injectedZohoClient || zohoClient;
    const hsClient = injectedHubSpotClient || hubspotClient;
    const results = [];

    for (const record of activeRecords) {
      const { crmDealId, zohoInvoiceId } = record;

      const executionId = crypto.randomUUID();
      const executionWorkerId = workerId
        ? `${workerId}_${executionId}`
        : `worker_rev_${process.pid}_${executionId}`;

      await OrchestrationService.acquireOrchestrationLock(crmDealId, executionWorkerId);

      try {
        const totalAlreadyReversedMinor = record.totalReversedMinor || 0;
        const totalAlreadyRefundedMinor = record.totalRefundedMinor || 0;
        const remainingMinor = record.amountMinor - totalAlreadyReversedMinor - totalAlreadyRefundedMinor;

        let reversalMinor;
        if (amount !== null && amount !== undefined) {
          reversalMinor = Math.round(Number(amount) * 100);
          if (reversalMinor <= 0) {
            const err = new Error('Reversal amount must be greater than zero.');
            err.code = 'INVALID_REVERSAL_AMOUNT';
            throw err;
          }
          if (reversalMinor > remainingMinor) {
            const err = new Error(
              `Cannot reverse AED ${amount}: Exceeds remaining active payment balance of AED ${remainingMinor / 100}.`
            );
            err.code = 'REVERSAL_EXCEEDS_PAYMENT_BALANCE';
            throw err;
          }
        } else {
          // Full remaining reversal
          reversalMinor = remainingMinor;
        }

        const effectiveRevId = reversalId || `rev_${crypto.randomUUID().substring(0, 8)}`;
        const newTotalReversedMinor = totalAlreadyReversedMinor + reversalMinor;
        const isFullyReversedOrRefunded = newTotalReversedMinor + totalAlreadyRefundedMinor >= record.amountMinor;
        const newStatus = isFullyReversedOrRefunded ? 'REVERSED' : 'PARTIALLY_REVERSED';

        // Update PaymentRecord
        await PaymentRecord.updateOne(
          { _id: record._id },
          {
            $set: {
              status: newStatus,
              totalReversedMinor: newTotalReversedMinor,
              reversalReason: reason,
              reversedAt: new Date()
            },
            $push: {
              reversals: {
                reversalId: effectiveRevId,
                amount: reversalMinor / 100,
                amountMinor: reversalMinor,
                reversedAt: new Date(),
                reason
              }
            }
          }
        );

        // Fetch current invoice balance from Zoho
        const invRes = await zClient.request({
          method: 'GET',
          path: `/invoices/${zohoInvoiceId}`,
          crmDealId
        });

        const targetInvoice = invRes.data?.invoice;
        const milestone = await MilestoneInvoice.findOne({ zohoInvoiceId });

        let currentBalance;
        if (targetInvoice?.balance !== undefined && targetInvoice?.balance !== null) {
          currentBalance = Number(targetInvoice.balance);
        } else if (milestone && milestone.balance !== null) {
          currentBalance = milestone.balance + reversalMinor / 100;
        } else {
          currentBalance = record.amount;
        }

        if (milestone) {
          const milestoneStatus =
            currentBalance >= milestone.totalAmount
              ? 'CREATED'
              : currentBalance === 0
              ? 'PAID'
              : 'PARTIALLY_PAID';

          await MilestoneInvoice.updateOne(
            { _id: milestone._id },
            {
              $set: {
                balance: currentBalance,
                status: milestoneStatus,
                paidAt: currentBalance === 0 ? milestone.paidAt : null
              }
            }
          );
        }

        // Recalculate metrics
        const syncRecord = await IntegrationSync.findOne({ crmDealId });
        const metrics = await calculateAggregateFinancialMetrics(
          crmDealId,
          syncRecord.salesOrderTotal,
          referenceDate || new Date()
        );

        // Update IntegrationSync with lease fencing
        const updatedSync = await IntegrationSync.findOneAndUpdate(
          { crmDealId, orchestrationLockedBy: executionWorkerId },
          {
            $set: {
              totalInvoicedAmount: metrics.totalInvoiced,
              amountCollected: metrics.amountCollected ?? 0,
              percentageCollected: metrics.percentageCollected ?? 0,
              amountInvoicedUnpaid: metrics.amountInvoicedUnpaid,
              paymentInfoStatus: metrics.paymentStatus === 'PAYMENT_INFO_UNAVAILABLE' ? 'PAYMENT_INFO_UNAVAILABLE' : 'DETERMINED',
              isOverdue: metrics.isOverdue,
              nextDueDate: metrics.nextDueDate || null,
              lastSyncedAt: new Date()
            }
          },
          { returnDocument: 'after' }
        );

        if (!updatedSync) {
          const fencingErr = new Error(
            `Fencing guard violated: Worker lease expired or was preempted for deal ${crmDealId}.`
          );
          fencingErr.code = 'FENCING_GUARD_VIOLATION';
          throw fencingErr;
        }

        // Update HubSpot
        const hsPayload = {
          zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
          zoho_payment_status: metrics.paymentStatus,
          zoho_is_overdue: String(Boolean(metrics.isOverdue)),
          integration_last_synced_at: new Date().toISOString()
        };

        if (metrics.amountCollected !== null) {
          hsPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
          hsPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
        }

        if (metrics.nextDueDate) {
          hsPayload.zoho_next_due_date = formatHubSpotDate(metrics.nextDueDate);
        }

        await updateHubSpotDealWithRetry(hsClient, crmDealId, hsPayload);

        // Audit Log
        try {
          await IntegrationLog.create({
            system: 'ZOHO_BOOKS',
            direction: 'INBOUND_WEBHOOK',
            method: 'POST',
            endpoint: '/api/webhooks/zoho/reversal',
            statusCode: 200,
            crmDealId,
            requestBody: { paymentId, reversalId: effectiveRevId, amount: reversalMinor / 100, reason },
            responseBody: { paymentId, status: newStatus, currentBalance, metrics },
            isSuccess: true
          });
        } catch (logErr) {
          console.warn('[REVERSAL LOG ERROR]', logErr.message);
        }

        results.push({
          status: newStatus,
          reversalId: effectiveRevId,
          paymentId,
          reversedAmount: reversalMinor / 100,
          zohoInvoiceId,
          crmDealId,
          currentBalance,
          metrics
        });
      } finally {
        await OrchestrationService.releaseOrchestrationLock(crmDealId, executionWorkerId);
      }
    }

    return {
      success: true,
      paymentId,
      reversals: results
    };
  }

  /**
   * Processes a customer payment refund from Zoho Books.
   * Distinct from reversal: handles partial or full refunds, tracks refund_id idempotently,
   * updates invoice balance and financial metrics, and pushes updates to HubSpot.
   */
  static async processPaymentRefund({
    refundPayload,
    workerId = null,
    injectedZohoClient = null,
    injectedHubSpotClient = null,
    referenceDate = null
  }) {
    if (!refundPayload || typeof refundPayload !== 'object') {
      const err = new Error('Invalid refund payload: Payload must be a non-null object.');
      err.code = 'INVALID_REFUND_DATA';
      throw err;
    }

    const rawRefund = refundPayload.refund || refundPayload;
    const refundId = String(rawRefund.refund_id || rawRefund.refundId || refundPayload.refund_id || '').trim();
    const paymentId = String(
      rawRefund.payment_id || rawRefund.paymentId || refundPayload.payment_id || refundPayload.payment?.payment_id || ''
    ).trim();

    if (!refundId) {
      const err = new Error('Refund processing failed: Missing required refund_id.');
      err.code = 'MISSING_REFUND_ID';
      throw err;
    }

    if (!paymentId) {
      const err = new Error('Refund processing failed: Missing associated payment_id for refund.');
      err.code = 'MISSING_PAYMENT_ID';
      throw err;
    }

    const record = await PaymentRecord.findOne({ paymentId });
    if (!record) {
      const err = new Error(`Cannot process refund ${refundId}: Payment ${paymentId} not found.`);
      err.code = 'PAYMENT_NOT_FOUND';
      throw err;
    }

    // Idempotency: Check if this refundId was already applied
    if (record.refunds && record.refunds.some((r) => r.refundId === refundId)) {
      return {
        status: 'ALREADY_PROCESSED',
        refundId,
        paymentId,
        message: `Refund ${refundId} was already applied.`
      };
    }

    const refundAmount = Number(rawRefund.amount ?? refundPayload.amount ?? 0);
    if (refundAmount <= 0) {
      const err = new Error('Refund amount must be greater than zero.');
      err.code = 'INVALID_REFUND_AMOUNT';
      throw err;
    }

    const refundMinor = Math.round(refundAmount * 100);
    const totalAlreadyRefundedMinor = record.totalRefundedMinor || 0;
    const totalAlreadyReversedMinor = record.totalReversedMinor || 0;
    const remainingMinor = record.amountMinor - totalAlreadyRefundedMinor - totalAlreadyReversedMinor;

    if (refundMinor > remainingMinor) {
      const err = new Error(
        `Refund of AED ${refundAmount} exceeds remaining active payment balance of AED ${remainingMinor / 100}.`
      );
      err.code = 'REFUND_EXCEEDS_PAYMENT_BALANCE';
      throw err;
    }

    const zClient = injectedZohoClient || zohoClient;
    const hsClient = injectedHubSpotClient || hubspotClient;
    const { crmDealId, zohoInvoiceId } = record;

    const executionId = crypto.randomUUID();
    const executionWorkerId = workerId
      ? `${workerId}_${executionId}`
      : `worker_ref_${process.pid}_${executionId}`;

    await OrchestrationService.acquireOrchestrationLock(crmDealId, executionWorkerId);

    try {
      const newTotalRefundedMinor = totalAlreadyRefundedMinor + refundMinor;
      const isFullyRefundedOrReversed = newTotalRefundedMinor + totalAlreadyReversedMinor >= record.amountMinor;
      const newStatus = isFullyRefundedOrReversed ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

      // Update PaymentRecord
      await PaymentRecord.updateOne(
        { _id: record._id },
        {
          $set: {
            status: newStatus,
            totalRefundedMinor: newTotalRefundedMinor
          },
          $push: {
            refunds: {
              refundId,
              amount: refundAmount,
              amountMinor: refundMinor,
              refundDate: rawRefund.date ? new Date(rawRefund.date) : new Date(),
              reason: rawRefund.reason || rawRefund.description || 'Customer payment refund'
            }
          }
        }
      );

      // Fetch current invoice balance from Zoho
      const invRes = await zClient.request({
        method: 'GET',
        path: `/invoices/${zohoInvoiceId}`,
        crmDealId
      });

      const targetInvoice = invRes.data?.invoice;
      const milestone = await MilestoneInvoice.findOne({ zohoInvoiceId });

      let currentBalance;
      if (targetInvoice?.balance !== undefined && targetInvoice?.balance !== null) {
        currentBalance = Number(targetInvoice.balance);
      } else if (milestone && milestone.balance !== null) {
        currentBalance = milestone.balance + refundAmount;
      } else {
        currentBalance = milestone ? milestone.totalAmount : record.amount;
      }

      if (milestone) {
        const milestoneStatus =
          currentBalance >= milestone.totalAmount
            ? 'CREATED'
            : currentBalance === 0
            ? 'PAID'
            : 'PARTIALLY_PAID';

        await MilestoneInvoice.updateOne(
          { _id: milestone._id },
          {
            $set: {
              balance: currentBalance,
              status: milestoneStatus,
              paidAt: currentBalance === 0 ? milestone.paidAt : null
            }
          }
        );
      }

      // Recalculate metrics
      const syncRecord = await IntegrationSync.findOne({ crmDealId });
      const metrics = await calculateAggregateFinancialMetrics(
        crmDealId,
        syncRecord.salesOrderTotal,
        referenceDate || new Date()
      );

      // Update IntegrationSync with lease fencing
      const updatedSync = await IntegrationSync.findOneAndUpdate(
        { crmDealId, orchestrationLockedBy: executionWorkerId },
        {
          $set: {
            totalInvoicedAmount: metrics.totalInvoiced,
            amountCollected: metrics.amountCollected ?? 0,
            percentageCollected: metrics.percentageCollected ?? 0,
            amountInvoicedUnpaid: metrics.amountInvoicedUnpaid,
            paymentInfoStatus: metrics.paymentStatus === 'PAYMENT_INFO_UNAVAILABLE' ? 'PAYMENT_INFO_UNAVAILABLE' : 'DETERMINED',
            isOverdue: metrics.isOverdue,
            nextDueDate: metrics.nextDueDate || null,
            lastSyncedAt: new Date()
          }
        },
        { returnDocument: 'after' }
      );

      if (!updatedSync) {
        const fencingErr = new Error(
          `Fencing guard violated: Worker lease expired or was preempted for deal ${crmDealId}.`
        );
        fencingErr.code = 'FENCING_GUARD_VIOLATION';
        throw fencingErr;
      }

      // Update HubSpot
      const hsPayload = {
        zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
        zoho_payment_status: metrics.paymentStatus,
        zoho_is_overdue: String(Boolean(metrics.isOverdue)),
        integration_last_synced_at: new Date().toISOString()
      };

      if (metrics.amountCollected !== null) {
        hsPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
        hsPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
      }

      if (metrics.nextDueDate) {
        hsPayload.zoho_next_due_date = formatHubSpotDate(metrics.nextDueDate);
      }

      await updateHubSpotDealWithRetry(hsClient, crmDealId, hsPayload);

      // Audit Log
      try {
        await IntegrationLog.create({
          system: 'ZOHO_BOOKS',
          direction: 'INBOUND_WEBHOOK',
          method: 'POST',
          endpoint: '/api/webhooks/zoho/refund',
          statusCode: 200,
          crmDealId,
          requestBody: refundPayload,
          responseBody: { refundId, paymentId, amount: refundAmount, status: newStatus, currentBalance, metrics },
          isSuccess: true
        });
      } catch (logErr) {
        console.warn('[REFUND LOG ERROR]', logErr.message);
      }

      return {
        success: true,
        refundId,
        paymentId,
        amount: refundAmount,
        status: newStatus,
        currentBalance,
        metrics
      };
    } finally {
      await OrchestrationService.releaseOrchestrationLock(crmDealId, executionWorkerId);
    }
  }

  /**
   * Polling / Reconciliation Fallback:
   * Synchronizes payments and invoice balances for a specific deal by polling Zoho Books directly.
   */
  static async syncPaymentsForDeal({
    crmDealId,
    workerId = null,
    injectedZohoClient = null,
    injectedHubSpotClient = null,
    referenceDate = null
  }) {
    if (!crmDealId) throw new Error('crmDealId is required.');

    const syncRecord = await IntegrationSync.findOne({ crmDealId });
    if (!syncRecord) throw new Error(`IntegrationSync record not found for deal ${crmDealId}.`);

    const milestones = await MilestoneInvoice.find({
      crmDealId,
      status: { $in: ['CREATED', 'SENT', 'PAID', 'PARTIALLY_PAID'] },
      zohoInvoiceId: { $ne: null }
    });

    const zClient = injectedZohoClient || zohoClient;
    const hsClient = injectedHubSpotClient || hubspotClient;
    const reconciledPayments = [];

    const executionId = crypto.randomUUID();
    const executionWorkerId = workerId
      ? `${workerId}_${executionId}`
      : `worker_poll_${process.pid}_${executionId}`;

    await OrchestrationService.acquireOrchestrationLock(crmDealId, executionWorkerId);

    try {
      for (const m of milestones) {
        const invRes = await zClient.request({
          method: 'GET',
          path: `/invoices/${m.zohoInvoiceId}`,
          crmDealId
        });

        const invData = invRes.data?.invoice;
        if (!invData) continue;

        const currentBalance =
          invData.balance !== undefined && invData.balance !== null ? Number(invData.balance) : m.balance;

        const newStatus =
          currentBalance === 0
            ? 'PAID'
            : currentBalance < m.totalAmount
            ? 'PARTIALLY_PAID'
            : 'CREATED';

        await MilestoneInvoice.updateOne(
          { _id: m._id },
          {
            $set: {
              balance: currentBalance,
              status: newStatus,
              dueDate: invData.due_date ? new Date(invData.due_date) : m.dueDate,
              paidAt: currentBalance === 0 ? m.paidAt || new Date() : null
            }
          }
        );

        // Reconcile payments listed on invoice
        const payments = invData.payments || [];
        for (const p of payments) {
          const pId = p.payment_id || p.paymentId;
          if (!pId) continue;

          const existing = await PaymentRecord.findOne({ paymentId: pId, zohoInvoiceId: m.zohoInvoiceId });
          if (!existing) {
            const rec = await PaymentRecord.create({
              paymentId: pId,
              crmDealId,
              zohoInvoiceId: m.zohoInvoiceId,
              milestoneIndex: m.milestoneIndex,
              amount: Number(p.amount || 0),
              amountMinor: Math.round(Number(p.amount || 0) * 100),
              currencyCode: invData.currency_code || 'AED',
              paymentNumber: p.payment_number || null,
              paymentMode: p.payment_mode || 'Unknown',
              paymentDate: p.date ? new Date(p.date) : new Date(),
              status: 'APPLIED',
              hubspotSynced: true,
              hubspotSyncedAt: new Date(),
              rawPayload: p
            });
            reconciledPayments.push(rec);
          }
        }
      }

      // Recalculate metrics
      const metrics = await calculateAggregateFinancialMetrics(
        crmDealId,
        syncRecord.salesOrderTotal,
        referenceDate || new Date()
      );

      const updatedSync = await IntegrationSync.findOneAndUpdate(
        { crmDealId, orchestrationLockedBy: executionWorkerId },
        {
          $set: {
            totalInvoicedAmount: metrics.totalInvoiced,
            amountCollected: metrics.amountCollected ?? 0,
            percentageCollected: metrics.percentageCollected ?? 0,
            amountInvoicedUnpaid: metrics.amountInvoicedUnpaid,
            paymentInfoStatus: metrics.paymentStatus === 'PAYMENT_INFO_UNAVAILABLE' ? 'PAYMENT_INFO_UNAVAILABLE' : 'DETERMINED',
            isOverdue: metrics.isOverdue,
            nextDueDate: metrics.nextDueDate || null,
            lastSyncedAt: new Date()
          }
        },
        { returnDocument: 'after' }
      );

      if (!updatedSync) {
        const fencingErr = new Error(
          `Fencing guard violated: Worker lease expired or was preempted for deal ${crmDealId}.`
        );
        fencingErr.code = 'FENCING_GUARD_VIOLATION';
        throw fencingErr;
      }

      // Push to HubSpot
      const hsPayload = {
        zoho_amount_invoiced_unpaid: Number(metrics.amountInvoicedUnpaid.toFixed(2)),
        zoho_payment_status: metrics.paymentStatus,
        zoho_is_overdue: String(Boolean(metrics.isOverdue)),
        integration_last_synced_at: new Date().toISOString()
      };

      if (metrics.amountCollected !== null) {
        hsPayload.zoho_total_collected_amount = Number(metrics.amountCollected.toFixed(2));
        hsPayload.zoho_percentage_collected = Number(metrics.percentageCollected.toFixed(2));
      }

      if (metrics.nextDueDate) {
        hsPayload.zoho_next_due_date = formatHubSpotDate(metrics.nextDueDate);
      }

      await updateHubSpotDealWithRetry(hsClient, crmDealId, hsPayload);

      return {
        status: 'SYNCED',
        crmDealId,
        newPaymentsReconciled: reconciledPayments.length,
        metrics
      };
    } finally {
      await OrchestrationService.releaseOrchestrationLock(crmDealId, executionWorkerId);
    }
  }

  /**
   * Batch evaluator for Polling / Reconciliation Fallback across all active deals.
   */
  static async syncAllActiveDeals({
    limit = 50,
    injectedZohoClient = null,
    injectedHubSpotClient = null,
    referenceDate = null
  } = {}) {
    const deals = await IntegrationSync.find({
      syncStatus: { $in: ['M1_INVOICED', 'M2_INVOICED', 'M3_INVOICED', 'SYNCED'] }
    }).limit(limit);

    const results = [];
    for (const d of deals) {
      try {
        const res = await this.syncPaymentsForDeal({
          crmDealId: d.crmDealId,
          injectedZohoClient,
          injectedHubSpotClient,
          referenceDate
        });
        results.push({ crmDealId: d.crmDealId, success: true, result: res });
      } catch (err) {
        results.push({ crmDealId: d.crmDealId, success: false, error: err.message });
      }
    }

    return {
      evaluated: deals.length,
      synced: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results
    };
  }

  /**
   * Processes the next queued Zoho WebhookEvent from durable queue.
   */
  static async processNextQueuedPaymentEvent({
    injectedZohoClient = null,
    injectedHubSpotClient = null
  } = {}) {
    const claimedEvent = await QueueService.claimNextEvent('ZOHO_BOOKS');
    if (!claimedEvent) {
      return null;
    }

    const payload = claimedEvent.payload || {};
    try {
      let result;
      if (
        claimedEvent.eventType === 'payment_refunded' ||
        claimedEvent.eventType === 'payment.refunded' ||
        payload.event_type === 'payment_refunded' ||
        payload.refund_id
      ) {
        result = await this.processPaymentRefund({
          refundPayload: payload,
          injectedZohoClient,
          injectedHubSpotClient
        });
      } else if (
        claimedEvent.eventType === 'payment_reversed' ||
        claimedEvent.eventType === 'payment_voided' ||
        payload.event_type === 'payment_reversed' ||
        payload.reversal_id
      ) {
        const paymentId = payload.payment_id || payload.payment?.payment_id;
        result = await this.processPaymentReversal({
          paymentId,
          reversalId: payload.reversal_id,
          amount: payload.amount,
          reason: payload.reason || 'Webhook reversal event',
          injectedZohoClient,
          injectedHubSpotClient
        });
      } else {
        result = await this.processPaymentEvent({
          paymentPayload: payload,
          injectedZohoClient,
          injectedHubSpotClient
        });
      }

      await QueueService.markCompleted(claimedEvent.eventId);
      return { eventId: claimedEvent.eventId, result };
    } catch (err) {
      await QueueService.markFailed(claimedEvent.eventId, err.message);
      throw err;
    }
  }
}

module.exports = PaymentService;
