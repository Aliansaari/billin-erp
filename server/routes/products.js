const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

router.get('/', productController.getAll);
router.get('/low-stock', productController.getLowStock);
router.get('/next-barcode', productController.getNextBarcode);
router.get('/barcode/:barcode', productController.getByBarcode);
router.get('/:id', productController.getById);
router.get('/:id/stock-movement', productController.getStockMovement);
router.post('/', productController.create);
router.put('/:id', productController.update);
router.post('/:id/adjust', productController.adjust);
router.delete('/:id', productController.delete);

module.exports = router;
