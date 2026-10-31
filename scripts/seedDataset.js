/**
 * Phase 6 Seed Dataset Script
 * 
 * Generates an idempotent, mathematically consistent synthetic dataset for demo
 * and operational evaluation:
 * - 16 Customers (covering exact match, auto-created, manually resolved, and ambiguous)
 * - 23 Deals (covering Closed Won, M1, M2, M3, partial payments, refunds, overdue aging buckets, exceptions)
 * - Milestone invoices with integer-cent accuracy
 * - Payment records, Webhook events, and Integration logs
 * 
 * SAFE TO RE-RUN: Uses upserts keyed on deterministic demo identifiers.
 * DOES NOT call Zoho Books or HubSpot APIs.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const CustomerMapping = require('../server/src/models/CustomerMapping');
const IntegrationSync = require('../server/src/models/IntegrationSync');
const MilestoneInvoice = require('../server/src/models/MilestoneInvoice');
const PaymentRecord = require('../server/src/models/PaymentRecord');
const WebhookEvent = require('../server/src/models/WebhookEvent');
const IntegrationLog = require('../server/src/models/IntegrationLog');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/crm_zoho_dev';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();

function daysAgo(days) {
  return new Date(now.getTime() - days * DAY_MS);
}

function daysAhead(days) {
  return new Date(now.getTime() + days * DAY_MS);
}

// 16 Customers
const customersData = [
  {
    hubspotCompanyId: 'demo_co_001',
    companyName: 'Falcon HyperTech FZ-LLC',
    contactName: 'Tariq Al-Mansoor',
    contactEmail: 'tariq@falconhypertech.demo',
    zohoContactId: 'zc_demo_001',
    zohoContactName: 'Falcon HyperTech FZ-LLC',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_002',
    companyName: 'Al-Amal Global Logistics',
    contactName: 'Fatima Al-Zahra',
    contactEmail: 'fatima@alamallogistics.demo',
    zohoContactId: 'zc_demo_002',
    zohoContactName: 'Al-Amal Global Logistics',
    mappingType: 'AUTO_CREATED',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_003',
    companyName: 'Gulf Horizon Properties',
    contactName: 'Rashid Bin Zayed',
    contactEmail: 'rashid@gulfhorizon.demo',
    zohoContactId: 'zc_demo_003',
    zohoContactName: 'Gulf Horizon Properties',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_004',
    companyName: 'Emirates AI Labs',
    contactName: 'Dr. Noura Al-Kaabi',
    contactEmail: 'noura@emiratesailabs.demo',
    zohoContactId: 'zc_demo_004',
    zohoContactName: 'Emirates AI Labs',
    mappingType: 'AUTO_CREATED',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_005',
    companyName: 'Palm FinTech Solutions',
    contactName: 'Kareem Mostafa',
    contactEmail: 'kareem@palmfintech.demo',
    zohoContactId: 'zc_demo_005',
    zohoContactName: 'Palm FinTech Solutions',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_006',
    companyName: 'Burj Retail Ventures',
    contactName: 'Sultan Al-Ghurair',
    contactEmail: 'sultan@burjretail.demo',
    zohoContactId: 'zc_demo_006',
    zohoContactName: 'Burj Retail Ventures',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_007',
    companyName: 'Oasis Cloud Systems',
    contactName: 'Laila Al-Hashimi',
    contactEmail: 'laila@oasiscloud.demo',
    zohoContactId: 'zc_demo_007',
    zohoContactName: 'Oasis Cloud Systems',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_008',
    companyName: 'Dubai Digital Media',
    contactName: 'Omar Farooq',
    contactEmail: 'omar@dubaidigital.demo',
    zohoContactId: 'zc_demo_008',
    zohoContactName: 'Dubai Digital Media',
    mappingType: 'AUTO_CREATED',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_009',
    companyName: 'Marina Maritime Cargo',
    contactName: 'Capt. Zaid Al-Balooshi',
    contactEmail: 'zaid@marinacargo.demo',
    zohoContactId: 'zc_demo_009',
    zohoContactName: 'Marina Maritime Cargo',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_010',
    companyName: 'Jumeirah Health Group',
    contactName: 'Dr. Mariam Al-Suwaidi',
    contactEmail: 'mariam@jumeirahhealth.demo',
    zohoContactId: 'zc_demo_010',
    zohoContactName: 'Jumeirah Health Group',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_011',
    companyName: 'Zabeel Industrial Supplies',
    contactName: 'Hamdan Al-Nuaimi',
    contactEmail: 'hamdan@zabeelindustrial.demo',
    zohoContactId: 'zc_demo_011',
    zohoContactName: 'Zabeel Industrial Supplies',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_012',
    companyName: 'Arabian Green Energy',
    contactName: 'Yousef Al-Otaiba',
    contactEmail: 'yousef@arabiangreen.demo',
    zohoContactId: 'zc_demo_012',
    zohoContactName: 'Arabian Green Energy',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_013',
    companyName: 'Pearl Cyber Security',
    contactName: 'Amina Al-Falasi',
    contactEmail: 'amina@pearlcyber.demo',
    zohoContactId: 'zc_demo_013',
    zohoContactName: 'Pearl Cyber Security',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_014',
    companyName: 'Desert Dune Consulting',
    contactName: 'Mansoor Al-Haddad',
    contactEmail: 'mansoor@desertdune.demo',
    zohoContactId: 'zc_demo_014',
    zohoContactName: 'Desert Dune Consulting',
    mappingType: 'AUTO_CREATED',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_015',
    companyName: 'Etihad Aviation Logistics',
    contactName: 'Khalid Al-Marzooqi',
    contactEmail: 'khalid@etihadlogistics.demo',
    zohoContactId: 'zc_demo_015',
    zohoContactName: 'Etihad Aviation Logistics',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'ACTIVE'
  },
  {
    hubspotCompanyId: 'demo_co_016',
    companyName: 'Sharjah Maritime Services',
    contactName: 'Ali Al-Qasimi',
    contactEmail: 'ali@sharjahmaritime.demo',
    zohoContactId: null,
    zohoContactName: '',
    mappingType: 'AUTOMATIC_EXACT',
    status: 'AMBIGUOUS',
    reason: 'Multiple Zoho contacts matched company name "Sharjah Maritime Services" (2 found)',
    candidateMatches: [
      {
        contactId: 'zc_cand_016a',
        contactName: 'Sharjah Maritime Services L.L.C.',
        companyName: 'Sharjah Maritime Services L.L.C.',
        email: 'billing@sms-uae.demo',
        phone: '+971-6-528-1100'
      },
      {
        contactId: 'zc_cand_016b',
        contactName: 'Sharjah Maritime Group FZE',
        companyName: 'Sharjah Maritime Group FZE',
        email: 'accounts@sharjahmaritime.demo',
        phone: '+971-6-528-9944'
      }
    ]
  }
];

// Helper to calculate exact milestone amounts
function calcMilestones(subtotal, taxRate = 0.05) {
  const m1Sub = Math.round(subtotal * 0.50);
  const m2Sub = Math.round(subtotal * 0.30);
  const m3Sub = subtotal - m1Sub - m2Sub;

  const m1Tax = Math.round(m1Sub * taxRate);
  const m2Tax = Math.round(m2Sub * taxRate);
  const m3Tax = Math.round(m3Sub * taxRate);

  return [
    { index: 1, name: 'Signing', pct: 50, subtotal: m1Sub, tax: m1Tax, total: m1Sub + m1Tax },
    { index: 2, name: 'Go-Live', pct: 30, subtotal: m2Sub, tax: m2Tax, total: m2Sub + m2Tax },
    { index: 3, name: '90 Days Post Go-Live', pct: 20, subtotal: m3Sub, tax: m3Tax, total: m3Sub + m3Tax }
  ];
}

async function seed(options = {}) {
  // Safety Guard: Block in production unless explicitly authorized
  const isProd = process.env.NODE_ENV === 'production';
  const allowProdSeed = process.env.ALLOW_PRODUCTION_SEED === 'true' || options.allowProd === true;

  if (isProd && !allowProdSeed) {
    const errorMsg = '[SAFETY GUARD] Seeding is blocked in production environment (NODE_ENV=production). ' +
      'To seed demo data into a separate staging/demo database, configure MONGODB_URI to that database, ' +
      'or set ALLOW_PRODUCTION_SEED=true to override.';
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  console.log(`[SEED] Connecting to MongoDB: ${MONGODB_URI}`);
  await mongoose.connect(MONGODB_URI);
  console.log('[SEED] Connected successfully.');

  // 1. Upsert Customers
  console.log(`[SEED] Upserting ${customersData.length} customer mappings...`);
  const customerMap = {};
  for (const c of customersData) {
    const doc = await CustomerMapping.findOneAndUpdate(
      { hubspotCompanyId: c.hubspotCompanyId },
      { $set: c },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    customerMap[c.companyName] = doc;
  }
  console.log(`[SEED] Customer mappings upserted.`);

  // 2. Define 23 Deals
  const dealsDefinition = [
    // Deal 1: Primary assignment contract (AED 120,000 subtotal, 5% VAT = 126,000 gross)
    // M1 paid, M2 invoiced & current
    {
      crmDealId: 'crm_demo_deal_001',
      dealName: 'Falcon HyperTech Enterprise Implementation',
      customerName: 'Falcon HyperTech FZ-LLC',
      customerEmail: 'tariq@falconhypertech.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'M2_INVOICED',
      confirmedGoLiveDate: daysAgo(10),
      goLiveVerifiedAt: daysAgo(10),
      m3EligibleAt: daysAhead(80),
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(30), paidAt: daysAgo(25), paidAmount: 63000 },
        { index: 2, status: 'SENT', dueDate: daysAhead(20), paidAt: null, paidAmount: 0 }
      ]
    },
    // Deal 2: Fully invoiced & fully paid
    {
      crmDealId: 'crm_demo_deal_002',
      dealName: 'Al-Amal Global Supply Chain ERP',
      customerName: 'Al-Amal Global Logistics',
      customerEmail: 'fatima@alamallogistics.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'SYNCED',
      confirmedGoLiveDate: daysAgo(120),
      goLiveVerifiedAt: daysAgo(120),
      m3EligibleAt: daysAgo(30),
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(140), paidAt: daysAgo(135), paidAmount: 63000 },
        { index: 2, status: 'PAID', dueDate: daysAgo(110), paidAt: daysAgo(105), paidAmount: 37800 },
        { index: 3, status: 'PAID', dueDate: daysAgo(20), paidAt: daysAgo(15), paidAmount: 25200 }
      ]
    },
    // Deal 3: Fully invoiced with partial payment on M3
    {
      crmDealId: 'crm_demo_deal_003',
      dealName: 'Gulf Horizon Multi-Tenant Portal',
      customerName: 'Gulf Horizon Properties',
      customerEmail: 'rashid@gulfhorizon.demo',
      subtotal: 80000,
      soTotal: 84000,
      syncStatus: 'SYNCED',
      confirmedGoLiveDate: daysAgo(100),
      goLiveVerifiedAt: daysAgo(100),
      m3EligibleAt: daysAgo(10),
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(120), paidAt: daysAgo(115), paidAmount: 42000 },
        { index: 2, status: 'PAID', dueDate: daysAgo(90), paidAt: daysAgo(85), paidAmount: 25200 },
        { index: 3, status: 'PARTIALLY_PAID', dueDate: daysAhead(15), paidAt: daysAgo(5), paidAmount: 8400 } // balance: 8400
      ]
    },
    // Deal 4: M1 invoiced, partial payment on M1
    {
      crmDealId: 'crm_demo_deal_004',
      dealName: 'Emirates AI Model Serving Infrastructure',
      customerName: 'Emirates AI Labs',
      customerEmail: 'noura@emiratesailabs.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'PARTIALLY_PAID', dueDate: daysAhead(10), paidAt: daysAgo(3), paidAmount: 31500 } // balance: 31500
      ]
    },
    // Deal 5: M1 overdue (31-60 days aging bucket)
    {
      crmDealId: 'crm_demo_deal_005',
      dealName: 'Palm FinTech High-Frequency Settlement',
      customerName: 'Palm FinTech Solutions',
      customerEmail: 'kareem@palmfintech.demo',
      subtotal: 150000,
      soTotal: 157500,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'SENT', dueDate: daysAgo(45), paidAt: null, paidAmount: 0 }
      ]
    },
    // Deal 6: M1 paid, M2 overdue (1-30 days aging bucket)
    {
      crmDealId: 'crm_demo_deal_006',
      dealName: 'Burj Retail Smart POS Network',
      customerName: 'Burj Retail Ventures',
      customerEmail: 'sultan@burjretail.demo',
      subtotal: 60000,
      soTotal: 63000,
      syncStatus: 'M2_INVOICED',
      confirmedGoLiveDate: daysAgo(45),
      goLiveVerifiedAt: daysAgo(45),
      m3EligibleAt: daysAhead(45),
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(60), paidAt: daysAgo(55), paidAmount: 31500 },
        { index: 2, status: 'SENT', dueDate: daysAgo(15), paidAt: null, paidAmount: 0 }
      ]
    },
    // Deal 7: Fully invoiced, M3 overdue (90+ days aging bucket)
    {
      crmDealId: 'crm_demo_deal_007',
      dealName: 'Oasis Cloud Enterprise Migration',
      customerName: 'Oasis Cloud Systems',
      customerEmail: 'laila@oasiscloud.demo',
      subtotal: 200000,
      soTotal: 210000,
      syncStatus: 'SYNCED',
      confirmedGoLiveDate: daysAgo(200),
      goLiveVerifiedAt: daysAgo(200),
      m3EligibleAt: daysAgo(110),
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(220), paidAt: daysAgo(215), paidAmount: 105000 },
        { index: 2, status: 'PAID', dueDate: daysAgo(190), paidAt: daysAgo(185), paidAmount: 63000 },
        { index: 3, status: 'SENT', dueDate: daysAgo(95), paidAt: null, paidAmount: 0 } // Overdue 95 days
      ]
    },
    // Deal 8: M1 paid, voided & re-issued scenario
    {
      crmDealId: 'crm_demo_deal_008',
      dealName: 'Dubai Digital Video Streaming Engine',
      customerName: 'Dubai Digital Media',
      customerEmail: 'omar@dubaidigital.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(10), paidAt: daysAgo(5), paidAmount: 63000 }
      ]
    },
    // Deal 9: Fresh Closed Won deal, M1 unpaid (current)
    {
      crmDealId: 'crm_demo_deal_009',
      dealName: 'Marina Maritime Real-Time Tracking',
      customerName: 'Marina Maritime Cargo',
      customerEmail: 'zaid@marinacargo.demo',
      subtotal: 90000,
      soTotal: 94500,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'SENT', dueDate: daysAhead(20), paidAt: null, paidAmount: 0 }
      ]
    },
    // Deal 10: Milestone 1 paid, awaiting Go-Live
    {
      crmDealId: 'crm_demo_deal_010',
      dealName: 'Jumeirah Health Clinical Telemetry',
      customerName: 'Jumeirah Health Group',
      customerEmail: 'mariam@jumeirahhealth.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(20), paidAt: daysAgo(18), paidAmount: 63000 }
      ]
    },
    // Deal 11: M1 paid, M2 overdue (61-90 days aging bucket)
    {
      crmDealId: 'crm_demo_deal_011',
      dealName: 'Zabeel Industrial Automated Robotics',
      customerName: 'Zabeel Industrial Supplies',
      customerEmail: 'hamdan@zabeelindustrial.demo',
      subtotal: 110000,
      soTotal: 115500,
      syncStatus: 'M2_INVOICED',
      confirmedGoLiveDate: daysAgo(80),
      goLiveVerifiedAt: daysAgo(80),
      m3EligibleAt: daysAhead(10),
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(95), paidAt: daysAgo(90), paidAmount: 57750 },
        { index: 2, status: 'SENT', dueDate: daysAgo(65), paidAt: null, paidAmount: 0 } // Overdue 65 days
      ]
    },
    // Deal 12: Arabian Green Energy - Solar Phase 1 (Paid)
    {
      crmDealId: 'crm_demo_deal_012',
      dealName: 'Arabian Green Energy Solar Phase 1',
      customerName: 'Arabian Green Energy',
      customerEmail: 'yousef@arabiangreen.demo',
      subtotal: 75000,
      soTotal: 78750,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(15), paidAt: daysAgo(12), paidAmount: 39375 }
      ]
    },
    // Deal 13: Arabian Green Energy - Grid Sync Phase 2 (Unpaid, multi-deal customer)
    {
      crmDealId: 'crm_demo_deal_013',
      dealName: 'Arabian Green Energy Grid Sync Phase 2',
      customerName: 'Arabian Green Energy',
      customerEmail: 'yousef@arabiangreen.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'SENT', dueDate: daysAhead(25), paidAt: null, paidAmount: 0 }
      ]
    },
    // Deal 14: Fully paid clean deal
    {
      crmDealId: 'crm_demo_deal_014',
      dealName: 'Pearl Cyber Incident Response Suite',
      customerName: 'Pearl Cyber Security',
      customerEmail: 'amina@pearlcyber.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'SYNCED',
      confirmedGoLiveDate: daysAgo(110),
      goLiveVerifiedAt: daysAgo(110),
      m3EligibleAt: daysAgo(20),
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(130), paidAt: daysAgo(125), paidAmount: 63000 },
        { index: 2, status: 'PAID', dueDate: daysAgo(100), paidAt: daysAgo(95), paidAmount: 37800 },
        { index: 3, status: 'PAID', dueDate: daysAgo(10), paidAt: daysAgo(5), paidAmount: 25200 }
      ]
    },
    // Deal 15: Single milestone current
    {
      crmDealId: 'crm_demo_deal_015',
      dealName: 'Desert Dune ESG Reporting Suite',
      customerName: 'Desert Dune Consulting',
      customerEmail: 'mansoor@desertdune.demo',
      subtotal: 50000,
      soTotal: 52500,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'SENT', dueDate: daysAhead(18), paidAt: null, paidAmount: 0 }
      ]
    },
    // Deal 16: Large enterprise deal (AED 240,000), M2 partial payment
    {
      crmDealId: 'crm_demo_deal_016',
      dealName: 'Etihad Aviation Engine Maintenance ERP',
      customerName: 'Etihad Aviation Logistics',
      customerEmail: 'khalid@etihadlogistics.demo',
      subtotal: 240000,
      soTotal: 252000,
      syncStatus: 'M2_INVOICED',
      confirmedGoLiveDate: daysAgo(30),
      goLiveVerifiedAt: daysAgo(30),
      m3EligibleAt: daysAhead(60),
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(45), paidAt: daysAgo(40), paidAmount: 126000 },
        { index: 2, status: 'PARTIALLY_PAID', dueDate: daysAhead(15), paidAt: daysAgo(5), paidAmount: 37800 } // Total: 75,600, bal: 37,800
      ]
    },
    // Deal 17: M3 eligible after 90 days
    {
      crmDealId: 'crm_demo_deal_017',
      dealName: 'Skyline Telecom Fiber Core Billing',
      customerName: 'Falcon HyperTech FZ-LLC', // Reusing customer 1
      customerEmail: 'tariq@falconhypertech.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'M2_INVOICED',
      confirmedGoLiveDate: daysAgo(95),
      goLiveVerifiedAt: daysAgo(95),
      m3EligibleAt: daysAgo(5), // M3 eligible now!
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(110), paidAt: daysAgo(105), paidAmount: 63000 },
        { index: 2, status: 'PAID', dueDate: daysAgo(85), paidAt: daysAgo(80), paidAmount: 37800 }
      ]
    },
    // Deal 18: Overdue invoice (1-30 days bucket)
    {
      crmDealId: 'crm_demo_deal_018',
      dealName: 'Red Sands Regional Warehouse OMS',
      customerName: 'Burj Retail Ventures',
      customerEmail: 'sultan@burjretail.demo',
      subtotal: 100000,
      soTotal: 105000,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'SENT', dueDate: daysAgo(5), paidAt: null, paidAmount: 0 } // Overdue 5 days
      ]
    },
    // Deal 19: Customer mapping ambiguity resolved
    {
      crmDealId: 'crm_demo_deal_019',
      dealName: 'Khorfakkan Heavy Haulage Telematics',
      customerName: 'Al-Amal Global Logistics',
      customerEmail: 'fatima@alamallogistics.demo',
      subtotal: 160000,
      soTotal: 168000,
      syncStatus: 'M1_INVOICED',
      invoices: [
        { index: 1, status: 'PAID', dueDate: daysAgo(10), paidAt: daysAgo(5), paidAmount: 84000 }
      ]
    },
    // Deal 20: Closed Won with no invoice yet (Confirmed Sales Order)
    {
      crmDealId: 'crm_demo_deal_020',
      dealName: 'Fujairah Offshore Tank Farm Sensor Mesh',
      customerName: 'Marina Maritime Cargo',
      customerEmail: 'zaid@marinacargo.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'SALES_ORDER_CONFIRMED',
      invoices: []
    },
    // Deal 21: Exception - Customer Ambiguity (Sharjah Maritime)
    {
      crmDealId: 'crm_demo_deal_021',
      dealName: 'Sharjah Port Drydock Scheduling System',
      customerName: 'Sharjah Maritime Services',
      customerEmail: 'ali@sharjahmaritime.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'REQUIRES_MANUAL_MATCH',
      failureReason: 'Customer mapping is ambiguous: Multiple Zoho contacts matched company name "Sharjah Maritime Services"',
      invoices: []
    },
    // Deal 22: Exception - Network drop reconciliation required
    {
      crmDealId: 'crm_demo_deal_022',
      dealName: 'Ajman Smart Grid Substation Automation',
      customerName: 'Emirates AI Labs',
      customerEmail: 'noura@emiratesailabs.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'RECONCILIATION_REQUIRED',
      reconciliationMilestoneIndex: 1,
      reconciliationReason: 'POST /invoices returned 504 Gateway Timeout. Re-querying Zoho by reference CRM_crm_demo_deal_022_M1 required before safe retry.',
      reconciliationRequestedAt: daysAgo(1),
      invoices: []
    },
    // Deal 23: Exception - HubSpot rate limit failed sync
    {
      crmDealId: 'crm_demo_deal_023',
      dealName: 'Ras Al Khaimah Quarry IoT Monitoring',
      customerName: 'Zabeel Industrial Supplies',
      customerEmail: 'hamdan@zabeelindustrial.demo',
      subtotal: 120000,
      soTotal: 126000,
      syncStatus: 'HUBSPOT_SYNC_FAILED',
      failureReason: 'HubSpot API returned 429 Too Many Requests (Rate limit 100/10s exhausted)',
      invoices: [
        { index: 1, status: 'SENT', dueDate: daysAhead(15), paidAt: null, paidAmount: 0 }
      ]
    }
  ];

  console.log(`[SEED] Seeding ${dealsDefinition.length} deals and their financial records...`);

  for (const def of dealsDefinition) {
    const customer = customerMap[def.customerName];
    const zohoContactId = customer ? customer.zohoContactId : null;
    const milestoneCalculations = calcMilestones(def.subtotal);

    // Compute aggregate metrics
    let totalInvoicedAmount = 0;
    let amountCollected = 0;
    let amountInvoicedUnpaid = 0;
    let nextDueDate = null;
    let isOverdue = false;

    // First upsert IntegrationSync
    const syncDoc = await IntegrationSync.findOneAndUpdate(
      { crmDealId: def.crmDealId },
      {
        $set: {
          dealName: def.dealName,
          customerName: def.customerName,
          customerEmail: def.customerEmail,
          zohoContactId: zohoContactId,
          zohoSalesOrderId: `so_${def.crmDealId}`,
          zohoSalesOrderLineItemId: `item_${def.crmDealId}_1`,
          zohoSalesOrderNumber: `SO-${def.crmDealId.replace('crm_demo_deal_', '100')}`,
          salesOrderTotal: def.soTotal,
          salesOrderSubtotal: def.subtotal,
          salesOrderTax: def.soTotal - def.subtotal,
          salesOrderStatus: def.syncStatus === 'REQUIRES_MANUAL_MATCH' ? 'NONE' : 'CONFIRMED',
          currencyCode: 'AED',
          confirmedGoLiveDate: def.confirmedGoLiveDate || null,
          goLiveVerifiedAt: def.goLiveVerifiedAt || null,
          m3EligibleAt: def.m3EligibleAt || null,
          syncStatus: def.syncStatus,
          reconciliationMilestoneIndex: def.reconciliationMilestoneIndex || null,
          reconciliationReason: def.reconciliationReason || null,
          reconciliationRequestedAt: def.reconciliationRequestedAt || null,
          failureReason: def.failureReason || null
        }
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    // Seed MilestoneInvoices for this deal
    for (const invDef of def.invoices) {
      const mCalc = milestoneCalculations.find(m => m.index === invDef.index);
      const balance = mCalc.total - invDef.paidAmount;
      const invDueDate = invDef.dueDate;

      totalInvoicedAmount += mCalc.total;
      amountCollected += invDef.paidAmount;
      amountInvoicedUnpaid += balance;

      if (balance > 0) {
        if (!nextDueDate || invDueDate < nextDueDate) {
          nextDueDate = invDueDate;
        }
        if (invDueDate < now) {
          isOverdue = true;
        }
      }

      const invDoc = await MilestoneInvoice.findOneAndUpdate(
        { crmDealId: def.crmDealId, milestoneIndex: invDef.index },
        {
          $set: {
            syncId: syncDoc._id,
            milestoneName: mCalc.name,
            percentage: mCalc.pct,
            subtotal: mCalc.subtotal,
            taxAmount: mCalc.tax,
            totalAmount: mCalc.total,
            balance: balance,
            zohoInvoiceId: `inv_${def.crmDealId}_M${invDef.index}`,
            zohoInvoiceNumber: `INV-${def.crmDealId.replace('crm_demo_deal_', '200')}-M${invDef.index}`,
            zohoSalesOrderId: `so_${def.crmDealId}`,
            zohoSalesOrderItemId: `item_${def.crmDealId}_1`,
            currencyCode: 'AED',
            referenceNumber: `CRM_${def.crmDealId}_M${invDef.index}`,
            status: invDef.status,
            dueDate: invDueDate,
            paidAt: invDef.paidAt
          }
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      );

      // If a payment was made, upsert PaymentRecord
      if (invDef.paidAmount > 0) {
        const paymentId = `pay_${def.crmDealId}_M${invDef.index}`;
        await PaymentRecord.findOneAndUpdate(
          { paymentId: paymentId },
          {
            $set: {
              paymentNumber: `RCPT-${def.crmDealId.replace('crm_demo_deal_', '300')}-M${invDef.index}`,
              crmDealId: def.crmDealId,
              zohoInvoiceId: invDoc.zohoInvoiceId,
              milestoneIndex: invDef.index,
              amount: invDef.paidAmount,
              amountMinor: Math.round(invDef.paidAmount * 100),
              currencyCode: 'AED',
              paymentMode: 'Bank Transfer',
              paymentDate: invDef.paidAt || now,
              status: 'APPLIED',
              hubspotSynced: true,
              hubspotSyncedAt: invDef.paidAt || now,
              rawPayload: { simulated: true }
            }
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
      }
    }

    const amountNotInvoiced = Math.max(0, def.soTotal - totalInvoicedAmount);
    const percentageInvoiced = def.soTotal > 0 ? Number(((totalInvoicedAmount / def.soTotal) * 100).toFixed(2)) : 0;
    const percentageCollected = def.soTotal > 0 ? Number(((amountCollected / def.soTotal) * 100).toFixed(2)) : 0;

    // Update IntegrationSync with verified metrics
    await IntegrationSync.updateOne(
      { _id: syncDoc._id },
      {
        $set: {
          totalInvoicedAmount,
          amountCollected,
          amountInvoicedUnpaid,
          amountNotInvoiced,
          percentageInvoiced,
          percentageCollected,
          nextDueDate,
          isOverdue,
          lastSyncedAt: now,
          lastSyncedValues: {
            zoho_sales_order_total: def.soTotal,
            zoho_total_invoiced: totalInvoicedAmount,
            zoho_total_collected: amountCollected,
            zoho_invoiced_unpaid: amountInvoicedUnpaid,
            zoho_not_invoiced: amountNotInvoiced,
            zoho_percentage_invoiced: percentageInvoiced,
            zoho_percentage_collected: percentageCollected,
            zoho_next_due_date: nextDueDate ? nextDueDate.toISOString().split('T')[0] : null,
            zoho_is_overdue: String(Boolean(isOverdue))
          }
        }
      }
    );
  }
  console.log(`[SEED] Deals and invoices seeded successfully.`);

  // 3. Upsert Sample Webhook Events
  console.log('[SEED] Upserting webhook queue demo events...');
  const webhookEvents = [
    {
      eventId: 'evt_demo_queued_001',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'RECEIVED',
      payload: {
        objectId: 'crm_demo_deal_020',
        propertyName: 'dealstage',
        propertyValue: 'closedwon',
        changeSource: 'CRM_UI'
      }
    },
    {
      eventId: 'evt_demo_processed_002',
      source: 'CRM',
      eventType: 'deal.propertyChange',
      status: 'PROCESSED',
      processedAt: daysAgo(2),
      payload: {
        objectId: 'crm_demo_deal_001',
        propertyName: 'dealstage',
        propertyValue: 'closedwon'
      }
    },
    {
      eventId: 'evt_demo_failed_003',
      source: 'ZOHO_BOOKS',
      eventType: 'customer_payment.created',
      status: 'FAILED',
      error: 'HubSpot API rate limit exhausted during downstream financial property sync',
      payload: {
        payment_id: 'pay_demo_failed_99',
        customer_id: 'zc_demo_011',
        amount: 34650
      }
    }
  ];

  for (const ev of webhookEvents) {
    await WebhookEvent.findOneAndUpdate(
      { eventId: ev.eventId },
      { $set: ev },
      { upsert: true }
    );
  }

  // 4. Upsert Sample Integration Logs (Sanitized)
  console.log('[SEED] Upserting integration audit logs...');
  const auditLogs = [
    {
      crmDealId: 'crm_demo_deal_001',
      system: 'ZOHO_BOOKS',
      direction: 'OUTBOUND',
      method: 'POST',
      endpoint: '/books/v3/invoices',
      statusCode: 201,
      durationMs: 420,
      isSuccess: true,
      requestBody: { reference_number: 'CRM_crm_demo_deal_001_M2', customer_id: 'zc_demo_001', total: 37800 },
      responseBody: { code: 0, message: 'The invoice has been created.', invoice: { invoice_id: 'inv_demo_001_M2' } }
    },
    {
      crmDealId: 'crm_demo_deal_001',
      system: 'CRM',
      direction: 'OUTBOUND',
      method: 'PATCH',
      endpoint: '/crm/v3/objects/deals/crm_demo_deal_001',
      statusCode: 200,
      durationMs: 180,
      isSuccess: true,
      requestBody: { properties: { zoho_total_invoiced: '100800', zoho_percentage_invoiced: '80.00' } },
      responseBody: { id: 'crm_demo_deal_001', updatedAt: now.toISOString() }
    },
    {
      crmDealId: 'crm_demo_deal_022',
      system: 'ZOHO_BOOKS',
      direction: 'OUTBOUND',
      method: 'POST',
      endpoint: '/books/v3/invoices',
      statusCode: 504,
      durationMs: 10000,
      isSuccess: false,
      error: 'Gateway Timeout after 10000ms. Transitioned to RECONCILIATION_REQUIRED.',
      requestBody: { reference_number: 'CRM_crm_demo_deal_022_M1' },
      responseBody: null
    }
  ];

  for (const log of auditLogs) {
    const exists = await IntegrationLog.findOne({
      crmDealId: log.crmDealId,
      endpoint: log.endpoint,
      method: log.method,
      statusCode: log.statusCode
    });
    if (!exists) {
      await IntegrationLog.create(log);
    }
  }

  const customerCount = await CustomerMapping.countDocuments();
  const dealCount = await IntegrationSync.countDocuments();
  const invoiceCount = await MilestoneInvoice.countDocuments();
  const paymentCount = await PaymentRecord.countDocuments();

  console.log('\n==========================================');
  console.log(' SEED DATASET GENERATION COMPLETE');
  console.log('==========================================');
  console.log(` Customers in DB:  ${customerCount} (Requirement: >= 15)`);
  console.log(` Deals in DB:      ${dealCount} (Requirement: >= 20)`);
  console.log(` Invoices in DB:   ${invoiceCount}`);
  console.log(` Payments in DB:   ${paymentCount}`);
  console.log('==========================================\n');

  await mongoose.disconnect();
  console.log('[SEED] Disconnected from MongoDB.');
}

if (require.main === module) {
  seed().catch(err => {
    console.error('[SEED ERROR]', err);
    process.exit(1);
  });
}

module.exports = seed;
