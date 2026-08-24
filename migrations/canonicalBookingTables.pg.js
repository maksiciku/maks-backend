// migrations/canonicalBookingTables.pg.js

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
    SELECT
      data_type,
      udt_name,
      is_nullable
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

async function assertExistingType(
  client,
  table,
  column,
  allowedUdts
) {
  if (!(await tableExists(client, table))) return;

  const info = await getColumn(client, table, column);
  if (!info) return;

  if (!allowedUdts.includes(info.udt_name)) {
    throw new Error(
      `Canonical booking/table schema refused: public.${table}.${column} is ${info.udt_name}; expected ${allowedUdts.join(" or ")}`
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

async function ensureConstraint(
  client,
  table,
  name,
  definition
) {
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

async function assertNoRows(client, sql, message) {
  const { rows } = await client.query(sql);
  const count = Number(rows?.[0]?.count || 0);

  if (count > 0) {
    throw new Error(`${message}: ${count} offending row(s)`);
  }
}

async function runCanonicalBookingTablesPg({ pool }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error(
      "Canonical booking/table schema requires PostgreSQL pool"
    );
  }

  console.log(
    "🪑 Running canonical MAKS booking/table schema..."
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =====================================================
    // FAIL-CLOSED TYPE PREFLIGHT
    // =====================================================

    const idColumns = [
      ["tables", "id"],
      ["tables", "restaurant_id"],
      ["table_map", "id"],
      ["table_map", "restaurant_id"],
      ["bookings", "id"],
      ["bookings", "restaurant_id"],
      ["booking_tables", "booking_id"],
      ["booking_tables", "table_id"],
      ["booking_tables", "restaurant_id"],
      ["restaurant_customers", "id"],
      ["restaurant_customers", "restaurant_id"],
      ["pos_table_sessions", "table_id"],
      ["pos_table_sessions", "restaurant_id"],
    ];

    for (const [table, column] of idColumns) {
      await assertExistingType(
        client,
        table,
        column,
        ["int8"]
      );
    }

    await assertExistingType(
      client,
      "bookings",
      "booking_time",
      ["timestamptz"]
    );

    await assertExistingType(
      client,
      "bookings",
      "requested_booking_time",
      ["timestamptz"]
    );

    await assertExistingType(
      client,
      "bookings",
      "table_ids",
      ["_text"]
    );

    // =====================================================
    // TABLES
    // POS/booking source of truth for table identity/status.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tables (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        seats INTEGER DEFAULT 2,
        restaurant_id BIGINT NOT NULL,
        status TEXT DEFAULT 'free'
      );
    `);

    await ensureColumns(
      client,
      "tables",
      [
        ["name", "TEXT NOT NULL"],
        ["seats", "INTEGER DEFAULT 2"],
        ["restaurant_id", "BIGINT NOT NULL"],
        ["status", "TEXT DEFAULT 'free'"],
      ]
    );

    await ensureConstraint(
      client,
      "tables",
      "fk_tables_rest",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "tables",
      "tables_restaurant_id_id_key",
      `UNIQUE (restaurant_id, id)`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tables_rid
      ON public.tables (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tables_rid_name
      ON public.tables (restaurant_id, name);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_tables_rid_name
      ON public.tables (
        restaurant_id,
        LOWER(TRIM(name))
      );
    `);

    // =====================================================
    // TABLE MAP
    // Layout coordinates/zone/shape mirror canonical tables.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.table_map (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        shape TEXT DEFAULT 'square',
        seats INTEGER DEFAULT 2,
        x REAL DEFAULT 0,
        y REAL DEFAULT 0,
        zone TEXT DEFAULT 'Main',
        status TEXT DEFAULT 'free',
        restaurant_id BIGINT NOT NULL
      );
    `);

    await ensureColumns(
      client,
      "table_map",
      [
        ["name", "TEXT NOT NULL"],
        ["shape", "TEXT DEFAULT 'square'"],
        ["seats", "INTEGER DEFAULT 2"],
        ["x", "REAL DEFAULT 0"],
        ["y", "REAL DEFAULT 0"],
        ["zone", "TEXT DEFAULT 'Main'"],
        ["status", "TEXT DEFAULT 'free'"],
        ["restaurant_id", "BIGINT"],
      ]
    );

    await ensureConstraint(
      client,
      "table_map",
      "table_map_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_table_map_rid
      ON public.table_map (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_table_map_rid_name
      ON public.table_map (restaurant_id, name);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_table_map_rid_name
      ON public.table_map (
        restaurant_id,
        LOWER(TRIM(name))
      );
    `);

    // =====================================================
    // BOOKINGS
    // Includes customer self-service change/cancel fields.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.bookings (
        id BIGSERIAL PRIMARY KEY,
        customer_name TEXT,
        phone TEXT,
        booking_time TIMESTAMPTZ,
        guests INTEGER DEFAULT 1,
        notes TEXT,
        table_name TEXT,
        status TEXT DEFAULT 'booked',
        restaurant_id BIGINT NOT NULL,
        slot_min INTEGER NOT NULL DEFAULT 90,
        table_ids TEXT[],
        email TEXT,
        first_name TEXT,
        last_name TEXT,
        public_token TEXT,
        customer_cancelled_at TIMESTAMPTZ,
        change_requested_at TIMESTAMPTZ,
        requested_booking_time TIMESTAMPTZ,
        requested_guests INTEGER,
        requested_note TEXT
      );
    `);

    await ensureColumns(
      client,
      "bookings",
      [
        ["customer_name", "TEXT"],
        ["phone", "TEXT"],
        ["booking_time", "TIMESTAMPTZ"],
        ["guests", "INTEGER DEFAULT 1"],
        ["notes", "TEXT"],
        ["table_name", "TEXT"],
        ["status", "TEXT DEFAULT 'booked'"],
        ["restaurant_id", "BIGINT"],
        ["slot_min", "INTEGER NOT NULL DEFAULT 90"],
        ["table_ids", "TEXT[]"],
        ["email", "TEXT"],
        ["first_name", "TEXT"],
        ["last_name", "TEXT"],
        ["public_token", "TEXT"],
        ["customer_cancelled_at", "TIMESTAMPTZ"],
        ["change_requested_at", "TIMESTAMPTZ"],
        ["requested_booking_time", "TIMESTAMPTZ"],
        ["requested_guests", "INTEGER"],
        ["requested_note", "TEXT"],
      ]
    );

    await ensureConstraint(
      client,
      "bookings",
      "bookings_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "bookings",
      "bookings_restaurant_id_id_key",
      `UNIQUE (restaurant_id, id)`
    );

    await ensureConstraint(
      client,
      "bookings",
      "bookings_slot_min_positive",
      `CHECK (slot_min > 0)`
    );

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS bookings_public_token_idx
      ON public.bookings (public_token)
      WHERE public_token IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_rid
      ON public.bookings (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_rid_time
      ON public.bookings (restaurant_id, booking_time);
    `);

    // =====================================================
    // RESTAURANT CUSTOMER MEMORY
    // Required by staff/public booking customer recall.
    // The expression index exactly matches ON CONFLICT in
    // bookingRoutes/publicBookingRoutes.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.restaurant_customers (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        full_name TEXT,
        phone TEXT,
        email TEXT,
        notes TEXT,
        total_bookings INTEGER NOT NULL DEFAULT 0,
        last_booking_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        booking_email_opt_in BOOLEAN DEFAULT TRUE,
        marketing_email_opt_in BOOLEAN DEFAULT FALSE,
        birthday_opt_in BOOLEAN DEFAULT FALSE,
        gdpr_consent_at TIMESTAMPTZ
      );
    `);

    await ensureColumns(
      client,
      "restaurant_customers",
      [
        ["restaurant_id", "BIGINT NOT NULL"],
        ["first_name", "TEXT"],
        ["last_name", "TEXT"],
        ["full_name", "TEXT"],
        ["phone", "TEXT"],
        ["email", "TEXT"],
        ["notes", "TEXT"],
        ["total_bookings", "INTEGER NOT NULL DEFAULT 0"],
        ["last_booking_at", "TIMESTAMPTZ"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
        ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
        ["booking_email_opt_in", "BOOLEAN DEFAULT TRUE"],
        ["marketing_email_opt_in", "BOOLEAN DEFAULT FALSE"],
        ["birthday_opt_in", "BOOLEAN DEFAULT FALSE"],
        ["gdpr_consent_at", "TIMESTAMPTZ"],
      ]
    );

    await ensureConstraint(
      client,
      "restaurant_customers",
      "restaurant_customers_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_restaurant_customers_rid_phone
      ON public.restaurant_customers (restaurant_id, phone);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_restaurant_customers_rid_phone_clean
      ON public.restaurant_customers (
        restaurant_id,
        regexp_replace(
          COALESCE(phone, ''),
          '\\D',
          '',
          'g'
        )
      )
      WHERE COALESCE(phone, '') <> '';
    `);

    // =====================================================
    // BOOKING <-> TABLE RELATION
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.booking_tables (
        booking_id BIGINT NOT NULL,
        table_id BIGINT NOT NULL,
        restaurant_id BIGINT NOT NULL,
        CONSTRAINT booking_tables_pkey
          PRIMARY KEY (booking_id, table_id)
      );
    `);

    await ensureColumns(
      client,
      "booking_tables",
      [
        ["booking_id", "BIGINT NOT NULL"],
        ["table_id", "BIGINT NOT NULL"],
        ["restaurant_id", "BIGINT NOT NULL"],
      ]
    );

    // Existing MAKS data must be internally tenant-consistent
    // before database-level tenant FKs are added.
    await assertNoRows(
      client,
      `
      SELECT COUNT(*)::bigint AS count
      FROM public.booking_tables bt
      LEFT JOIN public.bookings b
        ON b.id = bt.booking_id
      LEFT JOIN public.tables t
        ON t.id = bt.table_id
      WHERE b.id IS NULL
         OR t.id IS NULL
         OR bt.restaurant_id <> b.restaurant_id
         OR bt.restaurant_id <> t.restaurant_id
      `,
      "Canonical booking/table schema refused cross-tenant booking_tables"
    );

    await ensureConstraint(
      client,
      "booking_tables",
      "booking_tables_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    // Keep the existing simple relationship names for
    // compatibility with the current live schema.
    await ensureConstraint(
      client,
      "booking_tables",
      "booking_tables_booking_id_fkey",
      `FOREIGN KEY (booking_id)
       REFERENCES public.bookings(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "booking_tables",
      "booking_tables_table_id_fkey",
      `FOREIGN KEY (table_id)
       REFERENCES public.tables(id)
       ON DELETE RESTRICT`
    );

    // Strong tenant-aware relationships: a booking/table id
    // from another restaurant cannot be linked even if the
    // application layer is bypassed.
    await ensureConstraint(
      client,
      "booking_tables",
      "booking_tables_booking_tenant_fkey",
      `FOREIGN KEY (restaurant_id, booking_id)
       REFERENCES public.bookings(restaurant_id, id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "booking_tables",
      "booking_tables_table_tenant_fkey",
      `FOREIGN KEY (restaurant_id, table_id)
       REFERENCES public.tables(restaurant_id, id)
       ON DELETE RESTRICT`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_tables_rid
      ON public.booking_tables (restaurant_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_tables_rid_table
      ON public.booking_tables (restaurant_id, table_id);
    `);

    // =====================================================
    // POS TABLE SESSION -> TABLE TENANT INTEGRITY
    // =====================================================

    if (await tableExists(client, "pos_table_sessions")) {
      await assertNoRows(
        client,
        `
        SELECT COUNT(*)::bigint AS count
        FROM public.pos_table_sessions pts
        LEFT JOIN public.tables t
          ON t.id = pts.table_id
        WHERE t.id IS NULL
           OR pts.restaurant_id <> t.restaurant_id
        `,
        "Canonical booking/table schema refused invalid pos_table_sessions"
      );

      await ensureConstraint(
        client,
        "pos_table_sessions",
        "pos_table_sessions_table_tenant_fkey",
        `FOREIGN KEY (restaurant_id, table_id)
         REFERENCES public.tables(restaurant_id, id)
         ON DELETE CASCADE`
      );
    }

    await client.query("COMMIT");

    console.log(
      "✅ Canonical MAKS booking/table schema ready"
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runCanonicalBookingTablesPg,
};
