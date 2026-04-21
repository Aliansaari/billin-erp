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
app.use('/api/sales', require('./routes/sales'));
app.use('/api/sales-returns', require('./routes/salesReturns'));
app.use('/api/purchase-returns', require('./routes/purchaseReturns'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/data', require('./routes/importExport'));
app.use('/api/backup', require('./routes/backup'));

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
      END $$;
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
