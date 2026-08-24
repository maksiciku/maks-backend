const express = require("express");
const router = express.Router();
const { qAll } = require("../dbCompat");
const { requireRole } = require("../middleware/authMiddleware");

router.get("/", requireRole("owner","admin"), async (req, res) => {
  try {
    const rid = Number(req.tenantRid);
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const rows = await qAll(
      `
      SELECT id, user_id, actor_role, action, entity, entity_id, ip, meta, created_at
      FROM audit_log
      WHERE restaurant_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
      `,
      [rid, limit]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("GET /audit failed:", e);
    res.status(500).json({ error: "Failed to load audit log" });
  }
});

module.exports = router;
