async function saveMenuItemIngredientsAndRefreshNutrition(req, rid, menuItemId, ingredients = []) {
  await req.qRun(
    `DELETE FROM public.menu_item_ingredients WHERE restaurant_id = $1 AND menu_item_id = $2`,
    [rid, menuItemId]
  );

  let totalCost = 0;
  let totalCalories = 0;
  const allergens = new Set();

  for (const ing of ingredients) {
    const stockId = Number(ing.stock_id || 0) || null;
    const ingredient = String(ing.ingredient || "").trim();
    const amount = Number(ing.amount || 0);
    const unit = String(ing.unit || "unit").trim();

    if (!ingredient || amount <= 0) continue;

    const stock = stockId
      ? await req.qGet(
          `
          SELECT id, ingredient, price, allergens, calories_per_100g
          FROM public.stock
          WHERE restaurant_id = $1 AND id = $2
          LIMIT 1
          `,
          [rid, stockId]
        )
      : await req.qGet(
          `
          SELECT id, ingredient, price, allergens, calories_per_100g
          FROM public.stock
          WHERE restaurant_id = $1
            AND LOWER(TRIM(ingredient)) = LOWER(TRIM($2))
          LIMIT 1
          `,
          [rid, ingredient]
        );

    const finalStockId = stock?.id ? Number(stock.id) : stockId;
    const finalIngredient = stock?.ingredient || ingredient;

    await req.qRun(
      `
      INSERT INTO public.menu_item_ingredients
        (restaurant_id, menu_item_id, stock_id, ingredient, amount, unit)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [rid, menuItemId, finalStockId, finalIngredient, amount, unit]
    );

    totalCost += amount * Number(stock?.price || 0);

    const caloriesPer100 = Number(stock?.calories_per_100g || 0);
    if (caloriesPer100 > 0) {
      totalCalories += caloriesPer100 * (amount / 100);
    }

    if (stock?.allergens && String(stock.allergens).toLowerCase() !== "none") {
      String(stock.allergens)
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
        .forEach((a) => allergens.add(a));
    }
  }

  const allergensText = allergens.size ? Array.from(allergens).join(", ") : "None";

  const updated = await req.qGet(
    `
    UPDATE public.menu_items
    SET allergens = $1,
        calories = $2
    WHERE restaurant_id = $3
      AND id = $4
    RETURNING *
    `,
    [allergensText, Number(totalCalories.toFixed(2)), rid, menuItemId]
  );

  return {
    item: updated,
    total_cost: Number(totalCost.toFixed(4)),
    allergens: allergensText,
    calories: Number(totalCalories.toFixed(2)),
  };
}

module.exports = {
  saveMenuItemIngredientsAndRefreshNutrition,
};