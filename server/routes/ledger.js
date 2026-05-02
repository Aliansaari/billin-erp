const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ledgerController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/accounts',   requirePermission('accounts.view'), ctrl.listAccounts);
router.get('/integrity',  requirePermission('accounts.view'), ctrl.integrity);

// Ledger statement — voucher-level account-of-record view. Backs the
// Customer Statement / Supplier Statement / Ledger pages. The party
// flavor is ordered FIRST so the more-specific path is matched before
// Express tries to route /by-party/<id> as /:ledger_id (the parseInt
// would fail and 400 anyway, but explicit ordering reads clearer).
router.get('/statement/by-party/:party_id', requirePermission('accounts.view'), ctrl.statementByParty);
router.get('/statement/:ledger_id',         requirePermission('accounts.view'), ctrl.statement);
// R8 Phase 2 — auto-receipt I1-I6 invariants for the admin
// Integrity screen.
router.get('/auto-receipt-integrity', requirePermission('accounts.view'), ctrl.autoReceiptIntegrity);
router.get('/unposted',   requirePermission('accounts.view'), ctrl.unposted);
// Reconcile is a write operation that posts to ledger_entries. Reuses the
// same accounts.view perm as the rest of this router (the codebase has no
// finer-grained accounts.edit perm yet — JV create/update/delete all gate
// on accounts.view too). Tighten when the perm taxonomy expands.
router.post('/reconcile', requirePermission('accounts.view'), ctrl.reconcile);

module.exports = router;
