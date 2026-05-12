import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../api';
import './dashboard-editorial.css';

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
  const [period, setPeriod]     = useState('30D');   // 7D | 30D | 90D | FY
  const [loading, setLoading]   = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState(null);

  useEffect(() => {
    load();
    // Auto-refresh strategy:
    //   • 5 min — refresh stats + business metrics (these change slowly)
    //   • 60 s  — could refresh today's bill counts but keeping it
    //             simple with the 5-min cadence for now.
    // Tab not visible? Pause the polling. Resume on focus.
    let alive = true;
    const tick = () => { if (alive && !document.hidden) load(); };
    const id = setInterval(tick, 5 * 60 * 1000);
    const onFocus = () => { if (alive) load(); };
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [stRes, sRes, iRes, aRes, bRes] = await Promise.allSettled([
        reportAPI.getDashboard(),
        reportAPI.getDashboardSeries({ interval: 'day', periods: 90 }),
        reportAPI.getDashboardInsights(),
        reportAPI.getAging({ party_type: 'Customer' }),
        reportAPI.getDashboardBusiness(),
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
      <TopBar period={period} setPeriod={setPeriod} lastSyncAt={lastSyncAt} onReload={load} />
      <PageHeader stats={stats} insights={insights} aging={aging} business={business} />
      <KpiStrip stats={stats} series={series} insights={insights} business={business} />
      <MoneyMovementRow stats={stats} series={series} business={business} period={period} />
      <InsightBar tone="primary" insight={buildPrimaryInsight({ stats, insights, aging, business })} />
      <ReceivablesSection aging={aging} insights={insights} business={business} navigate={navigate} />
      <SalesIntelligenceRow insights={insights} business={business} stats={stats} />
      <OperationalHealthRow business={business} insights={insights} />
      <InsightBar tone="actions" actions={business?.actions || []} navigate={navigate} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 *  TOP BAR
 * ═══════════════════════════════════════════════════════════════════════ */
function TopBar({ period, setPeriod, lastSyncAt, onReload }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const synced = lastSyncAt ? humanAgo(lastSyncAt) : 'just now';
  const periods = ['7D', '30D', '90D', 'FY'];
  const range = computeDateRange(period);

  return (
    <div className="ed-topbar">
      <div className="ed-breadcrumb">
        <span>Overview</span>
        <span className="ed-sep">/</span>
        <span className="ed-here">Dashboard</span>
      </div>
      <div className="ed-live">
        <span className="ed-live-dot" />
        live · synced {synced}
      </div>
      <div className="ed-topbar-controls">
        <div className="ed-ctrl-pill ed-ctrl-pill-date">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          {range.label}
        </div>
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
  const avgTicket = stats?.monthly_sales_excl_gst && (series_avg_ticket_count(stats))
    ? stats.monthly_sales_excl_gst / series_avg_ticket_count(stats)
    : 0;

  // Situational subtitle from data
  const subtitle = useMemo(() => buildSituationalSubtitle({ stats, insights, aging }),
    [stats, insights, aging]);

  return (
    <header className="ed-page-head">
      <div className="ed-page-head-left">
        <h1 className="ed-page-title">
          {greeting}, <em>{firstName}</em>
        </h1>
        <div className="ed-page-sub">{subtitle}</div>
      </div>
      <div className="ed-quick-stats">
        <QStat label="Bills today" value={billsToday} sub={`${todaySales} sale · ${todayPurch} purch`} />
        <QStat label="Open bills" value={openSales + openPurch} sub={`${openSales} AR · ${openPurch} AP`} />
        <QStat label="Avg ticket" value={formatINR(avgTicket, { compact: true })} sub="MTD" mono />
        <QStat label="Stock value" value={formatINR(stats?.stock_value?.purchase || 0, { compact: true })} sub={`${stats?.low_stock_count || 0} low`} mono />
      </div>
    </header>
  );
}

function QStat({ label, value, sub, mono }) {
  return (
    <div className="ed-qstat">
      <div className="ed-qstat-label">{label}</div>
      <div className={`ed-qstat-val${mono ? ' ed-tab' : ''}`}>{value}</div>
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
      value: business?.cash_position ?? null,
      sub: cashRunway != null
        ? `${cashRunway} day runway`
        : 'all banks + cash',
      sparkKey: 'receipts',
      delta: null,
      isCurrency: true,
    },
    {
      tone: 'warn',
      label: 'Receivables',
      value: stats?.receivables?.total || 0,
      sub: `${stats?.receivables?.count || 0} parties${insights?.overdue_receivables?.length ? ' · ' + insights.overdue_receivables.length + ' overdue' : ''}`,
      sparkKey: 'sales',
      isCurrency: true,
    },
    {
      tone: 'neg',
      label: 'Payables',
      value: stats?.payables?.total || 0,
      sub: `${stats?.payables?.count || 0} suppliers${insights?.overdue_payables?.length ? ' · ' + insights.overdue_payables.length + ' overdue' : ''}`,
      sparkKey: 'purchases',
      isCurrency: true,
    },
    {
      tone: 'pos',
      label: 'Sales MTD',
      value: stats?.monthly_sales_excl_gst || 0,
      sub: buildSalesSub(stats, last14),
      sparkKey: 'sales',
      delta: pctDelta(stats?.monthly_sales_excl_gst, stats?.prior?.monthly_sales_excl_gst),
      isCurrency: true,
    },
    {
      tone: 'info',
      label: 'Stock value',
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

function KpiCard({ tone, label, value, sub, delta, isCurrency, sparkKey, series }) {
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
function MoneyMovementRow({ stats, series, period }) {
  // Slice series to the selected period
  const days = period === '7D' ? 7 : period === '30D' ? 30 : period === '90D' ? 90 : 90;
  const slice = (series || []).slice(-days);

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
            <div className="ed-panel-title">Cash <em>movement</em></div>
            <div className="ed-panel-meta">Last {days} days</div>
          </div>
        </div>
        <div className="ed-chart-wrap">
          <div className="ed-chart-summary">
            <Csum tone="pos" label="Received" value={received} delta={null} />
            <Csum tone="neg" label="Paid out" value={paid} delta={null} />
            <Csum tone="net" label="Net flow" value={net} delta={null} signed />
            <Csum tone="bal" label="Cash now" value={stats?.cash_position || 0} delta={null} />
          </div>
          <CashFlowChart series={slice} />
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
            <div className="ed-panel-title">Profit & <em>loss</em></div>
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

function Csum({ tone, label, value, delta, signed }) {
  const sign = signed && value > 0 ? '+' : (signed && value < 0 ? '−' : '');
  const display = formatINR(Math.abs(value), { compact: true });
  return (
    <div className={`ed-csum ed-csum-${tone}`}>
      <div className="ed-csum-label">{label}</div>
      <div className={`ed-csum-val ed-csum-val-${tone}`}>
        <span className="ed-cur">₹</span>{sign}{display}
      </div>
      {delta != null && (
        <div className="ed-csum-delta">
          <span className={delta >= 0 ? 'ed-up' : 'ed-down'}>{delta >= 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(1)}%</span> vs prior
        </div>
      )}
    </div>
  );
}

function CashFlowChart({ series }) {
  const W = 800, H = 200, P = 8;
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

  const xLabels = pickXLabels(series, 5);

  return (
    <div className="ed-chart-svg-wrap">
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
        {/* terminal dots */}
        <circle cx={xAt(n - 1)} cy={yAt(receipts[n - 1])} r="3" fill="var(--ed-pos)" />
        <circle cx={xAt(n - 1)} cy={yAt(payments[n - 1])} r="3" fill="var(--ed-neg)" />
      </svg>
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
  const grand = aging?.grand || { current: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0 };
  const labels = aging?.bucket_labels || { current: 'Current', b1: '0–30d', b2: '30–60d', b3: '60–90d', b4: '90+d' };
  const total = grand.total || 1;
  const buckets = [
    { key: 'current', tone: 'b0', label: labels.current, amount: grand.current || 0, count: countPartiesInBucket(aging, 'current') },
    { key: 'b1',      tone: 'b1', label: labels.b1,      amount: grand.b1      || 0, count: countPartiesInBucket(aging, 'b1') },
    { key: 'b2',      tone: 'b2', label: labels.b2,      amount: grand.b2      || 0, count: countPartiesInBucket(aging, 'b2') },
    { key: 'b3',      tone: 'b3', label: labels.b3,      amount: grand.b3      || 0, count: countPartiesInBucket(aging, 'b3') },
    { key: 'b4',      tone: 'b4', label: labels.b4,      amount: grand.b4      || 0, count: countPartiesInBucket(aging, 'b4') },
  ];

  const overdue = (enrichedOverdue || insights?.overdue_receivables || []).slice(0, 5);

  return (
    <section className="ed-section">
      <div className="ed-section-head">
        <div className="ed-section-head-left">
          <div className="ed-section-title">Where money is <em>stuck</em></div>
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
                            <div className="ed-party-meta">Oldest bill · {c.oldest_days}d</div>
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
function SalesIntelligenceRow({ insights, stats }) {
  // Derive top customers from overdue + recent_sales as best available; if we
  // had a top-customer-by-revenue endpoint we'd use it. For now use overdue
  // (which is sorted by balance — proxy for high-volume buyers).
  const topCustomers = (insights?.overdue_receivables || []).slice(0, 5);
  const topProducts = (insights?.top_selling_products || []).slice(0, 5);

  const totalRev = stats?.monthly_sales_excl_gst || 0;
  const topCustBalSum = topCustomers.reduce((s, c) => s + (c.balance || 0), 0);
  const concPct = totalRev ? Math.min(100, (topCustBalSum / totalRev) * 100) : 0;

  const concRisk =
    concPct < 30 ? { label: 'Low risk',      tone: 'pos'  } :
    concPct < 50 ? { label: 'Moderate risk', tone: 'warn' } :
                   { label: 'High risk',     tone: 'neg'  };

  // Color rotation for the segments
  const segColors = ['s1', 's2', 's3', 's4', 's5'];

  return (
    <section className="ed-row-3col">
      {/* Top customers */}
      <div className="ed-panel">
        <div className="ed-panel-head">
          <div className="ed-panel-title-row">
            <div className="ed-panel-title">Top <em>customers</em></div>
            <div className="ed-panel-meta">Highest balances</div>
          </div>
        </div>
        <div className="ed-topc-list">
          {topCustomers.length === 0 ? (
            <div className="ed-empty-mini">No data for this period.</div>
          ) : topCustomers.map((c, i) => {
            const maxBal = topCustomers[0]?.balance || 1;
            return (
              <div key={c.party_id} className="ed-topc-row">
                <div className="ed-topc-rank">{String(i + 1).padStart(2, '0')}</div>
                <div className="ed-topc-info">
                  <div className="ed-topc-name">{c.party_name}</div>
                  <div className="ed-topc-meta">{c.oldest_days}d oldest · ₹{formatINR(c.balance || 0, { compact: true })}</div>
                </div>
                <div className="ed-topc-bar-wrap">
                  <div className="ed-topc-bar" style={{ width: `${(c.balance / maxBal) * 100}%` }} />
                </div>
                <div className="ed-topc-value">
                  <span className="ed-cur-sm">₹</span>{formatINR(c.balance || 0, { compact: true })}
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
            <div className="ed-panel-title">Top <em>products</em></div>
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
            <div className="ed-panel-title">Customer <em>concentration</em></div>
            <div className="ed-panel-meta">Top 5 share</div>
          </div>
        </div>
        <div className="ed-conc-wrap">
          <div className={`ed-conc-hero ed-conc-hero-${concRisk.tone}`}>
            {concPct.toFixed(0)}<span className="ed-conc-pct">%</span>
          </div>
          <div className="ed-conc-sub">
            of receivables held by your <span className="ed-strong">top {topCustomers.length || 5}</span> customers.
            {' '}
            <span className={`ed-${concRisk.tone}`}>{concRisk.label}</span>.
          </div>
          {topCustomers.length > 0 && (
            <>
              <div className="ed-conc-bar">
                {topCustomers.map((c, i) => {
                  const w = totalRev ? (c.balance / totalRev) * 100 : 0;
                  return (
                    <div
                      key={c.party_id}
                      className={`ed-conc-seg ed-conc-${segColors[i] || 's5'}`}
                      style={{ width: `${w}%` }}
                      title={`${c.party_name} · ${w.toFixed(1)}%`}
                    />
                  );
                })}
                <div className="ed-conc-seg ed-conc-rest" style={{ flex: 1 }}>Rest</div>
              </div>
              <div className="ed-conc-detail">
                {topCustomers.slice(0, 3).map((c, i) => (
                  <div key={c.party_id} className="ed-conc-row">
                    <span className={`ed-conc-marker ed-conc-${segColors[i]}`} />
                    <span className="ed-conc-name">{c.party_name}</span>
                    <span className="ed-conc-val"><span className="ed-cur-sm">₹</span>{formatINR(c.balance || 0, { compact: true })}</span>
                    <span className="ed-conc-pct-row">{totalRev ? ((c.balance / totalRev) * 100).toFixed(1) : '0.0'}%</span>
                  </div>
                ))}
              </div>
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
          <div className="ed-section-title">Operational <em>health</em></div>
          <div className="ed-section-sub">Working capital · inventory · business velocity</div>
        </div>
      </div>
      <div className="ed-row-3col-inner">
        {/* Working capital */}
        <div className="ed-panel">
          <div className="ed-panel-head">
            <div className="ed-panel-title-row">
              <div className="ed-panel-title">Working <em>capital</em></div>
              <div className="ed-panel-meta">Liquidity ratios</div>
            </div>
          </div>
          <div className="ed-wc-wrap">
            <div className="ed-wc-grid">
              <div className="ed-wc-tile ed-wc-assets">
                <div className="ed-wc-tile-label">Current assets</div>
                <div className="ed-wc-tile-val">
                  <span className="ed-cur">₹</span>{formatINR(wc.current_assets || 0, { compact: true })}
                </div>
                <div className="ed-wc-tile-meta">cash + AR + stock</div>
              </div>
              <div className="ed-wc-tile ed-wc-liab">
                <div className="ed-wc-tile-label">Current liabilities</div>
                <div className="ed-wc-tile-val">
                  <span className="ed-cur">₹</span>{formatINR(wc.current_liabilities || 0, { compact: true })}
                </div>
                <div className="ed-wc-tile-meta">AP + GST net</div>
              </div>
            </div>
            <div className="ed-wc-net">
              <div className="ed-wc-net-label">Net working capital</div>
              <div className={`ed-wc-net-val ${(wc.net_working_capital || 0) >= 0 ? 'ed-pos-text' : 'ed-neg-text'}`}>
                <span className="ed-cur">₹</span>{formatINR(Math.abs(wc.net_working_capital || 0), { compact: true })}
              </div>
            </div>
            <div className="ed-ratio-grid">
              <div className="ed-ratio">
                <div className="ed-ratio-label">Current ratio</div>
                <div className={`ed-ratio-val ed-ratio-val-${crTone}`}>
                  {wc.current_ratio != null ? wc.current_ratio.toFixed(2) : '—'}
                </div>
                <div className="ed-ratio-bench">
                  Target <span className="ed-pos">≥ 1.5</span>
                </div>
              </div>
              <div className="ed-ratio">
                <div className="ed-ratio-label">Quick ratio</div>
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
              <div className="ed-panel-title">Inventory <em>health</em></div>
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
                <div className="ed-inv-met-label">Stock value</div>
                <div className="ed-inv-met-val">
                  <span className="ed-cur">₹</span>{formatINR(inv.value || 0, { compact: true })}
                </div>
                <div className="ed-inv-met-sub">cost basis · on hand</div>
              </div>
              <div className="ed-inv-met">
                <div className="ed-inv-met-label">Turnover</div>
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
              <div className="ed-panel-title">Business <em>velocity</em></div>
              <div className="ed-panel-meta">Cash conversion cycle</div>
            </div>
          </div>
          <div className="ed-opex-wrap">
            <div className="ed-ccc-hero">
              <div className="ed-ccc-label">Cash Conversion Cycle</div>
              <div className={`ed-ccc-val ed-ratio-val-${cccTone}`}>
                {bv.ccc != null ? bv.ccc : '—'}<span className="ed-inv-unit">d</span>
              </div>
              <div className="ed-ccc-formula">DIO {bv.dio ?? '—'} + DSO {bv.dso ?? '—'} − DPO {bv.dpo ?? '—'}</div>
            </div>
            <div className="ed-effic-rows">
              <EfficRow label="DSO" detail="Days Sales Outstanding" value={bv.dso} target={45} cap={80} invert={false} />
              <EfficRow label="DPO" detail={bv.dpo != null && bv.dpo < 30 ? 'Paying too fast' : 'Days Payable Outstanding'} value={bv.dpo} target={40} cap={80} invert={true} />
              <EfficRow label="DIO" detail="Days Inventory Outstanding" value={bv.dio} target={60} cap={120} invert={false} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function EfficRow({ label, detail, value, target, cap, invert }) {
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
          <div className="ed-effic-label">{label}</div>
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
  if (compact) {
    const abs = Math.abs(v);
    if (abs >= 1e7) return `${cur}${(v / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${cur}${(v / 1e5).toFixed(2)}L`;
    if (abs >= 1e3) return `${cur}${Math.round(v / 1e3)}K`;
    return `${cur}${Math.round(v)}`;
  }
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

function pickXLabels(series, n) {
  if (!series || series.length === 0) return [];
  const step = Math.max(1, Math.floor((series.length - 1) / (n - 1)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(series.length - 1, i * step);
    const d = series[idx]?.d;
    if (d) out.push(dayjs(d).format('D MMM'));
  }
  return out;
}

function countPartiesInBucket(aging, bucket) {
  if (!aging?.rows) return 0;
  return aging.rows.filter((r) => Number(r[bucket]) > 0).length;
}

function pickAgeBucket(days) {
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

function buildSituationalSubtitle({ stats, insights, aging }) {
  if (!stats) return 'Loading…';
  const overdue60 = (aging?.grand?.b3 || 0) + (aging?.grand?.b4 || 0);
  const overdue60Count = countPartiesInBucket(aging, 'b3') + countPartiesInBucket(aging, 'b4');
  const cash = stats?.cash_position ?? null;
  const ar = stats?.receivables?.total || 0;
  const ap = stats?.payables?.total || 0;

  // Priority 1: overdue alarm
  if (overdue60 > 0) {
    return (
      <>
        You have <span className="ed-alert">{overdue60Count} customer{overdue60Count === 1 ? '' : 's'}</span>
        {' '}over 60 days past due totalling <span className="ed-strong">₹{formatINR(overdue60, { compact: true })}</span>.
        {' '}{ar > ap
          ? <>Receivables (<span className="ed-strong">₹{formatINR(ar, { compact: true })}</span>) outweigh payables.</>
          : <>Payables (<span className="ed-strong">₹{formatINR(ap, { compact: true })}</span>) outweigh receivables.</>}
      </>
    );
  }

  // Priority 2: dead stock
  const deadValue = insights?.dead_stock?.total_value || 0;
  if (deadValue > 50000) {
    return (
      <>
        <span className="ed-strong">₹{formatINR(deadValue, { compact: true })}</span> of stock has had zero sales in 60 days
        {' '}({insights?.dead_stock?.count || 0} SKUs). Consider clearance pricing to free working capital.
      </>
    );
  }

  // Priority 3: healthy
  return (
    <>
      All key metrics within healthy ranges. Receivables <span className="ed-strong">₹{formatINR(ar, { compact: true })}</span>
      {' '}· Payables <span className="ed-strong">₹{formatINR(ap, { compact: true })}</span>
      {' '}· Focus on growth.
    </>
  );
}

function buildSalesSub(stats, last14) {
  const count = stats?.monthly_sales_excl_gst && last14.length
    ? sum(last14, 'sales_count')
    : 0;
  const avg = count ? (sum(last14, 'sales') / count) : 0;
  if (!count) return 'no sales yet this month';
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

function series_avg_ticket_count(stats) {
  // Defensive — if backend doesn't surface count, fall back.
  return stats?.monthly_sales_count || 1;
}
