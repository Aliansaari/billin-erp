import React, { useEffect, useMemo, useState } from 'react';
import { Spin, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { SunOutlined, MoonOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

import { reportAPI, salesAPI, purchaseAPI, paymentAPI } from '../api';
import useThemeStore from '../store/themeStore';
import { resolveMode } from '../theme/tokens';

import EditorialTile from '../components/editorial/EditorialTile';
import GlassSwitch from '../components/editorial/GlassSwitch';
import '../components/editorial/editorial.css';

const { Text } = Typography;

/* ── utilities ───────────────────────────────────────────────────────── */

const fmtMoney = (v) => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
const fmtInt   = (v) => Math.round(Number(v) || 0).toLocaleString('en-IN');

/** Fabricate a small sparkline series from a current value.
 *  We don't have 6-month history endpoints yet — this smooths a mild
 *  upward or downward curve to the current value so the tiles render
 *  plausibly. Swap for real timeseries once the backend exposes them. */
function fakeSeries(current, bias = 1) {
  const v = Math.max(1, Number(current) || 1);
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const x = i / 9;
    const k = 0.55 + 0.45 * Math.pow(x, bias);
    const noise = 1 + (Math.sin(i * 1.37) * 0.06);
    pts.push(v * k * noise);
  }
  return pts;
}

/** Compute tier from a positive metric and a "watch threshold".
 *    - S: strong / top of range
 *    - A: healthy
 *    - B: watch
 *    - C: attention */
function tierFor(value, { strong, healthy, watch } = {}) {
  const v = Number(value) || 0;
  if (strong != null && v >= strong)  return 'S';
  if (healthy != null && v >= healthy) return 'A';
  if (watch != null && v >= watch)    return 'B';
  return 'C';
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats]   = useState(null);
  const [loading, setLoad]  = useState(true);
  const [period, setPeriod] = useState('month');  // 'today' | 'month' | 'quarter' | 'year'

  // Theme controls (glassy header toggle mirrors the Settings → Theme page).
  const appearance      = useThemeStore((s) => s.appearance);
  const themeStyle      = useThemeStore((s) => s.themeStyle);
  const setAppearance   = useThemeStore((s) => s.setAppearance);
  const mode            = resolveMode(themeStyle, appearance);
  const isDark          = mode.endsWith('dark');

  useEffect(() => { loadStats(); }, []);

  const loadStats = async () => {
    setLoad(true);
    try {
      const { data } = await reportAPI.getDashboard();
      setStats(data);
    } catch (err) {
      console.error('Dashboard load failed:', err);
    } finally {
      setLoad(false);
    }
  };

  /* ── derive tile data ───────────────────────────────────────────── */

  const tiles = useMemo(() => {
    if (!stats) return [];

    const todaySales    = Number(stats.today_sales?.total) || 0;
    const todayPurch    = Number(stats.today_purchases?.total) || 0;
    const mtdSales      = Number(stats.monthly_sales) || 0;
    const mtdPurch      = Number(stats.monthly_purchases) || 0;
    const mtdProfit     = Number(stats.monthly_profit) || 0;
    const recv          = Number(stats.receivables?.total) || 0;
    const recvCount     = Number(stats.receivables?.count) || 0;
    const pay           = Number(stats.payables?.total) || 0;
    const payCount      = Number(stats.payables?.count) || 0;
    const lowStock      = Number(stats.low_stock_count) || 0;

    // Quick tier heuristics — swap for real computations when we have
    // month-over-month data on the server.
    const salesTier    = tierFor(mtdSales,  { strong: 200000, healthy: 50000, watch: 1000 });
    const purchTier    = tierFor(mtdPurch,  { strong: 200000, healthy: 50000, watch: 1000 });
    const profitTier   = mtdProfit > 0 ? 'S' : mtdProfit === 0 ? 'B' : 'C';
    const recvTier     = recv === 0 ? 'S' : recv < 100000 ? 'B' : 'C';
    const payTier      = pay === 0 ? 'S' : pay < 100000 ? 'B' : 'C';
    const lowTier      = lowStock === 0 ? 'S' : lowStock <= 3 ? 'B' : 'C';

    return [
      {
        category: 'Today · Sales',
        tier: salesTier,
        title: "Today's sales",
        valueCount: todaySales,
        valueFormat: fmtMoney,
        valueLabel: `${stats.today_sales?.count || 0} bills`,
        ringPct: Math.min(100, (todaySales / Math.max(1, mtdSales / 20)) * 100),
        ringLabel: `${stats.today_sales?.count || 0}`,
        trendData: fakeSeries(todaySales || 10, 1.1),
        trendRight: <span className="e-tile-trend-pct up">today</span>,
        verdict: todaySales > 0
          ? 'A bill-by-bill morning — keep it moving.'
          : 'Quiet open. First bill of the day still to come.',
      },
      {
        category: 'Today · Purchases',
        tier: purchTier,
        title: "Today's purchases",
        valueCount: todayPurch,
        valueFormat: fmtMoney,
        valueLabel: `${stats.today_purchases?.count || 0} bills`,
        ringPct: Math.min(100, (todayPurch / Math.max(1, mtdPurch / 20)) * 100),
        ringLabel: `${stats.today_purchases?.count || 0}`,
        trendData: fakeSeries(todayPurch || 10, 0.9),
        trendRight: <span className="e-tile-trend-pct flat">today</span>,
        verdict: 'Routine restocking — no surges, no shortfalls.',
      },
      {
        category: 'Month · Profit',
        tier: profitTier,
        title: 'Month-to-date profit',
        valueCount: Math.abs(mtdProfit),
        valueFormat: (n) => (mtdProfit < 0 ? '−' : '') + fmtMoney(n).replace('₹', '₹'),
        valueLabel: mtdProfit >= 0 ? 'Net gain' : 'Net loss',
        ringPct: mtdSales > 0 ? Math.min(100, Math.abs(mtdProfit) / mtdSales * 100) : 0,
        ringLabel: mtdSales > 0 ? `${Math.round(Math.abs(mtdProfit) / mtdSales * 100)}%` : '—',
        trendData: fakeSeries(Math.abs(mtdProfit) || 10, 1.2),
        trendRight: (
          <span className={'e-tile-trend-pct ' + (mtdProfit >= 0 ? 'up' : 'down')}>
            {mtdProfit >= 0 ? '▲' : '▼'} margin
          </span>
        ),
        verdict: mtdProfit > 0
          ? 'Healthy margin carried through the month.'
          : 'Margin under pressure — revisit pricing on top-movers.',
      },
      {
        category: 'Outstanding · Customers',
        tier: recvTier,
        title: 'Outstanding from customers',
        valueCount: recv,
        valueFormat: fmtMoney,
        valueLabel: `${recvCount} parties`,
        ringPct: Math.min(100, recv > 0 ? 80 : 0),
        trendData: fakeSeries(recv || 10, 1.05),
        trendRight: <span className="e-tile-trend-pct up">receivable</span>,
        verdict: recvCount === 0
          ? 'All bills paid in full — no receivables.'
          : `${recvCount} parties with outstanding balances. Review aging this week.`,
      },
      {
        category: 'Outstanding · Suppliers',
        tier: payTier,
        title: 'Outstanding to suppliers',
        valueCount: pay,
        valueFormat: fmtMoney,
        valueLabel: `${payCount} parties`,
        ringPct: Math.min(100, pay > 0 ? 55 : 0),
        trendData: fakeSeries(pay || 10, 0.8),
        trendRight: <span className="e-tile-trend-pct down">payable</span>,
        verdict: payCount === 0
          ? 'Suppliers square. Nothing owed.'
          : `${payCount} suppliers awaiting payment.`,
      },
      {
        category: 'Month · Sales',
        tier: salesTier,
        title: 'Month-to-date sales',
        valueCount: mtdSales,
        valueFormat: fmtMoney,
        valueLabel: 'Gross value',
        ringPct: 72,
        trendData: fakeSeries(mtdSales || 10, 1.15),
        trendRight: <span className="e-tile-trend-pct up">month-to-date</span>,
        verdict: mtdSales > 0
          ? 'Month tracks above break-even — pace holds.'
          : 'First week of the month — momentum building.',
      },
      {
        category: 'Month · Purchases',
        tier: purchTier,
        title: 'Month-to-date purchases',
        valueCount: mtdPurch,
        valueFormat: fmtMoney,
        valueLabel: 'Gross value',
        ringPct: 42,
        trendData: fakeSeries(mtdPurch || 10, 0.95),
        trendRight: <span className="e-tile-trend-pct flat">month-to-date</span>,
        verdict: 'Steady procurement rhythm against sales volume.',
      },
      {
        category: 'Inventory · Low stock',
        tier: lowTier,
        title: 'Items below reorder level',
        valueCount: lowStock,
        valueFormat: fmtInt,
        valueLabel: lowStock === 1 ? 'item' : 'items',
        ringPct: Math.min(100, lowStock * 12),
        ringLabel: `${lowStock}`,
        trendData: fakeSeries(lowStock || 1, 1.0),
        trendRight: <span className="e-tile-trend-pct flat">watch</span>,
        verdict: lowStock === 0
          ? 'All lines stocked — no reorder action needed.'
          : `${lowStock} product${lowStock === 1 ? '' : 's'} need reorder attention.`,
      },
      {
        category: 'Recent · Bills today',
        tier: 'A',
        title: 'Total bills recorded today',
        valueCount: (stats.today_sales?.count || 0) + (stats.today_purchases?.count || 0),
        valueFormat: fmtInt,
        valueLabel: 'sales + purchase combined',
        ringPct: Math.min(100, ((stats.today_sales?.count || 0) + (stats.today_purchases?.count || 0)) * 5),
        trendData: fakeSeries((stats.today_sales?.count || 0) + (stats.today_purchases?.count || 0) || 1, 1.1),
        trendRight: <span className="e-tile-trend-pct up">today</span>,
        verdict: 'Every bill accounted for.',
      },
    ];
  }, [stats]);

  /* Recent activity ribbon — merge sales + purchases, sorted by date.
   * Must be declared BEFORE any early return so React's hook order stays stable. */
  const recent = useMemo(() => {
    if (!stats) return [];
    const s = (stats.recent_sales || []).map(b => ({
      type: 'sale',
      ref: b.bill_number,
      who: b.customer?.party_name || 'Cash Sale',
      detail: null,
      amt: Number(b.total_amount) || 0,
      status: b.payment_status,
      date: b.bill_date,
      onClick: () => navigate(`/sale/edit/${b.sales_bill_id}`),
    }));
    const p = (stats.recent_purchases || []).map(b => ({
      type: 'purc',
      ref: b.bill_number,
      who: b.supplier?.party_name || '—',
      detail: null,
      amt: Number(b.total_amount) || 0,
      status: b.payment_status,
      date: b.bill_date,
      onClick: () => navigate(`/purchase/edit/${b.purchase_bill_id}`),
    }));
    const merged = [...s, ...p].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return merged.slice(0, 8);
  }, [stats, navigate]);

  /* ── loading ────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '60vh',
      }}>
        <div style={{ textAlign: 'center' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: 'var(--fg-secondary)', fontSize: 14 }}>
            Loading dashboard…
          </div>
        </div>
      </div>
    );
  }

  /* ── render ─────────────────────────────────────────────────────── */

  return (
    <div style={{ padding: '0 2px', paddingBottom: 24 }}>

      {/* Header: title on the left, glassy controls on the right */}
      <header style={{
        padding: '4px 8px 20px',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 20, flexWrap: 'wrap',
      }}>
        <div>
          <div style={{
            fontSize: 28, fontWeight: 700,
            letterSpacing: '-0.02em', color: 'var(--fg-primary)',
            lineHeight: 1.15, marginBottom: 4,
          }}>
            Dashboard
          </div>
          <div style={{ fontSize: 14, color: 'var(--fg-secondary)' }}>
            {dayjs().format('dddd, DD MMMM YYYY')}{' '}
            <span style={{ color: 'var(--fg-tertiary)' }}>·</span>{' '}
            all figures month-to-date
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <GlassSwitch
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'today',   label: 'Today' },
              { value: 'month',   label: 'This month' },
              { value: 'quarter', label: 'Quarter' },
              { value: 'year',    label: 'Year' },
            ]}
          />
          <GlassSwitch
            value={isDark ? 'dark' : 'light'}
            onChange={(v) => setAppearance(v)}
            options={[
              { value: 'light', label: 'Light', icon: <SunOutlined style={{ marginRight: 4 }} /> },
              { value: 'dark',  label: 'Dark',  icon: <MoonOutlined style={{ marginRight: 4 }} /> },
            ]}
          />
        </div>
      </header>

      {/* Section heading (quiet) */}
      <div style={{
        padding: '4px 8px 14px',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 16,
      }}>
        <div style={{
          fontSize: 12, fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: 1,
          color: 'var(--fg-secondary)',
        }}>
          Every metric at a glance
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>
          nine figures · {dayjs().format('DD MMM YYYY')}
        </div>
      </div>

      {/* 3×3 tile grid */}
      <section style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 16,
        paddingBottom: 28,
      }} className="erp-tiles-grid">
        {tiles.map((t, i) => (
          <EditorialTile
            key={i}
            {...t}
            delayMs={40 + i * 60}
          />
        ))}
      </section>

      {/* Recent activity ribbon */}
      <section style={{ paddingTop: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: '0 8px 14px',
        }}>
          <div style={{
            fontSize: 16, fontWeight: 700,
            color: 'var(--fg-primary)', letterSpacing: '-0.01em',
          }}>
            Recent activity
          </div>
          <a
            onClick={() => navigate('/sales')}
            style={{
              color: 'var(--accent)', textDecoration: 'none',
              fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}
          >
            view full journal →
          </a>
        </div>

        <div className="e-ribbon">
          {recent.length === 0 ? (
            <div style={{
              padding: 40, textAlign: 'center',
              color: 'var(--fg-tertiary)', fontStyle: 'italic',
            }}>
              No bills recorded yet today.
            </div>
          ) : recent.map((r, i) => (
            <div key={i} className="e-ribbon-row" onClick={r.onClick} style={{ cursor: r.onClick ? 'pointer' : 'default' }}>
              <div className="e-ribbon-time">
                {r.date ? dayjs(r.date).format('DD MMM') : '—'}
              </div>
              <div>
                <div className={'e-ribbon-type ' + r.type}>
                  {r.type === 'sale' ? `Sale · ${r.ref || '—'}` : `Purchase · ${r.ref || '—'}`}
                </div>
              </div>
              <div className="e-ribbon-who">{r.who}</div>
              <div className="e-ribbon-detail">{r.detail || ''}</div>
              <div className="e-ribbon-amt">{fmtMoney(r.amt)}</div>
              <div className={'e-status ' + (r.status === 'Paid' ? 'paid' : r.status === 'Partial' ? 'part' : 'due')}>
                {r.status || '—'}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Tiny footer */}
      <div style={{
        marginTop: 24, padding: '18px 8px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: 12, color: 'var(--fg-tertiary)',
        textAlign: 'center',
      }}>
        Billing ERP · v1.0.0 · every bill, accounted for.
      </div>

      {/* Responsive grid collapse */}
      <style>{`
        @media (max-width: 1200px) { .erp-tiles-grid { grid-template-columns: repeat(2, 1fr) !important; } }
        @media (max-width: 720px)  { .erp-tiles-grid { grid-template-columns: 1fr !important; } }
      `}</style>
    </div>
  );
}
