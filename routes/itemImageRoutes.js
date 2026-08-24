const router = require("express").Router();
const { authenticateToken } = require("../middleware/authMiddleware");
const { loadMembership } = require("../middleware/tenantMembership");
const { uploadMenuItemImage } = require("../utils/uploads");

router.post(
  "/:type/:id/image",
  authenticateToken,
  loadMembership,
  uploadMenuItemImage.single("photo"),
  async (req, res) => {
    try {
      const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
      const id = Number(req.params.id || 0);
      const type = String(req.params.type || "").toLowerCase();

      if (!rid) return res.status(401).json({ error: "Missing tenant" });
      if (!id) return res.status(400).json({ error: "Invalid item id" });
      if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

      const imageUrl = `/uploads/${rid}/menu-items/${req.file.filename}`;

      if (type === "meal" || type === "meals") {
        await req.qRun(
          `
          UPDATE public.meals
          SET photo_url = $1
          WHERE restaurant_id = $2
            AND id = $3
          `,
          [imageUrl, rid, id]
        );

        return res.json({ success: true, photo_url: imageUrl });
      }

      if (type === "drink" || type === "drinks" || type === "dessert" || type === "desserts") {
        const dbType = type.startsWith("drink") ? "drink" : "dessert";

        await req.qRun(
          `
          UPDATE public.menu_items
          SET photo_url = $1
          WHERE restaurant_id = $2
            AND id = $3
            AND LOWER(TRIM(type)) IN ($4, $5)
          `,
          [imageUrl, rid, id, dbType, `${dbType}s`]
        );

        return res.json({ success: true, photo_url: imageUrl });
      }

      return res.status(400).json({ error: "Invalid item type" });
    } catch (e) {
      console.error("❌ item image upload failed:", e);
      return res.status(500).json({ error: "Failed to upload item image" });
    }
  }
);

module.exports = router;