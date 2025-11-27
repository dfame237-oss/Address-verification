// api/db.js (UPDATED)
// Based on your original file. Adds client helper functions.
// See original uploaded file for the pre-existing connection helper. :contentReference[oaicite:2]{index=2}

const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ ERROR: MONGO_URI is missing. Set it in environment variables.");
}

// IMPORTANT: adjust DB_NAME if different in your environment
const DB_NAME = process.env.DB_NAME || "sample_mflix";

let cachedClient = global._cachedMongoClient;
let cachedDb = global._cachedMongoDb;

async function connectToDatabase() {
  if (!MONGO_URI) throw new Error("Database connection failed. MONGO_URI missing.");

  if (cachedClient && cachedDb) {
    return { dbClient: cachedClient, db: cachedDb };
  }

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(DB_NAME);

  global._cachedMongoClient = client;
  global._cachedMongoDb = db;
  cachedClient = client;
  cachedDb = db;

  console.log("📦 Connected to MongoDB:", DB_NAME);
  return { dbClient: client, db };
}

/*
  Helper functions for clients collection:
  - getClientById(id)
  - getClientByUsername(username)
  - deductCredit(clientId) -> returns { ok: true, remainingCredits } or { ok: false, error }
  - setCredits(clientId, value) -> sets remainingCredits (number or "Unlimited")
  - topupCredits(clientId, addNumber) -> increments number
  - createClient(payload) -> creates client document
  - updateClient(clientId, updates) -> updates fields
*/

async function getClientById(clientId) {
  const { db } = await connectToDatabase();
  if (!clientId) return null;
  const _id = typeof clientId === 'string' && ObjectId.isValid(clientId) ? new ObjectId(clientId) : clientId;
  return await db.collection('clients').findOne({ _id });
}

async function getClientByUsername(username) {
  const { db } = await connectToDatabase();
  return await db.collection('clients').findOne({ username });
}

async function deductCredit(clientId) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');
  const client = await clients.findOne({ _id: (ObjectId.isValid(clientId) ? new ObjectId(clientId) : clientId) });

  if (!client) return { ok: false, error: "Client not found" };

  // Unlimited handling
  if (client.remainingCredits === 'Unlimited' || client.remainingCredits === 'unlimited') {
    return { ok: true, remainingCredits: 'Unlimited' };
  }

  // If remainingCredits missing, try to use initialCredits
  let remaining = typeof client.remainingCredits === 'number' ? client.remainingCredits : (typeof client.initialCredits === 'number' ? client.initialCredits : null);

  if (remaining == null) {
    // no credits tracked: treat as 0
    return { ok: false, error: "Credits not configured for client" };
  }

  if (remaining <= 0) {
    return { ok: false, error: "Credits exhausted" };
  }

  // Decrement by 1 and persist
  const updated = await clients.findOneAndUpdate(
    { _id: client._id },
    { $inc: { remainingCredits: -1 } },
    { returnDocument: 'after' }
  );

  const newRemaining = updated.value ? updated.value.remainingCredits : (remaining - 1);
  return { ok: true, remainingCredits: newRemaining };
}

async function setCredits(clientId, value) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');

  // Accept numeric or 'Unlimited'
  const setValue = (String(value).toLowerCase() === 'unlimited') ? 'Unlimited' : (Number(String(value).replace(/,/g, '')) || 0);

  const res = await clients.findOneAndUpdate(
    { _id: (ObjectId.isValid(clientId) ? new ObjectId(clientId) : clientId) },
    { $set: { remainingCredits: setValue } },
    { returnDocument: 'after' }
  );

  return res.value || null;
}

async function topupCredits(clientId, addNumber) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');

  const client = await clients.findOne({ _id: (ObjectId.isValid(clientId) ? new ObjectId(clientId) : clientId) });
  if (!client) throw new Error("Client not found");

  if (client.remainingCredits === 'Unlimited') {
    // nothing to do
    return client;
  }

  const n = Number(addNumber);
  if (isNaN(n)) throw new Error("Invalid number to top-up");

  const res = await clients.findOneAndUpdate(
    { _id: client._id },
    { $inc: { remainingCredits: n } },
    { returnDocument: 'after' }
  );

  return res.value;
}

async function createClient(payload = {}) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');
  const now = new Date();
  const doc = {
    username: payload.username,
    passwordHash: payload.passwordHash || null, // assume you will hash before storing or server does it
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
    // other fields you use
  };

  const ins = await clients.insertOne(doc);
  return await clients.findOne({ _id: ins.insertedId });
}

async function updateClient(clientId, updates = {}) {
  const { db } = await connectToDatabase();
  const clients = db.collection('clients');
  const updatePayload = { ...updates };
  // Prevent accidental overwrite of _id
  delete updatePayload._id;
  if (updatePayload.remainingCredits === 'Unlimited') {
    updatePayload.remainingCredits = 'Unlimited';
  } else if (typeof updatePayload.remainingCredits === 'string' && updatePayload.remainingCredits.match(/^\d+$/)) {
    updatePayload.remainingCredits = Number(updatePayload.remainingCredits);
  }
  const res = await clients.findOneAndUpdate(
    { _id: (ObjectId.isValid(clientId) ? new ObjectId(clientId) : clientId) },
    { $set: updatePayload },
    { returnDocument: 'after' }
  );
  return res.value;
}

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
