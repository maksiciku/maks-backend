// routes/posRoutes.js
const express = require("express");
const router = express.Router();
const { detectAllergenCodesFromName } = require("../utils/novaAllergens");
const { qAll, qGet, qRun, withTx, kind } = require("../dbCompat");
const { authenticateToken, requireRole } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");
const { getMealPortionsLeft } = require("../utils/novaDeduct");
const {
  deductStockFromMealOrder,
  deductStockFromMenuItem,
  deductStockByItemName,
  deductStockByStockId,
} = require("../utils/novaDeduct");
const LIVE_VIEW = ["owner", "admin", "manager", "chef"];
const LIVE_DELETE = ["owner", "admin", "manager"];
const { audit } = require("../utils/audit");

const {
  enqueueEdgeEventTx,
  withEdgeOperation,
} = require("../edge/syncStore");

const {
  emitMenuCatalogSnapshotTx,
} = require("../edge/contracts/menuCatalog");

const {
  emitTableOperationalSnapshotTx,
  emitTableBatchAssignmentSnapshotTx,
  isTableEdgeProducerRuntime,
} = require(
  "../edge/contracts/tableOperations"
);

const {
  emitFinancialSettlementRecordedTx,
} = require(
  "../edge/contracts/financialOperations"
);

const {
  MaksRuntimeRoleError,
  assertCloudRuntime,
} = require("../utils/runtimeRole");

const {
  ItemAvailabilityError,
  reserveItemsAvailability,
  consumeAvailabilityReservationsForBatch,
  releaseAvailabilityReservationsForBatch,
} = require("../services/itemsSettingsService");

// ✅ Role groups (commercial-safe defaults)

/*
 * Membership roles are deliberately broad:
 *
 * owner
 * admin
 * chef
 * staff
 *
 * Human job titles such as waiter/cashier are stored
 * separately in restaurant_members.job_title.
 *
 * Security authority is handled through:
 * - membership.authority
 * - membership.permissions
 *
 * Do not use job titles as authentication roles.
 */
const POS_STAFF = [
  "owner",
  "admin",
  "staff",
];

const POS_MANAGER = [
  "owner",
  "admin",
];

function sendPosMenuCatalogAuthorityError(res, error) {
  if (!(error instanceof MaksRuntimeRoleError)) {
    return false;
  }

  if (error.code === "MAKS_RUNTIME_ROLE_NOT_CLOUD") {
    res.status(409).json({
      error: "MENU_CATALOG_CLOUD_AUTHORITY_REQUIRED",
    });
    return true;
  }

  res.status(503).json({
    error: "MENU_CATALOG_RUNTIME_ROLE_UNAVAILABLE",
  });
  return true;
}

function requireCloudPosMenuCatalogAuthority(req, res, next) {
  try {
    assertCloudRuntime();
    next();
  } catch (error) {
    if (sendPosMenuCatalogAuthorityError(res, error)) {
      return;
    }
    next(error);
  }
}
router.use(authenticateToken, loadMembership);
// ----------------------------
// Allowed EU allergen codes
// ----------------------------
const ALLOWED_ALLERGEN_CODES = [
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
];

const {
  buildCanonicalCart,
  PricingError,
} = require("../services/orderPricingService");

const {
  buildAuthoritativeQuote,
  normalizeSurface,
} = require("../services/pricingRulesService");

const {
  requirePermission,
  hasPermission,
  PERMISSIONS,
} = require("../middleware/accessControl");

function sanitizeAllergenCodes(arr = []) {
  return Array.from(
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((x) => String(x || "").trim().toLowerCase())
        .filter((x) => ALLOWED_ALLERGEN_CODES.includes(x))
    )
  );
}
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

// ---------- Utilities ----------
function canonicalTableName(input) {
  if (input == null) return "Takeaway";
  const s = String(input).trim();
  if (/^delivery$/i.test(s)) return "Delivery";
  if (/^takeaway$/i.test(s)) return "Takeaway";
  const m = s.match(/\d+/);
  return m ? `Table ${m[0]}` : s;
}

function tableNameVariants(input) {
  const raw = String(input || "").trim();
  const canon = canonicalTableName(raw);        // "4" -> "Table 4"
  const digits = (raw.match(/\d+/) || [null])[0];
  const justNum = digits ? String(Number(digits)) : null; // "Table 4" -> "4"
  const tableNum = digits ? `Table ${Number(digits)}` : null;

  return Array.from(new Set([raw, canon, justNum, tableNum].filter(Boolean)));
}

async function emitTableOperationalIfEdge(
  tx,
  restaurantId,
  tableName
) {
  if (
    !isTableEdgeProducerRuntime()
  ) {
    return null;
  }

  /*
   * Table operational snapshots represent a real physical
   * restaurant table. POS payment routes also support virtual
   * destinations such as Takeaway and Delivery, so those must
   * not manufacture a physical-table revision/event.
   */
  const physicalTable =
    await tx.qGet(
      `
      SELECT
        1 AS ok
      FROM
        public.tables
      WHERE
        restaurant_id = $1
        AND LOWER(
              TRIM(name)
            ) =
            LOWER(
              TRIM($2)
            )
      LIMIT 1
      `,
      [
        Number(
          restaurantId
        ),
        String(
          tableName || ""
        ).trim(),
      ]
    );

  if (
    !physicalTable?.ok
  ) {
    return null;
  }

  return emitTableOperationalSnapshotTx(
    tx,
    {
      restaurantId,
      tableName,
    }
  );
}


async function emitTableBatchAssignmentIfEdge(
  tx,
  restaurantId,
  batchId
) {
  if (
    !isTableEdgeProducerRuntime()
  ) {
    return null;
  }

  return emitTableBatchAssignmentSnapshotTx(
    tx,
    {
      restaurantId,
      batchId,
    }
  );
}

async function setTableStatus(qRunFn, rid, tableName, status) {
  const name = String(tableName || "").trim();
  if (!rid || !name) return;

  if (kind === "pg") {
    await qRunFn(
      `UPDATE public.table_map
         SET status = $1
       WHERE restaurant_id = $2
         AND LOWER(TRIM(name)) = LOWER(TRIM($3))`,
      [status, rid, name]
    );

    await qRunFn(
      `UPDATE public.tables
         SET status = $1
       WHERE restaurant_id = $2
         AND LOWER(TRIM(name)) = LOWER(TRIM($3))`,
      [status, rid, name]
    );
  } else {
    await qRunFn(
      `UPDATE table_map
         SET status = ?
       WHERE restaurant_id = ?
         AND LOWER(TRIM(name)) = LOWER(TRIM(?))`,
      [status, rid, name]
    );
    await qRunFn(
      `UPDATE tables
         SET status = ?
       WHERE restaurant_id = ?
         AND LOWER(TRIM(name)) = LOWER(TRIM(?))`,
      [status, rid, name]
    );
  }
}


function makeBatchId() {
  try {
    const crypto = require("crypto");
    return crypto.randomUUID();
  } catch {
    return `BATCH-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

function parsePosOrderIds(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => Number(x)).filter(Boolean);
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map((x) => Number(x)).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function sqlByKind(tx, pgSql, sqliteSql) {
  return tx.kind === "pg" ? pgSql : sqliteSql;
}

// ---------- Schema boot ----------
async function initPosOrders() {
  try {
    if (kind === "pg") {
      await qRun(`
        CREATE TABLE IF NOT EXISTS public.pos_orders (
          id BIGSERIAL PRIMARY KEY,
          table_number TEXT NOT NULL,
          meal_id TEXT,
          item_name TEXT,
          quantity REAL NOT NULL DEFAULT 1,
          total_price REAL DEFAULT 0,
          order_status TEXT DEFAULT 'open',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          restaurant_id BIGINT DEFAULT 1,
          note TEXT,
          options JSONB DEFAULT '{}'::jsonb,
          paid INTEGER DEFAULT 0,
          item_id BIGINT,
          item_type TEXT,
          batch_id UUID,
          category_id INTEGER
        );
      `);

      // -------------------------
      // PG safety alters
      // -------------------------
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS paid INTEGER DEFAULT 0;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '{}'::jsonb;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS note TEXT;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS item_id BIGINT;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS item_name TEXT;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS item_type TEXT;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS batch_id UUID;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS category_id INTEGER;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS menu_item_id BIGINT;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS stock_id BIGINT;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT false;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT false;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS table_allergy_codes JSONB;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS item_allergen_contains JSONB;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS allergen_conflicts JSONB;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS strict_cross_contamination BOOLEAN NOT NULL DEFAULT false;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS table_covers INTEGER DEFAULT 1;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS amount_paid REAL DEFAULT 0;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS remaining_price REAL;`);
      await qRun(`
  ALTER TABLE public.pos_orders
  ADD COLUMN IF NOT EXISTS
    vat_rate NUMERIC(6,3);
`);

await qRun(`
  ALTER TABLE public.pos_orders
  ADD COLUMN IF NOT EXISTS
    vat_gross NUMERIC(12,2);
`);

await qRun(`
  ALTER TABLE public.pos_orders
  ADD COLUMN IF NOT EXISTS
    vat_net NUMERIC(12,2);
`);

await qRun(`
  ALTER TABLE public.pos_orders
  ADD COLUMN IF NOT EXISTS
    vat_amount NUMERIC(12,2);
`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS invoice_number INTEGER;`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'pos';`);
      await qRun(`ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);
      /*
       * MAKS EDGE operational identity.
       *
       * BIGSERIAL ids are local to one PostgreSQL database
       * and MUST NOT be treated as Cloud/Edge identity.
       *
       * One submission UUID + row ordinal is stable across
       * independent databases and will later be used by
       * payment replication as well.
       */
      await qRun(`
        ALTER TABLE public.pos_orders
        ADD COLUMN IF NOT EXISTS
          edge_submission_id UUID;
      `);

      await qRun(`
        ALTER TABLE public.pos_orders
        ADD COLUMN IF NOT EXISTS
          edge_row_ordinal INTEGER;
      `);

      await qRun(`
        CREATE UNIQUE INDEX IF NOT EXISTS
          ux_pos_orders_edge_submission_row
        ON public.pos_orders (
          restaurant_id,
          batch_id,
          edge_submission_id,
          edge_row_ordinal
        )
        WHERE
          edge_submission_id IS NOT NULL
          AND edge_row_ordinal IS NOT NULL;
      `);


      // -------------------------
      // PG indexes
      // -------------------------
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_rid ON public.pos_orders(restaurant_id);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_table ON public.pos_orders(table_number);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_paid ON public.pos_orders(paid);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_batch ON public.pos_orders(batch_id);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_menu_item_id ON public.pos_orders(menu_item_id);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_stock_id ON public.pos_orders(stock_id);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_star ON public.pos_orders(restaurant_id, is_starred);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_remaining_price ON public.pos_orders(restaurant_id, remaining_price);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_source ON public.pos_orders(restaurant_id, source);`);

      // -------------------------
      // PG backfill
      // -------------------------
      await qRun(`
        UPDATE public.pos_orders
        SET remaining_price = CASE
          WHEN paid = 1 THEN 0
          ELSE COALESCE(total_price, 0)
        END
        WHERE remaining_price IS NULL
      `);

      await qRun(`
        UPDATE public.pos_orders
        SET amount_paid = CASE
          WHEN paid = 1 THEN COALESCE(total_price, 0)
          ELSE COALESCE(amount_paid, 0)
        END
        WHERE amount_paid IS NULL OR amount_paid = 0
      `);

    } else {
      await qRun(`
        CREATE TABLE IF NOT EXISTS pos_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_number TEXT NOT NULL,
          meal_id INTEGER,
          meal_name TEXT,
          quantity INTEGER NOT NULL DEFAULT 1,
          total_price REAL DEFAULT 0,
          order_status TEXT DEFAULT 'unpaid',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          restaurant_id INTEGER DEFAULT 1,
          note TEXT,
          options TEXT,
          paid INTEGER DEFAULT 0,
          item_id INTEGER,
          item_name TEXT,
          item_type TEXT,
          batch_id TEXT,
          category_id INTEGER
        );
      `);

      // -------------------------
      // SQLite safety alters
      // -------------------------
      await qRun(`ALTER TABLE pos_orders ADD COLUMN batch_id TEXT;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN item_id INTEGER;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN item_name TEXT;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN item_type TEXT;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN category_id INTEGER;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN menu_item_id BIGINT;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN stock_id BIGINT;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN is_starred INTEGER DEFAULT 0;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN is_priority INTEGER DEFAULT 0;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN strict_cross_contamination INTEGER DEFAULT 0;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN table_covers INTEGER DEFAULT 1;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN amount_paid REAL DEFAULT 0;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN remaining_price REAL;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN table_allergy_codes TEXT;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN item_allergen_contains TEXT;`).catch(() => {});
      await qRun(`ALTER TABLE pos_orders ADD COLUMN allergen_conflicts TEXT;`).catch(() => {});

      // -------------------------
      // SQLite indexes
      // -------------------------
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_rid ON pos_orders(restaurant_id);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_table ON pos_orders(table_number);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_paid ON pos_orders(paid);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_batch ON pos_orders(batch_id);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_menu_item_id ON pos_orders(menu_item_id);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_stock_id ON pos_orders(stock_id);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_star ON pos_orders(restaurant_id, is_starred);`);
      await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_orders_remaining_price ON pos_orders(restaurant_id, remaining_price);`);

      // -------------------------
      // SQLite backfill
      // -------------------------
      await qRun(`
        UPDATE pos_orders
        SET remaining_price = CASE
          WHEN paid = 1 THEN 0
          ELSE COALESCE(total_price, 0)
        END
        WHERE remaining_price IS NULL
      `).catch(() => {});

      await qRun(`
        UPDATE pos_orders
        SET amount_paid = CASE
          WHEN paid = 1 THEN COALESCE(total_price, 0)
          ELSE COALESCE(amount_paid, 0)
        END
        WHERE amount_paid IS NULL OR amount_paid = 0
      `).catch(() => {});
    }

    await initOrdersTables();
    console.log("✅ POS Orders table is ready");
  } catch (e) {
    console.error("❌ Failed to init pos_orders:", e);
  }
}

async function initOrdersTables() {
  // -------------------------
  // ORDERS
  // -------------------------
  if (kind === "pg") {
    await qRun(`
      CREATE TABLE IF NOT EXISTS public.orders (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        table_number TEXT NOT NULL,
        meal_name TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1,
        price_per_unit REAL DEFAULT 0,
        total_price REAL DEFAULT 0,
        paid INTEGER NOT NULL DEFAULT 0,
        order_status TEXT DEFAULT 'pending',
        category TEXT DEFAULT 'meals',
        category_id INTEGER,
        order_type TEXT DEFAULT 'dine-in',
        options JSONB DEFAULT '{}'::jsonb,
        note TEXT,
        special_requests TEXT,
        batch_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await qRun(`
      CREATE TABLE IF NOT EXISTS public.pos_table_sessions (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        table_id BIGINT NOT NULL,
        covers INTEGER NOT NULL DEFAULT 1,
        allergy_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
        strict_cross_contamination BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (restaurant_id, table_id)
      );
    `);

    // safety alters (PG supports IF NOT EXISTS)
    await qRun(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS category_id INTEGER;`);
    await qRun(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '{}'::jsonb;`);
    await qRun(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS note TEXT;`);
    await qRun(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS special_requests TEXT;`);
    await qRun(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS batch_id UUID;`);
    await qRun(`ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT false;`);

    await qRun(`
      ALTER TABLE public.pos_table_sessions
      ADD COLUMN IF NOT EXISTS strict_cross_contamination BOOLEAN NOT NULL DEFAULT false;
    `);

    await qRun(`CREATE INDEX IF NOT EXISTS idx_orders_rid ON public.orders(restaurant_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_orders_batch ON public.orders(batch_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(order_status);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_orders_table ON public.orders(table_number);`);

    await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_rid ON public.pos_table_sessions(restaurant_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_table ON public.pos_table_sessions(table_id);`);

    // -------------------------
    // ORDER_BATCHES
    // -------------------------
    await qRun(`
      CREATE TABLE IF NOT EXISTS public.order_batches (
        id UUID PRIMARY KEY,
        table_number TEXT,
        restaurant_id BIGINT NOT NULL,
        delivery_status TEXT,
        delivery_code TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await qRun(`ALTER TABLE public.order_batches ADD COLUMN IF NOT EXISTS order_type TEXT DEFAULT 'dine-in';`);
    await qRun(`ALTER TABLE public.order_batches ADD COLUMN IF NOT EXISTS pickup_number INTEGER;`);
    await qRun(`ALTER TABLE public.order_batches ADD COLUMN IF NOT EXISTS delivery_status TEXT;`);
    await qRun(`ALTER TABLE public.order_batches ADD COLUMN IF NOT EXISTS delivery_code TEXT;`);

    await qRun(`CREATE INDEX IF NOT EXISTS idx_order_batches_rid ON public.order_batches(restaurant_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_order_batches_table ON public.order_batches(table_number);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_order_batches_order_type ON public.order_batches(order_type);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_order_batches_pickup_number ON public.order_batches(restaurant_id, pickup_number);`);
await qRun(`ALTER TABLE public.order_batches ADD COLUMN IF NOT EXISTS requested_payment_method TEXT;`);
    // -------------------------
    // KITCHEN_STATE
    // -------------------------
    await qRun(`
      CREATE TABLE IF NOT EXISTS public.kitchen_state (
        restaurant_id BIGINT PRIMARY KEY,
        is_paused BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

  } else {
    // -------------------------
    // SQLITE VERSION
    // -------------------------
    await qRun(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id INTEGER NOT NULL,
        table_number TEXT NOT NULL,
        meal_name TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1,
        price_per_unit REAL DEFAULT 0,
        total_price REAL DEFAULT 0,
        paid INTEGER NOT NULL DEFAULT 0,
        order_status TEXT DEFAULT 'pending',
        category TEXT DEFAULT 'meals',
        category_id INTEGER,
        order_type TEXT DEFAULT 'dine-in',
        options TEXT DEFAULT '{}',
        note TEXT,
        special_requests TEXT,
        batch_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await qRun(`ALTER TABLE orders ADD COLUMN category_id INTEGER;`).catch(() => {});
    await qRun(`ALTER TABLE orders ADD COLUMN options TEXT;`).catch(() => {});
    await qRun(`ALTER TABLE orders ADD COLUMN note TEXT;`).catch(() => {});
    await qRun(`ALTER TABLE orders ADD COLUMN special_requests TEXT;`).catch(() => {});
    await qRun(`ALTER TABLE orders ADD COLUMN batch_id TEXT;`).catch(() => {});
    await qRun(`ALTER TABLE orders ADD COLUMN is_priority INTEGER DEFAULT 0;`).catch(() => {});

    await qRun(`CREATE INDEX IF NOT EXISTS idx_orders_rid ON orders(restaurant_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_orders_batch ON orders(batch_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_number);`);

    // -------------------------
    // ORDER_BATCHES
    // -------------------------
    await qRun(`
      CREATE TABLE IF NOT EXISTS order_batches (
        id TEXT PRIMARY KEY,
        table_number TEXT,
        restaurant_id INTEGER NOT NULL,
        delivery_status TEXT,
        delivery_code TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await qRun(`ALTER TABLE order_batches ADD COLUMN order_type TEXT DEFAULT 'dine-in';`).catch(() => {});
    await qRun(`ALTER TABLE order_batches ADD COLUMN pickup_number INTEGER;`).catch(() => {});
    await qRun(`ALTER TABLE order_batches ADD COLUMN delivery_status TEXT;`).catch(() => {});
    await qRun(`ALTER TABLE order_batches ADD COLUMN delivery_code TEXT;`).catch(() => {});

    await qRun(`CREATE INDEX IF NOT EXISTS idx_order_batches_rid ON order_batches(restaurant_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_order_batches_table ON order_batches(table_number);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_order_batches_order_type ON order_batches(order_type);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_order_batches_pickup_number ON order_batches(restaurant_id, pickup_number);`);

    // -------------------------
    // POS TABLE SESSIONS
    // -------------------------
    await qRun(`
      CREATE TABLE IF NOT EXISTS pos_table_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id INTEGER NOT NULL,
        table_id INTEGER NOT NULL,
        covers INTEGER NOT NULL DEFAULT 1,
        allergy_codes TEXT NOT NULL DEFAULT '[]',
        strict_cross_contamination INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (restaurant_id, table_id)
      );
    `);

    await qRun(`ALTER TABLE pos_table_sessions ADD COLUMN strict_cross_contamination INTEGER DEFAULT 0;`).catch(() => {});
    await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_rid ON pos_table_sessions(restaurant_id);`);
    await qRun(`CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_table ON pos_table_sessions(table_id);`);

    // optional compatibility if SQLite pos_orders still exists
    await qRun(`ALTER TABLE pos_orders ADD COLUMN strict_cross_contamination INTEGER DEFAULT 0;`).catch(() => {});
    await qRun(`ALTER TABLE pos_orders ADD COLUMN table_covers INTEGER DEFAULT 1;`).catch(() => {});

    // -------------------------
    // KITCHEN_STATE
    // -------------------------
    await qRun(`
      CREATE TABLE IF NOT EXISTS kitchen_state (
        restaurant_id INTEGER PRIMARY KEY,
        is_paused INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
}

// =========================================================
// POS FINANCIAL AUTHORITY HELPERS
// =========================================================

function posPermissionSubject(req) {
  return {
    authority:
      req.membership?.authority ||
      req.user?.authority,

    permissions:
      req.membership?.permissions ||
      req.user?.permissions,
  };
}

function permissionForTender(method) {
  const safeMethod =
    normalizePayMethod(method);

  if (safeMethod === "cash") {
    return PERMISSIONS.POS_CASH_PAYMENT;
  }

  if (safeMethod === "card") {
    return PERMISSIONS.POS_CARD_PAYMENT;
  }

  if (safeMethod === "voucher") {
    return PERMISSIONS.POS_VOUCHER_PAYMENT;
  }

  return null;
}

function requestedTenderPermissions(
  req,
  {
    defaultMethod = null,
  } = {}
) {
  const body =
    req.body || {};

  const rawMethods =
    Array.isArray(body.payments) &&
    body.payments.length
      ? body.payments.map(
          (payment) =>
            payment?.method
        )
      : [
          body.paymentMethod ??
          body.method ??
          defaultMethod,
        ];

  const required =
    new Set();

  for (const rawMethod of rawMethods) {
    const permission =
      permissionForTender(
        rawMethod
      );

    if (permission) {
      required.add(
        permission
      );
    }
  }

  // A voucher code is itself a POS financial instrument.
  if (body?.voucher?.code) {
    required.add(
      PERMISSIONS.POS_VOUCHER_PAYMENT
    );
  }

  return required;
}

function requireTenderPermissions({
  defaultMethod = null,
} = {}) {
  return function tenderPermissionMiddleware(
    req,
    res,
    next
  ) {
    const subject =
      posPermissionSubject(req);

    const required =
      requestedTenderPermissions(
        req,
        {
          defaultMethod,
        }
      );

    const missing =
      [...required].filter(
        (permission) =>
          !hasPermission(
            subject,
            permission
          )
      );

    if (missing.length) {
      return res.status(403).json({
        error:
          "You do not have permission to use this payment method.",

        code:
          "PAYMENT_METHOD_PERMISSION_DENIED",

        missing_permissions:
          missing,
      });
    }

    return next();
  };
}

function requireMiscPricePermission(
  req,
  res,
  next
) {
  const items =
    Array.isArray(
      req.body?.items
    )
      ? req.body.items
      : [];

  const hasManualPriceItem =
    items.some(
      (item) =>
        isManualMiscItem(item)
    );

  if (!hasManualPriceItem) {
    return next();
  }

  const allowed =
    hasPermission(
      posPermissionSubject(req),
      PERMISSIONS.POS_OVERRIDE_PRICE
    );

  if (!allowed) {
    return res.status(403).json({
      error:
        "You do not have permission to add manually priced items.",

      code:
        "POS_PRICE_OVERRIDE_PERMISSION_DENIED",

      missing_permission:
        PERMISSIONS.POS_OVERRIDE_PRICE,
    });
  }

  return next();
}

function requireStockOverridePermission(
  req,
  res,
  next
) {
  const items =
    Array.isArray(req.body?.items)
      ? req.body.items
      : [];

  const wantsStockOverride =
    items.some(
      (item) =>
        item?.stock_override === true ||
        item?.stock_override === "true" ||
        item?.allow_stock_override === true ||
        item?.allow_stock_override === "true"
    );

  if (!wantsStockOverride) {
    return next();
  }

  const allowed =
    hasPermission(
      posPermissionSubject(req),
      PERMISSIONS.STOCK_OVERRIDE_SALE
    );

    if (!allowed) {
    return res.status(403).json({
      error:
        "You do not have permission to override stock availability.",

      code:
        "STOCK_OVERRIDE_PERMISSION_DENIED",

      missing_permission:
        PERMISSIONS.STOCK_OVERRIDE_SALE,
    });
  }

  // SECURITY:
  // This value is created by the server only after permission
  // has been verified. The pricing engine may trust this flag.
  req.stockOverrideAuthorised = true;

  return next();
}

async function requireMarkPaidPermissions(
  req,
  res,
  next
) {
  try {
    const subject = {
      authority:
        req.membership?.authority ||
        req.user?.authority,

      permissions:
        req.membership?.permissions ||
        req.user?.permissions,
    };

    const rid = Number(
      req.tenantRid || 0
    );

    if (!rid) {
      return res.status(400).json({
        error: "Missing tenant",
      });
    }

    const {
      manualDiscountAmount = 0,
      serviceChargeAmount = 0,
    } = req.body || {};

    const manualDiscount =
      Number(
        manualDiscountAmount || 0
      );

    const serviceCharge =
      Number(
        serviceChargeAmount || 0
      );

    if (
      !Number.isFinite(
        manualDiscount
      ) ||
      manualDiscount < 0
    ) {
      return res.status(400).json({
        error:
          "Invalid manual discount amount.",
      });
    }

    if (
      !Number.isFinite(
        serviceCharge
      ) ||
      serviceCharge < 0
    ) {
      return res.status(400).json({
        error:
          "Invalid service charge amount.",
      });
    }

    /*
     * Load the restaurant's live POS policy.
     *
     * Security rule:
     * - browser does not decide whether discounts/service
     *   charge are enabled;
     * - PostgreSQL is authoritative.
     */
    const policy =
      await req.qGet(
        `
        SELECT
          service_charge_enabled,
          service_charge_rate,
          service_charge_vat_mode,
          manual_discounts_enabled,
          max_manual_discount_percent
        FROM public.restaurants
        WHERE id = $1
        LIMIT 1
        `,
        [rid]
      );

    if (!policy) {
      return res.status(404).json({
        error:
          "Restaurant not found",
      });
    }

    /*
     * Permission checks.
     */
    const required =
      new Set();

    if (manualDiscount > 0) {
      required.add(
        PERMISSIONS.POS_DISCOUNT
      );
    }

    if (serviceCharge > 0) {
      required.add(
        PERMISSIONS.POS_SERVICE_CHARGE
      );
    }

    const missing = [
      ...required,
    ].filter(
      (permission) =>
        !hasPermission(
          subject,
          permission
        )
    );

    if (missing.length) {
      return res.status(403).json({
        error:
          "You do not have permission to apply this adjustment.",

        code:
          "PAYMENT_PERMISSION_DENIED",

        missing_permissions:
          missing,
      });
    }

    /*
     * Restaurant-wide discount policy.
     */
    if (
      manualDiscount > 0 &&
      policy.manual_discounts_enabled !==
        true
    ) {
      return res.status(403).json({
        error:
          "Manual discounts are disabled for this restaurant.",

        code:
          "MANUAL_DISCOUNTS_DISABLED",
      });
    }

    /*
     * Restaurant-wide service-charge policy.
     */
    if (
      serviceCharge > 0 &&
      policy.service_charge_enabled !==
        true
    ) {
      return res.status(403).json({
        error:
          "Service charge is disabled for this restaurant.",

        code:
          "SERVICE_CHARGE_DISABLED",
      });
    }

    /*
     * Keep the policy available to the actual
     * settlement route so it does not need to
     * query restaurants again.
     */
    req.posPolicy = {
      serviceChargeEnabled:
        policy.service_charge_enabled ===
        true,

      serviceChargeRate:
        Number(
          policy.service_charge_rate ||
            0
        ),

        serviceChargeVatMode:
  String(
    policy.service_charge_vat_mode ||
      "discretionary"
  )
    .trim()
    .toLowerCase(),

      manualDiscountsEnabled:
        policy.manual_discounts_enabled ===
        true,

      maxManualDiscountPercent:
        Number(
          policy
            .max_manual_discount_percent ||
            0
        ),
    };

    return next();
  } catch (error) {
    console.error(
      "❌ requireMarkPaidPermissions failed:",
      error
    );

    return res.status(500).json({
      error:
        "Failed to validate payment permissions.",
    });
  }
}

async function verifyPosApprover({
  restaurantId,
  pin,
  permission,
}) {
  const safePin = String(pin || "").trim();

  if (!/^\d{4}$/.test(safePin)) {
    return null;
  }

  const rows = await qAll(
    `
    SELECT
      u.id,
      u.pin_hash,
      u.full_name,
      u.username,

      rm.authority,
      rm.permissions

    FROM public.restaurant_members rm

    JOIN public.users u
      ON u.id = rm.user_id

    WHERE rm.restaurant_id = $1
      AND rm.is_active = TRUE
      AND u.is_active = TRUE
      AND u.can_pos_login = TRUE
      AND u.pin_hash IS NOT NULL
      AND rm.authority IN ('owner', 'manager')
    `,
    [Number(restaurantId)]
  );

  const bcrypt = require("bcryptjs");

  for (const row of rows || []) {
    if (
      !row?.pin_hash ||
      !bcrypt.compareSync(
        safePin,
        row.pin_hash
      )
    ) {
      continue;
    }

    const allowed = hasPermission(
      {
        authority: row.authority,
        permissions: row.permissions,
      },
      permission
    );

    if (!allowed) {
      return null;
    }

    return {
      id: Number(row.id),
      name:
        row.full_name ||
        row.username ||
        "Manager",

      authority:
        row.authority,

      permissions:
        row.permissions || [],
    };
  }

  return null;
}

async function recordPayment({
  tx,
  restaurantId,
  tableNumber,
  amount,
  method,
  userId = null,
  batchId = null,
  terminalRef = null,
  posOrderIds = [],
  source = "pos",
  cashupSessionId = null,
  refPaymentId = null,
  settlementId = null,
  paymentUuid = null,
  refPaymentUuid = null,
}) {
  if (!tx?.qGet) {
    throw new Error("recordPayment requires an active database transaction");
  }

  const safeMethod = normalizePayMethod(method);

  const safeAmount = Number(
    Number(amount || 0).toFixed(2)
  );

  if (!Number.isFinite(safeAmount)) {
    throw new Error("Invalid payment amount");
  }

  const ids = Array.isArray(posOrderIds)
    ? posOrderIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];

  const safeBatchId =
    batchId && isUuid(batchId)
      ? String(batchId)
      : null;

  const safeSettlementId =
    settlementId && isUuid(settlementId)
      ? String(settlementId)
      : null;

  const rawPaymentUuid =
    paymentUuid == null
      ? ""
      : String(paymentUuid).trim();

  if (
    rawPaymentUuid &&
    !isUuid(rawPaymentUuid)
  ) {
    throw new Error(
      "Invalid payment UUID"
    );
  }

  const safePaymentUuid =
    rawPaymentUuid || null;

  const rawRefPaymentUuid =
    refPaymentUuid == null
      ? ""
      : String(refPaymentUuid).trim();

  if (
    rawRefPaymentUuid &&
    !isUuid(rawRefPaymentUuid)
  ) {
    throw new Error(
      "Invalid reference payment UUID"
    );
  }

  const safeRefPaymentUuid =
    rawRefPaymentUuid || null;

  const row = await tx.qGet(
    `
    INSERT INTO public.payments (
      restaurant_id,
      table_number,
      amount,
      method,
      created_at,
      staff_user_id,
      batch_id,
      terminal_ref,
      pos_order_ids,
      source,
      cashup_session_id,
      ref_payment_id,
      settlement_id,
      payment_uuid,
      ref_payment_uuid
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      NOW(),
      $5,
      $6::uuid,
      $7,
      $8::jsonb,
      $9,
      $10,
      $11,
      $12::uuid,
      COALESCE(
        $13::uuid,
        gen_random_uuid()
      ),
      $14::uuid
    )
    RETURNING
      id,
      restaurant_id,
      table_number,
      amount,
      method,
      batch_id,
      settlement_id,
      payment_uuid,
      ref_payment_uuid,
      created_at
    `,
    [
      Number(restaurantId),
      String(tableNumber),
      safeAmount,
      safeMethod,
      userId ? Number(userId) : null,
      safeBatchId,
      terminalRef
        ? String(terminalRef).trim()
        : null,
      JSON.stringify(ids),
      String(source || "pos"),
      cashupSessionId
        ? String(cashupSessionId)
        : null,
      refPaymentId
        ? Number(refPaymentId)
        : null,
      safeSettlementId,
      safePaymentUuid,
      safeRefPaymentUuid,
    ]
  );

  if (!row?.id) {
    throw new Error("Payment ledger row was not created");
  }

  return {
    id: Number(row.id),
    restaurantId: Number(row.restaurant_id),
    tableNumber: row.table_number,
    amount: Number(row.amount || 0),
    method: row.method,
    batchId: row.batch_id || null,
    settlementId: row.settlement_id || null,
    paymentUuid:
      row.payment_uuid || null,
    refPaymentUuid:
      row.ref_payment_uuid || null,
    createdAt: row.created_at,
  };
}

async function createPaymentSettlement({
  tx,
  settlementId = null,
  restaurantId,
  tableNumber,
  batchId = null,
  invoiceNumber = null,

  grossAmount = 0,
  pricingDiscountAmount = 0,
  happyHourDiscountAmount = 0,
  dealAdjustedAmount = 0,

  voucherId = null,
  voucherCode = null,
  voucherDiscountAmount = 0,

  manualDiscountAmount = 0,
  serviceChargeAmount = 0,
  finalAmount = 0,

  appliedRuleIds = [],
  posOrderIds = [],
  pricingSnapshot = {},

  source = "pos",
  createdByUserId = null,
}) {
  if (!tx?.qGet) {
    throw new Error(
      "createPaymentSettlement requires an active database transaction"
    );
  }

  const safeSettlementId =
    settlementId == null ||
    settlementId === ""
      ? null
      : String(
          settlementId
        ).trim();

  if (
    safeSettlementId &&
    !isUuid(
      safeSettlementId
    )
  ) {
    throw new Error(
      "Invalid payment settlement UUID"
    );
  }

  const money = (value) =>
    Number(Number(value || 0).toFixed(2));

  const cleanOrderIds = Array.isArray(posOrderIds)
    ? posOrderIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];

  const cleanRuleIds = Array.isArray(appliedRuleIds)
    ? appliedRuleIds.filter(
        (id) => id !== null && id !== undefined
      )
    : [];

  const safeBatchId =
    batchId && isUuid(batchId)
      ? String(batchId)
      : null;

  const row = await tx.qGet(
    `
    INSERT INTO public.payment_settlements (
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
      created_at,
      id
    )
    VALUES (
      $1,
      $2,
      $3::uuid,
      $4,

      $5,
      $6,
      $7,
      $8,

      $9,
      $10,
      $11,

      $12,
      $13,
      $14,

      $15::jsonb,
      $16::jsonb,
      $17::jsonb,

      $18,
      $19,
      NOW(),
      COALESCE(
        $20::uuid,
        gen_random_uuid()
      )
    )
    RETURNING *
    `,
    [
      Number(restaurantId),
      String(tableNumber),
      safeBatchId,
      invoiceNumber != null
        ? Number(invoiceNumber)
        : null,

      money(grossAmount),
      money(pricingDiscountAmount),
      money(happyHourDiscountAmount),
      money(dealAdjustedAmount),

      voucherId
        ? Number(voucherId)
        : null,
      voucherCode
        ? String(voucherCode).trim()
        : null,
      money(voucherDiscountAmount),

      money(manualDiscountAmount),
      money(serviceChargeAmount),
      money(finalAmount),

      JSON.stringify(cleanRuleIds),
      JSON.stringify(cleanOrderIds),
      JSON.stringify(
        pricingSnapshot &&
          typeof pricingSnapshot === "object"
          ? pricingSnapshot
          : {}
      ),

      String(source || "pos"),
      createdByUserId
        ? Number(createdByUserId)
        : null,

      safeSettlementId,
    ]
  );

  if (!row?.id) {
    throw new Error("Payment settlement was not created");
  }

  return {
    id: String(row.id),
    restaurantId: Number(row.restaurant_id),
    tableNumber: row.table_number,
    batchId: row.batch_id || null,
    invoiceNumber:
      row.invoice_number != null
        ? Number(row.invoice_number)
        : null,
    grossAmount: Number(row.gross_amount || 0),
    pricingDiscountAmount: Number(
      row.pricing_discount_amount || 0
    ),
    happyHourDiscountAmount: Number(
      row.happy_hour_discount_amount || 0
    ),
    dealAdjustedAmount: Number(
      row.deal_adjusted_amount || 0
    ),
    voucherDiscountAmount: Number(
      row.voucher_discount_amount || 0
    ),
    manualDiscountAmount: Number(
      row.manual_discount_amount || 0
    ),
    serviceChargeAmount: Number(
      row.service_charge_amount || 0
    ),
    finalAmount: Number(row.final_amount || 0),
    createdAt: row.created_at,
  };
}

async function sumPosOrdersByIds({ qGetFn, restaurantId, itemIds = [] }) {
  if (!itemIds.length) return 0;

  const isPg = kind === "pg";
  const placeholders = itemIds.map((_, i) => (isPg ? `$${i + 2}` : `?`)).join(",");

  const row = await qGetFn(
    isPg
      ? `SELECT COALESCE(SUM(COALESCE(remaining_price, total_price, 0)),0)::numeric AS total
         FROM public.pos_orders
         WHERE restaurant_id = $1
           AND id IN (${placeholders})
           AND paid = 0`
      : `SELECT COALESCE(SUM(total_price),0) AS total
         FROM pos_orders
         WHERE restaurant_id = ?
           AND id IN (${placeholders})
           AND paid = 0`,
    [restaurantId, ...itemIds]
  );

  return Number(row?.total || 0);
}

async function clearTableSessionByName(qRunFn, rid, tableName) {
  const name = String(tableName || "").trim();
  if (!rid || !name) return;

  if (kind === "pg") {
    await qRunFn(
      `
      DELETE FROM public.pos_table_sessions
      WHERE restaurant_id = $1
        AND table_id IN (
          SELECT id
          FROM public.tables
          WHERE restaurant_id = $1
            AND LOWER(TRIM(name)) = LOWER(TRIM($2))
        )
      `,
      [rid, name]
    );
  } else {
    await qRunFn(
      `
      DELETE FROM pos_table_sessions
      WHERE restaurant_id = ?
        AND table_id IN (
          SELECT id
          FROM tables
          WHERE restaurant_id = ?
            AND LOWER(TRIM(name)) = LOWER(TRIM(?))
        )
      `,
      [rid, rid, name]
    );
  }
}
function stableStringify(obj) {
  try {
    const o = obj && typeof obj === "object" ? obj : {};
    const keys = Object.keys(o).sort();
    const out = {};
    for (const k of keys) out[k] = o[k];
    return JSON.stringify(out);
  } catch {
    return "{}";
  }
}

function aggregateItems(items = []) {
  const map = new Map();

  for (const it of items) {
    const name = String(it.meal_name || it.item_name || it.name || "").trim();

    const cat = String(it.category || it.item_type || "meals").toLowerCase();
    const source = String(it.item_source || it.source || "").toLowerCase();

    const id = String(
      it.meal_id ??
      it.menu_item_id ??
      it.stock_id ??
      it.item_id ??
      it.id ??
      ""
    ).trim();

    const optionsObj = parseOptionsToObject(it.options, it.options_json) || {};
    const optKey = stableStringify(optionsObj);

    const noteKey = String(it.note || "").trim();
    const unit = Number(it.price_per_unit ?? it.price ?? 0);

    const key = `${source}__${cat}__${id}__${name}__${unit}__${optKey}__${noteKey}`;

    if (!map.has(key)) {
      map.set(key, {
        ...it,
        options: optionsObj,
        options_json: undefined,
        quantity: Number(it.quantity || 1),
      });
    } else {
      const cur = map.get(key);
      cur.quantity = Number(cur.quantity || 1) + Number(it.quantity || 1);

      if (it.total_price != null || cur.total_price != null) {
        const a = Number(cur.total_price || 0);
        const b = Number(it.total_price || 0);
        cur.total_price = Number((a + b).toFixed(2));
      }

      map.set(key, cur);
    }
  }

  return Array.from(map.values());
}


function parseOptionsToObject(options, options_json) {
  let obj = options_json ?? options ?? {};
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      obj = {};
    }
  }
  if (obj == null || typeof obj !== "object") obj = {};
  return obj;
}

function safeJsonString(input) {
  if (input == null) return JSON.stringify({});
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return JSON.stringify(parsed);
    } catch {
      return JSON.stringify({ raw: input });
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return JSON.stringify({ raw: String(input) });
  }
}

function normalizeCategory(raw) {
  const c = String(raw || "").toLowerCase();
  if (c.startsWith("drink")) return "drinks";
  if (c.startsWith("dessert")) return "desserts";
  if (c === "drinks" || c === "desserts" || c === "meals") return c;
  return "meals";
}

function normalizeOrderType(raw) {
  const t = String(raw || "").toLowerCase();
  if (t === "takeaway" || t === "delivery") return t;
  return "dine-in";
}

function validateOptionsAgainstSchema(schema = [], chosen = {}) {
  const errs = [];

  for (const opt of (Array.isArray(schema) ? schema : [])) {
    const id = String(opt.id || "").trim();
    if (!id) continue;

    const required = !!opt.required;
    const type = String(opt.type || "single").toLowerCase();
    const val = chosen?.[id];

    const missing =
      type === "multi" ? (!Array.isArray(val) || val.length === 0)
      : type === "text" ? (!String(val || "").trim())
      : (!String(val || "").trim()); // single

    if (required && missing) {
      errs.push(opt.label || id);
    }
  }

  return errs;
}

function calculateLegacyCartSubtotal(items = []) {
  let subtotalPennies = 0;

  for (const item of items || []) {
    if (isManualMiscItem(item)) {
      continue;
    }

    const quantity = Math.max(
      1,
      Number.parseInt(item.quantity, 10) || 1
    );

    const rawTotal = Number(item.total_price);
    const rawUnit = Number(
      item.price_per_unit ?? item.price
    );

    const lineTotal = Number.isFinite(rawTotal)
      ? rawTotal
      : Number.isFinite(rawUnit)
        ? rawUnit * quantity
        : 0;

    subtotalPennies += Math.round(lineTotal * 100);
  }

  return Number((subtotalPennies / 100).toFixed(2));
}

function extractPricingOptions(options) {
  let parsed = options ?? {};

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  // POS OptionsPicker wrapper:
  // {
  //   display: human-readable information,
  //   raw: authoritative optionId -> choiceId selections,
  //   meta: frontend metadata
  // }
  if (
    parsed.raw &&
    typeof parsed.raw === "object" &&
    !Array.isArray(parsed.raw)
  ) {
    return parsed.raw;
  }

  // QR/kiosk or older payloads may already send the raw selections.
  return parsed;
}

function getCanonicalPricingItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => !isManualMiscItem(item))
    .map((item) => ({
      ...item,

      // Only the pricing-engine copy is unwrapped.
      // The original live items remain unchanged.
      options: extractPricingOptions(
        item.options_json ?? item.options
      ),
    }));
}

function logPricingComparison({
  restaurantId,
  tableName,
  source,
  submittedItems,
  canonicalCart,
}) {
  const legacySubtotal =
    calculateLegacyCartSubtotal(submittedItems);

  const authoritativeSubtotal =
    Number(canonicalCart?.subtotal || 0);

  const difference = Number(
    (
      authoritativeSubtotal -
      legacySubtotal
    ).toFixed(2)
  );

  const comparison = {
    restaurant_id: Number(restaurantId),
    table_number: String(tableName),
    source: String(source || "pos"),
    legacy_subtotal: legacySubtotal,
    authoritative_subtotal: authoritativeSubtotal,
    difference,
    matched: Math.abs(difference) < 0.01,
    item_count: canonicalCart?.items?.length || 0,
  };

  if (comparison.matched) {
    console.log(
      "✅ PRICING SHADOW MATCH:",
      comparison
    );
  } else {
    console.warn(
      "⚠️ PRICING SHADOW MISMATCH:",
      comparison
    );
  }

  return comparison;
}

function isManualMiscItem(item) {
  return (
    item?.item_source === "misc" ||
    item?.custom_item === true ||
    String(item?.item_type || "").toLowerCase() === "misc" ||
    String(item?.category || "").toLowerCase() === "misc"
  );
}

async function assertItemsOrderable(
  tx,
  restaurantId,
  items,
  {
    stockDeductionEnabled = true,
    portionTrackingMode = "ingredients",
  } = {}
) {
  const orderableError = (
    message,
    status = 400,
    code = "INVALID_ORDER_ITEM"
  ) => {
    const err = new Error(message);
    err.status = status;
    err.publicMessage = message;
    err.code = code;
    return err;
  };

  const normalizeItemType = (t) => {
    const s = String(t || "").toLowerCase().trim();
    if (s === "misc") return "misc";
    if (s.startsWith("drink")) return "drinks";
    if (s.startsWith("dessert")) return "desserts";
    return "meals";
  };

  const mode = String(portionTrackingMode || "ingredients").toLowerCase();
  const manualMode = mode === "manual";
  const ingredientMode = mode === "ingredients";
const posOnlyMode = mode === "off";

  for (const raw of items || []) {
    const hasStockOverride =
      raw?.stock_override === true ||
      raw?.stock_override === "true" ||
      raw?.allow_stock_override === true ||
      raw?.allow_stock_override === "true";

    if (isManualMiscItem(raw)) {
      const name = String(raw.meal_name || raw.item_name || raw.name || "").trim();
      const qty = Number(raw.quantity || 0);
      const price = Number(raw.price_per_unit ?? raw.price ?? raw.total_price ?? 0);

      if (!name) throw new Error("Invalid misc item: missing name");
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error(`Invalid misc item quantity for "${name}"`);
      }
      if (!Number.isFinite(price) || price < 0) {
        throw new Error(`Invalid misc item price for "${name}"`);
      }

      continue;
    }

    const itemType = normalizeItemType(raw.item_type || raw.category);
    const mealId = Number(raw.meal_id || 0);
    const menuItemId = Number(raw.menu_item_id || 0);
    const qtyNeeded = Math.max(1, Number(raw.quantity || 1));

    if (itemType === "meals") {
      if (!mealId) {
        throw orderableError(
  `Invalid meal item: missing meal_id for "${
    raw.meal_name || raw.name || "Unknown item"
  }"`,
  400,
  "MISSING_MEAL_ID"
);
      }

      const meal = await tx.qGet(
        tx.kind === "pg"
          ? `
            SELECT
  id,
  name,
  out_of_stock
FROM public.meals
            WHERE restaurant_id = $1
              AND id = $2
            LIMIT 1
          `
          : `
            SELECT
              id,
              name,
              out_of_stock
            FROM meals
            WHERE restaurant_id = ?
              AND id = ?
            LIMIT 1
          `,
        [restaurantId, mealId]
      );

      if (!meal?.id) {
  throw orderableError(
    `Meal not found (id=${mealId})`,
    404,
    "MEAL_NOT_FOUND"
  );
}

      if (!posOnlyMode && !!meal.out_of_stock && !hasStockOverride) {
  throw new Error(`${meal.name} is out of stock`);
}

if (!posOnlyMode && !!meal.out_of_stock && hasStockOverride) {
          console.log("⚠️ STOCK OVERRIDE ACCEPTED: manager out-of-stock flag", {
          mealName: meal.name,
          reason: raw?.stock_override_reason || null,
        });
      }

      if (stockDeductionEnabled && ingredientMode) {
        const portionsLeft = await getMealPortionsLeft(tx, mealId, restaurantId);

        if (
          portionsLeft !== null &&
          Number(portionsLeft) < qtyNeeded &&
          !hasStockOverride
        ) {
          throw new Error(
            `${meal.name} does not have enough stock. Left: ${Number(portionsLeft)}, requested: ${qtyNeeded}`
          );
        }

        if (
          portionsLeft !== null &&
          Number(portionsLeft) < qtyNeeded &&
          hasStockOverride
        ) {
          console.log("⚠️ STOCK OVERRIDE ACCEPTED: insufficient stock", {
            mealName: meal.name,
            left: Number(portionsLeft),
            requested: qtyNeeded,
            reason: raw?.stock_override_reason || null,
          });
        }
      }

      continue;
    }

    if (itemType === "drinks" || itemType === "desserts") {
      if (!menuItemId) {
        throw orderableError(
  `Invalid menu item: missing menu_item_id for "${
    raw.meal_name || raw.name || "Unknown item"
  }"`,
  400,
  "MISSING_MENU_ITEM_ID"
);
      }

      const expectedType = itemType === "drinks" ? "drink" : "dessert";

      const menuItem = await tx.qGet(
        tx.kind === "pg"
          ? `
            SELECT
              id,
              name,
              type,
              out_of_stock
            FROM public.menu_items
            WHERE restaurant_id = $1
              AND id = $2
              AND LOWER(TRIM(COALESCE(type, ''))) = $3
            LIMIT 1
          `
          : `
            SELECT
              id,
              name,
              type,
              out_of_stock
            FROM menu_items
            WHERE restaurant_id = ?
              AND id = ?
              AND LOWER(TRIM(COALESCE(type, ''))) = ?
            LIMIT 1
          `,
        [restaurantId, menuItemId, expectedType]
      );

      if (!menuItem?.id) {
        throw orderableError(
  `${
    itemType === "drinks" ? "Drink" : "Dessert"
  } not found (id=${menuItemId})`,
  404,
  "MENU_ITEM_NOT_FOUND"
);
      }

      if (!posOnlyMode && !!menuItem.out_of_stock && !hasStockOverride) {
  throw new Error(`${menuItem.name} is out of stock`);
}

if (!posOnlyMode && !!menuItem.out_of_stock && hasStockOverride) {        console.log("⚠️ STOCK OVERRIDE ACCEPTED: menu item out-of-stock flag", {
          itemName: menuItem.name,
          reason: raw?.stock_override_reason || null,
        });
      }


      continue;
    }
  }
}

// ✅ IMPORTANT: ALL DB writes inside a tx must use tx.qRun/tx.qGet/tx.qAll
async function insertPosItems({
  tx,
  restaurantId,
  tableName,
  items,
  batchId,
  stockDeductionEnabled = true,
  holdKdsUntilPaid = false,
}) {
  if (!tx) throw new Error("insertPosItems missing tx");
  if (!restaurantId) throw new Error("restaurantId missing");
  if (!tableName) throw new Error("tableName missing");

  if (!Array.isArray(items) || items.length === 0) {
    return { batchId: batchId || null, deductionReport: { deducted: [], warnings: [] } };
  }

  const aggregated = typeof aggregateItems === "function" ? aggregateItems(items) : items;

  const crypto = require("crypto");
  const realBatchId =
    typeof batchId === "string" && isUuid(batchId) ? batchId : crypto.randomUUID();

  const deductionReport = { deducted: [], warnings: [] };
  const isPg = tx.kind === "pg";

  const INSERT_SQL = isPg
    ? `
      INSERT INTO orders (
        restaurant_id, table_number, meal_name, quantity,
        price_per_unit, total_price, paid, order_status,
        category, category_id, order_type, options, note, special_requests,
        batch_id, created_at,
        is_priority
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,
        $15::uuid, NOW(),
        $16
      )
    `
    : `
      INSERT INTO orders (
        restaurant_id, table_number, meal_name, quantity,
        price_per_unit, total_price, paid, order_status,
        category, category_id, order_type, options, note, special_requests,
        batch_id, created_at,
        is_priority
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP, ?)
    `;

  for (const item of aggregated) {
    const meal_name = String(item.meal_name || item.item_name || item.name || "").trim();
    if (!meal_name) continue;

    const quantity = Number.parseInt(item.quantity, 10) || 1;

    const rawTotal = Number(item.total_price);
    const rawUnit = Number(item.price_per_unit ?? item.price);

    const unit = Number.isFinite(rawUnit)
      ? rawUnit
      : Number.isFinite(rawTotal)
        ? rawTotal / quantity
        : 0;

    const total_price = Number.isFinite(rawTotal)
      ? rawTotal
      : Number((unit * quantity).toFixed(2));

    const category = normalizeCategory(item.category || item.item_type || "meals");
    const order_type = normalizeOrderType(item.order_type || item.orderType || "dine-in");

    const note = item.note ?? item.notes ?? null;
    const special_requests = item.special_requests ?? item.specialRequests ?? null;

    const sourceRaw = String(item.item_source || item.source || "").trim().toLowerCase();

const sourceNorm =
  sourceRaw === "meal" ? "meals" :
  sourceRaw === "menu" ? "menu_items" :
  sourceRaw ||
  (item.meal_id || item.mealId ? "meals" :
   item.menu_item_id || item.menuItemId ? "menu_items" :
   item.stock_id || item.stockId ? "stock" :
   "");

   console.log("🧾 POS ITEM SOURCE DEBUG:", {
  meal_name,
  meal_id: item.meal_id,
  menu_item_id: item.menu_item_id,
  stock_id: item.stock_id,
  item_source: item.item_source,
  source: item.source,
  sourceNorm,
});

    // ✅ chosen options object (always)
const chosenOptions =
  item.authoritative === true
    ? (
        item.selected_options ||
        item.options ||
        {}
      )
    : (
        parseOptionsToObject(
          item.options,
          item.options_json
        ) || {}
      );

  const canonicalDisplay =
  item.authoritative === true &&
  item.options_display &&
  typeof item.options_display === "object" &&
  !Array.isArray(item.options_display)
    ? item.options_display
    : null;

    // ✅ validate required options (based on source)
if (
  item.authoritative !== true &&
  sourceNorm === "meals"
) {      const mealId = Number(item.meal_id ?? item.mealId ?? 0) || null;
      const resolvedMealId = mealId || (await resolveMealIdByName(tx, restaurantId, meal_name));
      if (resolvedMealId) {
        const m = await tx.qGet(
          sqlByKind(
            tx,
            `SELECT options_schema FROM public.meals WHERE restaurant_id = $1 AND id = $2 LIMIT 1`,
            `SELECT options_schema FROM meals WHERE restaurant_id = ? AND id = ? LIMIT 1`
          ),
          [restaurantId, Number(resolvedMealId)]
        );
        const schema = parseOptionsToObject(m?.options_schema) || [];
        const missing = validateOptionsAgainstSchema(schema, chosenOptions);
        if (missing.length) throw new Error(`Missing required option(s): ${missing.join(", ")}`);
      }
    }

if (
  item.authoritative !== true &&
  sourceNorm === "menu_items"
) {      const menuItemId = Number(item.menu_item_id ?? 0) || null;
      if (menuItemId) {
        const mi = await tx.qGet(
          sqlByKind(
            tx,
            `SELECT options_schema FROM public.menu_items WHERE restaurant_id = $1 AND id = $2 LIMIT 1`,
            `SELECT options_schema FROM menu_items WHERE restaurant_id = ? AND id = ? LIMIT 1`
          ),
          [restaurantId, Number(menuItemId)]
        );
        const schema = parseOptionsToObject(mi?.options_schema) || [];
        const missing = validateOptionsAgainstSchema(schema, chosenOptions);
        if (missing.length) throw new Error(`Missing required option(s): ${missing.join(", ")}`);
      }
    }

    // ✅ store options correctly (PG jsonb object, SQLite string)
    const optionsForStorage =
  canonicalDisplay &&
  Object.keys(canonicalDisplay).length
    ? {
        ...chosenOptions,
        display: canonicalDisplay,
      }
    : chosenOptions;

const optionsVal =
  isPg
    ? optionsForStorage
    : safeJsonString(optionsForStorage);

    // ✅ priority (support old payloads too)
    const is_priority = !!(item.is_priority ?? item.is_starred);

    // ✅ category_id resolution (for THIS item only)
    let categoryId = item.category_id != null ? Number(item.category_id) : null;

    const itemId =
      item.meal_id ??
      item.mealId ??
      item.menu_item_id ??
      item.item_id ??
      item.itemId ??
      item.id ??
      null;

    if (!categoryId && itemId) {
      const m = await tx.qGet(
        sqlByKind(
          tx,
          `SELECT category_id FROM public.meals WHERE id = $1 AND restaurant_id = $2 LIMIT 1`,
          `SELECT category_id FROM meals WHERE id = ? AND restaurant_id = ? LIMIT 1`
        ),
        [Number(itemId), restaurantId]
      );
      if (m?.category_id != null) categoryId = Number(m.category_id);
    }

    if (!categoryId && itemId) {
      const s = await tx.qGet(
        sqlByKind(
          tx,
          `SELECT category_id FROM public.stock WHERE id = $1 AND restaurant_id = $2 LIMIT 1`,
          `SELECT category_id FROM stock WHERE id = ? AND restaurant_id = ? LIMIT 1`
        ),
        [Number(itemId), restaurantId]
      );
      if (s?.category_id != null) categoryId = Number(s.category_id);
    }

    if (!categoryId && item.category_name) {
      const c = await tx.qGet(
        sqlByKind(
          tx,
          `SELECT id FROM public.categories
           WHERE restaurant_id = $1
             AND LOWER(TRIM(name)) = LOWER(TRIM($2))
           LIMIT 1`,
          `SELECT id FROM categories
           WHERE restaurant_id = ?
             AND LOWER(TRIM(name)) = LOWER(TRIM(?))
           LIMIT 1`
        ),
        [restaurantId, String(item.category_name).trim()]
      );
      if (c?.id != null) categoryId = Number(c.id);
    }

    console.log("🚦 KDS INSERT CHECK:", {
  meal_name,
  holdKdsUntilPaid,
  willInsertToKds: !holdKdsUntilPaid,
});


    // ✅ insert order row (placeholders match params = 16)
    if (!holdKdsUntilPaid) {
  await tx.qRun(INSERT_SQL, [
    restaurantId,
    tableName,
    meal_name,
    quantity,
    Number(unit || 0),
    Number(total_price || 0),
    0,
    "pending",
    category,
    categoryId,
    order_type,
    optionsVal,
    note,
    special_requests,
    realBatchId,
    isPg ? is_priority : (is_priority ? 1 : 0),
  ]);
}
   // ✅ stock deduction can be switched OFF per restaurant
if (stockDeductionEnabled) {
  // ✅ base deduction (meals/menu/stock fallback)
  let baseDeductDone = false;

  if (sourceNorm === "meals") {
    const mealId = Number(item.meal_id ?? item.mealId ?? 0) || null;
    const resolvedMealId =
      mealId || (await resolveMealIdByName(tx, restaurantId, meal_name));

    if (resolvedMealId) {
      const rep = await deductStockFromMealOrder(
        tx,
        Number(resolvedMealId),
        quantity,
        restaurantId
      );

      if (rep?.deducted?.length) deductionReport.deducted.push(...rep.deducted);
      if (rep?.warnings?.length) deductionReport.warnings.push(...rep.warnings);

      baseDeductDone = true;
    }
  }

  if (!baseDeductDone && sourceNorm === "menu_items") {
    const menuItemId = Number(item.menu_item_id ?? item.menuItemId ?? 0) || null;

    if (menuItemId && typeof deductStockFromMenuItem === "function") {
      const rep = await deductStockFromMenuItem(
        tx,
        menuItemId,
        quantity,
        restaurantId
      );

      if (rep?.deducted?.length) deductionReport.deducted.push(...rep.deducted);
      if (rep?.warnings?.length) deductionReport.warnings.push(...rep.warnings);

      baseDeductDone = true;
    }
  }

  if (!baseDeductDone && sourceNorm === "stock") {
    const stockId = Number(item.stock_id ?? item.stockId ?? 0) || null;

    if (stockId) {
      const rep = await deductStockByStockId(
        tx,
        stockId,
        quantity,
        restaurantId
      );

      if (rep?.deducted?.length) deductionReport.deducted.push(...rep.deducted);
      if (rep?.warnings?.length) deductionReport.warnings.push(...rep.warnings);

      baseDeductDone = true;
    }
  }

  if (!baseDeductDone) {
    const rep = await deductStockByItemName(
      tx,
      meal_name,
      quantity,
      restaurantId
    );

    if (rep?.deducted?.length) deductionReport.deducted.push(...rep.deducted);
    if (rep?.warnings?.length) deductionReport.warnings.push(...rep.warnings);
  }

  // ✅ options/add-ons deduction only when stock deduction is enabled
 const optionDeduction =
  item.authoritative === true
    ? await deductCanonicalOptions(tx, {
        restaurantId,
        quantity,
        optionDetails:
          item.option_details || [],
      })
    : await deductFromOptions(tx, {
        restaurantId,
        quantity,
        item_source: sourceNorm,
        meal_id: item.meal_id,
        menu_item_id: item.menu_item_id,
        chosenOptions,
      });

if (optionDeduction?.deducted?.length) {
  deductionReport.deducted.push(
    ...optionDeduction.deducted
  );
}

if (optionDeduction?.warnings?.length) {
  deductionReport.warnings.push(
    ...optionDeduction.warnings
  );
}

} else {
  deductionReport.warnings.push({
    type: "STOCK_DEDUCTION_DISABLED",
    message: "Stock deduction is disabled for this restaurant.",
  });
}
  }
  return { batchId: realBatchId, deductionReport };
}

// helper for name → id (PG/SQLite safe)
async function resolveMealIdByName(tx, restaurantId, meal_name) {
  const row = await tx.qGet(
    sqlByKind(
      tx,
      `
      SELECT id
      FROM public.meals
      WHERE restaurant_id = $1
        AND LOWER(TRIM(name)) = LOWER(TRIM($2))
      LIMIT 1
      `,
      `
      SELECT id
      FROM meals
      WHERE restaurant_id = ?
        AND LOWER(TRIM(name)) = LOWER(TRIM(?))
      LIMIT 1
      `
    ),
    [restaurantId, meal_name]
  );
  return row?.id ?? null;
}

async function deductCanonicalOptions(
  tx,
  {
    restaurantId,
    quantity,
    optionDetails,
  }
) {
  const deducted = [];
  const warnings = [];

  const orderQuantity =
    Math.max(1, Number(quantity || 1));

  for (const option of optionDetails || []) {
    if (
      !option ||
      option.option_type === "text"
    ) {
      continue;
    }

    const choices = Array.isArray(option.choices)
      ? option.choices
      : [];

    for (const choice of choices) {
      const stockId =
        Number(choice?.stock_id || 0) || null;

      const deductQty =
        Number(choice?.deduct_qty || 0);

      if (
        !stockId ||
        !Number.isFinite(deductQty) ||
        deductQty <= 0
      ) {
        continue;
      }

      const amount =
        deductQty * orderQuantity;

      const rep = await deductStockByStockId(
        tx,
        stockId,
        amount,
        restaurantId
      );

      if (rep?.deducted?.length) {
        deducted.push(
          ...rep.deducted.map((entry) => ({
            ...entry,
            deduction_source: "canonical_option",
            option_id:
              option.option_id || null,
            choice_id:
              choice.id || null,
          }))
        );
      }

      if (rep?.warnings?.length) {
        warnings.push(
          ...rep.warnings.map((warning) => ({
            type: "OPTION_STOCK_WARNING",
            option_id:
              option.option_id || null,
            choice_id:
              choice.id || null,
            stock_id: stockId,
            warning,
          }))
        );
      }
    }
  }

  return {
    deducted,
    warnings,
  };
}

async function deductFromOptions(tx, {
  restaurantId,
  quantity,         // order quantity
  item_source,      // "meals" | "menu_items" | ...
  meal_id,
  menu_item_id,
  chosenOptions,    // object returned by OptionsPicker
}) {
  try {
    const source = String(item_source || "").toLowerCase();

    let schemaRow = null;

    if (source === "meals" && meal_id) {
      schemaRow = await tx.qGet(
        `SELECT options_schema FROM public.meals WHERE restaurant_id = $1 AND id = $2 LIMIT 1`,
        [restaurantId, Number(meal_id)]
      );
    } else if (source === "menu_items" && menu_item_id) {
      schemaRow = await tx.qGet(
        `SELECT options_schema FROM public.menu_items WHERE restaurant_id = $1 AND id = $2 LIMIT 1`,
        [restaurantId, Number(menu_item_id)]
      );
    } else {
      return { deducted: [], warnings: [] };
    }

    const schema = Array.isArray(schemaRow?.options_schema)
      ? schemaRow.options_schema
      : (schemaRow?.options_schema ? JSON.parse(schemaRow.options_schema) : []);

    const deducted = [];
    const warnings = [];

    for (const opt of schema || []) {
      if (!opt || opt.type === "text") continue;

      const chosen = chosenOptions?.[opt.id];

      // --- single
      if (opt.type === "single") {
        if (!chosen) continue;
        const ch = (opt.choices || []).find(x => String(x.id) === String(chosen));
        if (!ch?.stock_id) continue;

        const deductQty = Number(ch.deduct_qty || 0);
        if (!Number.isFinite(deductQty) || deductQty <= 0) continue;

        const amount = deductQty * Number(quantity || 1);

        await tx.qRun(
          `UPDATE public.stock
           SET quantity = GREATEST(0, quantity - $1)
           WHERE restaurant_id = $2 AND id = $3`,
          [amount, restaurantId, Number(ch.stock_id)]
        );

        deducted.push({ stock_id: Number(ch.stock_id), amount });
      }

      // --- multi
      if (opt.type === "multi") {
        const arr = Array.isArray(chosen) ? chosen : [];
        if (!arr.length) continue;

        for (const choiceId of arr) {
          const ch = (opt.choices || []).find(x => String(x.id) === String(choiceId));
          if (!ch?.stock_id) continue;

          const deductQty = Number(ch.deduct_qty || 0);
          if (!Number.isFinite(deductQty) || deductQty <= 0) continue;

          const amount = deductQty * Number(quantity || 1);

          await tx.qRun(
            `UPDATE public.stock
             SET quantity = GREATEST(0, quantity - $1)
             WHERE restaurant_id = $2 AND id = $3`,
            [amount, restaurantId, Number(ch.stock_id)]
          );

          deducted.push({ stock_id: Number(ch.stock_id), amount });
        }
      }
    }

    return { deducted, warnings };
  } catch (e) {
    // Don’t crash the whole order if options deduction fails — log + warn
    console.error("⚠️ deductFromOptions failed:", e);
    return { deducted: [], warnings: [{ reason: "options_deduction_failed" }] };
  }
}

async function ensurePaymentEditable({ rid, paymentId }) {
  const isPg = kind === "pg";

  const row = await qGet(
    isPg
      ? `
        SELECT
          p.id,
          p.status AS payment_status,
          p.cashup_session_id
        FROM public.payments p
        WHERE p.restaurant_id = $1
          AND p.id = $2
        LIMIT 1
      `
      : `
        SELECT
          p.id,
          p.status AS payment_status,
          p.cashup_session_id
        FROM payments p
        WHERE p.restaurant_id = ?
          AND p.id = ?
        LIMIT 1
      `,
    [rid, paymentId]
  );

  if (!row) {
    return { ok: false, code: 404, error: "Payment not found" };
  }

  const paymentStatus = String(row.payment_status || "").toLowerCase();

  if (paymentStatus !== "completed") {
    return {
      ok: false,
      code: 400,
      error: "Only completed payments can be changed",
    };
  }

  return { ok: true };
}

async function resolveUsersDisplayNameExpr() {
  if (kind !== "pg") return "u.username"; // fallback for sqlite; adjust if needed

  const cols = await qAll(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='users'`,
    []
  );

  const set = new Set((cols || []).map(r => r.column_name));

  const pick = (...names) => names.find(n => set.has(n)) || null;

  const full = pick("full_name", "name");
  const user = pick("username", "user_name");
  const email = pick("email");

  // build COALESCE chain only with existing columns
  const parts = [];
  if (full) parts.push(`NULLIF(TRIM(u.${full}), '')`);
  if (user) parts.push(`NULLIF(TRIM(u.${user}), '')`);
  if (email) parts.push(`NULLIF(TRIM(u.${email}), '')`);

  if (!parts.length) return `'Staff'`; // no usable column exists
  return `COALESCE(${parts.join(", ")}, 'Staff')`;
}

async function insertPosBillRow(
  tx,
  {
    restaurantId,
    tableName,
    item,
    batchId,
    total_price,
    category,
    category_id,
    source: orderSource,
    table_allergy_codes,
    item_allergen_contains,
    allergen_conflicts,
    strict_cross_contamination,
    table_covers,
  }
) {
  const qty = Math.max(1, Number(item.quantity || 1));

  const mealIdText = String(
    item.meal_id ?? item.menu_item_id ?? item.stock_id ?? item.item_id ?? item.id ?? ""
  ).trim();

  const itemName = String(item.meal_name || item.item_name || item.name || "").trim();

  const station = String(item?.item_type || item?.category || "").toLowerCase();

  const itemType =
    station === "meals" ? "meal" :
    station === "drinks" ? "drink" :
    station === "desserts" ? "dessert" :
    "misc";

  const note = item.note ?? null;
  
  const rawOptions =
  item?.selected_options &&
  typeof item.selected_options === "object" &&
  !Array.isArray(item.selected_options)
    ? item.selected_options
    : (
        parseOptionsToObject(
          item.options,
          item.options_json
        ) || {}
      );

const displayOptions =
  item?.options_display &&
  typeof item.options_display === "object" &&
  !Array.isArray(item.options_display)
    ? item.options_display
    : {};

const optionsObj = {
  raw: rawOptions,
  display: displayOptions,
};

const optionsVal =
  tx.kind === "pg"
    ? optionsObj
    : JSON.stringify(optionsObj);

  const isStarred = !!(item.is_starred ?? item.is_priority ?? item.isStarred);

  let categoryId = category_id != null ? Number(category_id) : null;

  const numericId = Number(mealIdText);
  const hasNumericId = Number.isFinite(numericId) && numericId > 0;

  if (!categoryId && hasNumericId) {
    const m = await tx.qGet(
      tx.kind === "pg"
        ? `SELECT category_id FROM meals WHERE id = $1 AND restaurant_id = $2 LIMIT 1`
        : `SELECT category_id FROM meals WHERE id = ? AND restaurant_id = ? LIMIT 1`,
      [numericId, Number(restaurantId)]
    );

    if (m?.category_id != null) categoryId = Number(m.category_id);
  }

  if (!categoryId && hasNumericId) {
    const s = await tx.qGet(
      tx.kind === "pg"
        ? `SELECT category_id FROM stock WHERE id = $1 AND restaurant_id = $2 LIMIT 1`
        : `SELECT category_id FROM stock WHERE id = ? AND restaurant_id = ? LIMIT 1`,
      [numericId, Number(restaurantId)]
    );

    if (s?.category_id != null) categoryId = Number(s.category_id);
  }

  const lineTotal = Number(total_price || 0);
  const unitTotal = Number((lineTotal / qty).toFixed(2));

const vatRate =
  item?.vat_rate === null ||
  item?.vat_rate === undefined ||
  String(item?.vat_rate).trim() === ""
    ? null
    : Number(item.vat_rate);


const unitVatNet =
  vatRate === null
    ? unitTotal
    : vatRate <= 0
      ? unitTotal
      : Number(
          (
            unitTotal /
            (
              1 +
              vatRate / 100
            )
          ).toFixed(2)
        );


const unitVatAmount =
  Number(
    (
      unitTotal -
      unitVatNet
    ).toFixed(2)
  );

  const safeSource = String(orderSource || "pos").trim().toLowerCase();

  const safeOrderStatus = String(item.order_status || "open").trim().toLowerCase();

  const safeExpiresAt =
    item.expires_at
      ? item.expires_at
      : safeOrderStatus === "pending_payment"
        ? new Date(Date.now() + 20 * 60 * 1000).toISOString()
        : null;

  const createdIds = [];

  if (tx.kind === "pg") {
    for (let i = 0; i < qty; i++) {
      const created = await tx.qGet(
  `
  INSERT INTO pos_orders (
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
    table_allergy_codes,
    item_allergen_contains,
    allergen_conflicts,
    strict_cross_contamination,
    table_covers,
    amount_paid,
    remaining_price,
    source,
    expires_at
  )
  VALUES (
    $1,$2,$3,$4,$5,
    $6,$7,$8,
    $9,$10,$11,$12,
    $13,$14,
    0,
    $15,$16,$17::uuid,
    NOW(),
    $18,$19,
    $20::jsonb,
    $21::jsonb,
    $22::jsonb,
    $23,$24,$25,$26,$27,$28
  )
  RETURNING id
  `,
  [
    Number(restaurantId),
    String(tableName),

    item.meal_id
      ? Number(item.meal_id)
      : null,

    item.menu_item_id
      ? Number(
          item.menu_item_id
        )
      : null,

    item.stock_id
      ? Number(item.stock_id)
      : null,

    String(itemName),

    1,

    unitTotal,

    vatRate,
    unitTotal,
    unitVatNet,
    unitVatAmount,

    String(itemType),

    safeOrderStatus,

    optionsObj,

    note,

    batchId || null,

    categoryId,

    isStarred,

    JSON.stringify(
      Array.isArray(
        table_allergy_codes
      )
        ? table_allergy_codes
        : []
    ),

    JSON.stringify(
      Array.isArray(
        item_allergen_contains
      )
        ? item_allergen_contains
        : []
    ),

    JSON.stringify(
      Array.isArray(
        allergen_conflicts
      )
        ? allergen_conflicts
        : []
    ),

    !!strict_cross_contamination,

    Math.max(
      1,
      Number(
        table_covers || 1
      )
    ),

    0,

    unitTotal,

    safeSource,

    safeExpiresAt,
  ]
);

      if (!created?.id) {
        throw new Error(
          "POS bill row INSERT did not return an id"
        );
      }

      createdIds.push(
        Number(created.id)
      );
    }

    return {
      ids: createdIds,
    };
  }

  for (let i = 0; i < qty; i++) {
    await tx.qRun(
      `
      INSERT INTO pos_orders (
        restaurant_id,
        table_number,
        meal_id,
        item_name,
        quantity,
        total_price,
        item_type,
        order_status,
        paid,
        options,
        note,
        batch_id,
        created_at,
        category_id,
        is_starred,
        strict_cross_contamination,
        table_covers,
        amount_paid,
        remaining_price,
        source,
        expires_at
      )
      VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        0, ?, ?, ?, CURRENT_TIMESTAMP,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
      `,
      [
        restaurantId,
        tableName,
        mealIdText || null,
        itemName,
        1,
        unitTotal,
        itemType,
        safeOrderStatus,
        optionsVal,
        note,
        batchId || "",
        categoryId,
        isStarred ? 1 : 0,
        strict_cross_contamination ? 1 : 0,
        Math.max(1, Number(table_covers || 1)),
        0,
        unitTotal,
        safeSource,
        safeExpiresAt,
      ]
    );
  }

  return {
    ids: createdIds,
  };
}

function normalizeStationKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function normalizePayMethod(v) {
  const s = String(v || "").trim().toLowerCase();

  if (["cash", "cash_payment"].includes(s)) return "cash";

  if (["card", "visa", "mastercard", "amex", "contactless"].includes(s)) {
    return "card";
  }

  if ([
    "voucher",
    "gift_voucher",
    "gift-voucher",
    "giftcard",
    "gift_card",
    "gift-card",
    "store_credit",
    "store-credit",
  ].includes(s)) {
    return "voucher";
  }

  return "unknown";
}

async function updateTableAfterPayment(qRunFn, qGetFn, restaurantId, tableName) {
  const isPg = kind === "pg";

  const row = await qGetFn(
    isPg
      ? `SELECT COUNT(*)::int AS c
         FROM public.pos_orders
         WHERE restaurant_id = $1
           AND table_number = $2
           AND COALESCE(remaining_price, total_price, 0) > 0`
      : `SELECT COUNT(*) AS c
         FROM pos_orders
         WHERE restaurant_id = ?
           AND table_number = ?
           AND COALESCE(remaining_price, total_price, 0) > 0`,
    [restaurantId, tableName]
  );

  const unpaidLeft = Number(row?.c || 0);

  await setTableStatus(
    qRunFn,
    restaurantId,
    tableName,
    unpaidLeft > 0 ? "occupied" : "occupied_paid"
  );

  return unpaidLeft;
}

async function createOrderBatch(tx, {
  restaurantId,
  tableName,
  orderType,
  batchId,
  requestedPaymentMethod = null,
}) {
  const isPg = tx.kind === "pg";
  const safeOrderType = String(orderType || "dine-in").toLowerCase();

  const safeRequestedPaymentMethod =
    requestedPaymentMethod && requestedPaymentMethod !== "unknown"
      ? String(requestedPaymentMethod).toLowerCase()
      : null;

  let pickupNumber = null;

  if (safeOrderType === "takeaway") {
    if (isPg) {
      await tx.qGet(`SELECT pg_advisory_xact_lock($1, $2)`, [
        Number(restaurantId),
        7001,
      ]);

      const row = await tx.qGet(
        `
        SELECT COALESCE(MAX(pickup_number), 0) + 1 AS next
        FROM public.order_batches
        WHERE restaurant_id = $1
          AND order_type = 'takeaway'
          AND created_at::date = CURRENT_DATE
        `,
        [Number(restaurantId)]
      );

      pickupNumber = Number(row?.next || 1);

      await tx.qRun(
        `
        INSERT INTO public.order_batches (
          id,
          table_number,
          restaurant_id,
          order_type,
          pickup_number,
          requested_payment_method,
          created_at
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, NOW())
        `,
        [
          String(batchId),
          String(tableName),
          Number(restaurantId),
          safeOrderType,
          pickupNumber,
          safeRequestedPaymentMethod,
        ]
      );
    } else {
      const row = await tx.qGet(
        `
        SELECT COALESCE(MAX(pickup_number), 0) + 1 AS next
        FROM order_batches
        WHERE restaurant_id = ?
          AND order_type = 'takeaway'
          AND date(created_at) = date('now')
        `,
        [Number(restaurantId)]
      );

      pickupNumber = Number(row?.next || 1);

      await tx.qRun(
        `
        INSERT INTO order_batches (
          id,
          table_number,
          restaurant_id,
          order_type,
          pickup_number,
          requested_payment_method,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `,
        [
          String(batchId),
          String(tableName),
          Number(restaurantId),
          safeOrderType,
          pickupNumber,
          safeRequestedPaymentMethod,
        ]
      );
    }
  } else {
    if (isPg) {
      await tx.qRun(
        `
        INSERT INTO public.order_batches (
          id,
          table_number,
          restaurant_id,
          order_type,
          pickup_number,
          requested_payment_method,
          created_at
        )
        VALUES ($1::uuid, $2, $3, $4, NULL, $5, NOW())
        `,
        [
          String(batchId),
          String(tableName),
          Number(restaurantId),
          safeOrderType,
          safeRequestedPaymentMethod,
        ]
      );
    } else {
      await tx.qRun(
        `
        INSERT INTO order_batches (
          id,
          table_number,
          restaurant_id,
          order_type,
          pickup_number,
          requested_payment_method,
          created_at
        )
        VALUES (?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)
        `,
        [
          String(batchId),
          String(tableName),
          Number(restaurantId),
          safeOrderType,
          safeRequestedPaymentMethod,
        ]
      );
    }
  }

  return { pickupNumber };
}

async function releasePaidHeldOrderToKds(tx, restaurantId, batchId) {
  if (!batchId) return;

  const rows = await tx.qAll(
    `
    SELECT *
    FROM public.pos_orders
    WHERE restaurant_id = $1
      AND batch_id = $2::uuid
      AND source IN ('qr', 'kiosk')
AND LOWER(TRIM(order_status)) = 'pending_payment'
      AND paid = 1
    ORDER BY id ASC
    `,
    [restaurantId, batchId]
  );

  console.log("🚀 RELEASE HELD KDS ROWS:", {
  restaurantId,
  batchId,
  count: rows?.length || 0,
  rows: (rows || []).map(r => ({
    id: r.id,
    item_name: r.item_name,
    paid: r.paid,
    order_status: r.order_status,
    source: r.source,
  })),
});

  for (const r of rows || []) {
    await tx.qRun(
      `
      INSERT INTO public.orders (
        restaurant_id, table_number, meal_name, quantity,
        price_per_unit, total_price, paid, order_status,
        category, category_id, order_type, options, note,
        batch_id, created_at, is_priority
      )
      VALUES (
        $1,$2,$3,$4,
$5,$6,false,'pending',
        $7,$8,$9,$10,$11,
        $12::uuid,NOW(),$13
      )
      `,
      [
        restaurantId,
        r.table_number,
        r.item_name,
        Number(r.quantity || 1),
        Number(r.total_price || 0),
        Number(r.total_price || 0),
        r.item_type === "drink" ? "drinks" : r.item_type === "dessert" ? "desserts" : "meals",
        r.category_id || null,
        "takeaway",
        r.options || {},
        r.note || null,
        batchId,
        !!r.is_starred,
      ]
    );
  }

  await tx.qRun(
    `
    UPDATE public.pos_orders
    SET order_status = 'open',
        expires_at = NULL
    WHERE restaurant_id = $1
      AND batch_id = $2::uuid
      AND source IN ('qr', 'kiosk')
      AND order_status = 'pending_payment'
    `,
    [restaurantId, batchId]
  );
}

function round2(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Math.round(
    (n + Number.EPSILON) * 100
  ) / 100;
}

function normalizeServiceChargeVatMode(raw) {
  return String(
    raw || "discretionary"
  )
    .trim()
    .toLowerCase() === "mandatory"
      ? "mandatory"
      : "discretionary";
}

function buildTrustedOptionsDisplay(optionDetails = []) {
  const out = {};

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
        out[label] = value;
      }

      continue;
    }

    const choices = Array.isArray(detail?.choices)
      ? detail.choices
      : [];

    const labels = choices
      .map((choice) =>
        String(choice?.label || "").trim()
      )
      .filter(Boolean);

    if (!labels.length) continue;

    out[label] =
      detail?.option_type === "multi"
        ? labels
        : labels[0];
  }

  return out;
}

function vatFromInclusiveGross(
  gross,
  rate
) {
  const safeGross =
    round2(
      Math.max(
        0,
        Number(gross || 0)
      )
    );

  if (
    rate === null ||
    rate === undefined ||
    String(rate).trim() === ""
  ) {
    return {
      gross: safeGross,
      net: safeGross,
      vat: 0,
      rate: null,
    };
  }

  const safeRate =
    Number(rate);

  if (
    !Number.isFinite(safeRate) ||
    safeRate < 0 ||
    safeRate > 100
  ) {
    throw new Error(
      `Invalid VAT rate: ${rate}`
    );
  }

  if (safeRate === 0) {
    return {
      gross: safeGross,
      net: safeGross,
      vat: 0,
      rate: 0,
    };
  }

  const net =
    round2(
      safeGross /
        (
          1 +
          safeRate / 100
        )
    );

  return {
    gross: safeGross,

    net,

    vat:
      round2(
        safeGross - net
      ),

    rate:
      Number(
        safeRate.toFixed(3)
      ),
  };
}


function allocateProportionally(
  rows,
  amount,
  getWeight
) {
  const totalAmount =
    round2(
      Math.max(
        0,
        Number(amount || 0)
      )
    );

  const weights =
    rows.map((row) =>
      Math.max(
        0,
        Number(
          getWeight(row) || 0
        )
      )
    );

  const totalWeight =
    weights.reduce(
      (sum, n) => sum + n,
      0
    );

  if (
    totalAmount <= 0 ||
    totalWeight <= 0
  ) {
    return rows.map(() => 0);
  }

  let allocated = 0;

  return rows.map(
    (row, index) => {
      /*
       * Last row receives the rounding remainder.
       * Therefore allocations always reconcile exactly.
       */
      if (
        index === rows.length - 1
      ) {
        return round2(
          totalAmount - allocated
        );
      }

      const share =
        round2(
          totalAmount *
            (
              weights[index] /
              totalWeight
            )
        );

      allocated =
        round2(
          allocated + share
        );

      return share;
    }
  );
}


function calculateSettlementVatBreakdown({
  amountRows = [],

  voucherDiscount = 0,
  manualDiscount = 0,

  serviceCharge = 0,

  serviceChargeVatMode =
    "discretionary",
}) {
  const mode =
    normalizeServiceChargeVatMode(
      serviceChargeVatMode
    );


  /*
   * payable_total already includes pricing/deal discounts.
   *
   * So this is our starting point for final VAT calculation.
   */
  const lines =
    (amountRows || []).map(
      (row) => ({
        pos_order_id:
          Number(row.id),

        vat_rate:
          row.vat_rate === null ||
          row.vat_rate === undefined ||
          String(
            row.vat_rate
          ).trim() === ""
            ? null
            : Number(
                row.vat_rate
              ),

        gross_before_bill_discount:
          round2(
            Math.max(
              0,
              Number(
                row.payable_total ||
                  0
              )
            )
          ),
      })
    );


  const dealAdjustedGross =
    round2(
      lines.reduce(
        (sum, line) =>
          sum +
          line
            .gross_before_bill_discount,
        0
      )
    );


  /*
   * Voucher + manual discount are bill-level discounts.
   * Pricing-rule discount is already inside payable_total.
   */
  const billDiscount =
    round2(
      Math.min(
        dealAdjustedGross,

        Math.max(
          0,
          Number(
            voucherDiscount || 0
          )
        ) +
          Math.max(
            0,
            Number(
              manualDiscount || 0
            )
          )
      )
    );


  const discountShares =
    allocateProportionally(
      lines,
      billDiscount,
      (line) =>
        line.gross_before_bill_discount
    );


  const discountedLines =
    lines.map(
      (line, index) => ({
        ...line,

        bill_discount:
          discountShares[index],

        gross_after_discount:
          round2(
            Math.max(
              0,

              line
                .gross_before_bill_discount -
                discountShares[index]
            )
          ),
      })
    );


  /*
   * Mandatory service charge follows the underlying meal VAT.
   * Discretionary service charge remains outside VAT.
   */
  const taxableServiceCharge =
    mode === "mandatory"
      ? round2(
          Math.max(
            0,
            Number(
              serviceCharge || 0
            )
          )
        )
      : 0;


  const outsideScopeServiceCharge =
    mode === "discretionary"
      ? round2(
          Math.max(
            0,
            Number(
              serviceCharge || 0
            )
          )
        )
      : 0;


  const serviceShares =
    allocateProportionally(
      discountedLines,
      taxableServiceCharge,
      (line) =>
        line.gross_after_discount
    );


  const finalLines =
    discountedLines.map(
      (line, index) => {
        const serviceShare =
          serviceShares[index];

        const finalTaxGross =
          round2(
            line.gross_after_discount +
              serviceShare
          );

        const calculated =
          vatFromInclusiveGross(
            finalTaxGross,
            line.vat_rate
          );

        return {
          pos_order_id:
            line.pos_order_id,

          vat_rate:
            calculated.rate,

          gross_before_bill_discount:
            line
              .gross_before_bill_discount,

          bill_discount:
            line.bill_discount,

          service_charge:
            serviceShare,

          vat_gross:
            calculated.gross,

          vat_net:
            calculated.net,

          vat_amount:
            calculated.vat,
        };
      }
    );


  const bucketMap =
    new Map();

  let unclassifiedGross = 0;


  for (const line of finalLines) {
    if (
      line.vat_rate === null
    ) {
      unclassifiedGross =
        round2(
          unclassifiedGross +
            line.vat_gross
        );

      continue;
    }

    const key =
      Number(
        line.vat_rate
      ).toFixed(3);

    if (
      !bucketMap.has(key)
    ) {
      bucketMap.set(
        key,
        {
          vat_rate:
            Number(
              line.vat_rate
            ),

          gross: 0,
          net: 0,
          vat: 0,
        }
      );
    }

    const bucket =
      bucketMap.get(key);

    bucket.gross =
      round2(
        bucket.gross +
          line.vat_gross
      );

    bucket.net =
      round2(
        bucket.net +
          line.vat_net
      );

    bucket.vat =
      round2(
        bucket.vat +
          line.vat_amount
      );
  }


  const buckets =
    Array.from(
      bucketMap.values()
    ).sort(
      (a, b) =>
        a.vat_rate -
        b.vat_rate
    );


  const taxableGross =
    round2(
      buckets.reduce(
        (sum, bucket) =>
          sum + bucket.gross,
        0
      )
    );


  const netAmount =
    round2(
      buckets.reduce(
        (sum, bucket) =>
          sum + bucket.net,
        0
      )
    );


  const vatAmount =
    round2(
      buckets.reduce(
        (sum, bucket) =>
          sum + bucket.vat,
        0
      )
    );


  return {
    version: 1,

    service_charge_vat_mode:
      mode,

    deal_adjusted_gross:
      dealAdjustedGross,

    bill_discount:
      billDiscount,

    taxable_gross:
      taxableGross,

    net_amount:
      netAmount,

    vat_amount:
      vatAmount,

    unclassified_gross:
      round2(
        unclassifiedGross
      ),

    service_charge_outside_scope:
      outsideScopeServiceCharge,

    buckets,

    lines:
      finalLines,
  };
}
// ---------- ROUTES ----------

// POST /orders  (simple)
router.post("/", requireRole(...POS_STAFF), async (req, res) => {
  const { items = [], table_number } = req.body || {};
  const restaurantId = req.tenantRid;
const order_type = String(req.body?.order_type || "dine-in").toLowerCase();
const isDineIn = !["takeaway", "delivery", "collection"].includes(order_type);
  if (!table_number || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Table number and at least one item required." });
  }

  const tableName = canonicalTableName(table_number);
  const batchId = makeBatchId();

  let tableAllergyCodes = [];
let strictCrossContamination = false;
let tableCovers = 1;

try {
  const result = await withTx(async (tx) => {

  if (isDineIn) {
    const tableRow = await tx.qGet(
      tx.kind === "pg"
        ? `
          SELECT t.id
          FROM public.tables t
          WHERE t.restaurant_id = $1
            AND LOWER(TRIM(t.name)) = LOWER(TRIM($2))
          LIMIT 1
        `
        : `
          SELECT id
          FROM tables
          WHERE restaurant_id = ?
            AND LOWER(TRIM(name)) = LOWER(TRIM(?))
          LIMIT 1
        `,
      [restaurantId, tableName]
    );

    if (tableRow?.id) {
      const sess = await tx.qGet(
  tx.kind === "pg"
    ? `
      SELECT covers, allergy_codes, strict_cross_contamination
      FROM public.pos_table_sessions
      WHERE restaurant_id = $1 AND table_id = $2
      LIMIT 1
    `
    : `
      SELECT covers, allergy_codes, strict_cross_contamination
      FROM pos_table_sessions
      WHERE restaurant_id = ? AND table_id = ?
      LIMIT 1
    `,
  [restaurantId, Number(tableRow.id)]
);

      let raw = sess?.allergy_codes;

if (typeof raw === "string") {
  try { raw = JSON.parse(raw); } catch { raw = []; }
}
tableAllergyCodes = sanitizeAllergenCodes(raw);
strictCrossContamination = !!sess?.strict_cross_contamination;
tableCovers = Math.max(1, Number(sess?.covers || 1));
    }
  }

  // 1) KDS orders + stock deduction
 const { batchId: realBatchId, deductionReport } =
  await insertPosItems({
    tx,
    restaurantId,
    tableName,
    items: trustedItems,
    batchId,
    stockDeductionEnabled,
    holdKdsUntilPaid: holdQrKioskUntilPaid,
  });

  if (!isUuid(realBatchId)) {
    throw new Error(`insertPosItems returned non-uuid batchId: ${realBatchId}`);
  }

  // 2) POS bill rows
  const aggregated =
    typeof aggregateItems === "function" ? aggregateItems(items) : items;

  for (const item of aggregated) {
    const name = String(item.meal_name || item.item_name || "").trim();
    if (!name) continue;

    const qty = Number.parseInt(item.quantity, 10) || 1;
    const rawTotal = Number(item.total_price);
    const rawUnit = Number(item.price_per_unit ?? item.price);

    const unit = Number.isFinite(rawUnit)
      ? rawUnit
      : Number.isFinite(rawTotal)
        ? rawTotal / qty
        : 0;

    const total_price = Number.isFinite(rawTotal)
      ? rawTotal
      : Number((unit * qty).toFixed(2));

    const item_type =
  item.item_type || item.category || normalizeCategory(item.category);
    const itemNameForAllergens = String(
      item.meal_name || item.item_name || item.name || ""
    ).trim();

   const itemAllergenContains = sanitizeAllergenCodes(
  detectAllergenCodesFromName(itemNameForAllergens)
);

    const allergenConflicts = itemAllergenContains.filter((code) =>
      tableAllergyCodes.includes(code)
    );

        await insertPosBillRow(tx, {
  restaurantId,
  tableName,
item: {
  ...item,
  item_type,
  order_status: "open",
expires_at: null,
},
  batchId: realBatchId,
  total_price,
  category: item.category ?? null,
  category_id: item.category_id ?? null,
  source: "pos",
  table_allergy_codes: tableAllergyCodes,
  item_allergen_contains: itemAllergenContains,
  allergen_conflicts: allergenConflicts,
  strict_cross_contamination: strictCrossContamination,
  table_covers: tableCovers,
});
  }

  // ✅ 3) TABLE STATUS UPDATE MUST BE HERE (tx exists here)
  if (isDineIn) {
    await setTableStatus(tx.qRun, restaurantId, tableName, "occupied");
  }

  return { batch_id: realBatchId, deductionReport };
});

    return res.status(201).json({
      success: true,
      message: "✅ POS order processed and stock updated.",
   batchId: result.batch_id,   
   deductionReport: result.deductionReport,
    });
  } catch (err) {
    console.error("❌ POS order failed:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

const resolveCategoryFromId = async (tx, restaurantId, categoryId) => {  if (!categoryId) return null;

  const isPg = tx.kind === "pg";
  const sql = isPg
    ? `SELECT id, name, type
       FROM categories
       WHERE id = $1 AND restaurant_id = $2
       LIMIT 1`
    : `SELECT id, name, type
       FROM categories
       WHERE id = ? AND restaurant_id = ?
       LIMIT 1`;

  const row = await tx.qGet(sql, [Number(categoryId), Number(restaurantId)]);
  if (!row?.id) return null;

  const s = String(row.type || "").toLowerCase();
  const item_type =
    s.startsWith("drink") ? "drinks" :
    s.startsWith("dessert") ? "desserts" :
    "meals";

  return {
    category_id: Number(row.id),
    category_name: String(row.name || "").trim(),
    item_type,
  };
};
function uniqLower(arr = []) {
  return Array.from(
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((x) => String(x || "").toLowerCase().trim())
        .filter(Boolean)
    )
  );
}




// POST /orders/grouped  (POS bill + KDS + stock, all atomic)
router.post(
  "/grouped",

  requireRole(
    ...POS_STAFF
  ),

  requireMiscPricePermission,
requireStockOverridePermission,

  async (req, res) => {
  const restaurantId = Number(req.tenantRid || req.user?.restaurant_id || 0);

  const rawTable = req.body?.table_number;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const order_type = String(req.body?.order_type || "dine-in").toLowerCase();
  const rawSource = String(req.body?.source || "pos").toLowerCase();

  const requestedPaymentMethod = normalizePayMethod(
    req.body?.kiosk_payment_method || req.body?.payment_method || null
  );

  const orderSource = ["qr", "kiosk"].includes(rawSource) ? rawSource : "pos";

  const safeOrderType =
    order_type === "takeaway" || order_type === "delivery" || order_type === "collection"
      ? order_type
      : "dine-in";

  const isDineIn = safeOrderType === "dine-in";

  const tableName = isDineIn
    ? canonicalTableName(rawTable)
    : safeOrderType === "delivery"
      ? "Delivery"
      : "Takeaway";

  if (!restaurantId) {
    return res.status(401).json({ error: "Missing restaurantId (tenant)" });
  }

 if (!items.length) {
  return res.status(400).json({
    error: "Order items are required.",
  });
}

// =====================================================
// SECURITY — ORDER PAYLOAD LIMITS
// =====================================================
//
// Never allow browser-controlled quantities to reach
// pricing, stock, availability, KDS or persistence
// without strict validation.
//
// This prevents:
// - zero / negative quantities
// - fractional quantities
// - NaN / Infinity
// - absurd quantities causing CPU/memory exhaustion
// - accidental bulk amplification
//
const MAX_ORDER_LINES = 100;
const MAX_ITEM_QUANTITY = 999;

if (items.length > MAX_ORDER_LINES) {
  return res.status(400).json({
    success: false,
    error: `Order cannot contain more than ${MAX_ORDER_LINES} line items.`,
    code: "ORDER_TOO_LARGE",
  });
}

for (let index = 0; index < items.length; index += 1) {
  const rawQuantity = items[index]?.quantity;

  // Missing quantity keeps existing normal behaviour of 1.
  const quantity =
    rawQuantity === undefined ||
    rawQuantity === null ||
    rawQuantity === ""
      ? 1
      : Number(rawQuantity);

  if (
    !Number.isFinite(quantity) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_ITEM_QUANTITY
  ) {
    return res.status(400).json({
      success: false,
      error:
        `Invalid quantity for item ${index + 1}. ` +
        `Quantity must be a whole number between 1 and ${MAX_ITEM_QUANTITY}.`,
      code: "INVALID_ITEM_QUANTITY",
      item_index: index,
    });
  }

  // From this point onward the backend uses a validated number.
  items[index].quantity = quantity;
}

if (isDineIn && !rawTable) {
    return res.status(400).json({ error: "Table number is required." });
  }

  function isUuidLocal(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(v || "")
    );
  }

const appendBatchIdRaw = String(req.body?.append_to_batch_id || "").trim();

const batchId =
  appendBatchIdRaw && isUuidLocal(appendBatchIdRaw)
    ? appendBatchIdRaw
    : require("crypto").randomUUID();

const shouldAppendToExistingBatch =
  Boolean(
    appendBatchIdRaw &&
    isUuidLocal(appendBatchIdRaw)
  );

/*
 * batch_id identifies the whole ticket.
 * submissionId identifies this individual Send / append.
 */
const requestedSubmissionId =
  String(
    req.body?.submission_id || ""
  ).trim();

if (
  requestedSubmissionId &&
  !isUuidLocal(
    requestedSubmissionId
  )
) {
  return res.status(400).json({
    success: false,

    error:
      "submission_id must be a valid UUID.",

    code:
      "INVALID_SUBMISSION_ID",
  });
}

const submissionId =
  requestedSubmissionId ||
  require("crypto").randomUUID();

  console.log(
    "SENDING ITEMS:",
    items.map((i) => ({
      name: i.meal_name,
      meal_id: i.meal_id,
      options: i.options,
    }))
  );

  const normalizeItemType = (t) => {
    const s = String(t || "").toLowerCase();
    if (s.startsWith("drink")) return "drinks";
    if (s.startsWith("dessert")) return "desserts";
    return "meals";
  };

  try {
    const operation =
      await withEdgeOperation({
        restaurantId,

        scope:
          "pos.orders.grouped",

        idempotencyKey:
          submissionId,

        requestPayload:
          req.body,

        execute:
          async ({ tx }) => {
      let tableAllergyCodes = [];
      let strictCrossContamination = false;
      let tableCovers = 1;

      const kioskSession = req.body?.kiosk_session || null;

      if (kioskSession) {
        tableAllergyCodes = sanitizeAllergenCodes(kioskSession?.allergy_codes);
        strictCrossContamination = !!kioskSession?.strict_cross_contamination;
        tableCovers = Math.max(1, Number(kioskSession?.covers || 1));
      } else if (isDineIn) {
        const tableRow = await tx.qGet(
          tx.kind === "pg"
            ? `
              SELECT t.id
              FROM public.tables t
              WHERE t.restaurant_id = $1
                AND LOWER(TRIM(t.name)) = LOWER(TRIM($2))
              LIMIT 1
            `
            : `
              SELECT id
              FROM tables
              WHERE restaurant_id = ?
                AND LOWER(TRIM(name)) = LOWER(TRIM(?))
              LIMIT 1
            `,
          [restaurantId, tableName]
        );

        if (tableRow?.id) {
          const sess = await tx.qGet(
            tx.kind === "pg"
              ? `
                SELECT covers, allergy_codes, strict_cross_contamination
                FROM public.pos_table_sessions
                WHERE restaurant_id = $1 AND table_id = $2
                LIMIT 1
              `
              : `
                SELECT covers, allergy_codes, strict_cross_contamination
                FROM pos_table_sessions
                WHERE restaurant_id = ? AND table_id = ?
                LIMIT 1
              `,
            [restaurantId, Number(tableRow.id)]
          );

          let raw = sess?.allergy_codes;

          if (typeof raw === "string") {
            try {
              raw = JSON.parse(raw);
            } catch {
              raw = [];
            }
          }

          tableAllergyCodes = sanitizeAllergenCodes(raw);
          strictCrossContamination = !!sess?.strict_cross_contamination;
          tableCovers = Math.max(1, Number(sess?.covers || 1));
        }
      } else {
        const takeawaySession = req.body?.takeaway_session || {};
        tableAllergyCodes = sanitizeAllergenCodes(takeawaySession?.allergy_codes);
        strictCrossContamination = !!takeawaySession?.strict_cross_contamination;
        tableCovers = 1;
      }

      const stockSetting = await tx.qGet(
        tx.kind === "pg"
          ? `
            SELECT
              selling_mode,
              hold_qr_kiosk_until_paid,
              allergen_tracking_enabled,
              calorie_tracking_enabled,
              plate_cost_enabled
            FROM public.restaurants
            WHERE id = $1
            LIMIT 1
          `
          : `
            SELECT
              selling_mode,
              hold_qr_kiosk_until_paid,
              allergen_tracking_enabled,
              calorie_tracking_enabled,
              plate_cost_enabled
            FROM restaurants
            WHERE id = ?
            LIMIT 1
          `,
        [restaurantId]
      );

      const sellingMode = String(stockSetting?.selling_mode || "full_stock").toLowerCase();

      const stockDeductionEnabled = sellingMode === "full_stock";

      const portionTrackingMode =
        sellingMode === "manual_portions"
          ? "manual"
          : sellingMode === "full_stock"
            ? "ingredients"
            : "off";

      const holdQrKioskUntilPaid =
        ["qr", "kiosk"].includes(orderSource) &&
        stockSetting?.hold_qr_kiosk_until_paid !== false;

      await assertItemsOrderable(tx, restaurantId, items, {
        stockDeductionEnabled,
        portionTrackingMode,
      });

const pricingItems =
  getCanonicalPricingItems(items);

let canonicalCart = null;
let authoritativeQuote = {
  items: [],
  subtotal: 0,
  discount: 0,
  pricing_discount: 0,
  total: 0,
  applied_rules: [],
};

let pricingComparison = null;

if (pricingItems.length > 0) {
  canonicalCart = await buildCanonicalCart(
  tx,
  restaurantId,
  pricingItems,
  {
    stockOverrideAuthorised:
      req.stockOverrideAuthorised === true,
  }
);

  authoritativeQuote = await buildAuthoritativeQuote({
    db: tx,
    restaurantId,
    canonicalCart,
    surface: normalizeSurface(orderSource),
  });

  pricingComparison = logPricingComparison({
    restaurantId,
    tableName,
    source: orderSource,
    submittedItems: pricingItems,
    canonicalCart,
  });

  console.log("✅ AUTHORITATIVE ORDER QUOTE:", {
    restaurant_id: restaurantId,
    table_number: tableName,
    source: normalizeSurface(orderSource),
    subtotal: authoritativeQuote.subtotal,
    pricing_discount:
      authoritativeQuote.pricing_discount,
    total: authoritativeQuote.total,
    applied_rules:
      authoritativeQuote.applied_rules,
  });
}

const canonicalQueues = new Map();

function canonicalMatchKey(item) {
  const mealId = Number(
    item?.meal_id ??
    item?.mealId ??
    0
  );

  if (mealId > 0) {
    return `meal:${mealId}`;
  }

  const menuItemId = Number(
    item?.menu_item_id ??
    item?.menuItemId ??
    0
  );

  if (menuItemId > 0) {
    return `menu_item:${menuItemId}`;
  }

  return null;
}

for (const canonicalItem of canonicalCart?.items || []) {
  const key = canonicalMatchKey(canonicalItem);

  if (!key) continue;

  if (!canonicalQueues.has(key)) {
    canonicalQueues.set(key, []);
  }

  canonicalQueues.get(key).push(canonicalItem);
}

const trustedItems = items.map((rawItem) => {
  const key = canonicalMatchKey(rawItem);
  const queue = key
    ? canonicalQueues.get(key)
    : null;

  const canonicalItem =
    Array.isArray(queue) && queue.length
      ? queue.shift()
      : null;

  // Miscellaneous/manual stock items remain on the legacy path.
  if (!canonicalItem) {
    return rawItem;
  }

  return {
    // Preserve operational fields that are not pricing authority.
    ...rawItem,

    // ✅ Mark that pricing/options were server validated.
    authoritative: true,

    // ✅ Authoritative identity
    source: canonicalItem.source,
    item_source: canonicalItem.source,

    item_id: canonicalItem.item_id,
    meal_id: canonicalItem.meal_id,
    menu_item_id: canonicalItem.menu_item_id,

    // ✅ Authoritative description/category
    name: canonicalItem.name,
    meal_name: canonicalItem.name,
    item_name: canonicalItem.name,
    item_type: canonicalItem.item_type,
    category:
      canonicalItem.category ||
      canonicalItem.item_type,
    category_id:
      canonicalItem.category_id ?? null,

    // ✅ Authoritative quantity and pricing
    quantity: canonicalItem.quantity,
    price: canonicalItem.unit_price,
    price_per_unit: canonicalItem.unit_price,
    total_price: canonicalItem.total_price,

vat_rate:
  canonicalItem.vat_rate,

vat_gross:
  canonicalItem.vat_gross,

vat_net:
  canonicalItem.vat_net,

vat_amount:
  canonicalItem.vat_amount,
    // ✅ Authoritative options
    // ✅ Authoritative options
options:
  canonicalItem.selected_options,

selected_options:
  canonicalItem.selected_options,

option_details:
  canonicalItem.option_details,

options_display:
  buildTrustedOptionsDisplay(
    canonicalItem.option_details
  ),

    // Preserve the canonical sanitized note.
    note:
      canonicalItem.note ??
      rawItem.note ??
      rawItem.notes ??
      null,

  };
});

const availabilityReservations =
  await reserveItemsAvailability({
    db: tx,

    restaurantId,

    batchId,

    submissionId,

    // IMPORTANT:
    // availability uses the server-authoritative identities,
    // not browser-supplied identities.
    items:
      trustedItems,

    source:
      orderSource,

      actorUserId:
  Number(
    req.user?.id || 0
  ) || null,

    /*
     * POS is immediately consumed.
     *
     * QR/Kiosk pending-payment orders are reservations.
     * They become consumed only after successful payment.
     */
    holdUntilPaid:
      holdQrKioskUntilPaid,
  });

console.log(
  "✅ ITEM AVAILABILITY RESERVED:",
  availabilityReservations
);

      let pickupNumber = null;

if (tx.kind === "pg") {
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
      `maks:pos:${restaurantId}:${batchId}`,
    ]
  );
}

const existingKdsOrderIds =
  tx.kind === "pg"
    ? new Set(
        (
          await tx.qAll(
            `
            SELECT id
            FROM public.orders
            WHERE restaurant_id = $1
              AND batch_id = $2::uuid
            ORDER BY id ASC
            `,
            [
              restaurantId,
              batchId,
            ]
          )
        )
          .map(
            (row) =>
              Number(row.id)
          )
          .filter(
            (id) =>
              Number.isSafeInteger(id) &&
              id > 0
          )
      )
    : new Set();

if (!shouldAppendToExistingBatch) {
  const created = await createOrderBatch(tx, {
    restaurantId,
    tableName,
    orderType: safeOrderType,
    batchId,
    requestedPaymentMethod,
  });

  pickupNumber = created.pickupNumber;
}

      console.log("🧾 QR/KIOSK HOLD DEBUG:", {
        rawSource,
        orderSource,
        sellingMode,
        stockDeductionEnabled,
        portionTrackingMode,
        hold_qr_kiosk_until_paid: stockSetting?.hold_qr_kiosk_until_paid,
        holdQrKioskUntilPaid,
      });

      const { batchId: realBatchId, deductionReport } =
  await insertPosItems({
    tx,
    restaurantId,
    tableName,
items: trustedItems,
    batchId,
    stockDeductionEnabled,
    holdKdsUntilPaid: holdQrKioskUntilPaid,
  });

      if (!isUuid(realBatchId)) {
        throw new Error(`insertPosItems returned non-uuid batchId: ${realBatchId}`);
      }


      const createdKdsOrderIds =
        tx.kind === "pg"
          ? (
              await tx.qAll(
                `
                SELECT id
                FROM public.orders
                WHERE restaurant_id = $1
                  AND batch_id = $2::uuid
                ORDER BY id ASC
                `,
                [
                  restaurantId,
                  realBatchId,
                ]
              )
            )
              .map(
                (row) =>
                  Number(row.id)
              )
              .filter(
                (id) =>
                  Number.isSafeInteger(id) &&
                  id > 0 &&
                  !existingKdsOrderIds.has(id)
              )
          : [];

      /*
       * =====================================================
       * MAKS EDGE — AUTHORITATIVE POS ROW OWNERSHIP
       * =====================================================
       *
       * Each quantity unit creates its own public.pos_orders
       * row. Capture those exact PostgreSQL IDs while still
       * inside the authoritative order transaction.
       *
       * Never discover these later using "latest order".
       */
      const createdPosOrderIds = [];

      for (const item of trustedItems) {
        const name = String(item.meal_name || item.item_name || "").trim();
        if (!name) continue;

        const qty = Number.parseInt(item.quantity, 10) || 1;
        const rawTotal = Number(item.total_price);
        const rawUnit = Number(item.price_per_unit ?? item.price);

        const unit = Number.isFinite(rawUnit)
          ? rawUnit
          : Number.isFinite(rawTotal)
            ? rawTotal / qty
            : 0;

        const total_price = Number.isFinite(rawTotal)
          ? rawTotal
          : Number((unit * qty).toFixed(2));

        const item_type =
          item.item_type || item.category || normalizeItemType(item.category);

        const itemNameForAllergens = String(
          item.meal_name || item.item_name || item.name || ""
        ).trim();

        const itemAllergenContains = sanitizeAllergenCodes(
          detectAllergenCodesFromName(itemNameForAllergens)
        );

        const allergenConflicts = itemAllergenContains.filter((code) =>
          tableAllergyCodes.includes(code)
        );

        const createdBillRows =
          await insertPosBillRow(tx, {
          restaurantId,
          tableName,
          item: {
            ...item,
            item_type,
            order_status: holdQrKioskUntilPaid ? "pending_payment" : "open",
            expires_at: holdQrKioskUntilPaid
              ? new Date(Date.now() + 20 * 60 * 1000).toISOString()
              : null,
          },
          batchId: realBatchId,
          total_price,
          category: item.category ?? null,
          category_id: item.category_id ?? null,
          table_allergy_codes: tableAllergyCodes,
          item_allergen_contains: itemAllergenContains,
          allergen_conflicts: allergenConflicts,
          strict_cross_contamination: strictCrossContamination,
          table_covers: tableCovers,
          source: orderSource,
        });

        if (tx.kind === "pg") {
          const newIds =
            Array.isArray(
              createdBillRows?.ids
            )
              ? createdBillRows.ids
                  .map(
                    (id) =>
                      Number(id)
                  )
                  .filter(
                    (id) =>
                      Number.isSafeInteger(id) &&
                      id > 0
                  )
              : [];

          /*
           * One public.pos_orders row is created per quantity
           * unit. If that invariant changes unexpectedly,
           * fail the whole order transaction rather than
           * produce an incomplete Edge event.
           */
          if (newIds.length !== qty) {
            throw new Error(
              "POS bill row ID capture mismatch"
            );
          }

          createdPosOrderIds.push(
            ...newIds
          );
        }
      }


      if (tx.kind === "pg") {
        for (
          let index = 0;
          index < createdPosOrderIds.length;
          index += 1
        ) {
          const stamped =
            await tx.qGet(
              `
              UPDATE public.pos_orders
              SET
                edge_submission_id =
                  $1::uuid,
                edge_row_ordinal =
                  $2
              WHERE
                restaurant_id = $3
                AND id = $4
                AND batch_id =
                  $5::uuid
              RETURNING id
              `,
              [
                submissionId,
                index + 1,
                restaurantId,
                createdPosOrderIds[
                  index
                ],
                realBatchId,
              ]
            );

          if (!stamped?.id) {
            throw new Error(
              "Failed to stamp stable POS operational identity"
            );
          }
        }
      }

     const pricingDiscount = Number(
  authoritativeQuote?.pricing_discount || 0
);

if (pricingDiscount > 0 && realBatchId) {
  /*
   * The discount is calculated by the backend.
   *
   * Misc/manual lines are excluded because they were not
   * part of the canonical pricing cart and must not receive
   * bundle discount.
   */
  const rows = await tx.qAll(
    `
    SELECT
      id,
      COALESCE(
        remaining_price,
        total_price,
        0
      )::numeric AS amount
    FROM public.pos_orders
    WHERE restaurant_id = $1
      AND batch_id = $2::uuid
      AND paid = 0
      AND LOWER(
        TRIM(
          COALESCE(item_type, '')
        )
      ) <> 'misc'
    ORDER BY id ASC
    `,
    [restaurantId, realBatchId]
  );

  const grossPennies = rows.reduce(
    (sum, row) =>
      sum +
      Math.round(
        Number(row.amount || 0) *
          100
      ),
    0
  );

  const discountPennies = Math.min(
    grossPennies,
    Math.round(
      pricingDiscount * 100
    )
  );

  if (
    grossPennies > 0 &&
    discountPennies > 0
  ) {
    let remainingDiscountPennies =
      discountPennies;

    for (
      let index = 0;
      index < rows.length;
      index += 1
    ) {
      const row = rows[index];

      const amountPennies =
        Math.round(
          Number(row.amount || 0) *
            100
        );

      const isLastRow =
        index === rows.length - 1;

      const rowDiscountPennies =
        isLastRow
          ? remainingDiscountPennies
          : Math.min(
              remainingDiscountPennies,
              Math.round(
                (
                  amountPennies /
                  grossPennies
                ) *
                  discountPennies
              )
            );

      remainingDiscountPennies -=
        rowDiscountPennies;

      const rowDiscount =
        Number(
          (
            rowDiscountPennies /
            100
          ).toFixed(2)
        );

      await tx.qRun(
        `
        UPDATE public.pos_orders
        SET remaining_price =
          GREATEST(
            0,
            COALESCE(
              remaining_price,
              total_price,
              0
            ) - $1
          )
        WHERE id = $2
          AND restaurant_id = $3
        `,
        [
          rowDiscount,
          row.id,
          restaurantId,
        ]
      );
    }
  }
}

      if (isDineIn) {
        await setTableStatus(
          tx.qRun,
          restaurantId,
          tableName,
          "occupied"
        );
      }

      /*
       * =====================================================
       * MAKS EDGE — POS ORDER SUBMITTED
       * =====================================================
       *
       * This outbox INSERT shares the SAME PostgreSQL
       * transaction as:
       *
       * - authoritative pricing
       * - availability reservation
       * - order batch
       * - KDS/order persistence
       * - POS bill rows
       * - pricing adjustments
       * - table status
       *
       * Therefore:
       *
       *     restaurant operation + Edge event
       *                   COMMIT
       *
       * or neither survives.
       */
      if (tx.kind === "pg") {
        if (!createdPosOrderIds.length) {
          throw new Error(
            "Grouped POS order produced no authoritative POS bill row IDs"
          );
        }

        const batchSnapshot =
          await tx.qGet(
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
            FROM
              public.order_batches
            WHERE
              restaurant_id = $1
              AND id = $2::uuid
            LIMIT 1
            `,
            [
              restaurantId,
              realBatchId,
            ]
          );

        if (!batchSnapshot?.id) {
          throw new Error(
            "POS Edge event cannot snapshot order batch"
          );
        }

        const posRowSnapshots =
          await tx.qAll(
            `
            SELECT
              id,
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
            FROM
              public.pos_orders
            WHERE
              restaurant_id = $1
              AND id =
                ANY($2::bigint[])
            ORDER BY
              edge_row_ordinal ASC
            `,
            [
              restaurantId,
              createdPosOrderIds,
            ]
          );

        if (
          posRowSnapshots.length !==
          createdPosOrderIds.length
        ) {
          throw new Error(
            "POS Edge event snapshot row count mismatch"
          );
        }

        const kdsRowSnapshots =
          createdKdsOrderIds.length
            ? await tx.qAll(
                `
                SELECT
                  id,
                  restaurant_id,
                  table_number,
                  items,
                  total_price,
                  paid,
                  created_at,
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
                FROM
                  public.orders
                WHERE
                  restaurant_id = $1
                  AND id =
                    ANY($2::bigint[])
                ORDER BY
                  id ASC
                `,
                [
                  restaurantId,
                  createdKdsOrderIds,
                ]
              )
            : [];

        await enqueueEdgeEventTx(
          tx,
          {
            restaurantId,

            eventType:
              "pos.order.submitted",

            entityType:
              "order_batch",

            entityId:
              String(
                realBatchId
              ),

            /*
             * Appending to an existing batch is a new
             * submission inside the same restaurant ticket.
             */
            idempotencyKey:
              `pos.order.submitted:${submissionId}`,

            payload: {
              schema_version: 2,

              restaurant_id:
                Number(
                  restaurantId
                ),

              batch_id:
                String(
                  realBatchId
                ),

              submission_id:
                submissionId,

              pos_order_ids:
                createdPosOrderIds,

              batch:
                batchSnapshot,

              pos_rows:
                posRowSnapshots,

              kds_rows:
                kdsRowSnapshots,

              order_type:
                safeOrderType,

              source:
                orderSource,

              table_number:
                tableName,

              pickup_number:
                pickupNumber,

              append_to_existing_batch:
                shouldAppendToExistingBatch,

              hold_until_paid:
                holdQrKioskUntilPaid,

              pricing: {
                subtotal:
                  Number(
                    authoritativeQuote
                      ?.subtotal || 0
                  ),

                pricing_discount:
                  Number(
                    authoritativeQuote
                      ?.pricing_discount || 0
                  ),

                total:
                  Number(
                    authoritativeQuote
                      ?.total || 0
                  ),

                applied_rules:
                  authoritativeQuote
                    ?.applied_rules ||
                  [],
              },
            },
          }
        );
      }

      return {
  batch_id: realBatchId,
  deductionReport,
  pickup_number: pickupNumber,
  pricingComparison,

  pricing: {
    subtotal: Number(
      authoritativeQuote?.subtotal || 0
    ),

    pricing_discount: Number(
      authoritativeQuote
        ?.pricing_discount || 0
    ),

    total: Number(
      authoritativeQuote?.total || 0
    ),

    applied_rules:
      authoritativeQuote
        ?.applied_rules || [],
  },
};
      },
    });

    const result =
      operation.responseBody;



    if (!operation.replayed) {
      await audit(
      req,
      "POS_GROUPED_ORDER_CREATED",
      {
        table: tableName,
        order_type,
        items_count: items.length,
        batch_id: result.batch_id,
      },
      { entity: "order_batch", entity_id: result.batch_id }
    );
    }



    
  return res.status(201).json({
  success: true,
  message:
    "✅ Grouped order placed successfully!",

  submission_id:
    submissionId,

  batch_id:
    result.batch_id,

  pickup_number:
    result.pickup_number || null,

  deductionReport:
    result.deductionReport,

  pricingComparison:
    result.pricingComparison,

  subtotal: Number(
    result.pricing?.subtotal || 0
  ),

  pricing_discount: Number(
    result.pricing
      ?.pricing_discount || 0
  ),

  total: Number(
    result.pricing?.total || 0
  ),

  applied_rules:
    result.pricing
      ?.applied_rules || [],
});

    } catch (err) {

  const idempotencyCode =
    String(
      err?.code || ""
    );

  if (
    idempotencyCode.startsWith(
      "EDGE_IDEMPOTENCY_"
    )
  ) {
    return res
      .status(409)
      .json({
        success: false,

        error:
          err.message,

        detail:
          err.message,

        code:
          idempotencyCode,
      });
  }

  // =====================================================
  // ITEM AVAILABILITY
  // =====================================================

  if (
    err instanceof
    ItemAvailabilityError
  ) {
    console.warn(
      "⚠️ ITEM AVAILABILITY BLOCKED:",
      {
        message:
          err.message,

        code:
          err.code,

        item_type:
          err.itemType,

        item_id:
          err.itemId,

        available:
          err.available,

        requested:
          err.requested,
      }
    );

    return res
      .status(
        Number(
          err.status || 409
        )
      )
      .json({
        success: false,

        error:
          err.message,

        detail:
          err.message,

        code:
          err.code,

        item_type:
          err.itemType,

        item_id:
          err.itemId,

        available:
          err.available,

        requested:
          err.requested,
      });
  }

    // ✅ Authoritative pricing errors should be 400, not 500
    if (err instanceof PricingError) {
      console.warn("⚠️ Authoritative pricing rejected order:", {
        message: err.message,
        code: err.code || null,
        details: err.details || null,
      });

      return res.status(400).json({
        success: false,
        error: err.message,
        detail: err.message,
        code: err.code || "PRICING_ERROR",
        details: err.details || null,
      });
    }

    // ✅ Keep existing stock and generic error handling
    console.error("❌ POST /orders/grouped failed:", err);

    const msg = String(err?.message || "Internal server error.");
    const lowerMsg = msg.toLowerCase();

    const isStockError =
      lowerMsg.includes("not enough stock") ||
      lowerMsg.includes("does not have enough stock") ||
      lowerMsg.includes("not have enough stock") ||
      lowerMsg.includes("out of stock");

    console.log("🚨 GROUPED ERROR RESPONSE:", {
      msg,
      isStockError,
      status: isStockError ? 409 : 500,
    });

    return res.status(isStockError ? 409 : 500).json({
      success: false,
      error: msg,
      detail: msg,
      code: isStockError ? "STOCK_BLOCKED" : "ORDER_GROUPED_FAILED",
    });
  }
});

// GET /orders
router.get("/", requireRole(...POS_STAFF), async (req, res) => {
  const { status, table } = req.query;
  const restaurantId = req.tenantRid;

  const isPg = kind === "pg";
  const params = [restaurantId];

  let sql = isPg
    ? `SELECT * FROM pos_orders WHERE restaurant_id = $1`
    : `SELECT * FROM pos_orders WHERE restaurant_id = ?`;

  if (status) {
    params.push(status);
    sql += isPg ? ` AND order_status = $${params.length}` : ` AND order_status = ?`;
  }

  if (table) {
    params.push(canonicalTableName(table));
    sql += isPg ? ` AND table_number = $${params.length}` : ` AND table_number = ?`;
  }

  sql += ` ORDER BY created_at ASC, id ASC`;

  try {
    const rows = await qAll(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("❌ Fetch POS orders error:", err);
    res.status(500).json({ error: "Error fetching POS orders." });
  }
});

// GET /orders/table/:tableNumber
router.get("/table/:tableNumber", requireRole(...POS_STAFF), async (req, res) => {
  const restaurantId = req.tenantRid;
  const tableNumber = canonicalTableName(req.params.tableNumber);

  try {
    const isPg = kind === "pg";
const rows = await qAll(
  isPg
    ? `SELECT *
       FROM pos_orders
       WHERE restaurant_id = $1
         AND table_number = $2
AND COALESCE(remaining_price, total_price, 0) > 0
       ORDER BY created_at ASC, id ASC`
    : `SELECT *
       FROM pos_orders
       WHERE restaurant_id = ?
         AND table_number = ?
AND COALESCE(remaining_price, total_price, 0) > 0
       ORDER BY created_at ASC, id ASC`,
  [restaurantId, tableNumber]
);

    res.json(rows);
  } catch (err) {
    console.error("❌ Table orders error:", err);
    res.status(500).json({ error: "Error fetching table orders." });
  }
});

router.post(
  "/kds-resend",
  requirePermission(
    PERMISSIONS.KDS_RESEND
  ),
  async (req, res) => {
    try {
      const rid =
        Number(
          req.tenantRid || 0
        );

      const {
        table_number,
      } =
        req.body || {};

      if (!rid) {
        return res
          .status(400)
          .json({
            error:
              "Missing tenant.",
          });
      }

      if (kind !== "pg") {
        return res
          .status(500)
          .json({
            error:
              "Postgres required.",
          });
      }

      const table =
        canonicalTableName(
          table_number
        );

      if (!table) {
        return res
          .status(400)
          .json({
            error:
              "table_number is required.",
          });
      }

      const result =
        await withTx(
          async (tx) => {
            /*
             * =====================================================
             * KDS REBUILD SERIALIZATION
             * =====================================================
             *
             * Two terminals/devices may request a rebuild at the
             * same time.
             *
             * Serialize rebuilds for this restaurant + table for
             * the duration of this PostgreSQL transaction.
             *
             * hashtext collisions would only cause extra locking;
             * they cannot weaken tenant isolation.
             */
            const lockKey =
              `kds-resend:${rid}:${String(
                table
              )
                .trim()
                .toLowerCase()}`;

            await tx.qGet(
              `
              SELECT
                pg_advisory_xact_lock(
                  hashtext($1)::bigint
                )
              `,
              [lockKey]
            );

            /*
             * =====================================================
             * AUTHORITATIVE UNPAID ROWS
             * =====================================================
             *
             * Lock the actual POS rows being rebuilt.
             *
             * We also read their existing order_batches so the new
             * ticket preserves the real order type.
             */
            const rows =
              await tx.qAll(
                `
                SELECT
                  po.id,
                  po.batch_id,
                  po.table_number,
                  po.created_at,

                  COALESCE(
                    NULLIF(
                      LOWER(
                        TRIM(
                          ob.order_type
                        )
                      ),
                      ''
                    ),

                    CASE
                      WHEN LOWER(
                        TRIM(
                          COALESCE(
                            po.table_number,
                            ''
                          )
                        )
                      ) = 'delivery'
                        THEN 'delivery'

                      WHEN LOWER(
                        TRIM(
                          COALESCE(
                            po.table_number,
                            ''
                          )
                        )
                      ) = 'takeaway'
                        THEN 'takeaway'

                      ELSE 'dine-in'
                    END
                  ) AS order_type

                FROM public.pos_orders po

                LEFT JOIN public.order_batches ob
                  ON ob.restaurant_id =
                       po.restaurant_id
                 AND ob.id =
                       po.batch_id

                WHERE po.restaurant_id = $1

                  AND LOWER(
                    TRIM(
                      po.table_number
                    )
                  ) =
                  LOWER(
                    TRIM($2)
                  )

                  AND COALESCE(
                    po.paid,
                    0
                  ) = 0

                  AND COALESCE(
                    po.remaining_price,
                    po.total_price,
                    0
                  ) > 0

                ORDER BY
                  po.created_at ASC,
                  po.id ASC

                FOR UPDATE OF po
                `,
                [
                  rid,
                  table,
                ]
              );

            if (!rows.length) {
              const err =
                new Error(
                  "No unpaid items found to rebuild KDS ticket."
                );

              err.status = 404;

              throw err;
            }

            /*
             * Existing batches referenced by the rows before
             * rebuilding.
             */
            const oldBatchIds =
              Array.from(
                new Set(
                  rows
                    .map(
                      (row) =>
                        String(
                          row.batch_id ||
                          ""
                        ).trim()
                    )
                    .filter(isUuid)
                )
              );

            /*
             * Preserve the authoritative original order type.
             *
             * Normally every row on the table belongs to the same
             * logical ticket. If legacy rows disagree, use the
             * first authoritative row rather than browser input.
             */
            const originalOrderType =
              String(
                rows.find(
                  (row) =>
                    String(
                      row.order_type ||
                      ""
                    ).trim()
                )?.order_type ||
                ""
              )
                .trim()
                .toLowerCase();

            const safeOrderType =
              [
                "dine-in",
                "takeaway",
                "delivery",
              ].includes(
                originalOrderType
              )
                ? originalOrderType
                : (
                    String(table)
                      .trim()
                      .toLowerCase() ===
                    "takeaway"
                  )
                  ? "takeaway"
                  : (
                      String(table)
                        .trim()
                        .toLowerCase() ===
                      "delivery"
                    )
                    ? "delivery"
                    : "dine-in";

            const newBatchId =
              makeBatchId();

            /*
             * =====================================================
             * CREATE REPLACEMENT BATCH
             * =====================================================
             */
            await tx.qRun(
              `
              INSERT INTO public.order_batches (
                id,
                restaurant_id,
                table_number,
                order_type,
                created_at
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                NOW()
              )
              `,
              [
                newBatchId,
                rid,
                table,
                safeOrderType,
              ]
            );

            /*
             * =====================================================
             * MOVE ONLY THE ROWS WE LOCKED
             * =====================================================
             *
             * Don't issue another broad table UPDATE based purely
             * on table name after the authoritative SELECT.
             */
            const rowIds =
              rows.map(
                (row) =>
                  Number(row.id)
              );

            await tx.qRun(
              `
              UPDATE public.pos_orders
              SET
                batch_id = $1,
                kds_archived_at = NULL,
                order_status = 'open'
              WHERE restaurant_id = $2
                AND id = ANY($3::bigint[])
              `,
              [
                newBatchId,
                rid,
                rowIds,
              ]
            );

            /*
             * =====================================================
             * REMOVE OLD DEVICE/ITEM STATE
             * =====================================================
             */
            if (
              oldBatchIds.length
            ) {
              await tx.qRun(
                `
                DELETE FROM public.kds_station_ack
                WHERE restaurant_id = $1
                  AND batch_id =
                    ANY($2::uuid[])
                `,
                [
                  rid,
                  oldBatchIds,
                ]
              );

              await tx.qRun(
                `
                DELETE FROM public.kds_item_state
                WHERE restaurant_id = $1
                  AND batch_id =
                    ANY($2::uuid[])
                `,
                [
                  rid,
                  oldBatchIds,
                ]
              );
            }

            /*
             * Defensive cleanup. A brand-new batch should never
             * contain KDS state, but keep that invariant explicit.
             */
            await tx.qRun(
              `
              DELETE FROM public.kds_station_ack
              WHERE restaurant_id = $1
                AND batch_id =
                  $2::uuid
              `,
              [
                rid,
                newBatchId,
              ]
            );

            await tx.qRun(
              `
              DELETE FROM public.kds_item_state
              WHERE restaurant_id = $1
                AND batch_id =
                  $2::uuid
              `,
              [
                rid,
                newBatchId,
              ]
            );

            /*
             * =====================================================
             * DELETE OBSOLETE ORDER_BATCH RECORDS
             * =====================================================
             *
             * This is what prevents simultaneous/sequential resend
             * requests from leaving orphan order_batches behind.
             *
             * Only delete a batch when NO POS row in this tenant
             * references it anymore.
             */
            if (
              oldBatchIds.length
            ) {
              await tx.qRun(
                `
                DELETE FROM public.order_batches ob
                WHERE ob.restaurant_id = $1
                  AND ob.id =
                    ANY($2::uuid[])

                  AND NOT EXISTS (
                    SELECT 1
                    FROM public.pos_orders po
                    WHERE
                      po.restaurant_id =
                        ob.restaurant_id
                      AND po.batch_id =
                        ob.id
                  )
                `,
                [
                  rid,
                  oldBatchIds,
                ]
              );
            }

            /*
             * Final transaction invariant:
             * every row we rebuilt must point to this batch.
             */
            const verification =
              await tx.qGet(
                `
                SELECT
                  COUNT(*)::int AS total_rows,

                  COUNT(*) FILTER (
                    WHERE batch_id =
                      $1::uuid
                  )::int AS correct_rows

                FROM public.pos_orders

                WHERE restaurant_id = $2
                  AND id =
                    ANY($3::bigint[])
                `,
                [
                  newBatchId,
                  rid,
                  rowIds,
                ]
              );

            if (
              Number(
                verification
                  ?.total_rows || 0
              ) !==
                rows.length ||

              Number(
                verification
                  ?.correct_rows || 0
              ) !==
                rows.length
            ) {
              throw new Error(
                "KDS rebuild integrity check failed."
              );
            }

            return {
              newBatchId,
              oldBatchIds,
              rowCount:
                rows.length,
              orderType:
                safeOrderType,
            };
          }
        );

      /*
       * Audit after successful commit.
       */
      try {
        await audit(
          req,
          "pos.kds_rebuild_ticket",
          {
            table_number:
              table,

            old_batch_ids:
              result.oldBatchIds,

            new_batch_id:
              result.newBatchId,

            unpaid_row_count:
              result.rowCount,

            order_type:
              result.orderType,
          }
        );
      } catch {}

      return res.json({
        ok: true,

        message:
          "KDS ticket rebuilt from unpaid items.",

        batch_id:
          result.newBatchId,

        rows:
          result.rowCount,

        order_type:
          result.orderType,
      });
    } catch (err) {
      console.error(
        "❌ /orders/kds-resend rebuild failed:",
        err
      );

      const status =
        Number(
          err?.status || 500
        );

      return res
        .status(status)
        .json({
          error:
            status === 404
              ? err.message
              : "Failed to rebuild KDS ticket.",

          detail:
            err?.message ||
            "Unknown error",
        });
    }
  }
);

// GET /orders/by-table/:tableNumber
router.get(
  "/by-table/:tableNumber",
  requireRole(...POS_STAFF),
  async (req, res) => {
    const restaurantId = Number(req.tenantRid || 0);
    const tableNumber = canonicalTableName(req.params.tableNumber);
    const batchId = String(req.query.batch_id || "").trim();

    if (!restaurantId) {
      return res.status(400).json({ error: "Missing tenant" });
    }

    try {
      const rows = await qAll(
        `
        SELECT
          po.*,
          ob.order_type,
          ob.pickup_number,
          ob.delivery_status,
          ob.delivery_code
        FROM public.pos_orders po
        LEFT JOIN public.order_batches ob
          ON ob.restaurant_id = po.restaurant_id
         AND ob.id = po.batch_id
        WHERE po.restaurant_id = $1
          AND (
            ($3::uuid IS NOT NULL AND po.batch_id = $3::uuid)
            OR
            (
              $3::uuid IS NULL
              AND (
                LOWER(TRIM(po.table_number)) = LOWER(TRIM($2))
                OR (
                  regexp_replace(
                    LOWER(TRIM(po.table_number)),
                    '[^0-9]',
                    '',
                    'g'
                  ) <> ''
                  AND regexp_replace(
                    LOWER(TRIM($2)),
                    '[^0-9]',
                    '',
                    'g'
                  ) <> ''
                  AND regexp_replace(
                    LOWER(TRIM(po.table_number)),
                    '[^0-9]',
                    '',
                    'g'
                  ) =
                  regexp_replace(
                    LOWER(TRIM($2)),
                    '[^0-9]',
                    '',
                    'g'
                  )
                )
              )
            )
          )
          AND COALESCE(po.remaining_price, po.total_price, 0) > 0
        ORDER BY po.created_at ASC, po.id ASC
        `,
        [restaurantId, tableNumber, batchId || null]
      );

      return res.json(rows || []);
    } catch (err) {
      console.error("❌ GET /orders/by-table failed:", err);
      return res.status(500).json({
        error: "Failed to load table orders.",
      });
    }
  }
);

router.put("/:id/status", authenticateToken, async (req, res) => {
  try {
    const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
    const id = Number(req.params.id);
    const status = String(req.body?.status || "free").trim().toLowerCase();

    if (!rid) return res.status(400).json({ error: "Missing tenant" });
    if (!id) return res.status(400).json({ error: "Invalid table id" });
    if (!["free","reserved","occupied"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const isPg = kind === "pg";

    // canonical status
    await qRun(
      isPg
        ? `UPDATE public.tables SET status=$1 WHERE restaurant_id=$2 AND id=$3`
        : `UPDATE tables SET status=? WHERE restaurant_id=? AND id=?`,
      isPg ? [status, rid, id] : [status, rid, id]
    );

    // keep map in sync for UI
    await qRun(
      isPg
        ? `UPDATE public.table_map SET status=$1 WHERE restaurant_id=$2 AND id=$3`
        : `UPDATE table_map SET status=? WHERE restaurant_id=? AND id=?`,
      isPg ? [status, rid, id] : [status, rid, id]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("❌ PUT /tables/:id/status failed:", e);
    res.status(500).json({ error: "Failed to update status" });
  }
});

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return v; }
}

// ✅ GET Receipt items for a table
router.get("/receipt/:table", requireRole(...POS_STAFF), async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const table = canonicalTableName(req.params.table);

    const isPg = kind === "pg";
    const rows = await qAll(
      isPg
        ? `SELECT id, batch_id, table_number, item_name, item_type, quantity, total_price, paid, created_at, options, note
           FROM pos_orders
           WHERE restaurant_id = $1
             AND table_number = $2
           ORDER BY created_at DESC, id DESC
           LIMIT 200`
        : `SELECT id, batch_id, table_number, item_name, item_type, quantity, total_price, paid, created_at, options, note
           FROM pos_orders
           WHERE restaurant_id = ?
             AND table_number = ?
           ORDER BY created_at DESC, id DESC
           LIMIT 200`,
      [rid, table]
    );

    const items = (rows || []).map((r) => ({
      id: r.id,
      batch_id: r.batch_id || null,
      meal_name: r.item_name || "",
      item_name: r.item_name || "",
      quantity: Number(r.quantity || 1),
      total_price: Number(r.total_price || 0),
      category: r.item_type || "meal",
      created_at: r.created_at,
      paid: Number(r.paid || 0),
      options: r.options ?? null,
      note: r.note ?? null,
    }));

    res.json({ table_number: table, items });
  } catch (e) {
    console.error("❌ GET /orders/receipt/:table failed:", e);
    res.status(500).json({ error: "Failed to load receipt" });
  }
});

router.post(
  "/close",

  requirePermission(
    PERMISSIONS.POS_CLOSE_TABLE
  ),

  async (req, res) => {
    try {
      const rid =
        Number(
          req.tenantRid ||
          req.user?.restaurant_id ||
          0
        );

      const tableName =
        canonicalTableName(
          req.body?.table_number ||
          req.body?.tableNumber
        );

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing tenant",
        });
      }

      if (!tableName) {
        return res.status(400).json({
          error:
            "Table number required.",
        });
      }

      const closeReason =
        String(
          req.body?.close_reason ||
          ""
        )
          .trim()
          .slice(0, 300);

      const managerPin =
        String(
          req.body?.manager_pin ||
          ""
        ).trim();

      const result =
        await withTx(
          async (tx) => {
            /*
             * Serialize close against mark-paid,
             * pay-share, void and transfer.
             */
            const rows =
              await tx.qAll(
                `
                SELECT
                  id,

                  COALESCE(
                    amount_paid,
                    0
                  )::numeric
                    AS amount_paid,

                  COALESCE(
                    remaining_price,
                    total_price,
                    0
                  )::numeric
                    AS remaining_price

                FROM public.pos_orders

                WHERE restaurant_id =
                      $1

                  AND LOWER(
                        TRIM(
                          table_number
                        )
                      ) =
                      LOWER(
                        TRIM($2)
                      )

                  AND COALESCE(
                        paid,
                        0
                      ) = 0

                  AND COALESCE(
                        remaining_price,
                        total_price,
                        0
                      ) > 0

                ORDER BY
                  created_at ASC,
                  id ASC

                FOR UPDATE
                `,
                [
                  rid,
                  tableName,
                ]
              );

            const unpaidTotal =
              round2(
                rows.reduce(
                  (
                    sum,
                    row
                  ) =>
                    sum +
                    Number(
                      row.remaining_price ||
                      0
                    ),
                  0
                )
              );

            const unpaidCount =
              rows.length;

            let closeApprover =
              null;

            if (
              unpaidTotal > 0
            ) {
              if (
                !/^\d{4}$/.test(
                  managerPin
                )
              ) {
                const error =
                  new Error(
                    "Manager or owner approval required to close an unpaid table."
                  );

                error.status =
                  403;

                error.code =
                  "UNPAID_CLOSE_APPROVAL_REQUIRED";

                error.detail = {
                  requires_manager_pin:
                    true,

                  unpaid_total:
                    unpaidTotal,

                  unpaid_count:
                    unpaidCount,
                };

                throw error;
              }

              if (!closeReason) {
                const error =
                  new Error(
                    "A reason is required to close an unpaid table."
                  );

                error.status =
                  400;

                error.code =
                  "UNPAID_CLOSE_REASON_REQUIRED";

                throw error;
              }

              /*
               * Do not erase an already-recorded partial
               * payment by converting it into closed_unpaid.
               */
              if (
                rows.some(
                  (row) =>
                    Number(
                      row.amount_paid ||
                      0
                    ) > 0.01
                )
              ) {
                const error =
                  new Error(
                    "This bill contains recorded payments. Resolve those payments before closing it as unpaid."
                  );

                error.status =
                  409;

                error.code =
                  "PAID_AMOUNT_EXISTS";

                throw error;
              }

              closeApprover =
                await verifyPosApprover({
                  restaurantId:
                    rid,

                  pin:
                    managerPin,

                  permission:
                    PERMISSIONS.POS_CLOSE_UNPAID_TABLE,
                });

              if (!closeApprover) {
                const error =
                  new Error(
                    "Manager or owner approval failed."
                  );

                error.status =
                  403;

                error.code =
                  "UNPAID_CLOSE_APPROVAL_DENIED";

                throw error;
              }

              const ids =
                rows.map(
                  (row) =>
                    Number(
                      row.id
                    )
                );

              const updated =
                await tx.qRun(
                  `
                  UPDATE public.pos_orders

                  SET
                    order_status =
                      'closed_unpaid',

                    remaining_price =
                      0,

                    amount_paid =
                      0,

                    kds_archived_at =
                      NOW()

                  WHERE restaurant_id =
                        $1

                    AND id =
                        ANY(
                          $2::bigint[]
                        )

                    AND COALESCE(
                          paid,
                          0
                        ) = 0

                    AND COALESCE(
                          amount_paid,
                          0
                        ) <= 0.01

                    AND COALESCE(
                          remaining_price,
                          total_price,
                          0
                        ) > 0
                  `,
                  [
                    rid,
                    ids,
                  ]
                );

              const changed =
                Number(
                  updated?.rowCount ||
                  updated?.changes ||
                  0
                );

              if (
                changed !==
                ids.length
              ) {
                const error =
                  new Error(
                    "Bill changed while table close was being processed."
                  );

                error.status =
                  409;

                error.code =
                  "TABLE_CLOSE_STATE_CHANGED";

                throw error;
              }
            }

            await setTableStatus(
              tx.qRun.bind(tx),
              rid,
              tableName,
              "free"
            );

            await clearTableSessionByName(
              tx.qRun.bind(tx),
              rid,
              tableName
            );

            const tableSync =
              await emitTableOperationalIfEdge(
                tx,
                rid,
                tableName
              );

            return {
              unpaidTotal,
              unpaidCount,
              closeApprover,
              tableSync,
            };
          }
        );

      try {
        await audit(
          req,
          "POS_TABLE_CLOSED",
          {
            table_number:
              tableName,

            unpaid_close:
              result.unpaidTotal >
              0,

            unpaid_total:
              result.unpaidTotal,

            unpaid_items_count:
              result.unpaidCount,

            reason:
              result.unpaidTotal > 0
                ? closeReason
                : null,

            approved_by_user_id:
              result
                .closeApprover
                ?.id ||
              null,

            approved_by_authority:
              result
                .closeApprover
                ?.authority ||
              null,
          },
          {
            entity:
              "table",

            entity_id:
              tableName,
          }
        );
      } catch (
        auditError
      ) {
        console.error(
          "⚠️ Table close committed but audit failed:",
          auditError
        );
      }

      return res.json({
        success:
          true,

        message:
          result.unpaidTotal > 0
            ? `✅ ${tableName} closed with unpaid balance logged.`
            : `✅ ${tableName} marked as free.`,

        status:
          "free",

        unpaid_close:
          result.unpaidTotal >
          0,

        unpaid_total:
          result.unpaidTotal,

        unpaid_count:
          result.unpaidCount,
      });
    } catch (err) {
      console.error(
        "❌ POS /orders/close failed:",
        err
      );

      const status =
        Number(
          err?.status ||
          500
        );

      return res
        .status(status)
        .json({
          error:
            status >= 500
              ? "Failed to close table."
              : err.message,

          ...(err?.code
            ? {
                code:
                  err.code,
              }
            : {}),

          ...(err?.detail
            ? err.detail
            : {}),
        });
    }
  }
);

// DELETE /orders/clear-unpaid/:tableNumber
router.delete(
  "/clear-unpaid/:tableNumber",

  requireRole(
    ...POS_MANAGER
  ),

  async (req, res) => {
    return res.status(410).json({
      error:
        "Legacy unpaid-order deletion is disabled. Use the authorised void workflow.",

      code:
        "LEGACY_CLEAR_UNPAID_DISABLED",
    });
  }
);

router.put(
  "/mark-paid",
  requireMarkPaidPermissions,
  requireTenderPermissions(),
  async (req, res) => {
    req.method = "POST";
    return router.handle(req, res);
  }
);

router.put(
  "/split-pay",
  requirePermission(
    PERMISSIONS.POS_SPLIT_BILL
  ),
  async (req, res) => {
  req.method = "POST";
  return router.handle(req, res);
});

router.post(
  "/mark-paid",
  requireMarkPaidPermissions,
  requireTenderPermissions(),
  async (req, res) => {
    const fail = (status, message, detail = null) => {
      const error = new Error(message);
      error.status = status;
      error.publicMessage = message;
      error.detail = detail;
      return error;
    };

    try {
      const rid = Number(req.tenantRid || 0);

      const {
        tableNumber,
        itemIds = [],
        paymentMethod,
        payments,
        terminalRef,
        voucher,
        manualDiscountAmount = 0,
        serviceChargeAmount = 0,
      } = req.body || {};

      if (!rid) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      if (
        !tableNumber ||
        !Array.isArray(itemIds) ||
        itemIds.length === 0
      ) {
        return res.status(400).json({
          error: "tableNumber and itemIds[] required.",
        });
      }

      const table = canonicalTableName(tableNumber);

      const refreshLatestBill =
        req.body?.refreshLatestBill === true ||
        req.body?.refreshLatestBill === "true";

      const round2 = (value) =>
        Math.round((Number(value) || 0) * 100) / 100;

      const result = await withTx(async (tx) => {
        let cleanIds = itemIds
          .map((id) => Number(id))
          .filter(
            (id) =>
              Number.isInteger(id) &&
              id > 0
          );

        /*
         * Full-payment mode may request the latest complete unpaid bill.
         * Resolve it inside the same transaction as the payment.
         */
        if (refreshLatestBill) {
          const latestRows = await tx.qAll(
            `
            SELECT id
            FROM public.pos_orders
            WHERE restaurant_id = $1
              AND LOWER(TRIM(table_number)) =
                  LOWER(TRIM($2))
              AND COALESCE(paid, 0) = 0
              AND COALESCE(
                    remaining_price,
                    total_price,
                    0
                  ) > 0
            ORDER BY created_at ASC, id ASC
            FOR UPDATE
            `,
            [rid, table]
          );

          cleanIds = latestRows
            .map((row) => Number(row.id))
            .filter(Boolean);
        }

        if (!cleanIds.length) {
          throw fail(400, "Nothing to pay.");
        }

        /*
         * Lock the exact bill rows.
         *
         * This prevents another terminal from settling the same items
         * while this payment is being processed.
         */
        const amountRows =
  await tx.qAll(
    `
    SELECT
  id,
  batch_id,
  source,
  order_status,
  expires_at,

  vat_rate,
      vat_gross,
      vat_net,
      vat_amount,

      COALESCE(
        total_price,
        0
      )::numeric
        AS original_total,

      COALESCE(
        remaining_price,
        total_price,
        0
      )::numeric
        AS payable_total

    FROM public.pos_orders

    WHERE restaurant_id = $1
      AND id = ANY($2::bigint[])
      AND COALESCE(
        remaining_price,
        total_price,
        0
      ) > 0

    ORDER BY id

    FOR UPDATE
    `,
    [
      rid,
      cleanIds,
    ]
  );

        if (!amountRows.length) {
  throw fail(
    400,
    "Nothing to pay. These items may already have been settled."
  );
}

/*
 * =====================================================
 * QR / KIOSK EXPIRY AUTHORITY
 * =====================================================
 *
 * Held QR/kiosk orders have a limited pending-payment
 * lifetime.
 *
 * This check happens AFTER the authoritative tenant-owned
 * rows have been locked with FOR UPDATE.
 *
 * Therefore payment and expiry cleanup cannot both win
 * against the same POS row.
 *
 * Never trust an expiry supplied by the browser.
 */
const expiredHeldRows =
  amountRows.filter(
    (row) => {
      const source =
        String(
          row.source || ""
        )
          .trim()
          .toLowerCase();

      const status =
        String(
          row.order_status || ""
        )
          .trim()
          .toLowerCase();

      if (
        !["qr", "kiosk"].includes(
          source
        )
      ) {
        return false;
      }

      if (
        status !==
        "pending_payment"
      ) {
        return false;
      }

      if (!row.expires_at) {
        return false;
      }

      const expiry =
        new Date(
          row.expires_at
        );

      if (
        Number.isNaN(
          expiry.getTime()
        )
      ) {
        /*
         * Invalid lifecycle data must fail closed.
         */
        return true;
      }

      return (
        expiry.getTime() <=
        Date.now()
      );
    }
  );

if (
  expiredHeldRows.length
) {
  throw fail(
    410,
    "This QR/kiosk order has expired and can no longer be paid.",
    {
      code:
        "PENDING_ORDER_EXPIRED",

      item_ids:
        expiredHeldRows
          .map(
            (row) =>
              Number(row.id)
          )
          .filter(Boolean),
    }
  );
}

/*
 * Only use rows that were actually found and locked.
 * Never trust item IDs from the frontend after this point.
 */
cleanIds =
  amountRows
    .map(
      (row) =>
        Number(row.id)
    )
    .filter(Boolean);

        const grossAmount = round2(
          amountRows.reduce(
            (sum, row) =>
              sum + Number(row.original_total || 0),
            0
          )
        );

        const dealAdjustedAmount = round2(
          amountRows.reduce(
            (sum, row) =>
              sum + Number(row.payable_total || 0),
            0
          )
        );

        const pricingDiscount = round2(
          Math.max(
            0,
            grossAmount - dealAdjustedAmount
          )
        );

        if (!(grossAmount > 0)) {
          throw fail(400, "Nothing to pay.");
        }

        if (!(dealAdjustedAmount > 0)) {
          throw fail(400, "Nothing to pay.");
        }

        /*
         * Voucher validation is done under a row lock.
         * This prevents two terminals using the last available redemption.
         */
        let voucherDiscount = 0;
        let voucherRow = null;

        if (voucher?.code) {
          const voucherCode = String(voucher.code)
            .trim()
            .toUpperCase();

          voucherRow = await tx.qGet(
            `
            SELECT *
            FROM public.vouchers
            WHERE restaurant_id = $1
              AND UPPER(TRIM(code)) = $2
            LIMIT 1
            FOR UPDATE
            `,
            [rid, voucherCode]
          );

          if (!voucherRow) {
            throw fail(400, "Voucher not found.");
          }

          if (!voucherRow.active) {
            throw fail(400, "Voucher is inactive.");
          }

          const now = new Date();

          if (
            voucherRow.starts_at &&
            new Date(voucherRow.starts_at) > now
          ) {
            throw fail(
              400,
              "Voucher is not active yet."
            );
          }

          if (
            voucherRow.expires_at &&
            new Date(voucherRow.expires_at) < now
          ) {
            throw fail(400, "Voucher has expired.");
          }

          if (
            voucherRow.usage_limit !== null &&
            Number(voucherRow.used_count || 0) >=
              Number(voucherRow.usage_limit)
          ) {
            throw fail(
              400,
              "Voucher usage limit reached."
            );
          }

          if (
            voucherRow.min_spend !== null &&
            grossAmount <
              Number(voucherRow.min_spend)
          ) {
            throw fail(
              400,
              `Minimum spend is £${Number(
                voucherRow.min_spend
              ).toFixed(2)}.`
            );
          }

          voucherDiscount =
            String(
              voucherRow.discount_type || ""
            ).toLowerCase() === "percent"
              ? round2(
                  (
                    dealAdjustedAmount *
                    Number(
                      voucherRow.discount_value || 0
                    )
                  ) / 100
                )
              : round2(
                  Number(
                    voucherRow.discount_value || 0
                  )
                );

          voucherDiscount = round2(
            Math.max(
              0,
              Math.min(
                dealAdjustedAmount,
                voucherDiscount
              )
            )
          );
        }

        const requestedManualDiscount =
  round2(
    Math.max(
      0,
      round2(
        manualDiscountAmount
      )
    )
  );

const maxDiscountPercent =
  Math.max(
    0,
    Math.min(
      100,
      Number(
        req.posPolicy
          ?.maxManualDiscountPercent ??
          0
      )
    )
  );

const maxManualDiscountAmount =
  round2(
    dealAdjustedAmount *
      (
        maxDiscountPercent /
        100
      )
  );

if (
  requestedManualDiscount >
  maxManualDiscountAmount + 0.01
) {
  throw fail(
    400,
    `Manual discount exceeds the restaurant maximum of ${maxDiscountPercent}%.`
  );
}

const manualDiscount =
  round2(
    Math.min(
      dealAdjustedAmount,
      requestedManualDiscount
    )
  );

/*
 * Service charge is still received as an amount
 * from the POS for now, but it cannot exist unless
 * the restaurant policy has service charge enabled.
 *
 * When we wire PosPage next, the browser will calculate
 * this from the centrally stored restaurant rate.
 */
const serviceCharge =
  round2(
    Math.max(
      0,
      round2(
        serviceChargeAmount
      )
    )
  );

        const finalAmount = round2(
          Math.max(
            0,
            dealAdjustedAmount -
              voucherDiscount -
              manualDiscount +
              serviceCharge
          )
        );

        const settlementVat =
  calculateSettlementVatBreakdown({
    amountRows,

    voucherDiscount,

    manualDiscount,

    serviceCharge,

    serviceChargeVatMode:
      req.posPolicy
        ?.serviceChargeVatMode ||
      "discretionary",
  });

  const vatReconciledTotal =
  round2(
    settlementVat.taxable_gross +
      settlementVat.unclassified_gross +
      settlementVat
        .service_charge_outside_scope
  );


if (
  Math.abs(
    vatReconciledTotal -
      finalAmount
  ) > 0.02
) {
  throw fail(
    500,
    "VAT settlement reconciliation failed."
  );
}
        /*
         * Build authoritative payment lines.
         */
        let payLines;

        if (
          Array.isArray(payments) &&
          payments.length
        ) {
          payLines = payments.map((payment) => ({
            method: normalizePayMethod(
              payment?.method
            ),
            amount: round2(payment?.amount),
          }));
        } else {
          payLines = [
            {
              method:
                normalizePayMethod(paymentMethod),
              amount: finalAmount,
            },
          ];
        }

        if (
          payLines.some(
            (payment) =>
              payment.method === "unknown"
          )
        ) {
          throw fail(
            400,
            "Invalid payment method."
          );
        }

        if (
          payLines.some(
            (payment) =>
              !Number.isFinite(payment.amount) ||
              payment.amount < 0
          )
        ) {
          throw fail(
            400,
            "Invalid payment amount."
          );
        }

        const payLinesTotal = round2(
          payLines.reduce(
            (sum, payment) =>
              sum + round2(payment.amount),
            0
          )
        );

        if (
          Math.abs(
            payLinesTotal - finalAmount
          ) > 0.01
        ) {
          throw fail(
            400,
            "Payment lines total must match final bill total."
          );
        }

        /*
         * Collect the bill's batch IDs.
         *
         * A settlement receives a batch_id only when all items belong
         * to the same batch.
         */
        const batchIds = Array.from(
          new Set(
            amountRows
              .map((row) => row.batch_id)
              .filter(Boolean)
              .map(String)
          )
        );

        const batchId =
          batchIds.length === 1
            ? batchIds[0]
            : null;

        /*
         * Serialize invoice allocation per restaurant.
         *
         * This removes the MAX(invoice_number) race between terminals.
         */
        await tx.qGet(
          `
          SELECT pg_advisory_xact_lock($1, $2)
          `,
          [rid, 7101]
        );

        const invoiceRow = await tx.qGet(
          `
          SELECT
            COALESCE(
              MAX(invoice_number),
              0
            ) + 1 AS next
          FROM public.pos_orders
          WHERE restaurant_id = $1
          `,
          [rid]
        );

        const nextInvoiceNumber = Number(
          invoiceRow?.next || 1
        );

        /*
         * Temporary breakdown:
         *
         * The current payable row values already include the complete
         * pricing-rule adjustment. Until the pricing engine returns a
         * separate happy-hour amount, that amount remains zero and the
         * complete rule discount is stored in pricing_discount_amount.
         */
        const happyHourDiscount = 0;
        const appliedRuleIds = [];

        const pricingSnapshot = {
          version: 2,
          calculation_source:
            "pos_orders_remaining_price",

          gross_amount: grossAmount,

          pricing_discount_amount:
            pricingDiscount,

          happy_hour_discount_amount:
            happyHourDiscount,

          deal_adjusted_amount:
            dealAdjustedAmount,

          voucher: voucherRow
            ? {
                id: Number(voucherRow.id),
                code: voucherRow.code,
                discount_type:
                  voucherRow.discount_type,
                discount_value: Number(
                  voucherRow.discount_value || 0
                ),
                discount_amount:
                  voucherDiscount,
              }
            : null,

          manual_discount_amount:
            manualDiscount,

          service_charge_amount:
            serviceCharge,

          final_amount: finalAmount,

vat: {
  service_charge_vat_mode:
    settlementVat
      .service_charge_vat_mode,

  taxable_gross:
    settlementVat
      .taxable_gross,

  net_amount:
    settlementVat
      .net_amount,

  vat_amount:
    settlementVat
      .vat_amount,

  unclassified_gross:
    settlementVat
      .unclassified_gross,

  service_charge_outside_scope:
    settlementVat
      .service_charge_outside_scope,

  buckets:
    settlementVat.buckets,

  lines:
    settlementVat.lines,
},

          payment_lines: payLines.map(
            (payment) => ({
              method: payment.method,
              amount: payment.amount,
            })
          ),

          item_totals: amountRows.map(
            (row) => ({
              pos_order_id: Number(row.id),
              original_total: round2(
                row.original_total
              ),
              payable_total: round2(
                row.payable_total
              ),
            })
          ),
        };

        /*
         * Create exactly one immutable settlement for this bill.
         */
        const settlement =
          await createPaymentSettlement({
            tx,

            restaurantId: rid,
            tableNumber: table,
            batchId,
            invoiceNumber:
              nextInvoiceNumber,

            grossAmount,
            pricingDiscountAmount:
              pricingDiscount,
            happyHourDiscountAmount:
              happyHourDiscount,
            dealAdjustedAmount,

            voucherId:
              voucherRow?.id || null,
            voucherCode:
              voucherRow?.code || null,
            voucherDiscountAmount:
              voucherDiscount,

            manualDiscountAmount:
              manualDiscount,
            serviceChargeAmount:
              serviceCharge,
            finalAmount,

            appliedRuleIds,
            posOrderIds: cleanIds,
            pricingSnapshot,

            source: "pos",
            createdByUserId:
              req.user?.id || null,
          });

        /*
         * Mark the locked bill rows paid.
         */
        const updateResult =
          await tx.qRun(
            `
            UPDATE public.pos_orders
            SET
              paid = 1,
              invoice_number = $3,
              amount_paid = COALESCE(
                remaining_price,
                total_price,
                0
              ),
              remaining_price = 0
            WHERE restaurant_id = $1
              AND id = ANY($2::bigint[])
              AND COALESCE(paid, 0) = 0
              AND COALESCE(
                    remaining_price,
                    total_price,
                    0
                  ) > 0
            `,
            [
              rid,
              cleanIds,
              nextInvoiceNumber,
            ]
          );

        const changes = Number(
          updateResult?.rowCount || 0
        );

        if (
          changes !== cleanIds.length
        ) {
          throw fail(
            409,
            "The bill changed while payment was being processed. No payment was recorded."
          );
        }

        /*
         * Release paid QR/kiosk batches to KDS.
         *
         * Important: this helper expects the transaction itself:
         * releasePaidHeldOrderToKds(tx, rid, batchId)
         */
        for (const oneBatchId of batchIds) {
          await releasePaidHeldOrderToKds(
            tx,
            rid,
            oneBatchId
          );
        }

        /*
         * Every cash/card line references the same settlement.
         */
        const recordedPayments = [];

        for (const payment of payLines) {
          /*
           * A fully discounted bill may have a £0 final amount.
           * Do not create a meaningless £0 payment tender row.
           */
          if (payment.amount <= 0) {
            continue;
          }

          const recorded =
            await recordPayment({
              tx,

              restaurantId: rid,
              tableNumber: table,
              amount: payment.amount,
              method: payment.method,

              userId:
                req.user?.id || null,

              batchId,
              terminalRef,
              posOrderIds: cleanIds,
              source: "pos",

              settlementId:
                settlement.id,
            });

          recordedPayments.push(recorded);
        }

        if (voucherRow?.id) {
          const voucherUpdate =
            await tx.qRun(
              `
              UPDATE public.vouchers
              SET
                used_count =
                  COALESCE(used_count, 0) + 1,
                updated_at = NOW()
              WHERE id = $1
                AND restaurant_id = $2
              `,
              [
                Number(voucherRow.id),
                rid,
              ]
            );

          if (
            Number(
              voucherUpdate?.rowCount || 0
            ) !== 1
          ) {
            throw new Error(
              "Voucher redemption could not be recorded"
            );
          }
        }

        const unpaidLeft =
          await updateTableAfterPayment(
            tx.qRun,
            tx.qGet,
            rid,
            table
          );

        if (unpaidLeft === 0) {
          await clearTableSessionByName(
            tx.qRun,
            rid,
            table
          );
        }

        await emitFinancialSettlementRecordedTx(
          tx,
          {
            restaurantId:
              rid,

            settlementId:
              settlement.id,
          }
        );

        await emitTableOperationalIfEdge(
          tx,
          rid,
          table
        );

        return {
          settlement,
          recordedPayments,

          invoiceNumber:
            nextInvoiceNumber,

          batchId,
          cleanIds,
          payLines,

          grossAmount,
          pricingDiscount,
          happyHourDiscount,
          dealAdjustedAmount,

          voucherRow,
          voucherDiscount,

          manualDiscount,
          serviceCharge,
          finalAmount,

          changes,
          unpaidLeft,
          appliedRuleIds,
          pricingSnapshot,
        };
      });

      /*
       * Audit after the financial transaction commits.
       *
       * An audit utility failure should not roll back a successful card/cash
       * settlement after the database transaction has committed.
       */
      try {
        await audit(
          req,
          "POS_MARK_PAID",
          {
            settlement_id:
              result.settlement.id,

            table,
            item_ids: result.cleanIds,

            payment_lines:
              result.payLines,

            payment_ids:
              result.recordedPayments.map(
                (payment) => payment.id
              ),

            invoice_number:
              result.invoiceNumber,

            gross_amount:
              result.grossAmount,

            pricing_discount_amount:
              result.pricingDiscount,

            happy_hour_discount_amount:
              result.happyHourDiscount,

            deal_adjusted_amount:
              result.dealAdjustedAmount,

            voucher_id:
              result.voucherRow?.id || null,

            voucher_code:
              result.voucherRow?.code || null,

            voucher_discount:
              result.voucherDiscount,

            manual_discount_amount:
              result.manualDiscount,

            service_charge_amount:
              result.serviceCharge,

            final_amount:
              result.finalAmount,
          },
          {
            entity: "payment_settlement",
            entity_id:
              result.settlement.id,
          }
        );
      } catch (auditError) {
        console.error(
          "⚠️ POS payment committed but audit failed:",
          auditError
        );
      }

      return res.json({
        success: true,

        settlement_id:
          result.settlement.id,

        invoice_number:
          result.invoiceNumber,

        batch_id:
          result.batchId,

        payment_ids:
          result.recordedPayments.map(
            (payment) => payment.id
          ),

        gross_amount:
          result.grossAmount,

        pricing_discount_amount:
          result.pricingDiscount,

        happy_hour_discount_amount:
          result.happyHourDiscount,

        deal_adjusted_amount:
          result.dealAdjustedAmount,

        voucher_id:
          result.voucherRow?.id || null,

        voucher_code:
          result.voucherRow?.code || null,

        voucher_discount:
          result.voucherDiscount,

        manual_discount_amount:
          result.manualDiscount,

        service_charge_amount:
          result.serviceCharge,

        amount:
          result.finalAmount,

          vat:
  result.pricingSnapshot
    ?.vat || null,

        applied_rule_ids:
          result.appliedRuleIds,

        table,

        changes:
          result.changes,

        unpaid_left:
          result.unpaidLeft,
      });
    } catch (err) {
      console.error(
        "❌ mark-paid error:",
        err
      );

      const status = Number(
        err?.status || 500
      );

      return res.status(status).json({
        error:
          err?.publicMessage ||
          (status >= 500
            ? "Failed to mark orders as paid."
            : err?.message),

        ...(err?.detail
          ? { detail: err.detail }
          : {}),
      });
    }
  }
);

router.post(
  "/split-by-people",
  requirePermission(
    PERMISSIONS.POS_SPLIT_BILL
  ),
  async (req, res) => {
  const restaurantId = Number(req.tenantRid || 0);
  const { table_number, tableNumber, people } = req.body || {};
  const table = canonicalTableName(tableNumber ?? table_number ?? null);
  const p = Number(people || 1);

  if (!table) return res.status(400).json({ error: "table_number required." });
  if (!p || p <= 0) return res.status(400).json({ error: "people must be > 0" });

  try {
    const isPg = kind === "pg";
    const row = await qGet(
      isPg
        ? `SELECT COALESCE(SUM(COALESCE(remaining_price, total_price, 0)), 0)::numeric AS total
           FROM public.pos_orders
           WHERE restaurant_id = $1
             AND table_number = $2
             AND COALESCE(remaining_price, total_price, 0) > 0`
        : `SELECT COALESCE(SUM(COALESCE(remaining_price, total_price, 0)), 0) AS total
           FROM pos_orders
           WHERE restaurant_id = ?
             AND table_number = ?
             AND COALESCE(remaining_price, total_price, 0) > 0`,
      [restaurantId, table]
    );

    const total = Number(row?.total || 0);
    const share = total / p;

    res.json({ total, share });
  } catch (err) {
    console.error("❌ split-by-people error:", err);
    res.status(500).json({ error: "Failed to split by people." });
  }
});

router.post(
  "/pay-share",

  requirePermission(
    PERMISSIONS.POS_SPLIT_BILL
  ),

  requireTenderPermissions({
    defaultMethod: "cash",
  }),

  async (req, res) => {
    const restaurantId =
      Number(
        req.tenantRid || 0
      );

    const {
      table_number,
      tableNumber,
      amount,
      payments,
      paymentMethod,
      method,
    } = req.body || {};

    const table =
      canonicalTableName(
        tableNumber ??
          table_number ??
          null
      );

    const requestedAmount =
      round2(
        Number(amount || 0)
      );


    if (!restaurantId) {
      return res.status(400).json({
        error: "Missing tenant",
      });
    }


    if (!table) {
      return res.status(400).json({
        error:
          "table_number required.",
      });
    }


    if (
      !Number.isFinite(
        requestedAmount
      ) ||
      requestedAmount <= 0
    ) {
      return res.status(400).json({
        error:
          "amount must be > 0",
      });
    }


    try {
      const result =
        await withTx(
          async (tx) => {
            const isPg =
              tx.kind === "pg";

            /*
             * One UUID identifies this person's
             * payment event.
             */
            const paymentBatchId =
              makeBatchId();


            // =============================================
            // 1. LOCK OUTSTANDING BILL
            // =============================================

            const items =
              await tx.qAll(
                isPg
                  ? `
                    SELECT
                      id,
                      batch_id,

                      total_price,

                      vat_rate,

                      COALESCE(
                        amount_paid,
                        0
                      )::numeric
                        AS amount_paid,

                      COALESCE(
                        remaining_price,
                        total_price,
                        0
                      )::numeric
                        AS remaining_price

                    FROM public.pos_orders

                    WHERE
                      restaurant_id = $1

                      AND
                      LOWER(
                        TRIM(
                          table_number
                        )
                      ) =
                      LOWER(
                        TRIM($2)
                      )

                      AND COALESCE(
                        remaining_price,
                        total_price,
                        0
                      ) > 0

                    ORDER BY
                      created_at ASC,
                      id ASC

                    FOR UPDATE
                  `
                  : `
                    SELECT
                      id,
                      batch_id,
                      total_price,

                      NULL AS vat_rate,

                      COALESCE(
                        amount_paid,
                        0
                      ) AS amount_paid,

                      COALESCE(
                        remaining_price,
                        total_price,
                        0
                      ) AS remaining_price

                    FROM pos_orders

                    WHERE
                      restaurant_id = ?

                      AND
                      LOWER(
                        TRIM(
                          table_number
                        )
                      ) =
                      LOWER(
                        TRIM(?)
                      )

                      AND COALESCE(
                        remaining_price,
                        total_price,
                        0
                      ) > 0

                    ORDER BY
                      created_at ASC,
                      id ASC
                  `,
                [
                  restaurantId,
                  table,
                ]
              );


            const availableTotal =
              round2(
                (items || []).reduce(
                  (
                    sum,
                    row
                  ) =>
                    sum +
                    Number(
                      row.remaining_price ||
                        0
                    ),
                  0
                )
              );


            if (
              !(
                availableTotal >
                0
              )
            ) {
              const error =
                new Error(
                  "Nothing left to pay."
                );

              error.status = 400;

              throw error;
            }


            if (
              requestedAmount -
                availableTotal >
              0.01
            ) {
              const error =
                new Error(
                  "Requested share is more than remaining unpaid total."
                );

              error.status = 400;

              throw error;
            }


            // =============================================
            // 2. PAYMENT TENDERS
            // =============================================

            let payLines = [];


            if (
              Array.isArray(
                payments
              ) &&
              payments.length
            ) {
              payLines =
                payments.map(
                  (payment) => ({
                    method:
                      normalizePayMethod(
                        payment?.method
                      ),

                    amount:
                      round2(
                        payment?.amount
                      ),
                  })
                );
            } else {
              payLines = [
                {
                  method:
                    normalizePayMethod(
                      paymentMethod ||
                        method ||
                        "cash"
                    ),

                  amount:
                    requestedAmount,
                },
              ];
            }


            if (
              payLines.some(
                (payment) =>
                  payment.method ===
                  "unknown"
              )
            ) {
              const error =
                new Error(
                  "Invalid payment method."
                );

              error.status = 400;

              throw error;
            }


            if (
              payLines.some(
                (payment) =>
                  !Number.isFinite(
                    payment.amount
                  ) ||
                  payment.amount < 0
              )
            ) {
              const error =
                new Error(
                  "Invalid payment amount."
                );

              error.status = 400;

              throw error;
            }


            const payLinesTotal =
              round2(
                payLines.reduce(
                  (
                    sum,
                    payment
                  ) =>
                    sum +
                    round2(
                      payment.amount
                    ),
                  0
                )
              );


            if (
              Math.abs(
                payLinesTotal -
                  requestedAmount
              ) > 0.01
            ) {
              const error =
                new Error(
                  "Payment lines total must match requested share amount."
                );

              error.status = 400;

              throw error;
            }


            // =============================================
            // 3. PROPORTIONAL VAT ALLOCATION
            //
            // Split-by-people is a share of the remaining
            // bill, not payment for whichever item happens
            // to appear first.
            //
            // Allocate this person's money across the
            // remaining bill proportionally for VAT.
            // =============================================

            const shareAllocations =
              allocateProportionally(
                items,
                requestedAmount,
                (row) =>
                  Number(
                    row.remaining_price ||
                      0
                  )
              );


            const vatAmountRows =
              items
                .map(
                  (
                    row,
                    index
                  ) => ({
                    id:
                      Number(
                        row.id
                      ),

                    vat_rate:
                      row.vat_rate,

                    /*
                     * For a person's share this allocated
                     * amount IS the gross amount represented
                     * by this settlement.
                     */
                    payable_total:
                      round2(
                        shareAllocations[
                          index
                        ] || 0
                      ),
                  })
                )
                .filter(
                  (row) =>
                    row.payable_total >
                    0
                );


            const settlementVat =
              calculateSettlementVatBreakdown({
                amountRows:
                  vatAmountRows,

                voucherDiscount: 0,

                manualDiscount: 0,

                serviceCharge: 0,

                serviceChargeVatMode:
                  "discretionary",
              });


            const vatReconciledTotal =
              round2(
                settlementVat
                  .taxable_gross +

                  settlementVat
                    .unclassified_gross +

                  settlementVat
                    .service_charge_outside_scope
              );


            if (
              Math.abs(
                vatReconciledTotal -
                  requestedAmount
              ) > 0.02
            ) {
              const error =
                new Error(
                  "Split-payment VAT reconciliation failed."
                );

              error.status = 500;

              throw error;
            }


            // =============================================
            // 4. IMMUTABLE SETTLEMENT SNAPSHOT
            // =============================================

            const pricingSnapshot = {
              version: 2,

              calculation_source:
                "split_people_proportional_outstanding",

              split_mode:
                "people",

              outstanding_before_payment:
                availableTotal,

              gross_amount:
                requestedAmount,

              pricing_discount_amount:
                0,

              happy_hour_discount_amount:
                0,

              deal_adjusted_amount:
                requestedAmount,

              voucher: null,

              manual_discount_amount:
                0,

              service_charge_amount:
                0,

              final_amount:
                requestedAmount,

              vat: {
                service_charge_vat_mode:
                  settlementVat
                    .service_charge_vat_mode,

                taxable_gross:
                  settlementVat
                    .taxable_gross,

                net_amount:
                  settlementVat
                    .net_amount,

                vat_amount:
                  settlementVat
                    .vat_amount,

                unclassified_gross:
                  settlementVat
                    .unclassified_gross,

                service_charge_outside_scope:
                  settlementVat
                    .service_charge_outside_scope,

                buckets:
                  settlementVat
                    .buckets,

                lines:
                  settlementVat
                    .lines,
              },

              payment_lines:
                payLines.map(
                  (payment) => ({
                    method:
                      payment.method,

                    amount:
                      payment.amount,
                  })
                ),

              /*
               * Snapshot exactly how this person's share
               * was allocated for VAT purposes.
               */
              item_totals:
                vatAmountRows.map(
                  (row) => ({
                    pos_order_id:
                      row.id,

                    allocated_share:
                      row.payable_total,
                  })
                ),
            };


            const settlementOrderIds =
              vatAmountRows
                .map(
                  (row) =>
                    Number(
                      row.id
                    )
                )
                .filter(Boolean);


            const settlement =
              await createPaymentSettlement({
                tx,

                restaurantId,

                tableNumber:
                  table,

                /*
                 * paymentBatchId is a UUID
                 * and uniquely identifies this share.
                 */
                batchId:
                  paymentBatchId,

                /*
                 * We do not invent a full invoice number
                 * for every partial-person payment.
                 */
                invoiceNumber:
                  null,

                grossAmount:
                  requestedAmount,

                pricingDiscountAmount:
                  0,

                happyHourDiscountAmount:
                  0,

                dealAdjustedAmount:
                  requestedAmount,

                voucherId:
                  null,

                voucherCode:
                  null,

                voucherDiscountAmount:
                  0,

                manualDiscountAmount:
                  0,

                serviceChargeAmount:
                  0,

                finalAmount:
                  requestedAmount,

                appliedRuleIds:
                  [],

                posOrderIds:
                  settlementOrderIds,

                pricingSnapshot,

                source:
                  "pos",

                createdByUserId:
                  req.user?.id ||
                  null,
              });


            // =============================================
            // 5. OPERATIONAL BILL BALANCE
            //
            // Keep the existing deterministic FIFO balance
            // reduction. This is separate from proportional
            // VAT allocation.
            // =============================================

            let remainingToApply =
              requestedAmount;

            const touchedIds = [];

            let paidAmount = 0;


            for (
              const row of items
            ) {
              if (
                remainingToApply <=
                0
              ) {
                break;
              }


              const rowRemaining =
                round2(
                  Number(
                    row.remaining_price ||
                      0
                  )
                );


              if (
                rowRemaining <= 0
              ) {
                continue;
              }


              const applied =
                round2(
                  Math.min(
                    rowRemaining,
                    remainingToApply
                  )
                );


              const nextRemaining =
                round2(
                  rowRemaining -
                    applied
                );


              const nextPaid =
                round2(
                  Number(
                    row.amount_paid ||
                      0
                  ) +
                    applied
                );


              const fullyPaid =
                nextRemaining <=
                0.009
                  ? 1
                  : 0;


              const updateResult =
                await tx.qRun(
                  isPg
                    ? `
                      UPDATE public.pos_orders

                      SET
                        amount_paid = $1,
                        remaining_price = $2,
                        paid = $3

                      WHERE
                        id = $4

                        AND
                        restaurant_id = $5

                        AND
                        COALESCE(
                          remaining_price,
                          total_price,
                          0
                        ) > 0
                    `
                    : `
                      UPDATE pos_orders

                      SET
                        amount_paid = ?,
                        remaining_price = ?,
                        paid = ?

                      WHERE
                        id = ?

                        AND
                        restaurant_id = ?

                        AND
                        COALESCE(
                          remaining_price,
                          total_price,
                          0
                        ) > 0
                    `,
                  [
                    nextPaid,

                    fullyPaid
                      ? 0
                      : nextRemaining,

                    fullyPaid,

                    row.id,

                    restaurantId,
                  ]
                );


              const changed =
                Number(
                  updateResult?.rowCount ??
                    updateResult?.changes ??
                    0
                );


              if (
                changed !== 1
              ) {
                const error =
                  new Error(
                    "The bill changed while split payment was being processed. No payment was recorded."
                  );

                error.status = 409;

                throw error;
              }


              touchedIds.push(
                Number(row.id)
              );


              paidAmount =
                round2(
                  paidAmount +
                    applied
                );


              remainingToApply =
                round2(
                  remainingToApply -
                    applied
                );
            }


            if (
              Math.abs(
                paidAmount -
                  requestedAmount
              ) > 0.01
            ) {
              throw new Error(
                "Unable to apply full share amount safely."
              );
            }


            // =============================================
            // 6. TENDER LEDGER
            //
            // Every tender points to the immutable
            // settlement we just created.
            // =============================================

            const recordedPayments =
              [];


            for (
              const payment of
              payLines
            ) {
              if (
                payment.amount <= 0
              ) {
                continue;
              }


              const recorded =
                await recordPayment({
                  tx,

                  restaurantId,

                  tableNumber:
                    table,

                  amount:
                    payment.amount,

                  method:
                    payment.method,

                  userId:
                    req.user?.id ||
                    null,

                  batchId:
                    paymentBatchId,

                  terminalRef:
                    req.body
                      ?.terminalRef ||
                    null,

                  /*
                   * These represent the physical order
                   * balances changed by this payment.
                   */
                  posOrderIds:
                    touchedIds,

                  source:
                    "pos",

                  settlementId:
                    settlement.id,
                });


              recordedPayments.push(
                recorded
              );
            }


            // =============================================
            // 7. TABLE STATE
            // =============================================

            const unpaidLeft =
              await updateTableAfterPayment(
                tx.qRun,
                tx.qGet,
                restaurantId,
                table
              );


            if (
              unpaidLeft === 0
            ) {
              await clearTableSessionByName(
                tx.qRun,
                restaurantId,
                table
              );
            }

            await emitFinancialSettlementRecordedTx(
              tx,
              {
                restaurantId,

                settlementId:
                  settlement.id,
              }
            );

            await emitTableOperationalIfEdge(
              tx,
              restaurantId,
              table
            );


            // =============================================
            // RETURN FROM TRANSACTION
            // =============================================

            return {
              settlement,

              recordedPayments,

              touchedIds,

              settlementOrderIds,

              paidAmount,

              leftover:
                remainingToApply,

              unpaid_left:
                unpaidLeft,

              table_status:
                unpaidLeft > 0
                  ? "occupied"
                  : "occupied_paid",

              fully_settled:
                unpaidLeft === 0,

              payment_batch_id:
                paymentBatchId,

              pricingSnapshot,
            };
          }
        );


      // =============================================
      // AUDIT AFTER COMMIT
      // =============================================

      try {
        await audit(
          req,

          "POS_PAY_SHARE",

          {
            settlement_id:
              result.settlement.id,

            table,

            requested_amount:
              requestedAmount,

            paid_amount:
              result.paidAmount,

            touched_ids:
              result.touchedIds,

            vat_allocation_ids:
              result
                .settlementOrderIds,

            payment_lines:
              result
                .recordedPayments
                .map(
                  (payment) => ({
                    id:
                      payment.id,

                    method:
                      payment.method,

                    amount:
                      payment.amount,
                  })
                ),

            payment_batch_id:
              result
                .payment_batch_id,
          },

          {
            entity:
              "payment_settlement",

            entity_id:
              result.settlement.id,
          }
        );
      } catch (
        auditError
      ) {
        console.error(
          "⚠️ Split payment committed but audit failed:",
          auditError
        );
      }


      // =============================================
      // RESPONSE
      // =============================================

      return res.json({
        success: true,

        settlement_id:
          result.settlement.id,

        payment_ids:
          result.recordedPayments.map(
            (payment) =>
              payment.id
          ),

        touchedIds:
          result.touchedIds,

        paidAmount:
          result.paidAmount,

        amount:
          result.paidAmount,

        gross_amount:
          result.paidAmount,

        deal_adjusted_amount:
          result.paidAmount,

        pricing_discount_amount:
          0,

        voucher_discount:
          0,

        manual_discount_amount:
          0,

        service_charge_amount:
          0,

        leftover:
          result.leftover,

        unpaid_left:
          result.unpaid_left,

        table_status:
          result.table_status,

        fully_settled:
          result.fully_settled,

        payment_batch_id:
          result.payment_batch_id,

        vat:
          result
            .pricingSnapshot
            ?.vat || null,
      });
    } catch (err) {
      console.error(
        "❌ pay-share error:",
        err
      );


      const status =
        Number(
          err?.status || 500
        );


      return res
        .status(status)
        .json({
          error:
            status >= 500
              ? err?.message ||
                "Failed to pay share."
              : err?.message,
        });
    }
  }
);

// GET /orders/unpaid-summary
// Shows ONLY unpaid QR / kiosk customer orders, not normal POS table/takeaway orders.
router.get("/unpaid-summary", requireRole(...POS_STAFF), async (req, res) => {
  const restaurantId = Number(req.tenantRid || 0);

  try {
    const rows = await qAll(
      `
      SELECT
  po.table_number,
  po.batch_id,
  ob.order_type,
  ob.pickup_number,
  ob.requested_payment_method,
  po.source,
  MIN(po.created_at) AS created_at,
  COUNT(*)::int AS items,
  COALESCE(SUM(COALESCE(po.remaining_price, po.total_price, 0)), 0)::numeric AS total
      FROM public.pos_orders po
      LEFT JOIN public.order_batches ob
        ON ob.restaurant_id = po.restaurant_id
       AND ob.id = po.batch_id
      WHERE po.restaurant_id = $1
        AND COALESCE(po.remaining_price, po.total_price, 0) > 0
        AND LOWER(COALESCE(po.source, '')) IN ('qr', 'kiosk')
      GROUP BY
        po.table_number,
        po.batch_id,
        ob.order_type,
        ob.pickup_number,
        ob.requested_payment_method,
        po.source
      ORDER BY MIN(po.created_at) ASC
      `,
      [restaurantId]
    );

    const out = (rows || []).map((r) => {
      const orderType = String(r.order_type || "").toLowerCase();
      const source = String(r.source || "").toLowerCase();
      const pickup = r.pickup_number != null ? Number(r.pickup_number) : null;

      return {
        table_number: r.table_number,
        batch_id: r.batch_id,
        order_type: orderType || "dine-in",
        source,
        pickup_number: pickup,
        payment_method: r.requested_payment_method || null,
        created_at: r.created_at || null,
        label:
          orderType === "takeaway" && pickup
            ? `Takeaway ${pickup}`
            : source === "qr"
            ? `QR • ${r.table_number}`
            : r.table_number,
        items: Number(r.items || 0),
        total: Number(r.total || 0),
      };
    });

    res.json(out);
  } catch (e) {
    console.error("unpaid-summary failed:", e);
    res.status(500).json({ error: "Failed to load unpaid summary" });
  }
});

// POST /orders/receipt/by-ids
router.post("/receipt/by-ids", requireRole(...POS_STAFF), async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const { itemIds = [] } = req.body || {};
    if (!rid) return res.status(400).json({ error: "Missing tenant" });
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: "itemIds[] required" });
    }

    const isPg = kind === "pg";
    const placeholders = itemIds.map((_, i) => (isPg ? `$${i + 2}` : `?`)).join(",");

    const rows = await qAll(
      isPg
        ? `SELECT
    id,
    table_number,
    item_name,
    item_type,
    quantity,
    total_price,
    COALESCE(amount_paid, 0) AS amount_paid,
    COALESCE(remaining_price, total_price, 0) AS remaining_price,
    paid,
    created_at,
    options,
    note
   FROM public.pos_orders
   WHERE restaurant_id = $1
     AND id IN (${placeholders})
   ORDER BY created_at ASC, id ASC`
        : `SELECT id, table_number, item_name, item_type, quantity, total_price, paid, created_at, options, note
           FROM pos_orders
           WHERE restaurant_id = ? AND id IN (${placeholders})
           ORDER BY created_at ASC, id ASC`,
      [rid, ...itemIds]
    );

const grossTotal = (rows || []).reduce(
  (sum, row) => sum + Number(row.total_price || 0),
  0
);

const finalTotal = (rows || []).reduce((sum, row) => {
  const amountPaid = Number(row.amount_paid || 0);

  if (amountPaid > 0) {
    return sum + amountPaid;
  }

  return sum + Number(
    row.remaining_price ?? row.total_price ?? 0
  );
}, 0);

const pricingDiscount = Math.max(0, grossTotal - finalTotal);

res.json({
  items: rows || [],
  gross_total: Number(grossTotal.toFixed(2)),
  pricing_discount: Number(pricingDiscount.toFixed(2)),
  total: Number(finalTotal.toFixed(2)),
});

  } catch (e) {
    console.error("❌ receipt/by-ids failed:", e);
    res.status(500).json({ error: "Failed to load receipt rows" });
  }
});

router.get(
  "/payments",
  requirePermission(
    PERMISSIONS.POS_PREVIOUS_ORDERS
  ),
  async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    if (!rid) return res.status(400).json({ error: "Missing tenant" });

    const isPg = kind === "pg";

    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const method = req.query.method ? String(req.query.method).toLowerCase() : null; // cash|card
    const status = req.query.status ? String(req.query.status).toLowerCase() : null; // completed|voided|refunded
    const q = req.query.q ? String(req.query.q).trim().toLowerCase() : null;

    // NOTE: adjust the staff display column to match your users table:
    // you said it "shows the name now" => keep whichever one you used.
    // Below uses u.full_name first, else u.username.
    
const staffExpr = isPg ? await resolveUsersDisplayNameExpr() : "COALESCE(NULLIF(TRIM(u.username),''), 'Staff')";

    const where = [];
    const params = [];
    let p = 1;

    const add = (sql, val) => {
      where.push(sql.replaceAll("?", isPg ? `$${p++}` : `?`));
      params.push(val);
    };

    add(`p.restaurant_id = ?`, rid);

    if (from) add(`p.created_at >= ?`, from);
    if (to) add(`p.created_at <= ?`, to);
    if (method) add(`LOWER(p.method) = ?`, method);
    if (status) add(`LOWER(p.status) = ?`, status);

    if (q) {
      // search by table, staff, terminal_ref, id
      if (isPg) {
        where.push(`
          (
            LOWER(COALESCE(p.table_number,'')) LIKE $${p} OR
            LOWER(COALESCE(p.terminal_ref,'')) LIKE $${p} OR
            CAST(p.id AS text) LIKE $${p} OR
            LOWER(${staffExpr}) LIKE $${p}
          )
        `);
        params.push(`%${q}%`);
        p++;
      } else {
        where.push(`
          (
            LOWER(COALESCE(p.table_number,'')) LIKE ? OR
            LOWER(COALESCE(p.terminal_ref,'')) LIKE ? OR
            CAST(p.id AS text) LIKE ? OR
            LOWER(${staffExpr}) LIKE ?
          )
        `);
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
    }

    const sql = isPg
      ? `
        SELECT
          p.id, p.restaurant_id, p.table_number, p.amount, p.method, p.created_at,
          p.status, p.void_reason, p.voided_at, p.voided_by_user_id,
          p.staff_user_id, p.terminal_ref, p.source, p.pos_order_ids,
p.batch_id,
p.cashup_session_id,
          ${staffExpr} AS staff_name
        FROM public.payments p
        LEFT JOIN public.users u ON u.id = p.staff_user_id
        WHERE ${where.join(" AND ")}
        ORDER BY p.created_at DESC
        LIMIT 1000
      `
      : `
        SELECT
          p.id, p.restaurant_id, p.table_number, p.amount, p.method, p.created_at,
          p.status, p.void_reason, p.voided_at, p.voided_by_user_id,
          p.staff_user_id, p.terminal_ref, p.source, p.pos_order_ids,
p.batch_id,
p.cashup_session_id,
          ${staffExpr} AS staff_name
        FROM payments p
        LEFT JOIN users u ON u.id = p.staff_user_id
        WHERE ${where.join(" AND ")}
        ORDER BY p.created_at DESC
        LIMIT 1000
      `;

    const rows = await qAll(sql, params);
    return res.json(rows || []);
  } catch (err) {
    console.error("payments list error:", err);
    return res.status(500).json({ error: "Failed to load payments" });
  }
});

router.get(
  "/payments/totals",
  requirePermission(
    PERMISSIONS.POS_PREVIOUS_ORDERS
  ),
  async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    if (!rid) return res.status(400).json({ error: "Missing tenant" });

    const isPg = kind === "pg";
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;

    const params = [rid];
    let extra = "";
    if (from) { params.push(from); extra += isPg ? ` AND created_at >= $${params.length}` : ` AND created_at >= ?`; }
    if (to) { params.push(to); extra += isPg ? ` AND created_at <= $${params.length}` : ` AND created_at <= ?`; }

    const sql = isPg
           ? `
        SELECT
          COALESCE(SUM(CASE WHEN LOWER(method)='cash' AND status='completed' THEN amount ELSE 0 END),0)::numeric AS cash_total,
          COALESCE(SUM(CASE WHEN LOWER(method)='card' AND status='completed' THEN amount ELSE 0 END),0)::numeric AS card_total,
          COALESCE(SUM(CASE WHEN LOWER(method)='voucher' AND status='completed' THEN amount ELSE 0 END),0)::numeric AS voucher_total,
          COALESCE(SUM(CASE WHEN status='completed' THEN amount ELSE 0 END),0)::numeric AS grand_total
        FROM public.payments
        WHERE restaurant_id = $1 ${extra}
      `
            : `
        SELECT
          COALESCE(SUM(CASE WHEN LOWER(method)='cash' AND status='completed' THEN amount ELSE 0 END),0) AS cash_total,
          COALESCE(SUM(CASE WHEN LOWER(method)='card' AND status='completed' THEN amount ELSE 0 END),0) AS card_total,
          COALESCE(SUM(CASE WHEN LOWER(method)='voucher' AND status='completed' THEN amount ELSE 0 END),0) AS voucher_total,
          COALESCE(SUM(CASE WHEN status='completed' THEN amount ELSE 0 END),0) AS grand_total
        FROM payments
        WHERE restaurant_id = ? ${extra}
      `;

    const row = await qGet(sql, params);
        res.json({
      cash_total: Number(row?.cash_total || 0),
      card_total: Number(row?.card_total || 0),
      voucher_total: Number(row?.voucher_total || 0),
      grand_total: Number(row?.grand_total || 0),
    });
  } catch (e) {
    console.error("payments totals error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

// GET /orders/payments/:id
router.get(
  "/payments/:id(\\d+)",
  requirePermission(
    PERMISSIONS.POS_PREVIOUS_ORDERS
  ),
  async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const id = Number(req.params.id || 0);
    if (!rid || !id) return res.status(400).json({ error: "Bad request" });

    const isPg = kind === "pg";
    const staffExpr = isPg ? await resolveUsersDisplayNameExpr() : "u.username";

    const pay = await qGet(
      isPg
        ? `
          SELECT p.*,
                 ${staffExpr} AS staff_name
          FROM public.payments p
          LEFT JOIN public.users u ON u.id = p.staff_user_id
          WHERE p.restaurant_id = $1 AND p.id = $2
        `
        : `
          SELECT p.*,
                 u.username AS staff_name
          FROM payments p
          LEFT JOIN users u ON u.id = p.staff_user_id
          WHERE p.restaurant_id = ? AND p.id = ?
        `,
      isPg ? [rid, id] : [rid, id]
    );

    if (!pay) return res.status(404).json({ error: "Not found" });

    const relatedPayments = await qAll(
  `
  SELECT method, amount
  FROM public.payments
  WHERE restaurant_id = $1
    AND batch_id = $2
  `,
  [rid, pay.batch_id]
);

    let ids = pay.pos_order_ids;
    if (typeof ids === "string") {
      try { ids = JSON.parse(ids); } catch { ids = []; }
    }
    if (!Array.isArray(ids)) ids = [];

    let items = [];
    if (ids.length) {
      const placeholders = ids.map((_, i) => (isPg ? `$${i + 2}` : `?`)).join(",");
      const sqlItems = isPg
  ? `SELECT
  id,
  item_name AS meal_name,
  item_name,
  quantity,
  total_price,
  COALESCE(amount_paid, 0) AS amount_paid,
  COALESCE(remaining_price, total_price, 0) AS remaining_price,
  created_at
     FROM public.pos_orders
     WHERE restaurant_id = $1 AND id IN (${placeholders})
     ORDER BY id ASC`
  : `SELECT
        id,
        item_name AS meal_name,
        item_name,
        quantity,
        total_price,
        created_at
     FROM pos_orders
     WHERE restaurant_id = ? AND id IN (${placeholders})
     ORDER BY id ASC`;


      items = await qAll(sqlItems, isPg ? [rid, ...ids] : [rid, ...ids]);
    }
return res.json({
  payment: pay,
  items,
  relatedPayments,
});
  } catch (e) {
    console.error("❌ payment detail error", e);
    res.status(500).json({ error: "Failed" });
  }
});

// ============================================================
// GET /orders/payment-settlements
//
// Commercial settlement-backed transaction history.
// One response row represents one completed bill.
// Child payment rows represent cash/card/voucher components.
//
// READ-ONLY:
// Existing payment, refund and void routes remain untouched.
// ============================================================
router.get(
  "/payment-settlements",
  requirePermission(
    PERMISSIONS.POS_PREVIOUS_ORDERS
  ),
  async (req, res) => {
    try {
      const rid = Number(req.tenantRid || 0);

      if (!rid) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      if (kind !== "pg") {
        return res.status(501).json({
          error:
            "Settlement transaction history requires PostgreSQL",
        });
      }

      const fromRaw = String(
        req.query?.from || ""
      ).trim();

      const toRaw = String(
        req.query?.to || ""
      ).trim();

      const method = String(
        req.query?.method || ""
      )
        .trim()
        .toLowerCase();

      const status = String(
        req.query?.status || ""
      )
        .trim()
        .toLowerCase();

      const search = String(
        req.query?.q || ""
      )
        .trim()
        .slice(0, 150);

      const fromDate =
        fromRaw && !Number.isNaN(Date.parse(fromRaw))
          ? fromRaw
          : null;

      const toDate =
        toRaw && !Number.isNaN(Date.parse(toRaw))
          ? toRaw
          : null;

      const safeMethod = [
        "cash",
        "card",
        "voucher",
      ].includes(method)
        ? method
        : null;

      const safeStatus = [
        "completed",
        "voided",
        "refunded",
        "partially_refunded",
        "partially_voided",
      ].includes(status)
        ? status
        : null;

      const staffExpr =
        await resolveUsersDisplayNameExpr();

      const rows = await qAll(
        `
        WITH settlement_history AS (
          SELECT
            s.id AS settlement_id,
            s.restaurant_id,
            s.table_number,
            s.batch_id,
            s.invoice_number,

            s.gross_amount,
            s.pricing_discount_amount,
            s.happy_hour_discount_amount,
            s.deal_adjusted_amount,

            s.voucher_id,
            s.voucher_code,
            s.voucher_discount_amount,

            s.manual_discount_amount,
            s.service_charge_amount,
            s.final_amount,

            s.applied_rule_ids,
            s.pos_order_ids,
            s.pricing_snapshot,

            s.source,
            s.created_by_user_id,
            s.created_at,

            ${staffExpr} AS staff_name,

            COALESCE(
              payment_summary.payment_ids,
              '[]'::jsonb
            ) AS payment_ids,

            COALESCE(
              payment_summary.payments,
              '[]'::jsonb
            ) AS payments,

            COALESCE(
              payment_summary.payment_methods,
              '[]'::jsonb
            ) AS payment_methods,

            COALESCE(
              payment_summary.payment_total,
              0
            ) AS payment_total,

            COALESCE(
              payment_summary.payment_count,
              0
            ) AS payment_count,

            COALESCE(
              payment_summary.settlement_status,
              'completed'
            ) AS status,

            payment_summary.terminal_ref,
            payment_summary.cashup_session_id

          FROM public.payment_settlements s

          LEFT JOIN public.users u
            ON u.id = s.created_by_user_id

          LEFT JOIN LATERAL (
            SELECT
              jsonb_agg(
                p.id
                ORDER BY p.id
              ) AS payment_ids,

              jsonb_agg(
                jsonb_build_object(
                  'id', p.id,
                  'method', p.method,
                  'amount', p.amount,
                  'status', p.status,
                  'terminal_ref', p.terminal_ref,
                  'cashup_session_id', p.cashup_session_id,
                  'staff_user_id', p.staff_user_id,
                  'source', p.source,
                  'created_at', p.created_at
                )
                ORDER BY p.id
              ) AS payments,

              jsonb_agg(
                DISTINCT p.method
              ) AS payment_methods,

              ROUND(
                COALESCE(
                  SUM(
                    CASE
                      WHEN p.status = 'completed'
                        THEN p.amount
                      ELSE 0
                    END
                  ),
                  0
                )::numeric,
                2
              ) AS payment_total,

              COUNT(p.id)::int AS payment_count,

              CASE
                WHEN COUNT(p.id) = 0
                  THEN 'completed'

                WHEN BOOL_AND(
                  p.status = 'voided'
                )
                  THEN 'voided'

                WHEN BOOL_AND(
                  p.status = 'refunded'
                )
                  THEN 'refunded'

                WHEN BOOL_OR(
                  p.status = 'refunded'
                )
                AND BOOL_OR(
                  p.status = 'completed'
                )
                  THEN 'partially_refunded'

                WHEN BOOL_OR(
                  p.status = 'voided'
                )
                AND BOOL_OR(
                  p.status = 'completed'
                )
                  THEN 'partially_voided'

                ELSE 'completed'
              END AS settlement_status,

              MAX(p.terminal_ref)
                FILTER (
                  WHERE p.terminal_ref IS NOT NULL
                ) AS terminal_ref,

              (
    SELECT p2.cashup_session_id
    FROM public.payments p2
    WHERE p2.restaurant_id = s.restaurant_id
      AND p2.settlement_id = s.id
      AND p2.cashup_session_id IS NOT NULL
    ORDER BY p2.created_at DESC
    LIMIT 1
)
AS cashup_session_id

            FROM public.payments p
            WHERE p.restaurant_id = s.restaurant_id
              AND p.settlement_id = s.id
          ) payment_summary
            ON TRUE

          WHERE s.restaurant_id = $1

            AND (
              $2::timestamptz IS NULL
              OR s.created_at >= $2::timestamptz
            )

            AND (
              $3::timestamptz IS NULL
              OR s.created_at <= $3::timestamptz
            )

            AND (
              $4::text IS NULL
              OR EXISTS (
                SELECT 1
                FROM public.payments method_payment
                WHERE method_payment.restaurant_id =
                        s.restaurant_id
                  AND method_payment.settlement_id =
                        s.id
                  AND LOWER(
                    TRIM(
                      COALESCE(
                        method_payment.method,
                        ''
                      )
                    )
                  ) = $4
              )
            )

            AND (
              $5::text IS NULL
              OR CONCAT_WS(
                ' ',
                s.id::text,
                s.invoice_number::text,
                s.table_number,
                s.voucher_code,
                ${staffExpr}
              ) ILIKE '%' || $5 || '%'

              OR EXISTS (
                SELECT 1
                FROM public.payments searched_payment
                WHERE searched_payment.restaurant_id =
                        s.restaurant_id
                  AND searched_payment.settlement_id =
                        s.id
                  AND CONCAT_WS(
                    ' ',
                    searched_payment.id::text,
                    searched_payment.method,
                    searched_payment.terminal_ref,
                    searched_payment.cashup_session_id
                  ) ILIKE '%' || $5 || '%'
              )
            )
        )

        SELECT *
        FROM settlement_history

        WHERE (
          $6::text IS NULL
          OR status = $6
        )

        ORDER BY created_at DESC
        LIMIT 1000
        `,
        [
          rid,
          fromDate,
          toDate,
          safeMethod,
          search || null,
          safeStatus,
        ]
      );

      const output = (rows || []).map(
        (row) => {
          const payments = Array.isArray(
            row.payments
          )
            ? row.payments
            : [];

          const methods = Array.from(
            new Set(
              payments
                .map((payment) =>
                  String(
                    payment?.method || ""
                  )
                    .trim()
                    .toLowerCase()
                )
                .filter(Boolean)
            )
          );

          return {
            settlement_id: String(
              row.settlement_id
            ),

            invoice_number:
              row.invoice_number != null
                ? Number(row.invoice_number)
                : null,

            table_number:
              row.table_number,

            batch_id:
              row.batch_id || null,

            created_at:
              row.created_at,

            staff_user_id:
              row.created_by_user_id != null
                ? Number(
                    row.created_by_user_id
                  )
                : null,

            staff_name:
              row.staff_name || "Staff",

            source:
              row.source || "pos",

            status:
              row.status || "completed",

            method:
              methods.length > 1
                ? "mixed"
                : methods[0] || "unknown",

            payment_ids:
              Array.isArray(row.payment_ids)
                ? row.payment_ids.map(Number)
                : [],

            payments: payments.map(
              (payment) => ({
                id: Number(payment.id),
                method:
                  payment.method || "unknown",
                amount: Number(
                  payment.amount || 0
                ),
                status:
                  payment.status || "completed",
                terminal_ref:
                  payment.terminal_ref || null,
                cashup_session_id:
                  payment.cashup_session_id ||
                  null,
                staff_user_id:
                  payment.staff_user_id != null
                    ? Number(
                        payment.staff_user_id
                      )
                    : null,
                source:
                  payment.source || "pos",
                created_at:
                  payment.created_at || null,
              })
            ),

            payment_count: Number(
              row.payment_count || 0
            ),

            payment_total: Number(
              row.payment_total || 0
            ),

            terminal_ref:
              row.terminal_ref || null,

            cashup_session_id:
              row.cashup_session_id || null,

            gross_amount: Number(
              row.gross_amount || 0
            ),

            pricing_discount_amount:
              Number(
                row.pricing_discount_amount ||
                  0
              ),

            happy_hour_discount_amount:
              Number(
                row.happy_hour_discount_amount ||
                  0
              ),

            deal_adjusted_amount:
              Number(
                row.deal_adjusted_amount || 0
              ),

            voucher_id:
              row.voucher_id != null
                ? Number(row.voucher_id)
                : null,

            voucher_code:
              row.voucher_code || null,

            voucher_discount_amount:
              Number(
                row.voucher_discount_amount ||
                  0
              ),

            manual_discount_amount:
              Number(
                row.manual_discount_amount ||
                  0
              ),

            service_charge_amount:
              Number(
                row.service_charge_amount ||
                  0
              ),

            final_amount: Number(
              row.final_amount || 0
            ),

            applied_rule_ids:
              Array.isArray(
                row.applied_rule_ids
              )
                ? row.applied_rule_ids
                : [],

            pos_order_ids:
              Array.isArray(row.pos_order_ids)
                ? row.pos_order_ids.map(Number)
                : [],

            pricing_snapshot:
              row.pricing_snapshot &&
              typeof row.pricing_snapshot ===
                "object"
                ? row.pricing_snapshot
                : {},
          };
        }
      );

      return res.json(output);
    } catch (error) {
      console.error(
        "❌ payment settlement history error:",
        error
      );

      return res.status(500).json({
        error:
          error?.message ||
          "Failed to load payment settlements",
      });
    }
  }
);

// ============================================================
// GET /orders/payment-settlements/:settlementId
//
// Returns one immutable settlement with:
// - authoritative financial snapshot
// - linked payment tender rows
// - linked POS order lines
//
// READ-ONLY.
// Tenant-safe.
// PostgreSQL only.
// ============================================================
router.get(
  "/payment-settlements/:settlementId",
  requirePermission(
    PERMISSIONS.POS_PREVIOUS_ORDERS
  ),
  async (req, res) => {
    try {
      const rid = Number(req.tenantRid || 0);
      const settlementId = String(
        req.params?.settlementId || ""
      ).trim();

      if (!rid) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      if (!isUuid(settlementId)) {
        return res.status(400).json({
          error: "Invalid settlement id",
        });
      }

      if (kind !== "pg") {
        return res.status(501).json({
          error:
            "Settlement detail requires PostgreSQL",
        });
      }

      const staffExpr =
        await resolveUsersDisplayNameExpr();

      /*
       * Load the immutable settlement first.
       *
       * restaurant_id is part of the lookup so a user can never
       * read another restaurant's settlement by UUID.
       */
      const settlement = await qGet(
        `
        SELECT
          s.id AS settlement_id,
          s.restaurant_id,
          s.table_number,
          s.batch_id,
          s.invoice_number,

          s.gross_amount,
          s.pricing_discount_amount,
          s.happy_hour_discount_amount,
          s.deal_adjusted_amount,

          s.voucher_id,
          s.voucher_code,
          s.voucher_discount_amount,

          s.manual_discount_amount,
          s.service_charge_amount,
          s.final_amount,

          s.applied_rule_ids,
          s.pos_order_ids,
          s.pricing_snapshot,

          s.source,
          s.created_by_user_id,
          s.created_at,

          ${staffExpr} AS staff_name

        FROM public.payment_settlements s

        LEFT JOIN public.users u
          ON u.id = s.created_by_user_id

        WHERE s.restaurant_id = $1
          AND s.id = $2::uuid

        LIMIT 1
        `,
        [rid, settlementId]
      );

      if (!settlement) {
        return res.status(404).json({
          error: "Settlement not found",
        });
      }

      /*
       * Load every tender row belonging to the settlement.
       *
       * A mixed payment therefore returns two or more rows,
       * while a normal card/cash payment returns one.
       */
      const paymentRows = await qAll(
        `
        SELECT
          p.id,
          p.restaurant_id,
          p.settlement_id,
          p.table_number,
          p.amount,
          p.method,
          p.status,
          p.staff_user_id,
          p.batch_id,
          p.terminal_ref,
          p.cashup_session_id,
          p.ref_payment_id,
          p.source,
          p.created_at

        FROM public.payments p

        WHERE p.restaurant_id = $1
          AND p.settlement_id = $2::uuid

        ORDER BY p.created_at ASC, p.id ASC
        `,
        [rid, settlementId]
      );

      const posOrderIds = Array.isArray(
        settlement.pos_order_ids
      )
        ? settlement.pos_order_ids
            .map((id) => Number(id))
            .filter(
              (id) =>
                Number.isInteger(id) &&
                id > 0
            )
        : [];

      /*
       * Load the exact POS lines referenced by the immutable
       * settlement snapshot.
       */
      const itemRows = posOrderIds.length
        ? await qAll(
            `
            SELECT
              po.id,
              po.restaurant_id,
              po.table_number,
              po.item_name,
              po.quantity,
              po.total_price,
              po.amount_paid,
              po.remaining_price,
              po.item_id,
              po.item_type,
              po.meal_id,
              po.menu_item_id,
              po.stock_id,
              po.category_id,
              po.options,
              po.note,
              po.source,
              po.batch_id,
              po.invoice_number,
              po.created_at

            FROM public.pos_orders po

            WHERE po.restaurant_id = $1
              AND po.id = ANY($2::bigint[])

            ORDER BY po.created_at ASC, po.id ASC
            `,
            [rid, posOrderIds]
          )
        : [];

      /*
       * The immutable pricing snapshot contains the original and
       * payable amount for each line at settlement time.
       *
       * This is preferred over current remaining_price because paid
       * rows are correctly changed to remaining_price = 0.
       */
      const pricingSnapshot =
        settlement.pricing_snapshot &&
        typeof settlement.pricing_snapshot ===
          "object"
          ? settlement.pricing_snapshot
          : {};

      const snapshotItemTotals =
        Array.isArray(
          pricingSnapshot.item_totals
        )
          ? pricingSnapshot.item_totals
          : [];

      const itemTotalMap = new Map(
        snapshotItemTotals
          .map((entry) => [
            Number(entry?.pos_order_id),
            {
              originalTotal: Number(
                entry?.original_total || 0
              ),
              payableTotal: Number(
                entry?.payable_total || 0
              ),
            },
          ])
          .filter(([id]) =>
            Number.isInteger(id)
          )
      );

      const payments = paymentRows.map(
        (payment) => ({
          id: Number(payment.id),
          settlement_id:
            payment.settlement_id || null,

          table_number:
            payment.table_number,

          amount: Number(
            payment.amount || 0
          ),

          method:
            payment.method || "unknown",

          status:
            payment.status || "completed",

          staff_user_id:
            payment.staff_user_id != null
              ? Number(
                  payment.staff_user_id
                )
              : null,

          batch_id:
            payment.batch_id || null,

          terminal_ref:
            payment.terminal_ref || null,

          cashup_session_id:
            payment.cashup_session_id ||
            null,

          ref_payment_id:
            payment.ref_payment_id != null
              ? Number(
                  payment.ref_payment_id
                )
              : null,

          source:
            payment.source || "pos",

          created_at:
            payment.created_at,
        })
      );

      const items = itemRows.map((item) => {
        const snapshot =
          itemTotalMap.get(Number(item.id));

        const originalTotal =
          snapshot?.originalTotal ??
          Number(item.total_price || 0);

        const payableTotal =
          snapshot?.payableTotal ??
          Number(
            item.amount_paid ??
              item.total_price ??
              0
          );

        return {
          id: Number(item.id),

          item_name:
            item.item_name || "Item",

          meal_name:
            item.item_name || "Item",

          quantity: Number(
            item.quantity || 1
          ),

          original_total: Number(
            originalTotal || 0
          ),

          payable_total: Number(
            payableTotal || 0
          ),

          // Compatibility with current receipt/item UI.
          total_price: Number(
            originalTotal || 0
          ),

          amount_paid: Number(
            payableTotal || 0
          ),

          item_id:
            item.item_id != null
              ? Number(item.item_id)
              : null,

          meal_id:
            item.meal_id || null,

          menu_item_id:
            item.menu_item_id != null
              ? Number(
                  item.menu_item_id
                )
              : null,

          stock_id:
            item.stock_id != null
              ? Number(item.stock_id)
              : null,

          item_type:
            item.item_type || null,

          category_id:
            item.category_id != null
              ? Number(
                  item.category_id
                )
              : null,

          options:
            item.options &&
            typeof item.options ===
              "object"
              ? item.options
              : {},

          note:
            item.note || null,

          source:
            item.source || "pos",

          batch_id:
            item.batch_id || null,

          invoice_number:
            item.invoice_number != null
              ? Number(
                  item.invoice_number
                )
              : null,

          created_at:
            item.created_at,
        };
      });

      const paymentStatuses = payments.map(
        (payment) =>
          String(
            payment.status || ""
          ).toLowerCase()
      );

      let status = "completed";

      if (
        paymentStatuses.length &&
        paymentStatuses.every(
          (value) => value === "voided"
        )
      ) {
        status = "voided";
      } else if (
        paymentStatuses.length &&
        paymentStatuses.every(
          (value) => value === "refunded"
        )
      ) {
        status = "refunded";
      } else if (
        paymentStatuses.includes(
          "refunded"
        ) &&
        paymentStatuses.includes(
          "completed"
        )
      ) {
        status = "partially_refunded";
      } else if (
        paymentStatuses.includes("voided") &&
        paymentStatuses.includes(
          "completed"
        )
      ) {
        status = "partially_voided";
      }

      const paymentMethods = Array.from(
        new Set(
          payments
            .map((payment) =>
              String(
                payment.method || ""
              )
                .trim()
                .toLowerCase()
            )
            .filter(Boolean)
        )
      );

      const paymentTotal = Number(
        payments
          .filter(
            (payment) =>
              payment.status ===
              "completed"
          )
          .reduce(
            (sum, payment) =>
              sum +
              Number(
                payment.amount || 0
              ),
            0
          )
          .toFixed(2)
      );

      return res.json({
        settlement: {
          settlement_id: String(
            settlement.settlement_id
          ),

          invoice_number:
            settlement.invoice_number != null
              ? Number(
                  settlement.invoice_number
                )
              : null,

          table_number:
            settlement.table_number,

          batch_id:
            settlement.batch_id || null,

          status,

          method:
            paymentMethods.length > 1
              ? "mixed"
              : paymentMethods[0] ||
                "unknown",

          gross_amount: Number(
            settlement.gross_amount || 0
          ),

          pricing_discount_amount:
            Number(
              settlement.pricing_discount_amount ||
                0
            ),

          happy_hour_discount_amount:
            Number(
              settlement.happy_hour_discount_amount ||
                0
            ),

          deal_adjusted_amount:
            Number(
              settlement.deal_adjusted_amount ||
                0
            ),

          voucher_id:
            settlement.voucher_id != null
              ? Number(
                  settlement.voucher_id
                )
              : null,

          voucher_code:
            settlement.voucher_code || null,

          voucher_discount_amount:
            Number(
              settlement.voucher_discount_amount ||
                0
            ),

          manual_discount_amount:
            Number(
              settlement.manual_discount_amount ||
                0
            ),

          service_charge_amount:
            Number(
              settlement.service_charge_amount ||
                0
            ),

          final_amount: Number(
            settlement.final_amount || 0
          ),

          payment_total: paymentTotal,

          applied_rule_ids:
            Array.isArray(
              settlement.applied_rule_ids
            )
              ? settlement.applied_rule_ids
              : [],

          pos_order_ids: posOrderIds,

          pricing_snapshot:
            pricingSnapshot,

          source:
            settlement.source || "pos",

          created_by_user_id:
            settlement.created_by_user_id !=
            null
              ? Number(
                  settlement.created_by_user_id
                )
              : null,

          staff_name:
            settlement.staff_name ||
            "Staff",

          created_at:
            settlement.created_at,
        },

        payments,
        items,
      });
    } catch (error) {
      console.error(
        "❌ payment settlement detail error:",
        error
      );

      return res.status(500).json({
        error:
          error?.message ||
          "Failed to load settlement details",
      });
    }
  }
);

router.post(
  "/payments/:id/refund",
  requirePermission(
    PERMISSIONS.POS_REFUND
  ), async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const id = Number(req.params.id || 0);
    const reason = String(req.body?.reason || "").trim();
    const reqAmount = req.body?.amount;

    if (!rid || !id) return res.status(400).json({ error: "Bad request" });

    const result = await withTx(async (tx) => {
      const isPg = tx.kind === "pg";
      const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const refundBatchId = makeBatchId();

      const pay = await tx.qGet(
        isPg
          ? `SELECT * FROM public.payments WHERE restaurant_id = $1 AND id = $2 FOR UPDATE`
          : `SELECT * FROM payments WHERE restaurant_id = ? AND id = ?`,
        [rid, id]
      );

      if (!pay) {
  const err =
    new Error(
      "Payment not found"
    );

  err.status =
    404;

  err.code =
    "PAYMENT_NOT_FOUND";

  throw err;
}

      const originalPaymentUuid =
        isPg
          ? String(
              pay.payment_uuid || ""
            ).trim()
          : null;

      if (
        isPg &&
        !isUuid(originalPaymentUuid)
      ) {
        const err =
          new Error(
            "Original payment is missing stable UUID identity"
          );

        err.status = 500;
        err.code =
          "PAYMENT_UUID_REQUIRED";

        throw err;
      }

      const paymentStatus =
  String(
    pay.status || ""
  )
    .trim()
    .toLowerCase();

if (
  paymentStatus !== "completed" &&
  paymentStatus !== "partially_refunded"
) {
  throw new Error(
    "Only completed or partially refunded payments can be refunded"
  );
}

const original =
  round2(
    Math.abs(
      Number(pay.amount || 0)
    )
  );

if (!(original > 0)) {
  throw new Error(
    "Invalid original payment amount"
  );
}

/*
 * Authoritative cumulative refund total.
 *
 * The browser is never trusted to tell us how much
 * remains refundable. We derive that from the ledger.
 */
const refundedRow =
  await tx.qGet(
    isPg
      ? `
        SELECT
          COALESCE(
            SUM(
              ABS(
                COALESCE(amount, 0)
              )
            ),
            0
          )::numeric AS refunded_total
        FROM public.payments
        WHERE restaurant_id = $1
          AND ref_payment_id = $2
          AND COALESCE(amount, 0) < 0
          AND LOWER(
            COALESCE(status, 'completed')
          ) <> 'voided'
      `
      : `
        SELECT
          COALESCE(
            SUM(
              ABS(
                COALESCE(amount, 0)
              )
            ),
            0
          ) AS refunded_total
        FROM payments
        WHERE restaurant_id = ?
          AND ref_payment_id = ?
          AND COALESCE(amount, 0) < 0
          AND LOWER(
            COALESCE(status, 'completed')
          ) <> 'voided'
      `,
    [rid, id]
  );

const alreadyRefunded =
  round2(
    Number(
      refundedRow?.refunded_total || 0
    )
  );

const refundableRemaining =
  round2(
    Math.max(
      0,
      original - alreadyRefunded
    )
  );

if (!(refundableRemaining > 0)) {
  throw new Error(
    "Payment has already been fully refunded"
  );
}

let refundAmount =
  refundableRemaining;

if (
  reqAmount != null &&
  reqAmount !== ""
) {
  refundAmount =
    round2(
      Number(reqAmount)
    );

  if (!(refundAmount > 0)) {
    throw new Error(
      "Refund amount must be > 0"
    );
  }

  if (
    refundAmount -
      refundableRemaining >
    0.01
  ) {
    throw new Error(
      "Refund exceeds remaining refundable amount"
    );
  }
}

      const posOrderIds = parsePosOrderIds(pay.pos_order_ids);

      if (!posOrderIds.length) {
        throw new Error("No linked POS orders found for this payment");
      }

      const rows = await tx.qAll(
        isPg
          ? `
            SELECT id,
                   total_price,
                   COALESCE(amount_paid, 0) AS amount_paid,
                   COALESCE(remaining_price, total_price, 0) AS remaining_price
            FROM public.pos_orders
            WHERE restaurant_id = $1
              AND id = ANY($2::bigint[])
            ORDER BY id DESC
            FOR UPDATE
          `
          : `
            SELECT id,
                   total_price,
                   COALESCE(amount_paid, 0) AS amount_paid,
                   COALESCE(remaining_price, total_price, 0) AS remaining_price
            FROM pos_orders
            WHERE restaurant_id = ?
              AND id IN (${posOrderIds.map(() => "?").join(",")})
            ORDER BY id DESC
          `,
        isPg ? [rid, posOrderIds] : [rid, ...posOrderIds]
      );

      if (!rows.length) {
        throw new Error("Linked POS orders not found");
      }

      let remainingRefund = refundAmount;
      const touchedIds = [];

      for (const row of rows) {
        if (remainingRefund <= 0) break;

        const currentlyPaid = round2(Number(row.amount_paid || 0));
        if (currentlyPaid <= 0) continue;

        const giveBack = round2(Math.min(currentlyPaid, remainingRefund));
        const nextPaid = round2(currentlyPaid - giveBack);
        const nextRemaining = round2(Number(row.remaining_price || 0) + giveBack);
        const fullyPaid = nextRemaining <= 0.009 ? 1 : 0;

        await tx.qRun(
          isPg
            ? `
              UPDATE public.pos_orders
              SET amount_paid = $1,
                  remaining_price = $2,
                  paid = $3
              WHERE id = $4
                AND restaurant_id = $5
            `
            : `
              UPDATE pos_orders
              SET amount_paid = ?,
                  remaining_price = ?,
                  paid = ?
              WHERE id = ?
                AND restaurant_id = ?
            `,
          [
            nextPaid,
            nextRemaining,
            fullyPaid,
            row.id,
            rid,
          ]
        );

        touchedIds.push(Number(row.id));
        remainingRefund = round2(remainingRefund - giveBack);
      }

      if (remainingRefund > 0.01) {
        throw new Error("Unable to restore full refund amount to POS orders safely");
      }

      const recordedRefund =
        await recordPayment({
          tx,
          restaurantId: rid,
          tableNumber:
            pay.table_number,
          amount:
            -Math.abs(refundAmount),
          method:
            pay.method,
          userId:
            req.user?.id || null,
          batchId:
            refundBatchId,
          terminalRef:
            pay.terminal_ref || null,
          posOrderIds:
            touchedIds,
          source:
            "refund",
          refPaymentId:
            id,
          refPaymentUuid:
            originalPaymentUuid,
        });

      const refundedAfter =
  round2(
    alreadyRefunded +
      refundAmount
  );

const nextPaymentStatus =
  original -
      refundedAfter <=
    0.01
    ? "refunded"
    : "partially_refunded";

await tx.qRun(
  isPg
    ? `
      UPDATE public.payments
      SET status = $1
      WHERE restaurant_id = $2
        AND id = $3
    `
    : `
      UPDATE payments
      SET status = ?
      WHERE restaurant_id = ?
        AND id = ?
    `,
  [
    nextPaymentStatus,
    rid,
    id,
  ]
);

      const unpaidLeft = await updateTableAfterPayment(
        tx.qRun,
        tx.qGet,
        rid,
        pay.table_number
      );

      await emitTableOperationalIfEdge(
        tx,
        rid,
        pay.table_number
      );

      await audit(
        req,
        "POS_REFUND",
        {
          payment_id: id,
          refund_amount: refundAmount,
          reason,
          touched_ids: touchedIds,
          payment_batch_id: refundBatchId,
        },
        { entity: "payment", entity_id: String(id) }
      );

      return {
        success: true,
        refund_amount: refundAmount,
        touched_ids: touchedIds,
        unpaid_left: unpaidLeft,
        table_status: unpaidLeft > 0 ? "occupied" : "occupied_paid",
        payment_batch_id: refundBatchId,
        payment_uuid:
          recordedRefund.paymentUuid,
        ref_payment_uuid:
          recordedRefund.refPaymentUuid,
      };
    });

    return res.json(result);
  } catch (e) {
  console.error(
    "❌ refund error",
    e
  );

  const status =
    Number(
      e?.status ||
      500
    );

  return res
    .status(status)
    .json({
      error:
        status >= 500
          ? "Failed to refund"
          : e?.message ||
            "Refund rejected",

      ...(e?.code
        ? {
            code:
              e.code,
          }
        : {}),
    });
}
});

router.post(
  "/payments/:id/void",
  requirePermission(
    PERMISSIONS.POS_VOID_ORDER
  ),async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const paymentId = Number(req.params.id);
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
const staffExpr = await resolveUsersDisplayNameExpr();
const canEdit = await ensurePaymentEditable({ rid, paymentId });
if (!canEdit.ok) return res.status(canEdit.code).json({ error: canEdit.error });

    if (!rid) return res.status(400).json({ error: "Missing tenant" });
    if (!paymentId) return res.status(400).json({ error: "Missing payment id" });

    const isPg = kind === "pg";

    // Only void completed payments, never double-void
    const sql = isPg
      ? `
        UPDATE public.payments
        SET status = 'voided',
            void_reason = $3,
            voided_at = NOW(),
            voided_by_user_id = $4
        WHERE id = $1 AND restaurant_id = $2 AND status = 'completed'
        RETURNING id, status
      `
      : `
        UPDATE payments
        SET status = 'voided',
            void_reason = ?,
            voided_at = CURRENT_TIMESTAMP,
            voided_by_user_id = ?
        WHERE id = ? AND restaurant_id = ? AND status = 'completed'
      `;

    const userId = req.user?.id ? Number(req.user.id) : null;

    let out;
    if (isPg) {
      out = await qGet(sql, [paymentId, rid, reason || null, userId]);
      if (!out?.id) return res.status(400).json({ error: "Cannot void (already voided/refunded or not found)" });
    } else {
      const r = await qRun(sql, [reason || null, userId, paymentId, rid]);
      if (!(r?.changes > 0)) return res.status(400).json({ error: "Cannot void (already voided/refunded or not found)" });
      out = { id: paymentId, status: "voided" };
    }

    await audit(req, "PAYMENT_VOID", { paymentId, reason }, { entity: "payment", entity_id: String(paymentId) });

    return res.json({ success: true, payment: out });
  } catch (err) {
    console.error("void payment error:", err);
    return res.status(500).json({ error: "Failed to void payment" });
  }
});

router.put(
  "/transfer-table",

  requirePermission(
    PERMISSIONS.POS_TRANSFER_TABLE
  ),

  async (req, res) => {
    try {
      const rid =
        Number(
          req.tenantRid ||
          req.user?.restaurant_id ||
          0
        );

      const oldTableRaw =
        req.body?.oldTable;

      const newTableRaw =
        req.body?.newTable;

      const nextOrderTypeRaw =
        req.body?.newOrderType;

      if (!rid) {
        return res.status(401).json({
          error:
            "No restaurant_id",
        });
      }

      if (
        !oldTableRaw ||
        !newTableRaw
      ) {
        return res.status(400).json({
          error:
            "Missing tables",
        });
      }

      const oldTable =
        canonicalTableName(
          oldTableRaw
        );

      const newTable =
        canonicalTableName(
          newTableRaw
        );

      const oldNorm =
        String(oldTable)
          .trim()
          .toLowerCase();

      const newNorm =
        String(newTable)
          .trim()
          .toLowerCase();

      if (
        oldNorm ===
        newNorm
      ) {
        return res.status(400).json({
          error:
            "Same table",
        });
      }

      const movingToTakeaway =
        newNorm ===
        "takeaway";

      const movingToDelivery =
        newNorm ===
        "delivery";

      const movingFromTakeaway =
        oldNorm ===
        "takeaway";

      const movingFromDelivery =
        oldNorm ===
        "delivery";

      const nextOrderType =
        String(
          nextOrderTypeRaw ||
          (
            movingToTakeaway
              ? "takeaway"
              : movingToDelivery
                ? "delivery"
                : "dine-in"
          )
        )
          .trim()
          .toLowerCase();

      const allowedOrderTypes =
        new Set([
          "dine-in",
          "takeaway",
          "delivery",
        ]);

      if (
        !allowedOrderTypes.has(
          nextOrderType
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid order type",
        });
      }

      const result =
        await withTx(
          async (tx) => {
            /*
             * =====================================================
             * 1. LOCK SOURCE BILL
             * =====================================================
             *
             * Payment also locks POS rows with FOR UPDATE.
             *
             * Transfer therefore participates in the same
             * PostgreSQL row-lock boundary instead of racing a
             * payment against an unlocked source bill.
             */
            const movedRows =
              await tx.qAll(
                tx.kind === "pg"
                  ? `
                    SELECT
                      id,
                      batch_id,
                      table_number,
                      paid,
                      remaining_price,
                      total_price

                    FROM public.pos_orders

                    WHERE restaurant_id = $1

                      AND COALESCE(
                            paid,
                            0
                          ) = 0

                      AND COALESCE(
                            remaining_price,
                            total_price,
                            0
                          ) > 0

                      AND LOWER(
                            TRIM(
                              table_number
                            )
                          ) =
                          LOWER(
                            TRIM($2)
                          )

                    ORDER BY
                      created_at ASC,
                      id ASC

                    FOR UPDATE
                  `
                  : `
                    SELECT
                      id,
                      batch_id,
                      table_number,
                      paid,
                      remaining_price,
                      total_price

                    FROM pos_orders

                    WHERE restaurant_id = ?

                      AND COALESCE(
                            paid,
                            0
                          ) = 0

                      AND COALESCE(
                            remaining_price,
                            total_price,
                            0
                          ) > 0

                      AND LOWER(
                            TRIM(
                              table_number
                            )
                          ) =
                          LOWER(
                            TRIM(?)
                          )

                    ORDER BY
                      created_at ASC,
                      id ASC
                  `,
                [
                  rid,
                  oldTable,
                ]
              );

            if (
              !movedRows.length
            ) {
              const error =
                new Error(
                  "No unpaid bill found on source table."
                );

              error.status =
                404;

              error.code =
                "SOURCE_TABLE_HAS_NO_UNPAID_BILL";

              throw error;
            }

            const movedIds =
              movedRows
                .map(
                  (row) =>
                    Number(
                      row.id
                    )
                )
                .filter(
                  (id) =>
                    Number.isInteger(
                      id
                    ) &&
                    id > 0
                );

            const batchIds =
              Array.from(
                new Set(
                  movedRows
                    .map(
                      (row) =>
                        String(
                          row.batch_id ||
                          ""
                        ).trim()
                    )
                    .filter(
                      (batchId) =>
                        isUuid(
                          batchId
                        )
                    )
                )
              );

            /*
             * Edge transfers must have a stable UUID identity for
             * every moved operational row. Cloud keeps legacy behavior,
             * but Edge refuses an unsyncable transfer before mutation.
             */
            if (
              isTableEdgeProducerRuntime()
            ) {
              const missingBatchIdentity =
                movedRows.filter(
                  (row) =>
                    !isUuid(
                      String(
                        row.batch_id ||
                        ""
                      ).trim()
                    )
                );

              if (
                missingBatchIdentity.length
              ) {
                const error =
                  new Error(
                    "This bill cannot be transferred offline because one or more rows do not have a stable batch identity."
                  );

                error.status =
                  409;

                error.code =
                  "EDGE_TABLE_TRANSFER_BATCH_ID_REQUIRED";

                throw error;
              }
            }

            batchIds.sort();

            /*
             * Lock every physical table participating in the transfer
             * in deterministic name order. This gives session/status
             * movement one table-level PostgreSQL boundary and prevents
             * opposite transfers from taking table locks in reverse order.
             */
            const physicalTableRows =
              new Map();

            const physicalTableNames =
              Array.from(
                new Set([
                  ...(
                    !movingFromTakeaway &&
                    !movingFromDelivery
                      ? [
                          oldTable,
                        ]
                      : []
                  ),

                  ...(
                    !movingToTakeaway &&
                    !movingToDelivery
                      ? [
                          newTable,
                        ]
                      : []
                  ),
                ])
              )
                .sort(
                  (
                    a,
                    b
                  ) =>
                    String(a)
                      .trim()
                      .toLowerCase()
                      .localeCompare(
                        String(b)
                          .trim()
                          .toLowerCase()
                      )
                );

            for (
              const tableName of
              physicalTableNames
            ) {
              const tableRow =
                await tx.qGet(
                  tx.kind === "pg"
                    ? `
                      SELECT
                        id,
                        name,
                        status
                      FROM public.tables
                      WHERE
                        restaurant_id = $1
                        AND LOWER(
                              TRIM(name)
                            ) =
                            LOWER(
                              TRIM($2)
                            )
                      LIMIT 1
                      FOR UPDATE
                    `
                    : `
                      SELECT
                        id,
                        name,
                        status
                      FROM tables
                      WHERE
                        restaurant_id = ?
                        AND LOWER(
                              TRIM(name)
                            ) =
                            LOWER(
                              TRIM(?)
                            )
                      LIMIT 1
                    `,
                  [
                    rid,
                    tableName,
                  ]
                );

              if (
                !tableRow?.id
              ) {
                const isDestination =
                  String(
                    tableName
                  )
                    .trim()
                    .toLowerCase() ===
                  newNorm;

                const error =
                  new Error(
                    isDestination
                      ? "Destination table not found."
                      : "Source table not found."
                  );

                error.status =
                  404;

                error.code =
                  isDestination
                    ? "DESTINATION_TABLE_NOT_FOUND"
                    : "SOURCE_TABLE_NOT_FOUND";

                throw error;
              }

              physicalTableRows.set(
                String(
                  tableName
                )
                  .trim()
                  .toLowerCase(),
                tableRow
              );
            }

            /*
             * =====================================================
             * 2. VALIDATE DESTINATION TABLE
             * =====================================================
             *
             * Takeaway / Delivery are virtual destinations.
             *
             * A normal dine-in destination must be a real table
             * belonging to THIS restaurant.
             */
            if (
              !movingToTakeaway &&
              !movingToDelivery
            ) {
              const destinationTable =
                await tx.qGet(
                  tx.kind === "pg"
                    ? `
                      SELECT
                        id,
                        name,
                        status

                      FROM public.tables

                      WHERE restaurant_id =
                            $1

                        AND LOWER(
                              TRIM(
                                name
                              )
                            ) =
                            LOWER(
                              TRIM($2)
                            )

                      LIMIT 1
                    `
                    : `
                      SELECT
                        id,
                        name,
                        status

                      FROM tables

                      WHERE restaurant_id =
                            ?

                        AND LOWER(
                              TRIM(
                                name
                              )
                            ) =
                            LOWER(
                              TRIM(?)
                            )

                      LIMIT 1
                    `,
                  [
                    rid,
                    newTable,
                  ]
                );

              if (
                !destinationTable?.id
              ) {
                const error =
                  new Error(
                    "Destination table not found."
                  );

                error.status =
                  404;

                error.code =
                  "DESTINATION_TABLE_NOT_FOUND";

                throw error;
              }
            }

            /*
             * =====================================================
             * 3. DO NOT SILENTLY MERGE DINE-IN BILLS
             * =====================================================
             *
             * Takeaway and Delivery are collection-style virtual
             * destinations and can legitimately contain multiple
             * independent batches.
             *
             * A physical dine-in table is different: if it already
             * has an outstanding bill, transferring another bill
             * into it would silently merge two customer accounts.
             *
             * That needs an explicit future "merge bills" workflow,
             * not an ordinary table transfer.
             */
            if (
              !movingToTakeaway &&
              !movingToDelivery
            ) {
              const destinationRows =
                await tx.qAll(
                  tx.kind === "pg"
                    ? `
                      SELECT
                        id

                      FROM public.pos_orders

                      WHERE restaurant_id =
                            $1

                        AND COALESCE(
                              paid,
                              0
                            ) = 0

                        AND COALESCE(
                              remaining_price,
                              total_price,
                              0
                            ) > 0

                        AND LOWER(
                              TRIM(
                                table_number
                              )
                            ) =
                            LOWER(
                              TRIM($2)
                            )

                      ORDER BY id

                      FOR UPDATE
                    `
                    : `
                      SELECT
                        id

                      FROM pos_orders

                      WHERE restaurant_id =
                            ?

                        AND COALESCE(
                              paid,
                              0
                            ) = 0

                        AND COALESCE(
                              remaining_price,
                              total_price,
                              0
                            ) > 0

                        AND LOWER(
                              TRIM(
                                table_number
                              )
                            ) =
                            LOWER(
                              TRIM(?)
                            )

                      ORDER BY id
                    `,
                  [
                    rid,
                    newTable,
                  ]
                );

              if (
                destinationRows.length
              ) {
                const error =
                  new Error(
                    "Destination table already has an unpaid bill."
                  );

                error.status =
                  409;

                error.code =
                  "DESTINATION_TABLE_HAS_UNPAID_BILL";

                error.detail = {
                  destination_table:
                    newTable,

                  unpaid_rows:
                    destinationRows.length,
                };

                throw error;
              }
            }

            /*
             * =====================================================
             * 4. MOVE EXACTLY THE LOCKED SOURCE ROWS
             * =====================================================
             *
             * Do not rerun a broad table-name UPDATE after the
             * source state has been established.
             */
            const moved =
              await tx.qRun(
                tx.kind === "pg"
                  ? `
                    UPDATE public.pos_orders

                    SET table_number =
                          $1

                    WHERE restaurant_id =
                          $2

                      AND id =
                          ANY(
                            $3::bigint[]
                          )

                      AND COALESCE(
                            paid,
                            0
                          ) = 0

                      AND COALESCE(
                            remaining_price,
                            total_price,
                            0
                          ) > 0
                  `
                  : `
                    UPDATE pos_orders

                    SET table_number =
                          ?

                    WHERE restaurant_id =
                          ?

                      AND id IN (
                        ${movedIds
                          .map(
                            () =>
                              "?"
                          )
                          .join(",")}
                      )

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
                tx.kind === "pg"
                  ? [
                      newTable,
                      rid,
                      movedIds,
                    ]
                  : [
                      newTable,
                      rid,
                      ...movedIds,
                    ]
              );

            const movedCount =
              Number(
                moved?.rowCount ??
                moved?.changes ??
                0
              );

            if (
              movedCount !==
              movedIds.length
            ) {
              const error =
                new Error(
                  "Bill changed while table transfer was being processed."
                );

              error.status =
                409;

              error.code =
                "TABLE_TRANSFER_STATE_CHANGED";

              throw error;
            }

            /*
             * =====================================================
             * 5. UPDATE AUTHORITATIVE ORDER BATCHES
             * =====================================================
             *
             * Previously normal table -> table transfers moved
             * pos_orders but could leave order_batches.table_number
             * pointing at the old table.
             *
             * Every moved batch now follows the bill.
             */
            let pickupNumber =
              null;

            if (
              movingToTakeaway &&
              batchIds.length
            ) {
              if (
                tx.kind ===
                "pg"
              ) {
                await tx.qGet(
                  `
                  SELECT
                    pg_advisory_xact_lock(
                      $1,
                      $2
                    )
                  `,
                  [
                    Number(rid),
                    7001,
                  ]
                );

                const nextRow =
                  await tx.qGet(
                    `
                    SELECT
                      COALESCE(
                        MAX(
                          pickup_number
                        ),
                        0
                      ) + 1
                        AS next

                    FROM public.order_batches

                    WHERE restaurant_id =
                          $1

                      AND order_type =
                          'takeaway'

                      AND created_at::date =
                          CURRENT_DATE
                    `,
                    [
                      Number(rid),
                    ]
                  );

                pickupNumber =
                  Number(
                    nextRow?.next ||
                    1
                  );
              } else {
                const nextRow =
                  await tx.qGet(
                    `
                    SELECT
                      COALESCE(
                        MAX(
                          pickup_number
                        ),
                        0
                      ) + 1
                        AS next

                    FROM order_batches

                    WHERE restaurant_id =
                          ?

                      AND order_type =
                          'takeaway'

                      AND date(
                            created_at
                          ) =
                          date(
                            'now'
                          )
                    `,
                    [
                      Number(rid),
                    ]
                  );

                pickupNumber =
                  Number(
                    nextRow?.next ||
                    1
                  );
              }
            }

            for (
              const batchId
              of batchIds
            ) {
              if (
                movingToTakeaway
              ) {
                await tx.qRun(
                  tx.kind === "pg"
                    ? `
                      UPDATE public.order_batches

                      SET
                        table_number =
                          'Takeaway',

                        order_type =
                          'takeaway',

                        pickup_number =
                          COALESCE(
                            pickup_number,
                            $1
                          )

                      WHERE restaurant_id =
                            $2

                        AND id =
                            $3::uuid
                    `
                    : `
                      UPDATE order_batches

                      SET
                        table_number =
                          'Takeaway',

                        order_type =
                          'takeaway',

                        pickup_number =
                          COALESCE(
                            pickup_number,
                            ?
                          )

                      WHERE restaurant_id =
                            ?

                        AND id =
                            ?
                    `,
                  [
                    pickupNumber,
                    rid,
                    batchId,
                  ]
                );

                continue;
              }

              if (
                movingToDelivery
              ) {
                await tx.qRun(
                  tx.kind === "pg"
                    ? `
                      UPDATE public.order_batches

                      SET
                        table_number =
                          'Delivery',

                        order_type =
                          'delivery',

                        pickup_number =
                          NULL

                      WHERE restaurant_id =
                            $1

                        AND id =
                            $2::uuid
                    `
                    : `
                      UPDATE order_batches

                      SET
                        table_number =
                          'Delivery',

                        order_type =
                          'delivery',

                        pickup_number =
                          NULL

                      WHERE restaurant_id =
                            ?

                        AND id =
                            ?
                    `,
                  [
                    rid,
                    batchId,
                  ]
                );

                continue;
              }

              /*
               * Physical table destination.
               */
              await tx.qRun(
                tx.kind === "pg"
                  ? `
                    UPDATE public.order_batches

                    SET
                      table_number =
                        $1,

                      order_type =
                        'dine-in',

                      pickup_number =
                        NULL

                    WHERE restaurant_id =
                          $2

                      AND id =
                          $3::uuid
                  `
                  : `
                    UPDATE order_batches

                    SET
                      table_number =
                        ?,

                      order_type =
                        'dine-in',

                      pickup_number =
                        NULL

                    WHERE restaurant_id =
                          ?

                      AND id =
                          ?
                  `,
                [
                  newTable,
                  rid,
                  batchId,
                ]
              );
            }

            /*
             * =====================================================
             * 6. TABLE STATUS
             * =====================================================
             */
            if (
              !movingToTakeaway &&
              !movingToDelivery
            ) {
              await setTableStatus(
                tx.qRun.bind(tx),
                rid,
                newTable,
                "occupied"
              );
            }

            /*
             * Physical source tables become free only after the
             * exact moved rows have left and no unpaid bill remains.
             */
            const sourceLeft =
              await tx.qGet(
                tx.kind === "pg"
                  ? `
                    SELECT
                      COUNT(*)::int
                        AS c

                    FROM public.pos_orders

                    WHERE restaurant_id =
                          $1

                      AND COALESCE(
                            paid,
                            0
                          ) = 0

                      AND COALESCE(
                            remaining_price,
                            total_price,
                            0
                          ) > 0

                      AND LOWER(
                            TRIM(
                              table_number
                            )
                          ) =
                          LOWER(
                            TRIM($2)
                          )
                  `
                  : `
                    SELECT
                      COUNT(*)
                        AS c

                    FROM pos_orders

                    WHERE restaurant_id =
                          ?

                      AND COALESCE(
                            paid,
                            0
                          ) = 0

                      AND COALESCE(
                            remaining_price,
                            total_price,
                            0
                          ) > 0

                      AND LOWER(
                            TRIM(
                              table_number
                            )
                          ) =
                          LOWER(
                            TRIM(?)
                          )
                  `,
                [
                  rid,
                  oldTable,
                ]
              );

            const oldLeft =
              Number(
                sourceLeft?.c ||
                0
              );

            if (
              oldLeft === 0 &&
              !movingFromTakeaway &&
              !movingFromDelivery
            ) {
              await setTableStatus(
                tx.qRun.bind(tx),
                rid,
                oldTable,
                "free"
              );
            }

            /*
             * If the physical source became genuinely free, remove its
             * stale session. When the destination is another physical
             * table and has no session of its own, carry the customer
             * covers/allergy metadata with the bill.
             *
             * Existing destination session metadata is preserved rather
             * than silently overwritten.
             */
            if (
              oldLeft === 0 &&
              physicalTableRows.has(
                oldNorm
              )
            ) {
              const sourcePhysical =
                physicalTableRows.get(
                  oldNorm
                );

              const sourceSession =
                await tx.qGet(
                  tx.kind === "pg"
                    ? `
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
                      FOR UPDATE
                    `
                    : `
                      SELECT
                        covers,
                        allergy_codes,
                        strict_cross_contamination
                      FROM
                        pos_table_sessions
                      WHERE
                        restaurant_id = ?
                        AND table_id = ?
                      LIMIT 1
                    `,
                  [
                    rid,
                    Number(
                      sourcePhysical.id
                    ),
                  ]
                );

              if (
                sourceSession
              ) {
                if (
                  physicalTableRows.has(
                    newNorm
                  )
                ) {
                  const destinationPhysical =
                    physicalTableRows.get(
                      newNorm
                    );

                  if (
                    tx.kind === "pg"
                  ) {
                    await tx.qRun(
                      `
                      INSERT INTO public.pos_table_sessions (
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
                      ON CONFLICT (
                        restaurant_id,
                        table_id
                      )
                      DO NOTHING
                      `,
                      [
                        rid,
                        Number(
                          destinationPhysical.id
                        ),
                        Number(
                          sourceSession.covers ||
                          1
                        ),
                        JSON.stringify(
                          sourceSession
                            .allergy_codes ||
                          []
                        ),
                        sourceSession
                          .strict_cross_contamination ===
                        true,
                      ]
                    );
                  } else {
                    await tx.qRun(
                      `
                      INSERT OR IGNORE INTO pos_table_sessions (
                        restaurant_id,
                        table_id,
                        covers,
                        allergy_codes,
                        strict_cross_contamination
                      )
                      VALUES (?, ?, ?, ?, ?)
                      `,
                      [
                        rid,
                        Number(
                          destinationPhysical.id
                        ),
                        Number(
                          sourceSession.covers ||
                          1
                        ),
                        typeof sourceSession
                          .allergy_codes ===
                          "string"
                          ? sourceSession
                              .allergy_codes
                          : JSON.stringify(
                              sourceSession
                                .allergy_codes ||
                              []
                            ),
                        sourceSession
                          .strict_cross_contamination
                          ? 1
                          : 0,
                      ]
                    );
                  }
                }

                await tx.qRun(
                  tx.kind === "pg"
                    ? `
                      DELETE FROM
                        public.pos_table_sessions
                      WHERE
                        restaurant_id = $1
                        AND table_id = $2
                    `
                    : `
                      DELETE FROM
                        pos_table_sessions
                      WHERE
                        restaurant_id = ?
                        AND table_id = ?
                    `,
                  [
                    rid,
                    Number(
                      sourcePhysical.id
                    ),
                  ]
                );
              }
            }

            /*
             * =====================================================
             * 7. FINAL ROW INVARIANT
             * =====================================================
             */
            const verification =
              await tx.qGet(
                tx.kind === "pg"
                  ? `
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
                            TRIM($1)
                          )
                      )::int
                        AS correct_rows

                    FROM public.pos_orders

                    WHERE restaurant_id =
                          $2

                      AND id =
                          ANY(
                            $3::bigint[]
                          )
                  `
                  : `
                    SELECT
                      COUNT(*)
                        AS total_rows,

                      SUM(
                        CASE
                          WHEN
                            LOWER(
                              TRIM(
                                table_number
                              )
                            ) =
                            LOWER(
                              TRIM(?)
                            )
                          THEN 1
                          ELSE 0
                        END
                      )
                        AS correct_rows

                    FROM pos_orders

                    WHERE restaurant_id =
                          ?

                      AND id IN (
                        ${movedIds
                          .map(
                            () =>
                              "?"
                          )
                          .join(",")}
                      )
                  `,
                tx.kind === "pg"
                  ? [
                      newTable,
                      rid,
                      movedIds,
                    ]
                  : [
                      newTable,
                      rid,
                      ...movedIds,
                    ]
              );

            if (
              Number(
                verification
                  ?.total_rows ||
                0
              ) !==
                movedIds.length ||

              Number(
                verification
                  ?.correct_rows ||
                0
              ) !==
                movedIds.length
            ) {
              const error =
                new Error(
                  "Table transfer integrity check failed."
                );

              error.status =
                409;

              error.code =
                "TABLE_TRANSFER_INTEGRITY_FAILED";

              throw error;
            }

            /*
             * Emit physical table snapshots first, then one authoritative
             * assignment event per moved batch. Every event shares this
             * same transfer transaction, so an assignment outbox failure
             * also rolls back already-written table revisions/events.
             */
            const tableSync =
              [];

            const eventTableNames =
              Array.from(
                physicalTableRows
                  .values()
              )
                .map(
                  (row) =>
                    String(
                      row.name || ""
                    ).trim()
                )
                .filter(
                  Boolean
                )
                .sort(
                  (
                    a,
                    b
                  ) =>
                    a
                      .toLowerCase()
                      .localeCompare(
                        b.toLowerCase()
                      )
                );

            for (
              const tableName of
              eventTableNames
            ) {
              const sync =
                await emitTableOperationalIfEdge(
                  tx,
                  rid,
                  tableName
                );

              if (
                sync
              ) {
                tableSync.push({
                  table_name:
                    tableName,

                  revision:
                    sync.revision,
                });
              }
            }

            const batchSync =
              [];

            for (
              const batchId of
              batchIds
            ) {
              const sync =
                await emitTableBatchAssignmentIfEdge(
                  tx,
                  rid,
                  batchId
                );

              if (
                sync
              ) {
                batchSync.push({
                  batch_id:
                    batchId,

                  revision:
                    sync.revision,
                });
              }
            }

            return {
              moved:
                movedCount,

              oldLeft,

              batchIds,

              orderType:
                nextOrderType,

              tableSync,

              batchSync,
            };
          }
        );

      try {
        await audit(
          req,
          "POS_TRANSFER_TABLE",
          {
            old_table:
              oldTable,

            new_table:
              newTable,

            moved:
              result.moved,

            old_table_unpaid_left:
              result.oldLeft,

            batch_ids:
              result.batchIds,

            order_type:
              result.orderType,
          },
          {
            entity:
              "table",

            entity_id:
              oldTable,
          }
        );
      } catch (
        auditError
      ) {
        console.error(
          "⚠️ Table transfer committed but audit failed:",
          auditError
        );
      }

      return res.json({
        success:
          true,

        moved:
          result.moved,

        old_table_unpaid_left:
          result.oldLeft,

        oldTable,

        newTable,

        order_type:
          result.orderType,
      });
    } catch (error) {
      console.error(
        "transfer-table failed",
        error
      );

      const status =
        Number(
          error?.status ||
          500
        );

      return res
        .status(status)
        .json({
          error:
            status >= 500
              ? "Transfer failed"
              : error.message,

          ...(error?.code
            ? {
                code:
                  error.code,
              }
            : {}),

          ...(error?.detail
            ? {
                detail:
                  error.detail,
              }
            : {}),
        });
    }
  }
);

router.post("/access-check", requireRole(...POS_STAFF), async (req, res) => {
  try {
    const restaurantId = Number(req.tenantRid || req.user?.restaurant_id || 0);
    const userId = Number(req.user?.id || 0);

    const deviceKey = String(
      req.body?.device_key || req.headers["x-device-key"] || ""
    ).trim();

    const deviceName = String(
      req.body?.device_name || req.headers["x-device-name"] || ""
    ).trim() || null;

    const deviceType = "pos";

    if (!restaurantId || !userId) {
      return res.status(400).json({ error: "Missing auth context" });
    }

    if (!deviceKey) {
      return res.status(400).json({ error: "device_key is required" });
    }

    const restaurant = await qGet(
      `
      SELECT id, name, device_limit, account_status
      FROM public.restaurants
      WHERE id = $1
      LIMIT 1
      `,
      [restaurantId]
    );

    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    if (String(restaurant.account_status || "active").toLowerCase() !== "active") {
      return res.status(403).json({
        error: "Restaurant account is not active",
        code: "ACCOUNT_BLOCKED",
      });
    }

    const deviceLimit = Number(restaurant.device_limit || 0);
    const liveWindowSql = `NOW() - INTERVAL '5 minutes'`;

    // keep device inventory updated
    const knownDevice = await qGet(
      `
      SELECT id, is_active
      FROM public.restaurant_devices
      WHERE restaurant_id = $1
        AND device_key = $2
      LIMIT 1
      `,
      [restaurantId, deviceKey]
    );

    if (knownDevice?.id) {
      if (knownDevice.is_active === false) {
        return res.status(403).json({
          error: "This POS device is disabled",
          code: "POS_DEVICE_DISABLED",
        });
      }

      await qRun(
        `
        UPDATE public.restaurant_devices
        SET
          device_type = $1,
          device_name = COALESCE($2, device_name),
          last_seen_at = NOW()
        WHERE restaurant_id = $3
          AND id = $4
        `,
        [deviceType, deviceName, restaurantId, Number(knownDevice.id)]
      );
    } else {
      await qRun(
        `
        INSERT INTO public.restaurant_devices
          (
            restaurant_id,
            device_key,
            device_type,
            device_name,
            is_active,
            first_seen_at,
            last_seen_at
          )
        VALUES
          ($1, $2, $3, $4, TRUE, NOW(), NOW())
        `,
        [restaurantId, deviceKey, deviceType, deviceName]
      );
    }

    // expire stale seats
    await qRun(
      `
      UPDATE public.pos_device_sessions
      SET
        is_active = FALSE,
        released_at = NOW()
      WHERE restaurant_id = $1
        AND is_active = TRUE
        AND last_seen_at < ${liveWindowSql}
      `,
      [restaurantId]
    );

    // limit <= 0 = unlimited
    if (deviceLimit > 0) {
      const liveRow = await qGet(
        `
        SELECT COUNT(*)::int AS c
        FROM public.pos_device_sessions
        WHERE restaurant_id = $1
          AND is_active = TRUE
          AND last_seen_at >= ${liveWindowSql}
        `,
        [restaurantId]
      );

      const liveCount = Number(liveRow?.c || 0);

      const alreadyLiveForThisDevice = await qGet(
        `
        SELECT id
        FROM public.pos_device_sessions
        WHERE restaurant_id = $1
          AND device_key = $2
          AND is_active = TRUE
          AND last_seen_at >= ${liveWindowSql}
        LIMIT 1
        `,
        [restaurantId, deviceKey]
      );

      if (!alreadyLiveForThisDevice?.id && liveCount >= deviceLimit) {
        return res.status(403).json({
          success: false,
          allowed: false,
          error: "POS device limit reached",
          code: "POS_DEVICE_LIMIT_REACHED",
          restaurant_id: restaurantId,
          device_limit: deviceLimit,
          active_pos_devices: liveCount,
        });
      }
    }

    const claimed = await qGet(
      `
      INSERT INTO public.pos_device_sessions
        (
          restaurant_id,
          user_id,
          device_key,
          device_name,
          is_active,
          claimed_at,
          created_at,
          last_seen_at,
          released_at
        )
      VALUES
        ($1, $2, $3, $4, TRUE, NOW(), NOW(), NOW(), NULL)
      ON CONFLICT (restaurant_id, device_key)
      DO UPDATE SET
        user_id      = EXCLUDED.user_id,
        device_name  = COALESCE(EXCLUDED.device_name, public.pos_device_sessions.device_name),
        is_active    = TRUE,
        claimed_at   = NOW(),
        last_seen_at = NOW(),
        released_at  = NULL
      RETURNING id
      `,
      [restaurantId, userId, deviceKey, deviceName]
    );

    return res.json({
      success: true,
      allowed: true,
      mode: "claimed_slot",
      session_id: Number(claimed?.id || 0),
    });
  } catch (err) {
    console.error("❌ POST /orders/access-check failed:", err);
    return res.status(500).json({ error: "Failed to claim POS slot" });
  }
});

router.post(
  "/void-unpaid/:tableNumber",

  requirePermission(
    PERMISSIONS.POS_VOID_ORDER
  ),

  async (req, res) => {
    try {
      const restaurantId =
        Number(
          req.tenantRid || 0
        );

      const tableNumber =
        canonicalTableName(
          req.params.tableNumber
        );

      const reason =
        String(
          req.body?.reason || ""
        )
          .trim()
          .slice(0, 200);

      const managerPin =
        String(
          req.body?.manager_pin || ""
        ).trim();

      if (!restaurantId) {
        return res.status(400).json({
          error:
            "Missing tenant",
        });
      }

      if (!tableNumber) {
        return res.status(400).json({
          error:
            "Table number required",
        });
      }

      if (
        !/^\d{4}$/.test(
          managerPin
        )
      ) {
        return res.status(400).json({
          error:
            "Valid manager PIN required",
        });
      }

      if (!reason) {
        return res.status(400).json({
          error:
            "Void reason required",
          code:
            "POS_VOID_REASON_REQUIRED",
        });
      }

      const approver =
        await verifyPosApprover({
          restaurantId,

          pin:
            managerPin,

          permission:
            PERMISSIONS.POS_VOID_ORDER,
        });

      if (!approver) {
        return res.status(403).json({
          error:
            "Manager or owner approval required.",

          code:
            "POS_VOID_ORDER_APPROVAL_DENIED",
        });
      }

      const result =
        await withTx(
          async (tx) => {
            /*
             * Lock the authoritative outstanding bill.
             *
             * mark-paid and pay-share also use FOR UPDATE,
             * therefore payment and void now serialize on
             * the exact same POS rows.
             */
            const rows =
              await tx.qAll(
                `
                SELECT
                  id,
                  table_number,
                  item_name,
                  quantity,
                  total_price,

                  COALESCE(
                    amount_paid,
                    0
                  )::numeric
                    AS amount_paid,

                  COALESCE(
                    remaining_price,
                    total_price,
                    0
                  )::numeric
                    AS remaining_price

                FROM public.pos_orders

                WHERE restaurant_id =
                      $1

                  AND LOWER(
                        TRIM(
                          table_number
                        )
                      ) =
                      LOWER(
                        TRIM($2)
                      )

                  AND COALESCE(
                        paid,
                        0
                      ) = 0

                  AND COALESCE(
                        remaining_price,
                        total_price,
                        0
                      ) > 0

                ORDER BY
                  created_at ASC,
                  id ASC

                FOR UPDATE
                `,
                [
                  restaurantId,
                  tableNumber,
                ]
              );

            if (!rows.length) {
              const error =
                new Error(
                  "No unpaid items found to void"
                );

              error.status = 400;
              error.code =
                "NO_UNPAID_ITEMS";

              throw error;
            }

            /*
             * A partially paid bill cannot be converted to
             * a £0 void because that would destroy captured
             * money while leaving the immutable ledger alive.
             *
             * Staff must refund/void the recorded payment
             * first, then void the remaining order.
             */
            const partiallyPaid =
              rows.filter(
                (row) =>
                  Number(
                    row.amount_paid ||
                    0
                  ) > 0.01
              );

            if (
              partiallyPaid.length
            ) {
              const error =
                new Error(
                  "This bill already contains recorded payments. Reverse those payments before voiding the unpaid bill."
                );

              error.status = 409;

              error.code =
                "PAID_AMOUNT_EXISTS";

              error.detail = {
                item_ids:
                  partiallyPaid.map(
                    (row) =>
                      Number(
                        row.id
                      )
                  ),
              };

              throw error;
            }

            const ids =
              rows
                .map(
                  (row) =>
                    Number(
                      row.id
                    )
                )
                .filter(Boolean);

            const updated =
              await tx.qRun(
                `
                UPDATE public.pos_orders

                SET
                  order_status =
                    'voided',

                  paid =
                    1,

                  amount_paid =
                    0,

                  remaining_price =
                    0,

                  kds_archived_at =
                    NOW()

                WHERE restaurant_id =
                      $1

                  AND id =
                      ANY(
                        $2::bigint[]
                      )

                  AND COALESCE(
                        paid,
                        0
                      ) = 0

                  AND COALESCE(
                        amount_paid,
                        0
                      ) <= 0.01

                  AND COALESCE(
                        remaining_price,
                        total_price,
                        0
                      ) > 0
                `,
                [
                  restaurantId,
                  ids,
                ]
              );

            const changed =
              Number(
                updated?.rowCount ||
                updated?.changes ||
                0
              );

            if (
              changed !==
              ids.length
            ) {
              const error =
                new Error(
                  "Bill changed while void was being processed."
                );

              error.status = 409;

              error.code =
                "VOID_STATE_CHANGED";

              throw error;
            }

            const remaining =
              await tx.qGet(
                `
                SELECT
                  COUNT(*)::int
                    AS count

                FROM public.pos_orders

                WHERE restaurant_id =
                      $1

                  AND LOWER(
                        TRIM(
                          table_number
                        )
                      ) =
                      LOWER(
                        TRIM($2)
                      )

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
                  restaurantId,
                  tableNumber,
                ]
              );

            const unpaidLeft =
              Number(
                remaining?.count ||
                0
              );

            await setTableStatus(
              tx.qRun.bind(tx),
              restaurantId,
              tableNumber,
              unpaidLeft > 0
                ? "occupied"
                : "free"
            );

            if (
              unpaidLeft === 0
            ) {
              await clearTableSessionByName(
                tx.qRun.bind(tx),
                restaurantId,
                tableNumber
              );
            }

            await emitTableOperationalIfEdge(
              tx,
              restaurantId,
              tableNumber
            );

            return {
              ids,
              rows,
              unpaidLeft,
            };
          }
        );

      try {
        await audit(
          req,
          "POS_VOID_UNPAID",
          {
            table:
              tableNumber,

            item_ids:
              result.ids,

            reason,

            approved_by_user_id:
              approver.id,

            approved_by_authority:
              approver.authority,
          },
          {
            entity:
              "table",

            entity_id:
              tableNumber,
          }
        );
      } catch (
        auditError
      ) {
        console.error(
          "⚠️ Void committed but audit failed:",
          auditError
        );
      }

      return res.json({
        success:
          true,

        voided_count:
          result.ids.length,

        unpaid_left:
          result.unpaidLeft,

        approved_by:
          approver.name,
      });
    } catch (err) {
      console.error(
        "❌ void-unpaid failed:",
        err
      );

      const status =
        Number(
          err?.status ||
          500
        );

      return res
        .status(status)
        .json({
          error:
            status >= 500
              ? "Failed to void unpaid items"
              : err.message,

          ...(err?.code
            ? {
                code:
                  err.code,
              }
            : {}),

          ...(err?.detail
            ? {
                detail:
                  err.detail,
              }
            : {}),
        });
    }
  }
);

router.post(
  "/void-items",

  requirePermission(
    PERMISSIONS.POS_VOID_ITEM
  ),

  async (req, res) => {
    try {
      const restaurantId =
        Number(
          req.tenantRid || 0
        );

      const {
        tableNumber,
        itemIds = [],
        reason = "",
        manager_pin = "",
      } =
        req.body || {};

      const table =
        canonicalTableName(
          tableNumber
        );

      if (!restaurantId) {
        return res.status(400).json({
          error:
            "Missing tenant",
        });
      }

      if (!table) {
        return res.status(400).json({
          error:
            "tableNumber is required",
        });
      }

      const cleanIds =
        Array.from(
          new Set(
            (
              Array.isArray(
                itemIds
              )
                ? itemIds
                : []
            )
              .map(Number)
              .filter(
                (id) =>
                  Number.isInteger(
                    id
                  ) &&
                  id > 0
              )
          )
        );

      if (!cleanIds.length) {
        return res.status(400).json({
          error:
            "itemIds[] required",
        });
      }

      const managerPin =
        String(
          manager_pin || ""
        ).trim();

      if (
        !/^\d{4}$/.test(
          managerPin
        )
      ) {
        return res.status(400).json({
          error:
            "Valid manager PIN required",
        });
      }

      const safeReason =
        String(
          reason || ""
        )
          .trim()
          .slice(0, 200);

      if (!safeReason) {
        return res.status(400).json({
          error:
            "Void reason required",
          code:
            "POS_VOID_REASON_REQUIRED",
        });
      }

      const approver =
        await verifyPosApprover({
          restaurantId,

          pin:
            managerPin,

          permission:
            PERMISSIONS.POS_VOID_ITEM,
        });

      if (!approver) {
        return res.status(403).json({
          error:
            "Manager or owner approval required.",

          code:
            "POS_VOID_ITEM_APPROVAL_DENIED",
        });
      }

      const result =
        await withTx(
          async (tx) => {
            const existingRows =
              await tx.qAll(
                `
                SELECT
                  id,
                  table_number,
                  item_name,
                  quantity,
                  total_price,

                  COALESCE(
                    amount_paid,
                    0
                  )::numeric
                    AS amount_paid,

                  COALESCE(
                    remaining_price,
                    total_price,
                    0
                  )::numeric
                    AS remaining_price

                FROM public.pos_orders

                WHERE restaurant_id =
                      $1

                  AND LOWER(
                        TRIM(
                          table_number
                        )
                      ) =
                      LOWER(
                        TRIM($2)
                      )

                  AND id =
                      ANY(
                        $3::bigint[]
                      )

                  AND COALESCE(
                        paid,
                        0
                      ) = 0

                  AND COALESCE(
                        remaining_price,
                        total_price,
                        0
                      ) > 0

                ORDER BY
                  created_at ASC,
                  id ASC

                FOR UPDATE
                `,
                [
                  restaurantId,
                  table,
                  cleanIds,
                ]
              );

            if (
              !existingRows.length
            ) {
              const error =
                new Error(
                  "No matching unpaid items found to void"
                );

              error.status =
                400;

              throw error;
            }

            const partiallyPaid =
              existingRows.filter(
                (row) =>
                  Number(
                    row.amount_paid ||
                    0
                  ) > 0.01
              );

            if (
              partiallyPaid.length
            ) {
              const error =
                new Error(
                  "One or more selected items already contain recorded payments. Reverse the payment before voiding them."
                );

              error.status =
                409;

              error.code =
                "PAID_AMOUNT_EXISTS";

              error.detail = {
                item_ids:
                  partiallyPaid.map(
                    (row) =>
                      Number(
                        row.id
                      )
                  ),
              };

              throw error;
            }

            const authoritativeIds =
              existingRows.map(
                (row) =>
                  Number(
                    row.id
                  )
              );

            const updated =
              await tx.qRun(
                `
                UPDATE public.pos_orders

                SET
                  order_status =
                    'voided',

                  paid =
                    1,

                  amount_paid =
                    0,

                  remaining_price =
                    0,

                  kds_archived_at =
                    NOW()

                WHERE restaurant_id =
                      $1

                  AND id =
                      ANY(
                        $2::bigint[]
                      )

                  AND COALESCE(
                        paid,
                        0
                      ) = 0

                  AND COALESCE(
                        amount_paid,
                        0
                      ) <= 0.01

                  AND COALESCE(
                        remaining_price,
                        total_price,
                        0
                      ) > 0
                `,
                [
                  restaurantId,
                  authoritativeIds,
                ]
              );

            const changed =
              Number(
                updated?.rowCount ||
                updated?.changes ||
                0
              );

            if (
              changed !==
              authoritativeIds.length
            ) {
              const error =
                new Error(
                  "Order changed while item void was being processed."
                );

              error.status =
                409;

              error.code =
                "VOID_STATE_CHANGED";

              throw error;
            }

            const unpaidLeft =
              await updateTableAfterPayment(
                tx.qRun.bind(tx),
                tx.qGet.bind(tx),
                restaurantId,
                table
              );

            if (
              Number(
                unpaidLeft
              ) === 0
            ) {
              await clearTableSessionByName(
                tx.qRun.bind(tx),
                restaurantId,
                table
              );
            }

            return {
              existingRows,
              unpaidLeft:
                Number(
                  unpaidLeft ||
                  0
                ),
            };
          }
        );

      try {
        await audit(
          req,
          "POS_ITEMS_VOIDED",
          {
            table,

            item_ids:
              result.existingRows.map(
                (row) =>
                  Number(
                    row.id
                  )
              ),

            items:
              result.existingRows.map(
                (row) => ({
                  id:
                    row.id,

                  item_name:
                    row.item_name,

                  quantity:
                    Number(
                      row.quantity ||
                      1
                    ),

                  total_price:
                    Number(
                      row.total_price ||
                      0
                    ),
                })
              ),

            reason:
              safeReason,

            approved_by_user_id:
              Number(
                approver.id
              ),

            approved_by_authority:
              approver.authority,
          },
          {
            entity:
              "table",

            entity_id:
              table,
          }
        );
      } catch (
        auditError
      ) {
        console.error(
          "⚠️ Item void committed but audit failed:",
          auditError
        );
      }

      return res.json({
        success:
          true,

        voided_count:
          result
            .existingRows
            .length,

        unpaid_left:
          result.unpaidLeft,

        table_status:
          result.unpaidLeft > 0
            ? "occupied"
            : "occupied_paid",
      });
    } catch (err) {
      console.error(
        "❌ void-items failed:",
        err
      );

      const status =
        Number(
          err?.status ||
          500
        );

      return res
        .status(status)
        .json({
          error:
            status >= 500
              ? "Failed to void selected items"
              : err.message,

          ...(err?.code
            ? {
                code:
                  err.code,
              }
            : {}),

          ...(err?.detail
            ? {
                detail:
                  err.detail,
              }
            : {}),
        });
    }
  }
);

router.patch(
  "/availability",
  requireRole(...POS_STAFF),
  requireCloudPosMenuCatalogAuthority,
  async (req, res) => {
    try {
      const restaurantId = Number(
        req.tenantRid || req.user?.restaurant_id || 0
      );
      const itemId = Number(req.body?.item_id || 0);
      const itemType = String(req.body?.item_type || "")
        .trim()
        .toLowerCase();
      const outOfStock = !!req.body?.out_of_stock;

      if (!restaurantId) {
        return res.status(400).json({
          error: "Missing restaurant context",
        });
      }

      if (!itemId) {
        return res.status(400).json({
          error: "item_id is required",
        });
      }

      if (!["meals", "drinks", "desserts"].includes(itemType)) {
        return res.status(400).json({
          error: "item_type must be 'meals', 'drinks', or 'desserts'",
        });
      }

      const result = await withTx(async (tx) => {
        if (itemType === "meals") {
          const current = await tx.qGet(
            `
            SELECT id, name, out_of_stock
            FROM public.meals
            WHERE restaurant_id = $1
              AND id = $2
            FOR UPDATE
            `,
            [restaurantId, itemId]
          );

          if (!current?.id) {
            return {
              notFound: true,
              itemSource: "meals",
            };
          }

          if (!!current.out_of_stock === outOfStock) {
            return {
              notFound: false,
              changed: false,
              itemSource: "meals",
              item: current,
            };
          }

          const updated = await tx.qGet(
            `
            UPDATE public.meals
            SET out_of_stock = $1
            WHERE restaurant_id = $2
              AND id = $3
            RETURNING id, name, out_of_stock
            `,
            [outOfStock, restaurantId, itemId]
          );

          await emitMenuCatalogSnapshotTx(tx, {
            restaurantId,
          });

          return {
            notFound: false,
            changed: true,
            itemSource: "meals",
            item: updated,
          };
        }

        const expectedType =
          itemType === "drinks" ? "drink" : "dessert";

        const current = await tx.qGet(
          `
          SELECT id, name, type, out_of_stock
          FROM public.menu_items
          WHERE restaurant_id = $1
            AND id = $2
            AND LOWER(TRIM(COALESCE(type, ''))) = $3
          FOR UPDATE
          `,
          [restaurantId, itemId, expectedType]
        );

        if (!current?.id) {
          return {
            notFound: true,
            itemSource: "menu_items",
          };
        }

        if (!!current.out_of_stock === outOfStock) {
          return {
            notFound: false,
            changed: false,
            itemSource: "menu_items",
            item: current,
          };
        }

        const updated = await tx.qGet(
          `
          UPDATE public.menu_items
          SET out_of_stock = $1
          WHERE restaurant_id = $2
            AND id = $3
            AND LOWER(TRIM(COALESCE(type, ''))) = $4
          RETURNING id, name, type, out_of_stock
          `,
          [outOfStock, restaurantId, itemId, expectedType]
        );

        await emitMenuCatalogSnapshotTx(tx, {
          restaurantId,
        });

        return {
          notFound: false,
          changed: true,
          itemSource: "menu_items",
          item: updated,
        };
      });

      if (result?.notFound) {
        return res.status(404).json({
          error:
            result.itemSource === "meals"
              ? "Meal not found"
              : "Menu item not found",
        });
      }

      return res.json({
        success: true,
        item_source: result.itemSource,
        item: result.item,
      });
    } catch (err) {
      console.error("❌ PATCH /availability failed:", err);

      if (sendPosMenuCatalogAuthorityError(res, err)) {
        return;
      }

      return res.status(500).json({
        error: "Failed to update item availability",
      });
    }
  }
);

router.post(
  "/cleanup-pending-qr-kiosk",
  requireRole(...POS_STAFF),

  async (req, res) => {
    try {
      const restaurantId =
        Number(req.tenantRid || 0);

      if (!restaurantId) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      if (kind !== "pg") {
        return res.status(500).json({
          error: "Postgres required.",
        });
      }

      const result =
        await withTx(
          async (tx) => {
            /*
             * =====================================================
             * 1. LOCK EXPIRED QR/KIOSK ROWS
             * =====================================================
             *
             * Payment also locks pos_orders rows.
             *
             * This means payment and cleanup cannot independently
             * mutate the same pending order at the same time.
             */
            const expiredRows =
              await tx.qAll(
                `
                SELECT
                  id,
                  batch_id,
                  source,
                  order_status,
                  paid,
                  expires_at
                FROM public.pos_orders
                WHERE restaurant_id = $1
                  AND LOWER(
                        TRIM(
                          COALESCE(
                            source,
                            ''
                          )
                        )
                      ) IN (
                        'qr',
                        'kiosk'
                      )
                  AND LOWER(
                        TRIM(
                          COALESCE(
                            order_status,
                            ''
                          )
                        )
                      ) = 'pending_payment'
                  AND COALESCE(
                        paid,
                        0
                      ) = 0
                  AND expires_at
                        IS NOT NULL
                  AND expires_at < NOW()
                ORDER BY
                  id ASC
                FOR UPDATE
                `,
                [
                  restaurantId,
                ]
              );

            if (
              !expiredRows.length
            ) {
              return {
                deleted: 0,
                batchIds: [],
              };
            }

            /*
             * Never trust batch identifiers from a request.
             *
             * These came directly from tenant-owned locked rows.
             */
            const batchIds =
              Array.from(
                new Set(
                  expiredRows
                    .map(
                      (row) =>
                        String(
                          row.batch_id ||
                            ""
                        )
                    )
                    .filter(
                      (batchId) =>
                        isUuid(
                          batchId
                        )
                    )
                )
              );

            /*
             * =====================================================
             * 2. RELEASE AVAILABILITY RESERVATIONS
             * =====================================================
             *
             * An abandoned QR/kiosk order must not permanently
             * reserve stock/availability.
             */
            for (
              const batchId
              of batchIds
            ) {
              await releaseAvailabilityReservationsForBatch(
                {
                  db: tx,

                  restaurantId,

                  batchId,
                }
              );
            }

            /*
             * =====================================================
             * 3. DELETE ONLY THE ROWS WE LOCKED
             * =====================================================
             *
             * Do NOT rerun a broad expires_at DELETE here.
             *
             * The IDs below are the exact rows whose state was
             * established while locked.
             */
            const ids =
              expiredRows
                .map(
                  (row) =>
                    Number(
                      row.id
                    )
                )
                .filter(
                  (id) =>
                    Number.isInteger(
                      id
                    ) &&
                    id > 0
                );

            const deleted =
              await tx.qRun(
                `
                DELETE FROM public.pos_orders
                WHERE restaurant_id = $1
                  AND id =
                    ANY(
                      $2::bigint[]
                    )
                  AND COALESCE(
                        paid,
                        0
                      ) = 0
                  AND LOWER(
                        TRIM(
                          COALESCE(
                            order_status,
                            ''
                          )
                        )
                      ) =
                        'pending_payment'
                  AND expires_at
                        IS NOT NULL
                  AND expires_at <
                        NOW()
                `,
                [
                  restaurantId,
                  ids,
                ]
              );

            const deletedCount =
              Number(
                deleted?.rowCount ||
                  0
              );

            /*
             * Because these rows were locked, every selected row
             * should still satisfy the DELETE predicate.
             *
             * Anything else indicates an unexpected lifecycle
             * mutation and should roll back.
             */
            if (
              deletedCount !==
              ids.length
            ) {
              const err =
                new Error(
                  "Pending order changed during cleanup."
                );

              err.status = 409;

              throw err;
            }

            /*
             * =====================================================
             * 4. REMOVE EMPTY ORDER BATCHES
             * =====================================================
             *
             * Only remove a batch when no POS rows remain attached.
             */
            for (
              const batchId
              of batchIds
            ) {
              await tx.qRun(
                `
                DELETE FROM public.order_batches ob
                WHERE ob.restaurant_id = $1
                  AND ob.id =
                        $2::uuid
                  AND NOT EXISTS (
                    SELECT 1
                    FROM public.pos_orders po
                    WHERE po.restaurant_id =
                          ob.restaurant_id
                      AND po.batch_id =
                          ob.id
                  )
                `,
                [
                  restaurantId,
                  batchId,
                ]
              );
            }

            return {
              deleted:
                deletedCount,

              batchIds,
            };
          }
        );

      /*
       * Audit after commit.
       */
      try {
        await audit(
          req,
          "pos.cleanup_pending_qr_kiosk",
          {
            deleted:
              result.deleted,

            batch_ids:
              result.batchIds,
          }
        );
      } catch {}

      return res.json({
        success: true,

        deleted:
          result.deleted,

        batches_released:
          result.batchIds.length,
      });
    } catch (e) {
      console.error(
        "❌ cleanup pending QR/kiosk failed:",
        e
      );

      return res
        .status(
          Number(
            e?.status ||
              500
          )
        )
        .json({
          error:
            e?.message ||
            "Cleanup failed",
        });
    }
  }
);

module.exports = { router, initPosOrders };
