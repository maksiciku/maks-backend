// routes/stockRoutes.js
const express = require("express");
const router = express.Router();
const tenantGuard = require("../middleware/tenantGuard");

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");

const {
  PERMISSIONS,
  requirePermission,
  hasPermission,
} = require("../middleware/accessControl");

const { qAll, qGet, qRun } = require("../dbCompat");

// Prefer tenant rid, fallback to user's restaurant_id
const ridOf = (req) =>
  Number(
    req.tenantRid ||
      req.user?.restaurant_id ||
      0
  );

// =========================================================
// PERMISSION HELPERS
// =========================================================

const permissionSubject = (req) => ({
  authority:
    req.membership?.authority ||
    req.user?.authority,

  permissions:
    req.membership?.permissions ||
    req.user?.permissions,
});

const can = (req, permission) =>
  hasPermission(
    permissionSubject(req),
    permission
  );

const deny = (res, permission) =>
  res.status(403).json({
    error:
      "You do not have permission to perform this action.",
    code: "PERMISSION_DENIED",
    permission,
  });

// =========================================================
// STOCK RESPONSE SECURITY
// =========================================================

/**
 * Stock cost/pricing is commercially sensitive.
 *
 * A user may have STOCK_VIEW without having
 * STOCK_VIEW_COST.
 *
 * Keep the response shape compatible but hide
 * price when the permission is absent.
 */
const protectStockCost = (req, row) => {
  if (!row) return row;

  if (
    can(
      req,
      PERMISSIONS.STOCK_VIEW_COST
    )
  ) {
    return row;
  }

  return {
    ...row,
    price: null,
  };
};

const protectStockCosts = (
  req,
  rows
) =>
  (rows || []).map((row) =>
    protectStockCost(req, row)
  );

// =========================================================
// EXPIRY DATE HELPER
// =========================================================

// expiry_date is TEXT in the current schema
function pgDateExpr(colName) {
  return `NULLIF(${colName}, '')::date`;
}

// =========================================================
// GET /stock
// All stock items
// =========================================================

router.get(
  "/",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_VIEW
  ),
  async (req, res) => {
    const rid = ridOf(req);

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      const rows = await qAll(
        `
        SELECT
          id,
          ingredient,
          type,
          category_id,
          category,
          price,
          quantity,
          unit,
          allergens,
          supplier_id,
          calories_per_100g,
          expiry_date,
          min_threshold,
          minimum_level,
          portions_left,
          restaurant_id,
          created_at,
          updated_at
        FROM stock
        WHERE restaurant_id = ?
          AND LOWER(
            TRIM(
              COALESCE(type,'')
            )
          ) IN (
            'ingredient',
            'ingredients',
            ''
          )
        `,
        [rid]
      );

      const counts = (
        rows || []
      ).reduce(
        (acc, row) => {
          const type = String(
            row.type || ""
          ).toLowerCase();

          acc[type] =
            (acc[type] || 0) + 1;

          return acc;
        },
        {}
      );

      console.log(
        `📦 Stock breakdown @rid=${rid}:`,
        counts
      );

      return res.json(
        protectStockCosts(
          req,
          rows
        )
      );
    } catch (err) {
      console.error(
        "❌ GET /stock failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch stock.",
      });
    }
  }
);

// =========================================================
// GET /stock/available-for-delivery
// =========================================================

router.get(
  "/available-for-delivery",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_VIEW
  ),
  async (req, res) => {
    const rid = ridOf(req);

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      const rows = await qAll(
        `
        SELECT
          id,
          ingredient,
          type,
          category,
          quantity,
          unit,
          price,
          allergens
        FROM stock
        WHERE restaurant_id = ?
          AND COALESCE(quantity, 0) > 0
        ORDER BY
          LOWER(ingredient) ASC
        `,
        [rid]
      );

      return res.json(
        protectStockCosts(
          req,
          rows
        )
      );
    } catch (err) {
      console.error(
        "❌ GET /stock/available-for-delivery failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch available stock.",
      });
    }
  }
);

// =========================================================
// POST /stock
//
// IMPORTANT:
//
// This legacy-compatible endpoint can perform TWO jobs:
//
// 1. Create a new stock ingredient
// 2. Add quantity to an existing ingredient
//
// Therefore authority is decided SERVER-SIDE.
//
// New ingredient:
//   STOCK_CREATE
//
// Existing ingredient:
//   STOCK_ADJUST
//
// Existing ingredient + metadata changes:
//   STOCK_ADJUST + STOCK_EDIT
//
// Expiry date changes:
//   STOCK_EXPIRY
// =========================================================

router.post(
  "/",
  authenticateToken,
  loadMembership,
  async (req, res) => {
    const rid = ridOf(req);

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      const body =
        req.body || {};

      // Never allow client to set id.
      const {
        id, // ignored intentionally
        ingredient,
        quantity = 0,
        unit = "unit",
        price = 0,
        allergens = "None",
        supplier_id = null,
        category = null,
        category_id = null,
        type = "ingredient",
        calories_per_100g = 0,
        expiry_date = null,
        min_threshold = null,
        minimum_level = 0,
        portions_left = 0,
      } = body;

      const ing = String(
        ingredient || ""
      ).trim();

      if (!ing) {
        return res.status(400).json({
          error:
            "ingredient required",
        });
      }

      // -----------------------------------------------------
// Validate commercial / quantity input
// -----------------------------------------------------

const numericQuantity =
  Number(quantity);

if (
  !Number.isFinite(
    numericQuantity
  ) ||
  numericQuantity < 0
) {
  return res.status(400).json({
    error:
      "Invalid quantity",
  });
}

const numericPrice =
  Number(price);

if (
  !Number.isFinite(
    numericPrice
  ) ||
  numericPrice < 0
) {
  return res.status(400).json({
    error:
      "Invalid price",
  });
}

let safeSupplierId =
  null;

if (
  supplier_id !== null &&
  supplier_id !== undefined &&
  supplier_id !== ""
) {
  safeSupplierId =
    Number(supplier_id);

  if (
    !Number.isInteger(
      safeSupplierId
    ) ||
    safeSupplierId <= 0
  ) {
    return res.status(400).json({
      error:
        "Invalid supplier id",
    });
  }

  /*
   * SECURITY:
   * A stock record may only reference
   * a supplier owned by the same tenant.
   */
  const ownedSupplier =
    await qGet(
      `
      SELECT id
      FROM suppliers
      WHERE id = ?
        AND restaurant_id = ?
      LIMIT 1
      `,
      [
        safeSupplierId,
        rid,
      ]
    );

  if (!ownedSupplier) {
    return res.status(404).json({
      error:
        "Supplier not found",
    });
  }
}

      // -----------------------------------------------------
      // Determine whether this is CREATE or ADJUST
      // -----------------------------------------------------

      const existing =
        await qGet(
          `
          SELECT
            id
          FROM stock
          WHERE restaurant_id = ?
            AND LOWER(
              TRIM(ingredient)
            ) = LOWER(
              TRIM(?)
            )
          LIMIT 1
          `,
          [rid, ing]
        );

      if (!existing) {
        // Brand-new stock record.
        if (
          !can(
            req,
            PERMISSIONS.STOCK_CREATE
          )
        ) {
          return deny(
            res,
            PERMISSIONS.STOCK_CREATE
          );
        }
      } else {
        // Existing item means the endpoint will
        // add quantity via ON CONFLICT.
        if (
          !can(
            req,
            PERMISSIONS.STOCK_ADJUST
          )
        ) {
          return deny(
            res,
            PERMISSIONS.STOCK_ADJUST
          );
        }

        /**
         * Existing stock POST also has the ability
         * to overwrite commercial/definition fields.
         *
         * If any of those fields were actually
         * supplied by the caller, STOCK_EDIT is
         * required as well.
         */
        const editableFields = [
          "unit",
          "price",
          "allergens",
          "supplier_id",
          "category",
          "category_id",
          "type",
          "calories_per_100g",
          "min_threshold",
          "minimum_level",
          "portions_left",
        ];

        const editsDefinition =
          editableFields.some(
            (field) =>
              Object.prototype.hasOwnProperty.call(
                body,
                field
              )
          );

        if (
          editsDefinition &&
          !can(
            req,
            PERMISSIONS.STOCK_EDIT
          )
        ) {
          return deny(
            res,
            PERMISSIONS.STOCK_EDIT
          );
        }
      }

      // Expiry control is separate.
      if (
        Object.prototype.hasOwnProperty.call(
          body,
          "expiry_date"
        ) &&
        !can(
          req,
          PERMISSIONS.STOCK_EXPIRY
        )
      ) {
        return deny(
          res,
          PERMISSIONS.STOCK_EXPIRY
        );
      }

      // -----------------------------------------------------
      // Canonicalise stock type
      // -----------------------------------------------------

      const tRaw = String(
        type || ""
      )
        .toLowerCase()
        .trim();

      const t =
        tRaw.startsWith("drink")
          ? "drinks"
          : tRaw.startsWith(
                "dessert"
              )
            ? "desserts"
            : tRaw.startsWith(
                  "meal"
                )
              ? "meals"
              : tRaw;

      const catId =
        category_id === "" ||
        category_id == null
          ? null
          : Number(
              category_id
            );

      // -----------------------------------------------------
      // Existing stock write preserved
      // -----------------------------------------------------

      const row = await qGet(
        `
        INSERT INTO stock (
          ingredient,
          quantity,
          unit,
          price,
          allergens,
          calories_per_100g,
          expiry_date,
          supplier_id,
          category,
          category_id,
          type,
          restaurant_id,
          min_threshold,
          minimum_level,
          portions_left
        )
        VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )

        ON CONFLICT (
          ingredient,
          restaurant_id
        )
        DO UPDATE SET

          quantity =
            stock.quantity +
            EXCLUDED.quantity,

          unit =
            COALESCE(
              EXCLUDED.unit,
              stock.unit
            ),

          price =
            COALESCE(
              EXCLUDED.price,
              stock.price
            ),

          allergens =
            COALESCE(
              EXCLUDED.allergens,
              stock.allergens
            ),

          calories_per_100g =
            COALESCE(
              EXCLUDED.calories_per_100g,
              stock.calories_per_100g
            ),

          expiry_date =
            COALESCE(
              EXCLUDED.expiry_date,
              stock.expiry_date
            ),

          supplier_id =
            COALESCE(
              EXCLUDED.supplier_id,
              stock.supplier_id
            ),

          category =
            COALESCE(
              EXCLUDED.category,
              stock.category
            ),

          category_id =
            COALESCE(
              EXCLUDED.category_id,
              stock.category_id
            ),

          type =
            COALESCE(
              EXCLUDED.type,
              stock.type
            ),

          min_threshold =
            COALESCE(
              EXCLUDED.min_threshold,
              stock.min_threshold
            ),

          minimum_level =
            COALESCE(
              EXCLUDED.minimum_level,
              stock.minimum_level
            ),

          portions_left =
            COALESCE(
              EXCLUDED.portions_left,
              stock.portions_left
            )

        RETURNING *
        `,
        [
          ing,
          numericQuantity,
          unit || "unit",
numericPrice,
          allergens || "None",
          Number(
            calories_per_100g
          ) || 0,
          expiry_date || null,
safeSupplierId,
          category,
          catId,
          t || "ingredient",
          rid,
          min_threshold === ""
            ? null
            : min_threshold,
          Number(
            minimum_level
          ) || 0,
          Number(
            portions_left
          ) || 0,
        ]
      );

      return res.status(201).json({
        success: true,
        item:
          protectStockCost(
            req,
            row
          ),
      });
    } catch (err) {
      console.error(
        "❌ POST /stock failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to save stock item.",
      });
    }
  }
);

// =========================================================
// DELETE /stock/expired
// Delete ALL expired stock
// =========================================================

router.delete(
  "/expired",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_EXPIRY
  ),
  async (req, res) => {
    const rid = ridOf(req);

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      const result =
        await qRun(
          `
          DELETE FROM stock
          WHERE restaurant_id = ?
            AND ${pgDateExpr(
              "expiry_date"
            )} IS NOT NULL
            AND ${pgDateExpr(
              "expiry_date"
            )} < CURRENT_DATE
          `,
          [rid]
        );

      const changed =
        result?.rowCount ??
        result?.changes ??
        0;

      return res.json({
        success: true,
        deleted: changed,
      });
    } catch (err) {
      console.error(
        "❌ DELETE /stock/expired failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to delete expired stock.",
      });
    }
  }
);

// =========================================================
// DELETE /stock/expired/:id
// Delete ONE expired stock item
// =========================================================

router.delete(
  "/expired/:id",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_EXPIRY
  ),
  async (req, res) => {
    const rid =
      ridOf(req);

    const id =
      Number(
        req.params.id
      );

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      if (!id) {
        return res.status(400).json({
          error: "Invalid id",
        });
      }

      const result =
        await qRun(
          `
          DELETE FROM stock
          WHERE restaurant_id = ?
            AND id = ?
            AND ${pgDateExpr(
              "expiry_date"
            )} IS NOT NULL
            AND ${pgDateExpr(
              "expiry_date"
            )} < CURRENT_DATE
          `,
          [rid, id]
        );

      const changed =
        result?.rowCount ??
        result?.changes ??
        0;

      if (!changed) {
        return res.status(404).json({
          error:
            "Expired item not found",
        });
      }

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "❌ DELETE /stock/expired/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to remove expired item.",
      });
    }
  }
);

// =========================================================
// PUT /stock/:id
//
// This endpoint can:
// - edit definition/details
// - adjust quantity
// - alter expiry information
//
// Required permission is determined from the
// fields actually supplied.
// =========================================================

router.put(
  "/:id",
  authenticateToken,
  loadMembership,
  async (req, res) => {
    const rid =
      ridOf(req);

    const id =
      Number(
        req.params.id
      );

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      if (!id) {
        return res.status(400).json({
          error: "Invalid id",
        });
      }

      const body =
        req.body || {};

      const {
        ingredient,
        quantity,
        unit,
        price,
        allergens,
        calories_per_100g,
        expiry_date,
        supplier_id,
        category,
        category_id,
        type,
        min_threshold,
        minimum_level,
        portions_left,
      } = body;

      // -----------------------------------------------------
      // Determine exactly what authority is needed
      // -----------------------------------------------------

      const adjustmentFields = [
        "quantity",
        "portions_left",
      ];

      const editFields = [
        "ingredient",
        "unit",
        "price",
        "allergens",
        "calories_per_100g",
        "supplier_id",
        "category",
        "category_id",
        "type",
        "min_threshold",
        "minimum_level",
      ];

      const changesQuantity =
        adjustmentFields.some(
          (field) =>
            Object.prototype.hasOwnProperty.call(
              body,
              field
            )
        );

      const changesDefinition =
        editFields.some(
          (field) =>
            Object.prototype.hasOwnProperty.call(
              body,
              field
            )
        );

      const changesExpiry =
        Object.prototype.hasOwnProperty.call(
          body,
          "expiry_date"
        );

      if (
        changesQuantity &&
        !can(
          req,
          PERMISSIONS.STOCK_ADJUST
        )
      ) {
        return deny(
          res,
          PERMISSIONS.STOCK_ADJUST
        );
      }

      if (
        changesDefinition &&
        !can(
          req,
          PERMISSIONS.STOCK_EDIT
        )
      ) {
        return deny(
          res,
          PERMISSIONS.STOCK_EDIT
        );
      }

      if (
        changesExpiry &&
        !can(
          req,
          PERMISSIONS.STOCK_EXPIRY
        )
      ) {
        return deny(
          res,
          PERMISSIONS.STOCK_EXPIRY
        );
      }

      // -----------------------------------------------------
      // Build safe update
      // -----------------------------------------------------

      // -----------------------------------------------------
// Validate supplier ownership when supplied
// -----------------------------------------------------

let safeSupplierId;

if (
  supplier_id !== undefined
) {
  if (
    supplier_id === null ||
    supplier_id === ""
  ) {
    // Explicitly allow unlinking a supplier.
    safeSupplierId = null;
  } else {
    safeSupplierId =
      Number(supplier_id);

    if (
      !Number.isInteger(
        safeSupplierId
      ) ||
      safeSupplierId <= 0
    ) {
      return res.status(400).json({
        error:
          "Invalid supplier id",
      });
    }

    const ownedSupplier =
      await qGet(
        `
        SELECT id
        FROM suppliers
        WHERE id = ?
          AND restaurant_id = ?
        LIMIT 1
        `,
        [
          safeSupplierId,
          rid,
        ]
      );

    if (!ownedSupplier) {
      return res.status(404).json({
        error:
          "Supplier not found",
      });
    }
  }
}

      const sets = [];
      const vals = [];

      const add = (
        column,
        value
      ) => {
        sets.push(
          `${column} = ?`
        );

        vals.push(value);
      };

      if (
        category_id !==
        undefined
      ) {
        add(
          "category_id",
          category_id
            ? Number(
                category_id
              )
            : null
        );
      }

      if (
        ingredient !==
        undefined
      ) {
        const cleanIngredient =
          String(
            ingredient || ""
          ).trim();

        if (
          !cleanIngredient
        ) {
          return res
            .status(400)
            .json({
              error:
                "ingredient required",
            });
        }

        add(
          "ingredient",
          cleanIngredient
        );
      }

      if (
        quantity !==
        undefined
      ) {
        const qty =
          Number(quantity);

        if (
          !Number.isFinite(
            qty
          ) ||
          qty < 0
        ) {
          return res
            .status(400)
            .json({
              error:
                "Invalid quantity",
            });
        }

        add(
          "quantity",
          qty
        );
      }

      if (
        unit !==
        undefined
      ) {
        add(
          "unit",
          unit || "unit"
        );
      }

      if (
        price !==
        undefined
      ) {
        const numericPrice =
          Number(price);

        if (
          price !== null &&
          price !== "" &&
          (
            !Number.isFinite(
              numericPrice
            ) ||
            numericPrice < 0
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                "Invalid price",
            });
        }

        add(
          "price",
          price == null ||
          price === ""
            ? 0
            : numericPrice
        );
      }

      if (
        allergens !==
        undefined
      ) {
        add(
          "allergens",
          allergens ||
            "None"
        );
      }

      if (
        calories_per_100g !==
        undefined
      ) {
        const calories =
          Number(
            calories_per_100g
          );

        if (
          calories_per_100g !==
            null &&
          calories_per_100g !==
            "" &&
          (
            !Number.isFinite(
              calories
            ) ||
            calories < 0
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                "Invalid calories",
            });
        }

        add(
          "calories_per_100g",
          calories_per_100g ==
              null ||
            calories_per_100g ===
              ""
            ? 0
            : calories
        );
      }

      if (
        expiry_date !==
        undefined
      ) {
        add(
          "expiry_date",
          expiry_date ||
            null
        );
      }

      if (
        supplier_id !==
        undefined
      ) {
        add(
          "supplier_id",
          safeSupplierId,
        );
      }

      if (
        category !==
        undefined
      ) {
        add(
          "category",
          category || null
        );
      }

      if (
        type !==
        undefined
      ) {
        add(
          "type",
          type ||
            "ingredient"
        );
      }

      if (
        min_threshold !==
        undefined
      ) {
        add(
          "min_threshold",
          min_threshold === ""
            ? null
            : min_threshold
        );
      }

      if (
        minimum_level !==
        undefined
      ) {
        const minimum =
          Number(
            minimum_level
          );

        if (
          !Number.isFinite(
            minimum
          ) ||
          minimum < 0
        ) {
          return res
            .status(400)
            .json({
              error:
                "Invalid minimum level",
            });
        }

        add(
          "minimum_level",
          minimum
        );
      }

      if (
        portions_left !==
        undefined
      ) {
        const portions =
          Number(
            portions_left
          );

        if (
          !Number.isFinite(
            portions
          ) ||
          portions < 0
        ) {
          return res
            .status(400)
            .json({
              error:
                "Invalid portions left",
            });
        }

        add(
          "portions_left",
          portions
        );
      }

      if (!sets.length) {
        return res
          .status(400)
          .json({
            error:
              "No fields to update",
          });
      }

      vals.push(
        id,
        rid
      );

      const result =
        await qRun(
          `
          UPDATE stock
          SET ${sets.join(", ")}
          WHERE id = ?
            AND restaurant_id = ?
          `,
          vals
        );

      const changed =
        result?.rowCount ??
        result?.changes ??
        0;

      if (!changed) {
        return res
          .status(404)
          .json({
            error:
              "Stock item not found",
          });
      }

      const updated =
        await qGet(
          `
          SELECT *
          FROM stock
          WHERE id = ?
            AND restaurant_id = ?
          LIMIT 1
          `,
          [
            id,
            rid,
          ]
        );

      return res.json({
        success: true,
        item:
          protectStockCost(
            req,
            updated
          ),
      });
    } catch (err) {
      console.error(
        "❌ PUT /stock/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to update stock item.",
      });
    }
  }
);

// =========================================================
// DELETE /stock/:id
// Permanent deletion
// =========================================================

router.delete(
  "/:id",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_DELETE
  ),
  async (req, res) => {
    const rid =
      ridOf(req);

    const id =
      Number(
        req.params.id
      );

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid id",
        });
      }

      const result =
        await qRun(
          `
          DELETE FROM stock
          WHERE id = ?
            AND restaurant_id = ?
          `,
          [
            id,
            rid,
          ]
        );

      const changed =
        result?.rowCount ??
        result?.changes ??
        0;

      if (!changed) {
        return res.status(404).json({
          error:
            "Stock item not found",
        });
      }

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "❌ DELETE /stock/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to delete stock item.",
      });
    }
  }
);

// =========================================================
// GET /stock/ingredients/by-meal
// =========================================================

router.get(
  "/ingredients/by-meal",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_VIEW
  ),
  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      const name =
        String(
          req.query.name ||
            ""
        ).trim();

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      if (!name) {
        return res.json([]);
      }

      const meal =
        await qGet(
          `
          SELECT id
          FROM meals
          WHERE restaurant_id = ?
            AND LOWER(
              TRIM(name)
            ) = LOWER(
              TRIM(?)
            )
          LIMIT 1
          `,
          [
            rid,
            name,
          ]
        );

      if (!meal) {
        return res.json([]);
      }

      const rows =
        await qAll(
          `
          SELECT
            mi.ingredient,
            mi.quantity,
            s.unit,
            s.price
          FROM meal_ingredients mi

          LEFT JOIN stock s
            ON s.restaurant_id = ?
           AND LOWER(
             TRIM(s.ingredient)
           ) = LOWER(
             TRIM(mi.ingredient)
           )

          WHERE mi.meal_id = ?
          `,
          [
            rid,
            meal.id,
          ]
        );

      return res.json(
        protectStockCosts(
          req,
          rows
        )
      );
    } catch (err) {
      console.error(
        "❌ GET /stock/ingredients/by-meal failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch meal ingredients.",
      });
    }
  }
);

// =========================================================
// GET /stock/by-category/:id
// =========================================================

router.get(
  "/by-category/:id",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_VIEW
  ),
  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      const categoryId =
        Number(
          req.params.id ||
            0
        );

      if (!rid) {
        return res
          .status(400)
          .json({
            error:
              "Missing rid",
          });
      }

      if (!categoryId) {
        return res
          .status(400)
          .json({
            error:
              "Invalid category id",
          });
      }

      const wantedType =
        String(
          req.query.type ||
            ""
        )
          .trim()
          .toLowerCase();

      const categoryRow =
        await qGet(
          `
          SELECT type
          FROM categories
          WHERE restaurant_id = ?
            AND id = ?
          LIMIT 1
          `,
          [
            rid,
            categoryId,
          ]
        );

      const categoryType =
        String(
          categoryRow?.type ||
            ""
        )
          .trim()
          .toLowerCase();

      const effectiveType =
        wantedType ||
        (
          categoryType.startsWith(
            "drink"
          )
            ? "drink"
            : categoryType.startsWith(
                  "dessert"
                )
              ? "dessert"
              : ""
        );

      let sql = `
        SELECT
          id,
          ingredient,
          type,
          category_id,
          category,
          price,
          quantity,
          unit,
          allergens,
          supplier_id,
          calories_per_100g,
          expiry_date,
          portions_left,
          restaurant_id
        FROM stock
        WHERE restaurant_id = ?
          AND category_id = ?
      `;

      const params = [
        rid,
        categoryId,
      ];

      if (
        effectiveType
      ) {
        sql += `
          AND LOWER(
            TRIM(
              COALESCE(type,'')
            )
          ) IN (?, ?)
        `;

        params.push(
          effectiveType,
          `${effectiveType}s`
        );
      }

      sql += `
        ORDER BY
          LOWER(
            TRIM(ingredient)
          ) ASC
      `;

      const rows =
        await qAll(
          sql,
          params
        );

      return res.json(
        protectStockCosts(
          req,
          rows
        )
      );
    } catch (err) {
      console.error(
        "❌ /stock/by-category/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to load stock by category",
      });
    }
  }
);

// =========================================================
// GET /stock/search?q=co
// Lightweight stock lookup
// =========================================================

router.get(
  "/search",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_VIEW
  ),
  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      const q =
        String(
          req.query.q ||
            ""
        )
          .trim()
          .toLowerCase();

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      if (
        q.length < 2
      ) {
        return res.json([]);
      }

      const rows =
        await qAll(
          `
          SELECT
            id,
            ingredient
          FROM stock
          WHERE restaurant_id = ?
            AND ingredient IS NOT NULL
            AND LOWER(
              TRIM(ingredient)
            ) LIKE ?
          ORDER BY
            LOWER(
              TRIM(ingredient)
            ) ASC
          LIMIT 20
          `,
          [
            rid,
            `%${q}%`,
          ]
        );

      return res.json(
        (rows || [])
          .map((row) => ({
            id:
              Number(
                row.id
              ),

            ingredient:
              String(
                row.ingredient ||
                  ""
              ).trim(),

            // compatibility
            value:
              String(
                row.ingredient ||
                  ""
              )
                .trim()
                .toLowerCase(),
          }))
          .filter(
            (row) =>
              row.id &&
              row.ingredient
          )
      );
    } catch (err) {
      console.error(
        "❌ GET /stock/search failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed stock search",
      });
    }
  }
);

// =========================================================
// GET /stock/search-rows?q=cu
// =========================================================

router.get(
  "/search-rows",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.STOCK_VIEW
  ),
  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      const q =
        String(
          req.query.q ||
            ""
        )
          .trim()
          .toLowerCase();

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (missing rid)",
        });
      }

      if (
        q.length < 2
      ) {
        return res.json([]);
      }

      const rows =
        await qAll(
          `
          SELECT
            id,
            ingredient
          FROM stock
          WHERE restaurant_id = ?
            AND ingredient IS NOT NULL
            AND LOWER(
              TRIM(ingredient)
            ) LIKE ?
          ORDER BY ingredient ASC
          LIMIT 20
          `,
          [
            rid,
            `%${q}%`,
          ]
        );

      return res.json(
        rows || []
      );
    } catch (err) {
      console.error(
        "❌ GET /stock/search-rows failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed stock search rows",
      });
    }
  }
);

module.exports = router;