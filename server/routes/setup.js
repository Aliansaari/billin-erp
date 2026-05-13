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

router.post('/provision', express.json({ limit: '8kb' }), async (req, res) => {
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
