const https = require('https');

class ZohoAuthManager {
  constructor() {
    this.accessToken = null;
    this.expiresAt = 0;
    this.refreshPromise = null;
  }

  async getValidAccessToken() {
    const now = Date.now();
    // Proactively refresh if token expires within 5 minutes (300,000ms)
    const fiveMinutesMs = 5 * 60 * 1000;

    if (this.accessToken && now < (this.expiresAt - fiveMinutesMs)) {
      return this.accessToken;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshToken()
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  async refreshToken() {
    const domain = process.env.ZOHO_BOOKS_DOMAIN || 'in';
    const clientId = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    const refreshToken = process.env.ZOHO_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Missing Zoho OAuth credentials in environment');
    }

    const postData = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    }).toString();

    const options = {
      hostname: `accounts.zoho.${domain}`,
      port: 443,
      path: `/oauth/v2/token?${postData}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const body = JSON.parse(data);
            if (body.error) {
              return reject(new Error(`Zoho OAuth refresh failed: ${body.error}`));
            }

            if (!body.access_token) {
              return reject(new Error(`Zoho OAuth response missing access_token`));
            }

            this.accessToken = body.access_token;
            // expires_in is in seconds (typically 3600s = 1 hour)
            const expiresInSeconds = body.expires_in || 3600;
            this.expiresAt = Date.now() + expiresInSeconds * 1000;

            console.log(`[ZOHO AUTH] Access token refreshed. Expires in ${expiresInSeconds}s`);
            resolve(this.accessToken);
          } catch (err) {
            reject(new Error(`Failed to parse Zoho OAuth response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Network error during Zoho OAuth refresh: ${err.message}`));
      });

      req.end();
    });
  }

  forceExpire() {
    this.expiresAt = 0;
  }

  getTokenStatus() {
    const now = Date.now();
    return {
      hasToken: Boolean(this.accessToken),
      isExpired: now >= this.expiresAt,
      secondsUntilExpiry: Math.max(0, Math.floor((this.expiresAt - now) / 1000))
    };
  }
}

const zohoAuthManager = new ZohoAuthManager();

module.exports = {
  ZohoAuthManager,
  zohoAuthManager
};

