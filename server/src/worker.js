require('dotenv').config();
const crypto = require('crypto');
const { connectDB, disconnectDB } = require('./config/db');
const { validateEnv } = require('./config/env');
const QueueService = require('./services/queueService');
const { OrchestrationService } = require('./services/orchestrationService');
const PaymentService = require('./services/paymentService');

/**
 * QueueWorker executes asynchronous background queue processing
 * decoupled completely from the Express HTTP server (zero ports opened).
 */
class QueueWorker {
  constructor(options = {}) {
    this.workerId = options.workerId || `worker_${process.pid}_${crypto.randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs || parseInt(process.env.WORKER_POLL_INTERVAL_MS || '3000', 10);
    this.leaseDurationMs = options.leaseDurationMs || parseInt(process.env.WORKER_LEASE_DURATION_MS || '300000', 10);
    this.maxAttempts = options.maxAttempts || parseInt(process.env.WORKER_MAX_ATTEMPTS || '3', 10);
    this.baseRetryDelayMs = options.baseRetryDelayMs || parseInt(process.env.WORKER_BASE_RETRY_DELAY_MS || '1000', 10);
    this.staleRecoveryIntervalMs = options.staleRecoveryIntervalMs || parseInt(process.env.WORKER_STALE_RECOVERY_INTERVAL_MS || '60000', 10);

    // Event filtering & Safety constraints
    this.allowedEventIds = options.allowedEventIds || (
      process.env.WORKER_ALLOWED_EVENT_IDS
        ? process.env.WORKER_ALLOWED_EVENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
        : null
    );

    const envIgnored = process.env.WORKER_IGNORE_EVENT_IDS
      ? process.env.WORKER_IGNORE_EVENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
      : ['hs_manual_test_01'];
    this.ignoredEventIds = options.ignoredEventIds || envIgnored;

    this.requireAllowlist = options.requireAllowlist !== undefined
      ? options.requireAllowlist
      : (process.env.WORKER_REQUIRE_ALLOWLIST === 'true');

    this.enabled = options.enabled !== undefined
      ? options.enabled
      : (process.env.WORKER_ENABLED === 'true');

    // Injected mock clients for testing
    this.injectedHubSpotClient = options.injectedHubSpotClient || null;
    this.injectedZohoClient = options.injectedZohoClient || null;

    // Optional tax overrides (e.g. 0% VAT testing)
    this.taxPercentage = options.taxPercentage !== undefined ? options.taxPercentage : null;
    this.taxId = options.taxId || null;

    // Runtime state
    this.isRunning = false;
    this.isProcessing = false;
    this.activeTaskPromise = null;
    this.pollTimer = null;
    this.lastStaleCheck = 0;
    this.processedCount = 0;
    this.disconnectOnShutdown = options.disconnectOnShutdown !== false;
  }

  /**
   * Evaluates startup readiness and safety constraints.
   * @returns {{ canRun: boolean, reason?: string }}
   */
  evaluateReadiness() {
    if (!this.enabled) {
      return {
        canRun: false,
        reason: 'Worker is disabled by default (WORKER_ENABLED !== true). Exiting safely without claiming events.'
      };
    }

    if (this.requireAllowlist && (!this.allowedEventIds || this.allowedEventIds.length === 0)) {
      return {
        canRun: false,
        reason: 'Worker requires an explicit event allowlist (WORKER_REQUIRE_ALLOWLIST=true), but none was provided.'
      };
    }

    return { canRun: true };
  }

  /**
   * Processes a single batch / event from the queue.
   * @returns {Promise<{ processed: boolean, eventId?: string, status?: string }>}
   */
  async processNext() {
    const readiness = this.evaluateReadiness();
    if (!readiness.canRun) {
      return { processed: false, reason: readiness.reason };
    }

    // Periodic stale-processing recovery with fencing guard
    const nowMs = Date.now();
    if (nowMs - this.lastStaleCheck >= this.staleRecoveryIntervalMs) {
      this.lastStaleCheck = nowMs;
      try {
        await QueueService.reclaimStaleProcessingEvents({
          lockTimeoutMs: this.leaseDurationMs,
          allowedEventIds: this.allowedEventIds,
          ignoredEventIds: this.ignoredEventIds
        });
      } catch (staleErr) {
        console.warn(`[WORKER WARNING] Stale recovery check failed: ${staleErr.message}`);
      }
    }

    // Attempt to claim and process next CRM event
    try {
      const result = await OrchestrationService.processNextQueuedEvent({
        injectedHubSpotClient: this.injectedHubSpotClient,
        injectedZohoClient: this.injectedZohoClient,
        workerId: this.workerId,
        allowedEventIds: this.allowedEventIds,
        ignoredEventIds: this.ignoredEventIds,
        maxAttempts: this.maxAttempts,
        baseRetryDelayMs: this.baseRetryDelayMs,
        taxPercentage: this.taxPercentage,
        taxId: this.taxId
      });

      if (result) {
        this.processedCount++;
        return { processed: true, eventId: result.eventId, result };
      }
    } catch (err) {
      // Error handling and status transitions are recorded atomically by QueueService
      return { processed: true, error: err.message };
    }

    return { processed: false };
  }

  /**
   * Starts the worker continuous polling loop.
   * @param {Object} [options]
   * @param {number} [options.maxEvents=Infinity] - Exit after processing N events (useful for testing)
   * @returns {Promise<{ status: string, processedCount: number }>}
   */
  async start({ maxEvents = Infinity } = {}) {
    const readiness = this.evaluateReadiness();
    if (!readiness.canRun) {
      console.log(`[WORKER] ${readiness.reason}`);
      return { status: 'STOPPED_PRE_FLIGHT', reason: readiness.reason, processedCount: 0 };
    }

    this.isRunning = true;
    console.log(`\n==================================================`);
    console.log(`⚙️  Queue Worker Active: ${this.workerId}`);
    console.log(`⏱️  Poll Interval: ${this.pollIntervalMs}ms | Lease: ${this.leaseDurationMs}ms`);
    if (this.allowedEventIds) {
      console.log(`🎯 Allowlist Filter: [${this.allowedEventIds.join(', ')}]`);
    }
    console.log(`🛡️  Ignorelist Filter: [${this.ignoredEventIds.join(', ')}]`);
    console.log(`==================================================\n`);

    while (this.isRunning && this.processedCount < maxEvents) {
      this.isProcessing = true;
      this.activeTaskPromise = this.processNext();
      const batchResult = await this.activeTaskPromise;
      this.isProcessing = false;
      this.activeTaskPromise = null;

      if (!batchResult.processed) {
        if (!this.isRunning || this.processedCount >= maxEvents) break;
        await new Promise((resolve) => {
          this.pollTimer = setTimeout(resolve, this.pollIntervalMs);
        });
        this.pollTimer = null;
      } else if (batchResult.error && maxEvents !== Infinity) {
        // When running in bounded test mode (maxEvents set), stop on unexpected error
        break;
      }
    }

    return { status: 'COMPLETED', processedCount: this.processedCount };
  }

  /**
   * Initiates graceful shutdown: finishes currently in-flight event then exits.
   */
  async stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.activeTaskPromise) {
      console.log(`[WORKER SHUTDOWN] In-flight job active. Awaiting completion...`);
      await this.activeTaskPromise;
    }

    return { status: 'STOPPED', processedCount: this.processedCount };
  }

  /**
   * Sets up process signal listeners for standalone execution.
   */
  setupSignalHandlers() {
    const handleSignal = async (signal) => {
      console.log(`\n[WORKER SHUTDOWN] Received ${signal}. Draining queue worker safely...`);
      await this.stop();
      if (this.disconnectOnShutdown) {
        await disconnectDB();
      }
      console.log('[WORKER SHUTDOWN] Worker process terminated gracefully.');
      process.exit(0);
    };

    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
  }
}

/**
 * CLI Execution Entry Point
 */
async function runStandaloneWorker() {
  validateEnv();

  const worker = new QueueWorker();
  const readiness = worker.evaluateReadiness();

  if (!readiness.canRun) {
    console.warn(`[WORKER STARTUP PREVENTED] ${readiness.reason}`);
    process.exit(0);
  }

  try {
    await connectDB();
  } catch (err) {
    console.error(`[WORKER ERROR] Database connection failed: ${err.message}`);
    process.exit(1);
  }

  worker.setupSignalHandlers();
  await worker.start();
}

if (require.main === module) {
  runStandaloneWorker().catch((err) => {
    console.error('[WORKER FATAL ERROR]', err);
    process.exit(1);
  });
}

module.exports = QueueWorker;
