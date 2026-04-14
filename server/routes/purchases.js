const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchaseController');
const { authenticateToken } = require('../middleware/auth');
const { checkPermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/', purchaseController.getAll);
router.get('/:id', purchaseController.getById);
router.post('/', checkPermission('Admin', 'Manager', 'Inventory Staff'), purchaseController.create);
router.put('/:id', checkPermission('Admin', 'Manager', 'Inventory Staff'), purchaseController.update);
router.post('/:id/cancel', checkPermission('Admin', 'Manager'), purchaseController.cancel);

module.exports = router;
