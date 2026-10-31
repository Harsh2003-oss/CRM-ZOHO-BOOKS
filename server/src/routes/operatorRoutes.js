const express = require('express');
const { requireOperatorAuth } = require('../middleware/authMiddleware');
const DashboardService = require('../services/dashboardService');

const router = express.Router();

// Enforce operator authentication across all endpoints in this router
router.use(requireOperatorAuth);

/**
 * POST /api/operator/retry-event/:eventId
 * Retries a failed or stuck webhook event.
 */
router.post('/retry-event/:eventId', async (req, res, next) => {
  try {
    const { eventId } = req.params;
    const result = await DashboardService.retryWebhookEvent({
      eventId,
      operator: req.operator
    });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    if (err.code === 'EVENT_NOT_FOUND') {
      return res.status(404).json({ success: false, error: err.code, message: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/operator/retry-hubspot-sync/:crmDealId
 * Retries HubSpot financial property update for a deal in HUBSPOT_SYNC_FAILED state.
 */
router.post('/retry-hubspot-sync/:crmDealId', async (req, res, next) => {
  try {
    const { crmDealId } = req.params;
    const result = await DashboardService.retryHubSpotSync({
      crmDealId,
      operator: req.operator
    });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    if (err.code === 'DEAL_NOT_FOUND') {
      return res.status(404).json({ success: false, error: err.code, message: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/operator/resolve-customer
 * Manually resolves an ambiguous customer mapping using validated candidates.
 */
router.post('/resolve-customer', async (req, res, next) => {
  try {
    const { mappingId, chosenZohoContactId, reason } = req.body;
    const result = await DashboardService.resolveAmbiguousCustomer({
      mappingId,
      chosenZohoContactId,
      reason,
      operator: req.operator
    });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    if (err.code === 'INVALID_CANDIDATE' || err.code === 'INVALID_CANDIDATE_ID' || err.code === 'MAPPING_ALREADY_ACTIVE' || err.code === 'MISSING_RESOLUTION_DATA') {
      return res.status(400).json({ success: false, error: err.code, message: err.message });
    }
    if (err.code === 'MAPPING_NOT_FOUND') {
      return res.status(404).json({ success: false, error: err.code, message: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/operator/retry-reconciliation/:crmDealId
 * Retries supported reconciliation operations for a deal in RECONCILIATION_REQUIRED state.
 */
router.post('/retry-reconciliation/:crmDealId', async (req, res, next) => {
  try {
    const { crmDealId } = req.params;
    const result = await DashboardService.retryReconciliation({
      crmDealId,
      operator: req.operator
    });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    if (err.code === 'DEAL_NOT_FOUND') {
      return res.status(404).json({ success: false, error: err.code, message: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/operator/sync-payments/:crmDealId
 * Triggers on-demand reverse payment sync for a deal by polling Zoho Books.
 */
router.post('/sync-payments/:crmDealId', async (req, res, next) => {
  try {
    const { crmDealId } = req.params;
    const result = await DashboardService.triggerPaymentSync({
      crmDealId,
      operator: req.operator
    });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
