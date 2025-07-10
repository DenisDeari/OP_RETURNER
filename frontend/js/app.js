// frontend/js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements from your index.html ---
    const steps = {
        compose: document.getElementById('compose-step'),
        sealing: document.getElementById('sealing-step'),
        payment: document.getElementById('payment-step'),
        success: document.getElementById('success-step'),
    };
    const messageInput = document.getElementById('message-input');
    const byteCounterSpan = document.getElementById('byte-counter-span');
    const progressBar = document.getElementById('progress-bar');
    const sealMessageBtn = document.getElementById('seal-message-button');
    const finalMessageReview = document.getElementById('final-message-review');
    const editMessageBtn = document.getElementById('edit-message-button');
    const confirmSealBtn = document.getElementById('confirm-seal-button');
    const capsuleIdDisplay = document.getElementById('capsule-id-display');
    const qrCodeContainer = document.getElementById('qrcode');
    const paymentAddressDiv = document.getElementById('payment-address');
    const requiredAmountSpan = document.getElementById('required-amount');
    const paymentStatusDisplay = document.getElementById('payment-status-display');
    const startOverBtn = document.getElementById('start-over-button');
    const finalTxIdSpan = document.getElementById('final-tx-id');
    const explorerLink = document.getElementById('explorer-link');
    const createNewMessageBtn = document.getElementById('create-new-message-button');
    const lookupLink = document.querySelector('footer > a'); // The "Look Up" link

    const MAX_BYTES = 80;
    let pollingInterval;
    let qrCodeInstance = null; // To hold the QRCode object

    // --- Core Functions ---

    function showStep(stepName) {
        Object.values(steps).forEach(step => step.classList.remove('active'));
        if (steps[stepName]) {
            steps[stepName].classList.add('active');
        }
    }

    async function fetchRequestStatus(id) {
        try {
            // This endpoint matches the one we created in api.js
            const response = await fetch(`/api/request/${id}`);
            if (!response.ok) {
                if (response.status === 404) {
                    clearActiveRequest();
                    showStep('compose');
                }
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error('Error fetching status:', error);
            return null;
        }
    }
    
    function updateUiForRequest(requestData) {
        if (!requestData) {
            showStep('compose');
            return;
        }

        const { id, status, address, amount, tx_id } = requestData;
        if (pollingInterval) clearInterval(pollingInterval);

        if (status === 'pending_payment') {
            capsuleIdDisplay.textContent = id;
            paymentAddressDiv.textContent = address;
            const amountBtc = amount / 100000000;
            requiredAmountSpan.textContent = amountBtc.toFixed(8);
            
            qrCodeContainer.innerHTML = '';
            qrCodeInstance = new QRCode(qrCodeContainer, {
                text: `bitcoin:${address}?amount=${amountBtc}`,
                width: 200,
                height: 200,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.H
            });

            paymentStatusDisplay.textContent = 'Waiting for payment...';
            showStep('payment');
            startPolling(id);

        } else if (status === 'paid' || status === 'broadcasted' || status === 'op_return_broadcasted') { // Handles multiple success statuses
            finalTxIdSpan.textContent = tx_id || 'Broadcast in progress...';
            explorerLink.href = tx_id ? `https://mempool.space/tx/${tx_id}` : '#';
            showStep('success');
            clearActiveRequest();
        } else {
            clearActiveRequest();
            showStep('compose');
        }
    }

    function startPolling(id) {
        pollingInterval = setInterval(async () => {
            console.log(`Polling for status of request ${id}...`);
            const requestData = await fetchRequestStatus(id);
            if (requestData && requestData.status !== 'pending_payment') {
                clearInterval(pollingInterval);
                updateUiForRequest(requestData);
            }
        }, 10000); 
    }

    function clearActiveRequest() {
        localStorage.removeItem('activeRequestId');
        if (pollingInterval) clearInterval(pollingInterval);
    }

    // --- Event Listeners ---

    messageInput.addEventListener('input', () => {
        const byteLength = new TextEncoder().encode(messageInput.value).length;
        byteCounterSpan.textContent = `${byteLength} / ${MAX_BYTES} bytes`;
        const progress = Math.min((byteLength / MAX_BYTES) * 100, 100);
        progressBar.style.width = `${progress}%`;

        if (byteLength > MAX_BYTES) {
            sealMessageBtn.disabled = true;
        } else {
            sealMessageBtn.disabled = false;
        }
    });

    sealMessageBtn.addEventListener('click', () => {
        finalMessageReview.textContent = messageInput.value;
        showStep('sealing');
    });

    editMessageBtn.addEventListener('click', () => showStep('compose'));

    confirmSealBtn.addEventListener('click', async () => {
        confirmSealBtn.disabled = true;
        confirmSealBtn.textContent = 'Sealing...';
        try {
            // This endpoint matches the one we created in api.js
            const response = await fetch('/api/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: messageInput.value }),
            });
            const data = await response.json();
            if (response.ok) {
                localStorage.setItem('activeRequestId', data.id);
                updateUiForRequest(data);
            } else {
                alert(`Error: ${data.error}`);
            }
        } catch (error) {
            alert(`Network error: ${error.message}`);
        } finally {
            confirmSealBtn.disabled = false;
            confirmSealBtn.textContent = 'Confirm & Immortalize!';
        }
    });
    
    startOverBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to cancel this payment and start over?')) {
            clearActiveRequest();
            window.location.reload();
        }
    });

    createNewMessageBtn.addEventListener('click', () => {
        clearActiveRequest();
        window.location.reload();
    });

    lookupLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = prompt('Please enter your Capsule ID:');
        if (id && id.trim()) {
            const requestData = await fetchRequestStatus(id.trim());
            if (requestData) {
                localStorage.setItem('activeRequestId', requestData.id);
                updateUiForRequest(requestData);
            } else {
                alert('Could not find a request with that ID.');
            }
        }
    });

    // --- Initial Page Load Logic ---
    async function initializeApp() {
        const activeRequestId = localStorage.getItem('activeRequestId');
        if (activeRequestId) {
            console.log(`Found active request ID: ${activeRequestId}. Fetching status...`);
            const requestData = await fetchRequestStatus(activeRequestId);
            if (requestData) {
                updateUiForRequest(requestData);
            } else {
                clearActiveRequest();
                showStep('compose');
            }
        } else {
            showStep('compose');
        }
    }

    initializeApp();
});