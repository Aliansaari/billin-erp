import React, { useEffect, useState } from 'react';
import { Dropdown, Tag, Tooltip, Modal, message } from 'antd';
import {
  BankOutlined, DownOutlined, CheckOutlined, SwapOutlined,
  PlusOutlined, AppstoreOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { companyAPI } from '../api';
import useCompanyStore from '../store/companyStore';
import useAuthStore from '../store/authStore';

/* ── CompanySwitcher ──────────────────────────────────────────────────
 *
 * Compact pill that shows the active company name + chevron, click
 * opens a dropdown with every active company plus "Manage Companies"
 * and (for developers) "+ New Company" actions.
 *
 * Phase 1 behaviour: when the user picks a different company, we show
 * a "Re-login required to switch" modal — Phase 2 will wire the actual
 * connection routing. For now the modal explains why and offers a
 * graceful Sign Out + relog flow.
 *
 * Hidden entirely when there's only one company (no switcher needed).
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

  // Refresh the company list on mount in case it changed since login.
  useEffect(() => {
    companyAPI.list()
      .then((r) => setList((r.data?.data || []).filter((c) => c.is_active && !c.db_dropped_at)))
      .catch(() => { /* silent — already-cached list keeps working */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hide entirely when only one company. Nothing to switch between.
  if (!list || list.length < 2) return null;

  const current = list.find((c) => c.company_id === currentId) || list[0];

  const handleSwitch = (target) => {
    if (target.company_id === current.company_id) return;
    Modal.confirm({
      title: `Switch to ${target.name}?`,
      icon: <SwapOutlined />,
      content: (
        <div>
          <p style={{ margin: '8px 0' }}>
            Switching companies in this version requires you to sign in again. Your work is saved
            on the current company; nothing is lost.
          </p>
          <p style={{ margin: '8px 0', color: '#94a3b8', fontSize: 13 }}>
            Quick in-place switching arrives in the next update.
          </p>
        </div>
      ),
      okText: 'Sign out & switch',
      cancelText: 'Stay here',
      onOk: () => {
        // Persist the new company id so the next login auto-selects it,
        // then run the FULL auth-store logout (which clears the token,
        // user, change-password flag AND syncs the store state) so we
        // can't end up half-logged-out — that combination caused the
        // blank-screen redirect loop on next launch.
        useCompanyStore.getState().pick(target.company_id);
        useAuthStore.getState().logout();
        message.info(`Switching to ${target.name}…`);
        setTimeout(() => { window.location.href = '/login'; }, 350);
      },
    });
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
      onClick: () => handleSwitch(c),
    })),
    { type: 'divider' },
    {
      key: 'manage',
      icon: <AppstoreOutlined />,
      label: 'Manage Companies',
      onClick: () => navigate('/settings/companies'),
    },
  ];

  if (collapsed) {
    return (
      <Tooltip title={`Company: ${current.name}`} placement="right">
        <Dropdown
          menu={{ items }}
          placement="bottomLeft"
          trigger={['click']}
        >
          <button
            type="button"
            className="erp-company-switch-icon"
            style={{
              width: 36, height: 36, padding: 0,
              borderRadius: 8,
              border: `1px solid ${current.accent_color || 'var(--border-subtle, #e5e7eb)'}`,
              background: (current.accent_color || '#21604C') + '20',
              color: current.accent_color || 'var(--fg-primary)',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto',
            }}
          >
            <BankOutlined style={{ fontSize: 16 }} />
          </button>
        </Dropdown>
      </Tooltip>
    );
  }

  return (
    <Dropdown
      menu={{ items }}
      placement={alignRight ? 'bottomRight' : 'bottomLeft'}
      trigger={['click']}
    >
      <button
        type="button"
        className="erp-company-switch-pill"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px',
          borderRadius: 8,
          border: `1px solid ${(current.accent_color || '#21604C')}40`,
          background: (current.accent_color || '#21604C') + '14',
          color: 'var(--fg-primary)',
          cursor: 'pointer',
          fontSize: 13, fontWeight: 600,
          width: '100%',
          minWidth: 0,
        }}
        title="Switch company"
      >
        <BankOutlined style={{ color: current.accent_color || '#21604C', flexShrink: 0 }} />
        <span style={{
          flex: 1, minWidth: 0, textAlign: 'left',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{current.name}</span>
        <DownOutlined style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }} />
      </button>
    </Dropdown>
  );
}
