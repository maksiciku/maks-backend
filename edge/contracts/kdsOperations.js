"use strict";

const {
  enqueueEdgeEventTx,
  hashJson,
} = require(
  "../syncStore"
);

const {
  EdgeDomainRevisionError,
  nextProducedRevisionTx,
  applyDomainRevisionTx,
} = require(
  "../domainRevisionStore"
);

const {
  RUNTIME_ROLES,
  getRuntimeRole,
  assertCloudRuntime,
} = require(
  "../../utils/runtimeRole"
);

const {
  withTx,
} = require(
  "../../dbCompat"
);


const KDS_BATCH_EVENT_TYPE =
  "kds.batch.state.replaced.v1";

const KDS_KITCHEN_EVENT_TYPE =
  "kds.kitchen.state.replaced.v1";

const KDS_KITCHEN_DOMAIN =
  "kds.kitchen";

const KDS_SCHEMA_VERSION = 1;

const MAX_ACK_ROWS = 500;
const MAX_ITEM_STATE_ROWS = 1000;
const MAX_EVENT_BYTES =
  512 * 1024;


class KdsOperationalSyncError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "KdsOperationalSyncError";

    this.code =
      code;

    if (
      details !== null
    ) {
      this.details =
        details;
    }
  }
}


function fail(
  code,
  message,
  details = null
) {
  throw new KdsOperationalSyncError(
    code,
    message,
    details
  );
}


function requireTx(
  tx
) {
  if (
    !tx ||
    typeof tx.qGet !==
      "function" ||
    typeof tx.qRun !==
      "function" ||
    typeof tx.qAll !==
      "function"
  ) {
    fail(
      "EDGE_KDS_TX_REQUIRED",
      "KDS operational sync requires a PostgreSQL transaction"
    );
  }

  return tx;
}


function requireRestaurantId(
  value
) {
  const rid =
    Number(value);

  if (
    !Number.isSafeInteger(
      rid
    ) ||
    rid <= 0
  ) {
    fail(
      "EDGE_KDS_TENANT_INVALID",
      "restaurant_id must be a positive integer"
    );
  }

  return rid;
}


function isUuid(
  value
) {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(
        String(
          value || ""
        )
      )
  );
}


function requireUuid(
  value,
  label
) {
  const out =
    String(
      value || ""
    ).trim();

  if (
    !isUuid(
      out
    )
  ) {
    fail(
      "EDGE_KDS_UUID_INVALID",
      `${label} must be a UUID`
    );
  }

  return out;
}


function requirePositiveInt(
  value,
  label
) {
  const out =
    Number(value);

  if (
    !Number.isSafeInteger(
      out
    ) ||
    out <= 0
  ) {
    fail(
      "EDGE_KDS_REVISION_INVALID",
      `${label} must be a positive safe integer`
    );
  }

  return out;
}


function requireText(
  value,
  label,
  {
    max,
    allowEmpty = false,
  }
) {
  const out =
    String(
      value ?? ""
    ).trim();

  if (
    (
      !allowEmpty &&
      !out
    ) ||
    out.length > max
  ) {
    fail(
      "EDGE_KDS_PAYLOAD_INVALID",
      `${label} is invalid`
    );
  }

  return out;
}


function optionalText(
  value,
  label,
  {
    max,
  }
) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const out =
    String(
      value
    ).trim();

  if (
    out.length > max
  ) {
    fail(
      "EDGE_KDS_PAYLOAD_INVALID",
      `${label} is too long`
    );
  }

  return out || null;
}


function requireBool(
  value,
  label
) {
  if (
    typeof value !==
      "boolean"
  ) {
    fail(
      "EDGE_KDS_PAYLOAD_INVALID",
      `${label} must be boolean`
    );
  }

  return value;
}


function isoOrNull(
  value,
  label,
  {
    required = false,
  } = {}
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    if (
      required
    ) {
      fail(
        "EDGE_KDS_PAYLOAD_INVALID",
        `${label} is required`
      );
    }

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
    fail(
      "EDGE_KDS_PAYLOAD_INVALID",
      `${label} must be a timestamp`
    );
  }

  return date.toISOString();
}


function onlyKeys(
  value,
  allowed,
  label
) {
  if (
    !value ||
    typeof value !==
      "object" ||
    Array.isArray(
      value
    )
  ) {
    fail(
      "EDGE_KDS_PAYLOAD_INVALID",
      `${label} must be an object`
    );
  }

  const allowedSet =
    new Set(
      allowed
    );

  const unknown =
    Object.keys(
      value
    ).filter(
      (key) =>
        !allowedSet.has(
          key
        )
    );

  if (
    unknown.length
  ) {
    fail(
      "EDGE_KDS_PAYLOAD_INVALID",
      `${label} contains unsupported fields`,
      {
        fields:
          unknown.slice(
            0,
            20
          ),
      }
    );
  }

  return value;
}


function ensureEventSize(
  payload
) {
  const bytes =
    Buffer.byteLength(
      JSON.stringify(
        payload
      ),
      "utf8"
    );

  if (
    bytes >
    MAX_EVENT_BYTES
  ) {
    fail(
      "EDGE_KDS_EVENT_TOO_LARGE",
      "KDS operational event exceeds the maximum payload size",
      {
        bytes,
        max_bytes:
          MAX_EVENT_BYTES,
      }
    );
  }

  return payload;
}


function normalizeAckRow(
  value,
  index
) {
  const row =
    onlyKeys(
      value,
      [
        "device_id",
        "station_key",
        "acked_at",
      ],
      `station_acks[${index}]`
    );

  return {
    device_id:
      requireText(
        row.device_id,
        `station_acks[${index}].device_id`,
        {
          max: 200,
        }
      ),

    station_key:
      requireText(
        row.station_key,
        `station_acks[${index}].station_key`,
        {
          max: 120,
        }
      ),

    acked_at:
      isoOrNull(
        row.acked_at,
        `station_acks[${index}].acked_at`,
        {
          required:
            true,
        }
      ),
  };
}


function normalizeItemStateRow(
  value,
  index
) {
  const row =
    onlyKeys(
      value,
      [
        "station_key",
        "item_name",
        "mods_line",
        "is_working",
        "is_hidden",
        "updated_by_device",
        "updated_at",
      ],
      `item_states[${index}]`
    );

  return {
    station_key:
      requireText(
        row.station_key,
        `item_states[${index}].station_key`,
        {
          max: 120,
        }
      ),

    item_name:
      requireText(
        row.item_name,
        `item_states[${index}].item_name`,
        {
          max: 500,
        }
      ),

    mods_line:
      requireText(
        row.mods_line,
        `item_states[${index}].mods_line`,
        {
          max: 1500,
          allowEmpty:
            true,
        }
      ),

    is_working:
      requireBool(
        row.is_working,
        `item_states[${index}].is_working`
      ),

    is_hidden:
      requireBool(
        row.is_hidden,
        `item_states[${index}].is_hidden`
      ),

    updated_by_device:
      optionalText(
        row.updated_by_device,
        `item_states[${index}].updated_by_device`,
        {
          max: 200,
        }
      ),

    updated_at:
      isoOrNull(
        row.updated_at,
        `item_states[${index}].updated_at`,
        {
          required:
            true,
        }
      ),
  };
}


function validateKdsBatchPayload(
  input
) {
  const payload =
    onlyKeys(
      input,
      [
        "schema_version",
        "restaurant_id",
        "batch_id",
        "revision",
        "station_acks",
        "item_states",
      ],
      "KDS batch payload"
    );

  if (
    Number(
      payload
        .schema_version
    ) !==
    KDS_SCHEMA_VERSION
  ) {
    fail(
      "EDGE_KDS_SCHEMA_UNSUPPORTED",
      "Unsupported KDS batch payload schema"
    );
  }

  if (
    !Array.isArray(
      payload.station_acks
    ) ||
    payload
      .station_acks
      .length >
      MAX_ACK_ROWS
  ) {
    fail(
      "EDGE_KDS_PAYLOAD_INVALID",
      "station_acks must be a bounded array"
    );
  }

  if (
    !Array.isArray(
      payload.item_states
    ) ||
    payload
      .item_states
      .length >
      MAX_ITEM_STATE_ROWS
  ) {
    fail(
      "EDGE_KDS_PAYLOAD_INVALID",
      "item_states must be a bounded array"
    );
  }

  const stationAcks =
    payload
      .station_acks
      .map(
        normalizeAckRow
      );

  const itemStates =
    payload
      .item_states
      .map(
        normalizeItemStateRow
      );

  const ackKeys =
    new Set();

  for (
    const row of
      stationAcks
  ) {
    const key = [
      row.device_id,
      row.station_key,
    ].join(
      "\u0000"
    );

    if (
      ackKeys.has(
        key
      )
    ) {
      fail(
        "EDGE_KDS_PAYLOAD_INVALID",
        "station_acks contains duplicate natural keys"
      );
    }

    ackKeys.add(
      key
    );
  }

  const stateKeys =
    new Set();

  for (
    const row of
      itemStates
  ) {
    const key = [
      row.station_key,
      row.item_name,
      row.mods_line,
    ].join(
      "\u0000"
    );

    if (
      stateKeys.has(
        key
      )
    ) {
      fail(
        "EDGE_KDS_PAYLOAD_INVALID",
        "item_states contains duplicate natural keys"
      );
    }

    stateKeys.add(
      key
    );
  }

  return ensureEventSize({
    schema_version:
      KDS_SCHEMA_VERSION,

    restaurant_id:
      requireRestaurantId(
        payload
          .restaurant_id
      ),

    batch_id:
      requireUuid(
        payload.batch_id,
        "batch_id"
      ),

    revision:
      requirePositiveInt(
        payload.revision,
        "revision"
      ),

    station_acks:
      stationAcks,

    item_states:
      itemStates,
  });
}


function validateKdsKitchenPayload(
  input
) {
  const payload =
    onlyKeys(
      input,
      [
        "schema_version",
        "restaurant_id",
        "revision",
        "is_paused",
        "updated_at",
      ],
      "KDS kitchen payload"
    );

  if (
    Number(
      payload
        .schema_version
    ) !==
    KDS_SCHEMA_VERSION
  ) {
    fail(
      "EDGE_KDS_SCHEMA_UNSUPPORTED",
      "Unsupported KDS kitchen payload schema"
    );
  }

  return ensureEventSize({
    schema_version:
      KDS_SCHEMA_VERSION,

    restaurant_id:
      requireRestaurantId(
        payload
          .restaurant_id
      ),

    revision:
      requirePositiveInt(
        payload.revision,
        "revision"
      ),

    is_paused:
      requireBool(
        payload.is_paused,
        "is_paused"
      ),

    updated_at:
      isoOrNull(
        payload.updated_at,
        "updated_at"
      ),
  });
}


function kdsBatchDomain(
  batchId
) {
  return (
    "kds.batch:" +
    requireUuid(
      batchId,
      "batchId"
    )
  );
}


function isKdsEdgeProducerRuntime({
  env = process.env,
} = {}) {
  return (
    getRuntimeRole({
      env,
      required:
        false,
    }) ===
    RUNTIME_ROLES.EDGE
  );
}


function assertKdsEdgeProducerRuntime() {
  const role =
    getRuntimeRole({
      required:
        true,
    });

  if (
    role !==
    RUNTIME_ROLES.EDGE
  ) {
    fail(
      "EDGE_KDS_RUNTIME_NOT_EDGE",
      "KDS operational events may only be produced by the MAKS Edge runtime",
      {
        runtime_role:
          role,
      }
    );
  }

  return role;
}


async function loadKdsBatchSnapshotTx(
  tx,
  {
    restaurantId,
    batchId,
  }
) {
  requireTx(
    tx
  );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const bid =
    requireUuid(
      batchId,
      "batchId"
    );

  const batch =
    await tx.qGet(
      `
      SELECT id
      FROM public.order_batches
      WHERE
        restaurant_id = $1
        AND id = $2::uuid
      LIMIT 1
      `,
      [
        rid,
        bid,
      ]
    );

  if (
    !batch
  ) {
    fail(
      "EDGE_KDS_BATCH_NOT_FOUND",
      "KDS batch is not owned by the restaurant"
    );
  }

  const stationAcks =
    await tx.qAll(
      `
      SELECT
        device_id,
        station_key,
        acked_at
      FROM
        public.kds_station_ack
      WHERE
        restaurant_id = $1
        AND batch_id = $2::uuid
      ORDER BY
        device_id ASC,
        station_key ASC
      `,
      [
        rid,
        bid,
      ]
    );

  const itemStates =
    await tx.qAll(
      `
      SELECT
        station_key,
        item_name,
        mods_line,
        is_working,
        is_hidden,
        updated_by_device,
        updated_at
      FROM
        public.kds_item_state
      WHERE
        restaurant_id = $1
        AND batch_id = $2::uuid
      ORDER BY
        station_key ASC,
        item_name ASC,
        mods_line ASC
      `,
      [
        rid,
        bid,
      ]
    );

  return {
    station_acks:
      stationAcks || [],

    item_states:
      itemStates || [],
  };
}


async function emitKdsBatchSnapshotTx(
  tx,
  {
    restaurantId,
    batchId,
  }
) {
  requireTx(
    tx
  );

  assertKdsEdgeProducerRuntime();

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const bid =
    requireUuid(
      batchId,
      "batchId"
    );

  const domain =
    kdsBatchDomain(
      bid
    );

  const revision =
    await nextProducedRevisionTx(
      tx,
      {
        restaurantId:
          rid,
        domain,
      }
    );

  const snapshot =
    await loadKdsBatchSnapshotTx(
      tx,
      {
        restaurantId:
          rid,
        batchId:
          bid,
      }
    );

  const payload =
    validateKdsBatchPayload({
      schema_version:
        KDS_SCHEMA_VERSION,

      restaurant_id:
        rid,

      batch_id:
        bid,

      revision,

      station_acks:
        snapshot
          .station_acks,

      item_states:
        snapshot
          .item_states,
    });

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          rid,

        eventType:
          KDS_BATCH_EVENT_TYPE,

        entityType:
          "order_batch",

        entityId:
          bid,

        idempotencyKey:
          `${KDS_BATCH_EVENT_TYPE}:${bid}:${revision}`,

        payload,
      }
    );

  return {
    domain,
    revision,
    payload,
    event,
  };
}


async function loadKdsKitchenSnapshotTx(
  tx,
  {
    restaurantId,
  }
) {
  requireTx(
    tx
  );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const row =
    await tx.qGet(
      `
      SELECT
        is_paused,
        updated_at
      FROM
        public.kitchen_state
      WHERE
        restaurant_id = $1
      LIMIT 1
      `,
      [
        rid,
      ]
    );

  return {
    is_paused:
      Boolean(
        row?.is_paused
      ),

    updated_at:
      row?.updated_at ||
      null,
  };
}


async function emitKdsKitchenSnapshotTx(
  tx,
  {
    restaurantId,
  }
) {
  requireTx(
    tx
  );

  assertKdsEdgeProducerRuntime();

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const revision =
    await nextProducedRevisionTx(
      tx,
      {
        restaurantId:
          rid,
        domain:
          KDS_KITCHEN_DOMAIN,
      }
    );

  const snapshot =
    await loadKdsKitchenSnapshotTx(
      tx,
      {
        restaurantId:
          rid,
      }
    );

  const payload =
    validateKdsKitchenPayload({
      schema_version:
        KDS_SCHEMA_VERSION,

      restaurant_id:
        rid,

      revision,

      is_paused:
        snapshot
          .is_paused,

      updated_at:
        snapshot
          .updated_at,
    });

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          rid,

        eventType:
          KDS_KITCHEN_EVENT_TYPE,

        entityType:
          "kitchen_state",

        entityId:
          String(
            rid
          ),

        idempotencyKey:
          `${KDS_KITCHEN_EVENT_TYPE}:${revision}`,

        payload,
      }
    );

  return {
    domain:
      KDS_KITCHEN_DOMAIN,
    revision,
    payload,
    event,
  };
}


const KDS_EVENT_KEYS = [
  "event_id",
  "restaurant_id",
  "event_type",
  "entity_type",
  "entity_id",
  "idempotency_key",
  "payload",
  "payload_hash",
  "created_at",
];


function requirePayloadHash(
  value
) {
  const hash =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    !/^[0-9a-f]{64}$/.test(
      hash
    )
  ) {
    fail(
      "EDGE_KDS_HASH_INVALID",
      "KDS event payload_hash must be a SHA-256 hex digest"
    );
  }

  return hash;
}


function isKdsOperationalEventType(
  value
) {
  const type =
    String(
      value || ""
    ).trim();

  return (
    type ===
      KDS_BATCH_EVENT_TYPE ||
    type ===
      KDS_KITCHEN_EVENT_TYPE
  );
}


function validateKdsOperationalEvent(
  event,
  {
    restaurantId,
    sourceInstallationId,
  }
) {
  const envelope =
    onlyKeys(
      event,
      KDS_EVENT_KEYS,
      "KDS event"
    );

  const tenantId =
    requireRestaurantId(
      restaurantId
    );

  const installationId =
    requireUuid(
      sourceInstallationId,
      "sourceInstallationId"
    );

  const eventId =
    requireUuid(
      envelope.event_id,
      "event.event_id"
    );

  const eventType =
    String(
      envelope.event_type ||
      ""
    ).trim();

  if (
    !isKdsOperationalEventType(
      eventType
    )
  ) {
    fail(
      "EDGE_KDS_EVENT_TYPE_INVALID",
      "Unexpected KDS operational event type"
    );
  }

  if (
    Number(
      envelope
        .restaurant_id
    ) !==
    tenantId
  ) {
    fail(
      "EDGE_KDS_TENANT_MISMATCH",
      "KDS event restaurant does not match authenticated Edge"
    );
  }

  const payload =
    eventType ===
      KDS_BATCH_EVENT_TYPE
      ? validateKdsBatchPayload(
          envelope.payload
        )
      : validateKdsKitchenPayload(
          envelope.payload
        );

  if (
    payload.restaurant_id !==
    tenantId
  ) {
    fail(
      "EDGE_KDS_TENANT_MISMATCH",
      "KDS payload restaurant does not match authenticated Edge"
    );
  }

  const suppliedHash =
    requirePayloadHash(
      envelope.payload_hash
    );

  const calculatedHash =
    hashJson(
      envelope.payload
    );

  if (
    suppliedHash !==
    calculatedHash
  ) {
    fail(
      "EDGE_KDS_HASH_MISMATCH",
      "KDS payload does not match payload_hash"
    );
  }

  let domain;
  let entityType;
  let entityId;
  let expectedIdempotencyKey;
  let batchId = null;

  if (
    eventType ===
    KDS_BATCH_EVENT_TYPE
  ) {
    batchId =
      payload.batch_id;

    domain =
      kdsBatchDomain(
        batchId
      );

    entityType =
      "order_batch";

    entityId =
      batchId;

    expectedIdempotencyKey =
      `${KDS_BATCH_EVENT_TYPE}:${batchId}:${payload.revision}`;
  } else {
    domain =
      KDS_KITCHEN_DOMAIN;

    entityType =
      "kitchen_state";

    entityId =
      String(
        tenantId
      );

    expectedIdempotencyKey =
      `${KDS_KITCHEN_EVENT_TYPE}:${payload.revision}`;
  }

  if (
    String(
      envelope.entity_type ||
      ""
    ) !==
    entityType
  ) {
    fail(
      "EDGE_KDS_ENTITY_TYPE_INVALID",
      "KDS event entity_type is invalid"
    );
  }

  if (
    String(
      envelope.entity_id ||
      ""
    ) !==
    entityId
  ) {
    fail(
      "EDGE_KDS_ENTITY_ID_INVALID",
      "KDS event entity_id does not match payload identity"
    );
  }

  if (
    String(
      envelope
        .idempotency_key ||
      ""
    ) !==
    expectedIdempotencyKey
  ) {
    fail(
      "EDGE_KDS_IDEMPOTENCY_MISMATCH",
      "KDS event idempotency key does not match payload revision"
    );
  }

  return {
    event_id:
      eventId,

    restaurant_id:
      tenantId,

    source_installation_id:
      installationId,

    event_type:
      eventType,

    entity_type:
      entityType,

    entity_id:
      entityId,

    payload_hash:
      suppliedHash,

    domain,

    revision:
      payload.revision,

    batch_id:
      batchId,

    payload,
  };
}


async function claimCloudKdsInboxTx(
  tx,
  normalized
) {
  const inbox =
    await tx.qGet(
      `
      SELECT
        event_id,
        restaurant_id,
        source,
        source_installation_id,
        event_type,
        entity_type,
        entity_id,
        status,
        applied_at
      FROM
        public.edge_inbox
      WHERE
        event_id = $1::uuid
      FOR UPDATE
      `,
      [
        normalized
          .event_id,
      ]
    );

  if (
    !inbox
  ) {
    fail(
      "EDGE_KDS_INBOX_REQUIRED",
      "KDS event must be durably received before Cloud apply"
    );
  }

  if (
    Number(
      inbox
        .restaurant_id
    ) !==
      normalized
        .restaurant_id ||
    String(
      inbox.source ||
      ""
    ) !==
      "edge" ||
    String(
      inbox
        .source_installation_id ||
      ""
    ) !==
      normalized
        .source_installation_id ||
    String(
      inbox
        .event_type ||
      ""
    ) !==
      normalized
        .event_type ||
    String(
      inbox
        .entity_type ||
      ""
    ) !==
      normalized
        .entity_type ||
    String(
      inbox
        .entity_id ||
      ""
    ) !==
      normalized
        .entity_id
  ) {
    fail(
      "EDGE_KDS_INBOX_IDENTITY_MISMATCH",
      "Durable inbox identity does not match KDS event"
    );
  }

  if (
    String(
      inbox.status ||
      ""
    ) ===
    "applied"
  ) {
    return {
      duplicate:
        true,

      workerId:
        null,
    };
  }

  if (
    ![
      "received",
      "failed",
    ].includes(
      String(
        inbox.status ||
        ""
      )
    )
  ) {
    fail(
      "EDGE_KDS_INBOX_STATE_INVALID",
      "KDS inbox event is not in an applicable state"
    );
  }

  const workerId =
    `cloud-kds-inline:${normalized.source_installation_id}`;

  const claimed =
    await tx.qGet(
      `
      UPDATE
        public.edge_inbox
      SET
        status =
          'applying',
        apply_attempts =
          apply_attempts + 1,
        locked_at =
          NOW(),
        locked_by =
          $3,
        last_attempt_at =
          NOW(),
        last_error =
          NULL,
        updated_at =
          NOW()
      WHERE
        event_id =
          $1::uuid
        AND
        restaurant_id =
          $2
        AND
        status IN (
          'received',
          'failed'
        )
      RETURNING
        event_id,
        status,
        locked_by
      `,
      [
        normalized
          .event_id,
        normalized
          .restaurant_id,
        workerId,
      ]
    );

  if (
    !claimed
      ?.event_id ||
    String(
      claimed.status ||
      ""
    ) !==
      "applying" ||
    String(
      claimed
        .locked_by ||
      ""
    ) !==
      workerId
  ) {
    fail(
      "EDGE_KDS_INBOX_CLAIM_FAILED",
      "KDS operational inbox event could not enter applying state"
    );
  }

  return {
    duplicate:
      false,

    workerId,
  };
}


async function finalizeCloudKdsInboxTx(
  tx,
  normalized,
  workerId
) {
  const applied =
    await tx.qGet(
      `
      UPDATE
        public.edge_inbox
      SET
        status =
          'applied',
        applied_at =
          NOW(),
        last_error =
          NULL,
        locked_at =
          NULL,
        locked_by =
          NULL,
        updated_at =
          NOW()
      WHERE
        event_id =
          $1::uuid
        AND
        restaurant_id =
          $2
        AND
        status =
          'applying'
        AND
        locked_by =
          $3
      RETURNING
        event_id,
        status,
        applied_at
      `,
      [
        normalized
          .event_id,
        normalized
          .restaurant_id,
        workerId,
      ]
    );

  if (
    !applied
      ?.event_id ||
    String(
      applied.status ||
      ""
    ) !==
      "applied" ||
    !applied
      .applied_at
  ) {
    fail(
      "EDGE_KDS_INBOX_FINALIZE_FAILED",
      "KDS operational inbox event could not enter applied state"
    );
  }

  return applied;
}


async function assertCloudBatchForKdsTx(
  tx,
  normalized
) {
  const batch =
    await tx.qGet(
      `
      SELECT
        id,
        restaurant_id
      FROM
        public.order_batches
      WHERE
        id =
          $1::uuid
      FOR UPDATE
      `,
      [
        normalized
          .batch_id,
      ]
    );

  if (
    !batch
  ) {
    fail(
      "EDGE_KDS_BATCH_REQUIRED",
      "Cloud order batch must exist before KDS batch state can apply"
    );
  }

  if (
    Number(
      batch.restaurant_id
    ) !==
    normalized
      .restaurant_id
  ) {
    fail(
      "EDGE_KDS_BATCH_TENANT_COLLISION",
      "KDS batch UUID belongs to another restaurant"
    );
  }

  if (
    normalized
      .payload
      .item_states
      .length
  ) {
    const names =
      Array.from(
        new Set(
          normalized
            .payload
            .item_states
            .map(
              (row) =>
                String(
                  row.item_name
                )
                  .trim()
                  .toLowerCase()
            )
        )
      );

    const rows =
      await tx.qAll(
        `
        SELECT
          LOWER(
            TRIM(
              item_name
            )
          ) AS item_name
        FROM
          public.pos_orders
        WHERE
          restaurant_id = $1
          AND
          batch_id = $2::uuid
          AND
          LOWER(
            TRIM(
              item_name
            )
          ) =
            ANY($3::text[])
        `,
        [
          normalized
            .restaurant_id,
          normalized
            .batch_id,
          names,
        ]
      );

    const existing =
      new Set(
        (rows || [])
          .map(
            (row) =>
              String(
                row.item_name ||
                ""
              )
          )
      );

    const missing =
      names.filter(
        (name) =>
          !existing.has(
            name
          )
      );

    if (
      missing.length
    ) {
      fail(
        "EDGE_KDS_ITEM_NOT_FOUND",
        "KDS item state references an item that is not present in the Cloud batch",
        {
          missing_items:
            missing.slice(
              0,
              20
            ),
        }
      );
    }
  }

  return batch;
}


async function replaceCloudKdsBatchStateTx(
  tx,
  normalized
) {
  await tx.qRun(
    `
    DELETE FROM
      public.kds_station_ack
    WHERE
      restaurant_id = $1
      AND
      batch_id = $2::uuid
    `,
    [
      normalized
        .restaurant_id,
      normalized
        .batch_id,
    ]
  );

  for (
    const row of
    normalized
      .payload
      .station_acks
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.kds_station_ack
      (
        restaurant_id,
        device_id,
        batch_id,
        station_key,
        acked_at
      )
      VALUES
      (
        $1,
        $2,
        $3::uuid,
        $4,
        $5::timestamptz
      )
      `,
      [
        normalized
          .restaurant_id,
        row.device_id,
        normalized
          .batch_id,
        row.station_key,
        row.acked_at,
      ]
    );
  }

  await tx.qRun(
    `
    DELETE FROM
      public.kds_item_state
    WHERE
      restaurant_id = $1
      AND
      batch_id = $2::uuid
    `,
    [
      normalized
        .restaurant_id,
      normalized
        .batch_id,
    ]
  );

  for (
    const row of
    normalized
      .payload
      .item_states
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.kds_item_state
      (
        restaurant_id,
        station_key,
        batch_id,
        item_name,
        mods_line,
        is_working,
        is_hidden,
        updated_by_device,
        updated_at
      )
      VALUES
      (
        $1,
        $2,
        $3::uuid,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::timestamptz
      )
      `,
      [
        normalized
          .restaurant_id,
        row.station_key,
        normalized
          .batch_id,
        row.item_name,
        row.mods_line,
        row.is_working,
        row.is_hidden,
        row.updated_by_device,
        row.updated_at,
      ]
    );
  }

  return {
    station_acks:
      normalized
        .payload
        .station_acks
        .length,

    item_states:
      normalized
        .payload
        .item_states
        .length,
  };
}


async function replaceCloudKitchenStateTx(
  tx,
  normalized
) {
  await tx.qRun(
    `
    INSERT INTO
      public.kitchen_state
    (
      restaurant_id,
      is_paused,
      updated_at
    )
    VALUES
    (
      $1,
      $2,
      COALESCE(
        $3::timestamptz,
        NOW()
      )
    )
    ON CONFLICT (
      restaurant_id
    )
    DO UPDATE SET
      is_paused =
        EXCLUDED.is_paused,
      updated_at =
        EXCLUDED.updated_at
    `,
    [
      normalized
        .restaurant_id,
      normalized
        .payload
        .is_paused,
      normalized
        .payload
        .updated_at,
    ]
  );

  return {
    is_paused:
      normalized
        .payload
        .is_paused,
  };
}


async function applyKdsOperationalCloud({
  event,
  restaurantId,
  sourceInstallationId,
}) {
  assertCloudRuntime();

  const normalized =
    validateKdsOperationalEvent(
      event,
      {
        restaurantId,
        sourceInstallationId,
      }
    );

  try {
    return await withTx(
      async (tx) => {
      await tx.qGet(
        `
        SELECT
          pg_advisory_xact_lock(
            hashtextextended(
              $1,
              0
            )
          ) AS locked
        `,
        [
          `maks:cloud-kds:${normalized.restaurant_id}:${normalized.domain}`,
        ]
      );

      const claim =
        await claimCloudKdsInboxTx(
          tx,
          normalized
        );

      if (
        claim.duplicate
      ) {
        return {
          duplicate:
            true,

          stale:
            false,

          state:
            "duplicate",

          event_type:
            normalized
              .event_type,

          revision:
            normalized
              .revision,

          batch_id:
            normalized
              .batch_id,
        };
      }

      if (
        normalized
          .event_type ===
        KDS_BATCH_EVENT_TYPE
      ) {
        await assertCloudBatchForKdsTx(
          tx,
          normalized
        );
      }

      const revisionResult =
        await applyDomainRevisionTx(
          tx,
          {
            restaurantId:
              normalized
                .restaurant_id,

            domain:
              normalized
                .domain,

            revision:
              normalized
                .revision,

            payloadHash:
              normalized
                .payload_hash,

            execute:
              async () => {
                if (
                  normalized
                    .event_type ===
                  KDS_BATCH_EVENT_TYPE
                ) {
                  return replaceCloudKdsBatchStateTx(
                    tx,
                    normalized
                  );
                }

                return replaceCloudKitchenStateTx(
                  tx,
                  normalized
                );
              },
          }
        );

      await finalizeCloudKdsInboxTx(
        tx,
        normalized,
        claim.workerId
      );

      return {
        duplicate:
          revisionResult
            .state ===
          "duplicate",

        stale:
          revisionResult
            .state ===
          "stale",

        state:
          revisionResult
            .state,

        event_type:
          normalized
            .event_type,

        revision:
          normalized
            .revision,

        applied_revision:
          revisionResult
            .appliedRevision,

        batch_id:
          normalized
            .batch_id,

        result:
          revisionResult
            .result ??
          null,
      };
      }
    );
  } catch (error) {
    if (
      error instanceof
        EdgeDomainRevisionError
    ) {
      fail(
        error.code ||
          "EDGE_KDS_REVISION_ERROR",
        error.message ||
          "KDS domain revision failed",
        error.details ??
          null
      );
    }

    throw error;
  }
}


module.exports = {
  KDS_BATCH_EVENT_TYPE,
  KDS_KITCHEN_EVENT_TYPE,
  KDS_KITCHEN_DOMAIN,
  KDS_SCHEMA_VERSION,
  KdsOperationalSyncError,
  kdsBatchDomain,
  isKdsEdgeProducerRuntime,
  validateKdsBatchPayload,
  validateKdsKitchenPayload,
  loadKdsBatchSnapshotTx,
  emitKdsBatchSnapshotTx,
  loadKdsKitchenSnapshotTx,
  emitKdsKitchenSnapshotTx,
  isKdsOperationalEventType,
  validateKdsOperationalEvent,
  applyKdsOperationalCloud,
};
