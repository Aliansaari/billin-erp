import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { DatePicker, Tooltip } from 'antd';
import { reportAPI } from '../api';
import { readSectionPrefs, isSectionVisible } from '../config/dashboardSections';
import './dashboard-editorial.css';

/* ── InfoTip ──────────────────────────────────────────────────────────
 * A small "(i)" affordance placed next to a metric / section title. On
 * hover (or keyboard focus) it shows a plain-language explanation so a
 * non-accountant shop owner understands what the number means and what
 * to do about it. Purely informational — never affects any value.
 */
function InfoTip({ text, label }) {
  return (
    <Tooltip
      title={text}
      placement="top"
      mouseEnterDelay={0.05}
      overlayClassName="ed-tip"
      overlayStyle={{ maxWidth: 320 }}
    >
      <span
        className="ed-info"
        tabIndex={0}
        role="img"
        aria-label={`${label ? label + ' — ' : ''}what is this?`}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="11" x2="12" y2="16" />
          <line x1="12" y1="7.5" x2="12.01" y2="7.5" />
        </svg>
      </span>
    </Tooltip>
  );
}

/**
 * Editorial Dashboard — wholesale business intelligence.
 * ──────────────────────────────────────────────────────
 *
 * Layout: top bar → page header w/ greeting → 5-card KPI strip →
 * money movement (cash flow chart + P&L MTD) → receivables aging →
 * sales intelligence (top customers / products / concentration).
 *
 * Data sources (existing endpoints):
 *   /api/reports/dashboard          — point-in-time totals + prior-period
 *   /api/reports/dashboard/series   — 30-day daily aggregates
 *   /api/reports/dashboard/insights — top overdue / top sellers / dead stock
 *   /api/reports/aging              — bucketed receivables aging
 *
 * Customizable tile version preserved at /dashboard/classic.
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats]       = useState(null);
  const [series, setSeries]     = useState([]);
  const [insights, setInsights] = useState(null);
  const [aging, setAging]       = useState(null);
  const [business, setBusiness] = useState(null);
  const [period, setPeriod]     = useState('30D');   // 7D | 30D | 90D | FY | CUSTOM
  const [customRange, setCustomRange] = useState(null); // [dayjs, dayjs] when period === 'CUSTOM'

  // Derive the trend interval from the active period — short windows
  // bucket by day, 90D rolls up to weeks, FY (or wide custom) to months,
  // so the trend chart's x-axis stays readable instead of cramming 365
  // daily ticks. Returned alongside a `bucketCount` driving slice/labels.
  const trendBucket = useMemo(() => {
    if (period === 'CUSTOM' && customRange?.[0] && customRange?.[1]) {
      const spanDays = customRange[1].diff(customRange[0], 'day') + 1;
      if (spanDays <= 60)  return { interval: 'day',   count: spanDays };
      if (spanDays <= 180) return { interval: 'week',  count: Math.min(52, Math.ceil(spanDays / 7)) };
      return { interval: 'month', count: Math.min(36, Math.ceil(spanDays / 30)) };
    }
    if (period === 'FY')  return { interval: 'month', count: 12 };
    if (period === '90D') return { interval: 'week',  count: 13 };
    if (period === '30D') return { interval: 'day',   count: 30 };
    return { interval: 'day', count: 7 };
  }, [period, customRange]);
  const [loading, setLoading]   = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState(null);

  // Section visibility — authored in Settings → Dashboard, stored in
  // localStorage. Re-read on the custom event (same-tab settings change)
  // and the native storage event (another tab/window).
  const [sectionPrefs, setSectionPrefs] = useState(readSectionPrefs);
  useEffect(() => {
    const reread = () => setSectionPrefs(readSectionPrefs());
    window.addEventListener('ed-dash-sections', reread);
    window.addEventListener('storage', reread);
    return () => {
      window.removeEventListener('ed-dash-sections', reread);
      window.removeEventListener('storage', reread);
    };
  }, []);
  const show = (id) => isSectionVisible(sectionPrefs, id);

  useEffect(() => {
    load(period);
    // Auto-refresh strategy:
    //   • 5 min — refresh stats + business metrics (these change slowly)
    // Tab not visible? Pause the polling. Resume on focus.
    let alive = true;
    const tick = () => { if (alive && !document.hidden) load(period); };
    const id = setInterval(tick, 5 * 60 * 1000);
    const onFocus = () => { if (alive) load(period); };
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [period, customRange]);

  async function load(currentPeriod = period) {
    setLoading(true);
    try {
      // Translate the period chip into concrete from/to dates + a `periods`
      // length for the day-bucket series. Sent as query params on every
      // dashboard request so the backend can filter; if a particular endpoint
      // ignores them today, future-proof now beats wiring it twice later.
      const today = dayjs();
      let from, to = today, periodsLen;
      if (currentPeriod === 'CUSTOM' && customRange?.[0] && customRange?.[1]) {
        from = customRange[0];
        to   = customRange[1];
        periodsLen = Math.max(to.diff(from, 'day') + 1, 1);
      } else if (currentPeriod === 'FY') {
        const y = today.month() < 3 ? today.year() - 1 : today.year();
        from = dayjs(`${y}-04-01`);
        periodsLen = Math.max(today.diff(from, 'day') + 1, 1);
      } else {
        const days = currentPeriod === '7D' ? 7 : currentPeriod === '30D' ? 30 : 90;
        from = today.subtract(days - 1, 'day');
        periodsLen = days;
      }
      const dateParams = { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD'), period: currentPeriod };
      const [stRes, sRes, iRes, aRes, bRes] = await Promise.allSettled([
        reportAPI.getDashboard(dateParams),
        // Trend series — interval / count chosen per period so the chart
        // x-axis stays readable. 7D & 30D = daily, 90D = weekly buckets,
        // FY (or >180-day custom) = monthly buckets.
        reportAPI.getDashboardSeries({ interval: trendBucket.interval, periods: trendBucket.count, ...dateParams }),
        reportAPI.getDashboardInsights(dateParams),
        reportAPI.getAging({ party_type: 'Customer', ...dateParams }),
        reportAPI.getDashboardBusiness(dateParams),
      ]);
      if (stRes.status === 'fulfilled') setStats(stRes.value.data || null);
      if (sRes.status  === 'fulfilled') setSeries(sRes.value.data?.series || []);
      if (iRes.status  === 'fulfilled') setInsights(iRes.value.data || null);
      if (aRes.status  === 'fulfilled') setAging(aRes.value.data || null);
      if (bRes.status  === 'fulfilled') setBusiness(bRes.value.data || null);
      setLastSyncAt(dayjs());
    } catch (err) {
      console.error('Dashboard load failed:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !stats) {
    return (
      <div className="ed-loading">
        <div className="ed-spinner" />
        <div className="ed-loading-text">Loading dashboard…</div>
      </div>
    );
  }

  return (
    <div className="ed-dashboard">
      <TopBar
        period={period}
        setPeriod={(p) => { setPeriod(p); if (p !== 'CUSTOM') setCustomRange(null); }}
        customRange={customRange}
        setCustomRange={(r) => { setCustomRange(r); setPeriod(r ? 'CUSTOM' : '30D'); }}
        onReload={() => load(period)}
      />
      {show('quickstats')   && <PageHeader stats={stats} insights={insights} aging={aging} business={business} />}
      {show('kpis')         && <KpiStrip stats={stats} series={series} insights={insights} business={business} />}
      {show('money')        && <MoneyMovementRow stats={stats} series={series} business={business} period={period} bucket={trendBucket} />}
      {show('trends')       && <SalesPurchaseTrendRow stats={stats} series={series} period={period} bucket={trendBucket} />}
      {show('insight')      && <InsightBar tone="primary" insight={buildPrimaryInsight({ stats, insights, aging, business })} />}
      {show('receivables')  && <ReceivablesSection aging={aging} insights={insights} business={business} navigate={navigate} />}
      {show('intelligence') && <SalesIntelligenceRow insights={insights} business={business} stats={stats} />}
      {show('health')       && <OperationalHealthRow business={business} insights={insights} />}
      {show('actions')      && <InsightBar tone="actions" actions={business?.actions || []} navigate={navigate} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  TOP BAR
 * ═══════════════════════════════════════════════════════════════════════ */
function TopBar({ period, setPeriod, customRange, setCustomRange, onReload }) {
  const periods = ['7D', '30D', '90D', 'FY'];

  return (
    <div className="ed-topbar rpt-page-hd">
      <div className="rpt-title">
        <h1>Dashboard</h1>
      </div>
      <div className="rpt-hd-ctrl">
        <div className="ed-ctrl-group">
          {periods.map((p) => (
            <button
              key={p}
              type="button"
              className={`ed-ctrl ${period === p ? 'is-active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <DatePicker.RangePicker
          className={`ed-range-picker${period === 'CUSTOM' ? ' is-active' : ''}`}
          value={period === 'CUSTOM' ? customRange : null}
          onChange={(val) => setCustomRange(val && val[0] && val[1] ? val : null)}
          format="DD MMM YY"
          placeholder={['Custom from', 'Custom to']}
          allowClear
          size="small"
        />
        <button type="button" className="ed-ctrl-pill" onClick={onReload} title="Refresh data">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>
    </div>
  );
}

function computeDateRange(period) {
  const today = dayjs();
  const days = period === '7D' ? 6 : period === '30D' ? 29 : period === '90D' ? 89 : null;
  if (period === 'FY') {
    // Indian financial year — Apr 1 to Mar 31
    const y = today.month() < 3 ? today.year() - 1 : today.year();
    return { label: `1 Apr ${String(y).slice(-2)} – today` };
  }
  const from = today.subtract(days, 'day');
  return { label: `${from.format('D MMM')} – ${today.format('D MMM')}` };
}

/* ═══════════════════════════════════════════════════════════════════════
 *  PAGE HEADER — greeting, situational subtitle, 4 quick stats
 * ═══════════════════════════════════════════════════════════════════════ */
function PageHeader({ stats, insights, aging }) {
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), []);
  const firstName = useMemo(() => firstNameFromAuth(), []);

  // Quick stats
  const billsToday = (stats?.today_sales?.count || 0) + (stats?.today_purchases?.count || 0);
  const todaySales = stats?.today_sales?.count || 0;
  const todayPurch = stats?.today_purchases?.count || 0;
  const openSales = stats?.receivables?.count || 0;
  const openPurch = stats?.payables?.count || 0;
  // Avg ticket = period sales ÷ period bill count. Guard on count>0 —
  // dividing by a missing count used to fall back to 1 and display the
  // ENTIRE month's sales as the "average ticket".
  const salesCount = stats?.monthly_sales_count || 0;
  const avgTicket = salesCount > 0 ? (stats?.monthly_sales_excl_gst || 0) / salesCount : 0;
  // Net GST for the period: output tax collected − input credit. What
  // the business actually owes the government — more useful up top than
  // repeating Stock value (already a KPI card below).
  const gstNet = stats?.monthly_gst_liability || 0;

  // Situational subtitle from data
  const subtitle = useMemo(() => buildSituationalSubtitle({ stats, insights, aging }),
    [stats, insights, aging]);

  return (
    <header className="ed-page-head">
      <div className="ed-page-head-left">
        <InsightBanner {...subtitle} />
      </div>
      <div className="ed-quick-stats">
        <QStat tone="primary" icon="invoice" label="Bills today"  value={billsToday} sub={`${todaySales} sale · ${todayPurch} purch`}
               tip="Number of bills you entered today — sales plus purchases. A quick pulse of today's activity." />
        <QStat tone="warn"    icon="folder"  label="Open bills"   value={openSales + openPurch} sub={`${openSales} AR · ${openPurch} AP`}
               tip="Bills not yet fully settled. AR (accounts receivable) = sales customers still owe you; AP (accounts payable) = purchases you still owe suppliers." />
        <QStat tone="info"    icon="ticket"  label="Avg ticket"   value={formatINR(avgTicket, { compact: true })} sub={salesCount > 0 ? `across ${salesCount} bills` : 'no sales yet'} mono cur
               tip="Average value of one sale in this period = total sales ÷ number of sales bills. Higher means bigger orders per customer." />
        <QStat tone="pos"     icon="box"     label="GST payable"  value={formatINR(Math.abs(gstNet), { compact: true })} sub={gstNet >= 0 ? 'output − input credit' : 'input credit exceeds output'} mono cur
               tip="Net GST for the period: tax collected on sales minus input credit on purchases. This is roughly what you'll deposit with the government (negative = credit carries forward)." />
      </div>
    </header>
  );
}

function QStat({ tone = 'idle', icon, label, value, sub, mono, cur, tip }) {
  const Icon = () => {
    if (icon === 'invoice') return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
    );
    if (icon === 'folder') return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    );
    if (icon === 'ticket') return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><line x1="13" y1="5" x2="13" y2="7"/><line x1="13" y1="11" x2="13" y2="13"/><line x1="13" y1="17" x2="13" y2="19"/></svg>
    );
    if (icon === 'box') return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
    );
    return null;
  };
  return (
    <div className={`ed-qstat ed-qstat--${tone}`}>
      <div className="ed-qstat-head">
        <span className="ed-qstat-icon"><Icon /></span>
        <span className="ed-qstat-label">{label}</span>
        {tip && <InfoTip text={tip} label={label} />}
      </div>
      <div className={`ed-qstat-val${mono ? ' ed-tab' : ''}`}>
        {cur && <span className="ed-qstat-cur">₹</span>}{value}
      </div>
      <div className="ed-qstat-sub">{sub}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  KPI STRIP — 5 cards: Cash, Receivables, Payables, Sales MTD, Stock
 * ═══════════════════════════════════════════════════════════════════════ */
function KpiStrip({ stats, series, insights, business }) {
  // Sparkline data — last 14 days
  const last14 = (series || []).slice(-14);
  const cashRunway = business?.cash_runway_days;

  const cards = [
    {
      tone: 'accent',
      label: 'Cash position',
      tip: 'Total money you can use right now — all bank balances plus cash in hand. “Runway” is roughly how many days this lasts at your recent spending rate.',
      value: business?.cash_position ?? null,
      // Honest sub-line: "0 day runway" on a negative balance reads like a
      // countdown when the real story is the books show net outflow.
      sub: (business?.cash_position ?? 0) < 0
        ? 'negative — verify opening balances'
        : (cashRunway != null && cashRunway > 0)
          ? `${cashRunway} day runway`
          : 'all banks + cash',
      sparkKey: 'receipts',
      delta: null,
      isCurrency: true,
    },
    {
      tone: 'warn',
      label: 'Receivables',
      tip: 'Money your customers still owe you on unpaid sales bills (udhaar). “Overdue” ones are past their due date — chase these first.',
      value: stats?.receivables?.total || 0,
      sub: `${stats?.receivables?.count || 0} parties${insights?.overdue_receivables?.length ? ' · ' + insights.overdue_receivables.length + ' overdue' : ''}`,
      sparkKey: 'sales',
      isCurrency: true,
    },
    {
      tone: 'neg',
      label: 'Payables',
      tip: 'Money you still owe your suppliers on unpaid purchase bills. “Overdue” ones are past their due date.',
      value: stats?.payables?.total || 0,
      sub: `${stats?.payables?.count || 0} suppliers${insights?.overdue_payables?.length ? ' · ' + insights.overdue_payables.length + ' overdue' : ''}`,
      sparkKey: 'purchases',
      isCurrency: true,
    },
    {
      tone: 'pos',
      label: 'Sales MTD',
      tip: 'Total sales so far this month (MTD = month-to-date), excluding GST. The % compares with the same point last month — green is up, red is down.',
      value: stats?.monthly_sales_excl_gst || 0,
      sub: buildSalesSub(stats),
      sparkKey: 'sales',
      delta: pctDelta(stats?.monthly_sales_excl_gst, stats?.prior?.monthly_sales_excl_gst),
      isCurrency: true,
    },
    {
      tone: 'info',
      label: 'Stock value',
      tip: 'Value of goods currently in stock, valued at the price you paid (cost), not the selling price. This is cash tied up in inventory.',
      value: stats?.stock_value?.purchase || 0,
      sub: buildStockSub(stats, insights),
      sparkKey: null,
      isCurrency: true,
    },
  ];

  return (
    <section className="ed-kpi-strip">
      {cards.map((c, i) => (
        <KpiCard key={c.label} {...c} series={last14} />
      ))}
    </section>
  );
}

function KpiCard({ tone, label, value, sub, delta, isCurrency, sparkKey, series, tip }) {
  const sparkValues = sparkKey
    ? series.map((s) => Number(s[sparkKey] || 0))
    : [];
  const showValue = value == null ? '—' : (isCurrency ? formatINR(value, { compact: true, withCur: true }) : value);

  return (
    <div className="ed-kpi">
      <div className="ed-kpi-head">
        <div className="ed-kpi-label">
          <span className={`ed-mk ed-mk-${tone}`} />
          {label}
          {tip && <InfoTip text={tip} label={label} />}
        </div>
        {delta != null && (
          <span className={`ed-kpi-delta ${deltaTone(delta, tone)}`}>
            {deltaIcon(delta)} {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      <div className={`ed-kpi-value`}>
        {typeof showValue === 'string' && showValue.startsWith('₹')
          ? <><span className="ed-cur">₹</span>{showValue.slice(1)}</>
          : showValue}
      </div>
      <div className="ed-kpi-sub">{sub || ' '}</div>
      {sparkValues.length > 0 ? <Sparkline values={sparkValues} tone={tone} /> : <div style={{ height: 24 }} />}
    </div>
  );
}

function Sparkline({ values, tone }) {
  const max = Math.max(1, ...values);
  const lastIdx = values.length - 1;
  return (
    <div className="ed-spark">
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * 22);
        return (
          <div
            key={i}
            className={`ed-sb ed-sb-${tone}${i === lastIdx ? ' ed-tall' : ''}`}
            style={{ height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  MONEY MOVEMENT — Cash Flow Chart (60%) + P&L MTD (40%)
 * ═══════════════════════════════════════════════════════════════════════ */
function MoneyMovementRow({ stats, series, period, bucket }) {
  // Slice series to the selected period. The trend-bucket prop is shared
  // with SalesPurchaseTrendRow so the cash-flow chart aggregates at the
  // same granularity (day/week/month) and the legend text stays in sync.
  const interval = bucket?.interval || 'day';
  const count    = bucket?.count    || (period === '7D' ? 7 : period === '30D' ? 30 : period === '90D' ? 13 : 12);
  const slice    = (series || []).slice(-count);
  const periodLabel = interval === 'month' ? `Last ${count} months`
                    : interval === 'week'  ? `Last ${count} weeks`
                    : `Last ${count} days`;

  const received = sum(slice, 'receipts');
  const paid = sum(slice, 'payments');
  const net = received - paid;
  const avgBal = slice.length ? (received - paid) / slice.length + (stats?.cash_position || 0) : (stats?.cash_position || 0);

  // P&L MTD from stats
  const rev = stats?.monthly_sales_excl_gst || 0;
  const cogs = stats?.monthly_cogs || (rev - (stats?.monthly_profit || 0));
  const grossProfit = rev - cogs;
  const opex = 0; // not yet computed
  const netProfit = stats?.monthly_profit || 0;

  return (
    <section className="ed-row-charts">
      {/* Left: cash flow */}
      <div className="ed-panel">
        <div className="ed-panel-head">
          <div className="ed-panel-title-row">
            <div className="ed-panel-title">Cash <em>movement</em>
              <InfoTip label="Cash movement" text="Money actually coming in (receipts) versus going out (payments) over this period — your real cash flow, separate from sales merely booked on credit." />
            </div>
            <div className="ed-panel-meta">{periodLabel}</div>
          </div>
        </div>
        <div className="ed-chart-wrap">
          <div className="ed-chart-summary">
            <Csum tone="pos" label="Received" value={received} delta={null} />
            <Csum tone="neg" label="Paid out" value={paid} delta={null} />
            <Csum tone="net" label="Net flow" value={net} delta={null} signed />
            <Csum tone="bal" label="Cash now" value={stats?.cash_position || 0} delta={null} />
          </div>
          <CashFlowChart series={slice} interval={interval} />
          <div className="ed-chart-legend">
            <span className="ed-legend-item">
              <span className="ed-legend-swatch" style={{ background: 'var(--ed-pos)' }} />
              Received <span className="ed-legend-value">{formatINR(received, { compact: true, withCur: true })}</span>
            </span>
            <span className="ed-legend-item">
              <span className="ed-legend-swatch" style={{ background: 'var(--ed-neg)' }} />
              Paid out <span className="ed-legend-value">{formatINR(paid, { compact: true, withCur: true })}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Right: P&L MTD */}
      <div className="ed-panel">
        <div className="ed-panel-head">
          <div className="ed-panel-title-row">
            <div className="ed-panel-title">Profit & <em>loss</em>
              <InfoTip label="Profit & loss" text="Your profit picture for the period: sales minus cost of goods sold and expenses. Shows whether the business is truly making money, not just turnover." />
            </div>
            <div className="ed-panel-meta">Month to date</div>
          </div>
        </div>
        <div className="ed-pl-rows">
          <PlRow label="Sales revenue" value={rev} pct={rev ? 100 : 0} />
          <PlRow label="Cost of goods sold" value={-cogs} pct={rev ? -(cogs / rev * 100) : 0} negVal />
          <PlRow label="Gross profit" value={grossProfit} pct={rev ? (grossProfit / rev * 100) : 0} total />
          <PlRow label="Operating expenses" value={-opex} pct={rev ? -(opex / rev * 100) : 0} negVal />
          <PlRow label="Net profit" value={netProfit} pct={rev ? (netProfit / rev * 100) : 0} total />
        </div>
      </div>
    </section>
  );
}

function Csum({ tone, label, value, delta, signed, raw }) {
  const sign = signed && value > 0 ? '+' : (signed && value < 0 ? '−' : '');
  const display = raw
    ? Math.abs(Math.round(value)).toLocaleString('en-IN')
    : formatINR(Math.abs(value), { compact: true });
  return (
    <div className={`ed-csum ed-csum-${tone}`}>
      <div className="ed-csum-label">{label}</div>
      <div className={`ed-csum-val ed-csum-val-${tone}`}>
        {!raw && <span className="ed-cur">₹</span>}{sign}{display}
      </div>
      {delta != null && (
        <div className="ed-csum-delta">
          <span className={delta >= 0 ? 'ed-up' : 'ed-down'}>{delta >= 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(1)}%</span> vs prior
        </div>
      )}
    </div>
  );
}

function CashFlowChart({ series, interval = 'day' }) {
  const W = 800, H = 200, P = 8;
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);

  if (!series || series.length < 2) {
    return (
      <div className="ed-chart-svg-wrap">
        <div className="ed-chart-empty">No movement in this period</div>
      </div>
    );
  }

  const receipts = series.map((s) => Number(s.receipts || 0));
  const payments = series.map((s) => Number(s.payments || 0));
  const max = Math.max(1, ...receipts, ...payments);
  const n = series.length;

  const xAt = (i) => P + (i * (W - P * 2)) / (n - 1);
  const yAt = (v) => H - P - (v / max) * (H - P * 2);

  const linePath = (vals) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ');
  const areaPath = (vals) =>
    `M ${xAt(0)} ${H - P} ` +
    vals.map((v, i) => `L ${xAt(i)} ${yAt(v)}`).join(' ') +
    ` L ${xAt(n - 1)} ${H - P} Z`;

  const xLabels = pickXLabels(series, 5, interval);

  const onMove = (e) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const xRel = (e.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(xRel * (n - 1))));
    setHover({ i, x_pct: (xAt(i) / W) * 100 });
  };
  const onLeave = () => setHover(null);

  const hi = hover?.i ?? null;
  const hoverRow = hi != null ? series[hi] : null;
  const hoverDate = hoverRow ? (hoverRow.d || hoverRow.date) : null;
  const dateFmt = interval === 'month' ? 'MMM YYYY'
                : interval === 'week'  ? '[Week of] D MMM'
                : 'D MMM YYYY';

  return (
    <div
      ref={wrapRef}
      className="ed-chart-svg-wrap"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="ed-chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="ed-grad-pos" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ed-pos)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--ed-pos)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* horizontal grid lines */}
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1={P} x2={W - P} y1={P + (H - P * 2) * t} y2={P + (H - P * 2) * t}
            stroke="var(--ed-line)" strokeDasharray="2 4" strokeWidth="0.6" />
        ))}
        {/* receipts area + line */}
        <path d={areaPath(receipts)} fill="url(#ed-grad-pos)" />
        <path d={linePath(receipts)} fill="none" stroke="var(--ed-pos)" strokeWidth="1.6" strokeLinejoin="round" />
        {/* payments line */}
        <path d={linePath(payments)} fill="none" stroke="var(--ed-neg)" strokeWidth="1.4" strokeLinejoin="round" />
        {/* hover guide + dots */}
        {hi != null && (
          <>
            <line x1={xAt(hi)} x2={xAt(hi)} y1={P} y2={H - P}
              stroke="var(--ed-ink-3)" strokeOpacity="0.35" strokeWidth="0.8" strokeDasharray="2 3" />
            <circle cx={xAt(hi)} cy={yAt(receipts[hi])} r="5" fill="var(--ed-pos)" fillOpacity="0.18" />
            <circle cx={xAt(hi)} cy={yAt(receipts[hi])} r="3" fill="var(--ed-pos)" />
            <circle cx={xAt(hi)} cy={yAt(payments[hi])} r="5" fill="var(--ed-neg)" fillOpacity="0.18" />
            <circle cx={xAt(hi)} cy={yAt(payments[hi])} r="3" fill="var(--ed-neg)" />
          </>
        )}
        {/* terminal dots */}
        <circle cx={xAt(n - 1)} cy={yAt(receipts[n - 1])} r="3" fill="var(--ed-pos)" />
        <circle cx={xAt(n - 1)} cy={yAt(payments[n - 1])} r="3" fill="var(--ed-neg)" />
      </svg>
      {hi != null && hoverDate && (
        <div
          className="ed-chart-tip ed-chart-tip--dual"
          style={{ left: `${hover.x_pct}%`, top: '12%' }}
        >
          <div className="ed-chart-tip-date">{dayjs(hoverDate).format(dateFmt)}</div>
          <div className="ed-chart-tip-val">
            <span className="ed-chart-tip-swatch" style={{ background: 'var(--ed-pos)' }} />
            Received <strong>₹{formatINR(receipts[hi], { compact: true })}</strong>
          </div>
          <div className="ed-chart-tip-val">
            <span className="ed-chart-tip-swatch" style={{ background: 'var(--ed-neg)' }} />
            Paid out <strong>₹{formatINR(payments[hi], { compact: true })}</strong>
          </div>
        </div>
      )}
      <div className="ed-chart-x-labels">
        {xLabels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  SALES + PURCHASE TREND — two separate panels side-by-side, each with
 *  its own summary cells, single-series area chart, and footer total.
 *  Same panel chrome as the Cash movement / P&L row.
 * ═══════════════════════════════════════════════════════════════════════ */
function SalesPurchaseTrendRow({ stats, series, period, bucket }) {
  const interval = bucket?.interval || 'day';
  const count    = bucket?.count    || (period === '7D' ? 7 : period === '30D' ? 30 : period === '90D' ? 13 : 12);
  const slice    = (series || []).slice(-count);
  const prevSlice = (series || []).slice(-count * 2, -count);
  const periodLabel = interval === 'month' ? `Last ${count} months`
                    : interval === 'week'  ? `Last ${count} weeks`
                    : `Last ${count} days`;

  // Sales aggregates
  const totalSales      = sum(slice, 'sales');
  const salesCount      = sum(slice, 'sales_count');
  const avgSalesBill    = salesCount ? totalSales / salesCount : 0;
  const peakSales       = slice.reduce((m, s) => Math.max(m, Number(s.sales || 0)), 0);
  const prevSalesTotal  = sum(prevSlice, 'sales');
  const salesDelta      = prevSalesTotal ? ((totalSales - prevSalesTotal) / prevSalesTotal) * 100 : null;

  // Purchase aggregates
  const totalPurchases   = sum(slice, 'purchases');
  const purchasesCount   = sum(slice, 'purchases_count');
  const avgPurchBill     = purchasesCount ? totalPurchases / purchasesCount : 0;
  const peakPurchases    = slice.reduce((m, s) => Math.max(m, Number(s.purchases || 0)), 0);
  const prevPurchTotal   = sum(prevSlice, 'purchases');
  const purchDelta       = prevPurchTotal ? ((totalPurchases - prevPurchTotal) / prevPurchTotal) * 100 : null;

  return (
    <section className="ed-row-charts ed-row-charts--equal">
      {/* Sales panel */}
      <div className="ed-panel">
        <div className="ed-panel-head">
          <div className="ed-panel-title-row">
            <div className="ed-panel-title">Sales <em>trend</em>
              <InfoTip label="Sales trend" text="Your sales over time across the selected period, so you can spot momentum, peak days, and slow patches at a glance." />
            </div>
            <div className="ed-panel-meta">{periodLabel}</div>
          </div>
        </div>
        <div className="ed-chart-wrap">
          <div className="ed-chart-summary">
            <Csum tone="pos" label="Total"     value={totalSales}    delta={salesDelta} />
            <Csum tone="net" label="Bills"     value={salesCount}    delta={null} raw />
            <Csum tone="bal" label="Avg ticket" value={avgSalesBill} delta={null} />
            <Csum tone="pos" label="Peak day"  value={peakSales}     delta={null} />
          </div>
          <TrendChart series={slice} field="sales" tone="pos" interval={interval} />
          <div className="ed-chart-legend">
            <span className="ed-legend-item">
              <span className="ed-legend-swatch" style={{ background: 'var(--ed-pos)' }} />
              Sales <span className="ed-legend-value">{formatINR(totalSales, { compact: true, withCur: true })}</span>
              <span className="ed-legend-meta">· {salesCount} bills</span>
            </span>
          </div>
        </div>
      </div>

      {/* Purchase panel */}
      <div className="ed-panel">
        <div className="ed-panel-head">
          <div className="ed-panel-title-row">
            <div className="ed-panel-title">Purchase <em>trend</em>
              <InfoTip label="Purchase trend" text="Your purchases over time across the selected period — useful for spotting overbuying and seeing how stocking lines up with sales." />
            </div>
            <div className="ed-panel-meta">{periodLabel}</div>
          </div>
        </div>
        <div className="ed-chart-wrap">
          <div className="ed-chart-summary">
            <Csum tone="warn" label="Total"     value={totalPurchases} delta={purchDelta} />
            <Csum tone="net"  label="Bills"     value={purchasesCount} delta={null} raw />
            <Csum tone="bal"  label="Avg ticket" value={avgPurchBill}  delta={null} />
            <Csum tone="warn" label="Peak day"  value={peakPurchases}  delta={null} />
          </div>
          <TrendChart series={slice} field="purchases" tone="warn" interval={interval} />
          <div className="ed-chart-legend">
            <span className="ed-legend-item">
              <span className="ed-legend-swatch" style={{ background: 'var(--ed-warn)' }} />
              Purchases <span className="ed-legend-value">{formatINR(totalPurchases, { compact: true, withCur: true })}</span>
              <span className="ed-legend-meta">· {purchasesCount} bills</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* Generic single-series area chart with hover tooltip.
 * `tone` ∈ { pos | warn | neg | accent } chooses the line + gradient.
 * On mouse-move we snap to the nearest data index, draw a vertical
 * guide + emphasised dot, and float a tooltip pill with the bucket
 * date + value. Touch users still get the terminal-dot summary. */
function TrendChart({ series, field, tone = 'pos', interval = 'day' }) {
  const W = 800, H = 200, P = 8;
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null); // { i, x_pct, y_pct }

  if (!series || series.length < 2) {
    return (
      <div className="ed-chart-svg-wrap">
        <div className="ed-chart-empty">Not enough data in this period</div>
      </div>
    );
  }

  const values = series.map((s) => Number(s[field] || 0));
  const max = Math.max(1, ...values);
  const n = series.length;

  const xAt = (i) => P + (i * (W - P * 2)) / (n - 1);
  const yAt = (v) => H - P - (v / max) * (H - P * 2);

  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ');
  const areaPath =
    `M ${xAt(0)} ${H - P} ` +
    values.map((v, i) => `L ${xAt(i)} ${yAt(v)}`).join(' ') +
    ` L ${xAt(n - 1)} ${H - P} Z`;

  const xLabels = pickXLabels(series, 5, interval);
  const stroke = `var(--ed-${tone})`;
  const gradId = `ed-grad-trend-${field}-${tone}`;

  const onMove = (e) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const xRel = (e.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(xRel * (n - 1))));
    setHover({
      i,
      x_pct: (xAt(i) / W) * 100,
      y_pct: (yAt(values[i]) / H) * 100,
    });
  };
  const onLeave = () => setHover(null);

  const hi = hover?.i ?? null;
  const hoverRow = hi != null ? series[hi] : null;
  const hoverVal = hi != null ? values[hi] : null;
  const hoverDate = hoverRow ? (hoverRow.d || hoverRow.date) : null;
  const dateFmt = interval === 'month' ? 'MMM YYYY'
                : interval === 'week'  ? '[Week of] D MMM'
                : 'D MMM YYYY';

  return (
    <div
      ref={wrapRef}
      className="ed-chart-svg-wrap"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="ed-chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1={P} x2={W - P} y1={P + (H - P * 2) * t} y2={P + (H - P * 2) * t}
            stroke="var(--ed-line)" strokeDasharray="2 4" strokeWidth="0.6" />
        ))}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={stroke} strokeWidth="1.7" strokeLinejoin="round" />
        {hi != null && (
          <>
            <line x1={xAt(hi)} x2={xAt(hi)} y1={P} y2={H - P}
              stroke={stroke} strokeOpacity="0.4" strokeWidth="0.8" strokeDasharray="2 3" />
            <circle cx={xAt(hi)} cy={yAt(values[hi])} r="5" fill={stroke} fillOpacity="0.18" />
            <circle cx={xAt(hi)} cy={yAt(values[hi])} r="3.2" fill={stroke} />
          </>
        )}
        <circle cx={xAt(n - 1)} cy={yAt(values[n - 1])} r="3.5" fill={stroke} />
      </svg>
      {hi != null && hoverDate && (
        <div
          className={`ed-chart-tip ed-chart-tip--${tone}`}
          style={{
            left:  `${hover.x_pct}%`,
            top:   `${hover.y_pct}%`,
          }}
        >
          <div className="ed-chart-tip-date">{dayjs(hoverDate).format(dateFmt)}</div>
          <div className="ed-chart-tip-val">
            <span className="ed-chart-tip-swatch" />
            {field === 'sales' ? 'Sales' : field === 'purchases' ? 'Purchases' : field}
            <strong>₹{formatINR(hoverVal, { compact: true })}</strong>
          </div>
        </div>
      )}
      <div className="ed-chart-x-labels">
        {xLabels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  );
}

function PlRow({ label, value, pct, total, negVal }) {
  return (
    <div className={`ed-pl-row${total ? ' ed-total' : ''}`}>
      <div className="ed-pl-lbl">{label}</div>
      <div className={`ed-pl-val${value < 0 ? ' ed-neg' : value > 0 ? ' ed-pos' : ''}`}>
        {value < 0 ? '−' : ''}<span className="ed-cur-sm">₹</span>{formatINR(Math.abs(value), { compact: true })}
      </div>
      <div className={`ed-pl-pct${pct < 0 ? ' ed-neg' : pct > 0 ? ' ed-pos' : ''}`}>
        {pct >= 0 ? '' : '−'}{Math.abs(pct).toFixed(1)}%
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  RECEIVABLES — aging buckets + top overdue
 * ═══════════════════════════════════════════════════════════════════════ */
function ReceivablesSection({ aging, insights, business, navigate }) {
  // Prefer enriched business endpoint data (has credit util %), fall back to insights.
  const enrichedOverdue = business?.top_overdue_with_credit?.length
    ? business.top_overdue_with_credit.map(c => ({
        party_id: c.party_id,
        party_name: c.party_name,
        balance: Number(c.outstanding) || 0,
        oldest_days: c.oldest_days,
        credit_used_pct: c.credit_used_pct,
      }))
    : null;
  const grand = aging?.grand || { current: 0, b1: 0, b2: 0, b3: 0, b4: 0, on_account: 0, total: 0 };
  const labels = aging?.bucket_labels || { current: 'Current', b1: '0–30d', b2: '30–60d', b3: '60–90d', b4: '90+d', on_account: 'On A/c' };
  const total = grand.total || 1;
  const buckets = [
    { key: 'current', tone: 'b0', label: labels.current, amount: grand.current || 0, count: countPartiesInBucket(aging, 'current') },
    { key: 'b1',      tone: 'b1', label: labels.b1,      amount: grand.b1      || 0, count: countPartiesInBucket(aging, 'b1') },
    { key: 'b2',      tone: 'b2', label: labels.b2,      amount: grand.b2      || 0, count: countPartiesInBucket(aging, 'b2') },
    { key: 'b3',      tone: 'b3', label: labels.b3,      amount: grand.b3      || 0, count: countPartiesInBucket(aging, 'b3') },
    { key: 'b4',      tone: 'b4', label: labels.b4,      amount: grand.b4      || 0, count: countPartiesInBucket(aging, 'b4') },
  ];
  // On-account / opening money isn't tied to any bill so it can't age into
  // a date bucket — but it IS part of the total. Without this chip the five
  // buckets visibly summed to less than the headline (e.g. 62%), which
  // read as a bug. Only rendered when the amount is non-trivial.
  if ((grand.on_account || 0) > 1) {
    buckets.push({
      key: 'on_account', tone: 'oa', label: labels.on_account || 'On A/c',
      amount: grand.on_account, count: countPartiesInBucket(aging, 'on_account'),
      tip: 'Advances, opening balances and on-account amounts not attached to a specific bill — included in the total but with no bill date to age from.',
    });
  }

  const overdue = (enrichedOverdue || insights?.overdue_receivables || []).slice(0, 5);

  return (
    <section className="ed-section">
      <div className="ed-section-head">
        <div className="ed-section-head-left">
          <div className="ed-section-title">Where money is <em>stuck</em>
            <InfoTip label="Receivables aging" text="Your unpaid customer dues grouped by how long they've been outstanding. The older the bucket (60–90d, 90+d), the higher the risk it won't be collected — focus your follow-ups there." />
          </div>
          <div className="ed-section-sub">Receivables aging · total {formatINR(grand.total || 0, { compact: true, withCur: true })}</div>
        </div>
        <button
          type="button"
          className="ed-section-link"
          onClick={() => navigate('/reports/aging')}
        >
          View all →
        </button>
      </div>

      <div className="ed-panel">
        <div className="ed-aging-summary">
          {buckets.map((b) => {
            const pct = (b.amount / total) * 100;
            return (
              <div key={b.key} className="ed-aging-bucket">
                <div className="ed-aging-bucket-head">
                  <span className={`ed-aging-dot ed-aging-${b.tone}`} />
                  <span className="ed-aging-bucket-label">{b.label}</span>
                  {b.tip && <InfoTip text={b.tip} label={b.label} />}
                </div>
                <div className={`ed-aging-bucket-val${b.tone === 'b3' || b.tone === 'b4' ? ' ed-alert' : ''}`}>
                  <span className="ed-cur">₹</span>{formatINR(b.amount, { compact: true })}
                </div>
                <div className="ed-aging-bucket-meta">{b.count} {b.count === 1 ? 'party' : 'parties'} · {pct.toFixed(0)}%</div>
                <div className="ed-aging-mini-bar">
                  <div className={`ed-aging-mini-fill ed-aging-${b.tone}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        {overdue.length > 0 ? (
          <>
            <table className="ed-data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Age</th>
                  {enrichedOverdue && <th>Credit used</th>}
                  <th className="ed-num">Overdue</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overdue.map((c, i) => {
                  const ageBucket = pickAgeBucket(c.oldest_days);
                  const cu = c.credit_used_pct;
                  const cuTone = cu == null ? 'flat' : cu > 100 ? 'over' : cu > 75 ? 'neg' : cu > 50 ? 'warn' : 'pos';
                  return (
                    <tr key={c.party_id} onClick={() => navigate(`/parties/${c.party_id}`)}>
                      <td>
                        <div className="ed-party-cell">
                          <div className={`ed-party-avatar ed-aging-${ageBucket.tone}${cu != null && cu > 100 ? ' ed-over-limit' : ''}`}>
                            {(c.party_name || '?').slice(0, 1).toUpperCase()}
                          </div>
                          <div>
                            <div className="ed-party-name">{c.party_name}</div>
                            <div className="ed-party-meta">
                              {Number.isFinite(Number(c.oldest_days)) && c.oldest_days != null
                                ? `Oldest bill · ${c.oldest_days}d`
                                : 'No dated bills'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`ed-age-pill ed-aging-${ageBucket.tone}`}>
                          {ageBucket.label}
                        </span>
                      </td>
                      {enrichedOverdue && (
                        <td>
                          {cu == null
                            ? <span className="ed-credit-na">no limit set</span>
                            : <span className={`ed-credit-pill ed-credit-${cuTone}`}>{cu}%</span>}
                        </td>
                      )}
                      <td className="ed-num">
                        <span className="ed-cur-sm">₹</span>{formatINR(c.balance || 0, { compact: true })}
                      </td>
                      <td className="ed-num">
                        <button
                          type="button"
                          className="ed-row-act-btn ed-row-act-primary"
                          onClick={(e) => { e.stopPropagation(); navigate(`/parties/${c.party_id}`); }}
                          title="Send reminder"
                        >
                          →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="ed-panel-foot">
              <span>Top {overdue.length} overdue · sorted by balance</span>
              <span className="ed-strong">{formatINR(overdue.reduce((s, c) => s + (c.balance || 0), 0), { compact: true, withCur: true })}</span>
            </div>
          </>
        ) : (
          <div className="ed-empty-strip">
            <span className="ed-empty-icon">✓</span>
            <span>All clear — no overdue customers at the moment.</span>
          </div>
        )}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  SALES INTELLIGENCE — top customers · top products · customer concentration
 * ═══════════════════════════════════════════════════════════════════════ */
function SalesIntelligenceRow({ insights, business, stats }) {
  // Top customers BY REVENUE (last 90 days) — from the business endpoint's
  // concentration detail. The old code borrowed the top-OVERDUE list here,
  // so a shop whose big buyers pay on time showed "No data" and the panel
  // never answered its actual question ("who do I sell the most to?").
  const topByRevenue = (business?.customer_concentration?.top || []).slice(0, 5);
  const fallbackOverdue = (insights?.overdue_receivables || []).slice(0, 5);
  const topCustomers = topByRevenue.length
    ? topByRevenue.map(c => ({ ...c, amount: c.revenue }))
    : fallbackOverdue.map(c => ({ ...c, amount: c.balance }));
  const usingRevenue = topByRevenue.length > 0;
  const topProducts = (insights?.top_selling_products || []).slice(0, 5);

  // Concentration — straight from the backend (top-5 share of 90-day
  // revenue). The old frontend divided overdue balances by monthly sales:
  // apples ÷ oranges, and it rendered 0% "Low risk" on real data.
  const conc = business?.customer_concentration || null;
  const concPct = conc ? Math.min(100, conc.pct || 0) : 0;
  const concRisk =
    (conc?.risk === 'high')     ? { label: 'High risk',     tone: 'neg'  } :
    (conc?.risk === 'moderate') ? { label: 'Moderate risk', tone: 'warn' } :
                                  { label: 'Low risk',      tone: 'pos'  };

  // Color rotation for the segments
  const segColors = ['s1', 's2', 's3', 's4', 's5'];

  return (
    <section className="ed-row-3col">
      {/* Top customers */}
      <div className="ed-panel">
        <div className="ed-panel-head">
          <div className="ed-panel-title-row">
            <div className="ed-panel-title">Top <em>customers</em>
              <InfoTip label="Top customers" text={usingRevenue
                ? 'Your biggest buyers over the last 90 days, ranked by billed revenue — the relationships your business runs on.'
                : 'Customers who owe you the most right now, by unpaid balance.'} />
            </div>
            <div className="ed-panel-meta">{usingRevenue ? 'By revenue · 90 days' : 'Highest balances'}</div>
          </div>
        </div>
        <div className="ed-topc-list">
          {topCustomers.length === 0 ? (
            <div className="ed-empty-mini">No sales recorded in the last 90 days.</div>
          ) : topCustomers.map((c, i) => {
            const maxAmt = topCustomers[0]?.amount || 1;
            return (
              <div key={c.party_id} className="ed-topc-row">
                <div className="ed-topc-rank">{String(i + 1).padStart(2, '0')}</div>
                <div className="ed-topc-info">
                  <div className="ed-topc-name">{c.party_name}</div>
                  <div className="ed-topc-meta">
                    {usingRevenue
                      ? `${(c.pct || 0).toFixed(1)}% of 90-day sales`
                      : `${c.oldest_days != null ? `${c.oldest_days}d oldest · ` : ''}₹${formatINR(c.amount || 0, { compact: true })}`}
                  </div>
                </div>
                <div className="ed-topc-bar-wrap">
                  <div className="ed-topc-bar" style={{ width: `${((c.amount || 0) / maxAmt) * 100}%` }} />
                </div>
                <div className="ed-topc-value">
                  <span className="ed-cur-sm">₹</span>{formatINR(c.amount || 0, { compact: true })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top products */}
      <div className="ed-panel">
        <div className="ed-panel-head">
          <div className="ed-panel-title-row">
            <div className="ed-panel-title">Top <em>products</em>
              <InfoTip label="Top products" text="Your best-selling items over the last 7 days, ranked by sales value. The FAST / SLOW tag shows how quickly each item is moving off the shelf." />
            </div>
            <div className="ed-panel-meta">Last 7 days</div>
          </div>
        </div>
        <div className="ed-topc-list">
          {topProducts.length === 0 ? (
            <div className="ed-empty-mini">No sales in the last 7 days.</div>
          ) : topProducts.map((p, i) => {
            const velocity = classifyVelocity(p.qty);
            const cat = guessCategoryTone(p.product_name, i);
            return (
              <div key={p.product_id} className="ed-prod-row">
                <div className={`ed-prod-cat ed-prod-cat-${cat}`} />
                <div className="ed-prod-info">
                  <div className="ed-prod-name">{p.product_name}</div>
                  <div className="ed-prod-meta">{Math.round(p.qty)} units · ₹{formatINR((p.value / Math.max(p.qty, 1)) || 0, { compact: true })}/unit</div>
                </div>
                <div className="ed-prod-velocity">
                  <span className={`ed-vel-pill ed-vel-${velocity}`}>{velocity}</span>
                </div>
                <div className="ed-prod-amt">
                  <span className="ed-cur-sm">₹</span>{formatINR(p.value || 0, { compact: true })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Customer concentration */}
      <div className="ed-panel">
        <div className="ed-panel-head">
          <div className="ed-panel-title-row">
            <div className="ed-panel-title">Customer <em>concentration</em>
              <InfoTip label="Customer concentration" text="What share of your last-90-day sales came from just your top 5 customers. A high % is risky — if one of them stops buying or delays payment, your business takes a big hit. Under 30% is low risk." />
            </div>
            <div className="ed-panel-meta">Top 5 · 90-day revenue</div>
          </div>
        </div>
        <div className="ed-conc-wrap">
          {!conc ? (
            <div className="ed-empty-mini">Computing concentration…</div>
          ) : (
            <>
              <div className={`ed-conc-hero ed-conc-hero-${concRisk.tone}`}>
                {concPct.toFixed(0)}<span className="ed-conc-pct">%</span>
              </div>
              <div className="ed-conc-sub">
                of 90-day revenue from your <span className="ed-strong">top {conc.top_n || topByRevenue.length || 5}</span> customers.
                {' '}
                <span className={`ed-${concRisk.tone}`}>{concRisk.label}</span>.
              </div>
              {topByRevenue.length > 0 && (
                <>
                  <div className="ed-conc-bar">
                    {topByRevenue.map((c, i) => (
                      <div
                        key={c.party_id}
                        className={`ed-conc-seg ed-conc-${segColors[i] || 's5'}`}
                        style={{ width: `${Math.min(100, c.pct || 0)}%` }}
                        title={`${c.party_name} · ${(c.pct || 0).toFixed(1)}%`}
                      />
                    ))}
                    <div className="ed-conc-seg ed-conc-rest" style={{ flex: 1 }}>Rest</div>
                  </div>
                  <div className="ed-conc-detail">
                    {topByRevenue.slice(0, 3).map((c, i) => (
                      <div key={c.party_id} className="ed-conc-row">
                        <span className={`ed-conc-marker ed-conc-${segColors[i]}`} />
                        <span className="ed-conc-name">{c.party_name}</span>
                        <span className="ed-conc-val"><span className="ed-cur-sm">₹</span>{formatINR(c.revenue || 0, { compact: true })}</span>
                        <span className="ed-conc-pct-row">{(c.pct || 0).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  OPERATIONAL HEALTH ROW — Working Capital · Inventory · Business Velocity
 * ═══════════════════════════════════════════════════════════════════════ */
function OperationalHealthRow({ business, insights }) {
  if (!business) {
    return (
      <section className="ed-row-3col">
        <div className="ed-panel"><div className="ed-empty-mini">Computing working capital…</div></div>
        <div className="ed-panel"><div className="ed-empty-mini">Computing inventory health…</div></div>
        <div className="ed-panel"><div className="ed-empty-mini">Computing business velocity…</div></div>
      </section>
    );
  }

  const wc = business.working_capital || {};
  const bv = business.business_velocity || {};
  const inv = business.inventory || {};
  const ivb = inv.breakdown || { fast: 0, med: 0, slow: 0, dead: 0 };
  const totalSku = ivb.fast + ivb.med + ivb.slow + ivb.dead || 1;

  // Health tones
  const crTone = wc.current_ratio == null ? 'flat' :
    wc.current_ratio >= 1.5 ? 'pos' :
    wc.current_ratio >= 1.0 ? 'warn' : 'neg';
  const qrTone = wc.quick_ratio == null ? 'flat' :
    wc.quick_ratio >= 1.0 ? 'pos' :
    wc.quick_ratio >= 0.7 ? 'warn' : 'neg';

  const cccTone = bv.ccc == null ? 'flat' :
    bv.ccc < 60 ? 'pos' :
    bv.ccc < 100 ? 'warn' : 'neg';

  return (
    <section className="ed-section">
      <div className="ed-section-head">
        <div className="ed-section-head-left">
          <div className="ed-section-title">Operational <em>health</em>
            <InfoTip label="Operational health" text="A health-check of how your business runs day to day: can you cover short-term dues (working capital), is your stock actually selling (inventory), and how fast does money cycle back to you (velocity)." />
          </div>
          <div className="ed-section-sub">Working capital · inventory · business velocity</div>
        </div>
      </div>
      <div className="ed-row-3col-inner">
        {/* Working capital */}
        <div className="ed-panel">
          <div className="ed-panel-head">
            <div className="ed-panel-title-row">
              <div className="ed-panel-title">Working <em>capital</em>
                <InfoTip label="Working capital" text="Your short-term financial cushion: what you own that turns into cash within a year (cash, dues from customers, stock) versus what you must pay within a year (supplier dues, GST). It answers “can I comfortably cover my near-term bills?”" />
              </div>
              <div className="ed-panel-meta">Liquidity ratios</div>
            </div>
          </div>
          <div className="ed-wc-wrap">
            <div className="ed-wc-grid">
              <div className="ed-wc-tile ed-wc-assets">
                <div className="ed-wc-tile-label">Current assets
                  <InfoTip label="Current assets" text="Things you own that turn into cash within a year: cash in hand and bank, money customers owe you (AR = accounts receivable), and stock on hand." />
                </div>
                <div className="ed-wc-tile-val">
                  <span className="ed-cur">₹</span>{formatINR(wc.current_assets || 0, { compact: true })}
                </div>
                <div className="ed-wc-tile-meta">cash + AR + stock</div>
              </div>
              <div className="ed-wc-tile ed-wc-liab">
                <div className="ed-wc-tile-label">Current liabilities
                  <InfoTip label="Current liabilities" text="What you must pay within a year: money you owe suppliers (AP = accounts payable) plus net GST payable to the government." />
                </div>
                <div className="ed-wc-tile-val">
                  <span className="ed-cur">₹</span>{formatINR(wc.current_liabilities || 0, { compact: true })}
                </div>
                <div className="ed-wc-tile-meta">AP + GST net</div>
              </div>
            </div>
            <div className="ed-wc-net">
              <div className="ed-wc-net-label">Net working capital
                <InfoTip label="Net working capital" text="Current assets minus current liabilities. A positive figure means you can cover all short-term dues and still have a buffer left over; negative means a cash crunch is likely." />
              </div>
              <div className={`ed-wc-net-val ${(wc.net_working_capital || 0) >= 0 ? 'ed-pos-text' : 'ed-neg-text'}`}>
                <span className="ed-cur">₹</span>{formatINR(Math.abs(wc.net_working_capital || 0), { compact: true })}
              </div>
            </div>
            <div className="ed-ratio-grid">
              <div className="ed-ratio">
                <div className="ed-ratio-label">Current ratio
                  <InfoTip label="Current ratio" text="Current assets ÷ current liabilities. 1.5 or higher is healthy; around 1 is tight; below 1 means you may struggle to pay short-term dues on time." />
                </div>
                <div className={`ed-ratio-val ed-ratio-val-${crTone}`}>
                  {wc.current_ratio != null ? wc.current_ratio.toFixed(2) : '—'}
                </div>
                <div className="ed-ratio-bench">
                  Target <span className="ed-pos">≥ 1.5</span>
                </div>
              </div>
              <div className="ed-ratio">
                <div className="ed-ratio-label">Quick ratio
                  <InfoTip label="Quick ratio" text="Like the current ratio but excludes stock (which takes time to sell). Above 1 means you can clear short-term dues from cash and customer payments alone, without relying on selling inventory." />
                </div>
                <div className={`ed-ratio-val ed-ratio-val-${qrTone}`}>
                  {wc.quick_ratio != null ? wc.quick_ratio.toFixed(2) : '—'}
                </div>
                <div className="ed-ratio-bench">
                  Target <span className="ed-pos">≥ 1.0</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Inventory */}
        <div className="ed-panel">
          <div className="ed-panel-head">
            <div className="ed-panel-title-row">
              <div className="ed-panel-title">Inventory <em>health</em>
                <InfoTip label="Inventory health" text="How well your stock is selling. Items are grouped by how fast they move — Fast, Medium, Slow, and Dead (no sale in 60+ days). Dead stock is cash stuck on the shelf you could free up." />
              </div>
              <div className="ed-panel-meta">{totalSku} active SKUs</div>
            </div>
          </div>
          <div className="ed-inv-wrap">
            <div className="ed-inv-stack">
              <div className="ed-inv-seg ed-inv-fast" style={{ width: `${(ivb.fast / totalSku) * 100}%` }} />
              <div className="ed-inv-seg ed-inv-med"  style={{ width: `${(ivb.med  / totalSku) * 100}%` }} />
              <div className="ed-inv-seg ed-inv-slow" style={{ width: `${(ivb.slow / totalSku) * 100}%` }} />
              <div className="ed-inv-seg ed-inv-dead" style={{ width: `${(ivb.dead / totalSku) * 100}%` }} />
            </div>
            <div className="ed-inv-leg">
              <div className="ed-inv-leg-row">
                <span className="ed-inv-leg-dot ed-inv-fast" />
                <span className="ed-inv-leg-name">Fast (&gt; 10/d)</span>
                <span className="ed-inv-leg-num">{ivb.fast}</span>
              </div>
              <div className="ed-inv-leg-row">
                <span className="ed-inv-leg-dot ed-inv-med" />
                <span className="ed-inv-leg-name">Medium (3–10/d)</span>
                <span className="ed-inv-leg-num">{ivb.med}</span>
              </div>
              <div className="ed-inv-leg-row">
                <span className="ed-inv-leg-dot ed-inv-slow" />
                <span className="ed-inv-leg-name">Slow (&lt; 3/d)</span>
                <span className="ed-inv-leg-num">{ivb.slow}</span>
              </div>
              <div className="ed-inv-leg-row">
                <span className="ed-inv-leg-dot ed-inv-dead" />
                <span className="ed-inv-leg-name">Dead (60d+)</span>
                <span className="ed-inv-leg-num">{ivb.dead}</span>
              </div>
            </div>
            <div className="ed-inv-metrics">
              <div className="ed-inv-met">
                <div className="ed-inv-met-label">Stock value
                  <InfoTip label="Stock value" text="Total cost-price value of all goods on hand right now — i.e. how much cash is currently tied up in inventory." />
                </div>
                <div className="ed-inv-met-val">
                  <span className="ed-cur">₹</span>{formatINR(inv.value || 0, { compact: true })}
                </div>
                <div className="ed-inv-met-sub">cost basis · on hand</div>
              </div>
              <div className="ed-inv-met">
                <div className="ed-inv-met-label">Turnover
                  <InfoTip label="Turnover" text="How many times you sell through your entire stock in a year. Higher is better — target 6× or more. Low turnover means cash is sitting in slow-moving goods." />
                </div>
                <div className={`ed-inv-met-val ed-ratio-val-${invTurnoverTone(inv.turnover)}`}>
                  {inv.turnover != null ? inv.turnover.toFixed(1) : '—'}<span className="ed-inv-unit">×/yr</span>
                </div>
                <div className="ed-inv-met-sub">target <span className="ed-pos">≥ 6×</span></div>
              </div>
            </div>
          </div>
        </div>

        {/* Business velocity */}
        <div className="ed-panel">
          <div className="ed-panel-head">
            <div className="ed-panel-title-row">
              <div className="ed-panel-title">Business <em>velocity</em>
                <InfoTip label="Business velocity" text="How quickly money flows through your business — from paying for stock, to selling it, to collecting the cash. Fewer days means your money isn't sitting idle waiting to come back." />
              </div>
              <div className="ed-panel-meta">Cash conversion cycle</div>
            </div>
          </div>
          <div className="ed-opex-wrap">
            <div className="ed-ccc-hero">
              <div className="ed-ccc-label">Cash Conversion Cycle
                <InfoTip label="Cash Conversion Cycle" text="The number of days from paying for stock to getting the cash back after selling it. Lower is better. Formula: DIO (days stock sits) + DSO (days customers take to pay) − DPO (days you take to pay suppliers)." />
              </div>
              <div className={`ed-ccc-val ed-ratio-val-${cccTone}`}>
                {bv.ccc != null ? bv.ccc : '—'}<span className="ed-inv-unit">d</span>
              </div>
              <div className="ed-ccc-formula">DIO {bv.dio ?? '—'} + DSO {bv.dso ?? '—'} − DPO {bv.dpo ?? '—'}</div>
            </div>
            <div className="ed-effic-rows">
              <EfficRow label="DSO" detail="Days Sales Outstanding" value={bv.dso} target={45} cap={80} invert={false}
                tip="Days Sales Outstanding — the average days your customers take to pay you. Lower is better (target under 45 days). High DSO means cash is stuck with customers." />
              <EfficRow label="DPO" detail={bv.dpo != null && bv.dpo < 30 ? 'Paying too fast' : 'Days Payable Outstanding'} value={bv.dpo} target={40} cap={80} invert={true}
                tip="Days Payable Outstanding — the average days you take to pay suppliers. Paying too fast strains your cash; paying very slowly can hurt supplier relationships." />
              <EfficRow label="DIO" detail="Days Inventory Outstanding" value={bv.dio} target={60} cap={120} invert={false}
                tip="Days Inventory Outstanding — the average days stock sits before it's sold. Lower means faster-moving inventory and less cash locked up in goods." />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function EfficRow({ label, detail, value, target, cap, invert, tip }) {
  const v = Number.isFinite(value) ? value : null;
  const pct = v != null ? Math.min(100, (v / cap) * 100) : 0;
  const benchPct = Math.min(100, (target / cap) * 100);

  // Tone: lower is better for DSO/DIO (invert=false), higher is better for DPO (invert=true)
  let tone = 'flat';
  if (v != null) {
    const diff = invert ? (target - v) : (v - target);
    if (Math.abs(diff) / target < 0.1) tone = 'pos';
    else if (Math.abs(diff) / target < 0.25) tone = 'warn';
    else tone = invert ? (diff > 0 ? 'pos' : 'neg') : (diff > 0 ? 'neg' : 'pos');
  }

  // Insufficient data — show muted state instead of misleading 0
  const insufficient = v == null;

  return (
    <div className="ed-effic-row">
      <div className="ed-effic-name">
        <div className="ed-effic-name-row">
          <div className="ed-effic-label">{label}{tip && <InfoTip label={label} text={tip} />}</div>
          <div className="ed-effic-bench">target {target}d</div>
        </div>
        <div className="ed-effic-bar-wrap">
          {!insufficient && <div className={`ed-effic-bar ed-effic-${tone}`} style={{ width: `${pct}%` }} />}
          {!insufficient && <div className="ed-effic-bench-mark" style={{ left: `calc(${benchPct}% - 1px)` }} />}
          {insufficient && <div className="ed-effic-bar-empty" />}
        </div>
        <div className="ed-effic-detail">
          {insufficient ? <span className="ed-effic-insufficient">Not enough activity in last 90 days</span> : detail}
        </div>
      </div>
      <div className="ed-effic-val">
        <div className={`ed-effic-val-num ed-ratio-val-${tone}`}>
          {v != null ? v : '—'}<span className="ed-inv-unit">d</span>
        </div>
      </div>
    </div>
  );
}

function invTurnoverTone(t) {
  if (t == null) return 'flat';
  if (t >= 6) return 'pos';
  if (t >= 4) return 'warn';
  return 'neg';
}

/* ═══════════════════════════════════════════════════════════════════════
 *  INSIGHT BAR — primary (situational) and actions (recommendations)
 * ═══════════════════════════════════════════════════════════════════════ */
function InsightBar({ tone, insight, actions, navigate }) {
  if (tone === 'actions') {
    if (!actions || actions.length === 0) return null;
    const totalImpact = actions.reduce((s, a) => s + (a.impact || 0), 0);
    return (
      <div className="ed-insight ed-insight-actions">
        <div className="ed-insight-icon ed-insight-icon-actions">★</div>
        <div className="ed-insight-body">
          <div className="ed-insight-title">
            {actions.length === 1
              ? <>One action could free up <span className="ed-strong">₹{formatINR(totalImpact, { compact: true })}</span> of working capital.</>
              : <>{actions.length} actions could free up <span className="ed-strong">₹{formatINR(totalImpact, { compact: true })}</span> of working capital this month.</>}
            <InfoTip label="Free up working capital" text="The biggest opportunities to unlock cash that's currently stuck — e.g. trimming excess stock to about 60 days of cover, or clearing dead items. Acting on these puts that money back in your hands." />
          </div>
          <div className="ed-insight-actions-list">
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                className="ed-insight-action"
                onClick={() => navigate && navigate(a.route)}
                title={a.detail}
              >
                <span className="ed-insight-action-title">{a.title}</span>
                <span className="ed-insight-action-impact">{a.impact_label}</span>
                <span className="ed-insight-action-arrow">→</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!insight) return null;
  return (
    <div className={`ed-insight ed-insight-${insight.severity || 'info'}`}>
      <div className="ed-insight-icon">{insight.icon || '◆'}</div>
      <div className="ed-insight-body">
        <div className="ed-insight-title">{insight.title}</div>
        <div className="ed-insight-text">{insight.body}</div>
      </div>
    </div>
  );
}

function buildPrimaryInsight({ stats, insights, aging, business }) {
  if (!stats || !business) return null;

  const wc = business.working_capital || {};
  const bv = business.business_velocity || {};
  const cr = wc.current_ratio;
  const dso = bv.dso;
  const ccc = bv.ccc;
  const overdue60 = (aging?.grand?.b3 || 0) + (aging?.grand?.b4 || 0);

  // Priority 1: Liquidity crisis
  if (cr != null && cr < 1.0) {
    return {
      severity: 'critical',
      icon: '!',
      title: (<><em>Liquidity is tight.</em> Current ratio is {cr.toFixed(2)} — you can't cover short-term obligations from current assets.</>),
      body: (<>
        Current liabilities (<span className="ed-strong">₹{formatINR(wc.current_liabilities, { compact: true })}</span>) exceed current assets
        (<span className="ed-strong">₹{formatINR(wc.current_assets, { compact: true })}</span>). Accelerate collections from overdue customers or delay non-critical payments.
      </>),
    };
  }

  // Priority 2: High DSO + significant overdue
  if (dso != null && dso > 60 && overdue60 > 50000) {
    return {
      severity: 'warn',
      icon: '⏱',
      title: (<><em>Collections are slowing down.</em> DSO is {dso} days vs industry 45.</>),
      body: (<>
        <span className="ed-strong">₹{formatINR(overdue60, { compact: true })}</span> tied up in customers past 60 days.
        {' '}Bringing DSO to 45d would free <span className="ed-pos">₹{formatINR(Math.max(0, (business?.working_capital?.breakdown?.receivables || 0) - (((business?.customer_concentration?.total_revenue_90d || 1) / 90) * 45)), { compact: true })}</span>.
      </>),
    };
  }

  // Priority 3: Inventory inefficiency
  const inv = business.inventory || {};
  if (inv.turnover != null && inv.turnover < 4) {
    return {
      severity: 'warn',
      icon: '⊟',
      title: (<><em>Inventory is moving slowly.</em> Annualised turnover of {inv.turnover.toFixed(1)}× vs target 6×.</>),
      body: (<>
        <span className="ed-strong">₹{formatINR(inv.value || 0, { compact: true })}</span> of stock on hand against
        {' '}<span className="ed-warn">{inv.breakdown?.dead || 0}</span> dead SKUs with no movement in 60 days. Consider clearance pricing.
      </>),
    };
  }

  // Priority 4: Customer concentration
  const cc = business.customer_concentration || {};
  if (cc.risk === 'high') {
    return {
      severity: 'warn',
      icon: '◈',
      title: (<><em>Concentration risk.</em> Top {cc.top_n} customers hold {cc.pct.toFixed(0)}% of revenue.</>),
      body: <>If your top customer leaves, your business takes a significant hit. Consider diversification.</>,
    };
  }

  // Priority 5: Healthy
  return {
    severity: 'pos',
    icon: '✓',
    title: <><em>All key metrics within healthy ranges.</em> Focus on growth.</>,
    body: (<>
      Current ratio <span className="ed-strong">{cr != null ? cr.toFixed(2) : '—'}</span>
      {' '}· DSO <span className="ed-strong">{dso ?? '—'}d</span>
      {' '}· CCC <span className="ed-strong">{ccc ?? '—'}d</span>
      {' '}· Cash <span className="ed-strong">₹{formatINR(business.cash_position || 0, { compact: true })}</span>.
    </>),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
 *  HELPERS
 * ═══════════════════════════════════════════════════════════════════════ */

function greetingForHour(h) {
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function firstNameFromAuth() {
  try {
    const raw = localStorage.getItem('erp-auth');
    if (raw) {
      const obj = JSON.parse(raw);
      const full = obj?.state?.user?.full_name || obj?.user?.full_name || '';
      if (full) return full.trim().split(/\s+/)[0];
    }
  } catch {}
  return 'there';
}

function formatINR(n, { compact = false, withCur = false } = {}) {
  const v = Number(n) || 0;
  const cur = withCur ? '₹' : '';
  // `compact` flag intentionally ignored — operators wanted exact figures
  // everywhere on the dashboard (no K / L / Cr abbreviations). Indian-style
  // grouping (lakh/crore separators) keeps long numbers readable.
  return cur + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
}

function pctDelta(curr, prior) {
  const c = Number(curr) || 0;
  const p = Number(prior) || 0;
  if (!p) return null;
  return ((c - p) / Math.abs(p)) * 100;
}

function deltaTone(delta, kpiTone) {
  // For tones where "up is good" (pos, accent, info) → positive = pos
  // For tones where "up is bad" (warn, neg) → positive = neg
  const upIsGood = ['pos', 'accent', 'info'].includes(kpiTone);
  if (Math.abs(delta) < 0.5) return 'flat';
  const isUp = delta > 0;
  return (upIsGood ? isUp : !isUp) ? 'pos' : 'neg';
}

function deltaIcon(delta) { return delta >= 0 ? '↑' : '↓'; }

function sum(arr, key) { return (arr || []).reduce((s, x) => s + (Number(x[key]) || 0), 0); }

function humanAgo(t) {
  if (!t) return 'just now';
  const sec = Math.max(0, dayjs().diff(t, 'second'));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function pickXLabels(series, n, interval = 'day') {
  if (!series || series.length === 0) return [];
  const step = Math.max(1, Math.floor((series.length - 1) / (n - 1)));
  const out = [];
  // Choose a format that fits the bucket size so weekly/monthly charts
  // don't repeat the same "1 Apr" tick. Week → "D MMM" (start-of-week
  // date); Month → "MMM YY". The series rows expose the bucket start
  // as either `d` (older endpoints) or `date` (newer ones) — accept
  // either so we never silently render empty x-axis ticks.
  const fmt = interval === 'month' ? 'MMM YY' : 'D MMM';
  for (let i = 0; i < n; i++) {
    const idx = Math.min(series.length - 1, i * step);
    const d = series[idx]?.d || series[idx]?.date;
    if (d) out.push(dayjs(d).format(fmt));
  }
  return out;
}

function countPartiesInBucket(aging, bucket) {
  if (!aging?.rows) return 0;
  return aging.rows.filter((r) => Number(r[bucket]) > 0).length;
}

function pickAgeBucket(days) {
  // Null/undefined = the party has no dated open bill (on-account only).
  // Show a neutral dash instead of a misleading green "current".
  if (days == null || !Number.isFinite(Number(days))) return { tone: 'oa', label: '—' };
  if (days <= 0)  return { tone: 'b0', label: 'current' };
  if (days <= 30) return { tone: 'b1', label: `${days}d` };
  if (days <= 60) return { tone: 'b2', label: `${days}d` };
  if (days <= 90) return { tone: 'b3', label: `${days}d` };
  return { tone: 'b4', label: `${days}d` };
}

function classifyVelocity(qty) {
  // qty here is total units over last 7 days from insights endpoint
  const perDay = Number(qty || 0) / 7;
  if (perDay >= 10) return 'fast';
  if (perDay >= 3)  return 'med';
  return 'slow';
}

function guessCategoryTone(name, idx) {
  // Cycle 4 tones so the list reads as varied. Real category mapping
  // ships in Phase 2 when we surface category_id on the top-selling list.
  const cats = ['apparel', 'fabric', 'access', 'footwear'];
  return cats[idx % cats.length];
}

/* Built as a structured insight banner — left accent bar, status icon,
 * bold headline + muted detail, secondary stat chips on the right. Far
 * easier to scan than a wrapping sentence, and the tone (alert / warn /
 * ok) drives the colour palette through .ed-insight-banner--{tone}. */
function buildSituationalSubtitle({ stats, insights, aging }) {
  if (!stats) return { tone: 'idle', icon: 'spinner', headline: 'Loading…', detail: '' };

  const overdue60      = (aging?.grand?.b3 || 0) + (aging?.grand?.b4 || 0);
  const overdue60Count = countPartiesInBucket(aging, 'b3') + countPartiesInBucket(aging, 'b4');
  const ar = stats?.receivables?.total || 0;
  const ap = stats?.payables?.total || 0;

  // Priority 1 — overdue alarm
  if (overdue60 > 0) {
    return {
      tone: 'alert',
      icon: 'alert',
      headline: `${overdue60Count} customer${overdue60Count === 1 ? '' : 's'} over 60 days past due`,
      detail: <>Totalling <strong>₹{formatINR(overdue60, { compact: true })}</strong>. {ar > ap
        ? <>Receivables exceed payables.</>
        : <>Payables exceed receivables.</>}</>,
      chips: [
        { k: 'AR', label: 'Receivables', value: `₹${formatINR(ar, { compact: true })}` },
        { k: 'AP', label: 'Payables',    value: `₹${formatINR(ap, { compact: true })}` },
      ],
    };
  }

  // Priority 2 — dead stock
  const deadValue = insights?.dead_stock?.total_value || 0;
  if (deadValue > 50000) {
    return {
      tone: 'warn',
      icon: 'box',
      headline: `₹${formatINR(deadValue, { compact: true })} stuck in dead stock`,
      detail: <>{insights?.dead_stock?.count || 0} SKUs · zero sales in 60 days. Consider clearance pricing.</>,
      chips: [
        { k: 'SKU',  label: 'SKUs',  value: insights?.dead_stock?.count || 0 },
        { k: 'VAL',  label: 'Value', value: `₹${formatINR(deadValue, { compact: true })}` },
      ],
    };
  }

  // Priority 3 — healthy
  return {
    tone: 'ok',
    icon: 'check',
    headline: 'All key metrics within healthy ranges',
    detail: 'Receivables and payables are balanced — focus on growth.',
    chips: [
      { k: 'AR', label: 'Receivables', value: `₹${formatINR(ar, { compact: true })}` },
      { k: 'AP', label: 'Payables',    value: `₹${formatINR(ap, { compact: true })}` },
    ],
  };
}

/* Banner renderer — keeps PageHeader JSX clean and the styling all in
 * one place. `tone` drives the colour theme; icons are inline SVGs so
 * we don't pull in an icon dep just for these three states. */
function InsightBanner({ tone, icon, headline, detail, chips }) {
  if (!headline) return null;
  const Icon = () => {
    if (icon === 'alert') return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    );
    if (icon === 'box') return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
    );
    if (icon === 'check') return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    );
    return null;
  };
  return (
    <div className={`ed-insight-banner ed-insight-banner--${tone}`}>
      <div className="ed-insight-banner-icon"><Icon /></div>
      <div className="ed-insight-banner-body">
        <div className="ed-insight-banner-headline">{headline}</div>
        {detail && <div className="ed-insight-banner-detail">{detail}</div>}
      </div>
      {chips && chips.length > 0 && (
        <div className="ed-insight-banner-chips">
          {chips.map((c) => (
            <div key={c.k} className="ed-insight-banner-chip">
              <span className="ed-insight-banner-chip-label">{c.label}</span>
              <span className="ed-insight-banner-chip-value">{c.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function buildSalesSub(stats) {
  // Same period + same denominator as the header's Avg-ticket card, so
  // the two "avg" figures on screen can never disagree. (The old version
  // averaged the last-14-day series regardless of the selected period.)
  const count = stats?.monthly_sales_count || 0;
  if (!count) return 'no sales yet this period';
  const avg = (stats?.monthly_sales_excl_gst || 0) / count;
  return `${count} invoices · avg ₹${formatINR(avg, { compact: true })}`;
}

function buildStockSub(stats, insights) {
  const dead = insights?.dead_stock?.count || 0;
  const low = stats?.low_stock_count || 0;
  if (!dead && !low) return 'inventory healthy';
  const parts = [];
  if (dead) parts.push(`${dead} dead SKUs`);
  if (low) parts.push(`${low} low stock`);
  return parts.join(' · ');
}

