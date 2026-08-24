"use strict";

const bcrypt = require("bcryptjs");
const { assertTestDatabase } = require("../safety/assertTestDatabase");

const TEST_PASSWORD = "MAKS-TEST-ONLY-Password-123!";

async function seedTestData() {
  const { pool, database } = await assertTestDatabase();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log(`🧪 Seeding MAKS test fixtures into ${database}...`);

    // -------------------------------------------------------
    // FINAL SAFETY CHECK
    // -------------------------------------------------------

    const identity = await client.query(`
      SELECT
        current_database() AS db,
        current_user AS db_user
    `);

    const actualDb = String(identity.rows?.[0]?.db || "");

    if (actualDb !== "maks_test") {
      throw new Error(
        `🚨 REFUSING TO SEED DATABASE: ${actualDb || "unknown"}`
      );
    }

    // -------------------------------------------------------
    // PREVENT ACCIDENTAL DOUBLE-SEEDING
    // -------------------------------------------------------

    const existingFixtures = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM restaurants
      WHERE name IN (
        'MAKS TEST RESTAURANT A',
        'MAKS TEST RESTAURANT B'
      )
    `);

    if (Number(existingFixtures.rows?.[0]?.count || 0) > 0) {
      throw new Error(
        "🛑 TEST FIXTURES ALREADY EXIST. Run resetTestData.js before seeding again."
      );
    }

    // -------------------------------------------------------
    // RESTAURANT A
    // -------------------------------------------------------

    const restaurantAResult = await client.query(
      `
      INSERT INTO restaurants (
        name,
        timezone,
        account_status,
        billing_status,
        stock_deduction_enabled,
        hold_qr_kiosk_until_paid,
        portion_tracking_mode,
        selling_mode,

        service_charge_enabled,
        service_charge_rate,
        manual_discounts_enabled,
        max_manual_discount_percent,
        service_charge_vat_mode
      )
      VALUES (
        $1,
        'Europe/London',
        'active',
        'active',
        TRUE,
        TRUE,
        'ingredients',
        'full_stock',

        FALSE,
        10.00,
        TRUE,
        100.00,
        'discretionary'
      )
      RETURNING id
      `,
      ["MAKS TEST RESTAURANT A"]
    );

    const restaurantA = Number(
      restaurantAResult.rows[0].id
    );

    // -------------------------------------------------------
    // RESTAURANT B
    // -------------------------------------------------------

    const restaurantBResult = await client.query(
      `
      INSERT INTO restaurants (
        name,
        timezone,
        account_status,
        billing_status,
        stock_deduction_enabled,
        hold_qr_kiosk_until_paid,
        portion_tracking_mode,
        selling_mode,

        service_charge_enabled,
        service_charge_rate,
        manual_discounts_enabled,
        max_manual_discount_percent,
        service_charge_vat_mode
      )
      VALUES (
        $1,
        'Europe/London',
        'active',
        'active',
        TRUE,
        TRUE,
        'ingredients',
        'full_stock',

        FALSE,
        10.00,
        TRUE,
        100.00,
        'discretionary'
      )
      RETURNING id
      `,
      ["MAKS TEST RESTAURANT B"]
    );

    const restaurantB = Number(
      restaurantBResult.rows[0].id
    );

    // -------------------------------------------------------
    // USERS
    // -------------------------------------------------------

    const passwordHash = await bcrypt.hash(
      TEST_PASSWORD,
      10
    );

    const ownerAResult = await client.query(
      `
      INSERT INTO users (
        username,
        password,
        password_hash,
        role,
        restaurant_id,
        is_active,
        can_pos_login,
        can_backoffice_login,
        full_name,
        permissions
      )
      VALUES (
        $1,
        $2,
        $2,
        'owner',
        $3,
        TRUE,
        TRUE,
        TRUE,
        'Test Owner A',
        '["*"]'
      )
      RETURNING id
      `,
      [
        "maks_test_owner_a",
        passwordHash,
        restaurantA,
      ]
    );

    const ownerA = Number(
      ownerAResult.rows[0].id
    );

    const ownerBResult = await client.query(
      `
      INSERT INTO users (
        username,
        password,
        password_hash,
        role,
        restaurant_id,
        is_active,
        can_pos_login,
        can_backoffice_login,
        full_name,
        permissions
      )
      VALUES (
        $1,
        $2,
        $2,
        'owner',
        $3,
        TRUE,
        TRUE,
        TRUE,
        'Test Owner B',
        '["*"]'
      )
      RETURNING id
      `,
      [
        "maks_test_owner_b",
        passwordHash,
        restaurantB,
      ]
    );

    const ownerB = Number(
      ownerBResult.rows[0].id
    );

    // -------------------------------------------------------
    // RESTAURANT MEMBERSHIPS
    //
    // VERY IMPORTANT:
    // A belongs ONLY to A.
    // B belongs ONLY to B.
    //
    // This is what makes the tenant attack tests meaningful.
    // -------------------------------------------------------

    await client.query(
      `
      INSERT INTO restaurant_members (
        restaurant_id,
        user_id,
        role,
        status,
        is_active,
        authority,
        job_title,
        permissions
      )
      VALUES
        (
          $1,
          $2,
          'owner',
          'active',
          TRUE,
          'owner',
          'Owner',
          '["*"]'::jsonb
        ),
        (
          $3,
          $4,
          'owner',
          'active',
          TRUE,
          'owner',
          'Owner',
          '["*"]'::jsonb
        )
      `,
      [
        restaurantA,
        ownerA,
        restaurantB,
        ownerB,
      ]
    );

    // -------------------------------------------------------
    // CATEGORIES
    // -------------------------------------------------------

    const categoryAResult = await client.query(
      `
      INSERT INTO categories (
        name,
        type,
        restaurant_id,
        station
      )
      VALUES (
        'Test Mains A',
        'meal',
        $1,
        'kitchen'
      )
      RETURNING id
      `,
      [restaurantA]
    );

    const categoryA = Number(
      categoryAResult.rows[0].id
    );

    const categoryBResult = await client.query(
      `
      INSERT INTO categories (
        name,
        type,
        restaurant_id,
        station
      )
      VALUES (
        'Test Mains B',
        'meal',
        $1,
        'kitchen'
      )
      RETURNING id
      `,
      [restaurantB]
    );

    const categoryB = Number(
      categoryBResult.rows[0].id
    );

    // -------------------------------------------------------
    // MEALS
    // -------------------------------------------------------

    const mealAResult = await client.query(
      `
      INSERT INTO meals (
        name,
        ingredients,
        price,
        category,
        category_id,
        restaurant_id,
        is_available,
        out_of_stock,
        vat_rate,
        options_schema
      )
      VALUES (
        'TEST Burger A',
        '[]'::jsonb,
        12.50,
        'Meals',
        $1,
        $2,
        TRUE,
        FALSE,
        20,
        $3::jsonb
      )
      RETURNING id
      `,
      [
        categoryA,
        restaurantA,
        JSON.stringify([
          {
            id: "test_side",
            label: "Side",
            type: "single",
            required: true,
            choices: [
              {
                id: "test_chips",
                label: "Chips",
                priceDelta: 0,
              },
              {
                id: "test_salad",
                label: "Salad",
                priceDelta: 1.5,
              },
            ],
          },
        ]),
      ]
    );

    const mealA = Number(
      mealAResult.rows[0].id
    );

    const mealBResult = await client.query(
      `
      INSERT INTO meals (
        name,
        ingredients,
        price,
        category,
        category_id,
        restaurant_id,
        is_available,
        out_of_stock,
        vat_rate,
        options_schema
      )
      VALUES (
        'TEST Burger B',
        '[]'::jsonb,
        99.99,
        'Meals',
        $1,
        $2,
        TRUE,
        FALSE,
        20,
        '[]'::jsonb
      )
      RETURNING id
      `,
      [
        categoryB,
        restaurantB,
      ]
    );

    const mealB = Number(
      mealBResult.rows[0].id
    );

    // -------------------------------------------------------
    // STOCK
    // -------------------------------------------------------

    const stockAResult = await client.query(
      `
      INSERT INTO stock (
        ingredient,
        quantity,
        unit,
        price,
        minimum_level,
        type,
        restaurant_id
      )
      VALUES (
        'TEST Beef A',
        100,
        'unit',
        1.50,
        10,
        'ingredient',
        $1
      )
      RETURNING id
      `,
      [restaurantA]
    );

    const stockA = Number(
      stockAResult.rows[0].id
    );

    const stockBResult = await client.query(
      `
      INSERT INTO stock (
        ingredient,
        quantity,
        unit,
        price,
        minimum_level,
        type,
        restaurant_id
      )
      VALUES (
        'TEST Beef B',
        777,
        'unit',
        9.99,
        20,
        'ingredient',
        $1
      )
      RETURNING id
      `,
      [restaurantB]
    );

    const stockB = Number(
      stockBResult.rows[0].id
    );

    // -------------------------------------------------------
    // TABLES
    // -------------------------------------------------------

    const tableAResult = await client.query(
      `
      INSERT INTO tables (
        name,
        seats,
        restaurant_id,
        status
      )
      VALUES (
        'TEST-A-1',
        4,
        $1,
        'free'
      )
      RETURNING id
      `,
      [restaurantA]
    );

    const tableA = Number(
      tableAResult.rows[0].id
    );

    const tableBResult = await client.query(
      `
      INSERT INTO tables (
        name,
        seats,
        restaurant_id,
        status
      )
      VALUES (
        'TEST-B-1',
        6,
        $1,
        'free'
      )
      RETURNING id
      `,
      [restaurantB]
    );

    const tableB = Number(
      tableBResult.rows[0].id
    );

    // -------------------------------------------------------
    // TABLE MAP
    // -------------------------------------------------------

    await client.query(
      `
      INSERT INTO table_map (
        name,
        shape,
        seats,
        x,
        y,
        zone,
        status,
        restaurant_id
      )
      VALUES
        (
          'TEST-A-1',
          'square',
          4,
          100,
          100,
          'Main',
          'available',
          $1
        ),
        (
          'TEST-B-1',
          'square',
          6,
          200,
          200,
          'Main',
          'available',
          $2
        )
      `,
      [
        restaurantA,
        restaurantB,
      ]
    );

    // -------------------------------------------------------
    // BOOKINGS
    // -------------------------------------------------------

    const bookingAResult = await client.query(
      `
      INSERT INTO bookings (
        customer_name,
        phone,
        booking_time,
        guests,
        table_name,
        status,
        slot_min,
        restaurant_id
      )
      VALUES (
        'TEST Customer A',
        '0000000001',
        NOW() + INTERVAL '1 day',
        4,
        'TEST-A-1',
        'booked',
        90,
        $1
      )
      RETURNING id
      `,
      [restaurantA]
    );

    const bookingA = Number(
      bookingAResult.rows[0].id
    );

    const bookingBResult = await client.query(
      `
      INSERT INTO bookings (
        customer_name,
        phone,
        booking_time,
        guests,
        table_name,
        status,
        slot_min,
        restaurant_id
      )
      VALUES (
        'TEST Customer B',
        '0000000002',
        NOW() + INTERVAL '1 day',
        6,
        'TEST-B-1',
        'booked',
        90,
        $1
      )
      RETURNING id
      `,
      [restaurantB]
    );

    const bookingB = Number(
      bookingBResult.rows[0].id
    );

    // -------------------------------------------------------
    // VERIFY TENANT FIXTURES BEFORE COMMIT
    // -------------------------------------------------------

    const verification = await client.query(
      `
      SELECT
        (SELECT COUNT(*) FROM restaurants) AS restaurants,
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM restaurant_members) AS memberships,
        (SELECT COUNT(*) FROM meals) AS meals,
        (SELECT COUNT(*) FROM stock) AS stock,
        (SELECT COUNT(*) FROM tables) AS tables,
        (SELECT COUNT(*) FROM bookings) AS bookings
      `
    );

    const counts = verification.rows[0];

    if (
      Number(counts.restaurants) !== 2 ||
      Number(counts.users) !== 2 ||
      Number(counts.memberships) !== 2 ||
      Number(counts.meals) !== 2 ||
      Number(counts.stock) !== 2 ||
      Number(counts.tables) !== 2 ||
      Number(counts.bookings) !== 2
    ) {
      throw new Error(
        `Fixture verification failed: ${JSON.stringify(counts)}`
      );
    }

    // -------------------------------------------------------
    // COMMIT
    // -------------------------------------------------------

    await client.query("COMMIT");

    console.log("");
    console.log("✅ MAKS TEST DATA SEEDED");
    console.log(`   Database:       ${database}`);
    console.log("");
    console.log(`   Restaurant A:   ${restaurantA}`);
    console.log(`   Owner A:        ${ownerA}`);
    console.log(`   Category A:     ${categoryA}`);
    console.log(`   Meal A:         ${mealA}`);
    console.log(`   Stock A:        ${stockA}`);
    console.log(`   Table A:        ${tableA}`);
    console.log(`   Booking A:      ${bookingA}`);
    console.log("");
    console.log(`   Restaurant B:   ${restaurantB}`);
    console.log(`   Owner B:        ${ownerB}`);
    console.log(`   Category B:     ${categoryB}`);
    console.log(`   Meal B:         ${mealB}`);
    console.log(`   Stock B:        ${stockB}`);
    console.log(`   Table B:        ${tableB}`);
    console.log(`   Booking B:      ${bookingB}`);
    console.log("");
    console.log("🔒 Tenant memberships are deliberately isolated.");
    console.log("🔒 LIVE maksdb WAS NOT USED.");

    return {
      database,

      password: TEST_PASSWORD,

      restaurantA,
      ownerA,
      categoryA,
      mealA,
      stockA,
      tableA,
      bookingA,

      restaurantB,
      ownerB,
      categoryB,
      mealB,
      stockB,
      tableB,
      bookingB,
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
  seedTestData().catch((err) => {
    console.error("");
    console.error("❌ TEST SEED FAILED:");
    console.error(
      err?.stack ||
      err?.message ||
      err
    );
    process.exit(1);
  });
}

module.exports = {
  seedTestData,
  TEST_PASSWORD,
};