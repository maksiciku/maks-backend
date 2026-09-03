"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const express =
  require("express");

const request =
  require("supertest");

const {
  Pool,
} = require("pg");

const {
  qGet,
  qAll,
  qRun,
  getPool,
} = require(
  "../../dbCompat"
);

const edgeRoutes =
  require(
    "../../routes/edgeRoutes"
  );

const {
  generateEdgeCredentials,
} = require(
  "../../utils/edgeAuth"
);

const {
  EdgeSyncError,

  hashJson,

  enqueueEdgeEvent,

  claimOutboxEvents,
  ackOutboxEvent,
  updateDirectionalSyncState,
} = require(
  "../../edge/syncStore"
);

const {
  pushOutboxOnce,
} = require(
  "../../edge/pushTransport"
);


const DATABASE_URL =
  String(
    process.env.DATABASE_URL || ""
  ).trim();


function uuid() {
  return crypto.randomUUID();
}


function edgeHeaders(
  installationId,
  secret
) {
  return {
    "x-edge-installation-id":
      installationId,

    "x-edge-secret":
      secret,
  };
}


function makeEvent({
  eventId =
    uuid(),

  restaurantId,

  payload = {
    test: true,
  },

  eventType =
    "edge.transport.attack.v1",

  entityType =
    "order_batch",

  entityId =
    uuid(),

  idempotencyKey =
    `push-attack:${uuid()}`,
} = {}) {
  return {
    event_id:
      eventId,

    restaurant_id:
      Number(
        restaurantId
      ),

    event_type:
      eventType,

    entity_type:
      entityType,

    entity_id:
      entityId,

    idempotency_key:
      idempotencyKey,

    payload,

    payload_hash:
      hashJson(
        payload
      ),

    created_at:
      new Date()
        .toISOString(),
  };
}


async function expectEdgeError(
  fn,
  code
) {
  let caught =
    null;

  try {
    await fn();
  } catch (error) {
    caught =
      error;
  }

  assert.ok(
    caught,
    `Expected ${code}`
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


test(
  "MAKS Edge push transport attack",
  {
    timeout: 60000,
  },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      "DATABASE_URL is required"
    );

    /*
     * =====================================================
     * CLOUD ROUTE HARNESS
     * =====================================================
     */

    const app =
      express();

    app.use(
      express.json({
        limit: "1mb",
      })
    );

    app.use(
      (
        req,
        _res,
        next
      ) => {
        req.qGet =
          qGet;

        req.qAll =
          qAll;

        req.qRun =
          qRun;

        req.kind =
          "pg";

        next();
      }
    );

    app.use(
      "/edge",
      edgeRoutes
    );

    const http =
      request(app);


    /*
     * Separate Pool object representing the local
     * MAKS Edge database connection.
     *
     * For this focused Attack both pools deliberately
     * point at maks_test, but this object is independent
     * from dbCompat's Cloud/global Pool.
     */
    const localPool =
      new Pool({
        connectionString:
          DATABASE_URL,
      });

    let explicitPoolConnects =
      0;

    const trackedLocalPool = {
      query:
        (...args) =>
          localPool.query(
            ...args
          ),

      connect:
        async () => {
          explicitPoolConnects +=
            1;

          return localPool.connect();
        },
    };


    const token =
      crypto
        .randomBytes(8)
        .toString("hex");

    let restaurantA =
      null;

    let restaurantB =
      null;

    let edgeA =
      null;

    let edgeB =
      null;


    /*
     * Convert a Supertest request into the small
     * Response interface expected by pushOutboxOnce().
     *
     * When dropAckAfterCloud=true, Cloud fully processes
     * and commits the request, then the simulated network
     * loses the response before Edge can see the ACK.
     */
    function makeFetchBridge({
      dropAckAfterCloud =
        false,
    } = {}) {
      let dropped =
        false;

      return async function fetchBridge(
        _url,
        options = {}
      ) {
        let body =
          {};

        try {
          body =
            JSON.parse(
              String(
                options.body ||
                "{}"
              )
            );
        } catch {
          body =
            {};
        }

        let req =
          http.post(
            "/edge/sync/push"
          );

        const headers =
          options.headers ||
          {};

        for (
          const [
            name,
            value,
          ] of Object.entries(
            headers
          )
        ) {
          req =
            req.set(
              name,
              String(value)
            );
        }

        const result =
          await req.send(
            body
          );

        if (
          dropAckAfterCloud &&
          !dropped
        ) {
          dropped =
            true;

          throw new Error(
            "MAKS_TEST_SIMULATED_LOST_ACK"
          );
        }

        return {
          ok:
            result.status >= 200 &&
            result.status < 300,

          status:
            result.status,

          json:
            async () =>
              result.body,
        };
      };
    }


    try {
      // ===================================================
      // 01 DATABASE GUARDS
      // ===================================================

      const cloudDb =
        await qGet(`
          SELECT
            current_database()
              AS db
        `);

      assert.equal(
        cloudDb?.db,
        "maks_test",
        "REFUSED: Cloud Attack database must be maks_test"
      );

      const localDb =
        await localPool.query(`
          SELECT
            current_database()
              AS db
        `);

      assert.equal(
        localDb.rows?.[0]?.db,
        "maks_test",
        "REFUSED: Edge-local Attack database must be maks_test"
      );

      console.log(
        "✅ 01 Cloud + Edge-local database guards: maks_test"
      );


      // ===================================================
      // ISOLATED TENANTS
      // ===================================================

      const createdA =
        await qGet(
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
            `EDGE PUSH ATTACK A ${token}`,
          ]
        );

      const createdB =
        await qGet(
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
            `EDGE PUSH ATTACK B ${token}`,
          ]
        );

      restaurantA =
        Number(
          createdA.id
        );

      restaurantB =
        Number(
          createdB.id
        );

      const credentialsA =
        generateEdgeCredentials();

      const credentialsB =
        generateEdgeCredentials();

      edgeA =
        {
          ...credentialsA,
        };

      edgeB =
        {
          ...credentialsB,
        };

      const nodeA =
        await qGet(
          `
          INSERT INTO
            public.restaurant_edge_nodes
          (
            restaurant_id,
            installation_id,
            edge_name,
            secret_hash,
            is_active
          )
          VALUES
          (
            $1,
            $2::uuid,
            $3,
            $4,
            TRUE
          )
          RETURNING id
          `,
          [
            restaurantA,
            edgeA.installationId,
            `EDGE PUSH ATTACK A ${token}`,
            edgeA.secretHash,
          ]
        );

      const nodeB =
        await qGet(
          `
          INSERT INTO
            public.restaurant_edge_nodes
          (
            restaurant_id,
            installation_id,
            edge_name,
            secret_hash,
            is_active
          )
          VALUES
          (
            $1,
            $2::uuid,
            $3,
            $4,
            TRUE
          )
          RETURNING id
          `,
          [
            restaurantB,
            edgeB.installationId,
            `EDGE PUSH ATTACK B ${token}`,
            edgeB.secretHash,
          ]
        );

      edgeA.nodeId =
        Number(
          nodeA.id
        );

      edgeB.nodeId =
        Number(
          nodeB.id
        );


      await t.test(
        "wrong Edge secret is rejected",
        async () => {
          const event =
            makeEvent({
              restaurantId:
                restaurantA,
            });

          const res =
            await http
              .post(
                "/edge/sync/push"
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  "wrong-secret"
                )
              )
              .send({
                events: [
                  event,
                ],
              });

          assert.equal(
            res.status,
            401
          );

          assert.equal(
            res.body?.success,
            false
          );

          assert.equal(
            res.body?.code,
            "EDGE_AUTH_INVALID"
          );

          console.log(
            "✅ 02 Wrong Edge secret rejected"
          );
        }
      );


      await t.test(
        "disabled Edge is rejected",
        async () => {
          await qRun(
            `
            UPDATE
              public.restaurant_edge_nodes
            SET
              is_active = FALSE
            WHERE
              id = $1
            `,
            [
              edgeA.nodeId,
            ]
          );

          try {
            const event =
              makeEvent({
                restaurantId:
                  restaurantA,
              });

            const res =
              await http
                .post(
                  "/edge/sync/push"
                )
                .set(
                  edgeHeaders(
                    edgeA.installationId,
                    edgeA.secret
                  )
                )
                .send({
                  events: [
                    event,
                  ],
                });

            assert.equal(
              res.status,
              403
            );

            assert.equal(
              res.body?.code,
              "EDGE_DISABLED"
            );

            console.log(
              "✅ 03 Disabled Edge rejected"
            );
          } finally {
            await qRun(
              `
              UPDATE
                public.restaurant_edge_nodes
              SET
                is_active = TRUE
              WHERE
                id = $1
              `,
              [
                edgeA.nodeId,
              ]
            );
          }
        }
      );


      await t.test(
        "authenticated Edge cannot cross tenant boundary",
        async () => {
          const event =
            makeEvent({
              restaurantId:
                restaurantB,
            });

          const res =
            await http
              .post(
                "/edge/sync/push"
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                events: [
                  event,
                ],
              });

          assert.equal(
            res.status,
            200
          );

          assert.equal(
            res.body?.success,
            true
          );

          assert.equal(
            res.body
              ?.rejected?.[0]
              ?.code,
            "EDGE_TENANT_MISMATCH"
          );

          const leaked =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.edge_inbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                event.event_id,
              ]
            );

          assert.equal(
            Number(
              leaked?.count ||
              0
            ),
            0
          );

          console.log(
            "✅ 04 Cross-tenant Edge event rejected with no inbox leak"
          );
        }
      );


      await t.test(
        "payload hash mismatch is rejected",
        async () => {
          const event =
            makeEvent({
              restaurantId:
                restaurantA,

              payload: {
                test:
                  "hash-attack",
              },
            });

          event.payload_hash =
            "0".repeat(
              64
            );

          const res =
            await http
              .post(
                "/edge/sync/push"
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                events: [
                  event,
                ],
              });

          assert.equal(
            res.status,
            200
          );

          assert.equal(
            res.body
              ?.rejected?.[0]
              ?.code,
            "EDGE_PAYLOAD_HASH_MISMATCH"
          );

          const stored =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.edge_inbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                event.event_id,
              ]
            );

          assert.equal(
            Number(
              stored?.count ||
              0
            ),
            0
          );

          console.log(
            "✅ 05 Payload tampering rejected"
          );
        }
      );


      await t.test(
        "pushOutboxOnce moves one durable local event to Cloud and ACKs it",
        async () => {
          const eventId =
            uuid();

          const payload = {
            schema_version:
              1,

            restaurant_id:
              restaurantA,

            batch_id:
              uuid(),

            submission_id:
              uuid(),

            pos_order_ids: [
              101,
              102,
            ],

            order_type:
              "takeaway",

            source:
              "pos",

            table_number:
              "Takeaway",
          };

          await enqueueEdgeEvent({
            eventId,

            restaurantId:
              restaurantA,

            eventType:
              "edge.transport.attack.v1",

            entityType:
              "order_batch",

            entityId:
              payload.batch_id,

            idempotencyKey:
              `push-valid:${eventId}`,

            payload,
          });

          const connectsBefore =
            explicitPoolConnects;

          const result =
            await pushOutboxOnce({
              pool:
                trackedLocalPool,

              cloudUrl:
                "https://maks-cloud.test",

              installationId:
                edgeA.installationId,

              edgeSecret:
                edgeA.secret,

              restaurantId:
                restaurantA,

              workerId:
                `push-valid-${token}`,

              fetchImpl:
                makeFetchBridge(),
            });

          assert.equal(
            result.success,
            true
          );

          assert.equal(
            result.claimed,
            1
          );

          assert.equal(
            result.acked,
            1
          );

          assert.equal(
            result.rejected,
            0
          );

          assert.ok(
            explicitPoolConnects >
              connectsBefore,
            "Explicit Edge-local pool was not used"
          );

          const outbox =
            await qGet(
              `
              SELECT *
              FROM
                public.edge_outbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                eventId,
              ]
            );

          assert.equal(
            outbox?.status,
            "acked"
          );

          assert.ok(
            outbox?.acked_at
          );

          const inbox =
            await qAll(
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

          assert.equal(
            inbox.length,
            1
          );

          assert.equal(
            Number(
              inbox[0]
                .restaurant_id
            ),
            restaurantA
          );

          assert.equal(
            inbox[0]
              .source,
            "edge"
          );

          assert.equal(
            inbox[0]
              .source_installation_id,
            edgeA.installationId
          );

          const state =
            await qGet(
              `
              SELECT *
              FROM
                public.edge_sync_state
              WHERE
                restaurant_id = $1
                AND
                installation_id =
                  $2::uuid
              `,
              [
                restaurantA,
                edgeA.installationId,
              ]
            );

          assert.equal(
            state?.sync_status,
            "synced"
          );

          assert.equal(
            state?.push_status,
            "synced"
          );

          assert.equal(
            Number(
              state
                ?.pending_outbox_events ||
              0
            ),
            0
          );

          console.log(
            "✅ 06 Local outbox → Cloud inbox → ACK proven"
          );
        }
      );


      await t.test(
        "identical Cloud replay is harmless",
        async () => {
          const eventId =
            uuid();

          const payload = {
            replay:
              "same",
          };

          const event =
            makeEvent({
              eventId,

              restaurantId:
                restaurantA,

              payload,
            });

          const first =
            await http
              .post(
                "/edge/sync/push"
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                events: [
                  event,
                ],
              });

          assert.equal(
            first.status,
            200
          );

          assert.equal(
            first.body
              ?.acked?.[0]
              ?.duplicate,
            false
          );

          const replay =
            await http
              .post(
                "/edge/sync/push"
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                events: [
                  event,
                ],
              });

          assert.equal(
            replay.status,
            200
          );

          assert.equal(
            replay.body
              ?.acked?.[0]
              ?.duplicate,
            true
          );

          const rows =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
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

          assert.equal(
            Number(
              rows?.count ||
              0
            ),
            1
          );

          console.log(
            "✅ 07 Identical replay ACKed with one Cloud copy"
          );
        }
      );


      await t.test(
        "same event_id with changed payload is rejected",
        async () => {
          const eventId =
            uuid();

          const original =
            makeEvent({
              eventId,

              restaurantId:
                restaurantA,

              payload: {
                value:
                  "original",
              },
            });

          const first =
            await http
              .post(
                "/edge/sync/push"
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                events: [
                  original,
                ],
              });

          assert.equal(
            first.body
              ?.acked?.length,
            1
          );

          const changedPayload = {
            value:
              "HACKED",
          };

          const changed = {
            ...original,

            payload:
              changedPayload,

            payload_hash:
              hashJson(
                changedPayload
              ),
          };

          const replay =
            await http
              .post(
                "/edge/sync/push"
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                events: [
                  changed,
                ],
              });

          assert.equal(
            replay.status,
            200
          );

          assert.equal(
            replay.body
              ?.rejected?.[0]
              ?.code,
            "EDGE_INBOX_REPLAY_CONFLICT"
          );

          const stored =
            await qGet(
              `
              SELECT
                payload
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

          assert.deepEqual(
            stored?.payload,
            original.payload
          );

          console.log(
            "✅ 08 Changed replay rejected; original Cloud payload preserved"
          );
        }
      );


      await t.test(
        "lost ACK retries safely without duplicating Cloud event",
        async () => {
          const eventId =
            uuid();

          const payload = {
            lost_ack:
              true,

            submission_id:
              uuid(),
          };

          await enqueueEdgeEvent({
            eventId,

            restaurantId:
              restaurantA,

            eventType:
              "edge.transport.attack.v1",

            entityType:
              "order_batch",

            entityId:
              uuid(),

            idempotencyKey:
              `lost-ack:${eventId}`,

            payload,
          });

          const first =
            await pushOutboxOnce({
              pool:
                trackedLocalPool,

              cloudUrl:
                "https://maks-cloud.test",

              installationId:
                edgeA.installationId,

              edgeSecret:
                edgeA.secret,

              restaurantId:
                restaurantA,

              workerId:
                `lost-ack-a-${token}`,

              fetchImpl:
                makeFetchBridge({
                  dropAckAfterCloud:
                    true,
                }),
            });

          assert.equal(
            first.success,
            false
          );

          assert.equal(
            first.error,
            "EDGE_PUSH_CONNECTION_FAILED"
          );

          const afterLoss =
            await qGet(
              `
              SELECT
                status,
                retry_count,
                last_error
              FROM
                public.edge_outbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                eventId,
              ]
            );

          assert.equal(
            afterLoss?.status,
            "failed"
          );

          const cloudAfterLoss =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
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

          assert.equal(
            Number(
              cloudAfterLoss
                ?.count ||
              0
            ),
            1,
            "Cloud did not durably receive event before simulated lost ACK"
          );

          /*
           * Do not sleep through the production backoff.
           * This Attack advances only this isolated event.
           */
          await qRun(
            `
            UPDATE
              public.edge_outbox
            SET
              next_attempt_at =
                NOW()
            WHERE
              event_id =
                $1::uuid
              AND
              restaurant_id = $2
            `,
            [
              eventId,
              restaurantA,
            ]
          );

          const retry =
            await pushOutboxOnce({
              pool:
                trackedLocalPool,

              cloudUrl:
                "https://maks-cloud.test",

              installationId:
                edgeA.installationId,

              edgeSecret:
                edgeA.secret,

              restaurantId:
                restaurantA,

              workerId:
                `lost-ack-b-${token}`,

              fetchImpl:
                makeFetchBridge(),
            });

          assert.equal(
            retry.success,
            true
          );

          assert.equal(
            retry.acked,
            1
          );

          const finalOutbox =
            await qGet(
              `
              SELECT
                status,
                acked_at
              FROM
                public.edge_outbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                eventId,
              ]
            );

          assert.equal(
            finalOutbox?.status,
            "acked"
          );

          assert.ok(
            finalOutbox?.acked_at
          );

          const cloudFinal =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
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

          assert.equal(
            Number(
              cloudFinal?.count ||
              0
            ),
            1
          );

          console.log(
            "✅ 09 Lost ACK replay recovered with exactly one Cloud event"
          );
        }
      );


      await t.test(
        "worker cannot ACK another worker's lease",
        async () => {
          const eventId =
            uuid();

          await enqueueEdgeEvent({
            eventId,

            restaurantId:
              restaurantB,

            eventType:
              "test.worker.ownership",

            entityType:
              "attack",

            entityId:
              uuid(),

            idempotencyKey:
              `worker:${eventId}`,

            payload: {
              worker_attack:
                true,
            },
          });

          const ownerWorker =
            `owner-${token}`;

          const wrongWorker =
            `wrong-${token}`;

          const claimed =
            await claimOutboxEvents({
              restaurantId:
                restaurantB,

              workerId:
                ownerWorker,

              limit:
                1,

              pool:
                trackedLocalPool,
            });

          assert.equal(
            claimed.length,
            1
          );

          assert.equal(
            claimed[0]
              .event_id,
            eventId
          );

          await expectEdgeError(
            () =>
              ackOutboxEvent({
                restaurantId:
                  restaurantB,

                eventId,

                workerId:
                  wrongWorker,

                pool:
                  trackedLocalPool,
              }),

            "EDGE_OUTBOX_NOT_OWNED"
          );

          await ackOutboxEvent({
            restaurantId:
              restaurantB,

            eventId,

            workerId:
              ownerWorker,

            pool:
              trackedLocalPool,
          });

          console.log(
            "✅ 10 Worker lease ownership enforced"
          );
        }
      );



      await t.test(
        "successful push cannot hide an existing pull failure",
        async () => {
          await updateDirectionalSyncState({
            restaurantId:
              restaurantB,

            installationId:
              edgeB.installationId,

            direction:
              "pull",

            patch: {
              status:
                "error",

              failureMode:
                "increment",

              lastAttemptAt:
                new Date(),

              lastError:
                "PULL_STILL_BROKEN",
            },

            pool:
              trackedLocalPool,
          });

          const eventId =
            uuid();

          await enqueueEdgeEvent({
            eventId,

            restaurantId:
              restaurantB,

            eventType:
              "test.directional.push",

            entityType:
              "attack",

            entityId:
              uuid(),

            idempotencyKey:
              `directional-push:${eventId}`,

            payload: {
              directional:
                "push-success-pull-failure",
            },
          });

          const result =
            await pushOutboxOnce({
              pool:
                trackedLocalPool,

              cloudUrl:
                "https://maks-cloud.test",

              installationId:
                edgeB.installationId,

              edgeSecret:
                edgeB.secret,

              restaurantId:
                restaurantB,

              workerId:
                `directional-push-${token}`,

              fetchImpl:
                makeFetchBridge(),
            });

          assert.equal(
            result.success,
            true
          );

          const state =
            (
              await trackedLocalPool.query(
                `
                SELECT
                  sync_status,
                  push_status,
                  pull_status,
                  last_error,
                  push_consecutive_failures,
                  pull_consecutive_failures
                FROM
                  public.edge_sync_state
                WHERE
                  restaurant_id = $1
                  AND installation_id =
                    $2::uuid
                `,
                [
                  restaurantB,
                  edgeB.installationId,
                ]
              )
            ).rows[0];

          assert.equal(
            state?.push_status,
            "synced"
          );

          assert.equal(
            state?.pull_status,
            "error"
          );

          assert.equal(
            state?.sync_status,
            "error",
            "Successful push hid pull failure"
          );

          assert.match(
            String(
              state?.last_error ||
              ""
            ),
            /Pull: PULL_STILL_BROKEN/
          );

          assert.equal(
            Number(
              state
                ?.push_consecutive_failures ||
              0
            ),
            0
          );

          assert.equal(
            Number(
              state
                ?.pull_consecutive_failures ||
              0
            ),
            1
          );

          /*
           * Restore this test tenant's pull direction so
           * later assertions are not contaminated.
           */
          await updateDirectionalSyncState({
            restaurantId:
              restaurantB,

            installationId:
              edgeB.installationId,

            direction:
              "pull",

            patch: {
              status:
                "synced",

              failureMode:
                "reset",

              lastSuccessAt:
                new Date(),

              lastError:
                null,
            },

            pool:
              trackedLocalPool,
          });

          console.log(
            "✅ 11 Push success cannot hide pull failure"
          );
        }
      );


      await t.test(
        "push batch is bounded to 25 events",
        async () => {
          const events =
            Array.from(
              {
                length:
                  26,
              },
              () =>
                makeEvent({
                  restaurantId:
                    restaurantA,
                })
            );

          const res =
            await http
              .post(
                "/edge/sync/push"
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                events,
              });

          assert.equal(
            res.status,
            400
          );

          assert.equal(
            res.body?.code,
            "EDGE_PUSH_BATCH_TOO_LARGE"
          );

          console.log(
            "✅ 12 Oversized push batch rejected"
          );
        }
      );


      // ===================================================
      // FINAL TENANT / SYNC ASSERTIONS
      // ===================================================

      const crossTenant =
        await qGet(
          `
          SELECT
            COUNT(*)::int
              AS count
          FROM
            public.edge_inbox i

          WHERE
            (
              i.restaurant_id = $1
              AND
              i.source_installation_id =
                $2::uuid
            )
            OR
            (
              i.restaurant_id = $3
              AND
              i.source_installation_id =
                $4::uuid
            )
          `,
          [
            restaurantA,
            edgeB.installationId,

            restaurantB,
            edgeA.installationId,
          ]
        );

      assert.equal(
        Number(
          crossTenant?.count ||
          0
        ),
        0
      );

      assert.ok(
        explicitPoolConnects >
          0,
        "Explicit local PostgreSQL pool was never exercised"
      );

      console.log(
        "✅ 13 Final tenant isolation + explicit pool proof passed"
      );

      console.log(
        "=============================================="
      );

      console.log(
        "✅ MAKS EDGE PUSH TRANSPORT ATTACK COMPLETE"
      );

      console.log(
        "=============================================="
      );
    } finally {
      /*
       * Restaurant FK cascades remove this Attack's
       * outbox/inbox/sync-state/Edge-node rows.
       */
      if (
        restaurantA ||
        restaurantB
      ) {
        await qRun(
          `
          DELETE FROM
            public.restaurants
          WHERE
            id =
              ANY(
                $1::bigint[]
              )
          `,
          [
            [
              restaurantA,
              restaurantB,
            ].filter(
              Boolean
            ),
          ]
        );
      }

      await localPool.end();

      /*
       * Close dbCompat pool last because the Cloud
       * route harness uses it.
       */
      await getPool().end();
    }
  }
);
