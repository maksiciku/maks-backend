// backend/utils/novaKnowledge.js

const ingredientFacts = {
  "heinz beans": { packSize: "6x2kg", totalKg: 12, portionsPerCan: 15, portionGrams: 130, portionsPerPack: 90 },
  "crushed tomatoes": { packSize: "25kg sack", totalKg: 25, portionsPerKg: 8.33, portionGrams: 120, portionsPerPack: 208.25 },
  "plain flour": { packSize: "15kg bag", totalKg: 15, portionsPerKg: 10, portionGrams: 100, portionsPerPack: 150 },
  "carrot cake": { packSize: "12kg", totalKg: 12, portionsPerKg: 5, portionGrams: 200, portionsPerPack: 60 },
  "vanilla ice cream": { packSize: "4L tub", totalLitres: 4, portionsPerLitre: 10, portionGrams: 100, portionsPerPack: 40 },
  "chocolate fudge cake": { packSize: "12ptn", totalKg: 1.2, portionsPerPack: 12, portionGrams: 100 }
};

function getIngredientFacts(baseIngredientName) {
  const key = baseIngredientName.toLowerCase().trim();
  return ingredientFacts[key] || null;
}

function isInGrams(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return lower.includes('kg') || lower.includes('g') || lower.includes('ml');
}

function getEstimatedGrams(name) {
  const lower = name.toLowerCase();
  if (lower.includes('egg')) return 60;
  if (lower.includes('loaf')) return 800;
  if (lower.includes('tray')) return 1800;
  if (lower.includes('tin')) return 26000;
  return 1000;
}

const ingredientAliases = {
  "cumberland sausage": "sausage",
  "pork sausage": "sausage",
  "free range eggs": "egg",
  "baked beans": "beans",
  "sliced mushrooms": "mushroom",
  "frozen hashbrowns": "hashbrown",
  "back bacon unsmoked": "bacon",
  "crushed tomatoes": "tomato"
};

function summarizeIngredients(ingredients, servings) {
  const summary = {};

  ingredients.forEach((item) => {
    const name = item?.ingredient_name;
    if (!name) return;

    const lowerName = name.toLowerCase();
    const base =
      Object.keys(ingredientAliases).find((key) =>
        lowerName.includes(key)
      ) || name;

    const baseTerm = ingredientAliases[base] || base;

    if (!summary[baseTerm]) {
      summary[baseTerm] = 0;
    }

    summary[baseTerm] += servings;
  });

  return summary;
}

module.exports = {
  ingredientFacts,
  getIngredientFacts,
  isInGrams,
  getEstimatedGrams,
  ingredientAliases,
  summarizeIngredients
};
