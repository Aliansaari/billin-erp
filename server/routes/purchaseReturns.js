const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/purchaseReturnController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',              requirePermission('purchase_returns.view'),   ctrl.getAll);
router.get('/reference/:id', requirePermission('purchase_returns.view'),   ctrl.getReferenceBill);
router.get('/:id',           requirePermission('purchase_returns.view'),   ctrl.getById);
router.post('/',             requirePermission('purchase_returns.create'), ctrl.create);
router.put('/:id',           requirePermission('purchase_returns.edit'),   ctrl.update);
router.post('/:id/cancel',   requirePermission('purchase_returns.delete'), ctrl.cancel);

module.exports = router;
