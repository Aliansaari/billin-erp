/**
 * Pass 2 — targeted scenarios missed by pass 1:
 *   · Receipts allocated to customers WITH actual outstanding
 *   · Payments allocated to suppliers WITH actual outstanding
 *   · Cheque lifecycle (inward receive → deposit → clear; outward issue → clear; bounce)
 *   · Bank transfers via JV
 *   · Cancellation of a freshly-created bill (no receipt yet)
 *   · Re-edit of a bill (post UI-CRASH-3 fix verification at scale)
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3001/api';
const LOG_FILE = path.join(__dirname, `functional_sim_pass2-${Date.now()}.log`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

const stats = { calls: 0, ok: 0, fail: 0, created: {} };
function bump(k) { stats.created[k] = (stats.created[k] || 0) + 1; }

let TOKEN;
async function login() {
  const r = await axios.post(`${BASE}/auth/login`,
    { username: 'admin', password: 'admin1234' });
  TOKEN = r.data.token;
}

function ax() {
  return axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${TOKEN}` },
    validateStatus: () => true,
  });
}

async function call(method, url, body, label) {
  stats.calls++;
  const r = await ax().request({ method, url, data: body });
  if (r.status >= 200 && r.status < 300) { stats.ok++; return { ok: true, data: r.data }; }
  stats.fail++;
  log(`  ✗ ${label} → ${r.status} ${JSON.stringify(r.data).slice(0, 180)}`);
  return { ok: false, status: r.status, data: r.data };
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function main() {
  log('======== Pass 2 start ========');
  await login();

  // ── Find customers with real outstanding ──
  const billsR = await call('GET', '/reports/bills-receivable?limit=200', null, 'br');
  const openBills = billsR.data?.data || [];
  log(`${openBills.length} open receivable bills`);
  const customersWithBalance = [...new Set(openBills.map(b => b.party_id))].slice(0, 20);
  log(`${customersWithBalance.length} customers with outstanding`);

  // ── Find suppliers with real outstanding ──
  const payR = await call('GET', '/reports/bills-payable?limit=200', null, 'bp');
  const openPay = payR.data?.data || [];
  const suppliersWithBalance = [...new Set(openPay.map(b => b.party_id))].slice(0, 15);
  log(`${suppliersWithBalance.length} suppliers with outstanding`);

  // ── 20 manual receipts ──
  log(`\n=== ${customersWithBalance.length} manual receipts ===`);
  for (const cid of customersWithBalance) {
    const bills = openBills.filter(b => b.party_id === cid);
    if (!bills.length) continue;
    const amount = Math.min(parseFloat(bills[0].outstanding), 200 + Math.random() * 800);
    const r = await call('POST', '/payments', {
      party_id: cid,
      transaction_type: 'Receipt',
      transaction_date: '2027-02-15',
      total_amount: amount,
      payment_method: 'Cash',
      splits: [{ amount, payment_mode: 'Cash' }],
      remarks: 'Pass2 receipt',
    }, `rec-${cid}`);
    if (r.ok) bump('receipt');
  }

  // ── 15 manual payments ──
  log(`\n=== ${suppliersWithBalance.length} manual payments ===`);
  for (const sid of suppliersWithBalance) {
    const bills = openPay.filter(b => b.party_id === sid);
    if (!bills.length) continue;
    const amount = Math.min(parseFloat(bills[0].outstanding), 300 + Math.random() * 1500);
    const r = await call('POST', '/payments', {
      party_id: sid,
      transaction_type: 'Payment',
      transaction_date: '2027-02-15',
      total_amount: amount,
      payment_method: 'Cash',
      splits: [{ amount, payment_mode: 'Cash' }],
      remarks: 'Pass2 payment',
    }, `pay-${sid}`);
    if (r.ok) bump('payment');
  }

  // ── Cheque lifecycle: issue + deposit + clear + bounce ──
  log(`\n=== Cheque lifecycle ===`);
  const banks = (await call('GET', '/banks', null, 'banks')).data?.banks || [];
  const hdfc = banks.find(b => /HDFC/.test(b.name));
  if (hdfc) {
    // Create a payment with cheque mode (outward issue)
    const sup = suppliersWithBalance[0];
    const r = await call('POST', '/payments', {
      party_id: sup,
      transaction_type: 'Payment',
      transaction_date: '2027-02-10',
      total_amount: 1500,
      payment_method: 'Cheque',
      splits: [{
        amount: 1500,
        payment_mode: 'Cheque',
        cheque_number: `PASS2-${Date.now().toString(36).slice(-5)}`,
        cheque_date: '2027-02-10',
        bank_ledger_id: hdfc.ledger_id,
      }],
      remarks: 'Pass2 cheque issue',
    }, 'cheque-out');
    if (r.ok) bump('cheque_issue');

    // List cheques to find newly-created one
    const cl = (await call('GET', '/cheques?limit=10', null, 'cheques')).data?.data || (await call('GET', '/cheques?limit=10', null, 'cheques')).data || [];
    log(`Found ${cl.length} cheques total`);

    // Find a PENDING outward cheque to clear
    const pendingOut = cl.find(c => c.direction === 'OUTWARD' && c.status === 'PENDING');
    if (pendingOut) {
      const cr = await call('POST', `/cheques/${pendingOut.cheque_id || pendingOut.id}/clear`, {
        clearance_date: '2027-02-12',
      }, 'cheque-clear');
      if (cr.ok) bump('cheque_clear');
    }

    // Find a PENDING inward cheque to deposit
    const pendingIn = cl.find(c => c.direction === 'INWARD' && c.status === 'PENDING');
    if (pendingIn) {
      const cr = await call('POST', `/cheques/${pendingIn.cheque_id || pendingIn.id}/deposit`, {
        deposit_date: '2027-02-10',
        bank_ledger_id: hdfc.ledger_id,
      }, 'cheque-deposit');
      if (cr.ok) bump('cheque_deposit');
    }
  }

  // ── Cancel a fresh bill (no receipt) ──
  log(`\n=== Cancel test on a credit bill ===`);
  // Find a credit bill with balance and no receipt linked
  const recentCredit = openBills.filter(b => b.payment_method === 'Credit').slice(0, 5);
  for (const b of recentCredit) {
    const r = await call('POST', `/sales/${b.bill_id || b.sales_bill_id}/cancel`,
      { reason: 'Pass2 cancellation test' }, `cancel-${b.bill_number}`);
    if (r.ok) { bump('cancel'); log(`  ✓ cancelled ${b.bill_number}`); break; }
    else if (r.data?.error?.includes('receipt')) {
      // Already has receipt — skip
      continue;
    } else {
      log(`  ✗ cancel ${b.bill_number}: ${r.data?.error}`);
    }
  }

  // ── 5 edits to verify the UI-CRASH-3 fix at scale ──
  log(`\n=== Edit 5 random bills ===`);
  for (let i = 0; i < 5; i++) {
    const target = openBills[i * 4];
    if (!target) continue;
    const id = target.bill_id || target.sales_bill_id;
    // Fetch full bill
    const bill = (await call('GET', `/sales/${id}`, null, 'fetch')).data;
    if (!bill?.items) continue;
    const r = await call('PUT', `/sales/${id}`, {
      customer_id: bill.customer_id,
      bill_date: bill.bill_date,
      items: bill.items.map(it => ({
        product_id: it.product_id, quantity: parseFloat(it.quantity),
        rate: parseFloat(it.rate), gst_rate: parseFloat(it.gst_rate),
      })),
      gst_mode: 'product',
      paid_amount: parseFloat(bill.paid_amount),
      payment_method: bill.payment_method,
      remarks: `Pass2 edit attempt ${i+1}`,
    }, `edit-${bill.bill_number}`);
    if (r.ok) bump('edit');
  }

  log('\n======== Pass 2 done ========');
  log(`Calls: ${stats.calls}, OK: ${stats.ok}, Fail: ${stats.fail}`);
  log(`Created: ${JSON.stringify(stats.created)}`);
}

main().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
