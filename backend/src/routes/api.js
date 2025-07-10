// backend/src/routes/api.js
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid'); // Import UUID for unique IDs

// This function creates a router and injects dependencies
function createApiRouter(db, rootNode, config, requestQueue) {
    const router = express.Router();

    // Helper function to register a webhook with BlockCypher
    async function registerWebhook(btcAddress, webhookUrl) {
        if (!config.BLOCKCYPHER_TOKEN) {
            console.warn("BLOCKCYPHER_TOKEN not set. Skipping webhook registration.");
            return null;
        }
        const apiUrl = `${config.BLOCKCYPHER_API_BASE}/hooks?token=${config.BLOCKCYPHER_TOKEN}`;
        const payload = { event: "confirmed-tx", address: btcAddress, url: webhookUrl };
        
        try {
            const response = await axios.post(apiUrl, payload);
            console.log(`Registered webhook for ${btcAddress}. ID: ${response.data.id}`);
            return response.data.id;
        } catch (error) {
            console.error("Error registering webhook:", error.response ? error.response.data : error.message);
            return null;
        }
    }

    // --- NEW: Main endpoint to create a message request ---
    router.post('/request', async (req, res) => {
        const { message } = req.body;
        if (!message || new TextEncoder().encode(message).length > 80) {
            return res.status(400).json({ error: "Message is required and must be under 80 bytes." });
        }

        try {
            // Use the queue to get a unique address and other details
            const result = await requestQueue.add(message, db, rootNode, config);
            
            // The full URL for the webhook receiver
            const webhookReceiverUrl = `${config.WEBHOOK_RECEIVER_BASE_URL}/api/webhook/payment-notification`;
            
            // Register the webhook for the new address
            const hookId = await registerWebhook(result.address, webhookReceiverUrl);
            
            // Update the request in the DB with the webhook ID
            if (hookId) {
                db.run('UPDATE requests SET blockcypherHookId = ? WHERE id = ?', [hookId, result.newRequestId]);
            }

            // Return all necessary info to the frontend
            res.status(201).json({
                id: result.newRequestId,
                message: message,
                address: result.address,
                amount: result.requiredAmountSatoshis,
                status: 'pending_payment',
                created_at: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error processing /api/request:', error);
            res.status(500).json({ error: 'Failed to process the request on the server.' });
        }
    });

    // --- NEW: Endpoint to get the status of any request by its ID ---
    router.get('/request/:id', (req, res) => {
        const { id } = req.params;
        db.get('SELECT * FROM requests WHERE id = ?', [id], (err, row) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            if (!row) {
                return res.status(404).json({ error: 'Request not found' });
            }
            // Return only the data safe for public viewing
            res.json({
                id: row.id,
                message: row.message,
                address: row.address,
                amount: row.requiredAmountSatoshis,
                status: row.status,
                tx_id: row.opReturnTxId, // The final transaction ID
                created_at: row.createdAt
            });
        });
    });

    return router;
}

module.exports = createApiRouter;