// utils/audit.js
const { qRun } = require("../dbCompat");

function getIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.ip;
}

async function audit(req, action, meta = {}, opts = {}) {
  const rid = Number(req.tenantRid || req.user?.restaurant_id || 0);
  const uid = Number(req.user?.id || 0);
  if (!rid || !uid) return; // don't crash the request if context missing

const actor_role = String(req.membership?.role || req.user?.role || "");  const entity = opts.entity || null;
  const entity_id = opts.entity_id != null ? String(opts.entity_id) : null;

  const ip = getIp(req);
  const user_agent = String(req.headers["user-agent"] || "");

  try {
    await qRun(
      `
      INSERT INTO audit_log
        (restaurant_id, user_id, actor_role, action, entity, entity_id, ip, user_agent, meta)
      VALUES
        (?,?,?,?,?,?,?,?,?::jsonb)
      `,
      [
        rid,
        uid,
        actor_role,
        String(action),
        entity,
        entity_id,
        ip,
        user_agent,
        JSON.stringify(meta || {}),
      ]
    );
  } catch (e) {
    // Never block the main action; just log server-side
    console.error("audit() failed:", e.message);
  }
}

module.exports = { audit };
