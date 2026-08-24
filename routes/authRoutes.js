// backend/routes/authRoutes.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const crypto = require("crypto");

const { authenticateToken } = require("../middleware/authMiddleware");
const { SECRET_KEY, SALT_ROUNDS } = require("../utils/constants");const { loadMembership } = require("../middleware/tenantMembership");

const router = express.Router();
const {
  getNextMonthlyLogoutAt,
  getJwtExpirySecondsFromNow,
} = require("../utils/jwtExpiry");

const {
  sendWelcomeEmail,
  sendPasswordResetEmail,
} = require("../utils/emailService");

const { qGet, qRun, qAll, kind } = require("../dbCompat");
// ---------- helpers ----------
function nowSql(kind) {
  return kind === "pg" ? "NOW()" : "datetime('now')";
}
function beginSql(kind) {
  return kind === "pg" ? "BEGIN" : "BEGIN IMMEDIATE";
}
function truthyExpr(kind, col) {
  // pg boolean vs sqlite int
  return kind === "pg" ? `COALESCE(${col}, false) = true` : `COALESCE(${col}, 0) = 1`;
}

function sql(kind, pgQuery, sqliteQuery) {
  return kind === "pg" ? pgQuery : sqliteQuery;
}

function dbGet(req, sqlText, params = []) {
  return req.qGet ? req.qGet(sqlText, params) : qGet(sqlText, params);
}

function dbRun(req, sqlText, params = []) {
  return req.qRun ? req.qRun(sqlText, params) : qRun(sqlText, params);
}

function dbAll(req, sqlText, params = []) {
  return req.qAll ? req.qAll(sqlText, params) : qAll(sqlText, params);
}

// ========================= EMAIL / USERNAME LOGIN =========================
router.post("/login", async (req, res) => {
  try {
    const { email, username, password, restaurant_id, restaurantId } = req.body || {};

    const identity = String(email || username || "").trim().toLowerCase();
    if (!identity || !password) {
      return res.status(400).json({ error: "email/username and password are required" });
    }

    // 1) Find user
    const user = await req.qGet(
  sql(
    req.kind,
    `
    SELECT id, username, password_hash, password, is_active, can_backoffice_login
    FROM public.users
    WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
    LIMIT 1
    `,
    `
    SELECT id, username, password_hash, password, is_active, can_backoffice_login
    FROM users
    WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
    LIMIT 1
    `
  ),
  [identity]
);


  const hash =
  user?.password_hash ||
  user?.password;

/*
 * SECURITY:
 * Unknown user and wrong password must produce the same
 * outward authentication result.
 */
if (!user || !hash) {
  return res.status(401).json({
    error:
      "Invalid email or password",
  });
}

const ok =
  bcrypt.compareSync(
    password,
    hash
  );

if (!ok) {
  return res.status(401).json({
    error:
      "Invalid email or password",
  });
}

/*
 * Only AFTER password ownership has been proven do we
 * reveal account-specific access state.
 */
const activeOk =
  req.kind === "pg"
    ? user.is_active === true
    : Number(user.is_active) === 1;

if (!activeOk) {
  return res.status(403).json({
    error:
      "Account is disabled",
  });
}

const backofficeOk =
  req.kind === "pg"
    ? user.can_backoffice_login === true
    : Number(
        user.can_backoffice_login
      ) === 1;

if (!backofficeOk) {
  return res.status(403).json({
    error:
      "This account can only access the POS using a PIN.",
  });
}
    // 2) Choose restaurant for token
    const bodyRid = Number(restaurant_id || restaurantId || 0);
    let tokenRid = bodyRid;

    if (!tokenRid) {
      const memberships = await req.qAll(
  sql(
    req.kind,
    `
    SELECT restaurant_id, role
    FROM public.restaurant_members
    WHERE user_id = ? AND is_active = TRUE
    ORDER BY restaurant_id
    `,
    `
    SELECT restaurant_id, role
    FROM restaurant_members
    WHERE user_id = ?
    ORDER BY restaurant_id
    `
  ),
  [user.id]
);


      if (!memberships.length) {
        return res.status(403).json({ error: "Not an active member of any restaurant" });
      }

   // ✅ No venue ID needed for normal customers.
// If user has multiple memberships, use the first active one for now.
tokenRid = Number(memberships[0].restaurant_id);
    }

    const m = await req.qGet(
  sql(
    req.kind,
    `
    SELECT role
    FROM public.restaurant_members
    WHERE restaurant_id = ? AND user_id = ? AND is_active = TRUE
    LIMIT 1
    `,
    `
    SELECT role
    FROM restaurant_members
    WHERE restaurant_id = ? AND user_id = ?
    LIMIT 1
    `
  ),
  [tokenRid, user.id]
);

if (!m) {
  return res.status(403).json({ error: "Not an active member of this restaurant" });
}

const restaurant = await req.qGet(
  sql(
    req.kind,
    `
    SELECT id, account_status
    FROM public.restaurants
    WHERE id = ?
    LIMIT 1
    `,
    `
    SELECT id, account_status
    FROM restaurants
    WHERE id = ?
    LIMIT 1
    `
  ),
  [tokenRid]
);

if (!restaurant) {
  return res.status(403).json({ error: "Restaurant not found" });
}

const accountStatus = String(restaurant.account_status || "active").toLowerCase();

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
  });
}

const role = m.role;

    const expiresIn = getJwtExpirySecondsFromNow();
const expiresAt = getNextMonthlyLogoutAt();

const token = jwt.sign(
  { id: user.id, role, restaurant_id: tokenRid },
  SECRET_KEY,
  { expiresIn }
);

    return res.json({
  token,
  expires_at: expiresAt.toISOString(),
  user: { id: user.id, username: user.username, role, restaurant_id: tokenRid },
});
  } catch (e) {
    console.error("❌ /login failed:", e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ========================= REGISTER RESTAURANT =========================
router.post("/register-restaurant", async (req, res) => {
  let txOpen = false;

  try {
const {
  restaurant_name,
  email,
  password,
  phone,
  registration_token,
  timezone,
  first_name,
  last_name,
  business_type,
  website,
  address,
  postcode,
  country,
  plan_key,
  monthly_price,
  billing_status,
  account_status,
  device_limit,

  stripe_customer_id,
  stripe_subscription_id,
  stripe_checkout_session_id,
  stripe_subscription_status,
  stripe_current_period_end,
} = req.body || {};

    if (!restaurant_name || !email || !password) {
      return res.status(400).json({
        error: "restaurant_name, email and password are required",
      });
    }

    const nameRaw = String(restaurant_name).trim();
    const emailRaw = String(email).trim().toLowerCase();

    /*
 * =====================================================
 * VERIFIED COMMERCIAL REGISTRATION
 * =====================================================
 *
 * Commercial entitlement comes ONLY from a token signed
 * by MAKS after Stripe verification.
 *
 * Browser supplied:
 * - plan_key
 * - monthly_price
 * - device_limit
 * - billing_status
 * - account_status
 * - Stripe IDs
 *
 * are NOT authoritative.
 * =====================================================
 */

const rawRegistrationToken =
  String(
    registration_token ||
    ""
  ).trim();

if (!rawRegistrationToken) {
  return res.status(401).json({
    error:
      "Verified checkout is required",

    code:
      "REGISTRATION_TOKEN_REQUIRED",
  });
}

let registrationClaims;

try {
  registrationClaims =
    jwt.verify(
      rawRegistrationToken,

      SECRET_KEY,

      {
        issuer:
          "maks-stripe",

        audience:
          "maks-registration",
      }
    );
} catch {
  return res.status(401).json({
    error:
      "Registration authorization is invalid or expired",

    code:
      "INVALID_REGISTRATION_TOKEN",
  });
}

if (
  registrationClaims?.type !==
  "restaurant_registration"
) {
  return res.status(401).json({
    error:
      "Invalid registration authorization",

    code:
      "INVALID_REGISTRATION_TOKEN",
  });
}

/*
 * The person cannot pay as:
 *
 *   alice@example.com / Alice Cafe
 *
 * and then modify DevTools to register:
 *
 *   victim@example.com / Free Enterprise Restaurant
 */

const authorisedEmail =
  String(
    registrationClaims.email ||
    ""
  )
    .trim()
    .toLowerCase();

const authorisedRestaurantName =
  String(
    registrationClaims
      .restaurant_name ||
    ""
  ).trim();

if (
  authorisedEmail !==
    emailRaw ||
  authorisedRestaurantName
    .toLowerCase() !==
    nameRaw.toLowerCase()
) {
  return res.status(403).json({
    error:
      "Registration details do not match the verified checkout",

    code:
      "REGISTRATION_IDENTITY_MISMATCH",
  });
}

/*
 * These are the ONLY commercial values that may be stored.
 */

const trustedPlanKey =
  String(
    registrationClaims
      .plan_key ||
    ""
  )
    .trim()
    .toLowerCase();

const trustedMonthlyPrice =
  Number(
    registrationClaims
      .monthly_price
  );

const trustedDeviceLimit =
  Number(
    registrationClaims
      .device_limit
  );

const trustedCheckoutSessionId =
  String(
    registrationClaims
      .stripe_checkout_session_id ||
    ""
  ).trim();

const trustedCustomerId =
  registrationClaims
    .stripe_customer_id ||
  null;

const trustedSubscriptionId =
  registrationClaims
    .stripe_subscription_id ||
  null;

const trustedSubscriptionStatus =
  String(
    registrationClaims
      .stripe_subscription_status ||
    ""
  )
    .trim()
    .toLowerCase();

const trustedPeriodEnd =
  registrationClaims
    .stripe_current_period_end ||
  null;

if (
  ![
    "starter",
    "professional",
    "enterprise",
  ].includes(
    trustedPlanKey
  ) ||
  !Number.isFinite(
    trustedMonthlyPrice
  ) ||
  trustedMonthlyPrice < 0 ||
  !Number.isInteger(
    trustedDeviceLimit
  ) ||
  trustedDeviceLimit <= 0 ||
  !trustedCheckoutSessionId
    .startsWith("cs_") ||
  !trustedSubscriptionId
) {
  return res.status(401).json({
    error:
      "Registration authorization contains invalid entitlement",

    code:
      "INVALID_REGISTRATION_ENTITLEMENT",
  });
}

    // ------------------------------------------------------------------
    // 1. Check restaurant name uniqueness
    // ------------------------------------------------------------------
    const dup = await req.qGet(
      `
      SELECT id
      FROM ${req.kind === "pg" ? "public.restaurants" : "restaurants"}
      WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
      LIMIT 1
      `,
      [nameRaw]
    );

   
    if (dup) {
      return res.status(409).json({
        error: "Restaurant name already exists",
      });
    }

    const usedCheckout =
  await req.qGet(
    `
    SELECT id
    FROM public.restaurants
    WHERE stripe_checkout_session_id = ?
    LIMIT 1
    `,
    [
      trustedCheckoutSessionId,
    ]
  );

if (usedCheckout) {
  return res.status(409).json({
    error:
      "This checkout has already been used",

    code:
      "CHECKOUT_ALREADY_USED",
  });
}

    // ------------------------------------------------------------------
    // 2. Start transaction
    // ------------------------------------------------------------------
    await req.qRun(beginSql(req.kind));
    txOpen = true;

    // ------------------------------------------------------------------
    // 3. Create restaurant
    // ------------------------------------------------------------------
    let restaurant_id = 0;
if (req.kind === "pg") {
  const row = await req.qGet(
    `
    INSERT INTO public.restaurants (
      name,
      timezone,
      phone,
      account_status,
      billing_status,
      plan_key,
      monthly_price,
      device_limit,
      owner_first_name,
      owner_last_name,
      owner_email,
      website,
      address_line1,
      postcode,
      country,
      business_type,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_checkout_session_id,
      stripe_subscription_status,
      stripe_current_period_end,
      created_at
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ${nowSql(req.kind)}
    )
    RETURNING id
    `,
    [
      nameRaw,
      timezone || "Europe/London",
      phone || null,
      "active",
"active",
trustedPlanKey,
trustedMonthlyPrice,
trustedDeviceLimit,
      first_name ? String(first_name).trim() : null,
      last_name ? String(last_name).trim() : null,
      emailRaw,
      website ? String(website).trim() : null,
      address ? String(address).trim() : null,
      postcode ? String(postcode).trim() : null,
      country ? String(country).trim() : "United Kingdom",
      business_type ? String(business_type).trim() : null,
     trustedCustomerId,
trustedSubscriptionId,
trustedCheckoutSessionId,
trustedSubscriptionStatus,
trustedPeriodEnd,
    ]
  );

  restaurant_id = Number(row?.id || 0);
}
     else {
      const out = await req.qRun(
        `
        INSERT INTO restaurants (
          name,
          timezone,
          phone,
          account_status,
          created_at
        )
        VALUES (
          ?,
          ?,
          ?,
          'active',
          ${nowSql(req.kind)}
        )
        `,
        [
          nameRaw,
          timezone || "Europe/London",
          phone || null,
        ]
      );

      restaurant_id = Number(out?.lastID || 0);
    }

    if (!restaurant_id) {
      throw new Error("RID_GUARD: restaurant insert failed");
    }

    // ------------------------------------------------------------------
    // 4. Check if email already exists
    // ------------------------------------------------------------------
    const existingUser = await req.qGet(
      `
      SELECT id
      FROM ${req.kind === "pg" ? "public.users" : "users"}
      WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
      LIMIT 1
      `,
      [emailRaw]
    );

    let user_id = 0;

/*
 * SECURITY:
 * Public registration must never take over or reuse an
 * existing MAKS identity merely because the browser knows
 * the email address.
 *
 * Existing users must sign in and use a separate authenticated
 * "add restaurant" workflow.
 */
if (existingUser) {
  const err =
    new Error(
      "An account with this email already exists. Please sign in."
    );

  err.status =
    409;

  err.code =
    "ACCOUNT_ALREADY_EXISTS";

  throw err;
}



// ------------------------------------------------------------------
// 5. Create NEW owner user
// ------------------------------------------------------------------
{
      const hash = bcrypt.hashSync(password, SALT_ROUNDS);

      // In your /register-restaurant route, replace ONLY this PG insert block:

if (req.kind === "pg") {
  const row = await req.qGet(
    `
    INSERT INTO public.users (
      username,
      password,          -- ✅ your PostgreSQL table requires this column
      password_hash,     -- ✅ also populate the new secure column
      role,
      restaurant_id,
      is_active,
      can_pos_login,
      can_backoffice_login,
      created_at
    )
    VALUES (
      ?,
      ?,
      ?,
      'owner',
      ?,
      TRUE,
      TRUE,
      TRUE,
      ${nowSql(req.kind)}
    )
    RETURNING id
    `,
    [
      emailRaw,
      hash,             // password
      hash,             // password_hash
      restaurant_id,
    ]
  );

  user_id = Number(row?.id || 0);
} else {
        const out = await req.qRun(
          `
          INSERT INTO users (
            username,
            password,
            role,
            restaurant_id,
            is_active,
            can_pos_login,
            can_backoffice_login,
            created_at
          )
          VALUES (
            ?,
            ?,
            'owner',
            ?,
            1,
            1,
            ${nowSql(req.kind)}
          )
          `,
          [emailRaw, hash, restaurant_id]
        );

        user_id = Number(out?.lastID || 0);
      }
}
    if (!user_id) {
      throw new Error("USER_GUARD: user insert/update failed");
    }

    // ------------------------------------------------------------------
    // 6. Create membership row
    // ------------------------------------------------------------------
    if (req.kind === "pg") {
      await req.qRun(
        `
        INSERT INTO public.restaurant_members (
          restaurant_id,
          user_id,
          role,
          is_active,
          created_at
        )
        VALUES (
          ?,
          ?,
          'owner',
          TRUE,
          ${nowSql(req.kind)}
        )
        ON CONFLICT (restaurant_id, user_id)
        DO UPDATE SET
          role = 'owner',
          is_active = TRUE
        `,
        [restaurant_id, user_id]
      );
    } else {
      await req.qRun(
        `
        INSERT OR IGNORE INTO restaurant_members (
          restaurant_id,
          user_id,
          role,
          created_at
        )
        VALUES (
          ?,
          ?,
          'owner',
          ${nowSql(req.kind)}
        )
        `,
        [restaurant_id, user_id]
      );
    }

    // ------------------------------------------------------------------
    // 7. Commit transaction
    // ------------------------------------------------------------------
    await req.qRun("COMMIT");
    txOpen = false;

    try {
  await sendWelcomeEmail({
    email: emailRaw,
    restaurantName: nameRaw,
  });
} catch (e) {
  console.error(
    "Welcome email failed:",
    e?.message || e
  );
}
    // ------------------------------------------------------------------
    // 8. Create JWT
    // ------------------------------------------------------------------
    const expiresIn = getJwtExpirySecondsFromNow();
    const expiresAt = getNextMonthlyLogoutAt();

    const token = jwt.sign(
      {
        id: user_id,
        role: "owner",
        restaurant_id,
      },
      SECRET_KEY,
      { expiresIn }
    );

    // ------------------------------------------------------------------
    // 9. Success response
    // ------------------------------------------------------------------
    return res.status(201).json({
      success: true,
      restaurant_id,
      user_id,
      role: "owner",
      token,
      expires_at: expiresAt.toISOString(),
    });
  } catch (e) {
  /*
   * Roll back exactly once if registration failed
   * after the transaction started.
   */
  if (txOpen) {
    try {
      await req.qRun(
        "ROLLBACK"
      );
    } catch {}

    txOpen =
      false;
  }

  /*
   * PostgreSQL unique constraint is the final
   * race-proof checkout replay barrier.
   */
  if (
    e?.code ===
      "23505" &&
    String(
      e?.constraint || ""
    ) ===
      "ux_restaurants_stripe_checkout_session_id"
  ) {
    return res
      .status(409)
      .json({
        error:
          "This checkout has already been used",

        code:
          "CHECKOUT_ALREADY_USED",
      });
  }
    console.error("❌ register-restaurant failed:", e);

    const status =
  Number(e?.status || 500);

return res
  .status(status)
  .json({
    error:
      status >= 500
        ? "Internal Server Error"
        : e?.message ||
          "Registration rejected",

    ...(e?.code
      ? {
          code:
            e.code,
        }
      : {}),
  });
  }
});

// ========================= STAFF PICKER (for POS selector UI if you want it) =========================
router.get("/staff", authenticateToken, loadMembership, async (req, res) => {
  try {
    const rid = Number(req.tenantRid);

    const rows = await req.qAll(
      `
      SELECT id, username, full_name, role,
             COALESCE(pin_label, username) AS label
      FROM users
      WHERE restaurant_id = ?
        AND ${truthyExpr(req.kind, "can_pos_login")}
        AND ${truthyExpr(req.kind, "is_active")}
      ORDER BY role, full_name, username
      `,
      [rid]
    );

    res.json(rows || []);
  } catch (e) {
    console.error("❌ GET /staff failed:", e?.message || e);
    res.status(500).json({ error: "Failed to load staff" });
  }
});

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function ensurePasswordResetTable(req) {
  if (req.kind === "pg") {
    await req.qRun(`
      CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
}

router.post("/request-reset", async (req, res) => {  try {
    await ensurePasswordResetTable(req);

    const identity = String(req.body?.usernameOrEmail || "").trim().toLowerCase();

    // Always return generic response for security
    const generic = {
      success: true,
      message: "If this account exists, a reset link has been sent.",
    };

    if (!identity) return res.json(generic);

    const user = await req.qGet(
      `
      SELECT id, username
      FROM ${req.kind === "pg" ? "public.users" : "users"}
      WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
      LIMIT 1
      `,
      [identity]
    );

    if (!user) return res.json(generic);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await req.qRun(
      `
      INSERT INTO ${req.kind === "pg" ? "public.password_reset_tokens" : "password_reset_tokens"}
        (user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ${nowSql(req.kind)})
      `,
      [user.id, tokenHash, expiresAt]
    );

    const frontendUrl = String(process.env.FRONTEND_URL || "https://maksos.co.uk").replace(/\/+$/, "");
    const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

    await sendPasswordResetEmail({
      email: user.username,
      resetUrl,
    });

    return res.json(generic);
  } catch (e) {
    console.error("❌ request-reset failed:", e);
    return res.status(500).json({ error: "Could not start password reset." });
  }
});

router.post("/reset-password", async (req, res) => {  try {
    await ensurePasswordResetTable(req);

    const token = String(req.body?.token || "").trim();
    const newPassword = String(req.body?.password || "");

    if (!token || newPassword.length < 8) {
      return res.status(400).json({ error: "Invalid token or password too short." });
    }

    const tokenHash = hashResetToken(token);

    const row = await req.qGet(
      `
      SELECT id, user_id, expires_at, used_at
      FROM ${req.kind === "pg" ? "public.password_reset_tokens" : "password_reset_tokens"}
      WHERE token_hash = ?
      LIMIT 1
      `,
      [tokenHash]
    );

    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Reset link is invalid or expired." });
    }

    const hash = bcrypt.hashSync(newPassword, SALT_ROUNDS);

    await req.qRun(
      `
      UPDATE ${req.kind === "pg" ? "public.users" : "users"}
      SET password = ?, password_hash = ?
      WHERE id = ?
      `,
      [hash, hash, row.user_id]
    );

    await req.qRun(
      `
      UPDATE ${req.kind === "pg" ? "public.password_reset_tokens" : "password_reset_tokens"}
      SET used_at = ${nowSql(req.kind)}
      WHERE id = ?
      `,
      [row.id]
    );

    return res.json({ success: true, message: "Password updated successfully." });
  } catch (e) {
    console.error("❌ reset-password failed:", e);
    return res.status(500).json({ error: "Could not reset password." });
  }
});

module.exports = router;
