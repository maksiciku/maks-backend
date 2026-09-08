// backend/routes/cashupRoutes.js

const router =
  require("express").Router();

const {
  authenticateToken,
} = require("../middleware/authMiddleware");

const {
  loadMembership,
} = require("../middleware/tenantMembership");

const {
  PERMISSIONS,
  requirePermission,
  hasPermission,
} = require("../middleware/accessControl");

const {
  withTx,
} = require("../dbCompat");

const {
  emitCashupSessionClosedTx,
} = require("../edge/contracts/cashupOperations");

// =========================================================
// AUTHORITY
// =========================================================

router.use(
  authenticateToken,
  loadMembership
);

function permissionSubject(req) {
  return {
    authority:
      req.membership?.authority ||
      req.user?.authority,

    permissions:
      req.membership?.permissions ||
      req.user?.permissions,
  };
}

function can(
  req,
  permission
) {
  return hasPermission(
    permissionSubject(req),
    permission
  );
}

function deny(
  res,
  permission
) {
  return res.status(403).json({
    error:
      "You do not have permission to perform this cash-up action.",

    code:
      "PERMISSION_DENIED",

    permission,
  });
}

// =========================================================
// HELPERS
// =========================================================

function isoStartOfDay() {
  const d = new Date();

  d.setHours(
    0,
    0,
    0,
    0
  );

  return d.toISOString();
}

function isoEndOfDay() {
  const d = new Date();

  d.setHours(
    23,
    59,
    59,
    999
  );

  return d.toISOString();
}

function normalizeMethod(v) {
  const s =
    String(v || "")
      .trim()
      .toLowerCase();

  if (!s) {
    return "unknown";
  }

  if (
    ["cash"].includes(s)
  ) {
    return "cash";
  }

  if (
    [
      "card",
      "visa",
      "mastercard",
      "amex",
      "contactless",
    ].includes(s)
  ) {
    return "card";
  }

  return s;
}

function mustRid(
  req,
  res
) {
  const rid =
    Number(
      req.tenantRid ||
      req.user?.restaurant_id ||
      0
    );

  if (!rid) {
    res.status(401).json({
      error:
        "Missing restaurant_id",
    });

    return null;
  }

  return rid;
}

function parseISO(
  value,
  fallbackISO
) {
  const v =
    String(
      value || ""
    ).trim();

  if (!v) {
    return fallbackISO;
  }

  const d =
    new Date(v);

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {
    return fallbackISO;
  }

  return d.toISOString();
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "").trim()
  );
}

// =========================================================
// VARIANCE PRIVACY
//
// CASHUP_VIEW:
// can see normal cash-up history.
//
// CASHUP_VIEW_VARIANCE:
// can additionally see:
// - expected cash
// - actual cash
// - discrepancy
// =========================================================

function protectVariance(
  req,
  session
) {
  if (!session) {
    return session;
  }

  if (
    can(
      req,
      PERMISSIONS.CASHUP_VIEW_VARIANCE
    )
  ) {
    return session;
  }

  return {
    ...session,

    actual_cash:
      null,

    expected_cash:
      null,

    discrepancy:
      null,
  };
}

// =========================================================
// KDS ARCHIVE
// =========================================================

async function ensureKdsArchiveColumn(
  req
) {
  await req.qRun(`
    ALTER TABLE public.pos_orders
    ADD COLUMN IF NOT EXISTS
      kds_archived_at TIMESTAMPTZ
  `);

  await req.qRun(`
    CREATE INDEX IF NOT EXISTS
      idx_pos_orders_kds_archive

    ON public.pos_orders
    (
      restaurant_id,
      kds_archived_at,
      created_at
    )
  `);
}

async function archiveKdsOrdersForCashup(
  req,
  rid,
  toISO
) {
  const result =
    await req.qRun(
      `
      UPDATE public.pos_orders

      SET
        kds_archived_at =
          NOW()

      WHERE restaurant_id = $1

        AND kds_archived_at
            IS NULL

        AND created_at <= $2

        AND COALESCE(
          order_status,
          'open'
        ) <> 'voided'
      `,
      [
        rid,
        toISO,
      ]
    );

  return Number(
    result?.rowCount ??
    result?.changes ??
    0
  );
}

// =========================================================
// FINANCIAL SUMMARY
// =========================================================

async function buildSummary(
  req,
  rid,
  from,
  to
) {
  // =====================================================
  // 1. PAYMENT TENDERS
  // =====================================================

  const byMethod =
    await req.qAll(
      `
      SELECT
        LOWER(
          COALESCE(
            NULLIF(
              TRIM(method),
              ''
            ),
            'unknown'
          )
        ) AS method,

        COUNT(*)::int
          AS items,

        COALESCE(
          SUM(amount),
          0
        )::numeric
          AS total

      FROM public.payments

      WHERE restaurant_id = $1

        AND created_at
          BETWEEN $2 AND $3

        AND LOWER(
          COALESCE(
            status,
            'completed'
          )
        ) <> 'voided'

      GROUP BY 1

      ORDER BY 1
      `,
      [
        rid,
        from,
        to,
      ]
    );


  const by_method =
    (byMethod || []).map(
      (row) => ({
        method:
          normalizeMethod(
            row.method
          ),

        items:
          Number(
            row.items || 0
          ),

        total:
          Number(
            row.total || 0
          ),
      })
    );


  const grand_total =
    Number(
      by_method
        .reduce(
          (
            sum,
            row
          ) =>
            sum +
            Number(
              row.total || 0
            ),
          0
        )
        .toFixed(2)
    );


  // =====================================================
  // 2. VAT SUMMARY
  //
  // Source:
  // immutable payment settlement VAT snapshots.
  //
  // We NEVER read today's menu VAT rates to rebuild
  // historical VAT.
  // =====================================================

const vatRows =
  await req.qAll(
    `
    SELECT
      NULLIF(
        bucket ->> 'vat_rate',
        ''
      )::numeric AS vat_rate,

      ROUND(
        COALESCE(
          SUM(
            COALESCE(
              NULLIF(
                bucket ->> 'gross',
                ''
              )::numeric,
              0
            )
          ),
          0
        ),
        2
      ) AS gross,

      ROUND(
        COALESCE(
          SUM(
            COALESCE(
              NULLIF(
                bucket ->> 'net',
                ''
              )::numeric,
              0
            )
          ),
          0
        ),
        2
      ) AS net,

      ROUND(
        COALESCE(
          SUM(
            COALESCE(
              NULLIF(
                bucket ->> 'vat',
                ''
              )::numeric,
              0
            )
          ),
          0
        ),
        2
      ) AS vat

    FROM public.payment_settlements s

    CROSS JOIN LATERAL
      jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(
            s.pricing_snapshot
              -> 'vat'
              -> 'buckets'
          ) = 'array'
          THEN
            s.pricing_snapshot
              -> 'vat'
              -> 'buckets'

          ELSE
            '[]'::jsonb
        END
      ) AS bucket

    WHERE
      s.restaurant_id = $1

      AND s.created_at >= $2
      AND s.created_at <= $3

    GROUP BY
      NULLIF(
        bucket ->> 'vat_rate',
        ''
      )::numeric

    ORDER BY
      NULLIF(
        bucket ->> 'vat_rate',
        ''
      )::numeric DESC
    `,
    [
      rid,
      from,
      to,
    ]
  );

  const vat_by_rate =
    (vatRows || []).map(
      (row) => ({
        vat_rate:
          Number(
            row.vat_rate || 0
          ),

        gross:
          Number(
            row.gross || 0
          ),

        net:
          Number(
            row.net || 0
          ),

        vat:
          Number(
            row.vat || 0
          ),
      })
    );


  const vat_gross =
    Number(
      vat_by_rate
        .reduce(
          (
            sum,
            row
          ) =>
            sum +
            Number(
              row.gross || 0
            ),
          0
        )
        .toFixed(2)
    );


  const vat_net =
    Number(
      vat_by_rate
        .reduce(
          (
            sum,
            row
          ) =>
            sum +
            Number(
              row.net || 0
            ),
          0
        )
        .toFixed(2)
    );


  const vat_total =
    Number(
      vat_by_rate
        .reduce(
          (
            sum,
            row
          ) =>
            sum +
            Number(
              row.vat || 0
            ),
          0
        )
        .toFixed(2)
    );


  // =====================================================
  // 3. UNCLASSIFIED VAT AMOUNTS
  //
  // Old sales may pre-date VAT snapshotting.
  // Keep them visible internally rather than pretending
  // they were zero-rated.
  // =====================================================

  const unclassifiedRow =
    await req.qGet(
      `
      SELECT
        ROUND(
          COALESCE(
            SUM(
              COALESCE(
                (
                  s.pricing_snapshot
                    -> 'vat'
                    ->> 'unclassified_gross'
                )::numeric,
                0
              )
            ),
            0
          ),
          2
        ) AS total

      FROM public.payment_settlements s

WHERE restaurant_id = $1

  AND created_at >= $2
  AND created_at <= $3
`,
[
  rid,
  from,
  to,
]
    );


  const vat_unclassified =
    Number(
      unclassifiedRow?.total || 0
    );


  // =====================================================
  // 4. OUTSIDE-SCOPE SERVICE CHARGE
  // =====================================================

  const outsideScopeRow =
    await req.qGet(
      `
      SELECT
        ROUND(
          COALESCE(
            SUM(
              COALESCE(
                (
                  s.pricing_snapshot
                    -> 'vat'
                    ->>
                    'service_charge_outside_scope'
                )::numeric,
                0
              )
            ),
            0
          ),
          2
        ) AS total

      FROM public.payment_settlements s

      WHERE restaurant_id = $1

  AND created_at >= $2
  AND created_at <= $3
`,
[
  rid,
  from,
  to,
]
    );


  const outside_scope =
    Number(
      outsideScopeRow?.total || 0
    );


  // =====================================================
  // 5. UNPAID POS TABS
  // =====================================================

  const unpaidRow =
    await req.qGet(
      `
      SELECT
        COALESCE(
          SUM(
            COALESCE(
              remaining_price,
              total_price,
              0
            )
          ),
          0
        )::numeric AS total

      FROM public.pos_orders

      WHERE restaurant_id = $1

        AND paid = 0

        AND COALESCE(
          order_status,
          'open'
        ) = 'open'
      `,
      [rid]
    );


  const unpaid_total =
    Number(
      unpaidRow?.total || 0
    );


  // =====================================================
  // 6. CASH DRAWER MOVEMENTS
  // =====================================================

  const movesRows =
    await req.qAll(
      `
      SELECT
        LOWER(kind)
          AS kind,

        COALESCE(
          SUM(amount),
          0
        )::numeric
          AS total

      FROM public.cash_drawer_moves

      WHERE restaurant_id = $1

        AND created_at
          BETWEEN $2 AND $3

      GROUP BY 1

      ORDER BY 1
      `,
      [
        rid,
        from,
        to,
      ]
    );


  const cash_movements =
    Object.fromEntries(
      (movesRows || []).map(
        (move) => [
          String(
            move.kind || ""
          ).toLowerCase(),

          Number(
            move.total || 0
          ),
        ]
      )
    );


  // =====================================================
  // 7. TRANSACTIONS
  // =====================================================

  const transactions =
    await req.qAll(
      `
      SELECT
        id,
        table_number,
        amount,
        method,
        status,
        source,
        created_at

      FROM public.payments

      WHERE restaurant_id = $1

        AND created_at
          BETWEEN $2 AND $3

        AND LOWER(
          COALESCE(
            status,
            'completed'
          )
        ) <> 'voided'

      ORDER BY
        created_at DESC

      LIMIT 250
      `,
      [
        rid,
        from,
        to,
      ]
    );


  // =====================================================
  // 8. EXPECTED CASH
  // =====================================================

  const cashSales =
    Number(
      by_method.find(
        (row) =>
          row.method ===
          "cash"
      )?.total || 0
    );


  const expected_cash =
    Number(
      (
        cashSales +

        Number(
          cash_movements.float ||
          0
        ) -

        Number(
          cash_movements.payout ||
          0
        ) -

        Number(
          cash_movements.drop ||
          0
        ) +

        Number(
          cash_movements.correction ||
          0
        ) -

        Number(
          cash_movements.refund ||
          0
        )
      ).toFixed(2)
    );


  // =====================================================
  // RESPONSE
  // =====================================================

  return {
    range: {
      from,
      to,
    },

    by_method,

    grand_total,

    vat_summary: {
      gross:
        vat_gross,

      net:
        vat_net,

      vat:
        vat_total,

      unclassified:
        vat_unclassified,

      outside_scope:
        outside_scope,

      by_rate:
        vat_by_rate,
    },

    unpaid_total,

    cash_movements,

    expected_cash,

    transactions:
      (transactions || []).map(
        (transaction) => ({
          id:
            transaction.id,

          table_number:
            transaction.table_number ||
            "",

          amount:
            Number(
              transaction.amount || 0
            ),

          method:
            normalizeMethod(
              transaction.method
            ),

          status:
            transaction.status ||
            "completed",

          source:
            transaction.source ||
            "pos",

          created_at:
            transaction.created_at,
        })
      ),
  };
}
// =========================================================
// GET /cashup/summary
// =========================================================

router.get(
  "/summary",

  requirePermission(
    PERMISSIONS.CASHUP_VIEW
  ),

  async (req, res) => {
    try {
      const rid =
        mustRid(
          req,
          res
        );

      if (!rid) {
        return;
      }

      const from =
        parseISO(
          req.query.from,
          isoStartOfDay()
        );

      const to =
        parseISO(
          req.query.to,
          isoEndOfDay()
        );

      if (
        new Date(from) >
        new Date(to)
      ) {
        return res
          .status(400)
          .json({
            error:
              "from must be before to",
          });
      }

      const summary =
        await buildSummary(
          req,
          rid,
          from,
          to
        );

      return res.json(
        summary
      );
    } catch (err) {
      console.error(
        "❌ cashup summary failed:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to build cashup summary",
        });
    }
  }
);

// =========================================================
// POST /cashup/close
// =========================================================

router.post(
  "/close",

  requirePermission(
    PERMISSIONS.CASHUP_CLOSE
  ),

  async (req, res) => {
    try {
      const rid =
        mustRid(
          req,
          res
        );

      if (!rid) {
        return;
      }

      const actual_cash =
        req.body?.actual_cash !=
        null
          ? Number(
              req.body.actual_cash
            )
          : null;

      if (
        actual_cash == null ||
        !Number.isFinite(
          actual_cash
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "actual_cash is required and must be a number",
          });
      }

      const fromISO =
        parseISO(
          req.body?.from,
          isoStartOfDay()
        );

      const toISO =
        parseISO(
          req.body?.to,
          new Date().toISOString()
        );

      const note =
        String(
          req.body?.note ||
          ""
        )
          .trim()
          .slice(
            0,
            1000
          ) ||
        null;

      if (
        new Date(
          fromISO
        ) >
        new Date(
          toISO
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "from must be before to",
          });
      }

      const actualCash =
        Number(
          actual_cash
        );

      // ---------------------------------------------------
      // ATOMIC CASH-UP CLOSE
      //
      // Everything below runs on one PostgreSQL client.
      // If any step fails, withTx() rolls the whole close
      // back so we never leave half-closed financial state.
      // ---------------------------------------------------

      const result =
        await withTx(
          async (tx) => {

            // ---------------------------------------------
            // Restaurant-scoped transaction lock.
            //
            // Prevents two terminals closing the same
            // restaurant at the same time.
            //
            // Lock is automatically released at COMMIT
            // or ROLLBACK.
            // ---------------------------------------------

            await tx.qRun(
              `
              SELECT pg_advisory_xact_lock(
                hashtext('maks-cashup-close'),
                $1
              )
              `,
              [rid]
            );

            // ---------------------------------------------
            // Snapshot is calculated INSIDE the lock and
            // transaction so the close uses one consistent
            // financial state.
            // ---------------------------------------------

            const snapshot =
              await buildSummary(
                tx,
                rid,
                fromISO,
                toISO
              );

            const expectedCash =
              Number(
                snapshot.expected_cash ||
                0
              );

            const diff =
              Number(
                (
                  actualCash -
                  expectedCash
                ).toFixed(2)
              );

            // ---------------------------------------------
            // Duplicate check happens under advisory lock.
            // ---------------------------------------------

            const existingSession =
              await tx.qGet(
                `
                SELECT
                  id,
                  created_at

                FROM public.cashup_sessions

                WHERE restaurant_id = $1

                  AND from_ts = $2

                  AND to_ts = $3

                LIMIT 1
                `,
                [
                  rid,
                  fromISO,
                  toISO,
                ]
              );

            if (
              existingSession
            ) {
              const err =
                new Error(
                  "CASHUP_ALREADY_CLOSED"
                );

              err.code =
                "CASHUP_ALREADY_CLOSED";

              err.cashup_session_id =
                existingSession.id;

              throw err;
            }

            // ---------------------------------------------
            // Create cash-up session.
            // ---------------------------------------------

            const session =
              await tx.qGet(
                `
                INSERT INTO public.cashup_sessions
                (
                  restaurant_id,
                  from_ts,
                  to_ts,
                  closed_by_user_id,
                  actual_cash,
                  expected_cash,
                  discrepancy,
                  note,
                  closed_by_name
                )

                VALUES
                (
                  $1,
                  $2,
                  $3,
                  $4,
                  $5,
                  $6,
                  $7,
                  $8,
                  $9
                )

                RETURNING id
                `,
                [
                  rid,
                  fromISO,
                  toISO,
                  req.user?.id ||
                    null,
                  actualCash,
                  expectedCash,
                  diff,
                  note,
                  String(
                    req.user?.full_name ||
                    req.user?.name ||
                    req.user?.username ||
                    ""
                  ).trim() ||
                    null,
                ]
              );

            const sessionId =
              session?.id;

            if (
              !sessionId ||
              !isUuid(
                sessionId
              )
            ) {
              throw new Error(
                "Cashup session id is not UUID. Fix DB schema: cashup_sessions.id must be UUID."
              );
            }

            // ---------------------------------------------
            // Link payments that have not already been
            // closed into another cash-up.
            // ---------------------------------------------

            const paymentsLinked =
              await tx.qRun(
                `
                UPDATE public.payments

                SET
                  cashup_session_id = $1

                WHERE restaurant_id = $2

                  AND cashup_session_id
                      IS NULL

                  AND created_at >= $3

                  AND created_at <= $4
                `,
                [
                  sessionId,
                  rid,
                  fromISO,
                  toISO,
                ]
              );

            // ---------------------------------------------
            // Archive KDS orders in SAME transaction.
            // ---------------------------------------------

            const kdsArchivedCount =
              await archiveKdsOrdersForCashup(
                tx,
                rid,
                toISO
              );

            /*
             * Durable Edge cash-up event.
             *
             * Same PostgreSQL transaction as
             * session creation, payment linking
             * and KDS archive.
             *
             * Outbox failure rolls back the
             * whole cash-up close.
             */
            await emitCashupSessionClosedTx(
              tx,
              {
                restaurantId:
                  rid,

                cashupSessionId:
                  sessionId,
              }
            );

            return {
              success: true,

              cashup_session_id:
                sessionId,

              expected_cash:
                expectedCash,

              actual_cash:
                actualCash,

              discrepancy:
                diff,

              payments_linked:
                Number(
                  paymentsLinked?.rowCount ??
                  paymentsLinked?.changes ??
                  0
                ),

              kds_archived_count:
                kdsArchivedCount,

              snapshot,
            };
          }
        );

      return res.json(
        result
      );
    } catch (err) {
      if (
        err?.code ===
        "CASHUP_ALREADY_CLOSED"
      ) {
        return res
          .status(409)
          .json({
            error:
              "This cash-up range has already been closed. Please choose a new time range.",

            cashup_session_id:
              err.cashup_session_id,
          });
      }

      console.error(
        "❌ cashup close failed:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to close cashup",
        });
    }
  }
);
// =========================================================
// POST /cashup/move
//
// float
//   → CASHUP_OPEN
//
// payout / drop / correction
//   → CASHUP_ADJUST
//
// sale / refund
//   → historical compatibility only.
//     New sales and refunds belong exclusively to the
//     authoritative immutable payments ledger.
// =========================================================

router.post(
  "/move",

  async (req, res) => {
    try {
      const rid =
        mustRid(
          req,
          res
        );

      if (!rid) {
        return;
      }

      const moveKind =
        String(
          req.body?.kind ||
          ""
        )
          .toLowerCase()
          .trim();

      const amount =
        Number(
          req.body?.amount
        );

      /*
       * Sales and POS refunds are authoritative financial
       * ledger entries in public.payments.
       *
       * Allowing them to also be entered manually here
       * would represent the same money twice.
       *
       * Historical sale/refund rows remain readable in
       * cash_drawer_moves for backward compatibility.
       */
      const ledgerOwnedKinds =
        new Set([
          "sale",
          "refund",
        ]);

      if (
        ledgerOwnedKinds.has(
          moveKind
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Manual sale/refund drawer movements are disabled. Sales and refunds are recorded from the payment ledger.",
            code:
              "CASHUP_LEDGER_OWNED_MOVEMENT",
          });
      }

      const allowed =
        new Set([
          "float",
          "payout",
          "drop",
          "correction",
        ]);

      if (
        !allowed.has(
          moveKind
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid kind",
          });
      }

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "amount must be greater than 0",
          });
      }

      const requiredPermission =
        moveKind ===
        "float"
          ? PERMISSIONS.CASHUP_OPEN
          : PERMISSIONS.CASHUP_ADJUST;

      if (
        !can(
          req,
          requiredPermission
        )
      ) {
        return deny(
          res,
          requiredPermission
        );
      }

      const note =
        String(
          req.body?.note ||
          ""
        )
          .trim()
          .slice(
            0,
            1000
          );

      await req.qRun(
        `
        INSERT INTO public.cash_drawer_moves
        (
          restaurant_id,
          kind,
          amount,
          note,
          created_by
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5
        )
        `,
        [
          rid,
          moveKind,
          amount,
          note,
          req.user?.id ||
            null,
        ]
      );

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "❌ cashup move failed:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to add movement",
        });
    }
  }
);

// =========================================================
// GET /cashup/sessions
// =========================================================

router.get(
  "/sessions",

  requirePermission(
    PERMISSIONS.CASHUP_VIEW
  ),

  async (req, res) => {
    try {
      const rid =
        mustRid(
          req,
          res
        );

      if (!rid) {
        return;
      }

      const from =
        parseISO(
          req.query.from,
          isoStartOfDay()
        );

      const to =
        parseISO(
          req.query.to,
          isoEndOfDay()
        );

      const rows =
        await req.qAll(
          `
          SELECT

            s.id,
            s.from_ts,
            s.to_ts,
            s.actual_cash,
            s.expected_cash,
            s.discrepancy,
            s.note,
            s.created_at,
            s.closed_by_user_id,

            COALESCE(
              u.full_name,
              u.username,
              CONCAT(
                'User #',
                u.id::text
              )
            )
              AS closed_by_name,

            COALESCE(
              p.cnt,
              0
            )::int
              AS payments_count,

            COALESCE(
              p.total,
              0
            )::numeric
              AS payments_total

          FROM public.cashup_sessions s

          LEFT JOIN public.users u
            ON u.id =
               s.closed_by_user_id

          LEFT JOIN
          (
            SELECT
              cashup_session_id,

              COUNT(*)
                AS cnt,

              SUM(amount)
                AS total

            FROM public.payments

            WHERE restaurant_id = $1

              AND LOWER(
                COALESCE(
                  status,
                  'completed'
                )
              ) <> 'voided'

            GROUP BY
              cashup_session_id
          ) p

            ON p.cashup_session_id =
               s.id

          WHERE s.restaurant_id = $1

            AND s.from_ts >= $2

            AND s.to_ts <= $3

          ORDER BY
            s.created_at DESC

          LIMIT 200
          `,
          [
            rid,
            from,
            to,
          ]
        );

      return res.json(
        (rows || []).map(
          (row) =>
            protectVariance(
              req,
              row
            )
        )
      );
    } catch (err) {
      console.error(
        "❌ cashup sessions list failed:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to load cashup sessions",
        });
    }
  }
);

// =========================================================
// GET /cashup/sessions/:id
// =========================================================

router.get(
  "/sessions/:id",

  requirePermission(
    PERMISSIONS.CASHUP_VIEW
  ),

  async (req, res) => {
    try {
      const rid =
        mustRid(
          req,
          res
        );

      if (!rid) {
        return;
      }

      const id =
        String(
          req.params.id ||
          ""
        ).trim();

      if (
        !isUuid(id)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid session id",
          });
      }

      const session =
        await req.qGet(
          `
          SELECT

            s.*,

            COALESCE(
              u.full_name,
              u.username,
              CONCAT(
                'User #',
                u.id::text
              )
            )
              AS closed_by_name

          FROM public.cashup_sessions s

          LEFT JOIN public.users u
            ON u.id =
               s.closed_by_user_id

          WHERE s.restaurant_id = $1

            AND s.id = $2
          `,
          [
            rid,
            id,
          ]
        );

      if (!session) {
        return res
          .status(404)
          .json({
            error:
              "Session not found",
          });
      }

      const payments =
        await req.qAll(
          `
          SELECT

            p.id,
            p.table_number,
            p.amount,
            p.method,
            p.status,
            p.source,
            p.created_at,
            p.terminal_ref,
            p.staff_user_id,

            COALESCE(
              u.full_name,
              u.username,
              CONCAT(
                'User #',
                u.id::text
              )
            )
              AS staff_name

          FROM public.payments p

          LEFT JOIN public.users u
            ON u.id =
               p.staff_user_id

          WHERE p.restaurant_id = $1

            AND p.cashup_session_id = $2

          ORDER BY
            p.created_at DESC

          LIMIT 2000
          `,
          [
            rid,
            id,
          ]
        );

      return res.json({
        session:
          protectVariance(
            req,
            session
          ),

        payments:
          payments || [],
      });
    } catch (err) {
      console.error(
        "❌ cashup session detail failed:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to load cashup session",
        });
    }
  }
);
// =========================================================
// POST /cashup/sessions/:id/attach
//
// ADMIN / FINANCIAL CORRECTION TOOL
//
// Reassigning payments to a cash-up session is a financial
// adjustment, therefore CASHUP_ADJUST.
// =========================================================

router.post(
  "/sessions/:id/attach",

  requirePermission(
    PERMISSIONS.CASHUP_ADJUST
  ),

  async (req, res) => {
    try {
      const rid =
        mustRid(
          req,
          res
        );

      if (!rid) {
        return;
      }

      const id =
        String(
          req.params.id ||
          ""
        ).trim();

      if (!isUuid(id)) {
        return res
          .status(400)
          .json({
            error:
              "Invalid session id",

            code:
              "INVALID_CASHUP_SESSION_ID",
          });
      }

      /*
       * =====================================================
       * AUTHORITATIVE SESSION
       * =====================================================
       *
       * The target cash-up must belong to the authenticated
       * restaurant.
       *
       * Its stored range is authoritative.
       */
      const session =
        await req.qGet(
          `
          SELECT
            id,
            restaurant_id,
            from_ts,
            to_ts,
            created_at

          FROM public.cashup_sessions

          WHERE restaurant_id = $1
            AND id = $2::uuid

          LIMIT 1
          `,
          [
            rid,
            id,
          ]
        );

      if (!session) {
        return res
          .status(404)
          .json({
            error:
              "Session not found",

            code:
              "CASHUP_SESSION_NOT_FOUND",
          });
      }

      const sessionFrom =
        new Date(
          session.from_ts
        );

      const sessionTo =
        new Date(
          session.to_ts
        );

      if (
        Number.isNaN(
          sessionFrom.getTime()
        ) ||
        Number.isNaN(
          sessionTo.getTime()
        ) ||
        sessionFrom >
          sessionTo
      ) {
        console.error(
          "❌ Invalid stored cashup session range:",
          {
            id,
            restaurant_id:
              rid,
            from_ts:
              session.from_ts,
            to_ts:
              session.to_ts,
          }
        );

        return res
          .status(500)
          .json({
            error:
              "Cash-up session has an invalid stored range.",

            code:
              "INVALID_STORED_CASHUP_RANGE",
          });
      }

      /*
       * =====================================================
       * OPTIONAL REQUEST RANGE
       * =====================================================
       *
       * This endpoint can accept a narrower correction range,
       * but NEVER a range outside the cash-up's authoritative
       * stored boundaries.
       *
       * If omitted, the exact session range is used.
       */
      const requestedFrom =
        req.body?.from != null &&
        String(
          req.body.from
        ).trim() !== ""
          ? new Date(
              req.body.from
            )
          : sessionFrom;

      const requestedTo =
        req.body?.to != null &&
        String(
          req.body.to
        ).trim() !== ""
          ? new Date(
              req.body.to
            )
          : sessionTo;

      if (
        Number.isNaN(
          requestedFrom.getTime()
        ) ||
        Number.isNaN(
          requestedTo.getTime()
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid cash-up attachment range.",

            code:
              "INVALID_CASHUP_ATTACH_RANGE",
          });
      }

      if (
        requestedFrom >
        requestedTo
      ) {
        return res
          .status(400)
          .json({
            error:
              "from must be before to",

            code:
              "INVALID_CASHUP_ATTACH_RANGE",
          });
      }

      /*
       * A correction range may be narrower than the session,
       * but it may not escape the accounting period that was
       * actually closed.
       */
      if (
        requestedFrom <
          sessionFrom ||
        requestedTo >
          sessionTo
      ) {
        return res
          .status(409)
          .json({
            error:
              "Attachment range must remain inside the cash-up session range.",

            code:
              "CASHUP_ATTACH_RANGE_OUTSIDE_SESSION",

            session_range: {
              from:
                sessionFrom.toISOString(),

              to:
                sessionTo.toISOString(),
            },
          });
      }

      const fromISO =
        requestedFrom.toISOString();

      const toISO =
        requestedTo.toISOString();

      /*
       * =====================================================
       * TRANSACTION + RESTAURANT CASHUP LOCK
       * =====================================================
       *
       * Attach participates in the same restaurant cash-up
       * serialization boundary as close.
       */
      const result =
        await withTx(
          async (tx) => {
            await tx.qRun(
              `
              SELECT
                pg_advisory_xact_lock(
                  hashtext(
                    'maks-cashup-close'
                  ),
                  $1
                )
              `,
              [
                rid,
              ]
            );

            /*
             * Re-read/lock the target session after acquiring
             * the restaurant cash-up lock.
             */
            const lockedSession =
              await tx.qGet(
                `
                SELECT
                  id,
                  restaurant_id,
                  from_ts,
                  to_ts

                FROM public.cashup_sessions

                WHERE restaurant_id = $1
                  AND id = $2::uuid

                FOR UPDATE
                `,
                [
                  rid,
                  id,
                ]
              );

            if (!lockedSession) {
              const err =
                new Error(
                  "Cash-up session no longer exists."
                );

              err.status =
                404;

              err.code =
                "CASHUP_SESSION_NOT_FOUND";

              throw err;
            }

            /*
             * =================================================
             * DETECT ALREADY-CLOSED PAYMENTS
             * =================================================
             *
             * A payment already owned by another cash-up is
             * historical accounting data.
             *
             * Never silently steal/reassign it.
             */
            const alreadyAssigned =
              await tx.qAll(
                `
                SELECT
                  id,
                  cashup_session_id

                FROM public.payments

                WHERE restaurant_id =
                      $1

                  AND created_at >=
                      $2

                  AND created_at <=
                      $3

                  AND cashup_session_id
                      IS NOT NULL

                  AND cashup_session_id <>
                      $4::uuid

                ORDER BY id

                FOR UPDATE
                `,
                [
                  rid,
                  fromISO,
                  toISO,
                  id,
                ]
              );

            if (
              alreadyAssigned.length
            ) {
              const err =
                new Error(
                  "One or more payments in this range already belong to another cash-up."
                );

              err.status =
                409;

              err.code =
                "PAYMENT_ALREADY_CASHED_UP";

              err.detail = {
                payment_ids:
                  alreadyAssigned.map(
                    (row) =>
                      Number(
                        row.id
                      )
                  ),

                cashup_session_ids:
                  Array.from(
                    new Set(
                      alreadyAssigned
                        .map(
                          (row) =>
                            String(
                              row
                                .cashup_session_id ||
                              ""
                            )
                        )
                        .filter(Boolean)
                    )
                  ),
              };

              throw err;
            }

            /*
             * =================================================
             * ATTACH ONLY UNASSIGNED PAYMENTS
             * =================================================
             *
             * Payments already belonging to this exact session
             * are harmless/idempotent and do not need rewriting.
             *
             * Payments belonging to another session were blocked
             * above.
             */
            const update =
              await tx.qRun(
                `
                UPDATE public.payments

                SET
                  cashup_session_id =
                    $1::uuid

                WHERE restaurant_id =
                      $2

                  AND cashup_session_id
                      IS NULL

                  AND created_at >=
                      $3

                  AND created_at <=
                      $4
                `,
                [
                  id,
                  rid,
                  fromISO,
                  toISO,
                ]
              );

            const updated =
              Number(
                update?.rowCount ??
                update?.changes ??
                0
              );

            /*
             * =================================================
             * POST-WRITE INVARIANT
             * =================================================
             */
            const invalidLinks =
              await tx.qAll(
                `
                SELECT
                  p.id,
                  p.restaurant_id,
                  p.cashup_session_id,
                  p.created_at

                FROM public.payments p

                WHERE p.restaurant_id =
                      $1

                  AND p.cashup_session_id =
                      $2::uuid

                  AND (
                    p.created_at <
                      $3

                    OR

                    p.created_at >
                      $4
                  )

                LIMIT 20
                `,
                [
                  rid,
                  id,
                  lockedSession.from_ts,
                  lockedSession.to_ts,
                ]
              );

            if (
              invalidLinks.length
            ) {
              const err =
                new Error(
                  "Cash-up payment range integrity check failed."
                );

              err.status =
                409;

              err.code =
                "CASHUP_PAYMENT_RANGE_INTEGRITY_FAILED";

              throw err;
            }

            return {
              updated,
            };
          }
        );

      return res.json({
        success:
          true,

        updated:
          result.updated,

        cashup_session_id:
          id,

        range: {
          from:
            fromISO,

          to:
            toISO,
        },
      });
    } catch (err) {
      console.error(
        "❌ attach payments failed:",
        err
      );

      const status =
        Number(
          err?.status ||
          500
        );

      return res
        .status(status)
        .json({
          error:
            status >= 500
              ? "Failed to attach payments"
              : err.message,

          ...(err?.code
            ? {
                code:
                  err.code,
              }
            : {}),

          ...(err?.detail
            ? {
                detail:
                  err.detail,
              }
            : {}),
        });
    }
  }
);

module.exports = router;
