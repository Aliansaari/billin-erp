const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/salesReturnController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',              requirePermission('sales_returns.view'),   ctrl.getAll);
router.get('/reference/:id', requirePermission('sales_returns.view'),   ctrl.getReferenceBill);
router.get('/:id',           requirePermission('sales_returns.view'),   ctrl.getById);
router.post('/',             requirePermission('sales_returns.create'), ctrl.create);
router.put('/:id',           requirePermission('sales_returns.edit'),   ctrl.update);
router.post('/:id/cancel',   requirePermission('sales_returns.delete'), ctrl.cancel);

module.exports = router;
