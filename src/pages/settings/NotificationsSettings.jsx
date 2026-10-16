import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Switch, message } from 'antd';
import { BellOutlined, ClockCircleOutlined, SettingOutlined } from '@ant-design/icons';
import { notificationsAPI } from '../../api';
import '../../components/Notifications/notifications.css';

/* ──────────────────────────────────────────────────────────────────────────
 * Settings → Notifications.
 *
 * Two layers of control mirroring server-side NotificationSettings:
 *
 *   1. Master toggle: turns the entire feature off. Bell icon disappears
 *      from the topbar / sidebar, polling stops, no detectors run. Useful
 *      for firms / operators who don't want any nudges.
 *
 *   2. Per-detector toggles: granular opt-out per notification type. The
 *      list is fetched from the server (single source of truth for the
 *      catalog) so adding a new detector server-side surfaces here
 *      automatically — no separate client config to keep in sync.
 *
 * All changes are persisted on toggle (no Save button). PUT is debounced
 * to avoid spamming on rapid checkbox flips. After every save we
 * dispatch a `notifications:refresh` window event so the bell component
 * re-polls and the badge updates immediately — particularly important
 * when the operator flips master_enabled, since the bell needs to
 * appear / disappear on the spot.
 *
 * The page deliberately doesn't expose snooze defaults / quiet hours
 * yet — that's a v2 ask. v1 keeps the surface tight: on/off per type
 * plus the master switch.
 * ────────────────────────────────────────────────────────────────────────── */

const SECTION_META = {
  today:  { label: 'Today',     icon: ClockCircleOutlined, hint: 'Calendar reminders for things due today or soon.' },
  risk:   { label: 'Attention', icon: BellOutlined,        hint: 'State-change alerts the operator would otherwise miss.' },
  system: { label: 'System',    icon: SettingOutlined,     hint: 'Operational health — backups, syncs, jobs.' },
};

export default function NotificationsSettings() {
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [master, setMaster]       = useState(true);
  const [toggles, setToggles]     = useState({});
  const [types, setTypes]         = useState([]);

  // Initial load — pulls both settings and the catalog. The catalog
  // sits on /notifications (not /notifications/settings) so we issue
  // both calls.
  useEffect(() => {
    let cancelled = false;
    Promise.all([notificationsAPI.getSettings(), notificationsAPI.list()])
      .then(([sRes, lRes]) => {
        if (cancelled) return;
        const s = sRes?.data || {};
        const l = lRes?.data || {};
        setMaster(s.master_enabled !== false);
        setToggles(s.type_toggles || {});
        setTypes(Array.isArray(l.types) ? l.types : []);
      })
      .catch((e) => {
        if (cancelled) return;
        message.error(e?.message || 'Failed to load notification settings');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Persist whichever subset of settings changed. We accept an
  // overrides object so the optimistic local state can be the
  // source of truth for the request body — no race with the controlled
  // Switch component's value prop.
  const persist = useCallback(async (overrides) => {
    setSaving(true);
    try {
      await notificationsAPI.updateSettings(overrides);
      window.dispatchEvent(new Event('notifications:refresh'));
    } catch (e) {
      message.error('Save failed — your change wasn\'t persisted.');
      console.error('[notifications settings persist]', e);
    } finally {
      setSaving(false);
    }
  }, []);

  const onMasterChange = (next) => {
    setMaster(next);
    persist({ master_enabled: next });
  };
  const onTypeChange = (typeKey, next) => {
    setToggles((cur) => ({ ...cur, [typeKey]: next }));
    persist({ type_toggles: { [typeKey]: next } });
  };

  // Group types by section for the rendered list.
  const grouped = useMemo(() => {
    const out = { today: [], risk: [], system: [] };
    for (const t of types) {
      const sec = (out[t.section] ? t.section : 'risk');
      out[sec].push(t);
    }
    return out;
  }, [types]);

  const header = (
    <header className="ms-page-header">
      <h1 className="ms-page-title">Notifications</h1>
      <p className="ms-page-sub">Choose which alerts show under the bell for you. Other users keep their own choices.</p>
    </header>
  );

  if (loading) {
    return (
      <div className="ms-shell settings-pane-fill">{header}
        <div className="ms-page-body"><div className="ms-page-body-inner"><div className="notif-status">Loading…</div></div></div>
      </div>
    );
  }

  return (
    <div className="ms-shell settings-pane-fill">
      {header}
      <div className="ms-page-body"><div className="ms-page-body-inner">
        <section className="ms-section">
          <div className="ms-row">
            <div>
              <div className="ms-row-label">Show notifications</div>
              <div className="ms-row-desc">
                Off: the bell disappears and nothing is worked out for you. Your choices below are kept.
              </div>
            </div>
            <div className="ms-row-control">
              <Switch checked={master} disabled={saving} onChange={onMasterChange} />
            </div>
          </div>
        </section>

        {/* Per-detector toggles, grouped by section. Dimmed when the master
            switch is off so the saved choices stay visible. */}
        <div className={master ? '' : 'notif-settings-disabled'}>
          {['today', 'risk', 'system'].map((sec) => {
            const list = grouped[sec] || [];
            if (!list.length) return null;
            const M = SECTION_META[sec];
            const SecIcon = M.icon;
            return (
              <section key={sec} className="ms-section">
                <div className="ms-section-head">
                  <h2 className="ms-section-title"><SecIcon style={{ marginRight: 7, color: 'var(--fg-tertiary)' }} />{M.label}</h2>
                  {M.hint && <p className="ms-section-desc">{M.hint}</p>}
                </div>
                {list.map((t) => (
                  <div key={t.type} className="ms-row" data-disabled={!master || undefined}>
                    <div>
                      <div className="ms-row-label">{t.label}</div>
                      <div className="ms-row-desc">{t.description}</div>
                    </div>
                    <div className="ms-row-control">
                      <Switch
                        checked={toggles[t.type] !== false}
                        disabled={saving || !master}
                        onChange={(next) => onTypeChange(t.type, next)}
                      />
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div></div>
    </div>
  );
}
