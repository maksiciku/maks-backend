// routes/publicBookingRoutes.js

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const {
  sendBookingConfirmationEmail,
  sendBookingChangeRequestEmail,
} = require("../utils/emailService");

const DEFAULT_SLOT_MIN = 120;

const MAX_GUESTS = 100;
const MIN_SLOT_MIN = 30;
const MAX_SLOT_MIN = 480;

const MAX_NAME_LEN = 160;
const MAX_PHONE_LEN = 50;
const MAX_EMAIL_LEN = 254;
const MAX_NOTES_LEN = 2000;
const MAX_AREA_LEN = 120;

const TOKEN_RE = /^[a-f0-9]{64}$/i;

// =========================================================
// PUBLIC RESTAURANT RESOLUTION
//
// Public routes legitimately receive a restaurant id from
// the customer-facing page.
//
// Every database operation still scopes itself explicitly
// to that restaurant.
// =========================================================

function getRidPublic(req) {
  const h = Number(
    req.headers["x-venue-rid"]
  );

  if (
    Number.isFinite(h) &&
    h > 0
  ) {
    return h;
  }

  const q = Number(
    req.query.restaurant_id
  );

  if (
    Number.isFinite(q) &&
    q > 0
  ) {
    return q;
  }

  const b = Number(
    req.body?.restaurant_id
  );

  if (
    Number.isFinite(b) &&
    b > 0
  ) {
    return b;
  }

  return null;
}

// =========================================================
// HELPERS
// =========================================================

function addMin(
  value,
  min
) {
  return new Date(
    new Date(value).getTime() +
      Number(min) * 60000
  );
}

function cleanText(
  value,
  maxLength
) {
  return String(
    value || ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );
}

function validEmail(
  value
) {
  const email =
    cleanText(
      value,
      MAX_EMAIL_LEN
    );

  if (!email) {
    return true;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );
}

function validToken(
  value
) {
  return TOKEN_RE.test(
    String(
      value || ""
    ).trim()
  );
}

/**
 * req.db appears to be a pg Pool in MAKS.
 *
 * This helper also works if a pg Client is supplied directly.
 */
async function getTransactionClient(
  db
) {
  if (
    db &&
    typeof db.connect ===
      "function"
  ) {
    const client =
      await db.connect();

    return {
      client,

      release: () => {
        if (
          typeof client.release ===
          "function"
        ) {
          client.release();
        }
      },
    };
  }

  return {
    client: db,
    release: () => {},
  };
}

// =========================================================
// RESTAURANT CHECK
// =========================================================

async function getRestaurant(
  db,
  rid
) {
  const result =
    await db.query(
      `
      SELECT
        id,
        name,
        owner_email,
        account_status
      FROM public.restaurants
      WHERE id = $1
      LIMIT 1
      `,
      [rid]
    );

  return (
    result.rows?.[0] ||
    null
  );
}

// =========================================================
// TABLE ASSIGNMENT
//
// IMPORTANT:
//
// This function should be called while the booking creation
// transaction holds the restaurant booking advisory lock.
// =========================================================

async function autoAssignTables(
  db,
  rid,
  guests,
  bookingTime,
  slotMin,
  area
) {
  const start =
    new Date(
      bookingTime
    );

  const end =
    addMin(
      start,
      slotMin
    );

  const startIso =
    start.toISOString();

  const endIso =
    end.toISOString();

  // -------------------------------------------------------
  // Find tables already allocated to overlapping bookings.
  // -------------------------------------------------------

  const blocked =
    await db.query(
      `
      SELECT DISTINCT
        bt.table_id

      FROM public.bookings b

      JOIN public.booking_tables bt
        ON bt.booking_id =
           b.id

       AND bt.restaurant_id =
           b.restaurant_id

      WHERE b.restaurant_id = $1

        AND LOWER(
          COALESCE(
            b.status,
            'pending'
          )
        ) <> 'cancelled'

        AND b.booking_time <
            $3::timestamptz

        AND (
          b.booking_time +
          make_interval(
            mins =>
              COALESCE(
                b.slot_min,
                $4
              )
          )
        ) >
          $2::timestamptz
      `,
      [
        rid,
        startIso,
        endIso,
        Number(slotMin),
      ]
    );

  const blockedIds =
    new Set(
      (blocked.rows || [])
        .map(
          (row) =>
            String(
              row.table_id
            )
        )
    );

  // -------------------------------------------------------
  // Load this restaurant's tables.
  // -------------------------------------------------------

  const tables =
    await db.query(
      `
      SELECT
        t.id,

        COALESCE(
          tm.seats,
          t.seats,
          2
        ) AS seats,

        COALESCE(
          NULLIF(
            TRIM(
              tm.status
            ),
            ''
          ),
          t.status,
          'free'
        ) AS status,

        COALESCE(
          NULLIF(
            TRIM(
              tm.zone
            ),
            ''
          ),
          'Main'
        ) AS zone

      FROM public.tables t

      LEFT JOIN public.table_map tm
        ON tm.restaurant_id =
           t.restaurant_id

       AND LOWER(
         TRIM(tm.name)
       ) =
       LOWER(
         TRIM(t.name)
       )

      WHERE t.restaurant_id = $1

      ORDER BY
        COALESCE(
          tm.seats,
          t.seats,
          2
        ) ASC,

        t.id ASC
      `,
      [rid]
    );

  const wantedArea =
    cleanText(
      area,
      MAX_AREA_LEN
    );

  const pool =
    (tables.rows || [])
      .filter(
        (row) =>
          !blockedIds.has(
            String(row.id)
          )
      )

      .filter(
        (row) =>
          String(
            row.status ||
            "free"
          )
            .trim()
            .toLowerCase() !==
          "occupied"
      )

      .filter((row) => {
        if (
          !wantedArea ||
          wantedArea.toLowerCase() ===
            "all"
        ) {
          return true;
        }

        return (
          String(
            row.zone || ""
          )
            .trim()
            .toLowerCase() ===
          wantedArea.toLowerCase()
        );
      })

      .map((row) => ({
        id:
          Number(row.id),

        seats:
          Number(
            row.seats || 0
          ),
      }))

      .filter(
        (row) =>
          row.id > 0 &&
          row.seats > 0
      );

  if (!pool.length) {
    return [];
  }

  // -------------------------------------------------------
  // Best-fit table combination.
  // -------------------------------------------------------

  let best = null;

  const arr =
    pool.slice(
      0,
      Math.min(
        pool.length,
        18
      )
    );

  const trySet = (
    picked
  ) => {
    const seats =
      picked.reduce(
        (
          sum,
          table
        ) =>
          sum +
          table.seats,
        0
      );

    if (
      seats <
      guests
    ) {
      return;
    }

    const candidate = {
      ids:
        picked.map(
          (table) =>
            table.id
        ),

      waste:
        seats -
        guests,

      count:
        picked.length,
    };

    if (
      !best ||
      candidate.waste <
        best.waste ||
      (
        candidate.waste ===
          best.waste &&
        candidate.count <
          best.count
      )
    ) {
      best =
        candidate;
    }
  };

  // Greedy candidate.
  let sum = 0;
  const greedy = [];

  for (
    const table of arr
  ) {
    if (
      sum >=
      guests
    ) {
      break;
    }

    greedy.push(
      table
    );

    sum +=
      table.seats;
  }

  trySet(
    greedy
  );

  const suffix =
    Array(
      arr.length + 1
    ).fill(0);

  for (
    let i =
      arr.length - 1;
    i >= 0;
    i--
  ) {
    suffix[i] =
      suffix[i + 1] +
      arr[i].seats;
  }

  let explored = 0;

  const MAX_STATES =
    80000;

  const dfs = (
    index,
    picked,
    seatSum
  ) => {
    if (
      explored++ >
      MAX_STATES
    ) {
      return;
    }

    if (
      seatSum >=
      guests
    ) {
      return trySet(
        picked
      );
    }

    if (
      index >=
      arr.length
    ) {
      return;
    }

    if (
      seatSum +
        suffix[index] <
      guests
    ) {
      return;
    }

    if (
      best &&
      best.waste ===
        0 &&
      best.count <=
        2
    ) {
      return;
    }

    dfs(
      index + 1,
      picked,
      seatSum
    );

    picked.push(
      arr[index]
    );

    dfs(
      index + 1,
      picked,
      seatSum +
        arr[index].seats
    );

    picked.pop();
  };

  dfs(
    0,
    [],
    0
  );

  return (
    best?.ids ||
    []
  );
}

// =========================================================
// GET /public/restaurant-info
// =========================================================

router.get(
  "/restaurant-info",
  async (req, res) => {
    try {
      const db =
        req.db;

      const rid =
        Number(
          req.query
            .restaurant_id
        );

      if (!rid) {
        return res.status(400).json({
          error:
            "restaurant_id required",
        });
      }

      const result =
        await db.query(
          `
          SELECT
            id,
            name,
            NULL AS logo_url

          FROM public.restaurants

          WHERE id = $1

          LIMIT 1
          `,
          [rid]
        );

      if (
        !result.rows.length
      ) {
        return res.status(404).json({
          error:
            "Restaurant not found",
        });
      }

      return res.json(
        result.rows[0]
      );
    } catch (err) {
      console.error(
        "GET /public/restaurant-info error:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to load restaurant info",
      });
    }
  }
);

// =========================================================
// GET /public/bookings/:token
//
// Token possession is the customer's booking credential.
// Never expose another booking without its token.
// =========================================================

router.get(
  "/bookings/:token",
  async (req, res) => {
    try {
      const db =
        req.db;

      const token =
        String(
          req.params.token ||
          ""
        ).trim();

      if (
        !validToken(
          token
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid booking token",
        });
      }

      const result =
        await db.query(
          `
          SELECT
            b.id,
            b.customer_name,
            b.phone,
            b.email,
            b.booking_time,
            b.guests,
            b.notes,
            b.status,
            b.table_name,
            b.restaurant_id,

            b.change_requested_at,
            b.requested_booking_time,
            b.requested_guests,
            b.requested_note,

            r.name
              AS restaurant_name

          FROM public.bookings b

          JOIN public.restaurants r
            ON r.id =
               b.restaurant_id

          WHERE b.public_token = $1

          LIMIT 1
          `,
          [token]
        );

      if (
        !result.rows.length
      ) {
        return res.status(404).json({
          error:
            "Booking not found",
        });
      }

      return res.json({
        booking:
          result.rows[0],
      });
    } catch (err) {
      console.error(
        "GET /public/bookings/:token failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to load booking",
      });
    }
  }
);

// =========================================================
// PUT /public/bookings/:token/cancel
//
// Customer cancellation.
//
// Frees booking reservations where the table is still
// RESERVED, but never overwrites OCCUPIED.
// =========================================================

router.put(
  "/bookings/:token/cancel",
  async (req, res) => {
    const db =
      req.db;

    const token =
      String(
        req.params.token ||
        ""
      ).trim();

    if (
      !validToken(
        token
      )
    ) {
      return res.status(400).json({
        error:
          "Invalid booking token",
      });
    }

    let tx;

    try {
      tx =
        await getTransactionClient(
          db
        );

      const client =
        tx.client;

      await client.query(
        "BEGIN"
      );

      const current =
        await client.query(
          `
          SELECT
            id,
            restaurant_id,
            status

          FROM public.bookings

          WHERE public_token = $1

          FOR UPDATE
          `,
          [token]
        );

      const booking =
        current.rows?.[0];

      if (!booking) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          error:
            "Booking not found",
        });
      }

      if (
        String(
          booking.status ||
          ""
        )
          .trim()
          .toLowerCase() ===
        "cancelled"
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({
          error:
            "Booking already cancelled",
        });
      }

      const tableRows =
        await client.query(
          `
          SELECT table_id
          FROM public.booking_tables
          WHERE restaurant_id = $1
            AND booking_id = $2
          `,
          [
            booking.restaurant_id,
            booking.id,
          ]
        );

      const tableIds =
        (tableRows.rows || [])
          .map(
            (row) =>
              Number(
                row.table_id
              )
          )
          .filter(Boolean);

      await client.query(
        `
        UPDATE public.bookings

        SET
          status =
            'cancelled',

          customer_cancelled_at =
            NOW()

        WHERE id = $1
          AND restaurant_id = $2
        `,
        [
          booking.id,
          booking.restaurant_id,
        ]
      );

      if (
        tableIds.length
      ) {
        await client.query(
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
            ) =
              'reserved'
          `,
          [
            booking.restaurant_id,
            tableIds,
          ]
        );

        await client.query(
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
            ) =
              'reserved'
          `,
          [
            booking.restaurant_id,
            tableIds,
          ]
        );
      }

      await client.query(
        "COMMIT"
      );

      return res.json({
        success: true,
      });
    } catch (err) {
      try {
        if (
          tx?.client
        ) {
          await tx.client.query(
            "ROLLBACK"
          );
        }
      } catch {}

      console.error(
        "PUT /public/bookings/:token/cancel failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to cancel booking",
      });
    } finally {
      tx?.release?.();
    }
  }
);

// =========================================================
// POST /public/bookings
//
// PUBLIC CUSTOMER BOOKING
//
// Uses:
//
// transaction
// +
// PostgreSQL advisory transaction lock
//
// so simultaneous public bookings for the same restaurant
// cannot both allocate from the same availability snapshot.
// =========================================================

router.post(
  "/bookings",
  async (req, res) => {
    const db =
      req.db;

    const rid =
      getRidPublic(
        req
      );

    if (!rid) {
      return res.status(400).json({
        error:
          "Missing restaurant id",
      });
    }

    const body =
      req.body || {};

    const customerName =
      cleanText(
        body.customer_name,
        MAX_NAME_LEN
      );

    const contactPhone =
      cleanText(
        body.phone,
        MAX_PHONE_LEN
      );

    const contactEmail =
      cleanText(
        body.email,
        MAX_EMAIL_LEN
      );

    const notes =
      cleanText(
        body.notes,
        MAX_NOTES_LEN
      );

    const area =
      cleanText(
        body.area ||
        "All",
        MAX_AREA_LEN
      );

    const ppl =
      Number(
        body.guests ??
        body.number_of_people ??
        0
      );

    const slot =
      Number(
        body.slot_min ??
        DEFAULT_SLOT_MIN
      );

    const bookingEmailOptIn =
      body.booking_email_opt_in !==
      false;

    const marketingEmailOptIn =
      Boolean(
        body.marketing_email_opt_in
      );

    if (
      !customerName
    ) {
      return res.status(400).json({
        error:
          "Customer name required",
      });
    }

    if (
      !contactPhone &&
      !contactEmail
    ) {
      return res.status(400).json({
        error:
          "Phone or email required",
      });
    }

    if (
      !validEmail(
        contactEmail
      )
    ) {
      return res.status(400).json({
        error:
          "Invalid email address",
      });
    }

    if (
      !Number.isInteger(
        ppl
      ) ||
      ppl < 1 ||
      ppl > MAX_GUESTS
    ) {
      return res.status(400).json({
        error:
          "Invalid guest count",
      });
    }

    if (
      !Number.isInteger(
        slot
      ) ||
      slot <
        MIN_SLOT_MIN ||
      slot >
        MAX_SLOT_MIN
    ) {
      return res.status(400).json({
        error:
          "Invalid booking duration",
      });
    }

    const bookingDate =
      new Date(
        body.booking_time
      );

    if (
      !body.booking_time ||
      Number.isNaN(
        bookingDate.getTime()
      )
    ) {
      return res.status(400).json({
        error:
          "Invalid booking time",
      });
    }

    // Do not accept clearly historical bookings from the
    // public customer route.
    if (
      bookingDate.getTime() <
      Date.now() -
        5 * 60 * 1000
    ) {
      return res.status(400).json({
        error:
          "Booking time has already passed",
      });
    }

    let tx;

    let bookingId;
    let tableIds = [];
    let publicToken;
    let bookingStatus;
    let restaurant;

    try {
      tx =
        await getTransactionClient(
          db
        );

      const client =
        tx.client;

      await client.query(
        "BEGIN"
      );

      // -----------------------------------------------------
      // SERIALISE PUBLIC BOOKING ALLOCATION FOR THIS VENUE.
      //
      // Transaction-level lock automatically releases on
      // COMMIT / ROLLBACK.
      // -----------------------------------------------------

      await client.query(
        `
        SELECT
          pg_advisory_xact_lock(
            hashtext(
              'maks-public-booking'
            ),
            $1::integer
          )
        `,
        [rid]
      );

      // -----------------------------------------------------
      // Verify restaurant exists.
      // -----------------------------------------------------

      restaurant =
        await getRestaurant(
          client,
          rid
        );

      if (!restaurant) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          error:
            "Restaurant not found",
        });
      }

      // -----------------------------------------------------
      // Find tables now that our allocation lock is held.
      // -----------------------------------------------------

      tableIds =
        await autoAssignTables(
          client,
          rid,
          ppl,
          bookingDate,
          slot,
          area
        );

      publicToken =
        crypto
          .randomBytes(32)
          .toString("hex");

      bookingStatus =
        tableIds.length
          ? "confirmed"
          : "pending";

      // -----------------------------------------------------
      // Create booking.
      // -----------------------------------------------------

      const insert =
        await client.query(
          `
          INSERT INTO public.bookings
          (
            customer_name,
            phone,
            email,
            booking_time,
            guests,
            notes,
            table_name,
            status,
            slot_min,
            restaurant_id,
            public_token
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            NULL,
            $7,
            $8,
            $9,
            $10
          )

          RETURNING id
          `,
          [
            customerName,
            contactPhone ||
              null,
            contactEmail ||
              null,
            bookingDate.toISOString(),
            ppl,
            notes,
            bookingStatus,
            slot,
            rid,
            publicToken,
          ]
        );

      bookingId =
        Number(
          insert.rows?.[0]?.id
        );

      if (!bookingId) {
        throw new Error(
          "Booking insert returned no id"
        );
      }

      // -----------------------------------------------------
      // Assign selected tables inside SAME transaction.
      // -----------------------------------------------------

      if (
        tableIds.length
      ) {
        for (
          const tableId of
          tableIds
        ) {
          await client.query(
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
            `,
            [
              bookingId,
              tableId,
              rid,
            ]
          );
        }

        const firstTable =
          await client.query(
            `
            SELECT name

            FROM public.tables

            WHERE restaurant_id = $1
              AND id = $2

            LIMIT 1
            `,
            [
              rid,
              tableIds[0],
            ]
          );

        await client.query(
          `
          UPDATE public.bookings

          SET table_name = $1

          WHERE restaurant_id = $2
            AND id = $3
          `,
          [
            firstTable.rows?.[0]
              ?.name ||
              null,

            rid,

            bookingId,
          ]
        );
      }

      // -----------------------------------------------------
      // CUSTOMER MEMORY
      //
      // One SQL statement:
      //
      // New customer:
      // total_bookings = 1
      //
      // Existing customer:
      // total_bookings += 1
      //
      // This fixes the old first-booking 1 -> 2 bug.
      // -----------------------------------------------------

      const phoneClean =
        contactPhone.replace(
          /\D/g,
          ""
        );

      if (
        phoneClean
      ) {
        await client.query(
          `
          INSERT INTO public.restaurant_customers
          (
            restaurant_id,
            full_name,
            phone,
            email,
            notes,
            total_bookings,
            last_booking_at,
            booking_email_opt_in,
            marketing_email_opt_in,
            gdpr_consent_at
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            1,
            $6,
            $7,
            $8,
            NOW()
          )

          ON CONFLICT
          (
            restaurant_id,

            regexp_replace(
              COALESCE(
                phone,
                ''
              ),
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

            full_name =
              EXCLUDED.full_name,

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
              COALESCE(
                public.restaurant_customers.total_bookings,
                0
              ) + 1,

            last_booking_at =
              EXCLUDED.last_booking_at,

            booking_email_opt_in =
              EXCLUDED.booking_email_opt_in,

            marketing_email_opt_in =
              EXCLUDED.marketing_email_opt_in,

            updated_at =
              NOW()
          `,
          [
            rid,
            customerName,
            contactPhone,
            contactEmail ||
              null,
            notes,
            bookingDate.toISOString(),
            bookingEmailOptIn,
            marketingEmailOptIn,
          ]
        );
      }

      await client.query(
        "COMMIT"
      );
    } catch (err) {
      try {
        if (
          tx?.client
        ) {
          await tx.client.query(
            "ROLLBACK"
          );
        }
      } catch {}

      console.error(
        "POST /public/bookings failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to create booking",
      });
    } finally {
      tx?.release?.();
    }

    // -------------------------------------------------------
    // EMAIL IS OUTSIDE THE DATABASE TRANSACTION.
    //
    // A temporary Brevo problem must never roll back a valid
    // restaurant booking.
    // -------------------------------------------------------

    try {
      if (
        contactEmail &&
        bookingEmailOptIn
      ) {
        const manageUrl =
          `${
            process.env.PUBLIC_APP_URL ||
            "https://maksos.co.uk"
          }` +
          `/manage-booking?token=${publicToken}`;

        await sendBookingConfirmationEmail({
          email:
            contactEmail,

          restaurantName:
            restaurant?.name ||
            "Restaurant",

          customerName,

          bookingTime:
            bookingDate.toISOString(),

          guests:
            ppl,

          reference:
            bookingId,

          manageUrl,

          status:
            bookingStatus,
        });
      }
    } catch (err) {
      console.error(
        "Booking confirmation email failed:",
        err
      );
    }

    return res.status(201).json({
      success: true,

      id:
        bookingId,

      table_ids:
        tableIds,

      manage_token:
        publicToken,

      status:
        bookingStatus,
    });
  }
);

// =========================================================
// GET /public/availability
//
// PUBLIC PRIVACY RULE:
//
// This endpoint may expose operational capacity information,
// but NEVER:
//
// - customer name
// - phone
// - email
// - notes
// - table assignment
//
// Existing frontend compatibility is preserved by still
// returning a bookings array.
// =========================================================

router.get(
  "/availability",
  async (req, res) => {
    try {
      const db =
        req.db;

      const rid =
        getRidPublic(
          req
        );

      if (!rid) {
        return res.status(400).json({
          error:
            "Missing restaurant id",
        });
      }

      const date =
        String(
          req.query.date ||
          ""
        ).slice(
          0,
          10
        );

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
          date
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid date",
        });
      }

      const restaurant =
        await getRestaurant(
          db,
          rid
        );

      if (!restaurant) {
        return res.status(404).json({
          error:
            "Restaurant not found",
        });
      }

      const total =
        await db.query(
          `
          SELECT
            COALESCE(
              SUM(
                COALESCE(
                  tm.seats,
                  t.seats,
                  2
                )
              ),
              0
            ) AS seats

          FROM public.tables t

          LEFT JOIN public.table_map tm
            ON tm.restaurant_id =
               t.restaurant_id

           AND LOWER(
             TRIM(tm.name)
           ) =
           LOWER(
             TRIM(t.name)
           )

          WHERE t.restaurant_id = $1
          `,
          [rid]
        );

      const bookings =
        await db.query(
          `
          SELECT
            id,
            booking_time,
            guests,
            slot_min,
            status

          FROM public.bookings

          WHERE restaurant_id = $1

            AND booking_time::date =
                $2::date

            AND LOWER(
  COALESCE(
    status,
    'pending'
  )
) NOT IN ('cancelled', 'declined')

          ORDER BY
            booking_time ASC
          `,
          [
            rid,
            date,
          ]
        );

      return res.json({
        date,

        total_seats:
          Number(
            total.rows?.[0]
              ?.seats ||
            0
          ),

        bookings:
          bookings.rows ||
          [],
      });
    } catch (err) {
      console.error(
        "GET /public/availability failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to load availability",
      });
    }
  }
);

// =========================================================
// PUT /public/bookings/:token/request-change
//
// Customer requests a change.
//
// Does not directly alter booking_time or guests.
// Staff still approves through protected bookingRoutes.js.
// =========================================================

router.put(
  "/bookings/:token/request-change",
  async (req, res) => {
    try {
      const db =
        req.db;

      const token =
        String(
          req.params.token ||
          ""
        ).trim();

      if (
        !validToken(
          token
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid booking token",
        });
      }

      const body =
        req.body || {};

      let requestedBookingTime =
        null;

      if (
        body.requested_booking_time
      ) {
        const parsed =
          new Date(
            body.requested_booking_time
          );

        if (
          Number.isNaN(
            parsed.getTime()
          )
        ) {
          return res.status(400).json({
            error:
              "Invalid requested booking time",
          });
        }

        if (
          parsed.getTime() <
          Date.now() -
            5 * 60 * 1000
        ) {
          return res.status(400).json({
            error:
              "Requested booking time has already passed",
          });
        }

        requestedBookingTime =
          parsed.toISOString();
      }

      let requestedGuests =
        null;

      if (
        body.requested_guests !==
          undefined &&
        body.requested_guests !==
          null &&
        body.requested_guests !==
          ""
      ) {
        requestedGuests =
          Number(
            body.requested_guests
          );

        if (
          !Number.isInteger(
            requestedGuests
          ) ||
          requestedGuests < 1 ||
          requestedGuests >
            MAX_GUESTS
        ) {
          return res.status(400).json({
            error:
              "Invalid requested guest count",
          });
        }
      }

      const requestedNote =
        cleanText(
          body.requested_note,
          MAX_NOTES_LEN
        );

      if (
        !requestedBookingTime &&
        !requestedGuests &&
        !requestedNote
      ) {
        return res.status(400).json({
          error:
            "No change requested",
        });
      }

      const result =
        await db.query(
          `
          UPDATE public.bookings

          SET
            change_requested_at =
              NOW(),

            requested_booking_time =
              COALESCE(
                $2,
                requested_booking_time
              ),

            requested_guests =
              COALESCE(
                $3,
                requested_guests
              ),

            requested_note =
              COALESCE(
                NULLIF(
                  $4,
                  ''
                ),
                requested_note
              )

          WHERE public_token = $1

            AND LOWER(
              COALESCE(
                status,
                'pending'
              )
            ) <>
              'cancelled'

          RETURNING
            id,
            restaurant_id
          `,
          [
            token,
            requestedBookingTime,
            requestedGuests,
            requestedNote,
          ]
        );

      if (
        !result.rows.length
      ) {
        return res.status(404).json({
          error:
            "Booking not found",
        });
      }

      // -----------------------------------------------------
      // TENANT-CORRECT RESTAURANT NOTIFICATION.
      //
      // Resolve owner_email from the booking's own
      // restaurant_id.
      //
      // Never accept restaurant email from the public client.
      // -----------------------------------------------------

      try {
        const info =
          await db.query(
            `
            SELECT
              b.id,
              b.customer_name,

              r.name
                AS restaurant_name,

              r.owner_email

            FROM public.bookings b

            JOIN public.restaurants r
              ON r.id =
                 b.restaurant_id

            WHERE b.public_token = $1

            LIMIT 1
            `,
            [token]
          );

        const row =
          info.rows?.[0];

        const restaurantEmail =
          cleanText(
            row?.owner_email,
            MAX_EMAIL_LEN
          );

        if (
          restaurantEmail &&
          validEmail(
            restaurantEmail
          )
        ) {
          await sendBookingChangeRequestEmail({
            restaurantEmail,

            restaurantName:
              row?.restaurant_name ||
              "Restaurant",

            customerName:
              row?.customer_name ||
              "Guest",

            requestedBookingTime,

            requestedGuests,

            requestedNote,

            bookingId:
              row?.id,
          });
        } else {
          console.warn(
            `⚠️ Booking change request ${row?.id || ""} has no valid restaurant owner_email`
          );
        }
      } catch (emailErr) {
        console.error(
          "Restaurant change request email failed:",
          emailErr
        );
      }

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "PUT /public/bookings/:token/request-change failed:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to request change",
      });
    }
  }
);

module.exports = router;