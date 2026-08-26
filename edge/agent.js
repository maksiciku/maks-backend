"use strict";

const os = require("os");
const fs = require("fs");
const { Pool } = require("pg");

const VERSION =
  process.env.MAKS_EDGE_VERSION ||
  "edge-agent-0.1.0";

const CLOUD_URL = String(
  process.env.MAKS_EDGE_CLOUD_URL || ""
).replace(/\/+$/, "");

const INSTALLATION_ID = String(
  process.env.MAKS_EDGE_INSTALLATION_ID || ""
).trim();

const EDGE_SECRET = String(
  process.env.MAKS_EDGE_SECRET || ""
).trim();

const DATABASE_URL = String(
  process.env.MAKS_EDGE_DATABASE_URL || ""
).trim();

const HEARTBEAT_MS = Math.max(
  5000,
  Number(
    process.env.MAKS_EDGE_HEARTBEAT_MS ||
      15000
  )
);

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

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 3000,
});

let shuttingDown = false;
let sending = false;
let timer = null;
let previousCloudLatencyMs = null;

function nowIso() {
  return new Date().toISOString();
}

function safeInteger(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(
    0,
    Math.round(number)
  );
}

async function getLocalDatabaseHealth() {
  const started =
    process.hrtime.bigint();

  try {
    const result =
      await pool.query(`
        SELECT
          current_database() AS database_name,
          NOW() AS database_time
      `);

    const ended =
      process.hrtime.bigint();

    const latencyMs =
      Number(
        ended - started
      ) / 1_000_000;

    return {
      status: "healthy",
      latency_ms:
        safeInteger(latencyMs),
      database_name:
        result?.rows?.[0]
          ?.database_name || null,
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      latency_ms: null,
      database_name: null,
      error:
        String(
          error?.message ||
            "Local PostgreSQL check failed"
        ).slice(0, 500),
    };
  }
}

async function getDiskFreeMb() {
  try {
    if (
      typeof fs.promises.statfs !==
      "function"
    ) {
      return null;
    }

    const stats =
      await fs.promises.statfs(
        process.cwd()
      );

    const blockSize =
      Number(
        stats.bsize || 0
      );

    const availableBlocks =
      Number(
        stats.bavail || 0
      );

    if (
      !Number.isFinite(blockSize) ||
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

async function buildTelemetry() {
  const [
    database,
    diskFreeMb,
  ] = await Promise.all([
    getLocalDatabaseHealth(),
    getDiskFreeMb(),
  ]);

  return {
    version: VERSION,

    local_db_status:
      database.status,

    local_db_latency_ms:
      database.latency_ms,

    cloud_latency_ms:
      previousCloudLatencyMs,

    /*
     * Sync engine is NOT implemented yet.
     * Do not report a false "synced" state.
     */
    sync_status: "unknown",

    pending_sync_events: 0,

    last_sync_at: null,

    last_sync_error:
      database.error,

    uptime_seconds:
      safeInteger(
        os.uptime()
      ),

    disk_free_mb:
      diskFreeMb,
  };
}

async function sendHeartbeat() {
  if (
    shuttingDown ||
    sending
  ) {
    return;
  }

  sending = true;

  try {
    const telemetry =
      await buildTelemetry();

    const started =
      process.hrtime.bigint();

    const response =
      await fetch(
        `${CLOUD_URL}/edge/heartbeat`,
        {
          method: "POST",

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
          ended - started
        ) / 1_000_000
      );

    let payload = null;

    try {
      payload =
        await response.json();
    } catch {
      payload = null;
    }

    if (
      !response.ok ||
      payload?.success !== true
    ) {
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

    console.log(
      `[${nowIso()}] ✅ MAKS Edge heartbeat`,
      {
        local_db:
          telemetry.local_db_status,

        local_db_latency_ms:
          telemetry.local_db_latency_ms,

        cloud_latency_ms:
          previousCloudLatencyMs,

        disk_free_mb:
          telemetry.disk_free_mb,

        next_heartbeat_seconds:
          Number(
            payload
              ?.heartbeat_interval_seconds ||
              HEARTBEAT_MS / 1000
          ),
      }
    );
  } catch (error) {
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
    sending = false;
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `[${nowIso()}] 🛑 MAKS Edge shutting down (${signal})`
  );

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      `[${nowIso()}] ❌ Unhandled Edge rejection`,
      error?.message || error
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
    HEARTBEAT_MS / 1000
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

sendHeartbeat();

timer = setInterval(
  sendHeartbeat,
  HEARTBEAT_MS
);
