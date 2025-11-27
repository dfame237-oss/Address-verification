// api/support/message.js
// Handles unauthenticated public inquiries (from contact.html).

// 🛠️ FIX: Corrected path from '../db' to '../../utils/db' 
// to properly locate db.js within the /utils folder (up two levels from /api/support/).
const { connectToDatabase } = require('../../utils/db');

module.exports = async (req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
    }

    // Ensure JSON body is parsed
    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { /* ignore */ }
    }

    try {
        const { clientName, clientEmail, clientMobile, messageText } = body;
        
        if (!clientName || !clientEmail || !messageText) {
            return res.status(400).json({ status: "Error", message: "Name, Email, and Requirement are required." });
        }

        // 🛑 CRITICAL STEP: The database connection happens here.
        const { db } = await connectToDatabase();
        
        // Use a new collection for unauthenticated support messages
        const supportCollection = db.collection("supportMessages"); 

        const messageData = {
            clientName,
            clientEmail,
            clientMobile: clientMobile || 'N/A',
            messageText,
            receivedAt: new Date(),
            isRead: false, // Helps admin track new messages
        };

        await supportCollection.insertOne(messageData);

        return res.status(201).json({ status: "Success", message: "Your message has been sent to the admin." });

    } catch (e) {
        console.error("Support Message Server Error:", e);
        // Ensure all catch blocks return a consistent JSON response (fixes the non-JSON 500 issue)
        return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
    }
};