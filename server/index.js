require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const os = require('os');
const path = require('path');
const { sequelize } = require('./models');
const seedDefaultData = require('./seeders/defaultData');

const app = express();
const PORT = process.env.SERVER_PORT || 3001;

/* ── LAN-aware middleware stack ────────────────────────────────────────
 *
 * The server is designed to run in three deployment modes simultaneously:
 *
 *   1) Single machine (default)   — Electron + Vite + server all on
 *      one PC; only localhost talks to it.
 *
 *   2) LAN host                   — one PC runs the server, other PCs
 *      on the same office Wi-Fi/LAN connect via the host's IP. Needs
 *      CORS open to private-IP clients and Express trusting the proxy.
 *
 *   3) Browser-only client        — a Wi-Fi-only laptop / tablet that
 *      can't run Electron. It opens http://<host-ip>:3001 directly,
 *      and this Express server delivers the React SPA + API from the
 *      same origin. No CORS issues at all because the browser is on
 *      the same origin.
 *
 * Helmet and compression are universally applied. CORS uses a function
 * origin so we can dynamically allow private RFC1918 ranges without
 * having to enumerate every client's IP in env. */

// helmet: sensible default security headers. Drop the strict CSP — the
// app uses inline styles (antd, dynamic CSS-in-JS) and inline event
// handlers in print-preview iframes, and our LAN deployment isn't
// public-internet-facing so the CSP value is low. crossOriginResourcePolicy
// must allow loading our own static assets from a different IP than the
// API origin (e.g. browser-only clients hitting :3001).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));

// gzip every response > 1 KiB. Electron clients on localhost don't benefit
// much (loopback is already fast), but LAN browser clients pulling the
// 2 MB Vite bundle do — first-load drops from ~2 MB to ~600 KB on the wire.
app.use(compression({
  threshold: 1024,
  // PDF/Excel exports are already binary-compressed; skip them so we
  // don't pay CPU recompressing for no win.
  filter: (req, res) => {
    const type = res.getHeader('Content-Type') || '';
    if (/^application\/(pdf|vnd\.openxmlformats|octet-stream)/i.test(String(type))) return false;
    return compression.filter(req, res);
  },
}));

// Trust proxy (X-Forwarded-For) so req.ip resolves correctly when the
// server sits behind a reverse proxy. Limited to "loopback, linklocal,
// uniquelocal" so a client on the LAN can't spoof a fake IP into the
// auth-rate-limit key.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

/* CORS — allow:
 *
 *   - The literal CLIENT_URL from env (legacy single-machine setup)
 *   - http(s)://localhost and 127.0.0.1 on any port (dev / Electron)
 *   - Any RFC1918 private-IP range on any port:
 *       10.0.0.0/8         (10.x.x.x)
 *       172.16.0.0/12      (172.16-31.x.x)
 *       192.168.0.0/16     (192.168.x.x)
 *       169.254.0.0/16     (link-local — rare but valid for ad-hoc Wi-Fi)
 *   - Any extra origins listed in CORS_EXTRA_ORIGINS (comma-separated)
 *     so an admin can whitelist a custom hostname like "shop.local" or
 *     "billing.office.example.com".
 *
 * Same-origin browser-only clients (those served the SPA from /dist by
 * THIS server) don't hit the function — they have no Origin header
 * because the API and the page share an origin.
 *
 * Origin-less requests (curl, native mobile apps, server-to-server) are
 * permitted — we authenticate via Bearer JWT, not via origin.
 */
// Pattern matches an `Origin` header from a private-IP client. Each
// RFC1918 range gets its own alternative — combining them under one
// shared "(?:10|192.168|169.254)" prefix would miscount octets, since
// 10.x.x.x has THREE octets after "10" while 192.168.x.x has only TWO
// after "192.168". Spelled out fully here for clarity.
const PRIVATE_IP_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?::\d+)?$/i;
const EXTRA_ORIGINS = (process.env.CORS_EXTRA_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const LEGACY_ORIGIN = process.env.CLIENT_URL || 'http://localhost:5173';
app.use(cors({
  credentials: true,
  // Returning `cb(null, false)` for an unknown origin tells the cors
  // middleware "skip the CORS headers entirely" — the preflight returns
  // 204 without Access-Control-Allow-Origin, which the browser then
  // refuses to use. That's the canonical CORS-deny behaviour. (Earlier
  // we returned `cb(new Error(...))`, which propagated as a 500 to the
  // global error handler — looked like a server bug to LAN admins.)
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                                  // curl / native app / same-origin
    if (origin === LEGACY_ORIGIN) return cb(null, true);
    if (PRIVATE_IP_RE.test(origin)) return cb(null, true);
    if (EXTRA_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Uploads directory
const fs = require('fs');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// LAN gate — enforces dev_lan_enabled + dev_lan_max_clients from
// system_settings. Mounted before the API routes so a denied client
// gets a 503 instead of (e.g.) a successful login. Health and
// server-info endpoints are exempt inside the middleware itself so
// the Server Setup screen can still probe.
const { lanGate } = require('./middleware/lanGate');
app.use('/api', lanGate);

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
app.use('/api/batches', require('./routes/batches'));
app.use('/api/user/favorites', require('./routes/userFavorites'));
app.use('/api/banks', require('./routes/banks'));
app.use('/api/loans', require('./routes/loans'));
app.use('/api/cheques', require('./routes/cheques'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/companies', require('./routes/companies'));

// Enumerate every IPv4 the host advertises so client setup screens can
// show the user "your office machines should connect to ANY of these
// addresses". Filters out internal (loopback) and IPv6 — those aren't
// useful for LAN peers.
function getLanAddresses() {
  const ifaces = os.networkInterfaces();
  const addrs = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const iface of (list || [])) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      addrs.push({ iface: name, address: iface.address, netmask: iface.netmask, mac: iface.mac });
    }
  }
  return addrs;
}

const SERVER_VERSION = require('../package.json').version || '0.0.0';

/* ── Health & discovery endpoints ───────────────────────────────────────
 *
 * /api/health      — 200 OK plus DB connectivity. Browser-only clients
 *                    poll this in the Server Setup screen to confirm
 *                    they typed the right IP/port.
 *
 * /api/server-info — descriptive: hostname, version, all the LAN IPs
 *                    the host advertises, the port it's listening on,
 *                    and a copy-pasteable URL for each. The Settings
 *                    > Network page renders this so an admin can read
 *                    the address out to office staff.
 *
 * Both endpoints are intentionally unauthenticated: a Wi-Fi-only client
 * needs to be able to confirm the server URL BEFORE it can log in. They
 * leak no sensitive data — just version + LAN IP, which any device on
 * the same network already knows. */
app.get('/api/health', async (req, res) => {
  let dbOk = true;
  let dbError = null;
  try {
    await sequelize.authenticate();
  } catch (e) {
    dbOk = false;
    dbError = e.message;
  }
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk,
    db_error: dbError,
    version: SERVER_VERSION,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/server-info', (req, res) => {
  const addrs = getLanAddresses();
  // Surface live concurrency state so the Developer Settings page can
  // render "3 of 10 clients active" without polling a separate endpoint.
  const { getActiveClients } = require('./middleware/lanGate');
  res.json({
    name: 'Billing ERP',
    version: SERVER_VERSION,
    hostname: os.hostname(),
    platform: process.platform,
    port: PORT,
    addresses: addrs,
    // Convenience: pre-built URLs the user can copy-paste
    urls: addrs.map(a => `http://${a.address}:${PORT}`),
    active_clients: getActiveClients(),
    timestamp: new Date().toISOString(),
  });
});

/* ── SPA delivery to browser-only clients ──────────────────────────────
 *
 * If a `dist/` build exists, serve it from the same Express app. This
 * is the bridge that lets a Wi-Fi-only laptop/tablet bill from a browser
 * by visiting http://<host-ip>:3001 directly — same origin as the API,
 * so no CORS, no token-leakage between origins, no Electron required.
 *
 * Previously this was gated on NODE_ENV === 'production', which meant
 * `npm run server` (used in dev) wouldn't serve the SPA even if a build
 * was present. Now it auto-detects: if the build is there, serve it; if
 * it's not, return a friendly hint at the root so the admin knows to
 * `npm run build` first.
 *
 * Cache headers: the Vite build emits hashed filenames (assets/*.[hash].js)
 * so they're safe to cache aggressively. index.html stays no-cache so a
 * server upgrade is picked up by clients on next refresh.
 */
const distDir = path.join(__dirname, '..', 'dist');
const distExists = fs.existsSync(path.join(distDir, 'index.html'));
if (distExists) {
  /* The Vite build emits relative asset paths (./assets/*.js) so the
   * same dist/ also works under file:// inside Electron. But that means
   * a browser landing on a deep-link route like /sale/new would resolve
   * ./assets/x.js to /sale/assets/x.js — 404. To handle both cases from
   * one build, we inject `<base href="/">` into the HTML we serve over
   * HTTP. Relative URLs then resolve from the document root regardless
   * of how deep the deep-link is.
   *
   * Electron's loadFile() reads the on-disk file directly and doesn't
   * pass through this transformer, so the file:// case keeps the
   * original (untouched) index.html. There ./assets/x.js resolves
   * relative to the file location — which IS the dist directory — so
   * everything works.
   */
  let indexHtml;
  try {
    const raw = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    indexHtml = raw.includes('<base ')
      ? raw
      : raw.replace(/<head([^>]*)>/i, '<head$1>\n    <base href="/" />');
  } catch (e) {
    console.error('[SPA serve] failed to read dist/index.html:', e.message);
    indexHtml = null;
  }

  // Hashed assets — 1 year, immutable.
  app.use('/assets', express.static(path.join(distDir, 'assets'), {
    maxAge: '365d',
    immutable: true,
    index: false,
  }));
  // Everything else (favicon, manifest, root-level files) — 1 day.
  // Skip serving index.html through the static handler so our
  // transformed copy below wins for both root and deep-link routes.
  app.use(express.static(distDir, {
    maxAge: '1d',
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  // SPA fallback — non-/api, non-/assets, non-extension routes return
  // the transformed index.html so React Router can take over. The two
  // exclusions matter because:
  //   - /api/* — should 404 if a route is missing (caller bug), not
  //     silently render the SPA shell.
  //   - /assets/* and /*.{ext} — a missing/stale-hash asset returning
  //     index.html (Content-Type: text/html) makes the BROWSER refuse
  //     to use it as JS/CSS, and the page renders blank with a
  //     "Refused to apply style/script" error in the console. Letting
  //     it 404 lets a stale-cache reload recover instead of silently
  //     painting white.
  app.get(/^\/(?!api(\/|$)|assets\/|.*\.[a-z0-9]+$).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (indexHtml) {
      res.type('html').send(indexHtml);
    } else {
      res.sendFile(path.join(distDir, 'index.html'));
    }
  });
} else {
  // No build yet: hint the admin instead of returning a blank 404.
  app.get('/', (req, res) => {
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Billing ERP</title>` +
      `<body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto">` +
      `<h2 style="margin-top:0">Billing ERP — API only</h2>` +
      `<p>The server is running and the API is live at <code>/api</code>.</p>` +
      `<p>To serve the web UI to browser-only clients on your LAN, build the frontend first:</p>` +
      `<pre style="background:#f4f4f5;padding:12px;border-radius:6px">npm run build</pre>` +
      `<p>Then restart the server.</p>` +
      `<hr><p style="color:#666;font-size:13px">Health: <a href="/api/health">/api/health</a> · ` +
      `Network info: <a href="/api/server-info">/api/server-info</a></p></body>`,
    );
  });
}

// Database sync and start server
async function startServer() {
  try {
    // ── Multi-company bootstrap ───────────────────────────────────────
    // Runs FIRST: ensures the master DB exists, syncs the companies
    // table, and registers the existing single-DB install as the
    // "primary company" if it hasn't been registered yet. Idempotent —
    // safe on every boot. Throws if the master DB can't be reached, in
    // which case startup aborts so we don't run half-initialised.
    const { runCompanyBootstrap } = require('./services/companyBootstrap');
    await runCompanyBootstrap();
    console.log('Multi-company bootstrap complete');

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

    // ── Bank reconciliation: cleared_at on payment_receipts ──────
    // Tier-2 bank statement feature. NULL = uncleared (cheque in
    // transit, deposit not yet posted by the bank). Set to a date
    // when the operator ticks the row in the Bank Statement view.
    // cleared_by tracks who reconciled for the audit trail.
    // Idempotent — IF NOT EXISTS guards.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'payments_receipts' AND column_name = 'cleared_at'
        ) THEN
          ALTER TABLE payments_receipts ADD COLUMN cleared_at TIMESTAMP WITH TIME ZONE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'payments_receipts' AND column_name = 'cleared_by'
        ) THEN
          ALTER TABLE payments_receipts ADD COLUMN cleared_by INTEGER REFERENCES users(user_id);
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Bank reconciliation migration] Error:', err.message);
    });

    // ── Loan accounts ─────────────────────────────────────────────
    //
    // A loan has two parts: the underlying ledger account (so it lives
    // in trial balance / ledger statement / journal posting like every
    // other ledger) and a sidecar table of loan-specific metadata
    // (principal, rate, tenure, EMI amount, dates). The sidecar joins
    // 1:1 to ledger_accounts by ledger_id.
    //
    // Loan types:
    //   • taken  → liability, sub_group='Loans (Liability)'
    //   • given  → asset,     sub_group='Loans & Advances (Asset)'
    //
    // We also pre-seed two system ledgers ('Interest Expense' under
    // Indirect Expenses, 'Interest Income' under Indirect Incomes) so
    // the Record-EMI flow always has a destination for the interest
    // leg without asking the operator to set them up. They're created
    // idempotently — IF NOT EXISTS guards.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'loan_accounts'
        ) THEN
          CREATE TABLE loan_accounts (
            loan_id            SERIAL PRIMARY KEY,
            ledger_id          INTEGER NOT NULL UNIQUE
                               REFERENCES ledger_accounts(ledger_id) ON DELETE CASCADE,
            loan_type          VARCHAR(10)  NOT NULL CHECK (loan_type IN ('taken','given')),
            party_id           INTEGER REFERENCES parties(party_id),
            principal          DECIMAL(15,2) NOT NULL DEFAULT 0,
            interest_rate      DECIMAL(6,3)  NOT NULL DEFAULT 0,
            tenure_months      INTEGER       NOT NULL DEFAULT 0,
            disbursement_date  DATE,
            first_emi_date     DATE,
            emi_amount         DECIMAL(15,2),
            emi_day            INTEGER,
            notes              TEXT,
            created_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
          CREATE INDEX idx_loan_accounts_ledger ON loan_accounts(ledger_id);
          CREATE INDEX idx_loan_accounts_party  ON loan_accounts(party_id);
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Loan accounts migration] Error:', err.message);
    });

    // Pre-seed Interest Expense / Interest Income system ledgers used by
    // the Record-EMI flow. We pick the existing canonical groups so the
    // P&L places them under the right heading.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM ledger_accounts WHERE ledger_name = 'Interest Expense'
        ) THEN
          INSERT INTO ledger_accounts (ledger_name, ledger_group, sub_group,
                                       opening_balance, opening_balance_type,
                                       current_balance, is_system_ledger, is_active,
                                       created_date)
          VALUES ('Interest Expense', 'Expenses', 'Indirect Expenses',
                  0, 'Debit', 0, false, true, CURRENT_DATE);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM ledger_accounts WHERE ledger_name = 'Interest Income'
        ) THEN
          INSERT INTO ledger_accounts (ledger_name, ledger_group, sub_group,
                                       opening_balance, opening_balance_type,
                                       current_balance, is_system_ledger, is_active,
                                       created_date)
          VALUES ('Interest Income', 'Income', 'Indirect Incomes',
                  0, 'Credit', 0, false, true, CURRENT_DATE);
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Interest ledgers seed] Error:', err.message);
    });

    // ── Per-bank posting: bank_ledger_id on splits + sales_bills ──
    //
    // Before this migration, every non-cash payment posted to a single
    // hardcoded ledger named 'Bank Account' (see voucherBuilders.js
    // paymentMethodToLedger). That made multi-bank reconciliation
    // impossible — every bank ledger but the system one was empty.
    //
    // Now each split / sales-bill carries the chosen bank ledger as a
    // FK. NULL means cash (or legacy not-yet-backfilled). The voucher
    // builder prefers bank_ledger_id; falls back to ledger_name='Bank
    // Account' for compatibility with rows created before the form
    // change shipped.
    //
    // Backfill: every existing non-cash row points at the singleton
    // 'Bank Account' ledger so historical reconciliation totals and
    // ledger statements stay consistent. Cash rows stay NULL.
    await sequelize.query(`
      DO $$
      DECLARE
        bank_account_id INTEGER;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'payment_splits' AND column_name = 'bank_ledger_id'
        ) THEN
          ALTER TABLE payment_splits
            ADD COLUMN bank_ledger_id INTEGER REFERENCES ledger_accounts(ledger_id);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'sales_bills' AND column_name = 'bank_ledger_id'
        ) THEN
          ALTER TABLE sales_bills
            ADD COLUMN bank_ledger_id INTEGER REFERENCES ledger_accounts(ledger_id);
        END IF;

        -- Find the seeded singleton bank ledger. If it's missing (a
        -- reseed that renamed it, or a fresh DB without seeds yet),
        -- skip the backfill silently — there's nothing to point at.
        SELECT ledger_id INTO bank_account_id
          FROM ledger_accounts
         WHERE ledger_name = 'Bank Account'
         LIMIT 1;

        IF bank_account_id IS NOT NULL THEN
          -- Splits: anything that wasn't cash points at the legacy bank.
          UPDATE payment_splits
             SET bank_ledger_id = bank_account_id
           WHERE bank_ledger_id IS NULL
             AND payment_mode IS NOT NULL
             AND payment_mode <> 'Cash';

          -- Sales bills: same rule — non-cash payment_method backfills.
          UPDATE sales_bills
             SET bank_ledger_id = bank_account_id
           WHERE bank_ledger_id IS NULL
             AND payment_method IS NOT NULL
             AND payment_method <> 'Cash'
             AND paid_amount > 0;
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Bank ledger FK migration] Error:', err.message);
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

        -- ── Developer-tier feature gates ───────────────────────────
        -- See SystemSettings.js for rationale per column. Each flag
        -- controls whether the corresponding feature is visible to
        -- non-developer users; developers see everything regardless.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='dev_show_ledger_integrity') THEN
          ALTER TABLE system_settings ADD COLUMN dev_show_ledger_integrity BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='dev_show_data_cleanup') THEN
          ALTER TABLE system_settings ADD COLUMN dev_show_data_cleanup BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='dev_show_backup_restore') THEN
          ALTER TABLE system_settings ADD COLUMN dev_show_backup_restore BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='dev_show_tally_sync') THEN
          ALTER TABLE system_settings ADD COLUMN dev_show_tally_sync BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='dev_show_import_export') THEN
          ALTER TABLE system_settings ADD COLUMN dev_show_import_export BOOLEAN DEFAULT TRUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='dev_show_server_settings') THEN
          ALTER TABLE system_settings ADD COLUMN dev_show_server_settings BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='dev_lan_enabled') THEN
          ALTER TABLE system_settings ADD COLUMN dev_lan_enabled BOOLEAN DEFAULT TRUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='system_settings' AND column_name='dev_lan_max_clients') THEN
          ALTER TABLE system_settings ADD COLUMN dev_lan_max_clients INTEGER DEFAULT 0;
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
        -- Doc-subtitle override. Blank = renderer falls back to the
        -- per-doc-type default ("TAX INVOICE", "PURCHASE BILL", etc.).
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='print_profiles' AND column_name='doc_label') THEN
          ALTER TABLE print_profiles ADD COLUMN doc_label VARCHAR(60) DEFAULT '';
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

    // ── Report favourites: rename 'movers' → 'fast_slow_stock' ──────
    // The Fast & Slow Stock report's registry id was renamed from
    // 'movers' so the code matches the user-facing label. This bulk
    // updates any pre-existing pinned-favourite row to the new id so
    // the user keeps their pin without having to re-star the report.
    //
    // Idempotent: running on a fresh DB or after the rename has
    // already happened is a no-op (no rows match the WHERE clause).
    // The (user_id, report_id) UNIQUE index protects against double
    // entries if a user had pinned the report under both ids during
    // an in-flight upgrade — ON CONFLICT DO NOTHING keeps the older
    // pin (oldest pinned_at wins, matches store ordering semantics).
    await sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_name = 'user_report_favorites'
        ) THEN
          -- Drop any duplicates first so the rename can't violate
          -- the (user_id, report_id) UNIQUE index. Keep the OLDER
          -- pinned_at row in each duplicate pair.
          DELETE FROM user_report_favorites a
            USING user_report_favorites b
            WHERE a.user_id = b.user_id
              AND a.report_id = 'movers'
              AND b.report_id = 'fast_slow_stock'
              AND a.pinned_at >= b.pinned_at;
          UPDATE user_report_favorites
             SET report_id = 'fast_slow_stock'
           WHERE report_id = 'movers';
        END IF;
      END
      $$;
    `).catch((err) => {
      console.error('[Favourites rename movers→fast_slow_stock]', err.message);
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

      -- ── LAN-deployment hot-path indexes ─────────────────────────────
      -- These cover the queries that fan out the most when 10–20 clients
      -- hit the dashboard / aging / outstanding pages simultaneously:
      --
      --   sales_bills    (customer_id, bill_date)         -- party statements + aging
      --   sales_bills    (is_cancelled, bill_date)        -- monthly + today aggregates
      --   sales_bills    (is_cancelled, balance_amount)   -- receivables roll-up (partial)
      --   purchase_bills (supplier_id, bill_date)         -- supplier statements + aging
      --   purchase_bills (is_cancelled, bill_date)        -- monthly + today aggregates
      --   purchase_bills (is_cancelled, balance_amount)   -- payables roll-up (partial)
      --   payments_receipts (transaction_type, is_cancelled, transaction_date)
      --
      -- Partial indexes are only built where they help — Postgres won't
      -- bother scanning a 5M-row history of cancelled bills when the
      -- dashboard only ever wants is_cancelled = false.
      CREATE INDEX IF NOT EXISTS idx_sales_bills_customer_date
        ON sales_bills (customer_id, bill_date);
      CREATE INDEX IF NOT EXISTS idx_purchase_bills_supplier_date
        ON purchase_bills (supplier_id, bill_date);
      CREATE INDEX IF NOT EXISTS idx_sales_bills_active_date
        ON sales_bills (bill_date) WHERE is_cancelled = false;
      CREATE INDEX IF NOT EXISTS idx_purchase_bills_active_date
        ON purchase_bills (bill_date) WHERE is_cancelled = false;
      CREATE INDEX IF NOT EXISTS idx_sales_bills_active_balance
        ON sales_bills (customer_id) WHERE is_cancelled = false AND balance_amount > 0;
      CREATE INDEX IF NOT EXISTS idx_purchase_bills_active_balance
        ON purchase_bills (supplier_id) WHERE is_cancelled = false AND balance_amount > 0;
      CREATE INDEX IF NOT EXISTS idx_payments_receipts_type_date
        ON payments_receipts (transaction_type, transaction_date) WHERE is_cancelled = false;
    `).catch((err) => {
      console.error('[Batch tracking migration] Error:', err.message);
    });

    // ── Single Product mode schema (Phase 1) ─────────────────────────
    //
    // Adds:
    //   • products.product_mode ENUM('variant','single') NOT NULL DEFAULT 'variant'
    //     Existing rows inherit 'variant' via the DEFAULT — preserves
    //     existing behaviour bit-exactly. New rows pick up whatever
    //     system_settings.default_product_mode is at create time
    //     (controllers wire this in Commit 2; nothing changes for
    //     existing flows in Commit 1).
    //   • products.weighted_avg_cost / last_purchase_rate /
    //     last_purchase_date — single-mode cost basis fields.
    //     NULL for variant rows; populated by single-mode purchases.
    //   • product_batches.purchase_rate — per-batch landed cost,
    //     used as the cost_rate snapshot source for single+batch
    //     products. NULL for batches created before Commit 2.
    //   • system_settings.default_product_mode — global default
    //     applied to NEW products only.
    //
    // All idempotent (IF NOT EXISTS gates). ENUM types use the
    // Sequelize convention `enum_<table>_<column>`.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='products' AND column_name='product_mode') THEN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_products_product_mode') THEN
            CREATE TYPE enum_products_product_mode AS ENUM ('variant', 'single');
          END IF;
          ALTER TABLE products ADD COLUMN product_mode enum_products_product_mode NOT NULL DEFAULT 'variant';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='products' AND column_name='weighted_avg_cost') THEN
          ALTER TABLE products ADD COLUMN weighted_avg_cost DECIMAL(14,4);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='products' AND column_name='last_purchase_rate') THEN
          ALTER TABLE products ADD COLUMN last_purchase_rate DECIMAL(14,4);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='products' AND column_name='last_purchase_date') THEN
          ALTER TABLE products ADD COLUMN last_purchase_date DATE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='product_batches' AND column_name='purchase_rate') THEN
          ALTER TABLE product_batches ADD COLUMN purchase_rate DECIMAL(14,4);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='system_settings' AND column_name='default_product_mode') THEN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_system_settings_default_product_mode') THEN
            CREATE TYPE enum_system_settings_default_product_mode AS ENUM ('variant', 'single');
          END IF;
          ALTER TABLE system_settings ADD COLUMN default_product_mode enum_system_settings_default_product_mode NOT NULL DEFAULT 'variant';
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_products_product_mode
        ON products (product_mode);
    `).catch((err) => {
      console.error('[Single mode migration] Error:', err.message);
    });

    // Audit-driven cleanup (Phase 6 of the design): clear is_batch_tracked
    // on any variant-mode product that wrongly carried it. The flag was
    // settable on variants pre-design but caused silent batch-info loss
    // on save (lookupProduct could resolve to a non-batched sibling).
    // Run AFTER the column addition above so product_mode exists.
    // Idempotent — re-runs find zero affected rows.
    try {
      const [rows] = await sequelize.query(
        `UPDATE products
            SET is_batch_tracked = false
          WHERE product_mode = 'variant' AND is_batch_tracked = true
          RETURNING product_id, product_name`,
      );
      if (rows && rows.length > 0) {
        console.log(`[Single mode migration] cleared is_batch_tracked on ${rows.length} variant product(s):`);
        for (const r of rows) {
          console.log(`  - id=${r.product_id} name="${r.product_name}"`);
        }
      }
    } catch (err) {
      console.error('[Single mode migration] cleanup error:', err.message);
    }

    // ── Multi-Color stock module migration ──────────────────────
    //
    // Adds the schema needed by the per-color stock feature. Idempotent
    // (IF NOT EXISTS guards everywhere), so a re-run is a no-op.
    //
    //   • product_colors table — one row per (product, color) pair,
    //     with current_stock + opening_stock + per-color low-stock
    //     threshold + soft-delete flag.
    //   • UNIQUE(product_id, color_name) — prevents accidental dupes
    //     ('Red' added twice to Lyra-S).
    //   • color_id FK on sales_bill_items + purchase_bill_items —
    //     NULL when the line's product isn't multi-color tracked.
    //   • color_mode + color_label columns on products — the
    //     mutually-exclusive mode picker ('none' / 'single' / 'multi')
    //     and the free-text label for single-color products.
    //   • single_color_enabled / multi_color_enabled / merge_repeat_
    //     scans_enabled toggles on system_settings — defaults OFF so
    //     existing installs see no UI change until admin opts in.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'product_colors'
        ) THEN
          CREATE TABLE product_colors (
            color_id        SERIAL PRIMARY KEY,
            product_id      INTEGER NOT NULL REFERENCES products(product_id),
            color_name      VARCHAR(50) NOT NULL,
            current_stock   DECIMAL(10,2) DEFAULT 0,
            opening_stock   DECIMAL(10,2) DEFAULT 0,
            low_stock_alert DECIMAL(10,2),
            is_active       BOOLEAN DEFAULT true,
            created_date    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            modified_date   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            CONSTRAINT product_colors_unique_per_product
              UNIQUE (product_id, color_name)
          );
          CREATE INDEX idx_product_colors_product ON product_colors(product_id);
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Multi-color schema migration] Error:', err.message);
    });

    // color_id columns on bill-item tables — NULLable so existing rows
    // continue to validate. References product_colors(color_id) so
    // RESTRICT-on-delete keeps history intact (mirrors the pattern on
    // batch_id and ledger_id elsewhere).
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'sales_bill_items' AND column_name = 'color_id'
        ) THEN
          ALTER TABLE sales_bill_items
            ADD COLUMN color_id INTEGER REFERENCES product_colors(color_id);
          CREATE INDEX idx_sales_bill_items_color ON sales_bill_items(color_id);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'purchase_bill_items' AND column_name = 'color_id'
        ) THEN
          ALTER TABLE purchase_bill_items
            ADD COLUMN color_id INTEGER REFERENCES product_colors(color_id);
          CREATE INDEX idx_purchase_bill_items_color ON purchase_bill_items(color_id);
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Multi-color color_id migration] Error:', err.message);
    });

    // products.color_mode + products.color_label
    //
    // Both the column and the underlying enum type need IF NOT EXISTS
    // guards: Sequelize sync may have created the type already from
    // the model definition (without the ALTER TABLE the model expects),
    // so we check both layers independently and skip whichever exists.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'enum_products_color_mode'
        ) THEN
          CREATE TYPE enum_products_color_mode AS ENUM ('none','single','multi');
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'products' AND column_name = 'color_mode'
        ) THEN
          ALTER TABLE products
            ADD COLUMN color_mode enum_products_color_mode NOT NULL DEFAULT 'none';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'products' AND column_name = 'color_label'
        ) THEN
          ALTER TABLE products ADD COLUMN color_label VARCHAR(50);
          CREATE INDEX idx_products_color_label ON products(color_label) WHERE color_label IS NOT NULL;
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Multi-color products migration] Error:', err.message);
    });

    // system_settings: 3 new boolean toggles, defaulting to FALSE so
    // existing installs surface no new UI until admin flicks them on.
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'system_settings' AND column_name = 'single_color_enabled'
        ) THEN
          ALTER TABLE system_settings
            ADD COLUMN single_color_enabled BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'system_settings' AND column_name = 'multi_color_enabled'
        ) THEN
          ALTER TABLE system_settings
            ADD COLUMN multi_color_enabled BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'system_settings' AND column_name = 'merge_repeat_scans_enabled'
        ) THEN
          ALTER TABLE system_settings
            ADD COLUMN merge_repeat_scans_enabled BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `).catch((err) => {
      console.error('[Multi-color settings migration] Error:', err.message);
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

    // ── Cheque module: add sync columns + backfill from existing
    //    cheque-mode payment splits. Idempotent — both blocks no-op
    //    on a fully migrated DB.
    //
    //    Why this lives here: sequelize.sync({alter:false}) creates
    //    new tables but never adds columns to existing ones. The
    //    cheques table was created on the first boot after the
    //    Cheque model shipped; any new column the model declares
    //    (here, source_payment_id and source_payment_split_id) needs
    //    a manual ALTER. The backfill then converts every existing
    //    cheque-mode payment_split row into a Cheque register entry
    //    so the operator's previously-recorded cheques surface in
    //    the new register without re-keying.
    try {
      await sequelize.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cheques') THEN
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'cheques' AND column_name = 'source_payment_id'
            ) THEN
              ALTER TABLE cheques ADD COLUMN source_payment_id INTEGER
                REFERENCES payments_receipts(transaction_id);
            END IF;
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'cheques' AND column_name = 'source_payment_split_id'
            ) THEN
              ALTER TABLE cheques ADD COLUMN source_payment_split_id INTEGER
                REFERENCES payment_splits(split_id);
            END IF;
            CREATE UNIQUE INDEX IF NOT EXISTS cheques_source_split_uniq
              ON cheques(source_payment_split_id)
              WHERE source_payment_split_id IS NOT NULL;
          END IF;
        END $$;
      `);

      // Backfill: for every cheque-mode payment_split that has a
      // cheque number AND isn't already linked to a cheques row,
      // synthesise a Cheque register entry. We DO NOT post a cheque
      // voucher for these — the originating payment voucher already
      // moved the money. Status maps from PaymentReceipt.cleared_at:
      //   INWARD  cleared_at IS NULL → DEPOSITED  (in transit)
      //   INWARD  cleared_at NOT NULL → CLEARED
      //   OUTWARD cleared_at IS NULL → PENDING    (issued, awaiting presentation)
      //   OUTWARD cleared_at NOT NULL → CLEARED
      // Bounced / cancelled receipts (pr.is_cancelled) get CANCELLED.
      const [backfilled] = await sequelize.query(`
        INSERT INTO cheques (
          direction, cheque_number, cheque_date, amount,
          party_id, bank_ledger_id, status, is_pdc,
          instrument_date, deposit_date, clearance_date,
          source_payment_id, source_payment_split_id,
          created_by, created_at, updated_at
        )
        SELECT
          (CASE pr.transaction_type WHEN 'Receipt' THEN 'INWARD' ELSE 'OUTWARD' END)::"enum_cheques_direction",
          ps.cheque_number,
          COALESCE(ps.cheque_date, pr.transaction_date),
          ps.amount,
          pr.party_id,
          ps.bank_ledger_id,
          (CASE
            WHEN pr.is_cancelled THEN 'CANCELLED'
            WHEN pr.cleared_at IS NOT NULL THEN 'CLEARED'
            WHEN pr.transaction_type = 'Receipt' THEN 'DEPOSITED'
            ELSE 'PENDING'
          END)::"enum_cheques_status",
          (COALESCE(ps.cheque_date, pr.transaction_date) > pr.transaction_date),
          pr.transaction_date,
          CASE WHEN pr.transaction_type = 'Receipt' THEN pr.transaction_date ELSE NULL END,
          pr.cleared_at::date,
          pr.transaction_id,
          ps.split_id,
          pr.created_by,
          NOW(), NOW()
        FROM payment_splits ps
        JOIN payments_receipts pr ON pr.transaction_id = ps.transaction_id
        WHERE ps.payment_mode = 'Cheque'
          AND ps.cheque_number IS NOT NULL
          AND ps.cheque_number <> ''
          AND pr.party_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM cheques c WHERE c.source_payment_split_id = ps.split_id
          )
        RETURNING cheque_id
      `);
      const inserted = (backfilled && backfilled.length) || 0;
      if (inserted > 0) {
        console.log(`[Cheque sync] backfilled ${inserted} cheque(s) from existing cheque-mode payments`);
      }
    } catch (err) {
      console.error('[Cheque sync migration] Error:', err.message);
    }

    const httpServer = app.listen(PORT, '0.0.0.0', () => {
      const lan = getLanAddresses();
      console.log('');
      console.log('┌───────────────────────────────────────────────────────────┐');
      console.log('│  Billing ERP server is running                            │');
      console.log('├───────────────────────────────────────────────────────────┤');
      console.log(`│  Local:    http://localhost:${PORT}`.padEnd(60) + '│');
      if (lan.length === 0) {
        console.log(`│  LAN:      (no LAN interface detected)`.padEnd(60) + '│');
      } else {
        for (const a of lan) {
          console.log(`│  LAN:      http://${a.address}:${PORT}   (${a.iface})`.padEnd(60) + '│');
        }
      }
      console.log(`│  API:      /api/*`.padEnd(60) + '│');
      console.log(`│  Web UI:   ${distExists ? 'served from /dist (browser clients OK)' : 'not built — run "npm run build"'}`.padEnd(60) + '│');
      console.log(`│  Health:   /api/health`.padEnd(60) + '│');
      console.log('└───────────────────────────────────────────────────────────┘');
      console.log('');

      // Tune the underlying TCP socket for many concurrent LAN clients:
      //   - keepAlive prevents idle Electron sessions from being silently
      //     dropped by Wi-Fi access points after ~5 min of inactivity.
      //   - keepAliveTimeout / headersTimeout headroom prevents the kernel
      //     from killing legitimate long-poll requests.
      httpServer.keepAliveTimeout = 65_000;   // > typical proxy idle timeout
      httpServer.headersTimeout = 70_000;     // must be > keepAliveTimeout
      httpServer.requestTimeout = 0;          // no hard cap — backups + imports run long

      // Start auto-backup scheduler
      require('./controllers/backupController').initScheduler();
      // Import job worker — recover orphans first, then start polling.
      const importWorker = require('./services/importJobWorker');
      importWorker.recoverOrphans()
        .then(() => importWorker.start())
        .catch((e) => console.error('[importJobWorker] failed to start:', e.message));
    });

    // Graceful shutdown — drain in-flight requests on SIGTERM/SIGINT so
    // an Electron quit or a `taskkill` doesn't leave half-written
    // payments-receipts in the DB. 5-second hard cap.
    const shutdown = (signal) => {
      console.log(`\n${signal} received — draining requests…`);
      const force = setTimeout(() => {
        console.warn('Drain timed out, forcing exit');
        process.exit(1);
      }, 5000);
      httpServer.close(() => {
        clearTimeout(force);
        sequelize.close().finally(() => process.exit(0));
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error.message);
    console.error('Make sure PostgreSQL is running and the database exists.');
    console.error('Create database: CREATE DATABASE billing_erp;');
    process.exit(1);
  }
}

startServer();
