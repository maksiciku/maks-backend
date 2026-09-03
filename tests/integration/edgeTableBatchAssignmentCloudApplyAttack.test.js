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
  TABLE_BATCH_ASSIGNMENT_EVENT_TYPE,
  TABLE_BATCH_ASSIGNMENT_SCHEMA_VERSION,
  tableBatchAssignmentDomain,
} = require(
  "../../edge/contracts/tableOperations"
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


function makeAssignmentPayload({
  restaurantId,
  batchId,
  revision,
  tableNumber,
  orderType,
  pickupNumber,
  schemaVersion =
    TABLE_BATCH_ASSIGNMENT_SCHEMA_VERSION,
}) {
  return {
    schema_version:
      schemaVersion,

    restaurant_id:
      restaurantId,

    revision,

    batch_id:
      batchId,

    assignment: {
      table_number:
        tableNumber,

      order_type:
        orderType,

      pickup_number:
        pickupNumber,
    },
  };
}


function makeAssignmentEvent({
  restaurantId,
  payload,
  eventId =
    uuid(),
}) {
  const batchId =
    String(
      payload.batch_id
    )
      .trim()
      .toLowerCase();

  return {
    event_id:
      eventId,

    restaurant_id:
      restaurantId,

    event_type:
      TABLE_BATCH_ASSIGNMENT_EVENT_TYPE,

    entity_type:
      "order_batch",

    entity_id:
      batchId,

    idempotency_key:
      `${TABLE_BATCH_ASSIGNMENT_EVENT_TYPE}:${batchId}:${payload.revision}`,

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


async function loadPhysicalTable(
  restaurantId,
  tableId
) {
  return qGet(
    `
    SELECT
      id,
      restaurant_id,
      name,
      status

    FROM
      public.tables

    WHERE
      restaurant_id = $1
      AND id = $2

    LIMIT 1
    `,
    [
      restaurantId,
      tableId,
    ]
  );
}


async function createSecondPhysicalTable(
  restaurantId
) {
  return qGet(
    `
    INSERT INTO public.tables
    (
      name,
      seats,
      restaurant_id,
      status
    )

    VALUES
    (
      'TEST-A-2',
      4,
      $1,
      'free'
    )

    RETURNING
      id,
      restaurant_id,
      name,
      status
    `,
    [
      restaurantId,
    ]
  );
}


async function insertBatch({
  restaurantId,
  batchId,
  tableNumber,
  orderType =
    "dine-in",
  pickupNumber =
    null,
}) {
  await qRun(
    `
    INSERT INTO public.order_batches
    (
      id,
      restaurant_id,
      table_number,
      order_type,
      pickup_number
    )

    VALUES
    (
      $1::uuid,
      $2,
      $3,
      $4,
      $5
    )
    `,
    [
      batchId,
      restaurantId,
      tableNumber,
      orderType,
      pickupNumber,
    ]
  );
}


async function insertPosRow({
  restaurantId,
  batchId,
  tableNumber,
  itemName,
  paid =
    0,
  remainingPrice =
    12.50,
}) {
  await qRun(
    `
    INSERT INTO public.pos_orders
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
      $4,
      $5,
      'pos',
      $6::uuid,
      'meal'
    )
    `,
    [
      restaurantId,
      tableNumber,
      itemName,
      paid,
      remainingPrice,
      batchId,
    ]
  );
}


async function insertActiveBatch({
  restaurantId,
  batchId,
  tableNumber,
  itemName,
}) {
  await insertBatch({
    restaurantId,
    batchId,
    tableNumber,
  });

  await insertPosRow({
    restaurantId,
    batchId,
    tableNumber,
    itemName,
  });
}


async function loadBatch(
  batchId
) {
  return qGet(
    `
    SELECT
      id,
      restaurant_id,
      table_number,
      order_type,
      pickup_number

    FROM
      public.order_batches

    WHERE
      id = $1::uuid

    LIMIT 1
    `,
    [
      batchId,
    ]
  );
}


async function loadPosRow(
  restaurantId,
  batchId,
  itemName
) {
  return qGet(
    `
    SELECT
      id,
      restaurant_id,
      table_number,
      item_name,
      paid,
      remaining_price,
      batch_id

    FROM
      public.pos_orders

    WHERE
      restaurant_id = $1

      AND batch_id =
        $2::uuid

      AND item_name =
        $3

    LIMIT 1
    `,
    [
      restaurantId,
      batchId,
      itemName,
    ]
  );
}


async function loadRevision(
  restaurantId,
  batchId
) {
  return qGet(
    `
    SELECT
      applied_revision,
      applied_payload_hash

    FROM
      public.edge_domain_revisions

    WHERE
      restaurant_id = $1

      AND domain = $2

    LIMIT 1
    `,
    [
      restaurantId,
      tableBatchAssignmentDomain(
        batchId
      ),
    ]
  );
}


async function loadInbox(
  eventId
) {
  return qGet(
    `
    SELECT
      event_id,
      status,
      applied_at,
      apply_attempts

    FROM
      public.edge_inbox

    WHERE
      event_id =
        $1::uuid

    LIMIT 1
    `,
    [
      eventId,
    ]
  );
}


async function countAssignmentOutbox(
  restaurantId
) {
  return qGet(
    `
    SELECT
      COUNT(*)::int
        AS count

    FROM
      public.edge_outbox

    WHERE
      restaurant_id = $1

      AND event_type =
        $2
    `,
    [
      restaurantId,
      TABLE_BATCH_ASSIGNMENT_EVENT_TYPE,
    ]
  );
}


test(
  "MAKS table batch-assignment Cloud materializer attack",
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

    const tableA =
      await loadPhysicalTable(
        restaurantA,
        fixtures.tableA
      );

    const tableB =
      await loadPhysicalTable(
        restaurantB,
        fixtures.tableB
      );

    assert.ok(
      tableA?.id
    );

    assert.ok(
      tableB?.id
    );

    const tableA2 =
      await createSecondPhysicalTable(
        restaurantA
      );

    assert.ok(
      tableA2?.id
    );

    const app =
      express();

    app.use(
      express.json({
        limit:
          "10mb",
      })
    );

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
        'TABLE Assignment Cloud Attack',
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


    const batchMain =
      uuid();

    const batchSecond =
      uuid();


    await insertActiveBatch({
      restaurantId:
        restaurantA,

      batchId:
        batchMain,

      tableNumber:
        tableA.name,

      itemName:
        "TEST Active Main",
    });


    /*
     * Historical paid row deliberately shares the same batch.
     *
     * Assignment replication must NOT move it.
     */
    await insertPosRow({
      restaurantId:
        restaurantA,

      batchId:
        batchMain,

      tableNumber:
        tableA.name,

      itemName:
        "TEST Historical Paid",

      paid:
        1,

      remainingPrice:
        0,
    });


    await insertActiveBatch({
      restaurantId:
        restaurantA,

      batchId:
        batchSecond,

      tableNumber:
        tableA.name,

      itemName:
        "TEST Active Second",
    });


    const rev1Payload =
      makeAssignmentPayload({
        restaurantId:
          restaurantA,

        batchId:
          batchMain,

        revision:
          1,

        tableNumber:
          tableA2.name,

        orderType:
          "dine-in",

        pickupNumber:
          null,
      });

    const rev1Event =
      makeAssignmentEvent({
        restaurantId:
          restaurantA,

        payload:
          rev1Payload,
      });


    try {
      await t.test(
        "physical -> physical moves batch and active POS rows by stable batch UUID",
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

          const batch =
            await loadBatch(
              batchMain
            );

          assert.equal(
            batch.table_number,
            tableA2.name
          );

          assert.equal(
            batch.order_type,
            "dine-in"
          );

          assert.equal(
            batch.pickup_number,
            null
          );

          const active =
            await loadPosRow(
              restaurantA,
              batchMain,
              "TEST Active Main"
            );

          assert.equal(
            active.table_number,
            tableA2.name
          );

          const historical =
            await loadPosRow(
              restaurantA,
              batchMain,
              "TEST Historical Paid"
            );

          assert.equal(
            historical.table_number,
            tableA.name,
            "historical paid POS row was incorrectly moved"
          );

          const revision =
            await loadRevision(
              restaurantA,
              batchMain
            );

          assert.equal(
            Number(
              revision
                ?.applied_revision
            ),
            1
          );

          const inbox =
            await loadInbox(
              rev1Event
                .event_id
            );

          assert.equal(
            inbox?.status,
            "applied"
          );

          console.log(
            "✅ 01 Physical -> physical stable batch assignment materialized"
          );
        }
      );


      await t.test(
        "independent batch UUID uses an independent assignment revision domain",
        async () => {
          const payload =
            makeAssignmentPayload({
              restaurantId:
                restaurantA,

              batchId:
                batchSecond,

              revision:
                1,

              tableNumber:
                tableA2.name,

              orderType:
                "dine-in",

              pickupNumber:
                null,
            });

          const event =
            makeAssignmentEvent({
              restaurantId:
                restaurantA,

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
              .rejected
              .length,
            0
          );

          const secondBatch =
            await loadBatch(
              batchSecond
            );

          assert.equal(
            secondBatch.table_number,
            tableA2.name
          );

          const secondPos =
            await loadPosRow(
              restaurantA,
              batchSecond,
              "TEST Active Second"
            );

          assert.equal(
            secondPos.table_number,
            tableA2.name
          );

          const mainRevision =
            await loadRevision(
              restaurantA,
              batchMain
            );

          const secondRevision =
            await loadRevision(
              restaurantA,
              batchSecond
            );

          assert.equal(
            Number(
              mainRevision
                .applied_revision
            ),
            1
          );

          assert.equal(
            Number(
              secondRevision
                .applied_revision
            ),
            1
          );

          console.log(
            "✅ 02 Independent batch UUID revision domains proven"
          );
        }
      );


      const rev2Payload =
        makeAssignmentPayload({
          restaurantId:
            restaurantA,

          batchId:
            batchMain,

          revision:
            2,

          tableNumber:
            "Takeaway",

          orderType:
            "takeaway",

          pickupNumber:
            41,
        });

      const rev2Event =
        makeAssignmentEvent({
          restaurantId:
            restaurantA,

          payload:
            rev2Payload,
        });


      await t.test(
        "physical -> Takeaway updates order type, pickup and active POS table",
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

          const batch =
            await loadBatch(
              batchMain
            );

          assert.equal(
            batch.table_number,
            "Takeaway"
          );

          assert.equal(
            batch.order_type,
            "takeaway"
          );

          assert.equal(
            Number(
              batch.pickup_number
            ),
            41
          );

          const active =
            await loadPosRow(
              restaurantA,
              batchMain,
              "TEST Active Main"
            );

          assert.equal(
            active.table_number,
            "Takeaway"
          );

          const historical =
            await loadPosRow(
              restaurantA,
              batchMain,
              "TEST Historical Paid"
            );

          assert.equal(
            historical.table_number,
            tableA.name
          );

          console.log(
            "✅ 03 Physical -> Takeaway assignment converged without moving history"
          );
        }
      );


      const rev3Payload =
        makeAssignmentPayload({
          restaurantId:
            restaurantA,

          batchId:
            batchMain,

          revision:
            3,

          tableNumber:
            tableA.name,

          orderType:
            "dine-in",

          pickupNumber:
            null,
        });

      const rev3Event =
        makeAssignmentEvent({
          restaurantId:
            restaurantA,

          payload:
            rev3Payload,
        });


      await t.test(
        "Takeaway -> physical returns batch and active POS rows to real Cloud table",
        async () => {
          const response =
            await pushEvent(
              app,
              credentials,
              rev3Event
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

          const batch =
            await loadBatch(
              batchMain
            );

          assert.equal(
            batch.table_number,
            tableA.name
          );

          assert.equal(
            batch.order_type,
            "dine-in"
          );

          assert.equal(
            batch.pickup_number,
            null
          );

          const active =
            await loadPosRow(
              restaurantA,
              batchMain,
              "TEST Active Main"
            );

          assert.equal(
            active.table_number,
            tableA.name
          );

          const revision =
            await loadRevision(
              restaurantA,
              batchMain
            );

          assert.equal(
            Number(
              revision
                .applied_revision
            ),
            3
          );

          console.log(
            "✅ 04 Takeaway -> physical assignment converged"
          );
        }
      );


      await t.test(
        "exact assignment event replay is idempotent",
        async () => {
          const response =
            await pushEvent(
              app,
              credentials,
              rev3Event
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

          assert.equal(
            response.body
              .acked[0]
              .duplicate,
            true
          );

          const revision =
            await loadRevision(
              restaurantA,
              batchMain
            );

          assert.equal(
            Number(
              revision
                .applied_revision
            ),
            3
          );

          console.log(
            "✅ 05 Exact assignment event replay is idempotent"
          );
        }
      );


      await t.test(
        "same revision with changed assignment fails closed",
        async () => {
          const conflictPayload =
            makeAssignmentPayload({
              restaurantId:
                restaurantA,

              batchId:
                batchMain,

              revision:
                3,

              tableNumber:
                tableA2.name,

              orderType:
                "dine-in",

              pickupNumber:
                null,
            });

          const conflictEvent =
            makeAssignmentEvent({
              restaurantId:
                restaurantA,

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

          const batch =
            await loadBatch(
              batchMain
            );

          assert.equal(
            batch.table_number,
            tableA.name
          );

          const inbox =
            await loadInbox(
              conflictEvent
                .event_id
            );

          assert.equal(
            inbox?.status,
            "received"
          );

          console.log(
            "✅ 06 Same-revision changed assignment conflict fails closed"
          );
        }
      );


      await t.test(
        "stale assignment ACKs after bill becomes paid and has no active dependency",
        async () => {
          await qRun(
            `
            UPDATE public.pos_orders
            SET
              paid = 1,
              remaining_price = 0
            WHERE
              restaurant_id = $1
              AND batch_id = $2::uuid
              AND item_name =
                'TEST Active Main'
            `,
            [
              restaurantA,
              batchMain,
            ]
          );

          const staleEvent =
            makeAssignmentEvent({
              restaurantId:
                restaurantA,

              payload:
                rev2Payload,
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

          const batch =
            await loadBatch(
              batchMain
            );

          assert.equal(
            batch.table_number,
            tableA.name
          );

          assert.equal(
            batch.order_type,
            "dine-in"
          );

          const paid =
            await loadPosRow(
              restaurantA,
              batchMain,
              "TEST Active Main"
            );

          assert.equal(
            Number(
              paid.paid
            ),
            1
          );

          assert.equal(
            paid.table_number,
            tableA.name
          );

          const revision =
            await loadRevision(
              restaurantA,
              batchMain
            );

          assert.equal(
            Number(
              revision
                .applied_revision
            ),
            3
          );

          const inbox =
            await loadInbox(
              staleEvent
                .event_id
            );

          assert.equal(
            inbox?.status,
            "applied"
          );

          console.log(
            "✅ 07 Stale assignment ACKs safely after active bill disappears"
          );
        }
      );


      await t.test(
        "assignment-before-POS remains retryable until both batch and active POS dependency exist",
        async () => {
          const lateBatch =
            uuid();

          const payload =
            makeAssignmentPayload({
              restaurantId:
                restaurantA,

              batchId:
                lateBatch,

              revision:
                1,

              tableNumber:
                tableA2.name,

              orderType:
                "dine-in",

              pickupNumber:
                null,
            });

          const event =
            makeAssignmentEvent({
              restaurantId:
                restaurantA,

              payload,
            });


          const beforeBatch =
            await pushEvent(
              app,
              credentials,
              event
            );

          assert.equal(
            beforeBatch.status,
            200
          );

          assert.equal(
            beforeBatch.body
              .rejected[0]
              .code,
            "EDGE_TABLE_BATCH_REQUIRED"
          );

          let inbox =
            await loadInbox(
              event.event_id
            );

          assert.equal(
            inbox?.status,
            "received"
          );

          let revision =
            await loadRevision(
              restaurantA,
              lateBatch
            );

          assert.equal(
            revision,
            null,
            "dependency failure consumed assignment revision"
          );


          await insertBatch({
            restaurantId:
              restaurantA,

            batchId:
              lateBatch,

            tableNumber:
              tableA.name,
          });


          const beforePos =
            await pushEvent(
              app,
              credentials,
              event
            );

          assert.equal(
            beforePos.status,
            200
          );

          assert.equal(
            beforePos.body
              .rejected[0]
              .code,
            "EDGE_TABLE_BATCH_POS_REQUIRED"
          );

          inbox =
            await loadInbox(
              event.event_id
            );

          assert.equal(
            inbox?.status,
            "received"
          );

          revision =
            await loadRevision(
              restaurantA,
              lateBatch
            );

          assert.equal(
            revision,
            null,
            "POS dependency failure consumed assignment revision"
          );


          await insertPosRow({
            restaurantId:
              restaurantA,

            batchId:
              lateBatch,

            tableNumber:
              tableA.name,

            itemName:
              "TEST Late POS",
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

          const batch =
            await loadBatch(
              lateBatch
            );

          assert.equal(
            batch.table_number,
            tableA2.name
          );

          const pos =
            await loadPosRow(
              restaurantA,
              lateBatch,
              "TEST Late POS"
            );

          assert.equal(
            pos.table_number,
            tableA2.name
          );

          revision =
            await loadRevision(
              restaurantA,
              lateBatch
            );

          assert.equal(
            Number(
              revision
                ?.applied_revision
            ),
            1
          );

          inbox =
            await loadInbox(
              event.event_id
            );

          assert.equal(
            inbox?.status,
            "applied"
          );

          console.log(
            "✅ 08 Assignment-before-POS retries and eventually converges"
          );
        }
      );


      await t.test(
        "foreign tenant batch UUID collision is blocked",
        async () => {
          const collisionBatch =
            uuid();

          await insertActiveBatch({
            restaurantId:
              restaurantB,

            batchId:
              collisionBatch,

            tableNumber:
              tableB.name,

            itemName:
              "TEST Foreign Collision",
          });

          const payload =
            makeAssignmentPayload({
              restaurantId:
                restaurantA,

              batchId:
                collisionBatch,

              revision:
                1,

              tableNumber:
                tableA2.name,

              orderType:
                "dine-in",

              pickupNumber:
                null,
            });

          const event =
            makeAssignmentEvent({
              restaurantId:
                restaurantA,

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
            "EDGE_TABLE_BATCH_TENANT_COLLISION"
          );

          const foreignBatch =
            await loadBatch(
              collisionBatch
            );

          assert.equal(
            Number(
              foreignBatch
                .restaurant_id
            ),
            restaurantB
          );

          assert.equal(
            foreignBatch
              .table_number,
            tableB.name
          );

          const revision =
            await loadRevision(
              restaurantA,
              collisionBatch
            );

          assert.equal(
            revision,
            null
          );

          console.log(
            "✅ 09 Cross-tenant stable batch UUID collision blocked"
          );
        }
      );


      await t.test(
        "foreign physical destination table cannot be used by authenticated tenant",
        async () => {
          const batchId =
            uuid();

          await insertActiveBatch({
            restaurantId:
              restaurantA,

            batchId,

            tableNumber:
              tableA.name,

            itemName:
              "TEST Foreign Destination",
          });

          const payload =
            makeAssignmentPayload({
              restaurantId:
                restaurantA,

              batchId,

              revision:
                1,

              tableNumber:
                tableB.name,

              orderType:
                "dine-in",

              pickupNumber:
                null,
            });

          const event =
            makeAssignmentEvent({
              restaurantId:
                restaurantA,

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
            "EDGE_TABLE_CLOUD_TABLE_REQUIRED"
          );

          const batch =
            await loadBatch(
              batchId
            );

          assert.equal(
            batch.table_number,
            tableA.name
          );

          const pos =
            await loadPosRow(
              restaurantA,
              batchId,
              "TEST Foreign Destination"
            );

          assert.equal(
            pos.table_number,
            tableA.name
          );

          console.log(
            "✅ 10 Foreign tenant physical destination cannot be assigned"
          );
        }
      );


      await t.test(
        "unsupported assignment schema is rejected before durable inbox acceptance",
        async () => {
          const batchId =
            uuid();

          const payload =
            makeAssignmentPayload({
              restaurantId:
                restaurantA,

              batchId,

              revision:
                1,

              tableNumber:
                tableA.name,

              orderType:
                "dine-in",

              pickupNumber:
                null,

              schemaVersion:
                999,
            });

          const event =
            makeAssignmentEvent({
              restaurantId:
                restaurantA,

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
            "EDGE_TABLE_BATCH_SCHEMA_UNSUPPORTED"
          );

          const inbox =
            await loadInbox(
              event.event_id
            );

          assert.equal(
            inbox,
            null
          );

          console.log(
            "✅ 11 Unsupported assignment schema rejected before inbox receipt"
          );
        }
      );


      await t.test(
        "invalid Takeaway assignment state is rejected before inbox acceptance",
        async () => {
          const batchId =
            uuid();

          const payload =
            makeAssignmentPayload({
              restaurantId:
                restaurantA,

              batchId,

              revision:
                1,

              tableNumber:
                "Takeaway",

              orderType:
                "takeaway",

              pickupNumber:
                null,
            });

          const event =
            makeAssignmentEvent({
              restaurantId:
                restaurantA,

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
            "EDGE_TABLE_BATCH_TAKEAWAY_STATE_INVALID"
          );

          const inbox =
            await loadInbox(
              event.event_id
            );

          assert.equal(
            inbox,
            null
          );

          console.log(
            "✅ 12 Invalid Takeaway assignment rejected fail-closed"
          );
        }
      );


      await t.test(
        "Cloud assignment materialization emits zero Edge feedback",
        async () => {
          const outbox =
            await countAssignmentOutbox(
              restaurantA
            );

          assert.equal(
            Number(
              outbox.count
            ),
            0,
            "Cloud assignment materializer emitted Edge feedback"
          );

          console.log(
            "✅ 13 Cloud batch assignment materialization produces zero Edge feedback"
          );
        }
      );


      console.log(
        "========================================================="
      );

      console.log(
        "✅ MAKS TABLE BATCH-ASSIGNMENT CLOUD ATTACK COMPLETE"
      );

      console.log(
        "========================================================="
      );
    } finally {
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
    }
  }
);
