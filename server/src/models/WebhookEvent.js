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
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('WebhookEvent', WebhookEventSchema);

