"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

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

function bearer(token) {
  return `Bearer ${token}`;
}

function expectBlocked(res, message) {
  assert.ok(
    [403, 404].includes(res.status),
    `${message}\nExpected 403/404, got ${res.status}\n${JSON.stringify(res.body)}`
  );
}

async function dbQuery(sql, params = []) {
  return dbPool.query(sql, params);
}

test.before(async () => {
  await resetTestData();
  fixtures = await seedTestData();

  const safe = await assertTestDatabase();
  dbPool = safe.pool;

  assert.equal(safe.database, "maks_test");

  ({ app } = require("../../server"));

  const a = await request(app)
    .post("/auth/login")
    .send({
      username: "maks_test_owner_a",
      password: TEST_PASSWORD,
      restaurant_id: fixtures.restaurantA,
    });

  assert.equal(a.status, 200);
  tokenA = a.body.token;

  const b = await request(app)
    .post("/auth/login")
    .send({
      username: "maks_test_owner_b",
      password: TEST_PASSWORD,
      restaurant_id: fixtures.restaurantB,
    });

  assert.equal(b.status, 200);
  tokenB = b.body.token;
});

test.after(async () => {
  if (dbPool) await dbPool.end();
});

test("Owner A table list does not expose Restaurant B", async () => {
  const res = await request(app)
    .get("/tables/")
    .set("Authorization", bearer(tokenA));

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  assert.equal(
    res.body.some(
      (t) =>
        Number(t.id) === Number(fixtures.tableB) ||
        String(t.name) === "TEST-B-1"
    ),
    false
  );
});

test("Owner B table list does not expose Restaurant A", async () => {
  const res = await request(app)
    .get("/tables/")
    .set("Authorization", bearer(tokenB));

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  assert.equal(
    res.body.some(
      (t) =>
        Number(t.id) === Number(fixtures.tableA) ||
        String(t.name) === "TEST-A-1"
    ),
    false
  );
});

test("Owner A cannot read Restaurant B table total", async () => {
  const res = await request(app)
    .get(`/tables/${fixtures.tableB}/total`)
    .set("Authorization", bearer(tokenA));

  expectBlocked(
    res,
    "SECURITY FAILURE: Owner A accessed Restaurant B table total"
  );
});

test("Owner A cannot change Restaurant B table status", async () => {
  const before = await dbQuery(
    `
    SELECT status
    FROM tables
    WHERE id = $1 AND restaurant_id = $2
    `,
    [fixtures.tableB, fixtures.restaurantB]
  );

  const original = before.rows[0].status;

  const res = await request(app)
    .put(`/tables/${fixtures.tableB}/status`)
    .set("Authorization", bearer(tokenA))
    .send({ status: "occupied" });

  expectBlocked(
    res,
    "SECURITY FAILURE: Owner A changed Restaurant B table"
  );

  const after = await dbQuery(
    `
    SELECT status
    FROM tables
    WHERE id = $1 AND restaurant_id = $2
    `,
    [fixtures.tableB, fixtures.restaurantB]
  );

  assert.equal(after.rows[0].status, original);
});

test("Owner B cannot change Restaurant A table status", async () => {
  const before = await dbQuery(
    `
    SELECT status
    FROM tables
    WHERE id = $1 AND restaurant_id = $2
    `,
    [fixtures.tableA, fixtures.restaurantA]
  );

  const original = before.rows[0].status;

  const res = await request(app)
    .put(`/tables/${fixtures.tableA}/status`)
    .set("Authorization", bearer(tokenB))
    .send({ status: "occupied" });

  expectBlocked(
    res,
    "SECURITY FAILURE: Owner B changed Restaurant A table"
  );

  const after = await dbQuery(
    `
    SELECT status
    FROM tables
    WHERE id = $1 AND restaurant_id = $2
    `,
    [fixtures.tableA, fixtures.restaurantA]
  );

  assert.equal(after.rows[0].status, original);
});

test("Owner A cannot close Restaurant B table by name", async () => {
  const res = await request(app)
    .post("/tables/TEST-B-1/close")
    .set("Authorization", bearer(tokenA));

  expectBlocked(
    res,
    "SECURITY FAILURE: Owner A closed Restaurant B table"
  );
});

test("Owner A booking list does not expose Restaurant B booking", async () => {
  const res = await request(app)
    .get("/bookings/")
    .set("Authorization", bearer(tokenA));

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  assert.equal(
    res.body.some(
      (b) =>
        Number(b.id) === Number(fixtures.bookingB) ||
        Number(b.restaurant_id) === Number(fixtures.restaurantB)
    ),
    false
  );
});

test("Owner B booking list does not expose Restaurant A booking", async () => {
  const res = await request(app)
    .get("/bookings/")
    .set("Authorization", bearer(tokenB));

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  assert.equal(
    res.body.some(
      (b) =>
        Number(b.id) === Number(fixtures.bookingA) ||
        Number(b.restaurant_id) === Number(fixtures.restaurantA)
    ),
    false
  );
});

test("Owner A cannot edit Restaurant B booking", async () => {
  const before = await dbQuery(
    `
    SELECT customer_name, guests, status
    FROM bookings
    WHERE id = $1 AND restaurant_id = $2
    `,
    [fixtures.bookingB, fixtures.restaurantB]
  );

  const original = before.rows[0];

  const res = await request(app)
    .put(`/bookings/${fixtures.bookingB}`)
    .set("Authorization", bearer(tokenA))
    .send({
      customer_name: "HACKED BY A",
      guests: 99,
    });

  expectBlocked(
    res,
    "SECURITY FAILURE: Owner A edited Restaurant B booking"
  );

  const after = await dbQuery(
    `
    SELECT customer_name, guests, status
    FROM bookings
    WHERE id = $1 AND restaurant_id = $2
    `,
    [fixtures.bookingB, fixtures.restaurantB]
  );

  assert.equal(after.rows[0].customer_name, original.customer_name);
  assert.equal(Number(after.rows[0].guests), Number(original.guests));
  assert.equal(after.rows[0].status, original.status);
});

test("Owner A cannot cancel Restaurant B booking", async () => {
  const res = await request(app)
    .put(`/bookings/${fixtures.bookingB}`)
    .set("Authorization", bearer(tokenA))
    .send({
      status: "cancelled",
    });

  expectBlocked(
    res,
    "SECURITY FAILURE: Owner A cancelled Restaurant B booking"
  );

  const after = await dbQuery(
    `
    SELECT status
    FROM bookings
    WHERE id = $1 AND restaurant_id = $2
    `,
    [fixtures.bookingB, fixtures.restaurantB]
  );

  assert.notEqual(
    String(after.rows[0].status).toLowerCase(),
    "cancelled"
  );
});

test("Owner A cannot delete Restaurant B booking", async () => {
  const res = await request(app)
    .delete(`/bookings/${fixtures.bookingB}`)
    .set("Authorization", bearer(tokenA));

  expectBlocked(
    res,
    "SECURITY FAILURE: Owner A deleted Restaurant B booking"
  );

  const after = await dbQuery(
    `
    SELECT id
    FROM bookings
    WHERE id = $1 AND restaurant_id = $2
    `,
    [fixtures.bookingB, fixtures.restaurantB]
  );

  assert.equal(after.rows.length, 1);
});

test("Owner A cannot create booking using Restaurant B table id", async () => {
  const res = await request(app)
    .post("/bookings/")
    .set("Authorization", bearer(tokenA))
    .send({
      customer_name: "Cross Tenant Attack",
      phone: "0000000999",
      booking_time: new Date(
        Date.now() + 2 * 24 * 60 * 60 * 1000
      ).toISOString(),
      guests: 2,
      slot_min: 90,
      table_ids: [fixtures.tableB],
    });

  assert.equal(
    res.status,
    400,
    `Expected invalid cross-tenant table to be rejected, got ${res.status}: ${JSON.stringify(res.body)}`
  );

  const leaked = await dbQuery(
    `
    SELECT id
    FROM bookings
    WHERE restaurant_id = $1
      AND customer_name = 'Cross Tenant Attack'
    `,
    [fixtures.restaurantA]
  );

  assert.equal(leaked.rows.length, 0);
});

test("forged x-tenant-rid cannot expose Restaurant B bookings to Owner A", async () => {
  const res = await request(app)
    .get("/bookings/")
    .set("Authorization", bearer(tokenA))
    .set("x-tenant-rid", String(fixtures.restaurantB));

  if (res.status === 403) {
    return;
  }

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  assert.equal(
    res.body.some(
      (b) =>
        Number(b.id) === Number(fixtures.bookingB) ||
        Number(b.restaurant_id) === Number(fixtures.restaurantB)
    ),
    false,
    "SECURITY FAILURE: forged tenant header exposed Restaurant B bookings"
  );
});

test("final table and booking ownership remains intact", async () => {
  const rows = await dbQuery(
    `
    SELECT
      (SELECT restaurant_id FROM tables WHERE id = $1) AS table_a_rid,
      (SELECT restaurant_id FROM tables WHERE id = $2) AS table_b_rid,
      (SELECT restaurant_id FROM bookings WHERE id = $3) AS booking_a_rid,
      (SELECT restaurant_id FROM bookings WHERE id = $4) AS booking_b_rid
    `,
    [
      fixtures.tableA,
      fixtures.tableB,
      fixtures.bookingA,
      fixtures.bookingB,
    ]
  );

  const row = rows.rows[0];

  assert.equal(Number(row.table_a_rid), Number(fixtures.restaurantA));
  assert.equal(Number(row.table_b_rid), Number(fixtures.restaurantB));
  assert.equal(Number(row.booking_a_rid), Number(fixtures.restaurantA));
  assert.equal(Number(row.booking_b_rid), Number(fixtures.restaurantB));
});