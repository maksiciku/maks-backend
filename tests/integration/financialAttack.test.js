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

let ownerTokenA;
let ownerTokenB;

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
  return status >= 200 && status < 300;
}

function money(value) {
  return Number(
    Number(value || 0).toFixed(2)
  );
}

/*
 * =====================================================
 * AUTHORITATIVE ORDER CREATION
 * =====================================================
 *
 * Browser lies about:
 * - name
 * - price
 *
 * Backend must still create TEST Burger A at £12.50.
 */
function orderPayload(
  mealId,
  tableNumber,
  options = {
    test_side: "test_chips",
  }
) {
  return {
    table_number: tableNumber,
    order_type: "dine-in",
    source: "pos",

    items: [
      {
        meal_id: mealId,

        item_source: "meals",
        item_type: "meals",

        meal_name:
          "FINANCIAL ATTACK FAKE NAME",

        quantity: 1,

        /*
         * Deliberately forged browser price.
         * The backend must ignore this and use
         * the authoritative database price.
         */
        price_per_unit: 0.01,
        total_price: 0.01,

        options,
      },
    ],
  };
}

async function createOrder({
  token,
  restaurantId,
  mealId,
  tableNumber,
  options,
  expectedPrice = 12.5,
}) {
  const before = await one(
    `
    SELECT
      COALESCE(MAX(id), 0)::bigint AS max_id
    FROM public.pos_orders
    WHERE restaurant_id = $1
    `,
    [restaurantId]
  );

  const beforeId =
    Number(before?.max_id || 0);

  const res =
    await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        bearer(token)
      )
      .send(
        orderPayload(
          mealId,
          tableNumber,
          options
        )
      );

  assert.equal(
    res.status,
    201,
    `Order creation failed: ${res.status} ${JSON.stringify(
      res.body
    )}`
  );

  const row = await one(
    `
    SELECT
      id,
      restaurant_id,
      table_number,
      meal_id,
      item_name,
      quantity,
      total_price,
      amount_paid,
      remaining_price,
      paid,
      invoice_number,
      batch_id,
      order_status
    FROM public.pos_orders
    WHERE restaurant_id = $1
      AND id > $2
      AND LOWER(TRIM(table_number)) =
          LOWER(TRIM($3))
    ORDER BY id DESC
    LIMIT 1
    `,
    [
      restaurantId,
      beforeId,
      tableNumber,
    ]
  );

  assert.ok(
    row,
    `No POS row created for ${tableNumber}`
  );

  assert.equal(
    Number(row.restaurant_id),
    restaurantId
  );

  /*
   * Canonical pricing must still win.
   */
  assert.equal(
    money(row.total_price),
    expectedPrice
  );

  assert.equal(
    money(row.remaining_price),
    expectedPrice
  );

  assert.equal(
    Number(row.paid),
    0
  );

  return row;
}

async function getOrder(
  restaurantId,
  id
) {
  return one(
    `
    SELECT
      id,
      restaurant_id,
      table_number,
      total_price,
      amount_paid,
      remaining_price,
      paid,
      invoice_number,
      order_status,
      batch_id
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

async function paymentsForTable(
  restaurantId,
  tableNumber
) {
  return all(
    `
    SELECT
      id,
      restaurant_id,
      table_number,
      amount,
      method,
      status,
      source,
      ref_payment_id,
      settlement_id,
      pos_order_ids,
      created_at
    FROM public.payments
    WHERE restaurant_id = $1
      AND LOWER(TRIM(table_number)) =
          LOWER(TRIM($2))
    ORDER BY id ASC
    `,
    [
      restaurantId,
      tableNumber,
    ]
  );
}

async function settlementsForTable(
  restaurantId,
  tableNumber
) {
  return all(
    `
    SELECT
      id,
      restaurant_id,
      table_number,
      invoice_number,
      gross_amount,
      final_amount,
      pos_order_ids,
      created_at
    FROM public.payment_settlements
    WHERE restaurant_id = $1
      AND LOWER(TRIM(table_number)) =
          LOWER(TRIM($2))
    ORDER BY created_at ASC
    `,
    [
      restaurantId,
      tableNumber,
    ]
  );
}

async function markPaid({
  token,
  tableNumber,
  itemIds,
  payments,
  paymentMethod = "cash",
  extra = {},
}) {
  const body = {
    tableNumber,
    itemIds,
    paymentMethod,
    ...extra,
  };

  if (payments !== undefined) {
    body.payments = payments;
  }

  return request(app)
    .post("/orders/mark-paid")
    .set(
      "Authorization",
      bearer(token)
    )
    .send(body);
}

async function payShare({
  token,
  tableNumber,
  amount,
  payments,
  paymentMethod = "cash",
}) {
  const body = {
    table_number: tableNumber,
    amount,
    paymentMethod,
  };

  if (payments !== undefined) {
    body.payments = payments;
  }

  return request(app)
    .post("/orders/pay-share")
    .set(
      "Authorization",
      bearer(token)
    )
    .send(body);
}

/*
 * =====================================================
 * SETUP
 * =====================================================
 */

test.before(async () => {
  await resetTestData();

  fixtures =
    await seedTestData();

  const safe =
    await assertTestDatabase();

  assert.equal(
    safe.database,
    "maks_test",
    "FINANCIAL ATTACK REFUSED: database is not maks_test"
  );

  pool = safe.pool;

  /*
   * Keep the financial tests focused on money rather
   * than ingredient stock.
   */
  await query(
    `
    UPDATE public.restaurants
    SET
      selling_mode = 'pos_only',
      stock_deduction_enabled = FALSE,
      portion_tracking_mode = 'off'
    WHERE id IN ($1, $2)
    `,
    [
      fixtures.restaurantA,
      fixtures.restaurantB,
    ]
  );

  ({ app } =
    require("../../server"));

  assert.ok(
    app,
    "Express app was not exported from server.js"
  );

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

  ownerTokenA =
    loginA.body?.token;

  assert.ok(ownerTokenA);

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

  ownerTokenB =
    loginB.body?.token;

  assert.ok(ownerTokenB);
});

test.after(async () => {
  if (pool) {
    await pool.end();
  }
});

/*
 * =====================================================
 * 1. UNDERPAYMENT
 * =====================================================
 */

test(
  "ATTACK: £0.01 cannot settle authoritative £12.50 bill",
  async () => {
    const table =
      "Table 201";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 0.01,
          },
        ],
      });

    assert.ok(
      res.status >= 400,
      `£0.01 attack succeeded: ${JSON.stringify(
        res.body
      )}`
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      12.5
    );

    assert.equal(
      money(after.amount_paid),
      0
    );

    assert.equal(
      Number(after.paid),
      0
    );

    const payments =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    assert.equal(
      payments.length,
      0,
      "Failed underpayment created a ledger row"
    );

    const settlements =
      await settlementsForTable(
        fixtures.restaurantA,
        table
      );

    assert.equal(
      settlements.length,
      0,
      "Failed underpayment created a settlement"
    );
  }
);

/*
 * =====================================================
 * 2. OVERPAYMENT
 * =====================================================
 */

test(
  "ATTACK: £100 cannot settle a £12.50 bill",
  async () => {
    const table =
      "Table 202";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 100,
          },
        ],
      });

    assert.ok(
      res.status >= 400,
      `Overpayment attack succeeded: ${JSON.stringify(
        res.body
      )}`
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      12.5
    );

    assert.equal(
      Number(after.paid),
      0
    );
  }
);

/*
 * =====================================================
 * 3. NEGATIVE PAYMENT
 * =====================================================
 */

test(
  "ATTACK: negative tender cannot reduce or corrupt bill",
  async () => {
    const table =
      "Table 203";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: -12.5,
          },
        ],
      });

    assert.ok(
      res.status >= 400
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      12.5
    );

    assert.equal(
      money(after.amount_paid),
      0
    );
  }
);

/*
 * =====================================================
 * 4. MALFORMED PAYMENT
 * =====================================================
 */

test(
  "ATTACK: malformed payment amount cannot create financial state",
  async () => {
    const table =
      "Table 204";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount:
              "THIS_IS_NOT_MONEY",
          },
        ],
      });

    assert.ok(
      res.status >= 400
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      12.5
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    assert.equal(
      ledger.length,
      0
    );
  }
);

/*
 * =====================================================
 * 5. INVALID PAYMENT METHOD
 * =====================================================
 */

test(
  "ATTACK: invented tender method is rejected",
  async () => {
    const table =
      "Table 205";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method:
              "free-money-attack",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      res.status >= 400
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    assert.equal(
      ledger.length,
      0
    );
  }
);

/*
 * =====================================================
 * 6. SPLIT-TENDER MISMATCH
 * =====================================================
 */

test(
  "ATTACK: split tender total must exactly match bill",
  async () => {
    const table =
      "Table 206";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 5,
          },
          {
            method: "card",
            amount: 5,
          },
        ],
      });

    assert.ok(
      res.status >= 400,
      `£10 tender unexpectedly settled £12.50`
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      12.5
    );

    assert.equal(
      Number(after.paid),
      0
    );
  }
);

/*
 * =====================================================
 * 7. DUPLICATE ITEM IDS
 * =====================================================
 */

test(
  "ATTACK: duplicate item IDs cannot multiply the bill",
  async () => {
    const table =
      "Table 207";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,

        itemIds: [
          Number(order.id),
          Number(order.id),
          Number(order.id),
          Number(order.id),
        ],

        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      is2xx(res.status),
      `Duplicate-ID payment failed unexpectedly: ${res.status} ${JSON.stringify(
        res.body
      )}`
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      0
    );

    assert.equal(
      money(after.amount_paid),
      12.5
    );

    assert.equal(
      Number(after.paid),
      1
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const positive =
      ledger.filter(
        (p) =>
          Number(p.amount) > 0
      );

    assert.equal(
      positive.length,
      1,
      "Duplicate IDs created duplicate payments"
    );

    assert.equal(
      money(positive[0].amount),
      12.5
    );
  }
);

/*
 * =====================================================
 * 8. CROSS-TENANT SETTLEMENT
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cannot settle Restaurant A POS row",
  async () => {
    const table =
      "Table 208";

    const orderA =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await markPaid({
        token: ownerTokenB,
        tableNumber: table,
        itemIds: [
          Number(orderA.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      res.status >= 400,
      `Restaurant B settled A row: ${JSON.stringify(
        res.body
      )}`
    );

    const afterA =
      await getOrder(
        fixtures.restaurantA,
        Number(orderA.id)
      );

    assert.equal(
      money(afterA.remaining_price),
      12.5
    );

    assert.equal(
      Number(afterA.paid),
      0
    );

    const bPayments =
      await paymentsForTable(
        fixtures.restaurantB,
        table
      );

    assert.equal(
      bPayments.length,
      0
    );
  }
);

/*
 * =====================================================
 * 9. MIXED TENANT IDS
 * =====================================================
 */

test(
  "ATTACK: mixed A+B POS IDs never modify Restaurant B row",
  async () => {
    const tableA =
      "Table 209";

    const tableB =
      "Table 210";

    const orderA =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: tableA,
      });

    const orderB =
  await createOrder({
    token: ownerTokenB,
    restaurantId:
      fixtures.restaurantB,
    mealId:
      fixtures.mealB,
    tableNumber: tableB,

    /*
     * Restaurant B fixture has no Side option
     * and its authoritative price is £99.99.
     */
    options: {},
    expectedPrice: 99.99,
  });

    /*
     * A submits its legitimate ID plus B's ID.
     *
     * The server may either:
     * - reject the whole request, OR
     * - safely discard B's ID and settle only A.
     *
     * It must NEVER alter B.
     */
    const res =
      await markPaid({
        token: ownerTokenA,
        tableNumber: tableA,

        itemIds: [
          Number(orderA.id),
          Number(orderB.id),
        ],

        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      res.status >= 200,
      "Request produced no HTTP response"
    );

    const afterB =
      await getOrder(
        fixtures.restaurantB,
        Number(orderB.id)
      );

    assert.equal(
  money(afterB.remaining_price),
  99.99,
  "Restaurant A changed Restaurant B outstanding balance"
);

    assert.equal(
      money(afterB.amount_paid),
      0
    );

    assert.equal(
      Number(afterB.paid),
      0
    );
  }
);

/*
 * =====================================================
 * 10. DOUBLE-PAYMENT RACE
 * =====================================================
 */

test(
  "ATTACK: two terminals cannot settle the same bill twice",
  async () => {
    const table =
      "Table 211";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const attack = () =>
      markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "card",
            amount: 12.5,
          },
        ],
      });

    const [a, b] =
      await Promise.all([
        attack(),
        attack(),
      ]);

    const successes =
      [a, b].filter(
        (r) => is2xx(r.status)
      );

    const failures =
      [a, b].filter(
        (r) => r.status >= 400
      );

    assert.equal(
      successes.length,
      1,
      `Expected exactly one successful payment. A=${a.status} B=${b.status}`
    );

    assert.equal(
      failures.length,
      1,
      "Second terminal was not rejected"
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.amount_paid),
      12.5
    );

    assert.equal(
      money(after.remaining_price),
      0
    );

    assert.equal(
      Number(after.paid),
      1
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const positive =
      ledger.filter(
        (p) =>
          Number(p.amount) > 0
      );

    assert.equal(
      positive.length,
      1,
      "Race created more than one positive ledger payment"
    );

    assert.equal(
      money(
        positive.reduce(
          (sum, p) =>
            sum +
            Number(p.amount || 0),
          0
        )
      ),
      12.5
    );

    const settlements =
      await settlementsForTable(
        fixtures.restaurantA,
        table
      );

    assert.equal(
      settlements.length,
      1,
      "Race created duplicate immutable settlements"
    );
  }
);

/*
 * =====================================================
 * 11. ALREADY-PAID REPLAY
 * =====================================================
 */

test(
  "ATTACK: replaying an already-paid POS item cannot charge twice",
  async () => {
    const table =
      "Table 212";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const first =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      is2xx(first.status)
    );

    const replay =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      replay.status >= 400,
      "Already-paid replay succeeded"
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const positive =
      ledger.filter(
        (p) =>
          Number(p.amount) > 0
      );

    assert.equal(
      positive.length,
      1
    );
  }
);

/*
 * =====================================================
 * 12. SPLIT PAYMENT
 * =====================================================
 */

test(
  "split-pay leaves exact authoritative outstanding balance",
  async () => {
    const table =
      "Table 213";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const first =
      await payShare({
        token: ownerTokenA,
        tableNumber: table,
        amount: 5,

        payments: [
          {
            method: "cash",
            amount: 2,
          },
          {
            method: "card",
            amount: 3,
          },
        ],
      });

    assert.ok(
      is2xx(first.status),
      `Split payment failed: ${first.status} ${JSON.stringify(
        first.body
      )}`
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.amount_paid),
      5
    );

    assert.equal(
      money(after.remaining_price),
      7.5
    );

    assert.equal(
      Number(after.paid),
      0
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    assert.equal(
      money(
        ledger.reduce(
          (sum, p) =>
            sum +
            Math.max(
              0,
              Number(p.amount || 0)
            ),
          0
        )
      ),
      5
    );
  }
);

/*
 * =====================================================
 * 13. SPLIT OVERPAY ATTACK
 * =====================================================
 */

test(
  "ATTACK: split payment cannot exceed remaining balance",
  async () => {
    const table =
      "Table 214";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const res =
      await payShare({
        token: ownerTokenA,
        tableNumber: table,
        amount: 20,

        payments: [
          {
            method: "cash",
            amount: 20,
          },
        ],
      });

    assert.ok(
      res.status >= 400
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      12.5
    );

    assert.equal(
      money(after.amount_paid),
      0
    );
  }
);

/*
 * =====================================================
 * 14. CONCURRENT SPLIT RACE
 * =====================================================
 */

test(
  "ATTACK: concurrent split-pay cannot over-settle remaining bill",
  async () => {
    const table =
      "Table 215";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const initial =
      await payShare({
        token: ownerTokenA,
        tableNumber: table,
        amount: 5,

        payments: [
          {
            method: "cash",
            amount: 5,
          },
        ],
      });

    assert.ok(
      is2xx(initial.status)
    );

    const attack = () =>
      payShare({
        token: ownerTokenA,
        tableNumber: table,
        amount: 7.5,

        payments: [
          {
            method: "card",
            amount: 7.5,
          },
        ],
      });

    const [a, b] =
      await Promise.all([
        attack(),
        attack(),
      ]);

    const successes =
      [a, b].filter(
        (r) => is2xx(r.status)
      );

    assert.equal(
      successes.length,
      1,
      `Concurrent split race allowed ${successes.length} successes`
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.amount_paid),
      12.5
    );

    assert.equal(
      money(after.remaining_price),
      0
    );

    assert.equal(
      Number(after.paid),
      1
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const positiveTotal =
      money(
        ledger.reduce(
          (sum, p) =>
            sum +
            Math.max(
              0,
              Number(p.amount || 0)
            ),
          0
        )
      );

    assert.equal(
      positiveTotal,
      12.5,
      "Concurrent split race over-recorded money"
    );
  }
);

/*
 * =====================================================
 * 15. REFUND EXCEEDS ORIGINAL
 * =====================================================
 */

test(
  "ATTACK: refund cannot exceed original payment",
  async () => {
    const table =
      "Table 216";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const paid =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      is2xx(paid.status)
    );

    const ledgerBefore =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const original =
      ledgerBefore.find(
        (p) =>
          Number(p.amount) > 0
      );

    assert.ok(original);

    const refund =
      await request(app)
        .post(
          `/orders/payments/${original.id}/refund`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          amount: 100,
          reason:
            "financial attack over-refund",
        });

    assert.ok(
      refund.status >= 400,
      "Over-refund succeeded"
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      0,
      "Failed refund changed POS balance"
    );

    const ledgerAfter =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const negatives =
      ledgerAfter.filter(
        (p) =>
          Number(p.amount) < 0
      );

    assert.equal(
      negatives.length,
      0
    );
  }
);

/*
 * =====================================================
 * 16. CROSS-TENANT REFUND
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cannot refund Restaurant A payment",
  async () => {
    const table =
      "Table 217";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const paid =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "card",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      is2xx(paid.status)
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const original =
      ledger.find(
        (p) =>
          Number(p.amount) > 0
      );

    assert.ok(original);

    const attack =
      await request(app)
        .post(
          `/orders/payments/${original.id}/refund`
        )
        .set(
          "Authorization",
          bearer(ownerTokenB)
        )
        .send({
          reason:
            "cross tenant attack",
        });

    assert.ok(
      attack.status >= 400
    );

    const after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      0
    );

    assert.equal(
      Number(after.paid),
      1
    );
  }
);

/*
 * =====================================================
 * 17. DOUBLE REFUND RACE
 * =====================================================
 */

test(
  "ATTACK: concurrent refund cannot create two negative ledger entries",
  async () => {
    const table =
      "Table 218";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const paid =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      is2xx(paid.status)
    );

    const ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const original =
      ledger.find(
        (p) =>
          Number(p.amount) > 0
      );

    assert.ok(original);

    const attack = () =>
      request(app)
        .post(
          `/orders/payments/${original.id}/refund`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          reason:
            "concurrent refund attack",
        });

    const [a, b] =
      await Promise.all([
        attack(),
        attack(),
      ]);

    const successes =
      [a, b].filter(
        (r) => is2xx(r.status)
      );

    assert.equal(
      successes.length,
      1,
      `Expected one refund success, got ${successes.length}`
    );

    const afterLedger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const negatives =
      afterLedger.filter(
        (p) =>
          Number(p.amount) < 0
      );

    assert.equal(
      negatives.length,
      1,
      "Double refund race created multiple refund ledger entries"
    );

    assert.equal(
      money(negatives[0].amount),
      -12.5
    );

    const afterOrder =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(afterOrder.remaining_price),
      12.5
    );

    assert.equal(
      money(afterOrder.amount_paid),
      0
    );

    assert.equal(
      Number(afterOrder.paid),
      0
    );
  }
);

/*
 * =====================================================
 * 18. PARTIAL REFUND FOLLOW-UP
 *
 * This intentionally tests a difficult edge:
 *
 * If MAKS supports `amount` on the refund endpoint,
 * a £5 partial refund should not make the remaining
 * £7.50 permanently impossible to refund later.
 *
 * If this goes RED, do not "fix the test".
 * We inspect the financial model.
 * =====================================================
 */

test(
  "EDGE: partial refund must not strand the unrefunded remainder",
  async () => {
    const table =
      "Table 219";

    const order =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: table,
      });

    const paid =
      await markPaid({
        token: ownerTokenA,
        tableNumber: table,
        itemIds: [
          Number(order.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    assert.ok(
      is2xx(paid.status)
    );

    let ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const original =
      ledger.find(
        (p) =>
          Number(p.amount) > 0
      );

    assert.ok(original);

    const firstRefund =
      await request(app)
        .post(
          `/orders/payments/${original.id}/refund`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          amount: 5,
          reason:
            "partial refund stage one",
        });

    assert.ok(
      is2xx(firstRefund.status),
      `First partial refund failed: ${firstRefund.status} ${JSON.stringify(
        firstRefund.body
      )}`
    );

    let after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      5
    );

    /*
     * Now try to refund the remaining £7.50.
     *
     * If the original payment was prematurely marked
     * fully refunded, this attack exposes it.
     */
    const secondRefund =
      await request(app)
        .post(
          `/orders/payments/${original.id}/refund`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          amount: 7.5,
          reason:
            "partial refund stage two",
        });

    assert.ok(
      is2xx(secondRefund.status),
      `Partial refund remainder is stranded: ${secondRefund.status} ${JSON.stringify(
        secondRefund.body
      )}`
    );

    after =
      await getOrder(
        fixtures.restaurantA,
        Number(order.id)
      );

    assert.equal(
      money(after.remaining_price),
      12.5
    );

    assert.equal(
      money(after.amount_paid),
      0
    );

    assert.equal(
      Number(after.paid),
      0
    );

    ledger =
      await paymentsForTable(
        fixtures.restaurantA,
        table
      );

    const refundTotal =
      money(
        ledger
          .filter(
            (p) =>
              Number(p.amount) < 0
          )
          .reduce(
            (sum, p) =>
              sum +
              Math.abs(
                Number(
                  p.amount || 0
                )
              ),
            0
          )
      );

    assert.equal(
      refundTotal,
      12.5
    );
  }
);

/*
 * =====================================================
 * 19. CONCURRENT INVOICE NUMBERS
 * =====================================================
 */

test(
  "ATTACK: simultaneous settlements receive unique invoice numbers",
  async () => {
    const tableA =
      "Table 220";

    const tableB =
      "Table 221";

    const orderA =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: tableA,
      });

    const orderB =
      await createOrder({
        token: ownerTokenA,
        restaurantId:
          fixtures.restaurantA,
        mealId:
          fixtures.mealA,
        tableNumber: tableB,
      });

    const payA = () =>
      markPaid({
        token: ownerTokenA,
        tableNumber: tableA,
        itemIds: [
          Number(orderA.id),
        ],
        payments: [
          {
            method: "cash",
            amount: 12.5,
          },
        ],
      });

    const payB = () =>
      markPaid({
        token: ownerTokenA,
        tableNumber: tableB,
        itemIds: [
          Number(orderB.id),
        ],
        payments: [
          {
            method: "card",
            amount: 12.5,
          },
        ],
      });

    const [a, b] =
      await Promise.all([
        payA(),
        payB(),
      ]);

    assert.ok(
      is2xx(a.status),
      JSON.stringify(a.body)
    );

    assert.ok(
      is2xx(b.status),
      JSON.stringify(b.body)
    );

    const afterA =
      await getOrder(
        fixtures.restaurantA,
        Number(orderA.id)
      );

    const afterB =
      await getOrder(
        fixtures.restaurantA,
        Number(orderB.id)
      );

    assert.ok(
      Number(afterA.invoice_number) > 0
    );

    assert.ok(
      Number(afterB.invoice_number) > 0
    );

    assert.notEqual(
      Number(afterA.invoice_number),
      Number(afterB.invoice_number),
      "Concurrent settlements received duplicate invoice numbers"
    );
  }
);

/*
 * =====================================================
 * 20. GLOBAL FINANCIAL INVARIANTS
 * =====================================================
 */

test(
  "FINAL: no Restaurant A POS balance is negative or overpaid",
  async () => {
    const bad =
      await all(
        `
        SELECT
          id,
          total_price,
          amount_paid,
          remaining_price,
          paid
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND (
            COALESCE(
              remaining_price,
              0
            ) < -0.01

            OR

            COALESCE(
              amount_paid,
              0
            ) < -0.01

            OR

            COALESCE(
              amount_paid,
              0
            ) -
            COALESCE(
              total_price,
              0
            ) > 0.01
          )
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.deepEqual(
      bad,
      [],
      `Financial corruption detected: ${JSON.stringify(
        bad
      )}`
    );
  }
);

/*
 * =====================================================
 * 21. TENANT INTEGRITY
 * =====================================================
 */

test(
  "FINAL: financial records preserve tenant ownership",
  async () => {
    const contaminatedPayments =
      await one(
        `
        SELECT COUNT(*)::int AS count
        FROM public.payments p
        WHERE p.restaurant_id = $1
          AND EXISTS (
            SELECT 1
            FROM public.pos_orders po
            WHERE po.restaurant_id = $2
              AND p.pos_order_ids @>
                  to_jsonb(
                    ARRAY[
                      po.id
                    ]::bigint[]
                  )
          )
        `,
        [
          fixtures.restaurantB,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        contaminatedPayments?.count ||
        0
      ),
      0,
      "Restaurant B payment references Restaurant A POS row"
    );

    const contaminatedSettlements =
      await one(
        `
        SELECT COUNT(*)::int AS count
        FROM public.payment_settlements ps
        WHERE ps.restaurant_id = $1
          AND EXISTS (
            SELECT 1
            FROM public.pos_orders po
            WHERE po.restaurant_id = $2
              AND ps.pos_order_ids @>
                  to_jsonb(
                    ARRAY[
                      po.id
                    ]::bigint[]
                  )
          )
        `,
        [
          fixtures.restaurantB,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        contaminatedSettlements?.count ||
        0
      ),
      0,
      "Restaurant B settlement references Restaurant A POS row"
    );
  }
);