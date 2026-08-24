// migrations/boot.pg.js
const { ensureColumnPg } = require('./pgSchema');

/**
 * Boot schema for Postgres.
 * - Creates core tables
 * - Adds missing columns safely (ensureColumnPg)
 * - Adds indexes + unique constraints for multi-tenant safety
 */
async function runBootMigrationsPg({ qRun, qGet }) {
  console.log('🧱 Running Postgres boot migrations...');

  // ---- CORE TABLES ----

  await qRun(`
    CREATE TABLE IF NOT EXISTS roles (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      permissions JSONB NOT NULL
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      restaurant_id BIGINT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      website TEXT,
      phone TEXT,
      contact_name TEXT,
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS categories (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'meal', -- meal/drink/dessert/other
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS tables (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      seats INTEGER DEFAULT 0,
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS table_map (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      shape TEXT DEFAULT 'square',
      seats INTEGER DEFAULT 0,
      x REAL DEFAULT 0,
      y REAL DEFAULT 0,
      zone TEXT,
      status TEXT DEFAULT 'available',
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS kitchen_settings (
      id BIGSERIAL PRIMARY KEY,
      restaurant_id BIGINT UNIQUE,
      is_paused BOOLEAN DEFAULT FALSE
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS stock (
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
      type TEXT DEFAULT 'ingredient', -- ingredient/drink/dessert/etc
      supplier_id BIGINT,
      category TEXT,
      restaurant_id BIGINT,
      CONSTRAINT ux_stock_ingredient_rid UNIQUE (ingredient, restaurant_id)
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS meals (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      ingredients JSONB DEFAULT '[]'::jsonb,   -- (if you store JSON array)
      allergens TEXT,
      calories REAL,
      price REAL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      user_id BIGINT,
      category TEXT,
      supplier_id BIGINT,
      paused BOOLEAN DEFAULT FALSE,
      options_schema JSONB,
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS meal_ingredients (
      id BIGSERIAL PRIMARY KEY,
      meal_id BIGINT NOT NULL,
      ingredient TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      unit TEXT DEFAULT 'g',
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS prepped_items (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      restaurant_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS meal_prepped_ingredients (
      id BIGSERIAL PRIMARY KEY,
      meal_id BIGINT NOT NULL,
      prepped_item_id BIGINT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      unit TEXT DEFAULT 'g',
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      table_number TEXT,
      items JSONB DEFAULT '[]'::jsonb,
      total_price REAL DEFAULT 0,
      paid BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS order_batches (
      id BIGSERIAL PRIMARY KEY,
      batch_id TEXT,
      table_number TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS pos_orders (
      id BIGSERIAL PRIMARY KEY,
      table_number TEXT,
      item_id BIGINT,
      item_name TEXT,
      quantity REAL DEFAULT 1,
      total_price REAL DEFAULT 0,
      order_status TEXT DEFAULT 'open',
      item_type TEXT DEFAULT 'meal', -- meal/drink/dessert
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT,
      phone TEXT,
      booking_time TIMESTAMPTZ,
      guests INTEGER DEFAULT 1,
      notes TEXT,
      table_name TEXT,
      status TEXT DEFAULT 'booked',
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS checklists (
      id BIGSERIAL PRIMARY KEY,
      folder_name TEXT,
      day_key TEXT,
      shift TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS checklist_items (
      id BIGSERIAL PRIMARY KEY,
      checklist_id BIGINT NOT NULL,
      label TEXT NOT NULL,
      is_done BOOLEAN DEFAULT FALSE,
      staff_name TEXT,
      signed_at TIMESTAMPTZ,
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS appliances (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS appliance_checks (
      id BIGSERIAL PRIMARY KEY,
      appliance_id BIGINT NOT NULL,
      temperature REAL,
      checked_at TIMESTAMPTZ DEFAULT NOW(),
      staff_name TEXT,
      shift TEXT,
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS supplier_prices (
      id BIGSERIAL PRIMARY KEY,
      ingredient TEXT NOT NULL,
      supplier_id BIGINT,
      price_per_unit REAL NOT NULL DEFAULT 0,
      unit TEXT DEFAULT 'unit',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS menus (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      layout JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      type TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS stock_alerts (
      id BIGSERIAL PRIMARY KEY,
      ingredient TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS cash_drawer (
      id BIGSERIAL PRIMARY KEY,
      opened_at TIMESTAMPTZ DEFAULT NOW(),
      opened_by TEXT,
      restaurant_id BIGINT
    );
  `);

  await qRun(`
    CREATE TABLE IF NOT EXISTS cashups (
      id BIGSERIAL PRIMARY KEY,
      total_cash REAL DEFAULT 0,
      total_card REAL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      restaurant_id BIGINT
    );
  `);

  // ---- ENSURE-COLUMNS (SAFE ADD) ----
  await ensureColumnPg(qGet, qRun, 'orders', 'options', 'JSONB DEFAULT \'{}\'::jsonb');
  await ensureColumnPg(qGet, qRun, 'orders', 'note', 'TEXT');
  await ensureColumnPg(qGet, qRun, 'orders', 'special_requests', 'TEXT');
  await ensureColumnPg(qGet, qRun, 'orders', 'payment_method', 'TEXT');
  await ensureColumnPg(qGet, qRun, 'orders', 'paid_at', 'TIMESTAMPTZ');
  await ensureColumnPg(qGet, qRun, 'orders', 'order_type', 'TEXT DEFAULT \'dine-in\'');

  // ---- INDEXES + UNIQUES (multi-tenant commercial safety) ----
  const RID_TABLES = [
    'orders','order_batches','meals','meal_ingredients','stock','supplier_prices',
    'suppliers','tables','table_map','bookings','prepped_items','meal_prepped_ingredients',
    'checklists','checklist_items','appliances','appliance_checks','cash_drawer','cashups',
    'reports','menus','stock_alerts','categories','kitchen_settings','pos_orders','users'
  ];

  for (const t of RID_TABLES) {
    await qRun(`CREATE INDEX IF NOT EXISTS idx_${t}_rid ON "${t}" (restaurant_id);`);
  }

  await qRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_tables_name_rid ON tables(name, restaurant_id);`);
  await qRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_table_map_name_rid ON table_map(name, restaurant_id);`);
  await qRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_suppliers_name_rid ON suppliers(name, restaurant_id);`);
  await qRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_rest_type_name ON categories(restaurant_id, type, name);`);

    // =====================================================
  // ATTACK MAKS — SECURITY VERIFICATION RUNS
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS public.cc_attack_runs (
      id BIGSERIAL PRIMARY KEY,

      status TEXT NOT NULL DEFAULT 'queued',

      started_by_admin_id BIGINT,
      started_by_email TEXT,

      environment TEXT NOT NULL DEFAULT 'maks_test',
      database_name TEXT NOT NULL DEFAULT 'maks_test',

      total_tests INTEGER NOT NULL DEFAULT 0,
      passed_tests INTEGER NOT NULL DEFAULT 0,
      failed_tests INTEGER NOT NULL DEFAULT 0,
      skipped_tests INTEGER NOT NULL DEFAULT 0,
      cancelled_tests INTEGER NOT NULL DEFAULT 0,
      todo_tests INTEGER NOT NULL DEFAULT 0,

      duration_ms BIGINT NOT NULL DEFAULT 0,

      suite_results JSONB NOT NULL DEFAULT '[]'::jsonb,
      failures JSONB NOT NULL DEFAULT '[]'::jsonb,

      output_tail TEXT,

      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT cc_attack_runs_status_check
        CHECK (
          status IN (
            'queued',
            'running',
            'passed',
            'failed',
            'error',
            'cancelled'
          )
        )
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS idx_cc_attack_runs_created_at
      ON public.cc_attack_runs (created_at DESC);
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS idx_cc_attack_runs_status
      ON public.cc_attack_runs (status);
  `);
  
  // ---- SEED ROLES ----
  const defaults = {
    owner: ['*'],
    admin: ['pos.*','kds.*','orders.*','stock.*','menus.*','reports.*','bookings.*','suppliers.*','users.*','analytics.view','settings.edit'],
    chef:  ['kds.view','kds.update','orders.view','orders.update','preplist.view','preplist.update','stock.view'],
    staff: ['pos.view','pos.create','orders.view','orders.create','tables.view','tables.update']
  };

  for (const [k, perms] of Object.entries(defaults)) {
    await qRun(
      `INSERT INTO roles (key, name, permissions)
       VALUES ($1,$2,$3)
       ON CONFLICT (key) DO NOTHING`,
      [k, k[0].toUpperCase() + k.slice(1), JSON.stringify(perms)]
    );
  }

  console.log('✅ Postgres boot migrations complete');
}

module.exports = { runBootMigrationsPg };
