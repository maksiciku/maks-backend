"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const request =
  require("supertest");

const bcrypt =
  require("bcryptjs");

const {
  resetTestData,
} =
  require("../setup/resetTestData");

const {
  seedTestData,
  TEST_PASSWORD,
} =
  require("../setup/seedTestData");

const {
  assertTestDatabase,
} =
  require("../safety/assertTestDatabase");

let app;
let pool;
let fixtures;

let tokenA;
let tokenB;

const MANAGER_PIN =
  "2468";

function bearer(token) {
  return `Bearer ${token}`;
}

function money(value) {
  return Number(
    Number(
      value || 0
    ).toFixed(2)
  );
}

function is2xx(status) {
  return (
    status >= 200 &&
    status < 300
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
    await query(
      sql,
      params
    );

  return result.rows || [];
}

async function ensureTable(
  tableName
) {
  let table =
    await one(
      `
      SELECT
        id,
        name
      FROM public.tables
      WHERE restaurant_id = $1
        AND LOWER(TRIM(name)) =
            LOWER(TRIM($2))
      LIMIT 1
      `,
      [
        fixtures.restaurantA,
        tableName,
      ]
    );

  if (!table) {
    table =
      await one(
        `
        INSERT INTO public.tables
        (
          restaurant_id,
          name,
          seats,
          status
        )
        VALUES
        (
          $1,
          $2,
          4,
          'free'
        )
        RETURNING
          id,
          name
        `,
        [
          fixtures.restaurantA,
          tableName,
        ]
      );
  }

  const map =
    await one(
      `
      SELECT id
      FROM public.table_map
      WHERE restaurant_id = $1
        AND LOWER(TRIM(name)) =
            LOWER(TRIM($2))
      LIMIT 1
      `,
      [
        fixtures.restaurantA,
        tableName,
      ]
    );

  if (!map) {
    await query(
      `
      INSERT INTO public.table_map
      (
        restaurant_id,
        name,
        x,
        y,
        seats,
        status,
        zone,
        shape
      )
      VALUES
      (
        $1,
        $2,
        0,
        0,
        4,
        'free',
        'Main',
        'square'
      )
      `,
      [
        fixtures.restaurantA,
        tableName,
      ]
    );
  }

  return table;
}

function orderBody(
  tableName
) {
  return {
    table_number:
      tableName,

    order_type:
      "dine-in",

    source:
      "pos",

    items: [
      {
        meal_id:
          fixtures.mealA,

        item_source:
          "meals",

        item_type:
          "meals",

        meal_name:
          "INVALID CLIENT NAME",

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
  };
}

async function createOrder(
  tableName
) {
  await ensureTable(
    tableName
  );

  const response =
    await request(app)
      .post(
        "/orders/grouped"
      )
      .set(
        "Authorization",
        bearer(tokenA)
      )
      .send(
        orderBody(
          tableName
        )
      );

  assert.equal(
    response.status,
    201,
    `${
      response.status
    } ${JSON.stringify(
      response.body
    )}`
  );

  const row =
    await one(
      `
      SELECT
        id,
        restaurant_id,
        table_number,
        batch_id,
        total_price,
        amount_paid,
        remaining_price,
        paid,
        order_status
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND LOWER(TRIM(table_number)) =
            LOWER(TRIM($2))
      ORDER BY id DESC
      LIMIT 1
      `,
      [
        fixtures.restaurantA,
        tableName,
      ]
    );

  assert.ok(row);

  return row;
}

async function getOrder(id) {
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
      order_status
    FROM public.pos_orders
    WHERE restaurant_id = $1
      AND id = $2
    `,
    [
      fixtures.restaurantA,
      Number(id),
    ]
  );
}

async function positivePayments(
  orderId
) {
  return all(
    `
    SELECT
      id,
      amount,
      status
    FROM public.payments
    WHERE restaurant_id = $1

      AND pos_order_ids @>
          to_jsonb(
            ARRAY[
              $2::bigint
            ]
          )

      AND amount > 0

    ORDER BY id
    `,
    [
      fixtures.restaurantA,
      Number(orderId),
    ]
  );
}

async function markPaid(
  row
) {
  return request(app)
    .post(
      "/orders/mark-paid"
    )
    .set(
      "Authorization",
      bearer(tokenA)
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

          amount:
            money(
              row.remaining_price
            ),
        },
      ],
    });
}

async function payShare(
  tableName,
  amount
) {
  return request(app)
    .post(
      "/orders/pay-share"
    )
    .set(
      "Authorization",
      bearer(tokenA)
    )
    .send({
      tableNumber:
        tableName,

      amount,

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

async function voidUnpaid(
  tableName,
  token = tokenA
) {
  return request(app)
    .post(
      `/orders/void-unpaid/${encodeURIComponent(
        tableName
      )}`
    )
    .set(
      "Authorization",
      bearer(token)
    )
    .send({
      reason:
        "Regression lifecycle test",

      manager_pin:
        MANAGER_PIN,
    });
}

async function voidItem(
  tableName,
  orderId,
  token = tokenA
) {
  return request(app)
    .post(
      "/orders/void-items"
    )
    .set(
      "Authorization",
      bearer(token)
    )
    .send({
      tableNumber:
        tableName,

      itemIds: [
        Number(orderId),
      ],

      reason:
        "Regression item void",

      manager_pin:
        MANAGER_PIN,
    });
}

async function closeTable(
  tableName,
  token = tokenA
) {
  return request(app)
    .post(
      "/orders/close"
    )
    .set(
      "Authorization",
      bearer(token)
    )
    .send({
      table_number:
        tableName,

      close_reason:
        "Regression unpaid close",

      manager_pin:
        MANAGER_PIN,
    });
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
      "VOID/CLOSE REGRESSION REFUSED: wrong database"
    );

    pool =
      safe.pool;

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

    /*
     * Give the seeded Restaurant A owner a known test PIN.
     *
     * This exists ONLY inside maks_test.
     */
    const pinHash =
      bcrypt.hashSync(
        MANAGER_PIN,
        10
      );

    await query(
      `
      UPDATE public.users
      SET
        pin_hash = $1,
        can_pos_login = TRUE,
        is_active = TRUE
      WHERE username =
            'maks_test_owner_a'
      `,
      [
        pinHash,
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
 * 1. PAID ITEM CANNOT BE VOIDED
 * =====================================================
 */

test(
  "VOID: paid item is immune to item void",
  async () => {
    const table =
      "Table 501";

    const row =
      await createOrder(
        table
      );

    const paid =
      await markPaid(
        row
      );

    assert.ok(
      is2xx(
        paid.status
      )
    );

    const result =
      await voidItem(
        table,
        row.id
      );

    assert.ok(
      result.status >= 400
    );

    const after =
      await getOrder(
        row.id
      );

    assert.equal(
      Number(after.paid),
      1
    );

    assert.equal(
      money(
        after.amount_paid
      ),
      12.5
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      0
    );

    assert.notEqual(
      String(
        after.order_status
      ).toLowerCase(),
      "voided"
    );

    const ledger =
      await positivePayments(
        row.id
      );

    assert.equal(
      ledger.length,
      1
    );
  }
);

/*
 * =====================================================
 * 2. CROSS-TENANT VOID
 * =====================================================
 */

test(
  "TENANT: Restaurant B cannot void Restaurant A unpaid bill",
  async () => {
    const table =
      "Table 502";

    const row =
      await createOrder(
        table
      );

    const response =
      await voidUnpaid(
        table,
        tokenB
      );

    assert.ok(
      response.status >= 400
    );

    const after =
      await getOrder(
        row.id
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

    assert.notEqual(
      String(
        after.order_status
      ).toLowerCase(),
      "voided"
    );
  }
);

/*
 * =====================================================
 * 3. NORMAL VOID
 * =====================================================
 */

test(
  "VOID: authorised unpaid void leaves no financial payment",
  async () => {
    const table =
      "Table 503";

    const row =
      await createOrder(
        table
      );

    const response =
      await voidUnpaid(
        table
      );

    assert.ok(
      is2xx(
        response.status
      ),
      `${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    const after =
      await getOrder(
        row.id
      );

    assert.ok(after);

    assert.equal(
      String(
        after.order_status
      ).toLowerCase(),
      "voided"
    );

    assert.equal(
      Number(after.paid),
      1
    );

    assert.equal(
      money(
        after.amount_paid
      ),
      0
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      0
    );

    const ledger =
      await positivePayments(
        row.id
      );

    assert.equal(
      ledger.length,
      0
    );
  }
);

/*
 * =====================================================
 * 4. VOID REPLAY
 * =====================================================
 */

test(
  "REPLAY: same unpaid bill cannot be voided twice",
  async () => {
    const table =
      "Table 504";

    const row =
      await createOrder(
        table
      );

    const first =
      await voidUnpaid(
        table
      );

    assert.ok(
      is2xx(
        first.status
      )
    );

    const second =
      await voidUnpaid(
        table
      );

    assert.ok(
      second.status >= 400
    );

    const after =
      await getOrder(
        row.id
      );

    assert.equal(
      String(
        after.order_status
      ).toLowerCase(),
      "voided"
    );

    assert.equal(
      money(
        after.amount_paid
      ),
      0
    );
  }
);

/*
 * =====================================================
 * 5. PAYMENT VS WHOLE-BILL VOID
 *
 * Exactly one lifecycle is allowed to win.
 * =====================================================
 */

test(
  "RACE: payment versus unpaid void leaves one authoritative outcome",
  async () => {
    const table =
      "Table 505";

    const row =
      await createOrder(
        table
      );

    const [
      payment,
      voided,
    ] =
      await Promise.all([
        markPaid(
          row
        ),

        voidUnpaid(
          table
        ),
      ]);

    assert.ok(
      payment.status >= 200
    );

    assert.ok(
      voided.status >= 200
    );

    const after =
      await getOrder(
        row.id
      );

    assert.ok(after);

    const ledger =
      await positivePayments(
        row.id
      );

    const state =
      String(
        after.order_status ||
        ""
      ).toLowerCase();

    /*
     * PAYMENT WON
     */
    if (
      money(
        after.amount_paid
      ) === 12.5
    ) {
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

      assert.notEqual(
        state,
        "voided"
      );

      assert.equal(
        ledger.length,
        1
      );

      return;
    }

    /*
     * VOID WON
     */
    assert.equal(
      state,
      "voided"
    );

    assert.equal(
      Number(after.paid),
      1
    );

    assert.equal(
      money(
        after.amount_paid
      ),
      0
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      0
    );

    assert.equal(
      ledger.length,
      0
    );
  }
);

/*
 * =====================================================
 * 6. PAYMENT VS ITEM VOID
 * =====================================================
 */

test(
  "RACE: payment versus item void cannot produce paid-and-voided money state",
  async () => {
    const table =
      "Table 506";

    const row =
      await createOrder(
        table
      );

    await Promise.all([
      markPaid(
        row
      ),

      voidItem(
        table,
        row.id
      ),
    ]);

    const after =
      await getOrder(
        row.id
      );

    const ledger =
      await positivePayments(
        row.id
      );

    const state =
      String(
        after.order_status ||
        ""
      ).toLowerCase();

    const paidMoney =
      money(
        after.amount_paid
      );

    if (
      paidMoney === 12.5
    ) {
      assert.equal(
        ledger.length,
        1
      );

      assert.notEqual(
        state,
        "voided",
        "Item became voided after money was captured"
      );

      assert.equal(
        money(
          after.remaining_price
        ),
        0
      );

      return;
    }

    assert.equal(
      state,
      "voided"
    );

    assert.equal(
      paidMoney,
      0
    );

    assert.equal(
      ledger.length,
      0,
      "Voided item still has positive payment ledger"
    );
  }
);

/*
 * =====================================================
 * 7. PAY-SHARE VS VOID
 * =====================================================
 */

test(
  "RACE: split payment versus whole-bill void preserves one money state",
  async () => {
    const table =
      "Table 507";

    const row =
      await createOrder(
        table
      );

    await Promise.all([
      payShare(
        table,
        5
      ),

      voidUnpaid(
        table
      ),
    ]);

    const after =
      await getOrder(
        row.id
      );

    const ledger =
      await positivePayments(
        row.id
      );

    const state =
      String(
        after.order_status ||
        ""
      ).toLowerCase();

    /*
     * VOID WON.
     */
    if (
      state === "voided"
    ) {
      assert.equal(
        money(
          after.amount_paid
        ),
        0
      );

      assert.equal(
        money(
          after.remaining_price
        ),
        0
      );

      assert.equal(
        ledger.length,
        0,
        "Void won but split-payment ledger survived"
      );

      return;
    }

    /*
     * SHARE WON.
     *
     * £5 paid against £12.50 leaves £7.50.
     */
    assert.equal(
      money(
        after.amount_paid
      ),
      5
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      7.5
    );

    assert.equal(
      Number(after.paid),
      0
    );

    assert.equal(
      ledger.length,
      1
    );
  }
);

/*
 * =====================================================
 * 8. PAYMENT VS UNPAID CLOSE
 *
 * Close is different from void:
 * closed_unpaid means an unpaid debt was deliberately
 * abandoned with manager approval.
 *
 * Payment and close cannot both become authoritative.
 * =====================================================
 */

test(
  "RACE: payment versus unpaid close cannot erase captured money",
  async () => {
    const table =
      "Table 508";

    const row =
      await createOrder(
        table
      );

    await Promise.all([
      markPaid(
        row
      ),

      closeTable(
        table
      ),
    ]);

    const after =
      await getOrder(
        row.id
      );

    const ledger =
      await positivePayments(
        row.id
      );

    const state =
      String(
        after.order_status ||
        ""
      ).toLowerCase();

    if (
      money(
        after.amount_paid
      ) === 12.5
    ) {
      assert.equal(
        ledger.length,
        1
      );

      assert.equal(
        money(
          after.remaining_price
        ),
        0
      );

      assert.notEqual(
        state,
        "closed_unpaid",
        "Captured payment was later converted to closed_unpaid"
      );

      return;
    }

    assert.equal(
      state,
      "closed_unpaid"
    );

    assert.equal(
      money(
        after.amount_paid
      ),
      0
    );

    assert.equal(
      money(
        after.remaining_price
      ),
      0
    );

    assert.equal(
      ledger.length,
      0
    );
  }
);

/*
 * =====================================================
 * 9. LEGACY CLEAR-UNPAID BOUNDARY
 *
 * This old DELETE route bypasses the newer manager-PIN
 * void lifecycle and physically deletes POS rows.
 *
 * Commercial target:
 * a live bill must not disappear through this legacy path.
 *
 * I EXPECT THIS MAY FAIL.
 * =====================================================
 */

test(
  "BOUNDARY: legacy clear-unpaid cannot silently delete a live bill",
  async () => {
    const table =
      "Table 509";

    const row =
      await createOrder(
        table
      );

    const response =
      await request(app)
        .delete(
          `/orders/clear-unpaid/${encodeURIComponent(
            table
          )}`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({});

    assert.ok(
      response.status >= 400,
      `Legacy clear-unpaid deleted live bill: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    const after =
      await getOrder(
        row.id
      );

    assert.ok(
      after,
      "Live POS row was physically deleted"
    );

    assert.equal(
      money(
        after.remaining_price
      ),
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
 * 10. FINAL MONEY/LIFECYCLE INVARIANTS
 * =====================================================
 */

test(
  "FINAL: void/close concurrency creates no impossible financial state",
  async () => {
    const bad =
      await all(
        `
        SELECT
          id,
          restaurant_id,
          table_number,
          total_price,
          amount_paid,
          remaining_price,
          paid,
          order_status

        FROM public.pos_orders

        WHERE
          COALESCE(
            amount_paid,
            0
          ) < -0.01

          OR

          COALESCE(
            remaining_price,
            0
          ) < -0.01

          OR

          COALESCE(
            amount_paid,
            0
          ) >
          COALESCE(
            total_price,
            0
          ) + 0.01

          OR

          (
            LOWER(
              TRIM(
                COALESCE(
                  order_status,
                  ''
                )
              )
            ) = 'voided'

            AND

            COALESCE(
              amount_paid,
              0
            ) > 0.01
          )

          OR

          (
            LOWER(
              TRIM(
                COALESCE(
                  order_status,
                  ''
                )
              )
            ) = 'closed_unpaid'

            AND

            COALESCE(
              amount_paid,
              0
            ) > 0.01
          )
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Impossible void/close money state: ${JSON.stringify(
        bad
      )}`
    );
  }
);