/* ---------------------------------------------------------
   Dfame Address AI
   script.js — Single + Bulk Verification
----------------------------------------------------------*/

/* ----------------------------------------
   STATUS MESSAGE HANDLER
-----------------------------------------*/
function updateStatusMessage(msg, isError = false) {
    const status = document.getElementById("status-message") ||
                   document.getElementById("bulk-status");

    if (!status) return;

    status.innerText = msg;
    status.style.color = isError ? "#f87171" : "#a3e635";
}

/* ----------------------------------------
   API URL (RELATIVE)
-----------------------------------------*/
const API_URL = "/api/verify-single-address";

/* ----------------------------------------
   SINGLE ADDRESS VERIFICATION
-----------------------------------------*/
async function verifySingleAddress() {
    const input = document.getElementById("address-input").value.trim();
    if (!input) return updateStatusMessage("❌ Please enter an address.", true);

    updateStatusMessage("⏳ Processing address...");

    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: input })
        });

        const result = await response.json();

        updateStatusMessage("✅ Address verified!");

        document.getElementById("result-box").classList.remove("hidden");

        document.getElementById("clean-address").innerText = result.cleanedAddress || "-";
        document.getElementById("out-district").innerText = result.district || "-";
        document.getElementById("out-state").innerText = result.state || "-";
        document.getElementById("out-pin").innerText = result.pin || "-";
        document.getElementById("out-landmark").innerText = result.landmark || "-";
        document.getElementById("out-quality").innerText = result.quality || "-";
        document.getElementById("out-remarks").innerText = result.remarks || "-";

    } catch (error) {
        console.error(error);
        updateStatusMessage("❌ Something went wrong. Try again.", true);
    }
}

/* ----------------------------------------
   BULK CSV VERIFICATION
-----------------------------------------*/

function validateCSV() {
    const fileInput = document.getElementById("csvFile");
    const file = fileInput.files[0];

    if (!file) {
        updateStatusMessage("❌ Please upload a CSV file.", true);
        return;
    }

    updateStatusMessage("⏳ Reading file...");

    const reader = new FileReader();

    reader.onload = async function (event) {
        const csvContent = event.target.result;
        const lines = csvContent.split(/\r?\n/).filter(line => line.trim());

        if (lines.length === 0) {
            updateStatusMessage("❌ CSV is empty.", true);
            return;
        }

        updateStatusMessage("⏳ Processing " + lines.length + " addresses...");

        const results = [];
        let index = 0;

        for (const line of lines) {
            try {
                const response = await fetch(API_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ address: line })
                });

                const json = await response.json();
                results.push(json);

                updateStatusMessage(`⏳ Processing ${index + 1} / ${lines.length}`);
                index++;

            } catch (error) {
                results.push({ cleanedAddress: "ERROR", remarks: "Failed" });
            }
        }

        updateStatusMessage("✅ Bulk verification completed!");

        // convert results to CSV
        const output = [
            "raw_input,cleaned_address,pin,district,state,landmark,quality,remarks"
        ];

        results.forEach(r => {
            output.push(
                `"${r.input || ""}","${r.cleanedAddress || ""}","${r.pin || ""}","${r.district || ""}","${r.state || ""}","${r.landmark || ""}","${r.quality || ""}","${r.remarks || ""}"`
            );
        });

        const blob = new Blob([output.join("\n")], { type: "text/csv" });
        const url = URL.createObjectURL(blob);

        document.getElementById("download-section").classList.remove("hidden");
        const link = document.getElementById("download-link");
        link.href = url;
        link.download = "verified-addresses.csv";

    };

    reader.onerror = function () {
        updateStatusMessage("❌ Error reading file.", true);
    };

    reader.readAsText(file);
}
