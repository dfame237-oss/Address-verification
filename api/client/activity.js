// api/client/activity.js
// Endpoint for client dashboard heartbeat: updates lastActivityAt

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

// IMPORTANT: make this fallback identical to the one used in your login file!
// Example fallback should match your other files. Prefer setting JWT_SECRET in Vercel envs.
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

function getClientIdFromReq(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.split(' ')[1] || null;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Use the same key your login issues: clientId
    const clientId = payload.clientId || payload.client_id || payload.id || null;
    return clientId ? String(clientId) : null;
  } catch (err) {
    // Helpful debug log for server-side investigation (remove or lower verbosity in prod)
    console.warn('activity.js - JWT verify failed:', err && err.message);
    return null;
  }
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your domain in production
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: "Error", message: 'Method Not Allowed' });

  const clientId = getClientIdFromReq(req);
  if (!clientId) {
    return res.status(401).json({ status: "Error", message: "Authentication required." });
  }

  if (!ObjectId.isValid(clientId)) {
    return res.status(400).json({ status: "Error", message: "Invalid clientId in token." });
  }

  let db;
  try {
    db = (await connectToDatabase()).db;
  } catch (e) {
    console.error('activity.js DB connect failed:', e && (e.stack || e.message));
    return res.status(500).json({ status: "Error", message: "Database connection failed." });
  }

  const clientsCollection = db.collection('clients');
  const lastActivityAt = new Date();

  try {
    const result = await clientsCollection.updateOne(
      { _id: new ObjectId(clientId) },
      { $set: { lastActivityAt } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ status: "Error", message: "Client not found." });
    }

    return res.status(200).json({ status: "Success", message: "Activity updated.", timestamp: lastActivityAt });

  } catch (e) {
    console.error("Client Activity Update Error:", e && (e.stack || e.message));
    return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e && e.message}` });
  }
};
