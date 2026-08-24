// routes/userRoutes.js
const express = require("express");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const multer = require("multer");


let sharp = null;
try {
  sharp = require("sharp");
} catch (e) {
  console.warn("⚠️ sharp not available - avatar processing disabled:", e.message);
}

const { qGet, qRun } = require("../dbCompat");
const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");
const avatarUpload = require("../middleware/uploadConfig");

const { profileUpdateSchema, passwordChangeSchema } = require("../utils/validationSchemas");
const { safeJoin, removeIfLocalUploads } = require("../utils/helpers");
const { uploadsDir, uploadsRoot } = require("../utils/constants");

const router = express.Router();

const ridOf = (req) => Number(req.tenantRid || req.user?.restaurant_id || 0);

function safeJsonArray(v) {
  try {
    if (Array.isArray(v)) return v;
    const x = JSON.parse(v || "[]");
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

// Ensure /backend/uploads exists
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
    const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
    cb(null, `avatar_${req.user.id}_${Date.now()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only PNG/JPG/WEBP allowed"), ok);
  },
});

// --------------------
// GET /users/me
// --------------------
router.get("/me", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);

    const u = await qGet(
      `
      SELECT
        u.id,
        u.username,
        rm.role AS role,
        u.full_name,
        u.address,
        u.avatar_url,
        u.membership_tier,
        rm.restaurant_id,
        u.created_at,
        rm.permissions AS permissions
      FROM public.restaurant_members rm
      JOIN public.users u ON u.id = rm.user_id
      WHERE rm.user_id = $1
        AND rm.restaurant_id = $2
        AND rm.is_active = TRUE
      LIMIT 1
      `,
      [req.user.id, rid]
    );

    if (!u) return res.status(404).json({ error: "User not found" });

    return res.json({
      ...u,
      permissions: safeJsonArray(u.permissions),
    });
  } catch (e) {
    console.error("GET /users/me failed:", e);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

// --------------------
// PUT /users/me
// --------------------
router.put("/me", authenticateToken, loadMembership, async (req, res) => {
  const { error, value } = profileUpdateSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      error: "Invalid input",
      details: error.details.map((d) => d.message),
    });
  }

  try {
    const rid = ridOf(req);

    const sets = [];
    const vals = [];
    let i = 1;

    if (value.full_name !== undefined) {
      sets.push(`full_name = $${i++}`);
      vals.push(value.full_name ? String(value.full_name).trim() : null);
    }
    if (value.address !== undefined) {
      sets.push(`address = $${i++}`);
      vals.push(value.address ? String(value.address).trim() : null);
    }

    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    // where clause
    vals.push(req.user.id);
    const uidIdx = i++;
    vals.push(rid);
    const ridIdx = i++;

    const r = await qRun(
  `UPDATE public.users
   SET ${sets.join(", ")}
   WHERE id = $${uidIdx}
     AND EXISTS (
       SELECT 1
       FROM public.restaurant_members rm
       WHERE rm.user_id = public.users.id
         AND rm.restaurant_id = $${ridIdx}
         AND rm.is_active = TRUE
     )`,
  vals
);

    // pg qRun may return rowCount depending on your wrapper
    const changed = r?.rowCount ?? r?.changes ?? 0;
    if (!changed) return res.status(404).json({ error: "User not found" });

    return res.json({ success: true });
  } catch (e) {
    console.error("PUT /users/me failed:", e);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

// --------------------
// PUT /users/me/password
// --------------------
router.put("/me/password", authenticateToken, loadMembership, async (req, res) => {
  const { error, value } = passwordChangeSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      error: "Invalid input",
      details: error.details.map((d) => d.message),
    });
  }

  try {
    const rid = ridOf(req);

    const u = await qGet(
  `
  SELECT u.password, u.password_hash
  FROM public.users u
  JOIN public.restaurant_members rm ON rm.user_id = u.id
  WHERE u.id = $1
    AND rm.restaurant_id = $2
    AND rm.is_active = TRUE
  LIMIT 1
  `,
  [req.user.id, rid]
);

    if (!u) return res.status(404).json({ error: "User not found" });

const hash = u.password_hash || u.password;
const ok = bcrypt.compareSync(value.current_password, hash);    if (!ok) return res.status(401).json({ error: "Current password incorrect" });

    const hashed = bcrypt.hashSync(value.new_password, 10);

    await qRun(
  `
  UPDATE public.users
  SET password = $1,
      password_hash = $1
  WHERE id = $2
    AND EXISTS (
      SELECT 1
      FROM public.restaurant_members rm
      WHERE rm.user_id = public.users.id
        AND rm.restaurant_id = $3
        AND rm.is_active = TRUE
    )
  `,
  [hashed, req.user.id, rid]
);

    return res.json({ success: true });
  } catch (e) {
    console.error("PUT /users/me/password failed:", e);
    return res.status(500).json({ error: "Failed to change password" });
  }
});

// --------------------
// POST /users/me/avatar
// --------------------
// --------------------
// POST /users/me/avatar
// --------------------
router.post(
  "/me/avatar",
  authenticateToken,
  loadMembership,
  upload.single("avatar"),
  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({ error: "No restaurant selected (rid missing)" });
      }

      if (!req.file?.filename) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const avatarUrl = `/uploads/${req.file.filename}`;

      const r = await qRun(
        `
        UPDATE public.users
        SET avatar_url = $1
        WHERE id = $2
          AND EXISTS (
            SELECT 1
            FROM public.restaurant_members rm
            WHERE rm.user_id = public.users.id
              AND rm.restaurant_id = $3
              AND rm.is_active = TRUE
          )
        `,
        [avatarUrl, req.user.id, rid]
      );

      const changed = r?.rowCount ?? r?.changes ?? 0;
      if (!changed) return res.status(404).json({ error: "User not found" });

      return res.json({ success: true, avatar_url: avatarUrl });
    } catch (e) {
      console.error("POST /users/me/avatar failed:", e);
      return res.status(500).json({ error: "Failed to upload avatar" });
    }
  }
);

router.delete("/me/avatar", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);

    const prev = await qGet(
      `
      SELECT u.avatar_url
      FROM public.users u
      JOIN public.restaurant_members rm ON rm.user_id = u.id
      WHERE u.id = $1
        AND rm.restaurant_id = $2
        AND rm.is_active = TRUE
      LIMIT 1
      `,
      [req.user.id, rid]
    );

    const r = await qRun(
      `
      UPDATE public.users
      SET avatar_url = NULL
      WHERE id = $1
        AND EXISTS (
          SELECT 1
          FROM public.restaurant_members rm
          WHERE rm.user_id = public.users.id
            AND rm.restaurant_id = $2
            AND rm.is_active = TRUE
        )
      `,
      [req.user.id, rid]
    );

    const changed = r?.rowCount ?? r?.changes ?? 0;
    if (!changed) return res.status(404).json({ error: "User not found" });

    if (prev?.avatar_url?.includes("/uploads/")) {
      const rel = prev.avatar_url.split("/uploads/")[1];

      if (rel) {
        const abs = safeJoin(UPLOAD_DIR, rel);
        await removeIfLocalUploads(abs, UPLOAD_DIR);
      }
    }

    const user = await qGet(
      `
      SELECT
        u.id,
        u.username,
        rm.role AS role,
        u.full_name,
        u.address,
        u.avatar_url,
        u.membership_tier,
        rm.restaurant_id,
        rm.permissions AS permissions
      FROM public.restaurant_members rm
      JOIN public.users u ON u.id = rm.user_id
      WHERE rm.user_id = $1
        AND rm.restaurant_id = $2
        AND rm.is_active = TRUE
      LIMIT 1
      `,
      [req.user.id, rid]
    );

    return res.json({
      success: true,
      user: {
        ...user,
        permissions: safeJsonArray(user?.permissions),
      },
    });
  } catch (e) {
    console.error("DELETE /users/me/avatar failed:", e);
    return res.status(500).json({ error: "Failed to remove avatar" });
  }
});

module.exports = router;
