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
  EdgeSyncError,

  hashJson,

  enqueueEdgeEvent,
  claimOutboxEvents,
  ackOutboxEvent,
  failOutboxEvent,

  receiveInboxEvent,
  claimInboxEvents,
  markInboxApplied,
  failInboxEvent,

  withEdgeOperation,

  ensureSyncState,
  updateSyncState,
} = require(
  "../../edge/syncStore"
);

const DATABASE_URL =
  String(
    process.env.DATABASE_URL || ""
  ).trim();

function uuid() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

async function expectEdgeError(
  fn,
  code
) {
  let caught = null;

  try {
    await fn();
  } catch (error) {
    caught = error;
  }

  assert.ok(
    caught,
    `Expected Edge error ${code}`
  );

  assert.ok(
    caught instanceof
      EdgeSyncError,
    `Expected EdgeSyncError, got ${caught?.constructor?.name}`
  );

  assert.equal(
    caught.code,
    code
  );

  return caught;
}

function ids(rows) {
  return new Set(
    rows.map(
      (row) =>
        String(
          row.event_id
        )
    )
  );
}

function intersection(
  a,
  b
) {
  return [
    ...a,
  ].filter(
    (value) =>
      b.has(value)
  );
}

test(
  "MAKS Edge syncStore attack",
  {
    timeout: 60000,
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

    let restaurantA =
      null;

    let restaurantB =
      null;

    try {
      // ===================================================
      // DATABASE GUARD
      // ===================================================

      const database =
        await pool.query(`
          SELECT
            current_database()
              AS db
        `);

      assert.equal(
        database.rows?.[0]?.db,
        "maks_test",
        "REFUSED: syncStore Attack may run only against maks_test"
      );

      console.log(
        "✅ 01 Database guard: maks_test"
      );

      // Snapshot global Edge counts so cleanup can be proven.
      const before =
        (
          await pool.query(`
            SELECT
              (
                SELECT COUNT(*)
                FROM public.edge_outbox
              )::bigint
                AS outbox,

              (
                SELECT COUNT(*)
                FROM public.edge_inbox
              )::bigint
                AS inbox,

              (
                SELECT COUNT(*)
                FROM public.edge_idempotency
              )::bigint
                AS idempotency,

              (
                SELECT COUNT(*)
                FROM public.edge_sync_state
              )::bigint
                AS sync_state
          `)
        ).rows[0];

      // ===================================================
      // TEMPORARY ISOLATED TENANTS
      // ===================================================

      const ra =
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
          )
          RETURNING id
          `,
          [
            `EDGE SYNCSTORE ATTACK A ${token}`,
          ]
        );

      const rb =
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
          )
          RETURNING id
          `,
          [
            `EDGE SYNCSTORE ATTACK B ${token}`,
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

      assert.ok(
        Number.isSafeInteger(
          restaurantA
        )
      );

      assert.ok(
        Number.isSafeInteger(
          restaurantB
        )
      );

      assert.notEqual(
        restaurantA,
        restaurantB
      );

      console.log(
        "✅ 02 Isolated test tenants created"
      );

      // ===================================================
      // CANONICAL JSON HASH
      // ===================================================

      await t.test(
        "canonical JSON hashing is stable",
        async () => {
          const first =
            hashJson({
              a: 1,
              b: {
                x: true,
                y: [
                  1,
                  2,
                ],
              },
            });

          const second =
            hashJson({
              b: {
                y: [
                  1,
                  2,
                ],
                x: true,
              },
              a: 1,
            });

          assert.equal(
            first,
            second
          );

          assert.match(
            first,
            /^[0-9a-f]{64}$/
          );

          console.log(
            "✅ 03 Canonical payload hashing proven"
          );
        }
      );

      // ===================================================
      // OUTBOX CONCURRENCY
      // ===================================================

      await t.test(
        "concurrent outbox workers never receive same event",
        async () => {
          const workerA =
            `worker-a-${token}`;

          const workerB =
            `worker-b-${token}`;

          const created = [];

          for (
            let i = 0;
            i < 6;
            i += 1
          ) {
            created.push(
              await enqueueEdgeEvent({
                restaurantId:
                  restaurantA,

                eventType:
                  "attack.concurrent",

                entityType:
                  "attack",

                entityId:
                  `concurrent-${i}`,

                idempotencyKey:
                  `syncstore-attack-${token}-concurrent-${i}`,

                payload: {
                  token,
                  index: i,
                },
              })
            );
          }

          assert.equal(
            created.length,
            6
          );

          const [
            claimedA,
            claimedB,
          ] =
            await Promise.all([
              claimOutboxEvents({
                restaurantId:
                  restaurantA,

                workerId:
                  workerA,

                limit: 3,

                leaseSeconds:
                  30,
              }),

              claimOutboxEvents({
                restaurantId:
                  restaurantA,

                workerId:
                  workerB,

                limit: 3,

                leaseSeconds:
                  30,
              }),
            ]);

          assert.equal(
            claimedA.length,
            3
          );

          assert.equal(
            claimedB.length,
            3
          );

          const setA =
            ids(
              claimedA
            );

          const setB =
            ids(
              claimedB
            );

          assert.equal(
            intersection(
              setA,
              setB
            ).length,
            0,
            "Two workers claimed the same outbox event"
          );

          assert.equal(
            new Set([
              ...setA,
              ...setB,
            ]).size,
            6
          );

          // Wrong worker must not ACK worker A's event.
          await expectEdgeError(
            () =>
              ackOutboxEvent({
                restaurantId:
                  restaurantA,

                eventId:
                  claimedA[0]
                    .event_id,

                workerId:
                  workerB,
              }),

            "EDGE_OUTBOX_NOT_OWNED"
          );

          for (
            const row of
              claimedA
          ) {
            await ackOutboxEvent({
              restaurantId:
                restaurantA,

              eventId:
                row.event_id,

              workerId:
                workerA,
            });
          }

          for (
            const row of
              claimedB
          ) {
            await ackOutboxEvent({
              restaurantId:
                restaurantA,

              eventId:
                row.event_id,

              workerId:
                workerB,
            });
          }

          console.log(
            "✅ 04 Concurrent outbox claiming + worker ownership proven"
          );
        }
      );

      // ===================================================
      // ACTUAL SKIP LOCKED BEHAVIOUR
      // ===================================================

      await t.test(
        "outbox skips a row locked by another transaction",
        async () => {
          const event1 =
            await enqueueEdgeEvent({
              restaurantId:
                restaurantA,

              eventType:
                "attack.skip-locked",

              idempotencyKey:
                `syncstore-attack-${token}-skip-1`,

              payload: {
                token,
                row: 1,
              },
            });

          const event2 =
            await enqueueEdgeEvent({
              restaurantId:
                restaurantA,

              eventType:
                "attack.skip-locked",

              idempotencyKey:
                `syncstore-attack-${token}-skip-2`,

              payload: {
                token,
                row: 2,
              },
            });

          const locker =
            await pool.connect();

          try {
            await locker.query(
              "BEGIN"
            );

            const locked =
              await locker.query(
                `
                SELECT
                  id,
                  event_id
                FROM
                  public.edge_outbox
                WHERE
                  restaurant_id = $1
                  AND event_id IN (
                    $2,
                    $3
                  )
                  AND status =
                    'pending'
                ORDER BY id
                LIMIT 1
                FOR UPDATE
                `,
                [
                  restaurantA,
                  event1.event_id,
                  event2.event_id,
                ]
              );

            assert.equal(
              locked.rowCount,
              1
            );

            const lockedId =
              String(
                locked.rows[0]
                  .event_id
              );

            const started =
              Date.now();

            const claimed =
              await claimOutboxEvents({
                restaurantId:
                  restaurantA,

                workerId:
                  `skip-worker-${token}`,

                limit: 1,

                leaseSeconds:
                  30,
              });

            const duration =
              Date.now() -
              started;

            assert.equal(
              claimed.length,
              1
            );

            assert.notEqual(
              String(
                claimed[0]
                  .event_id
              ),
              lockedId,
              "Worker claimed the row held by another transaction"
            );

            assert.ok(
              duration < 1500,
              `SKIP LOCKED claim blocked for ${duration}ms`
            );

            await ackOutboxEvent({
              restaurantId:
                restaurantA,

              eventId:
                claimed[0]
                  .event_id,

              workerId:
                `skip-worker-${token}`,
            });

            await locker.query(
              "ROLLBACK"
            );
          } finally {
            try {
              await locker.query(
                "ROLLBACK"
              );
            } catch {}

            locker.release();
          }

          const remaining =
            await claimOutboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                `skip-cleanup-${token}`,

              limit: 5,

              leaseSeconds:
                30,
            });

          for (
            const row of
              remaining
          ) {
            await ackOutboxEvent({
              restaurantId:
                restaurantA,

              eventId:
                row.event_id,

              workerId:
                `skip-cleanup-${token}`,
            });
          }

          console.log(
            "✅ 05 FOR UPDATE SKIP LOCKED proven"
          );
        }
      );

      // ===================================================
      // DEAD OUTBOX WORKER RECOVERY
      // ===================================================

      await t.test(
        "stale outbox lease is reclaimed safely",
        async () => {
          const event =
            await enqueueEdgeEvent({
              restaurantId:
                restaurantA,

              eventType:
                "attack.dead-worker",

              idempotencyKey:
                `syncstore-attack-${token}-dead-outbox`,

              payload: {
                token,
              },
            });

          const deadWorker =
            `dead-worker-${token}`;

          const recoveryWorker =
            `recovery-worker-${token}`;

          const firstClaim =
            await claimOutboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                deadWorker,

              limit: 1,

              leaseSeconds:
                30,
            });

          assert.equal(
            firstClaim.length,
            1
          );

          assert.equal(
            String(
              firstClaim[0]
                .event_id
            ),
            String(
              event.event_id
            )
          );

          assert.equal(
            firstClaim[0]
              .retry_count,
            1
          );

          // Simulate worker death without waiting in real time.
          await withTx(
            async (tx) => {
              await tx.qRun(
                `
                UPDATE
                  public.edge_outbox
                SET
                  locked_at =
                    NOW()
                    -
                    INTERVAL '5 minutes'
                WHERE
                  restaurant_id = $1
                  AND event_id = $2
                `,
                [
                  restaurantA,
                  event.event_id,
                ]
              );
            }
          );

          const reclaimed =
            await claimOutboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                recoveryWorker,

              limit: 1,

              leaseSeconds:
                30,
            });

          assert.equal(
            reclaimed.length,
            1
          );

          assert.equal(
            String(
              reclaimed[0]
                .event_id
            ),
            String(
              event.event_id
            )
          );

          assert.equal(
            reclaimed[0]
              .locked_by,
            recoveryWorker
          );

          assert.equal(
            reclaimed[0]
              .retry_count,
            2
          );

          await expectEdgeError(
            () =>
              ackOutboxEvent({
                restaurantId:
                  restaurantA,

                eventId:
                  event.event_id,

                workerId:
                  deadWorker,
              }),

            "EDGE_OUTBOX_NOT_OWNED"
          );

          await ackOutboxEvent({
            restaurantId:
              restaurantA,

            eventId:
              event.event_id,

            workerId:
              recoveryWorker,
          });

          console.log(
            "✅ 06 Dead outbox worker recovery proven"
          );
        }
      );

      // ===================================================
      // TENANT ISOLATION
      // ===================================================

      await t.test(
        "outbox worker cannot cross restaurant boundary",
        async () => {
          const event =
            await enqueueEdgeEvent({
              restaurantId:
                restaurantB,

              eventType:
                "attack.tenant",

              idempotencyKey:
                `syncstore-attack-${token}-tenant-b`,

              payload: {
                restaurant:
                  "B",
              },
            });

          const wrongTenant =
            await claimOutboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                `tenant-a-${token}`,

              limit: 100,

              leaseSeconds:
                30,
            });

          assert.equal(
            wrongTenant.some(
              (row) =>
                String(
                  row.event_id
                ) ===
                String(
                  event.event_id
                )
            ),
            false
          );

          const rightTenant =
            await claimOutboxEvents({
              restaurantId:
                restaurantB,

              workerId:
                `tenant-b-${token}`,

              limit: 1,

              leaseSeconds:
                30,
            });

          assert.equal(
            rightTenant.length,
            1
          );

          assert.equal(
            String(
              rightTenant[0]
                .event_id
            ),
            String(
              event.event_id
            )
          );

          await expectEdgeError(
            () =>
              ackOutboxEvent({
                restaurantId:
                  restaurantA,

                eventId:
                  event.event_id,

                workerId:
                  `tenant-b-${token}`,
              }),

            "EDGE_OUTBOX_NOT_OWNED"
          );

          await ackOutboxEvent({
            restaurantId:
              restaurantB,

            eventId:
              event.event_id,

            workerId:
              `tenant-b-${token}`,
          });

          console.log(
            "✅ 07 Runtime tenant isolation proven"
          );
        }
      );

      // ===================================================
      // FAILURE + RETRY PATH
      // ===================================================

      await t.test(
        "failed outbox event returns to retry queue",
        async () => {
          const event =
            await enqueueEdgeEvent({
              restaurantId:
                restaurantA,

              eventType:
                "attack.retry",

              idempotencyKey:
                `syncstore-attack-${token}-retry`,

              payload: {
                token,
              },
            });

          const worker =
            `retry-a-${token}`;

          const claimed =
            await claimOutboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                worker,

              limit: 1,

              leaseSeconds:
                30,
            });

          assert.equal(
            claimed.length,
            1
          );

          assert.equal(
            String(
              claimed[0]
                .event_id
            ),
            String(
              event.event_id
            )
          );

          const failed =
            await failOutboxEvent({
              restaurantId:
                restaurantA,

              eventId:
                event.event_id,

              workerId:
                worker,

              lastError:
                "simulated cloud outage",

              retryDelaySeconds:
                0,
            });

          assert.equal(
            failed.status,
            "failed"
          );

          assert.equal(
            failed.locked_by,
            null
          );

          const retry =
            await claimOutboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                `retry-b-${token}`,

              limit: 1,

              leaseSeconds:
                30,
            });

          assert.equal(
            retry.length,
            1
          );

          assert.equal(
            String(
              retry[0]
                .event_id
            ),
            String(
              event.event_id
            )
          );

          assert.equal(
            retry[0]
              .retry_count,
            2
          );

          await ackOutboxEvent({
            restaurantId:
              restaurantA,

            eventId:
              event.event_id,

            workerId:
              `retry-b-${token}`,
          });

          console.log(
            "✅ 08 Failure/retry lifecycle proven"
          );
        }
      );

      // ===================================================
      // INBOX REPLAY
      // ===================================================

      await t.test(
        "inbox replay is harmless but conflicting replay is rejected",
        async () => {
          const eventId =
            uuid();

          const first =
            await receiveInboxEvent({
              eventId,

              restaurantId:
                restaurantA,

              source:
                "cloud",

              eventType:
                "menu.item.updated",

              entityType:
                "menu_item",

              entityId:
                "attack-menu-item",

              payload: {
                a: 1,
                b: 2,
              },
            });

          assert.equal(
            first.duplicate,
            false
          );

          // Same logical JSON, different property order.
          const replay =
            await receiveInboxEvent({
              eventId,

              restaurantId:
                restaurantA,

              source:
                "cloud",

              eventType:
                "menu.item.updated",

              entityType:
                "menu_item",

              entityId:
                "attack-menu-item",

              payload: {
                b: 2,
                a: 1,
              },
            });

          assert.equal(
            replay.duplicate,
            true
          );

          await expectEdgeError(
            () =>
              receiveInboxEvent({
                eventId,

                restaurantId:
                  restaurantA,

                source:
                  "cloud",

                eventType:
                  "menu.item.updated",

                entityType:
                  "menu_item",

                entityId:
                  "attack-menu-item",

                payload: {
                  a: 999,
                  b: 2,
                },
              }),

            "EDGE_INBOX_REPLAY_CONFLICT"
          );

          const claimed =
            await claimInboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                `inbox-worker-${token}`,

              limit: 1,

              leaseSeconds:
                30,
            });

          const mine =
            claimed.find(
              (row) =>
                String(
                  row.event_id
                ) ===
                eventId
            );

          assert.ok(
            mine,
            "Expected inbox event was not claimed"
          );

          await expectEdgeError(
            () =>
              markInboxApplied({
                restaurantId:
                  restaurantA,

                eventId,

                workerId:
                  `wrong-inbox-worker-${token}`,
              }),

            "EDGE_INBOX_NOT_OWNED"
          );

          await markInboxApplied({
            restaurantId:
              restaurantA,

            eventId,

            workerId:
              `inbox-worker-${token}`,
          });

          console.log(
            "✅ 09 Inbox replay/conflict/ownership proven"
          );
        }
      );

      // ===================================================
      // DEAD INBOX WORKER RECOVERY
      // ===================================================

      await t.test(
        "stale inbox lease is reclaimed safely",
        async () => {
          const eventId =
            uuid();

          await receiveInboxEvent({
            eventId,

            restaurantId:
              restaurantA,

            source:
              "cloud",

            eventType:
              "attack.inbox-death",

            payload: {
              token,
            },
          });

          const deadWorker =
            `dead-inbox-${token}`;

          const recovery =
            `recover-inbox-${token}`;

          const first =
            await claimInboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                deadWorker,

              limit: 1,

              leaseSeconds:
                30,
            });

          const mine =
            first.find(
              (row) =>
                String(
                  row.event_id
                ) ===
                eventId
            );

          assert.ok(
            mine,
            "Dead worker did not claim expected inbox event"
          );

          await withTx(
            async (tx) => {
              await tx.qRun(
                `
                UPDATE
                  public.edge_inbox
                SET
                  locked_at =
                    NOW()
                    -
                    INTERVAL '5 minutes'
                WHERE
                  restaurant_id = $1
                  AND event_id = $2
                `,
                [
                  restaurantA,
                  eventId,
                ]
              );
            }
          );

          const reclaimed =
            await claimInboxEvents({
              restaurantId:
                restaurantA,

              workerId:
                recovery,

              limit: 1,

              leaseSeconds:
                30,
            });

          const recovered =
            reclaimed.find(
              (row) =>
                String(
                  row.event_id
                ) ===
                eventId
            );

          assert.ok(
            recovered,
            "Stale inbox event was not reclaimed"
          );

          assert.equal(
            recovered.locked_by,
            recovery
          );

          assert.equal(
            recovered.apply_attempts,
            2
          );

          await expectEdgeError(
            () =>
              failInboxEvent({
                restaurantId:
                  restaurantA,

                eventId,

                workerId:
                  deadWorker,

                lastError:
                  "dead worker",
              }),

            "EDGE_INBOX_NOT_OWNED"
          );

          await markInboxApplied({
            restaurantId:
              restaurantA,

            eventId,

            workerId:
              recovery,
          });

          console.log(
            "✅ 10 Dead inbox worker recovery proven"
          );
        }
      );

      // ===================================================
      // ATOMIC CRASH TEST
      // ===================================================

      await t.test(
        "business mutation + outbox + idempotency roll back together on crash",
        async () => {
          const installationId =
            uuid();

          const operationKey =
            `syncstore-attack-${token}-atomic-crash`;

          const outboxKey =
            `syncstore-attack-${token}-atomic-crash-event`;

          await assert.rejects(
            () =>
              withEdgeOperation({
                restaurantId:
                  restaurantA,

                scope:
                  "attack.atomic",

                idempotencyKey:
                  operationKey,

                requestPayload: {
                  action:
                    "simulated-business-write",
                },

                execute:
                  async ({
                    tx,
                    enqueueEdgeEvent:
                      enqueue,
                  }) => {
                    await tx.qRun(
                      `
                      INSERT INTO
                        public.edge_sync_state
                      (
                        restaurant_id,
                        installation_id,
                        sync_status
                      )
                      VALUES
                      (
                        $1,
                        $2,
                        'pending'
                      )
                      `,
                      [
                        restaurantA,
                        installationId,
                      ]
                    );

                    await enqueue({
                      eventType:
                        "attack.atomic",

                      entityType:
                        "attack",

                      entityId:
                        "atomic-crash",

                      idempotencyKey:
                        outboxKey,

                      payload: {
                        token,
                        atomic:
                          true,
                      },
                    });

                    throw new Error(
                      "SIMULATED_PROCESS_CRASH"
                    );
                  },
              }),

            /SIMULATED_PROCESS_CRASH/
          );

          const state =
            await pool.query(
              `
              SELECT COUNT(*)::int
                AS count
              FROM
                public.edge_sync_state
              WHERE
                restaurant_id = $1
                AND
                installation_id = $2
              `,
              [
                restaurantA,
                installationId,
              ]
            );

          const outbox =
            await pool.query(
              `
              SELECT COUNT(*)::int
                AS count
              FROM
                public.edge_outbox
              WHERE
                restaurant_id = $1
                AND
                idempotency_key = $2
              `,
              [
                restaurantA,
                outboxKey,
              ]
            );

          const idem =
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
                  'attack.atomic'
                AND
                idempotency_key = $2
              `,
              [
                restaurantA,
                operationKey,
              ]
            );

          assert.equal(
            state.rows[0].count,
            0,
            "Business mutation survived failed transaction"
          );

          assert.equal(
            outbox.rows[0].count,
            0,
            "Outbox event survived failed transaction"
          );

          assert.equal(
            idem.rows[0].count,
            0,
            "Idempotency record survived failed transaction"
          );

          console.log(
            "✅ 11 Atomic crash rollback proven"
          );
        }
      );

      // ===================================================
      // SUCCESSFUL ATOMIC OPERATION + REPLAY
      // ===================================================

      await t.test(
        "completed operation executes once and replay returns stored response",
        async () => {
          const installationId =
            uuid();

          const operationKey =
            `syncstore-attack-${token}-atomic-success`;

          const outboxKey =
            `syncstore-attack-${token}-atomic-success-event`;

          let executions = 0;

          const run =
            () =>
              withEdgeOperation({
                restaurantId:
                  restaurantA,

                scope:
                  "attack.atomic-success",

                idempotencyKey:
                  operationKey,

                requestPayload: {
                  order:
                    "A100",
                  quantity: 1,
                },

                execute:
                  async ({
                    tx,
                    enqueueEdgeEvent:
                      enqueue,
                  }) => {
                    executions += 1;

                    await tx.qRun(
                      `
                      INSERT INTO
                        public.edge_sync_state
                      (
                        restaurant_id,
                        installation_id,
                        sync_status
                      )
                      VALUES
                      (
                        $1,
                        $2,
                        'pending'
                      )
                      `,
                      [
                        restaurantA,
                        installationId,
                      ]
                    );

                    await enqueue({
                      eventType:
                        "attack.atomic-success",

                      entityType:
                        "attack_order",

                      entityId:
                        "A100",

                      idempotencyKey:
                        outboxKey,

                      payload: {
                        order:
                          "A100",
                      },
                    });

                    return {
                      responseStatus:
                        201,

                      responseBody: {
                        ok: true,
                        order:
                          "A100",
                      },
                    };
                  },
              });

          const first =
            await run();

          assert.equal(
            first.replayed,
            false
          );

          assert.equal(
            first.responseStatus,
            201
          );

          const second =
            await run();

          assert.equal(
            second.replayed,
            true
          );

          assert.equal(
            second.responseStatus,
            201
          );

          assert.deepEqual(
            second.responseBody,
            {
              ok: true,
              order: "A100",
            }
          );

          assert.equal(
            executions,
            1,
            "Business operation executed twice"
          );

          const eventCount =
            await pool.query(
              `
              SELECT COUNT(*)::int
                AS count
              FROM
                public.edge_outbox
              WHERE
                restaurant_id = $1
                AND
                idempotency_key = $2
              `,
              [
                restaurantA,
                outboxKey,
              ]
            );

          assert.equal(
            eventCount.rows[0]
              .count,
            1
          );

          await expectEdgeError(
            () =>
              withEdgeOperation({
                restaurantId:
                  restaurantA,

                scope:
                  "attack.atomic-success",

                idempotencyKey:
                  operationKey,

                requestPayload: {
                  order:
                    "DIFFERENT",
                },

                execute:
                  async () => ({
                    should:
                      "never run",
                  }),
              }),

            "EDGE_IDEMPOTENCY_CONFLICT"
          );

          console.log(
            "✅ 12 Execute-once + replay response proven"
          );
        }
      );

      // ===================================================
      // CONCURRENT IDEMPOTENT REQUESTS
      // ===================================================

      await t.test(
        "two simultaneous identical operations execute business logic once",
        async () => {
          const operationKey =
            `syncstore-attack-${token}-concurrent-idem`;

          const outboxKey =
            `syncstore-attack-${token}-concurrent-idem-event`;

          let executions = 0;

          async function run() {
            return withEdgeOperation({
              restaurantId:
                restaurantA,

              scope:
                "attack.concurrent-idem",

              idempotencyKey:
                operationKey,

              requestPayload: {
                button:
                  "SEND_ORDER",
                order:
                  "CONCURRENT-1",
              },

              execute:
                async ({
                  enqueueEdgeEvent:
                    enqueue,
                }) => {
                  executions += 1;

                  // Keep the winning transaction open briefly
                  // so the second request collides for real.
                  await sleep(
                    150
                  );

                  await enqueue({
                    eventType:
                      "attack.concurrent-idem",

                    entityType:
                      "attack_order",

                    entityId:
                      "CONCURRENT-1",

                    idempotencyKey:
                      outboxKey,

                    payload: {
                      order:
                        "CONCURRENT-1",
                    },
                  });

                  return {
                    responseStatus:
                      201,

                    responseBody: {
                      accepted:
                        true,
                    },
                  };
                },
            });
          }

          const [
            first,
            second,
          ] =
            await Promise.all([
              run(),
              run(),
            ]);

          assert.equal(
            executions,
            1,
            "Concurrent duplicate request executed twice"
          );

          const replayFlags =
            [
              first.replayed,
              second.replayed,
            ].sort();

          assert.deepEqual(
            replayFlags,
            [
              false,
              true,
            ]
          );

          const outbox =
            await pool.query(
              `
              SELECT COUNT(*)::int
                AS count
              FROM
                public.edge_outbox
              WHERE
                restaurant_id = $1
                AND
                idempotency_key = $2
              `,
              [
                restaurantA,
                outboxKey,
              ]
            );

          assert.equal(
            outbox.rows[0]
              .count,
            1
          );

          console.log(
            "✅ 13 Concurrent idempotency race proven"
          );
        }
      );

      // ===================================================
      // SYNC STATE API
      // ===================================================

      await t.test(
        "sync state API preserves monotonic cursor protection",
        async () => {
          const installationId =
            uuid();

          const initial =
            await ensureSyncState({
              restaurantId:
                restaurantA,

              installationId,
            });

          assert.equal(
            initial.sync_status,
            "unknown"
          );

          const updated =
            await updateSyncState({
              restaurantId:
                restaurantA,

              installationId,

              patch: {
                syncStatus:
                  "syncing",

                pendingOutboxEvents:
                  3,

                pendingInboxEvents:
                  2,

                lastAckedOutboxId:
                  10,

                lastAppliedInboxId:
                  20,
              },
            });

          assert.equal(
            updated.sync_status,
            "syncing"
          );

          assert.equal(
            updated.pending_outbox_events,
            3
          );

          await assert.rejects(
            () =>
              updateSyncState({
                restaurantId:
                  restaurantA,

                installationId,

                patch: {
                  lastAckedOutboxId:
                    9,
                },
              }),

            /cannot move backwards/i
          );

          console.log(
            "✅ 14 Sync-state runtime protection proven"
          );
        }
      );

      console.log("");
      console.log(
        "============================================"
      );
      console.log(
        "✅ MAKS EDGE SYNCSTORE ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );
    } finally {
      // ===================================================
      // CLEANUP
      //
      // Delete only the two random test tenants created
      // above. Edge rows cascade through restaurant FKs.
      // ===================================================

      const idsToDelete =
        [
          restaurantA,
          restaurantB,
        ].filter(
          (value) =>
            Number.isSafeInteger(
              value
            )
        );

      if (
        idsToDelete.length
      ) {
        await pool.query(
          `
          DELETE FROM
            public.restaurants
          WHERE id =
            ANY(
              $1::bigint[]
            )
          `,
          [
            idsToDelete,
          ]
        );
      }

      // Prove no random test restaurants survived.
      const leakedRestaurants =
        await pool.query(
          `
          SELECT COUNT(*)::int
            AS count
          FROM
            public.restaurants
          WHERE name LIKE $1
          `,
          [
            `EDGE SYNCSTORE ATTACK %${token}%`,
          ]
        );

      assert.equal(
        leakedRestaurants.rows[0]
          .count,
        0,
        "Temporary Edge Attack restaurant survived cleanup"
      );

      await pool.end();
    }
  }
);
