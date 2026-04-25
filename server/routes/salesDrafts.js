const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/salesDraftController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Reuse existing sales perms — no new permission keys needed.
router.get('/',          requirePermission('sales.view'),   ctrl.list);
router.get('/:id',       requirePermission('sales.view'),   ctrl.getById);
router.post('/',         requirePermission('sales.create'), ctrl.create);
router.put('/:id',       requirePermission('sales.create'), ctrl.update);
router.delete('/:id',    requirePermission('sales.delete'), ctrl.delete);

module.exports = router;
