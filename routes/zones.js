// routes/zones.js
const express = require('express');
const router = express.Router();

const { allAsync: qAll } = require('../db');

// GET /zones -> list of distinct zones from table_map
router.get('/', async (req, res) => {
  try {
    const rid = req.tenantRid;
    const rows = await qAll(
      `SELECT DISTINCT COALESCE(zone, 'Main') AS zone
         FROM table_map
        WHERE restaurant_id = ?
        ORDER BY zone ASC`,
      [rid]
    );

    const zones = Array.isArray(rows) ? rows.map(r => r.zone) : [];
    res.json(zones);
  } catch (err) {
    console.error('❌ GET /zones failed:', err);
    res.status(500).json({ error: 'Failed to fetch zones' });
  }
});

module.exports = router;
