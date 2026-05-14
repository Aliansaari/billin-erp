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

  // FY compliance fields on system_settings — mirrors the master
  // block in server/index.js so an existing per-company DB picks up
  // the new columns on first boot after upgrade. Idempotent.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'system_settings' AND column_name = 'fy_compliance_mode'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN fy_compliance_mode BOOLEAN DEFAULT false;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'system_settings' AND column_name = 'fy_soft_lock_date'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN fy_soft_lock_date DATE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'system_settings' AND column_name = 'fy_hard_lock_date'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN fy_hard_lock_date DATE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'system_settings' AND column_name = 'fy_require_override_password'
      ) THEN
        ALTER TABLE system_settings
          ADD COLUMN fy_require_override_password BOOLEAN DEFAULT false;
      END IF;
    END $$;
  `);

  // compliance_audit_logs — column shape matches the Sequelize model in
  // server/models/ComplianceAuditLog.js. JSONB columns hold the
  // before/after diff snapshots; the 4 indexes cover the common filter
  // axes used by the viewer (by date, by event_type, by user, by
  // target). Created explicitly here (not via Sequelize sync) because
  // the bootstrap path doesn't call sync — it only invokes this
  // migration runner for existing company DBs.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_name = 'compliance_audit_logs') THEN
        CREATE TABLE compliance_audit_logs (
          audit_log_id      SERIAL PRIMARY KEY,
          event_type        VARCHAR(40) NOT NULL,
          event_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          user_id           INTEGER,
          user_name         VARCHAR(150),
          user_role         VARCHAR(60),
          target_type       VARCHAR(40),
          target_id         INTEGER,
          target_label      VARCHAR(255),
          target_date       DATE,
          reason            TEXT,
          from_value        JSONB,
          to_value          JSONB,
          is_hard_override  BOOLEAN DEFAULT false,
          metadata          JSONB
        );
        CREATE INDEX idx_cal_event_type ON compliance_audit_logs(event_type);
        CREATE INDEX idx_cal_event_at   ON compliance_audit_logs(event_at);
        CREATE INDEX idx_cal_user       ON compliance_audit_logs(user_id);
        CREATE INDEX idx_cal_target     ON compliance_audit_logs(target_type, target_id);
      END IF;
    END $$;
  `);

  // Back-dated entry guard columns — sync() handles a from-scratch
  // company DB via the current model defs, but legacy company DBs
  // that predate the model edit still need a column ADD. Idempotent.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings'
                       AND column_name='allow_backdated_entries') THEN
        ALTER TABLE system_settings
          ADD COLUMN allow_backdated_entries BOOLEAN NOT NULL DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='roles'
                       AND column_name='can_enter_backdated') THEN
        ALTER TABLE roles
          ADD COLUMN can_enter_backdated BOOLEAN NOT NULL DEFAULT true;
      END IF;
    END $$;
  `);
}

module.exports = { runCompanySchemaMigrations };
