// api/public-single-address.js
// FINAL AND MOST ACCURATE VERSION: Fully prioritizes Gemini's contextual verification, 
// fixing P.O. selection issues.

const INDIA_POST_API = 'https://api.postalpincode.in/pincode/'; 
let pincodeCache = {};

// NOTE: No authentication, credit logic, or database access is included.

const coreMeaningfulWords = [
    "ddadu", "ddadu", "ai", "add", "add-", "raw", "dumping", "grand", "dumping grand",
    "chd", "chd-", "chandigarh", "chandigarh-", "chandigarh", "west", "sector", "sector-",
    "house", "no", "no#", "house no", "house no#", "floor", "first", "first floor",
    "majra", "colony", "dadu", "dadu majra", "shop", "wine", "wine shop", "house", "number",
    "tq", "job", "dist"
]; 
const meaningfulWords = [...coreMeaningfulWords]; 
const meaninglessRegex = new RegExp(`\\b(?:${meaningfulWords.join('|')})\\b`, 'gi'); 
const directionalKeywords = ['near', 'opposite', 'back side', 'front side', 'behind', 'opp']; 

// --- Gemini API Key (still needed for the core service) ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'REPLACE_WITH_YOUR_KEY'; 

// --- India Post helper (unchanged) ---
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

// --- Gemini helper (unchanged) ---
async function getGeminiResponse(prompt) {
    const apiKey = GEMINI_API_KEY; 
    if (!apiKey) {
        return { text: null, error: "Gemini API key not set in environment variables." }; 
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
            const errorMessage = `Gemini API Error: ${result.error?.message || "Unknown error."}`; 
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

// --- Utilities & Prompt Builder (FIXED) ---
function extractPin(address) {
    const match = String(address).match(/\b\d{6}\b/); 
    return match ? match[0] : null; 
}

function buildGeminiPrompt(originalAddress, postalData) {
    const initialPin = extractPin(originalAddress); 
    
    let basePrompt = `You are an expert Indian address verifier and formatter. Your verification must be highly accurate and cross-referenced.
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
7.  "PIN": The 6-digit PIN code. Find and **rigorously verify and correct** the PIN based on the entire location, including the locality and any landmarks. **Before accepting any PIN, search your knowledge base using all available components to find the most accurate 6-digit PIN for that specific location, even if it contradicts the default geographical PIN.**
8.  "Landmark": A specific, named landmark (e.g., "Apollo Hospital"), not a generic type like "school"). **If multiple landmarks are present, extract ONLY the most specific/primary landmark.** **Extract the landmark without any directional words like 'near', 'opposite', 'behind' etc., as this will be handled by the script.**
9.  "Remaining": A last resort for any text that does not fit into other fields.
Clean this by removing meaningless words like 'job', 'raw', 'add-', 'tq', 'dist' and country, state, district, or PIN code.
10. **"FormattedAddress": This is the most important field.** Based on your analysis, create a single, clean, human-readable address string containing the **detailed house/street/locality/colony information.** **STRICTLY DO NOT INCLUDE ANY LANDMARK NAME, P.O. NAME, TEHSIL, DISTRICT, STATE, or PIN in this field.** Use commas to separate logical components.
11. "LocationType": Identify the type of location (e.g., "Village", "Town", "City", "Urban Area").
12. "AddressQuality": Analyze the address completeness and clarity for shipping.
Categorize it as one of the following: Very Good, Good, Medium, Bad, or Very Bad.
13. "LocationSuitability": Analyze the location based on its State, District, and PIN to determine courier-friendliness in India.
Categorize it as one of the following: Prime Location, Tier 1 & 2 Cities, Remote/Difficult Location, or Non-Serviceable Location.
Raw Address: "${originalAddress}"
`; 

    if (postalData.PinStatus === 'Success') {
        basePrompt += `\nOfficial Postal Data for PIN ${initialPin}: ${JSON.stringify(postalData.PostOfficeList)}\n**CRITICAL INSTRUCTION:**
1. **First, verify if the PIN ${initialPin} is the most specific and correct PIN for this locality.** If your knowledge suggests a better PIN, set that corrected PIN in the "PIN" field.
2. **From the provided Post Office list, analyze the names and choose the single name that is the best geographical and most relevant match for the specific locality in the raw address.** Use this name for 'P.O.', 'Tehsil', and 'DIST.' fields. Do NOT use the first one arbitrarily.`; 
    } else {
        basePrompt += `\nAddress has no PIN or the PIN is invalid. You must find and verify the correct 6-digit PIN based on the address components.`; 
    }

    basePrompt += `\nYour entire response MUST be a single, valid JSON object starting with { and ending with } and contain ONLY the keys listed above.`; 
    return basePrompt;
}

function processAddress(address, postalData) {
    const prompt = buildGeminiPrompt(address, postalData); 
    return getGeminiResponse(prompt); 
}

// --- Main Handler (FREE POST ONLY) ---
module.exports = async (req, res) => {
    // CORS Setup for public access
    res.setHeader('Access-Control-Allow-Credentials', true); 
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins for public access
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS'); 
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); 

    if (req.method === 'OPTIONS') {
        res.status(200).end(); 
        return; 
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' }); 
    }

    // Parse request body
    let body = req.body; 
    if (typeof body === 'string') {
        try { body = JSON.parse(body); 
        } catch (e) { /* keep original */ }
    }
    const { address, customerName } = body || {}; 
    if (!address) {
        return res.status(400).json({ status: 'Error', error: 'Address is required.' }); 
    }

    try {
        const initialPin = extractPin(address); 
        let postalData = { PinStatus: 'Error' }; 
        if (initialPin) postalData = await getIndiaPostData(initialPin); 
        
        // NO AUTH OR CREDIT CHECK HERE
        
        // Run verification workflow
        let remarks = []; 
        const cleanedName = (customerName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim() || null; 
        const geminiResult = await processAddress(address, postalData); 
        
        if (geminiResult.error || !geminiResult.text) {
            return res.status(500).json({ status: 'Error', error: geminiResult.error || 'Gemini API failed to return text.' }); 
        }

        // Parse Gemini JSON output
        let parsedData; 
        try {
            const jsonText = geminiResult.text.replace(/```json|```/g, '').trim(); 
            parsedData = JSON.parse(jsonText); 
        } catch (e) {
            console.error('JSON Parsing Error:', e.message); 
            remarks.push(`CRITICAL_ALERT: JSON parse failed. Raw Gemini Output: ${String(geminiResult.text || '').substring(0, 50)}...`); 
            parsedData = {
                FormattedAddress: address.replace(meaninglessRegex, '').trim(),
                Landmark: '',
                State: '',
                DIST: '',
                PIN: initialPin, 
                AddressQuality: 'Very Bad',
                Remaining: remarks[0],
            }; 
        }

        // PIN verification/correction logic 
        let finalPin = String(parsedData.PIN).match(/\b\d{6}\b/) ? 
        parsedData.PIN : initialPin; 
        let primaryPostOffice = postalData.PostOfficeList ? postalData.PostOfficeList[0] : {}; 
        
        // Check if AI suggested a new PIN or if the initial API call failed
        if (finalPin) {
            if (postalData.PinStatus !== 'Success' || (initialPin && finalPin !== initialPin)) {
                // Rerun API with the AI-suggested PIN
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
                    remarks.push(`CRITICAL_ALERT: AI-provided PIN (${finalPin}) not verified by API. Reverting to original data.`); 
                    finalPin = initialPin; 
                }
            } else if (initialPin && postalData.PinStatus === 'Success') {
                remarks.push(`PIN (${initialPin}) verified successfully.`); 
            }
        } else {
            remarks.push('CRITICAL_ALERT: PIN not found after verification attempts. Manual check needed.'); 
            finalPin = initialPin || null; 
        }

        if (parsedData.FormattedAddress && parsedData.FormattedAddress.length < 35 && parsedData.AddressQuality !== 'Very Good' && parsedData.AddressQuality !== 'Good') {
            remarks.push(`CRITICAL_ALERT: Formatted address is short (${parsedData.FormattedAddress.length} chars). Manual verification recommended.`); 
        }

        // Landmark directional prefix logic (Returns PREFIXED landmark)
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
        } else if (remarks.length === 0) {
            remarks.push('Address verified and formatted successfully.'); 
        }

        // --- 1. CLEAN AI OUTPUT BEFORE CONCATENATION (THE FINAL DUPLICATION FIX) ---
        let primaryAddress = parsedData.FormattedAddress || address.replace(meaninglessRegex, '').trim() || ''; 
        
        // Get all postal and landmark names/values that might be present in the final string
        const postalNames = [
            (parsedData['P.O.']?.replace('P.O. ', '') || primaryPostOffice.Name),
            (parsedData.Tehsil?.replace('Tehsil ', '') || primaryPostOffice.Taluk),
            (parsedData['DIST.'] || primaryPostOffice.District),
            (parsedData.State || primaryPostOffice.State),
            finalPin,
            'INDIA',
            parsedData.Landmark // Use the clean landmark name for scrubbing
        ].filter(c => c && c.toString().trim() !== '');

        // Create a scrubber regex to find and remove *any* of the final components if the AI mistakenly added them to FormattedAddress
        const scrubberRegex = new RegExp(`(?:${postalNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');

        // Scrape the primary address line: remove duplicates, remove double commas, and trim.
        primaryAddress = primaryAddress.replace(scrubberRegex, '')
                                     .replace(/,\s*,/g, ',')
                                     .trim().replace(/,$/, '').trim();
        
        // 2. Get cleaned components for concatenation (FULLY RELYING ON AI'S PARSED DATA)
        const postOffice = parsedData['P.O.']?.replace('P.O. ', '') || ''; // No fallback to primaryPostOffice.Name
        const tehsil = parsedData.Tehsil?.replace('Tehsil ', '') || '';
        const district = parsedData['DIST.'] || '';
        const state = parsedData.State || '';
        
        // 3. Filter out empty components and concatenate into a single string.
        const components = [
            primaryAddress,
            finalLandmark, // The prefixed landmark (Near X)
            postOffice ? `P.O. ${postOffice}` : null,
            tehsil,
            district,
            state,
            finalPin,
            'INDIA'
        ].filter(c => c && c.toString().trim() !== '');

        // 4. Create the final single string
        const singleLineAddress = components.join(', ');

        // 5. Build final response
        const finalResponse = {
            status: "Success",
            customerRawName: customerName,
            customerCleanName: cleanedName,
            
            // CRITICAL CHANGE: The primary address line is now the single, concatenated string.
            addressLine1: singleLineAddress, 
            
            // The following fields are returned for data integrity.
            landmark: finalLandmark, 
            postOffice: postOffice, 
            tehsil: tehsil, 
            district: district, 
            state: state, 
            pin: finalPin, 
            
            addressQuality: parsedData.AddressQuality || 'Medium', 
            locationType: parsedData.LocationType || 'Unknown', 
            locationSuitability: parsedData.LocationSuitability || 'Unknown', 
            remarks: remarks.join('; ').trim(), 
        }; 

        // NO remainingCredits returned here
        return res.status(200).json(finalResponse); 

    } catch (e) {
        console.error('POST /api/public-single-address error:', e); 
        return res.status(500).json({ status: 'Error', message: `Internal Server Error: ${e.message}` }); 
    }
};
