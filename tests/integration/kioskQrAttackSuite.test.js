"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { resetTestData } =
  require("../setup/resetTestData");

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

async function one(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
}

async function countRows(table, rid) {
  return Number(
    (
      await one(
        `SELECT COUNT(*)::int AS cnt
         FROM public."${table}"
         WHERE restaurant_id = $1`,
        [rid]
      )
    )?.cnt || 0
  );
}

function validOptions() {
  return {
    test_side: "test_chips",
  };
}

function kioskItem(mealId, overrides = {}) {
  return {
    meal_id: mealId,
    menu_item_id: null,
    item_source: "meals",
    item_type: "meals",

    // hostile browser claims
    meal_name: "ATTACK NAME",
    item_name: "ATTACK NAME",

    price: 0.01,
    price_per_unit: 0.01,
    total_price: 0.01,

    quantity: 1,

    options: validOptions(),

    ...overrides,
  };
}

function kioskBody(mealId, overrides = {}) {
  return {
    table_number: "Takeaway",
    order_type: "takeaway",
    source: "kiosk",

    items: [
      kioskItem(mealId),
    ],

    kiosk_session: {
      allergy_codes: [],
      strict_cross_contamination: false,
      covers: 1,
    },

    kiosk_payment_method: "cash",

    ...overrides,
  };
}

test.before(async () => {
  await resetTestData();
  fixtures = await seedTestData();

  const safe = await assertTestDatabase();

  assert.equal(
    safe.database,
    "maks_test",
    "ATTACK TEST REFUSED: not maks_test"
  );

  pool = safe.pool;

  // Keep this suite focused on hostile request handling.
  await pool.query(
    `
    UPDATE public.restaurants
    SET
      selling_mode = 'pos_only',
      stock_deduction_enabled = FALSE,
      hold_qr_kiosk_until_paid = TRUE,
      portion_tracking_mode = 'off'
    WHERE id IN ($1,$2)
    `,
    [
      fixtures.restaurantA,
      fixtures.restaurantB,
    ]
  );

  ({ app } = require("../../server"));

  const a = await request(app)
    .post("/auth/login")
    .send({
      username: "maks_test_owner_a",
      password: TEST_PASSWORD,
      restaurant_id: fixtures.restaurantA,
    });

  assert.equal(a.status, 200);
  tokenA = a.body.token;

  const b = await request(app)
    .post("/auth/login")
    .send({
      username: "maks_test_owner_b",
      password: TEST_PASSWORD,
      restaurant_id: fixtures.restaurantB,
    });

  assert.equal(b.status, 200);
  tokenB = b.body.token;
});

test.after(async () => {
  if (pool) await pool.end();
});

/*
 * =========================================================
 * ATTACK 1 — FOREIGN TENANT ITEM
 * =========================================================
 */

test(
  "ATTACK: Restaurant A cannot inject Restaurant B meal into kiosk",
  async () => {
    const before =
      await countRows(
        "pos_orders",
        fixtures.restaurantA
      );

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(
        kioskBody(
          fixtures.mealB
        )
      );

    assert.ok(
      res.status >= 400,
      `Foreign meal attack succeeded: ${res.status}`
    );

    const after =
      await countRows(
        "pos_orders",
        fixtures.restaurantA
      );

    assert.equal(
      after,
      before,
      "Foreign tenant attack created an order"
    );
  }
);

/*
 * =========================================================
 * ATTACK 2 — FORGED TENANT HEADER
 * =========================================================
 */

test(
  "ATTACK: x-tenant-rid cannot switch authenticated kiosk tenant",
  async () => {
    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .set(
        "x-tenant-rid",
        String(fixtures.restaurantB)
      )
      .send(
        kioskBody(
          fixtures.mealB
        )
      );

    assert.ok(
      res.status >= 400,
      "Forged tenant header was accepted"
    );
  }
);

/*
 * =========================================================
 * ATTACK 3 — BODY RESTAURANT_ID SPOOF
 * =========================================================
 */

test(
  "ATTACK: body restaurant_id cannot override authenticated tenant",
  async () => {
    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(
        kioskBody(
          fixtures.mealB,
          {
            restaurant_id:
              fixtures.restaurantB,
          }
        )
      );

    assert.ok(
      res.status >= 400,
      "Body restaurant_id switched tenant"
    );
  }
);

/*
 * =========================================================
 * ATTACK 4 — £0.01 PRICE
 * =========================================================
 */

test(
  "ATTACK: forged £0.01 price becomes authoritative £12.50",
  async () => {
    const res = await request(app)
      .post("/orders/grouped")
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
      JSON.stringify(res.body)
    );

    const row = await one(
      `
      SELECT
        item_name,
        total_price,
        remaining_price,
        source,
        order_status
      FROM public.pos_orders
      WHERE restaurant_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [fixtures.restaurantA]
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
      "kiosk"
    );

    assert.equal(
      row.order_status,
      "pending_payment"
    );
  }
);

/*
 * =========================================================
 * ATTACK 5 — FAKE OPTION ID
 * =========================================================
 */

test(
  "ATTACK: nonexistent option choice is rejected",
  async () => {
    const before =
      await countRows(
        "pos_orders",
        fixtures.restaurantA
      );

    const body =
      kioskBody(
        fixtures.mealA
      );

    body.items[0].options = {
      test_side:
        "FREE_STEAK_ATTACK",
    };

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(body);

    assert.ok(
      res.status >= 400,
      `Fake option was accepted: ${JSON.stringify(
        res.body
      )}`
    );

    const after =
      await countRows(
        "pos_orders",
        fixtures.restaurantA
      );

    assert.equal(after, before);
  }
);

/*
 * =========================================================
 * ATTACK 6 — OMIT REQUIRED OPTION
 * =========================================================
 */

test(
  "ATTACK: required Side option cannot be bypassed",
  async () => {
    const body =
      kioskBody(
        fixtures.mealA
      );

    body.items[0].options = {};

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(body);

    assert.ok(
      res.status >= 400,
      "Required option bypass succeeded"
    );
  }
);

/*
 * =========================================================
 * ATTACK 7 — FAKE OPTION PRICE
 * =========================================================
 */

test(
  "ATTACK: browser cannot invent option priceDelta",
  async () => {
    const body =
      kioskBody(
        fixtures.mealA
      );

    body.items[0].options = {
      raw: {
        test_side:
          "test_salad",
      },

      display: {
        Side: "Salad",
      },

      meta: {
        test_side: {
          priceDelta:
            -1000,
        },
      },
    };

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(body);

    /*
     * Either:
     *  - backend accepts raw option IDs and ignores meta
     *  - or rejects wrapper shape
     *
     * It must NEVER accept the -£1000 browser price.
     */
    if (
      res.status >= 200 &&
      res.status < 300
    ) {
      const row = await one(
        `
        SELECT total_price
        FROM public.pos_orders
        WHERE restaurant_id = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [fixtures.restaurantA]
      );

      /*
       * Salad is £12.50 + £1.50 = £14.00
       */
      assert.equal(
        Number(row.total_price),
        14
      );
    } else {
      assert.ok(
        res.status >= 400
      );
    }
  }
);

/*
 * =========================================================
 * ATTACK 8 — ZERO QUANTITY
 * =========================================================
 */

test(
  "ATTACK: quantity zero cannot create a free order",
  async () => {
    const body =
      kioskBody(
        fixtures.mealA
      );

    body.items[0].quantity = 0;

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(body);

    if (
      res.status >= 200 &&
      res.status < 300
    ) {
      const row = await one(
        `
        SELECT
          quantity,
          total_price
        FROM public.pos_orders
        WHERE restaurant_id = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [fixtures.restaurantA]
      );

      assert.ok(
        Number(row.quantity) >= 1
      );

      assert.ok(
        Number(row.total_price) >= 12.5
      );
    } else {
      assert.ok(
        res.status >= 400
      );
    }
  }
);

/*
 * =========================================================
 * ATTACK 9 — NEGATIVE QUANTITY
 * =========================================================
 */

test(
  "ATTACK: negative quantity cannot create negative/free bill",
  async () => {
    const body =
      kioskBody(
        fixtures.mealA
      );

    body.items[0].quantity = -500;

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(body);

    if (
      res.status >= 200 &&
      res.status < 300
    ) {
      const row = await one(
        `
        SELECT
          quantity,
          total_price,
          remaining_price
        FROM public.pos_orders
        WHERE restaurant_id = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [fixtures.restaurantA]
      );

      assert.ok(
        Number(row.quantity) >= 1
      );

      assert.ok(
        Number(row.total_price) >= 0
      );

      assert.ok(
        Number(row.remaining_price) >= 0
      );
    } else {
      assert.ok(
        res.status >= 400
      );
    }
  }
);

/*
 * =========================================================
 * ATTACK 10 — HUGE QUANTITY
 * =========================================================
 */

test(
  "ATTACK: absurd quantity cannot corrupt monetary state",
  async () => {
    const body =
      kioskBody(
        fixtures.mealA
      );

    body.items[0].quantity =
      999999999;

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(body);

    /*
     * Rejection is ideal.
     *
     * If accepted, totals must still never become
     * negative, NaN or infinity.
     */
    if (
      res.status >= 200 &&
      res.status < 300
    ) {
      const row = await one(
        `
        SELECT
          quantity,
          total_price,
          remaining_price
        FROM public.pos_orders
        WHERE restaurant_id = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [fixtures.restaurantA]
      );

      assert.ok(
        Number.isFinite(
          Number(row.total_price)
        )
      );

      assert.ok(
        Number(row.total_price) >= 0
      );

      assert.ok(
        Number(row.remaining_price) >= 0
      );
    } else {
      assert.ok(
        res.status >= 400
      );
    }
  }
);

/*
 * =========================================================
 * ATTACK 11 — SOURCE SPOOFING
 * =========================================================
 */

test(
  "ATTACK: kiosk cannot use source spoofing to bypass hold-until-paid",
  async () => {
    const beforeKds =
      await countRows(
        "orders",
        fixtures.restaurantA
      );

    const body =
      kioskBody(
        fixtures.mealA,
        {
          source: "kiosk",
        }
      );

    /*
     * Browser also tries injecting POS-like fields.
     */
    body.is_paid = true;
    body.paid = true;
    body.order_status = "open";
    body.hold_until_paid = false;

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(body);

    assert.equal(
      res.status,
      201
    );

    const latest =
      await one(
        `
        SELECT
          paid,
          source,
          order_status
        FROM public.pos_orders
        WHERE restaurant_id = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [fixtures.restaurantA]
      );

    assert.equal(
      Number(latest.paid),
      0
    );

    assert.equal(
      latest.source,
      "kiosk"
    );

    assert.equal(
      latest.order_status,
      "pending_payment"
    );

    const afterKds =
      await countRows(
        "orders",
        fixtures.restaurantA
      );

    assert.equal(
      afterKds,
      beforeKds,
      "Browser forced unpaid kiosk order into KDS"
    );
  }
);

/*
 * =========================================================
 * ATTACK 12 — PUBLIC QR CROSS-TENANT
 * =========================================================
 */

test(
  "ATTACK: anonymous QR A cannot nominate B meal",
  async () => {
    const before =
      await countRows(
        "pos_orders",
        fixtures.restaurantA
      );

    const res = await request(app)
      .post(
        `/public/qr/${fixtures.restaurantA}/order`
      )
      .send({
        order_type:
          "takeaway",

        items: [
          {
            meal_id:
              fixtures.mealB,

            quantity: 1,

            price:
              0.01,

            name:
              "FOREIGN QR ATTACK",

            options: {
              test_side:
                "test_chips",
            },
          },
        ],
      });

    assert.ok(
      res.status >= 400
    );

    const after =
      await countRows(
        "pos_orders",
        fixtures.restaurantA
      );

    assert.equal(after, before);
  }
);

/*
 * =========================================================
 * ATTACK 13 — INVALID ITEM ID
 * =========================================================
 */

test(
  "ATTACK: fake meal ID creates no batch and no POS row",
  async () => {
    const beforePos =
      await countRows(
        "pos_orders",
        fixtures.restaurantA
      );

    const beforeBatch =
      await countRows(
        "order_batches",
        fixtures.restaurantA
      );

    const res = await request(app)
      .post("/orders/grouped")
      .set(
        "Authorization",
        auth(tokenA)
      )
      .send(
        kioskBody(
          999999999
        )
      );

    assert.ok(
      res.status >= 400
    );

    assert.equal(
      await countRows(
        "pos_orders",
        fixtures.restaurantA
      ),
      beforePos
    );

    assert.equal(
      await countRows(
        "order_batches",
        fixtures.restaurantA
      ),
      beforeBatch
    );
  }
);

/*
 * =========================================================
 * ATTACK 14 — FINAL NEGATIVE-BALANCE CHECK
 * =========================================================
 */

test(
  "ATTACK FINAL: no Restaurant A monetary balance became negative",
  async () => {
    const row = await one(
      `
      SELECT COUNT(*)::int AS bad
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND (
          COALESCE(total_price,0) < 0
          OR
          COALESCE(remaining_price,0) < 0
          OR
          COALESCE(amount_paid,0) < 0
        )
      `,
      [
        fixtures.restaurantA,
      ]
    );

    assert.equal(
      Number(row?.bad || 0),
      0,
      "SECURITY FAILURE: negative monetary state exists"
    );
  }
);

/*
 * =========================================================
 * ATTACK 15 — FINAL TENANT CONTAMINATION CHECK
 * =========================================================
 */

test(
  "ATTACK FINAL: no Restaurant B row contains Restaurant A meal",
  async () => {
    const row = await one(
      `
      SELECT COUNT(*)::int AS bad
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND meal_id = $2
      `,
      [
        fixtures.restaurantB,
        fixtures.mealA,
      ]
    );

    assert.equal(
      Number(row?.bad || 0),
      0,
      "SECURITY FAILURE: cross-tenant contamination detected"
    );
  }
);