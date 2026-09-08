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
  runCanonicalAvailabilitySubmissionPg,
} = require('../migrations/canonicalAvailabilitySubmission.pg');

const {
  runCanonicalInventoryMenuPg,
} = require('../migrations/canonicalInventoryMenu.pg');

const {
  runCanonicalManualPortionsPg,
} = require('../migrations/canonicalManualPortions.pg');

const {
  runCanonicalMenuSchedulingPg,
} = require('../migrations/canonicalMenuScheduling.pg');

const {
  runCanonicalFinancialLedgerPg,
} = require('../migrations/canonicalFinancialLedger.pg');

const {
  runCanonicalEdgeFinancialIdentityPg,
} = require('../migrations/canonicalEdgeFinancialIdentity.pg');

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
  runCanonicalEdgeSyncFoundationPg,
} = require('../migrations/canonicalEdgeSyncFoundation.pg');

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

    /*
     * Existing installations must receive the
     * submission-aware availability upgrade BEFORE
     * canonicalInventoryMenu runs.
     *
     * This is intentionally independent because an
     * unrelated later inventory migration failure must
     * not prevent this required compatibility upgrade.
     */
    await runCanonicalAvailabilitySubmissionPg({
      pool,
    });

    await runCanonicalInventoryMenuPg({
      pool,
    });

    await runCanonicalManualPortionsPg({
      pool,
    });

    await runCanonicalMenuSchedulingPg({
      pool,
    });

    await runCanonicalFinancialLedgerPg({
      pool,
    });

    await runCanonicalEdgeFinancialIdentityPg({
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

    await runCanonicalEdgeSyncFoundationPg({
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
