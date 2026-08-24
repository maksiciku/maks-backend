"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

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

/*
 * =====================================================
 * TEMPORARY POS SECURITY FIXTURES
 * =====================================================
 *
 * These users exist ONLY inside maks_test.
 *
 * We deliberately create mismatches between:
 *
 *   legacy role
 *   authority
 *   permissions
 *   job_title
 *
 * The whole point is to prove that legacy presentation /
 * compatibility fields cannot create security authority.
 */

const USERS = {
  staleLegacyOwner: {
    username:
      "maks_test_stale_legacy_owner",

    pin:
      "1111",

    role:
      "owner",

    authority:
      "staff",

    jobTitle:
      "Waiter",

    permissions: [],
  },

  fakeManagerTitle: {
    username:
      "maks_test_fake_manager_title",

    pin:
      "2222",

    role:
      "staff",

    authority:
      "staff",

    jobTitle:
      "Manager",

    permissions: [],
  },

  realManager: {
    username:
      "maks_test_real_manager",

    pin:
      "3333",

    role:
      "staff",

    authority:
      "manager",

    jobTitle:
      "Shift Manager",

    permissions: [
      "pos.void_order",
      "kds.view",
    ],
  },

  managerNoPermissions: {
    username:
      "maks_test_manager_no_permissions",

    pin:
      "4444",

    /*
     * Deliberately stale elevated legacy role.
     */
    role:
      "owner",

    authority:
      "manager",

    jobTitle:
      "Manager",

    permissions: [],
  },

  authorityOwner: {
    username:
      "maks_test_authority_owner",

    pin:
      "5555",

    /*
     * Deliberately LOW legacy role.
     *
     * Real authority is owner.
     */
    role:
      "staff",

    authority:
      "owner",

    jobTitle:
      "Owner",

    permissions: [],
  },
};

function bearer(token) {
  return `Bearer ${token}`;
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

async function createSecurityUser(
  definition
) {
  const passwordHash =
    await bcrypt.hash(
      TEST_PASSWORD,
      10
    );

  const pinHash =
    await bcrypt.hash(
      definition.pin,
      10
    );

  const result =
    await query(
      `
      INSERT INTO public.users
      (
        username,
        password,
        password_hash,
        role,
        restaurant_id,
        is_active,
        can_pos_login,
        can_backoffice_login,
        full_name,
        permissions,
        pin_hash
      )

      VALUES
      (
        $1,
        $2,
        $2,
        $3,
        $4,
        TRUE,
        TRUE,
        FALSE,
        $5,
        $6::jsonb,
        $7
      )

      RETURNING id
      `,
      [
        definition.username,
        passwordHash,
        definition.role,
        fixtures.restaurantA,
        `TEST ${definition.username}`,
        JSON.stringify(
          definition.permissions
        ),
        pinHash,
      ]
    );

  const userId =
    Number(
      result.rows[0].id
    );

  await query(
    `
    INSERT INTO public.restaurant_members
    (
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
      $3,
      'active',
      TRUE,
      $4,
      $5,
      $6::jsonb
    )
    `,
    [
      fixtures.restaurantA,
      userId,
      definition.role,
      definition.authority,
      definition.jobTitle,
      JSON.stringify(
        definition.permissions
      ),
    ]
  );

  definition.id =
    userId;

  return userId;
}

async function pinLogin(
  pin,
  restaurantId =
    fixtures.restaurantA
) {
  return request(app)
    .post(
      "/pos-auth/pin-login"
    )
    .set(
      "x-tenant-rid",
      String(
        restaurantId
      )
    )
    .send({
      pin,
    });
}

async function approveAction({
  pin,
  action,
  restaurantId =
    fixtures.restaurantA,
}) {
  return request(app)
    .post(
      "/pos-auth/approve-action"
    )
    .set(
      "x-tenant-rid",
      String(
        restaurantId
      )
    )
    .send({
      pin,
      action,
    });
}

async function kdsFeedLogin({
  pin,
  restaurantId =
    fixtures.restaurantA,
}) {
  return request(app)
    .post(
      "/pos-auth/kds-feed-login"
    )
    .send({
      restaurant_id:
        restaurantId,

      pin,
    });
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
      "POS AUTH TEST REFUSED: wrong database"
    );

    pool =
      safe.pool;

    ({ app } =
      require("../../server"));

    assert.ok(
      app,
      "Express app unavailable"
    );

    /*
     * Login the genuine Restaurant A owner.
     */
    const login =
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
      login.status,
      200,
      JSON.stringify(
        login.body
      )
    );

    ownerTokenA =
      login.body?.token;

    assert.ok(
      ownerTokenA
    );

    /*
     * Temporary authority fixtures.
     */
    for (
      const definition
      of Object.values(
        USERS
      )
    ) {
      await createSecurityUser(
        definition
      );
    }
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
 * 1. PIN LOGIN MUST REPORT REAL AUTHORITY
 * =====================================================
 */

test(
  "AUTHORITY: PIN login exposes authoritative membership authority",
  async () => {
    const response =
      await pinLogin(
        USERS
          .staleLegacyOwner
          .pin
      );

    assert.equal(
      response.status,
      200,
      JSON.stringify(
        response.body
      )
    );

    assert.equal(
      response.body
        ?.staff
        ?.authority,
      "staff"
    );

    /*
     * The old compatibility role may still say owner.
     *
     * That is acceptable only if no security decision
     * trusts it.
     */
    assert.equal(
      response.body
        ?.staff
        ?.role,
      "owner"
    );
  }
);

/*
 * =====================================================
 * 2. STALE LEGACY OWNER ROLE MUST NOT APPROVE
 *
 * Current approve-action is expected to expose this.
 * =====================================================
 */

test(
  "AUTHORITY: staff authority cannot approve using stale legacy owner role",
  async () => {
    const response =
      await approveAction({
        pin:
          USERS
            .staleLegacyOwner
            .pin,

        action:
          "pos.void_order",
      });

    assert.ok(
      response.status >= 400,
      `Staff authority received manager approval: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 3. JOB TITLE HAS ZERO AUTHORITY
 * =====================================================
 */

test(
  "AUTHORITY: job_title Manager gives staff no approval power",
  async () => {
    const response =
      await approveAction({
        pin:
          USERS
            .fakeManagerTitle
            .pin,

        action:
          "pos.void_order",
      });

    assert.ok(
      response.status >= 400
    );
  }
);

/*
 * =====================================================
 * 4. REAL MANAGER + REQUIRED PERMISSION
 *
 * The modern model should allow this even if legacy role
 * says staff.
 *
 * Current legacy role implementation may reject it.
 * =====================================================
 */

test(
  "AUTHORITY: real manager with required permission can approve action",
  async () => {
    const response =
      await approveAction({
        pin:
          USERS
            .realManager
            .pin,

        action:
          "pos.void_order",
      });

    assert.equal(
      response.status,
      200,
      `Real authorised manager rejected: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    assert.equal(
      response.body
        ?.success,
      true
    );
  }
);

/*
 * =====================================================
 * 5. MANAGER WITHOUT PERMISSION
 *
 * A manager title/authority is not blanket permission.
 * =====================================================
 */

test(
  "PERMISSION: manager without requested permission cannot approve action",
  async () => {
    const response =
      await approveAction({
        pin:
          USERS
            .managerNoPermissions
            .pin,

        action:
          "pos.void_order",
      });

    assert.ok(
      response.status >= 400,
      `Permissionless manager approved action: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 6. OWNER AUTHORITY IS AUTHORITATIVE
 *
 * Owner should not lose authority because stale legacy
 * role says staff.
 * =====================================================
 */

test(
  "AUTHORITY: owner authority works regardless of stale legacy staff role",
  async () => {
    const response =
      await approveAction({
        pin:
          USERS
            .authorityOwner
            .pin,

        action:
          "pos.void_order",
      });

    assert.equal(
      response.status,
      200,
      `Owner authority rejected because of legacy role: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 7. CROSS-TENANT PIN
 * =====================================================
 */

test(
  "TENANT: Restaurant A PIN cannot authenticate inside Restaurant B",
  async () => {
    const response =
      await pinLogin(
        USERS
          .authorityOwner
          .pin,

        fixtures.restaurantB
      );

    assert.equal(
      response.status,
      401
    );
  }
);

/*
 * =====================================================
 * 8. CROSS-TENANT MANAGER APPROVAL
 * =====================================================
 */

test(
  "TENANT: Restaurant A manager PIN cannot approve Restaurant B action",
  async () => {
    const response =
      await approveAction({
        pin:
          USERS
            .realManager
            .pin,

        action:
          "pos.void_order",

        restaurantId:
          fixtures.restaurantB,
      });

    assert.equal(
      response.status,
      401
    );
  }
);

/*
 * =====================================================
 * 9. DISABLED MEMBERSHIP
 * =====================================================
 */

test(
  "AUTHORITY: inactive membership cannot PIN-login or approve",
  async () => {
    await query(
      `
      UPDATE public.restaurant_members

      SET is_active = FALSE

      WHERE restaurant_id = $1
        AND user_id = $2
      `,
      [
        fixtures.restaurantA,
        USERS.realManager.id,
      ]
    );

    try {
      const login =
        await pinLogin(
          USERS
            .realManager
            .pin
        );

      assert.equal(
        login.status,
        401
      );

      const approval =
        await approveAction({
          pin:
            USERS
              .realManager
              .pin,

          action:
            "pos.void_order",
        });

      assert.equal(
        approval.status,
        401
      );
    } finally {
      await query(
        `
        UPDATE public.restaurant_members

        SET is_active = TRUE

        WHERE restaurant_id = $1
          AND user_id = $2
        `,
        [
          fixtures.restaurantA,
          USERS.realManager.id,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 10. DISABLED USER
 * =====================================================
 */

test(
  "AUTHORITY: inactive user cannot PIN-login or approve",
  async () => {
    await query(
      `
      UPDATE public.users

      SET is_active = FALSE

      WHERE id = $1
      `,
      [
        USERS.realManager.id,
      ]
    );

    try {
      const login =
        await pinLogin(
          USERS
            .realManager
            .pin
        );

      assert.equal(
        login.status,
        401
      );

      const approval =
        await approveAction({
          pin:
            USERS
              .realManager
              .pin,

          action:
            "pos.void_order",
        });

      assert.equal(
        approval.status,
        401
      );
    } finally {
      await query(
        `
        UPDATE public.users

        SET is_active = TRUE

        WHERE id = $1
        `,
        [
          USERS.realManager.id,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 11. POS ACCESS REVOKED
 * =====================================================
 */

test(
  "AUTHORITY: can_pos_login=false immediately revokes PIN authority",
  async () => {
    await query(
      `
      UPDATE public.users

      SET can_pos_login = FALSE

      WHERE id = $1
      `,
      [
        USERS.realManager.id,
      ]
    );

    try {
      const login =
        await pinLogin(
          USERS
            .realManager
            .pin
        );

      assert.equal(
        login.status,
        401
      );

      const approval =
        await approveAction({
          pin:
            USERS
              .realManager
              .pin,

          action:
            "pos.void_order",
        });

      assert.equal(
        approval.status,
        401
      );
    } finally {
      await query(
        `
        UPDATE public.users

        SET can_pos_login = TRUE

        WHERE id = $1
        `,
        [
          USERS.realManager.id,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 12. RESTAURANT SUSPENSION
 * =====================================================
 */

test(
  "ACCOUNT: suspended restaurant cannot use PIN approval",
  async () => {
    await query(
      `
      UPDATE public.restaurants

      SET account_status =
            'suspended'

      WHERE id = $1
      `,
      [
        fixtures.restaurantA,
      ]
    );

    try {
      const login =
        await pinLogin(
          USERS
            .authorityOwner
            .pin
        );

      assert.equal(
        login.status,
        403
      );

      const approval =
        await approveAction({
          pin:
            USERS
              .authorityOwner
              .pin,

          action:
            "pos.void_order",
        });

      assert.equal(
        approval.status,
        403
      );

      const kds =
        await kdsFeedLogin({
          pin:
            USERS
              .authorityOwner
              .pin,
        });

      assert.equal(
        kds.status,
        403
      );
    } finally {
      await query(
        `
        UPDATE public.restaurants

        SET account_status =
              'active'

        WHERE id = $1
        `,
        [
          fixtures.restaurantA,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 13. INVALID PIN FORMAT / RANDOM PIN
 * =====================================================
 */

test(
  "AUTHORITY: malformed and random PINs never approve",
  async () => {
    const malformed =
      await approveAction({
        pin:
          "12",

        action:
          "pos.void_order",
      });

    assert.equal(
      malformed.status,
      400
    );

    const random =
      await approveAction({
        pin:
          "9876",

        action:
          "pos.void_order",
      });

    assert.equal(
      random.status,
      401
    );
  }
);

/*
 * =====================================================
 * 14. KDS LEGACY ROLE ESCALATION
 *
 * Staff authority + old role owner must NOT generate
 * a KDS-only JWT.
 * =====================================================
 */

test(
  "KDS AUTHORITY: stale legacy owner role cannot create KDS feed token",
  async () => {
    const response =
      await kdsFeedLogin({
        pin:
          USERS
            .staleLegacyOwner
            .pin,
      });

    assert.ok(
      response.status >= 400,
      `Staff authority received KDS token: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    assert.equal(
      response.body?.token,
      undefined
    );
  }
);

/*
 * =====================================================
 * 15. REAL MANAGER WITH KDS PERMISSION
 * =====================================================
 */

test(
  "KDS AUTHORITY: authorised manager can create tenant-bound KDS token",
  async () => {
    const response =
      await kdsFeedLogin({
        pin:
          USERS
            .realManager
            .pin,
      });

    assert.equal(
      response.status,
      200,
      `Authorised manager KDS login rejected: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    assert.ok(
      response.body?.token
    );

    const decoded =
      jwt.decode(
        response.body.token
      );

    assert.equal(
      Number(
        decoded?.restaurant_id
      ),
      Number(
        fixtures.restaurantA
      )
    );

    assert.equal(
      decoded?.scope,
      "kds_only"
    );

    assert.equal(
      decoded?.purpose,
      "shared_kds_printer"
    );
  }
);

/*
 * =====================================================
 * 16. KDS TENANT BOUNDARY
 * =====================================================
 */

test(
  "KDS TENANT: Restaurant A PIN cannot create Restaurant B KDS token",
  async () => {
    const response =
      await kdsFeedLogin({
        pin:
          USERS
            .realManager
            .pin,

        restaurantId:
          fixtures.restaurantB,
      });

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      response.body?.token,
      undefined
    );
  }
);

/*
 * =====================================================
 * 17. DISABLED USER CANNOT GET KDS TOKEN
 * =====================================================
 */

test(
  "KDS AUTHORITY: disabled user cannot create feed token",
  async () => {
    await query(
      `
      UPDATE public.users

      SET is_active = FALSE

      WHERE id = $1
      `,
      [
        USERS.realManager.id,
      ]
    );

    try {
      const response =
        await kdsFeedLogin({
          pin:
            USERS
              .realManager
              .pin,
        });

      assert.equal(
        response.status,
        401
      );

      assert.equal(
        response.body?.token,
        undefined
      );
    } finally {
      await query(
        `
        UPDATE public.users

        SET is_active = TRUE

        WHERE id = $1
        `,
        [
          USERS.realManager.id,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 18. LEGACY KDS BUSINESS LOGIN REMAINS DEAD
 * =====================================================
 */

test(
  "KDS LEGACY: old business login remains permanently disabled",
  async () => {
    const response =
      await request(app)
        .post(
          "/pos-auth/kds-business-login"
        )
        .send({
          restaurant_id:
            fixtures.restaurantA,

          pin:
            USERS
              .authorityOwner
              .pin,
        });

    assert.equal(
      response.status,
      410
    );
  }
);

/*
 * =====================================================
 * 19. RESET-PIN TENANT BOUNDARY
 *
 * Owner A must NEVER be able to nominate Restaurant B
 * in a header and reset Owner B's PIN.
 *
 * We restore the original hash even if this test exposes
 * a problem so later tests remain clean.
 * =====================================================
 */

test(
  "TENANT: Restaurant A owner cannot reset Restaurant B user PIN",
  async () => {
    const before =
      await one(
        `
        SELECT
          pin_hash,
          can_pos_login

        FROM public.users

        WHERE id = $1
        `,
        [
          fixtures.ownerB,
        ]
      );

    assert.ok(before);

    let response;

    try {
      response =
        await request(app)
          .post(
            "/pos-auth/reset-pin"
          )
          .set(
            "Authorization",
            bearer(
              ownerTokenA
            )
          )
          .set(
            "x-tenant-rid",
            String(
              fixtures.restaurantB
            )
          )
          .send({
            user_id:
              fixtures.ownerB,

            pin:
              "8642",

            can_pos_login:
              true,
          });

      assert.ok(
        response.status >= 400,
        `Cross-tenant PIN reset succeeded: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );

      const after =
        await one(
          `
          SELECT
            pin_hash,
            can_pos_login

          FROM public.users

          WHERE id = $1
          `,
          [
            fixtures.ownerB,
          ]
        );

      assert.equal(
        after.pin_hash,
        before.pin_hash,
        "Restaurant B PIN hash was modified by Restaurant A"
      );
    } finally {
      /*
       * Safety restoration in case the current route is
       * vulnerable. This is maks_test only.
       */
      await query(
        `
        UPDATE public.users

        SET
          pin_hash = $1,
          can_pos_login = $2

        WHERE id = $3
        `,
        [
          before.pin_hash,
          before.can_pos_login,
          fixtures.ownerB,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 20. FINAL AUTHORITY DATABASE INVARIANT
 * =====================================================
 */

test(
  "FINAL: regression requests did not mutate authority or permissions",
  async () => {
    for (
      const definition
      of Object.values(
        USERS
      )
    ) {
      const row =
        await one(
          `
          SELECT
            rm.role,
            rm.authority,
            rm.job_title,
            rm.permissions,

            u.is_active,
            u.can_pos_login

          FROM public.restaurant_members rm

          JOIN public.users u
            ON u.id =
                 rm.user_id

          WHERE rm.restaurant_id =
                $1

            AND rm.user_id =
                $2
          `,
          [
            fixtures.restaurantA,
            definition.id,
          ]
        );

      assert.ok(row);

      assert.equal(
        String(
          row.authority
        ),
        definition.authority
      );

      assert.equal(
        String(
          row.role
        ),
        definition.role
      );

      assert.equal(
        String(
          row.job_title
        ),
        definition.jobTitle
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
        [...permissions].sort(),
        [
          ...definition.permissions,
        ].sort()
      );

      assert.equal(
        row.is_active,
        true
      );

      assert.equal(
        row.can_pos_login,
        true
      );
    }
  }
);

/*
 * =====================================================
 * 21. FINAL TENANT MEMBERSHIP INVARIANT
 * =====================================================
 */

test(
  "FINAL: temporary users remain members only of Restaurant A",
  async () => {
    const ids =
      Object.values(
        USERS
      ).map(
        (definition) =>
          Number(
            definition.id
          )
      );

    const bad =
      await query(
        `
        SELECT
          restaurant_id,
          user_id

        FROM public.restaurant_members

        WHERE user_id =
              ANY(
                $1::bigint[]
              )

          AND restaurant_id <>
              $2
        `,
        [
          ids,
          fixtures.restaurantA,
        ]
      );

    assert.deepEqual(
      bad.rows,
      []
    );
  }
);