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
  "MAKS real offline POS sale across separate Edge and Cloud PostgreSQL",
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
        "Edge process logs do not expose secrets or database URLs",
        async () => {
          const agentOutput =
            agent.output();

          const serverOutput =
            edgeServer
              .output();

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
        "✅ MAKS REAL OFFLINE POS TWO-POSTGRES E2E ATTACK COMPLETE"
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
