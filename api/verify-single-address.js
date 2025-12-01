// api/verify-single-address.js
// Final Logic Source for both single and bulk verification.
const INDIA_POST_API = 'https://api.postalpincode.in/pincode/'; 
let pincodeCache = {};

const testingKeywords = ['test', 'testing', 'asdf', 'qwer', 'zxcv', 'random', 'gjnj', 'fgjnj'];
const coreMeaningfulWords = [
    "ddadu", "ddadu", "ai", "add", "add-", "raw", "dumping", "grand", "dumping grand",
    "chd", "chd-", "chandigarh", "chandigarh-", "chandigarh", "west", "sector", "sector-",
    "house", "no", "no#", "house no", "house no#", "floor", "first", "first floor",
    "majra", "colony", "dadu", "dadu majra", "shop", "wine", "wine shop", "house", "number",
    "tq", "job", "dist"
];
const meaningfulWords = [...coreMeaningfulWords, ...testingKeywords]; 
const meaninglessRegex = new RegExp(`\\b(?:${meaningWords.join('|')})\\b`, 'gi');
const directionalKeywords = ['near', 'opposite', 'back side', 'front side', 'behind', 'opp'];
// --- DB helper and auth ---
const { connectToDatabase } = require('../utils/db');
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb'); 
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';


// --- India Post helper ---
async function getIndiaPostData(pin) {
    if (!pin) return { PinStatus: 'Error' };
    if (pincodeCache[pin]) return pincodeCache[pin]; 

    try {
        const response = await fetch(INDIA_POST_API + pin);
        const data = await response.json(); 
        const postData = data[0]; 

        if (response.status !== 200 || postData.Status !== 'Success') {
            pincodeCache[pin] = { PinStatus: 'Error' };
            return pincodeCache[pin]; 
        }

        const postOffices = postData.PostOffice.map(po => ({
            Name: po.Name || '',
            Taluk: po.Taluk || po.SubDistrict || '',
            District: po.District || '',
            State: po.State || ''
        }));
        pincodeCache[pin] = {
            PinStatus: 'Success',
            PostOfficeList: postOffices,
        };
        return pincodeCache[pin]; 
    } catch (e) {
        console.error("India Post API Error:", e.message); 
        pincodeCache[pin] = { PinStatus: 'Error' };
        return pincodeCache[pin]; 
    }
}

// --- Gemini helper ---
async function getGeminiResponse(prompt) { 
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return { text: null, error: "Gemini API key not set in environment variables."
        };
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; 

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
    };
    const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    };
    try {
        const response = await fetch(apiUrl, options); 
        const result = await response.json();
        if (response.status !== 200) {
            const errorMessage = `Gemini API Error: ${result.error?.message ||
            "Unknown error."}`;
            console.error(errorMessage); 
            return { text: null, error: errorMessage }; 
        }

        if (result.candidates && result.candidates.length > 0) {
            return { text: result.candidates[0].content.parts[0].text, error: null };
        } else {
            const errorMessage = "Gemini API Error: No candidates found in response."; 
            console.error(errorMessage);
            return { text: null, error: errorMessage }; 
        }
    } catch (e) {
        const errorMessage = `Error during Gemini API call: ${e.message}`;
        console.error(errorMessage); 
        return { text: null, error: errorMessage }; 
    }
}

// --- Utilities & Prompt Builder ---
function extractPin(address) {
    const match = String(address).match(/\b\d{6}\b/);
    return match ? match[0] : null; 
}

function buildGeminiPrompt(originalAddress, postalData) {
    let basePrompt = `You are an expert Indian address verifier and formatter.
    Your task is to process a raw address, perform a thorough analysis, and provide a comprehensive response in a single JSON object.
    Provide all responses in English only. Strictly translate all extracted address components to English.
    Correct all common spelling and phonetic errors in the provided address, such as "rd" to "Road", "nager" to "Nagar", and "nd" to "2nd".
    Analyze common short forms and phonetic spellings, such as "lean" for "Lane", and use your best judgment to correct them.
    Be strict about ensuring the output is a valid, single, and complete address for shipping.
    Use your advanced knowledge to identify and remove any duplicate address components that are present consecutively (e.g., 'Gandhi Street Gandhi Street' should be 'Gandhi Street').
    
    CRITICAL INSTRUCTION: If official Postal Data (State/District/PIN) is provided, you MUST ensure that your formatted address and extracted fields align perfectly with this official data. Remove any conflicting city, state, or district names from the raw address (e.g., if the raw address says 'Mumbai' but the PIN is for 'Delhi', you MUST remove 'Mumbai' from the FormattedAddress and set 'State'/'DIST.' to the official Delhi data).

    Your response must contain the following keys:
    1.  "H.no.", "Flat No.", "Plot No.", "Room No.", "Building No.", "Block No.", "Ward No.", "Gali No.", "Zone No.": Extract only the number or alphanumeric sequence (e.g., '1-26', 'A/25', '10').
    Set to null if not found.
    2.  "Colony", "Street", "Locality", "Building Name", "House Name", "Floor": Extract the name.
    3.  "P.O.": The official Post Office name from the PIN data. Prepend "P.O." to the name. Example: "P.O. Boduppal".
    4.  "Tehsil": The official Tehsil/SubDistrict from the PIN data. Prepend "Tehsil". Example: "Tehsil Pune".
    5.  "DIST.": The official District from the PIN data.
    6.  "State": The official State from the PIN data.
    7.  "PIN": The 6-digit PIN code. Find and verify the correct PIN.
    If a PIN exists in the raw address but is incorrect, find the correct one and provide it.
    8.  "Landmark": A specific, named landmark (e.g., "Apollo Hospital"), not a generic type like "school".
    If multiple landmarks are present, list them comma-separated. **Extract the landmark without any directional words like 'near', 'opposite', 'behind' etc., as this will be handled by the script.**
    9.  "Remaining": A last resort for any text that does not fit into other fields.
    Clean this by removing meaningless words like 'job', 'raw', 'add-', 'tq', 'dist' and country, state, district, or PIN code.
    10. "FormattedAddress": This is the most important field. Based on your full analysis, create a single, clean, human-readable, and comprehensive shipping-ready address string. It should contain only specific details (H.no., Room No., etc.), followed by locality, street, and colony. **STRICTLY DO NOT include P.O., Tehsil, District, State, or PIN in this string.** Use commas to separate logical components. Do not invent or "hallucinate" information.
    11. "LocationType": Identify the type of location (e.g., "Village", "Town", "City", "Urban Area").
    12. "AddressQuality": Analyze the address completeness and clarity for shipping.
    Categorize it as one of the following: Very Good, Good, Medium, Bad, or Very Bad.
    13. "LocationSuitability": Analyze the location based on its State, District, and PIN to determine courier-friendliness in India.
    Categorize it as one of the following: Prime Location, Tier 1 & 2 Cities, Remote/Difficult Location, or Non-Serviceable Location.
    Raw Address: "${originalAddress}"
`; 

    if (postalData.PinStatus === 'Success') {
        basePrompt += `\nOfficial Postal Data: ${JSON.stringify(postalData.PostOfficeList)}\nUse this list to find the best match for 'P.O.', 'Tehsil', and 'DIST.'
fields.`; 
    } else {
        basePrompt += `\nAddress has no PIN or the PIN is invalid.
You must find and verify the correct 6-digit PIN. If you cannot find a valid PIN, set "PIN" to null and provide the best available data.`;
    }

    basePrompt += `\nYour entire response MUST be a single, valid JSON object starting with { and ending with } and contain ONLY the keys listed above.`;
    return basePrompt;
}

function processAddress(address, postalData) {
    const prompt = buildGeminiPrompt(address, postalData); 
    return getGeminiResponse(prompt);
}

// --- NEW: Reusable Verification Logic Function ---
async function runVerificationLogic(address, customerName) {
    let remarks = [];
    const cleanedName = (customerName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim() || null; 
    const initialPin = extractPin(address);
    let postalData = { PinStatus: 'Error' };

    if (initialPin) {
        postalData = await getIndiaPostData(initialPin);
    }
    
    // 1. Call Gemini API
    const geminiResult = await processAddress(address, postalData);

    if (geminiResult.error || !geminiResult.text) {
        return {
            status: "Error", remarks: `Fatal Gemini Error: ${geminiResult.error || 'API failed.'}`, addressQuality: "Very Bad", 
            customerCleanName: cleanedName, addressLine1: address, landmark: "", state: "", district: "", pin: initialPin, success: false
        };
    }

    // 2. Parse Gemini JSON output
    let parsedData;
    try {
        const jsonText = geminiResult.text.replace(/```json|```/g, '').trim(); 
        parsedData = JSON.parse(jsonText);
    } catch (e) {
        remarks.push(`CRITICAL_ALERT: JSON parse failed. Raw Gemini Output: ${String(geminiResult.text || '').substring(0, 50)}...`);
        parsedData = {
            FormattedAddress: address.replace(meaninglessRegex, '').trim(),
            Landmark: '', State: '', DIST: '', PIN: initialPin, 
            AddressQuality: 'Very Bad', Remaining: remarks[0],
        };
    }

    // 3. --- PIN VERIFICATION & CORRECTION LOGIC ---
    let finalPin = String(parsedData.PIN).match(/\b\d{6}\b/) ? parsedData.PIN : initialPin; 
    let primaryPostOffice = postalData.PostOfficeList ? postalData.PostOfficeList[0] : {};
    
    if (finalPin) {
        if (postalData.PinStatus !== 'Success' || (initialPin && finalPin !== initialPin)) {
            const aiPostalData = await getIndiaPostData(finalPin);
            if (aiPostalData.PinStatus === 'Success') {
                postalData = aiPostalData;
                primaryPostOffice = postalData.PostOfficeList[0] || {}; 
                if (initialPin && initialPin !== finalPin) {
                    remarks.push(`CRITICAL_ALERT: Wrong PIN (${initialPin}) corrected to (${finalPin}).`);
                } else if (!initialPin) {
                    remarks.push(`Correct PIN (${finalPin}) added by AI.`);
                }
            } else {
                remarks.push(`CRITICAL_ALERT: AI-provided PIN (${finalPin}) not verified by API.`);
                finalPin = initialPin; 
            }
        } 
        // NOTE: Misleading 'PIN verified successfully' remark removed here.
    } else {
        remarks.push('CRITICAL_ALERT: PIN not found after verification attempts. Manual check needed.');
        finalPin = initialPin || null; 
    }

    if (parsedData.FormattedAddress && parsedData.FormattedAddress.length < 35 && parsedData.AddressQuality !== 'Very Good' && parsedData.AddressQuality !== 'Good') {
        remarks.push(`CRITICAL_ALERT: Formatted address is short (${parsedData.FormattedAddress.length} chars). Manual verification recommended.`);
    }

    // 4. --- Landmark directional prefix logic ---
    let landmarkValue = parsedData.Landmark || ''; 
    const originalAddressLower = address.toLowerCase(); 
    let finalLandmark = ''; 
    if (landmarkValue.toString().trim() !== '') {
        const foundDirectionalWord = directionalKeywords.find(keyword => originalAddressLower.includes(keyword));
        if (foundDirectionalWord) {
            const originalDirectionalWordMatch = address.match(new RegExp(`\\b${foundDirectionalWord.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i'));
            const originalDirectionalWord = originalDirectionalWordMatch ? originalDirectionalWordMatch[0] : foundDirectionalWord; 
            const prefixedWord = originalDirectionalWord.charAt(0).toUpperCase() + originalDirectionalWord.slice(1); 
            finalLandmark = `${prefixedWord} ${landmarkValue.toString().trim()}`;
        } else {
            finalLandmark = `Near ${landmarkValue.toString().trim()}`;
        }
    }

    if (parsedData.Remaining && parsedData.Remaining.trim() !== '') {
        remarks.push(`Remaining/Ambiguous Text: ${parsedData.Remaining.trim()}`);
    } 
    
    // Final default message: only added if no specific alerts/corrections were found
    if (remarks.length === 0) {
        remarks.push('Address verified and formatted successfully.');
    }

    // Build final response object
    return {
        status: "Success",
        customerRawName: customerName,
        customerCleanName: cleanedName,
        
        addressLine1: parsedData.FormattedAddress || address.replace(meaninglessRegex, '').trim() || '', 
        landmark: finalLandmark, 
        postOffice: primaryPostOffice.Name || parsedData['P.O.'] || '', 
        tehsil: primaryPostOffice.Taluk || parsedData.Tehsil || '', 
        district: primaryPostOffice.District || parsedData['DIST.'] || '', 
        state: primaryPostOffice.State || parsedData.State || '', 
        pin: finalPin, 
        addressQuality: parsedData.AddressQuality || 'Medium', 
        locationType: parsedData.LocationType || 'Unknown', 
        locationSuitability: parsedData.LocationSuitability || 'Unknown', 
        remarks: remarks.join('; ').trim(),
        success: true // Indicate successful verification
    };
}


// --- Main Handler (AUTHENTICATED POST & GET) ---
module.exports = async (req, res) => {
    // CORS & Auth Setup
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', 'https://dfame237-oss.github.io/Address-verification'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); 
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    if (req.method === 'OPTIONS') {
        res.status(200).end(); 
        return; 
    }

    // Connect DB
    let db;
    try {
        const dbResult = await connectToDatabase(); 
        db = dbResult.db;
    } catch (e) {
        console.error('DB connection failed in /api/verify-single-address:', e);
        return res.status(500).json({ status: 'Error', error: 'Database connection failed.' }); 
    }
    const clients = db.collection('clients');
    
    // Helper: parse JWT payload from Authorization header
    function parseJwtFromHeader(req) {
        const authHeader = req.headers.authorization || req.headers.Authorization; 
        if (!authHeader) return null; 
        const parts = authHeader.split(' '); 
        if (parts.length !== 2) return null; 
        const token = parts[1];
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            if (!payload || !payload.clientId) return null;
            return payload;
        } catch (e) {
            return null;
        }
    }

    // GET: return remaining credits
    if (req.method === 'GET') {
        const jwtPayload = parseJwtFromHeader(req);
        if (!jwtPayload || !jwtPayload.clientId) return res.status(401).json({ status: 'Error', message: 'Authentication required.' });
        try {
            const client = await clients.findOne({ _id: new ObjectId(jwtPayload.clientId) }, { projection: { remainingCredits: 1, initialCredits: 1, planName: 1 } });
            if (!client) return res.status(404).json({ status: 'Error', message: 'Client not found.' });
            return res.status(200).json({
                status: 'Success',
                remainingCredits: client.remainingCredits ?? 0,
                initialCredits: client.initialCredits ?? 0,
                planName: client.planName ?? null
            });
        } catch (e) {
            console.error('GET /api/verify-single-address error:', e);
            return res.status(500).json({ status: 'Error', message: 'Internal server error.' }); 
        }
    }

    // POST: process single verification with credits logic
    if (req.method === 'POST') {
        const jwtPayload = parseJwtFromHeader(req);
        if (!jwtPayload || !jwtPayload.clientId) return res.status(401).json({ status: 'Error', message: 'Authentication required.' });
        const clientId = jwtPayload.clientId; 
        
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* ignore */ } }
        const { address, customerName } = body || {}; 
        if (!address) return res.status(400).json({ status: 'Error', error: 'Address is required.' });

        try {
            const client = await clients.findOne({ _id: new ObjectId(clientId) });
            if (!client) return res.status(404).json({ status: 'Error', message: 'Client not found.' }); 

            // --- Credit Check and Deduction Logic ---
            const remaining = client.remainingCredits; 
            const initial = client.initialCredits;
            const isUnlimited = (remaining === 'Unlimited' || initial === 'Unlimited' || String(initial).toLowerCase() === 'unlimited'); 
            let reserved = false;

            if (!isUnlimited) {
                const reserveResult = await clients.findOneAndUpdate(
                    { _id: client._id, remainingCredits: { $gt: 0 } },
                    { $inc: { remainingCredits: -1 }, $set: { lastActivityAt: new Date() } },
                    { returnDocument: 'after' }
                );
                if (!reserveResult.value) {
                    return res.status(200).json({
                        status: 'QuotaExceeded',
                        message: 'You have exhausted your verification credits.',
                        remainingCredits: client.remainingCredits ?? 0
                    });
                }
                reserved = true;
            } else {
                await clients.updateOne({ _id: client._id }, { $set: { lastActivityAt: new Date() } });
            }

            // Use the unified logic function
            const finalResponse = await runVerificationLogic(address, customerName);

            // If an error occurred in runVerificationLogic, refund the credit
            if (finalResponse.status === "Error" && reserved) {
                 try {
                     await clients.updateOne({ _id: client._id }, { $inc: { remainingCredits: 1 } });
                 } catch (refundErr) {
                     console.error('Failed to refund reserved credit after Gemini error:', refundErr);
                 }
                 return res.status(500).json({ status: finalResponse.status, message: finalResponse.remarks });
            }

            // Determine and return updated remainingCredits
            const updatedClient = isUnlimited
                ? { remainingCredits: 'Unlimited' } 
                : await clients.findOne({ _id: client._id }, { projection: { remainingCredits: 1 } });

            // Final API response
            return res.status(200).json({
                ...finalResponse,
                remainingCredits: isUnlimited ? 'Unlimited' : (updatedClient.remainingCredits ?? 0)
            });

        } catch (e) {
            console.error('POST /api/verify-single-address error:', e);
            return res.status(500).json({ status: 'Error', message: `Internal Server Error: ${e.message}` });
        }
    }

    return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' }); 
};

// Export core functions for use in bulk-jobs.js
module.exports.getIndiaPostData = getIndiaPostData;
module.exports.getGeminiResponse = getGeminiResponse;
module.exports.processAddress = processAddress;
module.exports.extractPin = extractPin;
module.exports.meaninglessRegex = meaninglessRegex;
module.exports.runVerificationLogic = runVerificationLogic;