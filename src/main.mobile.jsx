import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import '@fontsource-variable/source-sans-3';
import App from './mobile/App';
import './mobile/theme.css';
import './mobile/glass.css';
import { startKeyboardTracking } from './mobile/utils/nativeShell';

// On iOS/Android, ask Capacitor to NEVER auto-scroll the WebView when the
// soft keyboard appears. Together with `resize: 'none'` in
// capacitor.config.js this keeps the editorial login form pinned in place
// when the user taps a field — the keyboard slides over the bottom rather
// than shoving the whole layout upward into the status bar. Browser
// preview is unaffected (Capacitor.isNativePlatform() is false there).
if (Capacitor.isNativePlatform()) {
  import('@capacitor/keyboard')
    .then(({ Keyboard }) => Keyboard.setScroll({ isDisabled: true }))
    .catch(() => { /* plugin missing on this build — no-op */ });
}

// One keyboard tracker for the whole app: publishes its height as --kb-h,
// turns on the iOS Prev/Next/Done accessory bar, and keeps the focused field
// on screen. See utils/nativeShell.js.
startKeyboardTracking();

// Self-heal stale localStorage on boot — same logic as desktop main.jsx.
// If we have a half-cleared session (token missing but user present, or
// the literal string 'null'/'undefined') we wipe both so the auth store
// mounts cleanly and lands on /login as a fresh user.
try {
  const t = localStorage.getItem('token');
  const u = localStorage.getItem('user');
  const tokenBad = !t || t === 'null' || t === 'undefined';
  const userBad  = !u || u === 'null' || u === 'undefined';
  if (tokenBad || userBad) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('must_change_password');
  }
} catch {}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/']} initialIndex={0}>
      <App />
    </MemoryRouter>
  </React.StrictMode>
);
