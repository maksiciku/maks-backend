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

const menuGroupRoutes =
  require("../../routes/menuGroupRoutes");

const MENU_EVENT = "menu.catalog.replaced.v1";
const MENU_DOMAIN = "menu.catalog";

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;

function makeApp() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    req.tenantRid = Number(
      req.get("x-maks-test-rid") || 0
    );
    next();
  });

  app.use("/menu-groups", menuGroupRoutes);
  return app;
}

function call(app, method, path, rid) {
  return request(app)
    [method](path)
    .set("x-maks-test-rid", String(rid));
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
    ? Number(result.rows[0].produced_revision || 0)
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
      trg_maks_test_reject_menu_group_catalog
    ON public.edge_outbox
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_menu_group_catalog()
  `);
}

test(
  "MAKS menu group Cloud authority attack",
  { timeout: 60000 },
  async (t) => {
    await assertTestDatabase();
    await resetTestData();

    const pool = getPool();
    const app = makeApp();

    let restaurantA;
    let restaurantB;
    let categoryA;
    let categoryB;
    let groupA;
    let groupB;
    let scheduleA;

    try {
      await removeFailureTrigger(pool);

      const restaurants = await pool.query(
        `
        INSERT INTO public.restaurants (name)
        VALUES ($1), ($2)
        RETURNING id
        `,
        [
          "MENU GROUP ATTACK A",
          "MENU GROUP ATTACK B",
        ]
      );

      restaurantA = Number(restaurants.rows[0].id);
      restaurantB = Number(restaurants.rows[1].id);

      const categories = await pool.query(
        `
        INSERT INTO public.categories
          (restaurant_id, name, type, icon)
        VALUES
          ($1, 'GROUP CATEGORY A', 'meals', '🍽️'),
          ($2, 'GROUP CATEGORY B', 'meals', '🍽️')
        RETURNING id, restaurant_id
        `,
        [restaurantA, restaurantB]
      );

      categoryA = Number(
        categories.rows.find(
          (row) => Number(row.restaurant_id) === restaurantA
        ).id
      );

      categoryB = Number(
        categories.rows.find(
          (row) => Number(row.restaurant_id) === restaurantB
        ).id
      );

      const bGroup = await pool.query(
        `
        INSERT INTO public.menu_groups
          (restaurant_id, name, base_type)
        VALUES ($1, 'TENANT B GROUP', 'meals')
        RETURNING id
        `,
        [restaurantB]
      );

      groupB = Number(bGroup.rows[0].id);

      process.env.MAKS_RUNTIME_ROLE = "cloud";

      await t.test(
        "Cloud group create emits revision 1",
        async () => {
          const response = await call(
            app,
            "post",
            "/menu-groups",
            restaurantA
          ).send({
            name: "BREAKFAST",
            base_type: "meals",
            sort_order: 1,
            show_pos: true,
            show_qr: true,
            show_kiosk: true,
          });

          assert.equal(
            response.status,
            200,
            JSON.stringify(response.body)
          );

          groupA = Number(response.body.id);
          assert.ok(groupA);

          assert.equal(
            await revisionOf(pool, restaurantA),
            1
          );

          const payload =
            await latestPayload(pool, restaurantA);

          assert.ok(
            payload.catalog.menu_groups.some(
              (row) =>
                Number(row.id) === groupA &&
                row.name === "BREAKFAST"
            )
          );

          console.log(
            "✅ 01 Cloud group create + revision 1 proven"
          );
        }
      );

      await t.test(
        "cross-tenant parent is rejected pre-mutation",
        async () => {
          const before = await pool.query(
            `
            SELECT COUNT(*)::int AS count
            FROM public.menu_groups
            WHERE restaurant_id = $1
            `,
            [restaurantA]
          );

          const response = await call(
            app,
            "post",
            "/menu-groups",
            restaurantA
          ).send({
            name: "ILLEGAL CHILD",
            parent_id: groupB,
          });

          assert.equal(response.status, 404);

          const after = await pool.query(
            `
            SELECT COUNT(*)::int AS count
            FROM public.menu_groups
            WHERE restaurant_id = $1
            `,
            [restaurantA]
          );

          assert.equal(
            Number(after.rows[0].count),
            Number(before.rows[0].count)
          );

          assert.equal(
            await revisionOf(pool, restaurantA),
            1
          );

          console.log(
            "✅ 02 Cross-tenant parent rejected"
          );
        }
      );

      await t.test(
        "schedule create requires same-tenant group",
        async () => {
          const illegal = await call(
            app,
            "post",
            `/menu-groups/${groupB}/schedules`,
            restaurantA
          ).send({
            active_days: ["mon"],
            start_time: "09:00",
            end_time: "12:00",
          });

          assert.equal(illegal.status, 404);
          assert.equal(
            await revisionOf(pool, restaurantA),
            1
          );

          const response = await call(
            app,
            "post",
            `/menu-groups/${groupA}/schedules`,
            restaurantA
          ).send({
            active_days: ["mon", "tue"],
            start_time: "08:00",
            end_time: "11:30",
            priority: 5,
            is_active: true,
          });

          assert.equal(
            response.status,
            200,
            JSON.stringify(response.body)
          );

          scheduleA = Number(response.body.id);

          assert.equal(
            await revisionOf(pool, restaurantA),
            2
          );

          console.log(
            "✅ 03 Same-tenant schedule + revision 2 proven"
          );
        }
      );

      await t.test(
        "category assignment requires same-tenant group and category",
        async () => {
          const badCategory = await call(
            app,
            "post",
            `/menu-groups/${groupA}/categories`,
            restaurantA
          ).send({
            category_id: categoryB,
          });

          assert.equal(badCategory.status, 404);

          const badGroup = await call(
            app,
            "post",
            `/menu-groups/${groupB}/categories`,
            restaurantA
          ).send({
            category_id: categoryA,
          });

          assert.equal(badGroup.status, 404);

          assert.equal(
            await revisionOf(pool, restaurantA),
            2
          );

          const response = await call(
            app,
            "post",
            `/menu-groups/${groupA}/categories`,
            restaurantA
          ).send({
            category_id: categoryA,
            sort_order: 3,
          });

          assert.equal(
            response.status,
            200,
            JSON.stringify(response.body)
          );

          assert.equal(
            await revisionOf(pool, restaurantA),
            3
          );

          const payload =
            await latestPayload(pool, restaurantA);

          assert.ok(
            payload.catalog.menu_group_categories.some(
              (row) =>
                Number(row.menu_group_id) === groupA &&
                Number(row.category_id) === categoryA
            )
          );

          console.log(
            "✅ 04 Same-tenant category assignment proven"
          );
        }
      );

      await t.test(
        "group and schedule updates emit final snapshots",
        async () => {
          const groupUpdate = await call(
            app,
            "put",
            `/menu-groups/${groupA}`,
            restaurantA
          ).send({
            name: "BREAKFAST UPDATED",
            show_pos: true,
            show_qr: false,
            show_kiosk: true,
            active_days: ["wed"],
            start_time: "07:00",
            end_time: "12:00",
            is_active: true,
          });

          assert.equal(
            groupUpdate.status,
            200,
            JSON.stringify(groupUpdate.body)
          );

          assert.equal(
            await revisionOf(pool, restaurantA),
            4
          );

          const scheduleUpdate = await call(
            app,
            "put",
            `/menu-groups/${groupA}/schedules/${scheduleA}`,
            restaurantA
          ).send({
            active_days: ["thu"],
            start_time: "10:00",
            end_time: "14:00",
            priority: 9,
            is_active: true,
          });

          assert.equal(
            scheduleUpdate.status,
            200,
            JSON.stringify(scheduleUpdate.body)
          );

          assert.equal(
            await revisionOf(pool, restaurantA),
            5
          );

          const payload =
            await latestPayload(pool, restaurantA);

          const group =
            payload.catalog.menu_groups.find(
              (row) => Number(row.id) === groupA
            );

          const schedule =
            payload.catalog.menu_group_schedules.find(
              (row) => Number(row.id) === scheduleA
            );

          assert.equal(group.name, "BREAKFAST UPDATED");
          assert.equal(group.show_qr, false);
          assert.equal(schedule.priority, 9);

          console.log(
            "✅ 05 Final group + schedule snapshots proven"
          );
        }
      );

      await t.test(
        "missing/cross-tenant updates create no fake revision",
        async () => {
          const missing = await call(
            app,
            "put",
            "/menu-groups/999999999",
            restaurantA
          ).send({ name: "NOPE" });

          assert.equal(missing.status, 404);

          const cross = await call(
            app,
            "put",
            `/menu-groups/${groupB}`,
            restaurantA
          ).send({ name: "NOPE B" });

          assert.equal(cross.status, 404);

          assert.equal(
            await revisionOf(pool, restaurantA),
            5
          );

          console.log(
            "✅ 06 No fake revision for invalid updates"
          );
        }
      );

      await t.test(
        "forced outbox failure rolls back group mutation + revision",
        async () => {
          const beforeRow = await pool.query(
            `
            SELECT name
            FROM public.menu_groups
            WHERE restaurant_id = $1
              AND id = $2
            `,
            [restaurantA, groupA]
          );

          const beforeRevision =
            await revisionOf(pool, restaurantA);
          const beforeOutbox =
            await outboxCount(pool, restaurantA);

          await removeFailureTrigger(pool);

          await pool.query(`
            CREATE FUNCTION
              public.maks_test_reject_menu_group_catalog()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              IF NEW.event_type =
                'menu.catalog.replaced.v1'
              THEN
                RAISE EXCEPTION
                  'MAKS_TEST_FORCED_MENU_GROUP_CATALOG_OUTBOX_FAILURE';
              END IF;
              RETURN NEW;
            END;
            $$
          `);

          await pool.query(`
            CREATE TRIGGER
              trg_maks_test_reject_menu_group_catalog
            BEFORE INSERT
            ON public.edge_outbox
            FOR EACH ROW
            EXECUTE FUNCTION
              public.maks_test_reject_menu_group_catalog()
          `);

          try {
            const failed = await call(
              app,
              "put",
              `/menu-groups/${groupA}`,
              restaurantA
            ).send({
              name: "MUST ROLLBACK",
              show_pos: true,
              show_qr: true,
              show_kiosk: true,
              active_days: [],
              start_time: "",
              end_time: "",
              is_active: true,
            });

            assert.equal(failed.status, 500);
          } finally {
            await removeFailureTrigger(pool);
          }

          const afterRow = await pool.query(
            `
            SELECT name
            FROM public.menu_groups
            WHERE restaurant_id = $1
              AND id = $2
            `,
            [restaurantA, groupA]
          );

          assert.equal(
            afterRow.rows[0].name,
            beforeRow.rows[0].name
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
            "✅ 07 Forced outbox failure rolled everything back"
          );
        }
      );

      await t.test(
        "Edge runtime rejects group/schedule/category writers",
        async () => {
          const beforeRevision =
            await revisionOf(pool, restaurantA);

          process.env.MAKS_RUNTIME_ROLE = "edge";

          const groupResponse = await call(
            app,
            "post",
            "/menu-groups",
            restaurantA
          ).send({ name: "EDGE ILLEGAL" });

          const scheduleResponse = await call(
            app,
            "post",
            `/menu-groups/${groupA}/schedules`,
            restaurantA
          ).send({ active_days: [] });

          const categoryResponse = await call(
            app,
            "post",
            `/menu-groups/${groupA}/categories`,
            restaurantA
          ).send({ category_id: categoryA });

          assert.equal(groupResponse.status, 409);
          assert.equal(scheduleResponse.status, 409);
          assert.equal(categoryResponse.status, 409);

          assert.equal(
            await revisionOf(pool, restaurantA),
            beforeRevision
          );

          process.env.MAKS_RUNTIME_ROLE = "cloud";

          console.log(
            "✅ 08 Edge authoring fails closed"
          );
        }
      );

      await t.test(
        "missing runtime role fails closed",
        async () => {
          const beforeRevision =
            await revisionOf(pool, restaurantA);

          delete process.env.MAKS_RUNTIME_ROLE;

          const response = await call(
            app,
            "post",
            "/menu-groups",
            restaurantA
          ).send({ name: "ROLELESS ILLEGAL" });

          assert.equal(response.status, 503);
          assert.equal(
            await revisionOf(pool, restaurantA),
            beforeRevision
          );

          process.env.MAKS_RUNTIME_ROLE = "cloud";

          console.log(
            "✅ 09 Missing runtime role fails closed"
          );
        }
      );

      await t.test(
        "real deletes emit; repeated deletes do not",
        async () => {
          let response = await call(
            app,
            "delete",
            `/menu-groups/${groupA}/categories/${categoryA}`,
            restaurantA
          );
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, { success: true });
          assert.equal(
            await revisionOf(pool, restaurantA),
            6
          );

          response = await call(
            app,
            "delete",
            `/menu-groups/${groupA}/categories/${categoryA}`,
            restaurantA
          );
          assert.equal(response.status, 200);
          assert.equal(
            await revisionOf(pool, restaurantA),
            6
          );

          response = await call(
            app,
            "delete",
            `/menu-groups/${groupA}/schedules/${scheduleA}`,
            restaurantA
          );
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, { success: true });
          assert.equal(
            await revisionOf(pool, restaurantA),
            7
          );

          response = await call(
            app,
            "delete",
            `/menu-groups/${groupA}/schedules/${scheduleA}`,
            restaurantA
          );
          assert.equal(response.status, 200);
          assert.equal(
            await revisionOf(pool, restaurantA),
            7
          );

          response = await call(
            app,
            "delete",
            `/menu-groups/${groupA}`,
            restaurantA
          );
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, { success: true });
          assert.equal(
            await revisionOf(pool, restaurantA),
            8
          );

          response = await call(
            app,
            "delete",
            `/menu-groups/${groupA}`,
            restaurantA
          );
          assert.equal(response.status, 200);
          assert.equal(
            await revisionOf(pool, restaurantA),
            8
          );

          const payload =
            await latestPayload(pool, restaurantA);

          assert.equal(
            payload.catalog.menu_groups.some(
              (row) => Number(row.id) === groupA
            ),
            false
          );

          console.log(
            "✅ 10 Delete + no-fake-revision behavior proven"
          );
        }
      );

      await t.test(
        "Restaurant B remains independent",
        async () => {
          const beforeB =
            await revisionOf(pool, restaurantB);

          const response = await call(
            app,
            "put",
            `/menu-groups/${groupB}`,
            restaurantB
          ).send({
            name: "TENANT B UPDATED",
            show_pos: true,
            show_qr: true,
            show_kiosk: true,
            active_days: [],
            start_time: "",
            end_time: "",
            is_active: true,
          });

          assert.equal(
            response.status,
            200,
            JSON.stringify(response.body)
          );

          assert.equal(
            await revisionOf(pool, restaurantB),
            beforeB + 1
          );

          assert.equal(
            await revisionOf(pool, restaurantA),
            8
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
        "✅ MAKS MENU GROUP WRITER CLOUD AUTHORITY ATTACK COMPLETE"
      );
      console.log(
        "============================================"
      );
    } finally {
      process.env.MAKS_RUNTIME_ROLE = "cloud";

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
