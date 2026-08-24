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

function auth(token) {
  return `Bearer ${token}`;
}

function is2xx(status) {
  return status >= 200 && status < 300;
}

function money(value) {
  return Number(
    Number(value || 0).toFixed(2)
  );
}

async function query(
  sql,
  params = []
) {
  return pool.query(
    sql,
    params
  );
}

async function one(
  sql,
  params = []
) {
  const result =
    await query(
      sql,
      params
    );

  return result.rows[0] || null;
}

async function all(
  sql,
  params = []
) {
  const result =
    await query(
      sql,
      params
    );

  return result.rows || [];
}

/*
 * =====================================================
 * FIXTURE PAYLOADS
 * =====================================================
 */

function kioskBody(
  mealId,
  extra = {}
) {
  return {
    table_number:
      "Takeaway",

    order_type:
      "takeaway",

    source:
      "kiosk",

    kiosk_payment_method:
      "cash",

    items: [
      {
        meal_id:
          mealId,

        item_source:
          "meals",

        item_type:
          "meals",

        /*
         * Deliberately forged browser identity/price.
         */
        name:
          "FAKE KIOSK ATTACK ITEM",

        meal_name:
          "FAKE KIOSK ATTACK ITEM",

        quantity:
          1,

        price:
          0.01,

        price_per_unit:
          0.01,

        total_price:
          0.01,

        options: {
          test_side:
            "test_chips",
        },

        /*
         * Lifecycle fields the browser must
         * never be authoritative for.
         */
        paid:
          true,

        is_paid:
          true,

        order_status:
          "open",

        expires_at:
          "2099-01-01T00:00:00.000Z",
      },
    ],

    /*
     * More forged top-level lifecycle state.
     */
    paid:
      true,

    is_paid:
      true,

    order_status:
      "open",

    hold_until_paid:
      false,

    ...extra,
  };
}

function qrBody(
  mealId,
  extra = {}
) {
  return {
    order_type:
      "takeaway",

    table_number:
      "Takeaway",

    items: [
      {
        meal_id:
          mealId,

        quantity:
          1,

        name:
          "FAKE PUBLIC QR ITEM",

        price:
          0.01,

        price_per_unit:
          0.01,

        total_price:
          0.01,

        paid:
          true,

        order_status:
          "open",

        expires_at:
          "2099-01-01T00:00:00.000Z",

        options: {
          test_side:
            "test_chips",
        },
      },
    ],

    paid:
      true,

    is_paid:
      true,

    order_status:
      "open",

    hold_until_paid:
      false,

    ...extra,
  };
}

/*
 * =====================================================
 * ORDER HELPERS
 * =====================================================
 */

async function createKioskOrder() {
  const res =
    await request(app)
      .post(
        "/orders/grouped"
      )
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(
        kioskBody(
          fixtures.mealA
        )
      );

  assert.equal(
    res.status,
    201,
    `Kiosk creation failed: ${
      res.status
    } ${JSON.stringify(
      res.body
    )}`
  );

  const batchId =
    String(
      res.body?.batchId ||
      res.body?.batch_id ||
      ""
    );

  assert.ok(
    batchId,
    "Kiosk response missing batch ID"
  );

  const row =
    await one(
      `
      SELECT
        id,
        restaurant_id,
        batch_id,
        source,
        table_number,
        item_name,
        total_price,
        amount_paid,
        remaining_price,
        paid,
        order_status,
        expires_at
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND batch_id = $2::uuid
      ORDER BY id ASC
      LIMIT 1
      `,
      [
        fixtures.restaurantA,
        batchId,
      ]
    );

  assert.ok(row);

  return {
    res,
    batchId,
    row,
  };
}

async function createPublicQrOrder() {
  const res =
    await request(app)
      .post(
        `/public/qr/${fixtures.restaurantA}/order`
      )
      .send(
        qrBody(
          fixtures.mealA
        )
      );

  assert.equal(
    res.status,
    201,
    `Public QR creation failed: ${
      res.status
    } ${JSON.stringify(
      res.body
    )}`
  );

  const batchId =
    String(
      res.body?.batch_id ||
      res.body?.batchId ||
      ""
    );

  assert.ok(
    batchId,
    "QR response missing batch ID"
  );

  const row =
    await one(
      `
      SELECT
        id,
        restaurant_id,
        batch_id,
        source,
        table_number,
        item_name,
        total_price,
        amount_paid,
        remaining_price,
        paid,
        order_status,
        expires_at
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND batch_id = $2::uuid
      ORDER BY id ASC
      LIMIT 1
      `,
      [
        fixtures.restaurantA,
        batchId,
      ]
    );

  assert.ok(row);

  return {
    res,
    batchId,
    row,
  };
}

async function markPaid({
  token,
  row,
  amount = 12.5,
}) {
  return request(app)
    .post(
      "/orders/mark-paid"
    )
    .set(
      "Authorization",
      auth(token)
    )
    .send({
      tableNumber:
        row.table_number,

      itemIds: [
        Number(row.id),
      ],

      paymentMethod:
        "cash",

      payments: [
        {
          method:
            "cash",

          amount,
        },
      ],
    });
}

async function cleanup(
  token
) {
  return request(app)
    .post(
      "/orders/cleanup-pending-qr-kiosk"
    )
    .set(
      "Authorization",
      auth(token)
    )
    .send({});
}

async function posRowById(
  restaurantId,
  id
) {
  return one(
    `
    SELECT
      id,
      restaurant_id,
      batch_id,
      source,
      table_number,
      total_price,
      amount_paid,
      remaining_price,
      paid,
      order_status,
      expires_at
    FROM public.pos_orders
    WHERE restaurant_id = $1
      AND id = $2
    `,
    [
      restaurantId,
      id,
    ]
  );
}

async function kdsRows(
  restaurantId,
  batchId
) {
  return all(
    `
    SELECT
      id,
      restaurant_id,
      batch_id,
      table_number,
      meal_name,
      order_type,
      order_status
    FROM public.orders
    WHERE restaurant_id = $1
      AND batch_id = $2::uuid
    ORDER BY id ASC
    `,
    [
      restaurantId,
      batchId,
    ]
  );
}

async function paymentRowsForOrder(
  restaurantId,
  orderId
) {
  return all(
    `
    SELECT
      id,
      restaurant_id,
      amount,
      status,
      pos_order_ids,
      settlement_id
    FROM public.payments
    WHERE restaurant_id = $1
      AND pos_order_ids @>
          to_jsonb(
            ARRAY[
              $2::bigint
            ]
          )
    ORDER BY id ASC
    `,
    [
      restaurantId,
      orderId,
    ]
  );
}

/*
 * =====================================================
 * SETUP
 * =====================================================
 */

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
      "QR/KIOSK ATTACK REFUSED: wrong database"
    );

    pool =
      safe.pool;

    /*
     * Force the lifecycle behaviour under attack.
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
          'off',

        hold_qr_kiosk_until_paid =
          TRUE
      WHERE id IN ($1, $2)
      `,
      [
        fixtures.restaurantA,
        fixtures.restaurantB,
      ]
    );

    ({ app } =
      require("../../server"));

    assert.ok(app);

    const loginA =
      await request(app)
        .post(
          "/auth/login"
        )
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
        .post(
          "/auth/login"
        )
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
 * 1. KIOSK LIFECYCLE SPOOFING
 * =====================================================
 */

test(
  "ATTACK: kiosk cannot forge paid/open lifecycle state",
  async () => {
    const {
      batchId,
      row,
    } =
      await createKioskOrder();

    assert.equal(
      Number(row.paid),
      0
    );

    assert.equal(
      String(
        row.source
      ).toLowerCase(),
      "kiosk"
    );

    assert.equal(
      String(
        row.order_status
      ).toLowerCase(),
      "pending_payment"
    );

    assert.equal(
      money(
        row.total_price
      ),
      12.5
    );

    assert.equal(
      money(
        row.remaining_price
      ),
      12.5
    );

    assert.ok(
      row.expires_at,
      "Held kiosk order has no expiry"
    );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    assert.equal(
      kds.length,
      0,
      "Unpaid kiosk order reached KDS"
    );
  }
);

/*
 * =====================================================
 * 2. PUBLIC QR LIFECYCLE SPOOFING
 * =====================================================
 */

test(
  "ATTACK: anonymous QR cannot forge paid/open lifecycle state",
  async () => {
    const {
      batchId,
      row,
    } =
      await createPublicQrOrder();

    assert.equal(
      Number(row.paid),
      0
    );

    assert.equal(
      String(
        row.source
      ).toLowerCase(),
      "qr"
    );

    assert.equal(
      String(
        row.order_status
      ).toLowerCase(),
      "pending_payment"
    );

    assert.equal(
      money(
        row.total_price
      ),
      12.5
    );

    assert.ok(
      row.expires_at
    );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    assert.equal(
      kds.length,
      0
    );
  }
);

/*
 * =====================================================
 * 3. NON-EXPIRED ORDER SURVIVES CLEANUP
 * =====================================================
 */

test(
  "LIFECYCLE: cleanup does not delete a live pending kiosk order",
  async () => {
    const {
      row,
    } =
      await createKioskOrder();

    const res =
      await cleanup(
        tokenA
      );

    assert.ok(
      is2xx(
        res.status
      )
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.ok(
      after,
      "Cleanup deleted non-expired pending order"
    );

    assert.equal(
      String(
        after.order_status
      ),
      "pending_payment"
    );
  }
);

/*
 * =====================================================
 * 4. CROSS-TENANT CLEANUP
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cleanup cannot delete Restaurant A expired order",
  async () => {
    const {
      row,
    } =
      await createKioskOrder();

    await query(
      `
      UPDATE public.pos_orders
      SET expires_at =
        NOW() -
        INTERVAL '5 minutes'
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [
        fixtures.restaurantA,
        Number(row.id),
      ]
    );

    const attack =
      await cleanup(
        tokenB
      );

    assert.ok(
      is2xx(
        attack.status
      )
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.ok(
      after,
      "Restaurant B deleted Restaurant A order"
    );
    /*
 * Test isolation:
 *
 * This attack intentionally leaves Restaurant A's
 * expired row untouched. Restore it so the following
 * cleanup test does not legitimately collect this
 * fixture as well.
 */
await query(
  `
  UPDATE public.pos_orders
  SET expires_at =
    NOW() +
    INTERVAL '20 minutes'
  WHERE restaurant_id = $1
    AND id = $2
  `,
  [
    fixtures.restaurantA,
    Number(row.id),
  ]
);
  }
);

/*
 * =====================================================
 * 5. EXPIRED ORDER CLEANUP
 * =====================================================
 */

test(
  "LIFECYCLE: expired unpaid kiosk order is removed with empty batch",
  async () => {
    const {
      batchId,
      row,
    } =
      await createKioskOrder();

    await query(
      `
      UPDATE public.pos_orders
      SET expires_at =
        NOW() -
        INTERVAL '5 minutes'
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [
        fixtures.restaurantA,
        Number(row.id),
      ]
    );

    const res =
      await cleanup(
        tokenA
      );

    assert.ok(
      is2xx(
        res.status
      ),
      JSON.stringify(
        res.body
      )
    );

    assert.equal(
      Number(
        res.body?.deleted ||
        0
      ),
      1
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.equal(
      after,
      null
    );

    const batch =
      await one(
        `
        SELECT id
        FROM public.order_batches
        WHERE restaurant_id = $1
          AND id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          batchId,
        ]
      );

    assert.equal(
      batch,
      null,
      "Cleanup left orphan order_batch"
    );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    assert.equal(
      kds.length,
      0
    );
  }
);

/*
 * =====================================================
 * 6. CLEANUP IDEMPOTENCY
 * =====================================================
 */

test(
  "REPLAY: cleanup is idempotent",
  async () => {
    const {
      row,
    } =
      await createKioskOrder();

    await query(
      `
      UPDATE public.pos_orders
      SET expires_at =
        NOW() -
        INTERVAL '10 minutes'
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [
        fixtures.restaurantA,
        Number(row.id),
      ]
    );

    const first =
      await cleanup(
        tokenA
      );

    assert.ok(
      is2xx(
        first.status
      )
    );

    assert.equal(
      Number(
        first.body?.deleted ||
        0
      ),
      1
    );

    const second =
      await cleanup(
        tokenA
      );

    assert.ok(
      is2xx(
        second.status
      )
    );

    assert.equal(
      Number(
        second.body?.deleted ||
        0
      ),
      0,
      "Cleanup replay changed state twice"
    );
  }
);

/*
 * =====================================================
 * 7. EXPIRED PAYMENT ATTACK
 *
 * IMPORTANT:
 *
 * Current mark-paid locking code does not appear
 * to reject expires_at < NOW().
 *
 * If RED: DO NOT CHANGE THE TEST.
 * =====================================================
 */

test(
  "ATTACK: an already-expired pending kiosk order cannot be paid",
  async () => {
    const {
      batchId,
      row,
    } =
      await createKioskOrder();

    await query(
      `
      UPDATE public.pos_orders
      SET expires_at =
        NOW() -
        INTERVAL '1 minute'
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [
        fixtures.restaurantA,
        Number(row.id),
      ]
    );

    const payment =
      await markPaid({
        token:
          tokenA,

        row,

        amount:
          12.5,
      });

    assert.ok(
      payment.status >= 400,
      `EXPIRED ORDER WAS PAID: ${
        payment.status
      } ${JSON.stringify(
        payment.body
      )}`
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.ok(after);

    assert.equal(
      Number(after.paid),
      0
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      12.5
    );

    const ledger =
      await paymentRowsForOrder(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.equal(
      ledger.length,
      0,
      "Expired order created payment ledger"
    );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    assert.equal(
      kds.length,
      0,
      "Expired order reached KDS"
    );
  }
);

/*
 * =====================================================
 * 8. CROSS-TENANT PAYMENT
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cannot pay Restaurant A pending kiosk order",
  async () => {
    const {
      batchId,
      row,
    } =
      await createKioskOrder();

    const attack =
      await markPaid({
        token:
          tokenB,

        row,

        amount:
          12.5,
      });

    assert.ok(
      attack.status >= 400
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.ok(after);

    assert.equal(
      Number(after.paid),
      0
    );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    assert.equal(
      kds.length,
      0
    );
  }
);

/*
 * =====================================================
 * 9. SUCCESSFUL PAYMENT RELEASE
 * =====================================================
 */

test(
  "LIFECYCLE: valid kiosk payment releases held order exactly once",
  async () => {
    const {
      batchId,
      row,
    } =
      await createKioskOrder();

    const payment =
      await markPaid({
        token:
          tokenA,

        row,

        amount:
          12.5,
      });

    assert.ok(
      is2xx(
        payment.status
      ),
      `${payment.status} ${JSON.stringify(
        payment.body
      )}`
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.equal(
      Number(after.paid),
      1
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      0
    );

    assert.equal(
      String(
        after.order_status
      ).toLowerCase(),
      "open"
    );

    assert.equal(
      after.expires_at,
      null
    );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    assert.equal(
      kds.length,
      1,
      "Successful held payment did not produce exactly one KDS row"
    );
  }
);

/*
 * =====================================================
 * 10. DOUBLE PAYMENT / KDS RELEASE RACE
 * =====================================================
 */

test(
  "RACE: simultaneous payment cannot release kiosk batch into KDS twice",
  async () => {
    const {
      batchId,
      row,
    } =
      await createKioskOrder();

    const attack = () =>
      markPaid({
        token:
          tokenA,

        row,

        amount:
          12.5,
      });

    const [
      first,
      second,
    ] =
      await Promise.all([
        attack(),
        attack(),
      ]);

    const successes =
      [
        first,
        second,
      ].filter(
        (res) =>
          is2xx(
            res.status
          )
      );

    assert.equal(
      successes.length,
      1,
      `Expected one payment success; got ${successes.length}`
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.equal(
      Number(after.paid),
      1
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      0
    );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    assert.equal(
      kds.length,
      1,
      "Concurrent payment released same KDS row more than once"
    );

    const ledger =
      await paymentRowsForOrder(
        fixtures.restaurantA,
        Number(row.id)
      );

    const positive =
      ledger.filter(
        (payment) =>
          Number(
            payment.amount
          ) > 0
      );

    assert.equal(
      positive.length,
      1
    );

    assert.equal(
      money(
        positive[0]
          .amount
      ),
      12.5
    );
  }
);

/*
 * =====================================================
 * 11. CLEANUP VS PAYMENT RACE
 *
 * This tests transactional integrity.
 *
 * Either cleanup wins OR payment wins.
 *
 * What is forbidden:
 * - payment ledger but POS row disappeared
 * - duplicate KDS release
 * - half-paid row
 * =====================================================
 */

test(
  "RACE: cleanup versus payment never leaves half-paid or orphan financial state",
  async () => {
    const {
      batchId,
      row,
    } =
      await createKioskOrder();

    await query(
      `
      UPDATE public.pos_orders
      SET expires_at =
        NOW() -
        INTERVAL '1 second'
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [
        fixtures.restaurantA,
        Number(row.id),
      ]
    );

    const [
      cleanupRes,
      paymentRes,
    ] =
      await Promise.all([
        cleanup(
          tokenA
        ),

        markPaid({
          token:
            tokenA,

          row,

          amount:
            12.5,
        }),
      ]);

    assert.ok(
      cleanupRes.status >=
        200
    );

    assert.ok(
      paymentRes.status >=
        200
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    const ledger =
      await paymentRowsForOrder(
        fixtures.restaurantA,
        Number(row.id)
      );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    /*
     * CLEANUP WON.
     */
    if (!after) {
      assert.equal(
        ledger.length,
        0,
        "POS row was cleaned up but payment ledger exists"
      );

      assert.equal(
        kds.length,
        0,
        "Cleaned-up order reached KDS"
      );

      assert.ok(
        paymentRes.status >=
          400,
        "Payment reported success after cleanup removed order"
      );

      return;
    }

    /*
     * PAYMENT WON.
     *
     * If current code lets an expired payment win,
     * test #7 will already expose that policy defect.
     *
     * Here we care specifically about atomic consistency.
     */
    assert.equal(
      Number(after.paid),
      1
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      0
    );

    assert.equal(
      String(
        after.order_status
      ).toLowerCase(),
      "open"
    );

    assert.equal(
      kds.length,
      1,
      "Payment won race but KDS state is inconsistent"
    );

    const positive =
      ledger.filter(
        (payment) =>
          Number(
            payment.amount
          ) > 0
      );

    assert.equal(
      positive.length,
      1
    );
  }
);

/*
 * =====================================================
 * 12. PAID ORDER IMMUNE TO CLEANUP
 * =====================================================
 */

test(
  "LIFECYCLE: cleanup cannot remove a successfully paid kiosk order",
  async () => {
    const {
      batchId,
      row,
    } =
      await createKioskOrder();

    const payment =
      await markPaid({
        token:
          tokenA,

        row,

        amount:
          12.5,
      });

    assert.ok(
      is2xx(
        payment.status
      )
    );

    /*
     * Even malicious/manual DB damage to expires_at
     * must not make cleanup delete a paid order.
     */
    await query(
      `
      UPDATE public.pos_orders
      SET expires_at =
        NOW() -
        INTERVAL '1 hour'
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [
        fixtures.restaurantA,
        Number(row.id),
      ]
    );

    const clean =
      await cleanup(
        tokenA
      );

    assert.ok(
      is2xx(
        clean.status
      )
    );

    const after =
      await posRowById(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.ok(
      after,
      "Cleanup deleted paid order"
    );

    assert.equal(
      Number(after.paid),
      1
    );

    const kds =
      await kdsRows(
        fixtures.restaurantA,
        batchId
      );

    assert.equal(
      kds.length,
      1
    );
  }
);

/*
 * =====================================================
 * 13. PUBLIC QR CROSS-TENANT ITEM
 * =====================================================
 */

test(
  "ATTACK: anonymous QR Restaurant A cannot nominate Restaurant B meal",
  async () => {
    const before =
      await one(
        `
        SELECT
          COUNT(*)::int
            AS count
        FROM public.pos_orders
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const attack =
      await request(app)
        .post(
          `/public/qr/${fixtures.restaurantA}/order`
        )
        .send(
          qrBody(
            fixtures.mealB
          )
        );

    assert.ok(
      attack.status >=
        400
    );

    const after =
      await one(
        `
        SELECT
          COUNT(*)::int
            AS count
        FROM public.pos_orders
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        after.count
      ),
      Number(
        before.count
      )
    );
  }
);

/*
 * =====================================================
 * 14. FINAL IMPOSSIBLE-STATE CHECK
 * =====================================================
 */

test(
  "FINAL: QR/kiosk lifecycle has no paid pending-payment rows",
  async () => {
    const bad =
      await all(
        `
        SELECT
          id,
          restaurant_id,
          batch_id,
          source,
          paid,
          order_status,
          amount_paid,
          remaining_price,
          expires_at
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND LOWER(
                COALESCE(
                  source,
                  ''
                )
              ) IN (
                'qr',
                'kiosk'
              )
          AND (
            (
              COALESCE(
                paid,
                0
              ) = 1

              AND LOWER(
                    TRIM(
                      COALESCE(
                        order_status,
                        ''
                      )
                    )
                  ) =
                    'pending_payment'
            )

            OR

            COALESCE(
              remaining_price,
              0
            ) < -0.01

            OR

            COALESCE(
              amount_paid,
              0
            ) < -0.01
          )
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.deepEqual(
      bad,
      [],
      `Impossible QR/kiosk lifecycle rows: ${JSON.stringify(
        bad
      )}`
    );
  }
);

/*
 * =====================================================
 * 15. FINAL KDS TENANT OWNERSHIP
 * =====================================================
 */

test(
  "FINAL: QR/kiosk KDS rows preserve tenant ownership",
  async () => {
    const contaminated =
      await all(
        `
        SELECT
          o.id,
          o.restaurant_id,
          o.batch_id,

          ob.restaurant_id
            AS batch_restaurant_id

        FROM public.orders o

        LEFT JOIN public.order_batches ob
          ON ob.id =
               o.batch_id

        WHERE
          o.batch_id
            IS NOT NULL

          AND (
            ob.id IS NULL

            OR

            ob.restaurant_id <>
              o.restaurant_id
          )
        `
      );

    assert.deepEqual(
      contaminated,
      [],
      `Cross-tenant/orphan KDS rows detected: ${JSON.stringify(
        contaminated
      )}`
    );
  }
);