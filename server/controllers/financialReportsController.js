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
const { SystemSettings, Product } = require('../models');

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
