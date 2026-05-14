// ── Loans routes ──────────────────────────────────────────────────────
//
// Loan-flavoured surface over ledger accounts under sub_groups
// 'Loans (Liability)' / 'Loans & Advances (Asset)', with EMI tracking.
// See controllers/loanController.js for the data shapes.

const express = require('express');
const router = express.Router();
const loan = require('../controllers/loanController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Audit AUTH-5 — split read vs write permissions on loans. Read-only
// users (accounts.view) can list/inspect/print loan statements;
// mutators (accounts.manage) can create, edit, delete, post EMIs.
//
// Order matters: /upcoming and /calculate must come BEFORE /:ledger_id
// so the static paths don't get parsed as ledger ids.
router.get('/',                          requirePermission('accounts.view'),   loan.listLoans);
router.get('/upcoming',                  requirePermission('accounts.view'),   loan.upcomingEmis);
router.get('/calculate',                 requirePermission('accounts.view'),   loan.calculateEmi);
router.get('/:ledger_id/statement',      requirePermission('accounts.view'),   loan.loanStatement);
router.get('/:ledger_id/schedule',       requirePermission('accounts.view'),   loan.loanSchedule);
router.post('/',                         requirePermission('accounts.manage'), loan.createLoan);
router.patch('/:ledger_id',              requirePermission('accounts.manage'), loan.updateLoan);
router.delete('/:ledger_id',             requirePermission('accounts.manage'), loan.deleteLoan);
router.post('/:ledger_id/emi',           requirePermission('accounts.manage'), loan.recordEMI);
router.post('/:ledger_id/emi/reverse',   requirePermission('accounts.manage'), loan.reverseEMI);

module.exports = router;
