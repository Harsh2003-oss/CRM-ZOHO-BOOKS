const mongoose = require('mongoose');

const MilestoneInvoiceSchema = new mongoose.Schema(
  {
    crmDealId: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    syncId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IntegrationSync',
      required: true,
      index: true
    },
    milestoneIndex: {
      type: Number,
      required: true,
      enum: [1, 2, 3]
    },
    milestoneName: {
      type: String,
      required: true,
      enum: ['Signing', 'Go-Live', '90 Days Post Go-Live']
    },
    percentage: {
      type: Number,
      required: true,
      enum: [50, 30, 20]
    },
    subtotal: {
      type: Number,
      required: true
    },
    taxAmount: {
      type: Number,
      default: 0
    },
    totalAmount: {
      type: Number,
      required: true
    },
    zohoInvoiceId: {
      type: String,
      default: null,
      trim: true
    },
    zohoInvoiceNumber: {
      type: String,
      default: null
    },
    zohoSalesOrderId: {
      type: String,
      default: null,
      trim: true
    },
    zohoSalesOrderItemId: {
      type: String,
      default: null,
      trim: true
    },
    currencyCode: {
      type: String,
      default: 'AED'
    },
    referenceNumber: {
      type: String,
      default: null,
      trim: true
    },
    status: {
      type: String,
      enum: ['PENDING_TRIGGER', 'PENDING_RECONCILIATION', 'FAILED_VALIDATION', 'CREATED', 'SENT', 'PAID', 'PARTIALLY_PAID', 'VOIDED'],
      default: 'PENDING_TRIGGER',
      index: true
    },
    failureReason: {
      type: String,
      default: null
    },
    balance: {
      type: Number,
      default: 0
    },
    dueDate: {
      type: Date,
      default: null
    },
    paidAt: {
      type: Date,
      default: null
    },
    voidedReason: {
      type: String,
      default: null
    },
    voidedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Compound Unique Index: A deal can only ever have ONE record per milestone index
MilestoneInvoiceSchema.index({ crmDealId: 1, milestoneIndex: 1 }, { unique: true });

// Optional Unique Index for zohoInvoiceId only when it is a non-null string
MilestoneInvoiceSchema.index(
  { zohoInvoiceId: 1 },
  { unique: true, partialFilterExpression: { zohoInvoiceId: { $type: 'string' } } }
);

module.exports = mongoose.model('MilestoneInvoice', MilestoneInvoiceSchema);
