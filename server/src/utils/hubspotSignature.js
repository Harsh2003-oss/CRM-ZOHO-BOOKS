const crypto = require('crypto');

/**
 * Normalizes the Request URI according to HubSpot's official Signature v3 specification.
 * Decodes the exact set of 12 percent-encoded characters specified by HubSpot:
 * %3A (:), %2F (/), %3F (?), %40 (@), %21 (!), %24 ($), %27 ('), %28 ((), %29 ()), %2A (*), %2C (,), %3B (;)
 *
 * Handles both uppercase and lowercase hex digits (%2f vs %2F) consistently.
 * Leaves all other percent-encoded characters (e.g. %20, %26, %3D) and query-string parameter orders untouched.
 *
 * @param {string} uri - Raw request URI (path + query)
 * @returns {string} Normalized URI
 */
function normalizeHubSpotUri(uri) {
  if (!uri || typeof uri !== 'string') {
    return '';
  }
  return uri.replace(
    /%(21|24|27|28|29|2A|2C|2F|3A|3B|3F|40)/gi,
    (match) => decodeURIComponent(match)
  );
}

/**
 * Generate HubSpot Signature v3 (HMAC-SHA256, Base64).
 * According to HubSpot's official specification:
 * source = HTTP_METHOD + NORMALIZED_REQUEST_URI + REQUEST_BODY + TIMESTAMP
 *
 * @param {Object} params
 * @param {string} params.method - HTTP method (e.g., 'POST', 'GET')
 * @param {string} params.requestUri - Full request URI including protocol, host, path, and query params
 * @param {string} [params.requestBody=''] - Raw unmodified request body UTF-8 string
 * @param {number|string} params.timestamp - Epoch timestamp in milliseconds from X-HubSpot-Request-Timestamp
 * @param {string} params.clientSecret - HubSpot app client secret
 * @returns {string} Base64 encoded HMAC-SHA256 digest
 */
function generateHubSpotSignatureV3({ method = 'POST', requestUri, requestBody = '', timestamp, clientSecret }) {
  if (!clientSecret || typeof clientSecret !== 'string') {
    throw new Error('HubSpot clientSecret is required to generate signature v3.');
  }
  if (!requestUri || typeof requestUri !== 'string') {
    throw new Error('requestUri is required to generate signature v3.');
  }
  if (timestamp === undefined || timestamp === null) {
    throw new Error('timestamp is required to generate signature v3.');
  }

  const normalizedMethod = String(method).toUpperCase();
  const normalizedUri = normalizeHubSpotUri(requestUri);
  const normalizedBody = typeof requestBody === 'string' ? requestBody : '';
  const normalizedTimestamp = String(timestamp).trim();

  const source = `${normalizedMethod}${normalizedUri}${normalizedBody}${normalizedTimestamp}`;
  return crypto.createHmac('sha256', clientSecret).update(source, 'utf8').digest('base64');
}

/**
 * Reconstruct the full canonical request URI from an Express request.
 * Honors Express proxy trust settings:
 * - Protocol: uses req.protocol (which evaluates X-Forwarded-Proto ONLY if proxy is trusted)
 * - Host: uses X-Forwarded-Host only if the proxy is trusted, otherwise falling back to standard Host header
 * - Reconstructed URI is normalized according to HubSpot's percent-encoding rules
 *
 * @param {import('express').Request} req
 * @returns {string} Full normalized URI (e.g. 'https://api.example.com/api/webhooks/hubspot?param=1')
 */
function getRequestUri(req) {
  const isProxyTrusted = Boolean(req.app ? req.app.get('trust proxy') : false);

  // Protocol: req.protocol honors X-Forwarded-Proto only when proxy is trusted by Express
  const proto = req.protocol || 'http';

  // Host: use X-Forwarded-Host only if the proxy is trusted, otherwise use standard Host header
  let host;
  if (isProxyTrusted && req.headers['x-forwarded-host']) {
    host = String(req.headers['x-forwarded-host']).split(',')[0].trim();
  } else {
    host = (req.get ? req.get('host') : req.headers['host']) || 'localhost';
  }

  const originalUrl = req.originalUrl || req.url || '';
  const rawUri = `${proto}://${host}${originalUrl}`;
  return normalizeHubSpotUri(rawUri);
}

/**
 * Verify incoming request against HubSpot Signature v3 specification.
 *
 * @param {Object} params
 * @param {string} params.method - HTTP method (e.g., 'POST')
 * @param {string} params.requestUri - Full request URI
 * @param {string} [params.requestBody=''] - Raw unmodified request body
 * @param {number|string} params.timestamp - Header value of X-HubSpot-Request-Timestamp
 * @param {string} params.signature - Header value of X-HubSpot-Signature-v3
 * @param {string} params.clientSecret - Configured HubSpot app client secret
 * @param {number} [params.maxAgeMs=300000] - Freshness tolerance in ms (default: 5 minutes / 300,000 ms)
 * @param {number} [params.now=Date.now()] - Current epoch ms (injectable for testing)
 * @returns {{ valid: boolean, error?: string, message?: string }}
 */
function verifyHubSpotSignatureV3({
  method,
  requestUri,
  requestBody = '',
  timestamp,
  signature,
  clientSecret,
  maxAgeMs = 300000,
  now = Date.now()
}) {
  if (!clientSecret) {
    return {
      valid: false,
      error: 'MISSING_SECRET',
      message: 'HubSpot client secret is not configured'
    };
  }

  if (!signature || typeof signature !== 'string') {
    return {
      valid: false,
      error: 'MISSING_SIGNATURE',
      message: 'Missing or invalid X-HubSpot-Signature-v3 header'
    };
  }

  if (timestamp === undefined || timestamp === null || String(timestamp).trim() === '') {
    return {
      valid: false,
      error: 'MISSING_TIMESTAMP',
      message: 'Missing or empty X-HubSpot-Request-Timestamp header'
    };
  }

  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp)) {
    return {
      valid: false,
      error: 'INVALID_TIMESTAMP',
      message: 'X-HubSpot-Request-Timestamp header must be a valid numeric timestamp'
    };
  }

  const ageMs = Math.abs(now - parsedTimestamp);
  if (ageMs > maxAgeMs) {
    return {
      valid: false,
      error: 'TIMESTAMP_EXPIRED',
      message: `HubSpot request timestamp is outside the allowable freshness window (${ageMs}ms > ${maxAgeMs}ms)`
    };
  }

  const expectedSignature = generateHubSpotSignatureV3({
    method,
    requestUri,
    requestBody,
    timestamp: String(timestamp).trim(),
    clientSecret
  });

  const sigBuf = Buffer.from(signature.trim(), 'utf8');
  const expBuf = Buffer.from(expectedSignature, 'utf8');

  // Constant-time comparison to prevent timing side-channel attacks
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return {
      valid: false,
      error: 'INVALID_SIGNATURE',
      message: 'HubSpot signature v3 verification failed (signature mismatch)'
    };
  }

  return { valid: true };
}

module.exports = {
  normalizeHubSpotUri,
  generateHubSpotSignatureV3,
  getRequestUri,
  verifyHubSpotSignatureV3
};
