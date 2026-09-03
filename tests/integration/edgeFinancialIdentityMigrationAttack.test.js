"use strict";

require("dotenv").config();

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const {
  Pool,
} = require("pg");

const {
  runCanonicalEdgeFinancialIdentityPg,
} = require(
  "../../migrations/canonicalEdgeFinancialIdentity.pg"
);


const DATABASE_URL =
  String(
    process.env.MAKS_ATTACK_DATABASE_URL ||
    ""
  ).trim();


function uuidLike(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  );
}


test(
  "ATTACK: Edge financial identity migration backfills portable payment/refund UUID identity safely",
  async () => {
    assert.ok(
      DATABASE_URL,
      "MAKS_ATTACK_DATABASE_URL is required"
    );

    const pool =
      new Pool({
        connectionString:
          DATABASE_URL,
      });

    const token =
      crypto
        .randomBytes(8)
        .toString("hex");

    let restaurantA =
      null;

    let restaurantB =
      null;

    try {
      // =====================================================
      // 01 — HARD DATABASE GUARD
      // =====================================================

      const database =
        await pool.query(`
          SELECT
            current_database()
              AS db
        `);

      assert.equal(
        database.rows?.[0]?.db,
        "maks_test",
        "REFUSED: Edge financial identity Attack may run only against maks_test"
      );

      console.log(
        "✅ 01 Database guard: maks_test"
      );


      // =====================================================
      // 02 — CREATE ISOLATED TEST TENANTS
      // =====================================================

      const ra =
        await pool.query(
          `
            INSERT INTO
              public.restaurants (
                name
              )
            VALUES (
              $1
            )
            RETURNING id
          `,
          [
            `EDGE FINANCIAL IDENTITY A ${token}`,
          ]
        );

      restaurantA =
        Number(
          ra.rows[0].id
        );

      const rb =
        await pool.query(
          `
            INSERT INTO
              public.restaurants (
                name
              )
            VALUES (
              $1
            )
            RETURNING id
          `,
          [
            `EDGE FINANCIAL IDENTITY B ${token}`,
          ]
        );

      restaurantB =
        Number(
          rb.rows[0].id
        );

      assert.ok(
        restaurantA > 0
      );

      assert.ok(
        restaurantB > 0
      );

      assert.notEqual(
        restaurantA,
        restaurantB
      );

      console.log(
        "✅ 02 Isolated tenants created"
      );


      // =====================================================
      // 03 — RECREATE PRE-MIGRATION STATE FOR TEST ROWS
      // =====================================================
      //
      // The migration was already run manually against
      // maks_test. To prove historical backfill, temporarily
      // allow these new test rows to have payment_uuid NULL.
      //
      // Existing rows are not modified.
      // The migration itself restores NOT NULL.
      // =====================================================

      await pool.query(`
        ALTER TABLE public.payments
        ALTER COLUMN payment_uuid
        DROP NOT NULL
      `);

      console.log(
        "✅ 03 Legacy nullable payment_uuid state recreated"
      );


      // =====================================================
      // 04 — ACTIVE LEGACY REF: ref_payment_id
      // =====================================================

      const originalA =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status,
              payment_uuid
            )
            VALUES (
              $1,
              $2,
              10.00,
              'cash',
              'pos',
              'completed',
              NULL
            )
            RETURNING id
          `,
          [
            restaurantA,
            `EDGE-FIN-A-${token}`,
          ]
        );

      const originalAId =
        Number(
          originalA.rows[0].id
        );

      const refundA =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status,
              ref_payment_id,
              payment_uuid
            )
            VALUES (
              $1,
              $2,
              -3.00,
              'cash',
              'refund',
              'completed',
              $3,
              NULL
            )
            RETURNING id
          `,
          [
            restaurantA,
            `EDGE-FIN-A-${token}`,
            originalAId,
          ]
        );

      const refundAId =
        Number(
          refundA.rows[0].id
        );


      // =====================================================
      // 05 — OLDER LEGACY REF: refund_of_payment_id
      // =====================================================

      const originalC =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status,
              payment_uuid
            )
            VALUES (
              $1,
              $2,
              20.00,
              'card',
              'pos',
              'completed',
              NULL
            )
            RETURNING id
          `,
          [
            restaurantA,
            `EDGE-FIN-C-${token}`,
          ]
        );

      const originalCId =
        Number(
          originalC.rows[0].id
        );

      const refundC =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status,
              refund_of_payment_id,
              payment_uuid
            )
            VALUES (
              $1,
              $2,
              -5.00,
              'card',
              'refund',
              'completed',
              $3,
              NULL
            )
            RETURNING id
          `,
          [
            restaurantA,
            `EDGE-FIN-C-${token}`,
            originalCId,
          ]
        );

      const refundCId =
        Number(
          refundC.rows[0].id
        );

      console.log(
        "✅ 04 Legacy payment/refund fixtures created"
      );


      // =====================================================
      // 06 — MIGRATE HISTORICAL ROWS
      // =====================================================

      await runCanonicalEdgeFinancialIdentityPg({
        pool,
      });

      const migrated =
        await pool.query(
          `
            SELECT
              id,
              payment_uuid::text
                AS payment_uuid,
              ref_payment_uuid::text
                AS ref_payment_uuid,
              ref_payment_id,
              refund_of_payment_id

            FROM public.payments

            WHERE restaurant_id = $1
              AND id = ANY($2::bigint[])

            ORDER BY id ASC
          `,
          [
            restaurantA,
            [
              originalAId,
              refundAId,
              originalCId,
              refundCId,
            ],
          ]
        );

      assert.equal(
        migrated.rows.length,
        4
      );

      const byId =
        new Map(
          migrated.rows.map(
            (row) => [
              Number(row.id),
              row,
            ]
          )
        );

      const migratedOriginalA =
        byId.get(originalAId);

      const migratedRefundA =
        byId.get(refundAId);

      const migratedOriginalC =
        byId.get(originalCId);

      const migratedRefundC =
        byId.get(refundCId);

      assert.ok(
        uuidLike(
          migratedOriginalA
            .payment_uuid
        )
      );

      assert.ok(
        uuidLike(
          migratedRefundA
            .payment_uuid
        )
      );

      assert.ok(
        uuidLike(
          migratedOriginalC
            .payment_uuid
        )
      );

      assert.ok(
        uuidLike(
          migratedRefundC
            .payment_uuid
        )
      );

      assert.equal(
        migratedRefundA
          .ref_payment_uuid,
        migratedOriginalA
          .payment_uuid,
        "ref_payment_id refund did not map to original payment_uuid"
      );

      assert.equal(
        migratedRefundC
          .ref_payment_uuid,
        migratedOriginalC
          .payment_uuid,
        "refund_of_payment_id refund did not map to original payment_uuid"
      );

      assert.equal(
        Number(
          migratedRefundA
            .ref_payment_id
        ),
        originalAId,
        "Migration changed legacy ref_payment_id"
      );

      assert.equal(
        Number(
          migratedRefundC
            .refund_of_payment_id
        ),
        originalCId,
        "Migration changed legacy refund_of_payment_id"
      );

      console.log(
        "✅ 05 Historical UUID backfill proven"
      );

      console.log(
        "✅ 06 Both legacy refund link styles map correctly"
      );


      // =====================================================
      // 07 — IDEMPOTENCY MUST PRESERVE IDENTITIES
      // =====================================================

      const identityBeforeSecondRun =
        migrated.rows.map(
          (row) => ({
            id:
              Number(row.id),

            payment_uuid:
              row.payment_uuid,

            ref_payment_uuid:
              row.ref_payment_uuid,
          })
        );

      await runCanonicalEdgeFinancialIdentityPg({
        pool,
      });

      const secondRun =
        await pool.query(
          `
            SELECT
              id,
              payment_uuid::text
                AS payment_uuid,
              ref_payment_uuid::text
                AS ref_payment_uuid

            FROM public.payments

            WHERE restaurant_id = $1
              AND id = ANY($2::bigint[])

            ORDER BY id ASC
          `,
          [
            restaurantA,
            [
              originalAId,
              refundAId,
              originalCId,
              refundCId,
            ],
          ]
        );

      const identityAfterSecondRun =
        secondRun.rows.map(
          (row) => ({
            id:
              Number(row.id),

            payment_uuid:
              row.payment_uuid,

            ref_payment_uuid:
              row.ref_payment_uuid,
          })
        );

      assert.deepEqual(
        identityAfterSecondRun,
        identityBeforeSecondRun,
        "Second migration run changed stable financial identities"
      );

      console.log(
        "✅ 07 Migration rerun preserves all UUID identities"
      );


      // =====================================================
      // 08 — CONFLICTING LEGACY POINTERS MUST FAIL CLOSED
      // =====================================================

      const conflictOriginal1 =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status
            )
            VALUES (
              $1,
              $2,
              30.00,
              'cash',
              'pos',
              'completed'
            )
            RETURNING id
          `,
          [
            restaurantA,
            `EDGE-CONFLICT-1-${token}`,
          ]
        );

      const conflictOriginal2 =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status
            )
            VALUES (
              $1,
              $2,
              40.00,
              'card',
              'pos',
              'completed'
            )
            RETURNING id
          `,
          [
            restaurantA,
            `EDGE-CONFLICT-2-${token}`,
          ]
        );

      const conflictOriginal1Id =
        Number(
          conflictOriginal1
            .rows[0].id
        );

      const conflictOriginal2Id =
        Number(
          conflictOriginal2
            .rows[0].id
        );

      const conflictRefund =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status,
              ref_payment_id,
              refund_of_payment_id
            )
            VALUES (
              $1,
              $2,
              -1.00,
              'cash',
              'refund',
              'completed',
              $3,
              $4
            )
            RETURNING id
          `,
          [
            restaurantA,
            `EDGE-CONFLICT-R-${token}`,
            conflictOriginal1Id,
            conflictOriginal2Id,
          ]
        );

      const conflictRefundId =
        Number(
          conflictRefund.rows[0].id
        );

      await assert.rejects(
        () =>
          runCanonicalEdgeFinancialIdentityPg({
            pool,
          }),

        /conflicting legacy refund payment references detected/
      );

      const conflictStillThere =
        await pool.query(
          `
            SELECT
              ref_payment_id,
              refund_of_payment_id

            FROM public.payments

            WHERE restaurant_id = $1
              AND id = $2
          `,
          [
            restaurantA,
            conflictRefundId,
          ]
        );

      assert.equal(
        conflictStillThere.rows.length,
        1
      );

      assert.equal(
        Number(
          conflictStillThere
            .rows[0]
            .ref_payment_id
        ),
        conflictOriginal1Id
      );

      assert.equal(
        Number(
          conflictStillThere
            .rows[0]
            .refund_of_payment_id
        ),
        conflictOriginal2Id
      );

      await pool.query(
        `
          DELETE FROM public.payments
          WHERE restaurant_id = $1
            AND id = ANY($2::bigint[])
        `,
        [
          restaurantA,
          [
            conflictRefundId,
            conflictOriginal1Id,
            conflictOriginal2Id,
          ],
        ]
      );

      console.log(
        "✅ 08 Conflicting legacy references fail closed"
      );


      // =====================================================
      // 09 — CROSS-TENANT LEGACY REF MUST FAIL CLOSED
      // =====================================================

      const foreignOriginal =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status
            )
            VALUES (
              $1,
              $2,
              50.00,
              'cash',
              'pos',
              'completed'
            )
            RETURNING id
          `,
          [
            restaurantB,
            `EDGE-FOREIGN-${token}`,
          ]
        );

      const foreignOriginalId =
        Number(
          foreignOriginal
            .rows[0].id
        );

      const crossTenantRefund =
        await pool.query(
          `
            INSERT INTO public.payments (
              restaurant_id,
              table_number,
              amount,
              method,
              source,
              status,
              ref_payment_id
            )
            VALUES (
              $1,
              $2,
              -2.00,
              'cash',
              'refund',
              'completed',
              $3
            )
            RETURNING id
          `,
          [
            restaurantA,
            `EDGE-CROSS-TENANT-${token}`,
            foreignOriginalId,
          ]
        );

      const crossTenantRefundId =
        Number(
          crossTenantRefund
            .rows[0].id
        );

      await assert.rejects(
        () =>
          runCanonicalEdgeFinancialIdentityPg({
            pool,
          }),

        /invalid or cross-tenant legacy refund reference detected/
      );

      await pool.query(
        `
          DELETE FROM public.payments
          WHERE restaurant_id = $1
            AND id = $2
        `,
        [
          restaurantA,
          crossTenantRefundId,
        ]
      );

      await pool.query(
        `
          DELETE FROM public.payments
          WHERE restaurant_id = $1
            AND id = $2
        `,
        [
          restaurantB,
          foreignOriginalId,
        ]
      );

      console.log(
        "✅ 09 Cross-tenant legacy reference fails closed"
      );


      // =====================================================
      // 10 — RESTORE/VERIFY FINAL CANONICAL STATE
      // =====================================================

      await runCanonicalEdgeFinancialIdentityPg({
        pool,
      });

      const column =
        await pool.query(`
          SELECT
            udt_name,
            is_nullable,
            column_default

          FROM information_schema.columns

          WHERE table_schema = 'public'
            AND table_name = 'payments'
            AND column_name = 'payment_uuid'
        `);

      assert.equal(
        column.rows?.[0]
          ?.udt_name,
        "uuid"
      );

      assert.equal(
        column.rows?.[0]
          ?.is_nullable,
        "NO"
      );

      assert.match(
        String(
          column.rows?.[0]
            ?.column_default ||
          ""
        ),
        /gen_random_uuid/
      );

      console.log(
        "✅ 10 Final canonical schema restored"
      );
    } finally {
      /*
       * Clean only the isolated tenants created by this test.
       *
       * Delete payment children first, then restaurants.
       */
      if (
        restaurantA ||
        restaurantB
      ) {
        try {
          const ids = [
            restaurantA,
            restaurantB,
          ].filter(
            (id) =>
              Number.isInteger(id) &&
              id > 0
          );

          if (ids.length) {
            await pool.query(
              `
                DELETE FROM public.payments
                WHERE restaurant_id =
                      ANY($1::bigint[])
              `,
              [
                ids,
              ]
            );

            await pool.query(
              `
                DELETE FROM public.restaurants
                WHERE id =
                      ANY($1::bigint[])
              `,
              [
                ids,
              ]
            );
          }
        } catch (cleanupError) {
          console.error(
            "⚠️ Financial identity test cleanup failed:",
            cleanupError.message
          );
        }
      }

      /*
       * If a test assertion failed after DROP NOT NULL,
       * attempt to restore the canonical migration before exit.
       */
      try {
        await runCanonicalEdgeFinancialIdentityPg({
          pool,
        });
      } catch (restoreError) {
        console.error(
          "❌ CRITICAL: failed to restore canonical financial identity schema:",
          restoreError.message
        );
      }

      await pool.end();
    }
  }
);
