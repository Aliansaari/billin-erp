import React, { useEffect, useState } from 'react';
import { Button, DatePicker, Form, Modal, Spin, Switch, message } from 'antd';
import {
  CalendarOutlined, SafetyOutlined, LockOutlined,
  HistoryOutlined, RightOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { settingsAPI } from '../../api';
import { refreshFinancialYear, fyLabel } from '../../hooks/useFinancialYear';
import './financial-year-settings.css';

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
 * 2. Compliance (toggle-gated)
 *    · Master toggle: "Compliance mode" (default: off)
 *    · When ON:
 *       - Soft lock date input (backdating before requires override)
 *       - Hard lock date input (Super Admin only beyond)
 *       - "Require password on override" toggle
 *       - Stage 2: "View audit log →" link
 *    · First-time toggle ON pops a wizard (per decision #6 Option C):
 *      "You're enabling compliance. Set a soft-lock date, or skip for now."
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

  // Wizard state — opens when the user flips compliance ON for the first
  // time, never been closed before. Stored intent is "show once, dismissable".
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSoft, setWizardSoft] = useState(null);

  // Local form state — mirrors the persisted settings until saved.
  const [complianceMode, setComplianceMode]   = useState(false);
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
        setComplianceMode(!!s.fy_compliance_mode);
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

  // Toggle handler — flipping ON for the first time opens the wizard;
  // the actual save happens when the wizard finishes or the operator
  // hits "Save changes" at the bottom. Flipping OFF saves immediately
  // because there's no setup needed.
  const handleComplianceToggle = (next) => {
    if (next && !complianceMode && !softLockDate && !hardLockDate) {
      // First-time enable AND no existing lock dates → walk them through.
      setWizardSoft(softLockDate);
      setWizardOpen(true);
    }
    setComplianceMode(next);
  };

  const handleWizardFinish = (mode) => {
    // mode: 'set' (use wizard's soft-lock date) or 'skip' (just toggle on)
    if (mode === 'set' && wizardSoft) {
      setSoftLockDate(wizardSoft);
    }
    setWizardOpen(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        fy_compliance_mode:           !!complianceMode,
        fy_soft_lock_date:            softLockDate ? softLockDate.format('YYYY-MM-DD') : null,
        fy_hard_lock_date:            hardLockDate ? hardLockDate.format('YYYY-MM-DD') : null,
        fy_require_override_password: !!requireOvridPw,
      };
      await settingsAPI.save(payload);
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
              <div className="fyset-card-title">Compliance mode</div>
              <div className="fyset-card-sub">
                Off by default. Turn on to enable lock dates, the override workflow, and the audit log.
              </div>
            </div>
          </div>
          <Switch
            checked={complianceMode}
            onChange={handleComplianceToggle}
            className="fyset-toggle"
          />
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
              <a href="#" className="fyset-link fyset-link-muted" onClick={(e) => {
                e.preventDefault();
                message.info('Audit log view ships in Stage 2 — coming next.');
              }}>
                <HistoryOutlined /> View audit log
                <span className="fyset-soon">soon</span>
              </a>
            </div>
          </Form>
        ) : (
          <div className="fyset-simple-info">
            <strong>Simple mode is active.</strong> Bills route automatically to the FY their date
            falls in. Use the FY pill in the top-bar / sidebar to switch context and view or edit
            past FYs. No locks, no audit log — Tally-style.
          </div>
        )}

        <div className="fyset-card-actions">
          <Button type="primary" onClick={handleSave} loading={saving}>
            Save changes
          </Button>
        </div>
      </section>

      {/* ── First-time enable wizard ─────────────────────────────────── */}
      <Modal
        open={wizardOpen}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <SafetyOutlined style={{ color: '#34D399' }} />
            Enabling compliance mode
          </span>
        }
        footer={null}
        onCancel={() => handleWizardFinish('skip')}
        width={500}
      >
        <p style={{ margin: '4px 0 16px', color: 'var(--fg-secondary)', fontSize: 13.5, lineHeight: 1.55 }}>
          Compliance mode adds <strong>lock dates</strong>, a <strong>role-based override workflow</strong>,
          and a <strong>full audit log</strong> on top of the simple FY behaviour. You can set a soft-lock
          date now (recommended once your audit working is in) or skip and configure later.
        </p>
        <div style={{ margin: '12px 0' }}>
          <label style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg-secondary)', marginBottom: 6, display: 'block' }}>
            Soft-lock date (optional)
          </label>
          <DatePicker
            value={wizardSoft}
            onChange={setWizardSoft}
            format="DD MMM YYYY"
            style={{ width: '100%' }}
            placeholder="e.g. 31 Mar — end of previous FY"
          />
          <div style={{ fontSize: 11.5, color: 'var(--fg-tertiary)', marginTop: 6 }}>
            Transactions on or before this date will require an override reason to edit.
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button onClick={() => handleWizardFinish('skip')}>Skip for now</Button>
          <Button type="primary" disabled={!wizardSoft} onClick={() => handleWizardFinish('set')}>
            Use this date
          </Button>
        </div>
      </Modal>
    </div>
  );
}
