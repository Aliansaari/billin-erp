import React, { useMemo } from 'react';
import { Card, Typography, Button, Tooltip, Tag, Empty, Popover, Segmented, Space } from 'antd';
import {
  DashboardOutlined, ReloadOutlined, PlusOutlined, CloseOutlined,
  ArrowUpOutlined, ArrowDownOutlined, CheckOutlined, EyeOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

import useDashboardSettingsStore, {
  SIZE_CHOICES, INTERVAL_CHOICES,
  PERIOD_CHOICES_FOR_INTERVAL, DEFAULT_PERIODS_FOR_INTERVAL,
} from '../../store/dashboardSettingsStore';
import { TILES, TILE_GROUPS, TYPE_LABEL, getTileById } from '../../config/dashboardTiles';
import ActionStrip from '../../components/keyboard/ActionStrip';

const { Title, Text } = Typography;

/**
 * Dashboard Settings — pick which tiles appear on the Dashboard and in
 * what order. The dashboard reads `tiles` (an ordered id array) from
 * dashboardSettingsStore; this page is the only authoring surface.
 *
 * Layout: fixed header strip (title + Restore defaults) above a
 * scrolling body with two cards:
 *   1. Active — pinned tiles, reorderable via ↑/↓ buttons, removable via ×.
 *   2. Available — every tile in the catalog, grouped by section. A
 *      "+ Add" button beside each unpinned tile appends to the active
 *      list; pinned tiles render as a dimmed, ticked card so the
 *      operator can see what's already in.
 *
 * Every change writes through the zustand store, so the dashboard picks
 * it up on the next render — no save / apply step.
 */
export default function DashboardSettings() {
  const navigate  = useNavigate();
  const tiles     = useDashboardSettingsStore((s) => s.tiles);
  const cfgMap    = useDashboardSettingsStore((s) => s.config);
  const add       = useDashboardSettingsStore((s) => s.add);
  const remove    = useDashboardSettingsStore((s) => s.remove);
  const move      = useDashboardSettingsStore((s) => s.move);
  const reset     = useDashboardSettingsStore((s) => s.reset);
  const setConfig = useDashboardSettingsStore((s) => s.setConfig);

  // Resolve ordered ids → catalog entries; drop any stale ids the
  // catalog no longer knows about so the operator can't action them.
  const activeTiles = useMemo(
    () => tiles.map((id) => getTileById(id)).filter(Boolean),
    [tiles],
  );

  const isActive = (id) => tiles.includes(id);

  // Group catalog by section for the picker. The render order for
  // groups is fixed by TILE_GROUPS so "Today" is always first, etc.
  const grouped = useMemo(() => {
    const out = {};
    for (const g of TILE_GROUPS) out[g] = [];
    for (const t of TILES) {
      if (out[t.group]) out[t.group].push(t);
      else { (out[t.group] = out[t.group] || []).push(t); }
    }
    return out;
  }, []);

  return (
    <div style={{
      height: '100%', width: '100%',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-app)', overflow: 'hidden',
    }}>
      <FixedHeader onReset={reset} activeCount={activeTiles.length} />

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <div style={{ padding: '20px clamp(12px, 2vw, 32px) 32px', maxWidth: 1100, margin: '0 auto' }}>

          {/* ── Active tiles ───────────────────────────────────────── */}
          <Card
            bodyStyle={{ padding: 24 }}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 16 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <Title level={5} style={{ margin: 0, color: 'var(--fg-primary)' }}>
                Active tiles
              </Title>
              <Text style={{ color: 'var(--fg-tertiary)', fontSize: 12 }}>
                {activeTiles.length} on dashboard · in display order
              </Text>
            </div>
            <Text style={{ color: 'var(--fg-secondary)', fontSize: 13, display: 'block', marginBottom: 16 }}>
              Use ↑ / ↓ to reorder. Tiles render left-to-right, top-to-bottom in a 3-column grid.
            </Text>

            {activeTiles.length === 0 ? (
              <Empty
                description="No tiles pinned yet — add some from the Available list below."
                style={{ padding: '20px 0 4px' }}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {activeTiles.map((t, i) => (
                  <ActiveRow
                    key={t.id}
                    tile={t}
                    index={i}
                    total={activeTiles.length}
                    config={(cfgMap || {})[t.id] || {}}
                    onUp={() => move(t.id, -1)}
                    onDown={() => move(t.id, +1)}
                    onRemove={() => remove(t.id)}
                    onConfig={(partial) => setConfig(t.id, partial)}
                  />
                ))}
              </div>
            )}
          </Card>

          {/* ── Available tiles ───────────────────────────────────── */}
          <Card
            bodyStyle={{ padding: 24 }}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 24 }}
          >
            <Title level={5} style={{ margin: '0 0 6px 0', color: 'var(--fg-primary)' }}>
              Available tiles
            </Title>
            <Text style={{ color: 'var(--fg-secondary)', fontSize: 13, display: 'block', marginBottom: 16 }}>
              Every metric the dashboard can render — pick what fits how you work. {TILES.length} total.
            </Text>

            {TILE_GROUPS.map((g) => {
              const list = grouped[g] || [];
              if (list.length === 0) return null;
              return (
                <div key={g} style={{ marginBottom: 22 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: 1.2,
                    textTransform: 'uppercase', color: 'var(--fg-tertiary)',
                    marginBottom: 10,
                  }}>
                    {g}
                  </div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: 10,
                  }}>
                    {list.map((t) => (
                      <AvailableCard
                        key={t.id}
                        tile={t}
                        active={isActive(t.id)}
                        onAdd={() => add(t.id)}
                        onRemove={() => remove(t.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </Card>
        </div>
      </div>

      <ActionStrip
        actions={[
          { id: 'back',    key: 'Esc', label: 'Back',     onAction: () => navigate('/dashboard') },
          { id: 'preview', key: 'F1',  label: 'Preview',  tone: 'primary', onAction: () => navigate('/dashboard') },
        ]}
      />
    </div>
  );
}

function FixedHeader({ onReset, activeCount }) {
  return (
    <header style={{
      flex: '0 0 auto',
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      padding: '18px clamp(12px, 2vw, 32px)',
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <Title level={3} style={{ margin: 0, color: 'var(--fg-primary)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <DashboardOutlined style={{ color: 'var(--accent)' }} />
            Dashboard
          </Title>
          <Text style={{ color: 'var(--fg-secondary)', fontSize: 13 }}>
            Pick the metrics you want to see. {activeCount} {activeCount === 1 ? 'tile' : 'tiles'} active. Changes save instantly.
          </Text>
        </div>
        <Tooltip title="Reset to the recommended starting set.">
          <Button icon={<ReloadOutlined />} onClick={onReset}>
            Restore defaults
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}

function TypeBadge({ type, size }) {
  const t = type || 'metric';
  const wide = (size || 1) > 1;
  const tone = t === 'chart' ? 'blue' : t === 'list' ? 'orange' : 'default';
  return (
    <Tag color={tone} style={{ margin: 0, fontSize: 10, fontWeight: 600, letterSpacing: 0.4 }}>
      {TYPE_LABEL[t] || t}
      {wide ? ` · ${size}-wide` : ''}
    </Tag>
  );
}

function ActiveRow({ tile, index, total, config, onUp, onDown, onRemove, onConfig }) {
  // Per-tile configurability — defaults to "size only" so every tile is
  // resizable; chart tiles also get an interval+periods control via
  // `configurable: { interval: true }` in the catalog.
  const conf = tile.configurable || { size: true };
  const effectiveSize = config.size ?? tile.size ?? 1;
  const effectiveInterval = config.interval ?? tile.defaultInterval ?? 'day';
  const effectivePeriods  = config.periods  ?? tile.defaultPeriods
    ?? DEFAULT_PERIODS_FOR_INTERVAL[effectiveInterval] ?? 30;
  const hasOverride = (config.size     != null && config.size     !== (tile.size ?? 1))
    || (config.interval != null && config.interval !== (tile.defaultInterval ?? 'day'))
    || (config.periods  != null && config.periods  !== (tile.defaultPeriods
      ?? DEFAULT_PERIODS_FOR_INTERVAL[effectiveInterval]));

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px',
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 8,
    }}>
      <Tag color="default" style={{ minWidth: 32, textAlign: 'center', margin: 0 }}>
        {index + 1}
      </Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-primary)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {tile.label}
          <TypeBadge type={tile.type} size={effectiveSize} />
          {conf.interval && (
            <Tag style={{ margin: 0, fontSize: 10, fontWeight: 600, letterSpacing: 0.4 }}>
              {effectivePeriods}{effectiveInterval === 'month' ? 'mo' : effectiveInterval === 'week' ? 'w' : 'd'}
            </Tag>
          )}
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
            textTransform: 'uppercase', color: 'var(--fg-tertiary)',
          }}>
            · {tile.group}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginTop: 2 }}>
          {tile.description}
        </div>
      </div>
      <Popover
        trigger="click"
        placement="bottomRight"
        title={<span style={{ fontSize: 13 }}>Customize this tile</span>}
        content={
          <ConfigPopover
            tile={tile}
            config={config}
            onConfig={onConfig}
            hasOverride={hasOverride}
          />
        }
      >
        <Tooltip title={hasOverride ? 'Customized — click to adjust' : 'Customize this tile'}>
          <Button
            size="small"
            type={hasOverride ? 'primary' : 'default'}
            ghost={hasOverride}
            icon={<SettingOutlined />}
          />
        </Tooltip>
      </Popover>
      <Tooltip title="Move up">
        <Button size="small" icon={<ArrowUpOutlined />} onClick={onUp} disabled={index === 0} />
      </Tooltip>
      <Tooltip title="Move down">
        <Button size="small" icon={<ArrowDownOutlined />} onClick={onDown} disabled={index === total - 1} />
      </Tooltip>
      <Tooltip title="Remove from dashboard">
        <Button size="small" danger icon={<CloseOutlined />} onClick={onRemove} />
      </Tooltip>
    </div>
  );
}

function ConfigPopover({ tile, config, onConfig, hasOverride }) {
  const conf = tile.configurable || { size: true };
  const size     = config.size     ?? tile.size ?? 1;
  const interval = config.interval ?? tile.defaultInterval ?? 'day';
  const periodChoices = PERIOD_CHOICES_FOR_INTERVAL[interval] || [];
  // If the operator picks an interval whose default-period choices don't
  // include the current `periods`, snap to the interval's default so
  // the segmented control always renders a selected option.
  const periods = config.periods != null && periodChoices.includes(config.periods)
    ? config.periods
    : (DEFAULT_PERIODS_FOR_INTERVAL[interval] ?? periodChoices[0] ?? 30);

  const handleIntervalChange = (next) => {
    // Switching interval invalidates the previous period count, so the
    // store change has to update both keys atomically — otherwise a
    // user who picks "month" while "periods=90" was set would request
    // 90 monthly buckets (server caps it but the picker would render
    // out-of-range). Snap to the new interval's default.
    onConfig({
      interval: next,
      periods: DEFAULT_PERIODS_FOR_INTERVAL[next] ?? periodChoices[0] ?? null,
    });
  };

  const intervalLabel = (i) => i === 'month' ? 'Month' : i === 'week' ? 'Week' : 'Day';
  const periodLabel = (n) => interval === 'month'
    ? `${n} mo`
    : interval === 'week'
      ? `${n} wk`
      : `${n} d`;

  return (
    <div style={{ minWidth: 280 }}>
      {conf.size && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-secondary)', marginBottom: 6 }}>
            Tile width
          </div>
          <Segmented
            block
            size="small"
            value={size}
            onChange={(v) => onConfig({ size: Number(v) })}
            options={SIZE_CHOICES.map((n) => ({
              value: n,
              label: n === 1 ? 'Compact' : n === 2 ? 'Wide' : 'Full',
            }))}
          />
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            How many grid columns this tile takes.
          </div>
        </div>
      )}
      {conf.interval && (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-secondary)', marginBottom: 6 }}>
              Bar = one
            </div>
            <Segmented
              block
              size="small"
              value={interval}
              onChange={handleIntervalChange}
              options={INTERVAL_CHOICES.map((i) => ({
                value: i,
                label: intervalLabel(i),
              }))}
            />
            <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
              Each bar in the chart aggregates one {intervalLabel(interval).toLowerCase()}.
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-secondary)', marginBottom: 6 }}>
              How many to show
            </div>
            <Segmented
              block
              size="small"
              value={periods}
              onChange={(v) => onConfig({ periods: Number(v) })}
              options={periodChoices.map((n) => ({
                value: n,
                label: periodLabel(n),
              }))}
            />
            <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
              Trailing {interval === 'month' ? 'months' : interval === 'week' ? 'weeks' : 'days'} of history shown.
            </div>
          </div>
        </>
      )}
      {hasOverride && (
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => onConfig({ size: null, interval: null, periods: null })}
          block
        >
          Reset to default
        </Button>
      )}
    </div>
  );
}

function AvailableCard({ tile, active, onAdd, onRemove }) {
  return (
    <div style={{
      position: 'relative',
      display: 'flex', flexDirection: 'column',
      gap: 8,
      padding: '12px 14px',
      background: active ? 'var(--accent-bg)' : 'var(--bg-elevated)',
      border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius: 10,
      transition: 'border-color .12s ease, background-color .12s ease',
      minHeight: 96,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-primary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {tile.label}
            <TypeBadge type={tile.type} size={tile.size} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginTop: 4, lineHeight: 1.4 }}>
            {tile.description}
          </div>
        </div>
        {active ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999,
            background: 'var(--accent)', color: '#fff',
            fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
          }}>
            <CheckOutlined style={{ fontSize: 10 }} /> Pinned
          </span>
        ) : null}
      </div>
      <div>
        {active ? (
          <Button size="small" icon={<CloseOutlined />} onClick={onRemove}>
            Remove
          </Button>
        ) : (
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={onAdd}>
            Add to dashboard
          </Button>
        )}
      </div>
    </div>
  );
}
