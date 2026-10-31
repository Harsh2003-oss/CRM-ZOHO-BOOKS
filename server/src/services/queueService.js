const crypto = require('crypto');
const WebhookEvent = require('../models/WebhookEvent');

/**
 * QueueService manages durable asynchronous queue processing backed by MongoDB.
 * Uses atomic findOneAndUpdate to prevent race conditions and duplicate executions.
 */
class QueueService {
  /**
   * Atomically claims the next pending event for processing.
   * Only one worker can claim an event at any time.
   *
   * @param {string|Object} sourceOrOptions - 'CRM', 'ZOHO_BOOKS', or options object
   * @param {Object} [maybeOptions] - Additional options when first param is string
   * @param {string} [maybeOptions.workerId] - Unique worker ID holding the lease
   * @param {number} [maybeOptions.leaseDurationMs] - Lease duration in milliseconds (default: 5 mins)
   * @param {Array<string>} [maybeOptions.allowedEventIds] - Explicit allowlist of event IDs
   * @param {Array<string>} [maybeOptions.ignoredEventIds] - Explicit ignorelist of event IDs
   * @param {Date} [maybeOptions.now] - Current time override
   * @returns {Promise<Document|null>}
   */
  static async claimNextEvent(sourceOrOptions = 'CRM', maybeOptions = {}) {
    const isOptionsObj = typeof sourceOrOptions === 'object' && sourceOrOptions !== null;
    const source = isOptionsObj ? (sourceOrOptions.source || 'CRM') : (sourceOrOptions || 'CRM');
    const options = isOptionsObj ? sourceOrOptions : maybeOptions;

    const now = options.now || new Date();
    const query = {
      source,
      status: 'RECEIVED',
      $or: [
        { nextAttemptAfter: null },
        { nextAttemptAfter: { $lte: now } }
      ]
    };

    if (Array.isArray(options.allowedEventIds)) {
      if (options.allowedEventIds.length === 0) {
        // Explicitly provided empty allowlist must fail closed immediately
        return null;
      }
      query.eventId = { $in: [...options.allowedEventIds] };
    }

    // Defense-in-depth: exclude protected historical IDs by default at QueueService layer
    const envIgnored = process.env.WORKER_IGNORE_EVENT_IDS
      ? process.env.WORKER_IGNORE_EVENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const customIgnored = options.ignoredEventIds || envIgnored;
    const ignored = Array.from(new Set([...QueueService.DEFAULT_PROTECTED_EVENT_IDS, ...customIgnored]));

    if (ignored.length > 0) {
      if (query.eventId && query.eventId.$in) {
        query.eventId.$in = query.eventId.$in.filter((id) => !ignored.includes(id));
        if (query.eventId.$in.length === 0) {
          return null;
        }
      } else {
        query.eventId = { $nin: ignored };
      }
    }

    const leaseDurationMs = options.leaseDurationMs || 5 * 60 * 1000;
    const workerId = options.workerId || `worker_${process.pid}_${crypto.randomUUID()}`;
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const claimed = await WebhookEvent.findOneAndUpdate(
      query,
      {
        $set: {
          status: 'PROCESSING',
          lockedBy: workerId,
          leaseExpiresAt,
          lastAttemptAt: now,
          updatedAt: now
        },
        $inc: { attempts: 1 }
      },
      {
        sort: { createdAt: 1, _id: 1 }, // Deterministic FIFO processing
        returnDocument: 'after'
      }
    );

    return claimed;
  }

  /**
   * Marks a claimed event as successfully processed.
   * @param {string} eventId
   */
  static async markCompleted(eventId) {
    return WebhookEvent.findOneAndUpdate(
      { eventId },
      {
        $set: {
          status: 'PROCESSED',
          lockedBy: null,
          leaseExpiresAt: null,
          processedAt: new Date(),
          error: null
        }
      },
      { returnDocument: 'after' }
    );
  }

  /**
   * Marks an event as failed with error details for dead-letter handling.
   * @param {string} eventId
   * @param {string} errorMessage
   */
  static async markFailed(eventId, errorMessage) {
    return WebhookEvent.findOneAndUpdate(
      { eventId },
      {
        $set: {
          status: 'FAILED',
          lockedBy: null,
          leaseExpiresAt: null,
          error: errorMessage,
          processedAt: new Date()
        }
      },
      { returnDocument: 'after' }
    );
  }

  /**
   * Determines whether an error is transient/retryable.
   * Permanent errors (4xx client validation, schema/data corruption) are NOT retried.
   * @param {Error|Object} err
   * @returns {boolean}
   */
  static isRetryableError(err) {
    if (!err) return false;
    if (err.isPermanent === true || err.isRetryable === false) return false;

    // Permanent application error codes
    const permanentCodes = [
      'INVALID_DEAL_DATA',
      'MISSING_REQUIRED_FIELD',
      'UNSUPPORTED_EVENT_TYPE',
      'MISSING_DEAL_ID',
      'INVALID_CANDIDATE_ID'
    ];
    if (err.code && permanentCodes.includes(err.code)) return false;

    // HTTP 4xx (except 429 Rate Limit) are permanent client errors
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
      return false;
    }

    // Explicit transient codes
    if (err.statusCode === 429 || (err.statusCode >= 500 && err.statusCode < 600)) return true;
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return true;
    if (err.code === 'RATE_LIMIT_EXCEEDED' || err.code === 'HUBSPOT_FETCH_FAILED' || err.code === 'ZOHO_TIMEOUT') return true;
    if (err.code === 'DEAL_LOCKED_BY_ANOTHER_WORKER' || err.code === 'CONCURRENT_EXECUTION_CONFLICT') return true;

    // Default runtime errors are considered transient unless maxAttempts is reached
    return true;
  }

  /**
   * Handles event execution failure by scheduling exponential retry or dead-lettering.
   *
   * @param {string} eventId
   * @param {Error|Object} error
   * @param {Object} [options]
   * @param {number} [options.maxAttempts=3]
   * @param {number} [options.baseDelayMs=1000]
   * @param {boolean} [options.isRetryable]
   * @returns {Promise<Document|null>}
   */
  static async handleEventFailure(eventId, error, options = {}) {
    const event = await WebhookEvent.findOne({ eventId });
    if (!event) return null;

    const errorMessage = error?.message || String(error);
    const maxAttempts = options.maxAttempts || event.maxAttempts || 3;
    const isRetryable = options.isRetryable !== undefined
      ? options.isRetryable
      : this.isRetryableError(error);

    if (isRetryable && event.attempts < maxAttempts) {
      // Schedule exponential backoff: 2^(attempts-1) * baseDelayMs (capped at 60s)
      const baseDelayMs = options.baseDelayMs || 1000;
      const backoffMs = Math.min(baseDelayMs * Math.pow(2, Math.max(0, event.attempts - 1)), 60000);
      const nextAttemptAfter = new Date(Date.now() + backoffMs);

      return WebhookEvent.findOneAndUpdate(
        { eventId },
        {
          $set: {
            status: 'RECEIVED',
            lockedBy: null,
            leaseExpiresAt: null,
            error: `[Retryable Attempt ${event.attempts}/${maxAttempts}] ${errorMessage}`,
            nextAttemptAfter,
            updatedAt: new Date()
          }
        },
        { returnDocument: 'after' }
      );
    }

    // Permanent failure or max attempts exhausted -> mark FAILED
    const failureReason = !isRetryable
      ? `[Permanent Error] ${errorMessage}`
      : `[Max Attempts Exhausted (${event.attempts}/${maxAttempts})] ${errorMessage}`;

    return WebhookEvent.findOneAndUpdate(
      { eventId },
      {
        $set: {
          status: 'FAILED',
          lockedBy: null,
          leaseExpiresAt: null,
          error: failureReason,
          processedAt: new Date(),
          updatedAt: new Date()
        }
      },
      { returnDocument: 'after' }
    );
  }

  /**
   * Reclaims stale PROCESSING events whose lease has expired,
   * provided the underlying deal orchestration lock is NOT currently active.
   *
   * @param {Object} [options]
   * @param {number} [options.lockTimeoutMs] - Fallback timeout for documents missing leaseExpiresAt
   * @param {Array<string>} [options.allowedEventIds] - Optional allowlist of event IDs to reclaim
   * @param {Array<string>} [options.ignoredEventIds] - Optional ignorelist
   * @param {Date} [options.now] - Current time override
   * @returns {Promise<{ reclaimed: number, skippedActiveLease: number, results: Array<Object> }>}
   */
  static async reclaimStaleProcessingEvents(options = {}) {
    const now = options.now || new Date();
    let IntegrationSync = null;
    try {
      IntegrationSync = require('../models/IntegrationSync');
    } catch {
      // Lazy model load
    }

    const staleQuery = {
      status: 'PROCESSING',
      $or: [
        { leaseExpiresAt: { $lt: now } },
        { leaseExpiresAt: null, updatedAt: { $lt: new Date(now.getTime() - (options.lockTimeoutMs || 10 * 60 * 1000)) } }
      ]
    };

    if (Array.isArray(options.allowedEventIds)) {
      if (options.allowedEventIds.length === 0) {
        return { reclaimed: 0, skippedActiveLease: 0, results: [] };
      }
      staleQuery.eventId = { $in: [...options.allowedEventIds] };
    }

    const envIgnored = process.env.WORKER_IGNORE_EVENT_IDS
      ? process.env.WORKER_IGNORE_EVENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const customIgnored = options.ignoredEventIds || envIgnored;
    const ignored = Array.from(new Set([...QueueService.DEFAULT_PROTECTED_EVENT_IDS, ...customIgnored]));

    if (ignored.length > 0) {
      if (staleQuery.eventId && staleQuery.eventId.$in) {
        staleQuery.eventId.$in = staleQuery.eventId.$in.filter((id) => !ignored.includes(id));
        if (staleQuery.eventId.$in.length === 0) {
          return { reclaimed: 0, skippedActiveLease: 0, results: [] };
        }
      } else {
        staleQuery.eventId = { $nin: ignored };
      }
    }

    const candidateEvents = await WebhookEvent.find(staleQuery).lean();
    let reclaimed = 0;
    let skippedActiveLease = 0;
    const results = [];

    for (const evt of candidateEvents) {
      const payload = evt.payload || {};
      const crmDealId = String(payload.objectId || payload.dealId || '');

      // CRITICAL FENCING SAFEGUARD:
      // Verify whether IntegrationSync still holds an active, unexpired lease!
      if (crmDealId && IntegrationSync && IntegrationSync.db?.readyState) {
        const syncDoc = await IntegrationSync.findOne({ crmDealId }).lean();
        if (syncDoc) {
          const orchActive = syncDoc.orchestrationLockedBy &&
            syncDoc.orchestrationLeaseExpiresAt &&
            new Date(syncDoc.orchestrationLeaseExpiresAt) > now;
          const soActive = syncDoc.lockedBy &&
            syncDoc.leaseExpiresAt &&
            new Date(syncDoc.leaseExpiresAt) > now;

          if (orchActive || soActive) {
            // An active worker lease exists on the underlying financial deal!
            // NEVER reclaim merely because event lease expired while the financial transaction lease is still alive!
            skippedActiveLease++;
            continue;
          }
        }
      }

      // Safe to reclaim
      const maxAttempts = evt.maxAttempts || 3;
      if (evt.attempts < maxAttempts) {
        await WebhookEvent.updateOne(
          { _id: evt._id, status: 'PROCESSING' },
          {
            $set: {
              status: 'RECEIVED',
              lockedBy: null,
              leaseExpiresAt: null,
              error: `[Lease Expired & Recovered] Previous worker lease expired. Re-queued for processing (Attempt ${evt.attempts}/${maxAttempts}).`,
              nextAttemptAfter: now,
              updatedAt: now
            }
          }
        );
        reclaimed++;
        results.push({ eventId: evt.eventId, action: 'RECLAIMED_TO_RECEIVED' });
      } else {
        await WebhookEvent.updateOne(
          { _id: evt._id, status: 'PROCESSING' },
          {
            $set: {
              status: 'FAILED',
              lockedBy: null,
              leaseExpiresAt: null,
              error: `[Lease Expired & Max Attempts Exhausted] Worker lease expired and attempts (${evt.attempts}/${maxAttempts}) exhausted.`,
              processedAt: now,
              updatedAt: now
            }
          }
        );
        reclaimed++;
        results.push({ eventId: evt.eventId, action: 'MOVED_TO_FAILED' });
      }
    }

    return { reclaimed, skippedActiveLease, results };
  }

  /**
   * Returns current queue statistics.
   */
  static async getQueueStats() {
    const stats = await WebhookEvent.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const result = {
      RECEIVED: 0,
      PROCESSING: 0,
      PROCESSED: 0,
      FAILED: 0,
      IGNORED: 0
    };

    stats.forEach((s) => {
      if (result[s._id] !== undefined) {
        result[s._id] = s.count;
      }
    });

    return result;
  }
}

QueueService.DEFAULT_PROTECTED_EVENT_IDS = Object.freeze(['hs_manual_test_01']);

module.exports = QueueService;
