// api/inbox/message.js
// Handles messaging between Admin (senderId = "admin") and Clients.

const { connectToDatabase } = require('../db');
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb');

// Get the message sender/receiver ID from the JWT payload
function getUserId(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    if (!token) return null;
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        return payload.id.toString(); // Return user ID as string
    } catch (err) {
        return null;
    }
}

module.exports = async (req, res) => {
    // CORS Setup (Standard)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    let db;
    try {
        db = (await connectToDatabase()).db;
    } catch (e) {
        return res.status(500).json({ status: "Error", message: "Database connection failed." });
    }
    const messagesCollection = db.collection("messages");
    const userId = getUserId(req);

    // --- POST: Send Message (Client to Admin / Admin to Client) ---
    if (req.method === 'POST') {
        if (!userId) return res.status(403).json({ status: "Error", message: "Authentication required to send message." });
        
        let body = req.body;
        if (typeof body === 'string') body = JSON.parse(body);

        const { subject, body: messageBody, recipientId } = body || {};

        if (!subject || !messageBody) {
            return res.status(400).json({ status: "Error", message: "Subject and message body are required." });
        }

        const newMessage = {
            senderId: userId, // ID of the person logged in
            receiverId: recipientId || 'admin', // Default target is 'admin'
            subject: subject,
            body: messageBody,
            isRead: false,
            timestamp: new Date(),
        };

        try {
            const result = await messagesCollection.insertOne(newMessage);
            return res.status(201).json({ status: "Success", message: "Message sent.", messageId: result.insertedId });
        } catch (e) {
            return res.status(500).json({ status: "Error", message: `Failed to send message: ${e.message}` });
        }
    }

    // --- GET: Retrieve Inbox ---
    if (req.method === 'GET') {
        if (!userId) return res.status(403).json({ status: "Error", message: "Authentication required to view inbox." });

        try {
            // Find messages sent to or received by the current user
            const messages = await messagesCollection.find({
                $or: [
                    { senderId: userId },
                    { receiverId: userId }
                ]
            })
            .sort({ timestamp: -1 }) // Sort newest first
            .toArray();

            // Calculate unread count for notification badge
            const unreadCount = messages.filter(m => m.receiverId === userId && m.isRead === false).length;

            return res.status(200).json({ 
                status: "Success", 
                messages: messages,
                unreadCount: unreadCount
            });
        } catch (e) {
            return res.status(500).json({ status: "Error", message: `Failed to retrieve inbox: ${e.message}` });
        }
    }

    // --- PUT: Mark as Read ---
    if (req.method === 'PUT') {
        const messageId = req.query.messageId; 
        if (!messageId) return res.status(400).json({ status: "Error", message: "Message ID is required." });
        
        try {
            const result = await messagesCollection.updateOne(
                { _id: new ObjectId(messageId), receiverId: userId },
                { $set: { isRead: true } }
            );
            if (result.matchedCount === 0) {
                 return res.status(404).json({ status: "Error", message: "Message not found or unauthorized." });
            }
            return res.status(200).json({ status: "Success", message: "Message marked as read." });
        } catch (e) {
            return res.status(500).json({ status: "Error", message: `Failed to update message status: ${e.message}` });
        }
    }

    res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
};