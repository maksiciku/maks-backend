function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeText(value, fallback = "") {
  return String(value || fallback).trim().toLowerCase();
}

async function loadMembership(req, res, next) {
  try {
    const uid = toInt(req.user?.id);
    const tokenRid = toInt(req.user?.restaurant_id);
    const tenantRid = toInt(req.tenantRid);

    const headerRid = toInt(
      req.headers["x-tenant-rid"] ||
        req.headers["x-venue-rid"]
    );

    if (!uid || !tokenRid) {
      return res.status(401).json({
        error: "Invalid auth context",
        code: "INVALID_AUTH_CONTEXT",
      });
    }

    /*
     * The authenticated token owns the tenant for this request.
     *
     * Headers / tenant middleware may confirm the same restaurant,
     * but they may not silently switch this request to another one.
     */
    if (headerRid && headerRid !== tokenRid) {
      return res.status(403).json({
        error: "Tenant does not match authenticated restaurant",
        code: "TENANT_MISMATCH",
      });
    }

    if (tenantRid && tenantRid !== tokenRid) {
      return res.status(403).json({
        error: "Tenant context does not match authenticated restaurant",
        code: "TENANT_MISMATCH",
      });
    }

    const rid = tokenRid;

    if (typeof req.qGet !== "function") {
      return res.status(500).json({
        error: "Server misconfig: req.qGet missing",
      });
    }

    /*
     * server.js already runs loadMembership globally.
     *
     * Several older routes still call it again.
     * Once this exact user + restaurant has been validated,
     * do not perform another membership query.
     */
    if (
      toInt(req._maksMembershipValidatedRid) === rid &&
      toInt(req._maksMembershipValidatedUserId) === uid
    ) {
      req.tenantRid = rid;
      return next();
    }

    const isPg =
      String(req.kind || "").toLowerCase() === "pg";

    const membershipSql = isPg
      ? `
        SELECT
          id,
          role,
          authority,
          job_title,
          permissions,
          is_active,
          status
        FROM public.restaurant_members
        WHERE restaurant_id = $1
          AND user_id = $2
        LIMIT 1
      `
      : `
        SELECT
          id,
          role,
          authority,
          job_title,
          permissions,
          is_active,
          status
        FROM restaurant_members
        WHERE restaurant_id = ?
          AND user_id = ?
        LIMIT 1
      `;

    const m = await req.qGet(
      membershipSql,
      [rid, uid]
    );

    if (!m) {
      return res.status(403).json({
        error: "Not a member of this restaurant",
        code: "MEMBERSHIP_REQUIRED",
      });
    }

    const active =
      m.is_active === true ||
      m.is_active === 1;

    if (!active) {
      return res.status(403).json({
        error: "Membership disabled",
        code: "MEMBERSHIP_DISABLED",
      });
    }

    const membershipStatus =
      normalizeText(
        m.status,
        "active"
      );

    if (membershipStatus !== "active") {
      return res.status(403).json({
        error: "Membership is not active",
        code: "MEMBERSHIP_INACTIVE",
      });
    }

    const restaurantSql = isPg
      ? `
        SELECT id, account_status
        FROM public.restaurants
        WHERE id = $1
        LIMIT 1
      `
      : `
        SELECT id, account_status
        FROM restaurants
        WHERE id = ?
        LIMIT 1
      `;

    const restaurant = await req.qGet(
      restaurantSql,
      [rid]
    );

    if (!restaurant) {
      return res.status(403).json({
        error: "Restaurant not found",
        code: "RESTAURANT_NOT_FOUND",
      });
    }

    const accountStatus =
      normalizeText(
        restaurant.account_status,
        "active"
      );

    if (accountStatus !== "active") {
      return res.status(403).json({
        error:
          accountStatus === "suspended"
            ? "Restaurant account is suspended"
            : accountStatus === "banned"
              ? "Restaurant account is banned"
              : accountStatus === "archived"
                ? "Restaurant account is archived"
                : "Restaurant account is not active",
        code: "RESTAURANT_INACTIVE",
      });
    }

    const liveRole =
      normalizeText(
        m.role,
        "staff"
      );

    const liveAuthority =
      normalizeText(
        m.authority,
        "staff"
      );

    const liveJobTitle =
      String(
        m.job_title || ""
      ).trim();

    const livePermissions =
      m.permissions || [];

    const isKdsOnly =
      req.user?.scope === "kds_only" &&
      req.user?.purpose ===
        "shared_kds_printer";

    /*
     * A KDS-only token must remain restricted.
     * Reloading the underlying human membership must
     * never upgrade it back to owner/manager authority.
     */
    const effectiveRole =
      isKdsOnly
        ? normalizeText(
            req.user?.role,
            "chef"
          )
        : liveRole;

    const effectiveAuthority =
      isKdsOnly
        ? "staff"
        : liveAuthority;

    const effectiveJobTitle =
      isKdsOnly
        ? "Kitchen Display"
        : liveJobTitle;

    const effectivePermissions =
      isKdsOnly
        ? req.user?.permissions || []
        : livePermissions;

    req.membership = {
      id: Number(m.id),

      role:
        effectiveRole,

      authority:
        effectiveAuthority,

      job_title:
        effectiveJobTitle,

      permissions:
        effectivePermissions,

      status:
        membershipStatus,

      restaurant_id:
        rid,

      user_id:
        uid,
    };

    /*
     * Keep req.user, req.membership and req.tenantRid
     * describing the SAME current restaurant membership.
     */
    req.user = {
      ...req.user,

      role:
        effectiveRole,

      authority:
        effectiveAuthority,

      job_title:
        effectiveJobTitle,

      permissions:
        effectivePermissions,

      restaurant_id:
        rid,
    };

    req.tenantRid = rid;

    req._maksMembershipValidatedRid =
      rid;

    req._maksMembershipValidatedUserId =
      uid;

    return next();
  } catch (e) {
    console.error(
      "loadMembership failed:",
      e
    );

    return res.status(500).json({
      error:
        "Failed to validate membership",
    });
  }
}

module.exports = {
  loadMembership,
};
