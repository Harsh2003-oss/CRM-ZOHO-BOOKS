const https = require('https');
const { zohoAuthManager } = require('./zohoAuthManager');
const { zohoRateLimiter } = require('../utils/rateLimiter');
let IntegrationLog = null;
try {
  IntegrationLog = require('../models/IntegrationLog');
} catch (e) {
  // Model may not be initialized in isolated tests
}

class ZohoClient {
  constructor() {
    this.domain = process.env.ZOHO_BOOKS_DOMAIN || 'in';
    this.orgId = process.env.ZOHO_BOOKS_ORGANIZATION_ID;
    this.hostname = this.domain === 'in' ? 'www.zohoapis.in' : `books.zoho.${this.domain}`;
  }

  async request({
    method = 'GET',
    path,
    body = null,
    crmDealId = null,
    maxRetries = 3
  }) {
    const startTime = Date.now();
    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt++;

      // 1. Acquire token from rate limiter
      await zohoRateLimiter.acquire(1);

      // 2. Get valid OAuth access token
      const accessToken = await zohoAuthManager.getValidAccessToken();

      // 3. Construct URL
      const separator = path.includes('?') ? '&' : '?';
      const fullPath = `/books/v3${path}${separator}organization_id=${this.orgId}`;

      const payloadString = body ? JSON.stringify(body) : null;

      const headers = {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      };

      if (payloadString) {
        headers['Content-Length'] = Buffer.byteLength(payloadString);
      }

      const options = {
        hostname: this.hostname,
        port: 443,
        path: fullPath,
        method,
        headers
      };

      try {
        const response = await this._sendHttpRequest(options, payloadString);
        const durationMs = Date.now() - startTime;

        // Log request & response
        await this._logAudit({
          crmDealId,
          method,
          endpoint: fullPath,
          statusCode: response.statusCode,
          requestBody: body,
          responseBody: response.data,
          durationMs,
          isSuccess: response.statusCode >= 200 && response.statusCode < 300,
          error: response.data?.message || null
        });

        // Handle Rate Limit (HTTP 429)
        if (response.statusCode === 429) {
          const retryAfterSeconds = parseInt(response.headers['retry-after'], 10) || 5;
          console.warn(`[ZOHO CLIENT] Hit rate limit (429). Waiting ${retryAfterSeconds}s...`);
          zohoRateLimiter.pause(retryAfterSeconds * 1000);

          if (attempt <= maxRetries) {
            continue;
          }
        }

        // Handle Transient Server Errors (5xx)
        if (response.statusCode >= 500 && attempt <= maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
          console.warn(`[ZOHO CLIENT] Server error (${response.statusCode}). Retrying in ${Math.round(backoffMs)}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        return response;
      } catch (networkErr) {
        const durationMs = Date.now() - startTime;
        await this._logAudit({
          crmDealId,
          method,
          endpoint: fullPath,
          statusCode: 0,
          requestBody: body,
          responseBody: null,
          durationMs,
          isSuccess: false,
          error: networkErr.message
        });

        if (attempt <= maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw networkErr;
      }
    }
  }

  _sendHttpRequest(options, payloadString) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          let parsedData = null;
          try {
            parsedData = JSON.parse(rawData);
          } catch (e) {
            parsedData = { raw: rawData };
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

  async _logAudit(logData) {
    if (!IntegrationLog || !IntegrationLog.db?.readyState) {
      return;
    }
    try {
      await IntegrationLog.create({
        ...logData,
        system: 'ZOHO_BOOKS',
        direction: 'OUTBOUND'
      });
    } catch (err) {
      // Non-blocking log failure
      console.error('[AUDIT LOG ERROR]', err.message);
    }
  }

  // Pre-flight check helper: find Sales Order by deterministic reference number
  async findSalesOrderByReference(referenceNumber) {
    const res = await this.request({
      method: 'GET',
      path: `/salesorders?reference_number=${encodeURIComponent(referenceNumber)}`
    });
    if (res.data?.salesorders?.length > 0) {
      return res.data.salesorders[0];
    }
    return null;
  }

  // Pre-flight check helper: find Invoice by deterministic reference number
  async findInvoiceByReference(referenceNumber) {
    const res = await this.request({
      method: 'GET',
      path: `/invoices?reference_number=${encodeURIComponent(referenceNumber)}`
    });
    if (res.data?.invoices?.length > 0) {
      return res.data.invoices[0];
    }
    return null;
  }
}

const zohoClient = new ZohoClient();

module.exports = {
  ZohoClient,
  zohoClient
};

