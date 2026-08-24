// backend/middleware/uploadConfig.js
const multer = require("multer");
const path = require("path");

// In-memory storage; we pipe to sharp later
const storage = multer.memoryStorage();

// Allow common image mimetypes only
const allowed = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const fileFilter = (_req, file, cb) => {
  if (allowed.has(file.mimetype)) return cb(null, true);
  cb(new Error("Unsupported file type. Allowed: JPG, PNG, WEBP, GIF"));
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter,
});

module.exports = upload;
