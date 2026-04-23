const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchaseController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',            requirePermission('purchase.view'),   purchaseController.getAll);
router.get('/:id',         requirePermission('purchase.view'),   purchaseController.getById);
router.post('/',           requirePermission('purchase.create'), purchaseController.create);
router.put('/:id',         requirePermission('purchase.edit'),   purchaseController.update);
router.post('/:id/cancel', requirePermission('purchase.delete'), purchaseController.cancel);

module.exports = router;
