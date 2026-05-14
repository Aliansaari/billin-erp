/**
 * First-run setup routes — called by the PostgresSetup wizard during
 * fresh installs. None of these endpoints require auth (the gate
 * exempts /api/setup/*) because at this stage the DB doesn't even
 * exist yet, so there's no admin user to authenticate against.
 *
 * Once `provision` returns successfully, the server still needs a
 * RESTART before sequelize picks up the new credentials — restart is
 * coordinated by the Electron main process which spawns the server
 * as a child. For browser-only / standalone server deployments, the
 * vendor restarts manually.
 */
const express = require('express');
const router  = express.Router();
const setup   = require('../services/setup');

router.get('/status', (req, res) => {
  res.json({
    setup_complete: setup.isSetupComplete(),
    config_path: setup.CONFIG_PATH,
  });
});

router.get('/detect-postgres', (req, res) => {
  res.json(setup.detectPostgres());
});

router.post('/test-connection', express.json({ limit: '8kb' }), async (req, res) => {
  const r = await setup.testConnection(req.body || {});
  res.json(r);
});

// Audit AUTH-2 — provision is loopback-only. The setup wizard runs in
// Electron's main window which talks to the server over loopback, so
// the legitimate flow is unaffected. A LAN client racing to provision
// from outside the host machine is rejected with a clear 403.
//
// Pre-fix, any LAN client could POST attacker-controlled Postgres
// credentials and a JWT_SECRET that would be persisted to disk, then
// the operator's next boot would silently run under attacker control.
// C19's marker-file probe is a backstop for "already provisioned"
// cases; this new check stops the race window on a brand-new install.
function isLoopback(req) {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
router.post('/provision', express.json({ limit: '8kb' }), async (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({
      ok: false,
      error: 'First-run setup must be performed from the server machine itself (loopback only).',
    });
  }
  try {
    // Audit C19 — marker file says setup is done? Refuse before touching
    // Postgres. Provision itself ALSO probes the master DB for user rows
    // (defense-in-depth in case the marker file was deleted), but the
    // route-level check is the cheap fast-path.
    if (setup.isSetupComplete()) {
      return res.status(409).json({
        ok: false,
        error: 'Setup has already been completed on this machine. Re-provisioning is not allowed.',
      });
    }
    const r = await setup.provision(req.body || {});
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
