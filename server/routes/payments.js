const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',              requirePermission('payments.view'),   paymentController.getAll);
router.get('/next-number',   requirePermission('payments.create'), paymentController.getNextNumber);
router.get('/unpaid-bills',  requirePermission('payments.view'),   paymentController.getUnpaidBills);
router.get('/:id',           requirePermission('payments.view'),   paymentController.getById);
router.post('/',             requirePermission('payments.create'), paymentController.create);
router.put('/:id',           requirePermission('payments.create'), paymentController.update);
router.post('/:id/cancel',   requirePermission('payments.delete'), paymentController.cancel);

module.exports = router;
