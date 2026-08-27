"use strict";

const assert = require(
  "node:assert/strict"
);
const crypto = require(
  "node:crypto"
);
const http = require(
  "node:http"
);
const path = require(
  "node:path"
);
const {
  once,
} = require(
  "node:events"
);
const {
  spawn,
} = require(
  "node:child_process"
);
const test = require(
  "node:test"
);

const {
  Pool,
} = require("pg");

const {
  runCanonicalCommercialPricingPg,
} = require(
  "../../migrations/canonicalCommercialPricing.pg"
);

const {
  runCanonicalEdgeSyncFoundationPg,
} = require(
  "../../migrations/canonicalEdgeSyncFoundation.pg"
);

const {
  runCanonicalEdgeDomainRevisionsPg,
} = require(
  "../../migrations/canonicalEdgeDomainRevisions.pg"
);

const {
  receiveInboxEvent,
} = require(
  "../../edge/syncStore"
);

const {
  PRICING_RULES_EVENT_TYPE,
} = require(
  "../../edge/contracts/pricingRules"
);


const DATABASE_URL =
  String(
    process.env.DATABASE_URL ||
    ""
  ).trim();


function sleep(
  ms
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}


async function waitFor(
  check,
  {
    timeoutMs = 10000,
    intervalMs = 50,
    message =
      "Timed out waiting for condition",
  } = {}
) {
  const deadline =
    Date.now() +
    timeoutMs;

  while (
    Date.now() < deadline
  ) {
    if (
      await check()
    ) {
      return;
    }

    await sleep(
      intervalMs
    );
  }

  throw new Error(
    message
  );
}


function jsonResponse(
  res,
  status,
  body
) {
  const text =
    JSON.stringify(body);

  res.statusCode =
    status;

  res.setHeader(
    "content-type",
    "application/json"
  );

  res.setHeader(
    "content-length",
    Buffer.byteLength(text)
  );

  res.end(text);
}


async function createCloudStub({
  restaurantId,
  installationId,
}) {
  const state = {
    heartbeats: 0,
    pullFailures: 0,
  };

  const server =
    http.createServer(
      (req, res) => {
        const url =
          new URL(
            req.url || "/",
            "http://127.0.0.1"
          );

        if (
          req.method === "POST" &&
          url.pathname ===
            "/edge/heartbeat"
        ) {
          state.heartbeats +=
            1;

          req.resume();

          jsonResponse(
            res,
            200,
            {
              success: true,
              edge: {
                installation_id:
                  installationId,
                restaurant_id:
                  restaurantId,
              },
              heartbeat_interval_seconds:
                60,
            }
          );

          return;
        }

        if (
          req.method === "POST" &&
          url.pathname ===
            "/edge/sync/pull"
        ) {
          state.pullFailures +=
            1;

          req.resume();

          jsonResponse(
            res,
            503,
            {
              success: false,
              error:
                "SIMULATED_PULL_OUTAGE",
            }
          );

          return;
        }

        req.resume();

        jsonResponse(
          res,
          404,
          {
            success: false,
            error: "NOT_FOUND",
          }
        );
      }
    );

  server.listen(
    0,
    "127.0.0.1"
  );

  await once(
    server,
    "listening"
  );

  const address =
    server.address();

  assert.ok(
    address &&
    typeof address ===
      "object"
  );

  return {
    server,
    state,
    url:
      `http://127.0.0.1:${address.port}`,
  };
}


function spawnAgent({
  cloudUrl,
  databaseUrl,
  installationId,
}) {
  const stdout = [];
  const stderr = [];

  const child =
    spawn(
      process.execPath,
      [
        path.join(
          __dirname,
          "../../edge/agent.js"
        ),
      ],
      {
        cwd:
          path.join(
            __dirname,
            "../.."
          ),
        env: {
          ...process.env,
          DB_DRIVER: "pg",
          DATABASE_URL:
            "postgresql://127.0.0.1:1/poison",
          MAKS_RUNTIME_ROLE:
            "edge",
          MAKS_EDGE_CLOUD_URL:
            cloudUrl,
          MAKS_EDGE_INSTALLATION_ID:
            installationId,
          MAKS_EDGE_SECRET:
            "agent-application-secret",
          MAKS_EDGE_DATABASE_URL:
            databaseUrl,
          MAKS_EDGE_VERSION:
            "edge-agent-application-attack",
          MAKS_EDGE_HEARTBEAT_MS:
            "5000",
          MAKS_EDGE_SYNC_MS:
            "60000",
          MAKS_EDGE_PULL_MS:
            "1000",
          MAKS_EDGE_APPLY_MS:
            "500",
        },
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    );

  child.stdout.on(
    "data",
    (chunk) => {
      stdout.push(
        String(chunk)
      );
    }
  );

  child.stderr.on(
    "data",
    (chunk) => {
      stderr.push(
        String(chunk)
      );
    }
  );

  return {
    child,
    stdout,
    stderr,
  };
}


async function stopAgent(
  agent
) {
  const child =
    agent?.child;

  if (!child) {
    return;
  }

  if (
    child.exitCode !== null
  ) {
    return;
  }

  child.kill(
    "SIGTERM"
  );

  await Promise.race([
    once(
      child,
      "exit"
    ),
    sleep(5000),
  ]);

  if (
    child.exitCode === null
  ) {
    child.kill(
      "SIGKILL"
    );

    await once(
      child,
      "exit"
    );
  }
}


function pricingPayload({
  revision,
  id,
  name,
  priority,
}) {
  const now =
    new Date()
      .toISOString();

  return {
    schema_version: 1,
    revision,
    rules: [
      {
        id,
        name,
        rule_type:
          "fixed_bundle",
        active: true,
        priority,
        conditions: {
          components: [
            {
              item_type:
                "meal",
              quantity: 1,
            },
          ],
        },
        actions: {
          bundle_price: 10,
        },
        starts_at: null,
        ends_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
  };
}


async function insertLocalRule(
  pool,
  restaurantId,
  name
) {
  await pool.query(
    `
    INSERT INTO
      public.pricing_rules
    (
      restaurant_id,
      name,
      rule_type,
      active,
      priority,
      conditions,
      actions,
      starts_at,
      ends_at,
      created_at,
      updated_at
    )
    VALUES
    (
      $1,
      $2,
      'fixed_bundle',
      TRUE,
      1,
      $3::jsonb,
      $4::jsonb,
      NULL,
      NULL,
      NOW(),
      NOW()
    )
    `,
    [
      restaurantId,
      name,
      JSON.stringify({
        components: [
          {
            item_type:
              "meal",
            quantity: 1,
          },
        ],
      }),
      JSON.stringify({
        bundle_price: 9,
      }),
    ]
  );
}


async function pricingNames(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        id,
        name,
        restaurant_id
      FROM
        public.pricing_rules
      WHERE
        restaurant_id = $1
      ORDER BY id
      `,
      [
        restaurantId,
      ]
    );

  return result.rows;
}


test(
  "MAKS Edge agent automatic application attack",
  {
    timeout: 45000,
  },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      "DATABASE_URL is required"
    );

    const pool =
      new Pool({
        connectionString:
          DATABASE_URL,
      });

    const token =
      crypto
        .randomBytes(8)
        .toString("hex");

    const installationId =
      crypto.randomUUID();

    let restaurantA =
      null;

    let restaurantB =
      null;

    let cloud =
      null;

    let agent =
      null;

    try {
      const database =
        await pool.query(
          "SELECT current_database() AS db"
        );

      assert.equal(
        database.rows?.[0]?.db,
        "maks_test",
        "REFUSED: agent application Attack may run only against maks_test"
      );

      console.log(
        "✅ 01 Database guard: maks_test"
      );

      await runCanonicalCommercialPricingPg({
        pool,
      });

      await runCanonicalEdgeSyncFoundationPg({
        pool,
      });

      await runCanonicalEdgeDomainRevisionsPg({
        pool,
      });

      console.log(
        "✅ 02 Required schemas verified"
      );

      const restaurants =
        await Promise.all([
          pool.query(
            `
            INSERT INTO
              public.restaurants
            (name)
            VALUES ($1)
            RETURNING id
            `,
            [
              `AGENT APPLY ATTACK A ${token}`,
            ]
          ),
          pool.query(
            `
            INSERT INTO
              public.restaurants
            (name)
            VALUES ($1)
            RETURNING id
            `,
            [
              `AGENT APPLY ATTACK B ${token}`,
            ]
          ),
        ]);

      restaurantA =
        Number(
          restaurants[0]
            .rows[0]
            .id
        );

      restaurantB =
        Number(
          restaurants[1]
            .rows[0]
            .id
        );

      await insertLocalRule(
        pool,
        restaurantA,
        `A OLD ${token}`
      );

      await insertLocalRule(
        pool,
        restaurantB,
        `B KEEP ${token}`
      );

      const nextIdResult =
        await pool.query(
          `
          SELECT
            COALESCE(
              MAX(id),
              0
            )::bigint + 10000
              AS next_id
          FROM
            public.pricing_rules
          `
        );

      const firstCloudRuleId =
        Number(
          nextIdResult
            .rows[0]
            .next_id
        );

      assert.ok(
        Number.isSafeInteger(
          firstCloudRuleId
        )
      );

      const event1 =
        crypto.randomUUID();

      await receiveInboxEvent({
        pool,
        eventId: event1,
        restaurantId:
          restaurantA,
        source: "cloud",
        eventType:
          PRICING_RULES_EVENT_TYPE,
        entityType:
          "pricing_rules",
        entityId:
          String(
            restaurantA
          ),
        payload:
          pricingPayload({
            revision: 1,
            id:
              firstCloudRuleId,
            name:
              `A CLOUD V1 ${token}`,
            priority: 10,
          }),
      });

      console.log(
        "✅ 03 Durable Cloud pricing event prepared"
      );

      cloud =
        await createCloudStub({
          restaurantId:
            restaurantA,
          installationId,
        });

      agent =
        spawnAgent({
          cloudUrl:
            cloud.url,
          databaseUrl:
            DATABASE_URL,
          installationId,
        });

      await t.test(
        "pending Cloud pricing event applies automatically after tenant authentication",
        async () => {
          await waitFor(
            async () => {
              const [
                pricing,
                inbox,
              ] =
                await Promise.all([
                  pricingNames(
                    pool,
                    restaurantA
                  ),
                  pool.query(
                    `
                    SELECT
                      status,
                      apply_attempts
                    FROM
                      public.edge_inbox
                    WHERE
                      event_id =
                        $1::uuid
                    `,
                    [event1]
                  ),
                ]);

              return (
                pricing.length === 1 &&
                pricing[0].name ===
                  `A CLOUD V1 ${token}` &&
                inbox.rows?.[0]
                  ?.status ===
                  "applied"
              );
            },
            {
              timeoutMs: 15000,
              message:
                "Edge agent did not automatically apply the durable pricing event",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null,
            `Agent exited unexpectedly:\n${agent.stderr.join("")}`
          );

          const inbox =
            await pool.query(
              `
              SELECT
                status,
                apply_attempts
              FROM
                public.edge_inbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [event1]
            );

          assert.equal(
            inbox.rows[0]
              .apply_attempts,
            1
          );

          const other =
            await pricingNames(
              pool,
              restaurantB
            );

          assert.equal(
            other.length,
            1
          );

          assert.equal(
            other[0].name,
            `B KEEP ${token}`
          );

          console.log(
            "✅ 04 Automatic pricing application + tenant isolation proven"
          );
        }
      );

      await t.test(
        "application timer keeps applying local inbox while Cloud pull is unavailable",
        async () => {
          await waitFor(
            () =>
              cloud.state
                .pullFailures > 0,
            {
              timeoutMs: 10000,
              message:
                "Expected simulated Cloud pull outage",
            }
          );

          const event2 =
            crypto.randomUUID();

          await receiveInboxEvent({
            pool,
            eventId: event2,
            restaurantId:
              restaurantA,
            source: "cloud",
            eventType:
              PRICING_RULES_EVENT_TYPE,
            entityType:
              "pricing_rules",
            entityId:
              String(
                restaurantA
              ),
            payload:
              pricingPayload({
                revision: 2,
                id:
                  firstCloudRuleId +
                  1,
                name:
                  `A CLOUD V2 ${token}`,
                priority: 20,
              }),
          });

          await waitFor(
            async () => {
              const [
                pricing,
                inbox,
              ] =
                await Promise.all([
                  pricingNames(
                    pool,
                    restaurantA
                  ),
                  pool.query(
                    `
                    SELECT status
                    FROM
                      public.edge_inbox
                    WHERE
                      event_id =
                        $1::uuid
                    `,
                    [event2]
                  ),
                ]);

              return (
                pricing.length === 1 &&
                pricing[0].name ===
                  `A CLOUD V2 ${token}` &&
                inbox.rows?.[0]
                  ?.status ===
                  "applied"
              );
            },
            {
              timeoutMs: 10000,
              message:
                "Independent Edge application loop did not apply revision 2 during pull outage",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null,
            `Agent crashed during pull outage:\n${agent.stderr.join("")}`
          );

          console.log(
            "✅ 05 Offline local application loop proven"
          );
        }
      );

      await t.test(
        "Edge application uses MAKS_EDGE_DATABASE_URL instead of poisoned global DATABASE_URL",
        async () => {
          const pricing =
            await pricingNames(
              pool,
              restaurantA
            );

          assert.equal(
            pricing.length,
            1
          );

          assert.equal(
            pricing[0].name,
            `A CLOUD V2 ${token}`
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          console.log(
            "✅ 06 Explicit Edge-local application pool proven"
          );
        }
      );

      await stopAgent(
        agent
      );

      assert.equal(
        agent.child.exitCode,
        0,
        `Agent did not shut down gracefully:\n${agent.stderr.join("")}`
      );

      console.log(
        "============================================"
      );
      console.log(
        "✅ MAKS EDGE AGENT APPLICATION ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );
    } finally {
      await stopAgent(
        agent
      );

      if (
        cloud?.server
      ) {
        await new Promise(
          (resolve) =>
            cloud.server.close(
              resolve
            )
        );
      }

      if (
        restaurantA ||
        restaurantB
      ) {
        await pool.query(
          `
          DELETE FROM
            public.restaurants
          WHERE id = ANY(
            $1::bigint[]
          )
          `,
          [[
            restaurantA,
            restaurantB,
          ].filter(Boolean)]
        );
      }

      await pool.end();

      console.log(
        "✅ 07 Cleanup proven"
      );
    }
  }
);
