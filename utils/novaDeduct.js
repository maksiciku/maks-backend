const novaKnowledge = require('./novaKnowledge');

// Deduct stock for a single meal
async function deductStockFromMealOrder(mealId, quantitySold = 1) {
  try {
    const ingredients = await new Promise((resolve, reject) => {
      pool.query(`
        SELECT mi.ingredient_name, mi.quantity_per_meal
        FROM meal_ingredients mi
        WHERE mi.meal_id = ?
      `, [mealId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const { ingredient_name, quantity_per_meal } of ingredients) {
      const ingredient = ingredient_name.toLowerCase().trim();
      const usedPerMeal = quantity_per_meal || 0;
      const totalUsed = usedPerMeal * quantitySold;

      // First get the current quantity and name
const stockItem = await new Promise((resolve, reject) => {
  db.get(`SELECT quantity, ingredient FROM stock WHERE LOWER(TRIM(ingredient)) = ?`, [ingredient], (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

if (!stockItem) {
  console.warn(`⚠️ No stock found for ingredient: ${ingredient}`);
  continue;
}

const gramsPerUnit = extractGramsFromName(stockItem.ingredient) || 1;
const totalAvailableGrams = stockItem.quantity * gramsPerUnit;

if (totalAvailableGrams < totalUsed) {
  console.warn(`⚠️ Stock for ${stockItem.ingredient} would go negative (${totalAvailableGrams} - ${totalUsed})`);
}

// Subtract totalUsed grams and convert back to units
const remainingGrams = totalAvailableGrams - totalUsed;
const updatedUnits = remainingGrams / gramsPerUnit;

await new Promise((resolve, reject) => {
  db.run(`
    UPDATE stock
    SET quantity = ?
    WHERE LOWER(TRIM(ingredient)) = ?
  `, [updatedUnits, ingredient], function (err) {
    if (err) reject(err);
    else resolve();
  });
});

console.log(`✅ Updated ${stockItem.ingredient}: ${stockItem.quantity} → ${updatedUnits.toFixed(2)} units (${remainingGrams}g remaining)`);

      console.log(`✅ Deducted ${totalUsed}g/ml/units of ${ingredient}`);
    }
  } catch (error) {
    console.error('❌ Error in deductStockFromMealOrder:', error.message);
  }
}

function extractGramsFromName(name) {
  const lower = name.toLowerCase();

  if (lower.includes('kg')) {
    const match = lower.match(/([\d.]+)\s*kg/);
    if (match) return parseFloat(match[1]) * 1000;
  }

  if (lower.includes('g')) {
    const match = lower.match(/([\d.]+)\s*g/);
    if (match) return parseFloat(match[1]);
  }

  if (lower.includes('ml')) {
    const match = lower.match(/([\d.]+)\s*ml/);
    if (match) return parseFloat(match[1]); // use for liquids
  }

  return null; // fallback if no unit info found
}

module.exports = { deductStockFromMealOrder };
