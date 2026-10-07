const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchaseController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',            requirePermission('purchase.view'),   purchaseController.getAll);
// Before '/:id' so the path isn't read as a bill id.
router.get('/check-supplier-bill', requirePermission('purchase.view'), purchaseController.checkSupplierBill);
router.get('/:id',         requirePermission('purchase.view'),   purchaseController.getById);
router.post('/',           requirePermission('purchase.create'), purchaseController.create);
router.put('/:id',         requirePermission('purchase.edit'),   purchaseController.update);
router.post('/:id/cancel', requirePermission('purchase.delete'), purchaseController.cancel);

module.exports = router;
