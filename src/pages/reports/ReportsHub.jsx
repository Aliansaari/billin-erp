import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Input, Typography, Tag, Empty } from 'antd';
import {
  RiseOutlined, ShoppingCartOutlined, InboxOutlined,
  PieChartOutlined, TeamOutlined, FileTextOutlined,
  SearchOutlined, StarFilled,
} from '@ant-design/icons';
import { REPORTS, CATEGORY_META, CATEGORY_ORDER, matchReport, resolveReports } from '../../config/reports';
import useFavoritesStore from '../../store/favoritesStore';
import useAuthStore from '../../store/authStore';
import { hasPermission } from '../../utils/perms';
import FavoriteStar from '../../components/FavoriteStar';

const { Title, Text } = Typography;

/*
 * Reports Hub — canonical home for every report in the app.
 *
 * Three sections, top to bottom:
 *   1. Header — title, "X reports across N categories" sub-line,
 *      glass search input pinned right (⌘K to focus).
 *   2. Pinned strip — favorite reports as compact cards. Renders
 *      iff the user has at least one favorite. Live metrics
 *      (period totals, due-date countdowns) are deferred to a
 *      follow-up commit; this version shows static name + subtitle
 *      so the strip is useful even before the metric layer lands.
 *   3. Category grid — two columns on desktop, one column on
 *      narrow viewports. Each category section lists its reports
 *      with a star toggle + name + subtitle. Click name → navigate.
 *      Search filters the grid in-place — categories with no
 *      matches collapse out entirely instead of showing an empty
 *      shell.
 *
 * Spec deferrals (call out for the follow-up commit):
 *   - "Needs Attention" strip
 *   - Pinned cards' live metric values
 *   - Date range picker (MVP scope didn't need it; some reports do
 *     their own date selection on their own page)
 */

// Map registry icon-name strings to actual AntD icon components. The
// registry can't import icons directly without forcing every consumer
// (including the favorites dropdown which doesn't need icon weight)
// to pull them in.
const ICON_BY_NAME = {
  RiseOutlined: <RiseOutlined />,
  ShoppingCartOutlined: <ShoppingCartOutlined />,
  InboxOutlined: <InboxOutlined />,
  PieChartOutlined: <PieChartOutlined />,
  TeamOutlined: <TeamOutlined />,
  FileTextOutlined: <FileTextOutlined />,
};

// Tone → tile background + icon colour. Pinned to existing CSS vars
// so dark mode just works.
const TONE_COLORS = {
  info:    { bg: 'rgba(79, 70, 229, 0.10)',  fg: '#4F46E5' },  // indigo
  warning: { bg: 'rgba(217, 119, 6, 0.12)',  fg: '#B45309' },  // amber
  success: { bg: 'rgba(5, 150, 105, 0.10)',  fg: '#059669' },  // green
  danger:  { bg: 'rgba(220, 38, 38, 0.10)',  fg: '#DC2626' },  // red
  purple:  { bg: 'rgba(124, 58, 237, 0.10)', fg: '#7C3AED' },  // purple
  teal:    { bg: 'rgba(13, 148, 136, 0.10)', fg: '#0D9488' },  // teal
};

export default function ReportsHub() {
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);
  const favIds   = useFavoritesStore((s) => s.ids);
  const favLoad  = useFavoritesStore((s) => s.load);
  const favLoaded= useFavoritesStore((s) => s.loaded);
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);

  // Hydrate favorites on first mount.
  useEffect(() => { if (!favLoaded) favLoad(); }, [favLoaded, favLoad]);

  // ⌘K / Ctrl+K → focus search.
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

  // Reports the current user can actually open (drop ones their
  // role/perms hide). Star + listing are both gated by this.
  const visibleReports = useMemo(
    () => REPORTS.filter((r) => !r.perm || hasPermission(user, r.perm)),
    [user],
  );

  const matcher = matchReport(query);
  const filtered = visibleReports.filter(matcher);

  // Category → reports in render order.
  const byCategory = useMemo(() => {
    const map = {};
    for (const cat of CATEGORY_ORDER) map[cat] = [];
    for (const r of filtered) map[r.category]?.push(r);
    return map;
  }, [filtered]);

  // Pinned reports — resolve ids to full registry entries, drop any
  // perms-hidden ones, preserve user's pin order.
  const pinned = useMemo(() => {
    const visibleIds = new Set(visibleReports.map((r) => r.id));
    return resolveReports(favIds.filter((id) => visibleIds.has(id)));
  }, [favIds, visibleReports]);

  return (
    <div style={{ padding: '14px 18px', maxWidth: 1400, margin: '0 auto' }}>
      {/* ── Header — single tight row ───────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <Title level={4} style={{ margin: 0, letterSpacing: '-0.01em' }}>Reports</Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {visibleReports.length} reports · {CATEGORY_ORDER.length} categories
            {pinned.length > 0 && <> · <b>{pinned.length}</b> pinned</>}
          </Text>
        </div>
        <Input
          ref={searchRef}
          allowClear
          prefix={<SearchOutlined style={{ color: 'var(--fg-tertiary, #9ca3af)' }} />}
          suffix={
            <Tag style={{
              fontSize: 10, padding: '0 5px', margin: 0, lineHeight: '16px',
              background: 'var(--bg-subtle, #f9fafb)', border: '1px solid var(--border, #e5e7eb)',
              color: 'var(--fg-secondary, #6b7280)',
            }}>⌘K</Tag>
          }
          placeholder="Search — “p&l”, “gst”, “stock”…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 280, maxWidth: '100%' }}
        />
      </div>

      {/* ── Pinned strip — inline pill row, no card chrome ──── */}
      {pinned.length > 0 && !query && (
        <div style={{
          marginBottom: 12, padding: '8px 10px',
          background: 'var(--bg-subtle, #fafafa)',
          border: '1px solid var(--border, #e5e7eb)',
          borderRadius: 8,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            color: 'var(--fg-secondary, #6b7280)',
            textTransform: 'uppercase', fontSize: 10, letterSpacing: 1, fontWeight: 600,
            paddingRight: 6, borderRight: '1px solid var(--border, #e5e7eb)',
          }}>
            <StarFilled style={{ color: '#EF9F27', fontSize: 11 }} /> Pinned
          </span>
          {pinned.map((r) => {
            const tone = TONE_COLORS[CATEGORY_META[r.category]?.tone] || TONE_COLORS.info;
            return (
              <span
                key={r.id}
                onClick={() => nav(r.route)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '3px 8px 3px 6px', borderRadius: 14,
                  background: 'var(--bg-elevated, white)',
                  border: '1px solid var(--border, #e5e7eb)',
                  cursor: 'pointer', fontSize: 12, fontWeight: 500,
                  color: 'var(--fg-primary)',
                  transition: 'border-color .12s, transform .1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = tone.fg; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = ''; }}
                title={r.subtitle}
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

      {/* ── Search-empty notice ──────────────────────────────── */}
      {query && filtered.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<>No reports match "<b>{query}</b>". Try a shorter query.</>}
          style={{ padding: 60 }}
        />
      )}

      {/* ── Category grid (3 cols on wide screens, denser rows) */}
      {filtered.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 10,
        }}>
          {CATEGORY_ORDER.map((cat) => {
            const reports = byCategory[cat];
            if (!reports || reports.length === 0) return null;
            const meta = CATEGORY_META[cat];
            const tone = TONE_COLORS[meta.tone] || TONE_COLORS.info;
            return (
              <Card key={cat} bodyStyle={{ padding: 0 }} size="small">
                {/* Compact category header */}
                <div style={{
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--border-subtle, #f1f5f9)',
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: tone.bg,
                }}>
                  <span style={{
                    color: tone.fg,
                    display: 'inline-flex', alignItems: 'center',
                    fontSize: 13,
                  }}>{ICON_BY_NAME[meta.icon]}</span>
                  <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg-primary)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    {meta.label}
                  </span>
                  <span style={{
                    color: 'var(--fg-tertiary)', fontSize: 11, marginLeft: 'auto',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {reports.length}
                  </span>
                </div>

                {/* Compact report rows — single-line each */}
                <div>
                  {reports.map((r, idx) => (
                    <div
                      key={r.id}
                      onClick={() => nav(r.route)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '5px 12px',
                        borderTop: idx === 0 ? 'none' : '1px solid var(--border-subtle, #f1f5f9)',
                        cursor: 'pointer',
                        transition: 'background .1s',
                        minHeight: 30,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-subtle, #f9fafb)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                      title={r.subtitle}
                    >
                      <FavoriteStar reportId={r.id} size={13} style={{ flexShrink: 0 }} />
                      <span style={{ fontWeight: 500, fontSize: 13, color: 'var(--fg-primary)', whiteSpace: 'nowrap' }}>
                        {r.name}
                      </span>
                      <span style={{
                        fontSize: 11, color: 'var(--fg-tertiary)',
                        flex: 1, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {r.subtitle}
                      </span>
                      {r.isNew && (
                        <Tag color="orange" style={{ fontSize: 8, padding: '0 4px', lineHeight: '13px', margin: 0, fontWeight: 700, letterSpacing: 0.4 }}>NEW</Tag>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
