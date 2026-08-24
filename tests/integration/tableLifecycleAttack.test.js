"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const request =
  require("supertest");

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

async function ensureTable({
  restaurantId,
  name,
  status = "free",
  seats = 4,
}) {
  const table =
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
        $3,
        $4
      )

      ON CONFLICT DO NOTHING

      RETURNING
        id,
        name
      `,
      [
        restaurantId,
        name,
        seats,
        status,
      ]
    );

  let realTable =
    table;

  if (!realTable) {
    realTable =
      await one(
        `
        SELECT
          id,
          name
        FROM public.tables
        WHERE restaurant_id = $1
          AND LOWER(
                TRIM(name)
              ) =
              LOWER(
                TRIM($2)
              )
        LIMIT 1
        `,
        [
          restaurantId,
          name,
        ]
      );
  }

  const map =
    await one(
      `
      SELECT id
      FROM public.table_map
      WHERE restaurant_id = $1
        AND LOWER(
              TRIM(name)
            ) =
            LOWER(
              TRIM($2)
            )
      LIMIT 1
      `,
      [
        restaurantId,
        name,
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
        $3,
        $4,
        'Main',
        'square'
      )
      `,
      [
        restaurantId,
        name,
        seats,
        status,
      ]
    );
  }

  return realTable;
}

function orderBody(
  mealId,
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
          mealId,

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
          fixtures.mealA,
          tableName
        )
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
        batch_id,
        table_number,
        total_price,
        amount_paid,
        remaining_price,
        paid,
        order_status
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND LOWER(
              TRIM(table_number)
            ) =
            LOWER(
              TRIM($2)
            )
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

async function tableStatus(
  restaurantId,
  tableName
) {
  const table =
    await one(
      `
      SELECT
        id,
        status
      FROM public.tables
      WHERE restaurant_id = $1
        AND LOWER(
              TRIM(name)
            ) =
            LOWER(
              TRIM($2)
            )
      LIMIT 1
      `,
      [
        restaurantId,
        tableName,
      ]
    );

  const map =
    await one(
      `
      SELECT
        id,
        status
      FROM public.table_map
      WHERE restaurant_id = $1
        AND LOWER(
              TRIM(name)
            ) =
            LOWER(
              TRIM($2)
            )
      LIMIT 1
      `,
      [
        restaurantId,
        tableName,
      ]
    );

  return {
    table,
    map,
  };
}

async function createSession(
  tableId,
  covers = 4
) {
  const response =
    await request(app)
      .post(
        `/pos/table-session/${tableId}`
      )
      .set(
        "Authorization",
        bearer(tokenA)
      )
      .send({
        covers,

        allergy_codes: [
          "milk",
        ],

        strict_cross_contamination:
          true,
      });

  assert.ok(
    is2xx(
      response.status
    ),
    JSON.stringify(
      response.body
    )
  );
}

async function session(
  restaurantId,
  tableId
) {
  return one(
    `
    SELECT
      restaurant_id,
      table_id,
      covers
    FROM public.pos_table_sessions
    WHERE restaurant_id = $1
      AND table_id = $2
    `,
    [
      restaurantId,
      tableId,
    ]
  );
}

async function markPaid(
  row,
  token = tokenA
) {
  return request(app)
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

async function paymentCount(
  restaurantId,
  orderId
) {
  const row =
    await one(
      `
      SELECT
        COUNT(*)::int AS count
      FROM public.payments
      WHERE restaurant_id = $1
        AND pos_order_ids @>
          to_jsonb(
            ARRAY[
              $2::bigint
            ]
          )
        AND amount > 0
      `,
      [
        restaurantId,
        orderId,
      ]
    );

  return Number(
    row?.count || 0
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
      "maks_test",
      "TABLE LIFECYCLE TEST REFUSED: wrong database"
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

    ({ app } =
      require("../../server"));

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
 * 1. ORDER OCCUPIES BOTH TABLE REPRESENTATIONS
 * =====================================================
 */

test(
  "TABLE STATE: dine-in order marks tables and table_map occupied",
  async () => {
    const tableName =
      "Table 401";

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        tableName,
    });

    await createOrder(
      tableName
    );

    const state =
      await tableStatus(
        fixtures.restaurantA,
        tableName
      );

    assert.equal(
      String(
        state.table?.status
      ).toLowerCase(),
      "occupied"
    );

    assert.equal(
      String(
        state.map?.status
      ).toLowerCase(),
      "occupied"
    );
  }
);

/*
 * =====================================================
 * 2. FOREIGN TRANSFER IS ISOLATED
 * =====================================================
 */

test(
  "TENANT: Restaurant B cannot transfer Restaurant A bill",
  async () => {
    const source =
      "Table 402";

    const destination =
      "Table 403";

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        source,
    });

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        destination,
    });

    const row =
      await createOrder(
        source
      );

    const response =
      await request(app)
        .put(
          "/orders/transfer-table"
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send({
          oldTable:
            source,

          newTable:
            destination,
        });

    /*
     * Whether route reports 200/moved=0 or 4xx,
     * Restaurant A's row must remain untouched.
     */
    assert.ok(
      response.status >= 200
    );

    const after =
      await one(
        `
        SELECT
          table_number
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(row.id),
        ]
      );

    assert.equal(
      after.table_number,
      source
    );
  }
);

/*
 * =====================================================
 * 3. NORMAL TRANSFER
 * =====================================================
 */

test(
  "TRANSFER: unpaid bill moves atomically and table statuses follow it",
  async () => {
    const source =
      "Table 404";

    const destination =
      "Table 405";

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        source,
    });

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        destination,
    });

    const row =
      await createOrder(
        source
      );

    const response =
      await request(app)
        .put(
          "/orders/transfer-table"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          oldTable:
            source,

          newTable:
            destination,
        });

    assert.ok(
      is2xx(
        response.status
      ),
      JSON.stringify(
        response.body
      )
    );

    assert.equal(
      Number(
        response.body?.moved ||
        0
      ),
      1
    );

    const after =
      await one(
        `
        SELECT
          table_number,
          paid,
          remaining_price
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(row.id),
        ]
      );

    assert.equal(
      after.table_number,
      destination
    );

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

    const sourceState =
      await tableStatus(
        fixtures.restaurantA,
        source
      );

    const destinationState =
      await tableStatus(
        fixtures.restaurantA,
        destination
      );

    assert.equal(
      String(
        sourceState.table
          ?.status
      ).toLowerCase(),
      "free"
    );

    assert.equal(
      String(
        sourceState.map
          ?.status
      ).toLowerCase(),
      "free"
    );

    assert.equal(
      String(
        destinationState
          .table?.status
      ).toLowerCase(),
      "occupied"
    );

    assert.equal(
      String(
        destinationState
          .map?.status
      ).toLowerCase(),
      "occupied"
    );
  }
);

/*
 * =====================================================
 * 4. DESTINATION ALREADY HAS BILL
 *
 * This is intentionally strict.
 *
 * A transfer should not silently merge two independently
 * opened table bills unless MAKS explicitly has a merge
 * workflow with confirmation.
 *
 * Current implementation may expose this.
 * =====================================================
 */

test(
  "BOUNDARY: transfer cannot silently merge into another unpaid table",
  async () => {
    const source =
      "Table 406";

    const destination =
      "Table 407";

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        source,
    });

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        destination,
    });

    const sourceRow =
      await createOrder(
        source
      );

    const destinationRow =
      await createOrder(
        destination
      );

    const response =
      await request(app)
        .put(
          "/orders/transfer-table"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          oldTable:
            source,

          newTable:
            destination,
        });

    assert.ok(
      response.status >= 400,
      `Independent bills were silently merged: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    const sourceAfter =
      await one(
        `
        SELECT table_number
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(
            sourceRow.id
          ),
        ]
      );

    const destinationAfter =
      await one(
        `
        SELECT table_number
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(
            destinationRow.id
          ),
        ]
      );

    assert.equal(
      sourceAfter.table_number,
      source
    );

    assert.equal(
      destinationAfter.table_number,
      destination
    );
  }
);

/*
 * =====================================================
 * 5. SAME TABLE TRANSFER
 * =====================================================
 */

test(
  "BOUNDARY: same-table transfer is rejected without changing bill",
  async () => {
    const tableName =
      "Table 408";

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        tableName,
    });

    const row =
      await createOrder(
        tableName
      );

    const response =
      await request(app)
        .put(
          "/orders/transfer-table"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          oldTable:
            tableName,

          newTable:
            tableName,
        });

    assert.equal(
      response.status,
      400
    );

    const after =
      await one(
        `
        SELECT table_number
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(row.id),
        ]
      );

    assert.equal(
      after.table_number,
      tableName
    );
  }
);

/*
 * =====================================================
 * 6. UNPAID CLOSE NEEDS APPROVAL
 * =====================================================
 */

test(
  "CLOSE: unpaid table cannot close without manager approval",
  async () => {
    const tableName =
      "Table 409";

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        tableName,
    });

    const row =
      await createOrder(
        tableName
      );

    const response =
      await request(app)
        .post(
          "/orders/close"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          table_number:
            tableName,
        });

    assert.equal(
      response.status,
      403
    );

    assert.equal(
      response.body?.code,
      "UNPAID_CLOSE_APPROVAL_REQUIRED"
    );

    const after =
      await one(
        `
        SELECT
          paid,
          remaining_price,
          order_status
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(row.id),
        ]
      );

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
      "closed_unpaid"
    );
  }
);

/*
 * =====================================================
 * 7. PAYMENT CLEARS TABLE SESSION
 * =====================================================
 */

test(
  "SESSION: full payment clears table session and preserves paid bill",
  async () => {
    const tableName =
      "Table 410";

    const table =
      await ensureTable({
        restaurantId:
          fixtures.restaurantA,

        name:
          tableName,
      });

    await createSession(
      Number(table.id),
      5
    );

    const beforeSession =
      await session(
        fixtures.restaurantA,
        Number(table.id)
      );

    assert.ok(
      beforeSession
    );

    const row =
      await createOrder(
        tableName
      );

    const payment =
      await markPaid(
        row
      );

    assert.ok(
      is2xx(
        payment.status
      ),
      JSON.stringify(
        payment.body
      )
    );

    const after =
      await one(
        `
        SELECT
          paid,
          remaining_price,
          amount_paid
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(row.id),
        ]
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
      money(
        after.amount_paid
      ),
      12.5
    );

    const afterSession =
      await session(
        fixtures.restaurantA,
        Number(table.id)
      );

    assert.equal(
      afterSession,
      null
    );

    const count =
      await paymentCount(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.equal(
      count,
      1
    );
  }
);

/*
 * =====================================================
 * 8. PAYMENT VS TRANSFER RACE
 *
 * Valid outcomes:
 *
 * - payment wins, transfer moves nothing
 * - transfer wins, payment request becomes stale/rejected
 *
 * Forbidden:
 *
 * - row paid AND duplicated
 * - >1 positive payment
 * - negative balance
 * =====================================================
 */

test(
  "RACE: simultaneous payment and transfer leave one valid bill state",
  async () => {
    const source =
      "Table 411";

    const destination =
      "Table 412";

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        source,
    });

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,

      name:
        destination,
    });

    const row =
      await createOrder(
        source
      );

    const paymentRequest =
      markPaid(
        row
      );

    const transferRequest =
      request(app)
        .put(
          "/orders/transfer-table"
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          oldTable:
            source,

          newTable:
            destination,
        });

    const [
      payment,
      transfer,
    ] =
      await Promise.all([
        paymentRequest,
        transferRequest,
      ]);

    assert.ok(
      payment.status >= 200
    );

    assert.ok(
      transfer.status >= 200
    );

    const after =
      await one(
        `
        SELECT
          id,
          table_number,
          paid,
          amount_paid,
          remaining_price
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(row.id),
        ]
      );

    assert.ok(after);

    assert.ok(
      [
        source,
        destination,
      ].includes(
        after.table_number
      )
    );

    assert.ok(
      money(
        after.remaining_price
      ) >= 0
    );

    assert.ok(
      money(
        after.amount_paid
      ) >= 0
    );

    assert.ok(
      money(
        after.amount_paid
      ) <= 12.5
    );

    const count =
      await paymentCount(
        fixtures.restaurantA,
        Number(row.id)
      );

    assert.ok(
      count <= 1,
      `Race produced ${count} positive payment rows`
    );

    if (
      Number(after.paid) ===
      1
    ) {
      assert.equal(
        money(
          after.remaining_price
        ),
        0
      );

      assert.equal(
        money(
          after.amount_paid
        ),
        12.5
      );

      assert.equal(
        count,
        1
      );
    } else {
      assert.equal(
        money(
          after.remaining_price
        ),
        12.5
      );

      assert.equal(
        count,
        0
      );
    }
  }
);

/*
 * =====================================================
 * 9. CONCURRENT TRANSFER
 *
 * Same source simultaneously moved toward two different
 * destinations. Only one destination may become the
 * authoritative home of the row.
 * =====================================================
 */

test(
  "RACE: simultaneous transfers cannot split one source bill across destinations",
  async () => {
    const source =
      "Table 413";

    const destinationA =
      "Table 414";

    const destinationB =
      "Table 415";

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,
      name:
        source,
    });

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,
      name:
        destinationA,
    });

    await ensureTable({
      restaurantId:
        fixtures.restaurantA,
      name:
        destinationB,
    });

    const row =
      await createOrder(
        source
      );

    const transfer =
      (destination) =>
        request(app)
          .put(
            "/orders/transfer-table"
          )
          .set(
            "Authorization",
            bearer(tokenA)
          )
          .send({
            oldTable:
              source,

            newTable:
              destination,
          });

    const [
      a,
      b,
    ] =
      await Promise.all([
        transfer(
          destinationA
        ),

        transfer(
          destinationB
        ),
      ]);

    assert.ok(
      a.status >= 200
    );

    assert.ok(
      b.status >= 200
    );

    const after =
      await one(
        `
        SELECT table_number
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(row.id),
        ]
      );

    assert.ok(
      [
        destinationA,
        destinationB,
      ].includes(
        after.table_number
      ),
      `Unexpected final table: ${after.table_number}`
    );

    const duplicate =
      await one(
        `
        SELECT
          COUNT(*)::int AS count
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          Number(row.id),
        ]
      );

    assert.equal(
      Number(
        duplicate.count
      ),
      1
    );
  }
);

/*
 * =====================================================
 * 10. FOREIGN TABLE STATUS ID
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot change Restaurant B table status",
  async () => {
    const before =
      await one(
        `
        SELECT status
        FROM public.tables
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantB,
          fixtures.tableB,
        ]
      );

    const response =
      await request(app)
        .put(
          `/tables/${fixtures.tableB}/status`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          status:
            "occupied",
        });

    /*
     * Current endpoint may return success even if its
     * tenant-scoped UPDATE matched zero rows.
     *
     * Database integrity is the authoritative assertion.
     */
    assert.ok(
      response.status >= 200
    );

    const after =
      await one(
        `
        SELECT status
        FROM public.tables
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantB,
          fixtures.tableB,
        ]
      );

    assert.equal(
      after.status,
      before.status
    );
  }
);

/*
 * =====================================================
 * 11. TABLE/TABLE_MAP CONSISTENCY
 * =====================================================
 */

test(
  "FINAL: tables and table_map statuses agree for matching tenant/name",
  async () => {
    const bad =
      await all(
        `
        SELECT
          t.restaurant_id,
          t.id AS table_id,
          t.name,
          t.status AS table_status,
          tm.status AS map_status

        FROM public.tables t

        JOIN public.table_map tm
          ON tm.restaurant_id =
               t.restaurant_id

         AND LOWER(
               TRIM(
                 tm.name
               )
             ) =
             LOWER(
               TRIM(
                 t.name
               )
             )

        WHERE
          CASE
  WHEN LOWER(
         TRIM(
           COALESCE(
             t.status,
             'free'
           )
         )
       ) IN (
         'free',
         'available'
       )
    THEN 'free'

  ELSE LOWER(
    TRIM(
      COALESCE(
        t.status,
        'free'
      )
    )
  )
END

<>

CASE
  WHEN LOWER(
         TRIM(
           COALESCE(
             tm.status,
             'free'
           )
         )
       ) IN (
         'free',
         'available'
       )
    THEN 'free'

  ELSE LOWER(
    TRIM(
      COALESCE(
        tm.status,
        'free'
      )
    )
  )
END
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Table status drift detected: ${JSON.stringify(
        bad
      )}`
    );
  }
);

/*
 * =====================================================
 * 12. SESSION TENANT INTEGRITY
 * =====================================================
 */

test(
  "FINAL: every POS table session still belongs to its table tenant",
  async () => {
    const bad =
      await all(
        `
        SELECT
          pts.restaurant_id,
          pts.table_id,
          t.restaurant_id
            AS table_restaurant_id

        FROM public.pos_table_sessions pts

        LEFT JOIN public.tables t
          ON t.id =
               pts.table_id

        WHERE
          t.id IS NULL

          OR

          t.restaurant_id <>
            pts.restaurant_id
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Invalid table session ownership: ${JSON.stringify(
        bad
      )}`
    );
  }
);

/*
 * =====================================================
 * 13. FINANCIAL BALANCE INVARIANT
 * =====================================================
 */

test(
  "FINAL: table lifecycle operations never create impossible POS balances",
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
            COALESCE(
              paid,
              0
            ) = 1

            AND

            COALESCE(
              remaining_price,
              0
            ) > 0.01
          )
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Impossible POS balances found: ${JSON.stringify(
        bad
      )}`
    );
  }
);