"use strict";

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const express =
  require("express");

const fs =
  require("node:fs");

const os =
  require("node:os");

const path =
  require("node:path");

const {
  spawn,
} = require(
  "node:child_process"
);

const test =
  require("node:test");

const request =
  require("supertest");

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

const DATABASE_URL =
  String(
    process.env.DATABASE_URL ||
    ""
  ).trim();

const TEST_ROOT =
  fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "maks-menu-asset-attack-"
    )
  );

const CLOUD_UPLOADS_ROOT =
  path.join(
    TEST_ROOT,
    "cloud-uploads"
  );

const EDGE_UPLOADS_ROOT =
  path.join(
    TEST_ROOT,
    "edge-uploads"
  );

const EDGE_TEMP_ROOT =
  path.join(
    TEST_ROOT,
    "edge-private-temp"
  );

const previousCloudUploadsRoot =
  process.env
    .MAKS_EDGE_ASSET_UPLOADS_ROOT;

process.env
  .MAKS_EDGE_ASSET_UPLOADS_ROOT =
  CLOUD_UPLOADS_ROOT;

const {
  qGet,
  qAll,
  qRun,
  getPool,
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

const edgeRoutes =
  require(
    "../../routes/edgeRoutes"
);

const {
  generateEdgeCredentials,
} = require(
  "../../utils/edgeAuth"
);

const {
  sha256Buffer,
  sha256File,
  reconcileMenuAssetsOnce,
} = require(
  "../../edge/menuAssetTransport"
);

function edgeHeaders(
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

function binaryParser(
  response,
  callback
) {
  const chunks = [];

  response.on(
    "data",
    (chunk) =>
      chunks.push(chunk)
  );

  response.on(
    "end",
    () =>
      callback(
        null,
        Buffer.concat(chunks)
      )
  );
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

async function waitFor(
  predicate,
  {
    timeoutMs = 15000,
    intervalMs = 75,
    message =
      "Condition timed out",
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

async function readIfExists(
  filePath
) {
  try {
    return await fs.promises
      .readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function stopAgent(agent) {
  if (
    !agent?.child ||
    agent.child.exitCode !== null
  ) {
    return;
  }

  agent.child.kill("SIGTERM");

  await Promise.race([
    new Promise(
      (resolve) =>
        agent.child.once(
          "exit",
          resolve
        )
    ),
    sleep(5000).then(
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

function spawnAgent({
  cloudUrl,
  databaseUrl,
  installationId,
  secret,
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
          MAKS_EDGE_DATABASE_URL:
            databaseUrl,
          MAKS_EDGE_CLOUD_URL:
            cloudUrl,
          MAKS_EDGE_INSTALLATION_ID:
            installationId,
          MAKS_EDGE_SECRET:
            secret,
          MAKS_RUNTIME_ROLE:
            "edge",
          MAKS_EDGE_HEARTBEAT_MS:
            "5000",
          MAKS_EDGE_SYNC_MS:
            "60000",
          MAKS_EDGE_PULL_MS:
            "60000",
          MAKS_EDGE_APPLY_MS:
            "60000",
          MAKS_EDGE_PROMOTION_ASSET_MS:
            "1000",
          MAKS_EDGE_PROMOTION_UPLOADS_ROOT:
            EDGE_UPLOADS_ROOT,
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

test(
  "MAKS Cloud to Edge menu image asset attack",
  {
    timeout: 90000,
  },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      "DATABASE_URL is required"
    );

    await assertTestDatabase();
    await resetTestData();

    const app = express();

    app.use(
      express.json({
        limit: "1mb",
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

    const api =
      request(app);

    const server =
      await new Promise(
        (
          resolve,
          reject
        ) => {
          const value =
            app.listen(
              0,
              "127.0.0.1",
              () =>
                resolve(value)
            );

          value.once(
            "error",
            reject
          );
        }
      );

    const cloudUrl =
      `http://127.0.0.1:${server.address().port}`;

    const token =
      crypto
        .randomBytes(8)
        .toString("hex");

    let restaurantA = null;
    let restaurantB = null;
    let edgeA = null;
    let edgeB = null;
    let mealId = null;
    let drinkId = null;
    let dessertId = null;
    let tenantBMealId = null;
    let agent = null;

    const filenames = {
      meal:
        `meal-${token}.png`,
      drink:
        `drink-${token}.jpg`,
      dessert:
        `dessert-${token}.webp`,
    };

    const bytes = {
      meal:
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
            2048
          ),
        ]),
      drink:
        Buffer.concat([
          Buffer.from([
            0xff,
            0xd8,
            0xff,
            0xe0,
          ]),
          crypto.randomBytes(
            1900
          ),
        ]),
      dessert:
        Buffer.concat([
          Buffer.from("RIFF"),
          crypto.randomBytes(
            1800
          ),
        ]),
    };

    try {
      const a =
        await qGet(
          `
          INSERT INTO
            public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `MENU ASSET A ${token}`,
          ]
        );

      const b =
        await qGet(
          `
          INSERT INTO
            public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `MENU ASSET B ${token}`,
          ]
        );

      restaurantA =
        Number(a.id);

      restaurantB =
        Number(b.id);

      edgeA =
        generateEdgeCredentials();

      edgeB =
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
          ),
          (
            $5,
            $6::uuid,
            $7,
            $8,
            TRUE
          )
        `,
        [
          restaurantA,
          edgeA.installationId,
          `MENU EDGE A ${token}`,
          edgeA.secretHash,
          restaurantB,
          edgeB.installationId,
          `MENU EDGE B ${token}`,
          edgeB.secretHash,
        ]
      );

      const categoryA =
        await qGet(
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
            restaurantA,
            `MENU ASSET CATEGORY A ${token}`,
          ]
        );

      const categoryB =
        await qGet(
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
            'B'
          )
          RETURNING id
          `,
          [
            restaurantB,
            `MENU ASSET CATEGORY B ${token}`,
          ]
        );

      const cloudDirA =
        path.join(
          CLOUD_UPLOADS_ROOT,
          String(restaurantA),
          "menu-items"
        );

      const cloudDirB =
        path.join(
          CLOUD_UPLOADS_ROOT,
          String(restaurantB),
          "menu-items"
        );

      await fs.promises.mkdir(
        cloudDirA,
        {
          recursive: true,
        }
      );

      await fs.promises.mkdir(
        cloudDirB,
        {
          recursive: true,
        }
      );

      for (
        const type of [
          "meal",
          "drink",
          "dessert",
        ]
      ) {
        await fs.promises.writeFile(
          path.join(
            cloudDirA,
            filenames[type]
          ),
          bytes[type]
        );
      }

      const meal =
        await qGet(
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
            10,
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
            restaurantA,
            `MENU ASSET MEAL ${token}`,
            `MENU ASSET CATEGORY A ${token}`,
            Number(categoryA.id),
            `/uploads/${restaurantA}/menu-items/${filenames.meal}`,
          ]
        );

      mealId =
        Number(meal.id);

      const drink =
        await qGet(
          `
          INSERT INTO
            public.menu_items
          (
            restaurant_id,
            name,
            price,
            type,
            category_id,
            photo_url
          )
          VALUES
          (
            $1,
            $2,
            3,
            'drink',
            $3,
            $4
          )
          RETURNING id
          `,
          [
            restaurantA,
            `MENU ASSET DRINK ${token}`,
            Number(categoryA.id),
            `/uploads/${restaurantA}/menu-items/${filenames.drink}`,
          ]
        );

      drinkId =
        Number(drink.id);

      const dessert =
        await qGet(
          `
          INSERT INTO
            public.menu_items
          (
            restaurant_id,
            name,
            price,
            type,
            category_id,
            photo_url
          )
          VALUES
          (
            $1,
            $2,
            5,
            'dessert',
            $3,
            $4
          )
          RETURNING id
          `,
          [
            restaurantA,
            `MENU ASSET DESSERT ${token}`,
            Number(categoryA.id),
            `/uploads/${restaurantA}/menu-items/${filenames.dessert}`,
          ]
        );

      dessertId =
        Number(dessert.id);

      const tenantBName =
        `tenant-b-${token}.png`;

      await fs.promises.writeFile(
        path.join(
          cloudDirB,
          tenantBName
        ),
        Buffer.from(
          "TENANT_B_PRIVATE_MENU_IMAGE"
        )
      );

      const tenantBMeal =
        await qGet(
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
            20,
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
            restaurantB,
            `MENU ASSET PRIVATE B ${token}`,
            `MENU ASSET CATEGORY B ${token}`,
            Number(categoryB.id),
            `/uploads/${restaurantB}/menu-items/${tenantBName}`,
          ]
        );

      tenantBMealId =
        Number(tenantBMeal.id);

      console.log(
        "✅ 01 Cloud menu image fixtures prepared"
      );

      await t.test(
        "wrong Edge secret cannot fetch menu image",
        async () => {
          const res =
            await api
              .get(
                `/edge/assets/menu/meal/${mealId}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  "wrong-secret"
                )
              );

          assert.equal(
            res.status,
            401
          );

          assert.equal(
            res.body?.code,
            "EDGE_AUTH_INVALID"
          );

          console.log(
            "✅ 02 Wrong Edge secret rejected"
          );
        }
      );

      await t.test(
        "Edge A cannot fetch Restaurant B menu image",
        async () => {
          const res =
            await api
              .get(
                `/edge/assets/menu/meal/${tenantBMealId}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              );

          assert.equal(
            res.status,
            404
          );

          assert.equal(
            res.body?.code,
            "EDGE_MENU_ASSET_NOT_FOUND"
          );

          console.log(
            "✅ 03 Tenant isolation proven"
          );
        }
      );

      await t.test(
        "meal image streams exact bytes, SHA-256, size and 304",
        async () => {
          const expectedSha =
            sha256Buffer(
              bytes.meal
            );

          const first =
            await api
              .get(
                `/edge/assets/menu/meal/${mealId}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .buffer(true)
              .parse(binaryParser);

          assert.equal(
            first.status,
            200
          );

          assert.equal(
            first.headers[
              "x-maks-asset-sha256"
            ],
            expectedSha
          );

          assert.equal(
            Number(
              first.headers[
                "x-maks-asset-size"
              ]
            ),
            bytes.meal.length
          );

          assert.deepEqual(
            first.body,
            bytes.meal
          );

          const second =
            await api
              .get(
                `/edge/assets/menu/meal/${mealId}/image`
              )
              .set({
                ...edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                ),
                "x-maks-local-sha256":
                  expectedSha,
              });

          assert.equal(
            second.status,
            304
          );

          console.log(
            "✅ 04 Stream/hash/size/304 proven"
          );
        }
      );

      await t.test(
        "drink and dessert image types stream correctly",
        async () => {
          for (
            const [
              type,
              id,
            ] of [
              [
                "drink",
                drinkId,
              ],
              [
                "dessert",
                dessertId,
              ],
            ]
          ) {
            const res =
              await api
                .get(
                  `/edge/assets/menu/${type}/${id}/image`
                )
                .set(
                  edgeHeaders(
                    edgeA.installationId,
                    edgeA.secret
                  )
                )
                .buffer(true)
                .parse(
                  binaryParser
                );

            assert.equal(
              res.status,
              200
            );

            assert.deepEqual(
              res.body,
              bytes[type]
            );
          }

          console.log(
            "✅ 05 Drink/dessert image transport proven"
          );
        }
      );

      await t.test(
        "reconciler downloads, avoids rewrites, repairs corruption and survives WAN failure",
        async () => {
          const first =
            await reconcileMenuAssetsOnce({
              pool: getPool(),
              cloudUrl,
              installationId:
                edgeA.installationId,
              edgeSecret:
                edgeA.secret,
              restaurantId:
                restaurantA,
              uploadsRoot:
                EDGE_UPLOADS_ROOT,
              tempRoot:
                EDGE_TEMP_ROOT,
            });

          assert.equal(
            first.success,
            true
          );

          assert.equal(
            first.downloaded,
            3
          );

          const localMeal =
            path.join(
              EDGE_UPLOADS_ROOT,
              String(restaurantA),
              "menu-items",
              filenames.meal
            );

          const statBefore =
            await fs.promises.stat(
              localMeal
            );

          const second =
            await reconcileMenuAssetsOnce({
              pool: getPool(),
              cloudUrl,
              installationId:
                edgeA.installationId,
              edgeSecret:
                edgeA.secret,
              restaurantId:
                restaurantA,
              uploadsRoot:
                EDGE_UPLOADS_ROOT,
              tempRoot:
                EDGE_TEMP_ROOT,
            });

          assert.equal(
            second.unchanged,
            3
          );

          const statAfter =
            await fs.promises.stat(
              localMeal
            );

          assert.equal(
            statAfter.mtimeMs,
            statBefore.mtimeMs
          );

          await fs.promises.writeFile(
            localMeal,
            Buffer.from(
              "CORRUPTED_LOCAL_MENU_IMAGE"
            )
          );

          const repair =
            await reconcileMenuAssetsOnce({
              pool: getPool(),
              cloudUrl,
              installationId:
                edgeA.installationId,
              edgeSecret:
                edgeA.secret,
              restaurantId:
                restaurantA,
              uploadsRoot:
                EDGE_UPLOADS_ROOT,
              tempRoot:
                EDGE_TEMP_ROOT,
            });

          assert.equal(
            repair.downloaded,
            1
          );

          assert.equal(
            await sha256File(
              localMeal
            ),
            sha256Buffer(
              bytes.meal
            )
          );

          const goodBeforeOutage =
            await fs.promises.readFile(
              localMeal
            );

          const outage =
            await reconcileMenuAssetsOnce({
              pool: getPool(),
              cloudUrl,
              installationId:
                edgeA.installationId,
              edgeSecret:
                edgeA.secret,
              restaurantId:
                restaurantA,
              uploadsRoot:
                EDGE_UPLOADS_ROOT,
              tempRoot:
                EDGE_TEMP_ROOT,
              fetchImpl:
                async () => {
                  throw new Error(
                    "MAKS_TEST_WAN_OFF"
                  );
                },
            });

          assert.equal(
            outage.success,
            false
          );

          assert.equal(
            outage.failed,
            3
          );

          assert.deepEqual(
            await fs.promises.readFile(
              localMeal
            ),
            goodBeforeOutage
          );

          console.log(
            "✅ 06 Download/304/repair/WAN durability proven"
          );
        }
      );

      await t.test(
        "traversal, missing file and oversized file fail closed",
        async () => {
          const traversal =
            await qGet(
              `
              INSERT INTO
                public.menu_items
              (
                restaurant_id,
                name,
                price,
                type,
                category_id,
                photo_url
              )
              VALUES
              (
                $1,
                $2,
                1,
                'drink',
                $3,
                $4
              )
              RETURNING id
              `,
              [
                restaurantA,
                `TRAVERSAL ${token}`,
                Number(categoryA.id),
                `/uploads/${restaurantA}/menu-items/../secret.txt`,
              ]
            );

          const traversalRes =
            await api
              .get(
                `/edge/assets/menu/drink/${traversal.id}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              );

          assert.equal(
            traversalRes.status,
            409
          );

          assert.equal(
            traversalRes.body?.code,
            "EDGE_MENU_ASSET_PATH_INVALID"
          );

          const missing =
            await qGet(
              `
              INSERT INTO
                public.menu_items
              (
                restaurant_id,
                name,
                price,
                type,
                category_id,
                photo_url
              )
              VALUES
              (
                $1,
                $2,
                1,
                'dessert',
                $3,
                $4
              )
              RETURNING id
              `,
              [
                restaurantA,
                `MISSING ${token}`,
                Number(categoryA.id),
                `/uploads/${restaurantA}/menu-items/missing-${token}.png`,
              ]
            );

          const missingRes =
            await api
              .get(
                `/edge/assets/menu/dessert/${missing.id}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              );

          assert.equal(
            missingRes.status,
            404
          );

          assert.equal(
            missingRes.body?.code,
            "EDGE_MENU_ASSET_FILE_MISSING"
          );

          const hugeName =
            `huge-${token}.bin`;

          const hugePath =
            path.join(
              cloudDirA,
              hugeName
            );

          const handle =
            await fs.promises.open(
              hugePath,
              "w"
            );

          try {
            await handle.truncate(
              4 * 1024 * 1024 + 1
            );
          } finally {
            await handle.close();
          }

          const huge =
            await qGet(
              `
              INSERT INTO
                public.menu_items
              (
                restaurant_id,
                name,
                price,
                type,
                category_id,
                photo_url
              )
              VALUES
              (
                $1,
                $2,
                1,
                'drink',
                $3,
                $4
              )
              RETURNING id
              `,
              [
                restaurantA,
                `HUGE ${token}`,
                Number(categoryA.id),
                `/uploads/${restaurantA}/menu-items/${hugeName}`,
              ]
            );

          const hugeRes =
            await api
              .get(
                `/edge/assets/menu/drink/${huge.id}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              );

          assert.equal(
            hugeRes.status,
            413
          );

          assert.equal(
            hugeRes.body?.code,
            "EDGE_MENU_ASSET_TOO_LARGE"
          );

          console.log(
            "✅ 07 Traversal/missing/oversize blocked"
          );
        }
      );

      await t.test(
        "running Edge agent mirrors menu images automatically",
        async () => {
          await fs.promises.rm(
            EDGE_UPLOADS_ROOT,
            {
              recursive: true,
              force: true,
            }
          );

          await fs.promises.mkdir(
            EDGE_UPLOADS_ROOT,
            {
              recursive: true,
            }
          );

          agent =
            spawnAgent({
              cloudUrl,
              databaseUrl:
                DATABASE_URL,
              installationId:
                edgeA.installationId,
              secret:
                edgeA.secret,
            });

          await waitFor(
            async () => {
              for (
                const type of [
                  "meal",
                  "drink",
                  "dessert",
                ]
              ) {
                const local =
                  await readIfExists(
                    path.join(
                      EDGE_UPLOADS_ROOT,
                      String(
                        restaurantA
                      ),
                      "menu-items",
                      filenames[type]
                    )
                  );

                if (
                  !Buffer.isBuffer(
                    local
                  ) ||
                  !local.equals(
                    bytes[type]
                  )
                ) {
                  return false;
                }
              }

              return true;
            },
            {
              timeoutMs: 18000,
              message:
                "Running Edge agent did not mirror all menu images",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null,
            agent.output()
          );

          await stopAgent(agent);
          agent = null;

          console.log(
            "✅ 08 Automatic Edge-agent mirroring proven"
          );
        }
      );

      console.log(
        "============================================"
      );
      console.log(
        "✅ MAKS EDGE MENU ASSET ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );
    } finally {
      await stopAgent(agent);

      await new Promise(
        (resolve) =>
          server.close(resolve)
      );

      await fs.promises.rm(
        TEST_ROOT,
        {
          recursive: true,
          force: true,
        }
      );

      if (
        previousCloudUploadsRoot ===
          undefined
      ) {
        delete process.env
          .MAKS_EDGE_ASSET_UPLOADS_ROOT;
      } else {
        process.env
          .MAKS_EDGE_ASSET_UPLOADS_ROOT =
          previousCloudUploadsRoot;
      }

      await resetTestData();
      await getPool().end();

      console.log(
        "✅ 09 Cleanup proven"
      );
    }
  }
);
