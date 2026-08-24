const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { SECRET_KEY } = require("../../utils/constants");
const { requirePlatformAdmin } = require("../../middleware/requirePlatformAdmin");

const {
  ccLoginIpLimiter,
  ccLoginAccountLimiter,
} = require("../../middleware/ccLoginSecurity");

const router = express.Router();

const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  "maks-invalid-platform-admin-password",
  10
);

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function clientIp(req) {
  return String(
    req.ip ||
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      ""
  ).slice(0, 255);
}

async function writeLoginEvent(
  req,
  {
    adminUserId = null,
    emailAttempted = "",
    success = false,
    reason = "unknown",
  }
) {
  try {
    await req.qRun(
      `
      INSERT INTO public.platform_admin_login_events (
        admin_user_id,
        email_attempted,
        success,
        reason,
        ip_address,
        user_agent,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        NOW()
      )
      `,
      [
        adminUserId ? Number(adminUserId) : null,
        normalizeEmail(emailAttempted),
        !!success,
        String(reason || "unknown"),
        clientIp(req),
        String(req.headers["user-agent"] || "").slice(0, 1000),
      ]
    );
  } catch (error) {
    /*
     * A logging problem must not crash authentication.
     * It is still printed so MAKS logs expose the failure.
     */
    console.error(
      "❌ Failed to record CC login event:",
      error
    );
  }
}

async function registerFailedLogin(req, admin) {
  if (!admin?.id) return null;

  return req.qGet(
    `
    UPDATE public.platform_admin_users
    SET
      failed_login_count =
        COALESCE(failed_login_count, 0) + 1,

      last_failed_login_at = NOW(),

      locked_until =
        CASE
          WHEN COALESCE(failed_login_count, 0) + 1 >= 10
            THEN NOW() + INTERVAL '24 hours'

          WHEN COALESCE(failed_login_count, 0) + 1 >= 7
            THEN NOW() + INTERVAL '1 hour'

          WHEN COALESCE(failed_login_count, 0) + 1 >= 5
            THEN NOW() + INTERVAL '30 minutes'

          WHEN COALESCE(failed_login_count, 0) + 1 >= 3
            THEN NOW() + INTERVAL '15 minutes'

          ELSE locked_until
        END

    WHERE id = $1

    RETURNING
      failed_login_count,
      last_failed_login_at,
      locked_until
    `,
    [Number(admin.id)]
  );
}

function genericLoginError(res) {
  return res.status(401).json({
    error: "Invalid email or password",
    code: "CC_INVALID_CREDENTIALS",
  });
}

function signPlatformAdminToken(admin) {
  return jwt.sign(
    {
      kind: "platform_admin",
      id: Number(admin.id),

      role: String(admin.role || "")
        .trim()
        .toLowerCase(),

      email: normalizeEmail(admin.email),

      security_version: Number(
        admin.security_version || 1
      ),
    },
    SECRET_KEY,
    {
      expiresIn: "1h",
      issuer: "maks-os",
      audience: "maks-cc",
    }
  );
}

router.post(
  "/login",
  ccLoginIpLimiter,
  ccLoginAccountLimiter,
  async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");

      if (!email || !password) {
        await writeLoginEvent(req, {
          emailAttempted: email,
          success: false,
          reason: "missing_credentials",
        });

        return res.status(400).json({
          error: "Email and password are required",
          code: "CC_CREDENTIALS_REQUIRED",
        });
      }

      const admin = await req.qGet(
        `
        SELECT
          id,
          email,
          password_hash,
          full_name,
          role,
          is_active,

          failed_login_count,
          last_failed_login_at,
          locked_until,
          password_changed_at,
          security_version

        FROM public.platform_admin_users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
        `,
        [email]
      );

      /*
       * Always perform a bcrypt comparison, even when the account
       * does not exist. This reduces account-discovery timing clues.
       */
      const passwordHash =
        admin?.password_hash || DUMMY_PASSWORD_HASH;

      const passwordMatches = bcrypt.compareSync(
        password,
        passwordHash
      );

      if (!admin) {
        await writeLoginEvent(req, {
          emailAttempted: email,
          success: false,
          reason: "unknown_account",
        });

        return genericLoginError(res);
      }

      if (!admin.is_active) {
        await writeLoginEvent(req, {
          adminUserId: admin.id,
          emailAttempted: email,
          success: false,
          reason: "inactive_account",
        });

        /*
         * Keep the external response generic so attackers cannot
         * discover whether an account exists or is inactive.
         */
        return genericLoginError(res);
      }

      const lockedUntil = admin.locked_until
        ? new Date(admin.locked_until)
        : null;

      if (
        lockedUntil &&
        Number.isFinite(lockedUntil.getTime()) &&
        lockedUntil.getTime() > Date.now()
      ) {
        await writeLoginEvent(req, {
          adminUserId: admin.id,
          emailAttempted: email,
          success: false,
          reason: "account_locked",
        });

        return res.status(423).json({
          error:
            "This account is temporarily locked. Try again later.",
          code: "CC_ACCOUNT_LOCKED",
          locked_until: admin.locked_until,
        });
      }

      if (!passwordMatches) {
        const failedState = await registerFailedLogin(
          req,
          admin
        );

        const nowLocked =
          failedState?.locked_until &&
          new Date(
            failedState.locked_until
          ).getTime() > Date.now();

        await writeLoginEvent(req, {
          adminUserId: admin.id,
          emailAttempted: email,
          success: false,
          reason: nowLocked
            ? "invalid_password_account_locked"
            : "invalid_password",
        });

        if (nowLocked) {
          return res.status(423).json({
            error:
              "This account is temporarily locked. Try again later.",
            code: "CC_ACCOUNT_LOCKED",
            locked_until: failedState.locked_until,
          });
        }

        return genericLoginError(res);
      }

      /*
       * Successful authentication resets all failed-login state.
       */
      const authenticatedAdmin = await req.qGet(
        `
        UPDATE public.platform_admin_users
        SET
          failed_login_count = 0,
          last_failed_login_at = NULL,
          locked_until = NULL,
          last_login_at = NOW()

        WHERE id = $1

        RETURNING
          id,
          email,
          full_name,
          role,
          is_active,
          security_version,
          last_login_at
        `,
        [Number(admin.id)]
      );

      if (!authenticatedAdmin?.id) {
        throw new Error(
          "Authenticated administrator could not be updated"
        );
      }

      const token = signPlatformAdminToken(
        authenticatedAdmin
      );

      await writeLoginEvent(req, {
        adminUserId: authenticatedAdmin.id,
        emailAttempted: email,
        success: true,
        reason: "login_success",
      });

      await req.qRun(
        `
        INSERT INTO public.platform_admin_audit (
          admin_user_id,
          action,
          entity,
          entity_id,
          meta,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          NOW()
        )
        `,
        [
          Number(authenticatedAdmin.id),
          "CC_LOGIN",
          "platform_admin_users",
          String(authenticatedAdmin.id),
          JSON.stringify({
            email: authenticatedAdmin.email,
            role: authenticatedAdmin.role,
            ip: clientIp(req),
            user_agent:
              req.headers["user-agent"] || null,
          }),
        ]
      );

      return res.json({
        success: true,
        token,

        admin: {
          id: Number(authenticatedAdmin.id),
          email: authenticatedAdmin.email,
          full_name:
            authenticatedAdmin.full_name || "",
          role: String(
            authenticatedAdmin.role || ""
          )
            .trim()
            .toLowerCase(),
        },
      });
    } catch (err) {
      console.error(
        "❌ POST /cc-auth/login failed:",
        err
      );

      return res.status(500).json({
        error: "Server error",
        code: "CC_LOGIN_SERVER_ERROR",
      });
    }
  }
);

// GET /cc-auth/me
router.get("/me", requirePlatformAdmin(), async (req, res) => {
  try {
    return res.json({
      id: req.platformAdmin.id,
      email: req.platformAdmin.email,
      full_name: req.platformAdmin.full_name,
      role: req.platformAdmin.role,
    });
  } catch (err) {
    console.error("❌ GET /cc-auth/me failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;