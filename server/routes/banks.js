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

// All bank views require accounts.view — same gate as Ledger Statement,
// since the data is a re-shaping of the same ledger entries.
//
// Order matters: /reconciliation must be declared before
// /:ledger_id/statement, otherwise Express's param-segment match would
// route a path like /reconciliation as ledger_id='reconciliation' and
// hand it to bankStatement instead.
router.get('/',                          requirePermission('accounts.view'), bank.listBanks);
router.get('/reconciliation',            requirePermission('accounts.view'), bank.reconciliation);
router.get('/:ledger_id/statement',      requirePermission('accounts.view'), bank.bankStatement);
router.post('/clear/:transaction_id',    requirePermission('accounts.view'), bank.markCleared);
router.post('/unclear/:transaction_id',  requirePermission('accounts.view'), bank.markUncleared);

// Lifecycle (create / edit / activate-deactivate / delete). Gated on
// the same permission today; if you want a separate manage_banks perm
// later, this is the line to change.
router.post('/',                         requirePermission('accounts.view'), bank.createBank);
router.patch('/:ledger_id',              requirePermission('accounts.view'), bank.updateBank);
router.delete('/:ledger_id',             requirePermission('accounts.view'), bank.deleteBank);

module.exports = router;
