const WebhookEvent = require('../models/WebhookEvent');

/**
 * QueueService manages durable asynchronous queue processing backed by MongoDB.
 * Uses atomic findOneAndUpdate to prevent race conditions and duplicate executions.
 */
class QueueService {
  /**
   * Atomically claims the next pending event for processing.
   * Only one worker can claim an event at any time.
   * @param {string} source - 'CRM' or 'ZOHO_BOOKS'
   * @returns {Promise<Document|null>}
   */
  static async claimNextEvent(source = 'CRM') {
    const claimed = await WebhookEvent.findOneAndUpdate(
      {
        source,
        status: 'RECEIVED'
      },
      {
        $set: {
          status: 'PROCESSING',
          updatedAt: new Date()
        }
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
          error: errorMessage,
          processedAt: new Date()
        }
      },
      { returnDocument: 'after' }
    );
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

module.exports = QueueService;
