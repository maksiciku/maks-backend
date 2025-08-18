const express = require('express');
const router = express.Router();
const db = require('../dbSqliteCompat');

// ✅ GET /drinks/suppliers — Get all suppliers
router.get('/suppliers', (req, res) => {
  pool.query('SELECT * FROM suppliers', [], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching suppliers:', err.message);
      return res.status(500).json({ error: 'Failed to fetch suppliers' });
    }
    res.json(rows);
  });
});

// ✅ GET /drinks/restock-orders — Get all restock orders for drinks
router.get('/restock-orders', (req, res) => {
  const query = `
    SELECT * FROM restock_orders
    WHERE type = 'drink'
    ORDER BY created_at DESC
  `;
  pool.query(query, [], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching restock orders:', err.message);
      return res.status(500).json({ error: 'Failed to fetch restock orders' });
    }
    res.json(rows);
  });
});

// ✅ GET /drinks/sales-analytics — Dummy stats for now
router.get('/sales-analytics', (req, res) => {
  const query = `
    SELECT ingredient, SUM(quantity_sold) as total_sold
    FROM sales
    WHERE type = 'drink'
    GROUP BY ingredient
    ORDER BY total_sold DESC
  `;
  pool.query(query, [], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching sales analytics:', err.message);
      return res.status(500).json({ error: 'Failed to fetch sales analytics' });
    }
    res.json(rows);
  });
});

module.exports = router;
