"use strict";


async function tableExists(
  client,
  table
) {
  const { rows } =
    await client.query(
      `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
        AND table_type = 'BASE TABLE'
      LIMIT 1
      `,
      [
        table,
      ]
    );

  return rows.length > 0;
}


async function assertColumnType(
  client,
  table,
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
        AND c.relname = $1
        AND a.attname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped
      LIMIT 1
      `,
      [
        table,
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
      `Canonical Edge domain revisions refused: public.${table}.${column} expected ${allowedTypes.join(
        "/"
      )}, got ${type || "missing"}`
    );
  }
}


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


async function runCanonicalEdgeDomainRevisionsPg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !==
      "function"
  ) {
    throw new Error(
      "Canonical Edge domain revisions require PostgreSQL pool"
    );
  }

  console.log(
    "🔢 Running canonical MAKS Edge domain revisions..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const existed =
      await tableExists(
        client,
        "edge_domain_revisions"
      );

    await client.query(`
      CREATE TABLE IF NOT EXISTS
        public.edge_domain_revisions
      (
        restaurant_id BIGINT
          NOT NULL,

        domain TEXT
          NOT NULL,

        produced_revision BIGINT
          NOT NULL
          DEFAULT 0,

        applied_revision BIGINT
          NOT NULL
          DEFAULT 0,

        applied_payload_hash TEXT,

        created_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW()
      );
    `);

    /*
     * If this table pre-existed, never "repair" a partial or
     * incompatible shape silently. The type checks below are
     * deliberately fail-closed.
     */
    const checks = [
      [
        "restaurant_id",
        ["int8"],
      ],
      [
        "domain",
        ["text"],
      ],
      [
        "produced_revision",
        ["int8"],
      ],
      [
        "applied_revision",
        ["int8"],
      ],
      [
        "applied_payload_hash",
        ["text"],
      ],
      [
        "created_at",
        ["timestamptz"],
      ],
      [
        "updated_at",
        ["timestamptz"],
      ],
    ];

    for (
      const [
        column,
        types,
      ] of checks
    ) {
      await assertColumnType(
        client,
        "edge_domain_revisions",
        column,
        types
      );
    }

    await ensureConstraint(
      client,
      "edge_domain_revisions",
      "edge_domain_revisions_pkey",
      `
      PRIMARY KEY (
        restaurant_id,
        domain
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_domain_revisions",
      "edge_domain_revisions_restaurant_fk",
      `
      FOREIGN KEY (restaurant_id)
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
      `
    );

    await ensureConstraint(
      client,
      "edge_domain_revisions",
      "edge_domain_revisions_domain_check",
      `
      CHECK (
        LENGTH(TRIM(domain))
          BETWEEN 1 AND 200
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_domain_revisions",
      "edge_domain_revisions_produced_check",
      `
      CHECK (
        produced_revision >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_domain_revisions",
      "edge_domain_revisions_applied_check",
      `
      CHECK (
        applied_revision >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_domain_revisions",
      "edge_domain_revisions_hash_check",
      `
      CHECK (
        applied_payload_hash IS NULL
        OR applied_payload_hash ~
          '^[0-9a-f]{64}$'
      )
      `
    );

    const verified =
      await tableExists(
        client,
        "edge_domain_revisions"
      );

    if (!verified) {
      throw new Error(
        "Canonical Edge domain revisions verification failed"
      );
    }

    await client.query(
      "COMMIT"
    );

    console.log(
      existed
        ? "✅ Canonical MAKS Edge domain revisions verified"
        : "✅ Canonical MAKS Edge domain revisions ready"
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
  runCanonicalEdgeDomainRevisionsPg,
};
