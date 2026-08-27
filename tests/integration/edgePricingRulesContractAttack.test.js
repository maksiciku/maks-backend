"use strict";

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
  withTx,
} = require(
  "../../dbCompat"
);

const {
  runCanonicalCommercialPricingPg,
} = require(
  "../../migrations/canonicalCommercialPricing.pg"
);

const {
  runCanonicalEdgeSyncFoundationPg,
} = require(
  "../../migrations/canonicalEdgeSyncFoundation.pg"
);

const {
  runCanonicalEdgeDomainRevisionsPg,
} = require(
  "../../migrations/canonicalEdgeDomainRevisions.pg"
);

const {
  EdgeDomainRevisionError,
  readDomainRevisionTx,
} = require(
  "../../edge/domainRevisionStore"
);

const {
  receiveInboxEvent,
} = require(
  "../../edge/syncStore"
);

const {
  applyInboxOnce,
} = require(
  "../../edge/applyEngine"
);

const {
  PRICING_RULES_DOMAIN,
  PRICING_RULES_EVENT_TYPE,
  PricingRulesContractError,
  validatePricingRulesPayload,
  emitPricingRulesSnapshotTx,
  applyPricingRulesReplaced,
} = require(
  "../../edge/contracts/pricingRules"
);


const DATABASE_URL =
  String(
    process.env.DATABASE_URL ||
    ""
  ).trim();


function uuid() {
  return crypto.randomUUID();
}


async function insertRule(
  tx,
  restaurantId,
  name,
  priority = 0
) {
  return tx.qGet(
    `
    INSERT INTO
      public.pricing_rules
    (
      restaurant_id,
      name,
      rule_type,
      active,
      priority,
      conditions,
      actions,
      starts_at,
      ends_at,
      created_at,
      updated_at
    )
    VALUES
    (
      $1,
      $2,
      'fixed_bundle',
      TRUE,
      $3,
      $4::jsonb,
      $5::jsonb,
      NULL,
      NULL,
      NOW(),
      NOW()
    )
    RETURNING *
    `,
    [
      restaurantId,
      name,
      priority,
      JSON.stringify({
        components: [
          {
            item_type:
              "meal",
            quantity: 1,
          },
        ],
      }),
      JSON.stringify({
        bundle_price: 10,
      }),
    ]
  );
}


async function pricingRows(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        id,
        restaurant_id,
        name,
        rule_type,
        active,
        priority,
        conditions,
        actions,
        starts_at,
        ends_at,
        created_at,
        updated_at
      FROM
        public.pricing_rules
      WHERE
        restaurant_id = $1
      ORDER BY
        priority DESC,
        id DESC
      `,
      [
        restaurantId,
      ]
    );

  return result.rows;
}


async function producedState(
  restaurantId
) {
  return withTx(
    (tx) =>
      readDomainRevisionTx(
        tx,
        {
          restaurantId,
          domain:
            PRICING_RULES_DOMAIN,
        }
      )
  );
}


test(
  "MAKS Cloud to Edge pricing rules contract attack",
  {
    timeout:
      60000,
  },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      "DATABASE_URL is required"
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

    const originalRole =
      process.env
        .MAKS_RUNTIME_ROLE;

    let restaurantA =
      null;

    let restaurantB =
      null;

    try {
      const database =
        await pool.query(
          "SELECT current_database() AS db"
        );

      assert.equal(
        database.rows?.[0]?.db,
        "maks_test",
        "REFUSED: pricing contract Attack may run only against maks_test"
      );

      console.log(
        "✅ 01 Database guard: maks_test"
      );

      await runCanonicalCommercialPricingPg({
        pool,
      });

      await runCanonicalEdgeSyncFoundationPg({
        pool,
      });

      await runCanonicalEdgeDomainRevisionsPg({
        pool,
      });

      console.log(
        "✅ 02 Required canonical schemas verified"
      );

      const ra =
        await pool.query(
          `
          INSERT INTO
            public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `PRICING CONTRACT ATTACK A ${token}`,
          ]
        );

      const rb =
        await pool.query(
          `
          INSERT INTO
            public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `PRICING CONTRACT ATTACK B ${token}`,
          ]
        );

      restaurantA =
        Number(
          ra.rows[0].id
        );

      restaurantB =
        Number(
          rb.rows[0].id
        );

      await withTx(
        async (tx) => {
          await insertRule(
            tx,
            restaurantA,
            `A BASE ${token}`,
            10
          );

          await insertRule(
            tx,
            restaurantB,
            `B KEEP ${token}`,
            20
          );
        }
      );

      console.log(
        "✅ 03 Isolated pricing tenants created"
      );

      await t.test(
        "Cloud producer emits a strict full snapshot with revision 1",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          const produced =
            await withTx(
              (tx) =>
                emitPricingRulesSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                )
            );

          assert.equal(
            produced.revision,
            1
          );

          assert.equal(
            produced.event
              .event_type,
            PRICING_RULES_EVENT_TYPE
          );

          assert.equal(
            produced.payload
              .schema_version,
            1
          );

          assert.equal(
            produced.payload
              .revision,
            1
          );

          assert.equal(
            produced.payload
              .rules.length,
            1
          );

          assert.equal(
            Object.prototype
              .hasOwnProperty.call(
                produced.payload,
                "restaurant_id"
              ),
            false,
            "Tenant identity leaked into pricing payload"
          );

          console.log(
            "✅ 04 Cloud pricing snapshot production proven"
          );
        }
      );

      await t.test(
        "business mutation revision and outbox roll back together",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          const beforeState =
            await producedState(
              restaurantA
            );

          const beforeOutbox =
            Number(
              (
                await pool.query(
                  `
                  SELECT COUNT(*)::int AS count
                  FROM public.edge_outbox
                  WHERE restaurant_id = $1
                    AND event_type = $2
                  `,
                  [
                    restaurantA,
                    PRICING_RULES_EVENT_TYPE,
                  ]
                )
              ).rows[0].count
            );

          await assert.rejects(
            () =>
              withTx(
                async (tx) => {
                  await insertRule(
                    tx,
                    restaurantA,
                    `ROLLBACK ${token}`,
                    99
                  );

                  await emitPricingRulesSnapshotTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                    }
                  );

                  throw new Error(
                    "SIMULATED_PRICING_CRASH"
                  );
                }
              ),
            /SIMULATED_PRICING_CRASH/
          );

          const afterRows =
            await pricingRows(
              pool,
              restaurantA
            );

          assert.equal(
            afterRows.some(
              (row) =>
                row.name ===
                  `ROLLBACK ${token}`
            ),
            false
          );

          const afterState =
            await producedState(
              restaurantA
            );

          assert.equal(
            Number(
              afterState
                .produced_revision
            ),
            Number(
              beforeState
                .produced_revision
            )
          );

          const afterOutbox =
            Number(
              (
                await pool.query(
                  `
                  SELECT COUNT(*)::int AS count
                  FROM public.edge_outbox
                  WHERE restaurant_id = $1
                    AND event_type = $2
                  `,
                  [
                    restaurantA,
                    PRICING_RULES_EVENT_TYPE,
                  ]
                )
              ).rows[0].count
            );

          assert.equal(
            afterOutbox,
            beforeOutbox
          );

          console.log(
            "✅ 05 Atomic pricing mutation + revision + outbox rollback proven"
          );
        }
      );

      await t.test(
        "Edge and missing runtime roles cannot produce Cloud snapshots",
        async () => {
          const before =
            await producedState(
              restaurantA
            );

          process.env.MAKS_RUNTIME_ROLE =
            "edge";

          await assert.rejects(
            () =>
              withTx(
                (tx) =>
                  emitPricingRulesSnapshotTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                    }
                  )
              ),
            (error) =>
              error?.code ===
                "MAKS_RUNTIME_ROLE_NOT_CLOUD"
          );

          delete process.env
            .MAKS_RUNTIME_ROLE;

          await assert.rejects(
            () =>
              withTx(
                (tx) =>
                  emitPricingRulesSnapshotTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                    }
                  )
              ),
            (error) =>
              error?.code ===
                "MAKS_RUNTIME_ROLE_MISSING"
          );

          const after =
            await producedState(
              restaurantA
            );

          assert.equal(
            Number(
              after.produced_revision
            ),
            Number(
              before.produced_revision
            )
          );

          console.log(
            "✅ 06 Cloud-only pricing producer authority proven"
          );
        }
      );

      let revision2 =
        null;

      await t.test(
        "newer snapshot replaces only the authoritative tenant",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          revision2 =
            await withTx(
              async (tx) => {
                await insertRule(
                  tx,
                  restaurantA,
                  `A SECOND ${token}`,
                  5
                );

                return emitPricingRulesSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                );
              }
            );

          assert.equal(
            revision2.revision,
            2
          );

          const bBefore =
            await pricingRows(
              pool,
              restaurantB
            );

          await pool.query(
            `
            DELETE FROM public.pricing_rules
            WHERE restaurant_id = $1
            `,
            [
              restaurantA,
            ]
          );

          await withTx(
            (tx) =>
              insertRule(
                tx,
                restaurantA,
                `EDGE STALE ${token}`,
                999
              )
          );

          const applied =
            await withTx(
              (tx) =>
                applyPricingRulesReplaced({
                  tx,
                  restaurantId:
                    restaurantA,
                  event:
                    revision2.event,
                  payload:
                    revision2.payload,
                })
            );

          assert.equal(
            applied.state,
            "applied"
          );

          assert.equal(
            applied.appliedRevision,
            2
          );

          const aAfter =
            await pricingRows(
              pool,
              restaurantA
            );

          assert.deepEqual(
            aAfter.map(
              (row) =>
                String(row.name)
            ),
            revision2.payload
              .rules.map(
                (rule) =>
                  rule.name
              )
          );

          const bAfter =
            await pricingRows(
              pool,
              restaurantB
            );

          assert.deepEqual(
            bAfter.map(
              (row) =>
                row.name
            ),
            bBefore.map(
              (row) =>
                row.name
            )
          );

          console.log(
            "✅ 07 Tenant-safe pricing snapshot replacement proven"
          );
        }
      );

      await t.test(
        "stale duplicate and conflicting pricing revisions fail safely",
        async () => {
          const executionsBefore =
            await pricingRows(
              pool,
              restaurantA
            );

          const stalePayload =
            {
              ...revision2.payload,
              revision: 1,
            };

          const stale =
            await withTx(
              (tx) =>
                applyPricingRulesReplaced({
                  tx,
                  restaurantId:
                    restaurantA,
                  event: {
                    ...revision2.event,
                    payload_hash:
                      "a".repeat(64),
                  },
                  payload:
                    stalePayload,
                })
            );

          assert.equal(
            stale.state,
            "stale"
          );

          const duplicate =
            await withTx(
              (tx) =>
                applyPricingRulesReplaced({
                  tx,
                  restaurantId:
                    restaurantA,
                  event:
                    revision2.event,
                  payload:
                    revision2.payload,
                })
            );

          assert.equal(
            duplicate.state,
            "duplicate"
          );

          await assert.rejects(
            () =>
              withTx(
                (tx) =>
                  applyPricingRulesReplaced({
                    tx,
                    restaurantId:
                      restaurantA,
                    event: {
                      ...revision2.event,
                      payload_hash:
                        "f".repeat(64),
                    },
                    payload:
                      revision2.payload,
                  })
              ),
            (error) =>
              error instanceof
                EdgeDomainRevisionError &&
              error.code ===
                "EDGE_DOMAIN_REVISION_CONFLICT"
          );

          const executionsAfter =
            await pricingRows(
              pool,
              restaurantA
            );

          assert.deepEqual(
            executionsAfter.map(
              (row) => row.name
            ),
            executionsBefore.map(
              (row) => row.name
            )
          );

          console.log(
            "✅ 08 Pricing stale/replay/conflict protection proven"
          );
        }
      );

      await t.test(
        "strict malformed payload is rejected before business mutation",
        async () => {
          const before =
            await pricingRows(
              pool,
              restaurantA
            );

          assert.throws(
            () =>
              validatePricingRulesPayload({
                ...revision2.payload,
                restaurant_id:
                  restaurantB,
              }),
            (error) =>
              error instanceof
                PricingRulesContractError &&
              error.code ===
                "PRICING_SYNC_PAYLOAD_INVALID"
          );

          const after =
            await pricingRows(
              pool,
              restaurantA
            );

          assert.deepEqual(
            after.map(
              (row) => row.name
            ),
            before.map(
              (row) => row.name
            )
          );

          console.log(
            "✅ 09 Strict payload + envelope tenant authority proven"
          );
        }
      );

      await t.test(
        "application engine applies production pricing handler exactly once",
        async () => {
          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          const revision3 =
            await withTx(
              async (tx) => {
                await tx.qRun(
                  `
                  UPDATE public.pricing_rules
                  SET
                    name = $2,
                    updated_at = NOW()
                  WHERE restaurant_id = $1
                  `,
                  [
                    restaurantA,
                    `CLOUD REV3 ${token}`,
                  ]
                );

                return emitPricingRulesSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                );
              }
            );

          assert.equal(
            revision3.revision,
            3
          );

          await pool.query(
            `
            UPDATE public.pricing_rules
            SET
              name = $2,
              updated_at = NOW()
            WHERE restaurant_id = $1
            `,
            [
              restaurantA,
              `LOCAL STALE ${token}`,
            ]
          );

          const eventId =
            uuid();

          await receiveInboxEvent({
            pool,
            eventId,
            restaurantId:
              restaurantA,
            source:
              "cloud",
            eventType:
              PRICING_RULES_EVENT_TYPE,
            entityType:
              "pricing_rules",
            entityId:
              String(
                restaurantA
              ),
            payload:
              revision3.payload,
          });

          const first =
            await applyInboxOnce({
              pool,
              restaurantId:
                restaurantA,
              workerId:
                `pricing-apply-${token}`,
              handlers: {
                [PRICING_RULES_EVENT_TYPE]:
                  applyPricingRulesReplaced,
              },
              limit: 10,
              leaseSeconds: 30,
              maxAttempts: 3,
            });

          assert.equal(
            first.applied,
            1
          );

          const second =
            await applyInboxOnce({
              pool,
              restaurantId:
                restaurantA,
              workerId:
                `pricing-apply-2-${token}`,
              handlers: {
                [PRICING_RULES_EVENT_TYPE]:
                  applyPricingRulesReplaced,
              },
              limit: 10,
              leaseSeconds: 30,
              maxAttempts: 3,
            });

          assert.equal(
            second.claimed,
            0
          );

          const rows =
            await pricingRows(
              pool,
              restaurantA
            );

          assert.equal(
            rows.every(
              (row) =>
                row.name ===
                  `CLOUD REV3 ${token}`
            ),
            true
          );

          const inbox =
            await pool.query(
              `
              SELECT status
              FROM public.edge_inbox
              WHERE event_id = $1
              `,
              [
                eventId,
              ]
            );

          assert.equal(
            inbox.rows[0].status,
            "applied"
          );

          console.log(
            "✅ 10 Production pricing handler + application engine proven"
          );
        }
      );

      console.log(
        "============================================"
      );
      console.log(
        "✅ MAKS EDGE PRICING CONTRACT ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );
    } finally {
      if (
        originalRole ===
          undefined
      ) {
        delete process.env
          .MAKS_RUNTIME_ROLE;
      } else {
        process.env.MAKS_RUNTIME_ROLE =
          originalRole;
      }

      if (
        restaurantA ||
        restaurantB
      ) {
        await pool.query(
          `
          DELETE FROM public.restaurants
          WHERE id = ANY($1::bigint[])
          `,
          [
            [
              restaurantA,
              restaurantB,
            ].filter(Boolean),
          ]
        );
      }

      await pool.end();

      console.log(
        "✅ 11 Cleanup proven"
      );
    }
  }
);
