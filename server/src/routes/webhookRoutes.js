const express = require('express');
const crypto = require('crypto');
const WebhookService = require('../services/webhookService');
const QueueService = require('../services/queueService');
const { verifyHubSpotSignatureV3, getRequestUri } = require('../utils/hubspotSignature');

const router = express.Router();

/**
 * POST /api/webhooks/hubspot
 * High-speed webhook ingestion endpoint with HubSpot Signature v3 authentication.
 * Returns HTTP 202 Accepted immediately (< 50ms) to ensure HubSpot CRM never waits for Zoho.
 */
router.post('/hubspot', async (req, res) => {
  const startTime = Date.now();

  // 1. Authenticity verification via HubSpot Signature v3
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET || process.env.HUBSPOT_WEBHOOK_SECRET;

  if ((process.env.NODE_ENV === 'production' || process.env.HUBSPOT_SIGNATURE_REQUIRED === 'true') && !clientSecret) {
    return res.status(503).json({
      success: false,
      error: 'SECURITY_CONFIG_ERROR',
      message: 'HubSpot webhook signature verification is mandatory in production but HUBSPOT_CLIENT_SECRET is not configured.'
    });
  }

  if (clientSecret) {
    const signature = req.headers['x-hubspot-signature-v3'] || req.headers['x-hubspot-signature'];
    const timestamp = req.headers['x-hubspot-request-timestamp'];

    if (!signature || !timestamp) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED_HUBSPOT_WEBHOOK',
        message: 'Missing required HubSpot webhook signature headers (X-HubSpot-Signature-v3 and X-HubSpot-Request-Timestamp).'
      });
    }

    const requestUri = getRequestUri(req);
    const verification = verifyHubSpotSignatureV3({
      method: req.method,
      requestUri,
      requestBody: req.rawBody !== undefined ? req.rawBody : '',
      timestamp,
      signature,
      clientSecret
    });

    if (!verification.valid) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED_HUBSPOT_WEBHOOK',
        message: verification.message || 'HubSpot webhook signature verification failed.'
      });
    }
  }

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
 * POST /api/webhooks/zoho
 * High-speed Zoho Books webhook ingestion endpoint.
 * Supports token authentication via X-Zoho-Webhook-Token, Authorization Bearer, or ?token=
 * Returns HTTP 202 Accepted immediately (< 50ms) to ensure Zoho Books never times out.
 */
router.post('/zoho', async (req, res) => {
  const startTime = Date.now();

  // 1. Authenticity verification if secret is configured
  const webhookSecret = process.env.ZOHO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : null;
    const headerToken = req.headers['x-zoho-webhook-token'];
    const queryToken = req.query.token || req.query.secret;
    const candidateToken = String(headerToken || bearerToken || queryToken || '').trim();

    if (!candidateToken) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED_ZOHO_WEBHOOK',
        message: 'Missing required Zoho webhook authentication token.'
      });
    }

    const secretBuf = Buffer.from(webhookSecret, 'utf8');
    const candBuf = Buffer.from(candidateToken, 'utf8');

    if (secretBuf.length !== candBuf.length || !crypto.timingSafeEqual(secretBuf, candBuf)) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED_ZOHO_WEBHOOK',
        message: 'Invalid Zoho webhook authentication token.'
      });
    }
  }

  // 2. Strict payload validation
  if (!req.body || typeof req.body !== 'object' || (Array.isArray(req.body) && req.body.length === 0)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_WEBHOOK_PAYLOAD',
      message: 'Request body must be a non-empty object or array.'
    });
  }

  try {
    const result = await WebhookService.processZohoWebhook(req.body);
    const durationMs = Date.now() - startTime;

    return res.status(202).json({
      success: true,
      message: 'Zoho Books webhook received and durably persisted',
      durationMs,
      summary: result
    });
  } catch (err) {
    if (err.code === 'INVALID_PAYLOAD') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_WEBHOOK_PAYLOAD',
        message: err.message
      });
    }

    console.error('[ZOHO WEBHOOK ERROR]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to process Zoho Books webhook event',
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

