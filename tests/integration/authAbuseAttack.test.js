"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const request =
  require("supertest");

const jwt =
  require("jsonwebtoken");

const {
  resetTestData,
} =
  require("../setup/resetTestData");

const {
  seedTestData,
  TEST_PASSWORD,
} =
  require("../setup/seedTestData");

const {
  assertTestDatabase,
} =
  require("../safety/assertTestDatabase");

const {
  SECRET_KEY,
} =
  require("../../utils/constants");

let app;
let pool;
let fixtures;

const TEST_PREFIX =
  "MAKS AUTH ATTACK";

const NEW_PASSWORD =
  "MAKS-Auth-Attack-123!";

  let syntheticIpCounter =
  10;

function nextTestIp() {
  syntheticIpCounter +=
    1;

  return `198.51.100.${syntheticIpCounter}`;
}

function uniqueValue(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(
    Math.random() * 1_000_000
  )}`;
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

async function one(
  sql,
  params = []
) {
  const result =
    await query(
      sql,
      params
    );

  return (
    result.rows[0] ||
    null
  );
}

async function all(
  sql,
  params = []
) {
  const result =
    await query(
      sql,
      params
    );

  return (
    result.rows ||
    []
  );
}

async function count(
  sql,
  params = []
) {
  const row =
    await one(
      sql,
      params
    );

  return Number(
    row?.count ||
    row?.cnt ||
    0
  );
}

/*
 * =====================================================
 * REGISTRATION TOKEN HELPERS
 * =====================================================
 */

function makeRegistrationClaims({
  email,
  restaurantName,

  planKey =
    "starter",

  monthlyPrice =
    79,

  deviceLimit =
    2,

  checkoutSessionId =
    `cs_test_${uniqueValue(
      "checkout"
    )}`,

  customerId =
    `cus_test_${uniqueValue(
      "customer"
    )}`,

  subscriptionId =
    `sub_test_${uniqueValue(
      "subscription"
    )}`,

  subscriptionStatus =
    "active",

  currentPeriodEnd =
    new Date(
      Date.now() +
      30 *
        24 *
        60 *
        60 *
        1000
    ).toISOString(),

  type =
    "restaurant_registration",
} = {}) {
  return {
    type,

    email:
      String(
        email || ""
      )
        .trim()
        .toLowerCase(),

    restaurant_name:
      String(
        restaurantName ||
        ""
      ).trim(),

    plan_key:
      planKey,

    monthly_price:
      monthlyPrice,

    device_limit:
      deviceLimit,

    stripe_checkout_session_id:
      checkoutSessionId,

    stripe_customer_id:
      customerId,

    stripe_subscription_id:
      subscriptionId,

    stripe_subscription_status:
      subscriptionStatus,

    stripe_current_period_end:
      currentPeriodEnd,
  };
}

function signRegistrationToken(
  claims,
  {
    issuer =
      "maks-stripe",

    audience =
      "maks-registration",

    expiresIn =
      "15m",

    secret =
      SECRET_KEY,
  } = {}
) {
  return jwt.sign(
    claims,
    secret,
    {
      issuer,
      audience,
      expiresIn,
    }
  );
}

function registrationBody({
  email,
  restaurantName,
  token,

  password =
    NEW_PASSWORD,

  extra = {},
} = {}) {
  return {
    restaurant_name:
      restaurantName,

    email,

    password,

    first_name:
      "Attack",

    last_name:
      "Tester",

    phone:
      "07000000000",

    timezone:
      "Europe/London",

    country:
      "United Kingdom",

    business_type:
      "restaurant",

    registration_token:
      token,

    ...extra,
  };
}

async function register({
  path =
    "/auth/register-restaurant",

  email,
  restaurantName,
  token,
  password,
  extra,

  ip =
    nextTestIp(),
} = {}) {
  return request(app)
    .post(path)
    .set(
      "X-Forwarded-For",
      ip
    )
    .send(
      registrationBody({
        email,
        restaurantName,
        token,
        password,
        extra,
      })
    );
}

async function restaurantByName(
  name
) {
  return one(
    `
    SELECT
      id,
      name,
      owner_email,
      account_status,
      billing_status,
      plan_key,
      monthly_price,
      device_limit,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_checkout_session_id,
      stripe_subscription_status

    FROM public.restaurants

    WHERE LOWER(TRIM(name)) =
          LOWER(TRIM($1))

    LIMIT 1
    `,
    [
      name,
    ]
  );
}

async function userByEmail(
  email
) {
  return one(
    `
    SELECT
      id,
      username,
      role,
      restaurant_id,
      is_active,
      can_pos_login,
      can_backoffice_login

    FROM public.users

    WHERE LOWER(TRIM(username)) =
          LOWER(TRIM($1))

    LIMIT 1
    `,
    [
      email,
    ]
  );
}

async function membershipsForUser(
  userId
) {
  return all(
    `
    SELECT
      restaurant_id,
      user_id,
      role,
      authority,
      status,
      is_active

    FROM public.restaurant_members

    WHERE user_id = $1

    ORDER BY restaurant_id ASC
    `,
    [
      Number(userId),
    ]
  );
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
      "AUTH ABUSE ATTACK REFUSED: database is not maks_test"
    );

    pool =
      safe.pool;

    ({ app } =
      require("../../server"));

    assert.ok(
      app,
      "Express app was not loaded"
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
 * 1. VALID LOGIN BASELINE
 * =====================================================
 */

test(
  "AUTH: legitimate owner can still login normally",
  async () => {
    const response =
      await request(app)
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_test_owner_a",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      response.status,
      200,
      `Legitimate login failed: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );

    assert.ok(
      response.body?.token
    );

    assert.equal(
      Number(
        response.body
          ?.user
          ?.restaurant_id
      ),
      Number(
        fixtures.restaurantA
      )
    );
  }
);

/*
 * =====================================================
 * 2. WRONG PASSWORD
 * =====================================================
 */

test(
  "AUTH: wrong password receives generic invalid-credentials response",
  async () => {
    const response =
      await request(app)
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_test_owner_a",

          password:
            "COMPLETELY-WRONG-PASSWORD",

          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      response.body?.error,
      "Invalid email or password"
    );
  }
);

/*
 * =====================================================
 * 3. UNKNOWN ACCOUNT ENUMERATION
 * =====================================================
 */

test(
  "PRIVACY: unknown account and real account with wrong password expose same response",
  async () => {
    const real =
      await request(app)
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_test_owner_a",

          password:
            "WRONG-PASSWORD-ENUMERATION",

          restaurant_id:
            fixtures.restaurantA,
        });

    const fake =
      await request(app)
        .post(
          "/auth/login"
        )
        .send({
          username:
            `missing-${Date.now()}@example.invalid`,

          password:
            "WRONG-PASSWORD-ENUMERATION",

          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      real.status,
      401
    );

    assert.equal(
      fake.status,
      401
    );

    assert.equal(
      real.body?.error,
      fake.body?.error
    );
  }
);

/*
 * =====================================================
 * 4. LOGIN TENANT SELECTION
 * =====================================================
 */

test(
  "TENANT: Restaurant A owner cannot login into Restaurant B by supplying its id",
  async () => {
    const response =
      await request(app)
        .post(
          "/auth/login"
        )
        .send({
          username:
            "maks_test_owner_a",

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures.restaurantB,
        });

    assert.equal(
      response.status,
      403
    );

    assert.equal(
      Boolean(
        response.body?.token
      ),
      false
    );
  }
);

/*
 * =====================================================
 * 5. REGISTRATION REQUIRES VERIFIED CHECKOUT
 * =====================================================
 */

test(
  "REGISTRATION: browser cannot create restaurant without signed checkout entitlement",
  async () => {
    const restaurantName =
      uniqueValue(
        "NO TOKEN RESTAURANT"
      );

    const email =
      `${uniqueValue(
        "notoken"
      )}@example.test`;

    const before =
      await count(
        `
        SELECT COUNT(*)::int AS count
        FROM public.restaurants
        WHERE LOWER(TRIM(name)) =
              LOWER(TRIM($1))
        `,
        [
          restaurantName,
        ]
      );

    const response =
      await register({
        email,
        restaurantName,

        token:
          "",

        extra: {
          plan_key:
            "enterprise",

          monthly_price:
            0,

          device_limit:
            999999,

          billing_status:
            "active",

          account_status:
            "active",

          stripe_customer_id:
            "cus_FAKE_ATTACK",

          stripe_subscription_id:
            "sub_FAKE_ATTACK",

          stripe_checkout_session_id:
            "cs_FAKE_ATTACK",

          stripe_subscription_status:
            "active",
        },
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      response.body?.code,
      "REGISTRATION_TOKEN_REQUIRED"
    );

    const after =
      await count(
        `
        SELECT COUNT(*)::int AS count
        FROM public.restaurants
        WHERE LOWER(TRIM(name)) =
              LOWER(TRIM($1))
        `,
        [
          restaurantName,
        ]
      );

    assert.equal(
      after,
      before,
      "Unsigned registration created a restaurant"
    );
  }
);

/*
 * =====================================================
 * 6. RANDOM / FORGED JWT
 * =====================================================
 */

test(
  "REGISTRATION: random forged token cannot create restaurant",
  async () => {
    const restaurantName =
      uniqueValue(
        "FORGED TOKEN RESTAURANT"
      );

    const email =
      `${uniqueValue(
        "forged"
      )}@example.test`;

    const forged =
      jwt.sign(
        makeRegistrationClaims({
          email,
          restaurantName,
        }),

        "ATTACKER-CONTROLLED-SECRET",

        {
          issuer:
            "maks-stripe",

          audience:
            "maks-registration",

          expiresIn:
            "15m",
        }
      );

    const response =
      await register({
        email,
        restaurantName,
        token:
          forged,
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      response.body?.code,
      "INVALID_REGISTRATION_TOKEN"
    );

    assert.equal(
      await restaurantByName(
        restaurantName
      ),
      null
    );
  }
);

/*
 * =====================================================
 * 7. WRONG ISSUER
 * =====================================================
 */

test(
  "REGISTRATION: correctly signed token with wrong issuer is rejected",
  async () => {
    const restaurantName =
      uniqueValue(
        "WRONG ISSUER"
      );

    const email =
      `${uniqueValue(
        "issuer"
      )}@example.test`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email,
          restaurantName,
        }),

        {
          issuer:
            "attacker",
        }
      );

    const response =
      await register({
        email,
        restaurantName,
        token,
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      await restaurantByName(
        restaurantName
      ),
      null
    );
  }
);

/*
 * =====================================================
 * 8. WRONG AUDIENCE
 * =====================================================
 */

test(
  "REGISTRATION: correctly signed token with wrong audience is rejected",
  async () => {
    const restaurantName =
      uniqueValue(
        "WRONG AUDIENCE"
      );

    const email =
      `${uniqueValue(
        "audience"
      )}@example.test`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email,
          restaurantName,
        }),

        {
          audience:
            "attacker-registration",
        }
      );

    const response =
      await register({
        email,
        restaurantName,
        token,
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      await restaurantByName(
        restaurantName
      ),
      null
    );
  }
);

/*
 * =====================================================
 * 9. EXPIRED TOKEN
 * =====================================================
 */

test(
  "REGISTRATION: expired checkout entitlement is rejected",
  async () => {
    const restaurantName =
      uniqueValue(
        "EXPIRED TOKEN"
      );

    const email =
      `${uniqueValue(
        "expired"
      )}@example.test`;

    const claims =
      makeRegistrationClaims({
        email,
        restaurantName,
      });

    const nowSeconds =
      Math.floor(
        Date.now() /
        1000
      );

    const token =
      jwt.sign(
        {
          ...claims,

          iat:
            nowSeconds -
            3600,

          exp:
            nowSeconds -
            60,

          iss:
            "maks-stripe",

          aud:
            "maks-registration",
        },

        SECRET_KEY
      );

    const response =
      await register({
        email,
        restaurantName,
        token,
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      await restaurantByName(
        restaurantName
      ),
      null
    );
  }
);

/*
 * =====================================================
 * 10. TOKEN TYPE CONFUSION
 * =====================================================
 */

test(
  "REGISTRATION: ordinary signed token cannot be used as registration entitlement",
  async () => {
    const restaurantName =
      uniqueValue(
        "WRONG TOKEN TYPE"
      );

    const email =
      `${uniqueValue(
        "wrongtype"
      )}@example.test`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email,
          restaurantName,

          type:
            "ordinary_login_token",
        })
      );

    const response =
      await register({
        email,
        restaurantName,
        token,
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      response.body?.code,
      "INVALID_REGISTRATION_TOKEN"
    );
  }
);

/*
 * =====================================================
 * 11. EMAIL IDENTITY SWAP
 * =====================================================
 */

test(
  "REGISTRATION: checkout email cannot be swapped in browser",
  async () => {
    const restaurantName =
      uniqueValue(
        "EMAIL SWAP RESTAURANT"
      );

    const authorisedEmail =
      `${uniqueValue(
        "paid"
      )}@example.test`;

    const attackerEmail =
      `${uniqueValue(
        "victim"
      )}@example.test`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email:
            authorisedEmail,

          restaurantName,
        })
      );

    const response =
      await register({
        email:
          attackerEmail,

        restaurantName,

        token,
      });

    assert.equal(
      response.status,
      403
    );

    assert.equal(
      response.body?.code,
      "REGISTRATION_IDENTITY_MISMATCH"
    );

    assert.equal(
      await restaurantByName(
        restaurantName
      ),
      null
    );
  }
);

/*
 * =====================================================
 * 12. RESTAURANT NAME SWAP
 * =====================================================
 */

test(
  "REGISTRATION: checkout restaurant identity cannot be swapped in browser",
  async () => {
    const authorisedName =
      uniqueValue(
        "PAID RESTAURANT"
      );

    const attackerName =
      uniqueValue(
        "ALTERED RESTAURANT"
      );

    const email =
      `${uniqueValue(
        "nameswap"
      )}@example.test`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email,

          restaurantName:
            authorisedName,
        })
      );

    const response =
      await register({
        email,

        restaurantName:
          attackerName,

        token,
      });

    assert.equal(
      response.status,
      403
    );

    assert.equal(
      response.body?.code,
      "REGISTRATION_IDENTITY_MISMATCH"
    );

    assert.equal(
      await restaurantByName(
        attackerName
      ),
      null
    );
  }
);

/*
 * =====================================================
 * 13. COMMERCIAL FIELD FORGERY
 * =====================================================
 */

test(
  "AUTHORITY: browser cannot upgrade Starter entitlement to free Enterprise",
  async () => {
    const restaurantName =
      uniqueValue(
        "AUTHORITATIVE STARTER"
      );

    const email =
      `${uniqueValue(
        "starter"
      )}@example.test`;

    const checkoutSessionId =
      `cs_test_${uniqueValue(
        "starter"
      )}`;

    const customerId =
      `cus_test_${uniqueValue(
        "starter"
      )}`;

    const subscriptionId =
      `sub_test_${uniqueValue(
        "starter"
      )}`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email,
          restaurantName,

          planKey:
            "starter",

          monthlyPrice:
            79,

          deviceLimit:
            2,

          checkoutSessionId,
          customerId,
          subscriptionId,
        })
      );

    const response =
      await register({
        email,
        restaurantName,
        token,

        extra: {
          /*
           * Hostile browser values.
           */
          plan_key:
            "enterprise",

          monthly_price:
            0,

          device_limit:
            999999,

          billing_status:
            "free_forever",

          account_status:
            "super_admin",

          stripe_customer_id:
            "cus_ATTACKER",

          stripe_subscription_id:
            "sub_ATTACKER",

          stripe_checkout_session_id:
            "cs_ATTACKER",

          stripe_subscription_status:
            "active",
        },
      });

    assert.equal(
      response.status,
      201,
      `Authoritative registration failed: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );

    assert.equal(
      response.body?.role,
      "owner"
    );

    const restaurant =
      await restaurantByName(
        restaurantName
      );

    assert.ok(
      restaurant
    );

    /*
     * Signed entitlement wins.
     */
    assert.equal(
      restaurant.plan_key,
      "starter"
    );

    assert.equal(
      Number(
        restaurant.monthly_price
      ),
      79
    );

    assert.equal(
      Number(
        restaurant.device_limit
      ),
      2
    );

    assert.equal(
      restaurant.stripe_checkout_session_id,
      checkoutSessionId
    );

    assert.equal(
      restaurant.stripe_customer_id,
      customerId
    );

    assert.equal(
      restaurant.stripe_subscription_id,
      subscriptionId
    );

    assert.equal(
      restaurant.account_status,
      "active"
    );

    assert.equal(
      restaurant.billing_status,
      "active"
    );

    /*
     * New owner identity and membership must match
     * the newly created restaurant.
     */

    const user =
      await userByEmail(
        email
      );

    assert.ok(
      user
    );

    const memberships =
      await membershipsForUser(
        user.id
      );

    const newMembership =
      memberships.find(
        (m) =>
          Number(
            m.restaurant_id
          ) ===
          Number(
            restaurant.id
          )
      );

    assert.ok(
      newMembership,
      "New owner membership was not created"
    );

    assert.equal(
      newMembership.role,
      "owner"
    );
  }
);

/*
 * =====================================================
 * 14. EXISTING ACCOUNT TAKEOVER
 * =====================================================
 */

test(
  "AUTHORITY: public registration cannot take over an existing MAKS account by knowing its email",
  async () => {
    const restaurantName =
      uniqueValue(
        "EXISTING ACCOUNT ATTACK"
      );

    const existingEmail =
      "maks_test_owner_a";

    const beforeUser =
      await userByEmail(
        existingEmail
      );

    assert.ok(
      beforeUser
    );

    const beforeMemberships =
      await membershipsForUser(
        beforeUser.id
      );

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email:
            existingEmail,

          restaurantName,

          checkoutSessionId:
            `cs_test_${uniqueValue(
              "takeover"
            )}`,

          subscriptionId:
            `sub_test_${uniqueValue(
              "takeover"
            )}`,
        })
      );

    const response =
      await register({
        email:
          existingEmail,

        restaurantName,

        /*
         * Deliberately supply attacker password.
         */
        password:
          "ATTACKER-NEW-PASSWORD-123!",

        token,
      });

    assert.equal(
      response.status,
      409,
      `Existing-account registration wasn't blocked: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );

    assert.equal(
      response.body?.code,
      "ACCOUNT_ALREADY_EXISTS"
    );

    /*
     * Restaurant insert must have rolled back.
     */
    assert.equal(
      await restaurantByName(
        restaurantName
      ),
      null,
      "Existing-account attack left an orphan restaurant"
    );

    const afterUser =
      await userByEmail(
        existingEmail
      );

    assert.equal(
      Number(
        afterUser.id
      ),
      Number(
        beforeUser.id
      )
    );

    assert.equal(
      Number(
        afterUser.restaurant_id
      ),
      Number(
        beforeUser.restaurant_id
      )
    );

    const afterMemberships =
      await membershipsForUser(
        afterUser.id
      );

    assert.deepEqual(
      afterMemberships.map(
        (m) =>
          Number(
            m.restaurant_id
          )
      ),

      beforeMemberships.map(
        (m) =>
          Number(
            m.restaurant_id
          )
      ),

      "Existing-account attack changed restaurant memberships"
    );

    /*
     * Original password must still work.
     */
    const login =
      await request(app)
        .post(
          "/auth/login"
        )
        .send({
          username:
            existingEmail,

          password:
            TEST_PASSWORD,

          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      login.status,
      200,
      "Existing owner's original login was damaged by registration attack"
    );
  }
);

/*
 * =====================================================
 * 15. INVALID COMMERCIAL ENTITLEMENT
 * =====================================================
 */

test(
  "REGISTRATION: signed token with impossible commercial entitlement is rejected",
  async () => {
    const restaurantName =
      uniqueValue(
        "INVALID ENTITLEMENT"
      );

    const email =
      `${uniqueValue(
        "invalid-entitlement"
      )}@example.test`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email,
          restaurantName,

          planKey:
            "enterprise",

          monthlyPrice:
            -1000,

          deviceLimit:
            999,
        })
      );

    const response =
      await register({
        email,
        restaurantName,
        token,
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      response.body?.code,
      "INVALID_REGISTRATION_ENTITLEMENT"
    );

    assert.equal(
      await restaurantByName(
        restaurantName
      ),
      null
    );
  }
);

/*
 * =====================================================
 * 16. CHECKOUT REPLAY
 * =====================================================
 */

test(
  "REPLAY: one checkout entitlement cannot create the same restaurant twice",
  async () => {
    const restaurantName =
      uniqueValue(
        "REPLAY RESTAURANT"
      );

    const email =
      `${uniqueValue(
        "replay"
      )}@example.test`;

    const checkoutSessionId =
      `cs_test_${uniqueValue(
        "replay"
      )}`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email,
          restaurantName,
          checkoutSessionId,

          subscriptionId:
            `sub_test_${uniqueValue(
              "replay"
            )}`,
        })
      );

    const first =
      await register({
        email,
        restaurantName,
        token,
      });

    assert.equal(
      first.status,
      201,
      JSON.stringify(
        first.body
      )
    );

    const second =
      await register({
        email,
        restaurantName,
        token,
      });

    assert.equal(
      second.status,
      409,
      `Checkout replay was accepted: ${second.status} ${JSON.stringify(
        second.body
      )}`
    );

    const rows =
      await all(
        `
        SELECT id
        FROM public.restaurants
        WHERE stripe_checkout_session_id = $1
        `,
        [
          checkoutSessionId,
        ]
      );

    assert.equal(
      rows.length,
      1,
      "One checkout session created multiple restaurants"
    );
  }
);

/*
 * =====================================================
 * 17. CONCURRENT CHECKOUT REPLAY
 * =====================================================
 *
 * Database unique index must be the final authority.
 * Two requests may both pass application-level pre-checks.
 * They still must not both commit.
 * =====================================================
 */

test(
  "RACE: simultaneous replay of one checkout can create at most one restaurant",
  async () => {
    const restaurantName =
      uniqueValue(
        "RACE REGISTRATION"
      );

    const email =
      `${uniqueValue(
        "race"
      )}@example.test`;

    const checkoutSessionId =
      `cs_test_${uniqueValue(
        "race"
      )}`;

    const subscriptionId =
      `sub_test_${uniqueValue(
        "race"
      )}`;

    const token =
      signRegistrationToken(
        makeRegistrationClaims({
          email,
          restaurantName,
          checkoutSessionId,
          subscriptionId,
        })
      );

    const [
      first,
      second,
    ] =
      await Promise.all([
        register({
          email,
          restaurantName,
          token,
        }),

        register({
          email,
          restaurantName,
          token,
        }),
      ]);

    const statuses = [
      first.status,
      second.status,
    ];

    const successes =
      statuses.filter(
        (status) =>
          status === 201
      ).length;

    assert.equal(
      successes,
      1,
      `Concurrent checkout replay produced ${successes} successful registrations. Statuses: ${JSON.stringify(
        statuses
      )}`
    );

    const rows =
      await all(
        `
        SELECT
          id,
          stripe_checkout_session_id

        FROM public.restaurants

        WHERE stripe_checkout_session_id =
              $1
        `,
        [
          checkoutSessionId,
        ]
      );

    assert.equal(
      rows.length,
      1,
      "Database allowed checkout session to own multiple restaurants"
    );
  }
);

/*
 * =====================================================
 * 18. LEGACY REGISTER PATH
 * =====================================================
 */

test(
  "BOUNDARY: legacy /register-restaurant also requires signed entitlement",
  async () => {
    const restaurantName =
      uniqueValue(
        "LEGACY UNSIGNED"
      );

    const email =
      `${uniqueValue(
        "legacy"
      )}@example.test`;

    const response =
      await register({
        path:
          "/register-restaurant",

        email,
        restaurantName,

        token:
          "",
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      await restaurantByName(
        restaurantName
      ),
      null
    );
  }
);

/*
 * =====================================================
 * 19. LOGIN RATE LIMIT — /auth/login
 * =====================================================
 *
 * Run rate-limit tests late because they deliberately
 * consume the route's allowance.
 * =====================================================
 */

test(
  "ABUSE: repeated password guessing on /auth/login eventually returns 429",
  async () => {
    const responses =
      [];

    for (
      let i = 0;
      i < 30;
      i++
    ) {
      responses.push(
        await request(app)
          .post(
            "/auth/login"
          )
          .set(
            "X-Forwarded-For",
            "203.0.113.77"
          )
          .send({
            username:
              "maks_test_owner_a",

            password:
              `WRONG-${i}`,

            restaurant_id:
              fixtures.restaurantA,
          })
      );
    }

    const statuses =
      responses.map(
        (response) =>
          response.status
      );

    assert.equal(
      statuses.includes(
        429
      ),
      true,
      `Login flood never reached 429: ${JSON.stringify(
        statuses
      )}`
    );
  }
);

/*
 * =====================================================
 * 20. LOGIN RATE LIMIT — LEGACY /login
 * =====================================================
 */

test(
  "ABUSE: legacy /login is protected by login limiter too",
  async () => {
    const responses =
      [];

    for (
      let i = 0;
      i < 30;
      i++
    ) {
      responses.push(
        await request(app)
          .post(
            "/login"
          )
          .set(
            "X-Forwarded-For",
            "203.0.113.88"
          )
          .send({
            username:
              "maks_test_owner_a",

            password:
              `LEGACY-WRONG-${i}`,

            restaurant_id:
              fixtures.restaurantA,
          })
      );
    }

    assert.equal(
      responses.some(
        (response) =>
          response.status ===
          429
      ),
      true,
      `Legacy login flood never reached 429: ${JSON.stringify(
        responses.map(
          (response) =>
            response.status
        )
      )}`
    );
  }
);

/*
 * =====================================================
 * 21. REGISTRATION RATE LIMIT
 * =====================================================
 *
 * Invalid unsigned registrations are enough to consume
 * the public HTTP boundary without creating restaurants.
 * =====================================================
 */

test(
  "ABUSE: repeated anonymous registration requests eventually return 429",
  async () => {
    const responses =
      [];

    for (
      let i = 0;
      i < 16;
      i++
    ) {
      responses.push(
        await request(app)
          .post(
            "/auth/register-restaurant"
          )
          .set(
            "X-Forwarded-For",
            "203.0.113.99"
          )
          .send({
            restaurant_name:
              `REG FLOOD ${i}`,

            email:
              `reg-flood-${i}@example.test`,

            password:
              NEW_PASSWORD,
          })
      );
    }

    assert.equal(
      responses.some(
        (response) =>
          response.status ===
          429
      ),
      true,
      `Registration flood never reached 429: ${JSON.stringify(
        responses.map(
          (response) =>
            response.status
        )
      )}`
    );
  }
);

/*
 * =====================================================
 * 22. LEGACY REGISTRATION RATE LIMIT
 * =====================================================
 */

test(
  "ABUSE: legacy /register-restaurant is rate limited too",
  async () => {
    const responses =
      [];

    for (
      let i = 0;
      i < 16;
      i++
    ) {
      responses.push(
        await request(app)
          .post(
            "/register-restaurant"
          )
          .set(
            "X-Forwarded-For",
            "203.0.113.111"
          )
          .send({
            restaurant_name:
              `LEGACY REG FLOOD ${i}`,

            email:
              `legacy-reg-flood-${i}@example.test`,

            password:
              NEW_PASSWORD,
          })
      );
    }

    assert.equal(
      responses.some(
        (response) =>
          response.status ===
          429
      ),
      true,
      `Legacy registration flood never reached 429: ${JSON.stringify(
        responses.map(
          (response) =>
            response.status
        )
      )}`
    );
  }
);

/*
 * =====================================================
 * 23. FINAL CHECKOUT UNIQUENESS INVARIANT
 * =====================================================
 */

test(
  "FINAL: no Stripe checkout session belongs to multiple restaurants",
  async () => {
    const bad =
      await all(
        `
        SELECT
          stripe_checkout_session_id,
          COUNT(*)::int AS count

        FROM public.restaurants

        WHERE stripe_checkout_session_id
              IS NOT NULL

        GROUP BY
          stripe_checkout_session_id

        HAVING COUNT(*) > 1
        `
      );

    assert.deepEqual(
      bad,
      []
    );
  }
);

/*
 * =====================================================
 * 24. FINAL OWNER MEMBERSHIP INVARIANT
 * =====================================================
 */

test(
  "FINAL: test-created registration owners belong to their restaurant",
  async () => {
    const bad =
      await all(
        `
        SELECT
          r.id AS restaurant_id,
          r.owner_email,
          u.id AS user_id,
          rm.restaurant_id AS membership_restaurant_id,
          rm.role

        FROM public.restaurants r

        LEFT JOIN public.users u
          ON LOWER(
               TRIM(
                 u.username
               )
             ) =
             LOWER(
               TRIM(
                 r.owner_email
               )
             )

        LEFT JOIN public.restaurant_members rm
          ON rm.user_id =
             u.id

         AND rm.restaurant_id =
             r.id

        WHERE r.owner_email LIKE '%@example.test'

          AND (
            u.id IS NULL
            OR rm.user_id IS NULL
            OR rm.role <> 'owner'
          )
        `
      );

    assert.deepEqual(
      bad,
      []
    );
  }
);

/*
 * =====================================================
 * 25. FINAL COMMERCIAL ENTITLEMENT INVARIANT
 * =====================================================
 */

test(
  "FINAL: no attack-created restaurant received impossible commercial values",
  async () => {
    const bad =
      await all(
        `
        SELECT
          id,
          name,
          owner_email,
          plan_key,
          monthly_price,
          device_limit,
          stripe_checkout_session_id

        FROM public.restaurants

        WHERE owner_email LIKE '%@example.test'

          AND (
            plan_key NOT IN (
              'starter',
              'professional',
              'enterprise'
            )

            OR monthly_price < 0

            OR device_limit <= 0

            OR stripe_checkout_session_id
               IS NULL
          )
        `
      );

    assert.deepEqual(
      bad,
      []
    );
  }
);