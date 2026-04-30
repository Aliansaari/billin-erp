const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ledgerController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/accounts',   requirePermission('accounts.view'), ctrl.listAccounts);
router.get('/integrity',  requirePermission('accounts.view'), ctrl.integrity);
router.get('/unposted',   requirePermission('accounts.view'), ctrl.unposted);
// Reconcile is a write operation that posts to ledger_entries. Reuses the
// same accounts.view perm as the rest of this router (the codebase has no
// finer-grained accounts.edit perm yet — JV create/update/delete all gate
// on accounts.view too). Tighten when the perm taxonomy expands.
router.post('/reconcile', requirePermission('accounts.view'), ctrl.reconcile);

module.exports = router;
