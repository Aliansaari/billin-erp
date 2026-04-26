// ── Excel Import Orchestrator ──────────────────────────────────────────
//
// Handles all 6 Excel templates: customers, suppliers, products,
// sales_bills, purchase_bills, payment_receipts.
//
// Lifecycle (no ledger-mapping pause needed for Excel):
//   parse → validate → preview/confirm → commit → finalize
//
// Re-import keys per template:
//   customers/suppliers: (party_name, mobile_1)
//   products:            barcode (or product_name fallback when blank)
//   sales/purchases:     bill_number
//   payment_receipts:    transaction_number
//
// Postings: customers/suppliers → Party.create (afterCreate hook handles
// ledger + opening JV). Products → Product.create (no posting).
// Sales/purchase/payment templates → corresponding bill row + Posting
// Service post inside one transaction per row.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const sequelize = require('../config/database');
const {
  ImportJob, ImportBatch, Party, Product, Category,
  SalesBill, SalesBillItem, PurchaseBill, PurchaseBillItem,
  PaymentReceipt, SystemSettings,
} = require('../models');
const { postVoucher, reverseVoucher } = require('./ledgerPostingService');
const { buildSalesBillVouchers, buildPurchaseBillVouchers, buildPaymentReceiptVouchers } = require('./voucherBuilders');

const REJECTED_DIR = path.join(__dirname, '..', '..', 'uploads', 'rejected');
fs.mkdirSync(REJECTED_DIR, { recursive: true });

// Header → field map per template. Header lookup is case-insensitive and
// trims whitespace; user can rearrange columns freely.
const HEADER_MAPS = {
  customers: {
    'party name': 'party_name', 'name': 'party_name',
    'mobile 1': 'mobile_1', 'mobile': 'mobile_1',
    'mobile 2': 'mobile_2',
    'email': 'email',
    'address': 'address_line_1',
    'city': 'city', 'state': 'state', 'pincode': 'pincode',
    'gstin': 'gstin', 'pan': 'pan_number',
    'opening balance': 'opening_balance',
    'balance type': 'opening_balance_type',
    'credit allowed': 'credit_allowed',
    'credit limit': 'credit_limit',
  },
  products: {
    'barcode': 'barcode',
    'category': 'category_name',
    'product name': 'product_name',
    'name': 'product_name',
    'hsn code': 'hsn_code',
    'gst %': 'gst_rate', 'gst rate': 'gst_rate',
    'unit': 'unit_of_measurement',
    'opening stock': 'opening_stock',
    'current stock': 'current_stock',
    'purchase rate': 'purchase_rate',
    'sale rate': 'sale_rate',
    'mrp': 'mrp',
  },
  sales_bills_header: {
    'bill number': 'bill_number',
    'date': 'bill_date',
    'customer mobile': 'customer_mobile',
    'customer name':   'customer_name',
    'discount %':      'discount_pct',
    'cgst %': 'cgst_pct', 'sgst %': 'sgst_pct', 'igst %': 'igst_pct',
    'other charges': 'other_charges',
    'freight': 'freight_charges',
    'round off': 'round_off',
    'payment method': 'payment_method',
  },
  sales_bills_items: {
    'bill number': 'bill_number',
    'barcode': 'barcode',
    'product name': 'product_name',
    'category': 'category_name',
    'hsn': 'hsn_code',
    'quantity': 'quantity',
    'rate': 'rate',
    'gst %': 'gst_rate',
  },
  payment_receipts: {
    'transaction number': 'transaction_number',
    'type': 'transaction_type',
    'date': 'transaction_date',
    'party mobile': 'party_mobile',
    'party name': 'party_name',
    'amount': 'total_amount',
    'payment method': 'payment_method',
    'remarks': 'remarks',
  },
};
HEADER_MAPS.suppliers = HEADER_MAPS.customers;
HEADER_MAPS.purchase_bills_header = {
  ...HEADER_MAPS.sales_bills_header,
  'supplier mobile': 'supplier_mobile',
  'supplier name': 'supplier_name',
  'supplier bill no':     'supplier_bill_number',
  'supplier bill number': 'supplier_bill_number',
  'transport':       'transport_name',
  'transport name':  'transport_name',
  'vehicle no':      'vehicle_number',
  'vehicle number':  'vehicle_number',
};
HEADER_MAPS.purchase_bills_items = HEADER_MAPS.sales_bills_items;

// Lower-case + trim cell value for header lookup.
function normHeader(s) { return String(s || '').trim().toLowerCase(); }

// Fields the parser should coerce to ISO YYYY-MM-DD. Excel cells in date-
// formatted columns can arrive as Date objects, numeric serials (the
// internal Excel format), formula cells whose .result is a Date or string,
// or plain strings (ISO, dd/mm/yyyy, etc.) when the file came from a
// non-Excel tool. Without this set the orchestrator silently keeps the
// raw value, so validation passes (truthy) but the commit phase trips
// when Sequelize tries to coerce a number into DATEONLY.
const DATE_FIELDS = new Set(['bill_date', 'transaction_date', 'voucher_date']);

// Excel's day 0 is "Dec 30, 1899" — accounting for the Lotus 1-2-3 leap-
// year bug Excel inherited. Day 1 = 1900-01-01.
const EXCEL_DAY_ZERO_UTC = Date.UTC(1899, 11, 30);

// Single source of truth for date normalisation. Returns ISO YYYY-MM-DD
// string on success, null on failure. ANY input the validator and the
// committer use must run through this function — keeping them in lock-
// step is what makes "preview accepts → commit accepts" hold.
function coerceDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && isFinite(v)) {
    // Excel serial date.
    const ms = EXCEL_DAY_ZERO_UTC + Math.round(v) * 86400000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    // dd/mm/yyyy or dd-mm-yyyy (Indian convention — ambiguous with the US
    // mm/dd; we default to dd/mm because that's the regional norm).
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      const dd = m[1].padStart(2, '0');
      const mm = m[2].padStart(2, '0');
      let yyyy = m[3]; if (yyyy.length === 2) yyyy = '20' + yyyy;
      return `${yyyy}-${mm}-${dd}`;
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  // Formula cell.
  if (typeof v === 'object' && v.result != null) return coerceDate(v.result);
  // Rich text.
  if (typeof v === 'object' && Array.isArray(v.richText)) {
    return coerceDate(v.richText.map((r) => r.text).join(''));
  }
  return null;
}

// ── Public entry point ─────────────────────────────────────────────────
async function run(job) {
  await job.update({ started_at: job.started_at || new Date() });
  const profile = job.profile_json || {};
  const choices = profile.user_choices || null;
  if (job.preview_json && choices) return commit(job);
  return parseAndPreview(job);
}

// ── 1+2+3. Parse + validate + preview ──────────────────────────────────
async function parseAndPreview(job) {
  await job.update({ status: 'parsing', progress_pct: 5, phase_message: 'Reading workbook…' });
  if (!job.input_file_path || !fs.existsSync(job.input_file_path)) {
    return fail(job, 'Uploaded file is missing on disk.');
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(job.input_file_path);

  const template = String(job.source).replace('excel_', '');
  await job.update({ progress_pct: 20, phase_message: `Validating ${template}…`, status: 'validating' });

  const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
  const gstEnabled = !!(settings && settings.gst_enabled);

  let buckets;
  try {
    if (template === 'customers' || template === 'suppliers') {
      buckets = await validateParties(wb, template);
    } else if (template === 'products') {
      buckets = await validateProducts(wb);
    } else if (template === 'sales' || template === 'sales_bills') {
      buckets = await validateBills(wb, 'sales', gstEnabled);
    } else if (template === 'purchases' || template === 'purchase_bills') {
      buckets = await validateBills(wb, 'purchase', gstEnabled);
    } else if (template === 'payments' || template === 'payment_receipts') {
      buckets = await validatePayments(wb);
    } else {
      return fail(job, `Unsupported Excel template: ${template}`);
    }
  } catch (e) {
    return fail(job, 'Validate error: ' + e.message);
  }

  const preview = {
    template,
    counts: {
      create: buckets.create.length, update: buckets.update.length,
      skip: buckets.skip.length, reject: buckets.reject.length,
    },
    sample: {
      create: buckets.create.slice(0, 10).map((x) => slim(x, false)),
      update: buckets.update.slice(0, 10).map((x) => slim(x, true)),
      reject: buckets.reject.slice(0, 20).map((x) => ({ row: x.row, reason: x.reason })),
    },
    gst_enabled: gstEnabled,
  };

  await job.update({
    status: 'awaiting_confirmation',
    progress_pct: 50,
    phase_message: `Ready: ${preview.counts.create} new, ${preview.counts.update} updates, ${preview.counts.skip} unchanged, ${preview.counts.reject} rejected`,
    preview_json: { ...preview, _full_buckets: buckets, _template: template, _gstEnabled: gstEnabled },
  });
}

// Shape the preview UI consumes. Includes the date and total so the
// "Will create / Will update" tables can render them — without this the
// preview would render "—" in every row even when the data was fine.
function slim(x, isUpdate) {
  const d = x._data || {};
  const date = d.bill_date || d.transaction_date || d.voucher_date || null;
  const newTotal = x._totals ? x._totals.total_amount : (d.total_amount != null ? Number(d.total_amount) : null);
  const out = {
    row: x.row,
    identifier: x.identifier,
    date,
    total: newTotal,
  };
  if (isUpdate) {
    out.new_total = newTotal;
    out.old_total = x._existingTotal != null ? Number(x._existingTotal) : null;
  }
  return out;
}

// ── parseSheet — header→field translator ─────────────────────────────
function parseSheet(ws, headerMap) {
  if (!ws) return [];
  const rows = [];
  let headerRow = null;
  ws.eachRow({ includeEmpty: false }, (row, num) => {
    if (num === 1) {
      headerRow = row.values.map((v) => normHeader(v));
      return;
    }
    if (!headerRow) return;
    const out = { _rowNum: num };
    for (let i = 1; i < headerRow.length; i++) {
      const field = headerMap[headerRow[i]];
      if (!field) continue;
      const v = row.values[i];
      if (v == null) continue;
      // Date-typed columns ALWAYS go through coerceDate so validate and
      // commit see the same shape (ISO YYYY-MM-DD string, or null).
      if (DATE_FIELDS.has(field)) {
        const iso = coerceDate(v);
        if (iso) out[field] = iso;
        continue;
      }
      if (v instanceof Date) out[field] = v.toISOString().slice(0, 10);
      else if (typeof v === 'object' && v.result != null) out[field] = v.result;
      else if (typeof v === 'object' && Array.isArray(v.richText)) {
        out[field] = v.richText.map((r) => r.text).join('');
      } else out[field] = v;
    }
    rows.push(out);
  });
  return rows;
}

// ── validateParties — customers/suppliers ─────────────────────────────
async function validateParties(wb, template) {
  const ws = wb.worksheets[0];
  const rows = parseSheet(ws, HEADER_MAPS[template]);
  const buckets = { create: [], update: [], skip: [], reject: [] };

  // Index existing parties by (name, mobile) for diff.
  const existing = await Party.findAll({ attributes: ['party_id', 'party_name', 'mobile_1', 'opening_balance'] });
  const key = (n, m) => `${String(n || '').toLowerCase()}|${String(m || '').replace(/\D/g, '')}`;
  const byKey = new Map(existing.map((p) => [key(p.party_name, p.mobile_1), p]));

  for (const r of rows) {
    if (!r.party_name) {
      buckets.reject.push({ row: r._rowNum, reason: 'Party Name required.', _data: r });
      continue;
    }
    if (!r.mobile_1) {
      buckets.reject.push({ row: r._rowNum, reason: 'Mobile 1 required.', _data: r });
      continue;
    }
    const k = key(r.party_name, r.mobile_1);
    const e = byKey.get(k);
    const identifier = `${r.party_name} (${r.mobile_1})`;
    if (e) {
      // Re-import: identical → skip; otherwise update.
      const oldOpening = Number(e.opening_balance) || 0;
      const newOpening = Number(r.opening_balance) || 0;
      if (Math.abs(oldOpening - newOpening) < 0.01) {
        buckets.skip.push({ row: r._rowNum, identifier, _data: r, _existingId: e.party_id });
      } else {
        buckets.update.push({ row: r._rowNum, identifier, _data: r, _existingId: e.party_id });
      }
    } else {
      buckets.create.push({ row: r._rowNum, identifier, _data: { ...r, party_type: template === 'customers' ? 'Customer' : 'Supplier' } });
    }
  }
  return buckets;
}

// ── validateProducts ──────────────────────────────────────────────────
async function validateProducts(wb) {
  const ws = wb.worksheets[0];
  const rows = parseSheet(ws, HEADER_MAPS.products);
  const buckets = { create: [], update: [], skip: [], reject: [] };

  const existing = await Product.findAll({ attributes: ['product_id', 'barcode', 'product_name'] });
  const byBarcode = new Map(existing.filter((p) => p.barcode).map((p) => [String(p.barcode).toLowerCase(), p]));
  const byName = new Map(existing.map((p) => [String(p.product_name).toLowerCase(), p]));

  for (const r of rows) {
    if (!r.product_name) {
      buckets.reject.push({ row: r._rowNum, reason: 'Product Name required.', _data: r });
      continue;
    }
    const e = (r.barcode && byBarcode.get(String(r.barcode).toLowerCase()))
           || byName.get(String(r.product_name).toLowerCase());
    const identifier = `${r.product_name}${r.barcode ? ` [${r.barcode}]` : ''}`;
    if (e) buckets.skip.push({ row: r._rowNum, identifier, _data: r, _existingId: e.product_id });
    else   buckets.create.push({ row: r._rowNum, identifier, _data: r });
  }
  return buckets;
}

// ── validateBills (sales / purchase) ──────────────────────────────────
async function validateBills(wb, kind, gstEnabled) {
  const headerMap = HEADER_MAPS[`${kind}_bills_header`];
  const itemsMap  = HEADER_MAPS[`${kind}_bills_items`];
  const billsWs = wb.getWorksheet('Bills') || wb.worksheets[0];
  const itemsWs = wb.getWorksheet('Items') || wb.worksheets[1];
  const billRows = parseSheet(billsWs, headerMap);
  const itemRows = itemsWs ? parseSheet(itemsWs, itemsMap) : [];

  // Group items by bill_number.
  const itemsByBill = new Map();
  for (const it of itemRows) {
    if (!it.bill_number) continue;
    const arr = itemsByBill.get(it.bill_number) || [];
    arr.push(it);
    itemsByBill.set(it.bill_number, arr);
  }

  const Bill = kind === 'sales' ? SalesBill : PurchaseBill;
  const numCol = 'bill_number';
  const existing = await Bill.findAll({ attributes: [kind === 'sales' ? 'sales_bill_id' : 'purchase_bill_id', numCol, 'total_amount'] });
  const byNum = new Map(existing.map((b) => [b[numCol], b]));

  const buckets = { create: [], update: [], skip: [], reject: [] };
  for (const r of billRows) {
    if (!r.bill_number) { buckets.reject.push({ row: r._rowNum, reason: 'Bill Number required.', _data: r }); continue; }
    if (!r.bill_date)   { buckets.reject.push({ row: r._rowNum, reason: 'Date required.', _data: r }); continue; }
    const items = itemsByBill.get(r.bill_number) || [];
    if (items.length === 0) {
      buckets.reject.push({ row: r._rowNum, reason: 'Bill has no items.', _data: r });
      continue;
    }
    // Compute totals.
    let taxable = 0;
    for (const it of items) {
      const q = Number(it.quantity) || 0;
      const rate = Number(it.rate) || 0;
      taxable += q * rate;
    }
    const discountPct = Number(r.discount_pct) || 0;
    const discount = round2(taxable * discountPct / 100);
    const cgstPct = gstEnabled ? (Number(r.cgst_pct) || 0) : 0;
    const sgstPct = gstEnabled ? (Number(r.sgst_pct) || 0) : 0;
    const igstPct = gstEnabled ? (Number(r.igst_pct) || 0) : 0;
    const taxableNet = taxable - discount;
    const cgst = round2(taxableNet * cgstPct / 100);
    const sgst = round2(taxableNet * sgstPct / 100);
    const igst = round2(taxableNet * igstPct / 100);
    const otherCharges = Number(r.other_charges) || 0;
    const freight = Number(r.freight_charges) || 0;
    const roundOff = Number(r.round_off) || 0;
    const total = round2(taxableNet + cgst + sgst + igst + otherCharges + freight + roundOff);

    const identifier = r.bill_number;
    const existingBill = byNum.get(r.bill_number);
    const totals = { taxable: round2(taxable), discount, cgst, sgst, igst, cgst_pct: cgstPct, sgst_pct: sgstPct, igst_pct: igstPct, other_charges: otherCharges, freight_charges: freight, round_off: roundOff, total_amount: total };
    if (existingBill) {
      const idVal = existingBill[kind === 'sales' ? 'sales_bill_id' : 'purchase_bill_id'];
      const existingTotal = Number(existingBill.total_amount) || 0;
      if (Math.abs(existingTotal - total) < 0.01) {
        buckets.skip.push({ row: r._rowNum, identifier, _data: r, _items: items, _totals: totals, _existingId: idVal, _existingTotal: existingTotal });
      } else {
        buckets.update.push({ row: r._rowNum, identifier, _data: r, _items: items, _totals: totals, _existingId: idVal, _existingTotal: existingTotal });
      }
    } else {
      buckets.create.push({ row: r._rowNum, identifier, _data: r, _items: items, _totals: totals });
    }
  }
  return buckets;
}

// ── validatePayments ──────────────────────────────────────────────────
async function validatePayments(wb) {
  const ws = wb.worksheets[0];
  const rows = parseSheet(ws, HEADER_MAPS.payment_receipts);
  const buckets = { create: [], update: [], skip: [], reject: [] };
  const existing = await PaymentReceipt.findAll({ attributes: ['transaction_id', 'transaction_number', 'total_amount'] });
  const byNum = new Map(existing.map((p) => [p.transaction_number, p]));
  for (const r of rows) {
    if (!r.transaction_number) { buckets.reject.push({ row: r._rowNum, reason: 'Transaction Number required.', _data: r }); continue; }
    if (!r.party_name && !r.party_mobile) { buckets.reject.push({ row: r._rowNum, reason: 'Party Name or Mobile required.', _data: r }); continue; }
    if (!r.total_amount || Number(r.total_amount) <= 0) { buckets.reject.push({ row: r._rowNum, reason: 'Amount must be > 0.', _data: r }); continue; }
    const type = String(r.transaction_type || '').toLowerCase();
    if (type !== 'receipt' && type !== 'payment') {
      buckets.reject.push({ row: r._rowNum, reason: `Type must be 'Receipt' or 'Payment' (got '${r.transaction_type}').`, _data: r });
      continue;
    }
    const identifier = r.transaction_number;
    const existingRow = byNum.get(r.transaction_number);
    if (existingRow) {
      const existingTotal = Number(existingRow.total_amount) || 0;
      if (Math.abs(existingTotal - Number(r.total_amount)) < 0.01) {
        buckets.skip.push({ row: r._rowNum, identifier, _data: r, _existingId: existingRow.transaction_id, _existingTotal: existingTotal });
      } else {
        buckets.update.push({ row: r._rowNum, identifier, _data: r, _existingId: existingRow.transaction_id, _existingTotal: existingTotal });
      }
    } else {
      buckets.create.push({ row: r._rowNum, identifier, _data: r });
    }
  }
  return buckets;
}

// ── 4. Commit ──────────────────────────────────────────────────────────
async function commit(job) {
  await job.update({ status: 'committing', progress_pct: 60, phase_message: 'Committing rows…' });
  const full = job.preview_json || {};
  const buckets = full._full_buckets;
  const template = full._template;
  const gstEnabled = full._gstEnabled;
  if (!buckets || !template) return fail(job, 'Internal error: preview data missing.');

  const handler =
    template === 'customers' || template === 'suppliers' ? commitParty :
    template === 'products' ? commitProduct :
    template === 'sales' || template === 'sales_bills' ? (j, item, action) => commitBill(j, item, action, 'sales') :
    template === 'purchases' || template === 'purchase_bills' ? (j, item, action) => commitBill(j, item, action, 'purchase') :
    template === 'payments' || template === 'payment_receipts' ? commitPayment :
    null;
  if (!handler) return fail(job, 'No commit handler for template ' + template);

  let posted = 0, failed = 0;
  const all = [
    ...buckets.create.map((x) => ({ x, action: 'create' })),
    ...buckets.update.map((x) => ({ x, action: 'update' })),
  ];
  let i = 0;
  for (const { x, action } of all) {
    await job.reload();
    if (job.status === 'cancelled') {
      return finalize(job, { posted, failed, skipped: buckets.skip.length, rejected: [...buckets.reject], cancelled: true });
    }
    const ok = await handler(job, x, action);
    if (ok.success) posted++;
    else { failed++; buckets.reject.push({ row: x.row, reason: ok.error, identifier: x.identifier }); }
    i++;
    if (i % 25 === 0) {
      await job.update({ progress_pct: 60 + Math.round((i / all.length) * 35), phase_message: `Committed ${i}/${all.length}` });
    }
  }
  return finalize(job, { posted, failed, skipped: buckets.skip.length, rejected: buckets.reject });
}

async function commitParty(job, item, action) {
  const t = await sequelize.transaction();
  try {
    const d = item._data;
    if (action === 'create') {
      const party = await Party.create({
        party_type: d.party_type,
        party_name: d.party_name,
        mobile_1: String(d.mobile_1).slice(0, 15),
        mobile_2: d.mobile_2 ? String(d.mobile_2).slice(0, 15) : null,
        email: d.email || null,
        address_line_1: d.address_line_1 || null,
        city: d.city || null, state: d.state || null, pincode: d.pincode || null,
        gstin: d.gstin || null, pan_number: d.pan_number || null,
        opening_balance: Number(d.opening_balance) || 0,
        // Workbook "Balance Type" column carries free-form values like
        // "Cr"/"Dr"/"Credit"/"Receivable". Route through the model's
        // static normalizer so every alias maps to the right enum value
        // — the afterCreate hook posts the JV based on this column.
        opening_balance_type: Party.normalizeBalanceType(d.opening_balance_type),
        credit_allowed: !!d.credit_allowed,
        credit_limit: Number(d.credit_limit) || 0,
      }, { transaction: t });
      await ImportBatch.create({
        import_job_id: job.id, entity_type: 'party', entity_id: party.party_id,
        external_ref: party.party_name, action: 'created',
      }, { transaction: t });
    } else {
      // Update flow: only opening_balance changed (per validateParties).
      // Skip for safety — opening balance edits should go through a manual JV.
      await ImportBatch.create({
        import_job_id: job.id, entity_type: 'party', entity_id: item._existingId,
        external_ref: item.identifier, action: 'updated',
        reason: 'Opening balance change ignored — adjust via manual Journal Voucher.',
      }, { transaction: t });
    }
    await t.commit();
    return { success: true };
  } catch (err) {
    try { await t.rollback(); } catch (_) {}
    return { success: false, error: err.message };
  }
}

async function commitProduct(job, item, action) {
  const t = await sequelize.transaction();
  try {
    const d = item._data;
    let categoryId = null;
    if (d.category_name) {
      const [cat] = await Category.findOrCreate({ where: { category_name: d.category_name }, transaction: t });
      categoryId = cat.category_id;
    }
    if (action === 'create') {
      const bc = d.barcode || `XLS${Date.now().toString().slice(-10)}${Math.floor(Math.random()*100)}`;
      const prod = await Product.create({
        barcode: String(bc).slice(0, 20),
        product_name: d.product_name,
        category_id: categoryId,
        hsn_code: d.hsn_code || null,
        gst_rate: Number(d.gst_rate) || 0,
        opening_stock: Number(d.opening_stock) || 0,
        current_stock: Number(d.current_stock) || Number(d.opening_stock) || 0,
        purchase_rate: Number(d.purchase_rate) || 0,
        sale_rate: Number(d.sale_rate) || 0,
        mrp: Number(d.mrp) || 0,
      }, { transaction: t });
      await ImportBatch.create({
        import_job_id: job.id, entity_type: 'product', entity_id: prod.product_id,
        external_ref: prod.barcode, action: 'created',
      }, { transaction: t });
    }
    await t.commit();
    return { success: true };
  } catch (err) {
    try { await t.rollback(); } catch (_) {}
    return { success: false, error: err.message };
  }
}

async function commitBill(job, item, action, kind) {
  const t = await sequelize.transaction();
  try {
    const d = item._data;
    const totals = item._totals;
    const items = item._items;

    // Resolve party.
    const partyType = kind === 'sales' ? 'Customer' : 'Supplier';
    const partyMobile = d[`${partyType.toLowerCase()}_mobile`] || d.party_mobile;
    const partyName   = d[`${partyType.toLowerCase()}_name`]   || d.party_name;
    let party = null;
    if (partyMobile) party = await Party.findOne({ where: { mobile_1: String(partyMobile) }, transaction: t });
    if (!party && partyName) party = await Party.findOne({ where: { party_name: partyName }, transaction: t });
    if (!party && partyName) {
      // Auto-create
      const stub = `XLS${Date.now().toString().slice(-9)}${Math.floor(Math.random()*100)}`.slice(0, 15);
      party = await Party.create({
        party_type: partyType,
        party_name: partyName,
        mobile_1: partyMobile ? String(partyMobile).slice(0, 15) : stub,
      }, { transaction: t });
    }
    if (kind === 'purchase' && !party) throw new Error('Purchase requires a supplier.');

    const Bill = kind === 'sales' ? SalesBill : PurchaseBill;
    const ItemModel = kind === 'sales' ? SalesBillItem : PurchaseBillItem;
    const idCol = kind === 'sales' ? 'sales_bill_id' : 'purchase_bill_id';
    const fkParty = kind === 'sales' ? 'customer_id' : 'supplier_id';
    const sourceType = kind === 'sales' ? 'sales_bill' : 'purchase_bill';
    const subType = kind === 'sales' ? 'sales_bill_receipt' : 'purchase_bill_payment';

    const billData = {
      bill_number: d.bill_number,
      bill_date: d.bill_date,
      [fkParty]: party ? party.party_id : null,
      sub_total: totals.taxable, discount_amount: totals.discount,
      cgst_amount: totals.cgst, sgst_amount: totals.sgst, igst_amount: totals.igst,
      cgst_pct: totals.cgst_pct, sgst_pct: totals.sgst_pct, igst_pct: totals.igst_pct,
      round_off: totals.round_off, other_charges: totals.other_charges, freight_charges: totals.freight_charges,
      total_amount: totals.total_amount, paid_amount: 0,
      balance_amount: totals.total_amount, payment_status: 'Unpaid',
      payment_method: d.payment_method || 'Cash',
    };
    // Purchase-only header fields. Carry them through if the workbook
    // supplied them — leaving them off would silently lose data the user
    // entered and is hard to spot until an audit.
    if (kind === 'purchase') {
      if (d.supplier_bill_number) billData.supplier_bill_number = String(d.supplier_bill_number);
      if (d.transport_name)       billData.transport_name       = String(d.transport_name);
      if (d.vehicle_number)       billData.vehicle_number       = String(d.vehicle_number);
    }

    let billRow;
    if (action === 'update') {
      billRow = await Bill.findByPk(item._existingId, { transaction: t });
      if (!billRow) throw new Error('Update target row vanished.');
      await reverseVoucher({ sourceType, sourceId: billRow[idCol], reason: 'Excel re-import update', transaction: t });
      await reverseVoucher({ sourceType: subType, sourceId: billRow[idCol], reason: 'Excel re-import update', transaction: t });
      await billRow.update(billData, { transaction: t });
      await ItemModel.destroy({ where: { [idCol]: billRow[idCol] }, transaction: t });
    } else {
      billRow = await Bill.create(billData, { transaction: t });
    }

    // Create items.
    for (const it of items) {
      let prod = null;
      if (it.barcode) prod = await Product.findOne({ where: { barcode: String(it.barcode) }, transaction: t });
      if (!prod && it.product_name) prod = await Product.findOne({ where: { product_name: it.product_name }, transaction: t });
      // Auto-create product if missing.
      if (!prod && it.product_name) {
        let categoryId = null;
        if (it.category_name) {
          const [cat] = await Category.findOrCreate({ where: { category_name: it.category_name }, transaction: t });
          categoryId = cat.category_id;
        }
        const bc = it.barcode || `XLS${Date.now().toString().slice(-10)}${Math.floor(Math.random()*100)}`;
        prod = await Product.create({
          barcode: String(bc).slice(0, 20),
          product_name: it.product_name,
          category_id: categoryId,
          hsn_code: it.hsn_code || null,
          gst_rate: Number(it.gst_rate) || 0,
        }, { transaction: t });
      }
      const qty = Number(it.quantity) || 0;
      const rate = Number(it.rate) || 0;
      // SalesBillItem stores the line price as `rate`; PurchaseBillItem
      // splits it into `purchase_rate` (NOT NULL — what the supplier
      // charged) and `sale_rate` (planned outgoing). We map the single
      // workbook "Rate" column to the right model field so the NOT NULL
      // constraint isn't tripped.
      const itemData = {
        [idCol]: billRow[idCol],
        product_id: prod ? prod.product_id : null,
        barcode: prod ? prod.barcode : (it.barcode || null),
        product_name: it.product_name || (prod && prod.product_name),
        hsn_code: it.hsn_code || null,
        quantity: qty,
        mrp: 0,
        taxable_amount: round2(qty * rate),
        gst_rate: Number(it.gst_rate) || 0,
        total_amount: round2(qty * rate),
      };
      if (kind === 'sales') {
        itemData.rate = rate;
        itemData.cost_rate = prod ? Number(prod.purchase_rate || 0) : 0;
      } else {
        itemData.purchase_rate = rate;
        // sale_rate is also NOT NULL on PurchaseBillItem in some installs;
        // default to the product's master sale_rate when available, else
        // mirror purchase_rate so the column always has a sensible number.
        itemData.sale_rate = prod ? Number(prod.sale_rate || rate) : rate;
      }
      await ItemModel.create(itemData, { transaction: t });
    }

    // Post via Posting Service.
    const refreshed = await Bill.findByPk(billRow[idCol], {
      include: [{ model: Party, as: kind === 'sales' ? 'customer' : 'supplier' }],
      transaction: t,
    });
    const builder = kind === 'sales' ? buildSalesBillVouchers : buildPurchaseBillVouchers;
    const vouchers = await builder(refreshed, { transaction: t });
    for (const v of vouchers) await postVoucher({ ...v, userId: job.created_by, transaction: t });

    await ImportBatch.create({
      import_job_id: job.id, entity_type: sourceType, entity_id: billRow[idCol],
      external_ref: d.bill_number, action: action === 'update' ? 'updated' : 'created',
    }, { transaction: t });

    await t.commit();
    return { success: true };
  } catch (err) {
    try { await t.rollback(); } catch (_) {}
    return { success: false, error: err.message };
  }
}

async function commitPayment(job, item, action) {
  const t = await sequelize.transaction();
  try {
    const d = item._data;
    let party = null;
    if (d.party_mobile) party = await Party.findOne({ where: { mobile_1: String(d.party_mobile) }, transaction: t });
    if (!party && d.party_name) party = await Party.findOne({ where: { party_name: d.party_name }, transaction: t });
    if (!party) throw new Error('Party not found and cannot be auto-created from a payment row alone.');

    const type = String(d.transaction_type).toLowerCase() === 'payment' ? 'Payment' : 'Receipt';
    let row;
    if (action === 'update') {
      row = await PaymentReceipt.findByPk(item._existingId, { transaction: t });
      if (!row) throw new Error('Update target row vanished.');
      await reverseVoucher({ sourceType: 'payment_receipt', sourceId: row.transaction_id, reason: 'Excel re-import update', transaction: t });
      await row.update({
        transaction_date: d.transaction_date, party_id: party.party_id,
        total_amount: Number(d.total_amount), payment_method: d.payment_method || 'Cash',
      }, { transaction: t });
    } else {
      row = await PaymentReceipt.create({
        transaction_number: d.transaction_number,
        transaction_type: type,
        transaction_date: d.transaction_date,
        party_id: party.party_id,
        total_amount: Number(d.total_amount),
        payment_method: d.payment_method || 'Cash',
      }, { transaction: t });
    }
    const refreshed = await PaymentReceipt.findByPk(row.transaction_id, {
      include: [{ model: Party, as: 'party' }],
      transaction: t,
    });
    const vouchers = await buildPaymentReceiptVouchers(refreshed, { transaction: t });
    for (const v of vouchers) await postVoucher({ ...v, userId: job.created_by, transaction: t });
    await ImportBatch.create({
      import_job_id: job.id, entity_type: 'payment_receipt', entity_id: row.transaction_id,
      external_ref: d.transaction_number, action: action === 'update' ? 'updated' : 'created',
    }, { transaction: t });
    await t.commit();
    return { success: true };
  } catch (err) {
    try { await t.rollback(); } catch (_) {}
    return { success: false, error: err.message };
  }
}

async function finalize(job, summary) {
  let rejectedPath = null;
  if (summary.rejected && summary.rejected.length > 0) {
    rejectedPath = path.join(REJECTED_DIR, `rejected-${job.id}-${Date.now()}.xlsx`);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rejected');
    ws.columns = [
      { header: 'Row #', key: 'row', width: 10 },
      { header: 'Identifier', key: 'identifier', width: 30 },
      { header: 'Reason', key: 'reason', width: 80 },
    ];
    for (const r of summary.rejected) ws.addRow({ row: r.row, identifier: r.identifier, reason: r.reason });
    await wb.xlsx.writeFile(rejectedPath);
  }
  await job.update({
    status: summary.cancelled ? 'cancelled' : 'done',
    progress_pct: summary.cancelled ? job.progress_pct : 100,
    phase_message: summary.cancelled ? 'Cancelled by user' : 'Done',
    completed_at: new Date(),
    rejected_rows_path: rejectedPath,
    result_summary_json: {
      posted: summary.posted || 0, failed: summary.failed || 0,
      skipped: summary.skipped || 0, rejected: (summary.rejected || []).length,
    },
  });
}

async function fail(job, message) {
  await job.update({ status: 'failed', error_message: message, completed_at: new Date() });
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = { run };
