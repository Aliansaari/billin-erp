/**
 * Enterprise testing driver for billin-erp.
 *
 * Drives the production API the same way the React frontend would, but
 * generates realistic volume: 50 parties (mix intra/inter-state, registered/unregistered),
 * 100 products across GST slabs, then hundreds of sale + purchase + payment vouchers
 * spread across the financial year. Captures every request/response for the audit
 * report and stops on the first protocol break so we surface bugs immediately.
 *
 * Run as: node .audit/driver.js [phase]
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = 'http://localhost:3001/api';
const LOG_DIR = path.join(__dirname);
const LOG_FILE = path.join(LOG_DIR, `driver-${Date.now()}.log`);
const DATA_FILE = path.join(LOG_DIR, 'state.json');
const REPORT_FILE = path.join(LOG_DIR, 'driver-report.json');

// Tally counters
const stats = { calls: 0, ok: 0, failures: [], created: {} };
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}
function bump(kind) { stats.created[kind] = (stats.created[kind] || 0) + 1; }

function loadState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2)); }

let TOKEN = null;
async function login() {
  const r = await axios.post(`${BASE}/auth/login`, { username: 'admin', password: 'admin1234' });
  TOKEN = r.data.token;
  log(`Logged in. Token len=${TOKEN.length}`);
  return r.data;
}

function client() {
  return axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${TOKEN}` },
    validateStatus: () => true,  // we want to inspect failures
  });
}

async function call(method, url, body, label) {
  stats.calls++;
  const ax = client();
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = Date.now();
    const r = await ax.request({ method, url, data: body });
    const ms = Date.now() - t0;
    if (r.status === 429) {
      const wait = (r.data?.retry_after_seconds || 5) * 1000 + 500;
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    if (r.status >= 200 && r.status < 300) {
      stats.ok++;
      return r.data;
    }
    const errBody = typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 400);
    stats.failures.push({ label, method, url, status: r.status, error: errBody, ms });
    log(`  ✗ ${label} ${method} ${url} → HTTP ${r.status} (${ms} ms) :: ${errBody}`);
    return null;
  }
  return null;
}

// Indian states roster with GST codes for realistic data
const INDIAN_STATES = [
  { code: '27', name: 'Maharashtra' },   // company state — intra
  { code: '29', name: 'Karnataka' },
  { code: '24', name: 'Gujarat' },
  { code: '07', name: 'Delhi' },
  { code: '06', name: 'Haryana' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '36', name: 'Telangana' },
  { code: '32', name: 'Kerala' },
  { code: '19', name: 'West Bengal' },
  { code: '08', name: 'Rajasthan' },
];
function pickState(i) { return INDIAN_STATES[i % INDIAN_STATES.length]; }
function fakeGstin(stateCode, idx) {
  // 2-digit state + 5 alpha + 4 digit + 1 alpha + 1 alpha + Z + 1 alpha-num
  const pan = `ABCDE${String(idx + 1000).slice(-4)}F`;
  return `${stateCode}${pan}1Z${String.fromCharCode(65 + (idx % 26))}`;
}

const PRODUCT_GST_SLABS = [0, 5, 12, 18, 28];
const HSN_CODES = ['1006', '6109', '6110', '8528', '8517', '8471', '3304', '9404', '6309', '7308'];
const UNITS = ['PCS', 'KG', 'METER', 'LITER', 'BOX', 'DOZEN'];

function dateInFY(monthOffset = 0) {
  // FY starts April 1, 2026. Spread dates Apr 2026..Mar 2027
  const d = new Date(2026, 3 + monthOffset % 12, 1 + Math.floor(Math.random() * 28));
  return d.toISOString().split('T')[0];
}

async function ensureCompanySetup() {
  log('\n=== Phase: Company setup ===');
  const sys = await call('GET', '/settings/system', null, 'get-settings');
  if (!sys?.data?.gstin) {
    await call('PUT', '/settings/system', {
      company_name: 'Sabina Dresses',
      gstin: '27ABCDE1234F1Z5',
      pan_number: 'ABCDE1234F',
      company_address: '123 MG Road, Pune',
      sales_bill_prefix: 'INV',
      purchase_bill_prefix: 'BILL',
      sales_return_prefix: 'CN',
      purchase_return_prefix: 'DN',
    }, 'set-company');
  }
  log(`Company GSTIN: ${sys?.data?.gstin || 'set just now'}`);
}

async function ensureCategories() {
  log('\n=== Phase: Categories ===');
  const cats = await call('GET', '/categories', null, 'list-categories');
  const wanted = ['Apparel', 'Electronics', 'Stationery', 'Grocery', 'Hardware'];
  const have = (cats || []).map(c => c.category_name);
  const ids = {};
  for (const c of cats || []) ids[c.category_name] = c.category_id;
  for (const n of wanted) {
    if (have.includes(n)) continue;
    const r = await call('POST', '/categories', { category_name: n }, `cat-${n}`);
    if (r) { ids[n] = r.category_id; bump('category'); }
  }
  return ids;
}

async function ensureGodowns() {
  log('\n=== Phase: Godowns ===');
  const list = await call('GET', '/godowns', null, 'list-godowns');
  const have = (list || []).map(g => g.code);
  const wanted = [
    { name: 'Main', code: 'MAIN' },
    { name: 'Branch Mumbai', code: 'MUM' },
    { name: 'Branch Bangalore', code: 'BLR' },
  ];
  const ids = {};
  for (const g of list || []) ids[g.code] = g.godown_id;
  for (const g of wanted) {
    if (have.includes(g.code)) continue;
    const r = await call('POST', '/godowns', g, `god-${g.code}`);
    if (r) { ids[g.code] = r.godown_id || r.data?.godown_id; bump('godown'); }
  }
  return ids;
}

async function createParties(n) {
  log(`\n=== Phase: ${n} parties ===`);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const st = pickState(i);
    const isCustomer = i % 3 !== 0;  // 2/3 customers, 1/3 suppliers
    const isReg = i % 4 !== 0;       // 3/4 registered
    const body = {
      party_type: isCustomer ? 'Customer' : 'Supplier',
      party_name: `${isCustomer ? 'Customer' : 'Supplier'} ${st.name} ${String(i + 1).padStart(3, '0')}`,
      mobile_1: `9${String(800000000 + i * 17).slice(0, 9)}`,
      gstin: isReg ? fakeGstin(st.code, i) : null,
      state: st.name,
      city: st.name,
      pincode: `400${String(100 + i).slice(0, 3)}`,
      address_line_1: `Plot ${i + 1}, ${st.name} Industrial Estate`,
      credit_allowed: i % 5 === 0,
      credit_days: 30,
      opening_balance: i % 10 === 0 ? Math.round(Math.random() * 5000) / 100 * 100 : 0,
      opening_balance_type: 'Receivable',
    };
    const r = await call('POST', '/parties', body, `party-${i}`);
    if (r) { ids.push({ id: r.party_id, type: body.party_type, name: body.party_name, gstin: r.gstin, state: r.state }); bump('party'); }
  }
  log(`Created ${ids.length}/${n} parties`);
  return ids;
}

async function createProducts(n, categoryIds) {
  log(`\n=== Phase: ${n} products ===`);
  const ids = [];
  const cats = Object.values(categoryIds);
  for (let i = 0; i < n; i++) {
    const slab = PRODUCT_GST_SLABS[i % PRODUCT_GST_SLABS.length];
    const purchase = 100 + (i * 7) % 900;
    const margin = 20 + (i % 30);
    const sale = +(purchase * (1 + margin / 100)).toFixed(2);
    const body = {
      product_name: `Product ${String(i + 1).padStart(4, '0')} (${slab}% GST)`,
      hsn_code: HSN_CODES[i % HSN_CODES.length],
      gst_rate: slab,
      unit_of_measurement: UNITS[i % UNITS.length],
      category_id: cats[i % cats.length],
      purchase_rate: purchase,
      sale_rate: sale,
      mrp: +(sale * 1.1).toFixed(2),
      margin_percentage: margin,
      opening_stock: 100,
      opening_stock_rate: purchase,
      minimum_stock_level: 10,
    };
    const r = await call('POST', '/products', body, `prod-${i}`);
    if (r && (r.product_id || r.product?.product_id)) {
      ids.push({ id: r.product_id || r.product.product_id, gst: slab, hsn: body.hsn_code, purchase, sale, name: body.product_name });
      bump('product');
    }
  }
  log(`Created ${ids.length}/${n} products`);
  return ids;
}

async function createPurchaseBills(n, suppliers, products, godownId) {
  log(`\n=== Phase: ${n} purchase bills ===`);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const sup = suppliers[i % suppliers.length];
    const lineCount = 1 + (i % 4);
    const items = [];
    for (let j = 0; j < lineCount; j++) {
      const p = products[(i * 7 + j) % products.length];
      items.push({
        product_id: p.id,
        quantity: 5 + (j + 1) * 5,
        purchase_rate: p.purchase,
        discount_percentage: i % 6 === 0 ? 5 : 0,
        gst_rate: p.gst,
      });
    }
    const body = {
      supplier_id: sup.id,
      godown_id: godownId,
      bill_date: dateInFY(i % 12),
      supplier_bill_number: `SUP-${String(i + 1).padStart(5, '0')}`,
      supplier_bill_date: dateInFY(i % 12),
      items,
      gst_mode: 'product',
      // BUG-WORKAROUND: auto-payment for partial-paid bills hits the
      // transaction_number VARCHAR(30) limit (see audit). Use 0 to bypass.
      paid_amount: 0,
    };
    const r = await call('POST', '/purchases', body, `purch-${i}`);
    if (r?.purchase_bill_id) { ids.push({ id: r.purchase_bill_id, supplier_id: sup.id, total: r.total_amount, balance: r.balance_amount }); bump('purchase'); }
  }
  log(`Created ${ids.length}/${n} purchase bills`);
  return ids;
}

async function createSaleBills(n, customers, products, godownId) {
  log(`\n=== Phase: ${n} sale bills ===`);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const cust = customers[i % customers.length];
    const lineCount = 1 + (i % 5);
    const items = [];
    for (let j = 0; j < lineCount; j++) {
      const p = products[(i * 11 + j) % products.length];
      items.push({
        product_id: p.id,
        quantity: 1 + (j + 1) * 2,
        rate: p.sale,
        discount_percentage: i % 7 === 0 ? 3 : 0,
        gst_rate: p.gst,
      });
    }
    const body = {
      customer_id: cust.id,
      godown_id: godownId,
      bill_date: dateInFY(i % 12),
      items,
      gst_mode: 'product',
      // BUG-WORKAROUND: same auto-receipt VARCHAR(30) bug on sales path.
      paid_amount: 0,
    };
    const r = await call('POST', '/sales', body, `sale-${i}`);
    if (r?.sales_bill_id) { ids.push({ id: r.sales_bill_id, customer_id: cust.id, total: r.total_amount, balance: r.balance_amount, date: r.bill_date }); bump('sale'); }
  }
  log(`Created ${ids.length}/${n} sale bills`);
  return ids;
}

async function createPayments(n, sales, customers) {
  log(`\n=== Phase: ${n} receipts ===`);
  const created = [];
  // For receipt allocation we need cust → unpaid bills
  const open = sales.filter(s => s.balance > 0.01);
  for (let i = 0; i < Math.min(n, open.length); i++) {
    const s = open[i];
    const allocated = Math.min(s.balance, 500 + Math.round(Math.random() * 1000));
    const body = {
      party_id: s.customer_id,
      transaction_date: dateInFY((i + 3) % 12),
      transaction_type: 'Receipt',
      payment_method: ['Cash', 'Bank Transfer', 'UPI', 'Cheque'][i % 4],
      total_amount: allocated,
      bill_allocations: [{ bill_id: s.id, bill_type: 'Sales', amount: allocated }],
    };
    const r = await call('POST', '/payments', body, `rcpt-${i}`);
    if (r?.transaction_id || r?.receipt_id || r?.payment_id) { created.push(r); bump('receipt'); }
  }
  log(`Created ${created.length} receipts`);
  return created;
}

async function fetchReports() {
  log('\n=== Phase: Reports ===');
  const fy_from = '2026-04-01';
  const fy_to   = '2027-03-31';
  const reports = {};
  const probes = [
    ['/reports/trial-balance',       'TB'],
    ['/reports/balance-sheet',       'BS'],
    ['/reports/profit-loss',         'PL'],
    ['/reports/day-book',            'DayBook'],
    ['/reports/sales',               'Sales'],
    ['/reports/purchases',           'Purchases'],
    ['/reports/aging',               'Aging'],
    ['/reports/party-outstanding',   'Outstanding'],
    ['/reports/bills-receivable',    'Receivable'],
    ['/reports/bills-payable',       'Payable'],
    ['/reports/hsn-summary',         'HSN'],
    ['/reports/stock-summary',       'Stock'],
    ['/reports/godown-valuation',    'GodownVal'],
    ['/reports/movers',              'Movers'],
    ['/reports/gstr1',               'GSTR1'],
    ['/reports/gstr3b',              'GSTR3B'],
    ['/reports/monthly-summary',     'Monthly'],
    ['/reports/dashboard',           'Dashboard'],
    ['/reports/dashboard/series',    'DashSeries'],
    ['/reports/dashboard/insights',  'DashInsights'],
    ['/reports/dashboard/business',  'DashBiz'],
    ['/reports/cash-flow/monthly',   'CashFlowM'],
    ['/reports/fund-flow/monthly',   'FundFlowM'],
    ['/ledger/integrity',            'LedgerIntegrity'],
  ];
  for (const [url, key] of probes) {
    const params = new URLSearchParams({ from_date: fy_from, to_date: fy_to }).toString();
    const r = await call('GET', `${url}?${params}`, null, key);
    reports[key] = r;
    if (r) log(`  ✓ ${key} OK`);
  }
  return reports;
}

(async () => {
  const phase = process.argv[2] || 'all';
  log(`==================== START ${phase} ====================`);
  await login();
  const state = loadState();

  if (phase === 'setup' || phase === 'all') {
    await ensureCompanySetup();
    state.categories = await ensureCategories();
    state.godowns = await ensureGodowns();
    saveState(state);
  }
  if (phase === 'parties' || phase === 'all') {
    state.parties = await createParties(50);
    saveState(state);
  }
  if (phase === 'products' || phase === 'all') {
    state.products = await createProducts(100, state.categories);
    saveState(state);
  }
  if (phase === 'purchases' || phase === 'all') {
    const suppliers = (state.parties || []).filter(p => p.type === 'Supplier');
    const godownId = state.godowns?.MAIN || 1;
    state.purchases = await createPurchaseBills(200, suppliers, state.products, godownId);
    saveState(state);
  }
  if (phase === 'sales' || phase === 'all') {
    const customers = (state.parties || []).filter(p => p.type === 'Customer');
    const godownId = state.godowns?.MAIN || 1;
    state.sales = await createSaleBills(300, customers, state.products, godownId);
    saveState(state);
  }
  if (phase === 'payments' || phase === 'all') {
    const customers = (state.parties || []).filter(p => p.type === 'Customer');
    state.payments = await createPayments(150, state.sales || [], customers);
    saveState(state);
  }
  if (phase === 'reports' || phase === 'all') {
    state.reports = await fetchReports();
    saveState(state);
  }

  log('\n==================== SUMMARY ====================');
  log(`Total calls: ${stats.calls}, OK: ${stats.ok}, FAIL: ${stats.failures.length}`);
  for (const [k, v] of Object.entries(stats.created)) log(`  Created ${k}: ${v}`);
  if (stats.failures.length) {
    log(`\nFirst 10 failures:`);
    for (const f of stats.failures.slice(0, 10)) log(`  ${f.label} → ${f.status} ${f.error}`);
  }
  fs.writeFileSync(REPORT_FILE, JSON.stringify(stats, null, 2));
  log(`\nReport saved to ${REPORT_FILE}`);
})().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
