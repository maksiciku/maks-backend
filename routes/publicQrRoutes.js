const express = require("express");
const crypto = require("crypto");
const { qAll, qGet, qRun, withTx, kind } = require("../dbCompat");
const {
  buildCanonicalCart,
  PricingError,
} = require("../services/orderPricingService");
const { detectAllergenCodesFromName } = require("../utils/novaAllergens");
const {
  deductStockFromMealOrder,
  deductStockByItemName,
  getMealPortionsLeft,
} = require("../utils/novaDeduct");

const router = express.Router();

/*
 * =====================================================
 * PUBLIC ORDER RESOURCE LIMITS
 * =====================================================
 */

const MAX_PUBLIC_ORDER_LINES =
  100;

const ALLOWED_ALLERGEN_CODES = [
  "celery",
  "gluten",
  "crustaceans",
  "egg",
  "fish",
  "lupin",
  "milk",
  "molluscs",
  "mustard",
  "tree_nuts",
  "peanuts",
  "sesame",
  "soy",
  "sulphites",
];

const dayKeyNow = () => {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return days[new Date().getDay()];
};

const minutesNow = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const timeToMinutes = (v) => {
  if (!v) return null;
  const [h, m] = String(v).slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  return h * 60 + (Number.isFinite(m) ? m : 0);
};

const groupOpenNow = (g, surface) => {
  if (g.is_active === false) return false;

  if (surface === "qr" && g.show_qr === false) return false;
  if (surface === "kiosk" && g.show_kiosk === false) return false;
  if (surface === "pos" && g.show_pos === false) return false;

  const today = new Date().toISOString().slice(0, 10);

  if (g.start_date && String(g.start_date).slice(0, 10) > today) return false;
  if (g.end_date && String(g.end_date).slice(0, 10) < today) return false;

  const activeDays = Array.isArray(g.active_days) ? g.active_days : [];

  if (activeDays.length && !activeDays.includes(dayKeyNow())) {
    return false;
  }

  const start = timeToMinutes(g.start_time);
  const end = timeToMinutes(g.end_time);
  const now = minutesNow();

  if (start === null || end === null) return true;

  if (start <= end) {
    return now >= start && now <= end;
  }

  return now >= start || now <= end;
};

// GET /public/qr/:restaurantId/active-categories?surface=qr
router.get("/:restaurantId/active-categories", async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId || 0);
    const surface = ["qr", "kiosk", "pos"].includes(String(req.query.surface))
      ? String(req.query.surface)
      : "qr";

    await assertRestaurantActive(restaurantId);

    const groups = await qAll(
      kind === "pg"
        ? `
          SELECT *
          FROM public.menu_groups
          WHERE restaurant_id = $1
          ORDER BY priority DESC, sort_order ASC, name ASC
        `
        : `
          SELECT *
          FROM menu_groups
          WHERE restaurant_id = ?
          ORDER BY priority DESC, sort_order ASC, name ASC
        `,
      [restaurantId]
    );

    const allGroups = Array.isArray(groups) ? groups : [];
    const openGroups = allGroups.filter((g) => groupOpenNow(g, surface));

    if (allGroups.length && !openGroups.length) {
      return res.json([]);
    }

    if (!allGroups.length) {
      const rows = await qAll(
        kind === "pg"
          ? `
            SELECT id, name, icon, type
            FROM public.categories
            WHERE restaurant_id = $1
            ORDER BY id ASC
          `
          : `
            SELECT id, name, icon, type
            FROM categories
            WHERE restaurant_id = ?
            ORDER BY id ASC
          `,
        [restaurantId]
      );

      return res.json(rows || []);
    }

    const ids = openGroups.map((g) => Number(g.id)).filter(Boolean);
    const marks =
      kind === "pg"
        ? ids.map((_, i) => `$${i + 2}`).join(",")
        : ids.map(() => "?").join(",");

    const rows = await qAll(
      kind === "pg"
        ? `
          SELECT DISTINCT
            c.id,
            c.name,
            c.icon,
            c.type,
            MIN(mgc.sort_order) AS sort_order
          FROM public.menu_group_categories mgc
          JOIN public.categories c
            ON c.id = mgc.category_id
           AND c.restaurant_id = mgc.restaurant_id
          WHERE mgc.restaurant_id = $1
            AND mgc.menu_group_id IN (${marks})
          GROUP BY c.id, c.name, c.icon, c.type
          ORDER BY sort_order ASC, c.name ASC
        `
        : `
          SELECT DISTINCT
            c.id,
            c.name,
            c.icon,
            c.type,
            MIN(mgc.sort_order) AS sort_order
          FROM menu_group_categories mgc
          JOIN categories c
            ON c.id = mgc.category_id
           AND c.restaurant_id = mgc.restaurant_id
          WHERE mgc.restaurant_id = ?
            AND mgc.menu_group_id IN (${marks})
          GROUP BY c.id, c.name, c.icon, c.type
          ORDER BY sort_order ASC, c.name ASC
        `,
      kind === "pg" ? [restaurantId, ...ids] : [restaurantId, ...ids]
    );

    res.json(rows || []);
  } catch (err) {
    console.error("❌ public active categories failed:", err);
    res.status(400).json({
      error: err.message || "Failed to load active menu",
    });
  }
});

function sanitizeAllergenCodes(arr = []) {
  return Array.from(
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((x) => String(x || "").trim().toLowerCase())
        .filter((x) => ALLOWED_ALLERGEN_CODES.includes(x))
    )
  );
}

function canonicalTableName(input) {
  if (input == null) return "Takeaway";
  const s = String(input).trim();
  if (/^delivery$/i.test(s)) return "Delivery";
  if (/^takeaway$/i.test(s)) return "Takeaway";
  const m = s.match(/\d+/);
  return m ? `Table ${Number(m[0])}` : s;
}

function normalizeType(type) {
  const s = String(type || "").toLowerCase();
  if (s.startsWith("drink")) return "drinks";
  if (s.startsWith("dessert")) return "desserts";
  return "meals";
}

function extractPublicPricingOptions(options) {
  let parsed = options ?? {};

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return {};
  }

  // OptionsWizard shape:
  // {
  //   display: {...},
  //   raw: {...},
  //   meta: {...}
  // }
  //
  // Only raw IDs are authoritative.
  if (
    parsed.raw &&
    typeof parsed.raw === "object" &&
    !Array.isArray(parsed.raw)
  ) {
    return parsed.raw;
  }

  return parsed;
}

function buildPublicPricingItems(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const rawType = normalizeType(
      item.item_type ||
      item.category ||
      item.type
    );

    const mealId =
      Number(
        item.meal_id ||
        0
      ) || null;

    const menuItemId =
      Number(
        item.menu_item_id ||
        0
      ) || null;

    return {
      /*
       * IMPORTANT:
       * Backend pricing decides identity/price/name.
       *
       * Browser may only nominate an ID + quantity +
       * raw selected options.
       */
      item_source:
        mealId
          ? "meals"
          : "menu_items",

      source:
        mealId
          ? "meals"
          : "menu_items",

      meal_id:
        mealId,

      menu_item_id:
        menuItemId,

      item_type:
        rawType,

      category:
        rawType,

      quantity:
        Math.max(
          1,
          Number.parseInt(
            item.quantity,
            10
          ) || 1
        ),

      options:
        extractPublicPricingOptions(
          item.options
        ),

      note:
        item.note
          ? String(
              item.note
            ).trim()
          : null,
    };
  });
}

async function assertRestaurantActive(
  restaurantId
) {
  if (
    !Number.isInteger(
      Number(
        restaurantId
      )
    ) ||
    Number(
      restaurantId
    ) <= 0
  ) {
    const err =
      new Error(
        "Invalid restaurant id."
      );

    err.status =
      400;

    err.code =
      "INVALID_RESTAURANT_ID";

    throw err;
  }

  const row =
    await qGet(
      kind === "pg"
        ? `
          SELECT
            id,
            account_status
          FROM public.restaurants
          WHERE id = $1
          LIMIT 1
          `
        : `
          SELECT
            id,
            account_status
          FROM restaurants
          WHERE id = ?
          LIMIT 1
          `,
      [
        restaurantId,
      ]
    );

  if (!row?.id) {
    const err =
      new Error(
        "Restaurant not found."
      );

    err.status =
      404;

    err.code =
      "RESTAURANT_NOT_FOUND";

    throw err;
  }

  const status =
    String(
      row.account_status ||
      "active"
    )
      .trim()
      .toLowerCase();

  if (
    status !==
    "active"
  ) {
    const err =
      new Error(
        "Restaurant is not active."
      );

    err.status =
      403;

    err.code =
      "RESTAURANT_NOT_ACTIVE";

    throw err;
  }

  return row;
}

router.get("/:restaurantId/categories", async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId || 0);
    await assertRestaurantActive(restaurantId);

    const rows = await qAll(
      kind === "pg"
        ? `
          SELECT id, name, icon, type
          FROM public.categories
          WHERE restaurant_id = $1
          ORDER BY id ASC
        `
        : `
          SELECT id, name, icon, type
          FROM categories
          WHERE restaurant_id = ?
          ORDER BY id ASC
        `,
      [restaurantId]
    );

    res.json(rows || []);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to load categories" });
  }
});

router.get("/:restaurantId/allergens", async (_req, res) => {
  res.json([
    { code: "celery", label: "Celery", icon: "🥬" },
    { code: "gluten", label: "Gluten", icon: "🌾" },
    { code: "crustaceans", label: "Crustaceans", icon: "🦐" },
    { code: "egg", label: "Egg", icon: "🥚" },
    { code: "fish", label: "Fish", icon: "🐟" },
    { code: "lupin", label: "Lupin", icon: "🌼" },
    { code: "milk", label: "Milk", icon: "🥛" },
    { code: "molluscs", label: "Molluscs", icon: "🐚" },
    { code: "mustard", label: "Mustard", icon: "🟡" },
    { code: "tree_nuts", label: "Tree Nuts", icon: "🌰" },
    { code: "peanuts", label: "Peanuts", icon: "🥜" },
    { code: "sesame", label: "Sesame", icon: "⚪" },
    { code: "soy", label: "Soy", icon: "🫘" },
    { code: "sulphites", label: "Sulphites", icon: "🧪" },
  ]);
});

router.get("/:restaurantId/items", async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId || 0);
    const categoryId = Number(req.query.category_id || 0);
    const type = normalizeType(req.query.type);

    await assertRestaurantActive(restaurantId);

    if (!categoryId) return res.json([]);

    if (type === "meals") {
      const rows = await qAll(
        kind === "pg"
          ? `
           SELECT id, name, price, category_id, photo_url, out_of_stock, options_schema
FROM public.meals
            WHERE restaurant_id = $1 AND category_id = $2
            ORDER BY name ASC
          `
          : `
            SELECT id, name, price, category_id, photo_url, out_of_stock, options_schema
FROM meals
            WHERE restaurant_id = ? AND category_id = ?
            ORDER BY name ASC
          `,
        [restaurantId, categoryId]
      );

const rowsWithAvailability = await Promise.all(
  (rows || []).map(async (item) => {
    try {
      const portionsLeft = await getMealPortionsLeft(
        { qGet, qAll, kind },
        Number(item.id),
        restaurantId
      );

      const possible =
        portionsLeft === null || portionsLeft === undefined
          ? null
          : Number(portionsLeft);

      return {
        ...item,
        portions_left: possible,
        out_of_stock:
          !!item.out_of_stock ||
          (possible !== null && possible <= 0),
      };
    } catch (err) {
      console.error("❌ QR meal availability failed:", err);
      return item;
    }
  })
);

return res.json(rowsWithAvailability);
    }

    const expectedType = type === "drinks" ? "drink" : "dessert";

    const rows = await qAll(
      kind === "pg"
        ? `
          SELECT id, name, price, category_id, photo_url, out_of_stock, type, options_schema
FROM public.menu_items
          WHERE restaurant_id = $1
            AND category_id = $2
            AND LOWER(TRIM(COALESCE(type, ''))) = $3
          ORDER BY name ASC
        `
        : `
         SELECT id, name, price, category_id, photo_url, out_of_stock, type, options_schema
FROM menu_items
          WHERE restaurant_id = ?
            AND category_id = ?
            AND LOWER(TRIM(COALESCE(type, ''))) = ?
          ORDER BY name ASC
        `,
      [restaurantId, categoryId, expectedType]
    );

    res.json(rows || []);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to load items" });
  }
});

router.get("/:restaurantId/items/allergens", async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId || 0);
    const type = normalizeType(req.query.type);
    await assertRestaurantActive(restaurantId);

    let rows = [];

    if (type === "meals") {
      rows = await qAll(
        kind === "pg"
          ? `SELECT id, name FROM public.meals WHERE restaurant_id = $1`
          : `SELECT id, name FROM meals WHERE restaurant_id = ?`,
        [restaurantId]
      );
    } else {
      const expectedType = type === "drinks" ? "drink" : "dessert";
      rows = await qAll(
        kind === "pg"
          ? `
            SELECT id, name
            FROM public.menu_items
            WHERE restaurant_id = $1
              AND LOWER(TRIM(COALESCE(type, ''))) = $2
          `
          : `
            SELECT id, name
            FROM menu_items
            WHERE restaurant_id = ?
              AND LOWER(TRIM(COALESCE(type, ''))) = ?
          `,
        [restaurantId, expectedType]
      );
    }

    const out = {};
    for (const r of rows || []) {
      out[Number(r.id)] = {
        contains: sanitizeAllergenCodes(detectAllergenCodesFromName(r.name)),
        may_contain: [],
      };
    }

    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to load allergens" });
  }
});

router.post("/:restaurantId/order", async (req, res) => {
  try {
  const restaurantId =
    Number(
      req.params
        .restaurantId ||
      0
    );

  if (
    !Number.isInteger(
      restaurantId
    ) ||
    restaurantId <= 0
  ) {
    return res
      .status(400)
      .json({
        error:
          "Invalid restaurant id.",
      });
  }

  await assertRestaurantActive(
    restaurantId
  );

  const items =
    Array.isArray(
      req.body?.items
    )
      ? req.body.items
      : [];

  if (
    items.length >
    MAX_PUBLIC_ORDER_LINES
  ) {
    return res
      .status(413)
      .json({
        error:
          `A public order may contain at most ${MAX_PUBLIC_ORDER_LINES} lines.`,
      });
  }
const requestedPaymentMethod = String(
  req.body?.kiosk_payment_method || ""
).toLowerCase();
    const orderTypeRaw = String(req.body?.order_type || "dine-in").toLowerCase();

    const orderType =
      orderTypeRaw === "takeaway" || orderTypeRaw === "delivery"
        ? orderTypeRaw
        : "dine-in";

    const isDineIn = orderType === "dine-in";
    const tableName = isDineIn
      ? canonicalTableName(req.body?.table_number)
      : orderType === "delivery"
        ? "Delivery"
        : "Takeaway";

    if (!items.length) {
      return res.status(400).json({ error: "Order items are required." });
    }

    if (isDineIn && !req.body?.table_number) {
      return res.status(400).json({ error: "Table number is required." });
    }

    const settingRow = await qGet(
      kind === "pg"
        ? `
          SELECT hold_qr_kiosk_until_paid
          FROM public.restaurants
          WHERE id = $1
          LIMIT 1
        `
        : `
          SELECT hold_qr_kiosk_until_paid
          FROM restaurants
          WHERE id = ?
          LIMIT 1
        `,
      [restaurantId]
    );

    const holdQrUntilPaid = settingRow?.hold_qr_kiosk_until_paid !== false;

    const session = req.body?.kiosk_session || req.body?.takeaway_session || {};
    const tableAllergyCodes = sanitizeAllergenCodes(session?.allergy_codes);
    const strictCrossContamination = !!session?.strict_cross_contamination;
    const batchId = crypto.randomUUID();

    const result = await withTx(async (tx) => {
            // =====================================================
      // AUTHORITATIVE PUBLIC ORDER PRICING
      // =====================================================

      const pricingItems =
        buildPublicPricingItems(items);

      if (!pricingItems.length) {
        const err =
          new Error(
            "Order items are required."
          );

        err.status = 400;

        throw err;
      }

      const canonicalCart =
        await buildCanonicalCart(
          tx,
          restaurantId,
          pricingItems
        );

      if (
        !canonicalCart ||
        !Array.isArray(
          canonicalCart.items
        ) ||
        !canonicalCart.items.length
      ) {
        const err =
          new Error(
            "No valid order items."
          );

        err.status = 400;

        throw err;
      }

      /*
       * From this point forward ONLY canonicalItems
       * may be used for:
       *
       * - item identity
       * - names
       * - category
       * - prices
       * - options
       * - quantity
       */
      const canonicalItems =
        canonicalCart.items;

      console.log(
        "✅ PUBLIC AUTHORITATIVE ORDER QUOTE:",
        {
          restaurant_id:
            restaurantId,

          submitted_items:
            items.length,

          canonical_items:
            canonicalItems.length,

          subtotal:
            canonicalCart.subtotal,

          total:
            canonicalCart.total,
        }
      );

      let pickupNumber = null;

      if (orderType === "takeaway") {
        const row = await tx.qGet(
          tx.kind === "pg"
            ? `
              SELECT COALESCE(MAX(pickup_number), 0) + 1 AS next
              FROM public.order_batches
              WHERE restaurant_id = $1
                AND order_type = 'takeaway'
                AND created_at::date = CURRENT_DATE
            `
            : `
              SELECT COALESCE(MAX(pickup_number), 0) + 1 AS next
              FROM order_batches
              WHERE restaurant_id = ?
                AND order_type = 'takeaway'
            `,
          [restaurantId]
        );

        pickupNumber = Number(row?.next || 1);
      }

      await tx.qRun(
        tx.kind === "pg"
          ? `
            INSERT INTO public.order_batches
              (id, table_number, restaurant_id, order_type, pickup_number, requested_payment_method, created_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6, NOW())
          `
          : `
            INSERT INTO order_batches
              (id, table_number, restaurant_id, order_type, pickup_number, created_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `,
[batchId, tableName, restaurantId, orderType, pickupNumber, requestedPaymentMethod]
      );

        for (
        const item of canonicalItems
      ) {
        const name =
          String(
            item.name || ""
          ).trim();

        if (!name) {
          throw new Error(
            "Canonical item name missing."
          );
        }

        const qty =
          Math.max(
            1,
            Number(
              item.quantity || 1
            )
          );

        const unit =
          Number(
            item.unit_price || 0
          );

        const total =
          Number(
            item.total_price || 0
          );

        const itemType =
          normalizeType(
            item.item_type
          );

        if (
          !Number.isFinite(unit) ||
          unit < 0 ||
          !Number.isFinite(total) ||
          total < 0
        ) {
          throw new Error(
            "Invalid canonical item price."
          );
        }

        // ✅ IMPORTANT:
        // If QR hold-until-paid is ON, do NOT insert into orders/KDS yet.
        // It will be released into KDS after payment by releasePaidHeldOrderToKds().
        if (!holdQrUntilPaid) {
          await tx.qRun(
            tx.kind === "pg"
              ? `
                INSERT INTO public.orders
                  (
                    restaurant_id, table_number, meal_name, quantity,
                    price_per_unit, total_price, paid, order_status,
                    category, category_id, order_type, options, note,
                    batch_id, created_at
                  )
                VALUES
                  (
                    $1, $2, $3, $4,
                    $5, $6, FALSE, 'pending',
                    $7, $8, $9, $10::jsonb, $11,
$12::uuid, NOW()
                  )
              `
              : `
                INSERT INTO orders
                  (
                    restaurant_id, table_number, meal_name, quantity,
                    price_per_unit, total_price, paid, order_status,
                    category, category_id, order_type, options, note,
                    batch_id, created_at
                  )
                VALUES
                  (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, '{}', ?, ?, CURRENT_TIMESTAMP)
              `,
            [
  restaurantId,
  tableName,
  name,
  qty,
  unit,
  total,
  itemType,
  item.category_id ?? null,
  orderType,
JSON.stringify(
  item.selected_options || {}
),
  item.note ?? null,
  batchId,
]
          );
        }

        const itemAllergenContains = sanitizeAllergenCodes(
          detectAllergenCodesFromName(name)
        );

        const allergenConflicts = itemAllergenContains.filter((code) =>
          tableAllergyCodes.includes(code)
        );

        const posOrderStatus = holdQrUntilPaid ? "pending_payment" : "open";
        const expiresAt = holdQrUntilPaid
          ? new Date(Date.now() + 20 * 60 * 1000).toISOString()
          : null;

        for (let i = 0; i < qty; i++) {
          await tx.qRun(
            tx.kind === "pg"
              ? `
                INSERT INTO public.pos_orders
                  (
                    restaurant_id,
                    table_number,
                    meal_id,
                    menu_item_id,
                    item_name,
                    quantity,
                    total_price,
                    item_type,
                    order_status,
                    paid,
                    options,
                    note,
                    batch_id,
                    category_id,
                    table_allergy_codes,
                    item_allergen_contains,
                    allergen_conflicts,
                    strict_cross_contamination,
                    table_covers,
                    amount_paid,
                    remaining_price,
                    source,
                    expires_at,
                    created_at
                  )
                  VALUES
(
  $1, $2,
  $3, $4,
  $5, 1, $6, $7,
  $8, 0, $9::jsonb, $10, $11::uuid,
  $12, $13::jsonb, $14::jsonb, $15::jsonb, $16,
  1, 0, $6, 'qr', $17, NOW()
)
              `
              : `
                INSERT INTO pos_orders
                  (
                    restaurant_id,
                    table_number,
                    meal_id,
                    menu_item_id,
                    item_name,
                    quantity,
                    total_price,
                    item_type,
                    order_status,
                    paid,
                    options,
                    note,
                    batch_id,
                    category_id,
                    strict_cross_contamination,
                    table_covers,
                    amount_paid,
                    remaining_price,
                    source,
                    expires_at,
                    created_at
                  )
                VALUES
                  (
                    ?, ?, ?, ?,
                    ?, 1, ?, ?,
                    ?, 0, '{}', ?, ?,
                    ?, ?, 1, 0, ?, 'qr', ?, CURRENT_TIMESTAMP
                  )
              `,
            tx.kind === "pg"
              ? [
  restaurantId,
  tableName,
item.meal_id
  ? Number(item.meal_id)
  : null,

item.menu_item_id
  ? Number(item.menu_item_id)
  : null,
  name,
  unit,
  itemType === "meals" ? "meal" : itemType === "drinks" ? "drink" : "dessert",
  posOrderStatus,
  JSON.stringify(
  item.selected_options || {}
),
  item.note ?? null,
  batchId,
  item.category_id ?? null,
  JSON.stringify(tableAllergyCodes),
  JSON.stringify(itemAllergenContains),
  JSON.stringify(allergenConflicts),
  strictCrossContamination,
  expiresAt,
]
              : [
                  restaurantId,
                  tableName,
                  item.item_type === "meals" ? Number(item.meal_id || 0) || null : null,
                  item.item_type !== "meals" ? Number(item.menu_item_id || 0) || null : null,
                  name,
                  unit,
                  itemType === "meals" ? "meal" : itemType === "drinks" ? "drink" : "dessert",
                  posOrderStatus,
                  item.note ?? null,
                  batchId,
                  item.category_id ?? null,
                  strictCrossContamination ? 1 : 0,
                  unit,
                  expiresAt,
                ]
          );
        }

        // ✅ Keep current QR behaviour: stock deducts when QR order is placed.
        // Later we can move deduction after payment too if you want stricter stock logic.
                if (
          itemType === "meals" &&
          item.meal_id
        ) {
          await deductStockFromMealOrder(
            tx,
            Number(
              item.meal_id
            ),
            qty,
            restaurantId
          );
        } else {
          await deductStockByItemName(
            tx,
            name,
            qty,
            restaurantId
          );
        }
      }
      if (isDineIn) {
        await tx.qRun(
          tx.kind === "pg"
            ? `
              UPDATE public.tables
              SET status = 'occupied'
              WHERE restaurant_id = $1
                AND LOWER(TRIM(name)) = LOWER(TRIM($2))
            `
            : `
              UPDATE tables
              SET status = 'occupied'
              WHERE restaurant_id = ?
                AND LOWER(TRIM(name)) = LOWER(TRIM(?))
            `,
          [restaurantId, tableName]
        );

        await tx.qRun(
          tx.kind === "pg"
            ? `
              UPDATE public.table_map
              SET status = 'occupied'
              WHERE restaurant_id = $1
                AND LOWER(TRIM(name)) = LOWER(TRIM($2))
            `
            : `
              UPDATE table_map
              SET status = 'occupied'
              WHERE restaurant_id = ?
                AND LOWER(TRIM(name)) = LOWER(TRIM(?))
            `,
          [restaurantId, tableName]
        );
      }

            return {
        batch_id:
          batchId,

        pickup_number:
          pickupNumber,

        subtotal:
          Number(
            canonicalCart.subtotal ||
            0
          ),

        total:
          Number(
            canonicalCart.total ||
            canonicalCart.subtotal ||
            0
          ),

        items:
          canonicalItems.map(
            (item) => ({
              meal_id:
                item.meal_id ||
                null,

              menu_item_id:
                item.menu_item_id ||
                null,

              name:
                item.name,

              item_type:
                item.item_type,

              category_id:
                item.category_id ??
                null,

              quantity:
                Number(
                  item.quantity || 1
                ),

              unit_price:
                Number(
                  item.unit_price || 0
                ),

              total_price:
                Number(
                  item.total_price || 0
                ),

              options:
                item.selected_options ||
                {},
            })
          ),
      };

    });
        return res.status(201).json({
      success: true,

      batch_id:
        result.batch_id,

      pickup_number:
        result.pickup_number ||
        null,

      held_until_paid:
        holdQrUntilPaid,

      subtotal:
        result.subtotal,

      total:
        result.total,

      items:
        result.items,
    });
    } catch (err) {
    console.error(
      "❌ public QR order failed:",
      err
    );

    if (
      err instanceof PricingError
    ) {
      return res
        .status(
          Number(
            err.status || 400
          )
        )
        .json({
          error:
            err.message,

          code:
            err.code ||
            "PRICING_ERROR",

          details:
            err.details ||
            undefined,
        });
    }

    const status =
      Number(
        err?.status || 500
      );

    return res
      .status(status)
      .json({
        error:
          status >= 500
            ? "Failed to place QR order."
            : String(
                err?.message ||
                "Invalid order."
              ),
      });
  }
});

router.get("/:restaurantId/settings", async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId || 0);
    await assertRestaurantActive(restaurantId);

    const row = await qGet(
      kind === "pg"
        ? `
          SELECT name, kiosk_settings
          FROM public.restaurants
          WHERE id = $1
          LIMIT 1
        `
        : `
          SELECT name, kiosk_settings
          FROM restaurants
          WHERE id = ?
          LIMIT 1
        `,
      [restaurantId]
    );

    let kioskSettings = row?.kiosk_settings || {};

    if (typeof kioskSettings === "string") {
      try {
        kioskSettings = JSON.parse(kioskSettings);
      } catch {
        kioskSettings = {};
      }
    }

    res.json({
      name: row?.name || "our restaurant",
      kiosk_settings: kioskSettings,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to load settings" });
  }
});

router.get("/:restaurantId/kiosk-settings", async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId || 0);
    await assertRestaurantActive(restaurantId);

    const row = await qGet(
      kind === "pg"
        ? `
          SELECT kiosk_settings
          FROM public.restaurants
          WHERE id = $1
          LIMIT 1
        `
        : `
          SELECT kiosk_settings
          FROM restaurants
          WHERE id = ?
          LIMIT 1
        `,
      [restaurantId]
    );

    let settings = row?.kiosk_settings || {};

    if (typeof settings === "string") {
      try {
        settings = JSON.parse(settings);
      } catch {
        settings = {};
      }
    }

    res.json({
      show_eat_in: settings.show_eat_in !== false,
      show_takeaway: settings.show_takeaway !== false,
      show_voucher: settings.show_voucher !== false,
      show_prices: settings.show_prices !== false,
      show_photos: settings.show_photos !== false,
      visible_category_ids: Array.isArray(settings.visible_category_ids)
        ? settings.visible_category_ids
        : [],
    });
  } catch (err) {
    res.status(400).json({
      error: err.message || "Failed to load kiosk settings",
    });
  }
});

router.get("/:restaurantId/promotion", async (req, res) => {
  try {
    const restaurantId = Number(req.params.restaurantId || 0);
    const displayContext = String(req.query.display_context || "qr").toLowerCase();
    const orderType = String(req.query.order_type || "dine-in").toLowerCase();

    await assertRestaurantActive(restaurantId);

    const rows = await qAll(
      `
      SELECT *
      FROM public.restaurant_promotions
      WHERE restaurant_id = $1
        AND active = TRUE
        AND (
          $2 = 'qr' AND COALESCE(show_on_qr, TRUE) = TRUE
          OR
          $2 = 'kiosk' AND COALESCE(show_on_kiosk, TRUE) = TRUE
          OR
          COALESCE(display_context, 'both') = 'both'
        )
        AND (
          $3 = 'dine-in' AND COALESCE(show_for_dine_in, TRUE) = TRUE
          OR
          $3 = 'takeaway' AND COALESCE(show_for_takeaway, TRUE) = TRUE
          OR
          COALESCE(order_type, 'both') = 'both'
        )
      ORDER BY priority DESC, sort_order ASC, id DESC
      LIMIT 3
      `,
      [restaurantId, displayContext, orderType]
    );

    res.json(rows || []);
  } catch (err) {
    console.error("❌ public promotion failed:", err);
    res.status(500).json([]);
  }
});
module.exports = router;