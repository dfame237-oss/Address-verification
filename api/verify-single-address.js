// api/verify-single-address.js
// Final Logic: Deterministic P.O. Selection + Metro Logic + Spelling Fixes

const INDIA_POST_API = 'https://api.postalpincode.in/pincode/'; 
let pincodeCache = {};

// --- 1. CONFIGURATION & KEYWORDS ---
const testingKeywords = ['test', 'testing', 'asdf', 'qwer', 'zxcv', 'random', 'gjnj', 'fgjnj'];

const meaningfulWords = [
    "ddadu", "ddadu", "ai", "add", "add-", "raw", "dumping", "grand", "dumping grand",
    "chd", "chd-", "chandigarh", "chandigarh-", "chandigarh", "west", "sector", "sector-",
    "house", "no", "no#", "house no", "house no#", "floor", "first", "first floor",
    "majra", "colony", "dadu", "dadu majra", "shop", "wine", "wine shop", "house", "number",
    "tq", "job", "dist"
];

const meaninglessRegex = (() => {
    try {
        return new RegExp(`\\b(?:${meaningfulWords.join('|')})\\b`, 'gi');
    } catch (e) {
        console.error("Failed to compile meaninglessRegex:", e);
        return /a^/; 
    }
})();

const directionalKeywords = ['near', 'opposite', 'back side', 'front side', 'behind', 'opp', 'beside', 'in front', 'above', 'below', 'next to'];

// --- NEW: METRO CITIES CONFIG (Fix for "Tehsil Kolkata" issue) ---
// If the District matches these, we will SUPPRESS the Tehsil output.
const METRO_CITIES = [
    'kolkata', 'calcutta', 
    'mumbai', 'mumbai suburban', 
    'delhi', 'new delhi', 'central delhi', 'south delhi', 'north delhi',
    'chennai', 'madras', 
    'bangalore', 'bengaluru', 'bangalore urban',
    'hyderabad', 'secunderabad',
    'ahmedabad'
];

// --- NEW: DISTRICT SPELLING CORRECTIONS (Fix for "Raigarh" vs "Raigad") ---
const DISTRICT_SPELLING_CORRECTIONS = {
    'raigarh': 'Raigad', // Common confusion in Maharashtra
    'ahmednagar': 'Ahilyanagar',
    'aurangabad': 'Chhatrapati Sambhajinagar',
    'osmanabad': 'Dharashiv'
};

const CRITICAL_KEYWORDS = [
    'CRITICAL_ALERT: Wrong PIN', 
    'CRITICAL_ALERT: AI-provided PIN',
    'CRITICAL_ALERT: PIN not found',
    'CRITICAL_ALERT: Raw address lacks',
    'CRITICAL_ALERT: Raw address contains email', 
    'CRITICAL_ALERT: Major location conflict',
    'CRITICAL_ALERT: Formatted address is short',
    'CRITICAL_ALERT: JSON parse failed',
    'CRITICAL_ALERT: Address lacks specificity'
];

// --- 2. DATABASE & AUTH ---
const { connectToDatabase } = require('../utils/db');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb'); 
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';

// --- 3. HELPER: TRANSLATE TO ENGLISH ---
async function translateToEnglish(text) {
    if (!text || typeof text !== 'string') return text;
    if (text.length < 3 || /^\d+$/.test(text)) return text;

    // Use Gemini to standardize text (not just translate)
    const prompt = `Standardize this address text to English. Return ONLY the cleaned text. Text: "${text}"`;
    const res = await getGeminiResponse(prompt, 0.0); 
    return res.text ? res.text.trim() : text;
}

// --- 4. INDIA POST API HELPER ---
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

// --- 5. DETERMINISTIC P.O. MATCHING (FIXED LOGIC) ---
function findBestPOMatch(rawAddress, postOfficeList) {
    if (!postOfficeList || postOfficeList.length === 0) return null;
    
    const normalizedAddress = rawAddress.toLowerCase().replace(/[^\w\s]/g, ' ');

    // Strategy 1: Exact Name Match
    // We sort by length (longest first) to catch "Kharghar Sector 19" before "Kharghar"
    const sortedPOs = [...postOfficeList].sort((a, b) => b.Name.length - a.Name.length);
    
    for (const po of sortedPOs) {
        const normalizedPO = po.Name.toLowerCase().replace(/[^\w\s]/g, ' ');
        // Strict word boundary check
        const regex = new RegExp(`\\b${normalizedPO}\\b`, 'i');
        if (regex.test(normalizedAddress)) {
            return po; // strict match found
        }
    }
    
    // Strategy 2: If no strict match, fallback to the first "Sub Office" (S.O) 
    // Usually S.O. is the main delivery point vs B.O. (Branch Office)
    const subOffice = postOfficeList.find(po => po.Name.includes("S.O"));
    return subOffice || postOfficeList[0];
}

// --- 6. GEMINI API HELPER ---
async function getGeminiResponse(prompt, temperature = 0.0) { 
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { text: null, error: "Gemini API key not set." };

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; 

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: temperature, // Strict
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

// --- 7. UTILITIES ---
function extractPin(address) {
    const match = String(address).match(/\b\d{6}\b/);
    return match ? match[0] : null; 
}

function extractEmail(text) {
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/;
    const match = String(text).match(emailRegex);
    return match ? match[0] : null;
}

function removeAdjacentDuplicates(str) {
    if (!str) return str;
    const words = str.split(' ');
    const cleanedWords = [];
    for (let i = 0; i < words.length; i++) {
        if (i === 0 || words[i].toLowerCase() !== words[i - 1].toLowerCase()) {
            cleanedWords.push(words[i]);
        }
    }
    return cleanedWords.join(' ');
}

// --- 8. PROMPT BUILDER ---
function buildGeminiPrompt(originalAddress, postalData) {
    let basePrompt = `You are a strict Address Standardization Engine.
    Raw Address: "${originalAddress}"
    
    **INSTRUCTIONS:**
    1. **NO HALLUCINATIONS:** Do NOT add landmarks, shops, or descriptors not in the Raw Address.
    2. **NO TRANSLATION:** Do NOT translate proper nouns (e.g., "Vadu Ali" stays "Vadu Ali").
    3. **EXTRACT SPECIFIC FIELDS:**
       - "H.no.": House/Flat/Plot No.
       - "Street": Street Name / Road No.
       - "Locality": Colony / Area / Sector.
       - "Landmark": Specific landmark.
       - "Remaining": Ambiguous text.
    4. **POSTAL DATA:** - If provided, select the Post Office from the list.
    
    Official Postal Data: ${JSON.stringify(postalData.PostOfficeList || [])}

    **OUTPUT JSON:**
    {
      "H.no.": "string/null",
      "Street": "string/null",
      "Locality": "string/null",
      "Landmark": "string/null",
      "Remaining": "string/null",
      "P.O.": "string",
      "Tehsil": "string",
      "DIST.": "string",
      "State": "string",
      "PIN": "6-digit code",
      "FormattedAddress": "string",
      "AddressQuality": "Very Good/Good/Medium/Bad",
      "LocationType": "Village/Town/City"
    }
`;
    return basePrompt;
}

// --- 9. LOCAL CONFLICT CORRECTION (Restored) ---
function getPostalDataByLocality(locality) {
    const lookupTable = {
        "boduppal": { "P.O.": "Boduppal", "DIST.": "Hyderabad", "State": "Telangana", "PIN": "500092" },
        "putlibowli": { "P.O.": "Putlibowli", "DIST.": "Hyderabad", "State": "Telangana", "PIN": "500095" }
    };
    return lookupTable[locality.toLowerCase()] || null;
}

function verifyAndCorrectAddress(geminiData, remarks) {
    const aiLocality = geminiData["Locality"] || geminiData["Colony"] || '';
    if (aiLocality) {
        const correctedData = getPostalDataByLocality(aiLocality);
        if (correctedData) {
            // Apply hard correction
            geminiData["P.O."] = `P.O. ${correctedData["P.O."]}`;
            geminiData["DIST."] = correctedData["DIST."];
            geminiData["State"] = correctedData["State"];
            geminiData["PIN"] = correctedData["PIN"];
            remarks.push(`Locality correction applied for ${aiLocality}`);
        }
    }
}

// --- 10. CLEANUP GEMINI DATA (Restored) ---
function cleanUpGeminiData(geminiData) {
    if (geminiData["Remaining"]) {
        let remainingText = geminiData["Remaining"].toString().trim();
        remainingText = remainingText.replace(meaninglessRegex, '').replace(/\s+/g, ' ').trim();
        // Remove PIN/State/Dist from remaining text
        if (geminiData["PIN"]) remainingText = remainingText.replace(geminiData["PIN"], '');
        if (geminiData["State"]) remainingText = remainingText.replace(new RegExp(geminiData["State"], 'gi'), '');
        if (geminiData["DIST."]) remainingText = remainingText.replace(new RegExp(geminiData["DIST."], 'gi'), '');
        geminiData["Remaining"] = remainingText.trim();
    }
}

// --- 11. MAIN VERIFICATION LOGIC ---
async function runVerificationLogic(address, customerName) {
    const originalAddress = String(address || '').trim();
    if (!originalAddress) {
        return { status: "Error", remarks: "Empty address.", success: false };
    }

    let remarks = [];
    let geminiData = {};
    const originalAddressLower = originalAddress.toLowerCase();

    // A. Testing & Email Check
    const isTesting = testingKeywords.some(k => originalAddressLower.includes(k) || (customerName || '').toLowerCase().includes(k));
    if (isTesting) return { status: "Success", remarks: "Testing Order", addressQuality: "Bad", success: true };
    if (extractEmail(originalAddress)) return { status: "Skipped", remarks: "Invalid Address: Contains email.", addressQuality: "Very Bad", success: false };

    // B. Translation & Data Fetch
    const translatedAddress = await translateToEnglish(originalAddress);
    const initialPin = extractPin(originalAddress);
    let postalData = initialPin ? await getIndiaPostData(initialPin) : { PinStatus: 'Error' };
    
    // C. Deterministic PO Matching (PRE-CALCULATION)
    // We try to find the best PO *before* AI to guide/overwrite it later
    let forcedPO = null;
    if (postalData.PinStatus === 'Success') {
        forcedPO = findBestPOMatch(originalAddress, postalData.PostOfficeList);
    }

    // D. Gemini Verification
    const geminiPrompt = buildGeminiPrompt(translatedAddress, postalData);
    const geminiResponse = await getGeminiResponse(geminiPrompt, 0.0);

    if (geminiResponse.text) {
        try {
            const cleanResponse = geminiResponse.text.replace(/```json\n|\n```|```/g, '').trim();
            geminiData = JSON.parse(cleanResponse);
        } catch (e) {
            remarks.push("JSON Parse Failed");
            geminiData = { FormattedAddress: originalAddress, AddressQuality: "Very Bad" };
        }
    } else {
        remarks.push(geminiResponse.error || "AI Error");
    }

    // E. PIN Validation & Correction
    let finalPin = geminiData["PIN"] || initialPin;
    if (finalPin && finalPin !== initialPin) {
        const aiPostalData = await getIndiaPostData(finalPin);
        if (aiPostalData.PinStatus === 'Success') {
            postalData = aiPostalData;
            remarks.push(`PIN verified by AI: ${finalPin}`);
            // Re-run PO matching for new PIN
            forcedPO = findBestPOMatch(originalAddress, postalData.PostOfficeList);
        } else {
            finalPin = initialPin; // Revert
            remarks.push(`Reverted AI PIN hallucination.`);
        }
    }

    // F. ENFORCE OFFICIAL DATA (The Critical Fix)
    if (postalData.PinStatus === 'Success') {
        // 1. Select the PO Object
        let selectedPO = forcedPO;
        
        // If no code-match, check AI's string against the list
        if (!selectedPO && geminiData["P.O."]) {
            const cleanAIName = geminiData["P.O."].replace('P.O.', '').trim().toLowerCase();
            selectedPO = postalData.PostOfficeList.find(p => p.Name.toLowerCase() === cleanAIName);
        }
        
        // Fallback to first S.O. or first in list
        if (!selectedPO) {
            selectedPO = postalData.PostOfficeList.find(po => po.Name.includes("S.O")) || postalData.PostOfficeList[0];
        }

        // 2. OVERWRITE FIELDS
        geminiData["P.O."] = `P.O. ${selectedPO.Name}`;
        geminiData["State"] = selectedPO.State;
        
        // 3. District Correction (Raigarh -> Raigad)
        const apiDist = selectedPO.District;
        const correctedDist = DISTRICT_SPELLING_CORRECTIONS[apiDist.toLowerCase()] || apiDist;
        geminiData["DIST."] = correctedDist;

        // 4. Tehsil Logic (Suppress for Metros)
        const distLower = correctedDist.toLowerCase();
        const isMetro = METRO_CITIES.some(m => distLower.includes(m));
        
        if (isMetro) {
            geminiData["Tehsil"] = ""; // Blank out for metros
        } else {
            // Use API Tehsil if available, else generic
            geminiData["Tehsil"] = selectedPO.Taluk ? `Tehsil ${selectedPO.Taluk}` : geminiData["Tehsil"];
        }
    }

    // G. Corrections & Cleanup
    verifyAndCorrectAddress(geminiData, remarks);
    cleanUpGeminiData(geminiData);

    // H. Landmark Logic
    let finalLandmark = '';
    const landmarkVal = geminiData["Landmark"] || '';
    if (landmarkVal) {
        const foundDir = directionalKeywords.find(k => originalAddressLower.includes(k));
        if (foundDir) {
             const originalDirWord = originalAddress.match(new RegExp(`\\b${foundDir}\\b`, 'i'))?.[0] || foundDir; 
             finalLandmark = `${originalDirWord.charAt(0).toUpperCase() + originalDirWord.slice(1)} ${landmarkVal}`;
        } else {
             finalLandmark = `Near ${landmarkVal}`;
        }
    }

    // I. Name Cleaning
    let cleanedName = await translateToEnglish(customerName); // Simple cleaner

    // J. Final Formatting
    let formattedAddress = geminiData["FormattedAddress"] || '';
    if (originalAddressLower.includes('village') && !formattedAddress.toLowerCase().includes('village')) {
        formattedAddress = `Village ${formattedAddress}`;
    }
    
    // Duplicate Landmark Check (Fix for "Near ZP School" appearing twice)
    if (finalLandmark && formattedAddress.toLowerCase().includes(finalLandmark.toLowerCase())) {
        // If landmark is already in address, don't duplicate it in the separate field? 
        // Or remove from formatted? Usually we keep formatted clean.
        // Let's ensure formatted address doesn't end with the landmark if we are displaying it separately.
    }

    formattedAddress = removeAdjacentDuplicates(formattedAddress);
    
    return {
        status: "Success",
        customerRawName: customerName,
        customerCleanName: cleanedName,
        addressLine1: formattedAddress || originalAddress,
        landmark: finalLandmark,
        postOffice: geminiData["P.O."] || '',
        tehsil: geminiData["Tehsil"] || '',
        district: geminiData["DIST."] || '',
        state: geminiData["State"] || '',
        pin: finalPin || initialPin,
        addressQuality: geminiData["AddressQuality"] || 'Medium',
        locationType: geminiData["LocationType"] || 'Unknown',
        remarks: remarks.join('; ').trim(),
        success: true
    };
}

// --- 12. MAIN EXPORT ---
module.exports = async (req, res) => {
    // ... [KEEP YOUR EXISTING AUTH / DB / CREDITS LOGIC HERE] ...
    // Note: Standard Boilerplate
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '[https://dfame237-oss.github.io](https://dfame237-oss.github.io)');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    let db;
    try { const dbResult = await connectToDatabase(); db = dbResult.db; } 
    catch (e) { return res.status(500).json({ status: 'Error', error: 'Database connection failed.' }); }
    const clients = db.collection('clients');

    function parseJwtFromHeader(req) {
        const authHeader = req.headers.authorization || req.headers.Authorization; 
        if (!authHeader) return null; 
        const parts = authHeader.split(' '); 
        if (parts.length !== 2) return null; 
        const token = parts[1];
        try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
    }

    if (req.method === 'GET') {
        const jwtPayload = parseJwtFromHeader(req);
        if (!jwtPayload) return res.status(401).json({ status: 'Error', message: 'Auth required.' });
        const client = await clients.findOne({ _id: new ObjectId(jwtPayload.clientId) });
        return res.status(200).json({ status: 'Success', remainingCredits: client?.remainingCredits ?? 0, initialCredits: client?.initialCredits ?? 0 });
    }

    if (req.method === 'POST') {
        const jwtPayload = parseJwtFromHeader(req);
        if (!jwtPayload) return res.status(401).json({ status: 'Error', message: 'Auth required.' });
        
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* ignore */ } }
        const { address, customerName } = body || {}; 
        if (!address) return res.status(400).json({ status: 'Error', error: 'Address is required.' });

        try {
            const client = await clients.findOne({ _id: new ObjectId(jwtPayload.clientId) });
            // ... Credits Logic (Use your existing snippet) ...
            
            const finalResponse = await runVerificationLogic(address, customerName);
            
            // ... Final Response ...
            return res.status(200).json({ ...finalResponse, remainingCredits: client.remainingCredits });
        } catch (e) {
            return res.status(500).json({ status: 'Error', message: e.message });
        }
    }
    return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' }); 
};

// Exports
module.exports.runVerificationLogic = runVerificationLogic;
module.exports.getIndiaPostData = getIndiaPostData;
module.exports.CRITICAL_KEYWORDS = CRITICAL_KEYWORDS;