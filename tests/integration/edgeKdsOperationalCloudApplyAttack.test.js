"use strict";

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const express =
  require("express");

const request =
  require("supertest");

const test =
  require("node:test");

const {
  assertTestDatabase,
} = require(
  "../safety/assertTestDatabase"
);

const {
  resetTestData,
} = require(
  "../setup/resetTestData"
);

const {
  seedTestData,
} = require(
  "../setup/seedTestData"
);

const originalRuntimeRole =
  process.env
    .MAKS_RUNTIME_ROLE;

process.env
  .MAKS_RUNTIME_ROLE =
  "cloud";

const {
  qAll,
  qGet,
  qRun,
  getPool,
} = require(
  "../../dbCompat"
);

const {
  hashJson,
} = require(
  "../../edge/syncStore"
);

const {
  generateEdgeCredentials,
} = require(
  "../../utils/edgeAuth"
);

const {
  KDS_BATCH_EVENT_TYPE,
  KDS_KITCHEN_EVENT_TYPE,
} = require(
  "../../edge/contracts/kdsOperations"
);

const edgeRoutes =
  require(
    "../../routes/edgeRoutes"
);


function uuid() {
  return crypto
    .randomUUID();
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


function makeBatchPayload({
  restaurantId,
  batchId,
  revision,
  stationAcks = [],
  itemStates = [],
}) {
  return {
    schema_version:
      1,

    restaurant_id:
      restaurantId,

    batch_id:
      batchId,

    revision,

    station_acks:
      stationAcks,

    item_states:
      itemStates,
  };
}


function makeKitchenPayload({
  restaurantId,
  revision,
  isPaused,
  updatedAt =
    new Date()
      .toISOString(),
}) {
  return {
    schema_version:
      1,

    restaurant_id:
      restaurantId,

    revision,

    is_paused:
      isPaused,

    updated_at:
      updatedAt,
  };
}


function makeEvent({
  restaurantId,
  eventType,
  payload,
  eventId =
    uuid(),
}) {
  const isBatch =
    eventType ===
    KDS_BATCH_EVENT_TYPE;

  const entityId =
    isBatch
      ? String(
          payload.batch_id
        )
      : String(
          restaurantId
        );

  const idempotencyKey =
    isBatch
      ? `${KDS_BATCH_EVENT_TYPE}:${payload.batch_id}:${payload.revision}`
      : `${KDS_KITCHEN_EVENT_TYPE}:${payload.revision}`;

  return {
    event_id:
      eventId,

    restaurant_id:
      restaurantId,

    event_type:
      eventType,

    entity_type:
      isBatch
        ? "order_batch"
        : "kitchen_state",

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


async function insertBatch({
  restaurantId,
  batchId,
  tableNumber,
  itemName =
    null,
}) {
  await qRun(
    `
    INSERT INTO
      public.order_batches
    (
      id,
      restaurant_id,
      table_number,
      order_type
    )
    VALUES
    (
      $1::uuid,
      $2,
      $3,
      'dine-in'
    )
    `,
    [
      batchId,
      restaurantId,
      tableNumber,
    ]
  );

  if (
    itemName
  ) {
    await qRun(
      `
      INSERT INTO
        public.pos_orders
      (
        restaurant_id,
        table_number,
        item_name,
        quantity,
        total_price,
        order_status,
        paid,
        remaining_price,
        source,
        batch_id,
        item_type
      )
      VALUES
      (
        $1,
        $2,
        $3,
        1,
        12.50,
        'open',
        0,
        12.50,
        'pos',
        $4::uuid,
        'meal'
      )
      `,
      [
        restaurantId,
        tableNumber,
        itemName,
        batchId,
      ]
    );
  }
}


async function pushEvent(
  app,
  credentials,
  event
) {
  return request(
    app
  )
    .post(
      "/edge/sync/push"
    )
    .set(
      headers(
        credentials
          .installationId,
        credentials
          .secret
      )
    )
    .send({
      events: [
        event,
      ],
    });
}


test(
  "MAKS KDS operational Cloud materializer attack",
  {
    timeout:
      60000,
  },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();

    const fixtures =
      await seedTestData();

    const restaurantA =
      Number(
        fixtures.restaurantA
      );

    const restaurantB =
      Number(
        fixtures.restaurantB
      );

    const app =
      express();

    app.use(
      express.json({
        limit:
          "10mb",
      })
    );

    /*
     * Match the production server request DB adapter.
     * edgeRoutes authenticates the Edge installation
     * through req.qGet, so the focused Supertest app
     * must provide the same request-scoped helpers.
     */
    app.use(
      (
        req,
        _res,
        next
      ) => {
        req.qAll =
          qAll;

        req.qGet =
          qGet;

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

    const credentials =
      generateEdgeCredentials();

    const batchA =
      uuid();

    const batchB =
      uuid();

    await qRun(
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
        'KDS Cloud Apply Attack',
        $3,
        TRUE
      )
      `,
      [
        restaurantA,
        credentials
          .installationId,
        credentials
          .secretHash,
      ]
    );

    await insertBatch({
      restaurantId:
        restaurantA,
      batchId:
        batchA,
      tableNumber:
        "Table KDS-A",
      itemName:
        "TEST Burger A",
    });

    await insertBatch({
      restaurantId:
        restaurantB,
      batchId:
        batchB,
      tableNumber:
        "Table KDS-B",
      itemName:
        "TEST Burger B",
    });

    await qRun(
      `
      INSERT INTO
        public.kds_station_ack
      (
        restaurant_id,
        device_id,
        batch_id,
        station_key
      )
      VALUES
      (
        $1,
        'foreign-device',
        $2::uuid,
        'meals'
      )
      `,
      [
        restaurantB,
        batchB,
      ]
    );

    const rev1Payload =
      makeBatchPayload({
        restaurantId:
          restaurantA,

        batchId:
          batchA,

        revision:
          1,

        stationAcks: [
          {
            device_id:
              "edge-kitchen-a",

            station_key:
              "meals",

            acked_at:
              new Date()
                .toISOString(),
          },
        ],

        itemStates: [
          {
            station_key:
              "meals",

            item_name:
              "TEST Burger A",

            mods_line:
              "",

            is_working:
              true,

            is_hidden:
              false,

            updated_by_device:
              "edge-kitchen-a",

            updated_at:
              new Date()
                .toISOString(),
          },
        ],
      });

    const rev1Event =
      makeEvent({
        restaurantId:
          restaurantA,

        eventType:
          KDS_BATCH_EVENT_TYPE,

        payload:
          rev1Payload,
      });

    try {
      await t.test(
        "valid batch revision materializes authoritative ACK and item state",
        async () => {
          const response =
            await pushEvent(
              app,
              credentials,
              rev1Event
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              ?.rejected
              ?.length,
            0
          );

          assert.equal(
            response.body
              ?.acked
              ?.length,
            1
          );

          const ackRows =
            await qAll(
              `
              SELECT
                device_id,
                station_key
              FROM
                public.kds_station_ack
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
              `,
              [
                restaurantA,
                batchA,
              ]
            );

          assert.deepEqual(
            ackRows.map(
              (row) => ({
                device_id:
                  row.device_id,
                station_key:
                  row.station_key,
              })
            ),
            [
              {
                device_id:
                  "edge-kitchen-a",
                station_key:
                  "meals",
              },
            ]
          );

          const state =
            await qGet(
              `
              SELECT
                is_working,
                is_hidden,
                updated_by_device
              FROM
                public.kds_item_state
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
                AND
                station_key = 'meals'
                AND
                item_name = 'TEST Burger A'
              LIMIT 1
              `,
              [
                restaurantA,
                batchA,
              ]
            );

          assert.ok(
            state
          );

          assert.equal(
            Boolean(
              state.is_working
            ),
            true
          );

          assert.equal(
            Boolean(
              state.is_hidden
            ),
            false
          );

          const revision =
            await qGet(
              `
              SELECT
                applied_revision
              FROM
                public.edge_domain_revisions
              WHERE
                restaurant_id = $1
                AND
                domain = $2
              LIMIT 1
              `,
              [
                restaurantA,
                `kds.batch:${batchA}`,
              ]
            );

          assert.equal(
            Number(
              revision
                ?.applied_revision
            ),
            1
          );

          const inbox =
            await qGet(
              `
              SELECT
                status,
                applied_at
              FROM
                public.edge_inbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                rev1Event
                  .event_id,
              ]
            );

          assert.equal(
            inbox
              ?.status,
            "applied"
          );

          assert.ok(
            inbox
              ?.applied_at
          );

          const foreign =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.kds_station_ack
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
                AND
                device_id =
                  'foreign-device'
              `,
              [
                restaurantB,
                batchB,
              ]
            );

          assert.equal(
            Number(
              foreign.count
            ),
            1
          );

          console.log(
            "✅ 01 Cloud batch KDS revision 1 materialized tenant-safely"
          );
        }
      );

      const rev2Payload =
        makeBatchPayload({
          restaurantId:
            restaurantA,

          batchId:
            batchA,

          revision:
            2,

          stationAcks:
            [],

          itemStates: [
            {
              station_key:
                "meals",

              item_name:
                "TEST Burger A",

              mods_line:
                "",

              is_working:
                false,

              is_hidden:
                true,

              updated_by_device:
                "edge-kitchen-a",

              updated_at:
                new Date()
                  .toISOString(),
            },
          ],
        });

      const rev2Event =
        makeEvent({
          restaurantId:
            restaurantA,

          eventType:
            KDS_BATCH_EVENT_TYPE,

          payload:
            rev2Payload,
        });

      await t.test(
        "newer revision authoritatively replaces the batch snapshot",
        async () => {
          const response =
            await pushEvent(
              app,
              credentials,
              rev2Event
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .rejected
              .length,
            0
          );

          const ackCount =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.kds_station_ack
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
              `,
              [
                restaurantA,
                batchA,
              ]
            );

          assert.equal(
            Number(
              ackCount.count
            ),
            0,
            "UNACK semantics did not remove authoritative Cloud ACK state"
          );

          const state =
            await qGet(
              `
              SELECT
                is_working,
                is_hidden
              FROM
                public.kds_item_state
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
              LIMIT 1
              `,
              [
                restaurantA,
                batchA,
              ]
            );

          assert.equal(
            Boolean(
              state
                ?.is_working
            ),
            false
          );

          assert.equal(
            Boolean(
              state
                ?.is_hidden
            ),
            true
          );

          console.log(
            "✅ 02 Newer KDS snapshot authoritatively replaces ACK/item state"
          );
        }
      );

      await t.test(
        "stale revision is acknowledged but cannot roll Cloud state backward",
        async () => {
          const staleEvent =
            makeEvent({
              restaurantId:
                restaurantA,

              eventType:
                KDS_BATCH_EVENT_TYPE,

              payload:
                rev1Payload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              staleEvent
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .rejected
              .length,
            0
          );

          assert.equal(
            response.body
              .acked
              .length,
            1
          );

          const revision =
            await qGet(
              `
              SELECT
                applied_revision
              FROM
                public.edge_domain_revisions
              WHERE
                restaurant_id = $1
                AND
                domain = $2
              `,
              [
                restaurantA,
                `kds.batch:${batchA}`,
              ]
            );

          assert.equal(
            Number(
              revision
                .applied_revision
            ),
            2
          );

          const state =
            await qGet(
              `
              SELECT
                is_working,
                is_hidden
              FROM
                public.kds_item_state
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
              LIMIT 1
              `,
              [
                restaurantA,
                batchA,
              ]
            );

          assert.equal(
            Boolean(
              state.is_working
            ),
            false
          );

          assert.equal(
            Boolean(
              state.is_hidden
            ),
            true
          );

          const inbox =
            await qGet(
              `
              SELECT status
              FROM public.edge_inbox
              WHERE event_id =
                $1::uuid
              `,
              [
                staleEvent
                  .event_id,
              ]
            );

          assert.equal(
            inbox.status,
            "applied"
          );

          console.log(
            "✅ 03 Stale KDS revision cannot roll Cloud backward"
          );
        }
      );

      await t.test(
        "same revision with changed payload fails closed",
        async () => {
          const conflictPayload =
            makeBatchPayload({
              restaurantId:
                restaurantA,

              batchId:
                batchA,

              revision:
                2,

              stationAcks: [
                {
                  device_id:
                    "malicious-revision-reuse",

                  station_key:
                    "meals",

                  acked_at:
                    new Date()
                      .toISOString(),
                },
              ],

              itemStates:
                rev2Payload
                  .item_states,
            });

          const conflictEvent =
            makeEvent({
              restaurantId:
                restaurantA,

              eventType:
                KDS_BATCH_EVENT_TYPE,

              payload:
                conflictPayload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              conflictEvent
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .acked
              .length,
            0
          );

          assert.equal(
            response.body
              .rejected
              .length,
            1
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_DOMAIN_REVISION_CONFLICT"
          );

          const inbox =
            await qGet(
              `
              SELECT status
              FROM public.edge_inbox
              WHERE event_id =
                $1::uuid
              `,
              [
                conflictEvent
                  .event_id,
              ]
            );

          assert.equal(
            inbox.status,
            "received"
          );

          const ackCount =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.kds_station_ack
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
              `,
              [
                restaurantA,
                batchA,
              ]
            );

          assert.equal(
            Number(
              ackCount.count
            ),
            0
          );

          console.log(
            "✅ 04 Conflicting KDS revision fails closed without business mutation"
          );
        }
      );

      await t.test(
        "KDS event that beats its POS batch safely retries after the batch arrives",
        async () => {
          const lateBatch =
            uuid();

          const payload =
            makeBatchPayload({
              restaurantId:
                restaurantA,

              batchId:
                lateBatch,

              revision:
                1,

              stationAcks: [
                {
                  device_id:
                    "edge-late",

                  station_key:
                    "meals",

                  acked_at:
                    new Date()
                      .toISOString(),
                },
              ],

              itemStates:
                [],
            });

          const event =
            makeEvent({
              restaurantId:
                restaurantA,

              eventType:
                KDS_BATCH_EVENT_TYPE,

              payload,
            });

          const early =
            await pushEvent(
              app,
              credentials,
              event
            );

          assert.equal(
            early.status,
            200
          );

          assert.equal(
            early.body
              .rejected[0]
              .code,
            "EDGE_KDS_BATCH_REQUIRED"
          );

          const received =
            await qGet(
              `
              SELECT status
              FROM public.edge_inbox
              WHERE event_id =
                $1::uuid
              `,
              [
                event.event_id,
              ]
            );

          assert.equal(
            received.status,
            "received"
          );

          await insertBatch({
            restaurantId:
              restaurantA,
            batchId:
              lateBatch,
            tableNumber:
              "Table KDS-LATE",
          });

          const retry =
            await pushEvent(
              app,
              credentials,
              event
            );

          assert.equal(
            retry.status,
            200
          );

          assert.equal(
            retry.body
              .rejected
              .length,
            0
          );

          assert.equal(
            retry.body
              .acked
              .length,
            1
          );

          const ack =
            await qGet(
              `
              SELECT device_id
              FROM public.kds_station_ack
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
              LIMIT 1
              `,
              [
                restaurantA,
                lateBatch,
              ]
            );

          assert.equal(
            ack
              ?.device_id,
            "edge-late"
          );

          console.log(
            "✅ 05 Out-of-order KDS-before-POS delivery safely retries"
          );
        }
      );

      let kitchenRev2Event;

      await t.test(
        "kitchen pause revisions converge and stale pause cannot return",
        async () => {
          const kitchenRev1 =
            makeEvent({
              restaurantId:
                restaurantA,

              eventType:
                KDS_KITCHEN_EVENT_TYPE,

              payload:
                makeKitchenPayload({
                  restaurantId:
                    restaurantA,
                  revision:
                    1,
                  isPaused:
                    true,
                }),
            });

          kitchenRev2Event =
            makeEvent({
              restaurantId:
                restaurantA,

              eventType:
                KDS_KITCHEN_EVENT_TYPE,

              payload:
                makeKitchenPayload({
                  restaurantId:
                    restaurantA,
                  revision:
                    2,
                  isPaused:
                    false,
                }),
            });

          const one =
            await pushEvent(
              app,
              credentials,
              kitchenRev1
            );

          const two =
            await pushEvent(
              app,
              credentials,
              kitchenRev2Event
            );

          const stale =
            await pushEvent(
              app,
              credentials,
              makeEvent({
                restaurantId:
                  restaurantA,

                eventType:
                  KDS_KITCHEN_EVENT_TYPE,

                payload:
                  kitchenRev1
                    .payload,
              })
            );

          assert.equal(
            one.body
              .rejected
              .length,
            0
          );

          assert.equal(
            two.body
              .rejected
              .length,
            0
          );

          assert.equal(
            stale.body
              .rejected
              .length,
            0
          );

          const kitchen =
            await qGet(
              `
              SELECT is_paused
              FROM public.kitchen_state
              WHERE restaurant_id =
                $1
              `,
              [
                restaurantA,
              ]
            );

          assert.equal(
            Boolean(
              kitchen
                ?.is_paused
            ),
            false
          );

          const revision =
            await qGet(
              `
              SELECT applied_revision
              FROM public.edge_domain_revisions
              WHERE
                restaurant_id = $1
                AND
                domain = 'kds.kitchen'
              `,
              [
                restaurantA,
              ]
            );

          assert.equal(
            Number(
              revision
                .applied_revision
            ),
            2
          );

          console.log(
            "✅ 06 Kitchen pause/resume stale-revision protection proven"
          );
        }
      );

      await t.test(
        "identical applied event replay is exactly once",
        async () => {
          const before =
            await qGet(
              `
              SELECT
                apply_attempts,
                status
              FROM
                public.edge_inbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                kitchenRev2Event
                  .event_id,
              ]
            );

          const replay =
            await pushEvent(
              app,
              credentials,
              kitchenRev2Event
            );

          assert.equal(
            replay.status,
            200
          );

          assert.equal(
            replay.body
              .rejected
              .length,
            0
          );

          assert.equal(
            replay.body
              .acked[0]
              .duplicate,
            true
          );

          const after =
            await qGet(
              `
              SELECT
                apply_attempts,
                status
              FROM
                public.edge_inbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                kitchenRev2Event
                  .event_id,
              ]
            );

          assert.equal(
            Number(
              after
                .apply_attempts
            ),
            Number(
              before
                .apply_attempts
            )
          );

          assert.equal(
            after.status,
            "applied"
          );

          console.log(
            "✅ 07 Lost-ACK style KDS replay is exactly once"
          );
        }
      );

      await t.test(
        "authenticated Edge cannot inject another tenant's KDS payload",
        async () => {
          const payload =
            makeKitchenPayload({
              restaurantId:
                restaurantB,
              revision:
                1,
              isPaused:
                true,
            });

          const event =
            makeEvent({
              restaurantId:
                restaurantA,

              eventType:
                KDS_KITCHEN_EVENT_TYPE,

              payload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              event
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .acked
              .length,
            0
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_KDS_TENANT_MISMATCH"
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
                event.event_id,
              ]
            );

          assert.equal(
            Number(
              inbox.count
            ),
            0
          );

          console.log(
            "✅ 08 Cross-tenant KDS payload blocked before inbox"
          );
        }
      );

      await t.test(
        "unsupported KDS schema is rejected before durable inbox acceptance",
        async () => {
          const payload =
            makeKitchenPayload({
              restaurantId:
                restaurantA,
              revision:
                99,
              isPaused:
                true,
            });

          payload.schema_version =
            2;

          const event =
            makeEvent({
              restaurantId:
                restaurantA,

              eventType:
                KDS_KITCHEN_EVENT_TYPE,

              payload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              event
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_KDS_SCHEMA_UNSUPPORTED"
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
                event.event_id,
              ]
            );

          assert.equal(
            Number(
              inbox.count
            ),
            0
          );

          console.log(
            "✅ 09 Unsupported KDS schema rejected before inbox"
          );
        }
      );

      await t.test(
        "foreign batch UUID cannot be materialized into authenticated tenant",
        async () => {
          const payload =
            makeBatchPayload({
              restaurantId:
                restaurantA,

              batchId:
                batchB,

              revision:
                1,

              stationAcks:
                [],

              itemStates:
                [],
            });

          const event =
            makeEvent({
              restaurantId:
                restaurantA,

              eventType:
                KDS_BATCH_EVENT_TYPE,

              payload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              event
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_KDS_BATCH_TENANT_COLLISION"
          );

          const foreign =
            await qGet(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.kds_station_ack
              WHERE
                restaurant_id = $1
                AND
                batch_id = $2::uuid
                AND
                device_id =
                  'foreign-device'
              `,
              [
                restaurantB,
                batchB,
              ]
            );

          assert.equal(
            Number(
              foreign.count
            ),
            1
          );

          console.log(
            "✅ 10 Cross-tenant batch UUID collision fails closed"
          );
        }
      );

      console.log(
        "=========================================================="
      );

      console.log(
        "✅ MAKS KDS OPERATIONAL CLOUD MATERIALIZER ATTACK COMPLETE"
      );

      console.log(
        "=========================================================="
      );
    } finally {
      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

      await resetTestData();

      if (
        originalRuntimeRole ===
        undefined
      ) {
        delete process.env
          .MAKS_RUNTIME_ROLE;
      } else {
        process.env
          .MAKS_RUNTIME_ROLE =
          originalRuntimeRole;
      }

      await getPool()
        .end();
    }
  }
);
