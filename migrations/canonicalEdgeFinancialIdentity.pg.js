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


async function getColumn(
  client,
  table,
  column
) {
  const { rows } =
    await client.query(
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
      [
        table,
        column,
      ]
    );

  return rows[0] || null;
}


async function assertColumnType(
  client,
  table,
  column,
  allowedTypes
) {
  const info =
    await getColumn(
      client,
      table,
      column
    );

  if (
    !info ||
    !allowedTypes.includes(
      info.udt_name
    )
  ) {
    throw new Error(
      `Canonical Edge financial identity refused: public.${table}.${column} expected ${allowedTypes.join(
        "/"
      )}, got ${info?.udt_name || "missing"}`
    );
  }

  return info;
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


async function runCanonicalEdgeFinancialIdentityPg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !==
      "function"
  ) {
    throw new Error(
      "Canonical Edge financial identity requires PostgreSQL pool"
    );
  }

  console.log(
    "💳 Running canonical MAKS Edge financial identity..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    /*
     * payments already belongs to the canonical financial
     * ledger. This migration does not recreate or reinterpret
     * that ledger.
     *
     * Its only job is to add cross-database financial identity
     * that survives independent Edge and Cloud BIGINT sequences.
     */
    if (
      !(await tableExists(
        client,
        "payments"
      ))
    ) {
      throw new Error(
        "Canonical Edge financial identity requires public.payments"
      );
    }

    /*
     * Fail closed if the legacy authority is not the schema
     * we audited.
     */
    await assertColumnType(
      client,
      "payments",
      "id",
      [
        "int8",
      ]
    );

    await assertColumnType(
      client,
      "payments",
      "restaurant_id",
      [
        "int8",
      ]
    );

    await assertColumnType(
      client,
      "payments",
      "ref_payment_id",
      [
        "int8",
      ]
    );

    await assertColumnType(
      client,
      "payments",
      "refund_of_payment_id",
      [
        "int8",
      ]
    );

    /*
     * Stable cross-database tender identity.
     *
     * payments.id remains the local PostgreSQL BIGSERIAL
     * primary key. It must never become Edge/Cloud identity.
     */
    await client.query(`
      ALTER TABLE public.payments

      ADD COLUMN IF NOT EXISTS
        payment_uuid UUID,

      ADD COLUMN IF NOT EXISTS
        ref_payment_uuid UUID;
    `);

    await assertColumnType(
      client,
      "payments",
      "payment_uuid",
      [
        "uuid",
      ]
    );

    await assertColumnType(
      client,
      "payments",
      "ref_payment_uuid",
      [
        "uuid",
      ]
    );

    /*
     * New tender rows receive stable identity automatically.
     *
     * Cloud materialization will still be able to INSERT an
     * explicit payment_uuid supplied by Edge.
     */
    await client.query(`
      ALTER TABLE public.payments
      ALTER COLUMN payment_uuid
      SET DEFAULT gen_random_uuid();
    `);

    /*
     * One-time historical backfill.
     *
     * Reruns do not replace existing UUIDs.
     */
    await client.query(`
      UPDATE public.payments
      SET payment_uuid =
        gen_random_uuid()
      WHERE payment_uuid IS NULL;
    `);

    const duplicateUuid =
      await client.query(`
        SELECT
          payment_uuid,
          COUNT(*)::int AS row_count

        FROM public.payments

        WHERE payment_uuid IS NOT NULL

        GROUP BY payment_uuid

        HAVING COUNT(*) > 1

        LIMIT 1;
      `);

    if (
      duplicateUuid.rows.length
    ) {
      throw new Error(
        "Canonical Edge financial identity refused: duplicate payment_uuid detected"
      );
    }

    const duplicateTenantUuid =
      await client.query(`
        SELECT
          restaurant_id,
          payment_uuid,
          COUNT(*)::int AS row_count

        FROM public.payments

        WHERE payment_uuid IS NOT NULL

        GROUP BY
          restaurant_id,
          payment_uuid

        HAVING COUNT(*) > 1

        LIMIT 1;
      `);

    if (
      duplicateTenantUuid.rows.length
    ) {
      throw new Error(
        "Canonical Edge financial identity refused: duplicate restaurant/payment_uuid detected"
      );
    }

    await client.query(`
      ALTER TABLE public.payments
      ALTER COLUMN payment_uuid
      SET NOT NULL;
    `);

    await ensureConstraint(
      client,
      "payments",
      "payments_payment_uuid_key",
      `
        UNIQUE (
          payment_uuid
        )
      `
    );

    /*
     * Keep a tenant-qualified unique authority as well.
     *
     * This allows the refund UUID relationship to be enforced
     * at restaurant + UUID level rather than UUID alone.
     */
    await ensureConstraint(
      client,
      "payments",
      "payments_restaurant_payment_uuid_key",
      `
        UNIQUE (
          restaurant_id,
          payment_uuid
        )
      `
    );

    /*
     * There are two historical local-BIGINT refund link
     * columns in the schema.
     *
     * The current POS refund route writes ref_payment_id.
     * Older/reporting code may still expose
     * refund_of_payment_id.
     *
     * Never silently choose between conflicting values.
     */
    const conflictingLegacyRef =
      await client.query(`
        SELECT
          id,
          restaurant_id,
          ref_payment_id,
          refund_of_payment_id

        FROM public.payments

        WHERE ref_payment_id IS NOT NULL
          AND refund_of_payment_id IS NOT NULL
          AND ref_payment_id <>
              refund_of_payment_id

        LIMIT 1;
      `);

    if (
      conflictingLegacyRef.rows.length
    ) {
      throw new Error(
        "Canonical Edge financial identity refused: conflicting legacy refund payment references detected"
      );
    }

    /*
     * Every historical local refund pointer must resolve to a
     * payment owned by the same restaurant.
     *
     * A legacy cross-tenant relationship is financial
     * corruption; do not normalize it silently.
     */
    const invalidLegacyRef =
      await client.query(`
        SELECT
          payment.id,
          payment.restaurant_id,

          COALESCE(
            payment.ref_payment_id,
            payment.refund_of_payment_id
          ) AS legacy_reference_id,

          reference.id
            AS reference_id,

          reference.restaurant_id
            AS reference_restaurant_id

        FROM public.payments payment

        LEFT JOIN public.payments reference
          ON reference.id =
             COALESCE(
               payment.ref_payment_id,
               payment.refund_of_payment_id
             )

        WHERE
          COALESCE(
            payment.ref_payment_id,
            payment.refund_of_payment_id
          ) IS NOT NULL

          AND (
            reference.id IS NULL
            OR reference.restaurant_id <>
               payment.restaurant_id
          )

        LIMIT 1;
      `);

    if (
      invalidLegacyRef.rows.length
    ) {
      throw new Error(
        "Canonical Edge financial identity refused: invalid or cross-tenant legacy refund reference detected"
      );
    }

    /*
     * If a partial migration already populated
     * ref_payment_uuid, it must agree with the audited legacy
     * relationship before we continue.
     */
    const mismatchedExistingUuidRef =
      await client.query(`
        SELECT
          payment.id,
          payment.restaurant_id,
          payment.ref_payment_uuid,
          reference.payment_uuid
            AS expected_ref_payment_uuid

        FROM public.payments payment

        JOIN public.payments reference
          ON reference.id =
             COALESCE(
               payment.ref_payment_id,
               payment.refund_of_payment_id
             )

         AND reference.restaurant_id =
             payment.restaurant_id

        WHERE
          COALESCE(
            payment.ref_payment_id,
            payment.refund_of_payment_id
          ) IS NOT NULL

          AND payment.ref_payment_uuid
              IS NOT NULL

          AND payment.ref_payment_uuid <>
              reference.payment_uuid

        LIMIT 1;
      `);

    if (
      mismatchedExistingUuidRef.rows.length
    ) {
      throw new Error(
        "Canonical Edge financial identity refused: ref_payment_uuid conflicts with legacy refund reference"
      );
    }

    /*
     * Historical refund rows now gain portable identity.
     *
     * The BIGINT relationships remain untouched for backwards
     * compatibility with current routes and reporting.
     */
    await client.query(`
      UPDATE public.payments payment

      SET ref_payment_uuid =
        reference.payment_uuid

      FROM public.payments reference

      WHERE
        payment.ref_payment_uuid
          IS NULL

        AND reference.id =
            COALESCE(
              payment.ref_payment_id,
              payment.refund_of_payment_id
            )

        AND reference.restaurant_id =
            payment.restaurant_id;
    `);

    /*
     * A pre-existing UUID relationship without a matching
     * same-tenant payment is also invalid.
     */
    const invalidUuidRef =
      await client.query(`
        SELECT
          payment.id,
          payment.restaurant_id,
          payment.ref_payment_uuid

        FROM public.payments payment

        LEFT JOIN public.payments reference
          ON reference.restaurant_id =
             payment.restaurant_id

         AND reference.payment_uuid =
             payment.ref_payment_uuid

        WHERE payment.ref_payment_uuid
              IS NOT NULL

          AND reference.id
              IS NULL

        LIMIT 1;
      `);

    if (
      invalidUuidRef.rows.length
    ) {
      throw new Error(
        "Canonical Edge financial identity refused: orphan or cross-tenant ref_payment_uuid detected"
      );
    }

    await ensureConstraint(
      client,
      "payments",
      "payments_ref_payment_uuid_tenant_fkey",
      `
        FOREIGN KEY (
          restaurant_id,
          ref_payment_uuid
        )
        REFERENCES public.payments (
          restaurant_id,
          payment_uuid
        )
        ON DELETE RESTRICT
      `
    );

    /*
     * UNIQUE (
     *   restaurant_id,
     *   payment_uuid
     * )
     * already owns the equivalent B-tree index.
     *
     * Drop the earlier development-only duplicate
     * idempotently so reruns converge to one canonical
     * index for this identity.
     */
    await client.query(`
      DROP INDEX IF EXISTS
        public.idx_payments_rid_payment_uuid
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_payments_rid_ref_payment_uuid

      ON public.payments (
        restaurant_id,
        ref_payment_uuid
      );
    `);

    /*
     * Final verification.
     */
    const paymentUuidInfo =
      await getColumn(
        client,
        "payments",
        "payment_uuid"
      );

    const refPaymentUuidInfo =
      await getColumn(
        client,
        "payments",
        "ref_payment_uuid"
      );

    if (
      paymentUuidInfo?.udt_name !==
        "uuid" ||
      paymentUuidInfo?.is_nullable !==
        "NO"
    ) {
      throw new Error(
        "Canonical Edge financial identity verification failed: payments.payment_uuid must be NOT NULL UUID"
      );
    }

    if (
      refPaymentUuidInfo?.udt_name !==
        "uuid"
    ) {
      throw new Error(
        "Canonical Edge financial identity verification failed: payments.ref_payment_uuid must be UUID"
      );
    }

    const missingPaymentUuid =
      await client.query(`
        SELECT COUNT(*)::int
          AS missing_count

        FROM public.payments

        WHERE payment_uuid
              IS NULL;
      `);

    if (
      Number(
        missingPaymentUuid
          .rows?.[0]
          ?.missing_count ||
        0
      ) !== 0
    ) {
      throw new Error(
        "Canonical Edge financial identity verification failed: payment_uuid backfill incomplete"
      );
    }

    await client.query(
      "COMMIT"
    );

    console.log(
      "✅ Canonical MAKS Edge financial identity ready"
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
  runCanonicalEdgeFinancialIdentityPg,
};
