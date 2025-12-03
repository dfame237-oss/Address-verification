// public/bulk_verification_logic.js
// Bulk verification logic refactored for Enterprise UX (Drag & Drop, Preview, Filtering)
// Updated fixes: ensure KPI persists across quick refreshes and fetches server data when needed.

const API_BULK_JOBS = '/api/bulk-jobs';

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
        const cleanedRow = row.map(cell => cell.trim().replace(/^\"|\"$/g, '').replace(/\"\"/g, '"'));
        if (cleanedRow.length > Math.max(idIndex, nameIndex, addressIndex)) {
            data.push({
                'ORDER ID': cleanedRow[idIndex] || '',
                'CUSTOMER NAME': cleanedRow[nameIndex] || '',
                'CUSTOMER RAW ADDRESS': cleanedRow[addressIndex] || '',
            });
        }
    }
    return { rows: data, header: header };
}

// --- Enterprise Improvement: CSV Preview Generator ---
function generatePreview(data) {
    const tableEl = document.getElementById('preview-table');
    const previewSection = document.getElementById('preview-section');

    if (!tableEl || !previewSection) return;

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
    const rowsToDisplay = data.rows.slice(0, 5);
    rowsToDisplay.forEach(row => {
        html += '<tr>';
        requiredHeaders.forEach(h => {
            const cellValue = (row[h] || '').toString();
            const cellContent = cellValue.length > 40 ? cellValue.substring(0, 37) + '...' : cellValue;
            html += `<td>${escapeHtml(cellContent)}</td>`;
        });
        html += '</tr>';
    });
    html += '</tbody>';
    tableEl.innerHTML = html;
    previewSection.classList.remove('hidden');
}

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- NEW: Check Active Job Count (Replaces function in HTML) ---
async function getActiveJobCount() {
    try {
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
    if (!fileInput || !processButton) {
        updateStatusMessage("UI not fully loaded.", true);
        return;
    }
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

            if (resp.status === 429) {
                alert("⚠️ A job is already in progress on the server. Please wait for completion.");
                updateStatusMessage(`Job submission blocked. Server busy.`, true);
            } else if (!resp.ok && resp.status !== 429) {
                updateStatusMessage(result.message || `Job submission failed (Status: ${resp.status}).`, true);
            } else if (result.status === 'Success' && result.jobId) {
                updateStatusMessage(`Verification job submitted (ID: ${result.jobId}). Processing started asynchronously.`);
                const inProgressBtn = document.getElementById('in-progress-tab-btn');
                if (inProgressBtn) showTab('in-progress-jobs', inProgressBtn);

                // Refresh credit UI after submission
                const afterCreditsResp = await getRemainingCredits();
                if (afterCreditsResp.ok) {
                    const rc = afterCreditsResp.remainingCredits;
                    const remEl = document.getElementById('plan-remaining-credits');
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
        console.error('Cancel job failed:', e);
        updateStatusMessage('Network or server error while cancelling the job.', true);
    }
}

// --- Persisted KPI Cache helpers ---
function setKpiCache(value) {
    const payload = { value, ts: Date.now() };
    try { localStorage.setItem('kpi_today_completed', JSON.stringify(payload)); } catch (e) {}
}
function getKpiCache() {
    try {
        const raw = localStorage.getItem('kpi_today_completed');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        // expire after 5 minutes
        if (Date.now() - (parsed.ts || 0) > 5 * 60 * 1000) {
            localStorage.removeItem('kpi_today_completed');
            return null;
        }
        return parsed.value;
    } catch (e) { return null; }
}

// --- KPI loader: computes today's completed rows. If globalJobsData is empty, fetches server-side job list. ---
async function loadKpiData() {
    const cached = getKpiCache();
    if (cached != null) {
        const el = document.getElementById('today-completed-kpi');
        if (el) el.textContent = Number(cached).toLocaleString();
        // still attempt to refresh in background
        fetchKpiAndRefresh();
        return;
    }
    await fetchKpiAndRefresh();
}

async function fetchKpiAndRefresh() {
    try {
        // If globalJobsData has been populated by a poller, prefer that
        let completedJobs = (window.globalJobsData && window.globalJobsData.completed) || [];

        // If not present, fetch from server
        if (!completedJobs || completedJobs.length === 0) {
            // call API_BULK_JOBS to get jobs list (same endpoint used by poller)
            const resp = await authFetch(API_BULK_JOBS, { method: 'GET' });
            if (resp.ok) {
                const result = await resp.json();
                if (result && result.status === 'Success' && Array.isArray(result.jobs)) {
                    completedJobs = result.jobs.filter(j => j.status === 'Completed' || j.status === 'Failed' || j.status === 'Cancelled');
                    // update globalJobsData so other UI re-renders benefit
                    window.globalJobsData = window.globalJobsData || {};
                    window.globalJobsData.completed = completedJobs;
                }
            }
        }

        // compute today's completed rows
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let completedToday = 0;
        (completedJobs || []).forEach(job => {
            const completedTime = job.completedTime || job.submittedAt;
            if (completedTime && job.status === 'Completed') {
                const completedDate = new Date(completedTime);
                if (completedDate >= today) {
                    completedToday += Number(job.totalRows || 0);
                }
            }
        });

        // persist to cache and update UI
        setKpiCache(completedToday);
        const el = document.getElementById('today-completed-kpi');
        if (el) el.textContent = completedToday.toLocaleString();
    } catch (e) {
        console.error('Failed to load KPI data:', e);
    }
}

// --- Drag & Drop + File selection handlers (existing) ---
function setupDragDropListeners() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('csvFileInput');
    const fileNameDisplay = document.getElementById('file-name-display');
    const processButton = document.getElementById('processButton');

    if (!dropZone || !fileInput) return;

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            dropZone.classList.add('dragover');
        }, false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            dropZone.classList.remove('dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length) {
            fileInput.files = files;
            handleFileSelection(files[0]);
        }
    }, false);

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
        const reader = new FileReader();
        reader.onload = function (e) {
            const text = e.target.result;
            const previewData = parseCSV(text);
            generatePreview(previewData);
        };
        reader.readAsText(file);
    }
}

// --- Init listeners (call from client-dashboard on load) ---
function initBulkListeners() {
    window.handleCancelJob = handleCancelJob;
    if (isPlanValid) {
        const downloadTemplateButton = document.getElementById('downloadTemplateButton');
        const csvFileInput = document.getElementById('csvFileInput');
        const processButton = document.getElementById('processButton');

        setupDragDropListeners();

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

// expose for html
window.initBulkListeners = initBulkListeners;
window.loadKpiData = loadKpiData;
window.handleBulkVerification = handleBulkVerification;
window.getActiveJobCount = getActiveJobCount;
