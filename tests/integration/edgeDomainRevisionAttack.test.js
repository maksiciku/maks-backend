"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

const {
  Pool,
} = require("pg");

const {
  withTx,
} = require(
  "../../dbCompat"
);

const {
  runCanonicalEdgeDomainRevisionsPg,
} = require(
  "../../migrations/canonicalEdgeDomainRevisions.pg"
);

const {
  EdgeDomainRevisionError,
  nextProducedRevisionTx,
  applyDomainRevisionTx,
  readDomainRevisionTx,
} = require(
  "../../edge/domainRevisionStore"
);


const DATABASE_URL =
  String(
    process.env.DATABASE_URL ||
    ""
  ).trim();


function hash(
  character
) {
  return String(character)
    .repeat(64)
    .slice(0, 64);
}


function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}


async function expectRevisionError(
  fn,
  code
) {
  let caught =
    null;

  try {
    await fn();
  } catch (error) {
    caught =
      error;
  }

  assert.ok(
    caught,
    `Expected Edge domain revision error ${code}`
  );

  assert.ok(
    caught instanceof
      EdgeDomainRevisionError,
    `Expected EdgeDomainRevisionError, got ${caught?.constructor?.name}`
  );

  assert.equal(
    caught.code,
    code
  );

  return caught;
}


test(
  "MAKS Edge domain revision attack",
  {
    timeout:
      60000,
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

    const domain =
      `attack.pricing.${token}`;

    let restaurantA =
      null;

    let restaurantB =
      null;

    try {
      const database =
        await pool.query(`
          SELECT
            current_database()
              AS db
        `);

      assert.equal(
        database.rows?.[0]?.db,
        "maks_test",
        "REFUSED: Edge domain revision Attack may run only against maks_test"
      );

      console.log(
        "✅ 01 Database guard: maks_test"
      );

      await runCanonicalEdgeDomainRevisionsPg({
        pool,
      });

      await runCanonicalEdgeDomainRevisionsPg({
        pool,
      });

      console.log(
        "✅ 02 Migration idempotency proven"
      );

      const before =
        Number(
          (
            await pool.query(`
              SELECT COUNT(*)::int
                AS count
              FROM
                public.edge_domain_revisions
            `)
          ).rows[0].count
        );

      const ra =
        await pool.query(
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
            `EDGE DOMAIN REVISION ATTACK A ${token}`,
          ]
        );

      const rb =
        await pool.query(
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
            `EDGE DOMAIN REVISION ATTACK B ${token}`,
          ]
        );

      restaurantA =
        Number(
          ra.rows[0].id
        );

      restaurantB =
        Number(
          rb.rows[0].id
        );

      assert.ok(
        Number.isSafeInteger(
          restaurantA
        )
      );

      assert.ok(
        Number.isSafeInteger(
          restaurantB
        )
      );

      assert.notEqual(
        restaurantA,
        restaurantB
      );

      console.log(
        "✅ 03 Isolated tenants created"
      );

      await t.test(
        "produced revisions are tenant isolated and monotonic",
        async () => {
          const a1 =
            await withTx(
              (tx) =>
                nextProducedRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                  }
                )
            );

          const a2 =
            await withTx(
              (tx) =>
                nextProducedRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                  }
                )
            );

          const b1 =
            await withTx(
              (tx) =>
                nextProducedRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantB,
                    domain,
                  }
                )
            );

          assert.deepEqual(
            [
              a1,
              a2,
              b1,
            ],
            [
              1,
              2,
              1,
            ]
          );

          console.log(
            "✅ 04 Tenant-isolated monotonic production proven"
          );
        }
      );

      await t.test(
        "concurrent producers receive unique contiguous revisions",
        async () => {
          const revisions =
            await Promise.all(
              Array.from(
                {
                  length: 8,
                },
                () =>
                  withTx(
                    (tx) =>
                      nextProducedRevisionTx(
                        tx,
                        {
                          restaurantId:
                            restaurantA,
                          domain,
                        }
                      )
                  )
              )
            );

          assert.deepEqual(
            revisions
              .slice()
              .sort(
                (a, b) =>
                  a - b
              ),
            [
              3,
              4,
              5,
              6,
              7,
              8,
              9,
              10,
            ]
          );

          console.log(
            "✅ 05 Concurrent revision allocation proven"
          );
        }
      );

      await t.test(
        "failed producer transaction does not consume a revision",
        async () => {
          await assert.rejects(
            () =>
              withTx(
                async (tx) => {
                  const revision =
                    await nextProducedRevisionTx(
                      tx,
                      {
                        restaurantId:
                          restaurantA,
                        domain,
                      }
                    );

                  assert.equal(
                    revision,
                    11
                  );

                  throw new Error(
                    "simulated producer crash"
                  );
                }
              ),
            /simulated producer crash/
          );

          const row =
            await withTx(
              (tx) =>
                readDomainRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                  }
                )
            );

          assert.equal(
            Number(
              row.produced_revision
            ),
            10
          );

          console.log(
            "✅ 06 Producer rollback safety proven"
          );
        }
      );

      await t.test(
        "applied revision rejects stale and conflicting snapshots",
        async () => {
          let executions =
            0;

          const first =
            await withTx(
              (tx) =>
                applyDomainRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                    revision: 5,
                    payloadHash:
                      hash("a"),
                    execute:
                      async () => {
                        executions +=
                          1;

                        return {
                          snapshot:
                            "revision-5",
                        };
                      },
                  }
                )
            );

          assert.equal(
            first.state,
            "applied"
          );

          assert.equal(
            first.appliedRevision,
            5
          );

          assert.equal(
            executions,
            1
          );

          const stale =
            await withTx(
              (tx) =>
                applyDomainRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                    revision: 4,
                    payloadHash:
                      hash("d"),
                    execute:
                      async () => {
                        executions +=
                          100;
                      },
                  }
                )
            );

          assert.equal(
            stale.state,
            "stale"
          );

          const duplicate =
            await withTx(
              (tx) =>
                applyDomainRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                    revision: 5,
                    payloadHash:
                      hash("a"),
                    execute:
                      async () => {
                        executions +=
                          100;
                      },
                  }
                )
            );

          assert.equal(
            duplicate.state,
            "duplicate"
          );

          assert.equal(
            executions,
            1,
            "Stale/duplicate revision executed business mutation"
          );

          await expectRevisionError(
            () =>
              withTx(
                (tx) =>
                  applyDomainRevisionTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                      domain,
                      revision: 5,
                      payloadHash:
                        hash("b"),
                      execute:
                        async () => {
                          executions +=
                            100;
                        },
                    }
                  )
              ),
            "EDGE_DOMAIN_REVISION_CONFLICT"
          );

          assert.equal(
            executions,
            1
          );

          console.log(
            "✅ 07 Stale/replay/conflict protection proven"
          );
        }
      );

      await t.test(
        "business mutation and applied revision roll back together",
        async () => {
          await assert.rejects(
            () =>
              withTx(
                (tx) =>
                  applyDomainRevisionTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                      domain,
                      revision: 6,
                      payloadHash:
                        hash("c"),
                      execute:
                        async ({
                          tx:
                            innerTx,
                        }) => {
                          await innerTx.qRun(
                            `
                            UPDATE
                              public.restaurants
                            SET
                              name = $2
                            WHERE
                              id = $1
                            `,
                            [
                              restaurantA,
                              `SHOULD ROLL BACK ${token}`,
                            ]
                          );

                          throw new Error(
                            "simulated apply crash"
                          );
                        },
                    }
                  )
              ),
            /simulated apply crash/
          );

          const row =
            await withTx(
              (tx) =>
                readDomainRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                  }
                )
            );

          assert.equal(
            Number(
              row.applied_revision
            ),
            5
          );

          assert.equal(
            String(
              row.applied_payload_hash
            ),
            hash("a")
          );

          const restaurant =
            await pool.query(
              `
              SELECT name
              FROM public.restaurants
              WHERE id = $1
              `,
              [
                restaurantA,
              ]
            );

          assert.equal(
            restaurant.rows[0].name,
            `EDGE DOMAIN REVISION ATTACK A ${token}`
          );

          console.log(
            "✅ 08 Business + revision rollback proven"
          );
        }
      );

      await t.test(
        "newer revision advances after a rolled-back attempt",
        async () => {
          const result =
            await withTx(
              (tx) =>
                applyDomainRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                    revision: 6,
                    payloadHash:
                      hash("c"),
                    execute:
                      async () => ({
                        snapshot:
                          "revision-6",
                      }),
                  }
                )
            );

          assert.equal(
            result.state,
            "applied"
          );

          assert.equal(
            result.appliedRevision,
            6
          );

          const tenantB =
            await withTx(
              (tx) =>
                readDomainRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantB,
                    domain,
                  }
                )
            );

          assert.equal(
            Number(
              tenantB.applied_revision
            ),
            0
          );

          console.log(
            "✅ 09 Newer revision + tenant isolation proven"
          );
        }
      );

      await t.test(
        "concurrent application of the same revision executes once",
        async () => {
          let executions =
            0;

          const run =
            () =>
              withTx(
                (tx) =>
                  applyDomainRevisionTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                      domain,
                      revision: 7,
                      payloadHash:
                        hash("e"),
                      execute:
                        async () => {
                          executions +=
                            1;

                          await sleep(
                            100
                          );

                          return {
                            snapshot:
                              "revision-7",
                          };
                        },
                    }
                  )
              );

          const [
            first,
            second,
          ] =
            await Promise.all([
              run(),
              run(),
            ]);

          assert.equal(
            executions,
            1,
            "Concurrent duplicate revision executed business logic twice"
          );

          assert.deepEqual(
            [
              first.state,
              second.state,
            ].sort(),
            [
              "applied",
              "duplicate",
            ]
          );

          const row =
            await withTx(
              (tx) =>
                readDomainRevisionTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                    domain,
                  }
                )
            );

          assert.equal(
            Number(
              row.applied_revision
            ),
            7
          );

          console.log(
            "✅ 10 Concurrent apply execute-once proven"
          );
        }
      );

      await t.test(
        "invalid revision inputs fail closed",
        async () => {
          await expectRevisionError(
            () =>
              withTx(
                (tx) =>
                  nextProducedRevisionTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                      domain: "",
                    }
                  )
              ),
            "EDGE_DOMAIN_NAME_INVALID"
          );

          await expectRevisionError(
            () =>
              withTx(
                (tx) =>
                  applyDomainRevisionTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                      domain,
                      revision: 0,
                      payloadHash:
                        hash("a"),
                      execute:
                        async () => {},
                    }
                  )
              ),
            "EDGE_DOMAIN_REVISION_INVALID"
          );

          await expectRevisionError(
            () =>
              withTx(
                (tx) =>
                  applyDomainRevisionTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                      domain,
                      revision: 7,
                      payloadHash:
                        "not-a-hash",
                      execute:
                        async () => {},
                    }
                  )
              ),
            "EDGE_DOMAIN_HASH_INVALID"
          );

          console.log(
            "✅ 11 Invalid input fail-closed proof passed"
          );
        }
      );

      console.log(
        "============================================"
      );
      console.log(
        "✅ MAKS EDGE DOMAIN REVISION ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );

      await pool.query(
        `
        DELETE FROM public.restaurants
        WHERE id = ANY($1::bigint[])
        `,
        [
          [
            restaurantA,
            restaurantB,
          ],
        ]
      );

      restaurantA =
        null;

      restaurantB =
        null;

      const after =
        Number(
          (
            await pool.query(`
              SELECT COUNT(*)::int
                AS count
              FROM
                public.edge_domain_revisions
            `)
          ).rows[0].count
        );

      assert.equal(
        after,
        before,
        "Edge domain revision rows leaked after tenant cleanup"
      );

      console.log(
        "✅ 12 Cleanup proven"
      );
    } finally {
      if (
        restaurantA ||
        restaurantB
      ) {
        await pool.query(
          `
          DELETE FROM public.restaurants
          WHERE id = ANY($1::bigint[])
          `,
          [
            [
              restaurantA,
              restaurantB,
            ].filter(Boolean),
          ]
        );
      }

      await pool.end();
    }
  }
);
