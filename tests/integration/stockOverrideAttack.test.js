"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");

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

let ownerTokenA;
let staffTokenA;

const STAFF_PASSWORD =
  "MAKS-TEST-STAFF-Password-123!";

function bearer(token) {
  return `Bearer ${token}`;
}

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function one(sql, params = []) {
  const result = await query(
    sql,
    params
  );

  return result.rows[0] || null;
}

async function countPosOrders(rid) {
  const row = await one(
    `
    SELECT COUNT(*)::int AS count
    FROM public.pos_orders
    WHERE restaurant_id = $1
    `,
    [rid]
  );

  return Number(
    row?.count || 0
  );
}

function orderPayload(
  mealId,
  overrides = {}
) {
  return {
    table_number:
      "Takeaway",

    order_type:
      "takeaway",

    source:
      "pos",

    items: [
      {
        meal_id:
          mealId,

        item_source:
          "meals",

        item_type:
          "meals",

        quantity:
          1,

        /*
         * Required option from our
         * authoritative Burger A fixture.
         */
        options: {
          test_side:
            "test_chips",
        },

        ...overrides,
      },
    ],
  };
}

/*
 * =====================================================
 * CREATE A REAL LOW-PRIVILEGE MAKS STAFF MEMBER
 * =====================================================
 *
 * IMPORTANT:
 *
 * restaurant_members.role is constrained by the real
 * schema to:
 *
 * owner
 * admin
 * chef
 * staff
 *
 * The person's human job title can still be "Waiter".
 *
 * SECURITY:
 * permissions = []
 *
 * Therefore this account MUST NOT possess
 * STOCK_OVERRIDE_SALE.
 */
async function createLowPrivilegeStaff() {
  const passwordHash =
    await bcrypt.hash(
      STAFF_PASSWORD,
      10
    );

  const userResult =
    await query(
      `
      INSERT INTO public.users (
        username,
        password,
        password_hash,
        role,
        restaurant_id,
        is_active,
        can_pos_login,
        can_backoffice_login,
        full_name
      )
      VALUES (
        $1,
        $2,
        $2,
        'staff',
        $3,
        TRUE,
        TRUE,
        TRUE,
        'Attack Test Waiter'
      )
      RETURNING id
      `,
      [
        "maks_test_waiter_a",
        passwordHash,
        fixtures.restaurantA,
      ]
    );

  const userId =
    Number(
      userResult.rows[0].id
    );

  assert.ok(
    userId > 0,
    "Failed to create low-privilege test user"
  );

  await query(
    `
    INSERT INTO public.restaurant_members (
      restaurant_id,
      user_id,
      role,
      authority,
      job_title,
      permissions,
      is_active
    )
    VALUES (
      $1,
      $2,
      'staff',
      'staff',
      'Waiter',
      '[]'::jsonb,
      TRUE
    )
    `,
    [
      fixtures.restaurantA,
      userId,
    ]
  );

  /*
   * Prove our attacker really has no explicit
   * stock-override permissions.
   */
  const membership =
    await one(
      `
      SELECT
        restaurant_id,
        user_id,
        role,
        authority,
        job_title,
        permissions,
        is_active
      FROM public.restaurant_members
      WHERE restaurant_id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [
        fixtures.restaurantA,
        userId,
      ]
    );

  assert.ok(
    membership,
    "Low-privilege membership was not created"
  );

  assert.equal(
    membership.role,
    "staff"
  );

  assert.equal(
    membership.authority,
    "staff"
  );

  assert.equal(
    membership.is_active,
    true
  );

  const permissions =
    Array.isArray(
      membership.permissions
    )
      ? membership.permissions
      : [];

  assert.deepEqual(
    permissions,
    [],
    "Attack user unexpectedly has explicit permissions"
  );

  return userId;
}

// =====================================================
// SETUP
// =====================================================

test.before(async () => {
  await resetTestData();

  fixtures =
    await seedTestData();

  const safe =
    await assertTestDatabase();

  assert.equal(
    safe.database,
    "maks_test",
    "ATTACK TEST REFUSED: database is not maks_test"
  );

  pool =
    safe.pool;

  /*
   * Keep out_of_stock enforcement active without
   * introducing ingredient-recipe stock calculations
   * into this specific permission attack.
   *
   * manual_portions means:
   *
   * posOnlyMode = false
   * ingredientMode = false
   *
   * Therefore meal.out_of_stock is still enforced.
   */
  await query(
    `
    UPDATE public.restaurants
    SET
      selling_mode = 'manual_portions',
      stock_deduction_enabled = FALSE,
      portion_tracking_mode = 'manual'
    WHERE id = $1
    `,
    [
      fixtures.restaurantA,
    ]
  );

  /*
   * Burger A is intentionally unavailable.
   */
  await query(
    `
    UPDATE public.meals
    SET out_of_stock = TRUE
    WHERE id = $1
      AND restaurant_id = $2
    `,
    [
      fixtures.mealA,
      fixtures.restaurantA,
    ]
  );

  await createLowPrivilegeStaff();

  /*
   * Import the real Express app only after
   * assertTestDatabase() has proved this is maks_test.
   */
  ({ app } =
    require("../../server"));

  assert.ok(
    app,
    "Express app was not exported from server.js"
  );

  // ---------------------------------------------------
  // OWNER A LOGIN
  // ---------------------------------------------------

  const ownerLogin =
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
    ownerLogin.status,
    200,
    `Owner login failed: ${JSON.stringify(
      ownerLogin.body
    )}`
  );

  ownerTokenA =
    ownerLogin.body?.token;

  assert.ok(
    ownerTokenA,
    "Owner A received no JWT"
  );

  // ---------------------------------------------------
  // LOW PRIVILEGE STAFF LOGIN
  // ---------------------------------------------------

  const staffLogin =
    await request(app)
      .post(
        "/auth/login"
      )
      .send({
        username:
          "maks_test_waiter_a",

        password:
          STAFF_PASSWORD,

        restaurant_id:
          fixtures.restaurantA,
      });

  assert.equal(
    staffLogin.status,
    200,
    `Low-privilege staff login failed: ${JSON.stringify(
      staffLogin.body
    )}`
  );

  staffTokenA =
    staffLogin.body?.token;

  assert.ok(
    staffTokenA,
    "Low-privilege staff received no JWT"
  );
});

test.after(async () => {
  if (pool) {
    await pool.end();
  }
});

// =====================================================
// 1. FIXTURE PROOF
// =====================================================

test(
  "fixture is genuinely out of stock",
  async () => {
    const meal =
      await one(
        `
        SELECT
          id,
          restaurant_id,
          name,
          out_of_stock
        FROM public.meals
        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          fixtures.mealA,
          fixtures.restaurantA,
        ]
      );

    assert.ok(
      meal,
      "Burger A fixture missing"
    );

    assert.equal(
      Number(
        meal.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      meal.out_of_stock,
      true
    );
  }
);

// =====================================================
// 2. NORMAL OUT-OF-STOCK BLOCK
// =====================================================

test(
  "ATTACK: ordinary staff cannot order out-of-stock meal without override",
  async () => {
    const before =
      await countPosOrders(
        fixtures.restaurantA
      );

    const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
        .set(
          "Authorization",
          bearer(
            staffTokenA
          )
        )
        .send(
          orderPayload(
            fixtures.mealA
          )
        );

    assert.ok(
      res.status >= 400,
      `Out-of-stock order unexpectedly succeeded: ${res.status} ${JSON.stringify(
        res.body
      )}`
    );

    const after =
      await countPosOrders(
        fixtures.restaurantA
      );

    assert.equal(
      after,
      before,
      "Blocked out-of-stock order created a POS row"
    );
  }
);

// =====================================================
// 3. DIRECT stock_override FORGERY
// =====================================================

test(
  "ATTACK: staff cannot bypass stock using stock_override=true",
  async () => {
    const before =
      await countPosOrders(
        fixtures.restaurantA
      );

        const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
        .set(
          "Authorization",
          bearer(
            staffTokenA
          )
        )
        .send(
          orderPayload(
            fixtures.mealA,
            {
              stock_override:
                true,

              stock_override_reason:
                "browser forged override",
            }
          )
        );

    console.log("🚨 STOCK OVERRIDE DENIAL RESPONSE:", {
      status: res.status,
      body: res.body,
    });

    assert.equal(
      res.status,
      403,
      `Expected 403, received ${res.status}: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.code,
      "STOCK_OVERRIDE_PERMISSION_DENIED"
    );

    const after =
      await countPosOrders(
        fixtures.restaurantA
      );

    assert.equal(
      after,
      before,
      "Forged stock_override created a POS row"
    );
  }
);

// =====================================================
// 4. LEGACY/ALTERNATE FLAG FORGERY
// =====================================================

test(
  'ATTACK: staff cannot bypass stock using allow_stock_override="true"',
  async () => {
    const before =
      await countPosOrders(
        fixtures.restaurantA
      );

    const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
       .set(
          "Authorization",
          bearer(
            staffTokenA
          )
        )
        .send(
          orderPayload(
            fixtures.mealA,
            {
              allow_stock_override:
                "true",

              stock_override_reason:
                "alternate forged flag",
            }
          )
        );

    assert.equal(
      res.status,
      403,
      `Expected 403, received ${res.status}: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.code,
      "STOCK_OVERRIDE_PERMISSION_DENIED"
    );

    const after =
      await countPosOrders(
        fixtures.restaurantA
      );

    assert.equal(
      after,
      before,
      "Forged allow_stock_override created a POS row"
    );
  }
);

// =====================================================
// 5. HIDDEN SECOND-LINE OVERRIDE
// =====================================================

test(
  "ATTACK: forged override cannot be hidden in a second line item",
  async () => {
    const before =
      await countPosOrders(
        fixtures.restaurantA
      );

    const body =
      orderPayload(
        fixtures.mealA
      );

    body.items.push({
      meal_id:
        fixtures.mealA,

      item_source:
        "meals",

      item_type:
        "meals",

      quantity:
        1,

      options: {
        test_side:
          "test_chips",
      },

      stock_override:
        true,

      stock_override_reason:
        "override hidden in second item",
    });

    const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
        
        .set(
          "Authorization",
          bearer(
            staffTokenA
          )
        )
        .send(body);

    assert.equal(
      res.status,
      403,
      `Expected 403, received ${res.status}: ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.code,
      "STOCK_OVERRIDE_PERMISSION_DENIED"
    );

    const after =
      await countPosOrders(
        fixtures.restaurantA
      );

    assert.equal(
      after,
      before,
      "Second-line forged override created POS rows"
    );
  }
);

// =====================================================
// 6. AUTHORISED OWNER OVERRIDE
// =====================================================

test(
  "authorised owner can deliberately override out-of-stock meal",
  async () => {
    const before =
      await countPosOrders(
        fixtures.restaurantA
      );

    const res =
      await request(app)
        .post(
          "/orders/grouped"
        )
        .set(
          "Authorization",
          bearer(
            ownerTokenA
          )
        )
        .send(
          orderPayload(
            fixtures.mealA,
            {
              stock_override:
                true,

              stock_override_reason:
                "Test owner authorised sale",
            }
          )
        );

    assert.equal(
      res.status,
      201,
      `Authorised owner override failed: ${res.status} ${JSON.stringify(
        res.body
      )}`
    );

    assert.equal(
      res.body?.success,
      true
    );

    const after =
      await countPosOrders(
        fixtures.restaurantA
      );

    assert.ok(
      after > before,
      "Authorised override created no POS order"
    );

    const latest =
      await one(
        `
        SELECT
          id,
          restaurant_id,
          meal_id,
          item_name,
          quantity,
          total_price,
          remaining_price,
          paid,
          source
        FROM public.pos_orders
        WHERE restaurant_id = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.ok(
      latest,
      "Authorised override POS row missing"
    );

    assert.equal(
      Number(
        latest.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      Number(
        latest.meal_id
      ),
      fixtures.mealA
    );

    assert.equal(
      latest.item_name,
      "TEST Burger A"
    );

    assert.equal(
      Number(
        latest.quantity
      ),
      1
    );

    /*
     * CRITICAL:
     * Stock override is NOT price override.
     *
     * Backend must preserve canonical £12.50.
     */
    assert.equal(
      Number(
        latest.total_price
      ),
      12.5
    );

    assert.equal(
      Number(
        latest.remaining_price
      ),
      12.5
    );

    assert.equal(
      Number(
        latest.paid
      ),
      0
    );
  }
);

// =====================================================
// 7. FINAL TENANT INTEGRITY
// =====================================================

test(
  "FINAL: denied override attempts caused no cross-tenant contamination",
  async () => {
    const row =
      await one(
        `
        SELECT COUNT(*)::int AS bad
        FROM public.pos_orders
        WHERE restaurant_id = $1
          AND meal_id = $2
        `,
        [
          fixtures.restaurantB,
          fixtures.mealA,
        ]
      );

    assert.equal(
      Number(
        row?.bad || 0
      ),
      0,
      "SECURITY FAILURE: Restaurant A meal leaked into Restaurant B"
    );
  }
);