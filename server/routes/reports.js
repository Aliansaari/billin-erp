const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const financialReports = require('../controllers/financialReportsController');
const operationalReports = require('../controllers/operationalReportsController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Phase R1 — Trial Balance + Balance Sheet. Gated on accounts.view
// (same as profit-loss) since these surface ledger-level data.
router.get('/trial-balance',      requirePermission('accounts.view'), financialReports.trialBalance);
router.get('/balance-sheet',      requirePermission('accounts.view'), financialReports.balanceSheet);
router.get('/cash-flow',          requirePermission('accounts.view'), financialReports.cashFlow);
// /receivables-aging + /payables-aging removed in Phase R5 follow-up.
// Use /api/reports/aging?party_type=Customer|Supplier (single source).

// Phase R3 — Operational registers + summaries.
router.get('/sales-register',     requirePermission('reports.view'),  operationalReports.salesRegister);
router.get('/purchase-register',  requirePermission('reports.view'),  operationalReports.purchaseRegister);
router.get('/hsn-summary',        requirePermission('reports.view'),  operationalReports.hsnSummary);
router.get('/stock-summary',      requirePermission('reports.view'),  operationalReports.stockSummary);
router.get('/movers',             requirePermission('reports.view'),  operationalReports.movers);

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
router.get('/gstr3b',            requirePermission('reports.view'),  reportController.gstr3bReport);

router.get('/sales/export',             requirePermission('reports.view'),  reportController.exportSalesReport);
router.get('/purchases/export',         requirePermission('reports.view'),  reportController.exportPurchaseReport);
router.get('/stock/export',             requirePermission('reports.view'),  reportController.exportStockReport);
router.get('/party-outstanding/export', requirePermission('reports.view'),  reportController.exportPartyOutstanding);
router.get('/aging/export',             requirePermission('reports.view'),  reportController.exportAgingReport);
router.get('/gstr1/export',             requirePermission('reports.view'),  reportController.exportGstr1Report);
router.get('/gstr3b/export',            requirePermission('reports.view'),  reportController.exportGstr3bReport);

module.exports = router;
