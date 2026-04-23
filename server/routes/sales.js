const express = require('express');
const router = express.Router();
const salesController = require('../controllers/salesController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',            requirePermission('sales.view'),   salesController.getAll);
router.get('/:id',         requirePermission('sales.view'),   salesController.getById);
router.post('/',           requirePermission('sales.create'), salesController.create);
router.put('/:id',         requirePermission('sales.edit'),   salesController.update);
router.post('/:id/cancel', requirePermission('sales.delete'), salesController.cancel);

module.exports = router;
