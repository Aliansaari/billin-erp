// ── Financial Reports Controller ───────────────────────────────────────
//
// Trial Balance + Balance Sheet (Phase R1). Both read from ledger_entries
// — single source of truth. Reversal pairs are excluded so the figures
// reflect the *current* state of the books, not the audit-trail volume.
//
// Convention:
//   • A ledger account's "balance" = Σ debit_amount − Σ credit_amount
//     across all live (non-reversed) entries up to as_of_date.
//   • Positive = Dr balance (typical for Assets, Expenses).
//   • Negative = Cr balance (typical for Liabilities, Income, Capital).
//   • Sub-group is the finer category set by the seeder (e.g.
//     "Sundry Debtors", "Bank Accounts", "Cash-in-Hand").
//
// Period filter:
//   • from_date / to_date come from req.query.
//   • Trial Balance honours both bounds (the closing balance for a
//     date *range*).
//   • Balance Sheet uses to_date only (the as-of date).
//   • If neither is supplied, defaults to the system FY (start → today).

const sequelize = require('../config/database');
const { Op } = require('sequelize');
const { SystemSettings, Product, Party, SalesBill, PurchaseBill } = require('../models');

const ASSET_GROUP     = 'Assets';
const LIABILITY_GROUP = 'Liabilities';
const INCOME_GROUP    = 'Income';
const EXPENSE_GROUP   = 'Expenses';
const CAPITAL_GROUP   = 'Capital';

// Convert numbers safely. DECIMAL columns come back as strings — naïve
// `value || fallback` doesn't work because "0.00" is truthy.
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }

// Resolve the period bounds. Returns ISO YYYY-MM-DD strings.
async function resolvePeriod(query) {
  let from = (query && query.from_date) ? String(query.from_date).slice(0, 10) : null;
  let to   = (query && query.to_date)   ? String(query.to_date).slice(0, 10)   : null;
  if (!from || !to) {
    const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
    if (!from) from = settings && settings.financial_year_start
      ? String(settings.financial_year_start).slice(0, 10) : '1900-01-01';
    if (!to)   to   = new Date().toISOString().slice(0, 10);
  }
  return { from, to };
}

// Common SQL filter for live (non-reversed) entries. Returns the
// fragment to splice into a WHERE clause + the replacements.
//
// "Live" = forward entries that haven't been paired with a reversal mirror.
//   reversal_of_id IS NULL          (the row itself is forward)
//   AND entry_id NOT IN (...)       (no other row mirrors it)
//
// Sub-query uses NOT EXISTS for clarity (tiny tables; planner handles it).
function liveEntriesWhereSql(toAlias = 'le', toDateLte = null, fromDateGte = null) {
  let where = `${toAlias}.reversal_of_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM ledger_entries m
       WHERE m.reversal_of_id = ${toAlias}.entry_id
    )`;
  if (fromDateGte) where += ` AND ${toAlias}.entry_date >= :from_date`;
  if (toDateLte)   where += ` AND ${toAlias}.entry_date <= :to_date`;
  return where;
}

// ── Trial Balance ──────────────────────────────────────────────────────
//
// One row per ledger_account with **closing balance as of to_date** —
// standard accounting convention. The from_date is captured for the
// "Period" display label but does NOT filter the running totals;
// opening JVs dated before from_date still need to flow through.
//
// For an "activity during period" view we'd return separate
// opening/activity/closing columns; that's a follow-up if needed.
//
// Reconciliation: a Trial Balance's per-column totals are NOT expected
// to equal the raw sum of every Dr/Cr leg — TB nets opposing entries
// within an account, so a customer with both sales and receipts
// contributes a single Dr (or Cr) in their column rather than two
// separate legs. The invariant we DO assert as a filter-drift check is:
//   Σ(legs with entry_date ≤ to_date)  +  Σ(legs with entry_date > to_date)
//     = Σ(all live legs)
// If that fails, the WHERE clause is dropping entries it shouldn't and
// the banner surfaces the bug. This is what catches a regression like
// "someone added a from_date filter and silently excluded opening JVs".
exports.trialBalance = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const rows = await sequelize.query(
      `SELECT la.ledger_id, la.ledger_name, la.ledger_group, la.sub_group,
              la.is_party_ledger, la.party_id,
              COALESCE(SUM(le.debit_amount),  0)::float AS sum_dr,
              COALESCE(SUM(le.credit_amount), 0)::float AS sum_cr
         FROM ledger_accounts la
         LEFT JOIN ledger_entries le
           ON le.ledger_id = la.ledger_id
          AND ${liveEntriesWhereSql('le', true, false)}
        WHERE la.is_active = true
        GROUP BY la.ledger_id, la.ledger_name, la.ledger_group, la.sub_group,
                 la.is_party_ledger, la.party_id
        ORDER BY la.ledger_group ASC, la.sub_group ASC, la.ledger_name ASC`,
      { replacements: { to_date: to }, type: sequelize.QueryTypes.SELECT },
    );

    const ledgers = [];
    let totalDr = 0, totalCr = 0;
    for (const r of rows) {
      const net = r2(r.sum_dr - r.sum_cr);
      const dr  = net > 0 ? net : 0;
      const cr  = net < 0 ? -net : 0;
      // Suppress accounts with truly zero activity. Keeps the report
      // readable on partly-populated installs without losing the totals.
      if (dr === 0 && cr === 0) continue;
      ledgers.push({
        ledger_id: r.ledger_id,
        ledger_name: r.ledger_name,
        ledger_group: r.ledger_group,
        sub_group: r.sub_group,
        is_party_ledger: r.is_party_ledger,
        party_id: r.party_id,
        debit:  dr,
        credit: cr,
      });
      totalDr += dr; totalCr += cr;
    }
    totalDr = r2(totalDr); totalCr = r2(totalCr);

    // Filter-drift reconciliation. Computed independently from the TB SQL
    // above so a bug in the per-account aggregation can't make both
    // numbers wrong in the same way.
    const [filtRaw] = await sequelize.query(
      `SELECT COALESCE(SUM(le.debit_amount),  0)::float AS dr,
              COALESCE(SUM(le.credit_amount), 0)::float AS cr
         FROM ledger_entries le
        WHERE le.reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries m
             WHERE m.reversal_of_id = le.entry_id
          )
          AND le.entry_date <= :to_date`,
      { replacements: { to_date: to }, type: sequelize.QueryTypes.SELECT },
    );
    const [excluded] = await sequelize.query(
      `SELECT COALESCE(SUM(le.debit_amount),  0)::float AS dr,
              COALESCE(SUM(le.credit_amount), 0)::float AS cr
         FROM ledger_entries le
        WHERE le.reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries m
             WHERE m.reversal_of_id = le.entry_id
          )
          AND le.entry_date > :to_date`,
      { replacements: { to_date: to }, type: sequelize.QueryTypes.SELECT },
    );
    const [integ] = await sequelize.query(
      `SELECT COALESCE(SUM(le.debit_amount),  0)::float AS dr,
              COALESCE(SUM(le.credit_amount), 0)::float AS cr
         FROM ledger_entries le
        WHERE le.reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries m
             WHERE m.reversal_of_id = le.entry_id
          )`,
      { type: sequelize.QueryTypes.SELECT },
    );

    const filterRawDr = r2(filtRaw.dr), filterRawCr = r2(filtRaw.cr);
    const excludedDr  = r2(excluded.dr), excludedCr = r2(excluded.cr);
    const integDr     = r2(integ.dr),    integCr    = r2(integ.cr);
    const driftDr = r2(filterRawDr + excludedDr - integDr);
    const driftCr = r2(filterRawCr + excludedCr - integCr);

    res.json({
      period: { from, to },
      ledgers,
      totals: {
        debit: totalDr,
        credit: totalCr,
        difference: r2(totalDr - totalCr),
        balanced: Math.abs(totalDr - totalCr) < 0.01,
        accounts_count: ledgers.length,
      },
      reconciliation: {
        // Σ legs included by the filter. Compared with `excluded` and
        // `integrity_active` to detect any silent filter drift.
        filter_raw_dr: filterRawDr,
        filter_raw_cr: filterRawCr,
        // Σ legs deliberately excluded by `entry_date > to_date`. Non-zero
        // when the user picks a historical to_date — that's normal.
        excluded_after_to_dr: excludedDr,
        excluded_after_to_cr: excludedCr,
        // Σ all live legs across the entire ledger (no date bound).
        integrity_active_dr: integDr,
        integrity_active_cr: integCr,
        // Should be 0 to the paisa. If non-zero, the TB SQL is dropping
        // entries it shouldn't (regression like an inadvertent from_date
        // clause). UI banner surfaces this.
        drift_dr: driftDr,
        drift_cr: driftCr,
        balanced: Math.abs(driftDr) < 0.01 && Math.abs(driftCr) < 0.01,
      },
    });
  } catch (err) {
    console.error('trialBalance error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Balance Sheet ──────────────────────────────────────────────────────
//
// Liabilities (incl. Capital + Net Profit/Loss) on one side, Assets on
// the other. Balanced when ledger_entries are balanced; mismatches
// surface as a banner in the UI.
//
// Stock-in-Hand value (Σ products.current_stock × purchase_rate) is
// shown as an informational tile but NOT included in the balance-check
// totals — physical stock isn't yet reflected in ledger_entries (the
// Phase 5g/5h work integrated stock_ledger ↔ products.current_stock,
// but the corresponding double-entry posting on opening-stock /
// COGS is a future phase). Documenting the gap so future hardening
// has a clear scope.
exports.balanceSheet = async (req, res) => {
  try {
    // Balance Sheet is "as-of" — only to_date matters. Default = today.
    const { to } = await resolvePeriod({ to_date: req.query && req.query.to_date });
    const asOf = to;

    const rows = await sequelize.query(
      `SELECT la.ledger_id, la.ledger_name, la.ledger_group, la.sub_group,
              la.is_party_ledger,
              COALESCE(SUM(le.debit_amount),  0)::float AS sum_dr,
              COALESCE(SUM(le.credit_amount), 0)::float AS sum_cr
         FROM ledger_accounts la
         LEFT JOIN ledger_entries le
           ON le.ledger_id = la.ledger_id
          AND ${liveEntriesWhereSql('le', true, false)}
        WHERE la.is_active = true
        GROUP BY la.ledger_id, la.ledger_name, la.ledger_group, la.sub_group,
                 la.is_party_ledger
        ORDER BY la.ledger_group ASC, la.sub_group ASC, la.ledger_name ASC`,
      { replacements: { to_date: asOf }, type: sequelize.QueryTypes.SELECT },
    );

    // Group rows by ledger_group → sub_group.
    const groups = {
      [ASSET_GROUP]: { rows: [], total: 0 },
      [LIABILITY_GROUP]: { rows: [], total: 0 },
      [INCOME_GROUP]: { rows: [], total: 0 },
      [EXPENSE_GROUP]: { rows: [], total: 0 },
      [CAPITAL_GROUP]: { rows: [], total: 0 },
    };
    for (const r of rows) {
      const net = r2(r.sum_dr - r.sum_cr);  // signed
      if (net === 0) continue;
      // Display sign: Assets/Expenses are normally Dr-positive,
      // Liabilities/Capital/Income are normally Cr-positive. We flip
      // the sign for the latter so the report column always shows a
      // positive amount in its natural direction.
      const isCrSide = r.ledger_group === LIABILITY_GROUP
                    || r.ledger_group === INCOME_GROUP
                    || r.ledger_group === CAPITAL_GROUP;
      const display = isCrSide ? -net : net;
      const bucket = groups[r.ledger_group];
      if (!bucket) continue;
      bucket.rows.push({
        ledger_id: r.ledger_id,
        ledger_name: r.ledger_name,
        sub_group: r.sub_group,
        is_party_ledger: r.is_party_ledger,
        amount: display,
      });
      bucket.total += display;
    }
    Object.values(groups).forEach((g) => { g.total = r2(g.total); });

    const totalIncome  = groups[INCOME_GROUP].total;
    const totalExpense = groups[EXPENSE_GROUP].total;
    const netProfit    = r2(totalIncome - totalExpense);   // + = profit, − = loss

    // Liabilities side = Liabilities + Capital + Net Profit (if profit).
    // Assets side      = Assets + Net Loss (if loss).
    const liabilitiesSubGroups = bucketBySubGroup(groups[LIABILITY_GROUP].rows);
    const capitalSubGroups     = bucketBySubGroup(groups[CAPITAL_GROUP].rows);
    const assetsSubGroups      = bucketBySubGroup(groups[ASSET_GROUP].rows);

    let totalLiabilities = r2(groups[LIABILITY_GROUP].total + groups[CAPITAL_GROUP].total);
    let totalAssets      = r2(groups[ASSET_GROUP].total);
    if (netProfit >= 0) {
      // Profit closes onto the equity / capital side.
      totalLiabilities = r2(totalLiabilities + netProfit);
    } else {
      // Loss closes onto the assets side as a "deficit".
      totalAssets = r2(totalAssets + (-netProfit));
    }

    // Stock-in-Hand: physical stock value at this as-of-date. NOT
    // included in the balance-check; presented as an informational tile.
    const stockRows = await Product.findAll({
      attributes: ['product_id', 'current_stock', 'purchase_rate'],
    });
    let stockValue = 0;
    for (const p of stockRows) stockValue += num(p.current_stock) * num(p.purchase_rate);
    stockValue = r2(stockValue);

    res.json({
      as_of: asOf,
      liabilities: {
        sub_groups: liabilitiesSubGroups,
        capital_sub_groups: capitalSubGroups,
        net_profit: netProfit >= 0 ? netProfit : 0,
        total: totalLiabilities,
      },
      assets: {
        sub_groups: assetsSubGroups,
        net_loss: netProfit < 0 ? -netProfit : 0,
        total: totalAssets,
      },
      stock_value: stockValue,
      pl: {
        income:  totalIncome,
        expense: totalExpense,
        net:     netProfit,
      },
      totals: {
        total_assets: totalAssets,
        total_liabilities: totalLiabilities,
        difference: r2(totalAssets - totalLiabilities),
        balanced: Math.abs(totalAssets - totalLiabilities) < 0.01,
      },
    });
  } catch (err) {
    console.error('balanceSheet error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Cash Flow Statement ────────────────────────────────────────────────
//
// Three sections — Operating, Investing, Financing — derived from
// ledger_entries activity within the period. Cash + Bank ledgers are
// tracked separately so we can show opening / closing reconciliation.
//
// Section detection runs on ledger_group + sub_group of the OTHER leg
// of every cash/bank-touching voucher:
//   Operating: party legs (Sundry Debtors / Sundry Creditors), Sales /
//              Purchase / their returns, GST ledgers (Duties & Taxes),
//              Indirect Income/Expense.
//   Investing: Fixed Assets sub-group on either side.
//   Financing: Capital / Loans sub-group.
//
// Net change in cash MUST equal Closing − Opening of (Cash + Bank). If
// not, banner — most likely a manual SQL edit on stock_ledger or a
// double-write someone left behind.
exports.cashFlow = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);

    // Resolve cash + bank ledger ids. The classification is by sub_group
    // ONLY — not by name. The previous `ledger_name ILIKE '%Cash%'`
    // bandage matched a Sundry Debtors party stub literally named
    // "Cash Sales" (created by Tally import), which then had every
    // sales-bill leg counted as a cash inflow. Fix: restrict to the
    // canonical cash/bank sub_groups AND require is_party_ledger=false
    // — a party ledger is NEVER cash by definition.
    const cashRows = await sequelize.query(
      `SELECT ledger_id, ledger_name, sub_group FROM ledger_accounts
        WHERE is_active = true
          AND is_party_ledger = false
          AND sub_group IN ('Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c')`,
      { type: sequelize.QueryTypes.SELECT },
    );
    const cashIds = cashRows.map((r) => r.ledger_id);
    if (cashIds.length === 0) {
      return res.json({
        period: { from, to },
        sections: { operating: [], investing: [], financing: [] },
        totals: { operating: 0, investing: 0, financing: 0, net_change: 0 },
        reconciliation: { opening: 0, closing: 0, computed_change: 0, balanced: true },
      });
    }

    // Opening cash = net Dr − Cr on cash ledgers BEFORE from_date.
    // Closing cash = net Dr − Cr on cash ledgers UP TO to_date.
    const openingRow = (await sequelize.query(
      `SELECT
         COALESCE(SUM(le.debit_amount - le.credit_amount), 0)::float AS net
        FROM ledger_entries le
        WHERE le.ledger_id IN (:ids)
          AND ${liveEntriesWhereSql('le', false, false)}
          AND le.entry_date < :from_date`,
      { replacements: { ids: cashIds, from_date: from }, type: sequelize.QueryTypes.SELECT },
    ))[0];
    const closingRow = (await sequelize.query(
      `SELECT
         COALESCE(SUM(le.debit_amount - le.credit_amount), 0)::float AS net
        FROM ledger_entries le
        WHERE le.ledger_id IN (:ids)
          AND ${liveEntriesWhereSql('le', true, false)}
          AND le.entry_date <= :to_date`,
      { replacements: { ids: cashIds, to_date: to }, type: sequelize.QueryTypes.SELECT },
    ))[0];
    const opening = r2(openingRow.net);
    const closing = r2(closingRow.net);
    const computedChange = r2(closing - opening);

    // Section attribution: for each entry on a cash/bank ledger inside
    // the period, find the contra-leg(s) of the same voucher (same
    // entry_number) and use their group/sub_group to classify.
    //
    // SQL approach: join ledger_entries to itself by entry_number, group
    // by entry_number AND classification, then sum the cash impact.
    const cashLegRows = await sequelize.query(
      `WITH cash_legs AS (
         SELECT entry_id, entry_number, debit_amount, credit_amount, entry_date
           FROM ledger_entries le
          WHERE le.ledger_id IN (:ids)
            AND ${liveEntriesWhereSql('le', true, true)}
       ),
       contra_legs AS (
         SELECT cl.entry_number,
                la.ledger_group,
                la.sub_group,
                la.ledger_name,
                SUM(le.debit_amount - le.credit_amount) AS contra_net
           FROM cash_legs cl
           JOIN ledger_entries le ON le.entry_number = cl.entry_number
                                  AND le.ledger_id NOT IN (:ids)
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          GROUP BY cl.entry_number, la.ledger_group, la.sub_group, la.ledger_name
       )
       SELECT cl.entry_number,
              SUM(cl.debit_amount - cl.credit_amount)::float AS cash_net,
              MAX(cl.entry_date)::text AS entry_date,
              (SELECT json_agg(json_build_object(
                  'ledger_group', cn.ledger_group,
                  'sub_group',    cn.sub_group,
                  'ledger_name',  cn.ledger_name,
                  'contra_net',   cn.contra_net
              )) FROM contra_legs cn WHERE cn.entry_number = cl.entry_number) AS contras
         FROM cash_legs cl
        GROUP BY cl.entry_number`,
      { replacements: { ids: cashIds, from_date: from, to_date: to }, type: sequelize.QueryTypes.SELECT },
    );

    const operating = [], investing = [], financing = [];
    let totOp = 0, totIn = 0, totFi = 0;
    for (const row of cashLegRows) {
      const cashImpact = r2(row.cash_net);
      const contras = row.contras || [];
      // Pick the first contra leg as the section classifier (typical
      // single-contra voucher). Multi-contra vouchers are rare — we
      // attribute the whole cash leg to the first contra's section.
      const c = contras[0] || {};
      const sub = String(c.sub_group || '').toLowerCase();
      const grp = String(c.ledger_group || '').toLowerCase();
      let section = 'operating';   // default
      if (/fixed assets/.test(sub) || /investment/.test(sub)) section = 'investing';
      else if (/capital/.test(sub) || /loan/.test(sub) || grp === 'capital') section = 'financing';

      const item = {
        entry_number: row.entry_number,
        entry_date:   row.entry_date,
        cash_impact:  cashImpact,        // + = inflow, − = outflow
        contra_label: contras.map((x) => x.ledger_name).filter(Boolean).join(', '),
        section,
      };
      if (section === 'operating') { operating.push(item); totOp += cashImpact; }
      else if (section === 'investing') { investing.push(item); totIn += cashImpact; }
      else { financing.push(item); totFi += cashImpact; }
    }

    const totalsSum = r2(totOp + totIn + totFi);
    res.json({
      period: { from, to },
      sections: { operating, investing, financing },
      totals: {
        operating: r2(totOp),
        investing: r2(totIn),
        financing: r2(totFi),
        net_change: totalsSum,
      },
      reconciliation: {
        opening, closing,
        computed_change: computedChange,
        attributed_change: totalsSum,
        balanced: Math.abs(totalsSum - computedChange) < 0.01,
      },
    });
  } catch (err) {
    console.error('cashFlow error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// The R2 receivables/payables aging endpoints + UI were removed and
// superseded by the pre-existing /api/reports/aging endpoint
// (server/controllers/reportController.js#agingReport). Single source
// of truth — that endpoint now carries the corrected reconciliation
// invariant; see the comment above _agingReconciliation there for the
// formula. Drift banner lives on src/pages/reports/AgingReport.jsx.

// Group an array of {sub_group, amount, ledger_*} into [{sub_group, total, rows[]}].
function bucketBySubGroup(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const key = r.sub_group || '(Uncategorised)';
    if (!buckets.has(key)) buckets.set(key, { sub_group: key, total: 0, rows: [] });
    const b = buckets.get(key);
    b.total += r.amount;
    b.rows.push(r);
  }
  for (const b of buckets.values()) b.total = r2(b.total);
  return [...buckets.values()];
}
