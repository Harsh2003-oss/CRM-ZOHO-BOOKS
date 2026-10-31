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
    zohoSalesOrderLineItemId: {
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
    salesOrderSubtotal: {
      type: Number,
      default: 0
    },
    salesOrderTax: {
      type: Number,
      default: 0
    },
    salesOrderStatus: {
      type: String,
      enum: ['NONE', 'DRAFT', 'CONFIRMED'],
      default: 'NONE',
      index: true
    },
    lockedBy: {
      type: String,
      default: null
    },
    lockedAt: {
      type: Date,
      default: null
    },
    leaseExpiresAt: {
      type: Date,
      default: null
    },
    orchestrationLockedBy: {
      type: String,
      default: null
    },
    orchestrationLockedAt: {
      type: Date,
      default: null
    },
    orchestrationLeaseExpiresAt: {
      type: Date,
      default: null
    },
    currencyCode: {
      type: String,
      default: 'AED'
    },
    totalInvoicedAmount: {
      type: Number,
      default: 0
    },
    percentageInvoiced: {
      type: Number,
      default: 0
    },
    amountCollected: {
      type: Number,
      default: 0
    },
    percentageCollected: {
      type: Number,
      default: 0
    },
    paymentInfoStatus: {
      type: String,
      enum: ['DETERMINED', 'PAYMENT_INFO_UNAVAILABLE'],
      default: 'DETERMINED'
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
    confirmedGoLiveDate: {
      type: Date,
      default: null
    },
    goLiveVerifiedAt: {
      type: Date,
      default: null
    },
    m3EligibleAt: {
      type: Date,
      default: null,
      index: true
    },
    syncStatus: {
      type: String,
      enum: [
        'PENDING',
        'PROCESSING',
        'REQUIRES_MANUAL_MATCH',
        'SALES_ORDER_DRAFT',
        'SALES_ORDER_CONFIRMED',
        'M1_INVOICED',
        'M2_INVOICED',
        'M3_INVOICED',
        'HUBSPOT_SYNC_FAILED',
        'RECONCILIATION_REQUIRED',
        'SYNCED',
        'FAILED'
      ],
      default: 'PENDING',
      index: true
    },
    reconciliationMilestoneIndex: {
      type: Number,
      default: null
    },
    reconciliationReason: {
      type: String,
      default: null
    },
    reconciliationRequestedAt: {
      type: Date,
      default: null
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
