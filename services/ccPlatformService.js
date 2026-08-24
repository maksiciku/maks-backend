"use strict";

/*
=========================================================
MAKS CC PLATFORM SERVICE

Shared platform inspection and repair logic.

This file must not use Express req/res directly.
Every function receives a database-compatible object
containing qGet, qAll and qRun.
=========================================================
*/

const TENANT_TABLES = Object.freeze([
  "categories",
  "meals",
  "orders",
  "pos_orders",
  "stock",
  "suppliers",
  "tables",
  "payments",
  "restaurant_members",
]);

async function countMissingTenant(db, tableName) {
  if (!TENANT_TABLES.includes(tableName)) {
    throw new Error(
      `Unsupported tenant table: ${tableName}`
    );
  }

  const row = await db.qGet(
    `
    SELECT COUNT(*)::int AS c
    FROM public.${tableName}
    WHERE restaurant_id IS NULL
    `,
    []
  );

  return Number(row?.c || 0);
}

async function countOrphanTenant(db, tableName) {
  if (!TENANT_TABLES.includes(tableName)) {
    throw new Error(
      `Unsupported tenant table: ${tableName}`
    );
  }

  const row = await db.qGet(
    `
    SELECT COUNT(*)::int AS c
    FROM public.${tableName} t
    LEFT JOIN public.restaurants r
      ON r.id = t.restaurant_id
    WHERE t.restaurant_id IS NOT NULL
      AND r.id IS NULL
    `,
    []
  );

  return Number(row?.c || 0);
}

async function buildTenantIntegritySnapshot(db) {
  if (!db?.qGet) {
    throw new Error(
      "buildTenantIntegritySnapshot requires qGet"
    );
  }

  const tableChecks = [];

  for (const tableName of TENANT_TABLES) {
    const [
      missingTenant,
      orphanTenant,
    ] = await Promise.all([
      countMissingTenant(db, tableName),
      countOrphanTenant(db, tableName),
    ]);

    tableChecks.push({
      table: tableName,
      missing_tenant: missingTenant,
      orphan_tenant: orphanTenant,
      ok:
        missingTenant === 0 &&
        orphanTenant === 0,
    });
  }

  const [
    usersBadRestaurant,
    membershipMismatch,
    restaurantsWithoutOwnerOrAdmin,
  ] = await Promise.all([
    db.qGet(
      `
      SELECT COUNT(*)::int AS c
      FROM public.users u
      LEFT JOIN public.restaurants r
        ON r.id = u.restaurant_id
      WHERE u.restaurant_id IS NOT NULL
        AND r.id IS NULL
      `,
      []
    ),

    db.qGet(
      `
      SELECT COUNT(*)::int AS c
      FROM public.restaurant_members rm
      JOIN public.users u
        ON u.id = rm.user_id
      WHERE u.restaurant_id IS NOT NULL
        AND u.restaurant_id <> rm.restaurant_id
      `,
      []
    ),

    db.qGet(
      `
      SELECT COUNT(*)::int AS c
      FROM public.restaurants r
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.restaurant_members rm
        JOIN public.users u
          ON u.id = rm.user_id
        WHERE rm.restaurant_id = r.id
          AND rm.is_active = TRUE
          AND u.is_active = TRUE
          AND rm.role IN ('owner', 'admin')
      )
      `,
      []
    ),
  ]);

  const usersBadRestaurantCount = Number(
    usersBadRestaurant?.c || 0
  );

  const membershipMismatchCount = Number(
    membershipMismatch?.c || 0
  );

  const restaurantsWithoutOwnerCount = Number(
    restaurantsWithoutOwnerOrAdmin?.c || 0
  );

  const problemGroups =
    tableChecks.filter((row) => !row.ok).length +
    (usersBadRestaurantCount > 0 ? 1 : 0) +
    (membershipMismatchCount > 0 ? 1 : 0) +
    (restaurantsWithoutOwnerCount > 0 ? 1 : 0);

  return {
    summary: {
      ok: problemGroups === 0,
      problem_groups: problemGroups,
    },

    checks: {
      table_checks: tableChecks,

      users_bad_restaurant_fk:
        usersBadRestaurantCount,

      membership_restaurant_mismatch:
        membershipMismatchCount,

      restaurants_without_owner_or_admin:
        restaurantsWithoutOwnerCount,
    },
  };
}

function clampScore(value) {
  return Math.max(
    0,
    Math.min(100, Math.round(Number(value || 0)))
  );
}

function scoreTone(score) {
  const value = clampScore(score);

  if (value < 60) return "critical";
  if (value < 85) return "warning";

  return "healthy";
}

function weightedAverage(entries) {
  const validEntries = entries.filter(
    (entry) =>
      Number.isFinite(Number(entry?.score)) &&
      Number(entry?.weight) > 0
  );

  const totalWeight = validEntries.reduce(
    (sum, entry) => sum + Number(entry.weight),
    0
  );

  if (totalWeight <= 0) return 0;

  const weightedTotal = validEntries.reduce(
    (sum, entry) =>
      sum +
      Number(entry.score) *
        Number(entry.weight),
    0
  );

  return clampScore(
    weightedTotal / totalWeight
  );
}

async function buildMissionControlSnapshot(db) {
  if (!db?.qGet || !db?.qAll) {
    throw new Error(
      "buildMissionControlSnapshot requires qGet and qAll"
    );
  }

  const scanStartedAt = Date.now();
  const dbStartedAt = Date.now();

  const dbPing = await db.qGet(
    `
    SELECT NOW() AS now_ts
    `,
    []
  );

  const databaseLatencyMs =
    Date.now() - dbStartedAt;

  const tenant =
    await buildTenantIntegritySnapshot(db);

  const [
    restaurantSummary,
    deviceSummary,
    securitySummary,
    auditSummary,
    recentAuditRows,
    deviceOverLimitRow,
  ] = await Promise.all([
    db.qGet(
      `
      SELECT
        COUNT(*)::int AS total,

        COUNT(*) FILTER (
          WHERE account_status = 'active'
        )::int AS active,

        COUNT(*) FILTER (
          WHERE account_status = 'suspended'
        )::int AS suspended,

        COUNT(*) FILTER (
          WHERE account_status = 'banned'
        )::int AS banned,

        COUNT(*) FILTER (
          WHERE account_status = 'archived'
        )::int AS archived,

        COUNT(*) FILTER (
          WHERE billing_status = 'overdue'
        )::int AS billing_overdue

      FROM public.restaurants
      `,
      []
    ),

    db.qGet(
      `
      SELECT
        COUNT(*)::int AS total,

        COUNT(*) FILTER (
          WHERE is_active = TRUE
        )::int AS active,

        COUNT(*) FILTER (
          WHERE is_active = FALSE
        )::int AS disabled,

        COUNT(*) FILTER (
          WHERE is_active = TRUE
            AND last_seen_at >=
              NOW() - INTERVAL '5 minutes'
        )::int AS online,

        COUNT(*) FILTER (
          WHERE is_active = TRUE
            AND (
              last_seen_at IS NULL
              OR last_seen_at <
                NOW() - INTERVAL '5 minutes'
            )
        )::int AS offline,

        COUNT(*) FILTER (
          WHERE is_active = TRUE
            AND last_seen_at IS NULL
        )::int AS never_seen

      FROM public.restaurant_devices
      `,
      []
    ),

    db.qGet(
      `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM public.platform_admin_login_events
          WHERE success = FALSE
            AND created_at >=
              NOW() - INTERVAL '24 hours'
        ) AS failed_logins_24h,

        (
          SELECT COUNT(*)::int
          FROM public.platform_admin_login_events
          WHERE success = TRUE
            AND created_at >=
              NOW() - INTERVAL '24 hours'
        ) AS successful_logins_24h,

        (
          SELECT COUNT(*)::int
          FROM public.platform_admin_users
          WHERE is_active = TRUE
            AND locked_until IS NOT NULL
            AND locked_until > NOW()
        ) AS locked_accounts,

        (
          SELECT COUNT(*)::int
          FROM public.platform_admin_users
          WHERE is_active = TRUE
        ) AS active_admin_accounts
      `,
      []
    ),

    db.qGet(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE created_at >=
            NOW() - INTERVAL '24 hours'
        )::int AS actions_24h,

        COUNT(*) FILTER (
          WHERE created_at >=
            NOW() - INTERVAL '1 hour'
        )::int AS actions_1h

      FROM public.platform_admin_audit
      `,
      []
    ),

    db.qAll(
      `
      SELECT
        paa.id,
        paa.action,
        paa.target_restaurant_id,
        paa.entity,
        paa.entity_id,
        paa.meta,
        paa.created_at,

        pau.email AS admin_email,
        pau.full_name AS admin_full_name,
        pau.role AS admin_role,

        r.name AS restaurant_name

      FROM public.platform_admin_audit paa

      JOIN public.platform_admin_users pau
        ON pau.id = paa.admin_user_id

      LEFT JOIN public.restaurants r
        ON r.id = paa.target_restaurant_id

      ORDER BY
        paa.created_at DESC,
        paa.id DESC

      LIMIT 20
      `,
      []
    ),

    db.qGet(
      `
      WITH device_counts AS (
        SELECT
          restaurant_id,

          COUNT(*) FILTER (
            WHERE is_active = TRUE
          ) AS device_count

        FROM public.restaurant_devices

        GROUP BY restaurant_id
      )

      SELECT COUNT(*)::int AS c

      FROM public.restaurants r

      LEFT JOIN device_counts dc
        ON dc.restaurant_id = r.id

      WHERE COALESCE(r.device_limit, 0) > 0
        AND COALESCE(dc.device_count, 0) >
            r.device_limit
      `,
      []
    ),
  ]);

  const restaurants = {
    total: Number(
      restaurantSummary?.total || 0
    ),

    active: Number(
      restaurantSummary?.active || 0
    ),

    suspended: Number(
      restaurantSummary?.suspended || 0
    ),

    banned: Number(
      restaurantSummary?.banned || 0
    ),

    archived: Number(
      restaurantSummary?.archived || 0
    ),

    billing_overdue: Number(
      restaurantSummary?.billing_overdue || 0
    ),

    device_over_limit: Number(
      deviceOverLimitRow?.c || 0
    ),
  };

  const devices = {
    total: Number(
      deviceSummary?.total || 0
    ),

    active: Number(
      deviceSummary?.active || 0
    ),

    disabled: Number(
      deviceSummary?.disabled || 0
    ),

    online: Number(
      deviceSummary?.online || 0
    ),

    offline: Number(
      deviceSummary?.offline || 0
    ),

    never_seen: Number(
      deviceSummary?.never_seen || 0
    ),

    heartbeat_threshold_seconds: 300,
  };

  const security = {
    failed_logins_24h: Number(
      securitySummary?.failed_logins_24h || 0
    ),

    successful_logins_24h: Number(
      securitySummary?.successful_logins_24h || 0
    ),

    locked_accounts: Number(
      securitySummary?.locked_accounts || 0
    ),

    active_admin_accounts: Number(
      securitySummary?.active_admin_accounts || 0
    ),
  };

  const audit = {
    actions_24h: Number(
      auditSummary?.actions_24h || 0
    ),

    actions_1h: Number(
      auditSummary?.actions_1h || 0
    ),

    recent: (recentAuditRows || []).map(
      (row) => ({
        id: Number(row.id),

        action:
          row.action || "",

        target_restaurant_id:
          row.target_restaurant_id != null
            ? Number(
                row.target_restaurant_id
              )
            : null,

        restaurant_name:
          row.restaurant_name ||
          row.meta?.restaurant_name ||
          "",

        entity:
          row.entity || "",

        entity_id:
          row.entity_id || "",

        meta:
          row.meta || {},

        created_at:
          row.created_at,

        admin: {
          email:
            row.admin_email || "",

          full_name:
            row.admin_full_name || "",

          role:
            row.admin_role || "",
        },
      })
    ),
  };

  const alerts = [];

  if (!tenant.summary.ok) {
    alerts.push({
      id: "tenant-integrity",
      level: "critical",
      category: "tenant",

      title:
        "Tenant integrity problems detected",

      message: `${Number(
        tenant.summary.problem_groups || 0
      )} structural problem group(s) require review.`,

      action: {
        type: "navigate",
        label: "Open tenant integrity",
        path: "/cc/tenant-integrity",
      },
    });
  }

  if (devices.offline > 0) {
    alerts.push({
      id: "offline-devices",
      level: "warning",
      category: "devices",

      title:
        "Active devices are offline",

      message: `${devices.offline} active device(s) have not sent a heartbeat within five minutes.`,

      action: {
        type: "navigate",
        label: "Open devices",
        path: "/cc/devices",
      },
    });
  }

  if (restaurants.device_over_limit > 0) {
    alerts.push({
      id: "device-limits",
      level: "warning",
      category: "restaurants",

      title:
        "Device limits exceeded",

      message: `${restaurants.device_over_limit} restaurant(s) exceed their configured device limit.`,

      action: {
        type: "navigate",
        label: "Open restaurants",
        path: "/cc/customers",
      },
    });
  }

  if (security.locked_accounts > 0) {
    alerts.push({
      id: "locked-cc-accounts",
      level: "critical",
      category: "security",

      title:
        "CC administrator locked",

      message: `${security.locked_accounts} active administrator account(s) are temporarily locked.`,

      action: {
        type: "navigate",
        label: "Open security",
        path: "/cc/security",
      },
    });
  }

  if (security.failed_logins_24h >= 3) {
    alerts.push({
      id: "failed-cc-logins",

      level:
        security.failed_logins_24h >= 10
          ? "critical"
          : "warning",

      category: "security",

      title:
        "Failed CC login attempts",

      message: `${security.failed_logins_24h} failed CC login attempt(s) were recorded in the last 24 hours.`,

      action: {
        type: "navigate",
        label: "Open security",
        path: "/cc/security",
      },
    });
  }

  if (databaseLatencyMs >= 500) {
    alerts.push({
      id: "database-latency",
      level: "critical",
      category: "database",

      title:
        "PostgreSQL latency is high",

      message:
        `The database health check took ${databaseLatencyMs} ms.`,

      action: {
        type: "navigate",
        label: "Open platform health",
        path: "/cc/health",
      },
    });
  } else if (databaseLatencyMs >= 150) {
    alerts.push({
      id: "database-latency",
      level: "warning",
      category: "database",

      title:
        "PostgreSQL is responding slowly",

      message:
        `The database health check took ${databaseLatencyMs} ms.`,

      action: {
        type: "navigate",
        label: "Open platform health",
        path: "/cc/health",
      },
    });
  }

  const tenantFailedTables =
  tenant.checks.table_checks.filter(
    (check) => check.ok === false
  ).length;

const tenantCheckTotal =
  tenant.checks.table_checks.length + 3;

const tenantFailureCount =
  tenantFailedTables +
  (
    Number(
      tenant.checks.users_bad_restaurant_fk || 0
    ) > 0
      ? 1
      : 0
  ) +
  (
    Number(
      tenant.checks
        .membership_restaurant_mismatch || 0
    ) > 0
      ? 1
      : 0
  ) +
  (
    Number(
      tenant.checks
        .restaurants_without_owner_or_admin || 0
    ) > 0
      ? 1
      : 0
  );

const tenantScore = clampScore(
  tenantCheckTotal > 0
    ? 100 -
        (
          tenantFailureCount /
          tenantCheckTotal
        ) *
          100
    : 100
);

const activeDeviceCount = Number(
  devices.active || 0
);

const deviceScore = clampScore(
  activeDeviceCount > 0
    ? (
        Number(devices.online || 0) /
        activeDeviceCount
      ) * 100
    : 100
);

const lockedAccountPenalty =
  Number(security.locked_accounts || 0) * 35;

const failedLoginPenalty = Math.min(
  35,
  Number(security.failed_logins_24h || 0) * 3
);

const securityScore = clampScore(
  100 -
    lockedAccountPenalty -
    failedLoginPenalty
);

const databaseScore = clampScore(
  databaseLatencyMs >= 1000
    ? 20
    : databaseLatencyMs >= 500
      ? 45
      : databaseLatencyMs >= 250
        ? 70
        : databaseLatencyMs >= 150
          ? 84
          : databaseLatencyMs >= 75
            ? 94
            : 100
);

const restaurantStructuralProblems =
  Number(restaurants.device_over_limit || 0) +
  Number(
    tenant.checks
      .restaurants_without_owner_or_admin || 0
  );

const restaurantScore = clampScore(
  Number(restaurants.total || 0) > 0
    ? 100 -
        (
          restaurantStructuralProblems /
          Number(restaurants.total)
        ) *
          100
    : 100
);

const backendScore = 100;

const scoreModules = {
  backend: {
    key: "backend",
    label: "Backend API",
    score: backendScore,
    tone: scoreTone(backendScore),
    path: "/cc/health",
    summary: "Node process is responding.",
  },

  database: {
    key: "database",
    label: "PostgreSQL",
    score: databaseScore,
    tone: scoreTone(databaseScore),
    path: "/cc/health",
    summary: `${databaseLatencyMs} ms database latency.`,
  },

  tenant: {
    key: "tenant",
    label: "Tenant integrity",
    score: tenantScore,
    tone: scoreTone(tenantScore),
    path: "/cc/tenant-integrity",
    summary: `${Number(
      tenant.summary.problem_groups || 0
    )} structural problem group(s).`,
  },

  devices: {
    key: "devices",
    label: "Device connectivity",
    score: deviceScore,
    tone: scoreTone(deviceScore),
    path: "/cc/devices",
    summary: `${Number(
      devices.online || 0
    )} online, ${Number(
      devices.offline || 0
    )} offline.`,
  },

  security: {
    key: "security",
    label: "CC security",
    score: securityScore,
    tone: scoreTone(securityScore),
    path: "/cc/security",
    summary: `${Number(
      security.failed_logins_24h || 0
    )} failed login(s), ${Number(
      security.locked_accounts || 0
    )} locked account(s).`,
  },

  restaurants: {
    key: "restaurants",
    label: "Restaurant structure",
    score: restaurantScore,
    tone: scoreTone(restaurantScore),
    path: "/cc/customers",
    summary: `${restaurantStructuralProblems} structural problem(s).`,
  },
};

const overallScore = weightedAverage([
  {
    score: backendScore,
    weight: 15,
  },
  {
    score: databaseScore,
    weight: 20,
  },
  {
    score: tenantScore,
    weight: 25,
  },
  {
    score: deviceScore,
    weight: 15,
  },
  {
    score: securityScore,
    weight: 15,
  },
  {
    score: restaurantScore,
    weight: 10,
  },
]);

const scores = {
  overall: {
    score: overallScore,
    tone: scoreTone(overallScore),
    label:
      overallScore >= 85
        ? "Platform operating well"
        : overallScore >= 60
          ? "Platform needs attention"
          : "Platform health is critical",
  },

  modules: scoreModules,

  methodology: {
    version: 1,
    description:
      "Weighted live score based on backend, database, tenant integrity, device connectivity, CC security and restaurant structure.",
  },
};

  const criticalCount = alerts.filter(
    (alert) =>
      alert.level === "critical"
  ).length;

  const warningCount = alerts.filter(
    (alert) =>
      alert.level === "warning"
  ).length;

  const overallStatus =
    criticalCount > 0
      ? "critical"
      : warningCount > 0
        ? "warning"
        : "healthy";

  const memory = process.memoryUsage();

  return {
    success: true,

    generated_at:
      dbPing?.now_ts ||
      new Date().toISOString(),

    scan_duration_ms:
      Date.now() - scanStartedAt,

    status: {
      overall: overallStatus,
      critical: criticalCount,
      warnings: warningCount,
      alerts_total: alerts.length,
    },

    alerts,

    system: {
      backend: {
        status: "online",

        node_uptime_seconds:
          Math.round(process.uptime()),

        rss_mb: Number(
          (
            memory.rss /
            1024 /
            1024
          ).toFixed(2)
        ),

        heap_used_mb: Number(
          (
            memory.heapUsed /
            1024 /
            1024
          ).toFixed(2)
        ),

        heap_total_mb: Number(
          (
            memory.heapTotal /
            1024 /
            1024
          ).toFixed(2)
        ),
      },

      database: {
        status: "connected",
        latency_ms: databaseLatencyMs,
      },
    },

    restaurants,
    devices,
    security,
    tenant,
    audit,
scores,
    capabilities: {
      tenant_scan: true,
      orphan_user_inspection: true,
      orphan_user_quarantine: true,

      manual_health_scan: true,

      device_remote_restart: false,
      server_remote_restart: false,
      database_remote_restart: false,

      automatic_tenant_repair_all: false,
      backup_monitoring: false,
      job_queue_monitoring: false,
    },
  };
}

async function inspectOrphanPayments(db) {
  if (!db?.qAll) {
    throw new Error(
      "inspectOrphanPayments requires qAll"
    );
  }

  const rows = await db.qAll(
    `
    SELECT
      p.id,
      p.table_number,
      p.amount,
      p.method,
      p.discount_value,
      p.discount_type,
      p.service_rate,
      p.created_at,
      p.restaurant_id,
      p.batch_id,
      p.staff_user_id,
      p.terminal_ref,
      p.pos_order_ids,
      p.source,
      p.status,
      p.refund_of_payment_id,
      p.ref_payment_id,
      p.settlement_id,

      staff.username AS staff_username,
      staff.full_name AS staff_full_name,
      staff.restaurant_id AS staff_restaurant_id,
      staff_restaurant.name AS staff_restaurant_name,

      settlement.restaurant_id
        AS settlement_restaurant_id,
      settlement_restaurant.name
        AS settlement_restaurant_name,

      reference_payment.restaurant_id
        AS reference_payment_restaurant_id,
      reference_restaurant.name
        AS reference_payment_restaurant_name,

      refund_payment.restaurant_id
        AS refund_payment_restaurant_id,
      refund_restaurant.name
        AS refund_payment_restaurant_name,

      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', po.id,
              'restaurant_id', po.restaurant_id,
              'restaurant_name', por.name,
              'table_number', po.table_number,
              'item_name', po.item_name,
              'total_price', po.total_price,
              'created_at', po.created_at
            )
            ORDER BY po.id
          )
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(p.pos_order_ids) = 'array'
                THEN p.pos_order_ids
              ELSE '[]'::jsonb
            END
          ) order_id(value)
          JOIN public.pos_orders po
            ON po.id = order_id.value::bigint
          LEFT JOIN public.restaurants por
            ON por.id = po.restaurant_id
          WHERE order_id.value ~ '^[0-9]+$'
        ),
        '[]'::jsonb
      ) AS linked_orders

    FROM public.payments p

    LEFT JOIN public.restaurants r
      ON r.id = p.restaurant_id

    LEFT JOIN public.users staff
      ON staff.id = p.staff_user_id

    LEFT JOIN public.restaurants staff_restaurant
      ON staff_restaurant.id = staff.restaurant_id

    LEFT JOIN public.payment_settlements settlement
      ON settlement.id = p.settlement_id

    LEFT JOIN public.restaurants settlement_restaurant
      ON settlement_restaurant.id =
         settlement.restaurant_id

    LEFT JOIN public.payments reference_payment
      ON reference_payment.id = p.ref_payment_id

    LEFT JOIN public.restaurants reference_restaurant
      ON reference_restaurant.id =
         reference_payment.restaurant_id

    LEFT JOIN public.payments refund_payment
      ON refund_payment.id =
         p.refund_of_payment_id

    LEFT JOIN public.restaurants refund_restaurant
      ON refund_restaurant.id =
         refund_payment.restaurant_id

    WHERE p.restaurant_id IS NOT NULL
      AND r.id IS NULL

    ORDER BY p.created_at ASC, p.id ASC
    `,
    []
  );

  const restaurants = await db.qAll(
    `
    SELECT
      id,
      name,
      account_status
    FROM public.restaurants
    WHERE account_status <> 'archived'
    ORDER BY name ASC, id ASC
    `,
    []
  );

  const mappedRows = (rows || []).map((row) => {
    const linkedOrders = Array.isArray(
      row.linked_orders
    )
      ? row.linked_orders
      : [];

    const evidence = [];

    for (const order of linkedOrders) {
      if (
        order?.restaurant_id != null &&
        order?.restaurant_name
      ) {
        evidence.push({
          source: "pos_order",
          source_id: Number(order.id),
          restaurant_id: Number(
            order.restaurant_id
          ),
          restaurant_name:
            order.restaurant_name,
        });
      }
    }

    if (
      row.staff_restaurant_id != null &&
      row.staff_restaurant_name
    ) {
      evidence.push({
        source: "staff_user",
        source_id:
          row.staff_user_id != null
            ? Number(row.staff_user_id)
            : null,
        restaurant_id: Number(
          row.staff_restaurant_id
        ),
        restaurant_name:
          row.staff_restaurant_name,
      });
    }

    if (
      row.settlement_restaurant_id != null &&
      row.settlement_restaurant_name
    ) {
      evidence.push({
        source: "settlement",
        source_id:
          row.settlement_id || null,
        restaurant_id: Number(
          row.settlement_restaurant_id
        ),
        restaurant_name:
          row.settlement_restaurant_name,
      });
    }

    if (
      row.reference_payment_restaurant_id != null &&
      row.reference_payment_restaurant_name
    ) {
      evidence.push({
        source: "reference_payment",
        source_id:
          row.ref_payment_id != null
            ? Number(row.ref_payment_id)
            : null,
        restaurant_id: Number(
          row.reference_payment_restaurant_id
        ),
        restaurant_name:
          row.reference_payment_restaurant_name,
      });
    }

    if (
      row.refund_payment_restaurant_id != null &&
      row.refund_payment_restaurant_name
    ) {
      evidence.push({
        source: "refund_payment",
        source_id:
          row.refund_of_payment_id != null
            ? Number(row.refund_of_payment_id)
            : null,
        restaurant_id: Number(
          row.refund_payment_restaurant_id
        ),
        restaurant_name:
          row.refund_payment_restaurant_name,
      });
    }

    const candidateIds = [
      ...new Set(
        evidence.map((item) =>
          Number(item.restaurant_id)
        )
      ),
    ];

    const suggestedRestaurantId =
      candidateIds.length === 1
        ? candidateIds[0]
        : null;

    const suggestedEvidence =
      suggestedRestaurantId != null
        ? evidence.filter(
            (item) =>
              Number(item.restaurant_id) ===
              suggestedRestaurantId
          )
        : [];

    return {
      id: Number(row.id),

      table_number:
        row.table_number || "",

      amount:
        Number(row.amount || 0),

      method:
        row.method || "",

      created_at:
        row.created_at,

      invalid_restaurant_id:
        Number(row.restaurant_id),

      batch_id:
        row.batch_id || null,

      staff_user_id:
        row.staff_user_id != null
          ? Number(row.staff_user_id)
          : null,

      staff_name:
        row.staff_full_name ||
        row.staff_username ||
        "",

      terminal_ref:
        row.terminal_ref || "",

      pos_order_ids:
        Array.isArray(row.pos_order_ids)
          ? row.pos_order_ids
          : [],

      source:
        row.source || "",

      status:
        row.status || "",

      settlement_id:
        row.settlement_id || null,

      linked_orders:
        linkedOrders,

      evidence,

      suggested_restaurant_id:
        suggestedRestaurantId,

      suggested_restaurant_name:
        suggestedEvidence[0]
          ?.restaurant_name || "",

      repair_confidence:
        candidateIds.length === 1
          ? evidence.length >= 2
            ? "high"
            : "medium"
          : candidateIds.length > 1
            ? "conflict"
            : "manual",

      explanation:
        candidateIds.length === 1
          ? `All valid evidence points to restaurant #${suggestedRestaurantId}.`
          : candidateIds.length > 1
            ? "The linked evidence points to different restaurants. Manual review is required."
            : "No valid linked restaurant was found. A restaurant must be selected manually.",
    };
  });

  return {
    success: true,
    total: mappedRows.length,
    rows: mappedRows,

    restaurants: (restaurants || []).map(
      (restaurant) => ({
        id: Number(restaurant.id),
        name: restaurant.name || "",
        account_status:
          restaurant.account_status || "",
      })
    ),
  };
}

async function repairOrphanPayment(
  tx,
  {
    paymentId,
    targetRestaurantId,
    adminUserId,
    reason,
  }
) {
  if (!tx?.qGet || !tx?.qRun) {
    throw new Error(
      "repairOrphanPayment requires an active transaction"
    );
  }

  const payment = await tx.qGet(
    `
    SELECT
      p.id,
      p.restaurant_id,
      p.table_number,
      p.amount,
      p.method,
      p.status,
      p.created_at,
      p.pos_order_ids,
      p.staff_user_id,
      p.settlement_id,
      r.id AS valid_current_restaurant_id
    FROM public.payments p
    LEFT JOIN public.restaurants r
      ON r.id = p.restaurant_id
    WHERE p.id = $1
    FOR UPDATE OF p
    `,
    [Number(paymentId)]
  );

  if (!payment?.id) {
    const error = new Error(
      "Payment was not found."
    );
    error.statusCode = 404;
    error.code = "CC_PAYMENT_NOT_FOUND";
    throw error;
  }

  if (payment.restaurant_id == null) {
    const error = new Error(
      "Payment has no restaurant link."
    );
    error.statusCode = 409;
    error.code =
      "CC_PAYMENT_ALREADY_DETACHED";
    throw error;
  }

  if (payment.valid_current_restaurant_id) {
    const error = new Error(
      "The payment restaurant link is already valid."
    );
    error.statusCode = 409;
    error.code =
      "CC_PAYMENT_LINK_ALREADY_VALID";
    throw error;
  }

  const targetRestaurant = await tx.qGet(
    `
    SELECT
      id,
      name,
      account_status
    FROM public.restaurants
    WHERE id = $1
    LIMIT 1
    `,
    [Number(targetRestaurantId)]
  );

  if (!targetRestaurant?.id) {
    const error = new Error(
      "The selected destination restaurant does not exist."
    );
    error.statusCode = 400;
    error.code =
      "CC_TARGET_RESTAURANT_NOT_FOUND";
    throw error;
  }

  const previousRestaurantId = Number(
    payment.restaurant_id
  );

  const repaired = await tx.qGet(
    `
    UPDATE public.payments
    SET restaurant_id = $1
    WHERE id = $2
      AND restaurant_id = $3
    RETURNING
      id,
      restaurant_id,
      table_number,
      amount,
      method,
      status,
      created_at
    `,
    [
      Number(targetRestaurant.id),
      Number(payment.id),
      previousRestaurantId,
    ]
  );

  if (!repaired?.id) {
    throw new Error(
      "Payment changed during repair. No update was applied."
    );
  }

  await tx.qRun(
    `
    INSERT INTO public.platform_admin_audit (
      admin_user_id,
      action,
      target_restaurant_id,
      entity,
      entity_id,
      meta,
      created_at
    )
    VALUES (
      $1,
      'CC_REASSIGN_ORPHAN_PAYMENT',
      $2,
      'payments',
      $3,
      $4::jsonb,
      NOW()
    )
    `,
    [
      Number(adminUserId),
      Number(targetRestaurant.id),
      String(payment.id),

      JSON.stringify({
        payment_id:
          Number(payment.id),

        previous_restaurant_id:
          previousRestaurantId,

        repaired_restaurant_id:
          Number(targetRestaurant.id),

        repaired_restaurant_name:
          targetRestaurant.name || null,

        table_number:
          payment.table_number || null,

        amount:
          Number(payment.amount || 0),

        method:
          payment.method || null,

        payment_status:
          payment.status || null,

        payment_created_at:
          payment.created_at || null,

        pos_order_ids:
          Array.isArray(payment.pos_order_ids)
            ? payment.pos_order_ids
            : [],

        staff_user_id:
          payment.staff_user_id != null
            ? Number(payment.staff_user_id)
            : null,

        settlement_id:
          payment.settlement_id || null,

        reason:
          String(reason || "").trim(),
      }),
    ]
  );

  return {
    id: Number(repaired.id),
    previous_restaurant_id:
      previousRestaurantId,
    restaurant_id: Number(
      repaired.restaurant_id
    ),
    restaurant_name:
      targetRestaurant.name || "",
    amount:
      Number(repaired.amount || 0),
    method:
      repaired.method || "",
    status:
      repaired.status || "",
  };
}

async function eraseOrphanTestPayment(
  tx,
  {
    paymentId,
    adminUserId,
    reason,
  }
) {
  if (!tx?.qGet || !tx?.qRun) {
    throw new Error(
      "eraseOrphanTestPayment requires an active transaction"
    );
  }

  const payment = await tx.qGet(
    `
    SELECT
      p.*,
      r.id AS valid_restaurant_id
    FROM public.payments p
    LEFT JOIN public.restaurants r
      ON r.id = p.restaurant_id
    WHERE p.id = $1
    FOR UPDATE OF p
    `,
    [Number(paymentId)]
  );

  if (!payment?.id) {
    const error = new Error("Payment was not found.");
    error.statusCode = 404;
    error.code = "CC_PAYMENT_NOT_FOUND";
    throw error;
  }

  if (payment.valid_restaurant_id) {
    const error = new Error(
      "Only payments linked to a missing restaurant can be erased here."
    );
    error.statusCode = 409;
    error.code = "CC_PAYMENT_RESTAURANT_VALID";
    throw error;
  }

  if (String(reason || "").trim().length < 10) {
    const error = new Error(
      "A clear erase reason of at least 10 characters is required."
    );
    error.statusCode = 400;
    error.code = "CC_ERASE_REASON_REQUIRED";
    throw error;
  }

  await tx.qRun(
    `
    INSERT INTO public.platform_admin_audit (
      admin_user_id,
      action,
      target_restaurant_id,
      entity,
      entity_id,
      meta,
      created_at
    )
    VALUES (
      $1,
      'CC_ERASE_ORPHAN_TEST_PAYMENT',
      NULL,
      'payments',
      $2,
      $3::jsonb,
      NOW()
    )
    `,
    [
      Number(adminUserId),
      String(payment.id),
      JSON.stringify({
        erased_payment: {
          id: Number(payment.id),
          table_number: payment.table_number || null,
          amount: Number(payment.amount || 0),
          method: payment.method || null,
          discount_value: Number(
            payment.discount_value || 0
          ),
          discount_type:
            payment.discount_type || null,
          service_rate: Number(
            payment.service_rate || 0
          ),
          created_at: payment.created_at || null,
          restaurant_id:
            payment.restaurant_id != null
              ? Number(payment.restaurant_id)
              : null,
          batch_id: payment.batch_id || null,
          staff_user_id:
            payment.staff_user_id != null
              ? Number(payment.staff_user_id)
              : null,
          terminal_ref:
            payment.terminal_ref || null,
          pos_order_ids:
            Array.isArray(payment.pos_order_ids)
              ? payment.pos_order_ids
              : [],
          source: payment.source || null,
          status: payment.status || null,
          void_reason: payment.void_reason || null,
          voided_at: payment.voided_at || null,
          voided_by_user_id:
            payment.voided_by_user_id != null
              ? Number(payment.voided_by_user_id)
              : null,
          refund_of_payment_id:
            payment.refund_of_payment_id != null
              ? Number(
                  payment.refund_of_payment_id
                )
              : null,
          cashup_session_id:
            payment.cashup_session_id || null,
          ref_payment_id:
            payment.ref_payment_id != null
              ? Number(payment.ref_payment_id)
              : null,
          settlement_id:
            payment.settlement_id || null,
        },
        reason: String(reason).trim(),
      }),
    ]
  );

  await tx.qRun(
    `
    DELETE FROM public.payments
    WHERE id = $1
      AND restaurant_id = $2
    `,
    [
      Number(payment.id),
      Number(payment.restaurant_id),
    ]
  );

  return {
    id: Number(payment.id),
    amount: Number(payment.amount || 0),
    method: payment.method || "",
  };
}

async function buildHealthSnapshot() {
  throw new Error(
    "buildHealthSnapshot is not connected yet"
  );
}

async function inspectMembershipMismatches(db) {
  if (!db?.qAll) {
    throw new Error(
      "inspectMembershipMismatches requires qAll"
    );
  }

  const rows = await db.qAll(
    `
    SELECT
      rm.id AS membership_id,
      rm.restaurant_id AS membership_restaurant_id,
      rm.user_id,
      rm.role AS membership_role,
      rm.status AS membership_status,
      rm.is_active AS membership_is_active,
      rm.permissions AS membership_permissions,
      rm.created_at AS membership_created_at,

      membership_restaurant.name
        AS membership_restaurant_name,

      u.username,
      u.full_name,
      u.role AS user_role,
      u.restaurant_id AS user_restaurant_id,
      u.is_active AS user_is_active,
      u.can_pos_login,
      u.created_at AS user_created_at,

      user_restaurant.name
        AS user_restaurant_name,

      (
        SELECT COUNT(*)::int
        FROM public.restaurant_members other_rm
        WHERE other_rm.user_id = rm.user_id
          AND other_rm.is_active = TRUE
      ) AS active_membership_count,

      EXISTS (
        SELECT 1
        FROM public.restaurant_members duplicate_rm
        WHERE duplicate_rm.user_id = rm.user_id
          AND duplicate_rm.restaurant_id =
              u.restaurant_id
          AND duplicate_rm.id <> rm.id
      ) AS user_restaurant_membership_exists

    FROM public.restaurant_members rm

    JOIN public.users u
      ON u.id = rm.user_id

    LEFT JOIN public.restaurants
      membership_restaurant
      ON membership_restaurant.id =
         rm.restaurant_id

    LEFT JOIN public.restaurants
      user_restaurant
      ON user_restaurant.id =
         u.restaurant_id

    WHERE u.restaurant_id IS NOT NULL
      AND u.restaurant_id <>
          rm.restaurant_id

    ORDER BY
      rm.user_id ASC,
      rm.id ASC
    `,
    []
  );

  return {
    success: true,
    total: rows.length,

    rows: (rows || []).map((row) => {
      const activeMembershipCount = Number(
        row.active_membership_count || 0
      );

      const userRestaurantExists =
        row.user_restaurant_id != null &&
        !!row.user_restaurant_name;

      const membershipRestaurantExists =
        row.membership_restaurant_id != null &&
        !!row.membership_restaurant_name;

      const duplicateMembershipExists =
        !!row.user_restaurant_membership_exists;

      let recommendedAction = "manual_review";
      let explanation =
        "Review both restaurant links before changing either record.";

      if (
        userRestaurantExists &&
        !membershipRestaurantExists
      ) {
        recommendedAction =
          "align_membership_to_user";

        explanation =
          "The user points to a valid restaurant but the membership restaurant does not exist.";
      } else if (
        !userRestaurantExists &&
        membershipRestaurantExists
      ) {
        recommendedAction =
          "align_user_to_membership";

        explanation =
          "The membership points to a valid restaurant but the user restaurant does not exist.";
      } else if (
        activeMembershipCount > 1
      ) {
        recommendedAction =
          "manual_review";

        explanation =
          "The user has multiple active memberships. Changing the primary restaurant requires manual review.";
      } else if (duplicateMembershipExists) {
        recommendedAction =
          "manual_review";

        explanation =
          "A membership already exists for the user’s current restaurant. Updating this row could create a duplicate.";
      }

      return {
        membership_id:
          Number(row.membership_id),

        user_id:
          Number(row.user_id),

        username:
          row.username || "",

        full_name:
          row.full_name || "",

        user_role:
          row.user_role || "",

        user_is_active:
          !!row.user_is_active,

        can_pos_login:
          !!row.can_pos_login,

        user_restaurant: {
          id:
            row.user_restaurant_id != null
              ? Number(
                  row.user_restaurant_id
                )
              : null,

          name:
            row.user_restaurant_name || "",

          exists:
            userRestaurantExists,
        },

        membership_restaurant: {
          id:
            row.membership_restaurant_id != null
              ? Number(
                  row.membership_restaurant_id
                )
              : null,

          name:
            row.membership_restaurant_name ||
            "",

          exists:
            membershipRestaurantExists,
        },

        membership: {
          role:
            row.membership_role || "",

          status:
            row.membership_status || "",

          is_active:
            !!row.membership_is_active,

          permissions:
            row.membership_permissions || {},

          created_at:
            row.membership_created_at ||
            null,
        },

        active_membership_count:
          activeMembershipCount,

        user_restaurant_membership_exists:
          duplicateMembershipExists,

        recommended_action:
          recommendedAction,

        explanation,
      };
    }),
  };
}

async function inspectRestaurantsWithoutOwner(db) {
  if (!db?.qAll) {
    throw new Error(
      "inspectRestaurantsWithoutOwner requires qAll"
    );
  }

  const rows = await db.qAll(
    `
    SELECT
      r.id AS restaurant_id,
      r.name AS restaurant_name,
      r.account_status,
      r.created_at,

      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'membership_id', rm.id,
              'user_id', u.id,
              'username', u.username,
              'full_name', u.full_name,
              'user_role', u.role,
              'membership_role', rm.role,
              'membership_status', rm.status,
              'membership_is_active', rm.is_active,
              'user_is_active', u.is_active,
              'can_pos_login', u.can_pos_login
            )
            ORDER BY
              CASE
                WHEN rm.role = 'owner' THEN 0
                WHEN rm.role = 'admin' THEN 1
                WHEN rm.role = 'manager' THEN 2
                ELSE 3
              END,
              u.id
          )
          FROM public.restaurant_members rm
          JOIN public.users u
            ON u.id = rm.user_id
          WHERE rm.restaurant_id = r.id
        ),
        '[]'::jsonb
      ) AS members,

      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'user_id', u.id,
              'username', u.username,
              'full_name', u.full_name,
              'role', u.role,
              'is_active', u.is_active,
              'can_pos_login', u.can_pos_login,
              'has_membership',
                EXISTS (
                  SELECT 1
                  FROM public.restaurant_members rm2
                  WHERE rm2.restaurant_id = r.id
                    AND rm2.user_id = u.id
                )
            )
            ORDER BY u.id
          )
          FROM public.users u
          WHERE u.restaurant_id = r.id
            AND u.is_active = TRUE
        ),
        '[]'::jsonb
      ) AS eligible_users

    FROM public.restaurants r

    WHERE NOT EXISTS (
      SELECT 1
      FROM public.restaurant_members rm
      JOIN public.users u
        ON u.id = rm.user_id
      WHERE rm.restaurant_id = r.id
        AND rm.is_active = TRUE
        AND u.is_active = TRUE
        AND LOWER(rm.role) IN (
          'owner',
          'admin'
        )
    )

    ORDER BY r.id ASC
    `,
    []
  );

  return {
    success: true,
    total: rows.length,

    rows: (rows || []).map((row) => {
      const members = Array.isArray(row.members)
        ? row.members
        : [];

      const eligibleUsers = Array.isArray(
        row.eligible_users
      )
        ? row.eligible_users
        : [];

      const activeMembershipCandidates =
        members.filter(
          (member) =>
            member.user_is_active === true &&
            member.membership_is_active === true
        );

      let recommendedUserId = null;
      let recommendedAction = "manual_review";
      let explanation =
        "Select an active user who should control this restaurant.";

      if (
        activeMembershipCandidates.length === 1
      ) {
        recommendedUserId = Number(
          activeMembershipCandidates[0].user_id
        );

        recommendedAction =
          "promote_existing_member";

        explanation =
          "This restaurant has one active member who can be promoted to owner or admin.";
      } else if (
        activeMembershipCandidates.length > 1
      ) {
        recommendedAction =
          "choose_existing_member";

        explanation =
          "Several active members are available. Choose the correct owner or administrator.";
      } else if (eligibleUsers.length === 1) {
        recommendedUserId = Number(
          eligibleUsers[0].user_id
        );

        recommendedAction =
          eligibleUsers[0].has_membership
            ? "reactivate_and_promote_member"
            : "create_owner_membership";

        explanation =
          "One active restaurant user is available but no active owner/admin membership exists.";
      } else if (eligibleUsers.length > 1) {
        recommendedAction =
          "choose_restaurant_user";

        explanation =
          "Several active users belong to this restaurant. Select the correct owner or administrator.";
      } else {
        recommendedAction =
          "no_candidate_available";

        explanation =
          "No active user is currently available for ownership. Create or reassign a user first.";
      }

      return {
        restaurant_id: Number(
          row.restaurant_id
        ),

        restaurant_name:
          row.restaurant_name || "",

        account_status:
          row.account_status || "",

        created_at:
          row.created_at || null,

        members,

        eligible_users: eligibleUsers,

        active_member_candidates:
          activeMembershipCandidates,

        recommended_user_id:
          recommendedUserId,

        recommended_action:
          recommendedAction,

        explanation,
      };
    }),
  };
}

async function runHealthScan() {
  throw new Error(
    "runHealthScan is not connected yet"
  );
}

module.exports = {
  buildTenantIntegritySnapshot,
  buildMissionControlSnapshot,
  inspectOrphanPayments,
  repairOrphanPayment,
  eraseOrphanTestPayment,
  inspectMembershipMismatches,
  inspectRestaurantsWithoutOwner,
  buildHealthSnapshot,
  runHealthScan,
};