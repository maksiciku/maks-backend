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

let app;
let pool;
let fixtures;
let tokenA;

/* =========================================================
   HELPERS
========================================================= */

function bearer(token) {
  return `Bearer ${token}`;
}

async function query(
  sql,
  params = []
) {
  assert.ok(
    pool,
    "Test database pool is not initialised"
  );

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

function sortedNumeric(
  values
) {
  return [
    ...(values || []),
  ]
    .map(
      (value) =>
        Number(value)
    )
    .sort(
      (a, b) =>
        a - b
    );
}

function orderPayload({
  mealId,

  quantity = 1,

  appendBatchId = null,
}) {
  return {
    order_type:
      "takeaway",

    table_number:
      "Takeaway",

    source:
      "pos",

    ...(appendBatchId
      ? {
          append_to_batch_id:
            appendBatchId,
        }
      : {}),

    items: [
      {
        meal_id:
          mealId,

        item_source:
          "meals",

        source:
          "meals",

        item_type:
          "meals",

        category:
          "meals",

        /*
         * Deliberately fake browser values.
         * Existing authoritative pricing must
         * continue replacing these.
         */
        meal_name:
          "EDGE ATTACK FAKE BURGER",

        name:
          "EDGE ATTACK FAKE BURGER",

        quantity,

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

async function restaurantCounts(
  restaurantId
) {
  return one(
    `
    SELECT

      (
        SELECT COUNT(*)::int
        FROM public.order_batches
        WHERE restaurant_id = $1
      ) AS batches,

      (
        SELECT COUNT(*)::int
        FROM public.orders
        WHERE restaurant_id = $1
      ) AS kds_orders,

      (
        SELECT COUNT(*)::int
        FROM public.pos_orders
        WHERE restaurant_id = $1
      ) AS pos_orders,

      (
        SELECT COUNT(*)::int
        FROM public.item_availability_reservations
        WHERE restaurant_id = $1
      ) AS availability_reservations,

      (
        SELECT COUNT(*)::int
        FROM public.edge_outbox
        WHERE restaurant_id = $1
      ) AS edge_outbox

    `,
    [
      restaurantId,
    ]
  );
}

async function removeFailureTrigger() {
  await query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_pos_edge
    ON public.edge_outbox
  `);

  await query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_pos_edge()
  `);
}

/* =========================================================
   SETUP
========================================================= */

test.before(
  async () => {
    /*
     * Existing MAKS destructive-test bootstrap.
     * resetTestData itself uses the test safety wall.
     */
    await resetTestData();

    fixtures =
      await seedTestData();

    const safe =
      await assertTestDatabase();

    assert.equal(
      safe.database,
      "maks_test",
      "REFUSED: Edge POS Attack may run only against maks_test"
    );

    pool =
      safe.pool;

    console.log(
      "✅ 01 Database guard: maks_test"
    );

    /*
     * Keep stock outside this focused test.
     * We are testing:
     *
     * POS transaction
     * KDS persistence
     * Edge outbox atomicity
     */
    await query(
      `
      UPDATE public.restaurants
      SET
        selling_mode =
          'pos_only',

        stock_deduction_enabled =
          FALSE

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

    /*
     * Edge schema must already exist.
     */
    const edgeSchema =
      await one(`
        SELECT
          to_regclass(
            'public.edge_outbox'
          ) AS edge_outbox
      `);

    assert.equal(
      edgeSchema?.edge_outbox,
      "edge_outbox",
      "edge_outbox migration is missing"
    );

    /*
     * Remove any stale forced-failure object
     * from an interrupted prior Attack.
     */
    await removeFailureTrigger();

    /*
     * Import server only AFTER maks_test is
     * positively established.
     */
    ({
      app,
    } =
      require(
        "../../server"
      ));

    assert.ok(
      app,
      "Express app was not exported"
    );

    const login =
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
      login.status,
      200,
      JSON.stringify(
        login.body
      )
    );

    tokenA =
      login.body?.token;

    assert.ok(
      tokenA,
      "Owner A login returned no JWT"
    );

    console.log(
      "✅ 02 Real POS owner authenticated"
    );
  }
);

test.after(
  async () => {
    if (pool) {
      try {
        await removeFailureTrigger();
      } catch {}

      try {
        await pool.end();
      } catch {}
    }
  }
);

/* =========================================================
   REAL POS → EDGE ATTACK
========================================================= */

test(
  "MAKS POS → Edge transactional integration attack",
  {
    timeout: 60000,
  },
  async (t) => {
    let firstBatchId = null;

    let firstPosIds = [];

    /* -----------------------------------------------------
       REAL GROUPED ORDER
    ----------------------------------------------------- */

    await t.test(
      "real grouped POS order commits KDS + POS + Edge together",
      async () => {
        const response =
          await request(app)
            .post(
              "/orders/grouped"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send(
              orderPayload({
                mealId:
                  fixtures.mealA,

                /*
                 * Important:
                 * insertPosBillRow creates one
                 * POS row per quantity unit.
                 */
                quantity: 2,
              })
            );

        assert.equal(
          response.status,
          201,
          `Grouped order failed: ${response.status} ${JSON.stringify(
            response.body
          )}`
        );

        firstBatchId =
          String(
            response.body
              ?.batch_id ||
              ""
          );

        assert.match(
          firstBatchId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        console.log(
          "✅ 03 Real /orders/grouped returned 201"
        );

        /*
         * Batch must exist under Restaurant A.
         */
        const batch =
          await one(
            `
            SELECT
              id,
              restaurant_id,
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
              fixtures.restaurantA,
              firstBatchId,
            ]
          );

        assert.ok(
          batch,
          "Authoritative order_batch was not created"
        );

        assert.equal(
          Number(
            batch.restaurant_id
          ),
          Number(
            fixtures.restaurantA
          )
        );

        assert.equal(
          String(
            batch.order_type
          ),
          "takeaway"
        );

        /*
         * Quantity 2 must create two exact
         * public.pos_orders rows.
         */
        const posRows =
          await all(
            `
            SELECT
              id,
              restaurant_id,
              batch_id,
              meal_id,
              item_name,
              quantity,
              total_price,
              remaining_price,
              source
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND batch_id =
                $2::uuid
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              firstBatchId,
            ]
          );

        assert.equal(
          posRows.length,
          2,
          "Quantity 2 did not create exactly two POS bill rows"
        );

        firstPosIds =
          posRows.map(
            (row) =>
              Number(
                row.id
              )
          );

        assert.equal(
          new Set(
            firstPosIds
          ).size,
          2,
          "POS bill row IDs were not unique"
        );

        for (
          const row of posRows
        ) {
          assert.equal(
            Number(
              row.restaurant_id
            ),
            Number(
              fixtures.restaurantA
            )
          );

          assert.equal(
            String(
              row.batch_id
            ),
            firstBatchId
          );

          assert.equal(
            Number(
              row.meal_id
            ),
            Number(
              fixtures.mealA
            )
          );

          /*
           * Browser submitted £0.01.
           * Backend remains authoritative.
           */
          assert.equal(
            Number(
              row.total_price
            ),
            12.5
          );

          assert.equal(
            row.source,
            "pos"
          );
        }

        console.log(
          "✅ 04 Exact authoritative POS row IDs captured"
        );

        /*
         * insertPosItems() is the KDS/order-side
         * persistence path.
         */
        const kdsRows =
          await all(
            `
            SELECT
              id,
              restaurant_id,
              batch_id,
              meal_name,
              quantity,
              total_price
            FROM
              public.orders
            WHERE
              restaurant_id = $1
              AND batch_id =
                $2::uuid
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              firstBatchId,
            ]
          );

        assert.ok(
          kdsRows.length > 0,
          "Grouped order created no KDS/order rows"
        );

        for (
          const row of
            kdsRows
        ) {
          assert.equal(
            Number(
              row.restaurant_id
            ),
            Number(
              fixtures.restaurantA
            )
          );

          assert.equal(
            String(
              row.batch_id
            ),
            firstBatchId
          );
        }

        console.log(
          "✅ 05 KDS/order persistence shares batch"
        );

        /*
         * Exactly one Edge submission event
         * must exist for this submission.
         */
        const events =
          await all(
            `
            SELECT
              id,
              event_id,
              restaurant_id,
              event_type,
              entity_type,
              entity_id,
              idempotency_key,
              payload,
              status,
              retry_count,
              acked_at
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type =
                'pos.order.submitted'
              AND entity_id = $2
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              firstBatchId,
            ]
          );

        assert.equal(
          events.length,
          1,
          "Initial POS submission did not create exactly one Edge event"
        );

        const event =
          events[0];

        assert.equal(
          Number(
            event.restaurant_id
          ),
          Number(
            fixtures.restaurantA
          )
        );

        assert.equal(
          event.event_type,
          "pos.order.submitted"
        );


        assert.equal(
          Number(
            event.payload
              ?.schema_version
          ),
          2,
          "POS Edge event did not use operational schema v2"
        );

        assert.equal(
          String(
            event.payload
              ?.batch?.id ||
            ""
          ),
          firstBatchId,
          "POS Edge event batch snapshot does not match ticket"
        );

        assert.equal(
          Number(
            event.payload
              ?.batch
              ?.restaurant_id
          ),
          Number(
            fixtures.restaurantA
          ),
          "POS Edge event batch snapshot crossed tenant"
        );

        assert.deepEqual(
          sortedNumeric(
            (
              event.payload
                ?.pos_rows ||
              []
            ).map(
              (row) =>
                row.id
            )
          ),
          sortedNumeric(
            event.payload
              ?.pos_order_ids ||
            []
          ),
          "POS Edge row snapshots do not match authoritative POS ids"
        );

        assert.equal(
          (
            event.payload
              ?.pos_rows ||
            []
          ).length,
          firstPosIds.length,
          "POS Edge event did not snapshot every authoritative POS row"
        );

        for (
          let index = 0;
          index <
            (
              event.payload
                ?.pos_rows ||
              []
            ).length;
          index += 1
        ) {
          const row =
            event.payload
              .pos_rows[index];

          assert.equal(
            String(
              row.edge_submission_id ||
              ""
            ),
            String(
              event.payload
                .submission_id
            ),
            "POS Edge stable submission id mismatch"
          );

          assert.equal(
            Number(
              row.edge_row_ordinal
            ),
            index + 1,
            "POS Edge row ordinal is not stable/consecutive"
          );

          assert.equal(
            Number(
              row.restaurant_id
            ),
            Number(
              fixtures.restaurantA
            ),
            "POS Edge row snapshot crossed tenant"
          );

          assert.equal(
            String(
              row.batch_id
            ),
            firstBatchId,
            "POS Edge row snapshot crossed batch"
          );
        }

        assert.ok(
          Array.isArray(
            event.payload
              ?.kds_rows
          ),
          "POS Edge event kds_rows is missing"
        );

        assert.ok(
          event.payload
            .kds_rows.length > 0,
          "Normal POS send produced no KDS row snapshot"
        );

        for (
          const row of
          event.payload.kds_rows
        ) {
          assert.equal(
            Number(
              row.restaurant_id
            ),
            Number(
              fixtures.restaurantA
            ),
            "KDS snapshot crossed tenant"
          );

          assert.equal(
            String(
              row.batch_id
            ),
            firstBatchId,
            "KDS snapshot crossed batch"
          );
        }

        console.log(
          "✅ POS operational schema v2 snapshots + stable row identity proven"
        );

        assert.equal(
          event.entity_type,
          "order_batch"
        );

        assert.equal(
          event.entity_id,
          firstBatchId
        );

        assert.equal(
          event.status,
          "pending"
        );

        assert.equal(
          Number(
            event.retry_count
          ),
          0
        );

        assert.equal(
          event.acked_at,
          null
        );

        const payload =
          event.payload;

        assert.ok(
          payload &&
          typeof payload ===
            "object"
        );

        assert.equal(
          Number(
            payload.restaurant_id
          ),
          Number(
            fixtures.restaurantA
          )
        );

        assert.equal(
          String(
            payload.batch_id
          ),
          firstBatchId
        );

        assert.equal(
          payload.order_type,
          "takeaway"
        );

        assert.equal(
          payload.source,
          "pos"
        );

        assert.equal(
          payload.table_number,
          "Takeaway"
        );

        assert.equal(
          payload.append_to_existing_batch,
          false
        );

        assert.match(
          String(
            payload.submission_id ||
            ""
          ),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          "Initial Edge event has no valid submission_id"
        );

        assert.deepEqual(
          sortedNumeric(
            payload.pos_order_ids
          ),
          sortedNumeric(
            firstPosIds
          ),
          "Edge payload IDs do not exactly match authoritative POS rows"
        );

        assert.equal(
          Number(
            payload.pricing
              ?.total
          ),
          25
        );

        /*
         * Batch UUID must not appear as an event
         * owned by Restaurant B.
         */
        const foreign =
          await one(
            `
            SELECT COUNT(*)::int
              AS count
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND entity_id = $2
            `,
            [
              fixtures.restaurantB,
              firstBatchId,
            ]
          );

        assert.equal(
          Number(
            foreign?.count ||
            0
          ),
          0,
          "Restaurant A Edge event crossed into Restaurant B"
        );

        console.log(
          "✅ 06 Edge event tenant + payload linkage proven"
        );
      }
    );

    /* -----------------------------------------------------
       LOST HTTP RESPONSE = SAFE IDEMPOTENT REPLAY
    ----------------------------------------------------- */

    await t.test(
      "lost HTTP response retry replays completed POS submission exactly once",
      async () => {
        const submissionId =
          require(
            "node:crypto"
          ).randomUUID();

        const payload = {
          ...orderPayload({
            mealId:
              fixtures.mealA,

            quantity:
              1,
          }),

          submission_id:
            submissionId,
        };

        /*
         * First request commits normally.
         *
         * The test deliberately does not use its response to
         * decide whether another business operation is needed.
         * Conceptually, the HTTP response is lost after commit.
         */
        const firstResponse =
          await request(app)
            .post(
              "/orders/grouped"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send(
              payload
            );

        assert.equal(
          firstResponse.status,
          201,
          JSON.stringify(
            firstResponse.body
          )
        );

        assert.equal(
          String(
            firstResponse.body
              ?.submission_id ||
            ""
          ),
          submissionId
        );

        const batchId =
          String(
            firstResponse.body
              ?.batch_id ||
            ""
          );

        assert.match(
          batchId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          "Lost-response first request returned no valid batch_id"
        );

        /*
         * Simulate the POS retry after it never received the
         * first response: same tenant, exact same body, same
         * client-generated submission UUID.
         */
        const replayResponse =
          await request(app)
            .post(
              "/orders/grouped"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send(
              payload
            );

        assert.equal(
          replayResponse.status,
          201,
          JSON.stringify(
            replayResponse.body
          )
        );

        assert.equal(
          String(
            replayResponse.body
              ?.submission_id ||
            ""
          ),
          submissionId
        );

        assert.equal(
          String(
            replayResponse.body
              ?.batch_id ||
            ""
          ),
          batchId,
          "Replay returned a different batch"
        );

        assert.deepEqual(
          replayResponse.body,
          firstResponse.body,
          "Replay did not return the original HTTP result"
        );

        const batchRows =
          await all(
            `
            SELECT id
            FROM
              public.order_batches
            WHERE
              restaurant_id = $1
              AND id = $2::uuid
            `,
            [
              fixtures.restaurantA,
              batchId,
            ]
          );

        assert.equal(
          batchRows.length,
          1,
          "Lost-response retry duplicated order_batches"
        );

        const posRows =
          await all(
            `
            SELECT id
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND batch_id = $2::uuid
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              batchId,
            ]
          );

        assert.equal(
          posRows.length,
          1,
          "Lost-response retry duplicated POS bill rows"
        );

        const kdsRows =
          await all(
            `
            SELECT id
            FROM
              public.orders
            WHERE
              restaurant_id = $1
              AND batch_id = $2::uuid
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              batchId,
            ]
          );

        assert.equal(
          kdsRows.length,
          1,
          "Lost-response retry duplicated KDS/order rows"
        );

        const reservations =
          await all(
            `
            SELECT
              id,
              submission_id,
              quantity,
              status
            FROM
              public.item_availability_reservations
            WHERE
              restaurant_id = $1
              AND batch_id = $2::uuid
              AND submission_id = $3::uuid
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              batchId,
              submissionId,
            ]
          );

        assert.equal(
          reservations.length,
          1,
          "Lost-response retry duplicated availability reservations"
        );

        assert.equal(
          Number(
            reservations[0]
              ?.quantity
          ),
          1
        );

        assert.equal(
          String(
            reservations[0]
              ?.status ||
            ""
          ),
          "consumed"
        );

        const events =
          await all(
            `
            SELECT
              id,
              idempotency_key,
              payload
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type =
                'pos.order.submitted'
              AND entity_id = $2
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              batchId,
            ]
          );

        assert.equal(
          events.length,
          1,
          "Lost-response retry duplicated Edge outbox events"
        );

        assert.equal(
          String(
            events[0]
              ?.idempotency_key ||
            ""
          ),
          `pos.order.submitted:${submissionId}`
        );

        assert.equal(
          String(
            events[0]
              ?.payload
              ?.submission_id ||
            ""
          ),
          submissionId
        );

        const idempotencyRows =
          await all(
            `
            SELECT
              id,
              status,
              response_status,
              response_body
            FROM
              public.edge_idempotency
            WHERE
              restaurant_id = $1
              AND scope = $2
              AND idempotency_key = $3
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              "pos.orders.grouped",
              submissionId,
            ]
          );

        assert.equal(
          idempotencyRows.length,
          1,
          "Lost-response retry created multiple idempotency records"
        );

        assert.equal(
          idempotencyRows[0]
            ?.status,
          "completed"
        );

        assert.equal(
          Number(
            idempotencyRows[0]
              ?.response_status
          ),
          200
        );

        assert.equal(
          String(
            idempotencyRows[0]
              ?.response_body
              ?.batch_id ||
            ""
          ),
          batchId
        );

        /*
         * Same UUID with changed request content must fail
         * closed and must not execute restaurant mutations.
         */
        const changedPayload = {
          ...payload,

          items:
            payload.items.map(
              (
                item,
                index
              ) =>
                index === 0
                  ? {
                      ...item,
                      quantity:
                        Number(
                          item.quantity ||
                          1
                        ) + 1,
                    }
                  : item
            ),
        };

        const conflictResponse =
          await request(app)
            .post(
              "/orders/grouped"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send(
              changedPayload
            );

        assert.equal(
          conflictResponse.status,
          409,
          JSON.stringify(
            conflictResponse.body
          )
        );

        assert.equal(
          conflictResponse.body
            ?.code,
          "EDGE_IDEMPOTENCY_CONFLICT"
        );

        const afterConflict =
          {
            batches:
              Number(
                (
                  await one(
                    `
                    SELECT COUNT(*)::int
                      AS count
                    FROM
                      public.order_batches
                    WHERE
                      restaurant_id = $1
                      AND id = $2::uuid
                    `,
                    [
                      fixtures.restaurantA,
                      batchId,
                    ]
                  )
                )?.count ||
                0
              ),

            pos:
              Number(
                (
                  await one(
                    `
                    SELECT COUNT(*)::int
                      AS count
                    FROM
                      public.pos_orders
                    WHERE
                      restaurant_id = $1
                      AND batch_id = $2::uuid
                    `,
                    [
                      fixtures.restaurantA,
                      batchId,
                    ]
                  )
                )?.count ||
                0
              ),

            kds:
              Number(
                (
                  await one(
                    `
                    SELECT COUNT(*)::int
                      AS count
                    FROM
                      public.orders
                    WHERE
                      restaurant_id = $1
                      AND batch_id = $2::uuid
                    `,
                    [
                      fixtures.restaurantA,
                      batchId,
                    ]
                  )
                )?.count ||
                0
              ),

            reservations:
              Number(
                (
                  await one(
                    `
                    SELECT COUNT(*)::int
                      AS count
                    FROM
                      public.item_availability_reservations
                    WHERE
                      restaurant_id = $1
                      AND batch_id = $2::uuid
                      AND submission_id = $3::uuid
                    `,
                    [
                      fixtures.restaurantA,
                      batchId,
                      submissionId,
                    ]
                  )
                )?.count ||
                0
              ),

            outbox:
              Number(
                (
                  await one(
                    `
                    SELECT COUNT(*)::int
                      AS count
                    FROM
                      public.edge_outbox
                    WHERE
                      restaurant_id = $1
                      AND event_type =
                        'pos.order.submitted'
                      AND entity_id = $2
                    `,
                    [
                      fixtures.restaurantA,
                      batchId,
                    ]
                  )
                )?.count ||
                0
              ),

            idempotency:
              Number(
                (
                  await one(
                    `
                    SELECT COUNT(*)::int
                      AS count
                    FROM
                      public.edge_idempotency
                    WHERE
                      restaurant_id = $1
                      AND scope = $2
                      AND idempotency_key = $3
                    `,
                    [
                      fixtures.restaurantA,
                      "pos.orders.grouped",
                      submissionId,
                    ]
                  )
                )?.count ||
                0
              ),
          };

        assert.deepEqual(
          afterConflict,
          {
            batches:
              1,

            pos:
              1,

            kds:
              1,

            reservations:
              1,

            outbox:
              1,

            idempotency:
              1,
          },
          "Idempotency conflict changed committed restaurant state"
        );

        console.log(
          "✅ Lost HTTP response replay returned original result exactly once"
        );

        console.log(
          "✅ Same submission_id with changed payload failed closed"
        );
      }
    );

    /* -----------------------------------------------------
       APPEND TO EXISTING BATCH
    ----------------------------------------------------- */

    await t.test(
      "append creates a distinct Edge submission without duplicating batch",
      async () => {
        assert.ok(
          firstBatchId,
          "Initial batch is missing"
        );

        const response =
          await request(app)
            .post(
              "/orders/grouped"
            )
            .set(
              "Authorization",
              bearer(
                tokenA
              )
            )
            .send(
              orderPayload({
                mealId:
                  fixtures.mealA,

                quantity: 1,

                appendBatchId:
                  firstBatchId,
              })
            );

        assert.equal(
          response.status,
          201,
          JSON.stringify(
            response.body
          )
        );

        assert.equal(
          String(
            response.body
              ?.batch_id
          ),
          firstBatchId
        );

        /*
         * Existing batch must still be exactly
         * one batch row.
         */
        const batchCount =
          await one(
            `
            SELECT COUNT(*)::int
              AS count
            FROM
              public.order_batches
            WHERE
              restaurant_id = $1
              AND id = $2::uuid
            `,
            [
              fixtures.restaurantA,
              firstBatchId,
            ]
          );

        assert.equal(
          Number(
            batchCount?.count ||
            0
          ),
          1
        );

        const posRows =
          await all(
            `
            SELECT id
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND batch_id =
                $2::uuid
            ORDER BY id ASC
            `,
            [
              fixtures.restaurantA,
              firstBatchId,
            ]
          );

        assert.equal(
          posRows.length,
          3,
          "Append should add one POS row to the existing two"
        );

        const events =
          await all(
            `
            SELECT
              id,
              idempotency_key,
              payload,
              status
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type =
                'pos.order.submitted'
              AND entity_id = $2
            ORDER BY id ASC
            `,
            [
              fixtures.restaurantA,
              firstBatchId,
            ]
          );

        assert.equal(
          events.length,
          2,
          "Append did not create a second distinct Edge submission event"
        );

        assert.notEqual(
          events[0]
            .idempotency_key,
          events[1]
            .idempotency_key,
          "Original and append submissions collided on Edge idempotency"
        );

        const appendEvent =
          events[1];

        assert.equal(
          appendEvent.status,
          "pending"
        );

        assert.equal(
          appendEvent.payload
            ?.append_to_existing_batch,
          true
        );

        const firstSubmissionId =
          String(
            events[0].payload
              ?.submission_id ||
            ""
          );

        const appendSubmissionId =
          String(
            appendEvent.payload
              ?.submission_id ||
            ""
          );

        assert.match(
          firstSubmissionId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        assert.match(
          appendSubmissionId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );

        assert.notEqual(
          appendSubmissionId,
          firstSubmissionId,
          "Append reused the original submission identity"
        );

        const reservations =
          await all(
            `
            SELECT
              id,
              restaurant_id,
              batch_id,
              submission_id,
              item_type,
              item_id,
              quantity,
              status
            FROM
              public.item_availability_reservations
            WHERE
              restaurant_id = $1
              AND batch_id =
                $2::uuid
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
              firstBatchId,
            ]
          );

        assert.equal(
          reservations.length,
          2,
          "Original + append should have two availability reservation rows"
        );

        assert.equal(
          new Set(
            reservations.map(
              (row) =>
                String(
                  row.submission_id
                )
            )
          ).size,
          2,
          "Availability reservations reused one submission_id"
        );

        const appendReservation =
          reservations.find(
            (row) =>
              String(
                row.submission_id
              ) ===
              appendSubmissionId
          );

        assert.ok(
          appendReservation,
          "Append Edge submission has no matching availability reservation"
        );

        assert.equal(
          Number(
            appendReservation.quantity
          ),
          1
        );

        assert.equal(
          String(
            appendReservation.batch_id
          ),
          firstBatchId
        );

        assert.equal(
          Number(
            appendReservation.restaurant_id
          ),
          Number(
            fixtures.restaurantA
          )
        );

        const appendedIds =
          sortedNumeric(
            appendEvent.payload
              ?.pos_order_ids
          );

        assert.equal(
          Number(
            appendEvent.payload
              ?.schema_version
          ),
          2
        );

        assert.equal(
          (
            appendEvent.payload
              ?.pos_rows ||
            []
          ).length,
          appendedIds.length,
          "Append snapshot included old POS rows"
        );

        for (
          const row of
          appendEvent.payload
            .pos_rows || []
        ) {
          assert.equal(
            String(
              row.edge_submission_id ||
              ""
            ),
            appendSubmissionId,
            "Append POS row reused old submission identity"
          );
        }


        assert.equal(
          appendedIds.length,
          1,
          "Append Edge event must contain only newly-created POS rows"
        );

        assert.equal(
          firstPosIds.includes(
            appendedIds[0]
          ),
          false,
          "Append Edge event reused an original POS row ID"
        );

        console.log(
          "✅ 07 Append submission Edge identity proven"
        );
      }
    );

    /* -----------------------------------------------------
       FORCED EDGE FAILURE = FULL POS ROLLBACK
    ----------------------------------------------------- */

    await t.test(
      "forced Edge enqueue failure rolls back the whole restaurant operation",
      async () => {
        const before =
          await restaurantCounts(
            fixtures.restaurantA
          );

        /*
         * Test-only PostgreSQL fault injection.
         *
         * This executes at the final Edge outbox INSERT,
         * after the route has already performed its normal
         * order/KDS/POS work inside the transaction.
         *
         * If transaction boundaries are correct, EVERYTHING
         * performed by that request disappears.
         */
        await removeFailureTrigger();

        await query(`
          CREATE FUNCTION
            public.maks_test_reject_pos_edge()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            IF NEW.event_type =
              'pos.order.submitted'
            THEN
              RAISE EXCEPTION
                'MAKS_TEST_FORCED_EDGE_OUTBOX_FAILURE';
            END IF;

            RETURN NEW;
          END;
          $$
        `);

        await query(`
          CREATE TRIGGER
            trg_maks_test_reject_pos_edge
          BEFORE INSERT
          ON public.edge_outbox
          FOR EACH ROW
          EXECUTE FUNCTION
            public.maks_test_reject_pos_edge()
        `);

        try {
          const response =
            await request(app)
              .post(
                "/orders/grouped"
              )
              .set(
                "Authorization",
                bearer(
                  tokenA
                )
              )
              .send(
                orderPayload({
                  mealId:
                    fixtures.mealA,

                  quantity: 3,
                })
              );

          assert.equal(
            response.status,
            500,
            `Forced Edge failure unexpectedly returned ${response.status}: ${JSON.stringify(
              response.body
            )}`
          );
        } finally {
          await removeFailureTrigger();
        }

        const after =
          await restaurantCounts(
            fixtures.restaurantA
          );

        assert.deepEqual(
          after,
          before,
          [
            "Forced Edge failure left persistent restaurant state.",
            `Before: ${JSON.stringify(before)}`,
            `After: ${JSON.stringify(after)}`,
          ].join(
            "\n"
          )
        );

        console.log(
          "✅ 08 Edge failure rolled back batch + availability + KDS + POS + outbox"
        );
      }
    );

    /* -----------------------------------------------------
       FINAL DATABASE LINKAGE
    ----------------------------------------------------- */

    await t.test(
      "all committed Edge POS event IDs reference real same-tenant POS rows",
      async () => {
        const events =
          await all(
            `
            SELECT
              id,
              entity_id,
              payload
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type =
                'pos.order.submitted'
            ORDER BY
              id ASC
            `,
            [
              fixtures.restaurantA,
            ]
          );

        assert.ok(
          events.length >= 2
        );

        for (
          const event of
            events
        ) {
          const payloadIds =
            sortedNumeric(
              event.payload
                ?.pos_order_ids
            );

          assert.ok(
            payloadIds.length > 0,
            "Committed Edge POS event contains no POS IDs"
          );

          const submissionId =
            String(
              event.payload
                ?.submission_id ||
              ""
            );

          assert.match(
            submissionId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
            "Committed Edge event has invalid submission_id"
          );

          const reservation =
            await one(
              `
              SELECT
                id,
                restaurant_id,
                batch_id,
                submission_id,
                quantity,
                status
              FROM
                public.item_availability_reservations
              WHERE
                restaurant_id = $1
                AND batch_id =
                  $2::uuid
                AND submission_id =
                  $3::uuid
              LIMIT 1
              `,
              [
                fixtures.restaurantA,
                String(
                  event.entity_id
                ),
                submissionId,
              ]
            );

          assert.ok(
            reservation,
            "Committed Edge submission has no matching availability reservation"
          );

          assert.equal(
            Number(
              reservation.restaurant_id
            ),
            Number(
              fixtures.restaurantA
            )
          );

          assert.equal(
            String(
              reservation.batch_id
            ),
            String(
              event.entity_id
            )
          );

          assert.equal(
            String(
              reservation.submission_id
            ),
            submissionId
          );

          const actual =
            await all(
              `
              SELECT
                id,
                restaurant_id,
                batch_id
              FROM
                public.pos_orders
              WHERE
                restaurant_id = $1
                AND id =
                  ANY(
                    $2::bigint[]
                  )
              ORDER BY
                id ASC
              `,
              [
                fixtures.restaurantA,
                payloadIds,
              ]
            );

          assert.deepEqual(
            sortedNumeric(
              actual.map(
                (row) =>
                  row.id
              )
            ),
            payloadIds,
            "Edge payload references a missing or foreign POS row"
          );

          for (
            const row of
              actual
          ) {
            assert.equal(
              Number(
                row.restaurant_id
              ),
              Number(
                fixtures.restaurantA
              )
            );

            assert.equal(
              String(
                row.batch_id
              ),
              String(
                event.entity_id
              )
            );
          }
        }

        console.log(
          "✅ 09 Persistent Edge → POS referential linkage proven"
        );
      }
    );

    console.log("");
    console.log(
      "=============================================="
    );
    console.log(
      "✅ MAKS POS → EDGE ATTACK COMPLETE"
    );
    console.log(
      "=============================================="
    );
  }
);
