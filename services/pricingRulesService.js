"use strict";

const {
  moneyToPennies,
  penniesToMoney,
} = require("./orderPricingService");

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;

  if (
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      return parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? parsed
        : fallback;
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function normalizeSurface(value) {
  const surface = String(value || "pos")
    .trim()
    .toLowerCase();

  if (surface === "qr") return "qr";
  if (surface === "kiosk") return "kiosk";

  return "pos";
}

function normalizeItemType(value) {
  const type = String(value || "")
    .trim()
    .toLowerCase();

  if (
    type === "meal" ||
    type === "meals"
  ) {
    return "meals";
  }

  if (
    type === "drink" ||
    type === "drinks"
  ) {
    return "drinks";
  }

  if (
    type === "dessert" ||
    type === "desserts"
  ) {
    return "desserts";
  }

  return type;
}

function ruleAllowsSurface(rule, surface) {
  const conditions = safeJson(
    rule?.conditions,
    {}
  );

  const surfaces = safeJson(
    conditions?.surfaces,
    {}
  );

  if (!Object.keys(surfaces).length) {
    return true;
  }

  const safeSurface =
    normalizeSurface(surface);

  return surfaces[safeSurface] !== false;
}

function canonicalLineKey(item, lineIndex) {
  return String(
    item?.line_id ||
      `${
        item?.source ||
        item?.item_type ||
        "item"
      }:${
        item?.meal_id ||
        item?.menu_item_id ||
        item?.item_id ||
        lineIndex
      }:${lineIndex}`
  );
}

function buildUnitInventory(items = []) {
  const units = [];

  items.forEach((item, lineIndex) => {
    const quantity = Math.max(
      1,
      Number.parseInt(
        item?.quantity,
        10
      ) || 1
    );

    const unitPricePennies =
      moneyToPennies(
        item?.unit_price || 0,
        "canonical unit price"
      );

    for (
      let unitIndex = 0;
      unitIndex < quantity;
      unitIndex += 1
    ) {
      units.push({
        unit_key:
          `${lineIndex}:${unitIndex}`,

        line_key:
          canonicalLineKey(
            item,
            lineIndex
          ),

        line_index: lineIndex,
        unit_index: unitIndex,

        item_id:
          Number(
            item?.item_id || 0
          ) || null,

        meal_id:
          Number(
            item?.meal_id || 0
          ) || null,

        menu_item_id:
          Number(
            item?.menu_item_id || 0
          ) || null,

        category_id:
          Number(
            item?.category_id || 0
          ) || null,

        item_type:
          normalizeItemType(
            item?.item_type
          ),

        unit_price_pennies:
          unitPricePennies,
      });
    }
  });

  return units;
}

function numberArray(value) {
  return Array.isArray(value)
    ? value
        .map(Number)
        .filter(
          (number) =>
            Number.isFinite(number) &&
            number > 0
        )
    : [];
}

function unitMatchesComponent(
  unit,
  component
) {
  const categoryIds = numberArray(
    component?.category_ids
  );

  const itemIds = numberArray(
    component?.item_ids
  );

  const directItemId = Number(
    component?.item_id ||
      component?.meal_id ||
      component?.menu_item_id ||
      0
  );

  if (
    Number.isFinite(directItemId) &&
    directItemId > 0
  ) {
    itemIds.push(directItemId);
  }

  const requiredType =
    normalizeItemType(
      component?.item_type
    );

  if (
    requiredType &&
    unit.item_type !== requiredType
  ) {
    return false;
  }

  if (
    categoryIds.length > 0 &&
    !categoryIds.includes(
      Number(unit.category_id || 0)
    )
  ) {
    return false;
  }

  if (
    itemIds.length > 0 &&
    !itemIds.includes(
      Number(unit.item_id || 0)
    ) &&
    !itemIds.includes(
      Number(unit.meal_id || 0)
    ) &&
    !itemIds.includes(
      Number(
        unit.menu_item_id || 0
      )
    )
  ) {
    return false;
  }

  return (
    categoryIds.length > 0 ||
    itemIds.length > 0
  );
}

function selectOneBundle({
  components,
  units,
  reservedUnits,
}) {
  const temporarilyReserved =
    new Set();

  const selectedUnits = [];

  for (const component of components) {
    const requiredQuantity =
      Math.max(
        1,
        Number.parseInt(
          component?.quantity,
          10
        ) || 1
      );

    const candidates = units
      .filter(
        (unit) =>
          !reservedUnits.has(
            unit.unit_key
          ) &&
          !temporarilyReserved.has(
            unit.unit_key
          ) &&
          unitMatchesComponent(
            unit,
            component
          )
      )
      .sort(
        (a, b) =>
          Number(
            a.unit_price_pennies || 0
          ) -
          Number(
            b.unit_price_pennies || 0
          )
      );

    if (
      candidates.length <
      requiredQuantity
    ) {
      return null;
    }

    const selected =
      candidates.slice(
        0,
        requiredQuantity
      );

    for (const unit of selected) {
      temporarilyReserved.add(
        unit.unit_key
      );

      selectedUnits.push(unit);
    }
  }

  return selectedUnits;
}

function applyFixedBundleRule({
  rule,
  units,
  reservedUnits,
}) {
  const conditions = safeJson(
    rule?.conditions,
    {}
  );

  const actions = safeJson(
    rule?.actions,
    {}
  );

  const components = Array.isArray(
    conditions?.components
  )
    ? conditions.components
    : [];

  const bundlePricePennies =
    moneyToPennies(
      actions?.bundle_price || 0,
      "bundle price"
    );

  if (
    components.length === 0 ||
    bundlePricePennies <= 0
  ) {
    return null;
  }

  const applications = [];

  while (true) {
    const selectedUnits =
      selectOneBundle({
        components,
        units,
        reservedUnits,
      });

    if (
      !selectedUnits ||
      selectedUnits.length === 0
    ) {
      break;
    }

    const originalPennies =
      selectedUnits.reduce(
        (sum, unit) =>
          sum +
          Number(
            unit.unit_price_pennies ||
              0
          ),
        0
      );

    if (
      originalPennies <=
      bundlePricePennies
    ) {
      break;
    }

    for (const unit of selectedUnits) {
      reservedUnits.add(
        unit.unit_key
      );
    }

    applications.push({
      original_pennies:
        originalPennies,

      final_pennies:
        bundlePricePennies,

      discount_pennies:
        originalPennies -
        bundlePricePennies,

      selected_units:
        selectedUnits,
    });
  }

  if (applications.length === 0) {
    return null;
  }

  const originalPennies =
    applications.reduce(
      (sum, application) =>
        sum +
        application.original_pennies,
      0
    );

  const finalPennies =
    applications.reduce(
      (sum, application) =>
        sum +
        application.final_pennies,
      0
    );

  const discountPennies =
    applications.reduce(
      (sum, application) =>
        sum +
        application.discount_pennies,
      0
    );

  const matchedLines = [
    ...new Set(
      applications.flatMap(
        (application) =>
          application.selected_units.map(
            (unit) => unit.line_key
          )
      )
    ),
  ];

  return {
    rule_id:
      Number(rule?.id || 0) || null,

    name:
      String(rule?.name || ""),

    rule_type:
      String(
        rule?.rule_type ||
        "fixed_bundle"
      ),

    applications:
      applications.length,

    original_total:
      penniesToMoney(
        originalPennies
      ),

    final_total:
      penniesToMoney(
        finalPennies
      ),

    discount_amount:
      penniesToMoney(
        discountPennies
      ),

    matched_lines:
      matchedLines,
  };
}

async function loadActivePricingRules(
  db,
  restaurantId
) {
  const rid =
    Number(restaurantId || 0);

  if (!rid) {
    throw new Error(
      "Missing restaurant ID"
    );
  }

  return db.qAll(
    `
    SELECT *
    FROM public.pricing_rules
    WHERE restaurant_id = $1
      AND active = TRUE
      AND (
        starts_at IS NULL
        OR NOW() >= starts_at
      )
      AND (
        ends_at IS NULL
        OR NOW() <= ends_at
      )
    ORDER BY priority DESC, id DESC
    `,
    [rid]
  );
}

function applyPricingRules({
  canonicalCart,
  rules,
  surface = "pos",
}) {
  const items = Array.isArray(
    canonicalCart?.items
  )
    ? canonicalCart.items
    : [];

  const subtotalPennies =
    moneyToPennies(
      canonicalCart?.subtotal || 0,
      "canonical subtotal"
    );

  const units =
    buildUnitInventory(items);

  // A physical item unit can only be used
  // by one rule.
  const reservedUnits =
    new Set();

  const appliedRules = [];

  let discountPennies = 0;

  const eligibleRules = (
    Array.isArray(rules)
      ? rules
      : []
  )
    .filter(
      (rule) =>
        rule?.active !== false &&
        ruleAllowsSurface(
          rule,
          surface
        )
    )
    .sort(
      (a, b) =>
        Number(
          b?.priority || 0
        ) -
          Number(
            a?.priority || 0
          ) ||
        Number(b?.id || 0) -
          Number(a?.id || 0)
    );

  for (const rule of eligibleRules) {
    const ruleType = String(
      rule?.rule_type || ""
    )
      .trim()
      .toLowerCase();

    let result = null;

    if (
      ruleType ===
        "fixed_bundle" ||
      ruleType === "mix_match"
    ) {
      result =
        applyFixedBundleRule({
          rule,
          units,
          reservedUnits,
        });
    }

    if (!result) continue;

    const ruleDiscountPennies =
      moneyToPennies(
        result.discount_amount,
        "rule discount"
      );

    if (
      ruleDiscountPennies <= 0
    ) {
      continue;
    }

    discountPennies +=
      ruleDiscountPennies;

    appliedRules.push(result);
  }

  const safeDiscountPennies =
    Math.min(
      subtotalPennies,
      discountPennies
    );

  const totalPennies =
    Math.max(
      0,
      subtotalPennies -
        safeDiscountPennies
    );

  return {
    items,

    subtotal:
      penniesToMoney(
        subtotalPennies
      ),

    discount:
      penniesToMoney(
        safeDiscountPennies
      ),

    pricing_discount:
      penniesToMoney(
        safeDiscountPennies
      ),

    total:
      penniesToMoney(
        totalPennies
      ),

    applied_rules:
      appliedRules,
  };
}

async function buildAuthoritativeQuote({
  db,
  restaurantId,
  canonicalCart,
  surface = "pos",
}) {
  const rules =
    await loadActivePricingRules(
      db,
      restaurantId
    );

  return applyPricingRules({
    canonicalCart,
    rules,
    surface,
  });
}

module.exports = {
  safeJson,
  normalizeSurface,
  normalizeItemType,
  ruleAllowsSurface,
  buildUnitInventory,
  unitMatchesComponent,
  applyFixedBundleRule,
  loadActivePricingRules,
  applyPricingRules,
  buildAuthoritativeQuote,
};