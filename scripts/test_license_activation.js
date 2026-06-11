/**
 * End-to-end license activation test for ZEHEN.
 *
 * Generates a fresh Ed25519 keypair, builds a signed license envelope
 * (matching License Studio's exact canonical-JSON format), then drives
 * the running server through the full activation flow:
 *
 *   1. Pre-activation: every gated endpoint returns 403 license_block
 *   2. /api/license/info reachable without auth
 *   3. POST /api/license/activate with the signed envelope succeeds
 *   4. Post-activation: gated endpoints accept requests again
 *   5. Tampered envelope: signature check rejects it
 *   6. Expired envelope: rejected with code 'expired'
 *   7. Wrong-key envelope: rejected with 'invalid_signature'
 *   8. Deactivate (vendor): returns to no_license state
 *
 * Run with the test keypair piped through env:
 *
 *   LICENSE_PUBLIC_KEY=<pubkey> node server/index.js  (start in another shell)
 *   node scripts/test_license_activation.js  <pubkey> <privkey>
 *
 * Or use the all-in-one driver below which spawns its own server.
 */

const nacl = require('tweetnacl');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BASE = process.env.API || 'http://localhost:3001';

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

const b64 = {
  encode: (u8) => Buffer.from(u8).toString('base64'),
  decode: (s)  => new Uint8Array(Buffer.from(s, 'base64')),
};

// Stable JSON — must match License Studio's crypto.stableJson exactly
function stableJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableJson).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}';
}

function buildEnvelope(payload, privateKey) {
  const payloadStr = stableJson(payload);
  const sig = nacl.sign.detached(
    new Uint8Array(Buffer.from(payloadStr, 'utf8')),
    b64.decode(privateKey),
  );
  return JSON.stringify({
    v: 1,
    kind: 'license-studio.license',
    payload: payloadStr,
    signature: b64.encode(sig),
  }, null, 2);
}

async function http(method, path, { body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json };
}

(async () => {
  const kp = nacl.sign.keyPair();
  const PUB  = b64.encode(kp.publicKey);
  const PRIV = b64.encode(kp.secretKey);
  console.log('Generated test keypair');
  console.log('  PUB  =', PUB);
  console.log('  PRIV =', PRIV.slice(0, 20) + '… (truncated)');
  console.log('');
  console.log('Spawning ZEHEN server with LICENSE_PUBLIC_KEY=<test>');
  console.log('('+'wait ~10s for boot)');
  console.log('');

  // Make sure no stale license carries over.
  const userLicenseDir = path.join(require('os').homedir(), '.zehen');
  for (const name of ['license.dat', 'license.dat.lastseen', 'license.dat.bind']) {
    try { fs.unlinkSync(path.join(userLicenseDir, name)); } catch {}
  }

  const env = { ...process.env, LICENSE_PUBLIC_KEY: PUB, NODE_ENV: 'test' };
  const child = spawn(process.execPath, ['server/index.js'], { env, cwd: path.resolve(__dirname, '..') });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  // Wait for /api/health to come up.
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  try {
    console.log('[1] Pre-activation gate behavior');
    const health = await http('GET', '/api/health');
    ok('1a /api/health bypassed', health.status === 200);

    const info = await http('GET', '/api/license/info');
    ok('1b /api/license/info reachable', info.status === 200);
    ok('1c info reports activated:false', info.body?.activated === false);
    ok('1d info has machine_fp', !!info.body?.machine_fp);

    const blocked = await http('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin' } });
    ok('1e /api/auth/login returns 403',  blocked.status === 403);
    ok('1f response has license_block:true', blocked.body?.license_block === true);
    ok('1g code === no_license',           blocked.body?.code === 'no_license');

    console.log('\n[2] Activate with valid signed license');
    const today = new Date().toISOString().slice(0, 10);
    const inOneYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const envelope = buildEnvelope({
      v: 1,
      customer_id:   'C-2026-0042',
      customer_name: 'Test Co',
      license_type:  'annual',
      issued_at:     today,
      expires_at:    inOneYear,
      max_companies: 5,
      features:      ['multi_company', 'tally_export'],
      machine_fp:    null,
    }, PRIV);

    const act = await http('POST', '/api/license/activate', { body: { license: envelope } });
    ok('2a activation returns 200', act.status === 200, 'status=' + act.status + ' body=' + JSON.stringify(act.body).slice(0,200));
    ok('2b ok:true',                act.body?.ok === true);
    ok('2c info.customer_id matches', act.body?.info?.customer_id === 'C-2026-0042');
    ok('2d info.expires_at matches',  act.body?.info?.expires_at === inOneYear);

    console.log('\n[3] Post-activation: gated endpoints reachable');
    const login = await http('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    ok('3a /api/auth/login gate passes (response is from auth handler now)',
       login.status !== 403 || !login.body?.license_block, 'status=' + login.status + ' body=' + JSON.stringify(login.body).slice(0,200));

    console.log('\n[4] Tampered envelope rejected');
    // Parse envelope, modify payload string in-place (so signature still
    // refers to the OLD payload), re-stringify. The verify step will see
    // a payload that doesn't match the signature.
    const parsed = JSON.parse(envelope);
    parsed.payload = parsed.payload.replace('"max_companies":5', '"max_companies":99');
    const badEnv = JSON.stringify(parsed);
    const tamper = await http('POST', '/api/license/activate', { body: { license: badEnv } });
    ok('4a tampered → 400', tamper.status === 400, 'status=' + tamper.status + ' body=' + JSON.stringify(tamper.body).slice(0,200));
    ok('4b code === invalid_signature', tamper.body?.code === 'invalid_signature', 'code=' + tamper.body?.code);

    console.log('\n[5] Expired license rejected');
    const expired = buildEnvelope({
      v: 1,
      customer_id: 'C-2026-9999', customer_name: 'Old',
      license_type: 'annual',
      issued_at: '2024-01-01', expires_at: '2024-12-31',
      max_companies: 5, features: [], machine_fp: null,
    }, PRIV);
    const expRes = await http('POST', '/api/license/activate', { body: { license: expired } });
    ok('5a expired → 400', expRes.status === 400);
    ok('5b code === expired', expRes.body?.code === 'expired');

    console.log('\n[6] Wrong-key signature rejected');
    const otherKp = nacl.sign.keyPair();
    const wrongKey = buildEnvelope({
      v: 1, customer_id: 'C-X', customer_name: 'X',
      license_type: 'annual', issued_at: today, expires_at: inOneYear,
      max_companies: 5, features: [], machine_fp: null,
    }, b64.encode(otherKp.secretKey));
    const wrong = await http('POST', '/api/license/activate', { body: { license: wrongKey } });
    ok('6a wrong key → 400', wrong.status === 400);
    ok('6b code === invalid_signature', wrong.body?.code === 'invalid_signature');

    console.log('\n[7] Status check after activation');
    const info2 = await http('GET', '/api/license/info');
    ok('7a info reports activated:true', info2.body?.activated === true);
    ok('7b status.ok === true',          info2.body?.status?.ok === true);
    ok('7c customer_id surfaced',        info2.body?.status?.customer_id === 'C-2026-0042');

    console.log('\n[8] Deactivate (vendor)');
    const deactBad = await http('POST', '/api/license/deactivate', { body: { developer_password: 'wrong' } });
    ok('8a bad dev password → 401', deactBad.status === 401);

    const deactOk = await http('POST', '/api/license/deactivate', { body: { developer_password: process.env.DEVELOPER_PASSWORD || 'dev@billing2025' } });
    ok('8b correct dev password → 200', deactOk.status === 200);

    const blockAgain = await http('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin' } });
    ok('8c after deactivate, gate blocks again', blockAgain.status === 403 && blockAgain.body?.code === 'no_license');

  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n========================================');
  console.log('Result: ' + pass + ' pass, ' + fail + ' fail');
  if (fail) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
    console.log('\n--- server log tail ---');
    console.log(serverLog.split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
})();
