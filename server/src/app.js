const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const healthRoutes = require('./routes/healthRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const operatorRoutes = require('./routes/operatorRoutes');

const app = express();

// Middlewares
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

// Request logging (sanitized)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/api/health') {
      console.log(`[HTTP] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Mount Routes
app.use('/api', healthRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/operator', operatorRoutes);

// Serve static frontend assets for Dashboard (React + Vite production build)
const clientDistPath = path.join(__dirname, '../../client/dist');
const publicFallbackPath = path.join(__dirname, '../public');
const dashboardStaticPath = fs.existsSync(clientDistPath) ? clientDistPath : publicFallbackPath;

app.use('/dashboard', express.static(dashboardStaticPath));
app.get(/^\/dashboard(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(dashboardStaticPath, 'index.html'));
});

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'CRM & Zoho Books Integration Gateway',
    version: '1.0.0',
    status: 'online',
    health: '/api/health'
  });
});

// Central Error Handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.message);
  res.status(err.status || 500).json({
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred'
  });
});

module.exports = app;

