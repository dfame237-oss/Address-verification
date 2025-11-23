// api/db.js (refined)
// Safe MongoDB connection helper for Vercel Serverless.
// - Does NOT connect at import time
// - Caches the client & db on global for serverless reuse
// - Clear error messages when env is missing
// - Adds a serverSelectionTimeoutMS to fail fast on network issues

const { MongoClient } = require('mongodb');

// Read environment variable (must be set in Vercel → Settings → Environment Variables)
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ ERROR: MONGO_URI is missing. Set it in Vercel Environment Variables.");
}

// Database name (ensure this matches the DB in your connection string if needed)
const DB_NAME = "AddressVerificationDB";

// Global cache to reuse connections across function calls
let cachedClient = global._cachedMongoClient;
let cachedDb = global._cachedMongoDb;

module.exports = {
  connectToDatabase: async () => {
    // If missing URI, throw clean error
    if (!MONGO_URI) {
      throw new Error("Database connection failed. MONGO_URI missing in environment variables.");
    }

    // If already connected, reuse cached instance
    if (cachedClient && cachedDb) {
      return { dbClient: cachedClient, db: cachedDb };
    }

    // Create new client (serverSelectionTimeoutMS fails faster if network unreachable)
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 5000, // fail fast if cannot reach server
      // maxPoolSize: 10, // optional tuning
    });

    try {
      // Connect
      await client.connect();

      const db = client.db(DB_NAME);

      // Cache for serverless re-use
      global._cachedMongoClient = client;
      global._cachedMongoDb = db;

      cachedClient = client;
      cachedDb = db;

      console.log("📦 Connected to MongoDB:", DB_NAME);

      // Optional: in local dev, close client on process exit to avoid warnings
      if (process.env.NODE_ENV === 'development') {
        process.on('SIGINT', async () => {
          try {
            await client.close();
            console.log('MongoDB client closed on app termination');
            process.exit(0);
          } catch (err) {
            console.error('Error closing MongoDB client on exit:', err);
            process.exit(1);
          }
        });
      }

      return { dbClient: client, db };

    } catch (err) {
      console.error("❌ MongoDB Connection Error:", err);
      throw new Error("Failed to connect to MongoDB — " + err.message);
    }
  }
};
