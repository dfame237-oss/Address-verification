// Address-verification-main/api/db.js

const { MongoClient, ServerApiVersion } = require('mongodb');

// Vercel Environment Variable (read directly from process.env)
const uri = process.env.MONGO_URI; 

// We DO NOT initialize or connect the client globally. 
// We define the parameters once.

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

// Caching the database client connection promise globally 
// ensures we only connect once per Vercel instance lifecycle.
let dbClientPromise;

module.exports = {
  connectToDatabase: async () => {
    if (!uri) {
        // This will now only throw if the connection is attempted
        console.error("MONGO_URI environment variable not set.");
        throw new Error("Database connection failed. MONGO_URI missing.");
    }
    
    // Use the global cache in production environments
    if (!dbClientPromise) {
        dbClientPromise = client.connect();
    }
    
    const dbClient = await dbClientPromise;
    // Define your database name here
    const db = dbClient.db("AddressVerificationDB"); 
    
    return { dbClient, db };
  }
};