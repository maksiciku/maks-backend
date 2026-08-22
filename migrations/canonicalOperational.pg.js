// migrations/canonicalOperational.pg.js

async function runCanonicalOperationalPg({
  qRun,
  qGet,
}) {
  if (
    typeof qRun !== "function" ||
    typeof qGet !== "function"
  ) {
    throw new Error(
      "Canonical operational schema requires qRun and qGet"
    );
  }

  console.log(
    "⚙️ Running canonical MAKS operational schema..."
  );

  // =====================================================
  // INVOICES
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS public.invoices (
      id BIGSERIAL PRIMARY KEY,

      restaurant_id BIGINT NOT NULL,

      supplier_name TEXT,
      invoice_number TEXT,
      invoice_date TEXT,

      raw_text TEXT,
      items_json TEXT,

      total DOUBLE PRECISION,
      currency TEXT,
      status TEXT,

      file_url TEXT,
      thumb_url TEXT,

      created_at TIMESTAMPTZ
        DEFAULT NOW()
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_invoices_rid
    ON public.invoices (
      restaurant_id
    );
  `);

  // =====================================================
  // KDS ITEM STATE
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.kds_item_state (
      id BIGSERIAL PRIMARY KEY,

      restaurant_id BIGINT NOT NULL,

      station_key TEXT NOT NULL,
      batch_id UUID NOT NULL,

      item_name TEXT NOT NULL,
      mods_line TEXT
        NOT NULL
        DEFAULT '',

      is_working BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      is_hidden BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      updated_by_device TEXT,

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      CONSTRAINT
        kds_item_state_restaurant_station_batch_item_uniq
      UNIQUE (
        restaurant_id,
        station_key,
        batch_id,
        item_name,
        mods_line
      )
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_kds_item_state_lookup
    ON public.kds_item_state (
      restaurant_id,
      station_key,
      batch_id
    );
  `);

  // =====================================================
  // KDS STATION ACK
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.kds_station_ack (
      id BIGSERIAL PRIMARY KEY,

      restaurant_id BIGINT NOT NULL,

      batch_id UUID NOT NULL,
      station_key TEXT NOT NULL,

      acked_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      acked_by BIGINT,

      device_id TEXT NOT NULL,

      CONSTRAINT
        kds_station_ack_device_uniq
      UNIQUE (
        restaurant_id,
        device_id,
        batch_id,
        station_key
      )
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_kds_ack_rid_batch
    ON public.kds_station_ack (
      restaurant_id,
      batch_id
    );
  `);

  // =====================================================
  // MENU ITEMS
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.menu_items (
      id BIGSERIAL PRIMARY KEY,

      restaurant_id BIGINT NOT NULL,

      name TEXT NOT NULL,
      type TEXT NOT NULL,

      price NUMERIC(10,2)
        NOT NULL
        DEFAULT 0,

      category_id BIGINT,

      paused BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      options_schema JSONB,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      is_available BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      out_of_stock BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      photo_url TEXT,

      allergens TEXT
        DEFAULT 'None',

      calories NUMERIC
        DEFAULT 0,

      manual_portions_enabled BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      manual_portions_available INTEGER,

      vat_rate NUMERIC(5,2),

      availability_mode TEXT
        NOT NULL
        DEFAULT 'maks',

      manual_quantity INTEGER,

      manually_stopped BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      CONSTRAINT
        menu_items_type_check
      CHECK (
        type IN (
          'meal',
          'drink',
          'dessert'
        )
      ),

      CONSTRAINT
        menu_items_availability_mode_valid
      CHECK (
        availability_mode IN (
          'maks',
          'manual',
          'unlimited'
        )
      ),

      CONSTRAINT
        menu_items_manual_quantity_valid
      CHECK (
        manual_quantity IS NULL
        OR manual_quantity >= 0
      ),

      CONSTRAINT
        menu_items_vat_rate_valid
      CHECK (
        vat_rate IS NULL
        OR (
          vat_rate >= 0
          AND vat_rate <= 100
        )
      )
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_menu_items_restaurant
    ON public.menu_items (
      restaurant_id
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_menu_items_cat
    ON public.menu_items (
      restaurant_id,
      category_id
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_menu_items_type
    ON public.menu_items (
      restaurant_id,
      type
    );
  `);

  // =====================================================
  // RECEIPT SETTINGS
  //
  // Exactly one current receipt-settings row
  // per restaurant.
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.org_receipt_settings (
      restaurant_id BIGINT
        PRIMARY KEY,

      receipt_name TEXT,
      receipt_address TEXT,
      receipt_email TEXT,
      receipt_phone TEXT,
      receipt_website TEXT,
      receipt_footer TEXT,

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      receipt_vat_number TEXT,
      receipt_company_number TEXT,
      receipt_custom_line1 TEXT,
      receipt_custom_line2 TEXT,

      receipt_show_vat BOOLEAN
        NOT NULL
        DEFAULT TRUE
    );
  `);

  // =====================================================
  // PAYMENT SETTLEMENTS
  //
  // Immutable commercial calculation snapshot.
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.payment_settlements (
      id UUID
        PRIMARY KEY
        DEFAULT gen_random_uuid(),

      restaurant_id BIGINT NOT NULL,

      table_number TEXT NOT NULL,

      batch_id UUID,
      invoice_number BIGINT,

      gross_amount NUMERIC(12,2)
        NOT NULL
        DEFAULT 0,

      pricing_discount_amount NUMERIC(12,2)
        NOT NULL
        DEFAULT 0,

      happy_hour_discount_amount NUMERIC(12,2)
        NOT NULL
        DEFAULT 0,

      deal_adjusted_amount NUMERIC(12,2)
        NOT NULL
        DEFAULT 0,

      voucher_id BIGINT,
      voucher_code TEXT,

      voucher_discount_amount NUMERIC(12,2)
        NOT NULL
        DEFAULT 0,

      manual_discount_amount NUMERIC(12,2)
        NOT NULL
        DEFAULT 0,

      service_charge_amount NUMERIC(12,2)
        NOT NULL
        DEFAULT 0,

      final_amount NUMERIC(12,2)
        NOT NULL
        DEFAULT 0,

      applied_rule_ids JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      pos_order_ids JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      pricing_snapshot JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      source TEXT
        NOT NULL
        DEFAULT 'pos',

      created_by_user_id BIGINT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      CONSTRAINT
        payment_settlements_gross_nonnegative
      CHECK (
        gross_amount >= 0
      ),

      CONSTRAINT
        payment_settlements_discounts_nonnegative
      CHECK (
        pricing_discount_amount >= 0
        AND happy_hour_discount_amount >= 0
        AND voucher_discount_amount >= 0
        AND manual_discount_amount >= 0
      ),

      CONSTRAINT
        payment_settlements_service_nonnegative
      CHECK (
        service_charge_amount >= 0
      ),

      CONSTRAINT
        payment_settlements_final_nonnegative
      CHECK (
        final_amount >= 0
      ),

      CONSTRAINT
        payment_settlements_deal_adjusted_valid
      CHECK (
        deal_adjusted_amount =
        GREATEST(
          0::numeric,
          gross_amount -
          pricing_discount_amount
        )
      ),

      CONSTRAINT
        payment_settlements_final_valid
      CHECK (
        final_amount =
        GREATEST(
          0::numeric,

          deal_adjusted_amount
          - voucher_discount_amount
          - manual_discount_amount
          + service_charge_amount
        )
      )
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_payment_settlements_batch
    ON public.payment_settlements (
      restaurant_id,
      batch_id
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_payment_settlements_restaurant_created
    ON public.payment_settlements (
      restaurant_id,
      created_at DESC
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_payment_settlements_restaurant_invoice
    ON public.payment_settlements (
      restaurant_id,
      invoice_number
    );
  `);

  // =====================================================
  // PAYMENTS LEDGER
  //
  // Canonical status model:
  //
  // completed
  // partially_refunded
  // refunded
  // voided
  //
  // Do NOT reproduce the two contradictory historical
  // production status constraints.
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.payments (
      id BIGSERIAL PRIMARY KEY,

      table_number TEXT,

      amount DOUBLE PRECISION
        NOT NULL,

      method TEXT
        NOT NULL,

      discount_value DOUBLE PRECISION
        DEFAULT 0,

      discount_type TEXT
        DEFAULT 'none',

      service_rate DOUBLE PRECISION
        DEFAULT 0,

      created_at TIMESTAMPTZ
        DEFAULT NOW(),

      restaurant_id BIGINT
        NOT NULL,

      batch_id UUID,

      staff_user_id BIGINT,

      terminal_ref TEXT,

      pos_order_ids JSONB
        DEFAULT '[]'::jsonb,

      source TEXT
        DEFAULT 'pos',

      status TEXT
        NOT NULL
        DEFAULT 'completed',

      void_reason TEXT,

      voided_at TIMESTAMPTZ,

      voided_by_user_id INTEGER,

      refund_of_payment_id BIGINT,

      cashup_session_id UUID,

      ref_payment_id BIGINT,

      settlement_id UUID,

      CONSTRAINT
        payments_status_check
      CHECK (
        status IN (
          'completed',
          'voided',
          'refunded',
          'partially_refunded'
        )
      ),

      CONSTRAINT
        payments_ref_payment_id_fkey
      FOREIGN KEY (
        ref_payment_id
      )
      REFERENCES public.payments(id)
      ON DELETE SET NULL,

      CONSTRAINT
        payments_refund_fk
      FOREIGN KEY (
        refund_of_payment_id
      )
      REFERENCES public.payments(id),

      CONSTRAINT
        payments_settlement_id_fkey
      FOREIGN KEY (
        settlement_id
      )
      REFERENCES public.payment_settlements(id)
      ON DELETE RESTRICT
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_payments_rid_created
    ON public.payments (
      restaurant_id,
      created_at DESC
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_payments_settlement
    ON public.payments (
      restaurant_id,
      settlement_id
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_payments_rid_cashup_session
    ON public.payments (
      restaurant_id,
      cashup_session_id
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_payments_refund_of
    ON public.payments (
      refund_of_payment_id
    );
  `);

  /*
   * Current refund logic searches by:
   * restaurant_id + ref_payment_id.
   */
  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_payments_rest_ref_payment
    ON public.payments (
      restaurant_id,
      ref_payment_id
    );
  `);

  // =====================================================
  // POS DEVICE SESSIONS
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.pos_device_sessions (
      id BIGSERIAL PRIMARY KEY,

      restaurant_id BIGINT NOT NULL,

      device_key TEXT NOT NULL,

      user_id BIGINT,

      claimed_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      last_seen_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      released_at TIMESTAMPTZ,

      is_active BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      device_name TEXT,

      created_at TIMESTAMPTZ
        DEFAULT NOW(),

      CONSTRAINT
        pos_device_sessions_restaurant_device_key_uniq
      UNIQUE (
        restaurant_id,
        device_key
      )
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_pos_device_sessions_last_seen
    ON public.pos_device_sessions (
      last_seen_at
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_pos_device_sessions_restaurant_active
    ON public.pos_device_sessions (
      restaurant_id,
      is_active
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_pos_device_sessions_restaurant_device
    ON public.pos_device_sessions (
      restaurant_id,
      device_key
    );
  `);

  // =====================================================
  // POS TABLE SESSIONS
  //
  // A restaurant/table pair is the identity.
  // =====================================================

  await qRun(`
    CREATE TABLE IF NOT EXISTS
    public.pos_table_sessions (
      restaurant_id BIGINT NOT NULL,

      table_id BIGINT NOT NULL,

      covers INTEGER
        NOT NULL
        DEFAULT 2,

      allergy_codes JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      strict_cross_contamination BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      CONSTRAINT
        pos_table_sessions_pkey
      PRIMARY KEY (
        restaurant_id,
        table_id
      )
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_pos_table_sessions_rid
    ON public.pos_table_sessions (
      restaurant_id
    );
  `);

  await qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_pos_table_sessions_table
    ON public.pos_table_sessions (
      table_id
    );
  `);

  // =====================================================
  // VERIFY PHASE 2
  // =====================================================

  const row =
    await qGet(`
      SELECT
        COUNT(*)::int
          AS table_count

      FROM information_schema.tables

      WHERE table_schema =
        'public'

        AND table_name =
        ANY(
          ARRAY[
            'invoices',
            'kds_item_state',
            'kds_station_ack',
            'menu_items',
            'org_receipt_settings',
            'payment_settlements',
            'payments',
            'pos_device_sessions',
            'pos_table_sessions'
          ]::text[]
        )
    `);

  if (
    Number(
      row?.table_count ||
      0
    ) !== 9
  ) {
    throw new Error(
      `Canonical operational verification failed: expected 9 tables, found ${Number(row?.table_count || 0)}`
    );
  }

  console.log(
    "✅ Canonical MAKS operational schema ready"
  );
}

module.exports = {
  runCanonicalOperationalPg,
};
