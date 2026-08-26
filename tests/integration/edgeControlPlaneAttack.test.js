"use strict";

const {
  test,
  after,
} = require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("crypto");

const bcrypt =
  require("bcryptjs");

const express =
  require("express");

const request =
  require("supertest");

const jwt =
  require("jsonwebtoken");

const {
  SECRET_KEY,
} = require(
  "../../utils/constants"
);

const {
  qGet,
  qAll,
  qRun,
  getPool,
} = require(
  "../../dbCompat"
);

const edgeRoutes =
  require(
    "../../routes/edgeRoutes"
  );

const ccEdgeRoutes =
  require(
    "../../routes/cc/ccEdgeRoutes"
  );

const app =
  express();

app.use(
  express.json({
    limit: "1mb",
  })
);

/*
 * Focused real-route harness.
 *
 * We deliberately do not require server.js here.
 * That keeps unrelated startup jobs/routes out of
 * this focused Edge attack while still exercising:
 *
 * - real PostgreSQL
 * - real Edge routes
 * - real CC Edge routes
 * - real requirePlatformAdmin
 * - real withTx
 */
app.use(
  (req, _res, next) => {
    req.qGet = qGet;
    req.qAll = qAll;
    req.qRun = qRun;
    req.kind = "pg";

    next();
  }
);

app.use(
  "/edge",
  edgeRoutes
);

app.use(
  "/cc/edge",
  ccEdgeRoutes
);

const http =
  request(app);

let passCount = 0;

let fixtureAdminId =
  null;

let fixtureRestaurantId =
  null;

const createdEdgeIds =
  [];

const runId =
  crypto
    .randomUUID()
    .slice(0, 8);

const edgePrefix =
  `MAKS Edge Attack ${runId}`;

function pass(message) {
  passCount += 1;

  console.log(
    `✅ ${String(
      passCount
    ).padStart(2, "0")} ${message}`
  );
}

function ccAuth(token) {
  return {
    Authorization:
      `Bearer ${token}`,
  };
}

function heartbeat(
  installationId,
  secret,
  overrides = {}
) {
  return http
    .post(
      "/edge/heartbeat"
    )
    .set(
      "x-edge-installation-id",
      installationId
    )
    .set(
      "x-edge-secret",
      secret
    )
    .send({
      version:
        "1.0.0-test",

      local_db_status:
        "healthy",

      local_db_latency_ms:
        4,

      cloud_latency_ms:
        12,

      sync_status:
        "synced",

      pending_sync_events:
        0,

      last_sync_at:
        new Date()
          .toISOString(),

      uptime_seconds:
        3600,

      disk_free_mb:
        50000,

      ...overrides,
    });
}

async function cleanup() {
  if (
    fixtureAdminId
  ) {
    await qRun(
      `
      DELETE FROM
        public.platform_admin_audit
      WHERE
        admin_user_id = $1
      `,
      [
        fixtureAdminId,
      ]
    );
  }

  if (
    createdEdgeIds.length
  ) {
    await qRun(
      `
      DELETE FROM
        public.restaurant_edge_nodes
      WHERE
        id =
          ANY($1::bigint[])
      `,
      [
        createdEdgeIds,
      ]
    );
  }

  /*
   * Safety net for a row created after a successful
   * INSERT but before its id was recorded locally.
   *
   * This only targets this unique Attack run.
   */
  if (
    fixtureRestaurantId
  ) {
    await qRun(
      `
      DELETE FROM
        public.restaurant_edge_nodes
      WHERE
        restaurant_id = $1
        AND edge_name LIKE $2
      `,
      [
        fixtureRestaurantId,
        `${edgePrefix}%`,
      ]
    );
  }

  if (
    fixtureAdminId
  ) {
    await qRun(
      `
      DELETE FROM
        public.platform_admin_users
      WHERE
        id = $1
      `,
      [
        fixtureAdminId,
      ]
    );
  }
}

after(
  async () => {
    await getPool().end();
  }
);

test(
  "MAKS Edge control plane attack",
  async () => {
    let adminToken;

    try {
      console.log(
        "\n=== MAKS EDGE CONTROL-PLANE ATTACK ==="
      );

      /*
       * 01 DATABASE GUARD
       */
      const db =
        await qGet(`
          SELECT
            current_database()
              AS db
        `);

      assert.equal(
        db?.db,
        "maks_test",
        "REFUSED: expected maks_test"
      );

      pass(
        "Database guard: maks_test"
      );

      /*
       * 02 TEMPORARY CC BOSS FIXTURE
       */
      const passwordHash =
        await bcrypt.hash(
          crypto.randomUUID(),
          10
        );

      const admin =
        await qGet(
          `
          INSERT INTO
            public.platform_admin_users
            (
              email,
              password_hash,
              full_name,
              role,
              is_active,
              created_at
            )

          VALUES
            (
              $1,
              $2,
              'Edge Attack Boss',
              'boss',
              TRUE,
              NOW()
            )

          RETURNING
            id,
            email,
            role
          `,
          [
            `edge-attack-${runId}@maks.test`,
            passwordHash,
          ]
        );

      assert.ok(
        admin?.id
      );

      fixtureAdminId =
        Number(admin.id);

      adminToken =
        jwt.sign(
          {
            kind:
              "platform_admin",

            id:
              fixtureAdminId,

            role:
              "boss",
          },
          SECRET_KEY,
          {
            expiresIn:
              "10m",
          }
        );

      pass(
        "Temporary platform boss fixture created"
      );

      /*
       * 03 SAFE EXISTING RESTAURANT
       */
      const restaurant =
        await qGet(`
          SELECT
            r.id,
            r.name

          FROM
            public.restaurants r

          WHERE
            NOT EXISTS (
              SELECT 1

              FROM
                public.restaurant_edge_nodes e

              WHERE
                e.restaurant_id =
                  r.id
            )

          ORDER BY
            r.id

          LIMIT 1
        `);

      assert.ok(
        restaurant?.id,
        "No restaurant without an existing Edge is available in maks_test"
      );

      fixtureRestaurantId =
        Number(
          restaurant.id
        );

      pass(
        "Safe restaurant selected"
      );

      /*
       * 04 CC AUTH REQUIRED
       */
      let res =
        await http.get(
          "/cc/edge"
        );

      assert.equal(
        res.status,
        401
      );

      pass(
        "CC Edge inventory rejects unauthenticated access"
      );

      /*
       * 05 MALFORMED UUID
       */
      res =
        await http
          .post(
            "/edge/heartbeat"
          )
          .set(
            "x-edge-installation-id",
            "not-a-valid-uuid"
          )
          .set(
            "x-edge-secret",
            "wrong"
          )
          .send({});

      assert.equal(
        res.status,
        401
      );

      assert.equal(
        res.body?.code,
        "EDGE_AUTH_INVALID"
      );

      pass(
        "Malformed Edge identity rejected cleanly"
      );

      /*
       * 06 PROVISION EDGE A
       */
      res =
        await http
          .post(
            `/cc/edge/restaurants/${fixtureRestaurantId}/provision`
          )
          .set(
            ccAuth(
              adminToken
            )
          )
          .send({
            edge_name:
              `${edgePrefix} A`,
          });

      assert.equal(
        res.status,
        201,
        JSON.stringify(
          res.body
        )
      );

      const edgeA =
        res.body?.edge;

      const secretA =
        res.body
          ?.credentials
          ?.secret;

      assert.ok(
        edgeA?.id
      );

      assert.ok(
        edgeA
          ?.installation_id
      );

      assert.ok(
        secretA
      );

      createdEdgeIds.push(
        Number(edgeA.id)
      );

      pass(
        "Edge A provisioned"
      );

      /*
       * 07 SECRET HASH
       */
      const storedA =
        await qGet(
          `
          SELECT
            restaurant_id,
            secret_hash,
            is_active

          FROM
            public.restaurant_edge_nodes

          WHERE
            id = $1
          `,
          [
            Number(
              edgeA.id
            ),
          ]
        );

      assert.equal(
        Number(
          storedA
            .restaurant_id
        ),
        fixtureRestaurantId
      );

      assert.equal(
        storedA.is_active,
        true
      );

      assert.match(
        storedA.secret_hash,
        /^[0-9a-f]{64}$/
      );

      assert.notEqual(
        storedA.secret_hash,
        secretA
      );

      pass(
        "Edge secret stored only as hash"
      );

      /*
       * 08 WAITING BEFORE HEARTBEAT
       */
      res =
        await http
          .get(
            `/cc/edge/restaurants/${fixtureRestaurantId}`
          )
          .set(
            ccAuth(
              adminToken
            )
          );

      assert.equal(
        res.status,
        200
      );

      let edgeView =
        res.body.edges.find(
          (edge) =>
            Number(
              edge.id
            ) ===
            Number(
              edgeA.id
            )
        );

      assert.equal(
        edgeView
          .health_status,
        "waiting"
      );

      pass(
        "Provisioned Edge waits for first heartbeat"
      );

      /*
       * 09 WRONG SECRET
       */
      res =
        await heartbeat(
          edgeA
            .installation_id,
          "wrong-secret"
        );

      assert.equal(
        res.status,
        401
      );

      assert.equal(
        res.body?.code,
        "EDGE_AUTH_INVALID"
      );

      pass(
        "Wrong Edge secret rejected"
      );

      /*
       * 10 VALID HEARTBEAT
       */
      res =
        await heartbeat(
          edgeA
            .installation_id,
          secretA
        );

      assert.equal(
        res.status,
        200,
        JSON.stringify(
          res.body
        )
      );

      assert.equal(
        Number(
          res.body
            ?.edge
            ?.restaurant_id
        ),
        fixtureRestaurantId
      );

      pass(
        "Valid authenticated heartbeat accepted"
      );

      /*
       * 11 REQUEST CANNOT SPOOF RESTAURANT
       */
      res =
        await heartbeat(
          edgeA
            .installation_id,
          secretA,
          {
            restaurant_id:
              999999999,
          }
        );

      assert.equal(
        res.status,
        200
      );

      assert.equal(
        Number(
          res.body
            ?.edge
            ?.restaurant_id
        ),
        fixtureRestaurantId
      );

      const tenantProof =
        await qGet(
          `
          SELECT
            restaurant_id

          FROM
            public.restaurant_edge_nodes

          WHERE
            id = $1
          `,
          [
            Number(
              edgeA.id
            ),
          ]
        );

      assert.equal(
        Number(
          tenantProof
            .restaurant_id
        ),
        fixtureRestaurantId
      );

      pass(
        "Cloud controls Edge restaurant ownership"
      );

      /*
       * 12 TELEMETRY PERSISTED
       */
      const telemetry =
        await qGet(
          `
          SELECT
            version,
            first_seen_at,
            last_seen_at,
            local_db_status,
            local_db_latency_ms,
            internet_status,
            cloud_latency_ms,
            sync_status,
            pending_sync_events,
            uptime_seconds,
            disk_free_mb

          FROM
            public.restaurant_edge_nodes

          WHERE
            id = $1
          `,
          [
            Number(
              edgeA.id
            ),
          ]
        );

      assert.equal(
        telemetry.version,
        "1.0.0-test"
      );

      assert.ok(
        telemetry
          .first_seen_at
      );

      assert.ok(
        telemetry
          .last_seen_at
      );

      assert.equal(
        telemetry
          .local_db_status,
        "healthy"
      );

      assert.equal(
        telemetry
          .internet_status,
        "online"
      );

      assert.equal(
        telemetry
          .sync_status,
        "synced"
      );

      pass(
        "Edge health telemetry persisted"
      );

      /*
       * 13 HEALTHY IN CC
       */
      res =
        await http
          .get(
            `/cc/edge/restaurants/${fixtureRestaurantId}`
          )
          .set(
            ccAuth(
              adminToken
            )
          );

      edgeView =
        res.body.edges.find(
          (edge) =>
            Number(
              edge.id
            ) ===
            Number(
              edgeA.id
            )
        );

      assert.equal(
        edgeView.online,
        true
      );

      assert.equal(
        edgeView
          .health_status,
        "healthy"
      );

      assert.equal(
        edgeView
          .internet_status,
        "online"
      );

      pass(
        "Control Centre calculates Edge as healthy"
      );

      /*
       * 14 INVALID TELEMETRY
       */
      res =
        await heartbeat(
          edgeA
            .installation_id,
          secretA,
          {
            pending_sync_events:
              -1,
          }
        );

      assert.equal(
        res.status,
        400
      );

      pass(
        "Invalid Edge telemetry rejected"
      );

      /*
       * 15 CLOUD OFFLINE AUTHORITY
       */
      await qRun(
        `
        UPDATE
          public.restaurant_edge_nodes

        SET
          last_seen_at =
            NOW() -
            INTERVAL '60 seconds'

        WHERE
          id = $1
        `,
        [
          Number(
            edgeA.id
          ),
        ]
      );

      res =
        await http
          .get(
            `/cc/edge/restaurants/${fixtureRestaurantId}`
          )
          .set(
            ccAuth(
              adminToken
            )
          );

      edgeView =
        res.body.edges.find(
          (edge) =>
            Number(
              edge.id
            ) ===
            Number(
              edgeA.id
            )
        );

      assert.equal(
        edgeView.online,
        false
      );

      assert.equal(
        edgeView
          .health_status,
        "offline"
      );

      assert.equal(
        edgeView
          .internet_status,
        "offline"
      );

      pass(
        "Cloud detects stale Edge as offline"
      );

      /*
       * Restore heartbeat.
       */
      res =
        await heartbeat(
          edgeA
            .installation_id,
          secretA
        );

      assert.equal(
        res.status,
        200
      );

      /*
       * 16 ROTATE SECRET
       */
      res =
        await http
          .post(
            `/cc/edge/${edgeA.id}/rotate-secret`
          )
          .set(
            ccAuth(
              adminToken
            )
          )
          .send({});

      assert.equal(
        res.status,
        200,
        JSON.stringify(
          res.body
        )
      );

      const rotatedSecret =
        res.body
          ?.credentials
          ?.secret;

      assert.ok(
        rotatedSecret
      );

      assert.notEqual(
        rotatedSecret,
        secretA
      );

      pass(
        "Edge secret rotated"
      );

      /*
       * 17 OLD SECRET DIES
       */
      res =
        await heartbeat(
          edgeA
            .installation_id,
          secretA
        );

      assert.equal(
        res.status,
        401
      );

      res =
        await heartbeat(
          edgeA
            .installation_id,
          rotatedSecret
        );

      assert.equal(
        res.status,
        200
      );

      pass(
        "Old secret revoked and new secret accepted"
      );

      /*
       * 18 PROVISION EDGE B
       */
      res =
        await http
          .post(
            `/cc/edge/restaurants/${fixtureRestaurantId}/provision`
          )
          .set(
            ccAuth(
              adminToken
            )
          )
          .send({
            edge_name:
              `${edgePrefix} B`,
          });

      assert.equal(
        res.status,
        201,
        JSON.stringify(
          res.body
        )
      );

      const edgeB =
        res.body.edge;

      const secretB =
        res.body
          .credentials
          .secret;

      createdEdgeIds.push(
        Number(edgeB.id)
      );

      const activeCount =
        await qGet(
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.restaurant_edge_nodes

          WHERE
            restaurant_id = $1

            AND is_active =
              TRUE
          `,
          [
            fixtureRestaurantId,
          ]
        );

      assert.equal(
        Number(
          activeCount.count
        ),
        1
      );

      pass(
        "Replacement provisioning leaves exactly one active Edge"
      );

      /*
       * 19 OLD EDGE DISABLED
       */
      res =
        await heartbeat(
          edgeA
            .installation_id,
          rotatedSecret
        );

      assert.equal(
        res.status,
        403
      );

      assert.equal(
        res.body?.code,
        "EDGE_DISABLED"
      );

      pass(
        "Replaced Edge cannot heartbeat"
      );

      /*
       * 20 DATABASE IS FINAL AUTHORITY
       */
      let uniqueCode =
        null;

      try {
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
            fixtureRestaurantId,
            crypto.randomUUID(),
            `${edgePrefix} ILLEGAL`,
            "f".repeat(64),
          ]
        );
      } catch (error) {
        uniqueCode =
          error?.code ||
          null;
      }

      assert.equal(
        uniqueCode,
        "23505"
      );

      pass(
        "PostgreSQL blocks second active Edge"
      );

      /*
       * 21 RE-ENABLE EDGE A
       */
      res =
        await http
          .patch(
            `/cc/edge/${edgeA.id}/status`
          )
          .set(
            ccAuth(
              adminToken
            )
          )
          .send({
            is_active:
              true,
          });

      assert.equal(
        res.status,
        200
      );

      const activeRows =
        await qAll(
          `
          SELECT
            id,
            is_active

          FROM
            public.restaurant_edge_nodes

          WHERE
            restaurant_id = $1

          ORDER BY
            id
          `,
          [
            fixtureRestaurantId,
          ]
        );

      assert.equal(
        activeRows.filter(
          (row) =>
            row.is_active ===
            true
        ).length,
        1
      );

      const currentA =
        activeRows.find(
          (row) =>
            Number(
              row.id
            ) ===
            Number(
              edgeA.id
            )
        );

      const currentB =
        activeRows.find(
          (row) =>
            Number(
              row.id
            ) ===
            Number(
              edgeB.id
            )
        );

      assert.equal(
        currentA.is_active,
        true
      );

      assert.equal(
        currentB.is_active,
        false
      );

      res =
        await heartbeat(
          edgeB
            .installation_id,
          secretB
        );

      assert.equal(
        res.status,
        403
      );

      pass(
        "Re-enabling one Edge disables the other"
      );

      /*
       * 22 DISABLE CURRENT EDGE
       */
      res =
        await http
          .patch(
            `/cc/edge/${edgeA.id}/status`
          )
          .set(
            ccAuth(
              adminToken
            )
          )
          .send({
            is_active:
              false,
          });

      assert.equal(
        res.status,
        200
      );

      res =
        await heartbeat(
          edgeA
            .installation_id,
          rotatedSecret
        );

      assert.equal(
        res.status,
        403
      );

      pass(
        "Disabled Edge credentials cannot operate"
      );

      /*
       * 23 AUDIT
       */
      const audits =
        await qAll(
          `
          SELECT
            action,
            entity,
            entity_id

          FROM
            public.platform_admin_audit

          WHERE
            admin_user_id =
              $1

            AND entity =
              'restaurant_edge_nodes'
          `,
          [
            fixtureAdminId,
          ]
        );

      const actions =
        new Set(
          audits.map(
            (row) =>
              row.action
          )
        );

      for (
        const expected of [
          "CC_EDGE_PROVISION",
          "CC_EDGE_ROTATE_SECRET",
          "CC_EDGE_ENABLE",
          "CC_EDGE_DISABLE",
        ]
      ) {
        assert.ok(
          actions.has(
            expected
          ),
          `Missing audit action ${expected}`
        );
      }

      pass(
        "Edge administration is audit logged"
      );

      assert.equal(
        passCount,
        23
      );

      console.log(
        "\n========================================"
      );

      console.log(
        "✅ MAKS EDGE CONTROL-PLANE ATTACK: 23/23"
      );

      console.log(
        "========================================\n"
      );
    } finally {
      await cleanup();
    }
  }
);
