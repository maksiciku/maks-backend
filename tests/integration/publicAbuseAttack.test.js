"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const request =
  require("supertest");

const {
  resetTestData,
} =
  require("../setup/resetTestData");

const {
  seedTestData,
} =
  require("../setup/seedTestData");

const {
  assertTestDatabase,
} =
  require("../safety/assertTestDatabase");

/*
 * =====================================================
 * MAKS OS — PUBLIC API ABUSE ATTACK SUITE
 * =====================================================
 *
 * Scope:
 *
 * - malformed JSON
 * - oversized JSON
 * - anonymous QR order flooding
 * - anonymous booking flooding
 * - huge QR carts
 * - invalid public tenant ids
 * - mutation limiter scope
 * - legitimate public reads remain usable
 *
 * IMPORTANT:
 *
 * This suite intentionally tests the current production
 * behaviour BEFORE we add/fix public-abuse middleware.
 *
 * Do not weaken the assertions just to make it green.
 * =====================================================
 */

let app;
let pool;
let fixtures;

/*
 * =====================================================
 * POLICY EXPECTATIONS
 * =====================================================
 *
 * These are security boundaries, not implementation
 * details.
 *
 * We deliberately allow enough normal traffic for a
 * restaurant/customer device while requiring obvious
 * bursts to become rate-limited.
 */

const QR_FLOOD_ATTEMPTS =
  40;

const BOOKING_FLOOD_ATTEMPTS =
  40;

const HUGE_CART_LINES =
  101;

/*
 * =====================================================
 * HELPERS
 * =====================================================
 */

function is2xx(status) {
  return (
    status >= 200 &&
    status < 300
  );
}

function hasStatus(
  responses,
  status
) {
  return responses.some(
    (response) =>
      Number(
        response.status
      ) === Number(status)
  );
}

function statusCounts(
  responses
) {
  const counts = {};

  for (
    const response of
    responses
  ) {
    const status =
      Number(
        response.status
      );

    counts[status] =
      Number(
        counts[status] ||
        0
      ) + 1;
  }

  return counts;
}

async function query(
  sql,
  params = []
) {
  return pool.query(
    sql,
    params
  );
}

async function countPublicOrders(
  restaurantId
) {
  const result =
    await query(
      `
      SELECT
        COUNT(*)::int
          AS count

      FROM public.pos_orders

      WHERE restaurant_id =
            $1
      `,
      [
        restaurantId,
      ]
    );

  return Number(
    result.rows?.[0]
      ?.count ||
    0
  );
}

function validQrItem() {
  return {
    meal_id:
      fixtures.mealA,

    item_type:
      "meals",

    quantity:
      1,

    options: {
      test_side:
        "test_chips",
    },
  };
}

/*
 * =====================================================
 * SETUP
 * =====================================================
 */

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
      "PUBLIC ABUSE TEST REFUSED: wrong database"
    );

    pool =
      safe.pool;

    ({
      app,
    } =
      require("../../server"));

    assert.ok(
      app,
      "Express app did not load"
    );
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
 * 1. MALFORMED JSON
 * =====================================================
 *
 * Parser failures are client input errors.
 *
 * They must never surface as generic HTTP 500.
 */

test(
  "BOUNDARY: malformed public JSON returns 400 instead of server error",
  async () => {
    const response =
      await request(app)
        .post(
          `/public/qr/${fixtures.restaurantA}/order`
        )
        .set(
          "Content-Type",
          "application/json"
        )
        .send(
          '{"items":[{"meal_id":1}'
        );

    assert.equal(
      response.status,
      400,
      `Malformed JSON produced ${response.status}: ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 2. OVERSIZED JSON
 * =====================================================
 *
 * Express already has a parser boundary.
 *
 * MAKS must preserve the correct 413 response rather than
 * converting parser rejection into a generic 500.
 */

test(
  "BOUNDARY: oversized public JSON returns 413 instead of server error",
  async () => {
    const oversized =
      "X".repeat(
        160 * 1024
      );

    const response =
      await request(app)
        .post(
          `/public/qr/${fixtures.restaurantA}/order`
        )
        .set(
          "Content-Type",
          "application/json"
        )
        .send(
          JSON.stringify({
            items: [],
            padding:
              oversized,
          })
        );

    assert.equal(
      response.status,
      413,
      `Oversized JSON produced ${response.status}: ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 3. INVALID QR REQUEST BASELINE
 * =====================================================
 *
 * Before testing rate limiting, prove the underlying route
 * behaves normally.
 */

test(
  "VALIDATION: normal invalid QR order is rejected cleanly",
  async () => {
    const response =
      await request(app)
        .post(
          `/public/qr/${fixtures.restaurantA}/order`
        )
        .send({
          order_type:
            "takeaway",

          items: [],
        });

    assert.equal(
      response.status,
      400
    );
  }
);

/*
 * =====================================================
 * 4. HUGE QR CART
 * =====================================================
 *
 * Test the semantic cart boundary BEFORE deliberately
 * exhausting the QR mutation rate limiter.
 *
 * Otherwise a correctly exhausted limiter will return
 * 429 before this request can reach the deeper 413
 * cart-line boundary.
 * =====================================================
 */

test(
  "BOUNDARY: excessive QR cart lines are rejected with 413",

  async () => {
    const before =
      await countPublicOrders(
        fixtures.restaurantA
      );

    const items =
      Array.from(
        {
          length:
            HUGE_CART_LINES,
        },
        () =>
          validQrItem()
      );

    const response =
      await request(app)
        .post(
          `/public/qr/${fixtures.restaurantA}/order`
        )
        .send({
          order_type:
            "takeaway",

          items,
        });

    assert.equal(
      response.status,
      413,
      `Huge QR cart was not rejected at the request boundary: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    const after =
      await countPublicOrders(
        fixtures.restaurantA
      );

    assert.equal(
      after,
      before,
      `Huge rejected cart still created ${
        after - before
      } POS order rows`
    );
  }
);

/*
 * =====================================================
 * 4. QR ORDER FLOOD
 * =====================================================
 *
 * We deliberately use INVALID orders.
 *
 * That means this attack:
 *
 * - creates no real order;
 * - creates no stock reservation;
 * - creates no payment;
 * - still consumes HTTP/backend resources.
 *
 * Public mutation endpoints must eventually return 429.
 */

test(
  "ABUSE: repeated anonymous QR order requests are rate limited",
  async () => {
    const responses =
      [];

    for (
      let i = 0;
      i <
      QR_FLOOD_ATTEMPTS;
      i++
    ) {
      responses.push(
        await request(app)
          .post(
            `/public/qr/${fixtures.restaurantA}/order`
          )
          .send({
            order_type:
              "takeaway",

            items: [],
          })
      );
    }

    assert.equal(
      hasStatus(
        responses,
        429
      ),
      true,
      `QR flood never hit HTTP 429. Statuses: ${JSON.stringify(
        statusCounts(
          responses
        )
      )}`
    );
  }
);

/*
 * =====================================================
 * 5. QR MUTATION LIMIT MUST NOT BLOCK PUBLIC MENU READS
 * =====================================================
 */

test(
  "BOUNDARY: QR order abuse limiter does not block public menu reads",
  async () => {
    const response =
      await request(app)
        .get(
          `/public/qr/${fixtures.restaurantA}/categories`
        );

    assert.equal(
      response.status,
      200,
      `Public QR categories were blocked after order flood: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    assert.ok(
      Array.isArray(
        response.body
      )
    );
  }
);

/*
 * =====================================================
 * 6. PUBLIC BOOKING VALIDATION BASELINE
 * =====================================================
 */

test(
  "VALIDATION: normal invalid public booking is rejected cleanly",
  async () => {
    const response =
      await request(app)
        .post(
          "/public/bookings"
        )
        .send({
          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      response.status,
      400
    );
  }
);

/*
 * =====================================================
 * 7. PUBLIC BOOKING FLOOD
 * =====================================================
 *
 * Again, deliberately invalid requests so the test does not
 * create bookings or send confirmation emails.
 */

test(
  "ABUSE: repeated anonymous public booking requests are rate limited",
  async () => {
    const responses =
      [];

    for (
      let i = 0;
      i <
      BOOKING_FLOOD_ATTEMPTS;
      i++
    ) {
      responses.push(
        await request(app)
          .post(
            "/public/bookings"
          )
          .send({
            restaurant_id:
              fixtures.restaurantA,
          })
      );
    }

    assert.equal(
      hasStatus(
        responses,
        429
      ),
      true,
      `Booking flood never hit HTTP 429. Statuses: ${JSON.stringify(
        statusCounts(
          responses
        )
      )}`
    );
  }
);

/*
 * =====================================================
 * 8. BOOKING MUTATION LIMIT MUST NOT BLOCK READS
 * =====================================================
 */

test(
  "BOUNDARY: booking abuse limiter does not block restaurant-info reads",
  async () => {
    const response =
      await request(app)
        .get(
          "/public/restaurant-info"
        )
        .query({
          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      response.status,
      200,
      `Public restaurant-info was blocked after booking flood: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    assert.equal(
      Number(
        response.body?.id
      ),
      Number(
        fixtures.restaurantA
      )
    );
  }
);

/*
 * =====================================================
 * 9. INVALID PUBLIC RESTAURANT ID
 * =====================================================
 *
 * An attacker should receive a bounded client error, never
 * an internal server error.
 */

test(
  "BOUNDARY: invalid public restaurant id cannot produce HTTP 500",
  async () => {
    const response =
      await request(app)
        .post(
          "/public/qr/not-a-restaurant/order"
        )
        .send({
          order_type:
            "takeaway",

          items: [
            validQrItem(),
          ],
        });

    assert.ok(
      response.status >= 400 &&
      response.status < 500,
      `Invalid public tenant produced server error: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );
  }
);
