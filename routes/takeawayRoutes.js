const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");

router.use(authenticateToken, loadMembership);

const ridOf = (req) => Number(req.tenantRid || req.user?.restaurant_id || 0);

// GET /takeaway/menu
router.get("/menu", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    // 🔹 MEALS
    const meals = await req.qAll(
      `
      SELECT id, name, price, category_id
      FROM meals
      WHERE restaurant_id = ?
        AND COALESCE(paused, false) = false
      ORDER BY name ASC
      `,
      [rid]
    );

    // 🔹 DRINKS
    const drinks = await req.qAll(
      `
      SELECT id, name, price, category_id
      FROM menu_items
      WHERE restaurant_id = ?
        AND LOWER(type) = 'drink'
        AND COALESCE(paused, false) = false
      ORDER BY name ASC
      `,
      [rid]
    );

    // 🔹 DESSERTS
    const desserts = await req.qAll(
      `
      SELECT id, name, price, category_id
      FROM menu_items
      WHERE restaurant_id = ?
        AND LOWER(type) = 'dessert'
        AND COALESCE(paused, false) = false
      ORDER BY name ASC
      `,
      [rid]
    );

    res.json({
      meals,
      drinks,
      desserts
    });

  } catch (e) {
    console.error("❌ GET /takeaway/menu failed:", e);
    res.status(500).json({ error: "Failed to load takeaway menu" });
  }
});

module.exports = router;