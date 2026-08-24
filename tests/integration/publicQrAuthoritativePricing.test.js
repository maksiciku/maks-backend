"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { resetTestData } = require("../setup/resetTestData");
const { seedTestData } = require("../setup/seedTestData");
const { assertTestDatabase } = require("../safety/assertTestDatabase");

let app;
let fixtures;
let pool;

let successfulBatchId = null;
let successfulPosOrderId = null;

/*
 * ============================================================
 * MAKS OS
 * PUBLIC QR AUTHORITATIVE PRICING + TENANT ISOLATION
 * ============================================================
 *
 * SECURITY CONTRACT:
 *
 * The public browser is UNTRUSTED.
 *
 * It may nominate:
 *   - restaurant URL
 *   - item ID
 *   - quantity
 *   - selected option IDs
 *
 * It MUST NOT control:
 *   - item ownership
 *   - item name
 *   - item price
 *   - final total
 *   - tenant ownership
 *   - KDS/batch ownership
 *
 * These tests intentionally submit malicious browser values.
 * ============================================================
 */

async function dbOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function dbAll(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows || [];
}

function qrOrderUrl(restaurantId) {
  return `/public/qr/${restaurantId}/order`;
}

function maliciousMealPayload(mealId, overrides = {}) {
  return {
    order_type: "takeaway",

    /*
     * These values are deliberately hostile.
     *
     * The backend MUST ignore browser-controlled
     * identity/pricing fields and rebuild the item
     * from the authoritative database.
     */
    items: [
      {
        meal_id: mealId,

        name: "HACKED QR BURGER",
        item_name: "HACKED QR BURGER",

        price: 0.01,
        unit_price: 0.01,
        total_price: 0.01,

        quantity: 1,

        item_type: "meals",
        category: "meals",

        options: {
  raw: {
    test_side: "test_chips",
  },
  display: {
    Side: "Chips",
  },
  meta: {},
},

        ...overrides,
      },
    ],
  };
}

test.before(async () => {
  /*
   * Both helpers independently enforce maks_test.
   */
  await resetTestData();
  fixtures = await seedTestData();

  /*
   * Obtain a separate DB handle for assertions.
   * This is still guarded by assertTestDatabase().
   */
  const safeDb = await assertTestDatabase();
  pool = safeDb.pool;

  /*
   * Import server only after test DB has been
   * positively confirmed and fixtures exist.
   */
  ({ app } = require("../../server"));

  assert.ok(
    app,
    "Express app was not exported from server.js"
  );

  assert.equal(
    safeDb.database,
    "maks_test",
    "SECURITY FAILURE: QR tests are not using maks_test"
  );
});

test.after(async () => {
  if (pool) {
    await pool.end();
  }
});

test(
  "QR fixtures really belong to different restaurants",
  async () => {
    const mealA = await dbOne(
      `
      SELECT id, restaurant_id, name, price
      FROM public.meals
      WHERE id = $1
      `,
      [fixtures.mealA]
    );

    const mealB = await dbOne(
      `
      SELECT id, restaurant_id, name, price
      FROM public.meals
      WHERE id = $1
      `,
      [fixtures.mealB]
    );

    assert.ok(mealA);
    assert.ok(mealB);

    assert.equal(
      Number(mealA.restaurant_id),
      fixtures.restaurantA
    );

    assert.equal(
      Number(mealB.restaurant_id),
      fixtures.restaurantB
    );

    assert.equal(
      Number(mealA.price),
      12.5
    );

    assert.equal(
      Number(mealB.price),
      99.99
    );

    assert.notEqual(
      Number(mealA.restaurant_id),
      Number(mealB.restaurant_id)
    );
  }
);

test(
  "Restaurant A public QR cannot order Restaurant B meal ID",
  async () => {
    const before = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.pos_orders
      WHERE restaurant_id = $1
      `,
      [fixtures.restaurantA]
    );

    const res = await request(app)
      .post(qrOrderUrl(fixtures.restaurantA))
      .send(
        maliciousMealPayload(
          fixtures.mealB
        )
      );

    assert.ok(
      res.status >= 400 && res.status < 500,
      `Expected cross-tenant QR item rejection, received ${res.status}: ${JSON.stringify(
        res.body
      )}`
    );

    const after = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.pos_orders
      WHERE restaurant_id = $1
      `,
      [fixtures.restaurantA]
    );

    assert.equal(
      Number(after?.cnt || 0),
      Number(before?.cnt || 0),
      "SECURITY FAILURE: rejected cross-tenant QR attack created POS rows"
    );
  }
);

test(
  "Restaurant B public QR cannot order Restaurant A meal ID",
  async () => {
    const before = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.pos_orders
      WHERE restaurant_id = $1
      `,
      [fixtures.restaurantB]
    );

    const res = await request(app)
      .post(qrOrderUrl(fixtures.restaurantB))
      .send(
        maliciousMealPayload(
          fixtures.mealA
        )
      );

    assert.ok(
      res.status >= 400 && res.status < 500,
      `Expected reverse cross-tenant QR rejection, received ${res.status}: ${JSON.stringify(
        res.body
      )}`
    );

    const after = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.pos_orders
      WHERE restaurant_id = $1
      `,
      [fixtures.restaurantB]
    );

    assert.equal(
      Number(after?.cnt || 0),
      Number(before?.cnt || 0),
      "SECURITY FAILURE: reverse cross-tenant QR attack created POS rows"
    );
  }
);

test(
  "QR browser cannot change Burger A from £12.50 to £0.01",
  async () => {
    const res = await request(app)
      .post(qrOrderUrl(fixtures.restaurantA))
      .send(
        maliciousMealPayload(
          fixtures.mealA
        )
      )
      .expect(201);

    assert.equal(
      res.body?.success,
      true
    );

    assert.ok(
      res.body?.batch_id,
      "QR order did not return batch_id"
    );

    successfulBatchId =
      String(res.body.batch_id);

    /*
     * Response itself must already expose
     * authoritative pricing.
     */
    assert.equal(
      Number(res.body?.subtotal),
      12.5
    );

    assert.equal(
      Number(res.body?.total),
      12.5
    );

    assert.ok(
      Array.isArray(res.body?.items)
    );

    assert.equal(
      res.body.items.length,
      1
    );

    const returned =
      res.body.items[0];

    assert.equal(
      Number(returned.meal_id),
      fixtures.mealA
    );

    assert.equal(
      returned.name,
      "TEST Burger A"
    );

    assert.equal(
      Number(returned.unit_price),
      12.5
    );

    assert.equal(
      Number(returned.total_price),
      12.5
    );

    assert.notEqual(
      returned.name,
      "HACKED QR BURGER"
    );

    assert.notEqual(
      Number(returned.unit_price),
      0.01
    );
  }
);

test(
  "QR POS database row stores authoritative identity and £12.50",
  async () => {
    assert.ok(
      successfulBatchId,
      "Successful QR batch was not created"
    );

    const rows = await dbAll(
      `
      SELECT
        id,
        restaurant_id,
        meal_id,
        menu_item_id,
        item_name,
        quantity,
        total_price,
        remaining_price,
        amount_paid,
        source,
        batch_id,
        paid,
        order_status
      FROM public.pos_orders
      WHERE batch_id = $1::uuid
      ORDER BY id ASC
      `,
      [successfulBatchId]
    );

    assert.equal(
      rows.length,
      1,
      `Expected exactly one QR POS row, found ${rows.length}`
    );

    const row = rows[0];

    successfulPosOrderId =
      Number(row.id);

    assert.equal(
      Number(row.restaurant_id),
      fixtures.restaurantA
    );

    assert.equal(
      Number(row.meal_id),
      fixtures.mealA
    );

    assert.equal(
      row.menu_item_id,
      null
    );

    assert.equal(
      row.item_name,
      "TEST Burger A"
    );

    assert.equal(
      Number(row.quantity),
      1
    );

    assert.equal(
      Number(row.total_price),
      12.5
    );

    assert.equal(
      Number(row.remaining_price),
      12.5
    );

    assert.equal(
      Number(row.amount_paid),
      0
    );

    assert.equal(
      String(row.source),
      "qr"
    );

    assert.equal(
      Boolean(row.paid),
      false
    );

    assert.notEqual(
      row.item_name,
      "HACKED QR BURGER"
    );

    assert.notEqual(
      Number(row.total_price),
      0.01
    );
  }
);

test(
  "QR batch belongs only to Restaurant A",
  async () => {
    const batch = await dbOne(
      `
      SELECT
        id,
        restaurant_id,
        table_number,
        order_type
      FROM public.order_batches
      WHERE id = $1::uuid
      `,
      [successfulBatchId]
    );

    assert.ok(
      batch,
      "QR order batch does not exist"
    );

    assert.equal(
      Number(batch.restaurant_id),
      fixtures.restaurantA
    );

    assert.notEqual(
      Number(batch.restaurant_id),
      fixtures.restaurantB
    );

    assert.equal(
      String(batch.order_type),
      "takeaway"
    );
  }
);

test(
  "fake browser item name never reaches persisted QR order",
  async () => {
    const row = await dbOne(
      `
      SELECT item_name
      FROM public.pos_orders
      WHERE id = $1
        AND restaurant_id = $2
      `,
      [
        successfulPosOrderId,
        fixtures.restaurantA,
      ]
    );

    assert.ok(row);

    assert.equal(
      row.item_name,
      "TEST Burger A"
    );

    assert.notEqual(
      row.item_name,
      "HACKED QR BURGER"
    );
  }
);

test(
  "nonexistent meal ID is rejected and creates no QR rows",
  async () => {
    const impossibleMealId = 999999999;

    const beforePos = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.pos_orders
      WHERE restaurant_id = $1
      `,
      [fixtures.restaurantA]
    );

    const beforeBatch = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.order_batches
      WHERE restaurant_id = $1
      `,
      [fixtures.restaurantA]
    );

    const res = await request(app)
      .post(qrOrderUrl(fixtures.restaurantA))
      .send(
        maliciousMealPayload(
          impossibleMealId
        )
      );

    assert.ok(
      res.status >= 400 && res.status < 500,
      `Expected nonexistent item rejection, received ${res.status}: ${JSON.stringify(
        res.body
      )}`
    );

    const afterPos = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.pos_orders
      WHERE restaurant_id = $1
      `,
      [fixtures.restaurantA]
    );

    const afterBatch = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.order_batches
      WHERE restaurant_id = $1
      `,
      [fixtures.restaurantA]
    );

    assert.equal(
      Number(afterPos?.cnt || 0),
      Number(beforePos?.cnt || 0),
      "Rejected nonexistent meal created POS order"
    );

    assert.equal(
      Number(afterBatch?.cnt || 0),
      Number(beforeBatch?.cnt || 0),
      "Rejected nonexistent meal created order batch"
    );
  }
);

test(
  "empty public QR cart is rejected",
  async () => {
    const res = await request(app)
      .post(qrOrderUrl(fixtures.restaurantA))
      .send({
        order_type: "takeaway",
        items: [],
      });

    assert.equal(
      res.status,
      400
    );
  }
);

test(
  "invalid restaurant cannot create public QR order",
  async () => {
    const res = await request(app)
      .post(
        qrOrderUrl(999999999)
      )
      .send(
        maliciousMealPayload(
          fixtures.mealA
        )
      );

    assert.ok(
      res.status >= 400,
      `Invalid restaurant unexpectedly succeeded: ${res.status}`
    );
  }
);

test(
  "Restaurant B contains no rows from Restaurant A successful QR batch",
  async () => {
    const foreignPos = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND batch_id = $2::uuid
      `,
      [
        fixtures.restaurantB,
        successfulBatchId,
      ]
    );

    const foreignBatch = await dbOne(
      `
      SELECT COUNT(*)::int AS cnt
      FROM public.order_batches
      WHERE restaurant_id = $1
        AND id = $2::uuid
      `,
      [
        fixtures.restaurantB,
        successfulBatchId,
      ]
    );

    assert.equal(
      Number(foreignPos?.cnt || 0),
      0,
      "SECURITY FAILURE: Restaurant A QR POS row leaked into Restaurant B"
    );

    assert.equal(
      Number(foreignBatch?.cnt || 0),
      0,
      "SECURITY FAILURE: Restaurant A QR batch leaked into Restaurant B"
    );
  }
);

test(
  "final QR database state preserves tenant ownership and authoritative pricing",
  async () => {
    const row = await dbOne(
      `
      SELECT
        po.restaurant_id,
        po.meal_id,
        po.item_name,
        po.total_price,
        po.remaining_price,
        po.source,
        ob.restaurant_id AS batch_restaurant_id
      FROM public.pos_orders po
      JOIN public.order_batches ob
        ON ob.id = po.batch_id
      WHERE po.id = $1
      `,
      [successfulPosOrderId]
    );

    assert.ok(row);

    assert.equal(
      Number(row.restaurant_id),
      fixtures.restaurantA
    );

    assert.equal(
      Number(row.batch_restaurant_id),
      fixtures.restaurantA
    );

    assert.equal(
      Number(row.meal_id),
      fixtures.mealA
    );

    assert.equal(
      row.item_name,
      "TEST Burger A"
    );

    assert.equal(
      Number(row.total_price),
      12.5
    );

    assert.equal(
      Number(row.remaining_price),
      12.5
    );

    assert.equal(
      row.source,
      "qr"
    );

    /*
     * Final explicit security assertions.
     */
    assert.notEqual(
      Number(row.restaurant_id),
      fixtures.restaurantB
    );

    assert.notEqual(
      row.item_name,
      "HACKED QR BURGER"
    );

    assert.notEqual(
      Number(row.total_price),
      0.01
    );
  }
);