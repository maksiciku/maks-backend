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

  eventTypes = null,

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

  let safeEventTypes =
    null;

  if (
    eventTypes !== null &&
    eventTypes !== undefined
  ) {
    if (
      !Array.isArray(
        eventTypes
      ) ||
      eventTypes.length < 1 ||
      eventTypes.length > 100
    ) {
      throw new EdgeSyncError(
        "EDGE_OUTBOX_EVENT_TYPES_INVALID",
        "Outbox eventTypes must be a non-empty array of at most 100 event types"
      );
    }

    safeEventTypes =
      [
        ...new Set(
          eventTypes.map(
            (value) =>
              String(
                value || ""
              ).trim()
          )
        ),
      ];

    if (
      safeEventTypes.some(
        (value) =>
          !value ||
          value.length > 255
      )
    ) {
      throw new EdgeSyncError(
        "EDGE_OUTBOX_EVENT_TYPES_INVALID",
        "Outbox eventTypes contains an invalid event type"
      );
    }
  }

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
              $5::text[]
                IS NULL
              OR
              event_type =
                ANY(
                  $5::text[]
                )
            )
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
          safeEventTypes,
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


async function deadLetterInboxEvent({
  restaurantId,

  eventId,

  workerId,

  lastError,

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
    ) ||
    "MAKS Edge inbox event was dead-lettered";

  return runSyncTx(
    pool,
    async (tx) => {
      const row =
        await tx.qGet(
          `
          UPDATE
            public.edge_inbox
          SET
            status =
              'dead_letter',

            locked_at =
              NULL,

            locked_by =
              NULL,

            last_error =
              $4,

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


async function applyClaimedInboxEvent({
  restaurantId,

  eventId,

  workerId,

  execute,

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

  if (
    typeof execute !==
      "function"
  ) {
    throw new EdgeSyncError(
      "EDGE_INBOX_EXECUTE_REQUIRED",
      "Inbox application requires an execute function"
    );
  }

  return runSyncTx(
    pool,
    async (tx) => {
      const event =
        await tx.qGet(
          `
          SELECT *
          FROM
            public.edge_inbox
          WHERE
            restaurant_id = $1
            AND
            event_id = $2
            AND
            status =
              'applying'
            AND
            locked_by = $3
          FOR UPDATE
          `,
          [
            rid,
            eid,
            worker,
          ]
        );

      if (!event) {
        throw new EdgeSyncError(
          "EDGE_INBOX_NOT_OWNED",
          "Inbox event is not owned by this worker"
        );
      }

      const identity = {
        event_id:
          String(
            event.event_id
          ),

        restaurant_id:
          rid,

        source:
          event.source,

        source_installation_id:
          event.source_installation_id ||
          null,

        event_type:
          event.event_type,

        entity_type:
          event.entity_type ||
          null,

        entity_id:
          event.entity_id ||
          null,

        payload_hash:
          event.payload_hash,
      };

      const gate =
        await beginIdempotentOperationTx(
          tx,
          {
            restaurantId:
              rid,

            scope:
              "edge.inbox.apply",

            idempotencyKey:
              eid,

            requestPayload:
              identity,
          }
        );

      if (
        gate.state ===
          "failed" ||
        gate.state ===
          "in_progress"
      ) {
        throw new EdgeSyncError(
          gate.state === "failed"
            ? "EDGE_IDEMPOTENCY_FAILED"
            : "EDGE_IDEMPOTENCY_IN_PROGRESS",
          gate.state === "failed"
            ? "This inbox event previously failed permanently"
            : "This inbox event is already being applied"
        );
      }

      let result =
        gate.responseBody;

      const replayed =
        gate.state ===
        "completed";

      if (!replayed) {
        result =
          await execute({
            tx,

            restaurantId:
              rid,

            event,

            payload:
              event.payload,
          });

        await completeIdempotentOperationTx(
          tx,
          {
            id:
              gate.record.id,

            responseStatus:
              200,

            responseBody:
              result ??
              null,
          }
        );
      }

      const applied =
        await tx.qGet(
          `
          UPDATE
            public.edge_inbox
          SET
            status =
              'applied',

            applied_at =
              COALESCE(
                applied_at,
                NOW()
              ),

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

      if (!applied) {
        throw new EdgeSyncError(
          "EDGE_INBOX_NOT_OWNED",
          "Inbox event is not owned by this worker"
        );
      }

      return {
        replayed,

        event:
          applied,

        result:
          result ??
          null,
      };
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


const SYNC_STATUS_VALUES =
  new Set([
    "unknown",
    "synced",
    "pending",
    "syncing",
    "error",
  ]);


function normalizeSyncStatus(
  value,
  label
) {
  const status =
    requireText(
      value,
      label,
      {
        max: 32,
      }
    );

  if (
    !SYNC_STATUS_VALUES.has(
      status
    )
  ) {
    throw new EdgeSyncError(
      "EDGE_SYNC_STATUS_INVALID",
      `Invalid ${label}`
    );
  }

  return status;
}


function normalizeTimestamp(
  value,
  label
) {
  if (value === null) {
    return null;
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
      `${label} is invalid`
    );
  }

  return date;
}


function latestTimestamp(
  first,
  second
) {
  const values =
    [
      first,
      second,
    ]
      .filter(Boolean)
      .map(
        (value) =>
          value instanceof Date
            ? value
            : new Date(
                value
              )
      )
      .filter(
        (value) =>
          !Number.isNaN(
            value.getTime()
          )
      );

  if (!values.length) {
    return null;
  }

  return new Date(
    Math.max(
      ...values.map(
        (value) =>
          value.getTime()
      )
    )
  );
}


function deriveAggregateSyncState(
  row
) {
  const pushStatus =
    row.push_status ||
    "unknown";

  const pullStatus =
    row.pull_status ||
    "unknown";

  const pendingOutbox =
    Number(
      row.pending_outbox_events ||
      0
    );

  const pendingInbox =
    Number(
      row.pending_inbox_events ||
      0
    );

  let syncStatus =
    "unknown";

  if (
    pushStatus === "error" ||
    pullStatus === "error"
  ) {
    syncStatus =
      "error";
  } else if (
    pushStatus === "syncing" ||
    pullStatus === "syncing"
  ) {
    syncStatus =
      "syncing";
  } else if (
    pushStatus === "pending" ||
    pullStatus === "pending" ||
    pendingOutbox > 0 ||
    pendingInbox > 0
  ) {
    syncStatus =
      "pending";
  } else if (
    (
      pushStatus === "synced" &&
      [
        "synced",
        "unknown",
      ].includes(
        pullStatus
      )
    ) ||
    (
      pullStatus === "synced" &&
      [
        "synced",
        "unknown",
      ].includes(
        pushStatus
      )
    )
  ) {
    /*
     * Transitional compatibility:
     * before automatic pull is wired, the untouched
     * direction is "unknown". A known-good direction
     * remains aggregate-synced unless the other direction
     * has actually reported an error.
     */
    syncStatus =
      "synced";
  }

  const failures =
    Math.max(
      Number(
        row.push_consecutive_failures ||
        0
      ),
      Number(
        row.pull_consecutive_failures ||
        0
      )
    );

  const errors =
    [];

  if (
    pushStatus === "error"
  ) {
    errors.push(
      `Push: ${
        String(
          row.last_push_error ||
          "MAKS Edge push failed"
        ).slice(
          0,
          980
        )
      }`
    );
  }

  if (
    pullStatus === "error"
  ) {
    errors.push(
      `Pull: ${
        String(
          row.last_pull_error ||
          "MAKS Edge pull failed"
        ).slice(
          0,
          980
        )
      }`
    );
  }

  return {
    syncStatus,

    consecutiveFailures:
      failures,

    lastSuccessAt:
      latestTimestamp(
        row.last_success_at,
        latestTimestamp(
          row.last_push_success_at,
          row.last_pull_success_at
        )
      ),

    lastError:
      errors.length
        ? errors
            .join(
              " | "
            )
            .slice(
              0,
              2000
            )
        : null,
  };
}


async function updateDirectionalSyncState({
  restaurantId,

  installationId,

  direction,

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

  const directionSafe =
    requireText(
      direction,
      "direction",
      {
        max: 16,
      }
    );

  if (
    ![
      "push",
      "pull",
    ].includes(
      directionSafe
    )
  ) {
    throw new EdgeSyncError(
      "EDGE_SYNC_DIRECTION_INVALID",
      "Sync direction must be push or pull"
    );
  }

  if (
    !patch ||
    typeof patch !==
      "object" ||
    Array.isArray(patch)
  ) {
    throw new EdgeSyncError(
      "EDGE_SYNC_PATCH_INVALID",
      "Directional sync-state patch must be an object"
    );
  }

  const normalized = {};

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "status"
    )
  ) {
    normalized.status =
      normalizeSyncStatus(
        patch.status,
        `${directionSafe}Status`
      );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "pendingOutboxEvents"
    )
  ) {
    normalized.pendingOutboxEvents =
      boundedInteger(
        patch.pendingOutboxEvents,
        "pendingOutboxEvents",
        {
          min: 0,
        }
      );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "pendingInboxEvents"
    )
  ) {
    normalized.pendingInboxEvents =
      boundedInteger(
        patch.pendingInboxEvents,
        "pendingInboxEvents",
        {
          min: 0,
        }
      );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "failureMode"
    )
  ) {
    const mode =
      requireText(
        patch.failureMode,
        "failureMode",
        {
          max: 16,
        }
      );

    if (
      ![
        "preserve",
        "increment",
        "reset",
      ].includes(
        mode
      )
    ) {
      throw new EdgeSyncError(
        "EDGE_SYNC_FAILURE_MODE_INVALID",
        "failureMode must be preserve, increment or reset"
      );
    }

    normalized.failureMode =
      mode;
  } else {
    normalized.failureMode =
      "preserve";
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "lastAttemptAt"
    )
  ) {
    normalized.lastAttemptAt =
      normalizeTimestamp(
        patch.lastAttemptAt,
        "lastAttemptAt"
      );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "lastSuccessAt"
    )
  ) {
    normalized.lastSuccessAt =
      normalizeTimestamp(
        patch.lastSuccessAt,
        "lastSuccessAt"
      );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "lastError"
    )
  ) {
    normalized.lastError =
      normalizeErrorText(
        patch.lastError
      );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "lastAckedOutboxId"
    )
  ) {
    normalized.lastAckedOutboxId =
      patch.lastAckedOutboxId ===
        null
        ? null
        : boundedInteger(
            patch.lastAckedOutboxId,
            "lastAckedOutboxId",
            {
              min: 0,
            }
          );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "lastAppliedInboxId"
    )
  ) {
    normalized.lastAppliedInboxId =
      patch.lastAppliedInboxId ===
        null
        ? null
        : boundedInteger(
            patch.lastAppliedInboxId,
            "lastAppliedInboxId",
            {
              min: 0,
            }
          );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "cloudCursor"
    )
  ) {
    normalized.cloudCursor =
      optionalText(
        patch.cloudCursor,
        "cloudCursor",
        {
          max: 1000,
        }
      );
  }

  const supportedInputs =
    [
      "status",
      "pendingOutboxEvents",
      "pendingInboxEvents",
      "failureMode",
      "lastAttemptAt",
      "lastSuccessAt",
      "lastError",
      "lastAckedOutboxId",
      "lastAppliedInboxId",
      "cloudCursor",
    ];

  const suppliedInputs =
    Object.keys(
      patch
    );

  if (
    !suppliedInputs.length ||
    suppliedInputs.some(
      (key) =>
        !supportedInputs.includes(
          key
        )
    )
  ) {
    throw new EdgeSyncError(
      "EDGE_SYNC_PATCH_INVALID",
      "Directional sync-state patch contains unsupported fields"
    );
  }

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

      const current =
        await tx.qGet(
          `
          SELECT *
          FROM
            public.edge_sync_state
          WHERE
            restaurant_id = $1
            AND
            installation_id = $2
          FOR UPDATE
          `,
          [
            rid,
            iid,
          ]
        );

      if (!current) {
        throw new EdgeSyncError(
          "EDGE_SYNC_STATE_MISSING",
          "Edge sync state could not be locked"
        );
      }

      const next = {
        ...current,
      };

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "status"
        )
      ) {
        next[
          `${directionSafe}_status`
        ] =
          normalized.status;
      }

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "pendingOutboxEvents"
        )
      ) {
        next.pending_outbox_events =
          normalized.pendingOutboxEvents;
      }

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "pendingInboxEvents"
        )
      ) {
        next.pending_inbox_events =
          normalized.pendingInboxEvents;
      }

      const failureColumn =
        `${directionSafe}_consecutive_failures`;

      if (
        normalized.failureMode ===
          "increment"
      ) {
        next[failureColumn] =
          Number(
            current[failureColumn] ||
            0
          ) + 1;
      } else if (
        normalized.failureMode ===
          "reset"
      ) {
        next[failureColumn] =
          0;
      }

      const attemptColumn =
        directionSafe ===
          "push"
          ? "last_push_at"
          : "last_pull_at";

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "lastAttemptAt"
        )
      ) {
        next[attemptColumn] =
          normalized.lastAttemptAt;
      }

      const successColumn =
        directionSafe ===
          "push"
          ? "last_push_success_at"
          : "last_pull_success_at";

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "lastSuccessAt"
        )
      ) {
        next[successColumn] =
          normalized.lastSuccessAt;
      }

      const errorColumn =
        directionSafe ===
          "push"
          ? "last_push_error"
          : "last_pull_error";

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "lastError"
        )
      ) {
        next[errorColumn] =
          normalized.lastError;
      }

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "lastAckedOutboxId"
        )
      ) {
        next.last_acked_outbox_id =
          normalized.lastAckedOutboxId;
      }

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "lastAppliedInboxId"
        )
      ) {
        next.last_applied_inbox_id =
          normalized.lastAppliedInboxId;
      }

      if (
        Object.prototype.hasOwnProperty.call(
          normalized,
          "cloudCursor"
        )
      ) {
        next.cloud_cursor =
          normalized.cloudCursor;
      }

      const aggregate =
        deriveAggregateSyncState(
          next
        );

      const row =
        await tx.qGet(
          `
          UPDATE
            public.edge_sync_state
          SET
            push_status = $3,
            pull_status = $4,

            pending_outbox_events = $5,
            pending_inbox_events = $6,

            last_acked_outbox_id = $7,
            last_applied_inbox_id = $8,
            cloud_cursor = $9,

            last_push_at = $10,
            last_pull_at = $11,

            last_push_success_at = $12,
            last_pull_success_at = $13,

            last_push_error = $14,
            last_pull_error = $15,

            push_consecutive_failures = $16,
            pull_consecutive_failures = $17,

            sync_status = $18,
            consecutive_failures = $19,
            last_success_at = $20,
            last_error = $21,

            updated_at = NOW()
          WHERE
            restaurant_id = $1
            AND installation_id = $2
          RETURNING *
          `,
          [
            rid,
            iid,

            next.push_status,
            next.pull_status,

            Number(
              next.pending_outbox_events ||
              0
            ),
            Number(
              next.pending_inbox_events ||
              0
            ),

            next.last_acked_outbox_id ??
              null,
            next.last_applied_inbox_id ??
              null,
            next.cloud_cursor ??
              null,

            next.last_push_at ||
              null,
            next.last_pull_at ||
              null,

            next.last_push_success_at ||
              null,
            next.last_pull_success_at ||
              null,

            next.last_push_error ||
              null,
            next.last_pull_error ||
              null,

            Number(
              next.push_consecutive_failures ||
              0
            ),
            Number(
              next.pull_consecutive_failures ||
              0
            ),

            aggregate.syncStatus,
            aggregate.consecutiveFailures,
            aggregate.lastSuccessAt,
            aggregate.lastError,
          ]
        );

      if (!row) {
        throw new EdgeSyncError(
          "EDGE_SYNC_STATE_MISSING",
          "Edge directional sync state could not be updated"
        );
      }

      return row;
    }
  );
}


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
  deadLetterInboxEvent,
  applyClaimedInboxEvent,

  beginIdempotentOperationTx,
  completeIdempotentOperationTx,

  withEdgeOperation,

  ensureSyncState,
  updateSyncState,
  updateDirectionalSyncState,
};
