const https = require('https');
const { hubspotRateLimiter } = require('../utils/rateLimiter');
let IntegrationLog = null;
try {
  IntegrationLog = require('../models/IntegrationLog');
} catch (e) {
  // Ignored
}

class HubSpotClient {
  constructor() {
    this.token = process.env.HUBSPOT_ACCESS_TOKEN;
    this.hostname = 'api.hubapi.com';
  }

  async request({ method = 'GET', path, body = null, crmDealId = null }) {
    await hubspotRateLimiter.acquire(1);

    const startTime = Date.now();
    const payloadString = body ? JSON.stringify(body) : null;

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };

    if (payloadString) {
      headers['Content-Length'] = Buffer.byteLength(payloadString);
    }

    const options = {
      hostname: this.hostname,
      port: 443,
      path,
      method,
      headers
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', async () => {
          let parsedData = null;
          try {
            parsedData = JSON.parse(rawData);
          } catch (e) {
            parsedData = { raw: rawData };
          }

          const durationMs = Date.now() - startTime;
          const isSuccess = res.statusCode >= 200 && res.statusCode < 300;

          if (IntegrationLog && IntegrationLog.db?.readyState) {
            try {
              await IntegrationLog.create({
                crmDealId,
                system: 'CRM',
                direction: 'OUTBOUND',
                method,
                endpoint: path,
                statusCode: res.statusCode,
                requestBody: body,
                responseBody: parsedData,
                durationMs,
                isSuccess,
                error: isSuccess ? null : (parsedData?.message || 'HubSpot API Error')
              });
            } catch (err) {
              console.error('[AUDIT LOG ERROR]', err.message);
            }
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: parsedData
          });
        });
      });

      req.on('error', (err) => reject(err));

      if (payloadString) {
        req.write(payloadString);
      }
      req.end();
    });
  }

  async getDeal(dealId) {
    return this.request({
      method: 'GET',
      path: `/crm/v3/objects/deals/${dealId}?properties=dealname,amount,dealstage,closedate&associations=companies,contacts,line_items`,
      crmDealId: dealId
    });
  }

  async updateDeal(dealId, properties) {
    return this.request({
      method: 'PATCH',
      path: `/crm/v3/objects/deals/${dealId}`,
      body: { properties },
      crmDealId: dealId
    });
  }

  async createProperty(propertyDef) {
    return this.request({
      method: 'POST',
      path: '/crm/v3/properties/deals',
      body: propertyDef
    });
  }

  async getProperty(propertyName) {
    return this.request({
      method: 'GET',
      path: `/crm/v3/properties/deals/${propertyName}`
    });
  }
}

const hubspotClient = new HubSpotClient();

module.exports = {
  HubSpotClient,
  hubspotClient
};
