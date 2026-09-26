// ── Top Parties Controller ─────────────────────────────────────────────
//
// Ranked league table of who you trade with most, over any date range.
//   customers → sales_bills    (who buys the most)
//   suppliers → purchase_bills (who you buy the most from)
//
// Answers the questions a ranking is actually used for: how big is each
// party, how often do they trade, when did they last transact, are they
// growing or shrinking, and how concentrated is the book on the top few.
//
// Three things worth knowing about the shape of this query:
//
// 1. Bill totals and line-item metrics are aggregated in SEPARATE CTEs
//    and joined on party_id. Joining bills → items and then summing the
//    bill's total_amount fans the total out once per line and inflates
//    it several-fold. Keep them apart.
//
// 2. Gross profit is computed ONLY over lines with a real cost
//    (`cost_rate > 0`) on both sides of the ratio. Lines imported
//    without a cost otherwise compute as 100% margin and silently
//    inflate the blended figure — on this book those lines reached 11%
//    of revenue in one year and made margin look ~9 points better than
//    it was. `costed_value` is returned alongside so the caller can see
//    how much of the party's revenue the margin actually covers.
//
// 3. The system Cash party (`is_system_cash`) is INCLUDED by default and
//    flagged, not silently dropped. On this book it carries 11,111 sales
//    bills (₹405L) of counter trade — excluding it would understate
//    total sales by most of the shop. It is not a party you can ring up
//    though, so `exclude_cash=1` drops it; the totals are then
//    recomputed without it so the percentages always agree with the
//    rows on screen.
//
// The comparison period is the same number of days immediately before
// `from`, so change % is like-for-like without the caller doing date
// math.

const ExcelJS = require('exceljs');
const sequelize = require('../config/database');
const { SystemSettings } = require('../models');
const { respondWithError } = require('../utils/helpers');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }

// Falls back to the financial-year start when the caller gives no
// range, matching the other operational reports.
async function resolvePeriod(query) {
  let from = query.from_date ? String(query.from_date).slice(0, 10) : null;
  let to   = query.to_date   ? String(query.to_date).slice(0, 10)   : null;
  if (!to) to = new Date().toISOString().slice(0, 10);
  if (!from) {
    const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
    from = settings && settings.financial_year_start
      ? String(settings.financial_year_start).slice(0, 10)
      : '1900-01-01';
  }
  return { from, to };
}

async function buildTopParties(query) {
  const direction = String(query.direction || 'customer').toLowerCase() === 'supplier'
    ? 'supplier' : 'customer';
  const isCustomer = direction === 'customer';

  // Whitelisted literals only — these are interpolated into SQL.
  const billTable = isCustomer ? 'sales_bills'      : 'purchase_bills';
  const itemTable = isCustomer ? 'sales_bill_items' : 'purchase_bill_items';
  const billIdCol = isCustomer ? 'sales_bill_id'    : 'purchase_bill_id';
  const partyCol  = isCustomer ? 'customer_id'      : 'supplier_id';

  const { from, to } = await resolvePeriod(query);

  // Comparison window: same length, immediately before `from`.
  const days = Math.max(
    1,
    Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1,
  );
  const prevTo = new Date(from + 'T00:00:00Z');
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
  const pTo   = prevTo.toISOString().slice(0, 10);
  const pFrom = prevFrom.toISOString().slice(0, 10);

  const search   = String(query.search || '').trim();
  const limit    = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 10000);
  const minValue = num(query.min_value);
  const sort     = String(query.sort || 'value_desc').toLowerCase();

  // Counter-cash handling — see note 3 in the header. Filtering in SQL
  // (rather than after aggregation) keeps the grand totals and the
  // concentration percentages consistent with the visible rows.
  const excludeCash = String(query.exclude_cash || '') === '1'
    || String(query.exclude_cash || '').toLowerCase() === 'true';
  const cashSql = excludeCash ? ' AND COALESCE(p.is_system_cash, false) = false ' : '';

  const replacements = { from, to, pFrom, pTo, today: to };
  const searchSql = search
    ? ' AND (p.party_name ILIKE :q OR p.display_name ILIKE :q OR p.mobile_1 ILIKE :q) '
    : '';
  if (search) replacements.q = `%${search}%`;

  // Gross profit only exists on the sales side — purchase items carry no
  // cost_rate. The purchase branch emits 0s so the row shape stays
  // identical either way and the frontend does not need two code paths.
  const gpSelect = isCustomer
    ? `SUM(i.taxable_amount) FILTER (WHERE i.cost_rate > 0)                  AS costed_value,
       SUM(i.quantity * i.cost_rate) FILTER (WHERE i.cost_rate > 0)          AS cogs,
       SUM(i.total_amount) FILTER (WHERE COALESCE(i.cost_rate,0) = 0)        AS uncosted_value,`
    : `0::numeric AS costed_value, 0::numeric AS cogs, 0::numeric AS uncosted_value,`;

  const rows = await sequelize.query(
    `WITH cur AS (
       SELECT ${partyCol} AS party_id,
              COUNT(*)::int     AS bills,
              SUM(total_amount) AS value,
              MIN(bill_date)    AS first_bill,
              MAX(bill_date)    AS last_bill
         FROM ${billTable}
        WHERE is_cancelled = false
          AND ${partyCol} IS NOT NULL
          AND bill_date BETWEEN :from AND :to
        GROUP BY 1
     ),
     prev AS (
       SELECT ${partyCol} AS party_id, SUM(total_amount) AS value
         FROM ${billTable}
        WHERE is_cancelled = false
          AND ${partyCol} IS NOT NULL
          AND bill_date BETWEEN :pFrom AND :pTo
        GROUP BY 1
     ),
     items AS (
       SELECT b.${partyCol} AS party_id,
              ${gpSelect}
              COUNT(DISTINCT i.product_id) AS styles,
              SUM(i.quantity)              AS units
         FROM ${billTable} b
         JOIN ${itemTable} i ON i.${billIdCol} = b.${billIdCol}
        WHERE b.is_cancelled = false
          AND b.${partyCol} IS NOT NULL
          AND b.bill_date BETWEEN :from AND :to
        GROUP BY 1
     )
     SELECT c.party_id,
            c.bills,
            c.value,
            c.first_bill,
            c.last_bill,
            (:today::date - c.last_bill) AS days_since,
            COALESCE(pr.value, 0)        AS prev_value,
            COALESCE(it.styles, 0)       AS styles,
            COALESCE(it.units, 0)        AS units,
            COALESCE(it.costed_value, 0) AS costed_value,
            COALESCE(it.cogs, 0)         AS cogs,
            COALESCE(it.uncosted_value,0) AS uncosted_value,
            p.party_name,
            p.display_name,
            p.party_type,
            p.mobile_1,
            p.city,
            p.gstin,
            p.current_balance,
            COALESCE(p.is_system_cash, false) AS is_cash_counter
       FROM cur c
       LEFT JOIN prev  pr ON pr.party_id = c.party_id
       LEFT JOIN items it ON it.party_id = c.party_id
       JOIN parties p ON p.party_id = c.party_id
      WHERE 1 = 1
        ${cashSql}
        ${searchSql}`,
    { replacements, type: sequelize.QueryTypes.SELECT },
  );

  // Grand totals come from the FULL set, before any top-N cut, so the
  // concentration percentages mean "share of the whole book" rather
  // than "share of what is displayed".
  const grandValue = rows.reduce((s, r) => s + num(r.value), 0);
  const grandBills = rows.reduce((s, r) => s + num(r.bills), 0);
  const grandPrev  = rows.reduce((s, r) => s + num(r.prev_value), 0);
  const grandCosted = rows.reduce((s, r) => s + num(r.costed_value), 0);
  const grandCogs   = rows.reduce((s, r) => s + num(r.cogs), 0);
  const grandUncosted = rows.reduce((s, r) => s + num(r.uncosted_value), 0);

  let enriched = rows.map((r) => {
    const value  = num(r.value);
    const costed = num(r.costed_value);
    const cogs   = num(r.cogs);
    const gp     = costed - cogs;
    const prev   = num(r.prev_value);
    return {
      party_id:        r.party_id,
      party_name:      r.display_name || r.party_name,
      party_type:      r.party_type,
      mobile_1:        r.mobile_1 || null,
      city:            r.city || null,
      gstin:           r.gstin || null,
      bills:           num(r.bills),
      value:           r2(value),
      avg_bill:        num(r.bills) ? r2(value / num(r.bills)) : 0,
      pct_of_total:    grandValue ? r2(100 * value / grandValue) : 0,
      first_bill:      r.first_bill,
      last_bill:       r.last_bill,
      days_since:      Math.max(0, num(r.days_since)),
      styles:          num(r.styles),
      units:           r2(r.units),
      // Null rather than 0 on the purchase side, so the UI can render a
      // dash instead of implying a real zero margin.
      gross_profit:    isCustomer ? r2(gp) : null,
      margin_pct:      isCustomer && costed ? r2(100 * gp / costed) : null,
      costed_value:    isCustomer ? r2(costed) : null,
      uncosted_value:  isCustomer ? r2(r.uncosted_value) : null,
      prev_value:      r2(prev),
      change_pct:      prev ? r2(100 * (value - prev) / prev) : null,
      current_balance: r2(r.current_balance),
      // Marks the built-in counter-cash aggregate so the UI can label
      // it rather than presenting it as a nameable customer.
      is_cash_counter: !!r.is_cash_counter,
    };
  });

  if (minValue > 0) enriched = enriched.filter((r) => r.value >= minValue);

  const sorters = {
    value_desc:  (a, b) => b.value - a.value,
    value_asc:   (a, b) => a.value - b.value,
    bills_desc:  (a, b) => b.bills - a.bills,
    gp_desc:     (a, b) => num(b.gross_profit) - num(a.gross_profit),
    margin_desc: (a, b) => num(b.margin_pct) - num(a.margin_pct),
    growth_desc: (a, b) => num(b.change_pct) - num(a.change_pct),
    growth_asc:  (a, b) => num(a.change_pct) - num(b.change_pct),
    recent_desc: (a, b) => a.days_since - b.days_since,
    stale_desc:  (a, b) => b.days_since - a.days_since,
    styles_desc: (a, b) => b.styles - a.styles,
    name_asc:    (a, b) => (a.party_name || '').localeCompare(b.party_name || ''),
  };
  enriched.sort(sorters[sort] || sorters.value_desc);

  // Concentration is always measured on the value ranking, regardless
  // of how the user has chosen to sort the table.
  const byValue = [...enriched].sort((a, b) => b.value - a.value);
  const headSum = (n) => byValue.slice(0, n).reduce((s, r) => s + r.value, 0);
  const pctOf = (v) => (grandValue ? r2(100 * v / grandValue) : 0);

  const paged = enriched.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));

  const grandGp = grandCosted - grandCogs;

  return {
    direction,
    period:      { from, to, days },
    prev_period: { from: pFrom, to: pTo },
    exclude_cash: excludeCash,
    totals: {
      value:        r2(grandValue),
      bills:        grandBills,
      parties:      enriched.length,
      avg_bill:     grandBills ? r2(grandValue / grandBills) : 0,
      prev_value:   r2(grandPrev),
      change_pct:   grandPrev ? r2(100 * (grandValue - grandPrev) / grandPrev) : null,
      gross_profit: isCustomer ? r2(grandGp) : null,
      margin_pct:   isCustomer && grandCosted ? r2(100 * grandGp / grandCosted) : null,
      // How much revenue the margin figure actually covers. When this
      // is well below `value`, the margin is computed on a subset and
      // should be read with that in mind.
      costed_value:   isCustomer ? r2(grandCosted) : null,
      uncosted_value: isCustomer ? r2(grandUncosted) : null,
      top3_value:   r2(headSum(3)),
      top5_value:   r2(headSum(5)),
      top10_value:  r2(headSum(10)),
      top3_pct:     pctOf(headSum(3)),
      top5_pct:     pctOf(headSum(5)),
      top10_pct:    pctOf(headSum(10)),
    },
    filtered_count: enriched.length,
    rows: paged,
  };
}

exports.topParties = async (req, res) => {
  try {
    res.json(await buildTopParties(req.query || {}));
  } catch (err) {
    console.error('topParties error:', err);
    respondWithError(res, err);
  }
};

// ── XLSX export ───────────────────────────────────────────────────────
// Same builder, same params — including the Top-N the user picked. If
// the screen says Top 10, the sheet is the same ten rows; "All" in the
// picker is what widens it. The grand totals and the concentration
// footer are always computed over the whole party set regardless, so
// the sheet still answers "share of the whole book".
exports.exportTopParties = async (req, res) => {
  try {
    const result = await buildTopParties(req.query || {});
    const isCustomer = result.direction === 'customer';
    const label = isCustomer ? 'Customer' : 'Supplier';

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(isCustomer ? 'Top Customers' : 'Top Suppliers');

    const cols = [
      { header: '#',                 key: 'rank',         width: 6 },
      { header: label,               key: 'party_name',   width: 30 },
      { header: 'Mobile',            key: 'mobile_1',     width: 15 },
      { header: 'City',              key: 'city',         width: 15 },
      { header: isCustomer ? 'Sales' : 'Purchases', key: 'value', width: 15 },
      { header: '% of Total',        key: 'pct_of_total', width: 11 },
      { header: 'Bills',             key: 'bills',        width: 8 },
      { header: 'Avg Bill',          key: 'avg_bill',     width: 13 },
      { header: 'Styles',            key: 'styles',       width: 9 },
      { header: 'Units',             key: 'units',        width: 11 },
    ];
    if (isCustomer) {
      cols.push(
        { header: 'Gross Profit', key: 'gross_profit', width: 14 },
        { header: 'Margin %',     key: 'margin_pct',   width: 10 },
      );
    }
    cols.push(
      { header: 'Prev Period',   key: 'prev_value', width: 14 },
      { header: 'Change %',      key: 'change_pct', width: 11 },
      { header: 'First Bill',    key: 'first_bill', width: 12 },
      { header: 'Last Bill',     key: 'last_bill',  width: 12 },
      { header: 'Days Since',    key: 'days_since', width: 11 },
      { header: 'Balance',       key: 'current_balance', width: 14 },
      { header: 'GSTIN',         key: 'gstin',      width: 18 },
    );
    ws.columns = cols;
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const r of result.rows) ws.addRow(r);

    const t = result.totals;
    const tot = ws.addRow({
      party_name:   `TOTAL (${result.rows.length} of ${t.parties})`,
      value:        t.value,
      bills:        t.bills,
      avg_bill:     t.avg_bill,
      gross_profit: t.gross_profit,
      margin_pct:   t.margin_pct,
      prev_value:   t.prev_value,
      change_pct:   t.change_pct,
    });
    tot.font = { bold: true };
    tot.border = { top: { style: 'medium' } };

    // Concentration footer — the "top 10 did X% of the book" line that
    // the ranking exists to answer.
    ws.addRow({});
    ws.addRow({ party_name: 'Period',        mobile_1: `${result.period.from} to ${result.period.to}` });
    ws.addRow({ party_name: 'Compared with', mobile_1: `${result.prev_period.from} to ${result.prev_period.to}` });
    ws.addRow({ party_name: 'Top 3 share',   mobile_1: `${t.top3_pct}%`,  city: t.top3_value });
    ws.addRow({ party_name: 'Top 5 share',   mobile_1: `${t.top5_pct}%`,  city: t.top5_value });
    ws.addRow({ party_name: 'Top 10 share',  mobile_1: `${t.top10_pct}%`, city: t.top10_value });
    ws.addRow({
      party_name: 'Counter cash',
      mobile_1:   result.exclude_cash ? 'EXCLUDED from these figures' : 'included in these figures',
    });
    if (isCustomer && t.uncosted_value > 0) {
      // Without this the margin column looks authoritative on revenue it
      // never covered.
      ws.addRow({
        party_name: 'Margin basis',
        mobile_1:   `computed on ${t.costed_value} of ${t.value}`,
        city:       `${t.uncosted_value} had no recorded cost`,
      });
    }

    const fname = `top_${isCustomer ? 'customers' : 'suppliers'}_${result.period.from}_to_${result.period.to}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('exportTopParties error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
};
