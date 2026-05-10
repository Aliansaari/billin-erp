import React from 'react';
import { RightOutlined } from '@ant-design/icons';
import { formatINRWithSymbol } from '../utils/format';

// Reusable KPI tile — colored mini-icon, label, big amount, drill arrow.
// Tap = navigate to drill route via the parent's onClick. The icon background
// uses the matching brand-soft variant so the dashboard reads as a coherent
// system rather than a rainbow.
export default function KPICard({ label, amount, tone = 'primary', icon, onClick, disabled }) {
  const toneVar  = `var(--c-${tone})`;
  const toneSoft = `var(--c-${tone}-soft)`;
  return (
    <div
      className="kpi-card tap-surface"
      onClick={disabled ? undefined : onClick}
      style={disabled ? { opacity: 0.55, cursor: 'default' } : undefined}
      role="button"
      tabIndex={disabled ? -1 : 0}
    >
      <div className="kpi-head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            className="kpi-icon"
            style={{ background: toneSoft, color: toneVar }}
            aria-hidden
          >
            {icon}
          </span>
          {label}
        </span>
        <RightOutlined style={{ fontSize: 11, color: 'var(--c-text-mute)' }} />
      </div>
      <div className={`kpi-amount${disabled ? ' kpi-amount-muted' : ''}`}>
        {formatINRWithSymbol(amount)}
      </div>
    </div>
  );
}
