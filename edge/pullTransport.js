"use strict";

const {
  EdgeSyncError,
  hashJson,
  receiveInboxEvent,
  ensureSyncState,
  updateSyncState,
} = require(
  "./syncStore"
);


class EdgePullError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "EdgePullError";

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
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    throw new EdgePullError(
      "EDGE_PULL_ARGUMENT_INVALID",
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
    throw new EdgePullError(
      "EDGE_PULL_ARGUMENT_INVALID",
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
    throw new EdgePullError(
      "EDGE_PULL_ARGUMENT_INVALID",
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


async function countLocalQueues(
  pool,
  restaurantId
) {
  const result =
    await pool.query(
      `
      SELECT
        (
          SELECT
            COUNT(*)::int
          FROM
            public.edge_outbox
          WHERE
            restaurant_id = $1
            AND status IN (
              'pending',
              'failed',
              'in_flight'
            )
        ) AS outbox,

        (
          SELECT
            COUNT(*)::int
          FROM
            public.edge_inbox
          WHERE
            restaurant_id = $1
            AND status IN (
              'received',
              'failed',
              'applying'
            )
        ) AS inbox
      `,
      [
        restaurantId,
      ]
    );

  return {
    outbox:
      Number(
        result.rows?.[0]
          ?.outbox || 0
      ),

    inbox:
      Number(
        result.rows?.[0]
          ?.inbox || 0
      ),
  };
}


async function postJson({
  url,
  installationId,
  edgeSecret,
  body,
  timeoutMs,
  fetchImpl,
}) {
  const response =
    await fetchImpl(
      url,
      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json",

          "x-edge-installation-id":
            installationId,

          "x-edge-secret":
            edgeSecret,
        },

        body:
          JSON.stringify(
            body
          ),

        signal:
          AbortSignal.timeout(
            timeoutMs
          ),
      }
    );

  let payload =
    null;

  try {
    payload =
      await response.json();
  } catch {
    payload =
      null;
  }

  return {
    response,
    payload,
  };
}


async function updateFailureState({
  pool,
  restaurantId,
  installationId,
  existingState,
  error,
}) {
  const queues =
    await countLocalQueues(
      pool,
      restaurantId
    );

  await updateSyncState({
    restaurantId,
    installationId,

    patch: {
      syncStatus:
        "error",

      pendingOutboxEvents:
        queues.outbox,

      pendingInboxEvents:
        queues.inbox,

      consecutiveFailures:
        Number(
          existingState
            ?.consecutive_failures ||
          0
        ) + 1,

      lastError:
        String(
          error ||
          "MAKS Edge pull failed"
        ).slice(
          0,
          2000
        ),
    },

    pool,
  });

  return queues;
}


async function pullFromCloudOnce({
  pool,

  cloudUrl,

  installationId,

  edgeSecret,

  restaurantId,

  limit = 25,

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
    throw new EdgePullError(
      "EDGE_PULL_POOL_INVALID",
      "Edge-local PostgreSQL pool is required"
    );
  }

  if (
    typeof fetchImpl !==
    "function"
  ) {
    throw new EdgePullError(
      "EDGE_PULL_FETCH_UNAVAILABLE",
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

  const safeLimit =
    Math.max(
      1,
      Math.min(
        25,
        Math.round(
          Number(limit) ||
          25
        )
      )
    );

  const safeTimeout =
    Math.max(
      1000,
      Number(timeoutMs) ||
      10000
    );

  const existingState =
    await ensureSyncState({
      restaurantId:
        rid,

      installationId:
        iid,

      pool,
    });

  let pullResponse;
  let pullBody;

  try {
    const result =
      await postJson({
        url:
          `${baseUrl}/edge/sync/pull`,

        installationId:
          iid,

        edgeSecret:
          secret,

        body: {
          limit:
            safeLimit,
        },

        timeoutMs:
          safeTimeout,

        fetchImpl,
      });

    pullResponse =
      result.response;

    pullBody =
      result.payload;
  } catch (error) {
    const queues =
      await updateFailureState({
        pool,

        restaurantId:
          rid,

        installationId:
          iid,

        existingState,

        error:
          error?.message ||
          error,
      });

    return {
      success:
        false,

      received:
        0,

      duplicates:
        0,

      acked:
        0,

      rejected:
        0,

      pending:
        queues.inbox,

      error:
        "EDGE_PULL_CONNECTION_FAILED",
    };
  }

  if (
    !pullResponse.ok ||
    pullBody?.success !==
      true ||
    !Array.isArray(
      pullBody?.events
    )
  ) {
    const errorMessage =
      pullBody?.error ||
      `Cloud pull rejected with HTTP ${pullResponse.status}`;

    const queues =
      await updateFailureState({
        pool,

        restaurantId:
          rid,

        installationId:
          iid,

        existingState,

        error:
          errorMessage,
      });

    return {
      success:
        false,

      received:
        0,

      duplicates:
        0,

      acked:
        0,

      rejected:
        0,

      pending:
        queues.inbox,

      error:
        pullBody?.code ||
        "EDGE_PULL_REJECTED",
    };
  }

  if (
    Number(
      pullBody
        ?.restaurant_id
    ) !== rid
  ) {
    const queues =
      await updateFailureState({
        pool,

        restaurantId:
          rid,

        installationId:
          iid,

        existingState,

        error:
          "Cloud pull tenant mismatch",
      });

    return {
      success:
        false,

      received:
        0,

      duplicates:
        0,

      acked:
        0,

      rejected:
        pullBody.events.length,

      pending:
        queues.inbox,

      error:
        "EDGE_PULL_TENANT_MISMATCH",
    };
  }

  const responseInstallationId =
    String(
      pullBody
        ?.installation_id ||
      ""
    ).trim();

  if (
    responseInstallationId &&
    responseInstallationId !==
      iid
  ) {
    const queues =
      await updateFailureState({
        pool,

        restaurantId:
          rid,

        installationId:
          iid,

        existingState,

        error:
          "Cloud pull installation mismatch",
      });

    return {
      success:
        false,

      received:
        0,

      duplicates:
        0,

      acked:
        0,

      rejected:
        pullBody.events.length,

      pending:
        queues.inbox,

      error:
        "EDGE_PULL_INSTALLATION_MISMATCH",
    };
  }

  let receivedCount =
    0;

  let duplicateCount =
    0;

  let rejectedCount =
    0;

  const ackIds =
    [];

  for (
    const event of
      pullBody.events
  ) {
    const eventId =
      String(
        event
          ?.event_id ||
        ""
      ).trim();

    try {
      requireUuid(
        eventId,
        "event_id"
      );

      if (
        Number(
          event
            ?.restaurant_id
        ) !== rid
      ) {
        throw new EdgePullError(
          "EDGE_PULL_EVENT_TENANT_MISMATCH",
          "Cloud event restaurant does not match authenticated tenant"
        );
      }

      const suppliedHash =
        String(
          event
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
        throw new EdgePullError(
          "EDGE_PULL_HASH_INVALID",
          "Cloud event payload_hash is invalid"
        );
      }

      const calculatedHash =
        hashJson(
          event?.payload
        );

      if (
        suppliedHash !==
        calculatedHash
      ) {
        throw new EdgePullError(
          "EDGE_PULL_HASH_MISMATCH",
          "Cloud event payload does not match payload_hash"
        );
      }

      const stored =
        await receiveInboxEvent({
          eventId,

          restaurantId:
            rid,

          source:
            "cloud",

          sourceInstallationId:
            null,

          eventType:
            event
              ?.event_type,

          entityType:
            event
              ?.entity_type ??
            null,

          entityId:
            event
              ?.entity_id ??
            null,

          payload:
            event
              ?.payload,

          pool,
        });

      receivedCount +=
        1;

      if (
        stored?.duplicate ===
        true
      ) {
        duplicateCount +=
          1;
      }

      /*
       * ACK only after the event is durably present
       * in local PostgreSQL.
       */
      ackIds.push(
        eventId
      );
    } catch (error) {
      rejectedCount +=
        1;

      console.error(
        "❌ MAKS Edge rejected Cloud event",
        {
          event_id:
            eventId ||
            null,

          code:
            error?.code ||
            "EDGE_PULL_EVENT_INVALID",

          error:
            String(
              error?.message ||
              error
            ).slice(
              0,
              500
            ),
        }
      );
    }
  }

  let ackedCount =
    0;

  let ackFailure =
    null;

  if (
    ackIds.length
  ) {
    try {
      const ackResult =
        await postJson({
          url:
            `${baseUrl}/edge/sync/pull/ack`,

          installationId:
            iid,

          edgeSecret:
            secret,

          body: {
            event_ids:
              ackIds,
          },

          timeoutMs:
            safeTimeout,

          fetchImpl,
        });

      if (
        !ackResult.response.ok ||
        ackResult.payload
          ?.success !==
          true ||
        !Array.isArray(
          ackResult.payload
            ?.acked
        )
      ) {
        throw new EdgePullError(
          ackResult.payload
            ?.code ||
          "EDGE_PULL_ACK_REJECTED",

          ackResult.payload
            ?.error ||
          `Cloud pull ACK rejected with HTTP ${ackResult.response.status}`
        );
      }

      const expected =
        new Set(
          ackIds
        );

      const acknowledged =
        new Set(
          ackResult.payload
            .acked
            .map(
              (item) =>
                String(
                  item
                    ?.event_id ||
                  ""
                )
            )
            .filter(
              (id) =>
                expected.has(
                  id
                )
            )
        );

      ackedCount =
        acknowledged.size;

      if (
        ackedCount !==
        ackIds.length
      ) {
        throw new EdgePullError(
          "EDGE_PULL_ACK_INCOMPLETE",
          "Cloud did not acknowledge every durably received event"
        );
      }
    } catch (error) {
      ackFailure =
        error;
    }
  }

  const queues =
    await countLocalQueues(
      pool,
      rid
    );

  const success =
    rejectedCount ===
      0 &&
    ackFailure ===
      null;

  await updateSyncState({
    restaurantId:
      rid,

    installationId:
      iid,

    patch: {
      syncStatus:
        success
          ? (
              (
                queues.outbox +
                queues.inbox
              ) > 0
                ? "pending"
                : "synced"
            )
          : "error",

      pendingOutboxEvents:
        queues.outbox,

      pendingInboxEvents:
        queues.inbox,

      consecutiveFailures:
        success
          ? 0
          : (
              Number(
                existingState
                  ?.consecutive_failures ||
                0
              ) + 1
            ),

      lastPullAt:
        new Date(),

      lastSuccessAt:
        success
          ? new Date()
          : (
              existingState
                ?.last_success_at ||
              null
            ),

      lastError:
        success
          ? null
          : String(
              ackFailure
                ?.message ||
              "One or more Cloud events were rejected"
            ).slice(
              0,
              2000
            ),
    },

    pool,
  });

  return {
    success,

    received:
      receivedCount,

    duplicates:
      duplicateCount,

    acked:
      ackedCount,

    rejected:
      rejectedCount,

    pending:
      queues.inbox,

    error:
      success
        ? null
        : (
            ackFailure?.code ||
            "EDGE_PULL_FAILED"
          ),
  };
}


module.exports = {
  EdgePullError,
  pullFromCloudOnce,
};
