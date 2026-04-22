const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

router.get('/', paymentController.getAll);
router.get('/next-number', paymentController.getNextNumber);
router.get('/unpaid-bills', paymentController.getUnpaidBills);
router.get('/:id', paymentController.getById);
router.post('/', paymentController.create);
router.post('/:id/cancel', paymentController.cancel);

module.exports = router;
