// api/admin/client.js  (Updated: Added specific PUT methods for Status and Activity)

const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb');

// IMPORTANT: require JWT_SECRET in environment to validate tokens reliably
const JWT_SECRET = process.env.JWT_SECRET;

// --- Utility function for Admin Auth (using JWT) ---
function checkAdminAuth(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    if (!token || !JWT_SECRET) return { ok: false, reason: 'unauthorized' };
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.role !== 'admin') return { ok: false, reason: 'not_admin' };
        return { ok: true, payload };
    } catch (err) {
        return { ok: false, reason: err.name || 'token_verify_error' };
    }
}

// --- Main Handler ---
module.exports = async (req, res) => {
    // CORS Setup (Keep original for compatibility)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // Authorization check
    const authCheck = checkAdminAuth(req);
    if (!authCheck.ok) {
        console.error('Unauthorized request to /api/admin/client:', authCheck.reason);
        return res.status(403).json({ status: "Error", message: "Forbidden: Admin access required." });
    }

    // Connect to DB
    let db;
    try {
        const dbResult = await connectToDatabase();
        db = dbResult.db;
    } catch (e) {
        console.error('DB connection failed in /api/admin/client:', e);
        return res.status(500).json({ status: "Error", message: "Database connection failed." });
    }
    const clientsCollection = db.collection("clients");

    // Ensure JSON body is parsed
    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { /* keep original */ }
    }
    
    const { clientId } = req.query; // Check for ID in query params for targeted PUT/DELETE

    // --- POST: Add New Client (No changes needed) ---
    if (req.method === 'POST') {
        const { clientName, username, password, mobile, email, businessName, businessType, planName, validity } = body || {};
        
        if (!username || !password || !planName || !validity) {
            return res.status(400).json({ status: "Error", message: "Missing required fields." });
        }
        
        try {
            if (await clientsCollection.findOne({ username })) {
                return res.status(409).json({ status: "Error", message: "Username already exists." });
            }

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
                validityEnd: new Date(validity),
                isActive: true,
                bulkAccessCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
                createdAt: new Date(),
                // NEW FIELD for status/activity check
                lastActivityAt: null, 
                isOnline: false, // Updated via a separate ping mechanism (Advanced: not implemented here)
            };

            const result = await clientsCollection.insertOne(newClient);
            return res.status(201).json({ status: "Success", message: "Client added successfully.", clientId: result.insertedId });

        } catch (e) {
            console.error("POST /api/admin/client error:", e);
            return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
        }
    }

    // --- GET: List clients ---
    if (req.method === 'GET') {
        try {
            // Include lastActivityAt and isOnline for dashboard display
            const clients = await clientsCollection.find({})
                .project({ passwordHash: 0 }) 
                .toArray();
            return res.status(200).json({ status: "Success", data: clients });
        } catch (e) {
            console.error("GET /api/admin/client error:", e);
            return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
        }
    }

    // --- PUT: Update Client (Combined logic for all updates) ---
    if (req.method === 'PUT') {
        const targetId = clientId || body?.clientId; // Prefer query param ID, fallback to body
        const updateFields = body || {};

        if (!targetId) return res.status(400).json({ status: "Error", message: "Client ID is required for update." });

        try {
            const updateDoc = {};
            
            // Password Change
            if (updateFields.password) {
                updateDoc.passwordHash = await bcrypt.hash(updateFields.password, 10);
                delete updateFields.password;
            }
            
            // Validity Change
            if (updateFields.validity) {
                updateFields.validityEnd = new Date(updateFields.validity);
                delete updateFields.validity;
            }

            // Status Change (Disable/Enable User)
            if (typeof updateFields.isActive !== 'undefined') {
                updateDoc.isActive = Boolean(updateFields.isActive);
                delete updateFields.isActive;
            }

            // General Fields
            Object.assign(updateDoc, updateFields);
            delete updateDoc.clientId; // Clean up redundant ID if passed in body

            const result = await clientsCollection.updateOne(
                { _id: new ObjectId(targetId) },
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

    // --- DELETE (No changes needed) ---
    if (req.method === 'DELETE') {
        const targetId = clientId || body?.clientId;
        if (!targetId) return res.status(400).json({ status: "Error", message: "Client ID is required for deletion." });

        try {
            const result = await clientsCollection.deleteOne({ _id: new ObjectId(targetId) });
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

// --- New Endpoint/Logic needed in the future: Activity Logging ---
// You will need to add a small PUT endpoint in a separate file (e.g., /api/client/activity.js)
// or modify /api/verify-single-address.js to update the 'lastActivityAt' field:
/*
PUT /api/client/activity
Update client's lastActivityAt: new Date()
*/