// api/inbox/message.js
// Handles messaging between Admin (senderId = "admin") and Clients. 

// FIX: Corrected path to require from the new /utils/db.js location
const { connectToDatabase } = require('../../utils/db'); 
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb'); 

// 🚨 Define the JWT_SECRET using the consistent fallback value
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';

// Get the message sender/receiver ID from the JWT payload
function getUserId(req) { 
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    
    if (!token) return null; 

    try {
        // Use the consistent JWT_SECRET variable for verification
        const payload = jwt.verify(token, JWT_SECRET); 
        
        // FIX: Check for 'clientId' (for clients) OR 'id' (common for admin/other users).
        let userId = payload.clientId || payload.id;
        
        // Handle explicit admin identity if present in the token (e.g., role: 'admin' or userId/clientId is 'admin')
        if (userId === 'admin' || payload.role === 'admin') {
            return 'admin';
        }
        
        // Ensure the ID is always a string and is not null/undefined
        if (!userId) {
            console.warn("JWT Verification Failed: Payload missing required ID property (clientId or id).");
            return null;
        }

        return userId.toString();

    } catch (err) { 
        console.warn("JWT Verification Failed in message.js:", err.message);
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

    // --- Authentication Check ---
    if (!userId) {
        return res.status(401).json({ status: "Error", message: "Authentication required." });
    }

    // --- POST: Send Message (Client to Admin / Admin to Client) --- 
    if (req.method === 'POST') { 
        
        let body = req.body; 
        
        // Ensure body is parsed 
        if (typeof body === 'string') { 
            try { 
                body = JSON.parse(body); 
            } catch (e) { 
                return res.status(400).json({ status: "Error", message: "Invalid JSON format in request body." }); 
            } 
        } 

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
            return res.status(201).json({ status: "Success", message: "Message sent.", messageId: result.insertedId }); 
        } catch (e) { 
            return res.status(500).json({ status: "Error", message: `Failed to send message: ${e.message}` }); 
        } 
    } 

    // --- GET: Retrieve Inbox --- 
    if (req.method === 'GET') { 
        
        try { 
            // The query handles messages where the current user (userId) is the sender OR the receiver
            const messages = await messagesCollection.find({ $or: [ { senderId: userId }, { receiverId: userId } ] }) 
            .sort({ timestamp: -1 }) 
            .toArray(); 
            
            // Unread count only includes messages where the current user is the receiver
            const unreadCount = messages.filter(m => m.receiverId === userId && m.isRead === false).length; 
            return res.status(200).json({ status: "Success", messages: messages, unreadCount: unreadCount }); 
        } catch (e) { 
            return res.status(500).json({ status: "Error", message: `Failed to retrieve inbox: ${e.message}` }); 
        }
    } 

    // --- PUT: Mark as Read --- 
    if (req.method === 'PUT') { 
        
        const messageId = req.query.messageId; 
        
        if (!messageId) return res.status(400).json({ status: "Error", message: "Message ID is required." }); 
        
        try { 
            let objectId; 
            try { 
                objectId = new ObjectId(messageId); 
            } catch (err) { 
                return res.status(400).json({ status: "Error", message: "Invalid message ID format." }); 
            } 
            
            // Only allow the receiver to mark the message as read
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