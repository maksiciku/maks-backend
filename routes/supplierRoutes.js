// routes/supplierRoutes.js
// POSTGRES / dbCompat version

const express = require("express");
const router = express.Router();

const {
  qAll,
  qGet,
  qRun,
} = require("../dbCompat");

const {
  authenticateToken,
} = require("../middleware/authMiddleware");

const {
  loadMembership,
} = require("../middleware/tenantMembership");

const {
  PERMISSIONS,
  requirePermission,
} = require("../middleware/accessControl");

// =========================================================
// TENANT
// =========================================================

const ridOf = (req) =>
  Number(
    req.tenantRid ||
    req.user?.restaurant_id ||
    0
  );

// =========================================================
// GET /suppliers
// Supplier directory
// =========================================================

router.get(
  "/",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_VIEW),
  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const rows = await qAll(
        `
        SELECT
          s.id,
          s.name,
          s.website,
          s.phone,
          s.contact_name,
          s.delivery_days,
          s.platform_supplier_id,
          ps.name AS platform_supplier_name,
          ps.slug AS platform_supplier_slug

        FROM suppliers s

        LEFT JOIN public.platform_suppliers ps
          ON ps.id =
             s.platform_supplier_id

        WHERE s.restaurant_id = $1

        ORDER BY
          LOWER(
            TRIM(s.name)
          ) ASC
        `,
        [rid]
      );

      return res.json(
        rows || []
      );
    } catch (err) {
      console.error(
        "❌ GET /suppliers failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch suppliers.",
      });
    }
  }
);

// =========================================================
// GET /suppliers/platform/search
//
// Search MAKS platform supplier network.
//
// This can expose supplier catalogue/network information,
// therefore it requires supplier visibility.
// =========================================================

router.get(
  "/platform/search",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_VIEW),
  async (req, res) => {
    try {
      const q =
        String(
          req.query.q ||
          ""
        ).trim();

      if (q.length < 2) {
        return res.json([]);
      }

      const rows = await qAll(
        `
        SELECT
          ps.id,
          ps.name,
          ps.slug,
          ps.website,
          ps.phone,
          COUNT(pp.id)::int
            AS product_count

        FROM public.platform_suppliers ps

        LEFT JOIN public.platform_supplier_products pp
          ON pp.platform_supplier_id =
             ps.id
         AND pp.is_active = TRUE

        WHERE ps.is_active = TRUE
          AND (
            LOWER(ps.name)
              LIKE LOWER(
                '%' || $1 || '%'
              )

            OR LOWER(ps.slug)
              LIKE LOWER(
                '%' || $1 || '%'
              )
          )

        GROUP BY ps.id

        ORDER BY
          ps.name ASC

        LIMIT 10
        `,
        [q]
      );

      return res.json(
        rows || []
      );
    } catch (err) {
      console.error(
        "❌ GET /suppliers/platform/search failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to search platform suppliers",
      });
    }
  }
);

// =========================================================
// GET /suppliers/prices/:ingredient
// Commercial supplier-price tracker
// =========================================================

router.get(
  "/prices/:ingredient",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_PRICES),
  async (req, res) => {
    const ingredient =
      String(
        req.params.ingredient ||
        ""
      ).trim();

    if (!ingredient) {
      return res.status(400).json({
        error:
          "Ingredient required",
      });
    }

    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const rows = await qAll(
        `
        SELECT
          sp.id,
          sp.supplier_id,
          s.name AS supplier_name,
          sp.price_per_unit AS price,
          sp.created_at AS date

        FROM supplier_prices sp

        JOIN suppliers s
          ON s.id = sp.supplier_id
         AND s.restaurant_id =
             sp.restaurant_id

        WHERE sp.restaurant_id = $1

          AND LOWER(
            TRIM(sp.ingredient)
          ) = LOWER(
            TRIM($2)
          )

        ORDER BY
          sp.date DESC NULLS LAST,
          sp.id DESC
        `,
        [
          rid,
          ingredient,
        ]
      );

      return res.json(
        rows || []
      );
    } catch (err) {
      console.error(
        "❌ GET /suppliers/prices/:ingredient failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch supplier prices.",
      });
    }
  }
);

// =========================================================
// POST /suppliers/prices
//
// Insert/update commercial supplier pricing.
//
// IMPORTANT:
// Supplier ownership is verified BEFORE writing the price.
// =========================================================

router.post(
  "/prices",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_PRICES),
  async (req, res) => {
    const {
      supplier_id,
      ingredient,
      price,
    } = req.body || {};

    if (
      !supplier_id ||
      !ingredient ||
      price == null
    ) {
      return res.status(400).json({
        error:
          "supplier_id, ingredient and price are required",
      });
    }

    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const supplierId =
        Number(supplier_id);

      if (!supplierId) {
        return res.status(400).json({
          error:
            "Invalid supplier id",
        });
      }

      const cleanIngredient =
        String(
          ingredient
        ).trim();

      if (!cleanIngredient) {
        return res.status(400).json({
          error:
            "Ingredient required",
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
            "Invalid supplier price",
        });
      }

      // -----------------------------------------------------
      // SECURITY:
      // Verify supplier belongs to active restaurant.
      // -----------------------------------------------------

      const supplier =
        await qGet(
          `
          SELECT id
          FROM suppliers
          WHERE id = $1
            AND restaurant_id = $2
          LIMIT 1
          `,
          [
            supplierId,
            rid,
          ]
        );

      if (!supplier) {
        return res.status(404).json({
          error:
            "Supplier not found",
        });
      }

      await qRun(
        `
        INSERT INTO supplier_prices (
          restaurant_id,
          supplier_id,
          ingredient,
          price_per_unit,
          source,
          created_at
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          'manual',
          NOW()
        )

        ON CONFLICT (
          restaurant_id,
          supplier_id,
          ingredient
        )

        DO UPDATE SET
          price_per_unit = EXCLUDED.price_per_unit,
          source = 'manual',
          created_at = NOW()
        `,
        [
          rid,
          supplierId,
          cleanIngredient,
          numericPrice,
        ]
      );

      return res.status(201).json({
        success: true,
        message:
          "Supplier price recorded.",
      });
    } catch (err) {
      console.error(
        "❌ POST /suppliers/prices failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to record price.",
      });
    }
  }
);

// =========================================================
// POST /suppliers
// Create/link restaurant supplier
// =========================================================

router.post(
  "/",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_MANAGE),
  async (req, res) => {
    const {
      name,
      website = "",
      phone = "",
      contact_name = "",
      delivery_days = "",
      platform_supplier_id = null,
    } = req.body || {};

    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const cleanName =
        String(
          name || ""
        ).trim();

      if (!cleanName) {
        return res.status(400).json({
          error:
            "Supplier name is required",
        });
      }

      // -----------------------------------------------------
      // If linking to MAKS platform supplier,
      // verify the platform supplier actually exists.
      // -----------------------------------------------------

      let platformSupplierId =
        null;

      if (
        platform_supplier_id !==
          null &&
        platform_supplier_id !==
          "" &&
        platform_supplier_id !==
          undefined
      ) {
        platformSupplierId =
          Number(
            platform_supplier_id
          );

        if (!platformSupplierId) {
          return res.status(400).json({
            error:
              "Invalid platform supplier id",
          });
        }

        const platformSupplier =
          await qGet(
            `
            SELECT id
            FROM public.platform_suppliers
            WHERE id = $1
              AND is_active = TRUE
            LIMIT 1
            `,
            [
              platformSupplierId,
            ]
          );

        if (!platformSupplier) {
          return res.status(404).json({
            error:
              "Platform supplier not found",
          });
        }
      }

      const existing =
        await qGet(
          `
          SELECT id
          FROM suppliers
          WHERE LOWER(
            TRIM(name)
          ) = LOWER(
            TRIM($1)
          )
            AND restaurant_id = $2
          LIMIT 1
          `,
          [
            cleanName,
            rid,
          ]
        );

      if (existing) {
        return res.status(409).json({
          error:
            "Supplier already exists",
        });
      }

      const result =
        await qRun(
          `
          INSERT INTO suppliers (
            name,
            website,
            phone,
            contact_name,
            delivery_days,
            restaurant_id,
            platform_supplier_id
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7
          )

          RETURNING id
          `,
          [
            cleanName,
            String(
              website || ""
            ),
            String(
              phone || ""
            ),
            String(
              contact_name || ""
            ),
            String(
              delivery_days || ""
            ),
            rid,
            platformSupplierId,
          ]
        );

      const newId =
        result?.rows?.[0]?.id ??
        result?.lastID;

      return res.status(201).json({
        success: true,
        id: newId,
        name: cleanName,
        website:
          String(
            website || ""
          ),
        phone:
          String(
            phone || ""
          ),
        contact_name:
          String(
            contact_name || ""
          ),
        delivery_days:
          String(
            delivery_days || ""
          ),
      });
    } catch (err) {
      console.error(
        "❌ POST /suppliers failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to add supplier.",
      });
    }
  }
);

// =========================================================
// GET /suppliers/:id/catalogue
//
// IMPORTANT:
// This exposes catalogue pricing.
//
// Requires SUPPLIERS_PRICES.
// =========================================================

router.get(
  "/:id/catalogue",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_PRICES),
  async (req, res) => {
    try {
      const rid = ridOf(req);

      const supplierId =
        Number(
          req.params.id
        );

      const search =
        String(
          req.query.search ||
          ""
        ).trim();

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected",
        });
      }

      if (!supplierId) {
        return res.status(400).json({
          error:
            "Invalid supplier id",
        });
      }

      // -----------------------------------------------------
      // Tenant ownership check FIRST.
      // -----------------------------------------------------

      const supplier =
        await qGet(
          `
          SELECT
            id,
            name,
            platform_supplier_id,
            delivery_days

          FROM public.suppliers

          WHERE id = $1
            AND restaurant_id = $2

          LIMIT 1
          `,
          [
            supplierId,
            rid,
          ]
        );

      if (!supplier) {
        return res.status(404).json({
          error:
            "Supplier not found",
        });
      }

      if (
        !supplier.platform_supplier_id
      ) {
        return res.json({
          supplier,
          products: [],
        });
      }

      const products =
        await qAll(
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
            AND is_active = TRUE

            AND (
              $2 = ''

              OR LOWER(
                product_name
              ) LIKE LOWER(
                '%' || $2 || '%'
              )

              OR LOWER(
                product_code
              ) LIKE LOWER(
                '%' || $2 || '%'
              )

              OR LOWER(
                COALESCE(
                  marketplace_category,
                  ''
                )
              ) LIKE LOWER(
                '%' || $2 || '%'
              )
            )

          ORDER BY
            product_name ASC

          LIMIT 2000
          `,
          [
            Number(
              supplier.platform_supplier_id
            ),
            search,
          ]
        );

      return res.json({
        supplier,
        products:
          products || [],
      });
    } catch (err) {
      console.error(
        "❌ GET /suppliers/:id/catalogue failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to load supplier catalogue",
      });
    }
  }
);

// =========================================================
// GET /suppliers/:id
//
// IMPORTANT:
// Generic parameter route stays BELOW:
// - /platform/search
// - /prices/:ingredient
// - /prices
// - /:id/catalogue
// =========================================================

router.get(
  "/:id",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_VIEW),
  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const id =
        Number(
          req.params.id
        );

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid supplier id",
        });
      }

      const row =
        await qGet(
          `
          SELECT
            id,
            name,
            website,
            phone,
            contact_name,
            delivery_days

          FROM suppliers

          WHERE id = $1
            AND restaurant_id = $2
          `,
          [
            id,
            rid,
          ]
        );

      if (!row) {
        return res.status(404).json({
          error:
            "Supplier not found",
        });
      }

      return res.json(row);
    } catch (err) {
      console.error(
        "❌ GET /suppliers/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch supplier.",
      });
    }
  }
);

// =========================================================
// PUT /suppliers/:id
// Supplier administration
// =========================================================

router.put(
  "/:id",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_MANAGE),
  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const id =
        Number(
          req.params.id
        );

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid supplier id",
        });
      }

      const {
        name,
        website,
        phone,
        contact_name,
        delivery_days,
      } = req.body || {};

      const fields = [];
      const vals = [];
      let i = 1;

      if (name !== undefined) {
        const cleanName =
          String(
            name || ""
          ).trim();

        if (!cleanName) {
          return res.status(400).json({
            error:
              "Supplier name is required",
          });
        }

        fields.push(
          `name = $${i++}`
        );

        vals.push(
          cleanName
        );
      }

      if (
        website !==
        undefined
      ) {
        fields.push(
          `website = $${i++}`
        );

        vals.push(
          String(
            website || ""
          )
        );
      }

      if (
        phone !==
        undefined
      ) {
        fields.push(
          `phone = $${i++}`
        );

        vals.push(
          String(
            phone || ""
          )
        );
      }

      if (
        contact_name !==
        undefined
      ) {
        fields.push(
          `contact_name = $${i++}`
        );

        vals.push(
          String(
            contact_name || ""
          )
        );
      }

      if (
        delivery_days !==
        undefined
      ) {
        fields.push(
          `delivery_days = $${i++}`
        );

        vals.push(
          String(
            delivery_days || ""
          )
        );
      }

      if (!fields.length) {
        return res.status(400).json({
          error:
            "No fields to update",
        });
      }

      vals.push(id);
      const idIdx = i++;

      vals.push(rid);
      const ridIdx = i++;

      const result =
        await qRun(
          `
          UPDATE suppliers

          SET ${fields.join(", ")}

          WHERE id = $${idIdx}
            AND restaurant_id =
                $${ridIdx}
          `,
          vals
        );

      const changed =
        result?.rowCount ??
        result?.changes ??
        0;

      if (!changed) {
        return res.status(404).json({
          error:
            "Supplier not found",
        });
      }

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "❌ PUT /suppliers/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to update supplier.",
      });
    }
  }
);

// =========================================================
// DELETE /suppliers/:id
// Supplier administration
// =========================================================

router.delete(
  "/:id",
  authenticateToken,
  loadMembership,
  requirePermission(PERMISSIONS.SUPPLIERS_MANAGE),
  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "No restaurant selected (rid missing)",
        });
      }

      const id =
        Number(
          req.params.id
        );

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid supplier id",
        });
      }

      const result =
        await qRun(
          `
          DELETE FROM suppliers
          WHERE id = $1
            AND restaurant_id = $2
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
            "Supplier not found",
        });
      }

      return res.json({
        success: true,
        message:
          "Supplier deleted successfully",
      });
    } catch (err) {
      console.error(
        "❌ DELETE /suppliers/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to delete supplier.",
      });
    }
  }
);

module.exports = router;