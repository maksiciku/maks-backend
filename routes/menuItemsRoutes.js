// backend/routes/menuItemsRoutes.js
const router = require("express").Router();
const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");

const ridOf = (req) => Number(req.tenantRid || req.user?.restaurant_id || 0);

const normType = (t) => {
  const s = String(t || "").toLowerCase().trim();
  if (s.startsWith("drink")) return "drink";
  if (s.startsWith("dessert")) return "dessert";
  return "meal";
};

// ✅ GET /menu-items/by-category/:categoryId?type=drink|dessert|meal (optional)
router.get("/by-category/:categoryId", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);
    const categoryId = Number(req.params.categoryId || 0);
    if (!rid || !categoryId) return res.status(400).json({ error: "Missing rid or categoryId" });

    const typeFilter = req.query.type ? normType(req.query.type) : null;

    const sql = req.kind === "pg"
      ? `
SELECT id, restaurant_id, name, type, price, category_id, paused, out_of_stock, options_schema, created_at, updated_at        FROM public.menu_items
        WHERE restaurant_id = $1
          AND category_id = $2
          AND paused = FALSE
          ${typeFilter ? "AND type = $3" : ""}
        ORDER BY LOWER(TRIM(name)) ASC
      `
      : `
SELECT id, restaurant_id, name, type, price, category_id, paused, out_of_stock, options_schema, created_at, updated_at        FROM menu_items
        WHERE restaurant_id = ?
          AND category_id = ?
          AND COALESCE(paused,0) = 0
          ${typeFilter ? "AND type = ?" : ""}
        ORDER BY LOWER(TRIM(name)) ASC
      `;

    const params = req.kind === "pg"
      ? (typeFilter ? [rid, categoryId, typeFilter] : [rid, categoryId])
      : (typeFilter ? [rid, categoryId, typeFilter] : [rid, categoryId]);

    const rows = await req.qAll(sql, params);
    return res.json(rows || []);
  } catch (e) {
    console.error("❌ GET /menu-items/by-category failed:", e);
    return res.status(500).json({ error: "Failed to load menu items" });
  }
});

router.get("/:id/options", async (req, res) => {
  try {
    const itemId = Number(req.params.id || 0);

    if (!itemId) {
      return res.status(400).json({
        error: "Invalid menu item id",
      });
    }

    const source = String(
      req.query.source || "menu_items"
    ).toLowerCase();

    let sql = "";
    let table = "menu_items";

    // ✅ meals come from meals table
    if (source === "meals") {
      table = "meals";
    }

    sql =
      req.kind === "pg"
        ? `
          SELECT
            id,
            restaurant_id,
            name,
            paused,
            out_of_stock,
            options_schema
          FROM public.${table}
          WHERE id = $1
          LIMIT 1
        `
        : `
          SELECT
            id,
            restaurant_id,
            name,
            paused,
            out_of_stock,
            options_schema
          FROM ${table}
          WHERE id = ?
          LIMIT 1
        `;

    const item = await req.qGet(sql, [itemId]);

    if (!item) {
      return res.status(404).json({
        error: "Menu item not found",
      });
    }

    if (
      item.paused === true ||
      Number(item.paused) === 1
    ) {
      return res.status(404).json({
        error: "Item unavailable",
      });
    }

    if (
      item.out_of_stock === true ||
      Number(item.out_of_stock) === 1
    ) {
      return res.status(404).json({
        error: "Item unavailable",
      });
    }

    let schema = {};

    try {
      schema =
        typeof item.options_schema === "string"
          ? JSON.parse(item.options_schema || "{}")
          : item.options_schema || {};
    } catch {
      schema = {};
    }

    return res.json({
      success: true,
      modifiers: Array.isArray(schema.modifiers)
        ? schema.modifiers
        : [],
      extras: Array.isArray(schema.extras)
        ? schema.extras
        : [],
    });
  } catch (err) {
    console.error(
      "❌ GET /menu-items/:id/options failed:",
      err
    );

    return res.status(500).json({
      error: "Failed to load item options",
    });
  }
});

module.exports = router;
