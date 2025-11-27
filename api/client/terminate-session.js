// api/client/terminate-session.js
// Verifies an actionToken (short-lived) and clears the client's activeSessionId so a new login can occur.

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const ACTION_TOKEN_SECRET = process.env.ACTION_TOKEN_SECRET || (process.env.JWT_SECRET || 'replace_with_env_jwt_secret') + '_action';

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });

  // parse body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { /* keep original */ }
  }

  const { actionToken } = body || {};
  if (!actionToken) return res.status(400).json({ status: 'Error', message: 'actionToken is required.' });

  // verify action token
  let payload;
  try {
    payload = jwt.verify(actionToken, ACTION_TOKEN_SECRET);
  } catch (e) {
    console.error('Invalid/expired action token in /api/client/terminate-session:', e?.message || e);
    return res.status(401).json({ status: 'Error', message: 'Invalid or expired action token.' });
  }

  const clientId = payload.clientId;
  if (!clientId) return res.status(400).json({ status: 'Error', message: 'Invalid action token payload.' });

  // connect to DB
  let db;
  try {
    const dbRes = await connectToDatabase();
    db = dbRes.db;
  } catch (e) {
    console.error('DB connection failed in /api/client/terminate-session:', e);
    return res.status(500).json({ status: 'Error', message: 'Database connection failed.' });
  }

  const clients = db.collection('clients');

  try {
    // Clear the activeSessionId for this client
    const result = await clients.findOneAndUpdate(
      { _id: new ObjectId(clientId) },
      { $set: { activeSessionId: null, lastActivityAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!result.value) {
      // If no document found (shouldn't normally happen)
      return res.status(404).json({ status: 'Error', message: 'Client not found.' });
    }

    return res.status(200).json({ status: 'Success', message: 'Previous session cleared. You may log in now.' });
  } catch (e) {
    console.error('Error in /api/client/terminate-session:', e);
    return res.status(500).json({ status: 'Error', message: 'Internal Server Error' });
  }
};
  