/**
 * License gate — runs BEFORE the auth middleware on every /api/* route
 * and full-blocks any request unless a valid license is on disk.
 *
 * Bypassed paths (always reachable, even without a license):
 *   GET  /api/health           — let healthchecks work for diagnostics
 *   GET  /api/server-info      — same
 *   GET  /api/license/info     — frontend reads this to show the screen
 *   POST /api/license/activate — drop-the-file flow during onboarding
 *   POST /api/license/deactivate — vendor tool, separately gated
 *
 * Every other request returns 403 with a structured body the frontend's
 * axios interceptor consumes:
 *
 *   { license_block: true, code, message, customer_id, expires_at }
 *
 * The `code` distinguishes the failure mode so the React app can show
 * the right screen (activate vs renew vs machine mismatch).
 *
 * Why FULL BLOCK (no soft / read-only mode):
 *   The customer's policy is "stop the app entirely on expiry". A soft
 *   block where data is readable but not editable is friendlier to the
 *   user but lets them still bill / sell silently in some cases. The
 *   vendor wants a hard wall: pay to renew, or the shop stops.
 */

const license = require('../services/license');

const BYPASS_PATHS = new Set([
  '/api/health',
  '/api/server-info',
  '/api/license/info',
  '/api/license/activate',
  '/api/license/deactivate',
  '/api/license/machine-fingerprint',
]);

function gate(req, res, next) {
  // Only gate /api/* — static assets and the SPA index.html should
  // always serve so the frontend can render the activation screen.
  if (!req.path.startsWith('/api/')) return next();

  if (BYPASS_PATHS.has(req.path)) return next();

  // /api/license/* and /api/setup/* prefixes are fully exempt — the
  // setup wizard runs BEFORE there's a license, and the license routes
  // are how the user activates one.
  if (req.path.startsWith('/api/license/')) return next();
  if (req.path.startsWith('/api/setup/'))   return next();

  const status = license.getStatus();
  if (status.ok) {
    // Surface key license bits on the request so downstream handlers
    // can reference the active customer if they want to (we don't
    // currently — just future-proofing).
    req.license = status;
    return next();
  }

  const body = {
    license_block: true,
    code:    status.code,
    message: friendlyMessage(status),
  };
  if (status.customer_id) body.customer_id = status.customer_id;
  if (status.customer_name) body.customer_name = status.customer_name;
  if (status.expires_at) body.expires_at = status.expires_at;

  return res.status(403).json(body);
}

function friendlyMessage(status) {
  switch (status.code) {
    case 'no_license':
      return 'No license has been activated on this installation.';
    case 'invalid_format':
      return 'License file is corrupted or in an unrecognized format.';
    case 'invalid_signature':
      return 'License signature is invalid. The file may have been edited.';
    case 'public_key_not_configured':
      return 'License verification key not configured on this build. Contact your vendor.';
    case 'expired':
      return `License expired on ${status.expires_at}. Contact your vendor to renew.`;
    case 'machine_mismatch':
      return 'This license is bound to a different machine. Contact your vendor for a fresh license.';
    case 'clock_tampered':
      return 'System clock has been changed. Set the correct date/time and try again.';
    default:
      return 'License check failed.';
  }
}

module.exports = { gate, BYPASS_PATHS };
