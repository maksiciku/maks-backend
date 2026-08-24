"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const request =
  require("supertest");

const bcrypt =
  require("bcryptjs");

const jwt =
  require("jsonwebtoken");

const crypto =
  require("crypto");

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

let app;
let pool;
let fixtures;

let ownerTokenA;
let ownerTokenB;

let kdsTokenA;
let kdsTokenB;

let batchA;
let batchB;

let sharedGroupId;

const PIN_A =
  "4812";

const PIN_B =
  "5937";

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

function orderPayload({
  mealId,
  tableNumber,
  restaurantSideRequired = false,
}) {
  return {
    table_number:
      tableNumber,

    order_type:
      "dine-in",

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

        /*
         * Hostile display values.
         * Server pricing/identity remains authoritative.
         */
        meal_name:
          "SHARED KDS ATTACK ITEM",

        quantity:
          1,

        price_per_unit:
          0.01,

        total_price:
          0.01,

        options:
          restaurantSideRequired
            ? {
                test_side:
                  "test_chips",
              }
            : {},
      },
    ],
  };
}

async function loginOwner({
  username,
  restaurantId,
}) {
  const response =
    await request(app)
      .post(
        "/auth/login"
      )
      .send({
        username,

        password:
          TEST_PASSWORD,

        restaurant_id:
          restaurantId,
      });

  assert.equal(
    response.status,
    200,
    `Owner login failed: ${response.status} ${JSON.stringify(
      response.body
    )}`
  );

  assert.ok(
    response.body?.token
  );

  return response.body.token;
}

async function createKdsFeedToken({
  restaurantId,
  pin,
}) {
  const response =
    await request(app)
      .post(
        "/pos-auth/kds-feed-login"
      )
      .send({
        restaurant_id:
          restaurantId,

        pin,
      });

  assert.equal(
    response.status,
    200,
    `KDS feed login failed for restaurant ${restaurantId}: ${response.status} ${JSON.stringify(
      response.body
    )}`
  );

  assert.ok(
    response.body?.token
  );

  assert.equal(
    response.body?.scope,
    "kds_only"
  );

  assert.equal(
    response.body?.purpose,
    "shared_kds_printer"
  );

  return response.body.token;
}

async function createOrder({
  token,
  restaurantId,
  mealId,
  tableNumber,
  sideRequired = false,
}) {
  const before =
    await one(
      `
      SELECT
        COALESCE(
          MAX(id),
          0
        )::bigint AS max_id

      FROM public.pos_orders

      WHERE restaurant_id =
            $1
      `,
      [
        restaurantId,
      ]
    );

  const response =
    await request(app)
      .post(
        "/orders/grouped"
      )
      .set(
        "Authorization",
        bearer(token)
      )
      .send(
        orderPayload({
          mealId,
          tableNumber,

          restaurantSideRequired:
            sideRequired,
        })
      );

  assert.equal(
    response.status,
    201,
    `Unable to create KDS fixture order: ${response.status} ${JSON.stringify(
      response.body
    )}`
  );

  const row =
    await one(
      `
      SELECT
        id,
        restaurant_id,
        batch_id,
        item_name,
        table_number,
        order_status

      FROM public.pos_orders

      WHERE restaurant_id = $1
        AND id > $2

      ORDER BY id DESC

      LIMIT 1
      `,
      [
        restaurantId,

        Number(
          before?.max_id ||
          0
        ),
      ]
    );

  assert.ok(
    row,
    `No KDS order created for restaurant ${restaurantId}`
  );

  assert.ok(
    row.batch_id,
    "KDS fixture order has no batch_id"
  );

  return {
    row,

    batchId:
      String(
        row.batch_id
      ),
  };
}

async function getFeed({
  token,
  device,
  forgedTenant = null,
}) {
  let req =
    request(app)
      .get(
        "/kds/live"
      )
      .set(
        "Authorization",
        bearer(token)
      )
      .set(
        "x-kds-device",
        device
      )
      .set(
        "x-station-key",
        "meals"
      );

  if (
    forgedTenant != null
  ) {
    req =
      req.set(
        "x-tenant-rid",
        String(
          forgedTenant
        )
      );
  }

  return req;
}

function flattenBatchIds(
  response
) {
  const cards =
    Array.isArray(
      response?.body
    )
      ? response.body
      : [];

  return cards
    .map(
      (card) =>
        String(
          card?.batch_id ||
          card?.id ||
          ""
        )
    )
    .filter(Boolean);
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
      "SHARED KDS ATTACK REFUSED: database is not maks_test"
    );

    pool =
      safe.pool;

    /*
     * Keep this suite focused on KDS isolation rather than
     * stock availability.
     */
    await query(
      `
      UPDATE public.restaurants

      SET
        selling_mode =
          'pos_only',

        stock_deduction_enabled =
          FALSE,

        portion_tracking_mode =
          'off',

        hold_qr_kiosk_until_paid =
          TRUE

      WHERE id IN (
        $1,
        $2
      )
      `,
      [
        fixtures.restaurantA,
        fixtures.restaurantB,
      ]
    );

    /*
     * Give each seeded owner a deterministic manager PIN.
     *
     * Feed-login still checks authoritative membership
     * authority + KDS permission.
     */
    const pinHashA =
      bcrypt.hashSync(
        PIN_A,
        10
      );

    const pinHashB =
      bcrypt.hashSync(
        PIN_B,
        10
      );

    await query(
      `
      UPDATE public.users

      SET
        pin_hash =
          CASE
            WHEN id = $1
              THEN $3
            WHEN id = $2
              THEN $4
            ELSE pin_hash
          END,

        can_pos_login =
          TRUE,

        is_active =
          TRUE

      WHERE id IN (
        $1,
        $2
      )
      `,
      [
        fixtures.ownerA,
        fixtures.ownerB,
        pinHashA,
        pinHashB,
      ]
    );

    /*
     * Explicit authoritative owner state.
     */
    await query(
      `
      UPDATE public.restaurant_members

      SET
        authority =
          'owner',

        is_active =
          TRUE,

        permissions =
          '[
            "kds.view",
            "kds.accept",
            "kds.complete",
            "kds.restore",
            "kds.priority",
            "kds.pause"
          ]'::jsonb

      WHERE
        (
          restaurant_id = $1
          AND user_id = $3
        )
        OR
        (
          restaurant_id = $2
          AND user_id = $4
        )
      `,
      [
        fixtures.restaurantA,
        fixtures.restaurantB,
        fixtures.ownerA,
        fixtures.ownerB,
      ]
    );

    /*
     * Create an intentional shared-KDS configuration.
     *
     * Runtime feeds are still tenant-bound individually.
     */
    const group =
      await one(
        `
        INSERT INTO public.shared_kds_groups
        (
          name,
          device_key,
          active
        )

        VALUES
        (
          $1,
          $2,
          TRUE
        )

        RETURNING id
        `,
        [
          "MAKS SHARED KDS ATTACK GROUP",

          `attack-device-${crypto.randomUUID()}`,
        ]
      );

    assert.ok(
      group?.id
    );

    sharedGroupId =
      Number(
        group.id
      );

    await query(
      `
      INSERT INTO public.shared_kds_group_members
      (
        group_id,
        restaurant_id,
        label,
        active
      )

      VALUES
        (
          $1,
          $2,
          'Restaurant A',
          TRUE
        ),
        (
          $1,
          $3,
          'Restaurant B',
          TRUE
        )
      `,
      [
        sharedGroupId,
        fixtures.restaurantA,
        fixtures.restaurantB,
      ]
    );

    ({ app } =
      require("../../server"));

    assert.ok(app);

    ownerTokenA =
      await loginOwner({
        username:
          "maks_test_owner_a",

        restaurantId:
          fixtures.restaurantA,
      });

    ownerTokenB =
      await loginOwner({
        username:
          "maks_test_owner_b",

        restaurantId:
          fixtures.restaurantB,
      });

    /*
     * Create one real KDS order in each restaurant.
     */
    const createdA =
      await createOrder({
        token:
          ownerTokenA,

        restaurantId:
          fixtures.restaurantA,

        mealId:
          fixtures.mealA,

        tableNumber:
          "KDS-A",

        sideRequired:
          true,
      });

    batchA =
      createdA.batchId;

    const createdB =
      await createOrder({
        token:
          ownerTokenB,

        restaurantId:
          fixtures.restaurantB,

        mealId:
          fixtures.mealB,

        tableNumber:
          "KDS-B",

        sideRequired:
          false,
      });

    batchB =
      createdB.batchId;
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
 * 1. GROUP CONFIGURATION
 * =====================================================
 */

test(
  "SHARED KDS: group intentionally contains Restaurant A and Restaurant B",
  async () => {
    const members =
      await all(
        `
        SELECT
          restaurant_id,
          active

        FROM public.shared_kds_group_members

        WHERE group_id = $1

        ORDER BY
          restaurant_id ASC
        `,
        [
          sharedGroupId,
        ]
      );

    assert.deepEqual(
      members.map(
        (row) =>
          Number(
            row.restaurant_id
          )
      ),

      [
        fixtures.restaurantA,
        fixtures.restaurantB,
      ].sort(
        (a, b) =>
          a - b
      )
    );

    assert.equal(
      members.every(
        (row) =>
          row.active ===
          true
      ),
      true
    );
  }
);

/*
 * =====================================================
 * 2. RESTAURANT A FEED TOKEN
 * =====================================================
 */

test(
  "KDS AUTHORITY: Restaurant A owner can create restricted feed token",
  async () => {
    kdsTokenA =
      await createKdsFeedToken({
        restaurantId:
          fixtures.restaurantA,

        pin:
          PIN_A,
      });

    const payload =
      jwt.decode(
        kdsTokenA
      );

    assert.equal(
      Number(
        payload.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      payload.role,
      "chef"
    );

    assert.equal(
      payload.scope,
      "kds_only"
    );

    assert.equal(
      payload.purpose,
      "shared_kds_printer"
    );

    /*
     * Device token must not inherit owner authority.
     */
    assert.equal(
      payload.authority,
      undefined
    );

    assert.equal(
      payload.permissions,
      undefined
    );
  }
);

/*
 * =====================================================
 * 3. RESTAURANT B FEED TOKEN
 * =====================================================
 */

test(
  "KDS AUTHORITY: Restaurant B owner can create independent restricted feed token",
  async () => {
    kdsTokenB =
      await createKdsFeedToken({
        restaurantId:
          fixtures.restaurantB,

        pin:
          PIN_B,
      });

    const payload =
      jwt.decode(
        kdsTokenB
      );

    assert.equal(
      Number(
        payload.restaurant_id
      ),
      fixtures.restaurantB
    );

    assert.equal(
      payload.scope,
      "kds_only"
    );

    assert.equal(
      payload.purpose,
      "shared_kds_printer"
    );
  }
);

/*
 * =====================================================
 * 4. TOKEN A SEES A
 * =====================================================
 */

test(
  "TENANT: Restaurant A KDS token sees Restaurant A batch",
  async () => {
    const response =
      await getFeed({
        token:
          kdsTokenA,

        device:
          "shared-screen-a",
      });

    assert.equal(
      response.status,
      200,
      JSON.stringify(
        response.body
      )
    );

    const ids =
      flattenBatchIds(
        response
      );

    assert.equal(
      ids.includes(
        batchA
      ),
      true,
      `Restaurant A batch ${batchA} missing from A feed`
    );
  }
);

/*
 * =====================================================
 * 5. TOKEN A CANNOT SEE B
 * =====================================================
 */

test(
  "TENANT: Restaurant A KDS token never receives Restaurant B batch",
  async () => {
    const response =
      await getFeed({
        token:
          kdsTokenA,

        device:
          "shared-screen-a-isolation",
      });

    assert.equal(
      response.status,
      200
    );

    const ids =
      flattenBatchIds(
        response
      );

    assert.equal(
      ids.includes(
        batchB
      ),
      false,
      "Restaurant B batch leaked into Restaurant A feed"
    );
  }
);

/*
 * =====================================================
 * 6. TOKEN B SEES B
 * =====================================================
 */

test(
  "TENANT: Restaurant B KDS token sees Restaurant B batch",
  async () => {
    const response =
      await getFeed({
        token:
          kdsTokenB,

        device:
          "shared-screen-b",
      });

    assert.equal(
      response.status,
      200,
      JSON.stringify(
        response.body
      )
    );

    const ids =
      flattenBatchIds(
        response
      );

    assert.equal(
      ids.includes(
        batchB
      ),
      true,
      `Restaurant B batch ${batchB} missing from B feed`
    );
  }
);

/*
 * =====================================================
 * 7. TOKEN B CANNOT SEE A
 * =====================================================
 */

test(
  "TENANT: Restaurant B KDS token never receives Restaurant A batch",
  async () => {
    const response =
      await getFeed({
        token:
          kdsTokenB,

        device:
          "shared-screen-b-isolation",
      });

    assert.equal(
      response.status,
      200
    );

    const ids =
      flattenBatchIds(
        response
      );

    assert.equal(
      ids.includes(
        batchA
      ),
      false,
      "Restaurant A batch leaked into Restaurant B feed"
    );
  }
);

/*
 * =====================================================
 * 8. FORGED TENANT HEADER
 * =====================================================
 */

test(
  "ATTACK: x-tenant-rid cannot switch Restaurant A KDS token into Restaurant B",
  async () => {
    const response =
      await getFeed({
        token:
          kdsTokenA,

        device:
          "forged-tenant-device",

        forgedTenant:
          fixtures.restaurantB,
      });

    /*
     * Either behavior is secure:
     *
     * 1. backend ignores forged header and serves A only; or
     * 2. backend detects mismatch and rejects the request.
     *
     * What must NEVER happen is a successful Restaurant B feed.
     */

    if (response.status === 200) {
      const ids =
        flattenBatchIds(
          response
        );

      assert.equal(
        ids.includes(
          batchA
        ),
        true
      );

      assert.equal(
        ids.includes(
          batchB
        ),
        false,
        "Forged x-tenant-rid switched KDS tenant"
      );

      return;
    }

    assert.ok(
      response.status === 401 ||
        response.status === 403,
      `Unexpected forged-tenant response: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 9. SHARED SCREEN MERGE
 * =====================================================
 *
 * This models what the UI should do:
 *
 *   feed A + feed B -> one visible KDS board
 *
 * Backend never creates a super-tenant token.
 * =====================================================
 */

test(
  "SHARED KDS: two isolated feeds can be merged visually without merging tenant authority",
  async () => {
    const [
      responseA,
      responseB,
    ] =
      await Promise.all([
        getFeed({
          token:
            kdsTokenA,

          device:
            "merged-screen-a",
        }),

        getFeed({
          token:
            kdsTokenB,

          device:
            "merged-screen-b",
        }),
      ]);

    assert.equal(
      responseA.status,
      200
    );

    assert.equal(
      responseB.status,
      200
    );

    const feedA =
      Array.isArray(
        responseA.body
      )
        ? responseA.body
        : [];

    const feedB =
      Array.isArray(
        responseB.body
      )
        ? responseB.body
        : [];

    const merged =
      [
        ...feedA.map(
          (card) => ({
            ...card,

            __restaurant_id:
              fixtures.restaurantA,
          })
        ),

        ...feedB.map(
          (card) => ({
            ...card,

            __restaurant_id:
              fixtures.restaurantB,
          })
        ),
      ];

    const ids =
      merged.map(
        (card) =>
          String(
            card.batch_id ||
            card.id ||
            ""
          )
      );

    assert.equal(
      ids.includes(
        batchA
      ),
      true
    );

    assert.equal(
      ids.includes(
        batchB
      ),
      true
    );

    /*
     * Each merged card retains explicit source restaurant.
     */
    const aCard =
      merged.find(
        (card) =>
          String(
            card.batch_id ||
            card.id
          ) ===
          batchA
      );

    const bCard =
      merged.find(
        (card) =>
          String(
            card.batch_id ||
            card.id
          ) ===
          batchB
      );

    assert.equal(
      Number(
        aCard
          ?.__restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      Number(
        bCard
          ?.__restaurant_id
      ),
      fixtures.restaurantB
    );
  }
);

/*
 * =====================================================
 * 10. FOREIGN ACK
 * =====================================================
 */

test(
  "TENANT: Restaurant A KDS token cannot ACK Restaurant B batch",
  async () => {
    const response =
      await request(app)
        .post(
          `/kds/live/${batchB}/ack`
        )
        .set(
          "Authorization",
          bearer(
            kdsTokenA
          )
        )
        .set(
          "x-kds-device",
          "attack-ack-a"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({});

    assert.ok(
      response.status >=
        400,
      `Foreign batch ACK succeeded: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );

    const foreignAck =
      await one(
        `
        SELECT 1

        FROM public.kds_station_ack

        WHERE restaurant_id = $1
          AND batch_id = $2::uuid

        LIMIT 1
        `,
        [
          fixtures.restaurantA,
          batchB,
        ]
      );

    assert.equal(
      foreignAck,
      null,
      "Restaurant A created ACK state for Restaurant B batch"
    );
  }
);

/*
 * =====================================================
 * 11. OWN ACK
 * =====================================================
 */

test(
  "KDS FUNCTION: Restaurant A KDS token can ACK its own batch",
  async () => {
    const response =
      await request(app)
        .post(
          `/kds/live/${batchA}/ack`
        )
        .set(
          "Authorization",
          bearer(
            kdsTokenA
          )
        )
        .set(
          "x-kds-device",
          "own-ack-a"
        )
        .set(
          "x-station-key",
          "meals"
        )
        .send({});

    assert.ok(
      response.status >=
        200 &&
      response.status <
        300,
      `Own KDS ACK failed: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 12. KDS TOKEN CANNOT ENTER POS
 * =====================================================
 */

test(
  "SCOPE: KDS-only token cannot access POS order history",
  async () => {
    const response =
      await request(app)
        .get(
          "/orders/"
        )
        .set(
          "Authorization",
          bearer(
            kdsTokenA
          )
        );

    assert.ok(
      response.status ===
        401 ||
      response.status ===
        403,
      `KDS token escaped into POS: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 13. KDS TOKEN CANNOT ACCESS PAYMENTS
 * =====================================================
 */

test(
  "SCOPE: KDS-only token cannot read payment history",
  async () => {
    const response =
      await request(app)
        .get(
          "/orders/payments"
        )
        .set(
          "Authorization",
          bearer(
            kdsTokenA
          )
        );

    assert.ok(
      response.status ===
        401 ||
      response.status ===
        403,
      `KDS token escaped into payments: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 14. KDS TOKEN CANNOT ACCESS STOCK
 * =====================================================
 */

test(
  "SCOPE: KDS-only token cannot read stock management",
  async () => {
    const response =
      await request(app)
        .get(
          "/stock/"
        )
        .set(
          "Authorization",
          bearer(
            kdsTokenA
          )
        );

    assert.ok(
      response.status ===
        401 ||
      response.status ===
        403,
      `KDS token escaped into stock: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 15. KDS TOKEN CANNOT ACCESS STAFF
 * =====================================================
 */

test(
  "SCOPE: KDS-only token cannot list organisation users",
  async () => {
    const response =
      await request(app)
        .get(
          "/org/users"
        )
        .set(
          "Authorization",
          bearer(
            kdsTokenA
          )
        );

    assert.ok(
      response.status ===
        401 ||
      response.status ===
        403,
      `KDS token escaped into staff administration: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 16. KDS TOKEN CANNOT ACCESS SETTINGS
 * =====================================================
 */

test(
  "SCOPE: KDS-only token cannot read organisation settings",
  async () => {
    const response =
      await request(app)
        .get(
          "/org/settings"
        )
        .set(
          "Authorization",
          bearer(
            kdsTokenA
          )
        );

    assert.ok(
      response.status ===
        401 ||
      response.status ===
        403,
      `KDS token escaped into organisation settings: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 17. KDS TOKEN CANNOT ACCESS BOOKINGS
 * =====================================================
 */

test(
  "SCOPE: KDS-only token cannot read private bookings",
  async () => {
    const response =
      await request(app)
        .get(
          "/bookings/"
        )
        .set(
          "Authorization",
          bearer(
            kdsTokenA
          )
        );

    assert.ok(
      response.status ===
        401 ||
      response.status ===
        403,
      `KDS token escaped into bookings: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 18. EXISTING TOKEN REVOKED BY MEMBERSHIP DISABLE
 * =====================================================
 */

test(
  "REVOCATION: disabling Restaurant A membership immediately kills existing KDS token",
  async () => {
    await query(
      `
      UPDATE public.restaurant_members

      SET is_active =
            FALSE

      WHERE restaurant_id =
            $1

        AND user_id =
            $2
      `,
      [
        fixtures.restaurantA,
        fixtures.ownerA,
      ]
    );

    const response =
      await getFeed({
        token:
          kdsTokenA,

        device:
          "revoked-membership",
      });

    assert.equal(
      response.status,
      403,
      `Disabled membership still used KDS token: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );

    /*
     * Restore for remaining tests.
     */
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
        fixtures.ownerA,
      ]
    );
  }
);

/*
 * =====================================================
 * 19. CROSS-TENANT PIN
 * =====================================================
 */

test(
  "TENANT: Restaurant A PIN cannot create Restaurant B KDS feed",
  async () => {
    const response =
      await request(app)
        .post(
          "/pos-auth/kds-feed-login"
        )
        .send({
          restaurant_id:
            fixtures.restaurantB,

          pin:
            PIN_A,
        });

    assert.ok(
      response.status ===
        401 ||
      response.status ===
        403,
      `Restaurant A PIN created Restaurant B feed: ${response.status} ${JSON.stringify(
        response.body
      )}`
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
 * 20. LEGACY BUSINESS LOGIN
 * =====================================================
 */

test(
  "LEGACY: old KDS business-login endpoint remains disabled",
  async () => {
    const response =
      await request(app)
        .post(
          "/pos-auth/kds-business-login"
        )
        .send({
          restaurant_id:
            fixtures.restaurantA,
        });

    assert.equal(
      response.status,
      410
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
 * 21. DATABASE TENANT INVARIANT
 * =====================================================
 */

test(
  "FINAL: KDS ACK state never crosses restaurant ownership",
  async () => {
    const bad =
      await all(
        `
        SELECT
          a.restaurant_id,
          a.batch_id

        FROM public.kds_station_ack a

        LEFT JOIN public.order_batches ob
          ON ob.id =
             a.batch_id

        WHERE ob.id IS NOT NULL

          AND ob.restaurant_id <>
              a.restaurant_id
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
 * 22. SHARED GROUP INVARIANT
 * =====================================================
 */

test(
  "FINAL: shared KDS group contains each restaurant at most once",
  async () => {
    const bad =
      await all(
        `
        SELECT
          group_id,
          restaurant_id,
          COUNT(*)::int AS count

        FROM public.shared_kds_group_members

        GROUP BY
          group_id,
          restaurant_id

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
 * 23. FINAL TOKEN ISOLATION
 * =====================================================
 */

test(
  "FINAL: shared KDS uses two tenant tokens rather than one cross-tenant super-token",
  async () => {
    const a =
      jwt.decode(
        kdsTokenA
      );

    const b =
      jwt.decode(
        kdsTokenB
      );

    assert.equal(
      Number(
        a.restaurant_id
      ),
      fixtures.restaurantA
    );

    assert.equal(
      Number(
        b.restaurant_id
      ),
      fixtures.restaurantB
    );

    assert.notEqual(
      Number(
        a.restaurant_id
      ),
      Number(
        b.restaurant_id
      )
    );

    assert.equal(
      a.scope,
      "kds_only"
    );

    assert.equal(
      b.scope,
      "kds_only"
    );

    /*
     * There must be no claim granting either token
     * access to the other restaurant.
     */
    assert.equal(
      a.restaurant_ids,
      undefined
    );

    assert.equal(
      b.restaurant_ids,
      undefined
    );

    assert.equal(
      a.group_id,
      undefined
    );

    assert.equal(
      b.group_id,
      undefined
    );
  }
);