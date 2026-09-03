"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

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

const TABLE_NAME =
  "Table 941";


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


async function tableEvents(
  restaurantId
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
        restaurantId,
        TABLE_OPERATIONAL_EVENT_TYPE,
        normalizeTableName(
          TABLE_NAME
        ),
      ]
    );

  return result.rows;
}


async function tableRevision(
  restaurantId
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
      tableOperationalDomain(
        TABLE_NAME
      ),
    ]
  );
}


async function loadTenantState(
  restaurantId
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
        TABLE_NAME,
      ]
    );

  const map =
    await one(
      `
      SELECT
        id,
        name,
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
        TABLE_NAME,
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


async function seedOpenTable(
  restaurantId,
  {
    covers = 4,
    allergens = [
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
        name
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
        TABLE_NAME,
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
          name
        `,
        [
          TABLE_NAME,
          restaurantId,
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
        restaurantId,
      ]
    );
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
      restaurantId,
      TABLE_NAME,
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
      restaurantId,
      TABLE_NAME,
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
      restaurantId,
      Number(
        table.id
      ),
      covers,
      JSON.stringify(
        allergens
      ),
      strict,
    ]
  );

  return table;
}


async function removeFailureTrigger() {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_table_close_edge
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_table_close_edge()
  `);
}


async function closeTable(
  token
) {
  return request(
    app
  )
    .post(
      "/orders/close"
    )
    .set(
      "Authorization",
      bearer(
        token
      )
    )
    .send({
      table_number:
        TABLE_NAME,
    });
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
      "REFUSED: table close Edge producer Attack may run only against maks_test"
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

    await seedOpenTable(
      fixtures
        .restaurantA
    );

    /*
     * Same physical display name in Restaurant B proves
     * every mutation/event remains tenant-scoped.
     */
    await seedOpenTable(
      fixtures
        .restaurantB,
      {
        covers:
          7,

        allergens:
          [
            "peanuts",
          ],

        strict:
          false,
      }
    );

    console.log(
      "✅ 01 Database + owner + same-name cross-tenant table fixtures ready"
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
  "MAKS POS table close Edge operational producer attack",
  async (t) => {
    await t.test(
      "close frees canonical table, clears session and emits revision 1 in the same transaction",
      async () => {
        const response =
          await closeTable(
            tokenA
          );

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const stateA =
          await loadTenantState(
            fixtures
              .restaurantA
          );

        assert.equal(
          stateA.table
            .status,
          "free"
        );

        assert.equal(
          stateA.map
            .status,
          "free"
        );

        assert.equal(
          stateA.session,
          null
        );

        const events =
          await tableEvents(
            fixtures
              .restaurantA
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

        const stateB =
          await loadTenantState(
            fixtures
              .restaurantB
          );

        assert.equal(
          stateB.table
            .status,
          "occupied"
        );

        assert.equal(
          stateB.map
            .status,
          "occupied"
        );

        assert.equal(
          Number(
            stateB.session
              ?.covers
          ),
          7
        );

        const foreignEvents =
          await tableEvents(
            fixtures
              .restaurantB
          );

        assert.equal(
          foreignEvents.length,
          0
        );

        console.log(
          "✅ 02 Close -> free + session null + revision 1 + tenant isolation proven"
        );
      }
    );


    await t.test(
      "forced outbox failure rolls free/session deletion/revision/event back together",
      async () => {
        await seedOpenTable(
          fixtures
            .restaurantA,
          {
            covers:
              5,

            allergens:
              [
                "egg",
              ],

            strict:
              true,
          }
        );

        await removeFailureTrigger();

        await pool.query(`
          CREATE OR REPLACE FUNCTION
            public.maks_test_reject_table_close_edge()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.event_type =
              '${TABLE_OPERATIONAL_EVENT_TYPE}'
            THEN
              RAISE EXCEPTION
                'MAKS_TEST_FORCED_TABLE_CLOSE_OUTBOX_FAILURE';
            END IF;

            RETURN NEW;
          END;
          $$
        `);

        await pool.query(`
          CREATE TRIGGER
            trg_maks_test_reject_table_close_edge
          BEFORE INSERT
          ON public.edge_outbox
          FOR EACH ROW
          EXECUTE FUNCTION
            public.maks_test_reject_table_close_edge()
        `);

        const response =
          await closeTable(
            tokenA
          );

        assert.equal(
          response.status,
          500
        );

        await removeFailureTrigger();

        const state =
          await loadTenantState(
            fixtures
              .restaurantA
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
          5
        );

        const revision =
          await tableRevision(
            fixtures
              .restaurantA
          );

        assert.equal(
          Number(
            revision
              .produced_revision
          ),
          1
        );

        const events =
          await tableEvents(
            fixtures
              .restaurantA
          );

        assert.equal(
          events.length,
          1
        );

        console.log(
          "✅ 03 Close status + session + revision + outbox rollback proven"
        );
      }
    );


    await t.test(
      "retry after rollback succeeds at revision 2",
      async () => {
        const response =
          await closeTable(
            tokenA
          );

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const state =
          await loadTenantState(
            fixtures
              .restaurantA
          );

        assert.equal(
          state.table
            .status,
          "free"
        );

        assert.equal(
          state.session,
          null
        );

        const revision =
          await tableRevision(
            fixtures
              .restaurantA
          );

        assert.equal(
          Number(
            revision
              .produced_revision
          ),
          2
        );

        const events =
          await tableEvents(
            fixtures
              .restaurantA
          );

        assert.equal(
          events.length,
          2
        );

        console.log(
          "✅ 04 Close retry advances exactly to revision 2"
        );
      }
    );


    await t.test(
      "Cloud runtime preserves close behavior without Edge feedback",
      async () => {
        await seedOpenTable(
          fixtures
            .restaurantA,
          {
            covers:
              3,

            allergens:
              [
                "sesame",
              ],

            strict:
              false,
          }
        );

        process.env
          .MAKS_RUNTIME_ROLE =
          "cloud";

        const beforeEvents =
          await tableEvents(
            fixtures
              .restaurantA
          );

        const response =
          await closeTable(
            tokenA
          );

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        const state =
          await loadTenantState(
            fixtures
              .restaurantA
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

        const afterEvents =
          await tableEvents(
            fixtures
              .restaurantA
          );

        assert.equal(
          afterEvents.length,
          beforeEvents.length
        );

        const revision =
          await tableRevision(
            fixtures
              .restaurantA
          );

        assert.equal(
          Number(
            revision
              .produced_revision
          ),
          2
        );

        process.env
          .MAKS_RUNTIME_ROLE =
          "edge";

        console.log(
          "✅ 05 Cloud feedback-loop suppression proven"
        );
      }
    );


    console.log(
      "===================================================="
    );

    console.log(
      "✅ MAKS POS TABLE CLOSE EDGE PRODUCER ATTACK COMPLETE"
    );

    console.log(
      "===================================================="
    );
  }
);
