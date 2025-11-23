// api/admin/login.js
// Final admin login handler:
// - Prefer environment-provided credentials (ADMIN_USERNAME & ADMIN_PLAINTEXT_PASSWORD).
// - Fallback to original hardcoded bcrypt hash if envs are not set.
// - Returns a JWT when JWT_SECRET is present and jsonwebtoken is installed.
// - Robust CORS, body parsing, and clear error responses.

let jwt = null;
let bcrypt = null;

try {
  jwt = require('jsonwebtoken');
} catch (err) {
  console.warn('jsonwebtoken not installed. Token generation will be disabled until installed.');
}

try {
  bcrypt = require('bcryptjs');
} catch (err) {
  console.warn('bcryptjs not installed. Password hash verification will fallback to plaintext if env password is provided.');
}

// Fallback hardcoded credentials (kept for backward compatibility)
const HARDCODED_USERNAME = 'admin_boss';
const HARDCODED_PASSWORD_HASH = '$2a$10$W.n3v3V/21bXkO6kI.06v.WfF1Z2/V2n8T.A0gK5lZ2V7v5jH7V4D'; // plaintext: Pkboss@12

module.exports = async (req, res) => {
  // Standard CORS for simple admin app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });

  // Parse body safely (some runtimes give string)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { /* ignore */ }
  }

  const JWT_SECRET = process.env.JWT_SECRET;
  const envAdminUsername = process.env.ADMIN_USERNAME;
  const envAdminPlaintext = process.env.ADMIN_PLAINTEXT_PASSWORD;

  try {
    const username = body?.username;
    const password = body?.password;

    if (!username || !password) {
      return res.status(400).json({ status: "Error", message: "Missing username or password." });
    }

    // 1) If env-provided credentials exist, prefer them (plaintext compare)
    if (envAdminUsername && envAdminPlaintext) {
      if (username !== envAdminUsername || password !== envAdminPlaintext) {
        return res.status(401).json({ status: "Error", message: "Invalid credentials." });
      }
      // Auth succeeded via env credentials
      if (!JWT_SECRET) {
        return res.status(200).json({
          status: "Success",
          message: "Admin login successful (JWT_SECRET missing).",
          token: null
        });
      }
      if (!jwt || typeof jwt.sign !== 'function') {
        return res.status(500).json({ status: "Error", message: "jsonwebtoken missing — cannot generate token." });
      }
      const token = jwt.sign({ id: "admin", username: envAdminUsername }, JWT_SECRET, { expiresIn: "1h" });
      return res.status(200).json({ status: "Success", message: "Admin access granted.", token });
    }

    // 2) Otherwise fallback to hardcoded username + bcrypt-hash
    if (username !== HARDCODED_USERNAME) {
      return res.status(401).json({ status: "Error", message: "Invalid credentials." });
    }

    let isPasswordValid = false;

    if (bcrypt && typeof bcrypt.compare === 'function') {
      try {
        isPasswordValid = await bcrypt.compare(password, HARDCODED_PASSWORD_HASH);
      } catch (e) {
        console.error('bcrypt.compare failed:', e);
        return res.status(500).json({ status: "Error", message: "Internal password check error." });
      }
    } else {
      // No bcrypt available. Fallback (insecure) to known plaintext password for testing:
      // Plaintext: Pkboss@12
      console.warn('bcryptjs not available and no env password provided — using insecure fallback plaintext compare.');
      isPasswordValid = (password === 'Pkboss@12');
    }

    if (!isPasswordValid) {
      return res.status(401).json({ status: "Error", message: "Invalid credentials." });
    }

    // Generate JWT if configured
    if (!JWT_SECRET) {
      return res.status(200).json({
        status: "Success",
        message: "Admin login successful (JWT_SECRET missing).",
        token: null
      });
    }

    if (!jwt || typeof jwt.sign !== 'function') {
      return res.status(500).json({ status: "Error", message: "jsonwebtoken missing — cannot generate token." });
    }

    const token = jwt.sign({ id: "admin", username: HARDCODED_USERNAME }, JWT_SECRET, { expiresIn: "1h" });
    return res.status(200).json({ status: "Success", message: "Admin access granted.", token });

  } catch (e) {
    console.error('Admin Login Crash:', e);
    return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
  }
};
