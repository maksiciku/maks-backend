"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const request =
  require("supertest");

const {
  resetTestData,
} = require(
  "../setup/resetTestData"
);

const {
  seedTestData,
  TEST_PASSWORD,
} = require(
  "../setup/seedTestData"
);

const {
  assertTestDatabase,
} = require(
  "../safety/assertTestDatabase"
);

const {
  KDS_BATCH_EVENT_TYPE,
  KDS_KITCHEN_EVENT_TYPE,
  KDS_KITCHEN_DOMAIN,
  kdsBatchDomain,
} = require(
  "../../edge/contracts/kdsOperations"
);


const originalRuntimeRole =
  process.env
    .MAKS_RUNTIME_ROLE;

process.env
  .MAKS_RUNTIME_ROLE =
  "edge";


let app;
let pool;
let fixtures;
let tokenA;
let tokenB;


function bearer(
  token
) {
  return `Bearer ${token}`;
}


async function one(
  sql,
  params = []
) {
  const result =
    await pool.query(
      sql,
      params
    );

  return (
    result.rows[0] ||
    null
  );
}


async function all(
  sql,
  params = []
) {
  const result =
    await pool.query(
      sql,
      params
    );

  return result.rows;
}


async function createOrder({
  token,
  restaurantId,
  mealId,
  tableNumber,
}) {
  const response =
    await request(
      app
    )
      .post(
        "/orders/grouped"
      )
      .set(
        "Authorization",
        bearer(
          token
        )
      )
      .send({
        order_type:
          "dine-in",

        table_number:
          tableNumber,

        source:
          "pos",

        items: [
          {
            meal_id:
              mealId,

            item_source:
              "meals",

            source:
              "meals",

            item_type:
              "meals",

            category:
              "meals",

            meal_name:
              "KDS EDGE FAKE NAME",

            name:
              "KDS EDGE FAKE NAME",

            quantity:
              1,

            price_per_unit:
              0.01,

            total_price:
              0.01,

            options: {
              test_side:
                "test_chips",
            },
          },
        ],
      });

  assert.equal(
    response.status,
    201,
    `Failed to create KDS Edge fixture: ${
      response.status
    } ${JSON.stringify(
      response.body
    )}`
  );

  const batchId =
    String(
      response.body
        ?.batch_id ||
      ""
    );

  assert.match(
    batchId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  const row =
    await one(
      `
      SELECT
        id,
        batch_id,
        item_name,
        total_price
      FROM
        public.pos_orders
      WHERE
        restaurant_id = $1
        AND batch_id =
          $2::uuid
      ORDER BY
        id DESC
      LIMIT 1
      `,
      [
        restaurantId,
        batchId,
      ]
    );

  assert.ok(
    row,
    "POS row missing for KDS Edge fixture"
  );

  return {
    batchId,
    posOrderId:
      Number(
        row.id
      ),
    itemName:
      String(
        row.item_name
      ),
  };
}


async function batchEvents(
  restaurantId,
  batchId
) {
  return all(
    `
    SELECT
      event_id,
      entity_id,
      payload,
      status
    FROM
      public.edge_outbox
    WHERE
      restaurant_id = $1
      AND event_type = $2
      AND entity_id = $3
    ORDER BY
      id ASC
    `,
    [
      restaurantId,
      KDS_BATCH_EVENT_TYPE,
      batchId,
    ]
  );
}


async function kitchenEvents(
  restaurantId
) {
  return all(
    `
    SELECT
      event_id,
      payload,
      status
    FROM
      public.edge_outbox
    WHERE
      restaurant_id = $1
      AND event_type = $2
    ORDER BY
      id ASC
    `,
    [
      restaurantId,
      KDS_KITCHEN_EVENT_TYPE,
    ]
  );
}


async function domainRow(
  restaurantId,
  domain
) {
  return one(
    `
    SELECT
      produced_revision,
      applied_revision
    FROM
      public.edge_domain_revisions
    WHERE
      restaurant_id = $1
      AND domain = $2
    LIMIT 1
    `,
    [
      restaurantId,
      domain,
    ]
  );
}


async function ackRows(
  restaurantId,
  batchId
) {
  return all(
    `
    SELECT
      device_id,
      station_key,
      acked_at
    FROM
      public.kds_station_ack
    WHERE
      restaurant_id = $1
      AND batch_id =
        $2::uuid
    ORDER BY
      device_id,
      station_key
    `,
    [
      restaurantId,
      batchId,
    ]
  );
}


async function itemStateRows(
  restaurantId,
  batchId
) {
  return all(
    `
    SELECT
      station_key,
      item_name,
      mods_line,
      is_working,
      is_hidden,
      updated_by_device,
      updated_at
    FROM
      public.kds_item_state
    WHERE
      restaurant_id = $1
      AND batch_id =
        $2::uuid
    ORDER BY
      station_key,
      item_name,
      mods_line
    `,
    [
      restaurantId,
      batchId,
    ]
  );
}


async function removeFailureTrigger() {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_kds_edge
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_kds_edge()
  `);
}


test.before(
  async () => {
    await resetTestData();

    fixtures =
      await seedTestData();

    const safe =
      await assertTestDatabase();

    assert.equal(
      safe.database,
      "maks_test",
      "REFUSED: KDS Edge producer Attack may run only against maks_test"
    );

    pool =
      safe.pool;

    console.log(
      "✅ 01 Database guard: maks_test"
    );

    await pool.query(
      `
      UPDATE
        public.restaurants
      SET
        selling_mode =
          'pos_only',
        stock_deduction_enabled =
          FALSE,
        portion_tracking_mode =
          'off'
      WHERE
        id IN (
          $1,
          $2
        )
      `,
      [
        fixtures
          .restaurantA,
        fixtures
          .restaurantB,
      ]
    );

    await removeFailureTrigger();

    ({
      app,
    } =
      require(
        "../../server"
      ));

    const loginA =
      await request(
        app
      )
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_test_owner_a",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures
              .restaurantA,
        });

    assert.equal(
      loginA.status,
      200,
      JSON.stringify(
        loginA.body
      )
    );

    tokenA =
      loginA.body
        ?.token;

    assert.ok(
      tokenA
    );

    const loginB =
      await request(
        app
      )
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_test_owner_b",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures
              .restaurantB,
        });

    assert.equal(
      loginB.status,
      200,
      JSON.stringify(
        loginB.body
      )
    );

    tokenB =
      loginB.body
        ?.token;

    assert.ok(
      tokenB
    );

    console.log(
      "✅ 02 Real KDS owners authenticated"
    );
  }
);


test.after(
  async () => {
    process.env
      .MAKS_RUNTIME_ROLE =
      "edge";

    if (
      pool
    ) {
      try {
        await removeFailureTrigger();
      } catch {}

      try {
        await resetTestData();
      } catch {}

      try {
        await pool.end();
      } catch {}
    }

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
);


test(
  "MAKS KDS Edge operational producer attack",
  {
    timeout:
      90000,
  },
  async (t) => {
    let primary =
      null;

    await t.test(
      "ACK commits state + revision + authoritative batch snapshot together",
      async () => {
        primary =
          await createOrder({
            token:
              tokenA,

            restaurantId:
              fixtures
                .restaurantA,

            mealId:
              fixtures
                .mealA,

            tableNumber:
              "Table KDS EDGE 401",
          });

        const ack =
          await request(
            app
          )
            .post(
              `/kds/live/${primary.batchId}/ack`
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .set(
              "x-kds-device",
              "edge-kds-device-a"
            )
            .set(
              "x-station-key",
              "meals"
            )
            .send({});

        assert.equal(
          ack.status,
          200,
          JSON.stringify(
            ack.body
          )
        );

        assert.equal(
          Number(
            ack.body
              ?.edge_revision
          ),
          1
        );

        const rows =
          await ackRows(
            fixtures
              .restaurantA,
            primary
              .batchId
          );

        assert.equal(
          rows.length,
          1
        );

        const events =
          await batchEvents(
            fixtures
              .restaurantA,
            primary
              .batchId
          );

        assert.equal(
          events.length,
          1
        );

        const payload =
          events[0]
            .payload;

        assert.equal(
          Number(
            payload
              .schema_version
          ),
          1
        );

        assert.equal(
          Number(
            payload
              .restaurant_id
          ),
          fixtures
            .restaurantA
        );

        assert.equal(
          String(
            payload
              .batch_id
          ),
          primary
            .batchId
        );

        assert.equal(
          Number(
            payload
              .revision
          ),
          1
        );

        assert.equal(
          payload
            .station_acks
            .length,
          1
        );

        assert.equal(
          payload
            .item_states
            .length,
          0
        );

        const domain =
          await domainRow(
            fixtures
              .restaurantA,
            kdsBatchDomain(
              primary
                .batchId
            )
          );

        assert.equal(
          Number(
            domain
              ?.produced_revision
          ),
          1
        );

        console.log(
          "✅ 03 ACK + revision 1 + KDS batch snapshot proven"
        );
      }
    );


    await t.test(
      "working, complete, restore and unack produce monotonic authoritative snapshots",
      async () => {
        const working =
          await request(
            app
          )
            .put(
              "/kds/live/item-state"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .set(
              "x-kds-device",
              "edge-kds-device-a"
            )
            .set(
              "x-station-key",
              "meals"
            )
            .send({
              batch_id:
                primary
                  .batchId,

              item_name:
                primary
                  .itemName,

              mods_line:
                "",

              is_working:
                true,

              is_hidden:
                false,
            });

        assert.equal(
          working.status,
          200,
          JSON.stringify(
            working.body
          )
        );

        assert.equal(
          Number(
            working.body
              ?.edge_revision
          ),
          2
        );

        const complete =
          await request(
            app
          )
            .put(
              "/kds/live/item-state"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .set(
              "x-kds-device",
              "edge-kds-device-a"
            )
            .set(
              "x-station-key",
              "meals"
            )
            .send({
              batch_id:
                primary
                  .batchId,

              item_name:
                primary
                  .itemName,

              mods_line:
                "",

              is_working:
                false,

              is_hidden:
                true,
            });

        assert.equal(
          complete.status,
          200,
          JSON.stringify(
            complete.body
          )
        );

        assert.equal(
          Number(
            complete.body
              ?.edge_revision
          ),
          3
        );

        const restore =
          await request(
            app
          )
            .post(
              `/kds/live/${primary.batchId}/items/show-all`
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send({
              stations: [
                "meals",
              ],
            });

        assert.equal(
          restore.status,
          200,
          JSON.stringify(
            restore.body
          )
        );

        assert.equal(
          Number(
            restore.body
              ?.edge_revision
          ),
          4
        );

        const unack =
          await request(
            app
          )
            .post(
              `/kds/live/${primary.batchId}/unack`
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .set(
              "x-kds-device",
              "edge-kds-device-a"
            )
            .send({
              stations: [
                "meals",
              ],
            });

        assert.equal(
          unack.status,
          200,
          JSON.stringify(
            unack.body
          )
        );

        assert.equal(
          Number(
            unack.body
              ?.edge_revision
          ),
          5
        );

        const events =
          await batchEvents(
            fixtures
              .restaurantA,
            primary
              .batchId
          );

        assert.deepEqual(
          events.map(
            (row) =>
              Number(
                row.payload
                  .revision
              )
          ),
          [
            1,
            2,
            3,
            4,
            5,
          ]
        );

        const latest =
          events[
            events.length - 1
          ].payload;

        assert.equal(
          latest
            .station_acks
            .length,
          0
        );

        assert.equal(
          latest
            .item_states
            .length,
          1
        );

        assert.equal(
          latest
            .item_states[0]
            .is_working,
          false
        );

        assert.equal(
          latest
            .item_states[0]
            .is_hidden,
          false
        );

        const persisted =
          await itemStateRows(
            fixtures
              .restaurantA,
            primary
              .batchId
          );

        assert.equal(
          persisted.length,
          1
        );

        assert.equal(
          persisted[0]
            .is_hidden,
          false
        );

        console.log(
          "✅ 04 KDS working/complete/restore/unack revision ordering proven"
        );
      }
    );


    await t.test(
      "kitchen pause uses an independent restaurant-wide revision stream",
      async () => {
        const paused =
          await request(
            app
          )
            .put(
              "/kds/kitchen/pause-status"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send({
              is_paused:
                true,
            });

        assert.equal(
          paused.status,
          200,
          JSON.stringify(
            paused.body
          )
        );

        assert.equal(
          Number(
            paused.body
              ?.edge_revision
          ),
          1
        );

        const resumed =
          await request(
            app
          )
            .put(
              "/kds/kitchen/pause-status"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send({
              is_paused:
                false,
            });

        assert.equal(
          resumed.status,
          200,
          JSON.stringify(
            resumed.body
          )
        );

        assert.equal(
          Number(
            resumed.body
              ?.edge_revision
          ),
          2
        );

        const events =
          await kitchenEvents(
            fixtures
              .restaurantA
          );

        assert.deepEqual(
          events.map(
            (row) =>
              Number(
                row.payload
                  .revision
              )
          ),
          [
            1,
            2,
          ]
        );

        assert.equal(
          events[0]
            .payload
            .is_paused,
          true
        );

        assert.equal(
          events[1]
            .payload
            .is_paused,
          false
        );

        const domain =
          await domainRow(
            fixtures
              .restaurantA,
            KDS_KITCHEN_DOMAIN
          );

        assert.equal(
          Number(
            domain
              ?.produced_revision
          ),
          2
        );

        console.log(
          "✅ 05 Kitchen pause/resume independent revisions proven"
        );
      }
    );


    await t.test(
      "bulk ACK emits one bounded authoritative snapshot per touched batch",
      async () => {
        const first =
          await createOrder({
            token:
              tokenA,

            restaurantId:
              fixtures
                .restaurantA,

            mealId:
              fixtures
                .mealA,

            tableNumber:
              "Table KDS EDGE 402",
          });

        const second =
          await createOrder({
            token:
              tokenA,

            restaurantId:
              fixtures
                .restaurantA,

            mealId:
              fixtures
                .mealA,

            tableNumber:
              "Table KDS EDGE 403",
          });

        const bulk =
          await request(
            app
          )
            .post(
              "/kds/live/ack-bulk"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .set(
              "x-kds-device",
              "edge-kds-bulk"
            )
            .send({
              rows: [
                {
                  batch_id:
                    first
                      .batchId,

                  stations: [
                    "meals",
                    "meals",
                  ],
                },

                {
                  batch_id:
                    second
                      .batchId,

                  stations: [
                    "meals",
                  ],
                },
              ],
            });

        assert.equal(
          bulk.status,
          200,
          JSON.stringify(
            bulk.body
          )
        );

        assert.equal(
          Number(
            bulk.body
              ?.processed
          ),
          2
        );

        assert.equal(
          bulk.body
            ?.synced_batches
            ?.length,
          2
        );

        for (
          const batch of [
            first,
            second,
          ]
        ) {
          const events =
            await batchEvents(
              fixtures
                .restaurantA,
              batch
                .batchId
            );

          assert.equal(
            events.length,
            1
          );

          assert.equal(
            Number(
              events[0]
                .payload
                .revision
            ),
            1
          );

          assert.equal(
            events[0]
              .payload
              .station_acks
              .length,
            1
          );
        }

        console.log(
          "✅ 06 Bulk ACK per-batch snapshot fan-out proven"
        );
      }
    );


    await t.test(
      "forced KDS outbox failure rolls state + revision + event back together",
      async () => {
        const order =
          await createOrder({
            token:
              tokenA,

            restaurantId:
              fixtures
                .restaurantA,

            mealId:
              fixtures
                .mealA,

            tableNumber:
              "Table KDS EDGE 404",
          });

        await removeFailureTrigger();

        await pool.query(`
          CREATE OR REPLACE FUNCTION
            public.maks_test_reject_kds_edge()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.event_type =
              '${KDS_BATCH_EVENT_TYPE}'
            THEN
              RAISE EXCEPTION
                'MAKS_TEST_FORCED_KDS_OUTBOX_FAILURE';
            END IF;

            RETURN NEW;
          END;
          $$
        `);

        await pool.query(`
          CREATE TRIGGER
            trg_maks_test_reject_kds_edge
          BEFORE INSERT
          ON public.edge_outbox
          FOR EACH ROW
          EXECUTE FUNCTION
            public.maks_test_reject_kds_edge()
        `);

        const failed =
          await request(
            app
          )
            .post(
              `/kds/live/${order.batchId}/ack`
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .set(
              "x-kds-device",
              "edge-kds-rollback"
            )
            .set(
              "x-station-key",
              "meals"
            )
            .send({});

        assert.equal(
          failed.status,
          500,
          JSON.stringify(
            failed.body
          )
        );

        await removeFailureTrigger();

        assert.equal(
          (
            await ackRows(
              fixtures
                .restaurantA,
              order
                .batchId
            )
          ).length,
          0,
          "ACK survived a forced outbox failure"
        );

        assert.equal(
          (
            await batchEvents(
              fixtures
                .restaurantA,
              order
                .batchId
            )
          ).length,
          0,
          "KDS event survived a forced outbox failure"
        );

        const domain =
          await domainRow(
            fixtures
              .restaurantA,
            kdsBatchDomain(
              order
                .batchId
            )
          );

        assert.equal(
          domain,
          null,
          "KDS revision survived a forced outbox failure"
        );

        const retry =
          await request(
            app
          )
            .post(
              `/kds/live/${order.batchId}/ack`
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .set(
              "x-kds-device",
              "edge-kds-rollback"
            )
            .set(
              "x-station-key",
              "meals"
            )
            .send({});

        assert.equal(
          retry.status,
          200,
          JSON.stringify(
            retry.body
          )
        );

        assert.equal(
          Number(
            retry.body
              ?.edge_revision
          ),
          1
        );

        console.log(
          "✅ 07 Forced outbox failure atomic rollback + clean retry proven"
        );
      }
    );


    await t.test(
      "Cloud runtime cannot create Edge-to-Cloud KDS feedback events",
      async () => {
        const order =
          await createOrder({
            token:
              tokenA,

            restaurantId:
              fixtures
                .restaurantA,

            mealId:
              fixtures
                .mealA,

            tableNumber:
              "Table KDS EDGE 405",
          });

        process.env
          .MAKS_RUNTIME_ROLE =
          "cloud";

        try {
          const ack =
            await request(
              app
            )
              .post(
                `/kds/live/${order.batchId}/ack`
              )
              .set(
                "Authorization",
                bearer(
                  tokenA
                )
              )
              .set(
                "x-kds-device",
                "cloud-no-feedback"
              )
              .set(
                "x-station-key",
                "meals"
              )
              .send({});

          assert.equal(
            ack.status,
            200,
            JSON.stringify(
              ack.body
            )
          );

          assert.equal(
            ack.body
              ?.edge_revision,
            null
          );
        } finally {
          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";
        }

        assert.equal(
          (
            await ackRows(
              fixtures
                .restaurantA,
              order
                .batchId
            )
          ).length,
          1
        );

        assert.equal(
          (
            await batchEvents(
              fixtures
                .restaurantA,
              order
                .batchId
            )
          ).length,
          0
        );

        assert.equal(
          await domainRow(
            fixtures
              .restaurantA,
            kdsBatchDomain(
              order
                .batchId
            )
          ),
          null
        );

        console.log(
          "✅ 08 Cloud feedback-loop suppression proven"
        );
      }
    );


    await t.test(
      "foreign tenant cannot manufacture KDS operational events",
      async () => {
        const order =
          await createOrder({
            token:
              tokenA,

            restaurantId:
              fixtures
                .restaurantA,

            mealId:
              fixtures
                .mealA,

            tableNumber:
              "Table KDS EDGE 406",
          });

        const attack =
          await request(
            app
          )
            .post(
              `/kds/live/${order.batchId}/ack`
            )
            .set(
              "Authorization",
              bearer(
                tokenB
              )
            )
            .set(
              "x-kds-device",
              "foreign-kds-device"
            )
            .set(
              "x-station-key",
              "meals"
            )
            .send({});

        assert.ok(
          attack.status >=
            400
        );

        assert.equal(
          (
            await batchEvents(
              fixtures
                .restaurantB,
              order
                .batchId
            )
          ).length,
          0
        );

        assert.equal(
          (
            await ackRows(
              fixtures
                .restaurantB,
              order
                .batchId
            )
          ).length,
          0
        );

        console.log(
          "✅ 09 Cross-tenant KDS producer isolation proven"
        );
      }
    );


    console.log(
      "========================================================"
    );

    console.log(
      "✅ MAKS KDS EDGE OPERATIONAL PRODUCER ATTACK COMPLETE"
    );

    console.log(
      "========================================================"
    );
  }
);
