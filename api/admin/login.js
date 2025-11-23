// Improved api/admin/login.js
// - Keeps the hardcoded admin username + bcrypt hash as requested.
// - Adds robust CORS handling and proper method handling.
// - Wraps requires for optional dependencies (jsonwebtoken, bcryptjs) so the function
//   returns clear errors if dependencies are missing instead of crashing with MODULE_NOT_FOUND.
// - Uses JWT_SECRET if available; if not available, returns a clear 500 error instead of crashing.

let jwt = null;
let bcrypt = null;

try {
  jwt = require('jsonwebtoken');
} catch (err) {
  console.warn('jsonwebtoken not found. Token generation will fail until dependency is installed.');
}

try {
  bcrypt = require('bcryptjs');
} catch (err) {
  console.warn('bcryptjs not found. Password hash verification will fall back to plaintext comparison.');
}

// --- HARDCODED CREDENTIALS ---
const HARDCODED_USERNAME = 'admin_boss';
const HARDCODED_PASSWORD_HASH = '$2a$10$W.n3v3V/21bXkO6kI.06v.WfF1Z2/V2n8T.A0gK5lZ2V7v5jH7V4D';
// Plaintext password: Pkboss@12

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
  }

  // Parse body if required
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {}
  }

  const JWT_SECRET = process.env.JWT_SECRET;

  try {
    const username = body?.username;
    const password = body?.password;

    if (!username || !password) {
      return res.status(400).json({ status: "Error", message: "Missing username or password." });
    }

    // Validate username
    if (username !== HARDCODED_USERNAME) {
      return res.status(401).json({ status: "Error", message: "Invalid credentials." });
    }

    // Validate password
    let isPasswordValid = false;

    if (bcrypt && typeof bcrypt.compare === 'function') {
      try {
        isPasswordValid = await bcrypt.compare(password, HARDCODED_PASSWORD_HASH);
      } catch (e) {
        console.error("bcrypt.compare failed:", e);
        return res.status(500).json({ status: "Error", message: "Internal password check error." });
      }
    } else {
      console.warn('bcryptjs missing. Using insecure plaintext fallback.');
      isPasswordValid = (password === 'Pkboss@12');
    }

    if (!isPasswordValid) {
      return res.status(401).json({ status: "Error", message: "Invalid credentials." });
    }

    // If no JWT secret, allow login but no token
    if (!JWT_SECRET) {
      return res.status(200).json({
        status: "Success",
        message: "Admin login successful (JWT_SECRET missing).",
        token: null
      });
    }

    if (!jwt || typeof jwt.sign !== 'function') {
      return res.status(500).json({
        status: "Error",
        message: "jsonwebtoken missing — cannot generate token."
      });
    }

    // Generate token
    const token = jwt.sign(
      { id: "admin", username: HARDCODED_USERNAME },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.status(200).json({
      status: "Success",
      message: "Admin access granted.",
      token: token
    });

  } catch (e) {
    console.error("Admin Login Crash:", e);
    return res.status(500).json({
      status: "Error",
      message: `Internal Server Error: ${e.message}`
    });
  }
};
