"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");

// Stub only route-bound auth/permission middleware.
// Writer authority + tenant rules remain production code under test.
const authModule =
  require("../../middleware/authMiddleware");
authModule.authenticateToken =
  (req, res, next) => next();

const membershipModule =
  require("../../middleware/tenantMembership");
membershipModule.loadMembership =
  (req, res, next) => {
    req.membership = {
      authority: "owner",
      permissions: ["*"],
    };
    next();
  };

const accessModule =
  require("../../middleware/accessControl");
accessModule.requirePermission =
  () => (req, res, next) => next();
accessModule.hasPermission =
  () => true;

delete require.cache[
  require.resolve("../../routes/drinksRoutes")
];
delete require.cache[
  require.resolve("../../routes/dessertsRoutes")
];

const drinksRoutes =
  require("../../routes/drinksRoutes");
const dessertsRoutes =
  require("../../routes/dessertsRoutes");

const {
  resetTestData,
} = require("../setup/resetTestData");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

const {
  getPool,
} = require("../../dbCompat");

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
        req.get("x-maks-test-rid") ||
        0
      );

    req.user = {
      id: null,
      restaurant_id:
        req.tenantRid,
      authority: "owner",
      permissions: ["*"],
    };

    req.kind = "pg";
    next();
  });

  app.use(
    "/drinks",
    drinksRoutes
  );

  app.use(
    "/desserts",
    dessertsRoutes
  );

  return app;
}

function call(
  app,
  method,
  path,
  rid
) {
  return request(app)
    [method](path)
    .set(
      "x-maks-test-rid",
      String(rid)
    );
}

async function revisionOf(
  pool,
  rid
) {
  const result =
    await pool.query(
      `
      SELECT produced_revision
      FROM public.edge_domain_revisions
      WHERE restaurant_id = $1
        AND domain = $2
      `,
      [rid, MENU_DOMAIN]
    );

  return result.rows.length
    ? Number(
        result.rows[0]
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
      FROM public.edge_outbox
      WHERE restaurant_id = $1
        AND event_type = $2
      `,
      [rid, MENU_EVENT]
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
      [rid, MENU_EVENT]
    );

  assert.equal(
    result.rows.length,
    1
  );

  return result.rows[0].payload;
}

async function removeFailureTrigger(
  pool
) {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_drink_dessert_catalog
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_drink_dessert_catalog()
  `);
}

test(
  "MAKS drink + dessert Cloud authority attack",
  {
    timeout: 60000,
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
    let drinkCategoryA;
    let dessertCategoryA;
    let drinkCategoryB;
    let dessertCategoryB;
    let drinkId;
    let dessertId;

    try {
      await removeFailureTrigger(
        pool
      );

      const restaurants =
        await pool.query(
          `
          INSERT INTO public.restaurants
            (name)
          VALUES
            ($1),
            ($2)
          RETURNING id
          `,
          [
            "DRINK DESSERT ATTACK A",
            "DRINK DESSERT ATTACK B",
          ]
        );

      restaurantA =
        Number(
          restaurants.rows[0].id
        );

      restaurantB =
        Number(
          restaurants.rows[1].id
        );

      const categories =
        await pool.query(
          `
          INSERT INTO public.categories
            (
              restaurant_id,
              name,
              type,
              icon
            )
          VALUES
            (
              $1,
              'ATTACK DRINKS A',
              'drinks',
              '🍹'
            ),
            (
              $1,
              'ATTACK DESSERTS A',
              'desserts',
              '🍰'
            ),
            (
              $2,
              'ATTACK DRINKS B',
              'drinks',
              '🍹'
            ),
            (
              $2,
              'ATTACK DESSERTS B',
              'desserts',
              '🍰'
            )
          RETURNING
            id,
            restaurant_id,
            type
          `,
          [
            restaurantA,
            restaurantB,
          ]
        );

      const by =
        (rid, type) =>
          Number(
            categories.rows.find(
              (row) =>
                Number(
                  row.restaurant_id
                ) === rid &&
                row.type === type
            ).id
          );

      drinkCategoryA =
        by(
          restaurantA,
          "drinks"
        );
      dessertCategoryA =
        by(
          restaurantA,
          "desserts"
        );
      drinkCategoryB =
        by(
          restaurantB,
          "drinks"
        );
      dessertCategoryB =
        by(
          restaurantB,
          "desserts"
        );

      process.env.MAKS_RUNTIME_ROLE =
        "cloud";

      await t.test(
        "Cloud drink create emits final snapshot",
        async () => {
          const response =
            await call(
              app,
              "post",
              "/drinks/items",
              restaurantA
            ).send({
              name:
                "ATTACK COLA",
              price:
                3.5,
              vat_rate:
                20,
              category_id:
                drinkCategoryA,
              options_schema:
                [],
              ingredients:
                [],
            });

          assert.equal(
            response.status,
            201,
            JSON.stringify(
              response.body
            )
          );

          drinkId =
            Number(
              response.body
                .item.id
            );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            1
          );

          const payload =
            await latestPayload(
              pool,
              restaurantA
            );

          assert.ok(
            payload.catalog.menu_items.some(
              (row) =>
                Number(row.id) ===
                  drinkId &&
                row.type ===
                  "drink" &&
                Number(row.price) ===
                  3.5
            )
          );

          console.log(
            "✅ 01 Cloud drink create + final snapshot proven"
          );
        }
      );

      await t.test(
        "Cloud dessert create emits final snapshot",
        async () => {
          const response =
            await call(
              app,
              "post",
              "/desserts/items",
              restaurantA
            ).send({
              name:
                "ATTACK CAKE",
              price:
                6.25,
              vat_rate:
                20,
              category_id:
                dessertCategoryA,
              options_schema:
                [],
              ingredients:
                [],
            });

          assert.equal(
            response.status,
            201,
            JSON.stringify(
              response.body
            )
          );

          dessertId =
            Number(
              response.body
                .item.id
            );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            2
          );

          const payload =
            await latestPayload(
              pool,
              restaurantA
            );

          assert.ok(
            payload.catalog.menu_items.some(
              (row) =>
                Number(row.id) ===
                  dessertId &&
                row.type ===
                  "dessert" &&
                Number(row.price) ===
                  6.25
            )
          );

          console.log(
            "✅ 02 Cloud dessert create + final snapshot proven"
          );
        }
      );

      await t.test(
        "cross-tenant categories are rejected before create",
        async () => {
          const before =
            await revisionOf(
              pool,
              restaurantA
            );

          const drink =
            await call(
              app,
              "post",
              "/drinks/items",
              restaurantA
            ).send({
              name:
                "ILLEGAL DRINK",
              price:
                2,
              category_id:
                drinkCategoryB,
            });

          const dessert =
            await call(
              app,
              "post",
              "/desserts/items",
              restaurantA
            ).send({
              name:
                "ILLEGAL DESSERT",
              price:
                5,
              category_id:
                dessertCategoryB,
            });

          assert.equal(
            drink.status,
            404
          );
          assert.equal(
            dessert.status,
            404
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            before
          );

          const leaked =
            await pool.query(
              `
              SELECT COUNT(*)::int AS count
              FROM public.menu_items
              WHERE restaurant_id = $1
                AND name IN
                  (
                    'ILLEGAL DRINK',
                    'ILLEGAL DESSERT'
                  )
              `,
              [restaurantA]
            );

          assert.equal(
            Number(
              leaked.rows[0].count
            ),
            0
          );

          console.log(
            "✅ 03 Cross-tenant categories rejected"
          );
        }
      );

      await t.test(
        "drink update + nutrition change emits one final snapshot",
        async () => {
          const response =
            await call(
              app,
              "put",
              `/drinks/items/${drinkId}`,
              restaurantA
            ).send({
              name:
                "ATTACK COLA UPDATED",
              price:
                3.75,
              ingredients:
                [],
            });

          assert.equal(
            response.status,
            200,
            JSON.stringify(
              response.body
            )
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            3
          );

          const payload =
            await latestPayload(
              pool,
              restaurantA
            );

          const row =
            payload.catalog.menu_items.find(
              (item) =>
                Number(item.id) ===
                drinkId
            );

          assert.equal(
            row.name,
            "ATTACK COLA UPDATED"
          );
          assert.equal(
            Number(row.price),
            3.75
          );
          assert.equal(
            row.allergens,
            "None"
          );

          console.log(
            "✅ 04 Drink update + nutrition snapshot proven"
          );
        }
      );

      await t.test(
        "cross-tenant category update creates no fake revision",
        async () => {
          const before =
            await revisionOf(
              pool,
              restaurantA
            );

          const response =
            await call(
              app,
              "put",
              `/desserts/items/${dessertId}`,
              restaurantA
            ).send({
              category_id:
                dessertCategoryB,
            });

          assert.equal(
            response.status,
            404
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            before
          );

          const row =
            await pool.query(
              `
              SELECT category_id
              FROM public.menu_items
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                dessertId,
              ]
            );

          assert.equal(
            Number(
              row.rows[0]
                .category_id
            ),
            dessertCategoryA
          );

          console.log(
            "✅ 05 Cross-tenant category update rejected"
          );
        }
      );

      await t.test(
        "forced outbox failure rolls item + recipe + nutrition back",
        async () => {
          await pool.query(
            `
            INSERT INTO public.menu_item_ingredients
              (
                restaurant_id,
                menu_item_id,
                stock_id,
                ingredient,
                amount,
                unit
              )
            VALUES
              (
                $1,
                $2,
                NULL,
                'ORIGINAL RECIPE',
                2,
                'g'
              )
            `,
            [
              restaurantA,
              dessertId,
            ]
          );

          const beforeItem =
            await pool.query(
              `
              SELECT
                name,
                price,
                allergens,
                calories
              FROM public.menu_items
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                dessertId,
              ]
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
              public.maks_test_reject_drink_dessert_catalog()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              IF NEW.event_type =
                'menu.catalog.replaced.v1'
              THEN
                RAISE EXCEPTION
                  'MAKS_TEST_FORCED_DRINK_DESSERT_OUTBOX_FAILURE';
              END IF;

              RETURN NEW;
            END;
            $$
          `);

          await pool.query(`
            CREATE TRIGGER
              trg_maks_test_reject_drink_dessert_catalog
            BEFORE INSERT
            ON public.edge_outbox
            FOR EACH ROW
            EXECUTE FUNCTION
              public.maks_test_reject_drink_dessert_catalog()
          `);

          try {
            const response =
              await call(
                app,
                "put",
                `/desserts/items/${dessertId}`,
                restaurantA
              ).send({
                name:
                  "MUST ROLLBACK",
                price:
                  99,
                ingredients: [
                  {
                    ingredient:
                      "NEW RECIPE",
                    amount:
                      5,
                    unit:
                      "g",
                  },
                ],
              });

            assert.equal(
              response.status,
              500
            );
          } finally {
            await removeFailureTrigger(
              pool
            );
          }

          const afterItem =
            await pool.query(
              `
              SELECT
                name,
                price,
                allergens,
                calories
              FROM public.menu_items
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                dessertId,
              ]
            );

          assert.deepEqual(
            afterItem.rows[0],
            beforeItem.rows[0]
          );

          const recipes =
            await pool.query(
              `
              SELECT
                ingredient,
                amount,
                unit
              FROM public.menu_item_ingredients
              WHERE restaurant_id = $1
                AND menu_item_id = $2
              ORDER BY id
              `,
              [
                restaurantA,
                dessertId,
              ]
            );

          assert.equal(
            recipes.rows.length,
            1
          );
          assert.equal(
            recipes.rows[0]
              .ingredient,
            "ORIGINAL RECIPE"
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

          console.log(
            "✅ 06 Forced outbox failure rolled item + recipe + nutrition back"
          );
        }
      );

      await t.test(
        "real drink delete emits once and repeated delete does not",
        async () => {
          const before =
            await revisionOf(
              pool,
              restaurantA
            );

          const first =
            await call(
              app,
              "delete",
              `/drinks/items/${drinkId}`,
              restaurantA
            );

          assert.equal(
            first.status,
            200
          );
          assert.deepEqual(
            first.body,
            {
              success: true,
            }
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            before + 1
          );

          const second =
            await call(
              app,
              "delete",
              `/drinks/items/${drinkId}`,
              restaurantA
            );

          assert.equal(
            second.status,
            404
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            before + 1
          );

          console.log(
            "✅ 07 Drink delete + no fake delete revision proven"
          );
        }
      );

      await t.test(
        "Edge runtime rejects both writer families",
        async () => {
          const before =
            await revisionOf(
              pool,
              restaurantA
            );

          process.env.MAKS_RUNTIME_ROLE =
            "edge";

          const drink =
            await call(
              app,
              "post",
              "/drinks/items",
              restaurantA
            ).send({
              name:
                "EDGE DRINK",
              price:
                1,
              category_id:
                drinkCategoryA,
            });

          const dessert =
            await call(
              app,
              "put",
              `/desserts/items/${dessertId}`,
              restaurantA
            ).send({
              name:
                "EDGE DESSERT",
            });

          assert.equal(
            drink.status,
            409
          );
          assert.equal(
            dessert.status,
            409
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            before
          );

          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          console.log(
            "✅ 08 Edge drink + dessert authoring fails closed"
          );
        }
      );

      await t.test(
        "missing runtime role fails closed",
        async () => {
          const before =
            await revisionOf(
              pool,
              restaurantA
            );

          delete process.env
            .MAKS_RUNTIME_ROLE;

          const response =
            await call(
              app,
              "post",
              "/desserts/items",
              restaurantA
            ).send({
              name:
                "ROLELESS DESSERT",
              price:
                4,
              category_id:
                dessertCategoryA,
            });

          assert.equal(
            response.status,
            503
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            before
          );

          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          console.log(
            "✅ 09 Missing runtime role fails closed"
          );
        }
      );

      await t.test(
        "Restaurant B remains independently authoritative",
        async () => {
          const beforeA =
            await revisionOf(
              pool,
              restaurantA
            );

          const beforeB =
            await revisionOf(
              pool,
              restaurantB
            );

          const response =
            await call(
              app,
              "post",
              "/drinks/items",
              restaurantB
            ).send({
              name:
                "TENANT B DRINK",
              price:
                8,
              category_id:
                drinkCategoryB,
              ingredients:
                [],
            });

          assert.equal(
            response.status,
            201,
            JSON.stringify(
              response.body
            )
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantB
            ),
            beforeB + 1
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            beforeA
          );

          console.log(
            "✅ 10 Restaurant B authority preserved"
          );
        }
      );

      console.log(
        "============================================"
      );
      console.log(
        "✅ MAKS DRINK + DESSERT CLOUD AUTHORITY ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );
    } finally {
      process.env.MAKS_RUNTIME_ROLE =
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
