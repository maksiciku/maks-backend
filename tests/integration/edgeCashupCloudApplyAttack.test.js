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



const crypto =
  require("node:crypto");

const {
  generateEdgeCredentials,
} = require(
  "../../utils/edgeAuth"
);

const {
  hashJson,
} = require(
  "../../edge/syncStore"
);


const CASHUP_EDGE_EVENT =
  "cashup.session.closed.v1";

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;


function uuid() {
  return crypto.randomUUID();
}


function edgeHeaders(
  installationId,
  secret
) {
  return {
    "x-edge-installation-id":
      installationId,

    "x-edge-secret":
      secret,
  };
}


function normalizeJson(
  value
) {
  if (
    typeof value === "string"
  ) {
    return JSON.parse(
      value
    );
  }

  return value;
}


async function registerEdge(
  restaurantId
) {
  const credentials =
    generateEdgeCredentials();

  await query(
    `
    INSERT INTO
      public.restaurant_edge_nodes
    (
      restaurant_id,
      installation_id,
      edge_name,
      secret_hash,
      is_active
    )
    VALUES
    (
      $1,
      $2::uuid,
      $3,
      $4,
      TRUE
    )
    `,
    [
      restaurantId,
      credentials.installationId,
      `CASHUP EDGE ATTACK ${Date.now()}`,
      credentials.secretHash,
    ]
  );

  return credentials;
}


async function cashupOutbox(
  restaurantId,
  sessionId
) {
  return one(
    `
    SELECT
      event_id,
      restaurant_id,
      event_type,
      entity_type,
      entity_id,
      idempotency_key,
      payload,
      payload_hash,
      created_at
    FROM public.edge_outbox
    WHERE restaurant_id = $1
      AND event_type = $2
      AND entity_id = $3
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [
      restaurantId,
      CASHUP_EDGE_EVENT,
      String(
        sessionId
      ),
    ]
  );
}


function pushShape(
  row
) {
  const payload =
    normalizeJson(
      row.payload
    );

  return {
    event_id:
      String(
        row.event_id
      ),

    restaurant_id:
      Number(
        row.restaurant_id
      ),

    event_type:
      String(
        row.event_type
      ),

    entity_type:
      String(
        row.entity_type
      ),

    entity_id:
      String(
        row.entity_id
      ),

    idempotency_key:
      String(
        row.idempotency_key
      ),

    payload,

    payload_hash:
      String(
        row.payload_hash
      ),

    created_at:
      new Date(
        row.created_at
      ).toISOString(),
  };
}


function makeCashupEvent({
  restaurantId,
  sessionId,
  payload,
  eventId = uuid(),
  entityId = sessionId,
}) {
  return {
    event_id:
      eventId,

    restaurant_id:
      Number(
        restaurantId
      ),

    event_type:
      CASHUP_EDGE_EVENT,

    entity_type:
      "cashup_session",

    entity_id:
      entityId,

    idempotency_key:
      `${CASHUP_EDGE_EVENT}:${sessionId}`,

    payload,

    payload_hash:
      hashJson(
        payload
      ),

    created_at:
      new Date()
        .toISOString(),
  };
}


async function pushEvent(
  credentials,
  event
) {
  return request(app)
    .post(
      "/edge/sync/push"
    )
    .set(
      edgeHeaders(
        credentials
          .installationId,
        credentials
          .secret
      )
    )
    .send({
      events: [
        event,
      ],
    });
}


async function inboxRow(
  eventId
) {
  return one(
    `
    SELECT
      event_id,
      restaurant_id,
      event_type,
      entity_type,
      entity_id,
      status,
      applied_at
    FROM public.edge_inbox
    WHERE event_id =
          $1::uuid
    `,
    [
      eventId,
    ]
  );
}


async function installCashupOutboxFailureTrigger() {
  await query(`
    DROP TRIGGER IF EXISTS
      maks_cashup_edge_attack_fail
    ON public.edge_outbox
  `);

  await query(`
    DROP FUNCTION IF EXISTS
      public.maks_cashup_edge_attack_fail()
  `);

  await query(`
    CREATE FUNCTION
      public.maks_cashup_edge_attack_fail()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.event_type =
           'cashup.session.closed.v1'
      THEN
        RAISE EXCEPTION
          'MAKS CASHUP EDGE FORCED OUTBOX FAILURE';
      END IF;

      RETURN NEW;
    END;
    $$
  `);

  await query(`
    CREATE TRIGGER
      maks_cashup_edge_attack_fail
    BEFORE INSERT
    ON public.edge_outbox
    FOR EACH ROW
    EXECUTE FUNCTION
      public.maks_cashup_edge_attack_fail()
  `);
}


async function removeCashupOutboxFailureTrigger() {
  await query(`
    DROP TRIGGER IF EXISTS
      maks_cashup_edge_attack_fail
    ON public.edge_outbox
  `);

  await query(`
    DROP FUNCTION IF EXISTS
      public.maks_cashup_edge_attack_fail()
  `);
}


/*
 * =========================================================
 * SAFE SETUP
 * =========================================================
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
      "EDGE CASHUP ATTACK REFUSED: wrong database"
    );

    pool =
      safe.pool;

    process.env
      .MAKS_RUNTIME_ROLE =
      "cloud";

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

    ({ app } =
      require(
        "../../server"
      ));

    assert.ok(app);

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
      tokenA
    );

    console.log(
      "✅ 01 Safe maks_test + real owner + real POS routes ready"
    );
  }
);


test.after(
  async () => {
    process.env
      .MAKS_RUNTIME_ROLE =
      "cloud";

    if (pool) {
      try {
        await removeCashupOutboxFailureTrigger();
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


/*
 * =========================================================
 * 1 — ATOMIC PRODUCER ROLLBACK
 * =========================================================
 */

test(
  "EDGE CASHUP: outbox failure rolls back the entire close",
  async () => {
    process.env
      .MAKS_RUNTIME_ROLE =
      "cloud";

    const from =
      new Date(
        Date.now() -
          1000
      ).toISOString();

    const sale =
      await createPaidSaleA(
        "Table CASH-EDGE-ROLLBACK"
      );

    const to =
      new Date(
        Date.now() +
          1000
      ).toISOString();

    await installCashupOutboxFailureTrigger();

    process.env
      .MAKS_RUNTIME_ROLE =
      "edge";

    let close;

    try {
      close =
        await closeCashup({
          from,
          to,

          actualCash:
            money(
              sale
                .payment
                .amount
            ),

          note:
            "forced outbox rollback",
        });
    } finally {
      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

      await removeCashupOutboxFailureTrigger();
    }

    assert.equal(
      close.status,
      500,
      JSON.stringify(
        close.body
      )
    );

    const sessions =
      await one(
        `
        SELECT
          COUNT(*)::int
            AS count
        FROM public.cashup_sessions
        WHERE restaurant_id = $1
          AND from_ts = $2
          AND to_ts = $3
        `,
        [
          fixtures.restaurantA,
          from,
          to,
        ]
      );

    assert.equal(
      Number(
        sessions?.count ||
        0
      ),
      0,
      "Cash-up session survived failed outbox write"
    );

    const payment =
      await one(
        `
        SELECT
          cashup_session_id
        FROM public.payments
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          sale.payment.id,
        ]
      );

    assert.equal(
      payment
        ?.cashup_session_id,
      null,
      "Payment stayed linked after transaction rollback"
    );

    const events =
      await one(
        `
        SELECT
          COUNT(*)::int
            AS count
        FROM public.edge_outbox
        WHERE restaurant_id = $1
          AND event_type = $2
        `,
        [
          fixtures.restaurantA,
          CASHUP_EDGE_EVENT,
        ]
      );

    assert.equal(
      Number(
        events?.count ||
        0
      ),
      0
    );

    console.log(
      "✅ 02 Forced outbox failure rolled back session + payment links"
    );
  }
);


/*
 * =========================================================
 * 2 — PRODUCER → CLOUD APPLY → ATTACKS
 * =========================================================
 */

test(
  "MAKS cash-up Edge producer + Cloud apply attack",
  {
    timeout:
      60000,
  },
  async (t) => {
    process.env
      .MAKS_RUNTIME_ROLE =
      "cloud";

    const from =
      new Date(
        Date.now() -
          1000
      ).toISOString();

    const sale =
      await createPaidSaleA(
        "Table CASH-EDGE-CLOUD"
      );

    const identity =
      await one(
        `
        SELECT
          id,
          payment_uuid,
          cashup_session_id
        FROM public.payments
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [
          fixtures.restaurantA,
          sale.payment.id,
        ]
      );

    assert.ok(
      identity
        ?.payment_uuid
    );

    const paymentUuid =
      String(
        identity.payment_uuid
      ).toLowerCase();

    const to =
      new Date(
        Date.now() +
          1000
      ).toISOString();

    process.env
      .MAKS_RUNTIME_ROLE =
      "edge";

    const close =
      await closeCashup({
        from,
        to,

        actualCash:
          money(
            sale
              .payment
              .amount
          ),

        note:
          "edge cloud apply attack",
      });

    process.env
      .MAKS_RUNTIME_ROLE =
      "cloud";

    assert.ok(
      is2xx(
        close.status
      ),
      JSON.stringify(
        close.body
      )
    );

    const sessionId =
      String(
        close.body
          ?.cashup_session_id ||
        ""
      ).toLowerCase();

    assert.ok(
      sessionId
    );

    const outbox =
      await cashupOutbox(
        fixtures.restaurantA,
        sessionId
      );

    assert.ok(
      outbox,
      "Cash-up close emitted no durable Edge outbox event"
    );

    const event =
      pushShape(
        outbox
      );

    const payload =
      event.payload;

    assert.equal(
      event.event_type,
      CASHUP_EDGE_EVENT
    );

    assert.equal(
      event.entity_type,
      "cashup_session"
    );

    assert.equal(
      String(
        event.entity_id
      ).toLowerCase(),
      sessionId
    );

    assert.equal(
      event.idempotency_key,
      `${CASHUP_EDGE_EVENT}:${sessionId}`
    );

    assert.equal(
      Number(
        payload.schema_version
      ),
      1
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
        payload.session.id
      ).toLowerCase(),
      sessionId
    );

    assert.equal(
      Object.prototype
        .hasOwnProperty
        .call(
          payload.session,
          "closed_by_user_id"
        ),
      false,
      "Local BIGINT staff identity crossed Edge boundary"
    );

    assert.ok(
      String(
        payload.session
          .closed_by_name ||
        ""
      ).length > 0,
      "Portable closer display name missing"
    );

    assert.ok(
      Array.isArray(
        payload.payment_uuids
      )
    );

    assert.ok(
      payload
        .payment_uuids
        .map(
          (value) =>
            String(
              value
            ).toLowerCase()
        )
        .includes(
          paymentUuid
        ),
      "Cash-up payload does not contain payment_uuid"
    );

    console.log(
      "✅ 03 Producer payload uses cash-up UUID + payment UUIDs only"
    );


    const localSession =
      await one(
        `
        SELECT
          id,
          closed_by_user_id,
          closed_by_name
        FROM public.cashup_sessions
        WHERE restaurant_id = $1
          AND id = $2::uuid
        `,
        [
          fixtures.restaurantA,
          sessionId,
        ]
      );

    assert.ok(
      localSession
    );

    assert.ok(
      localSession
        .closed_by_user_id
    );

    const localClosedByName =
      String(
        localSession
          .closed_by_name ||
        ""
      );


    /*
     * -----------------------------------------------------
     * Simulate the separate Cloud database state:
     *
     * payment exists by portable payment_uuid,
     * but cash-up session/link do not.
     * -----------------------------------------------------
     */

    await query(
      `
      UPDATE public.payments
      SET
        cashup_session_id =
          NULL
      WHERE restaurant_id = $1
        AND cashup_session_id =
            $2::uuid
      `,
      [
        fixtures.restaurantA,
        sessionId,
      ]
    );

    await query(
      `
      DELETE FROM public.cashup_sessions
      WHERE restaurant_id = $1
        AND id = $2::uuid
      `,
      [
        fixtures.restaurantA,
        sessionId,
      ]
    );

    const credentials =
      await registerEdge(
        fixtures.restaurantA
      );


    await t.test(
      "valid event reconstructs same cash-up UUID and portable payment links",
      async () => {
        const response =
          await pushEvent(
            credentials,
            event
          );

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            response.body
          )
        );

        assert.equal(
          response.body
            ?.success,
          true
        );

        assert.equal(
          response.body
            ?.acked
            ?.[0]
            ?.duplicate,
          false
        );

        const cloudSession =
          await one(
            `
            SELECT
              id,
              restaurant_id,
              closed_by_user_id,
              closed_by_name,
              from_ts,
              to_ts,
              expected_cash,
              actual_cash,
              discrepancy
            FROM public.cashup_sessions
            WHERE restaurant_id = $1
              AND id = $2::uuid
            `,
            [
              fixtures.restaurantA,
              sessionId,
            ]
          );

        assert.ok(
          cloudSession
        );

        assert.equal(
          String(
            cloudSession.id
          ).toLowerCase(),
          sessionId
        );

        assert.equal(
          cloudSession
            .closed_by_user_id,
          null,
          "Edge-local user BIGINT was materialized on Cloud"
        );

        assert.equal(
          String(
            cloudSession
              .closed_by_name ||
            ""
          ),
          localClosedByName
        );

        const linked =
          await all(
            `
            SELECT
              payment_uuid,
              cashup_session_id
            FROM public.payments
            WHERE restaurant_id = $1
              AND payment_uuid =
                  ANY($2::uuid[])
            ORDER BY payment_uuid
            `,
            [
              fixtures.restaurantA,
              payload.payment_uuids,
            ]
          );

        assert.equal(
          linked.length,
          payload
            .payment_uuids
            .length
        );

        for (
          const row of linked
        ) {
          assert.equal(
            String(
              row.cashup_session_id
            ).toLowerCase(),
            sessionId
          );
        }

        console.log(
          "✅ 04 Cloud reconstructed same cash-up UUID + payment UUID links"
        );
      }
    );


    await t.test(
      "identical replay is exactly once",
      async () => {
        const replay =
          await pushEvent(
            credentials,
            event
          );

        assert.equal(
          replay.status,
          200
        );

        assert.equal(
          replay.body
            ?.acked
            ?.[0]
            ?.duplicate,
          true
        );

        const count =
          await one(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM public.cashup_sessions
            WHERE restaurant_id = $1
              AND id = $2::uuid
            `,
            [
              fixtures.restaurantA,
              sessionId,
            ]
          );

        assert.equal(
          Number(
            count?.count ||
            0
          ),
          1
        );

        const inbox =
          await inboxRow(
            event.event_id
          );

        assert.equal(
          inbox?.status,
          "applied"
        );

        assert.ok(
          inbox?.applied_at
        );

        console.log(
          "✅ 05 Lost-ACK replay remained exactly once"
        );
      }
    );


    await t.test(
      "forged tenant is rejected before inbox persistence",
      async () => {
        const forgedPayload =
          JSON.parse(
            JSON.stringify(
              payload
            )
          );

        forgedPayload
          .restaurant_id =
          fixtures.restaurantB;

        const forged =
          makeCashupEvent({
            restaurantId:
              fixtures.restaurantB,

            sessionId,

            payload:
              forgedPayload,
          });

        const response =
          await pushEvent(
            credentials,
            forged
          );

        assert.equal(
          response.status,
          200
        );

        assert.equal(
          response.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_TENANT_MISMATCH"
        );

        assert.equal(
          await inboxRow(
            forged.event_id
          ),
          null
        );

        console.log(
          "✅ 06 Forged tenant rejected with no inbox leak"
        );
      }
    );


    await t.test(
      "mismatched cash-up entity UUID is rejected",
      async () => {
        const forged =
          makeCashupEvent({
            restaurantId:
              fixtures.restaurantA,

            sessionId,

            entityId:
              uuid(),

            payload:
              JSON.parse(
                JSON.stringify(
                  payload
                )
              ),
          });

        const response =
          await pushEvent(
            credentials,
            forged
          );

        assert.equal(
          response.status,
          200
        );

        assert.equal(
          response.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_CASHUP_SESSION_ID_MISMATCH"
        );

        assert.equal(
          await inboxRow(
            forged.event_id
          ),
          null
        );

        console.log(
          "✅ 07 Cash-up entity UUID forgery rejected"
        );
      }
    );


    await t.test(
      "same range with different UUID fails closed",
      async () => {
        const conflictId =
          uuid();

        const conflictPayload =
          JSON.parse(
            JSON.stringify(
              payload
            )
          );

        conflictPayload
          .session
          .id =
          conflictId;

        conflictPayload
          .payment_uuids =
          [];

        const conflict =
          makeCashupEvent({
            restaurantId:
              fixtures.restaurantA,

            sessionId:
              conflictId,

            payload:
              conflictPayload,
          });

        const response =
          await pushEvent(
            credentials,
            conflict
          );

        assert.equal(
          response.status,
          200
        );

        assert.equal(
          response.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_CASHUP_RANGE_CONFLICT"
        );

        const persisted =
          await one(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM public.cashup_sessions
            WHERE restaurant_id = $1
              AND id = $2::uuid
            `,
            [
              fixtures.restaurantA,
              conflictId,
            ]
          );

        assert.equal(
          Number(
            persisted?.count ||
            0
          ),
          0
        );

        console.log(
          "✅ 08 Same range / different UUID conflict rejected"
        );
      }
    );


    await t.test(
      "payment already owned by another cash-up fails closed",
      async () => {
        const otherId =
          uuid();

        const start =
          Date.now() +
          60 *
            60 *
            1000;

        const ownerConflictPayload = {
          schema_version:
            1,

          restaurant_id:
            fixtures.restaurantA,

          session: {
            id:
              otherId,

            from_ts:
              new Date(
                start
              ).toISOString(),

            to_ts:
              new Date(
                start +
                60 *
                  1000
              ).toISOString(),

            expected_cash:
              0,

            actual_cash:
              0,

            discrepancy:
              0,

            note:
              "payment owner conflict",

            closed_by_name:
              "Cashup Edge Attack",

            created_at:
              new Date()
                .toISOString(),
          },

          payment_uuids: [
            paymentUuid,
          ],
        };

        const attack =
          makeCashupEvent({
            restaurantId:
              fixtures.restaurantA,

            sessionId:
              otherId,

            payload:
              ownerConflictPayload,
          });

        const response =
          await pushEvent(
            credentials,
            attack
          );

        assert.equal(
          response.status,
          200
        );

        assert.equal(
          response.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_CASHUP_PAYMENT_ALREADY_CLOSED"
        );

        const leaked =
          await one(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM public.cashup_sessions
            WHERE restaurant_id = $1
              AND id = $2::uuid
            `,
            [
              fixtures.restaurantA,
              otherId,
            ]
          );

        assert.equal(
          Number(
            leaked?.count ||
            0
          ),
          0
        );

        console.log(
          "✅ 09 Payment cannot be stolen by another cash-up"
        );
      }
    );


    await t.test(
      "missing Cloud payment dependency remains unapplied",
      async () => {
        const missingId =
          uuid();

        const missingPaymentUuid =
          uuid();

        const start =
          Date.now() +
          2 *
            60 *
            60 *
            1000;

        const missingPayload = {
          schema_version:
            1,

          restaurant_id:
            fixtures.restaurantA,

          session: {
            id:
              missingId,

            from_ts:
              new Date(
                start
              ).toISOString(),

            to_ts:
              new Date(
                start +
                60 *
                  1000
              ).toISOString(),

            expected_cash:
              0,

            actual_cash:
              0,

            discrepancy:
              0,

            note:
              "missing payment dependency",

            closed_by_name:
              "Cashup Edge Attack",

            created_at:
              new Date()
                .toISOString(),
          },

          payment_uuids: [
            missingPaymentUuid,
          ],
        };

        const missingEvent =
          makeCashupEvent({
            restaurantId:
              fixtures.restaurantA,

            sessionId:
              missingId,

            payload:
              missingPayload,
          });

        const response =
          await pushEvent(
            credentials,
            missingEvent
          );

        assert.equal(
          response.status,
          200
        );

        assert.equal(
          response.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_CASHUP_PAYMENT_DEPENDENCY_MISSING"
        );

        const missingSession =
          await one(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM public.cashup_sessions
            WHERE restaurant_id = $1
              AND id = $2::uuid
            `,
            [
              fixtures.restaurantA,
              missingId,
            ]
          );

        assert.equal(
          Number(
            missingSession?.count ||
            0
          ),
          0
        );

        const inbox =
          await inboxRow(
            missingEvent
              .event_id
          );

        assert.ok(
          inbox,
          "Dependency failure should remain durably received for retry"
        );

        assert.equal(
          inbox.status,
          "received"
        );

        assert.equal(
          inbox.applied_at,
          null
        );

        console.log(
          "✅ 10 Missing payment dependency failed closed and stayed retryable"
        );
      }
    );


    console.log(
      "============================================================"
    );

    console.log(
      "✅ MAKS CASH-UP EDGE CLOUD APPLY ATTACK COMPLETE"
    );

    console.log(
      "============================================================"
    );
  }
);
