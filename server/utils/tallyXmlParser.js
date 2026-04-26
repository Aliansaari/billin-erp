// ── Pure Tally XML parser ──────────────────────────────────────────────
//
// Parsing-only helpers (no DB writes). The legacy tallyController.js has
// its own copies of these inlined; the new tallyImportOrchestrator uses
// these. Both run on the same regex shapes so a future refactor that
// retires the legacy ingest functions is mechanical.

const TAG_BOUNDARY = '(?:\\s[^>]*)?';

function decodeXmlBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return Buffer.from(buf.slice(2)).swap16().toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf-8');
  if (buf.length >= 128) {
    let zeroCount = 0;
    for (let i = 1; i < 128; i += 2) if (buf[i] === 0x00) zeroCount++;
    if (zeroCount > 40) return buf.toString('utf16le');
  }
  return buf.toString('utf-8');
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}${TAG_BOUNDARY}>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

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

function parseTallyDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function parseTallyAmount(raw) {
  const n = parseFloat(String(raw || '').trim());
  return isFinite(n) ? n : 0;
}

function classifyLedger(name) {
  if (!name) return 'other';
  const u = name.toUpperCase();
  if (u.includes('IGST')) return 'igst';
  if (u.includes('CGST')) return 'cgst';
  if (u.includes('SGST') || u.includes('UGST')) return 'sgst';
  if (u.includes('ROUND') && u.includes('OFF')) return 'roundoff';
  if (u.includes('DISCOUNT')) return 'discount';
  // Returns share the same Dr/Cr role within their voucher as Sales/Purchase
  // do in their own voucher — bucket them together so totals math reuses the
  // same taxable + tax shape for Credit Notes / Debit Notes.
  if (u.includes('SALES RETURN'))    return 'sales';
  if (u.includes('PURCHASE RETURN')) return 'purchase';
  // Broad match on SALES / PURCHASE — Tally users name their sales ledgers
  // many ways: "Sales Account", "Local Sales 12%", "Interstate Sales 18%",
  // "Export Sales", etc. A narrow whitelist mis-classifies all of these
  // as party_or_other, which then breaks the balance-check on cash sales
  // (the Sales line gets summed into the party leg instead of the
  // computed total). False positives like "Sales Commission" are
  // accounting-acceptable here — they still net out against the party
  // leg in the same direction.
  if (u.includes('SALES'))    return 'sales';
  if (u.includes('PURCHASE')) return 'purchase';
  if (u.includes('CASH') || u.includes('BANK')) return 'cash_bank';
  return 'party_or_other';
}

// ── parseLedgers — masters ──
// Returns array<{ name, parent, opening_balance, opening_balance_type, gstin, address, mobile }>
// where parent is the ledger's group (e.g., "Sundry Debtors").
function parseLedgers(xml) {
  const blocks = extractTag(xml, 'LEDGER');
  const out = [];
  for (const b of blocks) {
    const name = readField(b, 'NAME');
    if (!name) continue;
    const parent = readField(b, 'PARENT');
    const openingBalanceRaw = readField(b, 'OPENINGBALANCE');
    const opening = parseTallyAmount(openingBalanceRaw);
    out.push({
      name,
      parent,
      gstin: readField(b, 'PARTYGSTIN') || readField(b, 'LEDGERGSTIN'),
      address: '',
      mobile: readField(b, 'LEDGERPHONE'),
      // Tally exports opening as positive=debit, negative=credit. We map
      // to our Receivable/Payable convention based on parent group.
      opening_balance: Math.abs(opening),
      opening_balance_type: opening >= 0 ? 'Receivable' : 'Payable',
    });
  }
  return out;
}

// ── parseStockItems — products masters ──
function parseStockItems(xml) {
  const blocks = extractTag(xml, 'STOCKITEM');
  const out = [];
  for (const b of blocks) {
    const name = readField(b, 'NAME');
    if (!name) continue;
    out.push({
      name,
      hsn:    readField(b, 'GSTAPPLICABLE') || readField(b, 'HSNCODE') || '',
      unit:   readField(b, 'BASEUNITS') || 'Pcs',
      gst_rate: parseTallyAmount(readField(b, 'GSTRATE')) || 0,
      opening_stock: parseTallyAmount(readField(b, 'OPENINGBALANCE')),
    });
  }
  return out;
}

// ── parseVouchers — sales/purchase/receipt/payment ──
//
// Returns array<{
//   voucher_type,    // canonical: 'Sales' | 'Purchase' | 'Receipt' | 'Payment' | 'Credit Note' | 'Debit Note' | 'Contra' | 'Journal' | 'Stock Journal'
//   voucher_number,
//   voucher_date,
//   guid,            // Tally's stable per-voucher key
//   party_name,
//   ledger_entries,  // array<{ name, amount, isDeemedPositive, classification }>
//   inventory,       // array<{ name, quantity, rate, amount }>
//   raw_block,       // original XML block — used for diff detection on re-imports
// }>
function parseVouchers(xml) {
  const vBlocks = extractTagWithAttrs(xml, 'VOUCHER');
  const out = [];
  for (const v of vBlocks) {
    const body = v.body;
    const vchType = (v.attrs.VCHTYPE || readField(body, 'VOUCHERTYPENAME') || 'Unknown').trim();
    const number  = readField(body, 'VOUCHERNUMBER') || readField(body, 'BILLNAME') || '';
    const date    = parseTallyDate(readField(body, 'DATE'));
    const guid    = readField(body, 'GUID');
    const partyName = readField(body, 'PARTYLEDGERNAME') || readField(body, 'PARTYNAME') || readField(body, 'BASICBUYERNAME') || '';

    // Flat list of ledger postings for this voucher.
    const ledgerEntries = [];
    const lines = extractTag(body, 'LEDGERENTRIES.LIST').concat(extractTag(body, 'ALLLEDGERENTRIES.LIST'));
    for (const l of lines) {
      const lname = readField(l, 'LEDGERNAME');
      if (!lname) continue;
      const amt   = parseTallyAmount(readField(l, 'AMOUNT'));
      const isDeemed = readField(l, 'ISDEEMEDPOSITIVE');
      ledgerEntries.push({
        name: lname,
        amount: amt,
        isDeemedPositive: /yes/i.test(isDeemed),
        classification: classifyLedger(lname),
      });
    }

    // Inventory lines (sales / purchase only).
    const inventory = [];
    const inv = extractTag(body, 'ALLINVENTORYENTRIES.LIST').concat(extractTag(body, 'INVENTORYENTRIES.LIST'));
    for (const it of inv) {
      const stockItem = readField(it, 'STOCKITEMNAME');
      if (!stockItem) continue;
      const qtyRaw = readField(it, 'ACTUALQTY') || readField(it, 'BILLEDQTY');
      const qm = qtyRaw.match(/-?\d+(\.\d+)?/);
      const qty = qm ? parseFloat(qm[0]) : 0;
      const rateRaw = readField(it, 'RATE');
      const rm = rateRaw.match(/-?\d+(\.\d+)?/);
      const rate = rm ? parseFloat(rm[0]) : 0;
      const amt = parseTallyAmount(readField(it, 'AMOUNT'));
      inventory.push({ name: stockItem, quantity: qty, rate, amount: amt });
    }

    out.push({
      voucher_type: vchType,
      voucher_number: number,
      voucher_date: date,
      guid,
      party_name: partyName,
      ledger_entries: ledgerEntries,
      inventory,
      raw_block: body,
    });
  }
  return out;
}

module.exports = {
  decodeXmlBuffer,
  extractTag,
  extractTagWithAttrs,
  readField,
  parseTallyDate,
  parseTallyAmount,
  classifyLedger,
  parseLedgers,
  parseStockItems,
  parseVouchers,
};
