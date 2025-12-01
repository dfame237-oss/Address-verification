// public/bulk_verification_logic.js
// Bulk verification logic refactored to handle ASYNCHRONOUS JOB SUBMISSION and client-side helpers.

const API_BULK_JOBS = '/api/bulk-jobs'; // New constant for the bulk job endpoint

// --- UI helpers (existing) ---
function updateStatusMessage(message, isError = false) {
    const statusMessage = document.getElementById('status-message');
    if (!statusMessage) return;

    statusMessage.textContent = message;

    statusMessage.classList.remove('text-red-700', 'bg-red-100', 'text-gray-600', 'bg-tf-light', 'font-bold');
    statusMessage.classList.add('p-2', 'rounded');
    if (isError) {
        statusMessage.classList.add('text-red-700', 'bg-red-100', 'font-bold');
        statusMessage.classList.remove('text-gray-600', 'bg-tf-light');
    } else {
        statusMessage.classList.add('text-gray-600', 'bg-tf-light');
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

// --- CSV parsing (for local row counting) ---
function parseCSV(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return [];

    const header = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, ''));
    const data = [];
    const idIndex = header.indexOf('ORDER ID');
    const nameIndex = header.indexOf('CUSTOMER NAME');
    const addressIndex = header.indexOf('CUSTOMER RAW ADDRESS');

    if (idIndex === -1 || nameIndex === -1 || addressIndex === -1) {
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

// --- Credit helper: GET remaining credits ---
async function getRemainingCredits() {
    let responseText = null;
    try {
        const resp = await authFetch('/api/verify-single-address', { method: 'GET' });
        responseText = await resp.text();
        let json;
        try {
            json = JSON.parse(responseText);
        } catch (e) {
            console.error('getRemainingCredits JSON Parse Error:', responseText, e);
            return { ok: false, error: `Invalid JSON. Server responded with: "${responseText.substring(0, 50)}..."` };
        }

        if (!resp.ok || json.status === 'Error') {
            return { ok: false, error: json.message || `Server error (Status ${resp.status})` };
        }

        return { ok: true, remainingCredits: json.remainingCredits, initialCredits: json.initialCredits, planName: json.planName };
    } catch (e) {
        console.error('getRemainingCredits network/authFetch error:', e);
        return { ok: false, error: e.message || `Network error. Raw text: ${responseText ? responseText.substring(0, 50) : 'N/A'}` };
    }
}

// --- NEW: Check Active Job Count (Requirement 3) ---
async function getActiveJobCount() {
    try {
        // Calls the new /api/client/index?action=active-jobs endpoint
        const resp = await authFetch('/api/client/index?action=active-jobs', { method: 'GET' });
        const json = await resp.json();
        if (json.status === 'Success' && typeof json.activeJobsCount === 'number') {
            return json.activeJobsCount;
        }
        return 0;
    } catch (e) {
        console.error('Failed to get active job count:', e);
        return 0;
    }
}

// --- Main bulk handler (refactored for job submission) ---
async function handleBulkVerification() {
    if (!checkPlanValidity() || !isPlanValid) {
        updateStatusMessage("Access denied. Plan is expired or disabled.", true);
        return;
    }

    const fileInput = document.getElementById('csvFileInput');
    const processButton = document.getElementById('processButton');

    if (!fileInput.files.length) {
        updateStatusMessage("Please select a CSV file first.", true);
        return;
    }

    // Requirement 3 Check: Max 1 active job
    const activeJobs = await getActiveJobCount();
    if (activeJobs >= 1) { 
        // FIX: Using alert() for clear, immediate pop-up message as requested
        alert("⚠️ A job is already in progress. Please wait for completion before submitting a new file.");
        updateStatusMessage("Job submission blocked. One job is already running.", true);
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    processButton.disabled = true;
    fileInput.disabled = true;
    updateStatusMessage('Reading file and performing credit check...');

    reader.onload = async function (e) {
        const text = e.target.result;
        const addresses = parseCSV(text);

        if (addresses.length === 0) {
            updateStatusMessage("Error: No valid addresses found in CSV. Check format and required columns.", true);
            processButton.disabled = false;
            fileInput.disabled = false;
            return;
        }

        const totalRows = addresses.length;
        
        // --- NEW: POST JOB TO SERVER ---
        try {
            updateStatusMessage(`Submitting job for ${totalRows} addresses...`);
            const resp = await authFetch(API_BULK_JOBS, {
                method: 'POST',
                body: JSON.stringify({ 
                    filename: file.name,
                    csvData: text,
                    totalRows: totalRows
                })
            });
            const result = await resp.json();

            if (resp.status === 429) { // Server rejected due to max jobs (now 1)
                // FIX: Using alert() for server-side concurrency block
                alert("⚠️ A job is already in progress on the server. Please wait for completion.");
                updateStatusMessage(`Job submission blocked. Server busy.`, true);
            } else if (!resp.ok && resp.status !== 429) { // General HTTP/Credit Error
                updateStatusMessage(result.message || `Job submission failed (Status: ${resp.status}).`, true);
            } else if (result.status === 'Success' && result.jobId) {
                updateStatusMessage(`Verification job submitted (ID: ${result.jobId}). Processing started asynchronously.`);
                
                // Requirement 2: Switch to 'In Progress' tab
                const inProgressBtn = document.getElementById('in-progress-tab-btn');
                if (inProgressBtn) showTab('in-progress-jobs', inProgressBtn); 
                
                // Refresh credit UI after submission
                const afterCreditsResp = await getRemainingCredits();
                if (afterCreditsResp.ok) {
                    const rc = afterCreditsResp.remainingCredits;
                    const remEl = document.getElementById('plan-remaining-credits'); // Update plan card
                    if (remEl) remEl.textContent = rc === 'Unlimited' ? 'Unlimited' : Number(rc).toLocaleString();
                }

            } else {
                updateStatusMessage(result.message || 'Job submission failed due to unknown server response.', true);
            }
        } catch (error) {
            updateStatusMessage(`Network error during job submission: ${error.message}`, true);
        } finally {
            processButton.disabled = false;
            fileInput.disabled = false;
        }
    };

    reader.onerror = function () {
        updateStatusMessage("Error reading file.", true);
        processButton.disabled = false;
        fileInput.disabled = false;
    };

    reader.readAsText(file);
}

// --- NEW: Handle Job Cancellation (Requirement 4) ---
async function handleCancelJob(jobId) {
    if (!confirm(`Are you sure you want to cancel Job ID: ${jobId}?`)) return;

    try {
        const resp = await authFetch(API_BULK_JOBS + '?action=cancel', {
            method: 'PUT',
            body: JSON.stringify({ jobId })
        });
        const result = await resp.json();

        if (result.status === 'Success') {
            updateStatusMessage(`Cancellation request sent for Job ${jobId}. Status will update shortly.`, false);
        } else {
            updateStatusMessage(`Failed to cancel Job ${jobId}: ${result.message}`, true);
        }
    } catch (e) {
        updateStatusMessage(`Network error during cancellation: ${e.message}`, true);
    }
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
        
        // Expose function globally for the polling logic in client-dashboard.html
        window.handleCancelJob = handleCancelJob;
    }
}