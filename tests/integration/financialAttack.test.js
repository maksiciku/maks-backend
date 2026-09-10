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
 * Reporting fixtures use API-created orders, payments and refunds.
 * Only their timestamps are repositioned, on the verified maks_test DB,
 * into isolated UTC windows. No synthetic amounts or statuses are inserted.
 */
function reportingWindow(day) {
  return { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` };
}

async function reportingTotals(day, token = ownerTokenA, extra = {}) {
  const res = await request(app)
    .get("/orders/payments/totals")
    .set("Authorization", bearer(token))
    .query({ ...reportingWindow(day), ...extra });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

function assertReportingAmounts(actual, expected) {
  for (const [field, amount] of Object.entries(expected)) {
    assert.equal(typeof actual[field], "number", `${field} must be a JSON number`);
    assert.ok(Number.isFinite(actual[field]), `${field} must be finite`);
    assert.equal(actual[field], amount, `Incorrect ${field}`);
  }
}

function assertReportingTotals(actual, expected = {}) {
  assertReportingAmounts(actual, {
    cash_total: 0, card_total: 0, voucher_total: 0,
    grand_total: 0, voided_total: 0, refunded_total: 0,
    ...expected,
  });
}

async function stampReportingPayment(restaurantId, paymentId, timestamp) {
  const row = await one(`
    UPDATE public.payments SET created_at = $3::timestamptz
    WHERE restaurant_id = $1 AND id = $2
    RETURNING *
  `, [restaurantId, paymentId, timestamp]);
  assert.ok(row, "Timestamp fixture must target an existing tenant payment");
  if (Number(row.amount) > 0 && row.settlement_id) {
    const result = await query(`
      UPDATE public.payment_settlements SET created_at = $3::timestamptz
      WHERE restaurant_id = $1 AND id = $2::uuid
    `, [restaurantId, row.settlement_id, timestamp]);
    assert.equal(result.rowCount, 1);
  }
  return row;
}

async function createReportingSale({ table, day, method = "card", tenders, tenantB = false }) {
  const token = tenantB ? ownerTokenB : ownerTokenA;
  const restaurantId = tenantB ? fixtures.restaurantB : fixtures.restaurantA;
  const price = tenantB ? 99.99 : 12.5;
  const order = await createOrder({
    token, restaurantId, tableNumber: table,
    mealId: tenantB ? fixtures.mealB : fixtures.mealA,
    ...(tenantB ? { options: {}, expectedPrice: price } : {}),
  });
  const paid = await markPaid({
    token, tableNumber: table, itemIds: [Number(order.id)],
    paymentMethod: method,
    payments: tenders || [{ method, amount: price }],
  });
  assert.ok(is2xx(paid.status), JSON.stringify(paid.body));
  const ledger = await paymentsForTable(restaurantId, table);
  const originals = ledger.filter(row => Number(row.amount) > 0);
  assert.equal(originals.length, (tenders || [method]).length);
  const payments = [];
  for (const payment of originals) {
    payments.push(await stampReportingPayment(
      restaurantId, payment.id, `${day}T12:00:00.000Z`
    ));
  }
  assert.ok(payments[0].settlement_id, "API payment must have settlement identity");
  assert.ok(payments.every(p => p.settlement_id === payments[0].settlement_id));
  return { token, restaurantId, table, order, payments, settlementId: payments[0].settlement_id };
}

async function recordReportingRefund(sale, payment, amount, day, reason, time = "13:00:00.000") {
  const res = await request(app)
    .post(`/orders/payments/${payment.id}/refund`)
    .set("Authorization", bearer(sale.token))
    .send({ amount, reason });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.refund_amount, amount);
  assert.ok(res.body.payment_batch_id, "Refund response needs a batch identity");
  const rows = await all(`
    SELECT * FROM public.payments
    WHERE restaurant_id = $1 AND ref_payment_id = $2
      AND batch_id = $3::uuid AND amount < 0
  `, [sale.restaurantId, payment.id, res.body.payment_batch_id]);
  assert.equal(rows.length, 1, "One request must create one linked refund row");
  assert.equal(Number(rows[0].amount), -amount);
  assert.ok(rows[0].payment_uuid);
  assert.equal(rows[0].ref_payment_uuid, payment.payment_uuid);
  return stampReportingPayment(sale.restaurantId, rows[0].id, `${day}T${time}Z`);
}

async function reportingDetail(sale) {
  const res = await request(app)
    .get(`/orders/payment-settlements/${sale.settlementId}`)
    .set("Authorization", bearer(sale.token));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.payments));
  assert.ok(Array.isArray(res.body.refunds));
  return res.body;
}

async function reportingList(day, token, status) {
  const res = await request(app)
    .get("/orders/payment-settlements")
    .set("Authorization", bearer(token))
    .query({ ...reportingWindow(day), ...(status ? { status } : {}) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body));
  return res.body;
}

async function reportingLedgerSnapshot(sale) {
  return all(`
    SELECT to_jsonb(p) AS payment FROM public.payments p
    WHERE p.restaurant_id = $1
      AND (p.settlement_id = $2::uuid OR EXISTS (
        SELECT 1 FROM public.payments original
        WHERE original.restaurant_id = $1
          AND original.settlement_id = $2::uuid
          AND original.id = p.ref_payment_id
      ))
    ORDER BY p.id
  `, [sale.restaurantId, sale.settlementId]);
}

/*
 * =====================================================
 * SETUP
 * =====================================================
 */

test.before(async () => {
  assert.equal(process.env.NODE_ENV, "test", "Financial tests require NODE_ENV=test");
  assert.equal(process.env.MAKS_TEST_MODE, "1", "Financial tests require MAKS_TEST_MODE=1");

  // Verify the destructive-test target BEFORE calling reset or seed.
  const safe =
    await assertTestDatabase();

  assert.equal(
    safe.database,
    "maks_test",
    "FINANCIAL ATTACK REFUSED: database is not maks_test"
  );

  pool = safe.pool;

  await resetTestData();
  fixtures = await seedTestData();

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

    assert.equal(
      refund.status,
      409,
      "Over-refund must return a business-rule conflict"
    );

    assert.equal(
      refund.body?.code,
      "REFUND_EXCEEDS_REMAINING"
    );

    assert.equal(
      refund.body?.error,
      "Refund exceeds remaining refundable amount"
    );

    assert.ok(
      Number.isFinite(
        Number(
          refund.body?.max_refundable
        )
      ),
      "Over-refund response must expose max_refundable"
    );

    assert.ok(
      Number(
        refund.body?.max_refundable
      ) > 0,
      "max_refundable must be positive"
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

/* REPORTING A — signed ledger, partial/full status and per-refund audit history */
test("REPORTING: card refunds preserve the sale and expose exact linked history", async () => {
  const day = "2001-01-22";
  assertReportingTotals(await reportingTotals(day));
  const sale = await createReportingSale({ table: "Table 230", day });
  const original = sale.payments[0];
  const snapshot = await one(`
    SELECT to_jsonb(s) AS settlement FROM public.payment_settlements s
    WHERE s.restaurant_id = $1 AND s.id = $2::uuid
  `, [sale.restaurantId, sale.settlementId]);
  assertReportingTotals(await reportingTotals(day), { card_total: 12.5, grand_total: 12.5 });

  const first = await recordReportingRefund(sale, original, 5, day, "reporting partial reason");
  assertReportingTotals(await reportingTotals(day), {
    card_total: 7.5, grand_total: 7.5, refunded_total: 5,
  });
  let detail = await reportingDetail(sale);
  assert.equal(detail.settlement.status, "partially_refunded");
  assertReportingAmounts(detail.settlement, {
    original_payment_total: 12.5, refunded_total: 5, net_payment_total: 7.5, payment_total: 7.5,
  });
  assert.deepEqual(detail.payments.map(p => p.id), [Number(original.id)]);
  assert.equal(detail.refunds.length, 1);
  assert.equal(detail.refunds[0].payment_uuid, first.payment_uuid);
  assert.equal(detail.refunds[0].ref_payment_uuid, original.payment_uuid);
  assert.equal(detail.refunds[0].ref_payment_id, Number(original.id));
  assert.equal(detail.refunds[0].amount, -5);
  assert.equal(detail.refunds[0].method, "card");
  assert.equal(detail.refunds[0].created_at, `${day}T13:00:00.000Z`);
  assert.equal(detail.refunds[0].staff_user_id, Number(first.staff_user_id));
  assert.ok(detail.refunds[0].staff_name, "Recorded staff must be available");
  assert.equal(detail.refunds[0].reason, "reporting partial reason");
  const partialRows = await reportingList(day, sale.token, "refunded");
  assert.equal(partialRows.find(r => r.settlement_id === sale.settlementId)?.status, "partially_refunded");
  assert.ok(!(await reportingList(day, sale.token, "completed"))
    .some(r => r.settlement_id === sale.settlementId));

  const second = await recordReportingRefund(sale, original, 7.5, day, "reporting final reason", "14:00:00.000");
  assertReportingTotals(await reportingTotals(day), { refunded_total: 12.5 });
  detail = await reportingDetail(sale);
  assert.equal(detail.settlement.status, "refunded");
  assertReportingAmounts(detail.settlement, {
    original_payment_total: 12.5, refunded_total: 12.5, net_payment_total: 0, payment_total: 0,
  });
  assert.deepEqual(detail.payments.map(p => p.id), [Number(original.id)]);
  assert.equal(detail.payments[0].amount, 12.5, "The positive sale must survive a full refund");
  assert.deepEqual(detail.refunds.map(r => r.payment_uuid), [first.payment_uuid, second.payment_uuid]);
  assert.deepEqual(detail.refunds.map(r => r.reason), ["reporting partial reason", "reporting final reason"]);
  assert.equal((await reportingList(day, sale.token, "refunded"))
    .find(r => r.settlement_id === sale.settlementId)?.status, "refunded");

  const beforeReads = await reportingLedgerSnapshot(sale);
  await reportingDetail(sale);
  await reportingDetail(sale);
  await reportingTotals(day);
  assert.deepEqual(await reportingLedgerSnapshot(sale), beforeReads, "Reporting GETs must not mutate the ledger");
  assert.deepEqual(await one(`
    SELECT to_jsonb(s) AS settlement FROM public.payment_settlements s
    WHERE s.restaurant_id = $1 AND s.id = $2::uuid
  `, [sale.restaurantId, sale.settlementId]), snapshot, "Refunds must preserve the immutable sale snapshot");
});

/* REPORTING B — the physical 50p case, using the existing £12.50 fixture */
test("REPORTING: today's 50p refund against yesterday's sale reduces only today's takings", async () => {
  const yesterday = "2001-02-01", today = "2001-02-02";
  assertReportingTotals(await reportingTotals(yesterday));
  assertReportingTotals(await reportingTotals(today));
  const oldSale = await createReportingSale({ table: "Table 231", day: yesterday });
  await recordReportingRefund(oldSale, oldSale.payments[0], 12, yesterday, "prior-day refund");
  const currentSale = await createReportingSale({ table: "Table 232", day: today });
  const carryover = await recordReportingRefund(oldSale, oldSale.payments[0], 0.5, today, "last 50p from yesterday", "00:00:00.000");
  await recordReportingRefund(currentSale, currentSale.payments[0], 5, today, "current refund one");
  await recordReportingRefund(currentSale, currentSale.payments[0], 1, today, "current refund two", "14:00:00.000");
  await recordReportingRefund(currentSale, currentSale.payments[0], 5, today, "current refund three", "23:59:59.999");

  assertReportingTotals(await reportingTotals(yesterday), {
    card_total: 0.5, grand_total: 0.5, refunded_total: 12,
  });
  assertReportingTotals(await reportingTotals(today), {
    card_total: 1, grand_total: 1, refunded_total: 11.5,
  });
  const currentDetail = await reportingDetail(currentSale);
  assertReportingAmounts(currentDetail.settlement, {
    original_payment_total: 12.5, refunded_total: 11, net_payment_total: 1.5,
  });
  assert.equal(currentDetail.refunds.length, 3);
  assert.ok(!currentDetail.refunds.some(r => r.payment_uuid === carryover.payment_uuid), "Older sale's 50p must not appear under the new invoice");
  const oldDetail = await reportingDetail(oldSale);
  assert.equal(oldDetail.settlement.status, "refunded");
  assertReportingAmounts(oldDetail.settlement, { refunded_total: 12.5, net_payment_total: 0 });
  assert.ok(oldDetail.refunds.some(r => r.payment_uuid === carryover.payment_uuid));
  assertReportingTotals(await reportingTotals("2001-02-03"));
});

/* REPORTING C — each refund reduces its actual tender */
test("REPORTING: mixed cash/card refunds keep original tender IDs separate", async () => {
  const day = "2001-03-01";
  assertReportingTotals(await reportingTotals(day));
  const sale = await createReportingSale({ table: "Table 233", day,
    tenders: [{ method: "cash", amount: 5 }, { method: "card", amount: 7.5 }],
  });
  const cash = sale.payments.find(p => p.method === "cash");
  const card = sale.payments.find(p => p.method === "card");
  assert.ok(cash && card);
  await recordReportingRefund(sale, cash, 2, day, "cash return");
  await recordReportingRefund(sale, card, 3, day, "card return", "14:00:00.000");
  assertReportingTotals(await reportingTotals(day), {
    cash_total: 3, card_total: 4.5, grand_total: 7.5, refunded_total: 5,
  });
  const detail = await reportingDetail(sale);
  assert.equal(detail.settlement.status, "partially_refunded");
  assert.equal(detail.settlement.method, "mixed");
  assertReportingAmounts(detail.settlement, { original_payment_total: 12.5, refunded_total: 5, net_payment_total: 7.5 });
  assert.deepEqual(detail.payments.map(p => p.id).sort((a,b) => a-b),
    sale.payments.map(p => Number(p.id)).sort((a,b) => a-b));
  assert.equal(detail.refunds.length, 2);
  assert.equal(detail.refunds.find(r => r.method === "cash").ref_payment_id, Number(cash.id));
  assert.equal(detail.refunds.find(r => r.method === "card").ref_payment_id, Number(card.id));
});

/* REPORTING D — no tenant override or financial/audit disclosure */
test("ATTACK: reporting totals and refund detail remain tenant-scoped", async () => {
  const day = "2001-04-01";
  const a = await createReportingSale({ table: "Table 234", day });
  const b = await createReportingSale({ table: "Table 235", day, tenantB: true });
  await recordReportingRefund(a, a.payments[0], 2.5, day, "tenant A private reason");
  await recordReportingRefund(b, b.payments[0], 9.99, day, "tenant B private reason");
  assertReportingTotals(await reportingTotals(day, ownerTokenA, { restaurant_id: fixtures.restaurantB }), {
    card_total: 10, grand_total: 10, refunded_total: 2.5,
  });
  assertReportingTotals(await reportingTotals(day, ownerTokenB, { restaurant_id: fixtures.restaurantA }), {
    card_total: 90, grand_total: 90, refunded_total: 9.99,
  });
  for (const [token, foreignSale] of [[ownerTokenA, b], [ownerTokenB, a]]) {
    const res = await request(app)
      .get(`/orders/payment-settlements/${foreignSale.settlementId}`)
      .set("Authorization", bearer(token))
      .query({ restaurant_id: foreignSale.restaurantId });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.settlement, undefined);
    assert.equal(res.body.refunds, undefined);
  }
  assert.deepEqual((await reportingList(day, ownerTokenA, "refunded")).map(r => r.settlement_id), [a.settlementId]);
  assert.deepEqual((await reportingList(day, ownerTokenB, "refunded")).map(r => r.settlement_id), [b.settlementId]);
  assert.equal((await reportingDetail(a)).refunds[0].reason, "tenant A private reason");
  assert.equal((await reportingDetail(b)).refunds[0].reason, "tenant B private reason");
});

/* REPORTING E — preserve void history without treating it as takings/refund */
test("REPORTING: a voided positive payment is excluded from net and reported as voided", async () => {
  const day = "2001-05-01";
  const sale = await createReportingSale({ table: "Table 236", day, method: "cash" });
  assertReportingTotals(await reportingTotals(day), { cash_total: 12.5, grand_total: 12.5 });
  const res = await request(app)
    .post(`/orders/payments/${sale.payments[0].id}/void`)
    .set("Authorization", bearer(sale.token))
    .send({ reason: "reporting void fixture" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertReportingTotals(await reportingTotals(day), { voided_total: 12.5 });
  const detail = await reportingDetail(sale);
  assert.equal(detail.settlement.status, "voided");
  assertReportingAmounts(detail.settlement, { original_payment_total: 12.5, refunded_total: 0, net_payment_total: 0 });
  assert.equal(detail.payments[0].amount, 12.5);
  assert.equal(detail.refunds.length, 0);
});

/* REPORTING F — rejected refund attempts must leave every ledger value intact */
test("ATTACK: invalid and excessive partial refunds leave totals and history unchanged", async () => {
  const day = "2001-06-01";
  const sale = await createReportingSale({ table: "Table 237", day });
  const payment = sale.payments[0];
  await recordReportingRefund(sale, payment, 5, day, "valid partial refund");
  const before = await reportingLedgerSnapshot(sale);
  for (const amount of [0, -0.01, "not-money", 7.51]) {
    const res = await request(app)
      .post(`/orders/payments/${payment.id}/refund`)
      .set("Authorization", bearer(sale.token))
      .send({ amount, reason: "must be rejected" });
    assert.equal(res.status, amount === 7.51 ? 409 : 400, JSON.stringify(res.body));
    assert.equal(res.body.code, amount === 7.51 ? "REFUND_EXCEEDS_REMAINING" : "INVALID_REFUND_AMOUNT");
    if (amount === 7.51) assert.equal(res.body.max_refundable, 7.5);
    assert.deepEqual(await reportingLedgerSnapshot(sale), before);
  }
  assertReportingTotals(await reportingTotals(day), { card_total: 7.5, grand_total: 7.5, refunded_total: 5 });
  const detail = await reportingDetail(sale);
  assert.equal(detail.refunds.length, 1);
  assertReportingAmounts(detail.settlement, { refunded_total: 5, net_payment_total: 7.5 });
});

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