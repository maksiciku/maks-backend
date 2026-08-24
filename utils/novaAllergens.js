// backend/utils/novaAllergens.js

// Smart keyword → allergen mapping
const RULES = [
  { words: ["tuna","salmon","cod","haddock","fish"], codes: ["fish"] },
  { words: ["prawn","shrimp","lobster","crab"], codes: ["crustaceans"] },
  { words: ["mussel","clam","oyster"], codes: ["molluscs"] },

  { words: ["mayo","mayonnaise","aioli"], codes: ["egg"] },
  { words: ["egg","omelette"], codes: ["egg"] },

  { words: ["cheese","milk","butter","cream"], codes: ["milk"] },

  { words: ["bread","bun","toast","sandwich","pasta","pizza","wrap","batter"], codes: ["gluten"] },

  { words: ["peanut"], codes: ["peanuts"] },
  { words: ["almond","hazelnut","walnut","cashew","pistachio"], codes: ["tree_nuts"] },

  { words: ["soy","soya","tofu"], codes: ["soy"] },

  { words: ["sesame"], codes: ["sesame"] },

  { words: ["mustard"], codes: ["mustard"] },

  { words: ["celery"], codes: ["celery"] },

  { words: ["wine","beer","vinegar"], codes: ["sulphites"] }
];

function detectAllergenCodesFromName(name) {
  const text = String(name || "").toLowerCase();

  const out = new Set();

  for (const rule of RULES) {
    if (rule.words.some(w => text.includes(w))) {
      for (const code of rule.codes) out.add(code);
    }
  }

  return [...out];
}

module.exports = {
  detectAllergenCodesFromName
};