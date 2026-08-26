"use strict";

const fs = require("fs");

const {
  Pool,
} = require("pg");

const {
  pushOutboxOnce,
} = require(
  "./pushTransport"
);


function intervalFromEnv(
  name,
  fallback,
  minimum
) {
  const raw =
    process.env[name];

  if (
    raw === undefined ||
    raw === null ||
    raw === ""
  ) {
    return fallback;
  }

  const value =
    Number(raw);

  if (
    !Number.isFinite(value)
  ) {
    return fallback;
  }

  return Math.max(
    minimum,
    Math.round(value)
  );
}


const VERSION =
  process.env.MAKS_EDGE_VERSION ||
  "edge-agent-0.2.0";


const CLOUD_URL =
  String(
    process.env
      .MAKS_EDGE_CLOUD_URL ||
    ""
  ).replace(
    /\/+$/,
    ""
  );


const INSTALLATION_ID =
  String(
    process.env
      .MAKS_EDGE_INSTALLATION_ID ||
    ""
  ).trim();


const EDGE_SECRET =
  String(
    process.env
      .MAKS_EDGE_SECRET ||
    ""
  ).trim();


const DATABASE_URL =
  String(
    process.env
      .MAKS_EDGE_DATABASE_URL ||
    ""
  ).trim();


const HEARTBEAT_MS =
  intervalFromEnv(
    "MAKS_EDGE_HEARTBEAT_MS",
    15000,
    5000
  );


const SYNC_MS =
  intervalFromEnv(
    "MAKS_EDGE_SYNC_MS",
    2000,
    1000
  );


const SYNC_BATCH_LIMIT =
  25;

const SYNC_LEASE_SECONDS =
  30;


if (!CLOUD_URL) {
  throw new Error(
    "MAKS_EDGE_CLOUD_URL is required"
  );
}


if (!INSTALLATION_ID) {
  throw new Error(
    "MAKS_EDGE_INSTALLATION_ID is required"
  );
}


if (!EDGE_SECRET) {
  throw new Error(
    "MAKS_EDGE_SECRET is required"
  );
}


if (!DATABASE_URL) {
  throw new Error(
    "MAKS_EDGE_DATABASE_URL is required"
  );
}


const pool =
  new Pool({
    connectionString:
      DATABASE_URL,

    max:
      3,

    idleTimeoutMillis:
      10000,

    connectionTimeoutMillis:
      3000,
  });


const SYNC_WORKER_ID =
  `edge-agent:` +
  `${INSTALLATION_ID.slice(
    0,
    8
  )}:` +
  `${process.pid}`;


let shuttingDown =
  false;

let heartbeatSending =
  false;

let syncSending =
  false;

let heartbeatTimer =
  null;

let syncTimer =
  null;

let previousCloudLatencyMs =
  null;

/*
 * This value is learned from a successful authenticated
 * Cloud heartbeat.
 *
 * The Edge agent does NOT trust a local/browser supplied
 * restaurant_id to choose tenant ownership.
 */
let authenticatedRestaurantId =
  null;


function nowIso() {
  return new Date()
    .toISOString();
}


function safeInteger(
  value
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.round(number)
  );
}


function positiveIntegerOrNull(
  value
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(
      number
    ) ||
    number <= 0
  ) {
    return null;
  }

  return number;
}


function isoOrNull(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}


async function getLocalDatabaseHealth() {
  const started =
    process.hrtime.bigint();

  try {
    const result =
      await pool.query(`
        SELECT
          current_database()
            AS database_name,

          NOW()
            AS database_time
      `);

    const ended =
      process.hrtime.bigint();

    const latencyMs =
      Number(
        ended -
        started
      ) /
      1_000_000;

    return {
      status:
        "healthy",

      latency_ms:
        safeInteger(
          latencyMs
        ),

      database_name:
        result
          ?.rows?.[0]
          ?.database_name ||
        null,

      error:
        null,
    };
  } catch (error) {
    return {
      status:
        "error",

      latency_ms:
        null,

      database_name:
        null,

      error:
        String(
          error?.message ||
          "Local PostgreSQL check failed"
        ).slice(
          0,
          500
        ),
    };
  }
}


async function getDiskFreeMb() {
  try {
    if (
      typeof fs.promises
        .statfs !==
      "function"
    ) {
      return null;
    }

    const stats =
      await fs.promises
        .statfs(
          process.cwd()
        );

    const blockSize =
      Number(
        stats.bsize ||
        0
      );

    const availableBlocks =
      Number(
        stats.bavail ||
        0
      );

    if (
      !Number.isFinite(
        blockSize
      ) ||
      !Number.isFinite(
        availableBlocks
      )
    ) {
      return null;
    }

    return safeInteger(
      (
        blockSize *
        availableBlocks
      ) /
      1024 /
      1024
    );
  } catch {
    return null;
  }
}


function emptySyncTelemetry() {
  return {
    status:
      "unknown",

    pending:
      0,

    last_sync_at:
      null,

    last_sync_error:
      null,
  };
}


async function getLocalSyncTelemetry() {
  if (
    !authenticatedRestaurantId
  ) {
    return emptySyncTelemetry();
  }

  try {
    const [
      stateResult,
      pendingResult,
    ] =
      await Promise.all([
        pool.query(
          `
          SELECT
            sync_status,
            last_success_at,
            last_error
          FROM
            public.edge_sync_state
          WHERE
            restaurant_id = $1
            AND
            installation_id =
              $2::uuid
          LIMIT 1
          `,
          [
            authenticatedRestaurantId,
            INSTALLATION_ID,
          ]
        ),

        pool.query(
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
            )
            +
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
            )
              AS pending
          `,
          [
            authenticatedRestaurantId,
          ]
        ),
      ]);

    const state =
      stateResult
        .rows?.[0] ||
      null;

    const pending =
      Math.max(
        0,
        Number(
          pendingResult
            .rows?.[0]
            ?.pending ||
          0
        )
      );

    let status =
      state?.sync_status ||
      (
        pending > 0
          ? "pending"
          : "synced"
      );

    /*
     * Actual durable queue state wins over a stale
     * "synced" marker.
     */
    if (
      status === "synced" &&
      pending > 0
    ) {
      status =
        "pending";
    }

    return {
      status,

      pending,

      last_sync_at:
        isoOrNull(
          state
            ?.last_success_at
        ),

      last_sync_error:
        state
          ?.last_error ||
        null,
    };
  } catch (error) {
    /*
     * The PostgreSQL health query already proved the
     * database itself is reachable. Failure here is
     * therefore a sync-subsystem problem.
     */
    return {
      status:
        "error",

      pending:
        0,

      last_sync_at:
        null,

      last_sync_error:
        String(
          error?.message ||
          "Local Edge sync state check failed"
        ).slice(
          0,
          500
        ),
    };
  }
}


async function hasDueOutboxWork() {
  if (
    !authenticatedRestaurantId
  ) {
    return false;
  }

  const result =
    await pool.query(
      `
      SELECT
        EXISTS (
          SELECT
            1
          FROM
            public.edge_outbox
          WHERE
            restaurant_id = $1
            AND
            (
              (
                status IN (
                  'pending',
                  'failed'
                )
                AND
                next_attempt_at <=
                  NOW()
              )
              OR
              (
                status =
                  'in_flight'
                AND
                locked_at IS NOT NULL
                AND
                locked_at <=
                  NOW()
                  -
                  (
                    $2::int *
                    INTERVAL '1 second'
                  )
              )
            )
          LIMIT 1
        ) AS has_work
      `,
      [
        authenticatedRestaurantId,
        SYNC_LEASE_SECONDS,
      ]
    );

  return (
    result
      .rows?.[0]
      ?.has_work ===
    true
  );
}


async function buildTelemetry() {
  const [
    database,
    diskFreeMb,
  ] =
    await Promise.all([
      getLocalDatabaseHealth(),
      getDiskFreeMb(),
    ]);

  /*
   * Keep DB-health failures separate from sync failures.
   */
  const sync =
    database.status ===
      "healthy"
      ? await getLocalSyncTelemetry()
      : emptySyncTelemetry();

  return {
    version:
      VERSION,

    local_db_status:
      database.status,

    local_db_latency_ms:
      database.latency_ms,

    cloud_latency_ms:
      previousCloudLatencyMs,

    sync_status:
      sync.status,

    pending_sync_events:
      sync.pending,

    last_sync_at:
      sync.last_sync_at,

    last_sync_error:
      sync.last_sync_error,

    /*
     * Report MAKS Edge process uptime,
     * not whole-machine uptime.
     */
    uptime_seconds:
      safeInteger(
        process.uptime()
      ),

    disk_free_mb:
      diskFreeMb,
  };
}


async function sendSyncCycle() {
  if (
    shuttingDown ||
    syncSending ||
    !authenticatedRestaurantId
  ) {
    return;
  }

  syncSending =
    true;

  try {
    const hasWork =
      await hasDueOutboxWork();

    /*
     * Do not write sync_state every two seconds while
     * idle. Only invoke the transport when durable work
     * is actually due.
     */
    if (!hasWork) {
      return;
    }

    const result =
      await pushOutboxOnce({
        pool,

        cloudUrl:
          CLOUD_URL,

        installationId:
          INSTALLATION_ID,

        edgeSecret:
          EDGE_SECRET,

        restaurantId:
          authenticatedRestaurantId,

        workerId:
          SYNC_WORKER_ID,

        limit:
          SYNC_BATCH_LIMIT,

        leaseSeconds:
          SYNC_LEASE_SECONDS,

        timeoutMs:
          10000,
      });

    if (
      result?.success ===
      true
    ) {
      if (
        Number(
          result.claimed ||
          0
        ) > 0
      ) {
        console.log(
          `[${nowIso()}] ✅ MAKS Edge sync push`,
          {
            claimed:
              Number(
                result.claimed ||
                0
              ),

            acked:
              Number(
                result.acked ||
                0
              ),

            rejected:
              Number(
                result.rejected ||
                0
              ),

            pending:
              Number(
                result.pending ||
                0
              ),
          }
        );
      }

      return;
    }

    console.error(
      `[${nowIso()}] ❌ MAKS Edge sync push failed`,
      {
        claimed:
          Number(
            result?.claimed ||
            0
          ),

        acked:
          Number(
            result?.acked ||
            0
          ),

        rejected:
          Number(
            result?.rejected ||
            0
          ),

        pending:
          Number(
            result?.pending ||
            0
          ),

        code:
          result?.error ||
          "EDGE_PUSH_FAILED",
      }
    );
  } catch (error) {
    console.error(
      `[${nowIso()}] ❌ MAKS Edge sync cycle failed`,
      {
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
  } finally {
    syncSending =
      false;
  }
}


async function sendHeartbeat() {
  if (
    shuttingDown ||
    heartbeatSending
  ) {
    return;
  }

  heartbeatSending =
    true;

  try {
    const telemetry =
      await buildTelemetry();

    const started =
      process.hrtime.bigint();

    const response =
      await fetch(
        `${CLOUD_URL}/edge/heartbeat`,
        {
          method:
            "POST",

          headers: {
            "content-type":
              "application/json",

            "x-edge-installation-id":
              INSTALLATION_ID,

            "x-edge-secret":
              EDGE_SECRET,
          },

          body:
            JSON.stringify(
              telemetry
            ),

          signal:
            AbortSignal.timeout(
              10000
            ),
        }
      );

    const ended =
      process.hrtime.bigint();

    previousCloudLatencyMs =
      safeInteger(
        Number(
          ended -
          started
        ) /
        1_000_000
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

    if (
      !response.ok ||
      payload?.success !==
        true
    ) {
      /*
       * Invalid/revoked credentials must stop this
       * process from attempting tenant sync.
       *
       * A normal network/server outage does NOT clear
       * the known restaurant.
       */
      if (
        response.status ===
          401 ||
        response.status ===
          403
      ) {
        authenticatedRestaurantId =
          null;
      }

      console.error(
        `[${nowIso()}] ❌ MAKS Edge heartbeat rejected`,
        {
          status:
            response.status,

          code:
            payload?.code ||
            "UNKNOWN",

          error:
            payload?.error ||
            "Heartbeat rejected",
        }
      );

      return;
    }

    const returnedInstallationId =
      String(
        payload
          ?.edge
          ?.installation_id ||
        ""
      ).trim();

    if (
      returnedInstallationId &&
      returnedInstallationId !==
        INSTALLATION_ID
    ) {
      authenticatedRestaurantId =
        null;

      console.error(
        `[${nowIso()}] ❌ MAKS Edge heartbeat identity mismatch`,
        {
          code:
            "EDGE_INSTALLATION_MISMATCH",
        }
      );

      return;
    }

    const returnedRestaurantId =
      positiveIntegerOrNull(
        payload
          ?.edge
          ?.restaurant_id
      );

    if (
      returnedRestaurantId
    ) {
      if (
        authenticatedRestaurantId &&
        authenticatedRestaurantId !==
          returnedRestaurantId
      ) {
        authenticatedRestaurantId =
          null;

        console.error(
          `[${nowIso()}] ❌ MAKS Edge tenant identity changed`,
          {
            code:
              "EDGE_TENANT_CHANGED",
          }
        );

        return;
      }

      const learnedTenant =
        !authenticatedRestaurantId;

      authenticatedRestaurantId =
        returnedRestaurantId;

      /*
       * Don't wait for the next sync interval after
       * first authenticated contact with Cloud.
       */
      if (
        learnedTenant &&
        !shuttingDown
      ) {
        setImmediate(
          () => {
            sendSyncCycle();
          }
        );
      }
    }

    console.log(
      `[${nowIso()}] ✅ MAKS Edge heartbeat`,
      {
        local_db:
          telemetry
            .local_db_status,

        local_db_latency_ms:
          telemetry
            .local_db_latency_ms,

        cloud_latency_ms:
          previousCloudLatencyMs,

        sync_status:
          telemetry
            .sync_status,

        pending_sync_events:
          telemetry
            .pending_sync_events,

        disk_free_mb:
          telemetry
            .disk_free_mb,

        next_heartbeat_seconds:
          Number(
            payload
              ?.heartbeat_interval_seconds ||
            HEARTBEAT_MS /
              1000
          ),
      }
    );
  } catch (error) {
    /*
     * Keep authenticatedRestaurantId on a transient
     * network outage so queued work can retry as soon
     * as Cloud returns.
     */
    console.error(
      `[${nowIso()}] ❌ MAKS Edge cloud connection failed`,
      {
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
  } finally {
    heartbeatSending =
      false;
  }
}


async function shutdown(
  signal
) {
  if (
    shuttingDown
  ) {
    return;
  }

  shuttingDown =
    true;

  console.log(
    `[${nowIso()}] 🛑 MAKS Edge shutting down (${signal})`
  );

  if (
    heartbeatTimer
  ) {
    clearInterval(
      heartbeatTimer
    );

    heartbeatTimer =
      null;
  }

  if (
    syncTimer
  ) {
    clearInterval(
      syncTimer
    );

    syncTimer =
      null;
  }

  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
}


process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);


process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);


process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      `[${nowIso()}] ❌ Unhandled Edge rejection`,
      error?.message ||
      error
    );
  }
);


console.log(
  "======================================"
);

console.log(
  "          MAKS EDGE AGENT"
);

console.log(
  "======================================"
);

console.log(
  `Version: ${VERSION}`
);

console.log(
  `Cloud: ${CLOUD_URL}`
);

console.log(
  `Installation: ${INSTALLATION_ID.slice(
    0,
    8
  )}…`
);

console.log(
  `Heartbeat: ${Math.round(
    HEARTBEAT_MS /
    1000
  )} seconds`
);

console.log(
  `Sync: ${Math.round(
    SYNC_MS /
    1000
  )} seconds`
);

console.log(
  "Secret: configured (hidden)"
);

console.log(
  "Local PostgreSQL: configured (URL hidden)"
);

console.log(
  ""
);


/*
 * First heartbeat learns the authoritative restaurant.
 * First sync attempt before that safely does nothing.
 */
sendHeartbeat();

sendSyncCycle();


heartbeatTimer =
  setInterval(
    sendHeartbeat,
    HEARTBEAT_MS
  );


syncTimer =
  setInterval(
    sendSyncCycle,
    SYNC_MS
  );
