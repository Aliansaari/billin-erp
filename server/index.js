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
app.use('/api/imports', require('./routes/imports'));
app.use('/api/tally/ledger-mapping', require('./routes/tallyMapping'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/data', require('./routes/importExport'));
app.use('/api/tally', require('./routes/tally'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/print', require('./routes/print'));
app.use('/api/godowns', require('./routes/godowns'));
app.use('/api/stock-transfers', require('./routes/stockTransfers'));
app.use('/api/user/favorites', require('./routes/userFavorites'));

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

      -- ── Phase 4: import job queue + tally ledger mapping ────────────
      -- The three new tables (import_jobs, import_batches,
      -- tally_ledger_mappings) are created by sequelize.sync. The worker
      -- crash-recovery sweep below relies on them existing; if a fresh
      -- install hasn't synced yet, the sweep no-ops cleanly.

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
      -- Repair drafts→parties FK on installs where Sequelize sync built the
      -- table before the DO $$ block (sync omits ON DELETE clauses, so the
      -- FK ends up NO ACTION and blocks party deletion). The intent is
      -- SET NULL: a deleted party converts held drafts to walk-in. Idempotent
      -- — only fires when confdeltype is anything other than 'n' (SET NULL).
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sales_bill_drafts_customer_id_fkey'
            AND confdeltype <> 'n'
        ) THEN
          ALTER TABLE sales_bill_drafts DROP CONSTRAINT sales_bill_drafts_customer_id_fkey;
          ALTER TABLE sales_bill_drafts
            ADD CONSTRAINT sales_bill_drafts_customer_id_fkey
            FOREIGN KEY (customer_id) REFERENCES parties(party_id) ON DELETE SET NULL;
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'purchase_bill_drafts_supplier_id_fkey'
            AND confdeltype <> 'n'
        ) THEN
          ALTER TABLE purchase_bill_drafts DROP CONSTRAINT purchase_bill_drafts_supplier_id_fkey;
          ALTER TABLE purchase_bill_drafts
            ADD CONSTRAINT purchase_bill_drafts_supplier_id_fkey
            FOREIGN KEY (supplier_id) REFERENCES parties(party_id) ON DELETE SET NULL;
        END IF;
      END $$;

      -- ── System "Cash" party + walk-in name columns ────────────────────
      -- Replace the old NULL-customer / per-import "Cash Sales" stub
      -- pattern with a single canonical Cash party. Every cash sale and
      -- cash purchase points at this row; the party leg posts to the
      -- Cash-in-Hand ledger directly (skipping Sundry Debtors/Creditors).
      -- Reports filter it out of receivables/payables aging and the
      -- Sundry Debtors/Creditors Trial Balance/Balance Sheet groups so it
      -- doesn't pollute those buckets with a non-credit party.
      --
      -- walk_in_name lets the operator capture the actual person's name
      -- on the bill ("Mr Sharma walked in and paid in cash") without
      -- creating a real per-person party row. Stored on the bill so it
      -- prints alongside "Cash" on the customer header and shows up on
      -- the second line of the list view.
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='parties' AND column_name='is_system_cash') THEN
          ALTER TABLE parties ADD COLUMN is_system_cash BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='sales_bills' AND column_name='walk_in_name') THEN
          ALTER TABLE sales_bills ADD COLUMN walk_in_name VARCHAR(120);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='purchase_bills' AND column_name='walk_in_name') THEN
          ALTER TABLE purchase_bills ADD COLUMN walk_in_name VARCHAR(120);
        END IF;
        -- purchase_bills.supplier_id was NOT NULL — relax that. After this
        -- change the only legal cash-purchase shape is supplier_id = system
        -- Cash party (also enforced by the form's required validation), so
        -- in practice we never write NULL going forward, but the relaxation
        -- removes a constraint conflict during the in-flight stub→Cash
        -- migration that runs further down on first boot.
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name='purchase_bills' AND column_name='supplier_id' AND is_nullable='NO'
        ) THEN
          ALTER TABLE purchase_bills ALTER COLUMN supplier_id DROP NOT NULL;
        END IF;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_one_system_cash
        ON parties (is_system_cash) WHERE is_system_cash = true;

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

    // ── Books-integrity FK hardening ─────────────────────────────────
    // The two FKs from ledger_entries to its parents (ledger_accounts
    // and parties) used to be ON DELETE CASCADE — Sequelize's hasMany
    // default. That silently wiped ₹8,606 of debits when a stub ledger
    // account was deleted. Append-only is now enforced at the DB level:
    // RESTRICT means you cannot delete a parent row that has any
    // ledger history. Removing a ledger / party requires reversing
    // every voucher first, then setting is_active=false.
    //
    // This is idempotent — running on a DB that's already been
    // hardened is a no-op (DROP CONSTRAINT IF EXISTS, then re-ADD).
    await sequelize.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ledger_entries_ledger_id_fkey'
             AND confdeltype = 'c'   -- 'c' = CASCADE
        ) THEN
          ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_ledger_id_fkey;
          ALTER TABLE ledger_entries
            ADD CONSTRAINT ledger_entries_ledger_id_fkey
            FOREIGN KEY (ledger_id) REFERENCES ledger_accounts(ledger_id)
            ON UPDATE CASCADE ON DELETE RESTRICT;
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ledger_entries_party_id_fkey'
             AND confdeltype = 'c'
        ) THEN
          ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_party_id_fkey;
          ALTER TABLE ledger_entries
            ADD CONSTRAINT ledger_entries_party_id_fkey
            FOREIGN KEY (party_id) REFERENCES parties(party_id)
            ON UPDATE CASCADE ON DELETE RESTRICT;
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[FK hardening] Error:', err.message);
    });

    // ── Godown / multi-warehouse migration ─────────────────────────────
    //
    // What runs here:
    //   1. ADD COLUMN godown_id (nullable) to stock_ledger + every bill
    //      table. Nullable for now — sync() can't add NOT NULL to a
    //      populated table, and we backfill rows below before any code
    //      starts depending on the column being NOT NULL. Flipping to
    //      NOT NULL is deferred to a follow-up commit once every controller
    //      reliably populates it.
    //   2. ADD COLUMN allowed_godowns JSONB to users.
    //   3. Partial unique index on godowns(is_default) WHERE is_default = true
    //      so exactly one godown can be flagged default at a time. Same
    //      pattern as the system-Cash party fixture.
    //   4. CHECK constraint on stock_transfers — from/to must differ.
    //      DB-level guard backing up the frontend disable.
    //
    // Idempotent: every step is wrapped in `IF NOT EXISTS` (or
    // `pg_indexes` / `pg_constraint` lookups for the index + check).
    // Running this block twice on the same DB is a no-op.
    //
    // The actual JS-side backfill (UPDATE legacy rows to godown_id=Main,
    // populate product_godown_stock from products.current_stock) lives
    // AFTER seedDefaultData() because it needs the seeded Main godown.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='stock_ledger' AND column_name='godown_id') THEN
          ALTER TABLE stock_ledger ADD COLUMN godown_id INTEGER REFERENCES godowns(godown_id);
          CREATE INDEX IF NOT EXISTS idx_stock_ledger_godown_id ON stock_ledger(godown_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='sales_bills' AND column_name='godown_id') THEN
          ALTER TABLE sales_bills ADD COLUMN godown_id INTEGER REFERENCES godowns(godown_id);
          CREATE INDEX IF NOT EXISTS idx_sales_bills_godown_id ON sales_bills(godown_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='purchase_bills' AND column_name='godown_id') THEN
          ALTER TABLE purchase_bills ADD COLUMN godown_id INTEGER REFERENCES godowns(godown_id);
          CREATE INDEX IF NOT EXISTS idx_purchase_bills_godown_id ON purchase_bills(godown_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='sales_return_bills' AND column_name='godown_id') THEN
          ALTER TABLE sales_return_bills ADD COLUMN godown_id INTEGER REFERENCES godowns(godown_id);
          CREATE INDEX IF NOT EXISTS idx_sales_return_bills_godown_id ON sales_return_bills(godown_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='purchase_return_bills' AND column_name='godown_id') THEN
          ALTER TABLE purchase_return_bills ADD COLUMN godown_id INTEGER REFERENCES godowns(godown_id);
          CREATE INDEX IF NOT EXISTS idx_purchase_return_bills_godown_id ON purchase_return_bills(godown_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='users' AND column_name='allowed_godowns') THEN
          ALTER TABLE users ADD COLUMN allowed_godowns JSONB DEFAULT NULL;
        END IF;
      END $$;

      -- Exactly one default godown, enforced by partial unique index.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_godowns_one_default
        ON godowns (is_default) WHERE is_default = true;

      -- Distinct from/to godowns on transfers (controller also guards;
      -- this is the authoritative DB-level invariant).
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'stock_transfers_distinct_godowns'
        ) THEN
          ALTER TABLE stock_transfers
            ADD CONSTRAINT stock_transfers_distinct_godowns
            CHECK (from_godown_id <> to_godown_id);
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Godown migration] Error:', err.message);
    });

    // ── One-time created_date alignment for the 6 ledger_entries
    // re-inserted during the corrupted-backfill incident (Apr 2026).
    // Those rows had their original Dr-leg created_date wiped by a
    // cascade-delete, then were rebuilt from the known amounts via
    // direct SQL INSERT with created_date=NOW(). Aligning to the
    // entry_date doesn't restore the original timestamp, but at
    // least keeps audit-log queries honest about the business date.
    // Idempotent — once aligned, re-running matches no rows.
    await sequelize.query(`
      UPDATE ledger_entries
         SET created_date = entry_date::timestamp
       WHERE narration = 'Cash sale (restored from corrupted backfill)'
         AND created_date::date <> entry_date;
    `).catch((err) => {
      console.error('[Created-date alignment] Error:', err.message);
    });

    // ── P&L sub_group reclassification (idempotent) ────────────────────
    //
    // Sales / Purchase + their Returns historically lived under
    // 'Direct Incomes' / 'Direct Expenses', but Tally treats them as
    // dedicated primary groups ('Sales Accounts', 'Purchase Accounts').
    // Direct Incomes / Direct Expenses are reserved for operational
    // direct items (service income, freight inward, factory wages, etc.),
    // which the P&L renders as a separate section.
    //
    // Without this fix the P&L either:
    //   · double-counts Sales Returns as Direct Income (instead of
    //     netting them under Sales), or
    //   · forces hardcoded ledger-name allowlists in the report query.
    //
    // The fix is a pure data migration: change sub_group on the four
    // system ledgers. Idempotent — re-running matches no rows after the
    // first pass. is_system_ledger=true gate keeps user-renamed ledgers
    // safe (a user could have created their own ledger named "Sales
    // Account" with a deliberate Direct Incomes classification).
    await sequelize.query(`
      UPDATE ledger_accounts
         SET sub_group = 'Sales Accounts'
       WHERE is_system_ledger = true
         AND ledger_group = 'Income'
         AND sub_group = 'Direct Incomes'
         AND ledger_name IN ('Sales Account', 'Sales Return');
      UPDATE ledger_accounts
         SET sub_group = 'Purchase Accounts'
       WHERE is_system_ledger = true
         AND ledger_group = 'Expenses'
         AND sub_group = 'Direct Expenses'
         AND ledger_name IN ('Purchase Account', 'Purchase Return');
    `).catch((err) => {
      console.error('[P&L sub_group reclassification] Error:', err.message);
    });

    // ── payments_receipts.payment_method (R8 follow-up) ──────────────
    //
    // Denormalised mode field — Cash / Bank Transfer / Cheque / UPI /
    // Card / Credit. Populated:
    //   · auto-receipts → copied from source bill on sync
    //   · manual receipts → from the first PaymentSplit at create time
    //                       (or 'Mixed' for multi-split)
    //
    // Without this, the Receipts list "Mode" column reads from
    // payment_splits — which was never populated for the existing
    // 17 seed receipts AND can't represent mode for auto-receipts at
    // all (they have no splits row by design). One-time backfill below
    // recovers the value for existing rows.
    //
    // Idempotent: re-runs are no-ops once the column exists + backfill
    // has run (UPDATE filters on payment_method IS NULL).
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='payments_receipts' AND column_name='payment_method') THEN
          ALTER TABLE payments_receipts
            ADD COLUMN payment_method VARCHAR(20);
          CREATE INDEX idx_payments_receipts_method ON payments_receipts(payment_method) WHERE payment_method IS NOT NULL;
        END IF;
      END $$;
      -- Backfill — auto-receipts copy from source bill
      UPDATE payments_receipts pr
         SET payment_method = b.payment_method
        FROM sales_bills b
       WHERE pr.payment_method IS NULL
         AND pr.source = 'auto_from_bill'
         AND pr.transaction_type = 'Receipt'
         AND pr.source_bill_id = b.sales_bill_id
         AND b.payment_method IS NOT NULL;
      -- For manual receipts/payments with exactly one PaymentSplit,
      -- adopt the split's mode. Multi-split rows are left NULL and
      -- render as 'Mixed' on the UI.
      UPDATE payments_receipts pr
         SET payment_method = ps.payment_mode
        FROM payment_splits ps
       WHERE pr.payment_method IS NULL
         AND pr.source = 'manual'
         AND pr.transaction_id = ps.transaction_id
         AND (SELECT COUNT(*) FROM payment_splits ps2
               WHERE ps2.transaction_id = pr.transaction_id) = 1;
    `).catch((err) => {
      console.error('[payments_receipts.payment_method] Error:', err.message);
    });

    // ── Two-way ledger schema (Phase 1, R8) ──────────────────────────
    //
    // Auto-generated Receipt/Payment vouchers from embedded bill
    // payments. Adds:
    //   · payments_receipts.source        — manual | auto_from_bill
    //   · payments_receipts.source_bill_id — FK to source bill (null
    //                                       on manual entries)
    //   · bill_payment_allocations TABLE   — links a receipt/payment
    //                                       row to one or more bills
    //                                       with allocated_amount
    //
    // The voucher builders ALREADY emit a separate Receipt voucher for
    // paid credit sales (source_type='sales_bill_receipt'); what was
    // missing was the corresponding payments_receipts row + an
    // allocation linking it to the source bill. Phase 2 (separate
    // commit) wires the auto-row insertion into the voucher pipeline
    // and the cancel/edit cascade.
    //
    // All idempotent — wrapped in DO/IF NOT EXISTS blocks so re-runs
    // are no-ops on a migrated DB.
    await sequelize.query(`
      DO $$ BEGIN
        -- payments_receipts.source — distinguishes auto-generated
        -- bill receipts from operator-entered standalone receipts.
        -- The Receipts list filters on this; auto rows are read-only
        -- (must be edited via the source bill).
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name='payments_receipts' AND column_name='source'
        ) THEN
          CREATE TYPE enum_payments_receipts_source AS ENUM ('manual', 'auto_from_bill');
          ALTER TABLE payments_receipts ADD COLUMN source enum_payments_receipts_source DEFAULT 'manual';
        END IF;
        -- payments_receipts.source_bill_id — points at the originating
        -- sales_bill_id or purchase_bill_id (which is implied by
        -- transaction_type='Receipt'/'Payment'). Polymorphic FK
        -- isn't enforced at DB level (the table is unified across
        -- both sales + purchase); the Phase 2 voucher logic guarantees
        -- the pairing's correct.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name='payments_receipts' AND column_name='source_bill_id'
        ) THEN
          ALTER TABLE payments_receipts ADD COLUMN source_bill_id INTEGER;
          CREATE INDEX idx_payments_receipts_source_bill ON payments_receipts(source_bill_id) WHERE source_bill_id IS NOT NULL;
        END IF;

        -- bill_payment_allocations — links a payments_receipts row
        -- (transaction_id) to one or more bills (sales_bill_id /
        -- purchase_bill_id) with an allocated_amount. Polymorphic via
        -- bill_type ENUM since payments_receipts itself is unified.
        --
        -- ON DELETE: allocation rows are dependent on the receipt —
        -- cascade-delete with the receipt (CASCADE). The bill side
        -- is the source-of-truth for outstanding (RESTRICT — can't
        -- delete a bill that has live receipt allocations).
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_name='bill_payment_allocations') THEN
          CREATE TYPE enum_bill_payment_allocations_bill_type AS ENUM ('Sales', 'Purchase');
          CREATE TYPE enum_bill_payment_allocations_method   AS ENUM ('fifo_auto', 'manual', 'auto_from_bill');
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
    `).catch((err) => {
      console.error('[Two-way ledger schema] Error:', err.message);
    });

    // ── R9: extend allocation_method enum for import + backfill paths ──
    //
    // Phase 1 of R9 wires Excel + Tally orchestrators to write allocations
    // when receipts/payments come in via import. Phase 2 backfills the
    // historical seeded rows that pre-date the auto-receipt service.
    // Each writer tags its rows with a distinct method so audit + drift
    // analysis can attribute each row to its source.
    //
    // Idempotent — IF NOT EXISTS on each ADD VALUE so re-runs are no-ops.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_enum
                       WHERE enumtypid = 'enum_bill_payment_allocations_method'::regtype
                         AND enumlabel = 'import_excel') THEN
          ALTER TYPE enum_bill_payment_allocations_method ADD VALUE 'import_excel';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_enum
                       WHERE enumtypid = 'enum_bill_payment_allocations_method'::regtype
                         AND enumlabel = 'import_tally') THEN
          ALTER TYPE enum_bill_payment_allocations_method ADD VALUE 'import_tally';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_enum
                       WHERE enumtypid = 'enum_bill_payment_allocations_method'::regtype
                         AND enumlabel = 'backfill_fifo') THEN
          ALTER TYPE enum_bill_payment_allocations_method ADD VALUE 'backfill_fifo';
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[R9 enum extension] Error:', err.message);
    });

    // ── R8 Phase 3: auto-receipt backfill (boot-time) ────────────────
    //
    // Inserts the missing payments_receipts row + bill_payment_alloc-
    // ations row for any paid credit-sale bill that already has a
    // sales_bill_receipt voucher in the journal but no corresponding
    // entry in payments_receipts. Mirror logic for purchase side.
    //
    // Same code path as `node server/scripts/backfill-auto-receipts.js
    // --apply`, but called inline so production environments clear the
    // legacy rows on next deploy without an extra ops step. Idempotent
    // — the planSide() lookup excludes already-migrated rows, so
    // every subsequent boot is a no-op.
    //
    // Out-of-scope, never touched: system Cash party bills (cash sales,
    // single voucher) and bills with NULL party (legacy cash-without-
    // party rows; need a separate migration to attach to system Cash).
    try {
      const { planSide, applyPlan } = require('./scripts/backfill-auto-receipts');
      if (typeof planSide === 'function' && typeof applyPlan === 'function') {
        for (const kind of ['sales', 'purchase']) {
          const plan = await planSide(kind);
          if (plan.in_scope.length > 0) {
            const res = await applyPlan(plan);
            console.log(`[R8 backfill] ${kind}: inserted ${res.inserted} auto-${kind === 'sales' ? 'receipt' : 'payment'}(s)`);
          }
        }
      }
    } catch (err) {
      // Non-fatal: log + continue. The legacy rows will keep showing
      // I1.sales / I5 violations on the integrity screen, which is
      // visible enough that an admin will notice and re-run manually.
      console.warn('[R8 backfill] Skipped:', err.message);
    }

    // ── Batch tracking schema ─────────────────────────────────────────
    //
    // The two new tables (product_batches, product_batch_stock) are created
    // by sequelize.sync above. The block below is for COLUMN additions on
    // existing tables (idempotent — IF NOT EXISTS gates re-runs).
    //
    // All new columns are nullable: a non-batch-tracked product / movement
    // / bill line keeps batch_id NULL. The "required for batch-tracked
    // products" rule is enforced at the application layer (controllers),
    // not at the DB level — a single CHECK can't express "NULL only when
    // products.is_batch_tracked = false".
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='is_batch_tracked') THEN
          ALTER TABLE products ADD COLUMN is_batch_tracked BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='batch_expiry_alert_days') THEN
          ALTER TABLE system_settings ADD COLUMN batch_expiry_alert_days INTEGER DEFAULT 30;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='block_expired_sales') THEN
          ALTER TABLE system_settings ADD COLUMN block_expired_sales BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='allow_zero_stock_batches') THEN
          ALTER TABLE system_settings ADD COLUMN allow_zero_stock_batches BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock_ledger' AND column_name='batch_id') THEN
          ALTER TABLE stock_ledger ADD COLUMN batch_id INTEGER REFERENCES product_batches(batch_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_bill_items' AND column_name='batch_id') THEN
          ALTER TABLE sales_bill_items ADD COLUMN batch_id INTEGER REFERENCES product_batches(batch_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bill_items' AND column_name='batch_id') THEN
          ALTER TABLE purchase_bill_items ADD COLUMN batch_id INTEGER REFERENCES product_batches(batch_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_return_bill_items' AND column_name='batch_id') THEN
          ALTER TABLE sales_return_bill_items ADD COLUMN batch_id INTEGER REFERENCES product_batches(batch_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_return_bill_items' AND column_name='batch_id') THEN
          ALTER TABLE purchase_return_bill_items ADD COLUMN batch_id INTEGER REFERENCES product_batches(batch_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock_transfer_items' AND column_name='batch_id') THEN
          ALTER TABLE stock_transfer_items ADD COLUMN batch_id INTEGER REFERENCES product_batches(batch_id);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_stock_ledger_product_batch_date
        ON stock_ledger (product_id, batch_id, transaction_date);
      CREATE INDEX IF NOT EXISTS idx_sales_bill_items_batch
        ON sales_bill_items (batch_id);
      CREATE INDEX IF NOT EXISTS idx_purchase_bill_items_batch
        ON purchase_bill_items (batch_id);
      CREATE INDEX IF NOT EXISTS idx_product_batches_expiry
        ON product_batches (expiry_date);
      CREATE INDEX IF NOT EXISTS idx_product_batches_product_expiry
        ON product_batches (product_id, expiry_date);
    `).catch((err) => {
      console.error('[Batch tracking migration] Error:', err.message);
    });

    // Seed default data
    await seedDefaultData();

    // ── Godown backfill (must run AFTER seed so the Main godown exists)
    //
    // Pre-multi-warehouse rows have no godown_id. Pin them to the seeded
    // Main godown — that's the historically-correct location since there
    // was no other warehouse to choose from.
    //
    // Also seed product_godown_stock with one row per product at Main,
    // copying the existing products.current_stock and opening_stock
    // values across so all reports keep showing the same numbers post-
    // migration. ON CONFLICT DO NOTHING means a re-run skips already-seeded
    // pairs (idempotent).
    //
    // products.current_stock is intentionally NOT dropped — too many
    // (>100) call sites read it directly. It becomes a denormalized mirror
    // = SUM(product_godown_stock.current_stock) maintained by
    // applyGodownStockDelta. A follow-up commit can drop the column once
    // every reader switches to the join table.
    try {
      const { Godown } = require('./models');
      const main = await Godown.findOne({ where: { is_default: true } });
      if (main) {
        const gid = main.godown_id;
        const before = {};
        for (const tbl of ['stock_ledger', 'sales_bills', 'purchase_bills', 'sales_return_bills', 'purchase_return_bills']) {
          const [[r]] = await sequelize.query(
            `UPDATE ${tbl} SET godown_id = :gid WHERE godown_id IS NULL RETURNING ledger_id, sales_bill_id, purchase_bill_id, sales_return_id, purchase_return_id`,
            { replacements: { gid } },
          ).catch(() => [[]]);
          before[tbl] = r ? Object.values(r).filter(Boolean).length : 0;
        }
        // Rough log so an admin watching boot logs sees the backfill happen
        // exactly once (subsequent boots return zero rows from the UPDATEs
        // because no NULLs remain).
        const totalBackfilled = Object.values(before).reduce((a, b) => a + b, 0);
        if (totalBackfilled > 0) {
          console.log(`[Godown backfill] pinned ${totalBackfilled} legacy row(s) to Main godown (id=${gid})`);
        }

        // Per-product seed at Main godown. INSERT … SELECT so we get one
        // row per product without N round-trips. ON CONFLICT skips the
        // (product_id, godown_id) PK collision when re-running.
        const [pgsResult] = await sequelize.query(
          `INSERT INTO product_godown_stock
             (product_id, godown_id, current_stock, opening_stock, created_date, modified_date)
           SELECT p.product_id, :gid,
                  COALESCE(p.current_stock, 0),
                  COALESCE(p.opening_stock, 0),
                  NOW(), NOW()
             FROM products p
            ON CONFLICT (product_id, godown_id) DO NOTHING`,
          { replacements: { gid } },
        );
        const inserted = (pgsResult && pgsResult.rowCount) || 0;
        if (inserted > 0) {
          console.log(`[Godown backfill] seeded product_godown_stock for ${inserted} product(s) at Main godown`);
        }
      } else {
        console.warn('[Godown backfill] Main godown missing — skipped backfill (seeder will retry on next boot)');
      }
    } catch (err) {
      console.error('[Godown backfill] Error:', err.message);
    }

    // ── One-shot migration: legacy "Cash Sales" / "Cash Purchases"
    //    stub parties → seeded system Cash party. Idempotent — finds
    //    no candidates after first run. Has to live HERE (not inside
    //    the SQL migration block above) because it needs Sequelize
    //    models + the ledger posting service to reverse + repost
    //    vouchers safely. Errors are logged but don't crash the
    //    server: the system Cash party is already seeded above, so
    //    fresh installs and already-migrated installs are unaffected;
    //    only an in-flight migration with a partial failure would
    //    benefit from manual intervention, and surfacing the error to
    //    the admin via the log is the right move.
    try {
      const { migrateStubsToSystemCash } = require('./scripts/migrate-stubs-to-system-cash');
      const result = await migrateStubsToSystemCash();
      if (result.migrated > 0) {
        console.log(`[Cash stub migration] migrated ${result.migrated} stub party(ies), ${result.billsRepointed} bill(s) repointed`);
      }
    } catch (err) {
      console.error('[Cash stub migration] Error:', err.message);
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`API available at http://localhost:${PORT}/api`);
      // Start auto-backup scheduler
      require('./controllers/backupController').initScheduler();
      // Import job worker — recover orphans first, then start polling.
      const importWorker = require('./services/importJobWorker');
      importWorker.recoverOrphans()
        .then(() => importWorker.start())
        .catch((e) => console.error('[importJobWorker] failed to start:', e.message));
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    console.error('Make sure PostgreSQL is running and the database exists.');
    console.error('Create database: CREATE DATABASE billing_erp;');
    process.exit(1);
  }
}

startServer();
