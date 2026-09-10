"use strict";


const CANONICAL_PAYMENT_STATUSES =
  Object.freeze([
    "completed",
    "voided",
    "refunded",
    "partially_refunded",
  ]);


async function requirePaymentsTable(
  client
) {
  const { rows } =
    await client.query(
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'payments'
          AND table_type = 'BASE TABLE'
        LIMIT 1
      `
    );

  if (!rows.length) {
    throw new Error(
      "Canonical payment statuses refused: public.payments is missing"
    );
  }
}


async function assertExistingStatusesSupported(
  client
) {
  const { rows } =
    await client.query(
      `
        SELECT
          status,
          COUNT(*)::bigint AS count
        FROM public.payments
        WHERE status IS NULL
           OR status <> ALL($1::text[])
        GROUP BY status
        ORDER BY status NULLS FIRST
      `,
      [
        CANONICAL_PAYMENT_STATUSES,
      ]
    );

  if (rows.length) {
    const detail =
      rows
        .map(
          (row) =>
            `${String(row.status)}:${String(row.count)}`
        )
        .join(", ");

    throw new Error(
      `Canonical payment statuses refused: unsupported existing payment status rows detected (${detail})`
    );
  }
}


async function readTargetConstraints(
  client
) {
  const { rows } =
    await client.query(
      `
        SELECT
          conname,
          pg_get_constraintdef(oid)
            AS definition
        FROM pg_constraint
        WHERE
          conrelid =
            'public.payments'::regclass
          AND contype = 'c'
          AND conname IN (
            'payments_status_check',
            'payments_status_chk'
          )
        ORDER BY conname
      `
    );

  return rows;
}


async function verifyCanonicalConstraint(
  client
) {
  const rows =
    await readTargetConstraints(
      client
    );

  if (
    rows.length !== 1 ||
    rows[0].conname !==
      "payments_status_check"
  ) {
    throw new Error(
      "Canonical payment statuses verification failed: expected exactly one payments_status_check constraint"
    );
  }

  const definition =
    String(
      rows[0].definition || ""
    );

  for (
    const status of
    CANONICAL_PAYMENT_STATUSES
  ) {
    if (
      !definition.includes(status)
    ) {
      throw new Error(
        `Canonical payment statuses verification failed: ${status} is missing from payments_status_check`
      );
    }
  }

  if (
    definition.includes("corrected")
  ) {
    throw new Error(
      "Canonical payment statuses verification failed: legacy corrected status remains allowed"
    );
  }

  if (
    rows.some(
      (row) =>
        row.conname ===
        "payments_status_chk"
    )
  ) {
    throw new Error(
      "Canonical payment statuses verification failed: legacy payments_status_chk remains"
    );
  }
}


async function runCanonicalPaymentStatusesPg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !==
      "function"
  ) {
    throw new Error(
      "Canonical payment statuses require PostgreSQL pool"
    );
  }

  console.log(
    "💳 Running canonical MAKS payment-status compatibility..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await requirePaymentsTable(
      client
    );

    /*
     * Never silently discard a status currently used
     * by real ledger rows. If legacy/unknown values are
     * present, stop before altering either constraint.
     */
    await assertExistingStatusesSupported(
      client
    );

    /*
     * Historical databases can contain either or both
     * legacy constraint names with contradictory status
     * sets. Remove both idempotently and recreate one
     * canonical definition.
     */
    await client.query(`
      ALTER TABLE public.payments
      DROP CONSTRAINT IF EXISTS
        payments_status_chk;
    `);

    await client.query(`
      ALTER TABLE public.payments
      DROP CONSTRAINT IF EXISTS
        payments_status_check;
    `);

    await client.query(`
      ALTER TABLE public.payments
      ADD CONSTRAINT
        payments_status_check
      CHECK (
        status IN (
          'completed',
          'voided',
          'refunded',
          'partially_refunded'
        )
      );
    `);

    await verifyCanonicalConstraint(
      client
    );

    await client.query(
      "COMMIT"
    );

    console.log(
      "✅ Canonical MAKS payment-status compatibility ready"
    );
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch (_) {
      // Preserve original migration failure.
    }

    throw error;
  } finally {
    client.release();
  }
}


module.exports = {
  CANONICAL_PAYMENT_STATUSES,
  runCanonicalPaymentStatusesPg,
};
