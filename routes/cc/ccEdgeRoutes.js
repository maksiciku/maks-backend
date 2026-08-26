"use strict";

const express =
  require("express");

const {
  requirePlatformAdmin,
} = require(
  "../../middleware/requirePlatformAdmin"
);

const {
  withTx,
} = require(
  "../../dbCompat"
);

const {
  generateEdgeCredentials,
} = require(
  "../../utils/edgeAuth"
);

const router =
  express.Router();

function publicError(
  message,
  statusCode,
  code
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  error.code =
    code;

  return error;
}

function cleanEdgeName(value) {
  const name =
    String(
      value || "MAKS Edge"
    )
      .trim()
      .replace(
        /\s+/g,
        " "
      );

  if (!name) {
    return "MAKS Edge";
  }

  if (
    name.length > 120
  ) {
    throw publicError(
      "Edge name is too long.",
      400,
      "EDGE_NAME_INVALID"
    );
  }

  return name;
}

async function writeAudit(
  db,
  {
    adminUserId,
    action,
    restaurantId,
    edgeId,
    meta = {},
  }
) {
  await db.qRun(
    `
    INSERT INTO
      public.platform_admin_audit
      (
        admin_user_id,
        action,
        target_restaurant_id,
        entity,
        entity_id,
        meta,
        created_at
      )

    VALUES
      (
        $1,
        $2,
        $3,
        'restaurant_edge_nodes',
        $4,
        $5::jsonb,
        NOW()
      )
    `,
    [
      Number(adminUserId),
      String(action),
      Number(restaurantId),
      String(edgeId),
      JSON.stringify(
        meta || {}
      ),
    ]
  );
}

function edgeHealth(row) {
  if (
    row.is_active !== true
  ) {
    return {
      online: false,
      status: "disabled",
    };
  }

  if (!row.last_seen_at) {
    return {
      online: false,
      status: "waiting",
    };
  }

  const seenMs =
    new Date(
      row.last_seen_at
    ).getTime();

  const ageSeconds =
    Number.isFinite(seenMs)
      ? Math.max(
          0,
          Math.floor(
            (
              Date.now() -
              seenMs
            ) / 1000
          )
        )
      : null;

  if (
    ageSeconds === null ||
    ageSeconds > 45
  ) {
    return {
      online: false,
      status: "offline",
      age_seconds:
        ageSeconds,
    };
  }

  if (
    row.local_db_status ===
      "error" ||
    row.sync_status ===
      "error"
  ) {
    return {
      online: true,
      status: "critical",
      age_seconds:
        ageSeconds,
    };
  }

  if (
    row.local_db_status ===
      "warning" ||
    Number(
      row.pending_sync_events ||
        0
    ) > 100 ||
    String(
      row.last_sync_error ||
        ""
    ).trim()
  ) {
    return {
      online: true,
      status: "warning",
      age_seconds:
        ageSeconds,
    };
  }

  return {
    online: true,
    status: "healthy",
    age_seconds:
      ageSeconds,
  };
}

function serializeEdge(row) {
  const health =
    edgeHealth(row);

  return {
    id:
      Number(row.id),

    restaurant_id:
      Number(
        row.restaurant_id
      ),

    restaurant_name:
      row.restaurant_name ||
      "",

    installation_id:
      row.installation_id,

    edge_name:
      row.edge_name ||
      "MAKS Edge",

    is_active:
      row.is_active === true,

    version:
      row.version || "",

    first_seen_at:
      row.first_seen_at,

    last_seen_at:
      row.last_seen_at,

    local_db_status:
      row.local_db_status ||
      "unknown",

    local_db_latency_ms:
      row.local_db_latency_ms != null
        ? Number(
            row.local_db_latency_ms
          )
        : null,

    internet_status:
      health.status === "offline"
        ? "offline"
        : health.online
          ? "online"
          : (
              row.internet_status ||
              "unknown"
            ),

    cloud_latency_ms:
      row.cloud_latency_ms != null
        ? Number(
            row.cloud_latency_ms
          )
        : null,

    sync_status:
      row.sync_status ||
      "unknown",

    pending_sync_events:
      Number(
        row.pending_sync_events ||
          0
      ),

    last_sync_at:
      row.last_sync_at,

    last_sync_error:
      row.last_sync_error ||
      "",

    uptime_seconds:
      row.uptime_seconds != null
        ? Number(
            row.uptime_seconds
          )
        : null,

    disk_free_mb:
      row.disk_free_mb != null
        ? Number(
            row.disk_free_mb
          )
        : null,

    created_at:
      row.created_at,

    updated_at:
      row.updated_at,

    online:
      health.online,

    health_status:
      health.status,

    heartbeat_age_seconds:
      health.age_seconds ??
      null,

    heartbeat_threshold_seconds:
      45,
  };
}

const EDGE_SELECT = `
  SELECT
    e.id,
    e.restaurant_id,
    e.installation_id,
    e.edge_name,
    e.is_active,
    e.version,
    e.first_seen_at,
    e.last_seen_at,
    e.local_db_status,
    e.local_db_latency_ms,
    e.internet_status,
    e.cloud_latency_ms,
    e.sync_status,
    e.pending_sync_events,
    e.last_sync_at,
    e.last_sync_error,
    e.uptime_seconds,
    e.disk_free_mb,
    e.created_at,
    e.updated_at,

    r.name AS restaurant_name

  FROM
    public.restaurant_edge_nodes e

  JOIN
    public.restaurants r
    ON r.id =
       e.restaurant_id
`;

router.get(
  "/",
  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),
  async (req, res) => {
    try {
      const rows =
        await req.qAll(
          `
          ${EDGE_SELECT}

          ORDER BY
            e.is_active DESC,
            e.last_seen_at DESC NULLS LAST,
            e.id DESC
          `
        );

      const edges =
        (rows || []).map(
          serializeEdge
        );

      const summary = {
        total:
          edges.length,

        active:
          edges.filter(
            (edge) =>
              edge.is_active
          ).length,

        healthy:
          edges.filter(
            (edge) =>
              edge.health_status ===
              "healthy"
          ).length,

        warning:
          edges.filter(
            (edge) =>
              edge.health_status ===
              "warning"
          ).length,

        critical:
          edges.filter(
            (edge) =>
              edge.health_status ===
              "critical"
          ).length,

        offline:
          edges.filter(
            (edge) =>
              edge.health_status ===
              "offline"
          ).length,

        waiting:
          edges.filter(
            (edge) =>
              edge.health_status ===
              "waiting"
          ).length,

        disabled:
          edges.filter(
            (edge) =>
              edge.health_status ===
              "disabled"
          ).length,

        pending_sync_events:
          edges.reduce(
            (sum, edge) =>
              sum +
              Number(
                edge.pending_sync_events ||
                  0
              ),
            0
          ),

        heartbeat_threshold_seconds:
          45,
      };

      return res.json({
        success: true,
        summary,
        edges,
      });
    } catch (error) {
      console.error(
        "❌ GET /cc/edge failed:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            "Failed to load MAKS Edge status",
        });
    }
  }
);

router.get(
  "/restaurants/:restaurantId",
  requirePlatformAdmin(
    "boss",
    "admin_manager",
    "support_staff",
    "read_only"
  ),
  async (req, res) => {
    try {
      const restaurantId =
        Number(
          req.params
            .restaurantId
        );

      if (
        !Number.isInteger(
          restaurantId
        ) ||
        restaurantId <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Invalid restaurant id",
          });
      }

      const restaurant =
        await req.qGet(
          `
          SELECT
            id,
            name
          FROM
            public.restaurants
          WHERE
            id = $1
          LIMIT 1
          `,
          [restaurantId]
        );

      if (!restaurant) {
        return res
          .status(404)
          .json({
            success: false,
            error:
              "Restaurant not found",
          });
      }

      const rows =
        await req.qAll(
          `
          ${EDGE_SELECT}

          WHERE
            e.restaurant_id =
              $1

          ORDER BY
            e.is_active DESC,
            e.created_at DESC,
            e.id DESC
          `,
          [restaurantId]
        );

      return res.json({
        success: true,

        restaurant: {
          id:
            Number(
              restaurant.id
            ),
          name:
            restaurant.name ||
            "",
        },

        edges:
          (rows || []).map(
            serializeEdge
          ),
      });
    } catch (error) {
      console.error(
        "❌ GET restaurant MAKS Edge failed:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            "Failed to load restaurant MAKS Edge",
        });
    }
  }
);

router.post(
  "/restaurants/:restaurantId/provision",
  requirePlatformAdmin(
    "boss",
    "admin_manager"
  ),
  async (req, res) => {
    try {
      const restaurantId =
        Number(
          req.params
            .restaurantId
        );

      if (
        !Number.isInteger(
          restaurantId
        ) ||
        restaurantId <= 0
      ) {
        throw publicError(
          "Invalid restaurant id.",
          400,
          "EDGE_RESTAURANT_INVALID"
        );
      }

      const edgeName =
        cleanEdgeName(
          req.body?.edge_name
        );

      const result =
        await withTx(
          async (tx) => {
            const restaurant =
              await tx.qGet(
                `
                SELECT
                  id,
                  name,
                  account_status

                FROM
                  public.restaurants

                WHERE
                  id = $1

                LIMIT 1

                FOR UPDATE
                `,
                [
                  restaurantId,
                ]
              );

            if (!restaurant) {
              throw publicError(
                "Restaurant not found.",
                404,
                "EDGE_RESTAURANT_NOT_FOUND"
              );
            }

            await tx.qRun(
              `
              UPDATE
                public.restaurant_edge_nodes

              SET
                is_active =
                  FALSE,

                updated_at =
                  NOW()

              WHERE
                restaurant_id =
                  $1

                AND is_active =
                  TRUE
              `,
              [
                restaurantId,
              ]
            );

            const credentials =
              generateEdgeCredentials();

            const row =
              await tx.qGet(
                `
                INSERT INTO
                  public.restaurant_edge_nodes
                  (
                    restaurant_id,
                    installation_id,
                    edge_name,
                    secret_hash,
                    is_active,
                    local_db_status,
                    internet_status,
                    sync_status,
                    pending_sync_events,
                    created_at,
                    updated_at
                  )

                VALUES
                  (
                    $1,
                    $2::uuid,
                    $3,
                    $4,
                    TRUE,
                    'unknown',
                    'unknown',
                    'unknown',
                    0,
                    NOW(),
                    NOW()
                  )

                RETURNING
                  id,
                  restaurant_id,
                  installation_id,
                  edge_name,
                  is_active,
                  created_at
                `,
                [
                  restaurantId,
                  credentials
                    .installationId,
                  edgeName,
                  credentials
                    .secretHash,
                ]
              );

            await writeAudit(
              tx,
              {
                adminUserId:
                  req.platformAdmin
                    .id,

                action:
                  "CC_EDGE_PROVISION",

                restaurantId,

                edgeId:
                  row.id,

                meta: {
                  edge_name:
                    edgeName,

                  installation_id:
                    credentials
                      .installationId,

                  restaurant_name:
                    restaurant.name ||
                    "",
                },
              }
            );

            return {
              row,
              credentials,
            };
          }
        );

      /*
       * SECURITY:
       * secret is intentionally returned ONCE here.
       * Only secret_hash is stored in PostgreSQL.
       * Never log this response.
       */
      return res
        .status(201)
        .json({
          success: true,

          message:
            "MAKS Edge provisioned. Save the secret now; it will not be shown again.",

          edge: {
            id:
              Number(
                result.row.id
              ),

            restaurant_id:
              Number(
                result.row
                  .restaurant_id
              ),

            installation_id:
              result.row
                .installation_id,

            edge_name:
              result.row
                .edge_name,

            is_active:
              result.row
                .is_active ===
              true,

            created_at:
              result.row
                .created_at,
          },

          credentials: {
            installation_id:
              result.credentials
                .installationId,

            secret:
              result.credentials
                .secret,
          },
        });
    } catch (error) {
      console.error(
        "❌ MAKS Edge provision failed:",
        error?.code ||
          error?.message
      );

      return res
        .status(
          Number(
            error?.statusCode ||
              500
          )
        )
        .json({
          success: false,

          error:
            error?.statusCode
              ? error.message
              : "Failed to provision MAKS Edge",

          code:
            error?.code ||
            "EDGE_PROVISION_FAILED",
        });
    }
  }
);

router.patch(
  "/:edgeId/status",
  requirePlatformAdmin(
    "boss",
    "admin_manager"
  ),
  async (req, res) => {
    try {
      const edgeId =
        Number(
          req.params.edgeId
        );

      if (
        !Number.isInteger(
          edgeId
        ) ||
        edgeId <= 0
      ) {
        throw publicError(
          "Invalid Edge id.",
          400,
          "EDGE_ID_INVALID"
        );
      }

      if (
        typeof req.body
          ?.is_active !==
        "boolean"
      ) {
        throw publicError(
          "is_active must be true or false.",
          400,
          "EDGE_STATUS_INVALID"
        );
      }

      const nextActive =
        req.body.is_active;

      const row =
        await withTx(
          async (tx) => {
            const edge =
              await tx.qGet(
                `
                SELECT
                  id,
                  restaurant_id,
                  installation_id,
                  edge_name,
                  is_active

                FROM
                  public.restaurant_edge_nodes

                WHERE
                  id = $1

                LIMIT 1

                FOR UPDATE
                `,
                [edgeId]
              );

            if (!edge) {
              throw publicError(
                "MAKS Edge not found.",
                404,
                "EDGE_NOT_FOUND"
              );
            }

            await tx.qGet(
              `
              SELECT
                id
              FROM
                public.restaurants
              WHERE
                id = $1
              FOR UPDATE
              `,
              [
                Number(
                  edge.restaurant_id
                ),
              ]
            );

            if (nextActive) {
              await tx.qRun(
                `
                UPDATE
                  public.restaurant_edge_nodes

                SET
                  is_active =
                    FALSE,

                  updated_at =
                    NOW()

                WHERE
                  restaurant_id =
                    $1

                  AND id <> $2

                  AND is_active =
                    TRUE
                `,
                [
                  Number(
                    edge.restaurant_id
                  ),
                  edgeId,
                ]
              );
            }

            const updated =
              await tx.qGet(
                `
                UPDATE
                  public.restaurant_edge_nodes

                SET
                  is_active =
                    $1,

                  updated_at =
                    NOW()

                WHERE
                  id = $2

                RETURNING
                  id,
                  restaurant_id,
                  installation_id,
                  edge_name,
                  is_active,
                  updated_at
                `,
                [
                  nextActive,
                  edgeId,
                ]
              );

            await writeAudit(
              tx,
              {
                adminUserId:
                  req.platformAdmin
                    .id,

                action:
                  nextActive
                    ? "CC_EDGE_ENABLE"
                    : "CC_EDGE_DISABLE",

                restaurantId:
                  edge.restaurant_id,

                edgeId,

                meta: {
                  edge_name:
                    edge.edge_name ||
                    "",

                  installation_id:
                    edge
                      .installation_id,

                  is_active:
                    nextActive,
                },
              }
            );

            return updated;
          }
        );

      return res.json({
        success: true,

        edge: {
          id:
            Number(row.id),

          restaurant_id:
            Number(
              row.restaurant_id
            ),

          installation_id:
            row.installation_id,

          edge_name:
            row.edge_name,

          is_active:
            row.is_active ===
            true,

          updated_at:
            row.updated_at,
        },
      });
    } catch (error) {
      console.error(
        "❌ MAKS Edge status update failed:",
        error?.code ||
          error?.message
      );

      return res
        .status(
          Number(
            error?.statusCode ||
              500
          )
        )
        .json({
          success: false,

          error:
            error?.statusCode
              ? error.message
              : "Failed to update MAKS Edge status",

          code:
            error?.code ||
            "EDGE_STATUS_FAILED",
        });
    }
  }
);

router.post(
  "/:edgeId/rotate-secret",
  requirePlatformAdmin(
    "boss"
  ),
  async (req, res) => {
    try {
      const edgeId =
        Number(
          req.params.edgeId
        );

      if (
        !Number.isInteger(
          edgeId
        ) ||
        edgeId <= 0
      ) {
        throw publicError(
          "Invalid Edge id.",
          400,
          "EDGE_ID_INVALID"
        );
      }

      const result =
        await withTx(
          async (tx) => {
            const edge =
              await tx.qGet(
                `
                SELECT
                  id,
                  restaurant_id,
                  installation_id,
                  edge_name

                FROM
                  public.restaurant_edge_nodes

                WHERE
                  id = $1

                LIMIT 1

                FOR UPDATE
                `,
                [edgeId]
              );

            if (!edge) {
              throw publicError(
                "MAKS Edge not found.",
                404,
                "EDGE_NOT_FOUND"
              );
            }

            const credentials =
              generateEdgeCredentials();

            await tx.qRun(
              `
              UPDATE
                public.restaurant_edge_nodes

              SET
                secret_hash =
                  $1,

                updated_at =
                  NOW()

              WHERE
                id = $2
              `,
              [
                credentials
                  .secretHash,
                edgeId,
              ]
            );

            await writeAudit(
              tx,
              {
                adminUserId:
                  req.platformAdmin
                    .id,

                action:
                  "CC_EDGE_ROTATE_SECRET",

                restaurantId:
                  edge.restaurant_id,

                edgeId,

                meta: {
                  edge_name:
                    edge.edge_name ||
                    "",

                  installation_id:
                    edge
                      .installation_id,
                },
              }
            );

            return {
              edge,
              secret:
                credentials.secret,
            };
          }
        );

      return res.json({
        success: true,

        message:
          "MAKS Edge secret rotated. Save the new secret now; it will not be shown again.",

        edge: {
          id:
            Number(
              result.edge.id
            ),

          restaurant_id:
            Number(
              result.edge
                .restaurant_id
            ),

          installation_id:
            result.edge
              .installation_id,

          edge_name:
            result.edge
              .edge_name,
        },

        credentials: {
          installation_id:
            result.edge
              .installation_id,

          secret:
            result.secret,
        },
      });
    } catch (error) {
      console.error(
        "❌ MAKS Edge secret rotation failed:",
        error?.code ||
          error?.message
      );

      return res
        .status(
          Number(
            error?.statusCode ||
              500
          )
        )
        .json({
          success: false,

          error:
            error?.statusCode
              ? error.message
              : "Failed to rotate MAKS Edge secret",

          code:
            error?.code ||
            "EDGE_ROTATE_SECRET_FAILED",
        });
    }
  }
);

module.exports = router;
