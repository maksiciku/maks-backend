"use strict";

const {
  EdgeSyncError,
  claimInboxEvents,
  applyClaimedInboxEvent,
  failInboxEvent,
  deadLetterInboxEvent,
} = require(
  "./syncStore"
);


class EdgeApplyError extends Error {
  constructor(
    code,
    message,
    details = null
  ) {
    super(message);

    this.name =
      "EdgeApplyError";

    this.code =
      code;

    if (details !== null) {
      this.details =
        details;
    }
  }
}


function requireHandlers(
  handlers
) {
  if (
    !handlers ||
    typeof handlers !==
      "object" ||
    Array.isArray(handlers)
  ) {
    throw new EdgeApplyError(
      "EDGE_APPLY_HANDLERS_INVALID",
      "MAKS Edge apply handlers must be an object"
    );
  }

  const normalized =
    Object.create(null);

  for (
    const [
      eventType,
      handler,
    ] of Object.entries(
      handlers
    )
  ) {
    const type =
      String(
        eventType || ""
      ).trim();

    if (!type) {
      throw new EdgeApplyError(
        "EDGE_APPLY_EVENT_TYPE_INVALID",
        "MAKS Edge apply handler event type is invalid"
      );
    }

    if (
      typeof handler !==
        "function"
    ) {
      throw new EdgeApplyError(
        "EDGE_APPLY_HANDLER_INVALID",
        `MAKS Edge apply handler is invalid for ${type}`
      );
    }

    normalized[type] =
      handler;
  }

  return normalized;
}


function boundedInteger(
  value,
  label,
  {
    min,
    max,
  }
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(
      number
    ) ||
    number < min ||
    number > max
  ) {
    throw new EdgeApplyError(
      "EDGE_APPLY_ARGUMENT_INVALID",
      `${label} is invalid`
    );
  }

  return number;
}


function safeErrorText(
  error
) {
  return String(
    error?.message ||
    error ||
    "MAKS Edge inbox application failed"
  ).slice(
    0,
    1800
  );
}


function retryDelaySeconds(
  attempts
) {
  return Math.min(
    300,
    Math.max(
      1,
      2 **
      Math.min(
        8,
        Math.max(
          0,
          Number(
            attempts ||
            1
          ) -
          1
        )
      )
    )
  );
}


async function applyInboxOnce({
  pool,

  restaurantId,

  workerId,

  handlers,

  limit = 10,

  leaseSeconds = 30,

  maxAttempts = 5,
}) {
  if (
    !pool ||
    typeof pool.connect !==
      "function"
  ) {
    throw new EdgeApplyError(
      "EDGE_APPLY_POOL_INVALID",
      "MAKS Edge apply engine requires an explicit local PostgreSQL pool"
    );
  }

  const safeLimit =
    boundedInteger(
      limit,
      "limit",
      {
        min: 1,
        max: 25,
      }
    );

  const safeLease =
    boundedInteger(
      leaseSeconds,
      "leaseSeconds",
      {
        min: 1,
        max: 3600,
      }
    );

  const safeMaxAttempts =
    boundedInteger(
      maxAttempts,
      "maxAttempts",
      {
        min: 1,
        max: 100,
      }
    );

  const registry =
    requireHandlers(
      handlers
    );

  const claimed =
    await claimInboxEvents({
      restaurantId,

      workerId,

      limit:
        safeLimit,

      leaseSeconds:
        safeLease,

      pool,
    });

  const result = {
    claimed:
      claimed.length,

    applied:
      0,

    failed:
      0,

    dead_lettered:
      0,
  };

  for (
    const event of claimed
  ) {
    const eventId =
      String(
        event?.event_id ||
        ""
      );

    const eventType =
      String(
        event?.event_type ||
        ""
      ).trim();

    if (
      event?.source !==
        "cloud"
    ) {
      await deadLetterInboxEvent({
        restaurantId,

        eventId,

        workerId,

        lastError:
          "EDGE_APPLY_SOURCE_REJECTED: only Cloud-origin inbox events may be applied by the Edge runtime",

        pool,
      });

      result.dead_lettered +=
        1;

      continue;
    }

    const handler =
      registry[eventType];

    if (!handler) {
      await deadLetterInboxEvent({
        restaurantId,

        eventId,

        workerId,

        lastError:
          `EDGE_APPLY_EVENT_UNSUPPORTED: unsupported Cloud to Edge event type ${eventType || "(missing)"}`,

        pool,
      });

      result.dead_lettered +=
        1;

      continue;
    }

    try {
      await applyClaimedInboxEvent({
        restaurantId,

        eventId,

        workerId,

        pool,

        execute:
          async ({
            tx,
            restaurantId:
              authoritativeRestaurantId,
            event:
              claimedEvent,
            payload,
          }) =>
            handler({
              tx,

              restaurantId:
                authoritativeRestaurantId,

              event:
                claimedEvent,

              payload,
            }),
      });

      result.applied +=
        1;
    } catch (error) {
      if (
        error instanceof
          EdgeSyncError &&
        error.code ===
          "EDGE_INBOX_NOT_OWNED"
      ) {
        throw error;
      }

      const attempts =
        Math.max(
          1,
          Number(
            event?.apply_attempts ||
            1
          )
        );

      const message =
        safeErrorText(
          error
        );

      if (
        attempts >=
        safeMaxAttempts
      ) {
        await deadLetterInboxEvent({
          restaurantId,

          eventId,

          workerId,

          lastError:
            `EDGE_APPLY_MAX_ATTEMPTS: ${message}`,

          pool,
        });

        result.dead_lettered +=
          1;

        continue;
      }

      await failInboxEvent({
        restaurantId,

        eventId,

        workerId,

        lastError:
          `EDGE_APPLY_HANDLER_FAILED: ${message}`,

        retryDelaySeconds:
          retryDelaySeconds(
            attempts
          ),

        pool,
      });

      result.failed +=
        1;
    }
  }

  return result;
}


module.exports = {
  EdgeApplyError,
  applyInboxOnce,
};
