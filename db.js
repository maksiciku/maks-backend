// backend/db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render requires SSL
});

pool.on('error', (err) => {
  console.error('❌ PG Pool error:', err);
});

module.exports = pool;
