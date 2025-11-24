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
        
        // --- FIX: Check if the ID is the known admin string ---
        if (payload.id === 'admin') {
            return 'admin';
        }
        
        // For clients, return the MongoDB ObjectId string
        return payload.id.toString(); 

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
    // Consistent collection name for ALL authenticated messages
    const messagesCollection = db.collection("messages"); 
    const userId = getUserId(req);

    // --- POST: Send Message (Client to Admin / Admin to Client) ---
    if (req.method === 'POST') {
        if (!userId) return res.status(403).json({ status: "Error", message: "Authentication required to send message." });
        
        let body = req.body;
        // Ensure body is parsed if it's a raw string buffer from the request stream
        if (typeof body === 'string') {
             try { body = JSON.parse(body); } catch (e) { 
                 console.error("Failed to parse incoming JSON body:", e);
                 return res.status(400).json({ status: "Error", message: "Invalid JSON format in request body." });
             }
        }

        // The client-dashboard POST payload doesn't include recipientId, so it defaults to 'admin'
        const { subject, body: messageBody, recipientId } = body || {}; 

        if (!subject || !messageBody) {
            return res.status(400).json({ status: "Error", message: "Subject and message body are required." });
        }

        const newMessage = {
            senderId: userId, 
            receiverId: recipientId || 'admin', 
            subject: subject,
            body: messageBody,
            isRead: false,
            timestamp: new Date(),
        };

        try {
            const result = await messagesCollection.insertOne(newMessage);
            // HTTP Status 201 Created is appropriate for a successful POST
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
            .sort({ timestamp: -1 }) 
            .toArray();

            // Calculate unread count for notification badge (Only counts messages RECEIVED by the current user)
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

    // --- PUT: Mark as Read (FIXED LOGIC) ---
    if (req.method === 'PUT') {
        const messageId = req.query.messageId; 
        if (!messageId) return res.status(400).json({ status: "Error", message: "Message ID is required." });
        
        try {
            // Attempt to parse messageId as ObjectId; if it fails, the find query won't match, which is safer
            let objectId;
            try {
                objectId = new ObjectId(messageId);
            } catch (err) {
                 return res.status(400).json({ status: "Error", message: "Invalid message ID format." });
            }

            // Ensure the requesting userId is the intended RECEIVER of the message before marking it read
            const result = await messagesCollection.updateOne(
                { 
                    _id: objectId, 
                    receiverId: userId 
                },
                { $set: { isRead: true } }
            );
            if (result.matchedCount === 0) {
                 // 403 is more appropriate if the user is authenticated but not authorized for this specific resource
                 return res.status(403).json({ status: "Error", message: "Message not found or unauthorized to mark as read." });
            }
            return res.status(200).json({ status: "Success", message: "Message marked as read." });
        } catch (e) {
            return res.status(500).json({ status: "Error", message: `Failed to update message status: ${e.message}` });
        }
    }

    res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
};