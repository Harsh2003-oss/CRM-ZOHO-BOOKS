const mongoose = require('mongoose');

const ProductMappingSchema = new mongoose.Schema(
  {
    hubspotProductId: {
      type: String,
      default: null,
      trim: true
    },
    productName: {
      type: String,
      default: '',
      trim: true
    },
    sku: {
      type: String,
      default: null,
      trim: true
    },
    zohoItemId: {
      type: String,
      default: null,
      trim: true
    },
    zohoItemName: {
      type: String,
      default: ''
    },
    zohoItemSku: {
      type: String,
      default: ''
    },
    rate: {
      type: Number,
      default: 0
    },
    mappingType: {
      type: String,
      enum: ['AUTOMATIC_EXACT', 'CONFIGURED_DEFAULT', 'MANUALLY_MAPPED'],
      default: 'AUTOMATIC_EXACT'
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'AMBIGUOUS', 'UNMAPPED'],
      default: 'ACTIVE',
      index: true
    },
    candidateMatches: [
      {
        itemId: String,
        itemName: String,
        sku: String,
        rate: Number
      }
    ],
    reason: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true
  }
);

ProductMappingSchema.index({ hubspotProductId: 1 }, { sparse: true });
ProductMappingSchema.index({ productName: 1 }, { sparse: true });
ProductMappingSchema.index({ zohoItemId: 1 }, { sparse: true });

module.exports = mongoose.model('ProductMapping', ProductMappingSchema);

