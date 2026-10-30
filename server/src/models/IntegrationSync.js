const mongoose = require('mongoose');

const IntegrationSyncSchema = new mongoose.Schema(
  {
    crmDealId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    dealName: {
      type: String,
      default: ''
    },
    customerName: {
      type: String,
      default: ''
    },
    customerEmail: {
      type: String,
      default: ''
    },
    zohoContactId: {
      type: String,
      default: null,
      index: true
    },
    zohoSalesOrderId: {
      type: String,
      default: null,
      trim: true
    },
    zohoSalesOrderNumber: {
      type: String,
      default: null
    },
    zohoSalesOrderUrl: {
      type: String,
      default: null
    },
    salesOrderTotal: {
      type: Number,
      default: 0
    },
    currencyCode: {
      type: String,
      default: 'AED'
    },
    percentageInvoiced: {
      type: Number,
      default: 0
    },
    percentageCollected: {
      type: Number,
      default: 0
    },
    amountInvoicedUnpaid: {
      type: Number,
      default: 0
    },
    amountNotInvoiced: {
      type: Number,
      default: 0
    },
    nextDueDate: {
      type: Date,
      default: null
    },
    isOverdue: {
      type: Boolean,
      default: false
    },
    syncStatus: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'REQUIRES_MANUAL_MATCH', 'SYNCED', 'FAILED'],
      default: 'PENDING',
      index: true
    },
    failureReason: {
      type: String,
      default: null
    },
    retryCount: {
      type: Number,
      default: 0
    },
    lastSyncedValues: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    lastSyncedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

IntegrationSyncSchema.index(
  { zohoSalesOrderId: 1 },
  { unique: true, partialFilterExpression: { zohoSalesOrderId: { $type: 'string' } } }
);

module.exports = mongoose.model('IntegrationSync', IntegrationSyncSchema);
