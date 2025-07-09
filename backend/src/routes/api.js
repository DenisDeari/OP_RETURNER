// backend/src/routes/api.js
const express = require('express');
const axios = require('axios');

// This function creates a router and injects dependencies (db, wallet, etc.)
function createApiRouter(db, rootNode, config, requestQueue) {
    const router = express.Router();

    // --- Helper for Webhook Registration ---
    async function registerWebhook(btcAddress) {
        if (!config.BLOCKCYPHER_TOKEN) {
            console.warn("BLOCKCYPHER_TOKEN not found. Skipping webhook registration.");
            return null;
        }
        const webhookUrl = `${config.WEBHOOK_RECEIVER_BASE_URL}/api/webhook/payment-notification`;
        const apiUrl = `${config.BLOCKCYPHER_API_BASE}/hooks?token=${config.BLOCKCYPHER_TOKEN}`;
        const payload = { event: "confirmed-tx", address: btcAddress, url: webhookUrl };
        
        console.log(`Registering webhook for ${btcAddress}...`);
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

    // --- API Endpoints ---
    router.get('/health', (req, res) => {
        res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    router.get('/request-status/:requestId', async (req, res) => {
        const { requestId } = req.params;
        console.log(`GET /api/request-status for ID: ${requestId}`);
        try {
            const row = await new Promise((resolve, reject) => {
                db.get("SELECT * FROM requests WHERE id = ?", [requestId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            });
            if (row) {
                res.status(200).json(row);
            } else {
                res.status(404).json({ error: 'Request not found' });
            }
        } catch (error) { // <-- THIS LINE IS NOW CORRECTED
            console.error(`Error in /api/request-status/${requestId}:`, error);
            res.status(500).json({ error: 'Failed to retrieve request status' });
        }
    });

    router.post('/message-request', async (req, res) => {
        const { message } = req.body;
        if (!message || Buffer.byteLength(message, 'utf8') > 80) {
            return res.status(400).json({ error: "Message is required and must be under 80 bytes." });
        }

        try {
            const result = await requestQueue.add(message, db, rootNode, config);
            
            const hookId = await registerWebhook(result.address);
            if (hookId) {
                db.run('UPDATE requests SET blockcypherHookId = ? WHERE id = ?', [hookId, result.newRequestId]);
                console.log(`Successfully updated hook ID ${hookId} for request ${result.newRequestId}`);
            }

            res.status(201).json({
                requestId: result.newRequestId, 
                address: result.address,
                requiredAmountSatoshis: result.requiredAmountSatoshis,
                message: "Send the specified amount to the address to embed your message."
            });
        } catch (error) {
            console.error(`Error in /api/message-request:`, error);
            res.status(500).json({ error: "Failed to process message request." });
        }
    });

    return router;
}

module.exports = createApiRouter;
