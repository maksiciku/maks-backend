"use strict";

async function ensureConstraint(
  client,
  table,
  name,
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
        name,
        `public.${table}`,
      ]
    );

  if (rows.length) {
    return;
  }

  await client.query(`
    ALTER TABLE public.${table}
    ADD CONSTRAINT ${name}
    ${definition};
  `);
}

async function assertNoRows(
  client,
  sql,
  message
) {
  const { rows } =
    await client.query(sql);

  const count =
    Number(
      rows?.[0]?.count || 0
    );

  if (count > 0) {
    throw new Error(
      `${message}: ${count} offending row(s)`
    );
  }
}

async function requireNotNull(
  client,
  table,
  column
) {
  await assertNoRows(
    client,
    `
    SELECT
      COUNT(*)::bigint AS count
    FROM public.${table}
    WHERE ${column} IS NULL
    `,
    `Canonical Edge schema refused: public.${table}.${column} contains NULL values`
  );

  await client.query(`
    ALTER TABLE public.${table}
    ALTER COLUMN ${column}
    SET NOT NULL;
  `);
}

async function runCanonicalEdgeControlPlanePg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !==
      "function"
  ) {
    throw new Error(
      "Canonical MAKS Edge schema requires PostgreSQL pool"
    );
  }

  console.log(
    "🛰️ Running canonical MAKS Edge control-plane schema..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS
        public.restaurant_edge_nodes (
          id BIGSERIAL PRIMARY KEY,

          restaurant_id BIGINT NOT NULL,

          installation_id UUID NOT NULL,

          edge_name TEXT NOT NULL
            DEFAULT 'MAKS Edge',

          secret_hash TEXT NOT NULL,

          is_active BOOLEAN NOT NULL
            DEFAULT TRUE,

          version TEXT,

          first_seen_at TIMESTAMPTZ,
          last_seen_at TIMESTAMPTZ,

          local_db_status TEXT NOT NULL
            DEFAULT 'unknown',

          local_db_latency_ms INTEGER,

          internet_status TEXT NOT NULL
            DEFAULT 'unknown',

          cloud_latency_ms INTEGER,

          sync_status TEXT NOT NULL
            DEFAULT 'unknown',

          pending_sync_events INTEGER
            NOT NULL DEFAULT 0,

          last_sync_at TIMESTAMPTZ,
          last_sync_error TEXT,

          uptime_seconds BIGINT,
          disk_free_mb BIGINT,

          created_at TIMESTAMPTZ
            NOT NULL DEFAULT NOW(),

          updated_at TIMESTAMPTZ
            NOT NULL DEFAULT NOW()
        );
    `);

    const columns = [
      [
        "restaurant_id",
        "BIGINT",
      ],
      [
        "installation_id",
        "UUID",
      ],
      [
        "edge_name",
        "TEXT DEFAULT 'MAKS Edge'",
      ],
      [
        "secret_hash",
        "TEXT",
      ],
      [
        "is_active",
        "BOOLEAN DEFAULT TRUE",
      ],
      [
        "version",
        "TEXT",
      ],
      [
        "first_seen_at",
        "TIMESTAMPTZ",
      ],
      [
        "last_seen_at",
        "TIMESTAMPTZ",
      ],
      [
        "local_db_status",
        "TEXT DEFAULT 'unknown'",
      ],
      [
        "local_db_latency_ms",
        "INTEGER",
      ],
      [
        "internet_status",
        "TEXT DEFAULT 'unknown'",
      ],
      [
        "cloud_latency_ms",
        "INTEGER",
      ],
      [
        "sync_status",
        "TEXT DEFAULT 'unknown'",
      ],
      [
        "pending_sync_events",
        "INTEGER DEFAULT 0",
      ],
      [
        "last_sync_at",
        "TIMESTAMPTZ",
      ],
      [
        "last_sync_error",
        "TEXT",
      ],
      [
        "uptime_seconds",
        "BIGINT",
      ],
      [
        "disk_free_mb",
        "BIGINT",
      ],
      [
        "created_at",
        "TIMESTAMPTZ DEFAULT NOW()",
      ],
      [
        "updated_at",
        "TIMESTAMPTZ DEFAULT NOW()",
      ],
    ];

    for (
      const [
        name,
        definition,
      ] of columns
    ) {
      await client.query(`
        ALTER TABLE
          public.restaurant_edge_nodes
        ADD COLUMN IF NOT EXISTS
          ${name} ${definition};
      `);
    }

    for (
      const column of [
        "restaurant_id",
        "installation_id",
        "edge_name",
        "secret_hash",
        "is_active",
        "local_db_status",
        "internet_status",
        "sync_status",
        "pending_sync_events",
        "created_at",
        "updated_at",
      ]
    ) {
      await requireNotNull(
        client,
        "restaurant_edge_nodes",
        column
      );
    }

    await client.query(`
      ALTER TABLE
        public.restaurant_edge_nodes

      ALTER COLUMN edge_name
        SET DEFAULT 'MAKS Edge',

      ALTER COLUMN is_active
        SET DEFAULT TRUE,

      ALTER COLUMN local_db_status
        SET DEFAULT 'unknown',

      ALTER COLUMN internet_status
        SET DEFAULT 'unknown',

      ALTER COLUMN sync_status
        SET DEFAULT 'unknown',

      ALTER COLUMN pending_sync_events
        SET DEFAULT 0,

      ALTER COLUMN created_at
        SET DEFAULT NOW(),

      ALTER COLUMN updated_at
        SET DEFAULT NOW();
    `);

    await assertNoRows(
      client,
      `
      SELECT
        COUNT(*)::bigint AS count
      FROM
        public.restaurant_edge_nodes e
      LEFT JOIN
        public.restaurants r
        ON r.id =
           e.restaurant_id
      WHERE
        r.id IS NULL
      `,
      "Canonical Edge schema refused: restaurant_edge_nodes has orphan restaurant_id"
    );

    await assertNoRows(
      client,
      `
      SELECT
        COUNT(*)::bigint AS count
      FROM (
        SELECT
          installation_id
        FROM
          public.restaurant_edge_nodes
        GROUP BY
          installation_id
        HAVING
          COUNT(*) > 1
      ) duplicate_installations
      `,
      "Canonical Edge schema refused: duplicate installation_id"
    );

    await assertNoRows(
      client,
      `
      SELECT
        COUNT(*)::bigint AS count
      FROM (
        SELECT
          restaurant_id
        FROM
          public.restaurant_edge_nodes
        WHERE
          is_active = TRUE
        GROUP BY
          restaurant_id
        HAVING
          COUNT(*) > 1
      ) duplicate_active_edges
      `,
      "Canonical Edge schema refused: restaurant has multiple active Edge nodes"
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_installation_id_key",
      "UNIQUE (installation_id)"
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_secret_hash_check",
      "CHECK (LENGTH(secret_hash) = 64)"
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_local_db_status_check",
      `CHECK (
        local_db_status IN (
          'unknown',
          'healthy',
          'warning',
          'error'
        )
      )`
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_internet_status_check",
      `CHECK (
        internet_status IN (
          'unknown',
          'online',
          'offline'
        )
      )`
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_sync_status_check",
      `CHECK (
        sync_status IN (
          'unknown',
          'synced',
          'pending',
          'syncing',
          'error'
        )
      )`
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_pending_sync_check",
      `CHECK (
        pending_sync_events >= 0
      )`
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_local_db_latency_check",
      `CHECK (
        local_db_latency_ms IS NULL
        OR local_db_latency_ms >= 0
      )`
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_cloud_latency_check",
      `CHECK (
        cloud_latency_ms IS NULL
        OR cloud_latency_ms >= 0
      )`
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_uptime_check",
      `CHECK (
        uptime_seconds IS NULL
        OR uptime_seconds >= 0
      )`
    );

    await ensureConstraint(
      client,
      "restaurant_edge_nodes",
      "restaurant_edge_nodes_disk_free_check",
      `CHECK (
        disk_free_mb IS NULL
        OR disk_free_mb >= 0
      )`
    );

    await client.query(`
      CREATE UNIQUE INDEX
        IF NOT EXISTS
        ux_restaurant_edge_nodes_one_active_per_restaurant
      ON
        public.restaurant_edge_nodes (
          restaurant_id
        )
      WHERE
        is_active = TRUE;
    `);

    await client.query(`
      CREATE INDEX
        IF NOT EXISTS
        idx_restaurant_edge_nodes_restaurant
      ON
        public.restaurant_edge_nodes (
          restaurant_id
        );
    `);

    await client.query(`
      CREATE INDEX
        IF NOT EXISTS
        idx_restaurant_edge_nodes_last_seen
      ON
        public.restaurant_edge_nodes (
          last_seen_at DESC
        );
    `);

    await client.query(
      "COMMIT"
    );

    console.log(
      "✅ Canonical MAKS Edge control-plane schema ready"
    );
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  runCanonicalEdgeControlPlanePg,
};
