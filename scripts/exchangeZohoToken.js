/**
 * Helper script to exchange temporary Zoho grant code for a permanent refresh token.
 * Usage: node scripts/exchangeZohoToken.js <code> <clientId> <clientSecret> <domain>
 * Example: node scripts/exchangeZohoToken.js 1000.xxxx 1000.yyyy zzzz com
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const code = args[0];
const clientId = args[1];
const clientSecret = args[2];
const domain = args[3] || 'com';

if (!code || !clientId || !clientSecret) {
  console.error('\nUsage: node scripts/exchangeZohoToken.js <code> <clientId> <clientSecret> [domain]');
  console.error('Example: node scripts/exchangeZohoToken.js 1000.abc... 1000.xyz... secret123 com\n');
  process.exit(1);
}

const postData = new URLSearchParams({
  code,
  client_id: clientId,
  client_secret: clientSecret,
  grant_type: 'authorization_code'
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

console.log(`\nConnecting to https://accounts.zoho.${domain} to exchange code...`);

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      if (response.error) {
        console.error('\n❌ Zoho OAuth Error:', response.error);
        if (response.error === 'invalid_code') {
          console.error('The code has expired or was already used. Please click "Generate Code" in Zoho API Console again.\n');
        }
        process.exit(1);
      }

      console.log('\n✅ Successfully exchanged token!');
      console.log('--------------------------------------------------');
      console.log('Refresh Token:', response.refresh_token);
      console.log('Access Token :', response.access_token);
      console.log('Expires In   :', response.expires_in, 'seconds');
      console.log('API Domain   :', response.api_domain);
      console.log('--------------------------------------------------');

      // Append or update in .env if exists
      const envPath = path.join(__dirname, '..', '.env');
      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
      }

      if (response.refresh_token) {
        if (envContent.includes('ZOHO_REFRESH_TOKEN=')) {
          envContent = envContent.replace(/ZOHO_REFRESH_TOKEN=.*/, `ZOHO_REFRESH_TOKEN=${response.refresh_token}`);
        } else {
          envContent += `\nZOHO_REFRESH_TOKEN=${response.refresh_token}\n`;
        }
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('💾 Automatically updated ZOHO_REFRESH_TOKEN in .env!\n');
      }
    } catch (err) {
      console.error('Failed to parse response:', data);
    }
  });
});

req.on('error', (e) => {
  console.error('\n❌ Request error:', e.message);
});

req.end();

