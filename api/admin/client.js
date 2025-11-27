// api/admin/client.js
// Updated to add initialCredits, remainingCredits, and admin controls (clear session, keep remaining credits)

const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';

// --- Utility function for Admin Auth (using JWT) ---
function checkAdminAuth(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const token = authHeader?.split(' ')[1];
  if (!token || !JWT_SECRET) return { ok: false, reason: 'unauthorized' };
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return { ok: false, reason: 'not_admin' };
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: err.name || 'token_verify_error' };
  }
}

// Helper: parse credits from frontend plan string format
// Expected planName examples: "Growth Starter_1180_1_Month_10,000" or "Enterprise Max_5000_12_Month_Unlimited"
function parseCreditsFromPlanValue(planValue) {
  if (!planValue || typeof planValue !== 'string') return null;
  const parts = planValue.split('_');
  // credits is expected to be the last part
  const rawCredits = parts[parts.length - 1] || '';
  if (!rawCredits) return null;
  // Normalize 'Unlimited' (case-insensitive)
  if (rawCredits.toLowerCase() === 'unlimited') return 'Unlimited';
  // Remove commas and parse int
  const numeric = parseInt(String(rawCredits).replace(/,/g, ''), 10);
  if (isNaN(numeric)) return null;
  return numeric;
}

// Safe function to coerce credits for storage/display
function normalizeCreditsForStorage(credits) {
  if (credits === 'Unlimited') return 'Unlimited';
  if (credits === null || credits === undefined) return 0;
  return Number(credits);
}

module.exports = async (req, res) => {
  // CORS Setup
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Authorization check
  const authCheck = checkAdminAuth(req);
  if (!authCheck.ok) {
    console.error('Unauthorized request to /api/admin/client:', authCheck.reason);
    return res.status(403).json({ status: 'Error', message: 'Forbidden: Admin access required.' });
  }

  // Connect to DB
  let db;
  try {
    const dbResult = await connectToDatabase();
    db = dbResult.db;
  } catch (e) {
    console.error('DB connection failed in /api/admin/client:', e);
    return res.status(500).json({ status: 'Error', message: 'Database connection failed.' });
  }

  const clientsCollection = db.collection('clients');

  // Ensure JSON body is parsed
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { /* keep original */ }
  }

  const { clientId } = req.query;

  // --- POST: Add New Client ---
  if (req.method === 'POST') {
    const {
      clientName,
      username,
      password,
      mobile,
      email,
      businessName,
      businessType,
      planName,
      validity
    } = body || {};

    if (!username || !password || !planName || !validity) {
      return res.status(400).json({ status: 'Error', message: 'Missing required fields.' });
    }

    try {
      if (await clientsCollection.findOne({ username })) {
        return res.status(409).json({ status: 'Error', message: 'Username already exists.' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      // Parse credits from planName string
      const parsedCredits = parseCreditsFromPlanValue(planName);
      const initialCredits = parsedCredits === 'Unlimited' ? 'Unlimited' : normalizeCreditsForStorage(parsedCredits);
      const remainingCredits = initialCredits === 'Unlimited' ? 'Unlimited' : initialCredits;

      const newClient = {
        clientName: clientName || null,
        username: username,
        passwordHash: hashedPassword,
        mobile: mobile || null,
        email: email || null,
        businessName: businessName || null,
        businessType: businessType || null,
        planName: planName,
        validityEnd: new Date(validity),
        isActive: true,
        bulkAccessCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
        createdAt: new Date(),
        // NEW fields
        lastActivityAt: null,
        isOnline: false,
        initialCredits,
        remainingCredits,
        activeSessionId: null,
      };

      const result = await clientsCollection.insertOne(newClient);
      return res.status(201).json({
        status: 'Success',
        message: 'Client added successfully.',
        clientId: result.insertedId,
        client: { ...newClient, _id: result.insertedId }
      });

    } catch (e) {
      console.error('POST /api/admin/client error:', e);
      return res.status(500).json({ status: 'Error', message: `Internal Server Error: ${e.message}` });
    }
  }

  // --- GET: List clients ---
  if (req.method === 'GET') {
    try {
      const clients = await clientsCollection.find({})
        .project({ passwordHash: 0 })
        .toArray();
      return res.status(200).json({ status: 'Success', data: clients });
    } catch (e) {
      console.error('GET /api/admin/client error:', e);
      return res.status(500).json({ status: 'Error', message: `Internal Server Error: ${e.message}` });
    }
  }

  // --- PUT: Update Client ---
  if (req.method === 'PUT') {
    const targetId = clientId || body?.clientId;
    const updateFields = body || {};

    if (!targetId) return res.status(400).json({ status: 'Error', message: 'Client ID is required for update.' });

    try {
      const clientObjectId = new ObjectId(targetId);
      const existingClient = await clientsCollection.findOne({ _id: clientObjectId });
      if (!existingClient) return res.status(404).json({ status: 'Error', message: 'Client not found.' });

      const updateDoc = {};

      // Password Change
      if (updateFields.password) {
        updateDoc.passwordHash = await bcrypt.hash(updateFields.password, 10);
        delete updateFields.password;
      }

      // Validity Change
      if (updateFields.validity) {
        updateDoc.validityEnd = new Date(updateFields.validity);
        delete updateFields.validity;
      }

      // Status Change (Disable/Enable User)
      if (typeof updateFields.isActive !== 'undefined') {
        updateDoc.isActive = Boolean(updateFields.isActive);
        delete updateFields.isActive;
      }

      // Admin request to clear active session for this client
      if (updateFields.clearSession === true) {
        updateDoc.activeSessionId = null;
        delete updateFields.clearSession;
      }

      // Handle plan changes and credits
      if (typeof updateFields.planName !== 'undefined' && updateFields.planName !== existingClient.planName) {
        const newPlanValue = updateFields.planName;
        const parsedCredits = parseCreditsFromPlanValue(newPlanValue);
        const newInitialCredits = parsedCredits === 'Unlimited' ? 'Unlimited' : normalizeCreditsForStorage(parsedCredits);

        updateDoc.planName = newPlanValue;

        // If admin explicitly requests to keep existing remainingCredits, do not reset remainingCredits.
        // Provide an option `keepRemainingCredits: true` in request body to preserve remaining credits.
        const keepRemaining = updateFields.keepRemainingCredits === true;
        delete updateFields.keepRemainingCredits;

        if (!keepRemaining) {
          updateDoc.initialCredits = newInitialCredits;
          updateDoc.remainingCredits = newInitialCredits === 'Unlimited' ? 'Unlimited' : newInitialCredits;
        } else {
          // Still update initialCredits so admin sees the new plan baseline, but preserve remainingCredits
          updateDoc.initialCredits = newInitialCredits;
        }
        delete updateFields.planName;
      }

      // Apply any other general fields
      Object.assign(updateDoc, updateFields);
      delete updateDoc.clientId;

      const result = await clientsCollection.updateOne(
        { _id: clientObjectId },
        { $set: updateDoc }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ status: 'Error', message: 'Client not found.' });
      }

      return res.status(200).json({ status: 'Success', message: 'Client updated successfully.' });

    } catch (e) {
      console.error('PUT /api/admin/client error:', e);
      return res.status(500).json({ status: 'Error', message: `Update failed: ${e.message}` });
    }
  }

  // --- DELETE ---
  if (req.method === 'DELETE') {
    const targetId = clientId || body?.clientId;
    if (!targetId) return res.status(400).json({ status: 'Error', message: 'Client ID is required for deletion.' });

    try {
      const result = await clientsCollection.deleteOne({ _id: new ObjectId(targetId) });
      if (result.deletedCount === 0) {
        return res.status(404).json({ status: 'Error', message: 'Client not found.' });
      }
      return res.status(200).json({ status: 'Success', message: 'Client deleted successfully.' });
    } catch (e) {
      console.error('DELETE /api/admin/client error:', e);
      return res.status(500).json({ status: 'Error', message: `Deletion failed: ${e.message}` });
    }
  }

  res.status(405).json({ status: 'Error', error: 'Method Not Allowed' });
};
