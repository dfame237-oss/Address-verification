// api/admin/client.js  (updated, same behavior, better logging & JWT_SECRET handling)

const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb');

// IMPORTANT: require JWT_SECRET in environment to validate tokens reliably
const JWT_SECRET = process.env.JWT_SECRET;

function checkAdminAuth(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    if (!token) {
        // No token present
        return { ok: false, reason: 'no_token' };
    }
    if (!JWT_SECRET) {
        // Server misconfiguration
        return { ok: false, reason: 'missing_jwt_secret' };
    }
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        return { ok: true, payload };
    } catch (err) {
        // Provide the error type so runtime logs are helpful
        const reason = (err && err.name) ? err.name : 'token_verify_error';
        return { ok: false, reason };
    }
}

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // --- Authorization check with improved diagnostics ---
    const authCheck = checkAdminAuth(req);
    if (!authCheck.ok) {
        // Log useful info to Vercel logs for debugging
        console.error('Unauthorized request to /api/admin/client:', authCheck.reason);
        if (authCheck.reason === 'missing_jwt_secret') {
            return res.status(500).json({ status: "Error", message: "Server configuration error: JWT_SECRET is not set." });
        }
        // Token absent/invalid/expired
        return res.status(403).json({ status: "Error", message: "Forbidden: Not authenticated or token expired." });
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

    // Ensure JSON body is parsed (some runtimes provide string body)
    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { /* keep original */ }
    }

    // --- POST: Add New Client ---
    if (req.method === 'POST') {
        const { clientName, username, password, mobile, email, businessName, businessType, planName, validity } = body || {};
        
        if (!username || !password || !planName || !validity) {
            return res.status(400).json({ status: "Error", message: "Missing required fields." });
        }
        
        try {
            // Check if username already exists
            if (await clientsCollection.findOne({ username })) {
                return res.status(409).json({ status: "Error", message: "Username already exists." });
            }

            // Hash password
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

    // --- GET: List clients ---
    if (req.method === 'GET') {
        try {
            const clients = await clientsCollection.find({}).project({ passwordHash: 0 }).toArray();
            return res.status(200).json({ status: "Success", data: clients });
        } catch (e) {
            console.error("GET /api/admin/client error:", e);
            return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
        }
    }

    // --- PUT ---
    if (req.method === 'PUT') {
        const { clientId, ...updateFields } = body || {};
        if (!clientId) return res.status(400).json({ status: "Error", message: "Client ID is required for update." });

        try {
            const updateDoc = {};
            if (updateFields.password) {
                updateDoc.passwordHash = await bcrypt.hash(updateFields.password, 10);
                delete updateFields.password;
            }
            if (updateFields.validity) {
                updateFields.validityEnd = new Date(updateFields.validity);
                delete updateFields.validity;
            }
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

    // --- DELETE ---
    if (req.method === 'DELETE') {
        const { clientId } = body || {};
        if (!clientId) return res.status(400).json({ status: "Error", message: "Client ID is required for deletion." });

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
