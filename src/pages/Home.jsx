import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  ShoppingCartOutlined, InboxOutlined, DollarCircleOutlined, CreditCardOutlined,
  BarChartOutlined, DashboardOutlined, RollbackOutlined, AuditOutlined,
  TeamOutlined, ProductOutlined, BookOutlined, BankOutlined, FundOutlined,
} from '@ant-design/icons';

import { reportAPI } from '../api';
import useAuthStore         from '../store/authStore';
import useHomeSettingsStore from '../store/homeSettingsStore';

import Sparkline from '../components/editorial/Sparkline';
import { GlobalSearchHero } from '../components/GlobalSearch';
import './home.css';

/* ──────────────────────────────────────────────────────────────────────────
 * Home — the Command Center landing page (route /).
 *
 * Three pinned regions inside a fixed-height viewport shell — never scrolls,
 * never blinks on refresh:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │  KPI ribbon · 5 editorial cards (settings-driven)      │  ← top, fixed
 *   ├────────────────────────────────────────────────────────┤
 *   │                  GREETING · NAME                       │
 *   │           ┌─ 01:17 ─────────────────────────┐          │
 *   │           │   TUESDAY · 05 MAY 2026         │          │  ← middle,
 *   │           └─────────────────────────────────┘          │     centered,
 *   │       What would you like to do?                       │     absorbs
 *   │  ┌──────────── Search anything ─────── ⌘K ────────┐   │     slack
 *   │  └────────────────────────────────────────────────┘    │
 *   ├────────────────────────────────────────────────────────┤
 *   │  [Sale ⌥S] [Purchase ⌥P] [Receipt F6] [Pay F7] …       │  ← bottom, fixed
 *   └────────────────────────────────────────────────────────┘
 *
 * Anti-flicker discipline:
 *   - homeSettingsStore (Zustand + persist) hydrates synchronously, so the
 *     first paint already respects the operator's chosen layout — no flash
 *     of "default everything → user's prefs."
 *   - The clock is initialised in a lazy useState so the first render shows
 *     the correct time, not "—" then jump.
 *   - KPI tiles render skeleton placeholders with the SAME geometry as the
 *     loaded tiles, so the layout never reflows when stats arrive.
 *   - The page wraps a fixed-height shell (height: 100%) inside AppLayout's
 *     full-page Content (height: 100vh, overflow: hidden), so resizing or
 *     refreshing keeps the action ribbon flush to the viewport bottom.
 * ────────────────────────────────────────────────────────────────────────── */

const fmtInt = (v) => Math.round(Number(v) || 0).toLocaleString('en-IN');

/* Full ₹ — show the exact rupee amount with Indian-style grouping (lakh/crore
 * separators) instead of K / L / Cr abbreviations. Operators wanted the
 * precise figure visible at a glance, even on the KPI tiles. */
function fmtCompact(v) {
  const n = Number(v) || 0;
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

/* Smooth a small upward curve to a current value so the sparkline renders
 * plausibly while we wait on a real timeseries endpoint. Same shape as
 * EditorialTile's helper — kept inline to avoid a shared util that would
 * only have two callers. */
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

function greetingFor(hour) {
  if (hour < 5)  return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Burning the midnight oil';
}

/* Canonical action catalog. Each id is referenced by homeSettingsStore.
 * Order here is the default; the user-chosen `actions` array overrides.
 *
 * Shortcut conventions (locked with the user 2026-05-06):
 *   ctrlKey = direct jump  → 1 keystroke (Ctrl+S → /sale/new)
 *   altKey  = menu opener  → 2 keystrokes (Alt+S opens Sales menu;
 *                            press the underlined letter inside)
 *   fKey    = function key (F6 / F7) — direct, fires from any focus
 *
 * Cards advertise the FASTEST keystroke for their target. Customers /
 * Products / Reports show altKey because there's no direct Ctrl jump
 * for them — the operator opens the menu, picks the item.
 */
const ACTION_CATALOG = {
  // Bare-noun labels match what operators type — see the global search
  // ACTIONS comment for the full rationale. Sub-line carries the verb.
  'sale-new':       { icon: ShoppingCartOutlined, label: 'Sale',           sub: 'New customer invoice',  route: '/sale/new',              ctrlKey: 'S' },
  'purchase-new':   { icon: InboxOutlined,        label: 'Purchase',       sub: 'New supplier bill',     route: '/purchase/new',          ctrlKey: 'P' },
  'receipt-new':    { icon: DollarCircleOutlined, label: 'Receipt',        sub: 'Money in',              route: '/receipt/new',           fKey:  'F6'  },
  'payment-new':    { icon: CreditCardOutlined,   label: 'Payment',        sub: 'Money out',             route: '/payment/new',           fKey:  'F7'  },
  'sales-return':   { icon: RollbackOutlined,     label: 'Sales return',   sub: 'Credit note',           route: '/sales-return/new'                    },
  'purchase-return':{ icon: RollbackOutlined,     label: 'Purchase return',sub: 'Debit note',            route: '/purchase-return/new'                 },
  'journal-new':    { icon: AuditOutlined,        label: 'Journal',        sub: 'Manual entry',          route: '/accounts/journal/new'                },
  'expense-new':    { icon: FundOutlined,         label: 'Expense',        sub: 'Book a P&L expense',    route: '/expenses/new'                        },
  'expenses':       { icon: FundOutlined,         label: 'Expenses',       sub: 'List + report',         route: '/expenses'                            },
  'customers':      { icon: TeamOutlined,         label: 'Customers',      sub: 'Party master',          route: '/customers',             altKey: 'E'  },
  'suppliers':      { icon: TeamOutlined,         label: 'Suppliers',      sub: 'Vendor master',         route: '/suppliers',             altKey: 'E'  },
  'products':       { icon: ProductOutlined,      label: 'Products',       sub: 'Item master',           route: '/products',              altKey: 'I'  },
  'reports':        { icon: BarChartOutlined,     label: 'Reports',        sub: 'All reports',           route: '/reports',               altKey: 'R'  },
  'dashboard':      { icon: DashboardOutlined,    label: 'Dashboard',      sub: 'Every metric',          route: '/dashboard',             ctrlKey: 'D' },
  'day-book':       { icon: BookOutlined,         label: 'Day book',       sub: 'All vouchers · today',  route: '/reports/day-book'                    },
  'banks':          { icon: BankOutlined,         label: 'Banks',          sub: 'Reconciliation',        route: '/banks',                 altKey: 'B'  },
};

const IS_MAC    = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const altLabel  = (k) => (IS_MAC ? `⌥${k}` : `Alt+${k}`);
const ctrlLabel = (k) => (IS_MAC ? `⌃${k}` : `Ctrl+${k}`);

export default function Home() {
  const navigate = useNavigate();
  const user     = useAuthStore((s) => s.user);

  /* Pull every visibility flag in one shot. Subscribing to the whole store
   * is cheap here — Home re-renders on layout changes, which is what we
   * want, and there are no other commits while idle. */
  const cfg = useHomeSettingsStore();

  const [stats,   setStats]   = useState(null);
  const [loading, setLoading] = useState(true);

  /* Lazy initial — first render already shows the correct time, not "—". */
  const [now, setNow] = useState(() => dayjs());

  /* Tick once a second when seconds are visible (so the seconds digits
   * advance smoothly), otherwise once every 30s — minutes-only display
   * doesn't need a faster pulse, and the slower interval keeps idle CPU
   * near zero. Cleanup on unmount. */
  useEffect(() => {
    if (!cfg.showClock) return;
    const id = setInterval(() => setNow(dayjs()), cfg.showSeconds ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [cfg.showClock, cfg.showSeconds]);

  /* Publish the available space below the search input (above the action
   * ribbon) as a CSS custom property so the search dropdown can cap its
   * own max-height to fit cleanly without overlapping the bottom ribbon.
   * Pure-CSS clamp can't know the real ribbon position; this measure is.
   * Re-runs on resize and on every layout-affecting cfg change. */
  useLayoutEffect(() => {
    const recalc = () => {
      const input  = document.querySelector('.cc-search-section .gs-input-wrap');
      const ribbon = document.querySelector('.cc-actions');
      if (!input) {
        document.documentElement.style.removeProperty('--cc-results-max-h');
        return;
      }
      const inputBottom = input.getBoundingClientRect().bottom;
      const ribbonTop   = ribbon ? ribbon.getBoundingClientRect().top : window.innerHeight;
      /* 24px buffer keeps the dropdown shadow comfortably clear of the
       * ribbon. Floor at 160px so the dropdown is always usable even on
       * tiny windows. */
      const max = Math.max(160, Math.floor(ribbonTop - inputBottom - 24));
      document.documentElement.style.setProperty('--cc-results-max-h', `${max}px`);
    };
    recalc();
    window.addEventListener('resize', recalc);
    return () => {
      window.removeEventListener('resize', recalc);
      document.documentElement.style.removeProperty('--cc-results-max-h');
    };
  }, [cfg.showActionRibbon, cfg.showKpiStrip, cfg.showClock, cfg.showHeadline, cfg.showGreeting, cfg.showSearch]);

  /* KPI fetch — the dashboard endpoint serves both this page and /dashboard.
   * The cancellation guard prevents a state set after unmount during the
   * initial paint → quick-navigate-away race. */
  useEffect(() => {
    if (!cfg.showKpiStrip) return;
    let cancelled = false;
    setLoading(true);
    reportAPI.getDashboard()
      .then(({ data }) => { if (!cancelled) setStats(data); })
      .catch((err) => console.error('Home KPI load failed:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cfg.showKpiStrip]);

  /* Build the KPI list. Always returns five entries with stable shape so
   * the placeholder layout matches the loaded layout exactly — no reflow
   * when stats arrive. Visible-flag filtering happens in render. */
  const kpis = useMemo(() => {
    const placeholder = (id, label, tone) => ({
      id, label, value: '—', detail: 'Loading…',
      tone, spark: fakeSeries(10, 1), onClick: () => {},
    });
    if (!stats) {
      return [
        placeholder('sales',  'Sales today',  'muted'),
        placeholder('bills',  'Bills today',  'accent'),
        placeholder('recv',   'Receivables',  'muted'),
        placeholder('pay',    'Payables',     'muted'),
        placeholder('profit', 'Profit · MTD', 'muted'),
      ];
    }
    const todaySales = Number(stats.today_sales?.total) || 0;
    const todayCount = Number(stats.today_sales?.count) || 0;
    const purchCount = Number(stats.today_purchases?.count) || 0;
    const recv       = Number(stats.receivables?.total) || 0;
    const recvCount  = Number(stats.receivables?.count) || 0;
    const pay        = Number(stats.payables?.total) || 0;
    const payCount   = Number(stats.payables?.count) || 0;
    const profit     = Number(stats.monthly_profit) || 0;

    return [
      {
        id: 'sales', label: 'Sales today',
        value: fmtCompact(todaySales),
        detail: `${todayCount} bill${todayCount === 1 ? '' : 's'} · today`,
        tone:  todaySales > 0 ? 'good' : 'muted',
        spark: fakeSeries(todaySales || 10, 1.1),
        onClick: () => navigate('/sales'),
      },
      {
        id: 'bills', label: 'Bills today',
        value: fmtInt(todayCount + purchCount),
        detail: `${todayCount} sales · ${purchCount} purchase`,
        tone:  'accent',
        spark: fakeSeries((todayCount + purchCount) || 1, 1.0),
        onClick: () => navigate('/sales'),
      },
      {
        id: 'recv', label: 'Receivables',
        value: fmtCompact(recv),
        detail: recvCount === 0 ? 'All squared' : `${recvCount} part${recvCount === 1 ? 'y' : 'ies'} pending`,
        tone:  recv > 0 ? 'warn' : 'good',
        spark: fakeSeries(recv || 10, 1.05),
        onClick: () => navigate('/reports/receivables-aging'),
      },
      {
        id: 'pay', label: 'Payables',
        value: fmtCompact(pay),
        detail: payCount === 0 ? 'Suppliers square' : `${payCount} supplier${payCount === 1 ? '' : 's'}`,
        tone:  pay > 0 ? 'warn' : 'good',
        spark: fakeSeries(pay || 10, 0.9),
        onClick: () => navigate('/reports/payables-aging'),
      },
      {
        id: 'profit', label: profit >= 0 ? 'Profit · MTD' : 'Loss · MTD',
        value: fmtCompact(Math.abs(profit)),
        detail: profit >= 0 ? 'Net gain' : 'Margin under pressure',
        tone:  profit >= 0 ? 'good' : 'danger',
        spark: fakeSeries(Math.abs(profit) || 10, 1.15),
        onClick: () => navigate('/reports/profit-loss'),
      },
    ];
  }, [stats, navigate]);

  /* Filter KPIs by the per-card visibility toggles. Keep the filtered list
   * memoized so toggling one card doesn't reshape the others. */
  const visibleKpis = useMemo(() => {
    const map = { sales: cfg.showKpiSales, bills: cfg.showKpiBills, recv: cfg.showKpiRecv, pay: cfg.showKpiPay, profit: cfg.showKpiProfit };
    return kpis.filter((k) => map[k.id] !== false);
  }, [kpis, cfg.showKpiSales, cfg.showKpiBills, cfg.showKpiRecv, cfg.showKpiPay, cfg.showKpiProfit]);

  /* Action ribbon — resolve user-chosen ids against the catalog, ignore
   * unknown ids so a stale persisted list never crashes the page. */
  const visibleActions = useMemo(() => {
    return (cfg.actions || [])
      .map((id) => ACTION_CATALOG[id] && { id, ...ACTION_CATALOG[id] })
      .filter(Boolean);
  }, [cfg.actions]);

  // Use the full name as typed by the user (My Account → Full Name).
  // Earlier we sliced this to the first token for the "Hi, Ali" feel, but
  // people put their full legal name in there and expect to see it.
  const displayName = (user?.full_name || '').trim() || 'there';
  const greeting    = greetingFor(now.hour());

  /* Time string. Tabular numerals keep the column widths stable across
   * digit changes so the colon never jiggles. Seconds are opt-in via
   * the homeSettings toggle. */
  const timeStr = (() => {
    if (cfg.clockFormat === '12') {
      return now.format(cfg.showSeconds ? 'h:mm:ss A' : 'h:mm A');
    }
    return now.format(cfg.showSeconds ? 'HH:mm:ss' : 'HH:mm');
  })();

  return (
    <div className={`cc-home ${cfg.showAmbientGradient ? 'cc-ambient' : ''}`}>
      {/* ── 1. KPI ribbon ─────────────────────────────────────────────── */}
      {cfg.showKpiStrip && visibleKpis.length > 0 && (
        <section
          className="cc-kpi-ribbon"
          data-cols={visibleKpis.length}
          aria-busy={loading || undefined}
        >
          {visibleKpis.map((k) => (
            <button key={k.id} className={`cc-kpi cc-kpi-${k.tone}`} onClick={k.onClick}>
              <div className="cc-kpi-top">
                <span className="cc-kpi-label">{k.label}</span>
                <span className={`cc-kpi-dot cc-kpi-dot-${k.tone}`} aria-hidden="true" />
              </div>
              <div className="cc-kpi-value">{k.value}</div>
              <div className="cc-kpi-foot">
                <span className="cc-kpi-detail">{k.detail}</span>
                {cfg.showKpiSparks && (
                  <span className="cc-kpi-spark">
                    <Sparkline data={k.spark} height={22} color="currentColor" />
                  </span>
                )}
              </div>
            </button>
          ))}
        </section>
      )}

      {/* ── 2. Hero — greeting + headline up top, search at the upper-mid
       *           (where the eye naturally rests), clock + date as the
       *           bottom anchor. Order matters: the search is the action
       *           point, so it lives where attention lands first; the
       *           clock is reference info, so it sits below as a quiet
       *           visual signature. */}
      <main className="cc-middle">
        <header className="cc-greeting">
          {cfg.showGreeting && (
            <div className="cc-eyebrow">
              {greeting}, {displayName}
            </div>
          )}
          {cfg.showHeadline && (
            <h1 className="cc-headline">What would you like to do?</h1>
          )}
        </header>

        {cfg.showSearch && (
          <div className="cc-search-section">
            <GlobalSearchHero autoFocus />
          </div>
        )}

        {cfg.showSearch && cfg.showSearchHint && (
          <div className="cc-hint">
            Type to find anything &middot; <kbd className="gs-kbd">{altLabel('S')}</kbd> sale &middot; <kbd className="gs-kbd">{altLabel('P')}</kbd> purchase &middot; <kbd className="gs-kbd">{altLabel('G')}</kbd> palette
          </div>
        )}

        {cfg.showClock && (
          <Clock
            timeStr={timeStr}
            /* Long form is the wordy small-caps date (TUESDAY · 05 MAY 2026);
             * numeric is "TUESDAY · 05/05/2026" — same full weekday for
             * at-a-glance orientation, swapping the wordy month for the
             * numeric date most operators want to copy into a field. CSS
             * uppercases the day so both formats share the small-caps look. */
            date={cfg.clockDateFormat === 'numeric'
              ? now.format('dddd · DD/MM/YYYY')
              : now.format('dddd · DD MMM YYYY')}
            showDate={cfg.showClockDate}
            showPulse={cfg.showLivePulse}
          />
        )}
      </main>

      {/* ── 3. Action ribbon ──────────────────────────────────────────── */}
      {cfg.showActionRibbon && visibleActions.length > 0 && (
        <section
          className="cc-actions"
          data-count={visibleActions.length}
        >
          {visibleActions.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.id}
                className="cc-action"
                onClick={() => navigate(a.route)}
                title={`${a.label} — ${a.sub}`}
              >
                <span className="cc-action-icon"><Icon /></span>
                <span className="cc-action-text">
                  <span className="cc-action-label">{a.label}</span>
                  <span className="cc-action-sub">{a.sub}</span>
                </span>
                {(a.ctrlKey || a.altKey || a.fKey) && (
                  <span className="cc-action-kbd">
                    {a.ctrlKey && <kbd className="gs-kbd">{ctrlLabel(a.ctrlKey)}</kbd>}
                    {a.altKey && <kbd className="gs-kbd">{altLabel(a.altKey)}</kbd>}
                    {a.fKey && <kbd className="gs-kbd">{a.fKey}</kbd>}
                  </span>
                )}
              </button>
            );
          })}
        </section>
      )}
    </div>
  );
}

/* Clock — the visual anchor of the page.
 *
 *   • Big tabular HH:mm in a display weight so it reads from across the
 *     room. The font-variant-numeric: tabular-nums freezes column width so
 *     the colon never jiggles between 1:09 and 1:10.
 *   • Date below in small caps with strong tracking, in fg-secondary (NOT
 *     fg-tertiary) so it's confidently visible — the user explicitly asked
 *     for the date to be more prominent.
 *   • Optional live-pulse dot keeps the clock feeling "live" without being
 *     a visual jackhammer. */
function Clock({ timeStr, date, showDate, showPulse }) {
  return (
    <div className="cc-clock" aria-label={`${timeStr} · ${date}`}>
      <div className="cc-clock-time">
        {showPulse && <span className="cc-pulse" aria-hidden="true" />}
        <span>{timeStr}</span>
      </div>
      {showDate && <div className="cc-clock-date">{date}</div>}
    </div>
  );
}
