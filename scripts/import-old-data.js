#!/usr/bin/env node
'use strict';

/**
 * Old-software data migration → ZEHEN production database.
 *
 * Usage:
 *   node scripts/import-old-data.js --dry-run   (validate only, no DB writes)
 *   node scripts/import-old-data.js --import     (execute the import)
 *
 * Safety:
 *   - Entire import runs in a single PostgreSQL transaction
 *   - Dry-run mode validates and prints totals without touching DB
 *   - Every numeric total is cross-checked against source files
 *   - Detailed log written to scripts/import-log.txt
 */

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { Pool } = require('pg');

// ═══════════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const DATA_DIR = path.join('C:', 'Users', 'Ali', 'Downloads', 'old software data');

const stateFile = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.billing-erp',
  'embedded-pg.json',
);
const pgState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const DB_CONFIG = {
  host: '127.0.0.1',
  port: pgState.port,
  user: 'postgres',
  password: pgState.password,
  database: 'billing_erp',
};

const MODE = process.argv.includes('--import') ? 'import' : 'dry-run';

const LOG_FILE = path.join(__dirname, 'import-log.txt');
let logStream;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

function logSection(title) {
  const sep = '═'.repeat(60);
  log('');
  log(sep);
  log(`  ${title}`);
  log(sep);
}

// ═══════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════

function parseDate(dateStr) {
  if (!dateStr || dateStr === '----') return null;
  const s = String(dateStr).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function toNum(v) {
  if (v === null || v === undefined || v === '' || v === '-' || v === '----') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function trimStr(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return '';
  return String(v).trim();
}

function trunc(v, maxLen) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > maxLen ? s.substring(0, maxLen) : s;
}

function splitProductNameSize(fullName) {
  const s = trimStr(fullName);
  const idx = s.lastIndexOf(' - ');
  if (idx === -1) return { name: s, size: null };
  const name = s.substring(0, idx).trim();
  let size = s.substring(idx + 3).trim();
  if (size === '.' || size === '') size = null;
  return { name, size };
}

function normalizeBarcode(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\.0$/, '');
  if (!s || s === '0' || s === 'null' || s === '-' || s === '----') return null;
  return s;
}

function mapPayMode(mode, chequeNo) {
  const m = trimStr(mode).toUpperCase();
  if (m === 'CHEQUE') return 'Cheque';
  if (m === 'UPI' || m === 'PHONE_PAY' || m === 'PAYTM') return 'UPI';
  if (m === 'CREDIT') {
    const ch = trimStr(chequeNo);
    if (ch && ch !== '-' && ch !== '----' && ch !== '') return 'Cheque';
    return 'Cash';
  }
  return 'Cash';
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 1: FILE READERS
// ═══════════════════════════════════════════════════════════════════════

async function readExcelRows(fileName, headerRow, dataStartRow) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DATA_DIR, fileName));
  const sheet = wb.worksheets[0];
  const rows = [];

  const headers = [];
  const hRow = sheet.getRow(headerRow);
  hRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = trimStr(cell.value);
  });

  for (let i = dataStartRow; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const obj = {};
    let hasData = false;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const val = cell.value;
      if (val !== null && val !== undefined && val !== '----') hasData = true;
      obj[`C${col}`] = val;
    });
    if (hasData) rows.push(obj);
  }
  return rows;
}

async function readStockReport() {
  log('Reading stock report.xlsx ...');
  const rows = await readExcelRows('stock report.xlsx', 1, 2);
  const products = new Map();
  let skipped = 0;

  for (const r of rows) {
    const barcode = normalizeBarcode(r.C10);
    if (!barcode) { skipped++; continue; }
    const categoryName = trimStr(r.C2);
    if (!categoryName || categoryName === '----') { skipped++; continue; }

    let size = r.C4;
    if (size === null || size === undefined || size === 'null') size = null;
    else {
      size = trimStr(size);
      if (size === '.' || size === '') size = null;
    }

    const rawProductName = trimStr(r.C3);
    const productName = (!rawProductName || rawProductName === '0')
      ? categoryName
      : rawProductName;

    products.set(barcode, {
      barcode,
      categoryName,
      productName,
      size: (size instanceof Date) ? null : size,
      stockReportQty: toNum(r.C5),
      pcsPerBox: toNum(r.C6) || 1,
      purchaseRate: toNum(r.C7),
      saleRate: toNum(r.C8),
      articleNo: (r.C9 instanceof Date) ? null : (trimStr(r.C9) || null),
    });
  }

  log(`  Stock report: ${products.size} products parsed, ${skipped} skipped (no barcode/category)`);
  return products;
}

function readRptStock() {
  log('Reading rptstock.xls ...');
  const wb = XLSX.readFile(path.join(DATA_DIR, 'rptstock.xls'));
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const openingStock = new Map();
  let dataStarted = false;
  let parsed = 0;

  for (const row of jsonData) {
    if (!dataStarted) {
      if (String(row[0]).trim() === 'Invoice No.') {
        dataStarted = true;
      }
      continue;
    }

    const barcode = normalizeBarcode(row[10]);
    const balQty = toNum(row[9]);
    if (!barcode) continue;
    if (String(row[8]).trim() === 'TOTAL :') continue;

    const existing = openingStock.get(barcode) || {
      barcode,
      balQty: 0,
      itemName: trimStr(row[4]),
      size: trimStr(row[8]) || null,
      purchaseRate: toNum(row[14] || row[11]),
    };
    existing.balQty += balQty;
    openingStock.set(barcode, existing);
    parsed++;
  }

  log(`  rptstock: ${parsed} rows parsed, ${openingStock.size} unique barcodes`);
  return openingStock;
}

async function readPurchaseReports() {
  const files = [
    'Product Purchase Report 2023-01-01 - 2023-12-31.xlsx',
    'Product Purchase Report 2024-01-01 - 2024-12-31.xlsx',
    'Product Purchase Report 2025-01-01 - 2025-12-31.xlsx',
    'Product Purchase Report 2026-01-01 - 2026-05-31.xlsx',
  ];

  log('Reading purchase reports ...');
  const allItems = [];

  for (const f of files) {
    const rows = await readExcelRows(f, 4, 5);
    let count = 0;
    for (const r of rows) {
      const billNo = trimStr(r.C2);
      const barcode = normalizeBarcode(r.C12);
      if (!billNo || billNo === '----') continue;
      const billUpper = billNo.toUpperCase();
      if (billUpper === 'TOTAL' || billUpper === 'GRAND TOTAL' || billUpper.startsWith('TOTAL :')) continue;

      const parsedDate = parseDate(r.C3);
      if (!parsedDate) continue;

      const { name, size } = splitProductNameSize(r.C5);
      allItems.push({
        supplierName: trimStr(r.C1),
        billNo,
        date: parsedDate,
        companyName: trimStr(r.C4),
        productName: name,
        size,
        qty: toNum(r.C6),
        mrp: toNum(r.C7),
        rate: toNum(r.C8),
        discPct: toNum(r.C9),
        discAmt: toNum(r.C10),
        netTotal: toNum(r.C11),
        barcode,
      });
      count++;
    }
    log(`  ${path.basename(f)}: ${count} items`);
  }

  log(`  Total purchase items: ${allItems.length}`);
  return allItems;
}

async function readSalesReports() {
  const files = [
    'Product Sales Report 2023-01-01 - 2023-06-30.xlsx',
    'Product Sales Report 2023-07-01 - 2023-12-31.xlsx',
    'Product Sales Report 2024-01-01 - 2024-06-30.xlsx',
    'Product Sales Report 2024-07-01 - 2024-12-31.xlsx',
    'Product Sales Report 2025-01-01 - 2025-06-30.xlsx',
    'Product Sales Report 2025-07-01 - 2025-12-31.xlsx',
    'Product Sales Report 2026-01-01 - 2026-05-17.xlsx',
  ];

  log('Reading sales reports ...');
  const allItems = [];

  for (const f of files) {
    const rows = await readExcelRows(f, 4, 5);
    let count = 0;
    for (const r of rows) {
      const billNo = trimStr(r.C2);
      const barcode = normalizeBarcode(r.C12);
      if (!billNo || billNo === '----') continue;
      const billUpper = billNo.toUpperCase();
      if (billUpper === 'TOTAL' || billUpper === 'GRAND TOTAL' || billUpper.startsWith('TOTAL :')) continue;

      const parsedDate = parseDate(r.C3);
      if (!parsedDate) continue;

      const { name, size } = splitProductNameSize(r.C5);
      allItems.push({
        customerName: trimStr(r.C1),
        billNo,
        date: parsedDate,
        companyName: trimStr(r.C4),
        productName: name,
        size,
        qty: toNum(r.C6),
        rate: toNum(r.C7),
        discPct: toNum(r.C8),
        discAmt: toNum(r.C9),
        netTotal: toNum(r.C10),
        purchaseCost: toNum(r.C11),
        barcode,
      });
      count++;
    }
    log(`  ${path.basename(f)}: ${count} items`);
  }

  log(`  Total sales items: ${allItems.length}`);
  return allItems;
}

async function readCustomerPayments() {
  const files = [
    'Customer Payment Receipt Report 2023-01-01 - 2023-06-30.xlsx',
    'Customer Payment Receipt Report 2023-07-01 - 2023-12-31.xlsx',
    'Customer Payment Receipt Report 2024-01-01 - 2024-12-31.xlsx',
    'Customer Payment Receipt Report 2025-01-01 - 2025-12-31.xlsx',
    'Customer Payment Receipt Report 2026-01-01 - 2026-05-17.xlsx',
  ];

  log('Reading customer payment reports ...');
  const allPayments = [];

  for (const f of files) {
    const rows = await readExcelRows(f, 4, 5);
    let count = 0;
    for (const r of rows) {
      const particular = trimStr(r.C4);
      if (!particular || particular === '----' || particular === 'TOTAL') continue;

      allPayments.push({
        receiptNo: toNum(r.C1),
        billNo: toNum(r.C2),
        billDate: parseDate(r.C3),
        customerName: particular,
        payMode: trimStr(r.C5),
        payDate: parseDate(r.C6),
        chequeNo: trimStr(r.C8),
        bankName: trimStr(r.C9),
        amount: toNum(r.C11),
      });
      count++;
    }
    log(`  ${path.basename(f)}: ${count} payments`);
  }

  log(`  Total customer payments: ${allPayments.length}`);
  return allPayments;
}

async function readSupplierPayments() {
  const files = [
    'Supplier Payment Receipt Report.2023-01-01 - 2023-12-31.xlsx',
    'Supplier Payment Receipt Report.2024-01-01 - 2024-12-31.xlsx',
    'Supplier Payment Receipt Report.2025-01-01 - 2025-12-31.xlsx',
    'Supplier Payment Receipt Report.2026-01-01 - 2026-05-17.xlsx',
  ];

  log('Reading supplier payment reports ...');
  const allPayments = [];

  for (const f of files) {
    const rows = await readExcelRows(f, 4, 5);
    let count = 0;
    for (const r of rows) {
      const particular = trimStr(r.C4);
      if (!particular || particular === '----' || particular === 'TOTAL') continue;

      allPayments.push({
        receiptNo: toNum(r.C1),
        invNo: toNum(r.C2),
        billDate: parseDate(r.C3),
        supplierName: particular,
        payMode: trimStr(r.C5),
        payDate: parseDate(r.C6),
        chequeNo: trimStr(r.C8),
        bankName: trimStr(r.C9),
        amount: toNum(r.C11),
      });
      count++;
    }
    log(`  ${path.basename(f)}: ${count} payments`);
  }

  log(`  Total supplier payments: ${allPayments.length}`);
  return allPayments;
}

async function readCustomerInfo() {
  log('Reading Customer Information.xlsx ...');
  const rows = await readExcelRows('Customer Information.xlsx', 4, 5);
  const customers = [];
  for (const r of rows) {
    const name = trimStr(r.C2);
    if (!name || name === '----') continue;
    customers.push({
      name,
      address: trimStr(r.C3) === '-' ? '' : trimStr(r.C3),
      contact1: trimStr(r.C4) === '-' ? '' : trimStr(r.C4),
      contact2: trimStr(r.C5) === '-' ? '' : trimStr(r.C5),
      aadhar: trimStr(r.C6) === '-' ? '' : trimStr(r.C6),
      pan: trimStr(r.C7) === '-' ? '' : trimStr(r.C7),
      closingBalance: toNum(r.C8),
    });
  }
  log(`  Customers: ${customers.length}`);
  return customers;
}

async function readSupplierInfo() {
  log('Reading Supplier Information.xlsx ...');
  const rows = await readExcelRows('Supplier Information.xlsx', 4, 5);
  const suppliers = [];
  for (const r of rows) {
    const name = trimStr(r.C2);
    if (!name || name === '----') continue;
    suppliers.push({
      name,
      firmName: trimStr(r.C3) === '-' ? '' : trimStr(r.C3),
      address: trimStr(r.C4) === '-' ? '' : trimStr(r.C4),
      contact1: trimStr(r.C5) === '-' ? '' : trimStr(r.C5),
      contact2: trimStr(r.C6) === '-' ? '' : trimStr(r.C6),
      closingBalance: toNum(r.C7),
    });
  }
  log(`  Suppliers: ${suppliers.length}`);
  return suppliers;
}

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 2: DATA TRANSFORMATION
// ═══════════════════════════════════════════════════════════════════════

function buildCategoryList(stockProducts, purchaseItems, salesItems) {
  logSection('BUILDING CATEGORIES');
  const catSet = new Set();

  for (const [, p] of stockProducts) {
    if (p.categoryName) catSet.add(p.categoryName);
  }
  for (const item of purchaseItems) {
    if (item.companyName) catSet.add(item.companyName);
  }
  for (const item of salesItems) {
    if (item.companyName) catSet.add(item.companyName);
  }

  const categories = [...catSet].sort();
  log(`  Unique categories: ${categories.length}`);
  return categories;
}

function buildProductMaster(stockProducts, openingStock, purchaseItems, salesItems) {
  logSection('BUILDING PRODUCT MASTER');
  const master = new Map(stockProducts);

  let fromRptstock = 0;
  for (const [barcode, info] of openingStock) {
    if (!master.has(barcode)) {
      master.set(barcode, {
        barcode,
        categoryName: info.itemName || 'UNCATEGORIZED',
        productName: info.itemName || 'UNCATEGORIZED',
        size: info.size,
        stockReportQty: 0,
        pcsPerBox: 1,
        purchaseRate: info.purchaseRate || 0,
        saleRate: 0,
        articleNo: null,
      });
      fromRptstock++;
    }
  }

  let fromPurchase = 0;
  for (const item of purchaseItems) {
    if (!item.barcode) continue;
    if (!master.has(item.barcode)) {
      master.set(item.barcode, {
        barcode: item.barcode,
        categoryName: item.companyName || item.productName || 'UNCATEGORIZED',
        productName: item.productName || item.companyName || 'UNKNOWN',
        size: item.size,
        stockReportQty: 0,
        pcsPerBox: 1,
        purchaseRate: item.rate || 0,
        saleRate: item.mrp || 0,
        articleNo: null,
      });
      fromPurchase++;
    }
  }

  let fromSales = 0;
  for (const item of salesItems) {
    if (!item.barcode) continue;
    if (!master.has(item.barcode)) {
      master.set(item.barcode, {
        barcode: item.barcode,
        categoryName: item.companyName || item.productName || 'UNCATEGORIZED',
        productName: item.productName || item.companyName || 'UNKNOWN',
        size: item.size,
        stockReportQty: 0,
        pcsPerBox: 1,
        purchaseRate: 0,
        saleRate: item.rate || 0,
        articleNo: null,
      });
      fromSales++;
    }
  }

  log(`  Products from stock report: ${stockProducts.size}`);
  log(`  Additional from rptstock: ${fromRptstock}`);
  log(`  Additional from purchases: ${fromPurchase}`);
  log(`  Additional from sales: ${fromSales}`);
  log(`  TOTAL unique products: ${master.size}`);
  return master;
}

function groupPurchaseBills(purchaseItems) {
  logSection('GROUPING PURCHASE BILLS');
  const billMap = new Map();

  for (const item of purchaseItems) {
    const key = `${item.billNo}__${item.date}__${item.supplierName}`;
    if (!billMap.has(key)) {
      billMap.set(key, {
        billNo: item.billNo,
        date: item.date,
        supplierName: item.supplierName,
        items: [],
        totalAmount: 0,
        totalQty: 0,
      });
    }
    const bill = billMap.get(key);
    bill.items.push(item);
    bill.totalAmount += item.netTotal;
    bill.totalQty += item.qty;
  }

  const bills = [...billMap.values()];
  log(`  Purchase bills: ${bills.length}`);
  log(`  Total purchase items: ${purchaseItems.length}`);
  log(`  Total purchase value: ${bills.reduce((s, b) => s + b.totalAmount, 0).toFixed(2)}`);
  return bills;
}

function groupSalesBills(salesItems) {
  logSection('GROUPING SALES BILLS');
  const billMap = new Map();

  for (const item of salesItems) {
    const key = `${item.billNo}__${item.date}__${item.customerName}`;
    if (!billMap.has(key)) {
      billMap.set(key, {
        billNo: item.billNo,
        date: item.date,
        customerName: item.customerName,
        items: [],
        totalAmount: 0,
        totalQty: 0,
      });
    }
    const bill = billMap.get(key);
    bill.items.push(item);
    bill.totalAmount += item.netTotal;
    bill.totalQty += item.qty;
  }

  const bills = [...billMap.values()];
  log(`  Sales bills: ${bills.length}`);
  log(`  Total sales items: ${salesItems.length}`);
  log(`  Total sales value: ${bills.reduce((s, b) => s + b.totalAmount, 0).toFixed(2)}`);
  return bills;
}

function calculateOpeningBalances(
  customers, suppliers,
  salesBills, purchaseBills,
  customerPayments, supplierPayments,
) {
  logSection('CALCULATING OPENING BALANCES');

  // Customer: sum all sales by customer name
  const custSalesTotal = new Map();
  for (const bill of salesBills) {
    const name = bill.customerName.toUpperCase();
    custSalesTotal.set(name, (custSalesTotal.get(name) || 0) + bill.totalAmount);
  }

  // Customer: sum all receipts by customer name
  const custReceiptsTotal = new Map();
  for (const pmt of customerPayments) {
    const name = pmt.customerName.toUpperCase();
    custReceiptsTotal.set(name, (custReceiptsTotal.get(name) || 0) + pmt.amount);
  }

  // Calculate opening for each customer
  let custChecks = { matched: 0, mismatched: 0 };
  for (const cust of customers) {
    const name = cust.name.toUpperCase();
    const sales = custSalesTotal.get(name) || 0;
    const receipts = custReceiptsTotal.get(name) || 0;

    // Opening + Sales - Receipts = Closing
    // Opening = Closing - Sales + Receipts
    cust.totalSales = sales;
    cust.totalReceipts = receipts;
    cust.openingBalance = cust.closingBalance - sales + receipts;

    if (cust.openingBalance >= 0) {
      cust.openingBalanceType = 'Receivable';
    } else {
      cust.openingBalanceType = 'Payable';
      cust.openingBalance = Math.abs(cust.openingBalance);
    }

    // Verification: opening + sales - receipts should = closing
    const signedOpening = cust.openingBalanceType === 'Receivable'
      ? cust.openingBalance : -cust.openingBalance;
    const recomputed = signedOpening + sales - receipts;
    const diff = Math.abs(recomputed - cust.closingBalance);
    if (diff > 0.01) {
      custChecks.mismatched++;
      log(`  WARNING: Customer "${cust.name}" balance mismatch: recomputed=${recomputed.toFixed(2)}, closing=${cust.closingBalance.toFixed(2)}, diff=${diff.toFixed(2)}`);
    } else {
      custChecks.matched++;
    }
  }
  log(`  Customer balances: ${custChecks.matched} matched, ${custChecks.mismatched} mismatched`);

  // Supplier: sum all purchases by supplier name
  const suppPurchaseTotal = new Map();
  for (const bill of purchaseBills) {
    const name = bill.supplierName.toUpperCase();
    suppPurchaseTotal.set(name, (suppPurchaseTotal.get(name) || 0) + bill.totalAmount);
  }

  // Supplier: sum all payments by supplier name
  const suppPaymentsTotal = new Map();
  for (const pmt of supplierPayments) {
    const name = pmt.supplierName.toUpperCase();
    suppPaymentsTotal.set(name, (suppPaymentsTotal.get(name) || 0) + pmt.amount);
  }

  let suppChecks = { matched: 0, mismatched: 0 };
  for (const supp of suppliers) {
    const name = supp.name.toUpperCase();
    const purchases = suppPurchaseTotal.get(name) || 0;
    const payments = suppPaymentsTotal.get(name) || 0;

    // Opening + Purchases - Payments = Closing
    // Opening = Closing - Purchases + Payments
    supp.totalPurchases = purchases;
    supp.totalPayments = payments;
    supp.openingBalance = supp.closingBalance - purchases + payments;

    if (supp.openingBalance >= 0) {
      supp.openingBalanceType = 'Payable';
    } else {
      supp.openingBalanceType = 'Receivable';
      supp.openingBalance = Math.abs(supp.openingBalance);
    }

    const signedOpening = supp.openingBalanceType === 'Payable'
      ? supp.openingBalance : -supp.openingBalance;
    const recomputed = signedOpening + purchases - payments;
    const diff = Math.abs(recomputed - supp.closingBalance);
    if (diff > 0.01) {
      suppChecks.mismatched++;
      log(`  WARNING: Supplier "${supp.name}" balance mismatch: recomputed=${recomputed.toFixed(2)}, closing=${supp.closingBalance.toFixed(2)}, diff=${diff.toFixed(2)}`);
    } else {
      suppChecks.matched++;
    }
  }
  log(`  Supplier balances: ${suppChecks.matched} matched, ${suppChecks.mismatched} mismatched`);
}

function calculateStockPerBarcode(openingStock, purchaseItems, salesItems) {
  logSection('CALCULATING STOCK PER BARCODE');
  const stock = new Map();

  // Opening stock from rptstock
  for (const [barcode, info] of openingStock) {
    stock.set(barcode, { opening: info.balQty, purchased: 0, sold: 0 });
  }

  // Add purchases
  for (const item of purchaseItems) {
    if (!item.barcode) continue;
    if (!stock.has(item.barcode)) {
      stock.set(item.barcode, { opening: 0, purchased: 0, sold: 0 });
    }
    stock.get(item.barcode).purchased += item.qty;
  }

  // Subtract sales
  for (const item of salesItems) {
    if (!item.barcode) continue;
    if (!stock.has(item.barcode)) {
      stock.set(item.barcode, { opening: 0, purchased: 0, sold: 0 });
    }
    stock.get(item.barcode).sold += item.qty;
  }

  // Calculate final
  let totalOpening = 0, totalPurchased = 0, totalSold = 0, totalFinal = 0;
  let negativeCount = 0;
  for (const [barcode, s] of stock) {
    s.final = s.opening + s.purchased - s.sold;
    totalOpening += s.opening;
    totalPurchased += s.purchased;
    totalSold += s.sold;
    totalFinal += s.final;
    if (s.final < 0) negativeCount++;
  }

  log(`  Barcodes with stock activity: ${stock.size}`);
  log(`  Total opening stock (rptstock): ${totalOpening}`);
  log(`  Total purchased: ${totalPurchased}`);
  log(`  Total sold: ${totalSold}`);
  log(`  Total final stock: ${totalFinal}`);
  log(`  Items with negative stock: ${negativeCount}`);
  return stock;
}

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 3: DRY RUN REPORT
// ═══════════════════════════════════════════════════════════════════════

function printDryRunReport(data) {
  logSection('DRY RUN SUMMARY');

  log(`Categories: ${data.categories.length}`);
  log(`Products: ${data.productMaster.size}`);
  log(`Customers: ${data.customers.length} (excl CASH)`);
  log(`Suppliers: ${data.suppliers.length}`);
  log(`Purchase Bills: ${data.purchaseBills.length}`);
  log(`Sales Bills: ${data.salesBills.length}`);
  log(`Customer Payments: ${data.customerPayments.length}`);
  log(`Supplier Payments: ${data.supplierPayments.length}`);

  log('');
  log('── Financial Totals ──');
  const purchaseTotal = data.purchaseBills.reduce((s, b) => s + b.totalAmount, 0);
  const salesTotal = data.salesBills.reduce((s, b) => s + b.totalAmount, 0);
  const custPayTotal = data.customerPayments.reduce((s, p) => s + p.amount, 0);
  const suppPayTotal = data.supplierPayments.reduce((s, p) => s + p.amount, 0);
  log(`  Total Purchase Value: ${purchaseTotal.toFixed(2)}`);
  log(`  Total Sales Value: ${salesTotal.toFixed(2)}`);
  log(`  Total Customer Receipts: ${custPayTotal.toFixed(2)}`);
  log(`  Total Supplier Payments: ${suppPayTotal.toFixed(2)}`);

  log('');
  log('── Customer Opening Balances Sample (top 10) ──');
  const topCust = [...data.customers]
    .sort((a, b) => Math.abs(b.closingBalance) - Math.abs(a.closingBalance))
    .slice(0, 10);
  for (const c of topCust) {
    log(`  ${c.name}: closing=${c.closingBalance}, opening=${c.openingBalance} (${c.openingBalanceType}), sales=${c.totalSales?.toFixed(2)}, receipts=${c.totalReceipts?.toFixed(2)}`);
  }

  log('');
  log('── Supplier Opening Balances Sample (top 10) ──');
  const topSupp = [...data.suppliers]
    .sort((a, b) => Math.abs(b.closingBalance) - Math.abs(a.closingBalance))
    .slice(0, 10);
  for (const s of topSupp) {
    log(`  ${s.name}: closing=${s.closingBalance}, opening=${s.openingBalance} (${s.openingBalanceType}), purchases=${s.totalPurchases?.toFixed(2)}, payments=${s.totalPayments?.toFixed(2)}`);
  }

  log('');
  log('── Payment Mode Distribution ──');
  const custModes = {};
  for (const p of data.customerPayments) {
    const mode = mapPayMode(p.payMode, p.chequeNo);
    custModes[mode] = (custModes[mode] || 0) + 1;
  }
  log(`  Customer: ${JSON.stringify(custModes)}`);
  const suppModes = {};
  for (const p of data.supplierPayments) {
    const mode = mapPayMode(p.payMode, p.chequeNo);
    suppModes[mode] = (suppModes[mode] || 0) + 1;
  }
  log(`  Supplier: ${JSON.stringify(suppModes)}`);

  log('');
  log('── Receipt=0 (Paid-in-Bill) Distribution ──');
  const custZero = data.customerPayments.filter(p => p.receiptNo === 0);
  const custNonZero = data.customerPayments.filter(p => p.receiptNo !== 0);
  log(`  Customer: ${custZero.length} paid-in-bill, ${custNonZero.length} separate receipts`);
  const suppZero = data.supplierPayments.filter(p => p.receiptNo === 0);
  const suppNonZero = data.supplierPayments.filter(p => p.receiptNo !== 0);
  log(`  Supplier: ${suppZero.length} paid-in-bill, ${suppNonZero.length} separate payments`);
}

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 4: DATABASE IMPORT
// ═══════════════════════════════════════════════════════════════════════

async function importToDatabase(data) {
  logSection('DATABASE IMPORT');
  const pool = new Pool(DB_CONFIG);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    log('Transaction started.');

    // ── 4.1 Categories ──────────────────────────────────────────────
    log('Inserting categories ...');
    const categoryIdMap = new Map();
    for (const catName of data.categories) {
      const res = await client.query(
        `INSERT INTO categories (category_name, is_active)
         VALUES ($1, true)
         ON CONFLICT DO NOTHING
         RETURNING category_id`,
        [catName],
      );
      if (res.rows.length > 0) {
        categoryIdMap.set(catName, res.rows[0].category_id);
      }
    }
    // Fetch all (in case some existed)
    const catRes = await client.query('SELECT category_id, category_name FROM categories');
    for (const r of catRes.rows) {
      categoryIdMap.set(r.category_name, r.category_id);
    }
    log(`  Categories inserted: ${categoryIdMap.size}`);

    // ── 4.2 Products ────────────────────────────────────────────────
    log('Inserting products ...');
    const productIdMap = new Map(); // barcode → product_id

    // Column limits: DECIMAL(10,2) max=99999999.99, DECIMAL(15,2) max=9999999999999.99
    const clamp10 = (v) => Math.min(Math.max(toNum(v), -99999999.99), 99999999.99);
    const clamp15 = (v) => Math.min(Math.max(toNum(v), -9999999999999.99), 9999999999999.99);
    const clamp8  = (v) => Math.min(Math.max(toNum(v), -999999.99), 999999.99);

    const productChunks = chunkArray([...data.productMaster.values()], 500);
    let productCount = 0;
    let clampedCount = 0;

    for (const chunk of productChunks) {
      const values = [];
      const params = [];
      let idx = 1;

      for (const p of chunk) {
        const catId = categoryIdMap.get(p.categoryName) || null;
        const openingQty = data.stockPerBarcode.get(p.barcode)?.opening || 0;
        const currentQty = data.stockPerBarcode.get(p.barcode)?.final || 0;

        const rawPcsPerBox = toNum(p.pcsPerBox) || 1;
        const rawOpeningQty = toNum(openingQty);
        const rawCurrentQty = toNum(currentQty);
        const rawPurchaseRate = toNum(p.purchaseRate);
        const rawSaleRate = toNum(p.saleRate);

        const cPcsPerBox = clamp10(rawPcsPerBox);
        const cOpeningQty = clamp10(rawOpeningQty);
        const cCurrentQty = clamp10(rawCurrentQty);
        const cPurchaseRate = clamp15(rawPurchaseRate);
        const cSaleRate = clamp15(rawSaleRate);
        const cOpeningRate = clamp15(rawPurchaseRate);

        if (cPcsPerBox !== rawPcsPerBox || cOpeningQty !== rawOpeningQty ||
            cCurrentQty !== rawCurrentQty || cPurchaseRate !== rawPurchaseRate ||
            cSaleRate !== rawSaleRate) {
          clampedCount++;
          log(`  CLAMPED barcode=${p.barcode}: pcsPerBox=${rawPcsPerBox}→${cPcsPerBox}, opening=${rawOpeningQty}→${cOpeningQty}, current=${rawCurrentQty}→${cCurrentQty}, purchRate=${rawPurchaseRate}→${cPurchaseRate}, saleRate=${rawSaleRate}→${cSaleRate}`);
        }

        values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9},$${idx+10},$${idx+11},$${idx+12},$${idx+13},NOW(),NOW())`);
        params.push(
          trunc(p.barcode, 20),  // $1 barcode
          catId,               // $2 category_id
          trunc(p.productName, 200),  // $3 product_name
          trunc(p.size, 100),  // $4 size_value
          trunc(p.articleNo, 200),  // $5 article_number
          0,                   // $6 gst_rate
          cPcsPerBox,          // $7 quantity_per_box
          cOpeningQty,         // $8 opening_stock
          cOpeningRate,        // $9 opening_stock_rate
          '2023-01-01',        // $10 opening_stock_date
          cCurrentQty,         // $11 current_stock
          cPurchaseRate,       // $12 purchase_rate
          cSaleRate,           // $13 sale_rate
          cSaleRate,           // $14 mrp
        );
        idx += 14;
      }

      await client.query(
        `INSERT INTO products (barcode, category_id, product_name, size_value, article_number,
         gst_rate, quantity_per_box, opening_stock, opening_stock_rate, opening_stock_date,
         current_stock, purchase_rate, sale_rate, mrp, created_date, modified_date)
         VALUES ${values.join(',')}`,
        params,
      );
      productCount += chunk.length;
    }
    if (clampedCount > 0) log(`  WARNING: ${clampedCount} products had values clamped to fit column limits`);

    // Fetch all product IDs by barcode
    const prodRes = await client.query('SELECT product_id, barcode FROM products');
    for (const r of prodRes.rows) {
      productIdMap.set(r.barcode, r.product_id);
    }
    log(`  Products inserted: ${productCount}, mapped: ${productIdMap.size}`);

    // ── 4.2b Godown stock ──────────────────────────────────────────
    // Assign all imported stock to the default godown so the sales
    // validation (which checks product_godown_stock, not products.current_stock)
    // doesn't reject every bill with "Insufficient stock".
    const defaultGodown = await client.query(
      `SELECT godown_id FROM godowns WHERE is_default = true LIMIT 1`,
    );
    if (defaultGodown.rows.length) {
      const gdId = defaultGodown.rows[0].godown_id;
      const gdResult = await client.query(
        `INSERT INTO product_godown_stock (product_id, godown_id, current_stock, opening_stock, created_date, modified_date)
         SELECT product_id, $1, current_stock, current_stock, NOW(), NOW()
         FROM products
         ON CONFLICT DO NOTHING`,
        [gdId],
      );
      log(`  Godown stock rows created: ${gdResult.rowCount} (godown_id=${gdId})`);
    }

    // ── 4.3 Parties (Customers) ─────────────────────────────────────
    log('Inserting customers ...');
    const customerIdMap = new Map(); // name (uppercase) → party_id

    // The existing "Cash" party (id=1) maps to "CASH" customer
    customerIdMap.set('CASH', 1);

    for (const cust of data.customers) {
      if (cust.name.toUpperCase() === 'CASH') continue;

      const res = await client.query(
        `INSERT INTO parties (party_type, party_name, mobile_1, mobile_2, address_line_1,
         aadhar_number, pan_number, opening_balance, opening_balance_type,
         current_balance, credit_allowed, is_active, created_date, modified_date)
         VALUES ('Customer', $1, $2, $3, $4, $5, $6, $7, $8::enum_parties_opening_balance_type,
                 $9, true, true, NOW(), NOW())
         RETURNING party_id`,
        [
          cust.name,
          cust.contact1 || '',
          cust.contact2 || '',
          cust.address || '',
          cust.aadhar || '',
          cust.pan || '',
          cust.openingBalance,
          cust.openingBalanceType,
          cust.closingBalance,
        ],
      );
      customerIdMap.set(cust.name.toUpperCase(), res.rows[0].party_id);
    }
    log(`  Customers inserted: ${customerIdMap.size}`);

    // Check for customers in sales that aren't in info
    const missingCustNames = new Set();
    for (const bill of data.salesBills) {
      const name = bill.customerName.toUpperCase();
      if (!customerIdMap.has(name)) {
        missingCustNames.add(bill.customerName);
      }
    }
    for (const pmt of data.customerPayments) {
      const name = pmt.customerName.toUpperCase();
      if (!customerIdMap.has(name)) {
        missingCustNames.add(pmt.customerName);
      }
    }
    if (missingCustNames.size > 0) {
      log(`  Creating ${missingCustNames.size} customers found in sales/payments but not in info ...`);
      for (const name of missingCustNames) {
        const res = await client.query(
          `INSERT INTO parties (party_type, party_name, mobile_1, opening_balance,
           opening_balance_type, current_balance, credit_allowed, is_active,
           created_date, modified_date)
           VALUES ('Customer', $1, '', 0, 'Receivable', 0, true, true, NOW(), NOW())
           RETURNING party_id`,
          [name],
        );
        customerIdMap.set(name.toUpperCase(), res.rows[0].party_id);
      }
    }

    // ── 4.4 Parties (Suppliers) ─────────────────────────────────────
    log('Inserting suppliers ...');
    const supplierIdMap = new Map(); // name (uppercase) → party_id

    for (const supp of data.suppliers) {
      const nameUpper = supp.name.toUpperCase();
      if (nameUpper === 'CASH' && customerIdMap.has('CASH')) {
        supplierIdMap.set(nameUpper, customerIdMap.get('CASH'));
        continue;
      }

      const res = await client.query(
        `INSERT INTO parties (party_type, party_name, display_name, mobile_1, mobile_2,
         address_line_1, opening_balance, opening_balance_type,
         current_balance, credit_allowed, is_active, created_date, modified_date)
         VALUES ('Supplier', $1, $2, $3, $4, $5, $6, $7::enum_parties_opening_balance_type,
                 $8, true, true, NOW(), NOW())
         RETURNING party_id`,
        [
          supp.name,
          supp.firmName || '',
          supp.contact1 || '',
          supp.contact2 || '',
          supp.address || '',
          supp.openingBalance,
          supp.openingBalanceType,
          supp.closingBalance,
        ],
      );
      supplierIdMap.set(nameUpper, res.rows[0].party_id);
    }
    log(`  Suppliers inserted: ${supplierIdMap.size}`);

    // Create missing suppliers
    const missingSuppNames = new Set();
    for (const bill of data.purchaseBills) {
      const name = bill.supplierName.toUpperCase();
      if (!supplierIdMap.has(name)) missingSuppNames.add(bill.supplierName);
    }
    for (const pmt of data.supplierPayments) {
      const name = pmt.supplierName.toUpperCase();
      if (!supplierIdMap.has(name)) missingSuppNames.add(pmt.supplierName);
    }
    if (missingSuppNames.size > 0) {
      log(`  Creating ${missingSuppNames.size} suppliers found in purchases/payments but not in info ...`);
      for (const name of missingSuppNames) {
        const res = await client.query(
          `INSERT INTO parties (party_type, party_name, mobile_1, opening_balance,
           opening_balance_type, current_balance, credit_allowed, is_active,
           created_date, modified_date)
           VALUES ('Supplier', $1, '', 0, 'Payable', 0, true, true, NOW(), NOW())
           RETURNING party_id`,
          [name],
        );
        supplierIdMap.set(name.toUpperCase(), res.rows[0].party_id);
      }
    }

    // ── 4.5 Purchase Bills + Items ──────────────────────────────────
    log('Inserting purchase bills ...');
    const purchaseBillIdMap = new Map(); // groupKey → purchase_bill_id
    const purchaseBillNoMap = new Map(); // unique bill_number → purchase_bill_id
    let purchItemCount = 0;

    // Deduplicate bill numbers: prefix with P- and add suffix for collisions
    const usedPurchBillNos = new Set();
    for (const bill of data.purchaseBills) {
      let billNumber = `P-${bill.billNo}`;
      if (usedPurchBillNos.has(billNumber)) {
        let suffix = 2;
        while (usedPurchBillNos.has(`${billNumber}-${suffix}`)) suffix++;
        billNumber = `${billNumber}-${suffix}`;
      }
      usedPurchBillNos.add(billNumber);
      bill.uniqueBillNumber = billNumber;
    }

    for (const bill of data.purchaseBills) {
      const supplierId = supplierIdMap.get(bill.supplierName.toUpperCase()) || null;

      const billRes = await client.query(
        `INSERT INTO purchase_bills (bill_number, supplier_id, supplier_bill_number, bill_date,
         total_items, total_quantity, sub_total, discount_amount, discount_percentage,
         cgst_pct, sgst_pct, igst_pct, cgst_amount, sgst_amount, igst_amount,
         cess_amount, round_off, total_amount, paid_amount, balance_amount,
         payment_status, reverse_charge, is_cancelled,
         created_date, modified_date)
         VALUES ($1, $2, $3, $4::date,
                 $5, $6, $7, 0, 0,
                 0, 0, 0, 0, 0, 0,
                 0, 0, $7, 0, $7,
                 'Unpaid', false, false,
                 ($4::date || ' 12:00:00')::timestamptz, ($4::date || ' 12:00:00')::timestamptz)
         RETURNING purchase_bill_id`,
        [
          bill.uniqueBillNumber,
          supplierId,
          bill.billNo,
          bill.date,
          bill.items.length,
          bill.totalQty,
          bill.totalAmount,
        ],
      );

      const billId = billRes.rows[0].purchase_bill_id;
      purchaseBillIdMap.set(`${bill.billNo}__${bill.date}__${bill.supplierName}`, billId);
      purchaseBillNoMap.set(bill.billNo, billId);

      // Insert items
      for (const item of bill.items) {
        const productId = item.barcode ? (productIdMap.get(item.barcode) || null) : null;
        const catId = item.companyName ? (categoryIdMap.get(item.companyName) || null) : null;

        await client.query(
          `INSERT INTO purchase_bill_items (purchase_bill_id, product_id, barcode,
           category_name, product_name, size, article_number,
           quantity, quantity_per_box, purchase_rate, sale_rate, mrp,
           discount_percentage, discount_amount, taxable_amount,
           gst_rate, cgst_amount, sgst_amount, igst_amount, cess_amount,
           total_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, 0, 0, 0, 0, 0, $15)`,
          [
            billId,
            productId,
            trunc(item.barcode, 20),
            trunc(item.companyName, 100),
            trunc(item.productName, 200),
            trunc(item.size, 20),
            productId ? trunc(data.productMaster.get(item.barcode)?.articleNo, 50) : null,
            item.qty,
            productId ? (data.productMaster.get(item.barcode)?.pcsPerBox || 1) : 1,
            item.rate,
            item.mrp,
            item.mrp,
            item.discPct,
            item.discAmt,
            item.netTotal,
          ],
        );
        purchItemCount++;
      }
    }
    log(`  Purchase bills inserted: ${purchaseBillIdMap.size}, items: ${purchItemCount}`);

    // ── 4.6 Sales Bills + Items ─────────────────────────────────────
    log('Inserting sales bills ...');
    const salesBillIdMap = new Map(); // groupKey → sales_bill_id
    const salesBillNoMap = new Map(); // original billNo → sales_bill_id (last one wins for payment matching)
    let salesItemCount = 0;

    // Deduplicate sales bill numbers
    const usedSalesBillNos = new Set();
    for (const bill of data.salesBills) {
      let billNumber = `S-${bill.billNo}`;
      if (usedSalesBillNos.has(billNumber)) {
        let suffix = 2;
        while (usedSalesBillNos.has(`${billNumber}-${suffix}`)) suffix++;
        billNumber = `${billNumber}-${suffix}`;
      }
      usedSalesBillNos.add(billNumber);
      bill.uniqueBillNumber = billNumber;
    }

    for (const bill of data.salesBills) {
      const customerId = customerIdMap.get(bill.customerName.toUpperCase()) || null;

      const billRes = await client.query(
        `INSERT INTO sales_bills (bill_number, customer_id, bill_date,
         total_items, total_quantity, sub_total, discount_amount, discount_percentage,
         cgst_pct, sgst_pct, igst_pct, cgst_amount, sgst_amount, igst_amount,
         cess_amount, round_off, total_amount, paid_amount, balance_amount,
         payment_status, is_cancelled,
         created_date, modified_date)
         VALUES ($1, $2, $3::date,
                 $4, $5, $6, 0, 0,
                 0, 0, 0, 0, 0, 0,
                 0, 0, $6, 0, $6,
                 'Unpaid', false,
                 ($3::date || ' 12:00:00')::timestamptz, ($3::date || ' 12:00:00')::timestamptz)
         RETURNING sales_bill_id`,
        [
          bill.uniqueBillNumber,
          customerId,
          bill.date,
          bill.items.length,
          bill.totalQty,
          bill.totalAmount,
        ],
      );

      const billId = billRes.rows[0].sales_bill_id;
      salesBillIdMap.set(`${bill.billNo}__${bill.date}__${bill.customerName}`, billId);
      salesBillNoMap.set(bill.billNo, billId);

      for (const item of bill.items) {
        const productId = item.barcode ? (productIdMap.get(item.barcode) || null) : null;
        const catId = item.companyName ? (categoryIdMap.get(item.companyName) || null) : null;

        await client.query(
          `INSERT INTO sales_bill_items (sales_bill_id, product_id, barcode,
           category_name, product_name, size, article_number,
           quantity, rate, cost_rate, mrp,
           discount_percentage, discount_amount, taxable_amount,
           gst_rate, cgst_amount, sgst_amount, igst_amount, cess_amount,
           total_amount, quantity_per_box)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, $13, $14, 0, 0, 0, 0, 0, $14, $15)`,
          [
            billId,
            productId,
            trunc(item.barcode, 20),
            trunc(item.companyName, 100),
            trunc(item.productName, 200),
            trunc(item.size, 20),
            productId ? trunc(data.productMaster.get(item.barcode)?.articleNo, 50) : null,
            item.qty,
            item.rate,
            item.purchaseCost,
            item.rate,
            item.discPct,
            item.discAmt,
            item.netTotal,
            productId ? (data.productMaster.get(item.barcode)?.pcsPerBox || 1) : 1,
          ],
        );
        salesItemCount++;
      }
    }
    log(`  Sales bills inserted: ${salesBillIdMap.size}, items: ${salesItemCount}`);

    // ── 4.7 Stock Ledger ────────────────────────────────────────────
    log('Inserting stock ledger entries ...');
    let stockLedgerCount = 0;

    // 4.7a Opening stock entries from rptstock
    log('  Inserting opening stock entries ...');
    for (const [barcode, info] of data.openingStock) {
      if (info.balQty === 0) continue;
      const productId = productIdMap.get(barcode);
      if (!productId) continue;

      await client.query(
        `INSERT INTO stock_ledger (product_id, barcode, transaction_type, transaction_date,
         quantity_in, quantity_out, rate, balance_quantity, remarks, created_date)
         VALUES ($1, $2, 'Opening Stock', '2023-01-01', $3, 0, $4, $3,
                 'Imported from old software (rptstock)', NOW())`,
        [productId, barcode, info.balQty, info.purchaseRate],
      );
      stockLedgerCount++;
    }
    log(`    Opening stock entries: ${stockLedgerCount}`);

    // 4.7b Purchase stock-in entries
    log('  Inserting purchase stock-in entries ...');
    let purchStockCount = 0;
    for (const bill of data.purchaseBills) {
      const billKey = `${bill.billNo}__${bill.date}__${bill.supplierName}`;
      const billId = purchaseBillIdMap.get(billKey);
      for (const item of bill.items) {
        if (!item.barcode || item.qty === 0) continue;
        const productId = productIdMap.get(item.barcode);
        if (!productId) continue;

        await client.query(
          `INSERT INTO stock_ledger (product_id, barcode, transaction_type, transaction_date,
           reference_id, reference_number, quantity_in, quantity_out, rate,
           balance_quantity, created_date)
           VALUES ($1, $2, 'Purchase', $3::date, $4, $5, $6, 0, $7, 0, NOW())`,
          [productId, item.barcode, bill.date, billId, bill.uniqueBillNumber, item.qty, item.rate],
        );
        purchStockCount++;
      }
    }
    log(`    Purchase stock entries: ${purchStockCount}`);

    // 4.7c Sales stock-out entries
    log('  Inserting sales stock-out entries ...');
    let salesStockCount = 0;
    for (const bill of data.salesBills) {
      const sBillKey = `${bill.billNo}__${bill.date}__${bill.customerName}`;
      const billId = salesBillIdMap.get(sBillKey);
      for (const item of bill.items) {
        if (!item.barcode || item.qty === 0) continue;
        const productId = productIdMap.get(item.barcode);
        if (!productId) continue;

        await client.query(
          `INSERT INTO stock_ledger (product_id, barcode, transaction_type, transaction_date,
           reference_id, reference_number, quantity_in, quantity_out, rate,
           balance_quantity, created_date)
           VALUES ($1, $2, 'Sales', $3::date, $4, $5, 0, $6, $7, 0, NOW())`,
          [productId, item.barcode, bill.date, billId, bill.uniqueBillNumber, item.qty, item.rate],
        );
        salesStockCount++;
      }
    }
    log(`    Sales stock entries: ${salesStockCount}`);
    log(`  Total stock ledger entries: ${stockLedgerCount + purchStockCount + salesStockCount}`);

    // ── 4.8 Recalculate stock_ledger balance_quantity ────────────────
    log('Recalculating stock ledger running balances ...');
    await client.query(`
      WITH ordered AS (
        SELECT ledger_id, product_id, quantity_in, quantity_out,
               ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY transaction_date, ledger_id) AS rn
        FROM stock_ledger
      ),
      running AS (
        SELECT ledger_id,
               SUM(quantity_in - quantity_out) OVER (
                 PARTITION BY product_id
                 ORDER BY rn
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS bal
        FROM ordered
      )
      UPDATE stock_ledger sl
      SET balance_quantity = r.bal
      FROM running r
      WHERE sl.ledger_id = r.ledger_id
    `);
    log('  Running balances updated.');

    // ── 4.9 Customer Receipts ───────────────────────────────────────
    log('Inserting customer payment receipts ...');
    let custReceiptCount = 0;
    let custAutoCount = 0;
    const txnNumberSeen = new Map();

    function uniqueTxn(base) {
      const count = (txnNumberSeen.get(base) || 0) + 1;
      txnNumberSeen.set(base, count);
      return count === 1 ? base : `${base}-${count}`;
    }

    // Sort by pay date for consistent numbering
    const sortedCustPayments = [...data.customerPayments]
      .sort((a, b) => (a.payDate || '').localeCompare(b.payDate || ''));

    for (const pmt of sortedCustPayments) {
      const customerId = customerIdMap.get(pmt.customerName.toUpperCase());
      if (!customerId) {
        log(`  WARNING: Customer not found for payment: "${pmt.customerName}"`);
        continue;
      }

      const isAutoFromBill = pmt.receiptNo === 0;
      const txnNumber = uniqueTxn(isAutoFromBill
        ? `AUTO-R-${pmt.billNo}`
        : `R-${pmt.receiptNo}`);

      const referenceBillId = pmt.billNo > 0
        ? (salesBillNoMap.get(String(pmt.billNo)) || null) : null;
      const referenceBillNumber = pmt.billNo > 0 ? String(pmt.billNo) : null;

      const payDate = pmt.payDate || pmt.billDate || '2023-01-01';
      const mode = mapPayMode(pmt.payMode, pmt.chequeNo);

      const txnRes = await client.query(
        `INSERT INTO payments_receipts (transaction_number, transaction_type, transaction_date,
         party_id, reference_bill_id, reference_bill_type, reference_bill_number,
         total_amount, remarks, source, is_cancelled,
         created_date, modified_date)
         VALUES ($1, 'Receipt', $2::date, $3, $4::integer,
                 CASE WHEN $4::integer IS NOT NULL THEN 'Sales'::enum_payments_receipts_reference_bill_type ELSE NULL END,
                 $5, $6, $7,
                 $8::enum_payments_receipts_source,
                 false,
                 ($2::date || ' 12:00:00')::timestamptz, ($2::date || ' 12:00:00')::timestamptz)
         RETURNING transaction_id`,
        [
          txnNumber,
          payDate,
          customerId,
          referenceBillId,
          referenceBillNumber,
          pmt.amount,
          isAutoFromBill ? 'Paid in sales bill' : null,
          isAutoFromBill ? 'auto_from_bill' : 'manual',
        ],
      );

      const txnId = txnRes.rows[0].transaction_id;

      // Payment split
      const chequeNum = trimStr(pmt.chequeNo);
      const bankName = trimStr(pmt.bankName);
      await client.query(
        `INSERT INTO payment_splits (transaction_id, payment_mode, amount,
         bank_name, cheque_number)
         VALUES ($1, $2::enum_payment_splits_payment_mode, $3, $4, $5)`,
        [
          txnId,
          mode,
          pmt.amount,
          (bankName && bankName !== '-' && bankName !== '----') ? bankName : null,
          (chequeNum && chequeNum !== '-' && chequeNum !== '----') ? chequeNum : null,
        ],
      );

      if (isAutoFromBill) custAutoCount++;
      custReceiptCount++;
    }
    log(`  Customer receipts: ${custReceiptCount} (${custAutoCount} auto-from-bill)`);

    // ── 4.10 Supplier Payments ──────────────────────────────────────
    log('Inserting supplier payment receipts ...');
    let suppPayCount = 0;
    let suppAutoCount = 0;

    const sortedSuppPayments = [...data.supplierPayments]
      .sort((a, b) => (a.payDate || '').localeCompare(b.payDate || ''));

    for (const pmt of sortedSuppPayments) {
      const supplierId = supplierIdMap.get(pmt.supplierName.toUpperCase());
      if (!supplierId) {
        log(`  WARNING: Supplier not found for payment: "${pmt.supplierName}"`);
        continue;
      }

      const isAutoFromBill = pmt.receiptNo === 0;
      const txnNumber = uniqueTxn(isAutoFromBill
        ? `AUTO-P-${pmt.invNo}`
        : `P-${pmt.receiptNo}`);

      const referenceBillId = pmt.invNo > 0
        ? (purchaseBillNoMap.get(String(pmt.invNo)) || null) : null;
      const referenceBillNumber = pmt.invNo > 0 ? String(pmt.invNo) : null;

      const payDate = pmt.payDate || pmt.billDate || '2023-01-01';
      const mode = mapPayMode(pmt.payMode, pmt.chequeNo);

      const txnRes = await client.query(
        `INSERT INTO payments_receipts (transaction_number, transaction_type, transaction_date,
         party_id, reference_bill_id, reference_bill_type, reference_bill_number,
         total_amount, remarks, source, is_cancelled,
         created_date, modified_date)
         VALUES ($1, 'Payment', $2::date, $3, $4::integer,
                 CASE WHEN $4::integer IS NOT NULL THEN 'Purchase'::enum_payments_receipts_reference_bill_type ELSE NULL END,
                 $5, $6, $7,
                 $8::enum_payments_receipts_source,
                 false,
                 ($2::date || ' 12:00:00')::timestamptz, ($2::date || ' 12:00:00')::timestamptz)
         RETURNING transaction_id`,
        [
          txnNumber,
          payDate,
          supplierId,
          referenceBillId,
          referenceBillNumber,
          pmt.amount,
          isAutoFromBill ? 'Paid in purchase bill' : null,
          isAutoFromBill ? 'auto_from_bill' : 'manual',
        ],
      );

      const txnId = txnRes.rows[0].transaction_id;
      const chequeNum = trimStr(pmt.chequeNo);
      const bankName = trimStr(pmt.bankName);

      await client.query(
        `INSERT INTO payment_splits (transaction_id, payment_mode, amount,
         bank_name, cheque_number)
         VALUES ($1, $2::enum_payment_splits_payment_mode, $3, $4, $5)`,
        [
          txnId,
          mode,
          pmt.amount,
          (bankName && bankName !== '-' && bankName !== '----') ? bankName : null,
          (chequeNum && chequeNum !== '-' && chequeNum !== '----') ? chequeNum : null,
        ],
      );

      if (isAutoFromBill) suppAutoCount++;
      suppPayCount++;
    }
    log(`  Supplier payments: ${suppPayCount} (${suppAutoCount} auto-from-bill)`);

    // ── 4.11 Reconcile bill payment statuses ────────────────────────
    log('Reconciling bill payment statuses ...');

    // For each sales bill, sum its receipts and update paid/balance/status
    await client.query(`
      WITH bill_payments AS (
        SELECT reference_bill_id AS bill_id,
               SUM(total_amount) AS total_paid
        FROM payments_receipts
        WHERE transaction_type = 'Receipt'
          AND reference_bill_type = 'Sales'
          AND reference_bill_id IS NOT NULL
          AND is_cancelled = false
        GROUP BY reference_bill_id
      )
      UPDATE sales_bills sb
      SET paid_amount = COALESCE(bp.total_paid, 0),
          balance_amount = sb.total_amount - COALESCE(bp.total_paid, 0),
          payment_status = (CASE
            WHEN COALESCE(bp.total_paid, 0) >= sb.total_amount THEN 'Paid'
            WHEN COALESCE(bp.total_paid, 0) > 0 THEN 'Partial'
            ELSE 'Unpaid'
          END)::enum_sales_bills_payment_status
      FROM (SELECT sales_bill_id FROM sales_bills) AS all_bills
      LEFT JOIN bill_payments bp ON bp.bill_id = all_bills.sales_bill_id
      WHERE sb.sales_bill_id = all_bills.sales_bill_id
    `);

    // Same for purchase bills
    await client.query(`
      WITH bill_payments AS (
        SELECT reference_bill_id AS bill_id,
               SUM(total_amount) AS total_paid
        FROM payments_receipts
        WHERE transaction_type = 'Payment'
          AND reference_bill_type = 'Purchase'
          AND reference_bill_id IS NOT NULL
          AND is_cancelled = false
        GROUP BY reference_bill_id
      )
      UPDATE purchase_bills pb
      SET paid_amount = COALESCE(bp.total_paid, 0),
          balance_amount = pb.total_amount - COALESCE(bp.total_paid, 0),
          payment_status = (CASE
            WHEN COALESCE(bp.total_paid, 0) >= pb.total_amount THEN 'Paid'
            WHEN COALESCE(bp.total_paid, 0) > 0 THEN 'Partial'
            ELSE 'Unpaid'
          END)::enum_purchase_bills_payment_status
      FROM (SELECT purchase_bill_id FROM purchase_bills) AS all_bills
      LEFT JOIN bill_payments bp ON bp.bill_id = all_bills.purchase_bill_id
      WHERE pb.purchase_bill_id = all_bills.purchase_bill_id
    `);

    // Cash sales are settled at the counter — no separate payment receipt
    // exists in the old system, so auto-settle them.
    const cashSalesFix = await client.query(`
      UPDATE sales_bills
      SET paid_amount = total_amount, balance_amount = 0, payment_status = 'Paid'
      WHERE customer_id = 1 AND is_cancelled = false AND payment_status != 'Paid'
    `);
    const cashPurchFix = await client.query(`
      UPDATE purchase_bills
      SET paid_amount = total_amount, balance_amount = 0, payment_status = 'Paid'
      WHERE supplier_id = 1 AND is_cancelled = false AND payment_status != 'Paid'
    `);
    log(`  Cash bills auto-settled: ${cashSalesFix.rowCount} sales, ${cashPurchFix.rowCount} purchases`);

    // Also handle auto-from-bill payments that don't have reference_bill_id
    // (because bill numbers may not have matched). Sum ALL payments per party.
    log('  Reconciling party current balances ...');
    await client.query(`
      WITH party_sales AS (
        SELECT customer_id AS party_id, SUM(total_amount) AS total
        FROM sales_bills WHERE is_cancelled = false AND customer_id IS NOT NULL
        GROUP BY customer_id
      ),
      party_receipts AS (
        SELECT party_id, SUM(total_amount) AS total
        FROM payments_receipts
        WHERE transaction_type = 'Receipt' AND is_cancelled = false
        GROUP BY party_id
      )
      UPDATE parties p
      SET current_balance = p.opening_balance *
            CASE WHEN p.opening_balance_type = 'Receivable' THEN 1 ELSE -1 END
          + COALESCE(ps.total, 0) - COALESCE(pr.total, 0)
      FROM (SELECT party_id FROM parties WHERE party_type = 'Customer') AS cust
      LEFT JOIN party_sales ps ON ps.party_id = cust.party_id
      LEFT JOIN party_receipts pr ON pr.party_id = cust.party_id
      WHERE p.party_id = cust.party_id
    `);

    await client.query(`
      WITH party_purchases AS (
        SELECT supplier_id AS party_id, SUM(total_amount) AS total
        FROM purchase_bills WHERE is_cancelled = false AND supplier_id IS NOT NULL
        GROUP BY supplier_id
      ),
      party_payments AS (
        SELECT party_id, SUM(total_amount) AS total
        FROM payments_receipts
        WHERE transaction_type = 'Payment' AND is_cancelled = false
        GROUP BY party_id
      )
      UPDATE parties p
      SET current_balance = p.opening_balance *
            CASE WHEN p.opening_balance_type = 'Payable' THEN 1 ELSE -1 END
          + COALESCE(pp.total, 0) - COALESCE(ppy.total, 0)
      FROM (SELECT party_id FROM parties WHERE party_type = 'Supplier') AS supp
      LEFT JOIN party_purchases pp ON pp.party_id = supp.party_id
      LEFT JOIN party_payments ppy ON ppy.party_id = supp.party_id
      WHERE p.party_id = supp.party_id
    `);

    log('  Bill statuses and party balances reconciled.');

    // ── 4.12 Update sequences ───────────────────────────────────────
    log('Updating ID sequences ...');
    const seqTables = [
      ['categories', 'category_id'],
      ['products', 'product_id'],
      ['parties', 'party_id'],
      ['purchase_bills', 'purchase_bill_id'],
      ['sales_bills', 'sales_bill_id'],
      ['purchase_bill_items', 'item_id'],
      ['sales_bill_items', 'item_id'],
      ['payments_receipts', 'transaction_id'],
      ['payment_splits', 'split_id'],
      ['stock_ledger', 'ledger_id'],
    ];
    for (const [table, col] of seqTables) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', '${col}'),
                       COALESCE((SELECT MAX(${col}) FROM ${table}), 0) + 1, false)`,
      );
    }
    log('  Sequences updated.');

    // ═════════════════════════════════════════════════════════════════
    //  COMMIT or ROLLBACK
    // ═════════════════════════════════════════════════════════════════
    if (MODE === 'import') {
      await client.query('COMMIT');
      log('');
      log('██████████████████████████████████████████████████████████████');
      log('  IMPORT COMMITTED SUCCESSFULLY');
      log('██████████████████████████████████████████████████████████████');
    } else {
      await client.query('ROLLBACK');
      log('');
      log('DRY RUN — transaction rolled back. No data was written.');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    log(`FATAL ERROR — transaction rolled back: ${err.message}`);
    log(err.stack);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  PHASE 5: POST-IMPORT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════

async function verifyImport(data) {
  if (MODE !== 'import') return;
  logSection('POST-IMPORT VERIFICATION');

  const pool = new Pool(DB_CONFIG);
  try {
    const q = async (sql) => (await pool.query(sql)).rows;

    const counts = await q(`
      SELECT 'categories' AS t, COUNT(*)::int AS c FROM categories
      UNION ALL SELECT 'products', COUNT(*) FROM products
      UNION ALL SELECT 'parties', COUNT(*) FROM parties
      UNION ALL SELECT 'purchase_bills', COUNT(*) FROM purchase_bills
      UNION ALL SELECT 'purchase_bill_items', COUNT(*) FROM purchase_bill_items
      UNION ALL SELECT 'sales_bills', COUNT(*) FROM sales_bills
      UNION ALL SELECT 'sales_bill_items', COUNT(*) FROM sales_bill_items
      UNION ALL SELECT 'payments_receipts', COUNT(*) FROM payments_receipts
      UNION ALL SELECT 'payment_splits', COUNT(*) FROM payment_splits
      UNION ALL SELECT 'stock_ledger', COUNT(*) FROM stock_ledger
      ORDER BY t
    `);

    log('── Record Counts ──');
    for (const r of counts) {
      log(`  ${r.t}: ${r.c}`);
    }

    // Verify financial totals
    const purchTotal = await q(`SELECT SUM(total_amount)::numeric AS total FROM purchase_bills WHERE is_cancelled = false`);
    const salesTotal = await q(`SELECT SUM(total_amount)::numeric AS total FROM sales_bills WHERE is_cancelled = false`);
    const receiptTotal = await q(`SELECT SUM(total_amount)::numeric AS total FROM payments_receipts WHERE transaction_type = 'Receipt' AND is_cancelled = false`);
    const paymentTotal = await q(`SELECT SUM(total_amount)::numeric AS total FROM payments_receipts WHERE transaction_type = 'Payment' AND is_cancelled = false`);

    log('');
    log('── Financial Totals (DB vs Source) ──');
    const srcPurch = data.purchaseBills.reduce((s, b) => s + b.totalAmount, 0);
    const srcSales = data.salesBills.reduce((s, b) => s + b.totalAmount, 0);
    const srcReceipts = data.customerPayments.reduce((s, p) => s + p.amount, 0);
    const srcPayments = data.supplierPayments.reduce((s, p) => s + p.amount, 0);

    log(`  Purchases:  DB=${Number(purchTotal[0].total).toFixed(2)}, Source=${srcPurch.toFixed(2)}, Diff=${(Number(purchTotal[0].total) - srcPurch).toFixed(2)}`);
    log(`  Sales:      DB=${Number(salesTotal[0].total).toFixed(2)}, Source=${srcSales.toFixed(2)}, Diff=${(Number(salesTotal[0].total) - srcSales).toFixed(2)}`);
    log(`  Receipts:   DB=${Number(receiptTotal[0].total).toFixed(2)}, Source=${srcReceipts.toFixed(2)}, Diff=${(Number(receiptTotal[0].total) - srcReceipts).toFixed(2)}`);
    log(`  Payments:   DB=${Number(paymentTotal[0].total).toFixed(2)}, Source=${srcPayments.toFixed(2)}, Diff=${(Number(paymentTotal[0].total) - srcPayments).toFixed(2)}`);

    // Verify party balances sample
    const topCust = await q(`
      SELECT party_name, current_balance, opening_balance, opening_balance_type
      FROM parties WHERE party_type = 'Customer'
      ORDER BY ABS(current_balance) DESC LIMIT 10
    `);
    log('');
    log('── Top 10 Customer Balances (DB) ──');
    for (const r of topCust) {
      log(`  ${r.party_name}: current=${r.current_balance}, opening=${r.opening_balance} (${r.opening_balance_type})`);
    }

    const topSupp = await q(`
      SELECT party_name, current_balance, opening_balance, opening_balance_type
      FROM parties WHERE party_type = 'Supplier'
      ORDER BY ABS(current_balance) DESC LIMIT 10
    `);
    log('');
    log('── Top 10 Supplier Balances (DB) ──');
    for (const r of topSupp) {
      log(`  ${r.party_name}: current=${r.current_balance}, opening=${r.opening_balance} (${r.opening_balance_type})`);
    }

    // Payment status distribution
    const salesStatus = await q(`
      SELECT payment_status, COUNT(*)::int AS c FROM sales_bills
      GROUP BY payment_status ORDER BY payment_status
    `);
    log('');
    log('── Sales Bill Payment Status ──');
    for (const r of salesStatus) log(`  ${r.payment_status}: ${r.c}`);

    const purchStatus = await q(`
      SELECT payment_status, COUNT(*)::int AS c FROM purchase_bills
      GROUP BY payment_status ORDER BY payment_status
    `);
    log('── Purchase Bill Payment Status ──');
    for (const r of purchStatus) log(`  ${r.payment_status}: ${r.c}`);

  } finally {
    await pool.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  log(`=== OLD SOFTWARE DATA IMPORT — MODE: ${MODE} ===`);
  log(`Data directory: ${DATA_DIR}`);
  log(`Database: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);

  // Phase 1: Read all files
  logSection('PHASE 1: READING FILES');
  const stockProducts = await readStockReport();
  const openingStock = readRptStock();
  const purchaseItems = await readPurchaseReports();
  const salesItems = await readSalesReports();
  const customerPayments = await readCustomerPayments();
  const supplierPayments = await readSupplierPayments();
  const customers = await readCustomerInfo();
  const suppliers = await readSupplierInfo();

  // Phase 2: Transform
  logSection('PHASE 2: DATA TRANSFORMATION');
  const categories = buildCategoryList(stockProducts, purchaseItems, salesItems);
  const productMaster = buildProductMaster(stockProducts, openingStock, purchaseItems, salesItems);
  const purchaseBills = groupPurchaseBills(purchaseItems);
  const salesBills = groupSalesBills(salesItems);
  calculateOpeningBalances(customers, suppliers, salesBills, purchaseBills, customerPayments, supplierPayments);
  const stockPerBarcode = calculateStockPerBarcode(openingStock, purchaseItems, salesItems);

  const data = {
    categories, productMaster, purchaseBills, salesBills,
    customers, suppliers, customerPayments, supplierPayments,
    openingStock, stockPerBarcode,
  };

  // Phase 3: Dry run report
  printDryRunReport(data);

  // Phase 4: Import
  await importToDatabase(data);

  // Phase 5: Verify
  await verifyImport(data);

  log('');
  log('Import process complete. Log saved to: ' + LOG_FILE);
  logStream.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  if (logStream) {
    logStream.write(`FATAL: ${err.stack}\n`);
    logStream.end();
  }
  process.exit(1);
});
