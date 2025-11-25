// api/inbox/message.js 
// Handles messaging between Admin (senderId = "admin") and Clients. 

const { connectToDatabase } = require('../db'); 
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb'); 

// Get the message sender/receiver ID from the JWT payload
function getUserId(req) { 
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    
    // 1. If token is missing, fail immediately.
    if (!token) return null; 

    try {
        // 2. Verify the JWT
        const payload = jwt.verify(token, process.env.JWT_SECRET); 
        
        // --- NOTE: Assuming JWT payload contains 'id' ---
        
        // Check if the ID is the known admin string
        if (payload.id === 'admin') {
            return 'admin';
        }
        // For clients, return the client ID
        return payload.id.toString();

    } catch (err) { 
        // 3. If token verification fails (expired, invalid signature), return null.
        console.warn("JWT Verification Failed:", err.message);
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
        // 🚨 FIX: Using 401 Unauthorized instead of 403 Forbidden 
        if (!userId) {
            return res.status(401).json({ status: "Error", message: "Authentication context missing. Please log in again." });
        }
        
        let body = req.body; 
        
        // Ensure body is parsed 
        if (typeof body === 'string') { 
            try { 
                body = JSON.parse(body); 
            } catch (e) { 
                return res.status(400).json({ status: "Error", message: "Invalid JSON format in request body." }); 
            } 
        } 

        // Extract payload
        const { subject, body: messageBody, recipientId } = body || {}; 
        
        if (!subject || !messageBody) { 
            return res.status(400).json({ status: "Error", message: "Subject and message body are required." }); 
        } 

        const newMessage = { 
            senderId: userId, 
            receiverId: recipientId || 'admin', // Default to admin
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
        if (!userId) return res.status(401).json({ status: "Error", message: "Authentication required to view inbox." }); // Also changed to 401
        
        // ... (rest of GET logic remains the same) ...
        try { 
            const messages = await messagesCollection.find({ $or: [ { senderId: userId }, { receiverId: userId } ] }) 
            .sort({ timestamp: -1 }) 
            .toArray(); 
            
            const unreadCount = messages.filter(m => m.receiverId === userId && m.isRead === false).length; 
            return res.status(200).json({ status: "Success", messages: messages, unreadCount: unreadCount }); 
        } catch (e) { 
            return res.status(500).json({ status: "Error", message: `Failed to retrieve inbox: ${e.message}` }); 
        }
    } 

    // --- PUT: Mark as Read --- 
    if (req.method === 'PUT') { 
        if (!userId) return res.status(401).json({ status: "Error", message: "Authentication required." }); // Also changed to 401
        
        const messageId = req.query.messageId; 
        
        // ... (rest of PUT logic remains the same) ...
        if (!messageId) return res.status(400).json({ status: "Error", message: "Message ID is required." }); 
        
        try { 
            let objectId; 
            try { 
                objectId = new ObjectId(messageId); 
            } catch (err) { 
                return res.status(400).json({ status: "Error", message: "Invalid message ID format." }); 
            } 
            
            const result = await messagesCollection.updateOne( 
                { _id: objectId, receiverId: userId }, 
                { $set: { isRead: true } } 
            ); 
            
            if (result.matchedCount === 0) { 
                return res.status(403).json({ status: "Error", message: "Message not found or unauthorized to mark as read." }); 
            } 
            
            return res.status(200).json({ status: "Success", message: "Message marked as read." }); 
        } catch (e) { 
            return res.status(500).json({ status: "Error", message: `Failed to update message status: ${e.message}` }); 
        } 
    } 

    res.status(405).json({ status: "Error", error: 'Method Not Allowed' }); 
};