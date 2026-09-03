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

// =========================================================
// GLOBAL TEST STATE
// =========================================================

let app;
let fixtures;

let tokenA;
let tokenB;

let dbPool;

let batchA = null;
let posOrderA = null;

let paymentA = null;
let settlementA = null;

// =========================================================
// HELPERS
// =========================================================

function bearer(token) {
  return `Bearer ${token}`;
}

function round2(value) {
  return Math.round(
    (Number(value) || 0) * 100
  ) / 100;
}

async function dbQuery(
  sql,
  params = []
) {
  assert.ok(
    dbPool,
    "Test database pool is not initialised"
  );

  return dbPool.query(
    sql,
    params
  );
}

function expectNotSuccessful(
  res,
  message
) {
  assert.ok(
    res.status < 200 ||
      res.status >= 300,
    `${message}\n` +
      `Expected non-2xx response.\n` +
      `Received ${res.status}: ${JSON.stringify(
        res.body
      )}`
  );
}

// =========================================================
// SETUP
// =========================================================

test.before(async () => {
  /*
   * Completely clean test database.
   */
  await resetTestData();

  /*
   * Two isolated restaurants:
   *
   * A:
   * owner A
   * burger A £12.50
   *
   * B:
   * owner B
   * burger B £99.99
   */
  fixtures =
    await seedTestData();

  /*
   * Direct database assertions are also protected
   * through the same test-database safety wall.
   */
  const safe =
    await assertTestDatabase();

  assert.equal(
    safe.database,
    "maks_test"
  );

  dbPool = safe.pool;

  /*
   * IMPORTANT:
   *
   * This suite is testing:
   *
   * pricing
   * POS
   * KDS
   * payments
   * settlements
   * refunds
   *
   * Stock availability itself already has its own
   * tenant-isolation coverage.
   *
   * Therefore put both test restaurants into POS-only
   * selling mode so stock cannot interfere with the
   * financial lifecycle test.
   */
  await dbQuery(
    `
    UPDATE restaurants
    SET
      selling_mode = 'pos_only',
      stock_deduction_enabled = FALSE
    WHERE id IN ($1, $2)
    `,
    [
      fixtures.restaurantA,
      fixtures.restaurantB,
    ]
  );

  /*
   * Import Express only AFTER test DB safety is proven.
   *
   * server.js must not call app.listen() when imported.
   */
  ({ app } =
    require("../../server"));

  assert.ok(
    app,
    "Express app was not exported"
  );

  // -------------------------------------------------------
  // LOGIN A
  // -------------------------------------------------------

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
    JSON.stringify(loginA.body)
  );

  tokenA =
    loginA.body?.token;

  assert.ok(tokenA);

  // -------------------------------------------------------
  // LOGIN B
  // -------------------------------------------------------

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
    JSON.stringify(loginB.body)
  );

  tokenB =
    loginB.body?.token;

  assert.ok(tokenB);
});

test.after(async () => {
  if (dbPool) {
    await dbPool.end();
  }
});

// =========================================================
// 1. DATABASE FIXTURE CHECK
// =========================================================

test(
  "financial fixtures have the intended authoritative prices",
  async () => {
    const rows =
      await dbQuery(
        `
        SELECT
          id,
          restaurant_id,
          name,
          price
        FROM meals
        WHERE id IN ($1, $2)
        ORDER BY id
        `,
        [
          fixtures.mealA,
          fixtures.mealB,
        ]
      );

    assert.equal(
      rows.rows.length,
      2
    );

    const mealA =
      rows.rows.find(
        (row) =>
          Number(row.id) ===
          Number(fixtures.mealA)
      );

    const mealB =
      rows.rows.find(
        (row) =>
          Number(row.id) ===
          Number(fixtures.mealB)
      );

    assert.equal(
      Number(mealA.restaurant_id),
      fixtures.restaurantA
    );

    assert.equal(
      round2(mealA.price),
      12.5
    );

    assert.equal(
      Number(mealB.restaurant_id),
      fixtures.restaurantB
    );

    assert.equal(
      round2(mealB.price),
      99.99
    );
  }
);

// =========================================================
// 2. CROSS-TENANT ORDER ATTACK
// =========================================================

test(
  "Owner A cannot order Restaurant B meal ID",
  async () => {
    const before =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM pos_orders
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const beforeCount =
      Number(
        before.rows[0]?.count || 0
      );

    const res =
      await request(app)
        .post("/orders/grouped")
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          order_type:
            "takeaway",

          table_number:
            "Takeaway",

          source: "pos",

          items: [
            {
              item_source:
                "meals",

              source:
                "meals",

              item_type:
                "meals",

              category:
                "meals",

              /*
               * Deliberately Restaurant B's ID.
               */
              meal_id:
                fixtures.mealB,

              /*
               * Also lie about everything else.
               */
              meal_name:
                "HACKED BURGER",

              name:
                "HACKED BURGER",

              quantity: 1,

              price:
                0.01,

              price_per_unit:
                0.01,

              total_price:
                0.01,

              options: {},
            },
          ],
        });

    expectNotSuccessful(
      res,
      "SECURITY FAILURE: Restaurant A ordered Restaurant B meal"
    );

    const after =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM pos_orders
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        after.rows[0]?.count || 0
      ),
      beforeCount,
      "Cross-tenant order created POS rows"
    );
  }
);

// =========================================================
// 3. AUTHORITATIVE PRICING ATTACK
// =========================================================

test(
  "browser cannot change Burger A from £12.50 to £0.01",
  async () => {
    const res =
      await request(app)
        .post("/orders/grouped")
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          order_type:
            "takeaway",

          table_number:
            "Takeaway",

          source:
            "pos",

          items: [
            {
              item_source:
                "meals",

              source:
                "meals",

              item_type:
                "meals",

              category:
                "meals",

              meal_id:
                fixtures.mealA,

              /*
               * Browser lies.
               */
              meal_name:
                "I AM NOT THE REAL NAME",

              name:
                "I AM NOT THE REAL NAME",

              quantity: 1,

              price:
                0.01,

              price_per_unit:
                0.01,

              total_price:
                0.01,

              /*
               * Burger A's fixture contains a required
               * Side option.
               *
               * Chips costs £0.
               */
              options: {
                raw: {
                  test_side:
                    "test_chips",
                },

                /*
                 * Also deliberately forge display/meta.
                 * Backend must use raw choice IDs + schema.
                 */
                display: {
                  Side:
                    "FREE HACK",
                },

                meta: {},
              },
            },
          ],
        });

    assert.equal(
      res.status,
      201,
      `Order failed: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.success,
      true
    );

    /*
     * Backend quote must win.
     */
    assert.equal(
      round2(res.body?.subtotal),
      12.5,
      `Browser controlled subtotal: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      round2(res.body?.total),
      12.5
    );

    batchA =
      String(
        res.body?.batch_id || ""
      );

    assert.match(
      batchA,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  }
);

// =========================================================
// 4. DATABASE MUST ALSO HAVE AUTHORITATIVE PRICE
// =========================================================

test(
  "POS database row stores authoritative identity and £12.50",
  async () => {
    const result =
      await dbQuery(
        `
        SELECT
          id,
          restaurant_id,
          table_number,
          meal_id,
          item_name,
          total_price,
          remaining_price,
          amount_paid,
          paid,
          batch_id,
          source,
          options
        FROM pos_orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        ORDER BY id
        `,
        [
          fixtures.restaurantA,
          batchA,
        ]
      );

    assert.ok(
      result.rows.length >= 1,
      "No POS bill row created"
    );

    posOrderA =
      result.rows[0];

    assert.equal(
      Number(
        posOrderA.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      Number(posOrderA.meal_id),
      fixtures.mealA
    );

    assert.equal(
      posOrderA.item_name,
      "TEST Burger A"
    );

    assert.equal(
      round2(
        posOrderA.total_price
      ),
      12.5
    );

    assert.equal(
      round2(
        posOrderA.remaining_price
      ),
      12.5
    );

    assert.equal(
      round2(
        posOrderA.amount_paid
      ),
      0
    );

    assert.equal(
      Number(posOrderA.paid),
      0
    );

    assert.equal(
      String(posOrderA.source),
      "pos"
    );
  }
);

// =========================================================
// 5. ORDER BATCH OWNERSHIP
// =========================================================

test(
  "order batch belongs only to Restaurant A",
  async () => {
    const batch =
      await dbQuery(
        `
        SELECT
          id,
          restaurant_id,
          table_number,
          order_type
        FROM order_batches
        WHERE id = $1::uuid
        `,
        [batchA]
      );

    assert.equal(
      batch.rows.length,
      1
    );

    assert.equal(
      Number(
        batch.rows[0].restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      String(
        batch.rows[0].order_type
      ).toLowerCase(),
      "takeaway"
    );
  }
);

// =========================================================
// 6. FOREIGN KDS ACK ATTACK
// =========================================================

test(
  "Restaurant B cannot ACK Restaurant A KDS batch",
  async () => {
    const res =
      await request(app)
        .post(
          `/kds/live/${batchA}/ack`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .set(
          "x-kds-device",
          "TEST-KDS-B"
        )
        .set(
          "x-station-key",
          "kitchen"
        )
        .send({});

    assert.ok(
      [403, 404].includes(
        res.status
      ),
      `Foreign KDS ACK was not blocked: ${res.status} ${JSON.stringify(
        res.body
      )}`
    );

    /*
     * Verify no forged ACK was inserted for Restaurant B.
     */
    const rows =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM kds_station_ack
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [
          fixtures.restaurantB,
          batchA,
        ]
      );

    assert.equal(
      Number(
        rows.rows[0]?.count || 0
      ),
      0,
      "Restaurant B manufactured KDS state against A batch"
    );
  }
);

// =========================================================
// 7. OWNER A CAN ACK OWN KDS BATCH
// =========================================================

test(
  "Restaurant A can ACK its own KDS batch",
  async () => {
    const res =
      await request(app)
        .post(
          `/kds/live/${batchA}/ack`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-kds-device",
          "TEST-KDS-A"
        )
        .set(
          "x-station-key",
          "kitchen"
        )
        .send({});

    assert.equal(
      res.status,
      200,
      `Own KDS ACK failed: ${JSON.stringify(
        res.body
      )}`
    );

    const rows =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM kds_station_ack
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          batchA,
        ]
      );

    assert.equal(
      Number(
        rows.rows[0]?.count || 0
      ),
      1
    );
  }
);

// =========================================================
// 8. PAYMENT UNDERPAYMENT ATTACK
// =========================================================

test(
  "£0.01 tender cannot settle the authoritative £12.50 bill",
  async () => {
    const res =
      await request(app)
        .post(
          "/orders/mark-paid"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          tableNumber:
            "Takeaway",

          itemIds: [
            Number(
              posOrderA.id
            ),
          ],

          payments: [
            {
              method:
                "cash",

              /*
               * Deliberately wrong.
               */
              amount:
                0.01,
            },
          ],

          manualDiscountAmount:
            0,

          serviceChargeAmount:
            0,
        });

    assert.equal(
      res.status,
      400,
      `Underpayment should be rejected: ${JSON.stringify(
        res.body
      )}`
    );

    /*
     * Re-read POS row.
     */
    const row =
      await dbQuery(
        `
        SELECT
          paid,
          amount_paid,
          remaining_price
        FROM pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          posOrderA.id,
        ]
      );

    assert.equal(
      Number(
        row.rows[0].paid
      ),
      0
    );

    assert.equal(
      round2(
        row.rows[0]
          .amount_paid
      ),
      0
    );

    assert.equal(
      round2(
        row.rows[0]
          .remaining_price
      ),
      12.5
    );

    const payments =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM payments
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        payments.rows[0]?.count ||
          0
      ),
      0
    );
  }
);

// =========================================================
// 9. REAL PAYMENT
// =========================================================

test(
  "Restaurant A can settle the authoritative £12.50 bill",
  async () => {
    const res =
      await request(app)
        .post(
          "/orders/mark-paid"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          tableNumber:
            "Takeaway",

          itemIds: [
            Number(
              posOrderA.id
            ),
          ],

          paymentMethod:
            "cash",

          manualDiscountAmount:
            0,

          serviceChargeAmount:
            0,

          terminalRef:
            "TEST-TERMINAL-A",
        });

    assert.equal(
      res.status,
      200,
      `Payment failed: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.success,
      true
    );

    assert.equal(
      round2(
        res.body?.amount
      ),
      12.5
    );

    assert.equal(
      round2(
        res.body
          ?.gross_amount
      ),
      12.5
    );

    assert.equal(
      Number(
        res.body?.changes
      ),
      1
    );

    settlementA =
      String(
        res.body
          ?.settlement_id || ""
      );

    assert.match(
      settlementA,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const ids =
      res.body?.payment_ids;

    assert.ok(
      Array.isArray(ids)
    );

    assert.equal(
      ids.length,
      1
    );

    paymentA =
      Number(ids[0]);

    assert.ok(
      paymentA > 0
    );
  }
);

// =========================================================
// 10. PAID ROW RECONCILIATION
// =========================================================

test(
  "paid POS row reconciles exactly to zero outstanding",
  async () => {
    const result =
      await dbQuery(
        `
        SELECT
          total_price,
          amount_paid,
          remaining_price,
          paid,
          invoice_number
        FROM pos_orders
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          posOrderA.id,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      result.rows.length,
      1
    );

    const row =
      result.rows[0];

    assert.equal(
      round2(row.total_price),
      12.5
    );

    assert.equal(
      round2(row.amount_paid),
      12.5
    );

    assert.equal(
      round2(
        row.remaining_price
      ),
      0
    );

    assert.equal(
      Number(row.paid),
      1
    );

    assert.ok(
      Number(
        row.invoice_number
      ) > 0
    );
  }
);

// =========================================================
// 11. PAYMENT + SETTLEMENT DB RECONCILIATION
// =========================================================

test(
  "payment ledger and immutable settlement both equal £12.50",
  async () => {
    const payment =
      await dbQuery(
        `
        SELECT
          id,
          restaurant_id,
          amount,
          method,
          status,
          source,
          settlement_id,
          pos_order_ids
        FROM payments
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          paymentA,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      payment.rows.length,
      1
    );

    assert.equal(
      round2(
        payment.rows[0].amount
      ),
      12.5
    );

    assert.equal(
      String(
        payment.rows[0].method
      ).toLowerCase(),
      "cash"
    );

    assert.equal(
      String(
        payment.rows[0].status
      ).toLowerCase(),
      "completed"
    );

    assert.equal(
      String(
        payment.rows[0]
          .settlement_id
      ),
      settlementA
    );

    const settlement =
      await dbQuery(
        `
        SELECT
          id,
          restaurant_id,
          gross_amount,
          final_amount,
          pos_order_ids
        FROM payment_settlements
        WHERE id = $1::uuid
          AND restaurant_id = $2
        `,
        [
          settlementA,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      settlement.rows.length,
      1
    );

    assert.equal(
      round2(
        settlement.rows[0]
          .gross_amount
      ),
      12.5
    );

    assert.equal(
      round2(
        settlement.rows[0]
          .final_amount
      ),
      12.5
    );
  }
);

// =========================================================
// 12. DOUBLE PAYMENT ATTACK
// =========================================================

test(
  "same POS item cannot be paid twice",
  async () => {
    const paymentsBefore =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM payments
        WHERE restaurant_id = $1
          AND source = 'pos'
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const settlementsBefore =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM payment_settlements
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const res =
      await request(app)
        .post(
          "/orders/mark-paid"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          tableNumber:
            "Takeaway",

          itemIds: [
            Number(
              posOrderA.id
            ),
          ],

          paymentMethod:
            "cash",

          manualDiscountAmount:
            0,

          serviceChargeAmount:
            0,
        });

    assert.equal(
      res.status,
      400,
      `Duplicate payment wasn't blocked: ${JSON.stringify(
        res.body
      )}`
    );

    const paymentsAfter =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM payments
        WHERE restaurant_id = $1
          AND source = 'pos'
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const settlementsAfter =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM payment_settlements
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        paymentsAfter.rows[0]
          .count
      ),
      Number(
        paymentsBefore.rows[0]
          .count
      ),
      "Duplicate tender row created"
    );

    assert.equal(
      Number(
        settlementsAfter.rows[0]
          .count
      ),
      Number(
        settlementsBefore.rows[0]
          .count
      ),
      "Duplicate settlement created"
    );
  }
);

// =========================================================
// 13. PAYMENT HISTORY TENANT ISOLATION
// =========================================================

test(
  "Restaurant B cannot see Restaurant A payment in history",
  async () => {
    const res =
      await request(app)
        .get(
          "/orders/payments"
        )
        .set(
          "Authorization",
          bearer(tokenB)
        );

    assert.equal(
      res.status,
      200,
      JSON.stringify(res.body)
    );

    assert.ok(
      Array.isArray(res.body)
    );

    assert.equal(
      res.body.some(
        (payment) =>
          Number(payment.id) ===
            paymentA ||
          Number(
            payment.restaurant_id
          ) ===
            fixtures.restaurantA
      ),
      false,
      "Restaurant A payment leaked to Restaurant B"
    );
  }
);

// =========================================================
// 14. SETTLEMENT TENANT ISOLATION
// =========================================================

test(
  "Restaurant B cannot read Restaurant A settlement UUID",
  async () => {
    const res =
      await request(app)
        .get(
          `/orders/payment-settlements/${settlementA}`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        );

    assert.equal(
      res.status,
      404,
      `Foreign settlement was exposed: ${JSON.stringify(
        res.body
      )}`
    );
  }
);

// =========================================================
// 15. OWNER A CAN READ OWN SETTLEMENT
// =========================================================

test(
  "Restaurant A can read its immutable settlement",
  async () => {
    const res =
      await request(app)
        .get(
          `/orders/payment-settlements/${settlementA}`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        );

    assert.equal(
      res.status,
      200,
      JSON.stringify(res.body)
    );

    assert.equal(
      String(
        res.body
          ?.settlement
          ?.settlement_id
      ),
      settlementA
    );

    assert.equal(
      round2(
        res.body
          ?.settlement
          ?.final_amount
      ),
      12.5
    );
  }
);

// =========================================================
// 16. CROSS-TENANT REFUND ATTACK
// =========================================================

test(
  "Restaurant B cannot refund Restaurant A payment",
  async () => {
    const res =
      await request(app)
        .post(
          `/orders/payments/${paymentA}/refund`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send({
          reason:
            "CROSS TENANT ATTACK",
        });

    assert.ok(
      [403, 404].includes(
        res.status
      ),
      `Cross-tenant refund wasn't blocked: ${res.status} ${JSON.stringify(
        res.body
      )}`
    );

    const payment =
      await dbQuery(
        `
        SELECT status
        FROM payments
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          paymentA,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      String(
        payment.rows[0].status
      ).toLowerCase(),
      "completed"
    );
  }
);

// =========================================================
// 17. LEGITIMATE FULL REFUND
// =========================================================

test(
  "Restaurant A can refund its own £12.50 payment",
  async () => {
    const res =
      await request(app)
        .post(
          `/orders/payments/${paymentA}/refund`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          reason:
            "TEST FULL REFUND",
        });

    assert.equal(
      res.status,
      200,
      `Refund failed: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.success,
      true
    );

    assert.equal(
      round2(
        res.body?.refund_amount
      ),
      12.5
    );

    assert.ok(
      Array.isArray(
        res.body?.touched_ids
      )
    );

    assert.ok(
      res.body.touched_ids.includes(
        Number(
          posOrderA.id
        )
      )
    );

    assert.match(
      String(
        res.body?.payment_uuid ||
        ""
      ),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "Refund response is missing payment_uuid"
    );

    assert.match(
      String(
        res.body?.ref_payment_uuid ||
        ""
      ),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "Refund response is missing ref_payment_uuid"
    );
  }
);

// =========================================================
// 18. REFUND RESTORES POS BALANCE
// =========================================================

test(
  "refund restores the POS line to £12.50 outstanding",
  async () => {
    const row =
      await dbQuery(
        `
        SELECT
          total_price,
          amount_paid,
          remaining_price,
          paid
        FROM pos_orders
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          posOrderA.id,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      row.rows.length,
      1
    );

    assert.equal(
      round2(
        row.rows[0]
          .total_price
      ),
      12.5
    );

    assert.equal(
      round2(
        row.rows[0]
          .amount_paid
      ),
      0
    );

    assert.equal(
      round2(
        row.rows[0]
          .remaining_price
      ),
      12.5
    );

    assert.equal(
      Number(
        row.rows[0].paid
      ),
      0
    );
  }
);

// =========================================================
// 19. REFUND LEDGER RECONCILIATION
// =========================================================

test(
  "refund creates exactly one -£12.50 ledger entry linked to original payment",
  async () => {
    const original =
      await dbQuery(
        `
        SELECT
          status,
          payment_uuid
        FROM payments
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          paymentA,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      String(
        original.rows[0].status
      ).toLowerCase(),
      "refunded"
    );

    const refunds =
      await dbQuery(
        `
        SELECT
          id,
          amount,
          source,
          ref_payment_id,
          payment_uuid,
          ref_payment_uuid,
          restaurant_id
        FROM payments
        WHERE restaurant_id = $1
          AND ref_payment_id = $2
          AND source = 'refund'
        `,
        [
          fixtures.restaurantA,
          paymentA,
        ]
      );

    assert.equal(
      refunds.rows.length,
      1
    );

    assert.equal(
      round2(
        refunds.rows[0].amount
      ),
      -12.5
    );

    assert.equal(
      Number(
        refunds.rows[0]
          .ref_payment_id
      ),
      paymentA
    );

    const originalPaymentUuid =
      String(
        original.rows[0]
          .payment_uuid ||
        ""
      );

    const refundPaymentUuid =
      String(
        refunds.rows[0]
          .payment_uuid ||
        ""
      );

    const refundRefPaymentUuid =
      String(
        refunds.rows[0]
          .ref_payment_uuid ||
        ""
      );

    assert.match(
      originalPaymentUuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "Original payment is missing payment_uuid"
    );

    assert.match(
      refundPaymentUuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "Refund payment is missing payment_uuid"
    );

    assert.equal(
      refundRefPaymentUuid,
      originalPaymentUuid,
      "Refund ref_payment_uuid does not match original payment_uuid"
    );

    assert.notEqual(
      refundPaymentUuid,
      originalPaymentUuid,
      "Refund tender reused original payment_uuid"
    );
  }
);

// =========================================================
// 20. DOUBLE REFUND ATTACK
// =========================================================

test(
  "same payment cannot be refunded twice",
  async () => {
    const before =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM payments
        WHERE restaurant_id = $1
          AND ref_payment_id = $2
          AND source = 'refund'
        `,
        [
          fixtures.restaurantA,
          paymentA,
        ]
      );

    const res =
      await request(app)
        .post(
          `/orders/payments/${paymentA}/refund`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          reason:
            "SECOND REFUND ATTACK",
        });

    expectNotSuccessful(
      res,
      "SECURITY FAILURE: same tender was refunded twice"
    );

    const after =
      await dbQuery(
        `
        SELECT COUNT(*)::int AS count
        FROM payments
        WHERE restaurant_id = $1
          AND ref_payment_id = $2
          AND source = 'refund'
        `,
        [
          fixtures.restaurantA,
          paymentA,
        ]
      );

    assert.equal(
      Number(
        after.rows[0].count
      ),
      Number(
        before.rows[0].count
      )
    );
  }
);

// =========================================================
// 21. NO NEGATIVE POS BALANCES
// =========================================================

test(
  "no Restaurant A POS balance became negative",
  async () => {
    const rows =
      await dbQuery(
        `
        SELECT
          id,
          amount_paid,
          remaining_price
        FROM pos_orders
        WHERE restaurant_id = $1
          AND (
            COALESCE(
              amount_paid,
              0
            ) < 0
            OR
            COALESCE(
              remaining_price,
              0
            ) < 0
          )
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      rows.rows.length,
      0,
      `Negative financial state detected: ${JSON.stringify(
        rows.rows
      )}`
    );
  }
);

// =========================================================
// 22. FINAL TENANT OWNERSHIP CHECK
// =========================================================

test(
  "final order, payment and settlement ownership remains Restaurant A only",
  async () => {
    const orders =
      await dbQuery(
        `
        SELECT DISTINCT
          restaurant_id
        FROM pos_orders
        WHERE batch_id = $1::uuid
        `,
        [batchA]
      );

    assert.ok(
      orders.rows.length >= 1
    );

    assert.equal(
      orders.rows.every(
        (row) =>
          Number(
            row.restaurant_id
          ) ===
          fixtures.restaurantA
      ),
      true
    );

    const payments =
      await dbQuery(
        `
        SELECT
          restaurant_id
        FROM payments
        WHERE
          id = $1
          OR ref_payment_id = $1
        `,
        [paymentA]
      );

    assert.ok(
      payments.rows.length >= 2
    );

    assert.equal(
      payments.rows.every(
        (row) =>
          Number(
            row.restaurant_id
          ) ===
          fixtures.restaurantA
      ),
      true
    );

    const settlement =
      await dbQuery(
        `
        SELECT restaurant_id
        FROM payment_settlements
        WHERE id = $1::uuid
        `,
        [settlementA]
      );

    assert.equal(
      settlement.rows.length,
      1
    );

    assert.equal(
      Number(
        settlement.rows[0]
          .restaurant_id
      ),
      fixtures.restaurantA
    );
  }
);