// frontend/js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Get DOM Elements ---
    const messageInput = document.getElementById('message-input');
    const byteCounter = document.getElementById('byte-counter');
    const submitButton = document.getElementById('submit-button');
    const inputSection = document.getElementById('input-section');

    const paymentSection = document.getElementById('payment-section');
    const paymentFlexContainer = document.querySelector('.payment-flex-container'); // For showing/hiding QR+Address
    const requiredAmountEl = document.getElementById('required-amount');
    const paymentAddressEl = document.getElementById('payment-address');
    const qrcodeContainer = document.getElementById('qrcode');
    const requestIdEl = document.getElementById('request-id');
    const statusDisplayEl = document.getElementById('status-display');
    const newRequestButton = document.getElementById('new-request-button'); // In payment section
    const processingIndicator = document.getElementById('processing-indicator');

    const successSection = document.getElementById('success-section');
    const finalMessageEl = document.getElementById('final-message');
    const finalOpReturnTxidEl = document.getElementById('final-op-return-txid');
    const explorerLinkEl = document.getElementById('explorer-link');
    const finalOpReturnTxHexEl = document.getElementById('final-op-return-txhex');
    const successNewRequestButton = document.getElementById('success-new-request-button'); // In success section

    const lookupIdInput = document.getElementById('lookup-id-input');
    const lookupButton = document.getElementById('lookup-button');
    const lookupStatusEl = document.getElementById('lookup-status');

    const API_BASE_URL = '';
    let statusIntervalId = null;

    // --- Functions ---
    function updateByteCounter() {
        try {
            const message = messageInput.value;
            const byteLength = new TextEncoder().encode(message).length;
            byteCounter.textContent = byteLength;
            if (byteLength > 80) {
                byteCounter.style.color = 'red';
                byteCounter.style.fontWeight = 'bold';
            } else {
                byteCounter.style.color = '';
                byteCounter.style.fontWeight = '';
            }
        } catch (e) {
            console.error("Error calculating byte length:", e);
            byteCounter.textContent = 'Error';
        }
    }

    function showPaymentInfo(requestData) {
        paymentAddressEl.textContent = requestData.address;
        requestIdEl.textContent = requestData.requestId;
        requiredAmountEl.textContent = requestData.requiredAmountSatoshis;

        qrcodeContainer.innerHTML = '';
        try {
            new QRCode(qrcodeContainer, {
                text: `bitcoin:${requestData.address}?amount=${requestData.requiredAmountSatoshis / 100000000}`,
                width: 128,
                height: 128,
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch (e) {
            console.error("Failed to generate QR code:", e);
            qrcodeContainer.textContent = 'Error generating QR code.';
        }

        inputSection.style.display = 'none';
        paymentSection.style.display = 'block';
        if(paymentFlexContainer) paymentFlexContainer.style.display = 'flex'; // Ensure QR/Address part is visible
        successSection.style.display = 'none';
        processingIndicator.style.display = 'none';

        clearTimeout(statusIntervalId);
        checkStatus(requestData.requestId);
    }

    async function checkStatus(requestId) {
        console.log(`Checking status for ${requestId}...`);
        if (!requestId) return;

        try {
            const response = await fetch(`${API_BASE_URL}/api/request-status/${requestId}`);
            if (lookupStatusEl) lookupStatusEl.textContent = '';

            if (response.ok) {
                const data = await response.json();
                console.log("Status data from backend:", data);
                let currentStatusText = formatStatus(data);
                statusDisplayEl.textContent = currentStatusText;

                if (document.activeElement === lookupButton || (lookupIdInput && lookupIdInput.value === requestId)) {
                    if(lookupStatusEl) lookupStatusEl.textContent = `Status for ${requestId}: ${currentStatusText}`;
                }

                // Default UI states
                processingIndicator.style.display = 'none';
                if (paymentFlexContainer) paymentFlexContainer.style.display = 'flex'; // Show QR/Address by default

                if (data.status === 'payment_confirmed') {
                    statusDisplayEl.textContent = "Payment Confirmed. Creating & Broadcasting your message...";
                    processingIndicator.style.display = 'block';
                    if (paymentFlexContainer) paymentFlexContainer.style.display = 'none'; // Hide QR/Address
                    clearTimeout(statusIntervalId);
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 5000); // Poll faster
                } else if (data.status === 'op_return_broadcasted') {
                    statusDisplayEl.textContent = "Message Embedded & Broadcasted Successfully!"; // This element will now be hidden along with paymentSection
                    if (paymentFlexContainer) paymentFlexContainer.style.display = 'none'; // Hide QR/Address part
                    processingIndicator.style.display = 'none'; //
                    paymentSection.style.display = 'none'; // HIDE THE ENTIRE PAYMENT SECTION
                    successSection.style.display = 'block'; // Show success details

                    finalMessageEl.textContent = data.message || 'N/A'; //
                    finalOpReturnTxidEl.textContent = data.opReturnTxId || 'N/A'; //
                    if (data.opReturnTxId) {
                        // Assuming mainnet for now. Adjust if using testnet.
                        explorerLinkEl.href = `https://mempool.space/tx/${data.opReturnTxId}`; //
                        explorerLinkEl.style.display = 'inline'; //
                    } else {
                        explorerLinkEl.style.display = 'none'; //
                    }
                    finalOpReturnTxHexEl.textContent = data.opReturnTxHex || 'Raw transaction hex not available.'; //

                    clearTimeout(statusIntervalId); //
                } else if (data.status === 'op_return_failed') {
                    statusDisplayEl.textContent = "Error: Failed to create/broadcast OP_RETURN. Please contact support.";
                    if (paymentFlexContainer) paymentFlexContainer.style.display = 'none';
                    processingIndicator.style.display = 'none';
                    clearTimeout(statusIntervalId);
                } else {
                    // For 'pending_payment', 'payment_detected', or other active states
                    const activeStates = ['pending_payment', 'payment_detected'];
                    if (activeStates.includes(data.status)) {
                         clearTimeout(statusIntervalId);
                         statusIntervalId = setTimeout(() => checkStatus(requestId), 10000);
                    } else { // Assume other statuses might be final errors if not explicitly active
                        console.log(`Status (${data.status}) considered final or unhandled for polling. Stopping polling.`);
                        clearTimeout(statusIntervalId);
                    }
                }
            } else if (response.status === 404) {
                statusDisplayEl.textContent = "Request ID not found.";
                if (lookupStatusEl) lookupStatusEl.textContent = `Request ID ${requestId} not found.`;
                clearTimeout(statusIntervalId);
            } else {
                statusDisplayEl.textContent = `Error checking status (${response.status}).`;
                if (lookupStatusEl) lookupStatusEl.textContent = `Error checking status for ${requestId}.`;
                clearTimeout(statusIntervalId);
            }
        } catch (error) {
            statusDisplayEl.textContent = "Network error checking status.";
            if (lookupStatusEl) lookupStatusEl.textContent = "Network error checking status.";
            console.error("Network error fetching status:", error);
            clearTimeout(statusIntervalId);
        }
    }

    function formatStatus(data) {
        let text = `${data.status || 'Unknown'}`;
        if (data.status === 'payment_confirmed') {
            text = `Payment Confirmed! (Payment TX: ${data.paymentTxId || 'N/A'}) Processing OP_RETURN...`;
        } else if (data.status === 'op_return_broadcasted') {
            text = `Message Embedded! (OP_RETURN TX: ${data.opReturnTxId || 'N/A'})`;
        } else if (data.status === 'op_return_failed') {
            text = `Failed to embed message. (Payment TX: ${data.paymentTxId || 'N/A'})`;
        } else if (data.paymentTxId && (data.status === 'pending_payment' || data.status === 'payment_detected')) {
            text = `${data.status} (Payment TX: ${data.paymentTxId})`;
        }
        return text.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }

    function resetToInputState() {
        console.log("Resetting UI to input state.");
        localStorage.removeItem('activeRequestId');
        localStorage.removeItem('activeRequestAddress');
        localStorage.removeItem('activeRequestAmount');

        clearTimeout(statusIntervalId);
        statusIntervalId = null;

        paymentSection.style.display = 'none';
        successSection.style.display = 'none';
        processingIndicator.style.display = 'none';
        if(paymentFlexContainer) paymentFlexContainer.style.display = 'flex'; // Reset for next time
        inputSection.style.display = 'block';

        messageInput.value = '';
        if(statusDisplayEl) statusDisplayEl.textContent = 'Waiting for payment...'; // Default text
        if(qrcodeContainer) qrcodeContainer.innerHTML = '';
        updateByteCounter();

        if(lookupIdInput) lookupIdInput.value = '';
        if(lookupStatusEl) lookupStatusEl.textContent = '';
        
        // Ensure submit button is in its initial state
        submitButton.disabled = false;
        submitButton.textContent = 'Immortalize!';
    }

    // --- Event Listeners ---
    messageInput.addEventListener('input', updateByteCounter);

    submitButton.addEventListener('click', async () => {
        const message = messageInput.value;
        const byteLength = new TextEncoder().encode(message).length;

        if (byteLength === 0) { alert("Please enter a message."); return; }
        if (byteLength > 80) { alert("Message exceeds 80 bytes limit."); return; }

        submitButton.disabled = true;
        submitButton.textContent = 'Processing...';
        if (statusDisplayEl) statusDisplayEl.textContent = 'Requesting payment address...';

        try {
            const response = await fetch(`${API_BASE_URL}/api/message-request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message }),
            });
            const responseData = await response.json();
            if (response.ok && response.status === 201) {
                localStorage.setItem('activeRequestId', responseData.requestId);
                localStorage.setItem('activeRequestAddress', responseData.address);
                localStorage.setItem('activeRequestAmount', responseData.requiredAmountSatoshis);
                showPaymentInfo(responseData);
            } else {
                if (statusDisplayEl) statusDisplayEl.textContent = `Error: ${responseData.error || 'Failed to create request.'}`;
                alert(`Error: ${responseData.error || 'Failed to create request.'}`);
            }
        } catch (error) {
            console.error("Error submitting message request:", error);
            if (statusDisplayEl) statusDisplayEl.textContent = "Error: Could not connect to server.";
            alert("Error: Could not connect to server.");
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = 'Immortalize!';
        }
    });

    if (lookupButton) {
        lookupButton.addEventListener('click', () => {
            const lookupId = lookupIdInput.value.trim();
            if (lookupId) {
                if (lookupStatusEl) lookupStatusEl.textContent = 'Checking...';
                clearTimeout(statusIntervalId);
                checkStatus(lookupId);
            } else {
                if (lookupStatusEl) lookupStatusEl.textContent = 'Please enter a Request ID.';
            }
        });
    }

    if (newRequestButton) newRequestButton.addEventListener('click', resetToInputState);
    if (successNewRequestButton) successNewRequestButton.addEventListener('click', resetToInputState);

    // --- Initial Page Load Logic ---
    function initialize() {
        const savedRequestId = localStorage.getItem('activeRequestId');
        if (savedRequestId) {
            const savedAddress = localStorage.getItem('activeRequestAddress');
            const savedAmount = localStorage.getItem('activeRequestAmount');

            successSection.style.display = 'none';
            processingIndicator.style.display = 'none';

            if (savedAddress && savedAmount) {
                showPaymentInfo({
                    requestId: savedRequestId,
                    address: savedAddress,
                    requiredAmountSatoshis: parseInt(savedAmount, 10)
                });
            } else {
                inputSection.style.display = 'none';
                paymentSection.style.display = 'block';
                if (paymentFlexContainer) paymentFlexContainer.style.display = 'flex';
                if(requestIdEl) requestIdEl.textContent = savedRequestId;
                if(statusDisplayEl) statusDisplayEl.textContent = 'Checking status...';
                checkStatus(savedRequestId);
            }
        } else {
            inputSection.style.display = 'block';
            paymentSection.style.display = 'none';
            successSection.style.display = 'none';
            processingIndicator.style.display = 'none';
        }
        updateByteCounter();
    }

    initialize();

});