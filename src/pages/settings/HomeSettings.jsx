import React from 'react';
import {
  Card, Typography, Space, Switch, Segmented, Button, Divider, Tooltip,
} from 'antd';
import {
  HomeOutlined, AppstoreOutlined, FieldTimeOutlined, ThunderboltOutlined,
  EyeOutlined, ReloadOutlined, CheckOutlined,
  ShoppingCartOutlined, InboxOutlined, DollarCircleOutlined, CreditCardOutlined,
  RollbackOutlined, AuditOutlined, TeamOutlined, ProductOutlined,
  BarChartOutlined, DashboardOutlined, BookOutlined, BankOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

import useHomeSettingsStore, { KNOWN_ACTIONS } from '../../store/homeSettingsStore';
import ActionStrip from '../../components/keyboard/ActionStrip';

const { Title, Text } = Typography;

/**
 * Home Settings — per-user customization of the Command Center page (route /).
 *
 * Layout: fixed header (title + Restore defaults) sits at the top of the
 * AppLayout Content area; everything below it scrolls inside this page's
 * own body so the app-level scrollbar never engages. Pattern mirrors the
 * editorial reports (sticky title strip + scrolling body).
 *
 * Three logical groups, each in its own card:
 *   1. KPI strip — show/hide the row, plus per-card visibility.
 *   2. Hero (greeting + clock + headline + search + ambient).
 *   3. Action ribbon — row visibility + which actions to include.
 *
 * Every change writes through useHomeSettingsStore (Zustand + persist), so
 * the home page picks it up the next time it renders. The preview at the
 * top of the page reflects every toggle without a navigate.
 */

/* Pretty action labels — kept in sync with ACTION_CATALOG over in Home.jsx.
 * Duplicated rather than imported because the Home component pulls in
 * dayjs / Sparkline deps the settings page doesn't need. Small enough that
 * drift risk is low; if we ever grow this list, lift to a shared module. */
const ACTION_META = {
  'sale-new':        { label: 'Sale',            sub: 'New customer invoice', icon: ShoppingCartOutlined },
  'purchase-new':    { label: 'Purchase',        sub: 'New supplier bill',    icon: InboxOutlined },
  'receipt-new':     { label: 'Receipt',         sub: 'Money in',             icon: DollarCircleOutlined },
  'payment-new':     { label: 'Payment',         sub: 'Money out',            icon: CreditCardOutlined },
  'sales-return':    { label: 'Sales return',    sub: 'Credit note',          icon: RollbackOutlined },
  'purchase-return': { label: 'Purchase return', sub: 'Debit note',           icon: RollbackOutlined },
  'journal-new':     { label: 'Journal',         sub: 'Manual entry',         icon: AuditOutlined },
  'customers':       { label: 'Customers',       sub: 'Party master',         icon: TeamOutlined },
  'suppliers':       { label: 'Suppliers',       sub: 'Vendor master',        icon: TeamOutlined },
  'products':        { label: 'Products',        sub: 'Item master',          icon: ProductOutlined },
  'reports':         { label: 'Reports',         sub: 'All reports',          icon: BarChartOutlined },
  'dashboard':       { label: 'Dashboard',       sub: 'Every metric',         icon: DashboardOutlined },
  'day-book':        { label: 'Day book',        sub: 'All vouchers · today', icon: BookOutlined },
  'banks':           { label: 'Banks',           sub: 'Reconciliation',       icon: BankOutlined },
};

export default function HomeSettings() {
  const navigate = useNavigate();
  const cfg    = useHomeSettingsStore();
  const update = useHomeSettingsStore((s) => s.update);
  const reset  = useHomeSettingsStore((s) => s.reset);

  const toggleAction = (id) => {
    const has = (cfg.actions || []).includes(id);
    const next = has
      ? cfg.actions.filter((x) => x !== id)
      : [...(cfg.actions || []), id];
    update({ actions: next });
  };

  return (
    /* Outer shell — fills the AppLayout's full-page Content (100vh). The
     * page splits into a fixed header and a scrolling body so toggle cards
     * scroll inside this page without engaging the app-level scrollbar. */
    <div style={{
      height: '100%',
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-app)',
      overflow: 'hidden',
    }}>
      <FixedHeader onReset={reset} />

      {/* Scrollable body — every card lives here. */}
      <div style={{
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
      }}>
        <div style={{ padding: '20px clamp(12px, 2vw, 32px) 32px', maxWidth: 960, margin: '0 auto' }}>

          {/* ── Live preview ────────────────────────────────────────────────── */}
          <Card
            bodyStyle={{ padding: 0 }}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 20, overflow: 'hidden' }}
          >
            <PreviewBar />
            <Preview cfg={cfg} />
          </Card>

          {/* ── 1. KPI strip ────────────────────────────────────────────────── */}
          <Card
            bodyStyle={{ padding: 24 }}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 16 }}
          >
            <SectionTitle
              icon={<AppstoreOutlined />}
              title="KPI strip"
              subtitle="The row of summary cards across the top."
              right={
                <Switch
                  checked={cfg.showKpiStrip}
                  onChange={(v) => update({ showKpiStrip: v })}
                />
              }
            />
            <Divider style={{ margin: '12px 0 16px' }} />
            <ToggleRow disabled={!cfg.showKpiStrip} label="Sales today"     checked={cfg.showKpiSales}   onChange={(v) => update({ showKpiSales: v })} />
            <ToggleRow disabled={!cfg.showKpiStrip} label="Bills today"     checked={cfg.showKpiBills}   onChange={(v) => update({ showKpiBills: v })} />
            <ToggleRow disabled={!cfg.showKpiStrip} label="Receivables"     checked={cfg.showKpiRecv}    onChange={(v) => update({ showKpiRecv: v })} />
            <ToggleRow disabled={!cfg.showKpiStrip} label="Payables"        checked={cfg.showKpiPay}     onChange={(v) => update({ showKpiPay: v })} />
            <ToggleRow disabled={!cfg.showKpiStrip} label="Profit · MTD"    checked={cfg.showKpiProfit}  onChange={(v) => update({ showKpiProfit: v })} />
            <Divider style={{ margin: '12px 0' }} />
            <ToggleRow disabled={!cfg.showKpiStrip} label="Sparklines on each card" hint="Tiny trend curves under the value." checked={cfg.showKpiSparks} onChange={(v) => update({ showKpiSparks: v })} />
          </Card>

          {/* ── 2. Hero (clock + greeting + search hint) ────────────────────── */}
          <Card
            bodyStyle={{ padding: 24 }}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 16 }}
          >
            <SectionTitle
              icon={<FieldTimeOutlined />}
              title="Hero — clock & greeting"
              subtitle="The big block in the middle of the page."
            />
            <Divider style={{ margin: '12px 0 16px' }} />

            <ToggleRow label="Show clock"          hint="Big tabular HH:mm at the bottom of the hero."           checked={cfg.showClock}      onChange={(v) => update({ showClock: v })} />
            <ToggleRow disabled={!cfg.showClock} label="Show date below clock"  hint="Weekday and full date."                                checked={cfg.showClockDate}  onChange={(v) => update({ showClockDate: v })} />
            <ToggleRow disabled={!cfg.showClock} label="Show seconds"           hint="Adds :ss to the time and ticks every second."         checked={cfg.showSeconds}    onChange={(v) => update({ showSeconds: v })} />
            <ToggleRow disabled={!cfg.showClock} label="Live pulse"             hint="Animated green dot beside the time."                  checked={cfg.showLivePulse}  onChange={(v) => update({ showLivePulse: v })} />

            <SegmentedRow
              label="Time format"
              hint="24-hour reads more confidently in tabular numerals."
              value={cfg.clockFormat}
              onChange={(v) => update({ clockFormat: v })}
              options={[
                { label: '24-hour', value: '24' },
                { label: '12-hour', value: '12' },
              ]}
              disabled={!cfg.showClock}
            />

            <SegmentedRow
              label="Date format"
              hint="Long is great at a glance; numeric is easy to copy into a field."
              value={cfg.clockDateFormat}
              onChange={(v) => update({ clockDateFormat: v })}
              options={[
                { label: 'TUESDAY · 05 MAY 2026', value: 'long' },
                { label: 'TUESDAY · 05/05/2026',  value: 'numeric' },
              ]}
              disabled={!cfg.showClock || !cfg.showClockDate}
            />

            <Divider style={{ margin: '12px 0' }} />

            <ToggleRow label="Show greeting"        hint='"Working late, Ali" eyebrow above the headline.'    checked={cfg.showGreeting}   onChange={(v) => update({ showGreeting: v })} />
            <ToggleRow label="Show headline"        hint='"What would you like to do?"'                       checked={cfg.showHeadline}   onChange={(v) => update({ showHeadline: v })} />
            <ToggleRow label="Show search bar"      hint="The big global search input in the middle of the page (⌘K still works)." checked={cfg.showSearch} onChange={(v) => update({ showSearch: v })} />
            <ToggleRow disabled={!cfg.showSearch} label="Show keyboard hint" hint="Quiet line below search showing ⌥S, ⌥P, ⌘K." checked={cfg.showSearchHint} onChange={(v) => update({ showSearchHint: v })} />
            <ToggleRow label="Ambient gradient"     hint="Soft accent wash behind the page (Editorial theme)."  checked={cfg.showAmbientGradient} onChange={(v) => update({ showAmbientGradient: v })} />
          </Card>

          {/* ── 3. Action ribbon ────────────────────────────────────────────── */}
          <Card
            bodyStyle={{ padding: 24 }}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 24 }}
          >
            <SectionTitle
              icon={<ThunderboltOutlined />}
              title="Action ribbon"
              subtitle="Quick-access buttons pinned to the bottom of the page."
              right={
                <Switch
                  checked={cfg.showActionRibbon}
                  onChange={(v) => update({ showActionRibbon: v })}
                />
              }
            />
            <Divider style={{ margin: '12px 0 16px' }} />

            <Text style={{ color: 'var(--fg-secondary)', fontSize: 13, display: 'block', marginBottom: 14 }}>
              Click a card to add or remove it from the ribbon. Aim for 4–6 actions for the cleanest look.
            </Text>

            <ActionPickerGrid
              actions={KNOWN_ACTIONS}
              selectedIds={cfg.actions || []}
              onToggle={toggleAction}
              disabled={!cfg.showActionRibbon}
            />
          </Card>
        </div>
      </div>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
        ]}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Fixed header — sticky title strip at the top of the page.
 * Sits above the scrollable body so the title + restore-defaults stay
 * visible while the operator scrolls through toggle cards below.
 * ══════════════════════════════════════════════════════════════════════════ */
function FixedHeader({ onReset }) {
  return (
    <header style={{
      flex: '0 0 auto',
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      padding: '18px clamp(12px, 2vw, 32px)',
    }}>
      <div style={{
        maxWidth: 960, margin: '0 auto',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <Title level={3} style={{ margin: 0, color: 'var(--fg-primary)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <HomeOutlined style={{ color: 'var(--accent)' }} />
            Home page
          </Title>
          <Text style={{ color: 'var(--fg-secondary)', fontSize: 13 }}>
            Choose what shows on the Command Center landing page. Changes save instantly.
          </Text>
        </div>
        <Tooltip title="Restore every toggle to its default value.">
          <Button icon={<ReloadOutlined />} onClick={onReset}>
            Restore defaults
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Action picker — grid of card buttons. Each card mirrors the look of the
 * actual ribbon button (icon tile + label + sub) so the operator can see
 * what they're picking. Selected = accent border + accent-bg + tick.
 * ══════════════════════════════════════════════════════════════════════════ */
function ActionPickerGrid({ actions, selectedIds, onToggle, disabled }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
      gap: 10,
      opacity: disabled ? 0.5 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
    }}>
      {actions.map((id) => {
        const meta = ACTION_META[id] || { label: id, sub: '', icon: AppstoreOutlined };
        const Icon = meta.icon;
        const checked = selectedIds.includes(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onToggle(id)}
            aria-pressed={checked}
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              background: checked ? 'var(--accent-bg)' : 'var(--bg-elevated)',
              border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md, 10px)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textAlign: 'left',
              transition: 'transform .12s ease, border-color .12s ease, background-color .12s ease, box-shadow .12s ease',
              minHeight: 60,
            }}
            onMouseEnter={(e) => {
              if (checked) return;
              e.currentTarget.style.borderColor = 'var(--accent-border)';
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = 'var(--shadow-md)';
            }}
            onMouseLeave={(e) => {
              if (checked) return;
              e.currentTarget.style.borderColor = 'var(--border)';
              e.currentTarget.style.transform = '';
              e.currentTarget.style.boxShadow = '';
            }}
          >
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32, height: 32,
              borderRadius: 8,
              background: checked ? 'var(--accent)' : 'var(--accent-bg)',
              color: checked ? 'var(--fg-inverse, #fff)' : 'var(--accent)',
              fontSize: 16,
              flex: '0 0 auto',
              transition: 'background-color .12s ease, color .12s ease',
            }}>
              <Icon />
            </span>
            <span style={{ minWidth: 0, flex: 1, lineHeight: 1.2 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {meta.label}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--fg-tertiary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {meta.sub}
              </span>
            </span>
            {/* Tick badge — top-right when selected. Soft, not loud. */}
            {checked && (
              <span style={{
                position: 'absolute',
                top: 6, right: 6,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18, height: 18,
                borderRadius: '50%',
                background: 'var(--accent)',
                color: 'var(--fg-inverse, #fff)',
                fontSize: 11,
                lineHeight: 1,
              }}>
                <CheckOutlined />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Section title helper ────────────────────────────────────────────────── */
function SectionTitle({ icon, title, subtitle, right }) {
  return (
    <Space align="start" size={16} style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
      <Space align="start" size={16}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: 'var(--accent-bg)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flex: '0 0 auto',
        }}>
          {icon}
        </div>
        <div>
          <Title level={5} style={{ margin: 0, color: 'var(--fg-primary)' }}>{title}</Title>
          <Text style={{ color: 'var(--fg-secondary)', fontSize: 13 }}>{subtitle}</Text>
        </div>
      </Space>
      {right && <div style={{ flex: '0 0 auto' }}>{right}</div>}
    </Space>
  );
}

/* ── Reusable toggle row ─────────────────────────────────────────────────── */
function ToggleRow({ label, hint, checked, onChange, disabled }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 0',
      opacity: disabled ? 0.5 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
    }}>
      <div style={{ minWidth: 0, paddingRight: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--fg-primary)' }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: 'var(--fg-tertiary)', marginTop: 2 }}>{hint}</div>}
      </div>
      <Switch checked={!!checked} onChange={onChange} />
    </div>
  );
}

/* ── Segmented control row — same shape as ToggleRow but with a Segmented
 *    control on the right instead of a Switch. */
function SegmentedRow({ label, hint, value, onChange, options, disabled }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 0',
      gap: 12,
      opacity: disabled ? 0.5 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--fg-primary)' }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: 'var(--fg-tertiary)', marginTop: 2 }}>{hint}</div>}
      </div>
      <Segmented value={value} onChange={onChange} options={options} disabled={disabled} />
    </div>
  );
}

/* ── Preview ─────────────────────────────────────────────────────────────── */
function PreviewBar() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 14px',
      background: 'var(--bg-muted)',
      borderBottom: '1px solid var(--border)',
      fontSize: 11, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase',
      color: 'var(--fg-tertiary)',
    }}>
      <EyeOutlined />
      Live preview
    </div>
  );
}

/* A miniature, non-interactive representation of the home page so the
 * operator can sanity-check what they're toggling before navigating away.
 * Uses the same color tokens but at smaller scale; it isn't pixel-perfect
 * (the real page picks up live data + animations) — it's just a layout
 * stand-in. */
function Preview({ cfg }) {
  const visibleKpiCount = [
    cfg.showKpiSales, cfg.showKpiBills, cfg.showKpiRecv, cfg.showKpiPay, cfg.showKpiProfit,
  ].filter(Boolean).length;
  const actionCount = (cfg.actions || []).length || 1;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: 280,
      background: 'var(--bg-app)',
      padding: 0,
    }}>
      {/* KPI strip */}
      {cfg.showKpiStrip && visibleKpiCount > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${visibleKpiCount}, 1fr)`,
          gap: 6,
          padding: '8px 12px',
          flex: '0 0 auto',
        }}>
          {Array.from({ length: visibleKpiCount }).map((_, i) => (
            <div key={i} style={{
              background: 'var(--bg-panel)', border: '1px solid var(--border)',
              borderRadius: 6, height: 50, padding: 6,
              display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
            }}>
              <div style={{ height: 5, width: '40%', background: 'var(--bg-muted)', borderRadius: 2 }} />
              <div style={{ height: 8, width: '60%', background: 'var(--fg-tertiary)', opacity: 0.4, borderRadius: 2 }} />
              {cfg.showKpiSparks && <div style={{ height: 4, width: '90%', background: 'var(--accent-bg)', borderRadius: 2 }} />}
            </div>
          ))}
        </div>
      )}

      {/* Hero — order mirrors Home.jsx: greeting → headline → search → hint → clock. */}
      <div style={{
        flex: '1 1 auto', minHeight: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 8,
        padding: 12,
      }}>
        {cfg.showGreeting && (
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.4, color: 'var(--accent)', textTransform: 'uppercase' }}>
            WORKING LATE
          </div>
        )}
        {cfg.showHeadline && (
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-primary)' }}>
            What would you like to do?
          </div>
        )}
        {cfg.showSearch && (
          <div style={{
            height: 22, width: '60%',
            background: 'var(--bg-elevated)',
            border: '1.5px solid var(--accent-border)',
            borderRadius: 8,
            boxShadow: '0 0 0 3px var(--accent-bg)',
          }} />
        )}
        {cfg.showSearch && cfg.showSearchHint && (
          <div style={{ height: 5, width: '40%', background: 'var(--bg-muted)', borderRadius: 2 }} />
        )}
        {cfg.showClock && (
          <div style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 28, fontWeight: 700, color: 'var(--fg-primary)',
            letterSpacing: '-0.04em',
            display: 'flex', alignItems: 'center', gap: 8,
            marginTop: 6,
          }}>
            {cfg.showLivePulse && (
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: 'var(--success)',
                boxShadow: '0 0 0 3px var(--success-bg)',
              }} />
            )}
            {(() => {
              if (cfg.clockFormat === '12') return cfg.showSeconds ? '1:17:42 AM' : '1:17 AM';
              return cfg.showSeconds ? '01:17:42' : '01:17';
            })()}
          </div>
        )}
        {cfg.showClock && cfg.showClockDate && (
          <div style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 1.4,
            color: 'var(--fg-secondary)',
            textTransform: 'uppercase',
            fontFeatureSettings: '"tnum"',
          }}>
            {cfg.clockDateFormat === 'numeric' ? 'TUESDAY · 05/05/2026' : 'TUESDAY · 05 MAY 2026'}
          </div>
        )}
      </div>

      {/* Action ribbon */}
      {cfg.showActionRibbon && actionCount > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(actionCount, 8)}, 1fr)`,
          gap: 4,
          padding: '8px 12px',
          background: 'var(--bg-muted)',
          borderTop: '1px solid var(--border)',
          flex: '0 0 auto',
        }}>
          {Array.from({ length: Math.min(actionCount, 8) }).map((_, i) => (
            <div key={i} style={{
              height: 28, background: 'var(--bg-panel)',
              border: '1px solid var(--border)', borderRadius: 5,
            }} />
          ))}
        </div>
      )}
    </div>
  );
}
