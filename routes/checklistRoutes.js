module.exports = (app, ctx) => {
  const { db, pool, authenticateToken } = ctx;

  app.post('/checklists', authenticateToken, (req, res) => {
  const { name } = req.body;
  const createdBy = req.user.id;
  if (!name) return res.status(400).json({ error: "Checklist name is required" });

  const query = `INSERT INTO checklists (name, created_by, restaurant_id) VALUES (?, ?, ?)`;
  db.run(query, [name, createdBy, req.tenantRid], function (err) {
    if (err) {
      console.error("❌ Error creating checklist:", err.message);
      return res.status(500).json({ error: "Failed to create checklist" });
    }
    res.status(201).json({ id: this.lastID, message: "Checklist created" });
  });
}); 
  
  app.get('/checklists', authenticateToken, (req, res) => {
    const query = `SELECT * FROM checklists WHERE restaurant_id = ? ORDER BY id DESC`;
  
    pool.query(query, [req.tenantRid], (err, rows) => {
      if (err) {
        console.error("❌ Error fetching checklists:", err.message);
        return res.status(500).json({ error: "Failed to fetch checklists" });
      }
  
      res.status(200).json(rows);
    });
  });   
  
  app.post('/checklists/:id/items', authenticateToken, (req, res) => {
    const checklistId = req.params.id;
    const { description } = req.body;
  
    if (!description) {
      return res.status(400).json({ error: "Task description is required" });
    }
  
    const query = `INSERT INTO checklist_items (checklist_id, description, restaurant_id) VALUES (?, ?, ?)`;
    db.run(query, [checklistId, description, req.tenantRid], function (err) {
      if (err) {
        console.error("❌ Error adding task:", err.message);
        return res.status(500).json({ error: "Failed to add task" });
      }
  
      res.status(201).json({ id: this.lastID, message: "Task added" });
    });
  });

  app.get('/checklists/:id/items', authenticateToken, (req, res) => {
    const checklistId = req.params.id;
  
    const query = `SELECT * FROM checklist_items WHERE checklist_id = ? AND restaurant_id = ? ORDER BY id ASC`;
    pool.query(query, [checklistId, req.tenantRid], (err, rows) => {
      if (err) {
        console.error("❌ Error fetching tasks:", err.message);
        return res.status(500).json({ error: "Failed to fetch tasks" });
      }
  
      res.status(200).json(rows);
    });
  });

  app.put('/checklists/items/:itemId/complete', authenticateToken, (req, res) => {
    const itemId = req.params.itemId;
    const completedBy = req.user.id;
  
    const query = `
      UPDATE checklist_items
      SET completed = 1,
          completed_by = ?,
          completed_at = datetime('now')
      WHERE id = ? AND restaurant_id=?
    `;
  
    db.run(query, [completedBy, itemId, req.tenantRid,], function (err) {
      if (err) {
        console.error("❌ Error completing task:", err.message);
        return res.status(500).json({ error: "Failed to complete task" });
      }
  
      if (this.changes === 0) {
        return res.status(404).json({ error: "Task not found" });
      }
  
      res.status(200).json({ message: "Task marked as completed" });
    });
  });

  // Delete checklist folder
app.delete('/checklists/:id', authenticateToken, (req, res) => {
    const checklistId = req.params.id;
  
    const deleteItems = `DELETE FROM checklist_items WHERE checklist_id = ?`;
    const deleteFolder = `DELETE FROM checklists WHERE id = ?`;
  
    db.run(deleteItems, [checklistId], (err) => {
      if (err) {
        console.error("❌ Error deleting checklist items:", err.message);
        return res.status(500).json({ error: "Failed to delete checklist items" });
      }
  
      db.run(deleteFolder, [checklistId], (err2) => {
        if (err2) {
          console.error("❌ Error deleting checklist:", err2.message);
          return res.status(500).json({ error: "Failed to delete checklist" });
        }
  
        res.status(200).json({ message: "Checklist deleted successfully" });
      });
    });
  });
  
app.post('/appliances', authenticateToken, (req, res) => {
  const { type, name, storage_number, supplier, notes } = req.body;
  db.run(
    `INSERT INTO appliances (type, name, storage_number, supplier, notes, created_by, restaurant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [type, name, storage_number, supplier, notes, req.user.id, req.tenantRid],
    function (err){ 
        if (err) {
          console.error('Error inserting appliance:', err.message);
          return res.status(500).json({ error: 'Database error.' });
        }
        res.json({ id: this.lastID });
      }
    );
  });    
  
app.get('/appliances', authenticateToken, (req, res) => {
  pool.query(`SELECT * FROM appliances WHERE restaurant_id = ?`, [req.tenantRid], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});
  
app.post('/appliance-checks', authenticateToken, (req, res) => {
  const { appliance_id, temperature, shift, staff_name } = req.body;
  const time_recorded = new Date().toISOString();
  db.run(
    `INSERT INTO appliance_checks (appliance_id, temperature, shift, time_recorded, staff_name, restaurant_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [appliance_id, temperature, shift, time_recorded, staff_name, req.tenantRid],
    function (err){ 
    if (err) {
      console.error('❌ Insert failed:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ id: this.lastID });
  });
});
  
app.get('/appliance-checks', authenticateToken, (req, res) => {
  pool.query(
    `SELECT ac.*, a.name AS appliance_name
       FROM appliance_checks ac
       LEFT JOIN appliances a
         ON ac.appliance_id = a.id
        AND a.restaurant_id = ac.restaurant_id
      WHERE ac.restaurant_id = ?
      ORDER BY time_recorded DESC`,
    [req.tenantRid],
    (err, rows) => {
    if (err) {
      console.error('❌ Failed to fetch appliance checks:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
}); 

};
