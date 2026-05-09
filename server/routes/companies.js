const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/companyController');
const { authenticateToken } = require('../middleware/auth');

/* ── Companies routes ─────────────────────────────────────────────────
 *
 * /list-public          PUBLIC — no auth. Used by the login screen
 *                       to populate the company picker BEFORE the
 *                       user has any credentials. Returns only safe
 *                       metadata (id, name, logo, accent) — no GSTIN,
 *                       no audit data.
 *
 * Everything else requires a valid JWT.
 *
 * NOTE: developer-mode gating for create / settings is enforced via a
 * server-side flag check inside the controller, not via a route guard.
 * This keeps the API consistent (all callers get clean JSON errors)
 * and allows a future "dev mode for one user only" granularity if
 * needed later. The frontend already hides these surfaces from
 * non-developers via the system_settings flags.
 */

// Public — no auth (login picker).
router.get('/list-public', ctrl.listPublic);

// Authenticated — full metadata for the topbar / Manage page.
router.get('/',                authenticateToken, ctrl.list);
router.post('/',               authenticateToken, ctrl.create);
router.patch('/:id',           authenticateToken, ctrl.update);
router.delete('/:id',          authenticateToken, ctrl.softDelete);

// Master cap — read by Developer Settings to render the input,
// written when the developer changes it.
router.get('/settings/max-cap', authenticateToken, ctrl.getMaxCompaniesCap);
router.put('/settings/max-cap', authenticateToken, ctrl.setMaxCompaniesCap);

module.exports = router;
