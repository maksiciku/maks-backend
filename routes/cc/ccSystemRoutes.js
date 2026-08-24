const express = require("express");
const {
  requirePlatformAdmin,
} = require("../../middleware/requirePlatformAdmin");
const { withTx } = require("../../dbCompat");

const {
  buildTenantIntegritySnapshot,
  buildMissionControlSnapshot,
  inspectOrphanPayments,
  repairOrphanPayment,
  eraseOrphanTestPayment,
  inspectMembershipMismatches,
  inspectRestaurantsWithoutOwner,
} = require("../../services/ccPlatformService");

const {
  startAttackRun,
  getAttackRun,
  listAttackRuns,
  getLatestAttackRun,
  getActiveAttackRun,
  assertAttackDatabaseSafe,
} =
  require("../../services/ccAttackMaksService");

  const {
  runRealWorldMaksScan,
} =
  require("../../services/ccRealWorldMaksService");

const {
  repairMembershipMismatch,
} = require("../../services/ccRepairService");

const router = express.Router();

/**
 * GET /cc/system/tenant-check
 * Deep tenant integrity checks
 */
router.get(
  "/tenant-check",
  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),
  async (req, res) => {
    try {
      const snapshot =
        await buildTenantIntegritySnapshot(req);

      return res.json({
        success: true,
        ...snapshot,
      });
    } catch (err) {
      console.error(
        "❌ GET /cc/system/tenant-check failed:",
        err
      );

      return res.status(500).json({
        error: "Failed to run tenant checks",
      });
    }
  }
);

/**
 * GET /cc/system/mission-control
 *
 * Returns the current live platform snapshot.
 * This read does not create a permanent scan record.
 */
router.get(
  "/mission-control",
  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),
  async (req, res) => {
    try {
      const snapshot =
        await buildMissionControlSnapshot(req);

      return res.json(snapshot);
    } catch (err) {
      console.error(
        "❌ GET /cc/system/mission-control failed:",
        err
      );

      return res.status(500).json({
        success: false,

        error:
          "Failed to build Mission Control snapshot.",

        code:
          "CC_MISSION_CONTROL_FAILED",
      });
    }
  }
);

/**
 * GET /cc/system/tenant-check/orphan-payments
 *
 * Inspects financial records whose restaurant
 * no longer exists. Read-only.
 */
router.get(
  "/tenant-check/orphan-payments",
  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),
  async (req, res) => {
    try {
      const result =
        await inspectOrphanPayments(req);

      return res.json(result);
    } catch (err) {
      console.error(
        "❌ GET orphan payments failed:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to inspect orphan payments.",
        code:
          "CC_ORPHAN_PAYMENTS_LOAD_FAILED",
      });
    }
  }
);

/**
 * GET /cc/system/tenant-check/orphan-users
 *
 * Returns users whose restaurant_id points to a restaurant
 * that no longer exists.
 *
 * Read-only: no data is changed here.
 */
router.get(
  "/tenant-check/orphan-users",
  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),
  async (req, res) => {
    try {
      const rows = await req.qAll(
  `
  SELECT
    u.id,
    u.restaurant_id,
    u.username,
    u.full_name,
    u.role,
    u.is_active,
    u.can_pos_login,
    u.force_password_reset,
    u.created_at
  FROM public.users u
  LEFT JOIN public.restaurants r
    ON r.id = u.restaurant_id
  WHERE u.restaurant_id IS NOT NULL
    AND r.id IS NULL
  ORDER BY u.id ASC
  `,
  []
);

      return res.json({
        success: true,
        total: rows.length,

        rows: rows.map((row) => ({
  id: Number(row.id),

  restaurant_id:
    row.restaurant_id != null
      ? Number(row.restaurant_id)
      : null,

  username: row.username || "",
  full_name: row.full_name || "",
  role: row.role || "",

  is_active: !!row.is_active,
  can_pos_login: !!row.can_pos_login,
  force_password_reset:
    !!row.force_password_reset,

  created_at: row.created_at || null,
})),
      });
    } catch (err) {
      console.error(
        "❌ GET orphan tenant users failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to inspect users with invalid restaurant links.",
        code: "CC_ORPHAN_USERS_LOAD_FAILED",
      });
    }
  }
);

/**
 * GET /cc/system/tenant-check/membership-mismatches
 *
 * Read-only inspection of users whose primary
 * restaurant differs from their membership restaurant.
 */
router.get(
  "/tenant-check/membership-mismatches",
  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),
  async (req, res) => {
    try {
      const result =
        await inspectMembershipMismatches(req);

      return res.json(result);
    } catch (err) {
      console.error(
        "❌ GET membership mismatches failed:",
        err
      );

      return res.status(500).json({
        success: false,

        error:
          "Failed to inspect membership mismatches.",

        code:
          "CC_MEMBERSHIP_MISMATCH_LOAD_FAILED",
      });
    }
  }
);

/**
 * POST /cc/system/tenant-repair/membership-mismatches/:membershipId
 *
 * Repairs one verified user/membership restaurant
 * mismatch transactionally.
 */
router.post(
  "/tenant-repair/membership-mismatches/:membershipId",
  requirePlatformAdmin(
    "boss",
    "admin_manager"
  ),
  async (req, res) => {
    try {
      const membershipId = Number(
        req.params.membershipId
      );

      const userId = Number(
        req.body?.user_id
      );

      const action = String(
        req.body?.action || ""
      )
        .trim()
        .toLowerCase();

      const reason = String(
        req.body?.reason || ""
      ).trim();

      if (
        !Number.isInteger(
          membershipId
        ) ||
        membershipId <= 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid membership id.",
          code:
            "CC_INVALID_MEMBERSHIP_ID",
        });
      }

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid user id.",
          code: "CC_INVALID_USER_ID",
        });
      }

      if (
        ![
          "align_user_to_membership",
          "align_membership_to_user",
        ].includes(action)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Select a valid repair direction.",
          code:
            "CC_INVALID_MEMBERSHIP_REPAIR_ACTION",
        });
      }

      if (reason.length < 10) {
        return res.status(400).json({
          success: false,
          error:
            "Enter a clear repair reason of at least 10 characters.",
          code:
            "CC_REPAIR_REASON_REQUIRED",
        });
      }

      if (
        String(req.body?.confirm || "") !==
        "REPAIR_MEMBERSHIP_MISMATCH"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Explicit repair confirmation is required.",
          code:
            "CC_REPAIR_CONFIRMATION_REQUIRED",
        });
      }

      const repaired = await withTx(
        async (tx) =>
          repairMembershipMismatch(tx, {
            membershipId,
            userId,
            action,

            adminUserId:
              req.platformAdmin.id,

            reason,
          })
      );

      return res.json({
        success: true,

        message:
          action ===
          "align_user_to_membership"
            ? `User #${userId} was aligned to ${repaired.target_restaurant_name}.`
            : `Membership #${membershipId} was aligned to ${repaired.target_restaurant_name}.`,

        repair: repaired,
      });
    } catch (err) {
      console.error(
        "❌ POST repair membership mismatch failed:",
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
            "Failed to repair membership mismatch.",

          code:
            err.code ||
            "CC_MEMBERSHIP_REPAIR_FAILED",
        });
    }
  }
);

/**
 * GET /cc/system/tenant-check/restaurants-without-owner
 *
 * Read-only inspection of restaurants without an
 * active owner or administrator.
 */
router.get(
  "/tenant-check/restaurants-without-owner",
  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),
  async (req, res) => {
    try {
      const result =
        await inspectRestaurantsWithoutOwner(req);

      return res.json(result);
    } catch (err) {
      console.error(
        "❌ GET restaurants without owner failed:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          "Failed to inspect restaurants without an owner or administrator.",
        code:
          "CC_RESTAURANTS_WITHOUT_OWNER_LOAD_FAILED",
      });
    }
  }
);

/**
 * POST /cc/system/tenant-repair/orphan-users/:userId/quarantine
 *
 * Safe repair:
 * - verifies that the restaurant link is still invalid;
 * - removes the broken restaurant_id;
 * - disables the account;
 * - preserves the user for later review/reassignment;
 * - records the action in the platform audit.
 */
router.post(
  "/tenant-repair/orphan-users/:userId/quarantine",
  requirePlatformAdmin(
    "boss",
    "admin_manager"
  ),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({
          error: "Invalid user id.",
          code: "CC_INVALID_USER_ID",
        });
      }

      if (
        String(req.body?.confirm || "") !==
        "QUARANTINE_ORPHAN_USER"
      ) {
        return res.status(400).json({
          error:
            "Explicit repair confirmation is required.",
          code: "CC_REPAIR_CONFIRMATION_REQUIRED",
        });
      }

      const result = await withTx(async (tx) => {
        /*
         * Lock the user while validating and repairing it.
         */
        const user = await tx.qGet(
  `
  SELECT
    u.id,
    u.restaurant_id,
    u.username,
    u.full_name,
    u.role,
    u.is_active,
    u.can_pos_login,
    u.force_password_reset,
    u.created_at,
    r.id AS valid_restaurant_id
  FROM public.users u
  LEFT JOIN public.restaurants r
    ON r.id = u.restaurant_id
  WHERE u.id = $1
  FOR UPDATE OF u
  `,
  [userId]
);

        if (!user?.id) {
          const error = new Error(
            "User was not found."
          );
          error.statusCode = 404;
          error.code = "CC_USER_NOT_FOUND";
          throw error;
        }

        if (user.restaurant_id == null) {
          const error = new Error(
            "This user no longer has a restaurant link."
          );
          error.statusCode = 409;
          error.code = "CC_USER_ALREADY_DETACHED";
          throw error;
        }

        if (user.valid_restaurant_id != null) {
          const error = new Error(
            "The restaurant now exists. Repair was cancelled."
          );
          error.statusCode = 409;
          error.code =
            "CC_RESTAURANT_LINK_NOW_VALID";
          throw error;
        }

        const oldRestaurantId = Number(
          user.restaurant_id
        );

        const repaired = await tx.qGet(
  `
  UPDATE public.users
  SET
    restaurant_id = NULL,
    is_active = FALSE,
    can_pos_login = FALSE,
    force_password_reset = TRUE
  WHERE id = $1
  RETURNING
    id,
    restaurant_id,
    username,
    full_name,
    role,
    is_active,
    can_pos_login,
    force_password_reset,
    created_at
  `,
  [userId]
);

        if (!repaired?.id) {
          throw new Error(
            "The orphan user could not be quarantined."
          );
        }

        await tx.qRun(
  `
  INSERT INTO public.platform_admin_audit (
    admin_user_id,
    action,
    target_restaurant_id,
    entity,
    entity_id,
    meta,
    created_at
  )
  VALUES (
    $1,
    $2,
    NULL,
    $3,
    $4,
    $5::jsonb,
    NOW()
  )
  `,
  [
    Number(req.platformAdmin.id),
    "CC_QUARANTINE_ORPHAN_USER",
    "users",
    String(userId),

    JSON.stringify({
      user_id: Number(user.id),

      user_username:
        user.username || null,

      user_full_name:
        user.full_name || null,

      previous_restaurant_id:
        oldRestaurantId,

      previous_role:
        user.role || null,

      previous_is_active:
        !!user.is_active,

      previous_can_pos_login:
        !!user.can_pos_login,

      previous_force_password_reset:
        !!user.force_password_reset,

      repaired_restaurant_id:
        null,

      repaired_is_active:
        false,

      repaired_can_pos_login:
        false,

      repaired_force_password_reset:
        true,

      reason:
        "User referenced a restaurant that does not exist",
    }),
  ]
);
   
return {
  id: Number(repaired.id),

  username:
    repaired.username || "",

  full_name:
    repaired.full_name || "",

  role:
    repaired.role || "",

  restaurant_id:
    repaired.restaurant_id != null
      ? Number(repaired.restaurant_id)
      : null,

  is_active:
    !!repaired.is_active,

  can_pos_login:
    !!repaired.can_pos_login,

  force_password_reset:
    !!repaired.force_password_reset,

  previous_restaurant_id:
    oldRestaurantId,
};
      });

      return res.json({
        success: true,
        message:
          "The user was safely quarantined.",
        user: result,
      });
    } catch (err) {
      console.error(
        "❌ POST quarantine orphan user failed:",
        err
      );

      return res
        .status(Number(err.statusCode || 500))
        .json({
          error:
            err.message ||
            "Failed to quarantine orphan user.",
          code:
            err.code ||
            "CC_ORPHAN_USER_REPAIR_FAILED",
        });
    }
  }
);

/**
 * POST /cc/system/tenant-repair/orphan-payments/:paymentId/reassign
 *
 * Preserves the payment and assigns it to a valid
 * restaurant. Runs transactionally and writes audit.
 */
router.post(
  "/tenant-repair/orphan-payments/:paymentId/reassign",
  requirePlatformAdmin(
    "boss",
    "admin_manager"
  ),
  async (req, res) => {
    try {
      const paymentId = Number(
        req.params.paymentId
      );

      const targetRestaurantId = Number(
        req.body?.target_restaurant_id
      );

      const reason = String(
        req.body?.reason || ""
      ).trim();

      if (
        !Number.isInteger(paymentId) ||
        paymentId <= 0
      ) {
        return res.status(400).json({
          error: "Invalid payment id.",
          code: "CC_INVALID_PAYMENT_ID",
        });
      }

      if (
        !Number.isInteger(
          targetRestaurantId
        ) ||
        targetRestaurantId <= 0
      ) {
        return res.status(400).json({
          error:
            "A valid destination restaurant is required.",
          code:
            "CC_TARGET_RESTAURANT_REQUIRED",
        });
      }

      if (
        String(req.body?.confirm || "") !==
        "REASSIGN_ORPHAN_PAYMENT"
      ) {
        return res.status(400).json({
          error:
            "Explicit repair confirmation is required.",
          code:
            "CC_REPAIR_CONFIRMATION_REQUIRED",
        });
      }

      if (reason.length < 10) {
        return res.status(400).json({
          error:
            "Enter a clear repair reason of at least 10 characters.",
          code:
            "CC_REPAIR_REASON_REQUIRED",
        });
      }

      const repaired = await withTx(
        async (tx) =>
          repairOrphanPayment(tx, {
            paymentId,
            targetRestaurantId,
            adminUserId:
              req.platformAdmin.id,
            reason,
          })
      );

      return res.json({
        success: true,
        message:
          `Payment #${paymentId} was safely reassigned to ${repaired.restaurant_name}.`,
        payment: repaired,
      });
    } catch (err) {
      console.error(
        "❌ POST reassign orphan payment failed:",
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
            "Failed to reassign orphan payment.",
          code:
            err.code ||
            "CC_ORPHAN_PAYMENT_REPAIR_FAILED",
        });
    }
  }
);

/**
 * GET /cc/system/health
 * Basic platform/system visibility
 * Phase 1 = app + DB + counts
 */
router.get(
  "/health",
  requirePlatformAdmin("boss", "admin_manager", "support_staff", "read_only"),
  async (req, res) => {
    try {
      const startedAt = Date.now();

      // DB ping
      const dbPing = await req.qGet(`SELECT NOW() AS now_ts`, []);
      const dbLatencyMs = Date.now() - startedAt;

      const restaurantsCount = await req.qGet(
        `SELECT COUNT(*)::int AS c FROM public.restaurants`,
        []
      );

      const activeRestaurantsCount = await req.qGet(
        `SELECT COUNT(*)::int AS c
         FROM public.restaurants
         WHERE account_status = 'active'`,
        []
      );

      const suspendedRestaurantsCount = await req.qGet(
        `SELECT COUNT(*)::int AS c
         FROM public.restaurants
         WHERE account_status = 'suspended'`,
        []
      );

      const bannedRestaurantsCount = await req.qGet(
        `SELECT COUNT(*)::int AS c
         FROM public.restaurants
         WHERE account_status = 'banned'`,
        []
      );

      const overdueBillingCount = await req.qGet(
        `SELECT COUNT(*)::int AS c
         FROM public.restaurants
         WHERE billing_status = 'overdue'`,
        []
      );

      const deviceOverLimitCount = await req.qGet(
        `
        WITH device_counts AS (
          SELECT restaurant_id, COUNT(*) FILTER (WHERE is_active = TRUE) AS device_count
          FROM public.restaurant_devices
          GROUP BY restaurant_id
        )
        SELECT COUNT(*)::int AS c
        FROM public.restaurants r
        LEFT JOIN device_counts dc ON dc.restaurant_id = r.id
        WHERE COALESCE(r.device_limit, 0) > 0
          AND COALESCE(dc.device_count, 0) > r.device_limit
        `,
        []
      );

      const recentPlatformAuditCount = await req.qGet(
        `
        SELECT COUNT(*)::int AS c
        FROM public.platform_admin_audit
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        `,
        []
      );

      const mem = process.memoryUsage();

      return res.json({
        success: true,
        server_time: dbPing?.now_ts || null,
        db_latency_ms: dbLatencyMs,
        node: {
          uptime_seconds: Math.round(process.uptime()),
          rss_mb: Number((mem.rss / 1024 / 1024).toFixed(2)),
          heap_used_mb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
          heap_total_mb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
        },
        platform: {
          restaurants_total: Number(restaurantsCount?.c || 0),
          restaurants_active: Number(activeRestaurantsCount?.c || 0),
          restaurants_suspended: Number(suspendedRestaurantsCount?.c || 0),
          restaurants_banned: Number(bannedRestaurantsCount?.c || 0),
          billing_overdue: Number(overdueBillingCount?.c || 0),
          device_over_limit: Number(deviceOverLimitCount?.c || 0),
          recent_platform_admin_actions_24h: Number(recentPlatformAuditCount?.c || 0),
        },
      });
    } catch (err) {
      console.error("❌ GET /cc/system/health failed:", err);
      return res.status(500).json({ error: "Failed to load system health" });
    }
  }
);

/**
 * GET /cc/system/recent-audit
 * Quick recent platform audit feed
 */
router.get(
  "/recent-audit",
  requirePlatformAdmin("boss", "admin_manager", "support_staff", "read_only"),
  async (req, res) => {
    try {
      const rows = await req.qAll(
        `
        SELECT
          paa.id,
          paa.action,
          paa.target_restaurant_id,
          paa.entity,
          paa.entity_id,
          paa.meta,
          paa.created_at,
          pau.email AS admin_email,
          pau.full_name AS admin_full_name,
          pau.role AS admin_role,
          r.name AS restaurant_name
        FROM public.platform_admin_audit paa
        JOIN public.platform_admin_users pau ON pau.id = paa.admin_user_id
        LEFT JOIN public.restaurants r ON r.id = paa.target_restaurant_id
        ORDER BY paa.created_at DESC, paa.id DESC
        LIMIT 100
        `,
        []
      );

      return res.json(
        (rows || []).map((r) => ({
          id: Number(r.id),
          action: r.action || "",
          target_restaurant_id: r.target_restaurant_id ? Number(r.target_restaurant_id) : null,
restaurant_name:
  r.restaurant_name ||
  r.meta?.restaurant_name ||
  (r.target_restaurant_id ? `Deleted restaurant #${r.target_restaurant_id}` : ""),
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
      console.error("❌ GET /cc/system/recent-audit failed:", err);
      return res.status(500).json({ error: "Failed to load recent platform audit" });
    }
  }
);

/**
 * GET /cc/system/dashboard
 * FULL MAKS CC dashboard payload (ONE CALL ONLY)
 */
router.get(
  "/dashboard",
  requirePlatformAdmin("boss", "admin_manager", "support_staff", "read_only"),
  async (req, res) => {
    try {
      const revenue = await req.qGet(`
        SELECT
          COUNT(*) FILTER (
            WHERE billing_status = 'active'
              AND account_status = 'active'
              AND COALESCE(monthly_price, 0) > 0
          )::int AS paying,

          COUNT(*) FILTER (WHERE billing_status = 'trial')::int AS trial,
          COUNT(*) FILTER (WHERE billing_status = 'overdue')::int AS overdue,
          COUNT(*) FILTER (WHERE billing_status = 'cancelled')::int AS cancelled,

          COALESCE(SUM(monthly_price) FILTER (
            WHERE billing_status = 'active'
              AND account_status = 'active'
              AND COALESCE(monthly_price, 0) > 0
          ), 0)::numeric AS mrr
        FROM public.restaurants
        WHERE account_status <> 'archived'
      `);

      const avgValue = await req.qGet(`
        SELECT COALESCE(AVG(monthly_price), 0)::numeric AS avg
        FROM public.restaurants
        WHERE billing_status = 'active'
          AND account_status = 'active'
          AND COALESCE(monthly_price, 0) > 0
      `);

      const health = await req.qGet(`
        WITH activity AS (
          SELECT
            r.id,
            r.account_status,
            r.billing_status,
            GREATEST(
              COALESCE(r.last_seen_at, '1970-01-01'::timestamptz),
              COALESCE(MAX(d.last_seen_at), '1970-01-01'::timestamptz),
              COALESCE(MAX(po.created_at), '1970-01-01'::timestamptz)
            ) AS last_activity_at
          FROM public.restaurants r
          LEFT JOIN public.restaurant_devices d ON d.restaurant_id = r.id
          LEFT JOIN public.pos_orders po ON po.restaurant_id = r.id
          GROUP BY r.id
        )
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE account_status = 'active')::int AS active,
          COUNT(*) FILTER (WHERE account_status = 'suspended')::int AS suspended,
          COUNT(*) FILTER (WHERE account_status = 'banned')::int AS banned,
          COUNT(*) FILTER (WHERE account_status = 'archived')::int AS archived,

          COUNT(*) FILTER (
            WHERE account_status = 'active'
              AND last_activity_at < NOW() - INTERVAL '7 days'
          )::int AS inactive_7d,

          COUNT(*) FILTER (
            WHERE account_status = 'active'
              AND last_activity_at < NOW() - INTERVAL '30 days'
          )::int AS inactive_30d
        FROM activity
      `);

      const usage = await req.qGet(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS orders_today,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS orders_7d
        FROM public.pos_orders
      `);

      const activeRestaurants = await req.qGet(`
        WITH activity AS (
          SELECT restaurant_id, MAX(created_at) AS last_order_at
          FROM public.pos_orders
          GROUP BY restaurant_id

          UNION ALL

          SELECT restaurant_id, MAX(last_seen_at) AS last_order_at
          FROM public.restaurant_devices
          GROUP BY restaurant_id
        )
        SELECT COUNT(DISTINCT restaurant_id)::int AS active_today
        FROM activity
        WHERE last_order_at >= CURRENT_DATE
      `);

      const deviceIssues = await req.qGet(`
        WITH dc AS (
          SELECT restaurant_id, COUNT(*) FILTER (WHERE is_active = TRUE) AS c
          FROM public.restaurant_devices
          GROUP BY restaurant_id
        )
        SELECT COUNT(*)::int AS over_limit
        FROM public.restaurants r
        LEFT JOIN dc ON dc.restaurant_id = r.id
        WHERE r.account_status = 'active'
          AND COALESCE(r.device_limit, 0) > 0
          AND COALESCE(dc.c, 0) > r.device_limit
      `);

      const riskCustomers = await req.qAll(`
        WITH activity AS (
          SELECT
            r.id,
            r.name,
            r.account_status,
            r.billing_status,
            r.monthly_price,
            GREATEST(
              COALESCE(r.last_seen_at, '1970-01-01'::timestamptz),
              COALESCE(MAX(d.last_seen_at), '1970-01-01'::timestamptz),
              COALESCE(MAX(po.created_at), '1970-01-01'::timestamptz)
            ) AS last_activity_at
          FROM public.restaurants r
          LEFT JOIN public.restaurant_devices d ON d.restaurant_id = r.id
          LEFT JOIN public.pos_orders po ON po.restaurant_id = r.id
          WHERE r.account_status <> 'archived'
          GROUP BY r.id
        )
        SELECT *
        FROM activity
        WHERE billing_status = 'overdue'
          OR account_status = 'suspended'
          OR (
            account_status = 'active'
            AND last_activity_at < NOW() - INTERVAL '14 days'
          )
        ORDER BY last_activity_at ASC NULLS FIRST
        LIMIT 20
      `);

      return res.json({
        success: true,
        revenue: {
          mrr: Number(revenue?.mrr || 0),
          arr: Number(revenue?.mrr || 0) * 12,
          paying: Number(revenue?.paying || 0),
          trial: Number(revenue?.trial || 0),
          overdue: Number(revenue?.overdue || 0),
          cancelled: Number(revenue?.cancelled || 0),
          avg_value: Number(avgValue?.avg || 0),
        },
        customers: {
          total: Number(health?.total || 0),
          active: Number(health?.active || 0),
          suspended: Number(health?.suspended || 0),
          banned: Number(health?.banned || 0),
          archived: Number(health?.archived || 0),
          inactive_7d: Number(health?.inactive_7d || 0),
          inactive_30d: Number(health?.inactive_30d || 0),
        },
        usage: {
          orders_today: Number(usage?.orders_today || 0),
          orders_7d: Number(usage?.orders_7d || 0),
          restaurants_active_today: Number(activeRestaurants?.active_today || 0),
        },
        system: {
          device_over_limit: Number(deviceIssues?.over_limit || 0),
        },
        risk_customers: (riskCustomers || []).map((r) => ({
          id: Number(r.id),
          name: r.name || "",
          account_status: r.account_status || "",
          billing_status: r.billing_status || "",
          last_seen_at: r.last_activity_at,
          monthly_price: Number(r.monthly_price || 0),
        })),
      });
    } catch (err) {
      console.error("❌ GET /cc/system/dashboard failed:", err);
      return res.status(500).json({ error: "Failed to load dashboard" });
    }
  }
);

router.delete(
  "/tenant-repair/orphan-payments/:paymentId",
  requirePlatformAdmin(
    "boss",
    "admin_manager"
  ),
  async (req, res) => {
    try {
      const paymentId = Number(
        req.params.paymentId
      );

      const reason = String(
        req.body?.reason || ""
      ).trim();

      if (
        !Number.isInteger(paymentId) ||
        paymentId <= 0
      ) {
        return res.status(400).json({
          error: "Invalid payment id.",
          code: "CC_INVALID_PAYMENT_ID",
        });
      }

      if (
        String(req.body?.confirm || "") !==
        "ERASE_ORPHAN_TEST_PAYMENT"
      ) {
        return res.status(400).json({
          error:
            "Explicit erase confirmation is required.",
          code:
            "CC_ERASE_CONFIRMATION_REQUIRED",
        });
      }

      const erased = await withTx(
        async (tx) =>
          eraseOrphanTestPayment(tx, {
            paymentId,
            adminUserId:
              req.platformAdmin.id,
            reason,
          })
      );

      return res.json({
        success: true,
        message:
          `Test payment #${paymentId} was erased and preserved in the platform audit.`,
        payment: erased,
      });
    } catch (err) {
      console.error(
        "❌ DELETE orphan test payment failed:",
        err
      );

      return res
        .status(Number(err.statusCode || 500))
        .json({
          success: false,
          error:
            err.message ||
            "Failed to erase orphan test payment.",
          code:
            err.code ||
            "CC_ORPHAN_TEST_PAYMENT_ERASE_FAILED",
        });
    }
  }
);

// =====================================================
// REAL WORLD MAKS
// =====================================================

/**
 * POST /cc/system/real-world-maks/scan
 *
 * Executes a LIVE, READ-ONLY integrity scan against
 * the database currently used by MAKS OS.
 *
 * This endpoint:
 *
 * - does not insert test data;
 * - does not modify customer data;
 * - does not run Attack MAKS;
 * - refuses maks_test;
 * - returns real integrity evidence.
 */
router.post(
  "/real-world-maks/scan",

  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),

  async (req, res) => {
    try {
      const result =
        await runRealWorldMaksScan(
          req
        );

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "❌ Real World MAKS scan failed:",
        err
      );

      return res
        .status(
          Number(
            err.statusCode ||
            500
          )
        )
        .json({
          success:
            false,

          error:
            err.message ||
            "Real World MAKS scan failed.",

          code:
            err.code ||
            "CC_REAL_WORLD_MAKS_FAILED",
        });
    }
  }
);

// =====================================================
// ATTACK MAKS
// =====================================================

/**
 * GET /cc/system/attack-maks
 *
 * Read-only current Attack MAKS state.
 */
router.get(
  "/attack-maks",

  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),

  async (req, res) => {
    try {
      const latest =
        await getLatestAttackRun(
          req
        );

      const active =
        getActiveAttackRun();

      let environment = {
        configured:
          false,

        database_name:
          null,

        safe:
          false,
      };

      try {
        const checked =
          await assertAttackDatabaseSafe();

        environment = {
          configured:
            true,

          database_name:
            checked.databaseName,

          safe:
            checked.databaseName ===
            "maks_test",
        };
      } catch {
        /*
         * Viewing the page should still work if
         * the attack DB has not been configured.
         */
      }

      return res.json({
        success:
          true,

        active,

        latest,

        environment,

        can_run:
          req.platformAdmin.role ===
          "boss",
      });
    } catch (err) {
      console.error(
        "❌ GET Attack MAKS status failed:",
        err
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Failed to load Attack MAKS status.",

          code:
            "CC_ATTACK_MAKS_STATUS_FAILED",
        });
    }
  }
);

/**
 * POST /cc/system/attack-maks/runs
 *
 * Starts the REAL integration attack suite.
 *
 * Boss only.
 */
router.post(
  "/attack-maks/runs",

  requirePlatformAdmin(
    "boss"
  ),

  async (req, res) => {
    try {
      const run =
        await startAttackRun(
          req
        );

      return res
        .status(202)
        .json({
          success:
            true,

          message:
            "Attack MAKS started.",

          run,
        });
    } catch (err) {
      console.error(
        "❌ POST Attack MAKS failed:",
        err
      );

      return res
        .status(
          Number(
            err.statusCode ||
            500
          )
        )
        .json({
          success:
            false,

          error:
            err.message ||
            "Failed to start Attack MAKS.",

          code:
            err.code ||
            "CC_ATTACK_MAKS_START_FAILED",

          ...(err.runId
            ? {
                run_id:
                  Number(
                    err.runId
                  ),
              }
            : {}),
        });
    }
  }
);

/**
 * GET /cc/system/attack-maks/runs
 *
 * Previous verified runs.
 */
router.get(
  "/attack-maks/runs",

  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),

  async (req, res) => {
    try {
      const runs =
        await listAttackRuns(
          req,
          req.query?.limit
        );

      return res.json({
        success:
          true,

        runs,
      });
    } catch (err) {
      console.error(
        "❌ GET Attack MAKS history failed:",
        err
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Failed to load Attack MAKS history.",
        });
    }
  }
);

/**
 * GET /cc/system/attack-maks/runs/:id
 *
 * Poll one run.
 */
router.get(
  "/attack-maks/runs/:id",

  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),

  async (req, res) => {
    try {
      const run =
        await getAttackRun(
          req,
          req.params.id
        );

      return res.json({
        success:
          true,

        run,
      });
    } catch (err) {
      console.error(
        "❌ GET Attack MAKS run failed:",
        err
      );

      return res
        .status(
          Number(
            err.statusCode ||
            500
          )
        )
        .json({
          success:
            false,

          error:
            err.message ||
            "Failed to load Attack MAKS run.",

          code:
            err.code ||
            "CC_ATTACK_MAKS_RUN_FAILED",
        });
    }
  }
);
module.exports = router;