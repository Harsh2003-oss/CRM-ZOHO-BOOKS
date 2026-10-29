const express = require('express');
const mongoose = require('mongoose');
const { zohoAuthManager } = require('../clients/zohoAuthManager');
const { hubspotClient } = require('../clients/hubspotClient');

const router = express.Router();

router.get('/health', async (req, res) => {
  const healthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      mongodb: { status: 'disconnected' },
      zoho: { status: 'disconnected' },
      hubspot: { status: 'disconnected' }
    }
  };

  let allHealthy = true;

  // 1. Check MongoDB
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    healthStatus.services.mongodb = { status: 'connected', readyState: 1 };
  } else {
    healthStatus.services.mongodb = {
      status: 'disconnected',
      readyState: mongoose.connection ? mongoose.connection.readyState : 0
    };
    allHealthy = false;
  }

  // 2. Check Zoho Books Auth
  try {
    const token = await zohoAuthManager.getValidAccessToken();
    if (token) {
      const tokenStatus = zohoAuthManager.getTokenStatus();
      healthStatus.services.zoho = {
        status: 'connected',
        secondsUntilExpiry: tokenStatus.secondsUntilExpiry
      };
    } else {
      healthStatus.services.zoho = { status: 'disconnected', error: 'No token' };
      allHealthy = false;
    }
  } catch (err) {
    healthStatus.services.zoho = { status: 'disconnected', error: err.message };
    allHealthy = false;
  }

  // 3. Check HubSpot API
  try {
    const hsRes = await hubspotClient.getProperty('zoho_sales_order_id');
    if (hsRes.statusCode === 200) {
      healthStatus.services.hubspot = { status: 'connected' };
    } else {
      healthStatus.services.hubspot = { status: 'degraded', statusCode: hsRes.statusCode };
      allHealthy = false;
    }
  } catch (err) {
    healthStatus.services.hubspot = { status: 'disconnected', error: err.message };
    allHealthy = false;
  }

  healthStatus.status = allHealthy ? 'ok' : 'degraded';
  const httpCode = allHealthy ? 200 : 503;

  return res.status(httpCode).json(healthStatus);
});

module.exports = router;
