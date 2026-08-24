// routes/tableMapRoutes.js
const express = require("express");
const router = express.Router();

const { qAll, qRun, qGet, kind } = require("../dbCompat");

// ------------------ helpers ------------------
const asNum = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const cleanName = (v) => String(v || "").trim().replace(/\s+/g, " ");

const normalizeShape = (v) => {
  const s = String(v || "").toLowerCase();
  if (["circle", "square", "rectangle"].includes(s)) return s;
  return "square";
};

const normalizeZone = (v) => cleanName(v) || "Main";

// ✅ Traffic light system — keep
const normalizeStatus = (v) => {
  const s = String(v || "").toLowerCase();
  if (["free", "occupied", "occupied_paid"].includes(s)) return s;
  return "free";
};

const ridFromReq = (req) => Number(req.tenantRid || 0);

async function beginTx() {
  if (kind === "pg") return qRun("BEGIN");
  return qRun("BEGIN IMMEDIATE");
}

// ------------------ schema safety ------------------
let READY = false;

async function ensureSchema() {
  if (READY) return;

  // table_map
  if (kind === "pg") {
    await qRun(`
      CREATE TABLE IF NOT EXISTS table_map (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        name TEXT NOT NULL,
        x REAL DEFAULT 0,
        y REAL DEFAULT 0,
        seats INTEGER DEFAULT 2,
        status TEXT DEFAULT 'free',
        zone TEXT DEFAULT 'Main',
        shape TEXT DEFAULT 'square',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await qRun(`CREATE INDEX IF NOT EXISTS idx_table_map_rid ON table_map(restaurant_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_table_map_rid_name ON table_map(restaurant_id, name);`);
  } else {
    await qRun(`
      CREATE TABLE IF NOT EXISTS table_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        x REAL DEFAULT 0,
        y REAL DEFAULT 0,
        seats INTEGER DEFAULT 2,
        status TEXT DEFAULT 'free',
        zone TEXT DEFAULT 'Main',
        shape TEXT DEFAULT 'square'
      );
    `);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_table_map_rid ON table_map(restaurant_id);`);
  }

  // tables (POS source of truth for totals/status/orderability)
  // This keeps your traffic-light system working everywhere.
  if (kind === "pg") {
    await qRun(`
      CREATE TABLE IF NOT EXISTS tables (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        name TEXT NOT NULL,
        seats INTEGER DEFAULT 2,
        status TEXT DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_tables_rid ON tables(restaurant_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_tables_rid_name ON tables(restaurant_id, name);`);
  } else {
    await qRun(`
      CREATE TABLE IF NOT EXISTS tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        seats INTEGER DEFAULT 2,
        status TEXT DEFAULT 'free'
      );
    `);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_tables_rid ON tables(restaurant_id);`);
  }

  READY = true;
}

// ------------------ SYNC helpers ------------------
async function ensureTablesRow({ rid, name, seats, status }) {
  const existing = await qGet(
    `SELECT id FROM tables
     WHERE restaurant_id = ?
       AND LOWER(TRIM(name)) = LOWER(TRIM(?))
     LIMIT 1`,
    [rid, name]
  );

  if (existing?.id) {
    await qRun(
      `UPDATE tables
       SET seats = COALESCE(?, seats),
           status = COALESCE(?, status)
       WHERE restaurant_id = ?
         AND id = ?`,
      [seats, status, rid, existing.id]
    );
    return existing.id;
  }

  // create
  if (kind === "pg") {
    const r = await qRun(
      `INSERT INTO tables (restaurant_id, name, seats, status)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
      [rid, name, seats, status]
    );
    return r?.rows?.[0]?.id ?? null;
  } else {
    const r = await qRun(
      `INSERT INTO tables (restaurant_id, name, seats, status)
       VALUES (?, ?, ?, ?)`,
      [rid, name, seats, status]
    );
    return r?.lastID ?? null;
  }
}

async function renameTablesRow({ rid, oldName, newName }) {
  if (!oldName || !newName) return;

  await qRun(
    `UPDATE tables
     SET name = ?
     WHERE restaurant_id = ?
       AND LOWER(TRIM(name)) = LOWER(TRIM(?))`,
    [newName, rid, oldName]
  );
}

async function deleteTablesRow({ rid, name }) {
  if (!name) return;
  await qRun(
    `DELETE FROM tables
     WHERE restaurant_id = ?
       AND LOWER(TRIM(name)) = LOWER(TRIM(?))`,
    [rid, name]
  );
}

// ------------------ routes ------------------

// GET /table-map
router.get("/", async (req, res) => {
  try {
    await ensureSchema();

    const rid = ridFromReq(req);
    if (!rid) return res.status(401).json({ error: "No tenant" });

    const rows = await qAll(
      `SELECT
         id, name, x, y,
         COALESCE(seats, 2)        AS seats,
         COALESCE(status, 'free')  AS status,
         COALESCE(zone, 'Main')    AS zone,
         COALESCE(shape, 'square') AS shape
       FROM table_map
       WHERE restaurant_id = ?
       ORDER BY id ASC`,
      [rid]
    );

    res.json(rows || []);
  } catch (err) {
    console.error("❌ GET /table-map failed:", err?.message || err, err);
    res.status(500).json({ error: "Failed to load table map" });
  }
});

// POST /table-map
// - If body.tables exists => bulk replace layout
// - Else => single create
router.post("/", async (req, res) => {
  await ensureSchema();

  const rid = ridFromReq(req);
  if (!rid) return res.status(401).json({ error: "No tenant" });

  const body = req.body || {};

  const tables = Array.isArray(body.tables)
    ? body.tables
    : Array.isArray(body.map)
      ? body.map
      : Array.isArray(body.tableMap)
        ? body.tableMap
        : null;

  try {
    // ✅ BULK replace mode
    if (tables) {
      await beginTx();

      // wipe old map
      await qRun(`DELETE FROM table_map WHERE restaurant_id = ?`, [rid]);

      // We also sync "tables" so newly placed tables are orderable
      // Strategy: Upsert each table by name; do NOT delete all tables (safe).
      for (const t of tables) {
        if (!t) continue;
        const name = cleanName(t.name);
        if (!name) continue;

        const x = asNum(t.x, 0);
        const y = asNum(t.y, 0);
        const seats = Math.max(1, asNum(t.seats, 2));
        const status = normalizeStatus(t.status);
        const zone = normalizeZone(t.zone);
        const shape = normalizeShape(t.shape);

        await qRun(
          `INSERT INTO table_map (restaurant_id, name, x, y, seats, status, zone, shape)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [rid, name, x, y, seats, status, zone, shape]
        );

        await ensureTablesRow({ rid, name, seats, status });
      }

      await qRun("COMMIT");
      return res.json({ success: true, count: tables.length });
    }

    // ✅ SINGLE create mode
    const name = cleanName(body.name);
    if (!name) return res.status(400).json({ error: "name is required" });

    const x = asNum(body.x, 100);
    const y = asNum(body.y, 100);
    const seats = Math.max(1, asNum(body.seats, 2));
    const status = normalizeStatus(body.status);
    const zone = normalizeZone(body.zone);
    const shape = normalizeShape(body.shape);

    await beginTx();

    let id = null;

    if (kind === "pg") {
      const r = await qRun(
        `INSERT INTO table_map (restaurant_id, name, x, y, seats, status, zone, shape)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [rid, name, x, y, seats, status, zone, shape]
      );
      id = r?.rows?.[0]?.id ?? null;
    } else {
      const r = await qRun(
        `INSERT INTO table_map (restaurant_id, name, x, y, seats, status, zone, shape)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [rid, name, x, y, seats, status, zone, shape]
      );
      id = r?.lastID ?? null;
    }

    // ✅ CRITICAL: make it orderable in POS immediately
    await ensureTablesRow({ rid, name, seats, status });

    await qRun("COMMIT");

    return res.json({
      success: true,
      id,
      table: { id, name, x, y, seats, status, zone, shape },
    });
  } catch (err) {
    try { await qRun("ROLLBACK"); } catch {}
    console.error("❌ POST /table-map failed:", err?.message || err, err);
    res.status(500).json({ error: "Failed to save table map", detail: String(err?.message || err) });
  }
});

// PUT /table-map/:id
router.put("/:id", async (req, res) => {
  await ensureSchema();

  const rid = ridFromReq(req);
  if (!rid) return res.status(401).json({ error: "No tenant" });

  const id = asNum(req.params.id, NaN);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const body = req.body || {};
  const name = cleanName(body.name);
  if (!name) return res.status(400).json({ error: "name is required" });

  const x = asNum(body.x, 0);
  const y = asNum(body.y, 0);
  const seats = Math.max(1, asNum(body.seats, 2));
  const status = normalizeStatus(body.status);
  const zone = normalizeZone(body.zone);
  const shape = normalizeShape(body.shape);

  try {
    await beginTx();

    // get old name to support rename safely
    const old = await qGet(
      `SELECT name FROM table_map WHERE id = ? AND restaurant_id = ? LIMIT 1`,
      [id, rid]
    );
    const oldName = cleanName(old?.name);

    const r = await qRun(
      `UPDATE table_map
       SET name = ?, x = ?, y = ?, seats = ?, status = ?, zone = ?, shape = ?
       WHERE id = ? AND restaurant_id = ?`,
      [name, x, y, seats, status, zone, shape, id, rid]
    );

    // ✅ if name changed, rename in tables too
    if (oldName && oldName.toLowerCase() !== name.toLowerCase()) {
      await renameTablesRow({ rid, oldName, newName: name });
    }

    // ✅ keep tables synced (traffic lights + seats)
    await ensureTablesRow({ rid, name, seats, status });

    await qRun("COMMIT");

    const changes = Number(r?.rowCount ?? r?.changes ?? 0);
    res.json({ success: true, changes });
  } catch (err) {
    try { await qRun("ROLLBACK"); } catch {}
    console.error("❌ PUT /table-map/:id failed:", err?.message || err, err);
    res.status(500).json({ error: "Failed to update table", detail: String(err?.message || err) });
  }
});

// DELETE /table-map/:id
router.delete("/:id", async (req, res) => {
  await ensureSchema();

  const rid = ridFromReq(req);
  if (!rid) return res.status(401).json({ error: "No tenant" });

  const id = asNum(req.params.id, NaN);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    await beginTx();

    // fetch name first so we can delete from tables
    const row = await qGet(
      `SELECT name FROM table_map WHERE id = ? AND restaurant_id = ? LIMIT 1`,
      [id, rid]
    );
    const name = cleanName(row?.name);

    const r = await qRun(
      `DELETE FROM table_map WHERE id = ? AND restaurant_id = ?`,
      [id, rid]
    );

    // ✅ delete from tables too (prevents ghosts)
    if (name) await deleteTablesRow({ rid, name });

    await qRun("COMMIT");

    const removed = Number(r?.rowCount ?? r?.changes ?? 0);
    res.json({ success: true, removed });
  } catch (err) {
    try { await qRun("ROLLBACK"); } catch {}
    console.error("❌ DELETE /table-map/:id failed:", err?.message || err, err);
    res.status(500).json({ error: "Failed to delete table", detail: String(err?.message || err) });
  }
});

module.exports = router;
