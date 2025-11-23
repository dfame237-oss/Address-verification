// Address-verification-main/api/admin/login.js

const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcryptjs'); // Must be used to check the hardcoded hash!

// --- HARDCODED CREDENTIALS (INSECURE BUT SIMPLE) ---
// WARNING: Since this is in the source code, DO NOT use a real password.
const HARDCODED_USERNAME = 'admin_boss';
const HARDCODED_PASSWORD_HASH = '$2a$10$W.n3v3V/21bXkO6kI.06v.WfF1Z2/V2n8T.A0gK5lZ2V7v5jH7V4D'; 
// HASH is for the plaintext password: Pkboss@12
// -----------------------------------------------------

// JWT Secret still required for token generation (MUST be set in Vercel ENVs)
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async (req, res) => {
    // CORS Headers... (omitted for brevity, assume correct)

    if (req.method === 'OPTIONS') { return res.status(200).end(); }
    if (req.method !== 'POST') { return res.status(405).json({ status: "Error", error: 'Method Not Allowed' }); }

    // CRITICAL CHECK: We still need the JWT_SECRET to generate a secure token
    if (!JWT_SECRET) {
        return res.status(500).json({ status: "Error", message: "Server configuration error: JWT_SECRET missing in Vercel ENVs." });
    }

    try {
        const { username, password } = req.body;
        
        // 1. Check Username
        if (username !== HARDCODED_USERNAME) {
            return res.status(401).json({ status: "Error", message: "Invalid credentials." });
        }
        
        // 2. Check Password Hash
        // This requires the bcryptjs package to be bundled.
        const isPasswordValid = await bcrypt.compare(password, HARDCODED_PASSWORD_HASH);

        if (!isPasswordValid) {
            return res.status(401).json({ status: "Error", message: "Invalid credentials." });
        }
        
        // 3. Generate JWT Token
        const token = jwt.sign(
            { id: 'admin', username: HARDCODED_USERNAME }, 
            JWT_SECRET, 
            { expiresIn: '1h' }
        );

        return res.status(200).json({ 
            status: "Success", 
            message: "Admin access granted.",
            token: token 
        });
        
    } catch (e) {
        console.error("Admin Login Crash:", e);
        // This crash indicates that bcryptjs failed to bundle.
        return res.status(500).json({ status: "Error", message: `Internal Server Error: Dependency failure (bcryptjs/jsonwebtoken).` });
    }
};