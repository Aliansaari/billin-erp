import React, { useEffect, useState } from 'react';
import {
  Card, Switch, InputNumber, Button, Alert, Tag, Tooltip, Modal, Space, message, Typography,
} from 'antd';
import {
  CodeOutlined, LockOutlined, UnlockOutlined, ReloadOutlined,
  ExclamationCircleOutlined, ToolOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { settingsAPI, companyAPI } from '../../api';
import { refreshSystemSettings } from '../../hooks/useSystemSettings';
import { refreshFinancialYear } from '../../hooks/useFinancialYear';
import useDevModeStore from '../../store/devModeStore';

const { Title, Text, Paragraph } = Typography;

/* ── DeveloperSettings ──────────────────────────────────────────────────
 *
 * Visible only when developer mode is unlocked. Lets the developer choose
 * which power-tools normal users see in the sidebar. Each toggle persists
 * in system_settings so every machine on the LAN picks up the change
 * automatically — no per-PC reconfiguration.
 *
 * Three sections:
 *
 *   Feature visibility   — toggles for Ledger Integrity, Data Cleanup,
 *                          Backup Restore, Tally Sync, Import/Export,
 *                          Server Settings.
 *
 *   LAN deployment       — master on/off for accepting LAN clients,
 *                          plus a max-clients cap (0 = unlimited).
 *
 *   Session              — lock developer mode (forgets the unlock on
 *                          this device) and current activation info.
 * ────────────────────────────────────────────────────────────────────── */

const FEATURE_TOGGLES = [
  {
    key: 'dev_show_ledger_integrity',
    title: 'Ledger Integrity',
    description: 'Database-level integrity scan. Heavy queries — usually a power-user diagnostic.',
    risk: 'medium',
    defaultOn: false,
  },
  {
    key: 'dev_show_data_cleanup',
    title: 'Data Cleanup / Wipe',
    description: 'Bulk-delete bills / parties / products by category. Destructive; one wrong click empties tables.',
    risk: 'high',
    defaultOn: false,
  },
  {
    key: 'dev_show_backup_restore',
    title: 'Restore from Backup',
    description: 'Replaces every table with the contents of a chosen backup file. Backup CREATION stays visible regardless.',
    risk: 'high',
    defaultOn: false,
  },
  {
    key: 'dev_show_tally_sync',
    title: 'Tally Live Sync',
    description: 'Pushes / pulls vouchers to a live Tally instance. XML export/import stays visible — only the live HTTP path is gated.',
    risk: 'medium',
    defaultOn: false,
  },
  {
    key: 'dev_show_import_export',
    title: 'Import / Export (Excel)',
    description: 'Bulk Excel import for masters and transactions. Most shops use this every closing day.',
    risk: 'low',
    defaultOn: true,
  },
  {
    key: 'dev_show_server_settings',
    title: 'Server / Network Setup',
    description: 'Lets a user re-point the app at a different LAN host. Off by default — once configured, regular staff shouldn\'t change it.',
    risk: 'medium',
    defaultOn: false,
  },
];

export default function DeveloperSettings() {
  const navigate = useNavigate();
  const unlocked    = useDevModeStore((s) => s.unlocked);
  const unlockedAt  = useDevModeStore((s) => s.unlockedAt);
  const lockDevMode = useDevModeStore((s) => s.lock);
  const previewAsUser       = useDevModeStore((s) => s.previewAsUser);
  const togglePreviewAsUser = useDevModeStore((s) => s.togglePreviewAsUser);

  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(null); // currently-saving toggle key
  // dev_max_companies lives in master_settings (separate DB) so we
  // fetch + write it via the dedicated endpoint, not via the per-
  // company system_settings flow used by every other toggle on this
  // page. Tracked separately to keep the save state clear.
  const [maxCompanies, setMaxCompanies] = useState(3);
  const [savingMaxCompanies, setSavingMaxCompanies] = useState(false);

  useEffect(() => {
    if (!unlocked) {
      // Should never reach here via the menu (it only renders for unlocked
      // dev mode), but a direct URL hit lands without auth — bounce home.
      navigate('/');
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await settingsAPI.getSystem();
      setSettings(r.data?.data || r.data || {});
      // dev_max_companies in master DB — best-effort; if the master DB
      // hasn't been bootstrapped yet, the endpoint 404s and we fall
      // back to the default (3).
      try {
        const cap = await companyAPI.getMaxCap();
        const v = cap.data?.data?.dev_max_companies;
        if (Number.isFinite(Number(v))) setMaxCompanies(Number(v));
      } catch { /* master DB not ready yet — keep default */ }
    } catch (e) {
      message.error('Could not load developer settings');
    } finally {
      setLoading(false);
    }
  };

  const updateMaxCompanies = async (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return;
    setSavingMaxCompanies(true);
    try {
      await companyAPI.setMaxCap(n);
      setMaxCompanies(n);
      message.success('Saved');
    } catch (e) {
      message.error('Save failed');
    } finally {
      setSavingMaxCompanies(false);
    }
  };

  const updateFlag = async (key, value) => {
    setSaving(key);
    try {
      await settingsAPI.updateSystem({ ...settings, [key]: value });
      setSettings((s) => ({ ...s, [key]: value }));
      // Bust the in-memory cache so other open pages pick up the change
      // immediately (sidebar visibility flips, etc.).
      await refreshSystemSettings();
      message.success('Saved');
    } catch (e) {
      message.error('Save failed');
    } finally {
      setSaving(null);
    }
  };

  // ── Compliance mode toggle (dev-only) ──────────────────────────────
  // The master switch for the audit-trail feature. Moved out of the
  // regular FY Settings page in PR-DEV so an operator / accountant
  // can't silently disable the audit trail to cover a problem.
  // Turning OFF when locks are set is destructive (vouchers can now
  // freely backdate); always confirm.
  const toggleComplianceMode = (next) => {
    const hasConfig = !!(settings?.fy_soft_lock_date || settings?.fy_hard_lock_date);
    if (!next && hasConfig) {
      Modal.confirm({
        title: 'Disable compliance mode?',
        icon: <ExclamationCircleOutlined style={{ color: '#dc2626' }} />,
        content: (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            Compliance mode is currently <strong>ON</strong> with active lock dates.
            Disabling it will:
            <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
              <li>Stop firing the lock check on every voucher save / edit / cancel</li>
              <li>Let users post and backdate freely with no override prompt</li>
              <li>Keep the existing audit-log rows (they're append-only) but no new ones will be written from voucher writes</li>
            </ul>
            <div style={{ marginTop: 10, color: '#dc2626' }}>
              The lock-date and password settings are preserved — re-enabling restores them as-is.
            </div>
          </div>
        ),
        okText: 'Disable',
        okButtonProps: { danger: true },
        onOk: () => doToggleCompliance(next),
      });
      return;
    }
    doToggleCompliance(next);
  };

  const doToggleCompliance = async (next) => {
    setSaving('fy_compliance_mode');
    try {
      await settingsAPI.updateSystem({ ...settings, fy_compliance_mode: !!next });
      setSettings((s) => ({ ...s, fy_compliance_mode: !!next }));
      // Two caches to bust: the system-settings cache (so this page +
      // sidebar pick up the new state) and the FY-compliance store (so
      // every voucher form's useFiscalLock hook sees the new master
      // value immediately without a reload).
      await refreshSystemSettings();
      await refreshFinancialYear();
      message.success(next ? 'Compliance mode enabled' : 'Compliance mode disabled');
    } catch (e) {
      message.error('Save failed');
    } finally {
      setSaving(null);
    }
  };

  const handleLock = () => {
    Modal.confirm({
      title: 'Lock developer mode?',
      icon: <LockOutlined />,
      content: 'This will hide the Developer Settings page on this device until the password is entered again. Toggles already saved stay in effect — unlocking just restores access to change them.',
      okText: 'Lock',
      okButtonProps: { danger: true },
      onOk: () => {
        lockDevMode();
        message.success('Developer mode locked');
        navigate('/');
      },
    });
  };

  if (!unlocked) return null;

  const fmtTime = (ms) => {
    if (!ms) return null;
    try { return new Date(ms).toLocaleString(); }
    catch { return null; }
  };

  return (
    <div style={{ padding: 24, maxWidth: 920, margin: '0 auto' }}>
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <CodeOutlined style={{ fontSize: 26, color: '#9333ea' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Title level={2} style={{ margin: 0, lineHeight: 1.1 }}>Developer Settings</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            Per-deployment power-tool gating. Changes apply to every machine on the LAN.
          </Text>
        </div>
        <Button onClick={load} icon={<ReloadOutlined />} loading={loading}>Reload</Button>
        <Button onClick={handleLock} icon={<LockOutlined />} danger>Lock dev mode</Button>
      </div>

      <Alert
        type="success"
        showIcon
        icon={<UnlockOutlined />}
        message={<span>Developer mode is unlocked on this device{unlockedAt && <span style={{ color: '#475569' }}> · since {fmtTime(unlockedAt)}</span>}</span>}
        description="Power-tools and the Developer Settings page are visible to YOU. Other machines on the LAN see only the features you've toggled on below."
        style={{ marginBottom: 16 }}
      />

      {/* ── Preview as regular user ─────────────────────────────────── */}
      <Card
        style={{
          marginBottom: 20,
          borderRadius: 12,
          border: previewAsUser ? '1px solid #f59e0b' : '1px solid #e5e7eb',
          background: previewAsUser ? 'rgba(245, 158, 11, 0.06)' : '#fff',
        }}
        styles={{ body: { padding: 16 } }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ fontSize: 26 }}>{previewAsUser ? '👁' : '👨‍💻'}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 2 }}>
              Preview as regular user
              {previewAsUser && (
                <Tag color="orange" style={{ marginLeft: 8 }}>Active</Tag>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.5 }}>
              {previewAsUser
                ? 'Your sidebar and menus currently show ONLY what a regular user sees. Toggle off to return to full developer view.'
                : 'Developer mode normally shows you every feature regardless of the toggles below. Turn this on to verify what your staff actually see — gated features will hide for you too. A page reload always returns to full developer view.'}
            </div>
          </div>
          <Switch
            checked={previewAsUser}
            onChange={togglePreviewAsUser}
          />
        </div>
      </Card>

      {/* ── Feature visibility ─────────────────────────────────────── */}
      <Card
        title={<span><ToolOutlined /> Feature visibility for non-developer users</span>}
        style={{ marginBottom: 20, borderRadius: 12 }}
        styles={{ header: { fontWeight: 600 } }}
      >
        <Paragraph style={{ marginBottom: 18, color: '#64748b', fontSize: 13 }}>
          Each toggle decides whether normal users see the feature in the sidebar / settings menu.
          Developer mode always sees everything regardless.
        </Paragraph>
        {FEATURE_TOGGLES.map((t) => (
          <FeatureToggleRow
            key={t.key}
            toggle={t}
            value={!!settings?.[t.key]}
            saving={saving === t.key}
            onChange={(v) => updateFlag(t.key, v)}
          />
        ))}
      </Card>

      {/* ── Compliance & audit ─────────────────────────────────────── */}
      <Card
        title={<span><SafetyCertificateOutlined style={{ color: '#059669' }} /> Compliance &amp; audit</span>}
        style={{ marginBottom: 20, borderRadius: 12 }}
        styles={{ header: { fontWeight: 600 } }}
      >
        <Paragraph style={{ marginBottom: 14, color: '#64748b', fontSize: 13 }}>
          Master switch for the audit-trail feature. When ON, every voucher save / edit /
          cancel goes through the fiscal-lock check; backdated writes need a logged override.
          This toggle lives in dev mode so a regular operator cannot silently disable
          the audit trail to cover a problem.
        </Paragraph>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '12px 0', borderTop: '1px solid #f1f5f9' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
              Compliance mode
              <Tag color={settings?.fy_compliance_mode ? 'green' : 'default'} style={{ marginLeft: 0 }}>
                {settings?.fy_compliance_mode ? 'ON' : 'OFF'}
              </Tag>
              {settings?.fy_compliance_mode && (settings?.fy_soft_lock_date || settings?.fy_hard_lock_date) && (
                <Tag color="gold">locks configured</Tag>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.55 }}>
              {settings?.fy_compliance_mode
                ? <>Active. Lock dates and the override-password requirement are configured on <a onClick={() => navigate('/settings/financial-year')} style={{ cursor: 'pointer' }}>Settings → Financial Year</a>.</>
                : <>Simple mode. No locks, no override prompts, no new audit-log entries from voucher writes. Lock-date and password settings (if any were saved earlier) are preserved.</>}
            </div>
          </div>
          <Switch
            checked={!!settings?.fy_compliance_mode}
            loading={saving === 'fy_compliance_mode'}
            onChange={toggleComplianceMode}
          />
        </div>
      </Card>

      {/* ── LAN deployment ─────────────────────────────────────────── */}
      <Card
        title={<span>LAN deployment</span>}
        style={{ marginBottom: 20, borderRadius: 12 }}
        styles={{ header: { fontWeight: 600 } }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Accept LAN clients</div>
            <div style={{ fontSize: 12.5, color: '#64748b' }}>
              When OFF, the server still runs but rejects every non-loopback connection. Use this if you suspect a security issue or want to lock down to localhost only for a maintenance window.
            </div>
          </div>
          <Switch
            checked={!!settings?.dev_lan_enabled}
            loading={saving === 'dev_lan_enabled'}
            onChange={(v) => updateFlag('dev_lan_enabled', v)}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '14px 0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Maximum concurrent clients</div>
            <div style={{ fontSize: 12.5, color: '#64748b' }}>
              Cap on how many distinct logged-in machines can hit the server at once. <code>0 = unlimited</code> (default).
              Useful for license-style enforcement: set to 5 to make the 6th machine wait until one of the first five goes idle for 10 minutes.
            </div>
          </div>
          <InputNumber
            min={0}
            max={500}
            step={1}
            value={settings?.dev_lan_max_clients ?? 0}
            disabled={saving === 'dev_lan_max_clients'}
            onChange={(v) => updateFlag('dev_lan_max_clients', Number(v) || 0)}
            style={{ width: 120 }}
            addonAfter="PCs"
          />
        </div>
      </Card>

      {/* ── Multi-company ──────────────────────────────────────────── */}
      <Card
        title={<span>Multi-company</span>}
        style={{ marginBottom: 20, borderRadius: 12 }}
        styles={{ header: { fontWeight: 600 } }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '10px 0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>
              Maximum companies per customer
            </div>
            <div style={{ fontSize: 12.5, color: '#64748b' }}>
              How many separate company books a customer can create on this server.
              <code> 0 = unlimited</code>. Default 3 covers a main business + sister concern + holding entity.
              The Manage Companies page disables the New Company button when this cap is reached.
            </div>
          </div>
          <InputNumber
            min={0}
            max={50}
            step={1}
            value={maxCompanies}
            disabled={savingMaxCompanies}
            onChange={updateMaxCompanies}
            style={{ width: 120 }}
            addonAfter="books"
          />
        </div>
      </Card>

      <Card
        title="What developer-mode unlocks for YOU"
        style={{ marginBottom: 20, borderRadius: 12 }}
        styles={{ header: { fontWeight: 600 } }}
      >
        <ul style={{ paddingLeft: 18, margin: 0, color: '#475569', fontSize: 13.5, lineHeight: 1.8 }}>
          <li>This page (Developer Settings) — toggles above</li>
          <li>Server Setup screen at <code>/server-setup</code></li>
          <li>Every gated feature in the list above (regardless of toggle state)</li>
          <li>The "Lock dev mode" button in the top-right</li>
        </ul>
        <Paragraph style={{ marginTop: 12, marginBottom: 0, color: '#64748b', fontSize: 12.5 }}>
          The unlock is per-device. Locking forgets it on this PC; the password unlocks any machine.
        </Paragraph>
      </Card>
    </div>
  );
}

/* ── Helper ── */
function FeatureToggleRow({ toggle, value, saving, onChange }) {
  const riskColor = { low: 'green', medium: 'gold', high: 'red' }[toggle.risk] || 'default';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '12px 0', borderTop: '1px solid #f1f5f9' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          {toggle.title}
          <Tag color={riskColor} style={{ marginLeft: 0, textTransform: 'capitalize' }}>{toggle.risk} risk</Tag>
          {toggle.defaultOn && <Tag color="default">default ON</Tag>}
        </div>
        <div style={{ fontSize: 12.5, color: '#64748b' }}>{toggle.description}</div>
      </div>
      <Tooltip title={value ? 'Visible to all users' : 'Hidden — only developer mode sees it'}>
        <Switch checked={value} loading={saving} onChange={onChange} />
      </Tooltip>
    </div>
  );
}
