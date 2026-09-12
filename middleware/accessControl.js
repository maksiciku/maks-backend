"use strict";

/**
 * =========================================================
 * MAKS OS — CENTRAL ACCESS CONTROL
 * =========================================================
 *
 * SECURITY MODEL
 *
 * Authority:
 *   owner
 *   manager
 *   staff
 *
 * Job titles have ZERO security meaning.
 *
 * Permissions provide granular access.
 *
 * OWNER:
 *   Full restaurant authority automatically.
 *
 * MANAGER / STAFF:
 *   Explicit permissions only.
 *
 * Certain actions remain OWNER-ONLY regardless of permission.
 */

// =========================================================
// AUTHORITIES
// =========================================================

const AUTHORITIES = Object.freeze({
  OWNER: "owner",
  MANAGER: "manager",
  STAFF: "staff",
});

const AUTHORITY_SET = new Set(
  Object.values(AUTHORITIES)
);

// =========================================================
// CENTRAL PERMISSION CATALOGUE
// =========================================================

const PERMISSIONS = Object.freeze({
  // -------------------------------------------------------
  // SHARED NAVIGATION
  // -------------------------------------------------------

  PROFILE_VIEW: "profile.view",
  ORDERS_VIEW: "orders.view",

  // -------------------------------------------------------
  // POS — general
  // -------------------------------------------------------

  POS_VIEW: "pos.view",
  POS_CREATE_ORDER: "pos.create_order",
  POS_EDIT_ORDER: "pos.edit_order",

  POS_MOVE_TABLE: "pos.move_table",
  POS_TRANSFER_TABLE: "pos.transfer_table",

  POS_CLOSE_TABLE: "pos.close_table",
  POS_CLOSE_UNPAID_TABLE:
    "pos.close_unpaid_table",

  POS_REOPEN_TABLE:
    "pos.reopen_table",

  POS_SPLIT_BILL:
    "pos.split_bill",

  POS_DISCOUNT:
    "pos.discount",

  POS_SERVICE_CHARGE:
    "pos.service_charge",

  POS_OVERRIDE_PRICE:
    "pos.override_price",

  POS_VOID_ITEM:
    "pos.void_item",

  POS_VOID_ORDER:
    "pos.void_order",

  POS_REFUND:
    "pos.refund",

  POS_CASH_PAYMENT:
    "pos.cash_payment",

  POS_CARD_PAYMENT:
    "pos.card_payment",

    POS_VOUCHER_PAYMENT:
  "pos.voucher_payment",

  POS_OPEN_CASH_DRAWER:
    "pos.open_cash_drawer",

  POS_PREVIOUS_ORDERS:
    "pos.previous_orders",

  // -------------------------------------------------------
  // CASH UP / FINANCIAL CONTROL
  // -------------------------------------------------------

  CASHUP_VIEW:
    "cashup.view",

  CASHUP_OPEN:
    "cashup.open",

  CASHUP_CLOSE:
    "cashup.close",

  CASHUP_ADJUST:
    "cashup.adjust",

  CASHUP_VIEW_VARIANCE:
    "cashup.view_variance",

  // -------------------------------------------------------
  // KDS / KITCHEN
  // -------------------------------------------------------

  KDS_VIEW:
    "kds.view",

  KDS_ACCEPT:
    "kds.accept",

  KDS_DECLINE:
    "kds.decline",

  KDS_DELAY:
    "kds.delay",

  KDS_COMPLETE:
    "kds.complete",

  KDS_RESTORE:
    "kds.restore",

    KDS_RESEND:
  "kds.resend",

  KDS_PRIORITY:
    "kds.priority",

  KDS_PAUSE:
    "kds.pause",

  // -------------------------------------------------------
  // BOOKINGS
  // -------------------------------------------------------

  BOOKINGS_VIEW:
    "bookings.view",

  BOOKINGS_CREATE:
    "bookings.create",

  BOOKINGS_EDIT:
    "bookings.edit",

  BOOKINGS_CANCEL:
    "bookings.cancel",

  BOOKINGS_DELETE:
    "bookings.delete",

  BOOKINGS_OVERRIDE_CAPACITY:
    "bookings.override_capacity",

  // -------------------------------------------------------
  // TABLE MAP
  // -------------------------------------------------------

  TABLES_VIEW:
    "tables.view",

  TABLES_EDIT:
    "tables.edit",

  TABLES_LAYOUT:
    "tables.layout",

  TABLES_STATUS:
    "tables.status",

  PREPLIST_VIEW:
    "preplist.view",

  PREPLIST_UPDATE:
    "preplist.update",

  // -------------------------------------------------------
  // STOCK
  // -------------------------------------------------------

  STOCK_VIEW:
    "stock.view",

  STOCK_CREATE:
    "stock.create",

  STOCK_EDIT:
    "stock.edit",

  STOCK_ADJUST:
    "stock.adjust",

    STOCK_OVERRIDE_SALE:
  "stock.override_sale",

  STOCK_DELETE:
    "stock.delete",

  STOCK_VIEW_COST:
    "stock.view_cost",

  STOCK_EXPIRY:
    "stock.expiry",

  // -------------------------------------------------------
  // SUPPLIERS / PURCHASING
  // -------------------------------------------------------

  SUPPLIERS_VIEW:
    "suppliers.view",

  SUPPLIERS_MANAGE:
    "suppliers.manage",

  SUPPLIERS_PRICES:
    "suppliers.prices",

  PURCHASE_ORDERS_VIEW:
    "purchase_orders.view",

  PURCHASE_ORDERS_CREATE:
    "purchase_orders.create",

  PURCHASE_ORDERS_APPROVE:
    "purchase_orders.approve",

  // -------------------------------------------------------
  // MENU
  // -------------------------------------------------------

  MENU_VIEW:
    "menu.view",

  MENU_CREATE:
    "menu.create",

  MENU_EDIT:
    "menu.edit",

  MENU_DELETE:
    "menu.delete",

  MENU_PRICING:
    "menu.pricing",

  MENU_SCHEDULES:
    "menu.schedules",

  MENU_IMPORT:
    "menu.import",

  // -------------------------------------------------------
  // PRICING / DEALS / PROMOTIONS
  // -------------------------------------------------------

  PRICING_VIEW:
    "pricing.view",

  PRICING_MANAGE:
    "pricing.manage",

  DEALS_MANAGE:
    "deals.manage",

  VOUCHERS_MANAGE:
    "vouchers.manage",

  HAPPY_HOUR_MANAGE:
    "happy_hour.manage",

  PROMOTIONS_MANAGE:
    "promotions.manage",

  // -------------------------------------------------------
  // REPORTS / ANALYTICS
  // -------------------------------------------------------

  REPORTS_VIEW:
    "reports.view",

    REPORTS_CREATE:
  "reports.create",

  REPORTS_FINANCIAL:
    "reports.financial",

  REPORTS_STAFF:
    "reports.staff",

  ANALYTICS_VIEW:
    "analytics.view",

  CONTROL_CENTRE_VIEW:
    "control_centre.view",

  // -------------------------------------------------------
  // USERS / STAFF
  // -------------------------------------------------------

  USERS_VIEW:
    "users.view",

  USERS_CREATE:
    "users.create",

  USERS_EDIT:
    "users.edit",

  USERS_DISABLE:
    "users.disable",

  USERS_REMOVE:
    "users.remove",

  USERS_RESET_PIN:
    "users.reset_pin",

  USERS_RESET_PASSWORD:
    "users.reset_password",

  USERS_MANAGE_PERMISSIONS:
    "users.manage_permissions",

  USERS_MANAGE_POS_ACCESS:
    "users.manage_pos_access",

  // -------------------------------------------------------
  // DEVICES
  // -------------------------------------------------------

  DEVICES_VIEW:
    "devices.view",

  DEVICES_MANAGE:
    "devices.manage",

  DEVICES_REVOKE:
    "devices.revoke",

  // -------------------------------------------------------
  // RESTAURANT SETTINGS
  // -------------------------------------------------------

  SETTINGS_VIEW:
    "settings.view",

  SETTINGS_EDIT:
    "settings.edit",

  RECEIPTS_EDIT:
    "receipts.edit",

  KIOSK_SETTINGS:
    "kiosk.settings",

  QR_SETTINGS:
    "qr.settings",

  // -------------------------------------------------------
  // PLATFORM-SENSITIVE RESTAURANT ACTIONS
  // -------------------------------------------------------

  RESTAURANT_TRANSFER_OWNERSHIP:
    "restaurant.transfer_ownership",

  RESTAURANT_MANAGE_MANAGERS:
    "restaurant.manage_managers",

  RESTAURANT_BILLING:
    "restaurant.billing",

  RESTAURANT_ARCHIVE:
    "restaurant.archive",

  RESTAURANT_DELETE:
    "restaurant.delete",
});

// =========================================================
// OWNER-ONLY PERMISSIONS
// =========================================================

/**
 * These cannot be delegated.
 *
 * Even if somebody somehow receives the permission string
 * in the database, requirePermission() still refuses them
 * unless their current authority is OWNER.
 */
const OWNER_ONLY_PERMISSIONS = new Set([
  PERMISSIONS.RESTAURANT_TRANSFER_OWNERSHIP,
  PERMISSIONS.RESTAURANT_MANAGE_MANAGERS,
  PERMISSIONS.RESTAURANT_BILLING,
  PERMISSIONS.RESTAURANT_ARCHIVE,
  PERMISSIONS.RESTAURANT_DELETE,
]);

const KNOWN_PERMISSION_SET =
  new Set(Object.values(PERMISSIONS));

// =========================================================
// NORMALISERS
// =========================================================

function normalizeAuthority(
  value,
  fallback = ""
) {
  const authority = String(
    value || fallback
  )
    .trim()
    .toLowerCase();

  return AUTHORITY_SET.has(authority)
    ? authority
    : "";
}

function normalizePermission(value) {
  const permission = String(value || "")
    .trim()
    .toLowerCase();

  /*
   * Compatibility for permissions saved by older MAKS
   * frontend builds. New writes use the canonical values,
   * but existing restaurant staff start working immediately.
   */
  const aliases = {
    "menus.*": "menu.*",
    "stock.update": "stock.edit",
  };

  return aliases[permission] || permission;
}

function normalizePermissions(value) {
  let input = value;

  if (
    typeof input === "string"
  ) {
    try {
      input = JSON.parse(input);
    } catch {
      input = [];
    }
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return [
    ...new Set(
      input
        .map(normalizePermission)
        .filter(Boolean)
    ),
  ];
}

// =========================================================
// BASIC AUTHORITY HELPERS
// =========================================================

function isOwner(subject) {
  return (
    normalizeAuthority(
      subject?.authority ||
        subject?.membership?.authority
    ) === AUTHORITIES.OWNER
  );
}

function isManager(subject) {
  return (
    normalizeAuthority(
      subject?.authority ||
        subject?.membership?.authority
    ) === AUTHORITIES.MANAGER
  );
}

function isStaff(subject) {
  return (
    normalizeAuthority(
      subject?.authority ||
        subject?.membership?.authority
    ) === AUTHORITIES.STAFF
  );
}

// =========================================================
// PERMISSION CHECK
// =========================================================

function hasPermission(
  subject,
  permission
) {
  const required =
    normalizePermission(permission);

  if (!required) {
    return false;
  }

  const authority =
    normalizeAuthority(
      subject?.authority ||
        subject?.membership?.authority
    );

  if (!authority) {
    return false;
  }

  /*
   * Owner has full restaurant authority.
   */
  if (
    authority === AUTHORITIES.OWNER
  ) {
    return true;
  }

  /*
   * Owner-only capabilities can NEVER be delegated.
   */
  if (
    OWNER_ONLY_PERMISSIONS.has(
      required
    )
  ) {
    return false;
  }

  const permissions =
    normalizePermissions(
      subject?.permissions ||
        subject?.membership?.permissions
    );

  /*
   * Explicit full access wildcard.
   *
   * Still does NOT bypass owner-only restrictions
   * because that check happened above.
   */
  if (
    permissions.includes("*")
  ) {
    return true;
  }

  if (
    permissions.includes(required)
  ) {
    return true;
  }

  /*
   * Category wildcard:
   *
   * stock.*
   * pos.*
   * bookings.*
   */
  const group =
    required.split(".")[0];

  if (
    group &&
    permissions.includes(
      `${group}.*`
    )
  ) {
    return true;
  }

  return false;
}

// =========================================================
// EXPRESS PERMISSION GUARD
// =========================================================

function requirePermission(
  permission
) {
  const required =
    normalizePermission(permission);

  if (
    !KNOWN_PERMISSION_SET.has(
      required
    )
  ) {
    throw new Error(
      `Unknown MAKS permission: ${required}`
    );
  }

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthenticated",
        code: "AUTH_REQUIRED",
      });
    }

    const subject = {
      authority:
        req.membership?.authority ||
        req.user?.authority,

      permissions:
        req.membership?.permissions ||
        req.user?.permissions,
    };

    if (
      !hasPermission(
        subject,
        required
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to perform this action.",
        code:
          "PERMISSION_DENIED",
        permission:
          required,
        authority:
          normalizeAuthority(
            subject.authority
          ) || null,
      });
    }

    return next();
  };
}

// =========================================================
// EXPRESS AUTHORITY GUARD
// =========================================================

function requireAuthority(
  ...allowed
) {
  const allowedAuthorities = [
    ...new Set(
      allowed
        .flat()
        .map((value) =>
          normalizeAuthority(value)
        )
        .filter(Boolean)
    ),
  ];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthenticated",
        code: "AUTH_REQUIRED",
      });
    }

    const authority =
      normalizeAuthority(
        req.membership?.authority ||
          req.user?.authority
      );

    if (
      !allowedAuthorities.includes(
        authority
      )
    ) {
      return res.status(403).json({
        error:
          "Insufficient authority.",
        code:
          "AUTHORITY_DENIED",
        required:
          allowedAuthorities,
        current:
          authority || null,
      });
    }

    return next();
  };
}

// =========================================================
// OWNER-ONLY GUARD
// =========================================================

const requireOwner =
  requireAuthority(
    AUTHORITIES.OWNER
  );

// =========================================================
// PERMISSION VALIDATION
// =========================================================

function validatePermissions(
  permissions
) {
  const normalized =
    normalizePermissions(
      permissions
    );

  const unknown =
    normalized.filter(
      (permission) =>
        permission !== "*" &&
        !(
          permission.endsWith(".*") &&
          [...KNOWN_PERMISSION_SET].some(
            (known) =>
              known.startsWith(
                permission.slice(0, -1)
              )
          )
        ) &&
        !KNOWN_PERMISSION_SET.has(
          permission
        )
    );

  return {
    valid:
      unknown.length === 0,

    permissions:
      normalized,

    unknown,
  };
}

// =========================================================
// DELEGATION SECURITY
// =========================================================

/**
 * Decides whether actor may grant requested permissions.
 *
 * OWNER:
 * - may grant any normal permission;
 * - owner-only permissions remain owner-only and should
 *   never need to be granted.
 *
 * MANAGER:
 * - may grant only permissions they themselves possess.
 *
 * STAFF:
 * - cannot manage permissions.
 */
function canGrantPermissions(
  actor,
  requestedPermissions
) {
  const authority =
    normalizeAuthority(
      actor?.authority
    );

  const validation =
    validatePermissions(
      requestedPermissions
    );

  if (!validation.valid) {
    return {
      allowed: false,
      reason:
        "Unknown permission supplied.",
      unknown:
        validation.unknown,
    };
  }

  const requested =
    validation.permissions;

  if (
    authority === AUTHORITIES.OWNER
  ) {
    const forbidden =
      requested.filter(
        (permission) =>
          OWNER_ONLY_PERMISSIONS.has(
            permission
          )
      );

    if (forbidden.length) {
      return {
        allowed: false,
        reason:
          "Owner-only capabilities are not delegated as ordinary permissions.",
        forbidden,
      };
    }

    return {
      allowed: true,
      permissions: requested,
    };
  }

  if (
    authority !==
    AUTHORITIES.MANAGER
  ) {
    return {
      allowed: false,
      reason:
        "Only an owner or authorised manager may grant permissions.",
    };
  }

  if (
    !hasPermission(
      actor,
      PERMISSIONS.USERS_MANAGE_PERMISSIONS
    )
  ) {
    return {
      allowed: false,
      reason:
        "Manager does not have permission to manage staff permissions.",
    };
  }

  const forbidden =
    requested.filter(
      (permission) =>
        OWNER_ONLY_PERMISSIONS.has(
          permission
        ) ||
        !hasPermission(
          actor,
          permission
        )
    );

  if (forbidden.length) {
    return {
      allowed: false,
      reason:
        "Manager cannot grant permissions they do not possess.",
      forbidden,
    };
  }

  return {
    allowed: true,
    permissions: requested,
  };
}

// =========================================================
// EXPORTS
// =========================================================

module.exports = {
  AUTHORITIES,
  PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,

  normalizeAuthority,
  normalizePermission,
  normalizePermissions,

  isOwner,
  isManager,
  isStaff,

  hasPermission,

  requirePermission,
  requireAuthority,
  requireOwner,

  validatePermissions,
  canGrantPermissions,
};
