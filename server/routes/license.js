/**
 * License routes — onboarding + status + vendor tooling.
 *
 * GET  /info               — { activated, status }; no auth required
 * POST /activate           — accepts a license envelope or file content
 * POST /deactivate         — vendor-only, requires DEVELOPER_PASSWORD
 * GET  /machine-fingerprint — read your machine fp (handy for vendor support)
 *
 * Activation is intentionally OPEN (no auth) because at activation
 * time there's no user session yet — the app is locked at the
 * activation screen. The cryptographic signature check on the file
 * is the only auth we need; only ZEHEN License Studio (the vendor's
 * machine) can produce a file that verifies.
 */
const express = require('express');
const router  = express.Router();
const license = require('../services/license');
const fs = require('fs');
const path = require('path');

// Same gate as middleware/licenseGate.js: bypass only honored in dev (non-
// packaged) builds. Audit P2-H — closes the env-var bypass attack on
// shipping .exe installs.
function _isPackagedBuild() {
  try { const { app } = require('electron'); return !!(app && app.isPackaged); }
  catch { return false; }
}

router.get('/info', (req, res) => {
  // Dev-only escape hatch — when BILLING_ERP_BYPASS_LICENSE=1, report
  // the install as activated so the frontend skips the activation
  // screen. Matches the licenseGate bypass in middleware/licenseGate.js.
  if (process.env.BILLING_ERP_BYPASS_LICENSE === '1' && !_isPackagedBuild()) {
    return res.json({
      activated: true,
      status: { ok: true, code: 'bypassed', expires_at: '2099-12-31', customer_name: 'Developer (bypass)' },
      machine_fp: license.machineFingerprint(),
    });
  }
  const s = license.getStatus({ force: false });
  res.json({
    activated: !!s.ok,
    status:    s,
    machine_fp: license.machineFingerprint(),
  });
});

router.get('/machine-fingerprint', (req, res) => {
  res.json({ machine_fp: license.machineFingerprint() });
});

router.post('/activate', express.json({ limit: '128kb' }), (req, res) => {
  const text = (req.body && (req.body.license || req.body.envelope)) || null;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ ok: false, message: 'license envelope required (paste the .dat content as the "license" field)' });
  }
  const r = license.activateFromEnvelope(text);
  if (!r.ok) {
    return res.status(400).json(r);
  }
  res.json(r);
});

/**
 * Vendor-only deactivation. Requires the developer password from the
 * env so a customer can't accidentally clear their own license. We
 * compare here rather than going through the auth/dev-verify route
 * because at activation time the auth middleware would block us
 * (no user / no license).
 */
// Audit AUTH-1 — restrict to loopback only.
//
// The /deactivate endpoint MUST stay unauthenticated because it's the
// recovery path for an expired-license install (user is locked out of
// login by the license gate, so they can't authenticate first). The
// audit finding was that any LAN client could hit it with the public
// default password and brick the install.
//
// Fix: only accept the call when the request originates from loopback
// (localhost on the same machine). A LAN-connected client can't reach
// it any more, but a local admin sitting at the host can — exactly the
// audience that should be doing license recovery.
//
// Defense-in-depth: still requires the developer password on top of
// the loopback check. Either layer alone breaking doesn't grant
// recovery; both must succeed.
function isLoopback(req) {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
router.post('/deactivate', express.json({ limit: '4kb' }), (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({
      ok: false,
      message: 'License deactivation must be performed from the server machine itself (loopback only).',
    });
  }
  const supplied = req.body && req.body.developer_password;
  // Hardcoded ship-default — same as authController.SHIPPED_DEFAULT_DEV_PASSWORD.
  // Audit C15: the previously-published default 'dev@billing2025' is in repo
  // history and the audit report, so every install using it is exposed. New
  // value here is not in any public repo / blogpost. An integrator can still
  // override per-install via DEVELOPER_PASSWORD env var if they want extra
  // hardening; absent that, this default applies.
  const expected = process.env.DEVELOPER_PASSWORD || 'DragonStone@2911';
  if (!supplied || supplied !== expected) {
    return res.status(401).json({ ok: false, message: 'developer password required' });
  }
  const r = license.deactivate();
  res.json(r);
});

module.exports = router;
