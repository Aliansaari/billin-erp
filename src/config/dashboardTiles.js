/*
 * Dashboard tile catalog — single source of truth for every tile the
 * Dashboard can render. Each entry describes ONE metric and how to
 * project it from the dashboard endpoint payloads:
 *
 *   stats     — /api/reports/dashboard          (point-in-time totals + prior-period)
 *   series    — /api/reports/dashboard/series   (30-day daily aggregates)
 *   insights  — /api/reports/dashboard/insights (top overdue parties, top sellers, dead stock, …)
 *
 * Three tile shapes ("type"):
 *   metric — single big number with optional sparkline + delta chip
 *   list   — top-N list of parties / products with values
 *   chart  — multi-line trend (sales vs purchase, etc.)
 *
 * Adding a tile: push a new entry to TILES below. The settings page picks
 * it up automatically. Removing a tile: delete the entry; stale ids in
 * user prefs are silently dropped at hydrate time.
 *
 * No fabricated time series. Tiles without a meaningful daily trendline
 * (low-stock count, dead-stock value) render cleanly without one.
 *
 * Builders return PLAIN DATA — including `trendChip: { tone, text }` for
 * the chip the metric component renders. Keeps JSX out of the catalog so
 * it stays a normal `.js` module.
 */

const fmtMoney  = (v) => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
const fmtSigned = (v) => {
  const n = Math.round(Number(v) || 0);
  if (n < 0) return '−₹' + Math.abs(n).toLocaleString('en-IN');
  return '₹' + n.toLocaleString('en-IN');
};
const fmtMoneyShort = (v) => {
  // Compact form for list rows — keeps long names from getting pushed
  // off the right edge. ₹3.4L / ₹2.1Cr instead of ₹3,40,000.
  const n = Math.abs(Number(v) || 0);
  const sign = (Number(v) || 0) < 0 ? '−' : '';
  if (n >= 1e7) return `${sign}₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${sign}₹${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `${sign}₹${(n / 1e3).toFixed(1)} K`;
  return `${sign}₹${Math.round(n).toLocaleString('en-IN')}`;
};
const fmtInt    = (v) => Math.round(Number(v) || 0).toLocaleString('en-IN');

// Tier helper — drives the tile's accent colour. Keeping the S/A/B/C
// labels internal even though the explicit "Tier S" pill was removed
// — the colour mapping is what we want, the label was noise.
function tierFor(value, { strong, healthy, watch } = {}) {
  const v = Number(value) || 0;
  if (strong != null && v >= strong)   return 'S';
  if (healthy != null && v >= healthy) return 'A';
  if (watch != null && v >= watch)     return 'B';
  return 'C';
}

const seriesCol = (series, key) => (series || []).map((row) => Number(row[key]) || 0);

// Slice a series array to the last N buckets. Honours per-tile
// `config.periods` — Dashboard.jsx fetches the maximum supported window
// per interval and each tile trims to its own size. n is clamped to >=1
// so the chart never collapses to nothing.
function lastN(series, n) {
  if (!Array.isArray(series)) return [];
  const count = Math.max(1, Number(n) || 30);
  return series.slice(-count);
}

// Format the chart's x-axis label for a bucket date string. Daily
// buckets read like "07 May", weekly like "Wk 18", monthly like
// "May 26". Tightly tabular so axis ticks line up cleanly.
function fmtBucketLabel(dateStr, interval) {
  if (!dateStr) return '';
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [yy, mm, dd] = dateStr.split('-');
  const monthLabel = M[parseInt(mm, 10) - 1] || mm;
  if (interval === 'month') return `${monthLabel} ${(yy || '').slice(2)}`;
  if (interval === 'week')  return `${parseInt(dd, 10)} ${monthLabel}`;
  return `${parseInt(dd, 10)} ${monthLabel}`;
}

// Friendly category eyebrow & verdict noun for the active interval.
function intervalNoun(interval, periods) {
  if (interval === 'month') return `${periods}-month`;
  if (interval === 'week')  return `${periods}-week`;
  return `${periods}-day`;
}
function intervalUnit(interval) {
  return interval === 'month' ? 'monthly' : interval === 'week' ? 'weekly' : 'daily';
}

// Delta chip from a current/prior pair. invert:true flips the tone so a
// drop reads green for metrics where less is better (GST liability).
function deltaChip(current, prior, label, { invert = false } = {}) {
  if (prior == null || !isFinite(prior) || prior === 0) return null;
  const pct = ((Number(current) || 0) - prior) / Math.abs(prior) * 100;
  const rising  = pct > 0.5;
  const falling = pct < -0.5;
  const goodNow = invert ? falling : rising;
  const badNow  = invert ? rising  : falling;
  const tone = goodNow ? 'up' : badNow ? 'down' : 'flat';
  const arrow = rising ? '▲' : falling ? '▼' : '·';
  const text = `${arrow} ${Math.abs(pct).toFixed(1)}% ${label}`;
  return { tone, text };
}


/* ─────────────────────────────────────────────────────────────────────
 * Tile catalog.
 * Each entry has:
 *   id              unique slug (persisted in user prefs)
 *   group           Catalog UI grouping ("Trends", "Today", "Action", …)
 *   type            'metric' | 'list' | 'chart' (default 'metric')
 *   size            1 | 2 | 3   (grid columns to span — default 1)
 *   label           UI label in the picker
 *   description     UI subtitle in the picker
 *   defaultSelected boolean — included in the first-run defaults
 *   defaultInterval default chart bucket size: 'day' | 'week' | 'month'
 *                   (operator overrides via settings popover; default 'day')
 *   defaultPeriods  default number of buckets to show; if absent the
 *                   store derives a sensible default per interval (30
 *                   daily, 13 weekly, 12 monthly)
 *   configurable    { size?, interval? } — which per-tile controls show
 *                   in the settings popover (default: just `size` for
 *                   list/metric; `interval` enables both interval AND
 *                   periods controls for chart tiles)
 *   build(ctx)      returns props for the matching component
 *                   ctx = { stats, series, seriesMap, insights, config, navigate }
 *                   config = { size, interval, periods } — merged
 *                   catalog default + user override
 *                   series = full dataset for config.interval (slice via
 *                   lastN(series, config.periods) inside the builder)
 *                   seriesMap = { day, week, month } — full per-interval
 *                   datasets, available when a tile needs cross-interval data
 * ───────────────────────────────────────────────────────────────────── */

export const TILES = [
  // ── Trend charts (full-width, 3 columns) ─────────────────────────────
  {
    id: 'trend_sales_purchase',
    group: 'Trends',
    type: 'chart',
    size: 1,
    defaultInterval: 'day',
    defaultPeriods: 30,
    configurable: { size: true, interval: true },
    label: 'Sales vs Purchase trend',
    description: 'Revenue vs cost — daily/weekly/monthly bars, configurable per tile.',
    defaultSelected: true,
    build: ({ series, config }) => {
      const trimmed = lastN(series, config?.periods);
      const sales     = seriesCol(trimmed, 'sales');
      const purchases = seriesCol(trimmed, 'purchases');
      const dates     = (trimmed || []).map((r) => r.date);
      const totalSales = sales.reduce((s, x) => s + x, 0);
      const totalPurc  = purchases.reduce((s, x) => s + x, 0);
      const interval = config?.interval || 'day';
      const periods  = trimmed.length || config?.periods || 30;
      return {
        category: `Trend · ${intervalNoun(interval, periods)}`,
        title: 'Sales vs Purchase',
        summary: `Sales ${fmtMoney(totalSales)} · Purchase ${fmtMoney(totalPurc)} · per ${interval === 'month' ? 'month' : interval === 'week' ? 'week' : 'day'}`,
        series: [
          { key: 'sales',     label: 'Sales',     color: 'var(--accent)',  data: sales },
          { key: 'purchases', label: 'Purchase',  color: 'var(--warning)', data: purchases },
        ],
        xLabels: dates.map((d) => fmtBucketLabel(d, interval)),
      };
    },
  },
  {
    id: 'trend_cash_flow',
    group: 'Trends',
    type: 'chart',
    size: 1,
    defaultInterval: 'day',
    defaultPeriods: 30,
    configurable: { size: true, interval: true },
    label: 'Cash flow trend',
    description: 'Receipts vs payments — money in vs money out. Interval and window configurable per tile.',
    build: ({ series, config }) => {
      const trimmed = lastN(series, config?.periods);
      const receipts = seriesCol(trimmed, 'receipts');
      const payments = seriesCol(trimmed, 'payments');
      const dates    = (trimmed || []).map((r) => r.date);
      const totIn  = receipts.reduce((s, x) => s + x, 0);
      const totOut = payments.reduce((s, x) => s + x, 0);
      const interval = config?.interval || 'day';
      const periods  = trimmed.length || config?.periods || 30;
      return {
        category: `Trend · ${intervalNoun(interval, periods)}`,
        title: 'Money in vs money out',
        summary: `Received ${fmtMoney(totIn)} · Paid ${fmtMoney(totOut)} · Net ${fmtSigned(totIn - totOut)}`,
        series: [
          { key: 'receipts', label: 'Receipts', color: 'var(--success)', data: receipts },
          { key: 'payments', label: 'Payments', color: 'var(--danger)',  data: payments },
        ],
        xLabels: dates.map((d) => fmtBucketLabel(d, interval)),
      };
    },
  },
  {
    id: 'trend_profit',
    group: 'Trends',
    type: 'chart',
    size: 1,
    defaultInterval: 'day',
    defaultPeriods: 30,
    configurable: { size: true, interval: true },
    label: 'Profit trend',
    description: 'Gross profit per bucket — sales (ex-GST) minus COGS. Interval configurable.',
    build: ({ series, config }) => {
      const trimmed = lastN(series, config?.periods);
      const profit = seriesCol(trimmed, 'profit');
      const dates  = (trimmed || []).map((r) => r.date);
      const total  = profit.reduce((s, x) => s + x, 0);
      const periods = profit.length || 1;
      const interval = config?.interval || 'day';
      return {
        category: `Trend · ${intervalNoun(interval, periods)}`,
        title: `Gross profit · ${intervalUnit(interval)}`,
        summary: `${intervalNoun(interval, periods)} total ${fmtSigned(total)} · avg/${interval === 'month' ? 'mo' : interval === 'week' ? 'wk' : 'day'} ${fmtSigned(total / periods)}`,
        series: [
          { key: 'profit', label: 'Gross profit', color: 'var(--accent)', data: profit },
        ],
        xLabels: dates.map((d) => fmtBucketLabel(d, interval)),
      };
    },
  },

  // ── Action lists (top-N rich data) ───────────────────────────────────
  {
    id: 'top_overdue_customers',
    group: 'Action',
    type: 'list',
    size: 1,
    label: 'Top overdue customers',
    description: 'Top 5 customers carrying past-due balances. Drill to chase.',
    defaultSelected: true,
    build: ({ insights, navigate }) => {
      const rows = insights?.overdue_receivables || [];
      const total = rows.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      return {
        category: 'Action · Overdue',
        title: 'Customers past due',
        summary: rows.length === 0 ? 'No overdue balances — clean slate.' : `Top 5 of ₹${Math.round(total).toLocaleString('en-IN')} overdue`,
        items: rows.map((r) => ({
          id: `cust-${r.party_id}`,
          label: r.party_name,
          sub: r.oldest_days ? `${r.oldest_days} day${r.oldest_days === 1 ? '' : 's'} oldest` : null,
          value: fmtMoneyShort(r.balance),
          valueClass: 'danger',
          onClick: () => navigate?.(`/reports/customer-statement?id=${r.party_id}`),
        })),
        emptyText: 'No overdue balances — clean slate.',
        footer: rows.length > 0 ? 'Open Receivables Aging →' : null,
        onFooter: () => navigate?.('/reports/receivables-aging'),
      };
    },
  },
  {
    id: 'top_overdue_suppliers',
    group: 'Action',
    type: 'list',
    size: 1,
    label: 'Top suppliers we owe',
    description: 'Top 5 suppliers carrying past-due balances.',
    build: ({ insights, navigate }) => {
      const rows = insights?.overdue_payables || [];
      const total = rows.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      return {
        category: 'Action · Owed',
        title: 'Suppliers past due',
        summary: rows.length === 0 ? 'No overdue payables.' : `Top 5 of ₹${Math.round(total).toLocaleString('en-IN')} owed`,
        items: rows.map((r) => ({
          id: `supp-${r.party_id}`,
          label: r.party_name,
          sub: r.oldest_days ? `${r.oldest_days} day${r.oldest_days === 1 ? '' : 's'} oldest` : null,
          value: fmtMoneyShort(r.balance),
          valueClass: 'warning',
          onClick: () => navigate?.(`/reports/supplier-statement?id=${r.party_id}`),
        })),
        emptyText: 'No overdue payables.',
        footer: rows.length > 0 ? 'Open Payables Aging →' : null,
        onFooter: () => navigate?.('/reports/payables-aging'),
      };
    },
  },
  {
    id: 'top_selling_products',
    group: 'Action',
    type: 'list',
    size: 1,
    label: 'Top selling products (7d)',
    description: 'Best 5 SKUs by revenue this week — your workhorses.',
    defaultSelected: true,
    build: ({ insights, navigate }) => {
      const rows = insights?.top_selling_products || [];
      return {
        category: 'Action · Top sellers',
        title: 'Best sellers · last 7 days',
        summary: rows.length ? `Ranked by revenue` : null,
        items: rows.map((r) => ({
          id: `prod-${r.product_id}`,
          label: r.product_name,
          sub: `${Math.round(Number(r.qty) || 0)} units`,
          value: fmtMoneyShort(r.value),
          onClick: () => navigate?.(`/stock-movement/${r.product_id}`),
        })),
        emptyText: 'No sales in the last 7 days.',
      };
    },
  },

  // ── Today (point-in-time + same-day delta) ───────────────────────────
  {
    id: 'today_sales',
    group: 'Today',
    type: 'metric',
    size: 1,
    label: "Today's sales",
    description: 'Total invoiced today, with bill count and 30-day sparkline.',
    defaultSelected: true,
    build: ({ stats, series }) => {
      const v   = Number(stats?.today_sales?.total) || 0;
      const c   = Number(stats?.today_sales?.count) || 0;
      const arr = seriesCol(series, 'sales');
      return {
        category: 'Today · Sales',
        tier: tierFor(v, { strong: 200000, healthy: 50000, watch: 1 }),
        title: "Today's sales",
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: c === 1 ? '1 bill' : `${c} bills`,
        trendData: arr.length > 1 ? arr : undefined,
        trendLabel: '30-day daily sales',
        trendChip: deltaChip(v, stats?.prior?.today_sales?.total, 'vs yesterday'),
        verdict: c === 0
          ? 'Quiet open. First bill of the day still to come.'
          : c === 1
            ? 'One bill in. Pace setter.'
            : `${c} bills already booked — keep it moving.`,
      };
    },
  },
  {
    id: 'today_purchases',
    group: 'Today',
    type: 'metric',
    label: "Today's purchases",
    description: 'Total supplier-bill value received today.',
    build: ({ stats, series }) => {
      const v   = Number(stats?.today_purchases?.total) || 0;
      const c   = Number(stats?.today_purchases?.count) || 0;
      const arr = seriesCol(series, 'purchases');
      return {
        category: 'Today · Purchases',
        tier: tierFor(v, { strong: 200000, healthy: 50000, watch: 1 }),
        title: "Today's purchases",
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: c === 1 ? '1 bill' : `${c} bills`,
        trendData: arr.length > 1 ? arr : undefined,
        trendLabel: '30-day daily purchases',
        trendChip: deltaChip(v, stats?.prior?.today_purchases?.total, 'vs yesterday'),
        verdict: c === 0 ? 'No inward bills booked yet today.' : 'Restocking on schedule.',
      };
    },
  },
  {
    id: 'today_receipts',
    group: 'Today',
    type: 'metric',
    label: 'Money received today',
    description: 'Customer receipts logged today.',
    build: ({ series }) => {
      const arr = seriesCol(series, 'receipts');
      const v   = arr.length ? arr[arr.length - 1] : 0;
      const yest = arr.length > 1 ? arr[arr.length - 2] : null;
      return {
        category: 'Today · Receipts',
        tier: v > 0 ? 'A' : 'B',
        title: 'Receipts today',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: 'cash in',
        trendData: arr.length > 1 ? arr : undefined,
        trendLabel: '30-day daily receipts',
        trendChip: deltaChip(v, yest, 'vs yesterday'),
        verdict: v > 0 ? 'Cash flowing in.' : 'No receipts logged yet today.',
      };
    },
  },
  {
    id: 'today_payments',
    group: 'Today',
    type: 'metric',
    label: 'Money paid today',
    description: 'Supplier payments released today.',
    build: ({ series }) => {
      const arr = seriesCol(series, 'payments');
      const v   = arr.length ? arr[arr.length - 1] : 0;
      const yest = arr.length > 1 ? arr[arr.length - 2] : null;
      return {
        category: 'Today · Payments',
        tier: v === 0 ? 'A' : 'B',
        title: 'Payments today',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: 'cash out',
        trendData: arr.length > 1 ? arr : undefined,
        trendLabel: '30-day daily payments',
        trendChip: deltaChip(v, yest, 'vs yesterday'),
        verdict: v === 0 ? 'Nothing released today.' : 'Cash deployed.',
      };
    },
  },
  {
    id: 'today_net_cash',
    group: 'Today',
    type: 'metric',
    label: 'Net cash today',
    description: 'Receipts minus payments today — net change to cash position.',
    defaultSelected: true,
    build: ({ series }) => {
      const r  = seriesCol(series, 'receipts');
      const p  = seriesCol(series, 'payments');
      const v  = (r[r.length - 1] || 0) - (p[p.length - 1] || 0);
      const yest = r.length > 1 ? (r[r.length - 2] || 0) - (p[p.length - 2] || 0) : null;
      const arr = r.map((x, i) => x - (p[i] || 0));
      return {
        category: 'Today · Net cash',
        tier: v > 0 ? 'S' : v === 0 ? 'A' : 'C',
        title: 'Net cash flow today',
        valueCount: Math.abs(v),
        valueFormat: (n) => (v < 0 ? '−' : '') + fmtMoney(n),
        valueLabel: v < 0 ? 'net outflow' : v > 0 ? 'net inflow' : 'balanced',
        trendData: arr.length > 1 ? arr : undefined,
        trendLabel: '30-day daily net',
        trendChip: deltaChip(v, yest, 'vs yesterday'),
        verdict: v > 0 ? 'More in than out today.' : v < 0 ? 'Net cash leaving today.' : 'Cash neutral so far.',
      };
    },
  },

  // ── Month-to-date (running totals + same-window vs last month) ───────
  {
    id: 'mtd_sales',
    group: 'Month-to-date',
    type: 'metric',
    label: 'Sales (MTD)',
    description: 'Gross sales since the 1st, with same-window comparison vs last month.',
    build: ({ stats, series }) => {
      const v = Number(stats?.monthly_sales) || 0;
      const arr = seriesCol(series, 'sales');
      return {
        category: 'Month · Sales',
        tier: tierFor(v, { strong: 1000000, healthy: 250000, watch: 1 }),
        title: 'Month-to-date sales',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: 'gross value',
        trendData: arr.length > 1 ? arr : undefined,
        trendLabel: '30-day daily sales',
        trendChip: deltaChip(v, stats?.prior?.monthly_sales, 'vs last month'),
        verdict: v > 0 ? 'Month tracking — pace holds.' : 'No sales booked this month yet.',
      };
    },
  },
  {
    id: 'mtd_purchases',
    group: 'Month-to-date',
    type: 'metric',
    label: 'Purchases (MTD)',
    description: 'Gross supplier-bill value since the 1st.',
    build: ({ stats, series }) => {
      const v = Number(stats?.monthly_purchases) || 0;
      const arr = seriesCol(series, 'purchases');
      return {
        category: 'Month · Purchases',
        tier: tierFor(v, { strong: 1000000, healthy: 250000, watch: 1 }),
        title: 'Month-to-date purchases',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: 'gross value',
        trendData: arr.length > 1 ? arr : undefined,
        trendLabel: '30-day daily purchases',
        trendChip: deltaChip(v, stats?.prior?.monthly_purchases, 'vs last month'),
        verdict: 'Procurement rhythm against sales.',
      };
    },
  },
  {
    id: 'mtd_profit',
    group: 'Month-to-date',
    type: 'metric',
    label: 'Gross profit (MTD)',
    description: 'Real margin: sales (ex-GST) − COGS − adjustments. Includes margin %.',
    defaultSelected: true,
    build: ({ stats, series }) => {
      const v = Number(stats?.monthly_profit) || 0;
      const sales = Number(stats?.monthly_sales_excl_gst) || 0;
      const arr = seriesCol(series, 'profit');
      const margin = sales > 0 ? (v / sales) * 100 : 0;
      return {
        category: 'Month · Profit',
        tier: v > 0 ? (margin > 15 ? 'S' : 'A') : v === 0 ? 'B' : 'C',
        title: 'Gross profit · MTD',
        valueCount: Math.abs(v),
        valueFormat: (n) => (v < 0 ? '−' : '') + fmtMoney(n),
        valueLabel: v >= 0 ? 'net gain' : 'net loss',
        ringPct: sales > 0 ? Math.min(100, Math.abs(margin)) : 0,
        ringLabel: sales > 0 ? `${margin.toFixed(1)}%` : '—',
        trendData: arr.length > 1 ? arr : undefined,
        trendLabel: '30-day daily profit',
        trendChip: deltaChip(v, stats?.prior?.monthly_profit, 'vs last month'),
        verdict: v > 0
          ? `${margin.toFixed(1)}% margin holding through the month.`
          : v < 0
            ? 'Margin under water — revisit pricing on top-movers.'
            : 'Break-even so far this month.',
      };
    },
  },
  {
    id: 'mtd_gst_liability',
    group: 'Month-to-date',
    type: 'metric',
    label: 'Net GST liability (MTD)',
    description: 'Output GST minus input credit — what you owe the tax authority.',
    build: ({ stats }) => {
      const v = Number(stats?.monthly_gst_liability) || 0;
      return {
        category: 'GST · Liability',
        tier: v <= 0 ? 'A' : v < 25000 ? 'B' : 'C',
        title: 'Net GST liability',
        valueCount: Math.abs(v),
        valueFormat: (n) => (v < 0 ? '−' : '') + fmtMoney(n),
        valueLabel: v >= 0 ? 'payable to govt' : 'input credit balance',
        // Smaller liability = better, so a downward arrow reads green.
        trendChip: deltaChip(v, stats?.prior?.monthly_gst_liability, 'vs last month', { invert: true }),
        verdict: v > 0
          ? 'Set this aside — leaves you on the 20th.'
          : v === 0
            ? 'Output GST equals input credit.'
            : 'Net input credit — applied to next month.',
      };
    },
  },

  // ── Outstanding (point-in-time party balances) ───────────────────────
  {
    id: 'receivables',
    group: 'Outstanding',
    type: 'metric',
    label: 'Receivables',
    description: 'Total amount customers owe — bill balances + opening − on-account receipts.',
    defaultSelected: true,
    build: ({ stats }) => {
      const v = Number(stats?.receivables?.total) || 0;
      const c = Number(stats?.receivables?.count) || 0;
      return {
        category: 'Outstanding · Customers',
        tier: v === 0 ? 'S' : v < 100000 ? 'A' : v < 500000 ? 'B' : 'C',
        title: 'Outstanding from customers',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: c === 1 ? '1 party' : `${c} parties`,
        ringPct: v > 0 ? 80 : 0,
        ringLabel: c ? String(c) : undefined,
        verdict: c === 0
          ? 'All bills paid in full — zero receivables.'
          : `${c} ${c === 1 ? 'party' : 'parties'} carrying balance — review aging this week.`,
      };
    },
  },
  {
    id: 'payables',
    group: 'Outstanding',
    type: 'metric',
    label: 'Payables',
    description: 'Total amount you owe suppliers.',
    defaultSelected: true,
    build: ({ stats }) => {
      const v = Number(stats?.payables?.total) || 0;
      const c = Number(stats?.payables?.count) || 0;
      return {
        category: 'Outstanding · Suppliers',
        tier: v === 0 ? 'S' : v < 100000 ? 'A' : v < 500000 ? 'B' : 'C',
        title: 'Outstanding to suppliers',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: c === 1 ? '1 party' : `${c} parties`,
        ringPct: v > 0 ? 55 : 0,
        ringLabel: c ? String(c) : undefined,
        verdict: c === 0 ? 'Suppliers square. Nothing owed.' : `${c} ${c === 1 ? 'supplier' : 'suppliers'} awaiting payment.`,
      };
    },
  },
  {
    id: 'working_capital',
    group: 'Outstanding',
    type: 'metric',
    label: 'Working-capital gap',
    description: 'Receivables minus payables — short-term cash gap to bridge.',
    build: ({ stats }) => {
      const r = Number(stats?.receivables?.total) || 0;
      const p = Number(stats?.payables?.total)    || 0;
      const v = r - p;
      return {
        category: 'Outstanding · Working capital',
        tier: v >= 0 ? 'A' : 'C',
        title: 'Receivables minus payables',
        valueCount: Math.abs(v),
        valueFormat: (n) => (v < 0 ? '−' : '') + fmtMoney(n),
        valueLabel: v >= 0 ? 'net receivable' : 'net payable',
        verdict: v >= 0
          ? 'You collect more than you owe.'
          : 'Suppliers fund your stock — watch terms.',
      };
    },
  },
  {
    id: 'bills_due_sales',
    group: 'Outstanding',
    type: 'metric',
    label: 'Receivables due this week',
    description: 'Customer bills with due_date in the next 7 days — collections pipeline.',
    build: ({ insights }) => {
      const v = Number(insights?.bills_due_soon?.sales?.total) || 0;
      const c = Number(insights?.bills_due_soon?.sales?.count) || 0;
      return {
        category: 'Action · Due',
        tier: v === 0 ? 'A' : v < 100000 ? 'B' : 'C',
        title: 'Due to receive · 7 days',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: c === 1 ? '1 bill' : `${c} bills`,
        verdict: c === 0
          ? 'Nothing maturing this week.'
          : `${c} bill${c === 1 ? '' : 's'} maturing — line up the calls.`,
      };
    },
  },
  {
    id: 'bills_due_purchase',
    group: 'Outstanding',
    type: 'metric',
    label: 'Payables due this week',
    description: 'Supplier bills with due_date in the next 7 days — cash you need to plan.',
    build: ({ insights }) => {
      const v = Number(insights?.bills_due_soon?.purchase?.total) || 0;
      const c = Number(insights?.bills_due_soon?.purchase?.count) || 0;
      return {
        category: 'Action · Due',
        tier: v === 0 ? 'A' : v < 100000 ? 'B' : 'C',
        title: 'Due to pay · 7 days',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: c === 1 ? '1 bill' : `${c} bills`,
        verdict: c === 0
          ? 'No supplier bills due this week.'
          : `${c} bill${c === 1 ? '' : 's'} maturing — confirm cash on hand.`,
      };
    },
  },
  {
    id: 'cheques_pending',
    group: 'Outstanding',
    type: 'metric',
    label: 'Cheques pending',
    description: 'Issued or received cheques not yet cleared.',
    build: ({ insights }) => {
      const v = Number(insights?.cheques_pending?.total) || 0;
      const c = Number(insights?.cheques_pending?.count) || 0;
      return {
        category: 'Action · Cheques',
        tier: c === 0 ? 'A' : 'B',
        title: 'Cheques pending clearance',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: c === 1 ? '1 cheque' : `${c} cheques`,
        verdict: c === 0
          ? 'No cheques in flight.'
          : 'Watch the bank statement — these are the ones to reconcile.',
      };
    },
  },

  // ── Inventory (stock health) ─────────────────────────────────────────
  {
    id: 'low_stock',
    group: 'Inventory',
    type: 'metric',
    label: 'Low stock items',
    description: 'Active products at or below their reorder threshold.',
    defaultSelected: true,
    build: ({ stats }) => {
      const c = Number(stats?.low_stock_count) || 0;
      return {
        category: 'Inventory · Low stock',
        tier: c === 0 ? 'S' : c <= 3 ? 'A' : c <= 10 ? 'B' : 'C',
        title: 'Items below reorder level',
        valueCount: c, valueFormat: fmtInt,
        valueLabel: c === 1 ? 'item' : 'items',
        ringPct: Math.min(100, c * 10),
        ringLabel: String(c),
        verdict: c === 0
          ? 'All lines stocked — no reorder action needed.'
          : `${c} product${c === 1 ? '' : 's'} need reorder attention.`,
      };
    },
  },
  {
    id: 'stock_value_sale',
    group: 'Inventory',
    type: 'metric',
    label: 'Stock value · sale price',
    description: 'On-hand quantity × catalog sale rate — the realisable ceiling.',
    build: ({ stats }) => {
      const v = Number(stats?.stock_value?.sale) || 0;
      return {
        category: 'Inventory · Sale potential',
        tier: 'A',
        title: 'Stock value · sale potential',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: 'realisable at list price',
        verdict: 'What today’s shelves could clear at full price.',
      };
    },
  },
  {
    id: 'stock_value_cost',
    group: 'Inventory',
    type: 'metric',
    label: 'Stock value · cost',
    description: 'Cost basis of on-hand stock — capital tied up.',
    build: ({ stats }) => {
      const v = Number(stats?.stock_value?.purchase) || 0;
      return {
        category: 'Inventory · Cost',
        tier: 'A',
        title: 'Stock value · cost basis',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: 'capital tied up',
        verdict: 'Cost of goods sitting on shelves.',
      };
    },
  },
  {
    id: 'dead_stock',
    group: 'Inventory',
    type: 'metric',
    label: 'Dead stock value',
    description: 'On-hand value of products with zero sales in the last 60 days.',
    defaultSelected: true,
    build: ({ insights }) => {
      const v = Number(insights?.dead_stock?.total_value) || 0;
      const c = Number(insights?.dead_stock?.count) || 0;
      return {
        category: 'Inventory · Dead stock',
        tier: v === 0 ? 'S' : v < 100000 ? 'B' : 'C',
        title: 'Frozen capital · 60-day idle',
        valueCount: v, valueFormat: fmtMoney,
        valueLabel: c === 1 ? '1 SKU' : `${c} SKUs`,
        verdict: c === 0
          ? 'Every SKU has moved in the last 60 days.'
          : `${c} SKU${c === 1 ? '' : 's'} haven’t moved in 60 days — discount or clear.`,
      };
    },
  },
];

const BY_ID = TILES.reduce((m, t) => { m[t.id] = t; return m; }, {});
export const getTileById = (id) => BY_ID[id];

// First-run defaults — chart spans 3 cells, six metric/list tiles fill
// the other two rows for a clean 3×3 grid out of the box.
export const DEFAULT_TILE_IDS = TILES.filter((t) => t.defaultSelected).map((t) => t.id);

// Group order for the picker UI. Trends first because they're the
// "see business at a glance" view; Action next because that's what an
// operator opens the dashboard to find; today + MTD numbers after.
export const TILE_GROUPS = ['Trends', 'Action', 'Today', 'Month-to-date', 'Outstanding', 'Inventory'];

// Type label for the picker UI.
export const TYPE_LABEL = {
  metric: 'Metric',
  list:   'List',
  chart:  'Chart',
};
