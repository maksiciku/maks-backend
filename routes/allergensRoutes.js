// backend/routes/allergensRoutes.js
const express = require("express");
const { detectAllergenCodesFromName } = require("../utils/novaAllergens");

module.exports = function buildAllergensRoutes({ db, authenticateToken, tenantGuard }) {

  const router = express.Router();

  // safe query helper (never crash POS)
  async function safeAll(sql, params) {
    try {
      return await db.qAll(sql, params);
    } catch (e) {
      // ignore missing table OR missing column
      if (e && (e.code === "42P01" || e.code === "42703")) return [];
      console.error("safeAll failed:", e);
      return [];
    }
  }

  // Allergen definitions
  router.get("/allergens", authenticateToken, tenantGuard, (req, res) => {
    res.json([
      { code: "gluten", label: "Gluten", icon: "🌾" },
      { code: "egg", label: "Egg", icon: "🥚" },
      { code: "milk", label: "Milk", icon: "🥛" },
      { code: "peanuts", label: "Peanuts", icon: "🥜" },
      { code: "tree_nuts", label: "Tree nuts", icon: "🌰" },
      { code: "fish", label: "Fish", icon: "🐟" },
      { code: "crustaceans", label: "Crustaceans", icon: "🦐" },
      { code: "molluscs", label: "Molluscs", icon: "🦪" },
      { code: "soy", label: "Soy", icon: "🫘" },
      { code: "sesame", label: "Sesame", icon: "⚪" },
      { code: "mustard", label: "Mustard", icon: "🟡" },
      { code: "celery", label: "Celery", icon: "🥬" },
      { code: "sulphites", label: "Sulphites", icon: "🍷" },
      { code: "lupin", label: "Lupin", icon: "🌼" }
    ]);
  });


  router.get("/pos/items/allergens", authenticateToken, tenantGuard, async (req, res) => {

    const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
    if (!rid) return res.status(401).json({ error: "No restaurant" });

    const type = String(req.query?.type || "meal").toLowerCase();

    const out = {};

    try {

      // --------------------
      // MEALS
      // --------------------
      if (type === "meal") {

        const rows = await safeAll(
          `SELECT id, name FROM meals WHERE restaurant_id = $1`,
          [rid]
        );

        for (const r of rows) {
          out[Number(r.id)] = {
            contains: detectAllergenCodesFromName(r.name),
            may_contain: []
          };
        }

        return res.json(out);
      }


      // --------------------
      // DRINKS
      // --------------------
      if (type === "drink") {

        let rows = [];

        // 1️⃣ try menu_items
        rows = await safeAll(
          `SELECT id, name FROM menu_items WHERE restaurant_id = $1 AND item_type = 'drinks'`,
          [rid]
        );

        // 2️⃣ fallback to unified stock
        if (!rows.length) {
          rows = await safeAll(
            `SELECT id, name FROM stock WHERE restaurant_id = $1 AND type = 'drink'`,
            [rid]
          );
        }

        for (const r of rows) {
          out[Number(r.id)] = {
            contains: detectAllergenCodesFromName(r.name),
            may_contain: []
          };
        }

        return res.json(out);
      }


      // --------------------
      // DESSERTS
      // --------------------
      if (type === "dessert") {

        let rows = [];

        // 1️⃣ try menu_items
        rows = await safeAll(
          `SELECT id, name FROM menu_items WHERE restaurant_id = $1 AND item_type = 'desserts'`,
          [rid]
        );

        // 2️⃣ fallback to unified stock
        if (!rows.length) {
          rows = await safeAll(
            `SELECT id, name FROM stock WHERE restaurant_id = $1 AND type = 'dessert'`,
            [rid]
          );
        }

        for (const r of rows) {
          out[Number(r.id)] = {
            contains: detectAllergenCodesFromName(r.name),
            may_contain: []
          };
        }

        return res.json(out);
      }


      return res.json({});

    } catch (e) {

      console.error("pos/items/allergens failed", e);
      return res.status(500).json({ error: "Failed" });

    }

  });

  return router;
};