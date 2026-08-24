// routes/tables.js

const express = require("express");
const router = express.Router();

const {
  canonicalTableName,
} = require("../services/tablesService");

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

const {
  qAll,
  qGet,
  qRun,
  kind,
} = require("../dbCompat");

// =========================================================
// HELPERS
// =========================================================

function ridOf(req) {
  const rid = Number(
    req.tenantRid ||
      req.user?.restaurant_id ||
      0
  );

  return Number.isInteger(rid) && rid > 0
    ? rid
    : 0;
}

function changedRows(result) {
  return Number(
    result?.rowCount ??
      result?.changes ??
      0
  );
}

// =========================================================
// GET /tables
//
// Supports:
//   ?groupByZone=1
//
// Tenant-safe table list.
// =========================================================

router.get(
  "/",
  authenticateToken,
  loadMembership,
  async (req, res) => {
    try {
      const rid = ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      const group = String(
        req.query.groupByZone || ""
      )
        .trim()
        .toLowerCase();

      const wantGrouped =
        group === "1" ||
        group === "true" ||
        group === "yes";

      const isPg =
        kind === "pg";

      const rows = await qAll(
        isPg
          ? `
            SELECT
              t.id,
              t.name,
              COALESCE(t.seats, 2) AS seats,

              CASE
                WHEN COALESCE(
                  ords.live_total,
                  0
                ) > 0
                  THEN 'occupied'

                ELSE COALESCE(
                  NULLIF(
                    TRIM(t.status),
                    ''
                  ),
                  'free'
                )
              END AS status,

              COALESCE(
                tm.x,
                0
              ) AS x,

              COALESCE(
                tm.y,
                0
              ) AS y,

              COALESCE(
                NULLIF(
                  TRIM(tm.zone),
                  ''
                ),
                'Main'
              ) AS zone,

              ords.session_started_at,

              COALESCE(
                ords.live_total,
                0
              ) AS live_total

            FROM public.tables t

            LEFT JOIN public.table_map tm
              ON tm.restaurant_id =
                 t.restaurant_id

             AND (
               tm.id = t.id

               OR LOWER(
                    TRIM(tm.name)
                  ) =
                  LOWER(
                    TRIM(t.name)
                  )
             )

            LEFT JOIN (
              SELECT
                restaurant_id,

                LOWER(
                  TRIM(table_number)
                ) AS table_name_key,

                regexp_replace(
                  LOWER(
                    TRIM(table_number)
                  ),
                  '[^0-9]',
                  '',
                  'g'
                ) AS table_num_key,

                COALESCE(
                  SUM(
                    COALESCE(
                      remaining_price,
                      0
                    )
                  ),
                  0
                ) AS live_total,

                MIN(
                  created_at
                ) AS session_started_at

              FROM public.pos_orders

              WHERE
                COALESCE(
                  paid,
                  0
                ) = 0

                AND COALESCE(
                  remaining_price,
                  0
                ) > 0

                AND LOWER(
                  COALESCE(
                    order_status,
                    'open'
                  )
                ) NOT IN (
                  'closed',
                  'closed_unpaid',
                  'voided',
                  'cancelled'
                )

              GROUP BY
                restaurant_id,

                LOWER(
                  TRIM(table_number)
                ),

                regexp_replace(
                  LOWER(
                    TRIM(table_number)
                  ),
                  '[^0-9]',
                  '',
                  'g'
                )
            ) ords

              ON ords.restaurant_id =
                 t.restaurant_id

             AND (
               ords.table_name_key =
                 LOWER(
                   TRIM(t.name)
                 )

               OR ords.table_num_key =
                 regexp_replace(
                   LOWER(
                     TRIM(t.name)
                   ),
                   '[^0-9]',
                   '',
                   'g'
                 )
             )

            WHERE
              t.restaurant_id = $1

            ORDER BY
              t.id ASC
          `
          : `
            SELECT
              t.id,
              t.name,
              COALESCE(
                t.seats,
                2
              ) AS seats,

              COALESCE(
                NULLIF(
                  TRIM(t.status),
                  ''
                ),
                'free'
              ) AS status,

              COALESCE(
                tm.x,
                0
              ) AS x,

              COALESCE(
                tm.y,
                0
              ) AS y,

              COALESCE(
                NULLIF(
                  TRIM(tm.zone),
                  ''
                ),
                'Main'
              ) AS zone,

              ords.session_started_at,

              COALESCE(
                ords.live_total,
                0
              ) AS live_total

            FROM tables t

            LEFT JOIN table_map tm
              ON tm.restaurant_id =
                 t.restaurant_id
             AND tm.id = t.id

            LEFT JOIN (
              SELECT
                restaurant_id,

                LOWER(
                  TRIM(table_number)
                ) AS table_name_key,

                COALESCE(
                  SUM(
                    COALESCE(
                      remaining_price,
                      0
                    )
                  ),
                  0
                ) AS live_total,

                MIN(
                  created_at
                ) AS session_started_at

              FROM pos_orders

              WHERE
                paid = 0

              GROUP BY
                restaurant_id,
                LOWER(
                  TRIM(table_number)
                )
            ) ords

              ON ords.restaurant_id =
                 t.restaurant_id

             AND ords.table_name_key =
                 LOWER(
                   TRIM(t.name)
                 )

            WHERE
              t.restaurant_id = ?

            ORDER BY
              t.id ASC
          `,
        [rid]
      );

      if (!wantGrouped) {
        return res.json(
          rows || []
        );
      }

      const byZone =
        (rows || []).reduce(
          (acc, table) => {
            const zone =
              table.zone ||
              "Main";

            if (!acc[zone]) {
              acc[zone] = [];
            }

            acc[zone].push(
              table
            );

            return acc;
          },
          {}
        );

      return res.json({
        zones:
          Object.keys(
            byZone
          ).sort(),

        byZone,
      });
    } catch (err) {
      console.error(
        "❌ GET /tables failed:",
        err
      );

      return res.status(500).json({
        error:
          "Error fetching tables",
      });
    }
  }
);

// =========================================================
// GET /tables/zones/list
//
// IMPORTANT:
// Static route stays before dynamic routes.
// =========================================================

router.get(
  "/zones/list",
  authenticateToken,
  loadMembership,
  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing tenant",
        });
      }

      const isPg =
        kind === "pg";

      const rows =
        await qAll(
          isPg
            ? `
              SELECT DISTINCT
                COALESCE(
                  NULLIF(
                    TRIM(zone),
                    ''
                  ),
                  'Main'
                ) AS zone

              FROM public.table_map

              WHERE
                restaurant_id = $1

              ORDER BY
                zone ASC
            `
            : `
              SELECT DISTINCT
                COALESCE(
                  NULLIF(
                    TRIM(zone),
                    ''
                  ),
                  'Main'
                ) AS zone

              FROM table_map

              WHERE
                restaurant_id = ?

              ORDER BY
                zone ASC
            `,
          [rid]
        );

      return res.json(
        (rows || []).map(
          (row) => row.zone
        )
      );
    } catch (err) {
      console.error(
        "❌ GET /tables/zones/list failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch zones",
      });
    }
  }
);

// =========================================================
// GET /tables/:tableId/total
//
// Returns the current live unpaid total for one table.
//
// SECURITY:
// The requested table MUST belong to the authenticated
// restaurant. A cross-tenant ID returns 404.
// =========================================================

router.get(
  "/:tableId/total",
  authenticateToken,
  loadMembership,
  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      const tableId =
        Number(
          req.params.tableId
        );

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing tenant",
        });
      }

      if (
        !Number.isInteger(
          tableId
        ) ||
        tableId <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid tableId",
        });
      }

      const isPg =
        kind === "pg";

      const table =
        await qGet(
          isPg
            ? `
              SELECT
                id,
                name

              FROM public.tables

              WHERE
                restaurant_id = $1
                AND id = $2

              LIMIT 1
            `
            : `
              SELECT
                id,
                name

              FROM tables

              WHERE
                restaurant_id = ?
                AND id = ?

              LIMIT 1
            `,
          [
            rid,
            tableId,
          ]
        );

      if (!table) {
        return res.status(404).json({
          error:
            "Table not found",
        });
      }

      const tableName =
        canonicalTableName(
          table.name
        );

      const row =
        await qGet(
          isPg
            ? `
              SELECT
                COALESCE(
                  SUM(
                    COALESCE(
                      remaining_price,
                      total_price,
                      0
                    )
                  ),
                  0
                )::numeric AS total

              FROM public.pos_orders

              WHERE
                restaurant_id = $1

                AND table_number =
                    $2

                AND COALESCE(
                  remaining_price,
                  total_price,
                  0
                ) > 0

                AND LOWER(
                  COALESCE(
                    order_status,
                    'open'
                  )
                ) NOT IN (
                  'closed_unpaid',
                  'voided',
                  'cancelled'
                )
            `
            : `
              SELECT
                COALESCE(
                  SUM(
                    COALESCE(
                      remaining_price,
                      total_price,
                      0
                    )
                  ),
                  0
                ) AS total

              FROM pos_orders

              WHERE
                restaurant_id = ?

                AND table_number =
                    ?

                AND COALESCE(
                  remaining_price,
                  total_price,
                  0
                ) > 0
            `,
          [
            rid,
            tableName,
          ]
        );

      return res.json({
        total:
          Number(
            row?.total ||
            0
          ),
      });
    } catch (err) {
      console.error(
        "❌ GET /tables/:tableId/total failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch table total",
      });
    }
  }
);

// =========================================================
// PUT /tables/:id/status
//
// Operational status change.
//
// SECURITY:
// - authenticated identity
// - active restaurant membership
// - TABLES_STATUS permission
// - id + restaurant_id scope
// - returns 404 if row is not owned by tenant
// =========================================================

router.put(
  "/:id/status",

  authenticateToken,

  loadMembership,

  requirePermission(
    PERMISSIONS.TABLES_STATUS
  ),

  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      const id =
        Number(
          req.params.id
        );

      const status =
        String(
          req.body?.status ||
          ""
        )
          .trim()
          .toLowerCase();

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing tenant",
        });
      }

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid table id",
        });
      }

      const allowed = [
        "free",
        "reserved",
        "occupied",
        "occupied_paid",
      ];

      if (
        !allowed.includes(
          status
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid table status",
        });
      }

      const isPg =
        kind === "pg";

      const result =
        await qRun(
          isPg
            ? `
              UPDATE public.tables

              SET
                status = $1

              WHERE
                id = $2
                AND restaurant_id = $3
            `
            : `
              UPDATE tables

              SET
                status = ?

              WHERE
                id = ?
                AND restaurant_id = ?
            `,
          [
            status,
            id,
            rid,
          ]
        );

      const changes =
        changedRows(
          result
        );

      if (!changes) {
        return res.status(404).json({
          error:
            "Table not found",
        });
      }

      /*
       * Keep table_map aligned if a corresponding map row
       * exists. Failure here must not falsely undo the
       * successful canonical tables update.
       */
      await qRun(
        isPg
          ? `
            UPDATE public.table_map

            SET
              status = $1

            WHERE
              id = $2
              AND restaurant_id = $3
          `
          : `
            UPDATE table_map

            SET
              status = ?

            WHERE
              id = ?
              AND restaurant_id = ?
          `,
        [
          status,
          id,
          rid,
        ]
      ).catch(
        (err) => {
          console.error(
            "⚠️ table_map status sync failed:",
            err?.message ||
            err
          );
        }
      );

      return res.json({
        success: true,
        status,
      });
    } catch (err) {
      console.error(
        "❌ PUT /tables/:id/status failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to update table status",
      });
    }
  }
);

// =========================================================
// POST /tables/:tableName/close
//
// Marks a table free ONLY when no unpaid balance remains.
//
// SECURITY:
// - authenticated identity
// - active restaurant membership
// - TABLES_STATUS permission
// - all reads/writes tenant-scoped
// - verifies target table exists in this tenant
// =========================================================

router.post(
  "/:tableName/close",

  authenticateToken,

  loadMembership,

  requirePermission(
    PERMISSIONS.TABLES_STATUS
  ),

  async (req, res) => {
    try {
      const rid =
        ridOf(req);

      const tableName =
        canonicalTableName(
          req.params.tableName
        );

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing tenant",
        });
      }

      if (!tableName) {
        return res.status(400).json({
          error:
            "Invalid table name",
        });
      }

      /*
       * Resolve the table inside THIS restaurant first.
       *
       * This prevents:
       *
       * Restaurant A
       *   -> /tables/TEST-B-1/close
       *
       * from receiving a misleading success response.
       */
      const table =
        await req.qGet(
          `
          SELECT
            id,
            name,
            status

          FROM public.tables

          WHERE
            restaurant_id = $1

            AND LOWER(
              TRIM(name)
            ) = LOWER(
              TRIM($2)
            )

          LIMIT 1
          `,
          [
            rid,
            tableName,
          ]
        );

      if (!table) {
        return res.status(404).json({
          error:
            "Table not found",
        });
      }

      const canonicalName =
        canonicalTableName(
          table.name
        );

      const unpaid =
        await req.qGet(
          `
          SELECT
            COUNT(*)::int AS cnt

          FROM public.pos_orders

          WHERE
            restaurant_id = $1

            AND table_number =
                $2

            AND COALESCE(
              paid,
              0
            ) = 0

            AND COALESCE(
              remaining_price,
              0
            ) > 0

            AND LOWER(
              COALESCE(
                order_status,
                'open'
              )
            ) NOT IN (
              'closed_unpaid',
              'voided',
              'cancelled'
            )
          `,
          [
            rid,
            canonicalName,
          ]
        );

      if (
        Number(
          unpaid?.cnt ||
          0
        ) > 0
      ) {
        return res.status(400).json({
          error:
            "Cannot close table with unpaid orders",
        });
      }

      const result =
        await req.qRun(
          `
          UPDATE public.tables

          SET
            status = 'free'

          WHERE
            restaurant_id = $1

            AND id = $2
          `,
          [
            rid,
            table.id,
          ]
        );

      const changes =
        changedRows(
          result
        );

      if (!changes) {
        return res.status(404).json({
          error:
            "Table not found",
        });
      }

      await req.qRun(
        `
        UPDATE public.table_map

        SET
          status = 'free'

        WHERE
          restaurant_id = $1

          AND LOWER(
            TRIM(name)
          ) = LOWER(
            TRIM($2)
          )
        `,
        [
          rid,
          canonicalName,
        ]
      ).catch(
        (err) => {
          console.error(
            "⚠️ table_map close sync failed:",
            err?.message ||
            err
          );
        }
      );

      return res.json({
        success: true,
        status:
          "free",
      });
    } catch (err) {
      console.error(
        "❌ POST /tables/:tableName/close failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to close table",
      });
    }
  }
);

module.exports = router;