// utils/profileHelpers.js
const path = require('path');
const fs = require('fs');

function safeJoin(base, target) {
  const resolved = path.resolve(base, target);
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error('Path escape detected');
  }
  return resolved;
}

function nullIfEmpty(v) {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : null;
}

async function removeIfLocalUploads(fullPath, uploadsRoot) {
  try {
    const root = path.resolve(uploadsRoot);
    const abs  = path.resolve(fullPath);
    if (abs.startsWith(root) && fs.existsSync(abs)) {
      await fs.promises.unlink(abs);
    }
  } catch (_) {}
}

module.exports = { safeJoin, nullIfEmpty, removeIfLocalUploads };
