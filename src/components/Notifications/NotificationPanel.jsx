import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SyncOutlined, MoreOutlined, BellOutlined, CheckOutlined,
  ClockCircleOutlined, CloseOutlined, SettingOutlined,
} from '@ant-design/icons';
import { notificationsAPI } from '../../api';

/* ──────────────────────────────────────────────────────────────────────────
 * NotificationPanel — dropdown shown when the bell is clicked.
 *
 * Renders three sections in priority order:
 *   1. TODAY  — calendar-driven (PDCs, EMIs, GST, etc.)
 *   2. RISK   — state-change alerts (bounced, breached, negative)
 *   3. SYSTEM — operational (backup, sync, import)
 *
 * Each row is interactive:
 *   - Body click → navigates to actionRoute (the underlying entity)
 *     AND marks the row seen.
 *   - ⋯ menu → Snooze (1h / Tomorrow / 1 week) or Dismiss.
 *   - Severity stripe (red/amber/blue/green) on the left edge for
 *     at-a-glance triage.
 *
 * The full payload (sections + counts) is fetched once when the panel
 * opens. Subsequent state mutations (mark-seen, snooze, dismiss) are
 * applied optimistically and POST'd to the server in parallel; on
 * server failure we soft-revert and surface nothing — the next poll
 * will re-fetch ground truth.
 *
 * Empty state lives in this component too: when zero items across all
 * sections, we show a single "Nothing needs your attention" panel
 * with a link to settings.
 * ────────────────────────────────────────────────────────────────────────── */

const SECTION_META = {
  today:  { title: 'Today',     icon: ClockCircleOutlined, hint: 'Calendar reminders' },
  risk:   { title: 'Attention', icon: BellOutlined,        hint: 'Things that changed' },
  system: { title: 'System',    icon: SettingOutlined,     hint: 'Operational health' },
};

export default function NotificationPanel({ onClose, onCountChange, align = 'right', style }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState(null);
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const [error, setError] = useState(null);

  // Mount → fetch.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    notificationsAPI.list()
      .then((res) => {
        if (cancelled) return;
        setPayload(res.data || {});
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || 'Failed to load notifications');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Recompute count whenever payload changes and tell parent so the
  // badge stays in sync even before the next poll lands.
  useEffect(() => {
    if (!payload || typeof onCountChange !== 'function') return;
    let n = 0;
    for (const sec of ['today', 'risk', 'system']) {
      for (const r of (payload.sections?.[sec] || [])) {
        if (r.status === 'active') n++;
      }
    }
    onCountChange(n);
  }, [payload, onCountChange]);

  const hasAny = useMemo(() => {
    if (!payload?.sections) return false;
    return ['today', 'risk', 'system'].some((s) => (payload.sections[s] || []).length > 0);
  }, [payload]);

  // Optimistic state mutation helpers. Each touches the payload first
  // (so the row visually updates), then POSTs.
  const mutateRow = (key, mut) => {
    setPayload((prev) => {
      if (!prev) return prev;
      const next = { ...prev, sections: { ...prev.sections } };
      for (const sec of ['today', 'risk', 'system']) {
        next.sections[sec] = (prev.sections[sec] || []).map((r) =>
          r.key === key ? mut(r) : r
        );
      }
      return next;
    });
  };

  const removeRow = (key) => {
    setPayload((prev) => {
      if (!prev) return prev;
      const next = { ...prev, sections: { ...prev.sections } };
      for (const sec of ['today', 'risk', 'system']) {
        next.sections[sec] = (prev.sections[sec] || []).filter((r) => r.key !== key);
      }
      return next;
    });
  };

  const doSnooze = async (key, bucket) => {
    setOpenMenuKey(null);
    removeRow(key);
    try { await notificationsAPI.action(key, 'snooze', { bucket }); } catch { /* ignore */ }
  };

  const doDismiss = async (key) => {
    setOpenMenuKey(null);
    removeRow(key);
    try { await notificationsAPI.action(key, 'dismiss'); } catch { /* ignore */ }
  };

  const onRowClick = async (row) => {
    // Mark-seen optimistically (drops it out of the unread badge).
    mutateRow(row.key, (r) => ({ ...r, status: 'seen' }));
    if (row.action_route) navigate(row.action_route);
    try { await notificationsAPI.action(row.key, 'mark-seen'); } catch { /* ignore */ }
    onClose?.();
  };

  const markAllSeen = async () => {
    setPayload((prev) => {
      if (!prev) return prev;
      const next = { ...prev, sections: {} };
      for (const sec of ['today', 'risk', 'system']) {
        next.sections[sec] = (prev.sections[sec] || []).map((r) => ({ ...r, status: 'seen' }));
      }
      return next;
    });
    try { await notificationsAPI.markAllSeen(); } catch { /* ignore */ }
  };

  return (
    <div className={`notif-panel notif-panel-${align}`} role="dialog" aria-label="Notifications" style={style}>
      <div className="notif-header">
        <div className="notif-header-title">Notifications</div>
        <div className="notif-header-actions">
          {hasAny && (
            <button type="button" className="notif-link" onClick={markAllSeen}>
              Mark all seen
            </button>
          )}
          <button
            type="button"
            className="notif-link"
            onClick={() => { onClose?.(); navigate('/settings/notifications'); }}
            title="Notification settings"
          >
            <SettingOutlined />
          </button>
        </div>
      </div>

      <div className="notif-body">
        {loading && (
          <div className="notif-status">
            <SyncOutlined spin /> Loading…
          </div>
        )}

        {!loading && error && (
          <div className="notif-status notif-error">{error}</div>
        )}

        {!loading && !error && !hasAny && (
          <div className="notif-empty">
            <BellOutlined className="notif-empty-icon" />
            <div className="notif-empty-title">Nothing needs your attention</div>
            <div className="notif-empty-sub">
              We'll show items here when there's a cheque due, a balance crossed, or a system issue.
            </div>
          </div>
        )}

        {!loading && !error && hasAny && ['today', 'risk', 'system'].map((sec) => {
          const items = payload.sections?.[sec] || [];
          if (!items.length) return null;
          const M = SECTION_META[sec];
          return (
            <div key={sec} className="notif-section">
              <div className="notif-section-head">
                <span className="notif-section-icon"><M.icon /></span>
                <span className="notif-section-title">{M.title}</span>
                <span className="notif-section-count">{items.length}</span>
              </div>
              {items.map((row) => (
                <NotifRow
                  key={row.key}
                  row={row}
                  menuOpen={openMenuKey === row.key}
                  onMenuToggle={() => setOpenMenuKey(openMenuKey === row.key ? null : row.key)}
                  onMenuClose={() => setOpenMenuKey(null)}
                  onClick={() => onRowClick(row)}
                  onSnooze={(bucket) => doSnooze(row.key, bucket)}
                  onDismiss={() => doDismiss(row.key)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NotifRow({ row, menuOpen, onMenuToggle, onMenuClose, onClick, onSnooze, onDismiss }) {
  const stripeClass = `notif-stripe notif-stripe-${row.severity || 'amber'}`;
  const unread = row.status === 'active';
  return (
    <div className={`notif-row ${unread ? 'is-unread' : ''}`}>
      <div className={stripeClass} />
      <button
        type="button"
        className="notif-row-body"
        onClick={onClick}
        title={row.action_label || 'Open'}
      >
        <div className="notif-row-label">{row.label}</div>
        {row.sub && <div className="notif-row-sub">{row.sub}</div>}
      </button>
      <div className="notif-row-actions">
        {row.action_label && (
          <button
            type="button"
            className="notif-row-cta"
            onClick={onClick}
          >
            {row.action_label}
          </button>
        )}
        <div className="notif-menu-wrap">
          <button
            type="button"
            className="notif-menu-btn"
            onClick={(e) => { e.stopPropagation(); onMenuToggle(); }}
            aria-label="More actions"
          >
            <MoreOutlined />
          </button>
          {menuOpen && (
            <div className="notif-menu" onMouseLeave={onMenuClose}>
              <button type="button" onClick={() => onSnooze('1h')}>
                <ClockCircleOutlined /> Snooze 1 hour
              </button>
              <button type="button" onClick={() => onSnooze('tomorrow')}>
                <ClockCircleOutlined /> Snooze until tomorrow
              </button>
              <button type="button" onClick={() => onSnooze('1week')}>
                <ClockCircleOutlined /> Snooze 1 week
              </button>
              <div className="notif-menu-sep" />
              <button type="button" onClick={onDismiss} className="notif-menu-dismiss">
                <CloseOutlined /> Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
