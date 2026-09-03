"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;

process.env.MAKS_RUNTIME_ROLE =
  "cloud";

const { resetTestData } =
  require("../setup/resetTestData");

const {
  seedTestData,
  TEST_PASSWORD,
} = require("../setup/seedTestData");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

let app;
let fixtures;

let tokenA;
let tokenB;

let dbPool;

// =========================================================
// SAFETY HELPERS
// =========================================================

async function dbQuery(sql, params = []) {
  assert.ok(
    dbPool,
    "Test database pool has not been initialised"
  );

  return dbPool.query(sql, params);
}

function bearer(token) {
  return `Bearer ${token}`;
}

function expectBlocked(res, message) {
  assert.ok(
    [403, 404].includes(res.status),
    `${message}\n` +
      `Expected 403 or 404, received ${res.status}\n` +
      `Response: ${JSON.stringify(res.body)}`
  );
}

// =========================================================
// SETUP
// =========================================================

test.before(async () => {
  /*
   * resetTestData() and seedTestData() independently
   * enforce the maks_test safety wall.
   */
  await resetTestData();

  fixtures = await seedTestData();

  /*
   * Open a separate DB connection for verification.
   *
   * This ALSO passes through assertTestDatabase(), so
   * direct verification queries can never accidentally
   * run against maksdb.
   */
  const safeDb =
    await assertTestDatabase();

  dbPool = safeDb.pool;

  assert.equal(
    safeDb.database,
    "maks_test",
    "SECURITY FAILURE: integration test is not using maks_test"
  );

  /*
   * Import server only after test DB safety has been
   * established and fixtures exist.
   */
  ({ app } = require("../../server"));

  assert.ok(
    app,
    "Express app was not exported from server.js"
  );

  // -------------------------------------------------------
  // LOGIN OWNER A
  // -------------------------------------------------------

  const loginA = await request(app)
    .post("/auth/login")
    .send({
      username: "maks_test_owner_a",
      password: TEST_PASSWORD,
      restaurant_id: fixtures.restaurantA,
    });

  assert.equal(
    loginA.status,
    200,
    `Owner A login failed: ${JSON.stringify(
      loginA.body
    )}`
  );

  tokenA = loginA.body?.token;

  assert.ok(
    tokenA,
    "Owner A did not receive JWT"
  );

  // -------------------------------------------------------
  // LOGIN OWNER B
  // -------------------------------------------------------

  const loginB = await request(app)
    .post("/auth/login")
    .send({
      username: "maks_test_owner_b",
      password: TEST_PASSWORD,
      restaurant_id: fixtures.restaurantB,
    });

  assert.equal(
    loginB.status,
    200,
    `Owner B login failed: ${JSON.stringify(
      loginB.body
    )}`
  );

  tokenB = loginB.body?.token;

  assert.ok(
    tokenB,
    "Owner B did not receive JWT"
  );
});

test.after(async () => {
  try {
    if (dbPool) {
      await dbPool.end();
    }
  } finally {
    if (
      originalRuntimeRole == null
    ) {
      delete process.env
        .MAKS_RUNTIME_ROLE;
    } else {
      process.env
        .MAKS_RUNTIME_ROLE =
        originalRuntimeRole;
    }
  }
});

// =========================================================
// DATABASE FIXTURE SANITY
// =========================================================

test(
  "fixtures really belong to separate tenants",
  async () => {
    const meals = await dbQuery(
      `
      SELECT
        id,
        restaurant_id,
        name,
        price
      FROM meals
      WHERE id IN ($1, $2)
      ORDER BY id
      `,
      [
        fixtures.mealA,
        fixtures.mealB,
      ]
    );

    assert.equal(
      meals.rows.length,
      2
    );

    const mealA = meals.rows.find(
      (row) =>
        Number(row.id) ===
        Number(fixtures.mealA)
    );

    const mealB = meals.rows.find(
      (row) =>
        Number(row.id) ===
        Number(fixtures.mealB)
    );

    assert.ok(mealA);
    assert.ok(mealB);

    assert.equal(
      Number(mealA.restaurant_id),
      Number(fixtures.restaurantA)
    );

    assert.equal(
      Number(mealB.restaurant_id),
      Number(fixtures.restaurantB)
    );

    assert.notEqual(
      Number(mealA.restaurant_id),
      Number(mealB.restaurant_id)
    );
  }
);

// =========================================================
// MEAL READ ISOLATION
// =========================================================

test(
  "Owner A can read Meal A",
  async () => {
    const res = await request(app)
      .get(`/meals/${fixtures.mealA}`)
      .set(
        "Authorization",
        bearer(tokenA)
      );

    assert.equal(
      res.status,
      200,
      `Owner A could not read own meal: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      Number(res.body?.id),
      Number(fixtures.mealA)
    );
  }
);

test(
  "Owner B can read Meal B",
  async () => {
    const res = await request(app)
      .get(`/meals/${fixtures.mealB}`)
      .set(
        "Authorization",
        bearer(tokenB)
      );

    assert.equal(
      res.status,
      200,
      `Owner B could not read own meal: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      Number(res.body?.id),
      Number(fixtures.mealB)
    );
  }
);

test(
  "Owner A CANNOT read Restaurant B meal by direct ID",
  async () => {
    const res = await request(app)
      .get(`/meals/${fixtures.mealB}`)
      .set(
        "Authorization",
        bearer(tokenA)
      );

    expectBlocked(
      res,
      "SECURITY FAILURE: Owner A accessed Restaurant B meal"
    );
  }
);

test(
  "Owner B CANNOT read Restaurant A meal by direct ID",
  async () => {
    const res = await request(app)
      .get(`/meals/${fixtures.mealA}`)
      .set(
        "Authorization",
        bearer(tokenB)
      );

    expectBlocked(
      res,
      "SECURITY FAILURE: Owner B accessed Restaurant A meal"
    );
  }
);

// =========================================================
// MEAL LIST ISOLATION
// =========================================================

test(
  "Owner A meal list does not expose Restaurant B meal",
  async () => {
    const res = await request(app)
      .get("/meals/")
      .set(
        "Authorization",
        bearer(tokenA)
      );

    assert.equal(
      res.status,
      200,
      JSON.stringify(res.body)
    );

    assert.ok(
      Array.isArray(res.body)
    );

    const leaked =
      res.body.some(
        (meal) =>
          Number(meal.id) ===
            Number(fixtures.mealB) ||
          Number(meal.restaurant_id) ===
            Number(fixtures.restaurantB)
      );

    assert.equal(
      leaked,
      false,
      "SECURITY FAILURE: Restaurant B meal leaked into Owner A meal list"
    );
  }
);

test(
  "Owner B meal list does not expose Restaurant A meal",
  async () => {
    const res = await request(app)
      .get("/meals/")
      .set(
        "Authorization",
        bearer(tokenB)
      );

    assert.equal(
      res.status,
      200,
      JSON.stringify(res.body)
    );

    assert.ok(
      Array.isArray(res.body)
    );

    const leaked =
      res.body.some(
        (meal) =>
          Number(meal.id) ===
            Number(fixtures.mealA) ||
          Number(meal.restaurant_id) ===
            Number(fixtures.restaurantA)
      );

    assert.equal(
      leaked,
      false,
      "SECURITY FAILURE: Restaurant A meal leaked into Owner B meal list"
    );
  }
);

// =========================================================
// FORGED TENANT HEADER ATTACK
// =========================================================

test(
  "Owner A cannot switch to Restaurant B using x-tenant-rid",
  async () => {
    const res = await request(app)
      .get("/meals/")
      .set(
        "Authorization",
        bearer(tokenA)
      )
      .set(
        "x-tenant-rid",
        String(fixtures.restaurantB)
      );

    /*
     * Either:
     *
     * 1. server rejects the forged tenant => 403
     *
     * OR
     *
     * 2. server ignores the header and remains tenant A.
     *
     * Both are secure.
     */

    if (res.status === 403) {
      return;
    }

    assert.equal(
      res.status,
      200,
      `Unexpected status: ${res.status} ${JSON.stringify(
        res.body
      )}`
    );

    assert.ok(
      Array.isArray(res.body)
    );

    const leaked =
      res.body.some(
        (meal) =>
          Number(meal.id) ===
            Number(fixtures.mealB) ||
          Number(meal.restaurant_id) ===
            Number(fixtures.restaurantB)
      );

    assert.equal(
      leaked,
      false,
      "SECURITY FAILURE: x-tenant-rid switched Owner A into Restaurant B"
    );
  }
);

// =========================================================
// MEAL WRITE ISOLATION
// =========================================================

test(
  "Owner A CANNOT modify Restaurant B meal",
  async () => {
    const before =
      await dbQuery(
        `
        SELECT
          name,
          price,
          restaurant_id
        FROM meals
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.mealB,
          fixtures.restaurantB,
        ]
      );

    assert.equal(
      before.rows.length,
      1
    );

    const original =
      before.rows[0];

    const res = await request(app)
      .put(`/meals/${fixtures.mealB}`)
      .set(
        "Authorization",
        bearer(tokenA)
      )
      .send({
        name: "HACKED BY TENANT A",
        price: 0.01,
      });

    expectBlocked(
      res,
      "SECURITY FAILURE: Owner A modified Restaurant B meal"
    );

    /*
     * HTTP response is NOT enough.
     *
     * Verify Restaurant B's database row physically
     * remained untouched.
     */
    const after =
      await dbQuery(
        `
        SELECT
          name,
          price,
          restaurant_id
        FROM meals
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.mealB,
          fixtures.restaurantB,
        ]
      );

    assert.equal(
      after.rows.length,
      1
    );

    assert.equal(
      after.rows[0].name,
      original.name,
      "SECURITY FAILURE: Restaurant B meal name changed"
    );

    assert.equal(
      Number(after.rows[0].price),
      Number(original.price),
      "SECURITY FAILURE: Restaurant B meal price changed"
    );

    assert.equal(
      Number(after.rows[0].restaurant_id),
      Number(fixtures.restaurantB)
    );
  }
);

// =========================================================
// STOCK LIST ISOLATION
// =========================================================

test(
  "Owner A stock list contains no Restaurant B stock",
  async () => {
    const res = await request(app)
      .get("/stock/")
      .set(
        "Authorization",
        bearer(tokenA)
      );

    assert.equal(
      res.status,
      200,
      JSON.stringify(res.body)
    );

    assert.ok(
      Array.isArray(res.body)
    );

    const leaked =
      res.body.some(
        (item) =>
          Number(item.restaurant_id) ===
          Number(fixtures.restaurantB)
      );

    assert.equal(
      leaked,
      false,
      "SECURITY FAILURE: Restaurant B stock leaked to Owner A"
    );

    const beefB =
      res.body.some(
        (item) =>
          String(
            item.ingredient || ""
          ) === "TEST Beef B"
      );

    assert.equal(
      beefB,
      false,
      "SECURITY FAILURE: TEST Beef B leaked to Owner A"
    );
  }
);

test(
  "Owner B stock list contains no Restaurant A stock",
  async () => {
    const res = await request(app)
      .get("/stock/")
      .set(
        "Authorization",
        bearer(tokenB)
      );

    assert.equal(
      res.status,
      200,
      JSON.stringify(res.body)
    );

    assert.ok(
      Array.isArray(res.body)
    );

    const leaked =
      res.body.some(
        (item) =>
          Number(item.restaurant_id) ===
          Number(fixtures.restaurantA)
      );

    assert.equal(
      leaked,
      false,
      "SECURITY FAILURE: Restaurant A stock leaked to Owner B"
    );

    const beefA =
      res.body.some(
        (item) =>
          String(
            item.ingredient || ""
          ) === "TEST Beef A"
      );

    assert.equal(
      beefA,
      false,
      "SECURITY FAILURE: TEST Beef A leaked to Owner B"
    );
  }
);

// =========================================================
// STOCK DIRECT-ID WRITE ATTACK
// =========================================================

test(
  "Owner A CANNOT modify Restaurant B stock by direct ID",
  async () => {
    const before =
      await dbQuery(
        `
        SELECT
          id,
          restaurant_id,
          ingredient,
          quantity,
          price
        FROM stock
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.stockB,
          fixtures.restaurantB,
        ]
      );

    assert.equal(
      before.rows.length,
      1,
      "Restaurant B stock fixture missing"
    );

    const original =
      before.rows[0];

    const res = await request(app)
      .put(`/stock/${fixtures.stockB}`)
      .set(
        "Authorization",
        bearer(tokenA)
      )
      .send({
        quantity: 1,
      });

    expectBlocked(
      res,
      "SECURITY FAILURE: Owner A modified Restaurant B stock"
    );

    const after =
      await dbQuery(
        `
        SELECT
          id,
          restaurant_id,
          ingredient,
          quantity,
          price
        FROM stock
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.stockB,
          fixtures.restaurantB,
        ]
      );

    assert.equal(
      after.rows.length,
      1
    );

    assert.equal(
      Number(after.rows[0].quantity),
      Number(original.quantity),
      "SECURITY FAILURE: Restaurant B stock quantity changed"
    );

    assert.equal(
      Number(after.rows[0].price),
      Number(original.price),
      "SECURITY FAILURE: Restaurant B stock price changed"
    );

    assert.equal(
      after.rows[0].ingredient,
      original.ingredient
    );
  }
);

// =========================================================
// STOCK DELETE ATTACK
// =========================================================

test(
  "Owner A CANNOT delete Restaurant B stock by direct ID",
  async () => {
    const before =
      await dbQuery(
        `
        SELECT id
        FROM stock
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.stockB,
          fixtures.restaurantB,
        ]
      );

    assert.equal(
      before.rows.length,
      1
    );

    const res = await request(app)
      .delete(`/stock/${fixtures.stockB}`)
      .set(
        "Authorization",
        bearer(tokenA)
      );

    expectBlocked(
      res,
      "SECURITY FAILURE: Owner A deleted Restaurant B stock"
    );

    const after =
      await dbQuery(
        `
        SELECT id
        FROM stock
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.stockB,
          fixtures.restaurantB,
        ]
      );

    assert.equal(
      after.rows.length,
      1,
      "SECURITY FAILURE: Restaurant B stock was physically deleted"
    );
  }
);

// =========================================================
// REVERSE STOCK ATTACK
// =========================================================

test(
  "Owner B CANNOT modify Restaurant A stock by direct ID",
  async () => {
    const before =
      await dbQuery(
        `
        SELECT
          quantity
        FROM stock
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.stockA,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      before.rows.length,
      1
    );

    const originalQuantity =
      Number(before.rows[0].quantity);

    const res = await request(app)
      .put(`/stock/${fixtures.stockA}`)
      .set(
        "Authorization",
        bearer(tokenB)
      )
      .send({
        quantity: 999999,
      });

    expectBlocked(
      res,
      "SECURITY FAILURE: Owner B modified Restaurant A stock"
    );

    const after =
      await dbQuery(
        `
        SELECT quantity
        FROM stock
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.stockA,
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      after.rows.length,
      1
    );

    assert.equal(
      Number(after.rows[0].quantity),
      originalQuantity,
      "SECURITY FAILURE: Restaurant A stock quantity changed"
    );
  }
);

// =========================================================
// FINAL DATABASE TENANT INTEGRITY
// =========================================================

test(
  "final database state still preserves tenant ownership",
  async () => {
    const mealA =
      await dbQuery(
        `
        SELECT restaurant_id
        FROM meals
        WHERE id = $1
        `,
        [fixtures.mealA]
      );

    const mealB =
      await dbQuery(
        `
        SELECT restaurant_id
        FROM meals
        WHERE id = $1
        `,
        [fixtures.mealB]
      );

    const stockA =
      await dbQuery(
        `
        SELECT restaurant_id
        FROM stock
        WHERE id = $1
        `,
        [fixtures.stockA]
      );

    const stockB =
      await dbQuery(
        `
        SELECT restaurant_id
        FROM stock
        WHERE id = $1
        `,
        [fixtures.stockB]
      );

    assert.equal(
      Number(
        mealA.rows[0]?.restaurant_id
      ),
      Number(fixtures.restaurantA)
    );

    assert.equal(
      Number(
        mealB.rows[0]?.restaurant_id
      ),
      Number(fixtures.restaurantB)
    );

    assert.equal(
      Number(
        stockA.rows[0]?.restaurant_id
      ),
      Number(fixtures.restaurantA)
    );

    assert.equal(
      Number(
        stockB.rows[0]?.restaurant_id
      ),
      Number(fixtures.restaurantB)
    );
  }
);