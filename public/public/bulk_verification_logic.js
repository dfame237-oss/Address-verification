// public/bulk_verification_logic.js
// This script is imported by client-dashboard.html and uses its global scope:
// const API_ENDPOINT;
// const isPlanValid;
// function checkPlanValidity();
// async function authFetch(url, options); 
// const LOGIN_PAGE;

// --- BULK VERIFICATION CORE FUNCTIONS ---

function updateStatusMessage(message, isError = false) { 
    const statusMessage = document.getElementById('status-message');
    if (!statusMessage) return; 

    statusMessage.textContent = message;
    
    statusMessage.classList.remove('text-red-700', 'bg-red-100', 'text-gray-600');
    statusMessage.classList.add('p-2', 'rounded');

    if (isError) {
        statusMessage.classList.add('text-red-700', 'bg-red-100', 'font-bold');
        statusMessage.classList.remove('text-gray-600');
    } else {
        statusMessage.classList.add('text-gray-600');
        statusMessage.classList.remove('bg-red-100', 'font-bold');
    }
}

function handleTemplateDownload() {
    const templateHeaders = "ORDER ID,CUSTOMER NAME,CUSTOMER RAW ADDRESS\n";
    const templateData = 
        "1,\"John Doe\",\"H.No. 123, Sector 40B, near bus stand, Chandigarh\"\n" +
        "2,\"Jane Smith\",\"5th Floor, Alpha Tower, Mumbai 400001\"\n";
        
    const csvContent = templateHeaders + templateData;
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', 'address_verification_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function parseCSV(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return [];

    const header = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, ''));
    const data = [];
    
    const idIndex = header.indexOf('ORDER ID');
    const nameIndex = header.indexOf('CUSTOMER NAME');
    const addressIndex = header.indexOf('CUSTOMER RAW ADDRESS');

    if (idIndex === -1 || nameIndex === -1 || addressIndex === -1) {
        console.error("CSV header is missing one of the required columns.");
        return [];
    }

    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        
        const row = lines[i].match(/(".*?"|[^",\r\n]+)(?=\s*,|\s*$)/g) || [];
        
        const cleanedRow = row.map(cell => cell.trim().replace(/^\"|\"$/g, '').replace(/\"\"/g, '\"'));

        if (cleanedRow.length > Math.max(idIndex, nameIndex, addressIndex)) {
            data.push({
                'ORDER ID': cleanedRow[idIndex],
                'CUSTOMER NAME': cleanedRow[nameIndex],
                'CUSTOMER RAW ADDRESS': cleanedRow[addressIndex],
            });
        }
    }
    return data;
}

// CRITICALLY FIXED FUNCTION: Now uses authFetch and correctly handles session errors
async function fetchVerification(rawAddress, customerName) {
    const payload = { address: rawAddress, customerName }; 
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // CRITICAL: Uses the global, authenticated fetch wrapper
            const response = await authFetch(API_ENDPOINT, { 
                method: 'POST',
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) {
                const errorBody = await response.json();
                throw new Error(errorBody.error || `Server responded with status ${response.status}`);
            }
            
            return await response.json();

        } catch (error) {
            lastError = error;
            
            // CRITICAL FIX: If authFetch throws the session error, stop retrying immediately.
            // This is required to prevent continuous loops if the token is bad.
            if (error.message.includes("Session expired")) {
                throw error; 
            }
            
            console.error(`Verification API Attempt ${attempt + 1} failed:`, error);
            if (attempt < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }
    return { 
        status: "Error", 
        error: `Verification failed after ${maxRetries} attempts.`,
        remarks: `Error: ${lastError ? lastError.message : 'Unknown Network Error'}`,
        customerCleanName: customerName,
        addressLine1: "API Error: See Remarks",
        landmark: "",
        state: "",
        district: "",
        pin: "",
        addressQuality: "VERY BAD"
    };
}

function createAndDownloadCSV(rows, filename) {
    const header = "ORDER ID,CUSTOMER NAME,CUSTOMER RAW ADDRESS,CLEAN NAME,CLEAN ADDRESS LINE 1,LANDMARK,STATE,DISTRICT,PIN,REMARKS,QUALITY\n";
    const csvContent = header + rows.join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const downloadLink = document.getElementById('downloadLink');
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.classList.remove('hidden');
}

async function handleBulkVerification() {
    if (!checkPlanValidity() || !isPlanValid) {
        updateStatusMessage("Access denied. Plan is expired or disabled.", true);
        return;
    }

    const fileInput = document.getElementById('csvFileInput');
    const processButton = document.getElementById('processButton');
    const progressBarFill = document.getElementById('progressBarFill');
    const downloadLink = document.getElementById('downloadLink');

    if (!fileInput.files.length) {
        updateStatusMessage("Please select a CSV file first.", true);
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    processButton.disabled = true;
    fileInput.disabled = true;
    downloadLink.classList.add('hidden');
    progressBarFill.style.width = '0%';
    updateStatusMessage('Reading file...');
    
    reader.onload = async function(e) {
        const text = e.target.result;
        const addresses = parseCSV(text);
        
        if (addresses.length === 0) {
            updateStatusMessage("Error: No valid addresses found in CSV. Check format and required columns.", true);
            processButton.disabled = false;
            fileInput.disabled = false;
            return;
        }

        const totalAddresses = addresses.length;
        let processedCount = 0;
        const outputRows = [];

        updateStatusMessage(`Starting verification of ${totalAddresses} addresses...`);

        for (const row of addresses) {
            const orderId = row['ORDER ID'] || '';
            const customerName = row['CUSTOMER NAME'] || '';
            const rawAddress = row['CUSTOMER RAW ADDRESS'] || '';

            let verificationResult;

            if (!rawAddress || rawAddress.trim() === "") { 
                verificationResult = { status: "Skipped", remarks: "Missing raw address in CSV row.", addressQuality: "Poor", customerCleanName: customerName, addressLine1: "", landmark: "", state: "", district: "", pin: "" };
            } else {
                verificationResult = await fetchVerification(rawAddress, customerName);
            }

            const escapeAndQuote = (cell) => `\"${String(cell || '').replace(/\"/g, '\"\"')}\"`;

            const outputRow = [
                orderId,
                customerName,
                rawAddress,
                verificationResult.customerCleanName,
                verificationResult.addressLine1,
                verificationResult.landmark,
                verificationResult.state,
                verificationResult.district,
                verificationResult.pin,
                verificationResult.remarks,
                verificationResult.addressQuality
            ].map(escapeAndQuote).join(',');

            outputRows.push(outputRow);
            
            processedCount++;
            const progress = (processedCount / totalAddresses) * 100;
            progressBarFill.style.width = `${progress}%`;
            
            updateStatusMessage(`Processing... ${processedCount} of ${totalAddresses} addresses completed.`);
        }

        updateStatusMessage(`Processing complete! ${totalAddresses} addresses verified. Click 'Download Verified CSV'.`, false);
        createAndDownloadCSV(outputRows, "verified_addresses.csv");
        processButton.disabled = false;
        fileInput.disabled = false;
    };

    reader.onerror = function() {
        updateStatusMessage("Error reading file.", true);
        processButton.disabled = false;
        fileInput.disabled = false;
    };

    reader.readAsText(file);
}

// Function called by window.onload in client-dashboard.html
function initBulkListeners() {
    if (isPlanValid) {
        const downloadTemplateButton = document.getElementById('downloadTemplateButton');
        const csvFileInput = document.getElementById('csvFileInput');
        const processButton = document.getElementById('processButton');

        if (downloadTemplateButton) {
            downloadTemplateButton.addEventListener('click', handleTemplateDownload);
        }

        if (csvFileInput) {
            csvFileInput.addEventListener('change', () => {
                if (processButton) {
                    processButton.disabled = !csvFileInput.files.length;
                }
            });
        }

        if (processButton) {
            processButton.addEventListener('click', handleBulkVerification);
        }
    }
}