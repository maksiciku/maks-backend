// routes/dessertsRoutes.js
const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");

const { getEffectivePrice } = require("./happyHourRoutes");

const {
  withTx,
} = require("../dbCompat");

const {
  emitMenuCatalogSnapshotTx,
} = require("../edge/contracts/menuCatalog");

const {
  MaksRuntimeRoleError,
  assertCloudRuntime,
} = require("../utils/runtimeRole");

function sendMenuCatalogAuthorityError(res, error) {
  if (!(error instanceof MaksRuntimeRoleError)) {
    return false;
  }

  if (error.code === "MAKS_RUNTIME_ROLE_NOT_CLOUD") {
    res.status(409).json({
      error: "MENU_CATALOG_CLOUD_AUTHORITY_REQUIRED",
    });
    return true;
  }

  res.status(503).json({
    error: "MENU_CATALOG_RUNTIME_ROLE_UNAVAILABLE",
  });
  return true;
}

function requireCloudMenuCatalogAuthority(req, res, next) {
  try {
    assertCloudRuntime();
    next();
  } catch (error) {
    if (sendMenuCatalogAuthorityError(res, error)) {
      return;
    }
    next(error);
  }
}

async function requireOwnedCategoryTx(tx, rid, categoryId) {
  const row = await tx.qGet(
    `
    SELECT id
    FROM public.categories
    WHERE restaurant_id = $1
      AND id = $2
    LIMIT 1
    `,
    [rid, categoryId]
  );

  return row || null;
}


const {
  saveMenuItemIngredientsAndRefreshNutrition,
} = require("../utils/menuItemEngine");

const {
  PERMISSIONS,
  requirePermission,
  hasPermission,
} = require("../middleware/accessControl");

const ridOf = (req) => Number(req.tenantRid || req.user?.restaurant_id || 0);
const p = (req, n) => (req.kind === "pg" ? `$${n}` : `?`);

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
      const err =
        new Error(
          "Every option group requires an id."
        );
      err.status = 400;
      throw err;
    }

    if (groupIds.has(id)) {
      const err =
        new Error(
          "Duplicate option-group id."
        );
      err.status = 400;
      throw err;
    }

    groupIds.add(id);

    if (!label) {
      const err =
        new Error(
          "Every option group requires a label."
        );
      err.status = 400;
      throw err;
    }

    if (
      !["single", "multi", "text"].includes(type)
    ) {
      const err =
        new Error(
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
      const err =
        new Error(
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
        String(
          choice?.label || ""
        ).trim();

      if (!choiceId) {
        const err =
          new Error(
            `"${label}" contains a choice without an id.`
          );
        err.status = 400;
        throw err;
      }

      if (choiceIds.has(choiceId)) {
        const err =
          new Error(
            `"${label}" contains duplicate choice ids.`
          );
        err.status = 400;
        throw err;
      }

      choiceIds.add(choiceId);

      if (!choiceLabel) {
        const err =
          new Error(
            `"${label}" contains a choice without a label.`
          );
        err.status = 400;
        throw err;
      }

      const priceDelta =
        Number(
          choice?.priceDelta ??
          choice?.price_delta ??
          0
        );

      if (!Number.isFinite(priceDelta)) {
        const err =
          new Error(
            `"${choiceLabel}" has an invalid price adjustment.`
          );
        err.status = 400;
        throw err;
      }
    }
  }

  return schema;
}

// ✅ POST /desserts/items
router.post(
  "/items",
  authenticateToken,
  loadMembership,

  requirePermission(
    PERMISSIONS.MENU_CREATE
  ),

  requirePricingIfPresent,
  requireCloudMenuCatalogAuthority,

  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      const {
        name,
        price = 0,
        vat_rate,
        category_id = null,
        options_schema = [],
        ingredients = [],
      } = req.body || {};

      const nm =
        String(name || "").trim();

      if (!nm) {
        return res.status(400).json({
          error: "name required",
        });
      }

      const cleanPrice =
        Number(price);

      if (
        !Number.isFinite(cleanPrice) ||
        cleanPrice < 0
      ) {
        return res.status(400).json({
          error:
            "price must be a valid non-negative number",
        });
      }

      const vatRate =
        normalizeVatRate(vat_rate);

      const cleanOptionsSchema =
        validateOptionsSchema(
          options_schema
        );

      const requestedCategoryId =
        category_id == null ||
        category_id === ""
          ? null
          : Number(category_id);

      const result =
        await withTx(async (tx) => {
          let cid =
            requestedCategoryId;

          if (cid) {
            const ownedCategory =
              await requireOwnedCategoryTx(
                tx,
                rid,
                cid
              );

            if (!ownedCategory) {
              return {
                categoryNotFound: true,
              };
            }
          } else {
            const def =
              await tx.qGet(
                `
                SELECT id
                FROM public.categories
                WHERE restaurant_id = $1
                  AND LOWER(type) LIKE 'dessert%'
                ORDER BY id ASC
                LIMIT 1
                `,
                [rid]
              );

            if (!def?.id) {
              return {
                defaultCategoryMissing: true,
              };
            }

            cid =
              Number(def.id);
          }

          const row =
            await tx.qGet(
              `
              INSERT INTO public.menu_items
              (
                restaurant_id,
                name,
                price,
                vat_rate,
                type,
                category_id,
                options_schema
              )
              VALUES
              (
                $1,
                $2,
                $3,
                $4,
                'dessert',
                $5,
                $6
              )
              RETURNING *
              `,
              [
                rid,
                nm,
                Number(
                  cleanPrice.toFixed(2)
                ),
                vatRate,
                cid,
                JSON.stringify(
                  cleanOptionsSchema
                ),
              ]
            );

          const refreshed =
            await saveMenuItemIngredientsAndRefreshNutrition(
              tx,
              rid,
              row.id,
              Array.isArray(ingredients)
                ? ingredients
                : []
            );

          await emitMenuCatalogSnapshotTx(
            tx,
            {
              restaurantId:
                rid,
            }
          );

          return {
            row,
            refreshed,
          };
        });

      if (result?.categoryNotFound) {
        return res.status(404).json({
          error:
            "Dessert category not found",
        });
      }

      if (result?.defaultCategoryMissing) {
        return res.status(400).json({
          error:
            "No dessert category exists. Create a dessert category first.",
        });
      }

      const refreshed =
        result.refreshed;

      return res.status(201).json({
        success: true,
        item:
          refreshed.item ||
          result.row,
        total_cost:
          refreshed.total_cost,
        allergens:
          refreshed.allergens,
        calories:
          refreshed.calories,
      });
    } catch (e) {
      console.error(
        "❌ POST /desserts/items failed:",
        e
      );

      const status =
        Number(e?.status || 500);

      return res
        .status(status)
        .json({
          error:
            status < 500
              ? e.message
              : "Failed to create dessert item",
        });
    }
  }
);


// ✅ GET /desserts/items?category_id=123 (optional)
router.get("/items", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "No restaurant selected (missing rid)" });

    const categoryIdRaw = req.query.category_id;
    const categoryId = categoryIdRaw == null || categoryIdRaw === "" ? null : Number(categoryIdRaw);

    const sql = `
      SELECT
        mi.id,
        mi.name,
        mi.price,
mi.vat_rate,
mi.type,
        mi.category_id,
        mi.options_schema,
        mi.out_of_stock,
        mi.photo_url,
        mi.allergens,
        mi.calories,
        mi.created_at,
        COALESCE(SUM(mii.amount * COALESCE(s.price, 0)), 0) AS total_cost
      FROM public.menu_items mi
      LEFT JOIN public.menu_item_ingredients mii
        ON mii.restaurant_id = mi.restaurant_id
       AND mii.menu_item_id = mi.id
      LEFT JOIN public.stock s
        ON s.restaurant_id = mii.restaurant_id
       AND s.id = mii.stock_id
      WHERE mi.restaurant_id = $1
        AND LOWER(TRIM(COALESCE(mi.type,''))) IN ('dessert', 'desserts')
        ${categoryId ? "AND mi.category_id = $2" : ""}
      GROUP BY mi.id
      ORDER BY LOWER(TRIM(mi.name)) ASC
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
            type: "dessert",
            item_type: "desserts",
            base_price: Number(item.price || 0),
          },
          req.query.order_type
        );

        return {
          ...item,
          total_cost: Number(item.total_cost || 0),
          profit: Number(item.price || 0) - Number(item.total_cost || 0),
          margin:
            Number(item.price || 0) > 0
              ? ((Number(item.price || 0) - Number(item.total_cost || 0)) / Number(item.price || 0)) * 100
              : 0,
          ...pricing,
        };
      })
    );

    res.json(enriched);
  } catch (e) {
    console.error("❌ GET /desserts/items failed:", e?.message, e?.stack);
    res.status(500).json({ error: "Failed to fetch dessert items" });
  }
});

// ✅ DELETE /desserts/items/:id
router.delete(
  "/items/:id",
  authenticateToken,
  loadMembership,

  requirePermission(
    PERMISSIONS.MENU_DELETE
  ),

  requireCloudMenuCatalogAuthority,

  async (req, res) => {
    try {
      const rid = ridOf(req);
      const id = Number(req.params.id);

      if (!rid) {
        return res.status(400).json({
          error: "Missing rid",
        });
      }

      if (!id) {
        return res.status(400).json({
          error: "Invalid id",
        });
      }

      const deleted =
        await withTx(async (tx) => {
          const row = await tx.qGet(
            `
            DELETE FROM public.menu_items
            WHERE id = $1
              AND restaurant_id = $2
              AND LOWER(TRIM(type)) = 'dessert'
            RETURNING id
            `,
            [id, rid]
          );

          if (!row) {
            return false;
          }

          await emitMenuCatalogSnapshotTx(
            tx,
            {
              restaurantId: rid,
            }
          );

          return true;
        });

      if (!deleted) {
        return res.status(404).json({
          error: "Dessert not found",
        });
      }

      return res.json({
        success: true,
      });
    } catch (e) {
      console.error(
        "❌ DELETE /desserts/items/:id failed:",
        e
      );

      return res.status(500).json({
        error:
          "Failed to delete dessert item",
      });
    }
  }
);


// ✅ PUT /desserts/items/:id
router.put(
  "/items/:id",
  authenticateToken,
  loadMembership,

  requirePermission(
    PERMISSIONS.MENU_EDIT
  ),

  requirePricingIfPresent,
  requireCloudMenuCatalogAuthority,

  async (req, res) => {
    try {
      const rid = ridOf(req);
      const id = Number(req.params.id);

      if (!rid) {
        return res.status(400).json({
          error: "Missing rid",
        });
      }

      if (!id) {
        return res.status(400).json({
          error: "Invalid id",
        });
      }

      const {
        name,
        price,
        vat_rate,
        category_id,
        options_schema,
        out_of_stock,
        photo_url,
        ingredients,
      } = req.body || {};

      const sets = [];
      const vals = [];
      let i = 1;

      const add = (col, val) => {
        sets.push(`${col} = $${i++}`);
        vals.push(val);
      };

      if (name !== undefined) {
        add(
          "name",
          String(name || "").trim()
        );
      }

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
          normalizeVatRate(vat_rate)
        );
      }

      const requestedCategoryId =
        category_id === undefined
          ? undefined
          : category_id === "" ||
            category_id == null
            ? null
            : Number(category_id);

      if (category_id !== undefined) {
        add(
          "category_id",
          requestedCategoryId
        );
      }

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

      if (out_of_stock !== undefined) {
        add(
          "out_of_stock",
          !!out_of_stock
        );
      }

      if (photo_url !== undefined) {
        add(
          "photo_url",
          photo_url
            ? String(photo_url).trim()
            : null
        );
      }

      const result =
        await withTx(async (tx) => {
          const current =
            await tx.qGet(
              `
              SELECT *
              FROM public.menu_items
              WHERE id = $1
                AND restaurant_id = $2
                AND LOWER(TRIM(type)) = 'dessert'
              LIMIT 1
              `,
              [id, rid]
            );

          if (!current) {
            return {
              notFound: true,
            };
          }

          if (
            requestedCategoryId !== undefined &&
            requestedCategoryId !== null
          ) {
            const ownedCategory =
              await requireOwnedCategoryTx(
                tx,
                rid,
                requestedCategoryId
              );

            if (!ownedCategory) {
              return {
                categoryNotFound: true,
              };
            }
          }

          let updated =
            current;

          if (sets.length) {
            const updateVals = [
              ...vals,
              id,
              rid,
            ];

            const idParam = i++;
            const ridParam = i++;

            updated =
              await tx.qGet(
                `
                UPDATE public.menu_items
                SET ${sets.join(", ")}
                WHERE id = $${idParam}
                  AND restaurant_id = $${ridParam}
                  AND LOWER(TRIM(type)) = 'dessert'
                RETURNING *
                `,
                updateVals
              );

            if (!updated) {
              return {
                notFound: true,
              };
            }
          }

          let refreshed = null;

          if (
            Array.isArray(
              ingredients
            )
          ) {
            refreshed =
              await saveMenuItemIngredientsAndRefreshNutrition(
                tx,
                rid,
                id,
                ingredients
              );
          }

          const finalItem =
            await tx.qGet(
              `
              SELECT *
              FROM public.menu_items
              WHERE id = $1
                AND restaurant_id = $2
                AND LOWER(TRIM(type)) = 'dessert'
              LIMIT 1
              `,
              [id, rid]
            );

          if (
            sets.length ||
            Array.isArray(
              ingredients
            )
          ) {
            await emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  rid,
              }
            );
          }

          return {
            item:
              refreshed?.item ||
              finalItem ||
              updated,
            refreshed,
          };
        });

      if (result?.notFound) {
        return res.status(404).json({
          error:
            "Dessert not found",
        });
      }

      if (result?.categoryNotFound) {
        return res.status(404).json({
          error:
            "Dessert category not found",
        });
      }

      return res.json({
        success: true,
        item:
          result.item,
        total_cost:
          result.refreshed
            ?.total_cost,
        allergens:
          result.refreshed
            ?.allergens,
        calories:
          result.refreshed
            ?.calories,
      });
    } catch (e) {
      console.error(
        "❌ PUT /desserts/items/:id failed:",
        e
      );

      const status =
        Number(e?.status || 500);

      return res
        .status(status)
        .json({
          error:
            status < 500
              ? e.message
              : "Failed to update dessert item",
        });
    }
  }
);


// GET /desserts/items/:id/ingredients
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
        s.price AS stock_price,
        s.quantity AS stock_quantity,
        s.allergens,
        s.calories_per_100g
      FROM public.menu_item_ingredients mii
      LEFT JOIN public.stock s
        ON s.restaurant_id = mii.restaurant_id
       AND s.id = mii.stock_id
      WHERE mii.restaurant_id = $1
        AND mii.menu_item_id = $2
      ORDER BY mii.id ASC
      `,
      [rid, id]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("❌ GET /desserts/items/:id/ingredients failed:", e);
    res.status(500).json({ error: "Failed to load dessert ingredients" });
  }
});
module.exports = router;
