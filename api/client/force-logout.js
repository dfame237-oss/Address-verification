// api/client/force-logout.js
// Force logout any existing session for this client (used when user chooses "Logout Other Device")

const { connectToDatabase } = require('../db');
const { ObjectId } = require('mongodb');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ status: "Error", message: "Method not allowed" });
  }

  try {
    const { clientId } = req.body;

    if (!clientId) {
      return res.status(400).json({ status: "Error", message: "Missing clientId" });
    }

    const { db } = await connectToDatabase();
    const clients = db.collection('clients');

    // Clear active session regardless of sessionId
    await clients.updateOne(
      { _id: new ObjectId(clientId) },
      { $set: { activeSessionId: null, lastActivityAt: new Date() } }
    );

    return res.status(200).json({
      status: "Success",
      message: "Forced logout complete. You can now login.",
    });

  } catch (err) {
    console.error("Force logout error:", err);
    return res.status(500).json({
      status: "Error",
      message: "Internal Server Error",
    });
  }
};
