/* ────────────────────────────────────────────────────────────────────
 * CommandCentre — the floating centre button in the TabBar.
 *
 * Tap the "+" pill to open a full-screen action sheet with two
 * sections: Create (all entry forms) and Browse (quick navigation).
 * Designed to replace the scattered quick-action row on the dashboard
 * and give every action a consistent, reachable home.
 * ──────────────────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';

const ACTIONS = [
  {
    section: 'Create',
    items: [
      {
        id: 'sale-new',
        label: 'New Sale Invoice',
        sub: 'Create a customer bill',
        route: '/sale/new',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <path d="M14 2v6h6M9 13h6M9 17h4"/>
          </svg>
        ),
        accent: '#0EAFCA',
        bg: 'rgba(14,175,202,0.12)',
      },
      {
        id: 'purchase-new',
        label: 'New Purchase',
        sub: 'Record a supplier bill',
        route: '/purchase/new',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
            <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>
          </svg>
        ),
        accent: '#B45309',
        bg: 'rgba(180,83,9,0.10)',
      },
      {
        id: 'receipt-new',
        label: 'Record Receipt',
        sub: 'Money in from a customer',
        route: '/receipt/new',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>
          </svg>
        ),
        accent: '#16A34A',
        bg: 'rgba(22,163,74,0.10)',
      },
      {
        id: 'payment-new',
        label: 'Record Payment',
        sub: 'Money out to a supplier',
        route: '/payment/new',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21V9M7 14l5-5 5 5"/><path d="M5 3h14"/>
          </svg>
        ),
        accent: '#DC2626',
        bg: 'rgba(220,38,38,0.10)',
      },
      {
        id: 'customer-new',
        label: 'Add Customer',
        sub: 'Create a new customer party',
        route: '/customer/new',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M19 8v6M22 11h-6"/>
          </svg>
        ),
        accent: '#7C3AED',
        bg: 'rgba(124,58,237,0.10)',
      },
      {
        id: 'supplier-new',
        label: 'Add Supplier',
        sub: 'Create a new supplier party',
        route: '/supplier/new',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/>
            <circle cx="5.5" cy="18.5" r="2.5"/>
            <circle cx="18.5" cy="18.5" r="2.5"/>
          </svg>
        ),
        accent: '#2D5A3D',
        bg: 'rgba(45,90,61,0.10)',
      },
    ],
  },
  {
    section: 'Browse',
    items: [
      {
        id: 'vouchers',
        label: 'All Vouchers',
        sub: 'Bills · receipts · payments',
        route: '/vouchers',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 19.5A2.5 2.5 0 0 1 4.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        ),
        accent: '#475569',
        bg: 'rgba(71,85,105,0.10)',
      },
      {
        id: 'outstanding',
        label: 'Outstanding',
        sub: 'Receivables · payables',
        route: '/outstanding',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
          </svg>
        ),
        accent: '#D97706',
        bg: 'rgba(217,119,6,0.10)',
      },
      {
        id: 'day-book',
        label: 'Day Book',
        sub: "Today's entries",
        route: '/day-book',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <path d="M16 2v4M8 2v4M3 10h18"/>
            <path d="M9 16l2 2 4-4"/>
          </svg>
        ),
        accent: '#0891B2',
        bg: 'rgba(8,145,178,0.10)',
      },
      {
        id: 'reports',
        label: 'Reports',
        sub: 'All financial reports',
        route: '/reports',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v18h18"/>
            <path d="M7 14l4-4 4 4 5-5"/>
          </svg>
        ),
        accent: '#0F766E',
        bg: 'rgba(15,118,110,0.10)',
      },
    ],
  },
];

function CommandCentreSheet({ onClose }) {
  const navigate = useNavigate();
  const sheetRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (route) => {
    onClose();
    setTimeout(() => navigate(route), 180);
  };

  return (
    <div className="cc-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="cc-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command centre"
      >
        <div className="cc-grab" />
        <div className="cc-head">
          <div className="cc-head-title">Quick <em>actions</em></div>
          <button className="cc-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="cc-body">
          {ACTIONS.map(({ section, items }) => (
            <div key={section} className="cc-section">
              <div className="cc-section-label">{section}</div>
              <div className="cc-grid">
                {items.map((item) => (
                  <button
                    key={item.id}
                    className="cc-item"
                    onClick={() => go(item.route)}
                  >
                    <div className="cc-item-icon" style={{ background: item.bg, color: item.accent }}>
                      {item.icon}
                    </div>
                    <div className="cc-item-label">{item.label}</div>
                    <div className="cc-item-sub">{item.sub}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .cc-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(10, 8, 6, 0.6);
          -webkit-backdrop-filter: blur(6px);
          backdrop-filter: blur(6px);
          z-index: 2000;
          display: flex;
          align-items: flex-end;
          justify-content: center;
          animation: ccFadeIn 200ms ease-out;
        }
        @keyframes ccFadeIn { from { opacity: 0; } to { opacity: 1; } }

        .cc-sheet {
          background: var(--c-bg-surface);
          border-radius: 26px 26px 0 0;
          box-shadow: 0 -12px 48px rgba(0,0,0,0.22);
          width: 100%;
          max-width: 540px;
          max-height: 88vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          animation: ccRise 320ms cubic-bezier(0.32, 0.72, 0, 1);
        }
        @keyframes ccRise {
          from { transform: translateY(100%); }
          to   { transform: translateY(0); }
        }

        .cc-grab {
          width: 36px; height: 4px;
          border-radius: 2px;
          background: var(--c-border);
          margin: 10px auto 0;
          flex-shrink: 0;
        }

        .cc-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 20px 8px;
          flex-shrink: 0;
        }
        .cc-head-title {
          font-size: 22px;
          font-weight: 400;
          letter-spacing: -0.03em;
          color: var(--c-text);
        }
        .cc-head-title em { font-style: italic; font-weight: 300; }
        .cc-close {
          width: 32px; height: 32px;
          border-radius: 50%;
          background: var(--c-bg-page);
          border: 1px solid var(--c-border);
          display: flex; align-items: center; justify-content: center;
          color: var(--c-text-mute);
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }
        .cc-close:active { background: var(--c-bg-app); }

        .cc-body {
          flex: 1;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 8px 16px calc(env(safe-area-inset-bottom, 0px) + 28px);
          scrollbar-width: none;
        }
        .cc-body::-webkit-scrollbar { display: none; }

        .cc-section { margin-bottom: 20px; }
        .cc-section-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--c-text-mute);
          padding: 4px 4px 10px;
        }

        .cc-grid {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 10px;
        }

        .cc-item {
          background: var(--c-bg-surface);
          border: 1px solid var(--c-border);
          border-radius: 16px;
          padding: 14px 12px 12px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
          cursor: pointer;
          text-align: left;
          font-family: inherit;
          color: inherit;
          -webkit-tap-highlight-color: transparent;
          transition: transform 120ms, box-shadow 120ms;
        }
        .cc-item:active {
          transform: scale(0.96);
          box-shadow: 0 2px 12px rgba(0,0,0,0.08);
        }

        .cc-item-icon {
          width: 40px; height: 40px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .cc-item-label {
          font-size: 12px;
          font-weight: 600;
          color: var(--c-text);
          letter-spacing: -0.01em;
          line-height: 1.25;
        }

        .cc-item-sub {
          font-size: 10px;
          color: var(--c-text-mute);
          letter-spacing: 0.01em;
          line-height: 1.3;
        }
      `}</style>
    </div>
  );
}

export default function CommandCentre() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Floating "+" tab button — rendered inline in the TabBar */}
      <button
        className="cc-tab-btn"
        onClick={() => setOpen(true)}
        aria-label="Command centre"
      >
        <div className="cc-tab-pill">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14"/>
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
