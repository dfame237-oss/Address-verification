// public/bulk_verification_logic.js
// Bulk verification logic with credit checks and UI updates.
// Relies on global: API_ENDPOINT, isPlanValid, checkPlanValidity, authFetch, LOGIN_PAGE

// --- UI helpers (existing) ---
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

// --- Template download (unchanged) ---
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

// --- CSV parsing (unchanged) ---
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

// --- Credit helper: GET remaining credits (no consumption) ---
async function getRemainingCredits() {
    try {
        const resp = await authFetch('/api/verify-single-address', { method: 'GET' });
        const json = await resp.json();
        if (!resp.ok || json.status === 'Error') {
            return { ok: false, error: json.message || 'Failed to fetch credits' };
        }
        return { ok: true, remainingCredits: json.remainingCredits, initialCredits: json.initialCredits, planName: json.planName };
    } catch (e) {
        console.error('getRemainingCredits error:', e);
        return { ok: false, error: e.message || 'Network error' };
    }
}

// --- Server verification call (consumes a credit on success) ---
// Retries kept small because each attempt may consume a credit server-side.
async function fetchVerification(rawAddress, customerName) {
    const payload = { address: rawAddress, customerName };
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await authFetch(API_ENDPOINT, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            // Parse JSON regardless of ok flag
            const json = await response.json().catch(() => ({ status: 'Error', message: 'Invalid JSON from server' }));

            // Handle quota exhausted specially (server uses status: 'QuotaExceeded')
            if (json.status === 'QuotaExceeded') {
                return { status: 'QuotaExceeded', message: json.message || 'Credits exhausted', remainingCredits: json.remainingCredits ?? 0 };
            }

            if (!response.ok || json.status === 'Error') {
                // server reported an error (non-credit related)
                throw new Error(json.message || `Server error (status ${response.status})`);
            }

            // Success: server returns verification result and remainingCredits (we expect that)
            return json;

        } catch (error) {
            lastError = error;
            // If session expired or authFetch bubbled that, rethrow to force login redirect
            if (error.message && error.message.toLowerCase().includes('session')) {
                throw error;
            }
            console.error(`Verification API attempt ${attempt + 1} failed:`, error);
            if (attempt < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }

    // If all retries failed, return an error object compatible with original code
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

// --- CSV result builder (unchanged) ---
function createAndDownloadCSV(rows, filename) {
    const header = "ORDER ID,CUSTOMER NAME,CUSTOMER RAW ADDRESS,CLEAN NAME,CLEAN ADDRESS LINE 1,LANDMARK,STATE,DISTRICT,PIN,REMARKS,QUALITY\n";
    const csvContent = header + rows.join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const downloadLink = document.getElementById('downloadLink');
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.classList.remove('hidden');
}

// --- Main bulk handler (credit-aware) ---
async function handleBulkVerification() {
    if (!checkPlanValidity() || !isPlanValid) {
        updateStatusMessage("Access denied. Plan is expired or disabled.", true);
        return;
    }

    // Check remaining credits before starting
    const creditCheck = await getRemainingCredits();
    if (!creditCheck.ok) {
        updateStatusMessage(`Could not verify credits: ${creditCheck.error}`, true);
        return;
    }

    const remainingBefore = creditCheck.remainingCredits;
    if (remainingBefore !== 'Unlimited' && Number(remainingBefore) <= 0) {
        updateStatusMessage("You have no remaining verification credits. Contact support to purchase more credits.", true);
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

    reader.onload = async function (e) {
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

            // Mid-run credit check to avoid starting a request we know will be rejected
            const midCredit = await getRemainingCredits();
            if (!midCredit.ok) {
                updateStatusMessage(`Could not verify credits mid-run: ${midCredit.error}`, true);
                break;
            }
            const nowRemaining = midCredit.remainingCredits;
            if (nowRemaining !== 'Unlimited' && Number(nowRemaining) <= 0) {
                updateStatusMessage("Processing stopped — credits exhausted. Contact support to purchase more credits.", true);
                break;
            }

            let verificationResult;
            if (!rawAddress || rawAddress.trim() === "") {
                verificationResult = { status: "Skipped", remarks: "Missing raw address in CSV row.", addressQuality: "Poor", customerCleanName: customerName, addressLine1: "", landmark: "", state: "", district: "", pin: "" };
            } else {
                try {
                    verificationResult = await fetchVerification(rawAddress, customerName);
                } catch (err) {
                    // authFetch likely threw session error — redirect to login
                    console.error('Session/auth error during verification:', err);
                    updateStatusMessage('Session expired. Redirecting to login...', true);
                    setTimeout(() => {
                        // clear local tokens and redirect to login page
                        try { localStorage.removeItem('clientToken'); } catch (e) {}
                        window.location.href = (typeof LOGIN_PAGE !== 'undefined' ? LOGIN_PAGE : 'client-login.html');
                    }, 1200);
                    return; // stop processing
                }
            }

            // If server indicates quota exhausted during the API call, stop and inform user
            if (verificationResult && verificationResult.status === 'QuotaExceeded') {
                updateStatusMessage(verificationResult.message || "Credits exhausted during processing. Processing stopped.", true);
                break;
            }

            // Build CSV output row
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

            // Update remaining credits UI (server truth)
            const afterCreditsResp = await getRemainingCredits();
            if (afterCreditsResp.ok) {
                const rc = afterCreditsResp.remainingCredits;
                const remEl = document.getElementById('remaining-credits');
                if (remEl) {
                    remEl.textContent = rc === 'Unlimited' ? 'Unlimited' : Number(rc).toLocaleString();
                }
            }
        }

        updateStatusMessage(`Processing finished. ${processedCount} of ${totalAddresses} addresses processed. Click 'Download Verified CSV'.`, false);
        createAndDownloadCSV(outputRows, "verified_addresses.csv");
        processButton.disabled = false;
        fileInput.disabled = false;
    };

    reader.onerror = function () {
        updateStatusMessage("Error reading file.", true);
        processButton.disabled = false;
        fileInput.disabled = false;
    };

    reader.readAsText(file);
}

// --- Init listeners (call from client-dashboard on load) ---
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
