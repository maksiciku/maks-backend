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
let stockCreatorTokenA;
let stockAdjusterTokenA;
let stockEditorTokenA;
let stockViewerTokenA;
let stockCostViewerTokenA;
let supplierViewerTokenA;
let supplierManagerTokenA;
let supplierPriceTokenA;

const USER_PASSWORD =
  "MAKS-STOCK-SUPPLIER-TEST-123!";

const P = Object.freeze({
  STOCK_VIEW:
    "stock.view",

  STOCK_CREATE:
    "stock.create",

  STOCK_EDIT:
    "stock.edit",

  STOCK_ADJUST:
    "stock.adjust",

  STOCK_DELETE:
    "stock.delete",

  STOCK_VIEW_COST:
    "stock.view_cost",

  SUPPLIERS_VIEW:
    "suppliers.view",

  SUPPLIERS_MANAGE:
    "suppliers.manage",

  SUPPLIERS_PRICES:
    "suppliers.prices",
});

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

  assert.ok(user?.id);

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

async function createStock({
  token = ownerTokenA,
  ingredient,
  quantity = 10,
  price = 2.5,
  supplierId,
} = {}) {
  const body = {
    ingredient,
    quantity,
    unit:
      "kg",
    price,
    type:
      "ingredient",
  };

  if (
    supplierId !==
    undefined
  ) {
    body.supplier_id =
      supplierId;
  }

  const response =
    await request(app)
      .post("/stock")
      .set(
        "Authorization",
        bearer(token)
      )
      .send(body);

  return response;
}

async function createSupplier({
  token = ownerTokenA,
  name,
} = {}) {
  return request(app)
    .post("/suppliers")
    .set(
      "Authorization",
      bearer(token)
    )
    .send({
      name,
      website:
        "",
      phone:
        "",
      contact_name:
        "",
      delivery_days:
        "",
    });
}

async function stockRow(id) {
  return one(
    `
    SELECT *
    FROM public.stock
    WHERE id = $1
    `,
    [
      Number(id),
    ]
  );
}

async function supplierRow(id) {
  return one(
    `
    SELECT *
    FROM public.suppliers
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
      "STOCK/SUPPLIER TEST REFUSED: wrong database"
    );

    pool =
      safe.pool;

    /*
     * Deliberately stale role=owner.
     * Authoritative membership remains staff.
     */
    await createSecurityUser({
      username:
        "maks_stock_stale_owner",

      role:
        "owner",

      authority:
        "staff",

      jobTitle:
        "Server",

      permissions: [],
    });

    await createSecurityUser({
      username:
        "maks_stock_creator",

      authority:
        "staff",

      permissions: [
        P.STOCK_CREATE,
      ],
    });

    await createSecurityUser({
      username:
        "maks_stock_adjuster",

      authority:
        "staff",

      permissions: [
        P.STOCK_ADJUST,
      ],
    });

    await createSecurityUser({
      username:
        "maks_stock_editor",

      authority:
        "staff",

      permissions: [
        P.STOCK_EDIT,
      ],
    });

    await createSecurityUser({
      username:
        "maks_stock_viewer",

      authority:
        "staff",

      permissions: [
        P.STOCK_VIEW,
      ],
    });

    await createSecurityUser({
      username:
        "maks_stock_cost_viewer",

      authority:
        "staff",

      permissions: [
        P.STOCK_VIEW,
        P.STOCK_VIEW_COST,
      ],
    });

    await createSecurityUser({
      username:
        "maks_supplier_viewer",

      authority:
        "staff",

      permissions: [
        P.SUPPLIERS_VIEW,
      ],
    });

    await createSecurityUser({
      username:
        "maks_supplier_manager",

      authority:
        "manager",

      permissions: [
        P.SUPPLIERS_VIEW,
        P.SUPPLIERS_MANAGE,
      ],
    });

    await createSecurityUser({
      username:
        "maks_supplier_price",

      authority:
        "staff",

      permissions: [
        P.SUPPLIERS_PRICES,
      ],
    });

    ({ app } =
      require("../../server"));

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
          "maks_stock_stale_owner",
      });

    stockCreatorTokenA =
      await login({
        username:
          "maks_stock_creator",
      });

    stockAdjusterTokenA =
      await login({
        username:
          "maks_stock_adjuster",
      });

    stockEditorTokenA =
      await login({
        username:
          "maks_stock_editor",
      });

    stockViewerTokenA =
      await login({
        username:
          "maks_stock_viewer",
      });

    stockCostViewerTokenA =
      await login({
        username:
          "maks_stock_cost_viewer",
      });

    supplierViewerTokenA =
      await login({
        username:
          "maks_supplier_viewer",
      });

    supplierManagerTokenA =
      await login({
        username:
          "maks_supplier_manager",
      });

    supplierPriceTokenA =
      await login({
        username:
          "maks_supplier_price",
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
 * 1. STALE OWNER ROLE
 * =====================================================
 */

test(
  "AUTHORITY: stale legacy owner role gives staff no stock-create authority",
  async () => {
    const response =
      await createStock({
        token:
          staleOwnerTokenA,

        ingredient:
          "STALE OWNER STOCK ATTACK",
      });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 2. STOCK CREATE PERMISSION
 * =====================================================
 */

test(
  "PERMISSION: stock.create can create a new ingredient",
  async () => {
    const response =
      await createStock({
        token:
          stockCreatorTokenA,

        ingredient:
          "TEST CREATOR FLOUR",

        quantity:
          10,

        price:
          3.25,
      });

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
          ?.item
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
 * 3. CREATE DOES NOT IMPLY ADJUST
 * =====================================================
 */

test(
  "PERMISSION: stock.create alone cannot adjust an existing ingredient",
  async () => {
    await createStock({
      ingredient:
        "TEST EXISTING RICE",

      quantity:
        5,
    });

    const response =
      await createStock({
        token:
          stockCreatorTokenA,

        ingredient:
          "TEST EXISTING RICE",

        quantity:
          2,
      });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 4. ADJUST PERMISSION
 * =====================================================
 */

test(
  "PERMISSION: stock.adjust can change quantity but not definition",
  async () => {
    const created =
      await createStock({
        ingredient:
          "TEST ADJUST POTATO",

        quantity:
          8,
      });

    assert.equal(
      created.status,
      201
    );

    const id =
      Number(
        created.body
          ?.item?.id
      );

    const qtyChange =
      await request(app)
        .put(
          `/stock/${id}`
        )
        .set(
          "Authorization",
          bearer(
            stockAdjusterTokenA
          )
        )
        .send({
          quantity:
            12,
        });

    assert.equal(
      qtyChange.status,
      200
    );

    const definitionAttack =
      await request(app)
        .put(
          `/stock/${id}`
        )
        .set(
          "Authorization",
          bearer(
            stockAdjusterTokenA
          )
        )
        .send({
          price:
            0.01,
        });

    assert.equal(
      definitionAttack.status,
      403
    );
  }
);

/*
 * =====================================================
 * 5. EDIT DOES NOT IMPLY ADJUST
 * =====================================================
 */

test(
  "PERMISSION: stock.edit alone cannot change quantity",
  async () => {
    const created =
      await createStock({
        ingredient:
          "TEST EDIT ONLY",
      });

    const id =
      Number(
        created.body
          ?.item?.id
      );

    const response =
      await request(app)
        .put(
          `/stock/${id}`
        )
        .set(
          "Authorization",
          bearer(
            stockEditorTokenA
          )
        )
        .send({
          quantity:
            999,
        });

    assert.equal(
      response.status,
      403
    );
  }
);

/*
 * =====================================================
 * 6. STOCK COST REDACTION
 * =====================================================
 */

test(
  "CONFIDENTIALITY: stock.view without stock.view_cost hides cost",
  async () => {
    await createStock({
      ingredient:
        "TEST SECRET COST",

      quantity:
        4,

      price:
        77.77,
    });

    const response =
      await request(app)
        .get("/stock")
        .set(
          "Authorization",
          bearer(
            stockViewerTokenA
          )
        );

    assert.equal(
      response.status,
      200
    );

    const row =
      response.body.find(
        (item) =>
          item.ingredient ===
          "TEST SECRET COST"
      );

    assert.ok(row);

    assert.equal(
      row.price,
      null
    );
  }
);

test(
  "CONFIDENTIALITY: stock.view_cost reveals commercial cost",
  async () => {
    const response =
      await request(app)
        .get("/stock")
        .set(
          "Authorization",
          bearer(
            stockCostViewerTokenA
          )
        );

    assert.equal(
      response.status,
      200
    );

    const row =
      response.body.find(
        (item) =>
          item.ingredient ===
          "TEST SECRET COST"
      );

    assert.ok(row);

    assert.equal(
      Number(
        row.price
      ),
      77.77
    );
  }
);

/*
 * =====================================================
 * 8. CROSS-TENANT STOCK UPDATE
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot update Restaurant B stock",
  async () => {
    const createdB =
      await createStock({
        token:
          ownerTokenB,

        ingredient:
          "TENANT B STOCK",

        quantity:
          20,
      });

    assert.equal(
      createdB.status,
      201
    );

    const id =
      Number(
        createdB.body
          ?.item?.id
      );

    const before =
      await stockRow(id);

    const attack =
      await request(app)
        .put(
          `/stock/${id}`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          quantity:
            99999,
        });

    assert.equal(
      attack.status,
      404
    );

    const after =
      await stockRow(id);

    assert.equal(
      Number(after.quantity),
      Number(before.quantity)
    );
  }
);

/*
 * =====================================================
 * 9. CROSS-TENANT STOCK DELETE
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot delete Restaurant B stock",
  async () => {
    const createdB =
      await createStock({
        token:
          ownerTokenB,

        ingredient:
          "TENANT B DELETE STOCK",
      });

    const id =
      Number(
        createdB.body
          ?.item?.id
      );

    const attack =
      await request(app)
        .delete(
          `/stock/${id}`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        );

    assert.equal(
      attack.status,
      404
    );

    assert.ok(
      await stockRow(id)
    );
  }
);

/*
 * =====================================================
 * 10. NEGATIVE STOCK CREATE
 * =====================================================
 *
 * This is intentionally aimed at the legacy POST endpoint.
 */

test(
  "VALIDATION: new stock item cannot be created with negative quantity",
  async () => {
    const response =
      await createStock({
        ingredient:
          "NEGATIVE STOCK ATTACK",

        quantity:
          -50,
      });

    assert.equal(
      response.status,
      400,
      `Negative stock create accepted: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );

    const row =
      await one(
        `
        SELECT *
        FROM public.stock
        WHERE restaurant_id = $1
          AND ingredient = $2
        `,
        [
          fixtures.restaurantA,
          "NEGATIVE STOCK ATTACK",
        ]
      );

    assert.equal(
      row,
      null
    );
  }
);

/*
 * =====================================================
 * 11. NEGATIVE STOCK PRICE CREATE
 * =====================================================
 */

test(
  "VALIDATION: new stock item cannot be created with negative price",
  async () => {
    const response =
      await createStock({
        ingredient:
          "NEGATIVE PRICE ATTACK",

        quantity:
          1,

        price:
          -99,
      });

    assert.equal(
      response.status,
      400,
      `Negative stock price accepted: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );
  }
);

/*
 * =====================================================
 * 12. NEGATIVE PUT IS ALREADY EXPECTED TO HOLD
 * =====================================================
 */

test(
  "VALIDATION: stock update rejects negative quantity",
  async () => {
    const created =
      await createStock({
        ingredient:
          "NEGATIVE UPDATE TEST",
      });

    const id =
      Number(
        created.body
          ?.item?.id
      );

    const response =
      await request(app)
        .put(
          `/stock/${id}`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          quantity:
            -1,
        });

    assert.equal(
      response.status,
      400
    );
  }
);

/*
 * =====================================================
 * 13. CROSS-TENANT SUPPLIER REFERENCE FROM STOCK
 * =====================================================
 *
 * Restaurant A must never attach a Restaurant B supplier
 * id to its own stock row.
 */

test(
  "TENANT: Restaurant A stock cannot reference Restaurant B supplier",
  async () => {
    const supplierB =
      await createSupplier({
        token:
          ownerTokenB,

        name:
          "TENANT B SUPPLIER",
      });

    assert.equal(
      supplierB.status,
      201
    );

    const supplierBId =
      Number(
        supplierB.body.id
      );

    const response =
      await createStock({
        token:
          ownerTokenA,

        ingredient:
          "CROSS TENANT SUPPLIER ATTACK",

        supplierId:
          supplierBId,
      });

    assert.ok(
      response.status >= 400,
      `Cross-tenant supplier attached to stock: ${response.status} ${JSON.stringify(
        response.body
      )}`
    );

    const bad =
      await one(
        `
        SELECT id
        FROM public.stock
        WHERE restaurant_id = $1
          AND supplier_id = $2
        LIMIT 1
        `,
        [
          fixtures.restaurantA,
          supplierBId,
        ]
      );

    assert.equal(
      bad,
      null
    );
  }
);

/*
 * =====================================================
 * 14. SUPPLIER VIEW VS MANAGE
 * =====================================================
 */

test(
  "PERMISSION: suppliers.view cannot create suppliers",
  async () => {
    const response =
      await createSupplier({
        token:
          supplierViewerTokenA,

        name:
          "VIEWER CREATE ATTACK",
      });

    assert.equal(
      response.status,
      403
    );
  }
);

test(
  "PERMISSION: suppliers.manage can create supplier",
  async () => {
    const response =
      await createSupplier({
        token:
          supplierManagerTokenA,

        name:
          "VALID MANAGED SUPPLIER",
      });

    assert.equal(
      response.status,
      201,
      JSON.stringify(
        response.body
      )
    );
  }
);

/*
 * =====================================================
 * 16. CROSS-TENANT SUPPLIER READ
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot read Restaurant B supplier",
  async () => {
    const created =
      await createSupplier({
        token:
          ownerTokenB,

        name:
          "B SECRET SUPPLIER",
      });

    const id =
      Number(
        created.body.id
      );

    const response =
      await request(app)
        .get(
          `/suppliers/${id}`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        );

    assert.equal(
      response.status,
      404
    );
  }
);

/*
 * =====================================================
 * 17. CROSS-TENANT SUPPLIER UPDATE
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot update Restaurant B supplier",
  async () => {
    const created =
      await createSupplier({
        token:
          ownerTokenB,

        name:
          "B UPDATE TARGET",
      });

    const id =
      Number(
        created.body.id
      );

    const attack =
      await request(app)
        .put(
          `/suppliers/${id}`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        )
        .send({
          name:
            "STOLEN SUPPLIER",
        });

    assert.equal(
      attack.status,
      404
    );

    const after =
      await supplierRow(id);

    assert.equal(
      after.name,
      "B UPDATE TARGET"
    );
  }
);

/*
 * =====================================================
 * 18. CROSS-TENANT SUPPLIER DELETE
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot delete Restaurant B supplier",
  async () => {
    const created =
      await createSupplier({
        token:
          ownerTokenB,

        name:
          "B DELETE TARGET",
      });

    const id =
      Number(
        created.body.id
      );

    const attack =
      await request(app)
        .delete(
          `/suppliers/${id}`
        )
        .set(
          "Authorization",
          bearer(ownerTokenA)
        );

    assert.equal(
      attack.status,
      404
    );

    assert.ok(
      await supplierRow(id)
    );
  }
);

/*
 * =====================================================
 * 19. SUPPLIER PRICE NEGATIVE
 * =====================================================
 */

test(
  "VALIDATION: supplier price cannot be negative",
  async () => {
    const supplier =
      await createSupplier({
        name:
          "PRICE VALIDATION SUPPLIER",
      });

    const response =
      await request(app)
        .post(
          "/suppliers/prices"
        )
        .set(
          "Authorization",
          bearer(
            supplierPriceTokenA
          )
        )
        .send({
          supplier_id:
            supplier.body.id,

          ingredient:
            "Tomato",

          price:
            -10,
        });

    assert.equal(
      response.status,
      400
    );
  }
);

/*
 * =====================================================
 * 20. CROSS-TENANT SUPPLIER PRICE
 * =====================================================
 */

test(
  "TENANT: Restaurant A cannot write a price for Restaurant B supplier",
  async () => {
    const supplierB =
      await createSupplier({
        token:
          ownerTokenB,

        name:
          "B PRICE TARGET",
      });

    const response =
      await request(app)
        .post(
          "/suppliers/prices"
        )
        .set(
          "Authorization",
          bearer(
            supplierPriceTokenA
          )
        )
        .send({
          supplier_id:
            supplierB.body.id,

          ingredient:
            "Tomato",

          price:
            1.23,
        });

    assert.equal(
      response.status,
      404
    );
  }
);

/*
 * =====================================================
 * 21. CONCURRENT STOCK ADDITION
 * =====================================================
 *
 * POST /stock uses ON CONFLICT + quantity addition.
 * Two simultaneous deliveries must not lose one update.
 */

test(
  "RACE: simultaneous stock additions preserve both quantities",
  async () => {
    const initial =
      await createStock({
        ingredient:
          "RACE STOCK ITEM",

        quantity:
          10,
      });

    assert.equal(
      initial.status,
      201
    );

    const [a, b] =
      await Promise.all([
        createStock({
          ingredient:
            "RACE STOCK ITEM",

          quantity:
            3,
        }),

        createStock({
          ingredient:
            "RACE STOCK ITEM",

          quantity:
            4,
        }),
      ]);

    assert.equal(
      a.status,
      201
    );

    assert.equal(
      b.status,
      201
    );

    const row =
      await one(
        `
        SELECT quantity
        FROM public.stock
        WHERE restaurant_id = $1
          AND LOWER(TRIM(ingredient)) =
              LOWER(TRIM($2))
        LIMIT 1
        `,
        [
          fixtures.restaurantA,
          "RACE STOCK ITEM",
        ]
      );

    assert.equal(
      Number(
        row.quantity
      ),
      17
    );
  }
);

/*
 * =====================================================
 * 22. FINAL STOCK TENANT INVARIANT
 * =====================================================
 */

test(
  "FINAL: stock supplier references never cross tenant ownership",
  async () => {
    const bad =
      await all(
        `
        SELECT
          st.id AS stock_id,
          st.restaurant_id AS stock_restaurant,
          s.id AS supplier_id,
          s.restaurant_id AS supplier_restaurant

        FROM public.stock st

        JOIN public.suppliers s
          ON s.id =
             st.supplier_id

        WHERE st.supplier_id
          IS NOT NULL

          AND st.restaurant_id <>
              s.restaurant_id
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
 * 23. FINAL NON-NEGATIVE STOCK
 * =====================================================
 */

test(
  "FINAL: stock has no negative quantity or commercial price",
  async () => {
    const bad =
      await all(
        `
        SELECT
          id,
          restaurant_id,
          ingredient,
          quantity,
          price

        FROM public.stock

        WHERE COALESCE(quantity, 0) < 0
           OR COALESCE(price, 0) < 0
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
 * 24. FINAL SUPPLIER PRICES
 * =====================================================
 */

test(
  "FINAL: supplier prices preserve tenant ownership and non-negative price",
  async () => {
    const bad =
      await all(
        `
        SELECT
          sp.id,
          sp.restaurant_id,
          sp.supplier_id,
          sp.price_per_unit
        FROM public.supplier_prices sp

        LEFT JOIN public.suppliers s
          ON s.id =
             sp.supplier_id

        WHERE sp.price_per_unit < 0

           OR s.id IS NULL

           OR s.restaurant_id <>
              sp.restaurant_id
        `
      );

    assert.deepEqual(
      bad,
      []
    );
  }
);