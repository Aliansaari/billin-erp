/**
 * Remote Access routes — Settings → Remote Access.
 *
 *   GET  /status    current state (safe to poll; never touches the network)
 *   POST /enable    provision a tunnel for this PC and start it
 *   POST /disable   stop the tunnel; the site stays provisioned
 *   POST /pair      mint a short-lived pairing code to show as a QR
 *
 * Gated behind `settings.manage_company`, the same permission that guards the
 * LAN & Network page — turning a shop's books into something reachable from
 * the internet is squarely an owner-level decision, not a cashier's.
 */
const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const remoteAccess = require('../services/remoteAccess');

router.use(authenticateToken);

router.get('/status', requirePermission('settings.manage_company'), (req, res) => {
  res.json(remoteAccess.getStatus());
});

router.post('/enable', requirePermission('settings.manage_company'), async (req, res) => {
  try {
    const result = await remoteAccess.enable(req.body?.site_name);
    res.json({ ok: true, ...result, status: remoteAccess.getStatus() });
  } catch (e) {
    // Provisioning needs the internet; a shop that is offline right now gets a
    // plain explanation instead of a stack trace, and nothing else changes.
    res.status(502).json({ error: e.message || 'Could not enable remote access.' });
  }
});

router.post('/disable', requirePermission('settings.manage_company'), (req, res) => {
  res.json({ ok: true, ...remoteAccess.disable(), status: remoteAccess.getStatus() });
});

/**
 * Mint a pairing code for a phone. The code is short-lived and single-use;
 * the phone redeems it at the control plane for a device token, so the token
 * never travels through this server or sits in a QR image.
 */
router.post('/pair', requirePermission('settings.manage_company'), async (req, res) => {
  const status = remoteAccess.getStatus();
  if (!status.site_id) {
    return res.status(409).json({ error: 'Enable remote access before pairing a phone.' });
  }
  try {
    const upstream = await fetch(`${remoteAccess.CONTROL_PLANE_URL}/v1/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site_id: status.site_id }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(body.error || 'Pairing failed.');

    // The phone will redeem this within seconds. Pull the allow-list again
    // shortly so it can connect immediately instead of waiting out the
    // regular five-minute sync.
    remoteAccess.nudgeDeviceSync();

    res.json(body);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not create a pairing code.' });
  }
});

/**
 * App accounts — who may sign in to the mobile app for this shop.
 *
 * Proxied through this server rather than called from the browser directly,
 * because the request is authenticated by the installation's signed licence,
 * which must never leave the machine.
 */
router.post('/accounts', requirePermission('settings.manage_company'), async (req, res) => {
  const fs = require('fs');
  const license = require('../services/license');
  const { resolveLicensePath } = require('../config/license');

  let licenseText;
  try {
    licenseText = fs.readFileSync(resolveLicensePath(), 'utf8').trim();
  } catch {
    return res.status(409).json({ error: 'Activate a licence before managing app accounts.' });
  }

  try {
    const upstream = await fetch(`${remoteAccess.CONTROL_PLANE_URL}/v1/account/manage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...req.body,
        license: licenseText,
        machine_fp: license.machineFingerprint(),
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const body = await upstream.json().catch(() => ({}));
    // Pass the upstream status through so the UI can tell "already exists"
    // from "password too short" without parsing prose.
    res.status(upstream.status).json(body);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not reach the ZEHEN account service.' });
  }
});

/** ZEHEN users an app account can be linked to. */
router.get('/linkable-users', requirePermission('settings.manage_company'), async (req, res) => {
  try {
    const { User, Role } = require('../models');
    const users = await User.findAll({
      where: { is_active: true },
      include: [{ model: Role }],
      order: [['username', 'ASC']],
    });
    res.json({
      users: users.map((u) => ({
        username: u.username,
        full_name: u.full_name,
        role: u.Role?.role_name || null,
      })),
    });
  } catch (e) {
    // Log the real reason — an empty "Signs in as" dropdown in the UI is
    // otherwise indistinguishable from "this shop genuinely has no users".
    console.error('[remote-access] linkable-users failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not list users.' });
  }
});

module.exports = router;
