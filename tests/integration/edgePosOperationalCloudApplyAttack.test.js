"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const test = require("node:test");
const request = require("supertest");

process.env.MAKS_RUNTIME_ROLE = "cloud";

const {
  qGet,
  qAll,
  qRun,
  getPool,
} = require("../../dbCompat");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

const {
  resetTestData,
} = require("../setup/resetTestData");

const edgeRoutes = require("../../routes/edgeRoutes");

const {
  generateEdgeCredentials,
} = require("../../utils/edgeAuth");

const {
  hashJson,
} = require("../../edge/syncStore");

function edgeHeaders(installationId, secret) {
  return {
    "x-edge-installation-id": installationId,
    "x-edge-secret": secret,
  };
}

function makePayload({
  restaurantId,
  batchId,
  submissionId,
  edgePosId,
}) {
  const createdAt = new Date().toISOString();

  return {
    schema_version: 2,
    restaurant_id: restaurantId,
    batch_id: batchId,
    submission_id: submissionId,
    pos_order_ids: [edgePosId],
    order_type: "takeaway",
    source: "pos",
    table_number: "Takeaway",
    pickup_number: 41,
    append_to_existing_batch: false,
    hold_until_paid: false,
    pricing: {
      subtotal: 12.5,
      pricing_discount: 0,
      total: 12.5,
      applied_rules: [],
    },
    batch: {
      id: batchId,
      restaurant_id: restaurantId,
      table_number: "Takeaway",
      order_type: "takeaway",
      pickup_number: 41,
      requested_payment_method: null,
      delivery_status: null,
      delivery_code: null,
      created_at: createdAt,
    },
    pos_rows: [
      {
        id: edgePosId,
        restaurant_id: restaurantId,
        table_number: "Takeaway",
        meal_id: "1",
        menu_item_id: null,
        stock_id: null,
        item_name: "Offline Burger",
        quantity: 1,
        total_price: 12.5,
        vat_rate: 20,
        vat_gross: 12.5,
        vat_net: 10.42,
        vat_amount: 2.08,
        item_type: "meal",
        order_status: "open",
        paid: 0,
        options: { raw: {}, display: {} },
        note: null,
        batch_id: batchId,
        created_at: createdAt,
        category_id: null,
        is_starred: false,
        is_priority: false,
        table_allergy_codes: [],
        item_allergen_contains: [],
        allergen_conflicts: [],
        strict_cross_contamination: false,
        table_covers: 1,
        amount_paid: 0,
        remaining_price: 12.5,
        source: "pos",
        expires_at: null,
        edge_submission_id: submissionId,
        edge_row_ordinal: 1,
      },
    ],
    kds_rows: [
      {
        id: 700000001,
        restaurant_id: restaurantId,
        table_number: "Takeaway",
        items: [],
        total_price: 12.5,
        paid: false,
        created_at: createdAt,
        options: {},
        note: null,
        special_requests: null,
        payment_method: null,
        paid_at: null,
        order_type: "takeaway",
        meal_name: "Offline Burger",
        category: "meals",
        station: null,
        quantity: 1,
        order_status: "pending",
        batch_id: batchId,
        price_per_unit: 12.5,
        category_id: null,
        is_priority: false,
      },
    ],
  };
}

function makeEvent({
  eventId,
  restaurantId,
  batchId,
  payload,
}) {
  return {
    event_id: eventId,
    restaurant_id: restaurantId,
    event_type: "pos.order.submitted",
    entity_type: "order_batch",
    entity_id: batchId,
    idempotency_key:
      `pos.order.submitted:${payload.submission_id}`,
    payload,
    payload_hash: hashJson(payload),
    created_at: new Date().toISOString(),
  };
}

test(
  "MAKS Edge POS operational Cloud apply attack",
  { timeout: 60000 },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();

    const identityColumns = await qAll(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pos_orders'
        AND column_name IN (
          'edge_submission_id',
          'edge_row_ordinal'
        )
      ORDER BY column_name
      `
    );

    assert.deepEqual(
      identityColumns.map((row) => row.column_name),
      ["edge_row_ordinal", "edge_submission_id"],
      "Run the exact POS operational identity migration against maks_test first"
    );

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use((req, _res, next) => {
      req.qGet = qGet;
      req.qAll = qAll;
      req.qRun = qRun;
      req.kind = "pg";
      next();
    });
    app.use("/edge", edgeRoutes);

    const api = request(app);
    const token = crypto.randomBytes(8).toString("hex");

    const a = await qGet(
      `INSERT INTO public.restaurants (name) VALUES ($1) RETURNING id`,
      [`POS APPLY A ${token}`]
    );
    const b = await qGet(
      `INSERT INTO public.restaurants (name) VALUES ($1) RETURNING id`,
      [`POS APPLY B ${token}`]
    );

    const ridA = Number(a.id);
    const ridB = Number(b.id);

    const edgeA = generateEdgeCredentials();
    const edgeB = generateEdgeCredentials();

    await qRun(
      `
      INSERT INTO public.restaurant_edge_nodes (
        restaurant_id,
        installation_id,
        edge_name,
        secret_hash,
        is_active
      )
      VALUES
        ($1,$2::uuid,$3,$4,TRUE),
        ($5,$6::uuid,$7,$8,TRUE)
      `,
      [
        ridA,
        edgeA.installationId,
        `POS EDGE A ${token}`,
        edgeA.secretHash,
        ridB,
        edgeB.installationId,
        `POS EDGE B ${token}`,
        edgeB.secretHash,
      ]
    );

    const batchId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const collidingEdgePosId = 900000001;

    await qRun(
      `
      INSERT INTO public.pos_orders (
        id,
        restaurant_id,
        table_number,
        item_name,
        quantity,
        total_price,
        paid,
        remaining_price,
        source
      )
      VALUES ($1,$2,'Cloud Existing','UNRELATED CLOUD ROW',1,1,0,1,'pos')
      `,
      [collidingEdgePosId, ridA]
    );

    const payload = makePayload({
      restaurantId: ridA,
      batchId,
      submissionId,
      edgePosId: collidingEdgePosId,
    });

    const event = makeEvent({
      eventId,
      restaurantId: ridA,
      batchId,
      payload,
    });

    await t.test(
      "materializes batch + POS + KDS without reusing Edge bigint ids",
      async () => {
        const res = await api
          .post("/edge/sync/push")
          .set(edgeHeaders(edgeA.installationId, edgeA.secret))
          .send({ events: [event] });

        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body?.acked?.length, 1, JSON.stringify(res.body));
        assert.equal(res.body?.rejected?.length, 0, JSON.stringify(res.body));

        const inbox = await qGet(
          `
          SELECT status, applied_at
          FROM public.edge_inbox
          WHERE event_id = $1::uuid
          `,
          [eventId]
        );
        assert.equal(inbox?.status, "applied");
        assert.ok(inbox?.applied_at);

        const batch = await qGet(
          `
          SELECT restaurant_id, order_type, pickup_number
          FROM public.order_batches
          WHERE id = $1::uuid
          `,
          [batchId]
        );
        assert.equal(Number(batch?.restaurant_id), ridA);
        assert.equal(batch?.order_type, "takeaway");
        assert.equal(Number(batch?.pickup_number), 41);

        const rows = await qAll(
          `
          SELECT
            id,
            item_name,
            total_price,
            edge_submission_id,
            edge_row_ordinal
          FROM public.pos_orders
          WHERE restaurant_id = $1
            AND batch_id = $2::uuid
          ORDER BY edge_row_ordinal
          `,
          [ridA, batchId]
        );

        assert.equal(rows.length, 1);
        assert.notEqual(
          Number(rows[0].id),
          collidingEdgePosId,
          "Cloud reused Edge-local BIGSERIAL id"
        );
        assert.equal(String(rows[0].edge_submission_id), submissionId);
        assert.equal(Number(rows[0].edge_row_ordinal), 1);
        assert.equal(Number(rows[0].total_price), 12.5);

        const kds = await qAll(
          `
          SELECT meal_name, quantity, total_price
          FROM public.orders
          WHERE restaurant_id = $1
            AND batch_id = $2::uuid
          `,
          [ridA, batchId]
        );
        assert.equal(kds.length, 1);
        assert.equal(kds[0].meal_name, "Offline Burger");

        console.log(
          "✅ 01 Cloud batch + POS + KDS materialization proven"
        );
      }
    );

    await t.test("lost ACK retry is exactly once", async () => {
      const beforePos = await qGet(
        `
        SELECT COUNT(*)::int AS count
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [ridA, batchId]
      );
      const beforeKds = await qGet(
        `
        SELECT COUNT(*)::int AS count
        FROM public.orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [ridA, batchId]
      );

      const res = await api
        .post("/edge/sync/push")
        .set(edgeHeaders(edgeA.installationId, edgeA.secret))
        .send({ events: [event] });

      assert.equal(res.status, 200);
      assert.equal(res.body?.acked?.length, 1);
      assert.equal(res.body?.acked?.[0]?.duplicate, true);

      const afterPos = await qGet(
        `
        SELECT COUNT(*)::int AS count
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [ridA, batchId]
      );
      const afterKds = await qGet(
        `
        SELECT COUNT(*)::int AS count
        FROM public.orders
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [ridA, batchId]
      );

      assert.equal(Number(afterPos.count), Number(beforePos.count));
      assert.equal(Number(afterKds.count), Number(beforeKds.count));

      console.log("✅ 02 Lost-ACK retry exactly-once proven");
    });

    await t.test(
      "same logical submission under a new event id fails closed",
      async () => {
        const replay = makeEvent({
          eventId: crypto.randomUUID(),
          restaurantId: ridA,
          batchId,
          payload,
        });

        const res = await api
          .post("/edge/sync/push")
          .set(edgeHeaders(edgeA.installationId, edgeA.secret))
          .send({ events: [replay] });

        assert.equal(res.status, 200);
        assert.equal(res.body?.acked?.length, 0);
        assert.equal(
          res.body?.rejected?.[0]?.code,
          "EDGE_POS_SUBMISSION_CONFLICT"
        );

        const rows = await qGet(
          `
          SELECT COUNT(*)::int AS count
          FROM public.pos_orders
          WHERE restaurant_id = $1
            AND edge_submission_id = $2::uuid
          `,
          [ridA, submissionId]
        );
        assert.equal(Number(rows.count), 1);

        console.log("✅ 03 Duplicate logical submission blocked");
      }
    );

    await t.test(
      "Restaurant B cannot inject Restaurant A POS operation",
      async () => {
        const foreignBatch = crypto.randomUUID();
        const foreignSubmission = crypto.randomUUID();
        const foreignPayload = makePayload({
          restaurantId: ridA,
          batchId: foreignBatch,
          submissionId: foreignSubmission,
          edgePosId: 900000002,
        });
        const attack = makeEvent({
          eventId: crypto.randomUUID(),
          restaurantId: ridA,
          batchId: foreignBatch,
          payload: foreignPayload,
        });

        const res = await api
          .post("/edge/sync/push")
          .set(edgeHeaders(edgeB.installationId, edgeB.secret))
          .send({ events: [attack] });

        assert.equal(res.status, 200);
        assert.equal(res.body?.acked?.length, 0);
        assert.equal(
          res.body?.rejected?.[0]?.code,
          "EDGE_TENANT_MISMATCH"
        );

        console.log("✅ 04 Cross-tenant POS injection blocked");
      }
    );

    await t.test(
      "schema v1 POS event is rejected before Cloud inbox acceptance",
      async () => {
        const legacyBatch = crypto.randomUUID();
        const legacySubmission = crypto.randomUUID();
        const legacyPayload = makePayload({
          restaurantId: ridA,
          batchId: legacyBatch,
          submissionId: legacySubmission,
          edgePosId: 900000003,
        });
        legacyPayload.schema_version = 1;

        const legacy = makeEvent({
          eventId: crypto.randomUUID(),
          restaurantId: ridA,
          batchId: legacyBatch,
          payload: legacyPayload,
        });

        const res = await api
          .post("/edge/sync/push")
          .set(edgeHeaders(edgeA.installationId, edgeA.secret))
          .send({ events: [legacy] });

        assert.equal(res.status, 200);
        assert.equal(res.body?.acked?.length, 0);
        assert.equal(
          res.body?.rejected?.[0]?.code,
          "EDGE_POS_SCHEMA_UNSUPPORTED"
        );

        const leaked = await qGet(
          `
          SELECT COUNT(*)::int AS count
          FROM public.edge_inbox
          WHERE event_id = $1::uuid
          `,
          [legacy.event_id]
        );
        assert.equal(Number(leaked.count), 0);

        console.log("✅ 05 Legacy POS schema rejected before inbox");
      }
    );

    await t.test(
      "tampered batch identity fails before Cloud mutation",
      async () => {
        const badBatch = crypto.randomUUID();
        const badSubmission = crypto.randomUUID();
        const badPayload = makePayload({
          restaurantId: ridA,
          batchId: badBatch,
          submissionId: badSubmission,
          edgePosId: 900000004,
        });
        badPayload.batch.id = crypto.randomUUID();

        const bad = makeEvent({
          eventId: crypto.randomUUID(),
          restaurantId: ridA,
          batchId: badBatch,
          payload: badPayload,
        });

        const res = await api
          .post("/edge/sync/push")
          .set(edgeHeaders(edgeA.installationId, edgeA.secret))
          .send({ events: [bad] });

        assert.equal(res.status, 200);
        assert.equal(res.body?.acked?.length, 0);
        assert.equal(
          res.body?.rejected?.[0]?.code,
          "EDGE_POS_BATCH_MISMATCH"
        );

        const batch = await qGet(
          `
          SELECT COUNT(*)::int AS count
          FROM public.order_batches
          WHERE id = $1::uuid
          `,
          [badBatch]
        );
        assert.equal(Number(batch.count), 0);

        console.log("✅ 06 Tampered POS batch identity blocked");
      }
    );

    console.log("==============================================");
    console.log("✅ MAKS POS OPERATIONAL CLOUD APPLY ATTACK COMPLETE");
    console.log("==============================================");

    await resetTestData();
    await getPool().end();
  }
);
