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

// All loan views are gated behind accounts.view — same gate as Bank /
// Ledger Statement. If you split a 'manage_loans' permission later
// this is the spot.
//
// Order matters: /upcoming and /calculate must come BEFORE /:ledger_id
// so the static paths don't get parsed as ledger ids.
router.get('/',                          requirePermission('accounts.view'), loan.listLoans);
router.get('/upcoming',                  requirePermission('accounts.view'), loan.upcomingEmis);
router.get('/calculate',                 requirePermission('accounts.view'), loan.calculateEmi);
router.get('/:ledger_id/statement',      requirePermission('accounts.view'), loan.loanStatement);
router.get('/:ledger_id/schedule',       requirePermission('accounts.view'), loan.loanSchedule);
router.post('/',                         requirePermission('accounts.view'), loan.createLoan);
router.patch('/:ledger_id',              requirePermission('accounts.view'), loan.updateLoan);
router.delete('/:ledger_id',             requirePermission('accounts.view'), loan.deleteLoan);
router.post('/:ledger_id/emi',           requirePermission('accounts.view'), loan.recordEMI);

module.exports = router;
