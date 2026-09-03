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
let tableA;
let tableB;


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
    FROM
      public.edge_domain_revisions
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


async function sessionRow(
  restaurantId,
  tableId
) {
  return one(
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
    `,
    [
      restaurantId,
      tableId,
    ]
  );
}


async function removeFailureTrigger() {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_table_edge
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_table_edge()
  `);
}


async function saveSession({
  token,
  tableId,
  covers,
  allergyCodes,
  strict,
}) {
  return request(
    app
  )
    .post(
      `/pos/table-session/${tableId}`
    )
    .set(
      "Authorization",
      bearer(
        token
      )
    )
    .send({
      covers,

      allergy_codes:
        allergyCodes,

      strict_cross_contamination:
        strict,
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
      "REFUSED: table Edge producer Attack may run only against maks_test"
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

    tableA =
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
          AND id = $2
        `,
        [
          fixtures
            .restaurantA,
          fixtures
            .tableA,
        ]
      );

    tableB =
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
          AND id = $2
        `,
        [
          fixtures
            .restaurantB,
          fixtures
            .tableB,
        ]
      );

    assert.ok(
      tableA?.id
    );

    assert.ok(
      tableB?.id
    );

    console.log(
      "✅ 01 Database + real owner + table fixtures ready"
    );
  }
);


test.after(
  async () => {
    process.env
      .MAKS_RUNTIME_ROLE =
      "edge";

    if (
      pool
    ) {
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
  "MAKS table session Edge operational producer attack",
  async (t) => {
    const normalized =
      normalizeTableName(
        tableA.name
      );

    await t.test(
      "session save writes business state + revision + durable snapshot together",
      async () => {
        const response =
          await saveSession({
            token:
              tokenA,

            tableId:
              Number(
                tableA.id
              ),

            covers:
              3,

            allergyCodes: [
              "milk",
              "soy",
              "milk",
            ],

            strict:
              true,
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
          1
        );

        const session =
          await sessionRow(
            fixtures
              .restaurantA,
            Number(
              tableA.id
            )
          );

        assert.equal(
          Number(
            session.covers
          ),
          3
        );

        const events =
          await tableEvents(
            fixtures
              .restaurantA,
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
            .normalized_name,
          normalized
        );

        assert.equal(
          events[0]
            .payload
            .session
            .covers,
          3
        );

        assert.deepEqual(
          events[0]
            .payload
            .session
            .allergy_codes,
          [
            "milk",
            "soy",
          ]
        );

        assert.equal(
          Object.prototype
            .hasOwnProperty
            .call(
              events[0]
                .payload,
              "table_id"
            ),
          false,
          "Local bigint table_id leaked into the cross-database payload"
        );

        const revision =
          await tableRevision(
            fixtures
              .restaurantA,
            tableA.name
          );

        assert.equal(
          Number(
            revision
              .produced_revision
          ),
          1
        );

        console.log(
          "✅ 02 Table session revision 1 snapshot proven without bigint wire identity"
        );
      }
    );


    await t.test(
      "replay-style session update advances only the same table domain",
      async () => {
        const response =
          await saveSession({
            token:
              tokenA,

            tableId:
              Number(
                tableA.id
              ),

            covers:
              5,

            allergyCodes: [
              "egg",
            ],

            strict:
              false,
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

        const events =
          await tableEvents(
            fixtures
              .restaurantA,
            normalized
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
            .session
            .covers,
          5
        );

        console.log(
          "✅ 03 Per-table monotonic revision proven"
        );
      }
    );


    await t.test(
      "forced outbox failure rolls session + revision + event back together",
      async () => {
        await removeFailureTrigger();

        await pool.query(`
          CREATE OR REPLACE FUNCTION
            public.maks_test_reject_table_edge()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.event_type =
              '${TABLE_OPERATIONAL_EVENT_TYPE}'
            THEN
              RAISE EXCEPTION
                'MAKS_TEST_FORCED_TABLE_OUTBOX_FAILURE';
            END IF;

            RETURN NEW;
          END;
          $$
        `);

        await pool.query(`
          CREATE TRIGGER
            trg_maks_test_reject_table_edge
          BEFORE INSERT
          ON public.edge_outbox
          FOR EACH ROW
          EXECUTE FUNCTION
            public.maks_test_reject_table_edge()
        `);

        const failed =
          await saveSession({
            token:
              tokenA,

            tableId:
              Number(
                tableA.id
              ),

            covers:
              9,

            allergyCodes: [
              "fish",
            ],

            strict:
              true,
          });

        assert.equal(
          failed.status,
          500,
          JSON.stringify(
            failed.body
          )
        );

        await removeFailureTrigger();

        const session =
          await sessionRow(
            fixtures
              .restaurantA,
            Number(
              tableA.id
            )
          );

        assert.equal(
          Number(
            session.covers
          ),
          5,
          "Session mutation survived forced outbox failure"
        );

        const revision =
          await tableRevision(
            fixtures
              .restaurantA,
            tableA.name
          );

        assert.equal(
          Number(
            revision
              .produced_revision
          ),
          2,
          "Table revision was consumed by rolled-back operation"
        );

        const events =
          await tableEvents(
            fixtures
              .restaurantA,
            normalized
          );

        assert.equal(
          events.length,
          2,
          "Outbox event survived forced rollback"
        );

        console.log(
          "✅ 04 Table session + revision + outbox rollback proven"
        );
      }
    );


    await t.test(
      "Cloud runtime updates local session without Edge feedback event",
      async () => {
        process.env
          .MAKS_RUNTIME_ROLE =
          "cloud";

        try {
          const response =
            await saveSession({
              token:
                tokenA,

              tableId:
                Number(
                  tableA.id
                ),

              covers:
                6,

              allergyCodes: [
                "sesame",
              ],

              strict:
                false,
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
        } finally {
          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";
        }

        const events =
          await tableEvents(
            fixtures
              .restaurantA,
            normalized
          );

        assert.equal(
          events.length,
          2
        );

        const session =
          await sessionRow(
            fixtures
              .restaurantA,
            Number(
              tableA.id
            )
          );

        assert.equal(
          Number(
            session.covers
          ),
          6
        );

        console.log(
          "✅ 05 Cloud feedback-loop suppression proven"
        );
      }
    );


    await t.test(
      "foreign tenant table cannot manufacture an Edge table event",
      async () => {
        const before =
          await one(
            `
            SELECT
              COUNT(*)::int AS c
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type = $2
            `,
            [
              fixtures
                .restaurantA,
              TABLE_OPERATIONAL_EVENT_TYPE,
            ]
          );

        const response =
          await saveSession({
            token:
              tokenA,

            tableId:
              Number(
                tableB.id
              ),

            covers:
              4,

            allergyCodes:
              [],

            strict:
              false,
          });

        assert.equal(
          response.status,
          404
        );

        const after =
          await one(
            `
            SELECT
              COUNT(*)::int AS c
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type = $2
            `,
            [
              fixtures
                .restaurantA,
              TABLE_OPERATIONAL_EVENT_TYPE,
            ]
          );

        assert.equal(
          Number(
            after.c
          ),
          Number(
            before.c
          )
        );

        console.log(
          "✅ 06 Cross-tenant table event manufacture blocked"
        );
      }
    );

    console.log(
      "===================================================="
    );
    console.log(
      "✅ MAKS TABLE SESSION EDGE PRODUCER ATTACK COMPLETE"
    );
    console.log(
      "===================================================="
    );
  }
);
