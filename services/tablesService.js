// services/tablesService.js
function canonicalTableName(input) {
  if (input === null || input === undefined) return 'Takeaway';
  const s = String(input).trim();
  if (/^delivery$/i.test(s))  return 'Delivery';
  if (/^takeaway$/i.test(s))  return 'Takeaway';
  const m = s.match(/\d+/);
  return m ? `Table ${m[0]}` : s;
}

async function setTableStatusByName(db, name, status, rid) {
  const canon = canonicalTableName(name);
  await db.runAsync(`UPDATE tables SET status = ? WHERE name = ? AND restaurant_id = ?`, [status, canon, rid]);
  await db.runAsync(`UPDATE table_map SET status = ? WHERE name = ? AND restaurant_id = ?`, [status, canon, rid]);
}

async function syncTableCatalog(db) {
  await db.runAsync(`
    INSERT INTO tables (name, seats, status, x, y)
    SELECT tm.name, COALESCE(tm.seats,2), COALESCE(tm.status,'free'), COALESCE(tm.x,0), COALESCE(tm.y,0)
    FROM table_map tm
    LEFT JOIN tables t ON t.name = tm.name AND t.restaurant_id = tm.restaurant_id
    WHERE t.name IS NULL
  `);
  await db.runAsync(`
    INSERT INTO table_map (name, seats, shape, x, y, status, zone)
    SELECT t.name, COALESCE(t.seats,2), 'round', COALESCE(t.x,0), COALESCE(t.y,0), COALESCE(t.status,'free'), COALESCE(t.zone,'Main')
    FROM tables t
    LEFT JOIN table_map tm ON tm.name = t.name AND tm.restaurant_id = t.restaurant_id
    WHERE tm.name IS NULL
  `);
}

module.exports = { canonicalTableName, setTableStatusByName, syncTableCatalog };
