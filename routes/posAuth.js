// backend/routes/posAuth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();

const { authenticateToken } = require("../middleware/authMiddleware");
const tenantFromHeader = require("../middleware/tenantFromHeader");
const jwt = require("jsonwebtoken");
const { SECRET_KEY } = require("../utils/constants");
const {
  hasPermission,
  PERMISSIONS,
  normalizeAuthority: normalizeAccessAuthority,
  normalizePermissions: normalizeAccessPermissions,
} = require("../middleware/accessControl");

// ------------------ helpers ------------------
function didAffect(r) {
  if (!r) return false;
  if (typeof r.changes === "number") return r.changes > 0; // sqlite
  if (typeof r.rowCount === "number") return r.rowCount > 0; // pg
  return false;
}

function truthyExpr(kind, colName) {
  // SQL boolean check that works in pg/sqlite
  // PG:    COALESCE(col,false) = true
  // SQLite COALESCE(col,0) = 1
  return kind === "pg"
    ? `COALESCE(${colName}, false) = true`
    : `COALESCE(${colName}, 0) = 1`;
}

function boolParam(kind, v) {
  // Bind value for booleans
  return kind === "pg" ? !!v : v ? 1 : 0;
}

function safePermissions(value) {
  try {
    if (Array.isArray(value)) {
      return normalizeAccessPermissions([...new Set(
        value
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      )]);
    }

    if (value && typeof value === "object") {
      return [];
    }

    const parsed = JSON.parse(value || "[]");

    return Array.isArray(parsed)
      ? normalizeAccessPermissions([...new Set(
          parsed
            .map((item) => String(item || "").trim())
            .filter(Boolean)
        )])
      : [];
  } catch {
    return [];
  }
}

function normalizeAuthority(
  authority,
  legacyRole = ""
) {
  const value = String(
    authority || ""
  )
    .trim()
    .toLowerCase();

  if (
    ["owner", "manager", "staff"].includes(
      value
    )
  ) {
    return value;
  }

  const role = String(
    legacyRole || ""
  )
    .trim()
    .toLowerCase();

  if (
    role === "owner" ||
    role === "admin"
  ) {
    return "owner";
  }

  if (role === "manager") {
    return "manager";
  }

  return "staff";
}

function fallbackJobTitle(
  jobTitle,
  legacyRole = ""
) {
  const existing = String(
    jobTitle || ""
  ).trim();

  if (existing) {
    return existing;
  }

  const role = String(
    legacyRole || ""
  )
    .trim()
    .toLowerCase();

  const labels = {
    owner: "Owner",
    admin: "Administrator",
    manager: "Manager",
    supervisor: "Supervisor",
    chef: "Chef",
    waiter: "Waiter",
    cashier: "Cashier",
    staff: "Team Member",
  };

  return labels[role] || "Team Member";
}

router.get("/bootstrap-status", authenticateToken, async (req, res) => {
  try {
    const authenticatedRid = Number(
      req.tenantRid ||
      req.user?.restaurant_id ||
      0
    );

    const requestedRid = Number(
      req.headers["x-tenant-rid"] ||
      req.headers["x-restaurant-id"] ||
      0
    );

    if (!authenticatedRid) {
      return res.status(400).json({ error: "Missing restaurant id" });
    }

    if (
      requestedRid &&
      requestedRid !== authenticatedRid
    ) {
      return res.status(403).json({
        error: "Tenant does not match authenticated restaurant",
        code: "TENANT_MISMATCH",
      });
    }

    const rid = authenticatedRid;

    const row = await req.qGet(
      `
      SELECT COUNT(*)::int AS c
      FROM public.restaurant_members rm
      JOIN public.users u ON u.id = rm.user_id
      WHERE rm.restaurant_id = ?
        AND rm.is_active = TRUE
        AND u.is_active = TRUE
        AND u.can_pos_login = TRUE
        AND u.pin_hash IS NOT NULL
      `,
      [rid]
    );

    return res.json({
      success: true,
      restaurant_id: rid,
      has_pins: Number(row?.c || 0) > 0,
      pin_count: Number(row?.c || 0),
    });
  } catch (err) {
    console.error("❌ bootstrap-status failed:", err);
    return res.status(500).json({ error: "Failed to check POS PIN setup" });
  }
});

// ------------------ routes ------------------

/**
 * POST /pos-auth/pin-login
 * body: { pin: "1234" }
 *
 * Returns staff object if PIN matches an active user allowed to POS-login.
 * (This is a fast “local POS gate”, not your main JWT login.)
 */
// POST /pos-auth/pin-login
router.post(
  "/pin-login",
  tenantFromHeader,
  async (req, res) => {
    try {
      const pin = String(
        req.body?.pin || ""
      ).trim();

      if (!/^\d{4}$/.test(pin)) {
        return res.status(400).json({
          error:
            "PIN must be exactly 4 digits",
        });
      }

      const restaurant =
        await req.qGet(
          `
          SELECT
            id,
            account_status
          FROM public.restaurants
          WHERE id = ?
          LIMIT 1
          `,
          [req.tenantRid]
        );

      if (!restaurant) {
        return res.status(403).json({
          error:
            "Restaurant not found",
        });
      }

      const accountStatus =
        String(
          restaurant.account_status ||
            "active"
        )
          .trim()
          .toLowerCase();

      if (accountStatus !== "active") {
        return res.status(403).json({
          error:
            accountStatus ===
            "suspended"
              ? "Restaurant account is suspended"
              : accountStatus ===
                  "banned"
                ? "Restaurant account is banned"
                : accountStatus ===
                    "archived"
                  ? "Restaurant account is archived"
                  : "Restaurant account is not active",
        });
      }

      const rows =
        await req.qAll(
          `
          SELECT
            u.id,
            u.username,
            u.full_name,
            u.can_pos_login,
            u.pin_hash,

            rm.role AS role,
            rm.authority AS authority,
            rm.job_title AS job_title,
            rm.permissions AS permissions

          FROM public.restaurant_members rm

          JOIN public.users u
            ON u.id = rm.user_id

          WHERE rm.restaurant_id = ?
            AND rm.is_active = TRUE
            AND u.is_active = TRUE
            AND u.can_pos_login = TRUE
            AND u.pin_hash IS NOT NULL

          ORDER BY u.id DESC
          `,
          [req.tenantRid]
        );

      for (const u of rows || []) {
        if (!u?.pin_hash) {
          continue;
        }

        if (
          !bcrypt.compareSync(
            pin,
            u.pin_hash
          )
        ) {
          continue;
        }

        const legacyRole =
          String(
            u.role || "staff"
          )
            .trim()
            .toLowerCase();

        const authority =
          normalizeAuthority(
            u.authority,
            legacyRole
          );

        const jobTitle =
          fallbackJobTitle(
            u.job_title,
            legacyRole
          );

        /*
         * The PIN is a real staff authentication event.
         * Issue a short-lived JWT for that exact membership so
         * protected backend routes enforce the permissions of the
         * person who entered the PIN instead of the browser owner's
         * long-lived business token.
         */
        const accessToken =
          jwt.sign(
            {
              id: Number(u.id),
              restaurant_id:
                Number(req.tenantRid),
              role: legacyRole,
              authority,
              scope: "pos_staff",
              purpose: "pos_pin",
            },
            SECRET_KEY,
            {
              expiresIn: "12h",
            }
          );

        return res.json({
          success: true,

          staff: {
            id: Number(u.id),

            restaurant_id:
              Number(
                req.tenantRid
              ),

            username:
              u.username || "",

            full_name:
              u.full_name || "",

            /*
             * Legacy compatibility only.
             * We keep this while older areas
             * of MAKS still reference role.
             */
            role:
              legacyRole,

            /*
             * REAL security hierarchy.
             */
            authority,

            /*
             * Presentation only.
             * Never use job_title for security.
             */
            job_title:
              jobTitle,

            permissions:
              safePermissions(
                u.permissions
              ),

            can_pos_login:
              u.can_pos_login ===
              true,

            access_token:
              accessToken,
          },
        });
      }

      return res.status(401).json({
        error: "Invalid PIN",
      });
    } catch (err) {
      console.error(
        "PIN login error:",
        err?.message || err
      );

      return res.status(500).json({
        error: "Server error",
      });
    }
  }
);


// POST /pos-auth/reset-pin  (owner/admin only)
router.post(
  "/reset-pin",

  authenticateToken,
  tenantFromHeader,

  async (req, res) => {
    try {
      const actorUserId =
        Number(
          req.user?.id ||
          req.user?.user_id ||
          0
        );

      const restaurantId =
        Number(
          req.tenantRid ||
          0
        );

      const userId =
        Number(
          req.body?.user_id
        );

      const pin =
        String(
          req.body?.pin ||
          ""
        ).trim();

      const pinLabel =
        req.body?.pin_label !=
          null &&
        String(
          req.body.pin_label
        ).trim() !== ""
          ? String(
              req.body.pin_label
            )
              .trim()
              .slice(
                0,
                100
              )
          : null;

      const can =
        req.body
          ?.can_pos_login ===
          true;

      if (
        !actorUserId ||
        !restaurantId
      ) {
        return res
          .status(403)
          .json({
            error:
              "Authenticated restaurant membership required.",

            code:
              "TENANT_MEMBERSHIP_REQUIRED",
          });
      }

      if (
        !Number.isInteger(
          userId
        ) ||
        userId <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid user_id",
          });
      }

      if (
        !/^\d{4}$/.test(pin)
      ) {
        return res
          .status(400)
          .json({
            error:
              "PIN must be exactly 4 digits",
          });
      }

      /*
       * =====================================================
       * AUTHORITATIVE ACTOR MEMBERSHIP
       * =====================================================
       *
       * The request header chooses a tenant context.
       *
       * It does NOT prove the authenticated user belongs to
       * that restaurant.
       *
       * Re-load the actor's membership from PostgreSQL.
       */
      const actorMembership =
        await req.qGet(
          `
          SELECT
            authority,
            permissions,
            is_active

          FROM public.restaurant_members

          WHERE restaurant_id = ?

            AND user_id = ?

            AND is_active =
                TRUE

          LIMIT 1
          `,
          [
            restaurantId,
            actorUserId,
          ]
        );

      if (
        !actorMembership
      ) {
        return res
          .status(403)
          .json({
            error:
              "You are not an active member of this restaurant.",

            code:
              "TENANT_MEMBERSHIP_REQUIRED",
          });
      }

      const actorAuthority =
        normalizeAccessAuthority(
          actorMembership
            .authority
        );

      const actorPermissions =
        safePermissions(
          actorMembership
            .permissions
        );

      if (
        !hasPermission(
          {
            authority:
              actorAuthority,

            permissions:
              actorPermissions,
          },

          PERMISSIONS
            .USERS_RESET_PIN
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "You do not have permission to reset staff PINs.",

            code:
              "PERMISSION_DENIED",

            permission:
              PERMISSIONS
                .USERS_RESET_PIN,
          });
      }

      /*
       * Target must separately belong to the SAME tenant.
       */
      const targetMembership =
        await req.qGet(
          `
          SELECT
            user_id

          FROM public.restaurant_members

          WHERE restaurant_id = ?

            AND user_id = ?

          LIMIT 1
          `,
          [
            restaurantId,
            userId,
          ]
        );

      if (
        !targetMembership
      ) {
        return res
          .status(404)
          .json({
            error:
              "User not found in this restaurant",
          });
      }

      /*
       * PIN must remain unique within this restaurant.
       */
      const others =
        await req.qAll(
          `
          SELECT
            u.id,
            u.pin_hash

          FROM public.restaurant_members rm

          JOIN public.users u
            ON u.id =
                 rm.user_id

          WHERE rm.restaurant_id = ?

            AND rm.is_active =
                TRUE

            AND u.is_active =
                TRUE

            AND u.can_pos_login =
                TRUE

            AND u.pin_hash
                IS NOT NULL

            AND u.id <> ?
          `,
          [
            restaurantId,
            userId,
          ]
        );

      for (
        const row
        of others || []
      ) {
        if (
          row?.pin_hash &&
          bcrypt.compareSync(
            pin,
            row.pin_hash
          )
        ) {
          return res
            .status(409)
            .json({
              error:
                "This PIN is already used by another staff member.",
            });
        }
      }

      const hash =
        bcrypt.hashSync(
          pin,
          10
        );

      const update =
        await req.qRun(
          `
          UPDATE public.users

          SET
            pin_hash = ?,
            pin_label = ?,
            can_pos_login = ?

          WHERE id = ?
          `,
          [
            hash,
            pinLabel,
            boolParam(
              req.kind,
              can
            ),
            userId,
          ]
        );

      if (
        !didAffect(update)
      ) {
        return res
          .status(404)
          .json({
            error:
              "User not found",
          });
      }

      return res.json({
        success:
          true,
      });
    } catch (err) {
      console.error(
        "reset pin error:",
        err?.message ||
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Server error",
        });
    }
  }
);

router.post(
  "/approve-action",
  tenantFromHeader,

  async (req, res) => {
    try {
      const pin =
        String(
          req.body?.pin || ""
        ).trim();

      const action =
        String(
          req.body?.action || ""
        )
          .trim()
          .toLowerCase();

      if (
        !/^\d{4}$/.test(pin)
      ) {
        return res
          .status(400)
          .json({
            error:
              "PIN must be exactly 4 digits",
          });
      }

      if (!action) {
        return res
          .status(400)
          .json({
            error:
              "Action is required",
          });
      }

      /*
       * Approval requests must refer to a real MAKS
       * permission.
       *
       * Do not allow arbitrary client strings to become
       * approval capabilities.
       */
      const knownPermissions =
        new Set(
          Object.values(
            PERMISSIONS
          )
        );

      if (
        !knownPermissions.has(
          action
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Unknown approval action.",

            code:
              "UNKNOWN_APPROVAL_ACTION",
          });
      }

      const restaurant =
        await req.qGet(
          `
          SELECT
            id,
            account_status

          FROM public.restaurants

          WHERE id = ?

          LIMIT 1
          `,
          [
            req.tenantRid,
          ]
        );

      if (!restaurant) {
        return res
          .status(403)
          .json({
            error:
              "Restaurant not found",
          });
      }

      const accountStatus =
        String(
          restaurant.account_status ||
          "active"
        )
          .trim()
          .toLowerCase();

      if (
        accountStatus !==
        "active"
      ) {
        return res
          .status(403)
          .json({
            error:
              accountStatus ===
              "suspended"
                ? "Restaurant account is suspended"
                : accountStatus ===
                    "banned"
                  ? "Restaurant account is banned"
                  : accountStatus ===
                      "archived"
                    ? "Restaurant account is archived"
                    : "Restaurant account is not active",
          });
      }

      /*
       * SECURITY AUTHORITY:
       *
       * rm.role is compatibility metadata only.
       *
       * Security comes from:
       *   rm.authority
       *   rm.permissions
       */
      const rows =
        await req.qAll(
          `
          SELECT
            u.id,
            u.username,
            u.full_name,
            u.pin_hash,

            rm.role,
            rm.authority,
            rm.permissions

          FROM public.restaurant_members rm

          JOIN public.users u
            ON u.id =
                 rm.user_id

          WHERE rm.restaurant_id = ?

            AND rm.is_active =
                TRUE

            AND u.is_active =
                TRUE

            AND u.can_pos_login =
                TRUE

            AND u.pin_hash
                IS NOT NULL

          ORDER BY
            u.id DESC
          `,
          [
            req.tenantRid,
          ]
        );

      for (
        const user
        of rows || []
      ) {
        if (
          !user?.pin_hash
        ) {
          continue;
        }

        if (
          !bcrypt.compareSync(
            pin,
            user.pin_hash
          )
        ) {
          continue;
        }

        const authority =
          normalizeAccessAuthority(
            user.authority
          );

        /*
         * Approval itself is a manager/owner responsibility.
         *
         * A staff member does not become an approver merely
         * because a stale legacy role says "manager/owner".
         */
        if (
          authority !==
            "owner" &&
          authority !==
            "manager"
        ) {
          return res
            .status(403)
            .json({
              error:
                "Only an authorised owner or manager can approve this action.",

              code:
                "APPROVER_AUTHORITY_DENIED",
            });
        }

        const permissions =
          safePermissions(
            user.permissions
          );

        /*
         * Owner passes automatically through hasPermission.
         *
         * Manager must explicitly hold the permission for
         * the requested action.
         */
        const allowed =
          hasPermission(
            {
              authority,
              permissions,
            },
            action
          );

        if (!allowed) {
          return res
            .status(403)
            .json({
              error:
                "This manager does not have permission to approve this action.",

              code:
                "APPROVAL_PERMISSION_DENIED",

              permission:
                action,
            });
        }

        return res.json({
          success:
            true,

          approver: {
            id:
              Number(
                user.id
              ),

            restaurant_id:
              Number(
                req.tenantRid
              ),

            username:
              user.username ||
              "",

            full_name:
              user.full_name ||
              "",

            authority,

            /*
             * Compatibility only.
             */
            role:
              String(
                user.role ||
                ""
              ),
          },

          action,
        });
      }

      return res
        .status(401)
        .json({
          error:
            "Invalid PIN",
        });
    } catch (err) {
      console.error(
        "approve action error:",
        err?.message ||
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Server error",
        });
    }
  }
);

router.post(
  "/kds-feed-login",

  async (req, res) => {
    try {
      const restaurantId =
        Number(
          req.body
            ?.restaurant_id
        );

      const pin =
        String(
          req.body?.pin ||
          ""
        ).trim();

      if (
        !Number.isFinite(
          restaurantId
        ) ||
        restaurantId <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Restaurant required.",
          });
      }

      if (
        !/^\d{4}$/.test(pin)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Manager PIN must be exactly 4 digits.",
          });
      }

      const restaurant =
        await req.qGet(
          `
          SELECT
            id,
            name,
            account_status

          FROM public.restaurants

          WHERE id = ?

          LIMIT 1
          `,
          [
            restaurantId,
          ]
        );

      if (!restaurant) {
        return res
          .status(404)
          .json({
            error:
              "Restaurant not found.",
          });
      }

      const accountStatus =
        String(
          restaurant.account_status ||
          "active"
        )
          .trim()
          .toLowerCase();

      if (
        accountStatus !==
        "active"
      ) {
        return res
          .status(403)
          .json({
            error:
              "Restaurant is not active.",
          });
      }

      const users =
        await req.qAll(
          `
          SELECT
            u.id,
            u.username,
            u.full_name,
            u.pin_hash,

            rm.role,
            rm.authority,
            rm.permissions

          FROM public.restaurant_members rm

          JOIN public.users u
            ON u.id =
                 rm.user_id

          WHERE rm.restaurant_id = ?

            AND rm.is_active =
                TRUE

            AND u.is_active =
                TRUE

            AND u.can_pos_login =
                TRUE

            AND u.pin_hash
                IS NOT NULL
          `,
          [
            restaurantId,
          ]
        );

      let approvedUser =
        null;

      for (
        const user
        of users || []
      ) {
        if (
          !user?.pin_hash
        ) {
          continue;
        }

        if (
          !bcrypt.compareSync(
            pin,
            user.pin_hash
          )
        ) {
          continue;
        }

        const authority =
          normalizeAccessAuthority(
            user.authority
          );

        /*
         * Connecting a shared KDS feed requires owner or
         * manager authority.
         *
         * Legacy role/job title never grants it.
         */
        if (
          authority !==
            "owner" &&
          authority !==
            "manager"
        ) {
          return res
            .status(403)
            .json({
              error:
                "Only an authorised owner or manager can connect a KDS feed.",

              code:
                "KDS_FEED_AUTHORITY_DENIED",
            });
        }

        const permissions =
          safePermissions(
            user.permissions
          );

        if (
          !hasPermission(
            {
              authority,
              permissions,
            },
            PERMISSIONS.KDS_VIEW
          )
        ) {
          return res
            .status(403)
            .json({
              error:
                "This manager does not have permission to access KDS.",

              code:
                "KDS_FEED_PERMISSION_DENIED",

              permission:
                PERMISSIONS.KDS_VIEW,
            });
        }

        approvedUser = {
          ...user,
          authority,
          permissions,
        };

        break;
      }

      if (!approvedUser) {
        return res
          .status(401)
          .json({
            error:
              "Invalid manager PIN.",
          });
      }

      const categories =
        await req.qAll(
          `
          SELECT
            id,
            name,
            type,
            icon

          FROM public.categories

          WHERE restaurant_id = ?

          ORDER BY
            type ASC,
            name ASC
          `,
          [
            restaurantId,
          ]
        );

      /*
       * IMPORTANT:
       *
       * This JWT deliberately receives ONLY KDS scope.
       *
       * Do not copy owner/manager authority into the
       * device token.
       */
      const token =
        jwt.sign(
          {
            id:
              approvedUser.id,

            username:
              approvedUser.username,

            restaurant_id:
              restaurantId,

            role:
              "chef",

            scope:
              "kds_only",

            purpose:
              "shared_kds_printer",
          },

          SECRET_KEY,

          {
            expiresIn:
              "30d",
          }
        );

      return res.json({
        success:
          true,

        token,

        restaurant_id:
          restaurantId,

        restaurant_name:
          restaurant.name,

        scope:
          "kds_only",

        purpose:
          "shared_kds_printer",

        categories:
          categories || [],
      });
    } catch (err) {
      console.error(
        "❌ KDS feed login failed:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "KDS feed login failed.",
        });
    }
  }
);

router.post("/kds-business-login", async (req, res) => {
  return res.status(410).json({
    error: "Old KDS business login disabled. Use manager PIN feed login.",
  });
});
module.exports = router;
