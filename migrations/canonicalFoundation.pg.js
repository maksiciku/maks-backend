async function ensureConstraint(
  qRun,
  table,
  constraintName,
  definition
) {
  await qRun(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = '${constraintName}'
          AND conrelid = 'public.${table}'::regclass
      ) THEN
        ALTER TABLE public.${table}
        ADD CONSTRAINT ${constraintName}
        ${definition};
      END IF;
    END
    $$;
  `);
}

async function runCanonicalFoundationPg({
  qRun,
  qGet,
}) {
  if (
    typeof qRun !== "function" ||
    typeof qGet !== "function"
  ) {
    throw new Error(
      "Canonical foundation requires qRun and qGet"
    );
  }

  console.log(
    "🏗️ Running canonical MAKS foundation..."
  );

  // =====================================================
  // RESTAURANTS — TENANT ROOT
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS public.restaurants (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,

      created_at TIMESTAMPTZ DEFAULT NOW(),

      phone TEXT,
      timezone TEXT,

      account_status TEXT
        NOT NULL
        DEFAULT 'active',

      plan_key TEXT,

      monthly_price NUMERIC(10,2)
        DEFAULT 0,

      device_limit INTEGER
        DEFAULT 0,

      notes_internal TEXT,

      last_seen_at TIMESTAMPTZ,

      billing_status TEXT
        NOT NULL
        DEFAULT 'active',

      kiosk_settings JSONB
        NOT NULL
        DEFAULT '{
          "show_eat_in": true,
          "show_photos": true,
          "show_prices": true,
          "show_voucher": true,
          "show_takeaway": true,
          "visible_category_ids": []
        }'::jsonb,

      stock_deduction_enabled BOOLEAN
        DEFAULT TRUE,

      hold_qr_kiosk_until_paid BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      owner_first_name TEXT,
      owner_last_name TEXT,
      owner_email TEXT,

      website TEXT,
      address_line1 TEXT,
      postcode TEXT,
      country TEXT,
      business_type TEXT,

      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_checkout_session_id TEXT,
      stripe_subscription_status TEXT,
      stripe_current_period_end TIMESTAMPTZ,

      allergen_tracking_enabled BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      calorie_tracking_enabled BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      plate_cost_enabled BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      portion_tracking_mode TEXT
        NOT NULL
        DEFAULT 'ingredients',

      selling_mode TEXT
        NOT NULL
        DEFAULT 'full_stock',

      service_charge_enabled BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      service_charge_rate NUMERIC(5,2)
        NOT NULL
        DEFAULT 10.00,

      manual_discounts_enabled BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      max_manual_discount_percent NUMERIC(5,2)
        NOT NULL
        DEFAULT 100.00,

      service_charge_vat_mode TEXT
        NOT NULL
        DEFAULT 'discretionary',

      CONSTRAINT restaurants_max_manual_discount_percent_check
        CHECK (
          max_manual_discount_percent >= 0
          AND
          max_manual_discount_percent <= 100
        ),

      CONSTRAINT restaurants_service_charge_rate_check
        CHECK (
          service_charge_rate >= 0
          AND
          service_charge_rate <= 100
        ),

      CONSTRAINT restaurants_service_charge_vat_mode_chk
        CHECK (
          service_charge_vat_mode IN (
            'discretionary',
            'mandatory'
          )
        )
    );
  `);

  // Existing installations may have an older restaurant table.
  // Add current fields safely without destroying data.

  const restaurantColumns = [
    ["phone", "TEXT"],
    ["timezone", "TEXT"],

    [
      "account_status",
      "TEXT NOT NULL DEFAULT 'active'"
    ],

    ["plan_key", "TEXT"],

    [
      "monthly_price",
      "NUMERIC(10,2) DEFAULT 0"
    ],

    [
      "device_limit",
      "INTEGER DEFAULT 0"
    ],

    ["notes_internal", "TEXT"],
    ["last_seen_at", "TIMESTAMPTZ"],

    [
      "billing_status",
      "TEXT NOT NULL DEFAULT 'active'"
    ],

    [
      "kiosk_settings",
      `JSONB NOT NULL DEFAULT '{
        "show_eat_in": true,
        "show_photos": true,
        "show_prices": true,
        "show_voucher": true,
        "show_takeaway": true,
        "visible_category_ids": []
      }'::jsonb`
    ],

    [
      "stock_deduction_enabled",
      "BOOLEAN DEFAULT TRUE"
    ],

    [
      "hold_qr_kiosk_until_paid",
      "BOOLEAN NOT NULL DEFAULT TRUE"
    ],

    ["owner_first_name", "TEXT"],
    ["owner_last_name", "TEXT"],
    ["owner_email", "TEXT"],

    ["website", "TEXT"],
    ["address_line1", "TEXT"],
    ["postcode", "TEXT"],
    ["country", "TEXT"],
    ["business_type", "TEXT"],

    ["stripe_customer_id", "TEXT"],
    ["stripe_subscription_id", "TEXT"],
    ["stripe_checkout_session_id", "TEXT"],
    ["stripe_subscription_status", "TEXT"],
    [
      "stripe_current_period_end",
      "TIMESTAMPTZ"
    ],

    [
      "allergen_tracking_enabled",
      "BOOLEAN NOT NULL DEFAULT TRUE"
    ],

    [
      "calorie_tracking_enabled",
      "BOOLEAN NOT NULL DEFAULT TRUE"
    ],

    [
      "plate_cost_enabled",
      "BOOLEAN NOT NULL DEFAULT TRUE"
    ],

    [
      "portion_tracking_mode",
      "TEXT NOT NULL DEFAULT 'ingredients'"
    ],

    [
      "selling_mode",
      "TEXT NOT NULL DEFAULT 'full_stock'"
    ],

    [
      "service_charge_enabled",
      "BOOLEAN NOT NULL DEFAULT FALSE"
    ],

    [
      "service_charge_rate",
      "NUMERIC(5,2) NOT NULL DEFAULT 10.00"
    ],

    [
      "manual_discounts_enabled",
      "BOOLEAN NOT NULL DEFAULT TRUE"
    ],

    [
      "max_manual_discount_percent",
      "NUMERIC(5,2) NOT NULL DEFAULT 100.00"
    ],

    [
      "service_charge_vat_mode",
      "TEXT NOT NULL DEFAULT 'discretionary'"
    ],
  ];

  for (
    const [
      column,
      definition,
    ] of restaurantColumns
  ) {
    await qRun(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS
      ${column} ${definition};
    `);
  }

  // =====================================================
  // USERS — HUMAN / LOGIN IDENTITY
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS public.users (
      id BIGSERIAL PRIMARY KEY,

      username TEXT NOT NULL,
      password TEXT NOT NULL,

      role TEXT NOT NULL,

      restaurant_id BIGINT,

      is_active BOOLEAN
        DEFAULT TRUE,

      created_at TIMESTAMPTZ
        DEFAULT NOW(),

      pin_hash TEXT,

      can_pos_login BOOLEAN
        DEFAULT FALSE,

      full_name TEXT,
      pin_label TEXT,
      address TEXT,
      avatar_url TEXT,

      membership_tier TEXT
        DEFAULT 'Basic',

      force_password_reset BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      permissions TEXT
        DEFAULT '[]',

      password_hash TEXT,

      can_backoffice_login BOOLEAN
        NOT NULL
        DEFAULT FALSE
    );
  `);

  const userColumns = [
    ["pin_hash", "TEXT"],

    [
      "can_pos_login",
      "BOOLEAN DEFAULT FALSE"
    ],

    ["full_name", "TEXT"],
    ["pin_label", "TEXT"],
    ["address", "TEXT"],
    ["avatar_url", "TEXT"],

    [
      "membership_tier",
      "TEXT DEFAULT 'Basic'"
    ],

    [
      "force_password_reset",
      "BOOLEAN NOT NULL DEFAULT FALSE"
    ],

    [
      "permissions",
      "TEXT DEFAULT '[]'"
    ],

    ["password_hash", "TEXT"],

    [
      "can_backoffice_login",
      "BOOLEAN NOT NULL DEFAULT FALSE"
    ],
  ];

  for (
    const [
      column,
      definition,
    ] of userColumns
  ) {
    await qRun(`
      ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS
      ${column} ${definition};
    `);
  }

  // =====================================================
  // RESTAURANT MEMBERS
  //
  // This is the authoritative restaurant membership /
  // employee authority record.
  //
  // authority:
  //   owner
  //   manager
  //   staff
  //
  // job_title has no security meaning.
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.restaurant_members (
      id BIGSERIAL PRIMARY KEY,

      restaurant_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,

      role TEXT NOT NULL,

      status TEXT
        NOT NULL
        DEFAULT 'active',

      created_at TIMESTAMPTZ
        DEFAULT NOW(),

      is_active BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      permissions JSONB
        DEFAULT '[]'::jsonb,

      authority TEXT
        NOT NULL
        DEFAULT 'staff',

      job_title TEXT,

      CONSTRAINT
        restaurant_members_authority_check
      CHECK (
        authority IN (
          'owner',
          'manager',
          'staff'
        )
      ),

      CONSTRAINT
        restaurant_members_role_check
      CHECK (
        role IN (
          'owner',
          'admin',
          'chef',
          'staff'
        )
      ),

      CONSTRAINT
        restaurant_members_restaurant_id_user_id_key
      UNIQUE (
        restaurant_id,
        user_id
      ),

      CONSTRAINT
        restaurant_members_restaurant_id_fkey
      FOREIGN KEY (
        restaurant_id
      )
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE,

      CONSTRAINT
        restaurant_members_user_id_fkey
      FOREIGN KEY (
        user_id
      )
      REFERENCES public.users(id)
      ON DELETE CASCADE
    );
  `);

  const memberColumns = [
    [
      "status",
      "TEXT NOT NULL DEFAULT 'active'"
    ],

    [
      "created_at",
      "TIMESTAMPTZ DEFAULT NOW()"
    ],

    [
      "is_active",
      "BOOLEAN NOT NULL DEFAULT TRUE"
    ],

    [
      "permissions",
      "JSONB DEFAULT '[]'::jsonb"
    ],

    [
      "authority",
      "TEXT NOT NULL DEFAULT 'staff'"
    ],

    ["job_title", "TEXT"],
  ];

  for (
    const [
      column,
      definition,
    ] of memberColumns
  ) {
    await qRun(`
      ALTER TABLE public.restaurant_members
      ADD COLUMN IF NOT EXISTS
      ${column} ${definition};
    `);
  }

  // =====================================================
  // RESTAURANT MEMBER CONSTRAINTS
  // =====================================================

  await ensureConstraint(
    qRun,
    "restaurant_members",
    "restaurant_members_authority_check",
    `
      CHECK (
        authority IN (
          'owner',
          'manager',
          'staff'
        )
      )
    `
  );

  await ensureConstraint(
    qRun,
    "restaurant_members",
    "restaurant_members_role_check",
    `
      CHECK (
        role IN (
          'owner',
          'admin',
          'chef',
          'staff'
        )
      )
    `
  );

  await ensureConstraint(
    qRun,
    "restaurant_members",
    "restaurant_members_restaurant_id_user_id_key",
    `
      UNIQUE (
        restaurant_id,
        user_id
      )
    `
  );

  await ensureConstraint(
    qRun,
    "restaurant_members",
    "restaurant_members_restaurant_id_fkey",
    `
      FOREIGN KEY (
        restaurant_id
      )
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
    `
  );

  await ensureConstraint(
    qRun,
    "restaurant_members",
    "restaurant_members_user_id_fkey",
    `
      FOREIGN KEY (
        user_id
      )
      REFERENCES public.users(id)
      ON DELETE CASCADE
    `
  );

  // Current production lookup paths.
  await qRun(`
    CREATE INDEX IF NOT EXISTS
    idx_restaurant_members_restaurant_authority
    ON public.restaurant_members (
      restaurant_id,
      authority
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
    idx_restaurant_members_user_restaurant_active
    ON public.restaurant_members (
      user_id,
      restaurant_id,
      is_active
    );
  `);

  // =====================================================
  // VERIFY FOUNDATION
  // =====================================================

  const verification =
    await qGet(`
      SELECT
        to_regclass(
          'public.restaurants'
        ) AS restaurants,

        to_regclass(
          'public.users'
        ) AS users,

        to_regclass(
          'public.restaurant_members'
        ) AS restaurant_members
    `);

  if (
    !verification?.restaurants ||
    !verification?.users ||
    !verification?.restaurant_members
  ) {
    throw new Error(
      "Canonical MAKS foundation verification failed"
    );
  }

  console.log(
    "✅ Canonical MAKS foundation ready"
  );
}

module.exports = {
  runCanonicalFoundationPg,
};
