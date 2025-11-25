// api/client/activity.js
// Endpoint for client dashboard to send a heartbeat, updating their lastActivityAt timestamp.

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb');

// 🚨 FIX: Define the JWT_SECRET using the exact same fallback as the login file
const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret_for_dev_only';

// Helper to get client ID from JWT
function getClientId(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    if (!token) return null;
    try {
        // Use the consistent JWT_SECRET variable for verification
        const payload = jwt.verify(token, JWT_SECRET);
        // Assuming client IDs are stored as ObjectId strings
        return payload.id.toString(); 
    } catch (err) {
        console.warn("JWT Verification Failed in activity.js:", err.message);
        return null;
    }
}

module.exports = async (req, res) => {
    // CORS Setup
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });

    const clientId = getClientId(req);

    if (!clientId) {
        // 401 Unauthorized status is crucial for the client-side script to force a logout
        return res.status(401).json({ status: "Error", message: "Authentication required." });
    }

    let db;
    try {
        db = (await connectToDatabase()).db;
    } catch (e) {
        return res.status(500).json({ status: "Error", message: "Database connection failed." });
    }
    
    const clientsCollection = db.collection("clients");
    const lastActivityAt = new Date();

    try {
        // Update the client's activity timestamp
        const result = await clientsCollection.updateOne(
            { _id: new ObjectId(clientId) },
            { $set: { lastActivityAt: lastActivityAt } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ status: "Error", message: "Client not found." });
        }

        return res.status(200).json({ status: "Success", message: "Activity updated.", timestamp: lastActivityAt });

    } catch (e) {
        console.error("Client Activity Update Error:", e);
        return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
    }
};