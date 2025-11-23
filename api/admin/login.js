// Address-verification-main/api/admin/login.js

const jwt = require('jsonwebtoken'); 
// NOTE: We rely only on ENV variables and JWT, not MongoDB, for core Admin Login stability.

// Vercel Environment Variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME; 
const CORRECT_PASSWORD = process.env.ADMIN_PLAINTEXT_PASSWORD; 
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async (req, res) => {
    // 1. CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
    }

    if (!ADMIN_USERNAME || !CORRECT_PASSWORD || !JWT_SECRET) {
        // If secrets are missing, report an error, though Vercel should have crashed earlier.
        return res.status(500).json({ status: "Error", message: "Server configuration error: Admin credentials or JWT secret missing." });
    }

    try {
        const { username, password } = req.body;
        
        // 2. Simple String Comparison (Using Vercel ENV variables)
        if (username === ADMIN_USERNAME && password === CORRECT_PASSWORD) {
            
            // 3. Generate a JWT Token
            const token = jwt.sign(
                { id: 'admin', username: ADMIN_USERNAME }, 
                JWT_SECRET, 
                { expiresIn: '1h' } // Token expires in 1 hour
            );

            return res.status(200).json({ 
                status: "Success", 
                message: "Admin access granted.",
                token: token 
            });
        } else {
            return res.status(401).json({ status: "Error", message: "Invalid credentials." });
        }
        
    } catch (e) {
        console.error("Admin Login Server Error:", e);
        return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
    }
};