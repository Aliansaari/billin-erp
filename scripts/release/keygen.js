#!/usr/bin/env node
/**
 * Create the ZEHEN update-signing keypair. Run ONCE, ever.
 *
 *   node scripts/release/keygen.js
 *
 * The private key signs every installer that auto-update will accept. It is
 * written to ~/.zehen-release/update-signing-key.pem — outside every repo —
 * and this script refuses to overwrite an existing one.
 *
 * BACK IT UP (like the License Studio key). If it is lost, installs in the
 * field can no longer be updated automatically: they would reject anything
 * signed with a new key, and every shop would need a manual reinstall.
 *
 * The public key it prints goes into UPDATE_PUBLIC_KEY in electron/updater.js.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.zehen-release');
const KEY = path.join(DIR, 'update-signing-key.pem');

if (fs.existsSync(KEY)) {
  console.error(`Refusing to overwrite ${KEY}. There must only ever be one signing key.`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });

const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
console.log(`Private key written to ${KEY}. Back it up somewhere safe.`);
console.log(`UPDATE_PUBLIC_KEY = '${pub}'`);
