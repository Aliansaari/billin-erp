import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import axios from 'axios';
import { setServerUrl, setDeviceToken, getServerUrl } from '../../api';
import useAuthStore from '../../store/authStore';
import { ZehenMark } from '../../components/ZehenLogo';
import ServerDialog from '../components/ServerDialog';
import { controlPlaneUrl, installId } from '../utils/controlPlane';
import { refreshCompanyProfile } from '../utils/companyProfile';
import { fetchSnapshot, snapshotAge } from '../utils/offlineSnapshot';
import useKeyboardInset from '../hooks/useKeyboardInset';
import './Login.css';

/**
 * Sign in.
 *
 * One email-or-phone and one password, from anywhere. The app does not ask
 * which shop, and it does not ask for a server address — the previous version
 * required the user to type their shop PC's LAN IP, which only worked on the
 * shop's own Wi-Fi and was the single most confusing step in setup.
 *
 * The flow:
 *   1. Credentials go to the ZEHEN account service, which knows which shop
 *      this person belongs to.
 *   2. It returns that shop's address, a token for this device, and a
 *      short-lived signed assertion.
 *   3. We hand the assertion to the shop's own server, which issues the
 *      normal ZEHEN session. The shop server still decides permissions.
 *
 * Advanced users can still pin a specific server by hand — that lives in
 * Settings, not here, because it is a recovery tool and not part of signing
 * in.
 */

const MailIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2.5" />
    <path d="M2.5 7l9.5 6 9.5-6" />
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
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
);
const ArrowIcon = () => (
  <svg className="login-signin-arrow" width="15" height="15" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" strokeWidth="2.5"
       strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

/**
 * Did this failure mean "the shop computer is not reachable"?
 *
 * Only transport-level failures and gateway errors count. A 401/403 means the
 * server answered and rejected us — dropping into offline mode there would
 * hide a real problem behind stale figures.
 */
function isShopUnreachable(err) {
  const status = err?.response?.status;
  if (status && ![502, 503, 504, 520, 521, 522, 523, 524, 530].includes(status)) return false;
  if (status) return true;
  const msg = String(err?.message || '').toLowerCase();
  return /network|timeout|failed to fetch|load failed|econn|abort/.test(msg);
}

/** Turn a server error into something a shopkeeper can act on. */
function humanize(err, fallback) {
  const code = err?.response?.data?.code;
  if (code === 'bad_credentials')  return 'Wrong email/phone or password.';
  if (code === 'locked')           return 'Too many attempts. Try again in a few minutes.';
  if (code === 'mobile_disabled')  return 'App access is switched off for this account.';
  if (code === 'device_limit')     return 'Your licence has no free device slots. Remove a device first.';
  const msg = err?.response?.data?.error || err?.message || '';
  if (/Network|timeout|Failed to fetch|Load failed/i.test(msg)) {
    return 'No internet connection. Check your network and try again.';
  }
  return msg || fallback;
}

export default function Login() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const loginOffline = useAuthStore((s) => s.loginOffline);
  const kbd = useKeyboardInset();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const idRef = useRef(null);

  // Hidden recovery path: three taps on the logo opens manual server entry.
  //
  // Deliberately invisible. Typing an IP address is not part of signing in and
  // must not clutter this screen — but a shop whose broadband is down cannot
  // reach the account service, and without this its staff could not sign in at
  // all even standing next to the server. The same setting lives in the app's
  // Settings once signed in; this is only for the locked-out case.
  const [serverOpen, setServerOpen] = useState(false);
  const tapRef = useRef({ count: 0, timer: null });
  function onLogoTap() {
    const t = tapRef.current;
    if (t.timer) clearTimeout(t.timer);
    t.count += 1;
    if (t.count >= 3) { t.count = 0; setServerOpen(true); return; }
    t.timer = setTimeout(() => { t.count = 0; }, 800);
  }

  useEffect(() => {
    // Returning to the login screen means the previous session is gone; the
    // device token stays, since it belongs to the phone rather than the
    // session and re-pairing on every sign-in would be pointless friction.
    setError('');
  }, []);

  // Centre the focused field above the iOS keyboard, which overlays the
  // bottom ~45% without resizing the WebView.
  const onFieldFocus = (e) => {
    const el = e.target;
    setTimeout(() => { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {} }, 300);
  };

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (!identifier.trim() || !password) {
      setError('Enter your email or phone and your password.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      // 1 — who is this, and which shop do they belong to?
      const { data: acct } = await axios.post(`${controlPlaneUrl()}/v1/account/login`, {
        identifier: identifier.trim(),
        password,
        platform: 'ios',
        // Lets the account service give this phone its own device slot rather
        // than evicting whatever device signed in last.
        install_id: installId(),
      }, { timeout: 25000 });

      if (!acct?.site?.hostname) {
        throw new Error('Your shop’s computer has not been set up for app access yet.');
      }

      // 2 — point at that shop and remember this device.
      setDeviceToken(acct.device_token);
      setServerUrl(`https://${acct.site.hostname}`);

      // 3 — trade the assertion for a normal ZEHEN session on the shop server.
      let session;
      try {
        const res = await axios.post(
          `https://${acct.site.hostname}/api/auth/sso`,
          { assertion: acct.assertion },
          { headers: { 'X-Zehen-Device': acct.device_token }, timeout: 25000 },
        );
        session = res.data;
        if (!session?.token || !session?.user) throw new Error('Sign-in failed on the shop server.');
      } catch (shopErr) {
        // The shop computer is off, or its tunnel is down. Cloudflare answers
        // 530/502 for an origin it cannot reach, which used to surface as a
        // raw gateway error and made the app look Wi-Fi-only.
        //
        // The person has already proved who they are, so let them in
        // read-only against the last snapshot the desktop uploaded rather
        // than refusing entry outright.
        if (!isShopUnreachable(shopErr)) throw shopErr;

        const snap = await fetchSnapshot(acct.site.site_id).catch(() => null);
        if (!snap?.snapshot) {
          throw new Error('Your shop computer is offline, and there is no saved data on this phone yet.');
        }

        // Reuse the identity from the last successful online sign-in on this
        // phone so permissions and name stay correct; fall back to what the
        // account service told us if this is a first-ever sign-in.
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem('user') || 'null'); } catch { /* ignore */ }
        loginOffline(cached || {
          username: acct.account?.identifier || identifier.trim(),
          full_name: acct.account?.label || 'Offline user',
          role: 'Offline',
          permissions: {},
        });
        Toast.show({ content: `Shop computer is offline — showing saved figures from ${snapshotAge(snap)}` });
        navigate('/', { replace: true });
        return;
      }

      try {
        localStorage.setItem('zehen_active_site', acct.site.site_id || '');
        // Remember every company this person can open, and which one we
        // landed in, so the switcher can be offered without another round
        // trip — and so a two-company shop is not silently pinned to one.
        if (Array.isArray(session.companies)) {
          localStorage.setItem('zehen_companies', JSON.stringify(session.companies));
        }
        if (session.company_id != null) {
          localStorage.setItem('zehen_company_id', String(session.company_id));
        }
        const name = session.company?.name || acct.site.name;
        if (name) localStorage.setItem('zehen_last_company_name', name);
      } catch { /* private mode */ }

      login(session.user, session.token, false);
      // Pull the business name the owner set in Settings → Company Profile so
      // the first screen already shows it rather than a branch label.
      refreshCompanyProfile().catch(() => {});
      navigate('/', { replace: true });
    } catch (err) {
      setError(humanize(err, 'Could not sign in. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form
        className="login-content"
        onSubmit={onSubmit}
        noValidate
        style={kbd > 0 ? { paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + 20px + ${kbd}px)` } : undefined}
      >
        <div className="login-brand" onClick={onLogoTap} role="presentation">
          <div className="login-logo"><ZehenMark size={60} /></div>
          <div className="login-brand-word">ZEHEN</div>
        </div>

        <div className="login-hero">
          <h1>Sign in</h1>
          <p>Use the email or phone number your shop registered.</p>
        </div>

        <div className="login-card">
          <div className="login-row">
            <span className="login-row-icon"><MailIcon /></span>
            <input
              ref={idRef}
              className="login-row-input"
              type="text"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              enterKeyHint="next"
              value={identifier}
              onChange={(e) => { setIdentifier(e.target.value); setError(''); }}
              onFocus={onFieldFocus}
              placeholder="Email or phone"
            />
          </div>

          <div className="login-divider" />

          <div className="login-row">
            <span className="login-row-icon"><LockIcon /></span>
            <input
              className="login-row-input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              enterKeyHint="go"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              onFocus={onFieldFocus}
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

        {error && <div className="login-error" role="alert">{error}</div>}

        <button type="submit" className="login-signin" disabled={busy}>
          {busy ? <span className="login-spinner" /> : <>Sign in <ArrowIcon /></>}
        </button>

        <button
          type="button"
          className="login-forgot"
          onClick={() => Toast.show({ content: 'Ask your ZEHEN administrator to reset it.' })}
        >
          Forgot password?
        </button>

        <div className="login-hint">
          <span>ZEHEN · Billing · Inventory · GST</span>
        </div>
      </form>

      <ServerDialog
        open={serverOpen}
        initialUrl={getServerUrl()}
        onConnect={async (url) => {
          const res = await fetch(`${url}/api/health`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setServerUrl(url);
        }}
        onClose={() => setServerOpen(false)}
      />
    </div>
  );
}
