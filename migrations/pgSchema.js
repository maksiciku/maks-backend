// migrations/pgSchema.js
async function ensureColumnPg(qGet, qRun, table, column, definitionSql) {
  const exists = await qGet(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [table, column]
  );

  if (!exists) {
    console.log(`➕ Adding column ${table}.${column} (${definitionSql})`);
    await qRun(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definitionSql}`);
  }
}

module.exports = { ensureColumnPg };
