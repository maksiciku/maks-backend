const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { requirePlatformAdmin } = require("../../middleware/requirePlatformAdmin");

const { withTx } =
  require("../../dbCompat");

const {
  transferRestaurantOwnership,
} = require("../../services/ccRepairService");

const router = express.Router();

function randomTempPassword() {
  return crypto.randomBytes(6).toString("base64url");
}

async function writePlatformAudit(req, action, targetRestaurantId, entity, entityId, meta = {}) {
  await req.qRun(
    `
    INSERT INTO public.platform_admin_audit
      (admin_user_id, action, target_restaurant_id, entity, entity_id, meta, created_at)
    VALUES
      ($1, $2, $3, $4, $5, $6::jsonb, NOW())
    `,
    [
      Number(req.platformAdmin.id),
      String(action || ""),
      targetRestaurantId != null ? Number(targetRestaurantId) : null,
      entity != null ? String(entity) : null,
      entityId != null ? String(entityId) : null,
      JSON.stringify(meta || {}),
    ]
  );
}

async function getRestaurantById(req, restaurantId) {
  return req.qGet(
    `
    SELECT
      id,
      name,
      phone,
      timezone,
      created_at,
      account_status,
      billing_status,
      plan_key,
      monthly_price,
      device_limit,
      notes_internal,
      last_seen_at
    FROM public.restaurants
    WHERE id = $1
    LIMIT 1
    `,
    [Number(restaurantId)]
  );
}

async function getRestaurantMember(req, restaurantId, userId) {
  return req.qGet(
    `
    SELECT
      rm.restaurant_id,
      rm.user_id,
      rm.role,
      rm.status,
      rm.is_active,
      rm.created_at,
      u.username,
      u.full_name,
      u.can_pos_login,
      u.is_active AS user_is_active
    FROM public.restaurant_members rm
    JOIN public.users u ON u.id = rm.user_id
    WHERE rm.restaurant_id = $1
      AND rm.user_id = $2
    LIMIT 1
    `,
    [Number(restaurantId), Number(userId)]
  );
}

async function getRestaurantDevice(req, restaurantId, deviceId) {
  return req.qGet(
    `
    SELECT
      id,
      restaurant_id,
      device_key,
      device_type,
      device_name,
      is_active,
      first_seen_at,
      last_seen_at
    FROM public.restaurant_devices
    WHERE restaurant_id = $1
      AND id = $2
    LIMIT 1
    `,
    [Number(restaurantId), Number(deviceId)]
  );
}

/**
 * GET /cc/customers
 * Platform customer list for MAKS CC
 */
router.get(
  "/",
  requirePlatformAdmin("boss", "admin_manager", "support_staff", "read_only"),
  async (req, res) => {
    try {
      const rows = await req.qAll(
        `
        WITH device_counts AS (
          SELECT
            restaurant_id,
            COUNT(*) FILTER (WHERE is_active = TRUE) AS devices_in_use,
            MAX(last_seen_at) AS devices_last_seen_at
          FROM public.restaurant_devices
          GROUP BY restaurant_id
        ),
        member_counts AS (
          SELECT
            rm.restaurant_id,
            COUNT(*) FILTER (WHERE rm.is_active = TRUE) AS active_user_count
          FROM public.restaurant_members rm
          GROUP BY rm.restaurant_id
        ),
        owner_pick AS (
          SELECT DISTINCT ON (rm.restaurant_id)
            rm.restaurant_id,
            u.id AS owner_user_id,
            u.username,
            u.full_name
          FROM public.restaurant_members rm
          JOIN public.users u ON u.id = rm.user_id
          WHERE rm.is_active = TRUE
            AND u.is_active = TRUE
            AND rm.role IN ('owner', 'admin')
          ORDER BY rm.restaurant_id,
                   CASE WHEN rm.role = 'owner' THEN 0 ELSE 1 END,
                   u.id ASC
        )
        SELECT
          r.id,
          r.name,
          r.phone,
          r.created_at,
          r.timezone,
          r.account_status,
          r.billing_status,
          r.plan_key,
          r.monthly_price,
          r.device_limit,
          r.notes_internal,
          r.last_seen_at,

          COALESCE(dc.devices_in_use, 0) AS devices_in_use,
          dc.devices_last_seen_at,

          COALESCE(mc.active_user_count, 0) AS active_user_count,

          op.owner_user_id,
          op.username AS owner_username,
          op.full_name AS owner_full_name

        FROM public.restaurants r
        LEFT JOIN device_counts dc ON dc.restaurant_id = r.id
        LEFT JOIN member_counts mc ON mc.restaurant_id = r.id
        LEFT JOIN owner_pick op ON op.restaurant_id = r.id
        ORDER BY r.created_at DESC, r.id DESC
        `
      );

      return res.json(
        (rows || []).map((r) => ({
          id: Number(r.id),
          name: r.name || "",
          phone: r.phone || "",
          timezone: r.timezone || "",
          created_at: r.created_at,
          account_status: r.account_status || "active",
          billing_status: r.billing_status || "active",
          plan_key: r.plan_key || "",
          monthly_price: Number(r.monthly_price || 0),
          device_limit: Number(r.device_limit || 0),
          devices_in_use: Number(r.devices_in_use || 0),
          active_user_count: Number(r.active_user_count || 0),
          last_seen_at: r.last_seen_at,
          devices_last_seen_at: r.devices_last_seen_at,
          owner: {
            user_id: r.owner_user_id ? Number(r.owner_user_id) : null,
            username: r.owner_username || "",
            full_name: r.owner_full_name || "",
          },
          notes_internal: r.notes_internal || "",
        }))
      );
    } catch (err) {
      console.error("❌ GET /cc/customers failed:", err);
      return res.status(500).json({ error: "Failed to load platform customers" });
    }
  }
);

/**
 * GET /cc/customers/:id
 * Single customer detail
 */
router.get(
  "/:id",

  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),

  async (req, res) => {
    try {
      const restaurantId = Number(req.params.id);
      if (!Number.isFinite(restaurantId)) {
        return res.status(400).json({ error: "Invalid restaurant id" });
      }

      const restaurant = await getRestaurantById(req, restaurantId);

      if (!restaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      const members = await req.qAll(
        `
        SELECT
          rm.user_id,
          rm.role,
          rm.status,
          rm.is_active,
          rm.created_at,
          u.username,
          u.full_name,
          u.can_pos_login,
          u.is_active AS user_is_active,
          u.force_password_reset
        FROM public.restaurant_members rm
        JOIN public.users u ON u.id = rm.user_id
        WHERE rm.restaurant_id = $1
        ORDER BY
          CASE
            WHEN rm.role = 'owner' THEN 0
            WHEN rm.role = 'admin' THEN 1
            WHEN rm.role = 'chef' THEN 2
            ELSE 3
          END,
          u.id ASC
        `,
        [restaurantId]
      );

      const devices = await req.qAll(
        `
        SELECT
          id,
          device_key,
          device_type,
          device_name,
          is_active,
          first_seen_at,
          last_seen_at
        FROM public.restaurant_devices
        WHERE restaurant_id = $1
        ORDER BY last_seen_at DESC, id DESC
        `,
        [restaurantId]
      );

      return res.json({
        restaurant: {
          id: Number(restaurant.id),
          name: restaurant.name || "",
          phone: restaurant.phone || "",
          timezone: restaurant.timezone || "",
          created_at: restaurant.created_at,
          account_status: restaurant.account_status || "active",
          billing_status: restaurant.billing_status || "active",
          plan_key: restaurant.plan_key || "",
          monthly_price: Number(restaurant.monthly_price || 0),
          device_limit: Number(restaurant.device_limit || 0),
          last_seen_at: restaurant.last_seen_at,
          notes_internal: restaurant.notes_internal || "",
        },
        members: (members || []).map((m) => ({
          user_id: Number(m.user_id),
          username: m.username || "",
          full_name: m.full_name || "",
          role: m.role || "",
          status: m.status || "",
          is_active: !!m.is_active,
          user_is_active: !!m.user_is_active,
          can_pos_login: !!m.can_pos_login,
          force_password_reset: !!m.force_password_reset,
          created_at: m.created_at,
        })),
        devices: (devices || []).map((d) => ({
          id: Number(d.id),
          device_key: d.device_key || "",
          device_type: d.device_type || "",
          device_name: d.device_name || "",
          is_active: !!d.is_active,
          first_seen_at: d.first_seen_at,
          last_seen_at: d.last_seen_at,
        })),
      });
    } catch (err) {
      console.error("❌ GET /cc/customers/:id failed:", err);
      return res.status(500).json({ error: "Failed to load customer detail" });
    }
  }
);

/**
 * POST /cc/customers/:id/transfer-ownership
 *
 * Transfers ownership to an existing active member.
 * Boss-only because this changes restaurant control.
 */
router.post(
  "/:id/transfer-ownership",
  requirePlatformAdmin("boss"),
  async (req, res) => {
    try {
      const restaurantId = Number(
        req.params.id
      );

      const newOwnerUserId = Number(
        req.body?.new_owner_user_id
      );

      const previousOwnerRole = String(
        req.body?.previous_owner_role || ""
      )
        .trim()
        .toLowerCase();

      const reason = String(
        req.body?.reason || ""
      ).trim();

      const confirm = String(
        req.body?.confirm || ""
      );

      if (
        !Number.isInteger(restaurantId) ||
        restaurantId <= 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid restaurant id.",
          code:
            "CC_INVALID_RESTAURANT_ID",
        });
      }

      if (
        !Number.isInteger(
          newOwnerUserId
        ) ||
        newOwnerUserId <= 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Select a valid new owner.",
          code:
            "CC_INVALID_NEW_OWNER",
        });
      }

      if (
        !["admin", "manager"].includes(
          previousOwnerRole
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Choose the previous owner’s new role.",
          code:
            "CC_INVALID_PREVIOUS_OWNER_ROLE",
        });
      }

      if (reason.length < 10) {
        return res.status(400).json({
          success: false,
          error:
            "Enter a clear transfer reason of at least 10 characters.",
          code:
            "CC_TRANSFER_REASON_REQUIRED",
        });
      }

      if (
        confirm !== "TRANSFER OWNERSHIP"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Type TRANSFER OWNERSHIP to confirm.",
          code:
            "CC_OWNERSHIP_CONFIRMATION_REQUIRED",
        });
      }

      const transferred = await withTx(
        async (tx) =>
          transferRestaurantOwnership(
            tx,
            {
              restaurantId,
              newOwnerUserId,
              previousOwnerRole,

              adminUserId:
                req.platformAdmin.id,

              reason,
            }
          )
      );

      return res.json({
        success: true,

        message:
          `${transferred.new_owner.full_name ||
            transferred.new_owner.username ||
            `User #${transferred.new_owner.user_id}`} is now the owner of ${transferred.restaurant_name}.`,

        transfer: transferred,
      });
    } catch (err) {
      console.error(
        "❌ POST transfer restaurant ownership failed:",
        err
      );

      return res
        .status(
          Number(err.statusCode || 500)
        )
        .json({
          success: false,

          error:
            err.message ||
            "Failed to transfer restaurant ownership.",

          code:
            err.code ||
            "CC_OWNERSHIP_TRANSFER_FAILED",
        });
    }
  }
);

/**
 * PATCH /cc/customers/:id
 * Update MAKS CC customer-level fields
 */
router.patch(
  "/:id",
  requirePlatformAdmin("boss", "admin_manager"),
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.id);
      if (!Number.isFinite(restaurantId)) {
        return res.status(400).json({ error: "Invalid restaurant id" });
      }

      const body = req.body || {};
      const allowedAccount = new Set(["active", "suspended", "banned", "archived"]);
      const allowedBilling = new Set(["active", "trial", "overdue", "cancelled"]);

      const updates = [];
      const values = [];
      let idx = 1;

      if (body.account_status !== undefined) {
        const v = String(body.account_status || "").trim().toLowerCase();
        if (!allowedAccount.has(v)) {
          return res.status(400).json({ error: "Invalid account_status" });
        }
        updates.push(`account_status = $${idx++}`);
        values.push(v);
      }

      if (body.billing_status !== undefined) {
        const v = String(body.billing_status || "").trim().toLowerCase();
        if (!allowedBilling.has(v)) {
          return res.status(400).json({ error: "Invalid billing_status" });
        }
        updates.push(`billing_status = $${idx++}`);
        values.push(v);
      }

      if (body.plan_key !== undefined) {
        updates.push(`plan_key = $${idx++}`);
        values.push(body.plan_key ? String(body.plan_key).trim() : null);
      }

      if (body.monthly_price !== undefined) {
        const v = Number(body.monthly_price);
        if (!Number.isFinite(v) || v < 0) {
          return res.status(400).json({ error: "Invalid monthly_price" });
        }
        updates.push(`monthly_price = $${idx++}`);
        values.push(v);
      }

      if (body.device_limit !== undefined) {
        const v = Number(body.device_limit);
        if (!Number.isFinite(v) || v < 0) {
          return res.status(400).json({ error: "Invalid device_limit" });
        }
        updates.push(`device_limit = $${idx++}`);
        values.push(v);
      }

      if (body.notes_internal !== undefined) {
        updates.push(`notes_internal = $${idx++}`);
        values.push(body.notes_internal != null ? String(body.notes_internal) : null);
      }

      if (!updates.length) {
        return res.status(400).json({ error: "No valid fields to update" });
      }

      values.push(restaurantId);

      const row = await req.qGet(
        `
        UPDATE public.restaurants
        SET ${updates.join(", ")}
        WHERE id = $${idx}
        RETURNING
          id, name, account_status, billing_status, plan_key,
          monthly_price, device_limit, notes_internal, last_seen_at
        `,
        values
      );

      if (!row) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      await writePlatformAudit(
        req,
        "CC_CUSTOMER_UPDATE",
        restaurantId,
        "restaurants",
        restaurantId,
        {
          updated_fields: Object.keys(body).filter((k) =>
            [
              "account_status",
              "billing_status",
              "plan_key",
              "monthly_price",
              "device_limit",
              "notes_internal",
            ].includes(k)
          ),
        }
      );

      return res.json({
        success: true,
        restaurant: {
          id: Number(row.id),
          name: row.name || "",
          account_status: row.account_status || "active",
          billing_status: row.billing_status || "active",
          plan_key: row.plan_key || "",
          monthly_price: Number(row.monthly_price || 0),
          device_limit: Number(row.device_limit || 0),
          notes_internal: row.notes_internal || "",
          last_seen_at: row.last_seen_at,
        },
      });
    } catch (err) {
      console.error("❌ PATCH /cc/customers/:id failed:", err);
      return res.status(500).json({ error: "Failed to update customer" });
    }
  }
);

/**
 * POST /cc/customers/:id/activate
 * POST /cc/customers/:id/suspend
 * POST /cc/customers/:id/ban
 * POST /cc/customers/:id/archive
 */
async function setCustomerStatus(req, res, nextStatus, actionName) {
  try {
    const restaurantId = Number(req.params.id);
    if (!Number.isFinite(restaurantId)) {
      return res.status(400).json({ error: "Invalid restaurant id" });
    }

    const row = await req.qGet(
      `
      UPDATE public.restaurants
      SET account_status = $1
      WHERE id = $2
      RETURNING id, name, account_status
      `,
      [nextStatus, restaurantId]
    );

    if (!row) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    await writePlatformAudit(
      req,
      actionName,
      restaurantId,
      "restaurants",
      restaurantId,
      {
        new_status: nextStatus,
        restaurant_name: row.name || "",
      }
    );

    return res.json({
      success: true,
      restaurant: {
        id: Number(row.id),
        name: row.name || "",
        account_status: row.account_status || nextStatus,
      },
    });
  } catch (err) {
    console.error(`❌ ${actionName} failed:`, err);
    return res.status(500).json({ error: "Failed to update customer status" });
  }
}

router.post("/:id/activate", requirePlatformAdmin("boss", "admin_manager"), (req, res) =>
  setCustomerStatus(req, res, "active", "CC_CUSTOMER_ACTIVATE")
);

router.post("/:id/suspend", requirePlatformAdmin("boss", "admin_manager"), (req, res) =>
  setCustomerStatus(req, res, "suspended", "CC_CUSTOMER_SUSPEND")
);

router.post("/:id/ban", requirePlatformAdmin("boss"), (req, res) =>
  setCustomerStatus(req, res, "banned", "CC_CUSTOMER_BAN")
);

router.post("/:id/archive", requirePlatformAdmin("boss"), (req, res) =>
  setCustomerStatus(req, res, "archived", "CC_CUSTOMER_ARCHIVE")
);

/**
 * POST /cc/customers/:id/members/:userId/reset-password
 * Safe reset: creates a temp password, never reveals old one
 */
router.post(
  "/:id/members/:userId/reset-password",
  requirePlatformAdmin("boss", "admin_manager"),
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.id);
      const userId = Number(req.params.userId);

      if (!Number.isFinite(restaurantId) || !Number.isFinite(userId)) {
        return res.status(400).json({ error: "Invalid ids" });
      }

      const member = await getRestaurantMember(req, restaurantId, userId);

      if (!member) {
        return res.status(404).json({ error: "Member not found in this restaurant" });
      }

      const tempPassword = randomTempPassword();
      const hash = bcrypt.hashSync(tempPassword, 10);

      await req.qRun(
        `
        UPDATE public.users
        SET
          password_hash = $1,
          password = $1,
          force_password_reset = TRUE
        WHERE id = $2
        `,
        [hash, userId]
      );

      await writePlatformAudit(
        req,
        "CC_MEMBER_PASSWORD_RESET",
        restaurantId,
        "users",
        userId,
        {
          username: member.username || "",
          full_name: member.full_name || "",
          role: member.role || "",
        }
      );

      return res.json({
        success: true,
        temp_password: tempPassword,
        user: {
          id: Number(userId),
          username: member.username || "",
          full_name: member.full_name || "",
          role: member.role || "",
        },
      });
    } catch (err) {
      console.error("❌ POST /cc/customers/:id/members/:userId/reset-password failed:", err);
      return res.status(500).json({ error: "Failed to reset member password" });
    }
  }
);

/**
 * POST /cc/customers/:id/members/:userId/force-password-reset
 */
router.post(
  "/:id/members/:userId/force-password-reset",
  requirePlatformAdmin("boss", "admin_manager"),
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.id);
      const userId = Number(req.params.userId);

      if (!Number.isFinite(restaurantId) || !Number.isFinite(userId)) {
        return res.status(400).json({ error: "Invalid ids" });
      }

      const member = await getRestaurantMember(req, restaurantId, userId);

      if (!member) {
        return res.status(404).json({ error: "Member not found in this restaurant" });
      }

      await req.qRun(
        `
        UPDATE public.users
        SET force_password_reset = TRUE
        WHERE id = $1
        `,
        [userId]
      );

      await writePlatformAudit(
        req,
        "CC_MEMBER_FORCE_PASSWORD_RESET",
        restaurantId,
        "users",
        userId,
        {
          username: member.username || "",
          full_name: member.full_name || "",
          role: member.role || "",
        }
      );

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ POST /cc/customers/:id/members/:userId/force-password-reset failed:", err);
      return res.status(500).json({ error: "Failed to force password reset" });
    }
  }
);

/**
 * PATCH /cc/customers/:id/members/:userId/status
 * Body: { is_active: true/false }
 */
router.patch(
  "/:id/members/:userId/status",
  requirePlatformAdmin("boss", "admin_manager"),
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.id);
      const userId = Number(req.params.userId);
      const isActive = req.body?.is_active === true;

      if (!Number.isFinite(restaurantId) || !Number.isFinite(userId)) {
        return res.status(400).json({ error: "Invalid ids" });
      }

      const member = await getRestaurantMember(req, restaurantId, userId);

      if (!member) {
        return res.status(404).json({ error: "Member not found in this restaurant" });
      }

      await req.qRun(
        `
        UPDATE public.restaurant_members
        SET is_active = $1
        WHERE restaurant_id = $2
          AND user_id = $3
        `,
        [isActive, restaurantId, userId]
      );

      await req.qRun(
        `
        UPDATE public.users
        SET is_active = $1
        WHERE id = $2
        `,
        [isActive, userId]
      );

      await writePlatformAudit(
        req,
        isActive ? "CC_MEMBER_ENABLE" : "CC_MEMBER_DISABLE",
        restaurantId,
        "users",
        userId,
        {
          username: member.username || "",
          full_name: member.full_name || "",
          role: member.role || "",
          is_active: isActive,
        }
      );

      return res.json({ success: true, is_active: isActive });
    } catch (err) {
      console.error("❌ PATCH /cc/customers/:id/members/:userId/status failed:", err);
      return res.status(500).json({ error: "Failed to update member status" });
    }
  }
);

/**
 * PATCH /cc/customers/:id/members/:userId/pos-access
 * Body: { can_pos_login: true/false }
 */
router.patch(
  "/:id/members/:userId/pos-access",
  requirePlatformAdmin("boss", "admin_manager"),
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.id);
      const userId = Number(req.params.userId);
      const canPosLogin = req.body?.can_pos_login === true;

      if (!Number.isFinite(restaurantId) || !Number.isFinite(userId)) {
        return res.status(400).json({ error: "Invalid ids" });
      }

      const member = await getRestaurantMember(req, restaurantId, userId);

      if (!member) {
        return res.status(404).json({ error: "Member not found in this restaurant" });
      }

      await req.qRun(
  `
  UPDATE public.users
  SET can_pos_login = $1
  WHERE id = $2
  `,
  [canPosLogin, userId]
);

      await writePlatformAudit(
        req,
        canPosLogin ? "CC_MEMBER_POS_ENABLE" : "CC_MEMBER_POS_DISABLE",
        restaurantId,
        "users",
        userId,
        {
          username: member.username || "",
          full_name: member.full_name || "",
          role: member.role || "",
          can_pos_login: canPosLogin,
        }
      );

      return res.json({ success: true, can_pos_login: canPosLogin });
    } catch (err) {
      console.error("❌ PATCH /cc/customers/:id/members/:userId/pos-access failed:", err);
      return res.status(500).json({ error: "Failed to update POS access" });
    }
  }
);

/**
 * PATCH /cc/customers/:id/devices/:deviceId/status
 * Body: { is_active: true/false }
 */
router.patch(
  "/:id/devices/:deviceId/status",
  requirePlatformAdmin("boss", "admin_manager"),
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.id);
      const deviceId = Number(req.params.deviceId);
      const isActive = req.body?.is_active === true;

      if (!Number.isFinite(restaurantId) || !Number.isFinite(deviceId)) {
        return res.status(400).json({ error: "Invalid ids" });
      }

      const device = await getRestaurantDevice(req, restaurantId, deviceId);

      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }

      await req.qRun(
        `
        UPDATE public.restaurant_devices
        SET is_active = $1
        WHERE restaurant_id = $2
          AND id = $3
        `,
        [isActive, restaurantId, deviceId]
      );

      await writePlatformAudit(
        req,
        isActive ? "CC_DEVICE_ENABLE" : "CC_DEVICE_DISABLE",
        restaurantId,
        "restaurant_devices",
        deviceId,
        {
          device_key: device.device_key || "",
          device_type: device.device_type || "",
          device_name: device.device_name || "",
          is_active: isActive,
        }
      );

      return res.json({ success: true, is_active: isActive });
    } catch (err) {
      console.error("❌ PATCH /cc/customers/:id/devices/:deviceId/status failed:", err);
      return res.status(500).json({ error: "Failed to update device status" });
    }
  }
);

/**
 * GET /cc/customers/:id/audit
 */
router.get(
  "/:id/audit",
  requirePlatformAdmin("boss", "admin_manager", "support_staff", "read_only"),
  async (req, res) => {
    try {
      const restaurantId = Number(req.params.id);
      if (!Number.isFinite(restaurantId)) {
        return res.status(400).json({ error: "Invalid restaurant id" });
      }

      const rows = await req.qAll(
        `
        SELECT
          a.id,
          a.action,
          a.entity,
          a.entity_id,
          a.meta,
          a.created_at,
          u.email AS admin_email,
          u.full_name AS admin_full_name,
          u.role AS admin_role
        FROM public.platform_admin_audit a
        JOIN public.platform_admin_users u
          ON u.id = a.admin_user_id
        WHERE a.target_restaurant_id = $1
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 100
        `,
        [restaurantId]
      );

      return res.json(
        (rows || []).map((r) => ({
          id: Number(r.id),
          action: r.action || "",
          entity: r.entity || "",
          entity_id: r.entity_id || "",
          meta: r.meta || {},
          created_at: r.created_at,
          admin: {
            email: r.admin_email || "",
            full_name: r.admin_full_name || "",
            role: r.admin_role || "",
          },
        }))
      );
    } catch (err) {
      console.error("❌ GET /cc/customers/:id/audit failed:", err);
      return res.status(500).json({ error: "Failed to load customer audit" });
    }
  }
);

router.delete(
  "/:id/erase-forever",
  requirePlatformAdmin("boss"),
  async (req, res) => {
    let txOpen = false;

    try {
      const restaurantId = Number(req.params.id);
      const confirm = String(req.body?.confirm || "").trim();

      if (!Number.isFinite(restaurantId)) {
        return res.status(400).json({ error: "Invalid restaurant id" });
      }

      if (confirm !== "ERASE FOREVER") {
        return res.status(400).json({
          error: 'Type "ERASE FOREVER" to confirm.',
        });
      }

      const restaurant = await getRestaurantById(req, restaurantId);
      if (!restaurant) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      await req.qRun("BEGIN");
      txOpen = true;

            await writePlatformAudit(
        req,
        "CC_CUSTOMER_ERASE_FOREVER",
        restaurantId,
        "restaurants",
        restaurantId,
        {
          restaurant_name:
            restaurant.name || "",

          warning:
            "Permanent deletion requested from MAKS CC",
        }
      );

      /*
       * =====================================================
       * EXPLICIT TENANT CLEANUP
       * =====================================================
       *
       * These tables do NOT currently have a reliable
       * ON DELETE CASCADE relationship to restaurants(id).
       *
       * Delete them explicitly before deleting the tenant.
       * =====================================================
       */

      // -----------------------------------------------------
      // Booking relationships first
      // -----------------------------------------------------

      await req.qRun(
        `
        DELETE FROM public.booking_tables bt
        USING public.tables t
        WHERE bt.table_id = t.id
          AND t.restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.booking_tables bt
        USING public.bookings b
        WHERE bt.booking_id = b.id
          AND b.restaurant_id = $1
        `,
        [restaurantId]
      );

      // -----------------------------------------------------
      // Payment dependants before payments
      // -----------------------------------------------------

      await req.qRun(
        `
        DELETE FROM public.payments
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.payment_settlements
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      // -----------------------------------------------------
      // KDS / order-batch state
      // -----------------------------------------------------

      await req.qRun(
        `
        DELETE FROM public.kds_item_state
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.kds_station_ack
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.order_batches
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      // -----------------------------------------------------
      // Operational / commercial tenant tables
      // -----------------------------------------------------

      await req.qRun(
        `
        DELETE FROM public.bookings
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.invoices
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.meal_ingredients
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.menu_items
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.org_receipt_settings
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.pos_device_sessions
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.pos_table_sessions
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.reports
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.table_map
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      await req.qRun(
        `
        DELETE FROM public.audit_log
        WHERE restaurant_id = $1
        `,
        [restaurantId]
      );

      /*
       * =====================================================
       * DELETE RESTAURANT
       * =====================================================
       *
       * Tables with proper FK CASCADE relationships are now
       * removed automatically by PostgreSQL.
       * =====================================================
       */

      const deleted =
        await req.qRun(
          `
          DELETE FROM public.restaurants
          WHERE id = $1
          `,
          [restaurantId]
        );

      if (
        Number(
          deleted?.rowCount || 0
        ) !== 1
      ) {
        const err =
          new Error(
            "Restaurant deletion did not remove exactly one restaurant."
          );

        err.code =
          "CC_RESTAURANT_DELETE_FAILED";

        throw err;
      }

      /*
       * =====================================================
       * POST-DELETE VERIFICATION
       * =====================================================
       *
       * Never commit if known tenant data remains.
       * =====================================================
       */

      const remaining =
        await req.qGet(
          `
          SELECT
            (
              SELECT COUNT(*)
              FROM public.payments
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.payment_settlements
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.bookings
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.invoices
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.kds_item_state
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.kds_station_ack
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.meal_ingredients
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.menu_items
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.order_batches
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.org_receipt_settings
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.pos_device_sessions
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.pos_table_sessions
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.reports
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.table_map
              WHERE restaurant_id = $1
            )
            +
            (
              SELECT COUNT(*)
              FROM public.audit_log
              WHERE restaurant_id = $1
            )
              AS remaining_rows
          `,
          [restaurantId]
        );

      if (
        Number(
          remaining?.remaining_rows || 0
        ) !== 0
      ) {
        const err =
          new Error(
            `Restaurant erase verification failed. ${Number(
              remaining?.remaining_rows || 0
            )} tenant rows remain.`
          );

        err.code =
          "CC_RESTAURANT_ERASE_INCOMPLETE";

        throw err;
      }

      await req.qRun("COMMIT");
      txOpen = false;

      return res.json({
        success: true,
        erased: true,
        restaurant_id: restaurantId,
        restaurant_name: restaurant.name || "",
      });
    } catch (err) {
      if (txOpen) {
        try {
          await req.qRun("ROLLBACK");
        } catch {}
      }

      console.error("❌ ERASE FOREVER failed:", err);
      return res.status(500).json({
        error: err.message || "Failed to erase customer forever",
      });
    }
  }
);

module.exports = router;