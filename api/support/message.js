// Address-verification-main/api/support/message.js

const { connectToDatabase } = require('../db');

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

    try {
        const { clientName, clientEmail, messageText } = req.body;
        
        if (!clientName || !clientEmail || !messageText) {
            return res.status(400).json({ status: "Error", message: "All fields are required." });
        }

        const { db } = await connectToDatabase();
        // Use a new collection for support messages
        const supportCollection = db.collection("supportMessages"); 

        const messageData = {
            clientName,
            clientEmail,
            messageText,
            receivedAt: new Date(),
            isRead: false, // Helps admin track new messages
        };

        await supportCollection.insertOne(messageData);

        return res.status(201).json({ status: "Success", message: "Your message has been sent to the admin." });

    } catch (e) {
        console.error("Support Message Server Error:", e);
        return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
    }
};