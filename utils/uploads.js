// backend/utils/uploads.js
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const uploadsRoot = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });

// Basic uploader (e.g., HEIC conversion, generic uploads)
const baseStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsRoot),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const baseUpload = multer({ storage: baseStorage });

// Tenant-scoped avatar uploader
function ensureTenant(req) {
  const rid = req.tenantRid ?? req.user?.restaurant_id;
  if (rid == null) throw new Error('Missing tenant id for avatar upload');
  return String(rid);
}

const avatarStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const dir = path.join(uploadsRoot, ensureTenant(req));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) { cb(e); }
  },
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname) || '.png';
    const base = (path.basename(file.originalname, ext) || 'avatar')
      .toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 80);
    cb(null, `${base}-${Date.now()}${ext}`);
  }
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp'];
    if (!ok.includes(file.mimetype)) return cb(new Error('Invalid file type'));
    cb(null, true);
  }
});

const menuItemStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const rid = ensureTenant(req);
      const dir = path.join(uploadsRoot, rid, "menu-items");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    const safeBase = path
      .basename(file.originalname || "item", ext)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .slice(0, 60);

    cb(null, `${safeBase}-${Date.now()}${ext}`);
  },
});

const uploadMenuItemImage = multer({
  storage: menuItemStorage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"];
    if (!ok.includes(file.mimetype)) {
      return cb(new Error("Invalid file type. Use PNG, JPG, or WEBP."));
    }
    cb(null, true);
  },
});

module.exports = {
  baseUpload,
  uploadAvatar,
  uploadMenuItemImage,
  uploadsRoot,
};