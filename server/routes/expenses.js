const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/expenseController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// expenses.* perm path mirrors payments.* — view for read, create for
// new, edit for editing, delete for cancel. Server middleware is the
// source of truth; the frontend gates buttons but the API re-checks.
router.get('/next-number', requirePermission('expenses.create'), ctrl.getNextNumber);
router.get('/summary',     requirePermission('expenses.view'),   ctrl.getSummary);
router.get('/',            requirePermission('expenses.view'),   ctrl.getAll);
router.get('/:id',         requirePermission('expenses.view'),   ctrl.getById);
router.post('/',           requirePermission('expenses.create'), ctrl.create);
router.put('/:id',         requirePermission('expenses.edit'),   ctrl.update);
router.post('/:id/cancel', requirePermission('expenses.delete'), ctrl.cancel);

module.exports = router;
