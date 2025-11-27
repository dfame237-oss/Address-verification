// api/client/index.js
// Combined client router: login | logout | force-logout | activity | profile

// FIX: Change to require('./db') to correctly resolve module path within the /api/ directory
const { connectToDatabase } = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { ObjectId } = require('mongodb');

// FIX: Standardize JWT_SECRET fallback to match all other server files.
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret'; [cite_start]// [cite: 170]
const ACTION_TOKEN_SECRET =
  process.env.ACTION_TOKEN_SECRET ||
  (process.env.JWT_SECRET ? (process.env.JWT_SECRET + '_action') : 'change_action_secret');
const ACTION_TOKEN_EXPIRES_SECONDS = 300; [cite_start]// 5 minutes [cite: 171, 172]

const sendJSON = (res, statusCode, obj) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(statusCode).end(JSON.stringify(obj));
};

[cite_start]module.exports = async (req, res) => { // [cite: 173]
  // CORS (tighten in production)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); [cite_start]// [cite: 174]

  if (req.method === 'OPTIONS') return res.status(200).end();

  // derive action: ?action=... or body.action
  const url = new URL(req.url, `http://${req.headers.host}`);
  const actionQ = url.searchParams.get('action'); [cite_start]// [cite: 175]
  // parse body if needed
  let body = req.body;
  [cite_start]if (typeof body === 'string') { // [cite: 176]
    try { body = JSON.parse(body); [cite_start]// [cite: 177]
    } catch (e) { /* ignore */ }
  }
  const action = (actionQ || (body && body.action) || '').toLowerCase(); [cite_start]// [cite: 177]

  // connect DB once
  let db;
  try {
    db = (await connectToDatabase()).db; [cite_start]// [cite: 178]
  } catch (e) {
    console.error('DB connect failed in /api/client/index.js', e && (e.stack || e.message)); [cite_start]// [cite: 179]
    return sendJSON(res, 500, { status: 'Error', message: 'Database connection failed' }); [cite_start]// [cite: 180]
  }
  const clients = db.collection('clients');

  [cite_start]try { // [cite: 181]
    // -------------------------
    // ACTION: login
    // -------------------------
    if (action === 'login') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' }); [cite_start]// [cite: 182]

      const { username, password, force = false, actionToken = null } = body || {}; [cite_start]// [cite: 182]
      if (!username || !password) return sendJSON(res, 400, { status: 'Error', message: 'username and password required' }); [cite_start]// [cite: 183]

      const client = await clients.findOne({ username }); [cite_start]// [cite: 184]
      if (!client) return sendJSON(res, 401, { status: 'Error', message: 'Invalid credentials' }); [cite_start]// [cite: 184]

      const passwordHash = client.passwordHash || client.password || null; [cite_start]// [cite: 185]
      if (!passwordHash) {
        console.error('Missing passwordHash for', username); [cite_start]// [cite: 186]
        return sendJSON(res, 500, { status: 'Error', message: 'Server misconfiguration: password hash missing.' }); [cite_start]// [cite: 186]
      }

      const match = await bcrypt.compare(password, passwordHash); [cite_start]// [cite: 187]
      if (!match) return sendJSON(res, 401, { status: 'Error', message: 'Invalid credentials' }); [cite_start]// [cite: 188]
      if (client.isActive === false) return sendJSON(res, 403, { status: 'Error', message: 'Account disabled' }); [cite_start]// [cite: 189]

      const existingSessionId = client.activeSessionId || null;

      // If there is an existing session and caller didn't ask to force, return actionToken
      [cite_start]if (existingSessionId && !force) { // [cite: 190]
        const actionPayload = { clientId: String(client._id), ts: Date.now() }; [cite_start]// [cite: 190, 191]
        const actionTokenSigned = jwt.sign(actionPayload, ACTION_TOKEN_SECRET, { expiresIn: ACTION_TOKEN_EXPIRES_SECONDS }); [cite_start]// [cite: 191]
        return sendJSON(res, 200, {
          status: 'OK',
          alreadyLoggedIn: true,
          message: 'User already logged in on another device.',
          actionToken: actionTokenSigned,
          clientId: String(client._id)
        }); [cite_start]// [cite: 192]
      }

      // If force requested, validate actionToken
      if (force) {
        if (!actionToken) return sendJSON(res, 400, { status: 'Error', message: 'actionToken required to force login.' }); [cite_start]// [cite: 193]
        [cite_start]try { // [cite: 193]
          const decoded = jwt.verify(actionToken, ACTION_TOKEN_SECRET);
          [cite_start]if (!decoded || decoded.clientId !== String(client._id)) { // [cite: 194]
            return sendJSON(res, 403, { status: 'Error', message: 'Invalid action token.' }); [cite_start]// [cite: 194]
          }
          // valid: clear previous session
          await clients.updateOne({ _id: client._id }, { $set: { activeSessionId: null } }); [cite_start]// [cite: 195]
        } catch (e) {
          console.error('Invalid/expired actionToken', e && (e.message || e)); [cite_start]// [cite: 196]
          return sendJSON(res, 403, { status: 'Error', message: 'Invalid or expired action token.' }); [cite_start]// [cite: 197]
        }
      }

      // Create new session
      const sessionId = randomUUID();
      await clients.updateOne({ _id: client._id }, { $set: { activeSessionId: sessionId, lastActivityAt: new Date() } }); [cite_start]// [cite: 199]

      const jwtPayload = { clientId: String(client._id), sessionId, role: 'client' }; [cite_start]// [cite: 200]
      const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' }); [cite_start]// [cite: 200, 201]

      const planDetails = {
        [cite_start]planName: client.planName || null, // [cite: 241, 242]
        [cite_start]clientName: client.clientName || client.username || null, // [cite: 243]
        [cite_start]initialCredits: client.initialCredits ?? null, // [cite: 244]
        [cite_start]remainingCredits: client.remainingCredits ?? null, // [cite: 245]
        [cite_start]validityEnd: client.validityEnd ?? null // [cite: 246]
      };

      return sendJSON(res, 200, { status: 'Success', message: 'Authenticated', token, planDetails }); [cite_start]// [cite: 206]
    }

    // -------------------------
    // ACTION: logout
    // -------------------------
    if (action === 'logout') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' }); [cite_start]// [cite: 207]

      const authHeader = req.headers.authorization || ''; [cite_start]// [cite: 208]
      const token = (authHeader.split(' ')[1]) || null;
      if (!token) return sendJSON(res, 401, { status: 'Error', message: 'Missing token' }); [cite_start]// [cite: 209]

      let payload;
      try { payload = jwt.verify(token, JWT_SECRET); [cite_start]} // [cite: 210]
      catch (e) { payload = jwt.decode(token); [cite_start]} // [cite: 211]

      const clientId = payload?.clientId;
      const sessionId = payload?.sessionId;
      if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'Invalid token payload' }); [cite_start]// [cite: 212]

      const filter = { _id: new ObjectId(clientId) }; [cite_start]// [cite: 213]
      if (sessionId) filter.activeSessionId = sessionId;

      await clients.findOneAndUpdate(filter, { $set: { activeSessionId: null, lastActivityAt: new Date() } }); [cite_start]// [cite: 214]
      return sendJSON(res, 200, { status: 'Success', message: 'Logged out' }); [cite_start]// [cite: 215]
    }

    // -------------------------
    // ACTION: force-logout (explicit)
    // -------------------------
    if (action === 'force-logout') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' }); [cite_start]// [cite: 216, 217]

      const { clientId } = body || {};
      if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'clientId required' }); [cite_start]// [cite: 217, 218]

      [cite_start]try { // [cite: 218]
        await clients.updateOne({ _id: new ObjectId(clientId) }, { $set: { activeSessionId: null, lastActivityAt: new Date() } }); [cite_start]// [cite: 219]
        return sendJSON(res, 200, { status: 'Success', message: 'Force logout complete' }); [cite_start]// [cite: 219]
      } catch (e) {
        console.error('force-logout error:', e && (e.stack || e.message)); [cite_start]// [cite: 220, 221]
        return sendJSON(res, 500, { status: 'Error', message: 'Internal Server Error' }); [cite_start]// [cite: 221]
      }
    }

    // -------------------------
    // ACTION: activity (heartbeat)
    // -------------------------
    if (action === 'activity') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' }); [cite_start]// [cite: 222, 223]

      const authHeader = req.headers.authorization || ''; [cite_start]// [cite: 223]
      const token = (authHeader.split(' ')[1]) || null;
      if (!token) return sendJSON(res, 401, { status: 'Error', message: 'Missing token' }); [cite_start]// [cite: 224]

      let payload;
      try { payload = jwt.verify(token, JWT_SECRET); [cite_start]} // [cite: 225]
      catch (e) { return sendJSON(res, 401, { status: 'Error', message: 'Invalid token' }); [cite_start]} // [cite: 226]

      const clientId = payload?.clientId;
      const sessionId = payload?.sessionId;
      if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'Invalid token payload' }); [cite_start]// [cite: 227]

      // Validate the sessionId matches what's stored (prevent stale tokens)
      const client = await clients.findOne({ _id: new ObjectId(clientId) }); [cite_start]// [cite: 228]
      if (!client) return sendJSON(res, 401, { status: 'Error', message: 'Invalid session' }); [cite_start]// [cite: 229]
      [cite_start]if (client.activeSessionId && sessionId && client.activeSessionId !== sessionId) { // [cite: 230]
        // token does not match currently active session
        return sendJSON(res, 401, { status: 'Error', message: 'Session invalidated by server' }); [cite_start]// [cite: 230]
      }

      await clients.updateOne({ _id: new ObjectId(clientId) }, { $set: { lastActivityAt: new Date() } }); [cite_start]// [cite: 231, 232]
      return sendJSON(res, 200, { status: 'Success', message: 'Activity updated' }); [cite_start]// [cite: 232]
    }

    // -------------------------
    // ACTION: profile (GET) - NEW
    // Returns authoritative plan/credits & validates session
    // -------------------------
    if (action === 'profile') {
      if (req.method !== 'GET') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' }); [cite_start]// [cite: 233, 234]

      const authHeader = req.headers.authorization || ''; [cite_start]// [cite: 234]
      const token = (authHeader.split(' ')[1]) || null;
      if (!token) return sendJSON(res, 401, { status: 'Error', message: 'Missing token' }); [cite_start]// [cite: 235]

      let payload;
      try { payload = jwt.verify(token, JWT_SECRET); [cite_start]} // [cite: 236]
      catch (e) {
        return sendJSON(res, 401, { status: 'Error', message: 'Invalid token' }); [cite_start]// [cite: 237]
      }

      const clientId = payload?.clientId;
      const sessionId = payload?.sessionId;
      if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'Invalid token payload' }); [cite_start]// [cite: 238]

      const client = await clients.findOne({ _id: new ObjectId(clientId) }); [cite_start]// [cite: 239]
      if (!client) return sendJSON(res, 401, { status: 'Error', message: 'Invalid session' }); [cite_start]// [cite: 239]

      // If there is an activeSessionId that differs from token -> session invalidated
      [cite_start]if (client.activeSessionId && sessionId && client.activeSessionId !== sessionId) { // [cite: 240]
        return sendJSON(res, 401, { status: 'Error', message: 'Session invalidated (another device logged in)' }); [cite_start]// [cite: 240]
      }

      const planDetails = {
        [cite_start]planName: client.planName || null, // [cite: 241, 242]
        [cite_start]clientName: client.clientName || client.username || null, // [cite: 243]
        [cite_start]initialCredits: client.initialCredits ?? null, // [cite: 244]
        [cite_start]remainingCredits: client.remainingCredits ?? null, // [cite: 245]
        [cite_start]validityEnd: client.validityEnd ?? null, // [cite: 246]
        isActive: client.isActive
      };

      return sendJSON(res, 200, { status: 'Success', planDetails }); [cite_start]// [cite: 247]
    }

    // no action matched
    return sendJSON(res, 400, { status: 'Error', message: 'Unknown action. Use ?action=login|logout|force-logout|activity|profile or set body.action.' }); [cite_start]// [cite: 248]
  } catch (err) {
    console.error('UNCAUGHT in /api/client/index.js', err && (err.stack || err.message)); [cite_start]// [cite: 248, 249]
    return sendJSON(res, 500, { status: 'Error', message: 'Internal server error' }); [cite_start]// [cite: 249]
  }
};