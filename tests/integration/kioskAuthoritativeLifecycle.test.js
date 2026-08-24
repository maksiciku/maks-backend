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
// STATE
// =========================================================

let app;
let fixtures;
let pool;

let tokenA;
let tokenB;

let kioskBatchA = null;
let kioskPosOrderA = null;
let kioskPaymentA = null;
let kioskSettlementA = null;

// =========================================================
// HELPERS
// =========================================================

function bearer(token) {
  return `Bearer ${token}`;
}

function round2(value) {
  return (
    Math.round(
      (Number(value) || 0) * 100
    ) / 100
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

function expectBlocked(
  res,
  message
) {
  assert.ok(
    res.status < 200 ||
      res.status >= 300,
    `${message}\n` +
      `Received ${res.status}: ${JSON.stringify(
        res.body
      )}`
  );
}

/*
 * This deliberately mirrors the REAL KioskPage payload.
 *
 * Browser values are hostile on purpose.
 */
function kioskPayload(
  mealId,
  overrides = {}
) {
  return {
    table_number:
      "Takeaway",

    order_type:
      "takeaway",

    source:
      "kiosk",

    items: [
      {
        meal_id:
          mealId,

        menu_item_id:
          null,

        item_source:
          "meals",

        item_type:
          "meals",

        /*
         * ATTACK:
         * browser lies about identity
         */
        meal_name:
          "HACKED KIOSK BURGER",

        item_name:
          "HACKED KIOSK BURGER",

        /*
         * ATTACK:
         * browser lies about price
         */
        price:
          0.01,

        price_per_unit:
          0.01,

        total_price:
          0.01,

        quantity:
          1,

        category:
          "meals",

        /*
         * Valid required option.
         *
         * Burger A:
         * Side -> Chips -> +£0
         */
        options: {
          test_side:
            "test_chips",
        },

        /*
         * Browser display is NOT authority.
         */
        options_display: {
          Side:
            "HACKED FREE SIDE",
        },

        note:
          "",

        is_starred:
          false,

        ...overrides,
      },
    ],

    table_session: {
      allergy_codes: [],
      strict_cross_contamination:
        false,
      covers: 1,
    },

    takeaway_session: {
      allergy_codes: [],
      strict_cross_contamination:
        false,
    },

    kiosk_session: {
      allergy_codes: [],
      strict_cross_contamination:
        false,
      covers: 1,
    },

    kiosk_payment_method:
      "cash",

    voucher_id:
      null,

    voucher_code:
      null,

    voucher_discount:
      0,

    pricing_discount:
      0,

    pricing_applied_rules:
      [],
  };
}

// =========================================================
// SETUP
// =========================================================

test.before(async () => {
  /*
   * Both functions independently enforce maks_test.
   */
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
   * We are testing:
   *
   * - authoritative pricing
   * - kiosk hold
   * - KDS release
   * - payment
   * - tenant isolation
   *
   * NOT recipe stock math in this suite.
   *
   * Keep stock from interfering while preserving
   * hold_qr_kiosk_until_paid.
   */
  await query(
    `
    UPDATE public.restaurants
    SET
      selling_mode = 'pos_only',
      stock_deduction_enabled = FALSE,
      hold_qr_kiosk_until_paid = TRUE,
      portion_tracking_mode = 'off'
    WHERE id IN ($1, $2)
    `,
    [
      fixtures.restaurantA,
      fixtures.restaurantB,
    ]
  );

  /*
   * Import server only AFTER test DB safety
   * has been established.
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
    JSON.stringify(
      loginA.body
    )
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
    JSON.stringify(
      loginB.body
    )
  );

  tokenB =
    loginB.body?.token;

  assert.ok(tokenB);
});

test.after(async () => {
  if (pool) {
    await pool.end();
  }
});

// =========================================================
// 1. FIXTURE CHECK
// =========================================================

test(
  "kiosk fixtures belong to separate tenants with different prices",
  async () => {
    const result =
      await query(
        `
        SELECT
          id,
          restaurant_id,
          name,
          price
        FROM public.meals
        WHERE id IN ($1, $2)
        ORDER BY id
        `,
        [
          fixtures.mealA,
          fixtures.mealB,
        ]
      );

    assert.equal(
      result.rows.length,
      2
    );

    const mealA =
      result.rows.find(
        (row) =>
          Number(row.id) ===
          fixtures.mealA
      );

    const mealB =
      result.rows.find(
        (row) =>
          Number(row.id) ===
          fixtures.mealB
      );

    assert.equal(
      Number(
        mealA.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      round2(
        mealA.price
      ),
      12.5
    );

    assert.equal(
      Number(
        mealB.restaurant_id
      ),
      fixtures.restaurantB
    );

    assert.equal(
      round2(
        mealB.price
      ),
      99.99
    );
  }
);

// =========================================================
// 2. CROSS-TENANT ITEM ATTACK
// =========================================================

test(
  "Restaurant A kiosk cannot order Restaurant B meal ID",
  async () => {
    const before =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.pos_orders
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send(
          kioskPayload(
            fixtures.mealB
          )
        );

    expectBlocked(
      res,
      "SECURITY FAILURE: A kiosk ordered B meal"
    );

    const after =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.pos_orders
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        after.rows[0]?.count ||
          0
      ),
      Number(
        before.rows[0]?.count ||
          0
      ),
      "Cross-tenant kiosk attack created POS rows"
    );
  }
);

// =========================================================
// 3. REVERSE CROSS-TENANT ATTACK
// =========================================================

test(
  "Restaurant B kiosk cannot order Restaurant A meal ID",
  async () => {
    const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send(
          kioskPayload(
            fixtures.mealA
          )
        );

    expectBlocked(
      res,
      "SECURITY FAILURE: B kiosk ordered A meal"
    );
  }
);

// =========================================================
// 4. FORGED TENANT HEADER
// =========================================================

test(
  "Owner A cannot switch kiosk to Restaurant B using x-tenant-rid",
  async () => {
    const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .set(
          "x-tenant-rid",
          String(
            fixtures.restaurantB
          )
        )
        .send(
          kioskPayload(
            fixtures.mealB
          )
        );

    expectBlocked(
      res,
      "SECURITY FAILURE: forged x-tenant-rid switched kiosk tenant"
    );
  }
);

// =========================================================
// 5. £0.01 PRICE ATTACK
// =========================================================

test(
  "kiosk browser cannot change £12.50 Burger A to £0.01",
  async () => {
    const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send(
          kioskPayload(
            fixtures.mealA
          )
        );

    assert.equal(
      res.status,
      201,
      `Kiosk order failed: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.success,
      true
    );

    assert.ok(
      res.body?.batch_id,
      "Kiosk did not return batch_id"
    );

    kioskBatchA =
      String(
        res.body.batch_id
      );
  }
);

// =========================================================
// 6. DATABASE AUTHORITATIVE IDENTITY/PRICE
// =========================================================

test(
  "kiosk POS row stores authoritative Burger A identity and £12.50",
  async () => {
    const result =
      await query(
        `
        SELECT
          id,
          restaurant_id,
          batch_id,
          table_number,
          meal_id,
          menu_item_id,
          item_name,
          quantity,
          total_price,
          remaining_price,
          amount_paid,
          paid,
          source,
          order_status,
          expires_at,
          options
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        ORDER BY id
        `,
        [
          fixtures.restaurantA,
          kioskBatchA,
        ]
      );

    assert.equal(
      result.rows.length,
      1
    );

    kioskPosOrderA =
      result.rows[0];

    assert.equal(
      Number(
        kioskPosOrderA
          .restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      Number(
        kioskPosOrderA.meal_id
      ),
      fixtures.mealA
    );

    assert.equal(
      kioskPosOrderA.menu_item_id,
      null
    );

    assert.equal(
      kioskPosOrderA.item_name,
      "TEST Burger A"
    );

    assert.notEqual(
      kioskPosOrderA.item_name,
      "HACKED KIOSK BURGER"
    );

    assert.equal(
      Number(
        kioskPosOrderA.quantity
      ),
      1
    );

    assert.equal(
      round2(
        kioskPosOrderA
          .total_price
      ),
      12.5
    );

    assert.notEqual(
      round2(
        kioskPosOrderA
          .total_price
      ),
      0.01
    );

    assert.equal(
      round2(
        kioskPosOrderA
          .remaining_price
      ),
      12.5
    );

    assert.equal(
      round2(
        kioskPosOrderA
          .amount_paid
      ),
      0
    );

    assert.equal(
      Number(
        kioskPosOrderA.paid
      ),
      0
    );

    assert.equal(
      String(
        kioskPosOrderA.source
      ).toLowerCase(),
      "kiosk"
    );
  }
);

// =========================================================
// 7. PENDING-PAYMENT HOLD
// =========================================================

test(
  "unpaid kiosk order is pending_payment with an expiry",
  async () => {
    assert.equal(
      String(
        kioskPosOrderA
          .order_status
      ).toLowerCase(),
      "pending_payment"
    );

    assert.ok(
      kioskPosOrderA.expires_at,
      "Held kiosk order has no expiry"
    );

    const expires =
      new Date(
        kioskPosOrderA.expires_at
      ).getTime();

    const now =
      Date.now();

    assert.ok(
      Number.isFinite(expires)
    );

    /*
     * Current backend creates approximately
     * a 20-minute hold.
     *
     * Give wide boundaries so the test is not flaky.
     */
    assert.ok(
      expires >
        now + 10 * 60 * 1000,
      "Kiosk expiry is too soon"
    );

    assert.ok(
      expires <
        now + 30 * 60 * 1000,
      "Kiosk expiry is unexpectedly far away"
    );
  }
);

// =========================================================
// 8. ORDER BATCH OWNERSHIP + REQUESTED METHOD
// =========================================================

test(
  "kiosk batch belongs to Restaurant A and records requested cash payment",
  async () => {
    const result =
      await query(
        `
        SELECT
          id,
          restaurant_id,
          table_number,
          order_type,
          requested_payment_method
        FROM public.order_batches
        WHERE id = $1::uuid
        `,
        [
          kioskBatchA,
        ]
      );

    assert.equal(
      result.rows.length,
      1
    );

    const row =
      result.rows[0];

    assert.equal(
      Number(
        row.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      String(
        row.table_number
      ),
      "Takeaway"
    );

    assert.equal(
      String(
        row.order_type
      ).toLowerCase(),
      "takeaway"
    );

    assert.equal(
      String(
        row.requested_payment_method ||
          ""
      ).toLowerCase(),
      "cash"
    );
  }
);

// =========================================================
// 9. KDS MUST NOT RECEIVE UNPAID KIOSK ORDER
// =========================================================

test(
  "unpaid kiosk batch has not reached KDS",
  async () => {
    const result =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          kioskBatchA,
        ]
      );

    assert.equal(
      Number(
        result.rows[0]?.count ||
          0
      ),
      0,
      "SECURITY FAILURE: unpaid kiosk order reached KDS"
    );
  }
);

// =========================================================
// 10. CROSS-TENANT PAYMENT ATTACK
// =========================================================

test(
  "Restaurant B cannot pay Restaurant A kiosk order",
  async () => {
    const res =
      await request(app)
        .post(
          "/orders/mark-paid"
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send({
          tableNumber:
            "Takeaway",

          itemIds: [
            Number(
              kioskPosOrderA.id
            ),
          ],

          paymentMethod:
            "cash",

          manualDiscountAmount:
            0,

          serviceChargeAmount:
            0,
        });

    expectBlocked(
      res,
      "SECURITY FAILURE: B paid A kiosk bill"
    );

    const row =
      await query(
        `
        SELECT
          paid,
          remaining_price
        FROM public.pos_orders
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          kioskPosOrderA.id,
          fixtures.restaurantA,
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
          .remaining_price
      ),
      12.5
    );
  }
);

// =========================================================
// 11. KIOSK UNDERPAYMENT ATTACK
// =========================================================

test(
  "£0.01 cannot settle £12.50 kiosk order",
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
              kioskPosOrderA.id
            ),
          ],

          payments: [
            {
              method:
                "cash",

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
      `Underpayment wasn't blocked: ${JSON.stringify(
        res.body
      )}`
    );

    const row =
      await query(
        `
        SELECT
          paid,
          remaining_price
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          kioskPosOrderA.id,
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
          .remaining_price
      ),
      12.5
    );

    /*
     * Failed payment MUST NOT release KDS.
     */
    const kds =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          kioskBatchA,
        ]
      );

    assert.equal(
      Number(
        kds.rows[0]?.count ||
          0
      ),
      0
    );
  }
);

// =========================================================
// 12. LEGITIMATE KIOSK PAYMENT
// =========================================================

test(
  "Restaurant A can settle its £12.50 kiosk bill",
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
              kioskPosOrderA.id
            ),
          ],

          paymentMethod:
            "cash",

          manualDiscountAmount:
            0,

          serviceChargeAmount:
            0,

          terminalRef:
            "TEST-KIOSK-CASH",
        });

    assert.equal(
      res.status,
      200,
      `Kiosk payment failed: ${JSON.stringify(
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

    assert.ok(
      Array.isArray(
        res.body?.payment_ids
      )
    );

    assert.equal(
      res.body.payment_ids.length,
      1
    );

    kioskPaymentA =
      Number(
        res.body.payment_ids[0]
      );

    assert.ok(
      kioskPaymentA > 0
    );

    kioskSettlementA =
      String(
        res.body
          ?.settlement_id ||
          ""
      );

    assert.ok(
      kioskSettlementA
    );
  }
);

// =========================================================
// 13. PAYMENT MUST RELEASE KDS
// =========================================================

test(
  "successful kiosk payment releases batch to KDS exactly once",
  async () => {
    const rows =
      await query(
        `
        SELECT
          id,
          restaurant_id,
          table_number,
          meal_name,
          quantity,
          price_per_unit,
          total_price,
          order_status,
          batch_id
        FROM public.orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        ORDER BY id
        `,
        [
          fixtures.restaurantA,
          kioskBatchA,
        ]
      );

    assert.equal(
      rows.rows.length,
      1,
      `Expected one KDS row after payment, received ${rows.rows.length}`
    );

    const row =
      rows.rows[0];

    assert.equal(
      Number(
        row.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      row.meal_name,
      "TEST Burger A"
    );

    assert.equal(
      Number(
        row.quantity
      ),
      1
    );

    assert.equal(
      round2(
        row.total_price
      ),
      12.5
    );

    assert.equal(
      String(
        row.order_status
      ).toLowerCase(),
      "pending"
    );
  }
);

// =========================================================
// 14. POS HOLD MUST BECOME OPEN + PAID
// =========================================================

test(
  "paid kiosk POS row is reconciled and no longer pending_payment",
  async () => {
    const result =
      await query(
        `
        SELECT
          paid,
          total_price,
          amount_paid,
          remaining_price,
          order_status,
          expires_at,
          invoice_number
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          kioskPosOrderA.id,
        ]
      );

    assert.equal(
      result.rows.length,
      1
    );

    const row =
      result.rows[0];

    assert.equal(
      Number(row.paid),
      1
    );

    assert.equal(
      round2(
        row.total_price
      ),
      12.5
    );

    assert.equal(
      round2(
        row.amount_paid
      ),
      12.5
    );

    assert.equal(
      round2(
        row.remaining_price
      ),
      0
    );

    assert.equal(
      String(
        row.order_status
      ).toLowerCase(),
      "open"
    );

    assert.equal(
      row.expires_at,
      null
    );

    assert.ok(
      Number(
        row.invoice_number
      ) > 0
    );
  }
);

// =========================================================
// 15. DOUBLE PAYMENT MUST FAIL
// =========================================================

test(
  "same kiosk order cannot be paid twice",
  async () => {
    const kdsBefore =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          kioskBatchA,
        ]
      );

    const paymentBefore =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.payments
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
              kioskPosOrderA.id
            ),
          ],

          paymentMethod:
            "cash",

          manualDiscountAmount:
            0,

          serviceChargeAmount:
            0,
        });

    expectBlocked(
      res,
      "SECURITY FAILURE: kiosk order paid twice"
    );

    const kdsAfter =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          kioskBatchA,
        ]
      );

    const paymentAfter =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.payments
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        kdsAfter.rows[0].count
      ),
      Number(
        kdsBefore.rows[0].count
      ),
      "Duplicate payment duplicated KDS release"
    );

    assert.equal(
      Number(
        paymentAfter.rows[0].count
      ),
      Number(
        paymentBefore.rows[0].count
      ),
      "Duplicate payment created another tender"
    );
  }
);

// =========================================================
// 16. FINANCIAL TENANT OWNERSHIP
// =========================================================

test(
  "kiosk payment and settlement belong only to Restaurant A",
  async () => {
    const payment =
      await query(
        `
        SELECT
          id,
          restaurant_id,
          amount,
          status,
          settlement_id
        FROM public.payments
        WHERE id = $1
        `,
        [
          kioskPaymentA,
        ]
      );

    assert.equal(
      payment.rows.length,
      1
    );

    assert.equal(
      Number(
        payment.rows[0]
          .restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      round2(
        payment.rows[0]
          .amount
      ),
      12.5
    );

    assert.equal(
      String(
        payment.rows[0]
          .status
      ).toLowerCase(),
      "completed"
    );

    assert.equal(
      String(
        payment.rows[0]
          .settlement_id
      ),
      kioskSettlementA
    );

    const settlement =
      await query(
        `
        SELECT
          id,
          restaurant_id,
          gross_amount,
          final_amount
        FROM public.payment_settlements
        WHERE id = $1::uuid
        `,
        [
          kioskSettlementA,
        ]
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
// 17. RESTAURANT B MUST CONTAIN NOTHING FROM A'S KIOSK
// =========================================================

test(
  "Restaurant B contains no rows from Restaurant A kiosk batch",
  async () => {
    const pos =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [
          fixtures.restaurantB,
          kioskBatchA,
        ]
      );

    const kds =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [
          fixtures.restaurantB,
          kioskBatchA,
        ]
      );

    const batch =
      await query(
        `
        SELECT COUNT(*)::int AS count
        FROM public.order_batches
        WHERE restaurant_id = $1
          AND id = $2::uuid
        `,
        [
          fixtures.restaurantB,
          kioskBatchA,
        ]
      );

    assert.equal(
      Number(
        pos.rows[0]?.count ||
          0
      ),
      0
    );

    assert.equal(
      Number(
        kds.rows[0]?.count ||
          0
      ),
      0
    );

    assert.equal(
      Number(
        batch.rows[0]?.count ||
          0
      ),
      0
    );
  }
);

// =========================================================
// 18. FINAL COMMERCIAL INVARIANTS
// =========================================================

test(
  "final kiosk lifecycle preserves price, tenant and single KDS release",
  async () => {
    const result =
      await query(
        `
        SELECT
          po.restaurant_id,
          po.meal_id,
          po.item_name,
          po.total_price,
          po.amount_paid,
          po.remaining_price,
          po.source,
          po.order_status,

          ob.restaurant_id
            AS batch_restaurant_id,

          (
            SELECT COUNT(*)
            FROM public.orders o
            WHERE
              o.restaurant_id =
                po.restaurant_id
              AND
              o.batch_id =
                po.batch_id
          )::int
            AS kds_rows

        FROM public.pos_orders po

        JOIN public.order_batches ob
          ON ob.id = po.batch_id

        WHERE po.id = $1
        `,
        [
          kioskPosOrderA.id,
        ]
      );

    assert.equal(
      result.rows.length,
      1
    );

    const row =
      result.rows[0];

    assert.equal(
      Number(
        row.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      Number(
        row.batch_restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      Number(
        row.meal_id
      ),
      fixtures.mealA
    );

    assert.equal(
      row.item_name,
      "TEST Burger A"
    );

    assert.equal(
      round2(
        row.total_price
      ),
      12.5
    );

    assert.equal(
      round2(
        row.amount_paid
      ),
      12.5
    );

    assert.equal(
      round2(
        row.remaining_price
      ),
      0
    );

    assert.equal(
      row.source,
      "kiosk"
    );

    assert.equal(
      String(
        row.order_status
      ).toLowerCase(),
      "open"
    );

    assert.equal(
      Number(
        row.kds_rows
      ),
      1
    );
  }
);