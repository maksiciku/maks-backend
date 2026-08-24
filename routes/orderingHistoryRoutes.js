const express = require("express");
const router = express.Router();

const { qAll, qRun } = require("../dbCompat");
const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");

const {
  PERMISSIONS,
  requirePermission,
} = require("../middleware/accessControl");

// Prefer active tenant, then authenticated user's restaurant.
const ridOf = (req) =>
  Number(req.tenantRid || req.user?.restaurant_id || 0);

// =========================================================
// GET /ordering-history
// View purchasing history
// =========================================================

router.get(
  "/",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.PURCHASE_ORDERS_VIEW),
  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error: "No restaurant selected.",
        });
      }

      const rows = await qAll(
        `
        SELECT
          id,
          restaurant_id,
          created_by_user_id,
          data,
          created_at
        FROM ordering_history
        WHERE restaurant_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [rid]
      );

      return res.json(rows || []);
    } catch (err) {
      console.error(
        "❌ GET /ordering-history failed:",
        err
      );

      return res.status(500).json({
        error: "Failed to fetch ordering history.",
      });
    }
  }
);

// =========================================================
// POST /ordering-history
//
// Current MAKS behaviour:
// This saves a purchasing/order snapshot.
// It does NOT approve or transmit an order to a supplier.
//
// Therefore:
// PURCHASE_ORDERS_CREATE
//
// PURCHASE_ORDERS_APPROVE is intentionally NOT used here.
// =========================================================

router.post(
  "/",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.PURCHASE_ORDERS_CREATE),
  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error: "No restaurant selected.",
        });
      }

      const groupedOrders = req.body?.groupedOrders;

      if (
        !groupedOrders ||
        typeof groupedOrders !== "object" ||
        Array.isArray(groupedOrders)
      ) {
        return res.status(400).json({
          error: "groupedOrders object is required.",
        });
      }

      const data = JSON.stringify(groupedOrders);

      const result = await qRun(
        `
        INSERT INTO ordering_history (
          restaurant_id,
          created_by_user_id,
          data
        )
        VALUES ($1, $2, $3::jsonb)
        RETURNING id, created_at
        `,
        [
          rid,
          req.user?.id || null,
          data,
        ]
      );

      const row = result?.rows?.[0];

      return res.status(201).json({
        success: true,
        id: row?.id,
        created_at: row?.created_at,
      });
    } catch (err) {
      console.error(
        "❌ POST /ordering-history failed:",
        err
      );

      return res.status(500).json({
        error: "Failed to save order history.",
      });
    }
  }
);

module.exports = router;