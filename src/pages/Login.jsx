import React, { useEffect, useState } from 'react';
import { Form, Input, Button, message } from 'antd';
import { UserOutlined, LockOutlined, BankOutlined } from '@ant-design/icons';
import { authAPI, companyAPI } from '../api';
import useAuthStore from '../store/authStore';
import useCompanyStore from '../store/companyStore';

/**
 * Login — editorial Modern with multi-company picker.
 *
 * Layout: greeting + form. The Company select appears as a normal
 * Form.Item ABOVE the username field when the master DB has 2+
 * companies — single-company installs see it hidden so the form looks
 * unchanged.
 *
 * Behavior:
 *   - Auth call + redirect based on `must_change_password`
 *   - Authstore login persists flag to localStorage
 *   - Selected company is persisted in the company store so
 *     reload returns to the same one (Phase 2 will wire the JWT to
 *     carry the choice and route requests accordingly).
 */
export default function Login() {
  const [loading, setLoading] = useState(false);
  const [companies, setCompanies] = useState([]);
  const login = useAuthStore((s) => s.login);
  const pickCompany     = useCompanyStore((s) => s.pick);
  const storedCompanyId = useCompanyStore((s) => s.currentId);
  const setCompaniesInStore = useCompanyStore((s) => s.setList);

  // Currently-selected company (controlled state on the Select).
  // Initialised from the persisted store so a reload returns to the
  // same company selection. Cleared if that company no longer exists.
  const [selectedCompanyId, setSelectedCompanyId] = useState(storedCompanyId || null);

  // Picker dropdown open state — controlled because we open it via
  // the F1 shortcut, not just on click. Highlighted index is the
  // arrow-key cursor (separate from selectedCompanyId, which is the
  // committed selection). When the dropdown opens, the highlight
  // starts on whichever company is currently selected so the user
  // can press Enter to confirm without moving.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);

  // Keep the highlight in sync when the dropdown opens — point at the
  // currently-selected company so Enter is the natural "yes, this one".
  useEffect(() => {
    if (!pickerOpen) return;
    const i = Math.max(0, companies.findIndex((c) => c.company_id === selectedCompanyId));
    setHighlightIdx(i);
  }, [pickerOpen, companies, selectedCompanyId]);

  // F1 toggles the picker; arrows / Enter / number keys navigate it.
  // F1 ALWAYS works (even while typing in an input) — typing F1 in a
  // username field doesn't make sense anyway, so we suppress its
  // browser-default (help) and use it as the picker trigger.
  // 1-9 / arrows / Enter / Esc only fire when the dropdown is open AND
  // the user isn't typing in a text field, so the password field
  // still works normally.
  useEffect(() => {
    if (companies.length < 2) return;
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea';

      // F1 — toggle dropdown. Always intercepted so it doesn't pop the
      // browser/Electron help.
      if (e.key === 'F1') {
        e.preventDefault();
        setPickerOpen((o) => !o);
        return;
      }

      // Everything below only fires when the dropdown is open. Without
      // this gate, arrow keys + Enter would still work even when no
      // dropdown is visible — confusing.
      if (!pickerOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        setPickerOpen(false);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(companies.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(0, i - 1));
        return;
      }

      if (e.key === 'Home') {
        e.preventDefault();
        setHighlightIdx(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setHighlightIdx(companies.length - 1);
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const c = companies[highlightIdx];
        if (c) setSelectedCompanyId(c.company_id);
        setPickerOpen(false);
        return;
      }

      // 1-9 — quick-pick by number. Suppressed while typing so a
      // username containing digits still works.
      if (!typing) {
        const n = parseInt(e.key, 10);
        if (Number.isFinite(n) && n >= 1 && n <= companies.length) {
          e.preventDefault();
          setSelectedCompanyId(companies[n - 1].company_id);
          setPickerOpen(false);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [companies, pickerOpen, highlightIdx]);

  // Fetch the public list once on mount. Failures are silent — fresh
  // installs where the master DB hasn't been bootstrapped yet just see
  // the regular login form with no Company field.
  useEffect(() => {
    let cancel = false;
    companyAPI.listPublic()
      .then((r) => {
        if (cancel) return;
        const list = r.data?.data || [];
        setCompanies(list);
        setCompaniesInStore(list);
        // Auto-select if there's exactly one — no UI choice needed.
        if (list.length === 1) setSelectedCompanyId(list[0].company_id);
        // Drop a stale stored selection if that company no longer exists.
        else if (storedCompanyId && !list.some((c) => c.company_id === storedCompanyId)) {
          setSelectedCompanyId(null);
        }
      })
      .catch(() => { /* fresh install — proceed with no picker */ });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      // Resolve which company to authenticate against. The picker-driven
      // selectedCompanyId wins; fall back to the only company on a
      // single-company install; fall back to undefined (server defaults
      // to primary) on a fresh install with no companies yet.
      const company_id =
        selectedCompanyId ||
        (companies.length === 1 ? companies[0].company_id : undefined);

      const { data } = await authAPI.login({ ...values, company_id });
      // Persist the resolved company id (server returns it on success
      // even if we sent it; either way the store + topbar reflect the
      // actual book the user just logged into).
      const resolvedId = data.company_id || company_id;
      if (resolvedId) pickCompany(resolvedId);
      login(data.user, data.token, !!data.must_change_password);
      if (data.must_change_password) {
        message.warning('Please set a new password to continue.');
        window.location.href = '/change-password';
      } else {
        message.success(`Welcome back, ${data.user.full_name}!`);
        window.location.href = '/';
      }
    } catch (error) {
      message.error(error.response?.data?.error || 'Invalid username or password');
      setLoading(false);
    }
  };

  return (
    <div className="erp-login-root">
      {/* Warm radial mesh + fine grain overlay */}
      <div className="erp-login-mesh" />
      <div className="erp-login-grain" />

      <div className="erp-login-stage">
        <div className="erp-login-card">
          <h2 className="erp-login-h">Welcome back.</h2>
          <div className="erp-login-sub">Sign in to continue to your firm.</div>

          {/* Company picker — single trigger button that opens a
              dropdown panel listing every company. The trigger always
              shows the currently-selected company so the user can see
              at a glance which book they're about to log into. Press
              F (when no input is focused) to toggle, 1-9 inside the
              dropdown to quick-pick, Esc to close. */}
          {companies.length >= 2 && (() => {
            const cur = companies.find((c) => c.company_id === selectedCompanyId);
            return (
              <div className="erp-login-picker">
                <div className="erp-login-label" style={{ marginBottom: 8 }}>Company</div>
                <div className="erp-login-pick-wrap">
                  <button
                    type="button"
                    className="erp-login-pick-trigger"
                    style={{ '--accent': cur?.accent_color || '#21604C' }}
                    onClick={() => setPickerOpen((o) => !o)}
                    aria-haspopup="listbox"
                    aria-expanded={pickerOpen}
                  >
                    <div className="erp-login-pick-icon">
                      <BankOutlined />
                    </div>
                    <div className="erp-login-pick-name">
                      {cur ? cur.name : <span style={{ opacity: 0.5 }}>Pick a company</span>}
                    </div>
                    {cur?.is_primary && <span className="erp-login-pick-tag">PRIMARY</span>}
                    <span className="erp-login-pick-key">F1</span>
                    <span className="erp-login-pick-chev">{pickerOpen ? '▲' : '▼'}</span>
                  </button>

                  {pickerOpen && (
                    <>
                      {/* Click-outside scrim — dismisses the dropdown so
                          the user doesn't have to find the trigger again. */}
                      <div
                        className="erp-login-pick-scrim"
                        onClick={() => setPickerOpen(false)}
                        aria-hidden="true"
                      />
                      <ul className="erp-login-pick-list" role="listbox">
                        {companies.map((c, idx) => {
                          const sel = selectedCompanyId === c.company_id;
                          const hl  = highlightIdx === idx;
                          return (
                            <li key={c.company_id}>
                              <button
                                type="button"
                                className={`erp-login-pick-item${sel ? ' sel' : ''}${hl ? ' hl' : ''}`}
                                style={{ '--accent': c.accent_color || '#21604C' }}
                                onClick={() => {
                                  setSelectedCompanyId(c.company_id);
                                  setPickerOpen(false);
                                }}
                                onMouseEnter={() => setHighlightIdx(idx)}
                                role="option"
                                aria-selected={sel}
                              >
                                <div className="erp-login-pick-icon">
                                  <BankOutlined />
                                </div>
                                <div className="erp-login-pick-name">{c.name}</div>
                                {c.is_primary && <span className="erp-login-pick-tag">PRIMARY</span>}
                                {idx < 9 && <span className="erp-login-pick-key">{idx + 1}</span>}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          <Form name="login" onFinish={onFinish} layout="vertical" requiredMark={false}>
            <Form.Item
              name="username"
              label={<span className="erp-login-label">Username</span>}
              rules={[{ required: true, message: 'Please enter your username' }]}
              style={{ marginBottom: 18 }}
            >
              <Input
                className="erp-login-input"
                prefix={<UserOutlined style={{ color: '#8F8372' }} />}
                placeholder="admin"
                autoFocus
              />
            </Form.Item>

            <Form.Item
              name="password"
              label={<span className="erp-login-label">Password</span>}
              rules={[{ required: true, message: 'Please enter your password' }]}
              style={{ marginBottom: 22 }}
            >
              <Input.Password
                className="erp-login-input"
                prefix={<LockOutlined style={{ color: '#8F8372' }} />}
                placeholder="••••••••••"
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                className="erp-login-btn"
              >
                {loading ? 'Signing in…' : (
                  <span>Sign in <span className="erp-login-kbd">Enter</span></span>
                )}
              </Button>
            </Form.Item>
          </Form>

          <div className="erp-login-hint">
            <div className="erp-login-hint-ico">✦</div>
            <div className="erp-login-hint-text">
              First time? Try <code>admin</code> / <code>admin123</code> — we&rsquo;ll ask you to set a real password.
            </div>
          </div>
        </div>
      </div>

      {/* All styles inline for this page so the mesh/grain/glass feel
          stays self-contained and doesn't leak into the app shell. */}
      <style>{loginCss}</style>
    </div>
  );
}

const loginCss = `
.erp-login-root {
  position: fixed; inset: 0;
  background: #0B0807;
  color: #F5EEE2;
  font-family: 'Source Sans 3', system-ui, -apple-system, sans-serif;
  overflow: hidden;
}
.erp-login-mesh {
  position: fixed; inset: 0;
  pointer-events: none; z-index: 0;
  background:
    radial-gradient(800px 600px at 18% 20%, rgba(226, 106, 76, 0.22), transparent 60%),
    radial-gradient(700px 500px at 85% 10%, rgba(212, 165, 116, 0.16), transparent 60%),
    radial-gradient(900px 700px at 70% 90%, rgba(154, 76, 56, 0.18), transparent 60%),
    radial-gradient(600px 500px at 10% 90%, rgba(86, 50, 38, 0.22), transparent 60%);
  animation: erpLoginDrift 24s ease-in-out infinite alternate;
  filter: saturate(1.1);
}
@keyframes erpLoginDrift {
  0%   { transform: translate3d(0, 0, 0) scale(1); }
  50%  { transform: translate3d(-18px, 10px, 0) scale(1.04); }
  100% { transform: translate3d(12px, -8px, 0) scale(1); }
}
.erp-login-grain {
  position: fixed; inset: 0;
  pointer-events: none; z-index: 0;
  opacity: .06; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.9'/></svg>");
}
.erp-login-stage {
  position: relative; z-index: 5;
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 40px 20px;
}
.erp-login-card {
  width: 100%; max-width: 440px;
  padding: 44px 40px 36px;
  background: rgba(26, 23, 19, 0.72);
  backdrop-filter: blur(24px) saturate(140%);
  -webkit-backdrop-filter: blur(24px) saturate(140%);
  border: 1px solid rgba(245, 238, 226, 0.10);
  border-radius: 20px;
  box-shadow:
    0 30px 80px rgba(0, 0, 0, 0.50),
    inset 0 1px 0 rgba(245, 238, 226, 0.05);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(18px) scale(.985);
  animation: erpLoginCardIn 1.1s cubic-bezier(.2, .7, .2, 1) .15s forwards;
}
.erp-login-card::before {
  content: '';
  position: absolute; inset: 0 0 auto 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(226, 106, 76, 0.55), transparent);
}
@keyframes erpLoginCardIn {
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.erp-login-h {
  font-family: 'Source Sans 3', sans-serif;
  font-optical-sizing: auto;
  font-size: 32px;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: #F5EEE2;
  margin: 0 0 6px;
}
.erp-login-sub {
  font-family: 'Source Sans 3', sans-serif;
  font-style: italic;
  font-size: 14.5px;
  color: #8F8372;
  margin-bottom: 32px;
}
.erp-login-label {
  font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
  color: #8F8372 !important; font-weight: 500;
}
.erp-login-input.ant-input-affix-wrapper {
  background: rgba(11, 8, 7, 0.55) !important;
  border: 1px solid rgba(245, 238, 226, 0.12) !important;
  border-radius: 9px !important;
  height: 48px !important;
  padding: 0 14px !important;
  color: #F5EEE2 !important;
  box-shadow: none !important;
  transition: border-color .15s, box-shadow .15s, background .15s;
}
.erp-login-input .ant-input {
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  color: #F5EEE2 !important;
  font-size: 15px !important;
  padding: 0 !important;
  height: auto !important;
}
.erp-login-input .ant-input-prefix { margin-inline-end: 10px; }
.erp-login-input .ant-input-suffix { margin-inline-start: 10px; }
.erp-login-input.ant-input-affix-wrapper:hover { border-color: rgba(245, 238, 226, 0.22) !important; }
.erp-login-input.ant-input-affix-wrapper-focused,
.erp-login-input.ant-input-affix-wrapper:focus-within {
  border-color: rgba(226, 106, 76, 0.6) !important;
  box-shadow: 0 0 0 3px rgba(226, 106, 76, 0.14) !important;
  background: rgba(11, 8, 7, 0.75) !important;
}
.erp-login-input input::placeholder,
.erp-login-input .ant-input::placeholder { color: #6D6355 !important; }
.erp-login-input .ant-input-password-icon { color: #8F8372 !important; }
.erp-login-btn.ant-btn {
  height: 50px !important;
  margin-top: 8px;
  background: linear-gradient(135deg, #E26A4C, #B1472F) !important;
  border: none !important;
  border-radius: 9px !important;
  color: #FDFAF2 !important;
  font-weight: 600 !important;
  font-size: 15px !important;
  letter-spacing: 0.02em;
  box-shadow:
    0 14px 30px rgba(226, 106, 76, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
  transition: all .2s !important;
}
.erp-login-btn.ant-btn:hover {
  transform: translateY(-1px);
  box-shadow:
    0 18px 40px rgba(226, 106, 76, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.18) !important;
  filter: brightness(1.03);
}
.erp-login-btn.ant-btn:active { transform: translateY(0); }
.erp-login-kbd {
  display: inline-flex; align-items: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 3px;
  padding: 2px 6px;
  margin-left: 8px;
  letter-spacing: 0;
}
.erp-login-hint {
  margin-top: 20px;
  padding: 13px 15px;
  background: rgba(245, 238, 226, 0.04);
  border: 1px solid rgba(245, 238, 226, 0.08);
  border-radius: 9px;
  display: flex; align-items: center; gap: 11px;
}
.erp-login-hint-ico {
  width: 30px; height: 30px;
  display: grid; place-items: center;
  background: rgba(212, 165, 116, 0.16);
  color: #D4A574;
  border-radius: 7px;
  font-size: 14px;
  flex-shrink: 0;
}
.erp-login-hint-text {
  font-family: 'Source Sans 3', sans-serif; font-style: italic;
  font-size: 13px; color: #B2A791;
  line-height: 1.5;
}
.erp-login-hint-text code {
  font-family: 'JetBrains Mono', monospace;
  font-style: normal;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(245, 238, 226, 0.08);
  border-radius: 3px; padding: 1px 6px;
  color: #F5EEE2;
}

/* Form labels: override AntD's dark label color */
.erp-login-root .ant-form-item-label > label {
  color: #8F8372 !important;
  font-size: 11px !important; letter-spacing: 1.5px !important;
  text-transform: uppercase !important; font-weight: 500 !important;
}

/* ── Company picker (dropdown) ──────────────────────────────────── */
.erp-login-picker {
  margin-bottom: 22px;
}
.erp-login-pick-wrap {
  position: relative;
}

/* Trigger — the always-visible button. Same height as form inputs so
   the layout reads as one unified column. */
.erp-login-pick-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  height: 48px;
  border-radius: 9px;
  border: 1px solid rgba(245, 238, 226, 0.12);
  background: rgba(11, 8, 7, 0.55);
  color: #F5EEE2;
  cursor: pointer;
  font-family: inherit;
  font-size: 15px;
  text-align: left;
  transition: border-color .15s, background .15s;
  outline: none;
}
.erp-login-pick-trigger:hover,
.erp-login-pick-trigger:focus-visible {
  border-color: var(--accent, #21604C);
  background: rgba(245, 238, 226, 0.04);
}
.erp-login-pick-icon {
  width: 28px; height: 28px;
  flex-shrink: 0;
  border-radius: 7px;
  background: var(--accent, #21604C);
  color: #F5EEE2;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px;
}
.erp-login-pick-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  letter-spacing: -0.1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.erp-login-pick-tag {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  padding: 1px 5px;
  border-radius: 6px;
  background: rgba(245, 238, 226, 0.10);
  color: #D4A574;
  flex-shrink: 0;
}
.erp-login-pick-key {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: #8F8372;
  background: rgba(0, 0, 0, 0.35);
  padding: 2px 7px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  flex-shrink: 0;
}
.erp-login-pick-chev {
  font-size: 9px;
  color: #8F8372;
  margin-left: -4px;
  flex-shrink: 0;
}

/* Click-outside scrim — invisible, full-viewport, captures clicks
   that aren't on the dropdown so it dismisses cleanly. */
.erp-login-pick-scrim {
  position: fixed;
  inset: 0;
  z-index: 5;
}

/* Dropdown panel — absolute under the trigger, full-width of the
   trigger, scrolls if companies > ~5. */
.erp-login-pick-list {
  position: absolute;
  top: calc(100% + 6px);
  left: 0; right: 0;
  z-index: 10;
  margin: 0; padding: 6px;
  list-style: none;
  background: rgba(26, 23, 19, 0.96);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(245, 238, 226, 0.12);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  max-height: 280px;
  overflow-y: auto;
  animation: erpLoginPickIn 140ms cubic-bezier(.2, .7, .2, 1);
}
@keyframes erpLoginPickIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.erp-login-pick-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: #F5EEE2;
  cursor: pointer;
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  transition: background .12s;
}
.erp-login-pick-item:hover {
  background: rgba(245, 238, 226, 0.06);
}
/* Keyboard-highlighted item — when the user navs with arrow keys.
   Distinct from .sel (committed) and from :hover (mouse). The accent
   ring on the left edge mirrors how classic accounting software indicates the
   currently-focused row in its menus. */
.erp-login-pick-item.hl {
  background: rgba(245, 238, 226, 0.08);
  box-shadow: inset 3px 0 0 var(--accent, #21604C);
}
.erp-login-pick-item.sel {
  background: color-mix(in srgb, var(--accent, #21604C) 18%, transparent);
}
.erp-login-pick-item.sel.hl {
  background: color-mix(in srgb, var(--accent, #21604C) 26%, transparent);
}
.erp-login-pick-item.sel::before {
  content: '✓';
  position: absolute;
  margin-left: -22px;
  margin-top: 1px;
  font-size: 12px;
  color: var(--accent, #21604C);
  font-weight: 700;
}
`;
