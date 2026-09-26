// ── Party Lapse Controller ─────────────────────────────────────────────
//
// "Who stopped trading with us?" — one row per party that used to buy
// from us (customers) or supply us (suppliers), bucketed by how long
// they have been quiet.
//
// Why this exists:
//   Outstanding reports answer "who owes money". Aging answers "how old
//   is the debt". Neither answers the question that precedes both — a
//   supplier who stopped sending goods, or a customer who stopped
//   walking in, shows up in NO existing report until the damage is
//   already in the sales figures. A party can fall from top-10 to zero
//   across one season and nothing surfaces it.
//
// Source of truth:
//   • Suppliers  → purchase_bills (supplier_id)
//   • Customers  → sales_bills    (customer_id)
//   Cancelled bills are excluded. Trading history drives the buckets;
//   parties.current_balance is carried through only as context — it is
//   the party-level truth and is never re-derived by summing bill
//   balances.
//
// Buckets are days since the party's LAST bill:
//   active   ≤ 90d     still trading
//   slipping 91-180d   gone quiet, usually still recoverable
//   lapsed   181-365d  stopped, needs a call
//   lost     > 365d    gone for a full year
//
// `depth` classifies the relationship by bills-per-year over the
// lookback window. It matters because shallow relationships do not
// survive: on this book, suppliers billing 12+/yr retained ~79%
// year-over-year while one-off suppliers retained ~16%. A lapsed DEEP
// party is a far bigger loss than a lapsed one-off, and the two should
// never sit undifferentiated in the same list.

const ExcelJS = require('exceljs');
const sequelize = require('../config/database');
const { respondWithError } = require('../utils/helpers');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }

// Bucket thresholds in days-quiet, ordered so the first match wins.
const BUCKETS = [
  { key: 'active',   maxDays: 90 },
  { key: 'slipping', maxDays: 180 },
  { key: 'lapsed',   maxDays: 365 },
  { key: 'lost',     maxDays: Infinity },
];

// Human labels for the XLSX — the sheet is read away from the app, so
// raw keys like `one_off` / `slipping` would need decoding on paper.
const BUCKET_LABELS = {
  active:   'Active (0-90d)',
  slipping: 'Slipping (3-6m)',
  lapsed:   'Lapsed (6-12m)',
  lost:     'Lost (12m+)',
};

const DEPTH_LABELS = {
  deep:       'Deep',
  regular:    'Regular',
  occasional: 'Occasional',
  one_off:    'One-off',
};

function classifyBucket(daysQuiet) {
  return (BUCKETS.find((b) => daysQuiet <= b.maxDays) || BUCKETS[BUCKETS.length - 1]).key;
}

// Bills-per-year → relationship depth. Normalised against the lookback
// window so a 6-month and a 2-year window classify alike.
function classifyDepth(billsPerYear) {
  if (billsPerYear >= 12) return 'deep';
  if (billsPerYear >= 5)  return 'regular';
  if (billsPerYear >= 2)  return 'occasional';
  return 'one_off';
}

// Shared builder — the JSON endpoint and the XLSX export run the exact
// same query and filters so an exported sheet can never disagree with
// the rows on screen. The export only widens `limit`.
async function buildLapse(query) {
  {
    const req = { query };
    // ── Direction ──────────────────────────────────────────────────
    // Whitelisted to two literals — this picks the table and the party
    // column, so it must never carry raw user input into the SQL.
    const direction = String(req.query.direction || 'supplier').toLowerCase() === 'customer'
      ? 'customer' : 'supplier';
    const isSupplier = direction === 'supplier';
    const table    = isSupplier ? 'purchase_bills' : 'sales_bills';
    const partyCol = isSupplier ? 'supplier_id'    : 'customer_id';

    // ── Lookback window ────────────────────────────────────────────
    // How far back past volume is measured. Two years by default so a
    // party that traded strongly last season still shows its weight.
    const lookbackDays = Math.min(Math.max(parseInt(req.query.lookback_days, 10) || 730, 90), 3650);
    const to = req.query.to_date
      ? String(req.query.to_date).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const fromD = new Date(to + 'T00:00:00Z');
    fromD.setUTCDate(fromD.getUTCDate() - (lookbackDays - 1));
    const from = fromD.toISOString().slice(0, 10);

    // ── Filters ────────────────────────────────────────────────────
    const search       = String(req.query.search || '').trim();
    const bucketFilter = String(req.query.bucket || '').trim();
    const depthFilter  = String(req.query.depth  || '').trim();
    const minValue     = num(req.query.min_value);
    const limit        = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 10000);
    const sort         = String(req.query.sort || 'value_desc').toLowerCase();

    const replacements = { from, to, today: to };
    const searchSql = search
      ? ' AND (p.party_name ILIKE :q OR p.display_name ILIKE :q OR p.mobile_1 ILIKE :q) '
      : '';
    if (search) replacements.q = `%${search}%`;

    // Aggregate trading history once, then join party context.
    // is_system_cash is excluded: the built-in Cash party absorbs every
    // un-named counter transaction and would otherwise top the list as
    // the single biggest "relationship" on the book.
    const rows = await sequelize.query(
      `WITH tx AS (
         SELECT ${partyCol} AS party_id, bill_date, total_amount
           FROM ${table}
          WHERE is_cancelled = false
            AND ${partyCol} IS NOT NULL
            AND bill_date BETWEEN :from AND :to
       ),
       agg AS (
         SELECT party_id,
                COUNT(*)::int     AS bills,
                SUM(total_amount) AS value,
                MIN(bill_date)    AS first_bill,
                MAX(bill_date)    AS last_bill
           FROM tx
          GROUP BY party_id
       )
       SELECT a.party_id,
              a.bills,
              a.value,
              a.first_bill,
              a.last_bill,
              (:today::date - a.last_bill) AS days_quiet,
              (a.last_bill - a.first_bill) AS span_days,
              p.party_name,
              p.display_name,
              p.party_type,
              p.mobile_1,
              p.city,
              p.current_balance
         FROM agg a
         JOIN parties p ON p.party_id = a.party_id
        WHERE p.is_active = true
          AND COALESCE(p.is_system_cash, false) = false
          ${searchSql}`,
      { replacements, type: sequelize.QueryTypes.SELECT },
    );

    const years = lookbackDays / 365;

    let enriched = rows.map((r) => {
      const bills      = num(r.bills);
      const daysQuiet  = Math.max(0, num(r.days_quiet));
      const billsPerYr = bills / years;
      return {
        party_id:        r.party_id,
        party_name:      r.display_name || r.party_name,
        party_type:      r.party_type,
        mobile_1:        r.mobile_1 || null,
        city:            r.city || null,
        bills,
        value:           r2(r.value),
        avg_bill:        bills ? r2(num(r.value) / bills) : 0,
        first_bill:      r.first_bill,
        last_bill:       r.last_bill,
        days_quiet:      daysQuiet,
        span_days:       Math.max(0, num(r.span_days)),
        bills_per_year:  r2(billsPerYr),
        current_balance: r2(r.current_balance),
        bucket:          classifyBucket(daysQuiet),
        depth:           classifyDepth(billsPerYr),
      };
    });

    // ── Summary over the FULL set (pre-filter) so the KPI tiles show
    // the whole landscape regardless of which chips are toggled.
    const summary = {};
    for (const b of BUCKETS) summary[b.key] = { count: 0, value: 0, balance: 0 };
    for (const row of enriched) {
      const s = summary[row.bucket];
      s.count   += 1;
      s.value   += row.value;
      s.balance += row.current_balance;
    }
    for (const k of Object.keys(summary)) {
      summary[k].value   = r2(summary[k].value);
      summary[k].balance = r2(summary[k].balance);
    }
    // Trade at risk = volume attached to parties quiet past 90 days.
    // The headline number: last period's business no longer arriving.
    const atRisk = ['slipping', 'lapsed', 'lost'].reduce((s, k) => s + summary[k].value, 0);

    // ── Apply filters ──────────────────────────────────────────────
    if (bucketFilter) {
      const want = new Set(bucketFilter.split(',').map((s) => s.trim()).filter(Boolean));
      enriched = enriched.filter((r) => want.has(r.bucket));
    }
    if (depthFilter) {
      const want = new Set(depthFilter.split(',').map((s) => s.trim()).filter(Boolean));
      enriched = enriched.filter((r) => want.has(r.depth));
    }
    if (minValue > 0) enriched = enriched.filter((r) => r.value >= minValue);

    const sorters = {
      value_desc:   (a, b) => b.value - a.value,
      value_asc:    (a, b) => a.value - b.value,
      quiet_desc:   (a, b) => b.days_quiet - a.days_quiet,
      quiet_asc:    (a, b) => a.days_quiet - b.days_quiet,
      bills_desc:   (a, b) => b.bills - a.bills,
      balance_desc: (a, b) => Math.abs(b.current_balance) - Math.abs(a.current_balance),
      name_asc:     (a, b) => (a.party_name || '').localeCompare(b.party_name || ''),
    };
    enriched.sort(sorters[sort] || sorters.value_desc);

    return {
      direction,
      period:         { from, to, lookback_days: lookbackDays },
      summary,
      trade_at_risk:  r2(atRisk),
      filtered_count: enriched.length,
      rows:           enriched.slice(0, limit),
    };
  }
}

exports.partyLapse = async (req, res) => {
  try {
    res.json(await buildLapse(req.query || {}));
  } catch (err) {
    console.error('partyLapse error:', err);
    respondWithError(res, err);
  }
};

// ── XLSX export ───────────────────────────────────────────────────────
//
// Built to be carried to the market as a call list, so the column order
// is the order you use it in: who, how long quiet, how much they were
// worth, what you owe them. Phone number sits early for the same
// reason. Honours every filter the screen has applied; only `limit` is
// widened, since the operator is exporting rather than paging.
exports.exportPartyLapse = async (req, res) => {
  try {
    const result = await buildLapse({ ...(req.query || {}), limit: 10000 });
    const isSupplier = result.direction === 'supplier';

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(isSupplier ? 'Suppliers Stopped' : 'Customers Stopped');

    ws.columns = [
      { header: isSupplier ? 'Supplier' : 'Customer', key: 'party_name', width: 30 },
      { header: 'Mobile',        key: 'mobile_1',        width: 15 },
      { header: 'City',          key: 'city',            width: 16 },
      { header: 'Status',        key: 'bucket_label',    width: 16 },
      { header: isSupplier ? 'Last Supply' : 'Last Purchase', key: 'last_bill', width: 13 },
      { header: 'Days Quiet',    key: 'days_quiet',      width: 11 },
      { header: 'Bills',         key: 'bills',           width: 8 },
      { header: isSupplier ? 'Purchased' : 'Bought', key: 'value', width: 15 },
      { header: 'Avg Bill',      key: 'avg_bill',        width: 13 },
      { header: 'Bills / Year',  key: 'bills_per_year',  width: 12 },
      { header: 'Relationship',  key: 'depth_label',     width: 13 },
      { header: isSupplier ? 'You Owe' : 'Owes You', key: 'balance_abs', width: 14 },
      { header: 'First Traded',  key: 'first_bill',      width: 13 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const r of result.rows) {
      // Balance is signed by direction in the model (negative = we owe).
      // The sheet has a direction-specific header instead, so only the
      // magnitude that belongs under that header is written — a payable
      // shown as a negative under "You Owe" reads as a credit note.
      const bal = num(r.current_balance);
      const relevant = isSupplier ? (bal < 0 ? -bal : 0) : (bal > 0 ? bal : 0);
      ws.addRow({
        ...r,
        bucket_label: BUCKET_LABELS[r.bucket] || r.bucket,
        depth_label:  DEPTH_LABELS[r.depth] || r.depth,
        balance_abs:  relevant,
      });
    }

    const tot = ws.addRow({
      party_name:  `TOTAL (${result.rows.length})`,
      value:       result.rows.reduce((s, r) => s + num(r.value), 0),
      balance_abs: result.rows.reduce((s, r) => {
        const b = num(r.current_balance);
        return s + (isSupplier ? (b < 0 ? -b : 0) : (b > 0 ? b : 0));
      }, 0),
    });
    tot.font = { bold: true };
    tot.border = { top: { style: 'medium' } };

    const fname = `${isSupplier ? 'suppliers' : 'customers'}_stopped_${result.period.to}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('exportPartyLapse error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
};
