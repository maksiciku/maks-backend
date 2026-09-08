"use strict";

const assert =
  require("node:assert/strict");

const bcrypt =
  require("bcryptjs");

const crypto =
  require("node:crypto");

const express =
  require("express");

const fs =
  require("node:fs");

const fsp =
  require("node:fs/promises");

const http =
  require("node:http");

const net =
  require("node:net");

const os =
  require("node:os");

const path =
  require("node:path");

const {
  once,
} = require(
  "node:events"
);

const {
  execFileSync,
  spawn,
} = require(
  "node:child_process"
);

const test =
  require("node:test");

const {
  Pool,
} = require(
  "pg"
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
  TEST_PASSWORD,
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
  qGet,
  qRun,
  getPool,
} = require(
  "../../dbCompat"
);

const {
  generateEdgeCredentials,
} = require(
  "../../utils/edgeAuth"
);

const edgeRoutes =
  require(
    "../../routes/edgeRoutes"
);


const DATABASE_URL =
  String(
    process.env
      .DATABASE_URL ||
    ""
  ).trim();

const ROOT =
  path.resolve(
    __dirname,
    "../.."
  );

const AGENT_PATH =
  path.join(
    ROOT,
    "edge",
    "agent.js"
  );

const SERVER_PATH =
  path.join(
    ROOT,
    "server.js"
  );


function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}


async function waitFor(
  predicate,
  {
    timeoutMs = 20000,
    intervalMs = 100,
    message =
      "Timed out waiting for condition",
  } = {}
) {
  const deadline =
    Date.now() +
    timeoutMs;

  while (
    Date.now() <
    deadline
  ) {
    try {
      if (
        await predicate()
      ) {
        return;
      }
    } catch {}

    await sleep(
      intervalMs
    );
  }

  throw new Error(
    message
  );
}


function safeTail(text) {
  return String(
    text ||
    ""
  ).slice(
    -5000
  );
}


function resolvePostgresPrefix() {
  const explicit =
    String(
      process.env
        .MAKS_TEST_POSTGRES_PREFIX ||
      ""
    ).trim();

  if (explicit) {
    return explicit;
  }

  try {
    return execFileSync(
      "brew",
      [
        "--prefix",
        "postgresql@16",
      ],
      {
        encoding:
          "utf8",
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    ).trim();
  } catch {
    throw new Error(
      "PostgreSQL 16 Homebrew prefix was not found. " +
      "Set MAKS_TEST_POSTGRES_PREFIX to the PostgreSQL 16 prefix."
    );
  }
}


function postgresTools() {
  const prefix =
    resolvePostgresPrefix();

  const bin =
    path.join(
      prefix,
      "bin"
    );

  const names = [
    "initdb",
    "pg_ctl",
    "createdb",
    "pg_dump",
    "psql",
  ];

  const tools = {};

  for (
    const name of names
  ) {
    const file =
      path.join(
        bin,
        name
      );

    if (
      !fs.existsSync(
        file
      )
    ) {
      throw new Error(
        `Required PostgreSQL binary missing: ${file}`
      );
    }

    tools[name] =
      file;
  }

  return tools;
}


function runTool(
  file,
  args,
  {
    env =
      process.env,
    cwd =
      ROOT,
    timeoutMs =
      45000,
  } = {}
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const child =
        spawn(
          file,
          args,
          {
            cwd,
            env,
            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
          }
        );

      const stdout = [];
      const stderr = [];

      const timer =
        setTimeout(
          () => {
            child.kill(
              "SIGKILL"
            );
          },
          timeoutMs
        );

      child.stdout.on(
        "data",
        (chunk) => {
          stdout.push(
            String(
              chunk
            )
          );
        }
      );

      child.stderr.on(
        "data",
        (chunk) => {
          stderr.push(
            String(
              chunk
            )
          );
        }
      );

      child.on(
        "error",
        (error) => {
          clearTimeout(
            timer
          );
          reject(
            error
          );
        }
      );

      child.on(
        "close",
        (
          code,
          signal
        ) => {
          clearTimeout(
            timer
          );

          if (
            code === 0
          ) {
            resolve({
              stdout:
                stdout.join(""),
              stderr:
                stderr.join(""),
            });
            return;
          }

          reject(
            new Error(
              `${path.basename(file)} failed ` +
              `(code=${code}, signal=${signal || "none"}):\n` +
              safeTail(
                stderr.join("")
              )
            )
          );
        }
      );
    }
  );
}


function pgEnvFromUrl(
  databaseUrl
) {
  const parsed =
    new URL(
      databaseUrl
    );

  if (
    ![
      "postgres:",
      "postgresql:",
    ].includes(
      parsed.protocol
    )
  ) {
    throw new Error(
      "Expected a PostgreSQL DATABASE_URL"
    );
  }

  const env = {
    ...process.env,

    PGHOST:
      parsed.hostname,

    PGPORT:
      parsed.port ||
      "5432",

    PGUSER:
      decodeURIComponent(
        parsed.username
      ),

    PGDATABASE:
      decodeURIComponent(
        parsed.pathname
          .replace(
            /^\/+/,
            ""
          )
      ),
  };

  if (
    parsed.password
  ) {
    env.PGPASSWORD =
      decodeURIComponent(
        parsed.password
      );
  } else {
    delete env
      .PGPASSWORD;
  }

  return env;
}


async function getFreePort() {
  const server =
    net.createServer();

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

  const port =
    Number(
      address.port
    );

  await new Promise(
    (
      resolve,
      reject
    ) => {
      server.close(
        (error) => {
          if (error) {
            reject(
              error
            );
            return;
          }

          resolve();
        }
      );
    }
  );

  return port;
}


async function isPortOpen(
  port
) {
  return new Promise(
    (resolve) => {
      const socket =
        net.createConnection({
          host:
            "127.0.0.1",
          port,
        });

      const finish =
        (value) => {
          socket
            .removeAllListeners();

          socket.destroy();

          resolve(
            value
          );
        };

      socket.setTimeout(
        300
      );

      socket.once(
        "connect",
        () =>
          finish(
            true
          )
      );

      socket.once(
        "timeout",
        () =>
          finish(
            false
          )
      );

      socket.once(
        "error",
        () =>
          finish(
            false
          )
      );
    }
  );
}


async function startIsolatedPostgres({
  cloudDatabaseUrl,
}) {
  const tools =
    postgresTools();

  const root =
    await fsp.mkdtemp(
      path.join(
        os.tmpdir(),
        "maks-pos-offline-two-pg-"
      )
    );

  const dataDir =
    path.join(
      root,
      "data"
    );

  const schemaFile =
    path.join(
      root,
      "cloud-schema.sql"
    );

  const logFile =
    path.join(
      root,
      "postgres.log"
    );

  const port =
    await getFreePort();

  let started =
    false;

  try {
    await runTool(
      tools.initdb,
      [
        "-D",
        dataDir,
        "-A",
        "trust",
        "-U",
        "maksedge_test",
        "--no-locale",
      ],
      {
        timeoutMs:
          60000,
      }
    );

    await runTool(
      tools.pg_ctl,
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-o",
        `-F -p ${port} -h 127.0.0.1`,
        "-w",
        "start",
      ],
      {
        timeoutMs:
          60000,
      }
    );

    started =
      true;

    const adminEnv = {
      ...process.env,

      PGHOST:
        "127.0.0.1",

      PGPORT:
        String(
          port
        ),

      PGUSER:
        "maksedge_test",

      PGDATABASE:
        "postgres",
    };

    await runTool(
      tools.createdb,
      [
        "maks_test",
      ],
      {
        env:
          adminEnv,
      }
    );

    await runTool(
      tools.pg_dump,
      [
        "--schema-only",
        "--no-owner",
        "--no-privileges",
        "--file",
        schemaFile,
      ],
      {
        env:
          pgEnvFromUrl(
            cloudDatabaseUrl
          ),
        timeoutMs:
          90000,
      }
    );

    const edgeEnv = {
      ...adminEnv,

      PGDATABASE:
        "maks_test",
    };

    await runTool(
      tools.psql,
      [
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        schemaFile,
      ],
      {
        env:
          edgeEnv,
        timeoutMs:
          90000,
      }
    );

    const databaseUrl =
      `postgresql://maksedge_test@127.0.0.1:${port}/maks_test`;

    const pool =
      new Pool({
        connectionString:
          databaseUrl,
        max:
          5,
      });

    const identity =
      await pool.query(
        `
        SELECT
          current_database()
            AS db,
          inet_server_port()
            AS port
        `
      );

    assert.equal(
      identity.rows[0]
        .db,
      "maks_test",
      "REFUSED: isolated Edge database must be named maks_test"
    );

    assert.equal(
      Number(
        identity.rows[0]
          .port
      ),
      port
    );

    return {
      tools,
      root,
      dataDir,
      logFile,
      port,
      databaseUrl,
      pool,

      async stop() {
        try {
          await pool
            .end();
        } finally {
          if (
            started
          ) {
            await runTool(
              tools.pg_ctl,
              [
                "-D",
                dataDir,
                "-m",
                "fast",
                "-w",
                "stop",
              ],
              {
                timeoutMs:
                  30000,
              }
            ).catch(
              () => {}
            );

            started =
              false;
          }

          await fsp.rm(
            root,
            {
              recursive:
                true,
              force:
                true,
            }
          );
        }
      },
    };
  } catch (
    error
  ) {
    if (
      started
    ) {
      await runTool(
        tools.pg_ctl,
        [
          "-D",
          dataDir,
          "-m",
          "fast",
          "-w",
          "stop",
        ],
        {
          timeoutMs:
            30000,
        }
      ).catch(
        () => {}
      );
    }

    await fsp.rm(
      root,
      {
        recursive:
          true,
        force:
          true,
      }
    ).catch(
      () => {}
    );

    throw error;
  }
}


function makeCloudServer() {
  const app =
    express();

  app.use(
    express.json({
      limit:
        "10mb",
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

  return http
    .createServer(
      app
    );
}


async function listenCloud(
  server,
  port
) {
  server.listen(
    port,
    "127.0.0.1"
  );

  await once(
    server,
    "listening"
  );

  return port;
}


async function closeCloud(
  server
) {
  if (
    !server ||
    !server.listening
  ) {
    return;
  }

  await new Promise(
    (
      resolve,
      reject
    ) => {
      server.close(
        (error) => {
          if (
            error
          ) {
            reject(
              error
            );
            return;
          }

          resolve();
        }
      );
    }
  );
}


function captureChild(
  child
) {
  const stdout = [];
  const stderr = [];

  child.stdout.on(
    "data",
    (chunk) => {
      stdout.push(
        String(
          chunk
        )
      );
    }
  );

  child.stderr.on(
    "data",
    (chunk) => {
      stderr.push(
        String(
          chunk
        )
      );
    }
  );

  return {
    child,
    stdout,
    stderr,

    output() {
      return (
        stdout.join("") +
        "\n" +
        stderr.join("")
      );
    },
  };
}


function spawnAgent({
  cloudUrl,
  edgeDatabaseUrl,
  installationId,
  edgeSecret,
}) {
  const child =
    spawn(
      process.execPath,
      [
        AGENT_PATH,
      ],
      {
        cwd:
          ROOT,

        env: {
          ...process.env,

          DB_DRIVER:
            "pg",

          DATABASE_URL:
            "postgresql://127.0.0.1:1/poison",

          MAKS_RUNTIME_ROLE:
            "edge",

          MAKS_EDGE_CLOUD_URL:
            cloudUrl,

          MAKS_EDGE_INSTALLATION_ID:
            installationId,

          MAKS_EDGE_SECRET:
            edgeSecret,

          MAKS_EDGE_DATABASE_URL:
            edgeDatabaseUrl,

          MAKS_EDGE_VERSION:
            "edge-pos-offline-two-postgres-e2e-attack",

          MAKS_EDGE_HEARTBEAT_MS:
            "1000",

          MAKS_EDGE_SYNC_MS:
            "1000",

          MAKS_EDGE_PULL_MS:
            "60000",

          MAKS_EDGE_APPLY_MS:
            "60000",

          MAKS_EDGE_PROMOTION_ASSET_MS:
            "60000",
        },

        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    );

  return captureChild(
    child
  );
}


function spawnEdgeServer({
  edgeDatabaseUrl,
  port,
}) {
  const child =
    spawn(
      process.execPath,
      [
        SERVER_PATH,
      ],
      {
        cwd:
          ROOT,

        env: {
          ...process.env,

          DB_DRIVER:
            "pg",

          DATABASE_URL:
            edgeDatabaseUrl,

          MAKS_EDGE_DATABASE_URL:
            edgeDatabaseUrl,

          MAKS_RUNTIME_ROLE:
            "edge",

          MAKS_TEST_MODE:
            "1",

          NODE_ENV:
            "test",

          HOST:
            "127.0.0.1",

          PORT:
            String(
              port
            ),
        },

        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    );

  return captureChild(
    child
  );
}


async function stopChild(
  processInfo
) {
  if (
    !processInfo
      ?.child ||
    processInfo
      .child
      .exitCode !==
      null
  ) {
    return;
  }

  processInfo.child.kill(
    "SIGTERM"
  );

  await Promise.race([
    once(
      processInfo.child,
      "exit"
    ),

    sleep(
      4000
    ).then(
      () => {
        if (
          processInfo
            .child
            .exitCode ===
          null
        ) {
          processInfo
            .child
            .kill(
              "SIGKILL"
            );
        }
      }
    ),
  ]);
}


async function jsonFetch(
  url,
  {
    method =
      "GET",
    headers = {},
    body,
  } = {}
) {
  const response =
    await fetch(
      url,
      {
        method,

        headers: {
          ...headers,

          ...(
            body ===
            undefined
              ? {}
              : {
                  "content-type":
                    "application/json",
                }
          ),
        },

        ...(
          body ===
          undefined
            ? {}
            : {
                body:
                  JSON.stringify(
                    body
                  ),
              }
        ),
      }
    );

  let data =
    null;

  const text =
    await response
      .text();

  if (
    text
  ) {
    try {
      data =
        JSON.parse(
          text
        );
    } catch {
      data = {
        raw:
          text,
      };
    }
  }

  return {
    status:
      response.status,
    data,
  };
}


async function createCloudRestaurant({
  pool,
  token,
}) {
  const result =
    await pool.query(
      `
      INSERT INTO
        public.restaurants
      (
        name,
        timezone,
        account_status,
        billing_status,
        stock_deduction_enabled,
        hold_qr_kiosk_until_paid,
        portion_tracking_mode,
        selling_mode,
        service_charge_enabled,
        service_charge_rate,
        manual_discounts_enabled,
        max_manual_discount_percent,
        service_charge_vat_mode
      )
      VALUES
      (
        $1,
        'Europe/London',
        'active',
        'active',
        FALSE,
        FALSE,
        'off',
        'pos_only',
        FALSE,
        10.00,
        TRUE,
        100.00,
        'discretionary'
      )
      RETURNING
        id
      `,
      [
        `POS OFFLINE CLOUD ${token}`,
      ]
    );

  return Number(
    result.rows[0]
      .id
  );
}


async function seedEdgeRestaurant({
  pool,
  restaurantId,
  token,
}) {
  const passwordHash =
    await bcrypt.hash(
      TEST_PASSWORD,
      10
    );

  await pool.query(
    "BEGIN"
  );

  try {
    await pool.query(
      `
      INSERT INTO
        public.restaurants
      (
        id,
        name,
        timezone,
        account_status,
        billing_status,
        stock_deduction_enabled,
        hold_qr_kiosk_until_paid,
        portion_tracking_mode,
        selling_mode,
        service_charge_enabled,
        service_charge_rate,
        manual_discounts_enabled,
        max_manual_discount_percent,
        service_charge_vat_mode
      )
      VALUES
      (
        $1,
        $2,
        'Europe/London',
        'active',
        'active',
        FALSE,
        FALSE,
        'off',
        'pos_only',
        FALSE,
        10.00,
        TRUE,
        100.00,
        'discretionary'
      )
      `,
      [
        restaurantId,
        `POS OFFLINE EDGE ${token}`,
      ]
    );

    const owner =
      await pool.query(
        `
        INSERT INTO
          public.users
        (
          username,
          password,
          password_hash,
          role,
          restaurant_id,
          is_active,
          can_pos_login,
          can_backoffice_login,
          full_name,
          permissions
        )
        VALUES
        (
          $1,
          $2,
          $2,
          'owner',
          $3,
          TRUE,
          TRUE,
          TRUE,
          'Offline Edge Owner',
          '["*"]'
        )
        RETURNING
          id
        `,
        [
          `maks_edge_offline_${token}`,
          passwordHash,
          restaurantId,
        ]
      );

    const ownerId =
      Number(
        owner.rows[0]
          .id
      );

    await pool.query(
      `
      INSERT INTO
        public.restaurant_members
      (
        restaurant_id,
        user_id,
        role,
        status,
        is_active,
        authority,
        job_title,
        permissions
      )
      VALUES
      (
        $1,
        $2,
        'owner',
        'active',
        TRUE,
        'owner',
        'Owner',
        '["*"]'::jsonb
      )
      `,
      [
        restaurantId,
        ownerId,
      ]
    );

    const category =
      await pool.query(
        `
        INSERT INTO
          public.categories
        (
          name,
          type,
          restaurant_id,
          station
        )
        VALUES
        (
          'Offline Mains',
          'meal',
          $1,
          'kitchen'
        )
        RETURNING
          id
        `,
        [
          restaurantId,
        ]
      );

    const categoryId =
      Number(
        category.rows[0]
          .id
      );

    const meal =
      await pool.query(
        `
        INSERT INTO
          public.meals
        (
          name,
          ingredients,
          price,
          category,
          category_id,
          restaurant_id,
          is_available,
          out_of_stock,
          vat_rate,
          options_schema
        )
        VALUES
        (
          'OFFLINE EDGE BURGER',
          '[]'::jsonb,
          12.50,
          'Meals',
          $1,
          $2,
          TRUE,
          FALSE,
          20,
          $3::jsonb
        )
        RETURNING
          id
        `,
        [
          categoryId,
          restaurantId,
          JSON.stringify([
            {
              id:
                "test_side",
              label:
                "Side",
              type:
                "single",
              required:
                true,
              choices: [
                {
                  id:
                    "test_chips",
                  label:
                    "Chips",
                  priceDelta:
                    0,
                },
                {
                  id:
                    "test_salad",
                  label:
                    "Salad",
                  priceDelta:
                    1.5,
                },
              ],
            },
          ]),
        ]
      );

    const mealId =
      Number(
        meal.rows[0]
          .id
      );

    /*
     * Make the Edge-local BIGSERIAL range visibly different
     * from Cloud. This proves Cloud does not reuse Edge row IDs.
     */
    const sequence =
      await pool.query(
        `
        SELECT
          pg_get_serial_sequence(
            'public.pos_orders',
            'id'
          ) AS name
        `
      );

    assert.ok(
      sequence.rows[0]
        ?.name,
      "pos_orders sequence was not found"
    );

    await pool.query(
      `
      SELECT
        setval(
          pg_get_serial_sequence(
            'public.pos_orders',
            'id'
          ),
          900000000,
          TRUE
        )
      `
    );

    await pool.query(
      "COMMIT"
    );

    return {
      username:
        `maks_edge_offline_${token}`,
      ownerId,
      categoryId,
      mealId,
    };
  } catch (
    error
  ) {
    await pool.query(
      "ROLLBACK"
    );

    throw error;
  }
}


async function edgeOutboxForBatch({
  pool,
  restaurantId,
  batchId,
}) {
  const result =
    await pool.query(
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
        status,
        retry_count,
        acked_at,
        last_error
      FROM
        public.edge_outbox
      WHERE
        restaurant_id = $1
        AND
        event_type =
          'pos.order.submitted'
        AND
        entity_id = $2
      ORDER BY
        id DESC
      LIMIT 1
      `,
      [
        restaurantId,
        batchId,
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}


function comparablePosRow(
  row
) {
  return {
    item_name:
      String(
        row.item_name
      ),

    quantity:
      Number(
        row.quantity
      ),

    total_price:
      Number(
        row.total_price
      ),

    order_status:
      String(
        row.order_status
      ),

    source:
      String(
        row.source
      ),

    edge_submission_id:
      String(
        row.edge_submission_id
      ),

    edge_row_ordinal:
      Number(
        row.edge_row_ordinal
      ),
  };
}


function comparableEventPosRow(
  row
) {
  return {
    item_name:
      String(
        row.item_name
      ),

    quantity:
      Number(
        row.quantity
      ),

    total_price:
      Number(
        row.total_price
      ),

    order_status:
      String(
        row.order_status
      ),

    source:
      String(
        row.source
      ),

    edge_submission_id:
      String(
        row.edge_submission_id
      ),

    edge_row_ordinal:
      Number(
        row.edge_row_ordinal
      ),
  };
}


function comparableKdsRow(
  row
) {
  return {
    meal_name:
      String(
        row.meal_name
      ),

    quantity:
      Number(
        row.quantity
      ),

    total_price:
      Number(
        row.total_price
      ),

    order_type:
      String(
        row.order_type
      ),

    order_status:
      String(
        row.order_status
      ),
  };
}


test(
  "MAKS real offline financial settlement across separate Edge and Cloud PostgreSQL",
  {
    timeout:
      180000,
  },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      "DATABASE_URL is required"
    );

    await assertTestDatabase();
    await resetTestData();

    const cloudPool =
      getPool();

    const cloudIdentity =
      await cloudPool.query(
        `
        SELECT
          current_database()
            AS db,
          inet_server_port()
            AS port
        `
      );

    assert.equal(
      cloudIdentity.rows[0]
        .db,
      "maks_test",
      "REFUSED: Cloud Attack DB must be named maks_test"
    );

    const token =
      crypto
        .randomBytes(8)
        .toString("hex");

    let edge =
      null;

    let cloudServer =
      null;

    let agent =
      null;

    let edgeServer =
      null;

    let preRestartEdgeServerOutput =
      "";

    let coldRestartBatchId =
      null;

    let cloudPort =
      null;

    let edgeHttpPort =
      null;

    let restaurantId =
      null;

    let credentials =
      null;

    let edgeFixtures =
      null;

    let batchId =
      null;

    let submissionId =
      null;

    let eventId =
      null;

    let eventSnapshot =
      null;

    let financialEventId =
      null;

    let financialPayload =
      null;

    let settlementId =
      null;

    let paymentUuid =
      null;

    let cashupSessionId =
      null;

    let cashupEventId =
      null;

    let cashupPayload =
      null;

    let refundEventId =
      null;

    let refundPayload =
      null;

    let refundUuid =
      null;

    try {
      await t.test(
        "starts a genuinely separate Edge PostgreSQL named maks_test",
        async () => {
          edge =
            await startIsolatedPostgres({
              cloudDatabaseUrl:
                DATABASE_URL,
            });

          assert.notEqual(
            edge.port,
            Number(
              cloudIdentity
                .rows[0]
                .port
            ),
            "Cloud and Edge unexpectedly share one PostgreSQL port"
          );

          console.log(
            `✅ 01 Two real PostgreSQL servers: Cloud ${cloudIdentity.rows[0].port}, Edge ${edge.port}`
          );
        }
      );

      restaurantId =
        await createCloudRestaurant({
          pool:
            cloudPool,
          token,
        });

      edgeFixtures =
        await seedEdgeRestaurant({
          pool:
            edge.pool,
          restaurantId,
          token,
        });

      const cloudUserLeak =
        await cloudPool.query(
          `
          SELECT
            COUNT(*)::int
              AS count
          FROM
            public.users
          WHERE
            username = $1
          `,
          [
            edgeFixtures
              .username,
          ]
        );

      assert.equal(
        Number(
          cloudUserLeak.rows[0]
            .count
        ),
        0,
        "Edge-only POS owner unexpectedly exists in Cloud"
      );

      credentials =
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
          restaurantId,
          credentials
            .installationId,
          `POS OFFLINE EDGE ${token}`,
          credentials
            .secretHash,
        ]
      );

      cloudPort =
        await getFreePort();

      cloudServer =
        makeCloudServer();

      agent =
        spawnAgent({
          cloudUrl:
            `http://127.0.0.1:${cloudPort}`,
          edgeDatabaseUrl:
            edge.databaseUrl,
          installationId:
            credentials
              .installationId,
          edgeSecret:
            credentials
              .secret,
        });

      await sleep(
        1600
      );

      assert.equal(
        await isPortOpen(
          cloudPort
        ),
        false,
        "Cloud HTTP unexpectedly became reachable before WAN return"
      );

      assert.equal(
        agent.child
          .exitCode,
        null,
        `Edge agent crashed while Cloud was unreachable:\n${agent.output()}`
      );

      console.log(
        "✅ 02 Real Edge agent survives with Cloud HTTP unreachable"
      );

      await t.test(
        "real Edge POS server authenticates an Edge-only owner while Cloud is unreachable",
        async () => {
          edgeHttpPort =
            await getFreePort();

          edgeServer =
            spawnEdgeServer({
              edgeDatabaseUrl:
                edge.databaseUrl,
              port:
                edgeHttpPort,
            });

          await waitFor(
            async () => {
              if (
                edgeServer
                  .child
                  .exitCode !==
                null
              ) {
                throw new Error(
                  `Edge POS server exited during boot:\n${edgeServer.output()}`
                );
              }

              return isPortOpen(
                edgeHttpPort
              );
            },
            {
              timeoutMs:
                25000,
              message:
                `Edge POS HTTP did not start:\n${edgeServer.output()}`,
            }
          );

          const login =
            await jsonFetch(
              `http://127.0.0.1:${edgeHttpPort}/auth/login`,
              {
                method:
                  "POST",
                body: {
                  username:
                    edgeFixtures
                      .username,
                  password:
                    TEST_PASSWORD,
                  restaurant_id:
                    restaurantId,
                },
              }
            );

          assert.equal(
            login.status,
            200,
            JSON.stringify(
              login.data
            )
          );

          assert.ok(
            login.data
              ?.token,
            "Edge-only owner login returned no JWT"
          );

          assert.equal(
            await isPortOpen(
              cloudPort
            ),
            false
          );

          edgeFixtures.token =
            login.data
              .token;

          console.log(
            "✅ 03 Edge-only owner authenticated against real local POS HTTP"
          );
        }
      );

      await t.test(
        "real /orders/grouped commits locally with WAN down and Cloud untouched",
        async () => {
          const response =
            await jsonFetch(
              `http://127.0.0.1:${edgeHttpPort}/orders/grouped`,
              {
                method:
                  "POST",
                headers: {
                  authorization:
                    `Bearer ${edgeFixtures.token}`,
                },
                body: {
                  order_type:
                    "takeaway",

                  table_number:
                    "Takeaway",

                  source:
                    "pos",

                  items: [
                    {
                      meal_id:
                        edgeFixtures
                          .mealId,

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
                       * Edge authoritative pricing must replace them.
                       */
                      meal_name:
                        "FAKE OFFLINE BROWSER BURGER",

                      name:
                        "FAKE OFFLINE BROWSER BURGER",

                      quantity:
                        2,

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
                },
              }
            );

          assert.equal(
            response.status,
            201,
            `Offline grouped order failed: ${response.status} ${JSON.stringify(
              response.data
            )}\n${edgeServer.output()}`
          );

          batchId =
            String(
              response.data
                ?.batch_id ||
              ""
            );

          submissionId =
            String(
              response.data
                ?.submission_id ||
              ""
            );

          assert.match(
            batchId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.match(
            submissionId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.equal(
            Number(
              response.data
                ?.total
            ),
            25,
            "Offline Edge did not apply authoritative price"
          );

          const edgeBatch =
            await edge.pool
              .query(
                `
                SELECT
                  id,
                  restaurant_id,
                  order_type
                FROM
                  public.order_batches
                WHERE
                  restaurant_id = $1
                  AND
                  id = $2::uuid
                `,
                [
                  restaurantId,
                  batchId,
                ]
              );

          assert.equal(
            edgeBatch.rows.length,
            1
          );

          const edgePos =
            await edge.pool
              .query(
                `
                SELECT
                  id,
                  item_name,
                  quantity,
                  total_price,
                  order_status,
                  source,
                  edge_submission_id,
                  edge_row_ordinal
                FROM
                  public.pos_orders
                WHERE
                  restaurant_id = $1
                  AND
                  batch_id = $2::uuid
                ORDER BY
                  edge_row_ordinal,
                  id
                `,
                [
                  restaurantId,
                  batchId,
                ]
              );

          assert.equal(
            edgePos.rows.length,
            2
          );

          assert.ok(
            edgePos.rows.every(
              (row) =>
                Number(
                  row.id
                ) >=
                900000001
            ),
            "Edge BIGSERIAL range was not isolated as expected"
          );

          assert.ok(
            edgePos.rows.every(
              (row) =>
                String(
                  row
                    .edge_submission_id
                ) ===
                submissionId
            )
          );

          assert.deepEqual(
            edgePos.rows.map(
              (row) =>
                Number(
                  row
                    .edge_row_ordinal
                )
            ),
            [
              1,
              2,
            ]
          );

          const edgeKds =
            await edge.pool
              .query(
                `
                SELECT
                  meal_name,
                  quantity,
                  total_price,
                  order_type,
                  order_status
                FROM
                  public.orders
                WHERE
                  restaurant_id = $1
                  AND
                  batch_id = $2::uuid
                ORDER BY
                  id
                `,
                [
                  restaurantId,
                  batchId,
                ]
              );

          assert.ok(
            edgeKds.rows.length >
              0,
            "Offline Edge created no KDS row"
          );

          const outbox =
            await edgeOutboxForBatch({
              pool:
                edge.pool,
              restaurantId,
              batchId,
            });

          assert.ok(
            outbox,
            "Offline Edge produced no durable POS outbox event"
          );

          eventId =
            String(
              outbox.event_id
            );

          eventSnapshot =
            outbox.payload;

          assert.equal(
            outbox.event_type,
            "pos.order.submitted"
          );

          assert.equal(
            Number(
              eventSnapshot
                ?.schema_version
            ),
            2
          );

          assert.equal(
            String(
              eventSnapshot
                ?.submission_id
            ),
            submissionId
          );

          assert.equal(
            String(
              eventSnapshot
                ?.batch_id
            ),
            batchId
          );

          assert.equal(
            eventSnapshot
              ?.pos_rows
              ?.length,
            2
          );

          assert.equal(
            outbox.status ===
              "acked",
            false,
            "Offline Edge event was somehow ACKed while Cloud HTTP was unreachable"
          );

          assert.equal(
            outbox.acked_at,
            null
          );

          const cloudBusiness =
            await cloudPool
              .query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.order_batches
                    WHERE
                      restaurant_id = $1
                      AND
                      id = $2::uuid
                  ) AS batches,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.pos_orders
                    WHERE
                      restaurant_id = $1
                      AND
                      batch_id = $2::uuid
                  ) AS pos_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.orders
                    WHERE
                      restaurant_id = $1
                      AND
                      batch_id = $2::uuid
                  ) AS kds_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.edge_inbox
                    WHERE
                      event_id = $3::uuid
                  ) AS inbox_rows
                `,
                [
                  restaurantId,
                  batchId,
                  eventId,
                ]
              );

          const cloudBefore =
            cloudBusiness
              .rows[0];

          assert.equal(
            Number(
              cloudBefore
                .batches
            ),
            0
          );

          assert.equal(
            Number(
              cloudBefore
                .pos_rows
            ),
            0
          );

          assert.equal(
            Number(
              cloudBefore
                .kds_rows
            ),
            0
          );

          assert.equal(
            Number(
              cloudBefore
                .inbox_rows
            ),
            0
          );

          assert.equal(
            await isPortOpen(
              cloudPort
            ),
            false
          );

          console.log(
            "✅ 04 Real WAN-off /orders/grouped committed POS + KDS + outbox locally only"
          );
        }
      );


      await t.test(
        "real /orders/mark-paid commits settlement + tender + finance outbox on Edge only while Cloud is unreachable",
        async () => {
          const edgePosBeforePayment =
            await edge.pool.query(
              `
              SELECT
                id,
                batch_id,
                edge_submission_id,
                edge_row_ordinal,
                total_price,
                paid,
                amount_paid,
                remaining_price
              FROM
                public.pos_orders
              WHERE
                restaurant_id = $1
                AND batch_id = $2::uuid
              ORDER BY
                edge_row_ordinal,
                id
              `,
              [
                restaurantId,
                batchId,
              ]
            );

          assert.equal(
            edgePosBeforePayment.rows.length,
            2,
            "Expected the real offline sale to contain two Edge POS rows"
          );

          const edgeLocalPosIds =
            edgePosBeforePayment.rows
              .map(
                (row) =>
                  Number(
                    row.id
                  )
              );

          assert.ok(
            edgeLocalPosIds.every(
              (id) =>
                id >=
                900000001
            ),
            "Edge financial fixture lost isolated local BIGINT range"
          );

          assert.ok(
            edgePosBeforePayment.rows.every(
              (row) =>
                Number(
                  row.paid
                ) ===
                0
            )
          );

          const paymentResponse =
            await jsonFetch(
              `http://127.0.0.1:${edgeHttpPort}/orders/mark-paid`,
              {
                method:
                  "POST",

                headers: {
                  authorization:
                    `Bearer ${edgeFixtures.token}`,
                },

                body: {
                  tableNumber:
                    "Takeaway",

                  itemIds:
                    edgeLocalPosIds,

                  paymentMethod:
                    "cash",

                  manualDiscountAmount:
                    0,

                  serviceChargeAmount:
                    0,

                  terminalRef:
                    "EDGE-FINANCIAL-TWO-PG-E2E",
                },
              }
            );

          assert.equal(
            paymentResponse.status,
            200,
            `Real offline mark-paid failed: ${paymentResponse.status} ${JSON.stringify(
              paymentResponse.data
            )}\n${edgeServer.output()}`
          );

          assert.equal(
            await isPortOpen(
              cloudPort
            ),
            false,
            "Cloud HTTP became reachable during the financial blackout"
          );

          const financeOutbox =
            await edge.pool.query(
              `
              SELECT
                event_id,
                entity_id,
                idempotency_key,
                payload,
                status,
                acked_at
              FROM
                public.edge_outbox
              WHERE
                restaurant_id = $1
                AND event_type =
                  'financial.settlement.recorded.v1'
                AND payload
                      -> 'settlement'
                      ->> 'batch_id' =
                    $2
              ORDER BY
                id ASC
              `,
              [
                restaurantId,
                batchId,
              ]
            );

          assert.equal(
            financeOutbox.rows.length,
            1,
            "Offline mark-paid did not create exactly one durable financial settlement event"
          );

          const financialOutboxRow =
            financeOutbox.rows[0];

          financialEventId =
            String(
              financialOutboxRow
                .event_id ||
              ""
            );

          financialPayload =
            financialOutboxRow
              .payload;

          settlementId =
            String(
              financialPayload
                ?.settlement
                ?.id ||
              ""
            );

          paymentUuid =
            String(
              financialPayload
                ?.tenders
                ?.[0]
                ?.payment_uuid ||
              ""
            );

          assert.match(
            financialEventId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.match(
            settlementId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.match(
            paymentUuid,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.equal(
            String(
              financialOutboxRow
                .entity_id
            ),
            settlementId
          );

          assert.equal(
            financialOutboxRow
              .idempotency_key,
            `financial.settlement.recorded.v1:${settlementId}`
          );

          assert.equal(
            Number(
              financialPayload
                ?.restaurant_id
            ),
            restaurantId
          );

          assert.equal(
            String(
              financialPayload
                ?.settlement
                ?.batch_id
            ),
            batchId
          );

          assert.equal(
            financialPayload
              ?.settlement
              ?.table_number,
            "Takeaway"
          );

          assert.equal(
            financialPayload
              ?.settlement
              ?.order_refs
              ?.length,
            2,
            "Financial settlement did not contain both portable POS references"
          );

          assert.deepEqual(
            financialPayload
              .settlement
              .order_refs
              .map(
                (ref) =>
                  Number(
                    ref.edge_row_ordinal
                  )
              )
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              ),
            [
              1,
              2,
            ]
          );

          assert.ok(
            financialPayload
              .settlement
              .order_refs
              .every(
                (ref) =>
                  String(
                    ref.edge_submission_id
                  ) ===
                  submissionId &&
                  String(
                    ref.batch_id
                  ) ===
                  batchId
              ),
            "Financial settlement portable refs do not match the real offline POS sale"
          );

          assert.equal(
            financialPayload
              ?.tenders
              ?.length,
            1
          );

          assert.equal(
            financialPayload
              .tenders[0]
              .ref_payment_uuid,
            null
          );

          assert.equal(
            Number(
              financialPayload
                .tenders[0]
                .amount
            ),
            Number(
              financialPayload
                .settlement
                .final_amount
            )
          );

          const payloadText =
            JSON.stringify(
              financialPayload
            );

          for (
            const edgeLocalId of
              edgeLocalPosIds
          ) {
            assert.equal(
              payloadText.includes(
                `"pos_order_id":${edgeLocalId}`
              ),
              false,
              `Financial wire payload leaked Edge-local pos_order_id ${edgeLocalId}`
            );
          }

          const edgeSettlement =
            await edge.pool.query(
              `
              SELECT
                id,
                restaurant_id,
                batch_id,
                final_amount,
                pos_order_ids
              FROM
                public.payment_settlements
              WHERE
                restaurant_id = $1
                AND id = $2::uuid
              `,
              [
                restaurantId,
                settlementId,
              ]
            );

          assert.equal(
            edgeSettlement.rows.length,
            1
          );

          assert.equal(
            String(
              edgeSettlement.rows[0]
                .id
            ),
            settlementId
          );

          assert.deepEqual(
            (
              edgeSettlement.rows[0]
                .pos_order_ids ||
              []
            )
              .map(Number)
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              ),
            [
              ...edgeLocalPosIds,
            ].sort(
              (
                left,
                right
              ) =>
                left -
                right
            ),
            "Edge ledger did not retain its own local POS references"
          );

          const edgeTender =
            await edge.pool.query(
              `
              SELECT
                payment_uuid,
                settlement_id,
                amount,
                pos_order_ids
              FROM
                public.payments
              WHERE
                restaurant_id = $1
                AND settlement_id =
                  $2::uuid
              `,
              [
                restaurantId,
                settlementId,
              ]
            );

          assert.equal(
            edgeTender.rows.length,
            1
          );

          assert.equal(
            String(
              edgeTender.rows[0]
                .payment_uuid
            ),
            paymentUuid
          );

          assert.deepEqual(
            (
              edgeTender.rows[0]
                .pos_order_ids ||
              []
            )
              .map(Number)
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              ),
            [
              ...edgeLocalPosIds,
            ].sort(
              (
                left,
                right
              ) =>
                left -
                right
            )
          );

          assert.equal(
            financialOutboxRow
              .status ===
              "acked",
            false,
            "Financial event was somehow ACKed while Cloud HTTP was unreachable"
          );

          assert.equal(
            financialOutboxRow
              .acked_at,
            null
          );

          const cloudLedgerBefore =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payment_settlements
                  WHERE
                    restaurant_id = $1
                    AND id =
                      $2::uuid
                ) AS settlements,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payments
                  WHERE
                    restaurant_id = $1
                    AND payment_uuid =
                      $3::uuid
                ) AS tenders,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.edge_inbox
                  WHERE
                    event_id =
                      $4::uuid
                ) AS inbox_rows
              `,
              [
                restaurantId,
                settlementId,
                paymentUuid,
                financialEventId,
              ]
            );

          assert.equal(
            Number(
              cloudLedgerBefore
                .rows[0]
                .settlements
            ),
            0,
            "Cloud settlement changed while Cloud HTTP was unreachable"
          );

          assert.equal(
            Number(
              cloudLedgerBefore
                .rows[0]
                .tenders
            ),
            0,
            "Cloud tender changed while Cloud HTTP was unreachable"
          );

          assert.equal(
            Number(
              cloudLedgerBefore
                .rows[0]
                .inbox_rows
            ),
            0,
            "Cloud received the financial event while its HTTP endpoint was unreachable"
          );

          console.log(
            "✅ FIN-A Real WAN-off mark-paid committed settlement + tender + durable finance outbox only on Edge"
          );
        }
      );


      await t.test(
        "real partial refund commits on Edge while Cloud remains physically unreachable",
        async () => {
          assert.match(
            paymentUuid,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.equal(
            await isPortOpen(
              cloudPort
            ),
            false,
            "Cloud HTTP must still be unreachable before refund"
          );

          const edgeOriginalResult =
            await edge.pool.query(
              `
              SELECT
                id,
                amount,
                batch_id,
                pos_order_ids,
                payment_uuid,
                status
              FROM
                public.payments
              WHERE
                restaurant_id = $1
                AND payment_uuid =
                  $2::uuid
              `,
              [
                restaurantId,
                paymentUuid,
              ]
            );

          assert.equal(
            edgeOriginalResult.rows.length,
            1
          );

          const edgeOriginal =
            edgeOriginalResult.rows[0];

          const edgeOriginalPaymentId =
            Number(
              edgeOriginal.id
            );

          const originalAmount =
            Number(
              edgeOriginal.amount
            );

          assert.ok(
            Number.isSafeInteger(
              edgeOriginalPaymentId
            ) &&
            edgeOriginalPaymentId >
              0
          );

          assert.ok(
            Number.isFinite(
              originalAmount
            ) &&
            originalAmount >
              0.02,
            "Original offline tender is too small for partial refund proof"
          );

          const refundAmount =
            Math.min(
              5,
              Math.floor(
                (
                  originalAmount /
                  2
                ) *
                100
              ) /
              100
            );

          assert.ok(
            refundAmount >
              0 &&
            refundAmount <
              originalAmount,
            "Refund fixture must remain a partial refund"
          );

          /*
           * Force Cloud's next payment BIGINT far away from
           * Edge's original local payment BIGINT.
           *
           * This touches only isolated maks_test.
           * It ensures the test cannot accidentally pass by
           * receiving matching local payment IDs.
           */
          const forcedCloudPaymentId =
            edgeOriginalPaymentId +
            500000000;

          await cloudPool.query(
            `
            SELECT
              setval(
                pg_get_serial_sequence(
                  'public.payments',
                  'id'
                ),
                $1::bigint,
                false
              )
            `,
            [
              forcedCloudPaymentId,
            ]
          );

          const refundResponse =
            await jsonFetch(
              `http://127.0.0.1:${edgeHttpPort}/orders/payments/${edgeOriginalPaymentId}/refund`,
              {
                method:
                  "POST",

                headers: {
                  authorization:
                    `Bearer ${edgeFixtures.token}`,
                },

                body: {
                  amount:
                    refundAmount,

                  reason:
                    "REAL WAN-OFF REFUND E2E",
                },
              }
            );

          assert.equal(
            refundResponse.status,
            200,
            `Real WAN-off refund failed: ${refundResponse.status} ${JSON.stringify(
              refundResponse.data
            )}\n${edgeServer.output()}`
          );

          assert.equal(
            await isPortOpen(
              cloudPort
            ),
            false,
            "Cloud HTTP became reachable during refund blackout"
          );

          refundUuid =
            String(
              refundResponse.data
                ?.payment_uuid ||
              ""
            );

          const returnedOriginalUuid =
            String(
              refundResponse.data
                ?.ref_payment_uuid ||
              ""
            );

          const refundBatchId =
            String(
              refundResponse.data
                ?.payment_batch_id ||
              ""
            );

          assert.match(
            refundUuid,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.match(
            refundBatchId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.equal(
            returnedOriginalUuid,
            paymentUuid
          );

          assert.notEqual(
            refundUuid,
            paymentUuid
          );

          assert.notEqual(
            refundBatchId,
            String(
              edgeOriginal.batch_id
            ),
            "Real refund incorrectly reused original tender batch UUID"
          );

          const refundOutboxResult =
            await edge.pool.query(
              `
              SELECT
                event_id,
                entity_id,
                idempotency_key,
                payload,
                status,
                acked_at
              FROM
                public.edge_outbox
              WHERE
                restaurant_id = $1
                AND event_type =
                  'financial.refund.recorded.v1'
                AND entity_id =
                  $2
              ORDER BY
                id ASC
              `,
              [
                restaurantId,
                refundUuid,
              ]
            );

          assert.equal(
            refundOutboxResult.rows.length,
            1,
            "Offline refund did not create exactly one durable refund event"
          );

          const refundOutbox =
            refundOutboxResult.rows[0];

          refundEventId =
            String(
              refundOutbox.event_id ||
              ""
            );

          refundPayload =
            refundOutbox.payload;

          assert.match(
            refundEventId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.equal(
            String(
              refundOutbox.entity_id
            ),
            refundUuid
          );

          assert.equal(
            refundOutbox.idempotency_key,
            `financial.refund.recorded.v1:${refundUuid}`
          );

          assert.equal(
            Number(
              refundPayload
                ?.restaurant_id
            ),
            restaurantId
          );

          assert.equal(
            String(
              refundPayload
                ?.refund
                ?.payment_uuid
            ),
            refundUuid
          );

          assert.equal(
            String(
              refundPayload
                ?.refund
                ?.ref_payment_uuid
            ),
            paymentUuid
          );

          assert.equal(
            Number(
              refundPayload
                ?.refund
                ?.amount
            ),
            -refundAmount
          );

          assert.equal(
            String(
              refundPayload
                ?.refund
                ?.batch_id
            ),
            refundBatchId
          );

          assert.notEqual(
            String(
              refundPayload
                ?.refund
                ?.batch_id
            ),
            String(
              edgeOriginal.batch_id
            )
          );

          assert.ok(
            Array.isArray(
              refundPayload
                ?.refund
                ?.order_refs
            ) &&
            refundPayload
              .refund
              .order_refs
              .length >
              0
          );

          assert.ok(
            refundPayload
              .refund
              .order_refs
              .every(
                (ref) =>
                  String(
                    ref.batch_id
                  ) ===
                    batchId &&
                  String(
                    ref.edge_submission_id
                  ) ===
                    submissionId
              ),
            "Refund portable refs do not point to original offline POS batch"
          );

          const wireText =
            JSON.stringify(
              refundPayload
            );

          assert.equal(
            wireText.includes(
              '"ref_payment_id"'
            ),
            false,
            "Refund wire leaked Edge-local ref_payment_id"
          );

          assert.equal(
            wireText.includes(
              '"pos_order_id"'
            ),
            false,
            "Refund wire leaked Edge-local pos_order_id"
          );

          const edgeRefundResult =
            await edge.pool.query(
              `
              SELECT
                id,
                amount,
                batch_id,
                pos_order_ids,
                source,
                status,
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
                restaurantId,
                refundUuid,
              ]
            );

          assert.equal(
            edgeRefundResult.rows.length,
            1
          );

          const edgeRefund =
            edgeRefundResult.rows[0];

          assert.equal(
            Number(
              edgeRefund.amount
            ),
            -refundAmount
          );

          assert.equal(
            edgeRefund.source,
            "refund"
          );

          assert.equal(
            edgeRefund.status,
            "completed"
          );

          assert.equal(
            Number(
              edgeRefund.ref_payment_id
            ),
            edgeOriginalPaymentId
          );

          assert.equal(
            String(
              edgeRefund.ref_payment_uuid
            ),
            paymentUuid
          );

          assert.equal(
            String(
              edgeRefund.payment_uuid
            ),
            refundUuid
          );

          assert.equal(
            String(
              edgeRefund.batch_id
            ),
            refundBatchId
          );

          const originalPosIds =
            new Set(
              (
                Array.isArray(
                  edgeOriginal.pos_order_ids
                )
                  ? edgeOriginal.pos_order_ids
                  : JSON.parse(
                      edgeOriginal
                        .pos_order_ids ||
                      "[]"
                    )
              ).map(Number)
            );

          const refundPosIds =
            (
              Array.isArray(
                edgeRefund.pos_order_ids
              )
                ? edgeRefund.pos_order_ids
                : JSON.parse(
                    edgeRefund
                      .pos_order_ids ||
                    "[]"
                  )
            ).map(Number);

          assert.ok(
            refundPosIds.length >
              0
          );

          assert.ok(
            refundPosIds.every(
              (id) =>
                originalPosIds.has(
                  id
                )
            ),
            "Edge refund escaped original tender POS lineage"
          );

          assert.notEqual(
            refundOutbox.status,
            "acked",
            "Refund somehow ACKed while Cloud HTTP was dead"
          );

          assert.equal(
            refundOutbox.acked_at,
            null
          );

          const cloudBefore =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payments
                  WHERE
                    restaurant_id = $1
                    AND payment_uuid =
                      $2::uuid
                ) AS refund_rows,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.edge_inbox
                  WHERE
                    event_id =
                      $3::uuid
                ) AS inbox_rows
              `,
              [
                restaurantId,
                refundUuid,
                refundEventId,
              ]
            );

          assert.equal(
            Number(
              cloudBefore.rows[0]
                .refund_rows
            ),
            0,
            "Cloud refund ledger changed during HTTP blackout"
          );

          assert.equal(
            Number(
              cloudBefore.rows[0]
                .inbox_rows
            ),
            0,
            "Cloud received refund event during HTTP blackout"
          );

          console.log(
            "✅ FIN-R-A Real WAN-off partial refund committed negative ledger + durable refund outbox only on Edge"
          );
        }
      );


        await t.test(
          "real /cashup/close commits cash-up on Edge only while Cloud is unreachable",
          async () => {
            assert.equal(
              await isPortOpen(
                cloudPort
              ),
              false,
              "Cloud became reachable before WAN-off cash-up"
            );

            const cashupRefundUuid =
              String(
                refundPayload
                  ?.refund
                  ?.payment_uuid ||
                ""
              );

            assert.match(
              cashupRefundUuid,
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            );

            const portablePaymentUuids = [
              paymentUuid,
              cashupRefundUuid,
            ];

            const windowResult =
              await edge.pool.query(
                `
                SELECT
                  MIN(created_at)
                    AS min_created_at,

                  MAX(created_at)
                    AS max_created_at,

                  COALESCE(
                    SUM(
                      CASE
                        WHEN method = 'cash'
                         AND status = 'completed'
                        THEN amount
                        ELSE 0
                      END
                    ),
                    0
                  )::numeric
                    AS net_cash
                FROM public.payments
                WHERE restaurant_id = $1
                  AND payment_uuid =
                    ANY($2::uuid[])
                `,
                [
                  restaurantId,
                  portablePaymentUuids,
                ]
              );

            assert.ok(
              windowResult.rows[0]
                ?.min_created_at
            );

            assert.ok(
              windowResult.rows[0]
                ?.max_created_at
            );

            const from =
              new Date(
                new Date(
                  windowResult.rows[0]
                    .min_created_at
                ).getTime() -
                1000
              ).toISOString();

            const to =
              new Date(
                new Date(
                  windowResult.rows[0]
                    .max_created_at
                ).getTime() +
                1000
              ).toISOString();

            const actualCash =
              Number(
                windowResult.rows[0]
                  .net_cash ||
                0
              );

            const response =
              await jsonFetch(
                `http://127.0.0.1:${edgeHttpPort}/cashup/close`,
                {
                  method:
                    "POST",

                  headers: {
                    authorization:
                      `Bearer ${edgeFixtures.token}`,
                  },

                  body: {
                    from,
                    to,

                    actual_cash:
                      actualCash,

                    note:
                      "REAL WAN-OFF CASH-UP TWO-PG E2E",
                  },
                }
              );

            assert.equal(
              response.status,
              200,
              `Real WAN-off cash-up failed: ${response.status} ${JSON.stringify(
                response.data
              )}\n${edgeServer.output()}`
            );

            cashupSessionId =
              String(
                response.data
                  ?.cashup_session_id ||
                ""
              );

            assert.match(
              cashupSessionId,
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            );

            const edgeSession =
              await edge.pool.query(
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
                  restaurantId,
                  cashupSessionId,
                ]
              );

            assert.equal(
              edgeSession.rows.length,
              1
            );

            assert.ok(
              edgeSession.rows[0]
                .closed_by_user_id
            );

            assert.ok(
              String(
                edgeSession.rows[0]
                  .closed_by_name ||
                ""
              ).length > 0
            );

            const linked =
              await edge.pool.query(
                `
                SELECT
                  payment_uuid,
                  cashup_session_id
                FROM public.payments
                WHERE restaurant_id = $1
                  AND payment_uuid =
                    ANY($2::uuid[])
                `,
                [
                  restaurantId,
                  portablePaymentUuids,
                ]
              );

            assert.equal(
              linked.rows.length,
              portablePaymentUuids.length
            );

            assert.ok(
              linked.rows.every(
                (row) =>
                  String(
                    row.cashup_session_id
                  ) ===
                  cashupSessionId
              )
            );

            const outbox =
              await edge.pool.query(
                `
                SELECT
                  event_id,
                  entity_type,
                  entity_id,
                  idempotency_key,
                  payload,
                  status,
                  acked_at
                FROM public.edge_outbox
                WHERE restaurant_id = $1
                  AND event_type =
                    'cashup.session.closed.v1'
                  AND entity_id = $2
                `,
                [
                  restaurantId,
                  cashupSessionId,
                ]
              );

            assert.equal(
              outbox.rows.length,
              1,
              "Expected exactly one WAN-off cash-up event"
            );

            cashupEventId =
              String(
                outbox.rows[0]
                  .event_id
              );

            cashupPayload =
              outbox.rows[0]
                .payload;

            assert.equal(
              outbox.rows[0]
                .entity_type,
              "cashup_session"
            );

            assert.equal(
              String(
                outbox.rows[0]
                  .entity_id
              ),
              cashupSessionId
            );

            assert.equal(
              outbox.rows[0]
                .idempotency_key,
              `cashup.session.closed.v1:${cashupSessionId}`
            );

            assert.equal(
              String(
                cashupPayload
                  ?.session
                  ?.id
              ),
              cashupSessionId
            );

            assert.equal(
              Object.prototype
                .hasOwnProperty.call(
                  cashupPayload
                    .session,
                  "closed_by_user_id"
                ),
              false,
              "Cash-up event leaked Edge-local user BIGINT"
            );

            const payloadUuids =
              cashupPayload
                .payment_uuids
                .map(String);

            assert.ok(
              payloadUuids.includes(
                paymentUuid
              )
            );

            assert.ok(
              payloadUuids.includes(
                cashupRefundUuid
              )
            );

            assert.notEqual(
              outbox.rows[0]
                .status,
              "acked",
              "Cash-up ACKed while Cloud was unreachable"
            );

            assert.equal(
              outbox.rows[0]
                .acked_at,
              null
            );

            const cloudBefore =
              await cloudPool.query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.cashup_sessions
                    WHERE restaurant_id = $1
                      AND id = $2::uuid
                  ) AS sessions,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.edge_inbox
                    WHERE event_id =
                      $3::uuid
                  ) AS inbox_rows
                `,
                [
                  restaurantId,
                  cashupSessionId,
                  cashupEventId,
                ]
              );

            assert.equal(
              Number(
                cloudBefore.rows[0]
                  .sessions
              ),
              0
            );

            assert.equal(
              Number(
                cloudBefore.rows[0]
                  .inbox_rows
              ),
              0
            );

            console.log(
              "✅ CASH-A Real WAN-off cash-up committed session + payment UUID links + durable outbox only on Edge"
            );
          }
        );

        await t.test(
          "cold restart preserves local restaurant operations while Cloud remains unreachable",
          async () => {
            assert.equal(
              await isPortOpen(
                cloudPort
              ),
              false,
              "Cloud became reachable before cold restart"
            );

            /*
             * Snapshot durable Edge state before killing
             * the HTTP process.
             */
            const beforeRestart =
              await edge.pool.query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.cashup_sessions
                    WHERE restaurant_id = $1
                      AND id =
                        $2::uuid
                  ) AS cashup_sessions,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.payments
                    WHERE restaurant_id = $1
                      AND cashup_session_id =
                        $2::uuid
                  ) AS linked_payments,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.edge_outbox
                    WHERE restaurant_id = $1
                      AND event_id =
                        $3::uuid
                  ) AS cashup_outbox
                `,
                [
                  restaurantId,
                  cashupSessionId,
                  cashupEventId,
                ]
              );

            assert.equal(
              Number(
                beforeRestart.rows[0]
                  .cashup_sessions
              ),
              1
            );

            assert.equal(
              Number(
                beforeRestart.rows[0]
                  .linked_payments
              ),
              cashupPayload
                .payment_uuids
                .length
            );

            assert.equal(
              Number(
                beforeRestart.rows[0]
                  .cashup_outbox
              ),
              1
            );

            /*
             * Preserve logs from the original process so
             * later secret/DB-URL hygiene still checks
             * BOTH server lifetimes.
             */
            preRestartEdgeServerOutput =
              edgeServer.output();

            const oldEdgeChild =
              edgeServer.child;

            await stopChild(
              edgeServer
            );

            await waitFor(
              async () =>
                !(
                  await isPortOpen(
                    edgeHttpPort
                  )
                ),
              {
                timeoutMs:
                  10000,

                message:
                  "Original Edge HTTP port did not close during cold restart",
              }
            );

            /*
             * A ChildProcess terminated by SIGTERM may
             * legitimately keep exitCode === null.
             * signalCode is the authoritative termination
             * field in that case.
             *
             * The closed HTTP-port assertion above proves
             * the old server is no longer serving.
             */
            await waitFor(
              async () =>
                oldEdgeChild
                  .exitCode !==
                  null ||
                oldEdgeChild
                  .signalCode !==
                  null,
              {
                timeoutMs:
                  5000,

                message:
                  "Original Edge child never reported exit or termination signal",
              }
            );

            assert.ok(
              oldEdgeChild
                .exitCode !==
                null ||
              oldEdgeChild
                .signalCode !==
                null,
              "Original Edge process did not actually terminate"
            );

            assert.equal(
              await isPortOpen(
                cloudPort
              ),
              false,
              "Cloud became reachable while Edge was stopped"
            );

            /*
             * Cold boot:
             *
             * same Edge PostgreSQL
             * same HTTP port
             * Cloud still dead
             */
            edgeServer =
              spawnEdgeServer({
                edgeDatabaseUrl:
                  edge.databaseUrl,

                port:
                  edgeHttpPort,
              });

            await waitFor(
              async () => {
                if (
                  edgeServer
                    .child
                    .exitCode !==
                  null
                ) {
                  throw new Error(
                    `Cold-start Edge server exited during boot:\n${edgeServer.output()}`
                  );
                }

                return isPortOpen(
                  edgeHttpPort
                );
              },
              {
                timeoutMs:
                  25000,

                message:
                  `Cold-start Edge HTTP failed to reopen:\n${edgeServer.output()}`,
              }
            );

            assert.equal(
              await isPortOpen(
                cloudPort
              ),
              false,
              "Cloud became reachable during Edge cold boot"
            );

            /*
             * Old JWT is deliberately not trusted as
             * proof of cold-start identity.
             *
             * Authenticate again from the persisted
             * Edge-local user database.
             */
            const freshLogin =
              await jsonFetch(
                `http://127.0.0.1:${edgeHttpPort}/auth/login`,
                {
                  method:
                    "POST",

                  body: {
                    username:
                      edgeFixtures
                        .username,

                    password:
                      TEST_PASSWORD,

                    restaurant_id:
                      restaurantId,
                  },
                }
              );

            assert.equal(
              freshLogin.status,
              200,
              `Cold-start local login failed: ${freshLogin.status} ${JSON.stringify(
                freshLogin.data
              )}\n${edgeServer.output()}`
            );

            assert.ok(
              freshLogin.data
                ?.token,
              "Cold-start local login returned no JWT"
            );

            /*
             * Replace the old JWT with a JWT issued by
             * the freshly restarted Edge process.
             */
            edgeFixtures.token =
              freshLogin.data
                .token;

            /*
             * Cash-Up HTTP must reopen from local Edge
             * data while Cloud remains dead.
             */
            const cashupRead =
              await jsonFetch(
                `http://127.0.0.1:${edgeHttpPort}/cashup/sessions/${cashupSessionId}`,
                {
                  headers: {
                    authorization:
                      `Bearer ${edgeFixtures.token}`,
                  },
                }
              );

            assert.equal(
              cashupRead.status,
              200,
              `Cold-start cash-up read failed: ${cashupRead.status} ${JSON.stringify(
                cashupRead.data
              )}`
            );

            /*
             * KDS HTTP must also boot and answer locally.
             *
             * We deliberately assert only the HTTP
             * contract here; the real post-restart POS
             * operation below proves new KDS persistence.
             */
            const kdsRead =
              await jsonFetch(
                `http://127.0.0.1:${edgeHttpPort}/kds/live`,
                {
                  headers: {
                    authorization:
                      `Bearer ${edgeFixtures.token}`,

                      "x-kds-device":
                        "cold-restart-kds-device",

                      "x-station-key":
                        "meals",
                  },
                }
              );

            assert.equal(
              kdsRead.status,
              200,
              `Cold-start KDS read failed: ${kdsRead.status} ${JSON.stringify(
                kdsRead.data
              )}`
            );

            /*
             * Durable state must be unchanged by killing
             * and reopening server.js.
             */
            const afterRestart =
              await edge.pool.query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.cashup_sessions
                    WHERE restaurant_id = $1
                      AND id =
                        $2::uuid
                  ) AS cashup_sessions,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.payments
                    WHERE restaurant_id = $1
                      AND cashup_session_id =
                        $2::uuid
                  ) AS linked_payments,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.edge_outbox
                    WHERE restaurant_id = $1
                      AND event_id =
                        $3::uuid
                  ) AS cashup_outbox
                `,
                [
                  restaurantId,
                  cashupSessionId,
                  cashupEventId,
                ]
              );

            assert.deepEqual(
              afterRestart.rows[0],
              beforeRestart.rows[0],
              "Cold restart changed durable cash-up/payment/outbox state"
            );

            /*
             * Critical operational proof:
             *
             * create a NEW real POS sale through the
             * freshly restarted Edge server with Cloud
             * still physically unreachable.
             */
            const postRestartOrder =
              await jsonFetch(
                `http://127.0.0.1:${edgeHttpPort}/orders/grouped`,
                {
                  method:
                    "POST",

                  headers: {
                    authorization:
                      `Bearer ${edgeFixtures.token}`,
                  },

                  body: {
                    order_type:
                      "takeaway",

                    table_number:
                      "Takeaway",

                    source:
                      "pos",

                    items: [
                      {
                        meal_id:
                          edgeFixtures
                            .mealId,

                        item_source:
                          "meals",

                        source:
                          "meals",

                        item_type:
                          "meals",

                        category:
                          "meals",

                        meal_name:
                          "FAKE COLD-RESTART BROWSER BURGER",

                        name:
                          "FAKE COLD-RESTART BROWSER BURGER",

                        quantity:
                          1,

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
                  },
                }
              );

            assert.equal(
              postRestartOrder.status,
              201,
              `Cold-start POS order failed: ${postRestartOrder.status} ${JSON.stringify(
                postRestartOrder.data
              )}\n${edgeServer.output()}`
            );

            coldRestartBatchId =
              String(
                postRestartOrder.data
                  ?.batch_id ||
                ""
              );

            assert.match(
              coldRestartBatchId,
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            );

            assert.notEqual(
              coldRestartBatchId,
              batchId,
              "Cold restart reused the original sale batch UUID"
            );

            /*
             * The freshly restarted HTTP process must
             * have persisted BOTH POS and KDS state.
             */
            const localColdRows =
              await edge.pool.query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.pos_orders
                    WHERE restaurant_id = $1
                      AND batch_id =
                        $2::uuid
                  ) AS pos_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.orders
                    WHERE restaurant_id = $1
                      AND batch_id =
                        $2::uuid
                  ) AS kds_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.edge_outbox
                    WHERE restaurant_id = $1
                      AND entity_id =
                        $2::text
                  ) AS outbox_rows
                `,
                [
                  restaurantId,
                  coldRestartBatchId,
                ]
              );

            assert.ok(
              Number(
                localColdRows.rows[0]
                  .pos_rows
              ) > 0,
              "Cold-start POS created no local POS rows"
            );

            assert.ok(
              Number(
                localColdRows.rows[0]
                  .kds_rows
              ) > 0,
              "Cold-start POS created no local KDS rows"
            );

            assert.ok(
              Number(
                localColdRows.rows[0]
                  .outbox_rows
              ) > 0,
              "Cold-start POS created no durable Edge outbox event"
            );

            /*
             * Most important isolation check:
             * Cloud is STILL offline and knows nothing
             * about the new post-restart batch.
             */
            assert.equal(
              await isPortOpen(
                cloudPort
              ),
              false
            );

            const cloudColdRows =
              await cloudPool.query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.pos_orders
                    WHERE restaurant_id = $1
                      AND batch_id =
                        $2::uuid
                  ) AS pos_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.orders
                    WHERE restaurant_id = $1
                      AND batch_id =
                        $2::uuid
                  ) AS kds_rows
                `,
                [
                  restaurantId,
                  coldRestartBatchId,
                ]
              );

            assert.equal(
              Number(
                cloudColdRows.rows[0]
                  .pos_rows
              ),
              0,
              "Cloud received cold-start POS rows during WAN blackout"
            );

            assert.equal(
              Number(
                cloudColdRows.rows[0]
                  .kds_rows
              ),
              0,
              "Cloud received cold-start KDS rows during WAN blackout"
            );

            assert.equal(
              edgeServer
                .child
                .exitCode,
              null,
              "Cold-start Edge process died after local operation"
            );

            console.log(
              "✅ COLD-A Edge server restarted with Cloud dead, re-authenticated locally, reopened KDS/Cash-Up, and accepted a new POS+KDS order"
            );
          }
        );

      await t.test(
        "Cloud return lets the real agent reconstruct the offline sale exactly once",
        async () => {
          await listenCloud(
            cloudServer,
            cloudPort
          );

          await waitFor(
            async () => {
              const inbox =
                await cloudPool
                  .query(
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

              const outbox =
                await edgeOutboxForBatch({
                  pool:
                    edge.pool,
                  restaurantId,
                  batchId,
                });

              return (
                inbox.rows[0]
                  ?.status ===
                  "applied" &&
                Boolean(
                  inbox.rows[0]
                    ?.applied_at
                ) &&
                outbox
                  ?.status ===
                  "acked" &&
                Boolean(
                  outbox
                    ?.acked_at
                )
              );
            },
            {
              timeoutMs:
                30000,
              message:
                `Offline POS event did not converge after Cloud return.\nAGENT:\n${agent.output()}`,
            }
          );

          const cloudBatch =
            await cloudPool
              .query(
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
                  AND
                  id = $2::uuid
                `,
                [
                  restaurantId,
                  batchId,
                ]
              );

          assert.equal(
            cloudBatch.rows.length,
            1
          );

          assert.equal(
            String(
              cloudBatch.rows[0]
                .id
            ),
            batchId
          );

          const edgePos =
            await edge.pool
              .query(
                `
                SELECT
                  id,
                  item_name,
                  quantity,
                  total_price,
                  order_status,
                  source,
                  edge_submission_id,
                  edge_row_ordinal
                FROM
                  public.pos_orders
                WHERE
                  restaurant_id = $1
                  AND
                  batch_id = $2::uuid
                ORDER BY
                  edge_row_ordinal,
                  id
                `,
                [
                  restaurantId,
                  batchId,
                ]
              );

          const cloudPos =
            await cloudPool
              .query(
                `
                SELECT
                  id,
                  item_name,
                  quantity,
                  total_price,
                  order_status,
                  source,
                  edge_submission_id,
                  edge_row_ordinal
                FROM
                  public.pos_orders
                WHERE
                  restaurant_id = $1
                  AND
                  batch_id = $2::uuid
                ORDER BY
                  edge_row_ordinal,
                  id
                `,
                [
                  restaurantId,
                  batchId,
                ]
              );

          assert.equal(
            cloudPos.rows.length,
            eventSnapshot
              .pos_rows
              .length
          );

          assert.deepEqual(
            cloudPos.rows.map(
              comparablePosRow
            ),
            eventSnapshot
              .pos_rows
              .map(
                comparableEventPosRow
              )
          );

          const edgeIds =
            new Set(
              edgePos.rows.map(
                (row) =>
                  Number(
                    row.id
                  )
              )
            );

          const cloudIds =
            cloudPos.rows.map(
              (row) =>
                Number(
                  row.id
                )
            );

          assert.equal(
            cloudIds.some(
              (id) =>
                edgeIds.has(
                  id
                )
            ),
            false,
            "Cloud reused an Edge-local BIGSERIAL POS id"
          );

          const cloudKds =
            await cloudPool
              .query(
                `
                SELECT
                  meal_name,
                  quantity,
                  total_price,
                  order_type,
                  order_status
                FROM
                  public.orders
                WHERE
                  restaurant_id = $1
                  AND
                  batch_id = $2::uuid
                ORDER BY
                  id
                `,
                [
                  restaurantId,
                  batchId,
                ]
              );

          assert.equal(
            cloudKds.rows.length,
            eventSnapshot
              .kds_rows
              .length
          );

          assert.deepEqual(
            cloudKds.rows.map(
              comparableKdsRow
            ),
            eventSnapshot
              .kds_rows
              .map(
                comparableKdsRow
              )
          );

          const inbox =
            await cloudPool
              .query(
                `
                SELECT
                  COUNT(*)::int
                    AS count,
                  MAX(status)
                    AS status
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
            Number(
              inbox.rows[0]
                .count
            ),
            1
          );

          assert.equal(
            inbox.rows[0]
              .status,
            "applied"
          );

          const outbox =
            await edgeOutboxForBatch({
              pool:
                edge.pool,
              restaurantId,
              batchId,
            });

          assert.equal(
            outbox
              ?.status,
            "acked"
          );

          assert.ok(
            outbox
              ?.acked_at
          );

          console.log(
            "✅ 05 Cloud return reconstructed same batch with new Cloud POS ids and ACKed Edge"
          );
        }
      );


      await t.test(
        "real agent reconstructs the immutable settlement + tender on Cloud using Cloud-local POS ids",
        async () => {
          await waitFor(
            async () => {
              const inbox =
                await cloudPool.query(
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
                    financialEventId,
                  ]
                );

              const outbox =
                await edge.pool.query(
                  `
                  SELECT
                    status,
                    acked_at
                  FROM
                    public.edge_outbox
                  WHERE
                    event_id =
                      $1::uuid
                  `,
                  [
                    financialEventId,
                  ]
                );

              return (
                inbox.rows[0]
                  ?.status ===
                  "applied" &&
                Boolean(
                  inbox.rows[0]
                    ?.applied_at
                ) &&
                outbox.rows[0]
                  ?.status ===
                  "acked" &&
                Boolean(
                  outbox.rows[0]
                    ?.acked_at
                )
              );
            },
            {
              timeoutMs:
                30000,

              message:
                `Offline financial settlement did not converge after Cloud return.\nAGENT:\n${agent.output()}`,
            }
          );

          const edgePos =
            await edge.pool.query(
              `
              SELECT
                id
              FROM
                public.pos_orders
              WHERE
                restaurant_id = $1
                AND batch_id =
                  $2::uuid
              ORDER BY
                edge_row_ordinal,
                id
              `,
              [
                restaurantId,
                batchId,
              ]
            );

          const cloudPos =
            await cloudPool.query(
              `
              SELECT
                id,
                paid,
                amount_paid,
                remaining_price
              FROM
                public.pos_orders
              WHERE
                restaurant_id = $1
                AND batch_id =
                  $2::uuid
              ORDER BY
                edge_row_ordinal,
                id
              `,
              [
                restaurantId,
                batchId,
              ]
            );

          assert.equal(
            cloudPos.rows.length,
            2
          );

          const edgeIds =
            edgePos.rows
              .map(
                (row) =>
                  Number(
                    row.id
                  )
              )
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              );

          const cloudIds =
            cloudPos.rows
              .map(
                (row) =>
                  Number(
                    row.id
                  )
              )
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              );

          assert.equal(
            cloudIds.some(
              (id) =>
                edgeIds.includes(
                  id
                )
            ),
            false,
            "Cloud financial materialization reused an Edge-local POS BIGINT"
          );

          const cloudSettlement =
            await cloudPool.query(
              `
              SELECT
                id,
                restaurant_id,
                batch_id,
                final_amount,
                pos_order_ids,
                pricing_snapshot,
                voucher_id,
                created_by_user_id
              FROM
                public.payment_settlements
              WHERE
                restaurant_id = $1
                AND id =
                  $2::uuid
              `,
              [
                restaurantId,
                settlementId,
              ]
            );

          assert.equal(
            cloudSettlement.rows.length,
            1
          );

          const settlement =
            cloudSettlement.rows[0];

          assert.equal(
            String(
              settlement.id
            ),
            settlementId
          );

          assert.equal(
            Number(
              settlement
                .restaurant_id
            ),
            restaurantId
          );

          assert.equal(
            String(
              settlement.batch_id
            ),
            batchId
          );

          assert.equal(
            Number(
              settlement.final_amount
            ),
            Number(
              financialPayload
                .settlement
                .final_amount
            )
          );

          assert.deepEqual(
            (
              settlement
                .pos_order_ids ||
              []
            )
              .map(Number)
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              ),
            cloudIds,
            "Cloud settlement did not remap portable refs to Cloud-local POS ids"
          );

          assert.equal(
            (
              settlement
                .pos_order_ids ||
              []
            )
              .map(Number)
              .some(
                (id) =>
                  edgeIds.includes(
                    id
                  )
              ),
            false,
            "Cloud settlement retained an Edge-local POS BIGINT"
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

          const pricingText =
            JSON.stringify(
              settlement
                .pricing_snapshot ||
              {}
            );

          assert.equal(
            pricingText.includes(
              '"order_ref"'
            ),
            false,
            "Cloud pricing snapshot retained portable wire order_ref markers"
          );

          for (
            const edgeId of
              edgeIds
          ) {
            assert.equal(
              pricingText.includes(
                `"pos_order_id":${edgeId}`
              ),
              false,
              `Cloud pricing snapshot leaked Edge-local POS id ${edgeId}`
            );
          }

          const cloudTender =
            await cloudPool.query(
              `
              SELECT
                payment_uuid,
                settlement_id,
                restaurant_id,
                amount,
                method,
                pos_order_ids,
                staff_user_id,
                cashup_session_id,
                ref_payment_id,
                ref_payment_uuid
              FROM
                public.payments
              WHERE
                restaurant_id = $1
                AND payment_uuid =
                  $2::uuid
              `,
              [
                restaurantId,
                paymentUuid,
              ]
            );

          assert.equal(
            cloudTender.rows.length,
            1
          );

          const tender =
            cloudTender.rows[0];

          assert.equal(
            String(
              tender.payment_uuid
            ),
            paymentUuid
          );

          assert.equal(
            String(
              tender.settlement_id
            ),
            settlementId
          );

          assert.equal(
            Number(
              tender.restaurant_id
            ),
            restaurantId
          );

          assert.equal(
            Number(
              tender.amount
            ),
            Number(
              financialPayload
                .tenders[0]
                .amount
            )
          );

          assert.deepEqual(
            (
              tender
                .pos_order_ids ||
              []
            )
              .map(Number)
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              ),
            cloudIds,
            "Cloud tender did not remap portable refs to Cloud-local POS ids"
          );

          assert.equal(
            tender
              .staff_user_id,
            null
          );

          /*
           * Cash-up convergence is asynchronous.
           *
           * FIN-B may observe the tender before
           * cash-up apply, or after the agent has
           * already attached the exact WAN-off
           * cash-up session.
           *
           * No other cash-up UUID is legal here.
           * CASH-B below proves final convergence.
           */
          assert.ok(
            tender
              .cashup_session_id ==
              null ||
            String(
              tender
                .cashup_session_id
            ) ===
              cashupSessionId,
            `Cloud tender linked to unexpected cash-up session: ${
              tender
                .cashup_session_id
            }`
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

          /*
           * Initial financial materializer is intentionally
           * immutable-ledger only.
           *
           * It MUST NOT mutate Cloud POS balances yet.
           */
          assert.ok(
            cloudPos.rows.every(
              (row) =>
                Number(
                  row.paid
                ) ===
                0
            ),
            "Immutable financial materializer mutated Cloud POS paid state"
          );

          assert.ok(
            cloudPos.rows.every(
              (row) =>
                Number(
                  row.amount_paid
                ) ===
                0
            ),
            "Immutable financial materializer mutated Cloud POS amount_paid"
          );

          const financeInbox =
            await cloudPool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count,
                MAX(status)
                  AS status
              FROM
                public.edge_inbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                financialEventId,
              ]
            );

          assert.equal(
            Number(
              financeInbox.rows[0]
                .count
            ),
            1
          );

          assert.equal(
            financeInbox.rows[0]
              .status,
            "applied"
          );

          const financeOutbox =
            await edge.pool.query(
              `
              SELECT
                status,
                acked_at
              FROM
                public.edge_outbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                financialEventId,
              ]
            );

          assert.equal(
            financeOutbox.rows[0]
              ?.status,
            "acked"
          );

          assert.ok(
            financeOutbox.rows[0]
              ?.acked_at
          );

          console.log(
            "✅ FIN-B Cloud reconstructed same settlement/payment UUIDs with different Cloud-local POS BIGINTs"
          );
        }
      );


      await t.test(
        "real agent reconstructs WAN-off refund with Cloud-local payment identity",
        async () => {
          assert.match(
            refundUuid,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.match(
            refundEventId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          await waitFor(
            async () => {
              const inbox =
                await cloudPool.query(
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
                    refundEventId,
                  ]
                );

              const outbox =
                await edge.pool.query(
                  `
                  SELECT
                    status,
                    acked_at
                  FROM
                    public.edge_outbox
                  WHERE
                    event_id =
                      $1::uuid
                  `,
                  [
                    refundEventId,
                  ]
                );

              return (
                inbox.rows[0]
                  ?.status ===
                  "applied" &&
                Boolean(
                  inbox.rows[0]
                    ?.applied_at
                ) &&
                outbox.rows[0]
                  ?.status ===
                  "acked" &&
                Boolean(
                  outbox.rows[0]
                    ?.acked_at
                )
              );
            },
            {
              timeoutMs:
                30000,

              message:
                `WAN-off refund did not converge after Cloud return.\nAGENT:\n${agent.output()}`,
            }
          );

          const edgeOriginalResult =
            await edge.pool.query(
              `
              SELECT
                id,
                payment_uuid,
                batch_id,
                pos_order_ids
              FROM
                public.payments
              WHERE
                restaurant_id = $1
                AND payment_uuid =
                  $2::uuid
              `,
              [
                restaurantId,
                paymentUuid,
              ]
            );

          const edgeRefundResult =
            await edge.pool.query(
              `
              SELECT
                id,
                amount,
                batch_id,
                pos_order_ids,
                source,
                status,
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
                restaurantId,
                refundUuid,
              ]
            );

          const cloudOriginalResult =
            await cloudPool.query(
              `
              SELECT
                id,
                payment_uuid,
                batch_id,
                pos_order_ids
              FROM
                public.payments
              WHERE
                restaurant_id = $1
                AND payment_uuid =
                  $2::uuid
              `,
              [
                restaurantId,
                paymentUuid,
              ]
            );

          const cloudRefundResult =
            await cloudPool.query(
              `
              SELECT
                id,
                amount,
                batch_id,
                pos_order_ids,
                source,
                status,
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
                restaurantId,
                refundUuid,
              ]
            );

          assert.equal(
            edgeOriginalResult.rows.length,
            1
          );

          assert.equal(
            edgeRefundResult.rows.length,
            1
          );

          assert.equal(
            cloudOriginalResult.rows.length,
            1
          );

          assert.equal(
            cloudRefundResult.rows.length,
            1
          );

          const edgeA =
            edgeOriginalResult.rows[0];

          const edgeB =
            edgeRefundResult.rows[0];

          const cloudA =
            cloudOriginalResult.rows[0];

          const cloudB =
            cloudRefundResult.rows[0];

          assert.notEqual(
            Number(
              edgeA.id
            ),
            Number(
              cloudA.id
            ),
            "Cloud reused Edge-local original payment BIGINT"
          );

          assert.equal(
            String(
              cloudA.payment_uuid
            ),
            paymentUuid
          );

          assert.equal(
            String(
              cloudB.payment_uuid
            ),
            refundUuid
          );

          assert.equal(
            String(
              cloudB.ref_payment_uuid
            ),
            paymentUuid
          );

          assert.equal(
            Number(
              cloudB.ref_payment_id
            ),
            Number(
              cloudA.id
            ),
            "Cloud refund did not resolve ref_payment_id to Cloud-local A"
          );

          assert.equal(
            Number(
              edgeB.ref_payment_id
            ),
            Number(
              edgeA.id
            )
          );

          assert.notEqual(
            Number(
              cloudB.ref_payment_id
            ),
            Number(
              edgeB.ref_payment_id
            ),
            "Refund lineage still depends on Edge-local payment BIGINT"
          );

          assert.equal(
            Number(
              cloudB.amount
            ),
            Number(
              refundPayload
                .refund
                .amount
            )
          );

          assert.equal(
            cloudB.source,
            "refund"
          );

          assert.equal(
            cloudB.status,
            "completed"
          );

          assert.equal(
            String(
              cloudB.batch_id
            ),
            String(
              refundPayload
                .refund
                .batch_id
            )
          );

          assert.notEqual(
            String(
              cloudB.batch_id
            ),
            String(
              cloudA.batch_id
            ),
            "Cloud forced refund batch back to original tender batch"
          );

          const cloudPos =
            await cloudPool.query(
              `
              SELECT
                id,
                batch_id,
                edge_submission_id,
                edge_row_ordinal,
                paid,
                amount_paid,
                remaining_price
              FROM
                public.pos_orders
              WHERE
                restaurant_id = $1
                AND batch_id =
                  $2::uuid
              ORDER BY
                edge_row_ordinal,
                id
              `,
              [
                restaurantId,
                batchId,
              ]
            );

          assert.equal(
            cloudPos.rows.length,
            2
          );

          const expectedCloudRefundIds =
            refundPayload
              .refund
              .order_refs
              .map(
                (ref) => {
                  const row =
                    cloudPos.rows.find(
                      (candidate) =>
                        String(
                          candidate
                            .edge_submission_id
                        ) ===
                          String(
                            ref
                              .edge_submission_id
                          ) &&
                        Number(
                          candidate
                            .edge_row_ordinal
                        ) ===
                          Number(
                            ref
                              .edge_row_ordinal
                          ) &&
                        String(
                          candidate
                            .batch_id
                        ) ===
                          String(
                            ref
                              .batch_id
                          )
                    );

                  assert.ok(
                    row,
                    "Cloud refund portable POS reference did not resolve"
                  );

                  return Number(
                    row.id
                  );
                }
              )
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              );

          const cloudRefundIds =
            (
              Array.isArray(
                cloudB.pos_order_ids
              )
                ? cloudB.pos_order_ids
                : JSON.parse(
                    cloudB
                      .pos_order_ids ||
                    "[]"
                  )
            )
              .map(Number)
              .sort(
                (
                  left,
                  right
                ) =>
                  left -
                  right
              );

          assert.deepEqual(
            cloudRefundIds,
            expectedCloudRefundIds,
            "Cloud refund did not remap portable refs to Cloud-local POS ids"
          );

          const edgeRefundIds =
            (
              Array.isArray(
                edgeB.pos_order_ids
              )
                ? edgeB.pos_order_ids
                : JSON.parse(
                    edgeB
                      .pos_order_ids ||
                    "[]"
                  )
            ).map(Number);

          assert.equal(
            cloudRefundIds.some(
              (id) =>
                edgeRefundIds.includes(
                  id
                )
            ),
            false,
            "Cloud refund retained Edge-local POS BIGINT"
          );

          /*
           * Refund Cloud materialization is still
           * immutable-ledger only.
           */
          assert.ok(
            cloudPos.rows.every(
              (row) =>
                Number(
                  row.amount_paid
                ) ===
                0
            ),
            "Cloud refund materializer mutated POS amount_paid"
          );

          const refundInbox =
            await cloudPool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count,
                MAX(status)
                  AS status
              FROM
                public.edge_inbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                refundEventId,
              ]
            );

          assert.equal(
            Number(
              refundInbox.rows[0]
                .count
            ),
            1
          );

          assert.equal(
            refundInbox.rows[0]
              .status,
            "applied"
          );

          const refundOutbox =
            await edge.pool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count,
                MAX(status)
                  AS status,
                MAX(acked_at)
                  AS acked_at
              FROM
                public.edge_outbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                refundEventId,
              ]
            );

          assert.equal(
            Number(
              refundOutbox.rows[0]
                .count
            ),
            1
          );

          assert.equal(
            refundOutbox.rows[0]
              .status,
            "acked"
          );

          assert.ok(
            refundOutbox.rows[0]
              .acked_at
          );

          console.log(
            "✅ FIN-R-B Cloud reconstructed refund B -> original A using Cloud-local payment/POS identities"
          );
        }
      );


        await t.test(
          "real agent reconstructs WAN-off cash-up using Cloud-local payment identities",
          async () => {
            assert.ok(
              cashupSessionId
            );

            assert.ok(
              cashupEventId
            );

            assert.ok(
              cashupPayload
            );

            await waitFor(
              async () => {
                const inbox =
                  await cloudPool.query(
                    `
                    SELECT
                      status,
                      applied_at
                    FROM public.edge_inbox
                    WHERE event_id =
                      $1::uuid
                    `,
                    [
                      cashupEventId,
                    ]
                  );

                const outbox =
                  await edge.pool.query(
                    `
                    SELECT
                      status,
                      acked_at
                    FROM public.edge_outbox
                    WHERE event_id =
                      $1::uuid
                    `,
                    [
                      cashupEventId,
                    ]
                  );

                return (
                  inbox.rows[0]
                    ?.status ===
                    "applied" &&
                  Boolean(
                    inbox.rows[0]
                      ?.applied_at
                  ) &&
                  outbox.rows[0]
                    ?.status ===
                    "acked" &&
                  Boolean(
                    outbox.rows[0]
                      ?.acked_at
                  )
                );
              },
              {
                timeoutMs:
                  30000,

                message:
                  `WAN-off cash-up failed to converge.\nAGENT:\n${agent.output()}`,
              }
            );

            const sessionResult =
              await cloudPool.query(
                `
                SELECT
                  id,
                  restaurant_id,
                  expected_cash,
                  actual_cash,
                  discrepancy,
                  closed_by_user_id,
                  closed_by_name
                FROM public.cashup_sessions
                WHERE restaurant_id = $1
                  AND id = $2::uuid
                `,
                [
                  restaurantId,
                  cashupSessionId,
                ]
              );

            assert.equal(
              sessionResult.rows.length,
              1
            );

            const session =
              sessionResult.rows[0];

            assert.equal(
              String(
                session.id
              ),
              cashupSessionId
            );

            assert.equal(
              session
                .closed_by_user_id,
              null,
              "Cloud stored Edge-local closer BIGINT"
            );

            assert.equal(
              String(
                session
                  .closed_by_name ||
                ""
              ),
              String(
                cashupPayload
                  .session
                  .closed_by_name ||
                ""
              )
            );

            assert.equal(
              Number(
                session
                  .expected_cash
              ),
              Number(
                cashupPayload
                  .session
                  .expected_cash
              )
            );

            assert.equal(
              Number(
                session
                  .actual_cash
              ),
              Number(
                cashupPayload
                  .session
                  .actual_cash
              )
            );

            const cloudPayments =
              await cloudPool.query(
                `
                SELECT
                  payment_uuid,
                  cashup_session_id
                FROM public.payments
                WHERE restaurant_id = $1
                  AND payment_uuid =
                    ANY($2::uuid[])
                `,
                [
                  restaurantId,
                  cashupPayload
                    .payment_uuids,
                ]
              );

            assert.equal(
              cloudPayments.rows.length,
              cashupPayload
                .payment_uuids
                .length
            );

            assert.ok(
              cloudPayments.rows.every(
                (row) =>
                  String(
                    row.cashup_session_id
                  ) ===
                  cashupSessionId
              )
            );

            console.log(
              "✅ CASH-B Cloud reconstructed same cash-up UUID using Cloud-local payment identities"
            );
          }
        );

      await t.test(
        "continued agent cycles cannot duplicate the recovered sale",
        async () => {
          const before =
            await cloudPool
              .query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.pos_orders
                    WHERE
                      restaurant_id = $1
                      AND
                      batch_id = $2::uuid
                  ) AS pos_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.orders
                    WHERE
                      restaurant_id = $1
                      AND
                      batch_id = $2::uuid
                  ) AS kds_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.edge_inbox
                    WHERE
                      event_id = $3::uuid
                  ) AS inbox_rows
                `,
                [
                  restaurantId,
                  batchId,
                  eventId,
                ]
              );

          await sleep(
            2400
          );

          const after =
            await cloudPool
              .query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.pos_orders
                    WHERE
                      restaurant_id = $1
                      AND
                      batch_id = $2::uuid
                  ) AS pos_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.orders
                    WHERE
                      restaurant_id = $1
                      AND
                      batch_id = $2::uuid
                  ) AS kds_rows,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM
                      public.edge_inbox
                    WHERE
                      event_id = $3::uuid
                  ) AS inbox_rows
                `,
                [
                  restaurantId,
                  batchId,
                  eventId,
                ]
              );

          assert.deepEqual(
            after.rows[0],
            before.rows[0],
            "Repeated Edge agent cycles duplicated recovered Cloud business rows"
          );

          assert.equal(
            agent.child
              .exitCode,
            null
          );

          assert.equal(
            edgeServer
              .child
              .exitCode,
            null
          );

          console.log(
            "✅ 06 Post-recovery exactly-once stability proven"
          );
        }
      );


      await t.test(
        "continued real agent cycles cannot duplicate the recovered financial ledger",
        async () => {
          const before =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payment_settlements
                  WHERE
                    restaurant_id = $1
                    AND id =
                      $2::uuid
                ) AS settlements,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payments
                  WHERE
                    restaurant_id = $1
                    AND payment_uuid =
                      $3::uuid
                ) AS tenders,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.edge_inbox
                  WHERE
                    event_id =
                      $4::uuid
                ) AS inbox_rows
              `,
              [
                restaurantId,
                settlementId,
                paymentUuid,
                financialEventId,
              ]
            );

          assert.equal(
            Number(
              before.rows[0]
                .settlements
            ),
            1
          );

          assert.equal(
            Number(
              before.rows[0]
                .tenders
            ),
            1
          );

          assert.equal(
            Number(
              before.rows[0]
                .inbox_rows
            ),
            1
          );

          await sleep(
            2400
          );

          const after =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payment_settlements
                  WHERE
                    restaurant_id = $1
                    AND id =
                      $2::uuid
                ) AS settlements,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payments
                  WHERE
                    restaurant_id = $1
                    AND payment_uuid =
                      $3::uuid
                ) AS tenders,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.edge_inbox
                  WHERE
                    event_id =
                      $4::uuid
                ) AS inbox_rows
              `,
              [
                restaurantId,
                settlementId,
                paymentUuid,
                financialEventId,
              ]
            );

          assert.deepEqual(
            after.rows[0],
            before.rows[0],
            "Repeated real Edge agent cycles duplicated the recovered Cloud financial ledger"
          );

          assert.equal(
            agent.child
              .exitCode,
            null
          );

          assert.equal(
            edgeServer.child
              .exitCode,
            null
          );

          console.log(
            "✅ FIN-C Post-recovery financial exactly-once stability proven"
          );
        }
      );


      await t.test(
        "continued real agent cycles cannot duplicate recovered refund ledger",
        async () => {
          const before =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payments
                  WHERE
                    restaurant_id = $1
                    AND payment_uuid =
                      $2::uuid
                ) AS refund_rows,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payments
                  WHERE
                    restaurant_id = $1
                    AND payment_uuid =
                      $3::uuid
                ) AS original_rows,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.edge_inbox
                  WHERE
                    event_id =
                      $4::uuid
                ) AS refund_inbox_rows
              `,
              [
                restaurantId,
                refundUuid,
                paymentUuid,
                refundEventId,
              ]
            );

          assert.equal(
            Number(
              before.rows[0]
                .refund_rows
            ),
            1
          );

          assert.equal(
            Number(
              before.rows[0]
                .original_rows
            ),
            1
          );

          assert.equal(
            Number(
              before.rows[0]
                .refund_inbox_rows
            ),
            1
          );

          await sleep(
            2400
          );

          const after =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payments
                  WHERE
                    restaurant_id = $1
                    AND payment_uuid =
                      $2::uuid
                ) AS refund_rows,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.payments
                  WHERE
                    restaurant_id = $1
                    AND payment_uuid =
                      $3::uuid
                ) AS original_rows,

                (
                  SELECT
                    COUNT(*)::int
                  FROM
                    public.edge_inbox
                  WHERE
                    event_id =
                      $4::uuid
                ) AS refund_inbox_rows
              `,
              [
                restaurantId,
                refundUuid,
                paymentUuid,
                refundEventId,
              ]
            );

          assert.deepEqual(
            after.rows[0],
            before.rows[0],
            "Repeated real agent cycles duplicated Cloud refund ledger"
          );

          const edgeRefundOutbox =
            await edge.pool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count,
                MAX(status)
                  AS status
              FROM
                public.edge_outbox
              WHERE
                event_id =
                  $1::uuid
              `,
              [
                refundEventId,
              ]
            );

          assert.equal(
            Number(
              edgeRefundOutbox.rows[0]
                .count
            ),
            1
          );

          assert.equal(
            edgeRefundOutbox.rows[0]
              .status,
            "acked"
          );

          assert.equal(
            agent.child
              .exitCode,
            null
          );

          assert.equal(
            edgeServer.child
              .exitCode,
            null
          );

          console.log(
            "✅ FIN-R-C Post-recovery refund exactly-once stability proven"
          );
        }
      );


        await t.test(
          "continued real agent cycles cannot duplicate recovered cash-up",
          async () => {
            const before =
              await cloudPool.query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.cashup_sessions
                    WHERE restaurant_id = $1
                      AND id = $2::uuid
                  ) AS sessions,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.payments
                    WHERE restaurant_id = $1
                      AND cashup_session_id =
                        $2::uuid
                  ) AS linked_payments,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.edge_inbox
                    WHERE event_id =
                      $3::uuid
                  ) AS inbox_rows
                `,
                [
                  restaurantId,
                  cashupSessionId,
                  cashupEventId,
                ]
              );

            assert.equal(
              Number(
                before.rows[0]
                  .sessions
              ),
              1
            );

            assert.equal(
              Number(
                before.rows[0]
                  .linked_payments
              ),
              cashupPayload
                .payment_uuids
                .length
            );

            assert.equal(
              Number(
                before.rows[0]
                  .inbox_rows
              ),
              1
            );

            await sleep(
              2400
            );

            const after =
              await cloudPool.query(
                `
                SELECT
                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.cashup_sessions
                    WHERE restaurant_id = $1
                      AND id = $2::uuid
                  ) AS sessions,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.payments
                    WHERE restaurant_id = $1
                      AND cashup_session_id =
                        $2::uuid
                  ) AS linked_payments,

                  (
                    SELECT
                      COUNT(*)::int
                    FROM public.edge_inbox
                    WHERE event_id =
                      $3::uuid
                  ) AS inbox_rows
                `,
                [
                  restaurantId,
                  cashupSessionId,
                  cashupEventId,
                ]
              );

            assert.deepEqual(
              after.rows[0],
              before.rows[0],
              "Repeated Edge cycles duplicated Cloud cash-up state"
            );

            const edgeOutbox =
              await edge.pool.query(
                `
                SELECT
                  COUNT(*)::int AS count,
                  MAX(status) AS status
                FROM public.edge_outbox
                WHERE event_id =
                  $1::uuid
                `,
                [
                  cashupEventId,
                ]
              );

            assert.equal(
              Number(
                edgeOutbox.rows[0]
                  .count
              ),
              1
            );

            assert.equal(
              edgeOutbox.rows[0]
                .status,
              "acked"
            );

            assert.equal(
              agent.child
                .exitCode,
              null
            );

            assert.equal(
              edgeServer.child
                .exitCode,
              null
            );

            console.log(
              "✅ CASH-C Post-recovery cash-up exactly-once stability proven"
            );
          }
        );

      await t.test(
        "Edge process logs do not expose secrets or database URLs",
        async () => {
          const agentOutput =
            agent.output();

          const serverOutput =
            [
              preRestartEdgeServerOutput,

              edgeServer
                .output(),
            ]
              .filter(Boolean)
              .join("\n");

          assert.equal(
            agentOutput.includes(
              credentials.secret
            ),
            false
          );

          assert.equal(
            agentOutput.includes(
              edge.databaseUrl
            ),
            false
          );

          assert.equal(
            agentOutput.includes(
              DATABASE_URL
            ),
            false
          );

          assert.equal(
            serverOutput.includes(
              edge.databaseUrl
            ),
            false
          );

          assert.equal(
            serverOutput.includes(
              DATABASE_URL
            ),
            false
          );

          console.log(
            "✅ 07 Edge POS + agent secret/DB URL log hygiene proven"
          );
        }
      );

      console.log(
        "============================================================"
      );

      console.log(
        "✅ MAKS REAL OFFLINE FINANCIAL TWO-POSTGRES E2E ATTACK COMPLETE"
      );

      console.log(
        "============================================================"
      );
    } finally {
      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

      await stopChild(
        edgeServer
      );

      await stopChild(
        agent
      );

      await closeCloud(
        cloudServer
      ).catch(
        () => {}
      );

      if (
        edge
      ) {
        await edge
          .stop();
      }

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

      await cloudPool
        .end();

      console.log(
        "✅ Cleanup proven: Edge POS process, agent, Cloud HTTP, and temporary Edge PostgreSQL stopped"
      );
    }
  }
);
