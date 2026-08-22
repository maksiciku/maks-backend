// migrations/canonicalMenuScheduling.pg.js

async function ensureConstraint(client, table, name, definition) {
  const { rows } = await client.query(
    `
    SELECT 1
    FROM pg_constraint
    WHERE conname = $1
      AND conrelid = $2::regclass
    LIMIT 1
    `,
    [name, `public.${table}`]
  );

  if (rows.length) return;

  await client.query(`
    ALTER TABLE public.${table}
    ADD CONSTRAINT ${name}
    ${definition};
  `);
}

async function runCanonicalMenuSchedulingPg({ pool }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error(
      "Canonical menu scheduling schema requires PostgreSQL pool"
    );
  }

  console.log(
    "🗓️ Running canonical MAKS menu scheduling schema..."
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.menu_groups (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        name TEXT NOT NULL,
        base_type TEXT NOT NULL DEFAULT 'meals',
        parent_id BIGINT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        show_pos BOOLEAN NOT NULL DEFAULT TRUE,
        show_qr BOOLEAN NOT NULL DEFAULT TRUE,
        show_kiosk BOOLEAN NOT NULL DEFAULT TRUE,
        active_days JSONB NOT NULL DEFAULT '[]'::jsonb,
        start_time TIME,
        end_time TIME,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        start_date DATE,
        end_date DATE,
        priority INTEGER NOT NULL DEFAULT 0
      );
    `);

    await ensureConstraint(
      client,
      "menu_groups",
      "menu_groups_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "menu_groups",
      "menu_groups_parent_id_fkey",
      `FOREIGN KEY (parent_id)
       REFERENCES public.menu_groups(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_menu_groups_restaurant
      ON public.menu_groups (
        restaurant_id,
        base_type,
        parent_id,
        is_active
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_menu_groups_schedule
      ON public.menu_groups (
        restaurant_id,
        base_type,
        is_active,
        priority,
        sort_order
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.menu_group_schedules (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        menu_group_id BIGINT NOT NULL,
        active_days JSONB NOT NULL DEFAULT '[]'::jsonb,
        start_time TIME,
        end_time TIME,
        priority INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await ensureConstraint(
      client,
      "menu_group_schedules",
      "menu_group_schedules_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "menu_group_schedules",
      "menu_group_schedules_menu_group_id_fkey",
      `FOREIGN KEY (menu_group_id)
       REFERENCES public.menu_groups(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_menu_group_schedules_restaurant
      ON public.menu_group_schedules (
        restaurant_id,
        menu_group_id,
        is_active
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.menu_group_categories (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        menu_group_id BIGINT NOT NULL,
        category_id BIGINT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT menu_group_categories_restaurant_id_menu_group_id_category__key
          UNIQUE (restaurant_id, menu_group_id, category_id)
      );
    `);

    await ensureConstraint(
      client,
      "menu_group_categories",
      "menu_group_categories_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "menu_group_categories",
      "menu_group_categories_menu_group_id_fkey",
      `FOREIGN KEY (menu_group_id)
       REFERENCES public.menu_groups(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "menu_group_categories",
      "menu_group_categories_category_id_fkey",
      `FOREIGN KEY (category_id)
       REFERENCES public.categories(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_menu_group_categories_restaurant
      ON public.menu_group_categories (
        restaurant_id,
        menu_group_id,
        category_id
      );
    `);

    const { rows } = await client.query(`
      SELECT COUNT(*)::int AS table_count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(
          ARRAY[
            'menu_groups',
            'menu_group_schedules',
            'menu_group_categories'
          ]::text[]
        );
    `);

    if (Number(rows[0]?.table_count || 0) !== 3) {
      throw new Error(
        `Canonical menu scheduling verification failed: expected 3 tables, found ${Number(rows[0]?.table_count || 0)}`
      );
    }

    await client.query("COMMIT");

    console.log(
      "✅ Canonical MAKS menu scheduling schema ready"
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Preserve original error.
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  runCanonicalMenuSchedulingPg,
};
