const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");
const { qAll, qGet, qRun, kind } = require("../dbCompat");
const {
  PERMISSIONS,
  hasPermission,
} = require("../middleware/accessControl");

router.use(authenticateToken, loadMembership);


function ridOf(req) {
  return Number(req.tenantRid || req.user?.restaurant_id || 0);
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
  return hasPermission(
    actorAccess(req),
    PERMISSIONS.HAPPY_HOUR_MANAGE
  );
}

function canView(req) {
  /*
   * /current is operational state, not configuration.
   *
   * Any authenticated active restaurant member may need
   * to know the currently active Happy Hour so POS/KDS
   * displays remain consistent.
   */
  return !!req.membership;
}

function p(i) {
  return kind === "pg" ? `$${i}` : `?`;
}

function safeJson(val, fallback = []) {
  try {
    if (Array.isArray(val)) return val;
    if (typeof val === "string") return JSON.parse(val);
    if (val && typeof val === "object") return val;
    return fallback;
  } catch {
    return fallback;
  }
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function normalizeItemScope(v) {
  const s = String(v || "").trim().toLowerCase();

  if (s === "all") return "all";
  if (s === "category") return "category";
  if (s === "item") return "item";

  if (s === "drink" || s === "drinks" || s.startsWith("drink")) return "drinks";
  if (s === "dessert" || s === "desserts" || s.startsWith("dessert")) return "desserts";
  if (s === "meal" || s === "meals" || s.startsWith("meal")) return "meals";

  return "all";
}

function normalizeDiscountType(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "fixed") return "fixed";
  return "percent";
}

function normalizeMode(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "scheduled") return "scheduled";
  return "manual";
}

function normalizeOrderType(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "takeaway") return "takeaway";
  if (s === "delivery") return "delivery";
  return "dine-in";
}

async function initHappyHourTable() {
  if (kind === "pg") {
    await qRun(`
      CREATE TABLE IF NOT EXISTS public.happy_hours (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        manual_live BOOLEAN NOT NULL DEFAULT FALSE,
        mode TEXT NOT NULL DEFAULT 'manual',
        item_scope TEXT NOT NULL DEFAULT 'all',
        category_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        item_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        discount_type TEXT NOT NULL DEFAULT 'percent',
        discount_value NUMERIC(10,2) NOT NULL DEFAULT 0,
        starts_at TIMESTAMPTZ NULL,
        ends_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await qRun(`
      CREATE INDEX IF NOT EXISTS idx_happy_hours_rid
      ON public.happy_hours(restaurant_id);
    `);

    await qRun(`
      CREATE INDEX IF NOT EXISTS idx_happy_hours_live
      ON public.happy_hours(restaurant_id, enabled, manual_live);
    `);
  } else {
    await qRun(`
      CREATE TABLE IF NOT EXISTS happy_hours (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        manual_live INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'manual',
        item_scope TEXT NOT NULL DEFAULT 'all',
        category_ids TEXT NOT NULL DEFAULT '[]',
        item_ids TEXT NOT NULL DEFAULT '[]',
        discount_type TEXT NOT NULL DEFAULT 'percent',
        discount_value REAL NOT NULL DEFAULT 0,
        starts_at TEXT NULL,
        ends_at TEXT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
}

function toClientRule(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    name: row.name,
    enabled: !!row.enabled,
    manual_live: !!row.manual_live,
    mode: row.mode,
    item_scope: row.item_scope,
    category_ids: safeJson(row.category_ids, []).map(Number).filter(Boolean),
    item_ids: safeJson(row.item_ids, []).map(Number).filter(Boolean),
    discount_type: row.discount_type,
    discount_value: Number(row.discount_value || 0),
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function itemMatchesRule(rule, item) {
  if (!rule) return false;

  const scope = normalizeItemScope(rule.item_scope);
  const itemType = normalizeItemScope(item?.type || item?.item_type || item?.category || "all");
  const itemId = Number(item?.id || 0);
  const categoryId = Number(item?.category_id || 0);

  const ruleCategoryIds = safeJson(rule.category_ids, []).map(Number).filter(Boolean);
  const ruleItemIds = safeJson(rule.item_ids, []).map(Number).filter(Boolean);

  if (scope === "all") return true;
  if (scope === "meals") return itemType === "meals";
  if (scope === "drinks") return itemType === "drinks";
  if (scope === "desserts") return itemType === "desserts";
  if (scope === "category") return categoryId > 0 && ruleCategoryIds.includes(categoryId);
  if (scope === "item") return itemId > 0 && ruleItemIds.includes(itemId);

  return false;
}

async function getLiveHappyHourRule(req, restaurantId) {
  if (!restaurantId) return null;

  if (req.kind === "pg") {
    return await req.qGet(
      `
      SELECT *
      FROM happy_hours
      WHERE restaurant_id = $1
        AND enabled = TRUE
        AND (
          manual_live = TRUE
          OR (
            mode = 'scheduled'
            AND starts_at IS NOT NULL
            AND ends_at IS NOT NULL
            AND NOW() >= starts_at
            AND NOW() <= ends_at
          )
        )
      ORDER BY manual_live DESC, updated_at DESC, id DESC
      LIMIT 1
      `,
      [restaurantId]
    );
  }

  return await req.qGet(
    `
    SELECT *
    FROM happy_hours
    WHERE restaurant_id = ?
      AND enabled = 1
      AND (
        manual_live = 1
        OR (
          mode = 'scheduled'
          AND starts_at IS NOT NULL
          AND ends_at IS NOT NULL
          AND datetime('now') >= datetime(starts_at)
          AND datetime('now') <= datetime(ends_at)
        )
      )
    ORDER BY manual_live DESC, updated_at DESC, id DESC
    LIMIT 1
    `,
    [restaurantId]
  );
}

async function getEffectivePrice(req, restaurantId, item, orderType = "dine-in") {
  const rawBase = Number(item?.base_price ?? item?.price ?? 0);
  const basePence = Math.max(0, Math.round(rawBase * 100));

  const rule = await getLiveHappyHourRule(req, restaurantId);

  if (!rule || !itemMatchesRule(rule, item)) {
    return {
      price: basePence / 100,
      original_price: basePence / 100,
      happy_hour_applied: false,
      happy_hour_rule_id: null,
      happy_hour_name: null,
    };
  }

  let finalPence = basePence;

  if (String(rule.discount_type || "").toLowerCase() === "fixed") {
    const fixedOffPence = Math.max(0, Math.round(Number(rule.discount_value || 0) * 100));
    finalPence = Math.max(0, basePence - fixedOffPence);
  } else {
    const percent = Number(rule.discount_value || 0);
    const discountPence = Math.round((basePence * percent) / 100);
    finalPence = Math.max(0, basePence - discountPence);
  }

  return {
    price: finalPence / 100,
    original_price: basePence / 100,
    happy_hour_applied: finalPence !== basePence,
    happy_hour_rule_id: Number(rule.id),
    happy_hour_name: String(rule.name || ""),
  };
}

// GET all rules
router.get("/", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing restaurant context" });
    if (!canManage(req)) return res.status(403).json({ error: "Not allowed" });

    const rows = await qAll(
      `
      SELECT *
      FROM happy_hours
      WHERE restaurant_id = ${p(1)}
      ORDER BY created_at DESC, id DESC
      `,
      [rid]
    );

    return res.json((rows || []).map(toClientRule));
  } catch (e) {
    console.error("❌ GET /happy-hour failed:", e);
    return res.status(500).json({ error: "Failed to load happy hour rules" });
  }
});

// GET current active rule
router.get("/current", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing restaurant context" });
    if (!canView(req)) return res.status(403).json({ error: "Not allowed" });

    const row = await getLiveHappyHourRule(req, rid);
    return res.json({ active: toClientRule(row) });
  } catch (e) {
    console.error("❌ GET /happy-hour/current failed:", e);
    return res.status(500).json({ error: "Failed to load current happy hour" });
  }
});

// CREATE rule
router.post("/", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing restaurant context" });
    if (!canManage(req)) return res.status(403).json({ error: "Not allowed" });

    const {
      name,
      enabled = true,
      manual_live = false,
      mode = "manual",
      item_scope = "all",
      category_ids = [],
      item_ids = [],
      discount_type = "percent",
      discount_value,
      starts_at = null,
      ends_at = null,
    } = req.body || {};

    const cleanName = String(name || "").trim();
    if (!cleanName) {
      return res.status(400).json({ error: "Rule name required" });
    }

    const cleanMode = normalizeMode(mode);
    const cleanScope = normalizeItemScope(item_scope);
    const cleanDiscountType = normalizeDiscountType(discount_type);
    const cleanDiscountValue = Number(discount_value || 0);

    const cleanCategoryIds = Array.isArray(category_ids)
      ? category_ids.map(Number).filter(Boolean)
      : [];

    const cleanItemIds = Array.isArray(item_ids)
      ? item_ids.map(Number).filter(Boolean)
      : [];

    if (!(cleanDiscountValue > 0)) {
      return res.status(400).json({ error: "discount_value must be greater than 0" });
    }

    if (cleanDiscountType === "percent" && cleanDiscountValue > 100) {
      return res.status(400).json({ error: "Percent discount cannot exceed 100" });
    }

    if (cleanMode === "scheduled" && (!starts_at || !ends_at)) {
      return res.status(400).json({ error: "Scheduled mode requires starts_at and ends_at" });
    }

    if (starts_at && ends_at && new Date(ends_at) <= new Date(starts_at)) {
      return res.status(400).json({ error: "ends_at must be after starts_at" });
    }

    if (cleanScope === "category" && cleanCategoryIds.length === 0) {
      return res.status(400).json({ error: "category_ids required for category scope" });
    }

    if (cleanScope === "item" && cleanItemIds.length === 0) {
      return res.status(400).json({ error: "item_ids required for item scope" });
    }

    if (manual_live) {
      await qRun(
        `
        UPDATE happy_hours
        SET manual_live = ${kind === "pg" ? "FALSE" : "0"},
            updated_at = ${kind === "pg" ? "NOW()" : "CURRENT_TIMESTAMP"}
        WHERE restaurant_id = ${p(1)}
        `,
        [rid]
      );
    }

    const inserted = await qGet(
      `
      INSERT INTO happy_hours (
        restaurant_id,
        name,
        enabled,
        manual_live,
        mode,
        item_scope,
        category_ids,
        item_ids,
        discount_type,
        discount_value,
        starts_at,
        ends_at,
        created_at,
        updated_at
      )
      VALUES (
        ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)},
        ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)},
        ${kind === "pg" ? "NOW()" : "CURRENT_TIMESTAMP"},
        ${kind === "pg" ? "NOW()" : "CURRENT_TIMESTAMP"}
      )
      RETURNING *
      `,
      [
        rid,
        cleanName,
        !!enabled,
        !!manual_live,
        cleanMode,
        cleanScope,
        JSON.stringify(cleanCategoryIds),
        JSON.stringify(cleanItemIds),
        cleanDiscountType,
        cleanDiscountValue,
        starts_at || null,
        ends_at || null,
      ]
    );

    return res.status(201).json(toClientRule(inserted));
  } catch (e) {
    console.error("❌ POST /happy-hour failed:", e);
    return res.status(500).json({ error: "Failed to create happy hour rule" });
  }
});

// TOGGLE live
router.patch("/:id/live", async (req, res) => {
  try {
    const rid = ridOf(req);
    const id = Number(req.params.id || 0);
    const manual_live = !!req.body?.manual_live;

    if (!rid) return res.status(400).json({ error: "Missing restaurant context" });
    if (!id) return res.status(400).json({ error: "Invalid id" });
    if (!canManage(req)) return res.status(403).json({ error: "Not allowed" });

    if (manual_live) {
      await qRun(
        `
        UPDATE happy_hours
        SET manual_live = ${kind === "pg" ? "FALSE" : "0"},
            updated_at = ${kind === "pg" ? "NOW()" : "CURRENT_TIMESTAMP"}
        WHERE restaurant_id = ${p(1)}
        `,
        [rid]
      );
    }

    const updated = await qGet(
      `
      UPDATE happy_hours
      SET manual_live = ${p(3)},
          updated_at = ${kind === "pg" ? "NOW()" : "CURRENT_TIMESTAMP"}
      WHERE id = ${p(1)}
        AND restaurant_id = ${p(2)}
      RETURNING *
      `,
      [id, rid, manual_live]
    );

    if (!updated) return res.status(404).json({ error: "Rule not found" });

    return res.json(toClientRule(updated));
  } catch (e) {
    console.error("❌ PATCH /happy-hour/:id/live failed:", e);
    return res.status(500).json({ error: "Failed to toggle live happy hour" });
  }
});

// DELETE
router.delete("/:id", async (req, res) => {
  try {
    const rid = ridOf(req);
    const id = Number(req.params.id || 0);

    if (!rid) return res.status(400).json({ error: "Missing restaurant context" });
    if (!id) return res.status(400).json({ error: "Invalid id" });
    if (!canManage(req)) return res.status(403).json({ error: "Not allowed" });

    const deleted = await qGet(
      `
      DELETE FROM happy_hours
      WHERE id = ${p(1)}
        AND restaurant_id = ${p(2)}
      RETURNING id
      `,
      [id, rid]
    );

    if (!deleted) return res.status(404).json({ error: "Rule not found" });

    return res.json({ success: true });
  } catch (e) {
    console.error("❌ DELETE /happy-hour/:id failed:", e);
    return res.status(500).json({ error: "Failed to delete happy hour rule" });
  }
});

module.exports = {
  router,
  initHappyHourTable,
  getEffectivePrice,
};