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
} = require(
  "../setup/resetTestData"
);

const {
  seedTestData,
  TEST_PASSWORD,
} = require(
  "../setup/seedTestData"
);

const {
  assertTestDatabase,
} = require(
  "../safety/assertTestDatabase"
);

const {
  TABLE_OPERATIONAL_EVENT_TYPE,
  tableOperationalDomain,
  normalizeTableName,
} = require(
  "../../edge/contracts/tableOperations"
);

const {
  FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,
} = require(
  "../../edge/contracts/financialOperations"
);


const originalRuntimeRole =
  process.env
    .MAKS_RUNTIME_ROLE;

process.env
  .MAKS_RUNTIME_ROLE =
  "edge";


let app;
let pool;
let fixtures;
let tokenA;


function bearer(
  token
) {
  return `Bearer ${token}`;
}


async function one(
  sql,
  params = []
) {
  const result =
    await pool.query(
      sql,
      params
    );

  return (
    result.rows[0] ||
    null
  );
}


async function count(
  sql,
  params = []
) {
  const row =
    await one(
      sql,
      params
    );

  return Number(
    row?.count ||
    row?.c ||
    0
  );
}


async function ensurePhysicalTable(
  tableName,
  {
    covers = 4,
    allergyCodes = [
      "milk",
    ],
    strict = true,
  } = {}
) {
  let table =
    await one(
      `
      SELECT
        id,
        name,
        status
      FROM
        public.tables
      WHERE
        restaurant_id = $1
        AND LOWER(
              TRIM(name)
            ) =
            LOWER(
              TRIM($2)
            )
      LIMIT 1
      `,
      [
        fixtures
          .restaurantA,
        tableName,
      ]
    );

  if (!table) {
    table =
      await one(
        `
        INSERT INTO public.tables (
          name,
          seats,
          restaurant_id,
          status
        )
        VALUES (
          $1,
          4,
          $2,
          'occupied'
        )
        RETURNING
          id,
          name,
          status
        `,
        [
          tableName,
          fixtures
            .restaurantA,
        ]
      );
  } else {
    await pool.query(
      `
      UPDATE public.tables
      SET
        status = 'occupied'
      WHERE
        id = $1
        AND restaurant_id = $2
      `,
      [
        Number(
          table.id
        ),
        fixtures
          .restaurantA,
      ]
    );

    table.status =
      "occupied";
  }

  await pool.query(
    `
    INSERT INTO public.table_map (
      restaurant_id,
      name,
      seats,
      status,
      x,
      y,
      zone,
      shape
    )
    VALUES (
      $1,
      $2,
      4,
      'occupied',
      0,
      0,
      'Main',
      'rect'
    )
    ON CONFLICT DO NOTHING
    `,
    [
      fixtures
        .restaurantA,
      tableName,
    ]
  );

  await pool.query(
    `
    UPDATE public.table_map
    SET
      status = 'occupied'
    WHERE
      restaurant_id = $1
      AND LOWER(
            TRIM(name)
          ) =
          LOWER(
            TRIM($2)
          )
    `,
    [
      fixtures
        .restaurantA,
      tableName,
    ]
  );

  await pool.query(
    `
    INSERT INTO public.pos_table_sessions (
      restaurant_id,
      table_id,
      covers,
      allergy_codes,
      strict_cross_contamination
    )
    VALUES (
      $1,
      $2,
      $3,
      $4::jsonb,
      $5
    )
    ON CONFLICT (
      restaurant_id,
      table_id
    )
    DO UPDATE SET
      covers =
        EXCLUDED.covers,
      allergy_codes =
        EXCLUDED.allergy_codes,
      strict_cross_contamination =
        EXCLUDED.strict_cross_contamination,
      updated_at =
        now()
    `,
    [
      fixtures
        .restaurantA,
      Number(
        table.id
      ),
      covers,
      JSON.stringify(
        allergyCodes
      ),
      strict,
    ]
  );

  return table;
}


async function seedPosOrder(
  tableName,
  amount = 12.5
) {
  const normalized =
    String(
      tableName || ""
    )
      .trim()
      .toLowerCase();

  const orderType =
    normalized === "takeaway"
      ? "takeaway"
      : normalized === "delivery"
        ? "delivery"
        : "dine-in";

  /*
   * Model a real Edge POS row.
   *
   * Local pos_orders.id is NEVER portable authority.
   */
  const batch =
    await one(
      `
      INSERT INTO public.order_batches (
        id,
        table_number,
        restaurant_id,
        created_at,
        order_type,
        pickup_number,
        requested_payment_method
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        NOW(),
        $3,
        $4,
        'cash'
      )
      RETURNING
        id
      `,
      [
        tableName,

        fixtures
          .restaurantA,

        orderType,

        orderType ===
          "takeaway"
          ? 952
          : null,
      ]
    );

  assert.ok(
    batch?.id
  );

  const row =
    await one(
      `
      INSERT INTO public.pos_orders (
        restaurant_id,
        table_number,
        item_name,
        quantity,
        total_price,
        item_type,
        order_status,
        paid,
        amount_paid,
        remaining_price,
        source,
        batch_id,
        edge_submission_id,
        edge_row_ordinal,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        1,
        $4,
        'meal',
        'open',
        0,
        0,
        $4,
        'pos',
        $5::uuid,
        gen_random_uuid(),
        1,
        NOW()
      )
      RETURNING
        id,
        table_number,
        total_price,
        amount_paid,
        remaining_price,
        paid,
        batch_id,
        edge_submission_id,
        edge_row_ordinal
      `,
      [
        fixtures
          .restaurantA,

        tableName,

        `EDGE PAYMENT ${tableName}`,

        amount,

        batch.id,
      ]
    );

  assert.ok(
    row?.id
  );

  assert.match(
    String(
      row.batch_id
    ),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  assert.match(
    String(
      row.edge_submission_id
    ),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  assert.equal(
    Number(
      row.edge_row_ordinal
    ),
    1
  );

  return row;
}


async function financialSettlementEvents(
  tableName = null
) {
  const safeTableName =
    tableName == null
      ? null
      : String(
          tableName
        );

  const result =
    await pool.query(
      `
      SELECT
        event_id,
        entity_id,
        idempotency_key,
        payload,
        status

      FROM
        public.edge_outbox

      WHERE
        restaurant_id = $1
        AND event_type = $2

        AND (
          $3::text IS NULL
          OR
          payload
            -> 'settlement'
            ->> 'table_number' =
          $3
        )

      ORDER BY
        id ASC
      `,
      [
        fixtures
          .restaurantA,

        FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,

        safeTableName,
      ]
    );

  return result.rows;
}


async function tableEventRows(
  tableName
) {
  const result =
    await pool.query(
      `
      SELECT
        event_id,
        entity_id,
        payload,
        status
      FROM
        public.edge_outbox
      WHERE
        restaurant_id = $1
        AND event_type = $2
        AND entity_id = $3
      ORDER BY
        id ASC
      `,
      [
        fixtures
          .restaurantA,
        TABLE_OPERATIONAL_EVENT_TYPE,
        normalizeTableName(
          tableName
        ),
      ]
    );

  return result.rows;
}


async function tableRevision(
  tableName
) {
  return one(
    `
    SELECT
      produced_revision
    FROM
      public.edge_domain_revisions
    WHERE
      restaurant_id = $1
      AND domain = $2
    `,
    [
      fixtures
        .restaurantA,
      tableOperationalDomain(
        tableName
      ),
    ]
  );
}


async function tableState(
  tableName
) {
  const table =
    await one(
      `
      SELECT
        id,
        status
      FROM
        public.tables
      WHERE
        restaurant_id = $1
        AND LOWER(
              TRIM(name)
            ) =
            LOWER(
              TRIM($2)
            )
      LIMIT 1
      `,
      [
        fixtures
          .restaurantA,
        tableName,
      ]
    );

  const map =
    await one(
      `
      SELECT
        status
      FROM
        public.table_map
      WHERE
        restaurant_id = $1
        AND LOWER(
              TRIM(name)
            ) =
            LOWER(
              TRIM($2)
            )
      LIMIT 1
      `,
      [
        fixtures
          .restaurantA,
        tableName,
      ]
    );

  const session =
    table?.id
      ? await one(
          `
          SELECT
            covers,
            allergy_codes,
            strict_cross_contamination
          FROM
            public.pos_table_sessions
          WHERE
            restaurant_id = $1
            AND table_id = $2
          LIMIT 1
          `,
          [
            fixtures
              .restaurantA,
            Number(
              table.id
            ),
          ]
        )
      : null;

  return {
    table,
    map,
    session,
  };
}


async function markPaid(
  row
) {
  return request(
    app
  )
    .post(
      "/orders/mark-paid"
    )
    .set(
      "Authorization",
      bearer(
        tokenA
      )
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

      manualDiscountAmount:
        0,

      serviceChargeAmount:
        0,

      terminalRef:
        "EDGE-TABLE-PAYMENT-ATTACK",
    });
}


async function markPaidWithPayments(
  row,
  payments
) {
  return request(
    app
  )
    .post(
      "/orders/mark-paid"
    )
    .set(
      "Authorization",
      bearer(
        tokenA
      )
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

      payments,

      manualDiscountAmount:
        0,

      serviceChargeAmount:
        0,

      terminalRef:
        "EDGE-MULTI-TENDER-ATTACK",
    });
}


async function payShare(
  tableName,
  amount
) {
  return request(
    app
  )
    .post(
      "/orders/pay-share"
    )
    .set(
      "Authorization",
      bearer(
        tokenA
      )
    )
    .send({
      tableNumber:
        tableName,

      amount,

      paymentMethod:
        "cash",
    });
}


async function removeFinancialFailureTrigger() {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_financial_settlement_edge
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_financial_settlement_edge()
  `);
}


async function installFinancialFailureTrigger() {
  await removeFinancialFailureTrigger();

  await pool.query(`
    CREATE OR REPLACE FUNCTION
      public.maks_test_reject_financial_settlement_edge()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.event_type =
        '${FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE}'
      THEN
        RAISE EXCEPTION
          'MAKS_TEST_FORCED_FINANCIAL_SETTLEMENT_OUTBOX_FAILURE';
      END IF;

      RETURN NEW;
    END;
    $$
  `);

  await pool.query(`
    CREATE TRIGGER
      trg_maks_test_reject_financial_settlement_edge
    BEFORE INSERT
    ON public.edge_outbox
    FOR EACH ROW
    EXECUTE FUNCTION
      public.maks_test_reject_financial_settlement_edge()
  `);
}


async function removeFailureTrigger() {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_table_payment_edge
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_table_payment_edge()
  `);
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
      "REFUSED: table payment Edge producer Attack may run only against maks_test"
    );

    pool =
      safe.pool;

    await removeFailureTrigger();
    await removeFinancialFailureTrigger();

    ({
      app,
    } =
      require(
        "../../server"
      ));

    const loginA =
      await request(
        app
      )
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_test_owner_a",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures
              .restaurantA,
        });

    assert.equal(
      loginA.status,
      200,
      JSON.stringify(
        loginA.body
      )
    );

    tokenA =
      loginA.body
        ?.token;

    assert.ok(
      tokenA
    );

    /*
     * void-unpaid requires a real manager/owner PIN.
     * Set a test-only PIN on the seeded owner.
     */
    await pool.query(
      `
      UPDATE public.users
      SET
        pin_hash = $1,
        can_pos_login = TRUE,
        is_active = TRUE
      WHERE
        id = $2
      `,
      [
        bcrypt.hashSync(
          "9417",
          10
        ),
        fixtures
          .ownerA,
      ]
    );

    console.log(
      "✅ 01 Database + owner + payment lifecycle fixtures ready"
    );
  }
);


test.after(
  async () => {
    process.env
      .MAKS_RUNTIME_ROLE =
      "edge";

    if (pool) {
      try {
        await removeFailureTrigger();
      } catch {}

      try {
        await removeFinancialFailureTrigger();
      } catch {}

      try {
        await resetTestData();
      } catch {}

      try {
        await pool.end();
      } catch {}
    }

    if (
      originalRuntimeRole ===
      undefined
    ) {
      delete process.env
        .MAKS_RUNTIME_ROLE;
    } else {
      process.env
        .MAKS_RUNTIME_ROLE =
        originalRuntimeRole;
    }
  }
);


test(
  "MAKS table payment Edge operational producer attack",
  async (t) => {
    await t.test(
      "full mark-paid emits occupied_paid + session null at revision 1",
      async () => {
        const tableName =
          "Table 951";

        await ensurePhysicalTable(
          tableName,
          {
            covers:
              5,
          }
        );

        const row =
          await seedPosOrder(
            tableName,
            12.5
          );

        const response =
          await markPaid(
            row
          );

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const financialEvents =
          await financialSettlementEvents(
            tableName
          );

        assert.equal(
          financialEvents.length,
          1,
          "Full Edge payment did not create exactly one financial settlement event"
        );

        const financialEvent =
          financialEvents[0];

        const payload =
          financialEvent.payload;

        assert.equal(
          payload
            ?.schema_version,
          1
        );

        assert.equal(
          Number(
            payload
              ?.restaurant_id
          ),
          fixtures
            .restaurantA
        );

        assert.equal(
          payload
            ?.settlement
            ?.table_number,
          tableName
        );

        assert.match(
          String(
            payload
              ?.settlement
              ?.id ||
            ""
          ),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        assert.equal(
          financialEvent
            .entity_id,
          payload
            .settlement
            .id
        );

        assert.equal(
          financialEvent
            .idempotency_key,
          `${FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE}:${payload.settlement.id}`
        );

        assert.equal(
          payload
            .settlement
            .order_refs
            .length,
          1
        );

        assert.equal(
          payload
            .settlement
            .order_refs[0]
            .edge_submission_id,
          String(
            row.edge_submission_id
          )
            .toLowerCase()
        );

        assert.equal(
          Number(
            payload
              .settlement
              .order_refs[0]
              .edge_row_ordinal
          ),
          1
        );

        assert.equal(
          payload
            .settlement
            .order_refs[0]
            .batch_id,
          String(
            row.batch_id
          )
            .toLowerCase()
        );

        assert.equal(
          payload
            .tenders
            .length,
          1
        );

        assert.match(
          String(
            payload
              .tenders[0]
              .payment_uuid ||
            ""
          ),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        assert.equal(
          payload
            .tenders[0]
            .ref_payment_uuid,
          null
        );

        assert.equal(
          JSON.stringify(
            payload
          ).includes(
            `"pos_order_id":${Number(row.id)}`
          ),
          false,
          "Financial event leaked Edge-local POS BIGINT identity"
        );

        const state =
          await tableState(
            tableName
          );

        assert.equal(
          state.table
            .status,
          "occupied_paid"
        );

        assert.equal(
          state.map
            .status,
          "occupied_paid"
        );

        assert.equal(
          state.session,
          null
        );

        const events =
          await tableEventRows(
            tableName
          );

        assert.equal(
          events.length,
          1
        );

        assert.equal(
          Number(
            events[0]
              .payload
              .revision
          ),
          1
        );

        assert.equal(
          events[0]
            .payload
            .table
            .status,
          "occupied_paid"
        );

        assert.equal(
          events[0]
            .payload
            .session,
          null
        );

        console.log(
          "✅ 02 Full mark-paid -> occupied_paid + session null + revision 1"
        );
      }
    );


    await t.test(
      "virtual Takeaway payment succeeds without manufacturing a physical table event",
      async () => {
        const row =
          await seedPosOrder(
            "Takeaway",
            8.5
          );

        const response =
          await markPaid(
            row
          );

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const events =
          await tableEventRows(
            "Takeaway"
          );

        assert.equal(
          events.length,
          0
        );

        const revision =
          await tableRevision(
            "Takeaway"
          );

        assert.equal(
          revision,
          null
        );

        console.log(
          "✅ 03 Takeaway payment preserved without fake physical-table event"
        );
      }
    );


    await t.test(
      "forced financial outbox failure rolls settlement + tender + POS payment state back together",
      async () => {
        const tableName =
          "Table 956";

        await ensurePhysicalTable(
          tableName,
          {
            covers:
              3,
          }
        );

        const row =
          await seedPosOrder(
            tableName,
            11.75
          );

        const paymentCountBefore =
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          );

        const settlementCountBefore =
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payment_settlements
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          );

        const financialCountBefore =
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type = $2
            `,
            [
              fixtures
                .restaurantA,
              FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,
            ]
          );

        await installFinancialFailureTrigger();

        const response =
          await markPaid(
            row
          );

        assert.equal(
          response.status,
          500
        );

        await removeFinancialFailureTrigger();

        const pos =
          await one(
            `
            SELECT
              paid,
              amount_paid,
              remaining_price
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND id = $2
            `,
            [
              fixtures
                .restaurantA,
              Number(
                row.id
              ),
            ]
          );

        assert.equal(
          Number(
            pos.paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.amount_paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.remaining_price
          ),
          11.75
        );

        assert.equal(
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          ),
          paymentCountBefore
        );

        assert.equal(
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payment_settlements
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          ),
          settlementCountBefore
        );

        assert.equal(
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type = $2
            `,
            [
              fixtures
                .restaurantA,
              FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,
            ]
          ),
          financialCountBefore
        );

        const state =
          await tableState(
            tableName
          );

        assert.equal(
          state.table
            .status,
          "occupied"
        );

        assert.ok(
          state.session
        );

        console.log(
          "✅ Financial settlement/outbox/payment rollback proven"
        );
      }
    );


    await t.test(
      "forced table outbox failure rolls payment + table + session + revision back together",
      async () => {
        const tableName =
          "Table 952";

        await ensurePhysicalTable(
          tableName,
          {
            covers:
              6,

            allergyCodes: [
              "egg",
            ],
          }
        );

        const row =
          await seedPosOrder(
            tableName,
            9.25
          );

        const paymentCountBefore =
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          );

        const settlementCountBefore =
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payment_settlements
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          );

        await removeFailureTrigger();

        await pool.query(`
          CREATE OR REPLACE FUNCTION
            public.maks_test_reject_table_payment_edge()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.event_type =
              '${TABLE_OPERATIONAL_EVENT_TYPE}'
            THEN
              RAISE EXCEPTION
                'MAKS_TEST_FORCED_TABLE_PAYMENT_OUTBOX_FAILURE';
            END IF;

            RETURN NEW;
          END;
          $$
        `);

        await pool.query(`
          CREATE TRIGGER
            trg_maks_test_reject_table_payment_edge
          BEFORE INSERT
          ON public.edge_outbox
          FOR EACH ROW
          EXECUTE FUNCTION
            public.maks_test_reject_table_payment_edge()
        `);

        const response =
          await markPaid(
            row
          );

        assert.equal(
          response.status,
          500
        );

        await removeFailureTrigger();

        const pos =
          await one(
            `
            SELECT
              paid,
              amount_paid,
              remaining_price
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND id = $2
            `,
            [
              fixtures
                .restaurantA,
              Number(
                row.id
              ),
            ]
          );

        assert.equal(
          Number(
            pos.paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.amount_paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.remaining_price
          ),
          9.25
        );

        const state =
          await tableState(
            tableName
          );

        assert.equal(
          state.table
            .status,
          "occupied"
        );

        assert.equal(
          state.map
            .status,
          "occupied"
        );

        assert.equal(
          Number(
            state.session
              ?.covers
          ),
          6
        );

        assert.equal(
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          ),
          paymentCountBefore
        );

        assert.equal(
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payment_settlements
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          ),
          settlementCountBefore
        );

        assert.equal(
          await tableRevision(
            tableName
          ),
          null
        );

        assert.equal(
          (
            await tableEventRows(
              tableName
            )
          ).length,
          0
        );

        console.log(
          "✅ 04 Payment + table/session/revision/outbox rollback proven"
        );
      }
    );


    await t.test(
      "pay-share emits occupied at revision 1 then occupied_paid/session-null at revision 2",
      async () => {
        const tableName =
          "Table 953";

        await ensurePhysicalTable(
          tableName,
          {
            covers:
              4,
          }
        );

        const row =
          await seedPosOrder(
            tableName,
            10
          );

        const first =
          await payShare(
            tableName,
            4
          );

        assert.equal(
          first.status,
          200,
          JSON.stringify(
            first.body
          )
        );

        assert.equal(
          Number(
            first.body
              ?.unpaid_left
          ),
          1
        );

        let financialEvents =
          await financialSettlementEvents(
            tableName
          );

        assert.equal(
          financialEvents.length,
          1,
          "First pay-share did not create exactly one financial settlement event"
        );

        const firstFinancial =
          financialEvents[0];

        const firstPayload =
          firstFinancial.payload;

        assert.equal(
          Number(
            firstPayload
              ?.settlement
              ?.final_amount
          ),
          4
        );

        assert.equal(
          Number(
            firstPayload
              ?.settlement
              ?.gross_amount
          ),
          4
        );

        assert.equal(
          firstPayload
            ?.settlement
            ?.order_refs
            ?.length,
          1
        );

        assert.equal(
          firstPayload
            ?.tenders
            ?.length,
          1
        );

        assert.equal(
          firstPayload
            .settlement
            .order_refs[0]
            .edge_submission_id,
          String(
            row.edge_submission_id
          ).toLowerCase()
        );

        assert.equal(
          Number(
            firstPayload
              .settlement
              .order_refs[0]
              .edge_row_ordinal
          ),
          Number(
            row.edge_row_ordinal
          )
        );

        assert.equal(
          firstPayload
            .settlement
            .order_refs[0]
            .batch_id,
          String(
            row.batch_id
          ).toLowerCase()
        );

        assert.equal(
          firstPayload
            .tenders[0]
            .order_refs[0]
            .edge_submission_id,
          String(
            row.edge_submission_id
          ).toLowerCase()
        );

        assert.match(
          String(
            firstPayload
              .settlement
              .id ||
            ""
          ),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        assert.match(
          String(
            firstPayload
              .tenders[0]
              .payment_uuid ||
            ""
          ),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        assert.equal(
          firstFinancial.entity_id,
          firstPayload
            .settlement
            .id
        );

        assert.equal(
          firstFinancial.idempotency_key,
          `${FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE}:${firstPayload.settlement.id}`
        );

        assert.equal(
          JSON.stringify(
            firstPayload
          ).includes(
            `"pos_order_id":${Number(row.id)}`
          ),
          false,
          "First pay-share financial event leaked Edge-local POS BIGINT identity"
        );

        const firstSettlementUuid =
          firstPayload
            .settlement
            .id;

        const firstTenderUuid =
          firstPayload
            .tenders[0]
            .payment_uuid;

        const firstEventId =
          firstFinancial.event_id;

        let state =
          await tableState(
            tableName
          );

        assert.equal(
          state.table
            .status,
          "occupied"
        );

        assert.ok(
          state.session
        );

        let events =
          await tableEventRows(
            tableName
          );

        assert.equal(
          events.length,
          1
        );

        assert.equal(
          Number(
            events[0]
              .payload
              .revision
          ),
          1
        );

        assert.equal(
          events[0]
            .payload
            .table
            .status,
          "occupied"
        );

        assert.ok(
          events[0]
            .payload
            .session
        );

        const second =
          await payShare(
            tableName,
            6
          );

        assert.equal(
          second.status,
          200,
          JSON.stringify(
            second.body
          )
        );

        assert.equal(
          Number(
            second.body
              ?.unpaid_left
          ),
          0
        );

        financialEvents =
          await financialSettlementEvents(
            tableName
          );

        assert.equal(
          financialEvents.length,
          2,
          "Second pay-share did not create the second financial settlement event"
        );

        const secondFinancial =
          financialEvents[1];

        const secondPayload =
          secondFinancial.payload;

        assert.equal(
          Number(
            secondPayload
              ?.settlement
              ?.final_amount
          ),
          6
        );

        assert.equal(
          Number(
            secondPayload
              ?.settlement
              ?.gross_amount
          ),
          6
        );

        assert.equal(
          secondPayload
            ?.settlement
            ?.order_refs
            ?.length,
          1
        );

        assert.equal(
          secondPayload
            ?.tenders
            ?.length,
          1
        );

        assert.equal(
          secondPayload
            .settlement
            .order_refs[0]
            .edge_submission_id,
          String(
            row.edge_submission_id
          ).toLowerCase()
        );

        assert.equal(
          secondPayload
            .tenders[0]
            .order_refs[0]
            .edge_submission_id,
          String(
            row.edge_submission_id
          ).toLowerCase()
        );

        assert.match(
          String(
            secondPayload
              .settlement
              .id ||
            ""
          ),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        assert.match(
          String(
            secondPayload
              .tenders[0]
              .payment_uuid ||
            ""
          ),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        assert.notEqual(
          secondPayload
            .settlement
            .id,
          firstSettlementUuid,
          "Two independent shares reused one settlement UUID"
        );

        assert.notEqual(
          secondPayload
            .tenders[0]
            .payment_uuid,
          firstTenderUuid,
          "Two independent shares reused one tender payment_uuid"
        );

        assert.notEqual(
          secondFinancial
            .event_id,
          firstEventId,
          "Two independent shares reused one Edge event UUID"
        );

        assert.notEqual(
          secondFinancial
            .idempotency_key,
          firstFinancial
            .idempotency_key,
          "Two independent shares reused one idempotency key"
        );

        assert.equal(
          secondFinancial.entity_id,
          secondPayload
            .settlement
            .id
        );

        assert.equal(
          JSON.stringify(
            secondPayload
          ).includes(
            `"pos_order_id":${Number(row.id)}`
          ),
          false,
          "Second pay-share financial event leaked Edge-local POS BIGINT identity"
        );

        state =
          await tableState(
            tableName
          );

        assert.equal(
          state.table
            .status,
          "occupied_paid"
        );

        assert.equal(
          state.session,
          null
        );

        events =
          await tableEventRows(
            tableName
          );

        assert.equal(
          events.length,
          2
        );

        assert.equal(
          Number(
            events[1]
              .payload
              .revision
          ),
          2
        );

        assert.equal(
          events[1]
            .payload
            .table
            .status,
          "occupied_paid"
        );

        assert.equal(
          events[1]
            .payload
            .session,
          null
        );

        console.log(
          "✅ 05 Pay-share financial settlements + table revisions 1 -> 2 proven"
        );
      }
    );


    await t.test(
      "forced pay-share financial outbox failure rolls FIFO balance + settlement + tender back together",
      async () => {
        const tableName =
          "Table 957";

        await ensurePhysicalTable(
          tableName,
          {
            covers:
              5,
          }
        );

        const row =
          await seedPosOrder(
            tableName,
            10
          );

        const paymentCountBefore =
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          );

        const settlementCountBefore =
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payment_settlements
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          );

        assert.equal(
          (
            await financialSettlementEvents(
              tableName
            )
          ).length,
          0
        );

        await installFinancialFailureTrigger();

        const response =
          await payShare(
            tableName,
            4
          );

        assert.equal(
          response.status,
          500
        );

        await removeFinancialFailureTrigger();

        const pos =
          await one(
            `
            SELECT
              paid,
              amount_paid,
              remaining_price
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND id = $2
            `,
            [
              fixtures
                .restaurantA,
              Number(
                row.id
              ),
            ]
          );

        assert.equal(
          Number(
            pos.paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.amount_paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.remaining_price
          ),
          10
        );

        assert.equal(
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          ),
          paymentCountBefore
        );

        assert.equal(
          await count(
            `
            SELECT
              COUNT(*)::int AS count
            FROM
              public.payment_settlements
            WHERE
              restaurant_id = $1
              AND LOWER(
                    TRIM(table_number)
                  ) =
                  LOWER(
                    TRIM($2)
                  )
            `,
            [
              fixtures
                .restaurantA,
              tableName,
            ]
          ),
          settlementCountBefore
        );

        assert.equal(
          (
            await financialSettlementEvents(
              tableName
            )
          ).length,
          0
        );

        assert.equal(
          await tableRevision(
            tableName
          ),
          null
        );

        assert.equal(
          (
            await tableEventRows(
              tableName
            )
          ).length,
          0
        );

        const state =
          await tableState(
            tableName
          );

        assert.equal(
          state.table
            .status,
          "occupied"
        );

        assert.equal(
          Number(
            state.session
              ?.covers
          ),
          5
        );

        console.log(
          "✅ Pay-share financial outbox/FIFO rollback proven"
        );
      }
    );


    await t.test(
      "multi-tender full payment preserves two distinct portable tender UUIDs in one settlement",
      async () => {
        const tableName =
          "Table 958";

        await ensurePhysicalTable(
          tableName,
          {
            covers:
              2,
          }
        );

        const row =
          await seedPosOrder(
            tableName,
            12.5
          );

        const response =
          await markPaidWithPayments(
            row,
            [
              {
                method:
                  "cash",

                amount:
                  5,
              },

              {
                method:
                  "card",

                amount:
                  7.5,
              },
            ]
          );

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const financialEvents =
          await financialSettlementEvents(
            tableName
          );

        assert.equal(
          financialEvents.length,
          1,
          "Multi-tender payment did not create exactly one financial settlement event"
        );

        const event =
          financialEvents[0];

        const payload =
          event.payload;

        assert.equal(
          Number(
            payload
              ?.settlement
              ?.final_amount
          ),
          12.5
        );

        assert.equal(
          payload
            ?.tenders
            ?.length,
          2
        );

        const tenderAmounts =
          payload
            .tenders
            .map(
              (tender) =>
                Number(
                  tender.amount
                )
            )
            .sort(
              (a, b) =>
                a - b
            );

        assert.deepEqual(
          tenderAmounts,
          [
            5,
            7.5,
          ]
        );

        const tenderMethods =
          payload
            .tenders
            .map(
              (tender) =>
                tender.method
            )
            .sort();

        assert.deepEqual(
          tenderMethods,
          [
            "card",
            "cash",
          ]
        );

        const firstUuid =
          String(
            payload
              .tenders[0]
              .payment_uuid ||
            ""
          );

        const secondUuid =
          String(
            payload
              .tenders[1]
              .payment_uuid ||
            ""
          );

        const uuidRegex =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

        assert.match(
          firstUuid,
          uuidRegex
        );

        assert.match(
          secondUuid,
          uuidRegex
        );

        assert.notEqual(
          firstUuid,
          secondUuid,
          "Two tenders in one settlement reused one payment_uuid"
        );

        for (
          const tender of
          payload.tenders
        ) {
          assert.equal(
            tender
              .ref_payment_uuid,
            null
          );

          assert.equal(
            tender
              .order_refs
              .length,
            1
          );

          assert.equal(
            tender
              .order_refs[0]
              .edge_submission_id,
            String(
              row.edge_submission_id
            ).toLowerCase()
          );

          assert.equal(
            Number(
              tender
                .order_refs[0]
                .edge_row_ordinal
            ),
            Number(
              row.edge_row_ordinal
            )
          );

          assert.equal(
            tender
              .order_refs[0]
              .batch_id,
            String(
              row.batch_id
            ).toLowerCase()
          );
        }

        assert.equal(
          event.entity_id,
          payload
            .settlement
            .id
        );

        assert.equal(
          event.idempotency_key,
          `${FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE}:${payload.settlement.id}`
        );

        assert.equal(
          JSON.stringify(
            payload
          ).includes(
            `"pos_order_id":${Number(row.id)}`
          ),
          false,
          "Multi-tender financial event leaked Edge-local POS BIGINT identity"
        );

        console.log(
          "✅ Multi-tender settlement preserves distinct portable payment UUIDs"
        );
      }
    );


    await t.test(
      "financial producer emits only from explicit Edge runtime",
      async () => {
        /*
         * Missing runtime role:
         *
         * Payment remains valid for legacy/non-directional
         * runtime, but MUST NOT manufacture an Edge event.
         */
        const missingRoleTable =
          "Table 959";

        await ensurePhysicalTable(
          missingRoleTable,
          {
            covers:
              2,
          }
        );

        const missingRoleRow =
          await seedPosOrder(
            missingRoleTable,
            8.25
          );

        delete process.env
          .MAKS_RUNTIME_ROLE;

        try {
          const response =
            await markPaid(
              missingRoleRow
            );

          assert.equal(
            response.status,
            200,
            JSON.stringify(
              response.body
            )
          );

          assert.equal(
            (
              await financialSettlementEvents(
                missingRoleTable
              )
            ).length,
            0,
            "Missing runtime role incorrectly emitted an Edge financial event"
          );

          assert.equal(
            (
              await tableEventRows(
                missingRoleTable
              )
            ).length,
            0,
            "Missing runtime role incorrectly emitted an Edge table event"
          );

          const pos =
            await one(
              `
              SELECT
                paid,
                amount_paid,
                remaining_price

              FROM
                public.pos_orders

              WHERE
                restaurant_id = $1
                AND id = $2
              `,
              [
                fixtures
                  .restaurantA,

                Number(
                  missingRoleRow.id
                ),
              ]
            );

          assert.equal(
            Number(
              pos.paid
            ),
            1
          );

          assert.equal(
            Number(
              pos.amount_paid
            ),
            8.25
          );

          assert.equal(
            Number(
              pos.remaining_price
            ),
            0
          );
        } finally {
          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";
        }


        /*
         * Explicit Cloud runtime:
         *
         * Cloud must also never feed a financial settlement
         * back into the Edge outbox.
         */
        const cloudTable =
          "Table 960";

        await ensurePhysicalTable(
          cloudTable,
          {
            covers:
              3,
          }
        );

        const cloudRow =
          await seedPosOrder(
            cloudTable,
            9.5
          );

        process.env
          .MAKS_RUNTIME_ROLE =
          "cloud";

        try {
          const response =
            await markPaid(
              cloudRow
            );

          assert.equal(
            response.status,
            200,
            JSON.stringify(
              response.body
            )
          );

          assert.equal(
            (
              await financialSettlementEvents(
                cloudTable
              )
            ).length,
            0,
            "Cloud runtime incorrectly emitted an Edge financial event"
          );

          assert.equal(
            (
              await tableEventRows(
                cloudTable
              )
            ).length,
            0,
            "Cloud runtime incorrectly emitted an Edge table event"
          );

          const settlementCount =
            await count(
              `
              SELECT
                COUNT(*)::int AS count

              FROM
                public.payment_settlements

              WHERE
                restaurant_id = $1

                AND LOWER(
                      TRIM(table_number)
                    ) =
                    LOWER(
                      TRIM($2)
                    )
              `,
              [
                fixtures
                  .restaurantA,

                cloudTable,
              ]
            );

          const paymentCount =
            await count(
              `
              SELECT
                COUNT(*)::int AS count

              FROM
                public.payments

              WHERE
                restaurant_id = $1

                AND LOWER(
                      TRIM(table_number)
                    ) =
                    LOWER(
                      TRIM($2)
                    )
              `,
              [
                fixtures
                  .restaurantA,

                cloudTable,
              ]
            );

          assert.equal(
            settlementCount,
            1
          );

          assert.equal(
            paymentCount,
            1
          );
        } finally {
          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";
        }

        console.log(
          "✅ Financial producer directionality: Edge only"
        );
      }
    );


    await t.test(
      "refund reopens the paid bill and emits newer occupied table snapshot",
      async () => {
        const tableName =
          "Table 954";

        await ensurePhysicalTable(
          tableName,
          {
            covers:
              3,
          }
        );

        const row =
          await seedPosOrder(
            tableName,
            11
          );

        const payment =
          await markPaid(
            row
          );

        assert.equal(
          payment.status,
          200,
          JSON.stringify(
            payment.body
          )
        );

        const paymentId =
          Number(
            payment.body
              ?.payment_ids
              ?.[0]
          );

        assert.ok(
          paymentId > 0
        );

        const refund =
          await request(
            app
          )
            .post(
              `/orders/payments/${paymentId}/refund`
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send({
              amount:
                11,

              reason:
                "EDGE TABLE REFUND ATTACK",
            });

        assert.equal(
          refund.status,
          200,
          JSON.stringify(
            refund.body
          )
        );

        const pos =
          await one(
            `
            SELECT
              paid,
              amount_paid,
              remaining_price
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND id = $2
            `,
            [
              fixtures
                .restaurantA,
              Number(
                row.id
              ),
            ]
          );

        assert.equal(
          Number(
            pos.paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.amount_paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.remaining_price
          ),
          11
        );

        const state =
          await tableState(
            tableName
          );

        assert.equal(
          state.table
            .status,
          "occupied"
        );

        /*
         * Current business behavior does not recreate a table
         * session after refund; the Edge snapshot must reflect
         * the real state, not invent one.
         */
        assert.equal(
          state.session,
          null
        );

        const events =
          await tableEventRows(
            tableName
          );

        assert.equal(
          events.length,
          2
        );

        assert.equal(
          Number(
            events[1]
              .payload
              .revision
          ),
          2
        );

        assert.equal(
          events[1]
            .payload
            .table
            .status,
          "occupied"
        );

        assert.equal(
          events[1]
            .payload
            .session,
          null
        );

        console.log(
          "✅ 06 Refund reopens bill and emits newer occupied snapshot"
        );
      }
    );


    await t.test(
      "void-unpaid frees table, clears session and emits revision 1",
      async () => {
        const tableName =
          "Table 955";

        await ensurePhysicalTable(
          tableName,
          {
            covers:
              2,

            allergyCodes: [
              "sesame",
            ],
          }
        );

        const row =
          await seedPosOrder(
            tableName,
            7.75
          );

        const response =
          await request(
            app
          )
            .post(
              `/orders/void-unpaid/${encodeURIComponent(
                tableName
              )}`
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send({
              reason:
                "EDGE VOID UNPAID ATTACK",

              manager_pin:
                "9417",
            });

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const pos =
          await one(
            `
            SELECT
              paid,
              amount_paid,
              remaining_price,
              order_status
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND id = $2
            `,
            [
              fixtures
                .restaurantA,
              Number(
                row.id
              ),
            ]
          );

        assert.equal(
          Number(
            pos.paid
          ),
          1
        );

        assert.equal(
          Number(
            pos.amount_paid
          ),
          0
        );

        assert.equal(
          Number(
            pos.remaining_price
          ),
          0
        );

        assert.equal(
          String(
            pos.order_status
          ).toLowerCase(),
          "voided"
        );

        const state =
          await tableState(
            tableName
          );

        assert.equal(
          state.table
            .status,
          "free"
        );

        assert.equal(
          state.map
            .status,
          "free"
        );

        assert.equal(
          state.session,
          null
        );

        const events =
          await tableEventRows(
            tableName
          );

        assert.equal(
          events.length,
          1
        );

        assert.equal(
          Number(
            events[0]
              .payload
              .revision
          ),
          1
        );

        assert.equal(
          events[0]
            .payload
            .table
            .status,
          "free"
        );

        assert.equal(
          events[0]
            .payload
            .session,
          null
        );

        console.log(
          "✅ 07 Void-unpaid -> free + session null + revision 1"
        );
      }
    );


    console.log(
      "========================================================="
    );

    console.log(
      "✅ MAKS TABLE PAYMENT EDGE PRODUCER ATTACK COMPLETE"
    );

    console.log(
      "========================================================="
    );
  }
);
