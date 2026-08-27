"use strict";

async function assertColumnType(
  client,
  column,
  allowedTypes
) {
  const { rows } =
    await client.query(
      `
      SELECT
        t.typname AS type_name
      FROM pg_attribute a
      JOIN pg_class c
        ON c.oid = a.attrelid
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      JOIN pg_type t
        ON t.oid = a.atttypid
      WHERE n.nspname = 'public'
        AND c.relname = 'edge_sync_state'
        AND a.attname = $1
        AND a.attnum > 0
        AND NOT a.attisdropped
      LIMIT 1
      `,
      [
        column,
      ]
    );

  const type =
    rows?.[0]?.type_name;

  if (
    !type ||
    !allowedTypes.includes(type)
  ) {
    throw new Error(
      `Canonical Edge directional health refused: public.edge_sync_state.${column} expected ${allowedTypes.join(
        "/"
      )}, got ${type || "missing"}`
    );
  }
}


async function ensureConstraint(
  client,
  name,
  definition
) {
  const { rows } =
    await client.query(
      `
      SELECT 1
      FROM pg_constraint
      WHERE conname = $1
        AND conrelid =
          'public.edge_sync_state'::regclass
      LIMIT 1
      `,
      [
        name,
      ]
    );

  if (rows.length) {
    return;
  }

  await client.query(`
    ALTER TABLE
      public.edge_sync_state
    ADD CONSTRAINT
      ${name}
    ${definition};
  `);
}


async function runCanonicalEdgeSyncDirectionalHealthPg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !==
      "function"
  ) {
    throw new Error(
      "Canonical Edge directional health requires PostgreSQL pool"
    );
  }

  console.log(
    "🔄 Running canonical MAKS Edge directional sync health..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    /*
     * Directional health prevents a successful push from
     * clearing a pull failure, or a successful pull from
     * clearing a push failure.
     *
     * The existing aggregate columns remain for Control
     * Centre/runtime compatibility and are derived by the
     * syncStore from these directional columns.
     */
    const directionalColumns =
      [
        "push_status",
        "pull_status",
        "last_push_success_at",
        "last_pull_success_at",
        "last_push_error",
        "last_pull_error",
        "push_consecutive_failures",
        "pull_consecutive_failures",
      ];

    const existingDirectional =
      await client.query(
        `
        SELECT
          COUNT(*)::int AS count
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'edge_sync_state'
          AND column_name =
            ANY($1::text[])
        `,
        [
          directionalColumns,
        ]
      );

    const existingCount =
      Number(
        existingDirectional
          .rows?.[0]
          ?.count ||
        0
      );

    if (
      existingCount !== 0 &&
      existingCount !==
        directionalColumns.length
    ) {
      throw new Error(
        "Canonical Edge directional health refused: partial directional schema detected"
      );
    }

    const firstInstall =
      existingCount === 0;

    await client.query(`
      ALTER TABLE
        public.edge_sync_state
      ADD COLUMN IF NOT EXISTS
        push_status TEXT
          NOT NULL
          DEFAULT 'unknown',

      ADD COLUMN IF NOT EXISTS
        pull_status TEXT
          NOT NULL
          DEFAULT 'unknown',

      ADD COLUMN IF NOT EXISTS
        last_push_success_at TIMESTAMPTZ,

      ADD COLUMN IF NOT EXISTS
        last_pull_success_at TIMESTAMPTZ,

      ADD COLUMN IF NOT EXISTS
        last_push_error TEXT,

      ADD COLUMN IF NOT EXISTS
        last_pull_error TEXT,

      ADD COLUMN IF NOT EXISTS
        push_consecutive_failures INTEGER
          NOT NULL
          DEFAULT 0,

      ADD COLUMN IF NOT EXISTS
        pull_consecutive_failures INTEGER
          NOT NULL
          DEFAULT 0;
    `);

    if (firstInstall) {
      /*
       * One-time conservative upgrade from the old shared
       * health model. Copy the known aggregate state into
       * both directions so migration cannot turn an existing
       * error into a false healthy state. Future real push
       * and pull cycles replace their own directional state.
       *
       * This block is intentionally skipped on reruns, so
       * migration idempotency never overwrites newer runtime
       * directional health.
       */
      await client.query(`
        UPDATE
          public.edge_sync_state
        SET
          push_status =
            sync_status,

          pull_status =
            sync_status,

          last_push_success_at =
            last_success_at,

          last_pull_success_at =
            last_success_at,

          last_push_error =
            CASE
              WHEN sync_status = 'error'
                THEN last_error
              ELSE NULL
            END,

          last_pull_error =
            CASE
              WHEN sync_status = 'error'
                THEN last_error
              ELSE NULL
            END,

          push_consecutive_failures =
            consecutive_failures,

          pull_consecutive_failures =
            consecutive_failures
      `);
    }

    const typeChecks = [
      [
        "push_status",
        ["text"],
      ],

      [
        "pull_status",
        ["text"],
      ],

      [
        "last_push_success_at",
        ["timestamptz"],
      ],

      [
        "last_pull_success_at",
        ["timestamptz"],
      ],

      [
        "last_push_error",
        ["text"],
      ],

      [
        "last_pull_error",
        ["text"],
      ],

      [
        "push_consecutive_failures",
        ["int4"],
      ],

      [
        "pull_consecutive_failures",
        ["int4"],
      ],
    ];

    for (
      const [
        column,
        types,
      ] of typeChecks
    ) {
      await assertColumnType(
        client,
        column,
        types
      );
    }

    await ensureConstraint(
      client,
      "edge_sync_state_push_status_check",
      `
      CHECK (
        push_status IN (
          'unknown',
          'synced',
          'pending',
          'syncing',
          'error'
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state_pull_status_check",
      `
      CHECK (
        pull_status IN (
          'unknown',
          'synced',
          'pending',
          'syncing',
          'error'
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state_push_failures_check",
      `
      CHECK (
        push_consecutive_failures >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state_pull_failures_check",
      `
      CHECK (
        pull_consecutive_failures >= 0
      )
      `
    );

    await client.query(
      "COMMIT"
    );

    console.log(
      "✅ Canonical MAKS Edge directional sync health ready"
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
  runCanonicalEdgeSyncDirectionalHealthPg,
};
