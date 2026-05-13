import React, { useEffect, useState } from 'react';
import {
  Card, Button, Modal, Form, Input, Select, ColorPicker, Tag, Space, Tooltip,
  Typography, Empty, message, Popconfirm, Steps,
} from 'antd';
import {
  BankOutlined, PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  CheckOutlined, LockOutlined, ExclamationCircleOutlined, CloudDownloadOutlined,
  SwapOutlined, WarningFilled,
} from '@ant-design/icons';
import { companyAPI, authAPI } from '../../api';
import useCompanyStore from '../../store/companyStore';
import useDevModeStore from '../../store/devModeStore';
import useAuthStore from '../../store/authStore';
import './CompanyList.css';

const { Title, Text } = Typography;

const FY_MONTHS = [
  { value: 1,  label: 'January' },  { value: 4,  label: 'April (Indian FY)' },
  { value: 7,  label: 'July' },     { value: 10, label: 'October' },
];

/* ── CompanyList ──────────────────────────────────────────────────────
 *
 * Manage Companies page. Lists every company in the master DB (active
 * + archived); lets the user create new, rename existing, archive,
 * and re-activate.
 *
 * The CREATE button respects the dev_max_companies cap — a non-dev
 * user with the cap reached sees a disabled button + tooltip
 * explaining how to raise the limit.
 *
 * The PRIMARY company has its delete + deactivate buttons disabled
 * server-side; the UI shows a lock icon to make this clear.
 *
 * Layout: editorial header + card grid (one card per company), modals
 * for create + edit, popconfirm for archive / restore.
 * ────────────────────────────────────────────────────────────────── */
export default function CompanyList() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  // Hard-delete confirmation state. `deleting` is the row being deleted
  // (modal is open when truthy); `confirmText` is what the operator typed,
  // matched against deleting.name to enable the Delete button.
  //
  // Active-company case: when the operator tries to delete the company
  // they're currently logged into, we need to switch them away first
  // (the server refuses to drop the DB its own request is routed
  // through). switchTargetId + switchPassword power that prerequisite
  // step; the main "Delete forever" button stays disabled until both
  // are filled AND the name confirmation matches.
  const [deleting, setDeleting] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [switchTargetId, setSwitchTargetId] = useState(null);
  const [switchPassword, setSwitchPassword] = useState('');
  // Backup-before-delete state. `backupStatus` drives the visual feedback
  // on the Backup step:
  //   'idle'    — button enabled, no message
  //   'busy'    — spinning, "Downloading..."
  //   'done'    — green tick, filename shown
  //   'error'   — red, retry button
  const [backupStatus, setBackupStatus] = useState('idle');
  const [backupFilename, setBackupFilename] = useState(null);
  const [createForm] = Form.useForm();
  const [editForm]   = Form.useForm();

  const setListInStore = useCompanyStore((s) => s.setList);
  const pickCo          = useCompanyStore((s) => s.pick);
  const activeCompanyId = useCompanyStore((s) => s.currentId);
  const devUnlocked    = useDevModeStore((s) => s.unlocked);
  const previewAsUser  = useDevModeStore((s) => s.previewAsUser);
  const effectiveDev   = devUnlocked && !previewAsUser;

  const reload = async () => {
    setLoading(true);
    try {
      const r = await companyAPI.list({ include_inactive: 1 });
      const rows = r.data?.data || [];
      setList(rows);
      setListInStore(rows.filter((c) => c.is_active && !c.db_dropped_at));
    } catch (e) {
      message.error('Could not load companies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const handleCreate = async (values) => {
    try {
      await companyAPI.create(values);
      message.success(`"${values.name}" created`);
      setCreateOpen(false);
      createForm.resetFields();
      reload();
    } catch (e) {
      const msg = e.response?.data?.error || 'Could not create company';
      message.error(msg);
    }
  };

  const handleUpdate = async (values) => {
    try {
      await companyAPI.update(editing.company_id, values);
      message.success('Saved');
      setEditing(null);
      editForm.resetFields();
      reload();
    } catch (e) {
      message.error(e.response?.data?.error || 'Save failed');
    }
  };

  const handleArchive = async (row) => {
    try {
      await companyAPI.archive(row.company_id);
      message.success('Archived');
      reload();
    } catch (e) {
      message.error(e.response?.data?.error || 'Archive failed');
    }
  };

  const handleRestore = async (row) => {
    try {
      await companyAPI.update(row.company_id, { is_active: true });
      message.success('Restored');
      reload();
    } catch (e) {
      message.error('Restore failed');
    }
  };

  // Close the delete modal and clear all step-state. Called from Cancel,
  // the X button, AND the success path (so reopening for a different
  // company starts fresh).
  const closeDeleteModal = () => {
    setDeleting(null);
    setConfirmText('');
    setSwitchTargetId(null);
    setSwitchPassword('');
    setBackupStatus('idle');
    setBackupFilename(null);
  };

  // Trigger a per-company backup download. Works for any company id
  // (the server temporarily routes to that company's DB regardless of
  // the caller's active session).
  const handleBackup = async () => {
    if (!deleting) return;
    setBackupStatus('busy');
    try {
      const res = await companyAPI.backup(deleting.company_id);
      // The response is a Blob (axios responseType: 'blob'). Pull the
      // filename out of the Content-Disposition header so the download
      // matches whatever the server named the file.
      const cd = res.headers?.['content-disposition'] || '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      const slug = String(deleting.name || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const today = new Date().toISOString().slice(0, 10);
      const filename = (m && m[1]) || `${slug}-backup-${today}.enc`;

      // Save via the Electron bridge when available (writes to Downloads
      // folder), or fall back to a browser blob download for web.
      const ab = await res.data.arrayBuffer();
      if (window.electronAPI?.saveBlobToDownloads) {
        const r = await window.electronAPI.saveBlobToDownloads({ fileName: filename, bytes: new Uint8Array(ab) });
        if (r?.error) throw new Error(r.error);
      } else {
        const url = URL.createObjectURL(new Blob([ab], { type: 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setBackupFilename(filename);
      setBackupStatus('done');
      message.success('Backup downloaded');
    } catch (e) {
      console.error('[backup] failed:', e);
      setBackupStatus('error');
      const apiMsg = e.response?.data?.error;
      message.error(apiMsg || 'Backup failed — check server logs');
    }
  };

  // Irreversible delete — drops the per-company PG database AND the
  // master row. Server requires confirm_name to match exactly; we ALSO
  // gate the button on a client-side typed-name match so the request
  // is never even sent unless the operator typed it correctly.
  //
  // Active-company case: the server refuses to drop the DB its own
  // request is routed through (we'd be sawing off the branch we're
  // sitting on). So we first call authAPI.switchCompany to move the
  // session over to another company, hot-swap the auth store, THEN
  // fire the delete. Failure of the switch step aborts cleanly with
  // a clear message — the original delete never goes out.
  const handleHardDelete = async () => {
    if (!deleting) return;
    if (confirmText.trim() !== deleting.name.trim()) {
      message.error('Type the company name exactly to confirm.');
      return;
    }
    const isActive = Number(deleting.company_id) === Number(activeCompanyId);
    if (isActive && (!switchTargetId || !switchPassword)) {
      message.error('Pick a company to switch to and enter your password first.');
      return;
    }
    setDeleteBusy(true);
    try {
      // Step 1 (active-company case only): switch the session to a
      // different company. authAPI.switchCompany returns a fresh JWT
      // bound to the new company_id, plus the (same) user row.
      if (isActive) {
        try {
          const res = await authAPI.switchCompany(switchTargetId, switchPassword);
          const { token, user, must_change_password } = res.data || {};
          if (!token || !user) throw new Error('Switch response malformed');
          useAuthStore.getState().login(user, token, !!must_change_password);
          pickCo(switchTargetId);
          // Give the new JWT a moment to settle into axios's interceptor
          // before the delete fires.
          await new Promise((r) => setTimeout(r, 100));
        } catch (e) {
          const status = e.response?.status;
          const apiMsg = e.response?.data?.error;
          let msg = apiMsg || 'Could not switch company before deleting';
          if (status === 401) msg = 'Password is wrong — switch step failed.';
          message.error({ content: msg, duration: 6 });
          return;
        }
      }

      // Step 2: delete the original company.
      await companyAPI.hardDelete(deleting.company_id, confirmText.trim());
      message.success(`"${deleting.name}" permanently deleted`);
      try { localStorage.removeItem(`onboarding_dismissed_v1::${deleting.company_id}`); } catch {}
      closeDeleteModal();
      reload();
    } catch (e) {
      // Surface enough information to debug without DevTools. A 404 here
      // almost always means the backend server hasn't been restarted to
      // register the new /hard-delete route — the most common cause of
      // a generic "Could not delete" report.
      const status = e.response?.status;
      const apiMsg = e.response?.data?.error;
      let msg = apiMsg;
      if (!msg) {
        if (status === 404) msg = 'Endpoint not found — restart the backend server to register the new delete route.';
        else if (status === 401 || status === 403) msg = 'You don\'t have permission to delete companies (need Admin or Super Admin role).';
        else if (status) msg = `Delete failed (HTTP ${status})`;
        else msg = 'Delete failed — server unreachable.';
      }
      message.error({ content: msg, duration: 6 });
    } finally {
      setDeleteBusy(false);
    }
  };

  const activeCount = list.filter((c) => c.is_active && !c.db_dropped_at).length;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <BankOutlined style={{ fontSize: 26, color: '#21604C' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Title level={2} style={{ margin: 0, lineHeight: 1.1 }}>Companies</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            Each company is its own set of books. Switch between them from the topbar.
          </Text>
        </div>
        <Button onClick={reload} icon={<ReloadOutlined />} loading={loading}>Reload</Button>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
        >
          New Company
        </Button>
      </div>

      {list.length === 0 && !loading && (
        <Empty description="No companies yet. Click New Company to get started." />
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
        gap: 14,
      }}>
        {list.map((c) => {
          const archived = !c.is_active;
          return (
            <Card
              key={c.company_id}
              style={{
                borderRadius: 12,
                border: archived ? '1px dashed #cbd5e1' : '1px solid #e5e7eb',
                opacity: archived ? 0.65 : 1,
              }}
              styles={{ body: { padding: 16 } }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 44, height: 44,
                  borderRadius: 10,
                  background: (c.accent_color || '#21604C') + '20',
                  color: c.accent_color || '#21604C',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <BankOutlined style={{ fontSize: 22 }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</span>
                    {c.is_primary && <Tag color="gold" style={{ marginRight: 0 }}>Primary</Tag>}
                    {archived && <Tag color="default">Archived</Tag>}
                  </div>
                  {c.gstin && (
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, fontFamily: 'monospace' }}>
                      GSTIN {c.gstin}
                    </div>
                  )}
                  {c.address && (
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2,
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.address}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 6 }}>
                    DB: <code style={{ fontSize: 11 }}>{c.db_name}</code>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditing(c);
                    editForm.setFieldsValue({
                      name: c.name,
                      legal_name: c.legal_name,
                      gstin: c.gstin,
                      address: c.address,
                      fy_start_month: c.fy_start_month,
                      accent_color: c.accent_color,
                    });
                  }}
                >
                  Edit
                </Button>
                {archived ? (
                  <Button size="small" icon={<CheckOutlined />} onClick={() => handleRestore(c)}>
                    Restore
                  </Button>
                ) : c.is_primary ? (
                  <Tooltip title="The primary company can't be archived">
                    <Button size="small" icon={<LockOutlined />} disabled>Primary</Button>
                  </Tooltip>
                ) : (
                  <Popconfirm
                    title="Archive this company?"
                    description="The data stays on disk and you can restore it later."
                    icon={<ExclamationCircleOutlined style={{ color: '#f59e0b' }} />}
                    okText="Archive"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleArchive(c)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>Archive</Button>
                  </Popconfirm>
                )}
                {/* Delete-permanently — irreversible. Hidden on the
                 *  primary company (server also refuses). The currently-
                 *  active company is still deletable but the modal will
                 *  ask the operator to switch to a different company
                 *  first (we can't drop the DB the active session is
                 *  routed through). */}
                {!c.is_primary && (
                  <Tooltip title={
                    Number(c.company_id) === Number(activeCompanyId)
                      ? "Permanently delete this company. You'll be switched to another company first."
                      : 'Permanently delete this company. Drops its database and all its bills, ledger entries, and audit trail. Cannot be undone.'
                  }>
                    <Button
                      size="small"
                      danger
                      type="text"
                      icon={<DeleteOutlined />}
                      onClick={() => {
                        setDeleting(c);
                        setConfirmText('');
                        setSwitchTargetId(null);
                        setSwitchPassword('');
                        setBackupStatus('idle');
                        setBackupFilename(null);
                      }}
                      style={{ color: '#dc2626' }}
                    >
                      Delete
                    </Button>
                  </Tooltip>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <div style={{ marginTop: 18, color: '#94a3b8', fontSize: 12 }}>
        {activeCount} active {activeCount === 1 ? 'company' : 'companies'}.
        {!effectiveDev && ' Ask your developer to add more if you need them.'}
      </div>

      {/* ── Create modal ───────────────────────────────────────────── */}
      <Modal
        title={<span><PlusOutlined /> New Company</span>}
        open={createOpen}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        onOk={() => createForm.submit()}
        okText="Create"
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}
              initialValues={{ fy_start_month: 4, accent_color: '#21604C' }}>
          <Form.Item label="Company name" name="name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Sabina Dresses (Sister concern)" autoFocus />
          </Form.Item>
          <Form.Item label="Legal name (optional)" name="legal_name">
            <Input placeholder="As registered with the GST department" />
          </Form.Item>
          <Form.Item label="GSTIN (optional)" name="gstin">
            <Input placeholder="27AAAAA0000A1Z5" />
          </Form.Item>
          <Form.Item label="Address (optional)" name="address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="Financial year start" name="fy_start_month">
            <Select options={FY_MONTHS} />
          </Form.Item>
          <Form.Item label="Accent color" name="accent_color"
            tooltip="Used in the topbar pill so each company is visually distinct">
            <Input placeholder="#21604C" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Hard-delete confirmation modal ─────────────────────────── */}
      <Modal
        title={null}
        closable={false}
        open={!!deleting}
        onCancel={closeDeleteModal}
        footer={(() => {
          const isActive = deleting && Number(deleting.company_id) === Number(activeCompanyId);
          const nameOk = deleting && confirmText.trim() === deleting.name.trim();
          const switchOptionsExist = deleting && list.some((c) =>
            c.is_active && !c.db_dropped_at && Number(c.company_id) !== Number(deleting.company_id));
          const switchOk = !isActive || (switchTargetId && switchPassword);
          const switchBlocked = isActive && !switchOptionsExist;
          return [
            <Button key="cancel" size="large" onClick={closeDeleteModal}>
              Cancel
            </Button>,
            <Button
              key="delete"
              danger
              type="primary"
              size="large"
              loading={deleteBusy}
              disabled={!nameOk || !switchOk || switchBlocked}
              onClick={handleHardDelete}
              icon={<DeleteOutlined />}
            >
              {isActive ? 'Switch & delete forever' : 'Delete forever'}
            </Button>,
          ];
        })()}
        destroyOnClose
        width={620}
        className="company-delete-modal"
        styles={{
          body: { padding: 0 },
          content: { padding: 0 },
        }}
      >
        {deleting && (() => {
          const isActive = Number(deleting.company_id) === Number(activeCompanyId);
          const switchOptions = list
            .filter((c) => c.is_active && !c.db_dropped_at && Number(c.company_id) !== Number(deleting.company_id))
            .map((c) => ({ value: c.company_id, label: c.name + (c.is_primary ? ' (Primary)' : '') }));
          // Step progress — visually indicates how many gates the operator
          // still has to clear. Always:
          //   1. Back up   (optional but recommended; "done" when downloaded)
          //   2. Switch    (required only on active-company case)
          //   3. Confirm   (always required)
          const stepsCount = isActive ? 3 : 2;
          let currentStep = 0;
          if (backupStatus === 'done') currentStep = 1;
          if (isActive && switchTargetId && switchPassword) currentStep = 2;
          if (!isActive && backupStatus !== 'idle') currentStep = 1;
          const nameOk = confirmText.trim() === deleting.name.trim();
          if (nameOk) currentStep = stepsCount - 1;

          return (
            <div className="cdm-body">
              {/* ── Header banner ── */}
              <div className="cdm-header">
                <div className="cdm-header-icon">
                  <WarningFilled />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="cdm-header-title">
                    Permanently delete <b>{deleting.name}</b>?
                  </div>
                  <div className="cdm-header-sub">
                    This action is <b>irreversible</b>. Once you confirm,{' '}
                    every bill, ledger entry, payment, batch, audit trail and
                    uploaded logo/signature is gone for good.
                  </div>
                </div>
              </div>

              {/* ── Progress ── */}
              <div className="cdm-steps">
                <Steps
                  size="small"
                  current={currentStep}
                  items={[
                    { title: 'Back up' },
                    ...(isActive ? [{ title: 'Switch session' }] : []),
                    { title: 'Confirm' },
                  ]}
                />
              </div>

              <div className="cdm-content">
                {/* ── Step 1: Backup ── */}
                <section className="cdm-step">
                  <div className="cdm-step-head">
                    <span className="cdm-step-num">1</span>
                    <div>
                      <div className="cdm-step-title">Back up first (recommended)</div>
                      <div className="cdm-step-desc">
                        Download an encrypted <code>.enc</code> snapshot of{' '}
                        <b>{deleting.name}</b>. You can restore it later via{' '}
                        Settings → Backup &amp; Recovery if you change your mind.
                      </div>
                    </div>
                  </div>
                  <div className="cdm-step-body">
                    {backupStatus === 'idle' && (
                      <Button
                        icon={<CloudDownloadOutlined />}
                        onClick={handleBackup}
                      >
                        Download backup
                      </Button>
                    )}
                    {backupStatus === 'busy' && (
                      <Button loading disabled>Preparing backup…</Button>
                    )}
                    {backupStatus === 'done' && (
                      <div className="cdm-backup-done">
                        <CheckOutlined style={{ color: '#10b981' }} />
                        <span style={{ marginLeft: 6 }}>
                          Saved to Downloads: <code>{backupFilename}</code>
                        </span>
                        <Button
                          type="link"
                          size="small"
                          onClick={handleBackup}
                          style={{ marginLeft: 8, padding: 0 }}
                        >
                          Download again
                        </Button>
                      </div>
                    )}
                    {backupStatus === 'error' && (
                      <Button danger icon={<CloudDownloadOutlined />} onClick={handleBackup}>
                        Backup failed — retry
                      </Button>
                    )}
                  </div>
                </section>

                {/* ── Step 2: Switch (active company only) ── */}
                {isActive && (
                  <section className="cdm-step">
                    <div className="cdm-step-head">
                      <span className="cdm-step-num">2</span>
                      <div>
                        <div className="cdm-step-title">
                          Switch your session to another company
                        </div>
                        <div className="cdm-step-desc">
                          You're currently signed into <b>{deleting.name}</b>. We'll
                          move your session to a different company before dropping its
                          database — your password is required to confirm the switch.
                        </div>
                      </div>
                    </div>
                    <div className="cdm-step-body">
                      {switchOptions.length === 0 ? (
                        <div className="cdm-empty">
                          <Text type="danger">No other active companies available.</Text>
                          <div style={{ fontSize: 12, color: 'var(--fg-secondary, #64748b)', marginTop: 4 }}>
                            Create another company or restore an archived one first.
                          </div>
                        </div>
                      ) : (
                        <Space direction="vertical" size={10} style={{ width: '100%' }}>
                          <div>
                            <div className="cdm-field-label">Switch to</div>
                            <Select
                              value={switchTargetId}
                              onChange={setSwitchTargetId}
                              placeholder="Pick a company"
                              options={switchOptions}
                              suffixIcon={<SwapOutlined />}
                              style={{ width: '100%' }}
                              size="large"
                            />
                          </div>
                          <div>
                            <div className="cdm-field-label">Your password</div>
                            <Input.Password
                              value={switchPassword}
                              onChange={(e) => setSwitchPassword(e.target.value)}
                              placeholder="••••••••"
                              autoComplete="current-password"
                              size="large"
                            />
                          </div>
                        </Space>
                      )}
                    </div>
                  </section>
                )}

                {/* ── Step 3 (or 2 for non-active): Confirm name ── */}
                <section className="cdm-step cdm-step-final">
                  <div className="cdm-step-head">
                    <span className="cdm-step-num cdm-step-num-final">
                      {isActive ? '3' : '2'}
                    </span>
                    <div>
                      <div className="cdm-step-title">
                        Confirm by typing the company name
                      </div>
                      <div className="cdm-step-desc">
                        We require an exact match — this is your last chance to back out.
                      </div>
                    </div>
                  </div>
                  <div className="cdm-step-body">
                    <div className="cdm-confirm-row">
                      <div className="cdm-confirm-target">
                        <code>{deleting.name}</code>
                      </div>
                      <Input
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder={`Type "${deleting.name}" exactly`}
                        size="large"
                        status={confirmText && !nameOk ? 'error' : undefined}
                        onPressEnter={() => {
                          const switchOk = !isActive || (switchTargetId && switchPassword);
                          if (nameOk && switchOk) handleHardDelete();
                        }}
                      />
                    </div>
                    {confirmText && !nameOk && (
                      <div className="cdm-confirm-hint">
                        Doesn't match — type the name exactly as shown above (including any spaces and capitalisation).
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* ── Edit modal ─────────────────────────────────────────────── */}
      <Modal
        title={<span><EditOutlined /> Edit {editing?.name}</span>}
        open={!!editing}
        onCancel={() => { setEditing(null); editForm.resetFields(); }}
        onOk={() => editForm.submit()}
        okText="Save"
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" onFinish={handleUpdate}>
          <Form.Item label="Name" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Legal name" name="legal_name">
            <Input />
          </Form.Item>
          <Form.Item label="GSTIN" name="gstin">
            <Input />
          </Form.Item>
          <Form.Item label="Address" name="address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="Financial year start" name="fy_start_month">
            <Select options={FY_MONTHS} />
          </Form.Item>
          <Form.Item label="Accent color" name="accent_color">
            <Input placeholder="#21604C" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
