const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/purchaseDraftController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Reuse existing purchase perms — no new permission keys needed.
router.get('/',          requirePermission('purchase.view'),   ctrl.list);
router.get('/:id',       requirePermission('purchase.view'),   ctrl.getById);
router.post('/',         requirePermission('purchase.create'), ctrl.create);
router.put('/:id',       requirePermission('purchase.create'), ctrl.update);
router.delete('/:id',    requirePermission('purchase.delete'), ctrl.delete);

module.exports = router;
