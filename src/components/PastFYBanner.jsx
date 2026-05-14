import React from 'react';
import { WarningOutlined, RollbackOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useFYContext } from '../hooks/useFinancialYear';
import './past-fy-banner.css';

/* ──────────────────────────────────────────────────────────────────────────
 * PastFYBanner — global amber banner that's only visible while the user
 * is viewing a past financial year context.
 *
 * Mounted once at the top of AppLayout, just below the topnav (or above
 * the sidebar+content split in vertical mode). Reads useFYContext and
 * renders nothing when viewingFYOffset === 0 (the default, current FY).
 *
 * Two pieces of information the banner carries:
 *   1. WHICH past FY you're viewing (label + end date)
 *   2. ONE-CLICK return path back to the current FY
 *
 * It's deliberately a thin strip — 36 px tall — so it never steals the
 * main content area, but it's bright enough (amber tint + matching dot)
 * that the user can't miss the context. The amber tone is reused from
 * the status-tag system (Partial = #F59E0B) so the visual language is
 * consistent with the rest of the chrome.
 * ────────────────────────────────────────────────────────────────────── */

export default function PastFYBanner() {
  const { isViewingPast, viewingFY, currentFY, resetView } = useFYContext();

  if (!isViewingPast || !viewingFY || !currentFY) return null;

  const endDate  = viewingFY.end ? dayjs(viewingFY.end).format('DD MMM YYYY') : null;
  const isClosed = endDate && dayjs(viewingFY.end).isBefore(dayjs(), 'day');

  return (
    <div className="erp-pastfy-banner" role="status" aria-live="polite">
      <WarningOutlined className="erp-pastfy-icon" aria-hidden="true" />
      <span className="erp-pastfy-text">
        Viewing <strong>{viewingFY.label}</strong>
        {endDate && <span className="erp-pastfy-meta"> (ended {endDate})</span>}
        {isClosed && <span className="erp-pastfy-meta"> — closed</span>}
        <span className="erp-pastfy-sep">·</span>
        New bills + journals you create will use this FY's voucher sequence.
      </span>
      <button
        type="button"
        className="erp-pastfy-action"
        onClick={resetView}
        title={`Return to current FY (${currentFY.label})`}
      >
        <RollbackOutlined />
        Back to {currentFY.label}
      </button>
    </div>
  );
}
