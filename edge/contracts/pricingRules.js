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


const PRICING_RULES_DOMAIN =
  "pricing.rules";

const PRICING_RULES_EVENT_TYPE =
  "pricing.rules.replaced.v1";

const PRICING_RULES_SCHEMA_VERSION =
  1;

const MAX_RULES =
  200;

const MAX_PAYLOAD_BYTES =
  256 * 1024;

const MAX_JSON_FIELD_BYTES =
  32 * 1024;


class PricingRulesContractError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "PricingRulesContractError";

    this.code =
      code;

    if (details !== null) {
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
    throw new PricingRulesContractError(
      "PRICING_SYNC_TX_REQUIRED",
      "Pricing rules sync requires a PostgreSQL transaction"
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
    throw new PricingRulesContractError(
      "PRICING_SYNC_RESTAURANT_INVALID",
      "Pricing rules sync restaurantId must be a positive integer"
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
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
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

  if (unknown.length) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
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
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      `${label} must be a positive integer`
    );
  }

  return number;
}


function boundedInteger(
  value,
  label
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number < -1_000_000_000 ||
    number > 1_000_000_000
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      `${label} must be a safe bounded integer`
    );
  }

  return number;
}


function requiredText(
  value,
  label,
  max = 1000
) {
  const text =
    String(
      value ?? ""
    ).trim();

  if (
    !text ||
    text.length > max
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      `${label} is invalid`
    );
  }

  return text;
}


function requiredBoolean(
  value,
  label
) {
  if (
    typeof value !==
      "boolean"
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      `${label} must be boolean`
    );
  }

  return value;
}


function timestampOrNull(
  value,
  label,
  {
    required = false,
  } = {}
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    if (required) {
      throw new PricingRulesContractError(
        "PRICING_SYNC_PAYLOAD_INVALID",
        `${label} is required`
      );
    }

    return null;
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      `${label} must be a valid timestamp`
    );
  }

  return date.toISOString();
}


function jsonObject(
  value,
  label
) {
  const object =
    plainObject(
      value,
      label
    );

  let text =
    null;

  try {
    text =
      JSON.stringify(object);
  } catch {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      `${label} must be JSON serializable`
    );
  }

  if (
    Buffer.byteLength(
      text,
      "utf8"
    ) > MAX_JSON_FIELD_BYTES
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_TOO_LARGE",
      `${label} is too large`
    );
  }

  return JSON.parse(text);
}


function normalizeRule(
  raw,
  index
) {
  const rule =
    plainObject(
      raw,
      `rules[${index}]`
    );

  assertOnlyKeys(
    rule,
    [
      "id",
      "name",
      "rule_type",
      "active",
      "priority",
      "conditions",
      "actions",
      "starts_at",
      "ends_at",
      "created_at",
      "updated_at",
    ],
    `rules[${index}]`
  );

  const ruleType =
    requiredText(
      rule.rule_type,
      `rules[${index}].rule_type`,
      100
    )
      .toLowerCase();

  if (
    ![
      "fixed_bundle",
      "mix_match",
    ].includes(ruleType)
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      `rules[${index}].rule_type is unsupported`
    );
  }

  const startsAt =
    timestampOrNull(
      rule.starts_at,
      `rules[${index}].starts_at`
    );

  const endsAt =
    timestampOrNull(
      rule.ends_at,
      `rules[${index}].ends_at`
    );

  if (
    startsAt &&
    endsAt &&
    new Date(endsAt).getTime() <=
      new Date(startsAt).getTime()
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      `rules[${index}] has an invalid active range`
    );
  }

  return {
    id:
      positiveInteger(
        rule.id,
        `rules[${index}].id`
      ),

    name:
      requiredText(
        rule.name,
        `rules[${index}].name`
      ),

    rule_type:
      ruleType,

    active:
      requiredBoolean(
        rule.active,
        `rules[${index}].active`
      ),

    priority:
      boundedInteger(
        rule.priority,
        `rules[${index}].priority`
      ),

    conditions:
      jsonObject(
        rule.conditions,
        `rules[${index}].conditions`
      ),

    actions:
      jsonObject(
        rule.actions,
        `rules[${index}].actions`
      ),

    starts_at:
      startsAt,

    ends_at:
      endsAt,

    created_at:
      timestampOrNull(
        rule.created_at,
        `rules[${index}].created_at`,
        {
          required: true,
        }
      ),

    updated_at:
      timestampOrNull(
        rule.updated_at,
        `rules[${index}].updated_at`,
        {
          required: true,
        }
      ),
  };
}


function validatePricingRulesPayload(
  raw
) {
  const payload =
    plainObject(
      raw,
      "pricing rules payload"
    );

  assertOnlyKeys(
    payload,
    [
      "schema_version",
      "revision",
      "rules",
    ],
    "pricing rules payload"
  );

  if (
    Number(
      payload.schema_version
    ) !==
      PRICING_RULES_SCHEMA_VERSION
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_SCHEMA_UNSUPPORTED",
      "Unsupported pricing rules sync schema version"
    );
  }

  const revision =
    positiveInteger(
      payload.revision,
      "pricing rules revision"
    );

  if (
    !Array.isArray(
      payload.rules
    )
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_INVALID",
      "pricing rules payload rules must be an array"
    );
  }

  if (
    payload.rules.length >
      MAX_RULES
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_TOO_LARGE",
      `pricing rules snapshot exceeds ${MAX_RULES} rules`
    );
  }

  const rules =
    payload.rules.map(
      normalizeRule
    );

  const ids =
    new Set();

  for (
    const rule of rules
  ) {
    if (
      ids.has(rule.id)
    ) {
      throw new PricingRulesContractError(
        "PRICING_SYNC_PAYLOAD_INVALID",
        "pricing rules snapshot contains duplicate rule ids"
      );
    }

    ids.add(rule.id);
  }

  const normalized = {
    schema_version:
      PRICING_RULES_SCHEMA_VERSION,
    revision,
    rules,
  };

  const bytes =
    Buffer.byteLength(
      JSON.stringify(normalized),
      "utf8"
    );

  if (
    bytes >
      MAX_PAYLOAD_BYTES
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_PAYLOAD_TOO_LARGE",
      "pricing rules snapshot payload is too large"
    );
  }

  return normalized;
}


async function loadPricingRulesSnapshotTx(
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
        name,
        rule_type,
        active,
        priority,
        conditions,
        actions,
        starts_at,
        ends_at,
        created_at,
        updated_at
      FROM
        public.pricing_rules
      WHERE
        restaurant_id = $1
      ORDER BY
        priority DESC,
        id DESC
      `,
      [
        rid,
      ]
    );

  return rows || [];
}


async function emitPricingRulesSnapshotTx(
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
          PRICING_RULES_DOMAIN,
      }
    );

  const rows =
    await loadPricingRulesSnapshotTx(
      tx,
      rid
    );

  const payload =
    validatePricingRulesPayload({
      schema_version:
        PRICING_RULES_SCHEMA_VERSION,
      revision,
      rules:
        rows,
    });

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          rid,
        eventType:
          PRICING_RULES_EVENT_TYPE,
        entityType:
          "pricing_rules",
        entityId:
          String(rid),
        idempotencyKey:
          `${PRICING_RULES_EVENT_TYPE}:${revision}`,
        payload,
      }
    );

  return {
    revision,
    payload,
    event,
  };
}


async function replaceLocalPricingRulesTx(
  tx,
  restaurantId,
  rules
) {
  requireTx(tx);

  const rid =
    requireRestaurantId(
      restaurantId
    );

  await tx.qRun(
    `
    DELETE FROM
      public.pricing_rules
    WHERE
      restaurant_id = $1
    `,
    [
      rid,
    ]
  );

  for (
    const rule of rules
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.pricing_rules
      (
        id,
        restaurant_id,
        name,
        rule_type,
        active,
        priority,
        conditions,
        actions,
        starts_at,
        ends_at,
        created_at,
        updated_at
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
        $8::jsonb,
        $9,
        $10,
        $11,
        $12
      )
      `,
      [
        rule.id,
        rid,
        rule.name,
        rule.rule_type,
        rule.active,
        rule.priority,
        JSON.stringify(
          rule.conditions
        ),
        JSON.stringify(
          rule.actions
        ),
        rule.starts_at,
        rule.ends_at,
        rule.created_at,
        rule.updated_at,
      ]
    );
  }

  return {
    replaced:
      rules.length,
  };
}


async function applyPricingRulesReplaced({
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
      PRICING_RULES_EVENT_TYPE
  ) {
    throw new PricingRulesContractError(
      "PRICING_SYNC_EVENT_TYPE_INVALID",
      "Pricing rules handler received the wrong event type"
    );
  }

  const normalized =
    validatePricingRulesPayload(
      payload
    );

  const result =
    await applyDomainRevisionTx(
      tx,
      {
        restaurantId:
          rid,
        domain:
          PRICING_RULES_DOMAIN,
        revision:
          normalized.revision,
        payloadHash:
          event?.payload_hash,
        execute:
          async () =>
            replaceLocalPricingRulesTx(
              tx,
              rid,
              normalized.rules
            ),
      }
    );

  return {
    ...result,
    ruleCount:
      normalized.rules.length,
  };
}


module.exports = {
  PRICING_RULES_DOMAIN,
  PRICING_RULES_EVENT_TYPE,
  PRICING_RULES_SCHEMA_VERSION,
  PricingRulesContractError,
  validatePricingRulesPayload,
  loadPricingRulesSnapshotTx,
  emitPricingRulesSnapshotTx,
  applyPricingRulesReplaced,
};
