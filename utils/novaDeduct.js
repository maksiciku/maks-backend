// utils/novaDeduct.js
const { kind } = require("../dbCompat");

const toNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

let MEAL_ING_COLS = null;

async function detectMealIngredientsColumns(db) {
  if (MEAL_ING_COLS) return MEAL_ING_COLS;

  if (kind === "pg") {
    const cols = await db.qAll(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'meal_ingredients'
      `
    );

    const names = new Set((cols || []).map((c) => String(c.column_name).toLowerCase()));

    const nameCandidates = ["ingredient", "ingredient_name", "name", "ingredient_label"];
    const qtyCandidates = [
      "quantity",          // ✅ preferred
      "amount",
      "quantity_per_meal",
      "qty_per_meal",
      "quantity_per_item",
      "qty_per_item",
      "qty",
    ];

    const nameCol = nameCandidates.find((n) => names.has(n));
    const qtyCol = qtyCandidates.find((n) => names.has(n));

    if (!nameCol || !qtyCol) {
      throw new Error(
        `meal_ingredients schema unsupported (PG). Found columns: ${[...names].join(", ")}`
      );
    }

    MEAL_ING_COLS = { nameCol, qtyCol };
    return MEAL_ING_COLS;
  }

  // SQLite fallback
  const cols = await db.qAll(`PRAGMA table_info(meal_ingredients)`);
  const names = new Set((cols || []).map((c) => String(c.name).toLowerCase()));

  const nameCandidates = ["ingredient", "ingredient_name", "name", "ingredient_label"];
  const qtyCandidates = [
    "quantity",
    "amount",
    "quantity_per_meal",
    "qty_per_meal",
    "quantity_per_item",
    "qty_per_item",
    "qty",
  ];

  const nameCol = nameCandidates.find((n) => names.has(n));
  const qtyCol = qtyCandidates.find((n) => names.has(n));

  if (!nameCol || !qtyCol) {
    throw new Error(
      `meal_ingredients schema unsupported (SQLite). Found columns: ${[...names].join(", ")}`
    );
  }

  MEAL_ING_COLS = { nameCol, qtyCol };
  return MEAL_ING_COLS;
}

async function getMealPortionsLeft(db, mealId, restaurantId = 1) {
  const mealIdNum = toNumber(mealId, NaN);
  const ridNum = toNumber(restaurantId, 1);

  if (!Number.isFinite(mealIdNum)) return null;

  const { nameCol, qtyCol } = await detectMealIngredientsColumns(db);

  const recipeRows = await db.qAll(
    `
    SELECT ${nameCol} AS ingredient_name,
           ${qtyCol}  AS quantity_per_meal
    FROM meal_ingredients
    WHERE restaurant_id = ?
      AND meal_id = ?
    `,
    [ridNum, mealIdNum]
  );

  if (!recipeRows.length) {
    return null; // no recipe = unknown, let manual lock handle it
  }

  let minPortions = Infinity;
  const warnings = [];

  for (const row of recipeRows) {
    const ingName = String(row.ingredient_name || "").trim();
    const perMeal = toNumber(row.quantity_per_meal, 0);

    if (!ingName || perMeal <= 0) continue;

    const stockRow = await db.qGet(
      `
      SELECT id, ingredient, quantity
      FROM stock
      WHERE restaurant_id = ?
        AND LOWER(TRIM(ingredient)) = LOWER(TRIM(?))
      LIMIT 1
      `,
      [ridNum, ingName]
    );

const stockQty = toNumber(stockRow?.quantity, 0);
const possible = perMeal > 0 ? Math.floor(stockQty / perMeal) : 0;

console.log("📦 PORTIONS LEFT DEBUG:", {
  ingredientNeeded: ingName,
  perMeal,
  stockQty,
  possible,
  stockRow,
});
    if (!stockRow) {
      warnings.push(`Missing stock row for "${ingName}"`);
      minPortions = 0;
      continue;
    }

    if (possible < minPortions) {
      minPortions = possible;
    }
  }

  if (minPortions === Infinity) return null;

  return Math.max(0, minPortions);
}
// ----------------------------
// ✅ Atomic deduct helper (PG)
// ----------------------------
async function atomicDeductStockById(db, { stockId, restaurantId, need, clampZero = true }) {
  if (kind === "pg") {
    // lock row + update atomically
    // NOTE: uses ? placeholders - dbCompat converts to $1.. automatically
    const row = await db.qGet(
      `
      SELECT id, ingredient, quantity
      FROM stock
      WHERE restaurant_id = ?
        AND id = ?
      FOR UPDATE
      `,
      [restaurantId, stockId]
    );

    if (!row) return { ok: false, row: null };

    const current = toNumber(row.quantity, 0);
    let next = current - need;
    if (clampZero && next < 0) next = 0;

    await db.qRun(
      `
      UPDATE stock
      SET quantity = ?
      WHERE restaurant_id = ?
        AND id = ?
      `,
      [next, restaurantId, stockId]
    );

    return { ok: true, row, current, next };
  }

  // SQLite fallback
  const row = await db.qGet(
    `
    SELECT id, ingredient, quantity
    FROM stock
    WHERE restaurant_id = ?
      AND id = ?
    LIMIT 1
    `,
    [restaurantId, stockId]
  );
  if (!row) return { ok: false, row: null };

  const current = toNumber(row.quantity, 0);
  let next = current - need;
  if (clampZero && next < 0) next = 0;

  await db.qRun(
    `UPDATE stock SET quantity = ? WHERE restaurant_id = ? AND id = ?`,
    [next, restaurantId, stockId]
  );

  return { ok: true, row, current, next };
}

async function atomicDeductStockByName(db, { ingredientName, restaurantId, need, clampZero = true }) {
  if (kind === "pg") {
    const row = await db.qGet(
      `
      SELECT id, ingredient, quantity
      FROM stock
      WHERE restaurant_id = ?
        AND LOWER(TRIM(ingredient)) = LOWER(TRIM(?))
      FOR UPDATE
      `,
      [restaurantId, ingredientName]
    );

    if (!row) return { ok: false, row: null };

    const current = toNumber(row.quantity, 0);
    let next = current - need;
    if (clampZero && next < 0) next = 0;

    await db.qRun(
      `UPDATE stock SET quantity = ? WHERE restaurant_id = ? AND id = ?`,
      [next, restaurantId, row.id]
    );

    return { ok: true, row, current, next };
  }

  // SQLite fallback
  const row = await db.qGet(
    `
    SELECT id, ingredient, quantity
    FROM stock
    WHERE restaurant_id = ?
      AND LOWER(TRIM(ingredient)) = LOWER(TRIM(?))
    LIMIT 1
    `,
    [restaurantId, ingredientName]
  );

  if (!row) return { ok: false, row: null };

  const current = toNumber(row.quantity, 0);
  let next = current - need;
  if (clampZero && next < 0) next = 0;

  await db.qRun(
    `UPDATE stock SET quantity = ? WHERE restaurant_id = ? AND id = ?`,
    [next, restaurantId, row.id]
  );

  return { ok: true, row, current, next };
}

/**
 * ✅ Deduct by stock.id (best)
 */
async function deductStockByStockId(db, stockId, qty, restaurantId = 1, opts = {}) {
  const rid = toNumber(restaurantId, 1);
  const sid = toNumber(stockId, NaN);
  const q = toNumber(qty, 0);
  const clampZero = opts?.clampZero !== false;

  if (!Number.isFinite(sid) || q <= 0) {
    return { success: false, deducted: [], warnings: [`Invalid inputs stockId=${stockId} qty=${qty}`] };
  }

  const deducted = [];
  const warnings = [];

  const r = await atomicDeductStockById(db, { stockId: sid, restaurantId: rid, need: q, clampZero });

  if (!r.ok) {
    return { success: true, deducted: [], warnings: [`Stock id=${sid} not found (rid=${rid})`] };
  }

  deducted.push({
    stock_id: r.row.id,
    ingredient: r.row.ingredient,
    was: r.current,
    need: q,
    now: r.next
  });

  if (clampZero && r.next === 0 && r.current - q < 0) {
    warnings.push(`Clamped "${r.row.ingredient}" to 0 (was ${r.current}, need ${q})`);
  }

  return { success: true, deducted, warnings };
}

/**
 * ✅ Name fallback (exact normalized match)
 */
async function deductStockByItemName(db, itemName, qty, restaurantId = 1, opts = {}) {
  const rid = toNumber(restaurantId, 1);
  const q = toNumber(qty, 0);
  const clampZero = opts?.clampZero !== false;
  const name = String(itemName || "").trim();

  if (!name || q <= 0) return { success: false, deducted: [], warnings: ["Invalid itemName/qty"] };

  const r = await atomicDeductStockByName(db, { ingredientName: name, restaurantId: rid, need: q, clampZero });

  if (!r.ok) {
    return { success: true, deducted: [], warnings: [`Stock not found for "${name}" (rid=${rid})`] };
  }

  const deducted = [{
    stock_id: r.row.id,
    ingredient: r.row.ingredient,
    was: r.current,
    need: q,
    now: r.next
  }];

  const warnings = [];
  if (clampZero && r.next === 0 && r.current - q < 0) {
    warnings.push(`Clamped "${r.row.ingredient}" to 0 (was ${r.current}, need ${q})`);
  }

  return { success: true, deducted, warnings };
}

/**
 * ✅ MAIN: Deduct stock for a meal via meal_ingredients recipe
 */
async function deductStockFromMealOrder(db, mealId, qty, restaurantId = 1, opts = {}) {
  const mealIdNum = toNumber(mealId, NaN);
  const qtyNum = toNumber(qty, 0);
  const ridNum = toNumber(restaurantId, 1);
  const clampZero = opts?.clampZero !== false;

  if (!Number.isFinite(mealIdNum) || qtyNum <= 0) {
    return { success: false, deducted: [], warnings: [`Invalid inputs mealId=${mealId} qty=${qty}`] };
  }

  const { nameCol, qtyCol } = await detectMealIngredientsColumns(db);

  const rows = await db.qAll(
  `
  SELECT ${nameCol} AS ingredient_name,
         ${qtyCol} AS quantity_per_meal,
         COALESCE(unit, 'g') AS unit
  FROM meal_ingredients
  WHERE restaurant_id = ?
    AND meal_id = ?
  `,
  [ridNum, mealIdNum]
);

  console.log("🥘 MEAL DEDUCT RECIPE DEBUG:", {
  restaurantId: ridNum,
  mealId: mealIdNum,
  qtyOrdered: qtyNum,
  nameCol,
  qtyCol,
  rows,
});
  if (!rows.length) {
    return {
      success: true,
      deducted: [],
      warnings: [`No recipe for meal_id=${mealIdNum} (rid=${ridNum})`],
    };
  }

  const deducted = [];
  const warnings = [];

  for (const r of rows) {
    const ingName = String(r.ingredient_name || "").trim();
    const perMeal = toNumber(r.quantity_per_meal, 0);
    const recipeUnit = String(r.unit || "g").toLowerCase();
    if (!ingName || perMeal <= 0) continue;

const need = perMeal * qtyNum;

    const result = await atomicDeductStockByName(db, {
      ingredientName: ingName,
      restaurantId: ridNum,
      need,
      clampZero
    });

    if (!result.ok) {
      warnings.push(`Stock not found for "${ingName}" (rid=${ridNum})`);
      continue;
    }

    deducted.push({
      stock_id: result.row.id,
      ingredient: result.row.ingredient,
      was: result.current,
      need,
      now: result.next,
    });

    if (clampZero && result.next === 0 && result.current - need < 0) {
      warnings.push(`Clamped "${result.row.ingredient}" to 0 (was ${result.current}, need ${need})`);
    }
  }

  return { success: true, deducted, warnings };
}

async function deductStockFromMenuItem(tx, menuItemId, qty, restaurantId) {
  const rep = { deducted: [], warnings: [] };

  const cols = await tx.qAll(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'menu_item_ingredients'
  `);

  const names = new Set((cols || []).map(c => String(c.column_name).toLowerCase()));

  const hasStockId = names.has("stock_id");
  const qtyCol =
    names.has("amount") ? "amount" :
    names.has("quantity") ? "quantity" :
    names.has("qty") ? "qty" :
    null;

  if (!qtyCol) {
    rep.warnings.push({
      type: "MENU_ITEM_INGREDIENTS_SCHEMA_ERROR",
      message: "menu_item_ingredients has no amount/quantity/qty column",
    });
    return rep;
  }

 const rows = await tx.qAll(
  `
  SELECT
    mii.stock_id,
    mii.ingredient,
    COALESCE(mii.amount, 0) AS amount,
    COALESCE(mii.unit, 'unit') AS unit
  FROM menu_item_ingredients mii
  WHERE mii.restaurant_id = ?
    AND mii.menu_item_id = ?
  `,
  [restaurantId, menuItemId]
);

  if (!rows?.length) {
    rep.warnings.push({ type: "NO_RECIPE", menuItemId });
    return rep;
  }

  for (const r of rows) {
    const stockId = Number(r.stock_id || 0) || null;
    const ingredient = String(r.ingredient || "").trim();
    const perItem = Number(r.amount || 0);
    const needed = perItem * Number(qty || 1);

    if (needed <= 0) continue;

    let stockRow = null;

    if (stockId) {
      stockRow = await tx.qGet(
        `
        SELECT id, ingredient, quantity
        FROM stock
        WHERE restaurant_id = ?
          AND id = ?
        FOR UPDATE
        `,
        [restaurantId, stockId]
      );
    }

    if (!stockRow && ingredient) {
      stockRow = await tx.qGet(
        `
        SELECT id, ingredient, quantity
        FROM stock
        WHERE restaurant_id = ?
          AND LOWER(TRIM(ingredient)) = LOWER(TRIM(?))
        FOR UPDATE
        `,
        [restaurantId, ingredient]
      );
    }

    if (!stockRow) {
      rep.warnings.push({
        type: "MISSING_STOCK_ITEM",
        menuItemId,
        stockId,
        ingredient,
        needed,
      });
      continue;
    }

    const before = Number(stockRow.quantity || 0);
    const after = Math.max(0, before - needed);

    console.log("🥤 MENU ITEM DEDUCT RECIPE DEBUG:", {
  restaurantId,
  menuItemId,
  qtyOrdered: qty,
  rows,
});
    await tx.qRun(
      `
      UPDATE stock
      SET quantity = ?
      WHERE restaurant_id = ?
        AND id = ?
      `,
      [after, restaurantId, stockRow.id]
    );

    rep.deducted.push({
      stock_id: stockRow.id,
      ingredient: stockRow.ingredient,
      was: before,
      need: needed,
      now: after,
      unit: r.unit || "unit",
    });
  }

  return rep;
}

module.exports = {
  deductStockFromMealOrder,
  deductStockFromMenuItem,
  deductStockByItemName,
  deductStockByStockId,
  getMealPortionsLeft,
};
