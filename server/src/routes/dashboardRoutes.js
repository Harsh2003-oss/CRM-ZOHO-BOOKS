const express = require('express');
const DashboardService = require('../services/dashboardService');

const router = express.Router();

/**
 * GET /api/dashboard/summary
 * Overview KPIs grouped by currency, distinguishing invoiced vs not-yet-invoiced contract value.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const { currency } = req.query;
    // Trigger non-blocking real-time sync for pending HubSpot deals
    DashboardService.checkAndSyncPendingHubSpotDeals().catch(() => {});
    const summary = await DashboardService.getSummaryMetrics({ currency });
    res.json({
      success: true,
      data: summary
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/collections
 * Customer-level collections aging table with aging buckets, pagination, and search.
 */
router.get('/collections', async (req, res, next) => {
  try {
    const { page, limit, search, currency, referenceDate, agingBasis } = req.query;
    const collections = await DashboardService.getCollectionsAging({
      page,
      limit,
      search,
      currency,
      referenceDate: referenceDate ? new Date(referenceDate) : new Date(),
      agingBasis: agingBasis || 'DUE_DATE'
    });
    res.json({
      success: true,
      data: collections
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/logs
 * Paginated integration audit logs with sensitive field redaction and search.
 */
router.get('/logs', async (req, res, next) => {
  try {
    const { page, limit, system, isSuccess, search } = req.query;
    const logs = await DashboardService.getIntegrationLogs({
      page,
      limit,
      system,
      isSuccess,
      search
    });
    res.json({
      success: true,
      data: logs
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/events
 * Webhook queue inspection and event history with status filtering.
 */
router.get('/events', async (req, res, next) => {
  try {
    const { page, limit, status, source } = req.query;
    const events = await DashboardService.getIntegrationEvents({
      page,
      limit,
      status,
      source
    });
    res.json({
      success: true,
      data: events
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/exceptions
 * Actionable operational exceptions (ambiguous mappings, failed syncs, reconciliations).
 */
router.get('/exceptions', async (req, res, next) => {
  try {
    const exceptions = await DashboardService.getExceptions();
    res.json({
      success: true,
      data: exceptions
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/deals
 * Paginated CRM deals tracked in the integration system with status and search.
 */
router.get('/deals', async (req, res, next) => {
  try {
    const { page, limit, search, currency, syncStatus } = req.query;
    const deals = await DashboardService.getDeals({
      page,
      limit,
      search,
      currency,
      syncStatus
    });
    res.json({
      success: true,
      data: deals
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

