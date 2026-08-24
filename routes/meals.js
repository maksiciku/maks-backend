// routes/meals.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");
const { getEffectivePrice } = require("./happyHourRoutes");
// Use the same compat helper as authRoutes


const {
  PERMISSIONS,
  requirePermission,
  hasPermission,
} = require("../middleware/accessControl");

const {
  qRun,
  qAll,
  qGet,
  kind,
  withTx,
} = require("../dbCompat");
const ridOf = (req) => Number(req.tenantRid || req.user?.restaurant_id || 0);
const { getMealPortionsLeft } = require("../utils/novaDeduct");

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
  const changesPrice =
    req.body?.price !== undefined;

  const changesVat =
    req.body?.vat_rate !== undefined;

  if (!changesPrice && !changesVat) {
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

async function detectMealIngredientsColumnsLite() {
  if (kind === "pg") {
    const cols = await qAll(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'meal_ingredients'
    `);
    const names = new Set((cols || []).map(c => String(c.column_name).toLowerCase()));
    const qtyCol = ["amount","quantity","qty","quantity_per_meal"].find(c => names.has(c));
    const nameCol = ["ingredient","ingredient_name","name"].find(c => names.has(c));
    if (!nameCol || !qtyCol) throw new Error(`meal_ingredients schema missing cols. Found: ${[...names].join(", ")}`);
    return { nameCol, qtyCol };
  }

  const cols = await qAll(`PRAGMA table_info(meal_ingredients)`);
  const names = new Set((cols || []).map(c => String(c.name).toLowerCase()));
  const qtyCol = ["amount","quantity","qty","quantity_per_meal"].find(c => names.has(c));
  const nameCol = ["ingredient","ingredient_name","name"].find(c => names.has(c));
  if (!nameCol || !qtyCol) throw new Error(`meal_ingredients schema missing cols. Found: ${[...names].join(", ")}`);
  return { nameCol, qtyCol };
}

function nowExpr() {
  return (kind === "pg") ? "NOW()" : "datetime('now')";
}

/**
 * Small helper to safely parse options_schema JSON.
 */
function parseOptionsSchema(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

function normalizeAvailabilitySettings({
  availability_mode,
  manual_quantity,
  manually_stopped,
}) {
  const mode = String(
    availability_mode || "maks"
  )
    .trim()
    .toLowerCase();

  if (
    !["maks", "manual", "unlimited"].includes(
      mode
    )
  ) {
    const err = new Error(
      "availability_mode must be maks, manual or unlimited."
    );

    err.status = 400;
    throw err;
  }

  let manualQuantity = null;

  if (mode === "manual") {
    const qty = Number(
      manual_quantity
    );

    if (
      !Number.isInteger(qty) ||
      qty < 0
    ) {
      const err = new Error(
        "manual_quantity must be a whole number of 0 or more when using manual availability."
      );

      err.status = 400;
      throw err;
    }

    manualQuantity = qty;
  }

  return {
    availability_mode: mode,
    manual_quantity: manualQuantity,
    manually_stopped:
      manually_stopped === true ||
      manually_stopped === 1 ||
      manually_stopped === "true",
  };
}

function validateOptionsSchema(schemaRaw) {
  const schema =
    Array.isArray(schemaRaw)
      ? schemaRaw
      : parseOptionsSchema(schemaRaw);

  const seenGroups = new Set();

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
      throw Object.assign(
        new Error(
          "Every option group requires an id."
        ),
        { status: 400 }
      );
    }

    if (seenGroups.has(id)) {
      throw Object.assign(
        new Error(
          "Duplicate option-group id."
        ),
        { status: 400 }
      );
    }

    seenGroups.add(id);

    if (!label) {
      throw Object.assign(
        new Error(
          "Every option group requires a label."
        ),
        { status: 400 }
      );
    }

    if (
      ![
        "single",
        "multi",
        "text",
      ].includes(type)
    ) {
      throw Object.assign(
        new Error(
          `Unsupported option type: ${type}`
        ),
        { status: 400 }
      );
    }

    if (type === "text") {
      continue;
    }

    const choices =
      Array.isArray(group?.choices)
        ? group.choices
        : [];

    if (!choices.length) {
      throw Object.assign(
        new Error(
          `"${label}" requires at least one choice.`
        ),
        { status: 400 }
      );
    }

    const seenChoices =
      new Set();

    for (const choice of choices) {
      const choiceId =
        String(
          choice?.id || ""
        ).trim();

      const choiceLabel =
        String(
          choice?.label || ""
        ).trim();

      if (!choiceId) {
        throw Object.assign(
          new Error(
            `"${label}" contains a choice without an id.`
          ),
          { status: 400 }
        );
      }

      if (
        seenChoices.has(
          choiceId
        )
      ) {
        throw Object.assign(
          new Error(
            `"${label}" contains duplicate choice ids.`
          ),
          { status: 400 }
        );
      }

      seenChoices.add(
        choiceId
      );

      if (!choiceLabel) {
        throw Object.assign(
          new Error(
            `"${label}" contains a choice without a label.`
          ),
          { status: 400 }
        );
      }

      const priceDelta =
        Number(
          choice?.priceDelta ??
          choice?.price_delta ??
          0
        );

      if (
        !Number.isFinite(
          priceDelta
        )
      ) {
        throw Object.assign(
          new Error(
            `"${choiceLabel}" has an invalid price adjustment.`
          ),
          { status: 400 }
        );
      }

      if (
        choice?.stock_id != null &&
        choice?.stock_id !== "" &&
        (
          !Number.isInteger(
            Number(
              choice.stock_id
            )
          ) ||
          Number(
            choice.stock_id
          ) <= 0
        )
      ) {
        throw Object.assign(
          new Error(
            `"${choiceLabel}" has an invalid stock link.`
          ),
          { status: 400 }
        );
      }

      if (
        choice?.deduct_qty != null &&
        choice?.deduct_qty !== "" &&
        Number(
          choice.deduct_qty
        ) < 0
      ) {
        throw Object.assign(
          new Error(
            `"${choiceLabel}" has an invalid deduction quantity.`
          ),
          { status: 400 }
        );
      }
    }
  }

  return schema;
}

async function refreshMealNutritionWithDb(
  db,
  rid,
  mealId
) {
  const rows = await db.qAll(
    `
    SELECT
      mi.ingredient,
      mi.amount,
      mi.unit,
      s.allergens,
      s.calories_per_100g

    FROM public.meal_ingredients mi

    LEFT JOIN public.stock s
      ON s.restaurant_id =
         mi.restaurant_id

     AND LOWER(TRIM(s.ingredient)) =
         LOWER(TRIM(mi.ingredient))

    WHERE mi.restaurant_id = $1
      AND mi.meal_id = $2

    ORDER BY mi.id ASC
    `,
    [
      rid,
      mealId,
    ]
  );

  const allergensSet =
    new Set();

  let totalCalories = 0;

  const cleanIngredients =
    (rows || []).map((row) => {
      const amount =
        Number(row.amount || 0);

      const caloriesPer100 =
        Number(
          row.calories_per_100g ||
          0
        );

      if (
        row.allergens &&
        String(
          row.allergens
        ).toLowerCase() !== "none"
      ) {
        String(row.allergens)
          .split(",")
          .map((value) =>
            value.trim()
          )
          .filter(Boolean)
          .forEach((value) =>
            allergensSet.add(value)
          );
      }

      const calories =
        caloriesPer100 > 0 &&
        amount > 0
          ? caloriesPer100 *
            (amount / 100)
          : 0;

      totalCalories +=
        calories;

      return {
        name:
          String(
            row.ingredient ||
            ""
          ).trim(),

        amount,

        unit:
          row.unit || "g",

        allergens:
          row.allergens ||
          "None",

        calories:
          Number(
            calories.toFixed(2)
          ),
      };
    });

  const allergens =
    allergensSet.size
      ? Array.from(
          allergensSet
        ).join(", ")
      : "None";

  const calories =
    Number(
      totalCalories.toFixed(2)
    );

  await db.qRun(
    `
    UPDATE public.meals

    SET
      allergens = $1,
      calories = $2,
      ingredients = $3

    WHERE restaurant_id = $4
      AND id = $5
    `,
    [
      allergens,
      calories,
      JSON.stringify(
        cleanIngredients
      ),
      rid,
      mealId,
    ]
  );

  return {
    allergens,
    calories,
    ingredients:
      cleanIngredients,
  };
}

async function refreshMealNutrition(
  rid,
  mealId
) {
  return refreshMealNutritionWithDb(
    {
      qAll,
      qRun,
    },
    rid,
    mealId
  );
}

function normalizeMealIngredients(
  rawIngredients
) {
  if (
    !Array.isArray(
      rawIngredients
    )
  ) {
    return [];
  }

  const seen =
    new Set();

  const out = [];

  for (
    const raw
    of rawIngredients
  ) {
    const name =
      String(
        raw?.name ||
        raw?.ingredient ||
        ""
      )
        .trim()
        .toLowerCase();

    const amount =
      Number(
        raw?.amount ??
        raw?.quantity ??
        0
      );

    const unit =
      String(
        raw?.unit ||
        "g"
      )
        .trim()
        .toLowerCase();

    if (!name) {
      continue;
    }

    if (
      !Number.isFinite(
        amount
      ) ||
      amount <= 0
    ) {
      const err =
        new Error(
          `Ingredient "${name}" must have an amount greater than 0.`
        );

      err.status = 400;

      throw err;
    }

    if (
      seen.has(name)
    ) {
      const err =
        new Error(
          `Ingredient "${name}" appears more than once.`
        );

      err.status = 400;

      throw err;
    }

    seen.add(name);

    out.push({
      name,
      amount,
      unit:
        unit || "g",
    });
  }

  return out;
}

async function resolveMealCategory(
  db,
  rid,
  categoryId,
  fallbackName
) {
  if (!categoryId) {
    return {
      category_id: null,

      category:
        String(
          fallbackName ||
          "Meals"
        ).trim() ||
        "Meals",
    };
  }

  const row =
    await db.qGet(
      `
      SELECT
        id,
        name,
        type

      FROM public.categories

      WHERE restaurant_id = $1
        AND id = $2

      LIMIT 1
      `,
      [
        rid,
        Number(categoryId),
      ]
    );

  if (!row) {
    const err =
      new Error(
        "Selected category does not exist."
      );

    err.status = 400;

    throw err;
  }

  if (
    String(
      row.type || ""
    )
      .trim()
      .toLowerCase() !==
    "meals"
  ) {
    const err =
      new Error(
        "Selected category is not a Meals category."
      );

    err.status = 400;

    throw err;
  }

  return {
    category_id:
      Number(row.id),

    category:
      String(
        row.name ||
        fallbackName ||
        "Meals"
      ).trim(),
  };
}

// -------------------------
// HANDLERS (shared)
// -------------------------

async function getMealsHandler(req, res) {
  try {
    const rid = req.tenantRid;

    const categoryId = req.query.category_id ? Number(req.query.category_id) : null;
    const type = (req.query.type || "").toString().trim().toLowerCase(); // meals|desserts|drinks (if you add later)

    let sql = `
      SELECT m.*
      FROM meals m
      WHERE m.restaurant_id = ?
    `;
    const params = [rid];

    // filter by specific category_id
    if (Number.isFinite(categoryId) && categoryId > 0) {
      sql += ` AND m.category_id = ?`;
      params.push(categoryId);
    }

    // filter by type via categories table (only if no category_id provided)
    if (!categoryId && type) {
      sql += `
        AND EXISTS (
          SELECT 1
          FROM categories c
          WHERE c.restaurant_id = m.restaurant_id
            AND c.id = m.category_id
            AND LOWER(c.type) = LOWER(?)
        )
      `;
      params.push(type);
    }

    sql += ` ORDER BY m.name ASC`;

    const rows = await qAll(sql, params);

    const items = (rows || []).map(m => ({
      ...m,
      options_schema: parseOptionsSchema(m.options_schema)
    }));

const enriched = await Promise.all(
  items.map(async (meal) => {
    const pricing = await getEffectivePrice(
      req,
      rid,
      {
        ...meal,
        type: "meal",
        item_type: "meals",
        base_price: Number(meal.price || 0),
      },
      req.query.order_type
    );

    return {
      ...meal,
      ...pricing,
    };
  })
);

res.json(enriched);
  } catch (e) {
    console.error("❌ GET /meals failed:", e);
    res.status(500).json({ error: "Failed to load meals" });
  }
}

async function createMealHandler(
  req,
  res
) {
  try {
    const rid =
      Number(
        req.tenantRid ||
        0
      );

    if (!rid) {
      return res
        .status(401)
        .json({
          error:
            "Missing restaurant context",
        });
    }

    const {
  name,
  ingredients = [],
  price,
  vat_rate,
  category = "Meals",
  category_id,
  paused = false,
  options_schema = [],

  availability_mode = "maks",
  manual_quantity = null,
  manually_stopped = false,
} = req.body || {};

    const cleanName =
      String(
        name || ""
      ).trim();

    if (!cleanName) {
      return res
        .status(400)
        .json({
          error:
            "name is required",
        });
    }

    const cleanPrice =
      Number(price);

    if (
      !Number.isFinite(
        cleanPrice
      ) ||
      cleanPrice < 0
    ) {
      return res
        .status(400)
        .json({
          error:
            "price must be a valid non-negative number",
        });
    }

    const cleanVatRate =
      normalizeVatRate(
        vat_rate
      );

    const cleanIngredients =
      normalizeMealIngredients(
        ingredients
      );

    if (
      cleanIngredients.length ===
      0
    ) {
      return res
        .status(400)
        .json({
          error:
            "Add at least one ingredient",
        });
    }

    const cleanSchema =
      validateOptionsSchema(
        options_schema
      );

      const availability =
  normalizeAvailabilitySettings({
    availability_mode,
    manual_quantity,
    manually_stopped,
  });

    const result =
      await withTx(
        async (tx) => {
          const categoryInfo =
            await resolveMealCategory(
              tx,
              rid,
              category_id
                ? Number(
                    category_id
                  )
                : null,
              category
            );

          const insertedMeal =
            await tx.qGet(
              `
              INSERT INTO public.meals
              (
                restaurant_id,
                user_id,

                name,
                ingredients,
                allergens,
                calories,

                price,
                vat_rate,

                category,
                category_id,

                paused,
options_schema,

availability_mode,
manual_quantity,
manually_stopped,

created_at
              )

              VALUES
              (
                $1,
                $2,

                $3,
                $4,
                $5,
                $6,

                $7,
                $8,

                $9,
                $10,

                $11,
$12,

$13,
$14,
$15,

NOW()
              )

              RETURNING id
              `,
              [
                rid,
                req.user?.id ||
                  null,

                cleanName,
                JSON.stringify(
                  []
                ),
                "None",
                0,

                Number(
                  cleanPrice.toFixed(
                    2
                  )
                ),

                cleanVatRate,

                categoryInfo.category,
                categoryInfo.category_id,

                !!paused,

                JSON.stringify(
                  cleanSchema
                ),
                availability.availability_mode,
availability.manual_quantity,
availability.manually_stopped,
              ]
            );

          const mealId =
            Number(
              insertedMeal?.id ||
              0
            );

          if (!mealId) {
            throw new Error(
              "Meal creation did not return an id."
            );
          }

          for (
            const ingredient
            of cleanIngredients
          ) {
            await tx.qRun(
              `
              INSERT INTO public.meal_ingredients
              (
                meal_id,
                ingredient,
                quantity,
                amount,
                unit,
                restaurant_id
              )

              VALUES
              (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6
              )
              `,
              [
                mealId,

                ingredient.name,

                ingredient.amount,
                ingredient.amount,

                ingredient.unit,

                rid,
              ]
            );
          }

          const nutrition =
            await refreshMealNutritionWithDb(
              tx,
              rid,
              mealId
            );

          return {
            mealId,
            nutrition,
            categoryInfo,
          };
        }
      );

    return res
      .status(201)
      .json({
        success: true,

        meal_id:
          result.mealId,

        name:
          cleanName,

        price:
          Number(
            cleanPrice.toFixed(
              2
            )
          ),

        vat_rate:
          cleanVatRate,

        category_id:
          result.categoryInfo
            .category_id,

        category:
          result.categoryInfo
            .category,

        allergens:
          result.nutrition
            .allergens,

        total_calories:
          result.nutrition
            .calories,

        ingredients:
          result.nutrition
            .ingredients,

        options_schema:
          cleanSchema,

          availability_mode:
  availability.availability_mode,

manual_quantity:
  availability.manual_quantity,

manually_stopped:
  availability.manually_stopped,

      });
  } catch (e) {
    console.error(
      "❌ POST /meals failed:",
      e
    );

    const status =
      Number(
        e?.status ||
        500
      );

    return res
      .status(status)
      .json({
        error:
          status < 500
            ? e.message
            : "Failed to create meal",
      });
  }
}

// -------------------------
// ROUTES (aliases supported)
// -------------------------

// ✅ both /meals and /meals/meals work
router.get("/", getMealsHandler);
router.get("/meals", getMealsHandler);

// ✅ create via both paths (same handler)
router.post(
  "/",

  requirePermission(
    PERMISSIONS.MENU_CREATE
  ),

  requirePricingIfPresent,

  createMealHandler
);
/**
 * GET /meals/paginated?page=1&limit=10
 * Used by MealsPage.js
 */
router.get('/paginated', async (req, res) => {
  try {
    const rid   = req.tenantRid;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;

    const rows = await qAll(
      `SELECT
         id,
         name,
         ingredients,
         allergens,
         calories,
         price,
         vat_rate,
         category,
         paused,
         photo_url,
options_schema,
availability_mode,
manual_quantity,
manually_stopped,
out_of_stock
       FROM meals
       WHERE restaurant_id = ?
       ORDER BY name ASC
       LIMIT ? OFFSET ?`,
      [rid, limit, offset]
    );

    const countRow = await qGet(
      `SELECT COUNT(*) AS total
         FROM meals
        WHERE restaurant_id = ?`,
      [rid]
    );

    const total = Number(countRow?.total || 0);
    const pages = total === 0 ? 1 : Math.ceil(total / limit);

    const items = rows.map(m => ({
      ...m,
      options_schema: parseOptionsSchema(m.options_schema)
    }));

    res.json({ items, total, page, pages, limit });
  } catch (e) {
    console.error('❌ GET /meals/paginated failed:', e.message);
    res.status(500).json({ error: 'Failed to load meals (paginated)' });
  }
});

router.get("/resolve-id", async (req, res) => {
  try {
    const rid = Number(req.tenantRid);
    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });

    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Missing name" });

    const row = await qGet(
      `
      SELECT id
      FROM meals
      WHERE restaurant_id = ?
        AND lower(trim(name)) = lower(trim(?))
      LIMIT 1
      `,
      [rid, name]
    );

    if (!row?.id) return res.status(404).json({ error: "Not found" });

    return res.json({ id: row.id });
  } catch (e) {
    console.error("❌ /meals/resolve-id failed:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// GET /meals/ingredients-by-name?name=Burger
router.get("/ingredients-by-name", async (req, res) => {
  try {
    const rid = Number(req.tenantRid);
    const name = String(req.query.name || "").trim();

    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });
    if (!name) return res.json([]);

    // Find meal id by name (tenant-safe)
    const meal = await qGet(
      `
      SELECT id
      FROM meals
      WHERE restaurant_id = ?
        AND lower(trim(name)) = lower(trim(?))
      LIMIT 1
      `,
      [rid, name]
    );

    if (!meal?.id) return res.json([]);

    // Return ingredients (match real columns)
    const rows = await qAll(
      `
      SELECT
        ingredient AS ingredient_name,
        amount    AS quantity,
        unit
      FROM meal_ingredients
      WHERE restaurant_id = ?
        AND meal_id = ?
      ORDER BY id ASC
      `,
      [rid, meal.id]
    );

    return res.json(rows || []);
  } catch (e) {
    console.error("❌ /meals/ingredients-by-name failed:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// GET /meals/:id/cost
router.get("/:id/cost", async (req, res) => {
  try {
    const rid = Number(req.tenantRid);
    const mealId = Number(req.params.id);

    if (!rid) return res.status(401).json({ error: "Missing tenant" });
    if (!Number.isFinite(mealId) || mealId <= 0) {
      return res.status(400).json({ error: "Invalid meal id" });
    }

    const meal = await qGet(
      `SELECT id, name, price
       FROM meals
       WHERE restaurant_id = ? AND id = ?`,
      [rid, mealId]
    );

    if (!meal) return res.status(404).json({ error: "Meal not found" });

    const rows = await qAll(
      `
      SELECT
        mi.ingredient,
        mi.amount,
        mi.unit,
        COALESCE(s.price, 0) AS stock_price,
        COALESCE(s.quantity, 0) AS stock_quantity
      FROM meal_ingredients mi
      LEFT JOIN stock s
        ON s.restaurant_id = mi.restaurant_id
       AND LOWER(TRIM(s.ingredient)) = LOWER(TRIM(mi.ingredient))
      WHERE mi.restaurant_id = ?
        AND mi.meal_id = ?
      ORDER BY mi.id ASC
      `,
      [rid, mealId]
    );

    const breakdown = (rows || []).map((r) => {
      const amount = Number(r.amount || 0);
      const stockPrice = Number(r.stock_price || 0);
      const stockQty = Number(r.stock_quantity || 0);

      const lineCost = amount * stockPrice;
      const possiblePortions =
        amount > 0 && stockQty > 0 ? Math.floor(stockQty / amount) : null;

      return {
        ingredient: r.ingredient,
        amount,
        unit: r.unit,
        stock_price: stockPrice,
        stock_quantity: stockQty,
        line_cost: Number(lineCost.toFixed(4)),
        possible_portions: possiblePortions,
      };
    });

    const totalCost = breakdown.reduce(
      (sum, r) => sum + Number(r.line_cost || 0),
      0
    );

    const portionValues = breakdown
      .map((r) => r.possible_portions)
      .filter((v) => Number.isFinite(Number(v)));

    const portionsLeft = portionValues.length
      ? Math.min(...portionValues)
      : null;

    res.json({
      meal_id: meal.id,
      meal_name: meal.name,
      selling_price: Number(meal.price || 0),
      total_cost: Number(totalCost.toFixed(4)),
      portions_left: portionsLeft,
      breakdown,
    });
  } catch (e) {
    console.error("❌ GET /meals/:id/cost failed:", e);
    res.status(500).json({ error: "Failed to calculate meal cost" });
  }
});
/**
 * GET /meals/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const rid = req.tenantRid;
const id = Number(req.params.id);
if (!Number.isFinite(id) || id <= 0) {
  return res.status(400).json({ error: "Invalid meal id" });
}

    const meal = await qGet(
      `SELECT
         id,
         name,
         ingredients,
         allergens,
         calories,
         price,
         vat_rate,
         category,
         paused,
         photo_url,
options_schema,
availability_mode,
manual_quantity,
manually_stopped,
out_of_stock
       FROM meals
       WHERE restaurant_id = ? AND id = ?`,
      [rid, id]
    );

    if (!meal) return res.status(404).json({ error: 'Meal not found' });

    meal.options_schema = parseOptionsSchema(meal.options_schema);
    res.json(meal);
  } catch (e) {
    console.error('❌ GET /meals/:id failed:', e.message);
    res.status(500).json({ error: 'Failed to load meal' });
  }
});

// GET /meals/ingredient-search?q=co
router.get('/ingredient-search', async (req, res) => {
  try {
    const rid = req.tenantRid;
    const q = String(req.query.q || '').trim().toLowerCase();

    if (!q || q.length < 2) return res.json([]);

    // Pull suggestions from STOCK (best source for ingredient names)
    const rows = await qAll(
      `
      SELECT DISTINCT
        LOWER(TRIM(COALESCE(ingredient, name))) AS value
      FROM stock
      WHERE restaurant_id = ?
        AND COALESCE(ingredient, name) IS NOT NULL
        AND LOWER(TRIM(COALESCE(ingredient, name))) LIKE ?
      ORDER BY value ASC
      LIMIT 20
      `,
      [rid, `%${q}%`]
    );

    res.json((rows || []).map(r => r.value).filter(Boolean));
  } catch (e) {
    console.error('❌ GET /meals/ingredient-search failed:', e);
    res.status(500).json({ error: 'Failed ingredient search' });
  }
});

/**
 * PUT /meals/:id
 * Update meal – only owner/admin/chef
 */
router.put(
  "/:id",

  requirePermission(
    PERMISSIONS.MENU_EDIT
  ),

  requirePricingIfPresent,

  async (req, res) => {
    try {
      const rid =
        Number(
          req.tenantRid ||
          0
        );

      const id =
        Number(
          req.params.id
        );

      if (!rid) {
        return res
          .status(401)
          .json({
            error:
              "Missing restaurant context",
          });
      }

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid meal id",
          });
      }

      const {
  name,
  ingredients,
  allergens,
  calories,
  price,
  vat_rate,
  category,
  category_id,
  paused,
  options_schema,
  photo_url,

  availability_mode,
  manual_quantity,
  manually_stopped,
} = req.body || {};

      const result =
        await withTx(
          async (tx) => {
            const existing =
  await tx.qGet(
    `
      SELECT
        id,
        name,
        price,
        vat_rate,
        category,
        category_id,
        availability_mode,
        manual_quantity,
        manually_stopped

      FROM public.meals

      WHERE restaurant_id = $1
        AND id = $2

      FOR UPDATE
    `,
    [
      rid,
      id,
    ]
  );

            if (!existing) {
              const err =
                new Error(
                  "Meal not found"
                );

              err.status = 404;

              throw err;
            }

            const sets = [];
            const params = [];

            let paramIndex = 1;

            const setField = (
              column,
              value
            ) => {
              sets.push(
                `${column} = $${paramIndex++}`
              );

              params.push(
                value
              );
            };

            if (
              name !==
              undefined
            ) {
              const cleanName =
                String(
                  name || ""
                ).trim();

              if (!cleanName) {
                const err =
                  new Error(
                    "Meal name cannot be empty."
                  );

                err.status = 400;

                throw err;
              }

              setField(
                "name",
                cleanName
              );
            }

            if (
              price !==
              undefined
            ) {
              const cleanPrice =
                Number(price);

              if (
                !Number.isFinite(
                  cleanPrice
                ) ||
                cleanPrice < 0
              ) {
                const err =
                  new Error(
                    "price must be a valid non-negative number"
                  );

                err.status = 400;

                throw err;
              }

              setField(
                "price",
                Number(
                  cleanPrice.toFixed(
                    2
                  )
                )
              );
            }

            if (
              vat_rate !==
              undefined
            ) {
              setField(
                "vat_rate",
                normalizeVatRate(
                  vat_rate
                )
              );
            }

            if (
              category_id !==
              undefined
            ) {
              const categoryInfo =
                await resolveMealCategory(
                  tx,
                  rid,

                  category_id
                    ? Number(
                        category_id
                      )
                    : null,

                  category ??
                  existing.category
                );

              setField(
                "category_id",
                categoryInfo.category_id
              );

              setField(
                "category",
                categoryInfo.category
              );
            } else if (
              category !==
              undefined
            ) {
              setField(
                "category",
                String(
                  category ||
                  "Meals"
                ).trim()
              );
            }

            if (
              paused !==
              undefined
            ) {
              setField(
                "paused",
                !!paused
              );
            }

            if (
              photo_url !==
              undefined
            ) {
              setField(
                "photo_url",
                photo_url
                  ? String(
                      photo_url
                    ).trim()
                  : null
              );
            }

            if (
              options_schema !==
              undefined
            ) {
              const cleanSchema =
                validateOptionsSchema(
                  options_schema
                );

              setField(
                "options_schema",
                JSON.stringify(
                  cleanSchema
                )
              );
            }

            if (
  availability_mode !== undefined ||
  manual_quantity !== undefined ||
  manually_stopped !== undefined
) {
  const availability =
    normalizeAvailabilitySettings({
      availability_mode:
        availability_mode !== undefined
          ? availability_mode
          : existing.availability_mode,

      manual_quantity:
        manual_quantity !== undefined
          ? manual_quantity
          : existing.manual_quantity,

      manually_stopped:
        manually_stopped !== undefined
          ? manually_stopped
          : existing.manually_stopped,
    });

  setField(
    "availability_mode",
    availability.availability_mode
  );

  setField(
    "manual_quantity",
    availability.manual_quantity
  );

  setField(
    "manually_stopped",
    availability.manually_stopped
  );
}
            /*
             * Preserve backward compatibility:
             * direct allergen/calorie edits still work
             * when ingredients themselves are NOT being replaced.
             *
             * If ingredients are supplied below,
             * authoritative nutrition recalculation overrides them.
             */
            if (
              ingredients ===
                undefined &&
              allergens !==
                undefined
            ) {
              setField(
                "allergens",
                String(
                  allergens ||
                  "None"
                )
              );
            }

            if (
              ingredients ===
                undefined &&
              calories !==
                undefined
            ) {
              const cleanCalories =
                Number(calories);

              setField(
                "calories",
                Number.isFinite(
                  cleanCalories
                )
                  ? cleanCalories
                  : null
              );
            }

            if (
              sets.length
            ) {
              params.push(
                rid,
                id
              );

              const ridIndex =
                paramIndex++;

              const idIndex =
                paramIndex++;

              await tx.qRun(
                `
                UPDATE public.meals

                SET
                  ${sets.join(", ")}

                WHERE restaurant_id =
                      $${ridIndex}

                  AND id =
                      $${idIndex}
                `,
                params
              );
            }

            let nutrition =
              null;

            if (
              ingredients !==
              undefined
            ) {
              const cleanIngredients =
                normalizeMealIngredients(
                  ingredients
                );

              if (
                cleanIngredients.length ===
                0
              ) {
                const err =
                  new Error(
                    "A meal must contain at least one ingredient."
                  );

                err.status = 400;

                throw err;
              }

              await tx.qRun(
                `
                DELETE
                FROM public.meal_ingredients

                WHERE restaurant_id = $1
                  AND meal_id = $2
                `,
                [
                  rid,
                  id,
                ]
              );

              /*
               * IMPORTANT:
               * insert first,
               * calculate nutrition second.
               *
               * This fixes the old bug.
               */
              for (
                const ingredient
                of cleanIngredients
              ) {
                await tx.qRun(
                  `
                  INSERT INTO public.meal_ingredients
                  (
                    meal_id,
                    ingredient,
                    quantity,
                    amount,
                    unit,
                    restaurant_id
                  )

                  VALUES
                  (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                  )
                  `,
                  [
                    id,

                    ingredient.name,

                    ingredient.amount,
                    ingredient.amount,

                    ingredient.unit,

                    rid,
                  ]
                );
              }

              nutrition =
                await refreshMealNutritionWithDb(
                  tx,
                  rid,
                  id
                );
            }

            const updated =
              await tx.qGet(
                `
                SELECT
                  id,
                  name,

                  ingredients,
                  allergens,
                  calories,

                  price,
                  vat_rate,

                  category,
                  category_id,

                  paused,
photo_url,
options_schema,

availability_mode,
manual_quantity,
manually_stopped,
out_of_stock

                FROM public.meals

                WHERE restaurant_id = $1
                  AND id = $2

                LIMIT 1
                `,
                [
                  rid,
                  id,
                ]
              );

            return {
              updated,
              nutrition,
            };
          }
        );

      const meal =
        result.updated;

      return res.json({
        success: true,

        meal: {
          ...meal,

          options_schema:
            parseOptionsSchema(
              meal?.options_schema
            ),
        },
      });
    } catch (e) {
      console.error(
        "❌ PUT /meals/:id failed:",
        e
      );

      const status =
        Number(
          e?.status ||
          500
        );

      return res
        .status(status)
        .json({
          error:
            status < 500
              ? e.message
              : "Failed to update meal",
        });
    }
  }
);

/**
 * DELETE /meals/:id
 * Only owner/admin
 */
router.delete(
  "/:id",

  requirePermission(
    PERMISSIONS.MENU_DELETE
  ),

  async (req, res) => {
  try {
    const rid = req.tenantRid;
    const id  = Number(req.params.id);

    const r = await qRun(
      `DELETE FROM meals WHERE id = ? AND restaurant_id = ?`,
      [id, rid]
    );

    if (!r.changes) return res.status(404).json({ error: 'Meal not found' });

    res.json({ success: true });
  } catch (e) {
    console.error('❌ DELETE /meals/:id failed:', e.message);
    res.status(500).json({ error: 'Failed to delete meal' });
  }
});

// GET /meals/:id/ingredients
router.get('/:id/ingredients', async (req, res) => {
  try {
    const rid = req.tenantRid;
    const mealId = Number(req.params.id);
if (!Number.isFinite(mealId) || mealId <= 0) {
  return res.status(400).json({ error: "Invalid meal id" });
}

    const rows = await qAll(
  `SELECT id, meal_id, ingredient, amount AS quantity, unit
   FROM meal_ingredients
   WHERE restaurant_id = ? AND meal_id = ?
   ORDER BY id ASC`,
  [rid, mealId]
);


    res.json(rows || []);
  } catch (e) {
    console.error('❌ GET /meals/:id/ingredients failed:', e.message);
    res.status(500).json({ error: 'Failed to load meal ingredients' });
  }
}
);

// ✅ GET /meals/by-category/:categoryId
router.get("/by-category/:categoryId", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);
    const categoryId = Number(req.params.categoryId || 0);

    if (!rid) return res.status(400).json({ error: "Missing rid" });
    if (!categoryId) return res.status(400).json({ error: "Invalid category id" });

    const isPg = req.kind === "pg";

    const sql = isPg
      ? `
        SELECT
  id,
  name,
  price,
  vat_rate,
  category_id,
  options_schema,

availability_mode,
manual_quantity,
manually_stopped,

out_of_stock,
photo_url
        FROM public.meals
        WHERE restaurant_id = $1 AND category_id = $2
        ORDER BY id DESC
      `
      : `
SELECT
  id,
  name,
  price,
  vat_rate,
  category_id,
  options_schema,

availability_mode,
manual_quantity,
manually_stopped,

out_of_stock,
photo_url
          FROM meals
        WHERE restaurant_id = ? AND category_id = ?
        ORDER BY id DESC
      `;

    const rows = await req.qAll(sql, [rid, categoryId]);

    const enriched = await Promise.all(
  (rows || []).map(async (meal) => {
    let portions_left = null;

    try {
      portions_left = await getMealPortionsLeft(req, meal.id, rid);
    } catch (err) {
      console.error(`❌ portions_left calc failed for meal ${meal.id}:`, err.message);
      portions_left = null;
    }

    const pricing = await getEffectivePrice(
      req,
      rid,
      {
        ...meal,
        type: "meal",
        category: "meals",
      },
      req.query.order_type
    );

    return {
      ...meal,
      ...pricing,
      portions_left,
    };
  })
);

    res.json(enriched);
  } catch (e) {
    console.error("❌ GET /meals/by-category failed:", e);
    res.status(500).json({ error: "Failed to load meals by category" });
  }
});
module.exports = router;
