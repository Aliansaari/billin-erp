/**
 * Run the schema migration for a per-company Postgres database.
 *
 * For a freshly-created company DB:
 *   sequelize.sync({ alter: false }) creates every table from the
 *   current model definitions, including all columns and indexes
 *   declared in the model files. Because the models reflect the
 *   current schema, sync() is sufficient to produce a complete
 *   schema for a NEW company.
 *
 * The existing IF NOT EXISTS ALTER TABLE blocks in server/index.js
 * are deliberately NOT replayed here — those are backfills for
 * legacy single-DB installs that predate columns added later. A
 * brand-new company DB built from current models doesn't need them.
 *
 * If a column ever lands in a migration WITHOUT being added to the
 * model, this function will need that column added explicitly. The
 * smoke test runs `getCompanyConnection(2)` against a fresh DB and
 * fails fast if any controller hits a missing column — so any drift
 * surfaces during testing, not in production.
 */

async function runCompanySchemaMigrations(sequelize) {
  // sequelize.sync was already called by the caller; this function adds
  // tables, types, and indexes that aren't covered by the Sequelize
  // model definitions but ARE part of the live schema in master.
  //
  // Each block is wrapped in IF NOT EXISTS so re-running is idempotent.

  // bill_payment_allocations — links a payments_receipts row to one
  // or more bills with an allocated_amount. Used by FIFO auto-allocation
  // and manual receipt-against-bill flows. Mirrors the master block in
  // server/index.js. Without this table, any sales bill creation that
  // produces a receipt fails on FK lookup.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_name='bill_payment_allocations') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_bill_payment_allocations_bill_type') THEN
          CREATE TYPE enum_bill_payment_allocations_bill_type AS ENUM ('Sales', 'Purchase');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_bill_payment_allocations_method') THEN
          CREATE TYPE enum_bill_payment_allocations_method AS ENUM (
            'fifo_auto', 'manual', 'auto_from_bill', 'import_excel', 'import_tally', 'backfill_fifo'
          );
        END IF;
        CREATE TABLE bill_payment_allocations (
          allocation_id      SERIAL PRIMARY KEY,
          transaction_id     INTEGER NOT NULL REFERENCES payments_receipts(transaction_id) ON DELETE CASCADE,
          bill_type          enum_bill_payment_allocations_bill_type NOT NULL,
          bill_id            INTEGER NOT NULL,
          allocated_amount   NUMERIC(15,2) NOT NULL CHECK (allocated_amount > 0),
          allocation_method  enum_bill_payment_allocations_method NOT NULL DEFAULT 'manual',
          created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
        CREATE INDEX idx_bpa_transaction ON bill_payment_allocations(transaction_id);
        CREATE INDEX idx_bpa_bill        ON bill_payment_allocations(bill_type, bill_id);
      END IF;
    END $$;
  `);

  // payments_receipts.source_bill_id — used by the auto-receipt path
  // when a credit sale auto-creates a receipt. The CREATE TABLE for
  // payments_receipts is via Sequelize sync, but this column is added
  // post-hoc via the Two-way Ledger migration block — replay it here
  // for fresh company DBs.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='payments_receipts' AND column_name='source_bill_id') THEN
        ALTER TABLE payments_receipts ADD COLUMN source_bill_id INTEGER;
        CREATE INDEX idx_payments_receipts_source_bill
          ON payments_receipts(source_bill_id) WHERE source_bill_id IS NOT NULL;
      END IF;
    END $$;
  `);
}

module.exports = { runCompanySchemaMigrations };
