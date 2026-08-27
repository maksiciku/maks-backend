"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { Pool } = require("pg");

const {
  hashJson,
} = require(
  "../../edge/syncStore"
);

const ROOT = path.resolve(
  __dirname,
  "../.."
);

const AGENT_PATH = path.join(
  ROOT,
  "edge",
  "agent.js"
);

const TEST_DATABASE_URL =
  String(
    process.env.DATABASE_URL || ""
  ).trim();

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

async function waitFor(
  predicate,
  {
    timeoutMs = 10000,
    intervalMs = 50,
    message = "Condition timed out",
  } = {}
) {
  const started = Date.now();

  while (
    Date.now() - started <
    timeoutMs
  ) {
    if (await predicate()) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(message);
}

async function createCloudStub({
  status = 200,
  delayMs = 0,
  body = {
    success: true,
    heartbeat_interval_seconds: 15,
  },
} = {}) {
  const requests = [];

  const state = {
    status,
    delayMs,
    body,
  };

  const server =
    http.createServer(
      (req, res) => {
        const chunks = [];

        req.on(
          "data",
          (chunk) => {
            chunks.push(chunk);
          }
        );

        req.on(
          "end",
          () => {
            let parsedBody = null;

            try {
              parsedBody =
                JSON.parse(
                  Buffer.concat(
                    chunks
                  ).toString(
                    "utf8"
                  ) || "{}"
                );
            } catch {
              parsedBody = null;
            }

            requests.push({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: parsedBody,
              receivedAt:
                Date.now(),
            });

            setTimeout(
              () => {
                if (
                  res.destroyed
                ) {
                  return;
                }

                res.statusCode =
                  state.status;

                res.setHeader(
                  "content-type",
                  "application/json"
                );

                res.end(
                  JSON.stringify(
                    state.body
                  )
                );
              },
              state.delayMs
            );
          }
        );
      }
    );

  await new Promise(
    (resolve, reject) => {
      server.once(
        "error",
        reject
      );

      server.listen(
        0,
        "127.0.0.1",
        resolve
      );
    }
  );

  const address =
    server.address();

  return {
    server,
    requests,
    state,

    url:
      `http://127.0.0.1:${address.port}`,

    async close() {
      await new Promise(
        (resolve) => {
          server.close(
            resolve
          );
        }
      );
    },
  };
}

async function getUnusedUrl() {
  const server =
    http.createServer();

  await new Promise(
    (resolve) => {
      server.listen(
        0,
        "127.0.0.1",
        resolve
      );
    }
  );

  const port =
    server.address().port;

  await new Promise(
    (resolve) => {
      server.close(resolve);
    }
  );

  return `http://127.0.0.1:${port}`;
}


/*
 * Cloud stub used specifically by the automatic sync
 * tests.
 *
 * Heartbeat remains available while push availability
 * can be turned off/on during the same running agent.
 */
async function createSyncCloudStub({
  restaurantId,
  pushAvailable = true,
  pullAvailable = true,
  pullEvents = [],
  pullDelayMs = 0,
} = {}) {
  const requests = [];

  const state = {
    pushAvailable,
    pullAvailable,
    pullEvents:
      Array.isArray(
        pullEvents
      )
        ? [
            ...pullEvents,
          ]
        : [],

    pullAckedEventIds:
      new Set(),

    pullDelayMs:
      Math.max(
        0,
        Number(
          pullDelayMs
        ) || 0
      ),

    activePullRequests:
      0,

    maxConcurrentPullRequests:
      0,
  };

  const server =
    http.createServer(
      (req, res) => {
        const chunks = [];

        req.on(
          "data",
          (chunk) => {
            chunks.push(
              chunk
            );
          }
        );

        req.on(
          "end",
          () => {
            let body = null;

            try {
              body =
                JSON.parse(
                  Buffer.concat(
                    chunks
                  ).toString(
                    "utf8"
                  ) || "{}"
                );
            } catch {
              body = null;
            }

            const record = {
              method:
                req.method,

              url:
                req.url,

              headers:
                req.headers,

              body,

              receivedAt:
                Date.now(),

              responseStatus:
                null,
            };

            requests.push(
              record
            );

            let status = 404;

            let responseBody = {
              success:
                false,

              code:
                "MAKS_TEST_NOT_FOUND",
            };

            let responseDelayMs =
              0;

            let trackedPullRequest =
              false;

            if (
              req.method ===
                "POST" &&
              req.url ===
                "/edge/heartbeat"
            ) {
              status = 200;

              responseBody = {
                success:
                  true,

                edge: {
                  restaurant_id:
                    Number(
                      restaurantId
                    ),
                },

                heartbeat_interval_seconds:
                  15,
              };
            } else if (
              req.method ===
                "POST" &&
              req.url ===
                "/edge/sync/push"
            ) {
              if (
                state
                  .pushAvailable
              ) {
                status = 200;

                const events =
                  Array.isArray(
                    body?.events
                  )
                    ? body.events
                    : [];

                responseBody = {
                  success:
                    true,

                  restaurant_id:
                    Number(
                      restaurantId
                    ),

                  acked:
                    events.map(
                      (event) => ({
                        event_id:
                          event
                            ?.event_id,

                        duplicate:
                          false,
                      })
                    ),

                  rejected:
                    [],
                };
              } else {
                status = 503;

                responseBody = {
                  success:
                    false,

                  code:
                    "MAKS_TEST_CLOUD_UNAVAILABLE",

                  error:
                    "Simulated Cloud sync outage",
                };
              }
            } else if (
              req.method ===
                "POST" &&
              req.url ===
                "/edge/sync/pull"
            ) {
              trackedPullRequest =
                true;

              state.activePullRequests +=
                1;

              state.maxConcurrentPullRequests =
                Math.max(
                  state
                    .maxConcurrentPullRequests,
                  state
                    .activePullRequests
                );

              responseDelayMs =
                state.pullDelayMs;

              if (
                state
                  .pullAvailable
              ) {
                status = 200;

                const limit =
                  Math.max(
                    1,
                    Math.min(
                      25,
                      Number(
                        body?.limit
                      ) || 25
                    )
                  );

                const events =
                  state
                    .pullEvents
                    .filter(
                      (event) =>
                        !state
                          .pullAckedEventIds
                          .has(
                            String(
                              event
                                ?.event_id ||
                              ""
                            )
                          )
                    )
                    .slice(
                      0,
                      limit
                    );

                responseBody = {
                  success:
                    true,

                  restaurant_id:
                    Number(
                      restaurantId
                    ),

                  installation_id:
                    String(
                      req.headers[
                        "x-edge-installation-id"
                      ] || ""
                    ),

                  events,
                };
              } else {
                status = 503;

                responseBody = {
                  success:
                    false,

                  code:
                    "MAKS_TEST_PULL_UNAVAILABLE",

                  error:
                    "Simulated Cloud pull outage",
                };
              }
            } else if (
              req.method ===
                "POST" &&
              req.url ===
                "/edge/sync/pull/ack"
            ) {
              if (
                state
                  .pullAvailable
              ) {
                status = 200;

                const requested =
                  Array.isArray(
                    body?.event_ids
                  )
                    ? body.event_ids.map(
                        (eventId) =>
                          String(
                            eventId ||
                            ""
                          )
                      )
                    : [];

                const known =
                  new Set(
                    state
                      .pullEvents
                      .map(
                        (event) =>
                          String(
                            event
                              ?.event_id ||
                            ""
                          )
                      )
                  );

                const acked =
                  requested
                    .filter(
                      (eventId) =>
                        known.has(
                          eventId
                        )
                    );

                for (
                  const eventId of
                  acked
                ) {
                  state
                    .pullAckedEventIds
                    .add(
                      eventId
                    );
                }

                responseBody = {
                  success:
                    true,

                  restaurant_id:
                    Number(
                      restaurantId
                    ),

                  installation_id:
                    String(
                      req.headers[
                        "x-edge-installation-id"
                      ] || ""
                    ),

                  acked:
                    acked.map(
                      (eventId) => ({
                        event_id:
                          eventId,
                      })
                    ),
                };
              } else {
                status = 503;

                responseBody = {
                  success:
                    false,

                  code:
                    "MAKS_TEST_PULL_UNAVAILABLE",

                  error:
                    "Simulated Cloud pull ACK outage",
                };
              }
            }

            const finishResponse =
              () => {
                if (
                  trackedPullRequest
                ) {
                  state.activePullRequests =
                    Math.max(
                      0,
                      state
                        .activePullRequests -
                      1
                    );
                }

                record.responseStatus =
                  status;

                if (
                  res.destroyed
                ) {
                  return;
                }

                res.statusCode =
                  status;

                res.setHeader(
                  "content-type",
                  "application/json"
                );

                res.end(
                  JSON.stringify(
                    responseBody
                  )
                );
              };

            if (
              responseDelayMs > 0
            ) {
              setTimeout(
                finishResponse,
                responseDelayMs
              );
            } else {
              finishResponse();
            }
          }
        );
      }
    );

  await new Promise(
    (resolve, reject) => {
      server.once(
        "error",
        reject
      );

      server.listen(
        0,
        "127.0.0.1",
        resolve
      );
    }
  );

  const address =
    server.address();

  return {
    server,
    requests,
    state,

    url:
      `http://127.0.0.1:${address.port}`,

    async close() {
      await new Promise(
        (resolve) => {
          server.close(
            resolve
          );
        }
      );
    },
  };
}


function spawnAgent({
  cloudUrl,
  databaseUrl,
  installationId =
    crypto.randomUUID(),
  secret =
    `edge_${crypto
      .randomBytes(32)
      .toString("base64url")}`,
  version =
    "edge-agent-attack-0.1.0",
  heartbeatMs = "5000",
  syncMs = "1000",
  pullMs = "1000",
} = {}) {
  const env = {
    ...process.env,

    MAKS_EDGE_CLOUD_URL:
      cloudUrl,

    MAKS_EDGE_INSTALLATION_ID:
      installationId,

    MAKS_EDGE_SECRET:
      secret,

    MAKS_EDGE_DATABASE_URL:
      databaseUrl,

    MAKS_EDGE_VERSION:
      version,

    MAKS_EDGE_HEARTBEAT_MS:
      heartbeatMs,

    MAKS_EDGE_SYNC_MS:
      syncMs,

    MAKS_EDGE_PULL_MS:
      pullMs,
  };

  const child = spawn(
    process.execPath,
    [AGENT_PATH],
    {
      cwd: ROOT,
      env,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    }
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on(
    "data",
    (chunk) => {
      stdout +=
        chunk.toString(
          "utf8"
        );
    }
  );

  child.stderr.on(
    "data",
    (chunk) => {
      stderr +=
        chunk.toString(
          "utf8"
        );
    }
  );

  return {
    child,
    installationId,
    secret,
    databaseUrl,

    output() {
      return `${stdout}\n${stderr}`;
    },
  };
}

async function stopAgent(agent) {
  if (
    !agent?.child ||
    agent.child.exitCode !==
      null
  ) {
    return;
  }

  agent.child.kill(
    "SIGTERM"
  );

  await Promise.race([
    once(
      agent.child,
      "exit"
    ),

    sleep(3000).then(
      () => {
        if (
          agent.child
            .exitCode === null
        ) {
          agent.child.kill(
            "SIGKILL"
          );
        }
      }
    ),
  ]);
}

test(
  "MAKS Edge runtime attack",
  {
    timeout: 90000,
  },
  async (t) => {
    assert.ok(
      TEST_DATABASE_URL,
      "DATABASE_URL is required"
    );

    const safetyPool =
      new Pool({
        connectionString:
          TEST_DATABASE_URL,
      });

    try {
      const result =
        await safetyPool.query(
          `
          SELECT
            current_database()
              AS db
          `
        );

      assert.equal(
        result.rows?.[0]?.db,
        "maks_test",
        "REFUSED: Edge Agent Attack may run only against maks_test"
      );

      console.log(
        "✅ 01 Database guard: maks_test"
      );
    } finally {
      await safetyPool.end();
    }

    await t.test(
      "missing secret fails closed",
      async () => {
        const cloud =
          await createCloudStub();

        const agent =
          spawnAgent({
            cloudUrl:
              cloud.url,

            databaseUrl:
              TEST_DATABASE_URL,

            secret: "",
          });

        await once(
          agent.child,
          "exit"
        );

        const output =
          agent.output();

        assert.notEqual(
          agent.child.exitCode,
          0
        );

        assert.match(
          output,
          /MAKS_EDGE_SECRET is required/
        );

        assert.equal(
          output.includes(
            TEST_DATABASE_URL
          ),
          false
        );

        await cloud.close();

        console.log(
          "✅ 02 Missing credentials fail closed"
        );
      }
    );

    await t.test(
      "healthy runtime reports real telemetry",
      async () => {
        const cloud =
          await createCloudStub();

        const agent =
          spawnAgent({
            cloudUrl:
              cloud.url,

            databaseUrl:
              TEST_DATABASE_URL,
          });

        try {
          await waitFor(
            () =>
              cloud.requests
                .length >= 2,
            {
              timeoutMs: 9000,

              message:
                "Healthy agent did not send two heartbeats",
            }
          );

          const first =
            cloud.requests[0];

          const second =
            cloud.requests[1];

          assert.equal(
            first.method,
            "POST"
          );

          assert.equal(
            first.url,
            "/edge/heartbeat"
          );

          assert.equal(
            first.headers[
              "x-edge-installation-id"
            ],
            agent.installationId
          );

          assert.equal(
            first.headers[
              "x-edge-secret"
            ],
            agent.secret
          );

          assert.equal(
            first.body
              ?.local_db_status,
            "healthy"
          );

          assert.ok(
            Number.isInteger(
              first.body
                ?.local_db_latency_ms
            )
          );

          assert.ok(
            first.body
              .local_db_latency_ms >=
              0
          );

          assert.equal(
            first.body
              ?.sync_status,
            "unknown"
          );

          assert.equal(
            first.body
              ?.pending_sync_events,
            0
          );

          assert.equal(
            first.body
              ?.last_sync_at,
            null
          );

          assert.equal(
            first.body
              ?.last_sync_error,
            null
          );

          assert.ok(
            Number(
              first.body
                ?.uptime_seconds
            ) >= 0
          );

          assert.equal(
            Object.prototype.hasOwnProperty.call(
              first.body || {},
              "restaurant_id"
            ),
            false
          );

          assert.ok(
            Number.isInteger(
              second.body
                ?.cloud_latency_ms
            )
          );

          assert.ok(
            second.body
              .cloud_latency_ms >=
              0
          );

          assert.equal(
            agent.output().includes(
              agent.secret
            ),
            false
          );

          assert.equal(
            agent.output().includes(
              TEST_DATABASE_URL
            ),
            false
          );

          console.log(
            "✅ 03 Healthy runtime telemetry is real and secrets stay hidden"
          );
        } finally {
          await stopAgent(
            agent
          );

          await cloud.close();
        }

        assert.equal(
          agent.child.exitCode,
          0
        );

        assert.match(
          agent.output(),
          /MAKS Edge shutting down/
        );

        console.log(
          "✅ 04 SIGTERM shutdown is graceful"
        );
      }
    );

    await t.test(
      "cloud rejection does not kill Edge",
      async () => {
        const cloud =
          await createCloudStub({
            status: 401,

            body: {
              success: false,
              error:
                "Invalid MAKS Edge credentials",
              code:
                "EDGE_AUTH_INVALID",
            },
          });

        const agent =
          spawnAgent({
            cloudUrl:
              cloud.url,

            databaseUrl:
              TEST_DATABASE_URL,
          });

        try {
          await waitFor(
            () =>
              cloud.requests
                .length >= 1,
            {
              timeoutMs: 5000,
            }
          );

          await waitFor(
            () =>
              agent
                .output()
                .includes(
                  "EDGE_AUTH_INVALID"
                ),
            {
              timeoutMs: 3000,
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          assert.equal(
            agent.output().includes(
              agent.secret
            ),
            false
          );

          assert.equal(
            agent.output().includes(
              TEST_DATABASE_URL
            ),
            false
          );

          console.log(
            "✅ 05 Cloud credential rejection does not crash Edge"
          );
        } finally {
          await stopAgent(
            agent
          );

          await cloud.close();
        }
      }
    );

    await t.test(
      "cloud outage does not kill Edge",
      async () => {
        const deadUrl =
          await getUnusedUrl();

        const agent =
          spawnAgent({
            cloudUrl:
              deadUrl,

            databaseUrl:
              TEST_DATABASE_URL,
          });

        try {
          await waitFor(
            () =>
              agent
                .output()
                .includes(
                  "cloud connection failed"
                ),
            {
              timeoutMs: 6000,

              message:
                "Cloud outage was not detected",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          assert.equal(
            agent.output().includes(
              agent.secret
            ),
            false
          );

          assert.equal(
            agent.output().includes(
              TEST_DATABASE_URL
            ),
            false
          );

          console.log(
            "✅ 06 Cloud outage does not crash Edge"
          );
        } finally {
          await stopAgent(
            agent
          );
        }
      }
    );

    await t.test(
      "local PostgreSQL outage is reported to Cloud",
      async () => {
        const cloud =
          await createCloudStub();

        const badDb =
          "postgresql://edge_invalid:edge_invalid@127.0.0.1:1/maks_test";

        const agent =
          spawnAgent({
            cloudUrl:
              cloud.url,

            databaseUrl:
              badDb,
          });

        try {
          await waitFor(
            () =>
              cloud.requests
                .length >= 1,
            {
              timeoutMs: 8000,

              message:
                "Edge did not report local DB failure",
            }
          );

          const body =
            cloud.requests[0]
              .body;

          assert.equal(
            body
              ?.local_db_status,
            "error"
          );

          assert.equal(
            body
              ?.local_db_latency_ms,
            null
          );

          assert.equal(
            body
              ?.sync_status,
            "unknown"
          );

          assert.equal(
            body
              ?.last_sync_error,
            null
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          assert.equal(
            agent.output().includes(
              badDb
            ),
            false
          );

          console.log(
            "✅ 07 Local PostgreSQL failure is reported without killing Edge"
          );
        } finally {
          await stopAgent(
            agent
          );

          await cloud.close();
        }
      }
    );

    await t.test(
      "slow Cloud cannot create overlapping heartbeats",
      async () => {
        const cloud =
          await createCloudStub({
            delayMs: 7000,
          });

        const agent =
          spawnAgent({
            cloudUrl:
              cloud.url,

            databaseUrl:
              TEST_DATABASE_URL,

            heartbeatMs:
              "5000",
          });

        try {
          await waitFor(
            () =>
              cloud.requests
                .length >= 1,
            {
              timeoutMs: 5000,
            }
          );

          await sleep(5600);

          assert.equal(
            cloud.requests.length,
            1,
            "Second heartbeat overlapped while first was still in flight"
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          console.log(
            "✅ 08 Slow Cloud cannot create overlapping heartbeats"
          );
        } finally {
          await stopAgent(
            agent
          );

          await cloud.close();
        }
      }
    );

    await t.test(
      "automatic Edge push drains pending outbox and reports real sync telemetry",
      async () => {
        const localPool =
          new Pool({
            connectionString:
              TEST_DATABASE_URL,
          });

        let restaurantId =
          null;

        let cloud =
          null;

        let agent =
          null;

        try {
          const restaurant =
            await localPool.query(
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
              RETURNING id
              `,
              [
                `EDGE AGENT AUTO PUSH ${crypto.randomUUID()}`,
              ]
            );

          restaurantId =
            Number(
              restaurant
                .rows[0]
                .id
            );

          const eventId =
            crypto.randomUUID();

          const entityId =
            crypto.randomUUID();

          const payload = {
            schema_version:
              1,

            attack:
              "automatic-push",

            restaurant_id:
              restaurantId,
          };

          await localPool.query(
            `
            INSERT INTO
              public.edge_outbox
            (
              event_id,
              restaurant_id,
              event_type,
              entity_type,
              entity_id,
              idempotency_key,
              payload,
              payload_hash
            )
            VALUES
            (
              $1::uuid,
              $2,
              'pos.order.submitted',
              'order_batch',
              $3,
              $4,
              $5::jsonb,
              $6
            )
            `,
            [
              eventId,
              restaurantId,
              entityId,
              `agent-auto:${eventId}`,
              JSON.stringify(
                payload
              ),
              "a".repeat(
                64
              ),
            ]
          );

          cloud =
            await createSyncCloudStub({
              restaurantId,

              pushAvailable:
                true,
            });

          agent =
            spawnAgent({
              cloudUrl:
                cloud.url,

              databaseUrl:
                TEST_DATABASE_URL,

              heartbeatMs:
                "5000",

              syncMs:
                "1000",
            });

          /*
           * Automatic pull now runs beside push. A pull can
           * legitimately observe the outbox while it is still
           * pending and mark its own directional state pending.
           *
           * Recovery is complete only when the outbox is ACKed
           * AND the aggregate sync state has settled to synced.
           */
          await waitFor(
            async () => {
              const result =
                await localPool.query(
                  `
                  SELECT
                    o.status
                      AS outbox_status,

                    s.sync_status,
                    s.pending_outbox_events
                  FROM
                    public.edge_outbox o
                  LEFT JOIN
                    public.edge_sync_state s
                    ON
                      s.restaurant_id =
                        o.restaurant_id
                      AND
                      s.installation_id =
                        $2::uuid
                  WHERE
                    o.event_id =
                      $1::uuid
                  LIMIT 1
                  `,
                  [
                    eventId,
                    agent.installationId,
                  ]
                );

              const row =
                result.rows?.[0];

              return (
                row
                  ?.outbox_status ===
                  "acked" &&
                row
                  ?.sync_status ===
                  "synced" &&
                Number(
                  row
                    ?.pending_outbox_events ||
                  0
                ) === 0
              );
            },
            {
              timeoutMs:
                12000,

              message:
                "Automatic Edge push did not complete synced state",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          const pushRequests =
            cloud.requests.filter(
              (entry) =>
                entry.url ===
                "/edge/sync/push"
            );

          assert.ok(
            pushRequests.length >=
              1
          );

          assert.ok(
            pushRequests.some(
              (entry) =>
                entry.body
                  ?.events
                  ?.some(
                    (event) =>
                      event
                        ?.event_id ===
                      eventId
                  )
            )
          );

          const state =
            await localPool.query(
              `
              SELECT
                sync_status,
                pending_outbox_events,
                last_success_at,
                last_error
              FROM
                public.edge_sync_state
              WHERE
                restaurant_id = $1
                AND
                installation_id =
                  $2::uuid
              `,
              [
                restaurantId,
                agent.installationId,
              ]
            );

          assert.equal(
            state
              .rows?.[0]
              ?.sync_status,
            "synced"
          );

          assert.equal(
            Number(
              state
                .rows?.[0]
                ?.pending_outbox_events ||
              0
            ),
            0
          );

          assert.ok(
            state
              .rows?.[0]
              ?.last_success_at
          );

          assert.equal(
            state
              .rows?.[0]
              ?.last_error,
            null
          );

          /*
           * Wait for the next heartbeat so Control
           * Centre telemetry proves the sync result too.
           */
          await waitFor(
            () =>
              cloud.requests.some(
                (entry) =>
                  entry.url ===
                    "/edge/heartbeat" &&
                  entry.body
                    ?.sync_status ===
                    "synced" &&
                  Number(
                    entry.body
                      ?.pending_sync_events
                  ) === 0 &&
                  typeof entry.body
                    ?.last_sync_at ===
                    "string"
              ),
            {
              timeoutMs:
                9000,

              message:
                "Heartbeat did not report real synced state",
            }
          );

          const syncedHeartbeat =
            [
              ...cloud.requests,
            ]
              .reverse()
              .find(
                (entry) =>
                  entry.url ===
                    "/edge/heartbeat" &&
                  entry.body
                    ?.sync_status ===
                    "synced"
              );

          assert.ok(
            syncedHeartbeat
          );

          assert.ok(
            Number(
              syncedHeartbeat
                .body
                ?.uptime_seconds
            ) >= 0
          );

          assert.ok(
            Number(
              syncedHeartbeat
                .body
                ?.uptime_seconds
            ) < 120,
            "Edge uptime should represent this process, not machine uptime"
          );

          assert.equal(
            agent.output().includes(
              agent.secret
            ),
            false
          );

          assert.equal(
            agent.output().includes(
              TEST_DATABASE_URL
            ),
            false
          );

          console.log(
            "✅ 09 Automatic Edge push + real sync telemetry proven"
          );
        } finally {
          if (agent) {
            await stopAgent(
              agent
            );
          }

          if (cloud) {
            await cloud.close();
          }

          if (
            restaurantId
          ) {
            await localPool.query(
              `
              DELETE FROM
                public.restaurants
              WHERE
                id = $1
              `,
              [
                restaurantId,
              ]
            );
          }

          await localPool.end();
        }
      }
    );


    await t.test(
      "automatic Edge sync recovers when Cloud push returns",
      async () => {
        const localPool =
          new Pool({
            connectionString:
              TEST_DATABASE_URL,
          });

        let restaurantId =
          null;

        let cloud =
          null;

        let agent =
          null;

        try {
          const restaurant =
            await localPool.query(
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
              RETURNING id
              `,
              [
                `EDGE AGENT RECOVERY ${crypto.randomUUID()}`,
              ]
            );

          restaurantId =
            Number(
              restaurant
                .rows[0]
                .id
            );

          const eventId =
            crypto.randomUUID();

          const payload = {
            schema_version:
              1,

            attack:
              "cloud-recovery",

            restaurant_id:
              restaurantId,
          };

          await localPool.query(
            `
            INSERT INTO
              public.edge_outbox
            (
              event_id,
              restaurant_id,
              event_type,
              entity_type,
              entity_id,
              idempotency_key,
              payload,
              payload_hash
            )
            VALUES
            (
              $1::uuid,
              $2,
              'pos.order.submitted',
              'order_batch',
              $3,
              $4,
              $5::jsonb,
              $6
            )
            `,
            [
              eventId,
              restaurantId,
              crypto.randomUUID(),
              `agent-recovery:${eventId}`,
              JSON.stringify(
                payload
              ),
              "b".repeat(
                64
              ),
            ]
          );

          cloud =
            await createSyncCloudStub({
              restaurantId,

              pushAvailable:
                false,
            });

          agent =
            spawnAgent({
              cloudUrl:
                cloud.url,

              databaseUrl:
                TEST_DATABASE_URL,

              heartbeatMs:
                "5000",

              syncMs:
                "1000",
            });

          /*
           * Cloud heartbeat works, but sync/push fails.
           * The local event must remain durable.
           */
          await waitFor(
            async () => {
              const result =
                await localPool.query(
                  `
                  SELECT
                    status
                  FROM
                    public.edge_outbox
                  WHERE
                    event_id =
                      $1::uuid
                  `,
                  [
                    eventId,
                  ]
                );

              return (
                result
                  .rows?.[0]
                  ?.status ===
                "failed"
              );
            },
            {
              timeoutMs:
                10000,

              message:
                "Simulated Cloud outage did not leave event retryable",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          const failedState =
            await localPool.query(
              `
              SELECT
                sync_status,
                pending_outbox_events,
                consecutive_failures,
                last_error
              FROM
                public.edge_sync_state
              WHERE
                restaurant_id = $1
                AND
                installation_id =
                  $2::uuid
              `,
              [
                restaurantId,
                agent.installationId,
              ]
            );

          assert.equal(
            failedState
              .rows?.[0]
              ?.sync_status,
            "error"
          );

          assert.ok(
            Number(
              failedState
                .rows?.[0]
                ?.pending_outbox_events ||
              0
            ) >= 1
          );

          assert.ok(
            Number(
              failedState
                .rows?.[0]
                ?.consecutive_failures ||
              0
            ) >= 1
          );

          assert.equal(
            typeof failedState
              .rows?.[0]
              ?.last_error,
            "string"
          );

          /*
           * Internet/Cloud comes back.
           *
           * No manual push command.
           * No direct outbox modification.
           */
          cloud.state.pushAvailable =
            true;

          /*
           * Recovery is complete only when BOTH:
           *
           * 1. the durable outbox event is ACKed, and
           * 2. edge_sync_state has completed its final
           *    syncing -> synced transition.
           *
           * The outbox ACK intentionally happens before
           * the final telemetry/state update, so waiting
           * on ACK alone creates a legitimate race.
           */
          await waitFor(
            async () => {
              const result =
                await localPool.query(
                  `
                  SELECT
                    o.status
                      AS outbox_status,

                    s.sync_status,
                    s.pending_outbox_events,
                    s.consecutive_failures,
                    s.last_success_at,
                    s.last_error
                  FROM
                    public.edge_outbox o
                  LEFT JOIN
                    public.edge_sync_state s
                    ON
                      s.restaurant_id =
                        o.restaurant_id
                      AND
                      s.installation_id =
                        $2::uuid
                  WHERE
                    o.event_id =
                      $1::uuid
                  LIMIT 1
                  `,
                  [
                    eventId,
                    agent.installationId,
                  ]
                );

              const row =
                result.rows?.[0];

              return (
                row
                  ?.outbox_status ===
                  "acked" &&
                row
                  ?.sync_status ===
                  "synced" &&
                Number(
                  row
                    ?.pending_outbox_events ||
                  0
                ) === 0 &&
                Number(
                  row
                    ?.consecutive_failures ||
                  0
                ) === 0 &&
                Boolean(
                  row
                    ?.last_success_at
                ) &&
                row
                  ?.last_error ===
                  null
              );
            },
            {
              timeoutMs:
                12000,

              message:
                "Edge ACKed the event but did not complete synced recovery state",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          const pushes =
            cloud.requests.filter(
              (entry) =>
                entry.url ===
                "/edge/sync/push"
            );

          assert.ok(
            pushes.length >=
              2,
            "Expected failed push followed by automatic retry"
          );

          assert.ok(
            pushes.some(
              (entry) =>
                entry
                  .responseStatus ===
                503
            )
          );

          assert.ok(
            pushes.some(
              (entry) =>
                entry
                  .responseStatus ===
                200
            )
          );

          const recoveredState =
            await localPool.query(
              `
              SELECT
                sync_status,
                pending_outbox_events,
                consecutive_failures,
                last_success_at,
                last_error
              FROM
                public.edge_sync_state
              WHERE
                restaurant_id = $1
                AND
                installation_id =
                  $2::uuid
              `,
              [
                restaurantId,
                agent.installationId,
              ]
            );

          assert.equal(
            recoveredState
              .rows?.[0]
              ?.sync_status,
            "synced"
          );

          assert.equal(
            Number(
              recoveredState
                .rows?.[0]
                ?.pending_outbox_events ||
              0
            ),
            0
          );

          assert.equal(
            Number(
              recoveredState
                .rows?.[0]
                ?.consecutive_failures ||
              0
            ),
            0
          );

          assert.ok(
            recoveredState
              .rows?.[0]
              ?.last_success_at
          );

          assert.equal(
            recoveredState
              .rows?.[0]
              ?.last_error,
            null
          );

          console.log(
            "✅ 10 Cloud outage backlog automatically recovered"
          );
        } finally {
          if (agent) {
            await stopAgent(
              agent
            );
          }

          if (cloud) {
            await cloud.close();
          }

          if (
            restaurantId
          ) {
            await localPool.query(
              `
              DELETE FROM
                public.restaurants
              WHERE
                id = $1
              `,
              [
                restaurantId,
              ]
            );
          }

          await localPool.end();
        }
      }
    );


    await t.test(
      "automatic Cloud pull stores one durable local event and ACKs Cloud",
      async () => {
        const localPool =
          new Pool({
            connectionString:
              TEST_DATABASE_URL,
          });

        let restaurantId =
          null;

        let cloud =
          null;

        let agent =
          null;

        try {
          const restaurant =
            await localPool.query(
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
              RETURNING id
              `,
              [
                `EDGE AGENT AUTO PULL ${crypto.randomUUID()}`,
              ]
            );

          restaurantId =
            Number(
              restaurant
                .rows[0]
                .id
            );

          const eventId =
            crypto.randomUUID();

          const payload = {
            schema_version:
              1,

            attack:
              "automatic-pull",

            restaurant_id:
              restaurantId,
          };

          const cloudEvent = {
            event_id:
              eventId,

            restaurant_id:
              restaurantId,

            event_type:
              "restaurant.config.updated",

            entity_type:
              "restaurant_config",

            entity_id:
              String(
                restaurantId
              ),

            payload,

            payload_hash:
              hashJson(
                payload
              ),
          };

          cloud =
            await createSyncCloudStub({
              restaurantId,

              pullAvailable:
                true,

              pullEvents: [
                cloudEvent,
              ],
            });

          agent =
            spawnAgent({
              cloudUrl:
                cloud.url,

              databaseUrl:
                TEST_DATABASE_URL,

              heartbeatMs:
                "5000",

              syncMs:
                "1000",

              pullMs:
                "1000",
            });

          await waitFor(
            async () => {
              const inbox =
                await localPool.query(
                  `
                  SELECT
                    COUNT(*)::int
                      AS count
                  FROM
                    public.edge_inbox
                  WHERE
                    restaurant_id = $1
                    AND
                    event_id =
                      $2::uuid
                  `,
                  [
                    restaurantId,
                    eventId,
                  ]
                );

              return (
                Number(
                  inbox
                    .rows?.[0]
                    ?.count ||
                  0
                ) === 1 &&
                cloud
                  .state
                  .pullAckedEventIds
                  .has(
                    eventId
                  )
              );
            },
            {
              timeoutMs:
                10000,

              message:
                "Automatic Edge pull did not durably receive and ACK Cloud event",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          const inbox =
            await localPool.query(
              `
              SELECT
                status,
                payload_hash
              FROM
                public.edge_inbox
              WHERE
                restaurant_id = $1
                AND
                event_id =
                  $2::uuid
              `,
              [
                restaurantId,
                eventId,
              ]
            );

          assert.equal(
            inbox.rows.length,
            1
          );

          assert.equal(
            inbox
              .rows[0]
              .status,
            "received"
          );

          assert.equal(
            inbox
              .rows[0]
              .payload_hash,
            cloudEvent
              .payload_hash
          );

          const pullRequests =
            cloud.requests.filter(
              (entry) =>
                entry.url ===
                "/edge/sync/pull"
            );

          const ackRequests =
            cloud.requests.filter(
              (entry) =>
                entry.url ===
                "/edge/sync/pull/ack"
            );

          assert.ok(
            pullRequests.some(
              (entry) =>
                entry
                  .responseStatus ===
                200
            )
          );

          assert.ok(
            ackRequests.some(
              (entry) =>
                entry
                  .body
                  ?.event_ids
                  ?.includes(
                    eventId
                  )
            )
          );

          const state =
            await localPool.query(
              `
              SELECT
                sync_status,
                pull_status,
                pending_inbox_events,
                pull_consecutive_failures,
                last_pull_success_at,
                last_pull_error
              FROM
                public.edge_sync_state
              WHERE
                restaurant_id = $1
                AND
                installation_id =
                  $2::uuid
              `,
              [
                restaurantId,
                agent.installationId,
              ]
            );

          assert.equal(
            state
              .rows?.[0]
              ?.sync_status,
            "pending"
          );

          /*
           * Pull transport itself is healthy once the event
           * is durably received and ACKed. The aggregate
           * remains pending because the inbox event has not
           * been applied to business tables yet.
           */
          assert.equal(
            state
              .rows?.[0]
              ?.pull_status,
            "synced"
          );

          assert.equal(
            Number(
              state
                .rows?.[0]
                ?.pending_inbox_events ||
              0
            ),
            1
          );

          assert.equal(
            Number(
              state
                .rows?.[0]
                ?.pull_consecutive_failures ||
              0
            ),
            0
          );

          assert.ok(
            state
              .rows?.[0]
              ?.last_pull_success_at
          );

          assert.equal(
            state
              .rows?.[0]
              ?.last_pull_error,
            null
          );

          assert.equal(
            agent.output().includes(
              agent.secret
            ),
            false
          );

          assert.equal(
            agent.output().includes(
              TEST_DATABASE_URL
            ),
            false
          );

          console.log(
            "✅ 11 Automatic Cloud → Edge pull + ACK proven"
          );
        } finally {
          if (agent) {
            await stopAgent(
              agent
            );
          }

          if (cloud) {
            await cloud.close();
          }

          if (
            restaurantId
          ) {
            await localPool.query(
              `
              DELETE FROM
                public.restaurants
              WHERE
                id = $1
              `,
              [
                restaurantId,
              ]
            );
          }

          await localPool.end();
        }
      }
    );


    await t.test(
      "automatic Cloud pull recovers after outage without restart",
      async () => {
        const localPool =
          new Pool({
            connectionString:
              TEST_DATABASE_URL,
          });

        let restaurantId =
          null;

        let cloud =
          null;

        let agent =
          null;

        try {
          const restaurant =
            await localPool.query(
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
              RETURNING id
              `,
              [
                `EDGE AGENT PULL RECOVERY ${crypto.randomUUID()}`,
              ]
            );

          restaurantId =
            Number(
              restaurant
                .rows[0]
                .id
            );

          const eventId =
            crypto.randomUUID();

          const payload = {
            schema_version:
              1,

            attack:
              "automatic-pull-recovery",

            restaurant_id:
              restaurantId,
          };

          const cloudEvent = {
            event_id:
              eventId,

            restaurant_id:
              restaurantId,

            event_type:
              "restaurant.config.updated",

            entity_type:
              "restaurant_config",

            entity_id:
              String(
                restaurantId
              ),

            payload,

            payload_hash:
              hashJson(
                payload
              ),
          };

          cloud =
            await createSyncCloudStub({
              restaurantId,

              pullAvailable:
                false,

              pullEvents: [
                cloudEvent,
              ],
            });

          agent =
            spawnAgent({
              cloudUrl:
                cloud.url,

              databaseUrl:
                TEST_DATABASE_URL,

              heartbeatMs:
                "5000",

              syncMs:
                "1000",

              pullMs:
                "1000",
            });

          await waitFor(
            async () => {
              const result =
                await localPool.query(
                  `
                  SELECT
                    sync_status,
                    pull_status,
                    pull_consecutive_failures,
                    last_pull_error
                  FROM
                    public.edge_sync_state
                  WHERE
                    restaurant_id = $1
                    AND
                    installation_id =
                      $2::uuid
                  `,
                  [
                    restaurantId,
                    agent.installationId,
                  ]
                );

              const row =
                result.rows?.[0];

              return (
                row
                  ?.sync_status ===
                  "error" &&
                row
                  ?.pull_status ===
                  "error" &&
                Number(
                  row
                    ?.pull_consecutive_failures ||
                  0
                ) >= 1 &&
                typeof row
                  ?.last_pull_error ===
                  "string"
              );
            },
            {
              timeoutMs:
                10000,

              message:
                "Simulated Cloud pull outage did not produce directional error state",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          const beforeRecovery =
            await localPool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.edge_inbox
              WHERE
                restaurant_id = $1
                AND
                event_id =
                  $2::uuid
              `,
              [
                restaurantId,
                eventId,
              ]
            );

          assert.equal(
            Number(
              beforeRecovery
                .rows?.[0]
                ?.count ||
              0
            ),
            0
          );

          /*
           * Cloud becomes reachable again.
           *
           * No agent restart.
           * No manual pull command.
           */
          cloud.state.pullAvailable =
            true;

          await waitFor(
            async () => {
              const result =
                await localPool.query(
                  `
                  SELECT
                    (
                      SELECT
                        COUNT(*)::int
                      FROM
                        public.edge_inbox
                      WHERE
                        restaurant_id = $1
                        AND
                        event_id =
                          $2::uuid
                    ) AS inbox_count,

                    s.sync_status,
                    s.pull_status,
                    s.pending_inbox_events,
                    s.pull_consecutive_failures,
                    s.last_pull_success_at,
                    s.last_pull_error
                  FROM
                    public.edge_sync_state s
                  WHERE
                    s.restaurant_id = $1
                    AND
                    s.installation_id =
                      $3::uuid
                  `,
                  [
                    restaurantId,
                    eventId,
                    agent.installationId,
                  ]
                );

              const row =
                result.rows?.[0];

              return (
                Number(
                  row
                    ?.inbox_count ||
                  0
                ) === 1 &&
                cloud
                  .state
                  .pullAckedEventIds
                  .has(
                    eventId
                  ) &&
                row
                  ?.sync_status ===
                  "pending" &&
                row
                  ?.pull_status ===
                  "synced" &&
                Number(
                  row
                    ?.pending_inbox_events ||
                  0
                ) === 1 &&
                Number(
                  row
                    ?.pull_consecutive_failures ||
                  0
                ) === 0 &&
                Boolean(
                  row
                    ?.last_pull_success_at
                ) &&
                row
                  ?.last_pull_error ===
                  null
              );
            },
            {
              timeoutMs:
                12000,

              message:
                "Automatic Cloud pull did not recover after simulated outage",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          const pullRequests =
            cloud.requests.filter(
              (entry) =>
                entry.url ===
                "/edge/sync/pull"
            );

          assert.ok(
            pullRequests.some(
              (entry) =>
                entry
                  .responseStatus ===
                503
            ),
            "Expected at least one failed automatic pull"
          );

          assert.ok(
            pullRequests.some(
              (entry) =>
                entry
                  .responseStatus ===
                200
            ),
            "Expected automatic pull recovery without restart"
          );

          console.log(
            "✅ 12 Cloud pull outage automatically recovered"
          );
        } finally {
          if (agent) {
            await stopAgent(
              agent
            );
          }

          if (cloud) {
            await cloud.close();
          }

          if (
            restaurantId
          ) {
            await localPool.query(
              `
              DELETE FROM
                public.restaurants
              WHERE
                id = $1
              `,
              [
                restaurantId,
              ]
            );
          }

          await localPool.end();
        }
      }
    );


    await t.test(
      "slow Cloud pull cannot overlap itself",
      async () => {
        const localPool =
          new Pool({
            connectionString:
              TEST_DATABASE_URL,
          });

        let restaurantId =
          null;

        let cloud =
          null;

        let agent =
          null;

        try {
          const restaurant =
            await localPool.query(
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
              RETURNING id
              `,
              [
                `EDGE AGENT PULL OVERLAP ${crypto.randomUUID()}`,
              ]
            );

          restaurantId =
            Number(
              restaurant
                .rows[0]
                .id
            );

          cloud =
            await createSyncCloudStub({
              restaurantId,

              pullAvailable:
                true,

              pullDelayMs:
                2500,
            });

          agent =
            spawnAgent({
              cloudUrl:
                cloud.url,

              databaseUrl:
                TEST_DATABASE_URL,

              heartbeatMs:
                "5000",

              syncMs:
                "1000",

              pullMs:
                "1000",
            });

          await waitFor(
            () =>
              cloud.requests.some(
                (entry) =>
                  entry.url ===
                  "/edge/sync/pull"
              ),
            {
              timeoutMs:
                5000,

              message:
                "Agent did not start automatic pull",
            }
          );

          /*
           * The first pull is deliberately still in flight
           * while another interval tick occurs.
           */
          await sleep(
            1500
          );

          const pullRequests =
            cloud.requests.filter(
              (entry) =>
                entry.url ===
                "/edge/sync/pull"
            );

          assert.equal(
            pullRequests.length,
            1,
            "Second pull overlapped while first was still in flight"
          );

          assert.equal(
            cloud
              .state
              .maxConcurrentPullRequests,
            1,
            "Automatic pull concurrency exceeded one request"
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          console.log(
            "✅ 13 Slow Cloud cannot create overlapping pulls"
          );
        } finally {
          if (agent) {
            await stopAgent(
              agent
            );
          }

          if (cloud) {
            await cloud.close();
          }

          if (
            restaurantId
          ) {
            await localPool.query(
              `
              DELETE FROM
                public.restaurants
              WHERE
                id = $1
              `,
              [
                restaurantId,
              ]
            );
          }

          await localPool.end();
        }
      }
    );


    console.log(
      ""
    );

    console.log(
      "========================================"
    );

    console.log(
      "MAKS EDGE AGENT ATTACK EXECUTION COMPLETE"
    );

    console.log(
      "========================================"
    );
  }
);
