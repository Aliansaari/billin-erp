require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const { sequelize } = require('./models');
const seedDefaultData = require('./seeders/defaultData');

const app = express();
const PORT = process.env.SERVER_PORT || 3001;

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Uploads directory
const fs = require('fs');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/parties', require('./routes/parties'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', require('./routes/products'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/purchase-drafts', require('./routes/purchaseDrafts'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/sales-drafts', require('./routes/salesDrafts'));
app.use('/api/sales-returns', require('./routes/salesReturns'));
app.use('/api/purchase-returns', require('./routes/purchaseReturns'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/journal-vouchers', require('./routes/journalVouchers'));
app.use('/api/ledger', require('./routes/ledger'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/data', require('./routes/importExport'));
app.use('/api/tally', require('./routes/tally'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/print', require('./routes/print'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
  });
}

// Database sync and start server
async function startServer() {
  try {
    await sequelize.authenticate();
    console.log('Database connected successfully');

    // Sync models (creates tables if they don't exist)
    await sequelize.sync({ alter: false });
    console.log('Database tables synced');

    // ── Pre-migration: drop row-level UNIQUE on ledger_entries.entry_number ──
    // entry_number groups Dr/Cr legs of one voucher and MUST not be row-unique.
    // Sequelize auto-creates this constraint on every restart from the model
    // declaration; we removed `unique:true` from the model, but existing DBs
    // may still carry leftover constraints from prior boots. Dropped via a
    // standalone PL/pgSQL block (kept out of the big template literal so JS
    // template-string parsing stays simple).
    await sequelize.query(
      "DO $do$ DECLARE rec RECORD; BEGIN " +
      "FOR rec IN SELECT c.conname FROM pg_constraint c " +
      "JOIN pg_class cls ON cls.oid = c.conrelid " +
      "WHERE cls.relname = 'ledger_entries' AND c.contype = 'u' " +
      "AND pg_get_constraintdef(c.oid) ILIKE '%(entry_number)%' " +
      "LOOP EXECUTE format('ALTER TABLE ledger_entries DROP CONSTRAINT %I', rec.conname); " +
      "END LOOP; END $do$;",
    ).catch((err) => {
      console.error('[Pre-migration drop entry_number unique] Error:', err.message);
    });

    // Safe migrations — add columns if they don't exist
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='sale_due_days_mode') THEN
          ALTER TABLE system_settings ADD COLUMN sale_due_days_mode VARCHAR(20) DEFAULT 'bill_date';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='purchase_due_days_mode') THEN
          ALTER TABLE system_settings ADD COLUMN purchase_due_days_mode VARCHAR(20) DEFAULT 'bill_date';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='sales_bill_prefix') THEN
          ALTER TABLE system_settings ADD COLUMN sales_bill_prefix VARCHAR(20) DEFAULT '';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='purchase_bill_prefix') THEN
          ALTER TABLE system_settings ADD COLUMN purchase_bill_prefix VARCHAR(20) DEFAULT '';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='aging_bucket_1_days') THEN
          ALTER TABLE system_settings ADD COLUMN aging_bucket_1_days INTEGER DEFAULT 30;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='aging_bucket_2_days') THEN
          ALTER TABLE system_settings ADD COLUMN aging_bucket_2_days INTEGER DEFAULT 60;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='aging_bucket_3_days') THEN
          ALTER TABLE system_settings ADD COLUMN aging_bucket_3_days INTEGER DEFAULT 90;
        END IF;
        -- TallyPrime sync config. These live on system_settings rather than
        -- a separate table because there's always exactly one active config.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='tally_host') THEN
          ALTER TABLE system_settings ADD COLUMN tally_host VARCHAR(100) DEFAULT 'localhost';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='tally_port') THEN
          ALTER TABLE system_settings ADD COLUMN tally_port INTEGER DEFAULT 9000;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='tally_company') THEN
          ALTER TABLE system_settings ADD COLUMN tally_company VARCHAR(200);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='tally_sync_enabled') THEN
          ALTER TABLE system_settings ADD COLUMN tally_sync_enabled BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='tally_last_sync') THEN
          ALTER TABLE system_settings ADD COLUMN tally_last_sync TIMESTAMP;
        END IF;
        -- Return bill prefixes. Defaults match the seeder; existing DBs that
        -- ran the seeder before this column shipped still need a value so the
        -- controller trim() call does not throw on NULL.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='sales_return_prefix') THEN
          ALTER TABLE system_settings ADD COLUMN sales_return_prefix VARCHAR(20) DEFAULT 'SR';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='purchase_return_prefix') THEN
          ALTER TABLE system_settings ADD COLUMN purchase_return_prefix VARCHAR(20) DEFAULT 'PR';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='sale_type') THEN
          ALTER TABLE sales_bills ADD COLUMN sale_type VARCHAR(20) DEFAULT 'Retail';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='cgst_pct') THEN
          ALTER TABLE sales_bills ADD COLUMN cgst_pct DECIMAL(5,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='sgst_pct') THEN
          ALTER TABLE sales_bills ADD COLUMN sgst_pct DECIMAL(5,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='igst_pct') THEN
          ALTER TABLE sales_bills ADD COLUMN igst_pct DECIMAL(5,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='salesman_name') THEN
          ALTER TABLE sales_bills ADD COLUMN salesman_name VARCHAR(100);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='special_discount') THEN
          ALTER TABLE sales_bills ADD COLUMN special_discount DECIMAL(15,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='other_charges') THEN
          ALTER TABLE sales_bills ADD COLUMN other_charges DECIMAL(15,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='freight_charges') THEN
          ALTER TABLE sales_bills ADD COLUMN freight_charges DECIMAL(15,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='return_amount') THEN
          ALTER TABLE sales_bills ADD COLUMN return_amount DECIMAL(15,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='payment_method') THEN
          ALTER TABLE sales_bills ADD COLUMN payment_method VARCHAR(30) DEFAULT 'Cash';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bills' AND column_name='cgst_pct') THEN
          ALTER TABLE purchase_bills ADD COLUMN cgst_pct DECIMAL(5,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bills' AND column_name='sgst_pct') THEN
          ALTER TABLE purchase_bills ADD COLUMN sgst_pct DECIMAL(5,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bills' AND column_name='igst_pct') THEN
          ALTER TABLE purchase_bills ADD COLUMN igst_pct DECIMAL(5,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bills' AND column_name='other_charges') THEN
          ALTER TABLE purchase_bills ADD COLUMN other_charges DECIMAL(15,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bills' AND column_name='freight_charges') THEN
          ALTER TABLE purchase_bills ADD COLUMN freight_charges DECIMAL(15,2) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bill_items' AND column_name='unit_type') THEN
          ALTER TABLE sales_bill_items ADD COLUMN unit_type VARCHAR(10) DEFAULT 'Pcs';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bill_items' AND column_name='category_id') THEN
          ALTER TABLE sales_bill_items ADD COLUMN category_id INTEGER;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bill_items' AND column_name='quantity_per_box') THEN
          ALTER TABLE sales_bill_items ADD COLUMN quantity_per_box DECIMAL(10,2) DEFAULT 1;
        END IF;
        -- COGS at time of sale. Snapshotted from products.purchase_rate whenever
        -- a sales bill is created so historic profit is stable even if the
        -- product's cost is edited later. Without this column, gross profit on
        -- last year's sales would silently change whenever the owner updates
        -- purchase prices for new stock — breaking audit trails.
        --
        -- Backfill: for rows that pre-date this column we copy the product's
        -- CURRENT purchase_rate as a best-effort estimate. This is explicitly
        -- an approximation for old sales; going forward the value is captured
        -- accurately at bill-creation time in salesController.create.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bill_items' AND column_name='cost_rate') THEN
          ALTER TABLE sales_bill_items ADD COLUMN cost_rate DECIMAL(15,2) DEFAULT 0;
          UPDATE sales_bill_items sbi
             SET cost_rate = COALESCE(p.purchase_rate, 0)
            FROM products p
           WHERE sbi.product_id = p.product_id AND sbi.cost_rate = 0;
        END IF;
        -- Cancellation audit trail for payments/receipts
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments_receipts' AND column_name='cancelled_by') THEN
          ALTER TABLE payments_receipts ADD COLUMN cancelled_by INTEGER REFERENCES users(user_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments_receipts' AND column_name='cancelled_on') THEN
          ALTER TABLE payments_receipts ADD COLUMN cancelled_on TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments_receipts' AND column_name='cancellation_reason') THEN
          ALTER TABLE payments_receipts ADD COLUMN cancellation_reason TEXT;
        END IF;
        -- Per-bill allocations JSON on receipts/payments. Without this column
        -- every SELECT on payments_receipts fails because Sequelize includes
        -- the column in auto-generated SQL — which made the Payments Transactions
        -- page appear empty on older databases.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments_receipts' AND column_name='bill_allocations') THEN
          ALTER TABLE payments_receipts ADD COLUMN bill_allocations JSONB DEFAULT NULL;
        END IF;
        -- Cancellation reason + FK on bill cancellation fields
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bills' AND column_name='cancellation_reason') THEN
          ALTER TABLE sales_bills ADD COLUMN cancellation_reason TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bills' AND column_name='cancellation_reason') THEN
          ALTER TABLE purchase_bills ADD COLUMN cancellation_reason TEXT;
        END IF;
        -- Align purchase_bill_items.quantity_per_box to DECIMAL (was INTEGER,
        -- sales side is DECIMAL — mismatch caused silent rounding on partial boxes).
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='purchase_bill_items' AND column_name='quantity_per_box'
            AND data_type='integer'
        ) THEN
          ALTER TABLE purchase_bill_items ALTER COLUMN quantity_per_box TYPE DECIMAL(10,2) USING quantity_per_box::DECIMAL(10,2);
        END IF;
        -- Align products.quantity_per_box to DECIMAL for the same reason.
        -- Bill items were already DECIMAL; the product master was silently
        -- truncating fractional pack sizes on new-product auto-create.
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='products' AND column_name='quantity_per_box'
            AND data_type='integer'
        ) THEN
          ALTER TABLE products ALTER COLUMN quantity_per_box TYPE DECIMAL(10,2) USING quantity_per_box::DECIMAL(10,2);
        END IF;
        -- FK constraints for cancelled_by on bills (Sequelize sync doesn't add
        -- them retroactively to existing columns). Wrap each in an existence
        -- check so re-running the migration is a no-op.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='sales_bills' AND constraint_name='sales_bills_cancelled_by_fkey'
        ) THEN
          BEGIN
            ALTER TABLE sales_bills
              ADD CONSTRAINT sales_bills_cancelled_by_fkey
              FOREIGN KEY (cancelled_by) REFERENCES users(user_id);
          EXCEPTION WHEN others THEN NULL;
          END;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='purchase_bills' AND constraint_name='purchase_bills_cancelled_by_fkey'
        ) THEN
          BEGIN
            ALTER TABLE purchase_bills
              ADD CONSTRAINT purchase_bills_cancelled_by_fkey
              FOREIGN KEY (cancelled_by) REFERENCES users(user_id);
          EXCEPTION WHEN others THEN NULL;
          END;
        END IF;

        -- PrintProfile: theme + accent_color columns added post-v1. Existing
        -- profiles from the initial seed get defaulted to 'classic' / '#111'.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='print_profiles' AND column_name='theme') THEN
          ALTER TABLE print_profiles ADD COLUMN theme VARCHAR(20) DEFAULT 'classic';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='print_profiles' AND column_name='accent_color') THEN
          ALTER TABLE print_profiles ADD COLUMN accent_color VARCHAR(9) DEFAULT '#111111';
        END IF;

        -- Thermal style + darkness controls added for receipt-print readability.
        -- Existing rows default to 'standard' / 'bold'. No data backfill needed.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='print_profiles' AND column_name='thermal_style') THEN
          ALTER TABLE print_profiles ADD COLUMN thermal_style VARCHAR(20) DEFAULT 'standard';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='print_profiles' AND column_name='bold_level') THEN
          ALTER TABLE print_profiles ADD COLUMN bold_level VARCHAR(20) DEFAULT 'bold';
        END IF;

        -- Totals-section visibility toggles for GST and change/return amounts.
        -- Default TRUE to preserve prior render behavior; users explicitly opt
        -- out via the Fields / Columns tab.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='print_profiles' AND column_name='show_gst') THEN
          ALTER TABLE print_profiles ADD COLUMN show_gst BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='print_profiles' AND column_name='show_return_amount') THEN
          ALTER TABLE print_profiles ADD COLUMN show_return_amount BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='print_profiles' AND column_name='show_previous_balance') THEN
          ALTER TABLE print_profiles ADD COLUMN show_previous_balance BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='custom_permissions') THEN
          ALTER TABLE users ADD COLUMN custom_permissions JSONB DEFAULT NULL;
        END IF;

        -- ── Double-entry ledger wiring (Phase 1) ───────────────────────
        -- New columns required by the Posting Service. Sync with alter:false
        -- won't add these to existing tables, so we ALTER explicitly.
        -- All idempotent.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ledger_entries' AND column_name='source_type') THEN
          ALTER TABLE ledger_entries ADD COLUMN source_type VARCHAR(40);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ledger_entries' AND column_name='reversal_of_id') THEN
          ALTER TABLE ledger_entries ADD COLUMN reversal_of_id INTEGER REFERENCES ledger_entries(entry_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ledger_entries' AND column_name='party_id') THEN
          ALTER TABLE ledger_entries ADD COLUMN party_id INTEGER REFERENCES parties(party_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ledger_accounts' AND column_name='is_party_ledger') THEN
          ALTER TABLE ledger_accounts ADD COLUMN is_party_ledger BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ledger_accounts' AND column_name='party_id') THEN
          ALTER TABLE ledger_accounts ADD COLUMN party_id INTEGER REFERENCES parties(party_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='parties' AND column_name='ledger_account_id') THEN
          ALTER TABLE parties ADD COLUMN ledger_account_id INTEGER REFERENCES ledger_accounts(ledger_id) ON DELETE SET NULL;
        END IF;
        -- Replace any default-NO-ACTION FKs on the cyclic pair with
        -- ON DELETE SET NULL so cleanup ordering doesn't matter.
        IF EXISTS (
          SELECT 1 FROM pg_constraint c
            JOIN pg_class cls ON cls.oid = c.conrelid
           WHERE cls.relname = 'parties'
             AND c.conname = 'parties_ledger_account_id_fkey'
             AND c.confdeltype <> 'n'
        ) THEN
          ALTER TABLE parties DROP CONSTRAINT parties_ledger_account_id_fkey;
          ALTER TABLE parties ADD CONSTRAINT parties_ledger_account_id_fkey
            FOREIGN KEY (ledger_account_id) REFERENCES ledger_accounts(ledger_id) ON DELETE SET NULL;
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint c
            JOIN pg_class cls ON cls.oid = c.conrelid
           WHERE cls.relname = 'ledger_accounts'
             AND c.conname = 'ledger_accounts_party_id_fkey'
             AND c.confdeltype <> 'n'
        ) THEN
          ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_party_id_fkey;
          ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_party_id_fkey
            FOREIGN KEY (party_id) REFERENCES parties(party_id) ON DELETE SET NULL;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_ledger_entries_source
        ON ledger_entries (source_type, reference_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_entries_party
        ON ledger_entries (party_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_accounts_party
        ON ledger_accounts (party_id);

      CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_number
        ON ledger_entries (entry_number);

      -- Performance indexes. CREATE INDEX IF NOT EXISTS is idempotent and
      -- will no-op on subsequent boots. Without these, list pages do a
      -- sequential scan that's fine on a dev DB but collapses at 50k+ rows.
      CREATE INDEX IF NOT EXISTS idx_sales_bills_active_by_date
        ON sales_bills (is_cancelled, bill_date DESC);
      CREATE INDEX IF NOT EXISTS idx_sales_bills_payment_status
        ON sales_bills (payment_status);
      CREATE INDEX IF NOT EXISTS idx_sales_bills_customer_date
        ON sales_bills (customer_id, bill_date DESC);
      CREATE INDEX IF NOT EXISTS idx_purchase_bills_active_by_date
        ON purchase_bills (is_cancelled, bill_date DESC);
      CREATE INDEX IF NOT EXISTS idx_purchase_bills_supplier_date
        ON purchase_bills (supplier_id, bill_date DESC);
      CREATE INDEX IF NOT EXISTS idx_sales_bill_items_bill
        ON sales_bill_items (sales_bill_id);
      CREATE INDEX IF NOT EXISTS idx_purchase_bill_items_bill
        ON purchase_bill_items (purchase_bill_id);
      CREATE INDEX IF NOT EXISTS idx_stock_ledger_product_date
        ON stock_ledger (product_id, transaction_date);
      CREATE INDEX IF NOT EXISTS idx_payments_receipts_party_date
        ON payments_receipts (party_id, transaction_date);

      -- Trigram indexes for "instant" ILIKE '%foo%' search on bill numbers
      -- and party names. A B-tree index can't help with leading wildcards,
      -- so without pg_trgm the server falls back to a sequential scan on
      -- every keystroke. With it, the planner uses a GIN index and the
      -- query stays fast even at millions of rows. pg_trgm ships with
      -- PostgreSQL contrib (no extra install needed).
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS idx_sales_bills_bill_number_trgm
        ON sales_bills USING gin (bill_number gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_purchase_bills_bill_number_trgm
        ON purchase_bills USING gin (bill_number gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_parties_party_name_trgm
        ON parties USING gin (party_name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_parties_mobile_1_trgm
        ON parties USING gin (mobile_1 gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_products_product_name_trgm
        ON products USING gin (product_name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_products_barcode_trgm
        ON products USING gin (barcode gin_trgm_ops);

      -- Historical note: an earlier startup migration used to HALVE GST
      -- amounts on Tally-imported bills, to undo a double-counting bug in
      -- the old importer. The importer is now correct, so halving on every
      -- restart would damage freshly re-imported data (halve an already-
      -- correct value). That halving SQL is removed; the marker column
      -- tally_correction_applied is kept so we can gate the one-time
      -- revert below, then retired.
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='sales_bills' AND column_name='tally_correction_applied') THEN
          ALTER TABLE sales_bills ADD COLUMN tally_correction_applied BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='purchase_bills' AND column_name='tally_correction_applied') THEN
          ALTER TABLE purchase_bills ADD COLUMN tally_correction_applied BOOLEAN DEFAULT false;
        END IF;
        -- Second marker: tracks bills that have been reverted (doubled back)
        -- because the halving was applied to already-correct re-imported
        -- data. Running twice is a no-op once this is set.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='sales_bills' AND column_name='tally_halving_reverted') THEN
          ALTER TABLE sales_bills ADD COLUMN tally_halving_reverted BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='purchase_bills' AND column_name='tally_halving_reverted') THEN
          ALTER TABLE purchase_bills ADD COLUMN tally_halving_reverted BOOLEAN DEFAULT false;
        END IF;
      END $$;
      -- Hold-bill / Recall-draft feature: separate table so drafts are
      -- invisible to every existing report, GSTR-1/3B aggregator, and
      -- the bill-number sequence. JSONB blob holds the form state.
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_name='sales_bill_drafts') THEN
          CREATE TABLE sales_bill_drafts (
            draft_id      SERIAL PRIMARY KEY,
            draft_number  VARCHAR(20)   NOT NULL UNIQUE,
            customer_id   INTEGER       REFERENCES parties(party_id) ON DELETE SET NULL,
            draft_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
            payload       JSONB         NOT NULL,
            item_count    INTEGER       DEFAULT 0,
            total_preview NUMERIC(15,2) DEFAULT 0,
            created_by    INTEGER       REFERENCES users(user_id),
            created_date  TIMESTAMP     DEFAULT NOW(),
            modified_date TIMESTAMP     DEFAULT NOW()
          );
          CREATE INDEX idx_drafts_created_date ON sales_bill_drafts(created_date DESC);
        END IF;
      END $$;
      -- Amount-only / on-account billing feature: bill_mode flag +
      -- description column for the synthetic line text.
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='sales_bills' AND column_name='bill_mode') THEN
          ALTER TABLE sales_bills ADD COLUMN bill_mode VARCHAR(10) DEFAULT 'item';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='sales_bills' AND column_name='description') THEN
          ALTER TABLE sales_bills ADD COLUMN description TEXT;
        END IF;
        -- Operator-level kill switch for amount-only billing. Default
        -- TRUE so existing installs keep the feature available. Shared
        -- between sales and purchases — one toggle gates both forms.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='system_settings' AND column_name='enable_amount_only_billing') THEN
          ALTER TABLE system_settings ADD COLUMN enable_amount_only_billing BOOLEAN DEFAULT true;
        END IF;
      END $$;
      -- Mirror of the sales drafts table for purchases — same isolation
      -- rationale (no bill_number consumed, invisible to reports/stock/
      -- supplier balance, JSONB blob holds the form state).
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_name='purchase_bill_drafts') THEN
          CREATE TABLE purchase_bill_drafts (
            draft_id      SERIAL PRIMARY KEY,
            draft_number  VARCHAR(20)   NOT NULL UNIQUE,
            supplier_id   INTEGER       REFERENCES parties(party_id) ON DELETE SET NULL,
            draft_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
            payload       JSONB         NOT NULL,
            item_count    INTEGER       DEFAULT 0,
            total_preview NUMERIC(15,2) DEFAULT 0,
            created_by    INTEGER       REFERENCES users(user_id),
            created_date  TIMESTAMP     DEFAULT NOW(),
            modified_date TIMESTAMP     DEFAULT NOW()
          );
          CREATE INDEX idx_purchase_drafts_created_date ON purchase_bill_drafts(created_date DESC);
        END IF;
      END $$;
      -- Mirror amount-mode columns on purchase_bills.
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='purchase_bills' AND column_name='bill_mode') THEN
          ALTER TABLE purchase_bills ADD COLUMN bill_mode VARCHAR(10) DEFAULT 'item';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='purchase_bills' AND column_name='description') THEN
          ALTER TABLE purchase_bills ADD COLUMN description TEXT;
        END IF;
      END $$;

      -- One-time revert: any bill that was touched by the old halving SQL
      -- (tally_correction_applied=true) and has not been reverted yet gets
      -- DOUBLED back. After the user re-imported with the fixed importer,
      -- the values stored were already correct; halving them once more was
      -- the bug. Idempotent via tally_halving_reverted.
      UPDATE sales_bill_items sbi
         SET cgst_amount = sbi.cgst_amount * 2,
             sgst_amount = sbi.sgst_amount * 2,
             igst_amount = sbi.igst_amount * 2
        FROM sales_bills sb
       WHERE sbi.sales_bill_id = sb.sales_bill_id
         AND COALESCE(sb.tally_correction_applied, false) = true
         AND COALESCE(sb.tally_halving_reverted,   false) = false;

      UPDATE purchase_bill_items pbi
         SET cgst_amount = pbi.cgst_amount * 2,
             sgst_amount = pbi.sgst_amount * 2,
             igst_amount = pbi.igst_amount * 2
        FROM purchase_bills pb
       WHERE pbi.purchase_bill_id = pb.purchase_bill_id
         AND COALESCE(pb.tally_correction_applied, false) = true
         AND COALESCE(pb.tally_halving_reverted,   false) = false;

      UPDATE sales_bills SET
        cgst_amount = cgst_amount * 2,
        sgst_amount = sgst_amount * 2,
        igst_amount = igst_amount * 2,
        cgst_pct    = cgst_pct * 2,
        sgst_pct    = sgst_pct * 2,
        igst_pct    = igst_pct * 2,
        total_amount   = ROUND((sub_total + (cgst_amount + sgst_amount + igst_amount) * 2 + COALESCE(round_off, 0) - COALESCE(discount_amount, 0))::numeric, 2),
        balance_amount = ROUND((sub_total + (cgst_amount + sgst_amount + igst_amount) * 2 + COALESCE(round_off, 0) - COALESCE(discount_amount, 0) - COALESCE(paid_amount, 0))::numeric, 2),
        tally_halving_reverted = true
      WHERE COALESCE(tally_correction_applied, false) = true
        AND COALESCE(tally_halving_reverted,   false) = false;

      UPDATE purchase_bills SET
        cgst_amount = cgst_amount * 2,
        sgst_amount = sgst_amount * 2,
        igst_amount = igst_amount * 2,
        cgst_pct    = cgst_pct * 2,
        sgst_pct    = sgst_pct * 2,
        igst_pct    = igst_pct * 2,
        total_amount   = ROUND((sub_total + (cgst_amount + sgst_amount + igst_amount) * 2 + COALESCE(round_off, 0) - COALESCE(discount_amount, 0))::numeric, 2),
        balance_amount = ROUND((sub_total + (cgst_amount + sgst_amount + igst_amount) * 2 + COALESCE(round_off, 0) - COALESCE(discount_amount, 0) - COALESCE(paid_amount, 0))::numeric, 2),
        tally_halving_reverted = true
      WHERE COALESCE(tally_correction_applied, false) = true
        AND COALESCE(tally_halving_reverted,   false) = false;

      -- Widen discount_percentage so it can store 4-decimal precision.
      -- The column was DECIMAL(5, 2), which silently truncates a computed
      -- pct like 4.7619 down to 4.76 — which then re-derives the stored
      -- amount as 2239.10 instead of 2240, producing the ~₹1 drift the
      -- user saw on every imported bill. DECIMAL(9, 4) leaves room for
      -- up to 99999.9999% (comfortable margin) while giving us the
      -- precision needed to round-trip amount→pct→amount cleanly.
      ALTER TABLE sales_bills    ALTER COLUMN discount_percentage TYPE DECIMAL(9, 4);
      ALTER TABLE purchase_bills ALTER COLUMN discount_percentage TYPE DECIMAL(9, 4);

      -- Back-fill discount_percentage from stored discount_amount. Runs
      -- in two cases: (a) pct is 0 but amount > 0 (old importer didn't
      -- store pct at all); (b) pct was stored with only 2 decimals, so
      -- re-deriving the amount from pct drifts by up to ~₹1 on every
      -- imported bill. We compute pct to 4 decimals so sub_total × pct / 100
      -- round-trips back to the original discount_amount. Safe: we only
      -- touch rows where the current pct and amount disagree by more than
      -- a rupee — bills the user genuinely entered with a clean pct (like
      -- 10%) are left alone.
      UPDATE sales_bills
         SET discount_percentage = ROUND((discount_amount * 100.0 / NULLIF(sub_total, 0))::numeric, 4)
       WHERE COALESCE(discount_amount, 0) > 0
         AND COALESCE(sub_total, 0) > 0
         AND ABS(sub_total * COALESCE(discount_percentage, 0) / 100 - discount_amount) > 0.01;

      UPDATE purchase_bills
         SET discount_percentage = ROUND((discount_amount * 100.0 / NULLIF(sub_total, 0))::numeric, 4)
       WHERE COALESCE(discount_amount, 0) > 0
         AND COALESCE(sub_total, 0) > 0
         AND ABS(sub_total * COALESCE(discount_percentage, 0) / 100 - discount_amount) > 0.01;

      -- Opening Stock reconciliation. Stock Movement computes each product's
      -- running balance by summing quantity_in - quantity_out from the
      -- stock_ledger. For products brought in from Tally's stock-summary
      -- export, products.current_stock was set directly but no "Opening
      -- Stock" ledger entry was ever created — so the running balance in
      -- the Stock Movement view starts at 0 and never matches the "On Hand"
      -- card at the top. We fix that by inserting a single Opening Stock
      -- row per product, computed so the running total ends exactly at
      -- current_stock:  opening = current_stock - Σ(in) + Σ(out).
      -- Dated 2000-01-01 so it always sorts before real transactions.
      -- Idempotent: skips products that already have an Opening Stock row.
      INSERT INTO stock_ledger
        (product_id, barcode, transaction_type, transaction_date,
         reference_id, reference_number, quantity_in, quantity_out,
         rate, balance_quantity, remarks, created_date)
      SELECT
        p.product_id,
        p.barcode,
        'Opening Stock',
        DATE '2000-01-01',
        NULL,
        'OPENING',
        CASE WHEN (p.current_stock - COALESCE(s.total_in, 0) + COALESCE(s.total_out, 0)) >= 0
             THEN      (p.current_stock - COALESCE(s.total_in, 0) + COALESCE(s.total_out, 0))
             ELSE 0 END,
        CASE WHEN (p.current_stock - COALESCE(s.total_in, 0) + COALESCE(s.total_out, 0)) < 0
             THEN ABS(p.current_stock - COALESCE(s.total_in, 0) + COALESCE(s.total_out, 0))
             ELSE 0 END,
        COALESCE(p.opening_stock_rate, p.purchase_rate, 0),
        (p.current_stock - COALESCE(s.total_in, 0) + COALESCE(s.total_out, 0)),
        'Reconciled opening balance for imported data',
        NOW()
      FROM products p
      LEFT JOIN (
        SELECT product_id,
               SUM(COALESCE(quantity_in, 0))  AS total_in,
               SUM(COALESCE(quantity_out, 0)) AS total_out
          FROM stock_ledger
         GROUP BY product_id
      ) s ON s.product_id = p.product_id
      WHERE NOT EXISTS (
        SELECT 1 FROM stock_ledger sl
         WHERE sl.product_id = p.product_id
           AND sl.transaction_type = 'Opening Stock'
      )
      AND (COALESCE(p.current_stock, 0) <> 0
           OR COALESCE(s.total_in, 0)  <> 0
           OR COALESCE(s.total_out, 0) <> 0);

      -- Backfill GST percentages on bills imported from Tally. The importer
      -- used to only store tax AMOUNTS (cgst_amount, sgst_amount, igst_amount)
      -- and left the percentage columns at 0, which made the edit form's GST
      -- row appear empty even though the totals were right. Here we derive
      -- the percentage from the amounts and sub_total. Guarded on all three
      -- pct columns being 0 so re-running this on already-fixed or
      -- natively-created bills is a no-op.
      UPDATE sales_bills
         SET cgst_pct = ROUND((cgst_amount * 100.0 / NULLIF(sub_total, 0))::numeric, 2),
             sgst_pct = ROUND((sgst_amount * 100.0 / NULLIF(sub_total, 0))::numeric, 2),
             igst_pct = ROUND((igst_amount * 100.0 / NULLIF(sub_total, 0))::numeric, 2)
       WHERE COALESCE(cgst_pct, 0) = 0
         AND COALESCE(sgst_pct, 0) = 0
         AND COALESCE(igst_pct, 0) = 0
         AND (COALESCE(cgst_amount, 0) > 0 OR COALESCE(sgst_amount, 0) > 0 OR COALESCE(igst_amount, 0) > 0)
         AND COALESCE(sub_total, 0) > 0;

      UPDATE purchase_bills
         SET cgst_pct = ROUND((cgst_amount * 100.0 / NULLIF(sub_total, 0))::numeric, 2),
             sgst_pct = ROUND((sgst_amount * 100.0 / NULLIF(sub_total, 0))::numeric, 2),
             igst_pct = ROUND((igst_amount * 100.0 / NULLIF(sub_total, 0))::numeric, 2)
       WHERE COALESCE(cgst_pct, 0) = 0
         AND COALESCE(sgst_pct, 0) = 0
         AND COALESCE(igst_pct, 0) = 0
         AND (COALESCE(cgst_amount, 0) > 0 OR COALESCE(sgst_amount, 0) > 0 OR COALESCE(igst_amount, 0) > 0)
         AND COALESCE(sub_total, 0) > 0;

      -- Distribute bill-level tax into the per-item cgst/sgst/igst columns
      -- for any item whose tax columns are still zero on a bill that does
      -- have tax amounts. The share is proportional to taxable_amount.
      UPDATE sales_bill_items sbi
         SET cgst_amount = ROUND((sb.cgst_amount * sbi.taxable_amount / NULLIF(sb.sub_total, 0))::numeric, 2),
             sgst_amount = ROUND((sb.sgst_amount * sbi.taxable_amount / NULLIF(sb.sub_total, 0))::numeric, 2),
             igst_amount = ROUND((sb.igst_amount * sbi.taxable_amount / NULLIF(sb.sub_total, 0))::numeric, 2)
        FROM sales_bills sb
       WHERE sbi.sales_bill_id = sb.sales_bill_id
         AND COALESCE(sbi.cgst_amount, 0) = 0
         AND COALESCE(sbi.sgst_amount, 0) = 0
         AND COALESCE(sbi.igst_amount, 0) = 0
         AND (COALESCE(sb.cgst_amount, 0) > 0 OR COALESCE(sb.sgst_amount, 0) > 0 OR COALESCE(sb.igst_amount, 0) > 0)
         AND COALESCE(sb.sub_total, 0) > 0
         AND COALESCE(sbi.taxable_amount, 0) > 0;

      UPDATE purchase_bill_items pbi
         SET cgst_amount = ROUND((pb.cgst_amount * pbi.taxable_amount / NULLIF(pb.sub_total, 0))::numeric, 2),
             sgst_amount = ROUND((pb.sgst_amount * pbi.taxable_amount / NULLIF(pb.sub_total, 0))::numeric, 2),
             igst_amount = ROUND((pb.igst_amount * pbi.taxable_amount / NULLIF(pb.sub_total, 0))::numeric, 2)
        FROM purchase_bills pb
       WHERE pbi.purchase_bill_id = pb.purchase_bill_id
         AND COALESCE(pbi.cgst_amount, 0) = 0
         AND COALESCE(pbi.sgst_amount, 0) = 0
         AND COALESCE(pbi.igst_amount, 0) = 0
         AND (COALESCE(pb.cgst_amount, 0) > 0 OR COALESCE(pb.sgst_amount, 0) > 0 OR COALESCE(pb.igst_amount, 0) > 0)
         AND COALESCE(pb.sub_total, 0) > 0
         AND COALESCE(pbi.taxable_amount, 0) > 0;

      -- Backfill stock_ledger for sales/purchase items that don't have a
      -- matching movement row yet. This lights up Stock Movement for all
      -- imported bills. We deliberately do NOT touch products.current_stock —
      -- Tally's stock-summary import already set it to today's actual count,
      -- and decrementing now would double-subtract. balance_quantity is left
      -- at 0 because Stock Movement recomputes running balance client-side.
      INSERT INTO stock_ledger
        (product_id, barcode, transaction_type, transaction_date,
         reference_id, reference_number, quantity_in, quantity_out,
         rate, balance_quantity, remarks, created_date)
      SELECT sbi.product_id, sbi.barcode, 'Sales', sb.bill_date,
             sb.sales_bill_id, sb.bill_number, 0, sbi.quantity,
             sbi.rate, 0, 'Backfilled from imported Tally bill', NOW()
        FROM sales_bill_items sbi
        JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
       WHERE sbi.product_id IS NOT NULL
         AND sb.is_cancelled = false
         AND NOT EXISTS (
           SELECT 1 FROM stock_ledger sl
            WHERE sl.reference_id     = sb.sales_bill_id
              AND sl.reference_number = sb.bill_number
              AND sl.transaction_type = 'Sales'
              AND sl.product_id       = sbi.product_id
         );

      INSERT INTO stock_ledger
        (product_id, barcode, transaction_type, transaction_date,
         reference_id, reference_number, quantity_in, quantity_out,
         rate, balance_quantity, remarks, created_date)
      SELECT pbi.product_id, pbi.barcode, 'Purchase', pb.bill_date,
             pb.purchase_bill_id, pb.bill_number, pbi.quantity, 0,
             pbi.purchase_rate, 0, 'Backfilled from imported Tally bill', NOW()
        FROM purchase_bill_items pbi
        JOIN purchase_bills pb ON pb.purchase_bill_id = pbi.purchase_bill_id
       WHERE pbi.product_id IS NOT NULL
         AND pb.is_cancelled = false
         AND NOT EXISTS (
           SELECT 1 FROM stock_ledger sl
            WHERE sl.reference_id     = pb.purchase_bill_id
              AND sl.reference_number = pb.bill_number
              AND sl.transaction_type = 'Purchase'
              AND sl.product_id       = pbi.product_id
         );
    `).catch((err) => {
      // Log but don't crash on migration errors — the server should still
      // come up so an admin can investigate. Previously this was silently
      // swallowed with `() => {}`, which hid real schema problems (e.g. a
      // missing column would make every SELECT fail, but the user would
      // only see the symptom "page is empty" with no obvious cause).
      console.error('[Safe migrations] Error:', err.message);
    });

    // Seed default data
    await seedDefaultData();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`API available at http://localhost:${PORT}/api`);
      // Start auto-backup scheduler
      require('./controllers/backupController').initScheduler();
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    console.error('Make sure PostgreSQL is running and the database exists.');
    console.error('Create database: CREATE DATABASE billing_erp;');
    process.exit(1);
  }
}

startServer();
