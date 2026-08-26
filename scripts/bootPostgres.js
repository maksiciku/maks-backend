// scripts/bootPostgres.js

const {
  qAll,
  qGet,
  qRun,
  pool,
} = require('../db/pg');

const {
  runCanonicalFoundationPg,
} = require('../migrations/canonicalFoundation.pg');

const {
  runCanonicalOperationalPg,
} = require('../migrations/canonicalOperational.pg');

const {
  runCanonicalOrderLifecyclePg,
} = require('../migrations/canonicalOrderLifecycle.pg');

const {
  runCanonicalInventoryMenuPg,
} = require('../migrations/canonicalInventoryMenu.pg');

const {
  runCanonicalMenuSchedulingPg,
} = require('../migrations/canonicalMenuScheduling.pg');

const {
  runCanonicalFinancialLedgerPg,
} = require('../migrations/canonicalFinancialLedger.pg');

const {
  runCanonicalCommercialPricingPg,
} = require('../migrations/canonicalCommercialPricing.pg');

const {
  runCanonicalBookingTablesPg,
} = require('../migrations/canonicalBookingTables.pg');

const {
  runCanonicalPlatformAuditDevicesPg,
} = require('../migrations/canonicalPlatformAuditDevices.pg');

const {
  runCanonicalEdgeControlPlanePg,
} = require('../migrations/canonicalEdgeControlPlane.pg');

const {
  runBootMigrationsPg,
} = require('../migrations/boot.pg');

const {
  runRestaurantFkHardeningPg,
} = require('../migrations/restaurantFkHardening.pg');

async function main() {
  console.log(
    '🚀 Booting Postgres schema...'
  );

  console.log(
    'DATABASE_URL:',
    process.env.DATABASE_URL
      ? '(set)'
      : '(missing)'
  );

  try {
    await runCanonicalFoundationPg({
      qRun,
      qGet,
    });

    await runCanonicalOperationalPg({
      qRun,
      qGet,
    });

    await runCanonicalOrderLifecyclePg({
      pool,
    });

    await runCanonicalInventoryMenuPg({
      pool,
    });

    await runCanonicalMenuSchedulingPg({
      pool,
    });

    await runCanonicalFinancialLedgerPg({
      pool,
    });

    await runCanonicalCommercialPricingPg({
      pool,
    });

    await runCanonicalBookingTablesPg({
      pool,
    });

    await runCanonicalPlatformAuditDevicesPg({
      pool,
    });

    await runCanonicalEdgeControlPlanePg({
      pool,
    });

    await runBootMigrationsPg({
      qAll,
      qGet,
      qRun,
    });

    await runRestaurantFkHardeningPg({
      pool,
    });

    console.log(
      '✅ Schema ready.'
    );
  } catch (e) {
    console.error(
      '❌ Boot failed:',
      e.message
    );

    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}
