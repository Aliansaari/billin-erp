/* End-to-end smoke for the bank_ledger_id wiring.
 *
 *   1. Create a brand-new "HDFC (Test)" bank ledger.
 *   2. Find any non-cash customer.
 *   3. POST /api/payments with a Receipt for ₹5000 paid by Cheque,
 *      passing bank_ledger_id of the new bank.
 *   4. GET /api/banks/<HDFC>/statement — assert the receipt shows up.
 *   5. GET /api/banks/reconciliation — assert it shows in uncleared.
 *   6. Cleanup: cancel the receipt and delete the test bank ledger so
 *      reruns are idempotent.
 */

const http = require('http');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const sequelize = require('../config/database');
const { LedgerAccount, PaymentReceipt } = require('../models');

const TEST_BANK_NAME = 'HDFC (Test)';

function reqJson(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      host: 'localhost', port: 3001, path, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function getToken() {
  const [rows] = await sequelize.query(
    `SELECT u.user_id, u.username, r.role_name
       FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
      WHERE u.is_active = true ORDER BY u.user_id ASC LIMIT 1`,
  );
  const u = rows[0];
  return jwt.sign(
    { user_id: u.user_id, username: u.username, role: u.role_name },
    process.env.JWT_SECRET, { expiresIn: '5m' },
  );
}

async function ensureTestBank() {
  let bank = await LedgerAccount.findOne({ where: { ledger_name: TEST_BANK_NAME } });
  if (bank) return bank;

  // Copy the ledger_group string from an existing bank ledger so the
  // test row mirrors whatever convention the seed uses.
  const seed = await LedgerAccount.findOne({ where: { sub_group: 'Bank Accounts' } });
  if (!seed) throw new Error('No existing bank ledger to copy ledger_group from');

  bank = await LedgerAccount.create({
    ledger_name:  TEST_BANK_NAME,
    ledger_group: seed.ledger_group,
    sub_group:    'Bank Accounts',
    opening_balance: 0,
    opening_balance_type: 'Debit',
    is_active: true,
    is_system_ledger: false,
  });
  return bank;
}

async function findCreditCustomer() {
  // Receipt creation rejects if amount > outstanding, so we want a
  // customer who currently owes something. Pick the one with the
  // largest receivable so we can post any reasonable amount.
  const [rows] = await sequelize.query(
    `SELECT party_id, party_name, current_balance FROM parties
      WHERE party_type = 'Customer'
        AND COALESCE(is_system_cash, false) = false
        AND is_active = true
        AND COALESCE(current_balance, 0) > 0
      ORDER BY current_balance DESC LIMIT 1`,
  );
  if (rows.length) return rows[0];
  // Fallback: any customer (we'll set the amount low)
  const [any] = await sequelize.query(
    `SELECT party_id, party_name, current_balance FROM parties
      WHERE party_type = 'Customer' AND COALESCE(is_system_cash, false) = false AND is_active = true
      ORDER BY party_id ASC LIMIT 1`,
  );
  if (!any.length) throw new Error('No non-cash customer found');
  return any[0];
}

(async () => {
  let createdReceiptId = null;
  let bankId = null;
  let testBankCreated = false;
  try {
    const token = await getToken();
    console.log('── 1. Setup ──');
    const existingBank = await LedgerAccount.findOne({ where: { ledger_name: TEST_BANK_NAME } });
    testBankCreated = !existingBank;
    const bank = await ensureTestBank();
    bankId = bank.ledger_id;
    console.log(`  test bank: ${bank.ledger_name} (id=${bankId})${testBankCreated ? ' [created]' : ' [reused]'}`);
    const cust = await findCreditCustomer();
    const outstanding = parseFloat(cust.current_balance) || 0;
    console.log(`  customer:  ${cust.party_name} (id=${cust.party_id}) outstanding=₹${outstanding}`);

    // Pay the smaller of 5000 or what the customer actually owes — so
    // the smoke test works against any seeded customer mix.
    const amount = outstanding > 0 ? Math.min(5000, outstanding) : 5000;
    console.log(`  amount:    ₹${amount}`);

    console.log('\n── 2. Create cheque receipt against test bank ──');
    const payload = {
      transaction_type: 'Receipt',
      transaction_date: new Date().toISOString().slice(0, 10),
      party_id:         cust.party_id,
      total_amount:     amount,
      payment_method:   'Cheque',
      remarks:          '[smoke] bank_ledger_id wiring test',
      splits: [{
        payment_mode:   'Cheque',
        amount:         amount,
        bank_ledger_id: bankId,
        cheque_number:  'TEST-12345',
      }],
      bill_allocations: [],
    };
    const c = await reqJson('POST', '/api/payments', token, payload);
    if (c.status !== 201 && c.status !== 200) {
      console.log(`  FAIL status=${c.status}`, c.body);
      throw new Error('Create receipt failed');
    }
    createdReceiptId = c.body.transaction_id;
    console.log(`  ok  status=${c.status} txn_id=${createdReceiptId} number=${c.body.transaction_number}`);

    console.log('\n── 3. Verify the entry hit the test bank\'s statement ──');
    const s = await reqJson('GET', `/api/banks/${bankId}/statement?from_date=2020-01-01&to_date=2099-12-31`, token);
    const entries = s.body.entries || [];
    const ours = entries.filter((e) => e.transaction_id === createdReceiptId);
    console.log(`  bank statement: ${entries.length} entries, ours found: ${ours.length}`);
    if (ours.length === 0) throw new Error('FAIL: receipt did NOT post to the test bank ledger');
    const e = ours[0];
    console.log(`  matched row: deposit=${e.deposit} cheque="${e.cheque}" cleared=${!!e.cleared_at}`);
    if (Math.abs(e.deposit - amount) > 0.01) throw new Error(`FAIL: expected deposit ${amount}, got ${e.deposit}`);

    console.log('\n── 4. Verify it appears in cross-bank Reconciliation (uncleared) ──');
    const r = await reqJson('GET', '/api/banks/reconciliation?status=uncleared', token);
    const rentries = r.body.entries || [];
    const rours = rentries.filter((x) => x.transaction_id === createdReceiptId);
    console.log(`  reconciliation: ${rentries.length} uncleared entries, ours: ${rours.length}`);
    if (rours.length === 0) throw new Error('FAIL: receipt missing from reconciliation view');
    const ro = rours[0];
    console.log(`  bank=${ro.bank_name} deposit=${ro.deposit} days=${ro.days_outstanding} cheque=${ro.cheque}`);
    if (ro.bank_id !== bankId) throw new Error(`FAIL: posted to wrong bank (got ${ro.bank_id}, expected ${bankId})`);

    console.log('\n── 5. Verify the legacy "Bank Account" was NOT touched ──');
    const legacy = await LedgerAccount.findOne({ where: { ledger_name: 'Bank Account' } });
    if (legacy) {
      const ls = await reqJson('GET', `/api/banks/${legacy.ledger_id}/statement?from_date=2020-01-01&to_date=2099-12-31`, token);
      const legacyOurs = (ls.body.entries || []).filter((e) => e.transaction_id === createdReceiptId);
      console.log(`  legacy bank statement: ${ls.body.entries?.length || 0} entries, ours wrongly here: ${legacyOurs.length}`);
      if (legacyOurs.length > 0) throw new Error('FAIL: receipt also posted to legacy Bank Account ledger (regression)');
    } else {
      console.log('  no legacy Bank Account ledger found — skipped');
    }

    console.log('\n✓ All assertions passed.  bank_ledger_id wiring is end-to-end.');
  } catch (e) {
    console.error('\n✗ Smoke test failed:', e.message);
    process.exitCode = 1;
  } finally {
    // Cleanup so the test is idempotent.
    if (createdReceiptId) {
      try {
        const r = await PaymentReceipt.findByPk(createdReceiptId);
        if (r) { r.is_cancelled = true; await r.save(); }
      } catch (e) { console.warn('cleanup receipt failed:', e.message); }
    }
    if (testBankCreated && bankId) {
      try {
        // Only delete if no entries remain on it
        const [[{ cnt }]] = await sequelize.query(
          `SELECT COUNT(*)::int AS cnt FROM ledger_entries WHERE ledger_id = :id`,
          { replacements: { id: bankId } },
        );
        if (cnt === 0) {
          await LedgerAccount.destroy({ where: { ledger_id: bankId } });
        } else {
          console.log(`  (left test bank ledger in place — ${cnt} entries posted to it)`);
        }
      } catch (e) { console.warn('cleanup test bank failed:', e.message); }
    }
    await sequelize.close();
  }
})();
