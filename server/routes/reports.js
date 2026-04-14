const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

router.get('/dashboard', reportController.dashboardStats);
router.get('/sales', reportController.salesReport);
router.get('/purchases', reportController.purchaseReport);
router.get('/stock', reportController.stockReport);
router.get('/profit-loss', reportController.profitLoss);
router.get('/party-outstanding', reportController.partyOutstanding);

module.exports = router;
