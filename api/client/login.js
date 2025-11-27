// api/client/login.js
// Implements single-login enforcement using activeSessionId stored on client doc.
// On conflict returns an actionToken that can be used to terminate the existing session.

const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { ObjectId } = require('mongodb');

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';
const ACTION_TOKEN_SECRET = process.env.ACTION_TOKEN_SECRET || (process.env.JWT_SECRET || 'replace_with_env_jwt_secret') + '_action';
const ACTION_TOKEN_EXPIRES_SECONDS = 300; // 5 minutes

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });
  }

  // parse body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { /* keep original */ }
  }

  const { username, password, force } = body || {};
  if (!username || !password) {
    return res.status(400).json({ status: 'Error', message: 'username and password are required.' });
  }

  // connect db
  let db;
  try {
    const dbRes = await connectToDatabase();
    db = dbRes.db;
  } catch (e) {
    console.error('DB connection failed in /api/client/login:', e);
    return res.status(500).json({ status: 'Error', message: 'Database connection failed.' });
  }

  const clients = db.collection('clients');

  try {
    const client = await clients.findOne({ username });

    if (!client) {
      // Generic auth fail
      return res.status(401).json({ status: 'Error', message: 'Invalid credentials.' });
    }

    // verify password
    const passwordHash = client.passwordHash || client.password; // support older field name if present
    const passwordMatches = await bcrypt.compare(password, passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ status: 'Error', message: 'Invalid credentials.' });
    }

    // Check if client is active
    if (typeof client.isActive !== 'undefined' && client.isActive === false) {
      return res.status(403).json({ status: 'Error', message: 'Account disabled. Contact administrator.' });
    }

    // SINGLE-LOGIN LOGIC
    const existingSessionId = client.activeSessionId || null;

    // If there is an existing session and force is not set, return alreadyLoggedIn with action token
    if (existingSessionId && !force) {
      // create short-lived action token to authorize termination of existing session
      const actionPayload = { clientId: String(client._id) };
      const actionToken = jwt.sign(actionPayload, ACTION_TOKEN_SECRET, { expiresIn: ACTION_TOKEN_EXPIRES_SECONDS });

      return res.status(200).json({
        status: 'OK',
        alreadyLoggedIn: true,
        message: 'User is already logged in on another device.',
        actionToken
      });
    }

    // If force === true, clear existing session first (admin or user requested force)
    if (existingSessionId && force) {
      await clients.updateOne(
        { _id: client._id, activeSessionId: existingSessionId },
        { $set: { activeSessionId: null } }
      );
      // continue to create new session below
    }

    // Create a new sessionId, store it, issue JWT with sessionId
    const sessionId = uuidv4();
    await clients.updateOne(
      { _id: client._id },
      { $set: { activeSessionId: sessionId, lastActivityAt: new Date() } }
    );

    // create jwt payload
    const payload = {
      clientId: String(client._id),
      sessionId,
      role: 'client'
    };

    // Token expiry can be tuned; choose a reasonable expiry (e.g., 7 days)
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    // Optionally return planDetails & client summary (so frontend has remainingCredits etc.)
    const planDetails = {
      planName: client.planName || null,
      clientName: client.clientName || client.username || null,
      initialCredits: client.initialCredits ?? null,
      remainingCredits: client.remainingCredits ?? null,
      validityEnd: client.validityEnd ?? null
    };

    return res.status(200).json({
      status: 'Success',
      message: 'Authenticated',
      token,
      planDetails
    });

  } catch (e) {
    console.error('Error in /api/client/login:', e);
    return res.status(500).json({ status: 'Error', message: 'Internal Server Error' });
  }
};
