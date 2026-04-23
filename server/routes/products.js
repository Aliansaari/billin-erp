const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Read endpoints are covered by inventory.view. Even a Salesman needs to
// be able to look products up to add them to a sales bill.
router.get('/',                   requirePermission('inventory.view'),   productController.getAll);
router.get('/low-stock',          requirePermission('inventory.view'),   productController.getLowStock);
router.get('/next-barcode',       requirePermission('inventory.create'), productController.getNextBarcode);
router.get('/barcode/:barcode',   requirePermission('inventory.view'),   productController.getByBarcode);
router.get('/:id',                requirePermission('inventory.view'),   productController.getById);
router.get('/:id/stock-movement', requirePermission('inventory.view'),   productController.getStockMovement);
router.post('/',                  requirePermission('inventory.create'), productController.create);
router.put('/:id',                requirePermission('inventory.edit'),   productController.update);
router.post('/:id/adjust',        requirePermission('inventory.edit'),   productController.adjust);
router.delete('/:id',             requirePermission('inventory.delete'), productController.delete);

module.exports = router;
