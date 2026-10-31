const express = require('express');
const WebhookService = require('../services/webhookService');
const QueueService = require('../services/queueService');

const router = express.Router();

/**
 * POST /api/webhooks/hubspot
 * High-speed webhook ingestion endpoint.
 * Returns HTTP 202 Accepted immediately (< 50ms) to ensure HubSpot CRM never waits for Zoho.
 */
router.post('/hubspot', async (req, res) => {
  const startTime = Date.now();

  try {
    const result = await WebhookService.processHubSpotWebhook(req.body);
    const durationMs = Date.now() - startTime;

    return res.status(202).json({
      success: true,
      message: 'HubSpot webhook received and durably persisted',
      durationMs,
      summary: result
    });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to process webhook event',
      message: err.message
    });
  }
});

/**
 * GET /api/webhooks/stats
 * Inspection endpoint for queue state and event counts.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await QueueService.getQueueStats();
    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      queue: stats
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

