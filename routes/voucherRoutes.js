// routes/voucherRoutes.js
const express = require("express");
const router = express.Router();

const { qAll, qGet, qRun } = require("../dbCompat");
const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");

const {
  PERMISSIONS,
  hasPermission: hasAccessPermission,
} = require("../middleware/accessControl");
// ============================================================
// VOUCHERS ROUTES
// PostgreSQL-only mindset
// Multi-tenant safe via req.tenantRid
// Isolated from POS logic
// ============================================================



// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function requireTenant(req, res) {
  const restaurantId = Number(req.tenantRid || req.user?.restaurant_id || 0);
  if (!restaurantId) {
    res.status(400).json({ error: "Missing restaurant context." });
    return null;
  }
  return restaurantId;
}

function authorityOf(req) {
  return normalizeAuthority(
    req.membership?.authority ||
      req.user?.authority,
    "staff"
  );
}

function permissionsOf(req) {
  const raw =
    req.membership?.permissions ||
    req.user?.permissions ||
    [];

  if (Array.isArray(raw)) {
    return new Set(
      raw
        .map((p) => String(p || "").trim())
        .filter(Boolean)
    );
  }

  try {
    const parsed =
      typeof raw === "string"
        ? JSON.parse(raw)
        : [];

    return new Set(
      Array.isArray(parsed)
        ? parsed
            .map((p) => String(p || "").trim())
            .filter(Boolean)
        : []
    );
  } catch {
    return new Set();
  }
}

function actorAccess(req) {
  return {
    authority:
      req.membership?.authority ||
      req.user?.authority ||
      "staff",

    permissions:
      req.membership?.permissions ||
      req.user?.permissions ||
      [],
  };
}

function canManage(req) {
  return hasAccessPermission(
    actorAccess(req),
    PERMISSIONS.VOUCHERS_MANAGE
  );
}

function canApply(req) {
  return hasAccessPermission(
    actorAccess(req),
    PERMISSIONS.POS_VOUCHER_PAYMENT
  );
}

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-");
}

function generateVoucherCode(prefix = "MAKS") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = `${String(prefix || "MAKS").toUpperCase()}-`;
  for (let i = 0; i < 8; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function toNullableNumber(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isTruthy(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------
router.use(authenticateToken, loadMembership);

// ------------------------------------------------------------
// GET /vouchers
// List vouchers for current restaurant
// ------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const restaurantId = requireTenant(req, res);
    if (!restaurantId) return;

    if (!canManage(req)) {
      return res.status(403).json({ error: "Not allowed to manage vouchers." });
    }

    const rows = await qAll(
      `
      SELECT
        id,
        restaurant_id,
        name,
        code,
        discount_type,
        discount_value,
        min_spend,
        usage_limit,
        used_count,
        usage_mode,
        active,
        dine_in_only,
        takeaway_only,
        starts_at,
        expires_at,
        redeemed_at,
        created_at,
        updated_at
      FROM vouchers
      WHERE restaurant_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [restaurantId]
    );

    res.json(rows || []);
  } catch (err) {
    console.error("❌ GET /vouchers failed:", err);
    res.status(500).json({ error: "Failed to load vouchers." });
  }
});

// ------------------------------------------------------------
// POST /vouchers
// Create voucher for current restaurant
// ------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const restaurantId = requireTenant(req, res);
    if (!restaurantId) return;

    if (!canManage(req)) {
      return res.status(403).json({ error: "Not allowed to create vouchers." });
    }

    const {
      name,
      code,
      discount_type,
      discount_value,
      min_spend,
      usage_limit,
      active,
      dine_in_only,
      takeaway_only,
      starts_at,
      expires_at,
      usage_mode,
    } = req.body || {};

    const cleanName = String(name || "").trim();
    if (!cleanName) {
      return res.status(400).json({ error: "Voucher name is required." });
    }

    const cleanUsageMode = String(usage_mode || "multi").trim().toLowerCase();
    if (!["single", "multi"].includes(cleanUsageMode)) {
      return res.status(400).json({
        error: "usage_mode must be 'single' or 'multi'.",
      });
    }

    const cleanType = String(discount_type || "").trim().toLowerCase();
    if (!["percent", "fixed"].includes(cleanType)) {
      return res.status(400).json({
        error: "discount_type must be 'percent' or 'fixed'.",
      });
    }

    const cleanValue = Number(discount_value);
    if (!Number.isFinite(cleanValue) || cleanValue <= 0) {
      return res.status(400).json({
        error: "discount_value must be greater than 0.",
      });
    }

    if (cleanType === "percent" && cleanValue > 100) {
      return res.status(400).json({
        error: "Percentage vouchers cannot be more than 100%.",
      });
    }

    const cleanMinSpend = toNullableNumber(min_spend);
    if (cleanMinSpend !== null && cleanMinSpend < 0) {
      return res.status(400).json({ error: "min_spend cannot be negative." });
    }

    const cleanUsageLimit = toNullableNumber(usage_limit);
    if (cleanUsageLimit !== null && cleanUsageLimit < 1) {
      return res.status(400).json({ error: "usage_limit must be at least 1." });
    }

    const cleanStartsAt = starts_at || null;
    const cleanExpiresAt = expires_at || null;

    if (
      cleanStartsAt &&
      cleanExpiresAt &&
      new Date(cleanExpiresAt) <= new Date(cleanStartsAt)
    ) {
      return res.status(400).json({
        error: "expires_at must be after starts_at.",
      });
    }

    let cleanCode = normalizeCode(code);

    if (!cleanCode) {
      let attempts = 0;
      while (attempts < 10) {
        const candidate = generateVoucherCode("MAKS");
        const existing = await qGet(
          `SELECT id FROM vouchers WHERE restaurant_id = $1 AND code = $2 LIMIT 1`,
          [restaurantId, candidate]
        );
        if (!existing) {
          cleanCode = candidate;
          break;
        }
        attempts += 1;
      }

      if (!cleanCode) {
        return res.status(500).json({
          error: "Failed to generate voucher code.",
        });
      }
    }

    const existingCode = await qGet(
      `SELECT id FROM vouchers WHERE restaurant_id = $1 AND code = $2 LIMIT 1`,
      [restaurantId, cleanCode]
    );

    if (existingCode) {
      return res.status(409).json({
        error: "Voucher code already exists for this restaurant.",
      });
    }

    const inserted = await qGet(
      `
      INSERT INTO vouchers (
        restaurant_id,
        name,
        code,
        discount_type,
        discount_value,
        min_spend,
        usage_limit,
        used_count,
        usage_mode,
        active,
        dine_in_only,
        takeaway_only,
        starts_at,
        expires_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13
      )
      RETURNING
        id,
        restaurant_id,
        name,
        code,
        discount_type,
        discount_value,
        min_spend,
        usage_limit,
        used_count,
        usage_mode,
        active,
        dine_in_only,
        takeaway_only,
        starts_at,
        expires_at,
        redeemed_at,
        created_at,
        updated_at
      `,
      [
        restaurantId,
        cleanName,
        cleanCode,
        cleanType,
        cleanValue,
        cleanMinSpend,
        cleanUsageLimit,
        cleanUsageMode,
        isTruthy(active),
        isTruthy(dine_in_only),
        isTruthy(takeaway_only),
        cleanStartsAt,
        cleanExpiresAt,
      ]
    );

    res.status(201).json(inserted);
  } catch (err) {
    console.error("❌ POST /vouchers failed:", err);
    res.status(500).json({ error: "Failed to create voucher." });
  }
});

// ------------------------------------------------------------
// PATCH /vouchers/:id/status
// Enable / disable voucher
// ------------------------------------------------------------
router.patch("/:id/status", async (req, res) => {
  try {
    const restaurantId = requireTenant(req, res);
    if (!restaurantId) return;

    if (!canManage(req)) {
      return res.status(403).json({ error: "Not allowed to update vouchers." });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid voucher id." });
    }

    const active = isTruthy(req.body?.active);

    const updated = await qGet(
      `
      UPDATE vouchers
      SET
        active = $3,
        updated_at = NOW()
      WHERE id = $1
        AND restaurant_id = $2
      RETURNING id, active, updated_at
      `,
      [id, restaurantId, active]
    );

    if (!updated) {
      return res.status(404).json({ error: "Voucher not found." });
    }

    res.json(updated);
  } catch (err) {
    console.error("❌ PATCH /vouchers/:id/status failed:", err);
    res.status(500).json({ error: "Failed to update voucher status." });
  }
});

// ------------------------------------------------------------
// DELETE /vouchers/:id
// Delete voucher
// ------------------------------------------------------------
router.delete("/:id", async (req, res) => {
  try {
    const restaurantId = requireTenant(req, res);
    if (!restaurantId) return;

    if (!canManage(req)) {
      return res.status(403).json({ error: "Not allowed to delete vouchers." });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid voucher id." });
    }

    const deleted = await qGet(
      `
      DELETE FROM vouchers
      WHERE id = $1
        AND restaurant_id = $2
      RETURNING id, code
      `,
      [id, restaurantId]
    );

    if (!deleted) {
      return res.status(404).json({ error: "Voucher not found." });
    }

    res.json({ ok: true, deleted });
  } catch (err) {
    console.error("❌ DELETE /vouchers/:id failed:", err);
    res.status(500).json({ error: "Failed to delete voucher." });
  }
});

// ------------------------------------------------------------
// POST /vouchers/validate
// Used by POS to check a voucher before applying
// ------------------------------------------------------------
router.post("/validate", async (req, res) => {
  try {
    const restaurantId = requireTenant(req, res);
    if (!restaurantId) return;

    if (!canApply(req)) {
      return res.status(403).json({ error: "Not allowed to validate vouchers." });
    }

    const {
      code,
      order_type,
      subtotal = 0,
    } = req.body || {};

    const cleanCode = normalizeCode(code);
    if (!cleanCode) {
      return res.status(400).json({ error: "Voucher code is required." });
    }

    const voucher = await qGet(
      `
      SELECT
        id,
        restaurant_id,
        name,
        code,
        discount_type,
        discount_value,
        min_spend,
        usage_limit,
        used_count,
        usage_mode,
        active,
        dine_in_only,
        takeaway_only,
        starts_at,
        expires_at,
        redeemed_at
      FROM vouchers
      WHERE restaurant_id = $1
        AND code = $2
      LIMIT 1
      `,
      [restaurantId, cleanCode]
    );

    if (!voucher) {
      return res.status(404).json({ error: "Voucher not found." });
    }

    if (!voucher.active) {
      return res.status(400).json({ error: "Voucher is inactive." });
    }

    if (voucher.usage_mode === "single" && Number(voucher.used_count || 0) >= 1) {
      return res.status(400).json({ error: "Voucher has already been used." });
    }

    const now = new Date();

    if (voucher.starts_at && new Date(voucher.starts_at) > now) {
      return res.status(400).json({ error: "Voucher is not active yet." });
    }

    if (voucher.expires_at && new Date(voucher.expires_at) < now) {
      return res.status(400).json({ error: "Voucher has expired." });
    }

    if (
      voucher.usage_limit !== null &&
      Number(voucher.used_count || 0) >= Number(voucher.usage_limit)
    ) {
      return res.status(400).json({ error: "Voucher usage limit reached." });
    }

    const cleanOrderType = String(order_type || "").toLowerCase();

    if (voucher.dine_in_only && cleanOrderType === "takeaway") {
      return res.status(400).json({ error: "Voucher is dine-in only." });
    }

    if (voucher.takeaway_only && cleanOrderType === "dine-in") {
      return res.status(400).json({ error: "Voucher is takeaway only." });
    }

    const cleanSubtotal = Number(subtotal || 0);

    if (
      voucher.min_spend !== null &&
      Number.isFinite(cleanSubtotal) &&
      cleanSubtotal < Number(voucher.min_spend)
    ) {
      return res.status(400).json({
        error: `Minimum spend is £${Number(voucher.min_spend).toFixed(2)}.`,
      });
    }

    let discountAmount = 0;

    if (voucher.discount_type === "percent") {
      discountAmount =
        (cleanSubtotal * Number(voucher.discount_value || 0)) / 100;
    } else {
      discountAmount = Number(voucher.discount_value || 0);
    }

    discountAmount = Math.max(
      0,
      Math.min(cleanSubtotal, Number(discountAmount.toFixed(2)))
    );

    return res.json({
      ok: true,
      id: voucher.id,
      name: voucher.name,
      code: voucher.code,
      type: voucher.discount_type,
      value: Number(voucher.discount_value || 0),
      usage_mode: voucher.usage_mode || "multi",
      discount_amount: discountAmount,
      min_spend: voucher.min_spend,
      dine_in_only: !!voucher.dine_in_only,
      takeaway_only: !!voucher.takeaway_only,
    });
  } catch (err) {
    console.error("❌ POST /vouchers/validate failed:", err);
    res.status(500).json({ error: "Failed to validate voucher." });
  }
});

// ------------------------------------------------------------
// POST /vouchers/:id/redeem
// Call this only AFTER payment succeeds
// ------------------------------------------------------------
router.post("/:id/redeem", async (req, res) => {
  try {
    const restaurantId = requireTenant(req, res);
    if (!restaurantId) return;

    if (!canApply(req)) {
      return res.status(403).json({ error: "Not allowed to redeem vouchers." });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid voucher id." });
    }

    const voucher = await qGet(
      `
      SELECT id, code, usage_mode, used_count, usage_limit, active
      FROM vouchers
      WHERE id = $1
        AND restaurant_id = $2
      LIMIT 1
      `,
      [id, restaurantId]
    );

    if (!voucher) {
      return res.status(404).json({ error: "Voucher not found." });
    }

    if (!voucher.active) {
      return res.status(400).json({ error: "Voucher is inactive." });
    }

    if (voucher.usage_mode === "single" && Number(voucher.used_count || 0) >= 1) {
      return res.status(400).json({ error: "Voucher has already been used." });
    }

    if (
      voucher.usage_limit !== null &&
      Number(voucher.used_count || 0) >= Number(voucher.usage_limit)
    ) {
      return res.status(400).json({ error: "Voucher usage limit reached." });
    }

    let updated;

    if (voucher.usage_mode === "single") {
      updated = await qGet(
        `
        UPDATE vouchers
        SET
          used_count = COALESCE(used_count, 0) + 1,
          active = FALSE,
          redeemed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND restaurant_id = $2
        RETURNING id, code, usage_mode, used_count, usage_limit, active, redeemed_at
        `,
        [id, restaurantId]
      );
    } else {
      updated = await qGet(
        `
        UPDATE vouchers
        SET
          used_count = COALESCE(used_count, 0) + 1,
          updated_at = NOW()
        WHERE id = $1
          AND restaurant_id = $2
          AND active = TRUE
          AND (usage_limit IS NULL OR COALESCE(used_count, 0) < usage_limit)
        RETURNING id, code, usage_mode, used_count, usage_limit, active, redeemed_at
        `,
        [id, restaurantId]
      );
    }

    if (!updated) {
      return res.status(400).json({ error: "Voucher could not be redeemed." });
    }

    res.json({ ok: true, voucher: updated });
  } catch (err) {
    console.error("❌ POST /vouchers/:id/redeem failed:", err);
    res.status(500).json({ error: "Failed to redeem voucher." });
  }
});

module.exports = router;