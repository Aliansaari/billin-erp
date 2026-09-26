import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message } from 'antd';
import { authAPI, companyAPI } from '../api';
import useAuthStore from '../store/authStore';
import useCompanyStore from '../store/companyStore';
import { ZehenMark } from '../components/ZehenLogo';
import {
  AuthShell, I, fyLabel, greetingFor, initialsOf, openHelp,
  useClock, usePrefersReducedMotion,
} from './authShell';

/**
 * Login — built to LOGIN_SCREEN_SPEC.md.
 *
 * Header · centred column (company pill, card, note) · footer, over a dot
 * grid that lights up under the cursor. The spec is the source of truth
 * for spacing, motion and behaviour; everything below notes only where
 * this implementation departs from it, and why.
 *
 * 1. FONT. The spec asks for Geist. ZEHEN already bundles Source Sans 3
 *    (offline, via @fontsource-variable) and uses it on every other
 *    screen. Adding a second UI face for the sign-in screen alone would
 *    mean the door is set in a different typeface from the room behind
 *    it, and Geist is not vendored — pulling it from Google Fonts is
 *    ruled out for an offline app. Source Sans 3 throughout; the app's
 *    existing mono stack for the figures that need to align (FY, GSTIN).
 *
 * 2. COLOUR. The spec's palette IS ZEHEN's Classic teal (#0891A8 accent,
 *    #06758A button). Rather than hard-code it, login.css reads the live
 *    theme tokens, so the screen is teal under Classic and the same
 *    design in terracotta under Modern. The sign-in screen always
 *    matches the app behind the door — no jolt on the way in.
 *    The ZEHEN mark is the exception and never recolours: it is the app
 *    icon, and an icon that changes with a setting is not a logo.
 *
 * 3. BACKUP TIME (spec §5.5). There is no pre-auth endpoint for backup
 *    metadata, and the spec says to hide the item rather than invent a
 *    value. Hidden.
 *
 * 4. FORGOT (spec §5.3, open question 3). No reset flow exists yet, so
 *    rather than a dead link this states who can reset the password.
 *
 * PRIVACY, per spec §1 — nothing about a person is remembered. No last
 * username, no user list, no avatars. Fields are blank on mount and are
 * cleared again on success. The initial badge shows only the first
 * letter of what is being typed at that moment.
 */

export default function Login() {
  const prefersReduced = usePrefersReducedMotion();
  const { now, timePhase } = useClock();

  const [companies, setCompanies] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hl, setHl] = useState(0);
  const [swapping, setSwapping] = useState(false);

  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [focus, setFocus] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [caps, setCaps] = useState(false);
  const [enterDown, setEnterDown] = useState(false);
  const [error, setError] = useState('');
  const [badFields, setBadFields] = useState({ user: false, pw: false });
  const [shake, setShake] = useState(false);
  const [phase, setPhase] = useState('idle');     // idle | loading | ok

  const userRef = useRef(null);
  const pwRef = useRef(null);
  const searchRef = useRef(null);

  const login = useAuthStore((s) => s.login);
  const pickCompany = useCompanyStore((s) => s.pick);
  const storedCompanyId = useCompanyStore((s) => s.currentId);
  const setCompaniesInStore = useCompanyStore((s) => s.setList);

  /* Fields start blank and stay unremembered (spec §1). Belt and braces:
   * clear on mount so a hot reload or a back-navigation can never leave
   * the previous person's typing on screen. */
  useEffect(() => { setUser(''); setPw(''); }, []);

  const hour = now.getHours();

  /* Companies. Failures are silent — a fresh install with no master DB
   * still gets a usable form. */
  useEffect(() => {
    let cancel = false;
    companyAPI.listPublic()
      .then((r) => {
        if (cancel) return;
        const list = r.data?.data || [];
        setCompanies(list);
        setCompaniesInStore(list);
        if (list.length === 1) setSelectedId(list[0].company_id);
        else if (storedCompanyId && list.some((c) => c.company_id === storedCompanyId)) {
          setSelectedId(storedCompanyId);
        } else if (list.length) {
          setSelectedId(list.find((c) => c.is_primary)?.company_id ?? list[0].company_id);
        }
      })
      .catch(() => { /* fresh install — proceed with no picker */ });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = companies.find((c) => c.company_id === selectedId) || null;
  const fy = fyLabel(selected?.fy_start_month, now);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter((c) =>
      String(c.name || '').toLowerCase().includes(q)
      || String(c.gstin || '').toLowerCase().includes(q));
  }, [companies, query]);

  useEffect(() => { setHl(0); }, [query, open]);

  const closeDropdown = useCallback(() => { setOpen(false); setQuery(''); }, []);

  /* Esc closes the dropdown; arrows and Enter drive it (spec §5.2). */
  const onPopKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDropdown(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl((i) => Math.min(filtered.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHl((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const c = filtered[hl];
      if (c) choose(c.company_id);
    }
  };

  const choose = (id) => {
    closeDropdown();
    if (id === selectedId) return;
    if (prefersReduced) { setSelectedId(id); return; }
    setSwapping(true);
    setTimeout(() => setSelectedId(id), 160);
    setTimeout(() => setSwapping(false), 200);
  };

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  const capsProbe = (e) => {
    if (typeof e.getModifierState === 'function') setCaps(e.getModifierState('CapsLock'));
  };

  const fail = (msg, bad) => {
    setError(msg);
    setBadFields(bad || { user: false, pw: false });
    if (!prefersReduced) { setShake(true); setTimeout(() => setShake(false), 340); }
  };

  const submit = async () => {
    if (phase !== 'idle') return;
    closeDropdown();

    const u = user.trim();
    if (!u || !pw) {
      fail('Enter your username and password.', { user: !u, pw: !pw });
      (!u ? userRef : pwRef).current?.focus();
      return;
    }

    setError(''); setBadFields({ user: false, pw: false });
    setPhase('loading');
    try {
      const company_id = selectedId
        || (companies.length === 1 ? companies[0].company_id : undefined);
      const { data } = await authAPI.login({ username: u, password: pw, company_id });
      const resolvedId = data.company_id || company_id;
      if (resolvedId) pickCompany(resolvedId);

      // Nothing about the person is kept — clear before we leave.
      setUser(''); setPw('');
      setPhase('ok');

      login(data.user, data.token, !!data.must_change_password);
      const go = () => {
        window.location.href = data.must_change_password ? '/change-password' : '/';
      };
      if (data.must_change_password) {
        message.warning('Please set a new password to continue.');
        setTimeout(go, prefersReduced ? 0 : 500);
      } else {
        setTimeout(go, prefersReduced ? 0 : 1250);
      }
    } catch (err) {
      setPhase('idle');
      // One message for every failure — never reveal which field was
      // wrong, and never whether a username exists (spec §6).
      const server = err.response?.data?.error;
      const generic = 'Username or password is incorrect.';
      const isAuth = !err.response || err.response.status === 401 || err.response.status === 400;
      fail(isAuth ? generic : (server || generic), { user: true, pw: true });
      setPw('');
      pwRef.current?.focus();
    }
  };

  const dots = showPw ? 0 : Math.min(pw.length, 26);
  const masked = !showPw && (pw.length > 0 || focus === 'pw');
  const busy = phase !== 'idle';

  return (
    <AuthShell
      now={now}
      timePhase={timePhase}
      reduced={prefersReduced}
      overlay={phase === 'ok' ? (
        <div className="zl-zoom" aria-hidden="true">
          <div className="zl-zoom-in">
            <ZehenMark size={64} />
            <span className="t">Opening {selected?.name || 'ZEHEN'}</span>
            <span className="s">{fy}</span>
          </div>
        </div>
      ) : null}
    >
          {/* ── Company + financial year ── */}
          {companies.length > 0 && (
            <div className="zl-pill-wrap">
              <button
                type="button"
                className={`zl-pill${open ? ' open' : ''}${companies.length < 2 ? ' static' : ''}`}
                style={{ '--co': selected?.accent_color || 'var(--ac)' }}
                onClick={() => companies.length > 1 && setOpen((o) => !o)}
                aria-haspopup={companies.length > 1 ? 'listbox' : undefined}
                aria-expanded={companies.length > 1 ? open : undefined}
                aria-label="Company"
                disabled={companies.length < 2}
              >
                <span className="zl-init">
                  <span className={`zl-swap${swapping ? ' out' : ''}`}>{initialsOf(selected?.name)}</span>
                </span>
                <span className="zl-co-name">
                  <span className={`zl-swap${swapping ? ' out' : ''}`}>{selected?.name || 'Select a company'}</span>
                </span>
                <span className="div" aria-hidden="true" />
                <span className="zl-fy">{fy}</span>
                {companies.length > 1 && <span className="zl-chev" aria-hidden="true" />}
              </button>

              {open && (
                <>
                  <div className="zl-scrim" onClick={closeDropdown} aria-hidden="true" />
                  <div className="zl-pop" onKeyDown={onPopKey}>
                    <div className="zl-search">
                      <I.search className="mag" />
                      <label htmlFor="zl-q" className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                        Search companies
                      </label>
                      <input
                        id="zl-q"
                        ref={searchRef}
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search company or GSTIN"
                        autoComplete="off"
                      />
                    </div>
                    <div className="zl-rows" role="listbox" aria-label="Companies">
                      {filtered.map((c, i) => (
                        <button
                          key={c.company_id}
                          type="button"
                          role="option"
                          aria-selected={c.company_id === selectedId}
                          className={`zl-row${c.company_id === selectedId ? ' sel' : ''}${i === hl ? ' hl' : ''}`}
                          style={{ '--co': c.accent_color || 'var(--ac)' }}
                          onClick={() => choose(c.company_id)}
                          onMouseEnter={() => setHl(i)}
                        >
                          <span className="chip">{initialsOf(c.name)}</span>
                          <span className="meta">
                            <span className="nm">{c.name}</span>
                            {c.gstin && <span className="gst">{c.gstin}</span>}
                          </span>
                          {c.company_id === selectedId && <I.tick style={{ color: 'var(--ac)' }} />}
                        </button>
                      ))}
                      {filtered.length === 0 && (
                        <p className="zl-none">No company matches your search.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Card ── */}
          <div className={`zl-card${error ? ' err' : ''}${shake ? ' shake' : ''}`}>
            <h1 className="zl-title">Sign in to ZEHEN</h1>
            <p className="zl-sub">{greetingFor(hour)}. Enter your details to continue.</p>

            <form
              onSubmit={(e) => { e.preventDefault(); submit(); }}
              noValidate
            >
              <div className="zl-field">
                <div className="zl-lrow">
                  <label className={`zl-label${focus === 'user' ? ' on' : ''}`} htmlFor="zl-user">Username</label>
                </div>
                <div className="zl-inwrap">
                  <input
                    id="zl-user"
                    ref={userRef}
                    className={`zl-in user${badFields.user ? ' bad' : ''}`}
                    type="text"
                    value={user}
                    autoFocus
                    disabled={busy}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(e) => { setUser(e.target.value); if (error) { setError(''); setBadFields({ user: false, pw: false }); } }}
                    onFocus={() => { setFocus('user'); closeDropdown(); }}
                    onBlur={() => setFocus('')}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pwRef.current?.focus(); } }}
                  />
                  <span className={`zl-sweep${focus === 'user' ? ' on' : ''}`} aria-hidden="true" />
                  <span className={`zl-badge${user.trim() ? ' on' : ''}`} aria-hidden="true">
                    {user.trim() ? user.trim()[0].toUpperCase() : ''}
                  </span>
                </div>
              </div>

              <div className="zl-field">
                <div className="zl-lrow">
                  <label className={`zl-label${focus === 'pw' ? ' on' : ''}`} htmlFor="zl-pw">Password</label>
                </div>
                <div className="zl-inwrap">
                  <input
                    id="zl-pw"
                    ref={pwRef}
                    className={`zl-in pass${masked ? ' masked' : ''}${badFields.pw ? ' bad' : ''}`}
                    type={showPw ? 'text' : 'password'}
                    value={pw}
                    disabled={busy}
                    autoComplete="current-password"
                    onChange={(e) => { setPw(e.target.value); if (error) { setError(''); setBadFields({ user: false, pw: false }); } }}
                    onFocus={() => { setFocus('pw'); closeDropdown(); }}
                    onBlur={() => { setFocus(''); setCaps(false); }}
                    onKeyDown={(e) => { capsProbe(e); if (e.key === 'Enter') setEnterDown(true); }}
                    onKeyUp={(e) => { capsProbe(e); if (e.key === 'Enter') setEnterDown(false); }}
                  />
                  <span className={`zl-sweep${focus === 'pw' ? ' on' : ''}`} aria-hidden="true" />
                  {masked && (
                    <div className="zl-dots" aria-hidden="true">
                      {Array.from({ length: dots }, (_, i) => (
                        <i key={i} className={i === dots - 1 && focus === 'pw' ? 'last' : ''} />
                      ))}
                      {focus === 'pw' && <span className="zl-caret" />}
                    </div>
                  )}
                  <button
                    type="button"
                    className="zl-eye"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPw ? <I.eyeOff /> : <I.eye />}
                  </button>
                </div>
                {/* Rendered after the input on purpose: when it sat in the
                    label row above, Tab out of Username landed here instead
                    of on the password box. CSS floats it back up into the
                    label row, so it looks the same and tabs correctly. */}
                <button
                  type="button"
                  className="zl-forgot"
                  onClick={() => setError('Ask the owner to reset it in Settings → Users.')}
                >
                  Forgot?
                </button>
              </div>

              {error && (
                <div className="zl-msg error" role="alert">
                  <I.alert />{error}
                </div>
              )}
              {caps && !error && (
                <div className="zl-msg warn" role="status">Caps Lock is on</div>
              )}

              <button
                type="submit"
                className={`zl-btn${phase === 'ok' ? ' ok' : ''}`}
                disabled={busy}
              >
                {phase === 'loading' && <I.spin className="zl-spin" />}
                {phase === 'ok' && (
                  <svg className="zl-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                )}
                <span>
                  {phase === 'ok' ? 'Signed in' : phase === 'loading' ? 'Signing in…' : 'Sign in'}
                </span>
                {phase === 'idle' && <span className={`zl-kbd${enterDown ? ' down' : ''}`} aria-hidden="true">↵</span>}
              </button>
            </form>
          </div>

    </AuthShell>
  );
}
