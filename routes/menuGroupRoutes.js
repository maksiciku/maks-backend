const router = require("express").Router();

const ridOf = (req) => Number(req.tenantRid || 0);

const normType = (t) => {
  const s = String(t || "").toLowerCase().trim();
  if (s.startsWith("drink")) return "drinks";
  if (s.startsWith("dessert")) return "desserts";
  if (s.startsWith("custom")) return "custom";
  return "meals";
};

const dayKeyNow = () => {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return days[new Date().getDay()];
};

const minutesNow = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const timeToMinutes = (v) => {
  if (!v) return null;
  const [h, m] = String(v).slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  return h * 60 + (Number.isFinite(m) ? m : 0);
};

function safeArray(v) {
  try {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return JSON.parse(v);
    return [];
  } catch {
    return [];
  }
}

const scheduleOpenNow = (s) => {
  if (s.is_active === false) return false;

const activeDays = safeArray(s.active_days);
  if (activeDays.length && !activeDays.includes(dayKeyNow())) {
    return false;
  }

  const start = timeToMinutes(s.start_time);
  const end = timeToMinutes(s.end_time);
  const now = minutesNow();

  if (start === null || end === null) return true;

  if (start <= end) {
    return now >= start && now <= end;
  }

  return now >= start || now <= end;
};

async function getActiveMenuGroups(req, { baseType = null, surface = "pos" } = {}) {
  const rid = ridOf(req);
  if (!rid) return [];

  const groups = await req.qAll(
    `
    SELECT *
    FROM public.menu_groups
    WHERE restaurant_id = ?
      ${baseType ? "AND base_type = ?" : ""}
    ORDER BY sort_order ASC, name ASC
    `,
    baseType ? [rid, baseType] : [rid]
  );

  const schedules = await req.qAll(
    `
    SELECT s.*
    FROM public.menu_group_schedules s
    JOIN public.menu_groups g
      ON g.id = s.menu_group_id
     AND g.restaurant_id = s.restaurant_id
    WHERE s.restaurant_id = ?
      AND s.is_active = true
      ${baseType ? "AND g.base_type = ?" : ""}
    `,
    baseType ? [rid, baseType] : [rid]
  );

  const scheduleRows = Array.isArray(schedules) ? schedules : [];

  console.log("ACTIVE GROUP DEBUG", {
  baseType,
  surface,
  groups: (groups || []).map(g => ({
    id: g.id,
    name: g.name,
    start_time: g.start_time,
    end_time: g.end_time,
    active_days: g.active_days,
    is_active: g.is_active,
  })),
  schedules: scheduleRows.map(s => ({
    id: s.id,
    menu_group_id: s.menu_group_id,
    active_days: s.active_days,
    start_time: s.start_time,
    end_time: s.end_time,
    is_active: s.is_active,
  })),
});

  return (groups || []).filter((g) => {
    if (g.is_active === false) return false;

    if (surface === "pos" && g.show_pos === false) return false;
    if (surface === "qr" && g.show_qr === false) return false;
    if (surface === "kiosk" && g.show_kiosk === false) return false;

    const rowsForGroup = scheduleRows.filter(
      (s) => Number(s.menu_group_id) === Number(g.id)
    );

if (!rowsForGroup.length) {
  const hasLegacyTime = g.start_time || g.end_time || (
    Array.isArray(g.active_days) && g.active_days.length
  );

  if (hasLegacyTime) return scheduleOpenNow(g);

  return true;
}
    return rowsForGroup.some(scheduleOpenNow);
  });
}

router.get("/active-groups", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const baseType = req.query.base_type ? normType(req.query.base_type) : null;
    const surface = ["pos", "qr", "kiosk"].includes(String(req.query.surface))
      ? String(req.query.surface)
      : "pos";

    const activeGroups = await getActiveMenuGroups(req, { baseType, surface });
    res.json(activeGroups);
  } catch (e) {
    console.error("active menu groups error", e);
    res.status(500).json({ error: "Failed to load active groups" });
  }
});

// GET /menu-groups/active-categories?base_type=meals&surface=kiosk
router.get("/active-categories", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const baseType = req.query.base_type ? normType(req.query.base_type) : null;
    const surface = ["pos", "qr", "kiosk"].includes(String(req.query.surface))
      ? String(req.query.surface)
      : "pos";

   const groups = await req.qAll(
  `
  SELECT *
  FROM public.menu_groups
  WHERE restaurant_id = ?
    ${baseType ? "AND base_type = ?" : ""}
  ORDER BY sort_order ASC, name ASC
  `,
  baseType ? [rid, baseType] : [rid]
);

const allGroups = Array.isArray(groups) ? groups : [];

const activeGroups = await getActiveMenuGroups(req, { baseType, surface });

    if (allGroups.length && !activeGroups.length) {
      return res.json([]);
    }

    if (!allGroups.length) {
      const rows = await req.qAll(
        `
        SELECT id, restaurant_id, name, type, COALESCE(icon,'🍽️') AS icon
        FROM public.categories
        WHERE restaurant_id = ?
          ${baseType ? "AND type = ?" : ""}
        ORDER BY name ASC
        `,
        baseType ? [rid, baseType] : [rid]
      );

      return res.json(rows || []);
    }

    const ids = activeGroups.map((g) => Number(g.id)).filter(Boolean);
    const marks = ids.map(() => "?").join(",");

    const rows = await req.qAll(
      `
      SELECT DISTINCT
        c.id,
        c.restaurant_id,
        c.name,
        c.type,
        COALESCE(c.icon,'🍽️') AS icon,
        MIN(mgc.sort_order) AS sort_order
      FROM public.menu_group_categories mgc
      JOIN public.categories c
        ON c.id = mgc.category_id
       AND c.restaurant_id = mgc.restaurant_id
      WHERE mgc.restaurant_id = ?
        AND mgc.menu_group_id IN (${marks})
      GROUP BY c.id, c.restaurant_id, c.name, c.type, c.icon
      ORDER BY sort_order ASC, c.name ASC
      `,
      [rid, ...ids]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("active menu categories error", e);
    res.status(500).json({ error: "Failed to load active categories" });
  }
});

// GET /menu-groups?base_type=meals
router.get("/", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const baseType = req.query.base_type ? normType(req.query.base_type) : null;

    const rows = await req.qAll(
  `
  SELECT *
  FROM public.menu_groups
  WHERE restaurant_id = ?
    ${baseType ? "AND base_type = ?" : ""}
  ORDER BY
    CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END,
    sort_order ASC,
    name ASC
  `,
  baseType ? [rid, baseType] : [rid]
);

    res.json(rows || []);
  } catch (e) {
    console.error("menu-groups GET error", e);
    res.status(500).json({ error: "Failed to load menu groups" });
  }
});

// POST /menu-groups
router.post("/", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });

    const baseType = normType(req.body?.base_type);
    const parentId = req.body?.parent_id ? Number(req.body.parent_id) : null;

    const row = await req.qGet(
      `
      INSERT INTO public.menu_groups
        (restaurant_id, name, base_type, parent_id, sort_order, show_pos, show_qr, show_kiosk)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
      `,
      [
        rid,
        name,
        baseType,
        parentId,
        Number(req.body?.sort_order || 0),
        req.body?.show_pos !== false,
        req.body?.show_qr !== false,
        req.body?.show_kiosk !== false,
      ]
    );

    res.json(row);
  } catch (e) {
    console.error("menu-groups POST error", e);
    res.status(500).json({ error: "Failed to create menu group" });
  }
});

// PUT /menu-groups/:id
router.put("/:id", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const groupId = Number(req.params.id);
    if (!groupId) return res.status(400).json({ error: "Missing group id" });

    const activeDays = Array.isArray(req.body?.active_days)
      ? req.body.active_days
      : [];

    const row = await req.qGet(
      `
      UPDATE public.menu_groups
      SET
        name = COALESCE(NULLIF(?, ''), name),
        show_pos = ?,
        show_qr = ?,
        show_kiosk = ?,
        active_days = CAST(? AS jsonb),
        start_time = NULLIF(?, '')::time,
        end_time = NULLIF(?, '')::time,
        is_active = ?,
        updated_at = now()
      WHERE restaurant_id = ?
        AND id = ?
      RETURNING *
      `,
      [
        String(req.body?.name || "").trim(),
        req.body?.show_pos !== false,
        req.body?.show_qr !== false,
        req.body?.show_kiosk !== false,
        JSON.stringify(activeDays),
        String(req.body?.start_time || ""),
        String(req.body?.end_time || ""),
        req.body?.is_active !== false,
        rid,
        groupId,
      ]
    );

    if (!row) return res.status(404).json({ error: "Menu group not found" });

    res.json(row);
  } catch (e) {
    console.error("menu-groups PUT error", e);
    res.status(500).json({ error: "Failed to update menu group" });
  }
});

// GET /menu-groups/:id/schedules
router.get("/:id/schedules", async (req, res) => {
  try {
    const rid = ridOf(req);
    const groupId = Number(req.params.id);

    if (!rid || !groupId) return res.status(400).json({ error: "Missing rid/group" });

    const rows = await req.qAll(
      `
      SELECT *
      FROM public.menu_group_schedules
      WHERE restaurant_id = ?
        AND menu_group_id = ?
      ORDER BY priority DESC, start_time ASC, id ASC
      `,
      [rid, groupId]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("menu group schedules GET error", e);
    res.status(500).json({ error: "Failed to load schedules" });
  }
});

// POST /menu-groups/:id/schedules
router.post("/:id/schedules", async (req, res) => {
  try {
    const rid = ridOf(req);
    const groupId = Number(req.params.id);

    if (!rid || !groupId) return res.status(400).json({ error: "Missing rid/group" });

    const activeDays = Array.isArray(req.body?.active_days)
      ? req.body.active_days
      : [];

    const row = await req.qGet(
      `
      INSERT INTO public.menu_group_schedules
        (restaurant_id, menu_group_id, active_days, start_time, end_time, priority, is_active)
      VALUES (?, ?, CAST(? AS jsonb), NULLIF(?, '')::time, NULLIF(?, '')::time, ?, ?)
      RETURNING *
      `,
      [
        rid,
        groupId,
        JSON.stringify(activeDays),
        String(req.body?.start_time || ""),
        String(req.body?.end_time || ""),
        Number(req.body?.priority || 0),
        req.body?.is_active !== false,
      ]
    );

    res.json(row);
  } catch (e) {
    console.error("menu group schedule POST error", e);
    res.status(500).json({ error: "Failed to create schedule" });
  }
});

// PUT /menu-groups/:id/schedules/:scheduleId
router.put("/:id/schedules/:scheduleId", async (req, res) => {
  try {
    const rid = ridOf(req);
    const groupId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);

    if (!rid || !groupId || !scheduleId) {
      return res.status(400).json({ error: "Missing schedule" });
    }

    const activeDays = Array.isArray(req.body?.active_days)
      ? req.body.active_days
      : [];

    const row = await req.qGet(
      `
      UPDATE public.menu_group_schedules
      SET
        active_days = CAST(? AS jsonb),
        start_time = NULLIF(?, '')::time,
        end_time = NULLIF(?, '')::time,
        priority = ?,
        is_active = ?,
        updated_at = now()
      WHERE restaurant_id = ?
        AND menu_group_id = ?
        AND id = ?
      RETURNING *
      `,
      [
        JSON.stringify(activeDays),
        String(req.body?.start_time || ""),
        String(req.body?.end_time || ""),
        Number(req.body?.priority || 0),
        req.body?.is_active !== false,
        rid,
        groupId,
        scheduleId,
      ]
    );

    if (!row) return res.status(404).json({ error: "Schedule not found" });

    res.json(row);
  } catch (e) {
    console.error("menu group schedule PUT error", e);
    res.status(500).json({ error: "Failed to update schedule" });
  }
});

// DELETE /menu-groups/:id/schedules/:scheduleId
router.delete("/:id/schedules/:scheduleId", async (req, res) => {
  try {
    const rid = ridOf(req);
    const groupId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);

    await req.qRun(
      `
      DELETE FROM public.menu_group_schedules
      WHERE restaurant_id = ?
        AND menu_group_id = ?
        AND id = ?
      `,
      [rid, groupId, scheduleId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("menu group schedule DELETE error", e);
    res.status(500).json({ error: "Failed to delete schedule" });
  }
});

// DELETE /menu-groups/:id
router.delete("/:id", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const groupId = Number(req.params.id);
    if (!groupId) return res.status(400).json({ error: "Missing group id" });

    await req.qRun(
      `
      DELETE FROM public.menu_groups
      WHERE restaurant_id = ?
        AND id = ?
      `,
      [rid, groupId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("menu-groups DELETE error", e);
    res.status(500).json({ error: "Failed to delete menu group" });
  }
});

// POST /menu-groups/:id/categories
router.post("/:id/categories", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const groupId = Number(req.params.id);
    const categoryId = Number(req.body?.category_id);

    if (!groupId || !categoryId) {
      return res.status(400).json({ error: "Missing group/category" });
    }

    const row = await req.qGet(
      `
      INSERT INTO public.menu_group_categories
        (restaurant_id, menu_group_id, category_id, sort_order)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (restaurant_id, menu_group_id, category_id)
      DO UPDATE SET sort_order = excluded.sort_order
      RETURNING *
      `,
      [rid, groupId, categoryId, Number(req.body?.sort_order || 0)]
    );

    res.json(row);
  } catch (e) {
    console.error("menu group assign category error", e);
    res.status(500).json({ error: "Failed to assign category" });
  }
});

// GET /menu-groups/:id/categories
router.get("/:id/categories", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const groupId = Number(req.params.id);

    const rows = await req.qAll(
      `
      SELECT c.id, c.restaurant_id, c.name, c.type, COALESCE(c.icon,'🍽️') AS icon
      FROM public.menu_group_categories mgc
      JOIN public.categories c
        ON c.id = mgc.category_id
       AND c.restaurant_id = mgc.restaurant_id
      WHERE mgc.restaurant_id = ?
        AND mgc.menu_group_id = ?
      ORDER BY mgc.sort_order ASC, c.name ASC
      `,
      [rid, groupId]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("menu group categories GET error", e);
    res.status(500).json({ error: "Failed to load group categories" });
  }
});

// DELETE /menu-groups/:id/categories/:categoryId
router.delete("/:id/categories/:categoryId", async (req, res) => {
  try {
    const rid = ridOf(req);
    if (!rid) return res.status(400).json({ error: "Missing rid" });

    const groupId = Number(req.params.id);
    const categoryId = Number(req.params.categoryId);

    if (!groupId || !categoryId) {
      return res.status(400).json({ error: "Missing group/category" });
    }

    await req.qRun(
      `
      DELETE FROM public.menu_group_categories
      WHERE restaurant_id = ?
        AND menu_group_id = ?
        AND category_id = ?
      `,
      [rid, groupId, categoryId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("menu group remove category error", e);
    res.status(500).json({ error: "Failed to remove category" });
  }
});

module.exports = router;