"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resetTestData,
} = require("../setup/resetTestData");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

const {
  withTx,
  getPool,
} = require("../../dbCompat");

const {
  emitMenuCatalogSnapshotTx,
  applyMenuCatalogReplaced,
} = require("../../edge/contracts/menuCatalog");

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;


test(
  "retained menu group hierarchy survives parent replacement without cascade recreation",
  {
    timeout: 60000,
  },
  async () => {
    await assertTestDatabase();
    await resetTestData();

    const pool =
      getPool();

    try {
      const restaurant =
        await pool.query(
          `
          INSERT INTO public.restaurants
            (name)
          VALUES
            ($1)
          RETURNING id
          `,
          [
            "EDGE GROUP HIERARCHY ATTACK",
          ]
        );

      const rid =
        Number(
          restaurant.rows[0].id
        );


      const category =
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
              $2,
              'meals',
              '🍽️'
            )
          RETURNING id
          `,
          [
            rid,
            "Hierarchy Category",
          ]
        );

      const categoryId =
        Number(
          category.rows[0].id
        );


      /*
       * Authoritative Cloud hierarchy:
       *
       * Parent C
       *   └── Child B
       */
      const newParent =
        await pool.query(
          `
          INSERT INTO public.menu_groups
          (
            restaurant_id,
            name,
            base_type,
            parent_id,
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
            NULL,
            0,
            TRUE,
            TRUE,
            TRUE,
            '[]'::jsonb,
            TRUE,
            20
          )
          RETURNING id
          `,
          [
            rid,
            "NEW PARENT C",
          ]
        );

      const newParentId =
        Number(
          newParent.rows[0].id
        );


      const child =
        await pool.query(
          `
          INSERT INTO public.menu_groups
          (
            restaurant_id,
            name,
            base_type,
            parent_id,
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
            $3,
            1,
            TRUE,
            TRUE,
            TRUE,
            '[]'::jsonb,
            TRUE,
            10
          )
          RETURNING
            id,
            created_at
          `,
          [
            rid,
            "RETAINED CHILD B",
            newParentId,
          ]
        );

      const childId =
        Number(
          child.rows[0].id
        );


      const link =
        await pool.query(
          `
          INSERT INTO public.menu_group_categories
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
            0
          )
          RETURNING
            id,
            created_at
          `,
          [
            rid,
            childId,
            categoryId,
          ]
        );

      const linkId =
        Number(
          link.rows[0].id
        );


      const schedule =
        await pool.query(
          `
          INSERT INTO public.menu_group_schedules
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
            '["mon","tue"]'::jsonb,
            '09:00'::time,
            '17:00'::time,
            5,
            TRUE
          )
          RETURNING
            id,
            created_at
          `,
          [
            rid,
            childId,
          ]
        );

      const scheduleId =
        Number(
          schedule.rows[0].id
        );


      /*
       * Capture the authoritative Cloud snapshot while
       * Child B correctly belongs to Parent C.
       */
      process.env.MAKS_RUNTIME_ROLE =
        "cloud";

      const produced =
        await withTx(
          (tx) =>
            emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  rid,
              }
            )
        );

      assert.equal(
        produced.revision,
        1
      );


      /*
       * Now make the local Edge state stale:
       *
       * Parent A
       *   └── Child B
       *
       * Parent A does NOT exist in the Cloud snapshot.
       */
      const oldParent =
        await pool.query(
          `
          INSERT INTO public.menu_groups
          (
            restaurant_id,
            name,
            base_type,
            parent_id,
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
            NULL,
            99,
            TRUE,
            TRUE,
            TRUE,
            '[]'::jsonb,
            TRUE,
            1
          )
          RETURNING id
          `,
          [
            rid,
            "OBSOLETE PARENT A",
          ]
        );

      const oldParentId =
        Number(
          oldParent.rows[0].id
        );


      await pool.query(
        `
        UPDATE public.menu_groups
        SET parent_id = $1
        WHERE id = $2
          AND restaurant_id = $3
        `,
        [
          oldParentId,
          childId,
          rid,
        ]
      );


      const before =
        await pool.query(
          `
          SELECT
            g.created_at
              AS child_created_at,

            mgc.created_at
              AS link_created_at,

            mgs.created_at
              AS schedule_created_at

          FROM public.menu_groups g

          JOIN public.menu_group_categories mgc
            ON mgc.id = $1
           AND mgc.restaurant_id = g.restaurant_id
           AND mgc.menu_group_id = g.id

          JOIN public.menu_group_schedules mgs
            ON mgs.id = $2
           AND mgs.restaurant_id = g.restaurant_id
           AND mgs.menu_group_id = g.id

          WHERE g.id = $3
            AND g.restaurant_id = $4
          `,
          [
            linkId,
            scheduleId,
            childId,
            rid,
          ]
        );

      assert.equal(
        before.rows.length,
        1
      );


      process.env.MAKS_RUNTIME_ROLE =
        "edge";

      const applied =
        await withTx(
          (tx) =>
            applyMenuCatalogReplaced({
              tx,

              restaurantId:
                rid,

              event:
                produced.event,

              payload:
                produced.payload,
            })
        );

      assert.equal(
        applied.state,
        "applied"
      );


      const after =
        await pool.query(
          `
          SELECT
            g.parent_id,

            g.created_at
              AS child_created_at,

            mgc.id
              AS link_id,

            mgc.created_at
              AS link_created_at,

            mgs.id
              AS schedule_id,

            mgs.created_at
              AS schedule_created_at

          FROM public.menu_groups g

          JOIN public.menu_group_categories mgc
            ON mgc.id = $1
           AND mgc.restaurant_id = g.restaurant_id
           AND mgc.menu_group_id = g.id

          JOIN public.menu_group_schedules mgs
            ON mgs.id = $2
           AND mgs.restaurant_id = g.restaurant_id
           AND mgs.menu_group_id = g.id

          WHERE g.id = $3
            AND g.restaurant_id = $4
          `,
          [
            linkId,
            scheduleId,
            childId,
            rid,
          ]
        );

      assert.equal(
        after.rows.length,
        1,
        "Child B + link + schedule must all survive"
      );


      assert.equal(
        Number(
          after.rows[0].parent_id
        ),
        newParentId,
        "Child B must move to authoritative Parent C"
      );


      const obsolete =
        await pool.query(
          `
          SELECT
            COUNT(*)::int AS count
          FROM public.menu_groups
          WHERE restaurant_id = $1
            AND id = $2
          `,
          [
            rid,
            oldParentId,
          ]
        );

      assert.equal(
        Number(
          obsolete.rows[0].count
        ),
        0,
        "Obsolete Parent A must be removed"
      );


      /*
       * Critical preservation assertions.
       *
       * Same IDs alone are not enough: an ON DELETE CASCADE
       * could destroy these rows and later code could recreate
       * them using the same IDs.
       *
       * created_at proves whether the retained rows genuinely
       * survived the transition.
       */
      assert.equal(
        new Date(
          after.rows[0].child_created_at
        ).toISOString(),

        new Date(
          before.rows[0].child_created_at
        ).toISOString(),

        "Retained Child B was deleted/reinserted during parent replacement"
      );


      assert.equal(
        new Date(
          after.rows[0].link_created_at
        ).toISOString(),

        new Date(
          before.rows[0].link_created_at
        ).toISOString(),

        "Retained category link was deleted/reinserted by cascade"
      );


      assert.equal(
        new Date(
          after.rows[0].schedule_created_at
        ).toISOString(),

        new Date(
          before.rows[0].schedule_created_at
        ).toISOString(),

        "Retained schedule was deleted/reinserted by cascade"
      );


      console.log(
        "✅ Parent A → Parent C transition preserved Child B + link + schedule"
      );
    } finally {
      process.env.MAKS_RUNTIME_ROLE =
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
    }
  }
);
