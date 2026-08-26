"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { Pool } = require("pg");

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
    timeout: 60000,
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
            typeof body
              ?.last_sync_error,
            "string"
          );

          assert.ok(
            body
              .last_sync_error
              .length > 0
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

    console.log(
      ""
    );

    console.log(
      "========================================"
    );

    console.log(
      "✅ MAKS EDGE AGENT ATTACK: 8/8"
    );

    console.log(
      "========================================"
    );
  }
);
