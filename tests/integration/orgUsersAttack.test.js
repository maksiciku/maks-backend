"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const request =
  require("supertest");

const bcrypt =
  require("bcryptjs");

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

/*
 * =====================================================
 * TEST STATE
 * =====================================================
 */

let app;
let pool;
let fixtures;

let ownerTokenA;
let ownerTokenB;

let managerTokenA;
let staffEditorTokenA;

const MANAGER_PASSWORD =
  "MAKS-ORG-MANAGER-TEST-123!";

const STAFF_EDITOR_PASSWORD =
  "MAKS-ORG-STAFF-EDITOR-123!";

const MANAGER_PIN =
  "3210";

const STAFF_A_PIN =
  "4310";

const STAFF_B_PIN =
  "5410";

const PERMISSIONS = {
  USERS_VIEW:
    "users.view",

  USERS_CREATE:
    "users.create",

  USERS_EDIT:
    "users.edit",

  USERS_DISABLE:
    "users.disable",

  USERS_REMOVE:
    "users.remove",

  USERS_RESET_PIN:
    "users.reset_pin",

  USERS_MANAGE_PERMISSIONS:
    "users.manage_permissions",

  USERS_MANAGE_POS_ACCESS:
    "users.manage_pos_access",

  SETTINGS_VIEW:
    "settings.view",

  RESTAURANT_TRANSFER_OWNERSHIP:
    "restaurant.transfer_ownership",
};

const MANAGER_PERMISSIONS = [
  PERMISSIONS.USERS_VIEW,
  PERMISSIONS.USERS_CREATE,
  PERMISSIONS.USERS_EDIT,
  PERMISSIONS.USERS_DISABLE,
  PERMISSIONS.USERS_REMOVE,
  PERMISSIONS.USERS_RESET_PIN,
  PERMISSIONS.USERS_MANAGE_PERMISSIONS,
  PERMISSIONS.USERS_MANAGE_POS_ACCESS,
];

let managerId;
let staffEditorId;
let staffAId;
let staffBId;

/*
 * =====================================================
 * HELPERS
 * =====================================================
 */

function bearer(token) {
  return `Bearer ${token}`;
}

function is2xx(status) {
  return (
    status >= 200 &&
    status < 300
  );
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

function parsePermissions(value) {
  if (
    Array.isArray(value)
  ) {
    return value;
  }

  try {
    const parsed =
      JSON.parse(
        value || "[]"
      );

    return Array.isArray(
      parsed
    )
      ? parsed
      : [];
  } catch {
    return [];
  }
}

async function membership(
  restaurantId,
  userId
) {
  return one(
    `
    SELECT
      rm.id,
      rm.restaurant_id,
      rm.user_id,
      rm.role,
      rm.authority,
      rm.job_title,
      rm.permissions,
      rm.status,
      rm.is_active,

      u.username,
      u.full_name,
      u.role AS user_role,
      u.is_active AS user_is_active,
      u.can_pos_login,
      u.can_backoffice_login,
      u.pin_hash,
      u.password_hash

    FROM public.restaurant_members rm

    JOIN public.users u
      ON u.id =
           rm.user_id

    WHERE rm.restaurant_id =
          $1

      AND rm.user_id =
          $2

    LIMIT 1
    `,
    [
      restaurantId,
      userId,
    ]
  );
}

async function createFixtureUser({
  username,
  password,
  fullName,
  authority = "staff",
  jobTitle = "Team Member",
  permissions = [],
  pin,
  canPosLogin = true,
  canBackofficeLogin = true,
}) {
  const passwordHash =
    bcrypt.hashSync(
      password,
      10
    );

  const pinHash =
    pin
      ? bcrypt.hashSync(
          pin,
          10
        )
      : null;

  /*
   * Legacy role remains STAFF for managers.
   *
   * This is deliberate:
   * security must use authority, not the compatibility role.
   */
  const legacyRole =
    authority === "owner"
      ? "owner"
      : "staff";

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
        pin_hash,
        pin_label,
        can_pos_login,
        can_backoffice_login,
        force_password_reset,
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
        $6,
        'Test PIN',
        $7,
        $8,
        FALSE,
        NOW()
      )

      RETURNING id
      `,
      [
        username,
        passwordHash,
        legacyRole,
        fixtures.restaurantA,
        fullName,
        pinHash,
        !!canPosLogin,
        !!canBackofficeLogin,
      ]
    );

  assert.ok(
    user?.id
  );

  const userId =
    Number(
      user.id
    );

  await query(
    `
    INSERT INTO public.restaurant_members
    (
      restaurant_id,
      user_id,
      role,
      authority,
      job_title,
      status,
      is_active,
      permissions,
      created_at
    )

    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      $5,
      'active',
      TRUE,
      $6::jsonb,
      NOW()
    )
    `,
    [
      fixtures.restaurantA,
      userId,
      legacyRole,
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
  password,
  restaurantId,
}) {
  const response =
    await request(app)
      .post(
        "/auth/login"
      )
      .send({
        username,
        password,

        restaurant_id:
          restaurantId,
      });

  assert.equal(
    response.status,
    200,
    `Login failed: ${
      response.status
    } ${JSON.stringify(
      response.body
    )}`
  );

  assert.ok(
    response.body?.token
  );

  return response.body.token;
}

async function resetMembershipPermissions(
  userId,
  permissions
) {
  await query(
    `
    UPDATE public.restaurant_members

    SET permissions =
          $1::jsonb

    WHERE restaurant_id =
          $2

      AND user_id =
          $3
    `,
    [
      JSON.stringify(
        permissions
      ),
      fixtures.restaurantA,
      userId,
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
      "ORG USER ATTACK REFUSED: wrong database"
    );

    pool =
      safe.pool;

    /*
     * Manager with the complete delegated user-management
     * capability set.
     */
    managerId =
      await createFixtureUser({
        username:
          "maks_org_manager_a",

        password:
          MANAGER_PASSWORD,

        fullName:
          "ORG Test Manager",

        authority:
          "manager",

        jobTitle:
          "General Manager",

        permissions:
          MANAGER_PERMISSIONS,

        pin:
          MANAGER_PIN,
      });

    /*
     * Staff member deliberately holding users.edit.
     *
     * Holding an individual permission must never convert
     * staff authority into Manager/Owner authority.
     */
    staffEditorId =
      await createFixtureUser({
        username:
          "maks_org_staff_editor_a",

        password:
          STAFF_EDITOR_PASSWORD,

        fullName:
          "ORG Staff Editor",

        authority:
          "staff",

        jobTitle:
          "Team Member",

        permissions: [
          PERMISSIONS.USERS_EDIT,
        ],

        pin:
          "6510",
      });

    /*
     * Two ordinary targets used throughout the attacks.
     */
    staffAId =
      await createFixtureUser({
        username:
          "maks_org_staff_a",

        password:
          "MAKS-STAFF-A-TEST-123!",

        fullName:
          "ORG Staff A",

        authority:
          "staff",

        jobTitle:
          "Waiter",

        permissions: [],

        pin:
          STAFF_A_PIN,

        canBackofficeLogin:
          false,
      });

    staffBId =
      await createFixtureUser({
        username:
          "maks_org_staff_b",

        password:
          "MAKS-STAFF-B-TEST-123!",

        fullName:
          "ORG Staff B",

        authority:
          "staff",

        jobTitle:
          "Cashier",

        permissions: [],

        pin:
          STAFF_B_PIN,

        canBackofficeLogin:
          false,
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

    managerTokenA =
      await login({
        username:
          "maks_org_manager_a",

        password:
          MANAGER_PASSWORD,

        restaurantId:
          fixtures.restaurantA,
      });

    staffEditorTokenA =
      await login({
        username:
          "maks_org_staff_editor_a",

        password:
          STAFF_EDITOR_PASSWORD,

        restaurantId:
          fixtures.restaurantA,
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
 * 1. TENANT LIST ISOLATION
 * =====================================================
 */

test(
  "TENANT: Restaurant A user list never exposes Restaurant B owner",
  async () => {
    const response =
      await request(app)
        .get(
          "/org/users"
        )
        .set(
          "Authorization",
          bearer(
            ownerTokenA
          )
        );

    assert.equal(
      response.status,
      200,
      JSON.stringify(
        response.body
      )
    );

    const ids =
      (
        Array.isArray(
          response.body
        )
          ? response.body
          : []
      ).map(
        (row) =>
          Number(
            row.id
          )
      );

    assert.equal(
      ids.includes(
        Number(
          fixtures.ownerB
        )
      ),
      false
    );
  }
);

/*
 * =====================================================
 * 2. STAFF CANNOT CREATE USERS
 * =====================================================
 */

test(
  "PERMISSION: staff without users.create cannot create employee",
  async () => {
    const response =
      await request(app)
        .post(
          "/org/users"
        )
        .set(
          "Authorization",
          bearer(
            staffEditorTokenA
          )
        )
        .send({
          full_name:
            "FORGED EMPLOYEE",

          authority:
            "staff",

          job_title:
            "Waiter",

          can_pos_login:
            true,

          pin:
            "7610",

          permissions: [],
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 3. MANAGER MAY CREATE STAFF
 * =====================================================
 */

test(
  "AUTHORITY: authorised manager can create ordinary staff",
  async () => {
    const response =
      await request(app)
        .post(
          "/org/users"
        )
        .set(
          "Authorization",
          bearer(
            managerTokenA
          )
        )
        .send({
          full_name:
            "Manager Created Staff",

          authority:
            "staff",

          job_title:
            "Server",

          can_pos_login:
            true,

          can_backoffice_login:
            false,

          pin:
            "8710",

          permissions: [
            PERMISSIONS.USERS_VIEW,
          ],
        });

    assert.equal(
      response.status,
      201,
      `Authorised manager could not create staff: ${
        response.status
      } ${JSON.stringify(
        response.body
      )}`
    );

    assert.equal(
      response.body
        ?.user
        ?.authority,
      "staff"
    );

    assert.notEqual(
      response.body
        ?.user
        ?.authority,
      "manager"
    );

    assert.notEqual(
      response.body
        ?.user
        ?.authority,
      "owner"
    );
  }
);

/*
 * =====================================================
 * 4. MANAGER CANNOT CREATE MANAGER
 * =====================================================
 */

test(
  "AUTHORITY: manager cannot create another manager",
  async () => {
    const response =
      await request(app)
        .post(
          "/org/users"
        )
        .set(
          "Authorization",
          bearer(
            managerTokenA
          )
        )
        .send({
          full_name:
            "FORGED MANAGER",

          authority:
            "manager",

          job_title:
            "Manager",

          can_pos_login:
            true,

          pin:
            "8810",

          permissions: [],
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 5. MANAGER CANNOT CREATE OWNER
 * =====================================================
 */

test(
  "AUTHORITY: manager cannot create owner",
  async () => {
    const response =
      await request(app)
        .post(
          "/org/users"
        )
        .set(
          "Authorization",
          bearer(
            managerTokenA
          )
        )
        .send({
          full_name:
            "FORGED OWNER",

          authority:
            "owner",

          job_title:
            "Owner",

          can_pos_login:
            true,

          pin:
            "8910",

          permissions: [],
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 6. MANAGER CANNOT GRANT UNOWNED PERMISSION AT CREATE
 * =====================================================
 */

test(
  "PERMISSION: manager cannot grant permission they do not possess during creation",
  async () => {
    const response =
      await request(app)
        .post(
          "/org/users"
        )
        .set(
          "Authorization",
          bearer(
            managerTokenA
          )
        )
        .send({
          full_name:
            "FORGED REPORT ADMIN",

          authority:
            "staff",

          job_title:
            "Waiter",

          can_pos_login:
            true,

          pin:
            "9010",

          permissions: [
            PERMISSIONS.SETTINGS_VIEW,
          ],
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 7. UNKNOWN PERMISSION AT CREATE
 * =====================================================
 */

test(
  "PERMISSION: unknown permission cannot be created",
  async () => {
    const response =
      await request(app)
        .post(
          "/org/users"
        )
        .set(
          "Authorization",
          bearer(
            ownerTokenA
          )
        )
        .send({
          full_name:
            "UNKNOWN PERMISSION USER",

          authority:
            "staff",

          job_title:
            "Waiter",

          can_pos_login:
            true,

          pin:
            "9110",

          permissions: [
            "maks.super_god_mode",
          ],
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 8. STAFF CANNOT SELF-PROMOTE
 * =====================================================
 */

test(
  "AUTHORITY: staff with users.edit cannot self-promote to manager",
  async () => {
    const before =
      await membership(
        fixtures.restaurantA,
        staffEditorId
      );

    const response =
      await request(app)
        .put(
          `/org/users/${staffEditorId}`
        )
        .set(
          "Authorization",
          bearer(
            staffEditorTokenA
          )
        )
        .send({
          authority:
            "manager",

          full_name:
            before.full_name,

          job_title:
            "Manager",
        });

    assert.equal(
      response.status,
      403
    );

    const after =
      await membership(
        fixtures.restaurantA,
        staffEditorId
      );

    assert.equal(
      after.authority,
      "staff"
    );
  }
);

/*
 * =====================================================
 * 9. JOB TITLE IS PRESENTATION ONLY
 * =====================================================
 */

test(
  "AUTHORITY: job_title Owner does not give staff owner authority",
  async () => {
    const response =
      await request(app)
        .put(
          `/org/users/${staffEditorId}`
        )
        .set(
          "Authorization",
          bearer(
            staffEditorTokenA
          )
        )
        .send({
          job_title:
            "Owner",
        });

    assert.ok(
      is2xx(
        response.status
      ),
      JSON.stringify(
        response.body
      )
    );

    const after =
      await membership(
        fixtures.restaurantA,
        staffEditorId
      );

    assert.equal(
      after.job_title,
      "Owner"
    );

    assert.equal(
      after.authority,
      "staff"
    );

    assert.notEqual(
      after.role,
      "owner"
    );
  }
);

/*
 * =====================================================
 * 10. MANAGER CANNOT PROMOTE STAFF → MANAGER
 * =====================================================
 */

test(
  "AUTHORITY: manager cannot promote staff to manager",
  async () => {
    const response =
      await request(app)
        .put(
          `/org/users/${staffAId}`
        )
        .set(
          "Authorization",
          bearer(
            managerTokenA
          )
        )
        .send({
          authority:
            "manager",

          job_title:
            "Manager",
        });

    assert.equal(
      response.status,
      403
    );

    const after =
      await membership(
        fixtures.restaurantA,
        staffAId
      );

    assert.equal(
      after.authority,
      "staff"
    );
  }
);

/*
 * =====================================================
 * 11. MANAGER CANNOT EDIT OWNER
 * =====================================================
 */

test(
  "AUTHORITY: manager cannot edit restaurant owner",
  async () => {
    const response =
      await request(app)
        .put(
          `/org/users/${fixtures.ownerA}`
        )
        .set(
          "Authorization",
          bearer(
            managerTokenA
          )
        )
        .send({
          full_name:
            "FORGED OWNER NAME",
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 12. OWNER CANNOT BE DEMOTED THROUGH NORMAL EDITOR
 * =====================================================
 */

test(
  "OWNER: owner cannot be demoted through normal staff editor",
  async () => {
    const response =
      await request(app)
        .put(
          `/org/users/${fixtures.ownerA}`
        )
        .set(
          "Authorization",
          bearer(
            ownerTokenA
          )
        )
        .send({
          authority:
            "staff",
        });

    assert.equal(
      response.status,
      403
    );

    const owner =
      await membership(
        fixtures.restaurantA,
        fixtures.ownerA
      );

    assert.equal(
      owner.authority,
      "owner"
    );
  }
);

/*
 * =====================================================
 * 13. OWNER CANNOT BE DISABLED THROUGH NORMAL EDITOR
 * =====================================================
 */

test(
  "OWNER: owner cannot be disabled through normal staff editor",
  async () => {
    const response =
      await request(app)
        .put(
          `/org/users/${fixtures.ownerA}`
        )
        .set(
          "Authorization",
          bearer(
            ownerTokenA
          )
        )
        .send({
          is_active:
            false,
        });

    assert.equal(
      response.status,
      403
    );

    const owner =
      await membership(
        fixtures.restaurantA,
        fixtures.ownerA
      );

    assert.equal(
      owner.is_active,
      true
    );
  }
);

/*
 * =====================================================
 * 14. PERMISSIONS ENDPOINT:
 * MANAGER MAY GRANT A PERMISSION THEY OWN
 *
 * Current legacy endpoint may reject the genuine manager.
 * =====================================================
 */

test(
  "PERMISSION: authorised manager can grant staff a permission the manager owns",
  async () => {
    const before =
      await membership(
        fixtures.restaurantA,
        staffAId
      );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${staffAId}/permissions`
          )
          .set(
            "Authorization",
            bearer(
              managerTokenA
            )
          )
          .send({
            overrides: [
              PERMISSIONS.USERS_VIEW,
            ],
          });

      assert.equal(
        response.status,
        200,
        `Authorised manager permission delegation rejected: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );

      const after =
        await membership(
          fixtures.restaurantA,
          staffAId
        );

      assert.deepEqual(
        parsePermissions(
          after.permissions
        ).sort(),
        [
          PERMISSIONS.USERS_VIEW,
        ].sort()
      );
    } finally {
      await resetMembershipPermissions(
        staffAId,
        parsePermissions(
          before.permissions
        )
      );
    }
  }
);

/*
 * =====================================================
 * 15. PERMISSIONS ENDPOINT:
 * MANAGER CANNOT GRANT UNOWNED PERMISSION
 * =====================================================
 */

test(
  "ATTACK: manager cannot grant permission they do not possess through permissions endpoint",
  async () => {
    const before =
      await membership(
        fixtures.restaurantA,
        staffAId
      );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${staffAId}/permissions`
          )
          .set(
            "Authorization",
            bearer(
              managerTokenA
            )
          )
          .send({
            overrides: [
              PERMISSIONS.SETTINGS_VIEW,
            ],
          });

      assert.equal(
        response.status,
        403,
        `Manager granted unowned permission: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
      await resetMembershipPermissions(
        staffAId,
        parsePermissions(
          before.permissions
        )
      );
    }
  }
);

/*
 * =====================================================
 * 16. UNKNOWN PERMISSION THROUGH OLD ENDPOINT
 * =====================================================
 */

test(
  "ATTACK: permissions endpoint rejects unknown permission strings",
  async () => {
    const before =
      await membership(
        fixtures.restaurantA,
        staffAId
      );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${staffAId}/permissions`
          )
          .set(
            "Authorization",
            bearer(
              ownerTokenA
            )
          )
          .send({
            overrides: [
              "maks.super_god_mode",
            ],
          });

      assert.ok(
        response.status >= 400,
        `Unknown permission was persisted: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
      await resetMembershipPermissions(
        staffAId,
        parsePermissions(
          before.permissions
        )
      );
    }
  }
);

/*
 * =====================================================
 * 17. OWNER-ONLY PERMISSION MUST NEVER BE DELEGATED
 * =====================================================
 */

test(
  "ATTACK: owner-only platform permission cannot be delegated to staff",
  async () => {
    const before =
      await membership(
        fixtures.restaurantA,
        staffAId
      );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${staffAId}/permissions`
          )
          .set(
            "Authorization",
            bearer(
              ownerTokenA
            )
          )
          .send({
            overrides: [
              PERMISSIONS
                .RESTAURANT_TRANSFER_OWNERSHIP,
            ],
          });

      assert.ok(
        response.status >= 400,
        `Owner-only permission was delegated: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
      await resetMembershipPermissions(
        staffAId,
        parsePermissions(
          before.permissions
        )
      );
    }
  }
);

/*
 * =====================================================
 * 18. MANAGER PIN MANAGEMENT
 *
 * Manager with users.reset_pin should be able to manage
 * ordinary staff PINs under the modern permission model.
 * =====================================================
 */

test(
  "AUTHORITY: manager with users.reset_pin can change staff PIN",
  async () => {
    const before =
      await membership(
        fixtures.restaurantA,
        staffAId
      );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${staffAId}/pin`
          )
          .set(
            "Authorization",
            bearer(
              managerTokenA
            )
          )
          .send({
            pin:
              "7319",

            pin_label:
              "Manager reset",

            can_pos_login:
              true,
          });

      assert.equal(
        response.status,
        200,
        `Authorised manager PIN reset rejected: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );

      const after =
        await membership(
          fixtures.restaurantA,
          staffAId
        );

      assert.ok(
        bcrypt.compareSync(
          "7319",
          after.pin_hash
        )
      );
    } finally {
      await query(
        `
        UPDATE public.users

        SET
          pin_hash = $1,
          pin_label = $2,
          can_pos_login = $3

        WHERE id = $4
        `,
        [
          before.pin_hash,
          before.pin_label ||
            "Test PIN",
          !!before.can_pos_login,
          staffAId,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 19. DUPLICATE ACTIVE POS PIN
 * =====================================================
 */

test(
  "ATTACK: duplicate active POS PIN cannot be assigned through standalone PIN endpoint",
  async () => {
    const a =
      await membership(
        fixtures.restaurantA,
        staffAId
      );

    const b =
      await membership(
        fixtures.restaurantA,
        staffBId
      );

    assert.ok(
      bcrypt.compareSync(
        STAFF_A_PIN,
        a.pin_hash
      )
    );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${staffBId}/pin`
          )
          .set(
            "Authorization",
            bearer(
              ownerTokenA
            )
          )
          .send({
            pin:
              STAFF_A_PIN,

            can_pos_login:
              true,
          });

      assert.ok(
        response.status >= 400,
        `Duplicate active POS PIN accepted: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
      await query(
        `
        UPDATE public.users

        SET
          pin_hash = $1,
          can_pos_login = $2

        WHERE id = $3
        `,
        [
          b.pin_hash,
          !!b.can_pos_login,
          staffBId,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 20. MANAGER CANNOT ALTER OWNER PIN
 * =====================================================
 */

test(
  "OWNER: manager cannot alter owner PIN",
  async () => {
    const before =
      await membership(
        fixtures.restaurantA,
        fixtures.ownerA
      );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${fixtures.ownerA}/pin`
          )
          .set(
            "Authorization",
            bearer(
              managerTokenA
            )
          )
          .send({
            pin:
              "7419",

            can_pos_login:
              true,
          });

      assert.equal(
        response.status,
        403
      );
    } finally {
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
          !!before.can_pos_login,
          fixtures.ownerA,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 21. MANAGER DEACTIVATES ORDINARY STAFF
 * =====================================================
 */

test(
  "AUTHORITY: manager with users.disable can deactivate ordinary staff",
  async () => {
    try {
      const response =
        await request(app)
          .patch(
            `/org/users/${staffBId}/deactivate`
          )
          .set(
            "Authorization",
            bearer(
              managerTokenA
            )
          )
          .send({
            active:
              false,
          });

      assert.equal(
        response.status,
        200,
        `Authorised manager deactivate rejected: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );

      const after =
        await membership(
          fixtures.restaurantA,
          staffBId
        );

      assert.equal(
        after.is_active,
        false
      );

      assert.equal(
        after.user_is_active,
        false
      );
    } finally {
      await query(
        `
        UPDATE public.restaurant_members

        SET is_active =
              TRUE

        WHERE restaurant_id =
              $1

          AND user_id =
              $2
        `,
        [
          fixtures.restaurantA,
          staffBId,
        ]
      );

      await query(
        `
        UPDATE public.users

        SET is_active =
              TRUE

        WHERE id =
              $1
        `,
        [
          staffBId,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 22. OWNER CANNOT DEACTIVATE SELF
 * =====================================================
 */

test(
  "OWNER: authenticated owner cannot deactivate themselves",
  async () => {
    const response =
      await request(app)
        .patch(
          `/org/users/${fixtures.ownerA}/deactivate`
        )
        .set(
          "Authorization",
          bearer(
            ownerTokenA
          )
        )
        .send({
          active:
            false,
        });

    assert.equal(
      response.status,
      400
    );

    const owner =
      await membership(
        fixtures.restaurantA,
        fixtures.ownerA
      );

    assert.equal(
      owner.is_active,
      true
    );
  }
);

/*
 * =====================================================
 * 23. MANAGER REMOVES ORDINARY STAFF
 * =====================================================
 */

test(
  "AUTHORITY: manager with users.remove can remove ordinary staff",
  async () => {
    const before =
      await membership(
        fixtures.restaurantA,
        staffBId
      );

    try {
      const response =
        await request(app)
          .patch(
            `/org/users/${staffBId}/remove`
          )
          .set(
            "Authorization",
            bearer(
              managerTokenA
            )
          )
          .send({
            disable_pos:
              true,
          });

      assert.equal(
        response.status,
        200,
        `Authorised manager remove rejected: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );

      const after =
        await membership(
          fixtures.restaurantA,
          staffBId
        );

      assert.equal(
        after.is_active,
        false
      );

      assert.equal(
        after.can_pos_login,
        false
      );

      assert.equal(
        after.pin_hash,
        null
      );
    } finally {
      await query(
        `
        UPDATE public.restaurant_members

        SET
          is_active =
            TRUE,
          status =
            'active'

        WHERE restaurant_id =
              $1

          AND user_id =
              $2
        `,
        [
          fixtures.restaurantA,
          staffBId,
        ]
      );

      await query(
        `
        UPDATE public.users

        SET
          is_active = TRUE,
          can_pos_login = $1,
          pin_hash = $2

        WHERE id = $3
        `,
        [
          !!before.can_pos_login,
          before.pin_hash,
          staffBId,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 24. OWNER CANNOT REMOVE SELF
 * =====================================================
 */

test(
  "OWNER: authenticated owner cannot remove themselves",
  async () => {
    const response =
      await request(app)
        .patch(
          `/org/users/${fixtures.ownerA}/remove`
        )
        .set(
          "Authorization",
          bearer(
            ownerTokenA
          )
        )
        .send({});

    assert.equal(
      response.status,
      400
    );
  }
);

/*
 * =====================================================
 * 25. NORMAL CROSS-TENANT USER EDIT
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot edit Restaurant B user",
  async () => {
    const before =
      await membership(
        fixtures.restaurantB,
        fixtures.ownerB
      );

    const response =
      await request(app)
        .put(
          `/org/users/${fixtures.ownerB}`
        )
        .set(
          "Authorization",
          bearer(
            ownerTokenA
          )
        )
        .send({
          full_name:
            "CROSS TENANT ATTACK",
        });

    assert.equal(
      response.status,
      404
    );

    const after =
      await membership(
        fixtures.restaurantB,
        fixtures.ownerB
      );

    assert.equal(
      after.full_name,
      before.full_name
    );
  }
);

/*
 * =====================================================
 * 26. TENANT HEADER SWITCH — PERMISSIONS
 *
 * This specifically attacks the old class of bug found
 * earlier in POS reset-pin.
 * =====================================================
 */

test(
  "TENANT: Restaurant A owner cannot switch tenant header and modify Restaurant B permissions",
  async () => {
    const before =
      await membership(
        fixtures.restaurantB,
        fixtures.ownerB
      );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${fixtures.ownerB}/permissions`
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
            overrides: [
              PERMISSIONS.USERS_VIEW,
            ],
          });

      assert.ok(
        response.status >= 400,
        `Tenant header switched permissions context: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
      await query(
        `
        UPDATE public.restaurant_members

        SET permissions =
              $1::jsonb

        WHERE restaurant_id =
              $2

          AND user_id =
              $3
        `,
        [
          JSON.stringify(
            parsePermissions(
              before.permissions
            )
          ),
          fixtures.restaurantB,
          fixtures.ownerB,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 27. TENANT HEADER SWITCH — PIN
 * =====================================================
 */

test(
  "TENANT: Restaurant A owner cannot switch tenant header and alter Restaurant B PIN",
  async () => {
    const before =
      await membership(
        fixtures.restaurantB,
        fixtures.ownerB
      );

    try {
      const response =
        await request(app)
          .put(
            `/org/users/${fixtures.ownerB}/pin`
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
            pin:
              "7519",

            can_pos_login:
              true,
          });

      assert.ok(
        response.status >= 400,
        `Tenant header switched PIN context: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
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
          !!before.can_pos_login,
          fixtures.ownerB,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 28. TENANT HEADER SWITCH — PASSWORD RESET
 * =====================================================
 */

test(
  "TENANT: Restaurant A owner cannot switch tenant header and reset Restaurant B password",
  async () => {
    const before =
      await membership(
        fixtures.restaurantB,
        fixtures.ownerB
      );

    try {
      const response =
        await request(app)
          .post(
            `/org/users/${fixtures.ownerB}/reset-password`
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
          .send({});

      assert.ok(
        response.status >= 400,
        `Tenant header switched password-reset context: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
      await query(
        `
        UPDATE public.users

        SET
          password_hash =
            $1

        WHERE id =
              $2
        `,
        [
          before.password_hash,
          fixtures.ownerB,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 29. TENANT HEADER SWITCH — DEACTIVATE
 * =====================================================
 */

test(
  "TENANT: Restaurant A owner cannot switch tenant header and deactivate Restaurant B member",
  async () => {
    const before =
      await membership(
        fixtures.restaurantB,
        fixtures.ownerB
      );

    try {
      const response =
        await request(app)
          .patch(
            `/org/users/${fixtures.ownerB}/deactivate`
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
            active:
              false,
          });

      assert.ok(
        response.status >= 400,
        `Tenant header switched deactivate context: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
      await query(
        `
        UPDATE public.restaurant_members

        SET is_active =
              $1

        WHERE restaurant_id =
              $2

          AND user_id =
              $3
        `,
        [
          !!before.is_active,
          fixtures.restaurantB,
          fixtures.ownerB,
        ]
      );

      await query(
        `
        UPDATE public.users

        SET is_active =
              $1

        WHERE id =
              $2
        `,
        [
          !!before.user_is_active,
          fixtures.ownerB,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 30. TENANT HEADER SWITCH — REMOVE
 * =====================================================
 */

test(
  "TENANT: Restaurant A owner cannot switch tenant header and remove Restaurant B member",
  async () => {
    const before =
      await membership(
        fixtures.restaurantB,
        fixtures.ownerB
      );

    try {
      const response =
        await request(app)
          .patch(
            `/org/users/${fixtures.ownerB}/remove`
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
            disable_pos:
              true,
          });

      assert.ok(
        response.status >= 400,
        `Tenant header switched removal context: ${
          response.status
        } ${JSON.stringify(
          response.body
        )}`
      );
    } finally {
      await query(
        `
        UPDATE public.restaurant_members

        SET
          is_active = $1,
          status = $2

        WHERE restaurant_id =
              $3

          AND user_id =
              $4
        `,
        [
          !!before.is_active,
          before.status ||
            "active",
          fixtures.restaurantB,
          fixtures.ownerB,
        ]
      );

      await query(
        `
        UPDATE public.users

        SET
          is_active = $1,
          can_pos_login = $2,
          pin_hash = $3

        WHERE id = $4
        `,
        [
          !!before.user_is_active,
          !!before.can_pos_login,
          before.pin_hash,
          fixtures.ownerB,
        ]
      );
    }
  }
);

/*
 * =====================================================
 * 31. FINAL: TEST STAFF NEVER ESCALATED
 * =====================================================
 */

test(
  "FINAL: test staff never gained Manager or Owner authority",
  async () => {
    const rows =
      await all(
        `
        SELECT
          user_id,
          authority,
          role

        FROM public.restaurant_members

        WHERE restaurant_id =
              $1

          AND user_id =
              ANY(
                $2::bigint[]
              )
        `,
        [
          fixtures.restaurantA,
          [
            staffEditorId,
            staffAId,
            staffBId,
          ],
        ]
      );

    for (
      const row of rows
    ) {
      assert.equal(
        row.authority,
        "staff",
        `User ${row.user_id} escalated to ${row.authority}`
      );

      assert.notEqual(
        row.role,
        "owner"
      );
    }
  }
);

/*
 * =====================================================
 * 32. FINAL: MANAGER AUTHORITY REMAINS MANAGER
 * =====================================================
 */

test(
  "FINAL: manager authority was neither promoted nor corrupted",
  async () => {
    const row =
      await membership(
        fixtures.restaurantA,
        managerId
      );

    assert.equal(
      row.authority,
      "manager"
    );

    /*
     * Legacy compatibility role intentionally remains staff.
     */
    assert.equal(
      row.role,
      "staff"
    );

    assert.deepEqual(
      parsePermissions(
        row.permissions
      ).sort(),
      [
        ...MANAGER_PERMISSIONS,
      ].sort()
    );
  }
);

/*
 * =====================================================
 * 33. FINAL: NO CROSS-TENANT TEST MEMBERSHIP
 * =====================================================
 */

test(
  "FINAL: Restaurant A test users never gained Restaurant B membership",
  async () => {
    const ids = [
      managerId,
      staffEditorId,
      staffAId,
      staffBId,
    ];

    const bad =
      await all(
        `
        SELECT
          restaurant_id,
          user_id,
          authority

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
      bad,
      []
    );
  }
);

/*
 * =====================================================
 * 34. FINAL: EVERY RESTAURANT RETAINS ACTIVE OWNER
 * =====================================================
 */

test(
  "FINAL: every seeded restaurant still has an active owner",
  async () => {
    for (
      const rid of [
        fixtures.restaurantA,
        fixtures.restaurantB,
      ]
    ) {
      const row =
        await one(
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM public.restaurant_members rm

          JOIN public.users u
            ON u.id =
                 rm.user_id

          WHERE rm.restaurant_id =
                $1

            AND rm.authority =
                'owner'

            AND rm.is_active =
                TRUE

            AND u.is_active =
                TRUE
          `,
          [
            rid,
          ]
        );

      assert.ok(
        Number(
          row?.count ||
          0
        ) >= 1,
        `Restaurant ${rid} has no active owner`
      );
    }
  }
);