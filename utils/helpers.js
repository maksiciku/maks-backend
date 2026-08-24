// backend/utils/helpers.js
const fs = require("fs").promises;
const path = require("path");

/**
 * Safely joins two paths to prevent directory traversal.
 * Example: safeJoin('/uploads', '../../etc/passwd') → '/uploads'
 */
function safeJoin(base, target) {
  const targetPath = path.join(base, target);
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(targetPath);
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error("Unsafe file path detected");
  }
  return resolvedTarget;
}

/**
 * Removes a file only if it's inside the uploads directory
 */
async function removeIfLocalUploads(filePath, uploadsRoot) {
  try {
    const resolvedFile = path.resolve(filePath);
    const resolvedRoot = path.resolve(uploadsRoot);

    if (!resolvedFile.startsWith(resolvedRoot)) {
      console.warn(`⚠️ Skipping unsafe file delete: ${resolvedFile}`);
      return false;
    }

    await fs.unlink(resolvedFile);
    console.log(`🧹 Deleted file: ${resolvedFile}`);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.warn(`⚠️ File already removed: ${filePath}`);
      return false;
    }
    console.error("❌ Failed to delete file:", err.message);
    return false;
  }
}

module.exports = {
  safeJoin,
  removeIfLocalUploads,
};
