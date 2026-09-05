"use strict";

const {
  enqueueEdgeEventTx,
} = require(
  "../syncStore"
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


/*
 * =========================================================
 * MAKS EDGE — IMMUTABLE FINANCIAL SETTLEMENT CONTRACT
 * =========================================================
 *
 * First financial replication primitive:
 *
 *   financial.settlement.recorded.v1
 *
 * This event represents one immutable payment settlement
 * together with the tender rows created for that settlement.
 *
 * IMPORTANT CROSS-DATABASE RULE:
 *
 * PostgreSQL BIGSERIAL IDs are local database identities.
 *
 * Therefore:
 *
 *   payment_settlements.id
 *     -> portable UUID
 *
 *   payments.payment_uuid
 *     -> portable UUID
 *
 *   pos_orders.id
 *     -> NEVER Cloud authority
 *
 * POS rows cross the Edge/Cloud boundary using:
 *
 *   restaurant_id
 *   edge_submission_id
 *   edge_row_ordinal
 *
 * batch_id is also carried as a defensive identity check.
 */

const FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE =
  "financial.settlement.recorded.v1";

const FINANCIAL_SETTLEMENT_SCHEMA_VERSION =
  1;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_SETTLEMENT_ORDER_REFS =
  1000;

const MAX_TENDERS =
  100;

const MAX_EVENT_BYTES =
  768 * 1024;


class FinancialOperationalSyncError
  extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "FinancialOperationalSyncError";

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
  throw new FinancialOperationalSyncError(
    code,
    message,
    details
  );
}


function requireTx(
  tx
) {
  if (
    !tx?.qGet ||
    !tx?.qAll
  ) {
    fail(
      "EDGE_FINANCIAL_TX_REQUIRED",
      "Financial Edge operations require an active database transaction"
    );
  }

  if (
    tx.kind !== "pg"
  ) {
    fail(
      "EDGE_FINANCIAL_POSTGRES_REQUIRED",
      "Financial Edge operations require PostgreSQL"
    );
  }

  return tx;
}


function requireRestaurantId(
  value
) {
  const rid =
    Number(
      value
    );

  if (
    !Number.isSafeInteger(
      rid
    ) ||
    rid <= 0
  ) {
    fail(
      "EDGE_FINANCIAL_RESTAURANT_INVALID",
      "Financial settlement requires a valid restaurant_id"
    );
  }

  return rid;
}


function requireUuid(
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
    !UUID_RE.test(
      uuid
    )
  ) {
    fail(
      "EDGE_FINANCIAL_UUID_INVALID",
      `${field} must be a valid UUID`
    );
  }

  return uuid;
}


function optionalUuid(
  value,
  field
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  return requireUuid(
    value,
    field
  );
}


function requireText(
  value,
  field,
  {
    max = 255,
    allowEmpty = false,
  } = {}
) {
  const text =
    String(
      value ?? ""
    ).trim();

  if (
    (!allowEmpty && !text) ||
    text.length > max
  ) {
    fail(
      "EDGE_FINANCIAL_TEXT_INVALID",
      `${field} is invalid`
    );
  }

  return text;
}


function optionalText(
  value,
  field,
  {
    max = 255,
  } = {}
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  return requireText(
    value,
    field,
    {
      max,
      allowEmpty:
        false,
    }
  );
}


function money(
  value,
  field,
  {
    min = null,
  } = {}
) {
  const number =
    Number(
      value
    );

  if (
    !Number.isFinite(
      number
    )
  ) {
    fail(
      "EDGE_FINANCIAL_AMOUNT_INVALID",
      `${field} must be a finite number`
    );
  }

  const rounded =
    Number(
      number.toFixed(2)
    );

  if (
    min !== null &&
    rounded < min
  ) {
    fail(
      "EDGE_FINANCIAL_AMOUNT_INVALID",
      `${field} is below its allowed minimum`
    );
  }

  return rounded;
}


function integerOrNull(
  value,
  field,
  {
    min = 1,
  } = {}
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
    number < min
  ) {
    fail(
      "EDGE_FINANCIAL_INTEGER_INVALID",
      `${field} is invalid`
    );
  }

  return number;
}


function timestamp(
  value,
  field
) {
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
      "EDGE_FINANCIAL_TIMESTAMP_INVALID",
      `${field} is invalid`
    );
  }

  return date.toISOString();
}


function parseJsonArray(
  value,
  field
) {
  if (
    Array.isArray(
      value
    )
  ) {
    return value;
  }

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return [];
  }

  if (
    typeof value ===
    "string"
  ) {
    try {
      const parsed =
        JSON.parse(
          value
        );

      if (
        Array.isArray(
          parsed
        )
      ) {
        return parsed;
      }
    } catch {
      // handled below
    }
  }

  fail(
    "EDGE_FINANCIAL_JSON_ARRAY_INVALID",
    `${field} must be an array`
  );
}


function parseJsonObject(
  value,
  field
) {
  if (
    value &&
    typeof value ===
      "object" &&
    !Array.isArray(
      value
    )
  ) {
    return value;
  }

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return {};
  }

  if (
    typeof value ===
    "string"
  ) {
    try {
      const parsed =
        JSON.parse(
          value
        );

      if (
        parsed &&
        typeof parsed ===
          "object" &&
        !Array.isArray(
          parsed
        )
      ) {
        return parsed;
      }
    } catch {
      // handled below
    }
  }

  fail(
    "EDGE_FINANCIAL_JSON_OBJECT_INVALID",
    `${field} must be an object`
  );
}


function cleanLocalOrderIds(
  value,
  field
) {
  const raw =
    parseJsonArray(
      value,
      field
    );

  const ids =
    raw.map(
      (one) =>
        Number(
          one
        )
    );

  if (
    ids.some(
      (id) =>
        !Number.isSafeInteger(
          id
        ) ||
        id <= 0
    )
  ) {
    fail(
      "EDGE_FINANCIAL_LOCAL_ORDER_IDS_INVALID",
      `${field} contains an invalid local POS order id`
    );
  }

  return Array.from(
    new Set(
      ids
    )
  );
}


function normalizeOrderRef(
  value,
  field =
    "order_ref"
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
      "EDGE_FINANCIAL_ORDER_REF_INVALID",
      `${field} must be an object`
    );
  }

  const ordinal =
    Number(
      value.edge_row_ordinal
    );

  if (
    !Number.isSafeInteger(
      ordinal
    ) ||
    ordinal <= 0
  ) {
    fail(
      "EDGE_FINANCIAL_ORDER_REF_INVALID",
      `${field}.edge_row_ordinal is invalid`
    );
  }

  return {
    edge_submission_id:
      requireUuid(
        value.edge_submission_id,
        `${field}.edge_submission_id`
      ),

    edge_row_ordinal:
      ordinal,

    batch_id:
      requireUuid(
        value.batch_id,
        `${field}.batch_id`
      ),
  };
}


function normalizeOrderRefs(
  value,
  field
) {
  if (
    !Array.isArray(
      value
    )
  ) {
    fail(
      "EDGE_FINANCIAL_ORDER_REFS_INVALID",
      `${field} must be an array`
    );
  }

  if (
    value.length >
    MAX_SETTLEMENT_ORDER_REFS
  ) {
    fail(
      "EDGE_FINANCIAL_ORDER_REFS_TOO_LARGE",
      `${field} contains too many order references`
    );
  }

  const refs =
    value.map(
      (one, index) =>
        normalizeOrderRef(
          one,
          `${field}[${index}]`
        )
    );

  const keys =
    refs.map(
      (ref) =>
        [
          ref.edge_submission_id,
          ref.edge_row_ordinal,
        ].join(":")
    );

  if (
    new Set(
      keys
    ).size !==
    keys.length
  ) {
    fail(
      "EDGE_FINANCIAL_ORDER_REFS_DUPLICATE",
      `${field} contains duplicate order references`
    );
  }

  return refs;
}


function normalizePricingSnapshot(
  value
) {
  const snapshot =
    parseJsonObject(
      value,
      "settlement.pricing_snapshot"
    );

  return JSON.parse(
    JSON.stringify(
      snapshot
    )
  );
}


function validateFinancialSettlementPayload(
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
      "EDGE_FINANCIAL_PAYLOAD_INVALID",
      "Financial settlement payload must be an object"
    );
  }

  if (
    Number(
      value.schema_version
    ) !==
    FINANCIAL_SETTLEMENT_SCHEMA_VERSION
  ) {
    fail(
      "EDGE_FINANCIAL_SCHEMA_UNSUPPORTED",
      "Financial settlement payload schema is unsupported"
    );
  }

  const rid =
    requireRestaurantId(
      value.restaurant_id
    );

  const settlement =
    value.settlement;

  if (
    !settlement ||
    typeof settlement !==
      "object" ||
    Array.isArray(
      settlement
    )
  ) {
    fail(
      "EDGE_FINANCIAL_SETTLEMENT_INVALID",
      "Financial settlement snapshot is invalid"
    );
  }

  const normalizedSettlement = {
    id:
      requireUuid(
        settlement.id,
        "settlement.id"
      ),

    table_number:
      requireText(
        settlement.table_number,
        "settlement.table_number",
        {
          max:
            200,
        }
      ),

    batch_id:
      optionalUuid(
        settlement.batch_id,
        "settlement.batch_id"
      ),

    invoice_number:
      integerOrNull(
        settlement.invoice_number,
        "settlement.invoice_number"
      ),

    gross_amount:
      money(
        settlement.gross_amount,
        "settlement.gross_amount",
        {
          min:
            0,
        }
      ),

    pricing_discount_amount:
      money(
        settlement.pricing_discount_amount,
        "settlement.pricing_discount_amount",
        {
          min:
            0,
        }
      ),

    happy_hour_discount_amount:
      money(
        settlement.happy_hour_discount_amount,
        "settlement.happy_hour_discount_amount",
        {
          min:
            0,
        }
      ),

    deal_adjusted_amount:
      money(
        settlement.deal_adjusted_amount,
        "settlement.deal_adjusted_amount",
        {
          min:
            0,
        }
      ),

    voucher_code:
      optionalText(
        settlement.voucher_code,
        "settlement.voucher_code",
        {
          max:
            200,
        }
      ),

    voucher_discount_amount:
      money(
        settlement.voucher_discount_amount,
        "settlement.voucher_discount_amount",
        {
          min:
            0,
        }
      ),

    manual_discount_amount:
      money(
        settlement.manual_discount_amount,
        "settlement.manual_discount_amount",
        {
          min:
            0,
        }
      ),

    service_charge_amount:
      money(
        settlement.service_charge_amount,
        "settlement.service_charge_amount",
        {
          min:
            0,
        }
      ),

    final_amount:
      money(
        settlement.final_amount,
        "settlement.final_amount",
        {
          min:
            0,
        }
      ),

    applied_rule_ids:
      parseJsonArray(
        settlement.applied_rule_ids,
        "settlement.applied_rule_ids"
      ),

    order_refs:
      normalizeOrderRefs(
        settlement.order_refs,
        "settlement.order_refs"
      ),

    pricing_snapshot:
      normalizePricingSnapshot(
        settlement.pricing_snapshot
      ),

    source:
      requireText(
        settlement.source ||
          "pos",
        "settlement.source",
        {
          max:
            40,
        }
      ),

    created_at:
      timestamp(
        settlement.created_at,
        "settlement.created_at"
      ),
  };

  if (
    !Array.isArray(
      value.tenders
    ) ||
    value.tenders.length >
      MAX_TENDERS
  ) {
    fail(
      "EDGE_FINANCIAL_TENDERS_INVALID",
      "Financial settlement tenders are invalid"
    );
  }

  const tenders =
    value.tenders.map(
      (tender, index) => {
        if (
          !tender ||
          typeof tender !==
            "object" ||
          Array.isArray(
            tender
          )
        ) {
          fail(
            "EDGE_FINANCIAL_TENDER_INVALID",
            `tenders[${index}] is invalid`
          );
        }

        const refPaymentUuid =
          optionalUuid(
            tender.ref_payment_uuid,
            `tenders[${index}].ref_payment_uuid`
          );

        if (
          refPaymentUuid !==
          null
        ) {
          fail(
            "EDGE_FINANCIAL_SETTLEMENT_REFUND_TENDER_INVALID",
            "Settlement-recorded events cannot contain refund tenders"
          );
        }

        const status =
          requireText(
            tender.status ||
              "completed",
            `tenders[${index}].status`,
            {
              max:
                40,
            }
          )
            .toLowerCase();

        if (
          status !==
          "completed"
        ) {
          fail(
            "EDGE_FINANCIAL_SETTLEMENT_TENDER_STATUS_INVALID",
            "Settlement-recorded tenders must initially be completed"
          );
        }

        return {
          payment_uuid:
            requireUuid(
              tender.payment_uuid,
              `tenders[${index}].payment_uuid`
            ),

          amount:
            money(
              tender.amount,
              `tenders[${index}].amount`,
              {
                min:
                  0.01,
              }
            ),

          method:
            requireText(
              tender.method,
              `tenders[${index}].method`,
              {
                max:
                  80,
              }
            ),

          discount_value:
            money(
              tender.discount_value ||
                0,
              `tenders[${index}].discount_value`
            ),

          discount_type:
            requireText(
              tender.discount_type ||
                "none",
              `tenders[${index}].discount_type`,
              {
                max:
                  40,
              }
            ),

          service_rate:
            money(
              tender.service_rate ||
                0,
              `tenders[${index}].service_rate`
            ),

          batch_id:
            optionalUuid(
              tender.batch_id,
              `tenders[${index}].batch_id`
            ),

          terminal_ref:
            optionalText(
              tender.terminal_ref,
              `tenders[${index}].terminal_ref`,
              {
                max:
                  255,
              }
            ),

          source:
            requireText(
              tender.source ||
                "pos",
              `tenders[${index}].source`,
              {
                max:
                  40,
              }
            ),

          status,

          ref_payment_uuid:
            null,

          order_refs:
            normalizeOrderRefs(
              tender.order_refs,
              `tenders[${index}].order_refs`
            ),

          created_at:
            timestamp(
              tender.created_at,
              `tenders[${index}].created_at`
            ),
        };
      }
    );

  const tenderUuids =
    tenders.map(
      (tender) =>
        tender.payment_uuid
    );

  if (
    new Set(
      tenderUuids
    ).size !==
    tenderUuids.length
  ) {
    fail(
      "EDGE_FINANCIAL_TENDER_UUID_DUPLICATE",
      "Financial settlement contains duplicate tender UUIDs"
    );
  }

  const tenderTotal =
    Number(
      tenders.reduce(
        (sum, tender) =>
          sum +
          tender.amount,
        0
      ).toFixed(
        2
      )
    );

  if (
    Math.abs(
      tenderTotal -
      normalizedSettlement
        .final_amount
    ) >
    0.01
  ) {
    fail(
      "EDGE_FINANCIAL_TENDER_TOTAL_MISMATCH",
      "Tender total does not match settlement final amount",
      {
        tender_total:
          tenderTotal,

        settlement_final_amount:
          normalizedSettlement
            .final_amount,
      }
    );
  }

  const payload = {
    schema_version:
      FINANCIAL_SETTLEMENT_SCHEMA_VERSION,

    restaurant_id:
      rid,

    settlement:
      normalizedSettlement,

    tenders,
  };

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
      "EDGE_FINANCIAL_EVENT_TOO_LARGE",
      "Financial settlement event exceeds 768 KiB"
    );
  }

  return payload;
}


function isFinancialEdgeProducerRuntime() {
  return (
    getRuntimeRole({
      required:
        false,
    }) ===
    RUNTIME_ROLES.EDGE
  );
}


function portableizePricingSnapshot(
  value,
  orderRefByLocalId,
  path = []
) {
  if (
    Array.isArray(
      value
    )
  ) {
    return value.map(
      (one) =>
        portableizePricingSnapshot(
          one,
          orderRefByLocalId,
          path
        )
    );
  }

  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return value;
  }

  const out =
    {};

  for (
    const [
      key,
      child,
    ] of Object.entries(
      value
    )
  ) {
    /*
     * Legacy pricing snapshots use local POS BIGINT ids.
     *
     * Replace them with the same portable identity used by
     * the financial event itself.
     */
    if (
      key ===
      "pos_order_id"
    ) {
      const localId =
        Number(
          child
        );

      const ref =
        orderRefByLocalId.get(
          localId
        );

      if (
        !ref
      ) {
        fail(
          "EDGE_FINANCIAL_PRICING_ORDER_REF_MISSING",
          "Pricing snapshot references a POS row without portable identity",
          {
            local_pos_order_id:
              localId,
          }
        );
      }

      out.order_ref =
        ref;

      continue;
    }

    /*
     * voucher.id is a local database BIGINT.
     * voucher_code remains in the immutable settlement and
     * the remaining voucher attributes remain useful pricing
     * evidence, so strip only the non-portable numeric id.
     */
    if (
      key ===
        "id" &&
      path[
        path.length - 1
      ] ===
        "voucher"
    ) {
      continue;
    }

    out[key] =
      portableizePricingSnapshot(
        child,
        orderRefByLocalId,
        [
          ...path,
          key,
        ]
      );
  }

  return out;
}


async function loadFinancialSettlementSnapshotTx(
  tx,
  {
    restaurantId,
    settlementId,
  }
) {
  requireTx(
    tx
  );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const sid =
    requireUuid(
      settlementId,
      "settlementId"
    );

  const settlement =
    await tx.qGet(
      `
      SELECT
        id,
        restaurant_id,
        table_number,
        batch_id,
        invoice_number,

        gross_amount,
        pricing_discount_amount,
        happy_hour_discount_amount,
        deal_adjusted_amount,

        voucher_code,
        voucher_discount_amount,

        manual_discount_amount,
        service_charge_amount,
        final_amount,

        applied_rule_ids,
        pos_order_ids,
        pricing_snapshot,

        source,
        created_at

      FROM
        public.payment_settlements

      WHERE
        restaurant_id = $1
        AND id = $2::uuid

      LIMIT 1
      `,
      [
        rid,
        sid,
      ]
    );

  if (
    !settlement
  ) {
    fail(
      "EDGE_FINANCIAL_SETTLEMENT_NOT_FOUND",
      "Payment settlement was not found"
    );
  }

  const tenderRows =
    await tx.qAll(
      `
      SELECT
        payment_uuid,
        amount,
        method,

        discount_value,
        discount_type,
        service_rate,

        batch_id,
        terminal_ref,

        pos_order_ids,

        source,
        status,

        ref_payment_uuid,
        created_at

      FROM
        public.payments

      WHERE
        restaurant_id = $1
        AND settlement_id = $2::uuid

      ORDER BY
        created_at ASC,
        id ASC
      `,
      [
        rid,
        sid,
      ]
    );

  const settlementLocalIds =
    cleanLocalOrderIds(
      settlement.pos_order_ids,
      "settlement.pos_order_ids"
    );

  const tenderLocalIds =
    tenderRows.map(
      (row, index) =>
        cleanLocalOrderIds(
          row.pos_order_ids,
          `tenders[${index}].pos_order_ids`
        )
    );

  const allLocalIds =
    Array.from(
      new Set([
        ...settlementLocalIds,
        ...tenderLocalIds.flat(),
      ])
    );

  const identityRows =
    allLocalIds.length
      ? await tx.qAll(
          `
          SELECT
            id,
            batch_id,
            edge_submission_id,
            edge_row_ordinal

          FROM
            public.pos_orders

          WHERE
            restaurant_id = $1
            AND id =
              ANY(
                $2::bigint[]
              )
          `,
          [
            rid,
            allLocalIds,
          ]
        )
      : [];

  if (
    identityRows.length !==
    allLocalIds.length
  ) {
    const found =
      new Set(
        identityRows.map(
          (row) =>
            Number(
              row.id
            )
        )
      );

    fail(
      "EDGE_FINANCIAL_ORDER_NOT_FOUND",
      "Financial settlement references a POS row that does not exist",
      {
        missing_local_pos_order_ids:
          allLocalIds.filter(
            (id) =>
              !found.has(
                id
              )
          ),
      }
    );
  }

  const orderRefByLocalId =
    new Map();

  for (
    const row of
    identityRows
  ) {
    const localId =
      Number(
        row.id
      );

    if (
      !UUID_RE.test(
        String(
          row.edge_submission_id ||
            ""
        )
      ) ||
      !Number.isSafeInteger(
        Number(
          row.edge_row_ordinal
        )
      ) ||
      Number(
        row.edge_row_ordinal
      ) <= 0 ||
      !UUID_RE.test(
        String(
          row.batch_id ||
            ""
        )
      )
    ) {
      fail(
        "EDGE_FINANCIAL_ORDER_IDENTITY_REQUIRED",
        "A paid POS row is missing portable Edge identity",
        {
          local_pos_order_id:
            localId,
        }
      );
    }

    orderRefByLocalId.set(
      localId,
      normalizeOrderRef(
        {
          edge_submission_id:
            row.edge_submission_id,

          edge_row_ordinal:
            row.edge_row_ordinal,

          batch_id:
            row.batch_id,
        },
        `pos_orders[${localId}]`
      )
    );
  }

  const orderRefsForIds =
    (
      ids
    ) =>
      ids.map(
        (id) => {
          const ref =
            orderRefByLocalId.get(
              Number(
                id
              )
            );

          if (
            !ref
          ) {
            fail(
              "EDGE_FINANCIAL_ORDER_REF_MISSING",
              "A financial POS order reference could not be made portable",
              {
                local_pos_order_id:
                  Number(
                    id
                  ),
              }
            );
          }

          return ref;
        }
      );

  const pricingSnapshot =
    portableizePricingSnapshot(
      parseJsonObject(
        settlement.pricing_snapshot,
        "settlement.pricing_snapshot"
      ),
      orderRefByLocalId
    );

  const payload =
    validateFinancialSettlementPayload({
      schema_version:
        FINANCIAL_SETTLEMENT_SCHEMA_VERSION,

      restaurant_id:
        rid,

      settlement: {
        id:
          sid,

        table_number:
          settlement.table_number,

        batch_id:
          settlement.batch_id,

        invoice_number:
          settlement.invoice_number,

        gross_amount:
          settlement.gross_amount,

        pricing_discount_amount:
          settlement
            .pricing_discount_amount,

        happy_hour_discount_amount:
          settlement
            .happy_hour_discount_amount,

        deal_adjusted_amount:
          settlement
            .deal_adjusted_amount,

        voucher_code:
          settlement.voucher_code,

        voucher_discount_amount:
          settlement
            .voucher_discount_amount,

        manual_discount_amount:
          settlement
            .manual_discount_amount,

        service_charge_amount:
          settlement
            .service_charge_amount,

        final_amount:
          settlement.final_amount,

        applied_rule_ids:
          parseJsonArray(
            settlement.applied_rule_ids,
            "settlement.applied_rule_ids"
          ),

        order_refs:
          orderRefsForIds(
            settlementLocalIds
          ),

        pricing_snapshot:
          pricingSnapshot,

        source:
          settlement.source ||
          "pos",

        created_at:
          settlement.created_at,
      },

      tenders:
        tenderRows.map(
          (row, index) => ({
            payment_uuid:
              row.payment_uuid,

            amount:
              row.amount,

            method:
              row.method,

            discount_value:
              row.discount_value ||
              0,

            discount_type:
              row.discount_type ||
              "none",

            service_rate:
              row.service_rate ||
              0,

            batch_id:
              row.batch_id,

            terminal_ref:
              row.terminal_ref,

            source:
              row.source ||
              "pos",

            status:
              row.status ||
              "completed",

            ref_payment_uuid:
              row.ref_payment_uuid,

            order_refs:
              orderRefsForIds(
                tenderLocalIds[
                  index
                ]
              ),

            created_at:
              row.created_at,
          })
        ),
    });

  return payload;
}



/*
 * =========================================================
 * CLOUD FINANCIAL SETTLEMENT MATERIALIZATION
 * =========================================================
 *
 * Immutable scope only:
 *
 *   payment_settlements
 *   payments
 *
 * This phase intentionally does NOT mutate:
 *
 *   pos_orders.paid
 *   pos_orders.amount_paid
 *   pos_orders.remaining_price
 *   cash-up ownership
 *
 * Edge-local BIGSERIAL/FK identities are never Cloud
 * authority.
 */


function financialOrderRefKey(
  ref
) {
  return [
    ref.edge_submission_id,
    ref.edge_row_ordinal,
    ref.batch_id,
  ].join(":");
}


function validateFinancialSettlementRecordedEvent(
  event,
  {
    restaurantId,
    sourceInstallationId,
  }
) {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event)
  ) {
    fail(
      "EDGE_FINANCIAL_EVENT_INVALID",
      "Financial settlement event must be an object"
    );
  }

  const bytes =
    Buffer.byteLength(
      JSON.stringify(
        event
      ),
      "utf8"
    );

  /*
   * Payload itself is capped at 768 KiB. Permit a small
   * envelope allowance for event metadata.
   */
  if (
    bytes >
    MAX_EVENT_BYTES +
      (16 * 1024)
  ) {
    fail(
      "EDGE_FINANCIAL_EVENT_TOO_LARGE",
      "Financial settlement event is too large"
    );
  }

  const rid =
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
      event.event_id,
      "event.event_id"
    );

  if (
    String(
      event.event_type ||
      ""
    ) !==
    FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE
  ) {
    fail(
      "EDGE_FINANCIAL_EVENT_TYPE_INVALID",
      "Unexpected financial settlement event type"
    );
  }

  if (
    String(
      event.entity_type ||
      ""
    ) !==
    "payment_settlement"
  ) {
    fail(
      "EDGE_FINANCIAL_ENTITY_TYPE_INVALID",
      "Financial settlement event entity_type must be payment_settlement"
    );
  }

  const eventRid =
    requireRestaurantId(
      event.restaurant_id
    );

  if (
    eventRid !==
    rid
  ) {
    fail(
      "EDGE_FINANCIAL_TENANT_MISMATCH",
      "Financial settlement event restaurant does not match authenticated Edge"
    );
  }

  const payload =
    validateFinancialSettlementPayload(
      event.payload
    );

  if (
    Number(
      payload.restaurant_id
    ) !==
    rid
  ) {
    fail(
      "EDGE_FINANCIAL_TENANT_MISMATCH",
      "Financial settlement payload crossed restaurant boundary"
    );
  }

  const entityId =
    requireUuid(
      event.entity_id,
      "event.entity_id"
    );

  if (
    entityId !==
    payload.settlement.id
  ) {
    fail(
      "EDGE_FINANCIAL_SETTLEMENT_ID_MISMATCH",
      "Financial event entity_id does not match settlement UUID"
    );
  }

  const expectedIdempotencyKey =
    `${FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE}:${payload.settlement.id}`;

  if (
    String(
      event.idempotency_key ||
      ""
    ) !==
    expectedIdempotencyKey
  ) {
    fail(
      "EDGE_FINANCIAL_IDEMPOTENCY_MISMATCH",
      "Financial event idempotency key does not match settlement UUID"
    );
  }

  return {
    event_id:
      eventId,

    restaurant_id:
      rid,

    source_installation_id:
      installationId,

    event_type:
      FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,

    entity_type:
      "payment_settlement",

    entity_id:
      payload.settlement.id,

    idempotency_key:
      expectedIdempotencyKey,

    payload,
  };
}


function collectFinancialOrderRefs(
  payload
) {
  const refs =
    new Map();

  const add =
    (
      ref,
      field
    ) => {
      const normalized =
        normalizeOrderRef(
          ref,
          field
        );

      const key =
        financialOrderRefKey(
          normalized
        );

      refs.set(
        key,
        normalized
      );
    };

  payload
    .settlement
    .order_refs
    .forEach(
      (ref, index) =>
        add(
          ref,
          `settlement.order_refs[${index}]`
        )
    );

  payload
    .tenders
    .forEach(
      (tender, tenderIndex) => {
        tender
          .order_refs
          .forEach(
            (ref, refIndex) =>
              add(
                ref,
                `tenders[${tenderIndex}].order_refs[${refIndex}]`
              )
          );
      }
    );

  return Array.from(
    refs.values()
  );
}


async function resolveCloudFinancialOrderRefsTx(
  tx,
  restaurantId,
  refs
) {
  requireTx(
    tx
  );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const mapping =
    new Map();

  for (
    const rawRef of refs
  ) {
    const ref =
      normalizeOrderRef(
        rawRef
      );

    const rows =
      await tx.qAll(
        `
        SELECT
          id,
          restaurant_id,
          batch_id,
          edge_submission_id,
          edge_row_ordinal
        FROM
          public.pos_orders
        WHERE
          restaurant_id = $1
          AND edge_submission_id =
            $2::uuid
          AND edge_row_ordinal =
            $3
        ORDER BY
          id ASC
        FOR UPDATE
        `,
        [
          rid,
          ref.edge_submission_id,
          ref.edge_row_ordinal,
        ]
      );

    if (
      rows.length ===
      0
    ) {
      fail(
        "EDGE_FINANCIAL_ORDER_DEPENDENCY_MISSING",
        "Financial settlement references a POS row that is not materialized in Cloud yet",
        {
          edge_submission_id:
            ref.edge_submission_id,

          edge_row_ordinal:
            ref.edge_row_ordinal,

          batch_id:
            ref.batch_id,
        }
      );
    }

    if (
      rows.length !==
      1
    ) {
      fail(
        "EDGE_FINANCIAL_ORDER_IDENTITY_AMBIGUOUS",
        "Portable POS identity resolves to multiple Cloud rows",
        {
          edge_submission_id:
            ref.edge_submission_id,

          edge_row_ordinal:
            ref.edge_row_ordinal,
        }
      );
    }

    const row =
      rows[0];

    if (
      String(
        row.batch_id ||
        ""
      ).toLowerCase() !==
      ref.batch_id
    ) {
      fail(
        "EDGE_FINANCIAL_ORDER_BATCH_MISMATCH",
        "Portable financial POS reference resolved to the wrong batch",
        {
          edge_submission_id:
            ref.edge_submission_id,

          edge_row_ordinal:
            ref.edge_row_ordinal,

          expected_batch_id:
            ref.batch_id,

          cloud_batch_id:
            row.batch_id ||
            null,
        }
      );
    }

    const cloudId =
      Number(
        row.id
      );

    if (
      !Number.isSafeInteger(
        cloudId
      ) ||
      cloudId <=
        0
    ) {
      fail(
        "EDGE_FINANCIAL_CLOUD_ORDER_ID_INVALID",
        "Resolved Cloud POS row has an invalid local identity"
      );
    }

    mapping.set(
      financialOrderRefKey(
        ref
      ),
      cloudId
    );
  }

  return mapping;
}


function cloudOrderIdsForRefs(
  refs,
  mapping
) {
  return refs.map(
    (rawRef) => {
      const ref =
        normalizeOrderRef(
          rawRef
        );

      const id =
        mapping.get(
          financialOrderRefKey(
            ref
          )
        );

      if (
        !Number.isSafeInteger(
          id
        ) ||
        id <=
          0
      ) {
        fail(
          "EDGE_FINANCIAL_CLOUD_ORDER_MAPPING_MISSING",
          "Financial POS reference has no Cloud-local mapping"
        );
      }

      return id;
    }
  );
}


function localizeFinancialPricingSnapshot(
  value,
  mapping,
  path = []
) {
  if (
    Array.isArray(
      value
    )
  ) {
    return value.map(
      (one, index) =>
        localizeFinancialPricingSnapshot(
          one,
          mapping,
          [
            ...path,
            index,
          ]
        )
    );
  }

  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return value;
  }

  const out =
    {};

  for (
    const [
      key,
      child,
    ] of Object.entries(
      value
    )
  ) {
    /*
     * Edge converted local pricing_snapshot.pos_order_id
     * fields into portable order_ref objects.
     *
     * Cloud converts only that portable marker back into
     * its own local POS BIGINT identity for existing receipt
     * and settlement readers.
     */
    if (
      key ===
      "order_ref"
    ) {
      const ref =
        normalizeOrderRef(
          child,
          [
            "pricing_snapshot",
            ...path,
            key,
          ].join(".")
        );

      const cloudId =
        mapping.get(
          financialOrderRefKey(
            ref
          )
        );

      if (
        !Number.isSafeInteger(
          cloudId
        ) ||
        cloudId <=
          0
      ) {
        fail(
          "EDGE_FINANCIAL_PRICING_CLOUD_ORDER_REF_MISSING",
          "Pricing snapshot order_ref has no Cloud-local POS mapping"
        );
      }

      out.pos_order_id =
        cloudId;

      continue;
    }

    out[key] =
      localizeFinancialPricingSnapshot(
        child,
        mapping,
        [
          ...path,
          key,
        ]
      );
  }

  return out;
}


async function applyFinancialSettlementRecordedCloud({
  event,
  restaurantId,
  sourceInstallationId,
}) {
  assertCloudRuntime();

  const normalized =
    validateFinancialSettlementRecordedEvent(
      event,
      {
        restaurantId,
        sourceInstallationId,
      }
    );

  const payload =
    normalized.payload;

  const settlement =
    payload.settlement;

  return withTx(
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
          `maks:cloud-financial:${normalized.restaurant_id}:${settlement.id}`,
        ]
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
            normalized.event_id,
          ]
        );

      if (
        !inbox
      ) {
        fail(
          "EDGE_FINANCIAL_INBOX_REQUIRED",
          "Financial event must be durably received before Cloud apply"
        );
      }

      if (
        Number(
          inbox.restaurant_id
        ) !==
          normalized.restaurant_id ||

        String(
          inbox.source ||
          ""
        ) !==
          "edge" ||

        String(
          inbox.source_installation_id ||
          ""
        ) !==
          normalized.source_installation_id ||

        String(
          inbox.event_type ||
          ""
        ) !==
          FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE ||

        String(
          inbox.entity_type ||
          ""
        ) !==
          "payment_settlement" ||

        String(
          inbox.entity_id ||
          ""
        ).toLowerCase() !==
          settlement.id
      ) {
        fail(
          "EDGE_FINANCIAL_INBOX_IDENTITY_MISMATCH",
          "Durable inbox identity does not match financial settlement event"
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

          settlement_id:
            settlement.id,

          tenders:
            0,

          order_refs:
            0,
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
          "EDGE_FINANCIAL_INBOX_STATE_INVALID",
          "Financial inbox event is not in an applicable state"
        );
      }

      const workerId =
        `cloud-financial-inline:${normalized.source_installation_id}`;

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
            normalized.event_id,
            normalized.restaurant_id,
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
          "EDGE_FINANCIAL_INBOX_CLAIM_FAILED",
          "Financial inbox event could not enter applying state"
        );
      }

      const refs =
        collectFinancialOrderRefs(
          payload
        );

      const orderMapping =
        await resolveCloudFinancialOrderRefsTx(
          tx,
          normalized.restaurant_id,
          refs
        );

      const settlementOrderIds =
        cloudOrderIdsForRefs(
          settlement.order_refs,
          orderMapping
        );

      const cloudPricingSnapshot =
        localizeFinancialPricingSnapshot(
          settlement.pricing_snapshot,
          orderMapping
        );

      /*
       * A replay of the SAME event would have returned above
       * from inbox.status='applied'.
       *
       * Therefore a pre-existing settlement UUID here is a
       * conflicting identity, not a legitimate replay.
       */
      const existingSettlement =
        await tx.qGet(
          `
          SELECT
            id,
            restaurant_id
          FROM
            public.payment_settlements
          WHERE
            id =
              $1::uuid
          FOR UPDATE
          `,
          [
            settlement.id,
          ]
        );

      if (
        existingSettlement
      ) {
        fail(
          "EDGE_FINANCIAL_SETTLEMENT_UUID_CONFLICT",
          "Settlement UUID already exists in Cloud outside this applied event",
          {
            settlement_id:
              settlement.id,

            existing_restaurant_id:
              Number(
                existingSettlement
                  .restaurant_id
              ),
          }
        );
      }

      const tenderUuids =
        payload.tenders.map(
          (tender) =>
            tender.payment_uuid
        );

      if (
        tenderUuids.length
      ) {
        const existingTenders =
          await tx.qAll(
            `
            SELECT
              id,
              restaurant_id,
              settlement_id,
              payment_uuid
            FROM
              public.payments
            WHERE
              payment_uuid =
                ANY(
                  $1::uuid[]
                )
            ORDER BY
              id ASC
            FOR UPDATE
            `,
            [
              tenderUuids,
            ]
          );

        if (
          existingTenders.length
        ) {
          fail(
            "EDGE_FINANCIAL_PAYMENT_UUID_CONFLICT",
            "Tender payment UUID already exists in Cloud outside this applied event",
            {
              payment_uuids:
                existingTenders.map(
                  (row) =>
                    row.payment_uuid
                ),
            }
          );
        }
      }

      await tx.qRun(
        `
        INSERT INTO
          public.payment_settlements
        (
          id,
          restaurant_id,
          table_number,
          batch_id,
          invoice_number,

          gross_amount,
          pricing_discount_amount,
          happy_hour_discount_amount,
          deal_adjusted_amount,

          voucher_id,
          voucher_code,
          voucher_discount_amount,

          manual_discount_amount,
          service_charge_amount,
          final_amount,

          applied_rule_ids,
          pos_order_ids,
          pricing_snapshot,

          source,
          created_by_user_id,
          created_at
        )
        VALUES
        (
          $1::uuid,
          $2,
          $3,
          $4::uuid,
          $5,

          $6,
          $7,
          $8,
          $9,

          NULL,
          $10,
          $11,

          $12,
          $13,
          $14,

          $15::jsonb,
          $16::jsonb,
          $17::jsonb,

          $18,
          NULL,
          COALESCE(
            $19::timestamptz,
            NOW()
          )
        )
        `,
        [
          settlement.id,
          normalized.restaurant_id,
          settlement.table_number,
          settlement.batch_id,
          settlement.invoice_number,

          settlement.gross_amount,
          settlement.pricing_discount_amount,
          settlement.happy_hour_discount_amount,
          settlement.deal_adjusted_amount,

          settlement.voucher_code,
          settlement.voucher_discount_amount,

          settlement.manual_discount_amount,
          settlement.service_charge_amount,
          settlement.final_amount,

          JSON.stringify(
            settlement.applied_rule_ids ||
            []
          ),

          JSON.stringify(
            settlementOrderIds
          ),

          JSON.stringify(
            cloudPricingSnapshot ||
            {}
          ),

          settlement.source ||
            "pos",

          settlement.created_at,
        ]
      );

      for (
        const tender of
          payload.tenders
      ) {
        const tenderOrderIds =
          cloudOrderIdsForRefs(
            tender.order_refs,
            orderMapping
          );

        await tx.qRun(
          `
          INSERT INTO
            public.payments
          (
            table_number,
            amount,
            method,
            discount_value,
            discount_type,
            service_rate,
            created_at,

            restaurant_id,
            batch_id,
            staff_user_id,
            terminal_ref,
            pos_order_ids,
            source,
            status,

            void_reason,
            voided_at,
            voided_by_user_id,
            refund_of_payment_id,
            cashup_session_id,
            ref_payment_id,

            settlement_id,
            payment_uuid,
            ref_payment_uuid
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            COALESCE(
              $7::timestamptz,
              NOW()
            ),

            $8,
            $9::uuid,
            NULL,
            $10,
            $11::jsonb,
            $12,
            $13,

            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,

            $14::uuid,
            $15::uuid,
            NULL
          )
          `,
          [
            settlement.table_number,
            tender.amount,
            tender.method,
            tender.discount_value,
            tender.discount_type,
            tender.service_rate,
            tender.created_at,

            normalized.restaurant_id,
            tender.batch_id,
            tender.terminal_ref,

            JSON.stringify(
              tenderOrderIds
            ),

            tender.source ||
              "pos",

            tender.status ||
              "completed",

            settlement.id,
            tender.payment_uuid,
          ]
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
            normalized.event_id,
            normalized.restaurant_id,
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
          "EDGE_FINANCIAL_INBOX_FINALIZE_FAILED",
          "Financial inbox event could not enter applied state"
        );
      }

      return {
        duplicate:
          false,

        settlement_id:
          settlement.id,

        tenders:
          payload.tenders.length,

        order_refs:
          refs.length,
      };
    }
  );
}


async function emitFinancialSettlementRecordedTx(
  tx,
  {
    restaurantId,
    settlementId,
  }
) {
  requireTx(
    tx
  );

  /*
   * Missing role and Cloud role do NOT become Edge producers.
   *
   * Invalid runtime roles still fail closed inside
   * getRuntimeRole().
   */
  if (
    !isFinancialEdgeProducerRuntime()
  ) {
    return null;
  }

  const payload =
    await loadFinancialSettlementSnapshotTx(
      tx,
      {
        restaurantId,
        settlementId,
      }
    );

  const settlementIdSafe =
    payload
      .settlement
      .id;

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          payload
            .restaurant_id,

        eventType:
          FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,

        entityType:
          "payment_settlement",

        entityId:
          settlementIdSafe,

        idempotencyKey:
          `${FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE}:${settlementIdSafe}`,

        payload,
      }
    );

  return {
    event,
    payload,
  };
}


module.exports = {
  FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,
  FINANCIAL_SETTLEMENT_SCHEMA_VERSION,
  FinancialOperationalSyncError,
  isFinancialEdgeProducerRuntime,
  validateFinancialSettlementPayload,
  validateFinancialSettlementRecordedEvent,
  applyFinancialSettlementRecordedCloud,
  loadFinancialSettlementSnapshotTx,
  emitFinancialSettlementRecordedTx,
};
