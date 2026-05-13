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

// Sub-groups that drive the P&L's Sales/Purchase sections. Single
// source of truth — referenced by the seeder + the boot-time migration
// that reclassified the four ledgers, AND by the P&L grouping logic
// here. Intentionally NOT a hardcoded ledger-name allowlist: anything
// the user adds with sub_group='Sales Accounts' lands here naturally.
const SALES_ACCOUNTS_SUB    = 'Sales Accounts';
const PURCHASE_ACCOUNTS_SUB = 'Purchase Accounts';
const DIRECT_INCOME_SUB     = 'Direct Incomes';
const DIRECT_EXPENSE_SUB    = 'Direct Expenses';
const INDIRECT_INCOME_SUB   = 'Indirect Incomes';
const INDIRECT_EXPENSE_SUB  = 'Indirect Expenses';

// Convert numbers safely. DECIMAL columns come back as strings — naïve
// `value || fallback` doesn't work because "0.00" is truthy.
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }

const { computeDisplayCostAsOf, fetchBatchAggregateAsOf } = require('../utils/displayCost');

// Stock-in-Hand value as of a date — mode-aware.
//
//   Step 1: per-product qty at as_of (from stock_ledger, with fallback
//           to products.opening_stock for products that bypassed the
//           ledger entirely).
//   Step 2: per-mode cost basis (via computeDisplayCostAsOf):
//             • variant            → product.purchase_rate
//             • single, no batch   → product.weighted_avg_cost
//                                    (approximation: current wac stands
//                                     in for as-of-date wac — option B
//                                     from the design; documented in
//                                     displayCost.js)
//             • single + batch     → SUM(batch.qty_at_asof × batch.rate)
//                                    derived from stock_ledger filtered
//                                    by batch_id + as_of (EXACT — batch
//                                    rates are frozen at first-write)
//   Step 3: per-product value = qty × cost (or batch SUM directly for
//           single+batch). Sum across all active products.
//
// Same helper feeds Balance Sheet (as-of stock value), Profit & Loss
// (Opening + Closing Stock), and Trial Balance (stock delta = closing −
// opening). Invariant I6 (paisa-exact across reports + periods) is
// preserved because all three callers share this single computation.
//
// The qty fallback (products.opening_stock when no ledger movements
// exist at/before as_of) is preserved bit-exactly from the prior
// implementation so legacy data paths (seeder fixtures, manual backfill,
// products created via importers that bypassed stock_ledger) keep
// behaving the same.
async function stockValueAt(asOfDate) {
  // Step 1: qty per product at as_of, AND product metadata in one
  // round-trip. Products with no ledger movements still appear (LEFT
  // JOIN) so the opening_stock fallback below can fire.
  const rows = await sequelize.query(
    `WITH movements AS (
       SELECT product_id,
              SUM(COALESCE(quantity_in, 0) - COALESCE(quantity_out, 0)) AS qty
         FROM stock_ledger
        WHERE transaction_date <= :as_of
        GROUP BY product_id
     )
     SELECT p.product_id,
            p.product_mode,
            p.is_batch_tracked,
            p.purchase_rate::float           AS purchase_rate,
            p.weighted_avg_cost::float       AS weighted_avg_cost,
            p.opening_stock::float           AS opening_stock,
            p.opening_stock_date,
            m.qty::float                     AS ledger_qty
       FROM products p
       LEFT JOIN movements m ON m.product_id = p.product_id
      WHERE p.is_active = true`,
    { replacements: { as_of: asOfDate }, type: sequelize.QueryTypes.SELECT },
  );

  // Step 2: for single+batch products, fetch as-of batch aggregate in
  // one bulk query (per-batch ledger sums × batch.purchase_rate). Empty
  // input → empty Map, no DB round-trip.
  const batchProductIds = rows
    .filter(r => r.product_mode === 'single' && r.is_batch_tracked)
    .map(r => r.product_id);
  const batchAggMap = await fetchBatchAggregateAsOf(batchProductIds, asOfDate);

  // Step 3: per-product value, summed.
  let total = 0;
  for (const r of rows) {
    // Resolve qty at as_of: ledger sum if present, else opening_stock
    // when its date stamp permits. Mirrors the three CASE branches of
    // the prior implementation.
    let qty = 0;
    if (r.ledger_qty != null) {
      qty = parseFloat(r.ledger_qty) || 0;
    } else if (r.opening_stock_date && String(r.opening_stock_date).slice(0, 10) <= asOfDate) {
      qty = parseFloat(r.opening_stock) || 0;
    } else if (!r.opening_stock_date && asOfDate >= '2000-01-01') {
      qty = parseFloat(r.opening_stock) || 0;
    }

    if (qty === 0) continue;

    let value;
    if (r.product_mode === 'single' && r.is_batch_tracked) {
      // Batch-tracked: total_value from the as-of batch aggregate IS
      // the per-product stock value (each batch's qty × its frozen
      // purchase_rate, summed). qty fallback above doesn't apply here
      // — if a single+batch product has no batch ledger data at as_of,
      // it has no value attributable to a batch and we contribute 0.
      const agg = batchAggMap.get(r.product_id);
      value = agg ? agg.total_value : 0;
    } else {
      const cost = computeDisplayCostAsOf(r, asOfDate);
      value = qty * cost;
    }
    total += value;
  }

  return r2(total);
}

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

    // Stock-in-Hand: physical stock value at this as-of-date.
    //   = SUM( per-product net qty up to as_of × current purchase_rate )
    // Sourced via stockValueAt() so the value is correct for ANY date
    // (historical or future), and so the same number flows into P&L's
    // Closing Stock line — invariant I6 (BS closing stock = P&L closing
    // stock, paisa-exact) is enforced by sharing this helper. NOT
    // included in the balance-check; presented as an informational tile.
    const stockValue = await stockValueAt(asOf);

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

// ── Profit & Loss ──────────────────────────────────────────────────────
//
// TallyPrime-shape two-column statement. Sourced ENTIRELY from
// ledger_entries (Active = forward, non-reversed) so the figures are a
// pure derivation of the journal — manual JVs, opening balances, and
// voucher-driven postings all flow through the same path. No
// hand-curated allowlists; group/sub_group classification IS the
// allowlist.
//
//   Dr / Expenses side               Cr / Income side
//   ───────────────────────────────  ─────────────────────────────────
//   1. Opening Stock                 1. Sales Accounts (gross −
//   2. Purchase Accounts (gross −       Sales Returns = Net Sales)
//      Purchase Returns = Net        2. Closing Stock
//      Purchases)                    3. Direct Incomes (per ledger)
//   3. Direct Expenses (per ledger)  4. Gross Loss b/f (rare)
//   4. Gross Profit c/o (balancing)  5. Indirect Incomes (per ledger)
//   5. Indirect Expenses             6. Net Loss (balancing)
//   6. Net Profit (balancing)
//
// Invariants enforced and surfaced in the response:
//   I1  Total Dr = Total Cr (banner if not).
//   I2  Gross Profit = (Net Sales + Closing Stock + Direct Income)
//                    − (Opening Stock + Net Purchases + Direct Expenses)
//   I3  Net Profit  = Gross Profit + Indirect Income − Indirect Expense
//   I4  Net Profit (P&L) = P&L A/c closing on Balance Sheet (paisa-exact)
//   I5  Net Profit (P&L) = Σ(Income groups Cr − Expense groups Dr) on TB
//   I6  Closing Stock (P&L) = Closing Stock (BS) — shared helper enforces
//   I8  No GST ledger appears in P&L (group classification gates this)
//
// Stock costing convention: SUM(qty_in − qty_out up to date) ×
// products.purchase_rate (current). Same as BS so I6 holds.
//
// Comparative period (Tally-style "Previous Period" column) is supported
// via comp_from_date / comp_to_date query params. If only the current
// period is supplied with `?comparative=auto`, we derive an automatic
// prior period of equal length ending the day before from_date.
//
// Sales/Purchase Returns netting:
//   Within the 'Sales Accounts' sub_group, a Cr-balance ledger is a
//   sale and a Dr-balance ledger is a return — so the natural sign
//   classifies without a name allowlist. Same idea (mirrored) for
//   'Purchase Accounts'. Adding a user-defined Returns ledger that
//   sits in the right sub_group lights up automatically.
exports.profitLoss = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);

    // Comparative-period resolution. Three modes:
    //   1. Explicit: comp_from_date + comp_to_date supplied → use as-is.
    //   2. Auto:    `?comparative=auto` (or `?comparative=1`) → derive
    //               a prior period of EQUAL CALENDAR LENGTH ending the
    //               day before from_date. Tally uses the prior FY for
    //               annual comparisons, the prior quarter for QoQ, etc.
    //               "Equal length, ending day before" is a generic rule
    //               that matches all of those by construction.
    //   3. None:    no comp_* params → response.comparative is null.
    let compRange = null;
    const compReq = String(req.query?.comparative || '').toLowerCase();
    if (req.query?.comp_from_date && req.query?.comp_to_date) {
      compRange = {
        from: String(req.query.comp_from_date).slice(0, 10),
        to:   String(req.query.comp_to_date).slice(0, 10),
      };
    } else if (compReq === 'auto' || compReq === '1' || compReq === 'true') {
      const fromD = new Date(from + 'T00:00:00Z');
      const toD   = new Date(to   + 'T00:00:00Z');
      const days  = Math.round((toD - fromD) / 86400000); // inclusive both ends
      // Comp ends one day before current.from; same span backwards.
      const compToD   = new Date(fromD); compToD.setUTCDate(compToD.getUTCDate() - 1);
      const compFromD = new Date(compToD); compFromD.setUTCDate(compFromD.getUTCDate() - days);
      compRange = {
        from: compFromD.toISOString().slice(0, 10),
        to:   compToD.toISOString().slice(0, 10),
      };
    }

    const current = await computeProfitLoss(from, to);
    const comparative = compRange ? await computeProfitLoss(compRange.from, compRange.to) : null;

    res.json({
      period: { from, to },
      current,
      comparative,
    });
  } catch (err) {
    console.error('profitLoss error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// Compute one period's P&L. Pure function over (from, to) — used twice
// when comparative is requested.
async function computeProfitLoss(from, to) {
  // 1. Pull ledger activity for Income + Expense groups in [from, to].
  //    A ledger's contribution is signed Σ(Dr) − Σ(Cr) over its rows
  //    inside the period. Within a group:
  //      Income groups (Cr-natured):    display = −net  (positive on Cr side)
  //      Expense groups (Dr-natured):   display = +net  (positive on Dr side)
  //    Stored as `net_dr` (raw signed) so the consumer can decide.
  const rows = await sequelize.query(
    `SELECT la.ledger_id, la.ledger_name, la.ledger_group, la.sub_group,
            COALESCE(SUM(le.debit_amount),  0)::float AS sum_dr,
            COALESCE(SUM(le.credit_amount), 0)::float AS sum_cr
       FROM ledger_accounts la
       LEFT JOIN ledger_entries le
         ON le.ledger_id = la.ledger_id
        AND ${liveEntriesWhereSql('le', true, true)}
      WHERE la.is_active = true
        AND la.ledger_group IN ('Income', 'Expenses')
      GROUP BY la.ledger_id, la.ledger_name, la.ledger_group, la.sub_group
      ORDER BY la.ledger_group, la.sub_group, la.ledger_name`,
    { replacements: { from_date: from, to_date: to }, type: sequelize.QueryTypes.SELECT },
  );

  // 2. Bucket ledgers into Tally-shape groups.
  const buckets = {
    sales_accounts: { lines: [], gross: 0, returns: 0, net: 0 },
    purchase_accounts: { lines: [], gross: 0, returns: 0, net: 0 },
    direct_income:    { lines: [], total: 0 },
    direct_expense:   { lines: [], total: 0 },
    indirect_income:  { lines: [], total: 0 },
    indirect_expense: { lines: [], total: 0 },
    other_income_lines:  [],   // any Income ledger not in the four sub_groups above (defensive)
    other_expense_lines: [],   // any Expense ledger not in the four sub_groups above
  };

  for (const r of rows) {
    const netDr = r.sum_dr - r.sum_cr;     // signed Σ Dr − Σ Cr
    if (Math.abs(netDr) < 0.005) continue; // suppress no-activity ledgers
    const line = {
      ledger_id:   r.ledger_id,
      ledger_name: r.ledger_name,
      ledger_group: r.ledger_group,
      sub_group:    r.sub_group,
    };

    if (r.sub_group === SALES_ACCOUNTS_SUB) {
      // Cr-balance (netDr < 0) = sale; Dr-balance (netDr > 0) = return.
      if (netDr < 0) {
        const amount = r2(-netDr);
        buckets.sales_accounts.lines.push({ ...line, kind: 'sale', amount });
        buckets.sales_accounts.gross += amount;
      } else {
        const amount = r2(netDr);
        buckets.sales_accounts.lines.push({ ...line, kind: 'return', amount });
        buckets.sales_accounts.returns += amount;
      }
    } else if (r.sub_group === PURCHASE_ACCOUNTS_SUB) {
      // Dr-balance (netDr > 0) = purchase; Cr-balance (netDr < 0) = return.
      if (netDr > 0) {
        const amount = r2(netDr);
        buckets.purchase_accounts.lines.push({ ...line, kind: 'purchase', amount });
        buckets.purchase_accounts.gross += amount;
      } else {
        const amount = r2(-netDr);
        buckets.purchase_accounts.lines.push({ ...line, kind: 'return', amount });
        buckets.purchase_accounts.returns += amount;
      }
    } else if (r.ledger_group === INCOME_GROUP && r.sub_group === DIRECT_INCOME_SUB) {
      const amount = r2(-netDr);
      if (Math.abs(amount) > 0) {
        buckets.direct_income.lines.push({ ...line, amount });
        buckets.direct_income.total += amount;
      }
    } else if (r.ledger_group === EXPENSE_GROUP && r.sub_group === DIRECT_EXPENSE_SUB) {
      const amount = r2(netDr);
      if (Math.abs(amount) > 0) {
        buckets.direct_expense.lines.push({ ...line, amount });
        buckets.direct_expense.total += amount;
      }
    } else if (r.ledger_group === INCOME_GROUP && r.sub_group === INDIRECT_INCOME_SUB) {
      const amount = r2(-netDr);
      if (Math.abs(amount) > 0) {
        buckets.indirect_income.lines.push({ ...line, amount });
        buckets.indirect_income.total += amount;
      }
    } else if (r.ledger_group === EXPENSE_GROUP && r.sub_group === INDIRECT_EXPENSE_SUB) {
      const amount = r2(netDr);
      if (Math.abs(amount) > 0) {
        buckets.indirect_expense.lines.push({ ...line, amount });
        buckets.indirect_expense.total += amount;
      }
    } else if (r.ledger_group === INCOME_GROUP) {
      // Defensive: a P&L-natured Income ledger in an unrecognised
      // sub_group still contributes to the report. Bucketed as
      // Indirect Income so it's never silently dropped — the audit
      // surfaces this so the chart-of-accounts can be tightened.
      const amount = r2(-netDr);
      buckets.other_income_lines.push({ ...line, amount });
      buckets.indirect_income.total += amount;
      buckets.indirect_income.lines.push({ ...line, amount, defaulted: true });
    } else if (r.ledger_group === EXPENSE_GROUP) {
      const amount = r2(netDr);
      buckets.other_expense_lines.push({ ...line, amount });
      buckets.indirect_expense.total += amount;
      buckets.indirect_expense.lines.push({ ...line, amount, defaulted: true });
    }
  }

  // Totals & netting (round once, here).
  buckets.sales_accounts.gross    = r2(buckets.sales_accounts.gross);
  buckets.sales_accounts.returns  = r2(buckets.sales_accounts.returns);
  buckets.sales_accounts.net      = r2(buckets.sales_accounts.gross - buckets.sales_accounts.returns);
  buckets.purchase_accounts.gross   = r2(buckets.purchase_accounts.gross);
  buckets.purchase_accounts.returns = r2(buckets.purchase_accounts.returns);
  buckets.purchase_accounts.net     = r2(buckets.purchase_accounts.gross - buckets.purchase_accounts.returns);
  buckets.direct_income.total    = r2(buckets.direct_income.total);
  buckets.direct_expense.total   = r2(buckets.direct_expense.total);
  buckets.indirect_income.total  = r2(buckets.indirect_income.total);
  buckets.indirect_expense.total = r2(buckets.indirect_expense.total);

  // Audit C23 — ledger-empty fallback. If the period has bills but the
  // Sales/Purchase ledger sub_groups show ₹0 (voucher-posting hasn't
  // fired for those bills, e.g. fresh install or a migration window),
  // fall back to bill-aggregate sums so the P&L reports non-zero numbers
  // an operator can verify against. The response includes a `fallback_in_use`
  // flag so the frontend can render an explanatory banner.
  let fallback_in_use = false;
  let fallback_reason = null;
  if (buckets.sales_accounts.gross === 0 && buckets.purchase_accounts.gross === 0) {
    const [billCheck] = await sequelize.query(
      `SELECT
         COALESCE((SELECT SUM(total_amount)::float FROM sales_bills
                    WHERE is_cancelled = false AND bill_date BETWEEN :from AND :to), 0) AS sales_total,
         COALESCE((SELECT SUM(total_amount)::float FROM purchase_bills
                    WHERE is_cancelled = false AND bill_date BETWEEN :from AND :to), 0) AS purchase_total,
         COALESCE((SELECT SUM(total_amount)::float FROM sales_return_bills
                    WHERE is_cancelled = false AND bill_date BETWEEN :from AND :to), 0) AS sales_return_total,
         COALESCE((SELECT SUM(total_amount)::float FROM purchase_return_bills
                    WHERE is_cancelled = false AND bill_date BETWEEN :from AND :to), 0) AS purchase_return_total`,
      { replacements: { from, to }, type: sequelize.QueryTypes.SELECT },
    );
    if ((billCheck.sales_total || 0) > 0 || (billCheck.purchase_total || 0) > 0) {
      // Bills exist but ledger is silent — vouchers weren't posted. Use
      // bill aggregates as a best-effort substitute so the P&L isn't
      // misleadingly ₹0.
      fallback_in_use = true;
      fallback_reason = 'Ledger entries are empty for Sales/Purchase in this period; showing bill aggregates instead. Run "Recalculate ledgers" in Admin Tools to repost vouchers and remove this fallback.';
      buckets.sales_accounts.gross   = r2(billCheck.sales_total);
      buckets.sales_accounts.returns = r2(billCheck.sales_return_total);
      buckets.sales_accounts.net     = r2(buckets.sales_accounts.gross - buckets.sales_accounts.returns);
      buckets.sales_accounts.lines.push({
        ledger_id: null, ledger_name: 'Sales (bill aggregate)', ledger_group: 'Income',
        sub_group: SALES_ACCOUNTS_SUB, kind: 'sale', amount: buckets.sales_accounts.gross, fallback: true,
      });
      if (buckets.sales_accounts.returns > 0) {
        buckets.sales_accounts.lines.push({
          ledger_id: null, ledger_name: 'Sales Returns (bill aggregate)', ledger_group: 'Income',
          sub_group: SALES_ACCOUNTS_SUB, kind: 'return', amount: buckets.sales_accounts.returns, fallback: true,
        });
      }
      buckets.purchase_accounts.gross   = r2(billCheck.purchase_total);
      buckets.purchase_accounts.returns = r2(billCheck.purchase_return_total);
      buckets.purchase_accounts.net     = r2(buckets.purchase_accounts.gross - buckets.purchase_accounts.returns);
      buckets.purchase_accounts.lines.push({
        ledger_id: null, ledger_name: 'Purchases (bill aggregate)', ledger_group: 'Expenses',
        sub_group: PURCHASE_ACCOUNTS_SUB, kind: 'purchase', amount: buckets.purchase_accounts.gross, fallback: true,
      });
      if (buckets.purchase_accounts.returns > 0) {
        buckets.purchase_accounts.lines.push({
          ledger_id: null, ledger_name: 'Purchase Returns (bill aggregate)', ledger_group: 'Expenses',
          sub_group: PURCHASE_ACCOUNTS_SUB, kind: 'return', amount: buckets.purchase_accounts.returns, fallback: true,
        });
      }
    }
  }

  // 3. Stock — opening (period_start − 1 day) and closing (period_end).
  const fromD = new Date(from + 'T00:00:00Z');
  fromD.setUTCDate(fromD.getUTCDate() - 1);
  const openingDate = fromD.toISOString().slice(0, 10);
  const openingStock = await stockValueAt(openingDate);
  const closingStock = await stockValueAt(to);

  // 4. Balancing figures (I2, I3).
  const grossProfit = r2(
    (buckets.sales_accounts.net + closingStock + buckets.direct_income.total)
    - (openingStock + buckets.purchase_accounts.net + buckets.direct_expense.total),
  );
  const netProfit = r2(
    grossProfit + buckets.indirect_income.total - buckets.indirect_expense.total,
  );

  // 5. Build the two-column response. Each side's `total` is the
  //    BOTTOM-of-column number; both sides MUST equal (I1).
  //
  //    Tally splits the P&L into two stages, presented as one combined
  //    Dr|Cr statement:
  //      Stage 1 (Trading A/c)  → balances at Gross Profit / Gross Loss
  //      Stage 2 (P&L A/c)      → balances at Net Profit / Net Loss
  //    The balancing figures appear on BOTH sides — carried over (c/o)
  //    closes one stage on its side, brought down (b/d) opens the next
  //    stage on the opposite side. Frontend can draw a horizontal
  //    divider between the two stages, but the response keeps them as
  //    flat fields so each is independently addressable in the editorial
  //    UI's drill-down logic.
  //
  //      grossProfit > 0  →  Dr has Gross Profit c/o   (closes stage 1)
  //                          Cr has Gross Profit b/d   (opens stage 2)
  //      grossProfit < 0  →  Cr has Gross Loss b/f     (closes stage 1)
  //                          Dr has Gross Loss b/d     (opens stage 2)
  //      netProfit   > 0  →  Dr has Net Profit         (closes stage 2)
  //      netProfit   < 0  →  Cr has Net Loss           (closes stage 2)
  //
  //    Same number appears twice (c/o + b/d) so the column totals on
  //    each side land equal — which is what makes I1 hold paisa-exactly.
  const grossProfitCo = grossProfit > 0 ? grossProfit : 0;   // Dr, stage-1 close
  const grossProfitBd = grossProfit > 0 ? grossProfit : 0;   // Cr, stage-2 open
  const grossLossBf   = grossProfit < 0 ? -grossProfit : 0;  // Cr, stage-1 close
  const grossLossBd   = grossProfit < 0 ? -grossProfit : 0;  // Dr, stage-2 open
  const netProfitOut  = netProfit > 0 ? netProfit : 0;
  const netLossOut    = netProfit < 0 ? -netProfit : 0;

  const debit = {
    opening_stock: openingStock,
    purchase_accounts: buckets.purchase_accounts,
    direct_expenses: buckets.direct_expense,
    gross_profit_co: grossProfitCo,        // closes stage 1 on Dr
    gross_loss_bd:   grossLossBd,          // opens stage 2 on Dr (loss case)
    indirect_expenses: buckets.indirect_expense,
    net_profit: netProfitOut,
    total: r2(
      openingStock
      + buckets.purchase_accounts.net
      + buckets.direct_expense.total
      + grossProfitCo
      + grossLossBd
      + buckets.indirect_expense.total
      + netProfitOut,
    ),
  };
  const credit = {
    sales_accounts: buckets.sales_accounts,
    closing_stock: closingStock,
    direct_income: buckets.direct_income,
    gross_loss_bf:   grossLossBf,          // closes stage 1 on Cr (loss case)
    gross_profit_bd: grossProfitBd,        // opens stage 2 on Cr (profit case)
    indirect_income: buckets.indirect_income,
    net_loss: netLossOut,
    total: r2(
      buckets.sales_accounts.net
      + closingStock
      + buckets.direct_income.total
      + grossLossBf
      + grossProfitBd
      + buckets.indirect_income.total
      + netLossOut,
    ),
  };

  // 6. Cross-checks against the Trial Balance and Balance Sheet — surfaced
  //    so the UI can banner any drift. Computed independently from the
  //    bucketed numbers above so a bug in the bucket logic can't mask
  //    itself by also breaking the cross-check.
  //
  // I5 — TB net P&L:
  //   = Σ(Income groups Cr − Dr) over the period
  //     + Σ(Expense groups Dr − Cr) over the period flipped to Income side
  //   = Σ(−net_dr for Income) − Σ(net_dr for Expense)
  // Plus stock adjustment: Closing − Opening (since Tally treats stock
  // change as a P&L-nature adjustment when the opening-stock voucher
  // hasn't been posted as a real journal — current data assumption).
  const [tbRow] = await sequelize.query(
    `SELECT
       COALESCE(SUM(CASE WHEN la.ledger_group = 'Income'
                         THEN le.credit_amount - le.debit_amount ELSE 0 END), 0)::float AS income_cr_net,
       COALESCE(SUM(CASE WHEN la.ledger_group = 'Expenses'
                         THEN le.debit_amount  - le.credit_amount ELSE 0 END), 0)::float AS expense_dr_net
       FROM ledger_accounts la
       JOIN ledger_entries le ON le.ledger_id = la.ledger_id
      WHERE la.is_active = true
        AND la.ledger_group IN ('Income', 'Expenses')
        AND ${liveEntriesWhereSql('le', true, true)}`,
    { replacements: { from_date: from, to_date: to }, type: sequelize.QueryTypes.SELECT },
  );
  const tbIncomeNet  = r2(tbRow.income_cr_net);
  const tbExpenseNet = r2(tbRow.expense_dr_net);
  const tbStockDelta = r2(closingStock - openingStock);
  const tbPlNet      = r2(tbIncomeNet - tbExpenseNet + tbStockDelta);
  const tbDiff       = r2(tbPlNet - netProfit);

  // I4 — BS P&L A/c closing.
  // The Balance Sheet's "Profit & Loss A/c" line on the Capital side is
  // computed as (cumulative Income − Expense up to as_of). For our
  // *period* P&L, the comparable BS-side number is computed for [from, to]
  // (not "since beginning of time"). Cross-check uses the same window so
  // the equality holds period-by-period rather than only at FY close.
  const bsPlAccount = r2(tbIncomeNet - tbExpenseNet);   // net of period (excl. stock adj)
  const bsExpected  = r2(netProfit - tbStockDelta);     // P&L net minus stock-delta = ledger-only net
  const bsDiff      = r2(bsPlAccount - bsExpected);

  return {
    period: { from, to },
    debit,
    credit,
    summary: {
      gross_profit: grossProfit,         // signed: + profit, − loss
      net_profit:   netProfit,
      stock_adjustment: tbStockDelta,    // closing − opening (informational)
    },
    // Audit C23 — surfaced so the frontend can show a banner explaining
    // that ledger postings are absent and bill aggregates are being used.
    fallback_in_use,
    fallback_reason,
    reconciliation: {
      // I1 — column equality
      total_debit:  debit.total,
      total_credit: credit.total,
      difference:   r2(debit.total - credit.total),
      balanced:     Math.abs(debit.total - credit.total) < 0.01,
      // I5 — TB ledger net + stock delta = our net profit
      tb_pl_net:  tbPlNet,
      tb_diff:    tbDiff,
      tb_match:   Math.abs(tbDiff) < 0.01,
      // I4 — BS-side P&L closing (ledger-only net, used to validate
      // against the BS's Capital → Profit & Loss A/c line).
      bs_pl_account:        bsPlAccount,
      bs_expected_match:    bsExpected,
      bs_diff:              bsDiff,
      bs_match:             Math.abs(bsDiff) < 0.01,
    },
  };
}

// ── Cash Flow Statement (Tally-style three-level drill) ───────────────
//
// Three views, one resolver chain:
//
//   View 1 — Monthly register (cashFlowMonthly)
//     One row per calendar month between from..to. Inflow = Σ debit on
//     cash/bank ledgers; Outflow = Σ credit; Nett = Inflow − Outflow.
//     Months with zero activity still appear (generate_series).
//
//   View 2 — Two-column sub_group breakdown (cashFlowMonth)
//     For a single month, group the contra-leg sub_groups: cash leg on
//     the Dr side → Inflow column under contra's sub_group; cash leg
//     on the Cr side → Outflow column. Negative-amount groups never
//     appear (the per-row sign already encodes direction).
//
//   View 3 — Voucher list (cashFlowGroup)
//     For one (month, sub_group, direction), list the actual vouchers
//     chronologically. Date / Voucher / Contra Ledger / Amount.
//
// Cash detection (shared resolver, NOT changed from the previous
// implementation): sub_group IN 'Cash-in-Hand' / 'Bank Accounts' /
// 'Bank OD A/c' AND is_party_ledger = false. A party ledger is NEVER
// cash by definition — this is what stops a Sundry Debtors stub
// literally named "Cash Sales" from polluting the inflow column.

// Resolve cash/bank ledger ids — the only place cash is defined.
async function _resolveCashLedgerIds() {
  const rows = await sequelize.query(
    `SELECT ledger_id FROM ledger_accounts
      WHERE is_active = true
        AND is_party_ledger = false
        AND sub_group IN ('Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c')`,
    { type: sequelize.QueryTypes.SELECT },
  );
  return rows.map((r) => r.ledger_id);
}

// Format a YYYY-MM-01 ISO into "April 2026".
function _monthLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// View 1 — Monthly register. One row per calendar month between
// from..to with totals at the bottom.
exports.cashFlowMonthly = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const cashIds = await _resolveCashLedgerIds();
    if (cashIds.length === 0) {
      return res.json({
        period: { from, to },
        rows: [],
        totals: { inflow: 0, outflow: 0, nett: 0 },
      });
    }

    // generate_series produces every month start in the range so months
    // with zero activity still appear. LEFT JOIN against the cash legs
    // grouped by month start.
    const rows = await sequelize.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', :from_date::date),
           date_trunc('month', :to_date::date),
           interval '1 month'
         )::date AS month_start
       ),
       agg AS (
         SELECT date_trunc('month', le.entry_date)::date AS month_start,
                COALESCE(SUM(le.debit_amount),  0)::float AS inflow,
                COALESCE(SUM(le.credit_amount), 0)::float AS outflow
           FROM ledger_entries le
          WHERE le.ledger_id IN (:ids)
            AND ${liveEntriesWhereSql('le', true, true)}
          GROUP BY date_trunc('month', le.entry_date)
       )
       SELECT to_char(m.month_start, 'YYYY-MM-01') AS month_iso,
              COALESCE(a.inflow,  0)::float AS inflow,
              COALESCE(a.outflow, 0)::float AS outflow
         FROM months m
         LEFT JOIN agg a ON a.month_start = m.month_start
        ORDER BY m.month_start`,
      { replacements: { ids: cashIds, from_date: from, to_date: to }, type: sequelize.QueryTypes.SELECT },
    );

    let totIn = 0, totOut = 0;
    const out = rows.map((r) => {
      const inflow  = r2(r.inflow);
      const outflow = r2(r.outflow);
      const nett    = r2(inflow - outflow);
      totIn  += inflow;
      totOut += outflow;
      return {
        month_iso:   r.month_iso,
        month_label: _monthLabel(r.month_iso),
        inflow, outflow, nett,
      };
    });

    res.json({
      period: { from, to },
      rows: out,
      totals: { inflow: r2(totIn), outflow: r2(totOut), nett: r2(totIn - totOut) },
    });
  } catch (err) {
    console.error('cashFlowMonthly error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// View 2 — Two-column sub_group drill for a single month.
// `?month=YYYY-MM` (also accepts a YYYY-MM-DD; the day is ignored).
exports.cashFlowMonth = async (req, res) => {
  try {
    const monthRaw = String(req.query.month || '').slice(0, 10);
    if (!/^\d{4}-\d{2}/.test(monthRaw)) {
      return res.status(400).json({ error: 'month query param required (YYYY-MM)' });
    }
    // Normalize to month start / month end.
    const [y, m] = monthRaw.split('-').map(Number);
    const fromDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const monthEnd = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this
    const toDate   = monthEnd.toISOString().slice(0, 10);

    const cashIds = await _resolveCashLedgerIds();
    if (cashIds.length === 0) {
      return res.json({
        period: { from: fromDate, to: toDate, month_label: _monthLabel(fromDate) },
        inflow_groups: [], outflow_groups: [],
        totals: { inflow: 0, outflow: 0, nett: 0 },
      });
    }

    // Self-join cash legs to their contras (same entry_number, OTHER
    // ledger). Sum the cash impact (Dr − Cr) per (sub_group, direction).
    // Direction is determined by the sign of the cash leg, not by the
    // contra: cash Dr (positive) → inflow; cash Cr (negative) → outflow.
    //
    // Multi-contra convention matches the Tally screenshots: attribute
    // the whole cash impact to the FIRST contra's sub_group (picked by
    // entry_id ascending, deterministic). We use a window function to
    // pick that single contra per voucher.
    const rows = await sequelize.query(
      `WITH cash_legs AS (
         SELECT entry_number,
                entry_date,
                debit_amount,
                credit_amount,
                (debit_amount - credit_amount) AS cash_net
           FROM ledger_entries le
          WHERE le.ledger_id IN (:ids)
            AND ${liveEntriesWhereSql('le', true, true)}
       ),
       -- Audit M8: when a voucher splits cash across multiple contra
       -- ledgers (e.g. Cash 100 / Sales 80 / CGST 10 / SGST 10), this
       -- DISTINCT ON picks the first non-cash leg and attributes the
       -- WHOLE cash amount to its sub_group. Tally-style attribution —
       -- documented behaviour, but worth flagging here so an
       -- enhancement that splits cash by leg-amount stays compatible.
       contra_first AS (
         SELECT DISTINCT ON (le.entry_number)
                le.entry_number,
                la.sub_group,
                la.ledger_group
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE le.ledger_id NOT IN (:ids)
            AND le.entry_number IN (SELECT entry_number FROM cash_legs)
            AND ${liveEntriesWhereSql('le', false, false)}
          ORDER BY le.entry_number, le.entry_id
       )
       SELECT COALESCE(cf.sub_group, '(Uncategorised)') AS sub_group,
              SUM(cl.debit_amount)::float  AS inflow,
              SUM(cl.credit_amount)::float AS outflow
         FROM cash_legs cl
         LEFT JOIN contra_first cf ON cf.entry_number = cl.entry_number
        GROUP BY cf.sub_group`,
      { replacements: { ids: cashIds, from_date: fromDate, to_date: toDate }, type: sequelize.QueryTypes.SELECT },
    );

    const inflowGroups  = [];
    const outflowGroups = [];
    let totIn = 0, totOut = 0;
    for (const r of rows) {
      const inflow  = r2(r.inflow);
      const outflow = r2(r.outflow);
      if (inflow > 0.005) {
        inflowGroups.push({ sub_group: r.sub_group, total: inflow });
        totIn += inflow;
      }
      if (outflow > 0.005) {
        outflowGroups.push({ sub_group: r.sub_group, total: outflow });
        totOut += outflow;
      }
    }
    inflowGroups.sort((a, b) => b.total - a.total);
    outflowGroups.sort((a, b) => b.total - a.total);

    res.json({
      period: { from: fromDate, to: toDate, month_label: _monthLabel(fromDate) },
      inflow_groups:  inflowGroups,
      outflow_groups: outflowGroups,
      totals: { inflow: r2(totIn), outflow: r2(totOut), nett: r2(totIn - totOut) },
    });
  } catch (err) {
    console.error('cashFlowMonth error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// View 3 — Voucher list for one (month, sub_group, direction).
// `?month=YYYY-MM&sub_group=...&direction=in|out`
exports.cashFlowGroup = async (req, res) => {
  try {
    const monthRaw = String(req.query.month || '').slice(0, 10);
    const subGroup = String(req.query.sub_group || '');
    const direction = String(req.query.direction || '').toLowerCase();
    if (!/^\d{4}-\d{2}/.test(monthRaw)) {
      return res.status(400).json({ error: 'month query param required (YYYY-MM)' });
    }
    if (!subGroup) {
      return res.status(400).json({ error: 'sub_group query param required' });
    }
    if (direction !== 'in' && direction !== 'out') {
      return res.status(400).json({ error: 'direction must be "in" or "out"' });
    }
    const [y, m] = monthRaw.split('-').map(Number);
    // Date range = month-derived by default; the client can override
    // with explicit from_date / to_date params to widen / narrow the
    // window. Used by the third view's date-range picker so the user
    // can ask "show me everything between these two dates that
    // contributed to this sub_group's cash flow", not just the month
    // they originally drilled from.
    const monthFrom = `${y}-${String(m).padStart(2, '0')}-01`;
    const monthTo   = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const fromRaw = String(req.query.from_date || '').slice(0, 10);
    const toRaw   = String(req.query.to_date   || '').slice(0, 10);
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : monthFrom;
    const toDate   = /^\d{4}-\d{2}-\d{2}$/.test(toRaw)   ? toRaw   : monthTo;

    const cashIds = await _resolveCashLedgerIds();
    if (cashIds.length === 0) {
      return res.json({
        period: { from: fromDate, to: toDate, month_label: _monthLabel(fromDate), sub_group: subGroup, direction },
        rows: [],
        total: 0,
      });
    }

    // Same self-join as cashFlowMonth, but filter to (a) the chosen
    // sub_group and (b) the chosen direction, then collapse to one
    // row per voucher.
    //
    // CRITICAL — two bugs in the previous version that the user saw
    // as "broken UI":
    //   1. cash_legs returns one row per cash LEG; a voucher that hits
    //      the cash ledger N times (one per item line on a sales bill,
    //      etc.) produced N duplicate rows. Fix: aggregate cash_legs by
    //      entry_number first.
    //   2. contra_names used string_agg WITHOUT DISTINCT, so a SAL
    //      voucher with 7 line items that all post to "Sales Account"
    //      and "CGST Output" rendered as "Sales Account, Sales Account,
    //      Sales Account, …, CGST Output, CGST Output, …" — a wall of
    //      noise. Fix: string_agg(DISTINCT …).
    // The "(Uncategorised)" bucket is matched explicitly when the
    // sub_group string equals it.
    const rows = await sequelize.query(
      `WITH cash_legs AS (
         SELECT entry_number,
                MAX(entry_date) AS entry_date,
                SUM(debit_amount)  AS debit_amount,
                SUM(credit_amount) AS credit_amount
           FROM ledger_entries le
          WHERE le.ledger_id IN (:ids)
            AND ${liveEntriesWhereSql('le', true, true)}
            AND ${direction === 'in' ? 'le.debit_amount > 0' : 'le.credit_amount > 0'}
          GROUP BY entry_number
       ),
       contra_first AS (
         SELECT DISTINCT ON (le.entry_number)
                le.entry_number,
                la.sub_group
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE le.ledger_id NOT IN (:ids)
            AND le.entry_number IN (SELECT entry_number FROM cash_legs)
            AND ${liveEntriesWhereSql('le', false, false)}
          ORDER BY le.entry_number, le.entry_id
       ),
       contra_names AS (
         SELECT le.entry_number,
                string_agg(DISTINCT la.ledger_name, ', ' ORDER BY la.ledger_name) AS contra_label
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE le.ledger_id NOT IN (:ids)
            AND le.entry_number IN (SELECT entry_number FROM cash_legs)
            AND ${liveEntriesWhereSql('le', false, false)}
          GROUP BY le.entry_number
       ),
       /* party_names = subset of contra_names restricted to ledgers
          flagged as parties (customers / suppliers). Lets the client
          show a clean "Party" column with just the customer/supplier
          name, while keeping the full contra-leg list available as a
          separate "Details" column the user can opt into. The two
          columns answer different questions:
            - Party   → "who paid us / who we paid"  (the natural
                        first answer for an operator scanning cash)
            - Details → "what other accounts moved with this voucher"
                        (CGST Output, Sales Account, etc. — useful
                        when reconciling a single voucher's posting). */
       party_names AS (
         SELECT le.entry_number,
                string_agg(DISTINCT la.ledger_name, ', ' ORDER BY la.ledger_name) AS party_label
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE le.ledger_id NOT IN (:ids)
            AND la.is_party_ledger = true
            AND le.entry_number IN (SELECT entry_number FROM cash_legs)
            AND ${liveEntriesWhereSql('le', false, false)}
          GROUP BY le.entry_number
       )
       SELECT cl.entry_number,
              cl.entry_date::text AS entry_date,
              ${direction === 'in' ? 'cl.debit_amount' : 'cl.credit_amount'}::float AS amount,
              COALESCE(cn.contra_label, '') AS contra_label,
              COALESCE(pn.party_label,  '') AS party_label
         FROM cash_legs cl
         JOIN contra_first cf ON cf.entry_number = cl.entry_number
         LEFT JOIN contra_names cn ON cn.entry_number = cl.entry_number
         LEFT JOIN party_names  pn ON pn.entry_number = cl.entry_number
        WHERE COALESCE(cf.sub_group, '(Uncategorised)') = :sub_group
        ORDER BY cl.entry_date, cl.entry_number`,
      {
        replacements: { ids: cashIds, from_date: fromDate, to_date: toDate, sub_group: subGroup },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    let total = 0;
    const out = rows.map((r) => {
      const amount = r2(r.amount);
      total += amount;
      return {
        entry_date:   r.entry_date,
        entry_number: r.entry_number,
        // party_label = customers/suppliers only; contra_label = full
        // contra-leg list including tax + sales/purchase accounts.
        // Client picks which to show via the Customize popover.
        party_label:  r.party_label,
        contra_label: r.contra_label,
        amount,
      };
    });

    res.json({
      period: { from: fromDate, to: toDate, month_label: _monthLabel(fromDate), sub_group: subGroup, direction },
      rows: out,
      total: r2(total),
    });
  } catch (err) {
    console.error('cashFlowGroup error:', err);
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

// ── Fund Flow Statement ────────────────────────────────────────────────
//
// Tracks change in WORKING CAPITAL (Current Assets − Current Liabilities)
// between two balance-sheet dates, plus the long-term sources and
// applications that drove the change. Standard ICAI / Tally format.
//
// Two interlocking parts:
//
//   1. Schedule of Changes in Working Capital — line-by-line opening vs
//      closing for every Current Asset and Current Liability ledger.
//      Effect on WC:
//        Current Asset:      ↑ Δ → Increase in WC | ↓ Δ → Decrease in WC
//        Current Liability:  ↑ Δ → Decrease in WC | ↓ Δ → Increase in WC
//
//   2. Statement of Sources and Applications of Funds:
//        Sources       = Funds From Operations
//                      + Capital introduced
//                      + Long-term loans raised
//                      + Sale of fixed assets (net, at cost)
//                      + Sale of investments (net)
//                      + Decrease in Working Capital (if applicable)
//        Applications  = Funds Lost in Operations (if loss)
//                      + Drawings / Capital withdrawn
//                      + Long-term loans repaid
//                      + Purchase of fixed assets (net, at cost)
//                      + Purchase of investments (net)
//                      + Increase in Working Capital (if applicable)
//
// Core accounting identity (the report's own correctness check):
//   Total Sources = Total Applications  (paisa-exact, ±0.01 tolerance)
//
// This is forced by the balance-sheet equation:
//   ΔAssets = ΔLiabilities + ΔCapital + Net Profit
//   (ΔCA + ΔFA + ΔInv + ΔMiscExp) = (ΔCL + ΔLTL) + ΔCap + NP
//   ΔWC = NP + ΔLTL + ΔCap − ΔFA − ΔInv − ΔMiscExp
//
// Funds From Operations (FFO):
//   FFO = Net Profit
//       + non-fund expenses charged to P&L
//       − non-fund incomes credited to P&L
//   "Non-fund" = book entries that don't represent working-capital
//   movement: depreciation, amortization, provisions, gains/losses on
//   sale of fixed assets / investments, goodwill or preliminary
//   expenses written off.
//
// Depreciation handling — the subtle bit:
//   Depreciation reduces the closing FA balance below the opening, so a
//   naïve ΔFA = closing − opening would show a phantom "Sale of FA"
//   equal to the depreciation amount. The fix is to compute FA movement
//   AT COST: ΔFA_at_cost = ΔFA + Depreciation_charged_in_period. Then:
//     ΔFA_at_cost > 0 → "Purchase of Fixed Assets" (Application)
//     ΔFA_at_cost < 0 → "Sale of Fixed Assets"     (Source)
//   The same trick applies to Misc. Expenses (Asset) + amortization.
//
// Stock-in-Hand:
//   This ERP has no dedicated Stock-in-Hand ledger; the value is
//   derived from stock_ledger × current purchase_rate (same helper
//   the Balance Sheet uses — stockValueAt). We surface it as a
//   synthetic Current Asset line in the WC schedule so closing − opening
//   stock movement flows through correctly.
//
// Period defaults (matches Cash Flow + P&L):
//   from_date → SystemSettings.financial_year_start (fallback 1900-01-01)
//   to_date   → today
//
// Heuristic detection of non-fund items:
//   No dedicated tag exists on ledgers in this ERP; we match by ledger
//   name (case-insensitive) restricted to ledgers in the Income/Expense
//   groups. Patterns are intentionally broad — accountants use varied
//   names ("Depreciation A/c", "Plant Depreciation Charge", etc.) and
//   missing one breaks FFO. The response surfaces the matched ledgers
//   so the operator can audit / rename anything that misfires.

// Sub-group classifications. Mirrors src/pages/reports/TrialBalance.jsx's
// SUB_TO_MID, reorganized as set membership for fund-flow's
// current-vs-non-current question.
const FF_CURRENT_ASSET_SUBS = new Set([
  'Sundry Debtors', 'Cash-in-Hand', 'Bank Accounts', 'Bank Account',
  'Stock-in-Hand',
  'Loans & Advances (Asset)', 'Loans and Advances (Asset)',
  'Deposits (Asset)', 'Other Current Assets',
  // Duties & Taxes is in BOTH lists — disambiguated by ledger_group.
  'Duties & Taxes', 'Duties and Taxes', 'Input GST',
]);
const FF_FIXED_ASSET_SUBS = new Set([
  'Fixed Assets', 'Plant & Machinery', 'Furniture & Fixtures', 'Vehicles',
  'Office Equipment', 'Computer & Equipment', 'Buildings', 'Land',
]);
const FF_INVESTMENT_SUBS = new Set(['Investments']);
const FF_MISC_EXP_SUBS   = new Set(['Misc. Expenses (Asset)']);
const FF_CURRENT_LIAB_SUBS = new Set([
  'Sundry Creditors',
  'Duties & Taxes', 'Duties and Taxes', 'Output GST',
  'Provisions',
  'Other Current Liabilities',
]);
const FF_LONG_TERM_LIAB_SUBS = new Set([
  'Loans (Liability)',
  'Bank OD/CC', 'Bank OD A/c',
  'Secured Loans', 'Unsecured Loans',
]);

// Asset side: which "kind" is this ledger?
function ffClassifyAsset(subGroup) {
  const sg = subGroup || '';
  if (FF_FIXED_ASSET_SUBS.has(sg))  return 'fixed_asset';
  if (FF_INVESTMENT_SUBS.has(sg))   return 'investment';
  if (FF_MISC_EXP_SUBS.has(sg))     return 'misc_exp';
  // Everything else under Assets falls through to Current Asset. This
  // catches: party debtor ledgers (no sub_group), seeded current-asset
  // sub-groups, and anything new the user adds without changing the
  // classifier — safer than dropping unknowns.
  return 'current_asset';
}
// Liability side: current vs long-term.
function ffClassifyLiability(subGroup) {
  const sg = subGroup || '';
  if (FF_LONG_TERM_LIAB_SUBS.has(sg)) return 'long_term';
  // Everything else under Liabilities falls through to Current Liability.
  // Same safety reasoning as above.
  return 'current_liability';
}

// Heuristic patterns for non-fund items. Restricted at call site to
// ledgers in Income/Expense groups (so a "Provision for Doubtful Debts"
// sitting under Sundry Creditors as a liability doesn't misfire here).
//
// Order matters within a category — first-match wins so "Loss on sale
// of investments" doesn't pre-empt "Loss on sale of fixed assets".
const FF_NON_FUND_EXPENSE_PATTERNS = [
  { id: 'loss_sale_inv',  label: 'Loss on sale of investments',
    re: /\bloss\b.*\b(sale|disposal)\b.*\binvest/i },
  { id: 'loss_sale_fa',   label: 'Loss on sale of fixed assets',
    re: /\bloss\b.*\b(sale|disposal)\b.*\b(asset|fixed|plant|machine|vehicle|building|land|equipment|furniture)\b/i },
  { id: 'depreciation',   label: 'Depreciation',
    re: /\bdepreciation\b/i },
  { id: 'amortization',   label: 'Amortization',
    re: /\bamorti[sz]ation\b/i },
  { id: 'goodwill_wo',    label: 'Goodwill written off',
    re: /\bgoodwill\b.*\b(written|writ)\b.*\boff\b|\b(written|writ)\b.*\boff\b.*\bgoodwill\b/i },
  { id: 'preliminary_wo', label: 'Preliminary expenses written off',
    re: /\bpreliminary\b.*\b(written|writ)\b.*\boff\b|\b(written|writ)\b.*\boff\b.*\bpreliminary\b/i },
  { id: 'provision',      label: 'Provisions (P&L charge)',
    re: /\bprovision(s)?\b/i },
];
const FF_NON_FUND_INCOME_PATTERNS = [
  { id: 'profit_sale_inv', label: 'Profit on sale of investments',
    re: /\b(profit|gain)\b.*\b(sale|disposal)\b.*\binvest/i },
  { id: 'profit_sale_fa',  label: 'Profit on sale of fixed assets',
    re: /\b(profit|gain)\b.*\b(sale|disposal)\b.*\b(asset|fixed|plant|machine|vehicle|building|land|equipment|furniture)\b/i },
];

// Classify a ledger name against the non-fund-item patterns. Returns
// the first matching pattern id + label, or null. Capital ledgers /
// non-P&L groups should be filtered out before calling.
function ffMatchNonFund(ledgerName, side /* 'expense' | 'income' */) {
  const patterns = side === 'expense'
    ? FF_NON_FUND_EXPENSE_PATTERNS
    : FF_NON_FUND_INCOME_PATTERNS;
  const name = ledgerName || '';
  for (const p of patterns) {
    if (p.re.test(name)) return { id: p.id, label: p.label };
  }
  return null;
}

// ISO date subtraction — returns the day before `iso`. Used to derive
// the "opening balance as-of" date from from_date.
function ffPreviousDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Pull every ledger's opening balance, closing balance, and period
// movement (Dr/Cr separately for both ends) in a single query.
//
// Six SUM columns per row:
//   open_dr   — Σ debit_amount  for entries dated < from_date
//   open_cr   — Σ credit_amount for entries dated < from_date
//   close_dr  — Σ debit_amount  for entries dated ≤ to_date
//   close_cr  — Σ credit_amount for entries dated ≤ to_date
//   period_dr — Σ debit_amount  for entries dated in [from_date, to_date]
//   period_cr — Σ credit_amount for entries dated in [from_date, to_date]
// Live entries only (forward postings minus paired reversals).
async function ffFetchLedgerBalances(fromDate, toDate) {
  // We need entries < from_date for opening, so the JOIN can't pre-filter
  // by date — the CASE expressions inside SUM do the filtering. Reversal
  // pairs are excluded via the standard liveEntries clauses.
  const rows = await sequelize.query(
    `SELECT la.ledger_id, la.ledger_name, la.ledger_group, la.sub_group,
            la.is_party_ledger,
            COALESCE(SUM(CASE WHEN le.entry_date < :from_date  THEN le.debit_amount  ELSE 0 END), 0)::float AS open_dr,
            COALESCE(SUM(CASE WHEN le.entry_date < :from_date  THEN le.credit_amount ELSE 0 END), 0)::float AS open_cr,
            COALESCE(SUM(CASE WHEN le.entry_date <= :to_date   THEN le.debit_amount  ELSE 0 END), 0)::float AS close_dr,
            COALESCE(SUM(CASE WHEN le.entry_date <= :to_date   THEN le.credit_amount ELSE 0 END), 0)::float AS close_cr,
            COALESCE(SUM(CASE WHEN le.entry_date >= :from_date AND le.entry_date <= :to_date THEN le.debit_amount  ELSE 0 END), 0)::float AS period_dr,
            COALESCE(SUM(CASE WHEN le.entry_date >= :from_date AND le.entry_date <= :to_date THEN le.credit_amount ELSE 0 END), 0)::float AS period_cr
       FROM ledger_accounts la
       LEFT JOIN ledger_entries le
         ON le.ledger_id = la.ledger_id
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries m
           WHERE m.reversal_of_id = le.entry_id
        )
      WHERE la.is_active = true
      GROUP BY la.ledger_id, la.ledger_name, la.ledger_group, la.sub_group,
               la.is_party_ledger
      ORDER BY la.ledger_group ASC, la.sub_group ASC, la.ledger_name ASC`,
    { replacements: { from_date: fromDate, to_date: toDate }, type: sequelize.QueryTypes.SELECT },
  );
  // Decorate with display-signed opening / closing balances. Convention:
  //   Asset/Expense  → display = Dr − Cr  (positive on Dr side)
  //   Liab/Inc/Cap   → display = Cr − Dr  (positive on Cr side)
  return rows.map((r) => {
    const isCrSide = r.ledger_group === LIABILITY_GROUP
                  || r.ledger_group === INCOME_GROUP
                  || r.ledger_group === CAPITAL_GROUP;
    const openSigned  = r.open_dr  - r.open_cr;
    const closeSigned = r.close_dr - r.close_cr;
    const opening = r2(isCrSide ? -openSigned  : openSigned);
    const closing = r2(isCrSide ? -closeSigned : closeSigned);
    return {
      ledger_id:       r.ledger_id,
      ledger_name:     r.ledger_name,
      ledger_group:    r.ledger_group,
      sub_group:       r.sub_group || '(Uncategorised)',
      is_party_ledger: r.is_party_ledger,
      opening,                  // display-signed
      closing,                  // display-signed
      delta: r2(closing - opening),
      period_dr: r2(r.period_dr),
      period_cr: r2(r.period_cr),
    };
  });
}

exports.fundFlow = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);

    // ── 1. Pull every ledger's opening + closing + period movement ──
    const ledgers = await ffFetchLedgerBalances(from, to);

    // ── 2. Stock-in-Hand: synthetic Current Asset line ──
    // The ERP has no Stock-in-Hand ledger; closing/opening stock comes
    // from stock_ledger × current purchase_rate. Same helper Balance
    // Sheet uses, so closing-stock invariant I6 holds across reports.
    const openingStockDate = ffPreviousDay(from);
    const openingStock = await stockValueAt(openingStockDate);
    const closingStock = await stockValueAt(to);

    // ── 3. Working capital schedule ──
    // For each Current Asset: Δ > 0 → Increase in WC; Δ < 0 → Decrease.
    // For each Current Liability: Δ > 0 → Decrease in WC; Δ < 0 → Increase.
    // (Liability balances above are already display-signed positive on
    // Cr side, so a closing > opening is a real CL increase.)
    const caRows = [];
    const clRows = [];
    let openingFA = 0, closingFA = 0;
    let openingInv = 0, closingInv = 0;
    let openingMiscExp = 0, closingMiscExp = 0;
    let openingLTL = 0, closingLTL = 0;
    let openingCap = 0, closingCap = 0;

    for (const l of ledgers) {
      // Skip ledgers with no activity AT ALL (zero open AND close AND period
      // movement). Keeps the schedule readable.
      if (l.opening === 0 && l.closing === 0 && l.period_dr === 0 && l.period_cr === 0) continue;
      if (l.ledger_group === ASSET_GROUP) {
        const kind = ffClassifyAsset(l.sub_group);
        if (kind === 'current_asset') {
          caRows.push(buildScheduleRow(l, 'asset'));
        } else if (kind === 'fixed_asset') {
          openingFA += l.opening; closingFA += l.closing;
        } else if (kind === 'investment') {
          openingInv += l.opening; closingInv += l.closing;
        } else if (kind === 'misc_exp') {
          openingMiscExp += l.opening; closingMiscExp += l.closing;
        }
      } else if (l.ledger_group === LIABILITY_GROUP) {
        const kind = ffClassifyLiability(l.sub_group);
        if (kind === 'current_liability') {
          clRows.push(buildScheduleRow(l, 'liability'));
        } else {
          openingLTL += l.opening; closingLTL += l.closing;
        }
      } else if (l.ledger_group === CAPITAL_GROUP) {
        openingCap += l.opening; closingCap += l.closing;
      }
      // Income / Expense ledgers contribute via Net Profit, not balance change.
    }

    // Synthetic Stock-in-Hand line (only if non-zero either end).
    if (openingStock !== 0 || closingStock !== 0) {
      const delta = r2(closingStock - openingStock);
      caRows.push({
        ledger_id:    null,
        ledger_name:  'Stock-in-Hand',
        sub_group:    'Stock-in-Hand',
        is_synthetic: true,
        opening:      r2(openingStock),
        closing:      r2(closingStock),
        delta,
        increase_in_wc: delta > 0 ? delta : 0,
        decrease_in_wc: delta < 0 ? -delta : 0,
      });
    }

    // ── 4. Schedule totals ──
    const caRowsSorted = caRows.slice().sort((a, b) => a.ledger_name.localeCompare(b.ledger_name));
    const clRowsSorted = clRows.slice().sort((a, b) => a.ledger_name.localeCompare(b.ledger_name));
    const sumOpening = (rows) => r2(rows.reduce((s, r) => s + r.opening, 0));
    const sumClosing = (rows) => r2(rows.reduce((s, r) => s + r.closing, 0));
    const sumIncWc   = (rows) => r2(rows.reduce((s, r) => s + r.increase_in_wc, 0));
    const sumDecWc   = (rows) => r2(rows.reduce((s, r) => s + r.decrease_in_wc, 0));
    const totIncWc = r2(sumIncWc(caRowsSorted) + sumIncWc(clRowsSorted));
    const totDecWc = r2(sumDecWc(caRowsSorted) + sumDecWc(clRowsSorted));
    const netChangeWc = r2(totIncWc - totDecWc);
    const openingWC = r2(sumOpening(caRowsSorted) - sumOpening(clRowsSorted));
    const closingWC = r2(sumClosing(caRowsSorted) - sumClosing(clRowsSorted));

    // ── 5. Funds From Operations ──
    // P&L for the period gives Net Profit. Then add back non-fund
    // expenses charged and subtract non-fund incomes credited.
    const pl = await computeProfitLoss(from, to);
    // computeProfitLoss returns { summary: { net_profit, ... }, debit, credit, ... }
    // — net_profit is signed (+ profit, − loss).
    const netProfit = pl.summary.net_profit;

    // Walk the Income/Expense ledgers, match against the heuristic
    // patterns, and total the period_dr (for expenses) / period_cr
    // (for incomes) across each pattern bucket.
    const addBackBuckets = new Map();   // pattern_id → { label, amount, ledgers: [...] }
    const lessBuckets    = new Map();
    for (const l of ledgers) {
      if (l.ledger_group === EXPENSE_GROUP) {
        const m = ffMatchNonFund(l.ledger_name, 'expense');
        if (!m) continue;
        const amt = l.period_dr;
        if (amt < 0.005) continue;
        if (!addBackBuckets.has(m.id)) {
          addBackBuckets.set(m.id, { id: m.id, label: m.label, amount: 0, ledgers: [] });
        }
        const b = addBackBuckets.get(m.id);
        b.amount = r2(b.amount + amt);
        b.ledgers.push({ ledger_id: l.ledger_id, ledger_name: l.ledger_name, amount: amt });
      } else if (l.ledger_group === INCOME_GROUP) {
        const m = ffMatchNonFund(l.ledger_name, 'income');
        if (!m) continue;
        const amt = l.period_cr;
        if (amt < 0.005) continue;
        if (!lessBuckets.has(m.id)) {
          lessBuckets.set(m.id, { id: m.id, label: m.label, amount: 0, ledgers: [] });
        }
        const b = lessBuckets.get(m.id);
        b.amount = r2(b.amount + amt);
        b.ledgers.push({ ledger_id: l.ledger_id, ledger_name: l.ledger_name, amount: amt });
      }
    }
    const addBackList = [...addBackBuckets.values()].sort((a, b) => b.amount - a.amount);
    const lessList    = [...lessBuckets.values()].sort((a, b) => b.amount - a.amount);
    const sumAddBack  = r2(addBackList.reduce((s, b) => s + b.amount, 0));
    const sumLess     = r2(lessList.reduce((s, b) => s + b.amount, 0));
    const ffo         = r2(netProfit + sumAddBack - sumLess);
    // Detect what the depreciation/amortization buckets contributed —
    // needed to back out the FA / Misc-Exp movement at COST below.
    const depreciationCharge = r2((addBackBuckets.get('depreciation')?.amount) || 0);
    const amortizationCharge = r2((addBackBuckets.get('amortization')?.amount) || 0);

    // ── 6. Sources and Applications ──
    //
    // Capital change: + → Capital introduced (Source); − → Drawings/
    // withdrawal (Application). We surface both directions if both
    // happened — but on a SINGLE figure (net), since most of the time
    // owner contributions and drawings net to one direction.
    const capChange = r2(closingCap - openingCap);

    // Long-term liabilities: + → loans raised (Source); − → repaid (App).
    const ltlChange = r2(closingLTL - openingLTL);

    // Fixed assets at COST. Naïve ΔFA = closing − opening would be
    // distorted by depreciation (which reduced closing). Add depreciation
    // back to recover the at-cost movement.
    //   closing_FA = opening_FA + Purchases − Sales_at_cost − Depreciation
    //   Therefore: Purchases − Sales_at_cost = ΔFA + Depreciation
    const faChangeAtCost = r2((closingFA - openingFA) + depreciationCharge);

    // Investments. Investments don't depreciate, but profit/loss on
    // sale of investments lives in P&L and is already removed from FFO,
    // so the at-cost net movement is just ΔInv.
    const invChange = r2(closingInv - openingInv);

    // Misc Expenses (Asset) — preliminary expenses, deferred revenue
    // expenditure, etc. Same reasoning as FA: amortization reduced
    // closing, add it back.
    const miscExpChangeAtCost = r2((closingMiscExp - openingMiscExp) + amortizationCharge);

    const sources = [];
    const applications = [];

    // FFO: positive → operating source; negative → operating application.
    if (ffo > 0) {
      sources.push({
        id: 'ffo', label: 'Funds From Operations', amount: ffo,
        detail: { net_profit: r2(netProfit), add_back: addBackList, less: lessList },
      });
    } else if (ffo < 0) {
      applications.push({
        id: 'ffl', label: 'Funds Lost in Operations', amount: r2(-ffo),
        detail: { net_profit: r2(netProfit), add_back: addBackList, less: lessList },
      });
    }
    // Capital
    if (capChange > 0) {
      sources.push({ id: 'cap_in',  label: 'Capital Introduced',         amount: capChange });
    } else if (capChange < 0) {
      applications.push({ id: 'cap_out', label: 'Drawings / Capital Withdrawn', amount: r2(-capChange) });
    }
    // Long-term liabilities
    if (ltlChange > 0) {
      sources.push({ id: 'ltl_raised', label: 'Long-term Loans Raised',  amount: ltlChange });
    } else if (ltlChange < 0) {
      applications.push({ id: 'ltl_repaid', label: 'Long-term Loans Repaid', amount: r2(-ltlChange) });
    }
    // Fixed assets (at cost)
    if (faChangeAtCost > 0) {
      applications.push({ id: 'fa_buy',  label: 'Purchase of Fixed Assets (at cost)', amount: faChangeAtCost });
    } else if (faChangeAtCost < 0) {
      sources.push({ id: 'fa_sell', label: 'Sale of Fixed Assets (at cost)',     amount: r2(-faChangeAtCost) });
    }
    // Investments
    if (invChange > 0) {
      applications.push({ id: 'inv_buy',  label: 'Purchase of Investments',        amount: invChange });
    } else if (invChange < 0) {
      sources.push({ id: 'inv_sell', label: 'Sale of Investments',                amount: r2(-invChange) });
    }
    // Misc Expenses (Asset)
    if (miscExpChangeAtCost > 0) {
      applications.push({ id: 'misc_exp_inc', label: 'Misc. Expenses (Asset) increased', amount: miscExpChangeAtCost });
    }
    // We don't show "decrease in misc exp" as a Source — amortization
    // handles that case via the FFO add-back.

    // ── 7. Reconciliation — Tally convention ──
    //
    // Tally's Funds Flow Summary does NOT add a synthetic "Increase /
    // Decrease in Working Capital" balancing line to the Sources or
    // Applications columns. The two columns show only REAL flows:
    //   Sources       = NP + capital introduced + loans raised + FA sold
    //   Applications  = drawings + loans repaid + FA purchased
    // The bottom Working-Capital strip on the page conveys the
    // remainder: ΔWC = Sources − Applications.
    //
    // Equivalent to the ICAI textbook formulation but presented
    // differently — keeps the top columns honest about what funds
    // genuinely came in/out, with the WC change as the closing
    // arithmetic check rather than a forced balancing entry.
    //
    // The mathematical identity: Sources − Applications = ΔWC
    // (force-balanced version: Sources = Applications + ΔWC). Both
    // formulations are paisa-equivalent.
    const totalSources = r2(sources.reduce((s, x) => s + x.amount, 0));
    const totalApplications = r2(applications.reduce((s, x) => s + x.amount, 0));
    // Reconciliation: Σ Sources − Σ Applications must equal ΔWC.
    // A non-zero `drift` indicates classifier coverage gaps (eg. an FA
    // sub_group not in our list, an unhandled non-fund item, etc.).
    const drift = r2((totalSources - totalApplications) - netChangeWc);
    const balanced = Math.abs(drift) < 0.01;
    // Pre-WC totals retained for back-compat / debugging — they equal
    // totalSources/totalApplications now since we no longer push the
    // wc_inc/wc_dec line. Kept so consumers reading the old shape don't
    // crash; the two pairs are identical.
    const totalSourcesPre = totalSources;
    const totalAppsPre    = totalApplications;

    res.json({
      period: { from, to },
      schedule: {
        current_assets:      caRowsSorted,
        current_liabilities: clRowsSorted,
        totals: {
          opening_ca: r2(sumOpening(caRowsSorted)),
          closing_ca: r2(sumClosing(caRowsSorted)),
          opening_cl: r2(sumOpening(clRowsSorted)),
          closing_cl: r2(sumClosing(clRowsSorted)),
          opening_wc: openingWC,
          closing_wc: closingWC,
          increase_in_wc: totIncWc,
          decrease_in_wc: totDecWc,
          net_change_in_wc: netChangeWc,
        },
      },
      ffo: {
        net_profit: r2(netProfit),
        is_loss:    netProfit < 0,
        add_back:   addBackList,
        less:       lessList,
        sum_add_back: sumAddBack,
        sum_less:     sumLess,
        total:        ffo,
      },
      sources,
      applications,
      totals: {
        total_sources:        totalSources,
        total_applications:   totalApplications,
        // Sources excluding the balancing WC line — useful when the UI
        // wants to show what FFO + capital + sales drove on its own.
        total_sources_pre_wc:      totalSourcesPre,
        total_applications_pre_wc: totalAppsPre,
        net_change_in_wc:     netChangeWc,
        drift,
        balanced,
      },
      // Surface the balance components that drove the statement so a
      // user can audit any number against trial-balance source data.
      breakdown: {
        opening_fa: r2(openingFA), closing_fa: r2(closingFA), fa_change_at_cost: faChangeAtCost,
        opening_inv: r2(openingInv), closing_inv: r2(closingInv),
        opening_misc_exp: r2(openingMiscExp), closing_misc_exp: r2(closingMiscExp),
        opening_ltl: r2(openingLTL), closing_ltl: r2(closingLTL),
        opening_cap: r2(openingCap), closing_cap: r2(closingCap),
        depreciation_charge: depreciationCharge,
        amortization_charge: amortizationCharge,
      },
    });
  } catch (err) {
    console.error('fundFlow error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Fund Flow — Monthly Register ───────────────────────────────────────
//
// View 1 of the Tally-style three-level drill (parallel of Cash Flow's
// cashFlowMonthly). Returns one row per calendar month between
// from..to with:
//
//   month_iso     — ISO YYYY-MM-01 (used as drill key)
//   month_label   — "April 2026" (display)
//   opening_wc    — Working capital as of (month_start − 1 day)
//   closing_wc    — Working capital as of month_end (last day of month)
//   funds_flow    — closing_wc − opening_wc  (= net funds flow that month)
//
// Cumulative running totals — month N's opening_wc equals month N−1's
// closing_wc by construction. The Grand Total at the foot shows period-
// level opening_wc, closing_wc, and Σ funds_flow (which must equal
// closing_wc − opening_wc — the report's own internal check).
//
// Working capital = SUM(Current Asset balances) − SUM(Current Liability
// balances), with sign flipped for liabilities so we get a positive WC
// figure on a healthy balance sheet. Stock-in-Hand is included via the
// shared stockValueAt() helper (no dedicated ledger in this ERP).
exports.fundFlowMonthly = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);

    // ── Build the list of month boundaries ────────────────────────
    // generate_series in postgres to enumerate month-starts inside
    // [from, to]. For each, we compute opening (day-before month_start)
    // and closing (last day of month) WC values.
    const boundaries = await sequelize.query(
      `SELECT to_char(m.month_start, 'YYYY-MM-01') AS month_iso,
              m.month_start::text AS month_start,
              (m.month_start + interval '1 month' - interval '1 day')::date::text AS month_end
         FROM (
           SELECT generate_series(
             date_trunc('month', :from_date::date),
             date_trunc('month', :to_date::date),
             interval '1 month'
           )::date AS month_start
         ) m
        ORDER BY m.month_start`,
      { replacements: { from_date: from, to_date: to }, type: sequelize.QueryTypes.SELECT },
    );
    if (boundaries.length === 0) {
      return res.json({
        period: { from, to },
        rows: [],
        totals: { opening_wc: 0, closing_wc: 0, funds_flow: 0 },
      });
    }

    // ── WC ledger contribution per month-end ──────────────────────
    // For each month_end, compute Σ(CA balances at that date) −
    // Σ(CL balances at that date) over live (non-reversed) entries.
    //
    // Sign math: every entry's contribution is `(Dr − Cr)`. For a
    // current-asset ledger this is naturally positive (Dr-side bal).
    // For a current-liability ledger it's naturally negative (Cr-side
    // bal expressed as a Dr-Cr signed delta — Σ Cr exceeds Σ Dr, so
    // (Dr − Cr) is < 0). Therefore SUM(CA contribs) + SUM(CL contribs)
    // = Σ CA balances − Σ CL balances = Working Capital.
    //
    // The earlier draft of this code negated the CL contribution,
    // which double-flipped CL and produced CA + CL instead of CA − CL.
    // That bug shipped `Opening WC = -7,58,005` against a true
    // 91,40,712 — caught by the chain-coherence test below.
    //
    // FA / Investments / Misc.Exp(Asset) are EXCLUDED from CA. Long-term
    // liabilities (Loans, Bank OD, Secured/Unsecured Loans) excluded
    // from CL. Both lists mirror the JS-side classifiers above.
    const fixedExcl = [...FF_FIXED_ASSET_SUBS, ...FF_INVESTMENT_SUBS, ...FF_MISC_EXP_SUBS];
    const ltlExcl   = [...FF_LONG_TERM_LIAB_SUBS];

    // Single SQL using a correlated sub-query per month-end. PostgreSQL
    // executes the outer scan once and the sub-queries on indexed
    // entry_date — fast even on six-figure entry counts.
    const rows = await sequelize.query(
      `WITH bounds AS (
         SELECT to_char(m.month_start, 'YYYY-MM-01') AS month_iso,
                m.month_start AS month_start,
                (m.month_start + interval '1 month' - interval '1 day')::date AS month_end
           FROM (
             SELECT generate_series(
               date_trunc('month', :from_date::date),
               date_trunc('month', :to_date::date),
               interval '1 month'
             )::date AS month_start
           ) m
       ),
       wc_legs AS (
         SELECT le.entry_date,
                (le.debit_amount - le.credit_amount) AS contrib
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE le.reversal_of_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM ledger_entries m
               WHERE m.reversal_of_id = le.entry_id
            )
            AND la.is_active = true
            AND (
              (la.ledger_group = 'Assets'
                AND (la.sub_group IS NULL OR la.sub_group NOT IN (:fixed_excl)))
              OR
              (la.ledger_group = 'Liabilities'
                AND la.sub_group NOT IN (:ltl_excl))
            )
       )
       SELECT b.month_iso,
              b.month_start::text AS month_start,
              b.month_end::text   AS month_end,
              COALESCE((SELECT SUM(contrib) FROM wc_legs WHERE entry_date < b.month_start), 0)::float AS le_open,
              COALESCE((SELECT SUM(contrib) FROM wc_legs WHERE entry_date <= b.month_end),  0)::float AS le_close
         FROM bounds b
        ORDER BY b.month_start`,
      {
        replacements: { from_date: from, to_date: to, fixed_excl: fixedExcl, ltl_excl: ltlExcl },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // ── Stock-in-Hand contribution per month boundary ──────────────
    // No dedicated ledger; pulled from stock_ledger × current
    // purchase_rate via stockValueAt(). One call per month boundary —
    // for a year that's 13 calls; each is a single aggregate query.
    const stockOpenByMonth = new Map();
    const stockCloseByMonth = new Map();
    for (const r of rows) {
      // opening = day before month_start
      const d = new Date(r.month_start + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      const openingDate = d.toISOString().slice(0, 10);
      stockOpenByMonth.set(r.month_iso, await stockValueAt(openingDate));
      stockCloseByMonth.set(r.month_iso, await stockValueAt(r.month_end));
    }

    const out = rows.map((r) => {
      const stockOpen  = stockOpenByMonth.get(r.month_iso) || 0;
      const stockClose = stockCloseByMonth.get(r.month_iso) || 0;
      const openingWc  = r2(r.le_open  + stockOpen);
      const closingWc  = r2(r.le_close + stockClose);
      const fundsFlow  = r2(closingWc - openingWc);
      return {
        month_iso:   r.month_iso,
        month_label: _monthLabel(r.month_iso),
        opening_wc:  openingWc,
        closing_wc:  closingWc,
        funds_flow:  fundsFlow,
      };
    });

    // Period-level Grand Total — opening from FIRST row, closing from
    // LAST, sum of monthly funds_flow. The closing − opening must equal
    // Σ funds_flow (running totals tile cleanly); we surface both so a
    // UI banner can flag any drift.
    const first = out[0];
    const last  = out[out.length - 1];
    const sumFlows = r2(out.reduce((s, x) => s + x.funds_flow, 0));
    const totals = {
      opening_wc: first ? first.opening_wc : 0,
      closing_wc: last  ? last.closing_wc  : 0,
      funds_flow: sumFlows,
    };

    res.json({
      period: { from, to },
      rows: out,
      totals,
    });
  } catch (err) {
    console.error('fundFlowMonthly error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// Build one row of the WC schedule. Pure helper used twice (CA + CL).
//   side='asset'     → CA up = WC up
//   side='liability' → CL up = WC down
function buildScheduleRow(l, side) {
  const delta = r2(l.closing - l.opening);
  let inc = 0, dec = 0;
  if (side === 'asset') {
    if (delta > 0) inc = delta; else if (delta < 0) dec = -delta;
  } else {
    if (delta > 0) dec = delta; else if (delta < 0) inc = -delta;
  }
  return {
    ledger_id:    l.ledger_id,
    ledger_name:  l.ledger_name,
    sub_group:    l.sub_group,
    is_party_ledger: !!l.is_party_ledger,
    opening:      l.opening,
    closing:      l.closing,
    delta,
    increase_in_wc: r2(inc),
    decrease_in_wc: r2(dec),
  };
}
