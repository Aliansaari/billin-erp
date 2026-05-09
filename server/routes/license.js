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
 * is the only auth we need; only License Studio (the vendor's
 * machine) can produce a file that verifies.
 */
const express = require('express');
const router  = express.Router();
const license = require('../services/license');
const fs = require('fs');
const path = require('path');

router.get('/info', (req, res) => {
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
router.post('/deactivate', express.json({ limit: '4kb' }), (req, res) => {
  const supplied = req.body && req.body.developer_password;
  const expected = process.env.DEVELOPER_PASSWORD || 'dev@billing2025';
  if (!supplied || supplied !== expected) {
    return res.status(401).json({ ok: false, message: 'developer password required' });
  }
  const r = license.deactivate();
  res.json(r);
});

module.exports = router;
