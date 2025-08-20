// backend/dbSqliteCompat.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const util = require('util');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, 'database.db');
const dbPath = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ SQLite connection error:', err.message);
  } else {
    console.log('🗄️  SQLite connected:', dbPath);
  }
});

// Good idea for SQLite apps
db.run('PRAGMA foreign_keys = ON;');

// -------- Promisified helpers (handy for async/await) --------
db.allAsync = util.promisify(db.all).bind(db);
db.getAsync = util.promisify(db.get).bind(db);
db.runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

// -------- Postgres-like pool.query shim --------
// Node-postgres code usually calls: pool.query(sql, params?, cb)
// We emulate that with SQLite under the hood.
function isSingleRowSelect(sql) {
  const s = String(sql || '').trim();
  if (!/^select\b/i.test(s)) return false;
  if (/\blimit\s+1\b/i.test(s)) return true;
  // Common aggregates (without GROUP BY) usually return one row
  if (/\b(count|sum|min|max|avg)\s*\(/i.test(s) && !/\bgroup\s+by\b/i.test(s)) return true;
  return false;
}

const pool = {
  query(sql, params, cb) {
    // Flexible args: pool.query(sql, cb) or pool.query(sql, params, cb)
    if (typeof params === 'function') {
      cb = params;
      params = [];
    }
    if (!Array.isArray(params)) params = [];

    const firstWord = String(sql).trim().split(/\s+/)[0]?.toUpperCase() || '';

    if (firstWord === 'SELECT' || firstWord === 'PRAGMA') {
      // Decide whether to use get (single row) or all (many rows)
      if (isSingleRowSelect(sql)) {
        return db.get(sql, params, (err, row) => {
          // For compatibility with pg, return an array of rows
          if (cb) cb(err, row ? [row] : []);
        });
      } else {
        return db.all(sql, params, (err, rows) => {
          if (cb) cb(err, rows || []);
        });
      }
    } else {
      // INSERT / UPDATE / DELETE / CREATE / ALTER / etc.
      return db.run(sql, params, function (err) {
        if (cb) cb(err, { lastID: this?.lastID, changes: this?.changes });
      });
    }
  }
};

// (Optional) promise-style pool.query for convenience
pool.queryAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    const firstWord = String(sql).trim().split(/\s+/)[0]?.toUpperCase() || '';
    if (firstWord === 'SELECT' || firstWord === 'PRAGMA') {
      if (isSingleRowSelect(sql)) {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row ? [row] : [])));
      } else {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      }
    } else {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    }
  });

// -------- Exports --------
module.exports = db;       // so existing db.run / db.get / db.all keep working
module.exports.pool = pool; // so your converted pool.query calls work too
