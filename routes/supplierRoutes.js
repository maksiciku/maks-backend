const express = require('express');
const router = express.Router();
const db = require('../dbSqliteCompat');

// GET /suppliers – Fetch all suppliers
router.get('/', (req, res) => {
  pool.query('SELECT * FROM suppliers', [], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching suppliers:', err.message);
      return res.status(500).json({ error: 'Failed to fetch suppliers' });
    }
    res.json(rows);
  });
});

// POST /suppliers – Add a new supplier
router.post('/', (req, res) => {
  const { name, contact } = req.body;

  console.log("📥 New supplier POST:", name, contact);

  if (!name) {
    return res.status(400).json({ error: 'Supplier name is required' });
  }

  const query = `INSERT INTO suppliers (name, contact) VALUES (?, ?)`;
  db.run(query, [name, contact || null], function (err) {
    if (err) {
      console.error('❌ Error inserting supplier:', err.message);
      return res.status(500).json({ error: 'Failed to add supplier', detail: err.message });
    }
    res.status(201).json({ id: this.lastID, name, contact });
  });
});

// DELETE /suppliers/:id – Remove supplier by ID
router.delete('/:id', (req, res) => {
    const supplierId = req.params.id;
  
    const query = 'DELETE FROM suppliers WHERE id = ?';
    db.run(query, [supplierId], function (err) {
      if (err) {
        console.error('❌ Failed to delete supplier:', err.message);
        return res.status(500).json({ error: 'Failed to delete supplier' });
      }
  
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Supplier not found' });
      }
  
      res.json({ success: true, message: '✅ Supplier deleted successfully' });
    });
  });  
  
module.exports = router;
