const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/journalVoucherController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Gate every JV endpoint on accounts.view — the existing perm path that
// Admin / Super Admin have but Salesperson / Cashier don't. JV writes
// re-use the same gate for now; a finer-grained accounts.write key can
// be added later if accountant-without-admin role is introduced.
router.get('/',          requirePermission('accounts.view'),  ctrl.getAll);
router.get('/:id',       requirePermission('accounts.view'),  ctrl.getById);
router.post('/',         requirePermission('accounts.view'),  ctrl.create);
router.put('/:id',       requirePermission('accounts.view'),  ctrl.update);
router.delete('/:id',    requirePermission('accounts.view'),  ctrl.remove);

module.exports = router;
