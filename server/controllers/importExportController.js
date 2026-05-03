const ExcelJS = require('exceljs');
const { Op, col } = require('sequelize');
const sequelize = require('../config/database');
const { computeCostRateForSale } = require('../utils/displayCost');
const {
  Party, Product, Category, StockLedger,
  SalesBill, SalesBillItem, PurchaseBill, PurchaseBillItem, PaymentReceipt,
} = require('../models');

/* ──────────────────────────────────────────────────────────────────────
 * Shared helpers — used by the bill & receipt import/export branches
 * below. Kept at top so each branch can call them without repeating
 * look-up logic or reinventing total calculations.
 * ───────────────────────────────────────────────────────────────────── */

// Read every row of a named worksheet as { rowNumber, data } where data is
// a header→value object. Skips the header row. Returns an empty array if the
// sheet doesn't exist (caller decides whether that's an error).
function readSheet(workbook, sheetName) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return [];
  const headers = [];
  sheet.getRow(1).eachCell((cell) => headers.push(cell.value));
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data = {};
    row.eachCell((cell, colNumber) => {
      const key = headers[colNumber - 1];
      data[key] = cell.value;
    });
    // Skip rows that are entirely blank (happens when users paste and leave
    // trailing empty rows; without this guard they'd all flag as errors).
    if (Object.values(data).every((v) => v == null || String(v).trim() === '')) return;
    rows.push({ rowNumber, data });
  });
  return rows;
}

// Excel date cells come as JS Date, number, or string depending on how the
// user formatted the column. Normalise to YYYY-MM-DD, return null on junk.
function parseExcelDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // Excel serial date → JS Date. 25569 = Jan 1 1970 in Excel's epoch.
    const d = new Date((v - 25569) * 86400 * 1000);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  // Try native Date parsing first (handles "2026-01-15", "01/15/2026", etc.)
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  // Fallback: DD-MM-YYYY or DD/MM/YYYY Indian format
  const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const dd2 = new Date(iso);
    if (!isNaN(dd2)) return iso;
  }
  return null;
}

// Look up a party by (mobile OR name), scoped to customer/supplier/either.
// Mobile lookup wins when available because it's more uniquely identifying;
// name is a fallback for the common case where the import file only has a
// name column. Returns null if no match — caller decides whether to skip
// the row or auto-create.
async function findParty({ mobile, name, partyType /* 'Customer' | 'Supplier' | null */ }) {
  const typeFilter = partyType
    ? { party_type: { [Op.in]: [partyType, 'Both'] } }
    : {};
  if (mobile && String(mobile).trim()) {
    const p = await Party.findOne({ where: { mobile_1: String(mobile).trim(), ...typeFilter } });
    if (p) return p;
  }
  if (name && String(name).trim()) {
    const p = await Party.findOne({ where: { party_name: String(name).trim(), ...typeFilter } });
    if (p) return p;
  }
  return null;
}

// Look up a product by barcode (primary) or name (fallback). Import flow
// never auto-creates products from bills — the user is expected to import
// products first, then bills that reference them. A missing product is a
// hard skip with a clear error.
async function findProduct({ barcode, name }) {
  if (barcode && String(barcode).trim()) {
    const p = await Product.findOne({ where: { barcode: String(barcode).trim() } });
    if (p) return p;
  }
  if (name && String(name).trim()) {
    const p = await Product.findOne({ where: { product_name: String(name).trim() } });
    if (p) return p;
  }
  return null;
}

// Tally / GST convention: the first two chars of a GSTIN are the state code.
// Used by the bill importer to decide CGST+SGST (intra) vs IGST (inter) when
// the file leaves those fields blank and the user relies on auto-detection.
function stateOfGstin(gstin) {
  if (!gstin || gstin.length < 2) return null;
  return String(gstin).substring(0, 2);
}

exports.exportToExcel = async (req, res) => {
  try {
    const { module: moduleName } = req.params;
    // Filter params passed from the list pages so the export matches what the
    // user is looking at. Without this, an Export click from a filtered list
    // dumps the entire table — confusing and useless when the user explicitly
    // filtered to "Low Stock" or "Category = Fabrics" on-screen.
    const { search, category_id, stock_status, party_type, status } = req.query;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(moduleName);

    let data = [];
    let columns = [];

    switch (moduleName) {
      case 'customers': {
        const where = { party_type: { [Op.in]: ['Customer', 'Both'] } };
        if (status) where.party_status = status;
        if (search) {
          where[Op.or] = [
            { party_name: { [Op.iLike]: `%${search}%` } },
            { mobile_1:   { [Op.like]:  `%${search}%` } },
            { gstin:      { [Op.iLike]: `%${search}%` } },
          ];
        }
        data = await Party.findAll({ where, raw: true });
        columns = [
          { header: 'Party Name', key: 'party_name', width: 25 },
          { header: 'Mobile 1', key: 'mobile_1', width: 15 },
          { header: 'Mobile 2', key: 'mobile_2', width: 15 },
          { header: 'Email', key: 'email', width: 25 },
          { header: 'Address', key: 'address_line_1', width: 30 },
          { header: 'City', key: 'city', width: 15 },
          { header: 'State', key: 'state', width: 15 },
          { header: 'GSTIN', key: 'gstin', width: 18 },
          { header: 'PAN', key: 'pan_number', width: 12 },
          { header: 'Credit Limit', key: 'credit_limit', width: 15 },
          { header: 'Opening Balance', key: 'opening_balance', width: 15 },
          { header: 'Balance Type', key: 'opening_balance_type', width: 12 },
          { header: 'Current Balance', key: 'current_balance', width: 15 },
          { header: 'Status', key: 'party_status', width: 12 },
        ];
        break;
      }

      case 'suppliers': {
        const where = { party_type: { [Op.in]: ['Supplier', 'Both'] } };
        if (status) where.party_status = status;
        if (search) {
          where[Op.or] = [
            { party_name: { [Op.iLike]: `%${search}%` } },
            { mobile_1:   { [Op.like]:  `%${search}%` } },
            { gstin:      { [Op.iLike]: `%${search}%` } },
          ];
        }
        data = await Party.findAll({ where, raw: true });
        columns = [
          { header: 'Party Name', key: 'party_name', width: 25 },
          { header: 'Mobile 1', key: 'mobile_1', width: 15 },
          { header: 'Mobile 2', key: 'mobile_2', width: 15 },
          { header: 'Email', key: 'email', width: 25 },
          { header: 'Address', key: 'address_line_1', width: 30 },
          { header: 'City', key: 'city', width: 15 },
          { header: 'State', key: 'state', width: 15 },
          { header: 'GSTIN', key: 'gstin', width: 18 },
          { header: 'PAN', key: 'pan_number', width: 12 },
          { header: 'Credit Limit', key: 'credit_limit', width: 15 },
          { header: 'Current Balance', key: 'current_balance', width: 15 },
        ];
        break;
      }

      case 'products': {
        const where = { is_active: true };
        if (category_id) where.category_id = category_id;
        if (stock_status === 'low') {
          where.minimum_stock_level = { [Op.gt]: 0 };
          where.current_stock = { [Op.lte]: col('minimum_stock_level') };
        }
        if (stock_status === 'out') where.current_stock = { [Op.lte]: 0 };
        if (search) {
          where[Op.or] = [
            { product_name:    { [Op.iLike]: `%${search}%` } },
            { barcode:         { [Op.iLike]: `%${search}%` } },
            { article_number:  { [Op.iLike]: `%${search}%` } },
          ];
        }
        data = await Product.findAll({
          where,
          include: [{ model: Category, attributes: ['category_name'] }],
          raw: true, nest: true,
        });
        data = data.map(p => ({ ...p, category_name: p.Category?.category_name || '' }));
        columns = [
          { header: 'Barcode', key: 'barcode', width: 15 },
          { header: 'Category', key: 'category_name', width: 20 },
          { header: 'Product Name', key: 'product_name', width: 25 },
          { header: 'Size', key: 'size_value', width: 10 },
          { header: 'Article No', key: 'article_number', width: 15 },
          { header: 'HSN Code', key: 'hsn_code', width: 12 },
          { header: 'GST %', key: 'gst_rate', width: 8 },
          { header: 'Unit', key: 'unit_of_measurement', width: 8 },
          { header: 'Pieces per Box', key: 'quantity_per_box', width: 13 },
          { header: 'Opening Stock', key: 'opening_stock', width: 13 },
          { header: 'Opening Stock Rate', key: 'opening_stock_rate', width: 16 },
          { header: 'Current Stock', key: 'current_stock', width: 12 },
          { header: 'Min Stock', key: 'minimum_stock_level', width: 10 },
          { header: 'Purchase Rate', key: 'purchase_rate', width: 12 },
          { header: 'Margin %', key: 'margin_percentage', width: 10 },
          { header: 'Sale Rate', key: 'sale_rate', width: 12 },
          { header: 'MRP', key: 'mrp', width: 12 },
        ];
        break;
      }

      case 'sales_bills':
      case 'purchase_bills': {
        // Two-sheet export: Bills header on sheet 1, BillItems on sheet 2,
        // linked by Bill Number. Chosen over single-sheet-with-repeated-
        // headers because round-trip is cleaner — the importer can read the
        // sheets independently and the user can edit header fields once.
        return exportBillsTwoSheet({
          workbook, moduleName, res, req,
        });
      }

      case 'payment_receipts': {
        // Single-sheet — payments don't have line items.
        const where = { is_cancelled: false };
        const { from_date, to_date, party_type } = req.query;
        if (from_date) where.transaction_date = { ...(where.transaction_date || {}), [Op.gte]: from_date };
        if (to_date)   where.transaction_date = { ...(where.transaction_date || {}), [Op.lte]: to_date };
        const receipts = await PaymentReceipt.findAll({ where, raw: true });
        const partyIds = [...new Set(receipts.map(r => r.party_id).filter(Boolean))];
        const parties = await Party.findAll({ where: { party_id: partyIds }, raw: true });
        const partyMap = new Map(parties.map(p => [p.party_id, p]));
        data = receipts.map(r => ({
          ...r,
          party_name: partyMap.get(r.party_id)?.party_name || '',
          party_mobile: partyMap.get(r.party_id)?.mobile_1 || '',
        }));
        columns = [
          { header: 'Transaction Number', key: 'transaction_number', width: 18 },
          { header: 'Type',                key: 'transaction_type',   width: 10 },
          { header: 'Date',                key: 'transaction_date',   width: 12 },
          { header: 'Party Mobile',        key: 'party_mobile',       width: 15 },
          { header: 'Party Name',          key: 'party_name',         width: 25 },
          { header: 'Amount',              key: 'total_amount',       width: 12 },
          { header: 'Reference Bill',      key: 'reference_bill_number', width: 18 },
          { header: 'Reference Bill Type', key: 'reference_bill_type', width: 14 },
          { header: 'Remarks',             key: 'remarks',            width: 30 },
        ];
        break;
      }

      default:
        return res.status(400).json({ error: 'Invalid module' });
    }

    sheet.columns = columns;

    // Style header row
    sheet.getRow(1).font = { bold: true, size: 12 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    data.forEach(row => sheet.addRow(row));

    // Auto-filter
    sheet.autoFilter = { from: 'A1', to: String.fromCharCode(64 + columns.length) + '1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${moduleName}_export.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
};

/* ── Two-sheet bill export helper — shared by sales_bills + purchase_bills ─ */

async function exportBillsTwoSheet({ workbook, moduleName, res, req }) {
  // Drop the default sheet added by exportToExcel — this export uses Bills +
  // Items below, and ExcelJS keeps the placeholder around otherwise, leaving
  // an empty first tab labelled after the module name.
  const placeholder = workbook.getWorksheet(moduleName);
  if (placeholder) workbook.removeWorksheet(placeholder.id);

  const isSales = moduleName === 'sales_bills';
  const { from_date, to_date } = req.query;

  const BillModel = isSales ? SalesBill : PurchaseBill;
  const ItemModel = isSales ? SalesBillItem : PurchaseBillItem;
  const billFk    = isSales ? 'sales_bill_id' : 'purchase_bill_id';
  const partyFk   = isSales ? 'customer_id' : 'supplier_id';
  const partyKind = isSales ? 'Customer' : 'Supplier';

  const where = { is_cancelled: false };
  if (from_date) where.bill_date = { ...(where.bill_date || {}), [Op.gte]: from_date };
  if (to_date)   where.bill_date = { ...(where.bill_date || {}), [Op.lte]: to_date };

  const bills = await BillModel.findAll({ where, raw: true, order: [['bill_date', 'ASC'], ['bill_number', 'ASC']] });
  const billIds = bills.map(b => b[isSales ? 'sales_bill_id' : 'purchase_bill_id']);
  const items = await ItemModel.findAll({ where: { [billFk]: billIds }, raw: true });
  const partyIds = [...new Set(bills.map(b => b[partyFk]).filter(Boolean))];
  const parties = await Party.findAll({ where: { party_id: partyIds }, raw: true });
  const partyMap = new Map(parties.map(p => [p.party_id, p]));

  // --- Sheet 1: Bills ---
  const billsSheet = workbook.addWorksheet('Bills');
  billsSheet.columns = [
    { header: 'Bill Number',          key: 'bill_number',        width: 18 },
    { header: 'Bill Date',            key: 'bill_date',          width: 12 },
    { header: `${partyKind} Mobile`,  key: 'party_mobile',       width: 15 },
    { header: `${partyKind} Name`,    key: 'party_name',         width: 25 },
    { header: 'Discount %',           key: 'discount_percentage',width: 10 },
    { header: 'CGST %',               key: 'cgst_pct',           width: 8 },
    { header: 'SGST %',               key: 'sgst_pct',           width: 8 },
    { header: 'IGST %',               key: 'igst_pct',           width: 8 },
    { header: 'Other Charges',        key: 'other_charges',      width: 12 },
    { header: 'Freight',              key: 'freight_charges',    width: 10 },
    { header: 'Round Off',            key: 'round_off',          width: 10 },
    ...(isSales ? [
      { header: 'Payment Method',     key: 'payment_method',     width: 12 },
    ] : [
      { header: 'Supplier Bill No',   key: 'supplier_bill_number', width: 15 },
      { header: 'Transport',          key: 'transport_name',     width: 18 },
      { header: 'Vehicle No',         key: 'vehicle_number',     width: 12 },
    ]),
    { header: 'Remarks',              key: 'remarks',            width: 30 },
  ];
  billsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  billsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  bills.forEach(b => {
    const p = partyMap.get(b[partyFk]);
    billsSheet.addRow({
      ...b,
      party_mobile: p?.mobile_1 || '',
      party_name:   p?.party_name || '',
    });
  });

  // --- Sheet 2: Items ---
  const itemsSheet = workbook.addWorksheet('Items');
  itemsSheet.columns = [
    { header: 'Bill Number',    key: 'bill_number',   width: 18 },
    { header: 'Product Barcode',key: 'barcode',       width: 16 },
    { header: 'Product Name',   key: 'product_name',  width: 25 },
    { header: 'Category',       key: 'category_name', width: 16 },
    { header: 'HSN Code',       key: 'hsn_code',      width: 10 },
    { header: 'Quantity',       key: 'quantity',      width: 10 },
    { header: isSales ? 'Rate' : 'Purchase Rate', key: isSales ? 'rate' : 'purchase_rate', width: 10 },
    { header: 'GST %',          key: 'gst_rate',      width: 8 },
    { header: 'Unit',           key: 'unit_type',     width: 8 },
  ];
  itemsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  itemsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  // Group items by bill so we can write them in the same order as the Bills sheet.
  const itemsByBill = new Map();
  items.forEach(i => {
    const bid = i[billFk];
    if (!itemsByBill.has(bid)) itemsByBill.set(bid, []);
    itemsByBill.get(bid).push(i);
  });
  bills.forEach(b => {
    const bid = b[isSales ? 'sales_bill_id' : 'purchase_bill_id'];
    (itemsByBill.get(bid) || []).forEach(i => {
      itemsSheet.addRow({ ...i, bill_number: b.bill_number });
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${moduleName}_export.xlsx`);
  await workbook.xlsx.write(res);
  res.end();
}

// Bill template shapes — reused by downloadTemplate and the roundtrip
// export. Kept adjacent so any new column goes to both in one edit.
const BILLS_HEADER_COLUMNS = (partyKind, isSales) => [
  { header: 'Bill Number *',         key: 'bill_number',        width: 18 },
  { header: 'Bill Date *',           key: 'bill_date',          width: 12 },
  { header: `${partyKind} Mobile *`, key: 'party_mobile',       width: 15 },
  { header: `${partyKind} Name`,     key: 'party_name',         width: 25 },
  { header: 'Discount %',            key: 'discount_percentage',width: 10 },
  { header: 'CGST %',                key: 'cgst_pct',           width: 8 },
  { header: 'SGST %',                key: 'sgst_pct',           width: 8 },
  { header: 'IGST %',                key: 'igst_pct',           width: 8 },
  { header: 'Other Charges',         key: 'other_charges',      width: 12 },
  { header: 'Freight',               key: 'freight_charges',    width: 10 },
  { header: 'Round Off',             key: 'round_off',          width: 10 },
  ...(isSales ? [
    { header: 'Payment Method',      key: 'payment_method',     width: 12 },
  ] : [
    { header: 'Supplier Bill No',    key: 'supplier_bill_number', width: 15 },
    { header: 'Transport',           key: 'transport_name',     width: 18 },
    { header: 'Vehicle No',          key: 'vehicle_number',     width: 12 },
  ]),
  { header: 'Remarks',               key: 'remarks',            width: 30 },
];

const BILLS_ITEM_COLUMNS = (isSales) => [
  { header: 'Bill Number *',    key: 'bill_number',   width: 18 },
  { header: 'Product Barcode',  key: 'barcode',       width: 16 },
  { header: 'Product Name *',   key: 'product_name',  width: 25 },
  { header: 'Category',         key: 'category_name', width: 16 },
  { header: 'HSN Code',         key: 'hsn_code',      width: 10 },
  { header: 'Quantity *',       key: 'quantity',      width: 10 },
  { header: isSales ? 'Rate *' : 'Purchase Rate *', key: isSales ? 'rate' : 'purchase_rate', width: 12 },
  { header: 'GST %',            key: 'gst_rate',      width: 8 },
  { header: 'Unit',             key: 'unit_type',     width: 8 },
];

// Column instructions keyed per module so the Instructions sheet matches the
// template headers. Each row becomes [Column, Required, Description, Example].
const TEMPLATE_INSTRUCTIONS = {
  customers: [
    ['Party Name',    'Yes', 'Customer business or individual name.',                          'ABC Trading Co'],
    ['Mobile 1',      'Yes', '10-digit Indian mobile (primary contact).',                      '9876543210'],
    ['Mobile 2',      'No',  'Optional secondary mobile.',                                      '9876543211'],
    ['Email',         'No',  'Optional email for invoices / receipts.',                         'abc@example.com'],
    ['Address Line 1','No',  'Street / shop address.',                                          '12, MG Road'],
    ['City',          'No',  'City name.',                                                      'Mumbai'],
    ['State',         'No',  'Indian state (spelled out).',                                     'Maharashtra'],
    ['Pincode',       'No',  '6-digit postal code.',                                            '400001'],
    ['GSTIN',         'No',  '15-character GST identification number. Leave blank for unregistered.','27AABCU9603R1Z2'],
    ['PAN',           'No',  '10-character PAN.',                                               'AABCU9603R'],
    ['Credit Allowed','No',  'Yes if you sell on credit, No if cash-only.',                     'Yes'],
    ['Credit Limit',  'No',  'Maximum outstanding you allow, in ₹. Leave 0 if no limit.',       '50000'],
    ['Opening Balance','No', 'Balance at financial-year start. Always positive — use Balance Type for sign.','0'],
    ['Balance Type',  'No',  'Receivable = customer owes you. Payable = you owe customer (advance).','Receivable'],
  ],
  suppliers: [
    ['Party Name',    'Yes', 'Supplier business or individual name.',                          'XYZ Textiles Ltd'],
    ['Mobile 1',      'Yes', '10-digit Indian mobile (primary contact).',                      '9876543210'],
    ['Mobile 2',      'No',  'Optional secondary mobile.',                                      '9876543211'],
    ['Email',         'No',  'Optional email.',                                                 'xyz@example.com'],
    ['Address Line 1','No',  'Street address.',                                                 '45, Industrial Area'],
    ['City',          'No',  'City.',                                                           'Surat'],
    ['State',         'No',  'State.',                                                          'Gujarat'],
    ['Pincode',       'No',  'Postal code.',                                                    '395003'],
    ['GSTIN',         'No',  '15-character GSTIN.',                                             '24AABCX9603Z1Z5'],
    ['PAN',           'No',  '10-character PAN.',                                               'AABCX9603Z'],
    ['Credit Allowed','No',  'Yes if supplier gives you credit terms.',                         'Yes'],
    ['Credit Limit',  'No',  'Your credit limit with them, in ₹.',                              '100000'],
    ['Opening Balance','No', 'Positive amount only.',                                           '0'],
    ['Balance Type',  'No',  'Payable = you owe supplier. Receivable = supplier owes you (advance).','Payable'],
  ],
  products: [
    ['Barcode',            'No',  'Leave blank — system will auto-generate and offer to regenerate after import.','PROD-0000000123'],
    ['Category',           'Yes', 'Product category. Auto-created if it does not exist.',                         'Textiles'],
    ['Product Name',       'Yes', 'Name shown on bills.',                                                         'Cotton Fabric Premium'],
    ['Size',               'No',  'Free-text size (e.g. M, L, 42, 36 inch).',                                     'M'],
    ['Article No',         'No',  'Supplier or internal SKU / article code.',                                     'ART-001'],
    ['HSN Code',           'No',  'GST HSN/SAC code (4–8 digits).',                                               '5208'],
    ['GST %',              'No',  'GST rate slab: 0, 5, 12, 18, or 28.',                                          '5'],
    ['Unit',               'No',  'One of PCS, KG, METER, LITER, BOX, DOZEN. Defaults to PCS.',                   'PCS'],
    ['Pieces per Box',     'No',  'Used when selling by box. Fractional allowed.',                                '12'],
    ['Min Stock Level',    'No',  'Triggers low-stock alerts.',                                                   '10'],
    ['Opening Stock',      'No',  'Stock on hand at financial-year start.',                                       '50'],
    ['Opening Stock Rate', 'No',  'Cost rate for the opening stock valuation.',                                   '100'],
    ['Purchase Rate',      'Yes', 'Default purchase price.',                                                      '100'],
    ['Margin %',           'No',  'Expected margin — informational only.',                                        '20'],
    ['Sale Rate',          'Yes', 'Default sale price.',                                                          '120'],
    ['MRP',                'No',  'Maximum retail price (statutory cap).',                                        '150'],
  ],
  sales_bills: [
    ['Bill Number',    'Yes', 'Unique sales bill number. Re-importing the same number is skipped (not duplicated).', 'INV-2026-0001'],
    ['Bill Date',      'Yes', 'Date of sale. YYYY-MM-DD or DD-MM-YYYY both accepted.',                               '2026-01-15'],
    ['Customer Mobile','Yes', '10-digit mobile used to match the party. Mobile takes precedence over name.',         '9876543210'],
    ['Customer Name',  'No',  'Shown in the sheet for context; used as fallback only if Mobile is blank.',           'ABC Trading Co'],
    ['Discount %',     'No',  'Bill-level discount percentage.',                                                     '5'],
    ['CGST %',         'No',  'Central GST %. Combined with SGST for intra-state.',                                  '9'],
    ['SGST %',         'No',  'State GST %. Combined with CGST for intra-state.',                                    '9'],
    ['IGST %',         'No',  'Integrated GST %. Used for inter-state bills.',                                       '18'],
    ['Other Charges',  'No',  'Non-tax charges added to the bill.',                                                  '0'],
    ['Freight',        'No',  'Freight/transport charges.',                                                          '0'],
    ['Round Off',      'No',  'Manual round-off adjustment. Can be negative.',                                       '0.50'],
    ['Payment Method', 'No',  'Cash / Card / UPI / Bank Transfer / Cheque / Credit.',                                'Cash'],
    ['Remarks',        'No',  'Free-text note on the bill.',                                                         ''],
    // Items sheet
    ['—— Items sheet ——',   '',    '',                                                                              ''],
    ['Bill Number (Items)', 'Yes', 'Join key to the Bills sheet. One row per line item; repeat the bill number for each item.', 'INV-2026-0001'],
    ['Product Barcode',     'No',  'Match product by barcode first (most reliable).',                                'PROD-0000000001'],
    ['Product Name',        'Yes', 'Match product by name when barcode is blank.',                                   'Cotton Fabric Premium'],
    ['Quantity',            'Yes', 'Number of units sold in this line.',                                             '10'],
    ['Rate',                'Yes', 'Sale rate per unit.',                                                            '120'],
    ['Unit',                'No',  'Defaults to Pcs.',                                                               'Pcs'],
  ],
  purchase_bills: [
    ['Bill Number',        'Yes', 'Your internal purchase bill number (unique).',                                    'PUR-2026-0001'],
    ['Bill Date',          'Yes', 'Date of purchase.',                                                               '2026-01-15'],
    ['Supplier Mobile',    'Yes', '10-digit mobile used to match the supplier.',                                     '9876543211'],
    ['Supplier Name',      'No',  'Used as fallback if Mobile is blank.',                                            'XYZ Textiles Ltd'],
    ['Supplier Bill No',   'No',  'Supplier\'s own invoice number (appears on the bill for reference).',             'SUP-2341'],
    ['Discount %',         'No',  '',                                                                                ''],
    ['CGST %',             'No',  '',                                                                                '9'],
    ['SGST %',             'No',  '',                                                                                '9'],
    ['IGST %',             'No',  '',                                                                                '0'],
    ['Other Charges',      'No',  '',                                                                                '0'],
    ['Freight',            'No',  '',                                                                                '0'],
    ['Round Off',          'No',  '',                                                                                '0'],
    ['Transport',          'No',  'Transporter name.',                                                               'Blue Dart'],
    ['Vehicle No',         'No',  'Vehicle registration.',                                                           'MH12AB1234'],
    ['Remarks',            'No',  '',                                                                                ''],
    ['—— Items sheet ——',    '',   '',                                                                               ''],
    ['Bill Number (Items)','Yes', 'Join key to the Bills sheet.',                                                    'PUR-2026-0001'],
    ['Product Barcode',    'No',  'Match product by barcode first.',                                                 'PROD-0000000001'],
    ['Product Name',       'Yes', 'Match product by name when barcode is blank.',                                    'Cotton Fabric Premium'],
    ['Quantity',           'Yes', '',                                                                                '50'],
    ['Purchase Rate',      'Yes', 'Cost rate per unit.',                                                             '100'],
    ['Unit',               'No',  'Defaults to Pcs.',                                                                'Pcs'],
  ],
  payment_receipts: [
    ['Transaction Number',  'Yes', 'Unique transaction number. Re-importing the same one is skipped.',             'REC-0001'],
    ['Type',                'Yes', 'Payment = money out (to supplier). Receipt = money in (from customer).',        'Receipt'],
    ['Date',                'Yes', 'Transaction date.',                                                             '2026-01-15'],
    ['Party Mobile',        'Yes', '10-digit mobile used to match the party.',                                      '9876543210'],
    ['Party Name',          'No',  'Fallback lookup if Mobile is blank.',                                           'ABC Trading Co'],
    ['Amount',              'Yes', 'Amount in ₹. Always positive.',                                                 '5000'],
    ['Reference Bill',      'No',  'Original bill this transaction pays off.',                                      'INV-2026-0001'],
    ['Reference Bill Type', 'No',  'Sales or Purchase.',                                                            'Sales'],
    ['Remarks',             'No',  '',                                                                              ''],
  ],
};

function addInstructionsSheet(workbook, moduleName, extraNotes = []) {
  const instr = workbook.addWorksheet('Instructions', { state: 'visible' });
  instr.columns = [
    { header: 'Column',      key: 'col',  width: 24 },
    { header: 'Required?',   key: 'req',  width: 10 },
    { header: 'Description', key: 'desc', width: 60 },
    { header: 'Example',     key: 'ex',   width: 22 },
  ];
  instr.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  instr.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };

  const rows = TEMPLATE_INSTRUCTIONS[moduleName] || [];
  rows.forEach(([col, req, desc, ex]) => {
    const r = instr.addRow({ col, req, desc, ex });
    if (req === 'Yes') r.getCell('req').font = { bold: true, color: { argb: 'FFDC2626' } };
  });

  // Append general notes (e.g. barcode post-import prompt behaviour)
  instr.addRow({});
  instr.addRow({ col: 'Notes', req: '', desc: '', ex: '' }).font = { bold: true };
  const defaults = [
    'Required columns are marked with * in the header row of the Data sheet.',
    'Duplicate detection uses (Party Name + Mobile 1) for parties and Barcode for products.',
    'Re-importing the same file is safe — duplicates are skipped, not overwritten.',
    'After import, a summary dialog shows how many rows imported / skipped / failed, with a downloadable Excel error report.',
  ];
  [...defaults, ...extraNotes].forEach(n => instr.addRow({ desc: n }));
}

exports.downloadTemplate = async (req, res) => {
  try {
    const { module: moduleName } = req.params;
    const workbook = new ExcelJS.Workbook();

    // Bills templates are TWO sheets — return early via helper.
    if (moduleName === 'sales_bills' || moduleName === 'purchase_bills') {
      return buildBillsTemplate({ workbook, moduleName, res });
    }

    const sheet = workbook.addWorksheet('Data');

    let columns = [];
    let extraNotes = [];
    switch (moduleName) {
      case 'customers':
      case 'suppliers':
        columns = [
          { header: 'Party Name *', key: 'party_name', width: 25 },
          { header: 'Mobile 1 *', key: 'mobile_1', width: 15 },
          { header: 'Mobile 2', key: 'mobile_2', width: 15 },
          { header: 'Email', key: 'email', width: 25 },
          { header: 'Address Line 1', key: 'address_line_1', width: 30 },
          { header: 'City', key: 'city', width: 15 },
          { header: 'State', key: 'state', width: 15 },
          { header: 'Pincode', key: 'pincode', width: 10 },
          { header: 'GSTIN', key: 'gstin', width: 18 },
          { header: 'PAN', key: 'pan_number', width: 12 },
          { header: 'Credit Allowed (Yes/No)', key: 'credit_allowed', width: 18 },
          { header: 'Credit Limit', key: 'credit_limit', width: 12 },
          { header: 'Opening Balance', key: 'opening_balance', width: 15 },
          { header: 'Balance Type (Receivable/Payable)', key: 'opening_balance_type', width: 20 },
        ];
        break;

      case 'payment_receipts':
        columns = [
          { header: 'Transaction Number *',    key: 'transaction_number',  width: 18 },
          { header: 'Type (Payment/Receipt) *',key: 'transaction_type',    width: 18 },
          { header: 'Date *',                  key: 'transaction_date',    width: 12 },
          { header: 'Party Mobile *',          key: 'party_mobile',        width: 15 },
          { header: 'Party Name',              key: 'party_name',          width: 25 },
          { header: 'Amount *',                key: 'total_amount',        width: 12 },
          { header: 'Reference Bill',          key: 'reference_bill_number', width: 18 },
          { header: 'Reference Bill Type',     key: 'reference_bill_type', width: 14 },
          { header: 'Remarks',                 key: 'remarks',             width: 30 },
        ];
        break;

      case 'products':
        columns = [
          { header: 'Barcode (auto if blank)', key: 'barcode', width: 18 },
          { header: 'Category *', key: 'category_name', width: 20 },
          { header: 'Product Name *', key: 'product_name', width: 25 },
          { header: 'Size', key: 'size_value', width: 10 },
          { header: 'Article No', key: 'article_number', width: 15 },
          { header: 'HSN Code', key: 'hsn_code', width: 12 },
          { header: 'GST %', key: 'gst_rate', width: 8 },
          { header: 'Unit (PCS/KG/METER/LITER/BOX/DOZEN)', key: 'unit_of_measurement', width: 15 },
          { header: 'Pieces per Box', key: 'quantity_per_box', width: 13 },
          { header: 'Min Stock Level', key: 'minimum_stock_level', width: 12 },
          { header: 'Opening Stock', key: 'opening_stock', width: 13 },
          { header: 'Opening Stock Rate', key: 'opening_stock_rate', width: 16 },
          { header: 'Purchase Rate *', key: 'purchase_rate', width: 12 },
          { header: 'Margin %', key: 'margin_percentage', width: 10 },
          { header: 'Sale Rate *', key: 'sale_rate', width: 12 },
          { header: 'MRP', key: 'mrp', width: 12 },
        ];
        extraNotes = [
          'If the Barcode column is blank, the system will auto-generate one during import.',
          'After importing, a prompt appears showing how many items got auto-barcodes — you can Review / Regenerate them before printing labels.',
        ];
        break;

      default:
        return res.status(400).json({ error: 'Invalid module' });
    }

    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add sample row
    let sampleRow;
    if (moduleName === 'products') {
      sampleRow = { barcode: '', category_name: 'Textiles', product_name: 'Cotton Fabric', size_value: 'M', article_number: 'ART-001', hsn_code: '5208', gst_rate: 5, unit_of_measurement: 'PCS', quantity_per_box: 12, minimum_stock_level: 10, opening_stock: 50, opening_stock_rate: 100, purchase_rate: 100, margin_percentage: 20, sale_rate: 120, mrp: 150 };
    } else if (moduleName === 'payment_receipts') {
      sampleRow = { transaction_number: 'REC-0001', transaction_type: 'Receipt', transaction_date: '2026-01-15', party_mobile: '9876543210', party_name: 'ABC Trading Co', total_amount: 5000, reference_bill_number: 'INV-2026-0001', reference_bill_type: 'Sales', remarks: 'Partial payment' };
    } else {
      sampleRow = { party_name: 'ABC Trading Co', mobile_1: '9876543210', email: 'abc@example.com', city: 'Mumbai', state: 'Maharashtra', credit_allowed: 'Yes', credit_limit: 50000, opening_balance: 0, opening_balance_type: moduleName === 'suppliers' ? 'Payable' : 'Receivable' };
    }
    sheet.addRow(sampleRow);
    sheet.getRow(2).font = { italic: true, color: { argb: 'FF808080' } };

    // Separate Instructions sheet — every column explained with required/example.
    addInstructionsSheet(workbook, moduleName, extraNotes);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${moduleName}_template.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Template error:', error);
    res.status(500).json({ error: 'Template generation failed' });
  }
};

exports.importFromExcel = async (req, res) => {
  try {
    const { module: moduleName } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    // Bills (sales + purchase) use a two-sheet workbook (Bills + Items) and
    // transactional insert logic — delegated to a dedicated helper so the
    // single-sheet path below stays readable.
    if (moduleName === 'sales_bills' || moduleName === 'purchase_bills') {
      return importBills({ workbook, moduleName, req, res });
    }
    if (moduleName === 'payment_receipts') {
      return importPaymentReceipts({ workbook, req, res });
    }

    const sheet = workbook.worksheets[0];

    const headers = [];
    sheet.getRow(1).eachCell((cell) => headers.push(cell.value));

    const rows = [];
    const errors = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      const data = {};
      row.eachCell((cell, colNumber) => {
        const key = headers[colNumber - 1];
        data[key] = cell.value;
      });
      rows.push({ rowNumber, data });
    });

    let imported = 0;
    let skipped = 0;
    let autoBarcoded = 0;
    const autoBarcodedIds = []; // product_ids whose barcode was auto-generated

    if (moduleName === 'products') {
      // ── Bulk import for products (handles large files efficiently) ────────
      const { generateBarcode } = require('../utils/barcode');

      // 1. Build category map (name → id) — batch upsert all unique categories first
      const catNames = [...new Set(
        rows.map(r => (r.data['Category *'] || r.data['Category'] || '').trim()).filter(Boolean)
      )];
      const catMap = {};
      for (const name of catNames) {
        const [cat] = await Category.findOrCreate({
          where: { category_name: name },
          defaults: { category_name: name },
        });
        catMap[name] = cat.category_id;
      }

      // 2. Collect existing barcodes in one query
      const incomingBarcodes = rows
        .map(r => r.data['Barcode (auto if blank)'] || r.data['Barcode'])
        .filter(Boolean)
        .map(String);
      const existing = await Product.findAll({
        where: { barcode: incomingBarcodes },
        attributes: ['barcode'],
        raw: true,
      });
      const existingSet = new Set(existing.map(p => p.barcode));

      // 3. Build records to bulk-create
      // Safe parsers (defined once, used for every row)
      const unwrap = v => {
        if (v instanceof Date) return null;
        if (v !== null && typeof v === 'object' && 'result' in v) return v.result;
        if (v !== null && typeof v === 'object' && 'richText' in v) return v.richText.map(r => r.text).join('');
        return v;
      };
      // Clamp to max AND reject negatives so Excel sentinel values (9.22e16) don't
      // cause DECIMAL overflow, and a "-5" typo on GST %, rate, or quantity doesn't
      // silently become a tax refund or negative stock.
      const toNum = (v, def = 0, max = 9999999999999.99, min = 0) => {
        const n = parseFloat(unwrap(v));
        if (!isFinite(n) || n > max || n < min) return def;
        return n;
      };
      const toInt = (v, def = 1, max = 2147483647, min = 0) => {
        const n = parseInt(unwrap(v));
        if (!isFinite(n) || n > max || n < min) return def;
        return n;
      };
      // Signed variant — only for fields where negative is legitimate (e.g. round-off).
      const toNumSigned = (v, def = 0, max = 9999999999999.99, min = -9999999999999.99) => {
        const n = parseFloat(unwrap(v));
        if (!isFinite(n) || n > max || n < min) return def;
        return n;
      };
      const toStr = v => {
        const u = unwrap(v);
        // Do NOT treat the literal "0" as empty — it's a legitimate size/article code.
        // Previously "0" (e.g. barcode "0123" → "0") was silently dropped.
        return (u != null && String(u).trim() !== '') ? String(u).trim() : null;
      };

      const toCreate = [];
      for (const { rowNumber, data } of rows) {
        const rawName = data['Product Name *'] ?? data['Product Name'];
        // Treat null, undefined, empty string, OR numeric 0 as missing product name
        const productName = (rawName != null && String(rawName).trim() !== '' && String(rawName).trim() !== '0')
          ? String(rawName).trim() : '';
        if (!productName) {
          errors.push({ row: rowNumber, reason: 'Missing Product Name', rowData: data });
          skipped++;
          continue;
        }

        const rawBarcode = data['Barcode (auto if blank)'] || data['Barcode'];
        const hadBarcode = rawBarcode != null && String(rawBarcode).trim() !== '';
        const barcode = hadBarcode
          ? String(rawBarcode).trim()
          : await generateBarcode();

        if (existingSet.has(barcode)) {
          errors.push({ row: rowNumber, reason: 'Barcode already exists (duplicate)', rowData: data });
          skipped++;
          continue;
        }
        existingSet.add(barcode);

        const catName = (data['Category *'] || data['Category'] || '').trim();
        const openingStock = toNum(data['Opening Stock'], 0, 99999999.99);

        toCreate.push({
          _rowNumber: rowNumber,   // preserved for accurate error reporting in fallback
          _autoBarcoded: !hadBarcode,
          barcode,
          category_id: catMap[catName] || null,
          product_name: productName,
          size_value: toStr(data['Size']),
          article_number: toStr(data['Article No']),
          hsn_code: data['HSN Code'] ? String(data['HSN Code']).slice(0, 50) : null,
          gst_rate: toNum(data['GST %'], 0, 999999.99),
          // Validate against the ENUM defined on Product model — an invalid
          // value (e.g. "piece", "mtr") would cause the bulkCreate to fail.
          // Fall back to PCS so a typo doesn't block an entire import.
          unit_of_measurement: (() => {
            const allowed = ['PCS', 'KG', 'METER', 'LITER', 'BOX', 'DOZEN'];
            const raw = (data['Unit (PCS/KG/METER/LITER/BOX/DOZEN)'] || data['Unit'] || 'PCS').toString().trim().toUpperCase();
            // Common synonyms/aliases
            const alias = { PC: 'PCS', PIECE: 'PCS', PIECES: 'PCS', MTR: 'METER', MT: 'METER', LTR: 'LITER', LT: 'LITER', DZ: 'DOZEN', DOZ: 'DOZEN' };
            const mapped = alias[raw] || raw;
            return allowed.includes(mapped) ? mapped : 'PCS';
          })(),
          // DECIMAL(10,2) in DB — preserve fractional box counts (e.g. 0.5 m fabric rolls). toInt silently truncated 2.5 → 2.
          quantity_per_box: toNum(data['Pieces per Box'], 1, 99999.99, 0.01),
          minimum_stock_level: toNum(data['Min Stock Level'], 0, 99999999.99),
          opening_stock: openingStock,
          opening_stock_rate: toNum(data['Opening Stock Rate'], 0),
          current_stock: openingStock,
          purchase_rate: toNum(data['Purchase Rate *'] || data['Purchase Rate'], 0),
          margin_percentage: toNum(data['Margin %'], 0, 999999.99),
          sale_rate: toNum(data['Sale Rate *'] || data['Sale Rate'], 0),
          mrp: toNum(data['MRP'], 0),
        });
      }

      // 4. Bulk insert in chunks of 500; fall back to row-by-row on chunk failure
      const CHUNK = 500;
      const today = new Date().toISOString().split('T')[0];
      const createdProducts = []; // collect newly inserted products for ledger entries

      // Build a barcode→autoBarcoded map so we can tag products AFTER insert.
      const autoByBarcode = new Map(toCreate.map(r => [r.barcode, !!r._autoBarcoded]));

      for (let i = 0; i < toCreate.length; i += CHUNK) {
        const chunk = toCreate.slice(i, i + CHUNK);
        // Strip internal tracking fields before DB insert
        const chunkData = chunk.map(({ _rowNumber, _autoBarcoded, ...rest }) => rest);
        try {
          const results = await Product.bulkCreate(chunkData, { ignoreDuplicates: true, returning: true });
          results.forEach(p => {
            createdProducts.push(p);
            if (autoByBarcode.get(p.barcode)) {
              autoBarcoded++;
              autoBarcodedIds.push(p.product_id);
            }
          });
          imported += results.length;
        } catch (bulkErr) {
          // Chunk failed — retry each row individually so only bad rows are skipped
          for (let j = 0; j < chunk.length; j++) {
            try {
              const p = await Product.create(chunkData[j]);
              createdProducts.push(p);
              if (autoByBarcode.get(p.barcode)) {
                autoBarcoded++;
                autoBarcodedIds.push(p.product_id);
              }
              imported++;
            } catch (rowErr) {
              errors.push({ row: chunk[j]._rowNumber, reason: rowErr.message, rowData: chunkData[j] });
              skipped++;
            }
          }
        }
      }

      // 5. Create Opening Stock ledger entries for products that have opening_stock > 0
      const ledgerEntries = createdProducts
        .filter(p => parseFloat(p.opening_stock || 0) > 0)
        .map(p => ({
          product_id: p.product_id,
          transaction_type: 'Opening Stock',
          transaction_date: today,
          quantity_in: parseFloat(p.opening_stock),
          quantity_out: 0,
          rate: parseFloat(p.opening_stock_rate || p.purchase_rate || 0),
          balance_quantity: parseFloat(p.opening_stock),
          remarks: 'Opening Stock (Imported)',
        }));
      if (ledgerEntries.length > 0) {
        await StockLedger.bulkCreate(ledgerEntries, { ignoreDuplicates: true });
      }

    } else {
      // ── Row-by-row import for parties ─────────────────────────────────────

      // Case-insensitive parsers — users fill Excel by hand and type "yes",
      // "YES", "receivable", "PAYABLE" etc. Without these normalisers the
      // value would silently become false / default, corrupting opening
      // balances and credit policy.
      const parseYesNo = (v) => {
        if (v === true || v === 1) return true;
        if (v == null) return false;
        const s = String(v).trim().toLowerCase();
        return ['yes', 'y', 'true', '1'].includes(s);
      };
      const parseBalanceType = (v) => {
        const s = String(v ?? '').trim().toLowerCase();
        if (s === 'payable' || s === 'cr' || s === 'credit') return 'Payable';
        return 'Receivable'; // default + Receivable/Dr/Debit all fall through
      };
      // Non-negative number parser — opening balance and credit limit may
      // only be positive. Accounting convention is that the SIGN is carried
      // by the separate "Balance Type" column, so a negative in the number
      // column is always a typo.
      const toNonNegNum = (v) => {
        const n = parseFloat(v);
        if (!isFinite(n) || n < 0) return 0;
        return n;
      };

      for (const { rowNumber, data } of rows) {
        try {
          const partyName = data['Party Name *'] || data['Party Name'];
          const mobile = String(data['Mobile 1 *'] || data['Mobile 1'] || '');
          if (!partyName || !mobile) {
            errors.push({ row: rowNumber, reason: 'Missing required field (Name or Mobile)', rowData: data });
            skipped++;
            continue;
          }
          await Party.findOrCreate({
            where: { party_name: partyName, mobile_1: mobile },
            defaults: {
              party_type: moduleName === 'customers' ? 'Customer' : 'Supplier',
              party_name: partyName,
              mobile_1: mobile,
              mobile_2: data['Mobile 2'] ? String(data['Mobile 2']) : null,
              email: data['Email'] || null,
              address_line_1: data['Address Line 1'] || null,
              city: data['City'] || null,
              state: data['State'] || null,
              pincode: data['Pincode'] ? String(data['Pincode']) : null,
              gstin: data['GSTIN'] || null,
              pan_number: data['PAN'] || null,
              credit_allowed: parseYesNo(data['Credit Allowed (Yes/No)'] ?? data['Credit Allowed']),
              credit_limit: toNonNegNum(data['Credit Limit']),
              opening_balance: toNonNegNum(data['Opening Balance']),
              opening_balance_type: parseBalanceType(data['Balance Type (Receivable/Payable)'] ?? data['Balance Type']),
              created_by: req.user.user_id,
            },
          });
          imported++;
        } catch (err) {
          errors.push({ row: rowNumber, reason: err.message, rowData: data });
          skipped++;
        }
      }
    }

    res.json({
      message: `Import completed: ${imported} imported, ${skipped} skipped`,
      imported,
      skipped,
      errors,
      total: rows.length,
      // Products-only: how many rows had an empty Barcode cell and were
      // auto-assigned a system barcode. The client uses this to prompt
      // "Review / Regenerate auto-barcoded items?" after a products import.
      auto_barcoded: autoBarcoded,
      auto_barcoded_ids: autoBarcodedIds,
    });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Import failed: ' + error.message });
  }
};

/* ── Regenerate barcodes for a set of product_ids ──────────────────────────
 *
 * Post-import flow: after a products import auto-assigns barcodes to rows
 * that had the Barcode cell blank, the UI shows those product_ids in a
 * review list and calls this endpoint when the user hits "Regenerate".
 *
 * We reuse the same barcode util used everywhere else in the app — never
 * invent our own numbering here — so new barcodes follow the user's
 * configured prefix / padding / starting-number exactly.
 */
exports.regenerateBarcodes = async (req, res) => {
  try {
    const { product_ids } = req.body || {};
    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(400).json({ error: 'product_ids (non-empty array) required' });
    }
    const { generateBarcode } = require('../utils/barcode');
    const sequelize = require('../config/database');

    const updated = [];
    const failed = [];
    // Allocate under a transaction so a mid-run crash doesn't leave half the
    // batch with new barcodes and half with old ones — either the whole
    // request succeeds or nothing changes.
    await sequelize.transaction(async (t) => {
      for (const id of product_ids) {
        try {
          const newBarcode = await generateBarcode(t);
          const [n] = await Product.update(
            { barcode: newBarcode },
            { where: { product_id: id }, transaction: t }
          );
          if (n === 1) updated.push({ product_id: id, barcode: newBarcode });
          else failed.push({ product_id: id, reason: 'Product not found' });
        } catch (e) {
          failed.push({ product_id: id, reason: e.message });
        }
      }
    });

    res.json({
      message: `Regenerated ${updated.length} barcodes`,
      updated,
      failed,
    });
  } catch (error) {
    console.error('Regenerate barcodes error:', error);
    res.status(500).json({ error: 'Barcode regeneration failed' });
  }
};

/* ── Generate failed-rows Excel report ──────────────────────────────────── */
exports.generateFailedReport = async (req, res) => {
  try {
    const { errors = [], module: moduleName = 'products' } = req.body;
    if (!errors.length) return res.status(400).json({ error: 'No failed rows provided' });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Failed Rows');

    // Build columns from first rowData keys + prepend Row# and append Remark
    const sampleData = errors[0]?.rowData || {};
    const dataKeys = Object.keys(sampleData);

    sheet.columns = [
      { header: 'Row #', key: '_row', width: 8 },
      ...dataKeys.map(k => ({ header: k, key: k, width: 20 })),
      { header: 'Remark (Why Not Imported)', key: '_reason', width: 40 },
    ];

    // Style header
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };

    // Add rows
    errors.forEach(({ row, reason, rowData = {} }) => {
      const rowObj = { _row: row, _reason: reason };
      dataKeys.forEach(k => { rowObj[k] = rowData[k] ?? ''; });
      const addedRow = sheet.addRow(rowObj);
      addedRow.getCell('_reason').font = { color: { argb: 'FFDC2626' }, italic: true };
    });

    sheet.autoFilter = { from: 'A1', to: String.fromCharCode(64 + sheet.columns.length) + '1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=failed_import_report.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Failed report error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
};

/* ────────────────────────────────────────────────────────────────────────
 * Two-sheet template builder for Sales + Purchase bills.
 * ─────────────────────────────────────────────────────────────────────── */

async function buildBillsTemplate({ workbook, moduleName, res }) {
  const isSales = moduleName === 'sales_bills';
  const partyKind = isSales ? 'Customer' : 'Supplier';

  // Sheet 1: Bills
  const billsSheet = workbook.addWorksheet('Bills');
  billsSheet.columns = BILLS_HEADER_COLUMNS(partyKind, isSales);
  billsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  billsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  const sampleBill = isSales
    ? { bill_number: 'INV-2026-0001', bill_date: '2026-01-15', party_mobile: '9876543210', party_name: 'ABC Trading Co', discount_percentage: 0, cgst_pct: 9, sgst_pct: 9, igst_pct: 0, other_charges: 0, freight_charges: 0, round_off: 0, payment_method: 'Cash', remarks: 'Sample sales bill' }
    : { bill_number: 'PUR-2026-0001', bill_date: '2026-01-15', party_mobile: '9876543211', party_name: 'XYZ Textiles', supplier_bill_number: 'SUP-2341', discount_percentage: 0, cgst_pct: 9, sgst_pct: 9, igst_pct: 0, other_charges: 0, freight_charges: 0, round_off: 0, transport_name: 'Blue Dart', vehicle_number: '', remarks: 'Sample purchase bill' };
  billsSheet.addRow(sampleBill);
  billsSheet.getRow(2).font = { italic: true, color: { argb: 'FF808080' } };

  // Sheet 2: Items
  const itemsSheet = workbook.addWorksheet('Items');
  itemsSheet.columns = BILLS_ITEM_COLUMNS(isSales);
  itemsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  itemsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
  const sampleItem = isSales
    ? { bill_number: 'INV-2026-0001', barcode: '', product_name: 'Cotton Fabric Premium', category_name: 'Textiles', hsn_code: '5208', quantity: 10, rate: 120, gst_rate: 18, unit_type: 'Pcs' }
    : { bill_number: 'PUR-2026-0001', barcode: '', product_name: 'Cotton Fabric Premium', category_name: 'Textiles', hsn_code: '5208', quantity: 50, purchase_rate: 100, gst_rate: 18, unit_type: 'Pcs' };
  itemsSheet.addRow(sampleItem);
  itemsSheet.getRow(2).font = { italic: true, color: { argb: 'FF808080' } };

  // Sheet 3: Instructions (shared)
  addInstructionsSheet(workbook, moduleName, [
    'Bills sheet = one row per bill. Items sheet = one row per line item, repeat the bill number for each line.',
    'Parties are matched by Mobile first, then by Name — they must already exist (import Customers / Suppliers first).',
    'Products are matched by Barcode first, then by Name — they must already exist (import Stock Items first).',
    'CGST + SGST should each be half the total GST rate for intra-state. Use IGST alone for inter-state.',
    'Totals and tax amounts are recomputed server-side; the Bills sheet does not need a Sub Total column.',
  ]);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${moduleName}_template.xlsx`);
  await workbook.xlsx.write(res);
  res.end();
}

/* ────────────────────────────────────────────────────────────────────────
 * Bills import — reads Bills + Items sheets, validates, and inserts under
 * a transaction so a mid-batch failure leaves zero partial bills.
 *
 * Every bill is processed in its own transaction: if a line item fails to
 * resolve (missing product) the whole bill is rolled back and recorded in
 * errors — we never insert half a bill.
 * ─────────────────────────────────────────────────────────────────────── */

async function importBills({ workbook, moduleName, req, res }) {
  const isSales = moduleName === 'sales_bills';
  const BillModel = isSales ? SalesBill : PurchaseBill;
  const ItemModel = isSales ? SalesBillItem : PurchaseBillItem;
  const billFk    = isSales ? 'sales_bill_id' : 'purchase_bill_id';
  const partyFk   = isSales ? 'customer_id' : 'supplier_id';
  const partyKind = isSales ? 'Customer' : 'Supplier';

  const billRows = readSheet(workbook, 'Bills');
  const itemRows = readSheet(workbook, 'Items');
  if (billRows.length === 0) {
    return res.status(400).json({ error: 'Workbook must have a "Bills" sheet with header + rows' });
  }

  // Bucket items by bill number so one lookup per bill
  const itemsByBill = new Map();
  itemRows.forEach(({ rowNumber, data }) => {
    const bn = String(data['Bill Number *'] || data['Bill Number'] || '').trim();
    if (!bn) return;
    if (!itemsByBill.has(bn)) itemsByBill.set(bn, []);
    itemsByBill.get(bn).push({ rowNumber, data });
  });

  // Pre-fetch existing bill numbers to skip duplicates up front (idempotency)
  const incomingNumbers = billRows.map(r => String(r.data['Bill Number *'] || r.data['Bill Number'] || '').trim()).filter(Boolean);
  const existing = await BillModel.findAll({ where: { bill_number: incomingNumbers }, attributes: ['bill_number'], raw: true });
  const existingSet = new Set(existing.map(b => b.bill_number));

  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const { rowNumber, data } of billRows) {
    const billNumber = String(data['Bill Number *'] || data['Bill Number'] || '').trim();
    if (!billNumber) {
      errors.push({ row: rowNumber, reason: 'Missing Bill Number', rowData: data });
      skipped++;
      continue;
    }
    if (existingSet.has(billNumber)) {
      errors.push({ row: rowNumber, reason: `Bill Number '${billNumber}' already exists (duplicate skipped)`, rowData: data });
      skipped++;
      continue;
    }

    const billDate = parseExcelDate(data['Bill Date *'] || data['Bill Date']);
    if (!billDate) {
      errors.push({ row: rowNumber, reason: 'Missing or invalid Bill Date', rowData: data });
      skipped++;
      continue;
    }

    const partyMobile = data[`${partyKind} Mobile *`] ?? data[`${partyKind} Mobile`];
    const partyName   = data[`${partyKind} Name`];
    const party = await findParty({ mobile: partyMobile, name: partyName, partyType: partyKind });
    if (!party) {
      errors.push({ row: rowNumber, reason: `${partyKind} not found (mobile '${partyMobile || ''}' / name '${partyName || ''}')`, rowData: data });
      skipped++;
      continue;
    }

    const lineItems = itemsByBill.get(billNumber) || [];
    if (lineItems.length === 0) {
      errors.push({ row: rowNumber, reason: `Bill has no line items on the Items sheet`, rowData: data });
      skipped++;
      continue;
    }

    // Resolve every line's product BEFORE opening the transaction so a
    // missing product doesn't leave a half-created bill behind. Use the
    // shared findProduct helper (barcode first, name fallback).
    const resolvedItems = [];
    let itemError = null;
    for (const { rowNumber: itemRow, data: it } of lineItems) {
      const product = await findProduct({
        barcode: it['Product Barcode'],
        name:    it['Product Name *'] || it['Product Name'],
      });
      if (!product) {
        itemError = { row: itemRow, reason: `Item — product not found (barcode '${it['Product Barcode'] || ''}' / name '${it['Product Name *'] || it['Product Name'] || ''}')`, rowData: it };
        break;
      }
      const qty = parseFloat(it['Quantity *'] || it['Quantity'] || 0);
      const rate = parseFloat(it[isSales ? 'Rate *' : 'Purchase Rate *'] || it[isSales ? 'Rate' : 'Purchase Rate'] || 0);
      if (!(qty > 0) || !(rate >= 0)) {
        itemError = { row: itemRow, reason: `Item — invalid Quantity or Rate`, rowData: it };
        break;
      }
      resolvedItems.push({ product, qty, rate, unit: it['Unit'] || 'Pcs', gst_rate: parseFloat(it['GST %'] || product.gst_rate || 0) });
    }
    if (itemError) {
      errors.push(itemError);
      skipped++;
      continue;
    }

    // Compute totals from line items; bill-level CGST/SGST/IGST % from the
    // header (user can override by leaving 0 — the product GST is NOT
    // re-applied as a second layer).
    const subTotal = resolvedItems.reduce((s, it) => s + it.qty * it.rate, 0);
    const discPct  = parseFloat(data['Discount %'] || 0);
    const discAmt  = subTotal * discPct / 100;
    const taxable  = subTotal - discAmt;
    const cgstPct  = parseFloat(data['CGST %'] || 0);
    const sgstPct  = parseFloat(data['SGST %'] || 0);
    const igstPct  = parseFloat(data['IGST %'] || 0);
    const cgstAmt  = taxable * cgstPct / 100;
    const sgstAmt  = taxable * sgstPct / 100;
    const igstAmt  = taxable * igstPct / 100;
    const other    = parseFloat(data['Other Charges'] || 0);
    const freight  = parseFloat(data['Freight'] || 0);
    const roundOff = parseFloat(data['Round Off'] || 0);
    const totalAmt = taxable + cgstAmt + sgstAmt + igstAmt + other + freight + roundOff;

    try {
      await sequelize.transaction(async (t) => {
        const billRec = await BillModel.create({
          bill_number: billNumber,
          [partyFk]:   party.party_id,
          bill_date:   billDate,
          total_items: resolvedItems.length,
          total_quantity: resolvedItems.reduce((s, it) => s + it.qty, 0),
          sub_total: subTotal,
          discount_percentage: discPct,
          discount_amount: discAmt,
          cgst_pct: cgstPct, sgst_pct: sgstPct, igst_pct: igstPct,
          cgst_amount: cgstAmt, sgst_amount: sgstAmt, igst_amount: igstAmt,
          other_charges: other,
          freight_charges: freight,
          round_off: roundOff,
          total_amount: totalAmt,
          paid_amount: 0,
          balance_amount: totalAmt,
          payment_status: 'Unpaid',
          ...(isSales ? { payment_method: data['Payment Method'] || 'Cash' } : {
            supplier_bill_number: data['Supplier Bill No'] || null,
            transport_name: data['Transport'] || null,
            vehicle_number: data['Vehicle No'] || null,
          }),
          remarks: data['Remarks'] || null,
          created_by: req.user?.user_id || null,
        }, { transaction: t });

        const billId = billRec[billFk];
        // Mode-aware cost_rate snapshot for sales lines (Commit 3d).
        // Variant: purchase_rate. Single (no batch): wac. Single+batch
        // would need a per-line batch_id which Excel imports don't
        // currently carry — falls through to wac fallback inside the
        // helper. Map to async via Promise.all so each line resolves
        // its cost via the shared helper before bulkCreate.
        const itemCreate = await Promise.all(resolvedItems.map(async it => {
          const baseSales = isSales ? {
            rate: it.rate, unit_type: it.unit,
            cost_rate: await computeCostRateForSale({
              product: it.product, batch_id: it.batch_id || null, t,
            }),
          } : { purchase_rate: it.rate };
          return {
            [billFk]: billId,
            product_id: it.product.product_id,
            barcode: it.product.barcode,
            product_name: it.product.product_name,
            category_id: it.product.category_id,
            hsn_code: it.product.hsn_code,
            quantity: it.qty,
            ...baseSales,
            gst_rate: it.gst_rate,
            taxable_amount: it.qty * it.rate,
            total_amount: it.qty * it.rate,
            quantity_per_box: it.product.quantity_per_box || 1,
          };
        }));
        await ItemModel.bulkCreate(itemCreate, { transaction: t });
      });
      imported++;
      existingSet.add(billNumber);
    } catch (e) {
      errors.push({ row: rowNumber, reason: e.message, rowData: data });
      skipped++;
    }
  }

  res.json({
    message: `Import completed: ${imported} bills imported, ${skipped} skipped`,
    imported, skipped, errors,
    total: billRows.length,
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Single-sheet import for Payment / Receipt transactions.
 * Party must already exist; duplicate transaction_number is skipped.
 * ─────────────────────────────────────────────────────────────────────── */

async function importPaymentReceipts({ workbook, req, res }) {
  const rows = readSheet(workbook, 'Data')
    .concat(workbook.worksheets[0].name !== 'Data' ? readSheet(workbook, workbook.worksheets[0].name) : []);

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Workbook has no data rows' });
  }

  const incomingNums = rows.map(r => String(r.data['Transaction Number *'] || r.data['Transaction Number'] || '').trim()).filter(Boolean);
  const existing = await PaymentReceipt.findAll({ where: { transaction_number: incomingNums }, attributes: ['transaction_number'], raw: true });
  const existingSet = new Set(existing.map(r => r.transaction_number));

  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const { rowNumber, data } of rows) {
    try {
      const txnNum = String(data['Transaction Number *'] || data['Transaction Number'] || '').trim();
      if (!txnNum) { errors.push({ row: rowNumber, reason: 'Missing Transaction Number', rowData: data }); skipped++; continue; }
      if (existingSet.has(txnNum)) { errors.push({ row: rowNumber, reason: `Transaction '${txnNum}' already exists`, rowData: data }); skipped++; continue; }

      const typeRaw = String(data['Type (Payment/Receipt) *'] || data['Type'] || '').trim();
      const type = /receipt/i.test(typeRaw) ? 'Receipt' : /payment/i.test(typeRaw) ? 'Payment' : null;
      if (!type) { errors.push({ row: rowNumber, reason: `Invalid Type '${typeRaw}' (must be Payment or Receipt)`, rowData: data }); skipped++; continue; }

      const txnDate = parseExcelDate(data['Date *'] || data['Date']);
      if (!txnDate) { errors.push({ row: rowNumber, reason: 'Missing or invalid Date', rowData: data }); skipped++; continue; }

      const party = await findParty({
        mobile: data['Party Mobile *'] || data['Party Mobile'],
        name:   data['Party Name'],
        partyType: type === 'Receipt' ? 'Customer' : 'Supplier',
      });
      if (!party) { errors.push({ row: rowNumber, reason: `Party not found for ${type}`, rowData: data }); skipped++; continue; }

      const amount = parseFloat(data['Amount *'] || data['Amount'] || 0);
      if (!(amount > 0)) { errors.push({ row: rowNumber, reason: 'Amount must be > 0', rowData: data }); skipped++; continue; }

      await PaymentReceipt.create({
        transaction_number: txnNum,
        transaction_type: type,
        transaction_date: txnDate,
        party_id: party.party_id,
        reference_bill_number: data['Reference Bill'] || null,
        reference_bill_type:   data['Reference Bill Type'] || null,
        total_amount: amount,
        remarks: data['Remarks'] || null,
        created_by: req.user?.user_id || null,
      });
      imported++;
      existingSet.add(txnNum);
    } catch (e) {
      errors.push({ row: rowNumber, reason: e.message, rowData: data });
      skipped++;
    }
  }

  res.json({
    message: `Import completed: ${imported} transactions imported, ${skipped} skipped`,
    imported, skipped, errors,
    total: rows.length,
  });
}
