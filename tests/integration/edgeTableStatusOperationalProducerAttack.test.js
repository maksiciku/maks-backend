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

const {
  TABLE_OPERATIONAL_EVENT_TYPE,
  tableOperationalDomain,
  normalizeTableName,
} = require("../../edge/contracts/tableOperations");

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;

process.env.MAKS_RUNTIME_ROLE = "edge";

let app;
let pool;
let fixtures;
let tokenA;
let tableA;
let tableB;

function bearer(token) {
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

  return result.rows[0] || null;
}

async function tableEvents(
  restaurantId,
  normalizedName
) {
  const result =
    await pool.query(
      `
      SELECT
        event_id,
        entity_id,
        payload,
        status
      FROM public.edge_outbox
      WHERE
        restaurant_id = $1
        AND event_type = $2
        AND entity_id = $3
      ORDER BY id ASC
      `,
      [
        restaurantId,
        TABLE_OPERATIONAL_EVENT_TYPE,
        normalizedName,
      ]
    );

  return result.rows;
}

async function tableRevision(
  restaurantId,
  tableName
) {
  return one(
    `
    SELECT
      produced_revision
    FROM public.edge_domain_revisions
    WHERE
      restaurant_id = $1
      AND domain = $2
    `,
    [
      restaurantId,
      tableOperationalDomain(
        tableName
      ),
    ]
  );
}

async function tableState(
  restaurantId,
  tableId,
  tableName
) {
  const table =
    await one(
      `
      SELECT
        id,
        name,
        status
      FROM public.tables
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        tableId,
      ]
    );

  const map =
    await one(
      `
      SELECT
        id,
        name,
        status
      FROM public.table_map
      WHERE
        restaurant_id = $1
        AND LOWER(TRIM(name)) =
            LOWER(TRIM($2))
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

async function removeFailureTrigger() {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_table_status_edge
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_table_status_edge()
  `);
}

async function changeStatus({
  token,
  tableId,
  status,
}) {
  return request(app)
    .put(
      `/tables/${tableId}/status`
    )
    .set(
      "Authorization",
      bearer(token)
    )
    .send({
      status,
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
      "REFUSED: table status Edge producer Attack may run only against maks_test"
    );

    pool =
      safe.pool;

    await removeFailureTrigger();

    ({
      app,
    } = require("../../server"));

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

    assert.ok(
      tokenA
    );

    tableA =
      await one(
        `
        SELECT
          id,
          name,
          status
        FROM public.tables
        WHERE
          restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          fixtures.tableA,
        ]
      );

    tableB =
      await one(
        `
        SELECT
          id,
          name,
          status
        FROM public.tables
        WHERE
          restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantB,
          fixtures.tableB,
        ]
      );

    assert.ok(
      tableA?.id
    );

    assert.ok(
      tableB?.id
    );

    /*
     * Give the canonical table a mirrored map row.
     * The status producer must keep them atomic.
     */
    /*
     * seedTestData may already create the canonical table_map row.
     * Reuse it when present instead of manufacturing a duplicate
     * against ux_table_map_rid_name.
     */
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
        'free',
        0,
        0,
        'Main',
        'rect'
      )
      ON CONFLICT DO NOTHING
      `,
      [
        fixtures.restaurantA,
        tableA.name,
      ]
    );

    await pool.query(
      `
      UPDATE public.table_map
      SET status = 'free'
      WHERE
        restaurant_id = $1
        AND LOWER(TRIM(name)) =
            LOWER(TRIM($2))
      `,
      [
        fixtures.restaurantA,
        tableA.name,
      ]
    );

    /*
     * Seed session metadata directly so the first
     * status mutation itself owns table revision 1.
     */
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
        4,
        '["milk"]'::jsonb,
        true
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
        fixtures.restaurantA,
        Number(tableA.id),
      ]
    );

    console.log(
      "✅ 01 Database + owner + mirrored table/session fixtures ready"
    );
  }
);

test.after(
  async () => {
    process.env.MAKS_RUNTIME_ROLE =
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
      process.env.MAKS_RUNTIME_ROLE =
        originalRuntimeRole;
    }
  }
);

test(
  "MAKS table status Edge operational producer attack",
  async (t) => {
    const normalized =
      normalizeTableName(
        tableA.name
      );

    await t.test(
      "status update changes tables + table_map and emits revision 1 atomically",
      async () => {
        const response =
          await changeStatus({
            token:
              tokenA,
            tableId:
              Number(tableA.id),
            status:
              "occupied",
          });

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        assert.equal(
          response.body?.status,
          "occupied"
        );

        assert.equal(
          Number(
            response.body
              ?.edge_revision
          ),
          1
        );

        const state =
          await tableState(
            fixtures.restaurantA,
            Number(tableA.id),
            tableA.name
          );

        assert.equal(
          state.table.status,
          "occupied"
        );

        assert.equal(
          state.map.status,
          "occupied"
        );

        const events =
          await tableEvents(
            fixtures.restaurantA,
            normalized
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

        assert.equal(
          events[0]
            .payload
            .session
            .covers,
          4
        );

        assert.deepEqual(
          events[0]
            .payload
            .session
            .allergy_codes,
          [
            "milk",
          ]
        );

        assert.equal(
          Object.prototype
            .hasOwnProperty
            .call(
              events[0].payload,
              "table_id"
            ),
          false
        );

        console.log(
          "✅ 02 Occupied status + map + revision 1 snapshot proven"
        );
      }
    );

    await t.test(
      "second status advances only the same table revision",
      async () => {
        const response =
          await changeStatus({
            token:
              tokenA,
            tableId:
              Number(tableA.id),
            status:
              "reserved",
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
              ?.edge_revision
          ),
          2
        );

        const state =
          await tableState(
            fixtures.restaurantA,
            Number(tableA.id),
            tableA.name
          );

        assert.equal(
          state.table.status,
          "reserved"
        );

        assert.equal(
          state.map.status,
          "reserved"
        );

        const revision =
          await tableRevision(
            fixtures.restaurantA,
            tableA.name
          );

        assert.equal(
          Number(
            revision
              .produced_revision
          ),
          2
        );

        console.log(
          "✅ 03 Per-table status revision 2 proven"
        );
      }
    );

    await t.test(
      "forced outbox failure rolls table + map + revision back together",
      async () => {
        await removeFailureTrigger();

        await pool.query(`
          CREATE OR REPLACE FUNCTION
            public.maks_test_reject_table_status_edge()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.event_type =
              '${TABLE_OPERATIONAL_EVENT_TYPE}'
            THEN
              RAISE EXCEPTION
                'MAKS_TEST_FORCED_TABLE_STATUS_OUTBOX_FAILURE';
            END IF;

            RETURN NEW;
          END;
          $$
        `);

        await pool.query(`
          CREATE TRIGGER
            trg_maks_test_reject_table_status_edge
          BEFORE INSERT
          ON public.edge_outbox
          FOR EACH ROW
          EXECUTE FUNCTION
            public.maks_test_reject_table_status_edge()
        `);

        const response =
          await changeStatus({
            token:
              tokenA,
            tableId:
              Number(tableA.id),
            status:
              "occupied_paid",
          });

        assert.equal(
          response.status,
          500
        );

        await removeFailureTrigger();

        const state =
          await tableState(
            fixtures.restaurantA,
            Number(tableA.id),
            tableA.name
          );

        assert.equal(
          state.table.status,
          "reserved"
        );

        assert.equal(
          state.map.status,
          "reserved"
        );

        const revision =
          await tableRevision(
            fixtures.restaurantA,
            tableA.name
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
            fixtures.restaurantA,
            normalized
          );

        assert.equal(
          events.length,
          2
        );

        console.log(
          "✅ 04 Status + map + revision + outbox rollback proven"
        );
      }
    );

    await t.test(
      "Cloud runtime keeps status behavior without Edge feedback",
      async () => {
        process.env.MAKS_RUNTIME_ROLE =
          "cloud";

        const beforeEvents =
          await tableEvents(
            fixtures.restaurantA,
            normalized
          );

        const response =
          await changeStatus({
            token:
              tokenA,
            tableId:
              Number(tableA.id),
            status:
              "free",
          });

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        assert.equal(
          response.body
            ?.edge_revision,
          null
        );

        const state =
          await tableState(
            fixtures.restaurantA,
            Number(tableA.id),
            tableA.name
          );

        assert.equal(
          state.table.status,
          "free"
        );

        assert.equal(
          state.map.status,
          "free"
        );

        const afterEvents =
          await tableEvents(
            fixtures.restaurantA,
            normalized
          );

        assert.equal(
          afterEvents.length,
          beforeEvents.length
        );

        const revision =
          await tableRevision(
            fixtures.restaurantA,
            tableA.name
          );

        assert.equal(
          Number(
            revision
              .produced_revision
          ),
          2
        );

        process.env.MAKS_RUNTIME_ROLE =
          "edge";

        console.log(
          "✅ 05 Cloud feedback-loop suppression proven"
        );
      }
    );

    await t.test(
      "foreign tenant table cannot manufacture status event",
      async () => {
        process.env.MAKS_RUNTIME_ROLE =
          "edge";

        const before =
          await one(
            `
            SELECT status
            FROM public.tables
            WHERE
              restaurant_id = $1
              AND id = $2
            `,
            [
              fixtures.restaurantB,
              Number(tableB.id),
            ]
          );

        const response =
          await changeStatus({
            token:
              tokenA,
            tableId:
              Number(tableB.id),
            status:
              "occupied",
          });

        assert.equal(
          response.status,
          404,
          JSON.stringify(
            response.body
          )
        );

        const after =
          await one(
            `
            SELECT status
            FROM public.tables
            WHERE
              restaurant_id = $1
              AND id = $2
            `,
            [
              fixtures.restaurantB,
              Number(tableB.id),
            ]
          );

        assert.equal(
          after.status,
          before.status
        );

        const foreignEvents =
          await tableEvents(
            fixtures.restaurantB,
            normalizeTableName(
              tableB.name
            )
          );

        assert.equal(
          foreignEvents.length,
          0
        );

        console.log(
          "✅ 06 Cross-tenant status event manufacture blocked"
        );
      }
    );

    console.log(
      "===================================================="
    );

    console.log(
      "✅ MAKS TABLE STATUS EDGE PRODUCER ATTACK COMPLETE"
    );

    console.log(
      "===================================================="
    );
  }
);
