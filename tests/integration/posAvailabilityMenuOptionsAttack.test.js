"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");

const authModule =
  require("../../middleware/authMiddleware");

authModule.authenticateToken =
  (req, res, next) => {
    const rid = Number(
      req.get("x-maks-test-rid") || 0
    );

    if (!rid) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    req.user = {
      id: null,
      restaurant_id: rid,
      role: "owner",
      authority: "owner",
      permissions: ["*"],
    };

    next();
  };

authModule.requireRole =
  () => (req, res, next) => next();

const membershipModule =
  require("../../middleware/tenantMembership");

membershipModule.loadMembership =
  (req, res, next) => {
    const rid = Number(
      req.user?.restaurant_id || 0
    );

    req.tenantRid = rid;
    req.membership = {
      restaurant_id: rid,
      role: "owner",
      authority: "owner",
      permissions: ["*"],
    };

    next();
  };

delete require.cache[
  require.resolve("../../routes/posRoutes")
];
delete require.cache[
  require.resolve("../../routes/menuItemsRoutes")
];

const { router: posRoutes } =
  require("../../routes/posRoutes");
const menuItemsRoutes =
  require("../../routes/menuItemsRoutes");

const {
  resetTestData,
} = require("../setup/resetTestData");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

const db = require("../../dbCompat");

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
    req.kind = "pg";
    req.qGet = db.qGet;
    req.qRun = db.qRun;
    req.qAll = db.qAll;
    next();
  });

  app.use("/orders", posRoutes);
  app.use("/menu-items", menuItemsRoutes);

  return app;
}

function authed(app, method, path, rid) {
  return request(app)
    [method](path)
    .set(
      "x-maks-test-rid",
      String(rid)
    );
}

async function revisionOf(pool, rid) {
  const result = await pool.query(
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
        result.rows[0].produced_revision || 0
      )
    : 0;
}

async function outboxCount(pool, rid) {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM public.edge_outbox
    WHERE restaurant_id = $1
      AND event_type = $2
    `,
    [rid, MENU_EVENT]
  );

  return Number(result.rows[0].count);
}

async function latestPayload(pool, rid) {
  const result = await pool.query(
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

  assert.equal(result.rows.length, 1);
  return result.rows[0].payload;
}

async function removeFailureTrigger(pool) {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_pos_availability_catalog
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_pos_availability_catalog()
  `);
}

test(
  "MAKS final menu bypass attack",
  { timeout: 60000 },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();

    const pool = db.getPool();
    const app = makeApp();

    let restaurantA;
    let restaurantB;
    let mealA;
    let mealB;
    let drinkA;
    let drinkB;
    let dessertA;

    try {
      await removeFailureTrigger(pool);

      const restaurants = await pool.query(
        `
        INSERT INTO public.restaurants (name)
        VALUES ($1), ($2)
        RETURNING id
        `,
        [
          "FINAL MENU ATTACK A",
          "FINAL MENU ATTACK B",
        ]
      );

      restaurantA = Number(restaurants.rows[0].id);
      restaurantB = Number(restaurants.rows[1].id);

      const categories = await pool.query(
        `
        INSERT INTO public.categories
          (restaurant_id, name, type, icon)
        VALUES
          ($1, 'MEALS A', 'meals', '🍽️'),
          ($1, 'DRINKS A', 'drinks', '🍹'),
          ($1, 'DESSERTS A', 'desserts', '🍰'),
          ($2, 'MEALS B', 'meals', '🍽️'),
          ($2, 'DRINKS B', 'drinks', '🍹')
        RETURNING id, restaurant_id, type
        `,
        [restaurantA, restaurantB]
      );

      const cid = (rid, type) =>
        Number(
          categories.rows.find(
            (row) =>
              Number(row.restaurant_id) === rid &&
              row.type === type
          ).id
        );

      const meals = await pool.query(
        `
        INSERT INTO public.meals
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
            'MEAL A',
            '[]'::jsonb,
            'None',
            0,
            10,
            'MEALS A',
            $2,
            false,
            '{"modifiers":[],"extras":[]}'::jsonb,
            false
          ),
          (
            $3,
            'MEAL B',
            '[]'::jsonb,
            'None',
            0,
            11,
            'MEALS B',
            $4,
            false,
            '{"modifiers":[],"extras":[]}'::jsonb,
            false
          )
        RETURNING id, restaurant_id
        `,
        [
          restaurantA,
          cid(restaurantA, "meals"),
          restaurantB,
          cid(restaurantB, "meals"),
        ]
      );

      mealA = Number(
        meals.rows.find(
          (row) =>
            Number(row.restaurant_id) ===
            restaurantA
        ).id
      );

      mealB = Number(
        meals.rows.find(
          (row) =>
            Number(row.restaurant_id) ===
            restaurantB
        ).id
      );

      const items = await pool.query(
        `
        INSERT INTO public.menu_items
        (
          restaurant_id,
          name,
          price,
          type,
          category_id,
          paused,
          out_of_stock,
          options_schema,
          allergens,
          calories
        )
        VALUES
          (
            $1,
            'DRINK A',
            3,
            'drink',
            $2,
            false,
            false,
            '{"modifiers":[],"extras":[]}'::jsonb,
            'None',
            0
          ),
          (
            $1,
            'DESSERT A',
            6,
            'dessert',
            $3,
            false,
            false,
            '{"modifiers":[],"extras":[]}'::jsonb,
            'None',
            0
          ),
          (
            $4,
            'DRINK B',
            4,
            'drink',
            $5,
            false,
            false,
            '{"modifiers":[],"extras":[]}'::jsonb,
            'None',
            0
          )
        RETURNING id, restaurant_id, type
        `,
        [
          restaurantA,
          cid(restaurantA, "drinks"),
          cid(restaurantA, "desserts"),
          restaurantB,
          cid(restaurantB, "drinks"),
        ]
      );

      drinkA = Number(
        items.rows.find(
          (row) =>
            Number(row.restaurant_id) === restaurantA &&
            row.type === "drink"
        ).id
      );

      dessertA = Number(
        items.rows.find(
          (row) =>
            Number(row.restaurant_id) === restaurantA &&
            row.type === "dessert"
        ).id
      );

      drinkB = Number(
        items.rows.find(
          (row) =>
            Number(row.restaurant_id) === restaurantB
        ).id
      );

      process.env.MAKS_RUNTIME_ROLE =
        "cloud";

      await t.test(
        "meal availability emits authoritative snapshot",
        async () => {
          const response =
            await authed(
              app,
              "patch",
              "/orders/availability",
              restaurantA
            ).send({
              item_id: mealA,
              item_type: "meals",
              out_of_stock: true,
            });

          assert.equal(
            response.status,
            200,
            JSON.stringify(response.body)
          );

          assert.equal(
            await revisionOf(pool, restaurantA),
            1
          );

          const payload =
            await latestPayload(
              pool,
              restaurantA
            );

          const row =
            payload.catalog.meals.find(
              (item) =>
                Number(item.id) === mealA
            );

          assert.equal(
            row.out_of_stock,
            true
          );

          console.log(
            "✅ 01 Meal availability snapshot proven"
          );
        }
      );

      await t.test(
        "same-state click creates no fake revision",
        async () => {
          const before =
            await revisionOf(pool, restaurantA);
          const beforeOutbox =
            await outboxCount(pool, restaurantA);

          const response =
            await authed(
              app,
              "patch",
              "/orders/availability",
              restaurantA
            ).send({
              item_id: mealA,
              item_type: "meals",
              out_of_stock: true,
            });

          assert.equal(response.status, 200);
          assert.equal(
            await revisionOf(pool, restaurantA),
            before
          );
          assert.equal(
            await outboxCount(pool, restaurantA),
            beforeOutbox
          );

          console.log(
            "✅ 02 Same-state click has no fake revision"
          );
        }
      );

      await t.test(
        "drink and dessert emit final catalogue state",
        async () => {
          const drink =
            await authed(
              app,
              "patch",
              "/orders/availability",
              restaurantA
            ).send({
              item_id: drinkA,
              item_type: "drinks",
              out_of_stock: true,
            });

          assert.equal(drink.status, 200);

          const dessert =
            await authed(
              app,
              "patch",
              "/orders/availability",
              restaurantA
            ).send({
              item_id: dessertA,
              item_type: "desserts",
              out_of_stock: true,
            });

          assert.equal(dessert.status, 200);

          assert.equal(
            await revisionOf(pool, restaurantA),
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
                Number(item.id) === dessertA
            );

          assert.equal(
            row.out_of_stock,
            true
          );

          console.log(
            "✅ 03 Drink + dessert final snapshot proven"
          );
        }
      );

      await t.test(
        "cross-tenant availability is blocked",
        async () => {
          const beforeA =
            await revisionOf(pool, restaurantA);
          const beforeB =
            await revisionOf(pool, restaurantB);

          const response =
            await authed(
              app,
              "patch",
              "/orders/availability",
              restaurantA
            ).send({
              item_id: drinkB,
              item_type: "drinks",
              out_of_stock: true,
            });

          assert.equal(response.status, 404);
          assert.equal(
            await revisionOf(pool, restaurantA),
            beforeA
          );
          assert.equal(
            await revisionOf(pool, restaurantB),
            beforeB
          );

          const row = await pool.query(
            `
            SELECT out_of_stock
            FROM public.menu_items
            WHERE restaurant_id = $1
              AND id = $2
            `,
            [restaurantB, drinkB]
          );

          assert.equal(
            row.rows[0].out_of_stock,
            false
          );

          console.log(
            "✅ 04 Cross-tenant availability blocked"
          );
        }
      );

      await t.test(
        "forced outbox failure rolls availability back",
        async () => {
          const beforeRevision =
            await revisionOf(pool, restaurantA);
          const beforeOutbox =
            await outboxCount(pool, restaurantA);

          await removeFailureTrigger(pool);

          await pool.query(`
            CREATE FUNCTION
              public.maks_test_reject_pos_availability_catalog()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              IF NEW.event_type =
                'menu.catalog.replaced.v1'
              THEN
                RAISE EXCEPTION
                  'MAKS_TEST_FORCED_POS_AVAILABILITY_OUTBOX_FAILURE';
              END IF;
              RETURN NEW;
            END;
            $$
          `);

          await pool.query(`
            CREATE TRIGGER
              trg_maks_test_reject_pos_availability_catalog
            BEFORE INSERT
            ON public.edge_outbox
            FOR EACH ROW
            EXECUTE FUNCTION
              public.maks_test_reject_pos_availability_catalog()
          `);

          try {
            const response =
              await authed(
                app,
                "patch",
                "/orders/availability",
                restaurantA
              ).send({
                item_id: mealA,
                item_type: "meals",
                out_of_stock: false,
              });

            assert.equal(
              response.status,
              500
            );
          } finally {
            await removeFailureTrigger(pool);
          }

          const row = await pool.query(
            `
            SELECT out_of_stock
            FROM public.meals
            WHERE restaurant_id = $1
              AND id = $2
            `,
            [restaurantA, mealA]
          );

          assert.equal(
            row.rows[0].out_of_stock,
            true
          );
          assert.equal(
            await revisionOf(pool, restaurantA),
            beforeRevision
          );
          assert.equal(
            await outboxCount(pool, restaurantA),
            beforeOutbox
          );

          console.log(
            "✅ 05 Forced outbox failure rolls mutation + revision back"
          );
        }
      );

      await t.test(
        "Edge and missing runtime role fail closed",
        async () => {
          const before =
            await revisionOf(pool, restaurantA);

          process.env.MAKS_RUNTIME_ROLE =
            "edge";

          const edge =
            await authed(
              app,
              "patch",
              "/orders/availability",
              restaurantA
            ).send({
              item_id: mealA,
              item_type: "meals",
              out_of_stock: false,
            });

          assert.equal(edge.status, 409);

          delete process.env.MAKS_RUNTIME_ROLE;

          const missing =
            await authed(
              app,
              "patch",
              "/orders/availability",
              restaurantA
            ).send({
              item_id: mealA,
              item_type: "meals",
              out_of_stock: false,
            });

          assert.equal(missing.status, 503);
          assert.equal(
            await revisionOf(pool, restaurantA),
            before
          );

          process.env.MAKS_RUNTIME_ROLE =
            "cloud";

          console.log(
            "✅ 06 Edge/missing role fails closed"
          );
        }
      );

      await t.test(
        "direct options endpoint requires auth and tenant scope",
        async () => {
          const unauth =
            await request(app).get(
              `/menu-items/${drinkA}/options`
            );

          assert.equal(unauth.status, 401);

          const own =
            await authed(
              app,
              "get",
              `/menu-items/${drinkA}/options`,
              restaurantA
            );

          assert.equal(
            own.status,
            404,
            "out-of-stock drink must remain unavailable"
          );

          const ownAvailable =
            await authed(
              app,
              "get",
              `/menu-items/${drinkB}/options`,
              restaurantB
            );

          assert.equal(ownAvailable.status, 200);

          const crossTenant =
            await authed(
              app,
              "get",
              `/menu-items/${drinkB}/options`,
              restaurantA
            );

          assert.equal(crossTenant.status, 404);

          console.log(
            "✅ 07 Options endpoint auth + tenant isolation proven"
          );
        }
      );

      await t.test(
        "Restaurant B remains independently authoritative",
        async () => {
          const beforeA =
            await revisionOf(pool, restaurantA);
          const beforeB =
            await revisionOf(pool, restaurantB);

          const response =
            await authed(
              app,
              "patch",
              "/orders/availability",
              restaurantB
            ).send({
              item_id: mealB,
              item_type: "meals",
              out_of_stock: true,
            });

          assert.equal(response.status, 200);
          assert.equal(
            await revisionOf(pool, restaurantB),
            beforeB + 1
          );
          assert.equal(
            await revisionOf(pool, restaurantA),
            beforeA
          );

          console.log(
            "✅ 08 Restaurant B authority preserved"
          );
        }
      );

      console.log(
        "============================================"
      );
      console.log(
        "✅ MAKS FINAL MENU BYPASS ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );
    } finally {
      process.env.MAKS_RUNTIME_ROLE =
        "cloud";

      await removeFailureTrigger(pool);
      await resetTestData();

      if (originalRuntimeRole === undefined) {
        delete process.env.MAKS_RUNTIME_ROLE;
      } else {
        process.env.MAKS_RUNTIME_ROLE =
          originalRuntimeRole;
      }

      await pool.end();
      console.log("✅ Cleanup proven");
    }
  }
);
