// migrations/restaurantFkHardening.pg.js

const RESTAURANT_FKS = [
  ['bookings', 'bookings_restaurant_id_fkey'],
  ['invoices', 'invoices_restaurant_id_fkey'],
  ['kds_item_state', 'kds_item_state_restaurant_id_fkey'],
  ['kds_station_ack', 'kds_station_ack_restaurant_id_fkey'],
  ['meal_ingredients', 'meal_ingredients_restaurant_id_fkey'],
  ['menu_items', 'menu_items_restaurant_id_fkey'],
  ['order_batches', 'order_batches_restaurant_id_fkey'],
  ['org_receipt_settings', 'org_receipt_settings_restaurant_id_fkey'],
  ['payments', 'payments_restaurant_id_fkey'],
  ['payment_settlements', 'payment_settlements_restaurant_id_fkey'],
  ['pos_device_sessions', 'pos_device_sessions_restaurant_id_fkey'],
  ['pos_table_sessions', 'pos_table_sessions_restaurant_id_fkey'],
  ['reports', 'reports_restaurant_id_fkey'],
  ['table_map', 'table_map_restaurant_id_fkey'],
];

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function getOne(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0] || null;
}

async function getAll(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows;
}

async function requireTable(client, table) {
  const row = await getOne(
    client,
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = $1
      AND table_type = 'BASE TABLE'
    LIMIT 1
    `,
    [table]
  );

  if (!row) {
    throw new Error(
      `Restaurant FK hardening cannot continue: public.${table} does not exist.`
    );
  }
}

async function requireColumn(client, table, column) {
  const row = await getOne(
    client,
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [table, column]
  );

  if (!row) {
    throw new Error(
      `Restaurant FK hardening cannot continue: public.${table}.${column} does not exist.`
    );
  }
}

async function getNamedConstraint(client, table, constraintName) {
  return getOne(
    client,
    `
    SELECT
      c.conname,
      c.contype,
      c.convalidated,
      c.confdeltype,
      cardinality(c.conkey) AS child_column_count,
      cardinality(c.confkey) AS parent_column_count,
      child_col.attname AS child_column,
      parent_ns.nspname AS parent_schema,
      parent_rel.relname AS parent_table,
      parent_col.attname AS parent_column
    FROM pg_constraint c
    JOIN pg_class child_rel
      ON child_rel.oid = c.conrelid
    JOIN pg_namespace child_ns
      ON child_ns.oid = child_rel.relnamespace
    LEFT JOIN pg_class parent_rel
      ON parent_rel.oid = c.confrelid
    LEFT JOIN pg_namespace parent_ns
      ON parent_ns.oid = parent_rel.relnamespace
    LEFT JOIN pg_attribute child_col
      ON child_col.attrelid = c.conrelid
     AND child_col.attnum = c.conkey[1]
    LEFT JOIN pg_attribute parent_col
      ON parent_col.attrelid = c.confrelid
     AND parent_col.attnum = c.confkey[1]
    WHERE child_ns.nspname = 'public'
      AND child_rel.relname = $1
      AND c.conname = $2
    LIMIT 1
    `,
    [table, constraintName]
  );
}

async function getRestaurantIdForeignKeys(client, table) {
  return getAll(
    client,
    `
    SELECT
      c.conname,
      c.contype,
      c.convalidated,
      c.confdeltype,
      cardinality(c.conkey) AS child_column_count,
      cardinality(c.confkey) AS parent_column_count,
      child_col.attname AS child_column,
      parent_ns.nspname AS parent_schema,
      parent_rel.relname AS parent_table,
      parent_col.attname AS parent_column
    FROM pg_constraint c
    JOIN pg_class child_rel
      ON child_rel.oid = c.conrelid
    JOIN pg_namespace child_ns
      ON child_ns.oid = child_rel.relnamespace
    JOIN pg_class parent_rel
      ON parent_rel.oid = c.confrelid
    JOIN pg_namespace parent_ns
      ON parent_ns.oid = parent_rel.relnamespace
    JOIN pg_attribute child_col
      ON child_col.attrelid = c.conrelid
     AND child_col.attnum = c.conkey[1]
    JOIN pg_attribute parent_col
      ON parent_col.attrelid = c.confrelid
     AND parent_col.attnum = c.confkey[1]
    WHERE c.contype = 'f'
      AND child_ns.nspname = 'public'
      AND child_rel.relname = $1
      AND child_col.attname = 'restaurant_id'
      AND cardinality(c.conkey) = 1
      AND cardinality(c.confkey) = 1
    ORDER BY c.conname
    `,
    [table]
  );
}

function isCorrectRestaurantFk(row) {
  return Boolean(
    row &&
      row.contype === 'f' &&
      Number(row.child_column_count) === 1 &&
      Number(row.parent_column_count) === 1 &&
      row.child_column === 'restaurant_id' &&
      row.parent_schema === 'public' &&
      row.parent_table === 'restaurants' &&
      row.parent_column === 'id' &&
      row.confdeltype === 'c'
  );
}

async function countOrphans(client, table) {
  const row = await getOne(
    client,
    `
    SELECT COUNT(*)::bigint AS orphan_count
    FROM public.${quoteIdent(table)} t
    LEFT JOIN public.${quoteIdent('restaurants')} r
      ON r.id = t.${quoteIdent('restaurant_id')}
    WHERE t.${quoteIdent('restaurant_id')} IS NOT NULL
      AND r.id IS NULL
    `
  );

  return Number(row?.orphan_count || 0);
}

async function buildPlan(client) {
  await requireTable(client, 'restaurants');
  await requireColumn(client, 'restaurants', 'id');

  const plan = [];

  for (const [table, constraintName] of RESTAURANT_FKS) {
    await requireTable(client, table);
    await requireColumn(client, table, 'restaurant_id');

    const orphanCount = await countOrphans(client, table);

    if (orphanCount > 0) {
      throw new Error(
        `Restaurant FK hardening stopped: public.${table} has ${orphanCount} orphan ` +
          `restaurant_id row(s). No data was deleted.`
      );
    }

    const named = await getNamedConstraint(
      client,
      table,
      constraintName
    );

    if (named) {
      if (!isCorrectRestaurantFk(named)) {
        throw new Error(
          `Constraint public.${table}.${constraintName} exists but is not the expected ` +
            `restaurant_id -> public.restaurants(id) ON DELETE CASCADE foreign key.`
        );
      }

      plan.push({
        table,
        constraintName,
        action: named.convalidated ? 'verify' : 'validate',
      });

      continue;
    }

    const competing = await getRestaurantIdForeignKeys(
      client,
      table
    );

    if (competing.length > 0) {
      const names = competing
        .map((row) => row.conname)
        .join(', ');

      throw new Error(
        `public.${table}.restaurant_id already has foreign key constraint(s) [${names}], ` +
          `but ${constraintName} is missing. Refusing to add a competing constraint automatically.`
      );
    }

    plan.push({
      table,
      constraintName,
      action: 'add',
    });
  }

  return plan;
}

async function applyPlan(client, plan) {
  for (const item of plan) {
    const {
      table,
      constraintName,
      action,
    } = item;

    if (action === 'add') {
      console.log(
        `🔗 Adding ${constraintName}: public.${table}.restaurant_id -> public.restaurants(id) ON DELETE CASCADE`
      );

      await client.query(`
        ALTER TABLE public.${quoteIdent(table)}
        ADD CONSTRAINT ${quoteIdent(constraintName)}
        FOREIGN KEY (${quoteIdent('restaurant_id')})
        REFERENCES public.${quoteIdent('restaurants')} (${quoteIdent('id')})
        ON DELETE CASCADE
        NOT VALID
      `);
    }

    if (
      action === 'add' ||
      action === 'validate'
    ) {
      console.log(
        `✅ Validating ${constraintName}...`
      );

      await client.query(`
        ALTER TABLE public.${quoteIdent(table)}
        VALIDATE CONSTRAINT ${quoteIdent(constraintName)}
      `);
    }

    const verified = await getNamedConstraint(
      client,
      table,
      constraintName
    );

    if (
      !verified ||
      !isCorrectRestaurantFk(verified) ||
      !verified.convalidated
    ) {
      throw new Error(
        `Final verification failed for public.${table}.${constraintName}.`
      );
    }

    console.log(
      `🛡️ ${constraintName} verified`
    );
  }
}

async function runRestaurantFkHardeningPg({
  pool,
}) {
  if (
    !pool ||
    typeof pool.connect !== 'function'
  ) {
    throw new Error(
      'Restaurant FK hardening requires the PostgreSQL pool.'
    );
  }

  console.log(
    '🛡️ Running restaurant foreign-key hardening...'
  );

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const plan = await buildPlan(client);

    await applyPlan(
      client,
      plan
    );

    await client.query('COMMIT');

    console.log(
      `✅ Restaurant FK hardening complete (${RESTAURANT_FKS.length}/${RESTAURANT_FKS.length})`
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(
        '❌ FK hardening rollback failed:',
        rollbackError.message
      );
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  RESTAURANT_FKS,
  runRestaurantFkHardeningPg,
};
