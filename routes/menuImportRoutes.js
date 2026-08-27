const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");
const { execFile } = require("child_process");

const router = express.Router();

const {
  withTx,
} = require("../dbCompat");

const {
  emitMenuCatalogSnapshotTx,
} = require("../edge/contracts/menuCatalog");

const {
  MaksRuntimeRoleError,
  assertCloudRuntime,
} = require("../utils/runtimeRole");

const { parsePdfMenuV2 } = require("../utils/menuImporterV2");

function sendMenuImportAuthorityError(res, error) {
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

function requireCloudMenuImportAuthority(req, res, next) {
  try {
    assertCloudRuntime();
    next();
  } catch (error) {
    if (sendMenuImportAuthorityError(res, error)) {
      return;
    }
    next(error);
  }
}

async function extractTextWithPdfLayout(pdfPath) {
  const outPath = `${pdfPath}.layout.txt`;

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

async function extractTextWithOCR(pdfPath) {
  const outputDir = path.join(
    uploadsDir,
    `ocr-${Date.now()}`
  );

  fs.mkdirSync(outputDir, { recursive: true });

  await new Promise((resolve, reject) => {
  execFile(
    "pdftoppm",
    ["-png", "-r", "200", pdfPath, path.join(outputDir, "page")],
    (err) => (err ? reject(err) : resolve())
  );
});

  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith(".png"))
    .sort();

  let combinedText = "";

  for (const file of files) {
    const imagePath = path.join(outputDir, file);

    const result = await Tesseract.recognize(imagePath, "eng");

combinedText += "\n" + (result?.data?.text || "");
  }

  return combinedText;
}

const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".pdf";
      const base = path
        .basename(file.originalname, ext)
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "-")
        .slice(0, 60);

      cb(null, `${Date.now()}-${base}${ext}`);
    },
  }),
limits: { fileSize: 50 * 1024 * 1024 }
});

function guessType(sectionName = "") {
  const s = String(sectionName || "").toLowerCase();

  const drinkSectionNames = [
  "white wine",
  "red wine",
  "rosé wine",
  "rose wine",
  "sparkling wines",
  "champagne",
  "vodka",
  "whiskey",
  "whisky",
  "liqueur",
  "liquer",
  "brandy",
  "rum",
  "spirit mixers",
  "whitley neill",
  "fever tree tonic",
  "draft beer",
  "bottled beer",
  "bottled cider",
  "alcohol free",
  "cocktail jugs",
  "cocktails",
  "soft drinks",
  "post mix",
  "juices",
  "bar mixers",
  "ice cold",
  "smoothie",
  "coffee",
  "tea",
];

if (drinkSectionNames.includes(s.trim())) {
  return "drinks";
}

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
    s.includes("soft drink") ||
    s.includes("post mix") ||
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

  if (
    s.includes("dessert") ||
    s.includes("sweet") ||
    s.includes("cake") ||
    s.includes("ice cream")
  ) {
    return "desserts";
  }

  return "meals";
}

function splitLineIntoItems(line = "") {
  const text = String(line || "")
    .replace(/\s+/g, " ")
    .replace(/£\s+/g, "£")
    .trim();

  const matches = [...text.matchAll(/(.+?)\s*£\s*(\d+(?:\.\d{1,2})?)/g)];

  if (matches.length <= 1) return null;

  return matches
    .map((m) => ({
      name: String(m[1] || "")
        .replace(/^\s*[,+-]\s*/, "")
        .replace(/\s+/g, " ")
        .trim(),
      price: Number(m[2] || 0),
    }))
    .filter((x) => x.name && x.price > 0);
}

function normaliseSectionName(line = "", expectedSections = []) {
  const raw = String(line || "").replace(/\s+/g, " ").trim();
  const s = raw.toUpperCase();

  for (const section of expectedSections || []) {
    const cleanSection = String(section || "").replace(/\s+/g, " ").trim();
    if (!cleanSection) continue;

    if (s.includes(cleanSection.toUpperCase())) {
      return cleanSection;
    }
  }

  if (s.includes("SMALL PLATES")) return "Small Plates";
  if (s.includes("SALADS")) return "Salads";
  if (s.includes("SIDES")) return "Sides";
  if (s.includes("FRIED SEAFOOD")) return "Fried Seafood";
  if (s.includes("GRILLED SEAFOOD")) return "Grilled Seafood";
  if (s.includes("KITCHEN & GRILL")) return "Kitchen & Grill";
  if (s.includes("MILLIES BURGERS")) return "Millies Burgers";
if (s === "BURGERS") return "Burgers";
  if (s.includes("MOVING MOUNTAINS")) return "Moving Mountains";
  if (s.includes("TOASTED PANINIS") || s.includes("PANINIS")) return "Toasted Paninis";
  if (s.includes("JACKET POTATOES")) return "Jacket Potatoes";
  if (s.includes("KIDS MEALS") || s.includes("KIDS")) return "Kids Meals";

  if (s.includes("WHITE WINE") || s.includes("WHITE WINES")) return "White Wine";
  if (s.includes("RED WINE") || s.includes("RED WINES")) return "Red Wine";
  if (s.includes("ROSÉ WINE") || s.includes("ROSE WINE") || s.includes("ROSÉ WINES") || s.includes("ROSE WINES")) return "Rosé Wine";
  if (s.includes("SPARKLING WINES")) return "Sparkling Wines";
  if (s.includes("CHAMPAGNE")) return "Champagne";
  if (s.includes("VODKA")) return "Vodka";
  if (s.includes("WHISKEY") || s.includes("WHISKY")) return "Whiskey";
  if (s.includes("LIQUER") || s.includes("LIQUEUR")) return "Liqueur";
  if (s.includes("BRANDY")) return "Brandy";
if (s === "RUM") return "Rum";
  if (s.includes("SPIRITS")) return "Spirits";
  if (s.includes("MINERALS")) return "Minerals";
  if (s.includes("LAGER") || s.includes("BITTER") || s.includes("CIDER")) return "Lager, Bitter & Cider";
  if (s.includes("COFFEE")) return "Coffee";
if (s === "TEA") return "Tea";
  if (s.includes("SMOOTHIE")) return "Smoothie";
if (s === "DESSERTS" || s === "DESSERT") return "Desserts";
if (
  s === "ICE CREAM & SUNDAES" ||
  s === "ICE CREAM AND SUNDAES" ||
  s === "SUNDAES"
) {
  return "Ice Cream & Sundaes";
}
  return null;
}

function extractOptionFromLine(line = "") {
  const raw = String(line || "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();

  if (
    !lower.includes("served with") &&
    !lower.includes("choice of") &&
    !lower.includes("choose") &&
    !lower.includes("either")
  ) {
    return null;
  }

  let text = raw
    .replace(/^.*?served with\s+/i, "")
    .replace(/^.*?choice of\s+/i, "")
    .replace(/^.*?choose\s+/i, "")
    .replace(/^.*?either\s+/i, "")
    .replace(/\.$/, "")
    .trim();

  const isChoiceSentence =
    lower.includes("choice of") ||
    lower.includes("choose") ||
    lower.includes("either");

  let choices = [];

  if (isChoiceSentence) {
    choices = text.split(/\s*,\s*|\s+or\s+|\s+and\s+/i);
  } else if (/\s+or\s+/i.test(text)) {
    const [beforeOr, afterOr] = text.split(/\s+or\s+/i);
    const beforeParts = beforeOr.split(",").map((x) => x.trim()).filter(Boolean);

    let leftChoice = beforeParts[beforeParts.length - 1] || "";
    let rightChoice = afterOr.trim();

    const suffix = rightChoice.split(" ").slice(-1)[0];

    if (
      suffix &&
      leftChoice &&
      !leftChoice.toLowerCase().includes(suffix.toLowerCase())
    ) {
      leftChoice = `${leftChoice} ${suffix}`;
    }

    choices = [leftChoice, rightChoice];
  }

  choices = choices
    .map((x) =>
      String(x || "")
        .replace(/homemade|house|a choice of|and a choice of/gi, "")
        .trim()
    )
    .filter((x) => x.length >= 3 && x.length <= 35);

  if (choices.length < 2) return null;

  return {
    id: `choice_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    key: "choice",
    label: "Choice",
    type: "single",
    required: true,
    choices: choices.map((label) => ({
      id: label.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""),
      label,
      priceDelta: 0,
    })),
  };
}

function cleanImportedMenu(categories = []) {
  const order = [
  "Small Plates",
  "Salads",
  "Sides",
  "Fried Seafood",
  "Grilled Seafood",
  "Kitchen & Grill",
  "Millies Burgers",
  "Moving Mountains",
  "Toasted Paninis",
  "Jacket Potatoes",
  "Kids Meals",

  "White Wine",
  "Red Wine",
  "Rosé Wine",
  "Sparkling Wines",
  "Champagne",
  "Vodka",
  "Whiskey",
  "Liqueur",
  "Brandy",
  "Rum",
  "Spirit Mixers",
  "Whitley Neill",
  "Fever Tree Tonic",
  "Draft Beer",
  "Bottled Beer",
  "Bottled Cider",
  "Alcohol Free",
  "Cocktail Jugs",
  "Cocktails",
  "Soft Drinks",
  "Post Mix",
  "Juices",
  "Bar Mixers",
  "Ice Cold",
  "Smoothie",
  "Coffee",
  "Tea",
];

  const map = new Map();

  for (const cat of categories || []) {
    const name = cleanName(cat.name || "Menu");
    const items = Array.isArray(cat.items) ? cat.items : [];

    if (!name || !items.length) continue;

    const key = name.toLowerCase();

    if (!map.has(key)) {
      map.set(key, {
        ...cat,
        name,
        type: guessType(name),
        items: [],
      });
    }

    map.get(key).items.push(...items);
  }

  const merged = Array.from(map.values());

  return merged.sort((a, b) => {
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);

    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;

    return ai - bi;
  });
}

function cleanDrinkMenu(categories = []) {
  const moveRules = [
    { cat: "White Wine", words: ["gavi", "sauvignon blanc", "pellehaut white", "roos estate", "house white"] },
    { cat: "Red Wine", words: ["rioja", "pellehaut red", "malbec", "shiraz", "house red"] },
{ cat: "Rosé Wine", words: ["pellehaut rosé", "pellehaut rose", "zinfandel blush", "house rosé", "house rose"] },
    { cat: "Sparkling Wines", words: ["prosecco"] },
    { cat: "Champagne", words: ["moët", "veuve", "laurent", "house champagne"] },
    { cat: "Whiskey", words: ["jack daniel", "jameson", "bell", "southern comfort"] },
    { cat: "Brandy", words: ["courvoisier", "hennessy", "brandy"] },
    { cat: "Fever Tree Tonic", words: ["slim line", "light tonic", "elderflower", "ginger ale", "classic, premium indian"] },
    { cat: "Cocktails", words: ["bloody mary", "piña colada", "pina colada", "espresso martini", "classic mojito"] },
    { cat: "Cocktail Jugs", words: ["aperol spritz jug", "pimms jug"] },
    { cat: "Bar Mixers", words: ["lime & soda", "lime cordial", "blackcurrant [100ml]", "spirit mixers"] },
    { cat: "Post Mix", words: ["diet coke", "lemonade", "soda"] },
    { cat: "Ice Cold", words: ["j2o", "blackcurrant squash", "fruit shoot"] },
    { cat: "Tea", words: ["breakfast tea", "decaf tea", "peppermint", "earl grey", "chamomile", "green tea", "red berry", "fresh lemon"] },
  ];

  const out = new Map();

  const ensure = (name) => {
    const key = String(name || "Menu").toLowerCase();
    if (!out.has(key)) {
      out.set(key, {
        name,
        type: "drinks",
        options_schema: [],
        items: [],
      });
    }
    return out.get(key);
  };

  for (const cat of categories || []) {
    for (const item of cat.items || []) {
      const itemName = String(item.name || "").toLowerCase();

      const rule = moveRules.find((r) =>
        r.words.some((w) => itemName.includes(w))
      );

      const targetName = rule?.cat || cat.name;
      ensure(targetName).items.push(item);
    }
  }

  return cleanImportedMenu(
    Array.from(out.values()).filter((cat) => cat.items.length)
  );
}

function parseMenuText(rawText = "", config = {}) {
  const menuType = String(config.menuType || "mixed").toLowerCase();
  const priceMode = String(config.priceMode || "mixed").toLowerCase();
  const expectedSections = Array.isArray(config.expectedSections)
    ? config.expectedSections
    : [];
      const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const knownSections = [
    "SMALL PLATES",
    "SALADS",
    "SIDES",
    "FRIED SEAFOOD",
    "GRILLED SEAFOOD",
    "KITCHEN & GRILL",
    "MILLIES BURGERS",
    "MOVING MOUNTAINS",
    "TOASTED PANINIS",
    "JACKET POTATOES",
    "KIDS MEALS",
  ];

  const ignoreLines = [
    "Beach Bar & Restaurant",
    "All served",
    "Served with",
    "Experience the taste",
    "Can’t decide",
    "Can't decide",
    "A refined selection",
    "During peak",
    "Standard Wait Time",
    "Peak Times",
    "Large Groups",
    "Allergen Information",
    "Our chefs",
    "With ",
"Marinated ",
"Cooked ",
"Light ",
"Mixed salad",
"Serves two",
"Smaller portions",
"Enjoy ",
"Indulge ",
"Please ",
"The above",
"UPGRADE ",
"or make",
"or upgrade",
"ADD ",
"SWAP ",
"WANT EXTRA",
"HAVE A LOOK",
"GET SAUCY",
"Adults need",
  ];

  const sections = [];
let current = {
  name: "Menu",
  type: "meals",
  options_schema: [],
  items: [],
};
  let fixedPrice = null;

  let lastItem = null;

  let pendingItemName = null;
  const pushCurrent = () => {
    if (current.items.length) sections.push(current);
  };

  const setSection = (name) => {
    pushCurrent();
    current = {
  name,
  type: guessType(name),
  options_schema: [],
  items: [],
};
    fixedPrice = null;
  };

 const addItem = (name, price) => {
  const clean = String(name || "")
    .replace(/^NEW!?/i, "")
    .replace(/[•★]/g, "")
    .trim();

  if (!clean || clean.length < 3) return;

  const item = {
    name: clean,
    price: Number(price || 0),
    description: "",
    options_schema: [],
  };

  current.items.push(item);
  lastItem = item;
  pendingItemName = null;
};

  const priceAtEnd = /(.*?)\s*£\s*(\d+(?:\.\d{1,2})?)\s*$/;
  const priceAtStart = /^£\s*(\d+(?:\.\d{1,2})?)\s+(.*)$/;
  const fixedEach = /£\s*(\d+(?:\.\d{1,2})?)\s*(?:EACH|Kids Meals)/i;
const plainPriceAtEnd = /(.*?)\s+(\d+(?:\.\d{1,2}))\s*$/;
const addOnPriceOnly = /^\+?\d+(?:\.\d{1,2})$/;

  for (const raw of lines) {
    const line = raw.trim();
    const upper = line.toUpperCase();

    const option = extractOptionFromLine(line);
if (option) {
  const lower = line.toLowerCase();

  if (lower.startsWith("all served") || lower.startsWith("the above")) {
    current.options_schema = current.options_schema || [];
    current.options_schema.push(option);
  } else if (lastItem) {
    lastItem.options_schema = lastItem.options_schema || [];
    lastItem.options_schema.push(option);
  }

  continue;
}

if (ignoreLines.some((x) => line.startsWith(x))) continue;

if (option) {
  if (lastItem) {
    lastItem.options_schema = lastItem.options_schema || [];
    lastItem.options_schema.push(option);
  }
  continue;
}

const sectionName = normaliseSectionName(line, expectedSections);
if (sectionName) {
  setSection(sectionName);

  const fixed = line.match(fixedEach);
  fixedPrice = fixed ? Number(fixed[1]) : null;

  continue;
}

    const fixed = line.match(fixedEach);
    if (fixed) {
      fixedPrice = Number(fixed[1]);
      continue;
    }

    const splitItems = splitLineIntoItems(line);
if (splitItems && splitItems.length) {
  splitItems.forEach((x) => addItem(x.name, x.price));
  continue;
}

    let m = line.match(priceAtEnd);
    if (m) {
      addItem(m[1], Number(m[2]));
      continue;
    }

    m = line.match(priceAtStart);
    if (m) {
      addItem(m[2], Number(m[1]));
      continue;
    }

   if (priceMode === "plain" || priceMode === "mixed") {
  if (!addOnPriceOnly.test(line)) {
    m = line.match(plainPriceAtEnd);

    if (m) {
      const name = String(m[1] || "").trim();
      const lowerName = name.toLowerCase();
      const price = Number(m[2]);

      const isKcalPriceLine = lowerName.includes("kcal");

      if (isKcalPriceLine && pendingItemName && price > 0 && price < 100) {
        addItem(pendingItemName, price);
        continue;
      }

      const badPlainLine =
        lowerName.includes("kcal") ||
        lowerName.includes("+") ||
        lowerName.includes("upgrade") ||
        lowerName.includes("add ") ||
        lowerName.includes("served with") ||
        lowerName.includes("choose") ||
        lowerName.includes("choice of") ||
        lowerName.includes("only") ||
        lowerName.includes("sauce)") ||
        lowerName.endsWith("sauce") ||
        lowerName.length < 4;

      const looksLikeSentence =
        name.split(" ").length > 7 ||
        /^[a-z]/.test(name);

      if (price > 0 && price < 100 && !badPlainLine && !looksLikeSentence) {
        addItem(name, price);
        continue;
      }
    }
  }
}

const possibleTitle =
  line.length >= 4 &&
  line.length <= 60 &&
  /^[A-Z0-9'"’&.,*§() -]+$/i.test(line) &&
  !line.toLowerCase().includes("served with") &&
  !line.toLowerCase().includes("choose") &&
  !line.toLowerCase().includes("kcal") &&
  !line.toLowerCase().startsWith("add ") &&
  !line.toLowerCase().startsWith("upgrade") &&
  !line.toLowerCase().startsWith("with ");

if (possibleTitle) {
  pendingItemName = line;
}

    if (
  fixedPrice &&
  /^[A-Za-z0-9 &,.'()-]+$/.test(line) &&
  line.length <= 35 &&
  !line.toLowerCase().includes("with ") &&
  !line.toLowerCase().includes("served") &&
  !line.toLowerCase().includes("marinated") &&
  !line.toLowerCase().includes("cooked") &&
  !line.toLowerCase().includes("light ")
) {
  addItem(line, fixedPrice);
}
  }

  pushCurrent();

  return sections.filter((s) => s.items.length);
}

router.post("/parse", upload.single("menu"), async (req, res) => {
  try {
    const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
    if (!rid) return res.status(400).json({ error: "Missing tenant" });

    if (!req.file) {
      return res.status(400).json({
        error: 'No menu uploaded. Field name must be "menu".',
      });
    }

    const menuType = String(req.body?.menuType || "mixed").toLowerCase();
const priceMode = String(req.body?.priceMode || "mixed").toLowerCase();

const expectedSections = String(req.body?.expectedSections || "")
  .split(",")
  .map((x) => cleanName(x))
  .filter(Boolean);

   let rawText = "";
let method = "v2";
let categories = [];

try {
  const v2 = await parsePdfMenuV2(req.file.path);

  categories = Array.isArray(v2.categories) ? v2.categories : [];
  const v2ItemCount = categories.reduce((s, c) => s + c.items.length, 0);
  const hasBadMenuCategory = categories.some((c) => c.name === "Menu");
  const hasWeakCount = v2ItemCount < 20;

  console.log("✅ Menu Importer V2 result:", {
    categories: categories.length,
    items: v2ItemCount,
    debug: v2.debug,
  });

  if (hasWeakCount || hasBadMenuCategory) {
    throw new Error("V2 result too weak, fallback to V1");
  }

  rawText = "";
  method = "v2";
} catch (e) {

  console.warn("⚠️ V2 failed, falling back to V1:", e.message);

  rawText = await extractTextWithPdfLayout(req.file.path);
  method = "pdf-layout";
categories = parseMenuText(rawText, {
  menuType,
  priceMode,
  expectedSections,
});
  categories = cleanImportedMenu(categories);
  const lowerFile = String(req.file.originalname || "").toLowerCase();

  if (menuType === "desserts") {
  categories = categories.map((cat) => ({
    ...cat,
    type: "desserts",
  }));
}

if (lowerFile.includes("drink")) {
  categories = categories.filter((cat) => cat.type === "drinks");
  categories = cleanDrinkMenu(categories);
}
}

const itemCount = categories.reduce((s, c) => s + c.items.length, 0);

if (itemCount < 5) {
  console.log("⚠️ Weak PDF text parse, trying OCR fallback...");
  rawText = await extractTextWithOCR(req.file.path);
  method = "ocr";
categories = parseMenuText(rawText, {
  menuType,
  priceMode,
  expectedSections,
});
  categories = cleanImportedMenu(categories);
  const lowerFile = String(req.file.originalname || "").toLowerCase();

if (lowerFile.includes("drink")) {
  categories = categories.filter((cat) => cat.type === "drinks");
  categories = cleanDrinkMenu(categories);
}
}

    try {
      fs.unlinkSync(req.file.path);
    } catch {}

    return res.json({
      success: true,
      draft: {
        categories,
      },
      metadata: {
        method,
        textLength: rawText.length,
        categoryCount: categories.length,
        itemCount: categories.reduce((s, c) => s + c.items.length, 0),
      },
    });
  } catch (err) {
    console.error("❌ /menu-import/parse failed:", err);
    return res.status(500).json({
      error: "Failed to parse menu PDF",
      detail: err.message,
    });
  }
});

const cleanName = (v) => String(v || "").trim();

const iconForType = (type) => {
  if (type === "drinks") return "🍹";
  if (type === "desserts") return "🍰";
  return "🍽️";
};

router.post(
  "/commit",
  requireCloudMenuImportAuthority,
  async (req, res) => {
    try {
      const rid =
        Number(
          req.tenantRid ||
          req.user?.restaurant_id ||
          0
        );

      if (!rid) {
        return res
          .status(400)
          .json({
            error:
              "Missing tenant",
          });
      }

      const categories =
        Array.isArray(
          req.body?.categories
        )
          ? req.body.categories
          : [];

      if (!categories.length) {
        return res
          .status(400)
          .json({
            error:
              "No categories to import",
          });
      }

      const imported =
        await withTx(
          async (tx) => {
            const result = {
              categories: 0,
              meals: 0,
              drinks: 0,
              desserts: 0,
              skipped: 0,
            };

            for (
              const cat of
              categories
            ) {
              const catName =
                cleanName(
                  cat.name ||
                  "Menu"
                );

              const catType =
                cat.type ===
                  "drinks" ||
                cat.type ===
                  "desserts" ||
                cat.type ===
                  "meals"
                  ? cat.type
                  : guessType(
                      catName
                    );

              const items =
                Array.isArray(
                  cat.items
                )
                  ? cat.items
                  : [];

              if (
                !catName ||
                !items.length
              ) {
                result.skipped +=
                  items.length ||
                  1;

                continue;
              }

              const categoryRow =
                await tx.qGet(
                  `
                  INSERT INTO
                    public.categories
                  (
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
                    $4
                  )
                  ON CONFLICT
                  (
                    restaurant_id,
                    name
                  )
                  DO UPDATE
                  SET
                    type =
                      EXCLUDED.type,
                    icon =
                      EXCLUDED.icon
                  RETURNING id
                  `,
                  [
                    rid,
                    catName,
                    catType,
                    iconForType(
                      catType
                    ),
                  ]
                );

              const categoryId =
                Number(
                  categoryRow?.id ||
                  0
                );

              if (!categoryId) {
                result.skipped +=
                  items.length;

                continue;
              }

              result.categories +=
                1;

              for (
                const item of
                items
              ) {
                const itemName =
                  cleanName(
                    item.name
                  );

                const price =
                  Number(
                    item.price ||
                    0
                  );

                if (
                  !itemName ||
                  !(price >= 0)
                ) {
                  result.skipped +=
                    1;

                  continue;
                }

                const existing =
                  catType ===
                    "meals"
                    ? await tx.qGet(
                        `
                        SELECT id
                        FROM public.meals
                        WHERE restaurant_id = $1
                          AND LOWER(TRIM(name)) =
                            LOWER(TRIM($2))
                        LIMIT 1
                        `,
                        [
                          rid,
                          itemName,
                        ]
                      )
                    : await tx.qGet(
                        `
                        SELECT id
                        FROM public.menu_items
                        WHERE restaurant_id = $1
                          AND LOWER(TRIM(name)) =
                            LOWER(TRIM($2))
                          AND LOWER(TRIM(type)) = $3
                        LIMIT 1
                        `,
                        [
                          rid,
                          itemName,
                          catType ===
                            "drinks"
                            ? "drink"
                            : "dessert",
                        ]
                      );

                if (
                  existing?.id
                ) {
                  result.skipped +=
                    1;

                  continue;
                }

                if (
                  catType ===
                  "drinks"
                ) {
                  await tx.qRun(
                    `
                    INSERT INTO
                      public.menu_items
                    (
                      restaurant_id,
                      name,
                      price,
                      type,
                      category_id,
                      options_schema,
                      allergens,
                      calories
                    )
                    VALUES
                    (
                      $1,
                      $2,
                      $3,
                      'drink',
                      $4,
                      $5::jsonb,
                      'Review required',
                      0
                    )
                    `,
                    [
                      rid,
                      itemName,
                      price,
                      categoryId,
                      JSON.stringify(
                        []
                      ),
                    ]
                  );

                  result.drinks +=
                    1;

                  continue;
                }

                if (
                  catType ===
                  "desserts"
                ) {
                  await tx.qRun(
                    `
                    INSERT INTO
                      public.menu_items
                    (
                      restaurant_id,
                      name,
                      price,
                      type,
                      category_id,
                      options_schema,
                      allergens,
                      calories
                    )
                    VALUES
                    (
                      $1,
                      $2,
                      $3,
                      'dessert',
                      $4,
                      $5::jsonb,
                      'Review required',
                      0
                    )
                    `,
                    [
                      rid,
                      itemName,
                      price,
                      categoryId,
                      JSON.stringify(
                        []
                      ),
                    ]
                  );

                  result.desserts +=
                    1;

                  continue;
                }

                await tx.qRun(
                  `
                  INSERT INTO
                    public.meals
                  (
                    restaurant_id,
                    user_id,
                    name,
                    ingredients,
                    allergens,
                    calories,
                    price,
                    category,
                    category_id,
                    paused,
                    options_schema,
                    created_at
                  )
                  VALUES
                  (
                    $1,
                    $2,
                    $3,
                    $4,
                    'Review required',
                    0,
                    $5,
                    $6,
                    $7,
                    false,
                    $8::jsonb,
                    NOW()
                  )
                  `,
                  [
                    rid,
                    req.user?.id ||
                    null,
                    itemName,
                    JSON.stringify(
                      []
                    ),
                    price,
                    catName,
                    categoryId,
                    JSON.stringify(
                      []
                    ),
                  ]
                );

                result.meals +=
                  1;
              }
            }

            await emitMenuCatalogSnapshotTx(
              tx,
              {
                restaurantId:
                  rid,
              }
            );

            return result;
          }
        );

      return res.json({
        success: true,
        imported,
      });
    } catch (error) {
      console.error(
        "❌ /menu-import/commit failed:",
        error
      );

      if (
        sendMenuImportAuthorityError(
          res,
          error
        )
      ) {
        return;
      }

      return res
        .status(500)
        .json({
          error:
            "Failed to import menu",
          detail:
            error.message,
        });
    }
  }
);

module.exports = router;