// api/verify-single-address.js
// Logic Ported EXACTLY from Google Apps Script (GAS) to Node.js

const INDIA_POST_API = '[https://api.postalpincode.in/pincode/](https://api.postalpincode.in/pincode/)'; 
let pincodeCache = {};

// --- 1. CONFIGURATION & KEYWORDS (Synced with GAS) ---
const testingKeywords = ['test', 'testing', 'asdf', 'qwer', 'zxcv', 'random', 'gjnj', 'fgjnj'];

const meaningfulWords = [
    "ddadu", "ddadu", "ai", "add", "add-", "raw", "dumping", "grand", "dumping grand",
    "chd", "chd-", "chandigarh", "chandigarh-", "chandigarh", "west", "sector", "sector-",
    "house", "no", "no#", "house no", "house no#", "floor", "first", "first floor",
    "majra", "colony", "dadu", "dadu majra", "shop", "wine", "wine shop", "house", "number",
    "tq", "job", "dist"
];

// Regex to clean meaningless words
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

// --- 3. HELPER: TRANSLATE TO ENGLISH (Replaces LanguageApp) ---
// Since GAS uses LanguageApp, we use a lightweight Gemini call here.
async function translateToEnglish(text) {
    if (!text || typeof text !== 'string') return text;
    // Skip translation if text is very short or looks like a number/code
    if (text.length < 3 || /^\d+$/.test(text)) return text;

    const prompt = `Translate the following text to English. Return ONLY the translated text. If it is already in English or is a proper noun (name/place), return it as is. Text: "${text}"`;
    const res = await getGeminiResponse(prompt, 0.0); // Strict temp
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

// --- 5. GEMINI API HELPER ---
async function getGeminiResponse(prompt, temperature = 0.0) { 
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { text: null, error: "Gemini API key not set." };

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; 

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: temperature, // Controlled by caller
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

// --- 6. UTILITIES (From GAS) ---
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

// --- 7. PROMPT BUILDER (Exact Copy from GAS) ---
function buildGeminiPrompt(originalAddress, postalData) {
    let basePrompt = `You are an expert Indian address verifier and formatter. Your task is to process a raw address, perform a thorough analysis, and provide a comprehensive response in a single JSON object. **Provide all responses in English only. Strictly translate all extracted address components to English. Correct all common spelling and phonetic errors in the provided address, such as "rd" to "Road", "nager" to "Nagar", and "nd" to "2nd". Analyze common short forms and phonetic spellings, such as "lean" for "Lane", and use your best judgment to correct them. Be strict about ensuring the output is a valid, single, and complete address for shipping. Use your advanced knowledge to identify and remove any duplicate address components that are present consecutively (e.g., 'Gandhi Street Gandhi Street' should be 'Gandhi Street').**

Your response must contain the following keys:
1.  **"H.no."**, **"Flat No."**, **"Plot No."**, **"Room No."**, **"Building No."**, **"Block No."**, **"Ward No."**, **"Gali No."**, **"Zone No."**: Extract only the number or alphanumeric sequence (e.g., '1-26', 'A/25', '10'). Set to null if not found.
2.  **"Colony"**, **"Street"**, **"Locality"**, **"Building Name"**, **"House Name"**, **"Floor"**: Extract the name.
3.  **"P.O."**: The official Post Office name from the PIN data. Prepend "P.O." to the name. Example: "P.O. Boduppal".
4.  **"Tehsil"**: The official Tehsil/SubDistrict from the PIN data. Prepend "Tehsil". Example: "Tehsil Pune".
5.  **"DIST."**: The official District from the PIN data.
6.  **"State"**: The official State from the PIN data.
7.  **"PIN"**: The 6-digit PIN code. Find and verify the correct PIN. If a PIN exists in the raw address but is incorrect, find the correct one and provide it.
8.  **"Landmark"**: A specific, named landmark (e.g., "Apollo Hospital"), not a generic type like "school". If multiple landmarks are present, list them comma-separated. **Extract the landmark without any directional words like 'near', 'opposite', 'behind' etc., as this will be handled by the script.**
9.  **"Remaining"**: A last resort for any text that does not fit into other fields. Clean this by removing meaningless words like 'job', 'raw', 'add-', 'tq', 'dist' and country, state, district, or PIN code.
10. **"FormattedAddress"**: **This is the most important field.** Based on your full analysis, create a single, clean, human-readable, and comprehensive shipping-ready address string. It should contain all specific details (H.no., Room No., etc.), followed by locality, street, colony, P.O., Tehsil, and District. **DO NOT include the State or PIN in this string.** Use commas to separate logical components. Do not invent or "hallucinate" information.
11. **"LocationType"**: Identify the type of location (e.g., "Village", "Town", "City", "Urban Area").
12. **"AddressQuality"**: Analyze the address completeness and clarity for shipping. Categorize it as one of the following: **Very Good**, **Good**, **Medium**, **Bad**, or **Very Bad**.
13. **"LocationSuitability"**: Analyze the location based on its State, District, and PIN to determine courier-friendliness in India. Categorize it as one of the following: **Prime Location**, **Tier 1 & 2 Cities**, **Remote/Difficult Location**, or **Non-Serviceable Location**.

Raw Address: "${originalAddress}"
`;

    if (postalData.PinStatus === 'Success') {
        basePrompt += `\nOfficial Postal Data: ${JSON.stringify(postalData.PostOfficeList)}\nUse this list to find the best match for 'P.O.', 'Tehsil', and 'DIST.' fields.`;
    } else {
        basePrompt += `\nAddress has no PIN or the PIN is invalid. You must find and verify the correct 6-digit PIN. If you cannot find a valid PIN, set "PIN" to null.`;
    }
    return basePrompt;
}

// --- 8. LOGIC FUNCTIONS FROM GOOGLE SCRIPT ---

// Lookup Table for Conflict Resolution
function getPostalDataByLocality(locality) {
    const lookupTable = {
        "boduppal": { "P.O.": "Boduppal", "DIST.": "Hyderabad", "State": "Telangana", "PIN": "500092" },
        "putlibowli": { "P.O.": "Putlibowli", "DIST.": "Hyderabad", "State": "Telangana", "PIN": "500095" },
        // START OF FIX: Added 'baraula' to resolve Noida/Delhi PIN conflict
        "baraula": { "P.O.": "Noida", "DIST.": "Gautam Buddha Nagar", "State": "Uttar Pradesh", "PIN": "201301" }
        // END OF FIX
    };
    return lookupTable[locality.toLowerCase()] || null;
}

// Verify and Correct Address (PO Conflict)
function verifyAndCorrectAddress(geminiData, originalAddress, remarks) {
    const aiLocality = geminiData["Locality"] || geminiData["Colony"] || '';
    const aiPo = geminiData["P.O."];
    
    if (aiLocality && aiPo && aiLocality.toLowerCase() !== aiPo.toLowerCase()) {
        const correctedData = getPostalDataByLocality(aiLocality);
        if (correctedData) {
            // Check if AI got the wrong PO
            const normalizedAiPo = String(geminiData["P.O."] || '').toLowerCase();
            const normalizedCorrectedPo = `p.o. ${correctedData["P.O."].toLowerCase()}`;

            if (normalizedAiPo !== normalizedCorrectedPo) {
                remarks.push(`P.O. conflict: Corrected P.O. from "${geminiData["P.O."]}" to "P.O. ${correctedData["P.O."]}"`);
                geminiData["P.O."] = `P.O. ${correctedData["P.O."].toLowerCase()}`;
                geminiData["DIST."] = correctedData["DIST."];
                geminiData["State"] = correctedData["State"];
                if (geminiData["PIN"] !== correctedData["PIN"]) {
                    remarks.push(`PIN conflict: Corrected PIN from "${geminiData["PIN"]}" to "${correctedData["PIN"]}"`);
                    geminiData["PIN"] = correctedData["PIN"];
                }
            }
        }
    }
}

// Clean Up Gemini Data (Remove Pin/State/Dist from Remaining)
function cleanUpGeminiData(geminiData) {
    if (geminiData["Remaining"]) {
        let remainingText = geminiData["Remaining"].toString().trim();
        const pinRegex = /\b\d{6}\b/;
        const state = geminiData["State"] || '';
        const district = geminiData["DIST."] || '';

        remainingText = remainingText.replace(meaninglessRegex, '').replace(/\s+/g, ' ').trim();

        const remainingPinMatch = remainingText.match(pinRegex);
        if (remainingPinMatch && geminiData["PIN"] && remainingPinMatch[0] === geminiData["PIN"].toString().trim()) {
            remainingText = remainingText.replace(remainingPinMatch[0], '').trim();
        }

        if (state && remainingText.toLowerCase().includes(state.toLowerCase())) {
            remainingText = remainingText.toLowerCase().replace(state.toLowerCase(), '').trim();
        }

        if (district && remainingText.toLowerCase().includes(district.toLowerCase())) {
            remainingText = remainingText.toLowerCase().replace(district.toLowerCase(), '').trim();
        }

        geminiData["Remaining"] = remainingText;
    }
}

// --- 9. MAIN VERIFICATION LOGIC (Replaces GAS processSingleAddress) ---
async function runVerificationLogic(address, customerName) {
    const originalAddress = String(address || '').trim();
    if (!originalAddress) {
        return { status: "Error", remarks: "Empty address found.", success: false, addressQuality: "Very Bad" };
    }

    let remarks = [];
    let geminiData = {};
    const originalAddressLower = originalAddress.toLowerCase();

    // A. Testing Order Check
    const isTesting = testingKeywords.some(keyword => 
        (customerName && customerName.toLowerCase().includes(keyword)) || 
        originalAddressLower.includes(keyword)
    );
    if (isTesting) {
        return { status: "Success", remarks: "Testing Order", addressQuality: "Bad", success: true };
    }

    // B. Email Check
    if (extractEmail(originalAddress)) {
        return { status: "Skipped", remarks: "Invalid Address: Contains an email.", addressQuality: "Very Bad", success: false };
    }

    // C. TRANSLATION (Replaces LanguageApp)
    const translatedAddress = await translateToEnglish(originalAddress);

    // D. PIN Extraction & Fetch
    const originalPin = extractPin(originalAddress);
    let postalData = originalPin ? await getIndiaPostData(originalPin) : { PinStatus: 'Error' };

    // E. Gemini Verification
    const geminiPrompt = buildGeminiPrompt(translatedAddress, postalData);
    const geminiResponse = await getGeminiResponse(geminiPrompt, 0.0); // Strict

    if (geminiResponse.text) {
        try {
            const cleanResponse = geminiResponse.text.replace(/```json\n|\n```|```/g, '').trim();
            geminiData = JSON.parse(cleanResponse);

            // F. AI-Provided PIN Check (Logic from GAS)
            const aiPin = geminiData["PIN"];
            if (aiPin && postalData.PinStatus !== 'Success') {
                const aiPostalData = await getIndiaPostData(aiPin);
                if (aiPostalData.PinStatus === 'Success') {
                    geminiData["P.O."] = `P.O. ${aiPostalData.PostOfficeList[0].Name}`;
                    geminiData["Tehsil"] = `Tehsil ${aiPostalData.PostOfficeList[0].Taluk}`;
                    geminiData["DIST."] = aiPostalData.PostOfficeList[0].District;
                    geminiData["State"] = aiPostalData.PostOfficeList[0].State;
                    remarks.push(`PIN verified by AI: (${aiPin})`);
                    postalData = aiPostalData; 
                } else {
                    remarks.push(`Warning: AI-provided PIN (${aiPin}) not verified by API.`);
                }
            }
        } catch (e) {
            remarks.push(`JSON parse failed: ${e.message}`);
            geminiData = { FormattedAddress: originalAddress, AddressQuality: "Very Bad" };
        }
    } else {
        remarks.push(geminiResponse.error || "Address could not be verified by Gemini.");
    }

    // G. Verify and Correct (Logic from GAS)
    verifyAndCorrectAddress(geminiData, originalAddress, remarks);

    // H. Cleanup (Logic from GAS)
    cleanUpGeminiData(geminiData);

    // I. Landmark Directional Logic (Logic from GAS)
    let landmarkValue = geminiData["Landmark"] || '';
    let finalLandmark = '';
    const foundDirectionalWord = directionalKeywords.find(keyword => originalAddressLower.includes(keyword));

    if (foundDirectionalWord) {
        // Find original spelling in raw address
        const originalDirectionalWord = originalAddress.match(new RegExp(`\\b${foundDirectionalWord}\\b`, 'i'))?.[0] || '';
        if (landmarkValue.trim() !== '') {
            finalLandmark = `${originalDirectionalWord.charAt(0).toUpperCase() + originalDirectionalWord.slice(1)} ${landmarkValue.trim()}`;
        }
    } else {
        if (landmarkValue.trim() !== '') {
            finalLandmark = `Near ${landmarkValue.trim()}`;
        }
    }

    // J. Name Cleaning (Using Gemini)
    let cleanedName = customerName;
    if (customerName) {
        const namePrompt = `Clean and correct the following customer name. Remove any numbers or special characters and translate the name to English if needed. Provide only the cleaned name. Provide only the name with no other text. Name: "${customerName}"`;
        const cleanedNameResponse = await getGeminiResponse(namePrompt, 0.0);
        if (cleanedNameResponse.text) {
            cleanedName = cleanedNameResponse.text.trim();
        } else {
            remarks.push("Name cleaning failed.");
        }
    }

    // K. Final Formatting (Logic from GAS)
    const finalPin = geminiData["PIN"];
    let formattedAddress = geminiData["FormattedAddress"] || '';

    // Village Prefix
    if (originalAddressLower.includes('village') && formattedAddress.length > 0 && !formattedAddress.toLowerCase().includes('village')) {
        formattedAddress = `Village ${formattedAddress}`;
    }

    // PIN Remarks
    if (!finalPin) {
        remarks.push("Warning: PIN not found after verification attempts. Manual check needed.");
    } else if (originalPin && finalPin !== originalPin) {
        remarks.push(`Wrong PIN (${originalPin}) Corrected to (${finalPin})`);
    } else if (!originalPin && finalPin) {
        remarks.push(`Correct PIN (${finalPin}) added`);
    }

    // Short Address Check
    if (formattedAddress.length < 35) {
        remarks.push("Warning: Formatted address is too short. Please verify manually.");
    }

    // Adjacent Duplicates
    formattedAddress = removeAdjacentDuplicates(formattedAddress);
    finalLandmark = removeAdjacentDuplicates(finalLandmark);

    // Return Final Object
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
        pin: finalPin || originalPin,
        addressQuality: geminiData["AddressQuality"] || 'Medium',
        locationType: geminiData["LocationType"] || 'Unknown',
        locationSuitability: geminiData["LocationSuitability"] || 'Unknown',
        remarks: remarks.join('; ').trim(),
        success: true
    };
}

// --- 10. MAIN HANDLER ---
module.exports = async (req, res) => {
    // ... (AUTH & DB - SAME AS BEFORE) ...
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '[https://dfame237-oss.github.io](https://dfame237-oss.github.io)');
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

    if (req.method === 'GET') {
        const jwtPayload = parseJwtFromHeader(req);
        if (!jwtPayload) return res.status(401).json({ status: 'Error', message: 'Authentication required.' });
        try {
            const client = await clients.findOne({ _id: new ObjectId(jwtPayload.clientId) });
            if (!client) return res.status(404).json({ status: 'Error', message: 'Client not found.' });
            return res.status(200).json({
                status: 'Success',
                remainingCredits: client.remainingCredits ?? 0,
                initialCredits: client.initialCredits ?? 0
            });
        } catch (e) { return res.status(500).json({ status: 'Error', message: 'Internal server error.' }); }
    }

    if (req.method === 'POST') {
        const jwtPayload = parseJwtFromHeader(req);
        if (!jwtPayload) return res.status(401).json({ status: 'Error', message: 'Authentication required.' });
        
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* ignore */ } }
        const { address, customerName } = body || {}; 
        
        if (!address) return res.status(400).json({ status: 'Error', error: 'Address is required.' });

        try {
            const client = await clients.findOne({ _id: new ObjectId(jwtPayload.clientId) });
            if (!client) return res.status(404).json({ status: 'Error', message: 'Client not found.' });

            const remaining = client.remainingCredits;
            const isUnlimited = (remaining === 'Unlimited');
            let reserved = false;

            if (!isUnlimited) {
                const reserveResult = await clients.findOneAndUpdate(
                    { _id: client._id, remainingCredits: { $gt: 0 } },
                    { $inc: { remainingCredits: -1 }, $set: { lastActivityAt: new Date() } },
                    { returnDocument: 'after' }
                );
                if (!reserveResult.value) {
                    return res.status(200).json({ status: 'QuotaExceeded', message: 'No credits left.' });
                }
                reserved = true;
            }

            // RUN THE VERIFICATION
            const finalResponse = await runVerificationLogic(address, customerName);

            // Refund if error
            if ((finalResponse.status === "Error" || finalResponse.status === "Skipped") && reserved) {
                 await clients.updateOne({ _id: client._id }, { $inc: { remainingCredits: 1 } });
                 return res.status(500).json({ status: finalResponse.status, message: finalResponse.remarks });
            }
             
            // If skipped, return 200 but notify
            if (finalResponse.status === "Skipped") {
                return res.status(200).json({ status: finalResponse.status, message: finalResponse.remarks, remainingCredits: reserved ? (client.remainingCredits ?? 0) : 'Unlimited' });
            }

            const updatedClient = isUnlimited ? { remainingCredits: 'Unlimited' } : await clients.findOne({ _id: client._id });
            
            return res.status(200).json({
                ...finalResponse,
                remainingCredits: isUnlimited ? 'Unlimited' : (updatedClient.remainingCredits ?? 0)
            });
        } catch (e) {
            return res.status(500).json({ status: 'Error', message: `Internal Server Error: ${e.message}` });
        }
    }
    return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' }); 
};

// EXPORTS
module.exports.runVerificationLogic = runVerificationLogic;
module.exports.getIndiaPostData = getIndiaPostData;
module.exports.getGeminiResponse = getGeminiResponse;
module.exports.extractPin = extractPin;
module.exports.meaninglessRegex = meaninglessRegex;
// Define CRITICAL_KEYWORDS here if needed for export compatibility with bulk-jobs
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
module.exports.CRITICAL_KEYWORDS = CRITICAL_KEYWORDS;