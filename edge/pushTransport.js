"use strict";

const os =
  require("os");

const {
  claimOutboxEvents,
  ackOutboxEvent,
  failOutboxEvent,
  ensureSyncState,
  updateSyncState,
} = require(
  "./syncStore"
);


class EdgePushError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "EdgePushError";

    this.code =
      code;

    if (details !== null) {
      this.details =
        details;
    }
  }
}


function requirePositiveInteger(
  value,
  label
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(
      number
    ) ||
    number <= 0
  ) {
    throw new EdgePushError(
      "EDGE_PUSH_ARGUMENT_INVALID",
      `${label} must be a positive integer`
    );
  }

  return number;
}


function requireUuid(
  value,
  label
) {
  const text =
    String(
      value || ""
    ).trim();

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      text
    )
  ) {
    throw new EdgePushError(
      "EDGE_PUSH_ARGUMENT_INVALID",
      `${label} must be a UUID`
    );
  }

  return text;
}


function requireText(
  value,
  label,
  max = 2000
) {
  const text =
    String(
      value || ""
    ).trim();

  if (
    !text ||
    text.length > max
  ) {
    throw new EdgePushError(
      "EDGE_PUSH_ARGUMENT_INVALID",
      `${label} is invalid`
    );
  }

  return text;
}


function normaliseCloudUrl(
  value
) {
  return requireText(
    value,
    "cloudUrl",
    2000
  ).replace(
    /\/+$/,
    ""
  );
}


function defaultWorkerId() {
  return (
    `maks-edge-push:` +
    `${os.hostname()}:` +
    `${process.pid}`
  );
}


function retryDelaySeconds(
  retryCount
) {
  const retries =
    Math.max(
      1,
      Number(
        retryCount || 1
      )
    );

  /*
   * 2, 4, 8, 16 ... capped at five minutes.
   */
  return Math.min(
    300,
    2 ** Math.min(
      retries,
      8
    )
  );
}


async function countPendingOutbox(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        COUNT(*)::int AS count
      FROM
        public.edge_outbox
      WHERE
        restaurant_id = $1
        AND status IN (
          'pending',
          'failed',
          'in_flight'
        )
      `,
      [
        restaurantId,
      ]
    );

  return Number(
    result.rows[0]
      ?.count || 0
  );
}


function transportEvent(
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


async function failClaimedEvents({
  events,

  restaurantId,

  workerId,

  pool,

  error,
}) {
  const message =
    String(
      error ||
      "MAKS Edge push failed"
    ).slice(
      0,
      2000
    );

  for (
    const event of events
  ) {
    try {
      await failOutboxEvent({
        restaurantId,

        eventId:
          event.event_id,

        workerId,

        retryDelaySeconds:
          retryDelaySeconds(
            event.retry_count
          ),

        lastError:
          message,

        pool,
      });
    } catch (failureError) {
      console.error(
        "❌ MAKS Edge could not release failed outbox event",
        {
          event_id:
            event.event_id,

          error:
            String(
              failureError
                ?.message ||
              failureError
            ).slice(
              0,
              500
            ),
        }
      );
    }
  }
}


async function pushOutboxOnce({
  pool,

  cloudUrl,

  installationId,

  edgeSecret,

  restaurantId,

  workerId =
    defaultWorkerId(),

  limit = 25,

  leaseSeconds = 30,

  timeoutMs = 10000,

  fetchImpl =
    globalThis.fetch,
}) {
  if (
    !pool ||
    typeof pool.query !==
      "function" ||
    typeof pool.connect !==
      "function"
  ) {
    throw new EdgePushError(
      "EDGE_PUSH_POOL_INVALID",
      "Edge-local PostgreSQL pool is required"
    );
  }

  if (
    typeof fetchImpl !==
    "function"
  ) {
    throw new EdgePushError(
      "EDGE_PUSH_FETCH_UNAVAILABLE",
      "Fetch implementation is unavailable"
    );
  }

  const rid =
    requirePositiveInteger(
      restaurantId,
      "restaurantId"
    );

  const iid =
    requireUuid(
      installationId,
      "installationId"
    );

  const secret =
    requireText(
      edgeSecret,
      "edgeSecret",
      1000
    );

  const baseUrl =
    normaliseCloudUrl(
      cloudUrl
    );

  const worker =
    requireText(
      workerId,
      "workerId",
      200
    );

  const existingState =
    await ensureSyncState({
      restaurantId:
        rid,

      installationId:
        iid,

      pool,
    });

  const claimed =
    await claimOutboxEvents({
      restaurantId:
        rid,

      workerId:
        worker,

      limit,

      leaseSeconds,

      pool,
    });

  if (!claimed.length) {
    const pending =
      await countPendingOutbox(
        pool,
        rid
      );

    await updateSyncState({
      restaurantId:
        rid,

      installationId:
        iid,

      patch: {
        syncStatus:
          pending === 0
            ? "synced"
            : "pending",

        pendingOutboxEvents:
          pending,

        lastError:
          null,
      },

      pool,
    });

    return {
      success: true,

      claimed: 0,
      acked: 0,
      rejected: 0,
      pending,
    };
  }

  await updateSyncState({
    restaurantId:
      rid,

    installationId:
      iid,

    patch: {
      syncStatus:
        "syncing",

      pendingOutboxEvents:
        await countPendingOutbox(
          pool,
          rid
        ),

      lastPushAt:
        new Date(),

      lastError:
        null,
    },

    pool,
  });

  let response;
  let responseBody;

  try {
    response =
      await fetchImpl(
        `${baseUrl}/edge/sync/push`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",

            "x-edge-installation-id":
              iid,

            "x-edge-secret":
              secret,
          },

          body:
            JSON.stringify({
              events:
                claimed.map(
                  transportEvent
                ),
            }),

          signal:
            AbortSignal.timeout(
              Math.max(
                1000,
                Number(
                  timeoutMs
                ) || 10000
              )
            ),
        }
      );

    try {
      responseBody =
        await response.json();
    } catch {
      responseBody =
        null;
    }
  } catch (error) {
    await failClaimedEvents({
      events:
        claimed,

      restaurantId:
        rid,

      workerId:
        worker,

      pool,

      error:
        error?.message ||
        "Cloud connection failed",
    });

    const pending =
      await countPendingOutbox(
        pool,
        rid
      );

    const failures =
      Number(
        existingState
          ?.consecutive_failures ||
        0
      ) + 1;

    await updateSyncState({
      restaurantId:
        rid,

      installationId:
        iid,

      patch: {
        syncStatus:
          "error",

        pendingOutboxEvents:
          pending,

        consecutiveFailures:
          failures,

        lastError:
          String(
            error?.message ||
            error
          ).slice(
            0,
            2000
          ),
      },

      pool,
    });

    return {
      success: false,

      claimed:
        claimed.length,

      acked: 0,

      rejected:
        claimed.length,

      pending,

      error:
        "EDGE_PUSH_CONNECTION_FAILED",
    };
  }

  if (
    !response.ok ||
    responseBody
      ?.success !== true ||
    !Array.isArray(
      responseBody?.acked
    ) ||
    !Array.isArray(
      responseBody?.rejected
    )
  ) {
    const errorMessage =
      (
        responseBody?.error ||
        `Cloud push rejected with HTTP ${response.status}`
      );

    await failClaimedEvents({
      events:
        claimed,

      restaurantId:
        rid,

      workerId:
        worker,

      pool,

      error:
        errorMessage,
    });

    const pending =
      await countPendingOutbox(
        pool,
        rid
      );

    await updateSyncState({
      restaurantId:
        rid,

      installationId:
        iid,

      patch: {
        syncStatus:
          "error",

        pendingOutboxEvents:
          pending,

        consecutiveFailures:
          Number(
            existingState
              ?.consecutive_failures ||
            0
          ) + 1,

        lastError:
          String(
            errorMessage
          ).slice(
            0,
            2000
          ),
      },

      pool,
    });

    return {
      success: false,

      claimed:
        claimed.length,

      acked: 0,

      rejected:
        claimed.length,

      pending,

      error:
        responseBody?.code ||
        "EDGE_PUSH_REJECTED",
    };
  }

  const claimedIds =
    new Set(
      claimed.map(
        (row) =>
          String(
            row.event_id
          )
      )
    );

  const ackedIds =
    new Set();

  const rejectedById =
    new Map();

  for (
    const ack of
      responseBody.acked
  ) {
    const id =
      String(
        ack?.event_id ||
        ""
      );

    if (
      !claimedIds.has(id) ||
      ackedIds.has(id)
    ) {
      continue;
    }

    ackedIds.add(id);
  }

  for (
    const rejected of
      responseBody.rejected
  ) {
    const id =
      String(
        rejected
          ?.event_id ||
        ""
      );

    if (
      !claimedIds.has(id) ||
      ackedIds.has(id) ||
      rejectedById.has(id)
    ) {
      continue;
    }

    rejectedById.set(
      id,
      rejected
    );
  }

  const acknowledgedRows =
    [];

  for (
    const event of claimed
  ) {
    const id =
      String(
        event.event_id
      );

    if (
      ackedIds.has(id)
    ) {
      const acked =
        await ackOutboxEvent({
          restaurantId:
            rid,

          eventId:
            id,

          workerId:
            worker,

          pool,
        });

      acknowledgedRows.push(
        acked
      );

      continue;
    }

    const rejection =
      rejectedById.get(
        id
      );

    const reason =
      rejection
        ? (
            rejection.error ||
            rejection.code ||
            "Cloud rejected event"
          )
        : "Cloud response did not acknowledge this event";

    await failOutboxEvent({
      restaurantId:
        rid,

      eventId:
        id,

      workerId:
        worker,

      retryDelaySeconds:
        retryDelaySeconds(
          event.retry_count
        ),

      lastError:
        reason,

      pool,
    });
  }

  const pending =
    await countPendingOutbox(
      pool,
      rid
    );

  const rejectedCount =
    claimed.length -
    acknowledgedRows.length;

  const fullySuccessful =
    rejectedCount === 0;

  const highestAckedId =
    acknowledgedRows.length
      ? Math.max(
          ...acknowledgedRows.map(
            (row) =>
              Number(
                row.id
              )
          )
        )
      : null;

  await updateSyncState({
    restaurantId:
      rid,

    installationId:
      iid,

    patch: {
      syncStatus:
        rejectedCount > 0
          ? "error"
          : (
              pending === 0
                ? "synced"
                : "pending"
            ),

      pendingOutboxEvents:
        pending,

      consecutiveFailures:
        fullySuccessful
          ? 0
          : (
              Number(
                existingState
                  ?.consecutive_failures ||
                0
              ) + 1
            ),

      lastPushAt:
        new Date(),

      lastSuccessAt:
        acknowledgedRows.length
          ? new Date()
          : (
              existingState
                ?.last_success_at ||
              null
            ),

      lastAckedOutboxId:
        highestAckedId ??
        (
          existingState
            ?.last_acked_outbox_id ??
          null
        ),

      lastError:
        fullySuccessful
          ? null
          : "One or more Edge events were rejected by Cloud",
    },

    pool,
  });

  return {
    success:
      fullySuccessful,

    claimed:
      claimed.length,

    acked:
      acknowledgedRows.length,

    rejected:
      rejectedCount,

    pending,
  };
}


module.exports = {
  EdgePushError,
  pushOutboxOnce,
};
