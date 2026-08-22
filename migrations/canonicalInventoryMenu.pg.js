// migrations/canonicalInventoryMenu.pg.js

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

async function runCanonicalInventoryMenuPg({ pool }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error(
      "Canonical inventory/menu schema requires PostgreSQL pool"
    );
  }

  console.log(
    "📦 Running canonical MAKS inventory/menu schema..."
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =====================================================
    // PLATFORM SUPPLIER DIRECTORY
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.platform_suppliers (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        website TEXT,
        phone TEXT,
        contact_name TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT platform_suppliers_slug_key UNIQUE (slug)
      );
    `);

    await ensureColumns(
      client,
      "platform_suppliers",
      [
        ["website", "TEXT"],
        ["phone", "TEXT"],
        ["contact_name", "TEXT"],
        ["is_active", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
      ]
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.platform_supplier_products (
        id BIGSERIAL PRIMARY KEY,
        platform_supplier_id BIGINT NOT NULL,
        product_code TEXT,
        unit_of_order_code TEXT,
        product_name TEXT NOT NULL,
        quantity_type TEXT,
        product_group TEXT,
        marketplace_category TEXT,
        extra_product_details TEXT,
        price NUMERIC(10,2),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pack_count NUMERIC,
        unit_size NUMERIC,
        unit TEXT,
        total_quantity NUMERIC,
        pack_description TEXT,
        display_quantity NUMERIC,
        display_unit TEXT
      );
    `);

    await ensureConstraint(
      client,
      "platform_supplier_products",
      "platform_supplier_products_platform_supplier_id_fkey",
      `FOREIGN KEY (platform_supplier_id)
       REFERENCES public.platform_suppliers(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_supplier_products_supplier
      ON public.platform_supplier_products (platform_supplier_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_supplier_products_name
      ON public.platform_supplier_products (LOWER(TRIM(product_name)));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_supplier_products_code
      ON public.platform_supplier_products (LOWER(TRIM(product_code)));
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_platform_supplier_products_supplier_code
      ON public.platform_supplier_products (platform_supplier_id, product_code)
      WHERE product_code IS NOT NULL
        AND TRIM(product_code) <> '';
    `);

    // =====================================================
    // CATEGORIES
    // Active routes use restaurant_id + name as the
    // conflict identity, so this pair must be unique.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.categories (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'meals',
        restaurant_id BIGINT NOT NULL,
        icon TEXT DEFAULT '🍽️',
        station TEXT
      );
    `);

    await ensureColumns(
      client,
      "categories",
      [
        ["icon", "TEXT DEFAULT '🍽️'"],
        ["station", "TEXT"],
      ]
    );

    await ensureConstraint(
      client,
      "categories",
      "fk_categories_rest",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_rest_name
      ON public.categories (restaurant_id, name);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_rest_type_name
      ON public.categories (restaurant_id, type, name);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_categories_rid
      ON public.categories (restaurant_id);
    `);

    // =====================================================
    // RESTAURANT SUPPLIERS
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.suppliers (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        website TEXT,
        phone TEXT,
        contact_name TEXT,
        restaurant_id BIGINT NOT NULL,
        delivery_days TEXT DEFAULT '',
        platform_supplier_id BIGINT
      );
    `);

    await ensureColumns(
      client,
      "suppliers",
      [
        ["delivery_days", "TEXT DEFAULT ''"],
        ["platform_supplier_id", "BIGINT"],
      ]
    );

    await ensureConstraint(
      client,
      "suppliers",
      "fk_suppliers_rest",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "suppliers",
      "suppliers_platform_supplier_id_fkey",
      `FOREIGN KEY (platform_supplier_id)
       REFERENCES public.platform_suppliers(id)
       ON DELETE SET NULL`
    );

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_suppliers_name_rid
      ON public.suppliers (name, restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_suppliers_rid
      ON public.suppliers (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_suppliers_platform_supplier_id
      ON public.suppliers (platform_supplier_id);
    `);

    // =====================================================
    // SUPPLIER PRICES
    // price_per_unit is the canonical field used by the
    // Ordering Hub. supplierRoutes exposes it as API "price".
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.supplier_prices (
        id BIGSERIAL PRIMARY KEY,
        ingredient TEXT NOT NULL,
        supplier_id BIGINT NOT NULL,
        price_per_unit REAL NOT NULL DEFAULT 0,
        unit TEXT DEFAULT 'unit',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        restaurant_id BIGINT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual'
      );
    `);

    await ensureColumns(
      client,
      "supplier_prices",
      [
        ["price_per_unit", "REAL NOT NULL DEFAULT 0"],
        ["unit", "TEXT DEFAULT 'unit'"],
        ["created_at", "TIMESTAMPTZ DEFAULT NOW()"],
        ["source", "TEXT DEFAULT 'manual'"],
      ]
    );

    await ensureConstraint(
      client,
      "supplier_prices",
      "supplier_prices_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "supplier_prices",
      "supplier_prices_supplier_id_fkey",
      `FOREIGN KEY (supplier_id)
       REFERENCES public.suppliers(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_prices_rid_supplier_ingredient
      ON public.supplier_prices (
        restaurant_id,
        supplier_id,
        ingredient
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_supplier_prices_rid
      ON public.supplier_prices (restaurant_id);
    `);

    // =====================================================
    // STOCK
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.stock (
        id BIGSERIAL PRIMARY KEY,
        ingredient TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 0,
        unit TEXT DEFAULT 'unit',
        price REAL DEFAULT 0,
        allergens TEXT DEFAULT 'None',
        calories_per_100g REAL DEFAULT 0,
        expiry_date TEXT,
        minimum_level REAL DEFAULT 0,
        portions_left REAL DEFAULT 0,
        type TEXT DEFAULT 'ingredient',
        supplier_id BIGINT,
        category TEXT,
        restaurant_id BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        min_threshold NUMERIC,
        base_name TEXT,
        category_id BIGINT,
        CONSTRAINT ux_stock_ingredient_rid
          UNIQUE (ingredient, restaurant_id)
      );
    `);

    await ensureColumns(
      client,
      "stock",
      [
        ["created_at", "TIMESTAMPTZ DEFAULT NOW()"],
        ["updated_at", "TIMESTAMPTZ DEFAULT NOW()"],
        ["min_threshold", "NUMERIC"],
        ["base_name", "TEXT"],
        ["category_id", "BIGINT"],
      ]
    );

    await ensureConstraint(
      client,
      "stock",
      "fk_stock_rest",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "stock",
      "stock_category_fk",
      `FOREIGN KEY (category_id)
       REFERENCES public.categories(id)
       ON DELETE SET NULL`
    );

    await ensureConstraint(
      client,
      "stock",
      "stock_supplier_id_fkey",
      `FOREIGN KEY (supplier_id)
       REFERENCES public.suppliers(id)
       ON DELETE SET NULL`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_rid
      ON public.stock (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_rid_base
      ON public.stock (restaurant_id, base_name);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_rid_category
      ON public.stock (restaurant_id, category_id);
    `);

    // =====================================================
    // MEALS
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.meals (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        ingredients JSONB DEFAULT '[]'::jsonb,
        allergens TEXT,
        calories REAL,
        price REAL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        user_id BIGINT,
        category TEXT,
        supplier_id BIGINT,
        paused BOOLEAN DEFAULT FALSE,
        options_schema JSONB,
        restaurant_id BIGINT NOT NULL,
        category_id BIGINT,
        is_available BOOLEAN NOT NULL DEFAULT TRUE,
        out_of_stock BOOLEAN NOT NULL DEFAULT FALSE,
        photo_url TEXT,
        manual_portions_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        manual_portions_available INTEGER,
        vat_rate NUMERIC(5,2),
        availability_mode TEXT NOT NULL DEFAULT 'maks',
        manual_quantity INTEGER,
        manually_stopped BOOLEAN NOT NULL DEFAULT FALSE,
        CONSTRAINT meals_availability_mode_valid
          CHECK (availability_mode IN ('maks', 'manual', 'unlimited')),
        CONSTRAINT meals_manual_quantity_valid
          CHECK (manual_quantity IS NULL OR manual_quantity >= 0),
        CONSTRAINT meals_vat_rate_valid
          CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100))
      );
    `);

    await ensureColumns(
      client,
      "meals",
      [
        ["category_id", "BIGINT"],
        ["is_available", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["out_of_stock", "BOOLEAN NOT NULL DEFAULT FALSE"],
        ["photo_url", "TEXT"],
        ["manual_portions_enabled", "BOOLEAN NOT NULL DEFAULT FALSE"],
        ["manual_portions_available", "INTEGER"],
        ["vat_rate", "NUMERIC(5,2)"],
        ["availability_mode", "TEXT NOT NULL DEFAULT 'maks'"],
        ["manual_quantity", "INTEGER"],
        ["manually_stopped", "BOOLEAN NOT NULL DEFAULT FALSE"],
      ]
    );

    await ensureConstraint(
      client,
      "meals",
      "fk_meals_rest",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "meals",
      "meals_category_fk",
      `FOREIGN KEY (category_id)
       REFERENCES public.categories(id)
       ON DELETE SET NULL`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_meals_rid
      ON public.meals (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_meals_rid_catid
      ON public.meals (restaurant_id, category_id);
    `);

    // =====================================================
    // MEAL INGREDIENTS
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.meal_ingredients (
        id BIGSERIAL PRIMARY KEY,
        meal_id BIGINT NOT NULL,
        ingredient TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        unit TEXT DEFAULT 'g',
        restaurant_id BIGINT NOT NULL,
        quantity REAL
      );
    `);

    await ensureColumns(
      client,
      "meal_ingredients",
      [
        ["quantity", "REAL"],
      ]
    );

    await ensureConstraint(
      client,
      "meal_ingredients",
      "meal_ingredients_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_meal_ingredients_rid
      ON public.meal_ingredients (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_meal_ingredients_meal
      ON public.meal_ingredients (restaurant_id, meal_id);
    `);

    // =====================================================
    // MENU ITEM INGREDIENT LINKS
    // Drinks / desserts use menu_items + this table.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.menu_item_ingredients (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        menu_item_id BIGINT NOT NULL,
        ingredient TEXT NOT NULL,
        amount NUMERIC(12,4) NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT 'g',
        stock_id BIGINT
      );
    `);

    await ensureConstraint(
      client,
      "menu_item_ingredients",
      "menu_item_ingredients_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "menu_item_ingredients",
      "menu_item_ingredients_menu_item_id_fkey",
      `FOREIGN KEY (menu_item_id)
       REFERENCES public.menu_items(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "menu_item_ingredients",
      "menu_item_ingredients_stock_id_fkey",
      `FOREIGN KEY (stock_id)
       REFERENCES public.stock(id)
       ON DELETE RESTRICT`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mii_item
      ON public.menu_item_ingredients (menu_item_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mii_restaurant
      ON public.menu_item_ingredients (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mii_stock
      ON public.menu_item_ingredients (restaurant_id, stock_id);
    `);

    // =====================================================
    // ITEM AVAILABILITY RESERVATIONS
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.item_availability_reservations (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        batch_id UUID NOT NULL,
        item_type TEXT NOT NULL,
        item_id BIGINT NOT NULL,
        item_name TEXT,
        availability_mode TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved',
        source TEXT NOT NULL DEFAULT 'pos',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        consumed_at TIMESTAMPTZ,
        released_at TIMESTAMPTZ,
        override_used BOOLEAN NOT NULL DEFAULT FALSE,
        override_reason TEXT,
        override_user_id BIGINT,
        CONSTRAINT item_availability_reservations_availability_mode_check
          CHECK (availability_mode IN ('maks', 'manual', 'unlimited')),
        CONSTRAINT item_availability_reservations_item_type_check
          CHECK (item_type IN ('meal', 'drink', 'dessert')),
        CONSTRAINT item_availability_reservations_quantity_check
          CHECK (quantity > 0),
        CONSTRAINT item_availability_reservations_status_check
          CHECK (status IN ('reserved', 'consumed', 'released')),
        CONSTRAINT item_availability_reservation_restaurant_id_batch_id_item_t_key
          UNIQUE (restaurant_id, batch_id, item_type, item_id)
      );
    `);

    await ensureConstraint(
      client,
      "item_availability_reservations",
      "item_availability_reservations_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_item_availability_res_batch
      ON public.item_availability_reservations (restaurant_id, batch_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_item_availability_res_status
      ON public.item_availability_reservations (restaurant_id, status);
    `);

    // =====================================================
    // ORDERING HISTORY
    // Current route stores a JSON purchase snapshot.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ordering_history (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        created_by_user_id BIGINT,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await ensureColumns(
      client,
      "ordering_history",
      [
        ["created_by_user_id", "BIGINT"],
        ["data", "JSONB NOT NULL DEFAULT '{}'::jsonb"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
      ]
    );

    await ensureConstraint(
      client,
      "ordering_history",
      "ordering_history_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ordering_history_rid_created
      ON public.ordering_history (restaurant_id, created_at DESC);
    `);

    // =====================================================
    // RESTOCK ORDERS
    // Still used by active drinks compatibility endpoint.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.restock_orders (
        id BIGSERIAL PRIMARY KEY,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        category TEXT DEFAULT 'drinks',
        ordered_at TIMESTAMPTZ DEFAULT NOW(),
        supplier_id BIGINT,
        type TEXT DEFAULT 'ingredient',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        restaurant_id BIGINT NOT NULL
      );
    `);

    await ensureConstraint(
      client,
      "restock_orders",
      "restock_orders_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_restock_orders_rid_created
      ON public.restock_orders (restaurant_id, created_at DESC);
    `);

    // =====================================================
    // VERIFICATION
    // =====================================================

    const { rows } = await client.query(`
      SELECT COUNT(*)::int AS table_count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(
          ARRAY[
            'platform_suppliers',
            'platform_supplier_products',
            'categories',
            'suppliers',
            'supplier_prices',
            'stock',
            'meals',
            'meal_ingredients',
            'menu_item_ingredients',
            'item_availability_reservations',
            'ordering_history',
            'restock_orders'
          ]::text[]
        );
    `);

    if (Number(rows[0]?.table_count || 0) !== 12) {
      throw new Error(
        `Canonical inventory/menu verification failed: expected 12 tables, found ${Number(rows[0]?.table_count || 0)}`
      );
    }

    await client.query("COMMIT");

    console.log(
      "✅ Canonical MAKS inventory/menu schema ready"
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
  runCanonicalInventoryMenuPg,
};
