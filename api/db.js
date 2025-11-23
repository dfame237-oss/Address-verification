// Improved api/db.js
// Safe MongoDB connection helper for Vercel Serverless.
// - Does NOT connect globally
// - Caches the client properly
// - Gives clear error messages when env is missing
// - Works in both dev and production

const { MongoClient } = require('mongodb');

// Read environment variable (must be set in Vercel → Settings → Environment Variables)
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ ERROR: MONGO_URI is missing. Set it in Vercel Environment Variables.");
}

// Database name
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

    // Create new client
    const client = new MongoClient(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
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

      return { dbClient: client, db };

    } catch (err) {
      console.error("❌ MongoDB Connection Error:", err);
      throw new Error("Failed to connect to MongoDB — " + err.message);
    }
  }
};
