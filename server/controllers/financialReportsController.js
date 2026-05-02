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

// Stock-in-Hand value as of a date.
//   For each product:
//     · qty = sum of stock_ledger movements (quantity_in − quantity_out)
//             with transaction_date ≤ as_of
//     · if there are NO movements at or before as_of, fall back to
//       products.opening_stock — handles two real cases:
//         1. products created via paths that don't post to stock_ledger
//            (test fixtures, manual SQL backfills); their opening
//            balance still needs to be reflected
//         2. as_of dates BEFORE the product's first movement; the
//            opening stock IS its as-of value at those dates
//     · value = qty × current purchase_rate
// Sum across all products. Same formula serves Balance Sheet (as-of
// stock value) and Profit & Loss (Opening + Closing Stock). Sharing
// this helper is what makes invariant I6 hold paisa-exactly across
// reports and across periods.
async function stockValueAt(asOfDate) {
  const [row] = await sequelize.query(
    `WITH movements AS (
       SELECT product_id,
              SUM(COALESCE(quantity_in, 0) - COALESCE(quantity_out, 0)) AS qty
         FROM stock_ledger
        WHERE transaction_date <= :as_of
        GROUP BY product_id
     )
     SELECT COALESCE(SUM(
       CASE
         -- Stock-ledger has movements at or before as_of: trust them.
         WHEN m.qty IS NOT NULL THEN m.qty * p.purchase_rate
         -- No movements but the product's opening_stock_date is at/
         -- before as_of: use products.opening_stock as the effective
         -- value (catches products created via paths that bypass
         -- stock_ledger, like the seeder & test fixtures).
         WHEN p.opening_stock_date IS NOT NULL
              AND p.opening_stock_date <= :as_of
              THEN COALESCE(p.opening_stock, 0) * p.purchase_rate
         -- For products with no opening_stock_date column populated,
         -- treat them as if their opening was at "epoch" — only
         -- contributes when as_of is also a real ledger date.
         WHEN p.opening_stock_date IS NULL
              AND :as_of >= '2000-01-01'
              THEN COALESCE(p.opening_stock, 0) * p.purchase_rate
         ELSE 0
       END
     ), 0)::float AS v
       FROM products p
       LEFT JOIN movements m ON m.product_id = p.product_id
      WHERE p.is_active = true`,
    { replacements: { as_of: asOfDate }, type: sequelize.QueryTypes.SELECT },
  );
  return r2(row.v);
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
