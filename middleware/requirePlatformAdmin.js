const jwt = require("jsonwebtoken");
const { SECRET_KEY } = require("../utils/constants");

function requirePlatformAdmin(...allowedRoles) {
  return async (req, res, next) => {
    try {
      const authHeader =
        req.headers["authorization"] || req.headers["Authorization"];

      if (!authHeader || !String(authHeader).startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid Authorization header" });
      }

      const token = String(authHeader).slice(7).trim();
      if (!token) {
        return res.status(401).json({ error: "Missing token" });
      }

      let payload;
      try {
        payload = jwt.verify(token, SECRET_KEY);
      } catch (err) {
        console.error("❌ Platform admin JWT verify failed:", err.message);
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      if (
        !payload ||
        payload.kind !== "platform_admin" ||
        !payload.id ||
        !payload.role
      ) {
        return res.status(401).json({ error: "Invalid platform admin token payload" });
      }

      const admin = await req.qGet(
        `
        SELECT id, email, full_name, role, is_active, created_at, last_login_at
        FROM public.platform_admin_users
        WHERE id = $1
        LIMIT 1
        `,
        [Number(payload.id)]
      );

      if (!admin) {
        return res.status(401).json({ error: "Platform admin not found" });
      }

      if (!admin.is_active) {
        return res.status(403).json({ error: "Platform admin account is inactive" });
      }

      req.platformAdmin = {
        id: Number(admin.id),
        email: admin.email,
        full_name: admin.full_name || "",
        role: String(admin.role || "").trim().toLowerCase(),
      };

      if (allowedRoles.length > 0) {
        const role = req.platformAdmin.role;
        if (!allowedRoles.includes(role)) {
          return res.status(403).json({ error: "Insufficient platform permissions" });
        }
      }

      return next();
    } catch (err) {
      console.error("❌ requirePlatformAdmin failed:", err);
      return res.status(500).json({ error: "Server error" });
    }
  };
}

module.exports = { requirePlatformAdmin };