import React from 'react';
import './editorial.css';

/**
 * GlassSwitch — glassy segmented control used for the dashboard period
 * picker ("Today / This month / Quarter / Year") and the light/dark
 * toggle. Wraps a set of buttons in a frosted pill.
 *
 * Props:
 *   options   { label, value, icon? }[]
 *   value     currently-active value
 *   onChange  (next) => void
 */
export default function GlassSwitch({ options = [], value, onChange }) {
  return (
    <div className="e-switch e-glass">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? 'on' : ''}
          onClick={() => onChange && onChange(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}
