import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { authAPI, companyAPI, setServerUrl as saveServerUrl, getServerUrl } from '../../api';
import useAuthStore from '../../store/authStore';
import CompanySheet from '../components/CompanySheet';
import ServerDialog from '../components/ServerDialog';
import './Login.css';

const LAST_COMPANY_KEY      = 'zehen_last_company';
const LAST_COMPANY_NAME_KEY = 'zehen_last_company_name';

// Inline icons keep the bundle small (no icon-lib import) and match the
// editorial stroke weight (1.7) consistently across the form.
const UserIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);
const LockIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const EyeIcon = ({ open }) => (
  open ? (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
);
const ChevronIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);
const ArrowIcon = () => (
  <svg className="login-signin-arrow" width="15" height="15" viewBox="0 0 24 24"
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

function pickInitialCompany(list, lastUsedId) {
  return lastUsedId && list.find((c) => c.company_id === lastUsedId)
    ? lastUsedId
    : (list[0]?.company_id ?? null);
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

  // Connection state drives the subtle status pill under the wordmark.
  const [conn, setConn] = useState('checking'); // 'checking' | 'online' | 'offline'

  // Hidden server config — revealed by tapping the wordmark 3×.
  const [serverOpen, setServerOpen] = useState(false);
  const tapRef = useRef({ count: 0, timer: null });

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
  // license gate exempts companies/list-public so a fresh install can render).
  useEffect(() => {
    let cancelled = false;
    companyAPI.listPublic()
      .then((res) => {
        if (cancelled) return;
        const list = normalizeCompanies(res.data, lastUsedId);
        setCompanies(list);
        setSelectedCompanyId(pickInitialCompany(list, lastUsedId));
        setConn('online');
      })
      .catch(() => {
        if (cancelled) return;
        setConn('offline');
        // Fresh install with no server yet → surface the (otherwise hidden)
        // config dialog so the app isn't a dead end. Once a server has ever
        // been saved, stay hidden and rely on the 3-tap gesture.
        if (!getServerUrl()) setServerOpen(true);
      });
    return () => { cancelled = true; };
  }, [lastUsedId]);

  const selectedCompany = companies.find((c) => c.company_id === selectedCompanyId);

  // Secret entry point: three taps on the wordmark (within 800ms of each
  // other) open the server dialog. Counter lives in a ref so taps don't
  // trigger re-renders.
  function handleWordmarkTap() {
    const t = tapRef.current;
    if (t.timer) clearTimeout(t.timer);
    t.count += 1;
    if (t.count >= 3) {
      t.count = 0;
      setServerOpen(true);
      return;
    }
    t.timer = setTimeout(() => { t.count = 0; }, 800);
  }

  // Owned by the parent: the dialog calls this with a normalized origin and
  // we do the reachability check + persistence. Throws on failure so the
  // dialog can show an inline error.
  async function connectToServer(url) {
    const res = await fetch(`${url}/api/companies/list-public`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    saveServerUrl(url);
    const list = normalizeCompanies(json, lastUsedId);
    setCompanies(list);
    setSelectedCompanyId(pickInitialCompany(list, lastUsedId));
    setConn('online');
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

  const connLabel = conn === 'online' ? 'Connected' : conn === 'offline' ? 'Offline' : 'Connecting…';
  const hasFirms = companies.length > 0;

  return (
    <div className="login-screen">
      <form className="login-content" onSubmit={onSubmit} noValidate>
        {/* Brand — secret 3-tap trigger reveals the server dialog */}
        <div className="login-brand" onClick={handleWordmarkTap} role="button" tabIndex={-1}>
          <div className="login-brand-mark" aria-hidden />
          <div className="login-brand-word">
            ZEHEN
          </div>
          <span className={`login-status login-status--${conn}`}>
            <span className="login-status-dot" />
            {connLabel}
          </span>
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

        {/* Grouped form card */}
        <div className="login-card">
          {/* Company / firm context */}
          <button
            type="button"
            className="login-firm"
            onClick={() => hasFirms && setSheetOpen(true)}
            disabled={!hasFirms}
          >
            <span className="login-firm-avatar">
              {(selectedCompany?.company_name || '?').trim().charAt(0).toUpperCase()}
            </span>
            <span className="login-firm-info">
              <span className="login-firm-label">Company</span>
              <span className="login-firm-name">
                {selectedCompany?.company_name || (conn === 'offline' ? 'No server connected' : 'No firm yet')}
              </span>
            </span>
            {hasFirms && companies.length > 1 && (
              <span className="login-firm-count">{companies.length}</span>
            )}
            <span className="login-firm-chevron"><ChevronIcon /></span>
          </button>

          <div className="login-divider" />

          {/* Username */}
          <div className="login-row">
            <span className="login-row-icon"><UserIcon /></span>
            <input
              className="login-row-input"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
            />
          </div>

          <div className="login-divider" />

          {/* Password */}
          <div className="login-row">
            <span className="login-row-icon"><LockIcon /></span>
            <input
              className="login-row-input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
            <button
              type="button"
              className="login-row-eye"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              <EyeIcon open={showPassword} />
            </button>
          </div>
        </div>

        <button type="submit" className="login-signin" disabled={submitting}>
          {submitting ? <span className="login-spinner" /> : <>Sign in <ArrowIcon /></>}
        </button>

        <button
          type="button"
          className="login-forgot"
          onClick={() => Toast.show({ icon: 'success', content: 'Ask the admin to reset it' })}
        >
          Forgot password?
        </button>

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

      <ServerDialog
        open={serverOpen}
        initialUrl={getServerUrl()}
        onConnect={connectToServer}
        onClose={() => setServerOpen(false)}
      />
    </div>
  );
}
