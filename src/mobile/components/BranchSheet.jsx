import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { Toast, Dialog } from 'antd-mobile';
import { getServerUrl } from '../../api';
import { fetchSites, getCachedSites, switchToSite } from '../utils/branches';
import './BranchSheet.css';

/**
 * Branch picker.
 *
 * Switching branch re-points the app at that shop's own server, so it is a
 * heavier action than it looks — the confirm step exists because a user who
 * bills into the wrong branch has written to the wrong company's books, and
 * that is not something an undo button can fix.
 */

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export default function BranchSheet({ open, onClose }) {
  const [sites, setSites] = useState(getCachedSites());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const current = getServerUrl();

  useEffect(() => {
    if (!open) return;
    setLoading(true); setError('');
    fetchSites()
      .then(({ sites: list, crossBranch }) => {
        setSites(list);
        if (!crossBranch && list.length <= 1) {
          setError('Your licence covers one branch. Ask about multi-branch to add more.');
        }
      })
      .catch((e) => setError(e.message || 'Could not load your branches.'))
      .finally(() => setLoading(false));
  }, [open]);

  async function pick(site) {
    if (`https://${site.hostname}` === current) { onClose?.(); return; }
    const ok = await Dialog.confirm({
      title: `Switch to ${site.name || site.hostname}?`,
      content: 'The app will reload and show that branch’s data. Anything you have not saved here will be lost.',
      confirmText: 'Switch',
    });
    if (!ok) return;
    if (switchToSite(site)) {
      Toast.show({ icon: 'loading', content: 'Switching branch…', duration: 900 });
      setTimeout(() => window.location.reload(), 400);
    }
  }

  if (!open) return null;

  return ReactDOM.createPortal(
    <div className="br-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="br-sheet" role="dialog" aria-label="Branches">
        <div className="br-grab" aria-hidden />
        <div className="br-head">
          <h2 className="br-title">Branches</h2>
          <button className="br-close" onClick={onClose}>Done</button>
        </div>

        {loading && sites.length === 0 && <div className="br-msg">Loading your branches…</div>}
        {error && <div className="br-msg br-msg--warn">{error}</div>}

        <div className="br-list">
          {sites.map((s) => {
            const active = `https://${s.hostname}` === current;
            return (
              <button
                key={s.site_id}
                className={`br-row${active ? ' br-row--active' : ''}`}
                onClick={() => pick(s)}
              >
                <span className="br-avatar">{(s.name || 'B').trim().charAt(0).toUpperCase()}</span>
                <span className="br-info">
                  <span className="br-name">{s.name || s.hostname}</span>
                  <span className="br-host">{s.hostname}</span>
                </span>
                {active && <span className="br-check"><CheckIcon /></span>}
              </button>
            );
          })}
          {!loading && !sites.length && !error && (
            <div className="br-msg">No branches available for this phone yet.</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
