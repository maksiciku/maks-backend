// backend/routes/orderingHubRoutes.js

const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");

const {
  PERMISSIONS,
  requirePermission,
} = require("../middleware/accessControl");

const { qAll } = require("../dbCompat");

const ridOf = (req) =>
  Number(req.tenantRid || req.user?.restaurant_id || 0);

const INGREDIENT_TYPES_SQL = `
  (
    type IS NULL
    OR TRIM(type) = ''
    OR LOWER(TRIM(type)) IN (
      'ingredient',
      'ingredients',
      'raw'
    )
  )
`;

// =========================================================
// GET /stock/order-list
//
// Commercial purchasing view.
// Contains:
// - stock levels
// - supplier selection
// - supplier prices
// - estimated purchasing spend
//
// Requires purchasing visibility.
// =========================================================

router.get(
  "/stock/order-list",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.PURCHASE_ORDERS_VIEW),
  async (req, res) => {
    const rid = ridOf(req);

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const rows = await qAll(
        `
        SELECT
          st.id,
          st.ingredient,
          st.quantity,
          st.unit,
          st.price AS stock_price,
          st.allergens,
          st.category,
          st.type,
          st.restaurant_id,
          st.supplier_id,
          st.updated_at,

          COALESCE(
            st.minimum_level,
            0
          ) AS minimum_level,

          best.supplier_id
            AS best_supplier_id,

          best.supplier_name
            AS best_supplier,

          best.price_per_unit
            AS best_price,

          best.source
            AS price_source,

          best.created_at
            AS price_date,

          CASE
            WHEN COALESCE(
              st.minimum_level,
              0
            ) <= 0
              THEN 0

            WHEN COALESCE(
              st.quantity,
              0
            ) < COALESCE(
              st.minimum_level,
              0
            )
              THEN CEIL(
                COALESCE(
                  st.minimum_level,
                  0
                ) -
                COALESCE(
                  st.quantity,
                  0
                )
              )

            ELSE 0
          END AS suggested_order_qty,

          CASE
            WHEN COALESCE(
              st.quantity,
              0
            ) <= 0
              THEN 'URGENT'

            WHEN COALESCE(
              st.minimum_level,
              0
            ) > 0
              AND COALESCE(
                st.quantity,
                0
              ) < COALESCE(
                st.minimum_level,
                0
              )
              THEN 'Order Soon'

            ELSE 'Can wait'
          END AS urgency

        FROM public.stock st

        LEFT JOIN LATERAL (
          SELECT
            sp.supplier_id,
            s.name AS supplier_name,
            sp.price_per_unit,
            COALESCE(
              sp.source,
              'manual'
            ) AS source,
            sp.created_at

          FROM public.supplier_prices sp

          JOIN public.suppliers s
            ON s.id = sp.supplier_id
           AND s.restaurant_id =
               sp.restaurant_id

          WHERE sp.restaurant_id =
                  st.restaurant_id

            AND LOWER(
              TRIM(sp.ingredient)
            ) = LOWER(
              TRIM(st.ingredient)
            )

            AND sp.price_per_unit
                IS NOT NULL

          ORDER BY
            sp.price_per_unit ASC,
            sp.created_at DESC
              NULLS LAST,
            sp.id DESC

          LIMIT 1
        ) best ON TRUE

        WHERE st.restaurant_id = $1
          AND ${INGREDIENT_TYPES_SQL}

        ORDER BY
          CASE
            WHEN COALESCE(
              st.quantity,
              0
            ) <= 0
              THEN 0

            WHEN COALESCE(
              st.minimum_level,
              0
            ) > 0
              AND COALESCE(
                st.quantity,
                0
              ) < COALESCE(
                st.minimum_level,
                0
              )
              THEN 1

            ELSE 2
          END,

          LOWER(
            TRIM(st.ingredient)
          ) ASC
        `,
        [rid]
      );

      const orderList = (rows || []).map((row) => {
        const currentQty =
          Number(row.quantity || 0);

        const minLevel =
          Number(row.minimum_level || 0);

        const suggestedQty =
          Number(row.suggested_order_qty || 0);

        const bestPrice =
          row.best_price != null
            ? Number(row.best_price)
            : null;

        const stockPrice =
          row.stock_price != null
            ? Number(row.stock_price)
            : null;

        const effectivePrice =
          bestPrice ??
          stockPrice ??
          null;

        return {
          id: Number(row.id),

          ingredient:
            row.ingredient || "",

          quantity:
            currentQty,

          unit:
            row.unit || "",

          minimum_level:
            minLevel,

          allergens:
            row.allergens || "",

          category:
            row.category || "",

          type:
            row.type || "ingredient",

          restaurant_id:
            Number(row.restaurant_id),

          supplier_id:
            row.best_supplier_id
              ? Number(
                  row.best_supplier_id
                )
              : null,

          supplier:
            row.best_supplier || null,

          best_supplier_id:
            row.best_supplier_id
              ? Number(
                  row.best_supplier_id
                )
              : null,

          best_supplier:
            row.best_supplier || null,

          best_price:
            bestPrice,

          stock_price:
            stockPrice,

          effective_price:
            effectivePrice,

          price_source:
            row.price_source ||
            (
              stockPrice != null
                ? "stock"
                : null
            ),

          price_date:
            row.price_date ||
            row.updated_at ||
            null,

          missing_price:
            effectivePrice == null,

          suggested_order_qty:
            suggestedQty,

          estimated_total:
            effectivePrice != null &&
            suggestedQty > 0
              ? Number(
                  (
                    effectivePrice *
                    suggestedQty
                  ).toFixed(2)
                )
              : 0,

          urgency:
            row.urgency ||
            "Can wait",
        };
      });

      const analytics = {
        total_items:
          orderList.length,

        low_stock_items:
          orderList.filter(
            (item) =>
              item.suggested_order_qty > 0
          ).length,

        urgent_items:
          orderList.filter(
            (item) =>
              item.urgency === "URGENT"
          ).length,

        missing_prices:
          orderList.filter(
            (item) =>
              item.missing_price
          ).length,

        suppliers_needed:
          new Set(
            orderList
              .filter(
                (item) =>
                  item.suggested_order_qty > 0 &&
                  item.best_supplier
              )
              .map(
                (item) =>
                  item.best_supplier
              )
          ).size,

        estimated_spend:
          Number(
            orderList
              .reduce(
                (sum, item) =>
                  sum +
                  Number(
                    item.estimated_total ||
                    0
                  ),
                0
              )
              .toFixed(2)
          ),
      };

      return res.json({
        success: true,
        analytics,
        orderList,
      });
    } catch (err) {
      console.error(
        "❌ GET /stock/order-list failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to build order list",
      });
    }
  }
);

// =========================================================
// GET /smart-order
//
// Builds supplier-grouped purchasing suggestions.
//
// Read-only commercial purchasing operation.
// =========================================================

router.get(
  "/smart-order",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.PURCHASE_ORDERS_VIEW),
  async (req, res) => {
    const rid = ridOf(req);

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const rows = await qAll(
        `
        SELECT
          st.ingredient,
          st.quantity,
          st.unit,

          COALESCE(
            st.minimum_level,
            0
          ) AS minimum_level,

          best.supplier_name
            AS supplier_name,

          best.price_per_unit
            AS price,

          best.source
            AS source,

          best.created_at
            AS price_date,

          CASE
            WHEN COALESCE(
              st.minimum_level,
              0
            ) <= 0
              THEN 0

            WHEN COALESCE(
              st.quantity,
              0
            ) < COALESCE(
              st.minimum_level,
              0
            )
              THEN CEIL(
                COALESCE(
                  st.minimum_level,
                  0
                ) -
                COALESCE(
                  st.quantity,
                  0
                )
              )

            ELSE 0
          END AS suggested_order_qty

        FROM public.stock st

        LEFT JOIN LATERAL (
          SELECT
            s.name AS supplier_name,
            sp.price_per_unit,
            COALESCE(
              sp.source,
              'manual'
            ) AS source,
            sp.created_at

          FROM public.supplier_prices sp

          JOIN public.suppliers s
            ON s.id = sp.supplier_id
           AND s.restaurant_id =
               sp.restaurant_id

          WHERE sp.restaurant_id =
                  st.restaurant_id

            AND LOWER(
              TRIM(sp.ingredient)
            ) = LOWER(
              TRIM(st.ingredient)
            )

            AND sp.price_per_unit
                IS NOT NULL

          ORDER BY
            sp.price_per_unit ASC,
            sp.created_at DESC
              NULLS LAST,
            sp.id DESC

          LIMIT 1
        ) best ON TRUE

        WHERE st.restaurant_id = $1
          AND ${INGREDIENT_TYPES_SQL}

          AND COALESCE(
            st.minimum_level,
            0
          ) > 0

          AND COALESCE(
            st.quantity,
            0
          ) < COALESCE(
            st.minimum_level,
            0
          )

        ORDER BY
          LOWER(
            TRIM(st.ingredient)
          ) ASC
        `,
        [rid]
      );

      const grouped = {};

      for (const row of rows || []) {
        const supplierName =
          row.supplier_name ||
          "Missing Supplier / Price";

        const qty =
          Number(
            row.suggested_order_qty ||
            0
          );

        const price =
          row.price != null
            ? Number(row.price)
            : null;

        const total =
          price != null
            ? Number(
                (
                  price * qty
                ).toFixed(2)
              )
            : 0;

        if (!grouped[supplierName]) {
          grouped[supplierName] = {
            items: [],
            subtotal: 0,
          };
        }

        grouped[
          supplierName
        ].items.push({
          ingredient:
            row.ingredient || "",

          amount:
            qty,

          unit:
            row.unit || "",

          price,
          unitPrice: price,
          total,

          source:
            row.source || null,

          price_date:
            row.price_date || null,
        });

        grouped[
          supplierName
        ].subtotal = Number(
          (
            grouped[
              supplierName
            ].subtotal +
            total
          ).toFixed(2)
        );
      }

      return res.json(grouped);
    } catch (err) {
      console.error(
        "❌ GET /smart-order failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to build smart order",
      });
    }
  }
);

// =========================================================
// GET /ordering-history
//
// Compatibility alias.
//
// The dedicated orderingHistoryRoutes.js remains the
// canonical history endpoint.
// =========================================================

router.get(
  "/ordering-history",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.PURCHASE_ORDERS_VIEW),
  async (req, res) => {
    const rid = ridOf(req);

    try {
      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const rows = await qAll(
        `
        SELECT
          id,
          restaurant_id,
          created_by_user_id,
          created_at,
          data
        FROM public.ordering_history
        WHERE restaurant_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [rid]
      );

      return res.json(
        rows || []
      );
    } catch (err) {
      console.error(
        "❌ GET /ordering-history failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to load ordering history",
      });
    }
  }
);

module.exports = router;