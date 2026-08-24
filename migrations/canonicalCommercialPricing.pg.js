// migrations/canonicalCommercialPricing.pg.js

async function tableExists(client, table) {
  const { rows } = await client.query(
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = $1
      AND table_type = 'BASE TABLE'
    LIMIT 1
    `,
    [table]
  );

  return rows.length > 0;
}

async function getColumn(client, table, column) {
  const { rows } = await client.query(
    `
    SELECT data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [table, column]
  );

  return rows[0] || null;
}

async function assertExistingType(client, table, column, allowedUdts) {
  if (!(await tableExists(client, table))) return;

  const info = await getColumn(client, table, column);
  if (!info) return;

  if (!allowedUdts.includes(info.udt_name)) {
    throw new Error(
      `Canonical commercial schema refused: public.${table}.${column} is ${info.udt_name}; expected ${allowedUdts.join(" or ")}`
    );
  }
}

async function ensureColumns(client, table, columns) {
  for (const [name, definition] of columns) {
    await client.query(`
      ALTER TABLE public.${table}
      ADD COLUMN IF NOT EXISTS ${name} ${definition};
    `);
  }
}

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

async function runCanonicalCommercialPricingPg({ pool }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error(
      "Canonical commercial pricing schema requires PostgreSQL pool"
    );
  }

  console.log(
    "🏷️ Running canonical MAKS commercial pricing schema..."
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =====================================================
    // FAIL-CLOSED TYPE PREFLIGHT
    // =====================================================

    for (const table of [
      "pricing_rules",
      "happy_hours",
      "vouchers",
      "restaurant_promotions",
    ]) {
      await assertExistingType(
        client,
        table,
        "id",
        ["int8"]
      );

      await assertExistingType(
        client,
        table,
        "restaurant_id",
        ["int8"]
      );
    }

    // =====================================================
    // PRICING RULES
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.pricing_rules (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        name TEXT NOT NULL,
        rule_type TEXT NOT NULL DEFAULT 'fixed_bundle',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        priority INTEGER NOT NULL DEFAULT 0,
        conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
        actions JSONB NOT NULL DEFAULT '{}'::jsonb,
        starts_at TIMESTAMPTZ,
        ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT pricing_rules_type_check
          CHECK (rule_type IN ('fixed_bundle', 'mix_match')),
        CONSTRAINT pricing_rules_range_check
          CHECK (
            starts_at IS NULL
            OR ends_at IS NULL
            OR ends_at > starts_at
          )
      );
    `);

    await ensureColumns(
      client,
      "pricing_rules",
      [
        ["name", "TEXT NOT NULL"],
        ["rule_type", "TEXT NOT NULL DEFAULT 'fixed_bundle'"],
        ["active", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["priority", "INTEGER NOT NULL DEFAULT 0"],
        ["conditions", "JSONB NOT NULL DEFAULT '{}'::jsonb"],
        ["actions", "JSONB NOT NULL DEFAULT '{}'::jsonb"],
        ["starts_at", "TIMESTAMPTZ"],
        ["ends_at", "TIMESTAMPTZ"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
        ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
      ]
    );

    await ensureConstraint(
      client,
      "pricing_rules",
      "pricing_rules_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "pricing_rules",
      "pricing_rules_type_check",
      `CHECK (rule_type IN ('fixed_bundle', 'mix_match'))`
    );

    await ensureConstraint(
      client,
      "pricing_rules",
      "pricing_rules_range_check",
      `CHECK (
        starts_at IS NULL
        OR ends_at IS NULL
        OR ends_at > starts_at
      )`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pricing_rules_rid_active
      ON public.pricing_rules (restaurant_id, active, priority);
    `);

    // =====================================================
    // HAPPY HOUR
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.happy_hours (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        manual_live BOOLEAN NOT NULL DEFAULT FALSE,
        mode TEXT NOT NULL DEFAULT 'manual',
        item_scope TEXT NOT NULL DEFAULT 'all',
        category_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        item_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        discount_type TEXT NOT NULL DEFAULT 'percent',
        discount_value NUMERIC(10,2) NOT NULL DEFAULT 0,
        starts_at TIMESTAMPTZ,
        ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT happy_hours_mode_check
          CHECK (mode IN ('manual', 'scheduled')),
        CONSTRAINT happy_hours_scope_check
          CHECK (
            item_scope IN (
              'all',
              'meals',
              'drinks',
              'desserts',
              'category',
              'item'
            )
          ),
        CONSTRAINT happy_hours_discount_type_check
          CHECK (discount_type IN ('percent', 'fixed')),
        CONSTRAINT happy_hours_discount_value_check
          CHECK (
            discount_value > 0
            AND (
              discount_type <> 'percent'
              OR discount_value <= 100
            )
          ),
        CONSTRAINT happy_hours_range_check
          CHECK (
            starts_at IS NULL
            OR ends_at IS NULL
            OR ends_at > starts_at
          )
      );
    `);

    await ensureColumns(
      client,
      "happy_hours",
      [
        ["name", "TEXT NOT NULL"],
        ["enabled", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["manual_live", "BOOLEAN NOT NULL DEFAULT FALSE"],
        ["mode", "TEXT NOT NULL DEFAULT 'manual'"],
        ["item_scope", "TEXT NOT NULL DEFAULT 'all'"],
        ["category_ids", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
        ["item_ids", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
        ["discount_type", "TEXT NOT NULL DEFAULT 'percent'"],
        ["discount_value", "NUMERIC(10,2) NOT NULL DEFAULT 0"],
        ["starts_at", "TIMESTAMPTZ"],
        ["ends_at", "TIMESTAMPTZ"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
        ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
      ]
    );

    await ensureConstraint(
      client,
      "happy_hours",
      "happy_hours_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "happy_hours",
      "happy_hours_mode_check",
      `CHECK (mode IN ('manual', 'scheduled'))`
    );

    await ensureConstraint(
      client,
      "happy_hours",
      "happy_hours_scope_check",
      `CHECK (
        item_scope IN (
          'all',
          'meals',
          'drinks',
          'desserts',
          'category',
          'item'
        )
      )`
    );

    await ensureConstraint(
      client,
      "happy_hours",
      "happy_hours_discount_type_check",
      `CHECK (discount_type IN ('percent', 'fixed'))`
    );

    await ensureConstraint(
      client,
      "happy_hours",
      "happy_hours_discount_value_check",
      `CHECK (
        discount_value > 0
        AND (
          discount_type <> 'percent'
          OR discount_value <= 100
        )
      )`
    );

    await ensureConstraint(
      client,
      "happy_hours",
      "happy_hours_range_check",
      `CHECK (
        starts_at IS NULL
        OR ends_at IS NULL
        OR ends_at > starts_at
      )`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_happy_hours_rid
      ON public.happy_hours (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_happy_hours_live
      ON public.happy_hours (restaurant_id, enabled, manual_live);
    `);

    // =====================================================
    // VOUCHERS
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.vouchers (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        discount_type TEXT NOT NULL,
        discount_value NUMERIC(12,2) NOT NULL,
        min_spend NUMERIC(12,2),
        usage_limit INTEGER,
        used_count INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        dine_in_only BOOLEAN NOT NULL DEFAULT FALSE,
        takeaway_only BOOLEAN NOT NULL DEFAULT FALSE,
        starts_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        usage_mode TEXT NOT NULL DEFAULT 'multi',
        redeemed_at TIMESTAMPTZ,
        CONSTRAINT vouchers_restaurant_code_unique
          UNIQUE (restaurant_id, code),
        CONSTRAINT vouchers_discount_type_check
          CHECK (discount_type IN ('percent', 'fixed')),
        CONSTRAINT vouchers_discount_value_check
          CHECK (
            discount_value > 0
            AND (
              discount_type <> 'percent'
              OR discount_value <= 100
            )
          ),
        CONSTRAINT vouchers_min_spend_check
          CHECK (min_spend IS NULL OR min_spend >= 0),
        CONSTRAINT vouchers_usage_limit_check
          CHECK (usage_limit IS NULL OR usage_limit >= 1),
        CONSTRAINT vouchers_used_count_check
          CHECK (used_count >= 0),
        CONSTRAINT vouchers_usage_mode_check
          CHECK (usage_mode IN ('single', 'multi')),
        CONSTRAINT vouchers_range_check
          CHECK (
            starts_at IS NULL
            OR expires_at IS NULL
            OR expires_at > starts_at
          )
      );
    `);

    await ensureColumns(
      client,
      "vouchers",
      [
        ["name", "TEXT NOT NULL"],
        ["code", "TEXT NOT NULL"],
        ["discount_type", "TEXT NOT NULL"],
        ["discount_value", "NUMERIC(12,2) NOT NULL"],
        ["min_spend", "NUMERIC(12,2)"],
        ["usage_limit", "INTEGER"],
        ["used_count", "INTEGER NOT NULL DEFAULT 0"],
        ["active", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["dine_in_only", "BOOLEAN NOT NULL DEFAULT FALSE"],
        ["takeaway_only", "BOOLEAN NOT NULL DEFAULT FALSE"],
        ["starts_at", "TIMESTAMPTZ"],
        ["expires_at", "TIMESTAMPTZ"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
        ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
        ["usage_mode", "TEXT NOT NULL DEFAULT 'multi'"],
        ["redeemed_at", "TIMESTAMPTZ"],
      ]
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_restaurant_code_unique",
      `UNIQUE (restaurant_id, code)`
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_discount_type_check",
      `CHECK (discount_type IN ('percent', 'fixed'))`
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_discount_value_check",
      `CHECK (
        discount_value > 0
        AND (
          discount_type <> 'percent'
          OR discount_value <= 100
        )
      )`
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_min_spend_check",
      `CHECK (min_spend IS NULL OR min_spend >= 0)`
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_usage_limit_check",
      `CHECK (usage_limit IS NULL OR usage_limit >= 1)`
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_used_count_check",
      `CHECK (used_count >= 0)`
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_usage_mode_check",
      `CHECK (usage_mode IN ('single', 'multi'))`
    );

    await ensureConstraint(
      client,
      "vouchers",
      "vouchers_range_check",
      `CHECK (
        starts_at IS NULL
        OR expires_at IS NULL
        OR expires_at > starts_at
      )`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vouchers_restaurant_id
      ON public.vouchers (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vouchers_restaurant_code
      ON public.vouchers (restaurant_id, code);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vouchers_active
      ON public.vouchers (restaurant_id, active);
    `);

    // =====================================================
    // RESTAURANT PROMOTIONS
    // orgRoutes currently creates only a historical subset,
    // while its POST path writes the complete structure below.
    // Canonical bootstrap owns the full runtime shape.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.restaurant_promotions (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        title TEXT,
        description TEXT,
        image_url TEXT,
        display_context TEXT NOT NULL DEFAULT 'both',
        order_type TEXT NOT NULL DEFAULT 'both',
        linked_item_id BIGINT,
        linked_item_type TEXT,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        show_on_qr BOOLEAN NOT NULL DEFAULT TRUE,
        show_on_kiosk BOOLEAN NOT NULL DEFAULT TRUE,
        show_on_eat_in BOOLEAN NOT NULL DEFAULT TRUE,
        show_on_takeaway BOOLEAN NOT NULL DEFAULT TRUE,
        show_for_dine_in BOOLEAN NOT NULL DEFAULT TRUE,
        show_for_takeaway BOOLEAN NOT NULL DEFAULT TRUE,
        button_text TEXT DEFAULT 'View',
        action_type TEXT DEFAULT 'none',
        action_target TEXT,
        start_at TIMESTAMPTZ,
        end_at TIMESTAMPTZ,
        sort_order INTEGER NOT NULL DEFAULT 0,
        promotion_type TEXT DEFAULT 'general',
        button_action TEXT DEFAULT 'none',
        linked_category_id BIGINT,
        start_date DATE,
        end_date DATE,
        start_time TIME,
        end_time TIME,
        meal_period TEXT DEFAULT 'all',
        days_of_week JSONB DEFAULT '[]'::jsonb,
        priority INTEGER DEFAULT 0,
        event_date DATE,
        event_time TIME,
        event_end_time TIME
      );
    `);

    await ensureColumns(
      client,
      "restaurant_promotions",
      [
        ["show_on_qr", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["show_on_kiosk", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["show_on_eat_in", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["show_on_takeaway", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["show_for_dine_in", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["show_for_takeaway", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["button_text", "TEXT DEFAULT 'View'"],
        ["action_type", "TEXT DEFAULT 'none'"],
        ["action_target", "TEXT"],
        ["start_at", "TIMESTAMPTZ"],
        ["end_at", "TIMESTAMPTZ"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
        ["promotion_type", "TEXT DEFAULT 'general'"],
        ["button_action", "TEXT DEFAULT 'none'"],
        ["linked_category_id", "BIGINT"],
        ["start_date", "DATE"],
        ["end_date", "DATE"],
        ["start_time", "TIME"],
        ["end_time", "TIME"],
        ["meal_period", "TEXT DEFAULT 'all'"],
        ["days_of_week", "JSONB DEFAULT '[]'::jsonb"],
        ["priority", "INTEGER DEFAULT 0"],
        ["event_date", "DATE"],
        ["event_time", "TIME"],
        ["event_end_time", "TIME"],
      ]
    );

    await ensureConstraint(
      client,
      "restaurant_promotions",
      "restaurant_promotions_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_restaurant_promotions_rid
      ON public.restaurant_promotions (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_restaurant_promotions_rid_active
      ON public.restaurant_promotions (restaurant_id, active, sort_order);
    `);

    // =====================================================
    // VERIFY
    // =====================================================

    const { rows } = await client.query(`
      SELECT COUNT(*)::int AS table_count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(
          ARRAY[
            'pricing_rules',
            'happy_hours',
            'vouchers',
            'restaurant_promotions'
          ]::text[]
        );
    `);

    if (Number(rows[0]?.table_count || 0) !== 4) {
      throw new Error(
        `Canonical commercial pricing verification failed: expected 4 tables, found ${Number(rows[0]?.table_count || 0)}`
      );
    }

    await client.query("COMMIT");

    console.log(
      "✅ Canonical MAKS commercial pricing schema ready"
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
  runCanonicalCommercialPricingPg,
};
