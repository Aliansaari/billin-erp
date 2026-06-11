#!/usr/bin/env node
/**
 * Pre-build sanity check.
 * ────────────────────────
 *
 * Refuses to build if any of these are true:
 *
 *   1. server/config/license.js still has the placeholder public key.
 *      (Shipping a build with this means signature verification can
 *      never succeed for any customer license — a dead app.)
 *
 *   2. dist/ doesn't exist (vite build hasn't run).
 *
 *   3. The public key looks malformed (not a 32-byte base64 string).
 *
 * If any check fails, exits non-zero with a clear, actionable error.
 * Hooked into the build pipeline as a pre-step before electron-builder.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error('');
  console.error('  ✗ Build aborted — ' + msg);
  console.error('');
  process.exit(1);
}

// 1. Public key check
const licConfig = path.join(ROOT, 'server', 'config', 'license.js');
if (!fs.existsSync(licConfig)) {
  fail('server/config/license.js is missing.');
}
const src = fs.readFileSync(licConfig, 'utf8');
if (src.includes('REPLACE_ME_WITH_LICENSE_STUDIO_PUBLIC_KEY')) {
  console.error('');
  console.error('  ✗ Build aborted — public key not configured.');
  console.error('');
  console.error('  Open ZEHEN License Studio → Settings → Security → Copy public key,');
  console.error('  then paste it into:');
  console.error('');
  console.error('      ' + path.relative(ROOT, licConfig));
  console.error('');
  console.error('  Replace the string  REPLACE_ME_WITH_LICENSE_STUDIO_PUBLIC_KEY');
  console.error('  with your 44-character base64 public key (keep the quotes).');
  console.error('');
  process.exit(1);
}

// Extract the literal value of LICENSE_PUBLIC_KEY's fallback. We keep
// this regex simple — only need to spot the pattern as it appears in
// the file we wrote.
const m = src.match(/LICENSE_PUBLIC_KEY\s*=\s*[^;]*?'([^']+)'\s*;/s);
if (!m) {
  // Couldn't statically parse — let the build proceed; runtime check
  // will catch an invalid value.
  console.warn('[check_build_ready] could not statically extract LICENSE_PUBLIC_KEY; proceeding.');
} else {
  const key = m[1];
  // Ed25519 public key = 32 bytes = 44 base64 chars (with one trailing '=').
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) {
    fail(`LICENSE_PUBLIC_KEY value looks malformed.\n\n  Expected a 44-character base64 string (32-byte Ed25519 public key).\n  Found: "${key}" (${key.length} chars)`);
  }
}

// 2. Renderer build present
const distIndex = path.join(ROOT, 'dist', 'index.html');
if (!fs.existsSync(distIndex)) {
  fail(`dist/index.html missing — run "npm run build" first (or use the combined "npm run dist" which builds renderer + installer).`);
}

console.log('  ✓ build pre-checks passed');
console.log('    public key: configured');
console.log('    dist/:      present');
