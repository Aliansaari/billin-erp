import React, { useState } from 'react';
import { Card, Typography, Button, Tooltip, Switch, Tag } from 'antd';
import {
  DashboardOutlined, ReloadOutlined, AppstoreOutlined, EyeOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

import {
  ED_SECTIONS, readSectionPrefs, writeSectionPrefs, isSectionVisible,
} from '../../config/dashboardSections';
import ActionStrip from '../../components/keyboard/ActionStrip';

const { Title, Text } = Typography;

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
    <div style={{
      height: '100%', width: '100%',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-app)', overflow: 'hidden',
    }}>
      {/* ── Fixed header ─────────────────────────────────────────────── */}
      <header style={{
        flex: '0 0 auto',
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border)',
        padding: '18px clamp(12px, 2vw, 32px)',
      }}>
        <div style={{
          maxWidth: 900, margin: '0 auto',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, flexWrap: 'wrap',
        }}>
          <div>
            <Title level={3} style={{ margin: 0, color: 'var(--fg-primary)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <DashboardOutlined style={{ color: 'var(--accent)' }} />
              Dashboard
            </Title>
            <Text style={{ color: 'var(--fg-secondary)', fontSize: 13 }}>
              Choose which sections appear on your dashboard. {visibleCount} of {ED_SECTIONS.length} visible · changes apply instantly.
            </Text>
          </div>
          <Tooltip title="Show every section again.">
            <Button icon={<ReloadOutlined />} onClick={resetAll}>
              Show all
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────── */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <div style={{ padding: '20px clamp(12px, 2vw, 32px) 32px', maxWidth: 900, margin: '0 auto' }}>

          <Card
            bodyStyle={{ padding: 24 }}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 16 }}
          >
            <Title level={5} style={{ margin: '0 0 6px 0', color: 'var(--fg-primary)' }}>
              Dashboard sections
            </Title>
            <Text style={{ color: 'var(--fg-secondary)', fontSize: 13, display: 'block', marginBottom: 16 }}>
              Sections render top-to-bottom in this order. Hide the ones you don't use —
              the rest stretch to fill the page.
            </Text>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ED_SECTIONS.map((s, i) => {
                const on = isSectionVisible(prefs, s.id);
                return (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 14,
                      padding: '12px 14px',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      opacity: on ? 1 : 0.55,
                      transition: 'opacity .15s ease',
                    }}
                  >
                    <Tag style={{ minWidth: 30, textAlign: 'center', margin: 0 }}>{i + 1}</Tag>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-primary)' }}>
                        {s.label}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                        {s.desc}
                      </div>
                    </div>
                    <Switch
                      checked={on}
                      onChange={(v) => toggle(s.id, v)}
                      aria-label={`${on ? 'Hide' : 'Show'} ${s.label}`}
                    />
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Classic tile dashboard — still available, keeps its own layout. */}
          <Card
            bodyStyle={{ padding: '16px 24px' }}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', marginBottom: 24 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <AppstoreOutlined style={{ fontSize: 20, color: 'var(--fg-tertiary)' }} />
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-primary)' }}>
                  Classic tile dashboard
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginTop: 2 }}>
                  The previous customizable tile grid is still available and keeps its saved layout.
                </div>
              </div>
              <Button icon={<EyeOutlined />} onClick={() => navigate('/dashboard/classic')}>
                Open classic view
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <ActionStrip
        actions={[
          { id: 'back',    key: 'Esc', label: 'Back',    onAction: () => navigate('/dashboard') },
          { id: 'preview', key: 'F1',  label: 'Preview', tone: 'primary', onAction: () => navigate('/dashboard') },
        ]}
      />
    </div>
  );
}
