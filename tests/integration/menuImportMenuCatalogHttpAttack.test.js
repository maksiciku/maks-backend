"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");

const {
  resetTestData,
} = require("../setup/resetTestData");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

const {
  getPool,
} = require("../../dbCompat");

const menuImportRoutes =
  require("../../routes/menuImportRoutes");

const MENU_EVENT =
  "menu.catalog.replaced.v1";

const MENU_DOMAIN =
  "menu.catalog";

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;

function makeApp() {
  const app = express();

  app.use(express.json());

  app.use((req, res, next) => {
    req.tenantRid =
      Number(
        req.get(
          "x-maks-test-rid"
        ) ||
        0
      );

    req.user = {
      id: null,
      restaurant_id:
        req.tenantRid,
    };

    next();
  });

  app.use(
    "/menu-import",
    menuImportRoutes
  );

  return app;
}

function commit(
  app,
  rid,
  categories
) {
  return request(app)
    .post(
      "/menu-import/commit"
    )
    .set(
      "x-maks-test-rid",
      String(rid)
    )
    .send({
      categories,
    });
}

async function revisionOf(
  pool,
  rid
) {
  const result =
    await pool.query(
      `
      SELECT
        produced_revision
      FROM
        public.edge_domain_revisions
      WHERE
        restaurant_id = $1
        AND domain = $2
      `,
      [
        rid,
        MENU_DOMAIN,
      ]
    );

  return result.rows.length
    ? Number(
        result
          .rows[0]
          .produced_revision ||
        0
      )
    : 0;
}

async function outboxCount(
  pool,
  rid
) {
  const result =
    await pool.query(
      `
      SELECT
        COUNT(*)::int AS count
      FROM
        public.edge_outbox
      WHERE
        restaurant_id = $1
        AND event_type = $2
      `,
      [
        rid,
        MENU_EVENT,
      ]
    );

  return Number(
    result.rows[0].count
  );
}

async function latestPayload(
  pool,
  rid
) {
  const result =
    await pool.query(
      `
      SELECT payload
      FROM public.edge_outbox
      WHERE restaurant_id = $1
        AND event_type = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [
        rid,
        MENU_EVENT,
      ]
    );

  assert.equal(
    result.rows.length,
    1
  );

  return result.rows[0].payload;
}

async function tenantCounts(
  pool,
  rid
) {
  const result =
    await pool.query(
      `
      SELECT
        (
          SELECT
            COUNT(*)::int
          FROM
            public.categories
          WHERE
            restaurant_id = $1
        ) AS categories,

        (
          SELECT
            COUNT(*)::int
          FROM
            public.meals
          WHERE
            restaurant_id = $1
        ) AS meals,

        (
          SELECT
            COUNT(*)::int
          FROM
            public.menu_items
          WHERE
            restaurant_id = $1
        ) AS menu_items
      `,
      [
        rid,
      ]
    );

  return {
    categories:
      Number(
        result
          .rows[0]
          .categories
      ),

    meals:
      Number(
        result
          .rows[0]
          .meals
      ),

    menu_items:
      Number(
        result
          .rows[0]
          .menu_items
      ),
  };
}

async function removeFailureTrigger(
  pool
) {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_menu_import_catalog
    ON
      public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_menu_import_catalog()
  `);
}

test(
  "MAKS menu import Cloud authority attack",
  {
    timeout:
      60000,
  },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();

    const pool =
      getPool();

    const app =
      makeApp();

    let restaurantA;
    let restaurantB;

    try {
      await removeFailureTrigger(
        pool
      );

      const restaurants =
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
          RETURNING id
          `,
          [
            "MENU IMPORT ATTACK A",
            "MENU IMPORT ATTACK B",
          ]
        );

      restaurantA =
        Number(
          restaurants
            .rows[0]
            .id
        );

      restaurantB =
        Number(
          restaurants
            .rows[1]
            .id
        );

      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

      await t.test(
        "Cloud bulk import commits one complete snapshot",
        async () => {
          const response =
            await commit(
              app,
              restaurantA,
              [
                {
                  name:
                    "Mains",
                  type:
                    "meals",
                  items: [
                    {
                      name:
                        "IMPORT BURGER",
                      price:
                        12.5,
                    },
                  ],
                },
                {
                  name:
                    "Drinks",
                  type:
                    "drinks",
                  items: [
                    {
                      name:
                        "IMPORT COLA",
                      price:
                        3.25,
                    },
                  ],
                },
                {
                  name:
                    "Desserts",
                  type:
                    "desserts",
                  items: [
                    {
                      name:
                        "IMPORT CAKE",
                      price:
                        6.5,
                    },
                  ],
                },
              ]
            );

          assert.equal(
            response.status,
            200,
            JSON.stringify(
              response.body
            )
          );

          assert.deepEqual(
            response.body.imported,
            {
              categories: 3,
              meals: 1,
              drinks: 1,
              desserts: 1,
              skipped: 0,
            }
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            1
          );

          assert.equal(
            await outboxCount(
              pool,
              restaurantA
            ),
            1
          );

          const counts =
            await tenantCounts(
              pool,
              restaurantA
            );

          assert.deepEqual(
            counts,
            {
              categories: 3,
              meals: 1,
              menu_items: 2,
            }
          );

          const payload =
            await latestPayload(
              pool,
              restaurantA
            );

          assert.ok(
            payload
              .catalog
              .meals
              .some(
                (row) =>
                  row.name ===
                  "IMPORT BURGER"
              )
          );

          assert.ok(
            payload
              .catalog
              .menu_items
              .some(
                (row) =>
                  row.name ===
                    "IMPORT COLA" &&
                  row.type ===
                    "drink"
              )
          );

          assert.ok(
            payload
              .catalog
              .menu_items
              .some(
                (row) =>
                  row.name ===
                    "IMPORT CAKE" &&
                  row.type ===
                    "dessert"
              )
          );

          console.log(
            "✅ 01 One transaction + one complete menu snapshot proven"
          );
        }
      );

      await t.test(
        "same-name tenant B catalogue remains isolated",
        async () => {
          await pool.query(
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
              'Mains',
              'meals',
              '🍽️'
            )
            `,
            [
              restaurantB,
            ]
          );

          await pool.query(
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
              paused,
              options_schema
            )
            VALUES
            (
              $1,
              'IMPORT BURGER',
              '[]'::jsonb,
              'TENANT B',
              0,
              99.99,
              'Mains',
              false,
              '[]'::jsonb
            )
            `,
            [
              restaurantB,
            ]
          );

          const beforeB =
            await tenantCounts(
              pool,
              restaurantB
            );

          const response =
            await commit(
              app,
              restaurantA,
              [
                {
                  name:
                    "Late Menu",
                  type:
                    "meals",
                  items: [
                    {
                      name:
                        "A ONLY ITEM",
                      price:
                        8,
                    },
                  ],
                },
              ]
            );

          assert.equal(
            response.status,
            200
          );

          const afterB =
            await tenantCounts(
              pool,
              restaurantB
            );

          assert.deepEqual(
            afterB,
            beforeB
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            2
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantB
            ),
            0
          );

          console.log(
            "✅ 02 Tenant B untouched by Restaurant A bulk import"
          );
        }
      );

      await t.test(
        "empty import is rejected without revision",
        async () => {
          const beforeRevision =
            await revisionOf(
              pool,
              restaurantA
            );

          const response =
            await commit(
              app,
              restaurantA,
              []
            );

          assert.equal(
            response.status,
            400
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            beforeRevision
          );

          console.log(
            "✅ 03 Empty import creates no fake revision"
          );
        }
      );

      await t.test(
        "forced outbox failure rolls back every imported row and revision",
        async () => {
          const beforeCounts =
            await tenantCounts(
              pool,
              restaurantA
            );

          const beforeRevision =
            await revisionOf(
              pool,
              restaurantA
            );

          const beforeOutbox =
            await outboxCount(
              pool,
              restaurantA
            );

          await removeFailureTrigger(
            pool
          );

          await pool.query(`
            CREATE FUNCTION
              public.maks_test_reject_menu_import_catalog()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              IF NEW.event_type =
                'menu.catalog.replaced.v1'
              THEN
                RAISE EXCEPTION
                  'MAKS_TEST_FORCED_MENU_IMPORT_OUTBOX_FAILURE';
              END IF;

              RETURN NEW;
            END;
            $$
          `);

          await pool.query(`
            CREATE TRIGGER
              trg_maks_test_reject_menu_import_catalog
            BEFORE INSERT
            ON
              public.edge_outbox
            FOR EACH ROW
            EXECUTE FUNCTION
              public.maks_test_reject_menu_import_catalog()
          `);

          try {
            const response =
              await commit(
                app,
                restaurantA,
                [
                  {
                    name:
                      "ROLLBACK MAINS",
                    type:
                      "meals",
                    items: [
                      {
                        name:
                          "ROLLBACK MEAL",
                        price:
                          14,
                      },
                    ],
                  },
                  {
                    name:
                      "ROLLBACK DRINKS",
                    type:
                      "drinks",
                    items: [
                      {
                        name:
                          "ROLLBACK DRINK",
                        price:
                          4,
                      },
                    ],
                  },
                  {
                    name:
                      "ROLLBACK DESSERTS",
                    type:
                      "desserts",
                    items: [
                      {
                        name:
                          "ROLLBACK DESSERT",
                        price:
                          7,
                      },
                    ],
                  },
                ]
              );

            assert.equal(
              response.status,
              500
            );
          } finally {
            await removeFailureTrigger(
              pool
            );
          }

          const afterCounts =
            await tenantCounts(
              pool,
              restaurantA
            );

          assert.deepEqual(
            afterCounts,
            beforeCounts
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            beforeRevision
          );

          assert.equal(
            await outboxCount(
              pool,
              restaurantA
            ),
            beforeOutbox
          );

          const leaked =
            await pool.query(
              `
              SELECT
                (
                  SELECT COUNT(*)::int
                  FROM public.meals
                  WHERE restaurant_id = $1
                    AND name =
                      'ROLLBACK MEAL'
                ) AS meals,

                (
                  SELECT COUNT(*)::int
                  FROM public.menu_items
                  WHERE restaurant_id = $1
                    AND name IN
                      (
                        'ROLLBACK DRINK',
                        'ROLLBACK DESSERT'
                      )
                ) AS menu_items
              `,
              [
                restaurantA,
              ]
            );

          assert.equal(
            Number(
              leaked
                .rows[0]
                .meals
            ),
            0
          );

          assert.equal(
            Number(
              leaked
                .rows[0]
                .menu_items
            ),
            0
          );

          console.log(
            "✅ 04 Forced event failure rolls entire import back"
          );
        }
      );

      await t.test(
        "Edge runtime rejects import before mutation",
        async () => {
          const beforeCounts =
            await tenantCounts(
              pool,
              restaurantA
            );

          const beforeRevision =
            await revisionOf(
              pool,
              restaurantA
            );

          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";

          const response =
            await commit(
              app,
              restaurantA,
              [
                {
                  name:
                    "EDGE ILLEGAL",
                  type:
                    "meals",
                  items: [
                    {
                      name:
                        "EDGE ILLEGAL ITEM",
                      price:
                        5,
                    },
                  ],
                },
              ]
            );

          assert.equal(
            response.status,
            409
          );

          assert.deepEqual(
            await tenantCounts(
              pool,
              restaurantA
            ),
            beforeCounts
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            beforeRevision
          );

          process.env
            .MAKS_RUNTIME_ROLE =
            "cloud";

          console.log(
            "✅ 05 Edge menu import fails closed"
          );
        }
      );

      await t.test(
        "missing runtime role fails closed before import",
        async () => {
          const beforeCounts =
            await tenantCounts(
              pool,
              restaurantA
            );

          const beforeRevision =
            await revisionOf(
              pool,
              restaurantA
            );

          delete process.env
            .MAKS_RUNTIME_ROLE;

          const response =
            await commit(
              app,
              restaurantA,
              [
                {
                  name:
                    "ROLELESS",
                  type:
                    "meals",
                  items: [
                    {
                      name:
                        "ROLELESS ITEM",
                      price:
                        9,
                    },
                  ],
                },
              ]
            );

          assert.equal(
            response.status,
            503
          );

          assert.deepEqual(
            await tenantCounts(
              pool,
              restaurantA
            ),
            beforeCounts
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            beforeRevision
          );

          process.env
            .MAKS_RUNTIME_ROLE =
            "cloud";

          console.log(
            "✅ 06 Missing runtime role fails closed"
          );
        }
      );

      await t.test(
        "duplicate items remain skipped while commit emits one final snapshot",
        async () => {
          const beforeCounts =
            await tenantCounts(
              pool,
              restaurantA
            );

          const beforeRevision =
            await revisionOf(
              pool,
              restaurantA
            );

          const beforeOutbox =
            await outboxCount(
              pool,
              restaurantA
            );

          const response =
            await commit(
              app,
              restaurantA,
              [
                {
                  name:
                    "Mains",
                  type:
                    "meals",
                  items: [
                    {
                      name:
                        "IMPORT BURGER",
                      price:
                        999,
                    },
                  ],
                },
                {
                  name:
                    "Drinks",
                  type:
                    "drinks",
                  items: [
                    {
                      name:
                        "IMPORT COLA",
                      price:
                        999,
                    },
                  ],
                },
              ]
            );

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            response
              .body
              .imported
              .skipped,
            2
          );

          assert.deepEqual(
            await tenantCounts(
              pool,
              restaurantA
            ),
            beforeCounts
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            beforeRevision + 1
          );

          assert.equal(
            await outboxCount(
              pool,
              restaurantA
            ),
            beforeOutbox + 1
          );

          console.log(
            "✅ 07 Duplicate-safe import still emits one final snapshot"
          );
        }
      );

      console.log(
        "============================================"
      );

      console.log(
        "✅ MAKS MENU IMPORT CLOUD AUTHORITY ATTACK COMPLETE"
      );

      console.log(
        "============================================"
      );
    } finally {
      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

      await removeFailureTrigger(
        pool
      );

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

      await pool.end();

      console.log(
        "✅ Cleanup proven"
      );
    }
  }
);
