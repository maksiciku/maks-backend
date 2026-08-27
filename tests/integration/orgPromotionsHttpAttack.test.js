"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const request =
  require("supertest");

const {
  resetTestData,
} = require(
  "../setup/resetTestData"
);

const {
  seedTestData,
  TEST_PASSWORD,
} = require(
  "../setup/seedTestData"
);

const {
  assertTestDatabase,
} = require(
  "../safety/assertTestDatabase"
);

const {
  runCanonicalCommercialPricingPg,
} = require(
  "../../migrations/canonicalCommercialPricing.pg"
);


let app;
let pool;
let fixtures;

let ownerTokenA;
let ownerTokenB;

let promotionAId;
let promotionBId;

let validMealId;
let validCategoryId;

const originalRuntimeRole =
  process.env.MAKS_RUNTIME_ROLE;


function bearer(token) {
  return `Bearer ${token}`;
}


function is2xx(status) {
  return (
    status >= 200 &&
    status < 300
  );
}


function dateOnly(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (
    value instanceof Date
  ) {
    const year =
      value.getFullYear();

    const month =
      String(
        value.getMonth() + 1
      ).padStart(
        2,
        "0"
      );

    const day =
      String(
        value.getDate()
      ).padStart(
        2,
        "0"
      );

    return `${year}-${month}-${day}`;
  }

  const text =
    String(value);

  if (
    /^\d{4}-\d{2}-\d{2}/.test(
      text
    )
  ) {
    return text.slice(
      0,
      10
    );
  }

  const parsed =
    new Date(value);

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return text;
  }

  return parsed
    .toISOString()
    .slice(0, 10);
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


async function promotionRow(id) {
  return one(
    `
    SELECT *
    FROM
      public.restaurant_promotions
    WHERE
      id = $1
    `,
    [
      Number(id),
    ]
  );
}


async function promotionRevision(
  restaurantId
) {
  return one(
    `
    SELECT
      produced_revision,
      applied_revision,
      applied_payload_hash
    FROM
      public.edge_domain_revisions
    WHERE
      restaurant_id = $1
      AND domain = 'promotions'
    `,
    [
      Number(restaurantId),
    ]
  );
}


async function promotionOutboxRows(
  restaurantId
) {
  const result =
    await query(
      `
      SELECT
        event_id,
        event_type,
        idempotency_key,
        payload,
        payload_hash,
        status
      FROM
        public.edge_outbox
      WHERE
        restaurant_id = $1
        AND event_type =
          'promotions.replaced.v1'
      ORDER BY
        id ASC
      `,
      [
        Number(restaurantId),
      ]
    );

  return result.rows || [];
}


function multipartPut(
  token,
  id,
  fields
) {
  let req =
    request(app)
      .put(
        `/org/promotions/${id}`
      )
      .set(
        "Authorization",
        bearer(token)
      );

  for (
    const [
      key,
      value,
    ] of Object.entries(
      fields
    )
  ) {
    if (
      value === undefined
    ) {
      continue;
    }

    if (
      Array.isArray(value)
    ) {
      req =
        req.field(
          key,
          JSON.stringify(value)
        );

      continue;
    }

    if (
      value === null
    ) {
      req =
        req.field(
          key,
          ""
        );

      continue;
    }

    req =
      req.field(
        key,
        String(value)
      );
  }

  return req;
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
      "PROMOTION HTTP ATTACK REFUSED: wrong database"
    );

    pool =
      safe.pool;

    await runCanonicalCommercialPricingPg({
      pool,
    });

    process.env.MAKS_RUNTIME_ROLE =
      "cloud";

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

    assert.ok(ownerTokenA);
    assert.ok(ownerTokenB);

    const meal =
      await one(
        `
        SELECT id
        FROM public.meals
        WHERE restaurant_id = $1
        ORDER BY id ASC
        LIMIT 1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    const category =
      await one(
        `
        SELECT id
        FROM public.categories
        WHERE restaurant_id = $1
        ORDER BY id ASC
        LIMIT 1
        `,
        [
          fixtures.restaurantA,
        ]
      );

    assert.ok(
      meal?.id,
      "Seeded Restaurant A meal missing"
    );

    assert.ok(
      category?.id,
      "Seeded Restaurant A category missing"
    );

    validMealId =
      Number(meal.id);

    validCategoryId =
      Number(category.id);

    const a =
      await one(
        `
        INSERT INTO
          public.restaurant_promotions
        (
          restaurant_id,
          title,
          description,
          active,
          created_at,
          updated_at
        )
        VALUES
        (
          $1,
          $2,
          'before-http-update',
          TRUE,
          NOW(),
          NOW()
        )
        RETURNING id
        `,
        [
          fixtures.restaurantA,
          "HTTP PROMOTION A",
        ]
      );

    const b =
      await one(
        `
        INSERT INTO
          public.restaurant_promotions
        (
          restaurant_id,
          title,
          description,
          active,
          created_at,
          updated_at
        )
        VALUES
        (
          $1,
          $2,
          'tenant-b-must-remain',
          TRUE,
          NOW(),
          NOW()
        )
        RETURNING id
        `,
        [
          fixtures.restaurantB,
          "HTTP PROMOTION B",
        ]
      );

    promotionAId =
      Number(a.id);

    promotionBId =
      Number(b.id);

    console.log(
      "✅ 01 Real /org HTTP harness authenticated against maks_test"
    );
  }
);


test.after(
  async () => {
    if (
      originalRuntimeRole ===
        undefined
    ) {
      delete process.env
        .MAKS_RUNTIME_ROLE;
    } else {
      process.env.MAKS_RUNTIME_ROLE =
        originalRuntimeRole;
    }

    try {
      await resetTestData();
    } finally {
      if (
        pool &&
        typeof pool.end ===
          "function"
      ) {
        await pool.end();
      }
    }

    console.log(
      "✅ 06 Cleanup proven"
    );
  }
);


test(
  "real PUT /org/promotions/:id persists every modern promotion field and emits one snapshot",
  async () => {
    process.env.MAKS_RUNTIME_ROLE =
      "cloud";

    const beforeRevision =
      await promotionRevision(
        fixtures.restaurantA
      );

    assert.equal(
      beforeRevision,
      null
    );

    const beforeOutbox =
      await promotionOutboxRows(
        fixtures.restaurantA
      );

    assert.equal(
      beforeOutbox.length,
      0
    );

    const fields = {
      title:
        "HTTP MODERN PROMOTION",

      description:
        "Full modern promotion edit",

      image_url:
        `/uploads/${fixtures.restaurantA}/promotions/http-modern.jpg`,

      active:
        false,

      show_on_qr:
        true,

      show_on_kiosk:
        false,

      show_on_eat_in:
        false,

      show_on_takeaway:
        true,

      show_for_dine_in:
        true,

      show_for_takeaway:
        false,

      promotion_type:
        "booking_event",

      button_text:
        "Reserve Now",

      button_action:
        "category",

      action_type:
        "url",

      action_target:
        "https://example.invalid/promotion",

      linked_category_id:
        validCategoryId,

      linked_item_id:
        validMealId,

      linked_item_type:
        "item",

      start_at:
        "2026-09-01T10:00:00.000Z",

      end_at:
        "2026-09-30T22:00:00.000Z",

      start_date:
        "2026-09-01",

      end_date:
        "2026-09-30",

      start_time:
        "10:30",

      end_time:
        "22:15",

      meal_period:
        "dinner",

      days_of_week: [
        "tue",
        "thu",
        "sat",
      ],

      priority:
        87,

      sort_order:
        6,

      event_date:
        "2026-09-20",

      event_time:
        "18:45",

      event_end_time:
        "21:15",
    };

    const res =
      await multipartPut(
        ownerTokenA,
        promotionAId,
        fields
      );

    assert.equal(
      res.status,
      200,
      JSON.stringify(
        res.body
      )
    );

    assert.equal(
      res.body?.title,
      fields.title
    );

    const row =
      await promotionRow(
        promotionAId
      );

    assert.ok(row);

    assert.equal(
      Number(
        row.restaurant_id
      ),
      Number(
        fixtures.restaurantA
      )
    );

    assert.equal(
      row.title,
      fields.title
    );

    assert.equal(
      row.description,
      fields.description
    );

    assert.equal(
      row.image_url,
      fields.image_url
    );

    assert.equal(
      row.active,
      false
    );

    assert.equal(
      row.show_on_qr,
      true
    );

    assert.equal(
      row.show_on_kiosk,
      false
    );

    assert.equal(
      row.show_on_eat_in,
      false
    );

    assert.equal(
      row.show_on_takeaway,
      true
    );

    assert.equal(
      row.show_for_dine_in,
      true
    );

    assert.equal(
      row.show_for_takeaway,
      false
    );

    assert.equal(
      row.display_context,
      "qr"
    );

    assert.equal(
      row.order_type,
      "dine-in"
    );

    assert.equal(
      row.promotion_type,
      fields.promotion_type
    );

    assert.equal(
      row.button_text,
      fields.button_text
    );

    assert.equal(
      row.button_action,
      fields.button_action
    );

    assert.equal(
      row.action_type,
      fields.action_type
    );

    assert.equal(
      row.action_target,
      fields.action_target
    );

    assert.equal(
      Number(
        row.linked_category_id
      ),
      validCategoryId
    );

    assert.equal(
      Number(
        row.linked_item_id
      ),
      validMealId
    );

    assert.equal(
      row.linked_item_type,
      "item"
    );

    assert.equal(
      new Date(
        row.start_at
      ).toISOString(),
      fields.start_at
    );

    assert.equal(
      new Date(
        row.end_at
      ).toISOString(),
      fields.end_at
    );

    assert.equal(
      dateOnly(
        row.start_date
      ),
      fields.start_date
    );

    assert.equal(
      dateOnly(
        row.end_date
      ),
      fields.end_date
    );

    assert.equal(
      String(
        row.start_time
      ).slice(
        0,
        5
      ),
      fields.start_time
    );

    assert.equal(
      String(
        row.end_time
      ).slice(
        0,
        5
      ),
      fields.end_time
    );

    assert.equal(
      row.meal_period,
      fields.meal_period
    );

    assert.deepEqual(
      row.days_of_week,
      fields.days_of_week
    );

    assert.equal(
      Number(
        row.priority
      ),
      fields.priority
    );

    assert.equal(
      Number(
        row.sort_order
      ),
      fields.sort_order
    );

    assert.equal(
      dateOnly(
        row.event_date
      ),
      fields.event_date
    );

    assert.equal(
      String(
        row.event_time
      ).slice(
        0,
        5
      ),
      fields.event_time
    );

    assert.equal(
      String(
        row.event_end_time
      ).slice(
        0,
        5
      ),
      fields.event_end_time
    );

    const revision =
      await promotionRevision(
        fixtures.restaurantA
      );

    assert.equal(
      Number(
        revision
          ?.produced_revision
      ),
      1
    );

    const outbox =
      await promotionOutboxRows(
        fixtures.restaurantA
      );

    assert.equal(
      outbox.length,
      1
    );

    assert.equal(
      outbox[0]
        .event_type,
      "promotions.replaced.v1"
    );

    assert.equal(
      outbox[0]
        .idempotency_key,
      "promotions.replaced.v1:1"
    );

    assert.equal(
      outbox[0]
        .payload
        ?.revision,
      1
    );

    const snap =
      outbox[0]
        .payload
        ?.promotions
        ?.find(
          (promotion) =>
            Number(
              promotion.id
            ) === promotionAId
        );

    assert.ok(
      snap,
      "Edited promotion missing from emitted snapshot"
    );

    assert.equal(
      snap.title,
      fields.title
    );

    assert.equal(
      snap.show_on_kiosk,
      false
    );

    assert.equal(
      snap.promotion_type,
      fields.promotion_type
    );

    assert.equal(
      snap.button_action,
      fields.button_action
    );

    assert.deepEqual(
      snap.days_of_week,
      fields.days_of_week
    );

    assert.equal(
      Number(
        snap.priority
      ),
      fields.priority
    );

    console.log(
      "✅ 02 Real HTTP modern promotion edit + revision + outbox proven"
    );
  }
);


test(
  "Restaurant A cannot edit Restaurant B promotion",
  async () => {
    process.env.MAKS_RUNTIME_ROLE =
      "cloud";

    const before =
      await promotionRow(
        promotionBId
      );

    const beforeRevision =
      await promotionRevision(
        fixtures.restaurantA
      );

    const beforeAOutbox =
      await promotionOutboxRows(
        fixtures.restaurantA
      );

    const beforeBOutbox =
      await promotionOutboxRows(
        fixtures.restaurantB
      );

    const res =
      await multipartPut(
        ownerTokenA,
        promotionBId,
        {
          title:
            "CROSS TENANT ATTACK",
        }
      );

    assert.equal(
      res.status,
      404
    );

    const after =
      await promotionRow(
        promotionBId
      );

    assert.equal(
      after.title,
      before.title
    );

    assert.equal(
      after.description,
      before.description
    );

    assert.equal(
      Number(
        after.restaurant_id
      ),
      Number(
        fixtures.restaurantB
      )
    );

    const afterRevision =
      await promotionRevision(
        fixtures.restaurantA
      );

    assert.equal(
      Number(
        afterRevision
          ?.produced_revision
      ),
      Number(
        beforeRevision
          ?.produced_revision
      )
    );

    assert.equal(
      (
        await promotionOutboxRows(
          fixtures.restaurantA
        )
      ).length,
      beforeAOutbox.length
    );

    assert.equal(
      (
        await promotionOutboxRows(
          fixtures.restaurantB
        )
      ).length,
      beforeBOutbox.length
    );

    console.log(
      "✅ 03 Cross-tenant promotion HTTP edit blocked"
    );
  }
);


test(
  "Edge runtime rejects promotion authoring before any mutation",
  async () => {
    const before =
      await promotionRow(
        promotionAId
      );

    const beforeRevision =
      await promotionRevision(
        fixtures.restaurantA
      );

    const beforeOutbox =
      await promotionOutboxRows(
        fixtures.restaurantA
      );

    process.env.MAKS_RUNTIME_ROLE =
      "edge";

    const res =
      await multipartPut(
        ownerTokenA,
        promotionAId,
        {
          title:
            "EDGE MUST NOT AUTHOR",
          priority:
            999,
        }
      );

    assert.equal(
      res.status,
      409,
      JSON.stringify(
        res.body
      )
    );

    const after =
      await promotionRow(
        promotionAId
      );

    assert.equal(
      after.title,
      before.title
    );

    assert.equal(
      Number(
        after.priority
      ),
      Number(
        before.priority
      )
    );

    const afterRevision =
      await promotionRevision(
        fixtures.restaurantA
      );

    assert.equal(
      Number(
        afterRevision
          ?.produced_revision
      ),
      Number(
        beforeRevision
          ?.produced_revision
      )
    );

    assert.equal(
      (
        await promotionOutboxRows(
          fixtures.restaurantA
        )
      ).length,
      beforeOutbox.length
    );

    console.log(
      "✅ 04 Edge HTTP promotion authoring fails closed"
    );
  }
);


test(
  "Restaurant B owner still has independent promotion authority",
  async () => {
    process.env.MAKS_RUNTIME_ROLE =
      "cloud";

    const res =
      await multipartPut(
        ownerTokenB,
        promotionBId,
        {
          title:
            "B INDEPENDENT UPDATE",

          priority:
            33,

          days_of_week: [
            "wed",
          ],
        }
      );

    assert.equal(
      res.status,
      200,
      JSON.stringify(
        res.body
      )
    );

    const row =
      await promotionRow(
        promotionBId
      );

    assert.equal(
      row.title,
      "B INDEPENDENT UPDATE"
    );

    assert.equal(
      Number(
        row.restaurant_id
      ),
      Number(
        fixtures.restaurantB
      )
    );

    assert.equal(
      Number(
        row.priority
      ),
      33
    );

    assert.deepEqual(
      row.days_of_week,
      [
        "wed",
      ]
    );

    const revision =
      await promotionRevision(
        fixtures.restaurantB
      );

    assert.equal(
      Number(
        revision
          ?.produced_revision
      ),
      1
    );

    const outbox =
      await promotionOutboxRows(
        fixtures.restaurantB
      );

    assert.equal(
      outbox.length,
      1
    );

    console.log(
      "✅ 05 Independent Restaurant B authority preserved"
    );
  }
);
