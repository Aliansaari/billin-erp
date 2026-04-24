const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Dashboard is informational and visible to anyone who can log in — it
// doesn't expose bill-level data, just the stats already derivable from
// their module perms. Gate the specific reports themselves.
router.get('/dashboard', reportController.dashboardStats);

router.get('/sales',             requirePermission('reports.view'),  reportController.salesReport);
router.get('/purchases',         requirePermission('reports.view'),  reportController.purchaseReport);
router.get('/stock',             requirePermission('reports.view'),  reportController.stockReport);
router.get('/profit-loss',       requirePermission('accounts.view'), reportController.profitLoss);
router.get('/party-outstanding', requirePermission('reports.view'),  reportController.partyOutstanding);
router.get('/aging',             requirePermission('reports.view'),  reportController.agingReport);
router.get('/gstr1',             requirePermission('reports.view'),  reportController.gstr1Report);

router.get('/sales/export',             requirePermission('reports.view'),  reportController.exportSalesReport);
router.get('/purchases/export',         requirePermission('reports.view'),  reportController.exportPurchaseReport);
router.get('/stock/export',             requirePermission('reports.view'),  reportController.exportStockReport);
router.get('/party-outstanding/export', requirePermission('reports.view'),  reportController.exportPartyOutstanding);
router.get('/aging/export',             requirePermission('reports.view'),  reportController.exportAgingReport);
router.get('/gstr1/export',             requirePermission('reports.view'),  reportController.exportGstr1Report);

module.exports = router;
