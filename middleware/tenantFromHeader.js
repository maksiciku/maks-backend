module.exports = function tenantFromHeader(req, res, next) {
  const ridRaw =
    req.headers["x-tenant-rid"] ||
    req.headers["x-restaurant-id"] ||
    req.headers["tenantRid"] ||
    req.headers["tenant-rid"];

  const rid = Number(ridRaw);

  if (!Number.isInteger(rid) || rid <= 0) {
    return res.status(400).json({ error: "Missing or invalid tenant id (x-tenant-rid)" });
  }

  req.tenantRid = rid;
  next();
};
