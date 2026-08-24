// backend/db.js
// Single DB entrypoint (SOURCE OF TRUTH)
// Everything should import from "../db" and it will work.
// Internally we use dbCompat so you don't have to rewrite imports.

module.exports = require("./dbCompat");
