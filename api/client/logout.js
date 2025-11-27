// api/client/logout.js
// Clears client's activeSessionId on logout (only if sessionId matches).

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });
  }

  // Parse token from Authorization header
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader) return res.status(401).json({ status: 'Error', message: 'Missing Authorization header' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ status: 'Error', message: 'Invalid Authorization header' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ status: 'Error', message: 'Invalid or expired token' });
  }

  const { clientId, sessionId } = payload || {};
  if (!clientId || !sessionId) {
    return res.status(400).json({ status: 'Error', message: 'Invalid token payload' });
  }

  // Connect to DB
  let db;
  try {
    const dbRes = await connectToDatabase();
    db = dbRes.db;
  } catch (e) {
    console.error('DB connect failed in /api/client/logout:', e);
    return res.status(500).json({ status: 'Error', message: 'Database connection failed.' });
  }

  const clients = db.collection('clients');

  try {
    // Only clear activeSessionId if it matches the sessionId in token (prevents clearing another session)
    const result = await clients.findOneAndUpdate(
      { _id: new ObjectId(clientId), activeSessionId: sessionId },
      { $set: { activeSessionId: null, lastActivityAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!result.value) {
      // No match — either already logged out or session mismatch
      return res.status(200).json({ status: 'Success', message: 'Session cleared (if it existed).' });
    }

    return res.status(200).json({ status: 'Success', message: 'Logged out successfully.' });
  } catch (e) {
    console.error('Error in /api/client/logout:', e);
    return res.status(500).json({ status: 'Error', message: 'Internal Server Error' });
  }
};
