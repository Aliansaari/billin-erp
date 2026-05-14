import React, { useEffect, useRef, useState } from 'react';
import { Dropdown, Modal } from 'antd';
import { CalendarOutlined, DownOutlined, CheckOutlined, WarningOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useFYContext, fyLabel } from '../hooks/useFinancialYear';
import './fy-switcher.css';

/* ──────────────────────────────────────────────────────────────────────────
 * FYSwitcher — financial-year context pill, sibling to CompanySwitcher.
 *
 * Renders the currently-viewed FY label (e.g. "FY 2026-27") with a small
 * dropdown listing the current FY plus the last 3 past FYs. Switching to
 * a past FY pops a confirm modal explaining that the user is about to
 * work in a closed period, then sets viewingFYOffset on the store. A
 * persistent yellow banner (PastFYBanner, rendered at AppLayout level)
 * mirrors the past-FY state so the user always knows their context.
 *
 * Three visual modes (matches CompanySwitcher's variants):
 *   - pill     (default)  → expanded form for topnav / sidebar full
 *   - icon     → collapsed-sidebar form (calendar glyph only)
 *
 * Switching auto-hides on single-FY scenarios where there's nothing to
 * switch to — but in practice every install has a "previous FY" once a
 * year has passed, so the switcher is almost always useful.
 * ────────────────────────────────────────────────────────────────────── */

export default function FYSwitcher({ collapsed = false, alignRight = false }) {
  const navigate = useNavigate();
  const { currentFY, viewingFY, pastFYs, isViewingPast, switchTo, resetView } = useFYContext();

  const [ddOpen, setDdOpen]     = useState(false);
  const [confirmFY, setConfirm] = useState(null); // {offset, fy, isPast}

  // Hidden until FY config loads from settings — avoids flashing a
  // "FY —" placeholder during the initial /api/settings/system fetch.
  if (!currentFY) return null;

  const handlePick = (offset, fy) => {
    setDdOpen(false);
    if (offset === 0) {
      // Switching back to current — no confirm needed, instant.
      if (isViewingPast) resetView();
      return;
    }
    // Switching to a past FY — confirm dialog explains the implications.
    setConfirm({ offset, fy });
  };

  const handleConfirm = () => {
    if (!confirmFY) return;
    switchTo(confirmFY.offset);
    setConfirm(null);
  };

  // Build the dropdown items: current FY first (with checkmark when
  // it's the viewing one), then the last 3 past FYs.
  const items = [
    {
      key: 'fy-header',
      type: 'group',
      label: (
        <div className="fysw-dd-head">
          <span>SWITCH FINANCIAL YEAR</span>
        </div>
      ),
    },
    {
      key: 'fy-current',
      label: (
        <span className="fysw-dd-row">
          <span className="fysw-dd-label">{currentFY.label}</span>
          <span className="fysw-dd-sub">Current</span>
          {!isViewingPast && <CheckOutlined className="fysw-dd-tick" />}
        </span>
      ),
      onClick: () => handlePick(0, currentFY),
    },
    ...pastFYs.filter(Boolean).map((fy) => ({
      key: `fy-${fy.offset}`,
      label: (
        <span className="fysw-dd-row">
          <span className="fysw-dd-label">{fy.label}</span>
          <span className="fysw-dd-sub">{fy.offset === -1 ? 'Previous' : `${Math.abs(fy.offset)} years ago`}</span>
          {viewingFY && viewingFY.start === fy.start && <CheckOutlined className="fysw-dd-tick" />}
        </span>
      ),
      onClick: () => handlePick(fy.offset, fy),
    })),
    { type: 'divider' },
    {
      key: 'fy-manage',
      icon: <CalendarOutlined />,
      label: 'Financial Year settings',
      onClick: () => { setDdOpen(false); navigate('/settings/financial-year'); },
    },
  ];

  const confirmModal = (
    <Modal
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <WarningOutlined style={{ color: '#F59E0B' }} />
          Switch to {confirmFY?.fy?.label}?
        </span>
      }
      open={!!confirmFY}
      onCancel={() => setConfirm(null)}
      onOk={handleConfirm}
      okText="Switch to past FY"
      cancelText="Cancel"
      okButtonProps={{ danger: false }}
      width={460}
    >
      <p style={{ margin: '4px 0 8px', color: 'var(--fg-secondary)', fontSize: 13.5, lineHeight: 1.55 }}>
        You're about to work in a <strong>closed financial year</strong>. Any new bills, returns,
        or journal entries you create will be dated and numbered against{' '}
        <strong>{confirmFY?.fy?.label}</strong>, not the current FY.
      </p>
      <p style={{ margin: '0 0 4px', color: 'var(--fg-tertiary)', fontSize: 12.5, lineHeight: 1.5 }}>
        A yellow banner at the top of the screen will remind you of the context. Switch back to{' '}
        <strong>{currentFY?.label}</strong> any time from the same pill.
      </p>
    </Modal>
  );

  // Collapsed sidebar — single icon with title tooltip.
  if (collapsed) {
    return (
      <>
        <Dropdown
          menu={{ items }}
          placement="bottomLeft"
          trigger={['click']}
          open={ddOpen}
          onOpenChange={setDdOpen}
          overlayClassName="fysw-dropdown"
        >
          <button
            type="button"
            className={`fysw-icon${isViewingPast ? ' is-past' : ''}`}
            title={`FY: ${viewingFY?.label || currentFY.label}${isViewingPast ? ' (past — click to switch)' : ''}`}
            aria-haspopup="true"
            aria-expanded={ddOpen}
          >
            <CalendarOutlined />
          </button>
        </Dropdown>
        {confirmModal}
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
        overlayClassName="fysw-dropdown"
      >
        <button
          type="button"
          className={`fysw-pill${isViewingPast ? ' is-past' : ''}`}
          title={`Financial year — click to switch${isViewingPast ? ' (currently viewing past FY)' : ''}`}
          aria-haspopup="true"
          aria-expanded={ddOpen}
        >
          <CalendarOutlined className="fysw-glyph" />
          <span className="fysw-label">
            <span className="fysw-prefix">FY</span> {viewingFY?.label || currentFY.label}
          </span>
          <DownOutlined className="fysw-caret" />
        </button>
      </Dropdown>
      {confirmModal}
    </>
  );
}
