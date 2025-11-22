// api/check-access.js
module.exports = async (req, res) => {
    // 1. CORS Headers (Same as verify-single-address.js)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', 'https://dfame237-oss.github.io/Address-verification');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ status: "Error", error: 'Method Not Allowed' });
    }

    try {
        const { code } = req.body;
        
        // 2. Load Secret Password from Environment Variables
        // IMPORTANT: Set this in Vercel Deployment Settings (e.g., NAME: BULK_ACCESS_CODE, VALUE: Pkboss@12)
        const CORRECT_CODE = process.env.BULK_ACCESS_CODE; 

        if (!CORRECT_CODE) {
            console.error("BULK_ACCESS_CODE environment variable is not set.");
            return res.status(500).json({ status: "Error", message: "Server configuration error." });
        }

        // 3. Simple String Comparison (Safe on the server)
        if (code === CORRECT_CODE) {
            return res.status(200).json({ status: "Success", message: "Access granted." });
        } else {
            return res.status(401).json({ status: "Error", message: "Incorrect access code." });
        }

    } catch (e) {
        console.error("Access Check Server Error:", e);
        return res.status(500).json({ status: "Error", message: `Internal Server Error: ${e.message}` });
    }
};
