// routes/scanRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

// Be tolerant to any export shape from the util
let parseInvoiceText = require('../utils/parseInvoiceText');
if (parseInvoiceText && typeof parseInvoiceText !== 'function') {
  if (typeof parseInvoiceText.parseInvoiceText === 'function') {
    parseInvoiceText = parseInvoiceText.parseInvoiceText;
  } else if (typeof parseInvoiceText.default === 'function') {
    parseInvoiceText = parseInvoiceText.default;
  }
}
if (typeof parseInvoiceText !== 'function') {
  console.warn('⚠️ parseInvoiceText not a function — using minimal fallback');
  parseInvoiceText = (txt) => {
    const lines = String(txt || '').split(/\r?\n/);
    return lines
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => ({ description: l, base_ingredient: l.toLowerCase(), qty: 1, quantity_parsed: 1, unit: 'unit', price: null, suggested_allergens: 'None' }))
      .filter(x => x.base_ingredient && x.base_ingredient !== 'total');
  };
}

// storage in /uploads
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      const base = path.basename(file.originalname, ext)
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-')
        .slice(0, 60);
      cb(null, `${Date.now()}-${base}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/scan-preview', upload.single('invoice'), async (req, res) => {
  const tmpPaths = [];
  const cleanup = () => tmpPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });

  try {
    if (!req.file) return res.status(400).json({ error: 'No invoice file uploaded (field name must be "invoice").' });

    const inputPath = req.file.path;
    const prepPath = inputPath + '.prep.png';
    tmpPaths.push(inputPath, prepPath);

    await sharp(inputPath).rotate().grayscale().normalize().toFormat('png').toFile(prepPath);

    const ocr = await Tesseract.recognize(prepPath, 'eng', {
      logger: m => m?.status && console.log(m)
    });

    const rawText = (ocr?.data?.text || '').trim();
    if (!rawText) {
      cleanup();
      return res.status(200).json({ itemsAndPrices: [], metadata: { textLength: 0 } });
    }

    const itemsAndPrices = parseInvoiceText(rawText) || [];
    console.log('📤 Sending extracted items:', JSON.stringify(itemsAndPrices, null, 2));

    res.status(200).json({
      itemsAndPrices,
      metadata: { textLength: rawText.length, lines: rawText.split(/\r?\n/).length }
    });

    cleanup();
  } catch (err) {
    console.error('❌ Invoice scan failed:', err);
    try { cleanup(); } catch {}
    res.status(500).json({ error: 'Invoice scan failed.' });
  }
});

// Simple ingredient enrichment endpoint used by AddMealForm
// Frontend calls: POST /scan-ingredient { ingredientName }
router.post("/scan-ingredient", async (req, res) => {
  try {
    const ingredientName = String(req.body?.ingredientName || "").trim();
    if (!ingredientName) return res.status(400).json({ error: "ingredientName required" });

    // ✅ If you already have a real allergen/calorie service, call it here.
    // For now we return safe defaults so the app never breaks.
    return res.json({
      ingredient: ingredientName,
      allergens: "None",
      calories: 0,
    });
  } catch (err) {
    console.error("❌ scan-ingredient failed:", err);
    return res.status(500).json({ error: "scan-ingredient failed" });
  }
});
module.exports = router;
