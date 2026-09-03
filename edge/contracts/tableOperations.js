"use strict";

const crypto =
  require("node:crypto");

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


const TABLE_OPERATIONAL_EVENT_TYPE =
  "table.operational.replaced.v1";

const TABLE_OPERATIONAL_SCHEMA_VERSION =
  1;

const MAX_TABLE_NAME_LENGTH =
  200;

const ALLOWED_TABLE_STATUSES =
  new Set([
    "free",
    "available",
    "reserved",
    "occupied",
    "occupied_paid",
  ]);

const ALLOWED_ALLERGEN_CODES =
  new Set([
    "celery",
    "gluten",
    "crustaceans",
    "egg",
    "fish",
    "lupin",
    "milk",
    "molluscs",
    "mustard",
    "tree_nuts",
    "peanuts",
    "sesame",
    "soy",
    "sulphites",
  ]);


const TABLE_EVENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_TABLE_EVENT_BYTES =
  64 * 1024;


class TableOperationalSyncError
  extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "TableOperationalSyncError";

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
  throw new TableOperationalSyncError(
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
      "function"
  ) {
    fail(
      "EDGE_TABLE_TX_REQUIRED",
      "Table operational sync requires a transaction"
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
      "EDGE_TABLE_RESTAURANT_INVALID",
      "Table operational restaurant_id must be a positive safe integer"
    );
  }

  return rid;
}


function hasOwn(
  value,
  key
) {
  return Object.prototype
    .hasOwnProperty
    .call(
      value,
      key
    );
}


function requireTableEventUuid(
  value,
  field
) {
  const uuid =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    !TABLE_EVENT_UUID_RE.test(
      uuid
    )
  ) {
    fail(
      "EDGE_TABLE_EVENT_UUID_INVALID",
      `${field} must be a valid UUID`
    );
  }

  return uuid;
}


function requireTablePayloadHash(
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
      "EDGE_TABLE_HASH_INVALID",
      "Table event payload_hash must be a SHA-256 hex digest"
    );
  }

  return hash;
}


function ensureTableEventSize(
  payload
) {
  let serialized;

  try {
    serialized =
      JSON.stringify(
        payload
      );
  } catch {
    fail(
      "EDGE_TABLE_PAYLOAD_INVALID",
      "Table event payload cannot be serialized"
    );
  }

  if (
    typeof serialized !==
    "string"
  ) {
    fail(
      "EDGE_TABLE_PAYLOAD_INVALID",
      "Table event payload is invalid"
    );
  }

  const bytes =
    Buffer.byteLength(
      serialized,
      "utf8"
    );

  if (
    bytes >
    MAX_TABLE_EVENT_BYTES
  ) {
    fail(
      "EDGE_TABLE_EVENT_TOO_LARGE",
      "Table operational event exceeds the maximum payload size",
      {
        bytes,
        max_bytes:
          MAX_TABLE_EVENT_BYTES,
      }
    );
  }

  return payload;
}


function normalizeTableName(
  value
) {
  const name =
    String(
      value || ""
    ).trim();

  if (
    !name ||
    name.length >
      MAX_TABLE_NAME_LENGTH
  ) {
    fail(
      "EDGE_TABLE_NAME_INVALID",
      "Table operational name is missing or too long"
    );
  }

  return name
    .toLowerCase();
}


function requireDisplayTableName(
  value
) {
  const name =
    String(
      value || ""
    ).trim();

  if (
    !name ||
    name.length >
      MAX_TABLE_NAME_LENGTH
  ) {
    fail(
      "EDGE_TABLE_NAME_INVALID",
      "Table operational display name is missing or too long"
    );
  }

  return name;
}


function normalizeTableStatus(
  value
) {
  const raw =
    String(
      value || "free"
    )
      .trim()
      .toLowerCase();

  if (
    !ALLOWED_TABLE_STATUSES
      .has(raw)
  ) {
    fail(
      "EDGE_TABLE_STATUS_INVALID",
      "Table operational status is invalid"
    );
  }

  return (
    raw === "available"
      ? "free"
      : raw
  );
}


function normalizeAllergens(
  raw
) {
  if (
    !Array.isArray(raw)
  ) {
    return [];
  }

  const out =
    Array.from(
      new Set(
        raw
          .map(
            (value) =>
              String(
                value || ""
              )
                .trim()
                .toLowerCase()
          )
          .filter(
            (value) =>
              ALLOWED_ALLERGEN_CODES
                .has(value)
          )
      )
    );

  out.sort();

  return out;
}


function normalizeSession(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (
    typeof value !==
      "object" ||
    Array.isArray(value)
  ) {
    fail(
      "EDGE_TABLE_SESSION_INVALID",
      "Table operational session must be an object or null"
    );
  }

  const covers =
    Number(
      value.covers
    );

  if (
    !Number.isInteger(
      covers
    ) ||
    covers < 1 ||
    covers > 1000
  ) {
    fail(
      "EDGE_TABLE_COVERS_INVALID",
      "Table operational covers must be an integer between 1 and 1000"
    );
  }

  return {
    covers,

    allergy_codes:
      normalizeAllergens(
        value
          .allergy_codes
      ),

    strict_cross_contamination:
      value
        .strict_cross_contamination ===
      true,
  };
}


function requireRevision(
  value
) {
  const revision =
    Number(value);

  if (
    !Number.isSafeInteger(
      revision
    ) ||
    revision <= 0
  ) {
    fail(
      "EDGE_TABLE_REVISION_INVALID",
      "Table operational revision must be a positive safe integer"
    );
  }

  return revision;
}


function validateTableOperationalPayload(
  value
) {
  if (
    !value ||
    typeof value !==
      "object" ||
    Array.isArray(value)
  ) {
    fail(
      "EDGE_TABLE_PAYLOAD_INVALID",
      "Table operational payload must be an object"
    );
  }

  const allowedKeys =
    new Set([
      "schema_version",
      "restaurant_id",
      "revision",
      "table",
      "session",
    ]);

  for (
    const key of
    Object.keys(value)
  ) {
    if (
      !allowedKeys.has(
        key
      )
    ) {
      fail(
        "EDGE_TABLE_PAYLOAD_FIELD_UNSUPPORTED",
        `Unsupported table operational payload field: ${key}`
      );
    }
  }

  if (
    Number(
      value.schema_version
    ) !==
    TABLE_OPERATIONAL_SCHEMA_VERSION
  ) {
    fail(
      "EDGE_TABLE_SCHEMA_UNSUPPORTED",
      "Unsupported table operational schema version"
    );
  }

  const restaurantId =
    requireRestaurantId(
      value.restaurant_id
    );

  const revision =
    requireRevision(
      value.revision
    );

  if (
    !value.table ||
    typeof value.table !==
      "object" ||
    Array.isArray(
      value.table
    )
  ) {
    fail(
      "EDGE_TABLE_STATE_INVALID",
      "Table operational payload requires table state"
    );
  }

  const tableAllowedKeys =
    new Set([
      "name",
      "normalized_name",
      "status",
    ]);

  for (
    const key of
    Object.keys(
      value.table
    )
  ) {
    if (
      !tableAllowedKeys.has(
        key
      )
    ) {
      fail(
        "EDGE_TABLE_STATE_FIELD_UNSUPPORTED",
        `Unsupported table state field: ${key}`
      );
    }
  }

  const name =
    requireDisplayTableName(
      value.table.name
    );

  const normalizedName =
    normalizeTableName(
      value.table
        .normalized_name
    );

  if (
    normalizeTableName(
      name
    ) !==
    normalizedName
  ) {
    fail(
      "EDGE_TABLE_NAME_MISMATCH",
      "Table display name and normalized identity do not match"
    );
  }

  return {
    schema_version:
      TABLE_OPERATIONAL_SCHEMA_VERSION,

    restaurant_id:
      restaurantId,

    revision,

    table: {
      name,

      normalized_name:
        normalizedName,

      status:
        normalizeTableStatus(
          value.table.status
        ),
    },

    session:
      normalizeSession(
        value.session
      ),
  };
}


function validateTableOperationalIngressPayload(
  value
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
      "EDGE_TABLE_PAYLOAD_INVALID",
      "Table operational payload must be an object"
    );
  }

  const requiredPayloadKeys = [
    "schema_version",
    "restaurant_id",
    "revision",
    "table",
    "session",
  ];

  for (
    const key of
    requiredPayloadKeys
  ) {
    if (
      !hasOwn(
        value,
        key
      )
    ) {
      fail(
        "EDGE_TABLE_PAYLOAD_FIELD_REQUIRED",
        `Table operational payload is missing required field: ${key}`
      );
    }
  }

  if (
    !value.table ||
    typeof value.table !==
      "object" ||
    Array.isArray(
      value.table
    )
  ) {
    fail(
      "EDGE_TABLE_STATE_INVALID",
      "Table operational payload requires table state"
    );
  }

  for (
    const key of [
      "name",
      "normalized_name",
      "status",
    ]
  ) {
    if (
      !hasOwn(
        value.table,
        key
      )
    ) {
      fail(
        "EDGE_TABLE_STATE_FIELD_REQUIRED",
        `Table state is missing required field: ${key}`
      );
    }
  }

  if (
    value.session !==
      null
  ) {
    if (
      !value.session ||
      typeof value.session !==
        "object" ||
      Array.isArray(
        value.session
      )
    ) {
      fail(
        "EDGE_TABLE_SESSION_INVALID",
        "Table operational session must be an object or null"
      );
    }

    const sessionAllowedKeys =
      new Set([
        "covers",
        "allergy_codes",
        "strict_cross_contamination",
      ]);

    for (
      const key of
      Object.keys(
        value.session
      )
    ) {
      if (
        !sessionAllowedKeys.has(
          key
        )
      ) {
        fail(
          "EDGE_TABLE_SESSION_FIELD_UNSUPPORTED",
          `Unsupported table session field: ${key}`
        );
      }
    }

    for (
      const key of [
        "covers",
        "allergy_codes",
        "strict_cross_contamination",
      ]
    ) {
      if (
        !hasOwn(
          value.session,
          key
        )
      ) {
        fail(
          "EDGE_TABLE_SESSION_FIELD_REQUIRED",
          `Table session is missing required field: ${key}`
        );
      }
    }

    if (
      !Array.isArray(
        value.session
          .allergy_codes
      )
    ) {
      fail(
        "EDGE_TABLE_ALLERGENS_INVALID",
        "Table session allergy_codes must be an array"
      );
    }

    if (
      value.session
        .allergy_codes
        .length >
      ALLOWED_ALLERGEN_CODES
        .size
    ) {
      fail(
        "EDGE_TABLE_ALLERGENS_INVALID",
        "Table session contains too many allergen codes"
      );
    }

    const seen =
      new Set();

    for (
      const rawCode of
      value.session
        .allergy_codes
    ) {
      if (
        typeof rawCode !==
        "string"
      ) {
        fail(
          "EDGE_TABLE_ALLERGEN_INVALID",
          "Table session allergen codes must be strings"
        );
      }

      const code =
        rawCode
          .trim()
          .toLowerCase();

      if (
        !ALLOWED_ALLERGEN_CODES
          .has(code) ||
        code !==
          rawCode
      ) {
        fail(
          "EDGE_TABLE_ALLERGEN_INVALID",
          "Table session contains a non-canonical allergen code"
        );
      }

      if (
        seen.has(
          code
        )
      ) {
        fail(
          "EDGE_TABLE_ALLERGEN_DUPLICATE",
          "Table session contains a duplicate allergen code"
        );
      }

      seen.add(
        code
      );
    }

    if (
      typeof value.session
        .strict_cross_contamination !==
      "boolean"
    ) {
      fail(
        "EDGE_TABLE_STRICT_CROSS_CONTAMINATION_INVALID",
        "strict_cross_contamination must be boolean"
      );
    }
  }

  return ensureTableEventSize(
    validateTableOperationalPayload(
      value
    )
  );
}


function tableIdentityDigest(
  tableName
) {
  return crypto
    .createHash(
      "sha256"
    )
    .update(
      normalizeTableName(
        tableName
      ),
      "utf8"
    )
    .digest(
      "hex"
    )
    .slice(
      0,
      32
    );
}


function tableOperationalDomain(
  tableName
) {
  return (
    "table.operational." +
    tableIdentityDigest(
      tableName
    )
  );
}


function isTableEdgeProducerRuntime({
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


function assertTableEdgeProducerRuntime() {
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
      "EDGE_TABLE_PRODUCER_ROLE_INVALID",
      "Table operational producer may run only on Edge"
    );
  }
}


async function loadTableOperationalSnapshotTx(
  tx,
  {
    restaurantId,
    tableName,
  }
) {
  requireTx(
    tx
  );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const normalizedName =
    normalizeTableName(
      tableName
    );

  const table =
    await tx.qGet(
      `
      SELECT
        id,
        name,
        status
      FROM
        public.tables
      WHERE
        restaurant_id = $1
        AND LOWER(
              TRIM(name)
            ) = $2
      LIMIT 1
      `,
      [
        rid,
        normalizedName,
      ]
    );

  if (
    !table?.id
  ) {
    fail(
      "EDGE_TABLE_NOT_FOUND",
      "Table operational snapshot target was not found"
    );
  }

  const session =
    await tx.qGet(
      `
      SELECT
        covers,
        allergy_codes,
        strict_cross_contamination
      FROM
        public.pos_table_sessions
      WHERE
        restaurant_id = $1
        AND table_id = $2
      LIMIT 1
      `,
      [
        rid,
        Number(
          table.id
        ),
      ]
    );

  let allergyCodes =
    session
      ?.allergy_codes;

  if (
    typeof allergyCodes ===
      "string"
  ) {
    try {
      allergyCodes =
        JSON.parse(
          allergyCodes
        );
    } catch {
      allergyCodes =
        [];
    }
  }

  return {
    table: {
      name:
        requireDisplayTableName(
          table.name
        ),

      normalized_name:
        normalizeTableName(
          table.name
        ),

      status:
        normalizeTableStatus(
          table.status
        ),
    },

    session:
      session
        ? {
            covers:
              Number(
                session.covers ||
                1
              ),

            allergy_codes:
              normalizeAllergens(
                allergyCodes
              ),

            strict_cross_contamination:
              session
                .strict_cross_contamination ===
              true,
          }
        : null,
  };
}


async function emitTableOperationalSnapshotTx(
  tx,
  {
    restaurantId,
    tableName,
  }
) {
  requireTx(
    tx
  );

  assertTableEdgeProducerRuntime();

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const normalizedName =
    normalizeTableName(
      tableName
    );

  const domain =
    tableOperationalDomain(
      normalizedName
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
    await loadTableOperationalSnapshotTx(
      tx,
      {
        restaurantId:
          rid,

        tableName:
          normalizedName,
      }
    );

  const payload =
    validateTableOperationalPayload({
      schema_version:
        TABLE_OPERATIONAL_SCHEMA_VERSION,

      restaurant_id:
        rid,

      revision,

      table:
        snapshot.table,

      session:
        snapshot.session,
    });

  const digest =
    tableIdentityDigest(
      normalizedName
    );

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          rid,

        eventType:
          TABLE_OPERATIONAL_EVENT_TYPE,

        entityType:
          "table",

        entityId:
          normalizedName,

        idempotencyKey:
          `${TABLE_OPERATIONAL_EVENT_TYPE}:${digest}:${revision}`,

        payload,
      }
    );

  return {
    revision,
    domain,
    event,
    payload,
  };
}


const TABLE_BATCH_ASSIGNMENT_EVENT_TYPE =
  "table.batch.assignment.replaced.v1";

const TABLE_BATCH_ASSIGNMENT_SCHEMA_VERSION =
  1;

const TABLE_BATCH_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TABLE_BATCH_ORDER_TYPES =
  new Set([
    "dine-in",
    "takeaway",
    "delivery",
  ]);


function normalizeTableBatchId(
  value
) {
  const batchId =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    !TABLE_BATCH_UUID_RE.test(
      batchId
    )
  ) {
    fail(
      "EDGE_TABLE_BATCH_ID_INVALID",
      "Table batch assignment requires a valid batch UUID"
    );
  }

  return batchId;
}


function normalizeTableBatchOrderType(
  value
) {
  const orderType =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    !TABLE_BATCH_ORDER_TYPES.has(
      orderType
    )
  ) {
    fail(
      "EDGE_TABLE_BATCH_ORDER_TYPE_INVALID",
      "Table batch assignment order_type is invalid"
    );
  }

  return orderType;
}


function normalizeTableBatchPickupNumber(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(
      value
    );

  if (
    !Number.isSafeInteger(
      number
    ) ||
    number <= 0 ||
    number > 999999999
  ) {
    fail(
      "EDGE_TABLE_BATCH_PICKUP_INVALID",
      "Table batch assignment pickup_number is invalid"
    );
  }

  return number;
}


function tableBatchAssignmentDomain(
  batchId
) {
  return (
    "table.batch.assignment." +
    normalizeTableBatchId(
      batchId
    )
  );
}


function validateTableBatchAssignmentPayload(
  value
) {
  if (
    !value ||
    typeof value !==
      "object" ||
    Array.isArray(value)
  ) {
    fail(
      "EDGE_TABLE_BATCH_PAYLOAD_INVALID",
      "Table batch assignment payload must be an object"
    );
  }

  const allowedKeys =
    new Set([
      "schema_version",
      "restaurant_id",
      "revision",
      "batch_id",
      "assignment",
    ]);

  for (
    const key of
    Object.keys(value)
  ) {
    if (
      !allowedKeys.has(
        key
      )
    ) {
      fail(
        "EDGE_TABLE_BATCH_PAYLOAD_FIELD_UNSUPPORTED",
        `Unsupported table batch assignment payload field: ${key}`
      );
    }
  }

  if (
    Number(
      value.schema_version
    ) !==
    TABLE_BATCH_ASSIGNMENT_SCHEMA_VERSION
  ) {
    fail(
      "EDGE_TABLE_BATCH_SCHEMA_UNSUPPORTED",
      "Unsupported table batch assignment schema version"
    );
  }

  const restaurantId =
    requireRestaurantId(
      value.restaurant_id
    );

  const revision =
    requireRevision(
      value.revision
    );

  const batchId =
    normalizeTableBatchId(
      value.batch_id
    );

  if (
    !value.assignment ||
    typeof value.assignment !==
      "object" ||
    Array.isArray(
      value.assignment
    )
  ) {
    fail(
      "EDGE_TABLE_BATCH_ASSIGNMENT_INVALID",
      "Table batch assignment payload requires assignment state"
    );
  }

  const assignmentAllowedKeys =
    new Set([
      "table_number",
      "order_type",
      "pickup_number",
    ]);

  for (
    const key of
    Object.keys(
      value.assignment
    )
  ) {
    if (
      !assignmentAllowedKeys.has(
        key
      )
    ) {
      fail(
        "EDGE_TABLE_BATCH_ASSIGNMENT_FIELD_UNSUPPORTED",
        `Unsupported table batch assignment field: ${key}`
      );
    }
  }

  const tableNumber =
    requireDisplayTableName(
      value.assignment
        .table_number
    );

  const orderType =
    normalizeTableBatchOrderType(
      value.assignment
        .order_type
    );

  const pickupNumber =
    normalizeTableBatchPickupNumber(
      value.assignment
        .pickup_number
    );

  const tableNorm =
    normalizeTableName(
      tableNumber
    );

  if (
    orderType ===
      "takeaway"
  ) {
    if (
      tableNorm !==
        "takeaway" ||
      pickupNumber ===
        null
    ) {
      fail(
        "EDGE_TABLE_BATCH_TAKEAWAY_STATE_INVALID",
        "Takeaway batch assignment requires Takeaway table_number and pickup_number"
      );
    }
  } else if (
    orderType ===
      "delivery"
  ) {
    if (
      tableNorm !==
        "delivery" ||
      pickupNumber !==
        null
    ) {
      fail(
        "EDGE_TABLE_BATCH_DELIVERY_STATE_INVALID",
        "Delivery batch assignment requires Delivery table_number and no pickup_number"
      );
    }
  } else {
    if (
      tableNorm ===
        "takeaway" ||
      tableNorm ===
        "delivery" ||
      pickupNumber !==
        null
    ) {
      fail(
        "EDGE_TABLE_BATCH_DINE_IN_STATE_INVALID",
        "Dine-in batch assignment requires a physical table and no pickup_number"
      );
    }
  }

  return {
    schema_version:
      TABLE_BATCH_ASSIGNMENT_SCHEMA_VERSION,

    restaurant_id:
      restaurantId,

    revision,

    batch_id:
      batchId,

    assignment: {
      table_number:
        tableNumber,

      order_type:
        orderType,

      pickup_number:
        pickupNumber,
    },
  };
}


function validateTableBatchAssignmentIngressPayload(
  value
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
      "EDGE_TABLE_BATCH_PAYLOAD_INVALID",
      "Table batch assignment payload must be an object"
    );
  }

  for (
    const key of [
      "schema_version",
      "restaurant_id",
      "revision",
      "batch_id",
      "assignment",
    ]
  ) {
    if (
      !hasOwn(
        value,
        key
      )
    ) {
      fail(
        "EDGE_TABLE_BATCH_PAYLOAD_FIELD_REQUIRED",
        `Table batch assignment payload is missing required field: ${key}`
      );
    }
  }

  if (
    !value.assignment ||
    typeof value.assignment !==
      "object" ||
    Array.isArray(
      value.assignment
    )
  ) {
    fail(
      "EDGE_TABLE_BATCH_ASSIGNMENT_INVALID",
      "Table batch assignment payload requires assignment state"
    );
  }

  for (
    const key of [
      "table_number",
      "order_type",
      "pickup_number",
    ]
  ) {
    if (
      !hasOwn(
        value.assignment,
        key
      )
    ) {
      fail(
        "EDGE_TABLE_BATCH_ASSIGNMENT_FIELD_REQUIRED",
        `Table batch assignment is missing required field: ${key}`
      );
    }
  }

  return ensureTableEventSize(
    validateTableBatchAssignmentPayload(
      value
    )
  );
}


function isTableOperationalEventType(
  value
) {
  const type =
    String(
      value || ""
    ).trim();

  return (
    type ===
      TABLE_OPERATIONAL_EVENT_TYPE ||
    type ===
      TABLE_BATCH_ASSIGNMENT_EVENT_TYPE
  );
}


function validateTableOperationalEvent(
  event,
  {
    restaurantId,
    sourceInstallationId,
  }
) {
  if (
    !event ||
    typeof event !==
      "object" ||
    Array.isArray(
      event
    )
  ) {
    fail(
      "EDGE_TABLE_EVENT_INVALID",
      "Table operational event must be an object"
    );
  }

  const allowedEventKeys =
    new Set([
      "event_id",
      "restaurant_id",
      "event_type",
      "entity_type",
      "entity_id",
      "idempotency_key",
      "payload",
      "payload_hash",
      "created_at",
    ]);

  for (
    const key of
    Object.keys(
      event
    )
  ) {
    if (
      !allowedEventKeys.has(
        key
      )
    ) {
      fail(
        "EDGE_TABLE_EVENT_FIELD_UNSUPPORTED",
        `Unsupported table operational event field: ${key}`
      );
    }
  }

  const tenantId =
    requireRestaurantId(
      restaurantId
    );

  const installationId =
    requireTableEventUuid(
      sourceInstallationId,
      "sourceInstallationId"
    );

  const eventId =
    requireTableEventUuid(
      event.event_id,
      "event.event_id"
    );

  const eventType =
    String(
      event.event_type ||
      ""
    ).trim();

  if (
    !isTableOperationalEventType(
      eventType
    )
  ) {
    fail(
      "EDGE_TABLE_EVENT_TYPE_INVALID",
      "Unexpected table operational event type"
    );
  }

  if (
    Number(
      event.restaurant_id
    ) !==
    tenantId
  ) {
    fail(
      "EDGE_TABLE_TENANT_MISMATCH",
      "Table event restaurant does not match authenticated Edge"
    );
  }

  const payload =
    eventType ===
      TABLE_OPERATIONAL_EVENT_TYPE
      ? validateTableOperationalIngressPayload(
          event.payload
        )
      : validateTableBatchAssignmentIngressPayload(
          event.payload
        );

  if (
    payload.restaurant_id !==
    tenantId
  ) {
    fail(
      "EDGE_TABLE_TENANT_MISMATCH",
      "Table payload restaurant does not match authenticated Edge"
    );
  }

  const suppliedHash =
    requireTablePayloadHash(
      event.payload_hash
    );

  const calculatedHash =
    hashJson(
      event.payload
    );

  if (
    suppliedHash !==
    calculatedHash
  ) {
    fail(
      "EDGE_TABLE_HASH_MISMATCH",
      "Table payload does not match payload_hash"
    );
  }

  let domain;
  let entityType;
  let entityId;
  let expectedIdempotencyKey;
  let tableName =
    null;
  let batchId =
    null;

  if (
    eventType ===
    TABLE_OPERATIONAL_EVENT_TYPE
  ) {
    tableName =
      payload.table
        .normalized_name;

    domain =
      tableOperationalDomain(
        tableName
      );

    entityType =
      "table";

    entityId =
      tableName;

    const digest =
      tableIdentityDigest(
        tableName
      );

    expectedIdempotencyKey =
      `${TABLE_OPERATIONAL_EVENT_TYPE}:${digest}:${payload.revision}`;
  } else {
    batchId =
      payload.batch_id;

    domain =
      tableBatchAssignmentDomain(
        batchId
      );

    entityType =
      "order_batch";

    entityId =
      batchId;

    expectedIdempotencyKey =
      `${TABLE_BATCH_ASSIGNMENT_EVENT_TYPE}:${batchId}:${payload.revision}`;
  }

  if (
    String(
      event.entity_type ||
      ""
    ) !==
    entityType
  ) {
    fail(
      "EDGE_TABLE_ENTITY_TYPE_INVALID",
      "Table event entity_type is invalid"
    );
  }

  if (
    String(
      event.entity_id ||
      ""
    ) !==
    entityId
  ) {
    fail(
      "EDGE_TABLE_ENTITY_ID_INVALID",
      "Table event entity_id does not match payload identity"
    );
  }

  if (
    String(
      event.idempotency_key ||
      ""
    ) !==
    expectedIdempotencyKey
  ) {
    fail(
      "EDGE_TABLE_IDEMPOTENCY_MISMATCH",
      "Table event idempotency key does not match payload revision"
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

    idempotency_key:
      expectedIdempotencyKey,

    payload_hash:
      suppliedHash,

    domain,

    revision:
      payload.revision,

    table_name:
      tableName,

    batch_id:
      batchId,

    payload,
  };
}


async function loadTableBatchAssignmentSnapshotTx(
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

  const safeBatchId =
    normalizeTableBatchId(
      batchId
    );

  const batch =
    await tx.qGet(
      `
      SELECT
        id,
        restaurant_id,
        table_number,
        order_type,
        pickup_number
      FROM
        public.order_batches
      WHERE
        id = $1::uuid
      FOR UPDATE
      `,
      [
        safeBatchId,
      ]
    );

  if (
    !batch?.id
  ) {
    fail(
      "EDGE_TABLE_BATCH_NOT_FOUND",
      "Table batch assignment target was not found"
    );
  }

  if (
    Number(
      batch.restaurant_id
    ) !==
    rid
  ) {
    fail(
      "EDGE_TABLE_BATCH_TENANT_COLLISION",
      "Table batch assignment UUID belongs to another restaurant"
    );
  }

  const rowState =
    await tx.qGet(
      `
      SELECT
        COUNT(*)::int
          AS total_rows,

        COUNT(*) FILTER (
          WHERE
            LOWER(
              TRIM(
                table_number
              )
            ) =
            LOWER(
              TRIM($3)
            )
        )::int
          AS correct_rows

      FROM
        public.pos_orders

      WHERE
        restaurant_id = $1
        AND batch_id = $2::uuid

        AND COALESCE(
              paid,
              0
            ) = 0

        AND COALESCE(
              remaining_price,
              total_price,
              0
            ) > 0
      `,
      [
        rid,
        safeBatchId,
        String(
          batch.table_number || ""
        ).trim(),
      ]
    );

  const totalRows =
    Number(
      rowState
        ?.total_rows ||
      0
    );

  const correctRows =
    Number(
      rowState
        ?.correct_rows ||
      0
    );

  if (
    totalRows <= 0 ||
    correctRows !==
      totalRows
  ) {
    fail(
      "EDGE_TABLE_BATCH_POS_STATE_INVALID",
      "Table batch assignment does not match its unpaid POS rows"
    );
  }

  return {
    batch_id:
      safeBatchId,

    assignment: {
      table_number:
        requireDisplayTableName(
          batch.table_number
        ),

      order_type:
        normalizeTableBatchOrderType(
          batch.order_type
        ),

      pickup_number:
        normalizeTableBatchPickupNumber(
          batch.pickup_number
        ),
    },
  };
}


async function emitTableBatchAssignmentSnapshotTx(
  tx,
  {
    restaurantId,
    batchId,
  }
) {
  requireTx(
    tx
  );

  assertTableEdgeProducerRuntime();

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const safeBatchId =
    normalizeTableBatchId(
      batchId
    );

  const domain =
    tableBatchAssignmentDomain(
      safeBatchId
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
    await loadTableBatchAssignmentSnapshotTx(
      tx,
      {
        restaurantId:
          rid,

        batchId:
          safeBatchId,
      }
    );

  const payload =
    validateTableBatchAssignmentPayload({
      schema_version:
        TABLE_BATCH_ASSIGNMENT_SCHEMA_VERSION,

      restaurant_id:
        rid,

      revision,

      batch_id:
        safeBatchId,

      assignment:
        snapshot.assignment,
    });

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          rid,

        eventType:
          TABLE_BATCH_ASSIGNMENT_EVENT_TYPE,

        entityType:
          "order_batch",

        entityId:
          safeBatchId,

        idempotencyKey:
          `${TABLE_BATCH_ASSIGNMENT_EVENT_TYPE}:${safeBatchId}:${revision}`,

        payload,
      }
    );

  return {
    revision,
    domain,
    event,
    payload,
  };
}


/*
 * =========================================================
 * CLOUD TABLE OPERATIONAL MATERIALIZATION
 * =========================================================
 *
 * Edge numeric table IDs are NEVER Cloud authority.
 *
 * Physical table identity:
 *
 *   restaurant_id
 *     +
 *   normalized canonical table name
 *
 * Batch assignment identity:
 *
 *   restaurant_id
 *     +
 *   stable batch UUID
 *
 * Cloud uses its own local tables.id when writing
 * pos_table_sessions.
 */


async function claimCloudTableInboxTx(
  tx,
  normalized
) {
  requireTx(
    tx
  );

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
        event_id =
          $1::uuid

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
      "EDGE_TABLE_INBOX_REQUIRED",
      "Table operational event must be durably received before Cloud apply"
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
      "EDGE_TABLE_INBOX_IDENTITY_MISMATCH",
      "Durable inbox identity does not match table operational event"
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
      "EDGE_TABLE_INBOX_STATE_INVALID",
      "Table operational inbox event is not in an applicable state"
    );
  }

  const workerId =
    `cloud-table-inline:${normalized.source_installation_id}`;

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

        AND restaurant_id =
          $2

        AND status IN (
          'received',
          'failed'
        )

      RETURNING
        event_id,
        status,
        apply_attempts,
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
      claimed.locked_by ||
      ""
    ) !==
      workerId
  ) {
    fail(
      "EDGE_TABLE_INBOX_CLAIM_FAILED",
      "Table operational inbox event could not enter applying state"
    );
  }

  return {
    duplicate:
      false,

    workerId,
  };
}


async function finalizeCloudTableInboxTx(
  tx,
  normalized,
  workerId
) {
  requireTx(
    tx
  );

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

        AND restaurant_id =
          $2

        AND status =
          'applying'

        AND locked_by =
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
      "EDGE_TABLE_INBOX_FINALIZE_FAILED",
      "Table operational inbox event could not enter applied state"
    );
  }

  return applied;
}


async function assertCloudPhysicalTableTx(
  tx,
  normalized
) {
  requireTx(
    tx
  );

  const tableName =
    normalizeTableName(
      normalized
        .table_name ||
      normalized
        .payload
        ?.assignment
        ?.table_number
    );

  /*
   * Lock every Cloud row matching the stable physical
   * identity. qGet returns the first row, while PostgreSQL
   * acquires row locks for the result set.
   *
   * Numeric Edge table IDs never appear here.
   */
  const table =
    await tx.qGet(
      `
      SELECT
        id,
        restaurant_id,
        name,
        status

      FROM
        public.tables

      WHERE
        restaurant_id =
          $1

        AND LOWER(
              TRIM(name)
            ) =
            $2

      ORDER BY
        id ASC

      FOR UPDATE
      `,
      [
        normalized
          .restaurant_id,

        tableName,
      ]
    );

  if (
    !table
      ?.id
  ) {
    fail(
      "EDGE_TABLE_CLOUD_TABLE_REQUIRED",
      "Cloud physical table must exist before table state can apply",
      {
        table_name:
          tableName,
      }
    );
  }

  if (
    Number(
      table.restaurant_id
    ) !==
    normalized
      .restaurant_id
  ) {
    fail(
      "EDGE_TABLE_CLOUD_TABLE_TENANT_COLLISION",
      "Cloud physical table belongs to another restaurant"
    );
  }

  if (
    normalizeTableName(
      table.name
    ) !==
    tableName
  ) {
    fail(
      "EDGE_TABLE_CLOUD_TABLE_IDENTITY_MISMATCH",
      "Cloud physical table identity does not match event identity"
    );
  }

  /*
   * Normalized table name is the cross-database identity.
   *
   * If Cloud contains more than one physical table with the
   * same normalized identity, choosing one would be unsafe.
   * Fail closed rather than materializing against an
   * ambiguous local BIGINT row.
   */
  const duplicateTable =
    await tx.qGet(
      `
      SELECT
        id

      FROM
        public.tables

      WHERE
        restaurant_id =
          $1

        AND LOWER(
              TRIM(name)
            ) =
            $2

        AND id <>
          $3

      ORDER BY
        id ASC

      LIMIT 1

      FOR UPDATE
      `,
      [
        normalized
          .restaurant_id,

        tableName,

        Number(
          table.id
        ),
      ]
    );

  if (
    duplicateTable
      ?.id
  ) {
    fail(
      "EDGE_TABLE_CLOUD_TABLE_AMBIGUOUS",
      "Cloud contains multiple physical tables with the same normalized identity",
      {
        table_name:
          tableName,
      }
    );
  }

  return {
    ...table,

    normalized_name:
      tableName,
  };
}


async function replaceCloudTableOperationalStateTx(
  tx,
  normalized,
  table
) {
  requireTx(
    tx
  );

  const status =
    normalized
      .payload
      .table
      .status;

  await tx.qRun(
    `
    UPDATE
      public.tables

    SET
      status =
        $1

    WHERE
      id =
        $2

      AND restaurant_id =
        $3
    `,
    [
      status,

      Number(
        table.id
      ),

      normalized
        .restaurant_id,
    ]
  );

  /*
   * table_map is a presentation mirror.
   *
   * Match by tenant + canonical table name, never by
   * Edge table ID and never by unrelated Cloud map ID.
   */
  await tx.qRun(
    `
    UPDATE
      public.table_map

    SET
      status =
        $1

    WHERE
      restaurant_id =
        $2

      AND LOWER(
            TRIM(name)
          ) =
          $3
    `,
    [
      status,

      normalized
        .restaurant_id,

      table
        .normalized_name,
    ]
  );

  const session =
    normalized
      .payload
      .session;

  if (
    session ===
    null
  ) {
    await tx.qRun(
      `
      DELETE FROM
        public.pos_table_sessions

      WHERE
        restaurant_id =
          $1

        AND table_id =
          $2
      `,
      [
        normalized
          .restaurant_id,

        Number(
          table.id
        ),
      ]
    );
  } else {
    await tx.qRun(
      `
      INSERT INTO
        public.pos_table_sessions
      (
        restaurant_id,
        table_id,
        covers,
        allergy_codes,
        strict_cross_contamination
      )

      VALUES (
        $1,
        $2,
        $3,
        $4::jsonb,
        $5
      )

      ON CONFLICT
      (
        restaurant_id,
        table_id
      )

      DO UPDATE SET
        covers =
          EXCLUDED.covers,

        allergy_codes =
          EXCLUDED.allergy_codes,

        strict_cross_contamination =
          EXCLUDED.strict_cross_contamination,

        updated_at =
          NOW()
      `,
      [
        normalized
          .restaurant_id,

        Number(
          table.id
        ),

        session
          .covers,

        JSON.stringify(
          session
            .allergy_codes
        ),

        session
          .strict_cross_contamination,
      ]
    );
  }

  return {
    table_id:
      Number(
        table.id
      ),

    table_name:
      table.name,

    normalized_name:
      table
        .normalized_name,

    status,

    session:
      session ===
      null
        ? null
        : {
            covers:
              session.covers,

            allergy_codes:
              [
                ...session
                  .allergy_codes,
              ],

            strict_cross_contamination:
              session
                .strict_cross_contamination,
          },
  };
}


async function assertCloudBatchAssignmentDependenciesTx(
  tx,
  normalized
) {
  requireTx(
    tx
  );

  const batch =
    await tx.qGet(
      `
      SELECT
        id,
        restaurant_id,
        table_number,
        order_type,
        pickup_number

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
    /*
     * Dependency failure is intentional.
     *
     * POS operational materialization is the authority that
     * creates the Cloud order batch. Never invent a batch here.
     *
     * Because this runs inside the same transaction as the
     * inbox claim and domain revision, throwing here causes
     * the whole apply attempt to roll back and remain retryable.
     */
    fail(
      "EDGE_TABLE_BATCH_REQUIRED",
      "Cloud order batch must exist before table assignment can apply"
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
      "EDGE_TABLE_BATCH_TENANT_COLLISION",
      "Table assignment batch UUID belongs to another restaurant"
    );
  }

  /*
   * The Edge producer transfers the active unpaid bill.
   *
   * Require the corresponding active Cloud POS rows before
   * consuming the assignment revision. This protects the
   * assignment-before-POS dependency case.
   */
  const activeRow =
    await tx.qGet(
      `
      SELECT
        id

      FROM
        public.pos_orders

      WHERE
        restaurant_id =
          $1

        AND batch_id =
          $2::uuid

        AND COALESCE(
              paid,
              0
            ) =
            0

        AND COALESCE(
              remaining_price,
              total_price,
              0
            ) >
            0

      ORDER BY
        id ASC

      FOR UPDATE
      `,
      [
        normalized
          .restaurant_id,

        normalized
          .batch_id,
      ]
    );

  if (
    !activeRow
      ?.id
  ) {
    fail(
      "EDGE_TABLE_BATCH_POS_REQUIRED",
      "Cloud active POS rows must exist before table assignment can apply"
    );
  }

  let physicalTable =
    null;

  if (
    normalized
      .payload
      .assignment
      .order_type ===
    "dine-in"
  ) {
    physicalTable =
      await assertCloudPhysicalTableTx(
        tx,
        {
          ...normalized,

          table_name:
            normalizeTableName(
              normalized
                .payload
                .assignment
                .table_number
            ),
        }
      );
  }

  return {
    batch,
    physicalTable,
  };
}


async function replaceCloudTableBatchAssignmentTx(
  tx,
  normalized
) {
  requireTx(
    tx
  );

  const assignment =
    normalized
      .payload
      .assignment;

  const batch =
    await tx.qGet(
      `
      UPDATE
        public.order_batches

      SET
        table_number =
          $3,

        order_type =
          $4,

        pickup_number =
          $5

      WHERE
        restaurant_id =
          $1

        AND id =
          $2::uuid

      RETURNING
        id,
        restaurant_id,
        table_number,
        order_type,
        pickup_number
      `,
      [
        normalized
          .restaurant_id,

        normalized
          .batch_id,

        assignment
          .table_number,

        assignment
          .order_type,

        assignment
          .pickup_number,
      ]
    );

  if (
    !batch
      ?.id
  ) {
    fail(
      "EDGE_TABLE_BATCH_UPDATE_FAILED",
      "Cloud table assignment batch could not be updated"
    );
  }

  /*
   * Mirror the Edge transfer's active-bill semantics.
   *
   * Do not move unrelated historical paid rows.
   * Only rows still belonging to the active unpaid bill
   * follow the assignment.
   */
  const movedRow =
    await tx.qGet(
      `
      UPDATE
        public.pos_orders

      SET
        table_number =
          $3

      WHERE
        restaurant_id =
          $1

        AND batch_id =
          $2::uuid

        AND COALESCE(
              paid,
              0
            ) =
            0

        AND COALESCE(
              remaining_price,
              total_price,
              0
            ) >
            0

      RETURNING
        id
      `,
      [
        normalized
          .restaurant_id,

        normalized
          .batch_id,

        assignment
          .table_number,
      ]
    );

  if (
    !movedRow
      ?.id
  ) {
    fail(
      "EDGE_TABLE_BATCH_POS_UPDATE_FAILED",
      "Cloud active POS rows could not follow table assignment"
    );
  }

  return {
    batch_id:
      normalized
        .batch_id,

    assignment: {
      table_number:
        batch
          .table_number,

      order_type:
        batch
          .order_type,

      pickup_number:
        batch
          .pickup_number ===
        null ||
        batch
          .pickup_number ===
        undefined
          ? null
          : Number(
              batch
                .pickup_number
            ),
    },
  };
}


async function applyTableOperationalCloud({
  event,
  restaurantId,
  sourceInstallationId,
}) {
  assertCloudRuntime();

  const normalized =
    validateTableOperationalEvent(
      event,
      {
        restaurantId,
        sourceInstallationId,
      }
    );

  try {
    return await withTx(
      async (tx) => {
        /*
         * Serialize application by tenant + stable domain.
         *
         * Physical tables each have an independent domain.
         * Batch assignment each has an independent batch UUID
         * domain.
         */
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
            `maks:cloud-table:${normalized.restaurant_id}:${normalized.domain}`,
          ]
        );

        const claim =
          await claimCloudTableInboxTx(
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

            table_name:
              normalized
                .table_name,

            batch_id:
              normalized
                .batch_id,

            result:
              null,
          };
        }

        /*
         * Revision classification MUST happen before mutable
         * business dependencies are required.
         *
         * stale:
         *   acknowledge safely without touching current state
         *
         * duplicate:
         *   acknowledge idempotently without touching current state
         *
         * advance:
         *   only then resolve Cloud-local dependencies and mutate
         *
         * This is especially important for batch assignments:
         * an old stale assignment may arrive after the bill has
         * already been paid and therefore no longer has active
         * unpaid POS rows.
         */
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
                    TABLE_OPERATIONAL_EVENT_TYPE
                  ) {
                    const physicalTable =
                      await assertCloudPhysicalTableTx(
                        tx,
                        normalized
                      );

                    return replaceCloudTableOperationalStateTx(
                      tx,
                      normalized,
                      physicalTable
                    );
                  }

                  await assertCloudBatchAssignmentDependenciesTx(
                    tx,
                    normalized
                  );

                  return replaceCloudTableBatchAssignmentTx(
                    tx,
                    normalized
                  );
                },
            }
          );

        await finalizeCloudTableInboxTx(
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

          table_name:
            normalized
              .table_name,

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
          "EDGE_TABLE_REVISION_ERROR",

        error.message ||
          "Table operational domain revision failed",

        error.details ??
          null
      );
    }

    throw error;
  }
}


module.exports = {
  TABLE_OPERATIONAL_EVENT_TYPE,
  TABLE_OPERATIONAL_SCHEMA_VERSION,
  TableOperationalSyncError,
  normalizeTableName,
  tableOperationalDomain,
  isTableEdgeProducerRuntime,
  isTableOperationalEventType,
  validateTableOperationalEvent,
  applyTableOperationalCloud,
  validateTableOperationalPayload,
  loadTableOperationalSnapshotTx,
  emitTableOperationalSnapshotTx,
  TABLE_BATCH_ASSIGNMENT_EVENT_TYPE,
  TABLE_BATCH_ASSIGNMENT_SCHEMA_VERSION,
  normalizeTableBatchId,
  tableBatchAssignmentDomain,
  validateTableBatchAssignmentPayload,
  loadTableBatchAssignmentSnapshotTx,
  emitTableBatchAssignmentSnapshotTx,
};
