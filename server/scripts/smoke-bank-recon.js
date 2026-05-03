/* Smoke test for the new /api/banks/reconciliation endpoint.
 * Mints a JWT from the active admin user, then hits the endpoint with
 * different filter combinations.  Run after the server is up:
 *   node server/scripts/smoke-bank-recon.js
 */

const http = require('http');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const sequelize = require('../config/database');

async function getToken() {
  const [rows] = await sequelize.query(
    `SELECT u.user_id, u.username, r.role_name
       FROM users u
       LEFT JOIN roles r ON r.role_id = u.role_id
      WHERE u.is_active = true
      ORDER BY u.user_id ASC LIMIT 1`,
  );
  if (!rows.length) throw new Error('No active users found');
  const u = rows[0];
  const token = jwt.sign(
    { user_id: u.user_id, username: u.username, role: u.role_name },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
  return { token, user: u };
}

function req(path, token) {
  return new Promise((resolve, reject) => {
    const r = http.get(
      { host: 'localhost', port: 3001, path,
        headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      },
    );
    r.on('error', reject);
  });
}

(async () => {
  try {
    const { token, user } = await getToken();
    console.log(`Auth as user_id=${user.user_id} username="${user.username}" role=${user.role_name}`);

    console.log('\n── 1. /api/banks/reconciliation (default = uncleared) ──');
    const r1 = await req('/api/banks/reconciliation', token);
    console.log(`  status: ${r1.status}`);
    if (r1.status !== 200) { console.log(r1.body); return; }
    const d = r1.body;
    console.log(`  totals: count=${d.totals.count} value=₹${d.totals.value} banks_affected=${d.totals.banks_affected} oldest=${d.totals.oldest_days}d`);
    console.log(`  per_bank: ${d.per_bank.length} bank(s)`);
    d.per_bank.forEach((b) => console.log(`    • ${b.bank_name}: ${b.count} uncleared, ₹${b.value}, net ₹${b.net_exposure}`));
    console.log(`  aging buckets:`);
    Object.entries(d.aging).forEach(([k, v]) => console.log(`    ${k.padEnd(6)} → ${v.count} entries, ₹${v.value}`));
    console.log(`  entries: ${d.entries.length}`);

    console.log('\n── 2. status=cleared filter ──');
    const r2 = await req('/api/banks/reconciliation?status=cleared', token);
    console.log(`  status: ${r2.status}, count: ${r2.body?.totals?.count}`);

    console.log('\n── 3. status=all filter ──');
    const r3 = await req('/api/banks/reconciliation?status=all', token);
    console.log(`  status: ${r3.status}, count: ${r3.body?.totals?.count}`);

    console.log('\n── 4. invalid status (should 400) ──');
    const r4 = await req('/api/banks/reconciliation?status=bogus', token);
    console.log(`  status: ${r4.status}, body:`, r4.body);

    if (d.per_bank.length > 0) {
      const firstBank = d.per_bank[0];
      console.log(`\n── 5. bank_id=${firstBank.bank_id} (${firstBank.bank_name}) filter ──`);
      const r5 = await req(`/api/banks/reconciliation?bank_id=${firstBank.bank_id}&status=all`, token);
      console.log(`  status: ${r5.status}, count: ${r5.body?.totals?.count}`);
      console.log(`  per_bank still includes all banks: ${r5.body?.per_bank?.length === d.per_bank.length}`);
    }

    console.log('\n✓ Smoke test complete');
    process.exit(0);
  } catch (e) {
    console.error('✗ Smoke test failed:', e.message);
    if (e.original) console.error('  PG error:', e.original.message);
    process.exit(1);
  }
})();
