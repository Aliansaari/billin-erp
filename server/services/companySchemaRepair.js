/**
 * Per-company schema reconciliation
 * ─────────────────────────────────
 *
 * The boot migrations in server/index.js run against ONE connection — the
 * primary company's database. They never switch company context, so a second
 * or third company created later never receives them and drifts further
 * behind on every release. The symptom is brutal and confusing: opening that
 * company throws `column "..." does not exist`, so the company simply cannot
 * be used, on the desktop or the phone.
 *
 * Rewriting 2,800 lines of boot migrations into a per-company loop is a large
 * and risky change. This closes the gap from the other end instead: for every
 * active company, compare the Sequelize models against the actual database
 * and add ONLY what is missing.
 *
 * ── Strictly additive, by design ──
 *
 * CREATE TABLE for absent tables, ADD COLUMN for absent columns. Nothing is
 * ever dropped, renamed or retyped. A column whose type has changed is left
 * alone and logged — silently rewriting a column in an accounting database is
 * how you lose money, and a human should decide.
 *
 * A NOT NULL column with no default is added as NULLABLE: the alternative is
 * a failed ALTER on any table with existing rows, which would abort the whole
 * repair and leave the company broken. Nullable-but-present beats absent.
 */

const { Sequelize } = require('sequelize');
const Company = require('../models/Company');

/**
 * Open a bare connection to one company's database.
 *
 * Deliberately NOT getCompanyConnection(): that builds the full model layer,
 * which queries columns the drifted database is missing — so it throws before
 * any repair can happen. That is the exact trap this service exists to escape,
 * so it uses raw SQL only.
 */
function rawConnection(dbName) {
  return new Sequelize(
    dbName,
    process.env.DB_USER || 'postgres',
    process.env.DB_PASSWORD || 'postgres',
    {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      dialect: 'postgres',
      logging: false,
      pool: { max: 2, min: 0, idle: 5000 },
    },
  );
}

/** Full column catalogue: table -> { column -> {type, nullable, default} }. */
async function schemaOf(sequelize) {
  const [rows] = await sequelize.query(
    `SELECT table_name, column_name, data_type, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable, column_default, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  const out = {};
  for (const r of rows) {
    (out[r.table_name] ||= {})[r.column_name] = r;
  }
  return out;
}

/** Render a reference column's SQL type. */
function typeSql(col) {
  const t = col.data_type;
  if (t === 'character varying') {
    return col.character_maximum_length ? `varchar(${col.character_maximum_length})` : 'varchar';
  }
  if (t === 'numeric' && col.numeric_precision) {
    return `numeric(${col.numeric_precision},${col.numeric_scale || 0})`;
  }
  if (t === 'ARRAY') return `${String(col.udt_name).replace(/^_/, '')}[]`;
  if (t === 'USER-DEFINED') return col.udt_name;
  return t;
}

/**
 * Read a table's CREATE statement (columns, defaults, NOT NULL, primary key)
 * plus its indexes, straight from the reference database's catalogs.
 *
 * Catalog-driven rather than pg_dump: shelling out would need a client binary
 * whose major version matches the server, which is exactly the mismatch that
 * bit us on this machine.
 */
async function tableDdl(sequelize, table) {
  const [cols] = await sequelize.query(
    `SELECT column_name, data_type, character_maximum_length, numeric_precision,
            numeric_scale, is_nullable, column_default, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = :t
      ORDER BY ordinal_position`,
    { replacements: { t: table } },
  );
  if (!cols.length) return null;

  const defs = cols.map((c) => {
    // An auto-increment column's default is nextval('<table>_<col>_seq'), and
    // that sequence does not exist in the target database — copying the
    // default verbatim fails with `relation ... does not exist`. SERIAL says
    // the same thing while creating the sequence as a side effect.
    const isSerial = c.column_default && /^nextval\(/i.test(c.column_default);
    if (isSerial) {
      const serial = c.data_type === 'bigint' ? 'BIGSERIAL'
        : c.data_type === 'smallint' ? 'SMALLSERIAL' : 'SERIAL';
      return `"${c.column_name}" ${serial}`;
    }
    let d = `"${c.column_name}" ${typeSql(c)}`;
    if (c.column_default) d += ` DEFAULT ${c.column_default}`;
    if (c.is_nullable === 'NO') d += ' NOT NULL';
    return d;
  });

  const [pk] = await sequelize.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = :t::regclass AND i.indisprimary`,
    { replacements: { t: `public.${table}` } },
  );
  if (pk.length) defs.push(`PRIMARY KEY (${pk.map((r) => `"${r.attname}"`).join(', ')})`);

  const [idx] = await sequelize.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = :t`,
    { replacements: { t: table } },
  );

  return {
    create: `CREATE TABLE IF NOT EXISTS "${table}" (${defs.join(', ')})`,
    // Skip the primary-key index: CREATE TABLE already made it.
    indexes: idx
      .map((r) => r.indexdef)
      .filter((d) => !/_pkey\b/.test(d))
      .map((d) => d.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ')),
  };
}

/**
 * Bring `targetDb` up to the column set of `referenceDb`.
 *
 * The primary company is the reference because boot migrations do reach it —
 * so "matches company 1" is exactly "has had every migration applied".
 *
 * Strictly additive: CREATE missing tables, ADD missing columns. Never drops,
 * renames or retypes. A NOT NULL column with no default is added nullable,
 * because the alternative is a failed ALTER on a table with rows, which would
 * abort the repair and leave the company unusable.
 */
async function repairCompany(companyId, name, targetDb, referenceDb) {
  const result = { companyId, name, tablesCreated: [], columnsAdded: [], skipped: [] };
  if (targetDb === referenceDb) return result;   // the reference itself
  const missingTables = [];

  const ref = rawConnection(referenceDb);
  const tgt = rawConnection(targetDb);
  try {
    const refSchema = await schemaOf(ref);
    const tgtSchema = await schemaOf(tgt);

    for (const [table, cols] of Object.entries(refSchema)) {
      if (!tgtSchema[table]) {
        missingTables.push(table);
        continue;
      }
      for (const [colName, col] of Object.entries(cols)) {
        if (tgtSchema[table][colName]) continue;
        let sql = `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${colName}" ${typeSql(col)}`;
        if (col.column_default) sql += ` DEFAULT ${col.column_default}`;
        if (col.is_nullable === 'NO' && col.column_default) sql += ' NOT NULL';
        try {
          await tgt.query(sql);
          result.columnsAdded.push(`${table}.${colName}`);
        } catch (e) {
          result.skipped.push(`${table}.${colName}: ${e.message}`);
        }
      }
    }
  } finally {
    await ref.close().catch(() => {});
    await tgt.close().catch(() => {});
  }

  // ── Phase 2: create absent tables from the reference database's DDL ──
  //
  // Deliberately NOT via getCompanyConnection()/sync(). Building the model
  // layer runs the app's default-data SEEDER, which inserts rows — during an
  // earlier run that silently added two system ledger accounts to a company
  // that was only supposed to receive a schema fix. A repair must never write
  // business data, so this reads DDL out of the reference database's catalogs
  // and replays it. No models, no seeding, no side effects.
  if (missingTables.length) {
    const ref2 = rawConnection(referenceDb);
    const tgt2 = rawConnection(targetDb);
    try {
      for (const table of missingTables) {
        try {
          const ddl = await tableDdl(ref2, table);
          if (!ddl) { result.skipped.push(`table ${table}: could not read its definition`); continue; }
          await tgt2.query(ddl.create);
          for (const idx of ddl.indexes) await tgt2.query(idx).catch(() => {});
          result.tablesCreated.push(table);
          result.skipped = result.skipped.filter((m) => !m.startsWith(`table ${table} `));
        } catch (e) {
          result.skipped.push(`table ${table}: ${e.message}`);
        }
      }
    } finally {
      await ref2.close().catch(() => {});
      await tgt2.close().catch(() => {});
    }
  }

  return result;
}

/**
 * Reconcile every active company. Fire-and-forget from boot: a company that
 * cannot be repaired is logged and skipped, never allowed to stop the server.
 */
async function repairAll({ verbose = true } = {}) {
  const results = [];
  let companies = [];
  try {
    companies = await Company.findAll({ where: { is_active: true }, order: [['company_id', 'ASC']] });
  } catch (e) {
    console.error('[schema-repair] could not list companies:', e.message);
    return results;
  }

  // The primary company is the reference: boot migrations run against it.
  const primary = companies.find((c) => c.is_primary) || companies[0];
  if (!primary) return results;

  for (const c of companies) {
    try {
      const r = await repairCompany(c.company_id, c.name, c.db_name, primary.db_name);
      results.push(r);
      if (verbose && (r.tablesCreated.length || r.columnsAdded.length)) {
        console.log(
          `[schema-repair] company ${c.company_id} (${c.name}): `
          + `+${r.tablesCreated.length} table(s), +${r.columnsAdded.length} column(s)`,
        );
        for (const s of r.skipped) console.warn(`[schema-repair]   skipped ${s}`);
      }
    } catch (e) {
      console.error(`[schema-repair] company ${c.company_id} (${c.name}) failed:`, e.message);
      results.push({ companyId: c.company_id, name: c.name, error: e.message });
    }
  }
  return results;
}

module.exports = { repairAll, repairCompany };
