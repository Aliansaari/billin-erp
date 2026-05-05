import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle auth errors.
//
//   401 = token missing / invalid / expired → log the user out so they can
//         get a fresh one. Keeps the app out of half-authenticated states.
//
//   403 = authenticated BUT lacks permission for this specific action.
//         Do NOT log them out — destroying the session any time a sub-request
//         hit a permission boundary was awful UX: clicking Sales List as a
//         restricted user would log them right back out because the page
//         fetched customers/products (which they lacked view on) as a side
//         effect. Instead we surface a toast and let the caller decide
//         whether to show an empty state, a banner, or swallow it silently.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    if (status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('must_change_password');
      window.location.href = '/login';
      return Promise.reject(error);
    }
    if (status === 403) {
      try {
        // Lazily require AntD message so this module stays usable in non-UI
        // contexts (e.g. tests) and doesn't fail if AntD isn't mounted yet.
        const { message } = require('antd');
        const detail = error.response?.data?.error || 'You do not have permission for that action.';
        const required = error.response?.data?.required;
        message.error(required ? `${detail} (needs ${required})` : detail, 4);
      } catch { /* no toast available; caller handles */ }
    }
    return Promise.reject(error);
  }
);

// Auth
export const authAPI = {
  login: (data) => api.post('/auth/login', data),
  getProfile: () => api.get('/auth/profile'),
  changePassword: (data) => api.post('/auth/change-password', data),
  verifyPassword: (password) => api.post('/auth/verify-password', { password }),
};

// Parties
export const partyAPI = {
  getAll: (params) => api.get('/parties', { params }),
  getCustomers: (params) => api.get('/parties/customers', { params }),
  getSuppliers: (params) => api.get('/parties/suppliers', { params }),
  getAging: (params) => api.get('/parties/aging', { params }),
  getProfit: (id, params) => api.get(`/parties/${id}/profit`, { params }),
  getById: (id) => api.get(`/parties/${id}`),
  getLedger: (id, params) => api.get(`/parties/${id}/ledger`, { params }),
  create: (data) => api.post('/parties', data),
  update: (id, data) => api.put(`/parties/${id}`, data),
  toggleActive: (id) => api.patch(`/parties/${id}/toggle-active`),
  delete: (id) => api.delete(`/parties/${id}`),
  recalculateBalances: () => api.post('/parties/recalculate-balances'),
};

// Categories
export const categoryAPI = {
  getAll: () => api.get('/categories'),
  getAllFlat: () => api.get('/categories/flat'),
  create: (data) => api.post('/categories', data),
  update: (id, data) => api.put(`/categories/${id}`, data),
  delete: (id) => api.delete(`/categories/${id}`),
};

// Products
export const productAPI = {
  getAll: (params) => api.get('/products', { params }),
  search: (q, params={}) => api.get('/products', { params: { search: q, limit: 50, ...params } }),
  getByBarcode: (barcode) => api.get(`/products/barcode/${barcode}`),
  getBatches:   (id, params) => api.get(`/products/${id}/batches`, { params }),
  getNextBarcode: () => api.get('/products/next-barcode'),
  getById: (id) => api.get(`/products/${id}`),
  getLowStock: () => api.get('/products/low-stock'),
  getStockMovement: (id, params) => api.get(`/products/${id}/stock-movement`, { params }),
  create: (data) => api.post('/products', data),
  update: (id, data) => api.put(`/products/${id}`, data),
  adjust: (id, data) => api.post(`/products/${id}/adjust`, data),
  delete: (id) => api.delete(`/products/${id}`),
};

// Purchases
export const purchaseAPI = {
  getAll: (params) => api.get('/purchases', { params }),
  getById: (id) => api.get(`/purchases/${id}`),
  create: (data) => api.post('/purchases', data),
  update: (id, data) => api.put(`/purchases/${id}`, data),
  cancel: (id) => api.post(`/purchases/${id}/cancel`),
};

// Purchase bill drafts — Hold/Recall flow. Same isolation as sales drafts:
// drafts live in their own table (purchase_bill_drafts) so they NEVER
// appear in GSTR-2/aging/supplier-ledger and never touch stock.
export const purchaseDraftAPI = {
  list:   ()        => api.get('/purchase-drafts'),
  get:    (id)      => api.get(`/purchase-drafts/${id}`),
  create: (data)    => api.post('/purchase-drafts', data),
  update: (id, d)   => api.put(`/purchase-drafts/${id}`, d),
  delete: (id)      => api.delete(`/purchase-drafts/${id}`),
};

// Sales
export const salesAPI = {
  getAll: (params) => api.get('/sales', { params }),
  getById: (id) => api.get(`/sales/${id}`),
  create: (data) => api.post('/sales', data),
  update: (id, data) => api.put(`/sales/${id}`, data),
  cancel: (id) => api.post(`/sales/${id}/cancel`),
};

// Sales bill drafts — Hold/Recall flow. Drafts live in their own table
// (sales_bill_drafts), so they NEVER appear in GSTR-1/3B/ledger/reports
// and never decrement stock. Recall = load draft → resume in form →
// save → drafts row is deleted (consumes a real bill_number only at
// commit time, not at hold time).
export const salesDraftAPI = {
  list:   ()        => api.get('/sales-drafts'),
  get:    (id)      => api.get(`/sales-drafts/${id}`),
  create: (data)    => api.post('/sales-drafts', data),
  update: (id, d)   => api.put(`/sales-drafts/${id}`, d),
  delete: (id)      => api.delete(`/sales-drafts/${id}`),
};

// Sales Returns — credit notes. getReferenceBill fetches the original sales
// bill's items so the return form can pre-populate lines for "return this bill".
export const salesReturnAPI = {
  getAll: (params) => api.get('/sales-returns', { params }),
  getById: (id) => api.get(`/sales-returns/${id}`),
  getReferenceBill: (salesBillId) => api.get(`/sales-returns/reference/${salesBillId}`),
  create: (data) => api.post('/sales-returns', data),
  update: (id, data) => api.put(`/sales-returns/${id}`, data),
  cancel: (id) => api.post(`/sales-returns/${id}/cancel`),
};

// Purchase Returns — debit notes. Mirrors salesReturnAPI.
export const purchaseReturnAPI = {
  getAll: (params) => api.get('/purchase-returns', { params }),
  getById: (id) => api.get(`/purchase-returns/${id}`),
  getReferenceBill: (purchaseBillId) => api.get(`/purchase-returns/reference/${purchaseBillId}`),
  create: (data) => api.post('/purchase-returns', data),
  update: (id, data) => api.put(`/purchase-returns/${id}`, data),
  cancel: (id) => api.post(`/purchase-returns/${id}/cancel`),
};

// Payments
export const paymentAPI = {
  getAll: (params) => api.get('/payments', { params }),
  getById: (id) => api.get(`/payments/${id}`),
  create: (data) => api.post('/payments', data),
  cancel: (id) => api.post(`/payments/${id}/cancel`),
  getUnpaidBills: (params) => api.get('/payments/unpaid-bills', { params }),
  // Preview the next auto-generated transaction number for the type.
  // Server-side, the real number is allocated atomically inside create().
  nextNumber: (type /* 'Receipt' | 'Payment' */) =>
    api.get('/payments/next-number', { params: { type } }),
};

// Reports
export const reportAPI = {
  getDashboard: () => api.get('/reports/dashboard'),
  getSalesReport: (params) => api.get('/reports/sales', { params }),
  getPurchaseReport: (params) => api.get('/reports/purchases', { params }),
  getStockReport: (params) => api.get('/reports/stock', { params }),
  // Legacy alias — kept for callers we haven't migrated yet (Dashboard etc).
  // The new Tally-shape P&L is exported as `profitLoss` below alongside
  // trialBalance/balanceSheet, with a structured two-column response.
  getProfitLoss: (params) => api.get('/reports/profit-loss', { params }),
  getPartyOutstanding: (params) => api.get('/reports/party-outstanding', { params }),
  getAging: (params) => api.get('/reports/aging', { params }),
  // Bill-level outstanding lists. Cursor pagination via page+limit so
  // useVirtualizedReport can chunk-load 10k+ rows.
  billsReceivable:       (params) => api.get('/reports/bills-receivable', { params }),
  billsPayable:          (params) => api.get('/reports/bills-payable',    { params }),
  exportBillsReceivable: (params) => api.get('/reports/bills-receivable/export', { params, responseType: 'blob' }),
  exportBillsPayable:    (params) => api.get('/reports/bills-payable/export',    { params, responseType: 'blob' }),
  // JSON dump used by the client-side PDF exporter — returns the full
  // filtered result set in one shot (server bumps the limit cap to 10k).
  exportBillsReceivableData: (params) => api.get('/reports/bills-receivable/export-data', { params }),
  exportBillsPayableData:    (params) => api.get('/reports/bills-payable/export-data',    { params }),
  // R10 — Monthly summary (sales | purchase | combined). Single endpoint,
  // mode parameter selects shape. Frontend wrappers preset the mode.
  monthlySummary:        (params) => api.get('/reports/monthly-summary', { params }),
  // R11 — Product item-level detail. Two endpoints, mirror shape.
  productSalesItems:     (params) => api.get('/reports/product-sales-items',    { params }),
  productPurchaseItems:  (params) => api.get('/reports/product-purchase-items', { params }),
  getGstr1: (params) => api.get('/reports/gstr1', { params }),
  getGstr3b: (params) => api.get('/reports/gstr3b', { params }),
  // Phase R1 — Trial Balance + Balance Sheet + Profit & Loss
  // (P&L moved here from reportController; new shape is two-column
  // Tally-style with optional comparative period.)
  trialBalance: (params) => api.get('/reports/trial-balance',  { params }),
  balanceSheet: (params) => api.get('/reports/balance-sheet',  { params }),
  profitLoss:   (params) => api.get('/reports/profit-loss',    { params }),
  // Phase R2 — Cash Flow (Tally-style three-level drill: register →
  // month → group) + Aging.
  cashFlowMonthly:    (params) => api.get('/reports/cash-flow/monthly', { params }),
  cashFlowMonth:      (params) => api.get('/reports/cash-flow/month',   { params }),
  cashFlowGroup:      (params) => api.get('/reports/cash-flow/group',   { params }),
  // Fund Flow — Tally-style three-level drill.
  fundFlowMonthly:    (params) => api.get('/reports/fund-flow/monthly', { params }),
  fundFlow:           (params) => api.get('/reports/fund-flow',         { params }),
  dayBook:            (params) => api.get('/reports/day-book',           { params }),
  // Phase R3 — Operational summaries (Sales/Purchase Registers folded
  // into the canonical /reports/sales and /reports/purchases above).
  hsnSummary:         (params) => api.get('/reports/hsn-summary',        { params }),
  movers:             (params) => api.get('/reports/movers',             { params }),
  stockVelocity:      (params) => api.get('/reports/stock-velocity',     { params }),
  // Phase Godown — multi-warehouse reports
  transferRegister:   (params) => api.get('/reports/transfer-register',  { params }),
  godownValuation:    (params) => api.get('/reports/godown-valuation',   { params }),

  // Filter-aware XLSX exports — SAME filter shape as the JSON endpoints above.
  // The server applies the filters, fetches ALL matching rows (no page limit),
  // and streams an xlsx with a totals row. Honors date range, party, status, etc.
  exportSalesReport: (params) => api.get('/reports/sales/export', { params, responseType: 'blob', timeout: 300000 }),
  exportPurchaseReport: (params) => api.get('/reports/purchases/export', { params, responseType: 'blob', timeout: 300000 }),
  exportStockReport: (params) => api.get('/reports/stock/export', { params, responseType: 'blob', timeout: 300000 }),
  exportPartyOutstanding: (params) => api.get('/reports/party-outstanding/export', { params, responseType: 'blob', timeout: 300000 }),
  exportAging: (params) => api.get('/reports/aging/export', { params, responseType: 'blob', timeout: 300000 }),
  exportGstr1: (params) => api.get('/reports/gstr1/export', { params, responseType: 'blob', timeout: 300000 }),
  exportGstr3b: (params) => api.get('/reports/gstr3b/export', { params, responseType: 'blob', timeout: 300000 }),
};

// Settings
export const settingsAPI = {
  getSystem: () => api.get('/settings/system'),
  updateSystem: (data) => api.put('/settings/system', data),
  getBarcode: () => api.get('/settings/barcode'),
  updateBarcode: (data) => api.put('/settings/barcode', data),
  getUsers: () => api.get('/settings/users'),
  createUser: (data) => api.post('/settings/users', data),
  updateUser: (id, data) => api.put(`/settings/users/${id}`, data),
  deleteUser: (id) => api.delete(`/settings/users/${id}`),
  getRoles: () => api.get('/settings/roles'),
  // Payload is { categories, password, confirmation } — backend re-verifies admin's
   // password and requires the user to type "DELETE" before wiping data.
  cleanupData: (payload) => api.post('/settings/cleanup', payload),
};

// Backup & Restore
export const backupAPI = {
  list: () => api.get('/backup/list'),
  create: () => api.post('/backup/create', {}, { responseType: 'blob', timeout: 300000 }),
  download: (filename) => api.get(`/backup/download/${filename}`, { responseType: 'blob', timeout: 300000 }),
  delete: (filename) => api.delete(`/backup/${filename}`),
  restore: (fileOrFilename, onProgress) => {
    if (typeof fileOrFilename === 'string') {
      return api.post('/backup/restore', { filename: fileOrFilename }, { timeout: 300000 });
    }
    const formData = new FormData();
    formData.append('file', fileOrFilename);
    return api.post('/backup/restore', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
      },
    });
  },
  getSettings: () => api.get('/backup/settings'),
  updateSettings: (data) => api.put('/backup/settings', data),
};

// Import/Export
export const dataAPI = {
  // params lets the caller pass { search, category_id, stock_status, status }
  // so the exported workbook reflects whatever filters are on-screen.
  exportExcel: (module, params = {}) => api.get(`/data/export/${module}`, { params, responseType: 'blob', timeout: 300000 }),
  downloadTemplate: (module) => api.get(`/data/template/${module}`, { responseType: 'blob' }),
  downloadFailedReport: (errors) => api.post('/data/failed-report', { errors }, { responseType: 'blob' }),
  importExcel: (module, file, onProgress) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post(`/data/import/${module}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
      },
    });
  },
  // Post-import: regenerate barcodes for product_ids that had blank Barcode
  // cells in the import file (the server sets them to auto-generated values
  // during import, and this call re-rolls them after the user confirms).
  regenerateBarcodes: (productIds) =>
    api.post('/data/regenerate-barcodes', { product_ids: productIds }),
};

// TallyPrime Sync — config, file-based export, live HTTP push/pull.
// Not all endpoints are implemented server-side yet; see TALLY_INTEGRATION.md
// for status. The client exposes the full surface so the UI can be built
// against it and stubs can be filled in incrementally.
export const tallyAPI = {
  getConfig: () => api.get('/tally/config'),
  updateConfig: (data) => api.put('/tally/config', data),
  testConnection: (data) => api.post('/tally/test-connection', data),
  exportMastersXML: (params = {}) =>
    api.get('/tally/export/masters', { params, responseType: 'blob', timeout: 300000 }),
  exportVouchersXML: (params = {}) =>
    api.get('/tally/export/vouchers', { params, responseType: 'blob', timeout: 300000 }),
  importXML: (file, onProgress) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/tally/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
      },
    });
  },
  pushLive: (data) => api.post('/tally/live/push', data, { timeout: 300000 }),
  pullLive: (data) => api.post('/tally/live/pull', data, { timeout: 300000 }),
  getSyncLogs: (params) => api.get('/tally/sync-logs', { params }),
};

export const printAPI = {
  list:       (params = {}) => api.get('/print/profiles', { params }),
  getById:    (id)           => api.get(`/print/profiles/${id}`),
  getDefault: (docType)      => api.get(`/print/profiles/default/${docType}`),
  create:     (data)         => api.post('/print/profiles', data),
  update:     (id, data)     => api.put(`/print/profiles/${id}`, data),
  remove:     (id)           => api.delete(`/print/profiles/${id}`),
  duplicate:  (id)           => api.post(`/print/profiles/${id}/duplicate`),
};

export const journalAPI = {
  list:    (params = {}) => api.get('/journal-vouchers', { params }),
  getById: (id)          => api.get(`/journal-vouchers/${id}`),
  create:  (data)        => api.post('/journal-vouchers', data),
  update:  (id, data)    => api.put(`/journal-vouchers/${id}`, data),
  remove:  (id, reason)  => api.delete(`/journal-vouchers/${id}`, { data: { reason } }),
};

export const ledgerAPI = {
  listAccounts:           (params = {}) => api.get('/ledger/accounts', { params }),
  integrity:              () => api.get('/ledger/integrity'),
  autoReceiptIntegrity:   () => api.get('/ledger/auto-receipt-integrity'),
  unposted:               () => api.get('/ledger/unposted'),
  reconcile:              () => api.post('/ledger/reconcile'),
  // Voucher-level statement of one ledger over a date range. Backs the
  // Customer Statement / Supplier Statement / Ledger pages — all three
  // call the SAME endpoint via different access paths (direct or
  // party→ledger resolution server-side).
  statement:              (ledgerId, params = {}) => api.get(`/ledger/statement/${ledgerId}`, { params }),
  statementByParty:       (partyId,  params = {}) => api.get(`/ledger/statement/by-party/${partyId}`, { params }),
};

// Banks — bank-flavoured surface over ledger accounts under the
// 'Bank Accounts' / 'Bank OD A/c' sub-groups.
export const bankAPI = {
  // List with optional include_inactive=true (used by the management
  // page so the operator can see + reactivate retired banks). Picker
  // surfaces (BankLedgerSelect) leave the flag off so they only see
  // active banks.
  list:           (params = {})          => api.get('/banks', { params }),
  statement:      (ledgerId, params = {}) => api.get(`/banks/${ledgerId}/statement`, { params }),
  // Cross-bank reconciliation. Accepts { status: 'uncleared'|'cleared'|'all',
  // bank_id, from_date, to_date }.
  reconciliation: (params = {})          => api.get('/banks/reconciliation', { params }),
  markCleared:    (txnId, body = {})     => api.post(`/banks/clear/${txnId}`, body),
  markUncleared:  (txnId)                => api.post(`/banks/unclear/${txnId}`),

  // Lifecycle. The server enforces all the safety rules (uniqueness,
  // sub_group reclassification needs zero entries, system ledgers can't
  // deactivate, deletion needs zero references). The UI just calls and
  // displays whatever the server says.
  create:         (body)                 => api.post('/banks', body),
  update:         (ledgerId, body)       => api.patch(`/banks/${ledgerId}`, body),
  remove:         (ledgerId)             => api.delete(`/banks/${ledgerId}`),
};

// Cheques — register + lifecycle (deposit / clear / bounce / cancel /
// reopen). All financial impact goes through ledgerPostingService on
// the server, so each lifecycle action commits a real voucher pair
// and returns the up-to-date cheque row.
//
// Filter shape on list():
//   { direction, status, party_id, bank_id, is_pdc, from_date, to_date,
//     search, page, limit }
// Where `status` accepts a comma-separated list ("PENDING,DEPOSITED").
//
// The list response also carries a kpis block populated against the
// FULL filtered set (not just the current page) so the register's KPI
// strip reads the right population numbers regardless of pagination.
export const chequeAPI = {
  list:    (params = {})    => api.get('/cheques', { params }),
  getById: (id)             => api.get(`/cheques/${id}`),
  create:  (body)           => api.post('/cheques', body),
  update:  (id, body)       => api.put(`/cheques/${id}`, body),
  deposit: (id, body = {})  => api.post(`/cheques/${id}/deposit`, body),
  clear:   (id, body = {})  => api.post(`/cheques/${id}/clear`,   body),
  bounce:  (id, body = {})  => api.post(`/cheques/${id}/bounce`,  body),
  cancel:  (id, body = {})  => api.post(`/cheques/${id}/cancel`,  body),
  reopen:  (id)             => api.post(`/cheques/${id}/reopen`),
};

// Loans — same shape as banks, plus per-loan amortization schedule and
// the cross-loan upcoming EMIs view, plus the recordEMI action that
// posts the proper double-entry split (Loan Dr + Interest Dr / Bank Cr).
export const loanAPI = {
  list:           (params = {})          => api.get('/loans', { params }),
  upcoming:       (params = {})          => api.get('/loans/upcoming', { params }),
  calculate:      (params)               => api.get('/loans/calculate', { params }),
  statement:      (ledgerId, params = {}) => api.get(`/loans/${ledgerId}/statement`, { params }),
  schedule:       (ledgerId)             => api.get(`/loans/${ledgerId}/schedule`),
  create:         (body)                 => api.post('/loans', body),
  update:         (ledgerId, body)       => api.patch(`/loans/${ledgerId}`, body),
  remove:         (ledgerId)             => api.delete(`/loans/${ledgerId}`),
  recordEmi:      (ledgerId, body)       => api.post(`/loans/${ledgerId}/emi`, body),
};

export const importsAPI = {
  list:    () => api.get('/imports'),
  getById: (id) => api.get(`/imports/${id}`),
  create:  (formData) => api.post('/imports', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  confirm: (id, choices) => api.post(`/imports/${id}/confirm`, choices || {}),
  cancel:  (id) => api.post(`/imports/${id}/cancel`),
  // Auth'd blob download. A plain <a href> wouldn't carry the JWT, so the
  // endpoint would 401. Return the blob; caller triggers the save.
  rejectedRowsBlob: (id) =>
    api.get(`/imports/${id}/rejected-rows`, { responseType: 'blob' }),
};

export const tallyMappingAPI = {
  list:    () => api.get('/tally/ledger-mapping'),
  suggest: (names) => api.get('/tally/ledger-mapping/suggest', { params: { names: names.join(',') } }),
  save:    (mappings) => api.post('/tally/ledger-mapping', { mappings }),
};

// Godowns — physical storage locations. CRUD lives in Settings.
// `getAll` is unfiltered by allowed_godowns deliberately (the form needs
// labels for any godown a bill might reference); the list dropdown in
// bill forms applies its own client-side filter to user.allowed_godowns.
export const godownAPI = {
  getAll:     (params) => api.get('/godowns', { params }),
  getById:    (id) => api.get(`/godowns/${id}`),
  create:     (data) => api.post('/godowns', data),
  update:     (id, data) => api.put(`/godowns/${id}`, data),
  setDefault: (id) => api.post(`/godowns/${id}/default`),
  delete:     (id) => api.delete(`/godowns/${id}`),
};

// Per-user report favorites. The hub page + the nav dropdown both
// read from a Zustand store that calls these endpoints and caches
// the resulting id list — so consumers should hit the store, not
// these endpoints, except when initially hydrating or when the
// store calls through.
export const favoritesAPI = {
  list:   () => api.get('/user/favorites'),
  pin:    (reportId) => api.post(`/user/favorites/${reportId}`),
  unpin:  (reportId) => api.delete(`/user/favorites/${reportId}`),
};

// Stock transfers between godowns. Lifecycle is Draft → In-Transit →
// Received (or → Cancelled from Draft/In-Transit). Server enforces all
// transitions; the UI just exposes the buttons.
export const stockTransferAPI = {
  getAll:  (params) => api.get('/stock-transfers', { params }),
  getById: (id) => api.get(`/stock-transfers/${id}`),
  create:  (data) => api.post('/stock-transfers', data),
  submit:  (id) => api.post(`/stock-transfers/${id}/submit`),
  receive: (id, data) => api.post(`/stock-transfers/${id}/receive`, data || {}),
  cancel:  (id, reason) => api.post(`/stock-transfers/${id}/cancel`, { reason }),
};

// Batches (Commit 5) — list of every batch in the system, per-batch
// detail (movement + stock-by-godown + bills-touched), and the bucketed
// expiry report. Read-only API; mutations live on the bill controllers.
export const batchAPI = {
  list:         (params) => api.get('/batches', { params }),
  getById:      (id)     => api.get(`/batches/${id}`),
  expiryReport: (params) => api.get('/batches/expiry-report', { params }),
};

export default api;
