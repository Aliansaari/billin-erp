import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, Typography, Tag, Empty, DatePicker } from 'antd';
import {
  RiseOutlined, ShoppingCartOutlined, InboxOutlined,
  PieChartOutlined, TeamOutlined, FileTextOutlined,
  SearchOutlined, StarFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { REPORTS, CATEGORY_META, CATEGORY_ORDER, matchReport, resolveReports } from '../../config/reports';
import useFavoritesStore from '../../store/favoritesStore';
import useAuthStore from '../../store/authStore';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { hasPermission } from '../../utils/perms';
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

// ── Main hub ─────────────────────────────────────────────────────────
//
// Pinned section is a compact pill strip (one row, wraps as needed);
// no live metrics, no per-card chrome — operator wanted it collapsed.
// Needs Attention strip removed entirely. Categories below are
// borderless, typographic sections (icon + label + count + hairline,
// then rows).
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

      {/* ── Pinned strip — compact pill row ──────────────────────
       *
       * Was a row of metric-bearing cards; user feedback was the
       * cards bloated the page above the categories. Now: a single
       * horizontal strip of pills with the star + name only.
       * Hover lights the pill in the category's tone color; click
       * navigates. Subtitle moves to the title attribute (hover
       * tooltip). Strip wraps on narrow viewports; no scroll bar. */}
      {pinned.length > 0 && !query && (
        <div style={{
          marginBottom: 18, padding: '8px 10px',
          background: 'var(--bg-subtle, #fafafa)',
          border: '1px solid var(--border, #e5e7eb)',
          borderRadius: 8,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            color: 'var(--fg-secondary, #6b7280)',
            textTransform: 'uppercase', fontSize: 10, letterSpacing: 1, fontWeight: 600,
            paddingRight: 8, borderRight: '1px solid var(--border, #e5e7eb)',
          }}>
            <StarFilled style={{ color: '#F59E0B', fontSize: 11 }} /> Pinned
          </span>
          {pinned.map((r) => {
            const tone = TONE[CATEGORY_META[r.category]?.tone] || TONE.info;
            return (
              <span
                key={r.id}
                onClick={() => nav(r.route)}
                title={r.subtitle}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px 4px 7px', borderRadius: 16,
                  background: 'var(--bg-elevated, #fff)',
                  border: '1px solid var(--border, #e5e7eb)',
                  cursor: 'pointer', fontSize: 12.5, fontWeight: 500,
                  color: 'var(--fg-primary)',
                  transition: 'border-color .12s, color .12s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = tone.fg;
                  e.currentTarget.style.color = tone.fg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '';
                  e.currentTarget.style.color = '';
                }}
              >
                <span style={{
                  width: 16, height: 16, borderRadius: 4,
                  background: tone.bg, color: tone.fg,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, flexShrink: 0,
                }}>{ICON_BY_NAME[CATEGORY_META[r.category]?.icon]}</span>
                {r.name}
              </span>
            );
          })}
        </div>
      )}

      {/* ── Search-empty notice ─────────────────────────────────── */}
      {query && filtered.length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<>No reports match "<b>{query}</b>". Try a shorter query.</>}
          style={{ padding: 60 }} />
      )}

      {/* ── Category grid — borderless, typographic separation ───
       *
       * Categories aren't framed in card boxes anymore — that was
       * giving the page a settings-grid vibe. Now each category is a
       * borderless inline section: icon + label + count as the header
       * with a single hairline rule below, then rows underneath. The
       * whole hub becomes one continuous report surface, not a grid
       * of widgets. Two columns laid out via CSS grid. */}
      {filtered.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
          columnGap: 40,
          rowGap: 28,
        }}>
          {CATEGORY_ORDER.map((cat) => {
            const reports = byCategory[cat];
            if (!reports || reports.length === 0) return null;
            const meta = CATEGORY_META[cat];
            const tone = TONE[meta.tone] || TONE.info;
            return (
              <div key={cat}>
                {/* Header: icon + label + count, hairline rule below */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  paddingBottom: 8,
                  borderBottom: '1px solid var(--border, #e5e7eb)',
                  marginBottom: 4,
                }}>
                  <span style={{
                    color: tone.fg, fontSize: 16,
                    display: 'inline-flex', alignItems: 'center',
                  }}>{ICON_BY_NAME[meta.icon]}</span>
                  <span style={{
                    fontWeight: 700, fontSize: 15, color: 'var(--fg-primary)',
                    letterSpacing: '-0.005em',
                  }}>
                    {meta.label}
                  </span>
                  <span style={{
                    color: 'var(--fg-tertiary)', fontSize: 12, marginLeft: 'auto',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {reports.length} {reports.length === 1 ? 'report' : 'reports'}
                  </span>
                </div>

                {/* Rows — typographic, no row borders, just generous
                    padding. Hover warms the row but no chrome around it. */}
                {reports.map((r) => (
                  <div
                    key={r.id}
                    onClick={() => nav(r.route)}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 10,
                      padding: '10px 0',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border-subtle, #f1f5f9)',
                      transition: 'background .12s, padding .12s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--bg-subtle, #fafafa)';
                      e.currentTarget.style.padding = '10px 8px';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '';
                      e.currentTarget.style.padding = '10px 0';
                    }}
                  >
                    <FavoriteStar reportId={r.id} size={14} style={{ flexShrink: 0, position: 'relative', top: 2 }} />
                    <span style={{
                      fontWeight: 500, fontSize: 14, color: 'var(--fg-primary)',
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
            );
          })}
        </div>
      )}
    </div>
  );
}
