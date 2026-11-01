require('dotenv').config();
const app = require('./app');
const { connectDB, disconnectDB } = require('./config/db');
const { validateEnv } = require('./config/env');
const ingressServer = require('../../scripts/webhookIngressGateway');
const DashboardService = require('./services/dashboardService');

const PORT = parseInt(process.env.PORT || '5000', 10);
const INGRESS_PORT = parseInt(process.env.INGRESS_PORT || '5001', 10);
const ENABLE_INGRESS = process.env.ENABLE_INGRESS_GATEWAY !== 'false' && process.env.WEBHOOK_INGRESS_ONLY !== 'true';
const AUTO_SYNC_ENABLED = process.env.ENABLE_AUTO_CRM_SYNC !== 'false';
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_POLL_INTERVAL_MS || '15000', 10);

async function startServer() {
  validateEnv();

  try {
    await connectDB();
  } catch (err) {
    console.warn('[SERVER WARNING] Server started without active MongoDB connection. Waiting for valid database credentials.');
  }

  const server = app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Integration Gateway Running on Port ${PORT}`);
    console.log(`📊 Dashboard UI: http://localhost:${PORT}/dashboard/`);
    console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
    console.log(`==================================================`);
  });

  if (ENABLE_INGRESS && INGRESS_PORT !== PORT) {
    ingressServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[INGRESS GATEWAY] Port ${INGRESS_PORT} is already bound by an existing process; primary server continues on port ${PORT}.`);
      } else {
        console.error(`[INGRESS GATEWAY ERROR]`, err.message);
      }
    });

    try {
      ingressServer.listen(INGRESS_PORT, '0.0.0.0', () => {
        console.log(`🛡️  Public Webhook Ingress Gateway Active on Port ${INGRESS_PORT}`);
        console.log(`🏥 Ingress Health: http://localhost:${INGRESS_PORT}/api/health`);
        console.log(`🔒 Forwarding webhooks securely to internal port ${PORT}`);
        console.log(`==================================================\n`);
      });
    } catch (err) {
      console.warn(`[INGRESS GATEWAY] Could not bind port ${INGRESS_PORT}:`, err.message);
    }
  }

  // Automated Real-Time Background Synchronization
  let syncIntervalTimer = null;
  if (AUTO_SYNC_ENABLED) {
    setTimeout(() => {
      DashboardService.checkAndSyncPendingHubSpotDeals().catch(() => {});
    }, 2000);

    syncIntervalTimer = setInterval(() => {
      DashboardService.checkAndSyncPendingHubSpotDeals().catch(() => {});
    }, SYNC_INTERVAL_MS);
    if (syncIntervalTimer.unref) syncIntervalTimer.unref();

    console.log(`🔄 Real-Time CRM Auto-Sync Active (Interval: ${SYNC_INTERVAL_MS / 1000}s)`);
  }

  const shutdown = async (signal) => {
    console.log(`\n[SHUTDOWN] Received ${signal}. Closing servers gracefully...`);
    if (syncIntervalTimer) clearInterval(syncIntervalTimer);
    server.close(() => {
      if (ingressServer && ingressServer.listening) {
        ingressServer.close(async () => {
          await disconnectDB();
          console.log('[SHUTDOWN] Completed.');
          process.exit(0);
        });
      } else {
        disconnectDB().then(() => {
          console.log('[SHUTDOWN] Completed.');
          process.exit(0);
        });
      }
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, ingressServer };
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
