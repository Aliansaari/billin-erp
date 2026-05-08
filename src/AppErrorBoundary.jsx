import React from 'react';

/**
 * App-level error boundary.
 *
 * Catches any uncaught render/runtime error during React's commit phase
 * and displays a recoverable error screen INSTEAD of a blank window.
 * Without this, a crash deep in the tree (e.g. a malformed store, a
 * missing import, a broken hook) leaves the user staring at white
 * pixels with no hint at what went wrong.
 *
 * The reload button forces a hard reload; the "Sign out & reload"
 * button additionally clears the JWT + dev-mode unlock so a corrupt
 * persisted-state can't keep crashing the same way after reload.
 *
 * Production-safe: never auto-mounts DevTools, never exposes stack
 * traces unless the user expands the Details disclosure.
 */
export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    // Bubble to console so the renderer's console-message bridge in
    // electron/main.js logs the stack to the launch terminal.
    // eslint-disable-next-line no-console
    console.error('[AppErrorBoundary]', error, errorInfo?.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleSignOutAndReload = () => {
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('must_change_password');
      localStorage.removeItem('billing_erp_dev_mode');
    } catch { /* private mode etc */ }
    window.location.href = '/';
  };

  render() {
    if (!this.state.error) return this.props.children;
    const stack = (this.state.errorInfo?.componentStack || '').trim();
    return (
      <div style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
        background: '#0f172a',
        color: '#e2e8f0',
        fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      }}>
        <div style={{ maxWidth: 640, width: '100%' }}>
          <div style={{
            display: 'inline-block',
            background: '#7f1d1d',
            color: '#fecaca',
            padding: '4px 10px',
            borderRadius: 12,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.5px',
            marginBottom: 12,
            textTransform: 'uppercase',
          }}>App crashed during render</div>

          <h1 style={{ margin: '0 0 8px', fontWeight: 700, letterSpacing: '-.4px', fontSize: 24 }}>
            Something went wrong
          </h1>
          <p style={{ margin: '0 0 18px', color: '#94a3b8', fontSize: 14, lineHeight: 1.55 }}>
            The app hit an unexpected error while loading. This usually clears with a reload — your
            data is safe on the server.
          </p>

          <div style={{
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 8,
            padding: '10px 14px',
            fontFamily: 'JetBrains Mono, Consolas, monospace',
            fontSize: 13,
            color: '#fda4af',
            marginBottom: 16,
            wordBreak: 'break-word',
          }}>
            {String(this.state.error?.message || this.state.error)}
          </div>

          <details style={{ marginBottom: 18 }}>
            <summary style={{ cursor: 'pointer', color: '#94a3b8', fontSize: 13 }}>
              Show technical details
            </summary>
            <pre style={{
              marginTop: 8,
              background: '#020617',
              color: '#94a3b8',
              padding: 12,
              borderRadius: 6,
              fontSize: 11.5,
              lineHeight: 1.5,
              maxHeight: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}>
              {(this.state.error?.stack || String(this.state.error))}
              {stack ? '\n\nComponent stack:\n' + stack : ''}
            </pre>
          </details>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                background: '#22c55e',
                color: '#0f172a',
                border: 'none',
                padding: '10px 18px',
                borderRadius: 8,
                fontWeight: 700,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.handleSignOutAndReload}
              style={{
                background: 'transparent',
                color: '#cbd5e1',
                border: '1px solid #475569',
                padding: '10px 18px',
                borderRadius: 8,
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Sign out &amp; reset
            </button>
          </div>
        </div>
      </div>
    );
  }
}
