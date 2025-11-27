// api/client/index.js
// Combined client router: login | logout | force-logout | activity | profile
const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { ObjectId } = require('mongodb');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ACTION_TOKEN_SECRET =
  process.env.ACTION_TOKEN_SECRET ||
  (process.env.JWT_SECRET ? (process.env.JWT_SECRET + '_action') : 'change_action_secret');
const ACTION_TOKEN_EXPIRES_SECONDS = 300; // 5 minutes

const sendJSON = (res, statusCode, obj) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(statusCode).end(JSON.stringify(obj));
};

module.exports = async (req, res) => {
  // CORS (tighten in production)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // derive action: ?action=... or body.action
  const url = new URL(req.url, `http://${req.headers.host}`);
  const actionQ = url.searchParams.get('action');
  // parse body if needed
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { /* ignore */ }
  }
  const action = (actionQ || (body && body.action) || '').toLowerCase();

  // connect DB once
  let db;
  try {
    db = (await connectToDatabase()).db;
  } catch (e) {
    console.error('DB connect failed in /api/client/index.js', e && (e.stack || e.message));
    return sendJSON(res, 500, { status: 'Error', message: 'Database connection failed' });
  }
  const clients = db.collection('clients');

  try {
    // -------------------------
    // ACTION: login
    // -------------------------
    if (action === 'login') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });

      const { username, password, force = false, actionToken = null } = body || {};
      if (!username || !password) return sendJSON(res, 400, { status: 'Error', message: 'username and password required' });

      const client = await clients.findOne({ username });
      if (!client) return sendJSON(res, 401, { status: 'Error', message: 'Invalid credentials' });

      const passwordHash = client.passwordHash || client.password || null;
      if (!passwordHash) {
        console.error('Missing passwordHash for', username);
        return sendJSON(res, 500, { status: 'Error', message: 'Server misconfiguration: password hash missing.' });
      }

      const match = await bcrypt.compare(password, passwordHash);
      if (!match) return sendJSON(res, 401, { status: 'Error', message: 'Invalid credentials' });
      if (client.isActive === false) return sendJSON(res, 403, { status: 'Error', message: 'Account disabled' });

      const existingSessionId = client.activeSessionId || null;

      // If there is an existing session and caller didn't ask to force, return actionToken
      if (existingSessionId && !force) {
        const actionPayload = { clientId: String(client._id), ts: Date.now() };
        const actionTokenSigned = jwt.sign(actionPayload, ACTION_TOKEN_SECRET, { expiresIn: ACTION_TOKEN_EXPIRES_SECONDS });
        return sendJSON(res, 200, {
          status: 'OK',
          alreadyLoggedIn: true,
          message: 'User already logged in on another device.',
          actionToken: actionTokenSigned,
          clientId: String(client._id)
        });
      }

      // If force requested, validate actionToken
      if (force) {
        if (!actionToken) return sendJSON(res, 400, { status: 'Error', message: 'actionToken required to force login.' });
        try {
          const decoded = jwt.verify(actionToken, ACTION_TOKEN_SECRET);
          if (!decoded || decoded.clientId !== String(client._id)) {
            return sendJSON(res, 403, { status: 'Error', message: 'Invalid action token.' });
          }
          // valid: clear previous session
          await clients.updateOne({ _id: client._id }, { $set: { activeSessionId: null } });
        } catch (e) {
          console.error('Invalid/expired actionToken', e && (e.message || e));
          return sendJSON(res, 403, { status: 'Error', message: 'Invalid or expired action token.' });
        }
      }

      // Create new session
      const sessionId = randomUUID();
      await clients.updateOne({ _id: client._id }, { $set: { activeSessionId: sessionId, lastActivityAt: new Date() } });

      const jwtPayload = { clientId: String(client._id), sessionId, role: 'client' };
      const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });

      const planDetails = {
        planName: client.planName || null,
        clientName: client.clientName || client.username || null,
        initialCredits: client.initialCredits ?? null,
        remainingCredits: client.remainingCredits ?? null,
        validityEnd: client.validityEnd ?? null
      };

      return sendJSON(res, 200, { status: 'Success', message: 'Authenticated', token, planDetails });
    }

    // -------------------------
    // ACTION: logout
    // -------------------------
    if (action === 'logout') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });

      const authHeader = req.headers.authorization || '';
      const token = (authHeader.split(' ')[1]) || null;
      if (!token) return sendJSON(res, 401, { status: 'Error', message: 'Missing token' });

      let payload;
      try { payload = jwt.verify(token, JWT_SECRET); }
      catch (e) { payload = jwt.decode(token); }

      const clientId = payload?.clientId;
      const sessionId = payload?.sessionId;
      if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'Invalid token payload' });

      const filter = { _id: new ObjectId(clientId) };
      if (sessionId) filter.activeSessionId = sessionId;

      await clients.findOneAndUpdate(filter, { $set: { activeSessionId: null, lastActivityAt: new Date() } });
      return sendJSON(res, 200, { status: 'Success', message: 'Logged out' });
    }

    // -------------------------
    // ACTION: force-logout (explicit)
    // -------------------------
    if (action === 'force-logout') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });

      const { clientId } = body || {};
      if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'clientId required' });

      try {
        await clients.updateOne({ _id: new ObjectId(clientId) }, { $set: { activeSessionId: null, lastActivityAt: new Date() } });
        return sendJSON(res, 200, { status: 'Success', message: 'Force logout complete' });
      } catch (e) {
        console.error('force-logout error:', e && (e.stack || e.message));
        return sendJSON(res, 500, { status: 'Error', message: 'Internal Server Error' });
      }
    }

    // -------------------------
    // ACTION: activity (heartbeat)
    // -------------------------
    if (action === 'activity') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });

      const authHeader = req.headers.authorization || '';
      const token = (authHeader.split(' ')[1]) || null;
      if (!token) return sendJSON(res, 401, { status: 'Error', message: 'Missing token' });

      let payload;
      try { payload = jwt.verify(token, JWT_SECRET); }
      catch (e) { return sendJSON(res, 401, { status: 'Error', message: 'Invalid token' }); }

      const clientId = payload?.clientId;
      const sessionId = payload?.sessionId;
      if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'Invalid token payload' });

      // Validate the sessionId matches what's stored (prevent stale tokens)
      const client = await clients.findOne({ _id: new ObjectId(clientId) });
      if (!client) return sendJSON(res, 401, { status: 'Error', message: 'Invalid session' });
      if (client.activeSessionId && sessionId && client.activeSessionId !== sessionId) {
        // token does not match currently active session
        return sendJSON(res, 401, { status: 'Error', message: 'Session invalidated by server' });
      }

      await clients.updateOne({ _id: new ObjectId(clientId) }, { $set: { lastActivityAt: new Date() } });
      return sendJSON(res, 200, { status: 'Success', message: 'Activity updated' });
    }

    // -------------------------
    // ACTION: profile (GET) - NEW
    // Returns authoritative plan/credits & validates session
    // -------------------------
    if (action === 'profile') {
      if (req.method !== 'GET') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });

      const authHeader = req.headers.authorization || '';
      const token = (authHeader.split(' ')[1]) || null;
      if (!token) return sendJSON(res, 401, { status: 'Error', message: 'Missing token' });

      let payload;
      try { payload = jwt.verify(token, JWT_SECRET); }
      catch (e) {
        return sendJSON(res, 401, { status: 'Error', message: 'Invalid token' });
      }

      const clientId = payload?.clientId;
      const sessionId = payload?.sessionId;
      if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'Invalid token payload' });

      const client = await clients.findOne({ _id: new ObjectId(clientId) });
      if (!client) return sendJSON(res, 401, { status: 'Error', message: 'Invalid session' });

      // If there is an activeSessionId that differs from token -> session invalidated
      if (client.activeSessionId && sessionId && client.activeSessionId !== sessionId) {
        return sendJSON(res, 401, { status: 'Error', message: 'Session invalidated (another device logged in)' });
      }

      const planDetails = {
        planName: client.planName || null,
        clientName: client.clientName || client.username || null,
        initialCredits: client.initialCredits ?? null,
        remainingCredits: client.remainingCredits ?? null,
        validityEnd: client.validityEnd ?? null,
        isActive: client.isActive
      };

      return sendJSON(res, 200, { status: 'Success', planDetails });
    }

    // no action matched
    return sendJSON(res, 400, { status: 'Error', message: 'Unknown action. Use ?action=login|logout|force-logout|activity|profile or set body.action.' });
  } catch (err) {
    console.error('UNCAUGHT in /api/client/index.js', err && (err.stack || err.message));
    return sendJSON(res, 500, { status: 'Error', message: 'Internal server error' });
  }
};
