"use strict";

const express =
  require("express");

const crypto =
  require("node:crypto");

const fs =
  require("node:fs");

const path =
  require("node:path");

const {
  edgeSecretMatches,
} = require(
  "../utils/edgeAuth"
);

const {
  EdgeSyncError,
  hashJson,
  receiveInboxEvent,
  claimOutboxEvents,
  ackOutboxEvent,
} = require(
  "../edge/syncStore"
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

function edgeAuthError(
  status,
  code,
  message
) {
  const error =
    new Error(message);

  error.statusCode =
    status;

  error.code =
    code;

  return error;
}


async function authenticateEdgeRequest(
  req
) {
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
    throw edgeAuthError(
      401,
      "EDGE_AUTH_REQUIRED",
      "Missing MAKS Edge credentials"
    );
  }

  if (
    !isUuid(
      installationId
    )
  ) {
    throw edgeAuthError(
      401,
      "EDGE_AUTH_INVALID",
      "Invalid MAKS Edge credentials"
    );
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
      [
        installationId,
      ]
    );

  if (
    !edge?.id
  ) {
    throw edgeAuthError(
      401,
      "EDGE_AUTH_INVALID",
      "Invalid MAKS Edge credentials"
    );
  }

  if (
    edge.is_active !==
    true
  ) {
    throw edgeAuthError(
      403,
      "EDGE_DISABLED",
      "MAKS Edge installation is disabled"
    );
  }

  if (
    !edgeSecretMatches(
      edge.secret_hash,
      suppliedSecret
    )
  ) {
    throw edgeAuthError(
      401,
      "EDGE_AUTH_INVALID",
      "Invalid MAKS Edge credentials"
    );
  }

  return edge;
}


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

const {
  POS_ORDER_SUBMITTED_EVENT_TYPE,
  PosOperationalSyncError,
  validatePosOrderSubmittedEvent,
  applyPosOrderSubmittedCloud,
} = require(
  "../edge/contracts/posOperations"
);

const {
  KdsOperationalSyncError,
  isKdsOperationalEventType,
  validateKdsOperationalEvent,
  applyKdsOperationalCloud,
} = require(
  "../edge/contracts/kdsOperations"
);

const {
  TableOperationalSyncError,
  isTableOperationalEventType,
  validateTableOperationalEvent,
  applyTableOperationalCloud,
} = require(
  "../edge/contracts/tableOperations"
);

const {
  FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE,
  FINANCIAL_REFUND_RECORDED_EVENT_TYPE,
  FinancialOperationalSyncError,
  validateFinancialSettlementRecordedEvent,
  validateFinancialRefundRecordedEvent,
  applyFinancialSettlementRecordedCloud,
  applyFinancialRefundRecordedCloud,
} = require(
  "../edge/contracts/financialOperations"
);

/*
 * =========================================================
 * EDGE → CLOUD PUSH TRANSPORT
 * =========================================================
 *
 * restaurant_id is NEVER trusted as authority.
 * The authenticated Edge installation owns the tenant.
 */
router.post(
  "/sync/push",
  async (req, res) => {
    try {
      const edge =
        await authenticateEdgeRequest(
          req
        );

      const restaurantId =
        Number(
          edge.restaurant_id
        );

      const installationId =
        String(
          edge.installation_id
        );

      const events =
        req.body?.events;

      if (
        !Array.isArray(events)
      ) {
        return res
          .status(400)
          .json({
            success: false,
            code:
              "EDGE_PUSH_EVENTS_REQUIRED",
            error:
              "events must be an array",
          });
      }

      if (
        events.length > 25
      ) {
        return res
          .status(400)
          .json({
            success: false,
            code:
              "EDGE_PUSH_BATCH_TOO_LARGE",
            error:
              "A maximum of 25 Edge events may be pushed at once",
          });
      }

      const requestBytes =
        Buffer.byteLength(
          JSON.stringify(
            req.body || {}
          ),
          "utf8"
        );

      if (
        requestBytes >
        1024 * 1024
      ) {
        return res
          .status(413)
          .json({
            success: false,
            code:
              "EDGE_PUSH_PAYLOAD_TOO_LARGE",
            error:
              "MAKS Edge push payload is too large",
          });
      }

      const acked = [];
      const rejected = [];

      for (
        const rawEvent of events
      ) {
        const eventId =
          String(
            rawEvent
              ?.event_id ||
            ""
          ).trim();

        if (
          !isUuid(eventId)
        ) {
          rejected.push({
            event_id:
              eventId ||
              null,

            code:
              "EDGE_EVENT_ID_INVALID",

            error:
              "event_id must be a UUID",
          });

          continue;
        }

        const suppliedRestaurantId =
          Number(
            rawEvent
              ?.restaurant_id
          );

        if (
          suppliedRestaurantId !==
          restaurantId
        ) {
          rejected.push({
            event_id:
              eventId,

            code:
              "EDGE_TENANT_MISMATCH",

            error:
              "Edge event restaurant does not match authenticated installation",
          });

          continue;
        }

        const suppliedHash =
          String(
            rawEvent
              ?.payload_hash ||
            ""
          )
            .trim()
            .toLowerCase();

        if (
          !/^[0-9a-f]{64}$/.test(
            suppliedHash
          )
        ) {
          rejected.push({
            event_id:
              eventId,

            code:
              "EDGE_PAYLOAD_HASH_INVALID",

            error:
              "payload_hash is invalid",
          });

          continue;
        }

        let calculatedHash;

        try {
          calculatedHash =
            hashJson(
              rawEvent?.payload
            );
        } catch (error) {
          rejected.push({
            event_id:
              eventId,

            code:
              error?.code ||
              "EDGE_PAYLOAD_INVALID",

            error:
              error?.message ||
              "Edge payload is invalid",
          });

          continue;
        }

        if (
          calculatedHash !==
          suppliedHash
        ) {
          rejected.push({
            event_id:
              eventId,

            code:
              "EDGE_PAYLOAD_HASH_MISMATCH",

            error:
              "Edge payload does not match payload_hash",
          });

          continue;
        }

        try {
          if (
            String(
              rawEvent
                ?.event_type ||
              ""
            ) ===
            POS_ORDER_SUBMITTED_EVENT_TYPE
          ) {
            validatePosOrderSubmittedEvent(
              rawEvent,
              {
                restaurantId,
                sourceInstallationId:
                  installationId,
              }
            );
          }

          if (
            isKdsOperationalEventType(
              rawEvent
                ?.event_type
            )
          ) {
            validateKdsOperationalEvent(
              rawEvent,
              {
                restaurantId,
                sourceInstallationId:
                  installationId,
              }
            );
          }

          if (
            isTableOperationalEventType(
              rawEvent
                ?.event_type
            )
          ) {
            validateTableOperationalEvent(
              rawEvent,
              {
                restaurantId,
                sourceInstallationId:
                  installationId,
              }
            );
          }

          if (
            String(
              rawEvent
                ?.event_type ||
              ""
            ) ===
            FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE
          ) {
            validateFinancialSettlementRecordedEvent(
              rawEvent,
              {
                restaurantId,
                sourceInstallationId:
                  installationId,
              }
            );
          }

          if (
            String(
              rawEvent
                ?.event_type ||
              ""
            ) ===
            FINANCIAL_REFUND_RECORDED_EVENT_TYPE
          ) {
            validateFinancialRefundRecordedEvent(
              rawEvent,
              {
                restaurantId,
                sourceInstallationId:
                  installationId,
              }
            );
          }

          const received =
            await receiveInboxEvent({
              eventId,

              restaurantId,

              source:
                "edge",

              sourceInstallationId:
                installationId,

              eventType:
                rawEvent
                  ?.event_type,

              entityType:
                rawEvent
                  ?.entity_type ??
                null,

              entityId:
                rawEvent
                  ?.entity_id ??
                null,

              payload:
                rawEvent
                  ?.payload,
            });

          let applied =
            null;

          if (
            String(
              rawEvent
                ?.event_type ||
              ""
            ) ===
            POS_ORDER_SUBMITTED_EVENT_TYPE
          ) {
            applied =
              await applyPosOrderSubmittedCloud({
                event:
                  rawEvent,

                restaurantId,

                sourceInstallationId:
                  installationId,
              });
          }

          if (
            isKdsOperationalEventType(
              rawEvent
                ?.event_type
            )
          ) {
            applied =
              await applyKdsOperationalCloud({
                event:
                  rawEvent,

                restaurantId,

                sourceInstallationId:
                  installationId,
              });
          }

          if (
            isTableOperationalEventType(
              rawEvent
                ?.event_type
            )
          ) {
            applied =
              await applyTableOperationalCloud({
                event:
                  rawEvent,

                restaurantId,

                sourceInstallationId:
                  installationId,
              });
          }

          if (
            String(
              rawEvent
                ?.event_type ||
              ""
            ) ===
            FINANCIAL_SETTLEMENT_RECORDED_EVENT_TYPE
          ) {
            applied =
              await applyFinancialSettlementRecordedCloud({
                event:
                  rawEvent,

                restaurantId,

                sourceInstallationId:
                  installationId,
              });
          }

          if (
            String(
              rawEvent
                ?.event_type ||
              ""
            ) ===
            FINANCIAL_REFUND_RECORDED_EVENT_TYPE
          ) {
            applied =
              await applyFinancialRefundRecordedCloud({
                event:
                  rawEvent,

                restaurantId,

                sourceInstallationId:
                  installationId,
              });
          }

          acked.push({
            event_id:
              eventId,

            duplicate:
              received
                ?.duplicate ===
                true ||
              applied
                ?.duplicate ===
                true,
          });
        } catch (error) {
          if (
            error instanceof
              EdgeSyncError ||
            error instanceof
              PosOperationalSyncError ||
            error instanceof
              KdsOperationalSyncError ||
            error instanceof
              TableOperationalSyncError ||
            error instanceof
              FinancialOperationalSyncError
          ) {
            rejected.push({
              event_id:
                eventId,

              code:
                error.code ||
                "EDGE_EVENT_REJECTED",

              error:
                error.message,
            });

            continue;
          }

          throw error;
        }
      }

      return res.json({
        success: true,

        restaurant_id:
          restaurantId,

        installation_id:
          installationId,

        acked,

        rejected,

        server_time:
          new Date()
            .toISOString(),
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode
        );

      if (
        status === 401 ||
        status === 403
      ) {
        return res
          .status(status)
          .json({
            success: false,

            code:
              error.code ||
              "EDGE_AUTH_INVALID",

            error:
              error.message ||
              "MAKS Edge authentication failed",
          });
      }

      console.error(
        "❌ MAKS Edge push failed:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          code:
            "EDGE_PUSH_FAILED",

          error:
            "MAKS Edge push failed",
        });
    }
  }
);


/*
 * =========================================================
 * CLOUD → EDGE PULL TRANSPORT
 * =========================================================
 *
 * Cloud edge_outbox is the durable source.
 * The authenticated installation determines restaurant
 * ownership. The Edge may never request another tenant.
 */

function edgePullWorkerId(
  installationId
) {
  return (
    "edge-pull:" +
    String(
      installationId
    )
  );
}


function serializeCloudEvent(
  row
) {
  return {
    event_id:
      row.event_id,

    restaurant_id:
      Number(
        row.restaurant_id
      ),

    event_type:
      row.event_type,

    entity_type:
      row.entity_type ||
      null,

    entity_id:
      row.entity_id ||
      null,

    idempotency_key:
      row.idempotency_key,

    payload:
      row.payload,

    payload_hash:
      row.payload_hash,

    created_at:
      row.created_at,
  };
}


router.post(
  "/sync/pull",
  async (req, res) => {
    try {
      const edge =
        await authenticateEdgeRequest(
          req
        );

      const restaurantId =
        Number(
          edge.restaurant_id
        );

      const installationId =
        String(
          edge.installation_id
        );

      const requestedLimit =
        req.body?.limit ===
          undefined
          ? 25
          : Number(
              req.body.limit
            );

      if (
        !Number.isSafeInteger(
          requestedLimit
        ) ||
        requestedLimit < 1 ||
        requestedLimit > 25
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            code:
              "EDGE_PULL_LIMIT_INVALID",

            error:
              "Pull limit must be between 1 and 25",
          });
      }

      const events =
        await claimOutboxEvents({
          restaurantId,

          workerId:
            edgePullWorkerId(
              installationId
            ),

          limit:
            requestedLimit,

          leaseSeconds:
            30,
        });

      return res.json({
        success:
          true,

        restaurant_id:
          restaurantId,

        installation_id:
          installationId,

        events:
          events.map(
            serializeCloudEvent
          ),

        server_time:
          new Date()
            .toISOString(),
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode
        );

      if (
        status === 401 ||
        status === 403
      ) {
        return res
          .status(status)
          .json({
            success:
              false,

            code:
              error.code ||
              "EDGE_AUTH_INVALID",

            error:
              error.message ||
              "MAKS Edge authentication failed",
          });
      }

      if (
        error instanceof
          EdgeSyncError
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            code:
              error.code,

            error:
              error.message,
          });
      }

      console.error(
        "❌ MAKS Edge pull failed:",
        error
      );

      return res
        .status(500)
        .json({
          success:
            false,

          code:
            "EDGE_PULL_FAILED",

          error:
            "MAKS Edge pull failed",
        });
    }
  }
);


router.post(
  "/sync/pull/ack",
  async (req, res) => {
    try {
      const edge =
        await authenticateEdgeRequest(
          req
        );

      const restaurantId =
        Number(
          edge.restaurant_id
        );

      const installationId =
        String(
          edge.installation_id
        );

      const eventIds =
        req.body
          ?.event_ids;

      if (
        !Array.isArray(
          eventIds
        )
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            code:
              "EDGE_PULL_ACK_REQUIRED",

            error:
              "event_ids must be an array",
          });
      }

      if (
        eventIds.length >
        25
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            code:
              "EDGE_PULL_ACK_TOO_LARGE",

            error:
              "A maximum of 25 events may be acknowledged at once",
          });
      }

      const workerId =
        edgePullWorkerId(
          installationId
        );

      const acked = [];
      const rejected = [];

      for (
        const rawEventId of
          eventIds
      ) {
        const eventId =
          String(
            rawEventId ||
            ""
          ).trim();

        if (
          !isUuid(
            eventId
          )
        ) {
          rejected.push({
            event_id:
              eventId ||
              null,

            code:
              "EDGE_EVENT_ID_INVALID",

            error:
              "event_id must be a UUID",
          });

          continue;
        }

        try {
          await ackOutboxEvent({
            restaurantId,

            eventId,

            workerId,
          });

          acked.push({
            event_id:
              eventId,

            duplicate:
              false,
          });

          continue;
        } catch (error) {
          /*
           * ACK itself must be idempotent.
           *
           * If Cloud committed the first ACK but the
           * HTTP response disappeared, the next ACK for
           * the same restaurant/event is harmless.
           */
          if (
            error instanceof
              EdgeSyncError &&
            error.code ===
              "EDGE_OUTBOX_NOT_OWNED"
          ) {
            const existing =
              await req.qGet(
                `
                SELECT
                  status
                FROM
                  public.edge_outbox
                WHERE
                  restaurant_id = $1
                  AND
                  event_id =
                    $2::uuid
                LIMIT 1
                `,
                [
                  restaurantId,
                  eventId,
                ]
              );

            if (
              existing
                ?.status ===
              "acked"
            ) {
              acked.push({
                event_id:
                  eventId,

                duplicate:
                  true,
              });

              continue;
            }
          }

          if (
            error instanceof
              EdgeSyncError
          ) {
            rejected.push({
              event_id:
                eventId,

              code:
                error.code,

              error:
                error.message,
            });

            continue;
          }

          throw error;
        }
      }

      return res.json({
        success:
          true,

        restaurant_id:
          restaurantId,

        installation_id:
          installationId,

        acked,

        rejected,

        server_time:
          new Date()
            .toISOString(),
      });
    } catch (error) {
      const status =
        Number(
          error?.statusCode
        );

      if (
        status === 401 ||
        status === 403
      ) {
        return res
          .status(status)
          .json({
            success:
              false,

            code:
              error.code ||
              "EDGE_AUTH_INVALID",

            error:
              error.message ||
              "MAKS Edge authentication failed",
          });
      }

      console.error(
        "❌ MAKS Edge pull ACK failed:",
        error
      );

      return res
        .status(500)
        .json({
          success:
            false,

          code:
            "EDGE_PULL_ACK_FAILED",

          error:
            "MAKS Edge pull acknowledgement failed",
        });
    }
  }
);



/*
 * =========================================================
 * CLOUD → EDGE PROMOTION ASSET FETCH
 * =========================================================
 *
 * Authority:
 * - credentials identify one Edge installation
 * - installation owns one restaurant
 * - promotion lookup is restricted to that restaurant
 * - caller never supplies a filesystem path
 */

const PROMOTION_ASSET_MAX_BYTES =
  20 * 1024 * 1024;


function promotionAssetUploadsRoot() {
  const configured =
    String(
      process.env
        .MAKS_EDGE_ASSET_UPLOADS_ROOT ||
      ""
    ).trim();

  return path.resolve(
    configured ||
      path.join(
        process.cwd(),
        "uploads"
      )
  );
}


function promotionAssetPathInside(
  base,
  target
) {
  const relative =
    path.relative(
      base,
      target
    );

  return (
    relative === "" ||
    (
      !relative.startsWith(
        `..${path.sep}`
      ) &&
      relative !== ".." &&
      !path.isAbsolute(
        relative
      )
    )
  );
}


function promotionAssetFilename({
  restaurantId,
  imageUrl,
}) {
  const rid =
    Number(
      restaurantId
    );

  const raw =
    String(
      imageUrl || ""
    ).trim();

  const prefix =
    `/uploads/${rid}/promotions/`;

  if (
    !Number.isSafeInteger(
      rid
    ) ||
    rid <= 0 ||
    !raw.startsWith(
      prefix
    )
  ) {
    throw edgeAuthError(
      409,
      "EDGE_PROMOTION_ASSET_PATH_INVALID",
      "Promotion image path is invalid"
    );
  }

  const filename =
    raw.slice(
      prefix.length
    );

  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes(
      "/"
    ) ||
    filename.includes(
      "\\"
    ) ||
    filename.includes(
      "\0"
    ) ||
    path.basename(
      filename
    ) !==
      filename
  ) {
    throw edgeAuthError(
      409,
      "EDGE_PROMOTION_ASSET_PATH_INVALID",
      "Promotion image path is invalid"
    );
  }

  let decoded =
    filename;

  try {
    decoded =
      decodeURIComponent(
        filename
      );
  } catch {
    decoded =
      filename;
  }

  if (
    decoded.includes(
      "/"
    ) ||
    decoded.includes(
      "\\"
    ) ||
    decoded === "." ||
    decoded === ".."
  ) {
    throw edgeAuthError(
      409,
      "EDGE_PROMOTION_ASSET_PATH_INVALID",
      "Promotion image path is invalid"
    );
  }

  return filename;
}


async function promotionAssetSha256(
  filePath
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const hash =
        crypto.createHash(
          "sha256"
        );

      const stream =
        fs.createReadStream(
          filePath
        );

      stream.on(
        "error",
        reject
      );

      stream.on(
        "data",
        (chunk) =>
          hash.update(
            chunk
          )
      );

      stream.on(
        "end",
        () =>
          resolve(
            hash.digest(
              "hex"
            )
          )
      );
    }
  );
}


async function resolveCloudPromotionAsset({
  restaurantId,
  imageUrl,
}) {
  const rid =
    Number(
      restaurantId
    );

  const filename =
    promotionAssetFilename({
      restaurantId:
        rid,

      imageUrl,
    });

  const uploadsRoot =
    promotionAssetUploadsRoot();

  const directory =
    path.resolve(
      uploadsRoot,
      String(
        rid
      ),
      "promotions"
    );

  const target =
    path.resolve(
      directory,
      filename
    );

  if (
    !promotionAssetPathInside(
      uploadsRoot,
      directory
    ) ||
    !promotionAssetPathInside(
      directory,
      target
    ) ||
    target === directory
  ) {
    throw edgeAuthError(
      409,
      "EDGE_PROMOTION_ASSET_PATH_INVALID",
      "Promotion image path escaped the restaurant uploads directory"
    );
  }

  let rootReal;
  let directoryReal;
  let targetReal;
  let lstat;

  try {
    [
      rootReal,
      directoryReal,
      targetReal,
      lstat,
    ] =
      await Promise.all([
        fs.promises
          .realpath(
            uploadsRoot
          ),

        fs.promises
          .realpath(
            directory
          ),

        fs.promises
          .realpath(
            target
          ),

        fs.promises
          .lstat(
            target
          ),
      ]);
  } catch (error) {
    if (
      error?.code ===
        "ENOENT"
    ) {
      throw edgeAuthError(
        404,
        "EDGE_PROMOTION_ASSET_FILE_MISSING",
        "Promotion image file is not available"
      );
    }

    throw error;
  }

  if (
    !promotionAssetPathInside(
      rootReal,
      directoryReal
    ) ||
    !promotionAssetPathInside(
      directoryReal,
      targetReal
    ) ||
    lstat.isSymbolicLink() ||
    !lstat.isFile()
  ) {
    throw edgeAuthError(
      409,
      "EDGE_PROMOTION_ASSET_PATH_INVALID",
      "Promotion image file is invalid"
    );
  }

  const size =
    Number(
      lstat.size
    );

  if (
    !Number.isSafeInteger(
      size
    ) ||
    size < 0 ||
    size >
      PROMOTION_ASSET_MAX_BYTES
  ) {
    throw edgeAuthError(
      413,
      "EDGE_PROMOTION_ASSET_TOO_LARGE",
      "Promotion image file exceeds the Edge asset limit"
    );
  }

  const sha256 =
    await promotionAssetSha256(
      targetReal
    );

  return {
    filename,

    filePath:
      targetReal,

    size,

    sha256,
  };
}


router.get(
  "/assets/promotions/:promotionId/image",
  async (req, res) => {
    try {
      const edge =
        await authenticateEdgeRequest(
          req
        );

      const restaurantId =
        Number(
          edge.restaurant_id
        );

      const promotionId =
        Number(
          req.params
            .promotionId
        );

      if (
        !Number.isSafeInteger(
          promotionId
        ) ||
        promotionId <= 0
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            code:
              "EDGE_PROMOTION_ASSET_ID_INVALID",

            error:
              "Promotion id is invalid",
          });
      }

      const promotion =
        await req.qGet(
          `
          SELECT
            id,
            image_url
          FROM
            public.restaurant_promotions
          WHERE
            id = $1
            AND restaurant_id = $2
          LIMIT 1
          `,
          [
            promotionId,
            restaurantId,
          ]
        );

      if (
        !promotion?.id
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            code:
              "EDGE_PROMOTION_ASSET_NOT_FOUND",

            error:
              "Promotion image was not found",
          });
      }

      if (
        !String(
          promotion.image_url ||
          ""
        ).trim()
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            code:
              "EDGE_PROMOTION_ASSET_NOT_FOUND",

            error:
              "Promotion image was not found",
          });
      }

      const asset =
        await resolveCloudPromotionAsset({
          restaurantId,

          imageUrl:
            promotion.image_url,
        });

      res.set(
        "x-maks-asset-sha256",
        asset.sha256
      );

      res.set(
        "x-maks-asset-size",
        String(
          asset.size
        )
      );

      res.set(
        "cache-control",
        "private, no-cache"
      );

      const localSha =
        String(
          req.headers[
            "x-maks-local-sha256"
          ] ||
          ""
        )
          .trim()
          .toLowerCase();

      if (
        /^[0-9a-f]{64}$/.test(
          localSha
        ) &&
        localSha ===
          asset.sha256
      ) {
        return res
          .status(304)
          .end();
      }

      res.type(
        asset.filename
      );

      res.set(
        "content-length",
        String(
          asset.size
        )
      );

      const stream =
        fs.createReadStream(
          asset.filePath
        );

      stream.on(
        "error",
        (error) => {
          console.error(
            "❌ MAKS Edge promotion asset stream failed:",
            String(
              error?.message ||
              error
            ).slice(
              0,
              300
            )
          );

          if (
            !res.headersSent
          ) {
            res
              .status(500)
              .end();
          } else {
            res.destroy(
              error
            );
          }
        }
      );

      return stream.pipe(
        res
      );
    } catch (error) {
      if (
        Number.isSafeInteger(
          error?.statusCode
        ) &&
        error?.code
      ) {
        return res
          .status(
            error.statusCode
          )
          .json({
            success:
              false,

            code:
              error.code,

            error:
              error.message,
          });
      }

      console.error(
        "❌ MAKS Edge promotion asset fetch failed:",
        String(
          error?.message ||
          error
        ).slice(
          0,
          500
        )
      );

      return res
        .status(500)
        .json({
          success:
            false,

          code:
            "EDGE_PROMOTION_ASSET_FAILED",

          error:
            "Promotion image fetch failed",
        });
    }
  }
);



/*
 * =========================================================
 * CLOUD → EDGE MENU IMAGE FETCH
 * =========================================================
 */

const MENU_ASSET_MAX_BYTES =
  4 * 1024 * 1024;

function normalizeMenuAssetType(raw) {
  const type =
    String(raw || "")
      .trim()
      .toLowerCase();

  if (
    type === "meal" ||
    type === "meals"
  ) {
    return "meal";
  }

  if (
    type === "drink" ||
    type === "drinks"
  ) {
    return "drink";
  }

  if (
    type === "dessert" ||
    type === "desserts"
  ) {
    return "dessert";
  }

  throw edgeAuthError(
    400,
    "EDGE_MENU_ASSET_TYPE_INVALID",
    "Menu item type is invalid"
  );
}

function menuAssetFilename({
  restaurantId,
  photoUrl,
}) {
  const rid =
    Number(restaurantId);

  const raw =
    String(photoUrl || "").trim();

  const prefix =
    `/uploads/${rid}/menu-items/`;

  if (
    !Number.isSafeInteger(rid) ||
    rid <= 0 ||
    !raw.startsWith(prefix)
  ) {
    throw edgeAuthError(
      409,
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image path is invalid"
    );
  }

  const filename =
    raw.slice(prefix.length);

  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    path.basename(filename) !==
      filename
  ) {
    throw edgeAuthError(
      409,
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image path is invalid"
    );
  }

  let decoded = filename;

  try {
    decoded =
      decodeURIComponent(filename);
  } catch {
    decoded = filename;
  }

  if (
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded === "." ||
    decoded === ".."
  ) {
    throw edgeAuthError(
      409,
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image path is invalid"
    );
  }

  return filename;
}

async function resolveCloudMenuAsset({
  restaurantId,
  photoUrl,
}) {
  const rid =
    Number(restaurantId);

  const filename =
    menuAssetFilename({
      restaurantId: rid,
      photoUrl,
    });

  const uploadsRoot =
    promotionAssetUploadsRoot();

  const directory =
    path.resolve(
      uploadsRoot,
      String(rid),
      "menu-items"
    );

  const target =
    path.resolve(
      directory,
      filename
    );

  if (
    !promotionAssetPathInside(
      uploadsRoot,
      directory
    ) ||
    !promotionAssetPathInside(
      directory,
      target
    ) ||
    target === directory
  ) {
    throw edgeAuthError(
      409,
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image path escaped the restaurant uploads directory"
    );
  }

  let rootReal;
  let directoryReal;
  let targetReal;
  let lstat;

  try {
    [
      rootReal,
      directoryReal,
      targetReal,
      lstat,
    ] =
      await Promise.all([
        fs.promises.realpath(
          uploadsRoot
        ),
        fs.promises.realpath(
          directory
        ),
        fs.promises.realpath(
          target
        ),
        fs.promises.lstat(
          target
        ),
      ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw edgeAuthError(
        404,
        "EDGE_MENU_ASSET_FILE_MISSING",
        "Menu image file is not available"
      );
    }

    throw error;
  }

  if (
    !promotionAssetPathInside(
      rootReal,
      directoryReal
    ) ||
    !promotionAssetPathInside(
      directoryReal,
      targetReal
    ) ||
    lstat.isSymbolicLink() ||
    !lstat.isFile()
  ) {
    throw edgeAuthError(
      409,
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image file is invalid"
    );
  }

  const size =
    Number(lstat.size);

  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size >
      MENU_ASSET_MAX_BYTES
  ) {
    throw edgeAuthError(
      413,
      "EDGE_MENU_ASSET_TOO_LARGE",
      "Menu image file exceeds the Edge asset limit"
    );
  }

  const sha256 =
    await promotionAssetSha256(
      targetReal
    );

  return {
    filename,
    filePath: targetReal,
    size,
    sha256,
  };
}

router.get(
  "/assets/menu/:type/:itemId/image",
  async (req, res) => {
    try {
      const edge =
        await authenticateEdgeRequest(
          req
        );

      const restaurantId =
        Number(
          edge.restaurant_id
        );

      const itemType =
        normalizeMenuAssetType(
          req.params.type
        );

      const itemId =
        Number(
          req.params.itemId
        );

      if (
        !Number.isSafeInteger(
          itemId
        ) ||
        itemId <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            code:
              "EDGE_MENU_ASSET_ID_INVALID",
            error:
              "Menu item id is invalid",
          });
      }

      let item = null;

      if (itemType === "meal") {
        item =
          await req.qGet(
            `
            SELECT
              id,
              photo_url
            FROM
              public.meals
            WHERE
              id = $1
              AND restaurant_id = $2
            LIMIT 1
            `,
            [
              itemId,
              restaurantId,
            ]
          );
      } else {
        item =
          await req.qGet(
            `
            SELECT
              id,
              photo_url
            FROM
              public.menu_items
            WHERE
              id = $1
              AND restaurant_id = $2
              AND LOWER(
                TRIM(
                  COALESCE(type, '')
                )
              ) IN (
                $3,
                $4
              )
            LIMIT 1
            `,
            [
              itemId,
              restaurantId,
              itemType,
              `${itemType}s`,
            ]
          );
      }

      if (
        !item?.id ||
        !String(
          item.photo_url || ""
        ).trim()
      ) {
        return res
          .status(404)
          .json({
            success: false,
            code:
              "EDGE_MENU_ASSET_NOT_FOUND",
            error:
              "Menu image was not found",
          });
      }

      const asset =
        await resolveCloudMenuAsset({
          restaurantId,
          photoUrl:
            item.photo_url,
        });

      res.set(
        "x-maks-asset-sha256",
        asset.sha256
      );

      res.set(
        "x-maks-asset-size",
        String(asset.size)
      );

      res.set(
        "cache-control",
        "private, no-cache"
      );

      const localSha =
        String(
          req.headers[
            "x-maks-local-sha256"
          ] || ""
        )
          .trim()
          .toLowerCase();

      if (
        /^[0-9a-f]{64}$/.test(
          localSha
        ) &&
        localSha === asset.sha256
      ) {
        return res
          .status(304)
          .end();
      }

      res.type(
        asset.filename
      );

      res.set(
        "content-length",
        String(asset.size)
      );

      const stream =
        fs.createReadStream(
          asset.filePath
        );

      stream.on(
        "error",
        (error) => {
          console.error(
            "❌ MAKS Edge menu asset stream failed:",
            String(
              error?.message ||
              error
            ).slice(0, 300)
          );

          if (!res.headersSent) {
            res
              .status(500)
              .end();
          } else {
            res.destroy(error);
          }
        }
      );

      return stream.pipe(res);
    } catch (error) {
      if (
        Number.isSafeInteger(
          error?.statusCode
        ) &&
        error?.code
      ) {
        return res
          .status(
            error.statusCode
          )
          .json({
            success: false,
            code: error.code,
            error:
              error.message,
          });
      }

      console.error(
        "❌ MAKS Edge menu asset fetch failed:",
        String(
          error?.message ||
          error
        ).slice(0, 500)
      );

      return res
        .status(500)
        .json({
          success: false,
          code:
            "EDGE_MENU_ASSET_FAILED",
          error:
            "Menu image fetch failed",
        });
    }
  }
);


module.exports = router;
