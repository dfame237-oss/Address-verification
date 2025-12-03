// public/bulk_verification_logic.js
// Bulk verification logic refactored for Enterprise UX (Drag & Drop, Preview, Filtering)

// NOTE: Assumes API_BULK_JOBS, authFetch, checkPlanValidity, showTab, API_CLIENT are global from client-dashboard.html

const API_BULK_JOBS = '/api/bulk-jobs'; [cite_start]// [cite: 1]
const API_CLIENT = '/api/client/index'; // Assumed global but safer to define here for new call

[cite_start]// --- UI helpers (existing) --- [cite: 2]
function updateStatusMessage(message, isError = false) {
    const statusMessage = document.getElementById('status-message');
    if (!statusMessage) return; [cite_start]// [cite: 3]

    statusMessage.textContent = message; [cite_start]// [cite: 3]

    statusMessage.classList.remove('text-red-700', 'bg-red-100', 'text-gray-600', 'bg-tf-light', 'font-bold');
    statusMessage.classList.add('p-2', 'rounded'); [cite_start]// [cite: 3]
    [cite_start]if (isError) { // [cite: 4]
        statusMessage.classList.add('text-red-700', 'bg-red-100', 'font-bold');
        statusMessage.classList.remove('text-gray-600', 'bg-tf-light'); [cite_start]// [cite: 4]
    [cite_start]} else { // [cite: 5]
        statusMessage.classList.add('text-gray-600', 'bg-tf-light');
        statusMessage.classList.remove('bg-red-100', 'font-bold'); [cite_start]// [cite: 5]
    }
}

// --- Template download (unchanged) ---
function handleTemplateDownload() {
    const templateHeaders = "ORDER ID,CUSTOMER NAME,CUSTOMER RAW ADDRESS\n"; [cite_start]// [cite: 6]
// CRITICAL FIX: Ensure multiline string is correctly concatenated
    const templateData =
        [cite_start]"1,\"John Doe\",\"H.No.\n" + // [cite: 7]
        [cite_start]"123, Sector 40B, near bus stand, Chandigarh\"\n" + // [cite: 8]
        "2,\"Jane Smith\",\"5th Floor, Alpha Tower, Mumbai 400001\"\n"; [cite_start]// [cite: 8]
    const csvContent = templateHeaders + templateData; [cite_start]// [cite: 9]

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); [cite_start]// [cite: 10]
    link.setAttribute('download', 'address_verification_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- CSV parsing (for local row counting and preview) ---
function parseCSV(text) {
    const lines = text.split('\n'); [cite_start]// [cite: 10]
    if (lines.length < 2) return { rows: [], header: [] }; [cite_start]// [cite: 11]
// Enterprise Improvement: Use proper CSV parsing logic (simplified here)
    const header = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, '')); [cite_start]// [cite: 12]
    const data = []; [cite_start]// [cite: 13]
    const idIndex = header.indexOf('ORDER ID');
    const nameIndex = header.indexOf('CUSTOMER NAME');
    const addressIndex = header.indexOf('CUSTOMER RAW ADDRESS'); [cite_start]// [cite: 13]
    [cite_start]if (idIndex === -1 || nameIndex === -1 || addressIndex === -1) { // [cite: 14]
        return { rows: [], header: [] }; [cite_start]// [cite: 15]
    }

    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue; [cite_start]// [cite: 15]
        [cite_start]const row = lines[i].match(/(".*?"|[^",\r\n]+)(?=\s*,|\s*$)/g) || []; // [cite: 16]

        [cite_start]const cleanedRow = row.map(cell => cell.trim().replace(/^\"|\"$/g, '').replace(/\"\"/g, '\"')); // [cite: 16]
        [cite_start]if (cleanedRow.length > Math.max(idIndex, nameIndex, addressIndex)) { // [cite: 17]
            data.push({
                'ORDER ID': cleanedRow[idIndex],
                'CUSTOMER NAME': cleanedRow[nameIndex],
                'CUSTOMER RAW ADDRESS': cleanedRow[addressIndex],
            }); [cite_start]// [cite: 17]
        }
    }
    return { rows: data, header: header }; [cite_start]// [cite: 18]
}

// --- Enterprise Improvement: CSV Preview Generator ---
function generatePreview(data) {
    const tableEl = document.getElementById('preview-table'); [cite_start]// [cite: 19]
    const previewSection = document.getElementById('preview-section'); [cite_start]// [cite: 20]

    if (data.rows.length === 0) {
        previewSection.classList.add('hidden');
        return; [cite_start]// [cite: 21]
    }

    // Create Header Row
    let html = '<thead><tr>'; [cite_start]// [cite: 21]
// Use only the required headers for clarity
    const requiredHeaders = ['ORDER ID', 'CUSTOMER NAME', 'CUSTOMER RAW ADDRESS']; [cite_start]// [cite: 22]
    [cite_start]requiredHeaders.forEach(h => { // [cite: 23]
        html += `<th>${h}</th>`;
    });
    html += '</tr></thead><tbody>'; [cite_start]// [cite: 23]
// Add up to 5 rows for preview
    const rowsToDisplay = data.rows.slice(0, 5); [cite_start]// [cite: 24]
    [cite_start]rowsToDisplay.forEach(row => { // [cite: 25]
        html += '<tr>';
        requiredHeaders.forEach(h => {
            // Truncate long addresses for the preview display
            [cite_start]const cellContent = row[h].length > 40 ? row[h].substring(0, 37) + '...' : row[h]; // [cite: 25]
            html += `<td>${cellContent}</td>`;
        });
        html += '</tr>';

    }); [cite_start]// [cite: 26]

    html += '</tbody>';
    tableEl.innerHTML = html;
    previewSection.classList.remove('hidden');
}

// --- NEW: Check Active Job Count (Replaces function in HTML) ---
async function getActiveJobCount() {
    try {
        const resp = await authFetch('/api/client/index?action=active-jobs', { method: 'GET' }); [cite_start]// [cite: 26]
        const json = await resp.json(); [cite_start]// [cite: 27]
        if (json.status === 'Success' && typeof json.activeJobsCount === 'number') {
            return json.activeJobsCount; [cite_start]// [cite: 28]
        }
        return 0; [cite_start]// [cite: 29]
    } catch (e) {
        console.error('Failed to get active job count:', e); [cite_start]// [cite: 30]
        return 0; [cite_start]// [cite: 30]
    }
}

// --- Main bulk handler (refactored for job submission) ---
async function handleBulkVerification() {
    // Note: checkPlanValidity, isPlanValid, authFetch, showTab, getRemainingCredits are assumed global
    if (!checkPlanValidity() || !isPlanValid) {
        updateStatusMessage("Access denied. Plan is expired or disabled.", true); [cite_start]// [cite: 31]
        return; [cite_start]// [cite: 31]
    }

    const fileInput = document.getElementById('csvFileInput');
    const processButton = document.getElementById('processButton'); [cite_start]// [cite: 32]
    if (!fileInput.files.length) {
        updateStatusMessage("Please select a CSV file first.", true);
        return; [cite_start]// [cite: 33]
    }

    // Requirement 3 Check: Max 1 active job
    const activeJobs = await getActiveJobCount(); [cite_start]// [cite: 33]
    [cite_start]if (activeJobs >= 1) { // [cite: 34]
        alert("⚠️ A job is already in progress. Please wait for completion before submitting a new file.");
        updateStatusMessage("Job submission blocked. One job is already running.", true); [cite_start]// [cite: 35]
        return;
    }

    const file = fileInput.files[0]; [cite_start]// [cite: 35]
    const reader = new FileReader(); [cite_start]// [cite: 36]

    processButton.disabled = true;
    fileInput.disabled = true;
    updateStatusMessage('Reading file and performing credit check...'); [cite_start]// [cite: 37]
    reader.onload = async function (e) {
        const text = e.target.result; [cite_start]// [cite: 37, 38]
        const { rows: addresses } = parseCSV(text); [cite_start]// [cite: 38]

        if (addresses.length === 0) {
            updateStatusMessage("Error: No valid addresses found in CSV. Check format and required columns.", true); [cite_start]// [cite: 39]
            processButton.disabled = false; [cite_start]// [cite: 39]
            fileInput.disabled = false; [cite_start]// [cite: 39]
            return;
        }

        const totalRows = addresses.length; [cite_start]// [cite: 40]
// --- NEW: POST JOB TO SERVER ---
        try {
            updateStatusMessage(`Submitting job for ${totalRows} addresses...`); [cite_start]// [cite: 41]
            [cite_start]const resp = await authFetch(API_BULK_JOBS, { // [cite: 41]
                method: 'POST',
                body: JSON.stringify({
                    filename: file.name,
                    csvData: text,

                    [cite_start]totalRows: totalRows // [cite: 42]
                })
            });
            const result = await resp.json(); [cite_start]// [cite: 43]

            [cite_start]if (resp.status === 429) { // Server rejected due to max jobs (now 1) [cite: 43]
                alert("⚠️ A job is already in progress on the server. Please wait for completion."); [cite_start]// [cite: 44]
                updateStatusMessage(`Job submission blocked. Server busy.`, true); [cite_start]// [cite: 44]
            } else if (!resp.ok && resp.status !== 429) { // General HTTP/Credit Error
                updateStatusMessage(result.message || `Job submission failed (Status: ${resp.status}).`, true); [cite_start]// [cite: 45]
            [cite_start]} else if (result.status === 'Success' && result.jobId) { // [cite: 45]
                updateStatusMessage(`Verification job submitted (ID: ${result.jobId}). Processing started asynchronously.`); [cite_start]// [cite: 46]
// Requirement 2: Switch to 'In Progress' tab
                const inProgressBtn = document.getElementById('in-progress-tab-btn'); [cite_start]// [cite: 46]
                if (inProgressBtn) showTab('in-progress-jobs', inProgressBtn); [cite_start]// [cite: 47]

                // Refresh credit UI after submission
                const afterCreditsResp = await getRemainingCredits(); [cite_start]// [cite: 47]
                [cite_start]if (afterCreditsResp.ok) { // [cite: 48]
                    const rc = afterCreditsResp.remainingCredits; [cite_start]// [cite: 49]
                    const remEl = document.getElementById('plan-remaining-credits'); [cite_start]// Update plan card [cite: 49]
                    if (remEl) remEl.textContent = rc === 'Unlimited' ? [cite_start]// [cite: 50]
                        'Unlimited' : Number(rc).toLocaleString(); [cite_start]// [cite: 50]
                }

            } else {
                updateStatusMessage(result.message || 'Job submission failed due to unknown server response.', true); [cite_start]// [cite: 51]
            }
        } catch (error) {
            updateStatusMessage(`Network error during job submission: ${error.message}`, true); [cite_start]// [cite: 52]
        } finally {
            processButton.disabled = false;
            fileInput.disabled = false; [cite_start]// [cite: 53]
        }
    };

    reader.onerror = function () {
        updateStatusMessage("Error reading file.", true); [cite_start]// [cite: 54]
        processButton.disabled = false; [cite_start]// [cite: 54]
        fileInput.disabled = false; [cite_start]// [cite: 54]
    };

    reader.readAsText(file);
}

// --- NEW: Handle Job Cancellation (Requirement 4) ---
async function handleCancelJob(jobId) {
    if (!confirm(`Are you sure you want to cancel Job ID: ${jobId}?`)) return; [cite_start]// [cite: 55]
// Note: authFetch is assumed global
    try {
        [cite_start]const resp = await authFetch(API_BULK_JOBS + '?action=cancel', { // [cite: 55]
            method: 'PUT',
            body: JSON.stringify({ jobId })
        });
        const result = await resp.json(); [cite_start]// [cite: 56]

        if (result.status === 'Success') {
            updateStatusMessage(`Cancellation request sent for Job ${jobId}. Status will update shortly.`, false); [cite_start]// [cite: 57]
        } else {
            updateStatusMessage(`Failed to cancel Job ${jobId}: ${result.message}`, true); [cite_start]// [cite: 58]
        }
    } catch (e) {
        updateStatusMessage(`Network error during cancellation: ${e.message}`, true); [cite_start]// [cite: 59]
    }
}

// --- Enterprise Improvement: Drag & Drop Handlers ---
function setupDragDropListeners() {
    const dropZone = document.getElementById('drop-zone'); [cite_start]// [cite: 59]
    const fileInput = document.getElementById('csvFileInput'); [cite_start]// [cite: 60]
    const fileNameDisplay = document.getElementById('file-name-display');
    const processButton = document.getElementById('processButton'); [cite_start]// [cite: 60]
// Prevent default drag behaviors
    [cite_start]['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => { // [cite: 61]
        dropZone.addEventListener(eventName, preventDefaults, false);
    }); [cite_start]// [cite: 61]
    [cite_start]function preventDefaults(e) { // [cite: 62]
        e.preventDefault();
        e.stopPropagation(); [cite_start]// [cite: 63]
    }

    // Highlight drop zone when item is dragged over it
    [cite_start]['dragenter', 'dragover'].forEach(eventName => { // [cite: 63]
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });
    [cite_start]['dragleave', 'drop'].forEach(eventName => { // [cite: 64]
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });
// Handle dropped files
    dropZone.addEventListener('drop', handleDrop, false); [cite_start]// [cite: 65]
    [cite_start]function handleDrop(e) { // [cite: 66]
        const dt = e.dataTransfer;
        const files = dt.files; [cite_start]// [cite: 67]
        if (files.length) {
            fileInput.files = files; [cite_start]// [cite: 67]
// Assign files to the hidden input
            handleFileSelection(files[0]); [cite_start]// [cite: 68]
        }
    }

    // Handle file selection via click/drag
    [cite_start]fileInput.addEventListener('change', (e) => { // [cite: 69]
        if (e.target.files.length) {
            handleFileSelection(e.target.files[0]);
        } else {
            fileNameDisplay.textContent = 'No file chosen';
            processButton.disabled = true;
            document.getElementById('preview-section').classList.add('hidden');

        }
    }); [cite_start]// [cite: 70, 71]
    [cite_start]function handleFileSelection(file) { // [cite: 71]
        fileNameDisplay.textContent = file.name;
        processButton.disabled = false; [cite_start]// [cite: 72]
// Read file content for preview
        const reader = new FileReader(); [cite_start]// [cite: 72]
        [cite_start]reader.onload = function(e) { // [cite: 73]
            const text = e.target.result; [cite_start]// [cite: 74]
            const previewData = parseCSV(text);
            generatePreview(previewData);
        };
        reader.readAsText(file); [cite_start]// [cite: 74]
    }
}


// --- Init listeners (call from client-dashboard on load) ---
function initBulkListeners() {
    // Export core functions needed by client-dashboard.html
    window.handleCancelJob = handleCancelJob; [cite_start]// [cite: 75]
    
    [cite_start]if (isPlanValid) { // [cite: 75]
        const downloadTemplateButton = document.getElementById('downloadTemplateButton');
        const csvFileInput = document.getElementById('csvFileInput'); [cite_start]// [cite: 76]
        const processButton = document.getElementById('processButton'); [cite_start]// [cite: 76]

        // Setup Drag & Drop and manual file change listeners (NEW)
        setupDragDropListeners(); [cite_start]// [cite: 77]
// Setup Search/Filtering listeners (NEW)
        document.getElementById('in-progress-search')?.addEventListener('input', window.filterJobsList);
        document.getElementById('completed-search')?.addEventListener('input', window.filterJobsList); [cite_start]// [cite: 78]
        if (downloadTemplateButton) {
            downloadTemplateButton.addEventListener('click', handleTemplateDownload); [cite_start]// [cite: 79]
        }

        if (processButton) {
            processButton.addEventListener('click', handleBulkVerification); [cite_start]// [cite: 80]
        }
    }
}

// --- FIX 1: Fetch and display TODAY'S COMPLETED VERIFICATIONS (NEW FUNCTION) ---
// This separates KPI loading from the main job status polling for better data integrity on initial load.
async function fetchTodayCompletedKpi() {
    const kpiEl = document.getElementById('today-completed-kpi');
    if (!kpiEl) return;
    
    // Check if data is already available from the last poll (to avoid another API call immediately)
    if (window.globalJobsData && window.globalJobsData.completed) {
        // Use the function already defined in client-dashboard.js
        if (typeof window.loadKpiData === 'function') {
            window.loadKpiData();
            return;
        }
    }

    try {
        // New endpoint to quickly get today's completed count (assumed to be a new API endpoint)
        // Since we don't have a new endpoint, we use the bulk job list and calculate locally.
        const resp = await authFetch(API_BULK_JOBS, { method: 'GET' });
        const result = await resp.json();

        if (result.status === 'Success') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            let completedToday = 0;

            result.jobs.forEach(job => {
                const completedTime = job.completedTime;
                if (job.status === 'Completed' && completedTime) {
                    const completedDate = new Date(completedTime);
                    if (completedDate >= today) {
                        // totalRows for a completed job is the effective deduction/usage
                        completedToday += job.totalRows; 
                    }
                }
            });
            kpiEl.textContent = completedToday.toLocaleString();
        } else {
            console.error('Failed to fetch KPI data:', result.message);
        }

    } catch (e) {
        console.error('KPI fetch error:', e);
        kpiEl.textContent = 'N/A';
    }
}

// --- FIX 2: Fetch and display DEDUCTION HISTORY (NEW FUNCTION) ---
async function fetchDeductionHistory() {
    const container = document.getElementById('deduction-history-list');
    if (!container) return;

    container.innerHTML = '<p class="text-center text-gray-500 mt-5">Loading history...</p>';

    try {
        // Call the new API endpoint
        const resp = await authFetch(`${API_CLIENT}?action=deduction-history`, { method: 'GET' });
        const result = await resp.json();

        if (result.status !== 'Success' || !result.history) {
            container.innerHTML = `<p class="text-center text-red-500 mt-5">Failed to load history: ${result.message || 'Unknown error.'}</p>`;
            return;
        }

        if (result.history.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-500 mt-5">No completed verification jobs found.</p>';
            return;
        }

        // Build the table header outside the loop
        let html = `
            <div class="overflow-x-auto bg-white rounded-lg shadow">
                <table class="min-w-full divide-y divide-gray-200">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Job ID</th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Filename</th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rows (Usage)</th>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Completion Time</th>
                        </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200">
        `;

        result.history.forEach(job => {
            const statusClass = job.status === 'Completed' ? 'text-green-600' : 'text-red-600';
            const statusText = job.status === 'Completed' ? 'Deducted' : job.status;
            // Assumes totalRows in a Completed job is the final deduction amount (successfulVerifications)
            const usageText = job.status === 'Completed' ? job.totalRows.toLocaleString() : '—'; 
            const completionTime = window.formatISTTime(job.completedTime || job.submittedAt);
            
            html += `
                <tr>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${job._id.substring(0, 8)}...</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${job.filename}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-semibold ${statusClass}">${statusText}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-tf-secondary">${usageText}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${completionTime}</td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;
        container.innerHTML = html;

    } catch (e) {
        console.error('Deduction history fetch error:', e);
        container.innerHTML = `<p class="text-center text-red-500 mt-5">Network error during history fetch.</p>`;
    }
}

// Export the new functions to be called by client-dashboard.html
window.initBulkListeners = initBulkListeners;
window.handleCancelJob = handleCancelJob;
window.fetchTodayCompletedKpi = fetchTodayCompletedKpi; // FIX 1
window.fetchDeductionHistory = fetchDeductionHistory; // FIX 2