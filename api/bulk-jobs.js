// api/bulk-jobs.js
// Handles Bulk Verification Job Submission, Status Polling, Cancellation, and Throttled Concurrent Processing

const { connectToDatabase } = require('../utils/db');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

// FIX: Correctly import the reusable core verification function from the single-address file
const { 
    runVerificationLogic 
} = require('./verify-single-address'); 

const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_env_jwt_secret';
const MAX_ACTIVE_JOBS = 1; // Enforce single job concurrency

// --- NEW CONFIGURATION: Throttle concurrent calls to avoid QPS rate limits ---
const MAX_CONCURRENT_CALLS = 10; 

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

// --- Helper: CSV parser (Uses Comma Delimiter) ---
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

// --- Helper: CSV result builder (Uses Comma Delimiter) ---
function createCSV(rows) {
    // FIX: Uses Comma delimiter for consistency
    const CUSTOM_DELIMITER = ","; 
    const header = "ORDER ID,CUSTOMER NAME,CUSTOMER RAW ADDRESS,CLEAN NAME,CLEAN ADDRESS LINE 1,LANDMARK,STATE,DISTRICT,PIN,REMARKS,QUALITY\n";
    
    const escapeAndQuote = (cell) => {
        return `\"${String(cell || '').replace(/\"/g, '\"\"')}\"`;
    };
    
    const outputRows = rows.map(vr => {
        const cleanName = vr.customerCleanName || '';
        const addressLine1 = vr.addressLine1 || '';
        const landmark = vr.landmark || '';
        const state = vr.state || '';
        const district = vr.district || '';
        const pin = vr.pin || '';
        const remarks = vr.remarks || '';
        const addressQuality = vr.addressQuality || 'Very Bad';

        return [
            vr['ORDER ID'],
            vr['CUSTOMER NAME'],
            vr['CUSTOMER RAW ADDRESS'],
            cleanName,
            addressLine1,
            landmark,
            state,
            district,
            pin,
            remarks,
            addressQuality
        ].map(escapeAndQuote).join(CUSTOM_DELIMITER); 
    });
    
    return header + outputRows.join('\n');
}


/**
 * Executes an array of asynchronous tasks (promises) in chunks (throttling).
 * THIS FUNCTION IS CRITICAL FOR AVOIDING RATE LIMIT ERRORS.
 */
async function processInChunks(promiseFactories, limit, jobId, jobsCollection) {
    const results = [];
    
    for (let i = 0; i < promiseFactories.length; i += limit) {
        // Check for cancellation signal before starting the next chunk
        const jobStatusCheck = await jobsCollection.findOne({ _id: jobId }, { projection: { status: 1 } });
        if (jobStatusCheck.status === 'Cancelled') {
            throw new Error('JobCancelled');
        }
        
        const chunk = promiseFactories.slice(i, i + limit);
        // Execute the chunk concurrently
        const chunkResults = await Promise.all(chunk.map(factory => factory()));
        results.push(...chunkResults);
        
        // Update progress in the database after each chunk
        await jobsCollection.updateOne({ _id: jobId }, { $set: { processedCount: Math.min(i + limit, promiseFactories.length) } });
    }
    return results;
}

// --------------------------------------------------------
// NEW: Cleanup Old Jobs Helper (Runs on status check)
// --------------------------------------------------------
async function cleanupOldJobs(jobsCollection) {
    // Defines the time 24 hours ago
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000); 
    
    try {
        // *** CRITICAL CHANGE: Only delete jobs where status is 'Completed' 
        // AND completedTime is less than 24 hours ago. ***
        const result = await jobsCollection.deleteMany({
            status: 'Completed',
            completedTime: { $lt: twentyFourHoursAgo }
        });
        // You can log this for debugging on the server
        // console.log(`Cleanup ran. Deleted ${result.deletedCount} old completed jobs.`);
        return result.deletedCount;
    } catch (e) {
        console.error('Failed to cleanup old jobs:', e);
        return 0;
    }
}


// --------------------------------------------------------
// CORE JOB PROCESSOR (THROTTLED CONCURRENT EXECUTION)
// --------------------------------------------------------
async function runJobProcessor(db, jobId, client, addresses) {
    const jobsCollection = db.collection('bulkJobs');
    const clientsCollection = db.collection('clients');
    
    console.log(`Starting throttled job ${jobId.toString()} for client ${client.username}`);
    
    await jobsCollection.updateOne(
        { _id: jobId }, 
        { $set: { status: 'In Progress', startTime: new Date(), processedCount: 0 } }
    );
    
    const isUnlimited = (client.remainingCredits === 'Unlimited' || String(client.initialCredits).toLowerCase() === 'unlimited');
    let successfulVerifications = 0;
    
    // --- 1. Map addresses to an array of promise factories (functions that return promises) ---
    const promiseFactories = addresses.map(row => {
        const rawAddress = row['CUSTOMER RAW ADDRESS'] || '';
        const customerName = row['CUSTOMER NAME'] || '';
        
        // Return a promise factory function (the work definition)
        return async () => {
            if (!rawAddress || rawAddress.trim() === "") {
                return { 
                    'ORDER ID': row['ORDER ID'], 'CUSTOMER NAME': row['CUSTOMER NAME'], 'CUSTOMER RAW ADDRESS': rawAddress,
                    status: "Skipped", remarks: "Missing raw address in CSV row.", addressQuality: "Very Bad", 
                    customerCleanName: customerName, addressLine1: "", landmark: "", state: "", district: "", pin: "" 
                };
            } 

            try {
                // Call the unified logic
                const result = await runVerificationLogic(rawAddress, customerName);
                
                if (result.success) {
                    successfulVerifications++; 
                }
                
                // Return the full mapped result
                return {
                    'ORDER ID': row['ORDER ID'], 'CUSTOMER NAME': row['CUSTOMER NAME'], 'CUSTOMER RAW ADDRESS': rawAddress,
                    status: result.status, customerCleanName: result.customerCleanName, addressLine1: result.addressLine1,
                    landmark: result.landmark, state: result.state, district: result.district, pin: result.pin,
                    addressQuality: result.addressQuality, remarks: result.remarks,
                };
            } catch (e) {
                // Catch any error from runVerificationLogic and map to an error row
                console.error(`Error processing address for ID ${row['ORDER ID']}:`, e);
                return { 
                    'ORDER ID': row['ORDER ID'], 'CUSTOMER NAME': row['CUSTOMER NAME'], 'CUSTOMER RAW ADDRESS': rawAddress,
                    status: "Error", remarks: `Fatal processing error: ${e.message}`, addressQuality: "Very Bad", 
                    customerCleanName: customerName, addressLine1: "", landmark: "", state: "", district: "", pin: "" 
                };
            }
        };
    });

    let outputRows;
    try {
        // --- 2. Execute promises in throttled chunks (10 at a time) ---
        outputRows = await processInChunks(promiseFactories, MAX_CONCURRENT_CALLS, jobId, jobsCollection);
        
    } catch (e) {
        if (e.message === 'JobCancelled') {
             console.log(`Job ${jobId} ended as cancelled.`);
             await jobsCollection.updateOne({ _id: jobId }, { $set: { status: 'Cancelled' } });
             return;
        }
        console.error(`Fatal unexpected error during job ${jobId}:`, e);
        await jobsCollection.updateOne({ _id: jobId }, { $set: { status: 'Failed', error: 'Throttled processing failed.' } });
        return;
    }
    
    // Final status check is now mostly redundant if catch blocks handle statuses correctly
    const jobStatusCheck = await jobsCollection.findOne({ _id: jobId }, { projection: { status: 1 } });
    if (jobStatusCheck.status === 'Cancelled') {
        console.log(`Job ${jobId} ended as cancelled.`);
        return; 
    }
    
    // --- CRITICAL STEP: FINAL CREDIT DEDUCTION ---
    if (!isUnlimited && successfulVerifications > 0) {
        const deductionAmount = successfulVerifications; 
        try {
            const deductionResult = await clientsCollection.updateOne(
                { _id: client._id, remainingCredits: { $ne: 'Unlimited' } },
                { $inc: { remainingCredits: -deductionAmount } }
            );
            if (deductionResult.matchedCount === 0) {
                console.warn(`Client ${client.username} used credits but deduction failed.`);
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
        // *** CRITICAL: Ensure completedTime is set on completion ***
        { $set: { status: 'Completed', completedTime: new Date(), outputData: finalCSV, processedCount: addresses.length } } 
    );
    console.log(`Job ${jobId} completed successfully.`);
}

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
    // GET: LIST STATUS (Runs Cleanup)
    // --------------------------------------------------------
    if (req.method === 'GET' && (!action || action === 'list')) {
        try {
            // *** CRITICAL: Run cleanup before fetching the list ***
            await cleanupOldJobs(jobsCollection); 
            
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

            // Check Max Active Jobs (Requirement 3 - Now 1)
            const activeJobsCount = await jobsCollection.countDocuments({ clientId: jwtPayload.clientId, status: { $in: ['Queued', 'In Progress'] } });
            if (activeJobsCount >= MAX_ACTIVE_JOBS) {
                return res.status(429).json({ 
                    status: 'Error', 
                    message: `Maximum ${MAX_ACTIVE_JOBS} job is already in progress. Please wait for completion.` 
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
            
            // --- Execute Job Processor (Throttled Concurrent Block) ---
            runJobProcessor(db, jobId, client, addresses)
                .catch(err => {
                    console.error(`Job ${jobId} FAILED with uncaught error:`, err);
                    jobsCollection.updateOne({ _id: jobId }, { $set: { status: 'Failed', error: 'Internal processing error.' } });
                });
            // --- End Concurrent Block ---

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
    // GET: DOWNLOAD CSV (FIXED)
    // --------------------------------------------------------
    if (req.method === 'GET' && action === 'download') {
        const jobId = url.searchParams.get('jobId');
        const filenameHint = url.searchParams.get('filename'); 
        
        if (!jobId) return res.status(400).json({ status: 'Error', message: 'jobId is required for download.' });
        
        try {
            const job = await jobsCollection.findOne({ _id: new ObjectId(jobId), clientId: jwtPayload.clientId, status: 'Completed' });
            
            if (!job) {
                return res.status(404).json({ status: 'Error', message: 'Job not found or not completed.' });
            }
            if (!job.outputData) {
                return res.status(404).json({ status: 'Error', message: 'No output data found.' });
            }
            
            const finalFilename = filenameHint || `${job.filename.replace('.csv', '')}_verified.csv`;
            
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);
            
            return res.status(200).send(job.outputData);
            
        } catch (e) {
            console.error('GET /api/bulk-jobs?action=download error:', e);
            return res.status(500).json({ status: 'Error', message: `Download failed: ${e.message}` });
        }
    }

    return res.status(405).json({ status: 'Error', error: 'Method Not Allowed' });
};