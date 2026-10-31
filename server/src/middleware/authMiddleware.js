const crypto = require('crypto');

const DEV_UNSAFE_DEFAULT_KEY = 'operator_secure_dev_key_2026';

/**
 * Middleware to protect operator action endpoints.
 * Requires valid X-Operator-Key header or Bearer token.
 * 
 * Production Hardening:
 * - Fails closed (HTTP 503) if OPERATOR_API_KEY (or OPERATOR_KEY) is missing, empty,
 *   or matches the development default in production (NODE_ENV === 'production').
 * - Only permits DEV_UNSAFE_DEFAULT_KEY in non-production environments (test/development).
 */
function requireOperatorAuth(req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';
  const configuredKey = (process.env.OPERATOR_API_KEY || process.env.OPERATOR_KEY || '').trim();

  // Production Fail-Closed Safety Check
  if (isProduction) {
    if (!configuredKey || configuredKey === DEV_UNSAFE_DEFAULT_KEY || configuredKey === 'op_secret_key_2026') {
      console.error('[SECURITY ERROR] Operator API is disabled: OPERATOR_API_KEY is not configured or uses an insecure development default in production.');
      return res.status(503).json({
        success: false,
        error: 'OPERATOR_SERVICE_UNCONFIGURED',
        message: 'Operator authorization is unavailable: secure production OPERATOR_API_KEY must be configured in environment.'
      });
    }
  }

  const effectiveSecret = configuredKey || DEV_UNSAFE_DEFAULT_KEY;

  const headerKey = req.headers['x-operator-key'];
  const authHeader = req.headers['authorization'];
  const bearerKey = authHeader && authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  const candidateKey = String(headerKey || bearerKey || '').trim();

  if (!candidateKey) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED_OPERATOR',
      message: 'Operator authorization is required. Please provide a valid X-Operator-Key or Bearer token.'
    });
  }

  const expectedBuf = Buffer.from(effectiveSecret, 'utf8');
  const candidateBuf = Buffer.from(candidateKey, 'utf8');

  if (expectedBuf.length !== candidateBuf.length || !crypto.timingSafeEqual(expectedBuf, candidateBuf)) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED_OPERATOR',
      message: 'Invalid operator authorization key.'
    });
  }

  req.operator = {
    role: 'OPERATOR',
    authorizedAt: new Date()
  };

  next();
}

module.exports = {
  requireOperatorAuth,
  DEV_UNSAFE_DEFAULT_KEY
};
