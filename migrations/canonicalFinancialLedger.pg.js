// migrations/canonicalFinancialLedger.pg.js

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

async function assertExistingType(client, table, column, allowedUdts) {
  if (!(await tableExists(client, table))) return;

  const info = await getColumn(client, table, column);
  if (!info) return;

  if (!allowedUdts.includes(info.udt_name)) {
    throw new Error(
      `Canonical financial schema refused: public.${table}.${column} is ${info.udt_name}; expected ${allowedUdts.join(" or ")}`
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

async function runCanonicalFinancialLedgerPg({ pool }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error(
      "Canonical financial ledger schema requires PostgreSQL pool"
    );
  }

  console.log(
    "💷 Running canonical MAKS financial ledger schema..."
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // =====================================================
    // FAIL-CLOSED TYPE PREFLIGHT
    // =====================================================

    await assertExistingType(
      client,
      "cashup_sessions",
      "id",
      ["uuid"]
    );

    await assertExistingType(
      client,
      "cash_drawer_moves",
      "id",
      ["int8"]
    );

    await assertExistingType(
      client,
      "payments",
      "cashup_session_id",
      ["uuid"]
    );

    await assertExistingType(
      client,
      "payments",
      "ref_payment_id",
      ["int8"]
    );

    await assertExistingType(
      client,
      "payments",
      "settlement_id",
      ["uuid"]
    );

    // =====================================================
    // CASH-UP SESSIONS
    // UUID is authoritative: cashupRoutes rejects anything
    // else before linking payments.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.cashup_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        restaurant_id BIGINT NOT NULL,
        from_ts TIMESTAMPTZ NOT NULL,
        to_ts TIMESTAMPTZ NOT NULL,
        expected_cash NUMERIC(12,2) NOT NULL DEFAULT 0,
        actual_cash NUMERIC(12,2) NOT NULL DEFAULT 0,
        discrepancy NUMERIC(12,2) NOT NULL DEFAULT 0,
        note TEXT,
        closed_by_user_id BIGINT,
        closed_by_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT cashup_sessions_range_unique
          UNIQUE (restaurant_id, from_ts, to_ts),
        CONSTRAINT cashup_sessions_range_valid
          CHECK (to_ts >= from_ts)
      );
    `);

    await ensureColumns(
      client,
      "cashup_sessions",
      [
        ["expected_cash", "NUMERIC(12,2) NOT NULL DEFAULT 0"],
        ["actual_cash", "NUMERIC(12,2) NOT NULL DEFAULT 0"],
        ["discrepancy", "NUMERIC(12,2) NOT NULL DEFAULT 0"],
        ["note", "TEXT"],
        ["closed_by_user_id", "BIGINT"],
        ["closed_by_name", "TEXT"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
      ]
    );

    await ensureConstraint(
      client,
      "cashup_sessions",
      "cashup_sessions_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "cashup_sessions",
      "cashup_sessions_range_unique",
      `UNIQUE (restaurant_id, from_ts, to_ts)`
    );

    await ensureConstraint(
      client,
      "cashup_sessions",
      "cashup_sessions_range_valid",
      `CHECK (to_ts >= from_ts)`
    );

    await ensureConstraint(
      client,
      "cashup_sessions",
      "cashup_sessions_restaurant_id_id_key",
      `UNIQUE (restaurant_id, id)`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cashup_sessions_rid_created
      ON public.cashup_sessions (restaurant_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cashup_sessions_rid_range
      ON public.cashup_sessions (restaurant_id, from_ts, to_ts);
    `);

    // =====================================================
    // CASH DRAWER MOVES
    // Active cashupRoutes reads/writes this table. The old
    // cash_drawer/cashups tables remain legacy compatibility.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.cash_drawer_moves (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        kind TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        note TEXT DEFAULT '',
        created_by BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT cash_drawer_moves_kind_check
          CHECK (
            kind IN (
              'float',
              'sale',
              'refund',
              'payout',
              'drop',
              'correction'
            )
          ),
        CONSTRAINT cash_drawer_moves_amount_positive
          CHECK (amount > 0)
      );
    `);

    await ensureColumns(
      client,
      "cash_drawer_moves",
      [
        ["note", "TEXT DEFAULT ''"],
        ["created_by", "BIGINT"],
        ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
      ]
    );

    await ensureConstraint(
      client,
      "cash_drawer_moves",
      "cash_drawer_moves_restaurant_id_fkey",
      `FOREIGN KEY (restaurant_id)
       REFERENCES public.restaurants(id)
       ON DELETE CASCADE`
    );

    await ensureConstraint(
      client,
      "cash_drawer_moves",
      "cash_drawer_moves_kind_check",
      `CHECK (
        kind IN (
          'float',
          'sale',
          'refund',
          'payout',
          'drop',
          'correction'
        )
      )`
    );

    await ensureConstraint(
      client,
      "cash_drawer_moves",
      "cash_drawer_moves_amount_positive",
      `CHECK (amount > 0)`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cash_drawer_moves_rid_created
      ON public.cash_drawer_moves (restaurant_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cash_drawer_moves_rid_time
      ON public.cash_drawer_moves (restaurant_id, created_at);
    `);

    // =====================================================
    // PAYMENTS -> CASH-UP LINK
    // payments/payment_settlements are created earlier by
    // canonical operational schema. Phase 5 owns the cash-up
    // relationship and the indexes needed by cashupRoutes.
    // =====================================================

    if (!(await tableExists(client, "payments"))) {
      throw new Error(
        "Canonical financial schema requires public.payments from canonical operational schema"
      );
    }

    await ensureColumns(
      client,
      "payments",
      [
        ["cashup_session_id", "UUID"],
        ["ref_payment_id", "BIGINT"],
        ["settlement_id", "UUID"],
      ]
    );

    await ensureConstraint(
      client,
      "payments",
      "payments_cashup_session_tenant_fkey",
      `FOREIGN KEY (restaurant_id, cashup_session_id)
       REFERENCES public.cashup_sessions(restaurant_id, id)
       ON DELETE RESTRICT`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_cashup_session
      ON public.payments (cashup_session_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_rid_cashup_session
      ON public.payments (restaurant_id, cashup_session_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_ref_payment
      ON public.payments (restaurant_id, ref_payment_id);
    `);

    // =====================================================
    // VERIFY
    // =====================================================

    const { rows: tableRows } = await client.query(`
      SELECT COUNT(*)::int AS table_count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(
          ARRAY[
            'payments',
            'payment_settlements',
            'cashup_sessions',
            'cash_drawer_moves'
          ]::text[]
        );
    `);

    if (Number(tableRows[0]?.table_count || 0) !== 4) {
      throw new Error(
        `Canonical financial ledger verification failed: expected 4 tables, found ${Number(tableRows[0]?.table_count || 0)}`
      );
    }

    const idType = await getColumn(
      client,
      "cashup_sessions",
      "id"
    );

    const cashupLinkType = await getColumn(
      client,
      "payments",
      "cashup_session_id"
    );

    if (idType?.udt_name !== "uuid") {
      throw new Error(
        "Canonical financial ledger verification failed: cashup_sessions.id must be uuid"
      );
    }

    if (cashupLinkType?.udt_name !== "uuid") {
      throw new Error(
        "Canonical financial ledger verification failed: payments.cashup_session_id must be uuid"
      );
    }

    await client.query("COMMIT");

    console.log(
      "✅ Canonical MAKS financial ledger schema ready"
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
  runCanonicalFinancialLedgerPg,
};
