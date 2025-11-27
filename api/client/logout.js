// api/client/logout.js
// Fully updated safe logout for single-session logic

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async (req, res) => {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader) {
    return res.status(401).json({ status: 'Error', message: 'Missing Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ status: 'Error', message: 'Invalid Authorization header' });
  }

  // --- Try decode token (even if expired) ---
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    try {
      // Expired token still needs logout → decode without verify
      payload = jwt.decode(token);
    } catch (err) {
      return res.status(400).json({ status: 'Error', message: 'Could not decode token' });
    }
  }

  const clientId = payload?.clientId;
  const sessionId = payload?.sessionId;

  if (!clientId) {
    return res.status(400).json({ status: 'Error', message: 'Invalid token payload: no clientId' });
  }

  // --- Database connection ---
  let db;
  try {
    db = (await connectToDatabase()).db;
  } catch (e) {
    console.error("DB connection failed in /api/client/logout:", e);
    return res.status(500).json({ status: 'Error', message: 'Database connection failed' });
  }

  const clients = db.collection('clients');

  try {
    const filter = { _id: new ObjectId(clientId) };

    // If sessionId exists → only clear THAT session
    if (sessionId) {
      filter.activeSessionId = sessionId;
    }

    // Clear login session
    const result = await clients.findOneAndUpdate(
      filter,
      {
        $set: {
          activeSessionId: null,
          lastActivityAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    return res.status(200).json({
      status: "Success",
      message: "Logout successful.",
    });

  } catch (err) {
    console.error("Error in /api/client/logout.js:", err);
    return res.status(500).json({ status: "Error", message: "Internal server error" });
  }
};
