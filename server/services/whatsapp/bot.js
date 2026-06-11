/**
 * WhatsApp self-service BOT (v4).
 * ───────────────────────────────
 * Three audiences, auto-detected by the sender's verified WhatsApp number:
 *   • OWNER   (numbers in bot_owner_numbers) → a private command centre:
 *       business reports (today/yesterday/week/month), receivables & payables,
 *       low-stock & top-product alerts, top customers, cash & bank position,
 *       expenses, cheque alerts, customer/supplier lookups, stock lookup, and
 *       statement PDFs. Every capability is individually switchable from the
 *       Settings page (bot_owner_panel JSON).
 *   • CUSTOMER (number on a customer party) → balance / bills / payments /
 *       statement PDF, and "reply with a bill or receipt number → PDF".
 *   • SUPPLIER (number on a supplier party) → what we owe them / purchase
 *       bills / payments we made / statement PDF (bot_supplier_panel JSON).
 *
 * Identity is the sender's number, so each party only ever sees their OWN data.
 * Pure logic — the manager wires sockets/DB (sendText, sendDoc, withCompany).
 */
const { Op, QueryTypes } = require('sequelize');
const { buildStatementPdf } = require('./statementPdf');
const { buildBillPdf, buildReceiptPdf, safeName } = require('./docPdf');

/* ══════════════ Entry creation — session state ══════════════════════
 * Multi-step conversations (party/ledger search → confirmation → save)
 * are tracked per-sender in memory with a 5-minute TTL.
 */
const SESSIONS = new Map();
const SESSION_TTL = 5 * 60 * 1000;
function getSession(key) {
  const s = SESSIONS.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { SESSIONS.delete(key); return null; }
  return s;
}
function setSession(key, data) { SESSIONS.set(key, { ...data, expiresAt: Date.now() + SESSION_TTL }); }
function clearSession(key) { SESSIONS.delete(key); }

// ── Per-sender rate limit ──
const RL = new Map();
function allow(key, perMin = 12, perHour = 100) {
  const now = Date.now();
  const arr = (RL.get(key) || []).filter((t) => now - t < 3600000);
  const lastMin = arr.filter((t) => now - t < 60000).length;
  if (arr.length >= perHour || lastMin >= perMin) { RL.set(key, arr); return false; }
  arr.push(now); RL.set(key, arr); return true;
}

const amt = (n) => 'Rs ' + Math.abs(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt0 = (n) => 'Rs ' + Math.abs(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const qty = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const drcr = (n) => { const v = Number(n) || 0; if (Math.abs(v) < 0.01) return 'Settled ✅'; return amt(v) + (v > 0 ? ' Dr' : ' Cr'); };
const dt = (d) => { if (!d) return ''; const x = new Date(d); return isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const pad = (n) => String(n).padStart(2, '0');
function dayOffset(n) { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function monthStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; }

function parseList(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function parseMap(s) { try { const o = JSON.parse(s || '{}'); return (o && typeof o === 'object') ? o : {}; } catch { return {}; } }
function inList(list, last10) { return list.some((x) => String(x).replace(/\D/g, '').slice(-10) === last10); }
const on = (map, key) => map[key] !== false; // default ON unless explicitly disabled

/* ── Natural-language helpers ── */
const MONTHS = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  january:1, february:2, march:3, april:4, june:6, july:7, august:8,
  september:9, october:10, november:11, december:12,
};
function parseDateStr(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v) return null;
  if (['today', 'aaj', 'aj', 'abhi'].includes(v)) return dayOffset(0);
  if (['yesterday', 'kal', 'kal ka', 'kl'].includes(v)) return dayOffset(-1);
  if (['parso', 'parson', 'day before yesterday'].includes(v)) return dayOffset(-2);
  let m;
  // DD/MM/YYYY or DD-MM-YYYY
  m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  // YYYY-MM-DD
  m = v.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  // DD/MM (current year)
  m = v.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${new Date().getFullYear()}-${pad(+m[2])}-${pad(+m[1])}`;
  // "15 jun" / "15 june" / "jun 15"
  m = v.match(/^(\d{1,2})\s+([a-z]+)$/);
  if (m && MONTHS[m[2].slice(0, 3)]) return `${new Date().getFullYear()}-${pad(MONTHS[m[2].slice(0, 3)])}-${pad(+m[1])}`;
  m = v.match(/^([a-z]+)\s+(\d{1,2})$/);
  if (m && MONTHS[m[1].slice(0, 3)]) return `${new Date().getFullYear()}-${pad(MONTHS[m[1].slice(0, 3)])}-${pad(+m[2])}`;
  return null;
}
function parseAmt(s) { return parseFloat(String(s || '').replace(/,/g, '').trim()) || 0; }
function normaliseMode(s) {
  const k = String(s || '').toLowerCase().replace(/\s+/g, '');
  if (['upi', 'gpay', 'phonepe', 'phonepay', 'paytm'].includes(k)) return 'UPI';
  if (['bank', 'banktransfer', 'neft', 'rtgs', 'imps', 'transfer'].includes(k)) return 'Bank Transfer';
  return 'Cash';
}
function looksLikeEntryIntent(text) {
  return /^(?:rec(?:eived?)?|rcvd|pay(?:ment)?|paid?|exp(?:ense)?|kharch[a]?)\s/i.test(text.trim());
}
function parseOwnerIntent(raw) {
  let rest = raw.trim();
  let date = dayOffset(0);

  // Strip "on <date>" / "dated <date>" / "date <date>" anywhere
  const dm = rest.match(/\s+(?:on|dated?|date|tarikh)\s+([\d\/\-]+(?:\s+\w+)?|\w+(?:\s+\d+)?|today|yesterday|kal|aaj|parso)/i);
  if (dm) { const p = parseDateStr(dm[1]); if (p) { date = p; rest = rest.replace(dm[0], '').trim(); } }

  // Strip trailing payment mode "by upi" / "via cash" / "cash" / "upi"
  let paymentMode = 'Cash';
  const mm = rest.match(/(?:\s+(?:by|via))?\s+(cash|upi|gpay|phonepe|paytm|bank\s*transfer|neft|rtgs|imps|transfer)$/i);
  if (mm) { paymentMode = normaliseMode(mm[1]); rest = rest.replace(mm[0], '').trim(); }

  let m;

  // ── RECEIPT ──
  // "received 5000 from Ahmed" / "rec 5000 from Ahmed" / "rcvd 5000 from Ahmed"
  m = rest.match(/^(?:received?|rcvd|rec)\s+(\d[\d,.]*)\s+(?:from|frm|se)\s+(.+)$/i);
  if (m) return { type: 'receipt', amount: parseAmt(m[1]), partyQuery: m[2].trim(), date, paymentMode };

  // "Ahmed ne 5000 diya" / "Ahmed paid 5000"
  m = rest.match(/^(.+?)\s+(?:ne|has)\s+(\d[\d,.]*)\s+(?:diya|de\s*diya|bheja|paid|rakha|diye)$/i);
  if (m) return { type: 'receipt', amount: parseAmt(m[2]), partyQuery: m[1].trim(), date, paymentMode };
  m = rest.match(/^(.+?)\s+paid\s+(\d[\d,.]*)$/i);
  if (m) return { type: 'receipt', amount: parseAmt(m[2]), partyQuery: m[1].trim(), date, paymentMode };

  // ── PAYMENT ──
  // "paid 5000 to Ahmed" / "pay 5000 to Ahmed" / "payment 5000 to Ahmed"
  m = rest.match(/^(?:paid?|payment)\s+(\d[\d,.]*)\s+(?:to|ko)\s+(.+)$/i);
  if (m) return { type: 'payment', amount: parseAmt(m[1]), partyQuery: m[2].trim(), date, paymentMode };

  // "Ahmed ko 5000 diya"
  m = rest.match(/^(.+?)\s+ko\s+(\d[\d,.]*)\s+(?:diya|de\s*diya|bheja|paid|diye)$/i);
  if (m) return { type: 'payment', amount: parseAmt(m[2]), partyQuery: m[1].trim(), date, paymentMode };

  // ── EXPENSE ──
  // "expense 1200 electricity" / "exp 1200 for electricity" / "kharch 1200 electricity"
  m = rest.match(/^(?:expense|exp|kharch|kharcha)\s+(\d[\d,.]*)(?:\s+for)?\s+(.+)$/i);
  if (m) return { type: 'expense', amount: parseAmt(m[1]), description: m[2].trim(), date, paymentMode };

  // "paid 1200 for electricity" — "for" distinguishes expense from supplier payment
  m = rest.match(/^(?:paid?|spent?|spend)\s+(\d[\d,.]*)\s+for\s+(.+)$/i);
  if (m) return { type: 'expense', amount: parseAmt(m[1]), description: m[2].trim(), date, paymentMode };

  return null;
}

async function companyInfo(models) {
  const s = await models.SystemSettings.findOne();
  if (!s) return { name: 'us' };
  return {
    name: s.company_name || 'us', address_line_1: s.company_address_line_1 || s.company_address || '',
    city: s.company_city || '', state: s.company_state || '', pincode: s.company_pincode || '',
    phone: s.company_phone || '', gstin: s.gstin || '',
  };
}
async function makeStatementPdf(party, shop) {
  const { getLedgerStatement, resolveLedgerForParty } = require('../../services/ledgerStatementService');
  const ledgerId = await resolveLedgerForParty(party.party_id);
  if (!ledgerId) return null;
  const from = dayOffset(-365);
  const statement = await getLedgerStatement(ledgerId, { fromDate: from });
  const pdf = buildStatementPdf({ shop, party, statement });
  return { pdf, fname: `Statement-${safeName(party.party_name)}.pdf`, closing: statement.closing_balance };
}

/* ════════════════ OWNER reports ════════════════ */
async function bizSummary(models, fromDate, toExclusive, title, dateLabel) {
  const w = { bill_date: toExclusive ? { [Op.gte]: fromDate, [Op.lt]: toExclusive } : { [Op.gte]: fromDate }, is_cancelled: false };
  const rw = { transaction_type: 'Receipt', is_cancelled: false, transaction_date: toExclusive ? { [Op.gte]: fromDate, [Op.lt]: toExclusive } : { [Op.gte]: fromDate } };
  const [sales, count, credit, collected] = await Promise.all([
    models.SalesBill.sum('total_amount', { where: w }), models.SalesBill.count({ where: w }),
    models.SalesBill.sum('balance_amount', { where: w }), models.PaymentReceipt.sum('total_amount', { where: rw }),
  ]);
  const s = Number(sales || 0), n = Number(count || 0), cr = Number(credit || 0), col = Number(collected || 0);
  const L = [`📊 *${title}*${dateLabel ? `  ·  ${dateLabel}` : ''}`, '',
    `🧾 Sales: *${amt(s)}*  (${n} bill${n === 1 ? '' : 's'})`, `💵 Collected: *${amt(col)}*`];
  if (cr > 0.01) L.push(`⏳ On credit: ${amt(cr)}`);
  if (n > 0) L.push(`📈 Avg bill: ${amt(s / n)}`);
  L.push('', 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerReceivables(models) {
  const [total, debtors, top] = await Promise.all([
    models.Party.sum('current_balance', { where: { current_balance: { [Op.gt]: 0 } } }),
    models.Party.count({ where: { current_balance: { [Op.gt]: 0 } } }),
    models.Party.findAll({ where: { current_balance: { [Op.gt]: 0 } }, order: [['current_balance', 'DESC']], limit: 6, attributes: ['party_name', 'current_balance'] }),
  ]);
  const L = [`📥 *Receivables — money to collect*`, `*${amt(total || 0)}* from ${Number(debtors || 0)} customer(s)`, ''];
  if (top.length) { L.push('Top dues:'); top.forEach((p, i) => L.push(`${i + 1}. ${p.party_name} — ${amt(p.current_balance)}`)); }
  else L.push('No dues — all collected. 🎉');
  L.push('', 'Tip: type a *name* to view a customer, or *pdf <name>* for a statement.', 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerPayables(models) {
  const [total, creditors, top] = await Promise.all([
    models.Party.sum('current_balance', { where: { current_balance: { [Op.lt]: 0 } } }),
    models.Party.count({ where: { current_balance: { [Op.lt]: 0 } } }),
    models.Party.findAll({ where: { current_balance: { [Op.lt]: 0 } }, order: [['current_balance', 'ASC']], limit: 6, attributes: ['party_name', 'current_balance'] }),
  ]);
  const L = [`📤 *Payables — money we owe*`, `*${amt(total || 0)}* to ${Number(creditors || 0)} supplier(s)`, ''];
  if (top.length) { L.push('Top payables:'); top.forEach((p, i) => L.push(`${i + 1}. ${p.party_name} — ${amt(p.current_balance)}`)); }
  else L.push('Nothing payable. 🎉');
  L.push('', 'Tip: *sup <name>* to view a supplier.', 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerTopCustomers(models) {
  const rows = await models.SalesBill.sequelize.query(
    `SELECT p.party_name, SUM(sb.total_amount)::float amt, COUNT(*)::int n
       FROM sales_bills sb JOIN parties p ON p.party_id = sb.customer_id
      WHERE sb.is_cancelled = false AND sb.bill_date >= :from AND sb.customer_id IS NOT NULL
      GROUP BY p.party_name ORDER BY amt DESC LIMIT 7`,
    { replacements: { from: monthStr() }, type: QueryTypes.SELECT });
  if (!rows.length) return '🏆 No sales yet this month.\n\nReply *0* for the menu.';
  const L = ['🏆 *Top customers this month*', ''];
  rows.forEach((r, i) => L.push(`${i + 1}. ${r.party_name} — *${amt0(r.amt)}* (${r.n} bill${r.n === 1 ? '' : 's'})`));
  L.push('', 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerTopProducts(models) {
  const rows = await models.SalesBill.sequelize.query(
    `SELECT sbi.product_name, SUM(sbi.quantity)::float q, SUM(sbi.total_amount)::float amt
       FROM sales_bill_items sbi JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
      WHERE sb.is_cancelled = false AND sb.bill_date >= :from
      GROUP BY sbi.product_name ORDER BY amt DESC LIMIT 7`,
    { replacements: { from: monthStr() }, type: QueryTypes.SELECT });
  if (!rows.length) return '🔥 No product sales yet this month.\n\nReply *0* for the menu.';
  const L = ['🔥 *Top-selling products this month*', ''];
  rows.forEach((r, i) => L.push(`${i + 1}. ${r.product_name} — ${qty(r.q)} sold · *${amt0(r.amt)}*`));
  L.push('', 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerLowStock(models) {
  const rows = await models.SalesBill.sequelize.query(
    `SELECT product_name, article_number, current_stock::float st, reorder_level::float rl, unit_of_measurement u
       FROM products WHERE is_active = true AND reorder_level > 0 AND current_stock <= reorder_level
      ORDER BY (current_stock - reorder_level) ASC LIMIT 15`, { type: QueryTypes.SELECT });
  if (!rows.length) return '✅ No items at or below reorder level. Stock looks healthy.\n\nReply *0* for the menu.';
  const out = rows.filter((r) => r.st <= 0).length;
  const L = [`⚠️ *Low stock* — ${rows.length} item(s)${out ? ` · ${out} out of stock` : ''}`, ''];
  rows.forEach((r) => L.push(`• ${r.product_name}${r.article_number ? ` (Art ${r.article_number})` : ''}\n   ${qty(r.st)} ${r.u || 'Pcs'} left · reorder at ${qty(r.rl)}${r.st <= 0 ? '  ❌' : ''}`));
  L.push('', 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerCashBank(models) {
  // Compute each account's live balance from ledger_entries (opening seed +
  // active entries) — LedgerAccount.current_balance is only maintained for
  // party ledgers, so for cash/bank we sum the postings directly.
  const rows = await models.SalesBill.sequelize.query(
    `SELECT la.ledger_name, la.sub_group,
            ((CASE WHEN la.opening_balance_type='Credit' THEN -1 ELSE 1 END) * COALESCE(la.opening_balance,0)
             + COALESCE((SELECT SUM(le.debit_amount - le.credit_amount) FROM ledger_entries le
                  WHERE le.ledger_id = la.ledger_id AND le.reversal_of_id IS NULL
                    AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)), 0))::float bal
       FROM ledger_accounts la
      WHERE la.is_active = true AND la.sub_group IN ('Cash-in-Hand','Bank Accounts')
      ORDER BY la.sub_group ASC, la.ledger_name ASC`, { type: QueryTypes.SELECT });
  if (!rows.length) return '🏦 No cash/bank accounts configured.\n\nReply *0* for the menu.';
  let total = 0;
  const L = ['🏦 *Cash & Bank balances*', ''];
  for (const r of rows) { const b = Number(r.bal || 0); total += b; L.push(`${r.sub_group === 'Cash-in-Hand' ? '💵' : '🏦'} ${r.ledger_name}: *${amt(b)}*`); }
  L.push('', `Total on hand: *${amt(total)}*`, '', 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerExpenses(models) {
  const [today, month, mcount] = await Promise.all([
    models.ExpenseVoucher.sum('total_amount', { where: { is_cancelled: false, voucher_date: { [Op.gte]: dayOffset(0) } } }),
    models.ExpenseVoucher.sum('total_amount', { where: { is_cancelled: false, voucher_date: { [Op.gte]: monthStr() } } }),
    models.ExpenseVoucher.count({ where: { is_cancelled: false, voucher_date: { [Op.gte]: monthStr() } } }),
  ]);
  const mname = new Date().toLocaleDateString('en-IN', { month: 'long' });
  return [`🧾 *Expenses*`, '', `Today: *${amt(today || 0)}*`, `${mname}: *${amt(month || 0)}*  (${Number(mcount || 0)} voucher${Number(mcount) === 1 ? '' : 's'})`, '', 'Reply *0* for the menu.'].join('\n');
}
async function ownerCheques(models) {
  async function grp(status) {
    const [n, sum] = await Promise.all([
      models.Cheque.count({ where: { status } }),
      models.Cheque.sum('amount', { where: { status } }),
    ]);
    return { n: Number(n || 0), sum: Number(sum || 0) };
  }
  const [pend, dep, bounce] = await Promise.all([grp('PENDING'), grp('DEPOSITED'), grp('BOUNCED')]);
  const L = ['💳 *Cheque alerts*', ''];
  L.push(`📥 To deposit (in hand): ${pend.n} · ${amt0(pend.sum)}`);
  L.push(`🏦 Awaiting clearance: ${dep.n} · ${amt0(dep.sum)}`);
  L.push(`❌ Bounced: ${bounce.n} · ${amt0(bounce.sum)}`);
  if (!pend.n && !dep.n && !bounce.n) L.push('', 'No cheques needing attention. ✅');
  L.push('', 'Reply *0* for the menu.');
  return L.join('\n');
}

/* ── Owner lookups ── */
async function ownerCustomerCard(models, party) {
  const [lastBill, lastPay, moSales, moCount] = await Promise.all([
    models.SalesBill.findOne({ where: { customer_id: party.party_id, is_cancelled: false }, order: [['bill_date', 'DESC'], ['sales_bill_id', 'DESC']] }),
    models.PaymentReceipt.findOne({ where: { party_id: party.party_id, transaction_type: 'Receipt', is_cancelled: false }, order: [['transaction_date', 'DESC'], ['transaction_id', 'DESC']] }),
    models.SalesBill.sum('total_amount', { where: { customer_id: party.party_id, is_cancelled: false, bill_date: { [Op.gte]: monthStr() } } }),
    models.SalesBill.count({ where: { customer_id: party.party_id, is_cancelled: false, bill_date: { [Op.gte]: monthStr() } } }),
  ]);
  const L = [`👤 *${party.party_name}*`, `Balance: *${drcr(party.current_balance)}*`];
  if (party.mobile_1) L.push(`📱 ${party.mobile_1}`);
  const cl = Number(party.credit_limit || 0);
  if (cl > 0) L.push(`💳 Credit limit: ${amt(cl)} (${Math.round((Math.max(0, Number(party.current_balance || 0)) / cl) * 100)}% used)`);
  L.push('');
  if (lastBill) L.push(`🧾 Last bill: ${dt(lastBill.bill_date)} ${lastBill.bill_number || ''} — ${amt(lastBill.total_amount)}${Number(lastBill.balance_amount || 0) > 0.01 ? ` (due ${amt(lastBill.balance_amount)})` : ' ✅'}`);
  if (lastPay) L.push(`💵 Last payment: ${dt(lastPay.transaction_date)} — ${amt(lastPay.total_amount)}`);
  const mo = Number(moSales || 0);
  if (mo > 0) L.push(`📅 This month: ${amt(mo)} (${Number(moCount || 0)} bill${Number(moCount) === 1 ? '' : 's'})`);
  if (!lastBill && !lastPay) L.push('No recent activity.');
  L.push('', `Send *pdf ${party.party_name}* for the full statement.`, 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerSupplierCard(models, party) {
  const [lastBill, lastPay] = await Promise.all([
    models.PurchaseBill.findOne({ where: { supplier_id: party.party_id, is_cancelled: false }, order: [['bill_date', 'DESC'], ['purchase_bill_id', 'DESC']] }),
    models.PaymentReceipt.findOne({ where: { party_id: party.party_id, transaction_type: 'Payment', is_cancelled: false }, order: [['transaction_date', 'DESC'], ['transaction_id', 'DESC']] }),
  ]);
  const bal = Number(party.current_balance || 0);
  const L = [`🏭 *${party.party_name}*  (Supplier)`,
    `Balance: *${Math.abs(bal) < 0.01 ? 'Settled ✅' : (bal < 0 ? amt(bal) + ' — we owe' : amt(bal) + ' — advance')}*`];
  if (party.mobile_1) L.push(`📱 ${party.mobile_1}`);
  L.push('');
  if (lastBill) L.push(`📦 Last purchase: ${dt(lastBill.bill_date)} ${lastBill.bill_number || ''} — ${amt(lastBill.total_amount)}${Number(lastBill.balance_amount || 0) > 0.01 ? ` (due ${amt(lastBill.balance_amount)})` : ' ✅'}`);
  if (lastPay) L.push(`💸 Last payment: ${dt(lastPay.transaction_date)} — ${amt(lastPay.total_amount)}`);
  if (!lastBill && !lastPay) L.push('No recent activity.');
  L.push('', `Send *pdf ${party.party_name}* for the full statement.`, 'Reply *0* for the menu.');
  return L.join('\n');
}
async function ownerFind(models, query, kind /* 'Customer' | 'Supplier' | null */) {
  const q = String(query || '').trim();
  if (q.length < 2) return 'Type at least 2 letters of a name to search.\n\nReply *0* for the menu.';
  const where = { party_name: { [Op.iLike]: `%${q}%` } };
  if (kind) where.party_type = kind;
  const rows = await models.Party.findAll({ where, order: [['party_name', 'ASC']], limit: 8, attributes: ['party_id', 'party_name', 'party_type', 'current_balance', 'mobile_1', 'credit_limit'] });
  if (!rows.length) return `No ${kind ? kind.toLowerCase() : 'party'} matching "${q}".\n\nReply *0* for the menu.`;
  if (rows.length === 1) return rows[0].party_type === 'Supplier' ? ownerSupplierCard(models, rows[0]) : ownerCustomerCard(models, rows[0]);
  const L = [`🔎 Matches for "${q}":`, ''];
  rows.forEach((p, i) => L.push(`${i + 1}. ${p.party_name}${p.party_type === 'Supplier' ? ' (sup)' : ''} — ${drcr(p.current_balance)}`));
  L.push('', 'Type the *full name* to open one, or *0* for the menu.');
  return L.join('\n');
}
async function ownerSendStatement(models, name, shop, sendDoc, sendText) {
  const q = String(name || '').trim();
  if (q.length < 2) return void await sendText('Send *pdf <name>* — at least 2 letters.\n\nReply *0* for the menu.');
  const rows = await models.Party.findAll({ where: { party_name: { [Op.iLike]: `%${q}%` } }, order: [['party_name', 'ASC']], limit: 8, attributes: ['party_id', 'party_name', 'current_balance'] });
  if (!rows.length) return void await sendText(`No party matching "${q}".\n\nReply *0* for the menu.`);
  if (rows.length > 1) { const L = [`Multiple matches for "${q}":`, '']; rows.forEach((p, i) => L.push(`${i + 1}. ${p.party_name} — ${drcr(p.current_balance)}`)); L.push('', 'Send *pdf <full name>* to pick one.'); return void await sendText(L.join('\n')); }
  const party = rows[0];
  try { const built = await makeStatementPdf(party, shop); if (built && sendDoc) { await sendDoc(built.pdf, built.fname, `${party.party_name} — closing ${drcr(built.closing)}`); return; } }
  catch (e) { console.error('[whatsapp] statement PDF failed:', e.message); }
  await sendText(`Couldn’t build a statement for ${party.party_name}. Balance: ${drcr(party.current_balance)}.\n\nReply *0* for the menu.`);
}

/* ── Owner STOCK lookup ── */
function stockFlags(s) {
  return { lookup: s.bot_stock_lookup !== false, sale: s.bot_owner_show_sale_rate !== false, purchase: s.bot_owner_show_purchase_rate !== false, stock: s.bot_owner_show_stock !== false, mrp: s.bot_owner_show_mrp !== false };
}
function stockCard(p, f) {
  const L = [`📦 *${p.product_name}*`];
  const sub = []; if (p.size_value) sub.push(`Size ${p.size_value}`); if (p.article_number) sub.push(`Article ${p.article_number}`);
  if (sub.length) L.push(sub.join('  ·  ')); if (p.barcode) L.push(`Barcode: ${p.barcode}`);
  L.push('');
  if (f.sale) L.push(`🏷️ Sale rate: *${amt(p.sale_rate)}*`);
  if (f.mrp && Number(p.mrp) > 0) L.push(`🔖 MRP: ${amt(p.mrp)}`);
  if (f.purchase) { const cost = Number(p.weighted_avg_cost > 0 ? p.weighted_avg_cost : p.purchase_rate) || 0; L.push(`💰 Purchase rate: ${amt(cost)}`); }
  if (f.stock) { const st = Number(p.current_stock || 0); const low = Number(p.reorder_level || 0) > 0 && st <= Number(p.reorder_level); L.push(`📊 In stock: *${qty(st)} ${p.unit_of_measurement || 'Pcs'}*${low ? '  ⚠️ low' : ''}`); }
  L.push('', 'Reply *0* for the menu.');
  return L.join('\n');
}
const STOCK_ATTRS = ['product_id', 'product_name', 'barcode', 'article_number', 'size_value', 'unit_of_measurement', 'sale_rate', 'purchase_rate', 'weighted_avg_cost', 'mrp', 'current_stock', 'reorder_level'];
function stockList(rows, label) {
  const L = [`🔎 *Stock matching ${label}* — ${rows.length} found`, ''];
  rows.forEach((p) => { const st = Number(p.current_stock || 0); const pick = p.barcode ? `send *B ${p.barcode}*` : (p.article_number ? `send *A ${p.article_number}*` : '');
    L.push(`• *${p.product_name}*${p.size_value ? ` (${p.size_value})` : ''}${p.article_number ? `  ·  Art ${p.article_number}` : ''}`);
    L.push(`   ${qty(st)} ${p.unit_of_measurement || 'Pcs'} in stock${pick ? `  ·  ${pick}` : ''}`); });
  L.push('', 'Send *B <barcode>* (exact) or *A <article>*, or *0* for the menu.');
  return L.join('\n');
}
async function stockByArticle(models, q, f) {
  const v = String(q || '').trim(); if (!v) return 'Send *A <article-no>* — e.g. *A 1024*.';
  let rows = await models.Product.findAll({ where: { is_active: true, article_number: { [Op.iLike]: v } }, attributes: STOCK_ATTRS, limit: 12 });
  if (!rows.length) rows = await models.Product.findAll({ where: { is_active: true, article_number: { [Op.iLike]: `%${v}%` } }, attributes: STOCK_ATTRS, limit: 12 });
  if (!rows.length) return `No product with article *${v}*.\n\nReply *0* for the menu.`;
  return rows.length === 1 ? stockCard(rows[0], f) : stockList(rows, `article "${v}"`);
}
async function stockByBarcode(models, q, f) {
  const v = String(q || '').trim(); if (!v) return 'Send *B <barcode>*.';
  const p = await models.Product.findOne({ where: { barcode: v }, attributes: STOCK_ATTRS });
  return p ? stockCard(p, f) : `No product with barcode *${v}*.\n\nReply *0* for the menu.`;
}
async function stockByName(models, q, f) {
  const v = String(q || '').trim(); if (v.length < 2) return 'Send *S <name>* — at least 2 letters.';
  const rows = await models.Product.findAll({ where: { is_active: true, product_name: { [Op.iLike]: `%${v}%` } }, order: [['product_name', 'ASC']], attributes: STOCK_ATTRS, limit: 14 });
  if (!rows.length) return `No product matching *${v}*.\n\nReply *0* for the menu.`;
  return rows.length === 1 ? stockCard(rows[0], f) : stockList(rows, `"${v}"`);
}

/* ══════════════ Entry session flow ═════════════════════════════════ */

async function showReceiptPaymentConfirm(party, intent, sk, sendText) {
  const { type, amount, date, paymentMode } = intent;
  const label = type === 'receipt' ? 'Receipt' : 'Payment';
  const emoji = type === 'receipt' ? '📥' : '📤';
  const L = [`${emoji} *${label} preview*`, '',
    `Party: *${party.party_name}*`, `Amount: *${amt(amount)}*`,
    `Date: *${dt(date)}*`, `Mode: *${paymentMode}*`,
    `Current balance: ${drcr(party.current_balance)}`, '',
    'Reply *yes* to save or *no* to cancel.'];
  setSession(sk, { type: `confirm_${type}`, party, intent });
  return sendText(L.join('\n'));
}

async function showExpenseConfirm(ledger, intent, sk, sendText) {
  const { amount, date, paymentMode } = intent;
  const L = ['🧾 *Expense preview*', '',
    `Account: *${ledger.ledger_name}*`, `Amount: *${amt(amount)}*`,
    `Date: *${dt(date)}*`, `Mode: *${paymentMode}*`, '',
    'Reply *yes* to save or *no* to cancel.'];
  setSession(sk, { type: 'confirm_expense', ledger, intent });
  return sendText(L.join('\n'));
}

async function startReceiptPaymentFlow(intent, sk, models, sendText) {
  const { type, amount, partyQuery } = intent;
  if (!amount || amount <= 0) return sendText('❌ Amount not understood.\n\nExamples:\n  *rec 5000 from Ahmed*\n  *pay 3000 to Ali Traders*\n\nReply *0* for the menu.');
  const rows = await models.Party.findAll({
    where: { party_name: { [Op.iLike]: `%${partyQuery}%` } },
    order: [['party_name', 'ASC']], limit: 8,
    attributes: ['party_id', 'party_name', 'party_type', 'current_balance'],
  });
  if (!rows.length) return sendText(`❌ No party matching *${partyQuery}* found. Check the spelling and try again.\n\nReply *0* for the menu.`);
  if (rows.length === 1) return showReceiptPaymentConfirm(rows[0].toJSON(), intent, sk, sendText);
  const L = [`Multiple matches for *${partyQuery}*:`, ''];
  rows.forEach((p, i) => L.push(`${i + 1}. ${p.party_name}${p.party_type ? ` (${p.party_type})` : ''} — ${drcr(p.current_balance)}`));
  L.push('', 'Reply with the *number* to select, or *no* to cancel.');
  setSession(sk, { type: `pick_party_${type}`, intent, parties: rows.map((p) => p.toJSON()) });
  return sendText(L.join('\n'));
}

async function startExpenseFlow(intent, sk, models, sendText) {
  const { amount, description } = intent;
  if (!amount || amount <= 0) return sendText('❌ Amount not understood.\n\nExample: *exp 1200 electricity*\n\nReply *0* for the menu.');
  let rows = await models.LedgerAccount.findAll({
    where: { ledger_group: 'Expenses', is_active: true, ledger_name: { [Op.iLike]: `%${description}%` } },
    order: [['ledger_name', 'ASC']], limit: 8, attributes: ['ledger_id', 'ledger_name'],
  });
  if (!rows.length) {
    // No match — show all expense ledgers so the owner can pick
    rows = await models.LedgerAccount.findAll({
      where: { ledger_group: 'Expenses', is_active: true },
      order: [['ledger_name', 'ASC']], limit: 20, attributes: ['ledger_id', 'ledger_name'],
    });
    if (!rows.length) return sendText('❌ No expense accounts found. Please create expense ledgers in the app first.\n\nReply *0* for the menu.');
    const L = [`❌ No expense account matching *${description}*. Available accounts:`, ''];
    rows.forEach((l, i) => L.push(`${i + 1}. ${l.ledger_name}`));
    L.push('', 'Reply with the *number* to use, or *no* to cancel.');
    setSession(sk, { type: 'pick_ledger_expense', intent, ledgers: rows.map((l) => l.toJSON()) });
    return sendText(L.join('\n'));
  }
  if (rows.length === 1) return showExpenseConfirm(rows[0].toJSON(), intent, sk, sendText);
  const L = [`Multiple expense accounts matching *${description}*:`, ''];
  rows.forEach((l, i) => L.push(`${i + 1}. ${l.ledger_name}`));
  L.push('', 'Reply with the *number* to select, or *no* to cancel.');
  setSession(sk, { type: 'pick_ledger_expense', intent, ledgers: rows.map((l) => l.toJSON()) });
  return sendText(L.join('\n'));
}

async function startEntryFlow(intent, sk, models, sendText) {
  if (intent.type === 'expense') return startExpenseFlow(intent, sk, models, sendText);
  return startReceiptPaymentFlow(intent, sk, models, sendText);
}

async function continueSession(session, sk, lower, models, sequelize, sendText, sendDoc, shop, companyId) {
  // "no" / "0" / "cancel" → abort
  if (/^(?:no|n|cancel|nahi|band|chodo|exit|0)$/.test(lower)) {
    clearSession(sk);
    return sendText('❌ Cancelled.\n\nReply *0* for the menu.');
  }

  const { type } = session;

  // ── Pick party from numbered list ──
  if (type === 'pick_party_receipt' || type === 'pick_party_payment') {
    const idx = parseInt(lower, 10);
    const parties = session.parties || [];
    if (isNaN(idx) || idx < 1 || idx > parties.length)
      return sendText(`Send a number between 1 and ${parties.length}, or *no* to cancel.`);
    const entryType = type === 'pick_party_receipt' ? 'receipt' : 'payment';
    return showReceiptPaymentConfirm(parties[idx - 1], { ...session.intent, type: entryType }, sk, sendText);
  }

  // ── Pick expense ledger from numbered list ──
  if (type === 'pick_ledger_expense') {
    const idx = parseInt(lower, 10);
    const ledgers = session.ledgers || [];
    if (isNaN(idx) || idx < 1 || idx > ledgers.length)
      return sendText(`Send a number between 1 and ${ledgers.length}, or *no* to cancel.`);
    return showExpenseConfirm(ledgers[idx - 1], session.intent, sk, sendText);
  }

  // ── Confirm receipt / payment ──
  if (type === 'confirm_receipt' || type === 'confirm_payment') {
    if (!/^(?:yes|y|ha|haan|confirm|ok|done)$/.test(lower))
      return sendText('Reply *yes* to confirm or *no* to cancel.');
    clearSession(sk);
    const { party, intent } = session;
    const entryType = type === 'confirm_receipt' ? 'Receipt' : 'Payment';
    try {
      const { createReceiptPayment } = require('./entryService');
      const result = await createReceiptPayment({
        type: entryType, partyId: party.party_id,
        amount: intent.amount, date: intent.date,
        paymentMode: intent.paymentMode, companyId, sequelize,
      });
      const emoji = entryType === 'Receipt' ? '✅📥' : '✅📤';
      await sendText([
        `${emoji} *${entryType} saved*`, '',
        `Voucher: *${result.transaction_number}*`,
        `Amount: *${amt(intent.amount)}* — ${party.party_name}`,
        `Date: ${dt(intent.date)} · Mode: ${intent.paymentMode}`,
        `New balance: ${drcr(result.freshBalance)}`,
        '', 'Reply *0* for the menu.',
      ].join('\n'));
      // Send the PDF receipt document
      if (sendDoc && result.receipt && result.party) {
        try {
          const company = await companyInfo(models);
          const pdf = buildReceiptPdf({
            shop, company,
            receipt: result.receipt,
            party: result.party,
            balanceAfter: result.freshBalance,
          });
          const fname = `${entryType}-${safeName(result.transaction_number)}.pdf`;
          await sendDoc(pdf, fname, `${emoji} ${result.transaction_number} — ${amt(intent.amount)}`);
        } catch (pdfErr) {
          console.error('[whatsapp] entry PDF failed:', pdfErr.message);
        }
      }
    } catch (e) {
      console.error('[whatsapp] entry create error:', e.message);
      return sendText(`❌ Could not save: ${e.message}\n\nReply *0* for the menu.`);
    }
    return;
  }

  // ── Confirm expense ──
  if (type === 'confirm_expense') {
    if (!/^(?:yes|y|ha|haan|confirm|ok|done)$/.test(lower))
      return sendText('Reply *yes* to confirm or *no* to cancel.');
    clearSession(sk);
    const { ledger, intent } = session;
    try {
      const { createExpense } = require('./entryService');
      const result = await createExpense({
        ledgerId: ledger.ledger_id, amount: intent.amount,
        date: intent.date, description: intent.description,
        paymentMode: intent.paymentMode, companyId, sequelize,
      });
      return sendText([
        '✅🧾 *Expense saved*', '',
        `Voucher: *${result.voucher_number}*`,
        `Amount: *${amt(intent.amount)}* — ${ledger.ledger_name}`,
        `Date: ${dt(intent.date)} · Mode: ${intent.paymentMode}`,
        '', 'Reply *0* for the menu.',
      ].join('\n'));
    } catch (e) {
      console.error('[whatsapp] expense create error:', e.message);
      return sendText(`❌ Could not save: ${e.message}\n\nReply *0* for the menu.`);
    }
  }
}

/* ── Owner menu (fixed numbers; only enabled rows shown) ── */
const OWNER_NUM = { 1: 'today', 2: 'yesterday', 3: 'week', 4: 'month', 5: 'receivables', 6: 'payables', 7: 'low_stock', 8: 'top_products', 9: 'top_customers', 10: 'cash_bank', 11: 'expenses', 12: 'cheques' };
function ownerMenu(shop, panel, stockOn) {
  const L = [`👋 *${shop}* — Owner Panel`];
  const seg = (title, items) => { const vis = items.filter((it) => on(panel, it[1])); if (!vis.length) return; L.push('', `*${title}*`); vis.forEach((it) => L.push(`${it[0]}  ${it[2]}`)); };
  seg('📊 SALES & MONEY', [['*1*', 'today', 'Today'], ['*2*', 'yesterday', 'Yesterday'], ['*3*', 'week', 'Last 7 days'], ['*4*', 'month', 'This month']]);
  seg('📒 DUES', [['*5*', 'receivables', 'Receivables (to collect)'], ['*6*', 'payables', 'Payables (we owe)']]);
  seg('📦 STOCK & PRODUCTS', [['*7*', 'low_stock', 'Low / out of stock'], ['*8*', 'top_products', 'Top-selling products'], ['*9*', 'top_customers', 'Top customers']]);
  seg('💰 CASH', [['*10*', 'cash_bank', 'Cash & bank balances'], ['*11*', 'expenses', 'Expenses'], ['*12*', 'cheques', 'Cheque alerts']]);
  const look = [];
  if (on(panel, 'customer_lookup')) look.push('• Customer: type a *name*  ·  *pdf <name>* = statement');
  if (on(panel, 'supplier_lookup')) look.push('• Supplier: *sup <name>*');
  if (stockOn) look.push('• Stock: *A <article>* · *B <barcode>* · *S <name>*');
  if (look.length) { L.push('', '*🔎 LOOK UP*'); look.forEach((x) => L.push(x)); }
  L.push('', '*📝 CREATE ENTRIES*');
  L.push('• Receipt: *rec 5000 from Ahmed*');
  L.push('• Payment: *pay 3000 to Ali Traders*');
  L.push('• Expense: *exp 1200 electricity*');
  L.push('  Add *on 5 jun* or *on yesterday* for a specific date');
  L.push('', 'Reply *0* for this menu.');
  return L.join('\n');
}

/* ════════════════ CUSTOMER side ════════════════ */
function custFlags(s) { return { balance: s.bot_show_balance !== false, bills: s.bot_show_bills !== false, payments: s.bot_show_payments !== false, statement: s.bot_show_statement !== false, docs: s.bot_doc_request !== false }; }
function custIntent(text) {
  const t = String(text || '').trim().toLowerCase();
  if (['0', 'menu', 'hi', 'hello', 'hey', 'start', '?', 'help'].includes(t)) return 'menu';
  if (['1', 'balance', 'bal', 'khata', 'due', 'dues', 'outstanding'].includes(t)) return 'balance';
  if (['2', 'bill', 'bills', 'invoice', 'invoices'].includes(t)) return 'bills';
  if (['3', 'payment', 'payments', 'paid', 'receipt', 'receipts'].includes(t)) return 'payments';
  if (['4', 'statement', 'account', 'history', 'ledger'].includes(t)) return 'statement';
  return null;
}
function custMenu(party, shop, settings, flags) {
  const L = [`👋 *Hello ${party.party_name || 'Customer'}!*`, `This is *${shop}* — self-service.`];
  if (settings.bot_welcome) L.push(settings.bot_welcome);
  L.push('', 'Reply with a number:');
  if (flags.balance) L.push('*1*  💰  Account balance');
  if (flags.bills) L.push('*2*  🧾  Recent bills');
  if (flags.payments) L.push('*3*  💵  Payments received');
  if (flags.statement) L.push('*4*  📄  Statement (PDF)');
  if (flags.docs) L.push('', '📎 Have a bill or receipt number? Send it (e.g. *14388*) for the PDF.');
  L.push('', 'Reply *0* anytime for this menu.');
  return L.join('\n');
}
function balanceMsg(party) {
  const b = Number(party.current_balance || 0);
  const body = Math.abs(b) < 0.01 ? 'Your account is fully settled. Thank you! ✅' : b > 0 ? `Your outstanding balance is *${amt(b)}*.` : `You have an advance/credit of *${amt(b)}* with us.`;
  return `💰 *Account Balance*\n\n${body}\n\nReply *0* for the menu.`;
}
async function billsMsg(models, party, flags) {
  const rows = await models.SalesBill.findAll({ where: { customer_id: party.party_id }, order: [['bill_date', 'DESC'], ['sales_bill_id', 'DESC']], limit: 8 });
  const bills = rows.filter((b) => !b.is_cancelled).slice(0, 5);
  if (!bills.length) return '🧾 No recent bills found.\n\nReply *0* for the menu.';
  const L = [`🧾 *Your last ${bills.length} bill(s)*`, ''];
  for (const b of bills) { const due = Number(b.balance_amount || 0); L.push(`*Bill ${b.bill_number || ''}*  ·  ${dt(b.bill_date)}`); L.push(`   Total ${amt0(b.total_amount)}${due > 0.01 ? `  ·  Due ${amt0(due)}` : '  ·  ✅ Paid'}`); L.push(''); }
  if (flags.docs) L.push(`📎 Reply with a bill number (e.g. *${bills[0].bill_number || ''}*) to get its PDF.`);
  L.push('Reply *0* for the menu.');
  return L.join('\n');
}
async function paymentsMsg(models, party, flags) {
  const rows = await models.PaymentReceipt.findAll({ where: { party_id: party.party_id, transaction_type: 'Receipt' }, order: [['transaction_date', 'DESC'], ['transaction_id', 'DESC']], limit: 8 });
  const pays = rows.filter((p) => !p.is_cancelled).slice(0, 5);
  if (!pays.length) return '💵 No recent payments found.\n\nReply *0* for the menu.';
  const L = [`💵 *Your last ${pays.length} payment(s)*`, ''];
  for (const p of pays) { L.push(`*Receipt ${p.transaction_number || ''}*  ·  ${dt(p.transaction_date)}`); L.push(`   ${amt0(p.total_amount)} received`); L.push(''); }
  if (flags.docs) L.push(`📎 Reply with a receipt number (e.g. *${pays[0].transaction_number || ''}*) to get its PDF.`);
  L.push('Reply *0* for the menu.');
  return L.join('\n');
}
async function customerDoc(models, party, raw, shop, sendText, sendDoc) {
  const num = String(raw || '').trim().replace(/\s+/g, '');
  if (!/\d{2,}/.test(num)) return false;
  const bill = await models.SalesBill.findOne({ where: { customer_id: party.party_id, is_cancelled: false, [Op.or]: [{ bill_number: num }, { bill_number: { [Op.iLike]: `%${num}` } }] }, order: [['bill_date', 'DESC']] });
  if (bill) {
    try { const items = await models.SalesBillItem.findAll({ where: { sales_bill_id: bill.sales_bill_id }, order: [['item_id', 'ASC']] }); const company = await companyInfo(models);
      const pdf = buildBillPdf({ shop, company, bill: bill.toJSON(), items: items.map((i) => i.toJSON()), party });
      const due = Number(bill.balance_amount || 0);
      await sendDoc(pdf, `Bill-${safeName(bill.bill_number)}.pdf`, `🧾 Bill ${bill.bill_number} — ${amt(bill.total_amount)}${due > 0.01 ? ` (due ${amt(due)})` : ''}`); return true;
    } catch (e) { console.error('[whatsapp] bill PDF failed:', e.message); await sendText(`Bill ${bill.bill_number}: total ${amt(bill.total_amount)}, due ${amt(bill.balance_amount)}.\n\nReply *0* for the menu.`); return true; }
  }
  const rc = await models.PaymentReceipt.findOne({ where: { party_id: party.party_id, is_cancelled: false, transaction_type: 'Receipt', [Op.or]: [{ transaction_number: num }, { transaction_number: { [Op.iLike]: `%${num}` } }] }, order: [['transaction_date', 'DESC']] });
  if (rc) {
    try { const company = await companyInfo(models); const pdf = buildReceiptPdf({ shop, company, receipt: rc.toJSON(), party, balanceAfter: party.current_balance });
      await sendDoc(pdf, `Receipt-${safeName(rc.transaction_number)}.pdf`, `💵 Receipt ${rc.transaction_number} — ${amt(rc.total_amount)} received`); return true;
    } catch (e) { console.error('[whatsapp] receipt PDF failed:', e.message); await sendText(`Receipt ${rc.transaction_number}: ${amt(rc.total_amount)} on ${dt(rc.transaction_date)}.\n\nReply *0* for the menu.`); return true; }
  }
  await sendText(`We couldn’t find bill / receipt *${num}* on your account.\n\nReply *2* for bills, *3* for payments, or *0* for the menu.`);
  return true;
}

/* ════════════════ SUPPLIER self-service ════════════════ */
function supFlags(s) { const m = parseMap(s.bot_supplier_panel); return { enabled: on(m, 'enabled'), balance: on(m, 'balance'), bills: on(m, 'bills'), payments: on(m, 'payments'), statement: on(m, 'statement') }; }
function supMenu(party, shop, flags) {
  const L = [`👋 *Hello ${party.party_name || 'Partner'}!*`, `This is *${shop}* — supplier self-service.`, '', 'Reply with a number:'];
  if (flags.balance) L.push('*1*  💰  Balance (what we owe you)');
  if (flags.bills) L.push('*2*  📦  Recent purchase bills');
  if (flags.payments) L.push('*3*  💸  Payments we made');
  if (flags.statement) L.push('*4*  📄  Statement (PDF)');
  L.push('', 'Reply *0* anytime for this menu.');
  return L.join('\n');
}

/* ════════════════ Daily owner digest (auto-sent) ════════════════ */
// Concise end-of-day summary pushed to owners. Deliberately omits low-stock
// (per the owner's preference) — focuses on the day's money + position.
async function buildDailyDigest(models, shop) {
  const today = dayOffset(0);
  const w = { bill_date: { [Op.gte]: today }, is_cancelled: false };
  const [sales, count, credit, collected, receivable, topCust, cashRows, chN, chSum] = await Promise.all([
    models.SalesBill.sum('total_amount', { where: w }),
    models.SalesBill.count({ where: w }),
    models.SalesBill.sum('balance_amount', { where: w }),
    models.PaymentReceipt.sum('total_amount', { where: { transaction_type: 'Receipt', is_cancelled: false, transaction_date: { [Op.gte]: today } } }),
    models.Party.sum('current_balance', { where: { current_balance: { [Op.gt]: 0 } } }),
    models.SalesBill.sequelize.query(
      `SELECT p.party_name, SUM(sb.total_amount)::float amt FROM sales_bills sb JOIN parties p ON p.party_id = sb.customer_id
        WHERE sb.is_cancelled = false AND sb.bill_date >= :t AND sb.customer_id IS NOT NULL
        GROUP BY p.party_name ORDER BY amt DESC LIMIT 1`, { replacements: { t: today }, type: QueryTypes.SELECT }),
    models.SalesBill.sequelize.query(
      `SELECT ((CASE WHEN la.opening_balance_type='Credit' THEN -1 ELSE 1 END) * COALESCE(la.opening_balance,0)
               + COALESCE((SELECT SUM(le.debit_amount - le.credit_amount) FROM ledger_entries le
                    WHERE le.ledger_id = la.ledger_id AND le.reversal_of_id IS NULL
                      AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)), 0))::float bal
         FROM ledger_accounts la WHERE la.is_active = true AND la.sub_group IN ('Cash-in-Hand','Bank Accounts')`, { type: QueryTypes.SELECT }),
    models.Cheque.count({ where: { status: 'PENDING' } }),
    models.Cheque.sum('amount', { where: { status: 'PENDING' } }),
  ]);
  const s = Number(sales || 0), n = Number(count || 0), cr = Number(credit || 0), col = Number(collected || 0);
  const cash = (cashRows || []).reduce((a, r) => a + Number(r.bal || 0), 0);
  const L = [`🌙 *${shop} — Daily Digest*`, dt(new Date()), '', '*📊 Today*',
    `🧾 Sales: *${amt(s)}*  (${n} bill${n === 1 ? '' : 's'})`, `💵 Collected: *${amt(col)}*`];
  if (cr > 0.01) L.push(`⏳ On credit: ${amt(cr)}`);
  if (n > 0) L.push(`📈 Avg bill: ${amt(s / n)}`);
  if (topCust && topCust[0]) L.push(`🏆 Top customer: ${topCust[0].party_name} (${amt0(topCust[0].amt)})`);
  L.push('', `📥 Receivables: *${amt(receivable || 0)}* to collect`, `🏦 Cash & bank: *${amt(cash)}* on hand`);
  if (Number(chN || 0) > 0) L.push(`💳 Cheques to deposit: ${Number(chN)} · ${amt0(chSum || 0)}`);
  L.push('', '_Auto-sent by your WhatsApp bot. Send 0 anytime for the full menu._');
  return L.join('\n');
}

/* ════════════════ Entry point ════════════════ */
async function handle(ctx) {
  const { companyId, fromNumber, text, settings, withCompany, sendText, sendDoc } = ctx;
  if (!settings || !settings.bot_enabled) return;
  const last10 = String(fromNumber || '').replace(/\D/g, '').slice(-10);
  if (last10.length < 10) return;
  if (!allow(`${companyId}:${last10}`)) return;

  const isOwner = inList(parseList(settings.bot_owner_numbers), last10);
  if (!isOwner && inList(parseList(settings.bot_blocked), last10)) return;

  await withCompany(companyId, async (models, sequelize) => {
    const sys = await models.SystemSettings.findOne();
    const shop = (sys && sys.company_name) || 'us';
    const raw = String(text || '').trim();
    const t = raw.toLowerCase();

    // ── OWNER PANEL ──
    if (isOwner) {
      const panel = parseMap(settings.bot_owner_panel);
      const sf = stockFlags(settings);
      const sk = `${companyId}:${last10}`;

      // Abort any pending entry session on "cancel" / "no"
      if (/^(?:no|n|cancel|nahi|band|chodo)$/.test(t) && getSession(sk)) {
        clearSession(sk);
        return void await sendText('❌ Cancelled.\n\nReply *0* for the menu.');
      }
      // Continue an active entry session
      const session = getSession(sk);
      if (session) return void await continueSession(session, sk, t, models, sequelize, sendText, sendDoc, shop, companyId);

      const runIf = async (key, fn) => on(panel, key) ? sendText(await fn()) : sendText(ownerMenu(shop, panel, sf.lookup));
      if (['0', 'menu', 'hi', 'hello', 'hey', 'start', '?', 'help'].includes(t)) return void await sendText(ownerMenu(shop, panel, sf.lookup));
      // Stock prefixes (gated)
      let m;
      if (sf.lookup) {
        if ((m = raw.match(/^a[\s:.\-]+(.+)$/i))) return void await sendText(await stockByArticle(models, m[1], sf));
        if ((m = raw.match(/^b[\s:.\-]+(.+)$/i))) return void await sendText(await stockByBarcode(models, m[1], sf));
        if ((m = raw.match(/^s[\s:.\-]+(.+)$/i))) return void await sendText(await stockByName(models, m[1], sf));
      }
      if (on(panel, 'supplier_lookup') && (m = raw.match(/^sup(?:plier)?[\s:.\-]+(.+)$/i))) return void await sendText(await ownerFind(models, m[1], 'Supplier'));
      if ((m = raw.match(/^(?:pdf|statement)\s+(.+)$/i))) return void await ownerSendStatement(models, m[1], shop, sendDoc, sendText);
      // Numbered reports (fixed mapping; gated)
      if (/^\d{1,2}$/.test(t)) {
        const key = OWNER_NUM[parseInt(t, 10)];
        if (key) {
          if (!on(panel, key)) return void await sendText(ownerMenu(shop, panel, sf.lookup));
          switch (key) {
            case 'today': return void await sendText(await bizSummary(models, dayOffset(0), null, 'Today', dt(new Date())));
            case 'yesterday': return void await sendText(await bizSummary(models, dayOffset(-1), dayOffset(0), 'Yesterday', dt(new Date(Date.now() - 864e5))));
            case 'week': return void await sendText(await bizSummary(models, dayOffset(-6), null, 'Last 7 days'));
            case 'month': return void await sendText(await bizSummary(models, monthStr(), null, new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })));
            case 'receivables': return void await sendText(await ownerReceivables(models));
            case 'payables': return void await sendText(await ownerPayables(models));
            case 'low_stock': return void await sendText(await ownerLowStock(models));
            case 'top_products': return void await sendText(await ownerTopProducts(models));
            case 'top_customers': return void await sendText(await ownerTopCustomers(models));
            case 'cash_bank': return void await sendText(await ownerCashBank(models));
            case 'expenses': return void await sendText(await ownerExpenses(models));
            case 'cheques': return void await sendText(await ownerCheques(models));
          }
        }
      }
      // ── Entry creation via natural language (owner only) ──
      if (looksLikeEntryIntent(raw)) {
        const intent = parseOwnerIntent(raw);
        if (intent && intent.amount > 0) return void await startEntryFlow(intent, sk, models, sendText);
      }
      // Free text → customer/supplier name lookup (if enabled)
      if (on(panel, 'customer_lookup') || on(panel, 'supplier_lookup')) {
        const kind = on(panel, 'customer_lookup') && on(panel, 'supplier_lookup') ? null : (on(panel, 'customer_lookup') ? 'Customer' : 'Supplier');
        return void await sendText(await ownerFind(models, raw, kind));
      }
      return void await sendText(ownerMenu(shop, panel, sf.lookup));
    }

    // ── Identify the party by number ──
    const parties = await models.Party.findAll({ where: { [Op.or]: [{ mobile_1: { [Op.like]: `%${last10}` } }, { mobile_2: { [Op.like]: `%${last10}` } }] }, limit: 3 });
    const party = parties[0];
    if (!party) return void await sendText(`Hello!\n\nWe couldn’t find your account from this chat. Please contact *${shop}* directly and we’ll help you.`);

    // ── SUPPLIER self-service ──
    if (party.party_type === 'Supplier') {
      const f = supFlags(settings);
      if (!f.enabled) return void await sendText(`Hello ${party.party_name}! For account details please contact *${shop}* directly.`);
      const intent = custIntent(raw);
      if (intent === 'menu' || (intent && !f[intent === 'balance' ? 'balance' : intent === 'bills' ? 'bills' : intent === 'payments' ? 'payments' : 'statement'])) return void await sendText(supMenu(party, shop, f));
      if (intent === 'balance') { const b = Number(party.current_balance || 0); const body = Math.abs(b) < 0.01 ? 'Your account is settled. ✅' : b < 0 ? `We owe you *${amt(b)}*.` : `You hold an advance of *${amt(b)}* from us.`; return void await sendText(`💰 *Balance*\n\n${body}\n\nReply *0* for the menu.`); }
      if (intent === 'bills') { const rows = await models.PurchaseBill.findAll({ where: { supplier_id: party.party_id }, order: [['bill_date', 'DESC']], limit: 8 }); const bs = rows.filter((b) => !b.is_cancelled).slice(0, 5); if (!bs.length) return void await sendText('📦 No recent purchase bills.\n\nReply *0* for the menu.'); const L = [`📦 *Your last ${bs.length} bill(s) to us*`, '']; bs.forEach((b) => { const due = Number(b.balance_amount || 0); L.push(`*Bill ${b.bill_number || ''}*  ·  ${dt(b.bill_date)}`); L.push(`   ${amt0(b.total_amount)}${due > 0.01 ? `  ·  unpaid ${amt0(due)}` : '  ·  ✅ paid'}`); L.push(''); }); L.push('Reply *0* for the menu.'); return void await sendText(L.join('\n')); }
      if (intent === 'payments') { const rows = await models.PaymentReceipt.findAll({ where: { party_id: party.party_id, transaction_type: 'Payment' }, order: [['transaction_date', 'DESC']], limit: 8 }); const ps = rows.filter((p) => !p.is_cancelled).slice(0, 5); if (!ps.length) return void await sendText('💸 No recent payments.\n\nReply *0* for the menu.'); const L = [`💸 *Last ${ps.length} payment(s) we made*`, '']; ps.forEach((p) => L.push(`• ${dt(p.transaction_date)} — ${amt0(p.total_amount)} (${p.transaction_number || ''})`)); L.push('', 'Reply *0* for the menu.'); return void await sendText(L.join('\n')); }
      if (intent === 'statement') { try { const built = await makeStatementPdf(party, shop); if (built && sendDoc) { await sendDoc(built.pdf, built.fname, `Statement — closing ${drcr(built.closing)}`); return; } } catch (e) { console.error('[whatsapp] supplier statement failed:', e.message); } return void await sendText(`Balance: ${drcr(party.current_balance)}.\n\nReply *0* for the menu.`); }
      return void await sendText(supMenu(party, shop, f));
    }

    // ── CUSTOMER self-service ──
    const flags = custFlags(settings);
    const intent = custIntent(raw);
    if (intent === 'menu' || (intent && !flags[intent])) return void await sendText(custMenu(party, shop, settings, flags));
    if (intent === 'balance') return void await sendText(balanceMsg(party));
    if (intent === 'bills') return void await sendText(await billsMsg(models, party, flags));
    if (intent === 'payments') return void await sendText(await paymentsMsg(models, party, flags));
    if (intent === 'statement') {
      try { const built = await makeStatementPdf(party, shop); if (built && sendDoc) { await sendDoc(built.pdf, built.fname, `Account statement — closing ${drcr(built.closing)}`); return; } }
      catch (e) { console.error('[whatsapp] statement PDF failed:', e.message); }
      const rows = await models.SalesBill.findAll({ where: { customer_id: party.party_id }, order: [['bill_date', 'DESC']], limit: 6 });
      const L = ['📋 *Recent activity*', '']; rows.filter((b) => !b.is_cancelled).slice(0, 5).forEach((b) => L.push(`• ${dt(b.bill_date)}  Bill ${b.bill_number || ''} — ${amt(b.total_amount)}`));
      L.push('', `*Balance: ${drcr(party.current_balance)}*`, '', 'Reply *0* for the menu.'); return void await sendText(L.join('\n'));
    }
    if (flags.docs && await customerDoc(models, party, raw, shop, sendText, sendDoc)) return;
    return void await sendText(custMenu(party, shop, settings, flags));
  });
}

module.exports = { handle, buildDailyDigest };
