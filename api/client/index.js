// api/client/index.js
// Combined client router: login | logout | force-logout | activity | profile | update-password |
// active-jobs (NEW)

const { connectToDatabase } = require('../../utils/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto'); //
const { ObjectId } = require('mongodb'); //
// FIX: Standardize JWT_SECRET fallback to match all other server files.
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret'; //
const ACTION_TOKEN_SECRET =
  process.env.ACTION_TOKEN_SECRET ||
  (process.env.JWT_SECRET ? (process.env.JWT_SECRET + '_action') : 'change_action_secret');
const ACTION_TOKEN_EXPIRES_SECONDS = 300; //
// 5 minutes

const sendJSON = (res, statusCode, obj) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(statusCode).end(JSON.stringify(obj));
};
module.exports = async (req, res) => { //
  // CORS (tighten in production)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
// Added PUT for update
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); //

  if (req.method === 'OPTIONS') return res.status(200).end(); //
// derive action: ?action=... or body.action
  const url = new URL(req.url, `http://${req.headers.host}`);
  const actionQ = url.searchParams.get('action'); //
// parse body if needed
  let body = req.body; //
  if (typeof body === 'string') { //
    try { body = JSON.parse(body); //
    } catch (e) { /* ignore */ }
  }
  const action = (actionQ || (body && body.action) || '').toLowerCase(); //
// connect DB once
  let db;
  try {
    db = (await connectToDatabase()).db; //
  } catch (e) {
    console.error('DB connect failed in /api/client/index.js', e && (e.stack || e.message)); //
    return sendJSON(res, 500, { status: 'Error', message: 'Database connection failed' }); //
  }
  const clients = db.collection('clients'); //
  const bulkJobs = db.collection('bulkJobs'); // Reference for job status

  try {
    // -------------------------
    // ACTION: login
    // -------------------------
    if (action === 'login') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' }); //
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
        planName: client.planName ||
          null,
        clientName: client.clientName || client.username ||
          null,
        initialCredits: client.initialCredits ??
          null,
        remainingCredits: client.remainingCredits ??
          null,
        validityEnd: client.validityEnd ?? null
      };
      return sendJSON(res, 200, { status: 'Success', message: 'Authenticated', token, planDetails });
    }

    // -------------------------
    // Middleware for authenticated actions (checks token validity, extracts clientId, checks session)
    // -------------------------
    const authHeader = req.headers.authorization ||
      '';
    const token = (authHeader.split(' ')[1]) || null;
    if (!token) return sendJSON(res, 401, { status: 'Error', message: 'Missing token' });
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch (e) { payload = jwt.decode(token);
    }

    // `clientId` is the STRING ID from JWT
    const clientId = payload?.clientId; 
    const sessionId = payload?.sessionId;
    if (!clientId) return sendJSON(res, 400, { status: 'Error', message: 'Invalid token payload' });
    
    // FIX: Use the string ID for bulkJobs query and ObjectId for 'clients' collection lookup
    const clientIdString = clientId;
    const clientObjectId = new ObjectId(clientIdString);

    const client = await clients.findOne({ _id: clientObjectId });
    
    if (!client) return sendJSON(res, 401, { status: 'Error', message: 'Invalid session' });
    // IMPROVEMENT: Check account status immediately
    if (client.isActive === false) return sendJSON(res, 403, { status: 'Error', message: 'Account disabled' });
    if (client.activeSessionId && sessionId && client.activeSessionId !== sessionId) {
      return sendJSON(res, 401, { status: 'Error', message: 'Session invalidated by server' });
    }

    // -------------------------
    // ACTION: update-password (NEW)
    // -------------------------
    if (action === 'update-password') {
      if (req.method !== 'PUT') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });
      const { newPassword } = body || {};
      if (!newPassword || newPassword.length < 6) return sendJSON(res, 400, { status: 'Error', message: 'New password must be at least 6 characters.' });
      try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const result = await clients.updateOne(
          { _id: clientObjectId },
          { $set: { passwordHash: hashedPassword } }
        );
        if (result.matchedCount === 0) return sendJSON(res, 404, { status: 'Error', message: 'Client not found.' });
        // Invalidate current session for security (forces client to log back in)
        await clients.updateOne({ _id: clientObjectId }, { $set: { activeSessionId: null } });
        return sendJSON(res, 200, { status: 'Success', message: 'Password updated successfully. Please log in again.' });
      } catch (e) {
        console.error('Password update error:', e && (e.stack || e.message));
        return sendJSON(res, 500, { status: 'Error', message: 'Internal Server Error during password update.' });
      }
    }


    // -------------------------
    // ACTION: logout
    // -------------------------
    if (action === 'logout') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });
      const filter = { _id: clientObjectId };
      if (sessionId) filter.activeSessionId = sessionId;
      await clients.findOneAndUpdate(filter, { $set: { activeSessionId: null, lastActivityAt: new Date() } });
      return sendJSON(res, 200, { status: 'Success', message: 'Logged out' });
    }

    // -------------------------
    // ACTION: force-logout (explicit)
    // -------------------------
    if (action === 'force-logout') {
      if (req.method !== 'POST') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });
      try {
        await clients.updateOne({ _id: clientObjectId }, { $set: { activeSessionId: null, lastActivityAt: new Date() } });
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
      await clients.updateOne({ _id: clientObjectId }, { $set: { lastActivityAt: new Date() } });
      return sendJSON(res, 200, { status: 'Success', message: 'Activity updated' });
    }

    // -------------------------
    // ACTION: profile (GET) - NEW
    // Returns authoritative plan/credits & validates session
    // -------------------------
    if (action === 'profile') {
      if (req.method !== 'GET') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });
      // Session validation handled by middleware above

      const planDetails = {
        planName: client.planName ||
          null,
        clientName: client.clientName || client.username ||
          null,
        username: client.username ||
          null,
        email: client.email ||
          null,
        mobile: client.mobile ||
          null,
        bulkAccessCode: client.bulkAccessCode ||
          null,
        initialCredits: client.initialCredits ??
          null,
        remainingCredits: client.remainingCredits ??
          null,
        validityEnd: client.validityEnd ??
          null,
        isActive: client.isActive
      };
      return sendJSON(res, 200, { status: 'Success', planDetails });
    }
    
    // -------------------------
    // ACTION: active-jobs (GET) - NEW (Requirement 3 helper)
    // -------------------------
    if (action === 'active-jobs') {
        if (req.method !== 'GET') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });
        try {
            const activeJobsCount = await bulkJobs.countDocuments({ 
                // Use the string ID for bulkJobs, which matches the format stored on job creation
                clientId: clientIdString, 
                status: { $in: ['Queued', 'In Progress'] } 
          
            });

            return sendJSON(res, 200, { status: 'Success', activeJobsCount });
        } catch (e) {
            console.error('Error fetching active job count:', e);
            return sendJSON(res, 500, { status: 'Error', message: 'Internal server error fetching job count.' });
        }
    }

    // -------------------------
    // ACTION: deduction-history (GET) - FIXED
    // Fetches completed bulk verification jobs for deduction history display
    // -------------------------
    if (action === 'deduction-history') {
        if (req.method !== 'GET') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });
        try {
            // Fetch jobs that are completed, failed, or cancelled for a full history,
            // ordered by submission time.
            const historyJobs = await bulkJobs.find({ 
                clientId: clientIdString, 
                status: { $in: ['Completed', 'Failed', 'Cancelled'] } 
            })
            .sort({ completedTime: -1, submittedAt: -1 }) // Sort by newest completed jobs first, then submitted time
            .limit(100) // Limit to a manageable number for 
            .project({ // Select only necessary fields to reduce payload size
              _id: 1,
              filename: 1,
              submittedAt: 1,
              completedTime: 1,
              totalRows: 1,
              status: 1,
              error: 1,
            })
            .toArray();
            return sendJSON(res, 200, { status: 'Success', history: historyJobs });
        } catch (e) {
            console.error('Error fetching deduction history:', e);
            return sendJSON(res, 500, { status: 'Error', message: 'Internal server error fetching history.' });
        }
    }


    // -------------------------
    // ACTION: remaining-credits (GET) - NEW (Optional helper for UI polling)
    // -------------------------
    if (action === 'remaining-credits') {
        if (req.method !== 'GET') return sendJSON(res, 405, { status: 'Error', message: 'Method Not Allowed' });
        return sendJSON(res, 200, { 
            status: 'Success', 
            remainingCredits: client.remainingCredits ?? null 
        });
    }

    // no action matched
    return sendJSON(res, 400, { status: 'Error', message: 'Unknown action. Use ?action=login|logout|activity|profile|update-password|active-jobs|remaining-credits.' });
  } catch (err) {
    console.error('UNCAUGHT in /api/client/index.js', err && (err.stack || err.message));
    return sendJSON(res, 500, { status: 'Error', message: 'Internal server error' });
  }
};