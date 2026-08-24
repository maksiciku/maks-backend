// middleware/tenantGuard.js
module.exports = function tenantGuard(req, res, next) {
  const rid = Number(req.tenantRid);

  if (!Number.isInteger(rid) || rid <= 0) {
    return res.status(400).json({ error: 'Invalid tenant id' });
  }

  return next();
};
