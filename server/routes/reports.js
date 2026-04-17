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

// Filter-aware XLSX exports — accept the same query params as the JSON endpoint
// above and stream a workbook covering the entire filtered dataset.
router.get('/sales/export',             reportController.exportSalesReport);
router.get('/purchases/export',         reportController.exportPurchaseReport);
router.get('/stock/export',             reportController.exportStockReport);
router.get('/party-outstanding/export', reportController.exportPartyOutstanding);

module.exports = router;
