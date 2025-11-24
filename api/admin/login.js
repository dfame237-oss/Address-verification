// api/admin/login.js
// Secured admin login handler:
// - ONLY uses environment-provided credentials (ADMIN_USERNAME & ADMIN_PASSWORD_HASH).
// - REQUIRES 'bcryptjs' for secure password verification.

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
    // CRITICAL FAILURE: If bcrypt is missing, we cannot securely proceed.
    console.error('CRITICAL: bcryptjs is missing. Cannot verify password securely.');
    // We exit early or throw if the function runs, preventing insecure fallback.
    // In a serverless environment, this means the function will fail with a 500 error.
}

// Unified failure function: Always return a generic message to prevent username enumeration
const sendFailure = (res) => {
    return res.status(401).json({ status: "Error", message: "Invalid credentials." });
}

module.exports = async (req, res) => {
    // Standard CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });

    // Ensure bcrypt is available for secure operation
    if (!bcrypt || typeof bcrypt.compare !== 'function') {
        return res.status(500).json({ status: "Error", message: "Server dependency missing: bcryptjs. Cannot verify password securely." });
    }

    // Parse body safely
    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { /* ignore */ }
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    // Get SECURE environment variables
    const envAdminUsername = process.env.ADMIN_USERNAME;
    const envAdminPasswordHash = process.env.ADMIN_PASSWORD_HASH; // <-- We rely on the HASH here

    try {
        const username = body?.username;
        const password = body?.password;
        
        if (!username || !password) {
            return res.status(400).json({ status: "Error", message: "Missing username or password." });
        }
        
        // 1. Check for required environment variables
        if (!envAdminUsername || !envAdminPasswordHash) {
            console.error("ADMIN_USERNAME or ADMIN_PASSWORD_HASH environment variable is not set.");
            return res.status(500).json({ status: "Error", message: "Admin configuration error." });
        }

        let isAuthenticated = false;

        // 2. AUTH CHECK: Compare against secure hash
        if (username === envAdminUsername) {
            // Use bcrypt.compare() with the password and the HASH from environment variables
            isAuthenticated = await bcrypt.compare(password, envAdminPasswordHash);
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
                username: envAdminUsername
            });
        }

        // Generate JWT
        const token = jwt.sign({ id: "admin", username: envAdminUsername, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
        return res.status(200).json({ 
            status: "Success", 
            message: "Admin access granted.", 
            token, 
            username: envAdminUsername 
        });
    } catch (e) {
        console.error('Admin Login Crash:', e);
        return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
    }
};