// posRoutes.js
const express = require('express');
const router = express.Router();
const { deductStockFromMealOrder } = require('../utils/novaDeduct');
const db = require('../dbSqliteCompat');

// ✅ Ensure POS Orders table exists
const initializePOSOrdersTable = () => {
  const query = `
    CREATE TABLE IF NOT EXISTS pos_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number TEXT NOT NULL,
      meal_id INTEGER NOT NULL,
      meal_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      total_price REAL NOT NULL,
      order_status TEXT DEFAULT 'Pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;
  db.run(query, (err) => {
    if (err) console.error('❌ Error creating POS orders table:', err.message);
    else console.log('✅ POS Orders table is ready.');
  });
};
initializePOSOrdersTable();

// ✅ Create POS order and deduct ingredients
router.post('/', async (req, res) => {
  const { table_number, items = [] } = req.body;

  if (!table_number || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Table number and at least one item required.' });
  }

  try {
    for (const item of items) {
      const { type, id, name, quantity, total_price } = item;

      if (!type || !id || !name || !quantity || total_price === undefined) {
        console.warn('⚠️ Skipping item with missing fields:', item);
        continue;
      }

      // Insert to POS table
      const insertQuery = `
        INSERT INTO pos_orders (table_number, meal_id, meal_name, quantity, total_price)
        VALUES (?, ?, ?, ?, ?)
      `;
      await new Promise((resolve, reject) => {
        db.run(insertQuery, [table_number, id, name, quantity, total_price], function (err) {
          if (err) reject(err);
          else resolve();
        });
      });

      // Deduct stock by type
      if (type === 'meal') {
        await deductStockFromMealOrder(id, quantity); // meals via nova
      } else {
        db.get(
          `SELECT quantity FROM stock WHERE LOWER(ingredient) = LOWER(?)`,
          [name.toLowerCase()],
          (err, stockItem) => {
            if (err || !stockItem) {
              console.warn(`⚠️ Stock not found for ${type}: ${name}`);
              return;
            }

            const updatedQty = stockItem.quantity - quantity;
            db.run(
              `UPDATE stock SET quantity = ? WHERE LOWER(ingredient) = LOWER(?)`,
              [updatedQty, name.toLowerCase()],
              (err) => {
                if (err) {
                  console.error(`❌ Error updating stock for ${type}: ${name}`, err.message);
                } else {
                  console.log(`✅ Stock updated for ${type}: ${name} -${quantity}`);
                }
              }
            );
          }
        );
      }
    }

    return res.status(201).json({ success: true, message: '✅ POS order processed and stock updated.' });

  } catch (error) {
    console.error('❌ POS error:', error.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ✅ Get all POS orders
router.get('/', (req, res) => {
  const { status } = req.query;

  let query = `SELECT * FROM pos_orders`;
  const params = [];

  if (status) {
    query += ` WHERE order_status = ?`;
    params.push(status);
  }

  pool.query(query, params, (err, rows) => {
    if (err) {
      console.error("❌ Error fetching POS orders:", err.message);
      return res.status(500).json({ error: "Error fetching POS orders." });
    }

    res.status(200).json(rows);
  });
});

// ✅ Update POS order status
router.put('/:id/status', (req, res) => {
  const { id } = req.params;
  const { order_status } = req.body;

  if (!order_status) {
    return res.status(400).json({ error: 'Order status is required.' });
  }

  const query = `UPDATE pos_orders SET order_status = ? WHERE id = ?`;
  db.run(query, [order_status, id], function (err) {
    if (err) {
      console.error('❌ Error updating POS order status:', err.message);
      return res.status(500).json({ error: 'Error updating order status.' });
    }
    res.status(200).json({ message: 'Order status updated successfully.' });
  });
});

router.post('/close', (req, res) => {
  const { table_number } = req.body;

  if (!table_number) {
    return res.status(400).json({ error: 'Table number is required.' });
  }

  const query = `DELETE FROM pos_orders WHERE table_number = ?`;

  db.run(query, [table_number], function (err) {
    if (err) {
      console.error("❌ Error deleting POS table orders:", err.message);
      return res.status(500).json({ error: "Failed to delete POS orders." });
    }

    res.status(200).json({ message: `✅ All POS orders for table ${table_number} deleted.` });
  });
});

// 🔍 Get orders by table number
router.get('/table/:tableNumber', (req, res) => {
  const { tableNumber } = req.params;
  const query = `SELECT * FROM pos_orders WHERE table_number = ?`;

  pool.query(query, [tableNumber], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching table orders:", err.message);
      return res.status(500).json({ error: "Error fetching table orders." });
    }

    res.status(200).json(rows);
  });
});

router.put('/transfer-table', async (req, res) => {
  const { oldTable, newTable } = req.body;

  try {
    const result = await db.run(
      `UPDATE orders SET table_number = ? WHERE table_number = ? AND paid = 0`,
      [newTable, oldTable]
    );

    console.log(`✅ Transferred from ${oldTable} to ${newTable}`);
    res.json({ success: true, changes: result.changes });
  } catch (err) {
    console.error("❌ Transfer failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
