require('dotenv').config();
const app = require('./app');
const { connectDB, disconnectDB } = require('./config/db');
const { validateEnv } = require('./config/env');

const PORT = process.env.PORT || 5000;

async function startServer() {
  validateEnv();

  try {
    await connectDB();
  } catch (err) {
    console.warn('[SERVER WARNING] Server started without active MongoDB connection. Waiting for valid database credentials.');
  }

  const server = app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Integration Gateway Running on Port ${PORT}`);
    console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
    console.log(`==================================================\n`);
  });

  const shutdown = async (signal) => {
    console.log(`\n[SHUTDOWN] Received ${signal}. Closing server gracefully...`);
    server.close(async () => {
      await disconnectDB();
      console.log('[SHUTDOWN] Completed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };

