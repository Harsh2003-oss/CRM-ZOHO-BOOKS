const mongoose = require('mongoose');

const IntegrationLogSchema = new mongoose.Schema(
  {
    timestamp: {
      type: Date,
      default: Date.now,
      index: true
    },
    crmDealId: {
      type: String,
      default: null,
      index: true
    },
    system: {
      type: String,
      required: true,
      enum: ['CRM', 'ZOHO_BOOKS'],
      index: true
    },
    direction: {
      type: String,
      required: true,
      enum: ['OUTBOUND', 'INBOUND_WEBHOOK'],
      index: true
    },
    method: {
      type: String,
      required: true,
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    },
    endpoint: {
      type: String,
      required: true
    },
    statusCode: {
      type: Number,
      required: true,
      index: true
    },
    requestBody: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    responseBody: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    durationMs: {
      type: Number,
      default: 0
    },
    isSuccess: {
      type: Boolean,
      required: true,
      index: true
    },
    error: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('IntegrationLog', IntegrationLogSchema);

