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

  if (loading) {
    return <div className="notif-settings"><div className="notif-status">Loading…</div></div>;
  }

  return (
    <div className="notif-settings">
      {/* Master toggle — accent-tinted so it reads as a distinct
          category from the per-type toggles. */}
      <div className="notif-settings-section notif-settings-master">
        <div className="notif-settings-row">
          <div className="notif-settings-text">
            <div className="notif-settings-label">Show notifications</div>
            <div className="notif-settings-desc">
              When off, the bell icon disappears entirely and no notifications
              are computed for you. Your existing per-type preferences are kept.
            </div>
          </div>
          <Switch
            checked={master}
            disabled={saving}
            onChange={onMasterChange}
            checkedChildren="On"
            unCheckedChildren="Off"
          />
        </div>
      </div>

      {/* Per-detector toggles, grouped by section. The whole block is
          dimmed when master is off so the operator sees their per-type
          state preserved but understands nothing is firing. */}
      <div className={`notif-types ${master ? '' : 'notif-settings-disabled'}`}>
        {['today', 'risk', 'system'].map((sec) => {
          const list = grouped[sec] || [];
          if (!list.length) return null;
          const M = SECTION_META[sec];
          const SecIcon = M.icon;
          return (
            <div key={sec} className="notif-settings-section">
              <div className="notif-settings-section-title">
                <SecIcon style={{ marginRight: 6 }} />
                {M.label}
                <span style={{ marginLeft: 8, fontWeight: 400, letterSpacing: 0, textTransform: 'none', color: 'var(--fg-tertiary)' }}>
                  {M.hint}
                </span>
              </div>
              {list.map((t) => (
                <div key={t.type} className="notif-settings-row">
                  <div className="notif-settings-text">
                    <div className="notif-settings-label">{t.label}</div>
                    <div className="notif-settings-desc">{t.description}</div>
                  </div>
                  <Switch
                    checked={toggles[t.type] !== false}
                    disabled={saving || !master}
                    onChange={(next) => onTypeChange(t.type, next)}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
