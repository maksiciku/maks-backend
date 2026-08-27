"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");

const { resetTestData } = require("../setup/resetTestData");
const { seedTestData } = require("../setup/seedTestData");
const { assertTestDatabase } = require("../safety/assertTestDatabase");
const { getPool } = require("../../dbCompat");
const { PERMISSIONS } = require("../../middleware/accessControl");

const originalRuntimeRole = process.env.MAKS_RUNTIME_ROLE;
process.env.MAKS_RUNTIME_ROLE = "cloud";

const mealsRoutes = require("../../routes/meals");

const MENU_EVENT = "menu.catalog.replaced.v1";
const MENU_DOMAIN = "menu.catalog";

function qMarkToDollar(sql) {
  const source = String(sql);
  let index = 0;
  let out = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }

    if (ch === "?" && !inSingle && !inDouble) {
      index += 1;
      out += `$${index}`;
      continue;
    }

    out += ch;
  }

  return out;
}

function createApp(pool, fixtures) {
  const app = express();
  const allPermissions = Object.values(PERMISSIONS)
    .filter((value) => typeof value === "string");

  app.use(express.json({ limit: "2mb" }));

  app.use((req, _res, next) => {
    const rid = Number(req.get("x-test-restaurant-id") || 0);
    const ownerId =
      rid === Number(fixtures.restaurantB)
        ? Number(fixtures.ownerB)
        : Number(fixtures.ownerA);

    req.tenantRid = rid;
    req.kind = "pg";

    req.user = {
      id: ownerId,
      restaurant_id: rid,
      authority: "owner",
      role: "owner",
      permissions: allPermissions,
    };

    req.membership = {
      restaurant_id: rid,
      authority: "owner",
      permissions: allPermissions,
    };

    req.qAll = async (sql, params = []) =>
      (await pool.query(qMarkToDollar(sql), params)).rows || [];

    req.qGet = async (sql, params = []) =>
      (await pool.query(qMarkToDollar(sql), params)).rows?.[0] || null;

    req.qRun = async (sql, params = []) => {
      const result = await pool.query(qMarkToDollar(sql), params);
      return {
        changes: result.rowCount || 0,
        lastID: result.rows?.[0]?.id,
      };
    };

    req.db = {
      kind: "pg",
      qAll: req.qAll,
      qGet: req.qGet,
      qRun: req.qRun,
    };

    next();
  });

  app.use("/meals", mealsRoutes);
  return app;
}

async function revisionFor(pool, restaurantId) {
  const result = await pool.query(
    `
    SELECT produced_revision
    FROM public.edge_domain_revisions
    WHERE restaurant_id = $1
      AND domain = $2
    `,
    [restaurantId, MENU_DOMAIN]
  );

  return Number(result.rows?.[0]?.produced_revision || 0);
}

async function outboxRows(pool, restaurantId) {
  const result = await pool.query(
    `
    SELECT event_id, event_type, payload
    FROM public.edge_outbox
    WHERE restaurant_id = $1
      AND event_type = $2
    ORDER BY created_at ASC, event_id ASC
    `,
    [restaurantId, MENU_EVENT]
  );

  return result.rows || [];
}

async function installOutboxFailure(pool) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION
      public.maks_test_reject_meal_menu_catalog_outbox()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.event_type = 'menu.catalog.replaced.v1' THEN
        RAISE EXCEPTION
          'MAKS_TEST_FORCED_MEAL_MENU_CATALOG_OUTBOX_FAILURE';
      END IF;

      RETURN NEW;
    END;
    $$
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_meal_menu_catalog_outbox
    ON public.edge_outbox
  `);

  await pool.query(`
    CREATE TRIGGER
      trg_maks_test_reject_meal_menu_catalog_outbox
    BEFORE INSERT
    ON public.edge_outbox
    FOR EACH ROW
    EXECUTE FUNCTION
      public.maks_test_reject_meal_menu_catalog_outbox()
  `);
}

async function removeOutboxFailure(pool) {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_meal_menu_catalog_outbox
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_meal_menu_catalog_outbox()
  `);
}

test(
  "MAKS meal writer Cloud authority attack",
  { timeout: 90000 },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();
    const fixtures = await seedTestData();

    const pool = getPool();
    const app = createApp(pool, fixtures);

    const restaurantA = Number(fixtures.restaurantA);
    const restaurantB = Number(fixtures.restaurantB);
    const mealB = Number(fixtures.mealB);
    const mealCategoryResult = await pool.query(
      `
      INSERT INTO public.categories
        (restaurant_id, name, type, icon)
      VALUES
        ($1, $2, 'meals', '🍽️')
      RETURNING id
      `,
      [
        restaurantA,
        "EDGE MEAL WRITER CATEGORY",
      ]
    );

    const categoryA = Number(
      mealCategoryResult.rows[0].id
    );

    const ingredientResult = await pool.query(
      `
      SELECT
        NULLIF(
          TRIM(ingredient),
          ''
        ) AS ingredient_name
      FROM public.stock
      WHERE restaurant_id = $1
      ORDER BY id ASC
      LIMIT 1
      `,
      [restaurantA]
    );

    const stockIngredient = String(
      ingredientResult.rows?.[0]?.ingredient_name || ""
    ).trim();

    assert.ok(stockIngredient, "Seeded stock ingredient is required");

    let createdMealId = null;

    try {
      console.log("✅ 01 Real meal route harness prepared against maks_test");

      await t.test(
        "Cloud create commits final nutrition row revision and snapshot atomically",
        async () => {
          process.env.MAKS_RUNTIME_ROLE = "cloud";

          const response = await request(app)
            .post("/meals")
            .set("x-test-restaurant-id", String(restaurantA))
            .send({
              name: "EDGE CLOUD MEAL CREATE",
              price: 14.25,
              vat_rate: 20,
              category_id: categoryA,
              paused: false,
              options_schema: [],
              availability_mode: "manual",
              manual_quantity: 6,
              manually_stopped: false,
              ingredients: [
                {
                  name: stockIngredient,
                  amount: 100,
                  unit: "g",
                },
              ],
            });

          assert.equal(response.status, 201, JSON.stringify(response.body));

          createdMealId = Number(response.body.meal_id);
          assert.ok(createdMealId > 0);

          const row = await pool.query(
            `
            SELECT
              restaurant_id,
              name,
              price,
              vat_rate,
              category_id,
              allergens,
              calories,
              availability_mode,
              manual_quantity,
              manually_stopped
            FROM public.meals
            WHERE id = $1
            `,
            [createdMealId]
          );

          assert.equal(row.rows.length, 1);
          assert.equal(Number(row.rows[0].restaurant_id), restaurantA);
          assert.equal(row.rows[0].name, "EDGE CLOUD MEAL CREATE");
          assert.equal(Number(row.rows[0].price), 14.25);
          assert.equal(row.rows[0].availability_mode, "manual");
          assert.equal(Number(row.rows[0].manual_quantity), 6);

          assert.equal(await revisionFor(pool, restaurantA), 1);

          const events = await outboxRows(pool, restaurantA);
          assert.equal(events.length, 1);

          const snapshotMeal = events[0].payload.catalog.meals.find(
            (meal) => Number(meal.id) === createdMealId
          );

          assert.ok(snapshotMeal);
          assert.equal(snapshotMeal.name, "EDGE CLOUD MEAL CREATE");
          assert.equal(Number(snapshotMeal.price), 14.25);
          assert.equal(snapshotMeal.availability_mode, "manual");
          assert.equal(Number(snapshotMeal.manual_quantity), 6);

          console.log(
            "✅ 02 Cloud create + final nutrition + revision 1 snapshot proven"
          );
        }
      );

      await t.test(
        "Restaurant A cannot update Restaurant B meal or advance A revision",
        async () => {
          const before = await pool.query(
            `
            SELECT price
            FROM public.meals
            WHERE id = $1
              AND restaurant_id = $2
            `,
            [mealB, restaurantB]
          );

          assert.equal(before.rows.length, 1);

          const response = await request(app)
            .put(`/meals/${mealB}`)
            .set("x-test-restaurant-id", String(restaurantA))
            .send({ price: 999.99 });

          assert.equal(response.status, 404);

          const after = await pool.query(
            `
            SELECT price
            FROM public.meals
            WHERE id = $1
              AND restaurant_id = $2
            `,
            [mealB, restaurantB]
          );

          assert.equal(
            Number(after.rows[0].price),
            Number(before.rows[0].price)
          );

          assert.equal(await revisionFor(pool, restaurantA), 1);

          console.log(
            "✅ 03 Cross-tenant meal update blocked without fake revision"
          );
        }
      );

      await t.test(
        "Cloud update emits the final sell-critical row exactly once",
        async () => {
          const optionSchema = [
            {
              id: "size",
              label: "Size",
              type: "single",
              required: false,
              choices: [
                {
                  id: "large",
                  label: "Large",
                  priceDelta: 1.5,
                },
              ],
            },
          ];

          const response = await request(app)
            .put(`/meals/${createdMealId}`)
            .set("x-test-restaurant-id", String(restaurantA))
            .send({
              name: "EDGE CLOUD MEAL UPDATED",
              price: 16.5,
              vat_rate: 5,
              paused: true,
              photo_url: "/uploads/test/edge-cloud-meal.jpg",
              options_schema: optionSchema,
              availability_mode: "manual",
              manual_quantity: 3,
              manually_stopped: false,
            });

          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.meal.name, "EDGE CLOUD MEAL UPDATED");
          assert.equal(Number(response.body.meal.price), 16.5);
          assert.deepEqual(response.body.meal.options_schema, optionSchema);

          assert.equal(await revisionFor(pool, restaurantA), 2);

          const events = await outboxRows(pool, restaurantA);
          assert.equal(events.length, 2);

          const snapshotMeal = events[1].payload.catalog.meals.find(
            (meal) => Number(meal.id) === createdMealId
          );

          assert.ok(snapshotMeal);
          assert.equal(snapshotMeal.name, "EDGE CLOUD MEAL UPDATED");
          assert.equal(Number(snapshotMeal.price), 16.5);
          assert.equal(Number(snapshotMeal.vat_rate), 5);
          assert.equal(snapshotMeal.paused, true);
          assert.equal(
            snapshotMeal.photo_url,
            "/uploads/test/edge-cloud-meal.jpg"
          );
          assert.deepEqual(snapshotMeal.options_schema, optionSchema);
          assert.equal(Number(snapshotMeal.manual_quantity), 3);

          console.log(
            "✅ 04 Cloud update + final price/options/availability snapshot proven"
          );
        }
      );

      await t.test(
        "forced outbox failure rolls meal update and revision back together",
        async () => {
          await installOutboxFailure(pool);

          try {
            const response = await request(app)
              .put(`/meals/${createdMealId}`)
              .set("x-test-restaurant-id", String(restaurantA))
              .send({ price: 99.99 });

            assert.equal(response.status, 500);

            const row = await pool.query(
              `
              SELECT price
              FROM public.meals
              WHERE id = $1
                AND restaurant_id = $2
              `,
              [createdMealId, restaurantA]
            );

            assert.equal(Number(row.rows[0].price), 16.5);
            assert.equal(await revisionFor(pool, restaurantA), 2);
            assert.equal((await outboxRows(pool, restaurantA)).length, 2);
          } finally {
            await removeOutboxFailure(pool);
          }

          console.log(
            "✅ 05 Forced event failure rolls meal + revision + outbox back"
          );
        }
      );

      await t.test(
        "Edge runtime rejects meal authoring before mutation",
        async () => {
          process.env.MAKS_RUNTIME_ROLE = "edge";

          const update = await request(app)
            .put(`/meals/${createdMealId}`)
            .set("x-test-restaurant-id", String(restaurantA))
            .send({ price: 77.77 });

          assert.equal(update.status, 409);
          assert.equal(
            update.body.code,
            "MENU_CATALOG_CLOUD_AUTHORITY_REQUIRED"
          );

          const deletion = await request(app)
            .delete(`/meals/${createdMealId}`)
            .set("x-test-restaurant-id", String(restaurantA));

          assert.equal(deletion.status, 409);

          const row = await pool.query(
            `
            SELECT price
            FROM public.meals
            WHERE id = $1
              AND restaurant_id = $2
            `,
            [createdMealId, restaurantA]
          );

          assert.equal(row.rows.length, 1);
          assert.equal(Number(row.rows[0].price), 16.5);
          assert.equal(await revisionFor(pool, restaurantA), 2);

          console.log("✅ 06 Edge runtime meal authoring fails closed");
        }
      );

      await t.test(
        "missing runtime role fails closed before meal create",
        async () => {
          delete process.env.MAKS_RUNTIME_ROLE;

          const response = await request(app)
            .post("/meals")
            .set("x-test-restaurant-id", String(restaurantA))
            .send({
              name: "MISSING ROLE MEAL",
              price: 10,
              category_id: categoryA,
              ingredients: [
                {
                  name: stockIngredient,
                  amount: 50,
                  unit: "g",
                },
              ],
            });

          assert.equal(response.status, 503);
          assert.equal(
            response.body.code,
            "MENU_CATALOG_RUNTIME_ROLE_UNAVAILABLE"
          );

          const row = await pool.query(
            `
            SELECT id
            FROM public.meals
            WHERE restaurant_id = $1
              AND name = $2
            `,
            [restaurantA, "MISSING ROLE MEAL"]
          );

          assert.equal(row.rows.length, 0);
          assert.equal(await revisionFor(pool, restaurantA), 2);

          process.env.MAKS_RUNTIME_ROLE = "cloud";

          console.log("✅ 07 Missing runtime role fails closed");
        }
      );

      await t.test(
        "Cloud delete commits deletion and authoritative snapshot together",
        async () => {
          process.env.MAKS_RUNTIME_ROLE = "cloud";

          const response = await request(app)
            .delete(`/meals/${createdMealId}`)
            .set("x-test-restaurant-id", String(restaurantA));

          assert.equal(response.status, 200);
          assert.deepEqual(response.body, { success: true });

          const row = await pool.query(
            `
            SELECT id
            FROM public.meals
            WHERE id = $1
              AND restaurant_id = $2
            `,
            [createdMealId, restaurantA]
          );

          assert.equal(row.rows.length, 0);
          assert.equal(await revisionFor(pool, restaurantA), 3);

          const events = await outboxRows(pool, restaurantA);
          assert.equal(events.length, 3);
          assert.equal(
            events[2].payload.catalog.meals.some(
              (meal) => Number(meal.id) === createdMealId
            ),
            false
          );

          console.log(
            "✅ 08 Cloud delete + revision 3 + authoritative removal proven"
          );
        }
      );

      await t.test(
        "Restaurant B retains independent Cloud meal authority",
        async () => {
          const response = await request(app)
            .put(`/meals/${mealB}`)
            .set("x-test-restaurant-id", String(restaurantB))
            .send({ price: 21.5 });

          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(Number(response.body.meal.price), 21.5);
          assert.equal(await revisionFor(pool, restaurantB), 1);
          assert.equal(await revisionFor(pool, restaurantA), 3);

          console.log(
            "✅ 09 Independent Restaurant B meal authority preserved"
          );
        }
      );

      console.log("============================================");
      console.log("✅ MAKS MEAL WRITER CLOUD AUTHORITY ATTACK COMPLETE");
      console.log("============================================");
    } finally {
      await removeOutboxFailure(pool).catch(() => {});

      process.env.MAKS_RUNTIME_ROLE = "cloud";
      await resetTestData();

      if (originalRuntimeRole === undefined) {
        delete process.env.MAKS_RUNTIME_ROLE;
      } else {
        process.env.MAKS_RUNTIME_ROLE = originalRuntimeRole;
      }

      await pool.end();
      console.log("✅ 10 Cleanup proven");
    }
  }
);
