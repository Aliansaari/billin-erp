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

// Tag-name boundary: the opening tag must be `<TAG>` or `<TAG ` (attrs
// start with whitespace). Without this, the old `<${tag}[^>]*>` pattern
// happily matched `<NAME.LIST>` while looking for `<NAME>` or `<PARENTID>`
// while looking for `<PARENT>` — so product names landed in the DB with
// literal `<NAME>` prefixes and "Sundry Debtors" never matched the PARENT
// check, dropping every ledger on the floor.
const TAG_BOUNDARY = '(?:\\s[^>]*)?';

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}${TAG_BOUNDARY}>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// Like extractTag but also captures the attribute string of each tag's
// opening bracket — needed for <VOUCHER VCHTYPE="Sales" ACTION="Create">
// where VCHTYPE lives in attributes, not as a child element.
function extractTagWithAttrs(xml, tag) {
  const re = new RegExp(`<${tag}((?:\\s[^>]*)?)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
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
  const m = block.match(new RegExp(`<${tag}${TAG_BOUNDARY}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

// Tally writes rates as "5000/PCS", "12.50/NOS", or plain "5000". Strip
// anything after the first non-numeric/decimal char so DECIMAL columns
// don't NaN-out on insert.
function parseTallyRate(raw) {
  if (!raw) return 0;
  const m = String(raw).replace(',', '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

// Tally's <STANDARDPRICELIST.LIST> / <STANDARDCOSTLIST.LIST> wrap a series
// of <STANDARDPRICEDETAILS.LIST> each with <RATE>. We take the LATEST
// (last) one — Tally appends new rate slabs by date, so the tail is the
// currently-effective rate.
function readLastRateFromPriceList(block, listTag) {
  const lists = extractTag(block, listTag);
  if (!lists.length) return 0;
  const rates = extractTag(lists[lists.length - 1], 'RATE');
  if (!rates.length) return 0;
  return parseTallyRate(rates[rates.length - 1]);
}

// Join ADDRESS.LIST children into a comma-separated string for display.
function readAddressList(block) {
  const lists = extractTag(block, 'ADDRESS.LIST');
  if (!lists.length) return '';
  return extractTag(lists[0], 'ADDRESS').map(a => a.trim()).filter(Boolean).join(', ');
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

// Ledgers → Parties. Idempotent via findOrCreate on party_name.
// Skips non-party ledgers (income, expense, tax, etc.) by checking PARENT
// contains "Debtor" / "Creditor".
async function ingestLedgersFromXml(xml, userId) {
  const ledgers = extractTag(xml, 'LEDGER');
  let imported = 0;
  const errors = [];
  for (const block of ledgers) {
    try {
      const name = readField(block, 'NAME');
      if (!name) continue;
      const parent = readField(block, 'PARENT').toLowerCase();
      if (!/debtor|creditor/.test(parent)) continue;
      const partyType = parent.includes('debtor') ? 'Customer' : 'Supplier';
      const gstin = readField(block, 'GSTIN') || readField(block, 'PARTYGSTIN');
      const openBal = parseFloat(readField(block, 'OPENINGBALANCE') || 0);
      const state = readField(block, 'LEDSTATENAME');
      const pin = readField(block, 'PINCODE');
      const country = readField(block, 'COUNTRYOFRESIDENCE') || readField(block, 'LEDGERPHONE.COUNTRY') || 'India';
      const mobile = readField(block, 'LEDGERMOBILE') || readField(block, 'LEDGERCONTACT') || '';
      const email = readField(block, 'LEDGEREMAIL') || readField(block, 'EMAIL');
      const pan = readField(block, 'INCOMETAXNUMBER') || readField(block, 'PANNUMBER');
      const creditLimit = parseTallyRate(readField(block, 'CREDITLIMIT'));
      const creditDays = parseInt(readField(block, 'CREDITPERIOD'), 10) || 0;
      const address = readAddressList(block);

      const [, created] = await Party.findOrCreate({
        where: { party_name: name },
        defaults: {
          party_type: partyType,
          party_name: name,
          mobile_1: mobile || '0000000000',
          email: email || null,
          gstin: gstin || null,
          pan_number: pan || null,
          address_line1: address || null,
          state: state || null,
          pincode: pin || null,
          country: country || 'India',
          credit_allowed: creditLimit > 0 || creditDays > 0,
          credit_limit: creditLimit,
          credit_days: creditDays,
          opening_balance: Math.abs(openBal),
          opening_balance_type: openBal < 0 ? 'Payable' : 'Receivable',
          created_by: userId,
        },
      });
      if (created) imported++;
    } catch (e) {
      errors.push({ type: 'ledger', reason: e.message, name: readField(block, 'NAME') });
    }
  }
  return { imported, errors, seen: ledgers.length };
}

// Stock Summary report (StkSum.xml) → Products. Tally's Stock Summary is
// a display report, not a master export: rows come as sibling
// <DSPACCNAME>…<DSPSTKINFO>… pairs using `DSP*` tags instead of `NAME` /
// `OPENINGBALANCE`. If the XML uploaded by the user is a Stock Summary
// rather than a Masters export, the normal STOCKITEM parser returns zero
// and we fall through to this path so rates + on-hand qty still land.
async function ingestStockSummaryFromXml(xml) {
  // Walk the tags in document order so each DSPACCNAME pairs with the
  // DSPSTKINFO that follows it.
  const rowRe = /<(DSPACCNAME|DSPSTKINFO)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  const rows = [];
  let m;
  while ((m = rowRe.exec(xml)) !== null) rows.push({ tag: m[1].toUpperCase(), body: m[2] });
  if (!rows.length) return { imported: 0, errors: [], seen: 0 };

  const { generateBarcode } = require('../utils/barcode');
  const { Category } = require('../models');
  const [defaultCat] = await Category.findOrCreate({
    where: { category_name: 'Imported from Tally' },
    defaults: { category_name: 'Imported from Tally' },
  });

  let imported = 0;
  let seen = 0;
  const errors = [];
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].tag !== 'DSPACCNAME' || rows[i + 1].tag !== 'DSPSTKINFO') continue;
    seen++;
    try {
      const name = readField(rows[i].body, 'DSPDISPNAME');
      if (!name) continue;
      const info = rows[i + 1].body;
      const qty = parseTallyRate(readField(info, 'DSPCLQTY'));
      const rate = parseTallyRate(readField(info, 'DSPCLRATE'));
      // DSPCLAMTA is typically negative in Tally's stock summary (credit
      // convention on inventory). Keep unsigned abs for the DB.
      const [, created] = await Product.findOrCreate({
        where: { product_name: name },
        defaults: {
          product_name: name,
          category_id: defaultCat.category_id,
          barcode: await generateBarcode(),
          unit_of_measurement: 'PCS',
          gst_rate: 0,
          opening_stock: qty,
          current_stock: qty,
          opening_stock_rate: rate,
          purchase_rate: rate,
          sale_rate: rate,
          mrp: rate,
        },
      });
      if (created) imported++;
    } catch (e) {
      errors.push({ type: 'stocksum', reason: e.message });
    }
    i++;  // jump over the consumed DSPSTKINFO
  }
  return { imported, errors, seen };
}

// Stock Items → Products. Idempotent via findOrCreate on product_name.
// Auto-creates the "Imported from Tally" category on first run so imported
// items have a home without forcing the user to pick one upfront.
async function ingestStockItemsFromXml(xml) {
  const stockItems = extractTag(xml, 'STOCKITEM');
  const { generateBarcode } = require('../utils/barcode');
  const { Category } = require('../models');
  const [defaultCat] = await Category.findOrCreate({
    where: { category_name: 'Imported from Tally' },
    defaults: { category_name: 'Imported from Tally' },
  });
  // Tally units → our ENUM. Unknown units fall back to PCS (documented in
  // the ENUM in Product.js: PCS/KG/METER/LITER/BOX/DOZEN).
  const mapUnit = { NOS: 'PCS', PCS: 'PCS', KGS: 'KG', KG: 'KG',
                    MTRS: 'METER', MTR: 'METER', M: 'METER',
                    LTRS: 'LITER', LTR: 'LITER', L: 'LITER',
                    BOX: 'BOX', BOXES: 'BOX',
                    DOZ: 'DOZEN', DOZEN: 'DOZEN' };
  let imported = 0;
  const errors = [];
  for (const block of stockItems) {
    try {
      const name = readField(block, 'NAME');
      if (!name) continue;
      const hsn = readField(block, 'HSNCODE') || readField(block, 'GSTHSNCODE');
      const gstRate = parseFloat(readField(block, 'GSTRATE') || readField(block, 'IGSTRATE') || 0) || 0;
      const barcode = readField(block, 'BARCODE') || readField(block, 'PARTNUMBER') || await generateBarcode();
      const unit = (readField(block, 'BASEUNITS') || readField(block, 'ADDITIONALUNITS')).toUpperCase();
      const uom = mapUnit[unit] || 'PCS';

      // Opening stock: Tally reports qty as "100 PCS" or bare "100".
      const openingStock = parseTallyRate(readField(block, 'OPENINGBALANCE'));
      const openingRate = parseTallyRate(readField(block, 'OPENINGRATE'));
      // Closing balance/rate come from our Live Mode TDL (FETCH includes
      // ClosingBalance / ClosingRate / ClosingValue). Prefer them over the
      // opening snapshot when present — they represent "what's in stock
      // right now" as Tally sees it, which is what the ERP stock report
      // should show.
      const closingStock = parseTallyRate(readField(block, 'CLOSINGBALANCE'));
      const closingRate = parseTallyRate(readField(block, 'CLOSINGRATE'));
      const lastCostPrice = parseTallyRate(readField(block, 'LASTCOSTPRICE') || readField(block, 'COSTPRICE'));
      // Prefer the standard price list (selling) → last entry = current rate.
      // Fall back to LASTSELLINGPRICE if the price list is empty.
      const saleRate = readLastRateFromPriceList(block, 'STANDARDPRICELIST.LIST')
                    || parseTallyRate(readField(block, 'LASTSELLINGPRICE'))
                    || closingRate;
      const purchaseRate = openingRate || lastCostPrice
                        || readLastRateFromPriceList(block, 'STANDARDCOSTLIST.LIST')
                        || closingRate;
      const mrp = parseTallyRate(readField(block, 'MRPRATE') || readField(block, 'MAXIMUMRETAILPRICE'));
      const description = readField(block, 'DESCRIPTION');
      const article = readField(block, 'PARTNUMBER') || readField(block, 'ALIAS');
      const onHand = closingStock || openingStock;

      const [, created] = await Product.findOrCreate({
        where: { product_name: name },
        defaults: {
          barcode,
          category_id: defaultCat.category_id,
          product_name: name,
          product_description: description || null,
          article_number: article || null,
          hsn_code: hsn || null,
          gst_rate: gstRate,
          unit_of_measurement: uom,
          opening_stock: openingStock,
          opening_stock_rate: purchaseRate || 0,
          current_stock: onHand,
          purchase_rate: purchaseRate || 0,
          sale_rate: saleRate || 0,
          mrp: mrp || saleRate || 0,
        },
      });
      if (created) imported++;
    } catch (e) {
      errors.push({ type: 'stockitem', reason: e.message, name: readField(block, 'NAME') });
    }
  }
  return { imported, errors, seen: stockItems.length };
}

// Tally exports XML files in UTF-16 LE (BOM: FF FE) by default — reading
// them with `utf-8` leaves null bytes wedged between every character, so
// no tag regex matches and the import silently lands zero rows. Detect the
// BOM and decode accordingly; fall back to UTF-8 for files from other
// sources (our own re-exports, hand-edited samples).
function decodeXmlBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    // UTF-16 BE — Node only has utf16le, so byte-swap first.
    return Buffer.from(buf.slice(2)).swap16().toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf-8');
  }
  // Heuristic: if more than half the first 128 bytes are 0x00, treat as
  // UTF-16 LE without BOM — some Tally installations strip the BOM.
  if (buf.length >= 128) {
    let zeroCount = 0;
    for (let i = 1; i < 128; i += 2) if (buf[i] === 0x00) zeroCount++;
    if (zeroCount > 40) return buf.toString('utf16le');
  }
  return buf.toString('utf-8');
}

// Vouchers → Sales / Purchase / Receipt / Payment rows. Each voucher goes
// in its own DB transaction so a half-parsed inventory block can't leave a
// partial bill. Missing parties/products are auto-created as stubs so the
// user can upload transactions without having to pre-populate masters.
async function ingestVouchersFromXml(xml, userId) {
  const vouchers = extractTagWithAttrs(xml, 'VOUCHER');
  let imported = 0;
  const errors = [];

  // Idempotency caches — bill_number / transaction_number are unique, so
  // one pre-fetch per voucher-type is enough for O(1) "skip duplicate".
  const existingSales    = new Set((await SalesBill.findAll({ attributes: ['bill_number'], raw: true })).map(b => b.bill_number));
  const existingPurchase = new Set((await PurchaseBill.findAll({ attributes: ['bill_number'], raw: true })).map(b => b.bill_number));
  const existingTxn      = new Set((await PaymentReceipt.findAll({ attributes: ['transaction_number'], raw: true })).map(r => r.transaction_number));

  // Stub-master auto-create: Tally transaction exports frequently arrive
  // without masters. Rather than fail the voucher, we spin up a minimal
  // Party / Product with whatever the line gives us (party name; product
  // name + line rate). Caches prevent duplicate queries inside one pass.
  const { generateBarcode } = require('../utils/barcode');
  const { Category } = require('../models');
  const [tallyCat] = await Category.findOrCreate({
    where: { category_name: 'Imported from Tally' },
    defaults: { category_name: 'Imported from Tally' },
  });
  const partyCache   = new Map();
  const productCache = new Map();

  const resolveParty = async (name, preferredType) => {
    if (!name) return null;
    if (partyCache.has(name)) return partyCache.get(name);
    let party = await Party.findOne({ where: { party_name: name } });
    if (!party) {
      party = await Party.create({
        party_name: name,
        party_type: preferredType,
        mobile_1: '0000000000',
        created_by: userId,
      });
    } else if (preferredType && party.party_type !== preferredType && party.party_type !== 'Both') {
      // Existing row is Customer but we need Supplier (or vice versa) —
      // promote to 'Both' so both voucher-types can link it.
      await party.update({ party_type: 'Both' });
    }
    partyCache.set(name, party);
    return party;
  };
  const resolveProduct = async (name, hintedRate) => {
    if (!name) return null;
    if (productCache.has(name)) return productCache.get(name);
    let product = await Product.findOne({ where: { product_name: name } });
    if (!product) {
      product = await Product.create({
        product_name: name,
        category_id: tallyCat.category_id,
        barcode: await generateBarcode(),
        unit_of_measurement: 'PCS',
        gst_rate: 0,
        purchase_rate: hintedRate || 0,
        sale_rate: hintedRate || 0,
        mrp: hintedRate || 0,
      });
    }
    productCache.set(name, product);
    return product;
  };

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

      // Tally uses two different tag names for ledger postings depending on
      // voucher type:
      //   • Sales / Purchase (invoice mode)     → <LEDGERENTRIES.LIST>
      //   • Payment / Receipt / Contra / Journal → <ALLLEDGERENTRIES.LIST>
      // Previously we read only the first — so every Payment voucher had
      // zero ledgerEntries and bailed with "zero amount on party ledger".
      const ledgerEntries = [
        ...extractTag(body, 'LEDGERENTRIES.LIST'),
        ...extractTag(body, 'ALLLEDGERENTRIES.LIST'),
      ].map(block => ({
        name:   readField(block, 'LEDGERNAME'),
        amount: parseTallyAmount(readField(block, 'AMOUNT')),
        isDeemedPositive: /yes/i.test(readField(block, 'ISDEEMEDPOSITIVE')),
      }));

      const inventoryEntries = extractTag(body, 'ALLINVENTORYENTRIES.LIST').map(block => ({
        stockItem: readField(block, 'STOCKITEMNAME'),
        qty:       parseFloat(String(readField(block, 'ACTUALQTY') || readField(block, 'BILLEDQTY') || '0').replace(/[^\d.-]/g, '')) || 0,
        rate:      parseFloat(String(readField(block, 'RATE') || '0').replace(/[^\d.-]/g, '')) || 0,
        amount:    parseTallyAmount(readField(block, 'AMOUNT')),
      }));

      // Tax bucket aggregation — abs() because bills store positive tax
      // amounts; sign is implicit in the voucher-type + accounting direction.
      const totalFor = (bucket) => ledgerEntries
        .filter(e => classifyLedger(e.name) === bucket)
        .reduce((s, e) => s + Math.abs(e.amount), 0);
      const cgstAmt = totalFor('cgst');
      const sgstAmt = totalFor('sgst');
      const igstAmt = totalFor('igst');
      const roundOff = ledgerEntries
        .filter(e => classifyLedger(e.name) === 'roundoff')
        .reduce((s, e) => s + e.amount, 0);

      /* ── Sales voucher ─────────────────────────────────────────────── */
      if (vchtype.includes('sales') && !vchtype.includes('return')) {
        if (existingSales.has(voucherNumber)) {
          errors.push({ type: 'voucher', reason: `Sales voucher ${voucherNumber}: duplicate bill number, skipped` });
          continue;
        }
        const customer = await resolveParty(partyName, 'Customer');
        if (!customer) {
          errors.push({ type: 'voucher', reason: `Sales voucher ${voucherNumber}: missing <PARTYLEDGERNAME>` });
          continue;
        }
        const resolved = [];
        for (const inv of inventoryEntries) {
          const product = await resolveProduct(inv.stockItem, inv.rate);
          if (product) resolved.push({ product, ...inv });
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
            created_by: userId,
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
        imported++;
        continue;
      }

      /* ── Purchase voucher ──────────────────────────────────────────── */
      if (vchtype.includes('purchase') && !vchtype.includes('return')) {
        if (existingPurchase.has(voucherNumber)) {
          errors.push({ type: 'voucher', reason: `Purchase voucher ${voucherNumber}: duplicate bill number, skipped` });
          continue;
        }
        const supplier = await resolveParty(partyName, 'Supplier');
        if (!supplier) {
          errors.push({ type: 'voucher', reason: `Purchase voucher ${voucherNumber}: missing <PARTYLEDGERNAME>` });
          continue;
        }
        const resolved = [];
        for (const inv of inventoryEntries) {
          const product = await resolveProduct(inv.stockItem, inv.rate);
          if (product) resolved.push({ product, ...inv });
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
            created_by: userId,
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
        imported++;
        continue;
      }

      /* ── Receipt / Payment voucher ─────────────────────────────────── */
      if (vchtype.includes('receipt') || vchtype.includes('payment')) {
        const txnType = vchtype.includes('receipt') ? 'Receipt' : 'Payment';
        // Tally numbers Payment and Receipt vouchers in separate series —
        // both start at "1". Our PaymentReceipt.transaction_number has a
        // global unique index, so an unprefixed "1" would collide across
        // types. Prefix with type initial to keep them disjoint while
        // still readable (and reversible — the suffix is the original
        // Tally voucher number).
        const key = `${txnType === 'Receipt' ? 'RCT' : 'PMT'}-${voucherNumber}`;
        if (existingTxn.has(key)) {
          errors.push({ type: 'voucher', reason: `${txnType} voucher ${voucherNumber}: duplicate transaction number, skipped` });
          continue;
        }
        const party = await resolveParty(partyName, txnType === 'Receipt' ? 'Customer' : 'Supplier');
        if (!party) {
          errors.push({ type: 'voucher', reason: `${txnType} voucher ${voucherNumber}: missing <PARTYLEDGERNAME>` });
          continue;
        }
        const partyEntry = ledgerEntries.find(e => e.name === partyName);
        const amount = partyEntry ? Math.abs(partyEntry.amount) : 0;
        if (!(amount > 0)) {
          errors.push({ type: 'voucher', reason: `${txnType} voucher ${voucherNumber}: zero amount on party ledger` });
          continue;
        }
        await PaymentReceipt.create({
          transaction_number: key,
          transaction_type: txnType,
          transaction_date: billDate,
          party_id: party.party_id,
          total_amount: amount,
          remarks: narration || null,
          created_by: userId,
        });
        existingTxn.add(key);
        imported++;
        continue;
      }

      // Unsupported voucher type (Journal / Contra / Return etc.) — surface
      // so the user knows we saw it but didn't ingest.
      errors.push({ type: 'voucher', reason: `Voucher ${voucherNumber}: unsupported VCHTYPE '${vchtype}' (skipped)` });
    } catch (e) {
      errors.push({ type: 'voucher', reason: e.message });
    }
  }

  return { imported, errors, seen: vouchers.length };
}

exports.importXML = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fs = require('fs');
    const xml = decodeXmlBuffer(fs.readFileSync(req.file.path));

    const errors = [];

    const ledgerRes = await ingestLedgersFromXml(xml, req.user?.user_id || null);
    errors.push(...ledgerRes.errors);

    let stockRes = await ingestStockItemsFromXml(xml);
    errors.push(...stockRes.errors);
    // Fallback: if the file is a Stock Summary report (StkSum.xml) instead
    // of a masters export, the STOCKITEM parser finds nothing. Re-parse
    // the display-tag format so rates + on-hand qty still ingest.
    if (stockRes.seen === 0) {
      const summaryRes = await ingestStockSummaryFromXml(xml);
      if (summaryRes.seen > 0) {
        stockRes = summaryRes;
        errors.push(...summaryRes.errors);
      }
    }

    const voucherRes = await ingestVouchersFromXml(xml, req.user?.user_id || null);
    errors.push(...voucherRes.errors);

    // Delete the temp upload
    try { fs.unlinkSync(req.file.path); } catch {}

    res.json({
      ledgers_imported: ledgerRes.imported,
      stockitems_imported: stockRes.imported,
      vouchers_imported: voucherRes.imported,
      vouchers_previewed: voucherRes.seen,
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

    // Full Tally Prime port-9000 sync — same approach integrations like
    // LiveKeeping use:
    //   1. Ledgers  → custom TDL Collection, TYPE=Ledger, FETCH of scalar
    //      fields Tally Prime is known to expose.
    //   2. Stock    → custom TDL Collection, TYPE=StockItem, same.
    //   3. Vouchers → "Day Book" report with SVFROMDATE/SVTODATE pinned to
    //      the user's date range. Tally streams every voucher in that
    //      range with full LEDGERENTRIES and ALLINVENTORYENTRIES.
    // Earlier TDLs crashed Tally because they named fields that don't
    // exist on that object type (e.g. PartyGSTIN is a voucher field, not a
    // Ledger field; MaximumRetailPrice is not a StockItem scalar). The
    // lists below stick to documented Tally Prime native fields and are
    // the exact same ones widely used in the community Tally-XML tooling.
    const fetchCollection = async (collName, objectType, fetchFields, timeoutMs = 120000) => {
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<ENVELOPE>` +
        `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${esc(collName)}</ID></HEADER>` +
        `<BODY><DESC>` +
        `<STATICVARIABLES>` +
        `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
        (cfg.company ? `<SVCURRENTCOMPANY>${esc(cfg.company)}</SVCURRENTCOMPANY>` : '') +
        `</STATICVARIABLES>` +
        `<TDL><TDLMESSAGE>` +
        `<COLLECTION NAME="${esc(collName)}" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">` +
        `<TYPE>${esc(objectType)}</TYPE>` +
        `<FETCH>${fetchFields.join(', ')}</FETCH>` +
        `</COLLECTION>` +
        `</TDLMESSAGE></TDL>` +
        `</DESC></BODY></ENVELOPE>`;
      const { status, body } = await postTallyXML({ host: cfg.host, port: cfg.port, xml, timeoutMs });
      if (status !== 200) throw new Error(`Tally returned HTTP ${status}`);
      return body;
    };

    // Safe, widely-supported Tally Prime scalar fields. Keep `Address` and
    // `LedgerPhone` out of the FETCH — those are list-type fields that
    // multiply response time on larger ledgers. The address + phone data
    // we need is already captured in the MailingName / LedStateName /
    // Pincode / LedgerMobile / Email scalars.
    const ledgersXML = await fetchCollection('AllLedgerEntries', 'Ledger', [
      'Name', 'Parent', 'Alias', 'MailingName',
      'OpeningBalance', 'ClosingBalance',
      'LedStateName', 'Pincode', 'CountryName',
      'LedgerMobile', 'LedgerContact', 'Email',
      'GSTIN', 'IncomeTaxNumber',
      'CreditLimit', 'BillCreditPeriod',
    ]);
    const stockXML = await fetchCollection('AllStockEntries', 'StockItem', [
      'Name', 'Parent', 'Alias', 'Description',
      'BaseUnits', 'AdditionalUnits',
      'OpeningBalance', 'OpeningRate', 'OpeningValue',
      'ClosingBalance', 'ClosingRate', 'ClosingValue',
      'HSNCode', 'GSTApplicable',
    ]);

    // Vouchers via a TDL Voucher Collection with a SYSTEM Formula filter.
    // Day Book (TYPE=Data ID="Day Book") is clipped by Tally's active
    // period (F2) even when we send SVFROMDATE/SVTODATE, so backdated
    // pulls returned only current-year data no matter how wide the user
    // opened the range.
    //
    // A TDL COLLECTION over TYPE=Voucher walks the company's voucher
    // table directly (no active-period gate) and accepts a FILTER that we
    // define inline via <SYSTEM TYPE="Formulae">. The formula references
    // the static vars SVFROMDATE/SVTODATE which we bind per-request.
    let vouchersXML = '';
    try {
      const hasRange = Boolean(from_date && to_date);
      const vx =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<ENVELOPE>` +
        `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ERPAllVouchers</ID></HEADER>` +
        `<BODY><DESC>` +
        `<STATICVARIABLES>` +
        `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
        (cfg.company ? `<SVCURRENTCOMPANY>${esc(cfg.company)}</SVCURRENTCOMPANY>` : '') +
        (from_date ? `<SVFROMDATE TYPE="Date">${formatDate(from_date)}</SVFROMDATE>` : '') +
        (to_date ? `<SVTODATE TYPE="Date">${formatDate(to_date)}</SVTODATE>` : '') +
        `</STATICVARIABLES>` +
        `<TDL><TDLMESSAGE>` +
        `<COLLECTION NAME="ERPAllVouchers" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">` +
        `<TYPE>Voucher</TYPE>` +
        // FETCH list combines:
        //   *                      — all scalar fields (Date, VoucherTypeName,
        //                             VoucherNumber, PartyLedgerName, Narration…)
        //   AllInventoryEntries,   — nested repeating collections. `*` alone
        //   AllLedgerEntries,        does NOT pull these; you must name each
        //   LedgerEntries,           nested list explicitly or Tally returns
        //   InventoryEntries         the voucher shell only, which is how our
        //                            first live pull came back with 2370
        //                            vouchers but all 182 Purchase bills had
        //                            zero items and zero amount.
        `<FETCH>*, AllInventoryEntries, AllLedgerEntries, LedgerEntries, InventoryEntries</FETCH>` +
        (hasRange ? `<FILTER>ERPDateRange</FILTER>` : '') +
        `</COLLECTION>` +
        (hasRange ?
          `<SYSTEM TYPE="Formulae" NAME="ERPDateRange">$Date &gt;= $$Date:"${formatDate(from_date)}" AND $Date &lt;= $$Date:"${formatDate(to_date)}"</SYSTEM>`
          : '') +
        `</TDLMESSAGE></TDL>` +
        `</DESC></BODY></ENVELOPE>`;
      const r = await postTallyXML({ host: cfg.host, port: cfg.port, xml: vx, timeoutMs: 240000 });
      if (r.status === 200) vouchersXML = r.body;
      if (process.env.TALLY_DEBUG) {
        const voucherCount = (vouchersXML.match(/<VOUCHER\s/g) || []).length;
        const dateCount = (vouchersXML.match(/<DATE>/g) || []).length;
        const invCount = (vouchersXML.match(/<ALLINVENTORYENTRIES\.LIST/g) || []).length;
        const allLedCount = (vouchersXML.match(/<ALLLEDGERENTRIES\.LIST/g) || []).length;
        const ledCount = (vouchersXML.match(/<LEDGERENTRIES\.LIST/g) || []).length;
        console.log('[tally] voucher fetch status=' + r.status + ' bodyLen=' + vouchersXML.length
          + ' vouchers=' + voucherCount + ' dates=' + dateCount
          + ' inv=' + invCount + ' allLed=' + allLedCount + ' led=' + ledCount);
        const firstV = (vouchersXML.match(/<VOUCHER[\s\S]*?<\/VOUCHER>/) || [])[0] || '';
        console.log('[tally] first voucher (first 1200 chars):', firstV.slice(0, 1200));
      }
    } catch (e) {
      // Masters still make the pull useful — surface Day Book failures
      // in the errors array rather than aborting the whole live pull.
      if (process.env.TALLY_DEBUG) console.log('[tally] voucher fetch ERROR:', e.message);
    }

    // Persist — not just count. Same ingestion helpers as File Mode so
    // Live and File modes produce identical DB state from the same Tally
    // company.
    const userId = req.user?.user_id || null;
    const ledgerRes  = await ingestLedgersFromXml(ledgersXML, userId);
    const stockRes   = await ingestStockItemsFromXml(stockXML);
    const voucherRes = vouchersXML
      ? await ingestVouchersFromXml(vouchersXML, userId)
      : { imported: 0, errors: [], seen: 0 };

    // Update last-sync on success
    await SystemSettings.update({ tally_last_sync: new Date() }, { where: { setting_id: 1 } });

    res.json({
      // `ledgers` / `stockitems` reflect rows actually written. Non-party
      // ledgers (income/expense/tax) are counted under `ledgers_seen`
      // so the raw fetch total is still visible.
      ledgers:         ledgerRes.imported,
      ledgers_seen:    ledgerRes.seen,
      stockitems:      stockRes.imported,
      stockitems_seen: stockRes.seen,
      vouchers:        voucherRes.imported,
      vouchers_seen:   voucherRes.seen,
      conflicts: 0,
      errors:    [...ledgerRes.errors, ...stockRes.errors, ...voucherRes.errors],
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

exports.getSyncLogs = async (req, res) => {
  // Sync-log table not yet created (follow-up milestone).
  res.json({ logs: [] });
};
