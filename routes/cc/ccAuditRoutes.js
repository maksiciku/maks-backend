const express = require("express");
const { requirePlatformAdmin } = require("../../middleware/requirePlatformAdmin");

const router = express.Router();

/**
 * GET /cc/audit
 * Full platform admin audit feed with basic filters
 *
 * Query params:
 * - page
 * - limit
 * - action
 * - restaurant_id
 * - admin_email
 */
router.get(
  "/",
  requirePlatformAdmin("boss", "admin_manager", "support_staff", "read_only"),
  async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
      const offset = (page - 1) * limit;

      const action = String(req.query.action || "").trim();
      const adminEmail = String(req.query.admin_email || "").trim().toLowerCase();
      const restaurantIdRaw = req.query.restaurant_id;
      const restaurantId =
        restaurantIdRaw !== undefined && restaurantIdRaw !== null && restaurantIdRaw !== ""
          ? Number(restaurantIdRaw)
          : null;

      const where = [];
      const params = [];
      let i = 1;

      if (action) {
        where.push(`paa.action = $${i++}`);
        params.push(action);
      }

      if (Number.isFinite(restaurantId)) {
        where.push(`paa.target_restaurant_id = $${i++}`);
        params.push(restaurantId);
      }

      if (adminEmail) {
        where.push(`LOWER(pau.email) LIKE $${i++}`);
        params.push(`%${adminEmail}%`);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const countRow = await req.qGet(
        `
        SELECT COUNT(*)::int AS c
        FROM public.platform_admin_audit paa
        JOIN public.platform_admin_users pau ON pau.id = paa.admin_user_id
        LEFT JOIN public.restaurants r ON r.id = paa.target_restaurant_id
        ${whereSql}
        `,
        params
      );

      const rows = await req.qAll(
        `
        SELECT
          paa.id,
          paa.action,
          paa.target_restaurant_id,
          paa.entity,
          paa.entity_id,
          paa.meta,
          paa.created_at,

          pau.id AS admin_user_id,
          pau.email AS admin_email,
          pau.full_name AS admin_full_name,
          pau.role AS admin_role,

          r.name AS restaurant_name
        FROM public.platform_admin_audit paa
        JOIN public.platform_admin_users pau ON pau.id = paa.admin_user_id
        LEFT JOIN public.restaurants r ON r.id = paa.target_restaurant_id
        ${whereSql}
        ORDER BY paa.created_at DESC, paa.id DESC
        LIMIT $${i++}
        OFFSET $${i++}
        `,
        [...params, limit, offset]
      );

      return res.json({
        success: true,
        page,
        limit,
        total: Number(countRow?.c || 0),
        rows: (rows || []).map((r) => ({
          id: Number(r.id),
          action: r.action || "",
          target_restaurant_id: r.target_restaurant_id ? Number(r.target_restaurant_id) : null,
          restaurant_name: r.restaurant_name || "",
          entity: r.entity || "",
          entity_id: r.entity_id || "",
          meta: r.meta || {},
          created_at: r.created_at,
          admin: {
            id: Number(r.admin_user_id),
            email: r.admin_email || "",
            full_name: r.admin_full_name || "",
            role: r.admin_role || "",
          },
        })),
      });
    } catch (err) {
      console.error("❌ GET /cc/audit failed:", err);
      return res.status(500).json({ error: "Failed to load platform audit" });
    }
  }
);

module.exports = router;