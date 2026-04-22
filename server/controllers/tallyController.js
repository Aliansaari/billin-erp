/*
 * TallyPrime integration controller — file-based XML + live HTTP-XML.
 *
 * Tally's schema (simplified):
 *   Masters:   GROUP → UNIT → STOCKITEM → LEDGER
 *              (dependency order — children reference parents by name)
 *   Vouchers:  SALES / PURCHASE / RECEIPT / PAYMENT
 *   Envelope:  <ENVELOPE><HEADER>…</HEADER><BODY><IMPORTDATA>…</IMPORTDATA></BODY></ENVELOPE>
 *
 * We generate XML by hand (not via a library) because every Tally tag is
 * case-sensitive UPPERCASE and many are self-closing — wrapping xmlbuilder
 * around every field would add more ceremony than it removes.
 *
 * Live mode uses Node's built-in http; Tally listens on port 9000 when
 * ODBC/XML server is enabled in Gateway → F1 → Connectivity.
 */

const http = require('http');
const sequelize = require('../config/database');
const { SystemSettings, Party, Product, SalesBill, SalesBillItem,
        PurchaseBill, PurchaseBillItem, PaymentReceipt } = require('../models');
const { Op } = require('sequelize');

/* ────────────────────────────────────────────────────────────────────────
 * Helpers — XML escape, envelope wrap, state code → intrastate detection
 * ─────────────────────────────────────────────────────────────────────── */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const envelope = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<ENVELOPE>\n` +
  `  <HEADER>\n` +
  `    <TALLYREQUEST>Import Data</TALLYREQUEST>\n` +
  `  </HEADER>\n` +
  `  <BODY>\n` +
  `    <IMPORTDATA>\n` +
  `      <REQUESTDESC>\n` +
  `        <REPORTNAME>All Masters</REPORTNAME>\n` +
  `      </REQUESTDESC>\n` +
  `      <REQUESTDATA>\n` +
  `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n` +
  body +
  `        </TALLYMESSAGE>\n` +
  `      </REQUESTDATA>\n` +
  `    </IMPORTDATA>\n` +
  `  </BODY>\n` +
  `</ENVELOPE>\n`;

// First two digits of GSTIN are the Indian state code. If our company's state
// code matches the party's, the supply is intrastate → split CGST/SGST. Else
// interstate → IGST.
const stateOfGstin = (gstin) => {
  if (!gstin || gstin.length < 2) return null;
  return gstin.substring(0, 2);
};

/* ────────────────────────────────────────────────────────────────────────
 * Config: GET / PUT /api/tally/config
 * ─────────────────────────────────────────────────────────────────────── */

exports.getConfig = async (req, res) => {
  try {
    const s = await SystemSettings.findByPk(1);
    if (!s) return res.json({ tally_host: 'localhost', tally_port: 9000 });
    res.json({
      tally_host: s.tally_host || 'localhost',
      tally_port: s.tally_port || 9000,
      tally_company: s.tally_company || '',
      tally_sync_enabled: !!s.tally_sync_enabled,
      tally_last_sync: s.tally_last_sync || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.updateConfig = async (req, res) => {
  try {
    const { tally_host, tally_port, tally_company, tally_sync_enabled } = req.body;
    const [s] = await SystemSettings.findOrCreate({ where: { setting_id: 1 }, defaults: { setting_id: 1 } });
    await s.update({
      tally_host: tally_host || 'localhost',
      tally_port: tally_port || 9000,
      tally_company: tally_company || null,
      tally_sync_enabled: !!tally_sync_enabled,
    });
    res.json({
      tally_host: s.tally_host,
      tally_port: s.tally_port,
      tally_company: s.tally_company,
      tally_sync_enabled: s.tally_sync_enabled,
      tally_last_sync: s.tally_last_sync,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/* ────────────────────────────────────────────────────────────────────────
 * Live mode: POST /api/tally/test-connection
 *
 * Sends an EXPORT request for "List of Companies" which is cheap and
 * doesn't require any company to be loaded. A 200 response with a
 * well-formed XML body means Tally is alive; anything else surfaces
 * the exact network/protocol error to the UI.
 * ─────────────────────────────────────────────────────────────────────── */

function postTallyXML({ host, port, xml, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(xml, 'utf-8');
    const req = http.request({
      host, port, method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'Content-Length': body.length,
      },
    }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Tally did not respond within ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}

exports.testConnection = async (req, res) => {
  const { tally_host = 'localhost', tally_port = 9000 } = req.body || {};
  const start = Date.now();
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ENVELOPE>\n` +
    `  <HEADER>\n` +
    `    <VERSION>1</VERSION>\n` +
    `    <TALLYREQUEST>Export</TALLYREQUEST>\n` +
    `    <TYPE>Collection</TYPE>\n` +
    `    <ID>List of Companies</ID>\n` +
    `  </HEADER>\n` +
    `  <BODY>\n` +
    `    <DESC>\n` +
    `      <STATICVARIABLES>\n` +
    `        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>\n` +
    `      </STATICVARIABLES>\n` +
    `    </DESC>\n` +
    `  </BODY>\n` +
    `</ENVELOPE>\n`;

  try {
    const { status, body } = await postTallyXML({ host: tally_host, port: tally_port, xml });
    const ms = Date.now() - start;
    if (status !== 200) {
      return res.status(502).json({
        error: `Tally returned HTTP ${status}`,
        detail: body.slice(0, 500),
      });
    }
    // Quick&dirty — pick the first <COMPANYNAME>…</COMPANYNAME> (Tally uses
    // various tag names across versions; this covers common exports).
    const m = body.match(/<(?:COMPANYNAME|NAME)[^>]*>([^<]+)<\/(?:COMPANYNAME|NAME)>/i);
    res.json({
      ms,
      active_company: m ? m[1].trim() : null,
      response_bytes: body.length,
    });
  } catch (e) {
    const ms = Date.now() - start;
    const hint =
      /ECONNREFUSED/.test(e.message)
        ? 'Tally is not accepting connections on that host/port. Is Gateway → F1 → Connectivity → ODBC Server ON?'
        : /timed out|ETIMEDOUT/.test(e.message)
          ? 'No response from Tally. Check that the company is loaded and the ODBC/XML server is running.'
          : e.message;
    res.status(502).json({ error: 'Connection failed', detail: hint });
  }
};

/* ────────────────────────────────────────────────────────────────────────
 * File mode: GET /api/tally/export/masters
 *
 * Emits <LEDGER>, <STOCKITEM>, <UNIT>, <GROUP> inside one IMPORTDATA
 * envelope, in dependency order (Groups → Units → Stock Items → Ledgers).
 * ─────────────────────────────────────────────────────────────────────── */

const GROUP_DEFS = [
  { name: 'Sundry Debtors',   parent: 'Current Assets' },
  { name: 'Sundry Creditors', parent: 'Current Liabilities' },
  { name: 'Sales Accounts',   parent: 'Primary' },
  { name: 'Purchase Accounts',parent: 'Primary' },
  { name: 'Duties & Taxes',   parent: 'Current Liabilities' },
];

const UNIT_MAP = {
  // Tally uses abbreviated UNIT names — keep the upper-case symbols aligned
  // with its conventions so imports merge cleanly instead of creating a
  // parallel "PCS" vs "Nos" duplicate set.
  PCS: 'Nos', KG: 'Kgs', METER: 'Mtrs', LITER: 'Ltrs', BOX: 'Box', DOZEN: 'Doz',
};

function groupXML(g) {
  return `<GROUP NAME="${esc(g.name)}" ACTION="Create">
  <NAME>${esc(g.name)}</NAME>
  <PARENT>${esc(g.parent)}</PARENT>
</GROUP>\n`;
}

function unitXML(symbol) {
  return `<UNIT NAME="${esc(symbol)}" ACTION="Create">
  <NAME>${esc(symbol)}</NAME>
  <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
</UNIT>\n`;
}

function stockItemXML(p) {
  const unit = UNIT_MAP[p.unit_of_measurement] || 'Nos';
  return `<STOCKITEM NAME="${esc(p.product_name)}" ACTION="Create">
  <NAME>${esc(p.product_name)}</NAME>
  <BASEUNITS>${esc(unit)}</BASEUNITS>
  <GSTAPPLICABLE>Applicable</GSTAPPLICABLE>
  <HSNCODE>${esc(p.hsn_code || '')}</HSNCODE>
  <GSTDETAILS.LIST>
    <APPLICABLEFROM>${esc(new Date().toISOString().slice(0,10).replace(/-/g,''))}</APPLICABLEFROM>
    <TAXABILITY>Taxable</TAXABILITY>
    <GSTRATE>${parseFloat(p.gst_rate || 0).toFixed(2)}</GSTRATE>
  </GSTDETAILS.LIST>
  <OPENINGBALANCE>${parseFloat(p.opening_stock || 0)} ${esc(unit)}</OPENINGBALANCE>
  <OPENINGRATE>${parseFloat(p.opening_stock_rate || 0).toFixed(2)}/${esc(unit)}</OPENINGRATE>
  <BARCODE>${esc(p.barcode || '')}</BARCODE>
</STOCKITEM>\n`;
}

function ledgerXML(party) {
  const isCustomer = party.party_type === 'Customer' || party.party_type === 'Both';
  const parent = isCustomer ? 'Sundry Debtors' : 'Sundry Creditors';
  const openBal = parseFloat(party.opening_balance || 0);
  // Tally convention: positive opening balance on a Debtor = they owe you (Dr);
  // a positive balance on a Creditor = you owe them (Cr). The sign on the
  // amount itself conveys direction. Payable = -, Receivable = +.
  const signedBal = party.opening_balance_type === 'Payable' ? -openBal : openBal;
  return `<LEDGER NAME="${esc(party.party_name)}" ACTION="Create">
  <NAME>${esc(party.party_name)}</NAME>
  <PARENT>${esc(parent)}</PARENT>
  <ISDEEMEDPOSITIVE>${isCustomer ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
  <OPENINGBALANCE>${signedBal.toFixed(2)}</OPENINGBALANCE>
  <GSTIN>${esc(party.gstin || '')}</GSTIN>
  <LEDSTATENAME>${esc(party.state || '')}</LEDSTATENAME>
  <MAILINGNAME>${esc(party.display_name || party.party_name)}</MAILINGNAME>
  <LEDGERCONTACT>${esc(party.mobile_1 || '')}</LEDGERCONTACT>
  <LEDGEREMAIL>${esc(party.email || '')}</LEDGEREMAIL>
  <LEDGERMOBILE>${esc(party.mobile_1 || '')}</LEDGERMOBILE>
</LEDGER>\n`;
}

exports.exportMasters = async (req, res) => {
  try {
    const parties = await Party.findAll({ where: { is_active: true }, raw: true });
    const products = await Product.findAll({ where: { is_active: true }, raw: true });

    const unitsUsed = new Set(products.map(p => UNIT_MAP[p.unit_of_measurement] || 'Nos'));

    let body = '';
    GROUP_DEFS.forEach(g => { body += groupXML(g); });
    [...unitsUsed].forEach(u => { body += unitXML(u); });
    products.forEach(p => { body += stockItemXML(p); });
    parties.forEach(p => { body += ledgerXML(p); });

    const xml = envelope(body);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=tally-masters-${new Date().toISOString().slice(0,10)}.xml`);
    res.send(xml);
  } catch (e) {
    console.error('Tally masters export error:', e);
    res.status(500).json({ error: e.message });
  }
};

/* ────────────────────────────────────────────────────────────────────────
 * File mode: GET /api/tally/export/vouchers
 *
 * Vouchers:
 *   VCHTYPE="Sales"     → <LEDGERENTRIES.LIST> party Dr, Sales Account Cr,
 *                          CGST/SGST/IGST Cr
 *   VCHTYPE="Purchase"  → Party Cr, Purchase Account Dr, GST Dr
 *   VCHTYPE="Receipt"   → Bank/Cash Dr, Party Cr
 *   VCHTYPE="Payment"   → Bank/Cash Cr, Party Dr
 *
 * We use amountDr (positive = debit, negative = credit) per Tally's convention.
 * ─────────────────────────────────────────────────────────────────────── */

function formatDate(d) {
  return String(d).replace(/-/g, '').slice(0, 8);
}

function salesVoucherXML(bill, items, supplierState, companyState) {
  const intra = supplierState && companyState && supplierState === companyState;
  const subTotal = parseFloat(bill.sub_total || 0);
  const cgstAmt = parseFloat(bill.cgst_amount || 0);
  const sgstAmt = parseFloat(bill.sgst_amount || 0);
  const igstAmt = parseFloat(bill.igst_amount || 0);
  const total = subTotal + cgstAmt + sgstAmt + igstAmt + parseFloat(bill.round_off || 0);

  let inventory = '';
  items.forEach(it => {
    inventory += `
    <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${esc(it.product_name || '')}</STOCKITEMNAME>
      <ACTUALQTY>${parseFloat(it.quantity || 0)}</ACTUALQTY>
      <BILLEDQTY>${parseFloat(it.quantity || 0)}</BILLEDQTY>
      <RATE>${parseFloat(it.rate || 0).toFixed(2)}</RATE>
      <AMOUNT>-${(parseFloat(it.quantity || 0) * parseFloat(it.rate || 0)).toFixed(2)}</AMOUNT>
    </ALLINVENTORYENTRIES.LIST>`;
  });

  const ledgerEntries = [];
  // Customer (debit total)
  ledgerEntries.push({
    ledger: bill._customer_name || 'Cash',
    amount: total,
    isDeemedPositive: 'Yes',
  });
  // Sales Account (credit subTotal)
  ledgerEntries.push({
    ledger: 'Sales Accounts',
    amount: -subTotal,
    isDeemedPositive: 'No',
  });
  // GST splits
  if (intra) {
    if (cgstAmt > 0) ledgerEntries.push({ ledger: 'CGST',  amount: -cgstAmt, isDeemedPositive: 'No' });
    if (sgstAmt > 0) ledgerEntries.push({ ledger: 'SGST',  amount: -sgstAmt, isDeemedPositive: 'No' });
  } else if (igstAmt > 0) {
    ledgerEntries.push({ ledger: 'IGST', amount: -igstAmt, isDeemedPositive: 'No' });
  }

  const ledXML = ledgerEntries.map(e => `
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${e.isDeemedPositive}</ISDEEMEDPOSITIVE>
      <AMOUNT>${e.amount.toFixed(2)}</AMOUNT>
    </LEDGERENTRIES.LIST>`).join('');

  return `<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
  <DATE>${formatDate(bill.bill_date)}</DATE>
  <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${esc(bill.bill_number)}</VOUCHERNUMBER>
  <PARTYLEDGERNAME>${esc(bill._customer_name || '')}</PARTYLEDGERNAME>
  <ISINVOICE>Yes</ISINVOICE>
  <NARRATION>Sales Bill ${esc(bill.bill_number)}</NARRATION>
  ${ledXML}
  ${inventory}
</VOUCHER>\n`;
}

exports.exportVouchers = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const dateFilter = {};
    if (from_date) dateFilter[Op.gte] = from_date;
    if (to_date) dateFilter[Op.lte] = to_date;
    const where = Object.keys(dateFilter).length ? { bill_date: dateFilter, is_cancelled: false } : { is_cancelled: false };

    const sb = await SystemSettings.findByPk(1);
    const companyState = stateOfGstin(sb?.gstin);

    const bills = await SalesBill.findAll({ where, raw: true });
    const billIds = bills.map(b => b.sales_bill_id);
    const customerIds = [...new Set(bills.map(b => b.customer_id).filter(Boolean))];

    const customers = await Party.findAll({ where: { party_id: customerIds }, raw: true });
    const customerMap = new Map(customers.map(c => [c.party_id, c]));

    const items = await SalesBillItem.findAll({ where: { sales_bill_id: billIds }, raw: true });
    const itemsByBill = new Map();
    items.forEach(it => {
      if (!itemsByBill.has(it.sales_bill_id)) itemsByBill.set(it.sales_bill_id, []);
      itemsByBill.get(it.sales_bill_id).push(it);
    });

    let body = '';
    bills.forEach(b => {
      const customer = customerMap.get(b.customer_id);
      b._customer_name = customer?.party_name || 'Cash Sales';
      const supState = stateOfGstin(customer?.gstin);
      body += salesVoucherXML(b, itemsByBill.get(b.sales_bill_id) || [], supState, companyState);
    });

    const xml = envelope(body);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=tally-vouchers-${new Date().toISOString().slice(0,10)}.xml`);
    res.send(xml);
  } catch (e) {
    console.error('Tally vouchers export error:', e);
    res.status(500).json({ error: e.message });
  }
};

/* ────────────────────────────────────────────────────────────────────────
 * File mode: POST /api/tally/import   (multipart, field 'file')
 *
 * Minimal but honest parser — extracts LEDGER, STOCKITEM, and simple VOUCHER
 * nodes via regex because the full Tally schema is vast and a real XML-DOM
 * parse has performance issues on large exports. Good enough for the common
 * masters-import flow; vouchers are extracted but mapped to a dry-run
 * preview for now (full voucher ingestion with bill-item creation is the
 * next milestone).
 * ─────────────────────────────────────────────────────────────────────── */

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// Like extractTag but also captures the attribute string of each tag's
// opening bracket — needed for <VOUCHER VCHTYPE="Sales" ACTION="Create">
// where VCHTYPE lives in attributes, not as a child element.
function extractTagWithAttrs(xml, tag) {
  const re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = {};
    const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1])) !== null) attrs[am[1].toUpperCase()] = am[2];
    out.push({ attrs, body: m[2] });
  }
  return out;
}

function readField(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

// Parse Tally's date format. Tally writes YYYYMMDD in <DATE> tags; we
// normalise to YYYY-MM-DD so Sequelize DATEONLY accepts it cleanly.
function parseTallyDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }
  // Fallback — whatever Tally version produced, try JS Date.
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Tally convention: amounts are strings like "12345.00" (positive = debit)
// or "-12345.00" (positive = credit). Bare number parse works for both.
function parseTallyAmount(raw) {
  const n = parseFloat(String(raw || '').trim());
  return isFinite(n) ? n : 0;
}

// Classify a <LEDGERENTRIES.LIST> entry into one of a few buckets based on
// ledger name. Tally installs vary wildly in how GST ledgers are named —
// some use bare "CGST", others "Output CGST @ 18%", others "CGST 9%
// Payable". We match case-insensitive substrings and take the first hit.
function classifyLedger(name) {
  if (!name) return 'other';
  const u = name.toUpperCase();
  if (u.includes('IGST')) return 'igst';
  if (u.includes('CGST')) return 'cgst';
  if (u.includes('SGST') || u.includes('UGST')) return 'sgst';
  if (u.includes('ROUND') && u.includes('OFF')) return 'roundoff';
  if (u.includes('SALES ACCOUNT') || u.includes('SALES A/C') || u === 'SALES') return 'sales';
  if (u.includes('PURCHASE ACCOUNT') || u.includes('PURCHASE A/C') || u === 'PURCHASE') return 'purchase';
  if (u.includes('CASH') || u.includes('BANK')) return 'cash_bank';
  return 'party_or_other';
}

exports.importXML = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fs = require('fs');
    const xml = fs.readFileSync(req.file.path, 'utf-8');

    const ledgers = extractTag(xml, 'LEDGER');
    const stockItems = extractTag(xml, 'STOCKITEM');
    const vouchers = extractTagWithAttrs(xml, 'VOUCHER');

    let ledgersImported = 0, stockItemsImported = 0;
    let vouchersImported = 0;
    const errors = [];

    // Ledgers → Parties
    for (const block of ledgers) {
      try {
        const name = readField(block, 'NAME');
        if (!name) continue;
        const parent = readField(block, 'PARENT').toLowerCase();
        if (!/debtor|creditor/.test(parent)) continue; // Skip non-party ledgers
        const partyType = parent.includes('debtor') ? 'Customer' : 'Supplier';
        const gstin = readField(block, 'GSTIN');
        const openBal = parseFloat(readField(block, 'OPENINGBALANCE') || 0);
        const state = readField(block, 'LEDSTATENAME');
        const mobile = readField(block, 'LEDGERMOBILE') || readField(block, 'LEDGERCONTACT') || '0000000000';
        const email = readField(block, 'LEDGEREMAIL');

        await Party.findOrCreate({
          where: { party_name: name },
          defaults: {
            party_type: partyType,
            party_name: name,
            mobile_1: mobile,
            email: email || null,
            gstin: gstin || null,
            state: state || null,
            opening_balance: Math.abs(openBal),
            opening_balance_type: openBal < 0 ? 'Payable' : 'Receivable',
            created_by: req.user?.user_id || null,
          },
        });
        ledgersImported++;
      } catch (e) {
        errors.push({ type: 'ledger', reason: e.message });
      }
    }

    // Stock Items → Products
    const { generateBarcode } = require('../utils/barcode');
    const { Category } = require('../models');
    const [defaultCat] = await Category.findOrCreate({
      where: { category_name: 'Imported from Tally' },
      defaults: { category_name: 'Imported from Tally' },
    });

    for (const block of stockItems) {
      try {
        const name = readField(block, 'NAME');
        if (!name) continue;
        const hsn = readField(block, 'HSNCODE');
        const gstRate = parseFloat(readField(block, 'GSTRATE') || 0);
        const barcode = readField(block, 'BARCODE') || await generateBarcode();
        const unit = readField(block, 'BASEUNITS').toUpperCase();
        const mapUnit = { NOS: 'PCS', KGS: 'KG', MTRS: 'METER', LTRS: 'LITER', BOX: 'BOX', DOZ: 'DOZEN' };
        const uom = mapUnit[unit] || 'PCS';

        await Product.findOrCreate({
          where: { product_name: name },
          defaults: {
            barcode,
            category_id: defaultCat.category_id,
            product_name: name,
            hsn_code: hsn || null,
            gst_rate: gstRate,
            unit_of_measurement: uom,
          },
        });
        stockItemsImported++;
      } catch (e) {
        errors.push({ type: 'stockitem', reason: e.message });
      }
    }

    // Vouchers → Sales Bills / Purchase Bills / Receipts / Payments.
    // Masters must already be in place, so we run this AFTER ledgers +
    // stock items above. Each voucher is inserted under its own
    // transaction so a half-parsed inventory block never leaves a
    // partial bill in the DB.
    //
    // Idempotency: bill_number / transaction_number are unique. Pre-fetch
    // the existing keys in one query per voucher-type for O(1) "skip
    // duplicate" checks inside the loop.
    const existingSales    = new Set((await SalesBill.findAll({ attributes: ['bill_number'], raw: true })).map(b => b.bill_number));
    const existingPurchase = new Set((await PurchaseBill.findAll({ attributes: ['bill_number'], raw: true })).map(b => b.bill_number));
    const existingTxn      = new Set((await PaymentReceipt.findAll({ attributes: ['transaction_number'], raw: true })).map(r => r.transaction_number));

    for (const { attrs, body } of vouchers) {
      try {
        const vchtype = (attrs.VCHTYPE || readField(body, 'VOUCHERTYPENAME') || '').toLowerCase();
        const voucherNumber = readField(body, 'VOUCHERNUMBER');
        if (!voucherNumber) {
          errors.push({ type: 'voucher', reason: 'Missing VOUCHERNUMBER' });
          continue;
        }

        const billDate = parseTallyDate(readField(body, 'DATE'));
        if (!billDate) {
          errors.push({ type: 'voucher', reason: `Voucher ${voucherNumber}: unparseable <DATE>` });
          continue;
        }

        const partyName = readField(body, 'PARTYLEDGERNAME') || readField(body, 'PARTYNAME');
        const narration = readField(body, 'NARRATION');

        // Parse LEDGERENTRIES so we can compute GST / sales-account / party
        // amounts regardless of which voucher type we're handling.
        const ledgerEntries = extractTag(body, 'LEDGERENTRIES.LIST').map(block => ({
          name:   readField(block, 'LEDGERNAME'),
          amount: parseTallyAmount(readField(block, 'AMOUNT')),
          isDeemedPositive: /yes/i.test(readField(block, 'ISDEEMEDPOSITIVE')),
        }));

        // Parse ALLINVENTORYENTRIES for sales/purchase bills.
        const inventoryEntries = extractTag(body, 'ALLINVENTORYENTRIES.LIST').map(block => ({
          stockItem: readField(block, 'STOCKITEMNAME'),
          qty:       parseFloat(String(readField(block, 'ACTUALQTY') || readField(block, 'BILLEDQTY') || '0').replace(/[^\d.-]/g, '')) || 0,
          rate:      parseFloat(String(readField(block, 'RATE') || '0').replace(/[^\d.-]/g, '')) || 0,
          amount:    parseTallyAmount(readField(block, 'AMOUNT')),
        }));

        // Helper: aggregate signed amounts from classified ledgers. We use
        // abs() because downstream bills store positive tax amounts and the
        // sign is conveyed by the voucher type + accounting direction.
        const totalFor = (bucket) => ledgerEntries
          .filter(e => classifyLedger(e.name) === bucket)
          .reduce((s, e) => s + Math.abs(e.amount), 0);

        const cgstAmt = totalFor('cgst');
        const sgstAmt = totalFor('sgst');
        const igstAmt = totalFor('igst');
        const roundOff = ledgerEntries
          .filter(e => classifyLedger(e.name) === 'roundoff')
          .reduce((s, e) => s + e.amount, 0); // sign matters on round-off

        /* ── Sales voucher ─────────────────────────────────────────────── */
        if (vchtype.includes('sales') && !vchtype.includes('return')) {
          if (existingSales.has(voucherNumber)) {
            errors.push({ type: 'voucher', reason: `Sales voucher ${voucherNumber}: duplicate bill number, skipped` });
            continue;
          }
          const customer = partyName ? await Party.findOne({ where: { party_name: partyName, party_type: { [Op.in]: ['Customer', 'Both'] } } }) : null;
          if (!customer) {
            errors.push({ type: 'voucher', reason: `Sales voucher ${voucherNumber}: customer '${partyName}' not found — import its Ledger first` });
            continue;
          }

          // Resolve every inventory line to a local product — abort the
          // whole voucher if any one is missing, rather than inserting a
          // half-represented bill.
          const resolved = [];
          let missingItem = null;
          for (const inv of inventoryEntries) {
            const product = await Product.findOne({ where: { product_name: inv.stockItem } });
            if (!product) { missingItem = inv.stockItem; break; }
            resolved.push({ product, ...inv });
          }
          if (missingItem) {
            errors.push({ type: 'voucher', reason: `Sales voucher ${voucherNumber}: product '${missingItem}' not found — import Stock Items first` });
            continue;
          }

          const subTotal = resolved.reduce((s, it) => s + it.qty * it.rate, 0);
          const totalAmt = subTotal + cgstAmt + sgstAmt + igstAmt + roundOff;

          await sequelize.transaction(async (t) => {
            const bill = await SalesBill.create({
              bill_number: voucherNumber,
              customer_id: customer.party_id,
              bill_date: billDate,
              total_items: resolved.length,
              total_quantity: resolved.reduce((s, it) => s + it.qty, 0),
              sub_total: subTotal,
              cgst_amount: cgstAmt, sgst_amount: sgstAmt, igst_amount: igstAmt,
              round_off: roundOff,
              total_amount: totalAmt,
              balance_amount: totalAmt,
              payment_status: 'Unpaid',
              remarks: narration || null,
              created_by: req.user?.user_id || null,
            }, { transaction: t });
            await SalesBillItem.bulkCreate(resolved.map(r => ({
              sales_bill_id: bill.sales_bill_id,
              product_id: r.product.product_id,
              barcode: r.product.barcode,
              product_name: r.product.product_name,
              category_id: r.product.category_id,
              hsn_code: r.product.hsn_code,
              quantity: r.qty,
              rate: r.rate,
              cost_rate: r.product.purchase_rate || 0,
              gst_rate: r.product.gst_rate || 0,
              taxable_amount: r.qty * r.rate,
              total_amount: r.qty * r.rate,
              quantity_per_box: r.product.quantity_per_box || 1,
            })), { transaction: t });
          });
          existingSales.add(voucherNumber);
          vouchersImported++;
          continue;
        }

        /* ── Purchase voucher ──────────────────────────────────────────── */
        if (vchtype.includes('purchase') && !vchtype.includes('return')) {
          if (existingPurchase.has(voucherNumber)) {
            errors.push({ type: 'voucher', reason: `Purchase voucher ${voucherNumber}: duplicate bill number, skipped` });
            continue;
          }
          const supplier = partyName ? await Party.findOne({ where: { party_name: partyName, party_type: { [Op.in]: ['Supplier', 'Both'] } } }) : null;
          if (!supplier) {
            errors.push({ type: 'voucher', reason: `Purchase voucher ${voucherNumber}: supplier '${partyName}' not found` });
            continue;
          }

          const resolved = [];
          let missingItem = null;
          for (const inv of inventoryEntries) {
            const product = await Product.findOne({ where: { product_name: inv.stockItem } });
            if (!product) { missingItem = inv.stockItem; break; }
            resolved.push({ product, ...inv });
          }
          if (missingItem) {
            errors.push({ type: 'voucher', reason: `Purchase voucher ${voucherNumber}: product '${missingItem}' not found` });
            continue;
          }

          const subTotal = resolved.reduce((s, it) => s + it.qty * it.rate, 0);
          const totalAmt = subTotal + cgstAmt + sgstAmt + igstAmt + roundOff;

          await sequelize.transaction(async (t) => {
            const bill = await PurchaseBill.create({
              bill_number: voucherNumber,
              supplier_id: supplier.party_id,
              bill_date: billDate,
              total_items: resolved.length,
              total_quantity: resolved.reduce((s, it) => s + it.qty, 0),
              sub_total: subTotal,
              cgst_amount: cgstAmt, sgst_amount: sgstAmt, igst_amount: igstAmt,
              round_off: roundOff,
              total_amount: totalAmt,
              balance_amount: totalAmt,
              payment_status: 'Unpaid',
              remarks: narration || null,
              created_by: req.user?.user_id || null,
            }, { transaction: t });
            await PurchaseBillItem.bulkCreate(resolved.map(r => ({
              purchase_bill_id: bill.purchase_bill_id,
              product_id: r.product.product_id,
              barcode: r.product.barcode,
              product_name: r.product.product_name,
              hsn_code: r.product.hsn_code,
              quantity: r.qty,
              purchase_rate: r.rate,
              gst_rate: r.product.gst_rate || 0,
              taxable_amount: r.qty * r.rate,
              total_amount: r.qty * r.rate,
              quantity_per_box: r.product.quantity_per_box || 1,
            })), { transaction: t });
          });
          existingPurchase.add(voucherNumber);
          vouchersImported++;
          continue;
        }

        /* ── Receipt / Payment voucher ─────────────────────────────────── */
        if (vchtype.includes('receipt') || vchtype.includes('payment')) {
          const txnType = vchtype.includes('receipt') ? 'Receipt' : 'Payment';
          if (existingTxn.has(voucherNumber)) {
            errors.push({ type: 'voucher', reason: `${txnType} voucher ${voucherNumber}: duplicate transaction number, skipped` });
            continue;
          }
          const party = partyName ? await Party.findOne({
            where: { party_name: partyName,
              party_type: { [Op.in]: txnType === 'Receipt' ? ['Customer', 'Both'] : ['Supplier', 'Both'] } },
          }) : null;
          if (!party) {
            errors.push({ type: 'voucher', reason: `${txnType} voucher ${voucherNumber}: party '${partyName}' not found` });
            continue;
          }
          // Amount = absolute value of the party ledger entry, which is
          // what Tally credits (for Receipt) or debits (for Payment).
          const partyEntry = ledgerEntries.find(e => e.name === partyName);
          const amount = partyEntry ? Math.abs(partyEntry.amount) : 0;
          if (!(amount > 0)) {
            errors.push({ type: 'voucher', reason: `${txnType} voucher ${voucherNumber}: zero amount on party ledger` });
            continue;
          }
          await PaymentReceipt.create({
            transaction_number: voucherNumber,
            transaction_type: txnType,
            transaction_date: billDate,
            party_id: party.party_id,
            total_amount: amount,
            remarks: narration || null,
            created_by: req.user?.user_id || null,
          });
          existingTxn.add(voucherNumber);
          vouchersImported++;
          continue;
        }

        // Voucher type we don't handle (Journal / Contra / Return etc.) —
        // surface it so the user knows we saw it but didn't ingest.
        errors.push({ type: 'voucher', reason: `Voucher ${voucherNumber}: unsupported VCHTYPE '${vchtype}' (skipped)` });
      } catch (e) {
        errors.push({ type: 'voucher', reason: e.message });
      }
    }

    // Delete the temp upload
    try { fs.unlinkSync(req.file.path); } catch {}

    res.json({
      ledgers_imported: ledgersImported,
      stockitems_imported: stockItemsImported,
      vouchers_imported: vouchersImported,
      vouchers_previewed: vouchers.length,
      errors,
    });
  } catch (e) {
    console.error('Tally XML import error:', e);
    res.status(500).json({ error: e.message });
  }
};

/* ────────────────────────────────────────────────────────────────────────
 * Live mode: POST /api/tally/live/push and /api/tally/live/pull
 *
 * Minimal implementations — push POSTs the masters XML, pull fetches
 * "List of Ledgers" and feeds it through the same parser used by file
 * import. Response parsing surfaces Tally's <CREATED>/<ALTERED>/etc.
 * counts when present.
 * ─────────────────────────────────────────────────────────────────────── */

async function getTallyConfig() {
  const s = await SystemSettings.findByPk(1);
  return {
    host: s?.tally_host || 'localhost',
    port: s?.tally_port || 9000,
    company: s?.tally_company || '',
  };
}

exports.livePush = async (req, res) => {
  try {
    const cfg = await getTallyConfig();
    // Reuse the masters XML generator.
    const parties = await Party.findAll({ where: { is_active: true }, raw: true });
    const products = await Product.findAll({ where: { is_active: true }, raw: true });
    const unitsUsed = new Set(products.map(p => UNIT_MAP[p.unit_of_measurement] || 'Nos'));

    let body = '';
    GROUP_DEFS.forEach(g => { body += groupXML(g); });
    [...unitsUsed].forEach(u => { body += unitXML(u); });
    products.forEach(p => { body += stockItemXML(p); });
    parties.forEach(p => { body += ledgerXML(p); });
    const xml = envelope(body);

    const { status, body: respBody } = await postTallyXML({ host: cfg.host, port: cfg.port, xml });

    // Parse Tally's response counts if present
    const pick = (tag) => {
      const m = respBody.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? parseInt(m[1], 10) || 0 : 0;
    };

    // Update last-sync timestamp on success
    if (status === 200) {
      await SystemSettings.update({ tally_last_sync: new Date() }, { where: { setting_id: 1 } });
    }

    res.json({
      status,
      created: pick('CREATED'),
      altered: pick('ALTERED'),
      ignored: pick('IGNORED'),
      errors: pick('LINEERROR'),
      raw_preview: respBody.slice(0, 800),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

exports.livePull = async (req, res) => {
  try {
    const cfg = await getTallyConfig();
    const { from_date, to_date } = req.body || {};

    const fetch = async (id) => {
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${esc(id)}</ID></HEADER>` +
        `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
        (cfg.company ? `<SVCURRENTCOMPANY>${esc(cfg.company)}</SVCURRENTCOMPANY>` : '') +
        (from_date ? `<SVFROMDATE>${formatDate(from_date)}</SVFROMDATE>` : '') +
        (to_date ? `<SVTODATE>${formatDate(to_date)}</SVTODATE>` : '') +
        `</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
      const { status, body } = await postTallyXML({ host: cfg.host, port: cfg.port, xml });
      if (status !== 200) throw new Error(`Tally returned HTTP ${status}`);
      return body;
    };

    const ledgersXML = await fetch('List of Ledgers');
    const stockXML = await fetch('List of Stock Items');

    // Count masters via the same regex we use for file imports.
    const ledgers = extractTag(ledgersXML, 'LEDGER');
    const stockItems = extractTag(stockXML, 'STOCKITEM');

    // Update last-sync on success
    await SystemSettings.update({ tally_last_sync: new Date() }, { where: { setting_id: 1 } });

    res.json({
      ledgers: ledgers.length,
      stockitems: stockItems.length,
      vouchers: 0,      // Day Book parsing is follow-up work
      conflicts: 0,     // Conflict detection is follow-up work
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

exports.getSyncLogs = async (req, res) => {
  // Sync-log table not yet created (follow-up milestone).
  res.json({ logs: [] });
};
