// migrations/canonicalOrderLifecycle.pg.js

async function tableExists(client, table) {
  const { rows } = await client.query(
    `SELECT to_regclass($1) AS regclass`,
    [`public.${table}`]
  );

  return !!rows[0]?.regclass;
}

async function getColumn(
  client,
  table,
  column
) {
  const { rows } = await client.query(
    `
    SELECT
      data_type,
      udt_name,
      is_nullable,
      column_default
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

async function assertExistingColumnType(
  client,
  table,
  column,
  expectedUdt
) {
  if (!(await tableExists(client, table))) {
    return;
  }

  const col =
    await getColumn(
      client,
      table,
      column
    );

  if (!col) {
    return;
  }

  if (
    String(col.udt_name) !==
    String(expectedUdt)
  ) {
    throw new Error(
      `Canonical order lifecycle refused: public.${table}.${column} ` +
      `must be ${expectedUdt}, found ${col.udt_name}`
    );
  }
}

async function ensureColumns(
  client,
  table,
  columns
) {
  for (
    const [
      name,
      definition,
    ] of columns
  ) {
    await client.query(`
      ALTER TABLE public.${table}
      ADD COLUMN IF NOT EXISTS
      ${name} ${definition};
    `);
  }
}

async function ensureConstraint(
  client,
  table,
  constraintName,
  definition
) {
  const { rows } =
    await client.query(
      `
      SELECT 1
      FROM pg_constraint
      WHERE conname = $1
        AND conrelid = $2::regclass
      LIMIT 1
      `,
      [
        constraintName,
        `public.${table}`,
      ]
    );

  if (rows.length) {
    return;
  }

  await client.query(`
    ALTER TABLE public.${table}
    ADD CONSTRAINT ${constraintName}
    ${definition};
  `);
}

async function runCanonicalOrderLifecyclePg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !== "function"
  ) {
    throw new Error(
      "Canonical order lifecycle requires PostgreSQL pool"
    );
  }

  console.log(
    "🧾 Running canonical MAKS order lifecycle schema..."
  );

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    // =====================================================
    // FAIL-CLOSED TYPE PREFLIGHT
    // =====================================================

    await assertExistingColumnType(
      client,
      "order_batches",
      "id",
      "uuid"
    );

    await assertExistingColumnType(
      client,
      "orders",
      "batch_id",
      "uuid"
    );

    await assertExistingColumnType(
      client,
      "orders",
      "paid",
      "bool"
    );

    await assertExistingColumnType(
      client,
      "pos_orders",
      "batch_id",
      "uuid"
    );

    await assertExistingColumnType(
      client,
      "pos_orders",
      "paid",
      "int4"
    );

    // =====================================================
    // ORDER BATCHES
    // UUID = canonical batch identity
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS
      public.order_batches (
        id UUID
          PRIMARY KEY
          DEFAULT gen_random_uuid(),

        table_number TEXT
          NOT NULL,

        restaurant_id BIGINT
          NOT NULL,

        order_type TEXT
          DEFAULT 'dine-in',

        pickup_number INTEGER,

        delivery_status TEXT,
        delivery_code TEXT,

        requested_payment_method TEXT,

        created_at TIMESTAMPTZ
          DEFAULT NOW()
      );
    `);

    await ensureColumns(
      client,
      "order_batches",
      [
        [
          "order_type",
          "TEXT DEFAULT 'dine-in'",
        ],
        [
          "pickup_number",
          "INTEGER",
        ],
        [
          "delivery_status",
          "TEXT",
        ],
        [
          "delivery_code",
          "TEXT",
        ],
        [
          "requested_payment_method",
          "TEXT",
        ],
        [
          "created_at",
          "TIMESTAMPTZ DEFAULT NOW()",
        ],
      ]
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_order_batches_rid
      ON public.order_batches (
        restaurant_id
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_order_batches_table
      ON public.order_batches (
        table_number
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_order_batches_order_type
      ON public.order_batches (
        order_type
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_order_batches_pickup_number
      ON public.order_batches (
        restaurant_id,
        pickup_number
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_order_batches_rid_created
      ON public.order_batches (
        restaurant_id,
        created_at DESC
      );
    `);

    // =====================================================
    // ORDERS
    // KDS release / operational order event rows
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS
      public.orders (
        id BIGSERIAL
          PRIMARY KEY,

        table_number TEXT,

        items JSONB
          DEFAULT '[]'::jsonb,

        total_price REAL
          DEFAULT 0,

        paid BOOLEAN
          DEFAULT FALSE,

        created_at TIMESTAMPTZ
          DEFAULT NOW(),

        restaurant_id BIGINT
          NOT NULL,

        options JSONB
          DEFAULT '{}'::jsonb,

        note TEXT,
        special_requests TEXT,

        payment_method TEXT,
        paid_at TIMESTAMPTZ,

        order_type TEXT
          DEFAULT 'dine-in',

        meal_name TEXT,
        category TEXT,
        station TEXT,

        quantity INTEGER,

        order_status TEXT
          DEFAULT 'pending',

        batch_id UUID
          DEFAULT gen_random_uuid(),

        price_per_unit NUMERIC(10,2),

        category_id INTEGER,

        is_priority BOOLEAN
          NOT NULL
          DEFAULT FALSE
      );
    `);

    await ensureColumns(
      client,
      "orders",
      [
        [
          "items",
          "JSONB DEFAULT '[]'::jsonb",
        ],
        [
          "options",
          "JSONB DEFAULT '{}'::jsonb",
        ],
        ["note", "TEXT"],
        [
          "special_requests",
          "TEXT",
        ],
        [
          "payment_method",
          "TEXT",
        ],
        [
          "paid_at",
          "TIMESTAMPTZ",
        ],
        [
          "order_type",
          "TEXT DEFAULT 'dine-in'",
        ],
        ["meal_name", "TEXT"],
        ["category", "TEXT"],
        ["station", "TEXT"],
        ["quantity", "INTEGER"],
        [
          "order_status",
          "TEXT DEFAULT 'pending'",
        ],
        [
          "batch_id",
          "UUID DEFAULT gen_random_uuid()",
        ],
        [
          "price_per_unit",
          "NUMERIC(10,2)",
        ],
        [
          "category_id",
          "INTEGER",
        ],
        [
          "is_priority",
          "BOOLEAN NOT NULL DEFAULT FALSE",
        ],
      ]
    );

    await ensureConstraint(
      client,
      "orders",
      "fk_orders_rest",
      `
      FOREIGN KEY (
        restaurant_id
      )
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
      `
    );

    const orderIndexes = [
      `
      CREATE INDEX IF NOT EXISTS
      idx_orders_rid
      ON public.orders (
        restaurant_id
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_orders_batch
      ON public.orders (
        batch_id
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_orders_rest_batch
      ON public.orders (
        restaurant_id,
        batch_id
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_orders_rest_created
      ON public.orders (
        restaurant_id,
        created_at
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_orders_status
      ON public.orders (
        order_status
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_orders_table
      ON public.orders (
        table_number
      )
      `,
    ];

    for (
      const sql of orderIndexes
    ) {
      await client.query(sql);
    }

    // =====================================================
    // POS ORDERS
    // Commercial bill + KDS source
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS
      public.pos_orders (
        id BIGSERIAL
          PRIMARY KEY,

        table_number TEXT,

        item_id BIGINT,
        item_name TEXT,

        quantity REAL
          DEFAULT 1,

        total_price REAL
          DEFAULT 0,

        order_status TEXT
          DEFAULT 'open',

        item_type TEXT
          DEFAULT 'meal',

        created_at TIMESTAMPTZ
          DEFAULT NOW(),

        restaurant_id BIGINT
          NOT NULL,

        paid INTEGER
          DEFAULT 0,

        options JSONB
          DEFAULT '{}'::jsonb,

        note TEXT,

        meal_id TEXT,

        batch_id UUID,

        category_id INTEGER,

        menu_item_id BIGINT,
        stock_id BIGINT,

        invoice_number INTEGER,

        is_starred BOOLEAN
          NOT NULL
          DEFAULT FALSE,

        table_allergy_codes JSONB,
        item_allergen_contains JSONB,
        allergen_conflicts JSONB,

        strict_cross_contamination BOOLEAN
          NOT NULL
          DEFAULT FALSE,

        table_covers INTEGER
          DEFAULT 1,

        amount_paid REAL
          DEFAULT 0,

        remaining_price REAL,

        is_priority BOOLEAN
          NOT NULL
          DEFAULT FALSE,

        kds_archived_at TIMESTAMPTZ,

        source TEXT
          DEFAULT 'pos',

        expires_at TIMESTAMPTZ,

        vat_rate NUMERIC(6,3),
        vat_gross NUMERIC(12,2),
        vat_net NUMERIC(12,2),
        vat_amount NUMERIC(12,2)
      );
    `);

    await ensureColumns(
      client,
      "pos_orders",
      [
        ["item_id", "BIGINT"],
        ["item_name", "TEXT"],
        [
          "item_type",
          "TEXT DEFAULT 'meal'",
        ],
        [
          "paid",
          "INTEGER DEFAULT 0",
        ],
        [
          "options",
          "JSONB DEFAULT '{}'::jsonb",
        ],
        ["note", "TEXT"],
        ["meal_id", "TEXT"],
        ["batch_id", "UUID"],
        [
          "category_id",
          "INTEGER",
        ],
        [
          "menu_item_id",
          "BIGINT",
        ],
        ["stock_id", "BIGINT"],
        [
          "invoice_number",
          "INTEGER",
        ],
        [
          "is_starred",
          "BOOLEAN NOT NULL DEFAULT FALSE",
        ],
        [
          "table_allergy_codes",
          "JSONB",
        ],
        [
          "item_allergen_contains",
          "JSONB",
        ],
        [
          "allergen_conflicts",
          "JSONB",
        ],
        [
          "strict_cross_contamination",
          "BOOLEAN NOT NULL DEFAULT FALSE",
        ],
        [
          "table_covers",
          "INTEGER DEFAULT 1",
        ],
        [
          "amount_paid",
          "REAL DEFAULT 0",
        ],
        [
          "remaining_price",
          "REAL",
        ],
        [
          "is_priority",
          "BOOLEAN NOT NULL DEFAULT FALSE",
        ],
        [
          "kds_archived_at",
          "TIMESTAMPTZ",
        ],
        [
          "source",
          "TEXT DEFAULT 'pos'",
        ],
        [
          "expires_at",
          "TIMESTAMPTZ",
        ],
        [
          "vat_rate",
          "NUMERIC(6,3)",
        ],
        [
          "vat_gross",
          "NUMERIC(12,2)",
        ],
        [
          "vat_net",
          "NUMERIC(12,2)",
        ],
        [
          "vat_amount",
          "NUMERIC(12,2)",
        ],
      ]
    );

    await ensureConstraint(
      client,
      "pos_orders",
      "fk_pos_orders_rest",
      `
      FOREIGN KEY (
        restaurant_id
      )
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
      `
    );

    const posIndexes = [
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_rid
      ON public.pos_orders (
        restaurant_id
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_table
      ON public.pos_orders (
        table_number
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_paid
      ON public.pos_orders (
        paid
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_batch
      ON public.pos_orders (
        batch_id
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_meal_id
      ON public.pos_orders (
        meal_id
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_menu_item_id
      ON public.pos_orders (
        menu_item_id
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_stock_id
      ON public.pos_orders (
        stock_id
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_star
      ON public.pos_orders (
        restaurant_id,
        is_starred
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_remaining_price
      ON public.pos_orders (
        restaurant_id,
        remaining_price
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_source
      ON public.pos_orders (
        restaurant_id,
        source
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_rest_table_paid
      ON public.pos_orders (
        restaurant_id,
        table_number,
        paid,
        created_at
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS
      idx_pos_orders_kds_archive
      ON public.pos_orders (
        restaurant_id,
        kds_archived_at,
        created_at
      )
      `,
    ];

    for (
      const sql of posIndexes
    ) {
      await client.query(sql);
    }

    // =====================================================
    // KITCHEN STATE
    // One pause state per restaurant
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS
      public.kitchen_state (
        restaurant_id BIGINT
          PRIMARY KEY,

        is_paused BOOLEAN
          NOT NULL
          DEFAULT FALSE,

        updated_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW()
      );
    `);

    await ensureColumns(
      client,
      "kitchen_state",
      [
        [
          "is_paused",
          "BOOLEAN NOT NULL DEFAULT FALSE",
        ],
        [
          "updated_at",
          "TIMESTAMPTZ NOT NULL DEFAULT NOW()",
        ],
      ]
    );

    await ensureConstraint(
      client,
      "kitchen_state",
      "kitchen_state_restaurant_id_fkey",
      `
      FOREIGN KEY (
        restaurant_id
      )
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
      `
    );

    // =====================================================
    // FINAL TYPE VERIFICATION
    // =====================================================

    await assertExistingColumnType(
      client,
      "order_batches",
      "id",
      "uuid"
    );

    await assertExistingColumnType(
      client,
      "orders",
      "batch_id",
      "uuid"
    );

    await assertExistingColumnType(
      client,
      "orders",
      "paid",
      "bool"
    );

    await assertExistingColumnType(
      client,
      "pos_orders",
      "batch_id",
      "uuid"
    );

    await assertExistingColumnType(
      client,
      "pos_orders",
      "paid",
      "int4"
    );

    const { rows } =
      await client.query(`
        SELECT
          COUNT(*)::int
            AS table_count
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY(
            ARRAY[
              'orders',
              'pos_orders',
              'order_batches',
              'kitchen_state'
            ]::text[]
          );
      `);

    if (
      Number(
        rows[0]?.table_count || 0
      ) !== 4
    ) {
      throw new Error(
        "Canonical order lifecycle verification failed"
      );
    }

    await client.query("COMMIT");

    console.log(
      "✅ Canonical MAKS order lifecycle schema ready"
    );
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch (_) {
      // Preserve original error.
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  runCanonicalOrderLifecyclePg,
};
