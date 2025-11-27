// /api/client/login.js (debug-friendly, uses crypto.randomUUID())
const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto'); // <- built-in, no extra dependency
const { ObjectId } = require('mongodb');

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';
const ACTION_TOKEN_SECRET = process.env.ACTION_TOKEN_SECRET || (process.env.JWT_SECRET || 'replace_with_env_jwt_secret') + '_action';
const ACTION_TOKEN_EXPIRES_SECONDS = 300; // 5 minutes

module.exports = async (req, res) => {
  try {
    // CORS (adjust origin for production)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });

    // Parse body (safe)
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    const { username, password, force } = body || {};
    if (!username || !password) {
      return res.status(400).json({ status: 'Error', message: 'username and password are required.' });
    }

    // DB connect
    let db;
    try {
      const dbRes = await connectToDatabase();
      db = dbRes.db;
    } catch (e) {
      console.error('DB connection failed in /api/client/login:', e && (e.stack || e.message || e));
      return res.status(500).json({ status: 'Error', message: 'Database connection failed.', detail: e && (e.stack || e.message) });
    }

    const clients = db.collection('clients');
    const client = await clients.findOne({ username });

    if (!client) {
      return res.status(401).json({ status: 'Error', message: 'Invalid credentials.' });
    }

    const passwordHash = client.passwordHash || client.password;
    if (!passwordHash) {
      console.error('Missing passwordHash for user', username, 'client doc:', client);
      return res.status(500).json({ status: 'Error', message: 'Server misconfiguration: password hash missing for user.' });
    }

    const passwordMatches = await bcrypt.compare(password, passwordHash);
    if (!passwordMatches) return res.status(401).json({ status: 'Error', message: 'Invalid credentials.' });

    if (typeof client.isActive !== 'undefined' && client.isActive === false) {
      return res.status(403).json({ status: 'Error', message: 'Account disabled. Contact administrator.' });
    }

    const existingSessionId = client.activeSessionId || null;
    if (existingSessionId && !force) {
      const actionPayload = { clientId: String(client._id) };
      const actionToken = jwt.sign(actionPayload, ACTION_TOKEN_SECRET, { expiresIn: ACTION_TOKEN_EXPIRES_SECONDS });
      return res.status(200).json({ status: 'OK', alreadyLoggedIn: true, message: 'User already logged in on another device.', actionToken });
    }
    if (existingSessionId && force) {
      await clients.updateOne({ _id: client._id, activeSessionId: existingSessionId }, { $set: { activeSessionId: null } });
    }

    const sessionId = randomUUID();
    await clients.updateOne({ _id: client._id }, { $set: { activeSessionId: sessionId, lastActivityAt: new Date() } });

    const payload = { clientId: String(client._id), sessionId, role: 'client' };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

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
    return res.status(500).json({ status: 'Error', message: 'Internal Server Error', detail: err && (err.stack || err.message) });
  }
};
