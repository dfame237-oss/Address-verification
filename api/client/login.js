// Address-verification-main/api/client/login.js

const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret_for_dev_only';
// Helper function for unified failure message
const sendFailure = (res) => {
    return res.status(401).json({ status: "Error", message: "Invalid username or password." });
}


module.exports = async (req, res) => {
    // CORS Headers
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

    try {
        const { username, password } = req.body;
        const { db } = await connectToDatabase();
        const clientsCollection = db.collection("clients");

        // 1. Find the client by username
        const client = await clientsCollection.findOne({ username });

        if (!client) {
            return sendFailure(res); // Invalid username
        }

        // 2. Check the password against the stored hash
        const isPasswordValid = await bcrypt.compare(password, client.passwordHash);

        if (!isPasswordValid) {
            return sendFailure(res); // Invalid password
        }

        // --- FIX: Record Last Activity Time on Login ---
        const lastActivityAt = new Date();
        await clientsCollection.updateOne(
            { _id: client._id },
            { $set: { lastActivityAt: lastActivityAt } }
        );
        // --- END FIX ---
        
        // 3. Generate a JWT Token containing key plan info
        const token = jwt.sign(
            { 
                id: client._id, 
                username: client.username,
                // Add fields to payload that the dashboard will rely on
                clientName: client.clientName, 
                email: client.email,
                mobile: client.mobile,
                bulkAccessCode: client.bulkAccessCode,
                planName: client.planName,
                validityEnd: client.validityEnd,
                isActive: client.isActive
            }, 
            JWT_SECRET, 
            { expiresIn: '24h' } // Token expires in 24 hours
        );

        // 4. Return plan status and token to the frontend
        return res.status(200).json({ 
            status: "Success", 
            message: "Login successful.",
            token: token,
            // Return ALL relevant profile/plan details for localStorage caching
            planDetails: {
                clientName: client.clientName, 
                username: client.username,
                email: client.email,
                mobile: client.mobile,
                planName: client.planName,
                validityEnd: client.validityEnd,
                isActive: client.isActive,
                bulkAccessCode: client.bulkAccessCode,
            }
        });

    } catch (e) {
        console.error("Client Login Server Error:", e);
        return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
    }
};