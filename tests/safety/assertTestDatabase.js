"use strict";

/**
 * MAKS OS TEST DATABASE SAFETY GUARD
 *
 * Any destructive/integration test MUST pass through this guard first.
 *
 * It does NOT trust DATABASE_URL alone.
 * It asks PostgreSQL which database we are actually connected to.
 */

const { Pool } = require("pg");

const ALLOWED_TEST_DATABASES = new Set([
  "maks_test",
]);

async function assertTestDatabase() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "🛑 TEST BLOCKED: NODE_ENV must be exactly 'test'."
    );
  }

  if (process.env.MAKS_TEST_MODE !== "1") {
    throw new Error(
      "🛑 TEST BLOCKED: MAKS_TEST_MODE must be exactly '1'."
    );
  }

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();

  if (!databaseUrl) {
    throw new Error(
      "🛑 TEST BLOCKED: DATABASE_URL is missing."
    );
  }

  // Extra protection before even connecting.
  let parsed;

  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      "🛑 TEST BLOCKED: DATABASE_URL is invalid."
    );
  }

  const requestedDatabase =
    decodeURIComponent(parsed.pathname || "").replace(/^\/+/, "");

  if (!ALLOWED_TEST_DATABASES.has(requestedDatabase)) {
    throw new Error(
      `🛑 TEST BLOCKED: DATABASE_URL points to forbidden database '${requestedDatabase}'.`
    );
  }

  const isLocal =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1";

  if (!isLocal) {
    throw new Error(
      `🛑 TEST BLOCKED: destructive tests may only use local PostgreSQL. Host was '${parsed.hostname}'.`
    );
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: false,
  });

  try {
    // Do NOT trust the URL alone.
    // Ask PostgreSQL where we actually landed.
    const result = await pool.query(`
      SELECT
        current_database() AS database_name,
        current_user AS database_user,
        inet_server_addr()::text AS server_address
    `);

    const actualDatabase = String(
      result.rows?.[0]?.database_name || ""
    );

    if (!ALLOWED_TEST_DATABASES.has(actualDatabase)) {
      throw new Error(
        `🛑 TEST BLOCKED: PostgreSQL reports actual database '${actualDatabase}'.`
      );
    }

    if (actualDatabase === "maksdb") {
      throw new Error(
        "🚨 TEST BLOCKED: LIVE MAKS DATABASE DETECTED."
      );
    }

    console.log("🔒 MAKS TEST SAFETY CHECK PASSED");
    console.log(`   Database: ${actualDatabase}`);
    console.log(`   User:     ${result.rows?.[0]?.database_user}`);
    console.log(`   Server:   ${result.rows?.[0]?.server_address}`);

    return {
      pool,
      database: actualDatabase,
      user: result.rows?.[0]?.database_user,
    };
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

module.exports = {
  assertTestDatabase,
  ALLOWED_TEST_DATABASES,
};