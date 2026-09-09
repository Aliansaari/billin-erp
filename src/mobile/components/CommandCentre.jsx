/* ────────────────────────────────────────────────────────────────────
 * CommandCentre — the floating centre button in the TabBar.
 *
 * Tap the grid pill to open an action sheet: a compact Create grid plus
 * a Browse list. Swipe the sheet down (or tap the backdrop / ✕) to close.
 * ──────────────────────────────────────────────────────────────────── */
import { isOfflineSession } from '../../api';
import { tap as hapticTap, warn as hapticWarn } from '../utils/haptics';
import { Toast } from 'antd-mobile';
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import './CommandCentre.css';

const CREATES = [
  {
    id: 'sale-new', label: 'New\nSale', route: '/sale/new', accent: '#0EAFCA',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/>
      </svg>
    ),
  },
  {
    id: 'purchase-new', label: 'New\nPurchase', route: '/purchase/new', accent: '#B45309',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>
      </svg>
    ),
  },
  {
    id: 'receipt-new', label: 'Record\nReceipt', route: '/receipt/new', accent: '#16A34A',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>
      </svg>
    ),
  },
  {
    id: 'payment-new', label: 'Record\nPayment', route: '/payment/new', accent: '#DC2626',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 21V9M7 14l5-5 5 5"/><path d="M5 3h14"/>
      </svg>
    ),
  },
  {
    id: 'customer-new', label: 'Add\nCustomer', route: '/customer/new', accent: '#7C3AED',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>
      </svg>
    ),
  },
  {
    id: 'supplier-new', label: 'Add\nSupplier', route: '/supplier/new', accent: '#0F766E',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
      </svg>
    ),
  },
];

const BROWSES = [
  {
    id: 'vouchers', label: 'All Vouchers', sub: 'Sales · purchases · receipts', route: '/vouchers', accent: '#475569',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 19.5A2.5 2.5 0 0 1 4.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
    ),
  },
  {
    id: 'outstanding', label: 'Outstanding', sub: 'Receivables · payables', route: '/outstanding', accent: '#D97706',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
      </svg>
    ),
  },
  {
    id: 'day-book', label: 'Day Book', sub: "Today's entries", route: '/day-book', accent: '#0891B2',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M9 16l2 2 4-4"/>
      </svg>
    ),
  },
  {
    id: 'reports', label: 'Reports', sub: 'All financial reports', route: '/reports', accent: '#0F766E',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/>
      </svg>
    ),
  },
];

function CommandCentreSheet({ onClose }) {
  const navigate = useNavigate();
  const bodyRef = useRef(null);
  const drag = useRef({ startY: 0, active: false, delta: 0 });
  const [dragY, setDragY] = useState(0);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (route) => {
    // In an offline session there is no way to save anything, so stop at the
    // door rather than letting someone fill in a whole bill and only discover
    // it at the moment they press save. Read-only destinations still open.
    if (isOfflineSession() && /\/(new|edit)(\/|$)/.test(route)) {
      hapticWarn();
      Toast.show({
        content: 'Shop computer is offline — you can view saved figures, but not create or edit.',
        duration: 2600,
      });
      return;
    }
    hapticTap();
    onClose();
    setTimeout(() => navigate(route), 160);
  };

  /* Swipe-down-to-dismiss. Engages only when the scroll body is at the
     top, so dragging down mid-scroll scrolls content instead of fighting
     the dismiss. Works anywhere on the sheet, not just the handle. */
  const onTouchStart = (e) => {
    const atTop = !bodyRef.current || bodyRef.current.scrollTop <= 0;
    drag.current = { startY: e.touches[0].clientY, active: atTop, delta: 0 };
  };
  const onTouchMove = (e) => {
    if (!drag.current.active) return;
    const delta = e.touches[0].clientY - drag.current.startY;
    if (delta > 0) {
      drag.current.delta = delta;   // track in the ref — survives render timing
      setDragY(delta);
    } else {
      // upward drag → hand back to native scroll
      drag.current.active = false;
      drag.current.delta = 0;
      setDragY(0);
    }
  };
  const onTouchEnd = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    if (drag.current.delta > 88) onClose();
    else setDragY(0);
  };

  const sheetStyle = {
    transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
    transition: dragY > 0 ? 'none' : 'transform 300ms cubic-bezier(0.32, 0.72, 0, 1)',
  };
  const backdropStyle = dragY > 0 ? { opacity: Math.max(0.15, 1 - dragY / 320) } : undefined;

  return (
    <div className="cc-backdrop" style={backdropStyle} onClick={onClose}>
      <div
        className="cc-sheet"
        style={sheetStyle}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        role="dialog"
        aria-modal="true"
        aria-label="Command centre"
      >
        <div className="cc-grab-area"><div className="cc-grab" /></div>

        <div className="cc-head">
          <div>
            <div className="cc-head-title">Quick <em>actions</em></div>
            <div className="cc-head-sub">Create entries · browse records</div>
          </div>
          <button className="cc-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="cc-body" ref={bodyRef}>
          <div className="cc-section-label">Create</div>
          <div className="cc-create-grid">
            {CREATES.map((item) => (
              <button key={item.id} className="cc-create-item" onClick={() => go(item.route)}>
                <div className="cc-ci-icon" style={{ background: item.accent + '16', color: item.accent }}>
                  {item.icon}
                </div>
                <div className="cc-ci-label">{item.label}</div>
              </button>
            ))}
          </div>

          <div className="cc-section-label cc-section-label--browse">Browse</div>
          <div className="cc-browse-list">
            {BROWSES.map((item) => (
              <button key={item.id} className="cc-browse-item" onClick={() => go(item.route)}>
                <div className="cc-bi-icon" style={{ background: item.accent + '16', color: item.accent }}>
                  {item.icon}
                </div>
                <div className="cc-bi-text">
                  <div className="cc-bi-label">{item.label}</div>
                  <div className="cc-bi-sub">{item.sub}</div>
                </div>
                <div className="cc-bi-chev">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CommandCentre() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="cc-tab-btn" onClick={() => { hapticTap(); setOpen(true); }} aria-label="Command centre">
        <div className="cc-tab-pill">
          {/* Apps / grid glyph — signals an action hub, not a single "add" */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="2"/>
            <rect x="14" y="3" width="7" height="7" rx="2"/>
            <rect x="3" y="14" width="7" height="7" rx="2"/>
            <rect x="14" y="14" width="7" height="7" rx="2"/>
          </svg>
        </div>
      </button>

      {open && ReactDOM.createPortal(
        <CommandCentreSheet onClose={() => setOpen(false)} />,
        document.body,
      )}
    </>
  );
}
