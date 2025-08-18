const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const { execSync } = require('child_process');
const router = express.Router();
const { extractBaseIngredient, extractQuantity } = require('../utils/novaParser');
const { detectAllergensFromName } = require('../utils/novaAllergens');
const shelfLifeMap = require('../utils/shelfLifeMap');
const db = require('../dbSqliteCompat');

const upload = multer({ dest: 'uploads/' });

function extractItemsFromOCR(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const extractedItems = [];

  const stopPatterns = [
    /SUBSTITUTION DETAILS/i,
    /The following items were not available/i,
    /CHILLED DS/i,
    /RETAIL GROCERY/i
  ];

  const itemPattern = /^(.*?)(\d{1,3})?\s+£?(\d+\.\d{2})$/i;

  for (let line of lines) {
    if (stopPatterns.some(pattern => pattern.test(line))) break;

    const match = line.match(itemPattern);
    if (match) {
      const [, rawDesc, qty, price] = match;
      const cleanedDescription = cleanDescription(rawDesc);
      const base = extractBaseIngredient(cleanedDescription);
      const { quantity: quantityParsed, unit } = extractQuantity(cleanedDescription);

      extractedItems.push({
        description: cleanedDescription,
        base_ingredient: base,
        qty: parseQuantity(qty),
        quantity_parsed: quantityParsed,
        unit,
        price: parseFloat(price),
        suggested_allergens: detectAllergensFromName(base)
      });
    } else {
      console.log("❌ Line skipped, no match:", line); // 👈 debug failed lines
    }
  }

  return extractedItems.filter(item => item.description.length > 2 && item.price > 0);
}

function cleanDescription(text) {
    return text.replace(/[^\w\s]/g, '').replace(/\s\s+/g, ' ').trim();
}

function parseQuantity(qtyOrSize) {
    if (!qtyOrSize) return 1;
    const qty = parseInt(qtyOrSize);
    return isNaN(qty) ? 1 : qty;
}

function parsePrice(priceOrValue) {
    if (!priceOrValue) return 0;
    const price = parseFloat(priceOrValue.replace(',', '.'));
    return isNaN(price) ? 0 : price;
}

router.post("/scan-ingredient-image", upload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "No image uploaded." });

    try {
        const inputPath = req.file.path;
        const outputPath = `${inputPath}.png`;

        await sharp(inputPath).resize(1000).grayscale().toFile(outputPath);

        const { data: { text } } = await Tesseract.recognize(outputPath, "eng", { logger: m => console.log(m) });

        console.log("📄 OCR Text Extracted:\n", text);

        console.log("✅ Extracted Text (Raw):", text);

        const ingredientPattern = /ingredients[:\s]+([\s\S]*?)(allergy advice|contains|suitable for|certified sustainable)/i;
        const allergensPattern = /(allergy advice|contains)[:\s]+([\s\S]*?)(suitable for|certified sustainable|$)/i;

        const ingredientsMatch = text.match(ingredientPattern);
        const allergensMatch = text.match(allergensPattern);

        let extractedIngredients = ingredientsMatch ? ingredientsMatch[1] : "Not detected";
        let extractedAllergens = allergensMatch ? allergensMatch[2] : "None";

        extractedIngredients = extractedIngredients.replace(/\n/g, " ").replace(/[\(\)]/g, "").replace(/\s\s+/g, " ").trim();
        extractedAllergens = extractedAllergens.replace(/\n/g, ", ").replace(/\s\s+/g, " ").replace(/(see ingredients in bold|also, not suitable for customers with an|due to manufacturing methods)/gi, "").trim();

        const allergenList = [
            "gluten", "milk", "egg", "peanut", "soy", "sesame", "crustaceans",
            "fish", "molluscs", "tree nuts", "wheat", "barley", "rye", "oats",
            "sulphites", "mustard", "celery", "lupin"
        ];

        const detectedAllergens = allergenList.filter(allergen =>
            new RegExp(`\\b${allergen}\\b`, "i").test(extractedAllergens)
        );

        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

        const ingredient = extractedIngredients.split(",")[0].trim();
        if (!ingredient || ingredient === "Not detected") {
            return res.json({ success: false, message: "Could not detect ingredient name." });
        }

        const allergensToSave = detectedAllergens.length > 0 ? detectedAllergens.join(", ") : "None";
        const isDrink = /juice|soda|water|wine|beer|coffee|tea|milk/i.test(ingredient);

        const type = isDrink ? 'drink' : 'ingredient';
        const unit = 'unit';
        const quantity = 1;
        const quantity_parsed = 1;
        const price = 0;
        const category = 'General';
        const calories_per_100g = 0;
        const minimum_level = 10;

        await new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO stock (
      ingredient, price, supplier_id, quantity, allergens,
      calories_per_100g, waste_flag, expiry_date, unit,
      minimum_level, quantity_in_grams, type, category,
      portions_left, name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ingredient) DO UPDATE SET
      allergens = CASE 
        WHEN stock.allergens IS NULL OR stock.allergens = 'None' 
        THEN excluded.allergens 
        ELSE stock.allergens || ', ' || excluded.allergens 
      END,
      quantity = stock.quantity + excluded.quantity`,
    [
      ingredient.toLowerCase(),       // ingredient
      price || 0,                     // price
      null,                           // supplier_id
      quantity,                       // quantity
      allergensToSave || 'None',      // allergens
      0,                              // calories_per_100g
      0,                              // waste_flag
      null,                           // expiry_date
      unit || 'unit',                 // unit
      10,                             // minimum_level
      null,                           // quantity_in_grams
      type || 'ingredient',           // type
      category || 'General',          // category
      0,                              // portions_left
      ingredient                      // name (just duplicate of ingredient)
    ],
    function (err) {
      if (err) {
        console.error('❌ FINAL SQL ERROR:', err.message);
        reject(err);
      } else {
        console.log(`✅ FINAL SUCCESS: Inserted ${ingredient}`);
        resolve();
      }
    }
  );
});

        return res.json({
            success: true,
            ingredientName: ingredient,
            allergens: allergensToSave
        });

    } catch (error) {
        console.error("❌ Error processing image:", error.message);
        return res.status(500).json({ success: false, message: "Error processing image." });
    }
});

router.post('/scan-preview', upload.single('invoice'), async (req, res) => {
    console.log('📥 Invoice scan preview endpoint hit.');
    if (!req.file) return res.status(400).send('No file uploaded.');

    const filePath = req.file.path;
    let processedFilePath = filePath;

    try {
        const fileType = execSync(`file --mime-type -b ${filePath}`).toString().trim();
        if (fileType.includes('image/heif') || fileType.includes('image/heic')) {
            processedFilePath = `${filePath}.png`;
            execSync(`magick convert ${filePath} ${processedFilePath}`);
        }

        await sharp(processedFilePath).grayscale().toFile(`${processedFilePath}_processed.png`);
        processedFilePath = `${processedFilePath}_processed.png`;

        const { data: { text } } = await Tesseract.recognize(processedFilePath, 'eng', {
            logger: m => console.log(m)
        });

        const extractedItems = extractItemsFromOCR(text);
        if (extractedItems.length === 0) {
            return res.status(400).json({ success: false, message: 'No valid items found.' });
        }

        console.log("📤 Sending extracted items:", extractedItems);

       return res.json({
  success: true,
lines: extractedItems,
    metadata: {
        filename: req.file.originalname,
        scannedAt: new Date().toISOString(),
    },
}); 

    } catch (error) {
        console.error("❌ Error processing invoice preview:", error.message);
        return res.status(500).send("Error processing invoice.");
    } finally {
        try {
            fs.unlinkSync(filePath);
            if (processedFilePath !== filePath) fs.unlinkSync(processedFilePath);
            console.log("🗑️ Temporary files deleted.");
        } catch (cleanupError) {
            console.warn("⚠️ Cleanup failed:", cleanupError.message);
        }
    }
});

module.exports = router;
