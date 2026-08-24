const express =
  require("express");

const {
  authenticateToken,
} = require(
  "../middleware/authMiddleware"
);

const {
  loadMembership,
} = require(
  "../middleware/tenantMembership"
);

const {
  PERMISSIONS,
  requirePermission,
} = require(
  "../middleware/accessControl"
);

const router =
  express.Router();

/*
 * Device heartbeat is part of normal POS usage.
 *
 * It does NOT grant device-management authority.
 */
router.post(
  "/access-heartbeat",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.POS_VIEW
  ),
  async (req, res) => {
    try {
      const restaurantId =
        Number(
          req.tenantRid ||
            req.user
              ?.restaurant_id ||
            0
        );

      const deviceKey =
        String(
          req.headers[
            "x-device-key"
          ] ||
            req.body?.device_key ||
            ""
        ).trim();

      if (
        !restaurantId ||
        !deviceKey
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing restaurantId or device_key",
          });
      }

      const row =
        await req.qGet(
          `
          INSERT INTO public.pos_device_sessions (
            restaurant_id,
            device_key,
            is_active,
            last_seen_at
          )
          VALUES (
            $1,
            $2,
            TRUE,
            NOW()
          )

          ON CONFLICT (
            restaurant_id,
            device_key
          )
          DO UPDATE SET
            is_active = TRUE,
            last_seen_at = NOW()

          RETURNING id
          `,
          [
            restaurantId,
            deviceKey,
          ]
        );

      return res.json({
        success: true,
        active: !!row?.id,
      });
    } catch (err) {
      console.error(
        "❌ POST /device/access-heartbeat failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to refresh POS device session",
      });
    }
  }
);

router.post(
  "/access-release",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.POS_VIEW
  ),
  async (req, res) => {
    try {
      const restaurantId =
        Number(
          req.tenantRid ||
            req.user
              ?.restaurant_id ||
            0
        );

      const deviceKey =
        String(
          req.headers[
            "x-device-key"
          ] ||
            req.body?.device_key ||
            ""
        ).trim();

      if (
        !restaurantId ||
        !deviceKey
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing restaurantId or device_key",
          });
      }

      await req.qRun(
        `
        UPDATE public.pos_device_sessions
        SET
          is_active = FALSE,
          released_at = NOW()
        WHERE restaurant_id = $1
          AND device_key = $2
          AND is_active = TRUE
        `,
        [
          restaurantId,
          deviceKey,
        ]
      );

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "❌ POST /device/access-release failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to release POS slot",
      });
    }
  }
);

module.exports = router;