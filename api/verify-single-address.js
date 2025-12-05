// api/verify-single-address.js
// Final Logic: Deterministic India Post Matching + Strict AI Formatting + Original Safety Checks

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

// RESTORED: IIFE for regex compilation
const meaninglessRegex = (() => {
    try {
        return new RegExp(`\\b(?:${meaningfulWords.join('|')})\\b`, 'gi');
    } catch (e) {
        console.error("Failed to compile meaninglessRegex:", e);
        return /a^/; 
    }
})();

const directionalKeywords = ['near', 'opposite', 'back side', 'front side', 'behind', 'opp', 'beside', 'in front', 'above', 'below', 'next to'];

// --- RESTORED: Conflict Maps & Alert Keywords ---
const MAJOR_CITY_CONFLICTS = {
    'mumbai': 'Maharashtra',
    'delhi': 'Delhi',
    'chennai': 'Tamil Nadu',
    'bangalore': 'Karnataka',
    'kolkata': 'West Bengal',
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

// --- 4. DETERMINISTIC P.O. MATCHING (The Fix for Hallucinations) ---
function findBestPOMatch(rawAddress, postOfficeList) {
    if (!postOfficeList || postOfficeList.length === 0) return null;
    
    // Sort P.O.s by length (longest first) to match "Kharghar Sector 19" before "Kharghar"
    const sortedPOs = [...postOfficeList].sort((a, b) => b.Name.length - a.Name.length);
    const normalizedAddress = rawAddress.toLowerCase().replace(/[^\w\s]/g, ' ');

    for (const po of sortedPOs) {
        const normalizedPO = po.Name.toLowerCase().replace(/[^\w\s]/g, ' ');
        // Strict word boundary check
        const regex = new RegExp(`\\b${normalizedPO}\\b`, 'i');
        if (regex.test(normalizedAddress)) {
            return po; // Found strict match
        }
    }
    return null;
}

// --- 5. GEMINI API HELPER ---
async function getGeminiResponse(prompt) { 
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { text: null, error: "Gemini API key not set." };

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; 

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        // CRITICAL: Temperature 0.0 prevents "Macy's" and random inventions
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
            return { text: null, error: "External AI verification service failed to return data." }; 
        }
    } catch (e) {
        console.error(`Error during Gemini API call: ${e.message}`); 
        return { text: null, error: "A network issue occurred while contacting the AI service." }; 
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

// --- 7. PROMPT ENGINEERING (STRICT) ---
function buildGeminiPrompt(originalAddress, postalData, forcedPO) {
    
    // Logic: If we found a PO using code, force AI to use it. If not, give list.
    const postOfficeInstruction = forcedPO 
        ? `**OFFICIAL DATA LOCKED:** We have identified the Post Office is "${forcedPO.Name}". \n   - You MUST set "P.O." to "${forcedPO.Name}".\n   - You MUST set "Dist." to "${forcedPO.District}".\n   - You MUST set "State" to "${forcedPO.State}".`
        : `**OFFICIAL POST OFFICE LIST:** ${JSON.stringify(postalData.PostOfficeList?.map(p => p.Name) || [])}\n   - You MUST select the Post Office name from this list that best matches the locality.`;

    let basePrompt = `You are a strict Indian Address Standardization Engine.
    Raw Address: "${originalAddress}"
    ${postOfficeInstruction}

    **STRICT RULES (NO HALLUCINATIONS):**
    1. **NO NEW DATA:** Do NOT add landmarks (e.g., "Macy's", "Near Temple") if not in Raw Address.
    2. **NO TRANSLATION:** Do NOT translate proper nouns (e.g., "Vadu Ali" stays "Vadu Ali", NOT "Vadu Alley").
    3. **STRICT EXTRACTION:**
       - "H.no.": Extract House/Flat/Plot number.
       - "Street": Extract Street/Road name exactly.
       - "Locality": Extract the Area/Colony.
       - "Landmark": Extract ONLY if explicitly mentioned. Remove directional words like "Near".
       - "Remaining": Any ambiguous text.
    4. **FORMATTING:** Combine H.no, Street, Locality, P.O. into "FormattedAddress". DO NOT include City/State/PIN/Country.

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
      "LocationType": "Village/Town/City/Urban Area"
    }
`;
    return basePrompt;
}

function processAddress(address, postalData, forcedPO) {
    const prompt = buildGeminiPrompt(address, postalData, forcedPO); 
    return getGeminiResponse(prompt);
}

async function getTranslatedCleanName(rawName) {
    if (!rawName) return null;
    const namePrompt = `Standardize this name to English Title Case. Remove numbers/special chars. Do NOT translate meanings. Name: "${rawName}"`;
    const response = await getGeminiResponse(namePrompt);
    return response.text ? response.text.trim() : (rawName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim(); 
}

// --- 8. MAIN VERIFICATION LOGIC ---
async function runVerificationLogic(address, customerName) {
    // Safely define address
    const originalAddress = String(address || '').trim();
    const originalAddressLower = originalAddress.toLowerCase();

    if (!originalAddress) {
        return {
            status: "Error", remarks: "Input address was empty or invalid.", addressQuality: "Very Bad",
            customerCleanName: (customerName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim() || null, 
            addressLine1: "", landmark: "", state: "", district: "", pin: "", success: false
        };
    }

    let remarks = [];
    
    // --- A. EMAIL CHECK (Restored) ---
    const detectedEmail = extractEmail(originalAddress);
    if (detectedEmail) {
        remarks.push(`CRITICAL_ALERT: Raw address contains email: ${detectedEmail}. Manual check needed.`);
        return {
            status: "Skipped", remarks: remarks.join('; ').trim(), addressQuality: "Very Bad", 
            customerCleanName: (customerName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim() || null,
            addressLine1: originalAddress, landmark: "", state: "", district: "", pin: extractPin(originalAddress), success: false
        };
    }

    // --- B. DATA PREP ---
    let cleanedName = await getTranslatedCleanName(customerName);
    const initialPin = extractPin(originalAddress);
    let postalData = { PinStatus: 'Error' };
    let forcedPO = null;

    if (initialPin) {
        postalData = await getIndiaPostData(initialPin);
        // Code-based PO Match (Fixes Hallucinations)
        if (postalData.PinStatus === 'Success') {
            forcedPO = findBestPOMatch(originalAddress, postalData.PostOfficeList);
        }
    }

    // --- C. AI CALL ---
    const geminiResult = await processAddress(originalAddress, postalData, forcedPO);

    if (geminiResult.error || !geminiResult.text) {
        return {
            status: "Error", remarks: "Verification failed due to a problem with the external AI service.", addressQuality: "Very Bad", 
            customerCleanName: cleanedName, addressLine1: originalAddress, landmark: "", state: "", district: "", pin: initialPin, success: false
        };
    }

    // --- D. PARSING ---
    let parsedData;
    try {
        const jsonText = geminiResult.text.replace(/```json|```/g, '').trim(); 
        parsedData = JSON.parse(jsonText);
    } catch (e) {
        remarks.push(`CRITICAL_ALERT: AI response format error.`);
        parsedData = {
            FormattedAddress: originalAddress.replace(meaninglessRegex, '').trim(),
            Landmark: '', State: '', DIST: '', PIN: initialPin, 
            AddressQuality: 'Very Bad', 
        };
    }

    // --- E. PIN & DATA SYNC (The "Always Verified" Rule) ---
    let finalPin = parsedData.PIN || initialPin;
    
    // 1. PIN Check
    if (finalPin && finalPin !== initialPin) {
        const checkNewPin = await getIndiaPostData(finalPin);
        if (checkNewPin.PinStatus === 'Success') {
            postalData = checkNewPin;
            remarks.push(`Correct PIN (${finalPin}) identified by AI.`);
            // Re-match PO since PIN changed
            forcedPO = findBestPOMatch(originalAddress, postalData.PostOfficeList); 
        } else {
            finalPin = initialPin;
            remarks.push(`Reverted AI PIN hallucination (${parsedData.PIN}).`);
        }
    }

    // 2. ENFORCE OFFICIAL DATA (Override AI Hallucinations)
    if (postalData.PinStatus === 'Success') {
        let selectedPO = forcedPO;
        
        // If code didn't find match, check AI's choice against strict list
        if (!selectedPO && parsedData['P.O.']) {
            selectedPO = postalData.PostOfficeList.find(p => p.Name.toLowerCase() === parsedData['P.O.'].toLowerCase().replace('p.o. ', ''));
        }
        
        if (!selectedPO) selectedPO = postalData.PostOfficeList[0]; // Fallback to first

        // FORCE OVERWRITE - Trust IndiaPost over AI
        parsedData['P.O.'] = `P.O. ${selectedPO.Name}`;
        parsedData['DIST.'] = selectedPO.District;
        parsedData['State'] = selectedPO.State;
        parsedData['Tehsil'] = selectedPO.Taluk ? `Tehsil ${selectedPO.Taluk}` : parsedData['Tehsil'];
    }

    // --- F. LOCAL CORRECTIONS & CONFLICTS (Restored) ---
    // 1. Check Boduppal/Putlibowli (from Google Script logic)
    postVerificationCorrections(parsedData, originalAddress, remarks);

    // 2. RESTORED: Major City Conflict Check (Mumbai vs Delhi)
    const verifiedState = parsedData.State || '';
    if (verifiedState) {
        const verifiedStateLower = verifiedState.toLowerCase();
        for (const city in MAJOR_CITY_CONFLICTS) {
            const expectedStateLower = MAJOR_CITY_CONFLICTS[city].toLowerCase();
            if (originalAddressLower.includes(city) && !verifiedStateLower.includes(expectedStateLower)) { 
                remarks.push(`CRITICAL_ALERT: Major location conflict. Address says '${city.toUpperCase()}' but State is '${verifiedState}'.`);
                parsedData.AddressQuality = 'Very Bad';
                break; 
            }
        }
    }

    // --- G. FINAL CLEANUP ---
    // 1. H.no Cleanup
    const houseNumber = parsedData['H.no.'];
    if (houseNumber && (houseNumber === finalPin)) parsedData['H.no.'] = null;

    // 2. Format Address
    if (parsedData.FormattedAddress) {
        parsedData.FormattedAddress = removeAdjacentDuplicates(parsedData.FormattedAddress);
        // Village Prefix
        if (originalAddressLower.includes('village') && !parsedData.FormattedAddress.toLowerCase().startsWith('village')) {
            parsedData.FormattedAddress = `Village ${parsedData.FormattedAddress}`;
        }
        // H.no expansion
        parsedData.FormattedAddress = parsedData.FormattedAddress.replace(/\bHouse number\b/gi, 'H.no.');
    }

    // 3. Landmark Directionals
    let finalLandmark = '';
    if (parsedData.Landmark) {
        const foundDirection = directionalKeywords.find(k => originalAddressLower.includes(k));
        if (foundDirection) {
             const originalDirWord = originalAddress.match(new RegExp(`\\b${foundDirection}\\b`, 'i'))?.[0] || foundDirection; 
             finalLandmark = `${originalDirWord.charAt(0).toUpperCase() + originalDirWord.slice(1)} ${parsedData.Landmark}`;
        } else {
             finalLandmark = `Near ${parsedData.Landmark}`;
        }
    }

    // 4. Specificity Check
    if (!parsedData['H.no.'] && !parsedData.Street && !parsedData.Locality) {
        remarks.push(`CRITICAL_ALERT: Address lacks specificity.`);
        parsedData.AddressQuality = 'Bad';
    }

    if (remarks.length === 0) remarks.push('Address verified and formatted successfully.');

    return {
        status: "Success",
        customerRawName: customerName,
        customerCleanName: cleanedName,
        addressLine1: parsedData.FormattedAddress || originalAddress.replace(meaninglessRegex, '').trim(),
        landmark: finalLandmark,
        postOffice: parsedData['P.O.'] || '',
        tehsil: parsedData.Tehsil || '',
        district: parsedData['DIST.'] || '',
        state: parsedData['State'] || '',
        pin: finalPin,
        addressQuality: parsedData.AddressQuality || 'Medium',
        locationType: parsedData.LocationType || 'Unknown',
        locationSuitability: parsedData.LocationSuitability || 'Unknown',
        remarks: remarks.join('; ').trim(),
        success: true
    };
}

// --- RESTORED: Local Conflict Correction Logic ---
function postVerificationCorrections(geminiData, originalAddress, remarks) {
    const aiLocality = geminiData["Locality"] || geminiData["Colony"] || '';
    const correctedData = getPostalDataByLocality(aiLocality); // Lookup hardcoded fix
    
    if (correctedData) {
        geminiData["P.O."] = `P.O. ${correctedData["P.O."]}`;
        geminiData["DIST."] = correctedData["DIST."];
        geminiData["State"] = correctedData["State"];
        if (geminiData["PIN"] !== correctedData["PIN"]) {
            remarks.push(`PIN conflict: Corrected to "${correctedData["PIN"]}"`);
            geminiData["PIN"] = correctedData["PIN"];
        }
    }
}

function getPostalDataByLocality(locality) {
    if (!locality) return null;
    const lookupTable = {
        "boduppal": { "P.O.": "Boduppal", "DIST.": "Hyderabad", "State": "Telangana", "PIN": "500092" },
        "putlibowli": { "P.O.": "Putlibowli", "DIST.": "Hyderabad", "State": "Telangana", "PIN": "500095" }
    };
    return lookupTable[locality.toLowerCase()] || null;
}

// --- Main Handler ---
module.exports = async (req, res) => {
    // ... [KEEP YOUR EXISTING AUTH / DB / CREDITS LOGIC HERE] ...
    // Note: Use the exact same Auth/DB code from your original file for this section
    
    // (Partial snippet for context)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', 'https://dfame237-oss.github.io');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    let db;
    try {
        const dbResult = await connectToDatabase(); 
        db = dbResult.db;
    } catch (e) {
        return res.status(500).json({ status: 'Error', error: 'Database connection failed.' }); 
    }
    const clients = db.collection('clients');
    
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
        } catch (e) { return null; }
    }

    // GET & POST Handlers (Identical to your original file)
    if (req.method === 'GET') { /* ... copy your original GET logic ... */ 
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
            // ... Credits Logic ...
            
            // RUN LOGIC
            const finalResponse = await runVerificationLogic(address, customerName);
            
            // ... Final Response & Deductions ...
            return res.status(200).json({ ...finalResponse, remainingCredits: client.remainingCredits });
        } catch (e) {
            return res.status(500).json({ status: 'Error', message: e.message });
        }
    }
    return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' }); 
};

// --- RESTORED: All Original Exports ---
module.exports.getIndiaPostData = getIndiaPostData;
module.exports.getGeminiResponse = getGeminiResponse;
module.exports.processAddress = processAddress;
module.exports.extractPin = extractPin;
module.exports.meaninglessRegex = meaninglessRegex;
module.exports.runVerificationLogic = runVerificationLogic;
module.exports.CRITICAL_KEYWORDS = CRITICAL_KEYWORDS;