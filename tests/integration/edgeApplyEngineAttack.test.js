"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const {
  spawn,
} = require(
  "node:child_process"
);

const {
  once,
} = require(
  "node:events"
);

const {
  Pool,
} = require("pg");

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


const DATABASE_URL =
  String(
    process.env.DATABASE_URL ||
    ""
  ).trim();


function uuid() {
  return crypto.randomUUID();
}


async function getRestaurantName(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT name
      FROM
        public.restaurants
      WHERE
        id = $1
      `,
      [
        restaurantId,
      ]
    );

  return result
    .rows?.[0]
    ?.name ||
    null;
}


async function getInbox(
  pool,
  eventId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM
        public.edge_inbox
      WHERE
        event_id =
          $1::uuid
      `,
      [
        eventId,
      ]
    );

  return result
    .rows?.[0] ||
    null;
}


test(
  "MAKS Edge application engine attack",
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

        max:
          6,
      });

    let restaurantA =
      null;

    let restaurantB =
      null;

    try {
      const guard =
        await pool.query(
          `
          SELECT
            current_database()
              AS db
          `
        );

      assert.equal(
        guard.rows?.[0]?.db,
        "maks_test",
        "REFUSED: Edge application Attack may run only against maks_test"
      );

      console.log(
        "✅ 01 Database guard: maks_test"
      );

      const created =
        await pool.query(
          `
          INSERT INTO
            public.restaurants
          (
            name
          )
          VALUES
          (
            $1
          ),
          (
            $2
          )
          RETURNING
            id,
            name
          `,
          [
            `EDGE APPLY A ${uuid()}`,
            `EDGE APPLY B ${uuid()}`,
          ]
        );

      restaurantA =
        Number(
          created.rows[0].id
        );

      restaurantB =
        Number(
          created.rows[1].id
        );

      console.log(
        "✅ 02 Isolated application tenants created"
      );

      await t.test(
        "allowlisted Cloud event applies atomically exactly once",
        async () => {
          const eventId =
            uuid();

          const targetName =
            `EDGE APPLY SUCCESS ${uuid()}`;

          await receiveInboxEvent({
            pool,

            eventId,

            restaurantId:
              restaurantA,

            source:
              "cloud",

            eventType:
              "attack.restaurant.rename",

            entityType:
              "restaurant",

            entityId:
              String(
                restaurantA
              ),

            payload: {
              restaurant_id:
                restaurantB,

              name:
                targetName,
            },
          });

          let executions =
            0;

          const handlers = {
            "attack.restaurant.rename":
              async ({
                tx,
                restaurantId,
                payload,
              }) => {
                executions +=
                  1;

                await tx.qRun(
                  `
                  UPDATE
                    public.restaurants
                  SET
                    name = $2
                  WHERE
                    id = $1
                  `,
                  [
                    restaurantId,
                    payload.name,
                  ]
                );

                return {
                  renamed:
                    true,
                };
              },
          };

          const applied =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `apply-success-${uuid()}`,

              handlers,
            });

          assert.deepEqual(
            applied,
            {
              claimed: 1,
              applied: 1,
              failed: 0,
              dead_lettered: 0,
            }
          );

          assert.equal(
            executions,
            1
          );

          assert.equal(
            await getRestaurantName(
              pool,
              restaurantA
            ),
            targetName,
            "Handler must use authoritative inbox restaurant_id, not payload restaurant_id"
          );

          assert.notEqual(
            await getRestaurantName(
              pool,
              restaurantB
            ),
            targetName,
            "Cloud payload must not cross tenant ownership"
          );

          const inbox =
            await getInbox(
              pool,
              eventId
            );

          assert.equal(
            inbox?.status,
            "applied"
          );

          assert.ok(
            inbox?.applied_at
          );

          const idempotency =
            await pool.query(
              `
              SELECT
                status,
                request_hash
              FROM
                public.edge_idempotency
              WHERE
                restaurant_id = $1
                AND
                scope =
                  'edge.inbox.apply'
                AND
                idempotency_key =
                  $2
              `,
              [
                restaurantA,
                eventId,
              ]
            );

          assert.equal(
            idempotency.rowCount,
            1
          );

          assert.equal(
            idempotency.rows[0]
              .status,
            "completed"
          );

          const replay =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `apply-replay-${uuid()}`,

              handlers,
            });

          assert.equal(
            replay.claimed,
            0
          );

          assert.equal(
            executions,
            1,
            "Applied inbox event executed twice"
          );

          console.log(
            "✅ 03 Transactional exactly-once application proven"
          );
        }
      );


      await t.test(
        "unknown Cloud event is dead-lettered without business mutation",
        async () => {
          const eventId =
            uuid();

          const before =
            await getRestaurantName(
              pool,
              restaurantA
            );

          await receiveInboxEvent({
            pool,

            eventId,

            restaurantId:
              restaurantA,

            source:
              "cloud",

            eventType:
              "attack.unsupported",

            payload: {
              name:
                "SHOULD NEVER APPLY",
            },
          });

          const result =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `apply-unknown-${uuid()}`,

              handlers: {},
            });

          assert.deepEqual(
            result,
            {
              claimed: 1,
              applied: 0,
              failed: 0,
              dead_lettered: 1,
            }
          );

          const inbox =
            await getInbox(
              pool,
              eventId
            );

          assert.equal(
            inbox?.status,
            "dead_letter"
          );

          assert.match(
            String(
              inbox?.last_error ||
              ""
            ),
            /EDGE_APPLY_EVENT_UNSUPPORTED/
          );

          assert.equal(
            await getRestaurantName(
              pool,
              restaurantA
            ),
            before
          );

          console.log(
            "✅ 04 Unknown event fail-closed dead-letter proven"
          );
        }
      );


      await t.test(
        "handler failure rolls back business mutation then retries safely",
        async () => {
          const eventId =
            uuid();

          const before =
            await getRestaurantName(
              pool,
              restaurantA
            );

          const targetName =
            `EDGE APPLY RETRY ${uuid()}`;

          await receiveInboxEvent({
            pool,

            eventId,

            restaurantId:
              restaurantA,

            source:
              "cloud",

            eventType:
              "attack.restaurant.retry",

            payload: {
              name:
                targetName,
            },
          });

          let shouldFail =
            true;

          const handlers = {
            "attack.restaurant.retry":
              async ({
                tx,
                restaurantId,
                payload,
              }) => {
                await tx.qRun(
                  `
                  UPDATE
                    public.restaurants
                  SET
                    name = $2
                  WHERE
                    id = $1
                  `,
                  [
                    restaurantId,
                    payload.name,
                  ]
                );

                if (shouldFail) {
                  shouldFail =
                    false;

                  throw new Error(
                    "SIMULATED_APPLY_CRASH"
                  );
                }

                return {
                  recovered:
                    true,
                };
              },
          };

          const failed =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `apply-fail-${uuid()}`,

              handlers,

              maxAttempts:
                3,
            });

          assert.equal(
            failed.failed,
            1
          );

          assert.equal(
            await getRestaurantName(
              pool,
              restaurantA
            ),
            before,
            "Business mutation survived failed application transaction"
          );

          const failedInbox =
            await getInbox(
              pool,
              eventId
            );

          assert.equal(
            failedInbox?.status,
            "failed"
          );

          assert.match(
            String(
              failedInbox
                ?.last_error ||
              ""
            ),
            /SIMULATED_APPLY_CRASH/
          );

          const incomplete =
            await pool.query(
              `
              SELECT COUNT(*)::int
                AS count
              FROM
                public.edge_idempotency
              WHERE
                restaurant_id = $1
                AND
                scope =
                  'edge.inbox.apply'
                AND
                idempotency_key =
                  $2
              `,
              [
                restaurantA,
                eventId,
              ]
            );

          assert.equal(
            incomplete.rows[0]
              .count,
            0,
            "Rolled-back handler left an idempotency record behind"
          );

          /*
           * Production retry delay is intentional.
           * Move only this isolated maks_test event due now so
           * the Attack can prove the recovery path immediately.
           */
          await pool.query(
            `
            UPDATE
              public.edge_inbox
            SET
              next_attempt_at =
                NOW()
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

          const recovered =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `apply-recover-${uuid()}`,

              handlers,

              maxAttempts:
                3,
            });

          assert.equal(
            recovered.applied,
            1
          );

          assert.equal(
            await getRestaurantName(
              pool,
              restaurantA
            ),
            targetName
          );

          const recoveredInbox =
            await getInbox(
              pool,
              eventId
            );

          assert.equal(
            recoveredInbox?.status,
            "applied"
          );

          assert.equal(
            Number(
              recoveredInbox
                ?.apply_attempts ||
              0
            ),
            2
          );

          console.log(
            "✅ 05 Crash rollback + retry recovery proven"
          );
        }
      );


      await t.test(
        "two application workers cannot execute one event twice",
        async () => {
          const eventId =
            uuid();

          const targetName =
            `EDGE APPLY RACE ${uuid()}`;

          await receiveInboxEvent({
            pool,

            eventId,

            restaurantId:
              restaurantA,

            source:
              "cloud",

            eventType:
              "attack.restaurant.concurrent",

            payload: {
              name:
                targetName,
            },
          });

          let executions =
            0;

          const handlers = {
            "attack.restaurant.concurrent":
              async ({
                tx,
                restaurantId,
                payload,
              }) => {
                executions +=
                  1;

                await tx.qRun(
                  `
                  SELECT
                    pg_sleep(0.15)
                  `
                );

                await tx.qRun(
                  `
                  UPDATE
                    public.restaurants
                  SET
                    name = $2
                  WHERE
                    id = $1
                  `,
                  [
                    restaurantId,
                    payload.name,
                  ]
                );

                return {
                  concurrent:
                    true,
                };
              },
          };

          const results =
            await Promise.all([
              applyInboxOnce({
                pool,

                restaurantId:
                  restaurantA,

                workerId:
                  `apply-race-a-${uuid()}`,

                handlers,
              }),

              applyInboxOnce({
                pool,

                restaurantId:
                  restaurantA,

                workerId:
                  `apply-race-b-${uuid()}`,

                handlers,
              }),
            ]);

          assert.equal(
            results.reduce(
              (
                total,
                row
              ) =>
                total +
                row.applied,
              0
            ),
            1
          );

          assert.equal(
            executions,
            1
          );

          assert.equal(
            (
              await getInbox(
                pool,
                eventId
              )
            )?.status,
            "applied"
          );

          assert.equal(
            await getRestaurantName(
              pool,
              restaurantA
            ),
            targetName
          );

          console.log(
            "✅ 06 Concurrent exactly-once worker protection proven"
          );
        }
      );


      await t.test(
        "application worker cannot cross restaurant boundary",
        async () => {
          const eventId =
            uuid();

          await receiveInboxEvent({
            pool,

            eventId,

            restaurantId:
              restaurantB,

            source:
              "cloud",

            eventType:
              "attack.restaurant.isolation",

            payload: {
              name:
                `EDGE B ${uuid()}`,
            },
          });

          const result =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `apply-tenant-${uuid()}`,

              handlers: {
                "attack.restaurant.isolation":
                  async () => {
                    throw new Error(
                      "TENANT LEAK"
                    );
                  },
              },
            });

          assert.equal(
            result.claimed,
            0
          );

          assert.equal(
            (
              await getInbox(
                pool,
                eventId
              )
            )?.status,
            "received"
          );

          console.log(
            "✅ 07 Application tenant isolation proven"
          );
        }
      );


      await t.test(
        "application engine never falls back to global DATABASE_URL",
        async () => {
          const childScript =
            `
"use strict";

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const {
  Pool,
} = require("pg");

const {
  receiveInboxEvent,
} = require("./edge/syncStore");

const {
  applyInboxOnce,
} = require("./edge/applyEngine");

(async () => {
  const localUrl =
    String(
      process.env
        .EDGE_ATTACK_LOCAL_DATABASE_URL ||
      ""
    ).trim();

  assert.ok(
    localUrl,
    "Local Attack database URL is required"
  );

  const pool =
    new Pool({
      connectionString:
        localUrl,
    });

  let restaurantId =
    null;

  try {
    const guard =
      await pool.query(
        "SELECT current_database() AS db"
      );

    assert.equal(
      guard.rows?.[0]?.db,
      "maks_test"
    );

    const restaurant =
      await pool.query(
        \`
        INSERT INTO
          public.restaurants
        (
          name
        )
        VALUES
        (
          $1
        )
        RETURNING id
        \`,
        [
          \`EDGE APPLY EXPLICIT POOL \${crypto.randomUUID()}\`,
        ]
      );

    restaurantId =
      Number(
        restaurant.rows[0].id
      );

    const eventId =
      crypto.randomUUID();

    const targetName =
      \`EDGE APPLY LOCAL \${crypto.randomUUID()}\`;

    await receiveInboxEvent({
      pool,

      eventId,

      restaurantId,

      source:
        "cloud",

      eventType:
        "attack.explicit.pool",

      payload: {
        name:
          targetName,
      },
    });

    const result =
      await applyInboxOnce({
        pool,

        restaurantId,

        workerId:
          \`explicit-pool-\${crypto.randomUUID()}\`,

        handlers: {
          "attack.explicit.pool":
            async ({
              tx,
              restaurantId:
                rid,
              payload,
            }) => {
              await tx.qRun(
                \`
                UPDATE
                  public.restaurants
                SET
                  name = $2
                WHERE
                  id = $1
                \`,
                [
                  rid,
                  payload.name,
                ]
              );
            },
        },
      });

    assert.equal(
      result.applied,
      1
    );

    const applied =
      await pool.query(
        \`
        SELECT
          r.name,
          i.status
        FROM
          public.restaurants r
        JOIN
          public.edge_inbox i
          ON
            i.restaurant_id =
              r.id
        WHERE
          r.id = $1
          AND
          i.event_id =
            $2::uuid
        \`,
        [
          restaurantId,
          eventId,
        ]
      );

    assert.equal(
      applied.rows?.[0]?.name,
      targetName
    );

    assert.equal(
      applied.rows?.[0]?.status,
      "applied"
    );
  } finally {
    if (restaurantId) {
      await pool.query(
        "DELETE FROM public.restaurants WHERE id = $1",
        [
          restaurantId,
        ]
      );
    }

    await pool.end();
  }
})().catch(
  (error) => {
    console.error(
      error?.message ||
      error
    );

    process.exitCode =
      1;
  }
);
`;

          const child =
            spawn(
              process.execPath,
              [
                "-e",
                childScript,
              ],
              {
                cwd:
                  require("node:path")
                    .resolve(
                      __dirname,
                      "../.."
                    ),

                env: {
                  ...process.env,

                  DATABASE_URL:
                    "postgresql://edge_invalid:edge_invalid@127.0.0.1:1/maks_test",

                  EDGE_ATTACK_LOCAL_DATABASE_URL:
                    DATABASE_URL,
                },

                stdio: [
                  "ignore",
                  "pipe",
                  "pipe",
                ],
              }
            );

          let output =
            "";

          child.stdout.on(
            "data",
            (chunk) => {
              output +=
                chunk.toString(
                  "utf8"
                );
            }
          );

          child.stderr.on(
            "data",
            (chunk) => {
              output +=
                chunk.toString(
                  "utf8"
                );
            }
          );

          await once(
            child,
            "exit"
          );

          assert.equal(
            child.exitCode,
            0,
            output
          );

          assert.equal(
            output.includes(
              DATABASE_URL
            ),
            false,
            "Explicit-pool Attack leaked the database URL"
          );

          console.log(
            "✅ 08 Explicit Edge-local pool isolation proven"
          );
        }
      );


      await t.test(
        "non-Cloud inbox source is rejected before handler execution",
        async () => {
          const eventId =
            uuid();

          let executions =
            0;

          await receiveInboxEvent({
            pool,

            eventId,

            restaurantId:
              restaurantA,

            source:
              "edge",

            eventType:
              "attack.source.rejected",

            payload: {
              attack:
                true,
            },
          });

          const result =
            await applyInboxOnce({
              pool,

              restaurantId:
                restaurantA,

              workerId:
                `apply-source-${uuid()}`,

              handlers: {
                "attack.source.rejected":
                  async () => {
                    executions +=
                      1;
                  },
              },
            });

          assert.equal(
            executions,
            0
          );

          assert.equal(
            result.dead_lettered,
            1
          );

          const inbox =
            await getInbox(
              pool,
              eventId
            );

          assert.equal(
            inbox?.status,
            "dead_letter"
          );

          assert.match(
            String(
              inbox?.last_error ||
              ""
            ),
            /EDGE_APPLY_SOURCE_REJECTED/
          );

          console.log(
            "✅ 09 Cloud-only source enforcement proven"
          );
        }
      );


      console.log(
        ""
      );

      console.log(
        "============================================"
      );

      console.log(
        "MAKS EDGE APPLICATION ENGINE ATTACK COMPLETE"
      );

      console.log(
        "============================================"
      );
    } finally {
      if (
        restaurantA ||
        restaurantB
      ) {
        await pool.query(
          `
          DELETE FROM
            public.restaurants
          WHERE
            id = ANY(
              $1::int[]
            )
          `,
          [
            [
              restaurantA,
              restaurantB,
            ]
              .filter(Boolean),
          ]
        );
      }

      await pool.end();
    }
  }
);
