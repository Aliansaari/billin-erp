import React, { useEffect, useMemo, useState } from 'react';
import { Spin } from 'antd';
import { useNavigate } from 'react-router-dom';
import { SettingOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

import { reportAPI } from '../api';
import EditorialTile from '../components/editorial/EditorialTile';
import EditorialListTile from '../components/editorial/EditorialListTile';
import EditorialChartTile from '../components/editorial/EditorialChartTile';
import '../components/editorial/editorial.css';
import { TILES, getTileById } from '../config/dashboardTiles';
import useDashboardSettingsStore from '../store/dashboardSettingsStore';

/**
 * Dashboard — customizable tile grid driven by the catalog in
 * `src/config/dashboardTiles.js`. Three tile shapes:
 *
 *   metric — single big number with optional sparkline + delta chip
 *   list   — top-N list of parties / products with values
 *   chart  — multi-line trend (sales vs purchase, etc.)
 *
 * Data sources fetched in parallel on mount:
 *   /api/reports/dashboard          — point-in-time totals + prior-period
 *   /api/reports/dashboard/series   — 30-day daily aggregates
 *   /api/reports/dashboard/insights — top overdue parties, top sellers, dead stock, …
 *
 * Selected tile ids + display order live in dashboardSettingsStore
 * (zustand+persist). The Customize button takes the operator to
 * Settings → Dashboard.
 */
export default function Dashboard() {
  const navigate  = useNavigate();
  const tileIds   = useDashboardSettingsStore((s) => s.tiles);
  const tileCfg   = useDashboardSettingsStore((s) => s.config);
  const getConfig = useDashboardSettingsStore((s) => s.getConfig);
  const [stats,    setStats]    = useState(null);
  const [seriesMap, setSeriesMap] = useState({ day: [], week: [], month: [] });
  const [insights, setInsights] = useState(null);
  const [loading,  setLoad]     = useState(true);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoad(true);
    try {
      // Fetch all three intervals up front — three small round-trips,
      // total payload is tiny (each row is ~50 bytes, ~90+52+36 rows
      // max). Caching the full per-interval datasets means the operator
      // can flip a tile's interval / periods in the settings popover
      // without triggering a network round-trip.
      const [statsRes, dayRes, weekRes, monthRes, insightsRes] = await Promise.allSettled([
        reportAPI.getDashboard(),
        reportAPI.getDashboardSeries({ interval: 'day',   periods: 90 }),
        reportAPI.getDashboardSeries({ interval: 'week',  periods: 52 }),
        reportAPI.getDashboardSeries({ interval: 'month', periods: 36 }),
        reportAPI.getDashboardInsights(),
      ]);
      if (statsRes.status    === 'fulfilled') setStats(statsRes.value.data || null);
      if (insightsRes.status === 'fulfilled') setInsights(insightsRes.value.data || null);
      setSeriesMap({
        day:   dayRes.status   === 'fulfilled' ? (dayRes.value.data?.series   || []) : [],
        week:  weekRes.status  === 'fulfilled' ? (weekRes.value.data?.series  || []) : [],
        month: monthRes.status === 'fulfilled' ? (monthRes.value.data?.series || []) : [],
      });
    } catch (err) {
      console.error('Dashboard load failed:', err);
    } finally {
      setLoad(false);
    }
  };

  // Resolve user-selected ids → catalog entry + built props. Stale ids
  // (tile removed from catalog) are filtered out silently. Each builder
  // receives the FULL per-interval series map plus its merged config so
  // it can pick the right bucket size + count without us pre-slicing.
  const builtTiles = useMemo(() => {
    const haveAnyData = stats || insights || Object.values(seriesMap).some((arr) => arr && arr.length);
    if (!haveAnyData) return [];
    return tileIds
      .map((id) => {
        const def = getTileById(id);
        if (!def) return null;
        const config = getConfig(id);
        // Pick the active interval's full dataset; the builder slices
        // down to config.periods. Fallback to daily if an unknown
        // interval slips through (defensive — shouldn't happen).
        const intervalSeries = seriesMap[config.interval] || seriesMap.day || [];
        try {
          const props = def.build({
            stats, insights, navigate, config,
            // Existing builders expect `series`; pass the active interval
            // there. Builders that need cross-interval data (e.g. metric
            // tiles using a fixed daily sparkline) read `seriesMap.day`
            // directly.
            series: intervalSeries,
            seriesMap,
          });
          return {
            id,
            type: def.type || 'metric',
            size: config.size,
            ...props,
          };
        } catch (err) {
          console.error(`[dashboard] tile "${id}" build failed:`, err);
          return null;
        }
      })
      .filter(Boolean);
    // tileCfg in deps so the builder re-runs when the operator tweaks a
    // tile from the settings popover (without it, getConfig closes over
    // the previous config map).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileIds, tileCfg, stats, seriesMap, insights, navigate]);

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

  const hasTiles = builtTiles.length > 0;

  return (
    <div style={{ padding: '0 2px', paddingBottom: 24 }}>
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
            {builtTiles.length} {builtTiles.length === 1 ? 'tile' : 'tiles'} active
          </div>
        </div>

        <button
          type="button"
          onClick={() => navigate('/settings/dashboard')}
          className="erp-customize-btn"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 14px', borderRadius: 999,
            border: '1px solid var(--border-strong)',
            background: 'var(--bg-elev)',
            color: 'var(--fg-primary)',
            fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          <SettingOutlined /> Customize
        </button>
      </header>

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
          Live data · trends, action items, and metrics
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>
          {dayjs().format('DD MMM YYYY')}
        </div>
      </div>

      {hasTiles ? (
        <section
          className="erp-tiles-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            // dense flow back-fills holes left by 2/3-wide chart tiles
            // with following 1-cell tiles, so the grid never has empty
            // slots. The reordering it implies is a worthwhile trade for
            // the visual coherence — a chart in row 1 col 1-2 and a
            // metric in col 3 reads cleaner than a metric in col 1 with
            // dead space to its right.
            gridAutoFlow: 'dense',
            gap: 16,
            paddingBottom: 28,
          }}
        >
          {builtTiles.map((t, i) => {
            const span = Math.max(1, Math.min(3, t.size || 1));
            const cellStyle = span > 1 ? { gridColumn: `span ${span}` } : undefined;
            const delayMs = 40 + i * 50;

            if (t.type === 'chart') {
              return (
                <div key={t.id} style={cellStyle}>
                  <EditorialChartTile
                    category={t.category}
                    title={t.title}
                    summary={t.summary}
                    summaryRight={t.summaryRight}
                    series={t.series}
                    xLabels={t.xLabels}
                    delayMs={delayMs}
                  />
                </div>
              );
            }

            if (t.type === 'list') {
              return (
                <div key={t.id} style={cellStyle}>
                  <EditorialListTile
                    category={t.category}
                    title={t.title}
                    summary={t.summary}
                    summaryRight={t.summaryRight}
                    items={t.items}
                    emptyText={t.emptyText}
                    footer={t.footer && (
                      <span
                        role={t.onFooter ? 'button' : undefined}
                        tabIndex={t.onFooter ? 0 : undefined}
                        onClick={t.onFooter}
                        onKeyDown={(e) => { if (t.onFooter && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); t.onFooter(); } }}
                        style={t.onFooter ? { cursor: 'pointer' } : undefined}
                      >
                        {t.footer}
                      </span>
                    )}
                    delayMs={delayMs}
                  />
                </div>
              );
            }

            // metric (default)
            return (
              <div key={t.id} style={cellStyle}>
                <EditorialTile
                  category={t.category}
                  tier={t.tier}
                  title={t.title}
                  valueCount={t.valueCount}
                  valueFormat={t.valueFormat}
                  valueLabel={t.valueLabel}
                  ringPct={t.ringPct}
                  ringLabel={t.ringLabel}
                  trendData={t.trendData}
                  trendLabel={t.trendLabel}
                  trendRight={
                    t.trendChip
                      ? <span className={`e-tile-trend-pct ${t.trendChip.tone}`}>{t.trendChip.text}</span>
                      : null
                  }
                  verdict={t.verdict}
                  delayMs={delayMs}
                />
              </div>
            );
          })}
        </section>
      ) : (
        <div style={{
          padding: 60, textAlign: 'center',
          border: '1px dashed var(--border-strong)', borderRadius: 12,
          color: 'var(--fg-secondary)',
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg-primary)', marginBottom: 8 }}>
            No tiles pinned
          </div>
          <div style={{ fontSize: 14, marginBottom: 18 }}>
            Pick the metrics you want to see on this dashboard.
          </div>
          <button
            type="button"
            onClick={() => navigate('/settings/dashboard')}
            style={{
              padding: '10px 20px', borderRadius: 8,
              border: '1px solid var(--accent)', background: 'var(--accent)',
              color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <SettingOutlined /> Customize tiles
          </button>
        </div>
      )}

      <div style={{
        marginTop: 24, padding: '18px 8px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: 12, color: 'var(--fg-tertiary)',
        textAlign: 'center',
      }}>
        {TILES.length} tiles available · trends, action items, and metrics
      </div>

      <style>{`
        @media (max-width: 1200px) {
          .erp-tiles-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .erp-tiles-grid > div[style*="span 3"] { grid-column: span 2 !important; }
        }
        @media (max-width: 720px) {
          .erp-tiles-grid { grid-template-columns: 1fr !important; }
          .erp-tiles-grid > div { grid-column: span 1 !important; }
        }
        .erp-customize-btn:hover { background: var(--bg-hover); }
      `}</style>
    </div>
  );
}
