const mongoose = require('mongoose');

const CustomerMappingSchema = new mongoose.Schema(
  {
    hubspotCompanyId: {
      type: String,
      default: null,
      trim: true
    },
    hubspotContactId: {
      type: String,
      default: null,
      trim: true
    },
    companyName: {
      type: String,
      default: '',
      trim: true
    },
    contactName: {
      type: String,
      default: '',
      trim: true
    },
    contactEmail: {
      type: String,
      default: null,
      trim: true,
      lowercase: true
    },
    zohoContactId: {
      type: String,
      default: null,
      index: true
    },
    zohoContactName: {
      type: String,
      default: ''
    },
    mappingType: {
      type: String,
      enum: ['AUTOMATIC_EXACT', 'AUTO_CREATED', 'MANUALLY_RESOLVED'],
      default: 'AUTOMATIC_EXACT'
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'AMBIGUOUS', 'DELETED'],
      default: 'ACTIVE',
      index: true
    },
    deletedReason: {
      type: String,
      default: null
    },
    deletedAt: {
      type: Date,
      default: null
    },
    candidateMatches: [
      {
        contactId: String,
        contactName: String,
        companyName: String,
        email: String,
        phone: String
      }
    ],
    reason: {
      type: String,
      default: null
    },
    resolvedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Partial unique index for hubspotCompanyId (only when non-null string)
CustomerMappingSchema.index(
  { hubspotCompanyId: 1 },
  { unique: true, partialFilterExpression: { hubspotCompanyId: { $type: 'string' } } }
);

// Partial unique index for hubspotContactId (only when non-null string)
CustomerMappingSchema.index(
  { hubspotContactId: 1 },
  { unique: true, partialFilterExpression: { hubspotContactId: { $type: 'string' } } }
);

module.exports = mongoose.model('CustomerMapping', CustomerMappingSchema);

