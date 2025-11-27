// /api/db.js
// Merged: robust serverless-safe connectToDatabase + client helper functions
// Based on your uploaded files (safe connect helper).

const { MongoClient, ObjectId } = require('mongodb');

// Environment variable - must be set in Vercel (Project Settings → Environment Variables)
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ ERROR: MONGO_URI is missing. Set it in environment variables.");
}

// Database name - change if your Atlas DB uses a different name
const DB_NAME = process.env.DB_NAME || "sample_mflix";

// Global cache to reuse connections across serverless invocations
let cachedClient = global._cachedMongoClient;
let cachedDb = global._cachedMongoDb;

/**
 * connectToDatabase
 * - Reuses cached client when available (serverless-friendly)
 * - Fails fast if the DB can't be reached (serverSelectionTimeoutMS)
 */
async function connectToDatabase() {
  if (!MONGO_URI) throw new Error("Database connection failed. MONGO_URI missing in environment variables.");

  if (cachedClient && cachedDb) {
    return { dbClient: cachedClient, db: cachedDb };
  }

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    await client.connect();
    const db = client.db(DB_NAME);

    // Cache for re-use in subsequent invocations
    global._cachedMongoClient = client;
    global._cachedMongoDb = db;
    cachedClient = client;
    cachedDb = db;

    console.log("📦 Connected to MongoDB:", DB_NAME);
    return { dbClient: client, db };
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err && (err.stack || err.message || err));
    // Wrap the error message for clearer logs upstream
    throw new Error("Failed to connect to MongoDB — " + (err && err.message ? err.message : String(err)));
  }
}

/* ---------------------------
   Client helper functions
   --------------------------- */

/**
 * getClientById(clientId)
 * Accepts string id or ObjectId
 */
async function getClientById(clientId) {
  const { db } = await connectToDatabase();
  if (!clientId) return null;
  const _id = (typeof clientId === 'string' && ObjectId.isValid(clientId)) ? new ObjectId(clientId) : clientId;
  return await db.collection('clients').findOne({ _id });
}

/**
 * getClientByUsername(username)
 */
async function getClientByUsername(username) {
  const { db } = await connectToDatabase();
  if (!username) return null;
  return await db.collection('clients').findOne({ username });
}

/**
 * deductCredit(clientId)
 * Atomically decrements by 1 and returns remaining credits.
 * Handles "Unlimited".
 * Returns: { ok: true, remainingCredits } or { ok: false, error }
 */
async function deductCredit(clientId) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');

  // Resolve _id
  const _id = (typeof clientId === 'string' && ObjectId.isValid(clientId)) ? new ObjectId(clientId) : clientId;
  const client = await clients.findOne({ _id });

  if (!client) return { ok: false, error: "Client not found" };

  // Unlimited handling
  if (String(client.remainingCredits).toLowerCase() === 'unlimited') {
    return { ok: true, remainingCredits: 'Unlimited' };
  }

  // Compute remaining: prefer remainingCredits, fall back to initialCredits
  let remaining = (typeof client.remainingCredits === 'number') ? client.remainingCredits
                : (typeof client.initialCredits === 'number' ? client.initialCredits : null);

  if (remaining == null) {
    // no credits configured
    return { ok: false, error: "Credits not configured for client" };
  }

  if (remaining <= 0) {
    return { ok: false, error: "Credits exhausted" };
  }

  // Atomic decrement: ensure we get the post-update document
  const updated = await clients.findOneAndUpdate(
    { _id },
    { $inc: { remainingCredits: -1 } },
    { returnDocument: 'after' } // Node Mongo >=4.0 option
  );

  const newRemaining = updated && updated.value ? updated.value.remainingCredits : (remaining - 1);
  return { ok: true, remainingCredits: newRemaining };
}

/**
 * setCredits(clientId, value)
 * value may be number, numeric string, or "Unlimited" (case-insensitive)
 * Returns updated client or null
 */
async function setCredits(clientId, value) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');

  const setValue = (String(value).toLowerCase() === 'unlimited') ? 'Unlimited' : (Number(String(value).replace(/,/g, '')) || 0);

  const _id = (typeof clientId === 'string' && ObjectId.isValid(clientId)) ? new ObjectId(clientId) : clientId;
  const res = await clients.findOneAndUpdate(
    { _id },
    { $set: { remainingCredits: setValue } },
    { returnDocument: 'after' }
  );
  return res.value || null;
}

/**
 * topupCredits(clientId, addNumber)
 * Adds numeric credits to remainingCredits (unless Unlimited)
 */
async function topupCredits(clientId, addNumber) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');

  const _id = (typeof clientId === 'string' && ObjectId.isValid(clientId)) ? new ObjectId(clientId) : clientId;
  const client = await clients.findOne({ _id });
  if (!client) throw new Error("Client not found");

  if (String(client.remainingCredits).toLowerCase() === 'unlimited') {
    // nothing to do
    return client;
  }

  const n = Number(addNumber);
  if (isNaN(n)) throw new Error("Invalid number to top-up");

  const res = await clients.findOneAndUpdate(
    { _id },
    { $inc: { remainingCredits: n } },
    { returnDocument: 'after' }
  );

  return res.value;
}

/**
 * createClient(payload)
 * Minimal creation helper. Expect calling code to hash password beforehand (or adapt here).
 */
async function createClient(payload = {}) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');
  const now = new Date();
  const doc = {
    username: payload.username,
    passwordHash: payload.passwordHash || null,
    clientName: payload.clientName || null,
    email: payload.email || null,
    mobile: payload.mobile || null,
    planName: payload.planName || null,
    initialCredits: payload.initialCredits == null ? null : payload.initialCredits,
    remainingCredits: payload.remainingCredits == null ? payload.initialCredits : payload.remainingCredits,
    validityEnd: payload.validity || null,
    isActive: payload.isActive === undefined ? true : !!payload.isActive,
    createdAt: now,
    lastActivityAt: null,
  };

  const ins = await clients.insertOne(doc);
  return await clients.findOne({ _id: ins.insertedId });
}

/**
 * updateClient(clientId, updates)
 * Generic update helper. Returns updated doc.
 */
async function updateClient(clientId, updates = {}) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');
  const updatePayload = { ...updates };

  // Prevent accidental overwrite of _id
  delete updatePayload._id;

  // Normalize remainingCredits if present
  if (updatePayload.remainingCredits === 'Unlimited') {
    updatePayload.remainingCredits = 'Unlimited';
  } else if (typeof updatePayload.remainingCredits === 'string' && /^\d+$/.test(updatePayload.remainingCredits)) {
    updatePayload.remainingCredits = Number(updatePayload.remainingCredits);
  }

  const _id = (typeof clientId === 'string' && ObjectId.isValid(clientId)) ? new ObjectId(clientId) : clientId;
  const res = await clients.findOneAndUpdate(
    { _id },
    { $set: updatePayload },
    { returnDocument: 'after' }
  );
  return res.value;
}

/* ---------------------------
   Exports
   --------------------------- */
module.exports = {
  connectToDatabase,
  getClientById,
  getClientByUsername,
  deductCredit,
  setCredits,
  topupCredits,
  createClient,
  updateClient
};