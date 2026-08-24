"use strict";

/**
 * ==========================================================
 * MAKS OS
 * Authoritative Order Pricing Service
 * ==========================================================
 *
 * This service loads official item information directly from
 * PostgreSQL. Frontend names and prices must never be trusted.
 *
 * Current support:
 * - Meals from public.meals
 * - Drinks from public.menu_items
 * - Desserts from public.menu_items
 *
 * Next stages:
 * - Option validation and option priceDelta calculation
 * - Canonical cart construction
 * - Pricing rules and discounts
 */

class PricingError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "PricingError";
    this.status = Number(options.status || 400);
    this.code = String(options.code || "PRICING_ERROR");
    this.details = options.details || null;
  }
}

/**
 * Convert a value to a safe positive integer.
 */
function positiveInteger(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

/**
 * Convert a money value into integer pennies.
 *
 * Example:
 * 10.99 becomes 1099.
 */
function moneyToPennies(value, fieldName = "price") {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PricingError(`Invalid ${fieldName}`, {
      code: "INVALID_MONEY_VALUE",
      details: {
        field: fieldName,
      },
    });
  }

  return Math.round((parsed + Number.EPSILON) * 100);
}

/**
 * Convert integer pennies back into a normal GBP number.
 *
 * Example:
 * 1099 becomes 10.99.
 */
function penniesToMoney(value) {
  const pennies = Number(value || 0);

  if (!Number.isFinite(pennies)) {
    return 0;
  }

  return Number((pennies / 100).toFixed(2));
}

function roundMoney(value) {
  return penniesToMoney(moneyToPennies(value));
}

/**
 * Safely parse JSON.
 */
function parseJson(value, fallback = []) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeVatRate(raw) {
  if (
    raw === null ||
    raw === undefined ||
    String(raw).trim() === ""
  ) {
    return null;
  }

  const rate = Number(raw);

  if (
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 100
  ) {
    throw new PricingError(
      "Invalid VAT rate stored on menu item",
      {
        code: "INVALID_VAT_RATE",
        details: {
          vat_rate: raw,
        },
      }
    );
  }

  return Number(
    rate.toFixed(3)
  );
}


function calculateVatFromGross(
  gross,
  vatRate
) {
  const grossAmount =
    roundMoney(gross);

  if (
    vatRate === null ||
    vatRate === undefined
  ) {
    return {
      vat_rate: null,
      vat_gross: grossAmount,
      vat_net: grossAmount,
      vat_amount: 0,
    };
  }

  const rate =
    Number(vatRate);

  if (
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    return {
      vat_rate:
        Number.isFinite(rate)
          ? Number(rate.toFixed(3))
          : null,

      vat_gross: grossAmount,
      vat_net: grossAmount,
      vat_amount: 0,
    };
  }

  const divisor =
    1 + rate / 100;

  const net =
    roundMoney(
      grossAmount / divisor
    );

  const vat =
    roundMoney(
      grossAmount - net
    );

  return {
    vat_rate:
      Number(rate.toFixed(3)),

    vat_gross:
      grossAmount,

    vat_net:
      net,

    vat_amount:
      vat,
  };
}

/**
 * options_schema must always become an array.
 */
function parseOptionsSchema(schema) {
  const parsed = parseJson(schema, []);

  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Confirm the service is being used with the expected request
 * database helpers.
 */
function assertDatabaseContext(db) {
  if (!db || typeof db.qGet !== "function") {
    throw new PricingError("Pricing database context is missing", {
      status: 500,
      code: "MISSING_DATABASE_CONTEXT",
    });
  }

  if (db.kind && db.kind !== "pg") {
    throw new PricingError(
      "Authoritative pricing requires PostgreSQL",
      {
        status: 500,
        code: "POSTGRES_REQUIRED",
      }
    );
  }
}

/**
 * Convert menu item type into the canonical category name used
 * by orders.
 */
function canonicalMenuItemType(type) {
  const normalized = String(type || "")
    .trim()
    .toLowerCase();

  if (normalized === "drink" || normalized === "drinks") {
    return "drinks";
  }

  if (normalized === "dessert" || normalized === "desserts") {
    return "desserts";
  }

  return null;
}

/**
 * ==========================================================
 * LOAD AUTHORITATIVE MEAL
 * ==========================================================
 */
async function loadMeal(db, restaurantId, mealId) {
  assertDatabaseContext(db);

  const rid = positiveInteger(restaurantId);
  const id = positiveInteger(mealId);

  if (!rid) {
    throw new PricingError("Missing restaurant ID", {
      code: "MISSING_RESTAURANT_ID",
    });
  }

  if (!id) {
    throw new PricingError("Invalid meal ID", {
      code: "INVALID_MEAL_ID",
    });
  }

  const row = await db.qGet(
    `
    SELECT
      m.id,
      m.name,
      m.price,
      m.vat_rate,
      m.category,
      m.category_id,
      m.options_schema,
      m.paused,
      m.out_of_stock,
      m.photo_url,
      m.allergens,
      m.calories
    FROM public.meals m
    WHERE m.restaurant_id = $1
      AND m.id = $2
    LIMIT 1
    `,
    [rid, id]
  );

  if (!row) {
    throw new PricingError("Meal not found", {
      status: 404,
      code: "MEAL_NOT_FOUND",
      details: {
        restaurant_id: rid,
        meal_id: id,
      },
    });
  }

  return {
    source: "meals",

    item_id: Number(row.id),
    meal_id: Number(row.id),
    menu_item_id: null,

    name: String(row.name || "").trim(),
    type: "meal",
    item_type: "meals",

    category: row.category
      ? String(row.category).trim()
      : "Meals",

    category_id:
      row.category_id === null ||
      row.category_id === undefined
        ? null
        : Number(row.category_id),

    base_price: penniesToMoney(
      moneyToPennies(row.price, "meal price")
    ),

    vat_rate:
  normalizeVatRate(
    row.vat_rate
  ),

    options_schema: parseOptionsSchema(row.options_schema),

    paused: row.paused === true || Number(row.paused) === 1,

    out_of_stock:
      row.out_of_stock === true ||
      Number(row.out_of_stock) === 1,

    photo_url: row.photo_url || null,
    allergens: row.allergens || "None",
    calories: Number(row.calories || 0),
  };
}

/**
 * ==========================================================
 * LOAD AUTHORITATIVE MENU ITEM
 * ==========================================================
 *
 * Drinks and desserts are both stored in public.menu_items.
 */
async function loadMenuItem(
  db,
  restaurantId,
  menuItemId,
  expectedType = null
) {
  assertDatabaseContext(db);

  const rid = positiveInteger(restaurantId);
  const id = positiveInteger(menuItemId);

  if (!rid) {
    throw new PricingError("Missing restaurant ID", {
      code: "MISSING_RESTAURANT_ID",
    });
  }

  if (!id) {
    throw new PricingError("Invalid menu item ID", {
      code: "INVALID_MENU_ITEM_ID",
    });
  }

  const row = await db.qGet(
    `
    SELECT
      mi.id,
      mi.name,
      mi.price,
      mi.vat_rate,
      mi.type,
      mi.category_id,
      mi.options_schema,
      mi.out_of_stock,
      mi.photo_url,
      mi.allergens,
      mi.calories
    FROM public.menu_items mi
    WHERE mi.restaurant_id = $1
      AND mi.id = $2
    LIMIT 1
    `,
    [rid, id]
  );

  if (!row) {
    throw new PricingError("Menu item not found", {
      status: 404,
      code: "MENU_ITEM_NOT_FOUND",
      details: {
        restaurant_id: rid,
        menu_item_id: id,
      },
    });
  }

  const itemType = canonicalMenuItemType(row.type);

  if (!itemType) {
    throw new PricingError(
      "This menu item type is not supported by the pricing engine",
      {
        status: 500,
        code: "UNSUPPORTED_MENU_ITEM_TYPE",
        details: {
          menu_item_id: id,
          type: row.type,
        },
      }
    );
  }

  const expectedCanonicalType = expectedType
    ? canonicalMenuItemType(expectedType)
    : null;

  if (
    expectedCanonicalType &&
    expectedCanonicalType !== itemType
  ) {
    throw new PricingError(
      "Menu item type does not match the submitted order",
      {
        code: "MENU_ITEM_TYPE_MISMATCH",
        details: {
          menu_item_id: id,
          expected_type: expectedCanonicalType,
          actual_type: itemType,
        },
      }
    );
  }

  return {
    source: "menu_items",

    item_id: Number(row.id),
    meal_id: null,
    menu_item_id: Number(row.id),

    name: String(row.name || "").trim(),

    type:
      itemType === "drinks"
        ? "drink"
        : "dessert",

    item_type: itemType,
    category: itemType,

    category_id:
      row.category_id === null ||
      row.category_id === undefined
        ? null
        : Number(row.category_id),

    base_price: penniesToMoney(
      moneyToPennies(row.price, `${itemType} price`)
    ),

    vat_rate:
  normalizeVatRate(
    row.vat_rate
  ),

    options_schema: parseOptionsSchema(row.options_schema),

    paused: false,

    out_of_stock:
      row.out_of_stock === true ||
      Number(row.out_of_stock) === 1,

    photo_url: row.photo_url || null,
    allergens: row.allergens || "None",
    calories: Number(row.calories || 0),
  };
}

/**
 * Load a drink while enforcing that the database item really is
 * a drink.
 */
async function loadDrink(db, restaurantId, menuItemId) {
  return loadMenuItem(
    db,
    restaurantId,
    menuItemId,
    "drink"
  );
}

/**
 * Load a dessert while enforcing that the database item really is
 * a dessert.
 */
async function loadDessert(db, restaurantId, menuItemId) {
  return loadMenuItem(
    db,
    restaurantId,
    menuItemId,
    "dessert"
  );
}

/**
 * ==========================================================
 * STRICT OPTION VALIDATION
 * ==========================================================
 *
 * The frontend may submit only option and choice IDs.
 *
 * Labels and priceDelta values are always loaded from the
 * authoritative options_schema stored in PostgreSQL.
 */

function normalizeOptionId(value) {
  return String(value || "").trim();
}

function normalizeSubmittedOptions(value) {
  const parsed = parseJson(value, {});

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new PricingError(
      "Selected options must be an object",
      {
        code: "INVALID_SELECTED_OPTIONS",
      }
    );
  }

  return parsed;
}

/**
 * Read option priceDelta safely.
 *
 * `priceDelta` is the official field currently created by
 * OptionsBuilder.
 *
 * Legacy aliases are accepted temporarily so old saved menu
 * options do not immediately break.
 */
function getChoicePriceDelta(choice) {
  const rawValue =
    choice?.priceDelta ??
    choice?.price_delta ??
    choice?.extra_price ??
    choice?.additional_price ??
    0;

  return penniesToMoney(
    moneyToPennies(rawValue, "option price")
  );
}

/**
 * Return a safe canonical choice.
 *
 * Client-submitted labels and prices are discarded.
 */
function canonicalChoice(choice) {
  return {
    id: normalizeOptionId(choice?.id),
    label: String(choice?.label || "").trim(),
    priceDelta: getChoicePriceDelta(choice),

    stock_id: positiveInteger(choice?.stock_id),

    deduct_qty:
      Number.isFinite(Number(choice?.deduct_qty)) &&
      Number(choice?.deduct_qty) > 0
        ? Number(choice.deduct_qty)
        : null,
  };
}

/**
 * Validate submitted options against the database schema and
 * calculate the trusted additional unit price.
 *
 * Expected submitted structure:
 *
 * {
 *   bread: "white",
 *   extras: ["cheese", "bacon"],
 *   message: "No onions"
 * }
 */
function validateAndPriceOptions(
  optionsSchema,
  submittedOptions
) {
  const schema = parseOptionsSchema(optionsSchema);
  const selected = normalizeSubmittedOptions(
    submittedOptions
  );

  const canonicalOptions = {};
  const optionDetails = [];

  let optionPricePennies = 0;

  const knownOptionIds = new Set();

  for (const option of schema) {
    const optionId = normalizeOptionId(option?.id);
    const optionLabel = String(
      option?.label || optionId
    ).trim();

    const optionType = String(
      option?.type || "single"
    )
      .trim()
      .toLowerCase();

    const required = option?.required === true;

    if (!optionId) {
      throw new PricingError(
        "Saved option is missing its ID",
        {
          status: 500,
          code: "INVALID_OPTIONS_SCHEMA",
        }
      );
    }

    if (knownOptionIds.has(optionId)) {
      throw new PricingError(
        "Saved options contain duplicate IDs",
        {
          status: 500,
          code: "DUPLICATE_OPTION_ID",
          details: {
            option_id: optionId,
          },
        }
      );
    }

    knownOptionIds.add(optionId);

    if (
      !["single", "multi", "text"].includes(
        optionType
      )
    ) {
      throw new PricingError(
        "Saved option has an unsupported type",
        {
          status: 500,
          code: "INVALID_OPTION_TYPE",
          details: {
            option_id: optionId,
            option_type: optionType,
          },
        }
      );
    }

    const submittedValue = selected[optionId];

    /**
     * Text option
     */
    if (optionType === "text") {
      const text =
        submittedValue === null ||
        submittedValue === undefined
          ? ""
          : String(submittedValue).trim();

      if (required && !text) {
        throw new PricingError(
          `Please complete: ${optionLabel}`,
          {
            code: "REQUIRED_OPTION_MISSING",
            details: {
              option_id: optionId,
            },
          }
        );
      }

      if (text.length > 250) {
        throw new PricingError(
          `${optionLabel} is too long`,
          {
            code: "OPTION_TEXT_TOO_LONG",
            details: {
              option_id: optionId,
              maximum_length: 250,
            },
          }
        );
      }

      if (text) {
        canonicalOptions[optionId] = text;

        optionDetails.push({
          option_id: optionId,
          option_label: optionLabel,
          option_type: "text",
          value: text,
          priceDelta: 0,
        });
      }

      continue;
    }

    const choices = Array.isArray(option?.choices)
      ? option.choices
      : [];

    const choiceMap = new Map();

    for (const rawChoice of choices) {
      const choice = canonicalChoice(rawChoice);

      if (!choice.id) {
        throw new PricingError(
          "Saved option choice is missing its ID",
          {
            status: 500,
            code: "INVALID_OPTIONS_SCHEMA",
            details: {
              option_id: optionId,
            },
          }
        );
      }

      if (choiceMap.has(choice.id)) {
        throw new PricingError(
          "Saved option contains duplicate choice IDs",
          {
            status: 500,
            code: "DUPLICATE_CHOICE_ID",
            details: {
              option_id: optionId,
              choice_id: choice.id,
            },
          }
        );
      }

      choiceMap.set(choice.id, choice);
    }

    /**
     * Single-choice option
     */
    if (optionType === "single") {
      const selectedChoiceId =
        submittedValue === null ||
        submittedValue === undefined
          ? ""
          : normalizeOptionId(submittedValue);

      if (required && !selectedChoiceId) {
        throw new PricingError(
          `Please select: ${optionLabel}`,
          {
            code: "REQUIRED_OPTION_MISSING",
            details: {
              option_id: optionId,
            },
          }
        );
      }

      if (!selectedChoiceId) {
        continue;
      }

      const selectedChoice = choiceMap.get(
        selectedChoiceId
      );

      if (!selectedChoice) {
        throw new PricingError(
          `Invalid selection for ${optionLabel}`,
          {
            code: "INVALID_OPTION_CHOICE",
            details: {
              option_id: optionId,
              choice_id: selectedChoiceId,
            },
          }
        );
      }

      optionPricePennies += moneyToPennies(
        selectedChoice.priceDelta,
        "option price"
      );

      canonicalOptions[optionId] =
        selectedChoice.id;

      optionDetails.push({
        option_id: optionId,
        option_label: optionLabel,
        option_type: "single",
        choices: [selectedChoice],
        priceDelta: selectedChoice.priceDelta,
      });

      continue;
    }

    /**
     * Multiple-choice option
     */
    const selectedChoiceIds = Array.isArray(
      submittedValue
    )
      ? [
          ...new Set(
            submittedValue
              .map(normalizeOptionId)
              .filter(Boolean)
          ),
        ]
      : [];

    if (
      required &&
      selectedChoiceIds.length === 0
    ) {
      throw new PricingError(
        `Please select: ${optionLabel}`,
        {
          code: "REQUIRED_OPTION_MISSING",
          details: {
            option_id: optionId,
          },
        }
      );
    }

    const maxSelections = positiveInteger(
      option?.maxSelections ??
        option?.max_selections
    );

    if (
      maxSelections &&
      selectedChoiceIds.length > maxSelections
    ) {
      throw new PricingError(
        `Too many selections for ${optionLabel}`,
        {
          code: "OPTION_SELECTION_LIMIT_EXCEEDED",
          details: {
            option_id: optionId,
            maximum_selections: maxSelections,
          },
        }
      );
    }

    const canonicalChoices = [];
    let thisOptionPennies = 0;

    for (const selectedChoiceId of selectedChoiceIds) {
      const selectedChoice = choiceMap.get(
        selectedChoiceId
      );

      if (!selectedChoice) {
        throw new PricingError(
          `Invalid selection for ${optionLabel}`,
          {
            code: "INVALID_OPTION_CHOICE",
            details: {
              option_id: optionId,
              choice_id: selectedChoiceId,
            },
          }
        );
      }

      thisOptionPennies += moneyToPennies(
        selectedChoice.priceDelta,
        "option price"
      );

      canonicalChoices.push(selectedChoice);
    }

    if (canonicalChoices.length) {
      optionPricePennies += thisOptionPennies;

      canonicalOptions[optionId] =
        canonicalChoices.map(
          (choice) => choice.id
        );

      optionDetails.push({
        option_id: optionId,
        option_label: optionLabel,
        option_type: "multi",
        choices: canonicalChoices,
        priceDelta:
          penniesToMoney(thisOptionPennies),
      });
    }
  }

  /**
   * Reject forged option keys.
   *
   * Example:
   *
   * {
   *   fake_discount: "free"
   * }
   */
  for (const submittedOptionId of Object.keys(
    selected
  )) {
    if (!knownOptionIds.has(submittedOptionId)) {
      throw new PricingError(
        "Order contains an unknown option",
        {
          code: "UNKNOWN_OPTION",
          details: {
            option_id: submittedOptionId,
          },
        }
      );
    }
  }

  return {
    selected_options: canonicalOptions,
    option_details: optionDetails,

    option_price: penniesToMoney(
      optionPricePennies
    ),

    option_price_pennies:
      optionPricePennies,
  };
}

function buildOptionDisplay(optionDetails = []) {
  const display = {};

  for (const detail of Array.isArray(optionDetails) ? optionDetails : []) {
    const label = String(
      detail?.option_label ||
      detail?.option_id ||
      ""
    ).trim();

    if (!label) continue;

    if (detail?.option_type === "text") {
      const value = String(detail?.value || "").trim();

      if (value) {
        display[label] = value;
      }

      continue;
    }

    const choices = Array.isArray(detail?.choices)
      ? detail.choices
      : [];

    const labels = choices
      .map((choice) => String(choice?.label || "").trim())
      .filter(Boolean);

    if (!labels.length) continue;

    display[label] =
      detail?.option_type === "multi"
        ? labels
        : labels[0];
  }

  return display;
}

function resolveSubmittedItem(line) {
  if (!line || typeof line !== "object") {
    throw new PricingError("Invalid order line");
  }

  if (positiveInteger(line.meal_id)) {
    return {
      source: "meal",
      id: positiveInteger(line.meal_id),
    };
  }

  if (positiveInteger(line.menu_item_id)) {
    return {
      source: "menu_item",
      id: positiveInteger(line.menu_item_id),
      type: String(line.item_type || "").toLowerCase(),
    };
  }

  throw new PricingError("Unknown item type", {
    code: "UNKNOWN_ITEM_TYPE",
  });
}

async function buildCanonicalLine(
  db,
  restaurantId,
  submitted,
  {
    stockOverrideAuthorised = false,
  } = {}
) {

  const qty = positiveInteger(submitted.quantity) || 1;

  let item;

  const resolved = resolveSubmittedItem(submitted);

  if (resolved.source === "meal") {
    item = await loadMeal(
      db,
      restaurantId,
      resolved.id
    );
  }

 else {
  const canonicalType = canonicalMenuItemType(
    resolved.type
  );

  if (canonicalType === "drinks") {
    item = await loadDrink(
      db,
      restaurantId,
      resolved.id
    );
  } else if (canonicalType === "desserts") {
    item = await loadDessert(
      db,
      restaurantId,
      resolved.id
    );
  } else {
    throw new PricingError(
      "Unknown menu item type",
      {
        code: "UNKNOWN_MENU_ITEM_TYPE",
        details: {
          menu_item_id: resolved.id,
          submitted_type: resolved.type,
        },
      }
    );
  }
}

    const requestedStockOverride =
    submitted?.stock_override === true ||
    submitted?.stock_override === "true" ||
    submitted?.allow_stock_override === true ||
    submitted?.allow_stock_override === "true";

  const stockOverrideAllowed =
    stockOverrideAuthorised === true &&
    requestedStockOverride;

  if (
    item.out_of_stock &&
    !stockOverrideAllowed
  ) {
    throw new PricingError(
      `${item.name} is out of stock`
    );
  }

  if (item.paused) {
    throw new PricingError(
      `${item.name} is paused`
    );
  }

  const options =
    validateAndPriceOptions(
      item.options_schema,
      submitted.options
    );

  const optionsDisplay = {};

for (const detail of options.option_details || []) {
  const label = String(
    detail?.option_label ||
    detail?.option_id ||
    ""
  ).trim();

  if (!label) continue;

  if (detail?.option_type === "text") {
    const value = String(
      detail?.value || ""
    ).trim();

    if (value) {
      optionsDisplay[label] = value;
    }

    continue;
  }

  const choices = Array.isArray(detail?.choices)
    ? detail.choices
    : [];

  const choiceLabels = choices
    .map((choice) =>
      String(choice?.label || "").trim()
    )
    .filter(Boolean);

  if (!choiceLabels.length) continue;

  optionsDisplay[label] =
    detail?.option_type === "multi"
      ? choiceLabels
      : choiceLabels[0];
}

  const unitPrice =
    roundMoney(
      item.base_price +
      options.option_price
    );

  const total =
    roundMoney(
      unitPrice * qty
    );

    const unitVat =
  calculateVatFromGross(
    unitPrice,
    item.vat_rate
  );

const vat = {
  vat_rate:
    unitVat.vat_rate,

  vat_gross:
    roundMoney(
      unitVat.vat_gross * qty
    ),

  vat_net:
    roundMoney(
      unitVat.vat_net * qty
    ),

  vat_amount:
    roundMoney(
      unitVat.vat_amount * qty
    ),
};

  return {
  source:
    item.source,

  item_id:
    item.item_id,

  meal_id:
    item.meal_id,

  menu_item_id:
    item.menu_item_id,

  name:
    item.name,

  item_type:
    item.item_type,

  category:
    item.category,

  category_id:
    item.category_id,

  quantity:
    qty,

  base_price:
    item.base_price,

  option_price:
    options.option_price,

  unit_price:
    unitPrice,

  total_price:
    total,

  vat_rate:
    vat.vat_rate,

  vat_gross:
    vat.vat_gross,

  vat_net:
    vat.vat_net,

  vat_amount:
    vat.vat_amount,

  selected_options:
  options.selected_options,

option_details:
  options.option_details,

options_display:
  optionsDisplay,

note:
    submitted.note
      ? String(
          submitted.note
        ).trim()
      : null,
};

}

async function buildCanonicalCart(
  db,
  restaurantId,
  items,
  {
    stockOverrideAuthorised = false,
  } = {}
) {

  if (!Array.isArray(items)) {
    throw new PricingError(
      "Cart must be an array"
    );
  }

  const cart = [];

  let subtotal = 0;

  for (const line of items) {

        const canonical =
      await buildCanonicalLine(
        db,
        restaurantId,
        line,
        {
          stockOverrideAuthorised,
        }
      );

    subtotal += canonical.total_price;

    cart.push(canonical);

  }

  return {

    items: cart,

    subtotal: roundMoney(subtotal),

    discount: 0,

    total: roundMoney(subtotal),

  };

}

/**
 * Return safe API error responses from PricingError.
 */
function sendPricingError(res, error) {
  if (error instanceof PricingError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      details: error.details || undefined,
    });
  }

  console.error(
    "❌ Unexpected authoritative pricing error:",
    error
  );

  return res.status(500).json({
    error: "Failed to calculate authoritative price",
    code: "PRICING_INTERNAL_ERROR",
  });
}

module.exports = {
  PricingError,

  positiveInteger,

  moneyToPennies,
  penniesToMoney,
  roundMoney,

  parseJson,
  parseOptionsSchema,

  canonicalMenuItemType,

  normalizeSubmittedOptions,
  getChoicePriceDelta,
  canonicalChoice,
  validateAndPriceOptions,
buildOptionDisplay,

  loadMeal,
  loadMenuItem,
  loadDrink,
  loadDessert,

  sendPricingError,
  resolveSubmittedItem,

buildCanonicalLine,

buildCanonicalCart,
};