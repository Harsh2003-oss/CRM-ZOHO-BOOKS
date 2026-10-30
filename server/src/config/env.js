require('dotenv').config();

const requiredEnvVars = [
  'PORT',
  'ZOHO_BOOKS_DOMAIN',
  'ZOHO_BOOKS_ORGANIZATION_ID',
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
  'HUBSPOT_ACCESS_TOKEN',
  'MONGODB_URI'
];

function validateEnv() {
  const missing = [];
  for (const key of requiredEnvVars) {
    if (!process.env[key] || process.env[key].trim() === '') {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.warn(`[CONFIG WARNING] Missing environment variables: ${missing.join(', ')}`);
  }
}

function getSanitizedConfig() {
  return {
    PORT: process.env.PORT || 5000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
    ZOHO_BOOKS_DOMAIN: process.env.ZOHO_BOOKS_DOMAIN ? '[CONFIGURED]' : '[MISSING]',
    ZOHO_BOOKS_ORGANIZATION_ID: process.env.ZOHO_BOOKS_ORGANIZATION_ID ? '[CONFIGURED]' : '[MISSING]',
    ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID ? '[CONFIGURED]' : '[MISSING]',
    ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET ? '[CONFIGURED]' : '[MISSING]',
    ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN ? '[CONFIGURED]' : '[MISSING]',
    HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN ? '[CONFIGURED]' : '[MISSING]',
    MONGODB_URI: process.env.MONGODB_URI ? '[CONFIGURED]' : '[MISSING]'
  };
}

module.exports = {
  validateEnv,
  getSanitizedConfig
};

