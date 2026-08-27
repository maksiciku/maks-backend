// backend/routes/orgRoutes.js
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const {
  AUTHORITIES,
  PERMISSIONS,
  requirePermission,
  requireOwner,
  canGrantPermissions,
  normalizeAuthority,
  normalizePermissions: normalizeAccessPermissions,
} = require("../middleware/accessControl");

const {
  withTx,
} = require("../dbCompat");

const {
  MaksRuntimeRoleError,
  assertCloudRuntime,
} = require("../utils/runtimeRole");

const {
  emitPromotionsSnapshotTx,
} = require("../edge/contracts/promotions");

const router = express.Router();

/*
 * Restaurant membership roles already understood across MAKS OS.
 *
 * Do not remove legacy operational roles yet:
 * - chef is used by KDS/menu routes
 * - waiter/cashier are used by POS/payment routes
 * - staff remains the general operational role
 *
 * Customer-facing UI will simplify these into:
 * Owner / Manager / Staff
 */
const MEMBERSHIP_ROLES = Object.freeze([
  "owner",
  "admin",
  "chef",
  "staff",
]);

const MEMBERSHIP_ROLE_SET = new Set(MEMBERSHIP_ROLES);

function normalizeMembershipRole(value, fallback = "") {
  const role = String(value || fallback)
    .trim()
    .toLowerCase();

  return MEMBERSHIP_ROLE_SET.has(role) ? role : "";
}

function normalizeJobTitle(value) {
  return String(value || "")
    .trim()
    .slice(0, 80);
}

function legacyRoleFor({
  authority,
  jobTitle,
}) {
  const safeAuthority =
    normalizeAuthority(
      authority,
      "staff"
    );

  /*
   * =====================================================
   * LEGACY ROLE IS COMPATIBILITY ONLY
   * =====================================================
   *
   * PostgreSQL currently permits:
   *
   *   owner
   *   admin
   *   chef
   *   staff
   *
   * Real security comes from:
   *
   *   restaurant_members.authority
   *   restaurant_members.permissions
   *
   * job_title is presentation/operational metadata and
   * must never manufacture an unsupported DB role.
   */

  if (
    safeAuthority ===
    AUTHORITIES.OWNER
  ) {
    return "owner";
  }

  /*
   * Manager authority intentionally remains legacy
   * role=staff.
   *
   * Manager power comes from authority + permissions.
   */
  if (
    safeAuthority ===
    AUTHORITIES.MANAGER
  ) {
    return "staff";
  }

  const job =
    String(
      jobTitle || ""
    )
      .trim()
      .toLowerCase();

  /*
   * Chef remains a valid legacy operational role and
   * is still understood by older KDS/menu code.
   */
  if (
    job.includes("chef") ||
    job.includes("kitchen")
  ) {
    return "chef";
  }

  /*
   * Waiter, server, cashier, supervisor, bartender, etc.
   * belong in job_title now.
   *
   * Their compatibility DB role is simply staff.
   */
  return "staff";
}

function makeInternalUsername(
  restaurantId
) {
  return [
    "pos",
    Number(restaurantId),
    Date.now(),
    crypto.randomBytes(5).toString("hex"),
  ].join("-") + "@internal.maks";
}

function isOwnerRole(value) {
  return normalizeMembershipRole(value) === "owner";
}

// receipt settings

const multer = require("multer");
const path = require("path");
const fs = require("fs");

const promoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), "uploads", String(req.tenantRid), "promotions");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = String(file.originalname || "promo")
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-");

    cb(null, `${Date.now()}-${safe}`);
  },
});

const promoUpload = multer({ storage: promoStorage });

function randomTempPassword() {
  return crypto.randomBytes(6).toString("base64url"); // ~8 chars
}

function didAffect(r) {
  if (!r) return false;
  if (typeof r.changes === "number") return r.changes > 0; // sqlite
  if (typeof r.rowCount === "number") return r.rowCount > 0; // pg
  return false;
}

function safeJsonArray(v) {
  try {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Array.isArray(v) ? v : [];
    const x = JSON.parse(v || "[]");
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

function normalizePermissions(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(
    v.map((p) => String(p || "").trim()).filter(Boolean)
  )];
}

// Helpers to keep PG booleans vs SQLite ints consistent
function b(v, kind) {
  // returns value to bind into SQL param
  if (kind === "pg") return !!v;
  return v ? 1 : 0;
}
function isTrueExpr(col, kind) {
  // returns SQL expression that evaluates truthy
  return kind === "pg"
    ? `COALESCE(${col}, false) = true`
    : `COALESCE(${col}, 0) = 1`;
}
function coalesceActive(col, kind) {
  return kind === "pg" ? `COALESCE(${col}, true)` : `COALESCE(${col}, 1)`;
}

// ========== GET /org/users ==========
// Returns team users for THIS restaurant (tenant) via restaurant_members join
router.get(
  "/users",
  requirePermission(
    PERMISSIONS.USERS_VIEW
  ),
  async (req, res) => {
    try {
      const rows = await req.qAll(
        `
        SELECT
          u.id,
          u.username,
          u.full_name,

          u.can_pos_login,
          u.can_backoffice_login,
          u.pin_label,

          rm.role,
          rm.authority,
          rm.job_title,
          rm.is_active,
          rm.permissions

        FROM public.restaurant_members rm

        JOIN public.users u
          ON u.id = rm.user_id

        WHERE rm.restaurant_id = $1

        ORDER BY
          CASE rm.authority
            WHEN 'owner' THEN 1
            WHEN 'manager' THEN 2
            ELSE 3
          END,
          u.full_name ASC,
          u.id ASC
        `,
        [req.tenantRid]
      );

      return res.json(
        (rows || []).map((user) => ({
          ...user,

          authority:
            normalizeAuthority(
              user.authority,
              "staff"
            ),

          job_title:
            user.job_title || "",

          permissions:
            safeJsonArray(
              user.permissions
            ),

          /*
           * Do not expose generated internal usernames
           * as if they are genuine employee emails.
           */
          username:
            user.can_backoffice_login
              ? user.username
              : "",
        }))
      );
    } catch (err) {
      console.error(
        "❌ GET /org/users failed:",
        err?.message || err
      );

      return res.status(500).json({
        error:
          "Failed to load users",
      });
    }
  }
);
// ========== POST /org/users ==========
// Creates a user + ALSO inserts restaurant_members (the missing link for /login)
router.post(
  "/users",
  requirePermission(
    PERMISSIONS.USERS_CREATE
  ),
  async (req, res) => {
    try {
      const restaurantId =
        Number(req.tenantRid || 0);

      if (!restaurantId) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      const fullName =
        String(
          req.body?.full_name || ""
        )
          .trim()
          .slice(0, 120);

      const authority =
        normalizeAuthority(
          req.body?.authority,
          "staff"
        );

      const jobTitle =
        normalizeJobTitle(
          req.body?.job_title
        );

      const pin =
        String(
          req.body?.pin || ""
        ).trim();

      const pinLabel =
        String(
          req.body?.pin_label ||
            "POS PIN"
        )
          .trim()
          .slice(0, 40);

      const canPosLogin =
        req.body?.can_pos_login !== false;

      const canBackofficeLogin =
        req.body?.can_backoffice_login ===
        true;

      const requestedPermissions =
        normalizeAccessPermissions(
          req.body?.permissions
        );

      if (!fullName) {
        return res.status(400).json({
          error:
            "Full name is required",
        });
      }

      if (!authority) {
        return res.status(400).json({
          error:
            "Invalid authority",
        });
      }

      if (
        canPosLogin &&
        !/^\d{4}$/.test(pin)
      ) {
        return res.status(400).json({
          error:
            "A 4-digit PIN is required for POS access.",
        });
      }

      /*
       * Owner authority can only be assigned
       * by the existing Owner.
       *
       * Managers may create Staff only.
       */
      const actorAuthority =
        normalizeAuthority(
          req.membership?.authority ||
            req.user?.authority
        );

      if (
        authority ===
          AUTHORITIES.OWNER &&
        actorAuthority !==
          AUTHORITIES.OWNER
      ) {
        return res.status(403).json({
          error:
            "Only the restaurant owner may create another owner.",
        });
      }

      if (
        authority ===
          AUTHORITIES.MANAGER &&
        actorAuthority !==
          AUTHORITIES.OWNER
      ) {
        return res.status(403).json({
          error:
            "Only the restaurant owner may assign manager authority.",
        });
      }

      /*
       * Validate permission delegation.
       */
      const grantResult =
        canGrantPermissions(
          {
            authority:
              actorAuthority,

            permissions:
              req.membership
                ?.permissions ||
              req.user
                ?.permissions ||
              [],
          },
          requestedPermissions
        );

      if (!grantResult.allowed) {
        return res.status(403).json({
          error:
            grantResult.reason ||
            "These permissions cannot be assigned.",

          forbidden:
            grantResult.forbidden ||
            [],

          unknown:
            grantResult.unknown ||
            [],
        });
      }

      /*
       * Back-office credentials are optional.
       */
      let username = String(
        req.body?.username || ""
      )
        .trim()
        .toLowerCase();

      let rawPassword = String(
        req.body?.password || ""
      );

      if (canBackofficeLogin) {
        if (!username) {
          return res.status(400).json({
            error:
              "Email is required when back-office login is enabled.",
          });
        }

        if (rawPassword.length < 8) {
          return res.status(400).json({
            error:
              "Password must be at least 8 characters when back-office login is enabled.",
          });
        }

        const duplicate =
          await req.qGet(
            `
            SELECT id
            FROM public.users
            WHERE LOWER(username) =
                  LOWER($1)
            LIMIT 1
            `,
            [username]
          );

        if (duplicate?.id) {
          return res.status(409).json({
            error:
              "That login email is already in use.",
          });
        }
      } else {
        /*
         * POS-only staff receive inaccessible internal
         * credentials to satisfy the existing users schema.
         */
        username =
          makeInternalUsername(
            restaurantId
          );

        rawPassword =
          crypto
            .randomBytes(32)
            .toString("base64url");
      }

      /*
       * PIN must be unique inside this restaurant.
       */
      if (pin) {
        const existingPins =
          await req.qAll(
            `
            SELECT
              u.pin_hash

            FROM public.restaurant_members rm

            JOIN public.users u
              ON u.id = rm.user_id

            WHERE rm.restaurant_id = $1
              AND rm.is_active = TRUE
              AND u.is_active = TRUE
              AND u.can_pos_login = TRUE
              AND u.pin_hash IS NOT NULL
            `,
            [restaurantId]
          );

        for (
          const row of
          existingPins || []
        ) {
          if (
            row?.pin_hash &&
            bcrypt.compareSync(
              pin,
              row.pin_hash
            )
          ) {
            return res.status(409).json({
              error:
                "This PIN is already used by another staff member.",
            });
          }
        }
      }

      const passwordHash =
        bcrypt.hashSync(
          rawPassword,
          10
        );

      const pinHash =
        pin
          ? bcrypt.hashSync(
              pin,
              10
            )
          : null;

      const legacyRole =
        legacyRoleFor({
          authority,
          jobTitle,
        });

      /*
       * Use a real transaction so we cannot create
       * the users row without its membership.
       */
      const { withTx } =
        require("../dbCompat");

      const created =
        await withTx(
          async (tx) => {
            const user =
              await tx.qGet(
                `
                INSERT INTO public.users (
                  username,
                  password,
                  password_hash,

                  role,
                  restaurant_id,

                  full_name,

                  is_active,

                  pin_hash,
                  pin_label,

                  can_pos_login,
                  can_backoffice_login,

                  force_password_reset,

                  created_at
                )
                VALUES (
                  $1,
                  $2,
                  $3,

                  $4,
                  $5,

                  $6,

                  TRUE,

                  $7,
                  $8,

                  $9,
                  $10,

                  $11,

                  NOW()
                )

                RETURNING id
                `,
                [
                  username,
                  passwordHash,
                  passwordHash,

                  legacyRole,
                  restaurantId,

                  fullName,

                  pinHash,
                  pinLabel || null,

                  !!canPosLogin,
                  !!canBackofficeLogin,

                  !!canBackofficeLogin,
                ]
              );

            if (!user?.id) {
              throw new Error(
                "Failed to create user"
              );
            }

            await tx.qRun(
              `
              INSERT INTO public.restaurant_members (
                restaurant_id,
                user_id,

                role,
                authority,
                job_title,

                status,
                is_active,

                permissions,

                created_at
              )
              VALUES (
                $1,
                $2,

                $3,
                $4,
                $5,

                'active',
                TRUE,

                $6::jsonb,

                NOW()
              )
              `,
              [
                restaurantId,
                Number(user.id),

                legacyRole,
                authority,
                jobTitle || null,

                JSON.stringify(
                  grantResult.permissions ||
                    []
                ),
              ]
            );

            return {
              id: Number(user.id),
            };
          }
        );

      return res.status(201).json({
        success: true,

        id: created.id,

        user: {
          id: created.id,

          full_name:
            fullName,

          authority,

          job_title:
            jobTitle,

          role:
            legacyRole,

          can_pos_login:
            !!canPosLogin,

          can_backoffice_login:
            !!canBackofficeLogin,

          permissions:
            grantResult.permissions ||
            [],

          username:
            canBackofficeLogin
              ? username
              : "",
        },
      });
    } catch (err) {
      console.error(
        "❌ POST /org/users failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to create staff member",
      });
    }
  }
);

// ========== PATCH /org/users/:id/deactivate ==========
// Commercial-safe: deactivate membership + also user flag (keeps old logic consistent)
router.patch(
  "/users/:id/deactivate",
  requirePermission(PERMISSIONS.USERS_DISABLE),
  async (req, res) => {
  try {
    const id = Number(req.params.id);
    const active = req.body?.active === true;

    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid user id" });
    if (id === Number(req.user?.id)) return res.status(400).json({ error: "Cannot deactivate yourself" });

    // ensure user is in this tenant
    const member = await req.qGet(
  `
  SELECT role, is_active
  FROM public.restaurant_members
  WHERE restaurant_id = ?
    AND user_id = ?
  `,
  [req.tenantRid, id]
);
    if (!member) return res.status(404).json({ error: "User not found" });

    if (!active && isOwnerRole(member.role)) {
  const ownerCountRow = await req.qGet(
    `
    SELECT COUNT(*) AS count
    FROM public.restaurant_members
    WHERE restaurant_id = ?
      AND role = 'owner'
      AND is_active = TRUE
    `,
    [req.tenantRid]
  );

  const activeOwnerCount = Number(
    ownerCountRow?.count ??
    ownerCountRow?.c ??
    0
  );

  if (activeOwnerCount <= 1) {
    return res.status(409).json({
      error:
        "The restaurant's only active owner cannot be deactivated.",
    });
  }
}
    await req.qRun(
      `UPDATE restaurant_members SET is_active = ? WHERE restaurant_id = ? AND user_id = ?`,
      [active, req.tenantRid, id]
    );

    await req.qRun(
      `UPDATE users SET is_active = ? WHERE id = ?`,
      [active, id]
    );

    res.json({ id, is_active: active });
  } catch (err) {
    console.error("❌ PATCH /org/users/:id/deactivate failed:", err?.message || err);
    res.status(500).json({ error: "Failed to update user" });
  }
});


// ========== POST /org/users/:id/reset-password ==========
// Use password_hash (PG schema) not "password"
router.post("/users/:id/reset-password", requirePermission(PERMISSIONS.USERS_RESET_PASSWORD), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid user id" });

    const member = await req.qGet(
      `SELECT 1 FROM restaurant_members WHERE restaurant_id = ? AND user_id = ?`,
      [req.tenantRid, id]
    );
    if (!member) return res.status(404).json({ error: "User not found" });

    const temp = randomTempPassword();
    const hash = bcrypt.hashSync(temp, 10);

    await req.qRun(
  `UPDATE users SET password_hash = ?, force_password_reset = TRUE WHERE id = ?`,
  [hash, id]
);


    res.json({ success: true, temp_password: temp });
  } catch (err) {
    console.error("❌ POST /org/users/:id/reset-password failed:", err?.message || err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});


// ========== GET /org/settings ==========
router.get(
  "/settings",
  requirePermission(
    PERMISSIONS.SETTINGS_VIEW
  ),
  async (req, res) => {
  try {
    const org = await req.qGet(
      `SELECT
  id,
  name,
  phone,
  timezone,
  stock_deduction_enabled,
  allergen_tracking_enabled,
  calorie_tracking_enabled,
  plate_cost_enabled,
  portion_tracking_mode,
  selling_mode,
  service_charge_enabled,
service_charge_rate,
manual_discounts_enabled,
max_manual_discount_percent
FROM restaurants
WHERE id = ?`,
      [req.tenantRid]
    );
    res.json(org || {});
  } catch (err) {
    console.error("❌ GET /org/settings failed:", err?.message || err);
    res.status(500).json({ error: "Failed to load org settings" });
  }
});

// ========== PUT /org/settings ==========
router.put(
  "/settings",
  requirePermission(
    PERMISSIONS.SETTINGS_EDIT
  ),
  async (req, res) => {
  try {
    const {
  name,
  phone,
  timezone,

  stock_deduction_enabled,
  allergen_tracking_enabled,
  calorie_tracking_enabled,
  plate_cost_enabled,
  portion_tracking_mode,
  selling_mode,

  service_charge_enabled,
  service_charge_rate,
  manual_discounts_enabled,
  max_manual_discount_percent,
} = req.body || {};

    const fields = [];
    const vals = [];

    if (name !== undefined) {
      fields.push("name = ?");
      vals.push(name);
    }

    if (phone !== undefined) {
      fields.push("phone = ?");
      vals.push(phone);
    }

    if (timezone !== undefined) {
      fields.push("timezone = ?");
      vals.push(timezone);
    }

    if (stock_deduction_enabled !== undefined) {
      fields.push("stock_deduction_enabled = ?");
      vals.push(!!stock_deduction_enabled);
    }

    if (allergen_tracking_enabled !== undefined) {
      fields.push("allergen_tracking_enabled = ?");
      vals.push(!!allergen_tracking_enabled);
    }

    if (calorie_tracking_enabled !== undefined) {
      fields.push("calorie_tracking_enabled = ?");
      vals.push(!!calorie_tracking_enabled);
    }

    if (plate_cost_enabled !== undefined) {
      fields.push("plate_cost_enabled = ?");
      vals.push(!!plate_cost_enabled);
    }

    if (portion_tracking_mode !== undefined) {
      const mode = String(portion_tracking_mode || "ingredients").toLowerCase();
      fields.push("portion_tracking_mode = ?");
      vals.push(["off", "manual", "ingredients"].includes(mode) ? mode : "ingredients");
    }

    if (selling_mode !== undefined) {
  const mode = String(selling_mode || "full_stock").toLowerCase();

  fields.push("selling_mode = ?");

  vals.push(
    ["pos_only", "manual_portions", "full_stock"].includes(mode)
      ? mode
      : "full_stock"
  );
}
    if (!fields.length) {
      return res.status(400).json({ error: "No fields to update" });
    }

    if (service_charge_enabled !== undefined) {
  fields.push("service_charge_enabled = ?");
  vals.push(!!service_charge_enabled);
}

if (service_charge_rate !== undefined) {
  const rate = Number(service_charge_rate);

  if (
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 100
  ) {
    return res.status(400).json({
      error:
        "Service charge rate must be between 0 and 100.",
    });
  }

  fields.push("service_charge_rate = ?");
  vals.push(Number(rate.toFixed(2)));
}

if (manual_discounts_enabled !== undefined) {
  fields.push("manual_discounts_enabled = ?");
  vals.push(!!manual_discounts_enabled);
}

if (max_manual_discount_percent !== undefined) {
  const maxDiscount =
    Number(max_manual_discount_percent);

  if (
    !Number.isFinite(maxDiscount) ||
    maxDiscount < 0 ||
    maxDiscount > 100
  ) {
    return res.status(400).json({
      error:
        "Maximum manual discount must be between 0 and 100.",
    });
  }

  fields.push(
    "max_manual_discount_percent = ?"
  );

  vals.push(
    Number(maxDiscount.toFixed(2))
  );
}

    const out = await req.qRun(
      `UPDATE restaurants SET ${fields.join(", ")} WHERE id = ?`,
      [...vals, req.tenantRid]
    );

    if (!didAffect(out)) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ PUT /org/settings failed:", err?.message || err);
    res.status(500).json({ error: "Failed to update org settings" });
  }
});

// ========== GET /org/summary ==========
router.get("/summary", requirePermission(PERMISSIONS.ANALYTICS_VIEW), async (req, res) => {
  try {
    const rid = req.tenantRid;

    const orders = await req.qGet(
      `SELECT COUNT(*) AS c FROM pos_orders WHERE restaurant_id = ? AND (paid = 0 OR paid IS NULL)`,
      [rid]
    ).catch(() => ({ c: 0 }));

    const meals = await req.qGet(
      `SELECT COUNT(*) AS c FROM meals WHERE restaurant_id = ?`,
      [rid]
    ).catch(() => ({ c: 0 }));

    const low = await req.qGet(
      `SELECT COUNT(*) AS c
       FROM stock
       WHERE restaurant_id = ?
         AND (COALESCE(quantity,0) <= COALESCE(minimum_level,0) OR COALESCE(quantity,0) <= 0)`,
      [rid]
    ).catch(() => ({ c: 0 }));

    const users = await req.qGet(
  `
  SELECT COUNT(*) AS c
  FROM public.restaurant_members rm
  JOIN public.users u ON u.id = rm.user_id
  WHERE rm.restaurant_id = ?
    AND rm.is_active = TRUE
    AND u.is_active = TRUE
  `,
  [rid]
).catch(() => ({ c: 0 }));

    res.json({
      orders: Number(orders?.c || 0),
      meals: Number(meals?.c || 0),
      lowStock: Number(low?.c || 0),
      activeUsers: Number(users?.c || 0),
    });
  } catch (err) {
    console.error("❌ GET /org/summary failed:", err?.message || err);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

// ========== GET /org/roles ==========
router.get("/roles", requirePermission(PERMISSIONS.USERS_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const rows = await req.qAll(
      `SELECT key, name, permissions
       FROM roles
       WHERE restaurant_id = ?
       ORDER BY key`,
      [req.tenantRid]
    );

    res.json(
      (rows || []).map((r) => ({
        ...r,
        permissions: safeJsonArray(r.permissions),
      }))
    );
  } catch (err) {
    console.error("❌ GET /org/roles failed:", err?.message || err);
    res.status(500).json({ error: "Failed to load roles" });
  }
});

// ========== PUT /org/roles/:key ==========
router.put("/roles/:key", requireOwner, async (req, res) => {
  try {
    const key = String(req.params.key || "").toLowerCase();
    const { permissions, name } = req.body || {};

    await req.qRun(
      `UPDATE roles SET permissions = ?, name = COALESCE(?, name) WHERE key = ? AND restaurant_id = ?`,
      [JSON.stringify(Array.isArray(permissions) ? permissions : []), name || null, key, req.tenantRid]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ PUT /org/roles/:key failed:", err?.message || err);
    res.status(500).json({ error: "Failed to update role" });
  }
});

// ========== GET /org/users/:id/permissions ==========
router.get("/users/:id/permissions", requirePermission(PERMISSIONS.USERS_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const u = await req.qGet(
      `
      SELECT rm.role, rm.permissions
      FROM public.restaurant_members rm
      WHERE rm.restaurant_id = ? AND rm.user_id = ?
      LIMIT 1
      `,
      [req.tenantRid, userId]
    );

    if (!u) return res.status(404).json({ error: "User not found" });

    res.json({
      overrides: safeJsonArray(u.permissions),
      role: u.role,
    });
  } catch (err) {
    console.error("❌ GET /org/users/:id/permissions failed:", err?.message || err);
    res.status(500).json({ error: "Failed to load permissions" });
  }
});

// ========== PUT /org/users/:id/permissions ==========
router.put(
  "/users/:id/permissions",
  requirePermission(PERMISSIONS.USERS_MANAGE_PERMISSIONS),
  async (req, res) => {
    try {
      const restaurantId = Number(req.tenantRid || 0);
      const userId = Number(req.params.id);

      if (!restaurantId) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({
          error: "Invalid user id",
        });
      }

      /*
       * Load target from THIS restaurant only.
       */
      const target = await req.qGet(
        `
        SELECT
          rm.role,
          rm.authority,
          rm.permissions,
          rm.is_active
        FROM public.restaurant_members rm
        WHERE rm.restaurant_id = $1
          AND rm.user_id = $2
        LIMIT 1
        `,
        [restaurantId, userId]
      );

      if (!target) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      const actorAuthority = normalizeAuthority(
        req.membership?.authority || req.user?.authority,
        req.membership?.role || req.user?.role
      );

      const targetAuthority = normalizeAuthority(
        target.authority,
        target.role
      );

      /*
       * Managers may manage Staff permissions only.
       * Owner accounts remain Owner-controlled.
       */
      if (
        targetAuthority === AUTHORITIES.OWNER &&
        actorAuthority !== AUTHORITIES.OWNER
      ) {
        return res.status(403).json({
          error: "Only the restaurant owner may change owner permissions.",
        });
      }

      if (
        targetAuthority === AUTHORITIES.MANAGER &&
        actorAuthority !== AUTHORITIES.OWNER
      ) {
        return res.status(403).json({
          error: "Only the restaurant owner may change manager permissions.",
        });
      }

      /*
       * Accept the current ProfilePage payload name.
       * normalizeAccessPermissions performs catalogue normalization.
       */
      const requestedPermissions = normalizeAccessPermissions(
        req.body?.overrides ?? req.body?.permissions
      );

      /*
       * IMPORTANT:
       * canGrantPermissions validates:
       * - known permission catalogue
       * - actor delegation rights
       * - permissions the actor actually possesses
       * - owner-only/non-delegable permissions
       */
      const grantResult = canGrantPermissions(
        {
          authority: actorAuthority,
          permissions:
            req.membership?.permissions ||
            req.user?.permissions ||
            [],
        },
        requestedPermissions
      );

      if (!grantResult.allowed) {
        return res.status(403).json({
          error:
            grantResult.reason ||
            "These permissions cannot be assigned.",
          forbidden: grantResult.forbidden || [],
          unknown: grantResult.unknown || [],
        });
      }

      const out = await req.qRun(
        `
        UPDATE public.restaurant_members
        SET permissions = $1::jsonb
        WHERE restaurant_id = $2
          AND user_id = $3
        `,
        [
          JSON.stringify(grantResult.permissions || []),
          restaurantId,
          userId,
        ]
      );

      if (!didAffect(out)) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      return res.json({
        success: true,
        permissions: grantResult.permissions || [],
      });
    } catch (err) {
      console.error(
        "❌ PUT /org/users/:id/permissions failed:",
        err?.message || err
      );

      return res.status(500).json({
        error: "Failed to save permissions",
      });
    }
  }
);

// ========== PUT /org/users/:id/pin ==========
router.put(
  "/users/:id/pin",
  requirePermission(PERMISSIONS.USERS_RESET_PIN),
  async (req, res) => {
    try {
      const restaurantId = Number(req.tenantRid || 0);
      const userId = Number(req.params.id);

      const {
        pin,
        pin_label,
        can_pos_login,
      } = req.body || {};

      if (!restaurantId) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({
          error: "Invalid user id",
        });
      }

      /*
       * Target must belong to THIS restaurant.
       */
      const target = await req.qGet(
        `
        SELECT
          rm.role,
          rm.authority,
          rm.is_active,
          u.is_active AS user_is_active,
          u.can_pos_login
        FROM public.restaurant_members rm
        JOIN public.users u
          ON u.id = rm.user_id
        WHERE rm.restaurant_id = $1
          AND rm.user_id = $2
        LIMIT 1
        `,
        [restaurantId, userId]
      );

      if (!target) {
        return res.status(404).json({
          error: "User not found in this venue",
        });
      }

      const actorAuthority = normalizeAuthority(
        req.membership?.authority || req.user?.authority,
        req.membership?.role || req.user?.role
      );

      const targetAuthority = normalizeAuthority(
        target.authority,
        target.role
      );

      /*
       * Manager cannot alter Manager/Owner PINs.
       */
      if (
        targetAuthority === AUTHORITIES.OWNER &&
        actorAuthority !== AUTHORITIES.OWNER
      ) {
        return res.status(403).json({
          error: "Only the restaurant owner may change the owner PIN.",
        });
      }

      if (
        targetAuthority === AUTHORITIES.MANAGER &&
        actorAuthority !== AUTHORITIES.OWNER
      ) {
        return res.status(403).json({
          error: "Only the restaurant owner may change a manager PIN.",
        });
      }

      const pinStr =
        pin != null && String(pin).trim() !== ""
          ? String(pin).trim()
          : null;

      if (pinStr && !/^\d{4}$/.test(pinStr)) {
        return res.status(400).json({
          error: "PIN must be exactly 4 digits",
        });
      }

      /*
       * PIN uniqueness is restaurant-scoped.
       *
       * Only active POS-capable accounts matter.
       * Exclude the target user themselves.
       */
      if (pinStr) {
        const existingPins = await req.qAll(
          `
          SELECT
            u.id,
            u.pin_hash
          FROM public.restaurant_members rm
          JOIN public.users u
            ON u.id = rm.user_id
          WHERE rm.restaurant_id = $1
            AND rm.user_id <> $2
            AND rm.is_active = TRUE
            AND u.is_active = TRUE
            AND u.can_pos_login = TRUE
            AND u.pin_hash IS NOT NULL
          `,
          [restaurantId, userId]
        );

        for (const row of existingPins || []) {
          if (
            row?.pin_hash &&
            bcrypt.compareSync(pinStr, row.pin_hash)
          ) {
            return res.status(409).json({
              error:
                "This PIN is already used by another staff member.",
            });
          }
        }
      }

      const sets = [];
      const vals = [];

      if (pinStr) {
        sets.push(`pin_hash = $${vals.length + 1}`);
        vals.push(
          bcrypt.hashSync(pinStr, 10)
        );
      }

      if (pin_label !== undefined) {
        sets.push(`pin_label = $${vals.length + 1}`);
        vals.push(pin_label || null);
      }

      if (can_pos_login !== undefined) {
        sets.push(`can_pos_login = $${vals.length + 1}`);
        vals.push(!!can_pos_login);
      }

      if (!sets.length) {
        return res.status(400).json({
          error: "No changes",
        });
      }

      vals.push(userId);

      const out = await req.qRun(
        `
        UPDATE public.users
        SET ${sets.join(", ")}
        WHERE id = $${vals.length}
        `,
        vals
      );

      if (!didAffect(out)) {
        return res.status(404).json({
          error: "User not found in this venue",
        });
      }

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "❌ PUT /org/users/:id/pin failed:",
        err?.message || err
      );

      return res.status(500).json({
        error: "Server error",
      });
    }
  }
);

// PUT /org/users/:id
// New MAKS authority model:
// authority = owner | manager | staff
// job_title = descriptive only
router.put(
  "/users/:id",
  requirePermission(    PERMISSIONS.USERS_EDIT
),
  async (req, res) => {
    try {
      const restaurantId =
        Number(req.tenantRid || 0);

      const userId =
        Number(req.params.id);

      if (!restaurantId) {
        return res.status(400).json({
          error: "Missing tenant",
        });
      }

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {
        return res.status(400).json({
          error: "Invalid user id",
        });
      }

      /*
       * Load the real membership/user state first.
       */
      const member =
        await req.qGet(
          `
          SELECT
            rm.id AS membership_id,
            rm.role,
            rm.authority,
            rm.job_title,
            rm.is_active,
            rm.permissions,

            u.id AS user_id,
            u.username,
            u.full_name,
            u.is_active AS user_is_active,
            u.can_pos_login,
            u.can_backoffice_login,
            u.pin_label

          FROM public.restaurant_members rm

          JOIN public.users u
            ON u.id = rm.user_id

          WHERE rm.restaurant_id = $1
            AND rm.user_id = $2

          LIMIT 1
          `,
          [
            restaurantId,
            userId,
          ]
        );

      if (!member) {
        return res.status(404).json({
          error:
            "User not found in this restaurant",
        });
      }

      /*
       * Who is performing this action?
       *
       * Authority is preferred.
       * Legacy role is fallback only.
       */
      const actorAuthority =
        normalizeAuthority(
          req.membership?.authority ||
            req.user?.authority,
          req.membership?.role ||
            req.user?.role
        );

      const currentAuthority =
        normalizeAuthority(
          member.authority,
          member.role
        );

      let nextAuthority =
        req.body?.authority !== undefined
          ? normalizeAuthority(
              req.body.authority,
              ""
            )
          : currentAuthority;

      if (
        ![
          "owner",
          "manager",
          "staff",
        ].includes(nextAuthority)
      ) {
        return res.status(400).json({
          error: "Invalid authority",
        });
      }

      /*
       * Ownership cannot be created/demoted casually
       * through the normal staff editor.
       */
      if (
        currentAuthority === "owner" &&
        nextAuthority !== "owner"
      ) {
        return res.status(403).json({
          error:
            "Restaurant ownership must be changed through the ownership transfer process.",
        });
      }

      if (
        nextAuthority === "owner" &&
        currentAuthority !== "owner"
      ) {
        return res.status(403).json({
          error:
            "Restaurant ownership must be assigned through the ownership transfer process.",
        });
      }

      /*
       * Only Owner can grant Manager authority.
       *
       * A Manager with users.* may manage Staff,
       * but cannot promote someone to Manager.
       */
      if (
        nextAuthority === "manager" &&
        currentAuthority !== "manager" &&
        actorAuthority !== "owner"
      ) {
        return res.status(403).json({
          error:
            "Only the restaurant owner may grant Manager authority.",
        });
      }

      /*
       * Manager cannot edit an Owner.
       */
      if (
        currentAuthority === "owner" &&
        actorAuthority !== "owner"
      ) {
        return res.status(403).json({
          error:
            "Only the restaurant owner may edit the owner account.",
        });
      }

      const fullName =
        req.body?.full_name !== undefined
          ? String(
              req.body.full_name || ""
            )
              .trim()
              .slice(0, 120)
          : String(
              member.full_name || ""
            ).trim();

      const jobTitle =
        req.body?.job_title !== undefined
          ? normalizeJobTitle(
              req.body.job_title
            )
          : String(
              member.job_title || ""
            ).trim();

      const isActive =
        typeof req.body?.is_active ===
        "boolean"
          ? req.body.is_active
          : member.is_active === true;

      const canPos =
        typeof req.body
          ?.can_pos_login ===
        "boolean"
          ? req.body.can_pos_login
          : member.can_pos_login === true;

      const canBackoffice =
        typeof req.body
          ?.can_backoffice_login ===
        "boolean"
          ? req.body
              .can_backoffice_login
          : member
              .can_backoffice_login ===
            true;

      const pinLabel =
        req.body?.pin_label !== undefined
          ? String(
              req.body.pin_label || ""
            )
              .trim()
              .slice(0, 40)
          : String(
              member.pin_label || ""
            ).trim();

      const pin =
        String(
          req.body?.pin || ""
        ).trim();

      if (
        pin &&
        !/^\d{4}$/.test(pin)
      ) {
        return res.status(400).json({
          error:
            "PIN must be exactly 4 digits",
        });
      }

      /*
       * Never allow the Owner account to be disabled
       * through this normal editor.
       */
      if (
        currentAuthority === "owner" &&
        !isActive
      ) {
        return res.status(403).json({
          error:
            "The restaurant owner cannot be disabled here.",
        });
      }

      /*
       * Back-office access requires an actual login
       * identity.
       *
       * POS-only users have an internal @internal.maks
       * username generated by MAKS.
       */
      if (
        canBackoffice &&
        String(
          member.username || ""
        )
          .toLowerCase()
          .endsWith(
            "@internal.maks"
          )
      ) {
        return res.status(400).json({
          error:
            "Set a real login email and password before enabling back-office access.",
          code:
            "BACKOFFICE_CREDENTIALS_REQUIRED",
        });
      }

      /*
       * Maintain legacy role temporarily so old
       * MAKS routes continue working while the
       * authority migration is completed.
       */
      const legacyRole =
        legacyRoleFor({
          authority:
            nextAuthority,

          jobTitle:
            jobTitle ||
            (nextAuthority ===
            "manager"
              ? "Manager"
              : "Team Member"),
        });

      /*
       * PIN uniqueness inside this restaurant.
       */
      let pinHash = null;

      if (pin) {
        const others =
          await req.qAll(
            `
            SELECT
              u.id,
              u.pin_hash

            FROM public.restaurant_members rm

            JOIN public.users u
              ON u.id = rm.user_id

            WHERE rm.restaurant_id = $1
              AND rm.user_id <> $2
              AND rm.is_active = TRUE
              AND u.is_active = TRUE
              AND u.can_pos_login = TRUE
              AND u.pin_hash IS NOT NULL
            `,
            [
              restaurantId,
              userId,
            ]
          );

        for (
          const row of
          others || []
        ) {
          if (
            row?.pin_hash &&
            bcrypt.compareSync(
              pin,
              row.pin_hash
            )
          ) {
            return res.status(409).json({
              error:
                "This PIN is already used by another staff member.",
            });
          }
        }

        pinHash =
          bcrypt.hashSync(
            pin,
            10
          );
      }

      /*
       * Update membership + user atomically.
       */
      const { withTx } =
        require("../dbCompat");

      await withTx(
        async (tx) => {
          await tx.qRun(
            `
            UPDATE public.restaurant_members
            SET
              role = $1,
              authority = $2,
              job_title = $3,
              is_active = $4

            WHERE restaurant_id = $5
              AND user_id = $6
            `,
            [
              legacyRole,
              nextAuthority,
              jobTitle || null,
              !!isActive,

              restaurantId,
              userId,
            ]
          );

          const userSets = [
            "full_name = $1",
            "role = $2",
            "can_pos_login = $3",
            "can_backoffice_login = $4",
            "pin_label = $5",
          ];

          const params = [
            fullName || null,
            legacyRole,
            !!canPos,
            !!canBackoffice,
            pinLabel || null,
          ];

          if (pinHash) {
            userSets.push(
              `pin_hash = $${params.length + 1}`
            );

            params.push(
              pinHash
            );
          }

          params.push(userId);

          await tx.qRun(
            `
            UPDATE public.users
            SET
              ${userSets.join(", ")}

            WHERE id =
              $${params.length}
            `,
            params
          );
        }
      );

      /*
       * Return the exact identity ProfilePage needs.
       */
      const updated =
        await req.qGet(
          `
          SELECT
            u.id,
            u.username,
            u.full_name,
            u.can_pos_login,
            u.can_backoffice_login,
            u.pin_label,

            rm.role,
            rm.authority,
            rm.job_title,
            rm.is_active,
            rm.permissions

          FROM public.restaurant_members rm

          JOIN public.users u
            ON u.id = rm.user_id

          WHERE rm.restaurant_id = $1
            AND rm.user_id = $2

          LIMIT 1
          `,
          [
            restaurantId,
            userId,
          ]
        );

      return res.json({
        success: true,

        user: {
          ...updated,

          authority:
            normalizeAuthority(
              updated?.authority,
              updated?.role
            ),

          job_title:
            updated?.job_title || "",

          /*
           * Hide internal generated login names
           * from restaurant staff UI.
           */
          username:
            updated
              ?.can_backoffice_login
              ? updated.username
              : "",

          permissions:
            safeJsonArray(
              updated?.permissions
            ),
        },
      });
    } catch (err) {
      console.error(
        "❌ PUT /org/users/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to update staff member",
      });
    }
  }
);

router.get("/kiosk-settings", requirePermission(PERMISSIONS.KIOSK_SETTINGS), async (req, res) => {
  try {
    const row = await req.qGet(
      `
      SELECT kiosk_settings, selling_mode
      FROM public.restaurants
      WHERE id = ?
      LIMIT 1
      `,
      [req.tenantRid]
    );

    const settings =
      row?.kiosk_settings && typeof row.kiosk_settings === "object"
        ? row.kiosk_settings
        : {};

    res.json({
      ...settings,
      selling_mode: row?.selling_mode || "full_stock",
    });
  } catch (err) {
    console.error("❌ GET /org/kiosk-settings failed:", err?.message || err);
    res.status(500).json({ error: "Failed to load kiosk settings" });
  }
});

router.put("/kiosk-settings", requirePermission(PERMISSIONS.KIOSK_SETTINGS), async (req, res) => {
  try {
    const body = req.body || {};

    const settings = {
      show_eat_in: body.show_eat_in !== false,
      show_takeaway: body.show_takeaway !== false,
      show_voucher: body.show_voucher !== false,
      show_prices: body.show_prices !== false,
      show_photos: body.show_photos !== false,
      visible_category_ids: Array.isArray(body.visible_category_ids)
        ? body.visible_category_ids.map(Number).filter(Number.isFinite)
        : [],
    };

    await req.qRun(
      `
      UPDATE public.restaurants
      SET kiosk_settings = ?::jsonb
      WHERE id = ?
      `,
      [JSON.stringify(settings), req.tenantRid]
    );

    res.json(settings);
  } catch (err) {
    console.error("❌ PUT /org/kiosk-settings failed:", err?.message || err);
    res.status(500).json({ error: "Failed to save kiosk settings" });
  }
});

// PATCH /org/users/:id/remove
// Body optional: { disable_pos: true }
router.patch(
  "/users/:id/remove",
  requirePermission(PERMISSIONS.USERS_REMOVE),
  async (req, res) => {
  try {
    const restaurantId = Number(req.tenantRid || req.user?.restaurant_id || 0);
    const userId = Number(req.params.id);

    if (!restaurantId) return res.status(400).json({ error: "Missing tenant" });
    if (!Number.isFinite(userId)) return res.status(400).json({ error: "Invalid user id" });

    // cannot remove yourself (prevents locking yourself out)
    if (req.user?.id && Number(req.user.id) === userId) {
      return res.status(400).json({ error: "You cannot remove yourself." });
    }

    // must be in this restaurant
    const member = await req.qGet(
      `SELECT rm.role
       FROM public.restaurant_members rm
       WHERE rm.restaurant_id = ? AND rm.user_id = ?`,
      [restaurantId, userId]
    );

    if (!member) return res.status(404).json({ error: "User not found in this restaurant" });

    if (isOwnerRole(member.role)) {
  const ownerCountRow = await req.qGet(
    `
    SELECT COUNT(*) AS count
    FROM public.restaurant_members
    WHERE restaurant_id = ?
      AND role = 'owner'
      AND is_active = TRUE
    `,
    [restaurantId]
  );

  const activeOwnerCount = Number(
    ownerCountRow?.count ??
    ownerCountRow?.c ??
    0
  );

  if (activeOwnerCount <= 1) {
    return res.status(409).json({
      error:
        "The restaurant's only active owner cannot be removed.",
    });
  }
}
    // ✅ soft-remove membership
    await req.qRun(
      `UPDATE public.restaurant_members
       SET is_active = FALSE
       WHERE restaurant_id = ? AND user_id = ?`,
      [restaurantId, userId]
    );

    // optionally disable POS login on the user record too
    const disablePos = req.body?.disable_pos !== false; // default true
    if (disablePos) {
      await req.qRun(
        `UPDATE public.users
         SET can_pos_login = FALSE, pin_hash = NULL
         WHERE id = ?`,
        [userId]
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("remove member error:", err?.message || err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ========== GET /org/receipt-settings ==========
router.get("/receipt-settings", requirePermission(PERMISSIONS.SETTINGS_VIEW), async (req, res) => {
  try {
    const row = await req.qGet(
      `
      SELECT
        receipt_name,
        receipt_address,
        receipt_email,
        receipt_phone,
        receipt_website,
        receipt_footer,
        receipt_vat_number,
receipt_show_vat,
receipt_company_number,
receipt_custom_line1,
receipt_custom_line2
      FROM public.org_receipt_settings
      WHERE restaurant_id = ?
      `,
      [req.tenantRid]
    );

    res.json(row || {});
  } catch (err) {
    console.error("❌ GET /org/receipt-settings failed:", err?.message || err);
    res.status(500).json({ error: "Failed to load receipt settings" });
  }
});

// ========== PUT /org/receipt-settings ==========
router.put(
  "/receipt-settings",
  requirePermission(PERMISSIONS.RECEIPTS_EDIT),
  async (req, res) => {
    try {
      const body = req.body || {};

      const receipt_name =
        body.receipt_name ?? null;

      const receipt_address =
        body.receipt_address ?? null;

      const receipt_email =
        body.receipt_email ?? null;

      const receipt_phone =
        body.receipt_phone ?? null;

      const receipt_website =
        body.receipt_website ?? null;

      const receipt_footer =
        body.receipt_footer ?? null;

      const receipt_vat_number =
        body.receipt_vat_number ?? null;

      const receipt_show_vat =
        body.receipt_show_vat !== false;

      const receipt_company_number =
        body.receipt_company_number ?? null;

      const receipt_custom_line1 =
        body.receipt_custom_line1 ?? null;

      const receipt_custom_line2 =
        body.receipt_custom_line2 ?? null;


      await req.qRun(
        `
        INSERT INTO public.org_receipt_settings
        (
          restaurant_id,
          receipt_name,
          receipt_address,
          receipt_email,
          receipt_phone,
          receipt_website,
          receipt_footer,
          receipt_vat_number,
          receipt_show_vat,
          receipt_company_number,
          receipt_custom_line1,
          receipt_custom_line2,
          updated_at
        )
        VALUES
        (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          NOW()
        )

        ON CONFLICT (restaurant_id)
        DO UPDATE SET

          receipt_name =
            EXCLUDED.receipt_name,

          receipt_address =
            EXCLUDED.receipt_address,

          receipt_email =
            EXCLUDED.receipt_email,

          receipt_phone =
            EXCLUDED.receipt_phone,

          receipt_website =
            EXCLUDED.receipt_website,

          receipt_footer =
            EXCLUDED.receipt_footer,

          receipt_vat_number =
            EXCLUDED.receipt_vat_number,

          receipt_show_vat =
            EXCLUDED.receipt_show_vat,

          receipt_company_number =
            EXCLUDED.receipt_company_number,

          receipt_custom_line1 =
            EXCLUDED.receipt_custom_line1,

          receipt_custom_line2 =
            EXCLUDED.receipt_custom_line2,

          updated_at = NOW()
        `,
        [
          req.tenantRid,

          receipt_name,
          receipt_address,
          receipt_email,
          receipt_phone,
          receipt_website,
          receipt_footer,

          receipt_vat_number,
          receipt_show_vat,

          receipt_company_number,
          receipt_custom_line1,
          receipt_custom_line2,
        ]
      );


      const saved =
        await req.qGet(
          `
          SELECT
            receipt_name,
            receipt_address,
            receipt_email,
            receipt_phone,
            receipt_website,
            receipt_footer,

            receipt_vat_number,
            receipt_show_vat,

            receipt_company_number,
            receipt_custom_line1,
            receipt_custom_line2

          FROM public.org_receipt_settings

          WHERE restaurant_id = ?
          `,
          [
            req.tenantRid,
          ]
        );


      return res.json(
        saved || {}
      );
    } catch (err) {
      console.error(
        "❌ PUT /org/receipt-settings failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to save receipt settings",
      });
    }
  }
);

async function ensurePromotionsTable(req) {
  await req.qRun(`
    CREATE TABLE IF NOT EXISTS public.restaurant_promotions (
      id BIGSERIAL PRIMARY KEY,
      restaurant_id BIGINT NOT NULL,
      title TEXT,
      description TEXT,
      image_url TEXT,
      display_context TEXT NOT NULL DEFAULT 'both',
      order_type TEXT NOT NULL DEFAULT 'both',
      linked_item_id BIGINT,
      linked_item_type TEXT,
      active BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await req.qRun(`ALTER TABLE public.restaurant_promotions DROP CONSTRAINT IF EXISTS restaurant_promotions_restaurant_id_key`);

  await req.qRun(`ALTER TABLE public.restaurant_promotions ADD COLUMN IF NOT EXISTS button_text TEXT DEFAULT 'View'`);
  await req.qRun(`ALTER TABLE public.restaurant_promotions ADD COLUMN IF NOT EXISTS action_type TEXT DEFAULT 'none'`);
  await req.qRun(`ALTER TABLE public.restaurant_promotions ADD COLUMN IF NOT EXISTS action_target TEXT`);
  await req.qRun(`ALTER TABLE public.restaurant_promotions ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ`);
  await req.qRun(`ALTER TABLE public.restaurant_promotions ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ`);
  await req.qRun(`ALTER TABLE public.restaurant_promotions ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);

  await req.qRun(`
  ALTER TABLE public.restaurant_promotions
  ADD COLUMN IF NOT EXISTS event_date DATE
`);

await req.qRun(`
  ALTER TABLE public.restaurant_promotions
  ADD COLUMN IF NOT EXISTS event_time TIME
`);

await req.qRun(`
  ALTER TABLE public.restaurant_promotions
  ADD COLUMN IF NOT EXISTS event_end_time TIME
`);
  await req.qRun(`
    CREATE INDEX IF NOT EXISTS idx_restaurant_promotions_rid_active
    ON public.restaurant_promotions (restaurant_id, active, sort_order)
  `);
}

router.get("/promotion", requirePermission(PERMISSIONS.PROMOTIONS_MANAGE), async (req, res) => {
  try {
    await ensurePromotionsTable(req);

    const row = await req.qGet(
      `
      SELECT *
      FROM public.restaurant_promotions
      WHERE restaurant_id = ?
      LIMIT 1
      `,
      [req.tenantRid]
    );

    res.json(row || {});
  } catch (err) {
    console.error("❌ GET /org/promotion failed:", err);
    res.status(500).json({ error: "Failed to load promotion" });
  }
});

router.get("/promotions", requirePermission(PERMISSIONS.PROMOTIONS_MANAGE), async (req, res) => {
  try {
    await ensurePromotionsTable(req);

    const rows = await req.qAll(
      `
      SELECT *
      FROM public.restaurant_promotions
      WHERE restaurant_id = ?
      ORDER BY sort_order ASC, id DESC
      `,
      [req.tenantRid]
    );

    res.json(rows || []);
  } catch (err) {
    console.error("❌ GET /org/promotions failed:", err);
    res.status(500).json({ error: "Failed to load promotions" });
  }
});

function sendPromotionAuthorityError(
  res,
  error
) {
  if (
    !(error instanceof
      MaksRuntimeRoleError)
  ) {
    return false;
  }

  return res.status(409).json({
    error:
      "Promotions can only be managed by the Cloud runtime.",

    code:
      error.code ||
      "MAKS_RUNTIME_ROLE_FORBIDDEN",
  });
}


function requireCloudPromotionAuthority(
  req,
  res,
  next
) {
  try {
    assertCloudRuntime();
    return next();
  } catch (error) {
    if (
      sendPromotionAuthorityError(
        res,
        error
      )
    ) {
      return;
    }

    return next(error);
  }
}


function promotionBool(
  value,
  fallback
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return Boolean(fallback);
  }

  if (
    typeof value ===
      "boolean"
  ) {
    return value;
  }

  const normalized =
    String(value)
      .trim()
      .toLowerCase();

  return [
    "1",
    "true",
    "yes",
    "on",
  ].includes(normalized);
}


function promotionDays(
  value,
  fallback = []
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    if (
      Array.isArray(fallback)
    ) {
      return fallback;
    }

    try {
      const parsed =
        JSON.parse(
          fallback || "[]"
        );

      return Array.isArray(parsed)
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  if (
    Array.isArray(value)
  ) {
    return value;
  }

  try {
    const parsed =
      JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
}


function promotionOptionalId(
  value,
  fallback = null
) {
  if (
    value === undefined
  ) {
    return fallback === null ||
      fallback === undefined
      ? null
      : Number(fallback);
  }

  if (
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isSafeInteger(number) &&
    number > 0
    ? number
    : null;
}


function promotionOptionalText(
  value,
  fallback = null
) {
  if (
    value === undefined
  ) {
    return fallback === null ||
      fallback === undefined
      ? null
      : String(fallback);
  }

  const text =
    String(
      value ?? ""
    ).trim();

  return text || null;
}


function promotionScalar(
  value,
  fallback = null
) {
  return value === undefined
    ? fallback
    : (
        value === ""
          ? null
          : value
      );
}


function promotionEnum(
  value,
  allowed,
  fallback
) {
  const candidate =
    String(
      value === undefined
        ? fallback
        : value
    )
      .trim()
      .toLowerCase();

  return allowed.includes(
    candidate
  )
    ? candidate
    : fallback;
}


function normalizePromotionMutation(
  body,
  existing = null,
  imageUrl
) {
  const current =
    existing || {};

  const showOnQr =
    promotionBool(
      body.show_on_qr,
      current.show_on_qr ??
        true
    );

  const showOnKiosk =
    promotionBool(
      body.show_on_kiosk,
      current.show_on_kiosk ??
        true
    );

  const showForDineIn =
    promotionBool(
      body.show_for_dine_in,
      current.show_for_dine_in ??
        true
    );

  const showForTakeaway =
    promotionBool(
      body.show_for_takeaway,
      current.show_for_takeaway ??
        true
    );

  const displayContext =
    body.display_context !==
      undefined
      ? promotionEnum(
          body.display_context,
          [
            "qr",
            "kiosk",
            "both",
          ],
          current.display_context ||
            "both"
        )
      : (
          showOnQr &&
          !showOnKiosk
            ? "qr"
            : (
                !showOnQr &&
                showOnKiosk
                  ? "kiosk"
                  : "both"
              )
        );

  const orderType =
    body.order_type !==
      undefined
      ? promotionEnum(
          body.order_type,
          [
            "dine-in",
            "takeaway",
            "both",
          ],
          current.order_type ||
            "both"
        )
      : (
          showForDineIn &&
          !showForTakeaway
            ? "dine-in"
            : (
                !showForDineIn &&
                showForTakeaway
                  ? "takeaway"
                  : "both"
              )
        );

  const linkedItemId =
    promotionOptionalId(
      body.linked_item_id,
      current.linked_item_id
    );

  const linkedCategoryId =
    promotionOptionalId(
      body.linked_category_id,
      current.linked_category_id
    );

  const buttonAction =
    promotionEnum(
      body.button_action,
      [
        "none",
        "booking",
        "category",
        "item",
        "url",
        "menu",
      ],
      promotionEnum(
        current.button_action,
        [
          "none",
          "booking",
          "category",
          "item",
          "url",
          "menu",
        ],
        "none"
      )
    );

  const actionType =
    promotionEnum(
      body.action_type !==
        undefined
        ? body.action_type
        : buttonAction,
      [
        "none",
        "booking",
        "category",
        "item",
        "url",
        "menu",
      ],
      promotionEnum(
        current.action_type,
        [
          "none",
          "booking",
          "category",
          "item",
          "url",
          "menu",
        ],
        buttonAction
      )
    );

  let actionTarget =
    promotionOptionalText(
      body.action_target,
      current.action_target
    );

  if (
    actionType ===
      "category"
  ) {
    actionTarget =
      linkedCategoryId
        ? String(
            linkedCategoryId
          )
        : null;
  }

  if (
    actionType ===
      "item"
  ) {
    actionTarget =
      linkedItemId
        ? String(
            linkedItemId
          )
        : null;
  }

  const daysOfWeek =
    promotionDays(
      body.days_of_week,
      current.days_of_week ||
        []
    );

  return {
    title:
      String(
        body.title ??
        current.title ??
        ""
      ).trim(),

    description:
      String(
        body.description ??
        current.description ??
        ""
      ).trim(),

    image_url:
      imageUrl,

    display_context:
      displayContext,

    order_type:
      orderType,

    linked_item_id:
      linkedItemId,

    linked_item_type:
      linkedItemId
        ? (
            promotionOptionalText(
              body.linked_item_type,
              current.linked_item_type ||
                "item"
            ) ||
            "item"
          )
        : null,

    linked_category_id:
      linkedCategoryId,

    active:
      promotionBool(
        body.active,
        current.active ??
          true
      ),

    show_on_qr:
      showOnQr,

    show_on_kiosk:
      showOnKiosk,

    show_on_eat_in:
      promotionBool(
        body.show_on_eat_in,
        current.show_on_eat_in ??
          true
      ),

    show_on_takeaway:
      promotionBool(
        body.show_on_takeaway,
        current.show_on_takeaway ??
          true
      ),

    show_for_dine_in:
      showForDineIn,

    show_for_takeaway:
      showForTakeaway,

    button_text:
      String(
        body.button_text ??
        current.button_text ??
        "View"
      ).trim(),

    action_type:
      actionType,

    action_target:
      actionTarget,

    start_at:
      promotionScalar(
        body.start_at,
        current.start_at
      ),

    end_at:
      promotionScalar(
        body.end_at,
        current.end_at
      ),

    sort_order:
      Number(
        body.sort_order ??
        current.sort_order ??
        0
      ),

    promotion_type:
      String(
        body.promotion_type ??
        current.promotion_type ??
        "general"
      ).trim(),

    button_action:
      buttonAction,

    start_date:
      promotionScalar(
        body.start_date,
        current.start_date
      ),

    end_date:
      promotionScalar(
        body.end_date,
        current.end_date
      ),

    start_time:
      promotionScalar(
        body.start_time,
        current.start_time
      ),

    end_time:
      promotionScalar(
        body.end_time,
        current.end_time
      ),

    meal_period:
      String(
        body.meal_period ??
        current.meal_period ??
        "all"
      ).trim(),

    days_of_week:
      daysOfWeek,

    priority:
      Number(
        body.priority ??
        current.priority ??
        0
      ),

    event_date:
      promotionScalar(
        body.event_date,
        current.event_date
      ),

    event_time:
      promotionScalar(
        body.event_time,
        current.event_time
      ),

    event_end_time:
      promotionScalar(
        body.event_end_time,
        current.event_end_time
      ),
  };
}


function cleanupFailedPromotionUpload(
  req
) {
  const filePath =
    req?.file?.path;

  if (!filePath) {
    return;
  }

  try {
    if (
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(
      "❌ Failed to clean rolled-back promotion upload:",
      error?.message ||
        error
    );
  }
}


router.post(
  "/promotions",
  requirePermission(
    PERMISSIONS.PROMOTIONS_MANAGE
  ),
  requireCloudPromotionAuthority,
  promoUpload.single("image"),
  async (req, res) => {
    try {
      await ensurePromotionsTable(
        req
      );

      const body =
        req.body || {};

      const imageUrl =
        req.file
          ? `/uploads/${req.tenantRid}/promotions/${req.file.filename}`
          : promotionOptionalText(
              body.image_url,
              null
            );

      const values =
        normalizePromotionMutation(
          body,
          null,
          imageUrl
        );

      const saved =
        await withTx(
          async (tx) => {
            const row =
              await tx.qGet(
                `
                INSERT INTO public.restaurant_promotions
                (
                  restaurant_id,
                  title,
                  description,
                  image_url,
                  display_context,
                  order_type,
                  linked_item_id,
                  linked_item_type,
                  linked_category_id,
                  button_text,
                  action_type,
                  action_target,
                  start_at,
                  end_at,
                  event_date,
                  event_time,
                  event_end_time,
                  active,
                  sort_order,
                  show_on_qr,
                  show_on_kiosk,
                  show_on_eat_in,
                  show_on_takeaway,
                  show_for_dine_in,
                  show_for_takeaway,
                  promotion_type,
                  button_action,
                  start_date,
                  end_date,
                  start_time,
                  end_time,
                  meal_period,
                  days_of_week,
                  priority,
                  created_at,
                  updated_at
                )
                VALUES
                (
                  $1, $2, $3, $4, $5,
                  $6, $7, $8, $9, $10,
                  $11, $12, $13, $14, $15,
                  $16, $17, $18, $19, $20,
                  $21, $22, $23, $24, $25,
                  $26, $27, $28, $29, $30,
                  $31, $32, $33::jsonb, $34,
                  NOW(), NOW()
                )
                RETURNING *
                `,
                [
                  req.tenantRid,
                  values.title,
                  values.description,
                  values.image_url,
                  values.display_context,
                  values.order_type,
                  values.linked_item_id,
                  values.linked_item_type,
                  values.linked_category_id,
                  values.button_text,
                  values.action_type,
                  values.action_target,
                  values.start_at,
                  values.end_at,
                  values.event_date,
                  values.event_time,
                  values.event_end_time,
                  values.active,
                  values.sort_order,
                  values.show_on_qr,
                  values.show_on_kiosk,
                  values.show_on_eat_in,
                  values.show_on_takeaway,
                  values.show_for_dine_in,
                  values.show_for_takeaway,
                  values.promotion_type,
                  values.button_action,
                  values.start_date,
                  values.end_date,
                  values.start_time,
                  values.end_time,
                  values.meal_period,
                  JSON.stringify(
                    values.days_of_week
                  ),
                  values.priority,
                ]
              );

            await emitPromotionsSnapshotTx(
              tx,
              {
                restaurantId:
                  req.tenantRid,
              }
            );

            return row;
          }
        );

      return res
        .status(201)
        .json(saved);
    } catch (error) {
      cleanupFailedPromotionUpload(
        req
      );

      if (
        sendPromotionAuthorityError(
          res,
          error
        )
      ) {
        return;
      }

      console.error(
        "❌ POST /org/promotions failed:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to create promotion",

        detail:
          error?.message,
      });
    }
  }
);


router.put(
  "/promotions/:id",
  requirePermission(
    PERMISSIONS.PROMOTIONS_MANAGE
  ),
  requireCloudPromotionAuthority,
  promoUpload.single("image"),
  async (req, res) => {
    try {
      await ensurePromotionsTable(
        req
      );

      const id =
        Number(
          req.params.id
        );

      if (
        !Number.isSafeInteger(id) ||
        id <= 0
      ) {
        cleanupFailedPromotionUpload(
          req
        );

        return res.status(400).json({
          error:
            "Invalid promotion id",
        });
      }

      const body =
        req.body || {};

      const saved =
        await withTx(
          async (tx) => {
            const existing =
              await tx.qGet(
                `
                SELECT *
                FROM
                  public.restaurant_promotions
                WHERE
                  id = $1
                  AND restaurant_id = $2
                FOR UPDATE
                `,
                [
                  id,
                  req.tenantRid,
                ]
              );

            if (!existing) {
              return null;
            }

            const imageUrl =
              req.file
                ? `/uploads/${req.tenantRid}/promotions/${req.file.filename}`
                : (
                    body.image_url !==
                      undefined
                      ? promotionOptionalText(
                          body.image_url,
                          null
                        )
                      : existing.image_url
                  );

            const values =
              normalizePromotionMutation(
                body,
                existing,
                imageUrl
              );

            const row =
              await tx.qGet(
                `
                UPDATE
                  public.restaurant_promotions
                SET
                  title = $1,
                  description = $2,
                  image_url = $3,
                  display_context = $4,
                  order_type = $5,
                  linked_item_id = $6,
                  linked_item_type = $7,
                  linked_category_id = $8,
                  button_text = $9,
                  action_type = $10,
                  action_target = $11,
                  start_at = $12,
                  end_at = $13,
                  event_date = $14,
                  event_time = $15,
                  event_end_time = $16,
                  active = $17,
                  sort_order = $18,
                  show_on_qr = $19,
                  show_on_kiosk = $20,
                  show_on_eat_in = $21,
                  show_on_takeaway = $22,
                  show_for_dine_in = $23,
                  show_for_takeaway = $24,
                  promotion_type = $25,
                  button_action = $26,
                  start_date = $27,
                  end_date = $28,
                  start_time = $29,
                  end_time = $30,
                  meal_period = $31,
                  days_of_week = $32::jsonb,
                  priority = $33,
                  updated_at = NOW()
                WHERE
                  id = $34
                  AND restaurant_id = $35
                RETURNING *
                `,
                [
                  values.title,
                  values.description,
                  values.image_url,
                  values.display_context,
                  values.order_type,
                  values.linked_item_id,
                  values.linked_item_type,
                  values.linked_category_id,
                  values.button_text,
                  values.action_type,
                  values.action_target,
                  values.start_at,
                  values.end_at,
                  values.event_date,
                  values.event_time,
                  values.event_end_time,
                  values.active,
                  values.sort_order,
                  values.show_on_qr,
                  values.show_on_kiosk,
                  values.show_on_eat_in,
                  values.show_on_takeaway,
                  values.show_for_dine_in,
                  values.show_for_takeaway,
                  values.promotion_type,
                  values.button_action,
                  values.start_date,
                  values.end_date,
                  values.start_time,
                  values.end_time,
                  values.meal_period,
                  JSON.stringify(
                    values.days_of_week
                  ),
                  values.priority,
                  id,
                  req.tenantRid,
                ]
              );

            await emitPromotionsSnapshotTx(
              tx,
              {
                restaurantId:
                  req.tenantRid,
              }
            );

            return row;
          }
        );

      if (!saved) {
        cleanupFailedPromotionUpload(
          req
        );

        return res.status(404).json({
          error:
            "Promotion not found",
        });
      }

      return res.json(
        saved
      );
    } catch (error) {
      cleanupFailedPromotionUpload(
        req
      );

      if (
        sendPromotionAuthorityError(
          res,
          error
        )
      ) {
        return;
      }

      console.error(
        "❌ PUT /org/promotions/:id failed:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to update promotion",
      });
    }
  }
);


router.delete(
  "/promotions/:id",
  requirePermission(
    PERMISSIONS.PROMOTIONS_MANAGE
  ),
  requireCloudPromotionAuthority,
  async (req, res) => {
    try {
      await ensurePromotionsTable(
        req
      );

      const id =
        Number(
          req.params.id
        );

      if (
        !Number.isSafeInteger(id) ||
        id <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid promotion id",
        });
      }

      const deleted =
        await withTx(
          async (tx) => {
            const row =
              await tx.qGet(
                `
                DELETE FROM
                  public.restaurant_promotions
                WHERE
                  id = $1
                  AND restaurant_id = $2
                RETURNING id
                `,
                [
                  id,
                  req.tenantRid,
                ]
              );

            if (!row?.id) {
              return null;
            }

            await emitPromotionsSnapshotTx(
              tx,
              {
                restaurantId:
                  req.tenantRid,
              }
            );

            return row;
          }
        );

      if (!deleted?.id) {
        return res.status(404).json({
          error:
            "Promotion not found",
        });
      }

      return res.json({
        success:
          true,

        id:
          deleted.id,
      });
    } catch (error) {
      if (
        sendPromotionAuthorityError(
          res,
          error
        )
      ) {
        return;
      }

      console.error(
        "❌ DELETE /org/promotions/:id failed:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to delete promotion",
      });
    }
  }
);

module.exports = router;
