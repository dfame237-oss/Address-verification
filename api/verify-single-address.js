// api/verify-single-address.js
// Merged: your original Gemini + IndiaPost logic + credits handling + auth + GET remainingCredits
// NOTE: Replace process.env.GEMINI_API_KEY and process.env.JWT_SECRET in your Vercel env.
const INDIA_POST_API = 'https://api.postalpincode.in/pincode/'; [cite_start]// [cite: 145]
let pincodeCache = {};

const testingKeywords = ['test', 'testing', 'asdf', 'qwer', 'zxcv', 'random', 'gjnj', 'fgjnj']; [cite_start]// [cite: 145]
const coreMeaningfulWords = [
    "ddadu", "ddadu", "ai", "add", "add-", "raw", "dumping", "grand", "dumping grand",
    "chd", "chd-", "chandigarh", "chandigarh-", "chandigarh", "west", "sector", "sector-",
    "house", "no", "no#", "house no", "house no#", "floor", "first", "first floor",
    "majra", "colony", "dadu", "dadu majra", "shop", "wine", "wine shop", "house", "number",
    "tq", "job", "dist"
]; [cite_start]// [cite: 146]
const meaningfulWords = [...coreMeaningfulWords, ...testingKeywords]; [cite_start]// [cite: 147]
const meaninglessRegex = new RegExp(`\\b(?:${meaningfulWords.join('|')})\\b`, 'gi'); [cite_start]// [cite: 147]
const directionalKeywords = ['near', 'opposite', 'back side', 'front side', 'behind', 'opp']; [cite_start]// [cite: 148]
// --- DB helper and auth ---
const { connectToDatabase } = require('../db'); [cite_start]// [cite: 149]
const jwt = require('jsonwebtoken'); [cite_start]// [cite: 149]
const { ObjectId } = require('mongodb'); [cite_start]// [cite: 150]

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret'; [cite_start]// [cite: 150]
// --- India Post helper ---
async function getIndiaPostData(pin) {
    if (!pin) return { PinStatus: 'Error' }; [cite_start]// [cite: 151]
    if (pincodeCache[pin]) return pincodeCache[pin]; [cite_start]// [cite: 152]

    try {
        const response = await fetch(INDIA_POST_API + pin); [cite_start]// [cite: 152]
        const data = await response.json(); [cite_start]// [cite: 153]
        const postData = data[0]; [cite_start]// [cite: 153]

        if (response.status !== 200 || postData.Status !== 'Success') {
            pincodeCache[pin] = { PinStatus: 'Error' }; [cite_start]// [cite: 154]
            return pincodeCache[pin]; [cite_start]// [cite: 154]
        }

        const postOffices = postData.PostOffice.map(po => ({
            Name: po.Name || '',
            Taluk: po.Taluk || po.SubDistrict || '',
            District: po.District || '',
            State: po.State || ''
        })); [cite_start]// [cite: 154, 155]
        pincodeCache[pin] = {
            PinStatus: 'Success',
            PostOfficeList: postOffices,
        }; [cite_start]// [cite: 155]
        return pincodeCache[pin]; [cite_start]// [cite: 156]
    } catch (e) {
        console.error("India Post API Error:", e.message); [cite_start]// [cite: 156]
        pincodeCache[pin] = { PinStatus: 'Error' }; [cite_start]// [cite: 157]
        return pincodeCache[pin]; [cite_start]// [cite: 157]
    }
}

// --- Gemini helper (unchanged) ---
async function getGeminiResponse(prompt) {
    const apiKey = process.env.GEMINI_API_KEY; [cite_start]// [cite: 157]
    if (!apiKey) {
        return { text: null, error: "Gemini API key not set in environment variables."
        }; [cite_start]// [cite: 158, 159]
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; [cite_start]// [cite: 159]

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
    }; [cite_start]// [cite: 159]
    const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    }; [cite_start]// [cite: 160]
    try {
        const response = await fetch(apiUrl, options); [cite_start]// [cite: 161]
        const result = await response.json(); [cite_start]// [cite: 162]
        if (response.status !== 200) {
            const errorMessage = `Gemini API Error: ${result.error?.message ||
            "Unknown error."}`; [cite_start]// [cite: 162, 163]
            console.error(errorMessage); [cite_start]// [cite: 163]
            return { text: null, error: errorMessage }; [cite_start]// [cite: 163]
        }

        if (result.candidates && result.candidates.length > 0) {
            return { text: result.candidates[0].content.parts[0].text, error: null }; [cite_start]// [cite: 164]
        } else {
            const errorMessage = "Gemini API Error: No candidates found in response."; [cite_start]// [cite: 165]
            console.error(errorMessage); [cite_start]// [cite: 166]
            return { text: null, error: errorMessage }; [cite_start]// [cite: 166]
        }
    } catch (e) {
        const errorMessage = `Error during Gemini API call: ${e.message}`; [cite_start]// [cite: 166, 167]
        console.error(errorMessage); [cite_start]// [cite: 167]
        return { text: null, error: errorMessage }; [cite_start]// [cite: 167]
    }
}

// --- Utilities from your original file ---
function extractPin(address) {
    const match = String(address).match(/\b\d{6}\b/); [cite_start]// [cite: 167, 168]
    return match ? match[0] : null; [cite_start]// [cite: 168]
}

function buildGeminiPrompt(originalAddress, postalData) {
    let basePrompt = `You are an expert Indian address verifier and formatter.
Your task is to process a raw address, perform a thorough analysis, and provide a comprehensive response in a single JSON object.
Provide all responses in English only. Strictly translate all extracted address components to English.
Correct all common spelling and phonetic errors in the provided address, such as "rd" to "Road", "nager" to "Nagar", and "nd" to "2nd".
Analyze common short forms and phonetic spellings, such as "lean" for "Lane", and use your best judgment to correct them.
Be strict about ensuring the output is a valid, single, and complete address for shipping.
Use your advanced knowledge to identify and remove any duplicate address components that are present consecutively (e.g., 'Gandhi Street Gandhi Street' should be 'Gandhi Street').
Your response must contain the following keys:
1.  "H.no.", "Flat No.", "Plot No.", "Room No.", "Building No.", "Block No.", "Ward No.", "Gali No.", "Zone No.": Extract only the number or alphanumeric sequence (e.g., '1-26', 'A/25', '10').
Set to null if not found.
2.  "Colony", "Street", "Locality", "Building Name", "House Name", "Floor": Extract the name.
3.  "P.O.": The official Post Office name from the PIN data. Prepend "P.O." to the name. Example: "P.O. Boduppal".
4.  "Tehsil": The official Tehsil/SubDistrict from the PIN data. Prepend "Tehsil". Example: "Tehsil Pune".
5.  "DIST.": The official District from the PIN data.
6.  "State": The official State from the PIN data.
7.  "PIN": The 6-digit PIN code. Find and verify the correct PIN.
If a PIN exists in the raw address but is incorrect, find the correct one and provide it.
8.  "Landmark": A specific, named landmark (e.g., "Apollo Hospital"), not a generic type like "school".
If multiple landmarks are present, list them comma-separated. **Extract the landmark without any directional words like 'near', 'opposite', 'behind' etc., as this will be handled by the script.**
9.  "Remaining": A last resort for any text that does not fit into other fields.
Clean this by removing meaningless words like 'job', 'raw', 'add-', 'tq', 'dist' and country, state, district, or PIN code.
10. "FormattedAddress": This is the most important field. Based on your full analysis, create a single, clean, human-readable, and comprehensive shipping-ready address string.
It should contain all specific details (H.no., Room No., etc.), followed by locality, street, colony, P.O., Tehsil, and District.
DO NOT include the State or PIN in this string. Use commas to separate logical components.
Do not invent or "hallucinate" information.
11. "LocationType": Identify the type of location (e.g., "Village", "Town", "City", "Urban Area").
12. "AddressQuality": Analyze the address completeness and clarity for shipping.
Categorize it as one of the following: Very Good, Good, Medium, Bad, or Very Bad.
13. "LocationSuitability": Analyze the location based on its State, District, and PIN to determine courier-friendliness in India.
Categorize it as one of the following: Prime Location, Tier 1 & 2 Cities, Remote/Difficult Location, or Non-Serviceable Location.
Raw Address: "${originalAddress}"
`; [cite_start]// [cite: 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193]

    if (postalData.PinStatus === 'Success') {
        basePrompt += `\nOfficial Postal Data: ${JSON.stringify(postalData.PostOfficeList)}\nUse this list to find the best match for 'P.O.', 'Tehsil', and 'DIST.'
fields.`; [cite_start]// [cite: 193, 194]
    } else {
        basePrompt += `\nAddress has no PIN or the PIN is invalid.
You must find and verify the correct 6-digit PIN. If you cannot find a valid PIN, set "PIN" to null and provide the best available data.`; [cite_start]// [cite: 194, 195, 196]
    }

    basePrompt += `\nYour entire response MUST be a single, valid JSON object starting with { and ending with } and contain ONLY the keys listed above.`; [cite_start]// [cite: 196, 197]
    return basePrompt;
}

function processAddress(address, postalData) {
    const prompt = buildGeminiPrompt(address, postalData); [cite_start]// [cite: 197]
    return getGeminiResponse(prompt); [cite_start]// [cite: 198]
}

// --- Main Handler (merged) ---
module.exports = async (req, res) => {
    // CORS - keep your original origin for security
    res.setHeader('Access-Control-Allow-Credentials', true); [cite_start]// [cite: 198, 199]
    res.setHeader('Access-Control-Allow-Origin', 'https://dfame237-oss.github.io/Address-verification'); [cite_start]// [cite: 199]
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); [cite_start]// [cite: 199]
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'); [cite_start]// [cite: 199]
    if (req.method === 'OPTIONS') {
        res.status(200).end(); [cite_start]// [cite: 200]
        return; [cite_start]// [cite: 201]
    }

    // Connect DB early (used for credits)
    let db;
    try {
        const dbResult = await connectToDatabase(); [cite_start]// [cite: 202]
        db = dbResult.db; [cite_start]// [cite: 203]
    } catch (e) {
        console.error('DB connection failed in /api/verify-single-address:', e); [cite_start]// [cite: 203, 204]
        return res.status(500).json({ status: 'Error', error: 'Database connection failed.' }); [cite_start]// [cite: 204]
    }
    const clients = db.collection('clients'); [cite_start]// [cite: 204]
    
    // Helper: parse JWT payload from Authorization header
    function parseJwtFromHeader(req) {
        const authHeader = req.headers.authorization || [cite_start]// [cite: 205]
        req.headers.Authorization; [cite_start]// [cite: 206]
        if (!authHeader) return null; [cite_start]// [cite: 206]
        const parts = authHeader.split(' '); [cite_start]// [cite: 206]
        if (parts.length !== 2) return null; [cite_start]// [cite: 207]
        const token = parts[1]; [cite_start]// [cite: 207]
        try {
            const payload = jwt.verify(token, JWT_SECRET); [cite_start]// [cite: 207]

            // 🛑 FIX: Check for the required 'clientId' and ensure it exists
            if (!payload || !payload.clientId) {
                // If token is valid but the payload structure is wrong, treat as invalid
                console.warn("JWT Payload missing 'clientId' in verify-single-address.");
                return null;
            }

            return payload; [cite_start]// [cite: 208]
        } catch (e) {
            // Token verification failed (expired, tampered, etc.)
            return null; [cite_start]// [cite: 208, 209]
        }
    }

    // GET: return remaining credits for authenticated client (no consumption)
    if (req.method === 'GET') {
        const jwtPayload = parseJwtFromHeader(req); [cite_start]// [cite: 209, 210]
        if (!jwtPayload || !jwtPayload.clientId) {
            return res.status(401).json({ status: 'Error', message: 'Authentication required.' }); [cite_start]// [cite: 210, 211]
        }
        try {
            const client = await clients.findOne({ _id: new ObjectId(jwtPayload.clientId) }, { projection: { remainingCredits: 1, initialCredits: 1, planName: 1 } }); [cite_start]// [cite: 211]
            if (!client) return res.status(404).json({ status: 'Error', message: 'Client not found.' }); [cite_start]// [cite: 212]
            return res.status(200).json({
                status: 'Success',
                remainingCredits: client.remainingCredits ?? 0,
                initialCredits: client.initialCredits ?? 0,
                planName: client.planName ?? null
            }); [cite_start]// [cite: 213, 214]
        } catch (e) {
            console.error('GET /api/verify-single-address error:', e); [cite_start]// [cite: 214, 215]
            return res.status(500).json({ status: 'Error', message: 'Internal server error.' }); [cite_start]// [cite: 215]
        }
    }

    // POST: process verification with credits logic
    if (req.method === 'POST') {
        // Authenticate
        const jwtPayload = parseJwtFromHeader(req); [cite_start]// [cite: 215, 216]
        if (!jwtPayload || !jwtPayload.clientId) {
            return res.status(401).json({ status: 'Error', message: 'Authentication required.' }); [cite_start]// [cite: 216, 217]
        }
        const clientId = jwtPayload.clientId; [cite_start]// [cite: 217, 218]
        // Parse request body
        let body = req.body; [cite_start]// [cite: 218, 219]
        if (typeof body === 'string') {
            try { body = JSON.parse(body); [cite_start]// [cite: 219, 220]
            } catch (e) { /* keep original */ }
        }
        const { address, customerName } = body || [cite_start]// [cite: 220, 221]
        {}; [cite_start]// [cite: 221]
        if (!address) {
            return res.status(400).json({ status: 'Error', error: 'Address is required.' }); [cite_start]// [cite: 221, 222]
        }

        try {
            // Load client doc
            const client = await clients.findOne({ _id: new ObjectId(clientId) }); [cite_start]// [cite: 222, 223]
            if (!client) return res.status(404).json({ status: 'Error', message: 'Client not found.' }); [cite_start]// [cite: 223]

            const initialPin = extractPin(address); [cite_start]// [cite: 223, 224]
            let postalData = { PinStatus: 'Error' }; [cite_start]// [cite: 224]
            if (initialPin) postalData = await getIndiaPostData(initialPin); [cite_start]// [cite: 224, 225]
            // Determine if plan is Unlimited
            const remaining = client.remainingCredits; [cite_start]// [cite: 225, 226]
            const initial = client.initialCredits; [cite_start]// [cite: 226]
            const isUnlimited = (remaining === 'Unlimited' || initial === 'Unlimited' || String(initial).toLowerCase() === 'unlimited'); [cite_start]// [cite: 226, 227]
            let reserved = false; [cite_start]// [cite: 227]

            if (!isUnlimited) {
                // Atomically decrement remainingCredits if it's > 0
                const reserveResult = await clients.findOneAndUpdate(
                    { _id: client._id, remainingCredits: { $gt: 0 } },
                    { $inc: { 
                [cite_start]remainingCredits: -1 }, $set: { lastActivityAt: new Date() } }, // [cite: 228]
                    { returnDocument: 'after' }
                ); [cite_start]// [cite: 228, 229]
                if (!reserveResult.value) {
                    return res.status(200).json({
                        status: 'QuotaExceeded',
                        message: 'You have exhausted your verification credits. Contact support to purchase more credits or upgrade your plan.',
            
                        remainingCredits: client.remainingCredits ?? 0
                    }); [cite_start]// [cite: 229, 230, 231]
                }

                reserved = true; [cite_start]// [cite: 231, 232]
            } else {
                // Unlimited: update lastActivityAt only
                await clients.updateOne({ _id: client._id }, { $set: { lastActivityAt: new Date() } }); [cite_start]// [cite: 232, 233]
            }

            // Now run your original Gemini + IndiaPost verification workflow
            let remarks = []; [cite_start]// [cite: 233]
            const cleanedName = (customerName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim() || null; [cite_start]// [cite: 234, 235]
            // Call Gemini/Gemini-processing using your build/process functions
            const geminiResult = await processAddress(address, postalData); [cite_start]// [cite: 235, 236]
            if (geminiResult.error || !geminiResult.text) {
                // Refund reserved credit if external failed
                if (reserved) {
                    try {
                        await clients.updateOne({ _id: client._id }, { $inc: { remainingCredits: 1 } 
                        }); [cite_start]// [cite: 236, 237]
                    } catch (refundErr) {
                        console.error('Failed to refund reserved credit after Gemini error:', refundErr); [cite_start]// [cite: 237, 238]
                    }
                }
                return res.status(500).json({ status: 'Error', error: geminiResult.error || 'Gemini API failed to return text.' }); [cite_start]// [cite: 238, 239]
            }

            // Parse Gemini JSON output (your original parse logic)
            let parsedData; [cite_start]// [cite: 239, 240]
            try {
                const jsonText = geminiResult.text.replace(/```json|```/g, '').trim(); [cite_start]// [cite: 240, 241]
                parsedData = JSON.parse(jsonText); [cite_start]// [cite: 241]
            } catch (e) {
                console.error('JSON Parsing Error:', e.message); [cite_start]// [cite: 242]
                remarks.push(`CRITICAL_ALERT: JSON parse failed. Raw Gemini Output: ${String(geminiResult.text || '').substring(0, 50)}...`); [cite_start]// [cite: 242, 243]
                parsedData = {
                    FormattedAddress: address.replace(meaninglessRegex, '').trim(),
                    Landmark: '',
                    State: '',
                    DIST: '',
             
                    [cite_start]PIN: initialPin, // [cite: 244]
                    AddressQuality: 'Very Bad',
                    Remaining: remarks[0],
                }; [cite_start]// [cite: 244, 245]
            }

            // PIN verification/correction logic (kept from original)
            let finalPin = String(parsedData.PIN).match(/\b\d{6}\b/) ? [cite_start]// [cite: 245, 246]
            parsedData.PIN : initialPin; [cite_start]// [cite: 246]
            let primaryPostOffice = postalData.PostOfficeList ? postalData.PostOfficeList[0] : {}; [cite_start]// [cite: 246, 247]
            if (finalPin) {
                if (postalData.PinStatus !== 'Success' || (initialPin && finalPin !== initialPin)) {
                    const aiPostalData = await getIndiaPostData(finalPin); [cite_start]// [cite: 247, 248]
                    if (aiPostalData.PinStatus === 'Success') {
                        postalData = aiPostalData; [cite_start]// [cite: 248, 249]
                        primaryPostOffice = postalData.PostOfficeList[0] || {}; [cite_start]// [cite: 249]
                        if (initialPin && initialPin !== finalPin) {
                            remarks.push(`CRITICAL_ALERT: Wrong PIN (${initialPin}) corrected to (${finalPin}).`); [cite_start]// [cite: 249, 250]
                        } else if (!initialPin) {
                            remarks.push(`Correct PIN (${finalPin}) added by AI.`); [cite_start]// [cite: 250, 251]
                        }
                    } else {
                        remarks.push(`CRITICAL_ALERT: AI-provided PIN (${finalPin}) not verified by API.`); [cite_start]// [cite: 251, 252]
                        finalPin = initialPin; [cite_start]// [cite: 252]
                    }
                } else if (initialPin && postalData.PinStatus === 'Success') {
                    remarks.push(`PIN (${initialPin}) verified successfully.`); [cite_start]// [cite: 252, 253]
                }
            } else {
                remarks.push('CRITICAL_ALERT: PIN not found after verification attempts. Manual check needed.'); [cite_start]// [cite: 253, 254]
                finalPin = initialPin || null; [cite_start]// [cite: 254]
            }

            if (parsedData.FormattedAddress && parsedData.FormattedAddress.length < 35 && parsedData.AddressQuality !== 'Very Good' && parsedData.AddressQuality !== 'Good') {
                remarks.push(`CRITICAL_ALERT: Formatted address is short (${parsedData.FormattedAddress.length} chars). Manual verification recommended.`); [cite_start]// [cite: 254, 255]
            }

            // Landmark directional prefix logic (kept from original)
            let landmarkValue = parsedData.Landmark || [cite_start]// [cite: 255, 256]
            ''; [cite_start]// [cite: 256]
            const originalAddressLower = address.toLowerCase(); [cite_start]// [cite: 256]
            let finalLandmark = ''; [cite_start]// [cite: 256]
            if (landmarkValue.toString().trim() !== '') {
                const foundDirectionalWord = directionalKeywords.find(keyword => originalAddressLower.includes(keyword)); [cite_start]// [cite: 257]
                if (foundDirectionalWord) {
                    const originalDirectionalWordMatch = address.match(new RegExp(`\\b${foundDirectionalWord.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i')); [cite_start]// [cite: 257, 258]
                    const originalDirectionalWord = originalDirectionalWordMatch ? originalDirectionalWordMatch[0] : foundDirectionalWord; [cite_start]// [cite: 258]
                    const prefixedWord = originalDirectionalWord.charAt(0).toUpperCase() + originalDirectionalWord.slice(1); [cite_start]// [cite: 258]
                    finalLandmark = `${prefixedWord} ${landmarkValue.toString().trim()}`; [cite_start]// [cite: 259]
                } else {
                    finalLandmark = `Near ${landmarkValue.toString().trim()}`; [cite_start]// [cite: 259, 260]
                }
            }

            if (parsedData.Remaining && parsedData.Remaining.trim() !== '') {
                remarks.push(`Remaining/Ambiguous Text: ${parsedData.Remaining.trim()}`); [cite_start]// [cite: 260, 261]
            } else if (remarks.length === 0) {
                remarks.push('Address verified and formatted successfully.'); [cite_start]// [cite: 261, 262]
            }

            // Build final response (kept original keys)
            const finalResponse = {
                status: "Success",
                customerRawName: customerName,
                customerCleanName: cleanedName,
                
                addressLine1: parsedData.FormattedAddress || address.replace(meaninglessRegex, '').trim() || [cite_start]'', // [cite: 263]
                [cite_start]landmark: finalLandmark, // [cite: 263]
                postOffice: primaryPostOffice.Name || [cite_start]// [cite: 263, 264]
                parsedData['P.O.'] || [cite_start]'', // [cite: 264]
                tehsil: primaryPostOffice.Taluk || [cite_start]// [cite: 264, 265]
                parsedData.Tehsil || [cite_start]'', // [cite: 265]
                district: primaryPostOffice.District || [cite_start]// [cite: 265, 266]
                parsedData['DIST.'] || [cite_start]'', // [cite: 266]
                state: primaryPostOffice.State || [cite_start]// [cite: 266, 267]
                parsedData.State || [cite_start]'', // [cite: 267]
                [cite_start]pin: finalPin, // [cite: 267]
                addressQuality: parsedData.AddressQuality || [cite_start]// [cite: 268]
                [cite_start]'Medium', // [cite: 268]
                locationType: parsedData.LocationType || [cite_start]// [cite: 269]
                [cite_start]'Unknown', // [cite: 269]
                locationSuitability: parsedData.LocationSuitability || [cite_start]// [cite: 270]
                [cite_start]'Unknown', // [cite: 270]
                [cite_start]remarks: remarks.join('; ').trim(), // [cite: 270]
            }; [cite_start]// [cite: 271]
            // Determine and return updated remainingCredits
            const updatedClient = isUnlimited
                ? [cite_start]// [cite: 271, 272]
                [cite_start]{ remainingCredits: 'Unlimited' } // [cite: 272]
                : await clients.findOne({ _id: client._id }, { projection: { remainingCredits: 1 } }); [cite_start]// [cite: 272, 273]
            return res.status(200).json({
                ...finalResponse,
                remainingCredits: isUnlimited ? 'Unlimited' : (updatedClient.remainingCredits ?? 0)
            }); [cite_start]// [cite: 273, 274]
        } catch (e) {
            console.error('POST /api/verify-single-address error:', e); [cite_start]// [cite: 274, 275]
            return res.status(500).json({ status: 'Error', message: `Internal Server Error: ${e.message}` }); [cite_start]// [cite: 275, 276]
        }
    }

    // Method not allowed
    return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' }); [cite_start]// [cite: 276, 277]
};