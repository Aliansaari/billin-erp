import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { authAPI, companyAPI, setServerUrl as saveServerUrl, getServerUrl, probeServer } from '../../api';
import useAuthStore from '../../store/authStore';
import CompanySheet from '../components/CompanySheet';
import './Login.css';

const LAST_COMPANY_KEY      = 'billing_erp_last_company';
const LAST_COMPANY_NAME_KEY = 'billing_erp_last_company_name';

// Inline icons keep bundle small (no icon-lib import) and match the editorial
// stroke weight (1.7) consistently across all three fields.
const UserIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);
const LockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const EyeIcon = ({ open }) => (
  open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
);
const ChevronIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const ArrowIcon = () => (
  <svg className="login-signin-arrow" width="14" height="14" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" strokeWidth="2.5"
       strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
const SparkIcon = () => (
  <svg className="login-hint-spark" width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0L13.5 8.5 22 10 13.5 11.5 12 20 10.5 11.5 2 10 10.5 8.5z" />
  </svg>
);
const ServerIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2"/>
    <rect x="2" y="14" width="20" height="8" rx="2"/>
    <line x1="6" y1="6" x2="6.01" y2="6"/>
    <line x1="6" y1="18" x2="6.01" y2="18"/>
  </svg>
);

// Map server-side companyAPI.listPublic shape into what CompanySheet expects.
// The endpoint wraps the list in { data: [...] } and ships minimal metadata
// pre-login (company_id, name, accent_color, is_primary). We accept both
// `name` and `company_name`, and treat missing fields as graceful defaults
// rather than blanking the row.
function normalizeCompanies(payload, lastUsedId) {
  const rows = Array.isArray(payload) ? payload : (payload?.data || []);
  return rows.map((c) => ({
    company_id:    c.company_id,
    company_name:  c.company_name || c.name || `Company ${c.company_id}`,
    gstin:         c.gstin || '',
    city:          c.city || '',
    role:          c.is_primary ? 'Primary' : (c.role || ''),
    accent_color:  c.accent_color || '',
    is_last_used:  lastUsedId && c.company_id === lastUsedId,
  }));
}

export default function Login() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const usernameRef = useRef(null);

  const [serverOpen,   setServerOpen]   = useState(false);
  const [serverUrl,    setServerUrlVal] = useState(() => getServerUrl());
  const [serverStatus, setServerStatus] = useState(null); // null | 'testing' | 'ok' | 'err'
  const [serverErrMsg, setServerErrMsg] = useState('');

  // Pull the last-used company id (saved post-login) so we can pre-select
  // it on next launch — saves a tap for the common single-firm case.
  const lastUsedId = useMemo(() => {
    try {
      const raw = localStorage.getItem(LAST_COMPANY_KEY);
      const n = raw ? Number(raw) : null;
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  }, []);

  // Fetch companies once on mount. listPublic doesn't require auth (the
  // license gate already exempts companies/list-public so a fresh install
  // can even render this).
  useEffect(() => {
    let cancelled = false;
    companyAPI.listPublic()
      .then((res) => {
        if (cancelled) return;
        const list = normalizeCompanies(res.data, lastUsedId);
        setCompanies(list);
        const initial = lastUsedId && list.find((c) => c.company_id === lastUsedId)
          ? lastUsedId
          : (list[0]?.company_id ?? null);
        setSelectedCompanyId(initial);
      })
      .catch(() => {
        setServerOpen(true); // auto-expand server config when fetch fails (likely wrong URL)
      });
  }, [lastUsedId]);

  const selectedCompany = companies.find((c) => c.company_id === selectedCompanyId);

  async function handleTestServer() {
    const url = serverUrl.trim().replace(/\/+$/, '');
    if (!url) return;
    setServerStatus('testing');
    setServerErrMsg('');
    try {
      await probeServer(url);
      setServerStatus('ok');
      saveServerUrl(url);
      setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      setServerStatus('err');
      setServerErrMsg(e?.message || 'Could not reach server');
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    if (!username.trim() || !password) {
      Toast.show({ icon: 'fail', content: 'Username and password required' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await authAPI.login({
        username: username.trim(),
        password,
        company_id: selectedCompanyId || undefined,
      });
      const { user, token, must_change_password } = res.data || {};
      if (!user || !token) throw new Error('Bad login response');
      try {
        if (selectedCompanyId) localStorage.setItem(LAST_COMPANY_KEY, String(selectedCompanyId));
        // Save the picked company's display name so the dashboard greeting
        // and avatar can render without an extra API round-trip on next launch.
        const picked = companies.find((c) => c.company_id === selectedCompanyId);
        if (picked?.company_name) localStorage.setItem(LAST_COMPANY_NAME_KEY, picked.company_name);
      } catch {}
      login(user, token, !!must_change_password);
      navigate('/', { replace: true });
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Login failed';
      Toast.show({ icon: 'fail', content: msg });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-content" onSubmit={onSubmit} noValidate>
        {/* Wordmark */}
        <div className="wordmark">
          <div className="wordmark-mark" aria-hidden />
          <div className="wordmark-text">
            billin<span className="wm-dot">·</span>erp
            <span className="wm-version">v0.1</span>
          </div>
        </div>

        {/* Hero */}
        <div className="login-hero">
          <h1>Welcome <em>back.</em></h1>
          <p>Sign in to continue to your firm.</p>
        </div>

        {/* Editorial rule */}
        <div className="editorial-rule" aria-hidden>
          <div className="editorial-rule-line" />
          <div className="editorial-rule-mark" />
          <div className="editorial-rule-line" />
        </div>

        {/* Form */}
        <div className="login-form">
          {/* Username */}
          <div className="login-field">
            <div className="login-field-head">
              <span className="login-field-label">Username</span>
            </div>
            <label className="login-input">
              <span className="login-input-icon"><UserIcon /></span>
              <input
                ref={usernameRef}
                className="login-input-text"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
              />
            </label>
          </div>

          {/* Password */}
          <div className="login-field">
            <div className="login-field-head">
              <span className="login-field-label">Password</span>
              <button
                type="button"
                className="login-field-meta"
                onClick={() => Toast.show({ icon: 'success', content: 'Ask the admin to reset it' })}
              >
                Forgot?
              </button>
            </div>
            <label className="login-input">
              <span className="login-input-icon"><LockIcon /></span>
              <input
                className="login-input-text"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
              <button
                type="button"
                className="login-input-eye"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                <EyeIcon open={showPassword} />
              </button>
            </label>
          </div>

          {/* Company selector */}
          <div className="login-field">
            <div className="login-field-head">
              <span className="login-field-label">Company</span>
              <span className="login-field-meta" style={{ pointerEvents: 'none' }}>
                {companies.length ? `${companies.length} firm${companies.length === 1 ? '' : 's'}` : '—'}
              </span>
            </div>
            <button
              type="button"
              className="login-company"
              onClick={() => companies.length > 0 && setSheetOpen(true)}
              disabled={companies.length === 0}
            >
              <span className="login-company-avatar">
                {(selectedCompany?.company_name || '?').trim().charAt(0).toUpperCase()}
              </span>
              <span className="login-company-info">
                <span className="login-company-name">
                  {selectedCompany?.company_name || 'No firm yet'}
                </span>
                <span className="login-company-meta">
                  {selectedCompany
                    ? ([selectedCompany.gstin, selectedCompany.city].filter(Boolean).join(' · ') || 'No metadata')
                    : 'Tap to choose once available'}
                </span>
              </span>
              <span className="login-company-chevron"><ChevronIcon /></span>
            </button>
          </div>

          <button type="submit" className="login-signin" disabled={submitting}>
            {submitting ? <span className="login-spinner" /> : <>Sign in <ArrowIcon /></>}
          </button>
        </div>

        {/* Server config */}
        <div className="login-server">
          <button
            type="button"
            className={`login-server-toggle${serverOpen ? ' active' : ''}`}
            onClick={() => setServerOpen((v) => !v)}
          >
            <ServerIcon />
            <span>Server setup</span>
            <span className="login-server-chevron">{serverOpen ? '▲' : '▼'}</span>
          </button>
          {serverOpen && (
            <div className="login-server-body">
              <div className="login-server-desc">
                Enter your server's LAN address so the app can reach the database.
              </div>
              <div className="login-server-row">
                <label className="login-input login-server-input">
                  <input
                    type="url"
                    className="login-input-text"
                    placeholder="http://192.168.x.x:3001"
                    value={serverUrl}
                    onChange={(e) => { setServerUrlVal(e.target.value); setServerStatus(null); }}
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck="false"
                  />
                </label>
                <button
                  type="button"
                  className={`login-server-btn${serverStatus === 'ok' ? ' ok' : ''}`}
                  onClick={handleTestServer}
                  disabled={serverStatus === 'testing' || serverStatus === 'ok'}
                >
                  {serverStatus === 'testing'
                    ? <span className="login-spinner" style={{ width: 12, height: 12 }} />
                    : serverStatus === 'ok' ? '✓' : 'Connect'}
                </button>
              </div>
              {serverStatus === 'err' && (
                <div className="login-server-err">{serverErrMsg}</div>
              )}
              {serverStatus === 'ok' && (
                <div className="login-server-ok">Connected — reloading…</div>
              )}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="login-hint">
          <SparkIcon />
          <span>
            First time? Try{' '}
            <span className="login-kbd">admin</span>{' '}
            <span className="login-kbd">admin123</span>
          </span>
        </div>
      </form>

      <CompanySheet
        open={sheetOpen}
        companies={companies}
        selectedId={selectedCompanyId}
        onSelect={(id) => setSelectedCompanyId(id)}
        onConfirm={() => setSheetOpen(false)}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  );
}
