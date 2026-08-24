require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../db");

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  const password = String(process.argv[3] || "");
  const fullName = String(process.argv[4] || "Boss").trim();
  const role = String(process.argv[5] || "boss").trim().toLowerCase();

  if (!email || !password) {
    console.error(
      'Usage: node scripts/createPlatformAdmin.js "<email>" "<password>" "<full name>" "<role>"'
    );
    process.exit(1);
  }

  const allowed = new Set(["boss", "admin_manager", "support_staff", "read_only"]);
  if (!allowed.has(role)) {
    console.error(`Invalid role: ${role}`);
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 10);

  try {
    const existing = await db.qGet(
      `
      SELECT id, email, role
      FROM public.platform_admin_users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [email]
    );

    if (existing?.id) {
      console.error(`Platform admin already exists: ${existing.email} (${existing.role})`);
      process.exit(1);
    }

    const row = await db.qGet(
      `
      INSERT INTO public.platform_admin_users
        (email, password_hash, full_name, role, is_active, created_at)
      VALUES
        ($1, $2, $3, $4, TRUE, NOW())
      RETURNING id, email, full_name, role, is_active
      `,
      [email, hash, fullName || null, role]
    );

    console.log("✅ Platform admin created:");
    console.log(row);
    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to create platform admin:", err);
    process.exit(1);
  }
}

main();