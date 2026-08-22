const router = require("express").Router();
const {
  requirePermission,
  PERMISSIONS,
} = require("../middleware/accessControl");

function parseIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfTodayIso() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function num(v) {
  return Number(v || 0);
}

function buildAlerts({ stock, orders, bookings, cashup, sales, staff, reports }) {
  const alerts = [];

  for (const item of stock.low_stock_items || []) {
    alerts.push({
      level: "high",
      type: "low_stock",
      title: `Low stock: ${item.ingredient}`,
      message: `${item.ingredient} is at ${num(item.quantity)} ${item.unit || ""}`.trim(),
      meta: {
        stock_id: item.id,
        quantity: num(item.quantity),
        minimum_level: num(item.minimum_level),
      },
    });
  }

  if (num(stock.out_of_stock_count) > 0) {
    alerts.push({
      level: "high",
      type: "out_of_stock",
      title: "Items out of stock",
      message: `${num(stock.out_of_stock_count)} stock item(s) are at zero or below.`,
    });
  }

  if (num(orders.unpaid_tables_count) > 0) {
    alerts.push({
      level: "high",
      type: "unpaid_tables",
      title: "Unpaid tables open",
      message: `${num(orders.unpaid_tables_count)} table(s) still have unpaid balance.`,
      meta: { unpaid_amount: num(orders.unpaid_amount) },
    });
  }

  if (num(bookings.upcoming_count) > 0) {
    alerts.push({
      level: "info",
      type: "upcoming_bookings",
      title: "Upcoming bookings",
      message: `${num(bookings.upcoming_count)} upcoming booking(s) scheduled.`,
    });
  }

  if (!cashup.latest_session) {
    alerts.push({
      level: "medium",
      type: "cashup_missing",
      title: "No cashup session found",
      message: "No recent cashup session is available for this restaurant.",
    });
  } else if (Math.abs(num(cashup.latest_session.discrepancy)) > 0.009) {
    alerts.push({
      level: "medium",
      type: "cashup_discrepancy",
      title: "Cashup discrepancy detected",
      message: `Latest discrepancy is ${num(cashup.latest_session.discrepancy).toFixed(2)}.`,
      meta: { session_id: cashup.latest_session.id },
    });
  }

  if (num(sales.refunds_total) > 0) {
    alerts.push({
      level: "medium",
      type: "refunds",
      title: "Refunds recorded",
      message: `Refund total in range: ${num(sales.refunds_total).toFixed(2)}.`,
    });
  }

  if (num(reports?.estimated_waste_value) > 0) {
    alerts.push({
      level: num(reports.estimated_waste_value) >= 50 ? "high" : "medium",
      type: "waste_value",
      title: "Waste recorded",
      message: `Estimated waste value in range: ${num(reports.estimated_waste_value).toFixed(2)}.`,
    });
  }

  const risky = (staff?.risk_flags || []).filter((x) => num(x.score) > 0);
  for (const row of risky.slice(0, 3)) {
    alerts.push({
      level: "medium",
      type: "staff_risk",
      title: `Staff attention: ${row.staff_name}`,
      message: `${num(row.refunds_count)} refund(s), ${num(row.voids_count)} void(s), ${num(row.table_closures)} table close(s).`,
      meta: { user_id: row.user_id },
    });
  }

  return alerts
    .sort((a, b) => {
      const rank = { high: 3, medium: 2, info: 1 };
      return (rank[b.level] || 0) - (rank[a.level] || 0);
    })
    .slice(0, 20);
}

router.get("/overview", requirePermission(PERMISSIONS.CONTROL_CENTRE_VIEW), async (req, res) => {
  try {
    const rid = Number(req.tenantRid || 0);
    if (!rid) {
      return res.status(400).json({ error: "Missing restaurant context" });
    }

    const from = parseIsoOrNull(req.query.from) || startOfTodayIso();
    const to = parseIsoOrNull(req.query.to) || endOfTodayIso();

    if (new Date(from) > new Date(to)) {
      return res.status(400).json({ error: "from must be before to" });
    }

    // ---------------------------
    // SALES
    // ---------------------------
    const salesRow = await req.qGet(
      `
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0)::numeric AS total_sales,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(method, '')) = 'cash' AND amount > 0 THEN amount ELSE 0 END), 0)::numeric AS cash_sales,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(method, '')) = 'card' AND amount > 0 THEN amount ELSE 0 END), 0)::numeric AS card_sales,
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0)::numeric AS refunds_total,
        COUNT(*) FILTER (WHERE amount > 0)::int AS transactions_count
      FROM public.payments
      WHERE restaurant_id = $1
        AND created_at BETWEEN $2 AND $3
      `,
      [rid, from, to]
    );

    const sales = {
      total_sales: num(salesRow?.total_sales),
      cash_sales: num(salesRow?.cash_sales),
      card_sales: num(salesRow?.card_sales),
      refunds_total: num(salesRow?.refunds_total),
      transactions_count: num(salesRow?.transactions_count),
      average_spend:
        num(salesRow?.transactions_count) > 0
          ? Number((num(salesRow?.total_sales) / num(salesRow?.transactions_count)).toFixed(2))
          : 0,
    };

    // ---------------------------
// ORDERS / ITEMS
// Money truth = payments.
// Item performance = paid/settled POS rows only.
// Live risk = unpaid/open rows separately.
// ---------------------------

const orderSummaryRow = await req.qGet(
  `
  SELECT
    COUNT(*) FILTER (
      WHERE created_at BETWEEN $2 AND $3
    )::int AS total_order_rows,

    COALESCE(SUM(CASE
      WHEN created_at BETWEEN $2 AND $3
       AND COALESCE(paid, 0) = 1
       AND COALESCE(order_status, 'open') <> 'voided'
      THEN quantity ELSE 0
    END), 0)::numeric AS paid_items_sold,

    COUNT(DISTINCT CASE
      WHEN COALESCE(remaining_price, total_price, 0) > 0
       AND COALESCE(paid, 0) = 0
       AND COALESCE(order_status, 'open') = 'open'
       AND LOWER(COALESCE(table_number, '')) NOT IN ('takeaway', 'delivery')
      THEN table_number
    END)::int AS unpaid_tables_count,

    COALESCE(SUM(CASE
      WHEN COALESCE(remaining_price, total_price, 0) > 0
       AND COALESCE(paid, 0) = 0
       AND COALESCE(order_status, 'open') = 'open'
      THEN COALESCE(remaining_price, total_price, 0)
      ELSE 0
    END), 0)::numeric AS unpaid_amount,

    COALESCE(SUM(CASE
      WHEN created_at BETWEEN $2 AND $3
       AND COALESCE(paid, 0) = 1
       AND COALESCE(order_status, 'open') <> 'voided'
       AND LOWER(COALESCE(item_type, '')) IN ('meal', 'meals')
      THEN quantity ELSE 0
    END), 0)::numeric AS meals_count,

    COALESCE(SUM(CASE
      WHEN created_at BETWEEN $2 AND $3
       AND COALESCE(paid, 0) = 1
       AND COALESCE(order_status, 'open') <> 'voided'
       AND LOWER(COALESCE(item_type, '')) IN ('drink', 'drinks')
      THEN quantity ELSE 0
    END), 0)::numeric AS drinks_count,

    COALESCE(SUM(CASE
      WHEN created_at BETWEEN $2 AND $3
       AND COALESCE(paid, 0) = 1
       AND COALESCE(order_status, 'open') <> 'voided'
       AND LOWER(COALESCE(item_type, '')) IN ('dessert', 'desserts')
      THEN quantity ELSE 0
    END), 0)::numeric AS desserts_count,

    COALESCE(SUM(CASE
      WHEN created_at BETWEEN $2 AND $3
       AND COALESCE(paid, 0) = 1
       AND COALESCE(order_status, 'open') <> 'voided'
       AND LOWER(COALESCE(item_type, '')) NOT IN ('meal', 'meals', 'drink', 'drinks', 'dessert', 'desserts')
      THEN quantity ELSE 0
    END), 0)::numeric AS misc_count
  FROM public.pos_orders
  WHERE restaurant_id = $1
  `,
  [rid, from, to]
);

const topSellingItems = await req.qAll(
  `
  SELECT
    COALESCE(NULLIF(TRIM(item_name), ''), 'Unnamed Item') AS item_name,
    COALESCE(SUM(quantity), 0)::numeric AS qty_sold,
    COALESCE(SUM(total_price), 0)::numeric AS revenue,
    LOWER(COALESCE(item_type, 'misc')) AS item_type
  FROM public.pos_orders
  WHERE restaurant_id = $1
    AND created_at BETWEEN $2 AND $3
    AND COALESCE(paid, 0) = 1
    AND COALESCE(order_status, 'open') <> 'voided'
  GROUP BY
    COALESCE(NULLIF(TRIM(item_name), ''), 'Unnamed Item'),
    LOWER(COALESCE(item_type, 'misc'))
  ORDER BY qty_sold DESC, revenue DESC, item_name ASC
  LIMIT 5
  `,
  [rid, from, to]
);

const weakSellingItems = await req.qAll(
  `
  SELECT
    COALESCE(NULLIF(TRIM(item_name), ''), 'Unnamed Item') AS item_name,
    COALESCE(SUM(quantity), 0)::numeric AS qty_sold,
    COALESCE(SUM(total_price), 0)::numeric AS revenue,
    LOWER(COALESCE(item_type, 'misc')) AS item_type
  FROM public.pos_orders
  WHERE restaurant_id = $1
    AND created_at BETWEEN $2 AND $3
    AND COALESCE(paid, 0) = 1
    AND COALESCE(order_status, 'open') <> 'voided'
  GROUP BY
    COALESCE(NULLIF(TRIM(item_name), ''), 'Unnamed Item'),
    LOWER(COALESCE(item_type, 'misc'))
  HAVING COALESCE(SUM(quantity), 0) > 0
  ORDER BY qty_sold ASC, revenue ASC, item_name ASC
  LIMIT 5
  `,
  [rid, from, to]
);

const orders = {
  total_order_rows: num(orderSummaryRow?.total_order_rows),
  items_sold: num(orderSummaryRow?.paid_items_sold),
  unpaid_tables_count: num(orderSummaryRow?.unpaid_tables_count),
  unpaid_amount: num(orderSummaryRow?.unpaid_amount),
  by_type: {
    meals: num(orderSummaryRow?.meals_count),
    drinks: num(orderSummaryRow?.drinks_count),
    desserts: num(orderSummaryRow?.desserts_count),
    misc: num(orderSummaryRow?.misc_count),
  },
  top_selling_items: (topSellingItems || []).map((r) => ({
    item_name: r.item_name,
    qty_sold: num(r.qty_sold),
    revenue: num(r.revenue),
    item_type: r.item_type || "misc",
  })),
  weak_selling_items: (weakSellingItems || []).map((r) => ({
    item_name: r.item_name,
    qty_sold: num(r.qty_sold),
    revenue: num(r.revenue),
    item_type: r.item_type || "misc",
  })),
};

    // ---------------------------
    // BOOKINGS
    // ---------------------------
    const bookingSummaryRow = await req.qGet(
      `
      SELECT
        COUNT(*) FILTER (WHERE booking_time BETWEEN $2 AND $3)::int AS total_bookings,
        COALESCE(SUM(CASE WHEN booking_time BETWEEN $2 AND $3 THEN guests ELSE 0 END), 0)::int AS total_covers,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'no-show' AND booking_time BETWEEN $2 AND $3)::int AS no_shows,
        COUNT(*) FILTER (WHERE booking_time > NOW())::int AS upcoming_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'seated' AND booking_time BETWEEN $2 AND $3)::int AS seated_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('completed', 'finished') AND booking_time BETWEEN $2 AND $3)::int AS completed_count
      FROM public.bookings
      WHERE restaurant_id = $1
      `,
      [rid, from, to]
    );

    const upcomingBookings = await req.qAll(
      `
      SELECT
        id,
        customer_name,
        first_name,
        last_name,
        booking_time,
        guests,
        status,
        table_name
      FROM public.bookings
      WHERE restaurant_id = $1
        AND booking_time > NOW()
      ORDER BY booking_time ASC
      LIMIT 5
      `,
      [rid]
    );

    const bookings = {
      total_bookings: num(bookingSummaryRow?.total_bookings),
      total_covers: num(bookingSummaryRow?.total_covers),
      no_shows: num(bookingSummaryRow?.no_shows),
      upcoming_count: num(bookingSummaryRow?.upcoming_count),
      seated_count: num(bookingSummaryRow?.seated_count),
      completed_count: num(bookingSummaryRow?.completed_count),
      upcoming_bookings: (upcomingBookings || []).map((b) => ({
        id: b.id,
        customer_name:
          b.customer_name ||
          [b.first_name, b.last_name].filter(Boolean).join(" ") ||
          "Booking",
        booking_time: b.booking_time,
        guests: num(b.guests),
        status: b.status || "pending",
        table_name: b.table_name || null,
      })),
    };

    // ---------------------------
    // SERVICE
    // ---------------------------
    const ordersPerHour = await req.qAll(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'HH24:00') AS hour_label,
        COALESCE(SUM(quantity), 0)::numeric AS qty
      FROM public.pos_orders
      WHERE restaurant_id = $1
        AND created_at BETWEEN $2 AND $3
      GROUP BY 1
      ORDER BY 1
      `,
      [rid, from, to]
    );

    const coversPerHour = await req.qAll(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('hour', booking_time), 'HH24:00') AS hour_label,
        COALESCE(SUM(guests), 0)::numeric AS covers
      FROM public.bookings
      WHERE restaurant_id = $1
        AND booking_time BETWEEN $2 AND $3
      GROUP BY 1
      ORDER BY 1
      `,
      [rid, from, to]
    );

    const busiestOrderHours = [...(ordersPerHour || [])]
      .map((r) => ({ hour_label: r.hour_label, qty: num(r.qty) }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 3);

    const busiestBookingHours = [...(coversPerHour || [])]
      .map((r) => ({ hour_label: r.hour_label, covers: num(r.covers) }))
      .sort((a, b) => b.covers - a.covers)
      .slice(0, 3);

    const service = {
      busiest_order_hours: busiestOrderHours,
      busiest_booking_hours: busiestBookingHours,
      peak_hour_label:
        busiestOrderHours[0]?.hour_label ||
        busiestBookingHours[0]?.hour_label ||
        null,
      orders_per_hour: (ordersPerHour || []).map((r) => ({
        hour_label: r.hour_label,
        qty: num(r.qty),
      })),
      covers_per_hour: (coversPerHour || []).map((r) => ({
        hour_label: r.hour_label,
        covers: num(r.covers),
      })),
    };

    // ---------------------------
    // CASHUP
    // ---------------------------
    let latestCashup = null;

    try {
      latestCashup = await req.qGet(
        `
        SELECT
          id,
          from_ts,
          to_ts,
          actual_cash,
          expected_cash,
          discrepancy,
          note,
          created_at,
          closed_by_user_id
        FROM public.cashup_sessions
        WHERE restaurant_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [rid]
      );
    } catch (_err) {
      latestCashup = await req.qGet(
        `
        SELECT
          id,
          from_ts,
          to_ts,
          actual_cash,
          expected_cash,
          difference AS discrepancy,
          note,
          created_at,
          closed_by_user_id
        FROM public.cashup_sessions
        WHERE restaurant_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [rid]
      );
    }

    const cashup = {
      latest_session: latestCashup
        ? {
            id: latestCashup.id,
            from_ts: latestCashup.from_ts,
            to_ts: latestCashup.to_ts,
            actual_cash: num(latestCashup.actual_cash),
            expected_cash: num(latestCashup.expected_cash),
            discrepancy: num(latestCashup.discrepancy),
            note: latestCashup.note || null,
            created_at: latestCashup.created_at,
            closed_by_user_id: latestCashup.closed_by_user_id || null,
          }
        : null,
    };

    // ---------------------------
    // STOCK
    // ---------------------------
    const stockSummaryRow = await req.qGet(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE COALESCE(quantity, 0) <= 0
            AND LOWER(TRIM(COALESCE(type, 'ingredient'))) IN ('ingredient', 'ingredients', '')
        )::int AS out_of_stock_count,

        COUNT(*) FILTER (
          WHERE COALESCE(quantity, 0) > 0
            AND COALESCE(minimum_level, min_threshold, 0) > 0
            AND quantity <= COALESCE(minimum_level, min_threshold, 0)
            AND LOWER(TRIM(COALESCE(type, 'ingredient'))) IN ('ingredient', 'ingredients', '')
        )::int AS low_stock_count,

        COUNT(*) FILTER (
          WHERE NULLIF(expiry_date, '') IS NOT NULL
            AND NULLIF(expiry_date, '')::date <= CURRENT_DATE + INTERVAL '3 days'
            AND LOWER(TRIM(COALESCE(type, 'ingredient'))) IN ('ingredient', 'ingredients', '')
        )::int AS expiring_soon_count
      FROM public.stock
      WHERE restaurant_id = $1
      `,
      [rid]
    );

    const lowStockItems = await req.qAll(
      `
      SELECT
        id,
        ingredient,
        quantity,
        unit,
        minimum_level,
        min_threshold,
        expiry_date
      FROM public.stock
      WHERE restaurant_id = $1
        AND LOWER(TRIM(COALESCE(type, 'ingredient'))) IN ('ingredient', 'ingredients', '')
        AND (
          COALESCE(quantity, 0) <= 0
          OR (
            COALESCE(minimum_level, min_threshold, 0) > 0
            AND quantity <= COALESCE(minimum_level, min_threshold, 0)
          )
        )
      ORDER BY quantity ASC, ingredient ASC
      LIMIT 8
      `,
      [rid]
    );

    const stock = {
      low_stock_count: num(stockSummaryRow?.low_stock_count),
      out_of_stock_count: num(stockSummaryRow?.out_of_stock_count),
      expiring_soon_count: num(stockSummaryRow?.expiring_soon_count),
      low_stock_items: (lowStockItems || []).map((r) => ({
        id: r.id,
        ingredient: r.ingredient,
        quantity: num(r.quantity),
        unit: r.unit || "unit",
        minimum_level: num(r.minimum_level || r.min_threshold),
        expiry_date: r.expiry_date || null,
      })),
    };

    // ---------------------------
    // REPORTS / WASTE / REMAKES
    // ---------------------------
    const wasteSummaryRow = await req.qGet(
      `
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(report_type,'')) = 'waste')::int AS waste_reports,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(report_type,'')) = 'remake')::int AS remake_reports,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(report_type,'')) = 'complaint')::int AS complaint_reports,
        COALESCE(SUM(quantity), 0)::numeric AS total_waste_items,
        COALESCE(SUM(estimated_value), 0)::numeric AS estimated_waste_value
      FROM public.reports
      WHERE restaurant_id = $1
        AND created_at BETWEEN $2 AND $3
      `,
      [rid, from, to]
    );

    const mostWastedItems = await req.qAll(
      `
      SELECT
        COALESCE(NULLIF(TRIM(item_name), ''), 'Unnamed Item') AS item_name,
        LOWER(COALESCE(item_type, 'misc')) AS item_type,
        COALESCE(SUM(quantity), 0)::numeric AS qty,
        COALESCE(SUM(estimated_value), 0)::numeric AS waste_value
      FROM public.reports
      WHERE restaurant_id = $1
        AND created_at BETWEEN $2 AND $3
      GROUP BY COALESCE(NULLIF(TRIM(item_name), ''), 'Unnamed Item'), LOWER(COALESCE(item_type, 'misc'))
      ORDER BY qty DESC, waste_value DESC, item_name ASC
      LIMIT 8
      `,
      [rid, from, to]
    );

    const wasteByStaff = await req.qAll(
      `
      SELECT
        COALESCE(NULLIF(TRIM(reported_by), ''), 'Staff') AS staff_name,
        reported_by_user_id AS user_id,
        COUNT(*)::int AS reports_count,
        COALESCE(SUM(quantity), 0)::numeric AS qty,
        COALESCE(SUM(estimated_value), 0)::numeric AS waste_value
      FROM public.reports
      WHERE restaurant_id = $1
        AND created_at BETWEEN $2 AND $3
      GROUP BY COALESCE(NULLIF(TRIM(reported_by), ''), 'Staff'), reported_by_user_id
      ORDER BY qty DESC, waste_value DESC, staff_name ASC
      LIMIT 8
      `,
      [rid, from, to]
    );

    const reports = {
      waste_reports: num(wasteSummaryRow?.waste_reports),
      remake_reports: num(wasteSummaryRow?.remake_reports),
      complaint_reports: num(wasteSummaryRow?.complaint_reports),
      total_waste_items: num(wasteSummaryRow?.total_waste_items),
      estimated_waste_value: num(wasteSummaryRow?.estimated_waste_value),
      most_wasted_items: (mostWastedItems || []).map((r) => ({
        item_name: r.item_name,
        item_type: r.item_type || "misc",
        qty: num(r.qty),
        waste_value: num(r.waste_value),
      })),
      waste_by_staff: (wasteByStaff || []).map((r) => ({
        user_id: r.user_id || null,
        staff_name: r.staff_name || "Staff",
        reports_count: num(r.reports_count),
        qty: num(r.qty),
        waste_value: num(r.waste_value),
      })),
    };

    // ---------------------------
    // STAFF OVERVIEW
    // ---------------------------
    const staffRows = await req.qAll(
      `
      SELECT
        rm.id AS member_id,
        rm.user_id,
        rm.role,
        rm.is_active,
        rm.created_at,
        u.username,
        u.full_name
      FROM public.restaurant_members rm
      JOIN public.users u
        ON u.id = rm.user_id
      WHERE rm.restaurant_id = $1
      ORDER BY
        CASE
          WHEN rm.role = 'owner' THEN 1
          WHEN rm.role = 'admin' THEN 2
          WHEN rm.role = 'manager' THEN 3
          WHEN rm.role = 'supervisor' THEN 4
          WHEN rm.role = 'chef' THEN 5
          WHEN rm.role = 'waiter' THEN 6
          WHEN rm.role = 'cashier' THEN 7
          ELSE 99
        END,
        COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.username), ''), CONCAT('User #', u.id::text))
      `,
      [rid]
    );

    const staffSalesRows = await req.qAll(
      `
      SELECT
        p.staff_user_id AS user_id,
        COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.username), ''), CONCAT('User #', p.staff_user_id::text), 'Unknown') AS staff_name,
        COUNT(*) FILTER (WHERE p.amount > 0)::int AS transactions_count,
        COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END), 0)::numeric AS sales_total,
        COALESCE(SUM(CASE WHEN p.amount < 0 THEN ABS(p.amount) ELSE 0 END), 0)::numeric AS refunds_total
      FROM public.payments p
      LEFT JOIN public.users u
        ON u.id = p.staff_user_id
      WHERE p.restaurant_id = $1
        AND p.created_at BETWEEN $2 AND $3
      GROUP BY p.staff_user_id, staff_name
      ORDER BY sales_total DESC, transactions_count DESC, staff_name ASC
      `,
      [rid, from, to]
    );

    const cashupByStaffRows = await req.qAll(
      `
      SELECT
        cs.closed_by_user_id AS user_id,
        COALESCE(
          NULLIF(TRIM(u.full_name), ''),
          NULLIF(TRIM(u.username), ''),
          CONCAT('User #', cs.closed_by_user_id::text),
          'Unknown'
        ) AS staff_name,
        COUNT(*)::int AS cashups_closed,
        COALESCE(SUM(COALESCE(cs.discrepancy, 0)), 0)::numeric AS total_discrepancy
      FROM public.cashup_sessions cs
      LEFT JOIN public.users u
        ON u.id = cs.closed_by_user_id
      WHERE cs.restaurant_id = $1
      GROUP BY cs.closed_by_user_id, staff_name
      ORDER BY cashups_closed DESC, staff_name ASC
      `,
      [rid]
    );

    const auditAggRows = await req.qAll(
      `
      SELECT
        a.user_id,
        COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.username), ''), CONCAT('User #', a.user_id::text), 'Unknown') AS staff_name,
        COUNT(*) FILTER (WHERE a.action = 'POS_TABLE_CLOSED')::int AS table_closures,
        COUNT(*) FILTER (WHERE a.action = 'POS_REFUND')::int AS refunds_count,
        COUNT(*) FILTER (WHERE a.action = 'PAYMENT_VOID')::int AS voids_count,
        COUNT(*) FILTER (WHERE a.action = 'POS_GROUPED_ORDER_CREATED')::int AS orders_created,
        COUNT(*) FILTER (WHERE a.action = 'POS_SPLIT_PAY')::int AS split_pays
      FROM public.audit_log a
      LEFT JOIN public.users u
        ON u.id = a.user_id
      WHERE a.restaurant_id = $1
        AND a.created_at BETWEEN $2 AND $3
      GROUP BY a.user_id, staff_name
      ORDER BY staff_name ASC
      `,
      [rid, from, to]
    );

    const recentActivityRows = await req.qAll(
      `
      SELECT
        a.id,
        a.user_id,
        COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.username), ''), CONCAT('User #', a.user_id::text), 'Unknown') AS staff_name,
        a.actor_role,
        a.action,
        a.entity,
        a.entity_id,
        a.meta,
        a.created_at
      FROM public.audit_log a
      LEFT JOIN public.users u
        ON u.id = a.user_id
      WHERE a.restaurant_id = $1
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 30
      `,
      [rid]
    );

    const staffMap = new Map();

    for (const row of staffRows || []) {
      staffMap.set(Number(row.user_id), {
        user_id: Number(row.user_id),
        member_id: Number(row.member_id),
        staff_name:
          row.full_name?.trim() ||
          row.username?.trim() ||
          `User #${row.user_id}`,
        username: row.username || null,
        full_name: row.full_name || null,
        role: row.role || "unknown",
        is_active: row.is_active === true || row.is_active === 1,
        joined_at: row.created_at,
        transactions_count: 0,
        sales_total: 0,
        refunds_total: 0,
        cashups_closed: 0,
        cashup_discrepancy_total: 0,
        table_closures: 0,
        refunds_count: 0,
        voids_count: 0,
        orders_created: 0,
        split_pays: 0,
      });
    }

    for (const row of staffSalesRows || []) {
      const id = Number(row.user_id || 0);
      if (!staffMap.has(id)) {
        staffMap.set(id, {
          user_id: id,
          member_id: null,
          staff_name: row.staff_name || `User #${id}`,
          username: null,
          full_name: null,
          role: "unknown",
          is_active: true,
          joined_at: null,
          transactions_count: 0,
          sales_total: 0,
          refunds_total: 0,
          cashups_closed: 0,
          cashup_discrepancy_total: 0,
          table_closures: 0,
          refunds_count: 0,
          voids_count: 0,
          orders_created: 0,
          split_pays: 0,
        });
      }
      const cur = staffMap.get(id);
      cur.transactions_count = num(row.transactions_count);
      cur.sales_total = num(row.sales_total);
      cur.refunds_total = num(row.refunds_total);
      staffMap.set(id, cur);
    }

    for (const row of cashupByStaffRows || []) {
      const id = Number(row.user_id || 0);
      if (!staffMap.has(id)) continue;
      const cur = staffMap.get(id);
      cur.cashups_closed = num(row.cashups_closed);
      cur.cashup_discrepancy_total = num(row.total_discrepancy);
      staffMap.set(id, cur);
    }

    for (const row of auditAggRows || []) {
      const id = Number(row.user_id || 0);
      if (!staffMap.has(id)) continue;
      const cur = staffMap.get(id);
      cur.table_closures = num(row.table_closures);
      cur.refunds_count = num(row.refunds_count);
      cur.voids_count = num(row.voids_count);
      cur.orders_created = num(row.orders_created);
      cur.split_pays = num(row.split_pays);
      staffMap.set(id, cur);
    }

    const staffList = Array.from(staffMap.values());

    const roleCounts = staffList.reduce((acc, row) => {
      const key = String(row.role || "unknown").toLowerCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const activeCount = staffList.filter((x) => x.is_active).length;
    const inactiveCount = staffList.length - activeCount;

    const riskFlags = staffList
      .map((row) => ({
        user_id: row.user_id,
        staff_name: row.staff_name,
        refunds_count: row.refunds_count,
        voids_count: row.voids_count,
        table_closures: row.table_closures,
        score:
          num(row.refunds_count) * 3 +
          num(row.voids_count) * 3 +
          num(row.table_closures) * 1,
      }))
      .sort((a, b) => b.score - a.score);

    const staff = {
      total_staff: staffList.length,
      active_staff: activeCount,
      inactive_staff: inactiveCount,
      role_counts: roleCounts,
      team: staffList,
      top_sales_staff: [...staffList]
        .sort((a, b) => b.sales_total - a.sales_total)
        .slice(0, 5),
      top_refund_staff: [...staffList]
        .sort((a, b) => b.refunds_total - a.refunds_total)
        .slice(0, 5),
      top_cashup_staff: [...staffList]
        .sort((a, b) => b.cashups_closed - a.cashups_closed)
        .slice(0, 5),
      risk_flags: riskFlags.slice(0, 10),
      recent_activity: (recentActivityRows || []).map((r) => ({
        id: r.id,
        user_id: r.user_id,
        staff_name: r.staff_name,
        actor_role: r.actor_role,
        action: r.action,
        entity: r.entity,
        entity_id: r.entity_id,
        meta: r.meta || null,
        created_at: r.created_at,
      })),
    };

    // ---------------------------
    // ALERTS
    // ---------------------------
    const alerts = buildAlerts({
      stock,
      orders,
      bookings,
      cashup,
      sales,
      staff,
      reports,
    });

    return res.json({
      range: { from, to },
      sales,
      orders,
      bookings,
      service,
      cashup,
      stock,
      reports,
      staff,
      alerts,
    });
  } catch (err) {
    console.error("❌ control-centre overview failed:", err);
    return res.status(500).json({
      error: "Failed to load control centre overview",
      detail: err?.message || String(err),
    });
  }
});

module.exports = router;