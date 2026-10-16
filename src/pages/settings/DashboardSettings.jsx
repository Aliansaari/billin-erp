import React, { useState } from 'react';
import { Button, Tooltip, Switch } from 'antd';
import {
  ReloadOutlined, EyeOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

import {
  ED_SECTIONS, readSectionPrefs, writeSectionPrefs, isSectionVisible,
} from '../../config/dashboardSections';
import ActionStrip from '../../components/keyboard/ActionStrip';


/**
 * Dashboard Settings — show/hide the sections of the main dashboard
 * (/dashboard). Each toggle writes through to localStorage immediately;
 * the dashboard listens for the change event and re-renders live.
 *
 * History note: this page previously configured the retired tile grid
 * (now at /dashboard/classic), so its toggles had NO effect on the
 * dashboard the sidebar actually opens — the mismatch operators kept
 * reporting. It now authors the real one. The classic dashboard keeps
 * its stored layout and stays reachable below.
 */
export default function DashboardSettings() {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState(readSectionPrefs);

  const visibleCount = ED_SECTIONS.filter((s) => isSectionVisible(prefs, s.id)).length;

  const toggle = (id, on) => {
    // Store only explicit "off" flags — a missing key means visible, so
    // sections added in future versions default to on for everyone.
    const next = { ...prefs };
    if (on) delete next[id];
    else next[id] = false;
    setPrefs(next);
    writeSectionPrefs(next);
  };

  const resetAll = () => {
    setPrefs({});
    writeSectionPrefs({});
  };

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <div className="ms-page-header-row">
          <div>
            <h1 className="ms-page-title">Dashboard</h1>
            <p className="ms-page-sub">
              Choose which sections appear on your dashboard. {visibleCount} of {ED_SECTIONS.length} showing; changes apply at once.
            </p>
          </div>
          <Tooltip title="Show every section again.">
            <Button icon={<ReloadOutlined />} onClick={resetAll}>Show all</Button>
          </Tooltip>
        </div>
      </header>

      <div className="ms-page-body"><div className="ms-page-body-inner">
        <section className="ms-section">
          <div className="ms-section-head">
            <h2 className="ms-section-title">Sections</h2>
            <p className="ms-section-desc">Shown top to bottom in this order. Hide the ones you don't use; the rest stretch to fill the page.</p>
          </div>
          {ED_SECTIONS.map((s, i) => {
            const on = isSectionVisible(prefs, s.id);
            return (
              <div key={s.id} className="ms-row" style={{ gridTemplateColumns: 'auto 1fr auto', gap: 16 }}>
                <span className="ms-row-index">{i + 1}</span>
                <div style={{ opacity: on ? 1 : 0.55, transition: 'opacity .15s ease' }}>
                  <div className="ms-row-label">{s.label}</div>
                  <div className="ms-row-desc">{s.desc}</div>
                </div>
                <div className="ms-row-control">
                  <Switch checked={on} onChange={(v) => toggle(s.id, v)} aria-label={`${on ? 'Hide' : 'Show'} ${s.label}`} />
                </div>
              </div>
            );
          })}
        </section>

        {/* Classic tile dashboard — still available, keeps its own layout. */}
        <section className="ms-section">
          <div className="ms-row">
            <div>
              <div className="ms-row-label">Classic tile dashboard</div>
              <div className="ms-row-desc">The older tile grid is still available and keeps its saved layout.</div>
            </div>
            <div className="ms-row-control">
              <Button icon={<EyeOutlined />} onClick={() => navigate('/dashboard/classic')}>Open classic view</Button>
            </div>
          </div>
        </section>
      </div></div>

      <ActionStrip
        actions={[
          { id: 'back',    key: 'Esc', label: 'Back',    onAction: () => navigate('/dashboard') },
          { id: 'preview', key: 'F1',  label: 'Preview', tone: 'primary', onAction: () => navigate('/dashboard') },
        ]}
      />
    </div>
  );
}
