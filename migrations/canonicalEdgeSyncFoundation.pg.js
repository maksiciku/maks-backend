"use strict";

async function ensureConstraint(
  client,
  table,
  name,
  definition
) {
  const { rows } =
    await client.query(
      `
      SELECT 1
      FROM pg_constraint
      WHERE conname = $1
        AND conrelid = $2::regclass
      LIMIT 1
      `,
      [
        name,
        `public.${table}`,
      ]
    );

  if (rows.length) {
    return;
  }

  await client.query(`
    ALTER TABLE public.${table}
    ADD CONSTRAINT ${name}
    ${definition};
  `);
}

async function assertColumnType(
  client,
  table,
  column,
  allowedTypes
) {
  const { rows } =
    await client.query(
      `
      SELECT
        t.typname AS type_name
      FROM pg_attribute a
      JOIN pg_class c
        ON c.oid = a.attrelid
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      JOIN pg_type t
        ON t.oid = a.atttypid
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND a.attname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped
      LIMIT 1
      `,
      [table, column]
    );

  const type =
    rows?.[0]?.type_name;

  if (
    !type ||
    !allowedTypes.includes(type)
  ) {
    throw new Error(
      `Canonical Edge sync schema refused: public.${table}.${column} expected ${allowedTypes.join(
        "/"
      )}, got ${type || "missing"}`
    );
  }
}

async function runCanonicalEdgeSyncFoundationPg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !==
      "function"
  ) {
    throw new Error(
      "Canonical Edge sync schema requires PostgreSQL pool"
    );
  }

  console.log(
    "🔄 Running canonical MAKS Edge sync foundation..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    // =====================================================
    // EDGE OUTBOX
    //
    // Durable events created locally before Cloud ACK.
    // Event content is immutable once created.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.edge_outbox (
        id BIGSERIAL PRIMARY KEY,

        event_id UUID
          NOT NULL
          DEFAULT gen_random_uuid(),

        restaurant_id BIGINT
          NOT NULL,

        event_type TEXT
          NOT NULL,

        entity_type TEXT,

        entity_id TEXT,

        idempotency_key TEXT
          NOT NULL,

        payload JSONB
          NOT NULL,

        payload_hash TEXT
          NOT NULL,

        status TEXT
          NOT NULL
          DEFAULT 'pending',

        retry_count INTEGER
          NOT NULL
          DEFAULT 0,

        next_attempt_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),

        last_attempt_at TIMESTAMPTZ,

        locked_at TIMESTAMPTZ,

        locked_by TEXT,

        acked_at TIMESTAMPTZ,

        last_error TEXT,

        created_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW()
      );
    `);

    // =====================================================
    // EDGE INBOX
    //
    // Remote events received from Cloud/another Edge.
    // event_id is the replay barrier.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.edge_inbox (
        id BIGSERIAL PRIMARY KEY,

        event_id UUID
          NOT NULL,

        restaurant_id BIGINT
          NOT NULL,

        source TEXT
          NOT NULL,

        source_installation_id UUID,

        event_type TEXT
          NOT NULL,

        entity_type TEXT,

        entity_id TEXT,

        payload JSONB
          NOT NULL,

        payload_hash TEXT
          NOT NULL,

        status TEXT
          NOT NULL
          DEFAULT 'received',

        apply_attempts INTEGER
          NOT NULL
          DEFAULT 0,

        next_attempt_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),

        last_attempt_at TIMESTAMPTZ,

        applied_at TIMESTAMPTZ,

        last_error TEXT,

        received_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW()
      );
    `);

    // =====================================================
    // EDGE IDEMPOTENCY
    //
    // Protects business operations themselves from being
    // executed twice even when HTTP/event delivery repeats.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.edge_idempotency (
        id BIGSERIAL PRIMARY KEY,

        restaurant_id BIGINT
          NOT NULL,

        scope TEXT
          NOT NULL,

        idempotency_key TEXT
          NOT NULL,

        request_hash TEXT
          NOT NULL,

        status TEXT
          NOT NULL
          DEFAULT 'in_progress',

        response_status INTEGER,

        response_body JSONB,

        completed_at TIMESTAMPTZ,

        expires_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW()
      );
    `);

    // =====================================================
    // EDGE SYNC STATE
    //
    // Operational progress for one Edge installation.
    // No FK to restaurant_edge_nodes:
    // local Edge storage must remain independently usable
    // while Cloud/control-plane connectivity is unavailable.
    // =====================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.edge_sync_state (
        restaurant_id BIGINT
          NOT NULL,

        installation_id UUID
          NOT NULL,

        sync_status TEXT
          NOT NULL
          DEFAULT 'unknown',

        pending_outbox_events INTEGER
          NOT NULL
          DEFAULT 0,

        pending_inbox_events INTEGER
          NOT NULL
          DEFAULT 0,

        last_acked_outbox_id BIGINT,

        last_applied_inbox_id BIGINT,

        cloud_cursor TEXT,

        last_push_at TIMESTAMPTZ,

        last_pull_at TIMESTAMPTZ,

        last_success_at TIMESTAMPTZ,

        last_error TEXT,

        consecutive_failures INTEGER
          NOT NULL
          DEFAULT 0,

        created_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),

        PRIMARY KEY (
          restaurant_id,
          installation_id
        )
      );
    `);

    // =====================================================
    // FAIL-CLOSED TYPE CHECKS
    // =====================================================

    const typeChecks = [
      [
        "edge_outbox",
        "id",
        ["int8"],
      ],
      [
        "edge_outbox",
        "event_id",
        ["uuid"],
      ],
      [
        "edge_outbox",
        "restaurant_id",
        ["int8"],
      ],
      [
        "edge_outbox",
        "payload",
        ["jsonb"],
      ],

      [
        "edge_inbox",
        "id",
        ["int8"],
      ],
      [
        "edge_inbox",
        "event_id",
        ["uuid"],
      ],
      [
        "edge_inbox",
        "restaurant_id",
        ["int8"],
      ],
      [
        "edge_inbox",
        "payload",
        ["jsonb"],
      ],

      [
        "edge_idempotency",
        "id",
        ["int8"],
      ],
      [
        "edge_idempotency",
        "restaurant_id",
        ["int8"],
      ],
      [
        "edge_idempotency",
        "response_body",
        ["jsonb"],
      ],

      [
        "edge_sync_state",
        "restaurant_id",
        ["int8"],
      ],
      [
        "edge_sync_state",
        "installation_id",
        ["uuid"],
      ],
    ];

    for (
      const [
        table,
        column,
        types,
      ] of typeChecks
    ) {
      await assertColumnType(
        client,
        table,
        column,
        types
      );
    }

    // =====================================================
    // TENANT FOREIGN KEYS
    // =====================================================

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_restaurant_fk",
      `
      FOREIGN KEY (restaurant_id)
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
      `
    );

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_restaurant_fk",
      `
      FOREIGN KEY (restaurant_id)
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
      `
    );

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_restaurant_fk",
      `
      FOREIGN KEY (restaurant_id)
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state",
      "edge_sync_state_restaurant_fk",
      `
      FOREIGN KEY (restaurant_id)
      REFERENCES public.restaurants(id)
      ON DELETE CASCADE
      `
    );

    // =====================================================
    // UNIQUENESS / REPLAY BARRIERS
    // =====================================================

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_event_id_key",
      `
      UNIQUE (event_id)
      `
    );

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_restaurant_idempotency_key",
      `
      UNIQUE (
        restaurant_id,
        idempotency_key
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_event_id_key",
      `
      UNIQUE (event_id)
      `
    );

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_restaurant_scope_key",
      `
      UNIQUE (
        restaurant_id,
        scope,
        idempotency_key
      )
      `
    );

    // =====================================================
    // OUTBOX CHECKS
    // =====================================================

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_event_type_check",
      `
      CHECK (
        LENGTH(TRIM(event_type)) > 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_idempotency_key_check",
      `
      CHECK (
        LENGTH(TRIM(idempotency_key)) > 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_payload_hash_check",
      `
      CHECK (
        payload_hash ~ '^[0-9a-f]{64}$'
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_status_check",
      `
      CHECK (
        status IN (
          'pending',
          'in_flight',
          'acked',
          'failed',
          'dead_letter'
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_retry_count_check",
      `
      CHECK (
        retry_count >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_acked_timestamp_check",
      `
      CHECK (
        status <> 'acked'
        OR acked_at IS NOT NULL
      )
      `
    );

    // =====================================================
    // INBOX CHECKS
    // =====================================================

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_source_check",
      `
      CHECK (
        source IN (
          'cloud',
          'edge'
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_event_type_check",
      `
      CHECK (
        LENGTH(TRIM(event_type)) > 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_payload_hash_check",
      `
      CHECK (
        payload_hash ~ '^[0-9a-f]{64}$'
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_status_check",
      `
      CHECK (
        status IN (
          'received',
          'applying',
          'applied',
          'failed',
          'dead_letter'
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_apply_attempts_check",
      `
      CHECK (
        apply_attempts >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_applied_timestamp_check",
      `
      CHECK (
        status <> 'applied'
        OR applied_at IS NOT NULL
      )
      `
    );

    // =====================================================
    // IDEMPOTENCY CHECKS
    // =====================================================

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_scope_check",
      `
      CHECK (
        LENGTH(TRIM(scope)) > 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_key_check",
      `
      CHECK (
        LENGTH(TRIM(idempotency_key)) > 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_request_hash_check",
      `
      CHECK (
        request_hash ~ '^[0-9a-f]{64}$'
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_status_check",
      `
      CHECK (
        status IN (
          'in_progress',
          'completed',
          'failed'
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_response_status_check",
      `
      CHECK (
        response_status IS NULL
        OR (
          response_status >= 100
          AND response_status <= 599
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_completed_timestamp_check",
      `
      CHECK (
        status <> 'completed'
        OR completed_at IS NOT NULL
      )
      `
    );

    // =====================================================
    // SYNC STATE CHECKS
    // =====================================================

    await ensureConstraint(
      client,
      "edge_sync_state",
      "edge_sync_state_status_check",
      `
      CHECK (
        sync_status IN (
          'unknown',
          'synced',
          'pending',
          'syncing',
          'error'
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state",
      "edge_sync_state_pending_outbox_check",
      `
      CHECK (
        pending_outbox_events >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state",
      "edge_sync_state_pending_inbox_check",
      `
      CHECK (
        pending_inbox_events >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state",
      "edge_sync_state_failures_check",
      `
      CHECK (
        consecutive_failures >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state",
      "edge_sync_state_outbox_cursor_check",
      `
      CHECK (
        last_acked_outbox_id IS NULL
        OR last_acked_outbox_id >= 0
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_sync_state",
      "edge_sync_state_inbox_cursor_check",
      `
      CHECK (
        last_applied_inbox_id IS NULL
        OR last_applied_inbox_id >= 0
      )
      `
    );

    // =====================================================
    // WORKER / LOOKUP INDEXES
    // =====================================================

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_edge_outbox_worker
      ON public.edge_outbox (
        restaurant_id,
        next_attempt_at,
        id
      )
      WHERE status IN (
        'pending',
        'failed'
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_edge_outbox_status
      ON public.edge_outbox (
        restaurant_id,
        status,
        id
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_edge_inbox_worker
      ON public.edge_inbox (
        restaurant_id,
        next_attempt_at,
        id
      )
      WHERE status IN (
        'received',
        'failed'
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_edge_inbox_status
      ON public.edge_inbox (
        restaurant_id,
        status,
        id
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_edge_idempotency_expiry
      ON public.edge_idempotency (
        restaurant_id,
        expires_at
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
        idx_edge_sync_state_status
      ON public.edge_sync_state (
        sync_status,
        updated_at DESC
      );
    `);

    // =====================================================
    // IMMUTABILITY GUARDS
    //
    // Delivery state may change.
    // Event/business identity may NOT.
    // =====================================================

    await client.query(`
      CREATE OR REPLACE FUNCTION
        public.edge_outbox_immutable_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF
          NEW.event_id
            IS DISTINCT FROM
          OLD.event_id

          OR NEW.restaurant_id
            IS DISTINCT FROM
          OLD.restaurant_id

          OR NEW.event_type
            IS DISTINCT FROM
          OLD.event_type

          OR NEW.entity_type
            IS DISTINCT FROM
          OLD.entity_type

          OR NEW.entity_id
            IS DISTINCT FROM
          OLD.entity_id

          OR NEW.idempotency_key
            IS DISTINCT FROM
          OLD.idempotency_key

          OR NEW.payload
            IS DISTINCT FROM
          OLD.payload

          OR NEW.payload_hash
            IS DISTINCT FROM
          OLD.payload_hash

          OR NEW.created_at
            IS DISTINCT FROM
          OLD.created_at
        THEN
          RAISE EXCEPTION
            'MAKS Edge outbox event identity/content is immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS
        trg_edge_outbox_immutable
      ON public.edge_outbox;

      CREATE TRIGGER
        trg_edge_outbox_immutable
      BEFORE UPDATE
      ON public.edge_outbox
      FOR EACH ROW
      EXECUTE FUNCTION
        public.edge_outbox_immutable_guard();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        public.edge_inbox_immutable_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF
          NEW.event_id
            IS DISTINCT FROM
          OLD.event_id

          OR NEW.restaurant_id
            IS DISTINCT FROM
          OLD.restaurant_id

          OR NEW.source
            IS DISTINCT FROM
          OLD.source

          OR NEW.source_installation_id
            IS DISTINCT FROM
          OLD.source_installation_id

          OR NEW.event_type
            IS DISTINCT FROM
          OLD.event_type

          OR NEW.entity_type
            IS DISTINCT FROM
          OLD.entity_type

          OR NEW.entity_id
            IS DISTINCT FROM
          OLD.entity_id

          OR NEW.payload
            IS DISTINCT FROM
          OLD.payload

          OR NEW.payload_hash
            IS DISTINCT FROM
          OLD.payload_hash

          OR NEW.received_at
            IS DISTINCT FROM
          OLD.received_at
        THEN
          RAISE EXCEPTION
            'MAKS Edge inbox event identity/content is immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS
        trg_edge_inbox_immutable
      ON public.edge_inbox;

      CREATE TRIGGER
        trg_edge_inbox_immutable
      BEFORE UPDATE
      ON public.edge_inbox
      FOR EACH ROW
      EXECUTE FUNCTION
        public.edge_inbox_immutable_guard();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        public.edge_idempotency_immutable_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF
          NEW.restaurant_id
            IS DISTINCT FROM
          OLD.restaurant_id

          OR NEW.scope
            IS DISTINCT FROM
          OLD.scope

          OR NEW.idempotency_key
            IS DISTINCT FROM
          OLD.idempotency_key

          OR NEW.request_hash
            IS DISTINCT FROM
          OLD.request_hash

          OR NEW.created_at
            IS DISTINCT FROM
          OLD.created_at
        THEN
          RAISE EXCEPTION
            'MAKS Edge idempotency identity is immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS
        trg_edge_idempotency_immutable
      ON public.edge_idempotency;

      CREATE TRIGGER
        trg_edge_idempotency_immutable
      BEFORE UPDATE
      ON public.edge_idempotency
      FOR EACH ROW
      EXECUTE FUNCTION
        public.edge_idempotency_immutable_guard();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        public.edge_sync_state_identity_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF
          NEW.restaurant_id
            IS DISTINCT FROM
          OLD.restaurant_id

          OR NEW.installation_id
            IS DISTINCT FROM
          OLD.installation_id

          OR NEW.created_at
            IS DISTINCT FROM
          OLD.created_at
        THEN
          RAISE EXCEPTION
            'MAKS Edge sync-state identity is immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS
        trg_edge_sync_state_identity
      ON public.edge_sync_state;

      CREATE TRIGGER
        trg_edge_sync_state_identity
      BEFORE UPDATE
      ON public.edge_sync_state
      FOR EACH ROW
      EXECUTE FUNCTION
        public.edge_sync_state_identity_guard();
    `);

    // =====================================================
    // STATE-MACHINE HARDENING
    //
    // Identity/content immutability alone is not enough.
    // Delivery/apply/idempotency states must not move
    // backwards after terminal completion.
    // =====================================================

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_acked_exclusive_check",
      `
      CHECK (
        (
          status = 'acked'
          AND acked_at IS NOT NULL
        )
        OR
        (
          status <> 'acked'
          AND acked_at IS NULL
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_outbox",
      "edge_outbox_inflight_lock_check",
      `
      CHECK (
        status <> 'in_flight'
        OR (
          locked_at IS NOT NULL
          AND NULLIF(
            TRIM(locked_by),
            ''
          ) IS NOT NULL
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_inbox",
      "edge_inbox_applied_exclusive_check",
      `
      CHECK (
        (
          status = 'applied'
          AND applied_at IS NOT NULL
        )
        OR
        (
          status <> 'applied'
          AND applied_at IS NULL
        )
      )
      `
    );

    await ensureConstraint(
      client,
      "edge_idempotency",
      "edge_idempotency_completed_exclusive_check",
      `
      CHECK (
        (
          status = 'completed'
          AND completed_at IS NOT NULL
        )
        OR
        (
          status <> 'completed'
          AND completed_at IS NULL
        )
      )
      `
    );

    await client.query(`
      CREATE OR REPLACE FUNCTION
        public.edge_outbox_state_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF
          NEW.retry_count <
          OLD.retry_count
        THEN
          RAISE EXCEPTION
            'MAKS Edge outbox retry count cannot decrease'
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status = 'pending'
          AND NEW.status NOT IN (
            'pending',
            'in_flight',
            'dead_letter'
          )
        THEN
          RAISE EXCEPTION
            'Invalid MAKS Edge outbox transition: % -> %',
            OLD.status,
            NEW.status
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status = 'in_flight'
          AND NEW.status NOT IN (
            'in_flight',
            'acked',
            'failed',
            'dead_letter'
          )
        THEN
          RAISE EXCEPTION
            'Invalid MAKS Edge outbox transition: % -> %',
            OLD.status,
            NEW.status
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status = 'failed'
          AND NEW.status NOT IN (
            'failed',
            'in_flight',
            'dead_letter'
          )
        THEN
          RAISE EXCEPTION
            'Invalid MAKS Edge outbox transition: % -> %',
            OLD.status,
            NEW.status
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status IN (
            'acked',
            'dead_letter'
          )
          AND NEW.status <>
            OLD.status
        THEN
          RAISE EXCEPTION
            'Terminal MAKS Edge outbox state cannot be reopened'
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.acked_at IS NOT NULL
          AND NEW.acked_at
            IS DISTINCT FROM
              OLD.acked_at
        THEN
          RAISE EXCEPTION
            'MAKS Edge outbox acknowledgement timestamp is immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS
        trg_edge_outbox_state
      ON public.edge_outbox;

      CREATE TRIGGER
        trg_edge_outbox_state
      BEFORE UPDATE
      ON public.edge_outbox
      FOR EACH ROW
      EXECUTE FUNCTION
        public.edge_outbox_state_guard();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        public.edge_inbox_state_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF
          NEW.apply_attempts <
          OLD.apply_attempts
        THEN
          RAISE EXCEPTION
            'MAKS Edge inbox apply attempts cannot decrease'
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status = 'received'
          AND NEW.status NOT IN (
            'received',
            'applying',
            'dead_letter'
          )
        THEN
          RAISE EXCEPTION
            'Invalid MAKS Edge inbox transition: % -> %',
            OLD.status,
            NEW.status
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status = 'applying'
          AND NEW.status NOT IN (
            'applying',
            'applied',
            'failed',
            'dead_letter'
          )
        THEN
          RAISE EXCEPTION
            'Invalid MAKS Edge inbox transition: % -> %',
            OLD.status,
            NEW.status
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status = 'failed'
          AND NEW.status NOT IN (
            'failed',
            'applying',
            'dead_letter'
          )
        THEN
          RAISE EXCEPTION
            'Invalid MAKS Edge inbox transition: % -> %',
            OLD.status,
            NEW.status
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status IN (
            'applied',
            'dead_letter'
          )
          AND NEW.status <>
            OLD.status
        THEN
          RAISE EXCEPTION
            'Terminal MAKS Edge inbox state cannot be reopened'
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.applied_at IS NOT NULL
          AND NEW.applied_at
            IS DISTINCT FROM
              OLD.applied_at
        THEN
          RAISE EXCEPTION
            'MAKS Edge inbox applied timestamp is immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS
        trg_edge_inbox_state
      ON public.edge_inbox;

      CREATE TRIGGER
        trg_edge_inbox_state
      BEFORE UPDATE
      ON public.edge_inbox
      FOR EACH ROW
      EXECUTE FUNCTION
        public.edge_inbox_state_guard();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        public.edge_idempotency_state_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF
          OLD.status = 'in_progress'
          AND NEW.status NOT IN (
            'in_progress',
            'completed',
            'failed'
          )
        THEN
          RAISE EXCEPTION
            'Invalid MAKS Edge idempotency transition: % -> %',
            OLD.status,
            NEW.status
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.status IN (
            'completed',
            'failed'
          )
          AND NEW.status <>
            OLD.status
        THEN
          RAISE EXCEPTION
            'Terminal MAKS Edge idempotency state cannot be reopened'
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.completed_at IS NOT NULL
          AND NEW.completed_at
            IS DISTINCT FROM
              OLD.completed_at
        THEN
          RAISE EXCEPTION
            'MAKS Edge idempotency completion timestamp is immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS
        trg_edge_idempotency_state
      ON public.edge_idempotency;

      CREATE TRIGGER
        trg_edge_idempotency_state
      BEFORE UPDATE
      ON public.edge_idempotency
      FOR EACH ROW
      EXECUTE FUNCTION
        public.edge_idempotency_state_guard();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION
        public.edge_sync_state_cursor_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF
          OLD.last_acked_outbox_id
            IS NOT NULL
          AND (
            NEW.last_acked_outbox_id
              IS NULL
            OR
            NEW.last_acked_outbox_id <
              OLD.last_acked_outbox_id
          )
        THEN
          RAISE EXCEPTION
            'MAKS Edge outbox cursor cannot move backwards'
            USING ERRCODE = '23514';
        END IF;

        IF
          OLD.last_applied_inbox_id
            IS NOT NULL
          AND (
            NEW.last_applied_inbox_id
              IS NULL
            OR
            NEW.last_applied_inbox_id <
              OLD.last_applied_inbox_id
          )
        THEN
          RAISE EXCEPTION
            'MAKS Edge inbox cursor cannot move backwards'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS
        trg_edge_sync_state_cursor
      ON public.edge_sync_state;

      CREATE TRIGGER
        trg_edge_sync_state_cursor
      BEFORE UPDATE
      ON public.edge_sync_state
      FOR EACH ROW
      EXECUTE FUNCTION
        public.edge_sync_state_cursor_guard();
    `);

    await client.query(
      "COMMIT"
    );

    console.log(
      "✅ Canonical MAKS Edge sync foundation ready"
    );
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  runCanonicalEdgeSyncFoundationPg,
};
