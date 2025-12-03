// public/bulk_verification_logic.js
// Bulk verification logic refactored for Enterprise UX (Drag & Drop, Preview, Filtering)

// NOTE: Assumes API_BULK_JOBS, authFetch, checkPlanValidity, showTab, API_CLIENT are global from client-dashboard.html

const API_BULK_JOBS = '/api/bulk-jobs'; //
// FIX: Removed redundant declaration of API_CLIENT (it is declared in client-dashboard.html)

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
        "1,\"John Doe\",\"H.No.\n" +
        "123, Sector 40B, near bus stand, Chandigarh\"\n" +
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

// --- CSV parsing (for local row counting and preview) ---
function parseCSV(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return { rows: [], header: [] };
    const header = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, ''));
    const data = [];
    const idIndex = header.indexOf('ORDER ID');
    const nameIndex = header.indexOf('CUSTOMER NAME');
    const addressIndex = header.indexOf('CUSTOMER RAW ADDRESS');
    if (idIndex === -1 || nameIndex === -1 || addressIndex === -1) {
        return { rows: [], header: [] };
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
    return { rows: data, header: header };
}

// --- Enterprise Improvement: CSV Preview Generator ---
function generatePreview(data) {
    const tableEl = document.getElementById('preview-table');
    const previewSection = document.getElementById('preview-section');

    if (data.rows.length === 0) {
        previewSection.classList.add('hidden');
        return;
    }

    // Create Header Row
    let html = '<thead><tr>';
    const requiredHeaders = ['ORDER ID', 'CUSTOMER NAME', 'CUSTOMER RAW ADDRESS'];
    requiredHeaders.forEach(h => {
        html += `<th>${h}</th>`;
    });
    html += '</tr></thead><tbody>';
    // Add up to 5 rows for preview
    const rowsToDisplay = data.rows.slice(0, 5);
    rowsToDisplay.forEach(row => {
        html += '<tr>';
        requiredHeaders.forEach(h => {
            // Truncate long addresses for the preview display
            const cellContent = row[h].length > 40 ? row[h].substring(0, 37) + '...' : row[h];
            html += `<td>${cellContent}</td>`;
        });
        html += '</tr>';

    });

    html += '</tbody>';
    tableEl.innerHTML = html;
    previewSection.classList.remove('hidden');
}

// --- NEW: Check Active Job Count (Replaces function in HTML) ---
async function getActiveJobCount() {
    try {
        // Use the globally declared API_CLIENT
        const resp = await authFetch(`${API_CLIENT}?action=active-jobs`, { method: 'GET' });
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
    // Note: checkPlanValidity, isPlanValid, authFetch, showTab, getRemainingCredits are assumed global
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
        const { rows: addresses } = parseCSV(text);

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
                    if (remEl) remEl.textContent = rc === 'Unlimited' ?
                        'Unlimited' : Number(rc).toLocaleString();
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
    // Note: authFetch is assumed global
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

// --- Enterprise Improvement: Drag & Drop Handlers ---
function setupDragDropListeners() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('csvFileInput');
    const fileNameDisplay = document.getElementById('file-name-display');
    const processButton = document.getElementById('processButton');
    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // Highlight drop zone when item is dragged over it
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });
    // Handle dropped files
    dropZone.addEventListener('drop', handleDrop, false);
    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length) {
            fileInput.files = files;
            // Assign files to the hidden input
            handleFileSelection(files[0]);
        }
    }
    
    // Handle file selection via click/drag
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFileSelection(e.target.files[0]);
        } else {
            fileNameDisplay.textContent = 'No file chosen';
            processButton.disabled = true;
            document.getElementById('preview-section').classList.add('hidden');
  
        }
    });
    function handleFileSelection(file) {
        fileNameDisplay.textContent = file.name;
        processButton.disabled = false;
        // Read file content for preview
        const reader = new FileReader();
        reader.onload = function(e) {
            const text = e.target.result;
            const previewData = parseCSV(text);
            generatePreview(previewData);
        };
        reader.readAsText(file);
    }
}


// --- Init listeners (call from client-dashboard on load) ---
function initBulkListeners() {
    // Export core functions needed by client-dashboard.html
    window.handleCancelJob = handleCancelJob;
    
    // Call initial KPI fetch right away for a non-stale number
    if (typeof fetchTodayCompletedKpi === 'function') {
        fetchTodayCompletedKpi();
    }
    
    if (isPlanValid) {
        const downloadTemplateButton = document.getElementById('downloadTemplateButton');
        const csvFileInput = document.getElementById('csvFileInput');
        const processButton = document.getElementById('processButton');

        // Setup Drag & Drop and manual file change listeners (NEW)
        setupDragDropListeners();
        // Setup Search/Filtering listeners (NEW)
        document.getElementById('in-progress-search')?.addEventListener('input', window.filterJobsList);
        document.getElementById('completed-search')?.addEventListener('input', window.filterJobsList);
        if (downloadTemplateButton) {
            downloadTemplateButton.addEventListener('click', handleTemplateDownload);
        }

        if (processButton) {
            processButton.addEventListener('click', handleBulkVerification);
        }
    }
}

// --- FIX 1: Fetch and display TODAY'S COMPLETED VERIFICATIONS (NEW FUNCTION) ---
// This function addresses the issue of the KPI data disappearing on page refresh.
async function fetchTodayCompletedKpi() {
    const kpiEl = document.getElementById('today-completed-kpi');
    if (!kpiEl) return;
    
    // If global data exists from a recent poll, use it (and call loadKpiData in client-dashboard.js)
    if (window.globalJobsData && window.globalJobsData.completed && typeof window.loadKpiData === 'function') {
        window.loadKpiData();
        return;
    }

    try {
        // Fallback or initial load: fetch full job list and calculate locally.
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

    // Remove old placeholder message if it exists
    const oldPlaceholder = container.querySelector('.bg-yellow-50');
    if (oldPlaceholder) oldPlaceholder.remove();

    container.innerHTML = '<p class="text-center text-gray-500 mt-5">Loading history...</p>';

    try {
        // Use the globally declared API_CLIENT
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
            // Use the globally available formatISTTime function
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
window.fetchTodayCompletedKpi = fetchTodayCompletedKpi;
window.fetchDeductionHistory = fetchDeductionHistory;