const crypto = require('crypto');

/**
 * Middleware to protect operator action endpoints.
 * Requires valid X-Operator-Key header or Bearer token.
 */
function requireOperatorAuth(req, res, next) {
  const configuredSecret = process.env.OPERATOR_API_KEY || 'operator_secure_dev_key_2026';

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

  const expectedBuf = Buffer.from(configuredSecret, 'utf8');
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
  requireOperatorAuth
};

