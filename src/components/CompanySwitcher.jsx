import React, { useEffect, useRef, useState } from 'react';
import { Dropdown, Tag, Tooltip, Modal, Input, Form, message } from 'antd';
import {
  BankOutlined, DownOutlined, CheckOutlined, SwapOutlined,
  PlusOutlined, AppstoreOutlined, LockOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { authAPI, companyAPI } from '../api';
import useCompanyStore from '../store/companyStore';
import useAuthStore from '../store/authStore';
import './company-switcher.css';

/* ── CompanySwitcher ──────────────────────────────────────────────────
 *
 * Compact pill that shows the active company name + chevron, click
 * opens a dropdown with every active company plus "Manage Companies".
 *
 * Switching is IN-PLACE (no full logout / page reload):
 *
 *   1. User picks a destination company from the dropdown.
 *   2. We open a password modal (because users + passwords are
 *      per-company-isolated — the same `username` may have a
 *      different password in each company DB).
 *   3. POST /api/auth/switch-company with { company_id, password }.
 *   4. Server validates the password against the destination
 *      company's user-store, returns a fresh JWT carrying the new
 *      company_id claim.
 *   5. We swap the JWT in localStorage, update auth + company stores,
 *      and navigate to home — every subsequent API call routes to
 *      the new company automatically via the auth middleware's
 *      ALS pinning.
 *
 * If the user does NOT have an account on the destination company
 * (or types the wrong password), the server returns 401 and we keep
 * the current session intact — no half-state.
 *
 * Hidden entirely when there's only one company.
 *
 * Two visual modes:
 *   compact={true}  — collapsed sidebar — single pill icon
 *   compact={false} — expanded sidebar — pill with name + chevron
 *
 * Props:
 *   collapsed   — sidebar collapsed (icon-only)
 *   alignRight  — top-nav usage (right-side dropdown)
 * ──────────────────────────────────────────────────────────────────── */
export default function CompanySwitcher({ collapsed = false, alignRight = false }) {
  const navigate = useNavigate();
  const list      = useCompanyStore((s) => s.list);
  const currentId = useCompanyStore((s) => s.currentId);
  const setList   = useCompanyStore((s) => s.setList);
  const pickCo    = useCompanyStore((s) => s.pick);

  const [pwOpen, setPwOpen]       = useState(false);
  const [pwTarget, setPwTarget]   = useState(null);   // {company_id, name, accent_color}
  const [pwBusy, setPwBusy]       = useState(false);
  const [pwValue, setPwValue]     = useState('');
  const [pwError, setPwError]     = useState('');
  const pwInputRef                = useRef(null);

  // Controlled-open state for the dropdown so the F9 shortcut can pop
  // it open in place instead of navigating to a separate page.
  const [ddOpen, setDdOpen]       = useState(false);

  // Refresh the company list on mount in case it changed since login.
  useEffect(() => {
    companyAPI.list()
      .then((r) => setList((r.data?.data || []).filter((c) => c.is_active && !c.db_dropped_at)))
      .catch(() => { /* silent — already-cached list keeps working */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-focus the password field when the modal opens.
  useEffect(() => {
    if (pwOpen) {
      const t = setTimeout(() => pwInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [pwOpen]);

  // F9 handler — useKeyboardShortcuts dispatches `company-switcher:open`
  // on F9 from anywhere in the app; we open the dropdown here.
  useEffect(() => {
    const onF9 = () => setDdOpen(true);
    window.addEventListener('company-switcher:open', onF9);
    return () => window.removeEventListener('company-switcher:open', onF9);
  }, []);

  // Hide entirely when only one company. Nothing to switch between.
  if (!list || list.length < 2) return null;

  const current = list.find((c) => c.company_id === currentId) || list[0];

  // Click-handler from the dropdown — opens the password modal.
  const handlePick = (target) => {
    if (target.company_id === current.company_id) {
      setDdOpen(false);
      return;
    }
    setDdOpen(false);
    setPwTarget(target);
    setPwValue('');
    setPwError('');
    setPwOpen(true);
  };

  const handleSubmit = async () => {
    if (!pwTarget || !pwValue) return;
    setPwBusy(true);
    setPwError('');
    try {
      const res = await authAPI.switchCompany(pwTarget.company_id, pwValue);
      const { token, user, company_id, must_change_password } = res.data || {};
      if (!token || !user) throw new Error('Malformed switch response');

      // Hot-swap the auth state. login() persists token + user to
      // localStorage and updates the store atomically — every
      // subsequent axios request will carry the new JWT.
      useAuthStore.getState().login(user, token, !!must_change_password);
      pickCo(company_id);
      message.success(`Switched to ${pwTarget.name}`);

      // Reset modal and bounce to home so any in-flight per-company
      // queries on the previous page are flushed cleanly.
      setPwOpen(false);
      setPwValue('');
      setPwTarget(null);
      navigate('/', { replace: true });
    } catch (e) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.error || e.message || 'Switch failed';
      if (status === 429) {
        setPwError('Too many attempts. Please wait a moment and try again.');
      } else if (status === 401) {
        setPwError(msg);
      } else if (status === 404) {
        setPwError('Company is unavailable.');
      } else {
        setPwError(msg);
      }
    } finally {
      setPwBusy(false);
    }
  };

  const items = [
    {
      key: 'header',
      type: 'group',
      label: (
        <div style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: '#94a3b8', padding: '2px 0' }}>
          Switch company
        </div>
      ),
    },
    ...list.map((c) => ({
      key: `c-${c.company_id}`,
      icon: c.company_id === current.company_id
        ? <CheckOutlined style={{ color: '#16a34a' }} />
        : <BankOutlined style={{ color: c.accent_color || '#6b7280' }} />,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontWeight: c.company_id === current.company_id ? 600 : 400 }}>{c.name}</span>
          {c.is_primary && <Tag color="default" style={{ marginRight: 0, fontSize: 10 }}>Primary</Tag>}
        </span>
      ),
      onClick: () => handlePick(c),
    })),
    { type: 'divider' },
    {
      key: 'manage',
      icon: <AppstoreOutlined />,
      label: 'Manage Companies',
      onClick: () => navigate('/settings/companies'),
    },
  ];

  const passwordModal = (
    <Modal
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SwapOutlined style={{ color: pwTarget?.accent_color || '#21604C' }} />
          Switch to {pwTarget?.name}
        </span>
      }
      open={pwOpen}
      onCancel={() => { if (!pwBusy) setPwOpen(false); }}
      onOk={handleSubmit}
      okText="Switch"
      cancelText="Cancel"
      confirmLoading={pwBusy}
      destroyOnClose
      width={420}
      okButtonProps={{ disabled: !pwValue || pwBusy }}
    >
      <p style={{ margin: '4px 0 14px', color: '#475569', fontSize: 13 }}>
        Enter your password for <strong>{pwTarget?.name}</strong>. Your session
        switches in place — no need to sign back in.
      </p>
      <Form layout="vertical">
        <Form.Item
          label="Password"
          validateStatus={pwError ? 'error' : ''}
          help={pwError || ''}
          style={{ marginBottom: 0 }}
        >
          <Input.Password
            ref={pwInputRef}
            value={pwValue}
            onChange={(e) => { setPwValue(e.target.value); setPwError(''); }}
            onPressEnter={handleSubmit}
            prefix={<LockOutlined style={{ color: '#94a3b8' }} />}
            placeholder={`Password for ${pwTarget?.name || 'company'}`}
            autoComplete="current-password"
            disabled={pwBusy}
          />
        </Form.Item>
      </Form>
    </Modal>
  );

  // Avatar/initial removed — the company name + caret carry enough identity
  // on their own, and the colored-letter chrome was reading too busy
  // against the rest of the nav. Collapsed sidebar (no room for the name)
  // falls back to a plain BankOutlined glyph, same icon the rest of the
  // app uses to mean "company / accounting entity".

  if (collapsed) {
    return (
      <>
        <Tooltip title={`Company: ${current.name}`} placement="right">
          <Dropdown
            menu={{ items }}
            placement="bottomLeft"
            trigger={['click']}
            open={ddOpen}
            onOpenChange={setDdOpen}
            overlayClassName="erp-cs-dropdown"
          >
            <button
              type="button"
              className="erp-cs-icon"
              aria-label={`Company: ${current.name} — click to switch`}
              aria-haspopup="true"
              aria-expanded={ddOpen}
            >
              <BankOutlined />
            </button>
          </Dropdown>
        </Tooltip>
        {passwordModal}
      </>
    );
  }

  return (
    <>
      <Dropdown
        menu={{ items }}
        placement={alignRight ? 'bottomRight' : 'bottomLeft'}
        trigger={['click']}
        open={ddOpen}
        onOpenChange={setDdOpen}
        overlayClassName="erp-cs-dropdown"
      >
        <button
          type="button"
          className="erp-cs-pill"
          title={`Company: ${current.name} — click to switch (F9)`}
          aria-haspopup="true"
          aria-expanded={ddOpen}
        >
          <span className="erp-cs-name">{current.name}</span>
          <span className="erp-cs-caret"><DownOutlined /></span>
        </button>
      </Dropdown>
      {passwordModal}
    </>
  );
}
