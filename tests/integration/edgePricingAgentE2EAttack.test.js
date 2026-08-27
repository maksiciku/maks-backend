"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const test = require("node:test");

const { Pool } = require("pg");

const {
  withTx,
} = require("../../dbCompat");

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
  hashJson,
} = require(
  "../../edge/syncStore"
);

const {
  pullFromCloudOnce,
} = require(
  "../../edge/pullTransport"
);

const {
  PRICING_RULES_DOMAIN,
  PRICING_RULES_EVENT_TYPE,
  emitPricingRulesSnapshotTx,
} = require(
  "../../edge/contracts/pricingRules"
);

const DATABASE_URL =
  String(
    process.env.DATABASE_URL ||
      ""
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
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

async function waitFor(
  predicate,
  {
    timeoutMs = 12000,
    intervalMs = 50,
    message =
      "Timed out waiting for condition",
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

async function readJson(req) {
  const chunks = [];

  for await (
    const chunk of req
  ) {
    chunks.push(chunk);
  }

  try {
    return JSON.parse(
      Buffer.concat(chunks)
        .toString("utf8") ||
        "{}"
    );
  } catch {
    return {};
  }
}

function sendJson(
  res,
  status,
  body
) {
  const text =
    JSON.stringify(body);

  res.statusCode = status;
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
  const requests = [];

  const state = {
    pullAvailable: true,
    events: [],
    ackedEventIds:
      new Set(),
    failAckCount: 0,
    pullFailures: 0,
    ackFailures: 0,
    deliveries:
      new Map(),
  };

  const server =
    http.createServer(
      async (req, res) => {
        const body =
          await readJson(req);

        requests.push({
          method: req.method,
          url: req.url,
          body,
          receivedAt:
            Date.now(),
        });

        if (
          req.method === "POST" &&
          req.url ===
            "/edge/heartbeat"
        ) {
          sendJson(
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
          req.url ===
            "/edge/sync/push"
        ) {
          const events =
            Array.isArray(
              body?.events
            )
              ? body.events
              : [];

          sendJson(
            res,
            200,
            {
              success: true,
              restaurant_id:
                restaurantId,
              acked:
                events.map(
                  (event) => ({
                    event_id:
                      event?.event_id,
                    duplicate:
                      false,
                  })
                ),
              rejected: [],
            }
          );
          return;
        }

        if (
          req.method === "POST" &&
          req.url ===
            "/edge/sync/pull"
        ) {
          if (
            !state.pullAvailable
          ) {
            state.pullFailures +=
              1;

            sendJson(
              res,
              503,
              {
                success: false,
                code:
                  "MAKS_TEST_PULL_UNAVAILABLE",
                error:
                  "Simulated Cloud pull outage",
              }
            );
            return;
          }

          const limit =
            Math.max(
              1,
              Math.min(
                25,
                Number(
                  body?.limit || 25
                )
              )
            );

          const events =
            state.events
              .filter(
                (event) =>
                  !state
                    .ackedEventIds
                    .has(
                      String(
                        event.event_id
                      )
                    )
              )
              .slice(0, limit);

          for (
            const event of events
          ) {
            const eventId =
              String(
                event.event_id
              );

            state.deliveries.set(
              eventId,
              Number(
                state.deliveries
                  .get(eventId) ||
                  0
              ) + 1
            );
          }

          sendJson(
            res,
            200,
            {
              success: true,
              restaurant_id:
                restaurantId,
              installation_id:
                installationId,
              events,
            }
          );
          return;
        }

        if (
          req.method === "POST" &&
          req.url ===
            "/edge/sync/pull/ack"
        ) {
          if (
            !state.pullAvailable
          ) {
            state.ackFailures +=
              1;

            sendJson(
              res,
              503,
              {
                success: false,
                code:
                  "MAKS_TEST_PULL_UNAVAILABLE",
                error:
                  "Simulated Cloud ACK outage",
              }
            );
            return;
          }

          if (
            state.failAckCount > 0
          ) {
            state.failAckCount -=
              1;
            state.ackFailures +=
              1;

            sendJson(
              res,
              503,
              {
                success: false,
                code:
                  "MAKS_TEST_ACK_LOST",
                error:
                  "Simulated lost Cloud ACK response",
              }
            );
            return;
          }

          const requested =
            Array.isArray(
              body?.event_ids
            )
              ? body.event_ids.map(
                  (eventId) =>
                    String(eventId)
                )
              : [];

          const known =
            new Set(
              state.events.map(
                (event) =>
                  String(
                    event.event_id
                  )
              )
            );

          const acked =
            requested.filter(
              (eventId) =>
                known.has(eventId)
            );

          for (
            const eventId of acked
          ) {
            state.ackedEventIds
              .add(eventId);
          }

          sendJson(
            res,
            200,
            {
              success: true,
              restaurant_id:
                restaurantId,
              installation_id:
                installationId,
              acked:
                acked.map(
                  (eventId) => ({
                    event_id:
                      eventId,
                  })
                ),
            }
          );
          return;
        }

        sendJson(
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
    requests,
    state,
    url:
      `http://127.0.0.1:${address.port}`,
  };
}

function spawnAgent({
  cloudUrl,
  databaseUrl,
  installationId,
  edgeSecret,
}) {
  const stdout = [];
  const stderr = [];

  const child = spawn(
    process.execPath,
    [AGENT_PATH],
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
          databaseUrl,
        MAKS_EDGE_VERSION:
          "edge-pricing-e2e-attack",
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
    output() {
      return `${stdout.join("")}\n${stderr.join("")}`;
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
    sleep(3000).then(
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

async function pricingRows(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        id,
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
      FROM public.pricing_rules
      WHERE restaurant_id = $1
      ORDER BY
        priority DESC,
        id DESC
      `,
      [restaurantId]
    );

  return result.rows;
}

async function replaceRulesTx(
  tx,
  restaurantId,
  rules
) {
  await tx.qRun(
    `
    DELETE FROM
      public.pricing_rules
    WHERE restaurant_id = $1
    `,
    [restaurantId]
  );

  for (
    const rule of rules
  ) {
    await tx.qRun(
      `
      INSERT INTO public.pricing_rules
      (
        id,
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
        $1, $2, $3, $4,
        $5, $6, $7::jsonb,
        $8::jsonb, $9, $10,
        $11, $12
      )
      `,
      [
        rule.id,
        restaurantId,
        rule.name,
        rule.rule_type,
        rule.active,
        rule.priority,
        JSON.stringify(
          rule.conditions
        ),
        JSON.stringify(
          rule.actions
        ),
        rule.starts_at,
        rule.ends_at,
        rule.created_at,
        rule.updated_at,
      ]
    );
  }
}

async function insertRuleTx(
  tx,
  restaurantId,
  {
    name,
    priority,
    bundlePrice,
  }
) {
  return tx.qGet(
    `
    INSERT INTO public.pricing_rules
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
      $3,
      $4::jsonb,
      $5::jsonb,
      NULL,
      NULL,
      NOW(),
      NOW()
    )
    RETURNING *
    `,
    [
      restaurantId,
      name,
      priority,
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
        bundle_price:
          bundlePrice,
      }),
    ]
  );
}

async function produceDetachedRevision({
  restaurantId,
  cloudRule,
  edgeRows,
}) {
  process.env.MAKS_RUNTIME_ROLE =
    "cloud";

  const produced =
    await withTx(
      async (tx) => {
        await tx.qRun(
          `
          DELETE FROM
            public.pricing_rules
          WHERE restaurant_id = $1
          `,
          [restaurantId]
        );

        await insertRuleTx(
          tx,
          restaurantId,
          cloudRule
        );

        const result =
          await emitPricingRulesSnapshotTx(
            tx,
            {
              restaurantId,
            }
          );

        /*
         * Attack harness note:
         * Cloud and Edge share one physical maks_test DB.
         * Restore the simulated Edge business rows before
         * COMMIT while keeping the real produced revision
         * and outbox event. Real deployments use separate
         * Cloud and Edge PostgreSQL databases.
         */
        await replaceRulesTx(
          tx,
          restaurantId,
          edgeRows
        );

        return result;
      }
    );

  await withTx(
    (tx) =>
      tx.qRun(
        `
        DELETE FROM
          public.edge_outbox
        WHERE event_id = $1::uuid
        `,
        [
          produced.event
            .event_id,
        ]
      )
  );

  return produced;
}

function wireEvent(
  produced
) {
  return {
    event_id:
      String(
        produced.event
          .event_id
      ),
    restaurant_id:
      Number(
        produced.event
          .restaurant_id
      ),
    event_type:
      produced.event
        .event_type,
    entity_type:
      produced.event
        .entity_type,
    entity_id:
      produced.event
        .entity_id,
    payload:
      produced.payload,
    payload_hash:
      produced.event
        .payload_hash,
  };
}

async function inboxRow(
  pool,
  restaurantId,
  eventId
) {
  const result =
    await pool.query(
      `
      SELECT
        status,
        payload_hash,
        apply_attempts
      FROM public.edge_inbox
      WHERE
        restaurant_id = $1
        AND event_id = $2::uuid
      `,
      [
        restaurantId,
        eventId,
      ]
    );

  return result.rows[0] ||
    null;
}

async function domainState(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        produced_revision,
        applied_revision,
        applied_payload_hash
      FROM public.edge_domain_revisions
      WHERE
        restaurant_id = $1
        AND domain = $2
      `,
      [
        restaurantId,
        PRICING_RULES_DOMAIN,
      ]
    );

  return result.rows[0] ||
    null;
}

function names(rows) {
  return rows.map(
    (row) => row.name
  );
}

test(
  "MAKS Cloud to Edge pricing agent E2E attack",
  {
    timeout: 90000,
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

    const edgeSecret =
      "pricing-e2e-edge-secret";

    const originalRole =
      process.env
        .MAKS_RUNTIME_ROLE;

    let restaurantA = null;
    let restaurantB = null;
    let cloud = null;
    let agent = null;

    try {
      const database =
        await pool.query(
          "SELECT current_database() AS db"
        );

      assert.equal(
        database.rows?.[0]?.db,
        "maks_test",
        "REFUSED: pricing E2E Attack may run only against maks_test"
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
        "✅ 02 Required canonical schemas verified"
      );

      const ra =
        await pool.query(
          `
          INSERT INTO public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `PRICING E2E A ${token}`,
          ]
        );

      const rb =
        await pool.query(
          `
          INSERT INTO public.restaurants
          (name)
          VALUES ($1)
          RETURNING id
          `,
          [
            `PRICING E2E B ${token}`,
          ]
        );

      restaurantA =
        Number(ra.rows[0].id);
      restaurantB =
        Number(rb.rows[0].id);

      await withTx(
        async (tx) => {
          await insertRuleTx(
            tx,
            restaurantA,
            {
              name:
                `A LOCAL STALE ${token}`,
              priority: 1,
              bundlePrice: 99,
            }
          );

          await insertRuleTx(
            tx,
            restaurantB,
            {
              name:
                `B KEEP ${token}`,
              priority: 50,
              bundlePrice: 18,
            }
          );
        }
      );

      const bBefore =
        await pricingRows(
          pool,
          restaurantB
        );

      console.log(
        "✅ 03 Isolated Cloud/Edge pricing tenants prepared"
      );

      await t.test(
        "revision 1 travels Cloud to Edge and applies automatically",
        async () => {
          const edgeBefore =
            await pricingRows(
              pool,
              restaurantA
            );

          const rev1 =
            await produceDetachedRevision({
              restaurantId:
                restaurantA,
              cloudRule: {
                name:
                  `A CLOUD V1 ${token}`,
                priority: 10,
                bundlePrice: 10,
              },
              edgeRows:
                edgeBefore,
            });

          assert.equal(
            rev1.revision,
            1
          );

          cloud =
            await createCloudStub({
              restaurantId:
                restaurantA,
              installationId,
            });

          cloud.state.events.push(
            wireEvent(rev1)
          );

          agent =
            spawnAgent({
              cloudUrl:
                cloud.url,
              databaseUrl:
                DATABASE_URL,
              installationId,
              edgeSecret,
            });

          await waitFor(
            async () => {
              const rows =
                await pricingRows(
                  pool,
                  restaurantA
                );

              const inbox =
                await inboxRow(
                  pool,
                  restaurantA,
                  rev1.event.event_id
                );

              return (
                rows.length === 1 &&
                rows[0].name ===
                  `A CLOUD V1 ${token}` &&
                inbox?.status ===
                  "applied" &&
                cloud.state
                  .ackedEventIds
                  .has(
                    String(
                      rev1.event
                        .event_id
                    )
                  )
              );
            },
            {
              message:
                "Revision 1 did not automatically reach and apply on Edge",
            }
          );

          const state =
            await domainState(
              pool,
              restaurantA
            );

          assert.equal(
            Number(
              state?.applied_revision
            ),
            1
          );

          assert.deepEqual(
            names(
              await pricingRows(
                pool,
                restaurantB
              )
            ),
            names(bBefore)
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          console.log(
            "✅ 04 Cloud → pull → inbox → automatic pricing apply proven"
          );
        }
      );

      let rev2 = null;

      await t.test(
        "revision 2 waits through outage then recovers automatically",
        async () => {
          cloud.state.pullAvailable =
            false;

          const edgeV1 =
            await pricingRows(
              pool,
              restaurantA
            );

          rev2 =
            await produceDetachedRevision({
              restaurantId:
                restaurantA,
              cloudRule: {
                name:
                  `A CLOUD V2 ${token}`,
                priority: 20,
                bundlePrice: 12,
              },
              edgeRows:
                edgeV1,
            });

          assert.equal(
            rev2.revision,
            2
          );

          cloud.state.events.push(
            wireEvent(rev2)
          );

          await waitFor(
            () =>
              cloud.state
                .pullFailures >= 1,
            {
              message:
                "Simulated pull outage was not observed",
            }
          );

          const duringOutage =
            await pricingRows(
              pool,
              restaurantA
            );

          assert.equal(
            duringOutage[0].name,
            `A CLOUD V1 ${token}`,
            "Edge pricing changed before Cloud transport recovered"
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          cloud.state.pullAvailable =
            true;

          await waitFor(
            async () => {
              const rows =
                await pricingRows(
                  pool,
                  restaurantA
                );

              return (
                rows.length === 1 &&
                rows[0].name ===
                  `A CLOUD V2 ${token}` &&
                cloud.state
                  .ackedEventIds
                  .has(
                    String(
                      rev2.event
                        .event_id
                    )
                  )
              );
            },
            {
              message:
                "Revision 2 did not recover automatically after outage",
            }
          );

          const state =
            await domainState(
              pool,
              restaurantA
            );

          assert.equal(
            Number(
              state?.applied_revision
            ),
            2
          );

          console.log(
            "✅ 05 Pricing outage backlog + automatic recovery proven"
          );
        }
      );

      let rev3 = null;

      await t.test(
        "lost ACK replay remains exactly once",
        async () => {
          const edgeV2 =
            await pricingRows(
              pool,
              restaurantA
            );

          rev3 =
            await produceDetachedRevision({
              restaurantId:
                restaurantA,
              cloudRule: {
                name:
                  `A CLOUD V3 ${token}`,
                priority: 30,
                bundlePrice: 14,
              },
              edgeRows:
                edgeV2,
            });

          cloud.state.failAckCount =
            1;

          cloud.state.events.push(
            wireEvent(rev3)
          );

          await waitFor(
            async () => {
              const rows =
                await pricingRows(
                  pool,
                  restaurantA
                );

              const eventId =
                String(
                  rev3.event.event_id
                );

              return (
                rows.length === 1 &&
                rows[0].name ===
                  `A CLOUD V3 ${token}` &&
                cloud.state
                  .ackedEventIds
                  .has(eventId) &&
                Number(
                  cloud.state
                    .deliveries
                    .get(eventId) ||
                    0
                ) >= 2
              );
            },
            {
              message:
                "Lost ACK replay did not recover automatically",
            }
          );

          const eventId =
            String(
              rev3.event.event_id
            );

          const copies =
            await pool.query(
              `
              SELECT COUNT(*)::int AS count
              FROM public.edge_inbox
              WHERE
                restaurant_id = $1
                AND event_id = $2::uuid
              `,
              [
                restaurantA,
                eventId,
              ]
            );

          assert.equal(
            Number(
              copies.rows[0].count
            ),
            1
          );

          assert.equal(
            (
              await inboxRow(
                pool,
                restaurantA,
                eventId
              )
            )?.status,
            "applied"
          );

          const state =
            await domainState(
              pool,
              restaurantA
            );

          assert.equal(
            Number(
              state?.applied_revision
            ),
            3
          );

          console.log(
            "✅ 06 Lost ACK replay + exactly-once application proven"
          );
        }
      );

      await t.test(
        "stale pricing replay cannot roll Edge backward",
        async () => {
          const staleEventId =
            crypto.randomUUID();

          cloud.state.events.push({
            ...wireEvent(rev2),
            event_id:
              staleEventId,
            payload:
              rev2.payload,
            payload_hash:
              hashJson(
                rev2.payload
              ),
          });

          await waitFor(
            async () => {
              const row =
                await inboxRow(
                  pool,
                  restaurantA,
                  staleEventId
                );

              return (
                row?.status ===
                  "applied" &&
                cloud.state
                  .ackedEventIds
                  .has(
                    staleEventId
                  )
              );
            },
            {
              message:
                "Stale replay did not complete through the Edge pipeline",
            }
          );

          const rows =
            await pricingRows(
              pool,
              restaurantA
            );

          assert.equal(
            rows[0].name,
            `A CLOUD V3 ${token}`
          );

          const state =
            await domainState(
              pool,
              restaurantA
            );

          assert.equal(
            Number(
              state?.applied_revision
            ),
            3
          );

          console.log(
            "✅ 07 Stale Cloud replay cannot roll local pricing backward"
          );
        }
      );

      await t.test(
        "durable pull survives process boundary and applies after restart",
        async () => {
          await stopAgent(agent);
          agent = null;

          const edgeV3 =
            await pricingRows(
              pool,
              restaurantA
            );

          const rev4 =
            await produceDetachedRevision({
              restaurantId:
                restaurantA,
              cloudRule: {
                name:
                  `A CLOUD V4 ${token}`,
                priority: 40,
                bundlePrice: 16,
              },
              edgeRows:
                edgeV3,
            });

          cloud.state.events.push(
            wireEvent(rev4)
          );

          const pulled =
            await pullFromCloudOnce({
              pool,
              cloudUrl:
                cloud.url,
              installationId,
              edgeSecret,
              restaurantId:
                restaurantA,
              limit: 25,
              timeoutMs: 10000,
            });

          assert.equal(
            pulled.received >= 1,
            true
          );

          assert.equal(
            (
              await inboxRow(
                pool,
                restaurantA,
                rev4.event
                  .event_id
              )
            )?.status,
            "received",
            "Expected a durable unapplied inbox row at simulated crash boundary"
          );

          assert.equal(
            (
              await pricingRows(
                pool,
                restaurantA
              )
            )[0].name,
            `A CLOUD V3 ${token}`
          );

          cloud.state.pullAvailable =
            false;

          agent =
            spawnAgent({
              cloudUrl:
                cloud.url,
              databaseUrl:
                DATABASE_URL,
              installationId,
              edgeSecret,
            });

          await waitFor(
            async () => {
              const rows =
                await pricingRows(
                  pool,
                  restaurantA
                );

              const inbox =
                await inboxRow(
                  pool,
                  restaurantA,
                  rev4.event
                    .event_id
                );

              return (
                rows.length === 1 &&
                rows[0].name ===
                  `A CLOUD V4 ${token}` &&
                inbox?.status ===
                  "applied"
              );
            },
            {
              message:
                "Restarted Edge did not recover durable pricing inbox work",
            }
          );

          assert.equal(
            agent.child.exitCode,
            null
          );

          assert.ok(
            cloud.state.pullFailures >=
              1,
            "Expected Cloud pull to remain unavailable after restart"
          );

          const state =
            await domainState(
              pool,
              restaurantA
            );

          assert.equal(
            Number(
              state?.applied_revision
            ),
            4
          );

          assert.deepEqual(
            names(
              await pricingRows(
                pool,
                restaurantB
              )
            ),
            names(bBefore)
          );

          console.log(
            "✅ 08 Crash/restart durable inbox recovery + tenant isolation proven"
          );
        }
      );

      if (agent) {
        assert.equal(
          agent.output().includes(
            edgeSecret
          ),
          false,
          "Edge secret leaked to agent output"
        );

        assert.equal(
          agent.output().includes(
            DATABASE_URL
          ),
          false,
          "Database URL leaked to agent output"
        );

        await stopAgent(agent);

        assert.equal(
          agent.child.exitCode,
          0
        );
      }

      console.log(
        "============================================"
      );
      console.log(
        "✅ MAKS CLOUD → EDGE PRICING E2E ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );
    } finally {
      await stopAgent(agent);

      if (cloud?.server) {
        await new Promise(
          (resolve) =>
            cloud.server.close(
              resolve
            )
        );
      }

      if (
        originalRole ===
          undefined
      ) {
        delete process.env
          .MAKS_RUNTIME_ROLE;
      } else {
        process.env.MAKS_RUNTIME_ROLE =
          originalRole;
      }

      if (
        restaurantA ||
        restaurantB
      ) {
        await pool.query(
          `
          DELETE FROM public.restaurants
          WHERE id = ANY($1::bigint[])
          `,
          [[
            restaurantA,
            restaurantB,
          ].filter(Boolean)]
        );
      }

      await pool.end();

      console.log(
        "✅ 09 Cleanup proven"
      );
    }
  }
);
