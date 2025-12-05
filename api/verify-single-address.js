// api/verify-single-address.js
// Final Logic: Deterministic India Post Matching + Strict AI Formatting

const INDIA_POST_API = 'https://api.postalpincode.in/pincode/'; 
let pincodeCache = {};

// --- 1. CONFIGURATION & KEYWORDS ---
const testingKeywords = ['test', 'testing', 'asdf', 'qwer', 'zxcv', 'random', 'gjnj', 'fgjnj'];
const coreMeaningfulWords = [
    "ddadu", "ddadu", "ai", "add", "add-", "raw", "dumping", "grand", "dumping grand",
    "chd", "chd-", "chandigarh", "chandigarh-", "chandigarh", "west", "sector", "sector-",
    "house", "no", "no#", "house no", "house no#", "floor", "first", "first floor",
    "majra", "colony", "dadu", "dadu majra", "shop", "wine", "wine shop", "house", "number",
    "tq", "job", "dist"
];
const meaningfulWords = [...coreMeaningfulWords, ...testingKeywords]; 

const meaninglessRegex = (() => {
    try {
        return new RegExp(`\\b(?:${meaningfulWords.join('|')})\\b`, 'gi');
    } catch (e) {
        console.error("Failed to compile meaninglessRegex:", e);
        return /a^/; 
    }
})();

const directionalKeywords = ['near', 'opposite', 'back side', 'front side', 'behind', 'opp', 'beside', 'in front', 'above', 'below', 'next to'];

// --- 2. DATABASE & AUTH ---
const { connectToDatabase } = require('../utils/db');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb'); 
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';

// --- 3. INDIA POST API HELPER ---
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

// --- 4. DETERMINISTIC P.O. MATCHING (NEW) ---
/**
 * Scans the raw address to find if any official Post Office name exists in it.
 * This prevents the AI from guessing.
 */
function findBestPOMatch(rawAddress, postOfficeList) {
    if (!postOfficeList || postOfficeList.length === 0) return null;
    
    const normalizedAddress = rawAddress.toLowerCase().replace(/[^\w\s]/g, ' ');
    
    // Sort P.O.s by length (longest first) to match "Kharghar Sector 10" before "Kharghar"
    const sortedPOs = [...postOfficeList].sort((a, b) => b.Name.length - a.Name.length);

    // 1. Exact Name Match (Best)
    for (const po of sortedPOs) {
        const normalizedPO = po.Name.toLowerCase().replace(/[^\w\s]/g, ' ');
        // Check if the PO name appears as a whole word in the address
        const regex = new RegExp(`\\b${normalizedPO}\\b`, 'i');
        if (regex.test(normalizedAddress)) {
            return po; // Found strict match (e.g., "Kharghar" is in "Sector 19 Kharghar")
        }
    }

    // 2. Fallback: If no direct name match, check if the raw address *starts* or *ends* with a partial
    // (Skipped for now to avoid false positives. If no match, we let AI decide from the list).
    
    return null; // No clear match found
}


// --- 5. GEMINI API HELPER ---
async function getGeminiResponse(prompt) { 
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return { text: null, error: "Gemini API key not set." };
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; 

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        // CRITICAL: Temperature 0 for strictly deterministic output (No Hallucinations)
        generationConfig: {
            temperature: 0.0,
            topP: 0.8,
            topK: 10
        }
    };

    const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    };

    try {
        const response = await fetch(apiUrl, options); 
        const result = await response.json();

        if (response.status !== 200 || result.error) {
            console.error(`Gemini API Error: ${result.error?.message}`); 
            return { text: null, error: "External AI verification service failure." }; 
        }

        if (result.candidates && result.candidates.length > 0) {
            return { text: result.candidates[0].content.parts[0].text, error: null };
        } else {
            return { text: null, error: "No candidates found." }; 
        }
    } catch (e) {
        console.error(`Network Error: ${e.message}`); 
        return { text: null, error: "Network issue contacting AI service." }; 
    }
}

// --- 6. UTILITIES ---
function extractPin(address) {
    const match = String(address).match(/\b\d{6}\b/);
    return match ? match[0] : null; 
}

function extractEmail(text) {
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/;
    const match = String(text).match(emailRegex);
    return match ? match[0] : null;
}

// --- 7. PROMPT ENGINEERING (STRICT) ---
function buildGeminiPrompt(originalAddress, postalData, forcedPO) {
    
    // If we already found the correct PO using code, we give it to the AI.
    // If not, we give the list and ask it to pick.
    const postOfficeInstruction = forcedPO 
        ? `**OFFICIAL DATA LOCKED:** We have identified the Post Office is "${forcedPO.Name}". \n   - You MUST set "P.O." to "${forcedPO.Name}".\n   - You MUST set "Dist." to "${forcedPO.District}".\n   - You MUST set "State" to "${forcedPO.State}".\n   - Do NOT change these.`
        : `**OFFICIAL POST OFFICE LIST:** ${JSON.stringify(postalData.PostOfficeList?.map(p => p.Name) || [])}\n   - You MUST select the Post Office name from this list that best matches the locality in the Raw Address.\n   - If the address mentions "Kharghar" and the list has "Kharghar", use "Kharghar".`;

    let basePrompt = `You are a strict Address Standardization Robot.
    
    Raw Address: "${originalAddress}"
    ${postOfficeInstruction}

    **STRICT RULES (NO HALLUCINATIONS):**
    1. **NO NEW INFORMATION:** Do NOT add landmarks, shops, or descriptors that are not in the Raw Address. (e.g. Do not add "Near Temple" if "Temple" is not written).
    2. **NO TRANSLATION:** Do NOT translate proper nouns. 
       - "Vadu Ali" must remain "Vadu Ali" (NOT "Vadu Alley").
       - "Nagar" must remain "Nagar" (NOT "City").
    3. **STRICT EXTRACTION:**
       - "H.no.": Extract House/Flat/Plot number.
       - "Street": Extract Street/Road name exactly.
       - "Locality": Extract the Area/Colony.
       - "Landmark": Extract ONLY if explicitly mentioned (e.g. "Opposite School"). Remove directional words ("Opposite") from the value.
    4. **FORMATTING:** Combine H.no, Street, Locality, P.O. into "FormattedAddress". Remove City/State/PIN from this string.

    **OUTPUT JSON:**
    {
      "H.no.": "string or null",
      "Street": "string or null",
      "Locality": "string or null",
      "Landmark": "string or null",
      "P.O.": "string (From Official List)",
      "Tehsil": "string (Taluk/SubDistrict)",
      "DIST.": "string (District)",
      "State": "string (State)",
      "PIN": "6-digit code",
      "FormattedAddress": "string",
      "AddressQuality": "Very Good/Good/Medium/Bad"
    }
`;
    return basePrompt;
}

function processAddress(address, postalData, forcedPO) {
    const prompt = buildGeminiPrompt(address, postalData, forcedPO); 
    return getGeminiResponse(prompt);
}

// --- 8. NAME CLEANER ---
async function getTranslatedCleanName(rawName) {
    if (!rawName) return null;
    // Simple regex clean to avoid AI overhead/hallucination on names
    return rawName.replace(/[^\w\s\.]/gi, '').replace(/\s+/g, ' ').trim(); 
}

// --- 9. MAIN VERIFICATION LOGIC ---
async function runVerificationLogic(address, customerName) {
    const originalAddress = String(address || '').trim();
    if (!originalAddress) {
        return { status: "Error", remarks: "Empty address.", success: false };
    }

    let remarks = [];
    
    // A. Email Check
    if (extractEmail(originalAddress)) {
        return {
            status: "Skipped", remarks: "CRITICAL_ALERT: Address contains email.", addressQuality: "Very Bad", success: false
        };
    }

    // B. Initial PIN & Data Fetch
    let currentPin = extractPin(originalAddress);
    let postalData = { PinStatus: 'Error' };
    let forcedPO = null;

    if (currentPin) {
        postalData = await getIndiaPostData(currentPin);
        // C. DETERMINISTIC PO MATCHING
        if (postalData.PinStatus === 'Success') {
            forcedPO = findBestPOMatch(originalAddress, postalData.PostOfficeList);
            if (forcedPO) {
                // remarks.push(`Verified Post Office: ${forcedPO.Name}`); // Optional debug
            }
        }
    }
    
    // D. Call AI
    const cleanedName = await getTranslatedCleanName(customerName);
    const geminiResult = await processAddress(originalAddress, postalData, forcedPO);

    if (geminiResult.error) {
        return { status: "Error", remarks: "AI Service Error", success: false };
    }

    // E. Parse & Validate
    let parsedData = {};
    try {
        parsedData = JSON.parse(geminiResult.text.replace(/```json|```/g, '').trim());
    } catch (e) {
        parsedData = { AddressQuality: "Very Bad", FormattedAddress: originalAddress };
        remarks.push("CRITICAL: AI JSON Error");
    }

    // F. PIN Correction Logic
    // If AI suggests a different PIN (and we didn't force a PO), verify the new PIN
    let finalPin = parsedData.PIN || currentPin;
    if (finalPin && finalPin !== currentPin) {
        const newPinData = await getIndiaPostData(finalPin);
        if (newPinData.PinStatus === 'Success') {
            postalData = newPinData;
            remarks.push(`PIN Corrected to ${finalPin}`);
            // Re-check PO match with new PIN data
            const newMatch = findBestPOMatch(originalAddress, postalData.PostOfficeList);
            if (newMatch) forcedPO = newMatch;
        } else {
            finalPin = currentPin; // Revert invalid AI PIN
        }
    }

    // G. FINAL DATA ENFORCEMENT (The "Fix")
    // Regardless of what AI said, if we have a Valid PIN & Data, we OVERWRITE District/State
    if (postalData.PinStatus === 'Success') {
        // 1. Identify the Definitive PO
        let finalPOObj = forcedPO;
        
        // If we didn't find a code-match, look up the AI's chosen PO in the list
        if (!finalPOObj && parsedData['P.O.']) {
            finalPOObj = postalData.PostOfficeList.find(p => p.Name.toLowerCase() === parsedData['P.O.'].toLowerCase());
        }
        
        // Fallback: Use the first PO in the list if still nothing matches (rare)
        if (!finalPOObj) finalPOObj = postalData.PostOfficeList[0];

        // 2. Overwrite Fields
        parsedData['P.O.'] = `P.O. ${finalPOObj.Name}`;
        parsedData['Tehsil'] = finalPOObj.Taluk || finalPOObj.SubDistrict || parsedData['Tehsil']; // Prefer API
        parsedData['DIST.'] = finalPOObj.District; // FORCE API DATA
        parsedData['State'] = finalPOObj.State;    // FORCE API DATA
    }

    // H. Formatting Cleanup
    const finalLandmark = parsedData.Landmark ? 
        (directionalKeywords.some(d => parsedData.Landmark.toLowerCase().startsWith(d)) 
            ? parsedData.Landmark 
            : `Near ${parsedData.Landmark}`) 
        : "";

    if (remarks.length === 0) remarks.push('Address verified.');

    return {
        status: "Success",
        customerRawName: customerName,
        customerCleanName: cleanedName,
        addressLine1: parsedData.FormattedAddress || originalAddress,
        landmark: finalLandmark,
        postOffice: parsedData['P.O.'] || '',
        tehsil: parsedData.Tehsil ? (parsedData.Tehsil.toLowerCase().includes('tehsil') ? parsedData.Tehsil : `Tehsil ${parsedData.Tehsil}`) : '',
        district: parsedData['DIST.'] || '',
        state: parsedData['State'] || '',
        pin: finalPin,
        addressQuality: parsedData.AddressQuality || 'Medium',
        locationType: 'Unknown',
        locationSuitability: 'Serviceable',
        remarks: remarks.join('; ').trim(),
        success: true
    };
}

// --- EXPORT ---
module.exports = async (req, res) => {
    // ... (Keep existing Auth/Express boilerplate logic here) ...
    
    // Example boilerplate for context:
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', 'https://dfame237-oss.github.io');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') try { body = JSON.parse(body); } catch (e) {}
        const { address, customerName } = body || {};
        
        try {
            const result = await runVerificationLogic(address, customerName);
            return res.status(200).json(result);
        } catch (e) {
            return res.status(500).json({ status: "Error", message: e.message });
        }
    }
    return res.status(405).json({ error: "Method not allowed" });
};

// Export Helpers
module.exports.runVerificationLogic = runVerificationLogic;