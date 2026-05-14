// ── Banks routes ──────────────────────────────────────────────────────
//
// Bank-flavoured surface over ledger accounts under sub_group
// 'Bank Accounts' / 'Bank OD A/c'. See controllers/bankController.js
// for the full data shape.

const express = require('express');
const router = express.Router();
const bank = require('../controllers/bankController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Audit AUTH-5 — split the read-and-write surfaces.
//   accounts.view    → read-only access (list, statement, reconcile view)
//   accounts.manage  → mutate (create/edit/delete bank, mark cleared)
//
// `hasPermission` falls back to a parent module grant when the leaf
// doesn't exist, so existing 'accounts: true' role templates still
// allow management — only roles that EXPLICITLY have only
// 'accounts.view: true' will be restricted from mutations.
//
// Order matters: /reconciliation must be declared before
// /:ledger_id/statement, otherwise Express's param-segment match would
// route a path like /reconciliation as ledger_id='reconciliation' and
// hand it to bankStatement instead.
router.get('/',                          requirePermission('accounts.view'),   bank.listBanks);
router.get('/reconciliation',            requirePermission('accounts.view'),   bank.reconciliation);
router.get('/:ledger_id/statement',      requirePermission('accounts.view'),   bank.bankStatement);
router.post('/clear/:transaction_id',    requirePermission('accounts.manage'), bank.markCleared);
router.post('/unclear/:transaction_id',  requirePermission('accounts.manage'), bank.markUncleared);

// Lifecycle (create / edit / activate-deactivate / delete).
router.post('/',                         requirePermission('accounts.manage'), bank.createBank);
router.patch('/:ledger_id',              requirePermission('accounts.manage'), bank.updateBank);
router.delete('/:ledger_id',             requirePermission('accounts.manage'), bank.deleteBank);

module.exports = router;
