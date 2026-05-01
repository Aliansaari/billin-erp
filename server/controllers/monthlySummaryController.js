// ── Monthly Summary Controller (R10) ──────────────────────────────────
//
//   GET /api/reports/monthly-summary?mode=sales|purchase|combined
//
// One controller, three modes. The frontend has three thin wrapper
// components that render the same shared layout parameterized by side.
//
// Query params:
//   mode         'sales' | 'purchase' | 'combined'   (default: 'sales')
//   from_date    YYYY-MM-DD            default: current FY start
//   to_date      YYYY-MM-DD            default: today
//   party_ids    int[]                 multi-select customer/supplier
//                                      (sales mode → customers,
//                                       purchase → suppliers,
//                                       combined → both sides each
//                                       filter independently — pass
//                                       customer_ids+supplier_ids
//                                       instead, see below)
//   customer_ids int[]                 combined mode — sales side party
//   supplier_ids int[]                 combined mode — purchase side
//   min_net      number                drop months below this Net
//   max_net      number                drop months above this Net
//   gst_rates    number[]              future filter — currently a no-op
//                                      since per-rate breakdown isn't
//                                      stored on the bill header
//   include_zero 'true'|'false'        include empty months (default true)
//
// Response shape (varies by mode):
//   mode=sales/purchase:
//     {
//       mode,
//       from_date, to_date,
//       data: [{
//         month_iso       e.g. '2025-04-01'
//         month_label     e.g. 'Apr 2025'
//         bills_count, returns_count
//         gross           SUM(sub_total) on bills
//         returns         SUM(sub_total) on returns
//         net             gross − returns − discount net + freight + other
//                          (matches Sales Report's "register_net_to_ledger")
//         tax             SUM(cgst+sgst+igst) on bills − same on returns
//         total_invoiced  SUM(total_amount) on bills − returns
//         avg_bill_value  net / bills_count, null if 0
//       }],
//       summary: { total_bills, total_returns_count, total_gross,
//                  total_returns, total_net, total_tax,
//                  total_invoiced, avg_monthly_net, avg_bill_value },
//       kpis:    { best_month: {month, net}, worst_month, returns_pct,
//                  months_in_view },
//       reconciliation: { ledger_name, ledger_net, register_net,
//                         difference, balanced },
//       filter_meta: { parties: [{id, name}], gst_rates: [] },
//     }
//
//   mode=combined:
//     same but each row carries both sales_* and purchase_* columns
//     plus margin = sales_net − purchase_net and margin_pct.
//     summary + kpis include both sides + margin metrics.

const sequelize = require('../config/database');
const { SystemSettings } = require('../models');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Local YYYY-MM-DD in server tz — same idiom as billsOutstandingController.
function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Default period = current FY. Falls back to a 12-month rolling window
// if no FY start is configured (rare; new install before settings).
async function defaultPeriod() {
  const s = await SystemSettings.findOne({ where: { setting_id: 1 } });
  if (s && s.financial_year_start) {
    return {
      from_date: String(s.financial_year_start).slice(0, 10),
      to_date:   localDateString(),
    };
  }
  const today = new Date();
  const yearAgo = new Date(today.getFullYear() - 1, today.getMonth(), 1);
  return {
    from_date: localDateString(yearAgo),
    to_date:   localDateString(today),
  };
}

function toIntArr(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((s) => parseInt(s, 10)).filter(Number.isFinite);
}

// ── Per-side SQL ──────────────────────────────────────────────────────
//
// One LATERAL-style query: month_series LEFT JOIN bill_aggs LEFT JOIN
// return_aggs. Returns one row per month in [from, to]. Empty months
// come through as zeros (keeps the Net trend line continuous; users
// can hide via include_zero=false if they want).
//
// `net` is the post-discount + freight + other base — matches
// reportController's reconciliation formula so the Sales/Purchase
// ledger reconciles to SUM(net) over the same period.
async function _sideQuery({ side, from, to, partyIds }) {
  const isSales = side === 'sales';
  const billTable    = isSales ? 'sales_bills'        : 'purchase_bills';
  const returnTable  = isSales ? 'sales_return_bills' : 'purchase_return_bills';
  const partyFK      = isSales ? 'customer_id'        : 'supplier_id';

  const billsWhere   = ['is_cancelled = false', 'bill_date >= :from', 'bill_date <= :to'];
  const returnsWhere = ['is_cancelled = false', 'return_date >= :from', 'return_date <= :to'];
  const params       = { from, to };

  if (partyIds.length > 0) {
    billsWhere.push(`${partyFK} IN (:partyIds)`);
    returnsWhere.push(`${partyFK} IN (:partyIds)`);
    params.partyIds = partyIds;
  }

  const sql = `
    WITH month_series AS (
      SELECT generate_series(
        DATE_TRUNC('month', :from::date),
        DATE_TRUNC('month', :to::date),
        INTERVAL '1 month'
      )::date AS month_start
    ),
    bills AS (
      SELECT DATE_TRUNC('month', bill_date)::date AS m,
             COUNT(*)::int                                AS cnt,
             COALESCE(SUM(sub_total),       0)::float     AS gross,
             COALESCE(SUM(discount_amount), 0)::float     AS discount,
             COALESCE(SUM(freight_charges), 0)::float     AS freight,
             COALESCE(SUM(other_charges),   0)::float     AS other,
             COALESCE(SUM(cgst_amount + sgst_amount + igst_amount), 0)::float AS tax,
             COALESCE(SUM(total_amount),    0)::float     AS total
        FROM ${billTable}
       WHERE ${billsWhere.join(' AND ')}
       GROUP BY DATE_TRUNC('month', bill_date)
    ),
    rets AS (
      SELECT DATE_TRUNC('month', return_date)::date AS m,
             COUNT(*)::int                                AS cnt,
             COALESCE(SUM(sub_total),       0)::float     AS gross,
             COALESCE(SUM(discount_amount), 0)::float     AS discount,
             COALESCE(SUM(freight_charges), 0)::float     AS freight,
             COALESCE(SUM(other_charges),   0)::float     AS other,
             COALESCE(SUM(cgst_amount + sgst_amount + igst_amount), 0)::float AS tax,
             COALESCE(SUM(total_amount),    0)::float     AS total
        FROM ${returnTable}
       WHERE ${returnsWhere.join(' AND ')}
       GROUP BY DATE_TRUNC('month', return_date)
    )
    SELECT TO_CHAR(ms.month_start, 'YYYY-MM-DD')                 AS month_iso,
           TO_CHAR(ms.month_start, 'Mon YYYY')                   AS month_label,
           COALESCE(b.cnt, 0)                                    AS bills_count,
           COALESCE(r.cnt, 0)                                    AS returns_count,
           COALESCE(b.gross, 0)::float                           AS gross,
           COALESCE(r.gross, 0)::float                           AS returns,
           (COALESCE(b.gross, 0) - COALESCE(b.discount, 0)
            + COALESCE(b.freight, 0) + COALESCE(b.other, 0)
            - (COALESCE(r.gross, 0) - COALESCE(r.discount, 0)
               + COALESCE(r.freight, 0) + COALESCE(r.other, 0)))::float AS net,
           (COALESCE(b.tax, 0) - COALESCE(r.tax, 0))::float      AS tax,
           (COALESCE(b.total, 0) - COALESCE(r.total, 0))::float  AS total_invoiced
      FROM month_series ms
      LEFT JOIN bills b ON b.m = ms.month_start
      LEFT JOIN rets  r ON r.m = ms.month_start
     ORDER BY ms.month_start ASC
  `;
  const rows = await sequelize.query(sql, { replacements: params, type: sequelize.QueryTypes.SELECT });
  return rows.map((row) => ({
    month_iso:      row.month_iso,
    month_label:    row.month_label,
    bills_count:    Number(row.bills_count) || 0,
    returns_count:  Number(row.returns_count) || 0,
    gross:          r2(row.gross),
    returns:        r2(row.returns),
    net:            r2(row.net),
    tax:            r2(row.tax),
    total_invoiced: r2(row.total_invoiced),
    avg_bill_value: row.bills_count > 0 ? r2(row.net / row.bills_count) : null,
  }));
}

// ── Reconciliation against the Sales / Purchase Account ledger ───────
//
// Same formula as reportController._sales/_purchase reconciliation but
// run as a single SUM over the period. The monthly-summary banner just
// surfaces the period total mismatch — clicking "View reconciliation →"
// opens the existing detailed Sales/Purchase Report which already has
// the full breakdown.
async function _periodReconciliation({ side, from, to, partyIds }) {
  const isSales = side === 'sales';
  const billTable   = isSales ? 'sales_bills'    : 'purchase_bills';
  const partyFK     = isSales ? 'customer_id'     : 'supplier_id';
  const ledgerName  = isSales ? 'Sales Account'   : 'Purchase Account';
  // Sales credits the Sales Account; Purchase debits the Purchase Account.
  // Ledger net for the period reads the same direction.
  //
  // Returns post to a SEPARATE ledger ('Sales Returns' / 'Purchase
  // Returns'), not to the main Sales/Purchase Account, so we DON'T
  // subtract them from the register side here. The on-screen Net column
  // does subtract returns (that's the user-facing convention) but the
  // recon banner ties out the bills-only register to the bills-only
  // ledger — matches reportController.salesReport's recon exactly.
  const billWhere = ['is_cancelled = false', 'bill_date >= :from', 'bill_date <= :to'];
  const params = { from, to };
  if (partyIds.length > 0) {
    billWhere.push(`${partyFK} IN (:partyIds)`);
    params.partyIds = partyIds;
  }

  const [bSum] = await sequelize.query(
    `SELECT COALESCE(SUM(sub_total - discount_amount + freight_charges + other_charges), 0)::float AS net
       FROM ${billTable} WHERE ${billWhere.join(' AND ')}`,
    { replacements: params, type: sequelize.QueryTypes.SELECT },
  );
  const registerNet = r2(bSum.net);

  // Ledger net for the period — Sales Account (Cr − Dr) for sales,
  // Purchase Account (Dr − Cr) for purchase. Filtering by party_ids
  // doesn't apply at the ledger level (sales account isn't keyed by
  // customer); when the user has narrowed by party the recon is
  // intentionally informational only — banner says "filtered view, full
  // reconciliation in detail report" rather than firing a drift alert.
  const partyFiltered = partyIds.length > 0;

  let ledgerNet = null;
  if (!partyFiltered) {
    const [le] = await sequelize.query(
      `SELECT COALESCE(SUM(le.debit_amount), 0)::float  AS dr,
              COALESCE(SUM(le.credit_amount), 0)::float AS cr
         FROM ledger_entries le
         JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
        WHERE la.ledger_name = :name
          AND le.entry_date >= :from AND le.entry_date <= :to
          AND le.reversal_of_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)`,
      { replacements: { name: ledgerName, from, to }, type: sequelize.QueryTypes.SELECT },
    );
    ledgerNet = isSales ? r2(le.cr - le.dr) : r2(le.dr - le.cr);
  }
  const difference = ledgerNet == null ? null : r2(ledgerNet - registerNet);
  return {
    ledger_name:  ledgerName,
    register_net: registerNet,
    ledger_net:   ledgerNet,
    difference,
    balanced:     ledgerNet != null && Math.abs(difference) < 0.01,
    party_filtered: partyFiltered, // UI suppresses the drift alert in this case
  };
}

// ── KPI helpers ───────────────────────────────────────────────────────
function _summarize(rows) {
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const totalBills = rows.reduce((s, r) => s + r.bills_count, 0);
  const totalRetCount = rows.reduce((s, r) => s + r.returns_count, 0);
  const totalNet = r2(sum('net'));
  const totalGross = r2(sum('gross'));
  const totalReturns = r2(sum('returns'));
  const monthsInView = rows.length;
  return {
    total_bills:           totalBills,
    total_returns_count:   totalRetCount,
    total_gross:           totalGross,
    total_returns:         totalReturns,
    total_net:             totalNet,
    total_tax:             r2(sum('tax')),
    total_invoiced:        r2(sum('total_invoiced')),
    avg_monthly_net:       monthsInView > 0 ? r2(totalNet / monthsInView) : 0,
    avg_bill_value:        totalBills > 0 ? r2(totalNet / totalBills) : null,
  };
}

function _kpis(rows, summary) {
  // Best/worst by Net. Skip empty months when picking — a zero-month
  // tying with a real one shouldn't claim "Worst Month".
  const nonZero = rows.filter((r) => r.bills_count > 0);
  const monthsInView = rows.length;
  let best = null, worst = null;
  if (nonZero.length > 0) {
    best  = nonZero.reduce((b, r) => (r.net > b.net ? r : b), nonZero[0]);
    worst = nonZero.reduce((w, r) => (r.net < w.net ? r : w), nonZero[0]);
  }
  const returnsPct = summary.total_gross > 0
    ? r2((summary.total_returns / summary.total_gross) * 100)
    : null;
  return {
    months_in_view:  monthsInView,
    best_month:      best  ? { month_label: best.month_label,  month_iso: best.month_iso,  net: best.net }  : null,
    worst_month:     worst ? { month_label: worst.month_label, month_iso: worst.month_iso, net: worst.net } : null,
    returns_pct:     returnsPct,
  };
}

// Distinct parties for the multi-select filter chip list. Pulled from
// the PERIOD's bills/returns so the dropdown only shows parties
// actually relevant to the visible window — same UX pattern as the
// city/state filter chips on Bills Outstanding.
async function _filterParties({ side, from, to }) {
  const isSales = side === 'sales';
  const billTable = isSales ? 'sales_bills'    : 'purchase_bills';
  const partyFK   = isSales ? 'customer_id'    : 'supplier_id';
  const rows = await sequelize.query(
    `SELECT DISTINCT p.party_id AS id, p.party_name AS name
       FROM ${billTable} b
       JOIN parties p ON p.party_id = b.${partyFK}
      WHERE b.is_cancelled = false
        AND b.${partyFK} IS NOT NULL
        AND b.bill_date >= :from AND b.bill_date <= :to
      ORDER BY p.party_name ASC`,
    { replacements: { from, to }, type: sequelize.QueryTypes.SELECT },
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

// ── HTTP handler ──────────────────────────────────────────────────────
exports.monthlySummary = async (req, res) => {
  try {
    const q = req.query || {};
    const mode = ['sales', 'purchase', 'combined'].includes(q.mode) ? q.mode : 'sales';

    // Period defaults — current FY for the no-args call.
    const defaults = await defaultPeriod();
    const from_date = (q.from_date && /^\d{4}-\d{2}-\d{2}$/.test(q.from_date)) ? q.from_date : defaults.from_date;
    const to_date   = (q.to_date   && /^\d{4}-\d{2}-\d{2}$/.test(q.to_date))   ? q.to_date   : defaults.to_date;

    // Party filters — combined mode keeps customer + supplier separate.
    const customerIds = mode === 'combined' ? toIntArr(q.customer_ids) : (mode === 'sales'    ? toIntArr(q.party_ids) : []);
    const supplierIds = mode === 'combined' ? toIntArr(q.supplier_ids) : (mode === 'purchase' ? toIntArr(q.party_ids) : []);

    // Net-range + zero-month filters apply on the merged result so the
    // sql stays simple (handful-of-rows; no perf concern).
    const minNet = q.min_net != null && q.min_net !== '' ? Number(q.min_net) : null;
    const maxNet = q.max_net != null && q.max_net !== '' ? Number(q.max_net) : null;
    const includeZero = q.include_zero === 'false' ? false : true;

    let payload;
    if (mode === 'sales' || mode === 'purchase') {
      const partyIds = mode === 'sales' ? customerIds : supplierIds;
      let rows = await _sideQuery({ side: mode, from: from_date, to: to_date, partyIds });
      // Apply post-aggregate filters (zero / min / max Net).
      rows = rows.filter((r) => {
        if (!includeZero && r.bills_count === 0 && r.returns_count === 0) return false;
        if (minNet != null && r.net < minNet) return false;
        if (maxNet != null && r.net > maxNet) return false;
        return true;
      });
      const summary = _summarize(rows);
      const kpis    = _kpis(rows, summary);
      const reconciliation = await _periodReconciliation({ side: mode, from: from_date, to: to_date, partyIds });
      const filterParties  = await _filterParties({ side: mode, from: from_date, to: to_date });
      payload = {
        mode, from_date, to_date,
        data: rows,
        summary, kpis, reconciliation,
        filter_meta: { parties: filterParties },
      };
    } else {
      // mode === 'combined'
      const [salesRows, purRows, salesRecon, purRecon, salesParties, purParties] = await Promise.all([
        _sideQuery({ side: 'sales',    from: from_date, to: to_date, partyIds: customerIds }),
        _sideQuery({ side: 'purchase', from: from_date, to: to_date, partyIds: supplierIds }),
        _periodReconciliation({ side: 'sales',    from: from_date, to: to_date, partyIds: customerIds }),
        _periodReconciliation({ side: 'purchase', from: from_date, to: to_date, partyIds: supplierIds }),
        _filterParties({ side: 'sales',    from: from_date, to: to_date }),
        _filterParties({ side: 'purchase', from: from_date, to: to_date }),
      ]);
      // Merge by month_iso. Both sides have identical month_series so
      // the lengths match — but we left-join in case a future variant
      // skews them.
      const byMonth = new Map();
      for (const r of salesRows) byMonth.set(r.month_iso, { ...r, sales: r });
      for (const r of purRows) {
        const existing = byMonth.get(r.month_iso) || { month_iso: r.month_iso, month_label: r.month_label };
        existing.purchase = r;
        byMonth.set(r.month_iso, existing);
      }
      let merged = [...byMonth.values()].sort((a, b) => a.month_iso.localeCompare(b.month_iso));
      // Flatten + add margin.
      let combined = merged.map((m) => {
        const sales    = m.sales    || { bills_count: 0, returns_count: 0, gross: 0, returns: 0, net: 0, tax: 0, total_invoiced: 0, avg_bill_value: null };
        const purchase = m.purchase || { bills_count: 0, returns_count: 0, gross: 0, returns: 0, net: 0, tax: 0, total_invoiced: 0, avg_bill_value: null };
        const margin = r2(sales.net - purchase.net);
        const marginPct = sales.net > 0 ? r2((margin / sales.net) * 100) : null;
        return {
          month_iso:    m.month_iso,
          month_label:  m.month_label,
          sales_bills_count:    sales.bills_count,
          sales_net:            sales.net,
          sales_total_invoiced: sales.total_invoiced,
          purchase_bills_count: purchase.bills_count,
          purchase_net:         purchase.net,
          purchase_total_invoiced: purchase.total_invoiced,
          margin,
          margin_pct: marginPct,
        };
      });
      // Apply post-aggregate filters — for combined, "Net" filter
      // applies to the larger of sales/purchase (so dropping months by
      // either zero side requires both to be empty).
      combined = combined.filter((r) => {
        if (!includeZero && r.sales_bills_count === 0 && r.purchase_bills_count === 0) return false;
        if (minNet != null && Math.max(r.sales_net, r.purchase_net) < minNet) return false;
        if (maxNet != null && Math.max(r.sales_net, r.purchase_net) > maxNet) return false;
        return true;
      });
      const totalSalesNet     = r2(combined.reduce((s, r) => s + r.sales_net, 0));
      const totalPurchaseNet  = r2(combined.reduce((s, r) => s + r.purchase_net, 0));
      const totalMargin       = r2(totalSalesNet - totalPurchaseNet);
      const monthsCashNeg     = combined.filter((r) => r.purchase_net > r.sales_net).length;
      const monthsInView      = combined.length;
      const bestMargin = combined.reduce((b, r) => !b || r.margin > b.margin ? r : b, null);
      payload = {
        mode, from_date, to_date,
        data: combined,
        summary: {
          total_sales_net:    totalSalesNet,
          total_purchase_net: totalPurchaseNet,
          total_margin:       totalMargin,
          total_sales_bills:    combined.reduce((s, r) => s + r.sales_bills_count, 0),
          total_purchase_bills: combined.reduce((s, r) => s + r.purchase_bills_count, 0),
        },
        kpis: {
          months_in_view:       monthsInView,
          avg_monthly_margin:   monthsInView > 0 ? r2(totalMargin / monthsInView) : 0,
          best_margin_month:    bestMargin ? { month_label: bestMargin.month_label, month_iso: bestMargin.month_iso, margin: bestMargin.margin } : null,
          months_cash_negative: monthsCashNeg,
        },
        reconciliation: { sales: salesRecon, purchase: purRecon },
        filter_meta: { customers: salesParties, suppliers: purParties },
      };
    }

    res.json(payload);
  } catch (err) {
    console.error('monthlySummary error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
