// api/admin/support.js
// Handles fetching unauthenticated support/demo requests for the Admin Dashboard.
// Requires Admin authentication via JWT.

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb');

// Re-using the Admin authentication logic (Checks if user is 'admin')
function getUserId(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    if (!token) return null;
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        return payload.id === 'admin' ? 'admin' : null;
    } catch (err) {
        return null;
    }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const adminId = getUserId(req);

    // 1. Check Admin Authentication
    if (adminId !== 'admin') {
        // Use 403 (Forbidden) if token is present but not admin, or 401 (Unauthorized) if token is missing
        return res.status(401).json({ status: "Error", message: "Admin authentication required." });
    }

    let db;
    try {
        db = (await connectToDatabase()).db;
    } catch (e) {
        return res.status(500).json({ status: "Error", message: "Database connection failed." });
    }
    // Collection used by public contact forms (index.html, contact.html)
    const supportCollection = db.collection("supportMessages"); 

    // --- GET: Retrieve All Support Messages ---
    if (req.method === 'GET') {
        try {
            const messages = await supportCollection.find({})
                .sort({ receivedAt: -1 }) 
                .toArray();

            // Calculate unread count 
            const unreadCount = messages.filter(m => m.isRead === false).length;

            return res.status(200).json({ 
                status: "Success", 
                messages: messages,
                unreadCount: unreadCount
            });
        } catch (e) {
            console.error("Failed to retrieve support messages:", e);
            return res.status(500).json({ status: "Error", message: `Failed to retrieve support messages: ${e.message}` });
        }
    }

    // --- PUT: Mark as Read ---
    if (req.method === 'PUT') {
        const messageId = req.query.messageId; 
        if (!messageId) return res.status(400).json({ status: "Error", message: "Message ID is required." });
        
        try {
            const objectId = new ObjectId(messageId);
            
            const result = await supportCollection.updateOne(
                { _id: objectId },
                { $set: { isRead: true } }
            );
            if (result.matchedCount === 0) {
                 return res.status(404).json({ status: "Error", message: "Message not found." });
            }
            return res.status(200).json({ status: "Success", message: "Message marked as read." });
        } catch (e) {
            console.error("Failed to update support message status:", e);
            return res.status(500).json({ status: "Error", message: `Failed to update message status: ${e.message}` });
        }
    }

    res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
};