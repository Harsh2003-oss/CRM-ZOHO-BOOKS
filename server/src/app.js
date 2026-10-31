const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const healthRoutes = require('./routes/healthRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const operatorRoutes = require('./routes/operatorRoutes');

const app = express();

/**
 * Configure Express reverse-proxy trust settings.
 * Fails safely by refusing to blindly trust all upstream proxies.
 * Requires explicit TRUST_PROXY configuration in production (e.g. 1 for ALB/Render/Railway, or trusted CIDR).
 * Preserves local development and test behavior by defaulting to 'loopback' in non-production.
 */
function configureTrustProxy(appInstance) {
  const rawTrustProxy = process.env.TRUST_PROXY;
  const isProd = process.env.NODE_ENV === 'production';

  if (rawTrustProxy !== undefined && rawTrustProxy !== '') {
    const trimmed = rawTrustProxy.trim();
    if (trimmed.toLowerCase() === 'false' || trimmed === '0') {
      appInstance.set('trust proxy', false);
    } else if (trimmed.toLowerCase() === 'true') {
      appInstance.set('trust proxy', true);
    } else if (/^\d+$/.test(trimmed)) {
      appInstance.set('trust proxy', parseInt(trimmed, 10));
    } else {
      appInstance.set('trust proxy', trimmed);
    }
  } else if (isProd) {
    // Fail safely in production: do NOT guess that 1 hop is correct when topology is unestablished.
    appInstance.set('trust proxy', false);
    console.warn('[SECURITY CONFIG] TRUST_PROXY is not configured in production. Defaulting safely to false (untrusted proxy). If deployed behind an ALB, ingress, or reverse proxy, configure TRUST_PROXY (e.g. TRUST_PROXY=1) in your environment.');
  } else {
    // Preserve local development and test behavior
    appInstance.set('trust proxy', 'loopback');
  }
}

configureTrustProxy(app);

// Middlewares
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf, encoding) => {
    // Preserve raw request body exactly as transmitted for HMAC signature validation
    req.rawBody = buf ? buf.toString(encoding || 'utf8') : '';
  }
}));

// Request logging (sanitized)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/api/health') {
      console.log(`[HTTP] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Mount Routes
app.use('/api', healthRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/operator', operatorRoutes);

// Serve static frontend assets for Dashboard (React + Vite production build)
const clientDistPath = path.join(__dirname, '../../client/dist');
const publicFallbackPath = path.join(__dirname, '../public');
const dashboardStaticPath = fs.existsSync(clientDistPath) ? clientDistPath : publicFallbackPath;

app.use('/dashboard', express.static(dashboardStaticPath));
app.get(/^\/dashboard(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(dashboardStaticPath, 'index.html'));
});

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'CRM & Zoho Books Integration Gateway',
    version: '1.0.0',
    status: 'online',
    health: '/api/health'
  });
});

// Central Error Handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.message);
  res.status(err.status || 500).json({
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred'
  });
});

module.exports = app;

