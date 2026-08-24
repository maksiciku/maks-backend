// backend/services/itemsSettingsService.js

const {
  getMealPortionsLeft,
} = require("../utils/novaDeduct");


/* =========================================================
   ITEMS SETTINGS — AUTHORITATIVE AVAILABILITY SERVICE

   PURPOSE

   This service decides whether a sellable menu item can
   currently be ordered.

   Supported item types:
   - meal
   - drink
   - dessert

   Availability modes:
   - maks
       Availability calculated from linked ingredients.

   - manual
       Availability controlled by manual_quantity.

   - unlimited
       Quantity never blocks the sale.

   IMPORTANT:
   manually_stopped ALWAYS overrides every availability mode.

   Legacy:
   out_of_stock is still respected temporarily while MAKS
   migrates existing POS / Kiosk / QR behaviour.

   Stock deduction is NOT performed here.

   Stock deduction remains a separate commercial concern
   handled by novaDeduct / order lifecycle.
========================================================= */


/* =========================================================
   BASIC HELPERS
========================================================= */

function toNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}


function normalizeItemType(type) {
  const value = String(
    type || ""
  )
    .trim()
    .toLowerCase();

  if (
    value === "meal" ||
    value === "meals"
  ) {
    return "meal";
  }

  if (
    value === "drink" ||
    value === "drinks"
  ) {
    return "drink";
  }

  if (
    value === "dessert" ||
    value === "desserts"
  ) {
    return "dessert";
  }

  return null;
}


function normalizeAvailabilityMode(mode) {
  const value = String(
    mode || "maks"
  )
    .trim()
    .toLowerCase();

  if (
    value === "maks" ||
    value === "manual" ||
    value === "unlimited"
  ) {
    return value;
  }

  return "maks";
}


function normalizeRequestedQuantity(value) {
  const quantity = Number(value);

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return 1;
  }

  return Math.max(
    1,
    Math.floor(quantity)
  );
}


/* =========================================================
   LOAD AUTHORITATIVE ITEM

   Browser data is NOT trusted.

   Meals:
       public.meals

   Drinks / Desserts:
       public.menu_items
========================================================= */

async function loadItem(
  db,
  restaurantId,
  itemType,
  itemId
) {
  const rid =
    Number(restaurantId);

  const id =
    Number(itemId);

  const type =
    normalizeItemType(itemType);

  if (
    !Number.isFinite(rid) ||
    rid <= 0
  ) {
    throw Object.assign(
      new Error(
        "Invalid restaurant id"
      ),
      {
        status: 400,
        code:
          "INVALID_RESTAURANT_ID",
      }
    );
  }

  if (
    !Number.isFinite(id) ||
    id <= 0
  ) {
    throw Object.assign(
      new Error(
        "Invalid item id"
      ),
      {
        status: 400,
        code:
          "INVALID_ITEM_ID",
      }
    );
  }

  if (!type) {
    throw Object.assign(
      new Error(
        "Unsupported item type"
      ),
      {
        status: 400,
        code:
          "INVALID_ITEM_TYPE",
      }
    );
  }


  /* -------------------------
     MEAL
  ------------------------- */

  if (type === "meal") {
    const row =
      await db.qGet(
        `
        SELECT
          id,
          restaurant_id,
          name,
          availability_mode,
          manual_quantity,
          manually_stopped,
          out_of_stock
        FROM public.meals
        WHERE restaurant_id = ?
          AND id = ?
        LIMIT 1
        `,
        [
          rid,
          id,
        ]
      );

    if (!row?.id) {
      return null;
    }

    return {
      ...row,

      item_type:
        "meal",
    };
  }


  /* -------------------------
     DRINK / DESSERT
  ------------------------- */

  const row =
    await db.qGet(
      `
      SELECT
        id,
        restaurant_id,
        name,
        type,
        availability_mode,
        manual_quantity,
        manually_stopped,
        out_of_stock
      FROM public.menu_items
      WHERE restaurant_id = ?
        AND id = ?
        AND LOWER(TRIM(type)) = ?
      LIMIT 1
      `,
      [
        rid,
        id,
        type,
      ]
    );

  if (!row?.id) {
    return null;
  }

  return {
    ...row,

    item_type:
      type,
  };
}


/* =========================================================
   MENU ITEM PORTION CALCULATION

   Drinks + Desserts use:

       public.menu_item_ingredients

   We calculate how many complete items can be made from
   available stock.

   Example:

       Gin:
         25ml gin required
         stock = 500ml
         possible = 20

       Lime:
         1 pc required
         stock = 8
         possible = 8

       MAKS availability = 8

   This mirrors the existing Meal calculation philosophy
   already used by getMealPortionsLeft().
========================================================= */

async function getMenuItemPortionsLeft(
  db,
  menuItemId,
  restaurantId
) {
  const id =
    Number(menuItemId);

  const rid =
    Number(restaurantId);

  if (
    !Number.isFinite(id) ||
    id <= 0 ||
    !Number.isFinite(rid) ||
    rid <= 0
  ) {
    return null;
  }


  const recipeRows =
    await db.qAll(
      `
      SELECT
        mii.stock_id,
        mii.ingredient,
        COALESCE(
          mii.amount,
          0
        ) AS amount,
        COALESCE(
          mii.unit,
          'unit'
        ) AS unit
      FROM public.menu_item_ingredients mii
      WHERE mii.restaurant_id = ?
        AND mii.menu_item_id = ?
      `,
      [
        rid,
        id,
      ]
    );


  /*
   * No recipe means MAKS cannot calculate availability.
   *
   * IMPORTANT:
   * null means UNKNOWN, not zero.
   *
   * We deliberately do NOT block the sale just because
   * somebody has not configured a recipe.
   */
  if (
    !Array.isArray(
      recipeRows
    ) ||
    !recipeRows.length
  ) {
    return null;
  }


  let minimumPortions =
    Infinity;

  let usableRecipeLines =
    0;


  for (
    const recipe
    of recipeRows
  ) {
    const stockId =
      Number(
        recipe.stock_id ||
        0
      ) || null;

    const ingredientName =
      String(
        recipe.ingredient ||
        ""
      ).trim();

    const amountPerItem =
      Number(
        recipe.amount ||
        0
      );


    /*
     * Invalid/empty recipe lines should not
     * accidentally block an item.
     */
    if (
      amountPerItem <= 0 ||
      !Number.isFinite(
        amountPerItem
      )
    ) {
      continue;
    }

    usableRecipeLines += 1;


    let stockRow = null;


    /* -------------------------
       Prefer stock.id
    ------------------------- */

    if (stockId) {
      stockRow =
        await db.qGet(
          `
          SELECT
            id,
            ingredient,
            quantity,
            unit
          FROM public.stock
          WHERE restaurant_id = ?
            AND id = ?
          LIMIT 1
          `,
          [
            rid,
            stockId,
          ]
        );
    }


    /* -------------------------
       Name fallback
    ------------------------- */

    if (
      !stockRow &&
      ingredientName
    ) {
      stockRow =
        await db.qGet(
          `
          SELECT
            id,
            ingredient,
            quantity,
            unit
          FROM public.stock
          WHERE restaurant_id = ?
            AND LOWER(
              TRIM(
                ingredient
              )
            ) = LOWER(
              TRIM(?)
            )
          LIMIT 1
          `,
          [
            rid,
            ingredientName,
          ]
        );
    }


    /*
     * Recipe expects stock but the stock record
     * no longer exists.
     *
     * In MAKS Calculation mode this means zero
     * complete portions can safely be guaranteed.
     */
    if (!stockRow) {
      minimumPortions = 0;
      continue;
    }


    const stockQuantity =
      toNumber(
        stockRow.quantity,
        0
      );


    /*
     * IMPORTANT:
     *
     * Existing MAKS recipe/deduction logic currently
     * treats stock quantity and recipe amount as being
     * expressed in compatible units.
     *
     * We intentionally preserve that behaviour here.
     *
     * Unit-conversion authority should be hardened
     * separately rather than silently changing stock
     * semantics inside this availability service.
     */
    const possible =
      Math.floor(
        stockQuantity /
          amountPerItem
      );


    if (
      possible <
      minimumPortions
    ) {
      minimumPortions =
        possible;
    }
  }


  if (
    usableRecipeLines === 0 ||
    minimumPortions ===
      Infinity
  ) {
    return null;
  }


  return Math.max(
    0,
    minimumPortions
  );
}


/* =========================================================
   MAKS CALCULATION

   Meals:
       getMealPortionsLeft()

   Drinks / Desserts:
       getMenuItemPortionsLeft()
========================================================= */

async function calculateMaksAvailability(
  db,
  restaurantId,
  itemType,
  itemId
) {
  const type =
    normalizeItemType(
      itemType
    );


  if (type === "meal") {
    return getMealPortionsLeft(
      db,
      itemId,
      restaurantId
    );
  }


  if (
    type === "drink" ||
    type === "dessert"
  ) {
    return getMenuItemPortionsLeft(
      db,
      itemId,
      restaurantId
    );
  }


  return null;
}


/* =========================================================
   MAIN AVAILABILITY AUTHORITY

   RETURN CONTRACT

   {
      item_id,
      item_type,
      name,

      availability_mode,

      can_sell,

      available_quantity,

      requested_quantity,

      manually_stopped,

      reason,

      source
   }

========================================================= */

async function getItemAvailability({
  db,
  restaurantId,
  itemType,
  itemId,
  quantity = 1,
}) {
  if (!db) {
    throw new Error(
      "itemsSettingsService requires db/transaction"
    );
  }


  const type =
    normalizeItemType(
      itemType
    );

  const requestedQuantity =
    normalizeRequestedQuantity(
      quantity
    );


  const item =
    await loadItem(
      db,
      restaurantId,
      type,
      itemId
    );


  if (!item) {
    return {
      item_id:
        Number(itemId) || null,

      item_type:
        type,

      name:
        null,

      availability_mode:
        null,

      can_sell:
        false,

      available_quantity:
        0,

      requested_quantity:
        requestedQuantity,

      manually_stopped:
        false,

      reason:
        "ITEM_NOT_FOUND",

      source:
        "database",
    };
  }


  const mode =
    normalizeAvailabilityMode(
      item.availability_mode
    );


  const manuallyStopped =
    item.manually_stopped ===
      true ||
    item.manually_stopped ===
      1 ||
    item.manually_stopped ===
      "true";


  const legacyOutOfStock =
    item.out_of_stock ===
      true ||
    item.out_of_stock ===
      1 ||
    item.out_of_stock ===
      "true";


  /* =======================================================
     RULE #1
     MANUAL STOP ALWAYS WINS
  ======================================================= */

  if (manuallyStopped) {
    return {
      item_id:
        Number(item.id),

      item_type:
        type,

      name:
        item.name,

      availability_mode:
        mode,

      can_sell:
        false,

      available_quantity:
        0,

      requested_quantity:
        requestedQuantity,

      manually_stopped:
        true,

      reason:
        "MANUALLY_STOPPED",

      source:
        "manual",
    };
  }


  /* =======================================================
     LEGACY OUT_OF_STOCK

     TEMPORARY COMPATIBILITY BRIDGE.

     We keep respecting the current field while POS/Kiosk/QR
     are migrated to manually_stopped.

     Later we can remove this branch once all old callers
     have been migrated.
  ======================================================= */

  if (legacyOutOfStock) {
    return {
      item_id:
        Number(item.id),

      item_type:
        type,

      name:
        item.name,

      availability_mode:
        mode,

      can_sell:
        false,

      available_quantity:
        0,

      requested_quantity:
        requestedQuantity,

      manually_stopped:
        false,

      reason:
        "LEGACY_OUT_OF_STOCK",

      source:
        "legacy",
    };
  }


  /* =======================================================
     RULE #2
     UNLIMITED

     Quantities NEVER block the sale.

     Manual Stop Selling still works because it was checked
     above.
  ======================================================= */

  if (
    mode === "unlimited"
  ) {
    return {
      item_id:
        Number(item.id),

      item_type:
        type,

      name:
        item.name,

      availability_mode:
        "unlimited",

      can_sell:
        true,

      available_quantity:
        null,

      requested_quantity:
        requestedQuantity,

      manually_stopped:
        false,

      reason:
        null,

      source:
        "unlimited",
    };
  }


  /* =======================================================
     RULE #3
     MANUAL QUANTITY
  ======================================================= */

  if (
    mode === "manual"
  ) {
    const hasQuantity =
      item.manual_quantity !==
        null &&
      item.manual_quantity !==
        undefined &&
      item.manual_quantity !==
        "";


    /*
     * Manual mode selected without a quantity configured.
     *
     * We fail closed because the owner explicitly selected
     * Manual Quantity mode.
     */
    if (!hasQuantity) {
      return {
        item_id:
          Number(item.id),

        item_type:
          type,

        name:
          item.name,

        availability_mode:
          "manual",

        can_sell:
          false,

        available_quantity:
          0,

        requested_quantity:
          requestedQuantity,

        manually_stopped:
          false,

        reason:
          "MANUAL_QUANTITY_NOT_SET",

        source:
          "manual",
      };
    }


    const available =
      Math.max(
        0,
        Math.floor(
          toNumber(
            item.manual_quantity,
            0
          )
        )
      );


    return {
      item_id:
        Number(item.id),

      item_type:
        type,

      name:
        item.name,

      availability_mode:
        "manual",

      can_sell:
        available >=
        requestedQuantity,

      available_quantity:
        available,

      requested_quantity:
        requestedQuantity,

      manually_stopped:
        false,

      reason:
        available >=
        requestedQuantity
          ? null
          : "MANUAL_QUANTITY_EXHAUSTED",

      source:
        "manual",
    };
  }


  /* =======================================================
     RULE #4
     MAKS CALCULATION
  ======================================================= */

  const calculated =
    await calculateMaksAvailability(
      db,
      restaurantId,
      type,
      item.id
    );


  /*
   * No recipe = unknown availability.
   *
   * Do NOT convert unknown to zero.
   *
   * This preserves existing MAKS behaviour and prevents
   * a restaurant from accidentally losing its whole menu
   * just because recipes have not yet been configured.
   */
  if (
    calculated === null ||
    calculated === undefined
  ) {
    return {
      item_id:
        Number(item.id),

      item_type:
        type,

      name:
        item.name,

      availability_mode:
        "maks",

      can_sell:
        true,

      available_quantity:
        null,

      requested_quantity:
        requestedQuantity,

      manually_stopped:
        false,

      reason:
        null,

      source:
        "maks_no_recipe",
    };
  }


  const available =
    Math.max(
      0,
      Math.floor(
        Number(
          calculated
        ) || 0
      )
    );


  return {
    item_id:
      Number(item.id),

    item_type:
      type,

    name:
      item.name,

    availability_mode:
      "maks",

    can_sell:
      available >=
      requestedQuantity,

    available_quantity:
      available,

    requested_quantity:
      requestedQuantity,

    manually_stopped:
      false,

    reason:
      available >=
      requestedQuantity
        ? null
        : "INSUFFICIENT_STOCK",

    source:
      "maks",
  };
}


/* =========================================================
   ASSERT ORDERABLE

   Convenience helper for backend order routes.

   Throws a controlled 409 if the item cannot currently
   be sold.

   IMPORTANT:
   POS manager stock override is NOT handled here yet.

   We will wire override permissions deliberately when
   replacing the existing POS assertItemsOrderable logic.
========================================================= */

async function assertItemOrderable({
  db,
  restaurantId,
  itemType,
  itemId,
  quantity = 1,
}) {
  const availability =
    await getItemAvailability({
      db,
      restaurantId,
      itemType,
      itemId,
      quantity,
    });


  if (
    availability.can_sell
  ) {
    return availability;
  }


  const message = (() => {
    switch (
      availability.reason
    ) {
      case "MANUALLY_STOPPED":
        return `${availability.name || "Item"} is currently stopped from selling.`;

      case "LEGACY_OUT_OF_STOCK":
        return `${availability.name || "Item"} is currently marked out of stock.`;

      case "MANUAL_QUANTITY_NOT_SET":
        return `${availability.name || "Item"} is using manual availability but no quantity has been set.`;

      case "MANUAL_QUANTITY_EXHAUSTED":
        return `${availability.name || "Item"} does not have enough manual quantity available.`;

      case "INSUFFICIENT_STOCK":
        return `${availability.name || "Item"} does not have enough stock available.`;

      case "ITEM_NOT_FOUND":
        return "Menu item was not found.";

      default:
        return `${availability.name || "Item"} is not currently available.`;
    }
  })();


  const error =
    new Error(message);

  error.status = 409;

  error.code =
    "ITEM_NOT_ORDERABLE";

  error.availability =
    availability;

  throw error;
}

// =========================================================
// COMMERCIAL ITEM AVAILABILITY RESERVATIONS
// PostgreSQL authoritative
// =========================================================

class ItemAvailabilityError extends Error {
  constructor(
    message,
    {
      code = "ITEM_AVAILABILITY_BLOCKED",
      status = 409,
      itemType = null,
      itemId = null,
      available = null,
      requested = null,
    } = {}
  ) {
    super(message);

    this.name = "ItemAvailabilityError";
    this.code = code;
    this.status = status;

    this.itemType = itemType;
    this.itemId = itemId;
    this.available = available;
    this.requested = requested;
  }
}


function normalizeReservationItemType(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();

  if (
    s === "meal" ||
    s === "meals"
  ) {
    return "meal";
  }

  if (
    s === "drink" ||
    s === "drinks"
  ) {
    return "drink";
  }

  if (
    s === "dessert" ||
    s === "desserts"
  ) {
    return "dessert";
  }

  return null;
}


function getOrderItemIdentity(item = {}) {
  const explicitType =
    normalizeReservationItemType(
      item.item_type ||
      item.category ||
      item.source ||
      item.item_source
    );

  const mealId =
    Number(
      item.meal_id ??
      item.mealId ??
      0
    );

  if (
    mealId > 0 &&
    (
      explicitType === "meal" ||
      !explicitType
    )
  ) {
    return {
      itemType: "meal",
      itemId: mealId,
    };
  }

  const menuItemId =
    Number(
      item.menu_item_id ??
      item.menuItemId ??
      item.item_id ??
      0
    );

  if (
    menuItemId > 0 &&
    (
      explicitType === "drink" ||
      explicitType === "dessert"
    )
  ) {
    return {
      itemType: explicitType,
      itemId: menuItemId,
    };
  }

  return {
    itemType: null,
    itemId: null,
  };
}

function aggregateAvailabilityItems(
  items = []
) {
  const grouped =
    new Map();


  for (
    const item of
      items || []
  ) {
    const {
      itemType,
      itemId,
    } =
      getOrderItemIdentity(
        item
      );


    // Misc/custom POS items do not participate
    // in Items Settings availability.
    if (
      !itemType ||
      !itemId
    ) {
      continue;
    }


    const qty =
      Number(
        item.quantity ||
          1
      );


    if (
      !Number.isFinite(
        qty
      ) ||
      qty <= 0 ||
      !Number.isInteger(
        qty
      )
    ) {
      throw new ItemAvailabilityError(
        "Invalid item quantity.",
        {
          code:
            "INVALID_ITEM_QUANTITY",

          status: 400,

          itemType,
          itemId,

          requested:
            qty,
        }
      );
    }


    const overrideRequested =
      item?.stock_override ===
        true ||
      item?.stock_override ===
        "true" ||
      item?.allow_stock_override ===
        true ||
      item?.allow_stock_override ===
        "true";


    const key =
      `${itemType}:${itemId}`;


    if (
      !grouped.has(key)
    ) {
      grouped.set(
        key,
        {
          itemType,
          itemId,

          quantity: 0,

          itemName:
            String(
              item.name ||
                item.meal_name ||
                item.item_name ||
                ""
            ).trim(),

          overrideRequested:
            false,

          overrideReason:
            null,
        }
      );
    }


    const row =
      grouped.get(key);


    row.quantity +=
      qty;


    /*
     * If this particular item was explicitly approved
     * for override, preserve that decision.
     */
    if (
      overrideRequested
    ) {
      row.overrideRequested =
        true;

      row.overrideReason =
        String(
          item.stock_override_reason ||
            "staff_availability_override"
        ).trim();
    }
  }


  return Array.from(
    grouped.values()
  );
}

async function loadAvailabilityItemForUpdate({
  db,
  restaurantId,
  itemType,
  itemId,
}) {
  if (
    !db ||
    db.kind !== "pg"
  ) {
    throw new Error(
      "Commercial item availability requires PostgreSQL."
    );
  }

  if (
    itemType === "meal"
  ) {
    return db.qGet(
      `
      SELECT
        id,
        name,
        availability_mode,
        manual_quantity,
        manually_stopped,
        out_of_stock

      FROM public.meals

      WHERE restaurant_id = $1
        AND id = $2

      FOR UPDATE
      `,
      [
        restaurantId,
        itemId,
      ]
    );
  }


  return db.qGet(
    `
    SELECT
      id,
      name,
      type,
      availability_mode,
      manual_quantity,
      manually_stopped,
      out_of_stock

    FROM public.menu_items

    WHERE restaurant_id = $1
      AND id = $2
      AND LOWER(
        TRIM(
          COALESCE(
            type,
            ''
          )
        )
      ) = $3

    FOR UPDATE
    `,
    [
      restaurantId,
      itemId,
      itemType,
    ]
  );
}


async function findExistingAvailabilityReservation({
  db,
  restaurantId,
  batchId,
  itemType,
  itemId,
}) {
  return db.qGet(
    `
    SELECT
      id,
      quantity,
      status,
      availability_mode

    FROM public.item_availability_reservations

    WHERE restaurant_id = $1
      AND batch_id = $2::uuid
      AND item_type = $3
      AND item_id = $4

    FOR UPDATE
    `,
    [
      restaurantId,
      batchId,
      itemType,
      itemId,
    ]
  );
}

async function insertAvailabilityReservation({
  db,
  restaurantId,
  batchId,

  itemType,
  itemId,
  itemName,

  availabilityMode,
  quantity,

  status,
  source,

  overrideUsed = false,
  overrideReason = null,
  overrideUserId = null,
}) {
  return db.qGet(
    `
    INSERT INTO public.item_availability_reservations (
      restaurant_id,
      batch_id,

      item_type,
      item_id,
      item_name,

      availability_mode,
      quantity,

      status,
      source,

      override_used,
      override_reason,
      override_user_id,

      consumed_at
    )
    VALUES (
      $1,
      $2::uuid,

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

      CASE
        WHEN $8 = 'consumed'
          THEN NOW()
        ELSE NULL
      END
    )

    RETURNING *
    `,
    [
      restaurantId,
      batchId,

      itemType,
      itemId,
      itemName,

      availabilityMode,
      quantity,

      status,
      source,

      !!overrideUsed,

      overrideReason ||
        null,

      overrideUserId
        ? Number(
            overrideUserId
          )
        : null,
    ]
  );
}

async function reserveSingleItemAvailability({
  db,
  restaurantId,
  batchId,

  itemType,
  itemId,

  quantity,
  itemName = "",

  source = "pos",

  holdUntilPaid = false,

  overrideRequested = false,
  overrideReason = null,
  overrideUserId = null,
}) {
  const existing =
    await findExistingAvailabilityReservation({
      db,
      restaurantId,
      batchId,
      itemType,
      itemId,
    });


  // =====================================================
  // IDEMPOTENCY
  // =====================================================

  if (
    existing &&
    existing.status !==
      "released"
  ) {
    if (
      Number(
        existing.quantity
      ) !==
      Number(quantity)
    ) {
      throw new ItemAvailabilityError(
        "This order batch was already reserved with a different quantity.",
        {
          code:
            "AVAILABILITY_RESERVATION_CONFLICT",

          itemType,
          itemId,

          requested:
            quantity,
        }
      );
    }


    return {
      reused: true,

      reservationId:
        Number(
          existing.id
        ),

      itemType,
      itemId,

      quantity:
        Number(
          existing.quantity
        ),

      mode:
        existing.availability_mode,

      status:
        existing.status,
    };
  }


  const row =
    await loadAvailabilityItemForUpdate({
      db,
      restaurantId,
      itemType,
      itemId,
    });


  if (!row?.id) {
    throw new ItemAvailabilityError(
      "Menu item not found.",
      {
        code:
          "ITEM_NOT_FOUND",

        status: 404,

        itemType,
        itemId,
      }
    );
  }


  const mode =
    normalizeAvailabilityMode(
      row.availability_mode
    );


  /*
   * Customer surfaces NEVER receive human override.
   *
   * Even if a malicious QR/Kiosk request sends
   * stock_override=true, it is ignored here.
   */
  const overrideAllowed =
    source === "pos" &&
    overrideRequested ===
      true;


  const manuallyStopped =
    row.manually_stopped ===
      true;


  const legacyStopped =
    row.out_of_stock ===
      true;


  const stopped =
    manuallyStopped ||
    legacyStopped;


  // =====================================================
  // STOP SELLING
  // =====================================================

  if (
    stopped &&
    !overrideAllowed
  ) {
    throw new ItemAvailabilityError(
      `${row.name} has been stopped from selling.`,
      {
        code:
          "ITEM_MANUALLY_STOPPED",

        itemType,
        itemId,

        available: 0,

        requested:
          quantity,
      }
    );
  }


  const reservationStatus =
    holdUntilPaid
      ? "reserved"
      : "consumed";


  // =====================================================
  // UNLIMITED
  // =====================================================

  if (
    mode ===
    "unlimited"
  ) {
    const overrideUsed =
      stopped &&
      overrideAllowed;


    const reservation =
      await insertAvailabilityReservation({
        db,
        restaurantId,
        batchId,

        itemType,
        itemId,

        itemName:
          row.name ||
          itemName,

        availabilityMode:
          mode,

        quantity,

        status:
          reservationStatus,

        source,

        overrideUsed,

        overrideReason:
          overrideUsed
            ? overrideReason ||
              "staff_availability_override"
            : null,

        overrideUserId:
          overrideUsed
            ? overrideUserId
            : null,
      });


    return {
      reused: false,

      reservationId:
        Number(
          reservation.id
        ),

      itemType,
      itemId,

      itemName:
        row.name,

      quantity,

      mode,

      status:
        reservationStatus,

      overrideUsed,

      availableAfter:
        null,
    };
  }


  // =====================================================
  // MANUAL QUANTITY
  // =====================================================

  if (
    mode ===
    "manual"
  ) {
    const before =
      Math.max(
        0,
        Number(
          row.manual_quantity ||
            0
        )
      );


    const insufficient =
      before <
      quantity;


    const overrideNeeded =
      stopped ||
      insufficient;


    if (
      overrideNeeded &&
      !overrideAllowed
    ) {
      throw new ItemAvailabilityError(
        `${row.name} only has ${before} available.`,
        {
          code:
            "INSUFFICIENT_MANUAL_QUANTITY",

          itemType,
          itemId,

          available:
            before,

          requested:
            quantity,
        }
      );
    }


    const table =
      itemType ===
      "meal"
        ? "meals"
        : "menu_items";


    let updated;


    /*
     * Normal sale:
     * must have enough quantity.
     */
    if (
      !overrideNeeded
    ) {
      updated =
        await db.qGet(
          `
          UPDATE public.${table}

          SET manual_quantity =
            manual_quantity - $1

          WHERE restaurant_id = $2
            AND id = $3
            AND availability_mode = 'manual'
            AND manually_stopped = FALSE
            AND manual_quantity >= $1

          RETURNING
            id,
            name,
            manual_quantity
          `,
          [
            quantity,
            restaurantId,
            itemId,
          ]
        );


      if (!updated?.id) {
        throw new ItemAvailabilityError(
          `${row.name} is no longer available in the requested quantity.`,
          {
            code:
              "MANUAL_QUANTITY_RACE_LOST",

            itemType,
            itemId,

            requested:
              quantity,
          }
        );
      }
    } else {
      /*
       * HUMAN OVERRIDE
       *
       * Never allow quantity to become negative.
       *
       * Examples:
       *
       * 0 available, sell 1
       * → stays 0
       *
       * 3 available, sell 5
       * → becomes 0
       */
      updated =
        await db.qGet(
          `
          UPDATE public.${table}

          SET manual_quantity =
            GREATEST(
              COALESCE(
                manual_quantity,
                0
              ) - $1,
              0
            )

          WHERE restaurant_id = $2
            AND id = $3
            AND availability_mode = 'manual'

          RETURNING
            id,
            name,
            manual_quantity
          `,
          [
            quantity,
            restaurantId,
            itemId,
          ]
        );


      if (!updated?.id) {
        throw new ItemAvailabilityError(
          `${row.name} could not be overridden.`,
          {
            code:
              "MANUAL_OVERRIDE_FAILED",

            itemType,
            itemId,

            requested:
              quantity,
          }
        );
      }
    }


    const reservation =
      await insertAvailabilityReservation({
        db,
        restaurantId,
        batchId,

        itemType,
        itemId,

        itemName:
          row.name,

        availabilityMode:
          mode,

        quantity,

        status:
          reservationStatus,

        source,

        overrideUsed:
          overrideNeeded,

        overrideReason:
          overrideNeeded
            ? overrideReason ||
              "staff_availability_override"
            : null,

        overrideUserId:
          overrideNeeded
            ? overrideUserId
            : null,
      });


    return {
      reused: false,

      reservationId:
        Number(
          reservation.id
        ),

      itemType,
      itemId,

      itemName:
        row.name,

      quantity,

      mode,

      status:
        reservationStatus,

      overrideUsed:
        overrideNeeded,

      availableBefore:
        before,

      availableAfter:
        Number(
          updated.manual_quantity
        ),
    };
  }


  // =====================================================
  // MAKS CALCULATION
  // =====================================================

  const availability =
    await getItemAvailability({
      db,

      restaurantId,

      itemType,
      itemId,

      quantity,
    });


  const insufficient =
    !availability?.can_sell;


  const overrideNeeded =
    stopped ||
    insufficient;


  if (
    overrideNeeded &&
    !overrideAllowed
  ) {
    throw new ItemAvailabilityError(
      `${row.name} does not have enough availability.`,
      {
        code:
          "INSUFFICIENT_MAKS_AVAILABILITY",

        itemType,
        itemId,

        available:
          availability
            ?.available_quantity ??
          0,

        requested:
          quantity,
      }
    );
  }


  const reservation =
    await insertAvailabilityReservation({
      db,
      restaurantId,
      batchId,

      itemType,
      itemId,

      itemName:
        row.name,

      availabilityMode:
        "maks",

      quantity,

      status:
        reservationStatus,

      source,

      overrideUsed:
        overrideNeeded,

      overrideReason:
        overrideNeeded
          ? overrideReason ||
            "staff_availability_override"
          : null,

      overrideUserId:
        overrideNeeded
          ? overrideUserId
          : null,
    });


  return {
    reused: false,

    reservationId:
      Number(
        reservation.id
      ),

    itemType,
    itemId,

    itemName:
      row.name,

    quantity,

    mode:
      "maks",

    status:
      reservationStatus,

    overrideUsed:
      overrideNeeded,

    availableBefore:
      availability
        ?.available_quantity ??
      null,
  };
}

async function reserveItemsAvailability({
  db,
  restaurantId,
  batchId,

  items = [],

  source = "pos",

  holdUntilPaid = false,

  actorUserId = null,
}) {
  if (
    !db ||
    db.kind !== "pg"
  ) {
    throw new Error(
      "Item availability reservation requires PostgreSQL."
    );
  }


  if (
    !restaurantId
  ) {
    throw new Error(
      "restaurantId is required."
    );
  }


  if (!batchId) {
    throw new Error(
      "batchId is required."
    );
  }


  const aggregated =
    aggregateAvailabilityItems(
      items
    );


  /*
   * Deterministic lock order reduces deadlock risk
   * across multiple POS terminals.
   */
  aggregated.sort(
    (a, b) => {
      const aKey =
        `${a.itemType}:${a.itemId}`;

      const bKey =
        `${b.itemType}:${b.itemId}`;

      return aKey.localeCompare(
        bKey
      );
    }
  );


  const reservations =
    [];


  for (
    const item of
      aggregated
  ) {
    reservations.push(
      await reserveSingleItemAvailability({
        db,

        restaurantId,
        batchId,

        itemType:
          item.itemType,

        itemId:
          item.itemId,

        itemName:
          item.itemName,

        quantity:
          item.quantity,

        source,

        holdUntilPaid,

        overrideRequested:
          !!item.overrideRequested,

        overrideReason:
          item.overrideReason ||
          null,

        overrideUserId:
          actorUserId,
      })
    );
  }


  return reservations;
}

async function consumeAvailabilityReservationsForBatch({
  db,
  restaurantId,
  batchId,
}) {
  return db.qAll(
    `
    UPDATE public.item_availability_reservations

    SET
      status = 'consumed',
      consumed_at =
        COALESCE(
          consumed_at,
          NOW()
        )

    WHERE restaurant_id = $1
      AND batch_id = $2::uuid
      AND status = 'reserved'

    RETURNING *
    `,
    [
      restaurantId,
      batchId,
    ]
  );
}


async function releaseAvailabilityReservationsForBatch({
  db,
  restaurantId,
  batchId,
}) {
  const rows =
    await db.qAll(
      `
      SELECT *

      FROM public.item_availability_reservations

      WHERE restaurant_id = $1
        AND batch_id = $2::uuid
        AND status = 'reserved'

      ORDER BY
        item_type ASC,
        item_id ASC

      FOR UPDATE
      `,
      [
        restaurantId,
        batchId,
      ]
    );


  const released = [];


  for (const row of rows) {
    /*
     * Only Manual mode physically removed quantity from
     * manual_quantity.
     *
     * Unlimited / MAKS reservation rows need no quantity
     * restoration here.
     */
    if (
      row.availability_mode ===
      "manual"
    ) {
      const table =
        row.item_type ===
        "meal"
          ? "meals"
          : "menu_items";


      await db.qRun(
        `
        UPDATE public.${table}

        SET manual_quantity =
          COALESCE(
            manual_quantity,
            0
          ) + $1

        WHERE restaurant_id = $2
          AND id = $3
        `,
        [
          Number(
            row.quantity
          ),

          restaurantId,

          Number(
            row.item_id
          ),
        ]
      );
    }


    const updated =
      await db.qGet(
        `
        UPDATE public.item_availability_reservations

        SET
          status = 'released',
          released_at = NOW()

        WHERE id = $1
          AND restaurant_id = $2
          AND status = 'reserved'

        RETURNING *
        `,
        [
          row.id,
          restaurantId,
        ]
      );


    if (updated?.id) {
      released.push(
        updated
      );
    }
  }


  return released;
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  normalizeItemType,
  normalizeAvailabilityMode,

  loadItem,

  getMenuItemPortionsLeft,

  calculateMaksAvailability,

  getItemAvailability,

  assertItemOrderable,
  ItemAvailabilityError,
getOrderItemIdentity,
aggregateAvailabilityItems,
reserveSingleItemAvailability,
reserveItemsAvailability,
consumeAvailabilityReservationsForBatch,
releaseAvailabilityReservationsForBatch,
};