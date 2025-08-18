const allergenMap = {
  milk: ['milk', 'cheese', 'butter', 'cream', 'yogurt'],
  egg: ['egg', 'mayonnaise', 'meringue'],
  gluten: ['wheat', 'barley', 'rye', 'flour', 'bread', 'pasta', 'cake'],
  peanut: ['peanut'],
  tree_nuts: ['almond', 'hazelnut', 'walnut', 'cashew', 'pistachio'],
  soy: ['soy', 'soya'],
  sesame: ['sesame'],
  crustaceans: ['prawn', 'shrimp', 'crab', 'lobster'],
  fish: ['salmon', 'cod', 'tuna', 'haddock'],
  molluscs: ['mussels', 'clams', 'oyster', 'scallop'],
  sulphites: ['sulphite', 'sulfite'],
  mustard: ['mustard'],
  celery: ['celery'],
  lupin: ['lupin']
};

function detectAllergensFromName(name) {
  const found = [];

  const lowerName = name.toLowerCase();
  for (const [allergen, keywords] of Object.entries(allergenMap)) {
    if (keywords.some(keyword => lowerName.includes(keyword))) {
      found.push(allergen);
    }
  }

  return found.length > 0 ? found.join(', ') : 'None';
}

module.exports = { detectAllergensFromName };
