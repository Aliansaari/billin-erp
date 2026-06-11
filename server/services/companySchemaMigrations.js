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

  // products.is_tax_inclusive (audit GST-C4). Mirrors the master block
  // in server/index.js so a SECONDARY company DB (zehen_co_2 etc.)
  // that was created before the PR landed picks up the column on next
  // boot. Without this replay, the toggle on the product form silently
  // fails on save with "column does not exist" because the primary-DB
  // migration in server/index.js doesn't reach secondary company DBs.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name='products' AND column_name='is_tax_inclusive'
      ) THEN
        ALTER TABLE products ADD COLUMN is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;
      END IF;
    END $$;
  `);

  // salesmen — master list of sales staff credited on bills. Column shape
  // matches the Sequelize model in server/models/Salesman.js. Created
  // explicitly here (like compliance_audit_logs above) so the table exists
  // regardless of whether the provisioning path ran sync(). PURE ATTRIBUTION:
  // nothing here participates in any total/tax/ledger/balance calculation.
  // Uniqueness of name/code is enforced in the controller, not the DB.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_name = 'salesmen') THEN
        CREATE TABLE salesmen (
          salesman_id            SERIAL PRIMARY KEY,
          name                   VARCHAR(100) NOT NULL,
          code                   VARCHAR(20),
          phone                  VARCHAR(20),
          email                  VARCHAR(120),
          commission_percentage  NUMERIC(5,2) DEFAULT 0,
          is_active              BOOLEAN DEFAULT true,
          notes                  TEXT,
          created_date           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          modified_date          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      END IF;
    END $$;
  `);

  // sales_bills.salesman_id — nullable attribution FK into salesmen. Added as
  // a plain INTEGER (no DB-level FK constraint), mirroring the master block in
  // server/index.js and the existing category_id pattern: the deletion guard
  // lives in the controller, and we avoid a constraint scan over a large
  // sales_bills table on legacy company DBs.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='sales_bills' AND column_name='salesman_id') THEN
        ALTER TABLE sales_bills ADD COLUMN salesman_id INTEGER;
      END IF;
    END $$;
  `);

  // system_settings.insight_show_* — six BOOLEAN visibility toggles for the
  // F8 Customer Insight Panel. Declared in the SystemSettings model, so a
  // company DB missing these columns would fail EVERY system_settings read
  // ("column does not exist") — breaking company-name loading and the sales
  // save path. Mirrors the master block in server/index.js. Idempotent.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings' AND column_name='insight_show_fy_metrics') THEN
        ALTER TABLE system_settings ADD COLUMN insight_show_fy_metrics BOOLEAN DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings' AND column_name='insight_show_alltime_metrics') THEN
        ALTER TABLE system_settings ADD COLUMN insight_show_alltime_metrics BOOLEAN DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings' AND column_name='insight_show_profit') THEN
        ALTER TABLE system_settings ADD COLUMN insight_show_profit BOOLEAN DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings' AND column_name='insight_show_behavior') THEN
        ALTER TABLE system_settings ADD COLUMN insight_show_behavior BOOLEAN DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings' AND column_name='insight_show_top_products') THEN
        ALTER TABLE system_settings ADD COLUMN insight_show_top_products BOOLEAN DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings' AND column_name='insight_show_bill_stats') THEN
        ALTER TABLE system_settings ADD COLUMN insight_show_bill_stats BOOLEAN DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings' AND column_name='insight_show_pay_time') THEN
        ALTER TABLE system_settings ADD COLUMN insight_show_pay_time BOOLEAN DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='system_settings' AND column_name='insight_show_lifetime_profit') THEN
        ALTER TABLE system_settings ADD COLUMN insight_show_lifetime_profit BOOLEAN DEFAULT true;
      END IF;
    END $$;
  `);

  // ── WhatsApp delivery tables ────────────────────────────────────────
  // Column shapes match the Sequelize models (WhatsappSettings /
  // WhatsappOutbox). Created explicitly here — like `salesmen` above — so a
  // company DB built via the bootstrap path (which does NOT call sync()) still
  // gets them. Idempotent (CREATE TABLE / INDEX IF NOT EXISTS).
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_name = 'whatsapp_settings') THEN
        CREATE TABLE whatsapp_settings (
          whatsapp_settings_id      SERIAL PRIMARY KEY,
          provider                  VARCHAR(12) NOT NULL DEFAULT 'off',
          enabled                   BOOLEAN DEFAULT false,
          msg_template_bill         TEXT,
          msg_template_ledger       TEXT,
          msg_template_receipt      TEXT,
          auto_send_default         BOOLEAN DEFAULT false,
          min_delay_s               INTEGER DEFAULT 4,
          max_delay_s               INTEGER DEFAULT 15,
          daily_cap                 INTEGER DEFAULT 80,
          warmup_start              INTEGER DEFAULT 20,
          warmup_step               INTEGER DEFAULT 20,
          warmup_started_on         DATE,
          quiet_start               VARCHAR(5) DEFAULT '21:00',
          quiet_end                 VARCHAR(5) DEFAULT '08:00',
          validate_numbers          BOOLEAN DEFAULT true,
          bot_enabled               BOOLEAN DEFAULT false,
          bot_show_balance          BOOLEAN DEFAULT true,
          bot_show_bills            BOOLEAN DEFAULT true,
          bot_show_payments         BOOLEAN DEFAULT true,
          bot_show_statement        BOOLEAN DEFAULT true,
          bot_blocked               TEXT DEFAULT '[]',
          bot_owner_numbers         TEXT DEFAULT '[]',
          bot_welcome               TEXT,
          bot_stock_lookup             BOOLEAN DEFAULT true,
          bot_owner_show_sale_rate     BOOLEAN DEFAULT true,
          bot_owner_show_purchase_rate BOOLEAN DEFAULT true,
          bot_owner_show_stock         BOOLEAN DEFAULT true,
          bot_owner_show_mrp           BOOLEAN DEFAULT true,
          bot_doc_request              BOOLEAN DEFAULT true,
          bot_owner_panel              TEXT DEFAULT '{}',
          bot_supplier_panel           TEXT DEFAULT '{}',
          bot_daily_digest             BOOLEAN DEFAULT false,
          bot_digest_time              VARCHAR(5) DEFAULT '21:00',
          bot_digest_last_sent         DATE,
          official_api_base         VARCHAR(200) DEFAULT 'https://graph.facebook.com/v21.0',
          official_phone_number_id  VARCHAR(60),
          official_access_token     TEXT,
          official_template_name    VARCHAR(120),
          official_template_lang    VARCHAR(12) DEFAULT 'en',
          linked_number             VARCHAR(30),
          connection_state          VARCHAR(16) DEFAULT 'disconnected',
          connected_at              TIMESTAMP WITH TIME ZONE,
          created_date              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          modified_date             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_name = 'whatsapp_outbox') THEN
        CREATE TABLE whatsapp_outbox (
          outbox_id        SERIAL PRIMARY KEY,
          provider         VARCHAR(12),
          to_number        VARCHAR(30) NOT NULL,
          to_jid           VARCHAR(40),
          party_id         INTEGER,
          doc_type         VARCHAR(20),
          doc_id           INTEGER,
          file_name        VARCHAR(160),
          caption          TEXT,
          payload_base64   TEXT,
          status           VARCHAR(12) NOT NULL DEFAULT 'queued',
          attempts         INTEGER DEFAULT 0,
          error            TEXT,
          wa_message_id    VARCHAR(80),
          scheduled_at     TIMESTAMP WITH TIME ZONE,
          sent_at          TIMESTAMP WITH TIME ZONE,
          delivered_at     TIMESTAMP WITH TIME ZONE,
          read_at          TIMESTAMP WITH TIME ZONE,
          created_date     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          modified_date    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      END IF;
    END $$;
  `);
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS idx_wa_outbox_status_sched ON whatsapp_outbox(status, scheduled_at);`
  );
  // parties.whatsapp_opt_out — present on fresh DBs via the model/sync, but a
  // company DB created before this change needs the column added. Idempotent.
  await sequelize.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='parties' AND column_name='whatsapp_opt_out') THEN
        ALTER TABLE parties ADD COLUMN whatsapp_opt_out BOOLEAN NOT NULL DEFAULT false;
      END IF;
    END $$;
  `);
  // whatsapp_settings BOT columns — for a company DB whose whatsapp_settings
  // table predates the self-service bot. Idempotent (ADD COLUMN IF NOT EXISTS).
  await sequelize.query(`
    ALTER TABLE whatsapp_settings
      ADD COLUMN IF NOT EXISTS bot_enabled        BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS bot_show_balance   BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_show_bills     BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_show_payments  BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_show_statement BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_blocked        TEXT DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS bot_owner_numbers  TEXT DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS bot_welcome        TEXT,
      ADD COLUMN IF NOT EXISTS bot_stock_lookup             BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_owner_show_sale_rate     BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_owner_show_purchase_rate BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_owner_show_stock         BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_owner_show_mrp           BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_doc_request              BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bot_owner_panel              TEXT DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS bot_supplier_panel           TEXT DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS bot_daily_digest             BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS bot_digest_time              VARCHAR(5) DEFAULT '21:00',
      ADD COLUMN IF NOT EXISTS bot_digest_last_sent         DATE;
  `).catch(() => { /* table may not exist yet on a brand-new DB; sync creates it with these columns */ });

  // Durable barcode label design (off fragile localStorage, into the DB).
  await sequelize.query(`
    ALTER TABLE barcode_settings
      ADD COLUMN IF NOT EXISTS label_layout        TEXT,
      ADD COLUMN IF NOT EXISTS label_company_name  VARCHAR(120);
  `).catch(() => { /* table created by sync with these columns on a fresh DB */ });
}

module.exports = { runCompanySchemaMigrations };
