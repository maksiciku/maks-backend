// backend/routes/posTableSessionRoutes.js
"use strict";

const express =
  require("express");

const {
  withTx:
    fallbackWithTx,
} = require(
  "../dbCompat"
);

const {
  emitTableOperationalSnapshotTx,
  isTableEdgeProducerRuntime,
} = require(
  "../edge/contracts/tableOperations"
);

const ALLOWED_ALLERGEN_CODES =
  new Set([
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
  ]);

module.exports =
  function buildPosTableSessionRoutes({
    db,
    authenticateToken,
    tenantGuard,
  }) {
    const router =
      express.Router();

    const qGet =
      db.qGet;

    const qRun =
      db.qRun;

    const withTx =
      typeof db?.withTx ===
        "function"
        ? db.withTx
        : fallbackWithTx;

    /*
     * =====================================================
     * AUTHORITATIVE TABLE OWNERSHIP
     * =====================================================
     *
     * A table ID is never enough.
     *
     * The table must exist AND belong to the authenticated
     * restaurant before any table-session state can be read
     * or written.
     */
    async function loadOwnedTable(
      rid,
      tableId,
      qGetFn = qGet
    ) {
      return qGetFn(
        `
        SELECT
          id,
          restaurant_id,
          name,
          seats
        FROM public.tables
        WHERE restaurant_id = $1
          AND id = $2
        LIMIT 1
        `,
        [
          rid,
          tableId,
        ]
      );
    }

    async function emitTableOperationalIfEdge(
      tx,
      restaurantId,
      tableName
    ) {
      if (
        !isTableEdgeProducerRuntime()
      ) {
        return null;
      }

      return emitTableOperationalSnapshotTx(
        tx,
        {
          restaurantId,
          tableName,
        }
      );
    }


    function sanitizeAllergens(
      raw
    ) {
      if (!Array.isArray(raw)) {
        return [];
      }

      return Array.from(
        new Set(
          raw
            .map(
              (value) =>
                String(
                  value || ""
                )
                  .trim()
                  .toLowerCase()
            )
            .filter(
              (value) =>
                ALLOWED_ALLERGEN_CODES.has(
                  value
                )
            )
        )
      );
    }

    /*
     * =====================================================
     * GET SESSION
     * =====================================================
     */

    router.get(
      "/table-session/:tableId",
      authenticateToken,
      tenantGuard,

      async (req, res) => {
        const rid =
          Number(
            req.tenantRid ||
              req.user?.restaurant_id ||
              0
          );

        const tableId =
          Number(
            req.params.tableId ||
              0
          );

        if (!rid) {
          return res
            .status(401)
            .json({
              error:
                "No restaurant",
            });
        }

        if (
          !Number.isInteger(
            tableId
          ) ||
          tableId <= 0
        ) {
          return res
            .status(400)
            .json({
              error:
                "Bad table id",
            });
        }

        try {
          /*
           * Never reveal whether another tenant owns
           * the supplied table ID.
           */
          const table =
            await loadOwnedTable(
              rid,
              tableId
            );

          if (!table) {
            return res
              .status(404)
              .json({
                error:
                  "Table not found",
              });
          }

          const row =
            await qGet(
              `
              SELECT
                table_id,
                covers,
                allergy_codes,
                strict_cross_contamination
              FROM public.pos_table_sessions
              WHERE restaurant_id = $1
                AND table_id = $2
              LIMIT 1
              `,
              [
                rid,
                tableId,
              ]
            );

          if (!row) {
            return res.json(
              null
            );
          }

          let allergyCodes =
            row.allergy_codes;

          if (
            typeof allergyCodes ===
            "string"
          ) {
            try {
              allergyCodes =
                JSON.parse(
                  allergyCodes
                );
            } catch {
              allergyCodes = [];
            }
          }

          return res.json({
            table_id:
              Number(
                row.table_id
              ),

            covers:
              Number(
                row.covers ||
                  1
              ),

            allergy_codes:
              Array.isArray(
                allergyCodes
              )
                ? allergyCodes
                : [],

            strict_cross_contamination:
              !!row.strict_cross_contamination,
          });
        } catch (e) {
          console.error(
            "GET table-session failed",
            e
          );

          return res
            .status(500)
            .json({
              error:
                "Failed",
            });
        }
      }
    );

    /*
     * =====================================================
     * SAVE / UPDATE SESSION
     * =====================================================
     */

    router.post(
      "/table-session/:tableId",
      authenticateToken,
      tenantGuard,

      async (req, res) => {
        const rid =
          Number(
            req.tenantRid ||
              req.user?.restaurant_id ||
              0
          );

        const tableId =
          Number(
            req.params.tableId ||
              0
          );

        if (!rid) {
          return res
            .status(401)
            .json({
              error:
                "No restaurant",
            });
        }

        if (
          !Number.isInteger(
            tableId
          ) ||
          tableId <= 0
        ) {
          return res
            .status(400)
            .json({
              error:
                "Bad table id",
            });
        }

        const rawCovers =
          req.body?.covers ??
          2;

        const covers =
          Number(
            rawCovers
          );

        if (
          !Number.isInteger(
            covers
          ) ||
          covers < 1 ||
          covers > 1000
        ) {
          return res
            .status(400)
            .json({
              error:
                "Invalid covers",
            });
        }

        const allergyCodes =
          sanitizeAllergens(
            req.body
              ?.allergy_codes
          );

        const rawStrict =
          req.body
            ?.strict_cross_contamination;

        const strictCrossContamination =
          rawStrict === true ||
          rawStrict ===
            "true" ||
          rawStrict === 1 ||
          rawStrict === "1";

        const allergyJson =
          JSON.stringify(
            allergyCodes
          );

        try {
          const operation =
            await withTx(
              async (tx) => {
                const table =
                  await loadOwnedTable(
                    rid,
                    tableId,
                    (
                      sql,
                      params
                    ) =>
                      tx.qGet(
                        sql,
                        params
                      )
                  );

                if (!table) {
                  return {
                    found:
                      false,

                    table:
                      null,

                    sync:
                      null,
                  };
                }

                await tx.qRun(
                  `
                  INSERT INTO public.pos_table_sessions
                  (
                    restaurant_id,
                    table_id,
                    covers,
                    allergy_codes,
                    strict_cross_contamination
                  )

                  VALUES (
                    $1,
                    $2,
                    $3,
                    $4::jsonb,
                    $5
                  )

                  ON CONFLICT
                    (
                      restaurant_id,
                      table_id
                    )

                  DO UPDATE SET
                    covers =
                      EXCLUDED.covers,

                    allergy_codes =
                      EXCLUDED.allergy_codes,

                    strict_cross_contamination =
                      EXCLUDED.strict_cross_contamination,

                    updated_at =
                      NOW()
                  `,
                  [
                    rid,
                    tableId,
                    covers,
                    allergyJson,
                    strictCrossContamination,
                  ]
                );

                const sync =
                  await emitTableOperationalIfEdge(
                    tx,
                    rid,
                    table.name
                  );

                return {
                  found:
                    true,

                  table,

                  sync,
                };
              }
            );

          if (
            !operation.found
          ) {
            return res
              .status(404)
              .json({
                error:
                  "Table not found",
              });
          }

          return res.json({
            ok: true,

            table_id:
              tableId,

            table_name:
              operation
                .table
                .name,

            covers,

            allergy_codes:
              allergyCodes,

            strict_cross_contamination:
              strictCrossContamination,

            edge_revision:
              operation
                .sync
                ?.revision ??
              null,
          });
        } catch (e) {
          console.error(
            "POST table-session failed",
            e
          );

          return res
            .status(500)
            .json({
              error:
                "Failed",
            });
        }
      }
    );

    return router;
  };