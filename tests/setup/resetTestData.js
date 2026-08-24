"use strict";

const { assertTestDatabase } = require("../safety/assertTestDatabase");

/**
 * MAKS TEST DATABASE RESET
 *
 * PURPOSE:
 * Removes test data from maks_test so every automated test run
 * starts from a completely clean database.
 *
 * SAFETY:
 * - assertTestDatabase() must pass
 * - NODE_ENV must already be "test"
 * - MAKS_TEST_MODE must already be "1"
 * - DATABASE_URL must already point to maks_test
 * - We verify current_database() AGAIN on the same connection
 * - This file NEVER connects to maksdb intentionally
 */

async function resetTestData() {
  const { pool, database } = await assertTestDatabase();

  const client = await pool.connect();

  try {
    console.log("");
    console.log("🧹 MAKS TEST RESET STARTING...");
    console.log(`   Database: ${database}`);

    // -------------------------------------------------------
    // FINAL DATABASE IDENTITY CHECK
    // -------------------------------------------------------

    const identity = await client.query(`
      SELECT
        current_database() AS db,
        current_user AS db_user,
        inet_server_addr()::text AS server_addr
    `);

    const actualDb = String(
      identity.rows?.[0]?.db || ""
    );

    if (actualDb !== "maks_test") {
      throw new Error(
        `🚨 RESET REFUSED: connected to '${actualDb || "unknown"}', not 'maks_test'.`
      );
    }

    // -------------------------------------------------------
    // TRANSACTION
    // -------------------------------------------------------

    await client.query("BEGIN");

    /*
     * maks_test is an isolated disposable database.
     *
     * Therefore the safest deterministic reset is to clear
     * ALL application tables rather than trying to manually
     * chase FK relationships one table at a time.
     *
     * We deliberately:
     *
     * 1. discover BASE TABLES from public
     * 2. exclude migration-history tables if present
     * 3. TRUNCATE in one statement
     * 4. RESTART IDENTITY
     * 5. CASCADE FK dependencies
     */

    const tableResult = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    const protectedTables = new Set([
      "schema_migrations",
      "migrations",
      "knex_migrations",
      "knex_migrations_lock"
    ]);

    const tables = tableResult.rows
      .map((row) => String(row.tablename || "").trim())
      .filter(Boolean)
      .filter((name) => !protectedTables.has(name));

    if (!tables.length) {
      throw new Error(
        "🚨 RESET REFUSED: no application tables found in maks_test."
      );
    }

    // -------------------------------------------------------
    // SAFE IDENTIFIER QUOTING
    // -------------------------------------------------------

    const quoteIdent = (name) =>
      `"${String(name).replace(/"/g, '""')}"`;

    const tableSql = tables
      .map(quoteIdent)
      .join(", ");

    console.log(
      `🧹 Clearing ${tables.length} test tables...`
    );

    // -------------------------------------------------------
    // DESTRUCTIVE ACTION
    // -------------------------------------------------------

    await client.query(`
      TRUNCATE TABLE
        ${tableSql}
      RESTART IDENTITY
      CASCADE
    `);

    // -------------------------------------------------------
    // VERIFY CRITICAL TABLES ARE EMPTY
    // -------------------------------------------------------

    const verification = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM restaurants) AS restaurants,
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM restaurant_members) AS memberships,
        (SELECT COUNT(*) FROM meals) AS meals,
        (SELECT COUNT(*) FROM stock) AS stock,
        (SELECT COUNT(*) FROM tables) AS restaurant_tables,
        (SELECT COUNT(*) FROM bookings) AS bookings,
        (SELECT COUNT(*) FROM pos_orders) AS pos_orders
    `);

    const counts = verification.rows[0];

    const remaining = Object.entries(counts)
      .filter(
        ([, value]) =>
          Number(value || 0) !== 0
      );

    if (remaining.length) {
      throw new Error(
        `🚨 RESET VERIFICATION FAILED: ${JSON.stringify(
          Object.fromEntries(remaining)
        )}`
      );
    }

    // -------------------------------------------------------
    // ONE MORE DATABASE CHECK BEFORE COMMIT
    // -------------------------------------------------------

    const finalIdentity = await client.query(`
      SELECT current_database() AS db
    `);

    if (
      String(finalIdentity.rows?.[0]?.db || "") !==
      "maks_test"
    ) {
      throw new Error(
        "🚨 DATABASE IDENTITY CHANGED DURING RESET."
      );
    }

    // -------------------------------------------------------
    // COMMIT
    // -------------------------------------------------------

    await client.query("COMMIT");

    console.log("");
    console.log("✅ MAKS TEST DATABASE RESET");
    console.log(`   Tables cleared: ${tables.length}`);
    console.log("");
    console.log("   restaurants:        0");
    console.log("   users:              0");
    console.log("   restaurant_members: 0");
    console.log("   meals:              0");
    console.log("   stock:              0");
    console.log("   tables:             0");
    console.log("   bookings:           0");
    console.log("   pos_orders:          0");
    console.log("");
    console.log("🔒 Database confirmed: maks_test");
    console.log("🔒 LIVE maksdb WAS NOT USED.");
    console.log("");

    return {
      database,
      tablesCleared: tables.length
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  resetTestData().catch((err) => {
    console.error("");
    console.error("❌ TEST RESET FAILED:");
    console.error(
      err?.stack ||
      err?.message ||
      err
    );
    process.exit(1);
  });
}

module.exports = {
  resetTestData
};