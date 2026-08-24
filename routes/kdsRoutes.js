// backend/routes/kdsRoutes.js
const express = require("express");
const router = express.Router();
const {
  authenticateToken,
} = require("../middleware/authMiddleware");
const { qAll, qGet, qRun, kind } = require("../dbCompat");
const { loadMembership } = require("../middleware/tenantMembership");

const {
  PERMISSIONS,
  requirePermission,
} = require(
  "../middleware/accessControl"
);

router.use(authenticateToken);

router.use((req, res, next) => {
  // 🔒 KDS printer/feed tokens NEVER load memberships
  if (req.user?.scope === "kds_only") {
    return next();
  }

  return loadMembership(req, res, next);
});
function normalizeStationKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function normalizeKdsStation(v) {
  const s = normalizeStationKey(v);

  if (s === "meal" || s === "meals" || s === "food" || s === "kitchen") return "meals";
  if (s === "drink" || s === "drinks" || s === "bar") return "drinks";
  if (s === "dessert" || s === "desserts") return "desserts";

  return s;
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function normalizeText(v) {
  return String(v || "").trim().toLowerCase();
}

function formatModsLine(options, note) {
  const parts = [];

  const obj = safeJson(options);
  if (obj && typeof obj === "object") {
    const source = obj.display || obj.raw || obj.meta || obj;

    for (const [k, v] of Object.entries(source)) {
      if (v == null) continue;

      if (typeof v === "boolean") {
        if (v) parts.push(String(k).trim());
        continue;
      }

      const key = String(k || "").trim();
      const val = String(v || "").trim();
      if (!val) continue;

      if (/bread/i.test(key)) parts.push(`${val} bread`);
      else parts.push(val);
    }
  }

  const n = String(note || "").trim();
  if (n) parts.push(n);

  return Array.from(new Set(parts.map((x) => x.trim()).filter(Boolean))).join(" • ");
}

function requireItemStatePermission(
  req,
  res,
  next
) {
  let permission =
    PERMISSIONS.KDS_RESTORE;

  if (
    req.body?.is_hidden === true
  ) {
    permission =
      PERMISSIONS.KDS_COMPLETE;
  } else if (
    req.body?.is_working === true
  ) {
    permission =
      PERMISSIONS.KDS_ACCEPT;
  }

  return requirePermission(
    permission
  )(req, res, next);
}

/**
 * GET /kds/live
 * Headers required:
 *  - x-kds-device: deviceId (unique per tablet)
 *  - x-station-key: station key (e.g. meals, drinks, desserts, roast, pizzas)
 *
 * Returns cards grouped by batch_id (each submit = new card)
 */
router.get(
  "/live",
  requirePermission(
    PERMISSIONS.KDS_VIEW
  ),async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });

    const deviceId = String(req.headers["x-kds-device"] || "").trim();
    if (!deviceId) return res.status(400).json({ error: "Missing x-kds-device" });

    const stationKey = normalizeStationKey(req.headers["x-station-key"] || req.query.station || "");
    if (!stationKey) return res.status(400).json({ error: "Missing x-station-key (or ?station=...)" });

    const isBase = ["meals", "drinks", "desserts"].includes(stationKey);

    if (kind !== "pg") {
      return res.status(500).json({ error: "KDS live feed currently requires Postgres." });
    }

    const rows = await qAll(
  `
  WITH src AS (
    SELECT
      o.id,
      o.batch_id,
      o.table_number,
      o.item_name AS meal_name,
      o.category_id,
      o.quantity,
      o.total_price,
      o.paid,
      o.order_status,
      o.created_at,
      o.options,
      o.note,
      o.is_starred,
      o.table_allergy_codes,
      o.item_allergen_contains,
      o.allergen_conflicts,
      o.strict_cross_contamination,
      o.table_covers,

      COALESCE(
        NULLIF(LOWER(TRIM(ob.order_type)), ''),
        CASE
          WHEN LOWER(TRIM(COALESCE(o.table_number, ''))) = 'delivery' THEN 'delivery'
          WHEN LOWER(TRIM(COALESCE(o.table_number, ''))) = 'takeaway' THEN 'takeaway'
          ELSE 'dine-in'
        END
      ) AS batch_order_type,

      ob.pickup_number AS pickup_number,
      ob.delivery_status AS delivery_status,
      ob.delivery_code AS delivery_code,

      c.name    AS cat_name,
      c.type    AS cat_type,
      c.station AS cat_station,

      CASE
        WHEN lower(coalesce(c.type, '')) LIKE 'drink%'
          OR lower(coalesce(o.item_type, '')) LIKE 'drink%'
          THEN 'drinks'
        WHEN lower(coalesce(c.type, '')) LIKE 'dessert%'
          OR lower(coalesce(o.item_type, '')) LIKE 'dessert%'
          THEN 'desserts'
        ELSE 'meals'
      END AS base_key,

      CASE
  WHEN lower(coalesce(c.type, '')) LIKE 'drink%'
    OR lower(coalesce(o.item_type,'')) LIKE 'drink%'
    THEN 'drinks'
  WHEN lower(coalesce(c.type, '')) LIKE 'dessert%'
    OR lower(coalesce(o.item_type,'')) LIKE 'dessert%'
    THEN 'desserts'
  WHEN lower(coalesce(c.station, '')) <> ''
    THEN lower(regexp_replace(regexp_replace(trim(c.station), '\\s+','-','g'), '[^a-z0-9-]','','g'))
  ELSE 'meals'
END AS derived_station_key

    FROM public.pos_orders o
    LEFT JOIN public.categories c
      ON c.id = o.category_id
     AND c.restaurant_id = o.restaurant_id
    LEFT JOIN public.order_batches ob
      ON ob.id = o.batch_id
     AND ob.restaurant_id = o.restaurant_id
    WHERE o.restaurant_id = $1
  AND o.batch_id IS NOT NULL
  AND o.kds_archived_at IS NULL
  AND lower(coalesce(o.order_status,'')) IN ('pending','open')
  AND (
    COALESCE(o.paid, 0) = 0
    OR o.created_at >= NOW() - INTERVAL '12 hours'
  )
  )
  SELECT *
  FROM src s
  WHERE
    (
      ($2::boolean = true  AND s.base_key = $3)
      OR
      ($2::boolean = false AND s.derived_station_key = $3)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.kds_station_ack a
      WHERE a.restaurant_id = $1
        AND a.batch_id = s.batch_id
        AND a.station_key = $3
        AND a.device_id = $4
    )
  ORDER BY s.created_at ASC, s.id ASC
  `,
  [rid, isBase, stationKey, deviceId]
);
    const batchIds = Array.from(
  new Set((rows || []).map(r => String(r.batch_id || "").trim()).filter(isUuid))
);

let stateRows = [];
if (batchIds.length) {
  stateRows = await qAll(
    `
    SELECT
      batch_id,
      item_name,
      mods_line,
      is_working,
      is_hidden
    FROM public.kds_item_state
    WHERE restaurant_id = $1
      AND station_key = $2
      AND batch_id = ANY($3::uuid[])
    `,
    [rid, stationKey, batchIds]
  );
}

const stateMap = new Map(
  stateRows.map((s) => {
    const key = [
      String(s.batch_id || "").trim(),
      normalizeText(s.item_name),
      normalizeText(s.mods_line),
    ].join("::");

    return [key, {
      is_working: !!s.is_working,
      is_hidden: !!s.is_hidden,
    }];
  })
);
    console.log("LIVE ROW SAMPLE", rows?.[0]);

    const groups = new Map();

    for (const r of rows || []) {
      const key = r.batch_id || `row-${r.id}`;

      if (!groups.has(key)) {
  groups.set(key, {
    id: key,
    batch_id: r.batch_id,
    table_number: String(r.table_number || "").trim(),
    pickup_number: r.pickup_number != null ? Number(r.pickup_number) : null,
    order_type: String(r.batch_order_type || "").trim().toLowerCase() || "dine-in",
    delivery_status: r.delivery_status || null,
    delivery_code: r.delivery_code || null,
    created_at: r.created_at,
    order_status: r.order_status || "pending",
    paid: 1,
          table_allergy_codes: Array.isArray(safeJson(r.table_allergy_codes))
            ? safeJson(r.table_allergy_codes)
            : [],
          allergen_conflicts: Array.isArray(safeJson(r.allergen_conflicts))
            ? safeJson(r.allergen_conflicts)
            : [],
          strict_cross_contamination: !!r.strict_cross_contamination,
          table_covers: Number(r.table_covers || 1),
          items: [],
        });
      }

      const g = groups.get(key);

      const rowTableAllergies = Array.isArray(safeJson(r.table_allergy_codes))
        ? safeJson(r.table_allergy_codes)
        : [];

      const rowConflicts = Array.isArray(safeJson(r.allergen_conflicts))
        ? safeJson(r.allergen_conflicts)
        : [];

      g.table_allergy_codes = Array.from(
        new Set([...(g.table_allergy_codes || []), ...rowTableAllergies])
      );

      g.allergen_conflicts = Array.from(
        new Set([...(g.allergen_conflicts || []), ...rowConflicts])
      );

      if (r.strict_cross_contamination) {
        g.strict_cross_contamination = true;
      }

      if (r.table_covers) {
        g.table_covers = Number(r.table_covers || g.table_covers || 1);
      }

      const modsLine = formatModsLine(r.options, r.note);

const itemStateKey = [
  String(r.batch_id || "").trim(),
  normalizeText(r.meal_name || ""),
  normalizeText(modsLine),
].join("::");

const savedState = stateMap.get(itemStateKey) || {
  is_working: false,
  is_hidden: false,
};

g.items.push({
  id: r.id,
  meal_name: r.meal_name || "",
  item_name: r.meal_name || "",
  quantity: Number(r.quantity || 1),
  total_price: Number(r.total_price || 0),
  category: r.base_key || "meals",
  category_id: r.category_id ?? null,
  options: safeJson(r.options),
  note: r.note ?? null,
  is_starred: !!r.is_starred,
  is_priority: !!r.is_starred,
  table_allergy_codes: safeJson(r.table_allergy_codes) || [],
  item_allergen_contains: safeJson(r.item_allergen_contains) || [],
  allergen_conflicts: safeJson(r.allergen_conflicts) || [],
  strict_cross_contamination: !!r.strict_cross_contamination,
  table_covers: Number(r.table_covers || 1),

  kds_mods_line: modsLine,
  kds_is_working: savedState.is_working,
  kds_is_hidden: savedState.is_hidden,
});

      if (Number(r.paid || 0) === 0) g.paid = 0;
    }

    const out = Array.from(groups.values());
    console.log("LIVE RESPONSE SAMPLE", JSON.stringify(out?.[0], null, 2));

    return res.json(out);
  } catch (e) {
    console.error("❌ GET /kds/live failed:", e);
    return res.status(500).json({ error: "Failed to load KDS live orders" });
  }
});

// ACK (hide a card for THIS device + THIS station)
router.post(
  "/live/:batchId/ack",
  requirePermission(
    PERMISSIONS.KDS_ACCEPT
  ),
  async (req, res) => {
    try {
      const rid = Number(
        req.tenantRid || 0
      );

      const batchId = String(
        req.params.batchId || ""
      ).trim();

      const deviceId = String(
        req.headers["x-kds-device"] || ""
      ).trim();

      if (!rid) {
        return res.status(401).json({
          error: "Missing tenantRid",
        });
      }

      if (!deviceId) {
        return res.status(400).json({
          error: "Missing x-kds-device",
        });
      }

      if (!isUuid(batchId)) {
        return res.status(400).json({
          error:
            "Invalid batchId (must be uuid)",
        });
      }

      /*
       * SECURITY BOUNDARY
       *
       * A syntactically valid UUID is NOT enough.
       *
       * The batch must actually belong to the
       * authenticated restaurant.
       */
      const ownedBatch = await qGet(
  `
  SELECT id
  FROM public.order_batches
  WHERE restaurant_id = $1
    AND id = $2::uuid
  LIMIT 1
  `,
  [
    rid,
    batchId,
  ]
);

if (!ownedBatch) {
  return res.status(404).json({
    error: "KDS batch not found",
  });
}

      const stationKeyRaw =
        req.headers["x-station-key"] ||
        req.query.station ||
        "";

      const one =
        normalizeStationKey(
          stationKeyRaw
        );

      const stationsFromBody =
        Array.isArray(
          req.body?.stations
        )
          ? req.body.stations
          : [];

      const many =
        stationsFromBody
          .map(normalizeStationKey)
          .filter(Boolean);

      const stationKeys =
        many.length
          ? many
          : one
            ? [one]
            : [];

      if (!stationKeys.length) {
        return res.status(400).json({
          error:
            "Missing station key(s)",
        });
      }

      for (const sk of stationKeys) {
        await qRun(
          `
          INSERT INTO public.kds_station_ack (
            restaurant_id,
            device_id,
            batch_id,
            station_key
          )
          VALUES (
            $1,
            $2,
            $3::uuid,
            $4
          )
          ON CONFLICT (
            restaurant_id,
            device_id,
            batch_id,
            station_key
          )
          DO UPDATE SET
            acked_at = now()
          `,
          [
            rid,
            deviceId,
            batchId,
            sk,
          ]
        );
      }

      return res.json({
        success: true,
        batchId,
        stationKeys,
      });
    } catch (e) {
      console.error(
        "❌ POST /kds/live/:batchId/ack failed:",
        e
      );

      return res.status(500).json({
        error:
          "Failed to ack KDS order",
      });
    }
  }
);

router.post(
  "/live/ack-bulk",
  requirePermission(
    PERMISSIONS.KDS_ACCEPT
  ),
  async (req, res) => {
    try {
      const rid =
        Number(
          req.tenantRid || 0
        );

      const deviceId =
        String(
          req.headers[
            "x-kds-device"
          ] || ""
        ).trim();

      if (!rid) {
        return res.status(401).json({
          error:
            "Missing tenantRid",
        });
      }

      if (!deviceId) {
        return res.status(400).json({
          error:
            "Missing x-kds-device",
        });
      }

      const rows =
        Array.isArray(
          req.body?.rows
        )
          ? req.body.rows
          : [];

      /*
       * Collect only syntactically valid UUIDs.
       */
      const requestedBatchIds =
        Array.from(
          new Set(
            rows
              .map((r) =>
                String(
                  r?.batch_id || ""
                ).trim()
              )
              .filter(isUuid)
          )
        );

      if (
        !requestedBatchIds.length
      ) {
        return res.json({
          success: true,
          processed: 0,
        });
      }

      /*
       * SECURITY BOUNDARY
       *
       * Never create ACK state merely because
       * the browser supplied a valid UUID.
       *
       * Resolve batch ownership from PostgreSQL.
       */
      const ownedRows =
        await qAll(
          `
          SELECT id
          FROM public.order_batches
          WHERE restaurant_id = $1
            AND id =
              ANY($2::uuid[])
          `,
          [
            rid,
            requestedBatchIds,
          ]
        );

      const ownedBatchIds =
        new Set(
          (ownedRows || []).map(
            (row) =>
              String(row.id)
          )
        );

      let processed = 0;

      for (const r of rows) {
        const batchId =
          String(
            r?.batch_id || ""
          ).trim();

        if (
          !isUuid(batchId)
        ) {
          continue;
        }

        /*
         * Foreign/nonexistent batches are ignored.
         * Most importantly: no state is written.
         */
        if (
          !ownedBatchIds.has(
            batchId
          )
        ) {
          continue;
        }

        const stations =
          Array.isArray(
            r?.stations
          )
            ? r.stations
            : [];

        const normalizedStations =
          Array.from(
            new Set(
              stations
                .map(
                  normalizeStationKey
                )
                .filter(Boolean)
            )
          );

        for (
          const stationKey
          of normalizedStations
        ) {
          await qRun(
            `
            INSERT INTO public.kds_station_ack (
              restaurant_id,
              device_id,
              batch_id,
              station_key
            )
            VALUES (
              $1,
              $2,
              $3::uuid,
              $4
            )
            ON CONFLICT (
              restaurant_id,
              device_id,
              batch_id,
              station_key
            )
            DO UPDATE SET
              acked_at = now()
            `,
            [
              rid,
              deviceId,
              batchId,
              stationKey,
            ]
          );

          processed += 1;
        }
      }

      return res.json({
        success: true,
        processed,
      });
    } catch (e) {
      console.error(
        "❌ POST /kds/live/ack-bulk failed:",
        e
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to bulk ack",
        });
    }
  }
);

router.post(
  "/live/:batchId/unack",
  requirePermission(
    PERMISSIONS.KDS_RESTORE
  ), async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const deviceId = String(req.headers["x-kds-device"] || "").trim();
    const { batchId } = req.params;

    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });
    if (!deviceId) return res.status(400).json({ error: "Missing x-kds-device" });
    if (!isUuid(batchId)) return res.status(400).json({ error: "Invalid batchId" });

    const stations = Array.isArray(req.body?.stations) ? req.body.stations : [];

    if (stations.length) {
      for (const stRaw of stations) {
        const st = normalizeStationKey(stRaw);
        if (!st) continue;
        await qRun(
          `
          DELETE FROM public.kds_station_ack
          WHERE restaurant_id = $1 AND device_id = $2 AND batch_id = $3::uuid AND station_key = $4
          `,
          [rid, deviceId, batchId, st]
        );
      }
    } else {
      await qRun(
        `
        DELETE FROM public.kds_station_ack
        WHERE restaurant_id = $1 AND device_id = $2 AND batch_id = $3::uuid
        `,
        [rid, deviceId, batchId]
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error("❌ POST /kds/live/:batchId/unack failed:", e);
    res.status(500).json({ error: "Failed to unack" });
  }
});

// kitchen pause status (tenant safe)
router.get(
  "/kitchen/pause-status",
  requirePermission(
    PERMISSIONS.KDS_VIEW
  ), async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });

    const row = await qGet(
      `SELECT is_paused FROM public.kitchen_state WHERE restaurant_id = $1`,
      [rid]
    );

    res.json({ is_paused: !!row?.is_paused });
  } catch (e) {
    console.error("❌ GET /kds/kitchen/pause-status failed:", e);
    res.status(500).json({ error: "Failed to load pause status" });
  }
});

router.put(
  "/kitchen/pause-status",
  requirePermission(
    PERMISSIONS.KDS_PAUSE
  ), async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });

    const next = !!req.body?.is_paused;

    await qRun(
      `
      INSERT INTO public.kitchen_state (restaurant_id, is_paused, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (restaurant_id)
      DO UPDATE SET is_paused = EXCLUDED.is_paused, updated_at = now()
      `,
      [rid, next]
    );

    res.json({ success: true, is_paused: next });
  } catch (e) {
    console.error("❌ PUT /kds/kitchen/pause-status failed:", e);
    res.status(500).json({ error: "Failed to update pause status" });
  }
});

// PATCH /pos/orders/:id/star
router.patch(
  "/orders/:id/star",
  requirePermission(
    PERMISSIONS.KDS_PRIORITY
  ),async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const id = Number(req.params.id || 0);
    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });
    if (!id) return res.status(400).json({ error: "Invalid id" });

    // if body has { is_starred: true/false } we set it, otherwise toggle
    const hasExplicit = typeof req.body?.is_starred === "boolean";

    const row = await qGet(
      `SELECT is_starred FROM public.pos_orders WHERE restaurant_id = $1 AND id = $2`,
      [rid, id]
    );
    if (!row) return res.status(404).json({ error: "Order line not found" });

    const next = hasExplicit ? !!req.body.is_starred : !row.is_starred;

    await qRun(
      `UPDATE public.pos_orders
       SET is_starred = $3
       WHERE restaurant_id = $1 AND id = $2`,
      [rid, id, next]
    );

    res.json({ success: true, id, is_starred: next });
  } catch (e) {
    console.error("❌ PATCH /pos/orders/:id/star failed:", e);
    res.status(500).json({ error: "Failed to toggle star" });
  }
});

router.put(
  "/live/item-state",
  requireItemStatePermission, async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const deviceId = String(req.headers["x-kds-device"] || "").trim();
    const stationKey = normalizeStationKey(req.headers["x-station-key"] || req.body?.station_key || "");

    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });
    if (!deviceId) return res.status(400).json({ error: "Missing x-kds-device" });
    if (!stationKey) return res.status(400).json({ error: "Missing station key" });

    const batchId = String(req.body?.batch_id || "").trim();
    const itemName = String(req.body?.item_name || "").trim();
    const modsLine = String(req.body?.mods_line || "").trim();

    if (!isUuid(batchId)) return res.status(400).json({ error: "Invalid batch_id" });
    if (!itemName) return res.status(400).json({ error: "Missing item_name" });

    const isWorking = !!req.body?.is_working;
    const isHidden = !!req.body?.is_hidden;
const item = await qGet(
  `
  SELECT id
  FROM public.pos_orders
  WHERE restaurant_id = $1
    AND batch_id = $2::uuid
    AND LOWER(TRIM(item_name)) =
        LOWER(TRIM($3))
  LIMIT 1
  `,
  [
    rid,
    batchId,
    itemName,
  ]
);

if (!item) {
  return res.status(404).json({
    error: "KDS item not found",
  });
}
    await qRun(
      `
      INSERT INTO public.kds_item_state (
        restaurant_id, station_key, batch_id, item_name, mods_line,
        is_working, is_hidden, updated_by_device, updated_at
      )
      VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, now())
      ON CONFLICT (restaurant_id, station_key, batch_id, item_name, mods_line)
      DO UPDATE SET
        is_working = EXCLUDED.is_working,
        is_hidden = EXCLUDED.is_hidden,
        updated_by_device = EXCLUDED.updated_by_device,
        updated_at = now()
      `,
      [rid, stationKey, batchId, itemName, modsLine, isWorking, isHidden, deviceId]
    );

    return res.json({
      success: true,
      batch_id: batchId,
      item_name: itemName,
      mods_line: modsLine,
      is_working: isWorking,
      is_hidden: isHidden,
    });
  } catch (e) {
    console.error("❌ PUT /kds/live/item-state failed:", e);
    return res.status(500).json({ error: "Failed to save KDS item state" });
  }
});

router.post(
  "/live/:batchId/items/show-all",
  requirePermission(
    PERMISSIONS.KDS_RESTORE
  ),async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    const batchId = String(req.params.batchId || "").trim();

    if (!rid) return res.status(401).json({ error: "Missing tenantRid" });
    if (!isUuid(batchId)) return res.status(400).json({ error: "Invalid batchId" });

    const bodyStations = Array.isArray(req.body?.stations) ? req.body.stations : [];
    const normalizedStations = bodyStations.map(normalizeStationKey).filter(Boolean);

    if (normalizedStations.length) {
      await qRun(
        `
        UPDATE public.kds_item_state
        SET is_hidden = false,
            updated_at = now()
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
          AND station_key = ANY($3::text[])
        `,
        [rid, batchId, normalizedStations]
      );
    } else {
      await qRun(
        `
        UPDATE public.kds_item_state
        SET is_hidden = false,
            updated_at = now()
        WHERE restaurant_id = $1
          AND batch_id = $2::uuid
        `,
        [rid, batchId]
      );
    }

    return res.json({ success: true, batchId, stations: normalizedStations });
  } catch (e) {
    console.error("❌ POST /kds/live/:batchId/items/show-all failed:", e);
    return res.status(500).json({ error: "Failed to restore batch items" });
  }
});

module.exports = router;
