const mongoose = require('mongoose');

let isConnected = false;

async function connectDB(customUri = null) {
  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  let uri = customUri || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set in environment');
  }

  if (!uri.includes('crm_zoho_db') && !uri.startsWith('mongodb://127.0.0.1')) {
    uri = uri.replace(/\/?$/, '/crm_zoho_db?retryWrites=true&w=majority');
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000
    });

    isConnected = true;
    console.log(`[DATABASE] MongoDB Connected: readyState=${mongoose.connection.readyState}`);
    return conn;
  } catch (err) {
    console.error(`[DATABASE ERROR] MongoDB Connection Failed: ${err.name} - ${err.code || err.codeName || 'Check credentials'}`);
    throw err;
  }
}

async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    isConnected = false;
    console.log('[DATABASE] MongoDB Disconnected');
  }
}

module.exports = {
  connectDB,
  disconnectDB
};

