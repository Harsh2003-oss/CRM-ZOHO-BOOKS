const mongoose = require('mongoose');

const PaymentRecordSchema = new mongoose.Schema(
  {
    paymentId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    paymentNumber: {
      type: String,
      default: null,
      trim: true
    },
    crmDealId: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    zohoInvoiceId: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    milestoneIndex: {
      type: Number,
      required: true,
      enum: [1, 2, 3]
    },
    amount: {
      type: Number,
      required: true
    },
    amountMinor: {
      type: Number,
      required: true
    },
    currencyCode: {
      type: String,
      default: 'AED',
      trim: true
    },
    paymentMode: {
      type: String,
      default: 'Unknown',
      trim: true
    },
    paymentDate: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['APPLIED', 'PARTIALLY_REVERSED', 'REVERSED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
      default: 'APPLIED',
      index: true
    },
    hubspotSynced: {
      type: Boolean,
      default: false
    },
    hubspotSyncedAt: {
      type: Date,
      default: null
    },
    reversals: [
      {
        reversalId: {
          type: String,
          required: true
        },
        amount: {
          type: Number,
          required: true
        },
        amountMinor: {
          type: Number,
          required: true
        },
        reversedAt: {
          type: Date,
          default: Date.now
        },
        reason: {
          type: String,
          default: null
        }
      }
    ],
    totalReversedMinor: {
      type: Number,
      default: 0
    },
    refunds: [
      {
        refundId: {
          type: String,
          required: true
        },
        amount: {
          type: Number,
          required: true
        },
        amountMinor: {
          type: Number,
          required: true
        },
        refundDate: {
          type: Date,
          default: Date.now
        },
        reason: {
          type: String,
          default: null
        }
      }
    ],
    totalRefundedMinor: {
      type: Number,
      default: 0
    },
    reversalReason: {
      type: String,
      default: null
    },
    reversedAt: {
      type: Date,
      default: null
    },
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true
    },
    deletedReason: {
      type: String,
      default: null
    },
    deletedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

PaymentRecordSchema.index({ crmDealId: 1, zohoInvoiceId: 1 });

module.exports = mongoose.model('PaymentRecord', PaymentRecordSchema);

