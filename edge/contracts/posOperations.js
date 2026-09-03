"use strict";

const { withTx } = require("../../dbCompat");
const { assertCloudRuntime } = require("../../utils/runtimeRole");

const EVENT_TYPE = "pos.order.submitted";
const SCHEMA_VERSION = 2;
const MAX_POS_ROWS = 500;
const MAX_KDS_ROWS = 250;
const MAX_EVENT_BYTES = 768 * 1024;

class PosOperationalSyncError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "PosOperationalSyncError";
    this.code = code;
    if (details !== null) this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new PosOperationalSyncError(code, message, details);
}

function obj(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("EDGE_POS_PAYLOAD_INVALID", `${label} must be an object`);
  }
  return value;
}

function only(value, allowed, label) {
  const set = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !set.has(key));
  if (unknown.length) {
    fail(
      "EDGE_POS_PAYLOAD_INVALID",
      `${label} contains unsupported fields`,
      { fields: unknown.slice(0, 20) }
    );
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function uuid(value, label) {
  const out = String(value || "").trim();
  if (!isUuid(out)) {
    fail("EDGE_POS_UUID_INVALID", `${label} must be a UUID`);
  }
  return out;
}

function rid(value) {
  const out = Number(value);
  if (!Number.isSafeInteger(out) || out <= 0) {
    fail("EDGE_POS_TENANT_INVALID", "restaurant_id is invalid");
  }
  return out;
}

function num(
  value,
  label,
  { nullable = false, integer = false, min = -1e12, max = 1e12 } = {}
) {
  if (
    nullable &&
    (value === null || value === undefined || String(value).trim() === "")
  ) {
    return null;
  }
  const out = Number(value);
  if (
    !Number.isFinite(out) ||
    out < min ||
    out > max ||
    (integer && !Number.isSafeInteger(out))
  ) {
    fail("EDGE_POS_NUMBER_INVALID", `${label} is invalid`);
  }
  return out;
}

function txt(
  value,
  label,
  { nullable = false, blank = false, max = 4000 } = {}
) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    fail("EDGE_POS_TEXT_REQUIRED", `${label} is required`);
  }
  const out = String(value);
  if (!blank && !out.trim()) {
    fail("EDGE_POS_TEXT_REQUIRED", `${label} is required`);
  }
  if (out.length > max) {
    fail("EDGE_POS_TEXT_TOO_LONG", `${label} is too long`);
  }
  return out;
}

function timestamp(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail("EDGE_POS_TIMESTAMP_INVALID", `${label} is invalid`);
  }
  return date.toISOString();
}

function clone(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? fallback : value));
  } catch {
    fail("EDGE_POS_JSON_INVALID", "Operational event contains invalid JSON");
  }
}

function bool(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value || "").trim().toLowerCase() === "true"
  );
}

const EVENT_KEYS = [
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

const PAYLOAD_KEYS = [
  "schema_version",
  "restaurant_id",
  "batch_id",
  "submission_id",
  "pos_order_ids",
  "order_type",
  "source",
  "table_number",
  "pickup_number",
  "append_to_existing_batch",
  "hold_until_paid",
  "pricing",
  "batch",
  "pos_rows",
  "kds_rows",
];

const BATCH_KEYS = [
  "id",
  "restaurant_id",
  "table_number",
  "order_type",
  "pickup_number",
  "requested_payment_method",
  "delivery_status",
  "delivery_code",
  "created_at",
];

const POS_KEYS = [
  "id",
  "restaurant_id",
  "table_number",
  "meal_id",
  "menu_item_id",
  "stock_id",
  "item_name",
  "quantity",
  "total_price",
  "vat_rate",
  "vat_gross",
  "vat_net",
  "vat_amount",
  "item_type",
  "order_status",
  "paid",
  "options",
  "note",
  "batch_id",
  "created_at",
  "category_id",
  "is_starred",
  "is_priority",
  "table_allergy_codes",
  "item_allergen_contains",
  "allergen_conflicts",
  "strict_cross_contamination",
  "table_covers",
  "amount_paid",
  "remaining_price",
  "source",
  "expires_at",
  "edge_submission_id",
  "edge_row_ordinal",
];

const KDS_KEYS = [
  "id",
  "restaurant_id",
  "table_number",
  "items",
  "total_price",
  "paid",
  "created_at",
  "options",
  "note",
  "special_requests",
  "payment_method",
  "paid_at",
  "order_type",
  "meal_name",
  "category",
  "station",
  "quantity",
  "order_status",
  "batch_id",
  "price_per_unit",
  "category_id",
  "is_priority",
];

function validatePricing(raw) {
  const value = obj(raw, "payload.pricing");
  only(
    value,
    ["subtotal", "pricing_discount", "total", "applied_rules"],
    "payload.pricing"
  );
  return {
    subtotal: num(value.subtotal ?? 0, "payload.pricing.subtotal"),
    pricing_discount: num(
      value.pricing_discount ?? 0,
      "payload.pricing.pricing_discount"
    ),
    total: num(value.total ?? 0, "payload.pricing.total"),
    applied_rules: clone(value.applied_rules, []),
  };
}

function validateBatch(raw, restaurantId, batchId) {
  const value = obj(raw, "payload.batch");
  only(value, BATCH_KEYS, "payload.batch");

  const rowRid = rid(value.restaurant_id);
  if (rowRid !== restaurantId) {
    fail("EDGE_POS_TENANT_MISMATCH", "Batch crossed restaurant boundary");
  }

  const rowBatch = uuid(value.id, "payload.batch.id");
  if (rowBatch !== batchId) {
    fail("EDGE_POS_BATCH_MISMATCH", "Batch snapshot does not match batch_id");
  }

  return {
    id: rowBatch,
    restaurant_id: rowRid,
    table_number: txt(value.table_number, "batch.table_number", {
      nullable: true,
      blank: true,
      max: 200,
    }),
    order_type: txt(value.order_type || "dine-in", "batch.order_type", {
      max: 40,
    })
      .trim()
      .toLowerCase(),
    pickup_number: num(value.pickup_number, "batch.pickup_number", {
      nullable: true,
      integer: true,
      min: 0,
      max: 100000000,
    }),
    requested_payment_method: txt(
      value.requested_payment_method,
      "batch.requested_payment_method",
      { nullable: true, blank: true, max: 40 }
    ),
    delivery_status: txt(value.delivery_status, "batch.delivery_status", {
      nullable: true,
      blank: true,
      max: 100,
    }),
    delivery_code: txt(value.delivery_code, "batch.delivery_code", {
      nullable: true,
      blank: true,
      max: 200,
    }),
    created_at: timestamp(value.created_at, "batch.created_at"),
  };
}

function validatePosRows(
  rawRows,
  restaurantId,
  batchId,
  submissionId,
  posOrderIds
) {
  if (
    !Array.isArray(rawRows) ||
    rawRows.length < 1 ||
    rawRows.length > MAX_POS_ROWS ||
    rawRows.length !== posOrderIds.length
  ) {
    fail(
      "EDGE_POS_ROWS_INVALID",
      "pos_rows must match pos_order_ids and contain 1 to 500 rows"
    );
  }

  const ids = new Set();
  const ordinals = new Set();

  const rows = rawRows.map((raw, index) => {
    const value = obj(raw, `payload.pos_rows[${index}]`);
    only(value, POS_KEYS, `payload.pos_rows[${index}]`);

    const rowRid = rid(value.restaurant_id);
    if (rowRid !== restaurantId) {
      fail("EDGE_POS_TENANT_MISMATCH", "POS row crossed restaurant boundary");
    }

    const rowBatch = uuid(value.batch_id, `pos_rows[${index}].batch_id`);
    if (rowBatch !== batchId) {
      fail("EDGE_POS_BATCH_MISMATCH", "POS row crossed batch boundary");
    }

    const rowSubmission = uuid(
      value.edge_submission_id,
      `pos_rows[${index}].edge_submission_id`
    );
    if (rowSubmission !== submissionId) {
      fail(
        "EDGE_POS_SUBMISSION_MISMATCH",
        "POS row submission identity does not match payload"
      );
    }

    const edgeId = num(value.id, `pos_rows[${index}].id`, {
      integer: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    });
    if (edgeId !== posOrderIds[index]) {
      fail(
        "EDGE_POS_ID_ORDER_MISMATCH",
        "pos_rows order does not match pos_order_ids"
      );
    }
    if (ids.has(edgeId)) {
      fail("EDGE_POS_ID_DUPLICATE", "Duplicate Edge POS row id");
    }
    ids.add(edgeId);

    const ordinal = num(value.edge_row_ordinal, "pos.edge_row_ordinal", {
      integer: true,
      min: 1,
      max: MAX_POS_ROWS,
    });
    if (ordinals.has(ordinal)) {
      fail("EDGE_POS_ORDINAL_DUPLICATE", "Duplicate POS row ordinal");
    }
    ordinals.add(ordinal);

    return {
      edge_pos_order_id: edgeId,
      edge_submission_id: rowSubmission,
      edge_row_ordinal: ordinal,
      restaurant_id: rowRid,
      table_number: txt(value.table_number, "pos.table_number", { max: 200 }),
      meal_id:
        value.meal_id === null ||
        value.meal_id === undefined ||
        String(value.meal_id).trim() === ""
          ? null
          : String(value.meal_id),
      menu_item_id: num(value.menu_item_id, "pos.menu_item_id", {
        nullable: true,
        integer: true,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      }),
      stock_id: num(value.stock_id, "pos.stock_id", {
        nullable: true,
        integer: true,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      }),
      item_name: txt(value.item_name, "pos.item_name", { max: 500 }),
      quantity: num(value.quantity ?? 1, "pos.quantity", {
        min: 0,
        max: 1000000,
      }),
      total_price: num(value.total_price ?? 0, "pos.total_price"),
      vat_rate: num(value.vat_rate, "pos.vat_rate", {
        nullable: true,
        min: 0,
        max: 100,
      }),
      vat_gross: num(value.vat_gross, "pos.vat_gross", { nullable: true }),
      vat_net: num(value.vat_net, "pos.vat_net", { nullable: true }),
      vat_amount: num(value.vat_amount, "pos.vat_amount", { nullable: true }),
      item_type: txt(value.item_type || "misc", "pos.item_type", { max: 40 }),
      order_status: txt(value.order_status || "open", "pos.order_status", {
        max: 80,
      }),
      paid: num(value.paid ?? 0, "pos.paid", {
        integer: true,
        min: 0,
        max: 1,
      }),
      options: clone(value.options, {}),
      note: txt(value.note, "pos.note", {
        nullable: true,
        blank: true,
        max: 4000,
      }),
      batch_id: rowBatch,
      created_at: timestamp(value.created_at, "pos.created_at"),
      category_id: num(value.category_id, "pos.category_id", {
        nullable: true,
        integer: true,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      }),
      is_starred: bool(value.is_starred),
      is_priority: bool(value.is_priority),
      table_allergy_codes: clone(value.table_allergy_codes, []),
      item_allergen_contains: clone(value.item_allergen_contains, []),
      allergen_conflicts: clone(value.allergen_conflicts, []),
      strict_cross_contamination: bool(value.strict_cross_contamination),
      table_covers: num(value.table_covers ?? 1, "pos.table_covers", {
        integer: true,
        min: 1,
        max: 10000,
      }),
      amount_paid: num(value.amount_paid ?? 0, "pos.amount_paid"),
      remaining_price: num(
        value.remaining_price ?? value.total_price ?? 0,
        "pos.remaining_price"
      ),
      source: txt(value.source || "pos", "pos.source", { max: 40 })
        .trim()
        .toLowerCase(),
      expires_at: timestamp(value.expires_at, "pos.expires_at"),
    };
  });

  rows.sort((a, b) => a.edge_row_ordinal - b.edge_row_ordinal);
  rows.forEach((row, index) => {
    if (row.edge_row_ordinal !== index + 1) {
      fail(
        "EDGE_POS_ORDINAL_GAP",
        "POS row ordinals must be consecutive from 1"
      );
    }
  });

  return rows;
}

function validateKdsRows(rawRows, restaurantId, batchId) {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_KDS_ROWS) {
    fail(
      "EDGE_POS_KDS_ROWS_INVALID",
      "kds_rows must be an array of at most 250 rows"
    );
  }

  return rawRows.map((raw, index) => {
    const value = obj(raw, `payload.kds_rows[${index}]`);
    only(value, KDS_KEYS, `payload.kds_rows[${index}]`);

    const rowRid = rid(value.restaurant_id);
    if (rowRid !== restaurantId) {
      fail("EDGE_POS_TENANT_MISMATCH", "KDS row crossed restaurant boundary");
    }

    const rowBatch = uuid(value.batch_id, `kds_rows[${index}].batch_id`);
    if (rowBatch !== batchId) {
      fail("EDGE_POS_BATCH_MISMATCH", "KDS row crossed batch boundary");
    }

    return {
      restaurant_id: rowRid,
      table_number: txt(value.table_number, "kds.table_number", {
        nullable: true,
        blank: true,
        max: 200,
      }),
      items: clone(value.items, []),
      total_price: num(value.total_price ?? 0, "kds.total_price"),
      paid: bool(value.paid),
      created_at: timestamp(value.created_at, "kds.created_at"),
      options: clone(value.options, {}),
      note: txt(value.note, "kds.note", {
        nullable: true,
        blank: true,
        max: 4000,
      }),
      special_requests: txt(value.special_requests, "kds.special_requests", {
        nullable: true,
        blank: true,
        max: 4000,
      }),
      payment_method: txt(value.payment_method, "kds.payment_method", {
        nullable: true,
        blank: true,
        max: 40,
      }),
      paid_at: timestamp(value.paid_at, "kds.paid_at"),
      order_type: txt(value.order_type || "dine-in", "kds.order_type", {
        max: 40,
      })
        .trim()
        .toLowerCase(),
      meal_name: txt(value.meal_name, "kds.meal_name", { max: 500 }),
      category: txt(value.category || "meals", "kds.category", { max: 100 }),
      station: txt(value.station, "kds.station", {
        nullable: true,
        blank: true,
        max: 100,
      }),
      quantity: num(value.quantity ?? 1, "kds.quantity", {
        integer: true,
        min: 1,
        max: 1000000,
      }),
      order_status: txt(value.order_status || "pending", "kds.order_status", {
        max: 80,
      }),
      batch_id: rowBatch,
      price_per_unit: num(value.price_per_unit ?? 0, "kds.price_per_unit"),
      category_id: num(value.category_id, "kds.category_id", {
        nullable: true,
        integer: true,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      }),
      is_priority: bool(value.is_priority),
    };
  });
}

function validatePosOrderSubmittedEvent(
  event,
  { restaurantId, sourceInstallationId }
) {
  const bytes = Buffer.byteLength(JSON.stringify(event || {}), "utf8");
  if (bytes > MAX_EVENT_BYTES) {
    fail("EDGE_POS_EVENT_TOO_LARGE", "POS operational event exceeds 768 KiB");
  }

  const envelope = obj(event, "event");
  only(envelope, EVENT_KEYS, "event");

  const tenantId = rid(restaurantId);
  const installationId = uuid(
    sourceInstallationId,
    "sourceInstallationId"
  );
  const eventId = uuid(envelope.event_id, "event.event_id");

  if (String(envelope.event_type || "") !== EVENT_TYPE) {
    fail("EDGE_POS_EVENT_TYPE_INVALID", "Unexpected POS event type");
  }
  if (String(envelope.entity_type || "") !== "order_batch") {
    fail(
      "EDGE_POS_ENTITY_TYPE_INVALID",
      "POS event entity_type must be order_batch"
    );
  }

  const payload = obj(envelope.payload, "event.payload");
  only(payload, PAYLOAD_KEYS, "event.payload");

  if (Number(payload.schema_version) !== SCHEMA_VERSION) {
    fail(
      "EDGE_POS_SCHEMA_UNSUPPORTED",
      "POS operational payload schema is unsupported"
    );
  }

  const payloadRid = rid(payload.restaurant_id);
  if (payloadRid !== tenantId || Number(envelope.restaurant_id) !== tenantId) {
    fail(
      "EDGE_POS_TENANT_MISMATCH",
      "POS event restaurant does not match authenticated Edge"
    );
  }

  const batchId = uuid(payload.batch_id, "payload.batch_id");
  if (String(envelope.entity_id || "") !== batchId) {
    fail(
      "EDGE_POS_BATCH_MISMATCH",
      "event.entity_id does not match payload.batch_id"
    );
  }

  const submissionId = uuid(payload.submission_id, "payload.submission_id");
  if (
    String(envelope.idempotency_key || "") !==
    `pos.order.submitted:${submissionId}`
  ) {
    fail(
      "EDGE_POS_IDEMPOTENCY_MISMATCH",
      "POS idempotency key does not match submission_id"
    );
  }

  if (
    !Array.isArray(payload.pos_order_ids) ||
    payload.pos_order_ids.length < 1 ||
    payload.pos_order_ids.length > MAX_POS_ROWS
  ) {
    fail("EDGE_POS_IDS_INVALID", "pos_order_ids is invalid");
  }

  const posOrderIds = payload.pos_order_ids.map((value, index) =>
    num(value, `pos_order_ids[${index}]`, {
      integer: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    })
  );
  if (new Set(posOrderIds).size !== posOrderIds.length) {
    fail("EDGE_POS_IDS_DUPLICATE", "pos_order_ids contains duplicates");
  }

  const orderType = txt(payload.order_type || "dine-in", "payload.order_type", {
    max: 40,
  })
    .trim()
    .toLowerCase();

  const tableNumber = txt(payload.table_number, "payload.table_number", {
    max: 200,
  });

  const pickupNumber = num(payload.pickup_number, "payload.pickup_number", {
    nullable: true,
    integer: true,
    min: 0,
    max: 100000000,
  });

  const batch = validateBatch(payload.batch, tenantId, batchId);

  if (
    String(batch.table_number || "") !== String(tableNumber || "") ||
    batch.order_type !== orderType ||
    (batch.pickup_number ?? null) !== (pickupNumber ?? null)
  ) {
    fail(
      "EDGE_POS_BATCH_PAYLOAD_MISMATCH",
      "Batch snapshot does not match top-level POS payload"
    );
  }

  return {
    event_id: eventId,
    restaurant_id: tenantId,
    source_installation_id: installationId,
    batch_id: batchId,
    submission_id: submissionId,
    order_type: orderType,
    source: txt(payload.source || "pos", "payload.source", { max: 40 })
      .trim()
      .toLowerCase(),
    table_number: tableNumber,
    pickup_number: pickupNumber,
    append_to_existing_batch: bool(payload.append_to_existing_batch),
    hold_until_paid: bool(payload.hold_until_paid),
    pricing: validatePricing(payload.pricing),
    batch,
    pos_rows: validatePosRows(
      payload.pos_rows,
      tenantId,
      batchId,
      submissionId,
      posOrderIds
    ),
    kds_rows: validateKdsRows(payload.kds_rows, tenantId, batchId),
  };
}

function sameNullableNumber(a, b) {
  const left = a === null || a === undefined ? null : Number(a);
  const right = b === null || b === undefined ? null : Number(b);
  return left === right;
}

function assertBatchCompatible(existing, incoming) {
  if (
    Number(existing.restaurant_id) !== incoming.restaurant_id ||
    String(existing.table_number || "") !== String(incoming.table_number || "") ||
    String(existing.order_type || "dine-in").trim().toLowerCase() !==
      incoming.order_type ||
    !sameNullableNumber(existing.pickup_number, incoming.pickup_number)
  ) {
    fail(
      "EDGE_POS_BATCH_CONFLICT",
      "Existing Cloud batch conflicts with Edge batch identity"
    );
  }
}

async function applyPosOrderSubmittedCloud({
  event,
  restaurantId,
  sourceInstallationId,
}) {
  assertCloudRuntime();

  const normalized = validatePosOrderSubmittedEvent(event, {
    restaurantId,
    sourceInstallationId,
  });

  return withTx(async (tx) => {
    await tx.qGet(
      `
      SELECT pg_advisory_xact_lock(
        hashtextextended($1, 0)
      ) AS locked
      `,
      [
        `maks:cloud-pos:${normalized.restaurant_id}:${normalized.submission_id}`,
      ]
    );

    const inbox = await tx.qGet(
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
      FROM public.edge_inbox
      WHERE event_id = $1::uuid
      FOR UPDATE
      `,
      [normalized.event_id]
    );

    if (!inbox) {
      fail(
        "EDGE_POS_INBOX_REQUIRED",
        "POS event must be durably received before Cloud apply"
      );
    }

    if (
      Number(inbox.restaurant_id) !== normalized.restaurant_id ||
      String(inbox.source || "") !== "edge" ||
      String(inbox.source_installation_id || "") !==
        normalized.source_installation_id ||
      String(inbox.event_type || "") !== EVENT_TYPE ||
      String(inbox.entity_type || "") !== "order_batch" ||
      String(inbox.entity_id || "") !== normalized.batch_id
    ) {
      fail(
        "EDGE_POS_INBOX_IDENTITY_MISMATCH",
        "Durable inbox identity does not match POS event"
      );
    }

    if (String(inbox.status || "") === "applied") {
      return {
        duplicate: true,
        batch_id: normalized.batch_id,
        submission_id: normalized.submission_id,
        pos_rows: 0,
        kds_rows: 0,
        mapping: [],
      };
    }

    if (!["received", "failed"].includes(String(inbox.status || ""))) {
      fail(
        "EDGE_POS_INBOX_STATE_INVALID",
        "POS inbox event is not in an applicable state"
      );
    }

    /*
     * Respect the hardened Edge inbox state machine:
     *
     *   received/failed -> applying -> applied
     *
     * The applying claim lives in the SAME PostgreSQL
     * transaction as the Cloud POS/KDS materialization.
     * Therefore any later business failure rolls the claim
     * back together with the business rows.
     */
    const applyWorkerId =
      `cloud-pos-inline:${normalized.source_installation_id}`;

    const claimedInbox =
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
          apply_attempts,
          locked_by
        `,
        [
          normalized.event_id,
          normalized.restaurant_id,
          applyWorkerId,
        ]
      );

    if (
      !claimedInbox?.event_id ||
      String(
        claimedInbox.status || ""
      ) !== "applying" ||
      String(
        claimedInbox.locked_by || ""
      ) !== applyWorkerId
    ) {
      fail(
        "EDGE_POS_INBOX_CLAIM_FAILED",
        "POS operational inbox event could not enter applying state"
      );
    }

    const previous = await tx.qAll(
      `
      SELECT id, batch_id, edge_row_ordinal
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND edge_submission_id = $2::uuid
      ORDER BY edge_row_ordinal, id
      FOR UPDATE
      `,
      [normalized.restaurant_id, normalized.submission_id]
    );

    if (previous.length) {
      fail(
        "EDGE_POS_SUBMISSION_CONFLICT",
        "This submission identity is already materialized by another event"
      );
    }

    const existingBatch = await tx.qGet(
      `
      SELECT
        id,
        restaurant_id,
        table_number,
        order_type,
        pickup_number,
        requested_payment_method,
        delivery_status,
        delivery_code,
        created_at
      FROM public.order_batches
      WHERE id = $1::uuid
      FOR UPDATE
      `,
      [normalized.batch_id]
    );

    if (existingBatch) {
      if (Number(existingBatch.restaurant_id) !== normalized.restaurant_id) {
        fail(
          "EDGE_POS_BATCH_TENANT_COLLISION",
          "order batch UUID belongs to another restaurant"
        );
      }
      assertBatchCompatible(existingBatch, normalized.batch);
    } else {
      await tx.qRun(
        `
        INSERT INTO public.order_batches (
          id,
          table_number,
          restaurant_id,
          delivery_status,
          delivery_code,
          created_at,
          order_type,
          pickup_number,
          requested_payment_method
        )
        VALUES (
          $1::uuid,
          $2,
          $3,
          $4,
          $5,
          COALESCE($6::timestamptz, NOW()),
          $7,
          $8,
          $9
        )
        `,
        [
          normalized.batch.id,
          normalized.batch.table_number,
          normalized.restaurant_id,
          normalized.batch.delivery_status,
          normalized.batch.delivery_code,
          normalized.batch.created_at,
          normalized.batch.order_type,
          normalized.batch.pickup_number,
          normalized.batch.requested_payment_method,
        ]
      );
    }

    const mapping = [];

    for (const row of normalized.pos_rows) {
      const inserted = await tx.qGet(
        `
        INSERT INTO public.pos_orders (
          restaurant_id,
          table_number,
          meal_id,
          menu_item_id,
          stock_id,
          item_name,
          quantity,
          total_price,
          vat_rate,
          vat_gross,
          vat_net,
          vat_amount,
          item_type,
          order_status,
          paid,
          options,
          note,
          batch_id,
          created_at,
          category_id,
          is_starred,
          is_priority,
          table_allergy_codes,
          item_allergen_contains,
          allergen_conflicts,
          strict_cross_contamination,
          table_covers,
          amount_paid,
          remaining_price,
          source,
          expires_at,
          edge_submission_id,
          edge_row_ordinal
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,
          $16::jsonb,$17,$18::uuid,
          COALESCE($19::timestamptz, NOW()),
          $20,$21,$22,
          $23::jsonb,$24::jsonb,$25::jsonb,
          $26,$27,$28,$29,$30,
          $31::timestamptz,$32::uuid,$33
        )
        RETURNING id
        `,
        [
          normalized.restaurant_id,
          row.table_number,
          row.meal_id,
          row.menu_item_id,
          row.stock_id,
          row.item_name,
          row.quantity,
          row.total_price,
          row.vat_rate,
          row.vat_gross,
          row.vat_net,
          row.vat_amount,
          row.item_type,
          row.order_status,
          row.paid,
          JSON.stringify(row.options || {}),
          row.note,
          normalized.batch_id,
          row.created_at,
          row.category_id,
          row.is_starred,
          row.is_priority,
          JSON.stringify(row.table_allergy_codes || []),
          JSON.stringify(row.item_allergen_contains || []),
          JSON.stringify(row.allergen_conflicts || []),
          row.strict_cross_contamination,
          row.table_covers,
          row.amount_paid,
          row.remaining_price,
          row.source,
          row.expires_at,
          normalized.submission_id,
          row.edge_row_ordinal,
        ]
      );

      mapping.push({
        edge_pos_order_id: row.edge_pos_order_id,
        cloud_pos_order_id: Number(inserted.id),
        edge_row_ordinal: row.edge_row_ordinal,
      });
    }

    for (const row of normalized.kds_rows) {
      await tx.qRun(
        `
        INSERT INTO public.orders (
          table_number,
          items,
          total_price,
          paid,
          created_at,
          restaurant_id,
          options,
          note,
          special_requests,
          payment_method,
          paid_at,
          order_type,
          meal_name,
          category,
          station,
          quantity,
          order_status,
          batch_id,
          price_per_unit,
          category_id,
          is_priority
        )
        VALUES (
          $1,$2::jsonb,$3,$4,
          COALESCE($5::timestamptz, NOW()),
          $6,$7::jsonb,$8,$9,$10,
          $11::timestamptz,$12,$13,$14,$15,
          $16,$17,$18::uuid,$19,$20,$21
        )
        `,
        [
          row.table_number,
          JSON.stringify(row.items || []),
          row.total_price,
          row.paid,
          row.created_at,
          normalized.restaurant_id,
          JSON.stringify(row.options || {}),
          row.note,
          row.special_requests,
          row.payment_method,
          row.paid_at,
          row.order_type,
          row.meal_name,
          row.category,
          row.station,
          row.quantity,
          row.order_status,
          normalized.batch_id,
          row.price_per_unit,
          row.category_id,
          row.is_priority,
        ]
      );
    }

    const appliedInbox =
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
          normalized.event_id,
          normalized.restaurant_id,
          applyWorkerId,
        ]
      );

    if (
      !appliedInbox?.event_id ||
      String(
        appliedInbox.status || ""
      ) !== "applied" ||
      !appliedInbox.applied_at
    ) {
      fail(
        "EDGE_POS_INBOX_FINALIZE_FAILED",
        "POS operational inbox event could not enter applied state"
      );
    }

    return {
      duplicate: false,
      batch_id: normalized.batch_id,
      submission_id: normalized.submission_id,
      pos_rows: normalized.pos_rows.length,
      kds_rows: normalized.kds_rows.length,
      mapping,
    };
  });
}

module.exports = {
  POS_ORDER_SUBMITTED_EVENT_TYPE: EVENT_TYPE,
  POS_ORDER_SUBMITTED_SCHEMA_VERSION: SCHEMA_VERSION,
  PosOperationalSyncError,
  validatePosOrderSubmittedEvent,
  applyPosOrderSubmittedCloud,
};
