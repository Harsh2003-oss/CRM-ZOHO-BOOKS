require('dotenv').config();
const { hubspotClient } = require('../server/src/clients/hubspotClient');

const requiredProperties = [
  {
    name: 'zoho_customer_id',
    label: 'Zoho Customer ID',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_sales_order_id',
    label: 'Zoho Sales Order ID',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_sales_order_number',
    label: 'Zoho Sales Order Number',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_sales_order_url',
    label: 'Zoho Sales Order URL',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_sales_order_total',
    label: 'Zoho Sales Order Total',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_currency_code',
    label: 'Zoho Currency Code',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_total_invoiced_amount',
    label: 'Zoho Total Invoiced Amount',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_percentage_invoiced',
    label: 'Zoho Percentage Invoiced',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_total_collected_amount',
    label: 'Zoho Total Collected Amount',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_percentage_collected',
    label: 'Zoho Percentage Collected',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_amount_invoiced_unpaid',
    label: 'Zoho Amount Invoiced Unpaid',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_amount_not_invoiced',
    label: 'Zoho Amount Not Invoiced',
    type: 'number',
    fieldType: 'number',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_next_due_date',
    label: 'Zoho Next Due Date',
    type: 'date',
    fieldType: 'date',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_is_overdue',
    label: 'Zoho Is Overdue',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'zoho_payment_status',
    label: 'Zoho Payment Status',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'integration_sync_status',
    label: 'Integration Sync Status',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'integration_last_error',
    label: 'Integration Last Error',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'integration_milestone_stage',
    label: 'Integration Milestone Stage',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'integration_last_synced_at',
    label: 'Integration Last Synced At',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation'
  },
  {
    name: 'confirmed_go_live_date',
    label: 'Confirmed Go-Live Date',
    type: 'date',
    fieldType: 'date',
    groupName: 'dealinformation'
  },
  {
    name: 'm3_eligible_date',
    label: 'M3 Eligible Date',
    type: 'date',
    fieldType: 'date',
    groupName: 'dealinformation'
  }
];

async function setupProperties() {
  console.log('\n--- Provisioning Custom HubSpot Deal Properties ---');
  let createdCount = 0;
  let existingCount = 0;

  for (const prop of requiredProperties) {
    try {
      const checkRes = await hubspotClient.getProperty(prop.name);
      if (checkRes.statusCode === 200) {
        console.log(`[EXISTS] Property '${prop.name}' is already present.`);
        existingCount++;
        continue;
      }

      if (checkRes.statusCode === 404) {
        const createRes = await hubspotClient.createProperty(prop);
        if (createRes.statusCode === 201) {
          console.log(`[CREATED] Property '${prop.name}' created successfully.`);
          createdCount++;
        } else {
          console.error(`[ERROR] Failed to create '${prop.name}':`, createRes.data?.message);
        }
      } else {
        console.warn(`[WARN] Unexpected status (${checkRes.statusCode}) checking '${prop.name}'`);
      }
    } catch (err) {
      console.error(`[EXCEPTION] Error processing '${prop.name}':`, err.message);
    }
  }

  console.log('--------------------------------------------------');
  console.log(`Summary: ${createdCount} created, ${existingCount} already existed (Total: ${requiredProperties.length})\n`);
  return { createdCount, existingCount, total: requiredProperties.length };
}

if (require.main === module) {
  setupProperties()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error setting up properties:', err.message);
      process.exit(1);
    });
}

module.exports = { setupProperties, requiredProperties };

