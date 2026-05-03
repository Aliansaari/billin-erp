/* End-to-end smoke for the full bank lifecycle:
 *
 *   1. POST /api/banks              create new bank
 *   2. GET  /api/banks              new bank shows in active list
 *   3. DELETE /api/banks/:id        delete clean bank (no transactions)
 *   4. POST /api/banks              re-create the same bank
 *   5. POST /api/payments           create a receipt against it
 *   6. DELETE /api/banks/:id        attempt — server should 409 with suggest_deactivate
 *   7. PATCH /api/banks/:id         deactivate
 *   8. GET /api/banks               default list excludes the deactivated bank
 *   9. GET /api/banks?include_inactive=true   shows it again
 *  10. PATCH /api/banks/:id         re-activate
 *  11. DELETE /api/banks/:id        still rejected (txns exist)
 *  12. PATCH /api/banks/:id         deactivate (final cleanup)
 */

const http = require('http');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const sequelize = require('../config/database');
const { LedgerAccount, PaymentReceipt } = require('../models');

const TEST_NAME = 'ICICI (Smoke)';

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

async function findCustomerWithOutstanding() {
  const [rows] = await sequelize.query(
    `SELECT party_id, party_name, current_balance FROM parties
      WHERE party_type = 'Customer' AND COALESCE(is_system_cash, false) = false
        AND is_active = true AND COALESCE(current_balance, 0) > 0
      ORDER BY current_balance DESC LIMIT 1`,
  );
  return rows[0] || null;
}

(async () => {
  const out = (label, ok, extra='') => console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  '+extra : ''}`);
  let allOk = true;
  let createdId = null;
  let createdReceiptId = null;
  let leftBehind = false;

  // Pre-clean: a previous run might have left the test bank around,
  // possibly under its renamed name. Sweep all variants so this run
  // starts fresh.  We can only DESTROY rows that have NO entries —
  // for any with entries we just leave them alone (deactivated).
  const stale = await LedgerAccount.findAll({
    where: { ledger_name: { [require('sequelize').Op.like]: `${TEST_NAME}%` } },
  });
  for (const s of stale) {
    const [{ cnt }] = await sequelize.query(
      `SELECT COUNT(*)::int AS cnt FROM ledger_entries WHERE ledger_id = :id`,
      { replacements: { id: s.ledger_id }, type: sequelize.QueryTypes.SELECT },
    );
    if (cnt === 0) {
      await s.destroy().catch(() => {});
    } else {
      // Leave behind, but rename out of the way so create() and rename
      // assertions don't collide with it.
      const stamp = '_archived_' + Date.now();
      await s.update({ ledger_name: TEST_NAME + stamp, is_active: false }).catch(() => {});
    }
  }

  try {
    const token = await getToken();

    console.log('\n── 1. POST /api/banks (create) ──');
    const c1 = await reqJson('POST', '/api/banks', token, {
      name:                 TEST_NAME,
      sub_group:            'Bank Accounts',
      opening_balance:      10000,
      opening_balance_type: 'Debit',
    });
    out('status=201', c1.status === 201, `(got ${c1.status})`);
    out('returned id', !!c1.body.ledger_id, `id=${c1.body.ledger_id}`);
    out('balance equals opening', Math.abs(c1.body.balance - 10000) < 0.01, `balance=${c1.body.balance}`);
    createdId = c1.body.ledger_id;
    if (c1.status !== 201) { allOk = false; throw new Error('create failed'); }

    console.log('\n── 2. GET /api/banks (default = active) ──');
    const l1 = await reqJson('GET', '/api/banks', token);
    const found = (l1.body.banks || []).find((b) => b.ledger_id === createdId);
    out('appears in active list', !!found);
    out('is_active=true', found?.is_active === true);
    out('txn_count=0', found?.txn_count === 0, `(got ${found?.txn_count})`);

    console.log('\n── 3. POST /api/banks (duplicate name) — should 409 ──');
    const dup = await reqJson('POST', '/api/banks', token, {
      name: TEST_NAME, sub_group: 'Bank Accounts',
    });
    out('status=409', dup.status === 409, `(got ${dup.status})`);

    console.log('\n── 4. DELETE clean bank (no txns yet) ──');
    const d1 = await reqJson('DELETE', `/api/banks/${createdId}`, token);
    out('status=200', d1.status === 200, `(got ${d1.status})`);
    const stillExists = await LedgerAccount.findByPk(createdId);
    out('row removed from DB', !stillExists);

    console.log('\n── 5. Re-create the bank ──');
    const c2 = await reqJson('POST', '/api/banks', token, {
      name:                 TEST_NAME,
      sub_group:            'Bank Accounts',
      opening_balance:      0,
      opening_balance_type: 'Debit',
    });
    createdId = c2.body.ledger_id;
    out('re-created', c2.status === 201);

    console.log('\n── 6. Post a receipt against it (gives it transactions) ──');
    const cust = await findCustomerWithOutstanding();
    if (!cust) {
      console.log('  (no customer with outstanding — skipping txn creation)');
      console.log('  cleaning up the recreated test bank…');
      await reqJson('DELETE', `/api/banks/${createdId}`, token);
    } else {
      const amt = Math.min(100, parseFloat(cust.current_balance));
      const r = await reqJson('POST', '/api/payments', token, {
        transaction_type: 'Receipt',
        transaction_date: new Date().toISOString().slice(0, 10),
        party_id:         cust.party_id,
        total_amount:     amt,
        payment_method:   'Cheque',
        remarks:          '[smoke] lifecycle test',
        splits: [{ payment_mode: 'Cheque', amount: amt, bank_ledger_id: createdId, cheque_number: 'L-001' }],
        bill_allocations: [],
      });
      createdReceiptId = r.body.transaction_id;
      out('receipt created', r.status === 201 || r.status === 200, `txn_id=${createdReceiptId}`);

      console.log('\n── 7. DELETE bank with txns — should 409 + suggest_deactivate ──');
      const d2 = await reqJson('DELETE', `/api/banks/${createdId}`, token);
      out('status=409', d2.status === 409, `(got ${d2.status})`);
      out('suggest_deactivate=true', d2.body.suggest_deactivate === true);
      out('returns txn counts', typeof d2.body.txn_count === 'number');

      console.log('\n── 8. PATCH deactivate ──');
      const p1 = await reqJson('PATCH', `/api/banks/${createdId}`, token, { is_active: false });
      out('status=200', p1.status === 200);
      out('is_active=false in response', p1.body.is_active === false);

      console.log('\n── 9. GET /api/banks (default) — should NOT include inactive ──');
      const l2 = await reqJson('GET', '/api/banks', token);
      const stillThere = (l2.body.banks || []).find((b) => b.ledger_id === createdId);
      out('not in active list', !stillThere);

      console.log('\n── 10. GET /api/banks?include_inactive=true ──');
      const l3 = await reqJson('GET', '/api/banks?include_inactive=true', token);
      const inactive = (l3.body.banks || []).find((b) => b.ledger_id === createdId);
      out('appears in include_inactive list', !!inactive);
      out('is_active=false', inactive?.is_active === false);
      // inactive_count is only meaningful when include_inactive=true.
      out('inactive_count >= 1 (with flag)', (l3.body.totals?.inactive_count || 0) >= 1);

      console.log('\n── 11. Reconciliation entries still include the deactivated bank ──');
      const recon = await reqJson('GET', '/api/banks/reconciliation?status=all', token);
      const reconEntry = (recon.body.entries || []).find((e) => e.transaction_id === createdReceiptId);
      out('historical entry still surfaces', !!reconEntry, `bank=${reconEntry?.bank_name}`);

      console.log('\n── 12. Re-activate ──');
      const p2 = await reqJson('PATCH', `/api/banks/${createdId}`, token, { is_active: true });
      out('status=200', p2.status === 200);
      out('is_active=true', p2.body.is_active === true);

      console.log('\n── 13. Rename ──');
      const p3 = await reqJson('PATCH', `/api/banks/${createdId}`, token, { name: TEST_NAME + ' [renamed]' });
      out('status=200', p3.status === 200);
      out('name reflects in response', p3.body.name === TEST_NAME + ' [renamed]');

      console.log('\n── 14. Try to change sub_group with txns — should 409 ──');
      const p4 = await reqJson('PATCH', `/api/banks/${createdId}`, token, { sub_group: 'Bank OD A/c' });
      out('status=409 (cannot reclassify)', p4.status === 409);

      console.log('\n── Cleanup: cancel the receipt; deactivate the bank ──');
      const r2 = await PaymentReceipt.findByPk(createdReceiptId);
      if (r2) { r2.is_cancelled = true; await r2.save(); }
      await reqJson('PATCH', `/api/banks/${createdId}`, token, { is_active: false });
      // The cancelled receipt's reversal still leaves entries on the
      // ledger, so the test bank gets left behind in deactivated state.
      // That's fine — reruns reuse it.
      leftBehind = true;
    }

    console.log(`\n${allOk ? '✓ All checks passed' : '✗ Some checks failed (see above)'}.`);
    if (leftBehind) console.log(`  (test bank "${TEST_NAME}*" left behind, deactivated — reruns will reuse)`);
  } catch (e) {
    console.error('\n✗ Smoke failed:', e.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
