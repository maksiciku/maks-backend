"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const express =
  require("express");

const request =
  require("supertest");

const {
  resetTestData,
} = require(
  "../setup/resetTestData"
);

const {
  seedTestData,
} = require(
  "../setup/seedTestData"
);

const {
  assertTestDatabase,
} = require(
  "../safety/assertTestDatabase"
);

const {
  getPool,
} = require(
  "../../dbCompat"
);


const originalRuntimeRole =
  process.env
    .MAKS_RUNTIME_ROLE;

process.env
  .MAKS_RUNTIME_ROLE =
  "cloud";


const categoriesRoutes =
  require(
    "../../routes/categoriesRoutes"
  );


const MENU_EVENT =
  "menu.catalog.replaced.v1";

const MENU_DOMAIN =
  "menu.catalog";


function qMarkToDollar(
  sql
) {
  let index =
    0;

  return String(
    sql
  ).replace(
    /\?/g,
    () =>
      `$${++index}`
  );
}


function createApp(
  pool
) {
  const app =
    express();

  app.use(
    express.json()
  );

  app.use(
    (
      req,
      res,
      next
    ) => {
      const rid =
        Number(
          req.get(
            "x-test-restaurant-id"
          ) ||
          0
        );

      req.tenantRid =
        rid;

      req.kind =
        "pg";

      req.qAll =
        async (
          sql,
          params =
            []
        ) =>
          (
            await pool.query(
              qMarkToDollar(
                sql
              ),
              params
            )
          ).rows ||
          [];

      req.qGet =
        async (
          sql,
          params =
            []
        ) =>
          (
            (
              await pool.query(
                qMarkToDollar(
                  sql
                ),
                params
              )
            ).rows ||
            []
          )[0] ||
          null;

      req.qRun =
        async (
          sql,
          params =
            []
        ) => {
          const result =
            await pool.query(
              qMarkToDollar(
                sql
              ),
              params
            );

          return {
            changes:
              result.rowCount ||
              0,

            lastID:
              result
                .rows?.[0]
                ?.id,
          };
        };

      next();
    }
  );

  app.use(
    "/categories",
    categoriesRoutes
  );

  return app;
}


async function revisionFor(
  pool,
  restaurantId
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
        restaurantId,
        MENU_DOMAIN,
      ]
    );

  return Number(
    result
      .rows?.[0]
      ?.produced_revision ||
    0
  );
}


async function outboxRows(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        event_id,
        event_type,
        payload
      FROM
        public.edge_outbox
      WHERE
        restaurant_id = $1
        AND event_type = $2
      ORDER BY
        created_at ASC,
        event_id ASC
      `,
      [
        restaurantId,
        MENU_EVENT,
      ]
    );

  return result.rows ||
    [];
}


async function installOutboxFailure(
  pool
) {
  await pool.query(
    `
    CREATE OR REPLACE FUNCTION
      public.maks_test_reject_menu_catalog_outbox()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF
        NEW.event_type =
          'menu.catalog.replaced.v1'
      THEN
        RAISE EXCEPTION
          'MAKS_TEST_FORCED_MENU_CATALOG_OUTBOX_FAILURE';
      END IF;

      RETURN NEW;
    END;
    $$
    `
  );

  await pool.query(
    `
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_menu_catalog_outbox
    ON
      public.edge_outbox
    `
  );

  await pool.query(
    `
    CREATE TRIGGER
      trg_maks_test_reject_menu_catalog_outbox
    BEFORE INSERT
    ON
      public.edge_outbox
    FOR EACH ROW
    EXECUTE FUNCTION
      public.maks_test_reject_menu_catalog_outbox()
    `
  );
}


async function removeOutboxFailure(
  pool
) {
  await pool.query(
    `
    DROP TRIGGER IF EXISTS
      trg_maks_test_reject_menu_catalog_outbox
    ON
      public.edge_outbox
    `
  );

  await pool.query(
    `
    DROP FUNCTION IF EXISTS
      public.maks_test_reject_menu_catalog_outbox()
    `
  );
}


test(
  "MAKS category writer Cloud authority attack",
  {
    timeout:
      90000,
  },
  async (
    t
  ) => {
    await assertTestDatabase();

    await resetTestData();

    const fixtures =
      await seedTestData();

    const pool =
      getPool();

    const app =
      createApp(
        pool
      );

    const restaurantA =
      Number(
        fixtures.restaurantA
      );

    const restaurantB =
      Number(
        fixtures.restaurantB
      );

    const categoryA =
      Number(
        fixtures.categoryA
      );

    const categoryB =
      Number(
        fixtures.categoryB
      );

    let createdCategoryId =
      null;

    try {
      console.log(
        "✅ 01 Real category route harness prepared against maks_test"
      );


      await t.test(
        "Cloud category create commits row revision and snapshot atomically",
        async () => {
          process.env
            .MAKS_RUNTIME_ROLE =
            "cloud";

          const response =
            await request(
              app
            )
              .post(
                "/categories"
              )
              .set(
                "x-test-restaurant-id",
                String(
                  restaurantA
                )
              )
              .send({
                name:
                  "EDGE CATEGORY CLOUD CREATE",

                type:
                  "drinks",

                icon:
                  "🥤",
              });

          assert.equal(
            response.status,
            200
          );

          createdCategoryId =
            Number(
              response.body.id
            );

          assert.ok(
            createdCategoryId >
              0
          );

          const row =
            await pool.query(
              `
              SELECT
                restaurant_id,
                name,
                type,
                icon
              FROM
                public.categories
              WHERE
                id = $1
              `,
              [
                createdCategoryId,
              ]
            );

          assert.equal(
            row.rows.length,
            1
          );

          assert.equal(
            Number(
              row
                .rows[0]
                .restaurant_id
            ),
            restaurantA
          );

          assert.equal(
            row.rows[0].name,
            "EDGE CATEGORY CLOUD CREATE"
          );

          assert.equal(
            await revisionFor(
              pool,
              restaurantA
            ),
            1
          );

          const events =
            await outboxRows(
              pool,
              restaurantA
            );

          assert.equal(
            events.length,
            1
          );

          assert.equal(
            events[0]
              .event_type,
            MENU_EVENT
          );

          assert.ok(
            events[0]
              .payload
              .catalog
              .categories
              .some(
                (
                  category
                ) =>
                  Number(
                    category.id
                  ) ===
                    createdCategoryId &&
                  category.name ===
                    "EDGE CATEGORY CLOUD CREATE"
              )
          );

          console.log(
            "✅ 02 Cloud create + menu revision + outbox snapshot proven"
          );
        }
      );


      await t.test(
        "Restaurant A cannot delete Restaurant B category or advance A revision",
        async () => {
          const before =
            await pool.query(
              `
              SELECT
                name
              FROM
                public.categories
              WHERE
                id = $1
                AND restaurant_id = $2
              `,
              [
                categoryB,
                restaurantB,
              ]
            );

          assert.equal(
            before.rows.length,
            1
          );

          const response =
            await request(
              app
            )
              .delete(
                `/categories/${categoryB}`
              )
              .set(
                "x-test-restaurant-id",
                String(
                  restaurantA
                )
              );

          assert.equal(
            response.status,
            200
          );

          assert.deepEqual(
            response.body,
            {
              success:
                true,
            }
          );

          const after =
            await pool.query(
              `
              SELECT
                name
              FROM
                public.categories
              WHERE
                id = $1
                AND restaurant_id = $2
              `,
              [
                categoryB,
                restaurantB,
              ]
            );

          assert.equal(
            after.rows.length,
            1
          );

          assert.equal(
            after
              .rows[0]
              .name,
            before
              .rows[0]
              .name
          );

          assert.equal(
            await revisionFor(
              pool,
              restaurantA
            ),
            1
          );

          assert.equal(
            (
              await outboxRows(
                pool,
                restaurantA
              )
            ).length,
            1
          );

          console.log(
            "✅ 03 Cross-tenant category delete blocked without fake revision"
          );
        }
      );


      await t.test(
        "Cloud category delete commits deletion and replacement snapshot together",
        async () => {
          const response =
            await request(
              app
            )
              .delete(
                `/categories/${createdCategoryId}`
              )
              .set(
                "x-test-restaurant-id",
                String(
                  restaurantA
                )
              );

          assert.equal(
            response.status,
            200
          );

          const deleted =
            await pool.query(
              `
              SELECT
                id
              FROM
                public.categories
              WHERE
                id = $1
                AND restaurant_id = $2
              `,
              [
                createdCategoryId,
                restaurantA,
              ]
            );

          assert.equal(
            deleted.rows.length,
            0
          );

          assert.equal(
            await revisionFor(
              pool,
              restaurantA
            ),
            2
          );

          const events =
            await outboxRows(
              pool,
              restaurantA
            );

          assert.equal(
            events.length,
            2
          );

          assert.equal(
            events[1]
              .payload
              .revision,
            2
          );

          assert.equal(
            events[1]
              .payload
              .catalog
              .categories
              .some(
                (
                  category
                ) =>
                  Number(
                    category.id
                  ) ===
                    createdCategoryId
              ),
            false
          );

          console.log(
            "✅ 04 Cloud delete + revision 2 + deletion snapshot proven"
          );
        }
      );


      await t.test(
        "Edge runtime rejects category authoring before mutation",
        async () => {
          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";

          const postResponse =
            await request(
              app
            )
              .post(
                "/categories"
              )
              .set(
                "x-test-restaurant-id",
                String(
                  restaurantA
                )
              )
              .send({
                name:
                  "EDGE MUST NOT AUTHOR",

                type:
                  "meals",

                icon:
                  "⛔",
              });

          assert.equal(
            postResponse.status,
            409
          );

          assert.equal(
            postResponse
              .body
              .code,
            "MENU_CATALOG_CLOUD_AUTHORITY_REQUIRED"
          );

          const deleteResponse =
            await request(
              app
            )
              .delete(
                `/categories/${categoryA}`
              )
              .set(
                "x-test-restaurant-id",
                String(
                  restaurantA
                )
              );

          assert.equal(
            deleteResponse.status,
            409
          );

          const forbiddenRow =
            await pool.query(
              `
              SELECT
                id
              FROM
                public.categories
              WHERE
                restaurant_id = $1
                AND name = $2
              `,
              [
                restaurantA,
                "EDGE MUST NOT AUTHOR",
              ]
            );

          assert.equal(
            forbiddenRow
              .rows
              .length,
            0
          );

          const originalCategory =
            await pool.query(
              `
              SELECT id
              FROM public.categories
              WHERE id = $1
                AND restaurant_id = $2
              `,
              [
                categoryA,
                restaurantA,
              ]
            );

          assert.equal(
            originalCategory
              .rows
              .length,
            1
          );

          assert.equal(
            await revisionFor(
              pool,
              restaurantA
            ),
            2
          );

          console.log(
            "✅ 05 Edge runtime category authoring fails closed"
          );
        }
      );


      await t.test(
        "missing runtime role fails closed before category mutation",
        async () => {
          delete process.env
            .MAKS_RUNTIME_ROLE;

          const response =
            await request(
              app
            )
              .post(
                "/categories"
              )
              .set(
                "x-test-restaurant-id",
                String(
                  restaurantA
                )
              )
              .send({
                name:
                  "MISSING ROLE MUST NOT AUTHOR",

                type:
                  "meals",
              });

          assert.equal(
            response.status,
            503
          );

          assert.equal(
            response
              .body
              .code,
            "MENU_CATALOG_RUNTIME_ROLE_UNAVAILABLE"
          );

          const forbidden =
            await pool.query(
              `
              SELECT id
              FROM public.categories
              WHERE restaurant_id = $1
                AND name = $2
              `,
              [
                restaurantA,
                "MISSING ROLE MUST NOT AUTHOR",
              ]
            );

          assert.equal(
            forbidden.rows.length,
            0
          );

          assert.equal(
            await revisionFor(
              pool,
              restaurantA
            ),
            2
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
        "forced outbox failure rolls category mutation and revision back together",
        async () => {
          process.env
            .MAKS_RUNTIME_ROLE =
            "cloud";

          await installOutboxFailure(
            pool
          );

          try {
            const response =
              await request(
                app
              )
                .post(
                  "/categories"
                )
                .set(
                  "x-test-restaurant-id",
                  String(
                    restaurantA
                  )
                )
                .send({
                  name:
                    "ROLLBACK CATEGORY",

                  type:
                    "desserts",

                  icon:
                    "💥",
                });

            assert.equal(
              response.status,
              500
            );

            const row =
              await pool.query(
                `
                SELECT id
                FROM public.categories
                WHERE restaurant_id = $1
                  AND name = $2
                `,
                [
                  restaurantA,
                  "ROLLBACK CATEGORY",
                ]
              );

            assert.equal(
              row.rows.length,
              0
            );

            assert.equal(
              await revisionFor(
                pool,
                restaurantA
              ),
              2
            );

            assert.equal(
              (
                await outboxRows(
                  pool,
                  restaurantA
                )
              ).length,
              2
            );
          } finally {
            await removeOutboxFailure(
              pool
            );
          }

          console.log(
            "✅ 07 Forced Edge event failure rolls row + revision + outbox back"
          );
        }
      );


      await t.test(
        "Restaurant B retains independent Cloud category authority",
        async () => {
          process.env
            .MAKS_RUNTIME_ROLE =
            "cloud";

          const response =
            await request(
              app
            )
              .post(
                "/categories"
              )
              .set(
                "x-test-restaurant-id",
                String(
                  restaurantB
                )
              )
              .send({
                name:
                  "TENANT B INDEPENDENT CATEGORY",

                type:
                  "meals",

                icon:
                  "🍲",
              });

          assert.equal(
            response.status,
            200
          );

          assert.equal(
            await revisionFor(
              pool,
              restaurantB
            ),
            1
          );

          assert.equal(
            await revisionFor(
              pool,
              restaurantA
            ),
            2
          );

          const row =
            await pool.query(
              `
              SELECT
                restaurant_id
              FROM
                public.categories
              WHERE
                id = $1
              `,
              [
                Number(
                  response
                    .body
                    .id
                ),
              ]
            );

          assert.equal(
            Number(
              row
                .rows[0]
                .restaurant_id
            ),
            restaurantB
          );

          console.log(
            "✅ 08 Independent Restaurant B authority preserved"
          );
        }
      );


      console.log(
        "============================================"
      );

      console.log(
        "✅ MAKS CATEGORY WRITER CLOUD AUTHORITY ATTACK COMPLETE"
      );

      console.log(
        "============================================"
      );
    } finally {
      await removeOutboxFailure(
        pool
      ).catch(
        () => {}
      );

      process.env
        .MAKS_RUNTIME_ROLE =
        "cloud";

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
        "✅ 09 Cleanup proven"
      );
    }
  }
);
