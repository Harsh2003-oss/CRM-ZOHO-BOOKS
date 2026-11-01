/**
 * Standalone Public Webhook Ingress Gateway
 * 
 * Secure reverse proxy designed to sit at the network boundary (behind Cloudflare, AWS ALB, Nginx, or Reverse Tunnel).
 * 
 * Security Invariants:
 * 1. Strictly exposes ONLY webhook endpoints:
 *    - POST /api/webhooks/hubspot
 *    - POST /api/webhooks/zoho
 *    - GET  /api/health
 * 2. Rejects all other HTTP methods and paths with HTTP 404 (keeping /api/dashboard, /api/operator, and internal APIs 100% private).
 * 3. Preserves raw payload stream byte-for-byte to maintain HMAC-SHA256 signature validity.
 * 4. Reconstructs and forwards X-Forwarded-Host and X-Forwarded-Proto for upstream canonical URL reconstruction.
 */

require('dotenv').config();
const http = require('http');

const INGRESS_PORT = parseInt(process.env.INGRESS_PORT || '5001', 10);
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '5000', 10);

const ALLOWED_ROUTES = [
  { method: 'POST', path: '/api/webhooks/hubspot' },
  { method: 'POST', path: '/api/webhooks/zoho' },
  { method: 'GET', path: '/api/health' }
];

function isRouteAllowed(method, url) {
  const cleanPath = url.split('?')[0];
  return ALLOWED_ROUTES.some(
    (r) => r.method === method.toUpperCase() && r.path === cleanPath
  );
}

const server = http.createServer((req, res) => {
  const start = Date.now();

  // Route Allowlist Filter
  if (!isRouteAllowed(req.method, req.url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'ROUTE_NOT_FOUND',
      message: 'Ingress endpoint restricted to registered webhook receivers only.'
    }));
    return;
  }

  // Preserve and construct proxy headers
  const proxyHeaders = { ...req.headers };

  // Ensure public host is preserved in X-Forwarded-Host for HMAC Signature v3 reconstruction
  const incomingHost = req.headers['host'];
  if (!proxyHeaders['x-forwarded-host'] && incomingHost) {
    proxyHeaders['x-forwarded-host'] = incomingHost;
  }

  if (!proxyHeaders['x-forwarded-proto']) {
    proxyHeaders['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';
  }

  // Forward request to internal Express integration server
  const proxyReq = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: proxyHeaders
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on('end', () => {
        const duration = Date.now() - start;
        console.log(`[INGRESS] ${req.method} ${req.url.split('?')[0]} -> ${proxyRes.statusCode} (${duration}ms)`);
      });
    }
  );

  proxyReq.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      console.error(`[INGRESS ERROR] Target API server at ${TARGET_HOST}:${TARGET_PORT} is offline. Start the backend server with 'npm start' in another terminal.`);
    } else {
      console.error(`[INGRESS ERROR] Failed to forward request to ${TARGET_HOST}:${TARGET_PORT}:`, err.message);
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'BAD_GATEWAY',
      message: `Integration backend server at ${TARGET_HOST}:${TARGET_PORT} is offline. Ensure 'npm start' is running in another terminal.`
    }));
  });

  // Stream raw bytes directly to target without buffering or re-encoding
  req.pipe(proxyReq);
});

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[INGRESS GATEWAY] Port ${INGRESS_PORT} is already in use (primary server is already hosting ingress gateway).`);
      process.exit(0);
    } else {
      console.error(`[INGRESS GATEWAY FATAL]`, err);
      process.exit(1);
    }
  });

  server.listen(INGRESS_PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(`🛡️  Public Webhook Ingress Gateway Active on Port ${INGRESS_PORT}`);
    console.log(`🔒 Target: http://${TARGET_HOST}:${TARGET_PORT}`);
    console.log(`✅ Allowed Routes:`);
    ALLOWED_ROUTES.forEach((r) => console.log(`   - ${r.method} ${r.path}`));
    console.log(`🚫 All other dashboard & operator routes are BLOCKED (404)`);
    console.log(`==================================================`);
  });
}

module.exports = server;

