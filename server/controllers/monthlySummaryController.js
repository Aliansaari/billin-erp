// ── Monthly Register Controller (R10 v2 — Tally-faithful) ────────────
//
//   GET /api/reports/monthly-register?mode=<m>&overlay=<m>?
//
//   m ∈ { 'sales' | 'purchase' | 'payment' | 'receipt' }
//
// One controller, four modes + optional overlay. The frontend renders
// a single Tally-style table:
//
//   Particulars | Transactions (Debit | Credit) | Closing Balance
//   ─────────────────────────────────────────────────────────────
//   April       |              |    5,20,010.50  | 5,20,010.50 Cr
//   May         |              |    5,82,691.00  | 11,02,701.50 Cr
//   ...
//
// Sales / Purchase modes read from the `Sales Account` / `Purchase
// Account` ledger directly — sum of debit/credit per month. Payment /
// Receipt modes read from `payments_receipts`, summing total_amount
// per month: payments treated as Dr-natural, receipts as Cr-natural,
// matching Tally's voucher-register view.
//
// Opening balance: the running net of the ledger BEFORE from_date
// (or for vouchers, the cumulative amount before from_date). Required
// so the running closing balance starts at the right number for any
// from_date (not just FY-start).
//
// Overlay mode: a second register laid alongside the primary.
// Frontend renders side-by-side columns. Common pairings:
//   Sales ↔ Purchase   (revenue vs cost flow)
//   Receipt ↔ Payment  (cash in vs cash out)
// Any other pairing also works (the controller doesn't care).

const sequelize = require('../config/database');
const { SystemSettings } = require('../models');
const { roundTo } = require('../utils/helpers');

// Audit MONEY-4 — use canonical roundTo (Tally-compatible).
const r2 = (v) => roundTo(Number(v) || 0, 2);

const VALID_MODES = ['sales', 'purchase', 'payment', 'receipt'];

// Per-mode definition. `naturalSide` drives the closing-balance suffix
// (Dr or Cr) and the opening interpretation. `subGroup` matches ledger
// accounts by their `sub_group` column — the same classification the
// rest of the reporting codebase uses (financialReportsController's
// SALES_ACCOUNTS_SUB / PURCHASE_ACCOUNTS_SUB). The previous version
// matched by exact ledger_name='Sales Account', so a renamed primary
// ledger or a second sales ledger ("Sales – Wholesale") was silently
// excluded from the register. Audit H15.
//
// Voucher-backed modes (payment, receipt) use the _voucherRows query
// path instead.
const MODE = {
  sales: {
    label:        'Sales Register',
    subGroup:     'Sales Accounts',
    naturalSide:  'Cr',          // SUM(cr) - SUM(dr), positive = Cr
    rowsFn:       _ledgerRows,
  },
  purchase: {
    label:        'Purchase Register',
    subGroup:     'Purchase Accounts',
    naturalSide:  'Dr',          // SUM(dr) - SUM(cr), positive = Dr
    rowsFn:       _ledgerRows,
  },
  payment: {
    label:        'Payment Register',
    subGroup:     null,           // aggregates payments_receipts
    naturalSide:  'Dr',
    rowsFn:       _voucherRows,
    voucherType:  'Payment',
  },
  receipt: {
    label:        'Receipt Register',
    subGroup:     null,
    naturalSide:  'Cr',
    rowsFn:       _voucherRows,
    voucherType:  'Receipt',
  },
};

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Default period = current FY (Apr 1 → Mar 31). Tally always shows the
// register for a full FY by default.
async function defaultPeriod() {
  const s = await SystemSettings.findOne({ where: { setting_id: 1 } });
  if (s && s.financial_year_start) {
    const fyStart = String(s.financial_year_start).slice(0, 10);
    const startYear = parseInt(fyStart.slice(0, 4), 10);
    const fyEnd = `${startYear + 1}-03-31`;
    return { from_date: fyStart, to_date: fyEnd };
  }
  // Fallback when no FY configured.
  const today = new Date();
  const yearStart = new Date(today.getFullYear(), 3, 1);  // Apr 1
  const yearEnd   = new Date(today.getFullYear() + 1, 2, 31); // Mar 31
  return { from_date: localDateString(yearStart), to_date: localDateString(yearEnd) };
}

function fyLabel(from, to) {
  const f = new Date(from), t = new Date(to);
  const fmt = (d) => {
    const day = String(d.getDate()).padStart(2, '0');
    const mon = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']; // not used directly
    const monNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${day}-${monNames[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`;
  };
  return `${fmt(f)} to ${fmt(t)}`;
}

// ── _ledgerRows ──────────────────────────────────────────────────────
//
// For Sales/Purchase modes. Pulls live ledger_entries for the named
// ledger, aggregated per month. Computes opening balance from entries
// strictly before from_date.
//
// Returns: { opening_balance, opening_side, rows, totals }
//
// `closing` per row is signed in the natural side's direction. The
// frontend formats as "X.XX Cr" or "X.XX Dr" by combining `closing`
// (signed magnitude) with `closing_side`.
async function _ledgerRows({ subGroup, naturalSide, from, to }) {
  // Opening: net (Dr - Cr) of all entries strictly before `from` for
  // every ledger in this sub_group. For a Cr-natural account, store
  // as positive Cr.
  //
  // We filter `ledger_name NOT ILIKE '%return%'` so the Sales Register
  // continues to show only forward sales (Tally convention) — the seed
  // puts the system "Sales Return" ledger under sub_group='Sales Accounts'
  // which would otherwise drag credit-note movements into the register.
  // The name-based exclusion is safe because the system seeders use
  // 'Sales Return' / 'Purchase Return' canonical names; user-created
  // forward ledgers ("Sales – Wholesale", "Sales – GST 12%") still fall
  // through and are now included (audit H15).
  const [openingRow] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount),  0)::float AS dr,
            COALESCE(SUM(le.credit_amount), 0)::float AS cr
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
      WHERE la.sub_group = :subGroup
        AND la.ledger_name NOT ILIKE '%return%'
        AND le.entry_date < :from
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)`,
    { replacements: { subGroup, from }, type: sequelize.QueryTypes.SELECT },
  );
  const openingNet = naturalSide === 'Cr'
    ? r2(openingRow.cr - openingRow.dr)
    : r2(openingRow.dr - openingRow.cr);

  // Per-month rows. month_series LEFT JOIN ledger_entries — empty
  // months still appear (Tally-style continuous register).
  const rows = await sequelize.query(
    `WITH month_series AS (
       SELECT generate_series(
         DATE_TRUNC('month', :from::date),
         DATE_TRUNC('month', :to::date),
         INTERVAL '1 month'
       )::date AS month_start
     ),
     monthly AS (
       SELECT DATE_TRUNC('month', le.entry_date)::date AS m,
              COALESCE(SUM(le.debit_amount), 0)::float  AS dr,
              COALESCE(SUM(le.credit_amount), 0)::float AS cr
         FROM ledger_entries le
         JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
        WHERE la.sub_group = :subGroup
          AND la.ledger_name NOT ILIKE '%return%'
          AND le.entry_date >= :from AND le.entry_date <= :to
          AND le.reversal_of_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
        GROUP BY DATE_TRUNC('month', le.entry_date)
     )
     SELECT TO_CHAR(ms.month_start, 'YYYY-MM-DD')        AS month_iso,
            TO_CHAR(ms.month_start, 'Mon YYYY')          AS month_label,
            TO_CHAR(ms.month_start, 'FMMonth')           AS month_name,
            COALESCE(m.dr, 0)::float                     AS dr,
            COALESCE(m.cr, 0)::float                     AS cr
       FROM month_series ms
       LEFT JOIN monthly m ON m.m = ms.month_start
      ORDER BY ms.month_start ASC`,
    { replacements: { subGroup, from, to }, type: sequelize.QueryTypes.SELECT },
  );

  let runningClosing = openingNet;
  let totalDr = 0, totalCr = 0;
  const out = rows.map((r) => {
    const dr = r2(r.dr), cr = r2(r.cr);
    const monthNet = naturalSide === 'Cr' ? cr - dr : dr - cr;
    runningClosing = r2(runningClosing + monthNet);
    totalDr = r2(totalDr + dr);
    totalCr = r2(totalCr + cr);
    return {
      month_iso:    r.month_iso,
      month_label:  r.month_label,
      month_name:   r.month_name,
      dr,
      cr,
      closing:      Math.abs(runningClosing),
      closing_side: runningClosing >= 0 ? naturalSide : (naturalSide === 'Cr' ? 'Dr' : 'Cr'),
    };
  });
  return {
    opening_balance: Math.abs(openingNet),
    opening_side:    openingNet >= 0 ? naturalSide : (naturalSide === 'Cr' ? 'Dr' : 'Cr'),
    rows:            out,
    totals:          { dr: totalDr, cr: totalCr },
  };
}

// ── _billTotalRows ───────────────────────────────────────────────────
//
// "With Tax" view for Sales / Purchase. Uses the bill's total_amount
// (sub_total − discount + freight + other + GST) instead of the
// ledger-net values. Sales bills go in the credit column (still
// Cr-natural), sales returns in the debit column. Mirror for
// purchase. Cancelled bills excluded.
//
// The closing balance under this view represents the cumulative
// invoice volume — a useful "money invoiced over time" view that
// complements the ledger view's "amount that hit the books".
async function _billTotalRows({ side, naturalSide, from, to }) {
  const isSales = side === 'sales';
  const billTable    = isSales ? 'sales_bills'        : 'purchase_bills';
  const returnTable  = isSales ? 'sales_return_bills' : 'purchase_return_bills';
  const billDateCol  = 'bill_date';
  const returnDateCol = 'return_date';

  // Opening balance: sum of bills minus returns before `from`. For
  // sales (Cr-natural): bills credit, returns debit, opening = bills − returns.
  // For purchase (Dr-natural): bills debit, returns credit, opening = bills − returns.
  const [openingBills] = await sequelize.query(
    `SELECT COALESCE(SUM(total_amount), 0)::float v
       FROM ${billTable}
      WHERE is_cancelled = false AND ${billDateCol} < :from`,
    { replacements: { from }, type: sequelize.QueryTypes.SELECT },
  );
  const [openingReturns] = await sequelize.query(
    `SELECT COALESCE(SUM(total_amount), 0)::float v
       FROM ${returnTable}
      WHERE is_cancelled = false AND ${returnDateCol} < :from`,
    { replacements: { from }, type: sequelize.QueryTypes.SELECT },
  );
  const openingNet = r2(openingBills.v - openingReturns.v);

  const rows = await sequelize.query(
    `WITH month_series AS (
       SELECT generate_series(
         DATE_TRUNC('month', :from::date),
         DATE_TRUNC('month', :to::date),
         INTERVAL '1 month'
       )::date AS month_start
     ),
     bills AS (
       SELECT DATE_TRUNC('month', ${billDateCol})::date AS m,
              COALESCE(SUM(total_amount), 0)::float    AS amount
         FROM ${billTable}
        WHERE is_cancelled = false
          AND ${billDateCol} >= :from AND ${billDateCol} <= :to
        GROUP BY DATE_TRUNC('month', ${billDateCol})
     ),
     rets AS (
       SELECT DATE_TRUNC('month', ${returnDateCol})::date AS m,
              COALESCE(SUM(total_amount), 0)::float       AS amount
         FROM ${returnTable}
        WHERE is_cancelled = false
          AND ${returnDateCol} >= :from AND ${returnDateCol} <= :to
        GROUP BY DATE_TRUNC('month', ${returnDateCol})
     )
     SELECT TO_CHAR(ms.month_start, 'YYYY-MM-DD')   AS month_iso,
            TO_CHAR(ms.month_start, 'Mon YYYY')     AS month_label,
            TO_CHAR(ms.month_start, 'FMMonth')      AS month_name,
            COALESCE(b.amount, 0)::float            AS bill_amount,
            COALESCE(r.amount, 0)::float            AS return_amount
       FROM month_series ms
       LEFT JOIN bills b ON b.m = ms.month_start
       LEFT JOIN rets  r ON r.m = ms.month_start
      ORDER BY ms.month_start ASC`,
    { replacements: { from, to }, type: sequelize.QueryTypes.SELECT },
  );

  let runningClosing = openingNet;
  let totalDr = 0, totalCr = 0;
  const out = rows.map((r) => {
    const billAmt = r2(r.bill_amount);
    const retAmt  = r2(r.return_amount);
    // Sales: bills → Cr, returns → Dr. Purchase: bills → Dr, returns → Cr.
    const dr = naturalSide === 'Cr' ? retAmt  : billAmt;
    const cr = naturalSide === 'Cr' ? billAmt : retAmt;
    const monthNet = naturalSide === 'Cr' ? cr - dr : dr - cr;
    runningClosing = r2(runningClosing + monthNet);
    totalDr = r2(totalDr + dr);
    totalCr = r2(totalCr + cr);
    return {
      month_iso:    r.month_iso,
      month_label:  r.month_label,
      month_name:   r.month_name,
      dr, cr,
      closing:      Math.abs(runningClosing),
      closing_side: runningClosing >= 0 ? naturalSide : (naturalSide === 'Cr' ? 'Dr' : 'Cr'),
    };
  });
  return {
    opening_balance: Math.abs(openingNet),
    opening_side:    openingNet >= 0 ? naturalSide : (naturalSide === 'Cr' ? 'Dr' : 'Cr'),
    rows:            out,
    totals:          { dr: totalDr, cr: totalCr },
  };
}

// ── _voucherRows ─────────────────────────────────────────────────────
//
// For Payment / Receipt modes. Aggregates payments_receipts.total_amount
// by month, treating the voucher type as a Dr-natural (Payment) or
// Cr-natural (Receipt) "register" for the closing-balance display.
//
// Cancelled vouchers are excluded — they shouldn't appear in any
// register view.
async function _voucherRows({ voucherType, naturalSide, from, to }) {
  const [openingRow] = await sequelize.query(
    `SELECT COALESCE(SUM(total_amount), 0)::float AS amount
       FROM payments_receipts
      WHERE transaction_type = :tt
        AND is_cancelled = false
        AND transaction_date < :from`,
    { replacements: { tt: voucherType, from }, type: sequelize.QueryTypes.SELECT },
  );
  const openingNet = r2(openingRow.amount);

  const rows = await sequelize.query(
    `WITH month_series AS (
       SELECT generate_series(
         DATE_TRUNC('month', :from::date),
         DATE_TRUNC('month', :to::date),
         INTERVAL '1 month'
       )::date AS month_start
     ),
     monthly AS (
       SELECT DATE_TRUNC('month', transaction_date)::date AS m,
              COALESCE(SUM(total_amount), 0)::float       AS amount
         FROM payments_receipts
        WHERE transaction_type = :tt
          AND is_cancelled = false
          AND transaction_date >= :from AND transaction_date <= :to
        GROUP BY DATE_TRUNC('month', transaction_date)
     )
     SELECT TO_CHAR(ms.month_start, 'YYYY-MM-DD')   AS month_iso,
            TO_CHAR(ms.month_start, 'Mon YYYY')     AS month_label,
            TO_CHAR(ms.month_start, 'FMMonth')      AS month_name,
            COALESCE(m.amount, 0)::float            AS amount
       FROM month_series ms
       LEFT JOIN monthly m ON m.m = ms.month_start
      ORDER BY ms.month_start ASC`,
    { replacements: { tt: voucherType, from, to }, type: sequelize.QueryTypes.SELECT },
  );

  let running = openingNet;
  let totalDr = 0, totalCr = 0;
  const out = rows.map((r) => {
    const amt = r2(r.amount);
    running = r2(running + amt);
    // Payment → Dr column, Receipt → Cr column. The other column is
    // always 0 for voucher-backed registers (vouchers are single-amount).
    const dr = naturalSide === 'Dr' ? amt : 0;
    const cr = naturalSide === 'Cr' ? amt : 0;
    totalDr = r2(totalDr + dr);
    totalCr = r2(totalCr + cr);
    return {
      month_iso:    r.month_iso,
      month_label:  r.month_label,
      month_name:   r.month_name,
      dr, cr,
      closing:      running,
      closing_side: naturalSide,
    };
  });
  return {
    opening_balance: openingNet,
    opening_side:    naturalSide,
    rows:            out,
    totals:          { dr: totalDr, cr: totalCr },
  };
}

// ── _buildSection ────────────────────────────────────────────────────
//
// `withTax` only affects ledger-backed modes (sales, purchase). For
// payment / receipt the voucher total IS the with-tax figure already,
// so the toggle is a no-op there.
async function _buildSection(modeKey, from, to, withTax) {
  const cfg = MODE[modeKey];
  if (!cfg) throw new Error(`Unknown mode: ${modeKey}`);
  const useBillTotals = withTax && (modeKey === 'sales' || modeKey === 'purchase');
  const data = useBillTotals
    ? await _billTotalRows({ side: modeKey, naturalSide: cfg.naturalSide, from, to })
    : await cfg.rowsFn({
        subGroup:     cfg.subGroup,
        voucherType:  cfg.voucherType,
        naturalSide:  cfg.naturalSide,
        from, to,
      });
  return {
    label:           cfg.label,
    // The register may aggregate multiple ledgers under one sub_group
    // now (audit H15) — show the sub_group as the friendly label.
    ledger_name:     cfg.subGroup || cfg.label.replace(' Register', '') + 's',
    natural_side:    cfg.naturalSide,
    with_tax:        !!useBillTotals,
    opening_balance: data.opening_balance,
    opening_side:    data.opening_side,
    rows:            data.rows,
    totals:          data.totals,
  };
}

// ── HTTP handler ─────────────────────────────────────────────────────
exports.monthlySummary = async (req, res) => {
  try {
    const q = req.query || {};
    const mode    = VALID_MODES.includes(q.mode)    ? q.mode    : 'sales';
    const overlay = VALID_MODES.includes(q.overlay) ? q.overlay : null;

    const defaults = await defaultPeriod();
    const from_date = (q.from_date && /^\d{4}-\d{2}-\d{2}$/.test(q.from_date)) ? q.from_date : defaults.from_date;
    const to_date   = (q.to_date   && /^\d{4}-\d{2}-\d{2}$/.test(q.to_date))   ? q.to_date   : defaults.to_date;

    const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
    const companyName = (settings && settings.company_name) || 'Company';

    const withTax = q.with_tax === 'true' || q.with_tax === '1';
    const primary = await _buildSection(mode, from_date, to_date, withTax);
    const overlaySection = overlay ? await _buildSection(overlay, from_date, to_date, withTax) : null;

    res.json({
      period: {
        from_date,
        to_date,
        fy_label: fyLabel(from_date, to_date),
      },
      company_name: companyName,
      primary,
      overlay: overlaySection,
    });
  } catch (err) {
    console.error('monthlyRegister error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
