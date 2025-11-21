// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const db = require('./db/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// serve static files (your existing public folder)
app.use(express.static(path.join(__dirname, 'public')));

// --- helpers ---
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authAdminMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/, '');
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const adminRow = db.prepare('SELECT id, username FROM admin WHERE username = ?').get(decoded.username);
    if (!adminRow) return res.status(401).json({ error: 'Invalid token user' });
    req.admin = adminRow;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Admin login ---
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const row = db.prepare('SELECT id, username, password_hash FROM admin WHERE username = ?').get(username);
  if (!row) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, row.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ id: row.id, username: row.username, role: 'admin' });
  res.json({ token, username: row.username });
});

// --- Clients CRUD ---
app.get('/api/admin/list-clients', authAdminMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id, name, username, mobile, email, business_name, business_type, plan_name, validity_end, enabled, created_at FROM clients').all();
  res.json({ clients: rows });
});

app.post('/api/admin/add-client', authAdminMiddleware, async (req, res) => {
  const {
    name, username, password, mobile, email, business_name, business_type, plan_name, validity_end
  } = req.body || {};

  if (!username || !password || !name) return res.status(400).json({ error: 'name, username and password required' });

  const password_hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const created_at = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO clients (id,name,username,password_hash,mobile,email,business_name,business_type,plan_name,validity_end,enabled,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, username, password_hash, mobile, email, business_name, business_type, plan_name, validity_end, 1, created_at);

    res.json({ ok: true, id });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'username already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/admin/update-client', authAdminMiddleware, (req, res) => {
  const { id, enabled, plan_name, validity_end, password } = req.body || {};
  if (!id) return res.status(400).json({ error: 'client id required' });

  const current = db.prepare('SELECT id FROM clients WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'client not found' });

  if (password) {
    // update password too
    bcrypt.hash(password, 10).then(ph => {
      db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(ph, id);
    }).catch(err => console.error(err));
  }

  db.prepare('UPDATE clients SET enabled = COALESCE(?, enabled), plan_name = COALESCE(?, plan_name), validity_end = COALESCE(?, validity_end) WHERE id = ?')
    .run(enabled === undefined ? null : (enabled ? 1 : 0), plan_name || null, validity_end || null, id);

  res.json({ ok: true });
});

// --- Delete client ---
app.post('/api/admin/remove-client', authAdminMiddleware, (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'client id required' });
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Support messages ---
app.post('/api/contact', (req, res) => {
  const { name, email, mobile, message, client_id } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const id = uuidv4();
  const created_at = new Date().toISOString();
  db.prepare('INSERT INTO support_messages (id,client_id,name,email,mobile,message,created_at,resolved) VALUES (?,?,?,?,?,?,?,0)')
    .run(id, client_id || null, name || null, email || null, mobile || null, message, created_at);

  res.json({ ok: true, id });
});

app.get('/api/admin/support/messages', authAdminMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM support_messages ORDER BY created_at DESC').all();
  res.json({ messages: rows });
});

// --- Simple verify-bulk stub (expects client username or api_key) ---
app.post('/api/verify-bulk', (req, res) => {
  // This is a stub: check client status and return requiresPurchase if not allowed.
  // Expect body: { client_username: "abc", rows: 100 } or provide client_id
  const { client_username } = req.body || {};
  if (!client_username) return res.status(400).json({ error: 'client_username required' });

  const client = db.prepare('SELECT id, username, enabled, validity_end, plan_name FROM clients WHERE username = ?').get(client_username);
  if (!client) return res.json({ requiresPurchase: true, reason: 'client not found' });

  if (!client.enabled) return res.json({ requiresPurchase: true, reason: 'client disabled' });

  const now = new Date();
  const validUntil = client.validity_end ? new Date(client.validity_end) : null;
  if (!validUntil || validUntil < now) return res.json({ requiresPurchase: true, reason: 'plan expired' });

  // allowed: in a real implementation we'd process CSV and return results
  res.json({ requiresPurchase: false, message: 'allowed to process bulk' });
});

// Optionally mount your existing serverless verify single logic if you have it in api/verify-single-address.js
// If that file exports a function like module.exports = (req,res)=>{...}, you can require and use it:
// const verifySingle = require('./api/verify-single-address');
// app.post('/api/verify-single-address', verifySingle);

// fallback
app.get('*', (req, res) => {
  // let static middleware handle it; otherwise 404
  res.status(404).json({ error: 'not found' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
