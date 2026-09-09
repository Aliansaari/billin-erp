import React, { useEffect, useState } from 'react';
import { select as hapticSelect, warn as hapticWarn } from '../utils/haptics';
import ReactDOM from 'react-dom';
import { Toast, Dialog } from 'antd-mobile';
import api, { beginCompanySwitch, endCompanySwitch } from '../../api';
import useAuthStore from '../../store/authStore';
import './CompanySwitchSheet.css';

/**
 * Company switcher.
 *
 * A ZEHEN installation can hold several companies, each with its own books.
 * The app used to sign in to whichever one came first and give no way out —
 * so a shop running two firms could only ever see one of them on the phone.
 *
 * Switching re-issues the session against the other company's database. The
 * old token is retired server-side, so nothing from the previous company's
 * session survives the switch.
 */

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

function readCompanies() {
  try { return JSON.parse(localStorage.getItem('zehen_companies') || '[]'); } catch { return []; }
}
function readCurrentId() {
  const raw = Number(localStorage.getItem('zehen_company_id'));
  return Number.isFinite(raw) ? raw : null;
}

export default function CompanySwitchSheet({ open, onClose }) {
  const [companies, setCompanies] = useState(readCompanies());
  const [current, setCurrent] = useState(readCurrentId());
  const [switching, setSwitching] = useState(null);   // the company being opened
  const setAuth = useAuthStore((s) => s.login);

  useEffect(() => {
    if (!open) return;
    setCompanies(readCompanies());
    setCurrent(readCurrentId());
  }, [open]);

  async function pick(c) {
    if (c.company_id === current || switching) { onClose?.(); return; }
    const ok = await Dialog.confirm({
      title: `Switch to ${c.name}?`,
      content: 'The app will reopen on that company’s books. Anything unsaved here will be lost.',
      confirmText: 'Switch',
      cancelText: 'Cancel',
    });
    if (!ok) return;

    // Cover the screen for the whole switch. The sheet used to stay open and
    // interactive while the request ran, which read as a frozen dialog.
    hapticSelect();
    setSwitching(c);
    beginCompanySwitch();
    try {
      const { data } = await api.post('/auth/sso-switch', { company_id: c.company_id });
      if (!data?.token) throw new Error('Switch failed');

      localStorage.setItem('zehen_company_id', String(data.company_id));
      localStorage.setItem('zehen_last_company_name', c.name || '');
      setAuth(data.user, data.token, false);

      // Hard navigation to the root, not reload(), and with no artificial
      // delay. Two reasons: a reload would land back on the CURRENT route,
      // which may be a bill that only exists in the company we just left; and
      // every extra millisecond here is a window where an in-flight request
      // carrying the retired token can come back 401.
      window.location.replace('/');
    } catch (e) {
      endCompanySwitch();
      setSwitching(null);
      hapticWarn();
      Toast.show({
        icon: 'fail',
        content: e?.response?.data?.error || e?.message || 'Could not switch company.',
      });
    }
  }

  if (!open) return null;

  if (switching) {
    return ReactDOM.createPortal(
      <div className="cs-switching" role="status" aria-live="polite">
        <span className="cs-spinner" aria-hidden />
        <div className="cs-switching-text">Opening {switching.name}…</div>
      </div>,
      document.body,
    );
  }

  return ReactDOM.createPortal(
    <div className="cs-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="cs-sheet" role="dialog" aria-label="Companies">
        <div className="cs-grab" aria-hidden />
        <div className="cs-head">
          <h2 className="cs-title">Companies</h2>
          <button className="cs-close" onClick={onClose}>Done</button>
        </div>

        <div className="cs-list">
          {companies.map((c) => {
            const active = c.company_id === current;
            return (
              <button key={c.company_id}
                      className={`cs-row${active ? ' cs-row--active' : ''}`}
                      disabled={!!switching}
                      onClick={() => pick(c)}>
                <span className="cs-avatar" style={c.accent_color ? { background: c.accent_color } : undefined}>
                  {(c.name || '?').trim().charAt(0).toUpperCase()}
                </span>
                <span className="cs-info">
                  <span className="cs-name">{c.name}</span>
                  {c.is_primary && <span className="cs-tag">Primary</span>}
                </span>
                {active && <span className="cs-check"><CheckIcon /></span>}
              </button>
            );
          })}
          {companies.length <= 1 && (
            <div className="cs-msg">
              This sign-in can open one company. If your shop has more, ask your
              admin to make sure your user exists in them too.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
