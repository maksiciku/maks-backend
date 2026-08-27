"use strict";

const {
  enqueueEdgeEventTx,
} = require(
  "../syncStore"
);

const {
  nextProducedRevisionTx,
  applyDomainRevisionTx,
} = require(
  "../domainRevisionStore"
);

const {
  assertCloudRuntime,
} = require(
  "../../utils/runtimeRole"
);


const PROMOTIONS_DOMAIN =
  "promotions";

const PROMOTIONS_EVENT_TYPE =
  "promotions.replaced.v1";

const PROMOTIONS_SCHEMA_VERSION =
  1;

const MAX_PROMOTIONS =
  200;

const MAX_PAYLOAD_BYTES =
  512 * 1024;

const DAY_KEYS =
  new Set([
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
    "sun",
  ]);


class PromotionsContractError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "PromotionsContractError";

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


function requireTx(
  tx
) {
  if (
    !tx ||
    typeof tx.qGet !==
      "function" ||
    typeof tx.qAll !==
      "function" ||
    typeof tx.qRun !==
      "function"
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_TX_REQUIRED",
      "Promotions sync requires a PostgreSQL transaction"
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
    !Number.isSafeInteger(rid) ||
    rid <= 0
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_RESTAURANT_INVALID",
      "Promotions sync restaurantId must be a positive integer"
    );
  }

  return rid;
}


function plainObject(
  value,
  label
) {
  if (
    !value ||
    typeof value !==
      "object" ||
    Array.isArray(value)
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} must be an object`
    );
  }

  return value;
}


function assertOnlyKeys(
  value,
  allowed,
  label
) {
  const allowedSet =
    new Set(allowed);

  const unknown =
    Object.keys(value).filter(
      (key) =>
        !allowedSet.has(key)
    );

  if (
    unknown.length
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} contains unsupported fields`,
      {
        fields:
          unknown.slice(0, 20),
      }
    );
  }
}


function positiveInteger(
  value,
  label
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} must be a positive integer`
    );
  }

  return number;
}


function optionalPositiveInteger(
  value,
  label
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  return positiveInteger(
    value,
    label
  );
}


function boundedInteger(
  value,
  label
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number <
      -1_000_000_000 ||
    number >
      1_000_000_000
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} must be a safe bounded integer`
    );
  }

  return number;
}


function strictBoolean(
  value,
  label
) {
  if (
    typeof value !==
      "boolean"
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} must be a boolean`
    );
  }

  return value;
}


function nullableText(
  value,
  label,
  max
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text =
    String(value);

  if (
    text.length >
      max
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} is too long`
    );
  }

  return text;
}


function enumValue(
  value,
  label,
  allowed
) {
  const text =
    String(
      value ?? ""
    )
      .trim()
      .toLowerCase();

  if (
    !allowed.includes(
      text
    )
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} is invalid`
    );
  }

  return text;
}


function temporalText(
  value,
  label,
  {
    nullable = true,
    max = 80,
  } = {}
) {
  if (
    value === null ||
    value === undefined
  ) {
    if (nullable) {
      return null;
    }

    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} is required`
    );
  }

  const text =
    value instanceof Date
      ? value.toISOString()
      : String(value);

  if (
    !text ||
    text.length >
      max
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} is invalid`
    );
  }

  return text;
}


function normalizeDays(
  value,
  label
) {
  let parsed =
    value;

  if (
    typeof parsed ===
      "string"
  ) {
    try {
      parsed =
        JSON.parse(parsed);
    } catch {
      throw new PromotionsContractError(
        "PROMOTIONS_SYNC_PAYLOAD_INVALID",
        `${label} must be a JSON array`
      );
    }
  }

  if (
    !Array.isArray(parsed)
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} must be an array`
    );
  }

  const days =
    parsed.map(
      (day) =>
        String(day)
          .trim()
          .toLowerCase()
    );

  if (
    days.some(
      (day) =>
        !DAY_KEYS.has(day)
    )
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      `${label} contains an invalid day`
    );
  }

  return [
    ...new Set(days),
  ];
}


const PROMOTION_KEYS =
  Object.freeze([
    "id",
    "title",
    "description",
    "image_url",
    "display_context",
    "order_type",
    "linked_item_id",
    "linked_item_type",
    "active",
    "created_at",
    "updated_at",
    "show_on_qr",
    "show_on_kiosk",
    "show_on_eat_in",
    "show_on_takeaway",
    "show_for_dine_in",
    "show_for_takeaway",
    "button_text",
    "action_type",
    "action_target",
    "start_at",
    "end_at",
    "sort_order",
    "promotion_type",
    "button_action",
    "linked_category_id",
    "start_date",
    "end_date",
    "start_time",
    "end_time",
    "meal_period",
    "days_of_week",
    "priority",
    "event_date",
    "event_time",
    "event_end_time",
  ]);


function normalizePromotion(
  value,
  index
) {
  const row =
    plainObject(
      value,
      `promotions[${index}]`
    );

  assertOnlyKeys(
    row,
    PROMOTION_KEYS,
    `promotions[${index}]`
  );

  return {
    id:
      positiveInteger(
        row.id,
        `promotions[${index}].id`
      ),

    title:
      nullableText(
        row.title,
        `promotions[${index}].title`,
        1000
      ),

    description:
      nullableText(
        row.description,
        `promotions[${index}].description`,
        20_000
      ),

    image_url:
      nullableText(
        row.image_url,
        `promotions[${index}].image_url`,
        4096
      ),

    display_context:
      enumValue(
        row.display_context,
        `promotions[${index}].display_context`,
        [
          "qr",
          "kiosk",
          "both",
        ]
      ),

    order_type:
      enumValue(
        row.order_type,
        `promotions[${index}].order_type`,
        [
          "dine-in",
          "takeaway",
          "both",
        ]
      ),

    linked_item_id:
      optionalPositiveInteger(
        row.linked_item_id,
        `promotions[${index}].linked_item_id`
      ),

    linked_item_type:
      nullableText(
        row.linked_item_type,
        `promotions[${index}].linked_item_type`,
        100
      ),

    active:
      strictBoolean(
        row.active,
        `promotions[${index}].active`
      ),

    created_at:
      temporalText(
        row.created_at,
        `promotions[${index}].created_at`,
        {
          nullable:
            false,
        }
      ),

    updated_at:
      temporalText(
        row.updated_at,
        `promotions[${index}].updated_at`,
        {
          nullable:
            false,
        }
      ),

    show_on_qr:
      strictBoolean(
        row.show_on_qr,
        `promotions[${index}].show_on_qr`
      ),

    show_on_kiosk:
      strictBoolean(
        row.show_on_kiosk,
        `promotions[${index}].show_on_kiosk`
      ),

    show_on_eat_in:
      strictBoolean(
        row.show_on_eat_in,
        `promotions[${index}].show_on_eat_in`
      ),

    show_on_takeaway:
      strictBoolean(
        row.show_on_takeaway,
        `promotions[${index}].show_on_takeaway`
      ),

    show_for_dine_in:
      strictBoolean(
        row.show_for_dine_in,
        `promotions[${index}].show_for_dine_in`
      ),

    show_for_takeaway:
      strictBoolean(
        row.show_for_takeaway,
        `promotions[${index}].show_for_takeaway`
      ),

    button_text:
      nullableText(
        row.button_text,
        `promotions[${index}].button_text`,
        500
      ),

    action_type:
      enumValue(
        row.action_type,
        `promotions[${index}].action_type`,
        [
          "none",
          "booking",
          "category",
          "item",
          "url",
          "menu",
        ]
      ),

    action_target:
      nullableText(
        row.action_target,
        `promotions[${index}].action_target`,
        4096
      ),

    start_at:
      temporalText(
        row.start_at,
        `promotions[${index}].start_at`
      ),

    end_at:
      temporalText(
        row.end_at,
        `promotions[${index}].end_at`
      ),

    sort_order:
      boundedInteger(
        row.sort_order,
        `promotions[${index}].sort_order`
      ),

    promotion_type:
      nullableText(
        row.promotion_type,
        `promotions[${index}].promotion_type`,
        100
      ),

    button_action:
      nullableText(
        row.button_action,
        `promotions[${index}].button_action`,
        100
      ),

    linked_category_id:
      optionalPositiveInteger(
        row.linked_category_id,
        `promotions[${index}].linked_category_id`
      ),

    start_date:
      temporalText(
        row.start_date,
        `promotions[${index}].start_date`,
        {
          max:
            40,
        }
      ),

    end_date:
      temporalText(
        row.end_date,
        `promotions[${index}].end_date`,
        {
          max:
            40,
        }
      ),

    start_time:
      temporalText(
        row.start_time,
        `promotions[${index}].start_time`,
        {
          max:
            40,
        }
      ),

    end_time:
      temporalText(
        row.end_time,
        `promotions[${index}].end_time`,
        {
          max:
            40,
        }
      ),

    meal_period:
      nullableText(
        row.meal_period,
        `promotions[${index}].meal_period`,
        100
      ),

    days_of_week:
      normalizeDays(
        row.days_of_week,
        `promotions[${index}].days_of_week`
      ),

    priority:
      boundedInteger(
        row.priority,
        `promotions[${index}].priority`
      ),

    event_date:
      temporalText(
        row.event_date,
        `promotions[${index}].event_date`,
        {
          max:
            40,
        }
      ),

    event_time:
      temporalText(
        row.event_time,
        `promotions[${index}].event_time`,
        {
          max:
            40,
        }
      ),

    event_end_time:
      temporalText(
        row.event_end_time,
        `promotions[${index}].event_end_time`,
        {
          max:
            40,
        }
      ),
  };
}


function validatePromotionsPayload(
  value
) {
  const payload =
    plainObject(
      value,
      "promotion snapshot payload"
    );

  assertOnlyKeys(
    payload,
    [
      "schema_version",
      "revision",
      "promotions",
    ],
    "promotion snapshot payload"
  );

  const schemaVersion =
    positiveInteger(
      payload.schema_version,
      "schema_version"
    );

  if (
    schemaVersion !==
      PROMOTIONS_SCHEMA_VERSION
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_SCHEMA_UNSUPPORTED",
      `Unsupported promotions schema version ${schemaVersion}`
    );
  }

  const revision =
    positiveInteger(
      payload.revision,
      "revision"
    );

  if (
    !Array.isArray(
      payload.promotions
    )
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_INVALID",
      "promotions must be an array"
    );
  }

  if (
    payload.promotions.length >
      MAX_PROMOTIONS
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_TOO_LARGE",
      "promotion snapshot contains too many rows"
    );
  }

  const promotions =
    payload.promotions.map(
      normalizePromotion
    );

  const normalized = {
    schema_version:
      PROMOTIONS_SCHEMA_VERSION,

    revision,

    promotions,
  };

  const bytes =
    Buffer.byteLength(
      JSON.stringify(
        normalized
      ),
      "utf8"
    );

  if (
    bytes >
      MAX_PAYLOAD_BYTES
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_PAYLOAD_TOO_LARGE",
      "promotion snapshot payload is too large"
    );
  }

  return normalized;
}


async function loadPromotionsSnapshotTx(
  tx,
  restaurantId
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const rows =
    await tx.qAll(
      `
      SELECT
        id,
        title,
        description,
        image_url,
        display_context,
        order_type,
        linked_item_id,
        linked_item_type,
        active,
        created_at,
        updated_at,
        show_on_qr,
        show_on_kiosk,
        show_on_eat_in,
        show_on_takeaway,
        show_for_dine_in,
        show_for_takeaway,
        button_text,
        action_type,
        action_target,
        start_at,
        end_at,
        sort_order,
        promotion_type,
        button_action,
        linked_category_id,
        start_date,
        end_date,
        start_time,
        end_time,
        meal_period,
        days_of_week,
        priority,
        event_date,
        event_time,
        event_end_time
      FROM
        public.restaurant_promotions
      WHERE
        restaurant_id = $1
      ORDER BY
        priority DESC,
        sort_order ASC,
        id DESC
      `,
      [
        rid,
      ]
    );

  return rows || [];
}


async function emitPromotionsSnapshotTx(
  tx,
  {
    restaurantId,
  }
) {
  requireTx(tx);

  assertCloudRuntime();

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
          PROMOTIONS_DOMAIN,
      }
    );

  const rows =
    await loadPromotionsSnapshotTx(
      tx,
      rid
    );

  const payload =
    validatePromotionsPayload({
      schema_version:
        PROMOTIONS_SCHEMA_VERSION,

      revision,

      promotions:
        rows,
    });

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          rid,

        eventType:
          PROMOTIONS_EVENT_TYPE,

        entityType:
          "restaurant_promotions",

        entityId:
          String(rid),

        idempotencyKey:
          `${PROMOTIONS_EVENT_TYPE}:${revision}`,

        payload,
      }
    );

  return {
    revision,
    payload,
    event,
  };
}


async function replaceLocalPromotionsTx(
  tx,
  restaurantId,
  promotions
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  await tx.qRun(
    `
    DELETE FROM
      public.restaurant_promotions
    WHERE
      restaurant_id = $1
    `,
    [
      rid,
    ]
  );

  for (
    const promotion of
      promotions
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.restaurant_promotions
      (
        id,
        restaurant_id,
        title,
        description,
        image_url,
        display_context,
        order_type,
        linked_item_id,
        linked_item_type,
        active,
        created_at,
        updated_at,
        show_on_qr,
        show_on_kiosk,
        show_on_eat_in,
        show_on_takeaway,
        show_for_dine_in,
        show_for_takeaway,
        button_text,
        action_type,
        action_target,
        start_at,
        end_at,
        sort_order,
        promotion_type,
        button_action,
        linked_category_id,
        start_date,
        end_date,
        start_time,
        end_time,
        meal_period,
        days_of_week,
        priority,
        event_date,
        event_time,
        event_end_time
      )
      VALUES
      (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25,
        $26, $27, $28, $29, $30,
        $31, $32, $33::jsonb, $34,
        $35, $36, $37
      )
      `,
      [
        promotion.id,
        rid,
        promotion.title,
        promotion.description,
        promotion.image_url,
        promotion.display_context,
        promotion.order_type,
        promotion.linked_item_id,
        promotion.linked_item_type,
        promotion.active,
        promotion.created_at,
        promotion.updated_at,
        promotion.show_on_qr,
        promotion.show_on_kiosk,
        promotion.show_on_eat_in,
        promotion.show_on_takeaway,
        promotion.show_for_dine_in,
        promotion.show_for_takeaway,
        promotion.button_text,
        promotion.action_type,
        promotion.action_target,
        promotion.start_at,
        promotion.end_at,
        promotion.sort_order,
        promotion.promotion_type,
        promotion.button_action,
        promotion.linked_category_id,
        promotion.start_date,
        promotion.end_date,
        promotion.start_time,
        promotion.end_time,
        promotion.meal_period,
        JSON.stringify(
          promotion.days_of_week
        ),
        promotion.priority,
        promotion.event_date,
        promotion.event_time,
        promotion.event_end_time,
      ]
    );
  }

  return {
    replaced:
      promotions.length,
  };
}


async function applyPromotionsReplaced({
  tx,
  restaurantId,
  event,
  payload,
}) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  if (
    String(
      event?.event_type ||
      ""
    ).trim() !==
      PROMOTIONS_EVENT_TYPE
  ) {
    throw new PromotionsContractError(
      "PROMOTIONS_SYNC_EVENT_TYPE_INVALID",
      "Promotions handler received the wrong event type"
    );
  }

  const normalized =
    validatePromotionsPayload(
      payload
    );

  const result =
    await applyDomainRevisionTx(
      tx,
      {
        restaurantId:
          rid,

        domain:
          PROMOTIONS_DOMAIN,

        revision:
          normalized.revision,

        payloadHash:
          event?.payload_hash,

        execute:
          async () =>
            replaceLocalPromotionsTx(
              tx,
              rid,
              normalized.promotions
            ),
      }
    );

  return {
    ...result,

    promotionCount:
      normalized.promotions.length,
  };
}


module.exports = {
  PROMOTIONS_DOMAIN,
  PROMOTIONS_EVENT_TYPE,
  PROMOTIONS_SCHEMA_VERSION,
  PromotionsContractError,
  validatePromotionsPayload,
  loadPromotionsSnapshotTx,
  emitPromotionsSnapshotTx,
  applyPromotionsReplaced,
};
