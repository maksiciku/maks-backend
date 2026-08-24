// backend/routes/posTableSessionRoutes.js
"use strict";

const express =
  require("express");

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
      tableId
    ) {
      return qGet(
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

        try {
          /*
           * =================================================
           * TENANT OWNERSHIP CHECK
           * =================================================
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

          /*
           * =================================================
           * COVERS VALIDATION
           * =================================================
           *
           * Covers must be a real positive integer.
           *
           * Do not silently convert Infinity, NaN, decimals,
           * negatives or ridiculous values.
           *
           * We deliberately do NOT force covers <= seats here:
           * restaurants may temporarily pull chairs together.
           * Capacity enforcement belongs to booking/table
           * allocation policy rather than corrupting session
           * metadata.
           */
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

          /*
           * =================================================
           * ALLERGEN AUTHORITY
           * =================================================
           */
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

          /*
           * =================================================
           * TENANT-SAFE UPSERT
           * =================================================
           */
          await qRun(
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

          return res.json({
            ok: true,

            table_id:
              tableId,

            table_name:
              table.name,

            covers,

            allergy_codes:
              allergyCodes,

            strict_cross_contamination:
              strictCrossContamination,
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