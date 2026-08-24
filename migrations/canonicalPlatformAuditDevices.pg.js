// migrations/canonicalPlatformAuditDevices.pg.js

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
      `Canonical platform/audit/device schema refused: public.${table}.${column} is ${info.udt_name}; expected ${allowedUdts.join(" or ")}`
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

async function requireNotNull(client, table, column) {
  await assertNoRows(
    client,
    `
    SELECT COUNT(*)::bigint AS count
    FROM public.${table}
    WHERE ${column} IS NULL
    `,
    `Canonical platform/audit/device schema refused: public.${table}.${column} contains NULL values`
  );

  await client.query(`
    ALTER TABLE public.${table}
    ALTER COLUMN ${column} SET NOT NULL;
  `);
}

async function runCanonicalPlatformAuditDevicesPg({ pool }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error(
      "Canonical platform/audit/device schema requires PostgreSQL pool"
    );
  }

  console.log(
    "🛡️ Running canonical MAKS platform/audit/device schema..."
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =====================================================
    // FAIL-CLOSED TYPE PREFLIGHT
    // =====================================================

    const bigintColumns = [
      ["audit_log", "id"],
      ["audit_log", "restaurant_id"],
      ["audit_log", "user_id"],
      ["platform_admin_users", "id"],
      ["platform_admin_login_events", "id"],
      ["platform_admin_login_events", "admin_user_id"],
      ["platform_admin_audit", "id"],
      ["platform_admin_audit", "admin_user_id"],
      ["platform_admin_audit", "target_restaurant_id"],
      ["restaurant_devices", "id"],
      ["restaurant_devices", "restaurant_id"],
    ];

    for (const [table, column] of bigintColumns) {
      await assertExistingType(
        client,
        table,
        column,
        ["int8"]
      );
    }

    const timestampColumns = [
      ["audit_log", "created_at"],
      ["platform_admin_users", "created_at"],
      ["platform_admin_users", "last_login_at"],
      ["platform_admin_users", "last_failed_login_at"],
      ["platform_admin_users", "locked_until"],
      ["platform_admin_users", "password_changed_at"],
      ["platform_admin_login_events", "created_at"],
      ["platform_admin_audit", "created_at"],
      ["restaurant_devices", "first_seen_at"],
      ["restaurant_devices", "last_seen_at"],
    ];

    for (const [table, column] of timestampColumns) {
      await assertExistingType(
        client,
        table,
        column,
        ["timestamptz"]
      );
    }

    await assertExistingType(
      client,
      "audit_log",
      "meta",
      ["jsonb"]
    );

    await assertExistingType(
      client,
      "platform_admin_audit",
      "meta",
      ["jsonb"]
    );

    await assertExistingType(
      client,
      "platform_admin_users",
      "is_active",
      ["bool"]
    );

    await assertExistingType(
      client,
      "platform_admin_users",
      "failed_login_count",
      ["int4"]
    );

    await assertExistingType(
      client,
      "platform_admin_users",
      "security_version",
      ["int4"]
    );

    await assertExistingType(
      client,
      "platform_admin_login_events",
      "success",
      ["bool"]
    );

    await assertExistingType(
      client,
      "restaurant_devices",
      "is_active",
      ["bool"]
    );

    // =====================================================
    // TENANT AUDIT LOG
    // Intentionally NO restaurant/user FK.
    // Audit history must not disappear merely because a tenant/user
    // relationship changes. Erase-forever performs explicit cleanup.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.audit_log (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        actor_role TEXT,
        action TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        ip TEXT,
        user_agent TEXT,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await ensureColumns(
      client,
      "audit_log",
      [
        ["restaurant_id", "BIGINT"],
        ["user_id", "BIGINT"],
        ["actor_role", "TEXT"],
        ["action", "TEXT"],
        ["entity", "TEXT"],
        ["entity_id", "TEXT"],
        ["ip", "TEXT"],
        ["user_agent", "TEXT"],
        ["meta", "JSONB DEFAULT '{}'::jsonb"],
        ["created_at", "TIMESTAMPTZ DEFAULT NOW()"],
      ]
    );

    await requireNotNull(
      client,
      "audit_log",
      "restaurant_id"
    );
    await requireNotNull(client, "audit_log", "user_id");
    await requireNotNull(client, "audit_log", "action");
    await requireNotNull(client, "audit_log", "meta");
    await requireNotNull(client, "audit_log", "created_at");

    await client.query(`
      ALTER TABLE public.audit_log
      ALTER COLUMN meta SET DEFAULT '{}'::jsonb,
      ALTER COLUMN created_at SET DEFAULT NOW();
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_rest_action
      ON public.audit_log (restaurant_id, action);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_rest_created
      ON public.audit_log (restaurant_id, created_at DESC);
    `);

    // =====================================================
    // PLATFORM ADMIN USERS
    // Security state used directly by CC authentication/lockout.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.platform_admin_users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        role TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ,
        failed_login_count INTEGER NOT NULL DEFAULT 0,
        last_failed_login_at TIMESTAMPTZ,
        locked_until TIMESTAMPTZ,
        password_changed_at TIMESTAMPTZ,
        security_version INTEGER NOT NULL DEFAULT 1
      );
    `);

    await ensureColumns(
      client,
      "platform_admin_users",
      [
        ["email", "TEXT"],
        ["password_hash", "TEXT"],
        ["full_name", "TEXT"],
        ["role", "TEXT"],
        ["is_active", "BOOLEAN DEFAULT TRUE"],
        ["created_at", "TIMESTAMPTZ DEFAULT NOW()"],
        ["last_login_at", "TIMESTAMPTZ"],
        ["failed_login_count", "INTEGER DEFAULT 0"],
        ["last_failed_login_at", "TIMESTAMPTZ"],
        ["locked_until", "TIMESTAMPTZ"],
        ["password_changed_at", "TIMESTAMPTZ"],
        ["security_version", "INTEGER DEFAULT 1"],
      ]
    );

    for (const column of [
      "email",
      "password_hash",
      "role",
      "is_active",
      "created_at",
      "failed_login_count",
      "security_version",
    ]) {
      await requireNotNull(
        client,
        "platform_admin_users",
        column
      );
    }

    await client.query(`
      ALTER TABLE public.platform_admin_users
      ALTER COLUMN is_active SET DEFAULT TRUE,
      ALTER COLUMN created_at SET DEFAULT NOW(),
      ALTER COLUMN failed_login_count SET DEFAULT 0,
      ALTER COLUMN security_version SET DEFAULT 1;
    `);

    await ensureConstraint(
      client,
      "platform_admin_users",
      "platform_admin_users_email_key",
      "UNIQUE (email)"
    );

    // =====================================================
    // PLATFORM ADMIN LOGIN EVENTS
    // Deliberately no FK to platform_admin_users: failed/unknown
    // login attempts and historical security events must survive.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.platform_admin_login_events (
        id BIGSERIAL PRIMARY KEY,
        admin_user_id BIGINT,
        email_attempted TEXT,
        success BOOLEAN NOT NULL DEFAULT FALSE,
        reason TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await ensureColumns(
      client,
      "platform_admin_login_events",
      [
        ["admin_user_id", "BIGINT"],
        ["email_attempted", "TEXT"],
        ["success", "BOOLEAN DEFAULT FALSE"],
        ["reason", "TEXT"],
        ["ip_address", "TEXT"],
        ["user_agent", "TEXT"],
        ["created_at", "TIMESTAMPTZ DEFAULT NOW()"],
      ]
    );

    await requireNotNull(
      client,
      "platform_admin_login_events",
      "success"
    );
    await requireNotNull(
      client,
      "platform_admin_login_events",
      "reason"
    );
    await requireNotNull(
      client,
      "platform_admin_login_events",
      "created_at"
    );

    await client.query(`
      ALTER TABLE public.platform_admin_login_events
      ALTER COLUMN success SET DEFAULT FALSE,
      ALTER COLUMN created_at SET DEFAULT NOW();
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_admin_login_events_created
      ON public.platform_admin_login_events (created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_admin_login_events_email
      ON public.platform_admin_login_events (
        LOWER(email_attempted),
        created_at DESC
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_admin_login_events_ip
      ON public.platform_admin_login_events (
        ip_address,
        created_at DESC
      );
    `);

    // =====================================================
    // PLATFORM ADMIN AUDIT
    // Preserve current MAKS semantics:
    // admin delete -> audit rows delete;
    // restaurant delete -> target reference becomes NULL.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.platform_admin_audit (
        id BIGSERIAL PRIMARY KEY,
        admin_user_id BIGINT NOT NULL,
        action TEXT NOT NULL,
        target_restaurant_id BIGINT,
        entity TEXT,
        entity_id TEXT,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await ensureColumns(
      client,
      "platform_admin_audit",
      [
        ["admin_user_id", "BIGINT"],
        ["action", "TEXT"],
        ["target_restaurant_id", "BIGINT"],
        ["entity", "TEXT"],
        ["entity_id", "TEXT"],
        ["meta", "JSONB DEFAULT '{}'::jsonb"],
        ["created_at", "TIMESTAMPTZ DEFAULT NOW()"],
      ]
    );

    await requireNotNull(
      client,
      "platform_admin_audit",
      "admin_user_id"
    );
    await requireNotNull(
      client,
      "platform_admin_audit",
      "action"
    );
    await requireNotNull(
      client,
      "platform_admin_audit",
      "meta"
    );
    await requireNotNull(
      client,
      "platform_admin_audit",
      "created_at"
    );

    await assertNoRows(
      client,
      `
      SELECT COUNT(*)::bigint AS count
      FROM public.platform_admin_audit paa
      LEFT JOIN public.platform_admin_users pau
        ON pau.id = paa.admin_user_id
      WHERE pau.id IS NULL
      `,
      "Canonical platform/audit/device schema refused: platform admin audit has orphan admin_user_id"
    );

    await assertNoRows(
      client,
      `
      SELECT COUNT(*)::bigint AS count
      FROM public.platform_admin_audit paa
      LEFT JOIN public.restaurants r
        ON r.id = paa.target_restaurant_id
      WHERE paa.target_restaurant_id IS NOT NULL
        AND r.id IS NULL
      `,
      "Canonical platform/audit/device schema refused: platform admin audit has orphan target_restaurant_id"
    );

    await client.query(`
      ALTER TABLE public.platform_admin_audit
      ALTER COLUMN meta SET DEFAULT '{}'::jsonb,
      ALTER COLUMN created_at SET DEFAULT NOW();
    `);

    await ensureConstraint(
      client,
      "platform_admin_audit",
      "platform_admin_audit_admin_user_id_fkey",
      `FOREIGN KEY (admin_user_id)
       REFERENCES public.platform_admin_users(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "platform_admin_audit",
      "platform_admin_audit_target_restaurant_id_fkey",
      `FOREIGN KEY (target_restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE SET NULL`
    );

    // =====================================================
    // RESTAURANT DEVICE INVENTORY
    // Persistent device identity. Live-seat concurrency remains in
    // pos_device_sessions; this table stores known/disabled devices.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.restaurant_devices (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        device_key TEXT NOT NULL,
        device_type TEXT NOT NULL,
        device_name TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await ensureColumns(
      client,
      "restaurant_devices",
      [
        ["restaurant_id", "BIGINT"],
        ["device_key", "TEXT"],
        ["device_type", "TEXT"],
        ["device_name", "TEXT"],
        ["is_active", "BOOLEAN DEFAULT TRUE"],
        ["first_seen_at", "TIMESTAMPTZ DEFAULT NOW()"],
        ["last_seen_at", "TIMESTAMPTZ DEFAULT NOW()"],
      ]
    );

    for (const column of [
      "restaurant_id",
      "device_key",
      "device_type",
      "is_active",
      "first_seen_at",
      "last_seen_at",
    ]) {
      await requireNotNull(
        client,
        "restaurant_devices",
        column
      );
    }

    await assertNoRows(
      client,
      `
      SELECT COUNT(*)::bigint AS count
      FROM public.restaurant_devices d
      LEFT JOIN public.restaurants r
        ON r.id = d.restaurant_id
      WHERE r.id IS NULL
      `,
      "Canonical platform/audit/device schema refused: restaurant_devices has orphan restaurant_id"
    );

    await assertNoRows(
      client,
      `
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT restaurant_id, device_key
        FROM public.restaurant_devices
        GROUP BY restaurant_id, device_key
        HAVING COUNT(*) > 1
      ) duplicates
      `,
      "Canonical platform/audit/device schema refused: duplicate restaurant device keys"
    );

    await client.query(`
      ALTER TABLE public.restaurant_devices
      ALTER COLUMN is_active SET DEFAULT TRUE,
      ALTER COLUMN first_seen_at SET DEFAULT NOW(),
      ALTER COLUMN last_seen_at SET DEFAULT NOW();
    `);

    await ensureConstraint(
      client,
      "restaurant_devices",
      "restaurant_devices_restaurant_id_device_key_key",
      "UNIQUE (restaurant_id, device_key)"
    );

    await ensureConstraint(
      client,
      "restaurant_devices",
      "restaurant_devices_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await client.query("COMMIT");

    console.log(
      "✅ Canonical MAKS platform/audit/device schema ready"
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  runCanonicalPlatformAuditDevicesPg,
};
