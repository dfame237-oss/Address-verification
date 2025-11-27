// api/admin/topup.js
// Admin endpoint to add or set remainingCredits for a client.
// POST body: { clientId, action: 'add'|'set', addCredits: Number } OR { clientId, action: 'set', remainingCredits: 'Unlimited' }

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';

function checkAdminAuth(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const token = authHeader?.split(' ')[1];
  if (!token || !JWT_SECRET) return { ok: false, reason: 'unauthorized' };
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return { ok: false, reason: 'not_admin' };
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: 'token_verify_error' };
  }
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });

  const auth = checkAdminAuth(req);
  if (!auth.ok) return res.status(403).json({ status: 'Error', message: 'Admin access required.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {}
  }

  const { clientId, action, addCredits, remainingCredits } = body || {};
  if (!clientId || !action) return res.status(400).json({ status: 'Error', message: 'clientId and action are required.' });

  let db;
  try {
    const dbRes = await connectToDatabase();
    db = dbRes.db;
  } catch (e) {
    console.error('DB connection failed in /api/admin/topup:', e);
    return res.status(500).json({ status: 'Error', message: 'Database connection failed.' });
  }

  const clients = db.collection('clients');

  try {
    const clientObjId = new ObjectId(clientId);
    if (action === 'add') {
      const n = Number(addCredits || 0);
      if (isNaN(n) || n <= 0) return res.status(400).json({ status: 'Error', message: 'Invalid addCredits' });
      const result = await clients.updateOne({ _id: clientObjId }, { $inc: { remainingCredits: n } });
      if (result.matchedCount === 0) return res.status(404).json({ status: 'Error', message: 'Client not found' });
      return res.status(200).json({ status: 'Success', message: 'Credits added.' });
    } else if (action === 'set') {
      // Set remainingCredits either to a number or 'Unlimited'
      const newVal = (typeof remainingCredits === 'string' && remainingCredits.toLowerCase() === 'unlimited') ? 'Unlimited' : Number(remainingCredits);
      if (newVal !== 'Unlimited' && (isNaN(newVal) || newVal < 0)) return res.status(400).json({ status: 'Error', message: 'Invalid remainingCredits' });
      const result = await clients.updateOne({ _id: clientObjId }, { $set: { remainingCredits: newVal } });
      if (result.matchedCount === 0) return res.status(404).json({ status: 'Error', message: 'Client not found' });
      return res.status(200).json({ status: 'Success', message: 'remainingCredits set.' });
    } else {
      return res.status(400).json({ status: 'Error', message: 'Invalid action. Use add or set.' });
    }
  } catch (e) {
    console.error('Error in /api/admin/topup:', e);
    return res.status(500).json({ status: 'Error', message: 'Internal Server Error' });
  }
};
