// routes/bookingRoutes.js

const express = require("express");
const router = express.Router();

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
  sendBookingStatusEmail,
} = require("../utils/emailService");

// =========================================================
// TRUSTED RESTAURANT RESOLUTION
//
// IMPORTANT:
// Do NOT directly trust x-venue-rid here.
//
// loadMembership is responsible for validating the user's
// selected restaurant membership and setting req.tenantRid.
// =========================================================

function getRid(req) {
  const tenantRid =
    Number(req.tenantRid);

  if (
    Number.isFinite(tenantRid) &&
    tenantRid > 0
  ) {
    return tenantRid;
  }

  const userRid =
    Number(
      req.user?.restaurant_id
    );

  if (
    Number.isFinite(userRid) &&
    userRid > 0
  ) {
    return userRid;
  }

  return null;
}

// =========================================================
// PERMISSION HELPERS
// =========================================================

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
      "You do not have permission to perform this action.",
    code:
      "PERMISSION_DENIED",
    permission,
  });
}

async function withBookingTransaction(
  db,
  fn
) {
  if (
    !db ||
    typeof db.connect !== "function"
  ) {
    throw new Error(
      "PostgreSQL pool required for booking transaction"
    );
  }

  const client =
    await db.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const result =
      await fn(client);

    await client.query(
      "COMMIT"
    );

    return result;
  } catch (err) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    throw err;
  } finally {
    client.release();
  }
}

// =========================================================
// CUSTOMER MEMORY
// =========================================================

async function upsertRestaurantCustomer(
  db,
  rid,
  data
) {
  const phoneClean =
    String(
      data.phone || ""
    ).replace(/\D/g, "");

  if (!phoneClean) {
    return null;
  }

  const fullName =
    String(
      data.customer_name || ""
    ).trim() ||
    `${data.first_name || ""} ${data.last_name || ""}`.trim() ||
    "Guest";

  const out =
    await db.query(
      `
      INSERT INTO public.restaurant_customers
      (
        restaurant_id,
        first_name,
        last_name,
        full_name,
        phone,
        email,
        notes,
        total_bookings,
        last_booking_at
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
        1,
        $8
      )

      ON CONFLICT
      (
        restaurant_id,
        regexp_replace(
          COALESCE(phone, ''),
          '\\D',
          '',
          'g'
        )
      )

      WHERE COALESCE(
        phone,
        ''
      ) <> ''

      DO UPDATE SET

        first_name =
          COALESCE(
            EXCLUDED.first_name,
            public.restaurant_customers.first_name
          ),

        last_name =
          COALESCE(
            EXCLUDED.last_name,
            public.restaurant_customers.last_name
          ),

        full_name =
          COALESCE(
            EXCLUDED.full_name,
            public.restaurant_customers.full_name
          ),

        email =
          COALESCE(
            EXCLUDED.email,
            public.restaurant_customers.email
          ),

        notes =
          COALESCE(
            NULLIF(
              EXCLUDED.notes,
              ''
            ),
            public.restaurant_customers.notes
          ),

        total_bookings =
          public.restaurant_customers.total_bookings + 1,

        last_booking_at =
          EXCLUDED.last_booking_at,

        updated_at =
          NOW()

      RETURNING id
      `,
      [
        rid,
        data.first_name || null,
        data.last_name || null,
        fullName,
        data.phone || null,
        data.email || null,
        data.notes || "",
        data.booking_time,
      ]
    );

  return (
    out.rows?.[0]?.id ||
    null
  );
}

// =========================================================
// GET /bookings
//
// Staff booking visibility.
// =========================================================

router.get(
  "/",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.BOOKINGS_VIEW
  ),
  async (req, res) => {
    try {
      const db = req.db;
      const rid =
        getRid(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      const {
        date,
        from,
        to,
      } = req.query;

      let sql = `
        SELECT
          b.*,

          COALESCE(
            ARRAY_AGG(
              bt.table_id
              ORDER BY bt.table_id
            )
            FILTER (
              WHERE bt.table_id
              IS NOT NULL
            ),
            '{}'::bigint[]
          ) AS table_ids

        FROM bookings b

        LEFT JOIN booking_tables bt
          ON bt.booking_id =
             b.id
         AND bt.restaurant_id =
             b.restaurant_id

        WHERE b.restaurant_id = $1
      `;

      const params = [rid];

      if (date) {
        params.push(date);

        sql += `
          AND b.booking_time::date = $2
        `;
      } else if (
        from &&
        to
      ) {
        params.push(
          from,
          to
        );

        sql += `
          AND b.booking_time
              BETWEEN $2 AND $3
        `;
      }

      sql += `
        GROUP BY b.id

        ORDER BY
          b.booking_time ASC
      `;

      const out =
        await db.query(
          sql,
          params
        );

      return res.json(
        out.rows || []
      );
    } catch (err) {
      console.error(
        "GET /bookings failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to fetch bookings",
      });
    }
  }
);

// =========================================================
// POST /bookings
//
// Staff-created booking / walk-in.
// =========================================================

router.post(
  "/",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.BOOKINGS_CREATE
  ),

  async (req, res) => {
    try {
      const db =
        req.db;

      const rid =
        getRid(req);

      if (!rid) {
        return res
          .status(400)
          .json({
            error:
              "Missing restaurant id",
          });
      }

      const {
        customer_name,
        first_name,
        last_name,
        phone,
        email,
        number_of_people,
        guests,
        booking_time,
        status = "pending",
        slot_min = 90,
        notes = "",
        table_name,
        table_ids = [],
        table_numbers = [],
      } =
        req.body || {};

      const ppl =
        Number(
          number_of_people ??
            guests ??
            0
        );

      if (
        !booking_time ||
        !Number.isFinite(
          ppl
        ) ||
        ppl <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing or invalid required fields",
          });
      }

      const parsedSlot =
        Number(
          slot_min
        );

      if (
        !Number.isFinite(
          parsedSlot
        ) ||
        parsedSlot <= 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid booking slot",
          });
      }

      const bookingDate =
        new Date(
          booking_time
        );

      if (
        Number.isNaN(
          bookingDate.getTime()
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid booking time",
          });
      }

      const safeName =
        String(
          customer_name ||
            ""
        ).trim() ||
        "Walk-in";

      const safePhone =
        phone
          ? String(
              phone
            ).trim()
          : null;

      const safeEmail =
        email
          ? String(
              email
            ).trim()
          : null;

      const safeFirst =
        first_name
          ? String(
              first_name
            ).trim()
          : null;

      const safeLast =
        last_name
          ? String(
              last_name
            ).trim()
          : null;

      let legacyTableName =
        table_name;

      if (
        !legacyTableName &&
        Array.isArray(
          table_numbers
        ) &&
        table_numbers.length
      ) {
        legacyTableName =
          String(
            table_numbers[0]
          );
      }

      const ids =
        [
          ...new Set(
            (
              Array.isArray(
                table_ids
              )
                ? table_ids
                : []
            )
              .map(
                (value) =>
                  Number(
                    value
                  )
              )
              .filter(
                (value) =>
                  Number.isInteger(
                    value
                  ) &&
                  value > 0
              )
          ),
        ];

      /*
       * =====================================================
       * BOOKING ALLOCATION TRANSACTION
       * =====================================================
       *
       * Staff booking creation uses the same restaurant-level
       * advisory lock as public booking and auto-reserve.
       *
       * This serializes table allocation decisions for one
       * restaurant and prevents two simultaneous requests from
       * both seeing the same table as available.
       */
      const result =
        await withBookingTransaction(
          db,
          async (tx) => {
            await tx.query(
              `
              SELECT
                pg_advisory_xact_lock(
                  hashtext(
                    'maks-public-booking'
                  ),
                  $1::integer
                )
              `,
              [
                Number(rid),
              ]
            );

            /*
             * ===============================================
             * VALIDATE TABLE OWNERSHIP INSIDE THE LOCK
             * ===============================================
             */
            if (
              ids.length
            ) {
              const tableCheck =
                await tx.query(
                  `
                  SELECT
                    id
                  FROM public.tables
                  WHERE restaurant_id =
                        $1
                    AND id =
                        ANY(
                          $2::bigint[]
                        )
                  `,
                  [
                    rid,
                    ids,
                  ]
                );

              const validIds =
                new Set(
                  tableCheck.rows.map(
                    (row) =>
                      Number(
                        row.id
                      )
                  )
                );

              const invalidIds =
                ids.filter(
                  (tableId) =>
                    !validIds.has(
                      tableId
                    )
                );

              if (
                invalidIds.length
              ) {
                const err =
                  new Error(
                    `Invalid table id(s): ${invalidIds.join(
                      ", "
                    )}`
                  );

                err.status =
                  400;

                throw err;
              }
            }

            /*
             * ===============================================
             * OVERLAP CHECK
             * ===============================================
             *
             * Existing booking overlaps when:
             *
             * existing_start < requested_end
             * AND
             * existing_end > requested_start
             *
             * cancelled / declined bookings do not consume
             * table availability.
             */
            if (
              ids.length
            ) {
              const collision =
                await tx.query(
                  `
                  SELECT
                    b.id,
                    b.booking_time,
                    b.slot_min,
                    bt.table_id

                  FROM public.bookings b

                  JOIN public.booking_tables bt
                    ON bt.booking_id =
                         b.id
                   AND bt.restaurant_id =
                         b.restaurant_id

                  WHERE
                    b.restaurant_id =
                      $1

                    AND bt.table_id =
                      ANY(
                        $2::bigint[]
                      )

                    AND LOWER(
                          TRIM(
                            COALESCE(
                              b.status,
                              ''
                            )
                          )
                        )
                        NOT IN (
                          'cancelled',
                          'declined'
                        )

                    AND
                      b.booking_time <
                      (
                        $3::timestamptz +
                        (
                          $4::numeric *
                          INTERVAL '1 minute'
                        )
                      )

                    AND
                      (
                        b.booking_time +
                        (
                          COALESCE(
                            b.slot_min,
                            90
                          )::numeric *
                          INTERVAL '1 minute'
                        )
                      )
                      >
                      $3::timestamptz

                  ORDER BY
                    b.booking_time ASC

                  LIMIT 1
                  `,
                  [
                    rid,
                    ids,
                    booking_time,
                    parsedSlot,
                  ]
                );

              if (
                collision.rows.length
              ) {
                const conflict =
                  collision.rows[0];

                const err =
                  new Error(
                    "One or more selected tables are already booked during this time."
                  );

                err.status =
                  409;

                err.code =
                  "BOOKING_TABLE_CONFLICT";

                err.detail = {
                  booking_id:
                    Number(
                      conflict.id
                    ),

                  table_id:
                    Number(
                      conflict.table_id
                    ),
                };

                throw err;
              }
            }

            /*
             * ===============================================
             * CREATE BOOKING
             * ===============================================
             */
            const ins =
              await tx.query(
                `
                INSERT INTO public.bookings
                (
                  customer_name,
                  first_name,
                  last_name,
                  phone,
                  email,
                  booking_time,
                  guests,
                  notes,
                  table_name,
                  status,
                  slot_min,
                  restaurant_id
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
                  $9,
                  $10,
                  $11,
                  $12
                )

                RETURNING id
                `,
                [
                  safeName,
                  safeFirst,
                  safeLast,
                  safePhone,
                  safeEmail,
                  booking_time,
                  ppl,
                  String(
                    notes ||
                      ""
                  ),

                  legacyTableName
                    ? String(
                        legacyTableName
                      )
                    : null,

                  String(
                    status
                  ),

                  parsedSlot,
                  rid,
                ]
              );

            const bookingId =
              Number(
                ins.rows?.[0]
                  ?.id
              );

            if (
              !bookingId
            ) {
              throw new Error(
                "Booking insert returned no id"
              );
            }

            /*
             * ===============================================
             * TABLE ASSIGNMENTS
             * ===============================================
             */
            for (
              const tableId
              of ids
            ) {
              await tx.query(
                `
                INSERT INTO public.booking_tables
                (
                  booking_id,
                  table_id,
                  restaurant_id
                )

                VALUES
                (
                  $1,
                  $2,
                  $3
                )

                ON CONFLICT
                DO NOTHING
                `,
                [
                  bookingId,
                  tableId,
                  rid,
                ]
              );
            }

            return {
              bookingId,
            };
          }
        );

      /*
       * Customer-memory update is useful metadata,
       * but it must not be inside the booking-allocation
       * transaction because booking integrity has already
       * been committed.
       */
      try {
        await upsertRestaurantCustomer(
          db,
          rid,
          {
            customer_name:
              safeName,

            first_name:
              safeFirst,

            last_name:
              safeLast,

            phone:
              safePhone,

            email:
              safeEmail,

            notes:
              String(
                notes ||
                  ""
              ),

            booking_time,
          }
        );
      } catch (
        customerErr
      ) {
        console.error(
          "Booking customer memory failed:",
          customerErr
        );
      }

      return res
        .status(201)
        .json({
          success:
            true,

          id:
            result.bookingId,
        });
    } catch (err) {
      console.error(
        "POST /bookings failed:",
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
              ? "Failed to create booking"
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

// =========================================================
// GET /bookings/customer-search
//
// Customer data is private restaurant data.
// =========================================================

router.get(
  "/customer-search",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.BOOKINGS_VIEW
  ),
  async (req, res) => {
    try {
      const db = req.db;
      const rid =
        getRid(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      const rawPhone =
        String(
          req.query.phone ||
          ""
        );

      const phoneClean =
        rawPhone.replace(
          /\D/g,
          ""
        );

      if (!phoneClean) {
        return res.json({
          customer: null,
        });
      }

      const out =
        await db.query(
          `
          SELECT
            id,
            full_name,
            first_name,
            last_name,
            phone,
            email,
            notes,
            total_bookings,
            last_booking_at,
            booking_email_opt_in,
            marketing_email_opt_in,
            created_at

          FROM public.restaurant_customers

          WHERE restaurant_id = $1

            AND regexp_replace(
              COALESCE(
                phone,
                ''
              ),
              '\\D',
              '',
              'g'
            ) = $2

          LIMIT 1
          `,
          [
            rid,
            phoneClean,
          ]
        );

      return res.json({
        customer:
          out.rows?.[0] ||
          null,
      });
    } catch (err) {
      console.error(
        "GET /bookings/customer-search failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to search customer",
      });
    }
  }
);

// =========================================================
// GET /bookings/customers
// =========================================================

router.get(
  "/customers",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.BOOKINGS_VIEW
  ),
  async (req, res) => {
    try {
      const db = req.db;
      const rid =
        getRid(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      const out =
        await db.query(
          `
          SELECT
            id,
            full_name,
            first_name,
            last_name,
            phone,
            email,
            notes,
            total_bookings,
            last_booking_at,
            booking_email_opt_in,
            marketing_email_opt_in,
            created_at

          FROM public.restaurant_customers

          WHERE restaurant_id = $1

          ORDER BY
            COALESCE(
              total_bookings,
              0
            ) DESC,

            COALESCE(
              last_booking_at,
              created_at
            ) DESC
          `,
          [rid]
        );

      return res.json({
        customers:
          out.rows || [],
      });
    } catch (err) {
      console.error(
        "GET /bookings/customers failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to load customers",
      });
    }
  }
);

// =========================================================
// PUT /bookings/:id/approve-change
// =========================================================

router.put(
  "/:id/approve-change",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.BOOKINGS_EDIT
  ),
  async (req, res) => {
    try {
      const db = req.db;
      const rid =
        getRid(req);

      const id =
        Number(
          req.params.id
        );

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid booking id",
        });
      }

      const current =
        await db.query(
          `
          SELECT
            b.*,
            r.name
              AS restaurant_name

          FROM public.bookings b

          JOIN public.restaurants r
            ON r.id =
               b.restaurant_id

          WHERE b.restaurant_id = $1
            AND b.id = $2

          LIMIT 1
          `,
          [
            rid,
            id,
          ]
        );

      const booking =
        current.rows?.[0];

      if (!booking) {
        return res.status(404).json({
          error:
            "Booking not found",
        });
      }

      const newTime =
        booking.requested_booking_time ||
        booking.booking_time;

      const newGuests =
        booking.requested_guests ||
        booking.guests;

      await db.query(
        `
        UPDATE public.bookings

        SET
          booking_time = $1,
          guests = $2,
          status = 'confirmed',
          change_requested_at = NULL,
          requested_booking_time = NULL,
          requested_guests = NULL,
          requested_note = NULL

        WHERE restaurant_id = $3
          AND id = $4
        `,
        [
          newTime,
          newGuests,
          rid,
          id,
        ]
      );

      try {
        if (
          booking.email
        ) {
          const manageUrl =
            `${
              process.env.PUBLIC_APP_URL ||
              "https://maksos.co.uk"
            }` +
            `/manage-booking?token=${booking.public_token}`;

          await sendBookingStatusEmail({
            email:
              booking.email,

            restaurantName:
              booking.restaurant_name ||
              "Restaurant",

            customerName:
              booking.customer_name ||
              "Guest",

            bookingTime:
              newTime,

            guests:
              newGuests,

            reference:
              booking.id,

            status:
              "updated",

            manageUrl,
          });
        }
      } catch (emailErr) {
        console.error(
          "Approve change email failed:",
          emailErr
        );
      }

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "PUT /bookings/:id/approve-change failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to approve change",
      });
    }
  }
);

// =========================================================
// PUT /bookings/:id/decline-change
// =========================================================

router.put(
  "/:id/decline-change",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.BOOKINGS_EDIT
  ),
  async (req, res) => {
    try {
      const db = req.db;
      const rid =
        getRid(req);

      const id =
        Number(
          req.params.id
        );

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid booking id",
        });
      }

      const result =
        await db.query(
          `
          UPDATE public.bookings

          SET
            change_requested_at = NULL,
            requested_booking_time = NULL,
            requested_guests = NULL,
            requested_note = NULL

          WHERE restaurant_id = $1
            AND id = $2
          `,
          [
            rid,
            id,
          ]
        );

      if (
        !result.rowCount
      ) {
        return res.status(404).json({
          error:
            "Booking not found",
        });
      }

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "PUT /bookings/:id/decline-change failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to decline change",
      });
    }
  }
);

// =========================================================
// PUT /bookings/:id
//
// Mixed operation:
//
// Normal booking edits
//   → BOOKINGS_EDIT
//
// Setting status to cancelled
//   → BOOKINGS_CANCEL
//
// This distinction is made SERVER-SIDE.
// =========================================================

router.put(
  "/:id",
  authenticateToken,
  loadMembership,
  async (req, res) => {
    try {
      const db = req.db;
      const rid =
        getRid(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      const id =
        Number(
          req.params.id
        );

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid booking id",
        });
      }

      const body =
        req.body || {};

      const suppliedFields =
        Object.keys(body);

      if (
        !suppliedFields.length
      ) {
        return res.status(400).json({
          error:
            "No fields to update",
        });
      }

      const requestedStatus =
        body.status !== undefined
          ? String(
              body.status
            )
              .trim()
              .toLowerCase()
          : null;

      const cancelling =
        requestedStatus ===
        "cancelled";

      const otherEditFields =
        suppliedFields.filter(
          (field) =>
            field !== "status"
        );

      // Cancellation requires explicit cancel authority.
      if (
        cancelling &&
        !can(
          req,
          PERMISSIONS.BOOKINGS_CANCEL
        )
      ) {
        return deny(
          res,
          PERMISSIONS.BOOKINGS_CANCEL
        );
      }

      // A non-cancel status change is an edit.
      if (
        requestedStatus &&
        !cancelling &&
        !can(
          req,
          PERMISSIONS.BOOKINGS_EDIT
        )
      ) {
        return deny(
          res,
          PERMISSIONS.BOOKINGS_EDIT
        );
      }

      // Other field edits require BOOKINGS_EDIT.
      if (
        otherEditFields.length &&
        !can(
          req,
          PERMISSIONS.BOOKINGS_EDIT
        )
      ) {
        return deny(
          res,
          PERMISSIONS.BOOKINGS_EDIT
        );
      }

      const allowedFields =
        new Set([
          "status",
          "booking_time",
          "phone",
          "email",
          "first_name",
          "last_name",
          "customer_name",
          "slot_min",
          "notes",
          "guests",
          "number_of_people",
          "table_name",
        ]);

      const unknownFields =
        suppliedFields.filter(
          (field) =>
            !allowedFields.has(
              field
            )
        );

      if (
        unknownFields.length
      ) {
        return res.status(400).json({
          error:
            "Unsupported booking field(s)",
          fields:
            unknownFields,
        });
      }

      const sets = [];
      const params = [];

      const add = (
        column,
        value
      ) => {
        params.push(value);

        sets.push(
          `${column} = $${params.length}`
        );
      };

      if (
        body.status !==
        undefined
      ) {
        add(
          "status",
          String(
            body.status
          )
        );
      }

      if (
        body.booking_time !==
        undefined
      ) {
        add(
          "booking_time",
          body.booking_time
        );
      }

      if (
        body.phone !==
        undefined
      ) {
        add(
          "phone",
          body.phone
            ? String(
                body.phone
              )
            : null
        );
      }

      if (
        body.email !==
        undefined
      ) {
        add(
          "email",
          body.email
            ? String(
                body.email
              )
            : null
        );
      }

      if (
        body.first_name !==
        undefined
      ) {
        add(
          "first_name",
          body.first_name
            ? String(
                body.first_name
              )
            : null
        );
      }

      if (
        body.last_name !==
        undefined
      ) {
        add(
          "last_name",
          body.last_name
            ? String(
                body.last_name
              )
            : null
        );
      }

      if (
        body.customer_name !==
        undefined
      ) {
        add(
          "customer_name",
          String(
            body.customer_name
          )
        );
      }

      if (
        body.slot_min !==
        undefined
      ) {
        const slot =
          Number(
            body.slot_min
          );

        if (
          !Number.isFinite(
            slot
          ) ||
          slot <= 0
        ) {
          return res.status(400).json({
            error:
              "Invalid slot duration",
          });
        }

        add(
          "slot_min",
          slot
        );
      }

      if (
        body.notes !==
        undefined
      ) {
        add(
          "notes",
          String(
            body.notes || ""
          )
        );
      }

      if (
        body.guests !==
          undefined ||
        body.number_of_people !==
          undefined
      ) {
        const guests =
          Number(
            body.number_of_people ??
            body.guests
          );

        if (
          !Number.isFinite(
            guests
          ) ||
          guests <= 0
        ) {
          return res.status(400).json({
            error:
              "Invalid guest count",
          });
        }

        add(
          "guests",
          guests
        );
      }

      if (
        body.table_name !==
        undefined
      ) {
        add(
          "table_name",
          body.table_name
            ? String(
                body.table_name
              )
            : null
        );
      }

      if (!sets.length) {
        return res.status(400).json({
          error:
            "No fields to update",
        });
      }

      let existingBooking =
  null;

/*
 * =====================================================
 * BOOKING EDIT ALLOCATION TRANSACTION
 * =====================================================
 *
 * Booking edits participate in the exact same
 * restaurant-level allocation lock as:
 *
 * - staff booking creation
 * - public booking creation
 * - booking auto-reserve
 *
 * A booking therefore cannot be moved into a slot that
 * another concurrent request has just taken.
 */
const editResult =
  await withBookingTransaction(
    db,

    async (tx) => {
      await tx.query(
        `
        SELECT
          pg_advisory_xact_lock(
            hashtext(
              'maks-public-booking'
            ),
            $1::integer
          )
        `,
        [
          Number(rid),
        ]
      );

      /*
       * Lock and reload the booking.
       *
       * We need the existing booking_time, slot_min,
       * status and contact information because an edit
       * may contain only one changed field.
       */
      const current =
        await tx.query(
          `
          SELECT
            b.*,
            r.name
              AS restaurant_name

          FROM public.bookings b

          JOIN public.restaurants r
            ON r.id =
                 b.restaurant_id

          WHERE b.restaurant_id = $1
            AND b.id = $2

          LIMIT 1

          FOR UPDATE OF b
          `,
          [
            rid,
            id,
          ]
        );

      existingBooking =
        current.rows?.[0] ||
        null;

      if (
        !existingBooking
      ) {
        const err =
          new Error(
            "Booking not found"
          );

        err.status = 404;

        throw err;
      }

      /*
       * Work out what the booking WOULD look like
       * after this edit.
       */
      const effectiveTime =
        body.booking_time !==
        undefined
          ? body.booking_time
          : existingBooking
              .booking_time;

      const effectiveSlot =
        body.slot_min !==
        undefined
          ? Number(
              body.slot_min
            )
          : Number(
              existingBooking
                .slot_min ||
              90
            );

      const effectiveStatus =
        body.status !==
        undefined
          ? String(
              body.status
            )
              .trim()
              .toLowerCase()
          : String(
              existingBooking
                .status ||
              ""
            )
              .trim()
              .toLowerCase();

      if (
        !effectiveTime ||
        Number.isNaN(
          new Date(
            effectiveTime
          ).getTime()
        )
      ) {
        const err =
          new Error(
            "Invalid booking time"
          );

        err.status = 400;

        throw err;
      }

      if (
        !Number.isFinite(
          effectiveSlot
        ) ||
        effectiveSlot <= 0
      ) {
        const err =
          new Error(
            "Invalid slot duration"
          );

        err.status = 400;

        throw err;
      }

      /*
       * Load the tables that THIS booking actually owns.
       *
       * We never trust table IDs from the edit request.
       */
      const assigned =
        await tx.query(
          `
          SELECT
            bt.table_id

          FROM public.booking_tables bt

          WHERE bt.restaurant_id = $1
            AND bt.booking_id = $2

          ORDER BY
            bt.table_id
          `,
          [
            rid,
            id,
          ]
        );

      const assignedTableIds =
        assigned.rows
          .map(
            (row) =>
              Number(
                row.table_id
              )
          )
          .filter(
            (tableId) =>
              Number.isInteger(
                tableId
              ) &&
              tableId > 0
          );

      /*
       * Cancelled / declined bookings don't consume
       * table availability.
       *
       * Any active booking with tables must remain
       * collision-free after a time/slot/status edit.
       */
      const consumesAvailability =
        ![
          "cancelled",
          "declined",
        ].includes(
          effectiveStatus
        );

      if (
        consumesAvailability &&
        assignedTableIds.length
      ) {
        const collision =
          await tx.query(
            `
            SELECT
              b.id,
              b.booking_time,
              b.slot_min,
              bt.table_id

            FROM public.bookings b

            JOIN public.booking_tables bt
              ON bt.booking_id =
                   b.id

             AND bt.restaurant_id =
                   b.restaurant_id

            WHERE
              b.restaurant_id =
                $1

              /*
               * Never collide with ourselves.
               */
              AND b.id <> $2

              AND bt.table_id =
                ANY(
                  $3::bigint[]
                )

              AND LOWER(
                    TRIM(
                      COALESCE(
                        b.status,
                        ''
                      )
                    )
                  )
                  NOT IN (
                    'cancelled',
                    'declined'
                  )

              /*
               * Standard interval overlap:
               *
               * existing_start < new_end
               * AND existing_end > new_start
               */
              AND
                b.booking_time <
                (
                  $4::timestamptz +
                  (
                    $5::numeric *
                    INTERVAL '1 minute'
                  )
                )

              AND
                (
                  b.booking_time +
                  (
                    COALESCE(
                      b.slot_min,
                      90
                    )::numeric *
                    INTERVAL '1 minute'
                  )
                )
                >
                $4::timestamptz

            ORDER BY
              b.booking_time ASC

            LIMIT 1
            `,
            [
              rid,
              id,
              assignedTableIds,
              effectiveTime,
              effectiveSlot,
            ]
          );

        if (
          collision.rows.length
        ) {
          const conflict =
            collision.rows[0];

          const err =
            new Error(
              "One or more selected tables are already booked during this time."
            );

          err.status = 409;

          err.code =
            "BOOKING_TABLE_CONFLICT";

          err.detail = {
            booking_id:
              Number(
                conflict.id
              ),

            table_id:
              Number(
                conflict.table_id
              ),
          };

          throw err;
        }
      }

      /*
       * =================================================
       * APPLY THE ORIGINAL EDIT
       * =================================================
       *
       * sets[] and params[] were already built from the
       * server-side allow-list above.
       */
      const updateParams =
        [
          ...params,
          rid,
          id,
        ];

      const ridIndex =
        updateParams.length -
        1;

      const idIndex =
        updateParams.length;

      const result =
        await tx.query(
          `
          UPDATE public.bookings

          SET ${sets.join(", ")}

          WHERE restaurant_id =
                $${ridIndex}

            AND id =
                $${idIndex}
          `,
          updateParams
        );

      if (
        !result.rowCount
      ) {
        const err =
          new Error(
            "Booking not found"
          );

        err.status = 404;

        throw err;
      }

      return result;
    }
  );

const result =
  editResult;

      try {
        if (
          existingBooking &&
          existingBooking.email &&
          body.status &&
          [
            "confirmed",
            "declined",
          ].includes(
            String(
              body.status
            ).toLowerCase()
          )
        ) {
          const manageUrl =
            `${
              process.env.PUBLIC_APP_URL ||
              "https://maksos.co.uk"
            }` +
            `/manage-booking?token=${existingBooking.public_token}`;

          await sendBookingStatusEmail({
            email:
              existingBooking.email,

            restaurantName:
              existingBooking.restaurant_name ||
              "Restaurant",

            customerName:
              existingBooking.customer_name ||
              "Guest",

            bookingTime:
              body.booking_time ||
              existingBooking.booking_time,

            guests:
              body.number_of_people ??
              body.guests ??
              existingBooking.guests,

            reference:
              existingBooking.id,

            status:
              String(
                body.status
              ).toLowerCase(),

            manageUrl,
          });
        }
      } catch (emailErr) {
        console.error(
          "Booking status email failed:",
          emailErr
        );
      }

      return res.json({
        success: true,
        changes:
          result.rowCount,
      });
    } catch (err) {
  console.error(
    "PUT /bookings/:id failed:",
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
          ? "Failed to update booking"
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

// =========================================================
// DELETE /bookings/:id
//
// Permanent deletion is separate from cancellation.
// =========================================================

router.delete(
  "/:id",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.BOOKINGS_DELETE
  ),
  async (req, res) => {
    try {
      const db = req.db;
      const rid =
        getRid(req);

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      const id =
        Number(
          req.params.id
        );

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid booking id",
        });
      }

      const tableResult =
        await db.query(
          `
          SELECT table_id
          FROM public.booking_tables
          WHERE restaurant_id = $1
            AND booking_id = $2
          `,
          [
            rid,
            id,
          ]
        );

      const tableIds =
        tableResult.rows
          .map(
            (row) =>
              Number(
                row.table_id
              )
          )
          .filter(Boolean);

      await db.query(
        `
        DELETE FROM public.booking_tables
        WHERE restaurant_id = $1
          AND booking_id = $2
        `,
        [
          rid,
          id,
        ]
      );

      const result =
        await db.query(
          `
          DELETE FROM public.bookings
          WHERE restaurant_id = $1
            AND id = $2
          `,
          [
            rid,
            id,
          ]
        );

      if (
        !result.rowCount
      ) {
        return res.status(404).json({
          error:
            "Booking not found",
        });
      }

      if (
        tableIds.length
      ) {
        // Do NOT free occupied tables.
        await db.query(
          `
          UPDATE public.tables

          SET status = 'free'

          WHERE restaurant_id = $1

            AND id =
                ANY(
                  $2::bigint[]
                )

            AND COALESCE(
              NULLIF(
                TRIM(status),
                ''
              ),
              'free'
            ) = 'reserved'
          `,
          [
            rid,
            tableIds,
          ]
        );

        // Keep table_map aligned too.
        await db.query(
          `
          UPDATE public.table_map

          SET status = 'free'

          WHERE restaurant_id = $1

            AND id =
                ANY(
                  $2::bigint[]
                )

            AND COALESCE(
              NULLIF(
                TRIM(status),
                ''
              ),
              'free'
            ) = 'reserved'
          `,
          [
            rid,
            tableIds,
          ]
        );
      }

      return res.json({
        success: true,
        changes:
          result.rowCount,
      });
    } catch (err) {
      console.error(
        "DELETE /bookings/:id failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to delete booking",
      });
    }
  }
);

// =========================================================
// POST /bookings/tables/:id/status
//
// Table operational status is controlled by TABLES_STATUS.
// =========================================================

router.post(
  "/tables/:id/status",
  authenticateToken,
  loadMembership,
  requirePermission(
    PERMISSIONS.TABLES_STATUS
  ),
  async (req, res) => {
    try {
      const db = req.db;
      const rid =
        getRid(req);

      const id =
        Number(
          req.params.id
        );

      const status =
        String(
          req.body?.status ||
          ""
        )
          .trim()
          .toLowerCase();

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid table id",
        });
      }

      if (
        ![
          "free",
          "reserved",
          "occupied",
        ].includes(
          status
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid status",
        });
      }

      const result =
        await db.query(
          `
          UPDATE public.tables

          SET status = $1

          WHERE restaurant_id = $2
            AND id = $3
          `,
          [
            status,
            rid,
            id,
          ]
        );

      if (
        !result.rowCount
      ) {
        return res.status(404).json({
          error:
            "Table not found",
        });
      }

      // Keep table_map status aligned when ids correspond.
      await db.query(
        `
        UPDATE public.table_map

        SET status = $1

        WHERE restaurant_id = $2
          AND id = $3
        `,
        [
          status,
          rid,
          id,
        ]
      );

      return res.json({
        success: true,
        changes:
          result.rowCount,
      });
    } catch (err) {
      console.error(
        "POST /bookings/tables/:id/status failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to update table status",
      });
    }
  }
);

module.exports = router;