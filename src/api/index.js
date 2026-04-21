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

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 || error.response?.status === 403) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth
export const authAPI = {
  login: (data) => api.post('/auth/login', data),
  getProfile: () => api.get('/auth/profile'),
  changePassword: (data) => api.post('/auth/change-password', data),
};

// Parties
export const partyAPI = {
  getAll: (params) => api.get('/parties', { params }),
  getCustomers: (params) => api.get('/parties/customers', { params }),
  getSuppliers: (params) => api.get('/parties/suppliers', { params }),
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

// Sales
export const salesAPI = {
  getAll: (params) => api.get('/sales', { params }),
  getById: (id) => api.get(`/sales/${id}`),
  create: (data) => api.post('/sales', data),
  update: (id, data) => api.put(`/sales/${id}`, data),
  cancel: (id) => api.post(`/sales/${id}/cancel`),
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
};

// Reports
export const reportAPI = {
  getDashboard: () => api.get('/reports/dashboard'),
  getSalesReport: (params) => api.get('/reports/sales', { params }),
  getPurchaseReport: (params) => api.get('/reports/purchases', { params }),
  getStockReport: (params) => api.get('/reports/stock', { params }),
  getProfitLoss: (params) => api.get('/reports/profit-loss', { params }),
  getPartyOutstanding: (params) => api.get('/reports/party-outstanding', { params }),

  // Filter-aware XLSX exports — SAME filter shape as the JSON endpoints above.
  // The server applies the filters, fetches ALL matching rows (no page limit),
  // and streams an xlsx with a totals row. Honors date range, party, status, etc.
  exportSalesReport: (params) => api.get('/reports/sales/export', { params, responseType: 'blob', timeout: 300000 }),
  exportPurchaseReport: (params) => api.get('/reports/purchases/export', { params, responseType: 'blob', timeout: 300000 }),
  exportStockReport: (params) => api.get('/reports/stock/export', { params, responseType: 'blob', timeout: 300000 }),
  exportPartyOutstanding: (params) => api.get('/reports/party-outstanding/export', { params, responseType: 'blob', timeout: 300000 }),
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
};

export default api;
