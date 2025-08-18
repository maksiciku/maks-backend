// utils/novaParser.js
const { getIngredientFacts } = require('./novaKnowledge');

// 🔹 Extract quantity and unit from description
function extractQuantity(description) {
    const quantityMatch = description.match(/([\d.]+)\s*(kg|g|l|ml|x|ptn|portion|box|can|bottle)/i);
    if (quantityMatch) {
        return {
            quantity: parseFloat(quantityMatch[1]),
            unit: quantityMatch[2].toLowerCase()
        };
    }
    return { quantity: 1, unit: 'unit' };
}

// 🔹 Extract base ingredient from known list or fallback
function extractBaseIngredient(description) {
    const lower = description.toLowerCase();

    const knownIngredients = [
        'tomato', 'beans', 'chicken', 'beef', 'egg', 'cheese', 'milk', 'carrot',
        'rice', 'potato', 'sausage', 'fish', 'onion', 'lettuce', 'cucumber',
        'spinach', 'mushroom', 'ham', 'flour', 'cream', 'sugar', 'salt', 'oil',
        'butter', 'vanilla', 'chocolate', 'basil', 'oregano', 'water'
    ];

    for (let keyword of knownIngredients) {
        if (lower.includes(keyword)) return keyword;
    }

    // Fallback: use first 2 words as estimate
    return description.split(' ').slice(0, 2).join(' ').toLowerCase();
}

// 🔹 Classify base ingredient into category
function classifyCategory(baseIngredient) {
    const veg = ['tomato', 'carrot', 'potato', 'onion', 'spinach', 'lettuce', 'cucumber', 'mushroom', 'basil', 'oregano'];
    const meat = ['chicken', 'beef', 'sausage', 'ham', 'fish'];
    const dairy = ['cheese', 'milk', 'cream', 'butter'];
    const grain = ['rice', 'flour'];
    const drink = ['juice', 'water', 'wine', 'beer'];
    const sweet = ['sugar', 'chocolate', 'vanilla'];
    const other = ['salt', 'oil', 'egg'];

    if (veg.includes(baseIngredient)) return 'vegetable';
    if (meat.includes(baseIngredient)) return 'meat';
    if (dairy.includes(baseIngredient)) return 'dairy';
    if (grain.includes(baseIngredient)) return 'grain';
    if (drink.includes(baseIngredient)) return 'drink';
    if (sweet.includes(baseIngredient)) return 'sweet';
    if (other.includes(baseIngredient)) return 'other';

    return 'unknown';
}

// 🔹 Wrap everything into a single parser function
function parseInvoiceItem(description) {
    const { quantity, unit } = extractQuantity(description);
    const baseIngredient = extractBaseIngredient(description);
    const category = classifyCategory(baseIngredient);
    const facts = getIngredientFacts(baseIngredient);

    let portions = 1;
    if (novaKnowledge[baseIngredient] && novaKnowledge[baseIngredient].portionGrams && quantity > 0) {
        const gramsInItem = convertToGrams(quantity, unit);
        const portionGrams = novaKnowledge[baseIngredient].portionGrams;
        portions = Math.floor(gramsInItem / portionGrams);
    }

    return {
        rawDescription: description,
        baseIngredient,
        quantity,
        unit,
        category,
        ...facts, // will include packSize, portionsPerCan etc. if found
        portions

    };
}

function convertToGrams(quantity, unit) {
    const unitLower = unit.toLowerCase();
    if (unitLower === 'kg') return quantity * 1000;
    if (unitLower === 'g') return quantity;
    if (unitLower === 'l') return quantity * 1000;
    if (unitLower === 'ml') return quantity;
    if (unitLower === 'x' || unitLower === 'unit') return quantity; // fallback
    return 0;
}

module.exports = {
    extractQuantity,
    extractBaseIngredient,
    classifyCategory,
    parseInvoiceItem
};
