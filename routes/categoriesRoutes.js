const router = require("express").Router();

const ridOf = (req) => Number(req.tenantRid || 0);

function bind(sqliteSql, pgSql, kind) {
  return kind === "pg" ? pgSql : sqliteSql;
}

const normType = (t) => {
  const s = String(t || "").toLowerCase().trim();
  if (s.startsWith("drink")) return "drinks";
  if (s.startsWith("dessert")) return "desserts";
  return "meals";
};

// GET /categories?type=meals|drinks|desserts
router.get("/", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const tp = req.query.type ? normType(req.query.type) : null;

    const rows = await req.qAll(
      `
      SELECT id, restaurant_id, name, type, COALESCE(icon,'🍽️') AS icon
      FROM categories
      WHERE restaurant_id = ?
      ${tp ? "AND type = ?" : ""}
      ORDER BY name ASC
      `,
      tp ? [rid, tp] : [rid]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("categories GET error", e);
    res.status(500).json({ error: "Failed to load categories" });
  }
});

// POST /categories  { name, type, icon }
router.post("/", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const { name, type, icon } = req.body || {};
    const nm = String(name || "").trim();
    if (!nm) return res.status(400).json({ error: "Name required" });

    const tp = normType(type);
    const ic = String(icon || "🍽️").trim() || "🍽️";

    const row = await req.qGet(
      `
      INSERT INTO categories (restaurant_id, name, type, icon)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (restaurant_id, name)
      DO UPDATE SET type = excluded.type, icon = excluded.icon
      RETURNING id, name, type, icon
      `,
      [rid, nm, tp, ic]
    );

    res.json(row);
  } catch (e) {
    console.error("categories POST error", e);
    if (
      e?.code === "23505" ||
      String(e?.message || "").toLowerCase().includes("unique")
    ) {
      return res.status(409).json({ error: "Category already exists" });
    }
    res.status(500).json({ error: "Failed to create category" });
  }
});

// DELETE /categories/:id
router.delete("/:id", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    await req.qRun(`DELETE FROM categories WHERE id = ? AND restaurant_id = ?`, [id, rid]);
    res.json({ success: true });
  } catch (e) {
    console.error("categories DELETE error", e);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

module.exports = router;
