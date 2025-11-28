// api/admin/index.js
// MASTER CONSOLIDATED ADMIN ROUTER: Handles Login, Client CRUD (List, Add, Update, Delete), Topup, and Support messages.

const { connectToDatabase } = require('../../utils/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb'); 

// --- CONSTANTS AND UTILITIES ---
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

// Admin Auth Helper (Consolidated from checkAdminAuth/getUserId)
function checkAdminAuth(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    if (!token || !JWT_SECRET) return { ok: false, reason: 'unauthorized' };
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        // Admin tokens must have role: "admin"
        if (payload.role !== 'admin') return { ok: false, reason: 'not_admin' };
        return { ok: true, payload };
    } catch (err) {
        return { ok: false, reason: err.name || 'token_verify_error' };
    }
}

// Helper: parse credits from frontend plan string format (Copied from admin/client.js)
function parseCreditsFromPlanValue(planValue) {
    if (!planValue || typeof planValue !== 'string') return null;
    const parts = planValue.split('_');
    const rawCredits = parts[parts.length - 1] || '';
    if (!rawCredits) return null;
    if (rawCredits.toLowerCase() === 'unlimited') return 'Unlimited';
    const numeric = parseInt(String(rawCredits).replace(/,/g, ''), 10);
    return isNaN(numeric) ? null : numeric;
}

// Helper: normalize credits (Copied from admin/client.js)
function normalizeCreditsForStorage(credits) {
    if (credits === 'Unlimited') return 'Unlimited';
    if (credits === null || credits === undefined) return 0;
    return Number(credits);
}

const sendFailure = (res) => {
    return res.status(401).json({ status: "Error", message: "Invalid credentials." });
}

// --- NEW UTILITY: Sends a system message to a client's inbox ---
async function sendSystemMessage(db, recipientId, subject, body) {
    if (!recipientId || !db) return;
    const messagesCollection = db.collection("messages");
    
    const newMessage = { 
        senderId: 'admin', // System generated message
        receiverId: recipientId.toString(), // Ensure it's a string ID
        subject: subject, 
        body: body, 
        isRead: false, 
        timestamp: new Date(), 
    }; 
    try {
        await messagesCollection.insertOne(newMessage);
    } catch (e) {
        console.error("Failed to send system message:", e);
    }
}
// --- END NEW UTILITY ---

module.exports = async (req, res) => {
    // CORS Setup
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = new URL(req.url, `http://${req.headers.host}`);
    const actionQ = url.searchParams.get('action');
    const action = actionQ ? actionQ.toLowerCase() : null;

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { /* keep original */ }
    }
    
    // --------------------------------------------------------
    // ACTION: LOGIN (from admin/login.js)
    // --------------------------------------------------------
    if (action === 'login') {
        if (req.method !== 'POST') return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
        if (!bcrypt) return res.status(500).json({ status: "Error", message: "Server dependency missing: bcryptjs." });

        const username = body?.username;
        const password = body?.password;
        
        if (!username || !password) return res.status(400).json({ status: "Error", message: "Missing username or password." });
        if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
            console.error("Admin credentials ENV variable is not set.");
            return res.status(500).json({ status: "Error", message: "Admin configuration error." });
        }

        try {
            let isAuthenticated = (username === ADMIN_USERNAME) ? await bcrypt.compare(password, ADMIN_PASSWORD_HASH) : false;
            
            if (!isAuthenticated) return sendFailure(res);

            if (!jwt || !JWT_SECRET) return res.status(200).json({ status: "Warning", message: "Login successful. Token generation failed." });

            const token = jwt.sign({ id: "admin", username: ADMIN_USERNAME, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
            return res.status(200).json({ status: "Success", message: "Admin access granted.", token, username: ADMIN_USERNAME });

        } catch (e) {
            console.error('Admin Login Crash:', e);
            return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
        }
    }
    // --- END LOGIN ---

    // --- ALL OTHER ACTIONS REQUIRE ADMIN JWT ---
    const authCheck = checkAdminAuth(req);
    if (!authCheck.ok) {
        console.error('Unauthorized request to /api/admin/index:', authCheck.reason);
        return res.status(403).json({ status: 'Error', message: 'Forbidden: Admin access required.' });
    }

    // Connect to DB (after auth check)
    let db;
    try {
        const dbResult = await connectToDatabase();
        db = dbResult.db;
    } catch (e) {
        console.error('DB connection failed in /api/admin/index:', e);
        return res.status(500).json({ status: 'Error', message: 'Database connection failed.' });
    }
    const clientsCollection = db.collection('clients');
    const supportCollection = db.collection("supportMessages"); 
    const { clientId, messageId } = req.query; // Destructure messageId here too

    // --------------------------------------------------------
    // ACTION: SUPPORT (GET / PUT / DELETE)
    // --------------------------------------------------------
    if (action === 'support') {
        if (req.method === 'GET') {
            try {
                const messages = await supportCollection.find({}).sort({ receivedAt: -1 }).toArray();
                const unreadCount = messages.filter(m => m.isRead === false).length;
                return res.status(200).json({ status: "Success", messages: messages, unreadCount: unreadCount });
            } catch (e) {
                console.error("Failed to retrieve support messages:", e);
                return res.status(500).json({ status: "Error", message: `Failed to retrieve support messages: ${e.message}` });
            }
        }
        if (req.method === 'PUT') {
            const messageId = req.query.messageId; 
            if (!messageId) return res.status(400).json({ status: "Error", message: "Message ID is required." });
            try {
                const result = await supportCollection.updateOne({ _id: new ObjectId(messageId) }, { $set: { isRead: true } });
                if (result.matchedCount === 0) return res.status(404).json({ status: "Error", message: "Message not found." });
                return res.status(200).json({ status: "Success", message: "Message marked as read." });
            } catch (e) {
                console.error("Failed to update support message status:", e);
                return res.status(500).json({ status: "Error", message: `Failed to update message status: ${e.message}` });
            }
        }
        // 🛑 DELETE handler for support messages
        if (req.method === 'DELETE') {
            if (!messageId) return res.status(400).json({ status: "Error", message: "Message ID is required for deletion." });
            try {
                const result = await supportCollection.deleteOne({ _id: new ObjectId(messageId) });
                if (result.deletedCount === 0) return res.status(404).json({ status: "Error", message: "Message not found." });
                return res.status(200).json({ status: "Success", message: "Support message deleted successfully." });
            } catch (e) {
                console.error('DELETE /api/admin/index (support) error:', e);
                return res.status(500).json({ status: 'Error', message: `Deletion failed: ${e.message}` });
            }
        }
        return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' });
    }

    // --------------------------------------------------------
    // ACTION: TOPUP (POST) - Consolidates admin/topup.js
    // --------------------------------------------------------
    if (action === 'topup') {
        if (req.method !== 'POST') return res.status(405).json({ status: 'Error', message: 'Method Not Allowed' });
        const { clientId, addCredits, remainingCredits } = body || {};
        if (!clientId) return res.status(400).json({ status: 'Error', message: 'clientId is required.' });

        try {
            const clientObjId = new ObjectId(clientId);
            let client = await clientsCollection.findOne({ _id: clientObjId });

            if (body.action === 'add') {
                const n = Number(addCredits || 0);
                if (isNaN(n) || n <= 0) return res.status(400).json({ status: 'Error', message: 'Invalid addCredits' });
                const result = await clientsCollection.updateOne({ _id: clientObjId }, { $inc: { remainingCredits: n } });
                if (result.matchedCount === 0) return res.status(404).json({ status: 'Error', message: 'Client not found' });
                
                client = await clientsCollection.findOne({ _id: clientObjId });
                // --- AUTO MESSAGE TRIGGER ---
                const systemSubject = "💰 Credits Added";
                const systemBody = `Your account was credited with ${n.toLocaleString()} new credits. Your new remaining balance is **${client.remainingCredits}** credits.`;
                await sendSystemMessage(db, clientId, systemSubject, systemBody);
                // --- END TRIGGER ---

                return res.status(200).json({ status: 'Success', message: 'Credits added.' });
            } else if (body.action === 'set') {
                const newVal = (typeof remainingCredits === 'string' && remainingCredits.toLowerCase() === 'unlimited') ? 'Unlimited' : Number(remainingCredits);
                if (newVal !== 'Unlimited' && (isNaN(newVal) || newVal < 0)) return res.status(400).json({ status: 'Error', message: 'Invalid remainingCredits' });
                const result = await clientsCollection.updateOne({ _id: clientObjId }, { $set: { remainingCredits: newVal } });
                if (result.matchedCount === 0) return res.status(404).json({ status: 'Error', message: 'Client not found' });
                
                client = await clientsCollection.findOne({ _id: clientObjId });
                // --- AUTO MESSAGE TRIGGER ---
                const systemSubject = "⚙️ Credits Adjusted";
                const systemBody = `Your remaining credit balance has been manually set by the administrator. Your new balance is **${client.remainingCredits}** credits.`;
                await sendSystemMessage(db, clientId, systemSubject, systemBody);
                // --- END TRIGGER ---

                return res.status(200).json({ status: 'Success', message: 'remainingCredits set.' });
            } else {
                return res.status(400).json({ status: 'Error', message: 'Invalid action. Use add or set.' });
            }
        } catch (e) {
            console.error('Error in /api/admin/index (topup):', e);
            return res.status(500).json({ status: 'Error', message: 'Internal Server Error' });
        }
    }

    // --------------------------------------------------------
    // ACTION: DEFAULT / CLIENT CRUD (List, Add, Update, Delete)
    // --------------------------------------------------------
    if (action === 'client' || !action) {
        // --- POST: Add New Client ---
        if (req.method === 'POST') {
            const { clientName, username, password, mobile, email, businessName, businessType, planName, validity } = body || {};
            if (!username || !password || !planName || !validity) return res.status(400).json({ status: 'Error', message: 'Missing required fields.' });

            try {
                if (await clientsCollection.findOne({ username })) return res.status(409).json({ status: 'Error', message: 'Username already exists.' });
                const hashedPassword = await bcrypt.hash(password, 10);
                
                // --- CREDIT/PLAN LOGIC ---
                const parsedCredits = parseCreditsFromPlanValue(planName);
                const initialCredits = parsedCredits === 'Unlimited' ? 'Unlimited' : normalizeCreditsForStorage(parsedCredits);
                const remainingCredits = initialCredits === 'Unlimited' ? 'Unlimited' : initialCredits;
                // --- END CREDIT LOGIC ---

                const newClient = {
                    clientName: clientName || null, username: username, passwordHash: hashedPassword, mobile: mobile || null, email: email || null, 
                    businessName: businessName || null, businessType: businessType || null, planName: planName, validityEnd: new Date(validity), isActive: true,
                    bulkAccessCode: Math.random().toString(36).substring(2, 8).toUpperCase(), createdAt: new Date(), lastActivityAt: null, isOnline: false, 
                    initialCredits, remainingCredits, activeSessionId: null,
                };
                const result = await clientsCollection.insertOne(newClient);
                
                // --- AUTO MESSAGE TRIGGER ---
                if (result.insertedId) {
                    const welcomeSubject = "🎉 Welcome to Smart Locator!";
                    const welcomeBody = `Your account has been successfully created.
Plan: ${newClient.planName.split('_')[0]}
Credits: ${newClient.remainingCredits}
Validity End: ${new Date(newClient.validityEnd).toLocaleDateString()}
                    
You can log in now using your credentials.`;
                    await sendSystemMessage(db, result.insertedId.toString(), welcomeSubject, welcomeBody);
                }
                // --- END TRIGGER ---

                return res.status(201).json({ status: "Success", message: "Client added successfully.", clientId: result.insertedId, client: { ...newClient, _id: result.insertedId } });
            } catch (e) {
                console.error('POST /api/admin/index (client) error:', e);
                return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
            }
        }

        // --- GET: List clients ---
        if (req.method === 'GET') {
            try {
                const clients = await clientsCollection.find({}).project({ passwordHash: 0 }).toArray();
                return res.status(200).json({ status: 'Success', data: clients });
            } catch (e) {
                console.error('GET /api/admin/index (client) error:', e);
                return res.status(500).json({ status: 'Error', message: `Internal Server Error: ${e.message}` });
            }
        }

        // --- PUT: Update Client ---
        if (req.method === 'PUT') {
            const targetId = clientId || body?.clientId;
            const updateFields = body || {};
            if (!targetId) return res.status(400).json({ status: 'Error', message: 'Client ID is required for update.' });

            try {
                const clientObjectId = new ObjectId(targetId);
                const existingClient = await clientsCollection.findOne({ _id: clientObjectId });
                if (!existingClient) return res.status(404).json({ status: 'Error', message: 'Client not found.' });
                const updateDoc = {};

                // Determine if a status change occurred for messaging
                const statusChanged = typeof updateFields.isActive !== 'undefined' && updateFields.isActive !== existingClient.isActive;
                
                // Password Change
                if (updateFields.password) updateDoc.passwordHash = await bcrypt.hash(updateFields.password, 10);
                // Validity Change
                if (updateFields.validity) updateDoc.validityEnd = new Date(updateFields.validity);
                // Status Change (Disable/Enable User)
                if (typeof updateFields.isActive !== 'undefined') updateDoc.isActive = Boolean(updateFields.isActive);
                // Admin request to clear active session for this client
                if (updateFields.clearSession === true) updateDoc.activeSessionId = null;

                // Handle plan changes and credits
                if (typeof updateFields.planName !== 'undefined' && updateFields.planName !== existingClient.planName) {
                    const newPlanValue = updateFields.planName;
                    const parsedCredits = parseCreditsFromPlanValue(newPlanValue);
                    const newInitialCredits = parsedCredits === 'Unlimited' ? 'Unlimited' : normalizeCreditsForStorage(parsedCredits);
                    const keepRemaining = updateFields.keepRemainingCredits === true;
                    
                    updateDoc.planName = newPlanValue;
                    if (!keepRemaining) {
                        updateDoc.initialCredits = newInitialCredits;
                        updateDoc.remainingCredits = newInitialCredits === 'Unlimited' ? 'Unlimited' : newInitialCredits;
                    } else {
                        updateDoc.initialCredits = newInitialCredits;
                    }
                }

                // Clean and apply other general fields
                delete updateFields.password; delete updateFields.validity; delete updateFields.isActive; 
                delete updateFields.clearSession; delete updateFields.keepRemainingCredits; delete updateFields.planName;
                Object.assign(updateDoc, updateFields);
                delete updateDoc.clientId;

                const result = await clientsCollection.updateOne({ _id: clientObjectId }, { $set: updateDoc });
                if (result.matchedCount === 0) return res.status(404).json({ status: 'Error', message: 'Client not found.' });
                
                // --- AUTO MESSAGE TRIGGER ---
                if (result.matchedCount > 0) {
                    const client = await clientsCollection.findOne({ _id: clientObjectId });
                    let systemSubject = "Account Update Applied";
                    let systemBody = "Your client details have been successfully updated by the admin.";

                    if (statusChanged) {
                        if (updateDoc.isActive === false) {
                            systemSubject = "⚠️ Account Disabled";
                            systemBody = "Your account has been **disabled** by the administrator. Please contact support immediately.";
                        } else {
                            systemSubject = "✅ Account Re-Enabled";
                            systemBody = "Your account status has been restored to **Enabled**. You can now resume verification services.";
                        }
                    } else if (updateFields.planName) {
                        systemSubject = "✨ Plan Updated";
                        systemBody = `Your plan has been updated to **${client.planName.split('_')[0]}**. 
New Credits: ${client.remainingCredits}
New Validity: ${new Date(client.validityEnd).toLocaleDateString()}`;
                    }
                    
                    if (statusChanged || updateFields.planName) {
                        await sendSystemMessage(db, targetId, systemSubject, systemBody);
                    }
                }
                // --- END TRIGGER ---

                return res.status(200).json({ status: "Success", message: "Client updated successfully." });

            } catch (e) {
                console.error('PUT /api/admin/index (client) error:', e);
                return res.status(500).json({ status: 'Error', message: `Update failed: ${e.message}` });
            }
        }

        // --- DELETE ---
        if (req.method === 'DELETE') {
            const targetId = clientId || body?.clientId;
            if (!targetId) return res.status(400).json({ status: 'Error', message: 'Client ID is required for deletion.' });
            try {
                const result = await clientsCollection.deleteOne({ _id: new ObjectId(targetId) });
                if (result.deletedCount === 0) return res.status(404).json({ status: 'Error', message: 'Client not found.' });
                return res.status(200).json({ status: "Success", message: "Client deleted successfully." });
            } catch (e) {
                console.error('DELETE /api/admin/index (client) error:', e);
                return res.status(500).json({ status: 'Error', message: `Deletion failed: ${e.message}` });
            }
        }
        return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' });
    }

    return res.status(400).json({ status: 'Error', message: 'Unknown action specified.' });
};
