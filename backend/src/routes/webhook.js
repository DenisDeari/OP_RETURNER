// backend/src/routes/webhook.js
const express = require('express');
const { processPayment } = require('../op_return_creator');

// This function creates the webhook router
function createWebhookRouter(db, rootNode, config) {
    const router = express.Router();

    // The BlockCypher webhook will POST to this endpoint
    // This is the only route needed in this file.
    router.post('/payment-notification', async (req, res) => {
        const paymentData = req.body;
        console.log('[Webhook] Received payment notification:', JSON.stringify(paymentData, null, 2));

        const btcAddress = paymentData.address;

        if (!btcAddress) {
            console.warn('[Webhook] Received a notification without an address.');
            return res.status(400).send('Address missing from notification.');
        }

        try {
            // Find the request associated with this address
            db.get("SELECT * FROM requests WHERE address = ?", [btcAddress], async (err, request) => {
                if (err) {
                    console.error('[Webhook] Database error looking up address:', err);
                    return res.status(500).send('Internal server error.');
                }
                if (!request) {
                    console.warn(`[Webhook] Received payment for an unknown address: ${btcAddress}`);
                    return res.status(404).send('Request not found for this address.');
                }
                if (request.status !== 'pending_payment') {
                    console.log(`[Webhook] Ignoring notification for request ${request.id} because its status is already '${request.status}'.`);
                    return res.status(200).send('Already processed.');
                }

                // Update status to 'paid'
                db.run("UPDATE requests SET status = 'paid', paymentTxId = ?, paymentReceivedSatoshis = ? WHERE id = ?", 
                    [paymentData.hash, paymentData.value], 
                    (updateErr) => {
                        if (updateErr) {
                            console.error(`[Webhook] Failed to update status for request ${request.id}:`, updateErr);
                            return res.status(500).send('Internal server error.');
                        }
                        
                        console.log(`[Webhook] Status for request ${request.id} updated to 'paid'.`);
                        // Asynchronously process the OP_RETURN creation
                        processPayment(request, db, rootNode, config); 
                    }
                );
            });
            // Respond to BlockCypher immediately to prevent timeouts
            res.status(200).send('Notification received.');

        } catch (e) {
            console.error('[Webhook] Unexpected error processing notification:', e);
            res.status(500).send('Internal server error.');
        }
    });

    return router;
}

module.exports = createWebhookRouter;