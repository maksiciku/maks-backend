// scripts/bootPostgres.js

const {
  qAll,
  qGet,
  qRun,
  pool,
} = require('../db/pg');

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
    await runBootMigrationsPg({
      qAll,
      qGet,
      qRun,
    });

    await runRestaurantFkHardeningPg({
      pool,
    });

    console.log('✅ Schema ready.');
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
