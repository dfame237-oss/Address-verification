// api/bulk-jobs.js
// Handles Bulk Verification Job Submission, Status Polling, Cancellation, and Asynchronous Processing
// NOTE: This implementation runs the heavy verification process SYNCHRONOUSLY 
// within the POST handler. For large files, this will hit serverless function timeouts.
// A production solution requires a separate worker process or queue.

const { connectToDatabase } = require('../utils/db');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

// Import core verification logic from verify-single-address.js to use internally
const { getIndiaPostData, processAddress, extractPin, meaninglessRegex } = require('./verify-single-address');

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';
const MAX_ACTIVE_JOBS = 2; // Requirement 3

// --- Helper: parse JWT payload from Authorization header ---
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

// --- Helper: CSV parser from public/bulk_verification_logic.js ---
function parseCSV(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return [];

    // Simple header parsing (assuming fixed order for server-side simplicity)
    const header = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, ''));
    const data = [];
    const idIndex = header.indexOf('ORDER ID');
    const nameIndex = header.indexOf('CUSTOMER NAME');
    const addressIndex = header.indexOf('CUSTOMER RAW ADDRESS');

    if (idIndex === -1 || nameIndex === -1 || addressIndex === -1) {
        return [];
    }

    // Simplified row parser for server-side (handles basic quotes)
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        
        // This regex attempts to handle quoted fields in a CSV row
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

// --- Helper: CSV result builder from public/bulk_verification_logic.js ---
function createCSV(rows) {
    const header = "ORDER ID,CUSTOMER NAME,CUSTOMER RAW ADDRESS,CLEAN NAME,CLEAN ADDRESS LINE 1,LANDMARK,STATE,DISTRICT,PIN,REMARKS,QUALITY\n";
    const escapeAndQuote = (cell) => `\"${String(cell || '').replace(/\"/g, '\"\"')}\"`;
    
    const outputRows = rows.map(vr => {
        return [
            vr['ORDER ID'],
            vr['CUSTOMER NAME'],
            vr['CUSTOMER RAW ADDRESS'],
            vr.customerCleanName,
            vr.addressLine1,
            vr.landmark,
            vr.state,
            vr.district,
            vr.pin,
            vr.remarks,
            vr.addressQuality
        ].map(escapeAndQuote).join(',');
    });
    
    return header + outputRows.join('\n');
}

// --------------------------------------------------------
// CORE JOB PROCESSOR (Synchronous Execution - see Note above)
// --------------------------------------------------------
async function runJobProcessor(db, jobId, client, addresses) {
    const jobsCollection = db.collection('bulkJobs');
    const clientsCollection = db.collection('clients');
    
    console.log(`Starting job ${jobId.toString()} for client ${client.username}`);
    
    // Set status to In Progress
    await jobsCollection.updateOne(
        { _id: jobId }, 
        { $set: { status: 'In Progress', startTime: new Date(), processedCount: 0 } }
    );
    
    const isUnlimited = (client.remainingCredits === 'Unlimited' || String(client.initialCredits).toLowerCase() === 'unlimited');
    let successfulVerifications = 0;
    const outputRows = [];

    // The entire processing loop happens here (simulating an async worker)
    for (let i = 0; i < addresses.length; i++) {
        const row = addresses[i];
        const rawAddress = row['CUSTOMER RAW ADDRESS'] || '';
        const customerName = row['CUSTOMER NAME'] || '';
        
        let verificationResult;
        
        if (!rawAddress || rawAddress.trim() === "") {
            verificationResult = { 
                status: "Skipped", remarks: "Missing raw address in CSV row.", addressQuality: "Very Bad", 
                customerCleanName: customerName, addressLine1: "", landmark: "", state: "", district: "", pin: "" 
            };
        } else {
            try {
                // Check for cancellation signal before running expensive AI call
                const jobStatusCheck = await jobsCollection.findOne({ _id: jobId }, { projection: { status: 1 } });
                if (jobStatusCheck.status === 'Cancelled') {
                    console.log(`Job ${jobId} cancelled mid-run.`);
                    break; 
                }
                
                // --- Core Verification Logic ---
                const initialPin = extractPin(rawAddress);
                let postalData = initialPin ? await getIndiaPostData(initialPin) : { PinStatus: 'Error' };
                const geminiResult = await processAddress(rawAddress, postalData); // calls Gemini
                
                if (geminiResult.error || !geminiResult.text) {
                     verificationResult = {
                        status: "Error", error: geminiResult.error || 'Gemini API failed.',
                        remarks: `Error: ${geminiResult.error || 'Gemini Error'}`,
                        customerCleanName: customerName,
                        addressLine1: "API Error: See Remarks", landmark: "", state: "", district: "", pin: "", addressQuality: "VERY BAD"
                    };
                } else {
                    // NOTE: For this simulation, we are using a simplified verification result structure.
                    const jsonText = geminiResult.text.replace(/```json|```/g, '').trim(); 
                    let parsedData;
                    try { parsedData = JSON.parse(jsonText); } catch(e) { parsedData = {}; }

                    verificationResult = {
                        status: "Success",
                        customerCleanName: (customerName || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim() || null,
                        addressLine1: parsedData.FormattedAddress || rawAddress,
                        landmark: parsedData.Landmark || '',
                        state: parsedData.State || '',
                        district: parsedData['DIST.'] || '',
                        pin: parsedData.PIN || initialPin,
                        addressQuality: parsedData.AddressQuality || 'Medium',
                        remarks: 'Processed by AI.', // Simplified remark
                    };
                    successfulVerifications++;
                }
            } catch (error) {
                console.error(`Error processing row ${i} in job ${jobId}:`, error);
                verificationResult = { 
                    status: "Error", remarks: `Fatal processing error: ${error.message}`, addressQuality: "Very Bad", 
                    customerCleanName: customerName, addressLine1: "", landmark: "", state: "", district: "", pin: "" 
                };
            }
        }
        
        // Add required fields for CSV mapping
        verificationResult['ORDER ID'] = row['ORDER ID'];
        verificationResult['CUSTOMER NAME'] = row['CUSTOMER NAME'];
        verificationResult['CUSTOMER RAW ADDRESS'] = rawAddress;
        
        outputRows.push(verificationResult);
        
        // Update progress every 10 rows or at the end
        if ((i + 1) % 10 === 0 || i === addresses.length - 1) {
             await jobsCollection.updateOne({ _id: jobId }, { $set: { processedCount: i + 1 } });
        }
    }
    
    const jobStatusCheck = await jobsCollection.findOne({ _id: jobId }, { projection: { status: 1 } });
    if (jobStatusCheck.status === 'Cancelled') {
        console.log(`Job ${jobId} ended as cancelled.`);
        // Note: No refund needed as credit was never deducted.
        return; 
    }
    
    // --- CRITICAL STEP: FINAL CREDIT DEDUCTION (Requirement 1) ---
    if (!isUnlimited && successfulVerifications > 0) {
        // Deduct credits for successful verification attempts only
        const deductionAmount = successfulVerifications; 
        try {
            const deductionResult = await clientsCollection.updateOne(
                { _id: client._id, remainingCredits: { $ne: 'Unlimited' } },
                { $inc: { remainingCredits: -deductionAmount } }
            );
            if (deductionResult.matchedCount === 0) {
                 console.warn(`Client ${client.username} used credits but deduction failed (likely due to concurrent admin change).`);
            } else {
                 console.log(`Successfully deducted ${deductionAmount} credits for job ${jobId}.`);
            }
        } catch (e) {
            console.error(`Failed to perform final bulk credit deduction for job ${jobId}:`, e);
        }
    }
    
    // Finalize Job
    const finalCSV = createCSV(outputRows);
    await jobsCollection.updateOne(
        { _id: jobId }, 
        { $set: { status: 'Completed', completedTime: new Date(), outputData: finalCSV, processedCount: addresses.length } }
    );
    console.log(`Job ${jobId} completed successfully.`);
}
// --------------------------------------------------------

// --- Router Handler ---
module.exports = async (req, res) => {
    // CORS & Auth Setup
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get('action') || '';
    
    const jwtPayload = parseJwtFromHeader(req);
    if (!jwtPayload || !jwtPayload.clientId) {
        return res.status(401).json({ status: 'Error', message: 'Authentication required.' });
    }
    
    let db;
    try {
        db = (await connectToDatabase()).db;
    } catch (e) {
        return res.status(500).json({ status: 'Error', message: 'Database connection failed.' });
    }
    const clientsCollection = db.collection('clients');
    const jobsCollection = db.collection('bulkJobs');
    const clientId = new ObjectId(jwtPayload.clientId);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* ignore */ } }
    
    // --------------------------------------------------------
    // GET: LIST STATUS (Requirement 2)
    // --------------------------------------------------------
    if (req.method === 'GET') {
        try {
            const jobs = await jobsCollection.find({ clientId: jwtPayload.clientId }).sort({ submittedAt: -1 }).toArray();
            return res.status(200).json({ status: 'Success', jobs });
        } catch (e) {
            console.error('GET /api/bulk-jobs error:', e);
            return res.status(500).json({ status: 'Error', message: 'Failed to retrieve jobs.' });
        }
    }
    
    // --------------------------------------------------------
    // POST: SUBMIT JOB (Requirements 3, 6)
    // --------------------------------------------------------
    if (req.method === 'POST') {
        const { filename, csvData, totalRows } = body || {};
        if (!csvData || !totalRows || !filename) return res.status(400).json({ status: 'Error', message: 'Missing file data.' });
        
        try {
            const client = await clientsCollection.findOne({ _id: clientId });
            if (!client) return res.status(404).json({ status: 'Error', message: 'Client not found.' });

            // Check Max Active Jobs (Requirement 3)
            const activeJobsCount = await jobsCollection.countDocuments({ clientId: jwtPayload.clientId, status: { $in: ['Queued', 'In Progress'] } });
            if (activeJobsCount >= MAX_ACTIVE_JOBS) {
                 return res.status(429).json({ 
                    status: 'Error', 
                    message: `Maximum ${MAX_ACTIVE_JOBS} jobs already in progress. Please wait or cancel one.` 
                });
            }

            // Check Credits (Requirement 6 - Pre-check)
            const remaining = client.remainingCredits;
            if (remaining !== 'Unlimited' && Number(remaining) < totalRows) {
                 return res.status(400).json({ 
                    status: 'Error', 
                    message: `Insufficient Credits. You have ${remaining} credits but require ${totalRows}.` 
                });
            }

            // Parse CSV for processing
            const addresses = parseCSV(csvData);
            if (addresses.length === 0) return res.status(400).json({ status: 'Error', message: 'No valid rows found in CSV.' });

            // Create Job Document
            const newJob = {
                clientId: jwtPayload.clientId,
                filename,
                totalRows: addresses.length,
                processedCount: 0,
                status: 'Queued',
                submittedAt: new Date(),
                startTime: null,
                completedTime: null,
                outputData: null,
                error: null,
            };
            const insertResult = await jobsCollection.insertOne(newJob);
            const jobId = insertResult.insertedId;
            
            // --- Execute Job Processor (Synchronous Block) ---
            // In a production async environment, you would trigger a message queue here.
            // Here, we run it immediately, blocking the request until done (or serverless times out).
            runJobProcessor(db, jobId, client, addresses)
                .catch(err => {
                    console.error(`Job ${jobId} FAILED with uncaught error:`, err);
                    jobsCollection.updateOne({ _id: jobId }, { $set: { status: 'Failed', error: 'Internal processing error.' } });
                });
            // --- End Synchronous Block ---

            return res.status(200).json({ status: 'Success', message: 'Job submitted and started.', jobId: jobId.toString() });
        } catch (e) {
            console.error('POST /api/bulk-jobs error:', e);
            return res.status(500).json({ status: 'Error', message: `Internal Server Error: ${e.message}` });
        }
    }

    // --------------------------------------------------------
    // PUT: CANCEL JOB (Requirement 4)
    // --------------------------------------------------------
    if (req.method === 'PUT' && action === 'cancel') {
        const { jobId } = body || {};
        if (!jobId) return res.status(400).json({ status: 'Error', message: 'jobId is required for cancellation.' });
        
        try {
            const jobObjectId = new ObjectId(jobId);
            const result = await jobsCollection.updateOne(
                { _id: jobObjectId, clientId: jwtPayload.clientId, status: { $in: ['Queued', 'In Progress'] } },
                { $set: { status: 'Cancelled', cancelledAt: new Date(), remarks: 'Cancelled by client.' } }
            );
            
            if (result.matchedCount === 0) {
                return res.status(404).json({ status: 'Error', message: 'Job not found, or it is already completed/failed.' });
            }
            
            return res.status(200).json({ status: 'Success', message: 'Job cancellation successful.' });
        } catch (e) {
            console.error('PUT /api/bulk-jobs?action=cancel error:', e);
            return res.status(500).json({ status: 'Error', message: `Cancellation failed: ${e.message}` });
        }
    }
    
    // --------------------------------------------------------
    // GET: DOWNLOAD CSV
    // --------------------------------------------------------
    if (req.method === 'GET' && action === 'download') {
        const jobId = url.searchParams.get('jobId');
        const filenameHint = url.searchParams.get('filename'); // Get filename hint from client
        
        if (!jobId) return res.status(400).json({ status: 'Error', message: 'jobId is required for download.' });
        
        try {
            const job = await jobsCollection.findOne({ _id: new ObjectId(jobId), clientId: jwtPayload.clientId, status: 'Completed' });
            
            if (!job) {
                // Send JSON error response if job is not found/completed
                return res.status(404).json({ status: 'Error', message: 'Job not found or not completed.' });
            }
            if (!job.outputData) {
                // Send JSON error response if output is missing (e.g., failed processing)
                return res.status(404).json({ status: 'Error', message: 'No output data found.' });
            }
            
            // Determine final filename: prefer the hint from the client, fallback to stored job filename
            const finalFilename = filenameHint || `${job.filename.replace('.csv', '')}_verified.csv`;
            
            // Send CSV data with correct headers
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);
            
            // Use res.send() for sending binary/raw text data (CSV)
            return res.status(200).send(job.outputData);
            
        } catch (e) {
            console.error('GET /api/bulk-jobs?action=download error:', e);
            // Send generic server error JSON response
            return res.status(500).json({ status: 'Error', message: `Download failed: ${e.message}` });
        }
    }

    return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' });
};