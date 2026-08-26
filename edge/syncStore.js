"use strict";

const crypto = require("crypto");

const {
  withTx,
} = require("../dbCompat");

/*
 * Edge runtime may use a PostgreSQL database that is
 * deliberately different from the backend DATABASE_URL.
 *
 * When an explicit pool is supplied we must transact
 * against THAT pool rather than dbCompat's global pool.
 */
async function withExplicitPoolTx(
  pool,
  fn
) {
  if (
    !pool ||
    typeof pool.connect !== "function"
  ) {
    throw new EdgeSyncError(
      "EDGE_POOL_INVALID",
      "Explicit Edge PostgreSQL pool is invalid"
    );
  }

  if (
    typeof fn !== "function"
  ) {
    throw new EdgeSyncError(
      "EDGE_TX_CALLBACK_INVALID",
      "Edge transaction callback is required"
    );
  }

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const tx = {
      kind: "pg",

      qRun:
        (
          sql,
          params = []
        ) =>
          client.query(
            sql,
            params
          ),

      qGet:
        async (
          sql,
          params = []
        ) =>
          (
            await client.query(
              sql,
              params
            )
          ).rows[0] ||
          null,

      qAll:
        async (
          sql,
          params = []
        ) =>
          (
            await client.query(
              sql,
              params
            )
          ).rows ||
          [],
    };

    const result =
      await fn(tx);

    await client.query(
      "COMMIT"
    );

    return result;
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    throw error;
  } finally {
    client.release();
  }
}


function runSyncTx(
  pool,
  fn
) {
  if (pool) {
    return withExplicitPoolTx(
      pool,
      fn
    );
  }

  return withTx(
    fn
  );
}


class EdgeSyncError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "EdgeSyncError";

    this.code = code;

    if (details !== null) {
      this.details =
        details;
    }
  }
}

/* =========================================================
   VALIDATION / JSON HASHING
========================================================= */

function requireTx(tx) {
  if (
    !tx ||
    typeof tx.qGet !==
      "function" ||
    typeof tx.qAll !==
      "function" ||
    typeof tx.qRun !==
      "function"
  ) {
    throw new EdgeSyncError(
      "EDGE_TX_REQUIRED",
      "MAKS Edge operation requires an active PostgreSQL transaction"
    );
  }

  return tx;
}

function requireRestaurantId(
  value
) {
  const id =
    Number(value);

  if (
    !Number.isSafeInteger(id) ||
    id <= 0
  ) {
    throw new EdgeSyncError(
      "EDGE_RESTAURANT_INVALID",
      "A valid restaurant_id is required"
    );
  }

  return id;
}

function requireUuid(
  value,
  label
) {
  const s =
    String(
      value || ""
    ).trim();

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      s
    )
  ) {
    throw new EdgeSyncError(
      "EDGE_UUID_INVALID",
      `${label} must be a valid UUID`
    );
  }

  return s;
}

function requireText(
  value,
  label,
  {
    max = 255,
  } = {}
) {
  const s =
    String(
      value ?? ""
    ).trim();

  if (!s) {
    throw new EdgeSyncError(
      "EDGE_TEXT_REQUIRED",
      `${label} is required`
    );
  }

  if (
    s.length > max
  ) {
    throw new EdgeSyncError(
      "EDGE_TEXT_TOO_LONG",
      `${label} is too long`
    );
  }

  return s;
}

function optionalText(
  value,
  label,
  {
    max = 255,
  } = {}
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const s =
    String(value).trim();

  if (!s) {
    return null;
  }

  if (
    s.length > max
  ) {
    throw new EdgeSyncError(
      "EDGE_TEXT_TOO_LONG",
      `${label} is too long`
    );
  }

  return s;
}

function boundedInteger(
  value,
  label,
  {
    min = 0,
    max =
      Number.MAX_SAFE_INTEGER,
  } = {}
) {
  const n =
    Number(value);

  if (
    !Number.isSafeInteger(n) ||
    n < min ||
    n > max
  ) {
    throw new EdgeSyncError(
      "EDGE_INTEGER_INVALID",
      `${label} is invalid`
    );
  }

  return n;
}

function jsonSnapshot(
  value,
  label = "JSON value"
) {
  let text;

  try {
    text =
      JSON.stringify(
        value
      );
  } catch {
    throw new EdgeSyncError(
      "EDGE_JSON_INVALID",
      `${label} must be JSON serializable`
    );
  }

  if (
    text === undefined
  ) {
    throw new EdgeSyncError(
      "EDGE_JSON_INVALID",
      `${label} must be JSON serializable`
    );
  }

  let parsed;

  try {
    parsed =
      JSON.parse(text);
  } catch {
    throw new EdgeSyncError(
      "EDGE_JSON_INVALID",
      `${label} is invalid JSON`
    );
  }

  return {
    value: parsed,
    text:
      JSON.stringify(
        parsed
      ),
  };
}

function canonicalJson(
  value
) {
  if (
    value === null ||
    typeof value !==
      "object"
  ) {
    return JSON.stringify(
      value
    );
  }

  if (
    Array.isArray(value)
  ) {
    return (
      "[" +
      value
        .map(
          canonicalJson
        )
        .join(",") +
      "]"
    );
  }

  const keys =
    Object.keys(value)
      .sort();

  return (
    "{" +
    keys
      .map(
        (key) =>
          `${JSON.stringify(
            key
          )}:${canonicalJson(
            value[key]
          )}`
      )
      .join(",") +
    "}"
  );
}

function hashJson(
  value
) {
  const snapshot =
    jsonSnapshot(
      value
    );

  return crypto
    .createHash(
      "sha256"
    )
    .update(
      canonicalJson(
        snapshot.value
      )
    )
    .digest(
      "hex"
    );
}

function normalizeWorkerId(
  workerId
) {
  return requireText(
    workerId,
    "workerId",
    {
      max: 200,
    }
  );
}

function normalizeErrorText(
  value
) {
  return optionalText(
    value,
    "lastError",
    {
      max: 2000,
    }
  );
}

/* =========================================================
   OUTBOX
========================================================= */

async function enqueueEdgeEventTx(
  tx,
  {
    eventId =
      crypto.randomUUID(),

    restaurantId,

    eventType,

    entityType = null,

    entityId = null,

    idempotencyKey,

    payload,
  }
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const eid =
    requireUuid(
      eventId,
      "eventId"
    );

  const type =
    requireText(
      eventType,
      "eventType",
      {
        max: 200,
      }
    );

  const entityTypeSafe =
    optionalText(
      entityType,
      "entityType",
      {
        max: 200,
      }
    );

  const entityIdSafe =
    optionalText(
      entityId,
      "entityId",
      {
        max: 255,
      }
    );

  const key =
    requireText(
      idempotencyKey,
      "idempotencyKey",
      {
        max: 255,
      }
    );

  const snapshot =
    jsonSnapshot(
      payload,
      "Edge event payload"
    );

  const payloadHash =
    hashJson(
      snapshot.value
    );

  try {
    return await tx.qGet(
      `
      INSERT INTO
        public.edge_outbox
      (
        event_id,
        restaurant_id,
        event_type,
        entity_type,
        entity_id,
        idempotency_key,
        payload,
        payload_hash
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb,
        $8
      )
      RETURNING *
      `,
      [
        eid,
        rid,
        type,
        entityTypeSafe,
        entityIdSafe,
        key,
        snapshot.text,
        payloadHash,
      ]
    );
  } catch (error) {
    if (
      error?.code ===
      "23505"
    ) {
      throw new EdgeSyncError(
        "EDGE_OUTBOX_DUPLICATE",
        "MAKS Edge outbox event already exists"
      );
    }

    throw error;
  }
}

async function enqueueEdgeEvent(
  args
) {
  return withTx(
    (tx) =>
      enqueueEdgeEventTx(
        tx,
        args
      )
  );
}

async function claimOutboxEvents({
  restaurantId,

  workerId,

  limit = 25,

  leaseSeconds = 30,

  pool = null,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const worker =
    normalizeWorkerId(
      workerId
    );

  const safeLimit =
    boundedInteger(
      limit,
      "limit",
      {
        min: 1,
        max: 100,
      }
    );

  const safeLease =
    boundedInteger(
      leaseSeconds,
      "leaseSeconds",
      {
        min: 1,
        max: 3600,
      }
    );

  return runSyncTx(
    pool,
    async (tx) =>
      tx.qAll(
        `
        WITH candidates AS (
          SELECT
            id
          FROM
            public.edge_outbox
          WHERE
            restaurant_id = $1
            AND
            (
              (
                status IN (
                  'pending',
                  'failed'
                )
                AND
                next_attempt_at <= NOW()
              )
              OR
              (
                status =
                  'in_flight'
                AND
                locked_at
                  IS NOT NULL
                AND
                locked_at <=
                  NOW()
                  -
                  (
                    $4::int
                    *
                    INTERVAL '1 second'
                  )
              )
            )
          ORDER BY
            id
          FOR UPDATE
          SKIP LOCKED
          LIMIT $3::int
        )
        UPDATE
          public.edge_outbox
            AS o
        SET
          status =
            'in_flight',

          retry_count =
            o.retry_count + 1,

          locked_at =
            NOW(),

          locked_by =
            $2,

          last_attempt_at =
            NOW(),

          last_error =
            NULL,

          updated_at =
            NOW()
        FROM
          candidates c
        WHERE
          o.id = c.id
        RETURNING
          o.*
        `,
        [
          rid,
          worker,
          safeLimit,
          safeLease,
        ]
      )
  );
}

async function ackOutboxEvent({
  restaurantId,

  eventId,

  workerId,

  pool = null,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const eid =
    requireUuid(
      eventId,
      "eventId"
    );

  const worker =
    normalizeWorkerId(
      workerId
    );

  return runSyncTx(
    pool,
    async (tx) => {
      const row =
        await tx.qGet(
          `
          UPDATE
            public.edge_outbox
          SET
            status =
              'acked',

            acked_at =
              NOW(),

            locked_at =
              NULL,

            locked_by =
              NULL,

            last_error =
              NULL,

            updated_at =
              NOW()
          WHERE
            restaurant_id = $1
            AND
            event_id = $2
            AND
            status =
              'in_flight'
            AND
            locked_by = $3
          RETURNING *
          `,
          [
            rid,
            eid,
            worker,
          ]
        );

      if (!row) {
        throw new EdgeSyncError(
          "EDGE_OUTBOX_NOT_OWNED",
          "Outbox event is not owned by this worker"
        );
      }

      return row;
    }
  );
}

async function failOutboxEvent({
  restaurantId,

  eventId,

  workerId,

  lastError,

  retryDelaySeconds = 0,

  pool = null,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const eid =
    requireUuid(
      eventId,
      "eventId"
    );

  const worker =
    normalizeWorkerId(
      workerId
    );

  const errorText =
    normalizeErrorText(
      lastError
    );

  const delay =
    boundedInteger(
      retryDelaySeconds,
      "retryDelaySeconds",
      {
        min: 0,
        max: 86400,
      }
    );

  return runSyncTx(
    pool,
    async (tx) => {
      const row =
        await tx.qGet(
          `
          UPDATE
            public.edge_outbox
          SET
            status =
              'failed',

            locked_at =
              NULL,

            locked_by =
              NULL,

            last_error =
              $4,

            next_attempt_at =
              NOW()
              +
              (
                $5::int
                *
                INTERVAL '1 second'
              ),

            updated_at =
              NOW()
          WHERE
            restaurant_id = $1
            AND
            event_id = $2
            AND
            status =
              'in_flight'
            AND
            locked_by = $3
          RETURNING *
          `,
          [
            rid,
            eid,
            worker,
            errorText,
            delay,
          ]
        );

      if (!row) {
        throw new EdgeSyncError(
          "EDGE_OUTBOX_NOT_OWNED",
          "Outbox event is not owned by this worker"
        );
      }

      return row;
    }
  );
}

/* =========================================================
   INBOX
========================================================= */

async function receiveInboxEventTx(
  tx,
  {
    eventId,

    restaurantId,

    source =
      "cloud",

    sourceInstallationId =
      null,

    eventType,

    entityType = null,

    entityId = null,

    payload,
  }
) {
  requireTx(tx);

  const eid =
    requireUuid(
      eventId,
      "eventId"
    );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const sourceSafe =
    requireText(
      source,
      "source",
      {
        max: 32,
      }
    );

  if (
    ![
      "cloud",
      "edge",
    ].includes(
      sourceSafe
    )
  ) {
    throw new EdgeSyncError(
      "EDGE_INBOX_SOURCE_INVALID",
      "Inbox source must be cloud or edge"
    );
  }

  const sourceInstall =
    sourceInstallationId
      ? requireUuid(
          sourceInstallationId,
          "sourceInstallationId"
        )
      : null;

  const type =
    requireText(
      eventType,
      "eventType",
      {
        max: 200,
      }
    );

  const entityTypeSafe =
    optionalText(
      entityType,
      "entityType",
      {
        max: 200,
      }
    );

  const entityIdSafe =
    optionalText(
      entityId,
      "entityId",
      {
        max: 255,
      }
    );

  const snapshot =
    jsonSnapshot(
      payload,
      "Inbox payload"
    );

  const payloadHash =
    hashJson(
      snapshot.value
    );

  const inserted =
    await tx.qGet(
      `
      INSERT INTO
        public.edge_inbox
      (
        event_id,
        restaurant_id,
        source,
        source_installation_id,
        event_type,
        entity_type,
        entity_id,
        payload,
        payload_hash
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9
      )
      ON CONFLICT (
        event_id
      )
      DO NOTHING
      RETURNING *
      `,
      [
        eid,
        rid,
        sourceSafe,
        sourceInstall,
        type,
        entityTypeSafe,
        entityIdSafe,
        snapshot.text,
        payloadHash,
      ]
    );

  if (inserted) {
    return {
      ...inserted,
      duplicate: false,
    };
  }

  const existing =
    await tx.qGet(
      `
      SELECT *
      FROM
        public.edge_inbox
      WHERE
        event_id = $1
      FOR UPDATE
      `,
      [eid]
    );

  if (!existing) {
    throw new EdgeSyncError(
      "EDGE_INBOX_REPLAY_RACE",
      "Inbox replay disappeared during verification"
    );
  }

  const same =
    Number(
      existing.restaurant_id
    ) === rid &&
    existing.source ===
      sourceSafe &&
    (
      existing.source_installation_id ||
      null
    ) ===
      sourceInstall &&
    existing.event_type ===
      type &&
    (
      existing.entity_type ||
      null
    ) ===
      entityTypeSafe &&
    (
      existing.entity_id ||
      null
    ) ===
      entityIdSafe &&
    existing.payload_hash ===
      payloadHash;

  if (!same) {
    throw new EdgeSyncError(
      "EDGE_INBOX_REPLAY_CONFLICT",
      "Inbox event_id was replayed with different identity or content"
    );
  }

  return {
    ...existing,
    duplicate: true,
  };
}

async function receiveInboxEvent(
  args
) {
  const {
    pool = null,
    ...eventArgs
  } =
    args || {};

  return runSyncTx(
    pool,
    (tx) =>
      receiveInboxEventTx(
        tx,
        eventArgs
      )
  );
}

async function claimInboxEvents({
  restaurantId,

  workerId,

  limit = 25,

  leaseSeconds = 30,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const worker =
    normalizeWorkerId(
      workerId
    );

  const safeLimit =
    boundedInteger(
      limit,
      "limit",
      {
        min: 1,
        max: 100,
      }
    );

  const safeLease =
    boundedInteger(
      leaseSeconds,
      "leaseSeconds",
      {
        min: 1,
        max: 3600,
      }
    );

  return withTx(
    async (tx) =>
      tx.qAll(
        `
        WITH candidates AS (
          SELECT
            id
          FROM
            public.edge_inbox
          WHERE
            restaurant_id = $1
            AND
            (
              (
                status IN (
                  'received',
                  'failed'
                )
                AND
                next_attempt_at <= NOW()
              )
              OR
              (
                status =
                  'applying'
                AND
                locked_at
                  IS NOT NULL
                AND
                locked_at <=
                  NOW()
                  -
                  (
                    $4::int
                    *
                    INTERVAL '1 second'
                  )
              )
            )
          ORDER BY
            id
          FOR UPDATE
          SKIP LOCKED
          LIMIT $3::int
        )
        UPDATE
          public.edge_inbox
            AS i
        SET
          status =
            'applying',

          apply_attempts =
            i.apply_attempts + 1,

          locked_at =
            NOW(),

          locked_by =
            $2,

          last_attempt_at =
            NOW(),

          last_error =
            NULL,

          updated_at =
            NOW()
        FROM
          candidates c
        WHERE
          i.id = c.id
        RETURNING
          i.*
        `,
        [
          rid,
          worker,
          safeLimit,
          safeLease,
        ]
      )
  );
}

async function markInboxApplied({
  restaurantId,

  eventId,

  workerId,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const eid =
    requireUuid(
      eventId,
      "eventId"
    );

  const worker =
    normalizeWorkerId(
      workerId
    );

  return withTx(
    async (tx) => {
      const row =
        await tx.qGet(
          `
          UPDATE
            public.edge_inbox
          SET
            status =
              'applied',

            applied_at =
              NOW(),

            locked_at =
              NULL,

            locked_by =
              NULL,

            last_error =
              NULL,

            updated_at =
              NOW()
          WHERE
            restaurant_id = $1
            AND
            event_id = $2
            AND
            status =
              'applying'
            AND
            locked_by = $3
          RETURNING *
          `,
          [
            rid,
            eid,
            worker,
          ]
        );

      if (!row) {
        throw new EdgeSyncError(
          "EDGE_INBOX_NOT_OWNED",
          "Inbox event is not owned by this worker"
        );
      }

      return row;
    }
  );
}

async function failInboxEvent({
  restaurantId,

  eventId,

  workerId,

  lastError,

  retryDelaySeconds = 0,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const eid =
    requireUuid(
      eventId,
      "eventId"
    );

  const worker =
    normalizeWorkerId(
      workerId
    );

  const errorText =
    normalizeErrorText(
      lastError
    );

  const delay =
    boundedInteger(
      retryDelaySeconds,
      "retryDelaySeconds",
      {
        min: 0,
        max: 86400,
      }
    );

  return withTx(
    async (tx) => {
      const row =
        await tx.qGet(
          `
          UPDATE
            public.edge_inbox
          SET
            status =
              'failed',

            locked_at =
              NULL,

            locked_by =
              NULL,

            last_error =
              $4,

            next_attempt_at =
              NOW()
              +
              (
                $5::int
                *
                INTERVAL '1 second'
              ),

            updated_at =
              NOW()
          WHERE
            restaurant_id = $1
            AND
            event_id = $2
            AND
            status =
              'applying'
            AND
            locked_by = $3
          RETURNING *
          `,
          [
            rid,
            eid,
            worker,
            errorText,
            delay,
          ]
        );

      if (!row) {
        throw new EdgeSyncError(
          "EDGE_INBOX_NOT_OWNED",
          "Inbox event is not owned by this worker"
        );
      }

      return row;
    }
  );
}

/* =========================================================
   IDEMPOTENCY
========================================================= */

async function beginIdempotentOperationTx(
  tx,
  {
    restaurantId,

    scope,

    idempotencyKey,

    requestPayload,
  }
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const scopeSafe =
    requireText(
      scope,
      "scope",
      {
        max: 200,
      }
    );

  const key =
    requireText(
      idempotencyKey,
      "idempotencyKey",
      {
        max: 255,
      }
    );

  const requestHash =
    hashJson(
      requestPayload
    );

  const inserted =
    await tx.qGet(
      `
      INSERT INTO
        public.edge_idempotency
      (
        restaurant_id,
        scope,
        idempotency_key,
        request_hash
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4
      )
      ON CONFLICT (
        restaurant_id,
        scope,
        idempotency_key
      )
      DO NOTHING
      RETURNING *
      `,
      [
        rid,
        scopeSafe,
        key,
        requestHash,
      ]
    );

  if (inserted) {
    return {
      state:
        "started",

      record:
        inserted,
    };
  }

  const existing =
    await tx.qGet(
      `
      SELECT *
      FROM
        public.edge_idempotency
      WHERE
        restaurant_id = $1
        AND
        scope = $2
        AND
        idempotency_key = $3
      FOR UPDATE
      `,
      [
        rid,
        scopeSafe,
        key,
      ]
    );

  if (!existing) {
    throw new EdgeSyncError(
      "EDGE_IDEMPOTENCY_RACE",
      "Idempotency record disappeared during verification"
    );
  }

  if (
    existing.request_hash !==
    requestHash
  ) {
    throw new EdgeSyncError(
      "EDGE_IDEMPOTENCY_CONFLICT",
      "Idempotency key was reused for a different request"
    );
  }

  if (
    existing.status ===
    "completed"
  ) {
    return {
      state:
        "completed",

      record:
        existing,

      responseStatus:
        existing.response_status,

      responseBody:
        existing.response_body,
    };
  }

  if (
    existing.status ===
    "failed"
  ) {
    return {
      state:
        "failed",

      record:
        existing,
    };
  }

  return {
    state:
      "in_progress",

    record:
      existing,
  };
}

async function completeIdempotentOperationTx(
  tx,
  {
    id,

    responseStatus = 200,

    responseBody = null,
  }
) {
  requireTx(tx);

  const recordId =
    boundedInteger(
      id,
      "idempotency id",
      {
        min: 1,
      }
    );

  const status =
    boundedInteger(
      responseStatus,
      "responseStatus",
      {
        min: 100,
        max: 599,
      }
    );

  const snapshot =
    jsonSnapshot(
      responseBody,
      "Idempotency response body"
    );

  const row =
    await tx.qGet(
      `
      UPDATE
        public.edge_idempotency
      SET
        status =
          'completed',

        response_status =
          $2,

        response_body =
          $3::jsonb,

        completed_at =
          NOW(),

        updated_at =
          NOW()
      WHERE
        id = $1
        AND
        status =
          'in_progress'
      RETURNING *
      `,
      [
        recordId,
        status,
        snapshot.text,
      ]
    );

  if (!row) {
    throw new EdgeSyncError(
      "EDGE_IDEMPOTENCY_NOT_ACTIVE",
      "Idempotency operation is no longer active"
    );
  }

  return row;
}

/* =========================================================
   ATOMIC BUSINESS OPERATION + OUTBOX
========================================================= */

async function withEdgeOperation({
  restaurantId,

  scope,

  idempotencyKey,

  requestPayload,

  execute,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  if (
    typeof execute !==
    "function"
  ) {
    throw new EdgeSyncError(
      "EDGE_EXECUTE_REQUIRED",
      "withEdgeOperation requires an execute function"
    );
  }

  return withTx(
    async (tx) => {
      const gate =
        await beginIdempotentOperationTx(
          tx,
          {
            restaurantId:
              rid,

            scope,

            idempotencyKey,

            requestPayload,
          }
        );

      if (
        gate.state ===
        "completed"
      ) {
        return {
          replayed: true,

          responseStatus:
            gate.responseStatus,

          responseBody:
            gate.responseBody,
        };
      }

      if (
        gate.state ===
        "failed"
      ) {
        throw new EdgeSyncError(
          "EDGE_IDEMPOTENCY_FAILED",
          "This idempotent operation previously failed permanently"
        );
      }

      if (
        gate.state ===
        "in_progress"
      ) {
        throw new EdgeSyncError(
          "EDGE_IDEMPOTENCY_IN_PROGRESS",
          "This idempotent operation is already in progress"
        );
      }

      const result =
        await execute({
          tx,

          enqueueEdgeEvent:
            async (
              event
            ) => {
              if (
                event &&
                event.restaurantId !==
                  undefined &&
                requireRestaurantId(
                  event.restaurantId
                ) !== rid
              ) {
                throw new EdgeSyncError(
                  "EDGE_TENANT_MISMATCH",
                  "Edge event restaurant does not match transaction restaurant"
                );
              }

              return enqueueEdgeEventTx(
                tx,
                {
                  ...event,

                  restaurantId:
                    rid,
                }
              );
            },
        });

      const structured =
        result &&
        typeof result ===
          "object" &&
        !Array.isArray(
          result
        ) &&
        (
          Object.prototype.hasOwnProperty.call(
            result,
            "responseStatus"
          ) ||
          Object.prototype.hasOwnProperty.call(
            result,
            "responseBody"
          )
        );

      const responseStatus =
        structured &&
        result.responseStatus !==
          undefined
          ? boundedInteger(
              result.responseStatus,
              "responseStatus",
              {
                min: 100,
                max: 599,
              }
            )
          : 200;

      const responseBody =
        structured
          ? (
              result.responseBody ??
              null
            )
          : (
              result ??
              null
            );

      await completeIdempotentOperationTx(
        tx,
        {
          id:
            gate.record.id,

          responseStatus,

          responseBody,
        }
      );

      return {
        replayed: false,

        responseStatus,

        responseBody,
      };
    }
  );
}

/* =========================================================
   SYNC STATE
========================================================= */

async function ensureSyncState({
  restaurantId,

  installationId,

  pool = null,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const iid =
    requireUuid(
      installationId,
      "installationId"
    );

  return runSyncTx(
    pool,
    async (tx) => {
      await tx.qRun(
        `
        INSERT INTO
          public.edge_sync_state
        (
          restaurant_id,
          installation_id
        )
        VALUES
        (
          $1,
          $2
        )
        ON CONFLICT (
          restaurant_id,
          installation_id
        )
        DO NOTHING
        `,
        [
          rid,
          iid,
        ]
      );

      return tx.qGet(
        `
        SELECT *
        FROM
          public.edge_sync_state
        WHERE
          restaurant_id = $1
          AND
          installation_id = $2
        `,
        [
          rid,
          iid,
        ]
      );
    }
  );
}

async function updateSyncState({
  restaurantId,

  installationId,

  patch,

  pool = null,
}) {
  const rid =
    requireRestaurantId(
      restaurantId
    );

  const iid =
    requireUuid(
      installationId,
      "installationId"
    );

  if (
    !patch ||
    typeof patch !==
      "object" ||
    Array.isArray(patch)
  ) {
    throw new EdgeSyncError(
      "EDGE_SYNC_PATCH_INVALID",
      "Sync-state patch must be an object"
    );
  }

  const sets = [];
  const params = [
    rid,
    iid,
  ];

  function add(
    column,
    value
  ) {
    params.push(value);

    sets.push(
      `${column} = $${params.length}`
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "syncStatus"
    )
  ) {
    const status =
      requireText(
        patch.syncStatus,
        "syncStatus",
        {
          max: 32,
        }
      );

    if (
      ![
        "unknown",
        "synced",
        "pending",
        "syncing",
        "error",
      ].includes(
        status
      )
    ) {
      throw new EdgeSyncError(
        "EDGE_SYNC_STATUS_INVALID",
        "Invalid Edge sync status"
      );
    }

    add(
      "sync_status",
      status
    );
  }

  const integerFields = [
    [
      "pendingOutboxEvents",
      "pending_outbox_events",
    ],

    [
      "pendingInboxEvents",
      "pending_inbox_events",
    ],

    [
      "consecutiveFailures",
      "consecutive_failures",
    ],
  ];

  for (
    const [
      input,
      column,
    ] of integerFields
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        patch,
        input
      )
    ) {
      add(
        column,
        boundedInteger(
          patch[input],
          input,
          {
            min: 0,
          }
        )
      );
    }
  }

  const cursorFields = [
    [
      "lastAckedOutboxId",
      "last_acked_outbox_id",
    ],

    [
      "lastAppliedInboxId",
      "last_applied_inbox_id",
    ],
  ];

  for (
    const [
      input,
      column,
    ] of cursorFields
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        patch,
        input
      )
    ) {
      if (
        patch[input] ===
        null
      ) {
        add(
          column,
          null
        );
      } else {
        add(
          column,
          boundedInteger(
            patch[input],
            input,
            {
              min: 0,
            }
          )
        );
      }
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "cloudCursor"
    )
  ) {
    add(
      "cloud_cursor",
      optionalText(
        patch.cloudCursor,
        "cloudCursor",
        {
          max: 1000,
        }
      )
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "lastError"
    )
  ) {
    add(
      "last_error",
      normalizeErrorText(
        patch.lastError
      )
    );
  }

  const timestampFields = [
    [
      "lastPushAt",
      "last_push_at",
    ],

    [
      "lastPullAt",
      "last_pull_at",
    ],

    [
      "lastSuccessAt",
      "last_success_at",
    ],
  ];

  for (
    const [
      input,
      column,
    ] of timestampFields
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        patch,
        input
      )
    ) {
      const value =
        patch[input];

      if (
        value === null
      ) {
        add(
          column,
          null
        );

        continue;
      }

      const date =
        value instanceof Date
          ? value
          : new Date(
              value
            );

      if (
        Number.isNaN(
          date.getTime()
        )
      ) {
        throw new EdgeSyncError(
          "EDGE_TIMESTAMP_INVALID",
          `${input} is invalid`
        );
      }

      add(
        column,
        date
      );
    }
  }

  if (!sets.length) {
    throw new EdgeSyncError(
      "EDGE_SYNC_PATCH_EMPTY",
      "Sync-state patch contains no supported fields"
    );
  }

  sets.push(
    "updated_at = NOW()"
  );

  return runSyncTx(
    pool,
    async (tx) => {
      await tx.qRun(
        `
        INSERT INTO
          public.edge_sync_state
        (
          restaurant_id,
          installation_id
        )
        VALUES
        (
          $1,
          $2
        )
        ON CONFLICT (
          restaurant_id,
          installation_id
        )
        DO NOTHING
        `,
        [
          rid,
          iid,
        ]
      );

      const row =
        await tx.qGet(
          `
          UPDATE
            public.edge_sync_state
          SET
            ${sets.join(
              ",\n"
            )}
          WHERE
            restaurant_id = $1
            AND
            installation_id = $2
          RETURNING *
          `,
          params
        );

      if (!row) {
        throw new EdgeSyncError(
          "EDGE_SYNC_STATE_MISSING",
          "Edge sync state could not be updated"
        );
      }

      return row;
    }
  );
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  EdgeSyncError,

  hashJson,

  enqueueEdgeEvent,
  enqueueEdgeEventTx,

  claimOutboxEvents,
  ackOutboxEvent,
  failOutboxEvent,

  receiveInboxEvent,
  receiveInboxEventTx,

  claimInboxEvents,
  markInboxApplied,
  failInboxEvent,

  beginIdempotentOperationTx,
  completeIdempotentOperationTx,

  withEdgeOperation,

  ensureSyncState,
  updateSyncState,
};
