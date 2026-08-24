"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const {
  resetTestData,
} = require("../setup/resetTestData");

const {
  seedTestData,
  TEST_PASSWORD,
} = require("../setup/seedTestData");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

let app;
let pool;
let fixtures;

let tokenA;
let tokenB;

function bearer(token) {
  return `Bearer ${token}`;
}

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function one(sql, params = []) {
  const result =
    await query(sql, params);

  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result =
    await query(sql, params);

  return result.rows || [];
}

function is2xx(status) {
  return status >= 200 &&
    status < 300;
}

async function createOrder({
  token,
  restaurantId,
  mealId,
  tableNumber,
  orderType = "dine-in",
  expectedPrice,
  options,
}) {
  const before =
    await one(
      `
      SELECT
        COALESCE(
          MAX(id),
          0
        )::bigint AS max_id
      FROM public.pos_orders
      WHERE restaurant_id = $1
      `,
      [restaurantId]
    );

  const body = {
    table_number:
      tableNumber,

    order_type:
      orderType,

    source:
      "pos",

    items: [
      {
        meal_id:
          mealId,

        item_source:
          "meals",

        item_type:
          "meals",

        meal_name:
          "KDS ATTACK FAKE NAME",

        quantity:
          1,

        /*
         * Browser tries £0.01 again.
         *
         * This test still goes through the
         * authoritative order path.
         */
        price_per_unit:
          0.01,

        total_price:
          0.01,

        options:
          options ?? {},
      },
    ],
  };

  const res =
    await request(app)
      .post(
        "/orders/grouped"
      )
      .set(
        "Authorization",
        bearer(token)
      )
      .send(body);

  assert.equal(
    res.status,
    201,
    `Failed to create KDS fixture: ${
      res.status
    } ${JSON.stringify(
      res.body
    )}`
  );

  const row =
    await one(
      `
      SELECT
        id,
        restaurant_id,
        batch_id,
        table_number,
        item_name,
        total_price,
        remaining_price,
        paid,
        order_status
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND id > $2
        AND LOWER(
          TRIM(table_number)
        ) =
        LOWER(
          TRIM($3)
        )
      ORDER BY id DESC
      LIMIT 1
      `,
      [
        restaurantId,
        Number(
          before?.max_id || 0
        ),
        tableNumber,
      ]
    );

  assert.ok(row);
  assert.ok(row.batch_id);

  if (
    expectedPrice != null
  ) {
    assert.equal(
      Number(row.total_price),
      Number(expectedPrice)
    );
  }

  return row;
}

async function ackRows({
  restaurantId,
  batchId,
}) {
  return all(
    `
    SELECT
      restaurant_id,
      device_id,
      batch_id,
      station_key,
      acked_at
    FROM public.kds_station_ack
    WHERE restaurant_id = $1
      AND batch_id = $2::uuid
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

async function itemStateRows({
  restaurantId,
  batchId,
}) {
  return all(
    `
    SELECT
      restaurant_id,
      station_key,
      batch_id,
      item_name,
      mods_line,
      is_working,
      is_hidden,
      updated_by_device
    FROM public.kds_item_state
    WHERE restaurant_id = $1
      AND batch_id = $2::uuid
    ORDER BY
      station_key,
      item_name
    `,
    [
      restaurantId,
      batchId,
    ]
  );
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
      "maks_test"
    );

    pool =
      safe.pool;

    /*
     * Keep this attack focused on KDS state,
     * not stock depletion.
     */
    await query(
      `
      UPDATE public.restaurants
      SET
        selling_mode =
          'pos_only',
        stock_deduction_enabled =
          FALSE,
        portion_tracking_mode =
          'off'
      WHERE id IN ($1, $2)
      `,
      [
        fixtures.restaurantA,
        fixtures.restaurantB,
      ]
    );

    ({ app } =
      require("../../server"));

    const loginA =
      await request(app)
        .post("/auth/login")
        .send({
          username:
            "maks_test_owner_a",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      loginA.status,
      200,
      JSON.stringify(
        loginA.body
      )
    );

    tokenA =
      loginA.body?.token;

    assert.ok(tokenA);

    const loginB =
      await request(app)
        .post("/auth/login")
        .send({
          username:
            "maks_test_owner_b",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures.restaurantB,
        });

    assert.equal(
      loginB.status,
      200,
      JSON.stringify(
        loginB.body
      )
    );

    tokenB =
      loginB.body?.token;

    assert.ok(tokenB);
  }
);

test.after(
  async () => {
    if (pool) {
      await pool.end();
    }
  }
);

/*
 * =====================================================
 * 1. SINGLE ACK CROSS-TENANT
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cannot ACK Restaurant A batch",
  async () => {
    const orderA =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 301",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const attack =
      await request(app)
        .post(
          `/kds/live/${orderA.batch_id}/ack`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .set(
          "x-kds-device",
          "attack-device-b"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({});

    assert.ok(
      attack.status >= 400,
      "Foreign tenant ACK succeeded"
    );

    const contamination =
      await ackRows({
        restaurantId:
          fixtures.restaurantB,

        batchId:
          orderA.batch_id,
      });

    assert.equal(
      contamination.length,
      0,
      "Restaurant B manufactured ACK state against Restaurant A batch"
    );
  }
);

/*
 * =====================================================
 * 2. ACK IDEMPOTENCY
 * =====================================================
 */

test(
  "REPLAY: repeating the same ACK creates exactly one ACK row",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 302",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const ack = () =>
      request(app)
        .post(
          `/kds/live/${order.batch_id}/ack`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-kds-device",
          "device-302"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({});

    const first =
      await ack();

    const second =
      await ack();

    assert.ok(
      is2xx(first.status)
    );

    assert.ok(
      is2xx(second.status)
    );

    const rows =
      await ackRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      rows.length,
      1,
      "ACK replay created duplicate database state"
    );
  }
);

/*
 * =====================================================
 * 3. CONCURRENT ACK
 * =====================================================
 */

test(
  "RACE: concurrent identical ACKs still create one row",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 303",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const attack = () =>
      request(app)
        .post(
          `/kds/live/${order.batch_id}/ack`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-kds-device",
          "device-race-303"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({});

    const responses =
      await Promise.all([
        attack(),
        attack(),
        attack(),
        attack(),
      ]);

    for (
      const res of responses
    ) {
      assert.ok(
        is2xx(res.status),
        JSON.stringify(
          res.body
        )
      );
    }

    const rows =
      await ackRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      rows.length,
      1
    );
  }
);

/*
 * =====================================================
 * 4. DEVICE ISOLATION
 * =====================================================
 */

test(
  "KDS ACK state remains isolated per device",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 304",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    for (
      const device of [
        "device-304-a",
        "device-304-b",
      ]
    ) {
      const res =
        await request(app)
          .post(
            `/kds/live/${order.batch_id}/ack`
          )
          .set(
            "Authorization",
            bearer(tokenA)
          )
          .set(
            "x-kds-device",
            device
          )
          .set(
            "x-station-key",
            "meals"
          )
          .send({});

      assert.ok(
        is2xx(res.status)
      );
    }

    const rows =
      await ackRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      rows.length,
      2
    );

    assert.deepEqual(
      new Set(
        rows.map(
          (row) =>
            row.device_id
        )
      ),
      new Set([
        "device-304-a",
        "device-304-b",
      ])
    );
  }
);

/*
 * =====================================================
 * 5. BULK ACK FOREIGN BATCH
 *
 * IMPORTANT:
 * Current code appears to be missing the ownership
 * check used by the single ACK endpoint.
 *
 * If this goes RED, do NOT weaken the test.
 * =====================================================
 */

test(
  "ATTACK: bulk ACK cannot manufacture state against another tenant batch",
  async () => {
    const orderA =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 305",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const attack =
      await request(app)
        .post(
          "/kds/live/ack-bulk"
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .set(
          "x-kds-device",
          "bulk-attacker-b"
        )
        .send({
          rows: [
            {
              batch_id:
                orderA.batch_id,

              stations: [
                "meals",
              ],
            },
          ],
        });

    /*
     * Response status itself is less important
     * than DB integrity here.
     */
    assert.ok(
      attack.status >= 200
    );

    const contamination =
      await ackRows({
        restaurantId:
          fixtures.restaurantB,

        batchId:
          orderA.batch_id,
      });

    assert.equal(
      contamination.length,
      0,
      "BULK ACK CROSS-TENANT CONTAMINATION"
    );
  }
);

/*
 * =====================================================
 * 6. BULK ACK REPLAY
 * =====================================================
 */

test(
  "REPLAY: bulk ACK duplicates remain idempotent",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 306",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const attack =
      await request(app)
        .post(
          "/kds/live/ack-bulk"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-kds-device",
          "bulk-device-306"
        )
        .send({
          rows: [
            {
              batch_id:
                order.batch_id,

              stations: [
                "meals",
                "meals",
                " Meals ",
              ],
            },

            {
              batch_id:
                order.batch_id,

              stations: [
                "meals",
              ],
            },
          ],
        });

    assert.ok(
      is2xx(attack.status),
      JSON.stringify(
        attack.body
      )
    );

    const rows =
      await ackRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      rows.length,
      1
    );
  }
);

/*
 * =====================================================
 * 7. CROSS-TENANT ITEM STATE
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cannot change Restaurant A KDS item state",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 307",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const attack =
      await request(app)
        .put(
          "/kds/live/item-state"
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .set(
          "x-kds-device",
          "item-attacker-b"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({
          batch_id:
            order.batch_id,

          item_name:
            order.item_name,

          mods_line:
            "",

          is_working:
            true,

          is_hidden:
            false,
        });

    assert.ok(
      attack.status >= 400
    );

    const contamination =
      await itemStateRows({
        restaurantId:
          fixtures.restaurantB,

        batchId:
          order.batch_id,
      });

    assert.equal(
      contamination.length,
      0
    );
  }
);

/*
 * =====================================================
 * 8. ITEM STATE UPSERT IDEMPOTENCY
 * =====================================================
 */

test(
  "REPLAY: repeated identical item-state updates create one state row",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 308",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const update = () =>
      request(app)
        .put(
          "/kds/live/item-state"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-kds-device",
          "device-308"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({
          batch_id:
            order.batch_id,

          item_name:
            order.item_name,

          mods_line:
            "",

          is_working:
            true,

          is_hidden:
            false,
        });

    const first =
      await update();

    const second =
      await update();

    assert.ok(
      is2xx(first.status)
    );

    assert.ok(
      is2xx(second.status)
    );

    const rows =
      await itemStateRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      rows.length,
      1
    );

    assert.equal(
      rows[0].is_working,
      true
    );
  }
);

/*
 * =====================================================
 * 9. COMPLETE / RESTORE STATE
 * =====================================================
 */

test(
  "KDS item complete then restore remains reversible",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 309",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const complete =
      await request(app)
        .put(
          "/kds/live/item-state"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-kds-device",
          "device-309"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({
          batch_id:
            order.batch_id,

          item_name:
            order.item_name,

          mods_line:
            "",

          is_working:
            false,

          is_hidden:
            true,
        });

    assert.ok(
      is2xx(complete.status)
    );

    let rows =
      await itemStateRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      rows.length,
      1
    );

    assert.equal(
      rows[0].is_hidden,
      true
    );

    const restore =
      await request(app)
        .post(
          `/kds/live/${order.batch_id}/items/show-all`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          stations: [
            "meals",
          ],
        });

    assert.ok(
      is2xx(restore.status)
    );

    rows =
      await itemStateRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      rows[0].is_hidden,
      false
    );
  }
);

/*
 * =====================================================
 * 10. UNACK FOREIGN BATCH
 * =====================================================
 */

test(
  "ATTACK: foreign unack cannot remove another tenant ACK",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 310",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const ack =
      await request(app)
        .post(
          `/kds/live/${order.batch_id}/ack`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-kds-device",
          "shared-name-device"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({});

    assert.ok(
      is2xx(ack.status)
    );

    const attack =
      await request(app)
        .post(
          `/kds/live/${order.batch_id}/unack`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .set(
          "x-kds-device",
          "shared-name-device"
        )
        .send({
          stations: [
            "meals",
          ],
        });

    assert.ok(
      attack.status >= 200
    );

    const after =
      await ackRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      after.length,
      1,
      "Foreign tenant removed A's ACK"
    );
  }
);

/*
 * =====================================================
 * 11. SHOW-ALL FOREIGN BATCH
 * =====================================================
 */

test(
  "ATTACK: foreign show-all cannot restore another tenant state",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 311",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const complete =
      await request(app)
        .put(
          "/kds/live/item-state"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-kds-device",
          "device-311"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({
          batch_id:
            order.batch_id,

          item_name:
            order.item_name,

          mods_line:
            "",

          is_hidden:
            true,
          is_working:
            false,
        });

    assert.ok(
      is2xx(complete.status)
    );

    const attack =
      await request(app)
        .post(
          `/kds/live/${order.batch_id}/items/show-all`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send({
          stations: [
            "meals",
          ],
        });

    assert.ok(
      attack.status >= 200
    );

    const rows =
      await itemStateRows({
        restaurantId:
          fixtures.restaurantA,

        batchId:
          order.batch_id,
      });

    assert.equal(
      rows.length,
      1
    );

    assert.equal(
      rows[0].is_hidden,
      true,
      "Foreign tenant restored A state"
    );
  }
);

/*
 * =====================================================
 * 12. STAR CROSS-TENANT
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cannot star Restaurant A POS line",
  async () => {
    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "Table 312",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const attack =
      await request(app)
        .patch(
          `/kds/orders/${order.id}/star`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send({
          is_starred:
            true,
        });

    assert.ok(
      attack.status >= 400
    );

    const after =
      await one(
        `
        SELECT
          is_starred
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(order.id),
        ]
      );

    assert.equal(
      !!after.is_starred,
      false
    );
  }
);

/*
 * =====================================================
 * 13. RESEND CROSS-TENANT
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cannot rebuild Restaurant A table KDS ticket",
  async () => {
    const table =
      "Table 313";

    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          table,

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const originalBatch =
      String(
        order.batch_id
      );

    const attack =
      await request(app)
        .post(
          "/orders/kds-resend"
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send({
          table_number:
            table,
        });

    assert.ok(
      attack.status >= 400
    );

    const after =
      await one(
        `
        SELECT
          batch_id
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(order.id),
        ]
      );

    assert.equal(
      String(
        after.batch_id
      ),
      originalBatch
    );
  }
);

/*
 * =====================================================
 * 14. RESEND ORDER TYPE PRESERVATION
 *
 * This may expose a genuine bug:
 * current code hard-codes rebuilt order_batches
 * to dine-in.
 * =====================================================
 */

test(
  "EDGE: KDS rebuild preserves original takeaway order type",
  async () => {
    const table =
      "Takeaway";

    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          table,

        orderType:
          "takeaway",

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const beforeBatch =
      String(
        order.batch_id
      );

    const before =
      await one(
        `
        SELECT
          order_type
        FROM public.order_batches
        WHERE restaurant_id = $1
          AND id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          beforeBatch,
        ]
      );

    assert.equal(
      String(
        before?.order_type
      ).toLowerCase(),
      "takeaway"
    );

    const rebuild =
      await request(app)
        .post(
          "/orders/kds-resend"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          table_number:
            table,
        });

    assert.ok(
      is2xx(rebuild.status),
      JSON.stringify(
        rebuild.body
      )
    );

    const newBatch =
      String(
        rebuild.body?.batch_id ||
        ""
      );

    assert.ok(
      newBatch
    );

    assert.notEqual(
      newBatch,
      beforeBatch
    );

    const after =
      await one(
        `
        SELECT
          order_type
        FROM public.order_batches
        WHERE restaurant_id = $1
          AND id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          newBatch,
        ]
      );

    assert.equal(
      String(
        after?.order_type
      ).toLowerCase(),
      "takeaway",
      "KDS rebuild changed takeaway into dine-in"
    );
  }
);

/*
 * =====================================================
 * 15. RAPID RESEND / REBUILD CONSISTENCY
 * =====================================================
 */

test(
  "RACE: simultaneous KDS rebuild requests leave one authoritative batch",
  async () => {
    const table =
      "Table 315";

    const order =
      await createOrder({
        token:
          tokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          table,

        expectedPrice:
          12.5,

        options: {
          test_side:
            "test_chips",
        },
      });

    const attack = () =>
      request(app)
        .post(
          "/orders/kds-resend"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          table_number:
            table,
        });

    const responses =
      await Promise.all([
        attack(),
        attack(),
      ]);

    for (
      const response of responses
    ) {
      assert.ok(
        response.status >= 200
      );
    }

    const rows =
      await all(
        `
        SELECT
          id,
          batch_id
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND LOWER(
            TRIM(table_number)
          ) =
          LOWER(
            TRIM($2)
          )
          AND COALESCE(
            paid,
            0
          ) = 0
          AND COALESCE(
            remaining_price,
            total_price,
            0
          ) > 0
        `,
        [
          fixtures.restaurantA,
          table,
        ]
      );

    assert.ok(
      rows.length > 0
    );

    const activeBatchIds =
      new Set(
        rows.map(
          (row) =>
            String(
              row.batch_id
            )
        )
      );

    assert.equal(
      activeBatchIds.size,
      1,
      "Concurrent KDS rebuild split the live ticket across batches"
    );

    const activeBatch =
      [...activeBatchIds][0];

    const batch =
      await one(
        `
        SELECT
          id,
          restaurant_id
        FROM public.order_batches
        WHERE restaurant_id = $1
          AND id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          activeBatch,
        ]
      );

    assert.ok(
      batch,
      "POS row points at nonexistent batch after KDS rebuild race"
    );

    /*
     * Old/abandoned batch rows may exist after a race.
     * We deliberately detect that separately.
     */
    const referenced =
      await all(
        `
        SELECT DISTINCT
          batch_id
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND batch_id IS NOT NULL
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const orphanRebuildBatches =
      await all(
        `
        SELECT
          ob.id
        FROM public.order_batches ob
        WHERE ob.restaurant_id = $1
          AND LOWER(
            TRIM(
              ob.table_number
            )
          ) =
          LOWER(
            TRIM($2)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.pos_orders po
            WHERE
              po.restaurant_id =
                ob.restaurant_id
              AND po.batch_id =
                ob.id
          )
        `,
        [
          fixtures.restaurantA,
          table,
        ]
      );

    assert.equal(
      orphanRebuildBatches.length,
      0,
      `Concurrent rebuild created orphan order_batches: ${JSON.stringify(
        orphanRebuildBatches
      )}`
    );

    assert.ok(
      referenced.length > 0
    );

    /*
     * Keep original variable used so lint/debug tools
     * make the fixture relationship obvious.
     */
    assert.ok(
      order.batch_id
    );
  }
);

/*
 * =====================================================
 * 16. FINAL TENANT STATE INVARIANT
 * =====================================================
 */

test(
  "FINAL: no KDS state row points across tenant ownership",
  async () => {
    const badAck =
      await all(
        `
        SELECT
          a.restaurant_id,
          a.batch_id
        FROM public.kds_station_ack a
        LEFT JOIN public.order_batches ob
          ON ob.id =
            a.batch_id
        WHERE
          ob.id IS NULL
          OR
          ob.restaurant_id <>
            a.restaurant_id
        `
      );

    assert.deepEqual(
      badAck,
      [],
      `Cross-tenant/orphan ACK rows detected: ${JSON.stringify(
        badAck
      )}`
    );

    const badState =
      await all(
        `
        SELECT
          s.restaurant_id,
          s.batch_id
        FROM public.kds_item_state s
        LEFT JOIN public.order_batches ob
          ON ob.id =
            s.batch_id
        WHERE
          ob.id IS NULL
          OR
          ob.restaurant_id <>
            s.restaurant_id
        `
      );

    assert.deepEqual(
      badState,
      [],
      `Cross-tenant/orphan KDS item state detected: ${JSON.stringify(
        badState
      )}`
    );
  }
);