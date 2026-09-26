import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authAPI } from '../api';
import useAuthStore from '../store/authStore';
import {
  AuthShell, I, useClock, usePrefersReducedMotion,
} from './authShell';

/**
 * ChangePassword — the same room as the sign-in screen.
 *
 * Two entry points:
 *   (1) forced    — first sign-in on the factory admin password. The only
 *                   way out is Sign out.
 *   (2) voluntary — user menu > Change Password.
 *
 * It shares AuthShell with Login, so it inherits the dot grid, the header
 * clock and the footer, and it recolours with the theme exactly as the
 * sign-in screen does. It previously carried a private copy of an older,
 * dark, always-terracotta login design and looked like a different app.
 *
 * Behaviour is unchanged from that version: new must differ from current,
 * at least 4 characters, confirmation must match, then log out and return
 * to sign-in so the new password is actually used.
 */

const MIN_LEN = 4;

/** Three coarse bands. Deliberately not a score out of 100 — the point is
 *  to nudge, not to grade, and a precise-looking number invites gaming. */
function strengthOf(pw) {
  if (!pw) return null;
  const long = pw.length >= 12;
  const medium = pw.length >= 8;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (long && classes >= 3) return { level: 3, label: 'Strong' };
  if (medium && classes >= 2) return { level: 2, label: 'Fair' };
  return { level: 1, label: 'Weak' };
}

/** Passwords that are effectively no password at all. */
const BANNED = new Set([
  'admin123', 'admin', 'password', '123456', '1234', '12345678',
  'qwerty', 'zehen', 'zehen123', '0000', '1111',
]);

function Field({
  id, label, value, onChange, placeholder, autoFocus, disabled,
  show, onToggleShow, bad, onCaps, trailing,
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div className="zl-field">
      <div className="zl-lrow">
        <label className={`zl-label${focused ? ' on' : ''}`} htmlFor={id}>{label}</label>
      </div>
      <div className="zl-inwrap">
        <input
          id={id}
          className={`zl-in pass${bad ? ' bad' : ''}`}
          type={show ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete={id === 'cp-cur' ? 'current-password' : 'new-password'}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); onCaps?.(false); }}
          onKeyDown={(e) => {
            if (typeof e.getModifierState === 'function') onCaps?.(e.getModifierState('CapsLock'));
          }}
          onKeyUp={(e) => {
            if (typeof e.getModifierState === 'function') onCaps?.(e.getModifierState('CapsLock'));
          }}
        />
        <span className={`zl-sweep${focused ? ' on' : ''}`} aria-hidden="true" />
        <button
          type="button"
          className="zl-eye"
          onClick={onToggleShow}
          aria-label={show ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {show ? <I.eyeOff /> : <I.eye />}
        </button>
      </div>
      {trailing}
    </div>
  );
}

export default function ChangePassword() {
  const navigate = useNavigate();
  const reduced = usePrefersReducedMotion();
  const { now, timePhase } = useClock();

  const mustChange = useAuthStore((s) => s.mustChangePassword);
  const clearMustChange = useAuthStore((s) => s.clearMustChangePassword);
  const logout = useAuthStore((s) => s.logout);

  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState('');
  const [bad, setBad] = useState({ cur: false, next: false, confirm: false });
  const [shake, setShake] = useState(false);
  const [phase, setPhase] = useState('idle');     // idle | loading | ok
  const [enterDown, setEnterDown] = useState(false);
  const curRef = useRef(null);

  const busy = phase !== 'idle';
  const strength = strengthOf(next);
  const match = confirm.length > 0 && confirm === next;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter') setEnterDown(true);
      if (e.key === 'Escape' && !mustChange && !busy) navigate(-1);
    };
    const onUp = (e) => { if (e.key === 'Enter') setEnterDown(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  }, [mustChange, busy, navigate]);

  const fail = (msg, fields) => {
    setError(msg);
    setBad({ cur: false, next: false, confirm: false, ...(fields || {}) });
    if (!reduced) { setShake(true); setTimeout(() => setShake(false), 340); }
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;

    if (!cur) { fail('Enter your current password.', { cur: true }); return; }
    if (!next) { fail('Enter a new password.', { next: true }); return; }
    if (next.length < MIN_LEN) {
      fail(`The new password must be at least ${MIN_LEN} characters.`, { next: true });
      return;
    }
    if (next === cur) {
      fail('The new password must be different from the current one.', { next: true });
      return;
    }
    if (BANNED.has(next.toLowerCase())) {
      fail('That password is too common. Pick something only you would guess.', { next: true });
      return;
    }
    if (next !== confirm) {
      fail('The two new passwords do not match.', { confirm: true });
      return;
    }

    setError('');
    setBad({ cur: false, next: false, confirm: false });
    setPhase('loading');
    try {
      await authAPI.changePassword({ current_password: cur, new_password: next });
      clearMustChange();
      setCur(''); setNext(''); setConfirm('');
      setPhase('ok');
      // Sign out on purpose: the session was issued against the old
      // password, and signing in again proves the new one works.
      setTimeout(() => {
        logout();
        window.location.href = '/login';
      }, reduced ? 0 : 1100);
    } catch (err) {
      setPhase('idle');
      const server = err.response?.data?.error;
      const wrongCurrent = err.response?.status === 400 || err.response?.status === 401;
      fail(
        wrongCurrent ? (server || 'That current password is not right.') : (server || 'Could not update the password.'),
        wrongCurrent ? { cur: true } : {},
      );
      setCur('');
      curRef.current?.focus();
    }
  };

  const signOut = () => {
    logout();
    window.location.href = '/login';
  };

  return (
    <AuthShell
      now={now}
      timePhase={timePhase}
      reduced={reduced}
      footerNote="All data on this computer"
      overlay={phase === 'ok' ? (
        <div className="zl-zoom" aria-hidden="true">
          <div className="zl-zoom-in">
            <I.tick width={44} height={44} />
            <span className="t">Password updated</span>
            <span className="s">Sign in again with your new password</span>
          </div>
        </div>
      ) : null}
    >
      {/* Why this screen is here. Shown only on the forced path, and as a
          quiet chip rather than a red alarm — nothing is wrong yet. */}
      {mustChange && (
        <span className="zl-note">
          <I.shield /> First sign-in — the factory password still works on this account
        </span>
      )}

      <div className={`zl-card${error ? ' err' : ''}${shake ? ' shake' : ''}`}>
        <form onSubmit={submit} noValidate>
          <h1 className="zl-title">
            {mustChange ? 'Set your password' : 'Change password'}
          </h1>
          <p className="zl-sub">
            {mustChange
              ? 'Pick something only you know. You will sign in again with it.'
              : 'You will be signed out and asked to sign in with the new one.'}
          </p>

          <Field
            id="cp-cur"
            label="Current password"
            value={cur}
            onChange={(v) => { setCur(v); if (error) { setError(''); setBad({ cur: false, next: false, confirm: false }); } }}
            placeholder={mustChange ? 'The password you just used' : ''}
            autoFocus
            disabled={busy}
            show={show}
            onToggleShow={() => setShow((v) => !v)}
            bad={bad.cur}
            onCaps={setCaps}
          />

          <Field
            id="cp-new"
            label="New password"
            value={next}
            onChange={(v) => { setNext(v); if (error) { setError(''); setBad({ cur: false, next: false, confirm: false }); } }}
            placeholder={`At least ${MIN_LEN} characters`}
            disabled={busy}
            show={show}
            onToggleShow={() => setShow((v) => !v)}
            bad={bad.next}
            onCaps={setCaps}
            trailing={strength && (
              <div className="zl-meter" data-level={strength.level}>
                <i /><i /><i />
                <span>{strength.label}</span>
              </div>
            )}
          />

          <Field
            id="cp-confirm"
            label="Confirm new password"
            value={confirm}
            onChange={(v) => { setConfirm(v); if (error) { setError(''); setBad({ cur: false, next: false, confirm: false }); } }}
            placeholder="Type it once more"
            disabled={busy}
            show={show}
            onToggleShow={() => setShow((v) => !v)}
            bad={bad.confirm}
            onCaps={setCaps}
            trailing={match ? (
              <div className="zl-ok-row"><I.tick /> Both match</div>
            ) : null}
          />

          {error && (
            <div className="zl-msg error" role="alert">
              <I.alert />{error}
            </div>
          )}
          {caps && !error && (
            <div className="zl-msg warn" role="status">Caps Lock is on</div>
          )}

          <button type="submit" className={`zl-btn${phase === 'ok' ? ' ok' : ''}`} disabled={busy}>
            {phase === 'loading' && <I.spin className="zl-spin" />}
            {phase === 'ok' && (
              <svg className="zl-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12l5 5 9-10" />
              </svg>
            )}
            <span>
              {phase === 'ok' ? 'Updated' : phase === 'loading' ? 'Updating…' : 'Update password'}
            </span>
            {phase === 'idle' && <span className={`zl-kbd${enterDown ? ' down' : ''}`} aria-hidden="true">↵</span>}
          </button>

          <button type="button" className="zl-ghost" onClick={mustChange ? signOut : () => navigate(-1)} disabled={busy}>
            {mustChange ? 'Sign out instead' : (<><I.back /> Back</>)}
          </button>
        </form>
      </div>

      <span className="zl-note">
        <I.key /> Nobody else can see this password, not even from Settings
      </span>
    </AuthShell>
  );
}
