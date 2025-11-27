// api/support/message.js
// Handles unauthenticated public inquiries (from contact.html).

const { connectToDatabase } = require('../../utils/db');
const { ObjectId } = require('mongodb'); // Need ObjectId for deletion

module.exports = async (req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    // 🛑 FIX: Must allow DELETE method in CORS header
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS'); 
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    let db;
    try {
        const dbResult = await connectToDatabase();
        db = dbResult.db;
    } catch (e) {
        return res.status(500).json({ status: "Error", message: "Database connection failed." });
    }

    const supportCollection = db.collection("supportMessages"); 
    
    // --------------------------------------------------------
    // CASE 1: POST (Submission of New Demo Request)
    // --------------------------------------------------------
    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { /* ignore */ }
        }

        try {
            const { clientName, clientEmail, clientMobile, messageText } = body;
            
            if (!clientName || !clientEmail || !messageText) {
                return res.status(400).json({ status: "Error", message: "Name, Email, and Requirement are required." });
            }

            const messageData = {
                clientName,
                clientEmail,
                clientMobile: clientMobile || 'N/A',
                messageText,
                receivedAt: new Date(),
                isRead: false,
            };

            await supportCollection.insertOne(messageData);

            return res.status(201).json({ status: "Success", message: "Your message has been sent to the admin." });

        } catch (e) {
            console.error("Support Message Server Error:", e);
            return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
        }
    }
    
    // --------------------------------------------------------
    // CASE 2: DELETE (Deletion by Admin Router)
    // --------------------------------------------------------
    if (req.method === 'DELETE') {
        // The Admin router passes the message ID as a query parameter
        const messageId = req.query.messageId;
        
        if (!messageId) {
            return res.status(400).json({ status: "Error", message: "Message ID is required for deletion." });
        }
        
        try {
            const result = await supportCollection.deleteOne({ _id: new ObjectId(messageId) });
            
            if (result.deletedCount === 0) {
                return res.status(404).json({ status: "Error", message: "Message not found." });
            }

            return res.status(200).json({ status: "Success", message: "Support message deleted successfully." });

        } catch (e) {
            console.error("Support Message DELETE Error:", e);
            return res.status(500).json({ status: "Error", message: `Deletion failed: ${e.message}` });
        }
    }

    // Default 405 for other unhandled methods (like GET, PUT)
    return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
};