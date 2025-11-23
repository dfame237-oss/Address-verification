// Address-verification-main/api/admin/client.js

const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb'); // Needed for finding/deleting/updating by ID

// Vercel Environment Variable for JWT signing
const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret_for_dev_only';

// Helper function to check for admin authorization (simple token check)
function checkAdminAuth(req) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    
    try { 
        // Verify the token using the same secret used in admin/login.js
        return jwt.verify(token, JWT_SECRET); 
    } catch (e) { 
        return null; 
    }
}

module.exports = async (req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // 1. Authorization Check
    if (!checkAdminAuth(req)) {
        return res.status(403).json({ status: "Error", message: "Forbidden: Not authenticated or token expired." });
    }

    // Connect to database once
    let db;
    try {
        const dbResult = await connectToDatabase();
        db = dbResult.db;
    } catch (e) {
        return res.status(500).json({ status: "Error", message: "Database connection failed." });
    }
    const clientsCollection = db.collection("clients");

    // --- POST: Add a New Client ---
    if (req.method === 'POST') {
        const { clientName, username, password, mobile, email, businessName, businessType, planName, validity } = req.body;
        
        if (!username || !password || !planName || !validity) {
            return res.status(400).json({ status: "Error", message: "Missing required fields." });
        }
        
        try {
            // Check if username already exists
            if (await clientsCollection.findOne({ username })) {
                return res.status(409).json({ status: "Error", message: "Username already exists." });
            }

            // Hash the password before storing
            const hashedPassword = await bcrypt.hash(password, 10);
            
            const newClient = {
                clientName: clientName || null,
                username: username,
                passwordHash: hashedPassword,
                mobile: mobile || null,
                email: email || null,
                businessName: businessName || null,
                businessType: businessType || null,
                planName: planName,
                validityEnd: new Date(validity), // Convert validity string to Date object
                isActive: true, // Default to active
                bulkAccessCode: Math.random().toString(36).substring(2, 8).toUpperCase(), // Simple unique code
                createdAt: new Date(),
            };

            const result = await clientsCollection.insertOne(newClient);

            return res.status(201).json({ 
                status: "Success", 
                message: "Client added successfully.", 
                clientId: result.insertedId 
            });

        } catch (e) {
            console.error("POST /api/admin/client error:", e);
            return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
        }
    }
    
    // --- GET: List All Clients ---
    if (req.method === 'GET') {
        try {
            // Fetch all clients, excluding the password hash for security
            const clients = await clientsCollection.find({})
                .project({ passwordHash: 0 }) 
                .toArray();

            return res.status(200).json({ status: "Success", data: clients });

        } catch (e) {
            console.error("GET /api/admin/client error:", e);
            return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
        }
    }
    
    // --- PUT: Update Existing Client ---
    if (req.method === 'PUT') {
        const { clientId, ...updateFields } = req.body;
        
        if (!clientId) {
            return res.status(400).json({ status: "Error", message: "Client ID is required for update." });
        }
        
        try {
            const updateDoc = {};
            if (updateFields.password) {
                // Hash new password if provided
                updateDoc.passwordHash = await bcrypt.hash(updateFields.password, 10);
                delete updateFields.password;
            }
            if (updateFields.validity) {
                // Convert validity string to Date
                updateFields.validityEnd = new Date(updateFields.validity);
                delete updateFields.validity;
            }
            // Merge remaining fields into the update object
            Object.assign(updateDoc, updateFields);
            
            const result = await clientsCollection.updateOne(
                { _id: new ObjectId(clientId) },
                { $set: updateDoc }
            );
            
            if (result.matchedCount === 0) {
                return res.status(404).json({ status: "Error", message: "Client not found." });
            }

            return res.status(200).json({ status: "Success", message: "Client updated successfully." });
        } catch (e) {
            console.error("PUT /api/admin/client error:", e);
            return res.status(500).json({ status: "Error", message: `Update failed: ${e.message}` });
        }
    }
    
    // --- DELETE: Remove Client ---
    if (req.method === 'DELETE') {
        const { clientId } = req.body;
        
        if (!clientId) {
            return res.status(400).json({ status: "Error", message: "Client ID is required for deletion." });
        }
        
        try {
            const result = await clientsCollection.deleteOne({ _id: new ObjectId(clientId) });

            if (result.deletedCount === 0) {
                return res.status(404).json({ status: "Error", message: "Client not found." });
            }

            return res.status(200).json({ status: "Success", message: "Client deleted successfully." });

        } catch (e) {
            console.error("DELETE /api/admin/client error:", e);
            return res.status(500).json({ status: "Error", message: `Deletion failed: ${e.message}` });
        }
    }
    
    res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
};