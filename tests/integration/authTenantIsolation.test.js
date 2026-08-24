"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { resetTestData } =
  require("../setup/resetTestData");

const { seedTestData, TEST_PASSWORD } =
  require("../setup/seedTestData");

let app;
let fixtures;

test.before(async () => {
  /*
   * Safety/setup first.
   *
   * resetTestData + seedTestData both independently
   * enforce maks_test through assertTestDatabase().
   */
  await resetTestData();

  fixtures = await seedTestData();

  /*
   * IMPORTANT:
   * Require server only AFTER test env/database has
   * already been confirmed and fixtures created.
   *
   * server.js no longer starts app.listen() when imported.
   */
  ({ app } = require("../../server"));

  assert.ok(
    app,
    "Express app was not exported from server.js"
  );
});

test("health endpoint works", async () => {
  const res = await request(app)
    .get("/health")
    .expect(200);

  assert.equal(
    res.body?.ok,
    true
  );
});

test(
  "Owner A can login to Restaurant A",
  async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({
        username: "maks_test_owner_a",
        password: TEST_PASSWORD,
        restaurant_id: fixtures.restaurantA,
      })
      .expect(200);

    assert.ok(
      res.body?.token,
      "Owner A did not receive JWT"
    );

    assert.equal(
      Number(res.body?.user?.restaurant_id),
      fixtures.restaurantA
    );

    assert.equal(
      String(res.body?.user?.role),
      "owner"
    );
  }
);

test(
  "Owner B can login to Restaurant B",
  async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({
        username: "maks_test_owner_b",
        password: TEST_PASSWORD,
        restaurant_id: fixtures.restaurantB,
      })
      .expect(200);

    assert.ok(
      res.body?.token,
      "Owner B did not receive JWT"
    );

    assert.equal(
      Number(res.body?.user?.restaurant_id),
      fixtures.restaurantB
    );
  }
);

test(
  "Owner A CANNOT request a Restaurant B token",
  async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({
        username: "maks_test_owner_a",
        password: TEST_PASSWORD,

        // deliberate cross-tenant attack
        restaurant_id: fixtures.restaurantB,
      });

    assert.equal(
      res.status,
      403,
      `Expected 403, received ${res.status}: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.token,
      undefined,
      "SECURITY FAILURE: Owner A received Restaurant B token"
    );
  }
);

test(
  "Owner B CANNOT request a Restaurant A token",
  async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({
        username: "maks_test_owner_b",
        password: TEST_PASSWORD,

        // deliberate reverse attack
        restaurant_id: fixtures.restaurantA,
      });

    assert.equal(
      res.status,
      403,
      `Expected 403, received ${res.status}: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.token,
      undefined,
      "SECURITY FAILURE: Owner B received Restaurant A token"
    );
  }
);

test(
  "wrong password cannot authenticate",
  async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({
        username: "maks_test_owner_a",
        password: "THIS-IS-WRONG",
        restaurant_id: fixtures.restaurantA,
      });

    assert.equal(
      res.status,
      401
    );

    assert.equal(
      res.body?.token,
      undefined
    );
  }
);

test(
  "unknown user cannot authenticate",
  async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({
        username: "attacker@example.invalid",
        password: TEST_PASSWORD,
        restaurant_id: fixtures.restaurantA,
      });

    assert.equal(
      res.status,
      401
    );

    assert.equal(
      res.body?.token,
      undefined
    );
  }
);