// backend/src/routes/admin.js
const express = require('express');
const router = express.Router();
const { db } = require('../database'); // Use the destructured db object

// GET all requests (for the admin dashboard)
router.get('/requests', (req, res) => {
    const sql = "SELECT id, status, message, createdAt, address, opReturnTxId, error_log FROM requests ORDER BY createdAt DESC";
    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.json({
            "message": "success",
            "data": rows
        });
    });
});

// GET a single request by ID
router.get('/requests/:id', (req, res) => {
    db.get("SELECT * FROM requests WHERE id = ?", [req.params.id], (err, row) => {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.json({
            "message": "success",
            "data": row
        });
    });
});

// DELETE a request by ID
router.delete('/requests/:id', (req, res) => {
    db.run('DELETE FROM requests WHERE id = ?', req.params.id, function(err) {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.json({ "message": "deleted", changes: this.changes });
    });
});

module.exports = router;