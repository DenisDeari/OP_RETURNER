// backend/server.js

require('dotenv').config({ path: '../.env' });
const express = require('express');
const bitcoin = require('bitcoinjs-lib');
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const opReturnCreator = require('./src/op_return_creator');
const sqlite3 = require('sqlite3').verbose();

// --- Constants ---
const { PORT, MNEMONIC, BLOCKCYPHER_TOKEN, WEBHOOK_RECEIVER_BASE_URL } = process.env;
const NETWORK = bitcoin.networks.bitcoin; // Ensure this matches your intent (mainnet/testnet)
const NETWORK_NAME = NETWORK === bitcoin.networks.bitcoin ? 'main' : 'test3';
const BLOCKCYPHER_API_BASE = `https://api.blockcypher.com/v1/btc/${NETWORK_NAME}`;
const bip32 = BIP32Factory(ecc);

// --- HD Wallet Setup ---
if (!MNEMONIC || MNEMONIC.split(' ').length < 12) {
    console.error("FATAL ERROR: MNEMONIC environment variable not found or too short.");
    process.exit(1);
}
console.log("MNEMONIC loaded successfully.");
let rootNode;
try {
    if (!bip39.validateMnemonic(MNEMONIC)) {
        console.error("!!! MNEMONIC provided is NOT VALID. Please check it. !!!");
        process.exit(1);
    }
    const seed = bip39.mnemonicToSeedSync(MNEMONIC);
    rootNode = bip32.fromSeed(seed);
    console.log("HD Wallet root node created successfully.");
} catch (error) {
    console.error("FATAL ERROR: Failed to create HD wallet from mnemonic:", error);
    process.exit(1);
}

// --- Database Setup ---
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'requests.db');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
    console.log("Created data directory:", DATA_DIR);
}

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error("Error opening database:", err.message);
        process.exit(1);
    } else {
        console.log(`Connected to the SQLite database: ${DB_FILE}`);
        createRequestsTable();
    }
});

function createRequestsTable() {
    const createTableSql = `
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            message TEXT NOT NULL,
            address TEXT UNIQUE NOT NULL,
            derivationPath TEXT NOT NULL,
            "index" INTEGER UNIQUE NOT NULL,
            requiredAmountSatoshis INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending_payment',
            createdAt TEXT NOT NULL,
            blockcypherHookId TEXT,
            paymentTxId TEXT,
            paymentReceivedSatoshis INTEGER,
            paymentConfirmationCount INTEGER,
            paymentConfirmedAt TEXT,
            opReturnTxId TEXT,
            opReturnTxHex TEXT  /* New column for raw OP_RETURN TX hex */
        );
    `;
    db.run(createTableSql, (err) => {
        if (err) {
            console.error("Error creating requests table:", err.message);
            process.exit(1);
        } else {
            console.log("Table 'requests' created or already exists.");
        }
    });
}

// --- Express Application Setup ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.use('/css', express.static(path.join(__dirname, '../frontend/css')));
app.use('/js', express.static(path.join(__dirname, '../frontend/js')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// --- Helper Function for Blockcypher Webhook Registration ---
async function registerWebhookWithBlockcypher(btcAddress, webhookUrl) {
    if (!BLOCKCYPHER_TOKEN) {
        console.warn("BLOCKCYPHER_TOKEN not found. Skipping webhook registration.");
        return null;
    }
    if (!webhookUrl || !webhookUrl.startsWith('https://')) {
        console.warn(`Webhook URL (${webhookUrl}) is invalid or not HTTPS. Registration might fail.`);
    }
    const apiUrl = `${BLOCKCYPHER_API_BASE}/hooks?token=${BLOCKCYPHER_TOKEN}`;
    const payload = { event: "confirmed-tx", address: btcAddress, url: webhookUrl };
    console.log(`Registering webhook for ${btcAddress} with URL ${webhookUrl.split('?')[0]}`);
    try {
        const response = await axios.post(apiUrl, payload);
        console.log(`Successfully registered webhook. ID: ${response.data.id}`);
        return response.data.id;
    } catch (error) {
        console.error("Error registering webhook:", error.message);
        if (error.response) {
            console.error('API Error Status:', error.response.status, 'Data:', error.response.data);
        }
        return null;
    }
}

// --- In-Memory Queue for Message Request Processing ---
const requestProcessingQueue = [];
let isProcessingRequest = false;

async function processQueue() {
    if (isProcessingRequest || requestProcessingQueue.length === 0) {
        return; // Either busy or queue is empty
    }
    isProcessingRequest = true;
    const { message, originalResolve, originalReject } = requestProcessingQueue.shift(); // Get the oldest request

    console.log(`[QueueProcessor] Starting processing for message: "${message.substring(0,30)}..."`);

    try {
        // --- Critical DB logic and request creation ---
        const lastIdxRow = await new Promise((resolve, reject) => {
            db.get('SELECT MAX("index") as lastIndex FROM requests', [], (err, row) => {
                if (err) return reject(new Error("Failed to query last index: " + err.message));
                resolve(row);
            });
        });
        const nextIndex = (lastIdxRow && lastIdxRow.lastIndex !== null ? lastIdxRow.lastIndex : -1) + 1;

        const coinType = NETWORK === bitcoin.networks.bitcoin ? 0 : 1;
        const derivationPath = `m/84'/${coinType}'/0'/0/${nextIndex}`; // Used derivationPath as in your original code
        let address;
        try {
            const childNode = rootNode.derivePath(derivationPath);
            const pubkeyBuffer = Buffer.from(childNode.publicKey);
            address = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuffer, network: NETWORK }).address;
            if (!address) throw new Error("Address generation resulted in undefined.");
        } catch (deriveError) {
            console.error(`[QueueProcessor] Failed to derive address at ${derivationPath}:`, deriveError);
            throw new Error("Internal server error during address derivation.");
        }

        const requiredAmountSatoshis = 1000;
        const newRequestId = uuidv4();
        const createdAt = new Date().toISOString();

        await new Promise((resolve, reject) => {
            const params = [newRequestId, message, address, derivationPath, nextIndex, requiredAmountSatoshis, 'pending_payment', createdAt];
            db.run('INSERT INTO requests (id, message, address, derivationPath, "index", requiredAmountSatoshis, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params, function(err) {
                if (err) {
                    // This error will be caught by the outer try/catch and handled by originalReject
                    return reject(new Error(`Failed to save request: ${err.message}`));
                }
                console.log(`[QueueProcessor] New request inserted: ID ${newRequestId}, Address ${address}, Index ${nextIndex}`);
                resolve();
            });
        });
        // --- End of critical DB logic ---

        // If successful, resolve the original promise with the necessary data for the API response
        originalResolve({ newRequestId, address, requiredAmountSatoshis, message });

    } catch (error) {
        console.error("[QueueProcessor] Error processing request:", error.message);
        originalReject(error); // Reject the original promise associated with this request
    } finally {
        isProcessingRequest = false;
        console.log(`[QueueProcessor] Finished processing. Queue length: ${requestProcessingQueue.length}`);
        if (requestProcessingQueue.length > 0) {
             console.log("[QueueProcessor] Triggering next in queue.");
             processQueue(); // Attempt to process the next item if any
        }
    }
}


// --- API Endpoints ---
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/request-status/:requestId', async (req, res) => {
    const { requestId } = req.params;
    if (!requestId) return res.status(400).json({ error: 'Request ID is required.' });

    console.log(`GET /api/request-status for ID: ${requestId}`);
    try {
        const row = await new Promise((resolve, reject) => {
            db.get("SELECT * FROM requests WHERE id = ?", [requestId], (err, row) => {
                if (err) return reject(new Error(`DB query failed: ${err.message}`));
                resolve(row);
            });
        });
        if (row) {
            res.status(200).json(row);
        } else {
            res.status(404).json({ error: 'Request not found' });
        }
    } catch (error) {
        console.error(`Error in /api/request-status/${requestId}:`, error);
        res.status(500).json({ error: 'Failed to retrieve request status' });
    }
});

app.post('/api/message-request', async (req, res) => {
    const { message } = req.body;
    if (!message || Buffer.byteLength(message, 'utf8') === 0) {
        return res.status(400).json({ error: "Message is required." });
    }
    if (Buffer.byteLength(message, 'utf8') > 80) {
        return res.status(400).json({ error: "Message exceeds 80 bytes limit." });
    }

    console.log(`POST /api/message-request for message: "${message.substring(0,30)}..." - Adding to queue.`);

    try {
        // Add the request to the queue and wait for its turn
        // The actual processing (DB insert, etc.) is now handled by processQueue
        const resultFromQueue = await new Promise((resolve, reject) => {
            requestProcessingQueue.push({ message, originalResolve: resolve, originalReject: reject });
            console.log(`[MessageRequest] Added to queue. Current queue length: ${requestProcessingQueue.length}`);
            processQueue(); // Trigger processing if not already active
        });

        // resultFromQueue will contain { newRequestId, address, requiredAmountSatoshis, message }
        const { newRequestId, address, requiredAmountSatoshis } = resultFromQueue;

        // This part runs *after* the request has been successfully processed by the queue
        const webhookCallbackUrl = `${WEBHOOK_RECEIVER_BASE_URL}/api/webhook/payment-notification`;
        const hookId = await registerWebhookWithBlockcypher(address, webhookCallbackUrl);

        if (hookId) {
            await new Promise((resolve, reject) => {
                db.run('UPDATE requests SET blockcypherHookId = ? WHERE id = ?', [hookId, newRequestId], function(err) {
                    if (err) {
                        console.error(`Failed to update hook ID ${hookId} for request ${newRequestId}: ${err.message}`);
                        // Don't reject, just log as the primary operation was successful
                    } else {
                        console.log(`Successfully updated hook ID ${hookId} for request ${newRequestId}`);
                    }
                    resolve(); // Resolve regardless of hook update outcome for this promise
                });
            });
        } else {
            console.warn(`Webhook registration failed/skipped for address ${address}.`);
        }

        res.status(201).json({
            requestId: newRequestId,
            address: address,
            requiredAmountSatoshis: requiredAmountSatoshis,
            message: "Send the specified amount to the address to embed your message."
        });

    } catch (error) {
        // This catch block now handles errors from the queue processing as well
        console.error(`Error in /api/message-request (potentially from queue):`, error.message);
        res.status(500).json({ error: error.message || "Failed to process message request." });
    }
});

app.post('/api/webhook/payment-notification', async (req, res) => {
    console.log(">>>>>>>>> WEBHOOK /api/webhook/payment-notification ENTERED <<<<<<<<<");
    console.log("Webhook Body (first 200 chars):", JSON.stringify(req.body).substring(0, 200));

    const notification = req.body;
    try {
        const txHash = notification.hash;
        const confirmations = notification.confirmations;

        if (!txHash || confirmations === undefined || !notification.outputs || !Array.isArray(notification.outputs)) {
            console.warn("[Webhook] Payload missing essential fields.");
            return res.status(200).send('Webhook received but payload invalid/incomplete.');
        }
        console.log(`[Webhook] Processing TX ${txHash}, Confirmations: ${confirmations}`);

        let paymentProcessedForRequestObject = null;

        for (const output of notification.outputs) {
            if (!output.addresses || !Array.isArray(output.addresses) || output.value === undefined) continue;

            for (const targetAddress of output.addresses) {
                const matchingRequest = await new Promise((resolve, reject) => {
                    // Fetch request that is pending or had a payment detected (but not yet fully confirmed for OP_RETURN)
                    db.get("SELECT * FROM requests WHERE address = ? AND (status = 'pending_payment' OR status = 'payment_detected')", [targetAddress], (err, row) => {
                        if (err) return reject(new Error(`DB query failed for ${targetAddress}: ${err.message}`));
                        resolve(row);
                    });
                });

                if (matchingRequest) {
                    console.log(`[Webhook] Found matching request ID ${matchingRequest.id} for address ${targetAddress} with status ${matchingRequest.status}`);
                    const valueReceivedSatoshis = output.value;

                    // If already in a terminal OP_RETURN state, log and skip further processing for this request.
                    if (matchingRequest.status === 'op_return_broadcasted' || matchingRequest.status === 'op_return_failed') {
                        console.log(`[Webhook] Request ${matchingRequest.id} already in terminal state (${matchingRequest.status}). No further OP_RETURN action needed.`);
                        // Update confirmations if they changed, but don't reset paymentProcessedForRequestObject if another output might be relevant
                        if (matchingRequest.paymentTxId === txHash && confirmations > (matchingRequest.paymentConfirmationCount || 0)) {
                             await new Promise(resolve => { // Using resolve directly as reject is not critical here
                                 db.run('UPDATE requests SET paymentConfirmationCount = ? WHERE id = ?', [confirmations, matchingRequest.id], function(err) {
                                     if (err) console.error(`[Webhook] DB update (confirmations on terminal state) failed: ${err.message}`);
                                     else console.log(`[Webhook] Request ${matchingRequest.id} (terminal) confirmations updated to ${confirmations}.`);
                                     resolve();
                                 });
                             });
                        }
                        // Set to null only if this was the target, or ensure logic handles not reprocessing it.
                        // If one output leads to this, we should break from this inner loop for this address.
                        paymentProcessedForRequestObject = null; // Prevent reprocessing by subsequent logic if this was the hit.
                        break; // Break from iterating this output's addresses.
                    }

                    if (confirmations >= 1 && valueReceivedSatoshis >= matchingRequest.requiredAmountSatoshis) {
                        console.log(`[Webhook] Payment VALID for request ${matchingRequest.id}! (Conf: ${confirmations}, Received: ${valueReceivedSatoshis})`);
                        const updateParams = ['payment_confirmed', txHash, valueReceivedSatoshis, confirmations, notification.confirmed || new Date().toISOString(), matchingRequest.id];
                        
                        await new Promise((resolve, reject) => {
                            // Update to 'payment_confirmed' only if it's not already in a state that implies OP_RETURN processing has started/finished.
                            db.run('UPDATE requests SET status = ?, paymentTxId = ?, paymentReceivedSatoshis = ?, paymentConfirmationCount = ?, paymentConfirmedAt = ? WHERE id = ? AND (status = ? OR status = ?)',
                                [...updateParams, 'pending_payment', 'payment_detected'], function(err) {
                                if (err) return reject(new Error(`DB update to payment_confirmed failed: ${err.message}`));
                                if (this.changes > 0) {
                                     console.log(`[Webhook] Request ${matchingRequest.id} status updated to payment_confirmed.`);
                                } else {
                                     console.warn(`[Webhook] DB update (to payment_confirmed) was a NO-OP for ${matchingRequest.id}. Current status: ${matchingRequest.status} (may already be payment_confirmed or further).`);
                                }
                                resolve();
                            });
                        });
                        // Prepare the object for OP_RETURN processing. status will be re-checked.
                        paymentProcessedForRequestObject = { ...matchingRequest, status: 'payment_confirmed', paymentTxId: txHash, paymentReceivedSatoshis: valueReceivedSatoshis, paymentConfirmationCount: confirmations, paymentConfirmedAt: notification.confirmed || new Date().toISOString() };
                        break; // Address processed, break from iterating this output's addresses.
                    } else if (valueReceivedSatoshis > 0 && valueReceivedSatoshis < matchingRequest.requiredAmountSatoshis && matchingRequest.status === 'pending_payment') {
                        console.log(`[Webhook] Partial payment DETECTED for ${matchingRequest.id} (Received: ${valueReceivedSatoshis}, Required: ${matchingRequest.requiredAmountSatoshis}). Updating status.`);
                         await new Promise(resolve => { // Using resolve directly as reject is not critical here
                            db.run('UPDATE requests SET status = ?, paymentTxId = ?, paymentReceivedSatoshis = ?, paymentConfirmationCount = ? WHERE id = ? AND status = ?',
                                ['payment_detected', txHash, valueReceivedSatoshis, confirmations, matchingRequest.id, 'pending_payment'], function(err) {
                                if (err) console.error(`[Webhook] DB update to payment_detected failed: ${err.message}`);
                                else console.log(`[Webhook] Request ${matchingRequest.id} status updated to payment_detected.`);
                                resolve();
                            });
                        });
                        paymentProcessedForRequestObject = null; // Do not proceed to OP_RETURN
                        break; 
                    } else {
                        console.log(`[Webhook] Payment for ${matchingRequest.id} not yet valid (Conf: ${confirmations}, Received: ${valueReceivedSatoshis}, Required: ${matchingRequest.requiredAmountSatoshis}). Current status: ${matchingRequest.status}`);
                    }
                }
            } // end for targetAddress
            if (paymentProcessedForRequestObject) {
                    // If the inner loop (over addresses for the current output) resulted in finding
                    // a valid request to process (i.e., paymentProcessedForRequestObject is not null),
                    // then we can stop processing further outputs.
                    console.log(`[Webhook] Found a request to process (ID: ${paymentProcessedForRequestObject.id}) from the current output. Breaking from outer output loop.`);
                    break; // Break from the outer loop (iterating 'outputs')
                }
            } // end for output

        // Check if we have a request that's confirmed and needs OP_RETURN processing
        if (paymentProcessedForRequestObject) {
            // FRESH STATUS CHECK before critical OP_RETURN operation
            const freshStatusRow = await new Promise((resolve, reject) => {
                db.get("SELECT status FROM requests WHERE id = ?", [paymentProcessedForRequestObject.id], (err, row) => {
                    if (err) {
                        console.error(`[Webhook] DB query failed for fresh status check (ID: ${paymentProcessedForRequestObject.id}): ${err.message}`);
                        return reject(new Error(`DB query failed for fresh status check: ${err.message}`));
                    }
                    resolve(row);
                });
            }).catch(err => { // Catch error from the promise itself if db.get fails internally before reject()
                console.error(`[Webhook] Error fetching fresh status before OP_RETURN for ID ${paymentProcessedForRequestObject.id}:`, err);
                throw err; // Propagate to main catch, send 200 to webhook provider
            });

            if (freshStatusRow && freshStatusRow.status === 'payment_confirmed') {
                console.log(`[Webhook] Fresh status is 'payment_confirmed' for ${paymentProcessedForRequestObject.id}. Triggering OP_RETURN.`);
                let finalOpStatus = 'op_return_failed'; // Default to failed
                let opReturnTxId = null;
                let opReturnTxHex = null;

                try {
                    const opReturnResult = await opReturnCreator.createOpReturnTransaction(
                        paymentProcessedForRequestObject, // This object still has 'payment_confirmed' as its status property
                        rootNode,
                        NETWORK,
                        { BLOCKCYPHER_API_BASE, BLOCKCYPHER_TOKEN }
                    );

                    if (opReturnResult && opReturnResult.opReturnTxId) {
                        opReturnTxId = opReturnResult.opReturnTxId;
                        opReturnTxHex = opReturnResult.signedTxHex;
                        finalOpStatus = 'op_return_broadcasted';
                        console.log(`[Webhook] OP_RETURN broadcast success for ${paymentProcessedForRequestObject.id}, TXID: ${opReturnTxId}`);
                    } else {
                        console.error(`[Webhook] OP_RETURN creation/broadcast failed for ${paymentProcessedForRequestObject.id}. Result from creator: null or no txId`);
                    }
                } catch (opReturnError) {
                    console.error(`[Webhook] CATCH during OP_RETURN for ${paymentProcessedForRequestObject.id}:`, opReturnError);
                }

                // SMARTER DATABASE UPDATE
                let sql;
                let params;
                if (finalOpStatus === 'op_return_broadcasted') {
                    sql = "UPDATE requests SET status = ?, opReturnTxId = ?, opReturnTxHex = ? WHERE id = ? AND (status = ? OR status = ?)";
                    params = [finalOpStatus, opReturnTxId, opReturnTxHex, paymentProcessedForRequestObject.id, 'payment_confirmed', 'op_return_failed'];
                    console.log(`[Webhook] Attempting to set status to op_return_broadcasted for ${paymentProcessedForRequestObject.id} (can overwrite payment_confirmed or op_return_failed)`);
                } else { // finalOpStatus === 'op_return_failed'
                    sql = "UPDATE requests SET status = ?, opReturnTxId = ?, opReturnTxHex = ? WHERE id = ? AND status = ?";
                    params = [finalOpStatus, opReturnTxId, opReturnTxHex, paymentProcessedForRequestObject.id, 'payment_confirmed'];
                    console.log(`[Webhook] Attempting to set status to op_return_failed for ${paymentProcessedForRequestObject.id} (only if status is payment_confirmed)`);
                }

                await new Promise((resolve, reject) => {
                    db.run(sql, params, function(err) {
                        if (err) {
                            console.error(`[Webhook] DB update OP_RETURN details failed for ${paymentProcessedForRequestObject.id}:`, err);
                            return reject(err);
                        }
                        if (this.changes > 0) {
                            console.log(`[Webhook] DB updated: Request ${paymentProcessedForRequestObject.id} status based on OP_RETURN result to ${finalOpStatus}.`);
                        } else {
                            console.warn(`[Webhook] DB NO-OP when updating OP_RETURN details for ${paymentProcessedForRequestObject.id} to ${finalOpStatus}. Condition not met (e.g. status was not 'payment_confirmed' for a fail, or not 'payment_confirmed'/'op_return_failed' for a success).`);
                        }
                        resolve();
                    });
                }).catch(dbUpdateErr => {
                    console.error("[Webhook] CRITICAL - DB update of OP_RETURN results failed:", dbUpdateErr);
                });

            } else if (freshStatusRow && (freshStatusRow.status === 'op_return_broadcasted' || freshStatusRow.status === 'op_return_failed')) {
                console.log(`[Webhook] Request ${paymentProcessedForRequestObject.id} status became terminal (${freshStatusRow.status}) just before OP_RETURN call. OP_RETURN call was skipped.`);
            } else {
                console.log(`[Webhook] Request ${paymentProcessedForRequestObject.id} not in 'payment_confirmed' state (is ${freshStatusRow ? freshStatusRow.status : 'not found/error'}) right before OP_RETURN attempt. Skipping OP_RETURN call.`);
            }
        } else {
            console.log("[Webhook] No request identified for OP_RETURN processing in this webhook event (either no valid payment found, or request already in terminal state).");
        }

        res.status(200).send('Webhook Notification Processed.');
    } catch (error) {
        console.error("!!! CATCH BLOCK ERROR processing webhook payload !!!", error);
        res.status(200).send('Webhook received but internal processing error occurred.'); // ACK to Blockcypher
    }
});

// --- Start the Server ---
app.listen(PORT || 3000, () => {
    const actualPort = PORT || 3000;
    console.log(`Server listening on port ${actualPort}`);
    console.log(`View App: http://localhost:${actualPort}/`);
    console.log(`Test health: http://localhost:${actualPort}/api/health`);
    console.log(`Submit message request: POST http://localhost:${actualPort}/api/message-request`);
});