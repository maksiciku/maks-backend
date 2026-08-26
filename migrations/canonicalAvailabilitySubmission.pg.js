"use strict";

/*
 * =========================================================
 * MAKS AVAILABILITY SUBMISSION IDENTITY
 * =========================================================
 *
 * batch_id:
 *   the whole restaurant order/ticket.
 *
 * submission_id:
 *   one individual Send / append operation inside that batch.
 *
 * Historical rows are safely backfilled with:
 *
 *   submission_id = batch_id
 *
 * which preserves the old one-submission-per-batch meaning.
 */

async function constraintExists(
  client,
  table,
  name
) {
  const result =
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

  return result.rows.length > 0;
}

async function runCanonicalAvailabilitySubmissionPg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !== "function"
  ) {
    throw new Error(
      "Availability submission migration requires PostgreSQL pool"
    );
  }

  console.log(
    "🧾 Running MAKS availability submission schema..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const tableCheck =
      await client.query(`
        SELECT
          to_regclass(
            'public.item_availability_reservations'
          ) AS table_name
      `);

    /*
     * Fresh database:
     * canonicalInventoryMenu.pg.js will create the table
     * with the correct submission-aware definition later.
     */
    if (
      !tableCheck.rows[0]
        ?.table_name
    ) {
      await client.query(
        "COMMIT"
      );

      console.log(
        "ℹ️ Availability reservation table not created yet; standalone upgrade skipped"
      );

      return {
        skipped: true,
      };
    }

    /*
     * Existing database:
     * add nullable first so historical rows can be backfilled.
     */
    await client.query(`
      ALTER TABLE
        public.item_availability_reservations
      ADD COLUMN IF NOT EXISTS
        submission_id UUID
    `);

    /*
     * Historical identity:
     *
     * old reservation identity was the batch itself,
     * therefore batch_id is the correct legacy
     * submission identity.
     */
    await client.query(`
      UPDATE
        public.item_availability_reservations
      SET
        submission_id = batch_id
      WHERE
        submission_id IS NULL
    `);

    await client.query(`
      ALTER TABLE
        public.item_availability_reservations
      ALTER COLUMN
        submission_id
      SET NOT NULL
    `);

    /*
     * Old identity:
     *
     * restaurant + batch + item
     *
     * New identity:
     *
     * restaurant + batch + submission + item
     */
    await client.query(`
      ALTER TABLE
        public.item_availability_reservations
      DROP CONSTRAINT IF EXISTS
        item_availability_reservation_restaurant_id_batch_id_item_t_key
    `);

    const newConstraint =
      "item_availability_reservation_submission_key";

    const hasNewConstraint =
      await constraintExists(
        client,
        "item_availability_reservations",
        newConstraint
      );

    if (!hasNewConstraint) {
      await client.query(`
        ALTER TABLE
          public.item_availability_reservations

        ADD CONSTRAINT
          ${newConstraint}

        UNIQUE (
          restaurant_id,
          batch_id,
          submission_id,
          item_type,
          item_id
        )
      `);
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_item_availability_res_submission

      ON
        public.item_availability_reservations (
          restaurant_id,
          batch_id,
          submission_id
        )
    `);

    /*
     * Safety assertions.
     */
    const nullCheck =
      await client.query(`
        SELECT
          COUNT(*)::int AS count
        FROM
          public.item_availability_reservations
        WHERE
          submission_id IS NULL
      `);

    if (
      Number(
        nullCheck.rows[0]
          ?.count || 0
      ) !== 0
    ) {
      throw new Error(
        "Availability submission migration left NULL submission IDs"
      );
    }

    const verified =
      await constraintExists(
        client,
        "item_availability_reservations",
        newConstraint
      );

    if (!verified) {
      throw new Error(
        "Availability submission unique constraint was not created"
      );
    }

    await client.query(
      "COMMIT"
    );

    console.log(
      "✅ MAKS availability submission schema ready"
    );

    return {
      skipped: false,
    };
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  runCanonicalAvailabilitySubmissionPg,
};
