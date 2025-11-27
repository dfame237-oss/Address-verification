// api/inbox/message.js
// Handles messaging between Admin (senderId = "admin") and Clients. 

const { connectToDatabase } = require('../db'); 
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb'); 

// 🚨 FIX 2: Define the JWT_SECRET using the consistent fallback value
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';

// Get the message sender/receiver ID from the JWT payload
function getUserId(req) { 
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader?.split(' ')[1];
    
    if (!token) return null; 

    try {
        // Use the consistent JWT_SECRET variable for verification
        const payload = jwt.verify(token, JWT_SECRET); 
        
        // 🚨 FIX 1: Change to check for the correct 'clientId' property
        if (payload.clientId === 'admin') {
            return 'admin';
        }
        
        // 🚨 FIX 1: Ensure the ID is read from the correct key 'clientId'
        const userId = payload.clientId;

        // Check for existence before calling toString() 
        if (!userId) {
            console.warn("JWT Verification Failed: Payload missing clientId property.");
            return null;
        }

        return userId.toString();

    } catch (err) { 
        console.warn("JWT Verification Failed in message.js:", err.message);
        // This is the warning you saw in your logs!
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
        // 401 Unauthorized check (previously fixed)
        if (!userId) {
            return res.status(401).json({ status: "Error", message: "Authentication context missing. Please log in again." });
        }
        
        // Since you only want clients to see admin messages, you may want to restrict the POST method 
        // here unless the client is an 'admin' (which requires more complex token logic) 
        // OR simply restrict client-side UI from showing the message composition form.
        // For now, we allow POST, assuming you filter client-side.

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
        if (!userId) return res.status(401).json({ status: "Error", message: "Authentication required to view inbox." }); 
        
        try { 
            // Query for messages where the current user is either the sender OR the receiver
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
        if (!userId) return res.status(401).json({ status: "Error", message: "Authentication required." }); 
        
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