const router = require("express").Router();

const { qRun, withTx, kind } = require("../dbCompat");

const {
  authenticateToken,
} = require(
  "../middleware/authMiddleware"
);

const {
  PERMISSIONS,
  requirePermission,
} = require(
  "../middleware/accessControl"
);
const { loadMembership } = require("../middleware/tenantMembership");
const { audit } = require("../utils/audit");
const {
  deductStockFromMealOrder,
  deductStockByItemName,
  deductStockByStockId,
} = require("../utils/novaDeduct");

router.use(authenticateToken, loadMembership);


function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function text(v) {
  return String(v || "").trim();
}

function canonicalReason(reason) {
  const s = text(reason).toLowerCase();

  if (s.includes("complaint")) return "complaint";
  if (s.includes("burn")) return "burnt";
  if (s.includes("overcook")) return "overcooked";
  if (s.includes("undercook")) return "undercooked";
  if (s.includes("wrong")) return "wrong_item";
  if (s.includes("waste")) return "waste";
  if (s.includes("break")) return "broken";
  if (s.includes("refund")) return "refund";
  return s || "other";
}

function reportTypeFrom({ redo, reason }) {
  const r = canonicalReason(reason);
  if (redo) return "remake";
  if (r === "complaint") return "complaint";
  return "waste";
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

async function ensureReportsTable() {
  if (kind === "pg") {
    await qRun(`
      CREATE TABLE IF NOT EXISTS public.reports (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL,
        order_id BIGINT,
        batch_id UUID,
        table_number TEXT,
        meal_id BIGINT,
        menu_item_id BIGINT,
        stock_id BIGINT,
        item_name TEXT NOT NULL,
        item_type TEXT,
        category_id INTEGER,
        quantity REAL NOT NULL DEFAULT 1,
        reason TEXT,
        report_type TEXT,
        redo BOOLEAN NOT NULL DEFAULT false,
        waste_counted BOOLEAN NOT NULL DEFAULT true,
        stock_rededucted BOOLEAN NOT NULL DEFAULT false,
        estimated_value REAL NOT NULL DEFAULT 0,
        reported_by TEXT,
        reported_by_user_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS restaurant_id BIGINT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS order_id BIGINT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS batch_id UUID;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS table_number TEXT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS meal_id BIGINT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS menu_item_id BIGINT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS stock_id BIGINT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS item_name TEXT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS item_type TEXT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS category_id INTEGER;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS quantity REAL NOT NULL DEFAULT 1;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reason TEXT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS report_type TEXT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS redo BOOLEAN NOT NULL DEFAULT false;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS waste_counted BOOLEAN NOT NULL DEFAULT true;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS stock_rededucted BOOLEAN NOT NULL DEFAULT false;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS estimated_value REAL NOT NULL DEFAULT 0;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reported_by TEXT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reported_by_user_id BIGINT;`);
    await qRun(`ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);

    await qRun(`
      CREATE INDEX IF NOT EXISTS idx_reports_rid_created
      ON public.reports(restaurant_id, created_at DESC);
    `);
    await qRun(`
      CREATE INDEX IF NOT EXISTS idx_reports_type
      ON public.reports(restaurant_id, report_type);
    `);
    await qRun(`
      CREATE INDEX IF NOT EXISTS idx_reports_staff
      ON public.reports(restaurant_id, reported_by_user_id);
    `);
    await qRun(`
      CREATE INDEX IF NOT EXISTS idx_reports_batch
      ON public.reports(restaurant_id, batch_id);
    `);
    return;
  }

  await qRun(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      order_id INTEGER,
      batch_id TEXT,
      table_number TEXT,
      meal_id INTEGER,
      menu_item_id INTEGER,
      stock_id INTEGER,
      item_name TEXT NOT NULL,
      item_type TEXT,
      category_id INTEGER,
      quantity REAL NOT NULL DEFAULT 1,
      reason TEXT,
      report_type TEXT,
      redo INTEGER NOT NULL DEFAULT 0,
      waste_counted INTEGER NOT NULL DEFAULT 1,
      stock_rededucted INTEGER NOT NULL DEFAULT 0,
      estimated_value REAL NOT NULL DEFAULT 0,
      reported_by TEXT,
      reported_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

ensureReportsTable().catch((e) => {
  console.error("❌ ensureReportsTable failed:", e);
});

router.post(
  "/",
  requirePermission(
    PERMISSIONS.REPORTS_CREATE
  ),async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const userId = Number(req.user?.id || 0);

    if (!rid) return res.status(400).json({ error: "Missing tenant" });
    if (!userId) return res.status(400).json({ error: "Missing user" });

    const {
      order_id,
      batch_id,
      table_number,
      meal_id,
      menu_item_id,
      stock_id,
      item_name,
      item_type,
      category_id,
      reason,
      quantity = 1,
      redo = false,
      total_price = 0,
    } = req.body || {};

    const cleanName = text(item_name);
    const cleanReason = canonicalReason(reason);
    const qty = Math.max(1, num(quantity, 1));
    const reportType = reportTypeFrom({ redo: !!redo, reason: cleanReason });
    const estimatedValue = Math.max(0, num(total_price, 0));
    const tableName = text(table_number) || null;
    const safeItemType = text(item_type).toLowerCase() || null;

    const safeOrderId = order_id ? Number(order_id) : null;
    const safeMealId = meal_id ? Number(meal_id) : null;
    const safeMenuItemId = menu_item_id ? Number(menu_item_id) : null;
    const safeStockId = stock_id ? Number(stock_id) : null;
    const safeCategoryId = category_id ? Number(category_id) : null;
    const safeBatchId = isUuid(batch_id) ? String(batch_id) : null;

    if (!cleanName) {
      return res.status(400).json({ error: "item_name required" });
    }

    let stockRededucted = false;
    let deductionReport = { deducted: [], warnings: [] };

    console.log("REPORT PAYLOAD", {
      rid,
      safeOrderId,
      safeBatchId,
      tableName,
      safeMealId,
      safeMenuItemId,
      safeStockId,
      cleanName,
      safeItemType,
      safeCategoryId,
      qty,
      cleanReason,
      reportType,
      redo: !!redo,
      estimatedValue,
      userId,
    });

    await withTx(async (tx) => {
      if (!!redo) {
        if (safeMealId && safeMealId > 0) {
          deductionReport = await deductStockFromMealOrder(tx, safeMealId, qty, rid);
          stockRededucted = true;
        } else if (safeStockId && safeStockId > 0) {
          deductionReport = await deductStockByStockId(tx, safeStockId, qty, rid);
          stockRededucted = true;
        } else if (cleanName) {
          deductionReport = await deductStockByItemName(tx, cleanName, qty, rid);
          stockRededucted = true;
        } else {
          deductionReport = {
            deducted: [],
            warnings: ["No valid item reference for redo deduction"],
          };
          stockRededucted = false;
        }
      }

      console.log("REPORT INSERT VALUES", {
        restaurant_id: rid,
        order_id: safeOrderId,
        batch_id: safeBatchId,
        table_number: tableName,
        meal_id: safeMealId,
        menu_item_id: safeMenuItemId,
        stock_id: safeStockId,
        item_name: cleanName,
        item_type: safeItemType,
        category_id: safeCategoryId,
        quantity: qty,
        reason: cleanReason,
        report_type: reportType,
        redo: !!redo,
        waste_counted: true,
        stock_rededucted: stockRededucted,
        estimated_value: estimatedValue,
        reported_by: req.user?.full_name || req.user?.username || "Staff",
        reported_by_user_id: userId,
      });

      if (kind === "pg") {
        await tx.qRun(
          `
          INSERT INTO public.reports (
            restaurant_id,
            order_id,
            batch_id,
            table_number,
            meal_id,
            menu_item_id,
            stock_id,
            item_name,
            item_type,
            category_id,
            quantity,
            reason,
            report_type,
            redo,
            waste_counted,
            stock_rededucted,
            estimated_value,
            reported_by,
            reported_by_user_id,
            created_at
          )
          VALUES (
            $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
          )
          `,
          [
            rid,
            safeOrderId,
            safeBatchId,
            tableName,
            safeMealId,
            safeMenuItemId,
            safeStockId,
            cleanName,
            safeItemType,
            safeCategoryId,
            qty,
            cleanReason,
            reportType,
            !!redo,
            true,
            stockRededucted,
            estimatedValue,
            req.user?.full_name || req.user?.username || "Staff",
            userId,
          ]
        );
      } else {
        await tx.qRun(
          `
          INSERT INTO reports (
            restaurant_id,
            order_id,
            batch_id,
            table_number,
            meal_id,
            menu_item_id,
            stock_id,
            item_name,
            item_type,
            category_id,
            quantity,
            reason,
            report_type,
            redo,
            waste_counted,
            stock_rededucted,
            estimated_value,
            reported_by,
            reported_by_user_id,
            created_at
          )
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          `,
          [
            rid,
            safeOrderId,
            safeBatchId,
            tableName,
            safeMealId,
            safeMenuItemId,
            safeStockId,
            cleanName,
            safeItemType,
            safeCategoryId,
            qty,
            cleanReason,
            reportType,
            !!redo ? 1 : 0,
            1,
            stockRededucted ? 1 : 0,
            estimatedValue,
            req.user?.full_name || req.user?.username || "Staff",
            userId,
          ]
        );
      }
    });

    await audit(
      req,
      "KDS_ITEM_REPORTED",
      {
        order_id: safeOrderId,
        batch_id: safeBatchId,
        table_number: tableName,
        item_name: cleanName,
        item_type: safeItemType,
        category_id: safeCategoryId,
        quantity: qty,
        reason: cleanReason,
        report_type: reportType,
        redo: !!redo,
        stock_rededucted: stockRededucted,
        deductionReport,
      },
      { entity: "report", entity_id: String(safeOrderId || cleanName) }
    );

    return res.json({
      success: true,
      report_type: reportType,
      stock_rededucted: stockRededucted,
      deductionReport,
    });
  } catch (e) {
    console.error("REPORTS create error:", e);
    return res.status(500).json({
      error: "Server error",
      detail: e?.message || String(e),
    });
  }
});

module.exports = router;