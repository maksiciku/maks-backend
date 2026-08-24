"use strict";

/*
 * =====================================================
 * REAL WORLD MAKS
 * =====================================================
 *
 * LIVE PLATFORM INTEGRITY SCANNER.
 *
 * RULES:
 *
 * - SELECT queries only.
 * - No INSERT.
 * - No UPDATE.
 * - No DELETE.
 * - No test orders.
 * - No test payments.
 * - No customer mutations.
 * - Never treat maks_test as the real-world platform.
 *
 * Every PASS/FAIL comes from real database evidence.
 * =====================================================
 */

const MAX_EVIDENCE_ROWS = 25;

/*
 * =====================================================
 * HELPERS
 * =====================================================
 */

function number(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : 0;
}

function makeCheck({
  key,
  title,
  category,
  severity = "critical",
  count = 0,
  evidence = [],
  description = "",
  healthyMessage = "",
}) {
  const violations =
    number(count);

  return {
    key,
    title,
    category,
    severity,

    ok:
      violations === 0,

    violations,

    description,

    message:
      violations === 0
        ? healthyMessage ||
          "No integrity violations detected."
        : `${violations} integrity violation${
            violations === 1
              ? ""
              : "s"
          } detected.`,

    evidence:
      Array.isArray(evidence)
        ? evidence.slice(
            0,
            MAX_EVIDENCE_ROWS
          )
        : [],
  };
}

async function countQuery(
  db,
  sql,
  params = []
) {
  const row =
    await db.qGet(
      sql,
      params
    );

  return number(
    row?.count ??
    row?.c ??
    0
  );
}

async function evidenceQuery(
  db,
  sql,
  params = []
) {
  const rows =
    await db.qAll(
      sql,
      params
    );

  return Array.isArray(rows)
    ? rows.slice(
        0,
        MAX_EVIDENCE_ROWS
      )
    : [];
}

async function buildViolationCheck(
  db,
  {
    key,
    title,
    category,
    severity,
    description,
    healthyMessage,
    countSql,
    evidenceSql,
    params = [],
  }
) {
  const [
    count,
    evidence,
  ] =
    await Promise.all([
      countQuery(
        db,
        countSql,
        params
      ),

      evidenceSql
        ? evidenceQuery(
            db,
            evidenceSql,
            params
          )
        : Promise.resolve(
            []
          ),
    ]);

  return makeCheck({
    key,
    title,
    category,
    severity,
    count,
    evidence,
    description,
    healthyMessage,
  });
}

/*
 * =====================================================
 * ENVIRONMENT
 * =====================================================
 */

async function inspectEnvironment(
  db
) {
  const row =
    await db.qGet(
      `
      SELECT
        current_database()
          AS database_name,

        current_user
          AS database_user,

        NOW()
          AS database_time,

        current_setting(
          'transaction_read_only'
        )
          AS transaction_read_only
      `,
      []
    );

  const databaseName =
    String(
      row?.database_name ||
      ""
    );

  if (
    !databaseName
  ) {
    throw new Error(
      "Unable to identify live MAKS database."
    );
  }

  /*
   * Real World MAKS must never accidentally
   * present the isolated attack database as live.
   */
  if (
    databaseName ===
    "maks_test"
  ) {
    const err =
      new Error(
        "Real World MAKS refused to scan maks_test. That database belongs to Attack MAKS."
      );

    err.code =
      "REAL_WORLD_TEST_DB_REFUSED";

    err.statusCode =
      503;

    throw err;
  }

  return {
    database_name:
      databaseName,

    database_user:
      String(
        row?.database_user ||
        ""
      ),

    database_time:
      row?.database_time ||
      null,

    database_transaction_read_only:
      String(
        row?.transaction_read_only ||
        ""
      ) === "on",

    scanner_mode:
      "application_read_only",
  };
}

/*
 * =====================================================
 * 1. TENANT OWNERSHIP
 * =====================================================
 */

async function checkTenantOwnership(
  db
) {
  /*
   * Discover EVERY public table that contains
   * a restaurant_id column.
   *
   * This prevents Real World MAKS from missing
   * orphan tenant rows just because a table was
   * added later and forgotten here.
   */
  const discoveredTables =
    await db.qAll(
      `
      SELECT
        c.table_name,
        c.is_nullable

      FROM
        information_schema.columns c

      JOIN
        information_schema.tables t
        ON t.table_schema =
           c.table_schema
       AND t.table_name =
           c.table_name

      WHERE
        c.table_schema =
          'public'

        AND
        c.column_name =
          'restaurant_id'

        AND
        t.table_type =
          'BASE TABLE'

      ORDER BY
        c.table_name
      `,
      []
    );

  const checks =
    [];

  for (
    const row of
    discoveredTables || []
  ) {
    const table =
      String(
        row?.table_name ||
        ""
      ).trim();

    if (!table) {
      continue;
    }

    /*
     * SQL identifiers cannot use bind parameters,
     * therefore only identifiers discovered directly
     * from information_schema are permitted.
     */
    const safeTable =
      `"${table.replace(
        /"/g,
        '""'
      )}"`;

    /*
     * Nullable restaurant_id columns are allowed
     * to contain NULL unless the domain-specific
     * check below says otherwise.
     *
     * The universal tenant invariant here is:
     * if restaurant_id exists, it MUST point to a
     * real restaurant.
     */
    checks.push(
      await buildViolationCheck(
        db,
        {
          key:
            `tenant_all_${table}`,

          title:
            `${table} tenant ownership`,

          category:
            "Tenant Isolation",

          severity:
            "critical",

          description:
            `Checks every non-null ${table}.restaurant_id against public.restaurants.`,

          healthyMessage:
            `${table} contains no orphan tenant ownership.`,

          countSql:
            `
            SELECT
              COUNT(*)::int
                AS count

            FROM
              public.${safeTable} t

            LEFT JOIN
              public.restaurants r
              ON r.id =
                 t.restaurant_id

            WHERE
              t.restaurant_id
                IS NOT NULL

              AND

              r.id IS NULL
            `,

          evidenceSql:
            `
            SELECT
              t.restaurant_id,

              'restaurant_not_found'
                AS problem

            FROM
              public.${safeTable} t

            LEFT JOIN
              public.restaurants r
              ON r.id =
                 t.restaurant_id

            WHERE
              t.restaurant_id
                IS NOT NULL

              AND

              r.id IS NULL

            LIMIT 25
            `,
        }
      )
    );
  }

  /*
   * =====================================================
   * REQUIRED TENANT-ID CHECKS
   * =====================================================
   *
   * The dynamic scan above deliberately permits NULL on
   * nullable columns.
   *
   * For tables where MAKS business rules REQUIRE tenant
   * ownership, check NULL separately.
   * =====================================================
   */

  const requiredTenantTables = [
    "orders",
    "pos_orders",
    "stock",
    "restaurant_members",
    "restaurant_devices",
    "invoices",
    "kds_item_state",
    "kds_station_ack",
    "menu_items",
    "order_batches",
    "org_receipt_settings",
    "payment_settlements",
    "pos_device_sessions",
    "pos_table_sessions",
  ];

  for (
    const table of
    requiredTenantTables
  ) {
    /*
     * Only run this check if the table was actually
     * discovered in the current schema.
     */
    const exists =
      (discoveredTables || [])
        .some(
          (row) =>
            String(
              row?.table_name ||
              ""
            ) === table
        );

    if (!exists) {
      continue;
    }

    const safeTable =
      `"${table.replace(
        /"/g,
        '""'
      )}"`;

    checks.push(
      await buildViolationCheck(
        db,
        {
          key:
            `tenant_required_${table}`,

          title:
            `${table} required tenant identity`,

          category:
            "Tenant Isolation",

          severity:
            "critical",

          description:
            `${table} rows must always carry restaurant_id.`,

          healthyMessage:
            `${table} has no missing restaurant ownership.`,

          countSql:
            `
            SELECT
              COUNT(*)::int
                AS count

            FROM
              public.${safeTable}

            WHERE
              restaurant_id
                IS NULL
            `,

          evidenceSql:
            `
            SELECT
              'missing_restaurant_id'
                AS problem

            FROM
              public.${safeTable}

            WHERE
              restaurant_id
                IS NULL

            LIMIT 25
            `,
        }
      )
    );
  }

  /*
   * =====================================================
   * BOOKINGS
   * =====================================================
   *
   * MAKS currently treats booking ownership as mandatory
   * at application level even though the DB column remains
   * nullable.
   */
  const bookingExists =
    (discoveredTables || [])
      .some(
        (row) =>
          String(
            row?.table_name ||
            ""
          ) ===
          "bookings"
      );

  if (bookingExists) {
    checks.push(
      await buildViolationCheck(
        db,
        {
          key:
            "tenant_bookings_required",

          title:
            "Booking tenant ownership",

          category:
            "Tenant Isolation",

          severity:
            "critical",

          description:
            "Every booking must belong to a valid restaurant.",

          healthyMessage:
            "Bookings retain valid restaurant ownership.",

          countSql:
            `
            SELECT
              COUNT(*)::int
                AS count

            FROM
              public.bookings b

            LEFT JOIN
              public.restaurants r
              ON r.id =
                 b.restaurant_id

            WHERE
              b.restaurant_id
                IS NULL

              OR

              r.id IS NULL
            `,

          evidenceSql:
            `
            SELECT
              b.id,
              b.restaurant_id,
              b.booking_time,
              b.status,

              CASE
                WHEN
                  b.restaurant_id
                    IS NULL
                  THEN
                    'missing_restaurant_id'

                ELSE
                  'restaurant_not_found'
              END
                AS problem

            FROM
              public.bookings b

            LEFT JOIN
              public.restaurants r
              ON r.id =
                 b.restaurant_id

            WHERE
              b.restaurant_id
                IS NULL

              OR

              r.id IS NULL

            ORDER BY
              b.id ASC

            LIMIT 25
            `,
        }
      )
    );
  }

  return checks;
}

/*
 * =====================================================
 * 2. MEMBERSHIPS / AUTHORITY
 * =====================================================
 */

async function checkMemberships(
  db
) {
  const checks =
    [];

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "membership_user_restaurant_mismatch",

        title:
          "Membership tenant identity",

        category:
          "Users & Authority",

        severity:
          "critical",

        description:
          "A user's legacy restaurant_id must not contradict an active restaurant membership.",

        healthyMessage:
          "User and membership restaurant ownership is consistent.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.restaurant_members rm

          JOIN
            public.users u
            ON u.id =
               rm.user_id

          WHERE
            u.restaurant_id
              IS NOT NULL

            AND

            u.restaurant_id <>
              rm.restaurant_id
          `,

        evidenceSql:
          `
          SELECT
            rm.id
              AS membership_id,

            rm.user_id,

            rm.restaurant_id
              AS membership_restaurant_id,

            u.restaurant_id
              AS user_restaurant_id,

            rm.role,
            rm.authority,
            rm.is_active

          FROM
            public.restaurant_members rm

          JOIN
            public.users u
            ON u.id =
               rm.user_id

          WHERE
            u.restaurant_id
              IS NOT NULL

            AND

            u.restaurant_id <>
              rm.restaurant_id

          ORDER BY
            rm.id ASC

          LIMIT 25
          `,
      }
    )
  );

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "restaurants_without_owner",

        title:
          "Restaurant owner authority",

        category:
          "Users & Authority",

        severity:
          "critical",

        description:
          "Every restaurant must retain at least one active owner/admin membership.",

        healthyMessage:
          "Every restaurant has active owner/admin authority.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.restaurants r

          WHERE
            NOT EXISTS (
              SELECT 1

              FROM
                public.restaurant_members rm

              JOIN
                public.users u
                ON u.id =
                   rm.user_id

              WHERE
                rm.restaurant_id =
                  r.id

                AND
                rm.is_active =
                  TRUE

                AND
                u.is_active =
                  TRUE

                AND
                rm.role IN (
                  'owner',
                  'admin'
                )
            )
          `,

        evidenceSql:
          `
          SELECT
            r.id
              AS restaurant_id,

            r.name,
            r.account_status

          FROM
            public.restaurants r

          WHERE
            NOT EXISTS (
              SELECT 1

              FROM
                public.restaurant_members rm

              JOIN
                public.users u
                ON u.id =
                   rm.user_id

              WHERE
                rm.restaurant_id =
                  r.id

                AND
                rm.is_active =
                  TRUE

                AND
                u.is_active =
                  TRUE

                AND
                rm.role IN (
                  'owner',
                  'admin'
                )
            )

          ORDER BY
            r.id ASC

          LIMIT 25
          `,
      }
    )
  );

  return checks;
}

/*
 * =====================================================
 * 3. KDS / ORDER BATCH OWNERSHIP
 * =====================================================
 */

async function checkKdsOwnership(
  db
) {
  const checks =
    [];

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "kds_order_batch_ownership",

        title:
          "KDS batch ownership",

        category:
          "KDS",

        severity:
          "critical",

        description:
          "Every KDS order with a batch must point to a batch owned by the same restaurant.",

        healthyMessage:
          "KDS order batches preserve restaurant ownership.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.orders o

          LEFT JOIN
            public.order_batches ob
            ON ob.id =
               o.batch_id

          WHERE
            o.batch_id
              IS NOT NULL

            AND (
              ob.id
                IS NULL

              OR

              ob.restaurant_id <>
                o.restaurant_id
            )
          `,

        evidenceSql:
          `
          SELECT
            o.id
              AS order_id,

            o.restaurant_id
              AS order_restaurant_id,

            o.batch_id,

            ob.restaurant_id
              AS batch_restaurant_id,

            CASE
              WHEN
                ob.id IS NULL
                THEN
                  'missing_batch'

              ELSE
                'cross_tenant_batch'
            END
              AS problem

          FROM
            public.orders o

          LEFT JOIN
            public.order_batches ob
            ON ob.id =
               o.batch_id

          WHERE
            o.batch_id
              IS NOT NULL

            AND (
              ob.id
                IS NULL

              OR

              ob.restaurant_id <>
                o.restaurant_id
            )

          ORDER BY
            o.id ASC

          LIMIT 25
          `,
      }
    )
  );

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "pos_batch_ownership",

        title:
          "POS batch ownership",

        category:
          "Orders",

        severity:
          "critical",

        description:
          "POS order batches must never resolve to another restaurant.",

        healthyMessage:
          "POS batches preserve restaurant ownership.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.pos_orders po

          JOIN
            public.order_batches ob
            ON ob.id =
               po.batch_id

          WHERE
            po.batch_id
              IS NOT NULL

            AND

            ob.restaurant_id <>
              po.restaurant_id
          `,

        evidenceSql:
          `
          SELECT
            po.id
              AS pos_order_id,

            po.restaurant_id
              AS order_restaurant_id,

            po.batch_id,

            ob.restaurant_id
              AS batch_restaurant_id

          FROM
            public.pos_orders po

          JOIN
            public.order_batches ob
            ON ob.id =
               po.batch_id

          WHERE
            po.batch_id
              IS NOT NULL

            AND

            ob.restaurant_id <>
              po.restaurant_id

          ORDER BY
            po.id ASC

          LIMIT 25
          `,
      }
    )
  );

  return checks;
}

/*
 * =====================================================
 * 4. POS FINANCIAL INTEGRITY
 * =====================================================
 */

async function checkPosFinancialState(
  db
) {
  const checks =
    [];

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "pos_negative_balances",

        title:
          "POS non-negative balances",

        category:
          "Payments",

        severity:
          "critical",

        description:
          "POS paid/outstanding amounts must never fall below zero.",

        healthyMessage:
          "No POS order has an impossible negative financial balance.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.pos_orders

          WHERE
            COALESCE(
              amount_paid,
              0
            ) < -0.01

            OR

            COALESCE(
              remaining_price,
              0
            ) < -0.01
          `,

        evidenceSql:
          `
          SELECT
            id,
            restaurant_id,
            table_number,
            total_price,
            amount_paid,
            remaining_price,
            paid,
            order_status,
            source

          FROM
            public.pos_orders

          WHERE
            COALESCE(
              amount_paid,
              0
            ) < -0.01

            OR

            COALESCE(
              remaining_price,
              0
            ) < -0.01

          ORDER BY
            id ASC

          LIMIT 25
          `,
      }
    )
  );

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "paid_pos_has_balance",

        title:
          "Paid POS reconciliation",

        category:
          "Payments",

        severity:
          "critical",

        description:
          "A POS line marked paid must not retain an outstanding balance.",

        healthyMessage:
          "Paid POS lines reconcile to zero outstanding.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.pos_orders

          WHERE
            COALESCE(
              paid,
              0
            ) = 1

            AND

            ABS(
              COALESCE(
                remaining_price,
                0
              )
            ) > 0.01
          `,

        evidenceSql:
          `
          SELECT
            id,
            restaurant_id,
            table_number,
            total_price,
            amount_paid,
            remaining_price,
            source,
            order_status

          FROM
            public.pos_orders

          WHERE
            COALESCE(
              paid,
              0
            ) = 1

            AND

            ABS(
              COALESCE(
                remaining_price,
                0
              )
            ) > 0.01

          ORDER BY
            id ASC

          LIMIT 25
          `,
      }
    )
  );

  return checks;
}

/*
 * =====================================================
 * 5. PAYMENT OWNERSHIP / REFUNDS
 * =====================================================
 */

async function checkPayments(
  db
) {
  const checks =
    [];

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "payment_missing_restaurant",

        title:
          "Payment tenant ownership",

        category:
          "Payments",

        severity:
          "critical",

        description:
          "Every payment must resolve to a valid restaurant.",

        healthyMessage:
          "Payments retain valid restaurant ownership.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.payments p

          LEFT JOIN
            public.restaurants r
            ON r.id =
               p.restaurant_id

          WHERE
            p.restaurant_id
              IS NULL

            OR

            r.id IS NULL
          `,

        evidenceSql:
          `
          SELECT
            p.id,
            p.restaurant_id,
            p.amount,
            p.status,
            p.created_at

          FROM
            public.payments p

          LEFT JOIN
            public.restaurants r
            ON r.id =
               p.restaurant_id

          WHERE
            p.restaurant_id
              IS NULL

            OR

            r.id IS NULL

          ORDER BY
            p.id ASC

          LIMIT 25
          `,
      }
    )
  );

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "refund_cross_tenant",

        title:
          "Refund payment ownership",

        category:
          "Payments",

        severity:
          "critical",

        description:
          "Refunds must reference payments from the same restaurant.",

        healthyMessage:
          "Refund relationships remain inside their restaurant.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.payments refund

          JOIN
            public.payments original
            ON original.id =
               refund.refund_of_payment_id

          WHERE
            refund.refund_of_payment_id
              IS NOT NULL

            AND

            refund.restaurant_id <>
              original.restaurant_id
          `,

        evidenceSql:
          `
          SELECT
            refund.id
              AS refund_payment_id,

            refund.restaurant_id
              AS refund_restaurant_id,

            original.id
              AS original_payment_id,

            original.restaurant_id
              AS original_restaurant_id

          FROM
            public.payments refund

          JOIN
            public.payments original
            ON original.id =
               refund.refund_of_payment_id

          WHERE
            refund.refund_of_payment_id
              IS NOT NULL

            AND

            refund.restaurant_id <>
              original.restaurant_id

          ORDER BY
            refund.id ASC

          LIMIT 25
          `,
      }
    )
  );

  /*
   * Validate payment → POS ownership for every
   * numeric ID stored inside pos_order_ids.
   */
  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "payment_pos_order_cross_tenant",

        title:
          "Payment to POS ownership",

        category:
          "Payments",

        severity:
          "critical",

        description:
          "A payment may reference POS order IDs only from the same restaurant.",

        healthyMessage:
          "Payment POS references remain tenant-isolated.",

        countSql:
          `
          WITH payment_items AS (
            SELECT
              p.id
                AS payment_id,

              p.restaurant_id
                AS payment_restaurant_id,

              value
                AS pos_order_id_text

            FROM
              public.payments p

            CROSS JOIN LATERAL
              jsonb_array_elements_text(
                CASE
                  WHEN
                    jsonb_typeof(
                      COALESCE(
                        p.pos_order_ids,
                        '[]'::jsonb
                      )
                    ) = 'array'
                    THEN
                      COALESCE(
                        p.pos_order_ids,
                        '[]'::jsonb
                      )

                  ELSE
                    '[]'::jsonb
                END
              ) AS value

            WHERE
              value ~ '^[0-9]+$'
          )

          SELECT
            COUNT(*)::int
              AS count

          FROM
            payment_items pi

          JOIN
            public.pos_orders po
            ON po.id =
               pi.pos_order_id_text::bigint

          WHERE
            po.restaurant_id <>
              pi.payment_restaurant_id
          `,

        evidenceSql:
          `
          WITH payment_items AS (
            SELECT
              p.id
                AS payment_id,

              p.restaurant_id
                AS payment_restaurant_id,

              value
                AS pos_order_id_text

            FROM
              public.payments p

            CROSS JOIN LATERAL
              jsonb_array_elements_text(
                CASE
                  WHEN
                    jsonb_typeof(
                      COALESCE(
                        p.pos_order_ids,
                        '[]'::jsonb
                      )
                    ) = 'array'
                    THEN
                      COALESCE(
                        p.pos_order_ids,
                        '[]'::jsonb
                      )

                  ELSE
                    '[]'::jsonb
                END
              ) AS value

            WHERE
              value ~ '^[0-9]+$'
          )

          SELECT
            pi.payment_id,

            pi.payment_restaurant_id,

            po.id
              AS pos_order_id,

            po.restaurant_id
              AS pos_order_restaurant_id

          FROM
            payment_items pi

          JOIN
            public.pos_orders po
            ON po.id =
               pi.pos_order_id_text::bigint

          WHERE
            po.restaurant_id <>
              pi.payment_restaurant_id

          ORDER BY
            pi.payment_id ASC

          LIMIT 25
          `,
      }
    )
  );

  return checks;
}

/*
 * =====================================================
 * 6. STOCK
 * =====================================================
 */

async function checkStock(
  db
) {
  const checks =
    [];

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "stock_negative_commercial_state",

        title:
          "Stock commercial integrity",

        category:
          "Stock",

        severity:
          "critical",

        description:
          "Live stock quantity and commercial price must not become negative.",

        healthyMessage:
          "Stock has no negative quantity or commercial price.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.stock

          WHERE
            quantity < 0

            OR

            COALESCE(
              price,
              0
            ) < 0
          `,

        evidenceSql:
          `
          SELECT
            id,
            restaurant_id,
            ingredient,
            quantity,
            unit,
            price,
            supplier_id,
            updated_at

          FROM
            public.stock

          WHERE
            quantity < 0

            OR

            COALESCE(
              price,
              0
            ) < 0

          ORDER BY
            id ASC

          LIMIT 25
          `,
      }
    )
  );

  return checks;
}

/*
 * =====================================================
 * 7. BOOKINGS
 * =====================================================
 */

async function checkBookings(
  db
) {
  const checks =
    [];

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "booking_invalid_guests",

        title:
          "Booking guest integrity",

        category:
          "Bookings",

        severity:
          "warning",

        description:
          "Bookings should never contain zero or negative guest counts.",

        healthyMessage:
          "Booking guest counts are valid.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.bookings

          WHERE
            guests IS NULL

            OR

            guests <= 0
          `,

        evidenceSql:
          `
          SELECT
            id,
            restaurant_id,
            booking_time,
            customer_name,
            guests,
            status

          FROM
            public.bookings

          WHERE
            guests IS NULL

            OR

            guests <= 0

          ORDER BY
            id ASC

          LIMIT 25
          `,
      }
    )
  );

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "booking_invalid_duration",

        title:
          "Booking duration integrity",

        category:
          "Bookings",

        severity:
          "warning",

        description:
          "Booking slot duration must remain positive.",

        healthyMessage:
          "Booking durations are valid.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.bookings

          WHERE
            slot_min <= 0
          `,

        evidenceSql:
          `
          SELECT
            id,
            restaurant_id,
            booking_time,
            slot_min,
            status

          FROM
            public.bookings

          WHERE
            slot_min <= 0

          ORDER BY
            id ASC

          LIMIT 25
          `,
      }
    )
  );

  return checks;
}

/*
 * =====================================================
 * 8. DEVICES
 * =====================================================
 */

async function checkDevices(
  db
) {
  const checks =
    [];

  checks.push(
    await buildViolationCheck(
      db,
      {
        key:
          "device_invalid_seen_time",

        title:
          "Device heartbeat integrity",

        category:
          "Devices",

        severity:
          "warning",

        description:
          "A device must never report a last-seen time before its first-seen time.",

        healthyMessage:
          "Device heartbeat chronology is valid.",

        countSql:
          `
          SELECT
            COUNT(*)::int
              AS count

          FROM
            public.restaurant_devices

          WHERE
            last_seen_at <
              first_seen_at
          `,

        evidenceSql:
          `
          SELECT
            id,
            restaurant_id,
            device_key,
            device_type,
            device_name,
            first_seen_at,
            last_seen_at,
            is_active

          FROM
            public.restaurant_devices

          WHERE
            last_seen_at <
              first_seen_at

          ORDER BY
            id ASC

          LIMIT 25
          `,
      }
    )
  );

  return checks;
}

/*
 * =====================================================
 * PLATFORM COUNTS
 * =====================================================
 */

async function getPlatformCounts(
  db
) {
  const row =
    await db.qGet(
      `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM public.restaurants
        ) AS restaurants,

        (
          SELECT COUNT(*)::int
          FROM public.users
        ) AS users,

        (
          SELECT COUNT(*)::int
          FROM public.restaurant_members
        ) AS memberships,

        (
          SELECT COUNT(*)::int
          FROM public.restaurant_devices
        ) AS devices,

        (
          SELECT COUNT(*)::int
          FROM public.pos_orders
        ) AS pos_orders,

        (
          SELECT COUNT(*)::int
          FROM public.orders
        ) AS kds_orders,

        (
          SELECT COUNT(*)::int
          FROM public.payments
        ) AS payments,

        (
          SELECT COUNT(*)::int
          FROM public.bookings
        ) AS bookings,

        (
          SELECT COUNT(*)::int
          FROM public.stock
        ) AS stock_rows
      `,
      []
    );

  return {
    restaurants:
      number(
        row?.restaurants
      ),

    users:
      number(
        row?.users
      ),

    memberships:
      number(
        row?.memberships
      ),

    devices:
      number(
        row?.devices
      ),

    pos_orders:
      number(
        row?.pos_orders
      ),

    kds_orders:
      number(
        row?.kds_orders
      ),

    payments:
      number(
        row?.payments
      ),

    bookings:
      number(
        row?.bookings
      ),

    stock_rows:
      number(
        row?.stock_rows
      ),
  };
}

/*
 * =====================================================
 * CATEGORY SUMMARY
 * =====================================================
 */

function buildCategorySummary(
  checks
) {
  const map =
    new Map();

  for (
    const check of checks
  ) {
    const category =
      String(
        check.category ||
        "Other"
      );

    if (
      !map.has(
        category
      )
    ) {
      map.set(
        category,
        {
          category,
          total_checks:
            0,
          passed_checks:
            0,
          failed_checks:
            0,
          violations:
            0,
          critical_violations:
            0,
          warning_violations:
            0,
        }
      );
    }

    const target =
      map.get(
        category
      );

    target.total_checks +=
      1;

    target.violations +=
      number(
        check.violations
      );

    if (
      check.ok
    ) {
      target.passed_checks +=
        1;
    } else {
      target.failed_checks +=
        1;

      if (
        check.severity ===
        "critical"
      ) {
        target.critical_violations +=
          number(
            check.violations
          );
      } else {
        target.warning_violations +=
          number(
            check.violations
          );
      }
    }
  }

  return Array.from(
    map.values()
  );
}

/*
 * =====================================================
 * REAL WORLD SCAN
 * =====================================================
 */

async function runRealWorldMaksScan(
  db
) {
  if (
    !db?.qGet ||
    !db?.qAll
  ) {
    throw new Error(
      "Real World MAKS requires qGet and qAll."
    );
  }

  const startedAt =
    new Date();

  const startedMs =
    Date.now();

  /*
   * Verify environment first.
   */
  const environment =
    await inspectEnvironment(
      db
    );

  /*
   * Every function below is SELECT-only.
   */
  const [
    tenantChecks,
    membershipChecks,
    kdsChecks,
    financialChecks,
    paymentChecks,
    stockChecks,
    bookingChecks,
    deviceChecks,
    platformCounts,
  ] =
    await Promise.all([
      checkTenantOwnership(
        db
      ),

      checkMemberships(
        db
      ),

      checkKdsOwnership(
        db
      ),

      checkPosFinancialState(
        db
      ),

      checkPayments(
        db
      ),

      checkStock(
        db
      ),

      checkBookings(
        db
      ),

      checkDevices(
        db
      ),

      getPlatformCounts(
        db
      ),
    ]);

  const checks = [
    ...tenantChecks,
    ...membershipChecks,
    ...kdsChecks,
    ...financialChecks,
    ...paymentChecks,
    ...stockChecks,
    ...bookingChecks,
    ...deviceChecks,
  ];

  const totalChecks =
    checks.length;

  const passedChecks =
    checks.filter(
      (check) =>
        check.ok
    ).length;

  const failedChecks =
    totalChecks -
    passedChecks;

  const criticalFindings =
    checks.reduce(
      (
        sum,
        check
      ) =>
        sum +
        (
          !check.ok &&
          check.severity ===
            "critical"
            ? number(
                check.violations
              )
            : 0
        ),
      0
    );

  const warningFindings =
    checks.reduce(
      (
        sum,
        check
      ) =>
        sum +
        (
          !check.ok &&
          check.severity ===
            "warning"
            ? number(
                check.violations
              )
            : 0
        ),
      0
    );

  const totalFindings =
    criticalFindings +
    warningFindings;

  /*
   * Overall status is factual, not a fake score.
   *
   * critical -> integrity failure
   * warning  -> platform needs attention
   * healthy  -> all current invariants pass
   */
  const status =
    criticalFindings > 0
      ? "critical"
      : warningFindings > 0
        ? "warning"
        : "healthy";

  return {
    success:
      true,

    scanner:
      "real_world_maks",

    mode:
      "live_read_only",

    status,

    environment,

    summary: {
      total_checks:
        totalChecks,

      passed_checks:
        passedChecks,

      failed_checks:
        failedChecks,

      total_findings:
        totalFindings,

      critical_findings:
        criticalFindings,

      warning_findings:
        warningFindings,

      verified:
        criticalFindings === 0,

      fully_clean:
        totalFindings === 0,
    },

    platform_counts:
      platformCounts,

    categories:
      buildCategorySummary(
        checks
      ),

    checks,

    started_at:
      startedAt.toISOString(),

    finished_at:
      new Date().toISOString(),

    duration_ms:
      Date.now() -
      startedMs,
  };
}

module.exports = {
  runRealWorldMaksScan,
  inspectEnvironment,
};