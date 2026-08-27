"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");

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
  () =>
    (req, res, next) =>
      next();

const uploadModule =
  require("../../utils/uploads");

let uploadCalls = 0;

uploadModule.uploadMenuItemImage.single =
  () =>
    (req, res, next) => {
      uploadCalls += 1;

      req.file = {
        filename:
          `attack-${uploadCalls}.jpg`,
        path:
          `/tmp/maks-nonexistent-attack-${uploadCalls}.jpg`,
      };

      next();
    };

delete require.cache[
  require.resolve(
    "../../routes/itemsSettingsRoutes"
  )
];

delete require.cache[
  require.resolve(
    "../../routes/itemImageRoutes"
  )
];

const itemsSettingsRoutes =
  require("../../routes/itemsSettingsRoutes");

const itemImageRoutes =
  require("../../routes/itemImageRoutes");

const {
  resetTestData,
} = require("../setup/resetTestData");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

const db =
  require("../../dbCompat");

const MENU_EVENT =
  "menu.catalog.replaced.v1";

const MENU_DOMAIN =
  "menu.catalog";

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;

function makeApp() {
  const app =
    express();

  app.use(
    express.json()
  );

  app.use(
    (req, res, next) => {
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
        authority:
          "owner",
        permissions:
          ["*"],
      };

      req.kind =
        "pg";

      req.qGet =
        db.qGet;

      req.qRun =
        db.qRun;

      req.qAll =
        db.qAll;

      next();
    }
  );

  app.use(
    "/items-settings",
    itemsSettingsRoutes
  );

  app.use(
    "/item-images",
    itemImageRoutes
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

  return result
    .rows[0]
    .payload;
}

async function removeFailureTrigger(
  pool
) {
  await pool.query(`
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_item_settings_image_catalog
    ON
      public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_item_settings_image_catalog()
  `);
}

test(
  "MAKS item settings + image metadata Cloud authority attack",
  {
    timeout:
      60000,
  },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();

    const pool =
      db.getPool();

    const app =
      makeApp();

    let restaurantA;
    let restaurantB;

    let categoryMealA;
    let categoryDrinkA;
    let categoryDessertA;

    let categoryMealB;

    let mealA;
    let drinkA;
    let dessertA;
    let mealB;

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
            "ITEM SETTINGS ATTACK A",
            "ITEM SETTINGS ATTACK B",
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

      const categories =
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
              'ATTACK MEALS A',
              'meals',
              '🍽️'
            ),
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
              'ATTACK MEALS B',
              'meals',
              '🍽️'
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

      const cat =
        (rid, type) =>
          Number(
            categories
              .rows
              .find(
                (row) =>
                  Number(
                    row.restaurant_id
                  ) === rid &&
                  row.type ===
                    type
              )
              .id
          );

      categoryMealA =
        cat(
          restaurantA,
          "meals"
        );

      categoryDrinkA =
        cat(
          restaurantA,
          "drinks"
        );

      categoryDessertA =
        cat(
          restaurantA,
          "desserts"
        );

      categoryMealB =
        cat(
          restaurantB,
          "meals"
        );

      const meals =
        await pool.query(
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
            options_schema
          )
          VALUES
            (
              $1,
              'ATTACK MEAL A',
              '[]'::jsonb,
              'None',
              0,
              10,
              'ATTACK MEALS A',
              $2,
              false,
              '[]'::jsonb
            ),
            (
              $3,
              'ATTACK MEAL B',
              '[]'::jsonb,
              'None',
              0,
              11,
              'ATTACK MEALS B',
              $4,
              false,
              '[]'::jsonb
            )
          RETURNING
            id,
            restaurant_id
          `,
          [
            restaurantA,
            categoryMealA,
            restaurantB,
            categoryMealB,
          ]
        );

      mealA =
        Number(
          meals.rows.find(
            (row) =>
              Number(
                row.restaurant_id
              ) ===
              restaurantA
          ).id
        );

      mealB =
        Number(
          meals.rows.find(
            (row) =>
              Number(
                row.restaurant_id
              ) ===
              restaurantB
          ).id
        );

      const items =
        await pool.query(
          `
          INSERT INTO
            public.menu_items
          (
            restaurant_id,
            name,
            price,
            type,
            category_id,
            options_schema,
            allergens,
            calories
          )
          VALUES
            (
              $1,
              'ATTACK DRINK A',
              3,
              'drink',
              $2,
              '[]'::jsonb,
              'None',
              0
            ),
            (
              $1,
              'ATTACK DESSERT A',
              6,
              'dessert',
              $3,
              '[]'::jsonb,
              'None',
              0
            )
          RETURNING
            id,
            type
          `,
          [
            restaurantA,
            categoryDrinkA,
            categoryDessertA,
          ]
        );

      drinkA =
        Number(
          items.rows.find(
            (row) =>
              row.type ===
              "drink"
          ).id
        );

      dessertA =
        Number(
          items.rows.find(
            (row) =>
              row.type ===
              "dessert"
          ).id
        );

      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

      await t.test(
        "meal settings emit one authoritative snapshot",
        async () => {
          const response =
            await call(
              app,
              "put",
              `/items-settings/meal/${mealA}`,
              restaurantA
            ).send({
              availability_mode:
                "manual",
              manual_quantity:
                7,
              manually_stopped:
                false,
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
                Number(
                  item.id
                ) ===
                mealA
            );

          assert.equal(
            row.availability_mode,
            "manual"
          );

          assert.equal(
            Number(
              row.manual_quantity
            ),
            7
          );

          console.log(
            "✅ 01 Meal availability settings snapshot proven"
          );
        }
      );

      await t.test(
        "drink settings emit final menu-item state",
        async () => {
          const response =
            await call(
              app,
              "put",
              `/items-settings/drink/${drinkA}`,
              restaurantA
            ).send({
              availability_mode:
                "unlimited",
              manually_stopped:
                true,
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
            2
          );

          const payload =
            await latestPayload(
              pool,
              restaurantA
            );

          const row =
            payload.catalog.menu_items.find(
              (item) =>
                Number(
                  item.id
                ) ===
                drinkA
            );

          assert.equal(
            row.availability_mode,
            "unlimited"
          );

          assert.equal(
            row.manually_stopped,
            true
          );

          assert.equal(
            row.out_of_stock,
            true
          );

          console.log(
            "✅ 02 Drink settings final snapshot proven"
          );
        }
      );

      await t.test(
        "cross-tenant settings update creates no fake revision",
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
              "put",
              `/items-settings/meal/${mealB}`,
              restaurantA
            ).send({
              availability_mode:
                "manual",
              manual_quantity:
                99,
              manually_stopped:
                true,
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
            beforeA
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantB
            ),
            beforeB
          );

          const row =
            await pool.query(
              `
              SELECT
                availability_mode,
                manual_quantity,
                manually_stopped
              FROM public.meals
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantB,
                mealB,
              ]
            );

          assert.notEqual(
            Number(
              row.rows[0]
                .manual_quantity ||
              0
            ),
            99
          );

          console.log(
            "✅ 03 Cross-tenant settings mutation blocked"
          );
        }
      );

      await t.test(
        "forced outbox failure rolls settings mutation back",
        async () => {
          const beforeRow =
            await pool.query(
              `
              SELECT
                availability_mode,
                manual_quantity,
                manually_stopped,
                out_of_stock
              FROM public.menu_items
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                dessertA,
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
              public.maks_test_reject_item_settings_image_catalog()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              IF NEW.event_type =
                'menu.catalog.replaced.v1'
              THEN
                RAISE EXCEPTION
                  'MAKS_TEST_FORCED_ITEM_SETTINGS_IMAGE_OUTBOX_FAILURE';
              END IF;

              RETURN NEW;
            END;
            $$
          `);

          await pool.query(`
            CREATE TRIGGER
              trg_maks_test_reject_item_settings_image_catalog
            BEFORE INSERT
            ON public.edge_outbox
            FOR EACH ROW
            EXECUTE FUNCTION
              public.maks_test_reject_item_settings_image_catalog()
          `);

          try {
            const response =
              await call(
                app,
                "put",
                `/items-settings/dessert/${dessertA}`,
                restaurantA
              ).send({
                availability_mode:
                  "manual",
                manual_quantity:
                  55,
                manually_stopped:
                  true,
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

          const afterRow =
            await pool.query(
              `
              SELECT
                availability_mode,
                manual_quantity,
                manually_stopped,
                out_of_stock
              FROM public.menu_items
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                dessertA,
              ]
            );

          assert.deepEqual(
            afterRow.rows[0],
            beforeRow.rows[0]
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
            "✅ 04 Settings + revision rollback proven"
          );
        }
      );

      await t.test(
        "meal image metadata emits catalogue snapshot",
        async () => {
          const beforeUploads =
            uploadCalls;

          const response =
            await call(
              app,
              "post",
              `/item-images/meal/${mealA}/image`,
              restaurantA
            );

          assert.equal(
            response.status,
            200,
            JSON.stringify(
              response.body
            )
          );

          assert.equal(
            uploadCalls,
            beforeUploads + 1
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
            payload.catalog.meals.find(
              (item) =>
                Number(
                  item.id
                ) ===
                mealA
            );

          assert.equal(
            row.photo_url,
            response.body
              .photo_url
          );

          console.log(
            "✅ 05 Meal image metadata snapshot proven"
          );
        }
      );

      await t.test(
        "drink image metadata emits menu-item snapshot",
        async () => {
          const response =
            await call(
              app,
              "post",
              `/item-images/drink/${drinkA}/image`,
              restaurantA
            );

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
            4
          );

          const payload =
            await latestPayload(
              pool,
              restaurantA
            );

          const row =
            payload.catalog.menu_items.find(
              (item) =>
                Number(
                  item.id
                ) ===
                drinkA
            );

          assert.equal(
            row.photo_url,
            response.body
              .photo_url
          );

          console.log(
            "✅ 06 Drink image metadata snapshot proven"
          );
        }
      );

      await t.test(
        "cross-tenant image target is blocked before upload",
        async () => {
          const beforeUploads =
            uploadCalls;

          const beforeRevision =
            await revisionOf(
              pool,
              restaurantA
            );

          const response =
            await call(
              app,
              "post",
              `/item-images/meal/${mealB}/image`,
              restaurantA
            );

          assert.equal(
            response.status,
            404
          );

          assert.equal(
            uploadCalls,
            beforeUploads
          );

          assert.equal(
            await revisionOf(
              pool,
              restaurantA
            ),
            beforeRevision
          );

          console.log(
            "✅ 07 Cross-tenant image rejected before file write"
          );
        }
      );

      await t.test(
        "forced image event failure rolls photo_url and revision back",
        async () => {
          const before =
            await pool.query(
              `
              SELECT photo_url
              FROM public.menu_items
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                dessertA,
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

          await pool.query(`
            CREATE FUNCTION
              public.maks_test_reject_item_settings_image_catalog()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              IF NEW.event_type =
                'menu.catalog.replaced.v1'
              THEN
                RAISE EXCEPTION
                  'MAKS_TEST_FORCED_ITEM_SETTINGS_IMAGE_OUTBOX_FAILURE';
              END IF;

              RETURN NEW;
            END;
            $$
          `);

          await pool.query(`
            CREATE TRIGGER
              trg_maks_test_reject_item_settings_image_catalog
            BEFORE INSERT
            ON public.edge_outbox
            FOR EACH ROW
            EXECUTE FUNCTION
              public.maks_test_reject_item_settings_image_catalog()
          `);

          try {
            const response =
              await call(
                app,
                "post",
                `/item-images/dessert/${dessertA}/image`,
                restaurantA
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

          const after =
            await pool.query(
              `
              SELECT photo_url
              FROM public.menu_items
              WHERE restaurant_id = $1
                AND id = $2
              `,
              [
                restaurantA,
                dessertA,
              ]
            );

          assert.deepEqual(
            after.rows[0],
            before.rows[0]
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
            "✅ 08 Image metadata + revision rollback proven"
          );
        }
      );

      await t.test(
        "Edge runtime blocks settings and image before upload",
        async () => {
          const beforeUploads =
            uploadCalls;

          const beforeRevision =
            await revisionOf(
              pool,
              restaurantA
            );

          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";

          const settings =
            await call(
              app,
              "put",
              `/items-settings/meal/${mealA}`,
              restaurantA
            ).send({
              availability_mode:
                "manual",
              manual_quantity:
                3,
              manually_stopped:
                false,
            });

          const image =
            await call(
              app,
              "post",
              `/item-images/meal/${mealA}/image`,
              restaurantA
            );

          assert.equal(
            settings.status,
            409
          );

          assert.equal(
            image.status,
            409
          );

          assert.equal(
            uploadCalls,
            beforeUploads
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
            "✅ 09 Edge settings/image authoring fails closed before upload"
          );
        }
      );

      await t.test(
        "missing runtime role fails closed before upload",
        async () => {
          const beforeUploads =
            uploadCalls;

          const beforeRevision =
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
              `/item-images/meal/${mealA}/image`,
              restaurantA
            );

          assert.equal(
            response.status,
            503
          );

          assert.equal(
            uploadCalls,
            beforeUploads
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
            "✅ 10 Missing role fails closed before file write"
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
              "put",
              `/items-settings/meal/${mealB}`,
              restaurantB
            ).send({
              availability_mode:
                "manual",
              manual_quantity:
                12,
              manually_stopped:
                false,
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
            "✅ 11 Restaurant B authority preserved"
          );
        }
      );

      console.log(
        "============================================"
      );

      console.log(
        "✅ MAKS ITEM SETTINGS + IMAGE METADATA CLOUD AUTHORITY ATTACK COMPLETE"
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
