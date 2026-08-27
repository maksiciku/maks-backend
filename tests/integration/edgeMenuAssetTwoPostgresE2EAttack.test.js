"use strict";

const assert =
  require("node:assert/strict");

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
} = require("pg");

const {
  qAll,
  qGet,
  qRun,
  getPool,
  withTx,
} = require(
  "../../dbCompat"
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
  generateEdgeCredentials,
} = require(
  "../../utils/edgeAuth"
);

const originalRuntimeRole =
  process.env
    .MAKS_RUNTIME_ROLE;

const originalCloudUploadsRoot =
  process.env
    .MAKS_EDGE_ASSET_UPLOADS_ROOT;

process.env
  .MAKS_RUNTIME_ROLE =
  "cloud";

const edgeRoutes =
  require(
    "../../routes/edgeRoutes"
);

const {
  emitMenuCatalogSnapshotTx,
} = require(
  "../../edge/contracts/menuCatalog"
);

const {
  sha256Buffer,
  sha256File,
} = require(
  "../../edge/menuAssetTransport"
);

const DATABASE_URL =
  String(
    process.env.DATABASE_URL ||
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


function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}


async function waitFor(
  predicate,
  {
    timeoutMs = 25000,
    intervalMs = 75,
    message =
      "Timed out waiting for condition",
  } = {}
) {
  const deadline =
    Date.now() + timeoutMs;

  while (
    Date.now() < deadline
  ) {
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
      process.env
        .MAKS_TEST_POSTGRES_PREFIX ||
      ""
    ).trim();

  if (explicit) {
    return explicit;
  }

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
}


function postgresTools() {
  const bin =
    path.join(
      resolvePostgresPrefix(),
      "bin"
    );

  const tools = {};

  for (
    const name of [
      "initdb",
      "pg_ctl",
      "createdb",
      "pg_dump",
      "psql",
    ]
  ) {
    const file =
      path.join(
        bin,
        name
      );

    assert.ok(
      fs.existsSync(file),
      `Required PostgreSQL binary missing: ${file}`
    );

    tools[name] = file;
  }

  return tools;
}


function runTool(
  file,
  args,
  {
    env = process.env,
    timeoutMs = 90000,
  } = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          file,
          args,
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

      const stdout = [];
      const stderr = [];

      const timer =
        setTimeout(
          () =>
            child.kill("SIGKILL"),
          timeoutMs
        );

      child.stdout.on(
        "data",
        (chunk) =>
          stdout.push(
            String(chunk)
          )
      );

      child.stderr.on(
        "data",
        (chunk) =>
          stderr.push(
            String(chunk)
          )
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
        (
          code,
          signal
        ) => {
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
              `${path.basename(file)} failed (code=${code}, signal=${signal || "none"}):\n${stderr.join("").slice(-2500)}`
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

  const env = {
    ...process.env,
    PGHOST:
      parsed.hostname,
    PGPORT:
      parsed.port || "5432",
    PGUSER:
      decodeURIComponent(
        parsed.username
      ),
    PGDATABASE:
      decodeURIComponent(
        parsed.pathname.replace(
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
    typeof address === "object"
  );

  const port =
    Number(address.port);

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
        "maks-menu-asset-two-pg-"
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

  let started = false;

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
      ]
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
      ]
    );

    started = true;

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
      }
    );

    await runTool(
      tools.psql,
      [
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        schemaFile,
      ],
      {
        env: {
          ...adminEnv,
          PGDATABASE:
            "maks_test",
        },
      }
    );

    const databaseUrl =
      `postgresql://maksedge_test@127.0.0.1:${port}/maks_test`;

    const pool =
      new Pool({
        connectionString:
          databaseUrl,
        max: 4,
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
      identity.rows[0].db,
      "maks_test"
    );

    assert.equal(
      Number(
        identity.rows[0].port
      ),
      port
    );

    return {
      root,
      dataDir,
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

            started = false;
          }

          await fsp.rm(
            root,
            {
              recursive: true,
              force: true,
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
        recursive: true,
        force: true,
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
      limit: "10mb",
    })
  );

  app.use(
    (
      req,
      _res,
      next
    ) => {
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

  return Number(
    server.address().port
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
  edgeUploadsRoot,
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
        cwd: ROOT,
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
            edgeSecret,
          MAKS_EDGE_DATABASE_URL:
            edgeDatabaseUrl,
          MAKS_EDGE_VERSION:
            "edge-menu-asset-two-pg-attack",
          MAKS_EDGE_HEARTBEAT_MS:
            "5000",
          MAKS_EDGE_SYNC_MS:
            "60000",
          MAKS_EDGE_PULL_MS:
            "1000",
          MAKS_EDGE_APPLY_MS:
            "500",
          MAKS_EDGE_PROMOTION_ASSET_MS:
            "1000",
          MAKS_EDGE_PROMOTION_UPLOADS_ROOT:
            edgeUploadsRoot,
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
    (chunk) =>
      stdout.push(
        String(chunk)
      )
  );

  child.stderr.on(
    "data",
    (chunk) =>
      stderr.push(
        String(chunk)
      )
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
    agent.child.exitCode !== null
  ) {
    return;
  }

  agent.child.kill("SIGTERM");

  await Promise.race([
    once(
      agent.child,
      "exit"
    ),
    sleep(4000).then(
      () => {
        if (
          agent.child.exitCode === null
        ) {
          agent.child.kill(
            "SIGKILL"
          );
        }
      }
    ),
  ]);
}


async function readIfExists(
  filePath
) {
  try {
    return await fsp.readFile(
      filePath
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}


test(
  "MAKS menu image real two-PostgreSQL WAN-off E2E attack",
  {
    timeout: 120000,
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
      "maks_test"
    );

    const token =
      crypto
        .randomBytes(8)
        .toString("hex");

    const assetRoot =
      await fsp.mkdtemp(
        path.join(
          os.tmpdir(),
          "maks-menu-image-two-pg-assets-"
        )
      );

    const cloudUploadsRoot =
      path.join(
        assetRoot,
        "cloud-uploads"
      );

    const edgeUploadsRoot =
      path.join(
        assetRoot,
        "edge-uploads"
      );

    process.env
      .MAKS_EDGE_ASSET_UPLOADS_ROOT =
      cloudUploadsRoot;

    let edge = null;
    let cloudServer = null;
    let cloudPort = null;
    let agent = null;
    let restaurantId = null;
    let credentials = null;
    let mealId = null;
    let produced = null;

    const filename =
      `offline-meal-${token}.png`;

    const validBytes =
      Buffer.concat([
        Buffer.from([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
        ]),
        crypto.randomBytes(
          4096
        ),
      ]);

    try {
      await t.test(
        "starts a separate Edge PostgreSQL server named maks_test",
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
                .rows[0].port
            )
          );

          console.log(
            `✅ 01 Two PostgreSQL servers: Cloud ${cloudIdentity.rows[0].port}, Edge ${edge.port}`
          );
        }
      );

      const restaurant =
        await cloudPool.query(
          `
          INSERT INTO
            public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `MENU IMAGE TWO PG ${token}`,
          ]
        );

      restaurantId =
        Number(
          restaurant.rows[0].id
        );

      await edge.pool.query(
        `
        INSERT INTO
          public.restaurants
        (
          id,
          name
        )
        VALUES
        (
          $1,
          $2
        )
        `,
        [
          restaurantId,
          `EDGE MENU IMAGE TWO PG ${token}`,
        ]
      );

      const cloudDir =
        path.join(
          cloudUploadsRoot,
          String(restaurantId),
          "menu-items"
        );

      await fsp.mkdir(
        cloudDir,
        {
          recursive: true,
        }
      );

      await fsp.writeFile(
        path.join(
          cloudDir,
          filename
        ),
        validBytes
      );

      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

      produced =
        await withTx(
          async (tx) => {
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
                  'meals',
                  'M'
                )
                RETURNING id
                `,
                [
                  restaurantId,
                  `MENU IMAGE CATEGORY ${token}`,
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
                  out_of_stock,
                  photo_url
                )
                VALUES
                (
                  $1,
                  $2,
                  '[]'::jsonb,
                  'None',
                  0,
                  15,
                  $3,
                  $4,
                  FALSE,
                  '[]'::jsonb,
                  FALSE,
                  $5
                )
                RETURNING id
                `,
                [
                  restaurantId,
                  `OFFLINE IMAGE MEAL ${token}`,
                  `MENU IMAGE CATEGORY ${token}`,
                  Number(
                    category.id
                  ),
                  `/uploads/${restaurantId}/menu-items/${filename}`,
                ]
              );

            mealId =
              Number(meal.id);

            return emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId,
              }
            );
          }
        );

      assert.equal(
        Number(produced.revision),
        1
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
          credentials.installationId,
          `MENU IMAGE TWO PG EDGE ${token}`,
          credentials.secretHash,
        ]
      );

      const localFile =
        path.join(
          edgeUploadsRoot,
          String(restaurantId),
          "menu-items",
          filename
        );

      await t.test(
        "real Cloud sync applies photo_url and mirrors the physical image into separate Edge storage",
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
              edgeUploadsRoot,
              installationId:
                credentials.installationId,
              edgeSecret:
                credentials.secret,
            });

          await waitFor(
            async () => {
              const meal =
                await edge.pool.query(
                  `
                  SELECT
                    photo_url
                  FROM
                    public.meals
                  WHERE
                    restaurant_id = $1
                    AND id = $2
                  `,
                  [
                    restaurantId,
                    mealId,
                  ]
                );

              const bytes =
                await readIfExists(
                  localFile
                );

              return (
                meal.rows.length === 1 &&
                meal.rows[0].photo_url ===
                  `/uploads/${restaurantId}/menu-items/${filename}` &&
                Buffer.isBuffer(bytes) &&
                bytes.equals(
                  validBytes
                )
              );
            },
            {
              message:
                "Menu metadata and image bytes did not converge into separate Edge PostgreSQL/storage",
            }
          );

          const cloudOutbox =
            await qGet(
              `
              SELECT
                status
              FROM
                public.edge_outbox
              WHERE
                event_id = $1::uuid
              `,
              [
                produced.event.event_id,
              ]
            );

          assert.equal(
            cloudOutbox?.status,
            "acked"
          );

          assert.equal(
            await sha256File(localFile),
            sha256Buffer(validBytes)
          );

          console.log(
            "✅ 02 Separate Edge DB + physical menu image mirroring + ACK proven"
          );
        }
      );

      await t.test(
        "WAN-off keeps local menu metadata and physical image readable",
        async () => {
          await closeCloud(
            cloudServer
          );

          await sleep(1700);

          assert.equal(
            agent.child.exitCode,
            null,
            agent.output()
          );

          const meal =
            await edge.pool.query(
              `
              SELECT
                name,
                photo_url
              FROM
                public.meals
              WHERE
                restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantId,
                mealId,
              ]
            );

          assert.equal(
            meal.rows.length,
            1
          );

          assert.equal(
            meal.rows[0].photo_url,
            `/uploads/${restaurantId}/menu-items/${filename}`
          );

          assert.deepEqual(
            await fsp.readFile(
              localFile
            ),
            validBytes
          );

          console.log(
            "✅ 03 WAN-off metadata + physical image survival proven"
          );
        }
      );

      await t.test(
        "cold Edge-agent restart while Cloud is down preserves the image",
        async () => {
          await stopAgent(agent);

          agent =
            spawnAgent({
              cloudUrl:
                `http://127.0.0.1:${cloudPort}`,
              edgeDatabaseUrl:
                edge.databaseUrl,
              edgeUploadsRoot,
              installationId:
                credentials.installationId,
              edgeSecret:
                credentials.secret,
            });

          await sleep(1800);

          assert.equal(
            agent.child.exitCode,
            null,
            agent.output()
          );

          assert.deepEqual(
            await fsp.readFile(
              localFile
            ),
            validBytes
          );

          console.log(
            "✅ 04 Offline Edge restart preserves local menu image"
          );
        }
      );

      await t.test(
        "Cloud return repairs a corrupted local menu image",
        async () => {
          await fsp.writeFile(
            localFile,
            Buffer.from(
              "CORRUPTED_WHILE_OFFLINE"
            )
          );

          assert.notEqual(
            await sha256File(localFile),
            sha256Buffer(validBytes)
          );

          await listenCloud(
            cloudServer,
            cloudPort
          );

          await waitFor(
            async () => {
              const bytes =
                await readIfExists(
                  localFile
                );

              return (
                Buffer.isBuffer(bytes) &&
                bytes.equals(validBytes)
              );
            },
            {
              timeoutMs: 20000,
              message:
                "Cloud return did not repair corrupted local menu image",
            }
          );

          assert.equal(
            await sha256File(localFile),
            sha256Buffer(validBytes)
          );

          console.log(
            "✅ 05 Cloud return repairs corrupted local image"
          );
        }
      );

      await t.test(
        "Edge-agent logs never expose secrets or database URLs",
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

          console.log(
            "✅ 06 Secret/DB URL log hygiene preserved"
          );
        }
      );

      console.log(
        "======================================================"
      );
      console.log(
        "✅ MAKS MENU IMAGE TWO-POSTGRES E2E ATTACK COMPLETE"
      );
      console.log(
        "======================================================"
      );
    } finally {
      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

      await stopAgent(agent);

      await closeCloud(
        cloudServer
      ).catch(
        () => {}
      );

      if (edge) {
        await edge.stop();
      }

      await fsp.rm(
        assetRoot,
        {
          recursive: true,
          force: true,
        }
      );

      if (
        originalCloudUploadsRoot ===
          undefined
      ) {
        delete process.env
          .MAKS_EDGE_ASSET_UPLOADS_ROOT;
      } else {
        process.env
          .MAKS_EDGE_ASSET_UPLOADS_ROOT =
          originalCloudUploadsRoot;
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
        "✅ Cleanup proven: temp Edge PostgreSQL + image storage removed"
      );
    }
  }
);
