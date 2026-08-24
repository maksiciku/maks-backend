// backend/db/pool.js
const { Pool } = require('pg');

let _pool;

function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // optional:
      // ssl: { rejectUnauthorized: false }
    });
    _pool.on('error', (err) => {
      console.error('Unexpected PG client error', err);
    });
  }
  return _pool;
}

module.exports = { getPool };
