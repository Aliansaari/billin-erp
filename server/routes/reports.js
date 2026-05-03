const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const financialReports = require('../controllers/financialReportsController');
const operationalReports = require('../controllers/operationalReportsController');
const dayBookController = require('../controllers/dayBookController');
const billsOutstandingController = require('../controllers/billsOutstandingController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Phase R1 — Trial Balance + Balance Sheet. Gated on accounts.view
// (same as profit-loss) since these surface ledger-level data.
router.get('/trial-balance',      requirePermission('accounts.view'), financialReports.trialBalance);
router.get('/balance-sheet',      requirePermission('accounts.view'), financialReports.balanceSheet);
// Cash Flow — Tally-style three-level drill (register → month → group).
// The old `/cash-flow` endpoint was retired alongside the old CashFlow.jsx.
router.get('/cash-flow/monthly',  requirePermission('accounts.view'), financialReports.cashFlowMonthly);
router.get('/cash-flow/month',    requirePermission('accounts.view'), financialReports.cashFlowMonth);
router.get('/cash-flow/group',    requirePermission('accounts.view'), financialReports.cashFlowGroup);
// Fund Flow — Tally-style three-level drill (register → month → P&L).
//   /fund-flow/monthly   — month-by-month WC opening/closing/flow register
//   /fund-flow            — full Sources/Apps statement for ONE period; the
//                            month-summary view feeds it month-start..month-end
router.get('/fund-flow/monthly',  requirePermission('accounts.view'), financialReports.fundFlowMonthly);
router.get('/fund-flow',          requirePermission('accounts.view'), financialReports.fundFlow);
router.get('/day-book',           requirePermission('accounts.view'), dayBookController.dayBook);
// Profit & Loss — full Tally-shape statement sourced from ledger_entries.
// Replaces the legacy reportController.profitLoss which read from
// sales_bills / purchase_bills (bypassing the journal).
router.get('/profit-loss',        requirePermission('accounts.view'), financialReports.profitLoss);
// /receivables-aging + /payables-aging removed in Phase R5 follow-up.
// Use /api/reports/aging?party_type=Customer|Supplier (single source).

// Phase R3 — Operational summaries. (Sales/Purchase Registers were
// merged into /reports/sales and /reports/purchases — those endpoints
// now carry the same reconciliation block, with pagination + filters
// the registers lacked.)
router.get('/hsn-summary',        requirePermission('reports.view'),  operationalReports.hsnSummary);
router.get('/stock-summary',      requirePermission('reports.view'),  operationalReports.stockSummary);
router.get('/movers',             requirePermission('reports.view'),  operationalReports.movers);
// v2 redesign — same data shape as `movers` but enriched with cover-
// days, last-sale tracking, and a pre-classified row for each product.
router.get('/stock-velocity',     requirePermission('reports.view'),  operationalReports.stockVelocity);
router.get('/transfer-register',  requirePermission('reports.view'),  operationalReports.transferRegister);
router.get('/godown-valuation',   requirePermission('reports.view'),  operationalReports.godownValuation);

// Dashboard is informational and visible to anyone who can log in — it
// doesn't expose bill-level data, just the stats already derivable from
// their module perms. Gate the specific reports themselves.
router.get('/dashboard', reportController.dashboardStats);

router.get('/sales',             requirePermission('reports.view'),  reportController.salesReport);
router.get('/purchases',         requirePermission('reports.view'),  reportController.purchaseReport);
router.get('/stock',             requirePermission('reports.view'),  reportController.stockReport);
router.get('/party-outstanding', requirePermission('reports.view'),  reportController.partyOutstanding);
router.get('/aging',             requirePermission('reports.view'),  reportController.agingReport);
// Bill-level outstanding lists (cf. Aging which is party-level). Cursor-
// paginated via page/limit so the frontend can virtualize 10k+ rows.
// Monthly summary reports (R10) — one controller, three modes via
// ?mode=sales|purchase|combined query param. Frontend has three thin
// wrapper components calling this with the right mode preset.
const monthlySummaryController = require('../controllers/monthlySummaryController');
router.get('/monthly-summary',   requirePermission('reports.view'),  monthlySummaryController.monthlySummary);

// Product item-level detail (R11) — one row per (bill, line item) with
// party, product, price, tax, profit (sales side). Paginated for the
// virtualized table on the frontend.
const productItemsController = require('../controllers/productItemsController');
router.get('/product-sales-items',    requirePermission('reports.view'), productItemsController.productSalesItems);
router.get('/product-purchase-items', requirePermission('reports.view'), productItemsController.productPurchaseItems);

router.get('/bills-receivable',  requirePermission('reports.view'),  billsOutstandingController.billsReceivable);
router.get('/bills-payable',     requirePermission('reports.view'),  billsOutstandingController.billsPayable);
router.get('/bills-receivable/export', requirePermission('reports.view'), (req, res) => {
  req.query = { ...req.query, party_type: 'Customer' };
  return billsOutstandingController.exportBills(req, res);
});
router.get('/bills-payable/export',    requirePermission('reports.view'), (req, res) => {
  req.query = { ...req.query, party_type: 'Supplier' };
  return billsOutstandingController.exportBills(req, res);
});
// JSON dump for the client-side PDF exporter — same filters as the list
// endpoint but without the 500-row pagination cap, so the user gets a
// single PDF covering the full filtered set.
router.get('/bills-receivable/export-data', requirePermission('reports.view'), (req, res) => {
  req.query = { ...req.query, party_type: 'Customer' };
  return billsOutstandingController.exportBillsData(req, res);
});
router.get('/bills-payable/export-data',    requirePermission('reports.view'), (req, res) => {
  req.query = { ...req.query, party_type: 'Supplier' };
  return billsOutstandingController.exportBillsData(req, res);
});
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
