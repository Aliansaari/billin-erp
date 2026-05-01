import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Input, Typography, Tag, Empty } from 'antd';
import {
  RiseOutlined, ShoppingCartOutlined, InboxOutlined,
  PieChartOutlined, TeamOutlined, FileTextOutlined,
  SearchOutlined, StarFilled, AlertOutlined, CalendarOutlined,
} from '@ant-design/icons';
import { REPORTS, CATEGORY_META, CATEGORY_ORDER, matchReport, resolveReports } from '../../config/reports';
import useFavoritesStore from '../../store/favoritesStore';
import useAuthStore from '../../store/authStore';
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
  AlertOutlined: <AlertOutlined />,
  CalendarOutlined: <CalendarOutlined />,
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
  // Query lives in the URL (?q=…) so the browser-back button restores
  // the same search state when returning from a report. ESC on a
  // report page fires history.back() (handled by AppLayout) which
  // brings the user here with the query already populated.
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  // Selection is tracked as (categoryId, idx) — not a flat index —
  // because the categories render as separate columns in the grid.
  // ↓/↑ walks WITHIN a category column; →/← jumps to the equivalent
  // row of the next/previous category column. (cat=null means no
  // selection yet; the first arrow keypress lands on the first row
  // of the first category that has matches.)
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const searchRef = useRef(null);
  const rowRefs = useRef({});  // keyed by `${cat}:${idx}`

  // Keep the URL in sync. `replace: true` so each keystroke doesn't
  // pollute history with 17 entries when typing "profit & loss".
  useEffect(() => {
    if (query) setSearchParams({ q: query }, { replace: true });
    else if (searchParams.get('q')) setSearchParams({}, { replace: true });
    // eslint-disable-next-line
  }, [query]);

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

  // Reset selection on query change. cat=null + idx=-1 means no row
  // highlighted; first ↓ keypress lands on the first match.
  useEffect(() => { setSelectedCat(null); setSelectedIdx(-1); }, [query]);

  // Scroll the selected row into view when keyboard nav moves it
  // off-screen. block:'nearest' keeps the page from jumping when the
  // row is already visible.
  useEffect(() => {
    if (!selectedCat || selectedIdx < 0) return;
    const el = rowRefs.current[`${selectedCat}:${selectedIdx}`];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedCat, selectedIdx]);

  // Restore the search if we returned from a report via ESC. The
  // URL ?q= already carries the query, but the searchRef needs to
  // be focused so the operator can keep typing without clicking.
  useEffect(() => {
    if (sessionStorage.getItem('reports_hub_back') === '1') {
      sessionStorage.removeItem('reports_hub_back');
      setTimeout(() => searchRef.current?.focus(), 60);
    }
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

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1280, margin: '0 auto' }}>

      {/* ── Header ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: 14 }}>
        <Title level={2} style={{ margin: 0, fontWeight: 700, letterSpacing: '-0.02em' }}>Reports</Title>
        <Text type="secondary" style={{ fontSize: 13.5 }}>
          All financial, sales, and operational reports · {visibleReports.length} total
          {pinned.length > 0 && <> · <b style={{ color: 'var(--fg-secondary)' }}>{pinned.length}</b> pinned</>}
        </Text>
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
        onKeyDown={(e) => {
          // Keyboard nav inside search: ↓ ↑ → ← Enter Esc.
          // Only active when the search has text. Categories render as
          // separate columns in the grid; ↓/↑ walks within a column,
          // →/← jumps between columns at the same row index.
          if (!query) return;
          const presentCats = CATEGORY_ORDER.filter((c) => (byCategory[c] || []).length > 0);
          if (presentCats.length === 0) return;

          // Resolve the current selection (or land on first match).
          const ensure = () => {
            if (selectedCat) return { cat: selectedCat, idx: Math.max(0, selectedIdx) };
            return { cat: presentCats[0], idx: 0 };
          };

          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!selectedCat) {
              setSelectedCat(presentCats[0]);
              setSelectedIdx(0);
              return;
            }
            const items = byCategory[selectedCat] || [];
            if (selectedIdx + 1 < items.length) {
              setSelectedIdx(selectedIdx + 1);
            } else {
              // Past the bottom of this column → jump to the top of
              // the next category column (down-and-right reading flow).
              const ci = presentCats.indexOf(selectedCat);
              const next = presentCats[ci + 1];
              if (next) { setSelectedCat(next); setSelectedIdx(0); }
            }
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!selectedCat) return;
            if (selectedIdx > 0) {
              setSelectedIdx(selectedIdx - 1);
            } else {
              // Above the top of this column → jump to the bottom of
              // the previous category column.
              const ci = presentCats.indexOf(selectedCat);
              const prev = presentCats[ci - 1];
              if (prev) {
                setSelectedCat(prev);
                setSelectedIdx((byCategory[prev] || []).length - 1);
              }
            }
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            const { cat, idx } = ensure();
            const ci = presentCats.indexOf(cat);
            const next = presentCats[ci + 1];
            if (!next) return;
            // Preserve row index across columns, clamping to the new
            // column's length so we don't land on a missing row.
            const len = (byCategory[next] || []).length;
            setSelectedCat(next);
            setSelectedIdx(Math.min(idx, len - 1));
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            const { cat, idx } = ensure();
            const ci = presentCats.indexOf(cat);
            const prev = presentCats[ci - 1];
            if (!prev) return;
            const len = (byCategory[prev] || []).length;
            setSelectedCat(prev);
            setSelectedIdx(Math.min(idx, len - 1));
          } else if (e.key === 'Enter') {
            // Default to first item of first present category if no
            // explicit selection yet (command-palette default).
            const { cat, idx } = ensure();
            const target = (byCategory[cat] || [])[idx];
            if (target) {
              e.preventDefault();
              sessionStorage.setItem('reports_hub_back', '1');
              nav(target.route);
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // First Esc: clear selection. Second Esc (already cleared):
            // clear query.
            if (selectedCat) { setSelectedCat(null); setSelectedIdx(-1); }
            else setQuery('');
          }
        }}
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
                    padding. Hover warms the row but no chrome around it.
                    When keyboard-driving via search, the row that
                    matches (selectedCat, selectedIdx) is highlighted. */}
                {reports.map((r, rowIdx) => {
                  const selected = query && selectedCat === cat && selectedIdx === rowIdx;
                  return (
                  <div
                    key={r.id}
                    ref={(el) => { rowRefs.current[`${cat}:${rowIdx}`] = el; }}
                    onClick={() => {
                      sessionStorage.setItem('reports_hub_back', '1');
                      nav(r.route);
                    }}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 10,
                      padding: selected ? '10px 8px' : '10px 0',
                      cursor: 'pointer',
                      background: selected ? 'var(--bg-subtle, #fafafa)' : '',
                      borderLeft: selected ? `3px solid ${tone.fg}` : '3px solid transparent',
                      borderBottom: '1px solid var(--border-subtle, #f1f5f9)',
                      transition: 'background .12s, padding .12s',
                    }}
                    onMouseEnter={(e) => {
                      if (selected) return;
                      e.currentTarget.style.background = 'var(--bg-subtle, #fafafa)';
                      e.currentTarget.style.padding = '10px 8px';
                    }}
                    onMouseLeave={(e) => {
                      if (selected) return;
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
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
