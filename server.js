// backend/server.js
require("dotenv").config();
console.log("ENV DB_DRIVER =", process.env.DB_DRIVER);
console.log("ENV DATABASE_URL =", process.env.DATABASE_URL);

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");

const {
  rateLimit,
  ipKeyGenerator,
} = require("express-rate-limit");

// ✅ SINGLE source of truth DB (dbCompat.js)
// NOTE: you currently require "./db" — keep it as you asked (no removals).
// If your "./db" is actually dbCompat wrapper, perfect.
const dbWrapper = require("./db"); // ✅ keep
// or: const dbWrapper = require("./dbCompat");

// keep same variable names your server.js already uses
const allAsync = dbWrapper.qAll;
const getAsync = dbWrapper.qGet;
const runAsync = dbWrapper.qRun;

// `req.db` should be a db handle. For PG we use pool, for SQLite we use db.
const db = dbWrapper.db || dbWrapper.pool || null;

const kind = dbWrapper.kind;

const { authenticateToken } = require("./middleware/authMiddleware");
const tenantGuard = require("./middleware/tenantGuard");
const { loadMembership } = require("./middleware/tenantMembership");
const orderingHubRoutes = require("./routes/orderingHubRoutes");
const orderingHistoryRoutes = require("./routes/orderingHistoryRoutes");
const bookingRoutes = require('./routes/bookingRoutes');
const publicBookingRoutes = require("./routes/publicBookingRoutes");
const { startBookingAutoReserveJob } = require("./jobs/bookingAutoReserveJob");
const scanRoutes = require("./routes/scanRoutes");
const buildAllergensRoutes = require("./routes/allergensRoutes");
// ✅ FIX: you were using userRoutes but never required it
const userRoutes = require("./routes/userRoutes");
const buildPosTableSessionRoutes = require("./routes/posTableSessionRoutes");
const ccAuthRoutes = require("./routes/cc/ccAuthRoutes");
const ccCustomerRoutes = require("./routes/cc/ccCustomerRoutes");
const ccSystemRoutes = require("./routes/cc/ccSystemRoutes");
const ccAuditRoutes = require("./routes/cc/ccAuditRoutes");
// ✅ REQUIRED: bring in routes that you use
const { router: posRoutes, initPosOrders } = require("./routes/posRoutes");
const voucherRoutes = require("./routes/voucherRoutes");
const { router: happyHourRoutes, initHappyHourTable } = require("./routes/happyHourRoutes");
const pricingRulesRoutes = require("./routes/pricingRoutes");
const publicQrRoutes = require("./routes/publicQrRoutes");
const stripeRoutes = require("./routes/stripeRoutes");
const platformSupplierRoutes = require("./routes/platformSupplierRoutes");
const itemsSettingsRoutes = require("./routes/itemsSettingsRoutes");

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";
const itemImageRoutes = require("./routes/itemImageRoutes");
console.log(`🔌 DB driver: ${String(kind || "").toUpperCase()}`);
if (kind !== "pg" && dbWrapper.DB_PATH) {
  console.log(`🗄️  SQLite file: ${dbWrapper.DB_PATH}`);
}

const app = express();

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);

      const allowedExact = new Set([
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://192.168.1.195",
        "http://192.168.1.195:3000",
        "https://maksos.co.uk",
        "http://maksos.co.uk",
        "https://www.maksos.co.uk",
        "http://www.maksos.co.uk",
      ]);

      const isLanDev =
        /^http:\/\/192\.168\.\d+\.\d+$/.test(origin) ||
        /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin);

      const isTenDev =
        /^http:\/\/10\.\d+\.\d+\.\d+$/.test(origin) ||
        /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/.test(origin);

      const is172Dev =
        /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(origin) ||
        /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/.test(origin);

      if (allowedExact.has(origin) || isLanDev || isTenDev || is172Dev) {
        console.log("✅ CORS allowed:", origin);
        return cb(null, true);
      }

      console.log("❌ CORS blocked:", origin);
      return cb(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

/*
  ✅ Stripe webhook raw body protection.
  This MUST be before express.json().
  It only affects webhook URLs, not normal checkout routes.
*/
app.use(
  ["/billing/webhook", "/stripe/webhook", "/api/stripe/webhook"],
  express.raw({ type: "application/json" })
);

// =====================================================
// GLOBAL REQUEST BODY BOUNDARY
// =====================================================
//
// Stripe webhook raw bodies are already handled above.
//
// Everything else receives a bounded JSON parser.
// 100kb is deliberately explicit rather than relying on
// Express/body-parser defaults.
//
app.use(
  express.json({
    limit: "100kb",
  })
);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.set("trust proxy", 1);

// =====================================================
// PUBLIC MUTATION RATE LIMITS
// =====================================================
//
// These protect WRITE endpoints only.
//
// Public menu/category/restaurant reads remain unaffected.
//
// We scope QR orders by:
//   client IP + restaurant
//
// and bookings by:
//   client IP + restaurant
//
// so traffic for one venue does not consume another
// venue's mutation allowance.
//
// 30 submissions / 10 seconds is deliberately a BURST
// boundary rather than an overly restrictive normal-use
// hourly quota.
//
function publicRateKey(
  req,
  restaurantId
) {
  const ip =
    ipKeyGenerator(
      req.ip || ""
    );

  return [
    ip,
    String(
      restaurantId ||
      "unknown"
    ),
  ].join(":");
}

const publicQrOrderLimiter =
  rateLimit({
    windowMs:
      10 * 1000,

    limit:
      30,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,

    keyGenerator(req) {
      return publicRateKey(
        req,
        req.params
          ?.restaurantId
      );
    },

    handler(_req, res) {
      return res
        .status(429)
        .json({
          error:
            "Too many order requests. Please wait a moment and try again.",
        });
    },
  });

const publicBookingLimiter =
  rateLimit({
    windowMs:
      10 * 1000,

    limit:
      30,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,

    keyGenerator(req) {
      const rid =
        req.headers[
          "x-venue-rid"
        ] ||
        req.query
          ?.restaurant_id ||
        req.body
          ?.restaurant_id ||
        "unknown";

      return publicRateKey(
        req,
        rid
      );
    },

    handler(_req, res) {
      return res
        .status(429)
        .json({
          error:
            "Too many booking requests. Please wait a moment and try again.",
        });
    },
  });

// attach db helpers to req
app.use((req, _res, next) => {
  req.db = db;
  req.qAll = allAsync;
  req.qGet = getAsync;
  req.qRun = runAsync;
  req.kind = kind;
  next();
});

app.use((req, _res, next) => {
  const rid = req.headers["x-tenant-rid"] || req.headers["x-venue-rid"];
  console.log(
    `↗ ${req.method} ${req.url}  rid=${rid || "-"} auth=${
      req.headers.authorization ? "yes" : "no"
    }`
  );
  next();
});

// static uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ----- PUBLIC ROUTES -----
app.get("/health", (_req, res) => res.json({ ok: true }));
const authRoutes = require("./routes/authRoutes");

/*
 * =====================================================
 * AUTH ABUSE PROTECTION
 * =====================================================
 *
 * Login:
 * - tighter limiter against password guessing
 *
 * Registration:
 * - tighter limiter against automated tenant creation
 *
 * Both legacy and /auth/* paths are protected below.
 * =====================================================
 */

const loginLimiter =
  rateLimit({
    windowMs:
      10 * 60 * 1000,

    limit:
      20,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,

    handler(_req, res) {
      return res
        .status(429)
        .json({
          error:
            "Too many login attempts. Please wait and try again.",
        });
    },
  });

const registrationLimiter =
  rateLimit({
    windowMs:
      60 * 60 * 1000,

    limit:
      10,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,

    handler(_req, res) {
      return res
        .status(429)
        .json({
          error:
            "Too many registration attempts. Please wait and try again.",
        });
    },
  });

app.use(
  [
    "/login",
    "/auth/login",
  ],
  loginLimiter
);

app.use(
  [
    "/register-restaurant",
    "/auth/register-restaurant",
  ],
  registrationLimiter
);


// ✅ keep legacy endpoints working: /login, /register-restaurant
app.use("/", authRoutes);

// ✅ also support new endpoints: /auth/login, /auth/register-restaurant
app.use("/auth", authRoutes);
app.use("/pos-auth", require("./routes/posAuth"));
app.use("/cc-auth", ccAuthRoutes);
app.use("/cc/customers", ccCustomerRoutes);
app.use("/cc/system", ccSystemRoutes);
app.use("/cc/audit", ccAuditRoutes);

app.use(
  "/platform-suppliers",
  platformSupplierRoutes
);

/*
 * =====================================================
 * PUBLIC QR ORDER WRITE PROTECTION
 * =====================================================
 *
 * The limiter runs before the QR router only for POST
 * /:restaurantId/order.
 *
 * GET categories/items/settings remain unaffected.
 */
app.use(
  "/public/qr/:restaurantId/order",
  (req, res, next) => {
    if (
      req.method !==
      "POST"
    ) {
      return next();
    }

    return publicQrOrderLimiter(
      req,
      res,
      next
    );
  }
);

app.use(
  "/public/qr",
  publicQrRoutes
);

app.use(
  "/menu-items",
  require("./routes/menuItemsRoutes")
);

app.use(
  "/stripe",
  stripeRoutes
);

app.use(
  "/api/stripe",
  stripeRoutes
);

app.use(
  "/billing",
  stripeRoutes
);

/*
 * =====================================================
 * PUBLIC BOOKING WRITE PROTECTION
 * =====================================================
 */
app.use(
  "/public/bookings",
  (req, res, next) => {
    if (
      req.method !==
      "POST"
    ) {
      return next();
    }

    return publicBookingLimiter(
      req,
      res,
      next
    );
  }
);

app.use(
  "/public",
  publicBookingRoutes
);



// ✅ keep this (single place). DO NOT re-add authenticateToken per-route unless you truly need it.
app.use(authenticateToken);

// ----- SIMPLE tenantRid helper (single-restaurant mode) -----
// ✅ keep, but "membership wall" may overwrite/validate; this ensures req.tenantRid always exists.
app.use((req, _res, next) => {
  const userRid = Number(req.user?.restaurant_id || 0);
  if (userRid) req.tenantRid = userRid;
  next();
});


// ----- TENANT WALL (optional, if you use it) -----
// ✅ keep your code, but don’t run it automatically unless you want it on now.
// if (tenantGuard) {
 app.use(tenantGuard);
// }

// ✅✅✅ MEMBERSHIP WALL (THIS IS THE IMPORTANT FIX)
// You asked: "any route or any old button etc we connect should be connected to these"
// So: after token auth, we apply loadMembership ONCE for everything protected.
app.use(loadMembership);

const requireTenant = require("./middleware/requireTenant");
app.use(requireTenant);

// If you still want legacy online orders mounted, keep it, but DO NOT break app if ctx missing.
// (You can wire ctx properly later.)

// ----- PROTECTED ROUTES -----
app.use("/meals", require("./routes/meals"));
app.use("/stock", require("./routes/stockRoutes"));
app.use("/tables", require("./routes/tables"));
app.use("/categories", require("./routes/categoriesRoutes"));
app.use("/suppliers", require("./routes/supplierRoutes"));
app.use("/table-map", require("./routes/tableMapRoutes"));
app.use("/zones", require("./routes/zones"));
app.use("/audit", require("./routes/auditRoutes"));
app.use("/org", require("./routes/orgRoutes"));
app.use("/", orderingHubRoutes);
app.use("/ordering-history", orderingHistoryRoutes);
app.use("/desserts", require("./routes/dessertsRoutes")); // ✅ new
app.use("/drinks", require("./routes/drinksRoutes"));
app.use("/cashup", require("./routes/cashupRoutes"));
app.use("/items-settings", itemsSettingsRoutes);
app.use("/payments", require("./routes/paymentRoutes"));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use("/invoices", tenantGuard, require("./routes/invoiceRoutes")); // tenantGuard must set req.tenantRid
// ✅ MAIN POS/KDS source of truth
// ✅ FIX: remove duplicated authenticateToken/loadMembership here (already applied globally above)
// (Keeping routes mounted exactly as you had them, just without double middleware)
app.use("/users", userRoutes);
app.use("/vouchers", voucherRoutes);
const kdsRoutes = require("./routes/kdsRoutes");
 app.use("/pos", kdsRoutes);      // ✅ frontend uses /pos/...
 app.use("/kds", kdsRoutes);      // ✅ optional alias during transition
 app.use("/orders", posRoutes);   // ✅ keep POS/bills legacy if you want
 app.use("/reports", require("./routes/reports"));
app.use("/takeaway", require("./routes/takeawayRoutes"));
 app.use('/bookings', bookingRoutes);
 app.use("/happy-hour", happyHourRoutes);
app.use("/", pricingRulesRoutes);
 app.use("/control-centre", require("./routes/controlCentreRoutes"));
 app.use("/menu-import", require("./routes/menuImportRoutes"));
 app.use("/menu-groups", require("./routes/menuGroupRoutes"));
app.use("/", scanRoutes);

require("./routes/checklistRoutes")(app, {
  db,
  pool: db,
  authenticateToken,
});
app.use(
  buildAllergensRoutes({
    db: { qAll: allAsync },
    authenticateToken,
    tenantGuard
  })
);
app.use("/device", require("./routes/deviceHeartbeatRoutes"));
app.use("/pos", buildPosTableSessionRoutes({
  db:{ qGet:getAsync, qRun:runAsync },
  authenticateToken,
  tenantGuard
}));
app.use("/item-images", itemImageRoutes);
// keep the old system accessible but not used by KDS/POS
// (ONLY mount if you actually pass ctx somewhere else)


// ✅ match LiveOrdersPage which reads res.data.delay
app.get("/kitchen/estimated-delay", (req, res) => {
  res.json({ delay: null });
});

// 404 + error handlers (MUST BE LAST)
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(
  (
    err,
    _req,
    res,
    _next
  ) => {
    /*
     * =================================================
     * REQUEST BODY PARSER ERRORS
     * =================================================
     *
     * These are client-input failures, not server
     * failures.
     */

    if (
      err?.type ===
        "entity.too.large" ||
      Number(
        err?.status
      ) === 413 ||
      Number(
        err?.statusCode
      ) === 413
    ) {
      return res
        .status(413)
        .json({
          error:
            "Request body too large.",
        });
    }

    if (
      err?.type ===
        "entity.parse.failed" ||
      (
        err instanceof
          SyntaxError &&
        Number(
          err?.status
        ) === 400
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Invalid JSON body.",
        });
    }

    console.error(
      "❌ Server error:",
      err
    );

    return res
      .status(500)
      .json({
        error:
          "Server error",
      });
  }
);

async function cleanupExpiredSingleUseVouchers() {
  try {
    await runAsync(`
      DELETE FROM vouchers
      WHERE usage_mode = 'single'
        AND active = FALSE
        AND redeemed_at IS NOT NULL
        AND redeemed_at < NOW() - INTERVAL '30 days'
    `);

    console.log("🧹 Cleaned old single-use vouchers");
  } catch (err) {
    console.error("❌ Voucher cleanup failed:", err);
  }
}

function listRoutesVerbose(app) {
  const routes = [];

  function walk(stack, prefix = "") {
    stack.forEach((layer) => {
      if (layer.route?.path) {
        const methods = Object.keys(layer.route.methods)
          .map((m) => m.toUpperCase())
          .join(",");
        routes.push(`${methods.padEnd(10)} ${prefix}${layer.route.path}`);
        return;
      }

      if (layer.name === "router" && layer.handle?.stack) {
        // Try to extract the mount path from regexp
        const match = layer.regexp
          ?.toString()
          ?.match(/^\/\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)\/i$/);
        const mount = match ? `/${match[1].replace(/\\\//g, "/")}` : "";
        walk(layer.handle.stack, `${prefix}${mount}`);
      }
    });
  }

  walk(app._router.stack, "");
  return routes.sort();
}

function findDuplicates(routes) {
  const map = new Map();
  for (const r of routes) map.set(r, (map.get(r) || 0) + 1);
  return [...map.entries()].filter(([, c]) => c > 1);
}

const allRoutes = listRoutesVerbose(app);
console.log("\n=== ROUTES (FULL) ===");
allRoutes.forEach((r) => console.log(r));

const dupes = findDuplicates(allRoutes);
console.log("\n=== DUPLICATES (FULL) ===");
if (!dupes.length) console.log("✅ none");
else dupes.forEach(([r, c]) => console.log(`❌ ${r}  x${c}`));

async function boot() {
  await initPosOrders();
  await cleanupExpiredSingleUseVouchers();
  await initHappyHourTable();

  // Background jobs only run when MAKS is started normally.
  startBookingAutoReserveJob(db);

  const voucherCleanupTimer = setInterval(
    cleanupExpiredSingleUseVouchers,
    24 * 60 * 60 * 1000
  );

  const server = app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `🚀 Debug server on http://${HOST}:${PORT}`
      );
    }
  );

  return {
    server,
    voucherCleanupTimer,
  };
}

/*
 * IMPORTANT:
 *
 * npm start / node server.js
 *      -> starts MAKS normally
 *
 * require("./server")
 *      -> exposes Express app for automated tests
 *         WITHOUT opening a port or starting background jobs
 */
if (require.main === module) {
  boot().catch((e) => {
    console.error("❌ Boot failed:", e);
    process.exit(1);
  });
}

module.exports = {
  app,
  boot,
};
