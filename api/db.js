// Address-verification-main/api/db.js
// This code ensures the connection is not attempted until connectToDatabase() is called, 
// preventing global initialization crashes in Vercel.

const { MongoClient, ServerApiVersion } = require('mongodb');

// Vercel Environment Variable (read directly from process.env)
const uri = process.env.MONGO_URI; 

// We define the MongoClient properties globally but DO NOT connect it here.
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

// Use a global promise variable to cache the single client connection 
// across multiple calls during the serverless instance lifecycle.
let dbClientPromise;

module.exports = {
  connectToDatabase: async () => {
    if (!uri) {
        console.error("Database connection failed. MONGO_URI missing.");
        throw new Error("Database connection failed. MONGO_URI missing.");
    }
    
    // Check if running in a global environment (like Codespace/Dev)
    if (process.env.NODE_ENV === 'development') {
        if (!global._mongoClientPromise) {
            global._mongoClientPromise = client.connect();
        }
        dbClientPromise = global._mongoClientPromise;
    } else {
        // Production: Use the local file scope variable for caching
        if (!dbClientPromise) {
            dbClientPromise = client.connect();
        }
    }
    
    const dbClient = await dbClientPromise;
    const db = dbClient.db("AddressVerificationDB"); 
    
    return { dbClient, db };
  }
};