"use strict";

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const express =
  require("express");

const test =
  require("node:test");

const request =
  require("supertest");


process.env.MAKS_RUNTIME_ROLE =
  "cloud";


const {
  qGet,
  qAll,
  qRun,
  getPool,
} = require(
  "../../dbCompat"
);

const {
  assertTestDatabase,
} = require(
  "../safety/assertTestDatabase"
);

const {
  resetTestData,
} = require(
  "../setup/resetTestData"
);

const edgeRoutes =
  require(
    "../../routes/edgeRoutes"
  );

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

const {
  FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,
} = require(
  "../../edge/contracts/financialOperations"
);


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


function money(
  value
) {
  return Math.round(
    Number(value) *
      100
  ) / 100;
}


function makeOrderRef({
  submissionId,
  ordinal = 1,
  batchId,
}) {
  return {
    edge_submission_id:
      submissionId,

    edge_row_ordinal:
      ordinal,

    batch_id:
      batchId,
  };
}


function makePayload({
  restaurantId,
  settlementId,
  batchId,
  submissionId,
  tableNumber,
  tenderAmounts = [12.5],
  tenderUuids = null,
  posRowStates = null,
  createdAt = new Date().toISOString(),
}) {
  const orderRef =
    makeOrderRef({
      submissionId,
      ordinal: 1,
      batchId,
    });

  const uuids =
    tenderUuids ||
    tenderAmounts.map(
      () =>
        crypto.randomUUID()
    );

  assert.equal(
    uuids.length,
    tenderAmounts.length
  );

  const finalAmount =
    money(
      tenderAmounts.reduce(
        (sum, value) =>
          sum +
          Number(value),
        0
      )
    );

  return {
    schema_version:
      1,

    restaurant_id:
      restaurantId,

    ...(posRowStates
      ? {
          pos_row_states:
            posRowStates,
        }
      : {}),

    settlement: {
      id:
        settlementId,

      table_number:
        tableNumber,

      batch_id:
        batchId,

      invoice_number:
        null,

      gross_amount:
        finalAmount,

      pricing_discount_amount:
        0,

      happy_hour_discount_amount:
        0,

      deal_adjusted_amount:
        finalAmount,

      voucher_code:
        null,

      voucher_discount_amount:
        0,

      manual_discount_amount:
        0,

      service_charge_amount:
        0,

      final_amount:
        finalAmount,

      applied_rule_ids:
        [],

      order_refs: [
        orderRef,
      ],

      /*
       * This intentionally contains a portable order_ref.
       *
       * Cloud must reconstruct this as its OWN local
       * pricing_snapshot.pos_order_id.
       */
      pricing_snapshot: {
        version: 2,

        lines: [
          {
            order_ref:
              orderRef,

            label:
              "Offline financial line",

            gross:
              finalAmount,
          },
        ],
      },

      source:
        "pos",

      created_at:
        createdAt,
    },

    tenders:
      tenderAmounts.map(
        (
          amount,
          index
        ) => ({
          payment_uuid:
            uuids[index],

          amount:
            money(
              amount
            ),

          method:
            index === 0
              ? "cash"
              : "card",

          discount_value:
            0,

          discount_type:
            null,

          service_rate:
            0,

          batch_id:
            batchId,

          terminal_ref:
            index === 0
              ? null
              : `EDGE-CARD-${index}`,

          source:
            "pos",

          status:
            "completed",

          ref_payment_uuid:
            null,

          order_refs: [
            orderRef,
          ],

          created_at:
            createdAt,
        })
      ),
  };
}


function makeEvent({
  eventId,
  restaurantId,
  settlementId,
  payload,
}) {
  return {
    event_id:
      eventId,

    restaurant_id:
      restaurantId,

    event_type:
      FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,

    entity_type:
      "payment_settlement",

    entity_id:
      settlementId,

    idempotency_key:
      `${FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE}:${settlementId}`,

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


async function createBatch({
  restaurantId,
  batchId,
  tableNumber,
}) {
  await qRun(
    `
    INSERT INTO
      public.order_batches
    (
      id,
      restaurant_id,
      table_number,
      order_type,
      created_at
    )
    VALUES
    (
      $1::uuid,
      $2,
      $3,
      'dine-in',
      NOW()
    )
    `,
    [
      batchId,
      restaurantId,
      tableNumber,
    ]
  );
}


async function createPortablePosRow({
  restaurantId,
  batchId,
  submissionId,
  ordinal = 1,
  tableNumber,
  total = 12.5,
}) {
  await createBatch({
    restaurantId,
    batchId,
    tableNumber,
  });

  return qGet(
    `
    INSERT INTO
      public.pos_orders
    (
      restaurant_id,
      table_number,
      item_name,
      quantity,
      total_price,

      paid,
      amount_paid,
      remaining_price,

      source,
      batch_id,

      edge_submission_id,
      edge_row_ordinal,

      created_at
    )
    VALUES
    (
      $1,
      $2,
      'Cloud portable finance row',
      1,
      $3,

      0,
      0,
      $3,

      'pos',
      $4::uuid,

      $5::uuid,
      $6,

      NOW()
    )
    RETURNING
      id,
      restaurant_id,
      batch_id,
      edge_submission_id,
      edge_row_ordinal,
      paid,
      amount_paid,
      remaining_price
    `,
    [
      restaurantId,
      tableNumber,
      total,
      batchId,
      submissionId,
      ordinal,
    ]
  );
}


async function insertExistingSettlement({
  restaurantId,
  settlementId,
  tableNumber,
}) {
  await qRun(
    `
    INSERT INTO
      public.payment_settlements
    (
      id,
      restaurant_id,
      table_number,

      gross_amount,
      pricing_discount_amount,
      happy_hour_discount_amount,
      deal_adjusted_amount,

      voucher_discount_amount,
      manual_discount_amount,
      service_charge_amount,
      final_amount,

      applied_rule_ids,
      pos_order_ids,
      pricing_snapshot,

      source,
      created_at
    )
    VALUES
    (
      $1::uuid,
      $2,
      $3,

      1,
      0,
      0,
      1,

      0,
      0,
      0,
      1,

      '[]'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb,

      'pos',
      NOW()
    )
    `,
    [
      settlementId,
      restaurantId,
      tableNumber,
    ]
  );
}


async function insertExistingPayment({
  restaurantId,
  paymentUuid,
  tableNumber,
}) {
  await qRun(
    `
    INSERT INTO
      public.payments
    (
      table_number,
      amount,
      method,
      created_at,

      restaurant_id,
      pos_order_ids,
      source,
      status,

      payment_uuid
    )
    VALUES
    (
      $1,
      1,
      'cash',
      NOW(),

      $2,
      '[]'::jsonb,
      'pos',
      'completed',

      $3::uuid
    )
    `,
    [
      tableNumber,
      restaurantId,
      paymentUuid,
    ]
  );
}


async function pushEvent({
  api,
  edge,
  event,
}) {
  return api
    .post(
      "/edge/sync/push"
    )
    .set(
      edgeHeaders(
        edge.installationId,
        edge.secret
      )
    )
    .send({
      events: [
        event,
      ],
    });
}


async function countRows(
  sql,
  params
) {
  const row =
    await qGet(
      sql,
      params
    );

  return Number(
    row?.count ||
    0
  );
}


test(
  "MAKS financial settlement Cloud apply attack",
  {
    timeout:
      60000,
  },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();

    const requiredPaymentColumns =
      await qAll(
        `
        SELECT
          column_name
        FROM
          information_schema.columns
        WHERE
          table_schema =
            'public'
          AND table_name =
            'payments'
          AND column_name IN (
            'payment_uuid',
            'ref_payment_uuid',
            'settlement_id'
          )
        ORDER BY
          column_name
        `
      );

    assert.deepEqual(
      requiredPaymentColumns.map(
        (row) =>
          row.column_name
      ),
      [
        "payment_uuid",
        "ref_payment_uuid",
        "settlement_id",
      ],
      "Run the exact financial identity migration against maks_test first"
    );

    const app =
      express();

    app.use(
      express.json({
        limit:
          "2mb",
      })
    );

    app.use(
      (
        req,
        _res,
        next
      ) => {
        req.qGet =
          qGet;

        req.qAll =
          qAll;

        req.qRun =
          qRun;

        req.kind =
          "pg";

        next();
      }
    );

    app.use(
      "/edge",
      edgeRoutes
    );

    const api =
      request(
        app
      );

    const token =
      crypto
        .randomBytes(8)
        .toString(
          "hex"
        );

    const restaurantA =
      await qGet(
        `
        INSERT INTO
          public.restaurants
        (
          name
        )
        VALUES
        (
          $1
        )
        RETURNING
          id
        `,
        [
          `FIN CLOUD A ${token}`,
        ]
      );

    const restaurantB =
      await qGet(
        `
        INSERT INTO
          public.restaurants
        (
          name
        )
        VALUES
        (
          $1
        )
        RETURNING
          id
        `,
        [
          `FIN CLOUD B ${token}`,
        ]
      );

    const ridA =
      Number(
        restaurantA.id
      );

    const ridB =
      Number(
        restaurantB.id
      );

    const edgeA =
      generateEdgeCredentials();

    const edgeB =
      generateEdgeCredentials();

    await qRun(
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
        ridA,
        edgeA.installationId,
        `FIN EDGE A ${token}`,
        edgeA.secretHash,
      ]
    );

    await qRun(
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
        ridB,
        edgeB.installationId,
        `FIN EDGE B ${token}`,
        edgeB.secretHash,
      ]
    );


    /*
     * =====================================================
     * 01 — PRIMARY MULTI-TENDER MATERIALIZATION
     * =====================================================
     */

    const tableMain =
      "Table FIN 901";

    const batchMain =
      crypto.randomUUID();

    const submissionMain =
      crypto.randomUUID();

    const settlementMain =
      crypto.randomUUID();

    const eventMain =
      crypto.randomUUID();

    const tenderA =
      crypto.randomUUID();

    const tenderB =
      crypto.randomUUID();

    /*
     * Deliberate Edge-local POS ID collision.
     *
     * Financial payload must never use this BIGINT as
     * Cloud authority.
     */
    const pretendEdgeLocalPosId =
      900000001;

    await qRun(
      `
      INSERT INTO
        public.pos_orders
      (
        id,
        restaurant_id,
        table_number,
        item_name,
        quantity,
        total_price,
        paid,
        amount_paid,
        remaining_price,
        source,
        created_at
      )
      VALUES
      (
        $1,
        $2,
        'Cloud Existing',
        'Unrelated BIGINT collision row',
        1,
        1,
        0,
        0,
        1,
        'pos',
        NOW()
      )
      `,
      [
        pretendEdgeLocalPosId,
        ridA,
      ]
    );

    const cloudPosMain =
      await createPortablePosRow({
        restaurantId:
          ridA,

        batchId:
          batchMain,

        submissionId:
          submissionMain,

        tableNumber:
          tableMain,

        total:
          12.5,
      });

    assert.notEqual(
      Number(
        cloudPosMain.id
      ),
      pretendEdgeLocalPosId,
      "Test setup failed: Cloud portable row reused pretend Edge BIGINT"
    );

    const payloadMain =
      makePayload({
        restaurantId:
          ridA,

        settlementId:
          settlementMain,

        batchId:
          batchMain,

        submissionId:
          submissionMain,

        tableNumber:
          tableMain,

        tenderAmounts: [
          7.5,
          5,
        ],

        tenderUuids: [
          tenderA,
          tenderB,
        ],

        posRowStates: [
          {
            ...makeOrderRef({
              submissionId:
                submissionMain,

              ordinal:
                1,

              batchId:
                batchMain,
            }),

            paid:
              1,

            amount_paid:
              12.5,

            remaining_price:
              0,
          },
        ],
      });

    const event =
      makeEvent({
        eventId:
          eventMain,

        restaurantId:
          ridA,

        settlementId:
          settlementMain,

        payload:
          payloadMain,
      });


    await t.test(
      "materializes settlement + multi-tender ledger + POS financial state using Cloud-local POS ids",
      async () => {
        const outboxBefore =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.edge_outbox
            WHERE
              restaurant_id =
                $1
              AND event_type =
                $2
            `,
            [
              ridA,
              FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,
            ]
          );

        const res =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
          });

        assert.equal(
          res.status,
          200,
          JSON.stringify(
            res.body
          )
        );

        assert.equal(
          res.body
            ?.acked
            ?.length,
          1,
          JSON.stringify(
            res.body
          )
        );

        assert.equal(
          res.body
            ?.rejected
            ?.length,
          0,
          JSON.stringify(
            res.body
          )
        );

        const inbox =
          await qGet(
            `
            SELECT
              status,
              applied_at
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventMain,
            ]
          );

        assert.equal(
          inbox?.status,
          "applied"
        );

        assert.ok(
          inbox
            ?.applied_at
        );

        const settlement =
          await qGet(
            `
            SELECT
              id,
              restaurant_id,
              table_number,
              batch_id,
              final_amount,
              pos_order_ids,
              pricing_snapshot,
              voucher_id,
              created_by_user_id
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              settlementMain,
            ]
          );

        assert.ok(
          settlement
        );

        assert.equal(
          String(
            settlement.id
          ),
          settlementMain
        );

        assert.equal(
          Number(
            settlement
              .restaurant_id
          ),
          ridA
        );

        assert.equal(
          String(
            settlement.batch_id
          ),
          batchMain
        );

        assert.equal(
          Number(
            settlement.final_amount
          ),
          12.5
        );

        assert.deepEqual(
          settlement
            .pos_order_ids,
          [
            Number(
              cloudPosMain.id
            ),
          ]
        );

        assert.notEqual(
          Number(
            settlement
              .pos_order_ids[0]
          ),
          pretendEdgeLocalPosId
        );

        assert.equal(
          Number(
            settlement
              .pricing_snapshot
              ?.lines
              ?.[0]
              ?.pos_order_id
          ),
          Number(
            cloudPosMain.id
          )
        );

        assert.equal(
          settlement
            .pricing_snapshot
            ?.lines
            ?.[0]
            ?.order_ref,
          undefined
        );

        assert.equal(
          settlement
            .voucher_id,
          null
        );

        assert.equal(
          settlement
            .created_by_user_id,
          null
        );

        const tenders =
          await qAll(
            `
            SELECT
              payment_uuid,
              settlement_id,
              amount,
              method,
              restaurant_id,
              pos_order_ids,

              staff_user_id,
              cashup_session_id,
              ref_payment_id,
              ref_payment_uuid
            FROM
              public.payments
            WHERE
              settlement_id =
                $1::uuid
            ORDER BY
              amount DESC,
              payment_uuid
            `,
            [
              settlementMain,
            ]
          );

        assert.equal(
          tenders.length,
          2
        );

        const actualUuids =
          tenders
            .map(
              (row) =>
                String(
                  row.payment_uuid
                )
            )
            .sort();

        const expectedUuids =
          [
            tenderA,
            tenderB,
          ].sort();

        assert.deepEqual(
          actualUuids,
          expectedUuids
        );

        assert.deepEqual(
          tenders.map(
            (row) =>
              Number(
                row.amount
              )
          ).sort(
            (
              left,
              right
            ) =>
              left -
              right
          ),
          [
            5,
            7.5,
          ]
        );

        for (
          const tender of
            tenders
        ) {
          assert.equal(
            Number(
              tender
                .restaurant_id
            ),
            ridA
          );

          assert.deepEqual(
            tender
              .pos_order_ids,
            [
              Number(
                cloudPosMain.id
              ),
            ]
          );

          assert.equal(
            tender
              .staff_user_id,
            null
          );

          assert.equal(
            tender
              .cashup_session_id,
            null
          );

          assert.equal(
            tender
              .ref_payment_id,
            null
          );

          assert.equal(
            tender
              .ref_payment_uuid,
            null
          );
        }

        const posAfter =
          await qGet(
            `
            SELECT
              paid,
              amount_paid,
              remaining_price
            FROM
              public.pos_orders
            WHERE
              id =
                $1
            `,
            [
              cloudPosMain.id,
            ]
          );

        assert.equal(
          Number(
            posAfter.paid
          ),
          1,
          "Cloud settlement materializer did not copy paid state"
        );

        assert.equal(
          Number(
            posAfter
              .amount_paid
          ),
          12.5,
          "Cloud settlement materializer did not copy amount_paid"
        );

        assert.equal(
          Number(
            posAfter
              .remaining_price
          ),
          0,
          "Cloud settlement materializer did not copy remaining_price"
        );

        const outboxAfter =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.edge_outbox
            WHERE
              restaurant_id =
                $1
              AND event_type =
                $2
            `,
            [
              ridA,
              FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,
            ]
          );

        assert.equal(
          outboxAfter,
          outboxBefore,
          "Cloud financial apply emitted an Edge feedback event"
        );

        console.log(
          "✅ 01 Cloud settlement + portable multi-tender materialization proven"
        );
      }
    );


    /*
     * =====================================================
     * 02 — EXACT REPLAY
     * =====================================================
     */

    await t.test(
      "lost ACK retry is exactly once",
      async () => {
        const settlementBefore =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              settlementMain,
            ]
          );

        const tendersBefore =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payments
            WHERE
              settlement_id =
                $1::uuid
            `,
            [
              settlementMain,
            ]
          );

        const res =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
          });

        assert.equal(
          res.status,
          200
        );

        assert.equal(
          res.body
            ?.acked
            ?.length,
          1
        );

        assert.equal(
          res.body
            ?.acked
            ?.[0]
            ?.duplicate,
          true
        );

        const settlementAfter =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              settlementMain,
            ]
          );

        const tendersAfter =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payments
            WHERE
              settlement_id =
                $1::uuid
            `,
            [
              settlementMain,
            ]
          );

        assert.equal(
          settlementAfter,
          settlementBefore
        );

        assert.equal(
          tendersAfter,
          tendersBefore
        );

        console.log(
          "✅ 02 Financial lost-ACK replay exactly once"
        );
      }
    );


    /*
     * =====================================================
     * 03 — DEPENDENCY BEFORE POS
     * =====================================================
     */

    await t.test(
      "financial event arriving before POS dependency is retryable and not lost",
      async () => {
        const tableNumber =
          "Table FIN 902";

        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const settlementId =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        const payload =
          makePayload({
            restaurantId:
              ridA,

            settlementId,
            batchId,
            submissionId,
            tableNumber,
          });

        const pendingEvent =
          makeEvent({
            eventId,
            restaurantId:
              ridA,
            settlementId,
            payload,
          });

        const first =
          await pushEvent({
            api,
            edge:
              edgeA,
            event:
              pendingEvent,
          });

        assert.equal(
          first.status,
          200,
          JSON.stringify(
            first.body
          )
        );

        assert.equal(
          first.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          first.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_ORDER_DEPENDENCY_MISSING"
        );

        const inboxAfterFailure =
          await qGet(
            `
            SELECT
              status,
              applied_at
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

        /*
         * Apply transaction rolled back its 'applying'
         * transition, while durable receive remains.
         */
        assert.equal(
          inboxAfterFailure
            ?.status,
          "received"
        );

        assert.equal(
          inboxAfterFailure
            ?.applied_at,
          null
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              settlementId,
            ]
          ),
          0
        );

        await createPortablePosRow({
          restaurantId:
            ridA,

          batchId,
          submissionId,
          tableNumber,
          total:
            12.5,
        });

        const retry =
          await pushEvent({
            api,
            edge:
              edgeA,
            event:
              pendingEvent,
          });

        assert.equal(
          retry.status,
          200,
          JSON.stringify(
            retry.body
          )
        );

        assert.equal(
          retry.body
            ?.acked
            ?.length,
          1
        );

        assert.equal(
          retry.body
            ?.rejected
            ?.length,
          0
        );

        const appliedInbox =
          await qGet(
            `
            SELECT
              status,
              applied_at
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

        assert.equal(
          appliedInbox
            ?.status,
          "applied"
        );

        assert.ok(
          appliedInbox
            ?.applied_at
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              settlementId,
            ]
          ),
          1
        );

        console.log(
          "✅ 03 Finance-before-POS retry convergence proven"
        );
      }
    );


    /*
     * =====================================================
     * 04 — WRONG BATCH
     * =====================================================
     */

    await t.test(
      "portable submission + ordinal cannot be rebound to the wrong batch",
      async () => {
        const tableNumber =
          "Table FIN 903";

        const cloudBatch =
          crypto.randomUUID();

        const hostileBatch =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const settlementId =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        await createPortablePosRow({
          restaurantId:
            ridA,

          batchId:
            cloudBatch,

          submissionId,
          tableNumber,
          total:
            12.5,
        });

        const payload =
          makePayload({
            restaurantId:
              ridA,

            settlementId,

            batchId:
              hostileBatch,

            submissionId,
            tableNumber,
          });

        const attack =
          makeEvent({
            eventId,
            restaurantId:
              ridA,
            settlementId,
            payload,
          });

        const res =
          await pushEvent({
            api,
            edge:
              edgeA,
            event:
              attack,
          });

        assert.equal(
          res.status,
          200,
          JSON.stringify(
            res.body
          )
        );

        assert.equal(
          res.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          res.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_ORDER_BATCH_MISMATCH"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              settlementId,
            ]
          ),
          0
        );

        const inbox =
          await qGet(
            `
            SELECT
              status
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

        assert.equal(
          inbox
            ?.status,
          "received"
        );

        console.log(
          "✅ 04 Portable financial batch mismatch blocked"
        );
      }
    );


    /*
     * =====================================================
     * 04B — SETTLEMENT POS STATE COVERAGE
     * =====================================================
     */

    await t.test(
      "settlement POS financial state must exactly cover settlement order refs",
      async () => {
        const tableNumber =
          "Table FIN 903B";

        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        await createPortablePosRow({
          restaurantId:
            ridA,

          batchId,

          submissionId,

          tableNumber,

          total:
            12.5,
        });


        /*
         * Explicit new-format field with zero states.
         *
         * Legacy omission remains allowed, but an explicitly
         * supplied snapshot must cover every settlement row.
         */
        const incompleteSettlementId =
          crypto.randomUUID();

        const incompleteEventId =
          crypto.randomUUID();

        const incompletePayload =
          makePayload({
            restaurantId:
              ridA,

            settlementId:
              incompleteSettlementId,

            batchId,

            submissionId,

            tableNumber,

            posRowStates:
              [],
          });

        assert.equal(
          Object.prototype
            .hasOwnProperty
            .call(
              incompletePayload,
              "pos_row_states"
            ),
          true
        );

        const incompleteEvent =
          makeEvent({
            eventId:
              incompleteEventId,

            restaurantId:
              ridA,

            settlementId:
              incompleteSettlementId,

            payload:
              incompletePayload,
          });

        const incompleteRes =
          await pushEvent({
            api,

            edge:
              edgeA,

            event:
              incompleteEvent,
          });

        assert.equal(
          incompleteRes.status,
          200,
          JSON.stringify(
            incompleteRes.body
          )
        );

        assert.equal(
          incompleteRes.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          incompleteRes.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_POS_ROW_STATE_COUNT_MISMATCH"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              incompleteEventId,
            ]
          ),
          0,
          "Incomplete POS state reached durable Cloud inbox"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              incompleteSettlementId,
            ]
          ),
          0,
          "Incomplete POS state created a settlement"
        );


        /*
         * Same number of rows, but portable identity differs.
         */
        const wrongRefSettlementId =
          crypto.randomUUID();

        const wrongRefEventId =
          crypto.randomUUID();

        const wrongRefPayload =
          makePayload({
            restaurantId:
              ridA,

            settlementId:
              wrongRefSettlementId,

            batchId,

            submissionId,

            tableNumber,

            posRowStates: [
              {
                ...makeOrderRef({
                  submissionId:
                    crypto.randomUUID(),

                  ordinal:
                    1,

                  batchId,
                }),

                paid:
                  1,

                amount_paid:
                  12.5,

                remaining_price:
                  0,
              },
            ],
          });

        const wrongRefEvent =
          makeEvent({
            eventId:
              wrongRefEventId,

            restaurantId:
              ridA,

            settlementId:
              wrongRefSettlementId,

            payload:
              wrongRefPayload,
          });

        const wrongRefRes =
          await pushEvent({
            api,

            edge:
              edgeA,

            event:
              wrongRefEvent,
          });

        assert.equal(
          wrongRefRes.status,
          200,
          JSON.stringify(
            wrongRefRes.body
          )
        );

        assert.equal(
          wrongRefRes.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          wrongRefRes.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_POS_ROW_STATE_REF_MISMATCH"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              wrongRefEventId,
            ]
          ),
          0,
          "Wrong-ref POS state reached durable Cloud inbox"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              wrongRefSettlementId,
            ]
          ),
          0,
          "Wrong-ref POS state created a settlement"
        );

        console.log(
          "✅ 04B Settlement POS financial state coverage fails closed"
        );
      }
    );


    /*
     * =====================================================
     * 05 — TENANT FORGERY BEFORE INBOX
     * =====================================================
     */

    await t.test(
      "payload tenant forgery is rejected before durable inbox acceptance",
      async () => {
        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const settlementId =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        const payload =
          makePayload({
            restaurantId:
              ridB,

            settlementId,
            batchId,
            submissionId,

            tableNumber:
              "Table FIN 904",
          });

        /*
         * Envelope claims authenticated tenant A, payload
         * attempts to inject tenant B.
         */
        const attack =
          makeEvent({
            eventId,
            restaurantId:
              ridA,
            settlementId,
            payload,
          });

        const res =
          await pushEvent({
            api,
            edge:
              edgeA,
            event:
              attack,
          });

        assert.equal(
          res.status,
          200,
          JSON.stringify(
            res.body
          )
        );

        assert.equal(
          res.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          res.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_TENANT_MISMATCH"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          ),
          0
        );

        console.log(
          "✅ 05 Financial payload tenant forgery blocked pre-inbox"
        );
      }
    );


    /*
     * =====================================================
     * 06 — SETTLEMENT UUID COLLISION
     * =====================================================
     */

    await t.test(
      "pre-existing settlement UUID conflicts fail closed",
      async () => {
        const tableNumber =
          "Table FIN 905";

        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const settlementId =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        await createPortablePosRow({
          restaurantId:
            ridA,
          batchId,
          submissionId,
          tableNumber,
          total:
            12.5,
        });

        await insertExistingSettlement({
          restaurantId:
            ridA,
          settlementId,
          tableNumber,
        });

        const payload =
          makePayload({
            restaurantId:
              ridA,
            settlementId,
            batchId,
            submissionId,
            tableNumber,
          });

        const conflict =
          makeEvent({
            eventId,
            restaurantId:
              ridA,
            settlementId,
            payload,
          });

        const res =
          await pushEvent({
            api,
            edge:
              edgeA,
            event:
              conflict,
          });

        assert.equal(
          res.status,
          200,
          JSON.stringify(
            res.body
          )
        );

        assert.equal(
          res.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          res.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_SETTLEMENT_UUID_CONFLICT"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              settlementId,
            ]
          ),
          1
        );

        const inbox =
          await qGet(
            `
            SELECT
              status
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

        assert.equal(
          inbox
            ?.status,
          "received"
        );

        console.log(
          "✅ 06 Settlement UUID collision fails closed"
        );
      }
    );


    /*
     * =====================================================
     * 07 — PAYMENT UUID COLLISION
     * =====================================================
     */

    await t.test(
      "pre-existing tender UUID conflicts fail closed without settlement creation",
      async () => {
        const tableNumber =
          "Table FIN 906";

        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const settlementId =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        const paymentUuid =
          crypto.randomUUID();

        await createPortablePosRow({
          restaurantId:
            ridA,
          batchId,
          submissionId,
          tableNumber,
          total:
            12.5,
        });

        await insertExistingPayment({
          restaurantId:
            ridA,
          paymentUuid,
          tableNumber,
        });

        const payload =
          makePayload({
            restaurantId:
              ridA,
            settlementId,
            batchId,
            submissionId,
            tableNumber,

            tenderAmounts: [
              12.5,
            ],

            tenderUuids: [
              paymentUuid,
            ],
          });

        const conflict =
          makeEvent({
            eventId,
            restaurantId:
              ridA,
            settlementId,
            payload,
          });

        const res =
          await pushEvent({
            api,
            edge:
              edgeA,
            event:
              conflict,
          });

        assert.equal(
          res.status,
          200,
          JSON.stringify(
            res.body
          )
        );

        assert.equal(
          res.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          res.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_PAYMENT_UUID_CONFLICT"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payment_settlements
            WHERE
              id =
                $1::uuid
            `,
            [
              settlementId,
            ]
          ),
          0
        );

        const inbox =
          await qGet(
            `
            SELECT
              status
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          );

        assert.equal(
          inbox
            ?.status,
          "received"
        );

        console.log(
          "✅ 07 Tender payment UUID collision fails closed"
        );
      }
    );


    /*
     * =====================================================
     * 08 — WRONG EDGE INSTALLATION / TENANT
     * =====================================================
     */

    await t.test(
      "another tenant Edge cannot push tenant A financial event",
      async () => {
        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const settlementId =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        const payload =
          makePayload({
            restaurantId:
              ridA,
            settlementId,
            batchId,
            submissionId,

            tableNumber:
              "Table FIN 907",
          });

        const foreignEvent =
          makeEvent({
            eventId,
            restaurantId:
              ridA,
            settlementId,
            payload,
          });

        const res =
          await pushEvent({
            api,
            edge:
              edgeB,
            event:
              foreignEvent,
          });

        assert.equal(
          res.status,
          200,
          JSON.stringify(
            res.body
          )
        );

        assert.equal(
          res.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          res.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_TENANT_MISMATCH"
        );

        assert.equal(
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.edge_inbox
            WHERE
              event_id =
                $1::uuid
            `,
            [
              eventId,
            ]
          ),
          0
        );

        console.log(
          "✅ 08 Cross-tenant Edge financial injection blocked"
        );
      }
    );


    console.log(
      "============================================================"
    );

    console.log(
      "✅ MAKS FINANCIAL SETTLEMENT CLOUD APPLY ATTACK COMPLETE"
    );

    console.log(
      "============================================================"
    );

    await resetTestData();
    await getPool().end();
  }
);
