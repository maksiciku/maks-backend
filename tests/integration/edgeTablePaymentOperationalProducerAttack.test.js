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
        NOW()
      )
      RETURNING
        id,
        table_number,
        total_price,
        amount_paid,
        remaining_price,
        paid
      `,
      [
        fixtures
          .restaurantA,
        tableName,
        `EDGE PAYMENT ${tableName}`,
        amount,
      ]
    );

  assert.ok(
    row?.id
  );

  return row;
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
          "✅ 05 Pay-share partial/full table revisions 1 -> 2 proven"
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
