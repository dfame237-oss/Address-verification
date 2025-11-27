// /api/client/login.js
const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';
const ACTION_TOKEN_SECRET = process.env.ACTION_TOKEN_SECRET || ((process.env.JWT_SECRET || 'replace_with_env_jwt_secret') + '_action');
const ACTION_TOKEN_EXPIRES_SECONDS = 300; // 5 minutes

module.exports = async (req, res) => {
  try {
    // CORS (adjust Access-Control-Allow-Origin in production)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });

    // Body parse safe
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
    const { username, password, force = false, actionToken = null } = body || {};

    if (!username || !password) {
      return res.status(400).json({ status: 'Error', message: 'username and password are required.' });
    }

    // Connect DB
    let db;
    try {
      const dbRes = await connectToDatabase();
      db = dbRes.db;
    } catch (dbErr) {
      console.error('DB connection failed in /api/client/login:', dbErr && (dbErr.stack || dbErr.message || dbErr));
      return res.status(500).json({ status: 'Error', message: 'Database connection failed.' });
    }

    const clients = db.collection('clients');
    const client = await clients.findOne({ username });

    if (!client) {
      return res.status(401).json({ status: 'Error', message: 'Invalid credentials.' });
    }

    const passwordHash = client.passwordHash || client.password;
    if (!passwordHash) {
      console.error('Missing password hash for user', username);
      return res.status(500).json({ status: 'Error', message: 'Server misconfiguration: password hash missing.' });
    }

    const match = await bcrypt.compare(password, passwordHash);
    if (!match) return res.status(401).json({ status: 'Error', message: 'Invalid credentials.' });

    if (client.isActive === false) {
      return res.status(403).json({ status: 'Error', message: 'Account disabled. Contact administrator.' });
    }

    const existingSessionId = client.activeSessionId || null;

    // If there is an existing session and the caller did NOT request force, return an actionToken + alreadyLoggedIn
    if (existingSessionId && !force) {
      // Create a short-lived token to authorize the forced logout attempt
      const actionPayload = { clientId: String(client._id), ts: Date.now() };
      const actionTokenSigned = jwt.sign(actionPayload, ACTION_TOKEN_SECRET, { expiresIn: ACTION_TOKEN_EXPIRES_SECONDS });
      return res.status(200).json({
        status: 'OK',
        alreadyLoggedIn: true,
        message: 'User already logged in on another device.',
        actionToken: actionTokenSigned
      });
    }

    // If force=true, require a valid actionToken (prevents arbitrary force)
    if (force) {
      if (!actionToken) {
        return res.status(400).json({ status: 'Error', message: 'actionToken required to force login.' });
      }
      try {
        const decoded = jwt.verify(actionToken, ACTION_TOKEN_SECRET);
        if (!decoded || decoded.clientId !== String(client._id)) {
          return res.status(403).json({ status: 'Error', message: 'Invalid action token.' });
        }
        // actionToken valid => clear previous activeSessionId (if any)
        await clients.updateOne({ _id: client._id }, { $set: { activeSessionId: null } });
      } catch (e) {
        console.error('Invalid or expired actionToken:', e && (e.message || e));
        return res.status(403).json({ status: 'Error', message: 'Invalid or expired action token.' });
      }
    }

    // Create a new session
    const sessionId = randomUUID();
    await clients.updateOne({ _id: client._id }, { $set: { activeSessionId: sessionId, lastActivityAt: new Date() } });

    // Issue JWT token to client (7 days)
    const jwtPayload = { clientId: String(client._id), sessionId, role: 'client' };
    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });

    const planDetails = {
      planName: client.planName || null,
      clientName: client.clientName || client.username || null,
      initialCredits: client.initialCredits ?? null,
      remainingCredits: client.remainingCredits ?? null,
      validityEnd: client.validityEnd ?? null
    };

    return res.status(200).json({ status: 'Success', message: 'Authenticated', token, planDetails });

  } catch (err) {
    console.error('UNCAUGHT ERROR in /api/client/login:', err && (err.stack || err.message || err));
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ status: 'Error', message: 'Internal Server Error' });
  }
};
