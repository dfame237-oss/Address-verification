// api/client/logout.js
// Endpoint to set the client's activity status to 'offline' upon intentional logout.

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb');

// FIX: Define the JWT_SECRET using the exact same fallback for local development
const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret_for_dev_only';

// Helper to get client ID from JWT
function getClientId(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    if (!token) return null;
    try {
        // IMPORTANT: Use the consistent JWT_SECRET variable (which includes the fallback)
        const payload = jwt.verify(token, JWT_SECRET); 
        // Assuming client IDs are stored as ObjectId strings
        return payload.id.toString(); 
    } catch (err) {
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
        // If no valid token, just confirm the action completed (the user is effectively logged out)
        return res.status(200).json({ status: "Success", message: "User already logged out or token invalid." });
    }

    let db;
    try {
        db = (await connectToDatabase()).db;
    } catch (e) {
        return res.status(500).json({ status: "Error", message: "Database connection failed." });
    }
    
    const clientsCollection = db.collection("clients");

    try {
        // Critical Logout Logic: Set lastActivityAt to a historical time (e.g., 1 hour ago)
        // This ensures the Admin Dashboard immediately registers the client as 'Offline'
        const historicalTime = new Date(Date.now() - 3600000); 
        
        const objectId = new ObjectId(clientId);

        const result = await clientsCollection.updateOne(
            { _id: objectId },
            { $set: { lastActivityAt: historicalTime } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ status: "Error", message: "Client not found." });
        }

        return res.status(200).json({ status: "Success", message: "Logout activity recorded." });

    } catch (e) {
        console.error("Client Logout Update Error:", e);
        return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
    }
};