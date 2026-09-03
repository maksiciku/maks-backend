"use strict";

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const express =
  require("express");

const request =
  require("supertest");

const test =
  require("node:test");

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


const originalRuntimeRole =
  process.env
    .MAKS_RUNTIME_ROLE;

process.env
  .MAKS_RUNTIME_ROLE =
  "cloud";


const {
  qAll,
  qGet,
  qRun,
} = require(
  "../../dbCompat"
);

const {
  hashJson,
} = require(
  "../../edge/syncStore"
);

const {
  generateEdgeCredentials,
} = require(
  "../../utils/edgeAuth"
);

const {
  TABLE_OPERATIONAL_EVENT_TYPE,
  TABLE_OPERATIONAL_SCHEMA_VERSION,
  normalizeTableName,
  tableOperationalDomain,
} = require(
  "../../edge/contracts/tableOperations"
);

const edgeRoutes =
  require(
    "../../routes/edgeRoutes"
);


function uuid() {
  return crypto
    .randomUUID();
}


function tableDigest(
  tableName
) {
  return crypto
    .createHash(
      "sha256"
    )
    .update(
      normalizeTableName(
        tableName
      ),
      "utf8"
    )
    .digest(
      "hex"
    )
    .slice(
      0,
      32
    );
}


function headers(
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


function makeTablePayload({
  restaurantId,
  tableName,
  revision,
  status,
  session,
  schemaVersion =
    TABLE_OPERATIONAL_SCHEMA_VERSION,
}) {
  return {
    schema_version:
      schemaVersion,

    restaurant_id:
      restaurantId,

    revision,

    table: {
      name:
        tableName,

      normalized_name:
        normalizeTableName(
          tableName
        ),

      status,
    },

    session,
  };
}


function makeTableEvent({
  restaurantId,
  payload,
  eventId =
    uuid(),
}) {
  const normalizedName =
    normalizeTableName(
      payload
        .table
        .normalized_name
    );

  const digest =
    tableDigest(
      normalizedName
    );

  return {
    event_id:
      eventId,

    restaurant_id:
      restaurantId,

    event_type:
      TABLE_OPERATIONAL_EVENT_TYPE,

    entity_type:
      "table",

    entity_id:
      normalizedName,

    idempotency_key:
      `${TABLE_OPERATIONAL_EVENT_TYPE}:${digest}:${payload.revision}`,

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
  app,
  credentials,
  event
) {
  return request(
    app
  )
    .post(
      "/edge/sync/push"
    )
    .set(
      headers(
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


async function loadSeedTable(
  restaurantId,
  preferredId
) {
  const pid =
    Number(
      preferredId ||
      0
    );

  if (
    pid > 0
  ) {
    const byId =
      await qGet(
        `
        SELECT
          id,
          restaurant_id,
          name,
          status

        FROM
          public.tables

        WHERE
          restaurant_id =
            $1

          AND id =
            $2

        LIMIT 1
        `,
        [
          restaurantId,
          pid,
        ]
      );

    if (
      byId
    ) {
      return byId;
    }
  }

  return qGet(
    `
    SELECT
      id,
      restaurant_id,
      name,
      status

    FROM
      public.tables

    WHERE
      restaurant_id =
        $1

    ORDER BY
      id ASC

    LIMIT 1
    `,
    [
      restaurantId,
    ]
  );
}


async function loadTableMap(
  restaurantId,
  tableName
) {
  return qGet(
    `
    SELECT
      id,
      restaurant_id,
      name,
      status

    FROM
      public.table_map

    WHERE
      restaurant_id =
        $1

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
}


async function loadSession(
  restaurantId,
  tableId
) {
  return qGet(
    `
    SELECT
      restaurant_id,
      table_id,
      covers,
      allergy_codes,
      strict_cross_contamination

    FROM
      public.pos_table_sessions

    WHERE
      restaurant_id =
        $1

      AND table_id =
        $2

    LIMIT 1
    `,
    [
      restaurantId,
      tableId,
    ]
  );
}


async function loadRevision(
  restaurantId,
  domain
) {
  return qGet(
    `
    SELECT
      applied_revision,
      applied_payload_hash

    FROM
      public.edge_domain_revisions

    WHERE
      restaurant_id =
        $1

      AND domain =
        $2

    LIMIT 1
    `,
    [
      restaurantId,
      domain,
    ]
  );
}


async function loadInbox(
  eventId
) {
  return qGet(
    `
    SELECT
      event_id,
      status,
      applied_at,
      apply_attempts

    FROM
      public.edge_inbox

    WHERE
      event_id =
        $1::uuid

    LIMIT 1
    `,
    [
      eventId,
    ]
  );
}


async function countTableOutbox(
  restaurantId
) {
  return qGet(
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
      restaurantId,
      TABLE_OPERATIONAL_EVENT_TYPE,
    ]
  );
}


test(
  "MAKS table operational Cloud materializer attack",
  {
    timeout:
      60000,
  },

  async (t) => {
    await assertTestDatabase();

    await resetTestData();

    const fixtures =
      await seedTestData();

    const restaurantA =
      Number(
        fixtures
          .restaurantA
      );

    const restaurantB =
      Number(
        fixtures
          .restaurantB
      );

    const tableA =
      await loadSeedTable(
        restaurantA,
        fixtures
          .tableA
      );

    const tableB =
      await loadSeedTable(
        restaurantB,
        fixtures
          .tableB
      );

    assert.ok(
      tableA
        ?.id,
      "seedTestData did not provide Restaurant A physical table"
    );

    assert.ok(
      tableB
        ?.id,
      "seedTestData did not provide Restaurant B physical table"
    );

    const mapA =
      await loadTableMap(
        restaurantA,
        tableA.name
      );

    assert.ok(
      mapA
        ?.id,
      "seedTestData did not provide Restaurant A table_map mirror"
    );

    const credentials =
      generateEdgeCredentials();

    const app =
      express();

    app.use(
      express.json({
        limit:
          "10mb",
      })
    );

    /*
     * Match the real server request DB adapter.
     */
    app.use(
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

    app.use(
      "/edge",
      edgeRoutes
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
        'TABLE Cloud Apply Attack',
        $3,
        TRUE
      )
      `,
      [
        restaurantA,

        credentials
          .installationId,

        credentials
          .secretHash,
      ]
    );


    const domain =
      tableOperationalDomain(
        tableA.name
      );

    const rev1Payload =
      makeTablePayload({
        restaurantId:
          restaurantA,

        tableName:
          tableA.name,

        revision:
          1,

        status:
          "occupied",

        session: {
          covers:
            4,

          allergy_codes: [
            "gluten",
            "milk",
          ],

          strict_cross_contamination:
            true,
        },
      });

    const rev1Event =
      makeTableEvent({
        restaurantId:
          restaurantA,

        payload:
          rev1Payload,
      });


    try {
      await t.test(
        "revision 1 materializes table status, map mirror and Cloud-local session",
        async () => {
          const response =
            await pushEvent(
              app,
              credentials,
              rev1Event
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              ?.rejected
              ?.length,
            0
          );

          assert.equal(
            response.body
              ?.acked
              ?.length,
            1
          );

          const table =
            await qGet(
              `
              SELECT
                id,
                status

              FROM
                public.tables

              WHERE
                restaurant_id =
                  $1

                AND id =
                  $2
              `,
              [
                restaurantA,
                tableA.id,
              ]
            );

          assert.equal(
            table.status,
            "occupied"
          );

          const map =
            await loadTableMap(
              restaurantA,
              tableA.name
            );

          assert.equal(
            map.status,
            "occupied"
          );

          const session =
            await loadSession(
              restaurantA,
              tableA.id
            );

          assert.ok(
            session
          );

          assert.equal(
            Number(
              session.table_id
            ),
            Number(
              tableA.id
            ),
            "Cloud session did not use Cloud-local tables.id"
          );

          assert.equal(
            Number(
              session.covers
            ),
            4
          );

          assert.deepEqual(
            session.allergy_codes,
            [
              "gluten",
              "milk",
            ]
          );

          assert.equal(
            Boolean(
              session
                .strict_cross_contamination
            ),
            true
          );

          const revision =
            await loadRevision(
              restaurantA,
              domain
            );

          assert.equal(
            Number(
              revision
                ?.applied_revision
            ),
            1
          );

          const inbox =
            await loadInbox(
              rev1Event
                .event_id
            );

          assert.equal(
            inbox
              ?.status,
            "applied"
          );

          assert.ok(
            inbox
              ?.applied_at
          );

          console.log(
            "✅ 01 Table revision 1 materialized with Cloud-local session identity"
          );
        }
      );


      const rev2Payload =
        makeTablePayload({
          restaurantId:
            restaurantA,

          tableName:
            tableA.name,

          revision:
            2,

          status:
            "reserved",

          session:
            null,
        });

      const rev2Event =
        makeTableEvent({
          restaurantId:
            restaurantA,

          payload:
            rev2Payload,
        });


      await t.test(
        "newer revision replaces status and null session deletes Cloud session",
        async () => {
          const response =
            await pushEvent(
              app,
              credentials,
              rev2Event
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .rejected
              .length,
            0
          );

          assert.equal(
            response.body
              .acked
              .length,
            1
          );

          const table =
            await qGet(
              `
              SELECT status
              FROM public.tables
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                tableA.id,
              ]
            );

          assert.equal(
            table.status,
            "reserved"
          );

          const map =
            await loadTableMap(
              restaurantA,
              tableA.name
            );

          assert.equal(
            map.status,
            "reserved"
          );

          const session =
            await loadSession(
              restaurantA,
              tableA.id
            );

          assert.equal(
            session,
            null
          );

          const revision =
            await loadRevision(
              restaurantA,
              domain
            );

          assert.equal(
            Number(
              revision
                ?.applied_revision
            ),
            2
          );

          console.log(
            "✅ 02 Newer table snapshot replaced status and deleted session"
          );
        }
      );


      await t.test(
        "stale revision is ACKed but cannot regress current table state",
        async () => {
          const staleEvent =
            makeTableEvent({
              restaurantId:
                restaurantA,

              payload:
                rev1Payload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              staleEvent
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .rejected
              .length,
            0
          );

          assert.equal(
            response.body
              .acked
              .length,
            1
          );

          const table =
            await qGet(
              `
              SELECT status
              FROM public.tables
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                tableA.id,
              ]
            );

          assert.equal(
            table.status,
            "reserved"
          );

          const map =
            await loadTableMap(
              restaurantA,
              tableA.name
            );

          assert.equal(
            map.status,
            "reserved"
          );

          const session =
            await loadSession(
              restaurantA,
              tableA.id
            );

          assert.equal(
            session,
            null
          );

          const revision =
            await loadRevision(
              restaurantA,
              domain
            );

          assert.equal(
            Number(
              revision
                ?.applied_revision
            ),
            2
          );

          const inbox =
            await loadInbox(
              staleEvent
                .event_id
            );

          assert.equal(
            inbox.status,
            "applied"
          );

          console.log(
            "✅ 03 Stale table revision cannot roll Cloud backward"
          );
        }
      );


      await t.test(
        "exact event replay is idempotent",
        async () => {
          const firstInbox =
            await loadInbox(
              rev2Event
                .event_id
            );

          assert.equal(
            firstInbox.status,
            "applied"
          );

          const replay =
            await pushEvent(
              app,
              credentials,
              rev2Event
            );

          assert.equal(
            replay.status,
            200
          );

          assert.equal(
            replay.body
              .rejected
              .length,
            0
          );

          assert.equal(
            replay.body
              .acked
              .length,
            1
          );

          assert.equal(
            replay.body
              .acked[0]
              .duplicate,
            true
          );

          const table =
            await qGet(
              `
              SELECT status
              FROM public.tables
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                tableA.id,
              ]
            );

          assert.equal(
            table.status,
            "reserved"
          );

          const revision =
            await loadRevision(
              restaurantA,
              domain
            );

          assert.equal(
            Number(
              revision
                .applied_revision
            ),
            2
          );

          console.log(
            "✅ 04 Exact table event replay is idempotent"
          );
        }
      );


      await t.test(
        "same revision with changed payload fails closed",
        async () => {
          const conflictPayload =
            makeTablePayload({
              restaurantId:
                restaurantA,

              tableName:
                tableA.name,

              revision:
                2,

              status:
                "occupied_paid",

              session:
                null,
            });

          const conflictEvent =
            makeTableEvent({
              restaurantId:
                restaurantA,

              payload:
                conflictPayload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              conflictEvent
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .acked
              .length,
            0
          );

          assert.equal(
            response.body
              .rejected
              .length,
            1
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_DOMAIN_REVISION_CONFLICT"
          );

          const inbox =
            await loadInbox(
              conflictEvent
                .event_id
            );

          assert.equal(
            inbox.status,
            "received"
          );

          const table =
            await qGet(
              `
              SELECT status
              FROM public.tables
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                tableA.id,
              ]
            );

          assert.equal(
            table.status,
            "reserved"
          );

          console.log(
            "✅ 05 Conflicting table revision fails closed"
          );
        }
      );


      await t.test(
        "unsupported table schema is rejected before durable inbox acceptance",
        async () => {
          const badPayload =
            makeTablePayload({
              restaurantId:
                restaurantA,

              tableName:
                tableA.name,

              revision:
                3,

              status:
                "occupied",

              session:
                null,

              schemaVersion:
                999,
            });

          const badEvent =
            makeTableEvent({
              restaurantId:
                restaurantA,

              payload:
                badPayload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              badEvent
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .acked
              .length,
            0
          );

          assert.equal(
            response.body
              .rejected
              .length,
            1
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_TABLE_SCHEMA_UNSUPPORTED"
          );

          const inbox =
            await loadInbox(
              badEvent
                .event_id
            );

          assert.equal(
            inbox,
            null,
            "invalid reserved event was durably accepted before strict prevalidation"
          );

          console.log(
            "✅ 06 Unsupported table schema rejected before inbox receipt"
          );
        }
      );


      await t.test(
        "payload tenant mismatch is blocked before inbox acceptance",
        async () => {
          const tenantMismatchPayload =
            makeTablePayload({
              restaurantId:
                restaurantB,

              tableName:
                tableA.name,

              revision:
                3,

              status:
                "occupied",

              session:
                null,
            });

          /*
           * Event envelope claims authenticated tenant A,
           * while payload attempts tenant B.
           */
          const attackEvent =
            makeTableEvent({
              restaurantId:
                restaurantA,

              payload:
                tenantMismatchPayload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              attackEvent
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .acked
              .length,
            0
          );

          assert.equal(
            response.body
              .rejected
              .length,
            1
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_TABLE_TENANT_MISMATCH"
          );

          const inbox =
            await loadInbox(
              attackEvent
                .event_id
            );

          assert.equal(
            inbox,
            null
          );

          console.log(
            "✅ 07 Table payload tenant forgery blocked before inbox receipt"
          );
        }
      );


      await t.test(
        "strict session ingress rejects hostile unknown session fields",
        async () => {
          const hostilePayload =
            makeTablePayload({
              restaurantId:
                restaurantA,

              tableName:
                tableA.name,

              revision:
                3,

              status:
                "occupied",

              session: {
                covers:
                  2,

                allergy_codes:
                  [],

                strict_cross_contamination:
                  false,

                injected_admin_field:
                  true,
              },
            });

          const hostileEvent =
            makeTableEvent({
              restaurantId:
                restaurantA,

              payload:
                hostilePayload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              hostileEvent
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .acked
              .length,
            0
          );

          assert.equal(
            response.body
              .rejected
              .length,
            1
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_TABLE_SESSION_FIELD_UNSUPPORTED"
          );

          const inbox =
            await loadInbox(
              hostileEvent
                .event_id
            );

          assert.equal(
            inbox,
            null
          );

          console.log(
            "✅ 08 Hostile unknown session field rejected fail-closed"
          );
        }
      );


      await t.test(
        "foreign physical table identity cannot mutate another tenant",
        async () => {
          const foreignBefore =
            await qGet(
              `
              SELECT status
              FROM public.tables
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantB,
                tableB.id,
              ]
            );

          const foreignPayload =
            makeTablePayload({
              restaurantId:
                restaurantA,

              /*
               * Authenticated tenant A attempts to use
               * Restaurant B's physical table identity.
               */
              tableName:
                tableB.name,

              revision:
                1,

              status:
                "occupied",

              session:
                null,
            });

          const foreignEvent =
            makeTableEvent({
              restaurantId:
                restaurantA,

              payload:
                foreignPayload,
            });

          const response =
            await pushEvent(
              app,
              credentials,
              foreignEvent
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response.body
              .acked
              .length,
            0
          );

          assert.equal(
            response.body
              .rejected
              .length,
            1
          );

          assert.equal(
            response.body
              .rejected[0]
              .code,
            "EDGE_TABLE_CLOUD_TABLE_REQUIRED"
          );

          const inbox =
            await loadInbox(
              foreignEvent
                .event_id
            );

          assert.equal(
            inbox.status,
            "received"
          );

          const foreignAfter =
            await qGet(
              `
              SELECT status
              FROM public.tables
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantB,
                tableB.id,
              ]
            );

          assert.equal(
            foreignAfter.status,
            foreignBefore.status,
            "foreign tenant table was mutated"
          );

          console.log(
            "✅ 09 Foreign physical table identity cannot cross tenant boundary"
          );
        }
      );


      await t.test(
        "Cloud table apply emits no Edge feedback event",
        async () => {
          const outbox =
            await countTableOutbox(
              restaurantA
            );

          assert.equal(
            Number(
              outbox.count
            ),
            0,
            "Cloud materializer produced a table Edge feedback event"
          );

          console.log(
            "✅ 10 Cloud table materialization produces zero Edge feedback"
          );
        }
      );


      console.log(
        "========================================================="
      );

      console.log(
        "✅ MAKS TABLE OPERATIONAL CLOUD MATERIALIZER ATTACK COMPLETE"
      );

      console.log(
        "========================================================="
      );
    } finally {
      await resetTestData();

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
  }
);
