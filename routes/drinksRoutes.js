// routes/drinksRoutes.js
const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");

const { getEffectivePrice } = require("./happyHourRoutes");
const {
  PERMISSIONS,
  requirePermission,
  hasPermission,
} = require("../middleware/accessControl");

const ridOf = (req) => Number(req.tenantRid || req.user?.restaurant_id || 0);

const bind = (req, sqliteSql, pgSql) => (req.kind === "pg" ? pgSql : sqliteSql);
const p = (req, i) => (req.kind === "pg" ? `$${i}` : `?`);

function can(req, permission) {
  return hasPermission(
    {
      authority:
        req.membership?.authority ||
        req.user?.authority,

      permissions:
        req.membership?.permissions ||
        req.user?.permissions,
    },
    permission
  );
}

function requirePricingIfPresent(req, res, next) {
  if (req.body?.price === undefined) {
    return next();
  }

  if (
    !can(
      req,
      PERMISSIONS.MENU_PRICING
    )
  ) {
    return res.status(403).json({
      error:
        "You do not have permission to change menu pricing.",
      code: "PERMISSION_DENIED",
      permission:
        PERMISSIONS.MENU_PRICING,
    });
  }

  return next();
}

function normalizeVatRate(raw) {
  if (
    raw === undefined ||
    raw === null ||
    String(raw).trim() === ""
  ) {
    return null;
  }

  const value = Number(raw);

  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    const err = new Error(
      "VAT rate must be between 0 and 100, or left empty."
    );

    err.status = 400;
    throw err;
  }

  return Number(value.toFixed(2));
}

function parseOptionsSchema(raw) {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw;
  }

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function validateOptionsSchema(schemaRaw) {
  const schema =
    Array.isArray(schemaRaw)
      ? schemaRaw
      : parseOptionsSchema(schemaRaw);

  const groupIds = new Set();

  for (const group of schema) {
    const id =
      String(group?.id || "").trim();

    const label =
      String(group?.label || "").trim();

    const type =
      String(group?.type || "")
        .trim()
        .toLowerCase();

    if (!id) {
      const err = new Error(
        "Every option group requires an id."
      );

      err.status = 400;
      throw err;
    }

    if (groupIds.has(id)) {
      const err = new Error(
        "Duplicate option-group id."
      );

      err.status = 400;
      throw err;
    }

    groupIds.add(id);

    if (!label) {
      const err = new Error(
        "Every option group requires a label."
      );

      err.status = 400;
      throw err;
    }

    if (
      !["single", "multi", "text"].includes(type)
    ) {
      const err = new Error(
        `Unsupported option type: ${type}`
      );

      err.status = 400;
      throw err;
    }

    if (type === "text") {
      continue;
    }

    const choices =
      Array.isArray(group?.choices)
        ? group.choices
        : [];

    if (!choices.length) {
      const err = new Error(
        `"${label}" requires at least one choice.`
      );

      err.status = 400;
      throw err;
    }

    const choiceIds = new Set();

    for (const choice of choices) {
      const choiceId =
        String(choice?.id || "").trim();

      const choiceLabel =
        String(choice?.label || "").trim();

      if (!choiceId) {
        const err = new Error(
          `"${label}" contains a choice without an id.`
        );

        err.status = 400;
        throw err;
      }

      if (choiceIds.has(choiceId)) {
        const err = new Error(
          `"${label}" contains duplicate choice ids.`
        );

        err.status = 400;
        throw err;
      }

      choiceIds.add(choiceId);

      if (!choiceLabel) {
        const err = new Error(
          `"${label}" contains a choice without a label.`
        );

        err.status = 400;
        throw err;
      }

      const priceDelta = Number(
        choice?.priceDelta ??
        choice?.price_delta ??
        0
      );

      if (!Number.isFinite(priceDelta)) {
        const err = new Error(
          `"${choiceLabel}" has an invalid price adjustment.`
        );

        err.status = 400;
        throw err;
      }
    }
  }

  return schema;
}

async function saveDrinkIngredients(req, rid, menuItemId, ingredients = []) {
  await req.qRun(
    `DELETE FROM menu_item_ingredients WHERE restaurant_id = ? AND menu_item_id = ?`,
    [rid, menuItemId]
  );

  for (const ing of ingredients) {
    const stockId = Number(ing.stock_id || 0);
    const amount = Number(ing.amount || 0);
    const unit = String(ing.unit || "unit").trim();

    if (!stockId || amount <= 0) continue;

    const stock = await req.qGet(
      `
      SELECT id, ingredient
      FROM stock
      WHERE restaurant_id = ?
        AND id = ?
      LIMIT 1
      `,
      [rid, stockId]
    );

    if (!stock) continue;

    await req.qRun(
      `
      INSERT INTO menu_item_ingredients (
        restaurant_id,
        menu_item_id,
        stock_id,
        ingredient,
        amount,
        unit
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        rid,
        menuItemId,
        stock.id,
        stock.ingredient,
        amount,
        unit,
      ]
    );
  }
}

async function saveMenuItemIngredientsAndRefreshNutrition(req, rid, menuItemId, ingredients = []) {
  await req.qRun(
    `DELETE FROM public.menu_item_ingredients
     WHERE restaurant_id = $1 AND menu_item_id = $2`,
    [rid, menuItemId]
  );

  let totalCalories = 0;
  const allergensSet = new Set();

  for (const ing of ingredients) {
    const stockId = Number(ing.stock_id || 0) || null;
    const amount = Number(ing.amount || 0);
    const unit = String(ing.unit || "unit").trim();

    if (!stockId || amount <= 0) continue;

    const stock = await req.qGet(
      `
      SELECT id, ingredient, allergens, calories_per_100g
      FROM public.stock
      WHERE restaurant_id = $1 AND id = $2
      LIMIT 1
      `,
      [rid, stockId]
    );

    if (!stock?.id) continue;

    await req.qRun(
      `
      INSERT INTO public.menu_item_ingredients
        (restaurant_id, menu_item_id, stock_id, ingredient, amount, unit)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [rid, menuItemId, stockId, stock.ingredient, amount, unit]
    );

    if (stock.allergens && String(stock.allergens).toLowerCase() !== "none") {
      String(stock.allergens)
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
        .forEach((a) => allergensSet.add(a));
    }

    const cal100 = Number(stock.calories_per_100g || 0);
    if (cal100 > 0) totalCalories += cal100 * (amount / 100);
  }

  const allergens = allergensSet.size ? Array.from(allergensSet).join(", ") : "None";

  await req.qRun(
    `
    UPDATE public.menu_items
    SET allergens = $1,
        calories = $2
    WHERE restaurant_id = $3 AND id = $4
    `,
    [allergens, Number(totalCalories.toFixed(2)), rid, menuItemId]
  );

  return { allergens, calories: Number(totalCalories.toFixed(2)) };
}

// ✅ GET /drinks/suppliers
router.get("/suppliers", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "No restaurant selected (missing rid)" });

    const rows = await req.qAll(
      `SELECT * FROM suppliers WHERE restaurant_id = ${p(req, 1)} ORDER BY name ASC`,
      [rid]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("❌ GET /drinks/suppliers failed:", e);
    res.status(500).json({ error: "Failed to fetch suppliers" });
  }
});

// ✅ GET /drinks/restock-orders
router.get("/restock-orders", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "No restaurant selected (missing rid)" });

    const rows = await req.qAll(
      `
      SELECT *
      FROM restock_orders
      WHERE type = 'drink'
        AND restaurant_id = ${p(req, 1)}
      ORDER BY created_at DESC
      `,
      [rid]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("❌ GET /drinks/restock-orders failed:", e);
    res.status(500).json({ error: "Failed to fetch restock orders" });
  }
});

// ✅ GET /drinks/sales-analytics (from orders table)
router.get("/sales-analytics", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "No restaurant selected (missing rid)" });

    const rows = await req.qAll(
      `
      SELECT
        meal_name           AS drink_name,
        SUM(quantity)       AS total_sold,
        SUM(total_price)    AS total_revenue,
        AVG(price_per_unit) AS avg_unit_price
      FROM orders
      WHERE restaurant_id = ${p(req, 1)}
        AND LOWER(category) = 'drinks'
      GROUP BY meal_name
      ORDER BY total_sold DESC, drink_name ASC
      `,
      [rid]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("❌ GET /drinks/sales-analytics failed:", e);
    res.status(500).json({ error: "Failed to fetch drink analytics" });
  }
});

 router.post(
  "/items",
  authenticateToken,
  loadMembership,

  requirePermission(
    PERMISSIONS.MENU_CREATE
  ),

  requirePricingIfPresent,

  async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const nm = String(req.body?.name || "").trim();
    if (!nm) return res.status(400).json({ error: "name required" });

    const price = Number(req.body?.price || 0);

    if (
  !Number.isFinite(price) ||
  price < 0
) {
  return res.status(400).json({
    error:
      "price must be a valid non-negative number",
  });
}

const vatRate =
  normalizeVatRate(
    req.body?.vat_rate
  );

const cleanOptionsSchema =
  validateOptionsSchema(
    req.body?.options_schema || []
  );

    const ingredients = Array.isArray(req.body?.ingredients) ? req.body.ingredients : [];

    let category_id =
      req.body?.category_id == null || req.body?.category_id === ""
        ? null
        : Number(req.body.category_id);

const options_schema =
  JSON.stringify(
    cleanOptionsSchema
  );

    if (!category_id) {
      const def = await req.qGet(
        `
        SELECT id
        FROM categories
        WHERE restaurant_id = $1
          AND LOWER(type) LIKE 'drink%'
        ORDER BY id ASC
        LIMIT 1
        `,
        [rid]
      );

      if (!def?.id) {
        return res.status(400).json({
          error: "No drink category exists. Create a drink category first.",
        });
      }

      category_id = Number(def.id);
    }

    const row = await req.qGet(
      `
      INSERT INTO public.menu_items (
  restaurant_id,
  name,
  price,
  vat_rate,
  type,
  category_id,
  options_schema
)
VALUES (
  $1,
  $2,
  $3,
  $4,
  'drink',
  $5,
  $6
)
      RETURNING *
      `,
[
  rid,
  nm,
  Number(price.toFixed(2)),
  vatRate,
  category_id,
  options_schema,
]
    );

const nutrition = await saveMenuItemIngredientsAndRefreshNutrition(req, rid, row.id, ingredients);
    const finalItem = await req.qGet(
      `
      SELECT *
      FROM public.menu_items
      WHERE restaurant_id = $1 AND id = $2
      LIMIT 1
      `,
      [rid, row.id]
    );

    return res.status(201).json({
      success: true,
      item: finalItem || row,
      nutrition,
    });
  } catch (e) {
    console.error("❌ POST /drinks/items failed:", e);
    return res.status(500).json({ error: "Failed to create drink item" });
  }
}
);

// ✅ GET /drinks/items?category_id=123
router.get("/items", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const categoryIdRaw = req.query.category_id;
    const categoryId = categoryIdRaw ? Number(categoryIdRaw) : null;

    const sql = `
      SELECT
        id,
        name,
        price,
        vat_rate,
        type,
        category_id,
        options_schema,
        out_of_stock,
        photo_url,
        allergens,
        calories,
        created_at
      FROM public.menu_items
      WHERE restaurant_id = $1
        AND LOWER(TRIM(type)) IN ('drink', 'drinks')
        ${categoryId ? "AND category_id = $2" : ""}
      ORDER BY LOWER(TRIM(name)) ASC
    `;

    const params = categoryId ? [rid, categoryId] : [rid];
    const rows = await req.qAll(sql, params);

    const enriched = await Promise.all(
      (rows || []).map(async (item) => {
        const pricing = await getEffectivePrice(
          req,
          rid,
          {
            ...item,
            type: "drink",
            item_type: "drinks",
            base_price: Number(item.price || 0),
          },
          req.query.order_type
        );

        const recipeRows = await req.qAll(
  `
  SELECT
    mii.amount,
    COALESCE(s.price, 0) AS stock_price
  FROM public.menu_item_ingredients mii
  LEFT JOIN public.stock s
    ON s.restaurant_id = mii.restaurant_id
   AND s.id = mii.stock_id
  WHERE mii.restaurant_id = $1
    AND mii.menu_item_id = $2
  `,
  [rid, item.id]
);

const cost = (recipeRows || []).reduce((sum, r) => {
  return sum + Number(r.amount || 0) * Number(r.stock_price || 0);
}, 0);

        return {
  ...item,
  ...pricing,
  allergens: item.allergens || "None",
  calories: Number(item.calories || 0),
  cost: Number(cost.toFixed(4)),
};
      })
    );

    res.json(enriched);
  } catch (e) {
    console.error("❌ GET /drinks/items failed:", e?.message, e?.stack);
    res.status(500).json({ error: "Failed to fetch drink items" });
  }
});

router.put(
  "/items/:id",
  authenticateToken,
  loadMembership,

  requirePermission(
    PERMISSIONS.MENU_EDIT
  ),

  requirePricingIfPresent,

  async (req, res) => {
  try {
    const rid = ridOf(req);
    const id = Number(req.params.id);

    if (!rid) return res.status(400).json({ error: "Missing rid" });
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const {
      name,
      price,
        vat_rate,
      category_id,
      options_schema,
      photo_url,
      out_of_stock,
      ingredients,
    } = req.body || {};

    const sets = [];
    const vals = [];

    const add = (col, val) => {
      sets.push(`${col} = ?`);
      vals.push(val);
    };

    if (name !== undefined) add("name", String(name || "").trim());
if (price !== undefined) {
  const cleanPrice =
    Number(price);

  if (
    !Number.isFinite(cleanPrice) ||
    cleanPrice < 0
  ) {
    const err =
      new Error(
        "price must be a valid non-negative number"
      );

    err.status = 400;
    throw err;
  }

  add(
    "price",
    Number(
      cleanPrice.toFixed(2)
    )
  );
}

if (vat_rate !== undefined) {
  add(
    "vat_rate",
    normalizeVatRate(
      vat_rate
    )
  );
}    
    if (category_id !== undefined) {
      add("category_id", category_id === "" || category_id == null ? null : Number(category_id));
    }
    if (photo_url !== undefined) add("photo_url", photo_url ? String(photo_url).trim() : null);
    if (out_of_stock !== undefined) add("out_of_stock", !!out_of_stock);

    if (options_schema !== undefined) {
  const cleanSchema =
    validateOptionsSchema(
      options_schema || []
    );

  add(
    "options_schema",
    JSON.stringify(
      cleanSchema
    )
  );
}

    if (sets.length) {
      vals.push(id, rid);

      const r = await req.qRun(
        `
        UPDATE menu_items
        SET ${sets.join(", ")}
        WHERE id = ?
          AND restaurant_id = ?
          AND LOWER(TRIM(type)) IN ('drink', 'drinks')
        `,
        vals
      );

      const changed = r?.rowCount ?? r?.changes ?? 0;
      if (!changed) return res.status(404).json({ error: "Drink item not found" });
    }

    if (Array.isArray(ingredients)) {
await saveMenuItemIngredientsAndRefreshNutrition(req, rid, id, ingredients);    }

    const updated = await req.qGet(
      `
      SELECT *
      FROM menu_items
      WHERE id = ?
        AND restaurant_id = ?
        AND LOWER(TRIM(type)) IN ('drink', 'drinks')
      LIMIT 1
      `,
      [id, rid]
    );

    res.json({ success: true, item: updated });
  } catch (e) {
    console.error("❌ PUT /drinks/items/:id failed:", e);
const status =
  Number(e?.status || 500);

return res
  .status(status)
  .json({
    error:
      status < 500
        ? e.message
        : "Failed to create drink item",
  });

}
});
// ✅ DELETE /drinks/items/:id
router.delete(
  "/items/:id",
  authenticateToken,
  loadMembership,

  requirePermission(
    PERMISSIONS.MENU_DELETE
  ),

  async (req, res) => {
  try {
    const rid = ridOf(req);
    const id = Number(req.params.id);

    if (!rid) return res.status(400).json({ error: "No restaurant selected (missing rid)" });
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const r = await req.qRun(
      `DELETE FROM menu_items WHERE id = ${p(req, 1)} AND restaurant_id = ${p(req, 2)} AND LOWER(type) = 'drink'`,
      [id, rid]
    );

    const changed = r?.rowCount ?? r?.changes ?? 0;
    if (!changed) return res.status(404).json({ error: "Drink item not found" });

    res.json({ success: true });
  } catch (e) {
    console.error("❌ DELETE /drinks/items/:id failed:", e);
    res.status(500).json({ error: "Failed to delete drink item" });
  }
}
);

router.get("/items/:id/ingredients", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);
    const id = Number(req.params.id);

    if (!rid) return res.status(400).json({ error: "Missing rid" });
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const rows = await req.qAll(
      `
      SELECT
        mii.id,
        mii.menu_item_id,
        mii.stock_id,
        mii.ingredient,
        mii.amount,
        mii.unit,
        s.quantity AS stock_quantity,
        s.price AS stock_price,
        s.allergens,
        s.calories_per_100g
      FROM menu_item_ingredients mii
      LEFT JOIN stock s
        ON s.restaurant_id = mii.restaurant_id
       AND s.id = mii.stock_id
      WHERE mii.restaurant_id = ?
        AND mii.menu_item_id = ?
      ORDER BY mii.id ASC
      `,
      [rid, id]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("❌ GET /drinks/items/:id/ingredients failed:", e);
    res.status(500).json({ error: "Failed to load drink ingredients" });
  }
});

module.exports = router;
