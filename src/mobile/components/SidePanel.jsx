import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { activeCompanyName, userContactLine } from '../utils/identity';
import BranchSheet from './BranchSheet';
import CompanySwitchSheet from './CompanySwitchSheet';
import { Toast } from 'antd-mobile';
import useAuthStore from '../../store/authStore';
import useThemeStore from '../../store/themeStore';
import useCompanyStore from '../../store/companyStore';
import { companyAPI, setServerUrl as saveServerUrl, getServerUrl, getDeviceToken } from '../../api';
import './SidePanel.css';

const I = {
  swap: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3l4 4-4 4M20 7H8M8 21l-4-4 4-4M4 17h12"/>
    </svg>
  ),
  cal: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <path d="M16 2v4M8 2v4M3 10h18"/>
    </svg>
  ),
  user: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/>
      <path d="M4 21v-1a7 7 0 0 1 14 0v1"/>
    </svg>
  ),
  gst: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
      <path d="M3 5c0-1.66 4-3 9-3s9 1.34 9 3-4 3-9 3-9-1.34-9-3z"/>
    </svg>
  ),
  bell: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
    </svg>
  ),
  sync: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  ),
  help: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>
    </svg>
  ),
  info: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16v-4M12 8h.01"/>
      <circle cx="12" cy="12" r="10"/>
    </svg>
  ),
  signout: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <path d="M16 17l5-5-5-5M21 12H9"/>
    </svg>
  ),
  chev: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6"/>
    </svg>
  ),
  sun: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
    </svg>
  ),
  moon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  ),
  auto: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 3v18"/>
      <path d="M12 3a9 9 0 0 1 0 18" fill="currentColor"/>
    </svg>
  ),
  close: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>
  ),
  server: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
      <line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
    </svg>
  ),
  classic: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3"/>
      <path d="M3 9h18M9 3v18"/>
    </svg>
  ),
  editorial: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16v16H4z"/>
      <path d="M4 10h16M12 4v6"/>
    </svg>
  ),
};

function fyLabel() {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    label: `FY ${y}–${String(y + 1).slice(2)}`,
    range: `Apr 1, ${y} — Mar 31, ${y + 1}`,
  };
}

export default function SidePanel({ open, onClose }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const themeStyle = useThemeStore((s) => s.themeStyle);
  const setThemeStyle = useThemeStore((s) => s.setThemeStyle);
  const appearance = useThemeStore((s) => s.appearance);
  const setAppearance = useThemeStore((s) => s.setAppearance);
  const companyList = useCompanyStore((s) => s.list);
  const currentCompany = useCompanyStore((s) => s.getCurrent());
  const setCompanyList = useCompanyStore((s) => s.setList);

  const [closing, setClosing] = useState(false);
  const [serverOpen,  setServerOpen]  = useState(false);
  const [branchOpen,  setBranchOpen]  = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [serverUrl,   setServerUrlVal] = useState(() => getServerUrl());

  function handleSaveServer() {
    const url = serverUrl.trim().replace(/\/+$/, '');
    if (!url) return;
    saveServerUrl(url);
    Toast.show({ icon: 'success', content: 'Saved — reloading…' });
    setTimeout(() => window.location.reload(), 700);
  }

  useEffect(() => {
    if (open && companyList.length === 0) {
      companyAPI.listPublic().then((res) => {
        const rows = res.data?.data || res.data || [];
        if (rows.length) setCompanyList(rows);
      }).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  function animateClose() {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onClose();
    }, 280);
  }

  function handleSignOut() {
    animateClose();
    setTimeout(() => {
      logout();
      navigate('/login', { replace: true });
    }, 300);
  }

  if (!open && !closing) return null;

  // Resolves through the companies this sign-in actually returned, so a
  // single-company install shows its real name instead of "My Company".
  const companyName = activeCompanyName(currentCompany, user) || 'Company';

  const companyInitial = (companyName || '?').trim().charAt(0).toUpperCase();
  const gstin = currentCompany?.gstin || user?.gstin || '';
  const city = currentCompany?.city || user?.company_city || '';
  const firmMeta = [gstin, city].filter(Boolean).join(' · ') || '—';
  const userName = user?.full_name || user?.username || 'User';
  const userInitial = userName.trim().charAt(0).toUpperCase();
  // Their real email/phone, or their role — never a fabricated address.
  const userEmail = userContactLine(user);
  const userRole = user?.role || 'Owner';
  const fy = fyLabel();
  const firmCount = companyList.length || 1;

  const styleOptions = [
    { key: 'classic', label: 'Classic', icon: I.classic },
    { key: 'modern', label: 'Editorial', icon: I.editorial },
  ];

  const themeOptions = [
    { key: 'light', label: 'Light', icon: I.sun },
    { key: 'dark', label: 'Dark', icon: I.moon },
    { key: 'system', label: 'Auto', icon: I.auto },
  ];

  return (
    <>
      <div
        className={`sp-scrim${closing ? ' sp-closing' : ''}`}
        onClick={animateClose}
      />
      <div className={`sp-drawer${closing ? ' sp-closing' : ''}`}>
        {/* Sticky header — stays fixed, content scrolls under */}
        <div className="sp-header">
          <div className="sp-user">
            <div className="sp-avatar">{userInitial}</div>
            <div className="sp-user-info">
              <div className="sp-user-name">{userName}</div>
              <div className="sp-user-meta">
                <span className="sp-role-pill">{userRole}</span>
                {userEmail}
              </div>
            </div>
            <button className="sp-close-btn" onClick={animateClose} aria-label="Close panel">
              {I.close}
            </button>
          </div>
        </div>

        <div className="sp-content">
          {/* Firm card */}
          <div className="sp-firm">
            <div className="sp-firm-top">
              <div className="sp-firm-avatar">{companyInitial}</div>
              <div className="sp-firm-info">
                <div className="sp-firm-name">{companyName}</div>
                <div className="sp-firm-meta">{firmMeta}</div>
              </div>
            </div>
            {firmCount > 1 && (
              <button className="sp-firm-switch" onClick={() => { setCompanyOpen(true); }}>
                {I.swap}
                Switch firm
                <span className="sp-firm-count">{firmCount} available</span>
              </button>
            )}
          </div>

          {/* Data context */}
          <div className="sp-section-label">Data context</div>
          <button
            className="sp-ctx-card"
            onClick={() => Toast.show({ content: 'FY selection coming soon', position: 'bottom' })}
          >
            <div className="sp-ctx-icon">{I.cal}</div>
            <div className="sp-ctx-info">
              <div className="sp-ctx-label">Financial year</div>
              <div className="sp-ctx-value">{fy.label}</div>
              <div className="sp-ctx-sub">{fy.range}</div>
            </div>
            <div className="sp-ctx-chev">{I.chev}</div>
          </button>

          {/* Style */}
          <div className="sp-section-label">Style</div>
          <div className="sp-theme-seg sp-theme-seg-2">
            {styleOptions.map((s) => (
              <button
                key={s.key}
                className={`sp-theme-opt${themeStyle === s.key ? ' active' : ''}`}
                onClick={() => setThemeStyle(s.key)}
              >
                {s.icon}
                {s.label}
              </button>
            ))}
          </div>

          {/* Appearance */}
          <div className="sp-section-label">Appearance</div>
          <div className="sp-theme-seg">
            {themeOptions.map((t) => (
              <button
                key={t.key}
                className={`sp-theme-opt${appearance === t.key ? ' active' : ''}`}
                onClick={() => setAppearance(t.key)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {/* Server connection */}
          <div className="sp-section-label">Connection</div>
          <div className="sp-nav-list">
            {/* Only meaningful once this phone is paired — an unpaired phone
                belongs to no org, so it has no other branches to switch to. */}
            {getDeviceToken() && (
              <button className="sp-nav-row" onClick={() => setBranchOpen(true)}>
                <div className="sp-nav-icon">{I.server}</div>
                <span className="sp-nav-label">Branches</span>
                <div className="sp-nav-chev">{I.chev}</div>
              </button>
            )}
            <button
              className={`sp-nav-row${serverOpen ? ' sp-nav-row-open' : ''}`}
              onClick={() => setServerOpen((v) => !v)}
            >
              <div className="sp-nav-icon">{I.server}</div>
              <span className="sp-nav-label">Server</span>
              <span className="sp-server-url-hint">{getServerUrl() ? getServerUrl().replace(/^https?:\/\//, '') : 'not set'}</span>
              <div className="sp-nav-chev">{I.chev}</div>
            </button>
            {serverOpen && (
              <div className="sp-server-body">
                <input
                  className="sp-server-input"
                  type="url"
                  placeholder="http://192.168.x.x:3001"
                  value={serverUrl}
                  onChange={(e) => setServerUrlVal(e.target.value)}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck="false"
                />
                <button
                  className="sp-server-btn"
                  onClick={handleSaveServer}
                  disabled={!serverUrl.trim()}
                >
                  Save &amp; Reload
                </button>
              </div>
            )}
          </div>

          {/* Settings */}
          <div className="sp-section-label">Settings</div>
          <div className="sp-nav-list">
            <button className="sp-nav-row" onClick={() => { animateClose(); }}>
              <div className="sp-nav-icon">{I.user}</div>
              <span className="sp-nav-label">Profile & preferences</span>
              <div className="sp-nav-chev">{I.chev}</div>
            </button>
            <button className="sp-nav-row" onClick={() => { animateClose(); }}>
              <div className="sp-nav-icon">{I.gst}</div>
              <span className="sp-nav-label">GST & tax setup</span>
              <div className="sp-nav-chev">{I.chev}</div>
            </button>
            <button className="sp-nav-row" onClick={() => { animateClose(); }}>
              <div className="sp-nav-icon">{I.bell}</div>
              <span className="sp-nav-label">Notifications</span>
              <div className="sp-nav-chev">{I.chev}</div>
            </button>
            <button className="sp-nav-row" onClick={() => { animateClose(); }}>
              <div className="sp-nav-icon">{I.sync}</div>
              <span className="sp-nav-label">Backup & sync</span>
              <div className="sp-nav-chev">{I.chev}</div>
            </button>
          </div>

          {/* Help */}
          <div className="sp-section-label">Help</div>
          <div className="sp-nav-list">
            <button className="sp-nav-row" onClick={() => { animateClose(); }}>
              <div className="sp-nav-icon">{I.help}</div>
              <span className="sp-nav-label">Help & support</span>
              <div className="sp-nav-chev">{I.chev}</div>
            </button>
            <button className="sp-nav-row" onClick={() => { animateClose(); }}>
              <div className="sp-nav-icon">{I.info}</div>
              <span className="sp-nav-label">About ZEHEN</span>
              <div className="sp-nav-chev">{I.chev}</div>
            </button>
          </div>

          {/* Sign out */}
          <div className="sp-footer">
            <button className="sp-signout" onClick={handleSignOut}>
              <div className="sp-signout-icon">{I.signout}</div>
              <span className="sp-signout-label">Sign out</span>
              <span className="sp-signout-hint">this device</span>
            </button>
            <div className="sp-footer-line">
              <span className="sp-version">v0.1.0 <span className="sp-acc">·</span> ZEHEN</span>
              <span className="sp-sync-status">
                <span className="sp-sync-dot" />
                synced
              </span>
            </div>
          </div>
        </div>
      </div>
          <BranchSheet open={branchOpen} onClose={() => setBranchOpen(false)} />
          <CompanySwitchSheet open={companyOpen} onClose={() => setCompanyOpen(false)} />
    </>
  );
}
