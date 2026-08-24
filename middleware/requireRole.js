function requireRole(...allowed) {
  const allowedRoles = allowed
    .flat()
    .filter(Boolean)
    .map((role) =>
      String(role)
        .trim()
        .toLowerCase()
    );

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthenticated",
      });
    }

    if (
      req.user.scope === "kds_only" &&
      req.user.purpose ===
        "shared_kds_printer" &&
      allowedRoles.includes("chef")
    ) {
      return next();
    }

    const role = String(
      req.membership?.role ||
        req.user?.role ||
        ""
    )
      .trim()
      .toLowerCase();

    if (!role) {
      return res.status(403).json({
        error:
          "No role found for this restaurant",
      });
    }

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        error:
          "Insufficient permissions",
        required: allowedRoles,
        current: role,
      });
    }

    return next();
  };
}

module.exports = requireRole;