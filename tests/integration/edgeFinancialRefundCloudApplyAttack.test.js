"use strict";

const assert =
  require(
    "node:assert/strict"
  );

const crypto =
  require(
    "node:crypto"
  );

const express =
  require(
    "express"
  );

const test =
  require(
    "node:test"
  );

const request =
  require(
    "supertest"
  );


const originalRuntimeRole =
  process.env
    .MAKS_RUNTIME_ROLE;

process.env
  .MAKS_RUNTIME_ROLE =
  "cloud";


const {
  qGet,
  qAll,
  qRun,
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

const {
  seedTestData,
} = require(
  "../setup/seedTestData"
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
  FINANCIAL_REFUND_RECORDED_EVENT_TYPE,
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


function makeRefundPayload({
  restaurantId,
  refundUuid,
  originalUuid,
  batchId,
  refundBatchId =
    batchId,
  orderBatchId =
    batchId,
  submissionId,
  ordinal = 1,
  tableNumber,
  amount,
  method = "cash",
  createdAt =
    new Date()
      .toISOString(),
}) {
  return {
    schema_version:
      1,

    restaurant_id:
      restaurantId,

    refund: {
      payment_uuid:
        refundUuid,

      ref_payment_uuid:
        originalUuid,

      amount:
        Number(
          amount
        ),

      method,

      table_number:
        tableNumber,

      batch_id:
        refundBatchId,

      terminal_ref:
        null,

      order_refs: [
        makeOrderRef({
          submissionId,
          ordinal,
          batchId:
            orderBatchId,
        }),
      ],

      source:
        "refund",

      status:
        "completed",

      created_at:
        createdAt,
    },
  };
}


function makeRefundEvent({
  eventId,
  restaurantId,
  refundUuid,
  payload,
}) {
  return {
    event_id:
      eventId,

    restaurant_id:
      restaurantId,

    event_type:
      FINANCIAL_REFUND_RECORDED_EVENT_TYPE,

    entity_type:
      "payment_refund",

    entity_id:
      refundUuid,

    idempotency_key:
      `${FINANCIAL_REFUND_RECORDED_EVENT_TYPE}:${refundUuid}`,

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
  total,
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
      'Cloud refund portable row',
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


async function insertOriginalTender({
  restaurantId,
  paymentUuid,
  tableNumber,
  amount,
  batchId,
  posOrderIds,
}) {
  return qGet(
    `
    INSERT INTO
      public.payments
    (
      table_number,
      amount,
      method,
      created_at,

      restaurant_id,
      batch_id,
      pos_order_ids,

      source,
      status,

      payment_uuid
    )
    VALUES
    (
      $1,
      $2,
      'cash',
      NOW(),

      $3,
      $4::uuid,
      $5::jsonb,

      'pos',
      'completed',

      $6::uuid
    )
    RETURNING
      id,
      restaurant_id,
      amount,
      batch_id,
      pos_order_ids,
      payment_uuid
    `,
    [
      tableNumber,
      amount,
      restaurantId,
      batchId,
      JSON.stringify(
        posOrderIds
      ),
      paymentUuid,
    ]
  );
}


async function insertUuidCollision({
  restaurantId,
  paymentUuid,
  tableNumber,
}) {
  return qGet(
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
    RETURNING
      id,
      payment_uuid
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
  return request(
    api
  )
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


function jsonArray(
  value
) {
  if (
    Array.isArray(
      value
    )
  ) {
    return value;
  }

  if (
    typeof value ===
      "string"
  ) {
    return JSON.parse(
      value
    );
  }

  return [];
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
  "MAKS financial refund Cloud apply attack",
  {
    timeout:
      90000,
  },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();

    t.after(
      async () => {
        try {
          await resetTestData();
        } finally {
          if (
            originalRuntimeRole ==
            null
          ) {
            delete process
              .env
              .MAKS_RUNTIME_ROLE;
          } else {
            process.env
              .MAKS_RUNTIME_ROLE =
              originalRuntimeRole;
          }
        }
      }
    );

    const fixtures =
      await seedTestData();

    const ridA =
      Number(
        fixtures.restaurantA
      );

    const ridB =
      Number(
        fixtures.restaurantB
      );

    const requiredColumns =
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
          AND column_name =
            ANY(
              $1::text[]
            )
        `,
        [
          [
            "payment_uuid",
            "ref_payment_uuid",
            "ref_payment_id",
            "batch_id",
            "pos_order_ids",
            "status",
          ],
        ]
      );

    const columnNames =
      new Set(
        requiredColumns.map(
          (row) =>
            row.column_name
        )
      );

    for (
      const required of
      [
        "payment_uuid",
        "ref_payment_uuid",
        "ref_payment_id",
        "batch_id",
        "pos_order_ids",
        "status",
      ]
    ) {
      assert.ok(
        columnNames.has(
          required
        ),
        `Missing required payments column: ${required}`
      );
    }

    const api =
      express();

    api.use(
      express.json({
        limit:
          "10mb",
      })
    );

    api.use(
      (
        req,
        _res,
        next
      ) => {
        req.qAll =
          qAll;

        req.qGet =
          qGet;

        req.qRun =
          qRun;

        req.kind =
          "pg";

        next();
      }
    );

    api.use(
      "/edge",
      edgeRoutes
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
        "REFUND EDGE A",
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
        "REFUND EDGE B",
        edgeB.secretHash,
      ]
    );


    await t.test(
      "materializes immutable refund using Cloud-local original + POS ids",
      async () => {
        const batchId =
          crypto.randomUUID();

        const refundBatchId =
          crypto.randomUUID();

        assert.notEqual(
          refundBatchId,
          batchId
        );

        const submissionId =
          crypto.randomUUID();

        const originalUuid =
          crypto.randomUUID();

        const refundUuid =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        const tableNumber =
          "Table REF CLOUD 01";

        const pos =
          await createPortablePosRow({
            restaurantId:
              ridA,

            batchId,
            submissionId,
            ordinal:
              1,

            tableNumber,
            total:
              12.5,
          });

        const original =
          await insertOriginalTender({
            restaurantId:
              ridA,

            paymentUuid:
              originalUuid,

            tableNumber,
            amount:
              12.5,

            batchId,

            posOrderIds: [
              Number(
                pos.id
              ),
            ],
          });

        const payload =
          makeRefundPayload({
            restaurantId:
              ridA,

            refundUuid,
            originalUuid,
            batchId,

            refundBatchId,

            orderBatchId:
              batchId,

            submissionId,
            ordinal:
              1,

            tableNumber,
            amount:
              -5,
          });

        const event =
          makeRefundEvent({
            eventId,
            restaurantId:
              ridA,

            refundUuid,
            payload,
          });

        const response =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
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
            ?.acked
            ?.length,
          1,
          JSON.stringify(
            response.body
          )
        );

        assert.equal(
          response.body
            ?.rejected
            ?.length,
          0,
          JSON.stringify(
            response.body
          )
        );

        const refund =
          await qGet(
            `
            SELECT
              id,
              restaurant_id,
              amount,
              source,
              status,
              batch_id,
              pos_order_ids,
              ref_payment_id,
              payment_uuid,
              ref_payment_uuid
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND payment_uuid =
                $2::uuid
            `,
            [
              ridA,
              refundUuid,
            ]
          );

        assert.ok(
          refund
        );

        assert.equal(
          Number(
            refund.amount
          ),
          -5
        );

        assert.equal(
          refund.source,
          "refund"
        );

        assert.equal(
          refund.status,
          "completed"
        );

        assert.equal(
          String(
            refund.batch_id
          ),
          refundBatchId,
          "Cloud refund did not preserve its independent refund batch UUID"
        );

        assert.notEqual(
          String(
            refund.batch_id
          ),
          batchId,
          "Refund batch must not be forced to equal the original order/tender batch"
        );

        assert.equal(
          String(
            refund.payment_uuid
          ),
          refundUuid
        );

        assert.equal(
          String(
            refund.ref_payment_uuid
          ),
          originalUuid
        );

        assert.equal(
          Number(
            refund.ref_payment_id
          ),
          Number(
            original.id
          ),
          "Cloud did not derive local ref_payment_id from original UUID A"
        );

        assert.deepEqual(
          jsonArray(
            refund.pos_order_ids
          ).map(Number),
          [
            Number(
              pos.id
            ),
          ]
        );

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
              restaurant_id = $1
              AND id = $2
            `,
            [
              ridA,
              Number(
                pos.id
              ),
            ]
          );

        assert.equal(
          Number(
            posAfter.paid
          ),
          0
        );

        assert.equal(
          Number(
            posAfter.amount_paid
          ),
          0
        );

        assert.equal(
          Number(
            posAfter.remaining_price
          ),
          12.5
        );

        const feedbackCount =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.edge_outbox
            WHERE
              restaurant_id = $1
              AND event_type =
                $2
            `,
            [
              ridA,
              FINANCIAL_REFUND_RECORDED_EVENT_TYPE,
            ]
          );

        assert.equal(
          feedbackCount,
          0,
          "Cloud refund apply created a feedback Edge outbox event"
        );

        console.log(
          "✅ 01 Cloud refund + local lineage materialization proven"
        );
      }
    );


    await t.test(
      "refund status follows cumulative pence and survives rejection and replay",
      async () => {
        const batchId = crypto.randomUUID();
        const submissionId = crypto.randomUUID();
        const originalUuid = crypto.randomUUID();
        const tableNumber = "Table REF STATUS PENCE";
        const pos = await createPortablePosRow({
          restaurantId: ridA, batchId, submissionId, tableNumber, total: 7.5,
        });
        await insertOriginalTender({
          restaurantId: ridA, paymentUuid: originalUuid, tableNumber,
          amount: 7.5, batchId, posOrderIds: [Number(pos.id)],
        });
        const makeEvent = (amount) => {
          const refundUuid = crypto.randomUUID();
          return makeRefundEvent({
            eventId: crypto.randomUUID(), restaurantId: ridA, refundUuid,
            payload: makeRefundPayload({
              restaurantId: ridA, refundUuid, originalUuid, batchId,
              submissionId, tableNumber, amount,
            }),
          });
        };
        const readLedger = () => qAll(
          `SELECT payment_uuid, status, amount::text AS amount
           FROM public.payments
           WHERE restaurant_id = $1
             AND (payment_uuid = $2::uuid OR ref_payment_uuid = $2::uuid)
           ORDER BY payment_uuid`,
          [ridA, originalUuid]
        );
        const assertOriginal = async (status) => {
          const row = (await readLedger()).find((p) => p.payment_uuid === originalUuid);
          assert.equal(row.status, status);
          assert.equal(Number(row.amount), 7.5, "Original tender amount must stay intact");
        };

        const partial = makeEvent(-7.49);
        const first = await pushEvent({ api, edge: edgeA, event: partial });
        assert.equal(first.body?.acked?.length, 1, JSON.stringify(first.body));
        await assertOriginal("partially_refunded");

        const beforeRejected = await readLedger();
        const excessive = await pushEvent({ api, edge: edgeA, event: makeEvent(-0.02) });
        assert.equal(excessive.body?.acked?.length, 0, JSON.stringify(excessive.body));
        assert.equal(excessive.body?.rejected?.[0]?.code, "EDGE_FINANCIAL_REFUND_AMOUNT_EXCEEDED");
        assert.deepEqual(await readLedger(), beforeRejected);

        const finalPenny = makeEvent(-0.01);
        const final = await pushEvent({ api, edge: edgeA, event: finalPenny });
        assert.equal(final.body?.acked?.length, 1, JSON.stringify(final.body));
        await assertOriginal("refunded");

        const beforeReplay = await readLedger();
        for (const event of [partial, finalPenny]) {
          const replay = await pushEvent({ api, edge: edgeA, event });
          assert.equal(replay.body?.acked?.[0]?.duplicate, true, JSON.stringify(replay.body));
          assert.deepEqual(await readLedger(), beforeReplay);
        }
        assert.equal(beforeReplay.length, 3);
        assert.equal(beforeReplay.reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0), 0);
      }
    );

    await t.test(
      "refund against a voided original rolls back refund and preserves status",
      async () => {
        const batchId = crypto.randomUUID();
        const submissionId = crypto.randomUUID();
        const originalUuid = crypto.randomUUID();
        const refundUuid = crypto.randomUUID();
        const tableNumber = "Table REF STATUS VOID";
        const pos = await createPortablePosRow({
          restaurantId: ridA, batchId, submissionId, tableNumber, total: 5,
        });
        await insertOriginalTender({
          restaurantId: ridA, paymentUuid: originalUuid, tableNumber,
          amount: 5, batchId, posOrderIds: [Number(pos.id)],
        });
        await qRun(
          "UPDATE public.payments SET status = 'voided' WHERE restaurant_id = $1 AND payment_uuid = $2::uuid",
          [ridA, originalUuid]
        );
        const event = makeRefundEvent({
          eventId: crypto.randomUUID(), restaurantId: ridA, refundUuid,
          payload: makeRefundPayload({
            restaurantId: ridA, refundUuid, originalUuid, batchId,
            submissionId, tableNumber, amount: -1,
          }),
        });
        const response = await pushEvent({ api, edge: edgeA, event });
        assert.equal(response.body?.acked?.length, 0, JSON.stringify(response.body));
        assert.equal(response.body?.rejected?.[0]?.code, "EDGE_FINANCIAL_REFUND_ORIGINAL_STATUS_CONFLICT");
        const original = await qGet(
          "SELECT status FROM public.payments WHERE restaurant_id = $1 AND payment_uuid = $2::uuid",
          [ridA, originalUuid]
        );
        assert.equal(original.status, "voided");
        assert.equal(await countRows(
          "SELECT COUNT(*)::int AS count FROM public.payments WHERE restaurant_id = $1 AND payment_uuid = $2::uuid",
          [ridA, refundUuid]
        ), 0);
      }
    );

    await t.test(
      "lost ACK replay is exactly once",
      async () => {
        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const originalUuid =
          crypto.randomUUID();

        const refundUuid =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        const tableNumber =
          "Table REF CLOUD 02";

        const pos =
          await createPortablePosRow({
            restaurantId:
              ridA,

            batchId,
            submissionId,
            tableNumber,
            total:
              8,
          });

        await insertOriginalTender({
          restaurantId:
            ridA,

          paymentUuid:
            originalUuid,

          tableNumber,
          amount:
            8,

          batchId,

          posOrderIds: [
            Number(
              pos.id
            ),
          ],
        });

        const payload =
          makeRefundPayload({
            restaurantId:
              ridA,

            refundUuid,
            originalUuid,
            batchId,
            submissionId,
            tableNumber,
            amount:
              -3,
          });

        const event =
          makeRefundEvent({
            eventId,
            restaurantId:
              ridA,

            refundUuid,
            payload,
          });

        const first =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
          });

        assert.equal(
          first.body
            ?.acked
            ?.length,
          1,
          JSON.stringify(
            first.body
          )
        );

        const second =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
          });

        assert.equal(
          second.body
            ?.acked
            ?.length,
          1,
          JSON.stringify(
            second.body
          )
        );

        assert.equal(
          second.body
            ?.acked
            ?.[0]
            ?.duplicate,
          true
        );

        const count =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND payment_uuid =
                $2::uuid
            `,
            [
              ridA,
              refundUuid,
            ]
          );

        assert.equal(
          count,
          1
        );

        console.log(
          "✅ 02 Refund lost-ACK replay exactly once"
        );
      }
    );


    await t.test(
      "refund before original tender dependency is retryable",
      async () => {
        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const originalUuid =
          crypto.randomUUID();

        const refundUuid =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        const tableNumber =
          "Table REF CLOUD 03";

        const pos =
          await createPortablePosRow({
            restaurantId:
              ridA,

            batchId,
            submissionId,
            tableNumber,
            total:
              10,
          });

        const payload =
          makeRefundPayload({
            restaurantId:
              ridA,

            refundUuid,
            originalUuid,
            batchId,
            submissionId,
            tableNumber,
            amount:
              -4,
          });

        const event =
          makeRefundEvent({
            eventId,
            restaurantId:
              ridA,

            refundUuid,
            payload,
          });

        const missing =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
          });

        assert.equal(
          missing.body
            ?.acked
            ?.length,
          0,
          JSON.stringify(
            missing.body
          )
        );

        assert.equal(
          missing.body
            ?.rejected
            ?.length,
          1,
          JSON.stringify(
            missing.body
          )
        );

        assert.equal(
          missing.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_REFUND_ORIGINAL_DEPENDENCY_MISSING"
        );

        const inboxBefore =
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

        assert.ok(
          [
            "received",
            "failed",
          ].includes(
            String(
              inboxBefore
                ?.status ||
              ""
            )
          )
        );

        await insertOriginalTender({
          restaurantId:
            ridA,

          paymentUuid:
            originalUuid,

          tableNumber,
          amount:
            10,

          batchId,

          posOrderIds: [
            Number(
              pos.id
            ),
          ],
        });

        const recovered =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
          });

        assert.equal(
          recovered.body
            ?.acked
            ?.length,
          1,
          JSON.stringify(
            recovered.body
          )
        );

        assert.equal(
          recovered.body
            ?.rejected
            ?.length,
          0,
          JSON.stringify(
            recovered.body
          )
        );

        const count =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND payment_uuid =
                $2::uuid
            `,
            [
              ridA,
              refundUuid,
            ]
          );

        assert.equal(
          count,
          1
        );

        console.log(
          "✅ 03 Refund-before-original retry convergence proven"
        );
      }
    );


    await t.test(
      "concurrent partial refunds cannot exceed original tender",
      async () => {
        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const originalUuid =
          crypto.randomUUID();

        const tableNumber =
          "Table REF CLOUD 04";

        const pos =
          await createPortablePosRow({
            restaurantId:
              ridA,

            batchId,
            submissionId,
            tableNumber,
            total:
              10,
          });

        await insertOriginalTender({
          restaurantId:
            ridA,

          paymentUuid:
            originalUuid,

          tableNumber,
          amount:
            10,

          batchId,

          posOrderIds: [
            Number(
              pos.id
            ),
          ],
        });

        const refundUuidA =
          crypto.randomUUID();

        const refundUuidB =
          crypto.randomUUID();

        const eventA =
          makeRefundEvent({
            eventId:
              crypto.randomUUID(),

            restaurantId:
              ridA,

            refundUuid:
              refundUuidA,

            payload:
              makeRefundPayload({
                restaurantId:
                  ridA,

                refundUuid:
                  refundUuidA,

                originalUuid,
                batchId,
                submissionId,
                tableNumber,
                amount:
                  -6,
              }),
          });

        const eventB =
          makeRefundEvent({
            eventId:
              crypto.randomUUID(),

            restaurantId:
              ridA,

            refundUuid:
              refundUuidB,

            payload:
              makeRefundPayload({
                restaurantId:
                  ridA,

                refundUuid:
                  refundUuidB,

                originalUuid,
                batchId,
                submissionId,
                tableNumber,
                amount:
                  -6,
              }),
          });

        const [
          responseA,
          responseB,
        ] =
          await Promise.all([
            pushEvent({
              api,
              edge:
                edgeA,
              event:
                eventA,
            }),

            pushEvent({
              api,
              edge:
                edgeA,
              event:
                eventB,
            }),
          ]);

        const responses = [
          responseA,
          responseB,
        ];

        const acked =
          responses.reduce(
            (
              total,
              response
            ) =>
              total +
              Number(
                response.body
                  ?.acked
                  ?.length ||
                0
              ),
            0
          );

        const rejected =
          responses.reduce(
            (
              total,
              response
            ) =>
              total +
              Number(
                response.body
                  ?.rejected
                  ?.length ||
                0
              ),
            0
          );

        assert.equal(
          acked,
          1,
          responses
            .map(
              (r) =>
                JSON.stringify(
                  r.body
                )
            )
            .join("\n")
        );

        assert.equal(
          rejected,
          1
        );

        const rejectedCodes =
          responses
            .flatMap(
              (response) =>
                response.body
                  ?.rejected ||
                []
            )
            .map(
              (row) =>
                row.code
            );

        assert.deepEqual(
          rejectedCodes,
          [
            "EDGE_FINANCIAL_REFUND_AMOUNT_EXCEEDED",
          ]
        );

        const rows =
          await qAll(
            `
            SELECT
              amount,
              payment_uuid
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND ref_payment_uuid =
                $2::uuid
            ORDER BY
              id ASC
            `,
            [
              ridA,
              originalUuid,
            ]
          );

        assert.equal(
          rows.length,
          1
        );

        assert.equal(
          Number(
            rows[0].amount
          ),
          -6
        );

        console.log(
          "✅ 04 Concurrent refund aggregate protection proven"
        );
      }
    );


    await t.test(
      "refund cannot point a valid original tender at unrelated Cloud POS rows",
      async () => {
        const originalBatchId =
          crypto.randomUUID();

        const originalSubmission =
          crypto.randomUUID();

        const originalUuid =
          crypto.randomUUID();

        const tableNumber =
          "Table REF CLOUD 05";

        const originalPos =
          await createPortablePosRow({
            restaurantId:
              ridA,

            batchId:
              originalBatchId,

            submissionId:
              originalSubmission,

            tableNumber,
            total:
              9,
          });

        await insertOriginalTender({
          restaurantId:
            ridA,

          paymentUuid:
            originalUuid,

          tableNumber,
          amount:
            9,

          batchId:
            originalBatchId,

          posOrderIds: [
            Number(
              originalPos.id
            ),
          ],
        });

        /*
         * Same batch, different portable POS identity.
         * Resolver succeeds, lineage subset check must fail.
         */
        const forgedSubmission =
          crypto.randomUUID();

        const forgedPos =
          await qGet(
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
              'Forged refund target',
              1,
              2,

              0,
              0,
              2,

              'pos',
              $3::uuid,
              $4::uuid,
              1,
              NOW()
            )
            RETURNING
              id
            `,
            [
              ridA,
              tableNumber,
              originalBatchId,
              forgedSubmission,
            ]
          );

        assert.ok(
          Number(
            forgedPos.id
          ) !==
          Number(
            originalPos.id
          )
        );

        const refundUuid =
          crypto.randomUUID();

        const event =
          makeRefundEvent({
            eventId:
              crypto.randomUUID(),

            restaurantId:
              ridA,

            refundUuid,

            payload:
              makeRefundPayload({
                restaurantId:
                  ridA,

                refundUuid,
                originalUuid,

                batchId:
                  originalBatchId,

                submissionId:
                  forgedSubmission,

                tableNumber,
                amount:
                  -2,
              }),
          });

        const response =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
          });

        assert.equal(
          response.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          response.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_REFUND_ORDER_LINEAGE_MISMATCH"
        );

        const count =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND payment_uuid =
                $2::uuid
            `,
            [
              ridA,
              refundUuid,
            ]
          );

        assert.equal(
          count,
          0
        );

        console.log(
          "✅ 05 Forged refund POS lineage blocked"
        );
      }
    );


    await t.test(
      "pre-existing refund payment UUID conflicts fail closed",
      async () => {
        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const originalUuid =
          crypto.randomUUID();

        const refundUuid =
          crypto.randomUUID();

        const tableNumber =
          "Table REF CLOUD 06";

        const pos =
          await createPortablePosRow({
            restaurantId:
              ridA,

            batchId,
            submissionId,
            tableNumber,
            total:
              7,
          });

        await insertOriginalTender({
          restaurantId:
            ridA,

          paymentUuid:
            originalUuid,

          tableNumber,
          amount:
            7,

          batchId,

          posOrderIds: [
            Number(
              pos.id
            ),
          ],
        });

        await insertUuidCollision({
          restaurantId:
            ridA,

          paymentUuid:
            refundUuid,

          tableNumber:
            "UNRELATED COLLISION",
        });

        const event =
          makeRefundEvent({
            eventId:
              crypto.randomUUID(),

            restaurantId:
              ridA,

            refundUuid,

            payload:
              makeRefundPayload({
                restaurantId:
                  ridA,

                refundUuid,
                originalUuid,
                batchId,
                submissionId,
                tableNumber,
                amount:
                  -2,
              }),
          });

        const response =
          await pushEvent({
            api,
            edge:
              edgeA,
            event,
          });

        assert.equal(
          response.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          response.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_FINANCIAL_REFUND_PAYMENT_UUID_CONFLICT"
        );

        const refundRows =
          await countRows(
            `
            SELECT
              COUNT(*)::int
                AS count
            FROM
              public.payments
            WHERE
              restaurant_id = $1
              AND payment_uuid =
                $2::uuid
              AND source =
                'refund'
            `,
            [
              ridA,
              refundUuid,
            ]
          );

        assert.equal(
          refundRows,
          0
        );

        console.log(
          "✅ 06 Refund UUID collision fails closed"
        );
      }
    );


    await t.test(
      "another tenant Edge cannot push tenant A refund event",
      async () => {
        const refundUuid =
          crypto.randomUUID();

        const originalUuid =
          crypto.randomUUID();

        const batchId =
          crypto.randomUUID();

        const submissionId =
          crypto.randomUUID();

        const eventId =
          crypto.randomUUID();

        const payload =
          makeRefundPayload({
            restaurantId:
              ridA,

            refundUuid,
            originalUuid,
            batchId,
            submissionId,

            tableNumber:
              "Table REF CLOUD 07",

            amount:
              -1,
          });

        const event =
          makeRefundEvent({
            eventId,
            restaurantId:
              ridA,

            refundUuid,
            payload,
          });

        const response =
          await pushEvent({
            api,
            edge:
              edgeB,
            event,
          });

        assert.equal(
          response.body
            ?.acked
            ?.length,
          0
        );

        assert.equal(
          response.body
            ?.rejected
            ?.length,
          1
        );

        assert.equal(
          response.body
            ?.rejected
            ?.[0]
            ?.code,
          "EDGE_TENANT_MISMATCH"
        );

        const inboxCount =
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
          );

        assert.equal(
          inboxCount,
          0,
          "Tenant-forged refund was durably accepted before validation"
        );

        console.log(
          "✅ 07 Cross-tenant Edge refund injection blocked"
        );
      }
    );


    console.log(
      "============================================================"
    );

    console.log(
      "✅ MAKS FINANCIAL REFUND CLOUD APPLY ATTACK COMPLETE"
    );

    console.log(
      "============================================================"
    );
  }
);
