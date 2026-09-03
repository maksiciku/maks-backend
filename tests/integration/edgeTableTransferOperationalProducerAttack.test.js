"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const request =
  require("supertest");

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
  TABLE_BATCH_ASSIGNMENT_EVENT_TYPE,
  normalizeTableName,
  tableOperationalDomain,
  tableBatchAssignmentDomain,
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
let tokenB;


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


async function all(
  sql,
  params = []
) {
  const result =
    await pool.query(
      sql,
      params
    );

  return result.rows;
}


async function ensurePhysicalTable(
  restaurantId,
  tableName,
  status = "free"
) {
  let row =
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
        restaurantId,
        tableName,
      ]
    );

  if (!row) {
    row =
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
          $3
        )
        RETURNING
          id,
          name,
          status
        `,
        [
          tableName,
          restaurantId,
          status,
        ]
      );
  } else {
    await pool.query(
      `
      UPDATE public.tables
      SET
        status = $1
      WHERE
        id = $2
        AND restaurant_id = $3
      `,
      [
        status,
        Number(
          row.id
        ),
        restaurantId,
      ]
    );

    row.status =
      status;
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
      $3,
      0,
      0,
      'Main',
      'rect'
    )
    ON CONFLICT DO NOTHING
    `,
    [
      restaurantId,
      tableName,
      status,
    ]
  );

  await pool.query(
    `
    UPDATE public.table_map
    SET
      status = $1
    WHERE
      restaurant_id = $2
      AND LOWER(
            TRIM(name)
          ) =
          LOWER(
            TRIM($3)
          )
    `,
    [
      status,
      restaurantId,
      tableName,
    ]
  );

  return row;
}


async function putSession(
  restaurantId,
  tableId,
  {
    covers = 4,
    allergens = [
      "milk",
    ],
    strict = true,
  } = {}
) {
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
        NOW()
    `,
    [
      restaurantId,
      Number(
        tableId
      ),
      covers,
      JSON.stringify(
        allergens
      ),
      strict,
    ]
  );
}


async function seedBatchBill({
  restaurantId,
  tableNumber,
  orderType = "dine-in",
  pickupNumber = null,
  amount = 12.5,
  batchId =
    crypto.randomUUID(),
}) {
  await pool.query(
    `
    INSERT INTO public.order_batches (
      id,
      table_number,
      restaurant_id,
      order_type,
      pickup_number,
      created_at
    )
    VALUES (
      $1::uuid,
      $2,
      $3,
      $4,
      $5,
      NOW()
    )
    `,
    [
      batchId,
      tableNumber,
      restaurantId,
      orderType,
      pickupNumber,
    ]
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
        NOW()
      )
      RETURNING
        id,
        batch_id,
        table_number
      `,
      [
        restaurantId,
        tableNumber,
        `EDGE TRANSFER ${batchId}`,
        amount,
        batchId,
      ]
    );

  return {
    batchId,
    row,
  };
}


async function seedLegacyBillWithoutBatch({
  restaurantId,
  tableNumber,
  amount = 7,
}) {
  return one(
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
      created_at
    )
    VALUES (
      $1,
      $2,
      'EDGE LEGACY TRANSFER ROW',
      1,
      $3,
      'meal',
      'open',
      0,
      0,
      $3,
      'pos',
      NULL,
      NOW()
    )
    RETURNING
      id,
      table_number
    `,
    [
      restaurantId,
      tableNumber,
      amount,
    ]
  );
}


async function transfer({
  token = tokenA,
  oldTable,
  newTable,
  newOrderType = null,
}) {
  const body = {
    oldTable,
    newTable,
  };

  if (
    newOrderType
  ) {
    body.newOrderType =
      newOrderType;
  }

  return request(
    app
  )
    .put(
      "/orders/transfer-table"
    )
    .set(
      "Authorization",
      bearer(
        token
      )
    )
    .send(
      body
    );
}


async function tableState(
  restaurantId,
  tableName
) {
  const table =
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
        restaurantId,
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
        restaurantId,
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
            restaurantId,
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


async function batchState(
  restaurantId,
  batchId
) {
  const batch =
    await one(
      `
      SELECT
        id,
        table_number,
        order_type,
        pickup_number
      FROM
        public.order_batches
      WHERE
        restaurant_id = $1
        AND id = $2::uuid
      `,
      [
        restaurantId,
        batchId,
      ]
    );

  const rows =
    await all(
      `
      SELECT
        id,
        table_number,
        paid,
        remaining_price
      FROM
        public.pos_orders
      WHERE
        restaurant_id = $1
        AND batch_id = $2::uuid
      ORDER BY
        id ASC
      `,
      [
        restaurantId,
        batchId,
      ]
    );

  return {
    batch,
    rows,
  };
}


async function tableEvents(
  restaurantId,
  tableName
) {
  return all(
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
      restaurantId,
      TABLE_OPERATIONAL_EVENT_TYPE,
      normalizeTableName(
        tableName
      ),
    ]
  );
}


async function assignmentEvents(
  restaurantId,
  batchId
) {
  return all(
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
      restaurantId,
      TABLE_BATCH_ASSIGNMENT_EVENT_TYPE,
      String(
        batchId
      ).toLowerCase(),
    ]
  );
}


async function revisionRow(
  restaurantId,
  domain
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
      restaurantId,
      domain,
    ]
  );
}


async function removeFailureTrigger() {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_table_assignment_edge
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_table_assignment_edge()
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
      "REFUSED: table transfer Edge producer Attack may run only against maks_test"
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

    const loginB =
      await request(
        app
      )
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_test_owner_b",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures
              .restaurantB,
        });

    assert.equal(
      loginB.status,
      200,
      JSON.stringify(
        loginB.body
      )
    );

    tokenB =
      loginB.body
        ?.token;

    assert.ok(
      tokenA
    );

    assert.ok(
      tokenB
    );

    console.log(
      "✅ 01 Database + isolated owners ready"
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
  "MAKS table transfer Edge operational producer attack",
  async (t) => {
    await t.test(
      "physical-to-physical moves two batches, session and both table snapshots atomically",
      async () => {
        const source =
          "Table 961";

        const destination =
          "Table 962";

        const sourceTable =
          await ensurePhysicalTable(
            fixtures
              .restaurantA,
            source,
            "occupied"
          );

        await ensurePhysicalTable(
          fixtures
            .restaurantA,
          destination,
          "free"
        );

        await putSession(
          fixtures
            .restaurantA,
          Number(
            sourceTable.id
          ),
          {
            covers:
              5,

            allergens: [
              "milk",
              "sesame",
            ],

            strict:
              true,
          }
        );

        const first =
          await seedBatchBill({
            restaurantId:
              fixtures
                .restaurantA,

            tableNumber:
              source,

            amount:
              8.5,
          });

        const second =
          await seedBatchBill({
            restaurantId:
              fixtures
                .restaurantA,

            tableNumber:
              source,

            amount:
              6,
          });

        const response =
          await transfer({
            oldTable:
              source,

            newTable:
              destination,
          });

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        assert.equal(
          Number(
            response.body
              ?.moved
          ),
          2
        );

        for (
          const batchId of [
            first.batchId,
            second.batchId,
          ]
        ) {
          const state =
            await batchState(
              fixtures
                .restaurantA,
              batchId
            );

          assert.equal(
            state.batch
              .table_number,
            destination
          );

          assert.equal(
            state.batch
              .order_type,
            "dine-in"
          );

          assert.equal(
            state.batch
              .pickup_number,
            null
          );

          assert.equal(
            state.rows.length,
            1
          );

          assert.equal(
            state.rows[0]
              .table_number,
            destination
          );

          const events =
            await assignmentEvents(
              fixtures
                .restaurantA,
              batchId
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
              .assignment
              .table_number,
            destination
          );

          assert.equal(
            Object.prototype
              .hasOwnProperty
              .call(
                events[0]
                  .payload,
                "pos_order_id"
              ),
            false
          );
        }

        const sourceState =
          await tableState(
            fixtures
              .restaurantA,
            source
          );

        const destinationState =
          await tableState(
            fixtures
              .restaurantA,
            destination
          );

        assert.equal(
          sourceState
            .table
            .status,
          "free"
        );

        assert.equal(
          sourceState
            .map
            .status,
          "free"
        );

        assert.equal(
          sourceState
            .session,
          null
        );

        assert.equal(
          destinationState
            .table
            .status,
          "occupied"
        );

        assert.equal(
          destinationState
            .map
            .status,
          "occupied"
        );

        assert.equal(
          Number(
            destinationState
              .session
              ?.covers
          ),
          5
        );

        assert.deepEqual(
          destinationState
            .session
            ?.allergy_codes,
          [
            "milk",
            "sesame",
          ]
        );

        assert.equal(
          destinationState
            .session
            ?.strict_cross_contamination,
          true
        );

        const sourceEvents =
          await tableEvents(
            fixtures
              .restaurantA,
            source
          );

        const destinationEvents =
          await tableEvents(
            fixtures
              .restaurantA,
            destination
          );

        assert.equal(
          sourceEvents.length,
          1
        );

        assert.equal(
          destinationEvents.length,
          1
        );

        assert.equal(
          sourceEvents[0]
            .payload
            .table
            .status,
          "free"
        );

        assert.equal(
          sourceEvents[0]
            .payload
            .session,
          null
        );

        assert.equal(
          destinationEvents[0]
            .payload
            .table
            .status,
          "occupied"
        );

        assert.equal(
          Number(
            destinationEvents[0]
              .payload
              .session
              ?.covers
          ),
          5
        );

        console.log(
          "✅ 02 Physical transfer -> 2 batch assignments + 2 table snapshots + session migration"
        );
      }
    );


    await t.test(
      "physical-to-Takeaway clears source session and emits no virtual table event",
      async () => {
        const source =
          "Table 963";

        const sourceTable =
          await ensurePhysicalTable(
            fixtures
              .restaurantA,
            source,
            "occupied"
          );

        await putSession(
          fixtures
            .restaurantA,
          Number(
            sourceTable.id
          ),
          {
            covers:
              3,

            allergens: [
              "egg",
            ],
          }
        );

        const bill =
          await seedBatchBill({
            restaurantId:
              fixtures
                .restaurantA,

            tableNumber:
              source,

            amount:
              9,
          });

        const response =
          await transfer({
            oldTable:
              source,

            newTable:
              "Takeaway",
          });

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const state =
          await batchState(
            fixtures
              .restaurantA,
            bill.batchId
          );

        assert.equal(
          state.batch
            .table_number,
          "Takeaway"
        );

        assert.equal(
          state.batch
            .order_type,
          "takeaway"
        );

        assert.ok(
          Number(
            state.batch
              .pickup_number
          ) > 0
        );

        const sourceState =
          await tableState(
            fixtures
              .restaurantA,
            source
          );

        assert.equal(
          sourceState
            .table
            .status,
          "free"
        );

        assert.equal(
          sourceState
            .session,
          null
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              source
            )
          ).length,
          1
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              "Takeaway"
            )
          ).length,
          0
        );

        const assignment =
          await assignmentEvents(
            fixtures
              .restaurantA,
            bill.batchId
          );

        assert.equal(
          assignment.length,
          1
        );

        assert.equal(
          assignment[0]
            .payload
            .assignment
            .order_type,
          "takeaway"
        );

        assert.ok(
          Number(
            assignment[0]
              .payload
              .assignment
              .pickup_number
          ) > 0
        );

        console.log(
          "✅ 03 Physical -> Takeaway assignment + source cleanup proven"
        );
      }
    );


    await t.test(
      "Takeaway-to-physical emits destination table snapshot and dine-in assignment",
      async () => {
        const destination =
          "Table 964";

        await ensurePhysicalTable(
          fixtures
            .restaurantA,
          destination,
          "free"
        );

        const bill =
          await seedBatchBill({
            restaurantId:
              fixtures
                .restaurantA,

            tableNumber:
              "Takeaway",

            orderType:
              "takeaway",

            pickupNumber:
              88,

            amount:
              10,
          });

        const response =
          await transfer({
            oldTable:
              "Takeaway",

            newTable:
              destination,
          });

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const state =
          await batchState(
            fixtures
              .restaurantA,
            bill.batchId
          );

        assert.equal(
          state.batch
            .table_number,
          destination
        );

        assert.equal(
          state.batch
            .order_type,
          "dine-in"
        );

        assert.equal(
          state.batch
            .pickup_number,
          null
        );

        const destinationState =
          await tableState(
            fixtures
              .restaurantA,
            destination
          );

        assert.equal(
          destinationState
            .table
            .status,
          "occupied"
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              "Takeaway"
            )
          ).length,
          0
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              destination
            )
          ).length,
          1
        );

        assert.equal(
          (
            await assignmentEvents(
              fixtures
                .restaurantA,
              bill.batchId
            )
          ).length,
          1
        );

        console.log(
          "✅ 04 Takeaway -> physical emits no fake source table event"
        );
      }
    );


    await t.test(
      "forced assignment outbox failure rolls rows, batches, sessions, statuses and all revisions back",
      async () => {
        const source =
          "Table 965";

        const destination =
          "Table 966";

        const sourceTable =
          await ensurePhysicalTable(
            fixtures
              .restaurantA,
            source,
            "occupied"
          );

        await ensurePhysicalTable(
          fixtures
            .restaurantA,
          destination,
          "free"
        );

        await putSession(
          fixtures
            .restaurantA,
          Number(
            sourceTable.id
          ),
          {
            covers:
              6,

            allergens: [
              "peanuts",
            ],
          }
        );

        const bill =
          await seedBatchBill({
            restaurantId:
              fixtures
                .restaurantA,

            tableNumber:
              source,

            amount:
              13,
          });

        await removeFailureTrigger();

        await pool.query(`
          CREATE OR REPLACE FUNCTION
            public.maks_test_reject_table_assignment_edge()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.event_type =
              '${TABLE_BATCH_ASSIGNMENT_EVENT_TYPE}'
            THEN
              RAISE EXCEPTION
                'MAKS_TEST_FORCED_TABLE_ASSIGNMENT_OUTBOX_FAILURE';
            END IF;

            RETURN NEW;
          END;
          $$
        `);

        await pool.query(`
          CREATE TRIGGER
            trg_maks_test_reject_table_assignment_edge
          BEFORE INSERT
          ON public.edge_outbox
          FOR EACH ROW
          EXECUTE FUNCTION
            public.maks_test_reject_table_assignment_edge()
        `);

        const response =
          await transfer({
            oldTable:
              source,

            newTable:
              destination,
          });

        assert.equal(
          response.status,
          500
        );

        await removeFailureTrigger();

        const batch =
          await batchState(
            fixtures
              .restaurantA,
            bill.batchId
          );

        assert.equal(
          batch.batch
            .table_number,
          source
        );

        assert.equal(
          batch.rows[0]
            .table_number,
          source
        );

        const sourceState =
          await tableState(
            fixtures
              .restaurantA,
            source
          );

        const destinationState =
          await tableState(
            fixtures
              .restaurantA,
            destination
          );

        assert.equal(
          sourceState
            .table
            .status,
          "occupied"
        );

        assert.equal(
          Number(
            sourceState
              .session
              ?.covers
          ),
          6
        );

        assert.equal(
          destinationState
            .table
            .status,
          "free"
        );

        assert.equal(
          destinationState
            .session,
          null
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              source
            )
          ).length,
          0
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              destination
            )
          ).length,
          0
        );

        assert.equal(
          (
            await assignmentEvents(
              fixtures
                .restaurantA,
              bill.batchId
            )
          ).length,
          0
        );

        assert.equal(
          await revisionRow(
            fixtures
              .restaurantA,
            tableOperationalDomain(
              source
            )
          ),
          null
        );

        assert.equal(
          await revisionRow(
            fixtures
              .restaurantA,
            tableOperationalDomain(
              destination
            )
          ),
          null
        );

        assert.equal(
          await revisionRow(
            fixtures
              .restaurantA,
            tableBatchAssignmentDomain(
              bill.batchId
            )
          ),
          null
        );

        console.log(
          "✅ 05 Assignment failure rolls complete transfer transaction back"
        );
      }
    );


    await t.test(
      "Edge refuses a legacy transfer row that has no stable batch UUID",
      async () => {
        const source =
          "Table 967";

        const destination =
          "Table 968";

        await ensurePhysicalTable(
          fixtures
            .restaurantA,
          source,
          "occupied"
        );

        await ensurePhysicalTable(
          fixtures
            .restaurantA,
          destination,
          "free"
        );

        const row =
          await seedLegacyBillWithoutBatch({
            restaurantId:
              fixtures
                .restaurantA,

            tableNumber:
              source,
          });

        const response =
          await transfer({
            oldTable:
              source,

            newTable:
              destination,
          });

        assert.equal(
          response.status,
          409,
          JSON.stringify(
            response.body
          )
        );

        assert.equal(
          response.body
            ?.code,
          "EDGE_TABLE_TRANSFER_BATCH_ID_REQUIRED"
        );

        const after =
          await one(
            `
            SELECT
              table_number
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
          after
            .table_number,
          source
        );

        console.log(
          "✅ 06 Edge fail-closed stable batch identity gate proven"
        );
      }
    );


    await t.test(
      "Cloud runtime preserves transfer behavior without Edge feedback events",
      async () => {
        const source =
          "Table 969";

        const destination =
          "Table 970";

        const sourceTable =
          await ensurePhysicalTable(
            fixtures
              .restaurantA,
            source,
            "occupied"
          );

        await ensurePhysicalTable(
          fixtures
            .restaurantA,
          destination,
          "free"
        );

        await putSession(
          fixtures
            .restaurantA,
          Number(
            sourceTable.id
          ),
          {
            covers:
              2,
          }
        );

        const bill =
          await seedBatchBill({
            restaurantId:
              fixtures
                .restaurantA,

            tableNumber:
              source,

            amount:
              5,
          });

        process.env
          .MAKS_RUNTIME_ROLE =
          "cloud";

        const response =
          await transfer({
            oldTable:
              source,

            newTable:
              destination,
          });

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const batch =
          await batchState(
            fixtures
              .restaurantA,
            bill.batchId
          );

        assert.equal(
          batch.batch
            .table_number,
          destination
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              source
            )
          ).length,
          0
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              destination
            )
          ).length,
          0
        );

        assert.equal(
          (
            await assignmentEvents(
              fixtures
                .restaurantA,
              bill.batchId
            )
          ).length,
          0
        );

        process.env
          .MAKS_RUNTIME_ROLE =
          "edge";

        console.log(
          "✅ 07 Cloud transfer keeps local behavior without Edge feedback"
        );
      }
    );


    await t.test(
      "foreign tenant cannot transfer or manufacture table/batch events",
      async () => {
        const source =
          "Table 971";

        const destination =
          "Table 972";

        await ensurePhysicalTable(
          fixtures
            .restaurantA,
          source,
          "occupied"
        );

        await ensurePhysicalTable(
          fixtures
            .restaurantA,
          destination,
          "free"
        );

        const bill =
          await seedBatchBill({
            restaurantId:
              fixtures
                .restaurantA,

            tableNumber:
              source,

            amount:
              4.5,
          });

        const response =
          await transfer({
            token:
              tokenB,

            oldTable:
              source,

            newTable:
              destination,
          });

        assert.equal(
          response.status,
          404,
          JSON.stringify(
            response.body
          )
        );

        const batch =
          await batchState(
            fixtures
              .restaurantA,
            bill.batchId
          );

        assert.equal(
          batch.batch
            .table_number,
          source
        );

        assert.equal(
          (
            await tableEvents(
              fixtures
                .restaurantA,
              source
            )
          ).length,
          0
        );

        assert.equal(
          (
            await assignmentEvents(
              fixtures
                .restaurantA,
              bill.batchId
            )
          ).length,
          0
        );

        console.log(
          "✅ 08 Cross-tenant transfer event manufacture blocked"
        );
      }
    );


    console.log(
      "========================================================="
    );

    console.log(
      "✅ MAKS TABLE TRANSFER EDGE PRODUCER ATTACK COMPLETE"
    );

    console.log(
      "========================================================="
    );
  }
);
