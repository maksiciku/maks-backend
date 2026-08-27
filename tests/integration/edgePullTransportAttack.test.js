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
  enqueueEdgeEvent,
  updateDirectionalSyncState,
} = require(
  "../../edge/syncStore"
);

const {
  pullFromCloudOnce,
} = require(
  "../../edge/pullTransport"
);


const DATABASE_URL =
  String(
    process.env.DATABASE_URL || ""
  ).trim();


function uuid() {
  return crypto.randomUUID();
}


function headers(
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


async function enqueueCloudEvent({
  eventId = uuid(),

  restaurantId,

  payload,

  eventType =
    "cloud.settings.updated",

  entityType =
    "restaurant_settings",

  entityId =
    uuid(),

  suffix =
    uuid(),
}) {
  const row =
    await enqueueEdgeEvent({
      eventId,

      restaurantId,

      eventType,

      entityType,

      entityId,

      idempotencyKey:
        `cloud-pull-attack:${suffix}`,

      payload,
    });

  return row;
}


test(
  "MAKS Cloud to Edge pull transport attack",
  {
    timeout:
      60000,
  },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      "DATABASE_URL is required"
    );


    // =====================================================
    // REAL CLOUD ROUTE HARNESS
    // =====================================================

    const app =
      express();

    app.use(
      express.json({
        limit:
          "1mb",
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
     * Separate Pool object representing the restaurant's
     * Edge-local PostgreSQL connection.
     *
     * It points to maks_test in this Attack only, but it
     * is deliberately independent from dbCompat's pool.
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


    /*
     * Bridge fetch() to the real Express Edge routes.
     *
     * Options let the Attack simulate:
     *
     * - ACK request disappearing before Cloud sees it
     * - tampering with a pull response in transit
     */
    function makeFetchBridge({
      dropAckBeforeCloudOnce =
        false,

      mutatePullBody =
        null,
    } = {}) {
      let ackDropped =
        false;

      return async function fetchBridge(
        url,
        options = {}
      ) {
        const parsedUrl =
          new URL(
            url
          );

        const route =
          parsedUrl.pathname;

        if (
          dropAckBeforeCloudOnce &&
          !ackDropped &&
          route ===
            "/edge/sync/pull/ack"
        ) {
          ackDropped =
            true;

          throw new Error(
            "MAKS_TEST_PULL_ACK_LOST_BEFORE_CLOUD"
          );
        }

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
            route
          );

        for (
          const [
            name,
            value,
          ] of Object.entries(
            options.headers ||
            {}
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

        let responseBody =
          result.body;

        if (
          route ===
            "/edge/sync/pull" &&
          typeof mutatePullBody ===
            "function"
        ) {
          responseBody =
            mutatePullBody(
              JSON.parse(
                JSON.stringify(
                  result.body
                )
              )
            );
        }

        return {
          ok:
            result.status >=
              200 &&
            result.status <
              300,

          status:
            result.status,

          json:
            async () =>
              responseBody,
        };
      };
    }


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
        "REFUSED: Cloud DB must be maks_test"
      );

      const localDb =
        await localPool.query(`
          SELECT
            current_database()
              AS db
        `);

      assert.equal(
        localDb
          .rows?.[0]
          ?.db,
        "maks_test",
        "REFUSED: Edge-local DB must be maks_test"
      );

      console.log(
        "✅ 01 Cloud + Edge-local database guards: maks_test"
      );


      // ===================================================
      // ISOLATED TENANTS + EDGE INSTALLATIONS
      // ===================================================

      const a =
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
            `EDGE PULL ATTACK A ${token}`,
          ]
        );

      const b =
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
            `EDGE PULL ATTACK B ${token}`,
          ]
        );

      restaurantA =
        Number(
          a.id
        );

      restaurantB =
        Number(
          b.id
        );

      edgeA =
        generateEdgeCredentials();

      edgeB =
        generateEdgeCredentials();

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
            `PULL ATTACK A ${token}`,
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
            `PULL ATTACK B ${token}`,
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


      // ===================================================
      // 02 WRONG SECRET
      // ===================================================

      await t.test(
        "wrong Edge secret cannot pull Cloud events",
        async () => {
          const res =
            await http
              .post(
                "/edge/sync/pull"
              )
              .set(
                headers(
                  edgeA.installationId,
                  "wrong-secret"
                )
              )
              .send({
                limit:
                  25,
              });

          assert.equal(
            res.status,
            401
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


      // ===================================================
      // 03 DISABLED INSTALLATION
      // ===================================================

      await t.test(
        "disabled Edge cannot pull Cloud events",
        async () => {
          await qRun(
            `
            UPDATE
              public.restaurant_edge_nodes
            SET
              is_active =
                FALSE
            WHERE
              id = $1
            `,
            [
              edgeA.nodeId,
            ]
          );

          try {
            const res =
              await http
                .post(
                  "/edge/sync/pull"
                )
                .set(
                  headers(
                    edgeA.installationId,
                    edgeA.secret
                  )
                )
                .send({
                  limit:
                    25,
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
                is_active =
                  TRUE
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


      // ===================================================
      // 04 TENANT ISOLATION
      // ===================================================

      await t.test(
        "Restaurant A cannot pull Restaurant B Cloud event",
        async () => {
          const eventId =
            uuid();

          await enqueueCloudEvent({
            eventId,

            restaurantId:
              restaurantB,

            payload: {
              tenant:
                "B only",
            },
          });

          const res =
            await http
              .post(
                "/edge/sync/pull"
              )
              .set(
                headers(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                limit:
                  25,
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
              ?.events?.some(
                (event) =>
                  event
                    ?.event_id ===
                  eventId
              ),
            false
          );

          const row =
            await qGet(
              `
              SELECT
                status
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
            row?.status,
            "pending"
          );

          console.log(
            "✅ 04 Cloud → Edge tenant isolation proven"
          );
        }
      );


      // ===================================================
      // 05 IN-TRANSIT PAYLOAD TAMPERING
      // ===================================================

      await t.test(
        "tampered Cloud payload is rejected locally and never ACKed",
        async () => {
          const eventId =
            uuid();

          await enqueueCloudEvent({
            eventId,

            restaurantId:
              restaurantA,

            payload: {
              value:
                "ORIGINAL",
            },
          });

          const result =
            await pullFromCloudOnce({
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

              fetchImpl:
                makeFetchBridge({
                  mutatePullBody:
                    (body) => {
                      if (
                        body
                          ?.events?.[0]
                      ) {
                        body.events[0]
                          .payload = {
                            value:
                              "TAMPERED",
                          };

                        /*
                         * Deliberately leave original
                         * payload_hash untouched.
                         */
                      }

                      return body;
                    },
                }),
            });

          assert.equal(
            result.success,
            false
          );

          assert.equal(
            result.received,
            0
          );

          assert.equal(
            result.acked,
            0
          );

          assert.equal(
            result.rejected,
            1
          );

          const inbox =
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
              inbox?.count ||
              0
            ),
            0
          );

          const cloud =
            await qGet(
              `
              SELECT
                status
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
            cloud?.status,
            "in_flight"
          );

          /*
           * Remove this intentionally poisoned Attack
           * event so it cannot reappear in later tests.
           */
          await qRun(
            `
            DELETE FROM
              public.edge_outbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

          console.log(
            "✅ 05 Tampered Cloud payload blocked before local storage/ACK"
          );
        }
      );


      // ===================================================
      // 06 REAL CLOUD OUTBOX → LOCAL INBOX → CLOUD ACK
      // ===================================================

      let validAckedEventId =
        null;

      await t.test(
        "durable Cloud event is pulled into local inbox then ACKed",
        async () => {
          const eventId =
            uuid();

          validAckedEventId =
            eventId;

          const payload = {
            schema_version:
              1,

            restaurant_id:
              restaurantA,

            setting:
              "kitchen_display_mode",

            value:
              "compact",
          };

          await enqueueCloudEvent({
            eventId,

            restaurantId:
              restaurantA,

            eventType:
              "cloud.settings.updated",

            entityType:
              "restaurant_settings",

            entityId:
              String(
                restaurantA
              ),

            payload,
          });

          const connectsBefore =
            explicitPoolConnects;

          const result =
            await pullFromCloudOnce({
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

              fetchImpl:
                makeFetchBridge(),
            });

          assert.equal(
            result.success,
            true
          );

          assert.equal(
            result.received,
            1
          );

          assert.equal(
            result.duplicates,
            0
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
            "Explicit Edge-local PostgreSQL pool was not used"
          );

          const cloudRow =
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
            cloudRow?.status,
            "acked"
          );

          assert.ok(
            cloudRow?.acked_at
          );

          const inboxRows =
            await qAll(
              `
              SELECT
                *
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
            inboxRows.length,
            1
          );

          assert.equal(
            Number(
              inboxRows[0]
                .restaurant_id
            ),
            restaurantA
          );

          assert.equal(
            inboxRows[0]
              .source,
            "cloud"
          );

          assert.equal(
            inboxRows[0]
              .source_installation_id,
            null
          );

          assert.equal(
            inboxRows[0]
              .status,
            "received"
          );

          assert.deepEqual(
            inboxRows[0]
              .payload,
            payload
          );

          const state =
            await qGet(
              `
              SELECT
                sync_status,
                pull_status,
                pending_inbox_events
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

          /*
           * Transport is complete, but business-event
           * application has not happened yet.
           */
          assert.equal(
            state?.sync_status,
            "pending"
          );

          assert.equal(
            state?.pull_status,
            "synced"
          );

          assert.equal(
            Number(
              state
                ?.pending_inbox_events ||
              0
            ),
            1
          );

          console.log(
            "✅ 06 Cloud outbox → local inbox → Cloud ACK proven"
          );
        }
      );


      // ===================================================
      // 07 ACK ENDPOINT IDEMPOTENCY
      // ===================================================

      await t.test(
        "repeated pull ACK is harmless",
        async () => {
          assert.ok(
            validAckedEventId
          );

          const res =
            await http
              .post(
                "/edge/sync/pull/ack"
              )
              .set(
                headers(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                event_ids: [
                  validAckedEventId,
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
              ?.acked?.[0]
              ?.event_id,
            validAckedEventId
          );

          assert.equal(
            res.body
              ?.acked?.[0]
              ?.duplicate,
            true
          );

          console.log(
            "✅ 07 Cloud ACK replay is idempotent"
          );
        }
      );


      // ===================================================
      // 08 LOST ACK BEFORE CLOUD
      // ===================================================

      await t.test(
        "lost ACK causes safe Cloud replay with one local copy",
        async () => {
          const eventId =
            uuid();

          const payload = {
            schema_version:
              1,

            lost_ack:
              true,

            restaurant_id:
              restaurantA,
          };

          await enqueueCloudEvent({
            eventId,

            restaurantId:
              restaurantA,

            payload,
          });

          const first =
            await pullFromCloudOnce({
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

              fetchImpl:
                makeFetchBridge({
                  dropAckBeforeCloudOnce:
                    true,
                }),
            });

          assert.equal(
            first.success,
            false
          );

          assert.equal(
            first.received,
            1
          );

          assert.equal(
            first.acked,
            0
          );

          const localAfterLoss =
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
              localAfterLoss
                ?.count ||
              0
            ),
            1
          );

          const cloudAfterLoss =
            await qGet(
              `
              SELECT
                status
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
            cloudAfterLoss?.status,
            "in_flight"
          );

          /*
           * Simulate expiry of Cloud delivery lease.
           * No 31-second sleep required in the Attack.
           */
          await qRun(
            `
            UPDATE
              public.edge_outbox
            SET
              locked_at =
                NOW() -
                INTERVAL '31 seconds'
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

          const retry =
            await pullFromCloudOnce({
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

              fetchImpl:
                makeFetchBridge(),
            });

          assert.equal(
            retry.success,
            true
          );

          assert.equal(
            retry.received,
            1
          );

          assert.equal(
            retry.duplicates,
            1
          );

          assert.equal(
            retry.acked,
            1
          );

          const localFinal =
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
              localFinal?.count ||
              0
            ),
            1
          );

          const cloudFinal =
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
            cloudFinal?.status,
            "acked"
          );

          assert.ok(
            cloudFinal?.acked_at
          );

          console.log(
            "✅ 08 Lost ACK replay recovered with exactly one local event"
          );
        }
      );


      // ===================================================
      // 09 CHANGED REPLAY
      // ===================================================

      await t.test(
        "same Cloud event_id with changed content is rejected locally",
        async () => {
          const eventId =
            uuid();

          const originalPayload = {
            version:
              1,

            value:
              "ORIGINAL",
          };

          await enqueueCloudEvent({
            eventId,

            restaurantId:
              restaurantA,

            payload:
              originalPayload,

            suffix:
              `original:${uuid()}`,
          });

          const first =
            await pullFromCloudOnce({
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

              fetchImpl:
                makeFetchBridge(),
            });

          assert.equal(
            first.success,
            true
          );

          /*
           * Test-only reconstruction of a malicious/
           * corrupted Cloud replay after original ACK.
           */
          await qRun(
            `
            DELETE FROM
              public.edge_outbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

          const changedPayload = {
            version:
              2,

            value:
              "CHANGED",
          };

          await enqueueCloudEvent({
            eventId,

            restaurantId:
              restaurantA,

            payload:
              changedPayload,

            suffix:
              `changed:${uuid()}`,
          });

          const replay =
            await pullFromCloudOnce({
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

              fetchImpl:
                makeFetchBridge(),
            });

          assert.equal(
            replay.success,
            false
          );

          assert.equal(
            replay.acked,
            0
          );

          assert.equal(
            replay.rejected,
            1
          );

          const local =
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
            local?.payload,
            originalPayload
          );

          const cloud =
            await qGet(
              `
              SELECT
                status
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
            cloud?.status,
            "in_flight"
          );

          console.log(
            "✅ 09 Changed Cloud replay blocked; original local payload preserved"
          );
        }
      );



      // ===================================================
      // 10 DIRECTIONAL HEALTH
      // ===================================================

      await t.test(
        "successful pull cannot hide an existing push failure",
        async () => {
          await updateDirectionalSyncState({
            restaurantId:
              restaurantB,

            installationId:
              edgeB.installationId,

            direction:
              "push",

            patch: {
              status:
                "error",

              failureMode:
                "increment",

              lastAttemptAt:
                new Date(),

              lastError:
                "PUSH_STILL_BROKEN",
            },

            pool:
              trackedLocalPool,
          });

          /*
           * Restaurant B still has the Cloud event created
           * by the tenant-isolation Attack. Pulling it here
           * gives us a real successful pull cycle while the
           * opposite direction is deliberately unhealthy.
           */
          const result =
            await pullFromCloudOnce({
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
            state?.pull_status,
            "synced"
          );

          assert.equal(
            state?.push_status,
            "error"
          );

          assert.equal(
            state?.sync_status,
            "error",
            "Successful pull hid push failure"
          );

          assert.match(
            String(
              state?.last_error ||
              ""
            ),
            /Push: PUSH_STILL_BROKEN/
          );

          assert.equal(
            Number(
              state
                ?.push_consecutive_failures ||
              0
            ),
            1
          );

          assert.equal(
            Number(
              state
                ?.pull_consecutive_failures ||
              0
            ),
            0
          );

          await updateDirectionalSyncState({
            restaurantId:
              restaurantB,

            installationId:
              edgeB.installationId,

            direction:
              "push",

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
            "✅ 10 Pull success cannot hide push failure"
          );
        }
      );


      // ===================================================
      // 11 BATCH LIMIT
      // ===================================================

      await t.test(
        "pull batch is bounded",
        async () => {
          const res =
            await http
              .post(
                "/edge/sync/pull"
              )
              .set(
                headers(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .send({
                limit:
                  26,
              });

          assert.equal(
            res.status,
            400
          );

          assert.equal(
            res.body?.code,
            "EDGE_PULL_LIMIT_INVALID"
          );

          console.log(
            "✅ 11 Oversized pull request rejected"
          );
        }
      );


      // ===================================================
      // FINAL PROOFS
      // ===================================================

      assert.ok(
        explicitPoolConnects >
          0,
        "Edge-local explicit PostgreSQL pool was never exercised"
      );

      const crossTenantInbox =
        await qGet(
          `
          SELECT
            COUNT(*)::int
              AS count
          FROM
            public.edge_inbox
          WHERE
            restaurant_id = $1
            AND
            source = 'cloud'
            AND
            payload ->> 'tenant' =
              'B only'
          `,
          [
            restaurantA,
          ]
        );

      assert.equal(
        Number(
          crossTenantInbox
            ?.count ||
          0
        ),
        0
      );

      console.log(
        "✅ 12 Final tenant isolation + explicit local pool proof passed"
      );

      console.log(
        ""
      );

      console.log(
        "=============================================="
      );

      console.log(
        "✅ MAKS CLOUD → EDGE PULL ATTACK COMPLETE"
      );

      console.log(
        "=============================================="
      );
    } finally {
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

      await getPool().end();
    }
  }
);
