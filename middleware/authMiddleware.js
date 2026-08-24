// middleware/authMiddleware.js
const jwt = require("jsonwebtoken");
const { SECRET_KEY } = require("../utils/constants");
const requireRole = require("./requireRole");

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? n
    : 0;
}

/**
 * Normal MAKS authentication.
 *
 * IMPORTANT:
 * JWT proves identity + tenant.
 * PostgreSQL proves current role/access.
 *
 * This means:
 * - ownership changes apply immediately;
 * - demotions apply immediately;
 * - disabled memberships apply immediately;
 * - old JWT role cannot keep elevated permissions.
 */
async function authenticateToken(
  req,
  res,
  next
) {
  try {
    const authHeader =
      req.headers["authorization"] ||
      req.headers["Authorization"];

    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ")
    ) {
      return res.status(401).json({
        error:
          "Missing or invalid Authorization header",
      });
    }

    const token = authHeader.slice(7);

    let payload;

    try {
      payload = jwt.verify(
        token,
        SECRET_KEY
      );
    } catch (err) {
      console.error(
        "❌ JWT verify failed:",
        err.message
      );

      return res.status(401).json({
        error: "Invalid or expired token",
      });
    }

    const uid = toPositiveInt(
      payload?.id
    );

    const rid = toPositiveInt(
      payload?.restaurant_id
    );

    if (!uid || !rid) {
      return res.status(401).json({
        error: "Invalid token payload",
      });
    }

    if (
      typeof req.qGet !== "function"
    ) {
      console.error(
        "❌ authenticateToken: req.qGet missing"
      );

      return res.status(500).json({
        error:
          "Authentication database unavailable",
      });
    }

    /*
     * KDS-only tokens intentionally carry a
     * synthetic "chef" role.
     *
     * We still verify that:
     * - the user exists;
     * - membership is active;
     * - restaurant is active.
     *
     * But we preserve the restricted KDS role/scope.
     */
    const isKdsOnly =
      payload?.scope === "kds_only" &&
      payload?.purpose ===
        "shared_kds_printer";

    const authState = await req.qGet(
      `
      SELECT
  u.id AS user_id,
  u.username AS username,
  u.full_name AS full_name,
  u.is_active AS user_is_active,

        rm.id AS membership_id,
        rm.role AS membership_role,
rm.authority AS membership_authority,
rm.job_title AS membership_job_title,
rm.permissions AS membership_permissions,
rm.is_active AS membership_is_active,

        r.id AS restaurant_id,
        r.account_status

      FROM public.users u

      JOIN public.restaurant_members rm
        ON rm.user_id = u.id
       AND rm.restaurant_id = $2

      JOIN public.restaurants r
        ON r.id = rm.restaurant_id

      WHERE u.id = $1

      LIMIT 1
      `,
      [uid, rid]
    );

    if (!authState) {
      return res.status(403).json({
        error:
          "User is not a member of this restaurant",
      });
    }

    if (
      authState.user_is_active !== true
    ) {
      return res.status(403).json({
        error: "User account is disabled",
      });
    }

    if (
      authState.membership_is_active !==
      true
    ) {
      return res.status(403).json({
        error: "Membership disabled",
      });
    }

    const accountStatus = String(
      authState.account_status || "active"
    )
      .trim()
      .toLowerCase();

    if (accountStatus !== "active") {
      return res.status(403).json({
        error:
          accountStatus === "suspended"
            ? "Restaurant account is suspended"
            : accountStatus === "banned"
              ? "Restaurant account is banned"
              : accountStatus ===
                  "archived"
                ? "Restaurant account is archived"
                : "Restaurant account is not active",
      });
    }

    const liveRole = String(
      authState.membership_role ||
        "staff"
    )
      .trim()
      .toLowerCase();

      const liveAuthority = String(
  authState.membership_authority ||
    "staff"
)
  .trim()
  .toLowerCase();

const liveJobTitle = String(
  authState.membership_job_title ||
    ""
).trim();

    req.user = {
  id: uid,

  username:
  authState.username || "",

full_name:
  authState.full_name || "",

  role: isKdsOnly
    ? String(
        payload.role || "chef"
      )
        .trim()
        .toLowerCase()
    : liveRole,

  authority:
    isKdsOnly
      ? "staff"
      : liveAuthority,

  job_title:
    isKdsOnly
      ? "Kitchen Display"
      : liveJobTitle,

  restaurant_id: rid,

  scope:
    payload.scope || null,

  purpose:
    payload.purpose || null,

  permissions:
    authState.membership_permissions ||
    [],
};

    req.membership = {
  id: Number(
    authState.membership_id
  ),

  role: liveRole,

  authority:
    liveAuthority,

  job_title:
    liveJobTitle,

  restaurant_id: rid,
  user_id: uid,

  permissions:
    authState.membership_permissions ||
    [],
};

    req.tenantRid = rid;

    /*
     * KDS-only security wall.
     */
    if (isKdsOnly) {
      const path =
        req.originalUrl.split("?")[0];

      const allowedPrefixes = [
  "/pos/live",
  "/kds/live",
  "/kds/kitchen",
  "/categories",
  "/health",
];

      const allowed =
        allowedPrefixes.some(
          (prefix) =>
            path.startsWith(prefix)
        );

      if (!allowed) {
        return res.status(403).json({
          error:
            "KDS-only token cannot access this resource.",
        });
      }

      if (req.method !== "GET") {
        const allowedWriteRoutes = [
  "/pos/live/",
  "/kds/live/",
  "/kds/kitchen/",
];

        const writeAllowed =
          allowedWriteRoutes.some(
            (prefix) =>
              path.startsWith(prefix)
          );

        if (!writeAllowed) {
          return res.status(403).json({
            error:
              "KDS token cannot perform this action.",
          });
        }
      }
    }

    return next();
  } catch (err) {
    console.error(
      "❌ authenticateToken failed:",
      err
    );

    return res.status(500).json({
      error:
        "Failed to validate authentication",
    });
  }
}

/**
 * Role guard.
 *
 * authenticateToken now loads the current membership
 * role, so this is no longer trusting a stale JWT role.
 */
function checkRoles(
  allowedRoles = []
) {
  const normalized =
    allowedRoles.map((role) =>
      String(role || "")
        .trim()
        .toLowerCase()
    );

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Not authenticated",
      });
    }

    const role = String(
      req.membership?.role ||
        req.user?.role ||
        ""
    )
      .trim()
      .toLowerCase();

    if (!normalized.includes(role)) {
      return res.status(403).json({
        error:
          "Forbidden: insufficient role",
        required: normalized,
        current: role || null,
      });
    }

    return next();
  };
}

const requireOwnerOrAdmin =
  requireRole("owner", "admin");

module.exports = {
  authenticateToken,
  checkRoles,
  requireRole,
  requireOwnerOrAdmin,
};