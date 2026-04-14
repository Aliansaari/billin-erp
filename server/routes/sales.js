const express = require('express');
const router = express.Router();
const salesController = require('../controllers/salesController');
const { authenticateToken } = require('../middleware/auth');
const { checkPermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/', salesController.getAll);
router.get('/:id', salesController.getById);
router.post('/', checkPermission('Admin', 'Manager', 'Cashier'), salesController.create);
router.put('/:id', checkPermission('Admin', 'Manager', 'Cashier'), salesController.update);
router.post('/:id/cancel', checkPermission('Admin', 'Manager'), salesController.cancel);

module.exports = router;
