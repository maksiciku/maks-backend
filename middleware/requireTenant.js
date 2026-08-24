module.exports = function requireTenant(req, res, next) {
  const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
  if (!rid || Number.isNaN(rid)) {
    return res.status(403).json({ error: "Missing tenant (restaurant) context" });
  }
  req.tenantRid = rid;
  next();
};
