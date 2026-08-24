const fs = require("fs");
const { execFile } = require("child_process");

async function extractLayoutText(pdfPath) {
  const outPath = `${pdfPath}.v2-layout.txt`;

  await new Promise((resolve, reject) => {
    execFile(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", pdfPath, outPath],
      (err) => (err ? reject(err) : resolve())
    );
  });

  const text = fs.readFileSync(outPath, "utf8");

  try {
    fs.unlinkSync(outPath);
  } catch {}

  return String(text || "").trim();
}

function splitIntoPages(rawText = "") {
  return String(rawText)
    .split("\f")
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitPageIntoColumns(page = "") {
  const left = [];
  const right = [];

  for (const line of page.split("\n")) {
    if (!line.trim()) continue;

    // Very large gap usually means two PDF columns.
    const parts = line.split(/\s{8,}/);

    if (parts[0]?.trim()) left.push(parts[0].trim());
    if (parts[1]?.trim()) right.push(parts[1].trim());
  }

  return {
    left,
    right,
  };
}

function isSizeOrColumnHeader(line = "") {
  const s = String(line || "").toLowerCase().trim();

  if (!s) return true;
  if (/^(125ml|175ml|200ml|250ml|25ml|50ml|330ml|500ml|half pint|pint|bottle|single|double)(\s+|$)/i.test(s)) return true;
  if (s.includes("125ml") || s.includes("175ml") || s.includes("25ml") || s.includes("50ml")) return true;
  if (s === "single double") return true;
  if (s === "half pint pint") return true;

  return false;
}

function isHeading(line = "") {
  const s = String(line || "").trim();

  if (!s) return false;
  if (s.length > 35) return false;
  if (/£\s*\d/.test(s)) return false;

  const upper = s.toUpperCase();

  // mostly uppercase = likely menu heading
  return upper === s && /[A-Z]/.test(s);
}

function guessType(name = "") {
  const s = String(name || "").toLowerCase();

  if (
    s.includes("wine") ||
    s.includes("vodka") ||
    s.includes("whiskey") ||
    s.includes("whisky") ||
    s.includes("rum") ||
    s.includes("brandy") ||
    s.includes("liqueur") ||
    s.includes("gin") ||
    s.includes("beer") ||
    s.includes("cider") ||
    s.includes("cocktail") ||
    s.includes("soft") ||
    s.includes("juice") ||
    s.includes("mixer") ||
    s.includes("coffee") ||
    s.includes("tea") ||
    s.includes("smoothie") ||
    s.includes("tonic") ||
    s.includes("champagne") ||
    s.includes("prosecco")
  ) {
    return "drinks";
  }

  if (s.includes("dessert") || s.includes("cake") || s.includes("ice cream")) {
    return "desserts";
  }

  return "meals";
}

function extractPrice(line = "") {
  const m = String(line || "").match(/£\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function parseMenuV2(rawText = "") {
  const pages = splitIntoPages(rawText);

  const categories = [];
  let current = null;
  let pendingName = null;

  const startCategory = (name) => {
    current = {
      name: String(name || "").trim(),
      type: guessType(name),
      items: [],
    };
    categories.push(current);
    pendingName = null;
  };

  const readLine = (line) => {
    const clean = String(line || "").replace(/\s+/g, " ").trim();
    if (!clean) return;

    if (isSizeOrColumnHeader(clean)) return;
    if (
      clean.includes("MILLIE") ||
      clean.includes("BEACH BAR") ||
      clean.toLowerCase().includes("restaurant")
    ) {
      return;
    }

    if (isHeading(clean)) {
      startCategory(clean.replace(/\b\w/g, (c) => c.toUpperCase()));
      return;
    }

    const price = extractPrice(clean);

    if (price != null) {
      const name = clean.replace(/£\s*\d+(?:\.\d{1,2})?.*$/, "").trim();

      if (name.length >= 3) {
        if (!current) startCategory("Menu");

        current.items.push({
          name,
          price,
          description: "",
          options_schema: [],
        });

        pendingName = null;
        return;
      }

      if (pendingName && current) {
        current.items.push({
          name: pendingName,
          price,
          description: "",
          options_schema: [],
        });
        pendingName = null;
      }

      return;
    }

    if (clean.length <= 80 && /^[A-Za-z0-9 "'’&.,()[\]-]+$/.test(clean)) {
      pendingName = clean;
    }
  };

  const document = pages.map((page, pageIndex) => {
    const cols = splitPageIntoColumns(page);

    cols.left.forEach(readLine);
    cols.right.forEach(readLine);

    return {
      page: pageIndex + 1,
      ...cols,
    };
  });

  return {
    document,
    categories: categories.filter((c) => c.items.length),
    debug: {
      pages: pages.length,
      categories: categories.length,
      items: categories.reduce((s, c) => s + c.items.length, 0),
    },
  };
}

async function parsePdfMenuV2(pdfPath) {
  const rawText = await extractLayoutText(pdfPath);
  return parseMenuV2(rawText);
}

module.exports = {
  parsePdfMenuV2,
};