/**
 * routes/invoiceRoutes.js (POSTGRES ONLY, multi-tenant safe)
 * Endpoints:
 *  - POST /invoices/scan-preview   (upload field: "invoice")  => OCR + parse => items for review
 *  - POST /invoices/save          (body items)               => save invoice + apply to stock/prices
 *  - GET  /invoices
 *  - GET  /invoices/:id
 *  - DELETE /invoices/:id
 */

const express = require("express");
const router = express.Router();

const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");

const multer = require("multer");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");

const pdfParse = require("pdf-parse");

const { authenticateToken } = require("../middleware/authMiddleware");
const { detectAllergenCodesFromName } = require("../utils/novaAllergens");
// ✅ IMPORTANT: Postgres wrapper (change file if needed)
const db = require("../db"); // must expose qAll/qGet/qRun for PG
const qAll = db.qAll || db.allAsync || db.all;
const qGet = db.qGet || db.getAsync || db.get;
const qRun = db.qRun || db.runAsync || db.run;

if (!qAll || !qGet || !qRun) {
  throw new Error("invoiceRoutes: DB wrapper missing qAll/qGet/qRun (Postgres required).");
}

// ---------- Optional NovaParser ----------
let NovaParser = null;
try {
  NovaParser = require("../utils/novaParser");
} catch (_) {
  NovaParser = null;
}

// ---------- Storage ----------
const uploadsRoot = path.join(process.cwd(), "uploads");
const invoicesDir = path.join(uploadsRoot, "invoices");
fs.mkdirSync(invoicesDir, { recursive: true });

// Multer in-memory upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const ok = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/tiff",
      "application/pdf",
    ].includes(file.mimetype);
    if (!ok) return cb(new Error("Unsupported file type"));
    cb(null, true);
  },
});

const uid = (len = 12) => crypto.randomBytes(len).toString("hex");
const safe = (s) => (s == null ? null : String(s).trim() || null);

function asNumber(n, def = null) {
  const v = Number(n);
  return Number.isFinite(v) ? v : def;
}



// Minimal fallback parser (keeps description as full product name)
function fallbackParseItemsFromText(text = "") {
  const lines = String(text).split(/\r?\n/);
  const items = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
if (/subtotal|total|vat|amount due|balance|minimum order/i.test(line)) {
  continue;
}
    const mPrice = line.match(/([£$€]?\s?\d+(?:[\.,]\d{2})\b)/);
    if (!mPrice) continue;

    let qty = 1;
    let unit = "unit";

    const q1 = line.match(/\b(\d+(?:\.\d+)?)\s?(kg|g|l|ml|pcs?)\b/i);
    if (q1) {
      qty = asNumber(q1[1], 1) ?? 1;
      unit = String(q1[2]).toLowerCase();
      if (unit === "pcs") unit = "pc";
    }

    let product_name = line
      .replace(mPrice[1], "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!product_name) continue;

    const priceRaw = mPrice[1].replace(/[£$€\s]/g, "").replace(",", ".");
    const price = asNumber(priceRaw, 0) ?? 0;

    items.push({
      product_name,           // ✅ FULL stock key
      quantity: qty,
      unit,
      price,
      type: "ingredient",
      category: "General",
      allergens: "None",
    });
  }

  return { items, meta: { parser: "fallback", confidence: 0.3 } };
}

async function extractTextFromPdfBuffer(buffer) {
  try {
    const parsed = await pdfParse(buffer);
    return String(parsed?.text || "").trim();
  } catch (err) {
    console.error("❌ PDF text extraction failed:", err.message);
    return "";
  }
}

async function prepareOcrPng(buffer, mimetype) {
  const isPdf = mimetype === "application/pdf";

  try {
    const img = sharp(buffer, isPdf ? { pages: 1, density: 300 } : {});

    return await img
      .rotate()
      .resize({ width: 2400, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(170)
      .png()
      .toBuffer();
  } catch (e) {
    if (isPdf) {
      throw new Error("PDF support not available. Convert to image and retry.");
    }
    throw e;
  }
}

async function ocrImageBuffer(pngBuffer) {
  const { data } = await Tesseract.recognize(pngBuffer, "eng", {
    tessedit_pageseg_mode: "11",
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789£.,-/() xX",
  });

  return (data?.text || "").trim();
}

function normText(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normCode(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/['"`]/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .trim();
}

async function detectPlatformSupplierFromText(rawText) {
  const txt = normText(rawText);

  const suppliers = await qAll(`
    SELECT id, name, slug
    FROM public.platform_suppliers
    WHERE is_active = TRUE
    ORDER BY id ASC
  `);

  for (const s of suppliers || []) {
    const name = normText(s.name);
    const slug = normText(s.slug);

    const aliases = [
      name,
      slug,
      name.replace("freshgo zampa", "zampa"),
      name.replace("freshgo zampa", "freshgo"),
      "zampa",
      "freshgo",
      "zampa fish",
    ].filter(Boolean);

    if (aliases.some((a) => a && txt.includes(a))) {
      return s;
    }
  }

  return null;
}

async function enrichItemsWithPlatformCatalogue(rawText, parsedItems = []) {
  const supplier = await detectPlatformSupplierFromText(rawText);

  if (!supplier?.id) {
    return {
      platform_supplier: null,
      items: parsedItems,
      catalogue_matches: [],
    };
  }

  const catalogue = await qAll(
    `
    SELECT
      id,
      product_code,
      unit_of_order_code,
      product_name,
      quantity_type,
      product_group,
      marketplace_category,
      price
    FROM public.platform_supplier_products
    WHERE platform_supplier_id = $1
      AND is_active = TRUE
      AND product_code IS NOT NULL
      AND TRIM(product_code) <> ''
    `,
    [Number(supplier.id)]
  );

  const rawLines = String(rawText || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const matchedByCode = new Map();

 for (const p of catalogue || []) {
  const code = normCode(p.product_code);
  if (!code) continue;

  if (code.length < 4 && !/^[A-Z]\d{2,}$/.test(code)) continue;

  const variants = Array.from(
    new Set([
      code,
      code.replace(/O/g, "0"),
      code.replace(/0/g, "O"),
      code.replace(/I/g, "1"),
      code.replace(/1/g, "I"),
      code.replace(/S/g, "5"),
      code.replace(/5/g, "S"),
    ])
  );

const hitLine = rawLines.find((line) => {
  const lineNorm = normCode(line);

  const tokens = String(line || "")
    .split(/\s+/)
    .map(normCode)
    .filter((t) => t.length >= 3 && t.length <= 40);

  return variants.some((v) => {
    if (!v || v.length < 3) return false;

    return (
      tokens.includes(v) ||
      lineNorm.startsWith(v) ||
      lineNorm.includes(v)
    );
  });
});

  if (!hitLine) continue;

  matchedByCode.set(code, {
    ...p,
    matched_line: hitLine,
    normalised_code: code,
  });
}

const bestByLine = new Map();

for (const match of matchedByCode.values()) {
  const lineKey = String(match.matched_line || "").trim();
  const existing = bestByLine.get(lineKey);

  const currentCodeLength = normCode(match.product_code).length;
  const existingCodeLength = existing ? normCode(existing.product_code).length : 0;

  if (!existing || currentCodeLength > existingCodeLength) {
    bestByLine.set(lineKey, match);
  }
}

matchedByCode.clear();

for (const match of bestByLine.values()) {
  matchedByCode.set(normCode(match.product_code), match);
}

  console.log("🧠 Platform supplier:", supplier?.name || "-");
console.log("🧠 Catalogue matches:", Array.from(matchedByCode.values()).map(x => ({
  code: x.product_code,
  name: x.product_name,
  line: x.matched_line,
})));

  const enriched = [];
  const usedCodes = new Set();

  for (const item of parsedItems || []) {
    const itemText = `${item.product_name || ""} ${item.description || ""} ${item.name || ""}`;
    const itemNorm = normCode(itemText);

    const match = Array.from(matchedByCode.values()).find((p) =>
      itemNorm.includes(p.normalised_code)
    );

    if (match) {
      usedCodes.add(match.normalised_code);

      enriched.push({
        ...item,
        product_name: match.product_name,
        description: match.product_name,
        supplier_product_code: match.product_code,
        supplier_unit_code: match.unit_of_order_code,
        quantity_type: match.quantity_type,
        category: match.marketplace_category || item.category || "General",
        product_group: match.product_group,
        price: match.price != null ? Number(match.price) : item.price,
        platform_supplier_id: Number(supplier.id),
        platform_supplier_name: supplier.name,
        catalogue_match: true,
        catalogue_match_confidence: "code",
        matched_line: match.matched_line,
      });
    } else {
      enriched.push(item);
    }
  }

  for (const match of matchedByCode.values()) {
    if (usedCodes.has(match.normalised_code)) continue;

    enriched.push({
      product_name: match.product_name,
      description: match.product_name,
      supplier_product_code: match.product_code,
      supplier_unit_code: match.unit_of_order_code,
      quantity: 1,
      qty: 1,
      quantity_parsed: 1,
      unit: match.quantity_type || "unit",
      price: match.price != null ? Number(match.price) : 0,
      type: "ingredient",
      category: match.marketplace_category || "General",
      product_group: match.product_group,
      allergens: "None",
      platform_supplier_id: Number(supplier.id),
      platform_supplier_name: supplier.name,
      catalogue_match: true,
      catalogue_match_confidence: "code",
      matched_line: match.matched_line,
    });
  }

  return {
    platform_supplier: {
      id: Number(supplier.id),
      name: supplier.name,
      slug: supplier.slug,
    },
    items: enriched,
    catalogue_matches: Array.from(matchedByCode.values()),
  };
}

// ---------- Suppliers ----------
async function ensureSupplier(rid, supplierName) {
  const name = safe(supplierName);
  if (!name) return { supplier_id: null, supplier_name: null };

  const found = await qGet(
    `SELECT id
       FROM suppliers
      WHERE restaurant_id = $1
        AND LOWER(TRIM(name)) = LOWER(TRIM($2))
      LIMIT 1`,
    [rid, name]
  );

  if (found?.id) return { supplier_id: found.id, supplier_name: name };

  const ins = await qRun(
    `INSERT INTO suppliers (restaurant_id, name, created_at)
     VALUES ($1, $2, NOW())
     RETURNING id`,
    [rid, name]
  );

  const newId = ins?.rows?.[0]?.id;
  return { supplier_id: newId || null, supplier_name: name };
}

// ---------- Invoices ----------
async function saveInvoiceRow(rid, payload) {
  const p = payload || {};
  const itemsJson = p.items_json ? JSON.stringify(p.items_json) : null;

  const r = await qRun(
    `INSERT INTO invoices
      (restaurant_id, supplier_name, invoice_number, invoice_date,
       raw_text, items_json, total, currency, status, file_url, thumb_url, created_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     RETURNING id`,
    [
      rid,
      safe(p.supplier_name),
      safe(p.invoice_number),
      safe(p.invoice_date),
      safe(p.raw_text),
      itemsJson,
      asNumber(p.total, null),
      safe(p.currency) || "GBP",
      safe(p.status) || "draft",
      safe(p.file_url),
      safe(p.thumb_url),
    ]
  );

  return r?.rows?.[0]?.id;
}

// ---------- Stock & Supplier Prices ----------
async function persistItemsToInventory(rid, items = [], supplier_id = null, supplier_name = null) {
  let stock_updates = 0;
  let price_updates = 0;

  for (const it of items) {
    const product = safe(it.product_name || it.ingredient || it.name || it.description);
    if (!product) continue;

    const qty = asNumber(it.quantity, 0) ?? 0;
    const unit = safe(it.unit) || "unit";
    const price = asNumber(it.price, 0) ?? 0;

    const type = safe(it.type) || "ingredient";
    const category = safe(it.category) || "General";
    const allergens = safe(it.allergens) || "None";

    // ✅ Upsert stock by (restaurant_id, ingredient) — FULL NAME KEY
    await qRun(
      `INSERT INTO stock
        (restaurant_id, ingredient, quantity, unit, price, allergens, supplier_id, category, type, updated_at, created_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
       ON CONFLICT (restaurant_id, ingredient)
       DO UPDATE SET
         quantity   = stock.quantity + EXCLUDED.quantity,
         unit       = COALESCE(EXCLUDED.unit, stock.unit),
         price      = EXCLUDED.price,
         allergens  = COALESCE(NULLIF(EXCLUDED.allergens,''), stock.allergens),
         supplier_id= COALESCE(EXCLUDED.supplier_id, stock.supplier_id),
         category   = COALESCE(EXCLUDED.category, stock.category),
         type       = COALESCE(EXCLUDED.type, stock.type),
         updated_at = NOW()`,
      [rid, product, qty, unit, price, allergens, supplier_id, category, type]
    );

    stock_updates++;

    // ✅ supplier price tracking (if supplier known)
    if ((supplier_id || supplier_name) && price > 0) {
      await qRun(
        `INSERT INTO supplier_prices
          (restaurant_id, supplier_id, supplier_name, ingredient, price, date)
         VALUES
          ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (restaurant_id, supplier_id, ingredient)
         DO UPDATE SET price = EXCLUDED.price, date = NOW()`,
        [rid, supplier_id, supplier_name, product, price]
      );
      price_updates++;
    }
  }

  return { stock_updates, price_updates };
}

// -------------------- ROUTES --------------------

// ✅ POST /invoices/scan-preview  (field "invoice")
router.post(
  "/scan-preview",
  authenticateToken,
  upload.single("invoice"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'No file uploaded (field name must be "invoice")',
        });
      }

      const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
      if (!rid) {
        return res.status(403).json({ error: "Missing tenant restaurant_id" });
      }

      const { originalname, mimetype, buffer } = req.file;

      let raw_text = "";
let ocrPng = null;

if (mimetype === "application/pdf") {
  raw_text = await extractTextFromPdfBuffer(buffer);
}

if (!raw_text || raw_text.length < 30) {
  ocrPng = await prepareOcrPng(buffer, mimetype);
  raw_text = await ocrImageBuffer(ocrPng);
}

      console.log("🧾 OCR TEXT PREVIEW:", raw_text.slice(0, 1500));

      let parsed;
      if (NovaParser?.extract) {
        try {
          parsed = await NovaParser.extract(raw_text, { fallback: true });
        } catch (e) {
          parsed = fallbackParseItemsFromText(raw_text);
        }
      } else {
        parsed = fallbackParseItemsFromText(raw_text);
      }

      const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];

      const catalogueResult = await enrichItemsWithPlatformCatalogue(
        raw_text,
        rawItems
      );

      const catalogueItems =
        Array.isArray(catalogueResult?.items) && catalogueResult.items.length > 0
          ? catalogueResult.items
          : rawItems;

      const items = catalogueItems.map((it) => {
        const productName = safe(
          it.product_name || it.description || it.name || ""
        );

        const detected = detectAllergenCodesFromName(productName);

        const existingAllergens = safe(it.allergens || it.suggested_allergens);
        const allergens =
          !existingAllergens || existingAllergens.toLowerCase() === "none"
            ? detected.length
              ? detected.join(", ")
              : "None"
            : existingAllergens;

        return {
          ...it,
          product_name: productName,
          allergens,
          suggested_allergens: allergens,
        };
      });

      const base = `${Date.now()}_${uid(6)}`;
      const srcName = `${base}_${(originalname || "invoice").replace(
        /[^\w\.-]+/g,
        "_"
      )}`;
      const srcPath = path.join(invoicesDir, srcName);
      await fsp.writeFile(srcPath, buffer);

      const thumbName = `${base}_thumb.webp`;
      const thumbPath = path.join(invoicesDir, thumbName);
      if (ocrPng) {
  await sharp(ocrPng)
    .resize(640, 640, { fit: "inside" })
    .webp({ quality: 80 })
    .toFile(thumbPath);
} else {
  await sharp({
    create: {
      width: 640,
      height: 900,
      channels: 4,
      background: "#ffffff",
    },
  })
    .webp({ quality: 80 })
    .toFile(thumbPath);
}


      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      const file_url = `${proto}://${host}/uploads/invoices/${srcName}`;
      const thumb_url = `${proto}://${host}/uploads/invoices/${thumbName}`;

      return res.json({
        success: true,
        itemsAndPrices: items,
        draft: {
          supplier_name:
            parsed?.meta?.supplier_name ||
            catalogueResult?.platform_supplier?.name ||
            null,
          invoice_number: parsed?.meta?.invoice_number || null,
          invoice_date: parsed?.meta?.invoice_date || null,
          currency: parsed?.meta?.currency || "GBP",
          total: asNumber(parsed?.meta?.total, null),
          raw_text,
          file_url,
          thumb_url,
          items,
          parse_meta: parsed?.meta || {},
          platform_supplier: catalogueResult?.platform_supplier || null,
          catalogue_matches: catalogueResult?.catalogue_matches || [],
        },
        metadata: {
          textLength: raw_text.length,
          lines: raw_text ? raw_text.split(/\r?\n/).length : 0,
          catalogueMatches: catalogueResult?.catalogue_matches?.length || 0,
        },
      });
    } catch (err) {
      console.error("❌ /invoices/scan-preview failed:", err);
      const code = /Unsupported file type/i.test(err?.message) ? 400 : 500;
      return res.status(code).json({
        error: err?.message || "Invoice scan failed",
      });
    }
  }
);

// ✅ POST /invoices/save  (final apply)
router.post("/save", authenticateToken, async (req, res) => {
  try {
    const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
    if (!rid) return res.status(403).json({ error: "Missing tenant restaurant_id" });

    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];

    const { supplier_id, supplier_name } = await ensureSupplier(rid, body.supplier_name);

    const invoice_id = await saveInvoiceRow(rid, {
      supplier_name,
      invoice_number: body.invoice_number || null,
      invoice_date: body.invoice_date || null,
      raw_text: body.raw_text || null,
      items_json: items,
      total: asNumber(body.total, null),
      currency: body.currency || "GBP",
      status: "final",
      file_url: body.file_url || null,
      thumb_url: body.thumb_url || null,
    });

    const applied = await persistItemsToInventory(rid, items, supplier_id, supplier_name);

    return res.status(201).json({
      success: true,
      invoice_id,
      supplier_id,
      supplier_name,
      applied,
    });
  } catch (err) {
    console.error("❌ /invoices/save failed:", err);
    return res.status(500).json({ error: "Failed to save invoice" });
  }
});

// ✅ GET /invoices
router.get("/", authenticateToken, async (req, res) => {
  try {
    const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
    if (!rid) return res.status(403).json({ error: "Missing tenant restaurant_id" });

    const rows = await qAll(
      `SELECT id, supplier_name, invoice_number, invoice_date, total, currency, status, file_url, thumb_url, created_at
         FROM invoices
        WHERE restaurant_id = $1
        ORDER BY COALESCE(invoice_date, created_at) DESC, id DESC`,
      [rid]
    );

    return res.json(rows || []);
  } catch (err) {
    console.error("❌ GET /invoices failed:", err);
    return res.status(500).json({ error: "Failed to list invoices" });
  }
});

// ✅ GET /invoices/:id
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
    if (!rid) return res.status(403).json({ error: "Missing tenant restaurant_id" });

    const row = await qGet(
      `SELECT *
         FROM invoices
        WHERE id = $1 AND restaurant_id = $2`,
      [Number(req.params.id), rid]
    );

    if (!row) return res.status(404).json({ error: "Invoice not found" });

    try {
      row.items_json = row.items_json ? JSON.parse(row.items_json) : [];
    } catch {
      row.items_json = [];
    }

    return res.json(row);
  } catch (err) {
    console.error("❌ GET /invoices/:id failed:", err);
    return res.status(500).json({ error: "Failed to load invoice" });
  }
});

// ✅ DELETE /invoices/:id (does not reverse stock)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
    if (!rid) return res.status(403).json({ error: "Missing tenant restaurant_id" });

    const inv = await qGet(
      `SELECT file_url, thumb_url
         FROM invoices
        WHERE id = $1 AND restaurant_id = $2`,
      [Number(req.params.id), rid]
    );
    if (!inv) return res.status(404).json({ error: "Invoice not found" });

    await qRun(
      `DELETE FROM invoices WHERE id = $1 AND restaurant_id = $2`,
      [Number(req.params.id), rid]
    );

    // Best-effort file cleanup
    const toTry = [inv.file_url, inv.thumb_url].filter(Boolean);
    for (const url of toTry) {
      const idx = String(url).indexOf("/uploads/invoices/");
      if (idx !== -1) {
        const rel = String(url).slice(idx + "/uploads/invoices/".length);
        const abs = path.join(invoicesDir, rel);
        try { await fsp.unlink(abs); } catch {}
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ DELETE /invoices/:id failed:", err);
    return res.status(500).json({ error: "Failed to delete invoice" });
  }
});

module.exports = router;