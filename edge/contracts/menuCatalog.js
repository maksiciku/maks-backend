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


const MENU_CATALOG_DOMAIN =
  "menu.catalog";

const MENU_CATALOG_EVENT_TYPE =
  "menu.catalog.replaced.v1";

const MENU_CATALOG_SCHEMA_VERSION =
  1;

const MAX_PAYLOAD_BYTES =
  8 * 1024 * 1024;

const MAX_COUNTS =
  Object.freeze({
    categories:
      1000,

    meals:
      5000,

    menu_items:
      10000,

    menu_groups:
      1000,

    menu_group_categories:
      10000,

    menu_group_schedules:
      5000,
  });

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

const MENU_ITEM_TYPES =
  new Set([
    "meal",
    "drink",
    "dessert",
  ]);

const MENU_GROUP_BASE_TYPES =
  new Set([
    "meals",
    "drinks",
    "desserts",
    "custom",
  ]);

const AVAILABILITY_MODES =
  new Set([
    "maks",
    "manual",
    "unlimited",
  ]);


class MenuCatalogContractError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "MenuCatalogContractError";

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
    throw new MenuCatalogContractError(
      "MENU_CATALOG_TX_REQUIRED",
      "Menu catalogue sync requires a PostgreSQL transaction"
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
    throw new MenuCatalogContractError(
      "MENU_CATALOG_RESTAURANT_INVALID",
      "Menu catalogue restaurantId must be a positive integer"
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
    Array.isArray(
      value
    )
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
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
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
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
}


function positiveInteger(
  value,
  label
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(
      number
    ) ||
    number <= 0
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
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
  label,
  {
    min =
      -1_000_000_000,

    max =
      1_000_000_000,
  } = {}
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(
      number
    ) ||
    number < min ||
    number > max
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} must be a safe bounded integer`
    );
  }

  return number;
}


function nullableNonNegativeInteger(
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

  return boundedInteger(
    value,
    label,
    {
      min: 0,
      max:
        1_000_000_000,
    }
  );
}


function strictBoolean(
  value,
  label
) {
  if (
    typeof value !==
      "boolean"
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} must be a boolean`
    );
  }

  return value;
}


function textValue(
  value,
  label,
  {
    max,
    nullable =
      false,

    allowEmpty =
      false,
  }
) {
  if (
    value === null ||
    value === undefined
  ) {
    if (
      nullable
    ) {
      return null;
    }

    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} is required`
    );
  }

  const text =
    value instanceof Date
      ? value.toISOString()
      : String(
          value
        );

  if (
    (
      !allowEmpty &&
      !text.trim()
    ) ||
    text.length > max
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} is invalid`
    );
  }

  return text;
}


function optionalText(
  value,
  label,
  max
) {
  return textValue(
    value,
    label,
    {
      max,
      nullable:
        true,
      allowEmpty:
        true,
    }
  );
}


function nonNegativeNumber(
  value,
  label,
  {
    nullable =
      false,

    max =
      1_000_000_000,
  } = {}
) {
  if (
    (
      value === null ||
      value === undefined ||
      value === ""
    ) &&
    nullable
  ) {
    return null;
  }

  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    ) ||
    number < 0 ||
    number > max
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} must be a valid non-negative number`
    );
  }

  return number;
}


function vatRate(
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

  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    ) ||
    number < 0 ||
    number > 100
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} must be between 0 and 100`
    );
  }

  return number;
}


function jsonValue(
  value,
  label,
  maxBytes
) {
  if (
    value === undefined
  ) {
    return null;
  }

  let encoded;

  try {
    encoded =
      JSON.stringify(
        value
      );
  } catch {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} must be JSON serialisable`
    );
  }

  if (
    encoded === undefined
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} must be JSON serialisable`
    );
  }

  const bytes =
    Buffer.byteLength(
      encoded,
      "utf8"
    );

  if (
    bytes > maxBytes
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_TOO_LARGE",
      `${label} is too large`
    );
  }

  return JSON.parse(
    encoded
  );
}


function ingredientsText(
  value,
  label
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "[]";
  }

  const text =
    typeof value ===
      "string"
      ? value
      : JSON.stringify(
          value
        );

  if (
    Buffer.byteLength(
      text,
      "utf8"
    ) >
      512 * 1024
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_TOO_LARGE",
      `${label} is too large`
    );
  }

  return text;
}


function dayArray(
  value,
  label
) {
  const parsed =
    value === null ||
    value === undefined
      ? []
      : value;

  if (
    !Array.isArray(
      parsed
    )
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} must be an array`
    );
  }

  const unique =
    [];

  const seen =
    new Set();

  for (
    const raw of parsed
  ) {
    const day =
      String(
        raw || ""
      )
        .trim()
        .toLowerCase();

    if (
      !DAY_KEYS.has(
        day
      )
    ) {
      throw new MenuCatalogContractError(
        "MENU_CATALOG_PAYLOAD_INVALID",
        `${label} contains an invalid day`
      );
    }

    if (
      !seen.has(
        day
      )
    ) {
      seen.add(
        day
      );

      unique.push(
        day
      );
    }
  }

  return unique;
}


function availabilityMode(
  value,
  label
) {
  const mode =
    String(
      value ||
      "maks"
    )
      .trim()
      .toLowerCase();

  if (
    !AVAILABILITY_MODES.has(
      mode
    )
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} is invalid`
    );
  }

  return mode;
}


function normalizeCategory(
  row,
  index
) {
  plainObject(
    row,
    `catalog.categories[${index}]`
  );

  assertOnlyKeys(
    row,
    [
      "id",
      "name",
      "type",
      "icon",
    ],
    `catalog.categories[${index}]`
  );

  return {
    id:
      positiveInteger(
        row.id,
        `catalog.categories[${index}].id`
      ),

    name:
      textValue(
        row.name,
        `catalog.categories[${index}].name`,
        {
          max: 500,
        }
      ).trim(),

    type:
      textValue(
        row.type,
        `catalog.categories[${index}].type`,
        {
          max: 100,
        }
      )
        .trim()
        .toLowerCase(),

    icon:
      textValue(
        row.icon ?? "🍽️",
        `catalog.categories[${index}].icon`,
        {
          max: 64,
        }
      ).trim(),
  };
}


function normalizeMeal(
  row,
  index
) {
  plainObject(
    row,
    `catalog.meals[${index}]`
  );

  assertOnlyKeys(
    row,
    [
      "id",
      "name",
      "ingredients",
      "allergens",
      "calories",
      "price",
      "vat_rate",
      "category",
      "category_id",
      "paused",
      "photo_url",
      "options_schema",
      "availability_mode",
      "manual_quantity",
      "manually_stopped",
      "out_of_stock",
    ],
    `catalog.meals[${index}]`
  );

  return {
    id:
      positiveInteger(
        row.id,
        `catalog.meals[${index}].id`
      ),

    name:
      textValue(
        row.name,
        `catalog.meals[${index}].name`,
        {
          max: 500,
        }
      ).trim(),

    ingredients:
      ingredientsText(
        row.ingredients,
        `catalog.meals[${index}].ingredients`
      ),

    allergens:
      optionalText(
        row.allergens,
        `catalog.meals[${index}].allergens`,
        4000
      ),

    calories:
      nonNegativeNumber(
        row.calories,
        `catalog.meals[${index}].calories`,
        {
          nullable:
            true,
          max:
            10_000_000,
        }
      ),

    price:
      nonNegativeNumber(
        row.price,
        `catalog.meals[${index}].price`
      ),

    vat_rate:
      vatRate(
        row.vat_rate,
        `catalog.meals[${index}].vat_rate`
      ),

    category:
      optionalText(
        row.category,
        `catalog.meals[${index}].category`,
        500
      ),

    category_id:
      optionalPositiveInteger(
        row.category_id,
        `catalog.meals[${index}].category_id`
      ),

    paused:
      strictBoolean(
        row.paused,
        `catalog.meals[${index}].paused`
      ),

    photo_url:
      optionalText(
        row.photo_url,
        `catalog.meals[${index}].photo_url`,
        2048
      ),

    options_schema:
      jsonValue(
        row.options_schema,
        `catalog.meals[${index}].options_schema`,
        256 * 1024
      ),

    availability_mode:
      availabilityMode(
        row.availability_mode,
        `catalog.meals[${index}].availability_mode`
      ),

    manual_quantity:
      nullableNonNegativeInteger(
        row.manual_quantity,
        `catalog.meals[${index}].manual_quantity`
      ),

    manually_stopped:
      strictBoolean(
        row.manually_stopped,
        `catalog.meals[${index}].manually_stopped`
      ),

    out_of_stock:
      strictBoolean(
        row.out_of_stock,
        `catalog.meals[${index}].out_of_stock`
      ),
  };
}


function normalizeMenuItem(
  row,
  index
) {
  plainObject(
    row,
    `catalog.menu_items[${index}]`
  );

  assertOnlyKeys(
    row,
    [
      "id",
      "name",
      "type",
      "price",
      "category_id",
      "paused",
      "options_schema",
      "is_available",
      "out_of_stock",
      "photo_url",
      "allergens",
      "calories",
      "manual_portions_enabled",
      "manual_portions_available",
      "vat_rate",
      "availability_mode",
      "manual_quantity",
      "manually_stopped",
    ],
    `catalog.menu_items[${index}]`
  );

  const type =
    String(
      row.type || ""
    )
      .trim()
      .toLowerCase();

  if (
    !MENU_ITEM_TYPES.has(
      type
    )
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `catalog.menu_items[${index}].type is invalid`
    );
  }

  return {
    id:
      positiveInteger(
        row.id,
        `catalog.menu_items[${index}].id`
      ),

    name:
      textValue(
        row.name,
        `catalog.menu_items[${index}].name`,
        {
          max: 500,
        }
      ).trim(),

    type,

    price:
      nonNegativeNumber(
        row.price,
        `catalog.menu_items[${index}].price`
      ),

    category_id:
      optionalPositiveInteger(
        row.category_id,
        `catalog.menu_items[${index}].category_id`
      ),

    paused:
      strictBoolean(
        row.paused,
        `catalog.menu_items[${index}].paused`
      ),

    options_schema:
      jsonValue(
        row.options_schema,
        `catalog.menu_items[${index}].options_schema`,
        256 * 1024
      ),

    is_available:
      strictBoolean(
        row.is_available,
        `catalog.menu_items[${index}].is_available`
      ),

    out_of_stock:
      strictBoolean(
        row.out_of_stock,
        `catalog.menu_items[${index}].out_of_stock`
      ),

    photo_url:
      optionalText(
        row.photo_url,
        `catalog.menu_items[${index}].photo_url`,
        2048
      ),

    allergens:
      optionalText(
        row.allergens,
        `catalog.menu_items[${index}].allergens`,
        4000
      ),

    calories:
      nonNegativeNumber(
        row.calories,
        `catalog.menu_items[${index}].calories`,
        {
          nullable:
            true,
          max:
            10_000_000,
        }
      ),

    manual_portions_enabled:
      strictBoolean(
        row.manual_portions_enabled,
        `catalog.menu_items[${index}].manual_portions_enabled`
      ),

    manual_portions_available:
      nullableNonNegativeInteger(
        row.manual_portions_available,
        `catalog.menu_items[${index}].manual_portions_available`
      ),

    vat_rate:
      vatRate(
        row.vat_rate,
        `catalog.menu_items[${index}].vat_rate`
      ),

    availability_mode:
      availabilityMode(
        row.availability_mode,
        `catalog.menu_items[${index}].availability_mode`
      ),

    manual_quantity:
      nullableNonNegativeInteger(
        row.manual_quantity,
        `catalog.menu_items[${index}].manual_quantity`
      ),

    manually_stopped:
      strictBoolean(
        row.manually_stopped,
        `catalog.menu_items[${index}].manually_stopped`
      ),
  };
}


function normalizeMenuGroup(
  row,
  index
) {
  plainObject(
    row,
    `catalog.menu_groups[${index}]`
  );

  assertOnlyKeys(
    row,
    [
      "id",
      "name",
      "base_type",
      "parent_id",
      "sort_order",
      "show_pos",
      "show_qr",
      "show_kiosk",
      "active_days",
      "start_time",
      "end_time",
      "is_active",
      "start_date",
      "end_date",
      "priority",
    ],
    `catalog.menu_groups[${index}]`
  );

  const baseType =
    String(
      row.base_type ||
      "meals"
    )
      .trim()
      .toLowerCase();

  if (
    !MENU_GROUP_BASE_TYPES.has(
      baseType
    )
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `catalog.menu_groups[${index}].base_type is invalid`
    );
  }

  return {
    id:
      positiveInteger(
        row.id,
        `catalog.menu_groups[${index}].id`
      ),

    name:
      textValue(
        row.name,
        `catalog.menu_groups[${index}].name`,
        {
          max: 500,
        }
      ).trim(),

    base_type:
      baseType,

    parent_id:
      optionalPositiveInteger(
        row.parent_id,
        `catalog.menu_groups[${index}].parent_id`
      ),

    sort_order:
      boundedInteger(
        row.sort_order,
        `catalog.menu_groups[${index}].sort_order`
      ),

    show_pos:
      strictBoolean(
        row.show_pos,
        `catalog.menu_groups[${index}].show_pos`
      ),

    show_qr:
      strictBoolean(
        row.show_qr,
        `catalog.menu_groups[${index}].show_qr`
      ),

    show_kiosk:
      strictBoolean(
        row.show_kiosk,
        `catalog.menu_groups[${index}].show_kiosk`
      ),

    active_days:
      dayArray(
        row.active_days,
        `catalog.menu_groups[${index}].active_days`
      ),

    start_time:
      optionalText(
        row.start_time,
        `catalog.menu_groups[${index}].start_time`,
        32
      ),

    end_time:
      optionalText(
        row.end_time,
        `catalog.menu_groups[${index}].end_time`,
        32
      ),

    is_active:
      strictBoolean(
        row.is_active,
        `catalog.menu_groups[${index}].is_active`
      ),

    start_date:
      optionalText(
        row.start_date,
        `catalog.menu_groups[${index}].start_date`,
        80
      ),

    end_date:
      optionalText(
        row.end_date,
        `catalog.menu_groups[${index}].end_date`,
        80
      ),

    priority:
      boundedInteger(
        row.priority,
        `catalog.menu_groups[${index}].priority`
      ),
  };
}


function normalizeMenuGroupCategory(
  row,
  index
) {
  plainObject(
    row,
    `catalog.menu_group_categories[${index}]`
  );

  assertOnlyKeys(
    row,
    [
      "id",
      "menu_group_id",
      "category_id",
      "sort_order",
    ],
    `catalog.menu_group_categories[${index}]`
  );

  return {
    id:
      positiveInteger(
        row.id,
        `catalog.menu_group_categories[${index}].id`
      ),

    menu_group_id:
      positiveInteger(
        row.menu_group_id,
        `catalog.menu_group_categories[${index}].menu_group_id`
      ),

    category_id:
      positiveInteger(
        row.category_id,
        `catalog.menu_group_categories[${index}].category_id`
      ),

    sort_order:
      boundedInteger(
        row.sort_order,
        `catalog.menu_group_categories[${index}].sort_order`
      ),
  };
}


function normalizeMenuGroupSchedule(
  row,
  index
) {
  plainObject(
    row,
    `catalog.menu_group_schedules[${index}]`
  );

  assertOnlyKeys(
    row,
    [
      "id",
      "menu_group_id",
      "active_days",
      "start_time",
      "end_time",
      "priority",
      "is_active",
    ],
    `catalog.menu_group_schedules[${index}]`
  );

  return {
    id:
      positiveInteger(
        row.id,
        `catalog.menu_group_schedules[${index}].id`
      ),

    menu_group_id:
      positiveInteger(
        row.menu_group_id,
        `catalog.menu_group_schedules[${index}].menu_group_id`
      ),

    active_days:
      dayArray(
        row.active_days,
        `catalog.menu_group_schedules[${index}].active_days`
      ),

    start_time:
      optionalText(
        row.start_time,
        `catalog.menu_group_schedules[${index}].start_time`,
        32
      ),

    end_time:
      optionalText(
        row.end_time,
        `catalog.menu_group_schedules[${index}].end_time`,
        32
      ),

    priority:
      boundedInteger(
        row.priority,
        `catalog.menu_group_schedules[${index}].priority`
      ),

    is_active:
      strictBoolean(
        row.is_active,
        `catalog.menu_group_schedules[${index}].is_active`
      ),
  };
}


function arrayOf(
  value,
  label,
  max,
  normalizer
) {
  if (
    !Array.isArray(
      value
    )
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_INVALID",
      `${label} must be an array`
    );
  }

  if (
    value.length > max
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_TOO_LARGE",
      `${label} contains too many rows`
    );
  }

  return value.map(
    normalizer
  );
}


function assertUniqueIds(
  rows,
  label
) {
  const seen =
    new Set();

  for (
    const row of rows
  ) {
    if (
      seen.has(
        row.id
      )
    ) {
      throw new MenuCatalogContractError(
        "MENU_CATALOG_RELATION_INVALID",
        `${label} contains duplicate ids`,
        {
          id:
            row.id,
        }
      );
    }

    seen.add(
      row.id
    );
  }

  return seen;
}


function assertGroupParentGraph(
  groups,
  groupIds
) {
  const parents =
    new Map();

  for (
    const group of groups
  ) {
    if (
      group.parent_id ===
        null
    ) {
      continue;
    }

    if (
      group.parent_id ===
        group.id ||
      !groupIds.has(
        group.parent_id
      )
    ) {
      throw new MenuCatalogContractError(
        "MENU_CATALOG_RELATION_INVALID",
        "Menu group parent relationship is invalid",
        {
          menu_group_id:
            group.id,

          parent_id:
            group.parent_id,
        }
      );
    }

    parents.set(
      group.id,
      group.parent_id
    );
  }

  for (
    const group of groups
  ) {
    const visited =
      new Set();

    let cursor =
      group.id;

    while (
      parents.has(
        cursor
      )
    ) {
      if (
        visited.has(
          cursor
        )
      ) {
        throw new MenuCatalogContractError(
          "MENU_CATALOG_RELATION_INVALID",
          "Menu group parent relationships contain a cycle",
          {
            menu_group_id:
              group.id,
          }
        );
      }

      visited.add(
        cursor
      );

      cursor =
        parents.get(
          cursor
        );
    }
  }
}


function validateRelationships(
  catalog
) {
  const categoryIds =
    assertUniqueIds(
      catalog.categories,
      "catalog.categories"
    );

  assertUniqueIds(
    catalog.meals,
    "catalog.meals"
  );

  assertUniqueIds(
    catalog.menu_items,
    "catalog.menu_items"
  );

  const groupIds =
    assertUniqueIds(
      catalog.menu_groups,
      "catalog.menu_groups"
    );

  assertUniqueIds(
    catalog.menu_group_categories,
    "catalog.menu_group_categories"
  );

  assertUniqueIds(
    catalog.menu_group_schedules,
    "catalog.menu_group_schedules"
  );

  for (
    const meal of
      catalog.meals
  ) {
    if (
      meal.category_id !==
        null &&
      !categoryIds.has(
        meal.category_id
      )
    ) {
      throw new MenuCatalogContractError(
        "MENU_CATALOG_RELATION_INVALID",
        "Meal references a category outside the catalogue",
        {
          meal_id:
            meal.id,

          category_id:
            meal.category_id,
        }
      );
    }
  }

  for (
    const item of
      catalog.menu_items
  ) {
    if (
      item.category_id !==
        null &&
      !categoryIds.has(
        item.category_id
      )
    ) {
      throw new MenuCatalogContractError(
        "MENU_CATALOG_RELATION_INVALID",
        "Menu item references a category outside the catalogue",
        {
          menu_item_id:
            item.id,

          category_id:
            item.category_id,
        }
      );
    }
  }

  assertGroupParentGraph(
    catalog.menu_groups,
    groupIds
  );

  const relationPairs =
    new Set();

  for (
    const link of
      catalog.menu_group_categories
  ) {
    if (
      !groupIds.has(
        link.menu_group_id
      ) ||
      !categoryIds.has(
        link.category_id
      )
    ) {
      throw new MenuCatalogContractError(
        "MENU_CATALOG_RELATION_INVALID",
        "Menu group category link references a row outside the catalogue",
        {
          link_id:
            link.id,

          menu_group_id:
            link.menu_group_id,

          category_id:
            link.category_id,
        }
      );
    }

    const pair =
      `${link.menu_group_id}:${link.category_id}`;

    if (
      relationPairs.has(
        pair
      )
    ) {
      throw new MenuCatalogContractError(
        "MENU_CATALOG_RELATION_INVALID",
        "Menu group category pair is duplicated",
        {
          pair,
        }
      );
    }

    relationPairs.add(
      pair
    );
  }

  for (
    const schedule of
      catalog.menu_group_schedules
  ) {
    if (
      !groupIds.has(
        schedule.menu_group_id
      )
    ) {
      throw new MenuCatalogContractError(
        "MENU_CATALOG_RELATION_INVALID",
        "Menu group schedule references a row outside the catalogue",
        {
          schedule_id:
            schedule.id,

          menu_group_id:
            schedule.menu_group_id,
        }
      );
    }
  }
}


function validateMenuCatalogPayload(
  value
) {
  const payload =
    plainObject(
      value,
      "payload"
    );

  assertOnlyKeys(
    payload,
    [
      "schema_version",
      "revision",
      "catalog",
    ],
    "payload"
  );

  if (
    Number(
      payload.schema_version
    ) !==
      MENU_CATALOG_SCHEMA_VERSION
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_SCHEMA_UNSUPPORTED",
      "Menu catalogue schema version is unsupported"
    );
  }

  const revision =
    positiveInteger(
      payload.revision,
      "payload.revision"
    );

  const rawCatalog =
    plainObject(
      payload.catalog,
      "payload.catalog"
    );

  assertOnlyKeys(
    rawCatalog,
    [
      "categories",
      "meals",
      "menu_items",
      "menu_groups",
      "menu_group_categories",
      "menu_group_schedules",
    ],
    "payload.catalog"
  );

  const catalog = {
    categories:
      arrayOf(
        rawCatalog.categories,
        "catalog.categories",
        MAX_COUNTS.categories,
        normalizeCategory
      ),

    meals:
      arrayOf(
        rawCatalog.meals,
        "catalog.meals",
        MAX_COUNTS.meals,
        normalizeMeal
      ),

    menu_items:
      arrayOf(
        rawCatalog.menu_items,
        "catalog.menu_items",
        MAX_COUNTS.menu_items,
        normalizeMenuItem
      ),

    menu_groups:
      arrayOf(
        rawCatalog.menu_groups,
        "catalog.menu_groups",
        MAX_COUNTS.menu_groups,
        normalizeMenuGroup
      ),

    menu_group_categories:
      arrayOf(
        rawCatalog.menu_group_categories,
        "catalog.menu_group_categories",
        MAX_COUNTS.menu_group_categories,
        normalizeMenuGroupCategory
      ),

    menu_group_schedules:
      arrayOf(
        rawCatalog.menu_group_schedules,
        "catalog.menu_group_schedules",
        MAX_COUNTS.menu_group_schedules,
        normalizeMenuGroupSchedule
      ),
  };

  validateRelationships(
    catalog
  );

  const normalized = {
    schema_version:
      MENU_CATALOG_SCHEMA_VERSION,

    revision,

    catalog,
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
    throw new MenuCatalogContractError(
      "MENU_CATALOG_PAYLOAD_TOO_LARGE",
      "Menu catalogue payload exceeded the maximum allowed size"
    );
  }

  return normalized;
}


async function loadMenuCatalogSnapshotTx(
  tx,
  restaurantId
) {
  requireTx(
    tx
  );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  /*
   * One PostgreSQL transaction owns one pg Client.
   * Keep these reads sequential: issuing concurrent client.query()
   * calls on the same transaction client is deprecated by pg and
   * will be removed in pg@9.
   */
  const categories =
    await tx.qAll(
      `
      SELECT
        id,
        name,
        type,
        icon
      FROM
        public.categories
      WHERE
        restaurant_id = $1
      ORDER BY
        id ASC
      `,
      [
        rid,
      ]
    );

  const meals =
    await tx.qAll(
      `
      SELECT
        id,
        name,
        ingredients,
        allergens,
        calories,
        price,
        vat_rate,
        category,
        category_id,
        paused,
        photo_url,
        options_schema,
        availability_mode,
        manual_quantity,
        manually_stopped,
        out_of_stock
      FROM
        public.meals
      WHERE
        restaurant_id = $1
      ORDER BY
        id ASC
      `,
      [
        rid,
      ]
    );

  const menuItems =
    await tx.qAll(
      `
      SELECT
        id,
        name,
        type,
        price,
        category_id,
        paused,
        options_schema,
        is_available,
        out_of_stock,
        photo_url,
        allergens,
        calories,
        manual_portions_enabled,
        manual_portions_available,
        vat_rate,
        availability_mode,
        manual_quantity,
        manually_stopped
      FROM
        public.menu_items
      WHERE
        restaurant_id = $1
      ORDER BY
        id ASC
      `,
      [
        rid,
      ]
    );

  const menuGroups =
    await tx.qAll(
      `
      SELECT
        id,
        name,
        base_type,
        parent_id,
        sort_order,
        show_pos,
        show_qr,
        show_kiosk,
        active_days,
        start_time,
        end_time,
        is_active,
        start_date,
        end_date,
        priority
      FROM
        public.menu_groups
      WHERE
        restaurant_id = $1
      ORDER BY
        id ASC
      `,
      [
        rid,
      ]
    );

  const groupCategories =
    await tx.qAll(
      `
      SELECT
        id,
        menu_group_id,
        category_id,
        sort_order
      FROM
        public.menu_group_categories
      WHERE
        restaurant_id = $1
      ORDER BY
        id ASC
      `,
      [
        rid,
      ]
    );

  const schedules =
    await tx.qAll(
      `
      SELECT
        id,
        menu_group_id,
        active_days,
        start_time,
        end_time,
        priority,
        is_active
      FROM
        public.menu_group_schedules
      WHERE
        restaurant_id = $1
      ORDER BY
        id ASC
      `,
      [
        rid,
      ]
    );

  return {
    categories:
      categories || [],

    meals:
      meals || [],

    menu_items:
      menuItems || [],

    menu_groups:
      menuGroups || [],

    menu_group_categories:
      groupCategories || [],

    menu_group_schedules:
      schedules || [],
  };
}


async function emitMenuCatalogSnapshotTx(
  tx,
  {
    restaurantId,
  }
) {
  requireTx(
    tx
  );

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
          MENU_CATALOG_DOMAIN,
      }
    );

  const catalog =
    await loadMenuCatalogSnapshotTx(
      tx,
      rid
    );

  const payload =
    validateMenuCatalogPayload({
      schema_version:
        MENU_CATALOG_SCHEMA_VERSION,

      revision,

      catalog,
    });

  const event =
    await enqueueEdgeEventTx(
      tx,
      {
        restaurantId:
          rid,

        eventType:
          MENU_CATALOG_EVENT_TYPE,

        entityType:
          "menu_catalog",

        entityId:
          String(
            rid
          ),

        idempotencyKey:
          `${MENU_CATALOG_EVENT_TYPE}:${revision}`,

        payload,
      }
    );

  return {
    revision,
    payload,
    event,
  };
}


async function assertNoCrossTenantIdCollisionsTx(
  tx,
  restaurantId,
  table,
  ids
) {
  if (
    !ids.length
  ) {
    return;
  }

  const rows =
    await tx.qAll(
      `
      SELECT
        id,
        restaurant_id
      FROM
        public.${table}
      WHERE
        id = ANY(
          $1::bigint[]
        )
        AND restaurant_id <> $2
      LIMIT 20
      `,
      [
        ids,
        restaurantId,
      ]
    );

  if (
    rows?.length
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_ID_COLLISION",
      `Menu catalogue ${table} id belongs to another restaurant`,
      {
        table,

        ids:
          rows.map(
            (row) =>
              Number(
                row.id
              )
          ),
      }
    );
  }
}


async function deleteAbsentIdsTx(
  tx,
  restaurantId,
  table,
  ids
) {
  if (
    ids.length === 0
  ) {
    await tx.qRun(
      `
      DELETE FROM
        public.${table}
      WHERE
        restaurant_id = $1
      `,
      [
        restaurantId,
      ]
    );

    return;
  }

  await tx.qRun(
    `
    DELETE FROM
      public.${table}
    WHERE
      restaurant_id = $1
      AND NOT (
        id = ANY(
          $2::bigint[]
        )
      )
    `,
    [
      restaurantId,
      ids,
    ]
  );
}


async function replaceLocalMenuCatalogTx(
  tx,
  restaurantId,
  catalog
) {
  requireTx(
    tx
  );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  const normalized =
    validateMenuCatalogPayload({
      schema_version:
        MENU_CATALOG_SCHEMA_VERSION,

      revision: 1,

      catalog,
    }).catalog;

  const sets = {
    categories:
      normalized.categories.map(
        (row) =>
          row.id
      ),

    meals:
      normalized.meals.map(
        (row) =>
          row.id
      ),

    menu_items:
      normalized.menu_items.map(
        (row) =>
          row.id
      ),

    menu_groups:
      normalized.menu_groups.map(
        (row) =>
          row.id
      ),

    menu_group_categories:
      normalized
        .menu_group_categories
        .map(
          (row) =>
            row.id
        ),

    menu_group_schedules:
      normalized
        .menu_group_schedules
        .map(
          (row) =>
            row.id
        ),
  };

  for (
    const [
      table,
      ids,
    ] of Object.entries(
      sets
    )
  ) {
    await assertNoCrossTenantIdCollisionsTx(
      tx,
      rid,
      table,
      ids
    );
  }

  /*
   * Prune only obsolete rows.
   * Existing item IDs are preserved so recipe rows linked
   * to unchanged meals/menu_items are not destroyed.
   */
  await deleteAbsentIdsTx(
    tx,
    rid,
    "menu_group_schedules",
    sets.menu_group_schedules
  );

  await deleteAbsentIdsTx(
    tx,
    rid,
    "menu_group_categories",
    sets.menu_group_categories
  );

  await deleteAbsentIdsTx(
    tx,
    rid,
    "meals",
    sets.meals
  );

  await deleteAbsentIdsTx(
    tx,
    rid,
    "menu_items",
    sets.menu_items
  );

  await deleteAbsentIdsTx(
    tx,
    rid,
    "menu_groups",
    sets.menu_groups
  );

  await deleteAbsentIdsTx(
    tx,
    rid,
    "categories",
    sets.categories
  );

  for (
    const row of
      normalized.categories
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.categories
      (
        id,
        restaurant_id,
        name,
        type,
        icon
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5
      )
      ON CONFLICT (
        id
      )
      DO UPDATE
      SET
        name =
          EXCLUDED.name,

        type =
          EXCLUDED.type,

        icon =
          EXCLUDED.icon
      `,
      [
        row.id,
        rid,
        row.name,
        row.type,
        row.icon,
      ]
    );
  }

  for (
    const row of
      normalized.meals
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.meals
      (
        id,
        restaurant_id,
        name,
        ingredients,
        allergens,
        calories,
        price,
        vat_rate,
        category,
        category_id,
        paused,
        photo_url,
        options_schema,
        availability_mode,
        manual_quantity,
        manually_stopped,
        out_of_stock
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
        $8,
        $9,
        $10,
        $11,
        $12,
        $13::jsonb,
        $14,
        $15,
        $16,
        $17
      )
      ON CONFLICT (
        id
      )
      DO UPDATE
      SET
        name =
          EXCLUDED.name,

        ingredients =
          EXCLUDED.ingredients,

        allergens =
          EXCLUDED.allergens,

        calories =
          EXCLUDED.calories,

        price =
          EXCLUDED.price,

        vat_rate =
          EXCLUDED.vat_rate,

        category =
          EXCLUDED.category,

        category_id =
          EXCLUDED.category_id,

        paused =
          EXCLUDED.paused,

        photo_url =
          EXCLUDED.photo_url,

        options_schema =
          EXCLUDED.options_schema,

        availability_mode =
          EXCLUDED.availability_mode,

        manual_quantity =
          EXCLUDED.manual_quantity,

        manually_stopped =
          EXCLUDED.manually_stopped,

        out_of_stock =
          EXCLUDED.out_of_stock
      `,
      [
        row.id,
        rid,
        row.name,
        row.ingredients,
        row.allergens,
        row.calories,
        row.price,
        row.vat_rate,
        row.category,
        row.category_id,
        row.paused,
        row.photo_url,
        JSON.stringify(
          row.options_schema
        ),
        row.availability_mode,
        row.manual_quantity,
        row.manually_stopped,
        row.out_of_stock,
      ]
    );
  }

  for (
    const row of
      normalized.menu_items
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.menu_items
      (
        id,
        restaurant_id,
        name,
        type,
        price,
        category_id,
        paused,
        options_schema,
        is_available,
        out_of_stock,
        photo_url,
        allergens,
        calories,
        manual_portions_enabled,
        manual_portions_available,
        vat_rate,
        availability_mode,
        manual_quantity,
        manually_stopped
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
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19
      )
      ON CONFLICT (
        id
      )
      DO UPDATE
      SET
        name =
          EXCLUDED.name,

        type =
          EXCLUDED.type,

        price =
          EXCLUDED.price,

        category_id =
          EXCLUDED.category_id,

        paused =
          EXCLUDED.paused,

        options_schema =
          EXCLUDED.options_schema,

        is_available =
          EXCLUDED.is_available,

        out_of_stock =
          EXCLUDED.out_of_stock,

        photo_url =
          EXCLUDED.photo_url,

        allergens =
          EXCLUDED.allergens,

        calories =
          EXCLUDED.calories,

        manual_portions_enabled =
          EXCLUDED.manual_portions_enabled,

        manual_portions_available =
          EXCLUDED.manual_portions_available,

        vat_rate =
          EXCLUDED.vat_rate,

        availability_mode =
          EXCLUDED.availability_mode,

        manual_quantity =
          EXCLUDED.manual_quantity,

        manually_stopped =
          EXCLUDED.manually_stopped
      `,
      [
        row.id,
        rid,
        row.name,
        row.type,
        row.price,
        row.category_id,
        row.paused,
        JSON.stringify(
          row.options_schema
        ),
        row.is_available,
        row.out_of_stock,
        row.photo_url,
        row.allergens,
        row.calories,
        row.manual_portions_enabled,
        row.manual_portions_available,
        row.vat_rate,
        row.availability_mode,
        row.manual_quantity,
        row.manually_stopped,
      ]
    );
  }

  /*
   * Parent pointers are applied in a second pass after every
   * group exists locally.
   */
  for (
    const row of
      normalized.menu_groups
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.menu_groups
      (
        id,
        restaurant_id,
        name,
        base_type,
        parent_id,
        sort_order,
        show_pos,
        show_qr,
        show_kiosk,
        active_days,
        start_time,
        end_time,
        is_active,
        start_date,
        end_date,
        priority
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        NULL,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15
      )
      ON CONFLICT (
        id
      )
      DO UPDATE
      SET
        name =
          EXCLUDED.name,

        base_type =
          EXCLUDED.base_type,

        parent_id =
          NULL,

        sort_order =
          EXCLUDED.sort_order,

        show_pos =
          EXCLUDED.show_pos,

        show_qr =
          EXCLUDED.show_qr,

        show_kiosk =
          EXCLUDED.show_kiosk,

        active_days =
          EXCLUDED.active_days,

        start_time =
          EXCLUDED.start_time,

        end_time =
          EXCLUDED.end_time,

        is_active =
          EXCLUDED.is_active,

        start_date =
          EXCLUDED.start_date,

        end_date =
          EXCLUDED.end_date,

        priority =
          EXCLUDED.priority
      `,
      [
        row.id,
        rid,
        row.name,
        row.base_type,
        row.sort_order,
        row.show_pos,
        row.show_qr,
        row.show_kiosk,
        JSON.stringify(
          row.active_days
        ),
        row.start_time,
        row.end_time,
        row.is_active,
        row.start_date,
        row.end_date,
        row.priority,
      ]
    );
  }

  for (
    const row of
      normalized.menu_groups
  ) {
    if (
      row.parent_id ===
        null
    ) {
      continue;
    }

    await tx.qRun(
      `
      UPDATE
        public.menu_groups
      SET
        parent_id = $3
      WHERE
        id = $1
        AND restaurant_id = $2
      `,
      [
        row.id,
        rid,
        row.parent_id,
      ]
    );
  }

  for (
    const row of
      normalized
        .menu_group_categories
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.menu_group_categories
      (
        id,
        restaurant_id,
        menu_group_id,
        category_id,
        sort_order
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5
      )
      ON CONFLICT (
        id
      )
      DO UPDATE
      SET
        menu_group_id =
          EXCLUDED.menu_group_id,

        category_id =
          EXCLUDED.category_id,

        sort_order =
          EXCLUDED.sort_order
      `,
      [
        row.id,
        rid,
        row.menu_group_id,
        row.category_id,
        row.sort_order,
      ]
    );
  }

  for (
    const row of
      normalized
        .menu_group_schedules
  ) {
    await tx.qRun(
      `
      INSERT INTO
        public.menu_group_schedules
      (
        id,
        restaurant_id,
        menu_group_id,
        active_days,
        start_time,
        end_time,
        priority,
        is_active
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4::jsonb,
        $5,
        $6,
        $7,
        $8
      )
      ON CONFLICT (
        id
      )
      DO UPDATE
      SET
        menu_group_id =
          EXCLUDED.menu_group_id,

        active_days =
          EXCLUDED.active_days,

        start_time =
          EXCLUDED.start_time,

        end_time =
          EXCLUDED.end_time,

        priority =
          EXCLUDED.priority,

        is_active =
          EXCLUDED.is_active
      `,
      [
        row.id,
        rid,
        row.menu_group_id,
        JSON.stringify(
          row.active_days
        ),
        row.start_time,
        row.end_time,
        row.priority,
        row.is_active,
      ]
    );
  }

  return {
    categories:
      normalized.categories.length,

    meals:
      normalized.meals.length,

    menuItems:
      normalized.menu_items.length,

    menuGroups:
      normalized.menu_groups.length,

    menuGroupCategories:
      normalized
        .menu_group_categories
        .length,

    menuGroupSchedules:
      normalized
        .menu_group_schedules
        .length,
  };
}


async function applyMenuCatalogReplaced({
  tx,
  restaurantId,
  event,
  payload,
}) {
  requireTx(
    tx
  );

  const rid =
    requireRestaurantId(
      restaurantId
    );

  if (
    String(
      event?.event_type ||
      ""
    ).trim() !==
      MENU_CATALOG_EVENT_TYPE
  ) {
    throw new MenuCatalogContractError(
      "MENU_CATALOG_EVENT_TYPE_INVALID",
      "Menu catalogue handler received the wrong event type"
    );
  }

  const normalized =
    validateMenuCatalogPayload(
      payload
    );

  const result =
    await applyDomainRevisionTx(
      tx,
      {
        restaurantId:
          rid,

        domain:
          MENU_CATALOG_DOMAIN,

        revision:
          normalized.revision,

        payloadHash:
          event?.payload_hash,

        execute:
          async () =>
            replaceLocalMenuCatalogTx(
              tx,
              rid,
              normalized.catalog
            ),
      }
    );

  return {
    ...result,

    counts: {
      categories:
        normalized
          .catalog
          .categories
          .length,

      meals:
        normalized
          .catalog
          .meals
          .length,

      menu_items:
        normalized
          .catalog
          .menu_items
          .length,

      menu_groups:
        normalized
          .catalog
          .menu_groups
          .length,

      menu_group_categories:
        normalized
          .catalog
          .menu_group_categories
          .length,

      menu_group_schedules:
        normalized
          .catalog
          .menu_group_schedules
          .length,
    },
  };
}


module.exports = {
  MenuCatalogContractError,

  MENU_CATALOG_DOMAIN,
  MENU_CATALOG_EVENT_TYPE,
  MENU_CATALOG_SCHEMA_VERSION,
  MAX_PAYLOAD_BYTES,
  MAX_COUNTS,

  validateMenuCatalogPayload,
  loadMenuCatalogSnapshotTx,
  emitMenuCatalogSnapshotTx,
  replaceLocalMenuCatalogTx,
  applyMenuCatalogReplaced,
};
