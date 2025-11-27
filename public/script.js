// public/script.js

// 🚨 FIX: Use the new, unauthenticated API endpoint
const API_ENDPOINT = "/api/public-single-address"; 
// Note: We are using '/api/public-single-address' now, instead of the authenticated one.

document.addEventListener('DOMContentLoaded', () => {
    const verifyButton = document.getElementById('verifyButton');
    if (verifyButton) {
        verifyButton.addEventListener('click', handleSingleVerification);
    }
    
    // Note: If this page is your homepage, ensure bulk buttons are hidden or point to client-dashboard.
    // The bulk logic below is simple, non-authenticated logic meant for a basic demo.
    const downloadTemplateButton = document.getElementById('downloadTemplateButton');
    const csvFileInput = document.getElementById('csvFileInput');
    const processButton = document.getElementById('processButton');

    if (downloadTemplateButton) {
        downloadTemplateButton.addEventListener('click', handleTemplateDownload);
        if (csvFileInput) csvFileInput.disabled = false;
    }

    if (csvFileInput) {
        csvFileInput.addEventListener('change', () => {
            if (processButton) {
                processButton.disabled = !csvFileInput.files.length;
            }
        });
    }

    if (processButton) {
        // If this button is on the public page, you should redirect the user to login first.
        processButton.addEventListener('click', () => {
            alert("Bulk verification requires a client login. Redirecting...");
            window.location.href = 'client-login.html'; // Adjust this path if needed
        });
    }
});

async function handleSingleVerification() {
    const rawAddress = document.getElementById('rawAddress').value;
    const customerName = document.getElementById('customerName').value;
    const loadingMessage = document.getElementById('loading-message');
    const resultsContainer = document.getElementById('resultsContainer');

    if (rawAddress.trim() === "") {
        alert("Please enter a raw address to verify.");
        return;
    }

    document.getElementById('verifyButton').disabled = true;
    loadingMessage.style.display = 'block';
    resultsContainer.style.display = 'none';

    try {
        // This fetch is now unauthenticated, relying on the new public endpoint
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                address: rawAddress,
                customerName: customerName
            })
        });

        let result;
        try {
            result = await response.json();
        } catch (e) {
            console.error("Non-JSON API response. Status:", response.status);
            alert(`Verification Failed: Received a server error (${response.status}).`);
            return;
        }

        if (response.ok && result.status === "Success") {
            displayResults(result);
        } else {
            alert(`Verification Failed: ${result.error || result.remarks || "Unknown error."}`);
            displayErrorResult(result);
        }

    } catch (e) {
        console.error("Fetch Error:", e);
        alert("A network error occurred. Check the console for details.");
    } finally {
        document.getElementById('verifyButton').disabled = false;
        loadingMessage.style.display = 'none';
        resultsContainer.style.display = 'block';
    }
}

function displayResults(data) {
    document.getElementById('out-name').textContent = data.customerCleanName || 'N/A';
    document.getElementById('out-address').textContent = data.addressLine1 || 'N/A';
    document.getElementById('out-landmark').textContent = data.landmark || 'N/A';
    document.getElementById('out-state').textContent = data.state || 'N/A';
    document.getElementById('out-district').textContent = data.district || 'N/A';
    document.getElementById('out-pin').textContent = data.pin || 'N/A';
    document.getElementById('out-remarks').textContent = data.remarks || 'No issues found.';
    document.getElementById('out-quality').textContent = data.addressQuality || 'N/A';
}

function displayErrorResult(data) {
    document.getElementById('out-name').textContent = data.customerCleanName || '---';
    document.getElementById('out-address').textContent = data.addressLine1 || 'API ERROR';
    document.getElementById('out-landmark').textContent = '---';
    document.getElementById('out-state').textContent = data.state || '---';
    document.getElementById('out-district').textContent = data.district || '---';
    document.getElementById('out-pin').textContent = data.pin || '---';
    document.getElementById('out-remarks').textContent = data.remarks || data.error || 'Verification failed.';
    document.getElementById('out-quality').textContent = 'BAD';
}

function handleTemplateDownload() {
    const templateData = "ORDER ID,CUSTOMER NAME,CUSTOMER RAW ADDRESS\n";
    const blob = new Blob([templateData], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    link.setAttribute('href', url);
    link.setAttribute('download', 'address_template.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// NOTE: This fetchVerification function is likely unused on the public page, 
// but is kept here for completeness if you use a simplified bulk form. 
// If your bulk button redirects to login, this is irrelevant.
async function fetchVerification(address, name) {
    // This function should ideally point to the AUTHENTICATED endpoint if used, 
    // but here we keep it simple for a public page context.
    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: address, customerName: name })
        });
        
        let result = {};
        try {
            result = await response.json();
        } catch (e) {
            console.error("Non-JSON API response in bulk. Status:", response.status);
            return {
                status: "Error",
                customerCleanName: name,
                addressLine1: "Server Error",
                remarks: `API Failed: Server returned non-JSON error (${response.status}).`,
                addressQuality: "VERY BAD"
            };
        }

        // Logic here needs to be re-assessed based on whether public bulk is allowed.
        // Given your intent, this public file should NOT handle bulk.
        // We will assume the bulk button redirects users to the authenticated dashboard.
        
        return result; 
        
    } catch (e) {
        console.error("Bulk Fetch Error:", e);
        return {
            status: "Error",
            customerCleanName: name,
            addressLine1: "Network/Timeout Error",
            landmark: "",
            state: "",
            district: "",
            pin: "",
            remarks: "Network or timeout error during API call. (Check CORS/Vercel)",
            addressQuality: "VERY BAD"
        };
    }
}

// Simplified bulk handler for public page (redirects to login)
async function handleBulkVerification() {
    const fileInput = document.getElementById('csvFileInput');
    if (fileInput.files.length) {
        alert("Bulk verification requires client login. Redirecting...");
        window.location.href = 'client-login.html';
    } else {
        alert("Please select a CSV file.");
    }
}