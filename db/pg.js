// db/pg.js
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL is not set. Postgres will not connect.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Important for hosted + local TLS setups
  ssl: process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function qAll(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function qGet(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function qRun(sql, params = []) {
  const res = await pool.query(sql, params);
  return { rowCount: res.rowCount };
}

module.exports = { pool, qAll, qGet, qRun };
