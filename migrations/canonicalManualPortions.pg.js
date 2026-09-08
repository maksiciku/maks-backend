"use strict";


async function requireTable(
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

  if (!rows.length) {
    throw new Error(
      `Canonical manual portions refused: public.${table} is missing`
    );
  }
}


async function readColumn(
  client,
  table,
  column
) {
  const { rows } =
    await client.query(
      `
      SELECT
        data_type,
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


async function assertColumn({
  client,
  table,
  column,
  type,
  nullable,
  defaultFalse = false,
}) {
  const row =
    await readColumn(
      client,
      table,
      column
    );

  if (!row) {
    throw new Error(
      `Canonical manual portions verification failed: public.${table}.${column} is missing`
    );
  }

  if (
    row.data_type !== type
  ) {
    throw new Error(
      `Canonical manual portions refused: public.${table}.${column} expected ${type}, got ${row.data_type}`
    );
  }

  if (
    row.is_nullable !== nullable
  ) {
    throw new Error(
      `Canonical manual portions refused: public.${table}.${column} expected nullable=${nullable}, got ${row.is_nullable}`
    );
  }

  if (
    defaultFalse &&
    !/false/i.test(
      String(
        row.column_default || ""
      )
    )
  ) {
    throw new Error(
      `Canonical manual portions refused: public.${table}.${column} must default FALSE`
    );
  }
}


async function runCanonicalManualPortionsPg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !==
      "function"
  ) {
    throw new Error(
      "Canonical manual portions require PostgreSQL pool"
    );
  }

  console.log(
    "🍽️ Running canonical MAKS manual-portion compatibility..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    for (const table of [
      "meals",
      "menu_items",
    ]) {
      await requireTable(
        client,
        table
      );
    }

    await client.query(`
      ALTER TABLE public.meals
      ADD COLUMN IF NOT EXISTS
        manual_portions_enabled
        BOOLEAN
        NOT NULL
        DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE public.meals
      ADD COLUMN IF NOT EXISTS
        manual_portions_available
        INTEGER;
    `);

    await client.query(`
      ALTER TABLE public.menu_items
      ADD COLUMN IF NOT EXISTS
        manual_portions_enabled
        BOOLEAN
        NOT NULL
        DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE public.menu_items
      ADD COLUMN IF NOT EXISTS
        manual_portions_available
        INTEGER;
    `);

    for (const table of [
      "meals",
      "menu_items",
    ]) {
      await assertColumn({
        client,
        table,
        column:
          "manual_portions_enabled",
        type:
          "boolean",
        nullable:
          "NO",
        defaultFalse:
          true,
      });

      await assertColumn({
        client,
        table,
        column:
          "manual_portions_available",
        type:
          "integer",
        nullable:
          "YES",
      });

      const nullEnabled =
        await client.query(
          `
          SELECT
            COUNT(*)::int AS count
          FROM public.${table}
          WHERE manual_portions_enabled
            IS NULL
          `
        );

      if (
        Number(
          nullEnabled.rows?.[0]
            ?.count || 0
        ) !== 0
      ) {
        throw new Error(
          `Canonical manual portions verification failed: public.${table}.manual_portions_enabled contains NULL`
        );
      }
    }

    await client.query(
      "COMMIT"
    );

    console.log(
      "✅ Canonical MAKS manual-portion compatibility ready"
    );
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch (_) {
    }

    throw error;
  } finally {
    client.release();
  }
}


module.exports = {
  runCanonicalManualPortionsPg,
};
