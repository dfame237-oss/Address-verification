// Address-verification-main/api/db.js

const { MongoClient, ServerApiVersion } = require('mongodb');

// Vercel Environment Variable (set in Step 2 of the previous response)
const uri = process.env.MONGO_URI; 

// MongoClient instance, reused for performance in serverless functions
let client;
let clientPromise;

if (!uri) {
  // Use console.error instead of throwing error directly for Vercel logging consistency
  console.error('MONGO_URI environment variable not set.');
}

// Global caching logic for development environments (like Codespaces)
if (process.env.NODE_ENV === 'development') {
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  // Production environment (Vercel)
  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  clientPromise = client.connect();
}

// Export a module-scoped promise that resolves to the MongoClient
module.exports = {
  connectToDatabase: async () => {
    try {
      const dbClient = await clientPromise;
      // Define your database name here
      const db = dbClient.db("AddressVerificationDB"); 
      return { dbClient, db };
    } catch (error) {
      console.error("Failed to connect to MongoDB:", error);
      throw new Error("Database connection failed.");
    }
  }
};