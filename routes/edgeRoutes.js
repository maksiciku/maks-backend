"use strict";

const express =
  require("express");

const {
  edgeSecretMatches,
} = require(
  "../utils/edgeAuth"
);

const router =
  express.Router();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

const LOCAL_DB_STATUSES =
  new Set([
    "unknown",
    "healthy",
    "warning",
    "error",
  ]);

const SYNC_STATUSES =
  new Set([
    "unknown",
    "synced",
    "pending",
    "syncing",
    "error",
  ]);

function badRequest(message) {
  const error =
    new Error(message);

  error.statusCode = 400;

  return error;
}

function parseEnum(
  value,
  allowed,
  fallback,
  field
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const clean =
    String(value)
      .trim()
      .toLowerCase();

  if (!allowed.has(clean)) {
    throw badRequest(
      `Invalid ${field}`
    );
  }

  return clean;
}

function parseInteger(
  value,
  field,
  {
    min = 0,
    max =
      Number.MAX_SAFE_INTEGER,
  } = {}
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  if (
    !Number.isInteger(number) ||
    number < min ||
    number > max
  ) {
    throw badRequest(
      `Invalid ${field}`
    );
  }

  return number;
}

function parseText(
  value,
  field,
  maxLength
) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const text =
    String(value).trim();

  if (
    text.length >
    maxLength
  ) {
    throw badRequest(
      `${field} is too long`
    );
  }

  return text || null;
}

function parseTimestamp(
  value,
  field
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    throw badRequest(
      `Invalid ${field}`
    );
  }

  return date.toISOString();
}

router.post(
  "/heartbeat",
  async (req, res) => {
    try {
      const installationId =
        String(
          req.headers[
            "x-edge-installation-id"
          ] || ""
        ).trim();

      const suppliedSecret =
        String(
          req.headers[
            "x-edge-secret"
          ] || ""
        ).trim();

      if (
        !installationId ||
        !suppliedSecret
      ) {
        return res
          .status(401)
          .json({
            success: false,
            error:
              "Missing MAKS Edge credentials",
            code:
              "EDGE_AUTH_REQUIRED",
          });
      }

      if (!isUuid(installationId)) {
        return res
          .status(401)
          .json({
            success: false,
            error:
              "Invalid MAKS Edge credentials",
            code:
              "EDGE_AUTH_INVALID",
          });
      }

      const edge =
        await req.qGet(
          `
          SELECT
            e.id,
            e.restaurant_id,
            e.installation_id,
            e.edge_name,
            e.secret_hash,
            e.is_active,

            r.name AS restaurant_name,
            r.account_status

          FROM
            public.restaurant_edge_nodes e

          JOIN
            public.restaurants r
            ON r.id =
               e.restaurant_id

          WHERE
            e.installation_id =
              $1::uuid

          LIMIT 1
          `,
          [installationId]
        );

      if (!edge?.id) {
        return res
          .status(401)
          .json({
            success: false,
            error:
              "Invalid MAKS Edge credentials",
            code:
              "EDGE_AUTH_INVALID",
          });
      }

      if (
        edge.is_active !==
        true
      ) {
        return res
          .status(403)
          .json({
            success: false,
            error:
              "MAKS Edge installation is disabled",
            code:
              "EDGE_DISABLED",
          });
      }

      if (
        !edgeSecretMatches(
          edge.secret_hash,
          suppliedSecret
        )
      ) {
        return res
          .status(401)
          .json({
            success: false,
            error:
              "Invalid MAKS Edge credentials",
            code:
              "EDGE_AUTH_INVALID",
          });
      }

      const version =
        parseText(
          req.body?.version,
          "version",
          64
        );

      const localDbStatus =
        parseEnum(
          req.body
            ?.local_db_status,
          LOCAL_DB_STATUSES,
          "unknown",
          "local_db_status"
        );

      const localDbLatencyMs =
        parseInteger(
          req.body
            ?.local_db_latency_ms,
          "local_db_latency_ms",
          {
            min: 0,
            max: 120000,
          }
        );

      const cloudLatencyMs =
        parseInteger(
          req.body
            ?.cloud_latency_ms,
          "cloud_latency_ms",
          {
            min: 0,
            max: 120000,
          }
        );

      const syncStatus =
        parseEnum(
          req.body
            ?.sync_status,
          SYNC_STATUSES,
          "unknown",
          "sync_status"
        );

      const pendingSyncEvents =
        parseInteger(
          req.body
            ?.pending_sync_events,
          "pending_sync_events",
          {
            min: 0,
            max: 1000000000,
          }
        ) ?? 0;

      const lastSyncAt =
        parseTimestamp(
          req.body
            ?.last_sync_at,
          "last_sync_at"
        );

      const lastSyncError =
        parseText(
          req.body
            ?.last_sync_error,
          "last_sync_error",
          2000
        );

      const uptimeSeconds =
        parseInteger(
          req.body
            ?.uptime_seconds,
          "uptime_seconds",
          {
            min: 0,
          }
        );

      const diskFreeMb =
        parseInteger(
          req.body
            ?.disk_free_mb,
          "disk_free_mb",
          {
            min: 0,
          }
        );

      const updated =
        await req.qGet(
          `
          UPDATE
            public.restaurant_edge_nodes

          SET
            version = $1,

            first_seen_at =
              COALESCE(
                first_seen_at,
                NOW()
              ),

            last_seen_at =
              NOW(),

            local_db_status =
              $2,

            local_db_latency_ms =
              $3,

            internet_status =
              'online',

            cloud_latency_ms =
              $4,

            sync_status =
              $5,

            pending_sync_events =
              $6,

            last_sync_at =
              $7,

            last_sync_error =
              $8,

            uptime_seconds =
              $9,

            disk_free_mb =
              $10,

            updated_at =
              NOW()

          WHERE
            id = $11

          RETURNING
            id,
            restaurant_id,
            installation_id,
            edge_name,
            version,
            first_seen_at,
            last_seen_at
          `,
          [
            version,
            localDbStatus,
            localDbLatencyMs,
            cloudLatencyMs,
            syncStatus,
            pendingSyncEvents,
            lastSyncAt,
            lastSyncError,
            uptimeSeconds,
            diskFreeMb,
            Number(edge.id),
          ]
        );

      return res.json({
        success: true,

        edge: {
          id:
            Number(
              updated.id
            ),

          restaurant_id:
            Number(
              updated
                .restaurant_id
            ),

          installation_id:
            updated
              .installation_id,

          edge_name:
            updated.edge_name,

          version:
            updated.version,

          first_seen_at:
            updated
              .first_seen_at,

          last_seen_at:
            updated
              .last_seen_at,
        },

        cloud: {
          status: "online",
          server_time:
            new Date()
              .toISOString(),
        },

        heartbeat_interval_seconds:
          15,
      });
    } catch (error) {
      if (
        Number(
          error?.statusCode
        ) === 400
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              error.message,
            code:
              "EDGE_HEARTBEAT_INVALID",
          });
      }

      console.error(
        "❌ MAKS Edge heartbeat failed:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            "MAKS Edge heartbeat failed",
          code:
            "EDGE_HEARTBEAT_FAILED",
        });
    }
  }
);

module.exports = router;
