// api/verify-single-address.js
// Final Logic Source for both single and bulk verification.
const INDIA_POST_API = 'https://api.postalpincode.in/pincode/'; 
let pincodeCache = {};

// --- Google Cloud Translation Setup (REMOVED: Using Gemini directly for speed) ---
// Note: Relying on prompt for translation.
const testingKeywords = ['test', 'testing', 'asdf', 'qwer', 'zxcv', 'random', 'gjnj', 'fgjnj'];
const coreMeaningfulWords = [
    "ddadu", "ddadu", "ai", "add", "add-", "raw", "dumping", "grand", "dumping grand",
    "chd", "chd-", "chandigarh", "chandigarh-", "chandigarh", "west", "sector", "sector-",
    "house", "no", "no#", "house no", "house no#", "floor", "first", "first floor",
    "majra", "colony", "dadu", "dadu majra", "shop", "wine", "wine shop", "house", "number",
    "tq", "job", "dist"
];
const meaningfulWords = [...coreMeaningfulWords, ...testingKeywords]; 
// FIX: Use an Immediately Invoked Function Expression (IIFE) to compile the regex, 
// ensuring the 'meaningfulWords' variable is fully defined first.
const meaninglessRegex = (() => {
    try {
        return new RegExp(`\\b(?:${meaningfulWords.join('|')})\\b`, 'gi');
    } catch (e) {
        console.error("Failed to compile meaninglessRegex:", e);
        return /a^/; // Return a regex that matches nothing as a safe fallback
    }
})();

const directionalKeywords = ['near', 'opposite', 'back side', 'front side', 'behind', 'opp', 'beside', 'in front', 'above', 'below', 'next to'];
// --- DB helper and auth ---
const { connectToDatabase } = require('../utils/db');
const jwt = require('jsonwebtoken'); 
const { ObjectId } = require('mongodb'); 
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';

// --- Static Map for Location Conflict Check (New) ---
const MAJOR_CITY_CONFLICTS = {
    'mumbai': 'Maharashtra',
    'delhi': 'Delhi',
    'chennai': 'Tamil Nadu',
    'bangalore': 'Karnataka',
    'kolkata': 'West Bengal',
};

// --- NEW: Keywords used to flag results for Manual Check (Updated for email) ---
const CRITICAL_KEYWORDS = [
    'CRITICAL_ALERT: Wrong PIN', 
    'CRITICAL_ALERT: AI-provided PIN',
    'CRITICAL_ALERT: PIN not found',
    'CRITICAL_ALERT: Raw address lacks',
    'CRITICAL_ALERT: Raw address contains email', // NEW ALERT KEYWORD
    'CRITICAL_ALERT: Major location conflict',
    'CRITICAL_ALERT: Formatted address is short',
    'CRITICAL_ALERT: JSON parse failed',
    'CRITICAL_ALERT: Address lacks specificity' // NEW KEYWORD FOR MISSING H.NO/STREET
];


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

// --- Gemini helper (UPGRADED and maxOutputTokens REMOVED) ---
async function getGeminiResponse(prompt) { 
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return { text: null, error: "Gemini API key not set in environment variables."
        };
    }
    // ENHANCEMENT: Switched to gemini-2.5-flash for better performance/cost balance
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`; 

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        // maxOutputTokens removed to rely on API default (which is usually sufficient for single-address verification)
        config: {
            temperature: 0.1,
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
        
        // Check for non-200 status or specific Gemini error messages
        if (response.status !== 200 || result.error) {
            const rawErrorMessage = result.error?.message || "Unknown API error.";
            console.error(`Gemini API Error (Raw): ${rawErrorMessage}`); 
            // Return a generic error message for the client
            return { text: null, error: "External AI verification service failure. Please try again." }; 
        }

        if (result.candidates && result.candidates.length > 0) {
            return { text: result.candidates[0].content.parts[0].text, error: null };
        } else {
            const errorMessage = "Gemini API Error: No candidates found in response."; 
            console.error(errorMessage);
            // Return a generic error message for the client
            return { text: null, error: "External AI verification service failed to return data." }; 
        }
    } catch (e) {
        const errorMessage = `Error during Gemini API call: ${e.message}`;
        console.error(errorMessage); 
        // Return a generic error message for the client
        return { text: null, error: "A network issue occurred while contacting the AI service." }; 
    }
}

// --- Utilities & Prompt Builder ---
function extractPin(address) {
    const match = String(address).match(/\b\d{6}\b/);
    return match ? match[0] : null; 
}

// *** NEW: Function to check for email address in a string ***
function extractEmail(text) {
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/;
    const match = String(text).match(emailRegex);
    return match ? match[0] : null;
}
// *** END NEW ***


function buildGeminiPrompt(originalAddress, postalData) {
    let basePrompt = `You are an expert Indian address verifier and formatter.
    Your task is to process a raw address, perform a thorough analysis, and provide a comprehensive response in a single JSON object.
    
    ***STRICT AND IMMEDIATE TRANSLATION REQUIRED***
    **Provide ALL responses in English only. Strictly translate ALL extracted address components (Locality, P.O., Tehsil, Landmark, FormattedAddress, etc.) to English. FAILURE TO DO SO WILL RESULT IN IMMEDIATE REJECTION.**
    
    **Correct all common spelling and phonetic errors in the provided address, such as "rd" to "Road", "nager" to "Nagar", and "nd" to "2nd".**
    **Analyze common short forms and phonetic spellings, such as "ln" for "Lane", and use your best judgment to correct them.**
    Be strict about ensuring the output is a valid, single, and complete address for shipping.
    **Use your advanced knowledge to identify and remove any duplicate address components that are present consecutively (e.g., 'Gandhi Street Gandhi Street' should be 'Gandhi Street').**
    
    ***SELF-CORRECTION CHECK: Before finalizing the JSON, verify that every field containing text, including "FormattedAddress" and all component fields, is written entirely in English.***
    
    **CRITICAL INSTRUCTION:** If official Postal Data (State/District/PIN) is provided, you MUST ensure that your formatted address and extracted fields align perfectly with this official data. Remove any conflicting city, state, or district names from the raw address (e.g., if the raw address says 'Mumbai' but the PIN is for 'Delhi', you MUST remove 'Mumbai' from the FormattedAddress and set 'State'/'DIST.' to the official Delhi data).

    Your response must contain the following keys:
    1.  "H.no.", "Flat No.", "Plot No.", "Room No.", "Building No.", "Block No.", "Ward No.", "Gali No.", "Zone No.", "Quarter No.", "Road No.", "Street No.", "Sector", "Phase": Extract only the number or alphanumeric sequence (e.g., '1-26', 'A/25', '10'). 
    
    **CRITICAL PREFIX PRESERVATION RULE:** The prefix used in your JSON output (e.g., "H.no.", "Block No.", "Street No.") MUST match the type used in the original raw address, even if misspelled or abbreviated by the customer (e.g., 'st n.', 'blck no.'). **Analyze the raw address to determine the original prefix type.** If the customer used 'street n.', output 'Street No.'; if 'blck', output 'Block No.'. **If the customer used the short form 'H.no.', retain it exactly as 'H.no.'.** If no specific prefix is used, default to the most descriptive term found (e.g., 'H.no.' for house details, 'Block No.' for block details).
    
    **CRITICAL PIN EXTRACTION RULE: Never extract the 6-digit PIN code or the customer's 10-digit phone number into any of these number fields.**
    
    Set to null if not found.
    2.  "Colony", "Street", "Locality", "Building Name", "House Name", "Floor": Extract the name. **(MUST BE IN ENGLISH)**
    3.  "P.O.": The **OFFICIAL, BEST-MATCHING** Post Office name from the PIN data that most closely matches the customer's locality. **You must analyze ALL Post Office names in the list and select the most appropriate one.** Prepend "P.O." to the name. Example: "P.O. Boduppal". **(MUST BE IN ENGLISH)**
    4.  "Tehsil": The official Tehsil/SubDistrict corresponding to the **P.O. you selected.** Prepend "Tehsil". Example: "Tehsil Pune". **(MUST BE IN ENGLISH)**
    5.  "DIST.": The official District corresponding to the **P.O. you selected.** **(MUST BE IN ENGLISH)**
    6.  "State": The official State corresponding to the **P.O. you selected.** **(MUST BE IN ENGLISH)**
    7.  "PIN": The 6-digit PIN code. Find and verify the correct PIN.
    If a PIN exists in the raw address but is incorrect, find the correct one and provide it.
    8.  "Landmark": A specific, named landmark (e.g., "Apollo Hospital"), not a generic type like "school".
    If multiple landmarks are present, list them comma-separated. **Extract the landmark without any directional words like 'near', 'opposite', 'behind' etc., as this will be handled by the script. (MUST BE IN ENGLISH)**
    9.  "Remaining": A last resort for any text that does not fit into other fields.
    Clean this by removing meaningless words like 'job', 'raw', 'add-', 'tq', 'dist' and country, state, district, or PIN code. **(MUST BE IN ENGLISH)**
    10. "FormattedAddress": This is the most important field. Based on your full analysis, create a single, clean, human-readable, and comprehensive shipping-ready address string. It should contain all specific details (H.no., Room No., etc.), followed by locality, street, colony, P.O., and Tehsil. **STRICTLY DO NOT include District, State, or PIN in this string. (MUST BE IN ENGLISH)**
    11. "LocationType": Identify the type of location (e.g., "Village", "Town", "City", "Urban Area"). **(MUST BE IN ENGLISH)**
    12. "AddressQuality": Analyze the address completeness and clarity for shipping.
    Categorize it as one of the following: Very Good, Good, Medium, Bad, or Very Bad. **(MUST BE IN ENGLISH)**
    13. "LocationSuitability": Analyze the location based on its State, District, and PIN to determine courier-friendliness in India.
    Categorize it as one of the following: Prime Location, Tier 1 & 2 Cities, Remote/Difficult Location, or Non-Serviceable Location. **(MUST BE IN ENGLISH)**
    Raw Address: "${originalAddress}"
`; 

    if (postalData.PinStatus === 'Success') {
        // ENHANCEMENT: Providing the full list to AI for better P.O. selection
        basePrompt += `\nOfficial Postal Data: ${JSON.stringify(postalData.PostOfficeList)}\n**You MUST analyze this ENTIRE list and select the single Post Office that best matches the customer's locality. Use web search/Google to cross-reference the customer's locality against these Post Office names for 100% accuracy.**`; 
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

// --- NEW: Dedicated Name Cleaner and Translator ---
async function getTranslatedCleanName(rawName) {
    if (!rawName) return null;
    
    // Prompt dedicated solely to name cleaning and translation
    const namePrompt = `Clean, correct, and aggressively translate the following customer name to English. Remove any numbers, special characters, titles (Mr, Ms, Dr), or extraneous text. Provide ONLY the resulting cleaned, translated name, with no additional text or punctuation. Name: "${rawName}"`;
    
    const response = await getGeminiResponse(namePrompt);
    
    // Fallback: If Gemini fails to respond, perform the basic regex cleanup and use that.
    return response.text ? response.text.trim() : (rawName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim(); 
}

// --- NEW: Aggressive Address Component Translator (Final Cleanup for Address Fields) ---
async function getTranslatedAddressComponent(rawText) {
    if (!rawText || rawText.length < 3) return rawText;
    
    // Prompt designed to force translation of specific proper nouns and phrases (e.g., Landmarks)
    const prompt = `Translate the following short address component or proper noun to standard English. Correct any phonetic spelling errors. Provide ONLY the result with no additional context. Phrase: "${rawText}"`;
    
    const response = await getGeminiResponse(prompt);
    
    // Fallback: Use the original text if translation fails.
    return response.text ? response.text.trim() : rawText;
}


// --- NEW: Reusable Verification Logic Function (Unified) ---
async function runVerificationLogic(address, customerName) {
    // *** CRITICAL FIX START: Safely define necessary address variables to prevent fatal error ***
    const originalAddress = String(address || '').trim();
    const originalAddressLower = originalAddress.toLowerCase();

    if (!originalAddress) {
        return {
            status: "Error", remarks: "Input address was empty or invalid.", addressQuality: "Very Bad",
            customerCleanName: (customerName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim() || null, 
            addressLine1: "", landmark: "", state: "", district: "", pin: "", success: false
        };
    }
    // *** CRITICAL FIX END ***

    let remarks = [];
    
    // --- NEW REQUIREMENT 1: IMMEDIATE EMAIL CHECK ---
    const detectedEmail = extractEmail(originalAddress);
    if (detectedEmail) {
        remarks.push(`CRITICAL_ALERT: Raw address contains email: ${detectedEmail}. Manual check needed.`);
        // Immediately return a 'Very Bad' result for manual check, without calling AI
        return {
            status: "Skipped", remarks: remarks.join('; ').trim(), addressQuality: "Very Bad", 
            customerCleanName: (customerName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim() || null,
            addressLine1: originalAddress, landmark: "", state: "", district: "", pin: extractPin(originalAddress), success: false
        };
    }
    // --- END NEW REQUIREMENT 1 ---
    
    // --- 1. DEDICATED NAME CLEANING & TRANSLATION (Aggressive Fix) ---
    let cleanedName = await getTranslatedCleanName(customerName);
    
    const initialPin = extractPin(originalAddress);
    let postalData = { PinStatus: 'Error' };

    if (initialPin) {
        postalData = await getIndiaPostData(initialPin);
    }
    
    // 2. Call Gemini API for Address Verification
    const geminiResult = await processAddress(originalAddress, postalData);

    if (geminiResult.error || !geminiResult.text) {
        // FIX: Mask the specific Gemini error in the remarks returned to the client
        const maskedRemarks = "Verification failed due to a problem with the external AI service.";
        return {
            status: "Error", remarks: maskedRemarks, addressQuality: "Very Bad", 
            customerCleanName: cleanedName, addressLine1: originalAddress, landmark: "", state: "", district: "", pin: initialPin, success: false
        };
    }

    // 3. Parse Gemini JSON output
    let parsedData;
    try {
        const jsonText = geminiResult.text.replace(/```json|```/g, '').trim(); 
        parsedData = JSON.parse(jsonText);
    } catch (e) {
        const maskedRemarks = `CRITICAL_ALERT: AI response format error. Verification service returned unreadable data.`;
        remarks.push(maskedRemarks);
        parsedData = {
            FormattedAddress: originalAddress.replace(meaninglessRegex, '').trim(),
            Landmark: '', State: '', DIST: '', PIN: initialPin, 
            AddressQuality: 'Very Bad', Remaining: maskedRemarks, // Use masked message here
        };
    }
    
    // --- 4. MANDATORY POST-PARSING TRANSLATION (Parallel Check for Address Components) ---
    // If the aggressive prompt failed, this final step uses dedicated AI calls to translate components.
    if (typeof getTranslatedAddressComponent === 'function') {
        const fieldsToTranslate = [
            'FormattedAddress', 'Landmark', 'State', 'DIST.', 'P.O.', 'Tehsil', 'Remaining'
        ];
        
        const translationPromises = [];
        const keysToUpdate = [];

        // Collect all translation promises
        for (const key of fieldsToTranslate) {
            if (parsedData[key] && typeof parsedData[key] === 'string') {
                translationPromises.push(getTranslatedAddressComponent(parsedData[key])); 
                keysToUpdate.push(key);
            }
        }

        // Execute all address translation calls in parallel for speed
        const translatedResults = await Promise.all(translationPromises);
        
        // Re-assign translated address fields
        for (let i = 0; i < keysToUpdate.length; i++) {
            parsedData[keysToUpdate[i]] = translatedResults[i];
        }
    }


    // 5. --- PIN VERIFICATION & CORRECTION LOGIC ---
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
    } else {
        remarks.push('CRITICAL_ALERT: PIN not found after verification attempts. Manual check needed.');
        finalPin = initialPin || null; 
    }

    // 🎯 FIX 1A: PREVENT PIN/PHONE FROM BEING TREATED AS H.NO. (OR ANY ADDRESS COMPONENT NUMBER)
    const potentialPin = finalPin;
    const houseNumber = parsedData['H.no.'];
    const phoneMatch = originalAddress.match(/\b\d{10}\b/);
    const potentialPhone = phoneMatch ? phoneMatch[0] : null;

    if (houseNumber && (houseNumber === potentialPin || houseNumber === potentialPhone)) {
        remarks.push(`CRITICAL_ALERT: Removed PIN/Phone (${houseNumber}) incorrectly extracted as H.no.`);
        parsedData['H.no.'] = null;
        // Also remove from formatted address to clean the output
        if (parsedData.FormattedAddress) {
            // Use regex to replace the exact number extracted as H.no.
            parsedData.FormattedAddress = parsedData.FormattedAddress.replace(new RegExp(`\\b${houseNumber}\\b`, 'g'), '').replace(/\s+/g, ' ').trim();
        }
    }


    // --- 6. Local Address Correction Logic (P.O. Conflict Check) ---
    postVerificationCorrections(parsedData, originalAddress, remarks);


    // CRITICAL CHANGE: The state is now verified using the AI's output, as the AI selected the P.O.
    const verifiedState = parsedData.State || '';
    let currentQuality = parsedData.AddressQuality;

    // --- 7. ADJACENT DUPLICATE REMOVAL (Clean final address strings) ---
    const removeAdjacentDuplicates = (str) => {
        if (!str) return str;
        const words = str.split(' ');
        const cleanedWords = [];
        for (let i = 0; i < words.length; i++) {
            if (i === 0 || words[i].toLowerCase() !== words[i - 1].toLowerCase()) {
                cleanedWords.push(words[i]);
            }
        }
        return cleanedWords.join(' ');
    };

    if (parsedData.FormattedAddress) {
        parsedData.FormattedAddress = removeAdjacentDuplicates(parsedData.FormattedAddress);
    }
    if (parsedData.Landmark) {
        parsedData.Landmark = removeAdjacentDuplicates(parsedData.Landmark);
    }

    // --- 8. Village Prefix Logic (From Google Script) ---
    if (originalAddressLower.includes('village') && parsedData.FormattedAddress) {
        // Only prefix if it's not already prefixed
        if (!parsedData.FormattedAddress.toLowerCase().startsWith('village')) {
            parsedData.FormattedAddress = `Village ${parsedData.FormattedAddress}`;
        }
    }

    // --- NEW FIX: Enforce H.no. abbreviation (Post-AI correction) ---
    if (parsedData.FormattedAddress) {
        // Use a case-insensitive regex to replace the full phrase "House number" (or any case variation) with "H.no."
        // We use \b to ensure we only match whole words
        parsedData.FormattedAddress = parsedData.FormattedAddress.replace(/\bHouse number\b/gi, 'H.no.');
    }
    // --- END NEW FIX ---


    // 9. --- RULE: Missing Locality/Specifics Check (UPDATED FOR STRICTER LOGIC) ---
    const hasHouseOrFlat = parsedData['H.no.'] || parsedData['Flat No.'] || parsedData['Plot No.'] || parsedData['Room No.'];
    const hasStreetOrColony = parsedData.Street || parsedData.Colony || parsedData.Locality;
    const hasAnySpecificDetail = hasHouseOrFlat || hasStreetOrColony; // Simplified check

    // RULE 9a: Check if *both* a specific number AND a locality/street/colony are missing.
    if (!hasAnySpecificDetail) {
        // 🎯 FIX 2: Added more specific remark and force downgrade
        remarks.push(`CRITICAL_ALERT: Address lacks specificity (missing H.no./Flat/Street/Colony details).`);
        if (currentQuality === 'Very Good' || currentQuality === 'Good' || currentQuality === 'Medium') {
            parsedData.AddressQuality = 'Bad';
        }
        currentQuality = parsedData.AddressQuality; 
    }
    
    // RULE 9b: Stricter check for addresses that look like only PIN/Phone (your example case)
    const isFormattedAddressShort = parsedData.FormattedAddress && parsedData.FormattedAddress.length < 25;
    
    if (isFormattedAddressShort && !hasAnySpecificDetail) {
        // If the address is short and has no core details, it must be flagged 'Very Bad'
        remarks.push(`CRITICAL_ALERT: Formatted address is critically short and lacks specifics (House/Street/Colony). Manual check needed.`);
        parsedData.AddressQuality = 'Very Bad';
        currentQuality = parsedData.AddressQuality;
    }
    // --- END UPDATED STRICTER LOGIC ---

    // 10. --- RULE: Location Conflict Downgrade Check ---
    if (verifiedState) {
        const verifiedStateLower = verifiedState.toLowerCase();
        for (const city in MAJOR_CITY_CONFLICTS) {
            const expectedStateLower = MAJOR_CITY_CONFLICTS[city].toLowerCase();

            // Use the safely defined variable here
            if (originalAddressLower.includes(city) && !verifiedStateLower.includes(expectedStateLower)) { 
                remarks.push(`CRITICAL_ALERT: Major location conflict found. Raw address mentioned '${city.toUpperCase()}' but verified state is '${verifiedState}'.`);
                
                parsedData.AddressQuality = 'Very Bad';
                currentQuality = parsedData.AddressQuality; // Update for next check
                break; 
            }
        }
    }

    // 11. --- Short Address Check ---
    if (parsedData.FormattedAddress && parsedData.FormattedAddress.length < 35 && currentQuality !== 'Very Good' && currentQuality !== 'Good') {
        remarks.push(`CRITICAL_ALERT: Formatted address is short (${parsedData.FormattedAddress.length} chars). Manual verification recommended.`);
    }

    // 12. --- Landmark directional prefix logic ---
    let landmarkValue = parsedData.Landmark || ''; 
    let finalLandmark = ''; 
    if (landmarkValue.toString().trim() !== '') {
        // Use the safely defined variable here
        const foundDirectionalWord = directionalKeywords.find(keyword => originalAddressLower.includes(keyword)); 
        
        if (foundDirectionalWord) {
            const originalDirectionalWordMatch = originalAddress.match(new RegExp(`\\b${foundDirectionalWord.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i'));
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
    
    // --- NEW FIX: Remove Blank Prefixes from Formatted Address (Fixes H.no. , issue) ---
    if (parsedData.FormattedAddress) {
        let cleanedFormattedAddress = parsedData.FormattedAddress;

        // 1. Define common address prefixes the AI might insert blankly
        const commonPrefixes = [
            'H\\.no\\.', 'Flat No\\.', 'Plot No\\.', 'Room No\\.', 'Building No\\.', 
            'Block No\\.', 'Ward No\\.', 'Gali No\\.', 'Zone No\\.', 'Quarter No\\.', 
            'Road No\\.', 'Street No\\.', 'Sector', 'Phase'
        ];
        
        // 2. Create a regex pattern to find any of these prefixes followed by zero or more separators/spaces
        // The regex looks for the word boundary (\b), the prefix, and then any combination of spaces/commas/dashes and spaces (\s*[:,\-]?\s*)
        const blankPrefixPattern = new RegExp(
            `\\b(?:${commonPrefixes.join('|')})\\s*[:,\-]?\\s*`, 'gi'
        );

        // 3. Remove the entire pattern if found
        cleanedFormattedAddress = cleanedFormattedAddress.replace(blankPrefixPattern, '');

        // 4. Aggressive Final Cleanup (Essential after the removal above)
        cleanedFormattedAddress = cleanedFormattedAddress
            .replace(/,\s*,/g, ', ')    // Remove double commas (e.g., from removing a middle component)
            .replace(/,\s*$/g, '')      // Remove trailing commas/spaces
            .replace(/^\s*,/g, '')      // Remove leading commas/spaces
            .replace(/\s+/g, ' ').trim(); // Clean up extra spaces

        parsedData.FormattedAddress = cleanedFormattedAddress;
    }
    // --- END NEW FIX ---

    // Build final response object
    return {
        status: "Success",
        customerRawName: customerName,
        customerCleanName: cleanedName, // Now comes from dedicated name call
        
        // Use the fixed address variable here
        addressLine1: parsedData.FormattedAddress || originalAddress.replace(meaninglessRegex, '').trim() || '', 
        landmark: finalLandmark, 
        
        // P.O. FIX: Enforce 'P.O.' prefix on the AI-selected name
        postOffice: (() => {
            const poName = parsedData['P.O.'] || '';
            if (!poName) return '';
            const nameLower = poName.toLowerCase();
            // Check if it already has a prefix from AI, if not, add 'P.O. '
            if (nameLower.startsWith('p.o.') || nameLower.startsWith('post office')) {
                return poName; 
            }
            return `P.O. ${poName}`; // Enforce short prefix
        })(),
        // Tehsil FIX: Enforce 'Tehsil' prefix on the AI-selected name
        tehsil: (() => {
            const tehsilName = parsedData.Tehsil || '';
            if (!tehsilName) return '';
            // Check if it already has a prefix from AI, if not, add 'Tehsil '
            if (tehsilName.toLowerCase().startsWith('tehsil')) {
                return tehsilName; 
            }
            return `Tehsil ${tehsilName}`; // Enforce prefix
        })(),
        // District and State: Use AI's chosen data, which was cross-validated against the official list
        district: parsedData['DIST.'] || '', 
        state: parsedData.State || '', 
        
        pin: finalPin, 
        addressQuality: parsedData.AddressQuality || 'Medium', 
        locationType: parsedData.LocationType || 'Unknown', 
        locationSuitability: parsedData.LocationSuitability || 'Unknown', 
        remarks: remarks.join('; ').trim(),
        success: true // Indicate successful verification
    };
}

// --- Auxiliary Local Correction Functions (Copied from Google Script) ---

/**
 * Implements the P.O. conflict check logic found in your Google Script's 
 * verifyAndCorrectAddress function.
 */
function postVerificationCorrections(geminiData, originalAddress, remarks) {
    const aiLocality = geminiData["Locality"] || geminiData["Colony"] || '';
    const aiPo = geminiData["P.O."];
    
    // Check specific known locality conflicts (from your Google Sheet script)
    const correctedData = getPostalDataByLocality(aiLocality);
    
    if (correctedData) {
        // If Gemini gave a locality that matches a known static table entry:
        const normalizedAiPo = String(aiPo || '').toLowerCase();
        const normalizedCorrectedPo = `p.o. ${correctedData["P.O."].toLowerCase()}`;

        if (normalizedAiPo !== normalizedCorrectedPo) {
            remarks.push(`P.O. conflict: Corrected P.O. from "${geminiData["P.O."]}" to "P.O. ${correctedData["P.O."]}"`);
            
            // Overwrite Gemini data with the correct postal data from the lookup table
            geminiData["P.O."] = `P.O. ${correctedData["P.O."]}`;
            geminiData["DIST."] = correctedData["DIST."];
            geminiData["State"] = correctedData["State"];

            if (geminiData["PIN"] !== correctedData["PIN"]) {
                remarks.push(`PIN conflict: Corrected PIN from "${geminiData["PIN"]}" to "${correctedData["PIN"]}"`);
                geminiData["PIN"] = correctedData["PIN"];
            }
        }
    }
}

/**
 * Static lookup table for P.O. conflict checks (Copied from Google Script)
 */
function getPostalDataByLocality(locality) {
    const lookupTable = {
        "boduppal": {
            "P.O.": "Boduppal",
            "DIST.": "Hyderabad",
            "State": "Telangana",
            "PIN": "500092"
        },
        "putlibowli": {
            "P.O.": "Putlibowli",
            "DIST.": "Hyderabad",
            "State": "Telangana",
            "PIN": "500095"
        }
    };
    return lookupTable[locality.toLowerCase()] || null;
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
            if ((finalResponse.status === "Error" || finalResponse.status === "Skipped") && reserved) {
                 try {
                     await clients.updateOne({ _id: client._id }, { $inc: { remainingCredits: 1 } });
                 } catch (refundErr) {
                     console.error('Failed to refund reserved credit after AI/system error:', refundErr);
                 }
                 // Return the masked error message from runVerificationLogic
                 return res.status(500).json({ status: finalResponse.status, message: finalResponse.remarks });
            }
            // If status is "Skipped" (due to email), return 200 but inform the client
            if (finalResponse.status === "Skipped") {
                return res.status(200).json({ status: finalResponse.status, message: finalResponse.remarks, remainingCredits: reserved ? (client.remainingCredits ?? 0) : 'Unlimited' });
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

// Export core functions for use in bulk-jobs.js AND for classification logic
module.exports.getIndiaPostData = getIndiaPostData;
module.exports.getGeminiResponse = getGeminiResponse;
module.exports.processAddress = processAddress;
module.exports.extractPin = extractPin;
module.exports.meaninglessRegex = meaninglessRegex;
module.exports.runVerificationLogic = runVerificationLogic;
module.exports.CRITICAL_KEYWORDS = CRITICAL_KEYWORDS; // NEW EXPORT