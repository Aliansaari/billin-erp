const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/companyController');
const { authenticateToken } = require('../middleware/auth');
const { checkPermission } = require('../middleware/permissions');

/* ── Companies routes ─────────────────────────────────────────────────
 *
 * /list-public          PUBLIC — no auth. Used by the login screen
 *                       to populate the company picker BEFORE the
 *                       user has any credentials. Returns only safe
 *                       metadata (id, name, logo, accent) — no GSTIN,
 *                       no audit data.
 *
 * Everything else requires a valid JWT. Audit C18 — write routes
 * additionally require the Admin or Super Admin role: prior to this fix
 * any logged-in user (including a Salesman) could POST to create a new
 * Postgres database, PATCH an existing company, DELETE one, or set the
 * master cap. The frontend already hides these surfaces, but a hostile
 * client direct-API call had no server-side block.
 */

// Public — no auth (login picker).
router.get('/list-public', ctrl.listPublic);

// Authenticated — full metadata for the topbar / Manage page.
router.get('/',                authenticateToken, ctrl.list);
router.post('/',               authenticateToken, checkPermission('Super Admin', 'Admin'), ctrl.create);
router.patch('/:id',           authenticateToken, checkPermission('Super Admin', 'Admin'), ctrl.update);
router.delete('/:id',          authenticateToken, checkPermission('Super Admin', 'Admin'), ctrl.softDelete);
// Hard-delete is a destructive, irreversible operation — drops the
// per-company PostgreSQL database, removes branding files, deletes the
// master row. Same role gate as softDelete; controller additionally
// requires `confirm_name` in the body to match the company's name.
router.post('/:id/hard-delete', authenticateToken, checkPermission('Super Admin', 'Admin'), ctrl.hardDelete);

// Per-company backup — streams an encrypted .enc backup file for the
// specified company, regardless of the caller's active session. Used by
// the delete-company modal's "Back up first" button so the operator
// doesn't have to switch into the company to get its data out.
router.post('/:id/backup', authenticateToken, checkPermission('Super Admin', 'Admin'), ctrl.backupCompany);

// Master cap — read by Developer Settings to render the input,
// written when the developer changes it.
router.get('/settings/max-cap', authenticateToken, checkPermission('Super Admin', 'Admin'), ctrl.getMaxCompaniesCap);
router.put('/settings/max-cap', authenticateToken, checkPermission('Super Admin', 'Admin'), ctrl.setMaxCompaniesCap);

module.exports = router;
