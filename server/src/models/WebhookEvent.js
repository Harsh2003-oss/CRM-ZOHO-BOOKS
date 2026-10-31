const mongoose = require('mongoose');

const WebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    source: {
      type: String,
      required: true,
      enum: ['CRM', 'ZOHO_BOOKS'],
      index: true
    },
    eventType: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      enum: ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED'],
      default: 'RECEIVED',
      index: true
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    error: {
      type: String,
      default: null
    },
    processedAt: {
      type: Date,
      default: null
    },
    attempts: {
      type: Number,
      default: 0,
      index: true
    },
    maxAttempts: {
      type: Number,
      default: 3
    },
    lastAttemptAt: {
      type: Date,
      default: null
    },
    lockedBy: {
      type: String,
      default: null,
      index: true
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true
    },
    nextAttemptAfter: {
      type: Date,
      default: null,
      index: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('WebhookEvent', WebhookEventSchema);

