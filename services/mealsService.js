// services/mealsService.js
const { qAll, qGet } = require('../migrations/schema');
const { isInGrams, getEstimatedGrams } = require('../utils/novaKnowledge');

function parseOptionsSchemaSafe(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(obj) ? obj : [];
  } catch { return []; }
}

async function enrichIngredients(db, rid, ingredients) {
  const knownAllergens = { egg: 'Eggs', tuna: 'Fish', cheese: 'Milk', bread: 'Gluten' };
  const fallbackCalories = { egg: 155, tuna: 132, cheese: 402, bread: 250 };

  let detectedAllergens = new Set();
  let totalCalories = 0;
  let enrichedIngredients = [];

  for (const ing of ingredients) {
    const ingredientName = ing.name?.trim().toLowerCase();
    const amount = ing.amount ? parseFloat(ing.amount) : 100;
    if (!ingredientName) continue;

    const row = await db.getAsync(
      `SELECT allergens, calories_per_100g FROM stock
       WHERE restaurant_id = ? AND LOWER(ingredient) = LOWER(?)`,
      [rid, ingredientName]
    ).catch(()=>null);

    const allergens = new Set();
    if (row?.allergens && row.allergens.toLowerCase() !== 'none') {
      row.allergens.split(',').map(a => a.trim()).forEach(a => allergens.add(a));
    }
    if (knownAllergens[ingredientName]) allergens.add(knownAllergens[ingredientName]);

    const calories = row?.calories_per_100g
      ? row.calories_per_100g * (amount / 100)
      : fallbackCalories[ingredientName]
        ? fallbackCalories[ingredientName] * (amount / 100)
        : 0;

    detectedAllergens = new Set([...detectedAllergens, ...allergens]);
    totalCalories += calories;

    enrichedIngredients.push({
      name: ingredientName,
      amount,
      allergens: allergens.size ? Array.from(allergens).join(', ') : 'None',
      calories: calories.toFixed(2)
    });
  }

  return {
    enrichedIngredients,
    allergensList: Array.from(detectedAllergens).join(', ') || 'None',
    totalCalories
  };
}

function calculateMealCost(db, mealId, rid, callback) {
  const sql = `
    SELECT 
      mi.ingredient,
      mi.quantity,
      s.price,
      s.unit,
      (mi.quantity * COALESCE(s.price, 0)) AS cost
    FROM meal_ingredients mi
    LEFT JOIN stock s
      ON LOWER(TRIM(s.ingredient)) = LOWER(TRIM(mi.ingredient))
     AND s.restaurant_id = ?
    WHERE mi.meal_id = ?
  `;
  db.all(sql, [rid, mealId], (err, rows) => {
    if (err) return callback(err);
    const totalCost = rows.reduce((sum, r) => sum + (r.cost || 0), 0);
    const ingredients = rows.map(r => ({
      name: r.ingredient,
      quantity: r.quantity,
      unit: r.unit,
      price: r.price || 0,
      line_cost: Number((r.cost || 0).toFixed(2))
    }));
    callback(null, { totalCost: Number(totalCost.toFixed(2)), ingredients });
  });
}

module.exports = {
  parseOptionsSchemaSafe,
  enrichIngredients,
  calculateMealCost,
};
