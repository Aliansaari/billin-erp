import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Form, Input, Modal, Pagination, Select, Spin, Switch, Tag, message } from 'antd';
import {
  CalendarOutlined, SafetyOutlined, LockOutlined,
  HistoryOutlined, RightOutlined, DownloadOutlined, FilterOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { settingsAPI, complianceAPI } from '../../api';
import { refreshFinancialYear, fyLabel } from '../../hooks/useFinancialYear';
import './financial-year-settings.css';

// CSV export helper — escapes a single field for RFC-4180 output. We
// quote any field that contains comma/quote/newline so the file opens
// cleanly in Excel/Numbers/Google Sheets without spilling cells.
function csvField(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const EVENT_TYPE_OPTIONS = [
  { value: '',                      label: 'All event types' },
  { value: 'compliance_toggled',    label: 'Compliance mode toggled' },
  { value: 'soft_lock_set',         label: 'Soft lock changed' },
  { value: 'hard_lock_set',         label: 'Hard lock changed' },
  { value: 'require_password_set',  label: 'Override password requirement' },
  { value: 'soft_override',         label: 'Soft override (backdated save)' },
  { value: 'hard_override',         label: 'Hard override (post-ITR break)' },
  { value: 'post_close_edit',       label: 'Edit / cancel of a closed-period voucher' },
];

/* ──────────────────────────────────────────────────────────────────────────
 * Settings → Financial Year
 *
 * Two-section page:
 *
 * 1. FY Overview (always visible)
 *    · Current FY label + dates + day-of-FY counter
 *    · Voucher numbering note (per-FY reset is on by convention)
 *    · "Edit FY dates" link → /settings/company (FY config lives there)
 *
 * 2. Compliance (state shown read-only here; master toggle lives in
 *    Developer Settings → Compliance & audit so an operator can't
 *    silently disable the audit trail).
 *    · When compliance is ON:
 *       - Soft lock date input (backdating before requires override)
 *       - Hard lock date input (Super Admin only beyond)
 *       - "Require password on override" toggle
 *       - "View audit log →" link → paginated viewer + CSV export
 *    · When OFF, the section shows a brief info note pointing the
 *      user to Developer Settings if they want to turn it on.
 *
 * Default UX (compliance OFF, the simple Tally-style mode):
 *    · FY routing automatic by bill date
 *    · Past-FY context switch via the workspace pill (yellow banner)
 *    · No locks, no override prompts, no audit log
 * ────────────────────────────────────────────────────────────────────── */

export default function FinancialYearSettings() {
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [sys,     setSys]     = useState(null);

  // Audit-log viewer — paginated, filterable, exportable. Enterprise
  // deployments accumulate thousands of rows over a fiscal year; the
  // viewer paginates server-side (page_size=50) and exposes the same
  // filter axes the server's /audit-log endpoint accepts.
  const [auditOpen,    setAuditOpen]    = useState(false);
  const [auditRows,    setAuditRows]    = useState([]);
  const [auditTotal,   setAuditTotal]   = useState(0);
  const [auditPage,    setAuditPage]    = useState(1);
  const [auditPageSize, setAuditPageSize] = useState(50);
  const [auditLoading, setAuditLoading] = useState(false);
  const [filterType,   setFilterType]   = useState('');
  const [filterFrom,   setFilterFrom]   = useState(null);
  const [filterTo,     setFilterTo]     = useState(null);
  const [filterHardOnly, setFilterHardOnly] = useState(false);

  const auditQuery = useMemo(() => {
    const q = { page: auditPage, page_size: auditPageSize };
    if (filterType)     q.event_type = filterType;
    if (filterFrom)     q.from_date  = filterFrom.format('YYYY-MM-DD');
    if (filterTo)       q.to_date    = filterTo.format('YYYY-MM-DD');
    if (filterHardOnly) q.hard_only  = '1';
    return q;
  }, [auditPage, auditPageSize, filterType, filterFrom, filterTo, filterHardOnly]);

  useEffect(() => {
    if (!auditOpen) return;
    let cancelled = false;
    setAuditLoading(true);
    complianceAPI.auditLog(auditQuery)
      .then(({ data }) => {
        if (cancelled) return;
        setAuditRows(data?.data || []);
        setAuditTotal(data?.total || 0);
      })
      .catch(() => { if (!cancelled) message.error('Failed to load audit log'); })
      .finally(() => { if (!cancelled) setAuditLoading(false); });
    return () => { cancelled = true; };
  }, [auditOpen, auditQuery]);

  // CSV export — pulls EVERY row matching the current filters (server
  // caps page_size at 200, so chunk through pages). Generates an
  // RFC-4180 file and triggers a download — CA-friendly handoff.
  const [exporting, setExporting] = useState(false);
  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const PAGE_SIZE = 200;
      const all = [];
      let page = 1;
      let totalPages = 1;
      do {
        const { data } = await complianceAPI.auditLog({ ...auditQuery, page, page_size: PAGE_SIZE });
        all.push(...(data?.data || []));
        totalPages = data?.total_pages || 1;
        page += 1;
      } while (page <= totalPages);

      const header = [
        'audit_log_id', 'event_at', 'event_type', 'is_hard_override',
        'user_id', 'user_name', 'user_role',
        'target_type', 'target_id', 'target_label', 'target_date',
        'reason', 'from_value', 'to_value', 'metadata',
      ];
      const lines = [header.join(',')];
      for (const r of all) {
        lines.push([
          r.audit_log_id, r.event_at, r.event_type, r.is_hard_override ? 'true' : 'false',
          r.user_id || '', r.user_name || '', r.user_role || '',
          r.target_type || '', r.target_id || '', r.target_label || '', r.target_date || '',
          r.reason || '', r.from_value ? JSON.stringify(r.from_value) : '',
          r.to_value ? JSON.stringify(r.to_value) : '',
          r.metadata ? JSON.stringify(r.metadata) : '',
        ].map(csvField).join(','));
      }

      const csv = lines.join('\r\n');
      const stamp = dayjs().format('YYYYMMDD-HHmm');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `compliance-audit-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      message.success(`Exported ${all.length} row${all.length === 1 ? '' : 's'}.`);
    } catch (e) {
      message.error('Failed to export audit log');
    } finally {
      setExporting(false);
    }
  }, [auditQuery]);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setAuditPage(1); }, [filterType, filterFrom, filterTo, filterHardOnly]);

  // Compliance master switch is READ-ONLY here — the toggle lives in
  // Developer Settings so an operator / accountant can't accidentally
  // (or deliberately) disable the audit trail to clean up a problem.
  // We display the current state and surface the lock dates / password
  // controls only when compliance is already ON.
  const complianceMode = !!sys?.fy_compliance_mode;
  const [softLockDate,   setSoftLockDate]     = useState(null);
  const [hardLockDate,   setHardLockDate]     = useState(null);
  const [requireOvridPw, setRequireOvridPw]   = useState(false);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await settingsAPI.getSystem();
        const s = data?.data || data || {};
        if (cancelled) return;
        setSys(s);
        setSoftLockDate(s.fy_soft_lock_date ? dayjs(s.fy_soft_lock_date) : null);
        setHardLockDate(s.fy_hard_lock_date ? dayjs(s.fy_hard_lock_date) : null);
        setRequireOvridPw(!!s.fy_require_override_password);
      } catch {
        if (!cancelled) message.error('Failed to load financial-year settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Do NOT send fy_compliance_mode — that flip lives in Developer
      // Settings only. The server already has the current value; we
      // leave it untouched so this page can never invert the master
      // switch even by accident.
      const payload = {
        fy_soft_lock_date:            softLockDate ? softLockDate.format('YYYY-MM-DD') : null,
        fy_hard_lock_date:            hardLockDate ? hardLockDate.format('YYYY-MM-DD') : null,
        fy_require_override_password: !!requireOvridPw,
      };
      await settingsAPI.updateSystem(payload);
      // Refresh the FY/compliance store so other components pick up the
      // new state without a page reload.
      await refreshFinancialYear();
      message.success('Financial-year settings saved');
    } catch (e) {
      message.error(e?.response?.data?.error || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>;

  // ── Derived helpers for the overview card ────────────────────────────
  const fyStart = sys?.financial_year_start ? dayjs(sys.financial_year_start) : null;
  const fyEnd   = sys?.financial_year_end   ? dayjs(sys.financial_year_end)   : null;
  const today   = dayjs();
  const dayOfFY = fyStart ? today.diff(fyStart, 'day') + 1 : null;
  const totalDays = fyStart && fyEnd ? fyEnd.diff(fyStart, 'day') + 1 : null;
  const daysRemaining = fyEnd ? Math.max(0, fyEnd.diff(today, 'day')) : null;
  const pctElapsed = (dayOfFY && totalDays) ? Math.min(100, Math.max(0, (dayOfFY / totalDays) * 100)) : 0;

  return (
    <div className="fyset-page">
      <header className="fyset-header">
        <div>
          <div className="fyset-eyebrow">Settings · Financial Year</div>
          <h1 className="fyset-title">Financial year &amp; compliance</h1>
          <p className="fyset-sub">
            Manage the current FY's boundaries, and (optionally) enable the
            compliance features that lock past periods after audit.
          </p>
        </div>
      </header>

      {/* ── Overview ──────────────────────────────────────────────────── */}
      <section className="fyset-card">
        <div className="fyset-card-head">
          <CalendarOutlined className="fyset-card-icon" />
          <div>
            <div className="fyset-card-title">Current financial year</div>
            <div className="fyset-card-sub">FY config lives on Company Profile — edit there to change boundaries</div>
          </div>
        </div>

        <div className="fyset-overview">
          <div className="fyset-overview-stat">
            <div className="fyset-overview-label">FY</div>
            <div className="fyset-overview-value num">{fyStart ? fyLabel({ start: fyStart.format('YYYY-MM-DD') }) : '—'}</div>
            <div className="fyset-overview-meta">
              {fyStart?.format('DD MMM YYYY')} &nbsp;→&nbsp; {fyEnd?.format('DD MMM YYYY')}
            </div>
          </div>
          <div className="fyset-overview-stat">
            <div className="fyset-overview-label">Day of FY</div>
            <div className="fyset-overview-value num">{dayOfFY || '—'}</div>
            <div className="fyset-overview-meta">of {totalDays || '—'} days</div>
          </div>
          <div className="fyset-overview-stat">
            <div className="fyset-overview-label">Days remaining</div>
            <div className="fyset-overview-value num">{daysRemaining ?? '—'}</div>
            <div className="fyset-overview-meta">
              {daysRemaining === 0 ? 'FY has ended' : daysRemaining < 30 ? 'Year-end approaching' : ''}
            </div>
          </div>
        </div>

        {/* Progress bar — how far through the FY we are. */}
        <div className="fyset-progress">
          <div className="fyset-progress-track">
            <div className="fyset-progress-fill" style={{ width: `${pctElapsed}%` }} />
          </div>
          <div className="fyset-progress-meta">{Math.round(pctElapsed)}% elapsed</div>
        </div>

        <div className="fyset-card-foot">
          <a href="/settings/company" className="fyset-link">
            Edit FY dates on Company Profile <RightOutlined />
          </a>
        </div>
      </section>

      {/* ── Compliance ────────────────────────────────────────────────── */}
      <section className="fyset-card">
        <div className="fyset-card-head fyset-card-head-row">
          <div className="fyset-card-head-text">
            <SafetyOutlined className="fyset-card-icon" />
            <div>
              <div className="fyset-card-title">
                Compliance mode
                <Tag
                  color={complianceMode ? 'green' : 'default'}
                  style={{ marginLeft: 10, verticalAlign: 'middle' }}
                >
                  {complianceMode ? 'ON' : 'OFF'}
                </Tag>
              </div>
              <div className="fyset-card-sub">
                {complianceMode
                  ? 'Audit features are active. Configure the lock dates and password requirement below.'
                  : 'No locks, no audit log — Tally-style. Enabling compliance is a developer-only action.'}
              </div>
            </div>
          </div>
        </div>

        {complianceMode ? (
          <Form layout="vertical" className="fyset-form">
            <div className="fyset-form-row">
              <Form.Item
                label={<span><LockOutlined /> Soft-lock date</span>}
                help="Transactions on or before this date require an override reason (logged). Recommended after CA submits audit working."
              >
                <DatePicker
                  value={softLockDate}
                  onChange={setSoftLockDate}
                  format="DD MMM YYYY"
                  style={{ width: '100%' }}
                  allowClear
                  placeholder="No soft lock"
                />
              </Form.Item>

              <Form.Item
                label={<span><LockOutlined /> Hard-lock date</span>}
                help="Transactions on or before this date are blocked for every role except Super Admin. Use after ITR filing."
              >
                <DatePicker
                  value={hardLockDate}
                  onChange={setHardLockDate}
                  format="DD MMM YYYY"
                  style={{ width: '100%' }}
                  allowClear
                  placeholder="No hard lock"
                />
              </Form.Item>
            </div>

            <Form.Item className="fyset-form-row-pw">
              <div className="fyset-pw-row">
                <div>
                  <div className="fyset-pw-label">Require password on override</div>
                  <div className="fyset-pw-sub">
                    On top of the role check, prompt for the user's password every time
                    they override a soft lock. Recommended for stricter shops.
                  </div>
                </div>
                <Switch checked={requireOvridPw} onChange={setRequireOvridPw} />
              </div>
            </Form.Item>

            <div className="fyset-form-foot">
              <button
                type="button"
                className="fyset-link fyset-link-muted fyset-link-btn"
                onClick={() => setAuditOpen(true)}
              >
                <HistoryOutlined /> View audit log
              </button>
            </div>
          </Form>
        ) : (
          <div className="fyset-simple-info">
            <strong>Simple mode is active.</strong> Bills route automatically to the FY their
            date falls in. Use the FY pill in the top-bar / sidebar to switch context and view
            or edit past FYs.
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--fg-tertiary)' }}>
              To turn on lock dates, the override workflow, and the audit log, a developer must
              enable <strong>Compliance mode</strong> in <em>Developer Settings → Compliance &amp; audit</em>.
              This guard exists so an operator can't silently disable the audit trail.
            </div>
          </div>
        )}

        {complianceMode && (
          <div className="fyset-card-actions">
            <Button type="primary" onClick={handleSave} loading={saving}>
              Save changes
            </Button>
          </div>
        )}
      </section>

      {/* ── Audit log viewer ─────────────────────────────────────────── */}
      <Modal
        open={auditOpen}
        onCancel={() => setAuditOpen(false)}
        footer={null}
        width={920}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <HistoryOutlined style={{ color: 'var(--accent)' }} />
            Compliance audit log
            <span style={{ fontSize: 11, color: 'var(--fg-tertiary)', fontWeight: 400, letterSpacing: '0.05em' }}>
              · {auditTotal} event{auditTotal === 1 ? '' : 's'} · most recent first
            </span>
          </span>
        }
      >
        {/* Filter row — server-driven; changes reset to page 1 via the
            useEffect on filter state. */}
        <div className="fyset-audit-filters">
          <Select
            value={filterType}
            onChange={setFilterType}
            options={EVENT_TYPE_OPTIONS}
            style={{ minWidth: 220 }}
            size="small"
            suffixIcon={<FilterOutlined />}
          />
          <DatePicker
            value={filterFrom}
            onChange={setFilterFrom}
            placeholder="From"
            format="DD MMM YYYY"
            size="small"
            allowClear
          />
          <DatePicker
            value={filterTo}
            onChange={setFilterTo}
            placeholder="To"
            format="DD MMM YYYY"
            size="small"
            allowClear
          />
          <label className="fyset-audit-hard-only">
            <input type="checkbox" checked={filterHardOnly} onChange={(e) => setFilterHardOnly(e.target.checked)} />
            <span>Hard overrides only</span>
          </label>
          <div style={{ flex: 1 }} />
          <Button
            icon={<DownloadOutlined />}
            size="small"
            onClick={handleExportCsv}
            loading={exporting}
            disabled={auditTotal === 0}
          >
            Export CSV
          </Button>
        </div>

        {auditLoading ? (
          <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
        ) : auditRows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--fg-tertiary)' }}>
            <strong style={{ color: 'var(--fg-secondary)' }}>
              {auditTotal === 0 ? 'No audit events yet.' : 'No events match the current filters.'}
            </strong><br/>
            <span style={{ fontSize: 12.5 }}>
              {auditTotal === 0
                ? 'Compliance toggles and lock-date changes will appear here as they happen. So will every soft / hard override on a backdated voucher.'
                : 'Clear filters above to see all events.'}
            </span>
          </div>
        ) : (
          <>
            <div className="fyset-audit-list">
              {auditRows.map((r) => (
                <div key={r.audit_log_id} className={`fyset-audit-row ${r.is_hard_override ? 'is-hard' : ''}`}>
                  <div className="fyset-audit-meta">
                    <span className="fyset-audit-when">{dayjs(r.event_at).format('DD MMM YYYY · HH:mm')}</span>
                    <Tag color={
                      r.event_type === 'hard_override'      ? 'red'    :
                      r.event_type === 'soft_override'      ? 'orange' :
                      r.event_type === 'post_close_edit'    ? 'gold'   :
                      r.event_type === 'compliance_toggled' ? 'blue'   :
                      'default'
                    }>{r.event_type}</Tag>
                  </div>
                  <div className="fyset-audit-text">
                    <div className="fyset-audit-label">{r.target_label || '(no label)'}</div>
                    {r.reason && (
                      <div className="fyset-audit-reason">"{r.reason}"</div>
                    )}
                    <div className="fyset-audit-by">
                      by {r.user_name || 'system'}{r.user_role ? ` · ${r.user_role}` : ''}
                      {r.target_date && <> · for {dayjs(r.target_date).format('DD MMM YYYY')}</>}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {auditTotal > auditPageSize && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}>
                <Pagination
                  current={auditPage}
                  pageSize={auditPageSize}
                  total={auditTotal}
                  showSizeChanger
                  pageSizeOptions={[20, 50, 100, 200]}
                  onChange={(p, ps) => { setAuditPage(p); setAuditPageSize(ps); }}
                  size="small"
                />
              </div>
            )}
          </>
        )}
      </Modal>

    </div>
  );
}
