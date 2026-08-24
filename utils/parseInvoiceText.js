// utils/parseInvoiceText.js
// Commercial-safe invoice line parser (packs + units-per-pack)
// Output shape matches your scanner: { description, base_ingredient, qty, quantity_parsed, unit, price, suggested_allergens, portions? }
const { detectAllergenCodesFromName } = require("./novaAllergens");

function toNum(x) {
  if (x == null) return null;
  const s = String(x).replace(/[£,$]/g, "").trim().replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const STOP_WORDS = [
  "subtotal", "sub total", "total", "vat", "tax", "delivery", "shipping",
  "discount", "change", "cash", "card", "balance", "amount due"
];

function isJunkLine(line) {
  const t = line.toLowerCase();
  if (!t) return true;
  if (STOP_WORDS.some(w => t.includes(w))) return true;
  // ignore very short numeric-only lines
  if (/^[\d\W]+$/.test(t)) return true;
  return false;
}

// Try to detect patterns like:
// "2 Coca Cola 24x330ml £26.50"
// "1 Beer Lager 24 x 330ml 21.99"
// "Red Bull 12x250ml £18.00"
// "Chopped Tomatoes 6x2.5kg £31.80"  (still works - pack size = 6, unit size = 2.5kg)
function parsePackInfo(text) {
  const raw = String(text || "").trim();

  const mQty = raw.match(/^\s*(\d+)\s+/);
  const qty = mQty ? Number(mQty[1]) : 1;

  const patterns = [
    /(\d+)\s*[xX]\s*([\d.]+)\s*(ml|gm|g|kg|ltr|litre|litres|l)\b/i,
    /\bx\s*([\d.]+)\s*(ml|gm|g|kg|ltr|litre|litres|l)\b/i,
  ];

  let unitsPerPack = null;
  let unitSize = null;
  let unitSizeUom = null;

  const m1 = raw.match(patterns[0]);
  if (m1) {
    unitsPerPack = Number(m1[1]);
    unitSize = Number(m1[2]);
    unitSizeUom = String(m1[3]).toLowerCase();
  } else {
    const m2 = raw.match(patterns[1]);
    if (m2) {
      unitsPerPack = 1;
      unitSize = Number(m2[1]);
      unitSizeUom = String(m2[2]).toLowerCase();
    }
  }

  if (unitSizeUom === "gm") unitSizeUom = "g";
  if (["ltr", "litre", "litres", "l"].includes(unitSizeUom)) unitSizeUom = "l";

  const mPcs = raw.match(/\b(\d+)\s*(pcs|pc)\b/i);
  const pcsCount = mPcs ? Number(mPcs[1]) : null;

  if (!unitsPerPack && pcsCount) {
    unitsPerPack = pcsCount;
  }

  let totalQuantity = null;
  let stockUnit = null;
  let displayQuantity = null;
  let displayUnit = null;

  if (unitsPerPack && unitSize && unitSizeUom) {
    if (unitSizeUom === "kg") {
      stockUnit = "g";
      totalQuantity = unitsPerPack * unitSize * 1000;
      displayQuantity = totalQuantity / 1000;
      displayUnit = "kg";
    } else if (unitSizeUom === "g") {
      stockUnit = "g";
      totalQuantity = unitsPerPack * unitSize;
      displayQuantity = totalQuantity >= 1000 ? totalQuantity / 1000 : totalQuantity;
      displayUnit = totalQuantity >= 1000 ? "kg" : "g";
    } else if (unitSizeUom === "l") {
      stockUnit = "ml";
      totalQuantity = unitsPerPack * unitSize * 1000;
      displayQuantity = totalQuantity / 1000;
      displayUnit = "L";
    } else if (unitSizeUom === "ml") {
      stockUnit = "ml";
      totalQuantity = unitsPerPack * unitSize;
      displayQuantity = totalQuantity >= 1000 ? totalQuantity / 1000 : totalQuantity;
      displayUnit = totalQuantity >= 1000 ? "L" : "ml";
    }
  }

  return {
    qty,
    unitsPerPack: unitsPerPack || null,
    unitSize: unitSize || null,
    unitSizeUom: unitSizeUom || null,
    totalQuantity,
    stockUnit,
    displayQuantity,
    displayUnit,
    packDescription:
      unitsPerPack && unitSize && unitSizeUom
        ? `${unitsPerPack} x ${unitSize}${unitSizeUom}`
        : null,
  };
}

function extractMoney(line) {
  const matches = String(line).match(/(?:£\s*)?\d+(?:[.,]\d{2})\b/g);
  if (!matches || matches.length === 0) return { unit_price: null, line_total: null };

  const nums = matches.map(m => toNum(m)).filter(v => v != null);
  if (nums.length === 1) return { unit_price: nums[0], line_total: nums[0] };

  // Most invoices end with: UNIT PRICE then LINE TOTAL
  const line_total = nums[nums.length - 1];
  const unit_price = nums[nums.length - 2];
  return { unit_price, line_total };
}

function cleanBaseName(line) {
  return String(line)
    .replace(/(?:£\s*)?\d+(?:[.,]\d{2})\b/g, "")          // remove money
    .replace(/\b\d+\s*x\s*\d+(?:\.\d+)?\s*(ml|l|g|kg)\b/gi, "") // remove 24x330ml etc
    .replace(/\b\d+\s*(pcs|pc)\b/gi, "")                 // remove 180pcs
    .replace(/^\s*\d+\s+/, "")                           // remove leading qty
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeBaseIngredient(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseInvoiceText(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const out = [];

  for (const line of lines) {
    if (isJunkLine(line)) continue;

const { unit_price, line_total } = extractMoney(line);    // allow lines without price IF they clearly have pack info; but most invoices have price per line
    const pack = parsePackInfo(line);

    const baseName = cleanBaseName(line);
    const base_ingredient = normalizeBaseIngredient(baseName);

    if (!base_ingredient) continue;

    // Decide unit:
    // If we detected unitsPerPack => we’re selling single pieces/cans
    const unit = pack.unitsPerPack ? "pc" : "unit";

    // qty = packs, quantity_parsed = units per pack
let qty = pack.qty || 1;

// ✅ If OCR qty is wrong/missing but prices exist, infer qty
if (unit_price && line_total) {
  const est = line_total / unit_price;
  const rounded = Math.round(est);

  // only accept if it's clearly an integer qty
  if (rounded > 0 && Math.abs(est - rounded) < 0.06) {
    qty = rounded;
  }
}    const quantity_parsed = pack.unitsPerPack || 1;

    // If there is no price AND it doesn't look meaningful, skip
if (unit_price == null && line_total == null && quantity_parsed === 1 && qty === 1) continue;

const allergenCodes = detectAllergenCodesFromName(baseName);
const suggestedAllergens = allergenCodes.length ? allergenCodes.join(", ") : "None";

    out.push({
  description: line,
  base_ingredient,
  qty,
  quantity_parsed,
  unit,
  unit_size: pack.unitSize || null,
  unit_size_uom: pack.unitSizeUom || null,

  pack_count: pack.unitsPerPack || null,
pack_description: pack.packDescription || null,
total_quantity: pack.totalQuantity || null,
stock_unit: pack.stockUnit || null,
display_quantity: pack.displayQuantity || null,
display_unit: pack.displayUnit || null,

  price: unit_price ?? line_total ?? null,
  line_total: line_total ?? null,
  unit_price: unit_price ?? null,
  suggested_allergens: suggestedAllergens,
});
  }

  return out;
}

module.exports = parseInvoiceText;
module.exports.parseInvoiceText = parseInvoiceText;