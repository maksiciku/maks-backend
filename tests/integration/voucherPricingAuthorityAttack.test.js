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
let ownerTokenB;

let staleOwnerTokenA;
let fakeManagerTitleTokenA;
let voucherManagerTokenA;
let voucherOperatorTokenA;
let happyHourManagerTokenA;

let staleOwnerId;
let fakeManagerTitleId;
let voucherManagerId;
let voucherOperatorId;
let happyHourManagerId;

const USER_PASSWORD =
  "MAKS-PRICING-AUTH-TEST-123!";

const P = Object.freeze({
  POS_VOUCHER_PAYMENT:
    "pos.voucher_payment",

  VOUCHERS_MANAGE:
    "vouchers.manage",

  HAPPY_HOUR_MANAGE:
    "happy_hour.manage",
});

function bearer(token) {
  return `Bearer ${token}`;
}

function is2xx(status) {
  return status >= 200 && status < 300;
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

  return result.rows[0] || null;
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

  return result.rows || [];
}

async function createSecurityUser({
  username,
  role = "staff",
  authority = "staff",
  jobTitle = "Team Member",
  permissions = [],
}) {
  const hash =
    bcrypt.hashSync(
      USER_PASSWORD,
      10
    );

  const user =
    await one(
      `
      INSERT INTO public.users
      (
        username,
        password,
        password_hash,
        role,
        restaurant_id,
        full_name,
        is_active,
        can_pos_login,
        can_backoffice_login,
        created_at
      )

      VALUES
      (
        $1,
        $2,
        $2,
        $3,
        $4,
        $5,
        TRUE,
        TRUE,
        TRUE,
        NOW()
      )

      RETURNING id
      `,
      [
        username,
        hash,
        role,
        fixtures.restaurantA,
        `TEST ${username}`,
      ]
    );

  assert.ok(
    user?.id
  );

  const userId =
    Number(user.id);

  await query(
    `
    INSERT INTO public.restaurant_members
    (
      restaurant_id,
      user_id,
      role,
      authority,
      job_title,
      permissions,
      status,
      is_active,
      created_at
    )

    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6::jsonb,
      'active',
      TRUE,
      NOW()
    )
    `,
    [
      fixtures.restaurantA,
      userId,
      role,
      authority,
      jobTitle,
      JSON.stringify(
        permissions
      ),
    ]
  );

  return userId;
}

async function login({
  username,
  password = USER_PASSWORD,
  restaurantId =
    fixtures.restaurantA,
}) {
  const response =
    await request(app)
      .post("/auth/login")
      .send({
        username,
        password,
        restaurant_id:
          restaurantId,
      });

  assert.equal(
    response.status,
    200,
    `Login failed: ${response.status} ${JSON.stringify(
      response.body
    )}`
  );

  assert.ok(
    response.body?.token
  );

  return response.body.token;
}

function voucherPayload({
  name = "TEST Voucher",
  code,
  usageMode = "multi",
  usageLimit = null,
  value = 10,
} = {}) {
  return {
    name,
    code,
    discount_type:
      "fixed",

    discount_value:
      value,

    min_spend:
      0,

    usage_limit:
      usageLimit,

    active:
      true,

    dine_in_only:
      false,

    takeaway_only:
      false,

    usage_mode:
      usageMode,
  };
}

async function createVoucher({
  token = ownerTokenA,
  code,
  name,
  usageMode = "multi",
  usageLimit = null,
  value = 10,
}) {
  const response =
    await request(app)
      .post("/vouchers")
      .set(
        "Authorization",
        bearer(token)
      )
      .send(
        voucherPayload({
          code,
          name,
          usageMode,
          usageLimit,
          value,
        })
      );

  assert.equal(
    response.status,
    201,
    `Voucher creation failed: ${response.status} ${JSON.stringify(
      response.body
    )}`
  );

  assert.ok(
    response.body?.id
  );

  return response.body;
}

async function createVoucherDirect({
  restaurantId,
  code,
  usageMode = "multi",
  usageLimit = null,
  active = true,
}) {
  return one(
    `
    INSERT INTO public.vouchers
    (
      restaurant_id,
      name,
      code,
      discount_type,
      discount_value,
      min_spend,
      usage_limit,
      used_count,
      usage_mode,
      active,
      dine_in_only,
      takeaway_only,
      created_at,
      updated_at
    )

    VALUES
    (
      $1,
      $2,
      $3,
      'fixed',
      10,
      0,
      $4,
      0,
      $5,
      $6,
      FALSE,
      FALSE,
      NOW(),
      NOW()
    )

    RETURNING *
    `,
    [
      restaurantId,
      `TEST ${code}`,
      code,
      usageLimit,
      usageMode,
      active,
    ]
  );
}

async function voucherRow(id) {
  return one(
    `
    SELECT *
    FROM public.vouchers
    WHERE id = $1
    `,
    [
      Number(id),
    ]
  );
}

async function happyHourRow(id) {
  return one(
    `
    SELECT *
    FROM public.happy_hours
    WHERE id = $1
    `,
    [
      Number(id),
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
      "PRICING AUTH TEST REFUSED: wrong database"
    );

    pool =
      safe.pool;

    /*
     * Staff authority with a deliberately stale legacy
     * role of OWNER.
     *
     * If anything trusts role instead of authority,
     * this user becomes dangerous.
     */
    staleOwnerId =
      await createSecurityUser({
        username:
          "maks_pricing_stale_owner",

        role:
          "owner",

        authority:
          "staff",

        jobTitle:
          "Waiter",

        permissions: [],
      });

    /*
     * Fake Manager title.
     *
     * job_title must have zero security meaning.
     */
    fakeManagerTitleId =
      await createSecurityUser({
        username:
          "maks_pricing_fake_manager",

        role:
          "staff",

        authority:
          "staff",

        jobTitle:
          "Manager",

        permissions: [],
      });

    /*
     * Real manager who may configure vouchers.
     */
    voucherManagerId =
      await createSecurityUser({
        username:
          "maks_voucher_manager",

        role:
          "staff",

        authority:
          "manager",

        jobTitle:
          "Duty Manager",

        permissions: [
          P.VOUCHERS_MANAGE,
        ],
      });

    /*
     * Operational voucher user.
     *
     * May validate/redeem, but must NOT configure vouchers.
     */
    voucherOperatorId =
      await createSecurityUser({
        username:
          "maks_voucher_operator",

        role:
          "staff",

        authority:
          "staff",

        jobTitle:
          "Cashier",

        permissions: [
          P.POS_VOUCHER_PAYMENT,
        ],
      });

    /*
     * Happy Hour manager only.
     */
    happyHourManagerId =
      await createSecurityUser({
        username:
          "maks_happy_manager",

        role:
          "staff",

        authority:
          "manager",

        jobTitle:
          "Bar Manager",

        permissions: [
          P.HAPPY_HOUR_MANAGE,
        ],
      });

    ({ app } =
      require("../../server"));

    assert.ok(app);

    ownerTokenA =
      await login({
        username:
          "maks_test_owner_a",

        password:
          TEST_PASSWORD,

        restaurantId:
          fixtures.restaurantA,
      });

    ownerTokenB =
      await login({
        username:
          "maks_test_owner_b",

        password:
          TEST_PASSWORD,

        restaurantId:
          fixtures.restaurantB,
      });

    staleOwnerTokenA =
      await login({
        username:
          "maks_pricing_stale_owner",
      });

    fakeManagerTitleTokenA =
      await login({
        username:
          "maks_pricing_fake_manager",
      });

    voucherManagerTokenA =
      await login({
        username:
          "maks_voucher_manager",
      });

    voucherOperatorTokenA =
      await login({
        username:
          "maks_voucher_operator",
      });

    happyHourManagerTokenA =
      await login({
        username:
          "maks_happy_manager",
      });
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
 * 1. STALE LEGACY OWNER CANNOT MANAGE VOUCHERS
 * =====================================================
 */

test(
  "AUTHORITY: stale legacy owner role gives staff no voucher management power",
  async () => {
    const response =
      await request(app)
        .post("/vouchers")
        .set(
          "Authorization",
          bearer(
            staleOwnerTokenA
          )
        )
        .send(
          voucherPayload({
            code:
              "STALE-OWNER-ATTACK",
          })
        );

    assert.equal(
      response.status,
      403,
      `Legacy role escalated voucher authority: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 2. JOB TITLE MANAGER HAS ZERO AUTHORITY
 * =====================================================
 */

test(
  "AUTHORITY: job_title Manager cannot create voucher without permission",
  async () => {
    const response =
      await request(app)
        .post("/vouchers")
        .set(
          "Authorization",
          bearer(
            fakeManagerTitleTokenA
          )
        )
        .send(
          voucherPayload({
            code:
              "FAKE-MANAGER-ATTACK",
          })
        );

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 3. REAL VOUCHER MANAGER CAN CREATE
 * =====================================================
 */

test(
  "PERMISSION: manager with vouchers.manage can create voucher",
  async () => {
    const response =
      await request(app)
        .post("/vouchers")
        .set(
          "Authorization",
          bearer(
            voucherManagerTokenA
          )
        )
        .send(
          voucherPayload({
            code:
              "MANAGER-VALID-1",

            name:
              "Manager Voucher",
          })
        );

    assert.equal(
      response.status,
      201,
      JSON.stringify(
        response.body
      )
    );

    assert.equal(
      Number(
        response.body
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
 * 4. POS VOUCHER OPERATOR CANNOT CONFIGURE
 * =====================================================
 */

test(
  "PERMISSION: pos.voucher_payment does not grant voucher management",
  async () => {
    const response =
      await request(app)
        .post("/vouchers")
        .set(
          "Authorization",
          bearer(
            voucherOperatorTokenA
          )
        )
        .send(
          voucherPayload({
            code:
              "OPERATOR-CONFIG-ATTACK",
          })
        );

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 5. VOUCHER OPERATOR MAY VALIDATE
 * =====================================================
 */

test(
  "PERMISSION: POS voucher operator can validate tenant voucher",
  async () => {
    const voucher =
      await createVoucher({
        code:
          "OPERATOR-VALIDATE-1",
      });

    const response =
      await request(app)
        .post(
          "/vouchers/validate"
        )
        .set(
          "Authorization",
          bearer(
            voucherOperatorTokenA
          )
        )
        .send({
          code:
            voucher.code,

          order_type:
            "dine-in",

          subtotal:
            50,
        });

    assert.equal(
      response.status,
      200,
      JSON.stringify(
        response.body
      )
    );

    assert.equal(
      response.body?.ok,
      true
    );
  }
);

/*
 * =====================================================
 * 6. FAKE OWNER CANNOT APPLY VOUCHER
 * =====================================================
 */

test(
  "AUTHORITY: stale legacy owner cannot validate voucher without apply permission",
  async () => {
    const voucher =
      await createVoucher({
        code:
          "NO-LEGACY-APPLY-1",
      });

    const response =
      await request(app)
        .post(
          "/vouchers/validate"
        )
        .set(
          "Authorization",
          bearer(
            staleOwnerTokenA
          )
        )
        .send({
          code:
            voucher.code,

          order_type:
            "dine-in",

          subtotal:
            50,
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 7. CROSS-TENANT VOUCHER STATUS
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot change Restaurant B voucher status",
  async () => {
    const voucherB =
      await createVoucherDirect({
        restaurantId:
          fixtures.restaurantB,

        code:
          "TENANT-B-VOUCHER-1",
      });

    const response =
      await request(app)
        .patch(
          `/vouchers/${voucherB.id}/status`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          active:
            false,
        });

    assert.equal(
      response.status,
      404
    );

    const after =
      await voucherRow(
        voucherB.id
      );

    assert.equal(
      after.active,
      true
    );
  }
);

/*
 * =====================================================
 * 8. CROSS-TENANT DELETE
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot delete Restaurant B voucher",
  async () => {
    const voucherB =
      await createVoucherDirect({
        restaurantId:
          fixtures.restaurantB,

        code:
          "TENANT-B-VOUCHER-2",
      });

    const response =
      await request(app)
        .delete(
          `/vouchers/${voucherB.id}`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        );

    assert.equal(
      response.status,
      404
    );

    const after =
      await voucherRow(
        voucherB.id
      );

    assert.ok(after);
  }
);

/*
 * =====================================================
 * 9. CROSS-TENANT VALIDATION
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot validate Restaurant B voucher",
  async () => {
    const voucherB =
      await createVoucherDirect({
        restaurantId:
          fixtures.restaurantB,

        code:
          "TENANT-B-VOUCHER-3",
      });

    const response =
      await request(app)
        .post(
          "/vouchers/validate"
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          code:
            voucherB.code,

          order_type:
            "dine-in",

          subtotal:
            100,
        });

    assert.equal(
      response.status,
      404
    );
  }
);

/*
 * =====================================================
 * 10. CROSS-TENANT REDEMPTION
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot redeem Restaurant B voucher",
  async () => {
    const voucherB =
      await createVoucherDirect({
        restaurantId:
          fixtures.restaurantB,

        code:
          "TENANT-B-VOUCHER-4",
      });

    const response =
      await request(app)
        .post(
          `/vouchers/${voucherB.id}/redeem`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        );

    assert.equal(
      response.status,
      404
    );

    const after =
      await voucherRow(
        voucherB.id
      );

    assert.equal(
      Number(
        after.used_count
      ),
      0
    );
  }
);

/*
 * =====================================================
 * 11. SINGLE USE REPLAY
 * =====================================================
 */

test(
  "REPLAY: single-use voucher cannot be redeemed twice sequentially",
  async () => {
    const voucher =
      await createVoucher({
        code:
          "SINGLE-REPLAY-1",

        usageMode:
          "single",

        usageLimit:
          1,
      });

    const first =
      await request(app)
        .post(
          `/vouchers/${voucher.id}/redeem`
        )
        .set(
          "Authorization",
          bearer(
            voucherOperatorTokenA
          )
        );

    assert.equal(
      first.status,
      200,
      JSON.stringify(
        first.body
      )
    );

    const second =
      await request(app)
        .post(
          `/vouchers/${voucher.id}/redeem`
        )
        .set(
          "Authorization",
          bearer(
            voucherOperatorTokenA
          )
        );

    assert.ok(
      second.status >= 400,
      `Single-use voucher redeemed twice: ${second.status} ${JSON.stringify(
        second.body
      )}`
    );

    const after =
      await voucherRow(
        voucher.id
      );

    assert.equal(
      Number(
        after.used_count
      ),
      1
    );

    assert.equal(
      after.active,
      false
    );
  }
);

/*
 * =====================================================
 * 12. SINGLE USE CONCURRENCY
 *
 * This is expected to be the most important attack.
 * =====================================================
 */

test(
  "RACE: simultaneous redemption of single-use voucher succeeds exactly once",
  async () => {
    const voucher =
      await createVoucher({
        code:
          "SINGLE-RACE-1",

        usageMode:
          "single",

        usageLimit:
          1,
      });

    const [
      a,
      b,
    ] =
      await Promise.all([
        request(app)
          .post(
            `/vouchers/${voucher.id}/redeem`
          )
          .set(
            "Authorization",
            bearer(
              voucherOperatorTokenA
            )
          ),

        request(app)
          .post(
            `/vouchers/${voucher.id}/redeem`
          )
          .set(
            "Authorization",
            bearer(
              voucherOperatorTokenA
            )
          ),
      ]);

    const successes =
      [a, b].filter(
        (response) =>
          is2xx(
            response.status
          )
      );

    assert.equal(
      successes.length,
      1,
      `Concurrent single-use voucher produced ${successes.length} successful redemptions: ${JSON.stringify(
        [
          {
            status:
              a.status,
            body:
              a.body,
          },
          {
            status:
              b.status,
            body:
              b.body,
          },
        ]
      )}`
    );

    const after =
      await voucherRow(
        voucher.id
      );

    assert.equal(
      Number(
        after.used_count
      ),
      1,
      `Single-use voucher used_count became ${after.used_count}`
    );

    assert.equal(
      after.active,
      false
    );
  }
);

/*
 * =====================================================
 * 13. MULTI VOUCHER USAGE LIMIT RACE
 * =====================================================
 */

test(
  "RACE: limited multi-use voucher cannot exceed usage_limit",
  async () => {
    const voucher =
      await createVoucher({
        code:
          "MULTI-RACE-LIMIT-1",

        usageMode:
          "multi",

        usageLimit:
          1,
      });

    const [
      a,
      b,
    ] =
      await Promise.all([
        request(app)
          .post(
            `/vouchers/${voucher.id}/redeem`
          )
          .set(
            "Authorization",
            bearer(
              voucherOperatorTokenA
            )
          ),

        request(app)
          .post(
            `/vouchers/${voucher.id}/redeem`
          )
          .set(
            "Authorization",
            bearer(
              voucherOperatorTokenA
            )
          ),
      ]);

    const successes =
      [a, b].filter(
        (response) =>
          is2xx(
            response.status
          )
      );

    assert.equal(
      successes.length,
      1
    );

    const after =
      await voucherRow(
        voucher.id
      );

    assert.equal(
      Number(
        after.used_count
      ),
      1
    );
  }
);

/*
 * =====================================================
 * 14. HAPPY HOUR STALE OWNER
 * =====================================================
 */

test(
  "AUTHORITY: stale legacy owner role cannot create Happy Hour rule",
  async () => {
    const response =
      await request(app)
        .post(
          "/happy-hour"
        )
        .set(
          "Authorization",
          bearer(
            staleOwnerTokenA
          )
        )
        .send({
          name:
            "STALE OWNER HAPPY ATTACK",

          enabled:
            true,

          manual_live:
            false,

          mode:
            "manual",

          item_scope:
            "all",

          discount_type:
            "percent",

          discount_value:
            50,
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 15. HAPPY HOUR FAKE MANAGER TITLE
 * =====================================================
 */

test(
  "AUTHORITY: job_title Manager cannot manage Happy Hour",
  async () => {
    const response =
      await request(app)
        .post(
          "/happy-hour"
        )
        .set(
          "Authorization",
          bearer(
            fakeManagerTitleTokenA
          )
        )
        .send({
          name:
            "FAKE MANAGER HAPPY ATTACK",

          enabled:
            true,

          mode:
            "manual",

          item_scope:
            "all",

          discount_type:
            "percent",

          discount_value:
            25,
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 16. AUTHORISED HAPPY HOUR MANAGER
 * =====================================================
 */

test(
  "PERMISSION: manager with happy_hour.manage can create rule",
  async () => {
    const response =
      await request(app)
        .post(
          "/happy-hour"
        )
        .set(
          "Authorization",
          bearer(
            happyHourManagerTokenA
          )
        )
        .send({
          name:
            "VALID HAPPY MANAGER",

          enabled:
            true,

          manual_live:
            false,

          mode:
            "manual",

          item_scope:
            "all",

          discount_type:
            "percent",

          discount_value:
            20,
        });

    assert.equal(
      response.status,
      201,
      JSON.stringify(
        response.body
      )
    );

    assert.ok(
      response.body?.id
    );

    const row =
      await happyHourRow(
        response.body.id
      );

    assert.equal(
      Number(
        row.restaurant_id
      ),
      Number(
        fixtures.restaurantA
      )
    );
  }
);

/*
 * =====================================================
 * 17. CROSS-TENANT HAPPY HOUR TOGGLE
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot toggle Restaurant B Happy Hour",
  async () => {
    const row =
      await one(
        `
        INSERT INTO public.happy_hours
        (
          restaurant_id,
          name,
          enabled,
          manual_live,
          mode,
          item_scope,
          category_ids,
          item_ids,
          discount_type,
          discount_value,
          created_at,
          updated_at
        )

        VALUES
        (
          $1,
          'Restaurant B Happy Hour',
          TRUE,
          FALSE,
          'manual',
          'all',
          '[]'::jsonb,
          '[]'::jsonb,
          'percent',
          15,
          NOW(),
          NOW()
        )

        RETURNING *
        `,
        [
          fixtures.restaurantB,
        ]
      );

    const attack =
      await request(app)
        .patch(
          `/happy-hour/${row.id}/live`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          manual_live:
            true,
        });

    assert.equal(
      attack.status,
      404
    );

    const after =
      await happyHourRow(
        row.id
      );

    assert.equal(
      after.manual_live,
      false
    );
  }
);

/*
 * =====================================================
 * 18. CROSS-TENANT HAPPY HOUR DELETE
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot delete Restaurant B Happy Hour",
  async () => {
    const row =
      await one(
        `
        INSERT INTO public.happy_hours
        (
          restaurant_id,
          name,
          enabled,
          manual_live,
          mode,
          item_scope,
          category_ids,
          item_ids,
          discount_type,
          discount_value,
          created_at,
          updated_at
        )

        VALUES
        (
          $1,
          'Restaurant B Delete Test',
          TRUE,
          FALSE,
          'manual',
          'all',
          '[]'::jsonb,
          '[]'::jsonb,
          'percent',
          10,
          NOW(),
          NOW()
        )

        RETURNING *
        `,
        [
          fixtures.restaurantB,
        ]
      );

    const attack =
      await request(app)
        .delete(
          `/happy-hour/${row.id}`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        );

    assert.equal(
      attack.status,
      404
    );

    const after =
      await happyHourRow(
        row.id
      );

    assert.ok(after);
  }
);

/*
 * =====================================================
 * 19. CURRENT HAPPY HOUR OPERATIONAL VIEW
 * =====================================================
 */

test(
  "VIEW: active restaurant member may read current Happy Hour without manage permission",
  async () => {
    const response =
      await request(app)
        .get(
          "/happy-hour/current"
        )
        .set(
          "Authorization",
          bearer(
            voucherOperatorTokenA
          )
        );

    assert.equal(
      response.status,
      200,
      JSON.stringify(
        response.body
      )
    );
  }
);

/*
 * =====================================================
 * 20. FINAL VOUCHER TENANT INVARIANT
 * =====================================================
 */

test(
  "FINAL: vouchers retain valid restaurant ownership",
  async () => {
    const bad =
      await all(
        `
        SELECT
          id,
          restaurant_id

        FROM public.vouchers

        WHERE restaurant_id
          NOT IN ($1, $2)
        `,
        [
          fixtures.restaurantA,
          fixtures.restaurantB,
        ]
      );

    assert.deepEqual(
      bad,
      []
    );
  }
);

/*
 * =====================================================
 * 21. FINAL HAPPY HOUR TENANT INVARIANT
 * =====================================================
 */

test(
  "FINAL: Happy Hour rules retain valid restaurant ownership",
  async () => {
    const bad =
      await all(
        `
        SELECT
          id,
          restaurant_id

        FROM public.happy_hours

        WHERE restaurant_id
          NOT IN ($1, $2)
        `,
        [
          fixtures.restaurantA,
          fixtures.restaurantB,
        ]
      );

    assert.deepEqual(
      bad,
      []
    );
  }
);

/*
 * =====================================================
 * 22. FINAL STALE-ROLE USERS NEVER GAINED PERMISSIONS
 * =====================================================
 */

test(
  "FINAL: legacy roles and job titles never mutated authoritative pricing permissions",
  async () => {
    const rows =
      await all(
        `
        SELECT
          user_id,
          role,
          authority,
          job_title,
          permissions

        FROM public.restaurant_members

        WHERE restaurant_id = $1

          AND user_id =
              ANY($2::bigint[])
        `,
        [
          fixtures.restaurantA,
          [
            staleOwnerId,
            fakeManagerTitleId,
          ],
        ]
      );

    assert.equal(
      rows.length,
      2
    );

    for (
      const row of rows
    ) {
      assert.equal(
        row.authority,
        "staff"
      );

      const permissions =
        Array.isArray(
          row.permissions
        )
          ? row.permissions
          : JSON.parse(
              row.permissions ||
              "[]"
            );

      assert.deepEqual(
        permissions,
        []
      );
    }
  }
);