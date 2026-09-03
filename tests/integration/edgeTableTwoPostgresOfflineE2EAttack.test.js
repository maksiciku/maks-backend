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
        "maks-kds-offline-two-pg-"
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
            "edge-kds-offline-two-postgres-e2e-attack",

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
        `KDS OFFLINE CLOUD ${token}`,
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
        `KDS OFFLINE EDGE ${token}`,
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


async function edgeKdsOperationalEvents({
  pool,
  restaurantId,
  batchId,
}) {
  const result =
    await pool.query(
      `
      SELECT
        event_id,
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
        (
          (
            event_type =
              'kds.batch.state.replaced.v1'
            AND
            entity_id = $2
          )
          OR
          event_type =
            'kds.kitchen.state.replaced.v1'
        )
      ORDER BY
        id ASC
      `,
      [
        restaurantId,
        batchId,
      ]
    );

  return (
    result.rows ||
    []
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



const {
  tableOperationalDomain,
  tableBatchAssignmentDomain,
} = require(
  "../../edge/contracts/tableOperations"
);


async function seedTableShells({
  pool,
  restaurantId,
  edgeLocal = false,
}) {
  if (
    edgeLocal
  ) {
    await pool.query(
      `
      SELECT
        setval(
          pg_get_serial_sequence(
            'public.tables',
            'id'
          ),
          800000000,
          TRUE
        )
      `
    );
  }

  const names = [
    "OFFLINE TABLE A",
    "OFFLINE TABLE B",
    "OFFLINE TABLE C",
  ];

  const tables = {};

  for (
    const name of names
  ) {
    const inserted =
      await pool.query(
        `
        INSERT INTO public.tables
        (
          name,
          seats,
          restaurant_id,
          status
        )
        VALUES
        (
          $1,
          4,
          $2,
          'free'
        )
        RETURNING
          id,
          name,
          status
        `,
        [
          name,
          restaurantId,
        ]
      );

    await pool.query(
      `
      INSERT INTO public.table_map
      (
        name,
        shape,
        seats,
        x,
        y,
        zone,
        status,
        restaurant_id
      )
      VALUES
      (
        $1,
        'square',
        4,
        100,
        100,
        'Main',
        'available',
        $2
      )
      `,
      [
        name,
        restaurantId,
      ]
    );

    tables[name] = {
      id:
        Number(
          inserted.rows[0]
            .id
        ),
      name,
    };
  }

  return {
    tableA:
      tables["OFFLINE TABLE A"],
    tableB:
      tables["OFFLINE TABLE B"],
    tableC:
      tables["OFFLINE TABLE C"],
  };
}


async function loadPhysicalTableState({
  pool,
  restaurantId,
  tableName,
}) {
  const table =
    await pool.query(
      `
      SELECT
        id,
        name,
        status
      FROM
        public.tables
      WHERE
        restaurant_id = $1
        AND LOWER(TRIM(name)) =
            LOWER(TRIM($2))
      LIMIT 1
      `,
      [
        restaurantId,
        tableName,
      ]
    );

  if (
    table.rows.length !==
    1
  ) {
    return null;
  }

  const localId =
    Number(
      table.rows[0]
        .id
    );

  const map =
    await pool.query(
      `
      SELECT
        status
      FROM
        public.table_map
      WHERE
        restaurant_id = $1
        AND LOWER(TRIM(name)) =
            LOWER(TRIM($2))
      LIMIT 1
      `,
      [
        restaurantId,
        tableName,
      ]
    );

  const session =
    await pool.query(
      `
      SELECT
        covers,
        allergy_codes,
        strict_cross_contamination
      FROM
        public.pos_table_sessions
      WHERE
        restaurant_id = $1
        AND table_id = $2
      LIMIT 1
      `,
      [
        restaurantId,
        localId,
      ]
    );

  return {
    table: {
      id:
        localId,
      name:
        String(
          table.rows[0]
            .name
        ),
      status:
        String(
          table.rows[0]
            .status
        ),
    },
    map:
      map.rows[0]
        ? {
            status:
              String(
                map.rows[0]
                  .status
              ),
          }
        : null,
    session:
      session.rows[0] ||
      null,
  };
}


async function loadBatchAssignmentState({
  pool,
  restaurantId,
  batchId,
}) {
  const batch =
    await pool.query(
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
        AND id = $2::uuid
      LIMIT 1
      `,
      [
        restaurantId,
        batchId,
      ]
    );

  const pos =
    await pool.query(
      `
      SELECT
        id,
        table_number,
        paid,
        remaining_price,
        batch_id
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

  return {
    batch:
      batch.rows[0] ||
      null,
    pos:
      pos.rows,
  };
}


async function edgeTableOperationalEvents({
  pool,
  restaurantId,
  batchId,
}) {
  const result =
    await pool.query(
      `
      SELECT
        id,
        event_id,
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
        AND (
          event_type =
            'table.operational.replaced.v1'
          OR (
            event_type =
              'table.batch.assignment.replaced.v1'
            AND entity_id = $2
          )
        )
      ORDER BY
        id ASC
      `,
      [
        restaurantId,
        batchId,
      ]
    );

  return result.rows || [];
}


function latestExpectedTableRevisions(
  events
) {
  const map =
    new Map();

  for (
    const event of events
  ) {
    const payload =
      event.payload || {};

    let domain =
      null;

    if (
      event.event_type ===
      "table.operational.replaced.v1"
    ) {
      domain =
        tableOperationalDomain(
          payload
            ?.table
            ?.name
        );
    } else if (
      event.event_type ===
      "table.batch.assignment.replaced.v1"
    ) {
      domain =
        tableBatchAssignmentDomain(
          payload
            ?.batch_id
        );
    }

    if (
      !domain
    ) {
      continue;
    }

    const revision =
      Number(
        payload.revision
      );

    const existing =
      map.get(
        domain
      );

    if (
      !existing ||
      revision >
        existing.revision
    ) {
      map.set(
        domain,
        {
          revision,
          payloadHash:
            String(
              event
                .payload_hash
            ),
        }
      );
    }
  }

  return map;
}


async function transferTableHttp({
  baseUrl,
  token,
  oldTable,
  newTable,
  newOrderType = null,
}) {
  const body = {
    oldTable,
    newTable,
  };

  if (
    newOrderType
  ) {
    body.newOrderType =
      newOrderType;
  }

  return jsonFetch(
    `${baseUrl}/orders/transfer-table`,
    {
      method:
        "PUT",
      headers: {
        authorization:
          `Bearer ${token}`,
      },
      body,
    }
  );
}


test(
  "MAKS real offline table lifecycle across separate Edge and Cloud PostgreSQL",
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

    let cloudTables =
      null;

    let edgeTables =
      null;

    let batchId =
      null;

    let posEvent =
      null;

    let tableEvents =
      [];

    let tableEventIds =
      [];

    let expectedRevisions =
      new Map();

    try {
      await t.test(
        "starts genuinely separate Edge PostgreSQL with different physical table IDs",
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

          restaurantId =
            await createCloudRestaurant({
              pool:
                cloudPool,
              token,
            });

          cloudTables =
            await seedTableShells({
              pool:
                cloudPool,
              restaurantId,
              edgeLocal:
                false,
            });

          edgeFixtures =
            await seedEdgeRestaurant({
              pool:
                edge.pool,
              restaurantId,
              token,
            });

          edgeTables =
            await seedTableShells({
              pool:
                edge.pool,
              restaurantId,
              edgeLocal:
                true,
            });

          for (
            const key of [
              "tableA",
              "tableB",
              "tableC",
            ]
          ) {
            assert.equal(
              edgeTables[key]
                .name,
              cloudTables[key]
                .name
            );

            assert.notEqual(
              edgeTables[key]
                .id,
              cloudTables[key]
                .id,
              `Edge and Cloud unexpectedly share local BIGINT table id for ${key}`
            );
          }

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

          console.log(
            `✅ 01 Separate Cloud/Edge PostgreSQL + divergent local table BIGINT IDs proven`
          );
        }
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
          `TABLE OFFLINE EDGE ${token}`,
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
        "✅ 02 Real Edge agent survives with Cloud HTTP physically unreachable"
      );

      await t.test(
        "real Edge server authenticates local owner while Cloud is unreachable",
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
                  `Edge server exited during boot:\n${edgeServer.output()}`
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
                `Edge HTTP did not start:\n${edgeServer.output()}`,
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

          edgeFixtures.token =
            login.data
              .token;

          assert.equal(
            await isPortOpen(
              cloudPort
            ),
            false
          );

          console.log(
            "✅ 03 Edge-only owner authenticated against real local HTTP"
          );
        }
      );

      await t.test(
        "WAN-off table session + dine-in sale + A->B->Takeaway->C transfers commit only on Edge",
        async () => {
          const baseUrl =
            `http://127.0.0.1:${edgeHttpPort}`;

          const auth = {
            authorization:
              `Bearer ${edgeFixtures.token}`,
          };

          const occupied =
            await jsonFetch(
              `${baseUrl}/tables/${edgeTables.tableA.id}/status`,
              {
                method:
                  "PUT",
                headers:
                  auth,
                body: {
                  status:
                    "occupied",
                },
              }
            );

          assert.equal(
            occupied.status,
            200,
            JSON.stringify(
              occupied.data
            )
          );

          const session =
            await jsonFetch(
              `${baseUrl}/pos/table-session/${edgeTables.tableA.id}`,
              {
                method:
                  "POST",
                headers:
                  auth,
                body: {
                  covers:
                    4,
                  allergy_codes: [
                    "milk",
                    "sesame",
                  ],
                  strict_cross_contamination:
                    true,
                },
              }
            );

          assert.equal(
            session.status,
            200,
            JSON.stringify(
              session.data
            )
          );

          const order =
            await jsonFetch(
              `${baseUrl}/orders/grouped`,
              {
                method:
                  "POST",
                headers:
                  auth,
                body: {
                  order_type:
                    "dine-in",
                  table_number:
                    edgeTables
                      .tableA
                      .name,
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
                        "FAKE OFFLINE TABLE BROWSER BURGER",
                      name:
                        "FAKE OFFLINE TABLE BROWSER BURGER",
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
            order.status,
            201,
            `Offline grouped order failed: ${order.status} ${JSON.stringify(
              order.data
            )}\n${edgeServer.output()}`
          );

          batchId =
            String(
              order.data
                ?.batch_id ||
              ""
            );

          assert.match(
            batchId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );

          assert.equal(
            Number(
              order.data
                ?.total
            ),
            25,
            "Offline Edge did not apply authoritative price"
          );

          const firstTransfer =
            await transferTableHttp({
              baseUrl,
              token:
                edgeFixtures
                  .token,
              oldTable:
                edgeTables
                  .tableA
                  .name,
              newTable:
                edgeTables
                  .tableB
                  .name,
            });

          assert.equal(
            firstTransfer.status,
            200,
            JSON.stringify(
              firstTransfer.data
            )
          );

          const takeawayTransfer =
            await transferTableHttp({
              baseUrl,
              token:
                edgeFixtures
                  .token,
              oldTable:
                edgeTables
                  .tableB
                  .name,
              newTable:
                "Takeaway",
              newOrderType:
                "takeaway",
            });

          assert.equal(
            takeawayTransfer.status,
            200,
            JSON.stringify(
              takeawayTransfer.data
            )
          );

          const backToPhysical =
            await transferTableHttp({
              baseUrl,
              token:
                edgeFixtures
                  .token,
              oldTable:
                "Takeaway",
              newTable:
                edgeTables
                  .tableC
                  .name,
              newOrderType:
                "dine-in",
            });

          assert.equal(
            backToPhysical.status,
            200,
            JSON.stringify(
              backToPhysical.data
            )
          );

          /*
           * Mirror the real POS Takeaway -> table flow:
           * restore the saved table session, then confirm occupied.
           */
          const restoredSession =
            await jsonFetch(
              `${baseUrl}/pos/table-session/${edgeTables.tableC.id}`,
              {
                method:
                  "POST",
                headers:
                  auth,
                body: {
                  covers:
                    2,
                  allergy_codes: [
                    "milk",
                    "sesame",
                  ],
                  strict_cross_contamination:
                    true,
                },
              }
            );

          assert.equal(
            restoredSession.status,
            200,
            JSON.stringify(
              restoredSession.data
            )
          );

          const confirmedOccupied =
            await jsonFetch(
              `${baseUrl}/tables/${edgeTables.tableC.id}/status`,
              {
                method:
                  "PUT",
                headers:
                  auth,
                body: {
                  status:
                    "occupied",
                },
              }
            );

          assert.equal(
            confirmedOccupied.status,
            200,
            JSON.stringify(
              confirmedOccupied.data
            )
          );

          const edgeAssignment =
            await loadBatchAssignmentState({
              pool:
                edge.pool,
              restaurantId,
              batchId,
            });

          assert.equal(
            edgeAssignment
              .batch
              ?.table_number,
            edgeTables
              .tableC
              .name
          );

          assert.equal(
            edgeAssignment
              .batch
              ?.order_type,
            "dine-in"
          );

          assert.equal(
            edgeAssignment
              .batch
              ?.pickup_number,
            null
          );

          assert.ok(
            edgeAssignment
              .pos
              .length >
            0
          );

          assert.ok(
            edgeAssignment
              .pos
              .every(
                (row) =>
                  row.table_number ===
                  edgeTables
                    .tableC
                    .name
              )
          );

          const edgeA =
            await loadPhysicalTableState({
              pool:
                edge.pool,
              restaurantId,
              tableName:
                edgeTables
                  .tableA
                  .name,
            });

          const edgeB =
            await loadPhysicalTableState({
              pool:
                edge.pool,
              restaurantId,
              tableName:
                edgeTables
                  .tableB
                  .name,
            });

          const edgeC =
            await loadPhysicalTableState({
              pool:
                edge.pool,
              restaurantId,
              tableName:
                edgeTables
                  .tableC
                  .name,
            });

          assert.equal(
            edgeA.table.status,
            "free"
          );

          assert.equal(
            edgeA.map.status,
            "free"
          );

          assert.equal(
            edgeA.session,
            null
          );

          assert.equal(
            edgeB.table.status,
            "free"
          );

          assert.equal(
            edgeB.map.status,
            "free"
          );

          assert.equal(
            edgeB.session,
            null
          );

          assert.equal(
            edgeC.table.status,
            "occupied"
          );

          assert.equal(
            edgeC.map.status,
            "occupied"
          );

          assert.ok(
            edgeC.session
          );

          assert.equal(
            Number(
              edgeC.session
                .covers
            ),
            2
          );

          assert.deepEqual(
            edgeC.session
              .allergy_codes,
            [
              "milk",
              "sesame",
            ]
          );

          assert.equal(
            Boolean(
              edgeC.session
                .strict_cross_contamination
            ),
            true
          );

          const fakeEdgePhysical =
            await edge.pool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.tables
              WHERE
                restaurant_id = $1
                AND LOWER(TRIM(name)) IN (
                  'takeaway',
                  'delivery'
                )
              `,
              [
                restaurantId,
              ]
            );

          assert.equal(
            Number(
              fakeEdgePhysical
                .rows[0]
                .count
            ),
            0
          );

          posEvent =
            await edgeOutboxForBatch({
              pool:
                edge.pool,
              restaurantId,
              batchId,
            });

          assert.ok(
            posEvent,
            "Offline Edge produced no durable POS outbox event"
          );

          assert.equal(
            posEvent.status ===
              "acked",
            false,
            "POS event was ACKed while Cloud HTTP was unreachable"
          );

          tableEvents =
            await edgeTableOperationalEvents({
              pool:
                edge.pool,
              restaurantId,
              batchId,
            });

          assert.ok(
            tableEvents.length >=
              7,
            `Expected durable table events, got ${tableEvents.length}`
          );

          assert.ok(
            tableEvents.every(
              (event) =>
                event.status !==
                "acked"
            ),
            "A table event was ACKed while Cloud HTTP was unreachable"
          );

          const assignmentEvents =
            tableEvents.filter(
              (event) =>
                event.event_type ===
                "table.batch.assignment.replaced.v1"
            );

          assert.equal(
            assignmentEvents.length,
            3,
            "Expected exactly three stable batch-assignment events"
          );

          assert.deepEqual(
            assignmentEvents.map(
              (event) =>
                event.payload
                  ?.assignment
                  ?.table_number
            ),
            [
              edgeTables
                .tableB
                .name,
              "Takeaway",
              edgeTables
                .tableC
                .name,
            ]
          );

          const sessionSnapshots =
            tableEvents.filter(
              (event) =>
                event.event_type ===
                  "table.operational.replaced.v1" &&
                event.payload
                  ?.session
            );

          assert.ok(
            sessionSnapshots.some(
              (event) =>
                String(
                  event.payload
                    ?.table
                    ?.name
                ) ===
                  edgeTables
                    .tableA
                    .name &&
                Number(
                  event.payload
                    ?.session
                    ?.covers
                ) ===
                  4
            ),
            "Table A session snapshot was not durable in the offline outbox"
          );

          assert.ok(
            sessionSnapshots.some(
              (event) =>
                String(
                  event.payload
                    ?.table
                    ?.name
                ) ===
                  edgeTables
                    .tableC
                    .name &&
                Number(
                  event.payload
                    ?.session
                    ?.covers
                ) ===
                  2
            ),
            "Restored Table C session snapshot was not durable in the offline outbox"
          );

          assert.equal(
            tableEvents.some(
              (event) => {
                if (
                  event.event_type !==
                  "table.operational.replaced.v1"
                ) {
                  return false;
                }

                const normalized =
                  String(
                    event.payload
                      ?.table
                      ?.name ||
                    ""
                  )
                    .trim()
                    .toLowerCase();

                return (
                  normalized ===
                    "takeaway" ||
                  normalized ===
                    "delivery"
                );
              }
            ),
            false,
            "Virtual Takeaway/Delivery emitted a fake physical-table event"
          );

          tableEventIds =
            tableEvents.map(
              (event) =>
                String(
                  event.event_id
                )
            );

          expectedRevisions =
            latestExpectedTableRevisions(
              tableEvents
            );

          const cloudBefore =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT COUNT(*)::int
                  FROM public.order_batches
                  WHERE restaurant_id = $1
                    AND id = $2::uuid
                ) AS batches,
                (
                  SELECT COUNT(*)::int
                  FROM public.pos_orders
                  WHERE restaurant_id = $1
                    AND batch_id = $2::uuid
                ) AS pos_rows,
                (
                  SELECT COUNT(*)::int
                  FROM public.edge_inbox
                  WHERE event_id = ANY($3::uuid[])
                ) AS inbox_rows,
                (
                  SELECT COUNT(*)::int
                  FROM public.pos_table_sessions
                  WHERE restaurant_id = $1
                ) AS sessions
              `,
              [
                restaurantId,
                batchId,
                [
                  String(
                    posEvent.event_id
                  ),
                  ...tableEventIds,
                ],
              ]
            );

          assert.equal(
            Number(
              cloudBefore.rows[0]
                .batches
            ),
            0
          );

          assert.equal(
            Number(
              cloudBefore.rows[0]
                .pos_rows
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

          assert.equal(
            Number(
              cloudBefore.rows[0]
                .sessions
            ),
            0
          );

          for (
            const table of [
              cloudTables.tableA,
              cloudTables.tableB,
              cloudTables.tableC,
            ]
          ) {
            const state =
              await loadPhysicalTableState({
                pool:
                  cloudPool,
                restaurantId,
                tableName:
                  table.name,
              });

            assert.equal(
              state.table.status,
              "free"
            );

            assert.equal(
              state.map.status,
              "available"
            );

            assert.equal(
              state.session,
              null
            );
          }

          assert.equal(
            await isPortOpen(
              cloudPort
            ),
            false
          );

          console.log(
            `✅ 04 WAN-off table lifecycle durable on Edge only (${tableEvents.length} table events)`
          );
        }
      );

      await t.test(
        "Cloud return converges POS + physical tables + stable batch assignment exactly once",
        async () => {
          await listenCloud(
            cloudServer,
            cloudPort
          );

          const allEventIds = [
            String(
              posEvent.event_id
            ),
            ...tableEventIds,
          ];

          await waitFor(
            async () => {
              const cloudInbox =
                await cloudPool.query(
                  `
                  SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (
                      WHERE status = 'applied'
                        AND applied_at IS NOT NULL
                    )::int AS applied
                  FROM
                    public.edge_inbox
                  WHERE
                    event_id = ANY($1::uuid[])
                  `,
                  [
                    allEventIds,
                  ]
                );

              const edgeOutbox =
                await edge.pool.query(
                  `
                  SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (
                      WHERE status = 'acked'
                        AND acked_at IS NOT NULL
                    )::int AS acked
                  FROM
                    public.edge_outbox
                  WHERE
                    event_id = ANY($1::uuid[])
                  `,
                  [
                    allEventIds,
                  ]
                );

              return (
                Number(
                  cloudInbox.rows[0]
                    .total
                ) ===
                  allEventIds.length &&
                Number(
                  cloudInbox.rows[0]
                    .applied
                ) ===
                  allEventIds.length &&
                Number(
                  edgeOutbox.rows[0]
                    .total
                ) ===
                  allEventIds.length &&
                Number(
                  edgeOutbox.rows[0]
                    .acked
                ) ===
                  allEventIds.length
              );
            },
            {
              timeoutMs:
                40000,
              message:
                `Offline table lifecycle did not converge after Cloud return.\nAGENT:\n${agent.output()}`,
            }
          );

          const cloudAssignment =
            await loadBatchAssignmentState({
              pool:
                cloudPool,
              restaurantId,
              batchId,
            });

          assert.ok(
            cloudAssignment.batch
          );

          assert.equal(
            cloudAssignment
              .batch
              .table_number,
            cloudTables
              .tableC
              .name
          );

          assert.equal(
            cloudAssignment
              .batch
              .order_type,
            "dine-in"
          );

          assert.equal(
            cloudAssignment
              .batch
              .pickup_number,
            null
          );

          assert.ok(
            cloudAssignment
              .pos
              .length >
            0
          );

          assert.ok(
            cloudAssignment
              .pos
              .every(
                (row) =>
                  row.table_number ===
                  cloudTables
                    .tableC
                    .name
              )
          );

          const cloudA =
            await loadPhysicalTableState({
              pool:
                cloudPool,
              restaurantId,
              tableName:
                cloudTables
                  .tableA
                  .name,
            });

          const cloudB =
            await loadPhysicalTableState({
              pool:
                cloudPool,
              restaurantId,
              tableName:
                cloudTables
                  .tableB
                  .name,
            });

          const cloudC =
            await loadPhysicalTableState({
              pool:
                cloudPool,
              restaurantId,
              tableName:
                cloudTables
                  .tableC
                  .name,
            });

          assert.equal(
            cloudA.table.status,
            "free"
          );

          assert.equal(
            cloudA.map.status,
            "free"
          );

          assert.equal(
            cloudA.session,
            null
          );

          assert.equal(
            cloudB.table.status,
            "free"
          );

          assert.equal(
            cloudB.map.status,
            "free"
          );

          assert.equal(
            cloudB.session,
            null
          );

          assert.equal(
            cloudC.table.status,
            "occupied"
          );

          assert.equal(
            cloudC.map.status,
            "occupied"
          );

          assert.ok(
            cloudC.session
          );

          assert.equal(
            Number(
              cloudC.session
                .covers
            ),
            2
          );

          assert.deepEqual(
            cloudC.session
              .allergy_codes,
            [
              "milk",
              "sesame",
            ]
          );

          assert.equal(
            Boolean(
              cloudC.session
                .strict_cross_contamination
            ),
            true
          );

          const fakeCloudPhysical =
            await cloudPool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.tables
              WHERE
                restaurant_id = $1
                AND LOWER(TRIM(name)) IN (
                  'takeaway',
                  'delivery'
                )
              `,
              [
                restaurantId,
              ]
            );

          assert.equal(
            Number(
              fakeCloudPhysical
                .rows[0]
                .count
            ),
            0,
            "Cloud created a fake Takeaway/Delivery physical table"
          );

          const domains =
            [
              ...expectedRevisions
                .keys(),
            ];

          const revisions =
            await cloudPool.query(
              `
              SELECT
                domain,
                applied_revision,
                applied_payload_hash
              FROM
                public.edge_domain_revisions
              WHERE
                restaurant_id = $1
                AND domain = ANY($2::text[])
              `,
              [
                restaurantId,
                domains,
              ]
            );

          assert.equal(
            revisions.rows.length,
            domains.length
          );

          const revisionMap =
            new Map(
              revisions.rows.map(
                (row) => [
                  row.domain,
                  row,
                ]
              )
            );

          for (
            const [
              domain,
              expected,
            ] of expectedRevisions
          ) {
            const actual =
              revisionMap.get(
                domain
              );

            assert.ok(
              actual,
              `Cloud missing applied revision domain ${domain}`
            );

            assert.equal(
              Number(
                actual
                  .applied_revision
              ),
              expected.revision,
              `Cloud revision mismatch for ${domain}`
            );

            assert.equal(
              String(
                actual
                  .applied_payload_hash
              ),
              expected.payloadHash,
              `Cloud payload hash mismatch for ${domain}`
            );
          }

          console.log(
            `✅ 05 Cloud converged POS + ${tableEventIds.length} table events to final physical Table C exactly once`
          );
        }
      );

      await t.test(
        "continued agent cycles cannot duplicate recovered table state",
        async () => {
          const allEventIds = [
            String(
              posEvent.event_id
            ),
            ...tableEventIds,
          ];

          const before =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT COUNT(*)::int
                  FROM public.order_batches
                  WHERE restaurant_id = $1
                    AND id = $2::uuid
                ) AS batches,
                (
                  SELECT COUNT(*)::int
                  FROM public.pos_orders
                  WHERE restaurant_id = $1
                    AND batch_id = $2::uuid
                ) AS pos_rows,
                (
                  SELECT COUNT(*)::int
                  FROM public.edge_inbox
                  WHERE event_id = ANY($3::uuid[])
                ) AS inbox_rows,
                (
                  SELECT COUNT(*)::int
                  FROM public.edge_domain_revisions
                  WHERE restaurant_id = $1
                    AND domain = ANY($4::text[])
                ) AS revision_rows,
                (
                  SELECT COUNT(*)::int
                  FROM public.tables
                  WHERE restaurant_id = $1
                ) AS physical_tables,
                (
                  SELECT COUNT(*)::int
                  FROM public.pos_table_sessions
                  WHERE restaurant_id = $1
                ) AS sessions
              `,
              [
                restaurantId,
                batchId,
                allEventIds,
                [
                  ...expectedRevisions
                    .keys(),
                ],
              ]
            );

          await sleep(
            2600
          );

          const after =
            await cloudPool.query(
              `
              SELECT
                (
                  SELECT COUNT(*)::int
                  FROM public.order_batches
                  WHERE restaurant_id = $1
                    AND id = $2::uuid
                ) AS batches,
                (
                  SELECT COUNT(*)::int
                  FROM public.pos_orders
                  WHERE restaurant_id = $1
                    AND batch_id = $2::uuid
                ) AS pos_rows,
                (
                  SELECT COUNT(*)::int
                  FROM public.edge_inbox
                  WHERE event_id = ANY($3::uuid[])
                ) AS inbox_rows,
                (
                  SELECT COUNT(*)::int
                  FROM public.edge_domain_revisions
                  WHERE restaurant_id = $1
                    AND domain = ANY($4::text[])
                ) AS revision_rows,
                (
                  SELECT COUNT(*)::int
                  FROM public.tables
                  WHERE restaurant_id = $1
                ) AS physical_tables,
                (
                  SELECT COUNT(*)::int
                  FROM public.pos_table_sessions
                  WHERE restaurant_id = $1
                ) AS sessions
              `,
              [
                restaurantId,
                batchId,
                allEventIds,
                [
                  ...expectedRevisions
                    .keys(),
                ],
              ]
            );

          assert.deepEqual(
            after.rows[0],
            before.rows[0],
            "Repeated Edge agent cycles duplicated recovered Cloud table state"
          );

          assert.equal(
            Number(
              after.rows[0]
                .inbox_rows
            ),
            allEventIds.length
          );

          const finalAssignment =
            await loadBatchAssignmentState({
              pool:
                cloudPool,
              restaurantId,
              batchId,
            });

          assert.equal(
            finalAssignment
              .batch
              .table_number,
            cloudTables
              .tableC
              .name
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
            "✅ 06 Repeated real agent cycles cannot duplicate recovered table lifecycle"
          );
        }
      );

      await t.test(
        "Edge process logs do not expose secrets or database URLs",
        async () => {
          const agentOutput =
            agent.output();

          const serverOutput =
            edgeServer.output();

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
            "✅ 07 Edge table lifecycle + agent secret/DB URL log hygiene proven"
          );
        }
      );

      console.log(
        "============================================================"
      );

      console.log(
        "✅ MAKS REAL OFFLINE TABLE TWO-POSTGRES E2E ATTACK COMPLETE"
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
        await edge.stop();
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

      await cloudPool.end();

      console.log(
        "✅ Cleanup proven: Edge table process, agent, Cloud HTTP, and temporary Edge PostgreSQL stopped"
      );
    }
  }
);
