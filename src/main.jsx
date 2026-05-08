import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/source-sans-3';
import ThemeProvider from './theme/ThemeProvider';
import MainApp from './App';
import AppErrorBoundary from './AppErrorBoundary';
import { MenuPopupProvider } from './components/keyboard/MenuPopup';
import { DatePopupProvider } from './components/keyboard/DatePopup';
import './styles/global.css';

/* ── Self-heal stale localStorage on boot ─────────────────────────────
 *
 * Any combination of "I have a user but no token" or "the token is the
 * literal string 'null'/'undefined'" indicates a previous session
 * cleared half its state and bailed mid-flight. Without recovery here,
 * the auth store would mount thinking we're logged in, AppLayout would
 * render, an API call would 401, the axios interceptor would
 * window.location.href = '/login', and we'd go back into the same
 * inconsistent state — producing the blank/blinking screen the user
 * sees on every restart.
 *
 * Sweep these states before React mounts so the store initialises
 * cleanly. Idempotent: a fully-fine session has nothing to clean up.
 * ────────────────────────────────────────────────────────────────── */
try {
  const t = localStorage.getItem('token');
  const u = localStorage.getItem('user');
  const tokenBad = !t || t === 'null' || t === 'undefined';
  const userBad  = !u || u === 'null' || u === 'undefined';
  if (tokenBad || userBad) {
    // Either piece missing/corrupt → nuke both + the change-password
    // flag so the boot lands on /login as a fresh user.
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('must_change_password');
  }
} catch { /* private mode etc. */ }

// MenuPopup + DatePopup providers wrap App (not nested INSIDE) so
// useMenuPopup() / useDatePopup() called from inside App's body —
// notably from useGlobalShortcuts — find the context. Putting them
// inside App's JSX makes them mount AFTER App's hooks run, leaving
// useContext returning null on the first render.
//
// The error boundary sits at the OUTERMOST layer so it catches crashes
// from anywhere — including the providers themselves. Without it, a
// runtime error during React's first commit produces a silent blank
// window.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <ThemeProvider>
          <MenuPopupProvider>
            <DatePopupProvider>
              <MainApp />
            </DatePopupProvider>
          </MenuPopupProvider>
        </ThemeProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>
);
