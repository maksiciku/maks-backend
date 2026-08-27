"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const {
  execFileSync,
  spawn,
} = require("node:child_process");
const test = require("node:test");

const { Pool } = require("pg");

const {
  qAll,
  qGet,
  qRun,
  getPool,
  withTx,
} = require("../../dbCompat");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

const {
  resetTestData,
} = require("../setup/resetTestData");

const {
  generateEdgeCredentials,
} = require("../../utils/edgeAuth");

const {
  enqueueEdgeEvent,
} = require("../../edge/syncStore");

const {
  MENU_CATALOG_DOMAIN,
  MENU_CATALOG_EVENT_TYPE,
  emitMenuCatalogSnapshotTx,
} = require("../../edge/contracts/menuCatalog");

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;

process.env.MAKS_RUNTIME_ROLE =
  "cloud";

const edgeRoutes =
  require("../../routes/edgeRoutes");

const DATABASE_URL = String(
  process.env.DATABASE_URL || ""
).trim();

const ROOT = path.resolve(
  __dirname,
  "../.."
);

const AGENT_PATH = path.join(
  ROOT,
  "edge",
  "agent.js"
);

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
  );
}

async function waitFor(
  predicate,
  {
    timeoutMs = 15000,
    intervalMs = 75,
    message = "Timed out waiting for condition",
  } = {}
) {
  const deadline =
    Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(message);
}

function resolvePostgresPrefix() {
  const explicit =
    String(
      process.env.MAKS_TEST_POSTGRES_PREFIX ||
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
        encoding: "utf8",
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    ).trim();
  } catch (error) {
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
    "postgres",
    "initdb",
    "pg_ctl",
    "createdb",
    "pg_dump",
    "psql",
  ];

  const tools = {};

  for (const name of names) {
    const file =
      path.join(
        bin,
        name
      );

    if (!fs.existsSync(file)) {
      throw new Error(
        `Required PostgreSQL binary missing: ${file}`
      );
    }

    tools[name] =
      file;
  }

  return tools;
}

function safeTail(text) {
  return String(text || "")
    .slice(-3000);
}

function runTool(
  file,
  args,
  {
    env = process.env,
    cwd = ROOT,
    timeoutMs = 45000,
  } = {}
) {
  return new Promise(
    (resolve, reject) => {
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

      child.on(
        "error",
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );

      child.on(
        "close",
        (code, signal) => {
          clearTimeout(timer);

          if (code === 0) {
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
    new URL(databaseUrl);

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

  if (parsed.password) {
    env.PGPASSWORD =
      decodeURIComponent(
        parsed.password
      );
  } else {
    delete env.PGPASSWORD;
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
    (resolve, reject) => {
      server.close(
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    }
  );

  return port;
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
        "maks-edge-two-pg-"
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
        String(port),
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

    const cloudEnv =
      pgEnvFromUrl(
        cloudDatabaseUrl
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
          cloudEnv,
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
          4,
      });

    const identity =
      await pool.query(
        `
        SELECT
          current_database()
            AS db,
          inet_server_addr()::text
            AS host,
          inet_server_port()
            AS port
        `
      );

    assert.equal(
      identity.rows[0].db,
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
          await pool.end();
        } finally {
          if (started) {
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
  } catch (error) {
    if (started) {
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
      req.qAll =
        qAll;
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

  return http.createServer(
    app
  );
}

async function listenCloud(
  server,
  port = 0
) {
  server.listen(
    port,
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

  return Number(
    address.port
  );
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
    (resolve, reject) => {
      server.close(
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    }
  );
}

function spawnAgent({
  cloudUrl,
  edgeDatabaseUrl,
  installationId,
  edgeSecret,
}) {
  const stdout = [];
  const stderr = [];

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
            "edge-menu-two-postgres-e2e-attack",
          MAKS_EDGE_HEARTBEAT_MS:
            "5000",
          MAKS_EDGE_SYNC_MS:
            "60000",
          MAKS_EDGE_PULL_MS:
            "1000",
          MAKS_EDGE_APPLY_MS:
            "500",
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
    output() {
      return (
        stdout.join("") +
        "\n" +
        stderr.join("")
      );
    },
  };
}

async function stopAgent(
  agent
) {
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
    sleep(4000).then(
      () => {
        if (
          agent.child.exitCode ===
            null
        ) {
          agent.child.kill(
            "SIGKILL"
          );
        }
      }
    ),
  ]);
}

async function createCloudRestaurants(
  pool,
  token
) {
  const result =
    await pool.query(
      `
      INSERT INTO
        public.restaurants
      (
        name
      )
      VALUES
        ($1),
        ($2)
      RETURNING
        id,
        name
      `,
      [
        `TWO PG CLOUD A ${token}`,
        `TWO PG CLOUD B ${token}`,
      ]
    );

  return {
    restaurantA:
      Number(
        result.rows[0].id
      ),
    restaurantB:
      Number(
        result.rows[1].id
      ),
  };
}

async function mirrorRestaurantShellsToEdge({
  pool,
  restaurantA,
  restaurantB,
  token,
}) {
  await pool.query(
    `
    INSERT INTO
      public.restaurants
    (
      id,
      name
    )
    VALUES
      ($1, $2),
      ($3, $4)
    `,
    [
      restaurantA,
      `TWO PG EDGE A ${token}`,
      restaurantB,
      `TWO PG EDGE B ${token}`,
    ]
  );
}

async function seedEdgeTenantBSentinel({
  pool,
  restaurantB,
}) {
  const categoryId =
    900000001;

  const mealId =
    900000002;

  await pool.query(
    `
    INSERT INTO
      public.categories
    (
      id,
      restaurant_id,
      name,
      type,
      icon
    )
    VALUES
    (
      $1,
      $2,
      'EDGE B KEEP CATEGORY',
      'meals',
      'B'
    )
    `,
    [
      categoryId,
      restaurantB,
    ]
  );

  await pool.query(
    `
    INSERT INTO
      public.meals
    (
      id,
      restaurant_id,
      name,
      ingredients,
      allergens,
      calories,
      price,
      category,
      category_id,
      paused,
      options_schema,
      out_of_stock
    )
    VALUES
    (
      $1,
      $2,
      'EDGE B KEEP MEAL',
      '[]'::jsonb,
      'None',
      0,
      99.99,
      'EDGE B KEEP CATEGORY',
      $3,
      FALSE,
      '[]'::jsonb,
      FALSE
    )
    `,
    [
      mealId,
      restaurantB,
      categoryId,
    ]
  );
}

async function seedCloudMenuA({
  tx,
  restaurantId,
  token,
}) {
  const mealCategory =
    await tx.qGet(
      `
      INSERT INTO
        public.categories
      (
        restaurant_id,
        name,
        type,
        icon
      )
      VALUES
      (
        $1,
        $2,
        'meals',
        'M'
      )
      RETURNING id
      `,
      [
        restaurantId,
        `A MEALS V1 ${token}`,
      ]
    );

  const drinkCategory =
    await tx.qGet(
      `
      INSERT INTO
        public.categories
      (
        restaurant_id,
        name,
        type,
        icon
      )
      VALUES
      (
        $1,
        $2,
        'drinks',
        'D'
      )
      RETURNING id
      `,
      [
        restaurantId,
        `A DRINKS V1 ${token}`,
      ]
    );

  const dessertCategory =
    await tx.qGet(
      `
      INSERT INTO
        public.categories
      (
        restaurant_id,
        name,
        type,
        icon
      )
      VALUES
      (
        $1,
        $2,
        'desserts',
        'S'
      )
      RETURNING id
      `,
      [
        restaurantId,
        `A DESSERTS V1 ${token}`,
      ]
    );

  const meal =
    await tx.qGet(
      `
      INSERT INTO
        public.meals
      (
        restaurant_id,
        name,
        ingredients,
        allergens,
        calories,
        price,
        category,
        category_id,
        paused,
        options_schema,
        out_of_stock
      )
      VALUES
      (
        $1,
        $2,
        '[]'::jsonb,
        'None',
        500,
        12.50,
        $3,
        $4,
        FALSE,
        '[]'::jsonb,
        FALSE
      )
      RETURNING id
      `,
      [
        restaurantId,
        `A BURGER V1 ${token}`,
        `A MEALS V1 ${token}`,
        Number(
          mealCategory.id
        ),
      ]
    );

  const drink =
    await tx.qGet(
      `
      INSERT INTO
        public.menu_items
      (
        restaurant_id,
        name,
        type,
        price,
        category_id,
        paused,
        options_schema,
        is_available,
        out_of_stock,
        allergens,
        calories,
        availability_mode,
        manually_stopped
      )
      VALUES
      (
        $1,
        $2,
        'drink',
        4.75,
        $3,
        FALSE,
        $4::jsonb,
        TRUE,
        FALSE,
        'None',
        120,
        'maks',
        FALSE
      )
      RETURNING id
      `,
      [
        restaurantId,
        `A COLA V1 ${token}`,
        Number(
          drinkCategory.id
        ),
        JSON.stringify([
          {
            id:
              "size",
            label:
              "Size",
            type:
              "single",
            choices: [
              {
                id:
                  "large",
                label:
                  "Large",
                price:
                  1.25,
              },
            ],
          },
        ]),
      ]
    );

  const dessert =
    await tx.qGet(
      `
      INSERT INTO
        public.menu_items
      (
        restaurant_id,
        name,
        type,
        price,
        category_id,
        paused,
        options_schema,
        is_available,
        out_of_stock,
        allergens,
        calories,
        availability_mode,
        manually_stopped
      )
      VALUES
      (
        $1,
        $2,
        'dessert',
        6.25,
        $3,
        FALSE,
        '[]'::jsonb,
        TRUE,
        FALSE,
        'None',
        350,
        'maks',
        FALSE
      )
      RETURNING id
      `,
      [
        restaurantId,
        `A CAKE V1 ${token}`,
        Number(
          dessertCategory.id
        ),
      ]
    );

  const group =
    await tx.qGet(
      `
      INSERT INTO
        public.menu_groups
      (
        restaurant_id,
        name,
        base_type,
        sort_order,
        show_pos,
        show_qr,
        show_kiosk,
        active_days,
        is_active,
        priority
      )
      VALUES
      (
        $1,
        $2,
        'meals',
        1,
        TRUE,
        TRUE,
        TRUE,
        $3::jsonb,
        TRUE,
        10
      )
      RETURNING id
      `,
      [
        restaurantId,
        `A LUNCH V1 ${token}`,
        JSON.stringify([
          "mon",
          "tue",
          "wed",
          "thu",
          "fri",
        ]),
      ]
    );

  const groupCategory =
    await tx.qGet(
      `
      INSERT INTO
        public.menu_group_categories
      (
        restaurant_id,
        menu_group_id,
        category_id,
        sort_order
      )
      VALUES
      (
        $1,
        $2,
        $3,
        1
      )
      RETURNING id
      `,
      [
        restaurantId,
        Number(
          group.id
        ),
        Number(
          mealCategory.id
        ),
      ]
    );

  const schedule =
    await tx.qGet(
      `
      INSERT INTO
        public.menu_group_schedules
      (
        restaurant_id,
        menu_group_id,
        active_days,
        start_time,
        end_time,
        priority,
        is_active
      )
      VALUES
      (
        $1,
        $2,
        $3::jsonb,
        '08:00',
        '14:00',
        5,
        TRUE
      )
      RETURNING id
      `,
      [
        restaurantId,
        Number(
          group.id
        ),
        JSON.stringify([
          "mon",
          "tue",
          "wed",
          "thu",
          "fri",
        ]),
      ]
    );

  return {
    mealCategoryId:
      Number(
        mealCategory.id
      ),
    drinkCategoryId:
      Number(
        drinkCategory.id
      ),
    dessertCategoryId:
      Number(
        dessertCategory.id
      ),
    mealId:
      Number(
        meal.id
      ),
    drinkId:
      Number(
        drink.id
      ),
    dessertId:
      Number(
        dessert.id
      ),
    groupId:
      Number(
        group.id
      ),
    groupCategoryId:
      Number(
        groupCategory.id
      ),
    scheduleId:
      Number(
        schedule.id
      ),
  };
}

async function seedCloudMenuB({
  tx,
  restaurantId,
  token,
}) {
  const category =
    await tx.qGet(
      `
      INSERT INTO
        public.categories
      (
        restaurant_id,
        name,
        type,
        icon
      )
      VALUES
      (
        $1,
        $2,
        'desserts',
        'B'
      )
      RETURNING id
      `,
      [
        restaurantId,
        `B DESSERTS ${token}`,
      ]
    );

  await tx.qRun(
    `
    INSERT INTO
      public.menu_items
    (
      restaurant_id,
      name,
      type,
      price,
      category_id
    )
    VALUES
    (
      $1,
      $2,
      'dessert',
      7.75,
      $3
    )
    `,
    [
      restaurantId,
      `B PRIVATE DESSERT ${token}`,
      Number(
        category.id
      ),
    ]
  );
}

async function updateCloudMenuARevision2({
  tx,
  restaurantId,
  ids,
  token,
}) {
  await tx.qRun(
    `
    UPDATE
      public.categories
    SET
      name = $1
    WHERE
      restaurant_id = $2
      AND id = $3
    `,
    [
      `A MEALS V2 ${token}`,
      restaurantId,
      ids.mealCategoryId,
    ]
  );

  await tx.qRun(
    `
    UPDATE
      public.meals
    SET
      name = $1,
      price = 13.95,
      category = $2
    WHERE
      restaurant_id = $3
      AND id = $4
    `,
    [
      `A BURGER V2 ${token}`,
      `A MEALS V2 ${token}`,
      restaurantId,
      ids.mealId,
    ]
  );

  await tx.qRun(
    `
    UPDATE
      public.menu_items
    SET
      name = $1,
      price = 5.25
    WHERE
      restaurant_id = $2
      AND id = $3
      AND type = 'drink'
    `,
    [
      `A COLA V2 ${token}`,
      restaurantId,
      ids.drinkId,
    ]
  );

  await tx.qRun(
    `
    UPDATE
      public.menu_groups
    SET
      name = $1,
      priority = 20
    WHERE
      restaurant_id = $2
      AND id = $3
    `,
    [
      `A LUNCH V2 ${token}`,
      restaurantId,
      ids.groupId,
    ]
  );

  await tx.qRun(
    `
    UPDATE
      public.menu_group_schedules
    SET
      end_time = '15:30',
      priority = 7
    WHERE
      restaurant_id = $1
      AND id = $2
    `,
    [
      restaurantId,
      ids.scheduleId,
    ]
  );
}

async function catalogueCounts(
  pool,
  restaurantId
) {
  const tables = [
    "categories",
    "meals",
    "menu_items",
    "menu_groups",
    "menu_group_categories",
    "menu_group_schedules",
  ];

  const counts = {};

  for (const table of tables) {
    const result =
      await pool.query(
        `
        SELECT
          COUNT(*)::int
            AS count
        FROM
          public.${table}
        WHERE
          restaurant_id = $1
        `,
        [
          restaurantId,
        ]
      );

    counts[table] =
      Number(
        result.rows[0]
          .count
      );
  }

  return counts;
}

async function assertEdgeRevision1({
  pool,
  restaurantId,
  ids,
  token,
}) {
  const counts =
    await catalogueCounts(
      pool,
      restaurantId
    );

  assert.deepEqual(
    counts,
    {
      categories:
        3,
      meals:
        1,
      menu_items:
        2,
      menu_groups:
        1,
      menu_group_categories:
        1,
      menu_group_schedules:
        1,
    }
  );

  const meal =
    await pool.query(
      `
      SELECT
        name,
        price,
        category_id
      FROM
        public.meals
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.mealId,
      ]
    );

  assert.equal(
    meal.rows[0].name,
    `A BURGER V1 ${token}`
  );

  assert.equal(
    Number(
      meal.rows[0].price
    ),
    12.5
  );

  const drink =
    await pool.query(
      `
      SELECT
        name,
        price,
        category_id
      FROM
        public.menu_items
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.drinkId,
      ]
    );

  assert.equal(
    drink.rows[0].name,
    `A COLA V1 ${token}`
  );

  const group =
    await pool.query(
      `
      SELECT
        name,
        priority
      FROM
        public.menu_groups
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.groupId,
      ]
    );

  assert.equal(
    group.rows[0].name,
    `A LUNCH V1 ${token}`
  );

  const link =
    await pool.query(
      `
      SELECT
        menu_group_id,
        category_id
      FROM
        public.menu_group_categories
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.groupCategoryId,
      ]
    );

  assert.equal(
    Number(
      link.rows[0]
        .menu_group_id
    ),
    ids.groupId
  );

  const schedule =
    await pool.query(
      `
      SELECT
        end_time::text
          AS end_time,
        priority
      FROM
        public.menu_group_schedules
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.scheduleId,
      ]
    );

  assert.match(
    String(
      schedule.rows[0]
        .end_time
    ),
    /^14:00/
  );
}

async function assertEdgeRevision2({
  pool,
  restaurantId,
  ids,
  token,
}) {
  const counts =
    await catalogueCounts(
      pool,
      restaurantId
    );

  assert.deepEqual(
    counts,
    {
      categories:
        3,
      meals:
        1,
      menu_items:
        2,
      menu_groups:
        1,
      menu_group_categories:
        1,
      menu_group_schedules:
        1,
    }
  );

  const category =
    await pool.query(
      `
      SELECT
        name
      FROM
        public.categories
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.mealCategoryId,
      ]
    );

  assert.equal(
    category.rows[0].name,
    `A MEALS V2 ${token}`
  );

  const meal =
    await pool.query(
      `
      SELECT
        name,
        price
      FROM
        public.meals
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.mealId,
      ]
    );

  assert.equal(
    meal.rows[0].name,
    `A BURGER V2 ${token}`
  );

  assert.equal(
    Number(
      meal.rows[0].price
    ),
    13.95
  );

  const drink =
    await pool.query(
      `
      SELECT
        name,
        price
      FROM
        public.menu_items
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.drinkId,
      ]
    );

  assert.equal(
    drink.rows[0].name,
    `A COLA V2 ${token}`
  );

  assert.equal(
    Number(
      drink.rows[0].price
    ),
    5.25
  );

  const group =
    await pool.query(
      `
      SELECT
        name,
        priority
      FROM
        public.menu_groups
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.groupId,
      ]
    );

  assert.equal(
    group.rows[0].name,
    `A LUNCH V2 ${token}`
  );

  assert.equal(
    Number(
      group.rows[0]
        .priority
    ),
    20
  );

  const schedule =
    await pool.query(
      `
      SELECT
        end_time::text
          AS end_time,
        priority
      FROM
        public.menu_group_schedules
      WHERE
        restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        ids.scheduleId,
      ]
    );

  assert.match(
    String(
      schedule.rows[0]
        .end_time
    ),
    /^15:30/
  );

  assert.equal(
    Number(
      schedule.rows[0]
        .priority
    ),
    7
  );
}

async function edgeInboxStatus({
  pool,
  eventId,
}) {
  const result =
    await pool.query(
      `
      SELECT
        status,
        apply_attempts
      FROM
        public.edge_inbox
      WHERE
        event_id = $1::uuid
      `,
      [
        eventId,
      ]
    );

  return result.rows[0] ||
    null;
}

async function appliedRevision({
  pool,
  restaurantId,
}) {
  const result =
    await pool.query(
      `
      SELECT
        applied_revision
      FROM
        public.edge_domain_revisions
      WHERE
        restaurant_id = $1
        AND domain = $2
      `,
      [
        restaurantId,
        MENU_CATALOG_DOMAIN,
      ]
    );

  return Number(
    result.rows[0]
      ?.applied_revision ||
    0
  );
}

test(
  "MAKS real two-PostgreSQL Cloud to Edge menu E2E attack",
  {
    timeout:
      150000,
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
      cloudIdentity.rows[0].db,
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
    let cloudPort =
      null;
    let agent =
      null;
    let restaurantA =
      null;
    let restaurantB =
      null;
    let ids =
      null;
    let revision1 =
      null;
    let revision2 =
      null;
    let tenantBEvent =
      null;
    let staleEvent =
      null;
    let credentials =
      null;

    try {
      await t.test(
        "starts a genuinely separate Edge PostgreSQL server named maks_test",
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
            `✅ 01 Two real PostgreSQL servers proven: Cloud ${cloudIdentity.rows[0].port}, Edge ${edge.port}`
          );
        }
      );

      const restaurants =
        await createCloudRestaurants(
          cloudPool,
          token
        );

      restaurantA =
        restaurants.restaurantA;

      restaurantB =
        restaurants.restaurantB;

      await mirrorRestaurantShellsToEdge({
        pool:
          edge.pool,
        restaurantA,
        restaurantB,
        token,
      });

      await seedEdgeTenantBSentinel({
        pool:
          edge.pool,
        restaurantB,
      });

      process.env.MAKS_RUNTIME_ROLE =
        "cloud";

      revision1 =
        await withTx(
          async (tx) => {
            ids =
              await seedCloudMenuA({
                tx,
                restaurantId:
                  restaurantA,
                token,
              });

            return emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  restaurantA,
              }
            );
          }
        );

      tenantBEvent =
        await withTx(
          async (tx) => {
            await seedCloudMenuB({
              tx,
              restaurantId:
                restaurantB,
              token,
            });

            return emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  restaurantB,
              }
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
          restaurantA,
          credentials
            .installationId,
          `TWO PG EDGE ${token}`,
          credentials
            .secretHash,
        ]
      );

      await t.test(
        "real Cloud HTTP pull applies revision 1 into separate Edge database",
        async () => {
          cloudServer =
            makeCloudServer();

          cloudPort =
            await listenCloud(
              cloudServer
            );

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

          await waitFor(
            async () => {
              const inbox =
                await edgeInboxStatus({
                  pool:
                    edge.pool,
                  eventId:
                    revision1
                      .event
                      .event_id,
                });

              return (
                inbox
                  ?.status ===
                  "applied" &&
                (
                  await appliedRevision({
                    pool:
                      edge.pool,
                    restaurantId:
                      restaurantA,
                  })
                ) === 1
              );
            },
            {
              timeoutMs:
                20000,
              message:
                "Revision 1 did not traverse real Cloud HTTP transport into separate Edge PostgreSQL",
            }
          );

          await assertEdgeRevision1({
            pool:
              edge.pool,
            restaurantId:
              restaurantA,
            ids,
            token,
          });

          console.log(
            "✅ 02 Real Cloud HTTP → Edge inbox → application proven"
          );
        }
      );

      await t.test(
        "all six catalogue tables are local and Restaurant B cannot bleed into A",
        async () => {
          await assertEdgeRevision1({
            pool:
              edge.pool,
            restaurantId:
              restaurantA,
            ids,
            token,
          });

          const bSentinel =
            await edge.pool.query(
              `
              SELECT
                name,
                price
              FROM
                public.meals
              WHERE
                restaurant_id = $1
                AND id = 900000002
              `,
              [
                restaurantB,
              ]
            );

          assert.equal(
            bSentinel.rows[0]
              .name,
            "EDGE B KEEP MEAL"
          );

          const leakedEvent =
            await edge.pool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.edge_inbox
              WHERE
                event_id = $1::uuid
              `,
              [
                tenantBEvent
                  .event
                  .event_id,
              ]
            );

          assert.equal(
            Number(
              leakedEvent.rows[0]
                .count
            ),
            0
          );

          console.log(
            "✅ 03 Six-table local catalogue + tenant isolation proven"
          );
        }
      );

      await t.test(
        "WAN outage leaves the complete local catalogue usable",
        async () => {
          await closeCloud(
            cloudServer
          );

          await sleep(
            1600
          );

          assert.equal(
            agent.child.exitCode,
            null,
            `Agent crashed during WAN outage:\n${agent.output()}`
          );

          await assertEdgeRevision1({
            pool:
              edge.pool,
            restaurantId:
              restaurantA,
            ids,
            token,
          });

          assert.equal(
            await appliedRevision({
              pool:
                edge.pool,
              restaurantId:
                restaurantA,
            }),
            1
          );

          console.log(
            "✅ 04 WAN-off local catalogue survival proven"
          );
        }
      );

      await t.test(
        "cold Edge-agent restart during WAN outage preserves local data",
        async () => {
          await stopAgent(
            agent
          );

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
            1800
          );

          assert.equal(
            agent.child.exitCode,
            null,
            `Cold Edge agent did not survive Cloud outage:\n${agent.output()}`
          );

          await assertEdgeRevision1({
            pool:
              edge.pool,
            restaurantId:
              restaurantA,
            ids,
            token,
          });

          console.log(
            "✅ 05 Offline restart durability proven (local data retained)"
          );
        }
      );

      revision2 =
        await withTx(
          async (tx) => {
            await updateCloudMenuARevision2({
              tx,
              restaurantId:
                restaurantA,
              ids,
              token,
            });

            return emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  restaurantA,
              }
            );
          }
        );

      assert.equal(
        Number(
          revision2.revision
        ),
        2
      );

      await t.test(
        "Cloud return reconverges Edge to revision 2",
        async () => {
          await listenCloud(
            cloudServer,
            cloudPort
          );

          await waitFor(
            async () => {
              const inbox =
                await edgeInboxStatus({
                  pool:
                    edge.pool,
                  eventId:
                    revision2
                      .event
                      .event_id,
                });

              return (
                inbox
                  ?.status ===
                  "applied" &&
                (
                  await appliedRevision({
                    pool:
                      edge.pool,
                    restaurantId:
                      restaurantA,
                  })
                ) === 2
              );
            },
            {
              timeoutMs:
                25000,
              message:
                "Edge did not reconverge after Cloud returned",
            }
          );

          await assertEdgeRevision2({
            pool:
              edge.pool,
            restaurantId:
              restaurantA,
            ids,
            token,
          });

          console.log(
            "✅ 06 Cloud return + revision 2 reconvergence proven"
          );
        }
      );

      await t.test(
        "stale revision cannot roll the separate Edge database backwards",
        async () => {
          staleEvent =
            await enqueueEdgeEvent({
              eventId:
                crypto.randomUUID(),
              restaurantId:
                restaurantA,
              eventType:
                MENU_CATALOG_EVENT_TYPE,
              entityType:
                "menu_catalog",
              entityId:
                String(
                  restaurantA
                ),
              idempotencyKey:
                `two-pg-stale:${token}`,
              payload:
                revision1
                  .payload,
            });

          await waitFor(
            async () => {
              const inbox =
                await edgeInboxStatus({
                  pool:
                    edge.pool,
                  eventId:
                    staleEvent
                      .event_id,
                });

              return (
                inbox
                  ?.status ===
                  "applied"
              );
            },
            {
              timeoutMs:
                15000,
              message:
                "Stale event was not delivered/applied for rollback protection proof",
            }
          );

          assert.equal(
            await appliedRevision({
              pool:
                edge.pool,
              restaurantId:
                restaurantA,
            }),
            2
          );

          await assertEdgeRevision2({
            pool:
              edge.pool,
            restaurantId:
              restaurantA,
            ids,
            token,
          });

          console.log(
            "✅ 07 Stale revision rollback blocked on real separate Edge DB"
          );
        }
      );

      await t.test(
        "secrets and database URLs remain absent from Edge-agent logs",
        async () => {
          const output =
            agent.output();

          assert.equal(
            output.includes(
              credentials.secret
            ),
            false
          );

          assert.equal(
            output.includes(
              edge.databaseUrl
            ),
            false
          );

          assert.equal(
            output.includes(
              DATABASE_URL
            ),
            false
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          console.log(
            "✅ 08 Edge process secret/DB URL log hygiene proven"
          );
        }
      );

      console.log(
        "======================================================"
      );

      console.log(
        "✅ MAKS REAL TWO-POSTGRES MENU E2E ATTACK COMPLETE"
      );

      console.log(
        "======================================================"
      );
    } finally {
      process.env.MAKS_RUNTIME_ROLE =
        "cloud";

      await stopAgent(
        agent
      );

      await closeCloud(
        cloudServer
      ).catch(
        () => {}
      );

      if (edge) {
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
        "✅ Cleanup proven: temporary Edge PostgreSQL stopped and deleted"
      );
    }
  }
);
