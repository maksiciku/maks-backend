// backend/dbCompat.js
require("dotenv").config();

const DB_DRIVER = String(process.env.DB_DRIVER || "").toLowerCase();

// ✅ Postgres-only build guard (as you requested)
if (!["pg", "postgres", "postgresql"].includes(DB_DRIVER)) {
  throw new Error("DB_DRIVER must be pg/postgres/postgresql (Postgres-only build)");
}

const kind = "pg";

/* =======================
   POSTGRES SETUP
======================= */
let Pool = null;
let pgPool = null;

function initPg() {
  if (pgPool) return pgPool;

  ({ Pool } = require("pg"));

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("Missing DATABASE_URL for Postgres");

  const isLocal =
    DATABASE_URL.includes("127.0.0.1") || DATABASE_URL.includes("localhost");

  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  return pgPool;
}

// ✅ Replace ? -> $1..$n OUTSIDE quotes
function qMarkToDollar(sql) {
  if (!sql || typeof sql !== "string") return sql;

  let out = "";
  let i = 0;
  let idx = 1;
  let inSingle = false;
  let inDouble = false;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === `"` && !inSingle) inDouble = !inDouble;

    if (ch === "?" && !inSingle && !inDouble) {
      out += `$${idx++}`;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function normalizePgSql(sql) {
  let s = String(sql);

  // SQLite BEGIN IMMEDIATE -> PG BEGIN
  s = s.replace(/\bBEGIN\s+IMMEDIATE\b/gi, "BEGIN");

  // SQLite datetime('now') -> NOW()
  s = s.replace(/datetime\(\s*'now'\s*\)/gi, "NOW()");
  s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, "NOW()");

  return s;
}

// ✅ Transaction helper (commercial-safe)
// dbCompat.js

async function withTx(fn) {
  const pool = initPg(); // ✅ FIX: ensure pool is defined

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tx = {
      kind, // ✅ REQUIRED
      qRun: (sql, params = []) => client.query(qMarkToDollar(normalizePgSql(sql)), params),
      qGet: async (sql, params = []) =>
        (await client.query(qMarkToDollar(normalizePgSql(sql)), params)).rows[0] || null,
      qAll: async (sql, params = []) =>
        (await client.query(qMarkToDollar(normalizePgSql(sql)), params)).rows || [],
    };

    const out = await fn(tx);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}



async function pgAll(sql, params = []) {
  const pool = initPg();
  const fixedSql = qMarkToDollar(normalizePgSql(sql));
  const r = await pool.query(fixedSql, params);
  return r.rows || [];
}

async function pgGet(sql, params = []) {
  const rows = await pgAll(sql, params);
  return rows[0] || null;
}

async function pgRun(sql, params = []) {
  const pool = initPg();
  const fixedSql = qMarkToDollar(normalizePgSql(sql));
  const r = await pool.query(fixedSql, params);

  let lastID = undefined;
  if (r?.rows?.length && r.rows[0] && r.rows[0].id != null) {
    lastID = r.rows[0].id;
  }

  return { changes: r.rowCount || 0, lastID };
}

/* =======================
   SQLITE SETUP (kept, but NOT used in Postgres-only build)
======================= */
let sqlite = null;
let sqliteDb = null;

function initSqlite() {
  if (sqliteDb) return sqliteDb;

  const path = require("path");
  sqlite = require("sqlite3").verbose();

  const DB_PATH =
    process.env.SQLITE_PATH ||
    process.env.DB_PATH ||
    path.join(__dirname, "database.db");

  sqliteDb = new sqlite.Database(DB_PATH, (err) => {
    if (err) console.error("❌ SQLite connect error:", err.message);
    else console.log("✅ SQLite connected");
  });

  sqliteDb.DB_PATH = DB_PATH;
  return sqliteDb;
}

function sqliteAll(sql, params = []) {
  const db = initSqlite();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function sqliteGet(sql, params = []) {
  const db = initSqlite();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function sqliteRun(sql, params = []) {
  const db = initSqlite();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function getPool() {
  return initPg();
}

/* =======================
   UNIFIED API
======================= */
async function qAll(sql, params = []) {
  // Postgres-only build: always use PG
  if (kind === "pg") return pgAll(sql, params);
  return sqliteAll(sql, params);
}

async function qGet(sql, params = []) {
  if (kind === "pg") return pgGet(sql, params);
  return sqliteGet(sql, params);
}

async function qRun(sql, params = []) {
  if (kind === "pg") return pgRun(sql, params);
  return sqliteRun(sql, params);
}

/* =======================
   IMPORTANT:
   Ensure PG pool exists at module load so server.js never gets null db/pool
======================= */
initPg();

module.exports = {
  kind,
  qAll,
  qGet,
  qRun,
  withTx,
  getPool,

  // ✅ aliases so old/new code BOTH work
  allAsync: qAll,
  getAsync: qGet,
  runAsync: qRun,

  // ✅ expose db handles for req.db (NOW ALWAYS READY)
  db: initPg(),
  pool: initPg(),

  // kept (even though PG-only)
  DB_PATH: sqliteDb?.DB_PATH,
};
