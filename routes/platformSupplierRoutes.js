const express = require("express");
const { requirePlatformAdmin } = require("../middleware/requirePlatformAdmin");

const router = express.Router();

/*
GET /platform-suppliers
*/
router.get(
  "/",
  requirePlatformAdmin("boss", "admin_manager", "support_staff", "read_only"),
  async (req, res) => {
    try {
      const rows = await req.qAll(`
        SELECT
          ps.id,
          ps.name,
          ps.slug,
          ps.website,
          ps.phone,
          ps.contact_name,
          ps.is_active,
          COUNT(psp.id)::int AS product_count
        FROM public.platform_suppliers ps
        LEFT JOIN public.platform_supplier_products psp
          ON psp.platform_supplier_id = ps.id
        GROUP BY ps.id
        ORDER BY ps.name ASC
      `);

      return res.json(rows || []);
    } catch (err) {
      console.error(err);
      return res.status(500).json({
        error: "Failed to load platform suppliers",
      });
    }
  }
);

/*
GET /platform-suppliers/:id/products
*/
router.get(
  "/:id/products",
  requirePlatformAdmin("boss", "admin_manager", "support_staff", "read_only"),
  async (req, res) => {
    try {
      const supplierId = Number(req.params.id);
      const search = String(req.query.search || "").trim();

      const rows = await req.qAll(
        `
        SELECT
  id,
  product_code,
  unit_of_order_code,
  product_name,
  quantity_type,
  product_group,
  marketplace_category,
  price,
  is_active,
  pack_count,
  unit_size,
  unit,
  total_quantity,
  pack_description
FROM public.platform_supplier_products
        WHERE platform_supplier_id = $1
          AND (
            $2 = ''
            OR LOWER(product_name) LIKE LOWER('%' || $2 || '%')
            OR LOWER(product_code) LIKE LOWER('%' || $2 || '%')
          )
        ORDER BY product_name ASC
        LIMIT 2000
        `,
        [supplierId, search]
      );

      return res.json(rows || []);
    } catch (err) {
      console.error(err);
      return res.status(500).json({
        error: "Failed to load supplier products",
      });
    }
  }
);

module.exports = router;