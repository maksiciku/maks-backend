// jobs/bookingAutoReserveJob.js

const cron = require("node-cron");

const DEFAULT_SLOT_MIN = 120;

const RESERVE_BEFORE_MIN = 15;
const RELEASE_AFTER_MIN = 30;

const MAX_TABLES_FOR_SEARCH = 18;
const MAX_SEARCH_STATES = 80000;

// Prevent the same Node process starting another cycle
// while the previous cycle is still running.
let cycleRunning = false;

// =========================================================
// HELPERS
// =========================================================

function addMin(value, minutes) {
  return new Date(
    new Date(value).getTime() +
      Number(minutes) * 60000
  );
}

function normalizeStatus(value) {
  return String(
    value || "pending"
  )
    .trim()
    .toLowerCase();
}

async function getClient(pool) {
  if (
    pool &&
    typeof pool.connect === "function"
  ) {
    const client =
      await pool.connect();

    return {
      client,

      release() {
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
    client: pool,
    release() {},
  };
}

// =========================================================
// BEST-FIT TABLE SELECTION
// =========================================================

function chooseBestTables(
  tables,
  guests
) {
  const arr =
    (tables || [])
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
      )
      .sort(
        (a, b) =>
          a.seats - b.seats ||
          a.id - b.id
      )
      .slice(
        0,
        MAX_TABLES_FOR_SEARCH
      );

  if (
    !arr.length ||
    guests <= 0
  ) {
    return [];
  }

  let best = null;

  const trySet = (
    picked
  ) => {
    const totalSeats =
      picked.reduce(
        (sum, table) =>
          sum +
          table.seats,
        0
      );

    if (
      totalSeats <
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
        totalSeats -
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

  // Fast greedy candidate first.
  const greedy = [];
  let greedySeats = 0;

  for (
    const table of arr
  ) {
    if (
      greedySeats >=
      guests
    ) {
      break;
    }

    greedy.push(
      table
    );

    greedySeats +=
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

  const dfs = (
    index,
    picked,
    seatSum
  ) => {
    if (
      explored++ >
      MAX_SEARCH_STATES
    ) {
      return;
    }

    if (
      seatSum >=
      guests
    ) {
      trySet(
        picked
      );

      return;
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
      best.waste === 0 &&
      best.count <= 2
    ) {
      return;
    }

    // Skip current table.
    dfs(
      index + 1,
      picked,
      seatSum
    );

    // Include current table.
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
    best?.ids || []
  );
}

// =========================================================
// ASSIGN TABLES IF BOOKING HAS NONE
//
// MUST run while restaurant advisory transaction lock is held.
// =========================================================

async function assignTablesIfMissing(
  client,
  booking
) {
  const rid =
    Number(
      booking.restaurant_id
    );

  const bookingId =
    Number(
      booking.id
    );

  const guests =
    Number(
      booking.guests || 0
    );

  const slot =
    Number(
      booking.slot_min ||
      DEFAULT_SLOT_MIN
    );

  if (
    !rid ||
    !bookingId ||
    guests <= 0
  ) {
    return [];
  }

  // -------------------------------------------------------
  // Booking may already have tables.
  // -------------------------------------------------------

  const existingResult =
    await client.query(
      `
      SELECT table_id

      FROM public.booking_tables

      WHERE restaurant_id = $1
        AND booking_id = $2

      ORDER BY table_id ASC
      `,
      [
        rid,
        bookingId,
      ]
    );

  const existing =
    (existingResult.rows || [])
      .map(
        (row) =>
          Number(
            row.table_id
          )
      )
      .filter(Boolean);

  if (
    existing.length
  ) {
    return existing;
  }

  // -------------------------------------------------------
  // Find tables used by OTHER overlapping bookings.
  // -------------------------------------------------------

  const bookingStart =
    new Date(
      booking.booking_time
    );

  const bookingEnd =
    addMin(
      bookingStart,
      slot
    );

  const blockedResult =
    await client.query(
      `
      SELECT DISTINCT
        bt.table_id

      FROM public.bookings other

      JOIN public.booking_tables bt
        ON bt.booking_id =
           other.id

       AND bt.restaurant_id =
           other.restaurant_id

      WHERE other.restaurant_id = $1

        AND other.id <> $2

        AND LOWER(
          COALESCE(
            other.status,
            'pending'
          )
        ) NOT IN (
          'cancelled',
          'declined'
        )

        AND other.booking_time <
            $4::timestamptz

        AND (
          other.booking_time +
          make_interval(
            mins =>
              COALESCE(
                other.slot_min,
                $5
              )
          )
        ) >
          $3::timestamptz
      `,
      [
        rid,
        bookingId,
        bookingStart.toISOString(),
        bookingEnd.toISOString(),
        DEFAULT_SLOT_MIN,
      ]
    );

  const blockedIds =
    new Set(
      (blockedResult.rows || [])
        .map(
          (row) =>
            Number(
              row.table_id
            )
        )
        .filter(Boolean)
    );

  // -------------------------------------------------------
  // Load this restaurant's usable tables.
  //
  // OCCUPIED means physically in use right now, so never
  // auto-assign those.
  // -------------------------------------------------------

  const tablesResult =
    await client.query(
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
          NULLIF(
            TRIM(
              t.status
            ),
            ''
          ),
          'free'
        ) AS status

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

  const available =
    (tablesResult.rows || [])
      .filter(
        (row) =>
          !blockedIds.has(
            Number(
              row.id
            )
          )
      )
      .filter(
        (row) =>
          normalizeStatus(
            row.status
          ) !==
          "occupied"
      );

  const chosen =
    chooseBestTables(
      available,
      guests
    );

  if (
    !chosen.length
  ) {
    return [];
  }

  // -------------------------------------------------------
  // Insert assignment.
  //
  // This occurs under the SAME restaurant advisory lock used
  // by public booking creation.
  // -------------------------------------------------------

  for (
    const tableId of
    chosen
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

  // Legacy compatibility.
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
        chosen[0],
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

  return chosen;
}

// =========================================================
// RESERVE TABLES SHORTLY BEFORE BOOKING
// =========================================================

async function reserveIfDue(
  client,
  booking,
  tableIds,
  now
) {
  if (
    !tableIds.length
  ) {
    return;
  }

  const status =
    normalizeStatus(
      booking.status
    );

  if (
    [
      "cancelled",
      "declined",
      "arrived",
    ].includes(
      status
    )
  ) {
    return;
  }

  const bookingStart =
    new Date(
      booking.booking_time
    );

  const reserveFrom =
    addMin(
      bookingStart,
      -RESERVE_BEFORE_MIN
    );

  const releaseAt =
    addMin(
      bookingStart,
      RELEASE_AFTER_MIN
    );

  const shouldReserve =
    now >= reserveFrom &&
    now <= releaseAt;

  if (
    !shouldReserve
  ) {
    return;
  }

  const rid =
    Number(
      booking.restaurant_id
    );

  // Never overwrite OCCUPIED.
  await client.query(
    `
    UPDATE public.tables

    SET status =
      'reserved'

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
      ) <>
        'occupied'
    `,
    [
      rid,
      tableIds,
    ]
  );

  await client.query(
    `
    UPDATE public.table_map

    SET status =
      'reserved'

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
      ) <>
        'occupied'
    `,
    [
      rid,
      tableIds,
    ]
  );
}

// =========================================================
// RELEASE STALE RESERVATION
//
// After booking_time + RELEASE_AFTER_MIN:
//
// - do not overwrite OCCUPIED
// - only free RESERVED
// - do not free a table needed by another booking whose
//   reserve window is currently active
//
// We do NOT invent a "no_show" booking status here.
// =========================================================

async function releaseIfStale(
  client,
  booking,
  tableIds,
  now
) {
  if (
    !tableIds.length
  ) {
    return;
  }

  const status =
    normalizeStatus(
      booking.status
    );

  if (
    [
      "arrived",
      "cancelled",
      "declined",
    ].includes(
      status
    )
  ) {
    return;
  }

  const bookingStart =
    new Date(
      booking.booking_time
    );

  const releaseAt =
    addMin(
      bookingStart,
      RELEASE_AFTER_MIN
    );

  if (
    now <=
    releaseAt
  ) {
    return;
  }

  const rid =
    Number(
      booking.restaurant_id
    );

  const bookingId =
    Number(
      booking.id
    );

  // -------------------------------------------------------
  // Determine whether another booking currently needs each
  // table to remain reserved.
  // -------------------------------------------------------

  const otherActive =
    await client.query(
      `
      SELECT DISTINCT
        bt.table_id

      FROM public.booking_tables bt

      JOIN public.bookings b
        ON b.id =
           bt.booking_id

       AND b.restaurant_id =
           bt.restaurant_id

      WHERE bt.restaurant_id = $1

        AND bt.table_id =
          ANY(
            $2::bigint[]
          )

        AND b.id <> $3

        AND LOWER(
          COALESCE(
            b.status,
            'pending'
          )
        ) NOT IN (
          'cancelled',
          'declined',
          'arrived'
        )

        AND $4::timestamptz >=
          (
            b.booking_time -
            make_interval(
              mins => $5
            )
          )

        AND $4::timestamptz <=
          (
            b.booking_time +
            make_interval(
              mins => $6
            )
          )
      `,
      [
        rid,
        tableIds,
        bookingId,
        now.toISOString(),
        RESERVE_BEFORE_MIN,
        RELEASE_AFTER_MIN,
      ]
    );

  const protectedIds =
    new Set(
      (otherActive.rows || [])
        .map(
          (row) =>
            Number(
              row.table_id
            )
        )
        .filter(Boolean)
    );

  const releasable =
    tableIds.filter(
      (tableId) =>
        !protectedIds.has(
          Number(
            tableId
          )
        )
    );

  if (
    !releasable.length
  ) {
    return;
  }

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
      rid,
      releasable,
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
      rid,
      releasable,
    ]
  );
}

// =========================================================
// PROCESS ONE BOOKING
// =========================================================

async function processBooking(
  pool,
  booking,
  now
) {
  const rid =
    Number(
      booking.restaurant_id
    );

  const bookingId =
    Number(
      booking.id
    );

  if (
    !rid ||
    !bookingId
  ) {
    return;
  }

  const tx =
    await getClient(
      pool
    );

  const client =
    tx.client;

  try {
    await client.query(
      "BEGIN"
    );

    // -----------------------------------------------------
    // CRITICAL:
    //
    // SAME lock namespace/key used by publicBookingRoutes.
    //
    // This means:
    //
    // public booking creation
    // and
    // background auto-assignment
    //
    // cannot allocate tables concurrently for the same venue.
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

    // Re-read booking after lock.
    const freshResult =
      await client.query(
        `
        SELECT
          id,
          restaurant_id,
          booking_time,
          guests,

          COALESCE(
            slot_min,
            $3
          ) AS slot_min,

          status

        FROM public.bookings

        WHERE restaurant_id = $1
          AND id = $2

        LIMIT 1

        FOR UPDATE
        `,
        [
          rid,
          bookingId,
          DEFAULT_SLOT_MIN,
        ]
      );

    const fresh =
      freshResult.rows?.[0];

    if (!fresh) {
      await client.query(
        "ROLLBACK"
      );

      return;
    }

    const status =
      normalizeStatus(
        fresh.status
      );

    if (
      [
        "cancelled",
        "declined",
      ].includes(
        status
      )
    ) {
      await client.query(
        "COMMIT"
      );

      return;
    }

    let tableIds =
      await assignTablesIfMissing(
        client,
        fresh
      );

    // Re-read assignment because legacy data / conflict
    // handling may mean the helper returned no new ids.
    if (
      !tableIds.length
    ) {
      const assigned =
        await client.query(
          `
          SELECT table_id

          FROM public.booking_tables

          WHERE restaurant_id = $1
            AND booking_id = $2

          ORDER BY
            table_id ASC
          `,
          [
            rid,
            bookingId,
          ]
        );

      tableIds =
        (assigned.rows || [])
          .map(
            (row) =>
              Number(
                row.table_id
              )
          )
          .filter(Boolean);
    }

    await reserveIfDue(
      client,
      fresh,
      tableIds,
      now
    );

    await releaseIfStale(
      client,
      fresh,
      tableIds,
      now
    );

    await client.query(
      "COMMIT"
    );
  } catch (err) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    console.error(
      `❌ Booking auto-reserve failed for booking=${bookingId}, rid=${rid}:`,
      err
    );
  } finally {
    tx.release();
  }
}

// =========================================================
// AUTO RESERVE CYCLE
// =========================================================

async function autoReserveToday(
  pool
) {
  if (
    cycleRunning
  ) {
    console.warn(
      "⚠️ Booking auto-reserve skipped: previous cycle still running"
    );

    return;
  }

  cycleRunning = true;

  const now =
    new Date();

  try {
    /**
     * Do not derive "today" in JavaScript with toISOString().
     *
     * That creates a UTC-day edge case around midnight.
     *
     * Instead, fetch the operational window relative to NOW().
     *
     * Yesterday's late bookings are included so stale reservations
     * can still be released.
     *
     * Tomorrow is included so bookings created near midnight can
     * be assigned without waiting for a date rollover.
     */
    const result =
      await pool.query(
        `
        SELECT
          b.id,
          b.restaurant_id,
          b.booking_time,
          b.guests,

          COALESCE(
            b.slot_min,
            $1
          ) AS slot_min,

          b.status

        FROM public.bookings b

        WHERE b.booking_time >=
          NOW() -
          INTERVAL '1 day'

          AND b.booking_time <
          NOW() +
          INTERVAL '2 days'

          AND LOWER(
            COALESCE(
              b.status,
              'pending'
            )
          ) NOT IN (
            'cancelled',
            'declined'
          )

        ORDER BY
          b.restaurant_id ASC,
          b.booking_time ASC,
          b.id ASC
        `,
        [
          DEFAULT_SLOT_MIN,
        ]
      );

    for (
      const booking of
      result.rows || []
    ) {
      await processBooking(
        pool,
        booking,
        now
      );
    }

    console.log(
      `✅ booking auto-reserve cycle complete — ${result.rows?.length || 0} booking(s) checked`
    );
  } catch (err) {
    console.error(
      "❌ booking auto-reserve cycle failed:",
      err
    );
  } finally {
    cycleRunning = false;
  }
}

// =========================================================
// JOB START
// =========================================================

function startBookingAutoReserveJob(
  pool
) {
  cron.schedule(
    "*/1 * * * *",
    () => {
      autoReserveToday(
        pool
      ).catch(
        (err) => {
          console.error(
            "❌ Unhandled booking auto-reserve job error:",
            err
          );
        }
      );
    },
    {
      scheduled: true,
    }
  );
}

module.exports = {
  startBookingAutoReserveJob,
  autoReserveToday,
};