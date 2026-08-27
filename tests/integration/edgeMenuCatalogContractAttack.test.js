"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const crypto =
  require("node:crypto");

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
  withTx,
} = require(
  "../../dbCompat"
);


const originalRuntimeRole =
  process.env
    .MAKS_RUNTIME_ROLE;

process.env
  .MAKS_RUNTIME_ROLE =
  "cloud";


const {
  MENU_CATALOG_DOMAIN,
  MENU_CATALOG_EVENT_TYPE,
  validateMenuCatalogPayload,
  emitMenuCatalogSnapshotTx,
  applyMenuCatalogReplaced,
} = require(
  "../../edge/contracts/menuCatalog"
);


function hashPayload(
  payload
) {
  return crypto
    .createHash(
      "sha256"
    )
    .update(
      JSON.stringify(
        payload
      )
    )
    .digest(
      "hex"
    );
}


function clone(
  value
) {
  return JSON.parse(
    JSON.stringify(
      value
    )
  );
}


async function tableCount(
  pool,
  table,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        COUNT(*)::int
          AS count
      FROM
        public.${table}
      WHERE
        restaurant_id = $1
      `,
      [
        restaurantId,
      ]
    );

  return Number(
    result.rows?.[0]
      ?.count ||
    0
  );
}


test(
  "MAKS Edge menu catalogue contract attack",
  {
    timeout:
      90000,
  },
  async (t) => {
    await assertTestDatabase();

    await resetTestData();

    const fixtures =
      await seedTestData();

    const pool =
      getPool();

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

    let snapshot1;
    let event1;

    try {
      const schema =
        await pool.query(
          `
          SELECT
            to_regclass(
              'public.categories'
            ) AS categories,

            to_regclass(
              'public.meals'
            ) AS meals,

            to_regclass(
              'public.menu_items'
            ) AS menu_items,

            to_regclass(
              'public.menu_groups'
            ) AS menu_groups,

            to_regclass(
              'public.menu_group_categories'
            ) AS menu_group_categories,

            to_regclass(
              'public.menu_group_schedules'
            ) AS menu_group_schedules
          `
        );

      for (
        const [
          key,
          value,
        ] of Object.entries(
          schema.rows[0]
        )
      ) {
        assert.ok(
          value,
          `Required menu catalogue table missing: ${key}`
        );
      }

      console.log(
        "✅ 01 Required six-table menu catalogue schema verified"
      );


      const menuItemA =
        await pool.query(
          `
          INSERT INTO
            public.menu_items
          (
            restaurant_id,
            name,
            type,
            price,
            category_id,
            paused,
            options_schema,
            is_available,
            out_of_stock,
            allergens,
            calories,
            availability_mode,
            manually_stopped
          )
          VALUES
          (
            $1,
            $2,
            'drink',
            4.75,
            $3,
            FALSE,
            $4::jsonb,
            TRUE,
            FALSE,
            'None',
            120,
            'maks',
            FALSE
          )
          RETURNING id
          `,
          [
            restaurantA,
            "EDGE MENU CONTRACT DRINK",
            categoryA,
            JSON.stringify([
              {
                id:
                  "size",
                label:
                  "Size",
                type:
                  "single",
                choices: [
                  {
                    id:
                      "large",
                    label:
                      "Large",
                    price:
                      1.25,
                  },
                ],
              },
            ]),
          ]
        );

      const groupA =
        await pool.query(
          `
          INSERT INTO
            public.menu_groups
          (
            restaurant_id,
            name,
            base_type,
            sort_order,
            show_pos,
            show_qr,
            show_kiosk,
            active_days,
            is_active,
            priority
          )
          VALUES
          (
            $1,
            $2,
            'meals',
            3,
            TRUE,
            TRUE,
            TRUE,
            $3::jsonb,
            TRUE,
            10
          )
          RETURNING id
          `,
          [
            restaurantA,
            "EDGE MENU CONTRACT GROUP",
            JSON.stringify([
              "mon",
              "tue",
            ]),
          ]
        );

      const groupId =
        Number(
          groupA.rows[0].id
        );

      await pool.query(
        `
        INSERT INTO
          public.menu_group_categories
        (
          restaurant_id,
          menu_group_id,
          category_id,
          sort_order
        )
        VALUES
        (
          $1,
          $2,
          $3,
          1
        )
        `,
        [
          restaurantA,
          groupId,
          categoryA,
        ]
      );

      await pool.query(
        `
        INSERT INTO
          public.menu_group_schedules
        (
          restaurant_id,
          menu_group_id,
          active_days,
          start_time,
          end_time,
          priority,
          is_active
        )
        VALUES
        (
          $1,
          $2,
          $3::jsonb,
          '08:00',
          '14:00',
          5,
          TRUE
        )
        `,
        [
          restaurantA,
          groupId,
          JSON.stringify([
            "mon",
            "tue",
          ]),
        ]
      );

      await pool.query(
        `
        INSERT INTO
          public.menu_items
        (
          restaurant_id,
          name,
          type,
          price,
          category_id
        )
        VALUES
        (
          $1,
          $2,
          'dessert',
          6.25,
          $3
        )
        `,
        [
          restaurantB,
          "TENANT B MENU ITEM",
          Number(
            fixtures.categoryB
          ),
        ]
      );

      console.log(
        "✅ 02 Isolated menu catalogue fixtures prepared"
      );


      await t.test(
        "Cloud producer emits one complete six-table revision",
        async () => {
          process.env
            .MAKS_RUNTIME_ROLE =
            "cloud";

          const produced =
            await withTx(
              (tx) =>
                emitMenuCatalogSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                )
            );

          assert.equal(
            produced.revision,
            1
          );

          assert.equal(
            produced
              .event
              .event_type,
            MENU_CATALOG_EVENT_TYPE
          );

          assert.equal(
            produced
              .payload
              .schema_version,
            1
          );

          assert.equal(
            produced
              .payload
              .revision,
            1
          );

          for (
            const key of [
              "categories",
              "meals",
              "menu_items",
              "menu_groups",
              "menu_group_categories",
              "menu_group_schedules",
            ]
          ) {
            assert.ok(
              Array.isArray(
                produced
                  .payload
                  .catalog[
                    key
                  ]
              ),
              `${key} snapshot missing`
            );
          }

          assert.ok(
            produced
              .payload
              .catalog
              .menu_items
              .some(
                (row) =>
                  Number(
                    row.id
                  ) ===
                    Number(
                      menuItemA
                        .rows[0]
                        .id
                    ) &&
                  row.price ===
                    4.75 &&
                  row.is_available ===
                    true &&
                  row.availability_mode ===
                    "maks"
              )
          );

          assert.ok(
            produced
              .payload
              .catalog
              .menu_groups
              .some(
                (row) =>
                  row.id ===
                    groupId &&
                  row.priority ===
                    10
              )
          );

          assert.equal(
            JSON.stringify(
              produced.payload
            ).includes(
              '"restaurant_id"'
            ),
            false,
            "Tenant id must not be caller-controlled inside catalogue rows"
          );

          snapshot1 =
            produced.payload;

          event1 =
            produced.event;

          console.log(
            "✅ 03 Cloud revision 1 complete snapshot + outbox proven"
          );
        }
      );


      await t.test(
        "Cloud producer fails closed on Edge runtime",
        async () => {
          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";

          await assert.rejects(
            () =>
              withTx(
                (tx) =>
                  emitMenuCatalogSnapshotTx(
                    tx,
                    {
                      restaurantId:
                        restaurantA,
                    }
                  )
              )
          );

          const revision =
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
                restaurantA,
                MENU_CATALOG_DOMAIN,
              ]
            );

          assert.equal(
            Number(
              revision
                .rows[0]
                .produced_revision
            ),
            1
          );

          process.env
            .MAKS_RUNTIME_ROLE =
            "cloud";

          console.log(
            "✅ 04 Edge runtime cannot author menu catalogue"
          );
        }
      );


      await t.test(
        "strict relationship validation rejects orphan and cyclic catalogue data",
        async () => {
          const orphanMeal =
            clone(
              snapshot1
            );

          orphanMeal
            .catalog
            .meals[0]
            .category_id =
            999999999;

          assert.throws(
            () =>
              validateMenuCatalogPayload(
                orphanMeal
              ),
            /outside the catalogue/
          );

          const orphanLink =
            clone(
              snapshot1
            );

          orphanLink
            .catalog
            .menu_group_categories[0]
            .menu_group_id =
            999999999;

          assert.throws(
            () =>
              validateMenuCatalogPayload(
                orphanLink
              ),
            /outside the catalogue/
          );

          const cycle =
            clone(
              snapshot1
            );

          cycle
            .catalog
            .menu_groups
            .push({
              id:
                900000001,

              name:
                "Cycle A",

              base_type:
                "meals",

              parent_id:
                900000002,

              sort_order:
                0,

              show_pos:
                true,

              show_qr:
                true,

              show_kiosk:
                true,

              active_days:
                [],

              start_time:
                null,

              end_time:
                null,

              is_active:
                true,

              start_date:
                null,

              end_date:
                null,

              priority:
                0,
            });

          cycle
            .catalog
            .menu_groups
            .push({
              id:
                900000002,

              name:
                "Cycle B",

              base_type:
                "meals",

              parent_id:
                900000001,

              sort_order:
                0,

              show_pos:
                true,

              show_qr:
                true,

              show_kiosk:
                true,

              active_days:
                [],

              start_time:
                null,

              end_time:
                null,

              is_active:
                true,

              start_date:
                null,

              end_date:
                null,

              priority:
                0,
            });

          assert.throws(
            () =>
              validateMenuCatalogPayload(
                cycle
              ),
            /cycle/
          );

          console.log(
            "✅ 05 Orphan/cycle relationships rejected before DB apply"
          );
        }
      );


      await t.test(
        "revision 1 restores authoritative tenant A rows without touching tenant B",
        async () => {
          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";

          await pool.query(
            `
            UPDATE
              public.categories
            SET
              name =
                'LOCAL STALE CATEGORY'
            WHERE
              id = $1
              AND restaurant_id = $2
            `,
            [
              categoryA,
              restaurantA,
            ]
          );

          await pool.query(
            `
            UPDATE
              public.menu_items
            SET
              price =
                999.99
            WHERE
              id = $1
              AND restaurant_id = $2
            `,
            [
              Number(
                menuItemA
                  .rows[0]
                  .id
              ),
              restaurantA,
            ]
          );

          const beforeB =
            await pool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.menu_items
              WHERE
                restaurant_id = $1
              `,
              [
                restaurantB,
              ]
            );

          const applied =
            await withTx(
              (tx) =>
                applyMenuCatalogReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event:
                    event1,

                  payload:
                    snapshot1,
                })
            );

          assert.equal(
            applied.state,
            "applied"
          );

          const category =
            await pool.query(
              `
              SELECT name
              FROM public.categories
              WHERE id = $1
                AND restaurant_id = $2
              `,
              [
                categoryA,
                restaurantA,
              ]
            );

          assert.notEqual(
            category
              .rows[0]
              .name,
            "LOCAL STALE CATEGORY"
          );

          const item =
            await pool.query(
              `
              SELECT
                price::numeric
                  AS price
              FROM
                public.menu_items
              WHERE
                id = $1
                AND restaurant_id = $2
              `,
              [
                Number(
                  menuItemA
                    .rows[0]
                    .id
                ),
                restaurantA,
              ]
            );

          assert.equal(
            Number(
              item.rows[0].price
            ),
            4.75
          );

          const afterB =
            await pool.query(
              `
              SELECT
                COUNT(*)::int
                  AS count
              FROM
                public.menu_items
              WHERE
                restaurant_id = $1
              `,
              [
                restaurantB,
              ]
            );

          assert.equal(
            Number(
              afterB
                .rows[0]
                .count
            ),
            Number(
              beforeB
                .rows[0]
                .count
            )
          );

          console.log(
            "✅ 06 Authoritative replacement + tenant B isolation proven"
          );
        }
      );


      await t.test(
        "same revision is idempotent and same revision different hash conflicts",
        async () => {
          const duplicate =
            await withTx(
              (tx) =>
                applyMenuCatalogReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event:
                    event1,

                  payload:
                    snapshot1,
                })
            );

          assert.equal(
            duplicate.state,
            "duplicate"
          );

          await assert.rejects(
            () =>
              withTx(
                (tx) =>
                  applyMenuCatalogReplaced({
                    tx,

                    restaurantId:
                      restaurantA,

                    event: {
                      ...event1,

                      payload_hash:
                        "f".repeat(
                          64
                        ),
                    },

                    payload:
                      snapshot1,
                  })
              )
          );

          console.log(
            "✅ 07 Duplicate replay + same-revision hash conflict proven"
          );
        }
      );


      await t.test(
        "newer revision applies and stale revision cannot roll catalogue backward",
        async () => {
          process.env
            .MAKS_RUNTIME_ROLE =
            "cloud";

          await pool.query(
            `
            UPDATE
              public.categories
            SET
              icon =
                '🔥'
            WHERE
              id = $1
              AND restaurant_id = $2
            `,
            [
              categoryA,
              restaurantA,
            ]
          );

          const produced2 =
            await withTx(
              (tx) =>
                emitMenuCatalogSnapshotTx(
                  tx,
                  {
                    restaurantId:
                      restaurantA,
                  }
                )
            );

          assert.equal(
            produced2.revision,
            2
          );

          process.env
            .MAKS_RUNTIME_ROLE =
            "edge";

          const applied2 =
            await withTx(
              (tx) =>
                applyMenuCatalogReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event:
                    produced2.event,

                  payload:
                    produced2.payload,
                })
            );

          assert.equal(
            applied2.state,
            "applied"
          );

          const stale =
            await withTx(
              (tx) =>
                applyMenuCatalogReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event:
                    event1,

                  payload:
                    snapshot1,
                })
            );

          assert.equal(
            stale.state,
            "stale"
          );

          const category =
            await pool.query(
              `
              SELECT icon
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
            category
              .rows[0]
              .icon,
            "🔥"
          );

          console.log(
            "✅ 08 Higher revision + stale rollback protection proven"
          );
        }
      );


      await t.test(
        "empty authoritative snapshot clears tenant A only",
        async () => {
          const emptyPayload = {
            schema_version:
              1,

            revision:
              3,

            catalog: {
              categories:
                [],

              meals:
                [],

              menu_items:
                [],

              menu_groups:
                [],

              menu_group_categories:
                [],

              menu_group_schedules:
                [],
            },
          };

          const tenantBBefore = {
            categories:
              await tableCount(
                pool,
                "categories",
                restaurantB
              ),

            meals:
              await tableCount(
                pool,
                "meals",
                restaurantB
              ),

            menu_items:
              await tableCount(
                pool,
                "menu_items",
                restaurantB
              ),
          };

          const result =
            await withTx(
              (tx) =>
                applyMenuCatalogReplaced({
                  tx,

                  restaurantId:
                    restaurantA,

                  event: {
                    event_type:
                      MENU_CATALOG_EVENT_TYPE,

                    payload_hash:
                      hashPayload(
                        emptyPayload
                      ),
                  },

                  payload:
                    emptyPayload,
                })
            );

          assert.equal(
            result.state,
            "applied"
          );

          for (
            const table of [
              "categories",
              "meals",
              "menu_items",
              "menu_groups",
              "menu_group_categories",
              "menu_group_schedules",
            ]
          ) {
            assert.equal(
              await tableCount(
                pool,
                table,
                restaurantA
              ),
              0,
              `${table} was not cleared for tenant A`
            );
          }

          assert.equal(
            await tableCount(
              pool,
              "categories",
              restaurantB
            ),
            tenantBBefore.categories
          );

          assert.equal(
            await tableCount(
              pool,
              "meals",
              restaurantB
            ),
            tenantBBefore.meals
          );

          assert.equal(
            await tableCount(
              pool,
              "menu_items",
              restaurantB
            ),
            tenantBBefore.menu_items
          );

          console.log(
            "✅ 09 Empty authoritative snapshot clears tenant A only"
          );
        }
      );


      await t.test(
        "cross-tenant primary-key collision fails closed before mutation",
        async () => {
          const bCategory =
            await pool.query(
              `
              SELECT
                id,
                name,
                type,
                icon
              FROM
                public.categories
              WHERE
                restaurant_id = $1
              ORDER BY
                id ASC
              LIMIT 1
              `,
              [
                restaurantB,
              ]
            );

          assert.equal(
            bCategory.rows.length,
            1
          );

          const collisionPayload = {
            schema_version:
              1,

            revision:
              4,

            catalog: {
              categories: [
                {
                  id:
                    Number(
                      bCategory
                        .rows[0]
                        .id
                    ),

                  name:
                    "ATTEMPTED TENANT A COLLISION",

                  type:
                    String(
                      bCategory
                        .rows[0]
                        .type
                    ),

                  icon:
                    String(
                      bCategory
                        .rows[0]
                        .icon ||
                      "🍽️"
                    ),
                },
              ],

              meals:
                [],

              menu_items:
                [],

              menu_groups:
                [],

              menu_group_categories:
                [],

              menu_group_schedules:
                [],
            },
          };

          await assert.rejects(
            () =>
              withTx(
                (tx) =>
                  applyMenuCatalogReplaced({
                    tx,

                    restaurantId:
                      restaurantA,

                    event: {
                      event_type:
                        MENU_CATALOG_EVENT_TYPE,

                      payload_hash:
                        hashPayload(
                          collisionPayload
                        ),
                    },

                    payload:
                      collisionPayload,
                  })
              ),
            /another restaurant/
          );

          const untouched =
            await pool.query(
              `
              SELECT name
              FROM public.categories
              WHERE id = $1
                AND restaurant_id = $2
              `,
              [
                Number(
                  bCategory
                    .rows[0]
                    .id
                ),
                restaurantB,
              ]
            );

          assert.equal(
            untouched
              .rows[0]
              .name,
            bCategory
              .rows[0]
              .name
          );

          const revision =
            await pool.query(
              `
              SELECT
                applied_revision
              FROM
                public.edge_domain_revisions
              WHERE
                restaurant_id = $1
                AND domain = $2
              `,
              [
                restaurantA,
                MENU_CATALOG_DOMAIN,
              ]
            );

          assert.equal(
            Number(
              revision
                .rows[0]
                .applied_revision
            ),
            3
          );

          console.log(
            "✅ 10 Cross-tenant primary-key collision fails closed atomically"
          );
        }
      );


      console.log(
        "============================================"
      );

      console.log(
        "✅ MAKS EDGE MENU CATALOGUE CONTRACT ATTACK COMPLETE"
      );

      console.log(
        "============================================"
      );
    } finally {
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
        "✅ 11 Cleanup proven"
      );
    }
  }
);
