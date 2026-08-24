"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const {
  resetTestData,
} = require("../setup/resetTestData");

const {
  seedTestData,
  TEST_PASSWORD,
} = require("../setup/seedTestData");

const {
  assertTestDatabase,
} = require("../safety/assertTestDatabase");

let app;
let pool;
let fixtures;

let tokenA;
let tokenB;

function bearer(token) {
  return `Bearer ${token}`;
}

function is2xx(status) {
  return status >= 200 && status < 300;
}

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function one(sql, params = []) {
  const result =
    await query(sql, params);

  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result =
    await query(sql, params);

  return result.rows || [];
}

async function createBooking({
  token,
  name,
  bookingTime,
  guests = 2,
  tableIds = [],
  status = "confirmed",
  slotMin = 90,
}) {
  return request(app)
    .post("/bookings")
    .set(
      "Authorization",
      bearer(token)
    )
    .send({
      customer_name: name,
      phone: "07000000000",
      email:
        `${name
          .toLowerCase()
          .replace(/\s+/g, ".")}@example.test`,

      guests,
      number_of_people:
        guests,

      booking_time:
        bookingTime,

      slot_min:
        slotMin,

      status,

      table_ids:
        tableIds,
    });
}

async function bookingRow(
  restaurantId,
  id
) {
  return one(
    `
    SELECT
      id,
      restaurant_id,
      customer_name,
      booking_time,
      guests,
      status,
      slot_min
    FROM public.bookings
    WHERE restaurant_id = $1
      AND id = $2
    `,
    [
      restaurantId,
      id,
    ]
  );
}

async function sessionRow(
  restaurantId,
  tableId
) {
  return one(
    `
    SELECT
      restaurant_id,
      table_id,
      covers,
      allergy_codes,
      strict_cross_contamination
    FROM public.pos_table_sessions
    WHERE restaurant_id = $1
      AND table_id = $2
    `,
    [
      restaurantId,
      tableId,
    ]
  );
}

test.before(
  async () => {
    await resetTestData();

    fixtures =
      await seedTestData();

    const safe =
      await assertTestDatabase();

    assert.equal(
      safe.database,
      "maks_test",
      "BOOKING ATTACK REFUSED: wrong DB"
    );

    pool =
      safe.pool;

    ({ app } =
      require("../../server"));

    const loginA =
      await request(app)
        .post("/auth/login")
        .send({
          username:
            "maks_test_owner_a",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      loginA.status,
      200,
      JSON.stringify(
        loginA.body
      )
    );

    tokenA =
      loginA.body.token;

    const loginB =
      await request(app)
        .post("/auth/login")
        .send({
          username:
            "maks_test_owner_b",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures.restaurantB,
        });

    assert.equal(
      loginB.status,
      200,
      JSON.stringify(
        loginB.body
      )
    );

    tokenB =
      loginB.body.token;
  }
);

test.after(
  async () => {
    if (pool) {
      await pool.end();
    }
  }
);

/*
 * =====================================================
 * 1. TABLE SESSION FOREIGN TABLE
 *
 * Expected secure behaviour:
 * Restaurant A must not create a session using B's table.
 *
 * I expect this may currently FAIL.
 * =====================================================
 */

test(
  "ATTACK: Restaurant A cannot create session for Restaurant B table",
  async () => {
    const attack =
      await request(app)
        .post(
          `/pos/table-session/${fixtures.tableB}`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          covers: 4,

          allergy_codes: [
            "nuts",
          ],

          strict_cross_contamination:
            true,
        });

    assert.ok(
      attack.status >= 400,
      `FOREIGN TABLE SESSION ACCEPTED: ${
        attack.status
      } ${JSON.stringify(
        attack.body
      )}`
    );

    const contaminated =
      await sessionRow(
        fixtures.restaurantA,
        fixtures.tableB
      );

    assert.equal(
      contaminated,
      null,
      "Restaurant A created session against Restaurant B table ID"
    );
  }
);

/*
 * =====================================================
 * 2. NONEXISTENT TABLE
 * =====================================================
 */

test(
  "ATTACK: nonexistent table ID cannot create POS table session",
  async () => {
    const fakeId =
      999999999;

    const attack =
      await request(app)
        .post(
          `/pos/table-session/${fakeId}`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          covers: 2,
          allergy_codes: [],
        });

    assert.ok(
      attack.status >= 400
    );

    const row =
      await sessionRow(
        fixtures.restaurantA,
        fakeId
      );

    assert.equal(
      row,
      null
    );
  }
);

/*
 * =====================================================
 * 3. VALID SESSION
 * =====================================================
 */

test(
  "POS table session saves valid tenant-owned table",
  async () => {
    const res =
      await request(app)
        .post(
          `/pos/table-session/${fixtures.tableA}`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          covers: 3,

          allergy_codes: [
            "nuts",
            "milk",
          ],

          strict_cross_contamination:
            true,
        });

    assert.ok(
      is2xx(res.status),
      JSON.stringify(
        res.body
      )
    );

    const row =
      await sessionRow(
        fixtures.restaurantA,
        fixtures.tableA
      );

    assert.ok(row);

    assert.equal(
      Number(row.covers),
      3
    );

    assert.equal(
      !!row.strict_cross_contamination,
      true
    );
  }
);

/*
 * =====================================================
 * 4. SESSION UPSERT REPLAY
 * =====================================================
 */

test(
  "REPLAY: repeated table session update creates one session row",
  async () => {
    const endpoint =
      `/pos/table-session/${fixtures.tableA}`;

    for (
      const covers
      of [2, 4, 6]
    ) {
      const res =
        await request(app)
          .post(endpoint)
          .set(
            "Authorization",
            bearer(tokenA)
          )
          .send({
            covers,
            allergy_codes: [
              "milk",
            ],
          });

      assert.ok(
        is2xx(
          res.status
        )
      );
    }

    const count =
      await one(
        `
        SELECT
          COUNT(*)::int AS count
        FROM public.pos_table_sessions
        WHERE restaurant_id = $1
          AND table_id = $2
        `,
        [
          fixtures.restaurantA,
          fixtures.tableA,
        ]
      );

    assert.equal(
      Number(count.count),
      1
    );
  }
);

/*
 * =====================================================
 * 5. FOREIGN TABLE ID IN BOOKING
 *
 * bookingRoutes currently validates this.
 * This should be GREEN.
 * =====================================================
 */

test(
  "ATTACK: Restaurant A booking cannot attach Restaurant B table",
  async () => {
    const before =
      await one(
        `
        SELECT COUNT(*)::int AS count
        FROM public.bookings
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const res =
      await createBooking({
        token:
          tokenA,

        name:
          "Foreign Table Attack",

        bookingTime:
          "2030-06-01T18:00:00",

        guests:
          2,

        tableIds: [
          fixtures.tableB,
        ],
      });

    assert.ok(
      res.status >= 400
    );

    const after =
      await one(
        `
        SELECT COUNT(*)::int AS count
        FROM public.bookings
        WHERE restaurant_id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.equal(
      Number(after.count),
      Number(before.count)
    );
  }
);

/*
 * =====================================================
 * 6. SAME-TABLE COLLISION
 *
 * Two confirmed bookings:
 * same tenant
 * same table
 * same time
 *
 * Secure target:
 * only ONE should succeed.
 *
 * I expect this may currently FAIL.
 * =====================================================
 */

test(
  "ATTACK: same table cannot be double-booked for same time",
  async () => {
    const time =
      "2030-06-02T19:00:00";

    const first =
      await createBooking({
        token:
          tokenA,

        name:
          "Collision One",

        bookingTime:
          time,

        guests:
          2,

        tableIds: [
          fixtures.tableA,
        ],
      });

    assert.equal(
      first.status,
      201,
      JSON.stringify(
        first.body
      )
    );

    const second =
      await createBooking({
        token:
          tokenA,

        name:
          "Collision Two",

        bookingTime:
          time,

        guests:
          2,

        tableIds: [
          fixtures.tableA,
        ],
      });

    assert.ok(
      second.status >= 400,
      "Second overlapping booking was accepted"
    );
  }
);

/*
 * =====================================================
 * 7. CONCURRENT DOUBLE BOOKING
 *
 * The nasty version:
 * both requests hit together.
 * =====================================================
 */

test(
  "RACE: concurrent booking requests cannot both reserve same table slot",
  async () => {
    const time =
      "2030-06-03T20:00:00";

    const attack =
      (name) =>
        createBooking({
          token:
            tokenA,

          name,

          bookingTime:
            time,

          guests:
            2,

          tableIds: [
            fixtures.tableA,
          ],

          slotMin:
            90,
        });

    const [
      a,
      b,
    ] =
      await Promise.all([
        attack(
          "Race Booking A"
        ),

        attack(
          "Race Booking B"
        ),
      ]);

    const successes =
      [a, b].filter(
        (res) =>
          res.status === 201
      );

    assert.equal(
      successes.length,
      1,
      `Concurrent collision produced ${
        successes.length
      } successful bookings`
    );
  }
);

/*
 * =====================================================
 * 8. OVERLAPPING SLOTS
 *
 * 18:00 for 90 minutes overlaps 19:00.
 * =====================================================
 */

test(
  "ATTACK: partially overlapping booking slots cannot share same table",
  async () => {
    const first =
      await createBooking({
        token:
          tokenA,

        name:
          "Overlap One",

        bookingTime:
          "2030-06-04T18:00:00",

        guests:
          2,

        tableIds: [
          fixtures.tableA,
        ],

        slotMin:
          90,
      });

    assert.equal(
      first.status,
      201
    );

    const overlap =
      await createBooking({
        token:
          tokenA,

        name:
          "Overlap Two",

        bookingTime:
          "2030-06-04T19:00:00",

        guests:
          2,

        tableIds: [
          fixtures.tableA,
        ],

        slotMin:
          90,
      });

    assert.ok(
      overlap.status >= 400,
      "Overlapping 90-minute slots were both accepted"
    );
  }
);

/*
 * =====================================================
 * 9. EDIT INTO COLLISION
 *
 * Create bookings at different times,
 * then move B onto A.
 * =====================================================
 */

test(
  "ATTACK: booking edit cannot move booking into occupied table/time slot",
  async () => {
    const a =
      await createBooking({
        token:
          tokenA,

        name:
          "Edit Target A",

        bookingTime:
          "2030-06-05T18:00:00",

        guests:
          2,

        tableIds: [
          fixtures.tableA,
        ],
      });

    assert.equal(
      a.status,
      201
    );

    const b =
      await createBooking({
        token:
          tokenA,

        name:
          "Edit Target B",

        bookingTime:
          "2030-06-05T21:00:00",

        guests:
          2,

        tableIds: [
          fixtures.tableA,
        ],
      });

    assert.equal(
      b.status,
      201
    );

    const attack =
      await request(app)
        .put(
          `/bookings/${b.body.id}`
        )
        .set(
          "Authorization",
          bearer(tokenA)
        )
        .send({
          booking_time:
            "2030-06-05T18:00:00",
        });

    assert.ok(
      attack.status >= 400,
      "Booking edit created a collision"
    );

    const after =
      await bookingRow(
        fixtures.restaurantA,
        Number(b.body.id)
      );

    assert.notEqual(
      new Date(
        after.booking_time
      ).toISOString(),

      new Date(
        "2030-06-05T18:00:00"
      ).toISOString()
    );
  }
);

/*
 * =====================================================
 * 10. CROSS-TENANT BOOKING EDIT
 * =====================================================
 */

test(
  "ATTACK: Restaurant B cannot edit Restaurant A booking",
  async () => {
    const created =
      await createBooking({
        token:
          tokenA,

        name:
          "Tenant Edit Attack",

        bookingTime:
          "2030-06-06T18:00:00",

        guests:
          2,

        tableIds: [
          fixtures.tableA,
        ],
      });

    assert.equal(
      created.status,
      201
    );

    const attack =
      await request(app)
        .put(
          `/bookings/${created.body.id}`
        )
        .set(
          "Authorization",
          bearer(tokenB)
        )
        .send({
          guests:
            99,
        });

    assert.ok(
      attack.status >= 400
    );

    const after =
      await bookingRow(
        fixtures.restaurantA,
        Number(
          created.body.id
        )
      );

    assert.equal(
      Number(after.guests),
      2
    );
  }
);

/*
 * =====================================================
 * 11. IMPOSSIBLE SESSION OWNERSHIP
 * =====================================================
 */

test(
  "FINAL: every POS table session references a table owned by same tenant",
  async () => {
    const bad =
      await all(
        `
        SELECT
          pts.restaurant_id,
          pts.table_id,
          t.restaurant_id
            AS table_restaurant_id

        FROM public.pos_table_sessions pts

        LEFT JOIN public.tables t
          ON t.id =
               pts.table_id

        WHERE
          t.id IS NULL

          OR

          t.restaurant_id <>
            pts.restaurant_id
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Invalid POS table sessions: ${JSON.stringify(
        bad
      )}`
    );
  }
);

/*
 * =====================================================
 * 12. BOOKING TABLE TENANT INTEGRITY
 * =====================================================
 */

test(
  "FINAL: booking_tables never cross restaurant ownership",
  async () => {
    const bad =
      await all(
        `
        SELECT
          bt.booking_id,
          bt.table_id,
          bt.restaurant_id,
          b.restaurant_id
            AS booking_restaurant_id,
          t.restaurant_id
            AS table_restaurant_id

        FROM public.booking_tables bt

        LEFT JOIN public.bookings b
          ON b.id =
               bt.booking_id

        LEFT JOIN public.tables t
          ON t.id =
               bt.table_id

        WHERE
          b.id IS NULL

          OR

          t.id IS NULL

          OR

          bt.restaurant_id <>
            b.restaurant_id

          OR

          bt.restaurant_id <>
            t.restaurant_id
        `
      );

    assert.deepEqual(
      bad,
      [],
      `Cross-tenant booking/table relation detected: ${JSON.stringify(
        bad
      )}`
    );
  }
);