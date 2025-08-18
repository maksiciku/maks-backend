app.get('/ordering/live', async (req, res) => {
  try {
    const db = new sqlite3.Database('./database.db');

    db.all(`
      SELECT ingredient, quantity, minimum_level 
      FROM stock 
      WHERE quantity < minimum_level
    `, async (err, lowStockItems) => {
      if (err) {
        console.error("❌ Failed to fetch low stock items:", err.message);
        return res.status(500).json({ error: 'Failed to fetch low stock items.' });
      }

      if (lowStockItems.length === 0) {
        return res.json({ message: "✅ All stock is sufficient.", items: [] });
      }

      const results = [];

      for (const item of lowStockItems) {
        const { ingredient, quantity, minimum_level } = item;

        const supplier = await new Promise((resolve) => {
          db.get(
            `SELECT supplier_name, price FROM supplier_prices 
             WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?)) 
             ORDER BY price ASC LIMIT 1`,
            [ingredient],
            (err, row) => {
              if (err || !row) return resolve(null);
              resolve(row);
            }
          );
        });

        results.push({
          ingredient,
          current_quantity: quantity,
          minimum_level,
          suggested_supplier: supplier?.supplier_name || "No supplier found",
          price_per_unit: supplier?.price || null,
        });
      }

      res.json({ success: true, items: results });
    });

  } catch (err) {
    console.error("❌ Error in /ordering/live:", err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
