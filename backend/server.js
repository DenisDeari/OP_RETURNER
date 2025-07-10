// backend/server.js
const express = require('express');
const path = require('path');
const config = require('./src/config');
const db = require('./src/database'); // Corrected: Only import 'db'
const { initializeWallet } = require('./src/wallet');
const requestQueue = require('./src/queue');
const { cleanupOldRequests } = require('./src/cleanup');

// Route imports
const createApiRouter = require('./src/routes/api');
const createWebhookRouter = require('./src/routes/webhook');
const adminRoutes = require('./src/routes/admin');

// --- Initialization ---
const rootNode = initializeWallet();
const app = express();

// --- Middleware ---
app.use(express.json());

// --- API Routes ---
// Group all API routes together for clarity
const apiRouter = createApiRouter(db, rootNode, config, requestQueue);
const webhookRouter = createWebhookRouter(db, rootNode, config);

app.use('/api', apiRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/admin', adminRoutes); // Admin routes will be under /api/admin/*

// --- Frontend & Root Route ---
// Serve static files first
app.use(express.static(path.join(__dirname, '../frontend')));
// Then, for any other GET request, send the index.html to support client-side routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// --- Start Server ---
app.listen(config.PORT, () => {
    console.log(`Server listening on port ${config.PORT}`);
    console.log(`View App: http://localhost:${config.PORT}/`);
    console.log(`Admin API available at: http://localhost:${config.PORT}/api/admin/`);
});

// --- Scheduled Jobs ---
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
cleanupOldRequests(db); // Run once on startup
setInterval(() => cleanupOldRequests(db), CLEANUP_INTERVAL_MS);
console.log(`[Server] Cleanup job scheduled to run every ${CLEANUP_INTERVAL_MS / (1000 * 60 * 60)} hours.`);