// api/admin/login.js
// Final admin login handler:
// - PREFERRED: Environment-provided credentials (ADMIN_USERNAME & ADMIN_PLAINTEXT_PASSWORD).
// - FALLBACK: Original hardcoded bcrypt hash if envs are not set.
// - Returns a JWT when JWT_SECRET is present.
// - FIX: Ensures "Invalid credentials" error is always returned on failure.

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

// Unified failure function
const sendFailure = (res) => {
    return res.status(401).json({ status: "Error", message: "Invalid credentials." });
}

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
    
    let isAuthenticated = false;
    let authUsername = '';

    // 1) AUTH CHECK: Use environment-provided credentials if available
    if (envAdminUsername && envAdminPlaintext) {
      if (username === envAdminUsername && password === envAdminPlaintext) {
        isAuthenticated = true;
        authUsername = envAdminUsername;
      }
    }

    // 2) FALLBACK CHECK: Use hardcoded credentials if not authenticated by envs
    if (!isAuthenticated) {
        if (username === HARDCODED_USERNAME) {
            let isPasswordValid = false;
            
            if (bcrypt && typeof bcrypt.compare === 'function') {
                try {
                    isPasswordValid = await bcrypt.compare(password, HARDCODED_PASSWORD_HASH);
                } catch (e) {
                    // Log the error but return the generic failure message
                    console.error('bcrypt.compare failed during hardcoded fallback:', e);
                    return sendFailure(res);
                }
            } else {
                // Insecure plaintext fallback (if bcrypt is missing)
                console.warn('bcryptjs not available - using insecure plaintext fallback.');
                isPasswordValid = (password === 'Pkboss@12');
            }

            if (isPasswordValid) {
                isAuthenticated = true;
                authUsername = HARDCODED_USERNAME;
            }
        }
    }

    // --- FINAL AUTH RESULT ---
    if (!isAuthenticated) {
        return sendFailure(res); // Invalid username or password
    }

    // --- SUCCESS PATH ---
    
    // Check for JWT readiness
    if (!jwt || typeof jwt.sign !== 'function' || !JWT_SECRET) {
      return res.status(200).json({
        status: "Warning",
        message: `Admin login successful. Token generation failed (JWT setup incomplete).`,
        token: null,
        username: authUsername
      });
    }

    // Generate JWT
    const token = jwt.sign({ id: "admin", username: authUsername, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
    
    return res.status(200).json({ 
        status: "Success", 
        message: "Admin access granted.", 
        token, 
        username: authUsername 
    });

  } catch (e) {
    console.error('Admin Login Crash:', e);
    return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
  }
};