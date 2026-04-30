import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Input, Typography, Tag, Empty, DatePicker, Spin } from 'antd';
import {
  RiseOutlined, ShoppingCartOutlined, InboxOutlined,
  PieChartOutlined, TeamOutlined, FileTextOutlined,
  SearchOutlined, StarFilled, WarningFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { REPORTS, CATEGORY_META, CATEGORY_ORDER, matchReport, resolveReports } from '../../config/reports';
import useFavoritesStore from '../../store/favoritesStore';
import useAuthStore from '../../store/authStore';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { hasPermission } from '../../utils/perms';
import { reportAPI, partyAPI } from '../../api';
import FavoriteStar from '../../components/FavoriteStar';

const { Title, Text } = Typography;

/*
 * Reports Hub — canonical home, designed for visual presence and
 * useful information at a glance.
 *
 * Sections (top to bottom):
 *   1. Header strip — bold title + sub-line + FY date range picker
 *      pinned right (the picker drives Pinned-card metrics + the
 *      sub-headline counts on the cards).
 *   2. Search — full-width input, ⌘K to focus, clears the body to
 *      a flat result list when active.
 *   3. Needs Attention — conditional alert ribbon. Pulls real data:
 *      GSTR-1 deadline (11th of next month), aging buckets >60d.
 *      Renders only when at least one item is urgent.
 *   4. Pinned — favorites with LIVE metric values (currency / days
 *      / count) lazily fetched from each report's own backend
 *      endpoint. One shared loading state per card so a slow
 *      endpoint doesn't block the rest of the hub.
 *   5. Category grid — 6 sections, 2-col layout, clean rows. Each
 *      row: name on left, subtitle right-aligned (matches the
 *      reference design).
 *
 * Permission-gated: reports the user can't view drop out at the
 * registry filter step, so the pinned strip + categories show only
 * what they can actually open.
 */

// Map registry icon-name strings to AntD icon components — the registry
// can't import icons directly because the favorites dropdown reads the
// same registry but doesn't need icon weight.
const ICON_BY_NAME = {
  RiseOutlined: <RiseOutlined />,
  ShoppingCartOutlined: <ShoppingCartOutlined />,
  InboxOutlined: <InboxOutlined />,
  PieChartOutlined: <PieChartOutlined />,
  TeamOutlined: <TeamOutlined />,
  FileTextOutlined: <FileTextOutlined />,
};

// Category tone → icon backdrop + accent. Matches the AntD palette
// so dark mode picks up the right colors via CSS vars.
const TONE = {
  info:    { bg: 'rgba(79,70,229,0.12)',  fg: '#6366F1' },
  warning: { bg: 'rgba(217,119,6,0.14)',  fg: '#D97706' },
  success: { bg: 'rgba(5,150,105,0.12)',  fg: '#10B981' },
  danger:  { bg: 'rgba(220,38,38,0.12)',  fg: '#EF4444' },
  purple:  { bg: 'rgba(124,58,237,0.12)', fg: '#8B5CF6' },
  teal:    { bg: 'rgba(13,148,136,0.12)', fg: '#14B8A6' },
};

// Format helpers for the metric values on Pinned cards.
const fmtINR = (v) => {
  const n = parseFloat(v || 0);
  if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (Math.abs(n) >= 100000)   return `₹${(n / 100000).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtCount = (v) => parseInt(v || 0, 10).toLocaleString('en-IN');
const fmtDays  = (v) => `${parseInt(v || 0, 10)}d`;

// Days until the next GSTR-1 filing deadline (11th of the month).
function daysUntilNextGstr1() {
  const today = dayjs();
  let due = today.date() < 11 ? today.date(11) : today.add(1, 'month').date(11);
  return Math.max(0, due.diff(today, 'day'));
}

// Per-report metric loader. Returns a function that, given a date
// range, fetches the headline number for that report. Map keyed by
// report.id; reports without a fetcher get a static "—" treatment
// (still useful for "ready to open").
const METRICS = {
  profit_loss: {
    label: 'Net profit',
    sub:   'Revenue minus expenses',
    fetch: ({ from, to }) => reportAPI.getProfitLoss({ from_date: from, to_date: to })
      .then((r) => ({ value: r.data?.net_profit, format: fmtINR, tone: (r.data?.net_profit || 0) >= 0 ? 'good' : 'bad' })),
  },
  sales_report: {
    label: 'YTD revenue',
    sub:   'Sum of net sales',
    fetch: ({ from, to }) => reportAPI.getSalesReport({ from_date: from, to_date: to, page: 1, limit: 1 })
      .then((r) => ({ value: r.data?.totals?.total ?? r.data?.summary?.total_amount, format: fmtINR, tone: 'good' })),
  },
  purchase_report: {
    label: 'YTD spend',
    sub:   'Sum of purchases',
    fetch: ({ from, to }) => reportAPI.getPurchaseReport({ from_date: from, to_date: to, page: 1, limit: 1 })
      .then((r) => ({ value: r.data?.totals?.total ?? r.data?.summary?.total_amount, format: fmtINR, tone: 'neutral' })),
  },
  stock_report: {
    label: 'Stock value',
    sub:   'At purchase rate',
    fetch: () => reportAPI.getStockReport({ page: 1, limit: 1 })
      .then((r) => ({ value: r.data?.summary?.total_purchase_value, format: fmtINR, tone: 'neutral' })),
  },
  godown_valuation: {
    label: 'Total value',
    sub:   'Across all godowns',
    fetch: () => reportAPI.godownValuation()
      .then((r) => ({ value: r.data?.totals?.total_value, format: fmtINR, tone: 'neutral' })),
  },
  aging_report: {
    label: 'Outstanding',
    sub:   'Across all parties',
    fetch: () => partyAPI.getAging({ party_type: 'Customer' })
      .then((r) => {
        const d = r.data?.totals || r.data?.summary || {};
        return { value: d.total || d.balance || 0, format: fmtINR, tone: 'warning' };
      }),
  },
  gstr1: {
    label: 'Until filing due',
    sub:   'Ready to file',
    fetch: () => Promise.resolve({ value: daysUntilNextGstr1(), format: fmtDays, tone: 'warning' }),
  },
  gstr3b: {
    label: 'Until filing due',
    sub:   'Ready to file',
    fetch: () => Promise.resolve({ value: daysUntilNextGstr1() + 9, format: fmtDays, tone: 'warning' }),
  },
};

const TONE_TEXT = {
  good:    '#10B981',
  bad:     '#EF4444',
  warning: '#F59E0B',
  neutral: 'var(--fg-primary)',
};

// ── Pinned card — fetches its own metric ─────────────────────────────
function PinnedCard({ report, range, onOpen }) {
  const tone = TONE[CATEGORY_META[report.category]?.tone] || TONE.info;
  const metric = METRICS[report.id];
  const [state, setState] = useState({ loading: !!metric, error: false, data: null });

  useEffect(() => {
    if (!metric) { setState({ loading: false, error: false, data: null }); return; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: false }));
    metric.fetch(range)
      .then((d) => { if (!cancelled) setState({ loading: false, error: false, data: d }); })
      .catch(() => { if (!cancelled) setState({ loading: false, error: true, data: null }); });
    return () => { cancelled = true; };
  }, [report.id, range.from, range.to]);

  const valueColor = state.data ? (TONE_TEXT[state.data.tone] || TONE_TEXT.neutral) : 'var(--fg-primary)';
  const display = state.error ? '—'
    : state.loading ? <Spin size="small" />
    : state.data ? state.data.format(state.data.value)
    : '—';

  return (
    <div
      onClick={onOpen}
      style={{
        padding: '16px 18px',
        background: 'var(--bg-elevated, #fff)',
        border: '1px solid var(--border, #e5e7eb)',
        borderRadius: 10,
        cursor: 'pointer',
        position: 'relative',
        transition: 'transform .15s, border-color .15s, box-shadow .15s',
        minHeight: 110,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = tone.fg;
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '';
        e.currentTarget.style.transform = '';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 22, height: 22, borderRadius: 5,
            background: tone.bg, color: tone.fg,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12,
          }}>{ICON_BY_NAME[CATEGORY_META[report.category]?.icon]}</span>
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg-primary)' }}>{report.name}</span>
        </div>
        <FavoriteStar reportId={report.id} size={14} />
      </div>
      <div style={{
        fontSize: 26, fontWeight: 700, lineHeight: 1.1,
        fontVariantNumeric: 'tabular-nums',
        color: valueColor,
        letterSpacing: '-0.02em',
        marginBottom: 4,
      }}>
        {display}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fg-tertiary, #9ca3af)' }}>
        {metric ? `${metric.label} · ${metric.sub}` : report.subtitle}
      </div>
    </div>
  );
}

// ── Needs Attention strip ────────────────────────────────────────────
function NeedsAttention({ onJump }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const collect = async () => {
      const out = [];
      // GSTR-1 deadline countdown — always shown when within 14 days.
      const days = daysUntilNextGstr1();
      if (days <= 14) {
        out.push({
          id: 'gstr1',
          msg: `GSTR-1 due in ${days} day${days === 1 ? '' : 's'}`,
          route: '/reports/gstr1',
        });
      }
      // Parties >60 days overdue from aging.
      try {
        const r = await partyAPI.getAging({ party_type: 'Customer' });
        const buckets = r.data?.parties || r.data?.data || [];
        const stale = buckets.filter((p) =>
          parseFloat(p.bucket_60_90 || 0) > 0 || parseFloat(p.bucket_90_plus || 0) > 0,
        );
        if (stale.length > 0) {
          out.push({
            id: 'aging',
            msg: `${stale.length} part${stale.length === 1 ? 'y' : 'ies'} overdue >60 days`,
            route: '/reports/aging',
          });
        }
      } catch { /* silent — strip just hides this item */ }
      setItems(out);
    };
    collect();
  }, []);

  if (items.length === 0) return null;
  return (
    <div style={{
      padding: '10px 14px', marginBottom: 14,
      background: 'rgba(245,158,11,0.08)',
      border: '1px solid rgba(245,158,11,0.30)',
      borderRadius: 10,
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    }}>
      <WarningFilled style={{ color: '#D97706', fontSize: 16 }} />
      <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-primary)' }}>Needs attention</span>
      <span style={{ color: 'var(--fg-tertiary)', fontSize: 13 }}>·</span>
      {items.map((it, idx) => (
        <React.Fragment key={it.id}>
          {idx > 0 && <span style={{ color: 'var(--fg-tertiary)', fontSize: 13 }}>·</span>}
          <a
            onClick={(e) => { e.preventDefault(); onJump(it.route); }}
            style={{
              fontSize: 13, color: '#B45309', fontWeight: 500,
              cursor: 'pointer', textDecoration: 'none',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            {it.msg}
          </a>
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Main hub ─────────────────────────────────────────────────────────
export default function ReportsHub() {
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);
  const favIds   = useFavoritesStore((s) => s.ids);
  const favLoad  = useFavoritesStore((s) => s.load);
  const favLoaded= useFavoritesStore((s) => s.loaded);
  const { fyStart, fyEnd } = useFinancialYear();
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);

  const [range, setRange] = useState(() => ({
    from: fyStart || dayjs().startOf('year').format('YYYY-MM-DD'),
    to:   fyEnd   || dayjs().endOf('year').format('YYYY-MM-DD'),
  }));
  // When the FY hook resolves later, update the range once.
  useEffect(() => {
    if (fyStart && fyEnd) setRange({ from: fyStart, to: fyEnd });
  }, [fyStart, fyEnd]);

  useEffect(() => { if (!favLoaded) favLoad(); }, [favLoaded, favLoad]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const visibleReports = useMemo(
    () => REPORTS.filter((r) => !r.perm || hasPermission(user, r.perm)),
    [user],
  );
  const matcher = matchReport(query);
  const filtered = visibleReports.filter(matcher);

  const byCategory = useMemo(() => {
    const map = {};
    for (const cat of CATEGORY_ORDER) map[cat] = [];
    for (const r of filtered) map[r.category]?.push(r);
    return map;
  }, [filtered]);

  const pinned = useMemo(() => {
    const visibleIds = new Set(visibleReports.map((r) => r.id));
    return resolveReports(favIds.filter((id) => visibleIds.has(id)));
  }, [favIds, visibleReports]);

  const fmtRangeLabel = `${dayjs(range.from).format('DD MMM YYYY')} — ${dayjs(range.to).format('DD MMM YYYY')}`;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1280, margin: '0 auto' }}>

      {/* ── Header ──────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 16, marginBottom: 14,
      }}>
        <div>
          <Title level={2} style={{ margin: 0, fontWeight: 700, letterSpacing: '-0.02em' }}>Reports</Title>
          <Text type="secondary" style={{ fontSize: 13.5 }}>
            All financial, sales, and operational reports · {visibleReports.length} total
            {pinned.length > 0 && <> · <b style={{ color: 'var(--fg-secondary)' }}>{pinned.length}</b> pinned</>}
          </Text>
        </div>
        <DatePicker.RangePicker
          value={[dayjs(range.from), dayjs(range.to)]}
          onChange={(r) => r && r[0] && r[1] && setRange({
            from: r[0].format('YYYY-MM-DD'),
            to:   r[1].format('YYYY-MM-DD'),
          })}
          format="DD MMM YYYY"
          allowClear={false}
          style={{ minWidth: 280 }}
        />
      </div>

      {/* ── Search ──────────────────────────────────────────────── */}
      <Input
        ref={searchRef}
        allowClear
        size="large"
        prefix={<SearchOutlined style={{ color: 'var(--fg-tertiary, #9ca3af)', fontSize: 16 }} />}
        suffix={
          <Tag style={{
            fontSize: 11, padding: '0 6px', margin: 0, lineHeight: '18px',
            background: 'var(--bg-subtle, #f9fafb)', border: '1px solid var(--border, #e5e7eb)',
            color: 'var(--fg-secondary, #6b7280)', fontWeight: 600,
          }}>⌘ K</Tag>
        }
        placeholder="Search reports — type a name like 'p&l' or 'gstr'"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 14 }}
      />

      {/* ── Needs Attention ─────────────────────────────────────── */}
      {!query && <NeedsAttention onJump={(route) => nav(route)} />}

      {/* ── Pinned ──────────────────────────────────────────────── */}
      {pinned.length > 0 && !query && (
        <div style={{ marginBottom: 18 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            marginBottom: 10, fontSize: 13, fontWeight: 600,
            color: 'var(--fg-primary)',
          }}>
            <StarFilled style={{ color: '#F59E0B' }} /> Pinned
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(pinned.length, 3)}, 1fr)`,
            gap: 12,
          }}>
            {pinned.slice(0, 3).map((r) => (
              <PinnedCard key={r.id} report={r} range={range} onOpen={() => nav(r.route)} />
            ))}
          </div>
        </div>
      )}

      {/* ── Search-empty notice ─────────────────────────────────── */}
      {query && filtered.length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<>No reports match "<b>{query}</b>". Try a shorter query.</>}
          style={{ padding: 60 }} />
      )}

      {/* ── Category grid ───────────────────────────────────────── */}
      {filtered.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
          gap: 14,
        }}>
          {CATEGORY_ORDER.map((cat) => {
            const reports = byCategory[cat];
            if (!reports || reports.length === 0) return null;
            const meta = CATEGORY_META[cat];
            const tone = TONE[meta.tone] || TONE.info;
            return (
              <div key={cat} style={{
                background: 'var(--bg-elevated, #fff)',
                border: '1px solid var(--border, #e5e7eb)',
                borderRadius: 10,
                overflow: 'hidden',
              }}>
                {/* Category header — icon + label + count */}
                <div style={{
                  padding: '10px 16px',
                  display: 'flex', alignItems: 'center', gap: 10,
                  borderBottom: '1px solid var(--border-subtle, #f1f5f9)',
                }}>
                  <span style={{
                    width: 24, height: 24, borderRadius: 6,
                    background: tone.bg, color: tone.fg,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13,
                  }}>{ICON_BY_NAME[meta.icon]}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--fg-primary)' }}>
                    {meta.label}
                  </span>
                  <span style={{
                    color: 'var(--fg-tertiary)', fontSize: 12, marginLeft: 'auto',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {reports.length} report{reports.length === 1 ? '' : 's'}
                  </span>
                </div>

                {/* Rows — name left, subtitle right (matches reference) */}
                <div>
                  {reports.map((r, idx) => (
                    <div
                      key={r.id}
                      onClick={() => nav(r.route)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '9px 16px',
                        borderTop: idx === 0 ? 'none' : '1px solid var(--border-subtle, #f1f5f9)',
                        cursor: 'pointer',
                        transition: 'background .12s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-subtle, #fafafa)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                    >
                      <FavoriteStar reportId={r.id} size={14} style={{ flexShrink: 0 }} />
                      <span style={{
                        fontWeight: 500, fontSize: 13.5, color: 'var(--fg-primary)',
                      }}>{r.name}</span>
                      {r.isNew && (
                        <Tag color="orange" style={{
                          fontSize: 8.5, padding: '0 4px', lineHeight: '14px',
                          margin: 0, fontWeight: 700, letterSpacing: 0.4,
                        }}>NEW</Tag>
                      )}
                      <span style={{
                        fontSize: 12, color: 'var(--fg-tertiary)',
                        marginLeft: 'auto',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {r.subtitle}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
