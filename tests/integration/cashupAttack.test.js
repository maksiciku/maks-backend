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
let viewerTokenA;

const VIEWER_PASSWORD =
  "MAKS-CASHUP-VIEWER-TEST-123!";

function bearer(token) {
  return `Bearer ${token}`;
}

function is2xx(status) {
  return (
    status >= 200 &&
    status < 300
  );
}

function money(value) {
  return Number(
    Number(
      value || 0
    ).toFixed(2)
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

  return (
    result.rows ||
    []
  );
}

function rangeAroundNow(
  spreadSeconds = 120
) {
  const now =
    Date.now();

  return {
    from:
      new Date(
        now -
          spreadSeconds *
            1000
      ).toISOString(),

    to:
      new Date(
        now +
          spreadSeconds *
            1000
      ).toISOString(),
  };
}

function uniqueRange(
  offsetMinutes
) {
  const now =
    Date.now();

  const centre =
    now +
    Number(
      offsetMinutes
    ) *
      60 *
      1000;

  return {
    from:
      new Date(
        centre -
          15 * 1000
      ).toISOString(),

    to:
      new Date(
        centre +
          15 * 1000
      ).toISOString(),
  };
}

function orderPayload({
  mealId,
  tableNumber,
  restaurantSideRequired = false,
}) {
  return {
    table_number:
      tableNumber,

    order_type:
      "dine-in",

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
          "CASHUP ATTACK FAKE NAME",

        quantity:
          1,

        price_per_unit:
          0.01,

        total_price:
          0.01,

        options:
          restaurantSideRequired
            ? {
                test_side:
                  "test_chips",
              }
            : {},
      },
    ],
  };
}

async function createOrder({
  token,
  restaurantId,
  mealId,
  tableNumber,
  sideRequired = false,
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

      WHERE restaurant_id =
            $1
      `,
      [
        restaurantId,
      ]
    );

  const response =
    await request(app)
      .post(
        "/orders/grouped"
      )
      .set(
        "Authorization",
        bearer(token)
      )
      .send(
        orderPayload({
          mealId,
          tableNumber,
          restaurantSideRequired:
            sideRequired,
        })
      );

  assert.equal(
    response.status,
    201,
    `Order creation failed: ${
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
      total_price,
      amount_paid,
      remaining_price,
      paid,
      batch_id,
      created_at

    FROM public.pos_orders

    WHERE restaurant_id =
          $1

      AND id >
          $2

    ORDER BY
      id DESC

    LIMIT 1
    `,
    [
      restaurantId,
      Number(
        before?.max_id ||
        0
      ),
    ]
  );

  assert.ok(row);

  return row;
}

async function markPaid({
  token,
  row,
}) {
  const response =
    await request(app)
      .post(
        "/orders/mark-paid"
      )
      .set(
        "Authorization",
        bearer(token)
      )
      .send({
        tableNumber:
          row.table_number,

        itemIds: [
          Number(
            row.id
          ),
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

  assert.ok(
    is2xx(
      response.status
    ),
    `Payment failed: ${
      response.status
    } ${JSON.stringify(
      response.body
    )}`
  );

  const payment =
    await one(
      `
      SELECT
        id,
        restaurant_id,
        table_number,
        amount,
        method,
        status,
        cashup_session_id,
        created_at

      FROM public.payments

      WHERE restaurant_id =
            $1

        AND pos_order_ids @>
            to_jsonb(
              ARRAY[
                $2::bigint
              ]
            )

        AND amount > 0

      ORDER BY
        id DESC

      LIMIT 1
      `,
      [
        Number(
          row.restaurant_id
        ),
        Number(
          row.id
        ),
      ]
    );

  assert.ok(payment);

  return payment;
}

async function createPaidSaleA(
  tableNumber
) {
  const row =
    await createOrder({
      token:
        tokenA,

      restaurantId:
        fixtures.restaurantA,

      mealId:
        fixtures.mealA,

      tableNumber,

      sideRequired:
        true,
    });

  const payment =
    await markPaid({
      token:
        tokenA,

      row,
    });

  return {
    order:
      row,

    payment,
  };
}

async function createPaidSaleB(
  tableNumber
) {
  const row =
    await createOrder({
      token:
        tokenB,

      restaurantId:
        fixtures.restaurantB,

      mealId:
        fixtures.mealB,

      tableNumber,

      /*
       * TEST Burger B has no required options.
       */
      sideRequired:
        false,
    });

  const payment =
    await markPaid({
      token:
        tokenB,

      row,
    });

  return {
    order:
      row,

    payment,
  };
}

async function closeCashup({
  token = tokenA,
  from,
  to,
  actualCash = 0,
  note = "cashup regression",
}) {
  return request(app)
    .post(
      "/cashup/close"
    )
    .set(
      "Authorization",
      bearer(token)
    )
    .send({
      from,
      to,

      actual_cash:
        actualCash,

      note,
    });
}

async function sessionRow(
  id
) {
  return one(
    `
    SELECT
      id,
      restaurant_id,
      from_ts,
      to_ts,
      actual_cash,
      expected_cash,
      discrepancy,
      created_at

    FROM public.cashup_sessions

    WHERE id =
          $1::uuid
    `,
    [
      id,
    ]
  );
}

async function paymentRow(
  paymentId
) {
  return one(
    `
    SELECT
      id,
      restaurant_id,
      amount,
      status,
      cashup_session_id,
      created_at

    FROM public.payments

    WHERE id = $1
    `,
    [
      Number(
        paymentId
      ),
    ]
  );
}

async function createViewOnlyUser() {
  const passwordHash =
    await bcrypt.hash(
      VIEWER_PASSWORD,
      10
    );

  const user =
    await one(
      `
      INSERT INTO public.users
      (
        username,
        password,
        password_hash,
        role,
        restaurant_id,
        is_active,
        can_pos_login,
        can_backoffice_login,
        full_name
      )

      VALUES
      (
        'maks_cashup_viewer_a',
        $1,
        $1,
        'staff',
        $2,
        TRUE,
        TRUE,
        TRUE,
        'Cashup View Test'
      )

      RETURNING id
      `,
      [
        passwordHash,
        fixtures.restaurantA,
      ]
    );

  assert.ok(
    user?.id
  );

  await query(
    `
    INSERT INTO public.restaurant_members
    (
      restaurant_id,
      user_id,
      role,
      authority,
      job_title,
      permissions,
      status,
      is_active
    )

    VALUES
    (
      $1,
      $2,
      'staff',
      'staff',
      'Cashup Viewer',
      '["cashup.view"]'::jsonb,
      'active',
      TRUE
    )
    `,
    [
      fixtures.restaurantA,
      Number(
        user.id
      ),
    ]
  );

  return Number(
    user.id
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
      "CASHUP ATTACK REFUSED: wrong database"
    );

    pool =
      safe.pool;

    /*
     * Keep this suite focused on money/cash-up state.
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

      WHERE id IN (
        $1,
        $2
      )
      `,
      [
        fixtures.restaurantA,
        fixtures.restaurantB,
      ]
    );

    await createViewOnlyUser();

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

    const viewerLogin =
      await request(app)
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_cashup_viewer_a",

          password:
            VIEWER_PASSWORD,

          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      viewerLogin.status,
      200,
      JSON.stringify(
        viewerLogin.body
      )
    );

    viewerTokenA =
      viewerLogin.body?.token;

    assert.ok(
      viewerTokenA
    );
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
 * 1. VIEWER CANNOT CLOSE CASHUP
 * =====================================================
 */

test(
  "PERMISSION: cashup viewer cannot close a cashup",
  async () => {
    const range =
      uniqueRange(30);

    const response =
      await closeCashup({
        token:
          viewerTokenA,

        from:
          range.from,

        to:
          range.to,

        actualCash:
          0,
      });

    assert.equal(
      response.status,
      403
    );

    assert.equal(
      response.body?.code,
      "PERMISSION_DENIED"
    );
  }
);

/*
 * =====================================================
 * 2. VARIANCE PRIVACY
 * =====================================================
 */

test(
  "PRIVACY: cashup viewer without variance permission cannot see variance",
  async () => {
    const range =
      uniqueRange(31);

    const close =
      await closeCashup({
        from:
          range.from,

        to:
          range.to,

        actualCash:
          123.45,
      });

    assert.ok(
      is2xx(
        close.status
      ),
      JSON.stringify(
        close.body
      )
    );

    const sessionId =
      close.body
        ?.cashup_session_id;

    assert.ok(
      sessionId
    );

    const detail =
      await request(app)
        .get(
          `/cashup/sessions/${sessionId}`
        )
        .set(
          "Authorization",
          bearer(
            viewerTokenA
          )
        );

    assert.equal(
      detail.status,
      200,
      JSON.stringify(
        detail.body
      )
    );

    assert.equal(
      detail.body
        ?.session
        ?.actual_cash,
      null
    );

    assert.equal(
      detail.body
        ?.session
        ?.expected_cash,
      null
    );

    assert.equal(
      detail.body
        ?.session
        ?.discrepancy,
      null
    );
  }
);

/*
 * =====================================================
 * 3. CROSS-TENANT SESSION READ
 * =====================================================
 */

test(
  "TENANT: Restaurant B cannot read Restaurant A cashup session",
  async () => {
    const range =
      uniqueRange(32);

    const close =
      await closeCashup({
        from:
          range.from,

        to:
          range.to,

        actualCash:
          0,
      });

    assert.ok(
      is2xx(
        close.status
      )
    );

    const sessionId =
      close.body
        ?.cashup_session_id;

    const attack =
      await request(app)
        .get(
          `/cashup/sessions/${sessionId}`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        );

    assert.equal(
      attack.status,
      404
    );
  }
);

/*
 * =====================================================
 * 4. CROSS-TENANT SESSION ATTACH
 * =====================================================
 */

test(
  "TENANT: Restaurant B cannot attach payments to Restaurant A cashup",
  async () => {
    const range =
      uniqueRange(33);

    const close =
      await closeCashup({
        from:
          range.from,

        to:
          range.to,

        actualCash:
          0,
      });

    assert.ok(
      is2xx(
        close.status
      )
    );

    const sessionId =
      close.body
        ?.cashup_session_id;

    const attack =
      await request(app)
        .post(
          `/cashup/sessions/${sessionId}/attach`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send({
          from:
            range.from,

          to:
            range.to,
        });

    assert.equal(
      attack.status,
      404
    );
  }
);

/*
 * =====================================================
 * 5. CROSS-TENANT PAYMENT NEVER LINKS
 * =====================================================
 */

test(
  "TENANT: Restaurant A cashup cannot absorb Restaurant B payment",
  async () => {
    const saleB =
      await createPaidSaleB(
        "Table CASH-B-1"
      );

    const range =
      rangeAroundNow(
        120
      );

    const closeA =
      await closeCashup({
        token:
          tokenA,

        from:
          range.from,

        to:
          range.to,

        actualCash:
          0,

        note:
          "A cannot absorb B",
      });

    assert.ok(
      is2xx(
        closeA.status
      ),
      JSON.stringify(
        closeA.body
      )
    );

    const afterB =
      await paymentRow(
        saleB.payment.id
      );

    assert.equal(
      Number(
        afterB.restaurant_id
      ),
      Number(
        fixtures.restaurantB
      )
    );

    assert.notEqual(
      String(
        afterB.cashup_session_id ||
        ""
      ),
      String(
        closeA.body
          ?.cashup_session_id ||
        ""
      )
    );
  }
);

/*
 * =====================================================
 * 6. DUPLICATE EXACT RANGE
 * =====================================================
 */

test(
  "REPLAY: identical cashup range cannot be closed twice",
  async () => {
    const range =
      uniqueRange(34);

    const first =
      await closeCashup({
        from:
          range.from,

        to:
          range.to,

        actualCash:
          0,
      });

    assert.ok(
      is2xx(
        first.status
      )
    );

    const second =
      await closeCashup({
        from:
          range.from,

        to:
          range.to,

        actualCash:
          0,
      });

    assert.equal(
      second.status,
      409
    );

    assert.ok(
      second.body
        ?.cashup_session_id
    );
  }
);

/*
 * =====================================================
 * 7. CONCURRENT CLOSE
 * =====================================================
 */

test(
  "RACE: simultaneous close requests create exactly one cashup session",
  async () => {
    const range =
      uniqueRange(35);

    const [
      a,
      b,
    ] =
      await Promise.all([
        closeCashup({
          from:
            range.from,

          to:
            range.to,

          actualCash:
            0,

          note:
            "race A",
        }),

        closeCashup({
          from:
            range.from,

          to:
            range.to,

          actualCash:
            0,

          note:
            "race B",
        }),
      ]);

    const successCount =
      [a, b].filter(
        (response) =>
          is2xx(
            response.status
          )
      ).length;

    const conflictCount =
      [a, b].filter(
        (response) =>
          response.status ===
          409
      ).length;

    assert.equal(
      successCount,
      1,
      `Concurrent closes produced ${successCount} successes`
    );

    assert.equal(
      conflictCount,
      1
    );

    const count =
      await one(
        `
        SELECT
          COUNT(*)::int
            AS count

        FROM public.cashup_sessions

        WHERE restaurant_id =
              $1

          AND from_ts =
              $2

          AND to_ts =
              $3
        `,
        [
          fixtures.restaurantA,
          range.from,
          range.to,
        ]
      );

    assert.equal(
      Number(
        count?.count ||
        0
      ),
      1
    );
  }
);

/*
 * =====================================================
 * 8. PAYMENT LINKED ON CLOSE
 * =====================================================
 */

test(
  "CLOSE: eligible payment is linked exactly once to created cashup",
  async () => {
    const sale =
      await createPaidSaleA(
        "Table CASH-A-1"
      );

    const paymentBefore =
      await paymentRow(
        sale.payment.id
      );

    assert.equal(
      paymentBefore
        .cashup_session_id,
      null
    );

    const paymentTime =
      new Date(
        paymentBefore.created_at
      ).getTime();

    const range = {
      from:
        new Date(
          paymentTime -
            5000
        ).toISOString(),

      to:
        new Date(
          paymentTime +
            5000
        ).toISOString(),
    };

    const close =
      await closeCashup({
        from:
          range.from,

        to:
          range.to,

        actualCash:
          money(
            paymentBefore.amount
          ),
      });

    assert.ok(
      is2xx(
        close.status
      ),
      JSON.stringify(
        close.body
      )
    );

    const after =
      await paymentRow(
        sale.payment.id
      );

    assert.equal(
      String(
        after.cashup_session_id
      ),
      String(
        close.body
          .cashup_session_id
      )
    );

    assert.equal(
      Number(
        close.body
          ?.payments_linked ||
        0
      ),
      1
    );
  }
);

/*
 * =====================================================
 * 8A. REAL CASH REFUND COUNTS EXACTLY ONCE
 * =====================================================
 */

test(
  "LEDGER: real partial cash refund reduces expected cash exactly once",
  async () => {
    /*
     * Everything created before this DB timestamp is
     * excluded from this test's financial window.
     */
    const clock =
      await one(
        `
        SELECT
          NOW() AS from_ts,
          NOW() +
            INTERVAL '2 minutes'
            AS to_ts
        `
      );

    assert.ok(
      clock?.from_ts
    );

    assert.ok(
      clock?.to_ts
    );

    const range = {
      from:
        new Date(
          clock.from_ts
        ).toISOString(),

      to:
        new Date(
          clock.to_ts
        ).toISOString(),
    };

    /*
     * Create a real POS order and pay it entirely
     * using cash.
     */
    const sale =
      await createPaidSaleA(
        "Table CASH-REFUND-1"
      );

    const saleAmount =
      money(
        sale.payment.amount
      );

    assert.ok(
      saleAmount > 0
    );

    /*
     * Before refund, expected cash must equal the
     * isolated positive cash tender.
     */
    const beforeSummary =
      await request(app)
        .get(
          "/cashup/summary"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .query({
          from:
            range.from,

          to:
            range.to,
        });

    assert.equal(
      beforeSummary.status,
      200,
      JSON.stringify(
        beforeSummary.body
      )
    );

    const beforeCash =
      (
        beforeSummary.body
          ?.by_method ||
        []
      ).find(
        (row) =>
          row.method ===
          "cash"
      );

    assert.ok(
      beforeCash
    );

    assert.equal(
      money(
        beforeCash.total
      ),
      saleAmount
    );

    assert.equal(
      money(
        beforeSummary.body
          ?.expected_cash
      ),
      saleAmount
    );

    /*
     * Deliberately make this a partial refund.
     */
    const refundAmount =
      money(
        Math.min(
          5,
          saleAmount / 2
        )
      );

    assert.ok(
      refundAmount > 0
    );

    assert.ok(
      refundAmount <
        saleAmount
    );

    /*
     * Use the real production refund route.
     */
    const refundResponse =
      await request(app)
        .post(
          `/orders/payments/${sale.payment.id}/refund`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          amount:
            refundAmount,

          reason:
            "CASHUP EXACTLY ONCE REGRESSION",
        });

    assert.ok(
      is2xx(
        refundResponse.status
      ),
      `Refund failed: ${
        refundResponse.status
      } ${JSON.stringify(
        refundResponse.body
      )}`
    );

    /*
     * Refund B must exist as negative cash money.
     */
    const refund =
      await one(
        `
        SELECT
          id,
          restaurant_id,
          amount,
          method,
          status,
          source,
          ref_payment_id,
          cashup_session_id,
          created_at

        FROM public.payments

        WHERE restaurant_id =
              $1

          AND ref_payment_id =
              $2

          AND amount < 0

          AND LOWER(
            COALESCE(
              status,
              'completed'
            )
          ) <> 'voided'

        ORDER BY id DESC

        LIMIT 1
        `,
        [
          fixtures.restaurantA,

          Number(
            sale.payment.id
          ),
        ]
      );

    assert.ok(
      refund
    );

    assert.equal(
      money(
        refund.amount
      ),
      -refundAmount
    );

    assert.equal(
      String(
        refund.method
      ).toLowerCase(),
      "cash"
    );

    assert.equal(
      String(
        refund.source
      ).toLowerCase(),
      "refund"
    );

    assert.equal(
      Number(
        refund.ref_payment_id
      ),
      Number(
        sale.payment.id
      )
    );

    assert.equal(
      refund.cashup_session_id,
      null
    );

    /*
     * Critical exactly-once boundary:
     *
     * the negative payment ledger row must NOT also
     * create a cash_drawer_moves refund row.
     */
    const drawerRefund =
      await one(
        `
        SELECT
          COUNT(*)::int AS count,

          COALESCE(
            SUM(amount),
            0
          )::numeric AS total

        FROM public.cash_drawer_moves

        WHERE restaurant_id =
              $1

          AND LOWER(kind) =
              'refund'

          AND created_at
              BETWEEN $2 AND $3
        `,
        [
          fixtures.restaurantA,
          range.from,
          range.to,
        ]
      );

    assert.equal(
      Number(
        drawerRefund?.count ||
        0
      ),
      0,
      "POS refund created a duplicate cash drawer refund"
    );

    assert.equal(
      money(
        drawerRefund?.total
      ),
      0
    );

    const expectedAfterRefund =
      money(
        saleAmount -
        refundAmount
      );

    /*
     * +A and -B must now net to exactly the amount
     * physically expected in the till.
     */
    const afterSummary =
      await request(app)
        .get(
          "/cashup/summary"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .query({
          from:
            range.from,

          to:
            range.to,
        });

    assert.equal(
      afterSummary.status,
      200,
      JSON.stringify(
        afterSummary.body
      )
    );

    const afterCash =
      (
        afterSummary.body
          ?.by_method ||
        []
      ).find(
        (row) =>
          row.method ===
          "cash"
      );

    assert.ok(
      afterCash
    );

    assert.equal(
      money(
        afterCash.total
      ),
      expectedAfterRefund
    );

    assert.equal(
      money(
        afterSummary.body
          ?.expected_cash
      ),
      expectedAfterRefund
    );

    /*
     * Close with exactly the amount expected to remain
     * physically in the drawer.
     */
    const close =
      await closeCashup({
        from:
          range.from,

        to:
          range.to,

        actualCash:
          expectedAfterRefund,

        note:
          "cash refund exactly-once regression",
      });

    assert.ok(
      is2xx(
        close.status
      ),
      JSON.stringify(
        close.body
      )
    );

    assert.equal(
      money(
        close.body
          ?.expected_cash
      ),
      expectedAfterRefund
    );

    assert.equal(
      money(
        close.body
          ?.actual_cash
      ),
      expectedAfterRefund
    );

    assert.equal(
      money(
        close.body
          ?.discrepancy
      ),
      0
    );

    /*
     * Both immutable money rows must be captured by the
     * same closed cash-up:
     *
     * A = positive cash tender
     * B = negative cash refund
     */
    assert.equal(
      Number(
        close.body
          ?.payments_linked ||
        0
      ),
      2
    );

    const session =
      await sessionRow(
        close.body
          .cashup_session_id
      );

    assert.ok(
      session
    );

    assert.equal(
      money(
        session.expected_cash
      ),
      expectedAfterRefund
    );

    assert.equal(
      money(
        session.actual_cash
      ),
      expectedAfterRefund
    );

    assert.equal(
      money(
        session.discrepancy
      ),
      0
    );

    const originalAfter =
      await paymentRow(
        sale.payment.id
      );

    const refundAfter =
      await paymentRow(
        refund.id
      );

    assert.equal(
      String(
        originalAfter
          .cashup_session_id
      ),
      String(
        close.body
          .cashup_session_id
      )
    );

    assert.equal(
      String(
        refundAfter
          .cashup_session_id
      ),
      String(
        close.body
          .cashup_session_id
      )
    );

    console.log(
      "✅ CASH-R refund reduced expected cash exactly once"
    );
  }
);


/*
 * =====================================================
 * 9. ATTACH MUST NOT STEAL CLOSED PAYMENT
 *
 * This is the key expected red.
 * =====================================================
 */

test(
  "ATTACK: attach cannot steal payment from another closed cashup",
  async () => {
    const sale =
      await createPaidSaleA(
        "Table CASH-A-2"
      );

    const payment =
      await paymentRow(
        sale.payment.id
      );

    const paymentTime =
      new Date(
        payment.created_at
      ).getTime();

    const firstRange = {
      from:
        new Date(
          paymentTime -
            4000
        ).toISOString(),

      to:
        new Date(
          paymentTime +
            4000
        ).toISOString(),
    };

    const first =
      await closeCashup({
        from:
          firstRange.from,

        to:
          firstRange.to,

        actualCash:
          money(
            payment.amount
          ),
      });

    assert.ok(
      is2xx(
        first.status
      )
    );

    const firstSessionId =
      first.body
        ?.cashup_session_id;

    assert.ok(
      firstSessionId
    );

    const afterFirst =
      await paymentRow(
        payment.id
      );

    assert.equal(
      String(
        afterFirst
          .cashup_session_id
      ),
      String(
        firstSessionId
      )
    );

    /*
     * Create a completely separate cashup.
     */
    const secondRange =
      uniqueRange(40);

    const second =
      await closeCashup({
        from:
          secondRange.from,

        to:
          secondRange.to,

        actualCash:
          0,
      });

    assert.ok(
      is2xx(
        second.status
      )
    );

    const secondSessionId =
      second.body
        ?.cashup_session_id;

    /*
     * Attack: manually supply the first payment's old range
     * while targeting the second cashup.
     */
    const attack =
      await request(app)
        .post(
          `/cashup/sessions/${secondSessionId}/attach`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          from:
            firstRange.from,

          to:
            firstRange.to,
        });

    assert.ok(
      attack.status >= 400,
      `Closed payment was reassigned: ${
        attack.status
      } ${JSON.stringify(
        attack.body
      )}`
    );

    const afterAttack =
      await paymentRow(
        payment.id
      );

    assert.equal(
      String(
        afterAttack
          .cashup_session_id
      ),
      String(
        firstSessionId
      ),
      "Payment was stolen from its original closed cashup"
    );
  }
);

/*
 * =====================================================
 * 10. ATTACH RANGE CANNOT EXCEED SESSION RANGE
 *
 * Financial correction must not let a caller nominate an
 * arbitrary historical/future range unrelated to session.
 * =====================================================
 */

test(
  "ATTACK: attach cannot expand beyond target cashup session range",
  async () => {
    const range =
      uniqueRange(42);

    const close =
      await closeCashup({
        from:
          range.from,

        to:
          range.to,

        actualCash:
          0,
      });

    assert.ok(
      is2xx(
        close.status
      )
    );

    const sessionId =
      close.body
        ?.cashup_session_id;

    const attack =
      await request(app)
        .post(
          `/cashup/sessions/${sessionId}/attach`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          from:
            new Date(
              Date.now() -
                365 *
                  24 *
                  60 *
                  60 *
                  1000
            ).toISOString(),

          to:
            new Date(
              Date.now() +
                365 *
                  24 *
                  60 *
                  60 *
                  1000
            ).toISOString(),
        });

    assert.ok(
      attack.status >= 400,
      `Attach accepted arbitrary external range: ${
        attack.status
      } ${JSON.stringify(
        attack.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 11. LOW PRIVILEGE MOVEMENT
 * =====================================================
 */

test(
  "PERMISSION: cashup viewer cannot create float or adjustment movement",
  async () => {
    const floatAttempt =
      await request(app)
        .post(
          "/cashup/move"
        )
        .set(
          "Authorization",
          bearer(
            viewerTokenA
          )
        )
        .send({
          kind:
            "float",

          amount:
            20,

          note:
            "attack",
        });

    assert.equal(
      floatAttempt.status,
      403
    );

    const payoutAttempt =
      await request(app)
        .post(
          "/cashup/move"
        )
        .set(
          "Authorization",
          bearer(
            viewerTokenA
          )
        )
        .send({
          kind:
            "payout",

          amount:
            20,

          note:
            "attack",
        });

    assert.equal(
      payoutAttempt.status,
      403
    );
  }
);

/*
 * =====================================================
 * 12. INVALID CASH MOVEMENTS
 * =====================================================
 */

test(
  "VALIDATION: cash movement rejects invalid kinds and non-positive amounts",
  async () => {
    const invalidKind =
      await request(app)
        .post(
          "/cashup/move"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          kind:
            "free_money",

          amount:
            100,
        });

    assert.equal(
      invalidKind.status,
      400
    );

    /*
     * Sales and refunds belong to the immutable payment
     * ledger. They must never be accepted as parallel
     * manual drawer movements.
     */
    const ledgerOwnedBefore =
      await one(
        `
        SELECT
          COUNT(*)::int
            AS count

        FROM public.cash_drawer_moves

        WHERE restaurant_id =
              $1

          AND LOWER(kind)
              IN (
                'sale',
                'refund'
              )
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const manualSale =
      await request(app)
        .post(
          "/cashup/move"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          kind:
            "sale",

          amount:
            10,

          note:
            "must not duplicate payment ledger sale",
        });

    assert.equal(
      manualSale.status,
      400
    );

    assert.equal(
      manualSale.body?.code,
      "CASHUP_LEDGER_OWNED_MOVEMENT"
    );

    const manualRefund =
      await request(app)
        .post(
          "/cashup/move"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          kind:
            "refund",

          amount:
            10,

          note:
            "must not duplicate payment ledger refund",
        });

    assert.equal(
      manualRefund.status,
      400
    );

    assert.equal(
      manualRefund.body?.code,
      "CASHUP_LEDGER_OWNED_MOVEMENT"
    );

    const ledgerOwnedAfter =
      await one(
        `
        SELECT
          COUNT(*)::int
            AS count

        FROM public.cash_drawer_moves

        WHERE restaurant_id =
              $1

          AND LOWER(kind)
              IN (
                'sale',
                'refund'
              )
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(
        ledgerOwnedAfter?.count ||
        0
      ),
      Number(
        ledgerOwnedBefore?.count ||
        0
      ),
      "Rejected ledger-owned movement changed cash_drawer_moves"
    );

    const zero =
      await request(app)
        .post(
          "/cashup/move"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          kind:
            "float",

          amount:
            0,
        });

    assert.equal(
      zero.status,
      400
    );

    const negative =
      await request(app)
        .post(
          "/cashup/move"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          kind:
            "float",

          amount:
            -10,
        });

    assert.equal(
      negative.status,
      400
    );
  }
);

/*
 * =====================================================
 * 13. FINAL CASHUP/PAYMENT TENANT INTEGRITY
 * =====================================================
 */

test(
  "FINAL: every attached payment belongs to same tenant as cashup session",
  async () => {
    const bad =
      await all(
        `
        SELECT
          p.id
            AS payment_id,

          p.restaurant_id
            AS payment_restaurant_id,

          p.cashup_session_id,

          cs.restaurant_id
            AS session_restaurant_id

        FROM public.payments p

        JOIN public.cashup_sessions cs
          ON cs.id =
               p.cashup_session_id

        WHERE
          p.restaurant_id <>
          cs.restaurant_id
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Cross-tenant cashup linkage detected: ${JSON.stringify(
        bad
      )}`
    );
  }
);

/*
 * =====================================================
 * 14. FINAL SESSION RANGE INTEGRITY
 * =====================================================
 */

test(
  "FINAL: payments linked to cashups fall inside their session range",
  async () => {
    const bad =
      await all(
        `
        SELECT
          p.id
            AS payment_id,

          p.created_at
            AS payment_created_at,

          p.cashup_session_id,

          cs.from_ts,
          cs.to_ts

        FROM public.payments p

        JOIN public.cashup_sessions cs
          ON cs.id =
               p.cashup_session_id

        WHERE
          p.created_at <
            cs.from_ts

          OR

          p.created_at >
            cs.to_ts
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Payment linked outside cashup range: ${JSON.stringify(
        bad
      )}`
    );
  }
);

/*
 * =====================================================
 * 15. FINAL CASHUP IDS REMAIN VALID
 * =====================================================
 */

test(
  "FINAL: no payment references missing cashup session",
  async () => {
    const bad =
      await all(
        `
        SELECT
          p.id,
          p.restaurant_id,
          p.cashup_session_id

        FROM public.payments p

        LEFT JOIN public.cashup_sessions cs
          ON cs.id =
               p.cashup_session_id

        WHERE
          p.cashup_session_id
              IS NOT NULL

          AND cs.id
              IS NULL
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Orphan cashup references found: ${JSON.stringify(
        bad
      )}`
    );
  }
);