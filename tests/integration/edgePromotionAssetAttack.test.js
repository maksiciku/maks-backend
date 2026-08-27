"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

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

const express =
  require("express");

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
      "maks-promotion-asset-attack-"
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
  reconcilePromotionAssetsOnce,
} = require(
  "../../edge/promotionAssetTransport"
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
    (chunk) => {
      chunks.push(
        chunk
      );
    }
  );

  response.on(
    "end",
    () => {
      callback(
        null,
        Buffer.concat(
          chunks
        )
      );
    }
  );
}


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
  predicate,
  {
    timeoutMs =
      12000,

    intervalMs =
      75,

    message =
      "Condition timed out",
  } = {}
) {
  const started =
    Date.now();

  while (
    Date.now() -
      started <
    timeoutMs
  ) {
    if (
      await predicate()
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


async function readIfExists(
  filePath
) {
  try {
    return await fs.promises
      .readFile(
        filePath
      );
  } catch (error) {
    if (
      error?.code ===
        "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}


async function stopAgent(
  agent
) {
  if (
    !agent ||
    !agent.child ||
    agent.child.exitCode !==
      null
  ) {
    return;
  }

  agent.child.kill(
    "SIGTERM"
  );

  await Promise.race([
    new Promise(
      (resolve) =>
        agent.child.once(
          "exit",
          resolve
        )
    ),

    sleep(
      5000
    ).then(() => {
      if (
        agent.child.exitCode ===
          null
      ) {
        agent.child.kill(
          "SIGKILL"
        );
      }
    }),
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
        cwd:
          ROOT,

        env: {
          ...process.env,

          DATABASE_URL:
            databaseUrl,

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
    (chunk) => {
      stdout.push(
        String(
          chunk
        )
      );

      if (
        stdout.length >
          200
      ) {
        stdout.shift();
      }
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

      if (
        stderr.length >
          200
      ) {
        stderr.shift();
      }
    }
  );

  return {
    child,
    stdout,
    stderr,
  };
}


test(
  "MAKS Cloud to Edge promotion asset attack",
  {
    timeout:
      90000,
  },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      "DATABASE_URL is required"
    );

    const database =
      await qGet(
        `
        SELECT
          current_database()
            AS db
        `
      );

    assert.equal(
      database?.db,
      "maks_test",
      "REFUSED: promotion asset Attack may run only against maks_test"
    );

    console.log(
      "✅ 01 Database guard: maks_test"
    );

    await fs.promises.mkdir(
      CLOUD_UPLOADS_ROOT,
      {
        recursive:
          true,
      }
    );

    await fs.promises.mkdir(
      EDGE_UPLOADS_ROOT,
      {
        recursive:
          true,
      }
    );

    const app =
      express();

    app.use(
      express.json({
        limit:
          "1mb",
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

    const api =
      request(
        app
      );

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
                resolve(
                  value
                )
            );

          value.once(
            "error",
            reject
          );
        }
      );

    const address =
      server.address();

    const cloudUrl =
      `http://127.0.0.1:${address.port}`;

    const token =
      crypto
        .randomBytes(
          8
        )
        .toString(
          "hex"
        );

    let restaurantA =
      null;

    let restaurantB =
      null;

    let edgeA =
      null;

    let edgeB =
      null;

    let validPromotionId =
      null;

    let tenantBPromotionId =
      null;

    let agent =
      null;

    const filename =
      `promotion-${token}.png`;

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
          2048
        ),
      ]);

    try {
      const tableCheck =
        await qGet(
          `
          SELECT
            to_regclass(
              'public.restaurant_edge_nodes'
            ) AS edge_nodes,
            to_regclass(
              'public.restaurant_promotions'
            ) AS promotions
          `
        );

      assert.equal(
        tableCheck
          ?.edge_nodes,
        "restaurant_edge_nodes",
        "restaurant_edge_nodes schema missing"
      );

      assert.equal(
        tableCheck
          ?.promotions,
        "restaurant_promotions",
        "restaurant_promotions schema missing"
      );

      const a =
        await qGet(
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
            `PROMOTION ASSET ATTACK A ${token}`,
          ]
        );

      const b =
        await qGet(
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
            `PROMOTION ASSET ATTACK B ${token}`,
          ]
        );

      restaurantA =
        Number(
          a.id
        );

      restaurantB =
        Number(
          b.id
        );

      edgeA =
        generateEdgeCredentials();

      edgeB =
        generateEdgeCredentials();

      const nodeA =
        await qGet(
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
          RETURNING id
          `,
          [
            restaurantA,
            edgeA.installationId,
            `PROMOTION ASSET EDGE A ${token}`,
            edgeA.secretHash,
          ]
        );

      const nodeB =
        await qGet(
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
          RETURNING id
          `,
          [
            restaurantB,
            edgeB.installationId,
            `PROMOTION ASSET EDGE B ${token}`,
            edgeB.secretHash,
          ]
        );

      edgeA.nodeId =
        Number(
          nodeA.id
        );

      edgeB.nodeId =
        Number(
          nodeB.id
        );

      const cloudDirA =
        path.join(
          CLOUD_UPLOADS_ROOT,
          String(
            restaurantA
          ),
          "promotions"
        );

      const cloudDirB =
        path.join(
          CLOUD_UPLOADS_ROOT,
          String(
            restaurantB
          ),
          "promotions"
        );

      await fs.promises.mkdir(
        cloudDirA,
        {
          recursive:
            true,
        }
      );

      await fs.promises.mkdir(
        cloudDirB,
        {
          recursive:
            true,
        }
      );

      const cloudFile =
        path.join(
          cloudDirA,
          filename
        );

      await fs.promises.writeFile(
        cloudFile,
        validBytes
      );

      const validPromotion =
        await qGet(
          `
          INSERT INTO
            public.restaurant_promotions
          (
            restaurant_id,
            title,
            image_url,
            active
          )
          VALUES
          (
            $1,
            $2,
            $3,
            TRUE
          )
          RETURNING id
          `,
          [
            restaurantA,
            `VALID ASSET ${token}`,
            `/uploads/${restaurantA}/promotions/${filename}`,
          ]
        );

      const tenantBPromotion =
        await qGet(
          `
          INSERT INTO
            public.restaurant_promotions
          (
            restaurant_id,
            title,
            image_url,
            active
          )
          VALUES
          (
            $1,
            $2,
            $3,
            TRUE
          )
          RETURNING id
          `,
          [
            restaurantB,
            `TENANT B ASSET ${token}`,
            `/uploads/${restaurantB}/promotions/b-${filename}`,
          ]
        );

      validPromotionId =
        Number(
          validPromotion.id
        );

      tenantBPromotionId =
        Number(
          tenantBPromotion.id
        );

      await fs.promises.writeFile(
        path.join(
          cloudDirB,
          `b-${filename}`
        ),
        Buffer.from(
          "TENANT_B_SECRET_IMAGE"
        )
      );

      console.log(
        "✅ 02 Isolated Cloud promotion assets prepared"
      );


      await t.test(
        "wrong Edge secret cannot fetch promotion image",
        async () => {
          const res =
            await api
              .get(
                `/edge/assets/promotions/${validPromotionId}/image`
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
            "✅ 03 Wrong Edge secret rejected"
          );
        }
      );


      await t.test(
        "disabled Edge cannot fetch promotion image",
        async () => {
          await qRun(
            `
            UPDATE
              public.restaurant_edge_nodes
            SET
              is_active = FALSE
            WHERE
              id = $1
            `,
            [
              edgeA.nodeId,
            ]
          );

          try {
            const res =
              await api
                .get(
                  `/edge/assets/promotions/${validPromotionId}/image`
                )
                .set(
                  edgeHeaders(
                    edgeA.installationId,
                    edgeA.secret
                  )
                );

            assert.equal(
              res.status,
              403
            );

            assert.equal(
              res.body?.code,
              "EDGE_DISABLED"
            );
          } finally {
            await qRun(
              `
              UPDATE
                public.restaurant_edge_nodes
              SET
                is_active = TRUE
              WHERE
                id = $1
              `,
              [
                edgeA.nodeId,
              ]
            );
          }

          console.log(
            "✅ 04 Disabled Edge rejected"
          );
        }
      );


      await t.test(
        "Edge A cannot fetch Restaurant B promotion image",
        async () => {
          const res =
            await api
              .get(
                `/edge/assets/promotions/${tenantBPromotionId}/image`
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
            "EDGE_PROMOTION_ASSET_NOT_FOUND"
          );

          console.log(
            "✅ 05 Promotion asset tenant isolation proven"
          );
        }
      );


      await t.test(
        "unknown promotion id fails closed",
        async () => {
          const res =
            await api
              .get(
                "/edge/assets/promotions/999999999/image"
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

          console.log(
            "✅ 06 Unknown promotion id rejected"
          );
        }
      );


      await t.test(
        "valid image streams with exact SHA-256 and supports 304",
        async () => {
          const expectedSha =
            sha256Buffer(
              validBytes
            );

          const first =
            await api
              .get(
                `/edge/assets/promotions/${validPromotionId}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              )
              .buffer(
                true
              )
              .parse(
                binaryParser
              );

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
            validBytes.length
          );

          assert.deepEqual(
            first.body,
            validBytes
          );

          const second =
            await api
              .get(
                `/edge/assets/promotions/${validPromotionId}/image`
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
            "✅ 07 Cloud binary stream + SHA-256 + 304 proven"
          );
        }
      );


      await t.test(
        "Edge reconciler downloads, avoids rewrite, repairs corruption, and survives WAN failure",
        async () => {
          const localFile =
            path.join(
              EDGE_UPLOADS_ROOT,
              String(
                restaurantA
              ),
              "promotions",
              filename
            );

          const first =
            await reconcilePromotionAssetsOnce({
              pool:
                getPool(),

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
            1
          );

          assert.deepEqual(
            await fs.promises
              .readFile(
                localFile
              ),
            validBytes
          );

          const statBefore =
            await fs.promises
              .stat(
                localFile
              );

          await sleep(
            30
          );

          const second =
            await reconcilePromotionAssetsOnce({
              pool:
                getPool(),

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
            second.success,
            true
          );

          assert.equal(
            second.unchanged,
            1
          );

          const statAfter =
            await fs.promises
              .stat(
                localFile
              );

          assert.equal(
            statAfter.mtimeMs,
            statBefore.mtimeMs,
            "304 path unexpectedly rewrote the local file"
          );

          await fs.promises.writeFile(
            localFile,
            Buffer.from(
              "CORRUPTED_LOCAL_IMAGE"
            )
          );

          const repair =
            await reconcilePromotionAssetsOnce({
              pool:
                getPool(),

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
              localFile
            ),
            sha256Buffer(
              validBytes
            )
          );

          const goodBeforeOutage =
            await fs.promises
              .readFile(
                localFile
              );

          const outage =
            await reconcilePromotionAssetsOnce({
              pool:
                getPool(),

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
            1
          );

          assert.deepEqual(
            await fs.promises
              .readFile(
                localFile
              ),
            goodBeforeOutage,
            "WAN failure replaced or deleted a verified local image"
          );

          const tempFiles =
            await fs.promises
              .readdir(
                EDGE_TEMP_ROOT
              );

          assert.equal(
            tempFiles.filter(
              (name) =>
                name.endsWith(
                  ".part"
                )
            ).length,
            0
          );

          console.log(
            "✅ 08 Download/304/repair/WAN durability proven"
          );
        }
      );


      await t.test(
        "running Edge agent mirrors promotion image automatically after heartbeat",
        async () => {
          const localFile =
            path.join(
              EDGE_UPLOADS_ROOT,
              String(
                restaurantA
              ),
              "promotions",
              filename
            );

          await fs.promises.rm(
            localFile,
            {
              force:
                true,
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
              const bytes =
                await readIfExists(
                  localFile
                );

              return (
                Buffer.isBuffer(
                  bytes
                ) &&
                bytes.equals(
                  validBytes
                )
              );
            },
            {
              timeoutMs:
                15000,

              message:
                "Running Edge agent did not mirror the promotion image",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          await stopAgent(
            agent
          );

          agent =
            null;

          assert.deepEqual(
            await fs.promises
              .readFile(
                localFile
              ),
            validBytes
          );

          console.log(
            "✅ 09 Automatic agent promotion image mirroring proven"
          );
        }
      );


      await t.test(
        "malicious stored promotion path is rejected",
        async () => {
          const row =
            await qGet(
              `
              INSERT INTO
                public.restaurant_promotions
              (
                restaurant_id,
                title,
                image_url,
                active
              )
              VALUES
              (
                $1,
                $2,
                $3,
                TRUE
              )
              RETURNING id
              `,
              [
                restaurantA,
                `PATH ATTACK ${token}`,
                `/uploads/${restaurantA}/promotions/../secret.txt`,
              ]
            );

          const res =
            await api
              .get(
                `/edge/assets/promotions/${row.id}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              );

          assert.equal(
            res.status,
            409
          );

          assert.equal(
            res.body?.code,
            "EDGE_PROMOTION_ASSET_PATH_INVALID"
          );

          console.log(
            "✅ 10 Stored path traversal rejected"
          );
        }
      );


      await t.test(
        "missing Cloud image fails closed",
        async () => {
          const missingName =
            `missing-${filename}`;

          const row =
            await qGet(
              `
              INSERT INTO
                public.restaurant_promotions
              (
                restaurant_id,
                title,
                image_url,
                active
              )
              VALUES
              (
                $1,
                $2,
                $3,
                TRUE
              )
              RETURNING id
              `,
              [
                restaurantA,
                `MISSING ASSET ${token}`,
                `/uploads/${restaurantA}/promotions/${missingName}`,
              ]
            );

          const res =
            await api
              .get(
                `/edge/assets/promotions/${row.id}/image`
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
            "EDGE_PROMOTION_ASSET_FILE_MISSING"
          );

          console.log(
            "✅ 11 Missing Cloud promotion image fails closed"
          );
        }
      );


      await t.test(
        "oversized Cloud promotion image is rejected before streaming",
        async () => {
          const hugeName =
            `huge-${token}.bin`;

          const hugePath =
            path.join(
              cloudDirA,
              hugeName
            );

          const handle =
            await fs.promises
              .open(
                hugePath,
                "w"
              );

          try {
            await handle.truncate(
              20 *
                1024 *
                1024 +
              1
            );
          } finally {
            await handle.close();
          }

          const row =
            await qGet(
              `
              INSERT INTO
                public.restaurant_promotions
              (
                restaurant_id,
                title,
                image_url,
                active
              )
              VALUES
              (
                $1,
                $2,
                $3,
                TRUE
              )
              RETURNING id
              `,
              [
                restaurantA,
                `HUGE ASSET ${token}`,
                `/uploads/${restaurantA}/promotions/${hugeName}`,
              ]
            );

          const res =
            await api
              .get(
                `/edge/assets/promotions/${row.id}/image`
              )
              .set(
                edgeHeaders(
                  edgeA.installationId,
                  edgeA.secret
                )
              );

          assert.equal(
            res.status,
            413
          );

          assert.equal(
            res.body?.code,
            "EDGE_PROMOTION_ASSET_TOO_LARGE"
          );

          console.log(
            "✅ 12 Oversized promotion image rejected"
          );
        }
      );


      console.log(
        "============================================"
      );

      console.log(
        "✅ MAKS EDGE PROMOTION ASSET ATTACK COMPLETE"
      );

      console.log(
        "============================================"
      );
    } finally {
      await stopAgent(
        agent
      );

      await new Promise(
        (resolve) =>
          server.close(
            resolve
          )
      );

      if (
        restaurantA ||
        restaurantB
      ) {
        await qRun(
          `
          DELETE FROM
            public.restaurants
          WHERE
            id =
              ANY(
                $1::bigint[]
              )
          `,
          [
            [
              restaurantA,
              restaurantB,
            ].filter(
              Boolean
            ),
          ]
        );
      }

      await fs.promises.rm(
        TEST_ROOT,
        {
          recursive:
            true,
          force:
            true,
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

      await getPool().end();

      console.log(
        "✅ 13 Cleanup proven"
      );
    }
  }
);
