// ⚠️ IMPORTANT:
// This route ONLY reads the payments ledger.
// It does NOT restore POS order balances or table state.
//
// Refund / void operations belong to posRoutes.js.

const router =
  require("express").Router();

const {
  PERMISSIONS,
  requirePermission,
} = require(
  "../middleware/accessControl"
);

/*
 * Financial ledger access.
 *
 * Owner:
 * - always allowed by central authority.
 *
 * Manager / Staff:
 * - require reports.financial.
 */
router.get(
  "/",
  requirePermission(
    PERMISSIONS.REPORTS_FINANCIAL
  ),
  async (req, res) => {
    try {
      const rid =
        Number(req.tenantRid || 0);

      if (!rid) {
        return res.status(401).json({
          error: "No tenant",
        });
      }

      const rows =
        await req.qAll(
          `
          SELECT
            id,
            table_number,
            amount,
            method,
            status,
            created_at,
            ref_payment_id,
            source,
            staff_user_id,
            terminal_ref,
            pos_order_ids,
            cashup_session_id
          FROM public.payments
          WHERE restaurant_id = $1
          ORDER BY created_at DESC
          LIMIT 200
          `,
          [rid]
        );

      return res.json(
        rows || []
      );
    } catch (err) {
      console.error(
        "❌ GET /payments failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to load payments",
      });
    }
  }
);

/*
 * Intentionally disabled.
 *
 * POS financial state MUST be changed through
 * the authoritative POS refund flow.
 */
router.post(
  "/void",
  (req, res) => {
    return res.status(403).json({
      error:
        "Use /orders/payments/:id/refund instead",
    });
  }
);

module.exports = router;