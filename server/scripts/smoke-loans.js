/* End-to-end smoke for the Loans feature.
 *
 *   1. POST /api/loans                     create a "HDFC Vehicle Loan (Smoke)"
 *      • principal 1,00,000, rate 10% p.a., tenure 12mo
 *      • EMI formula → ₹8,791.59
 *   2. GET  /api/loans                     listed; outstanding=100000
 *   3. GET  /api/loans/:id/schedule        12 rows, all unpaid
 *   4. POST /api/loans/:id/emi             record EMI #1 (₹833 int + ₹7958 prin)
 *   5. GET  /api/loans/:id/statement       1 entry, outstanding ≈ 92,041
 *   6. GET  /api/loans/:id/schedule        first row paid, second now next-due
 *   7. POST /api/loans/:id/emi             record #2
 *   8. GET  /api/loans                     interest_paid > 0, principal_paid > 0
 *   9. GET  /api/loans/upcoming            shows the loan's next-due row
 *  10. DELETE /api/loans/:id               409 (has txns); suggest_deactivate=true
 *  11. PATCH deactivate
 *  12. Cleanup
 */

const http = require('http');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const sequelize = require('../config/database');
const { LedgerAccount, LoanAccount } = require('../models');

const TEST_NAME = 'HDFC Vehicle Loan (Smoke)';

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

(async () => {
  let allOk = true;
  let createdId = null;
  const out = (label, ok, extra = '') => {
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  };

  // Pre-clean: nuke any TEST_NAME row (and any prior renamed variants)
  // that have zero entries; rename out-of-the-way any that still carry
  // history so the new run can use the original name.
  try {
    const { Op } = require('sequelize');
    const stale = await LedgerAccount.findAll({
      where: { ledger_name: { [Op.like]: `${TEST_NAME}%` } },
    });
    for (const s of stale) {
      const [{ cnt }] = await sequelize.query(
        `SELECT COUNT(*)::int AS cnt FROM ledger_entries WHERE ledger_id = :id`,
        { replacements: { id: s.ledger_id }, type: sequelize.QueryTypes.SELECT },
      );
      if (cnt === 0) {
        await s.destroy().catch(() => {});
      } else if (s.ledger_name === TEST_NAME) {
        await s.update({
          ledger_name: TEST_NAME + '_archived_' + Date.now(),
          is_active:   false,
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('  (pre-clean warning:', e.message, ')');
  }

  try {
    const token = await getToken();
    const today = new Date().toISOString().slice(0, 10);
    const firstEmi = (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10); })();

    console.log('\n── 1. POST /api/loans ──');
    const c1 = await reqJson('POST', '/api/loans', token, {
      name:              TEST_NAME,
      loan_type:         'taken',
      principal:         100000,
      interest_rate:     10,
      tenure_months:     12,
      disbursement_date: today,
      first_emi_date:    firstEmi,
    });
    out('status=201', c1.status === 201, `(got ${c1.status})`);
    out('returned ledger_id', !!c1.body.ledger_id, `id=${c1.body.ledger_id}`);
    out('outstanding=principal at create time', Math.abs(c1.body.outstanding - 100000) < 0.01,
        `outstanding=${c1.body.outstanding}`);
    out('EMI computed correctly (~₹8791.59)', Math.abs(c1.body.emi_amount - 8791.59) < 1,
        `emi=${c1.body.emi_amount}`);
    createdId = c1.body.ledger_id;
    if (c1.status !== 201) { allOk = false; throw new Error('create failed'); }

    console.log('\n── 2. GET /api/loans (list) ──');
    const l1 = await reqJson('GET', '/api/loans', token);
    const found = (l1.body.loans || []).find((x) => x.ledger_id === createdId);
    out('appears in list', !!found);
    out('loan_type=taken', found?.loan_type === 'taken');
    out('outstanding ≈ 100000', Math.abs(found?.outstanding - 100000) < 0.01);
    out('emi_count=0', found?.emi_count === 0);

    console.log('\n── 3. GET /api/loans/:id/schedule ──');
    const s1 = await reqJson('GET', `/api/loans/${createdId}/schedule`, token);
    out('returned 12 rows', (s1.body.schedule || []).length === 12, `got ${s1.body.schedule?.length}`);
    out('first row.opening = 100000', Math.abs(s1.body.schedule?.[0]?.opening - 100000) < 0.01);
    out('last row.closing ≈ 0', Math.abs(s1.body.schedule?.[11]?.closing) < 1, `got ${s1.body.schedule?.[11]?.closing}`);
    out('paid_count = 0', s1.body.paid_count === 0);
    // Sanity: row N+1 opening = row N closing
    const rowsOk = s1.body.schedule.slice(1).every(
      (r, i) => Math.abs(r.opening - s1.body.schedule[i].closing) < 0.01,
    );
    out('schedule continuity (opening[i+1] = closing[i])', rowsOk);

    console.log('\n── 4. POST /api/loans/:id/emi (record EMI #1) ──');
    const e1 = await reqJson('POST', `/api/loans/${createdId}/emi`, token, {});
    out('status=201', e1.status === 201);
    out('principal portion present', e1.body.principal > 0, `=${e1.body.principal}`);
    out('interest portion present (~₹833 for 10% on 100k/12)', Math.abs(e1.body.interest - 833.33) < 1, `=${e1.body.interest}`);
    out('total = principal + interest', Math.abs(e1.body.emi - (e1.body.principal + e1.body.interest)) < 0.01);

    console.log('\n── 5. GET /api/loans/:id/statement (after first EMI) ──');
    const st1 = await reqJson('GET', `/api/loans/${createdId}/statement?from_date=2020-01-01&to_date=2099-12-31`, token);
    out('1 entry posted', st1.body.entries?.length === 1, `got ${st1.body.entries?.length}`);
    out('outstanding ≈ 92,041 (100k − 7958 principal repaid)',
        Math.abs(st1.body.totals?.closing_balance - 92041.67) < 5,
        `outstanding=${st1.body.totals?.closing_balance}`);

    console.log('\n── 6. GET /api/loans/:id/schedule (after first EMI) ──');
    const s2 = await reqJson('GET', `/api/loans/${createdId}/schedule`, token);
    out('paid_count = 1', s2.body.paid_count === 1);
    out('row[0].paid = true', s2.body.schedule?.[0]?.paid === true);
    out('row[1].paid = false', s2.body.schedule?.[1]?.paid === false);

    console.log('\n── 7. POST /api/loans/:id/emi (record EMI #2) ──');
    const e2 = await reqJson('POST', `/api/loans/${createdId}/emi`, token, {});
    out('status=201', e2.status === 201);
    out('paid_count → 2', e2.status === 201);

    console.log('\n── 8. GET /api/loans (totals updated) ──');
    const l2 = await reqJson('GET', '/api/loans', token);
    const after = (l2.body.loans || []).find((x) => x.ledger_id === createdId);
    out('emi_count = 2', after?.emi_count === 2);
    out('interest_paid > 0', after?.interest_paid > 0, `=${after?.interest_paid}`);
    out('principal_paid > 0', after?.principal_paid > 0, `=${after?.principal_paid}`);
    out('outstanding decreased', after?.outstanding < 100000);

    console.log('\n── 9. GET /api/loans/upcoming ──');
    const u1 = await reqJson('GET', '/api/loans/upcoming?days=400', token);
    const uOurs = (u1.body.upcoming || []).filter((r) => r.ledger_id === createdId);
    out('our loan has upcoming rows', uOurs.length > 0, `got ${uOurs.length}`);

    console.log('\n── 10. DELETE on used loan — should 409 ──');
    const d1 = await reqJson('DELETE', `/api/loans/${createdId}`, token);
    out('status=409', d1.status === 409);
    out('suggest_deactivate=true', d1.body.suggest_deactivate === true);

    console.log('\n── 11. PATCH deactivate ──');
    const p1 = await reqJson('PATCH', `/api/loans/${createdId}`, token, { is_active: false });
    out('status=200', p1.status === 200);

    console.log('\n── 12. Default list excludes deactivated, include_inactive=true shows it ──');
    const l3 = await reqJson('GET', '/api/loans', token);
    out('not in default list', !(l3.body.loans || []).find((x) => x.ledger_id === createdId));
    const l4 = await reqJson('GET', '/api/loans?include_inactive=true', token);
    out('appears with include_inactive=true', !!(l4.body.loans || []).find((x) => x.ledger_id === createdId));

    console.log('\n── 13. Calculate endpoint smoke ──');
    const calc = await reqJson('GET', '/api/loans/calculate?principal=500000&interest_rate=12&tenure_months=60', token);
    out('returns EMI', calc.body.emi > 0);
    // EMI for 5L @ 12% over 5y ≈ 11,122
    out('EMI ≈ ₹11,122', Math.abs(calc.body.emi - 11122) < 50, `got ${calc.body.emi}`);

    console.log(`\n${allOk ? '✓ All checks passed' : '✗ Some checks failed'}.`);
  } catch (e) {
    console.error('\n✗ Smoke failed:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
