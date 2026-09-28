#!/usr/bin/env node
/**
 * Publish a built release to download.zehenapp.com (R2 bucket zehen-downloads).
 *
 *   npm run dist                               # build dist-electron/
 *   node scripts/release/publish.js            # dry run: sign + verify, upload nothing
 *   node scripts/release/publish.js --publish  # upload for real
 *
 * What it does, in order:
 *   1. Checks dist-electron/ holds this version's installer, blockmap and
 *      latest.yml, and that latest.yml's SHA-512 matches the installer.
 *   2. Signs `zehen-release:<version>:<sha512>` with the update-signing key
 *      (~/.zehen-release/update-signing-key.pem) and adds it to latest.yml as
 *      zehenSignature. Installed apps refuse any update without a valid one
 *      (electron/updater.js).
 *   3. Verifies that signature against the public key the app embeds, so a
 *      key mix-up is caught here rather than by every shop's updater.
 *   4. Uploads updates/<installer>, updates/<blockmap>, and LAST
 *      updates/latest.yml — apps only learn of a release once every file it
 *      points to is already in place.
 *   5. Replaces Zehen-Setup.exe (the website's Download button), unless
 *      --no-website is passed.
 *
 * Needs `npx wrangler login` in cloud/ (OAuth; the token expires).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'dist-electron');
const BUCKET = 'zehen-downloads';
const KEY_PATH = path.join(os.homedir(), '.zehen-release', 'update-signing-key.pem');
const WRANGLER = path.join(ROOT, 'cloud', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const args = new Set(process.argv.slice(2));
const PUBLISH = args.has('--publish');
const WEBSITE = !args.has('--no-website');

function fail(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

const version = require(path.join(ROOT, 'package.json')).version;
const exeName = `ZEHEN-Setup-${version}.exe`;
const files = {
  exe: path.join(OUT, exeName),
  blockmap: path.join(OUT, `${exeName}.blockmap`),
  yml: path.join(OUT, 'latest.yml'),
};
for (const [k, f] of Object.entries(files)) if (!fs.existsSync(f)) fail(`Missing ${k}: ${f}. Run npm run dist first.`);

// 1. latest.yml describes exactly this installer.
const ymlText = fs.readFileSync(files.yml, 'utf8').replace(/^zehenSignature:.*\r?\n?/m, '');
const ymlVersion = (ymlText.match(/^version:\s*(\S+)/m) || [])[1];
const ymlSha = (ymlText.match(/^sha512:\s*(\S+)/m) || [])[1];
const ymlPath = (ymlText.match(/^path:\s*(\S+)/m) || [])[1];
if (ymlVersion !== version) fail(`latest.yml is for ${ymlVersion}, package.json says ${version}.`);
if (ymlPath !== exeName) fail(`latest.yml points at ${ymlPath}, expected ${exeName}.`);
const digest = crypto.createHash('sha512').update(fs.readFileSync(files.exe)).digest('base64');
if (digest !== ymlSha) fail('latest.yml SHA-512 does not match the installer. Rebuild.');

// 2. Sign.
if (!fs.existsSync(KEY_PATH)) fail(`No signing key at ${KEY_PATH}. See scripts/release/keygen.js.`);
const message = Buffer.from(`zehen-release:${version}:${digest}`);
const signature = crypto.sign(null, message, crypto.createPrivateKey(fs.readFileSync(KEY_PATH))).toString('base64');

// 3. Verify against the key the app ships with.
const updaterSrc = fs.readFileSync(path.join(ROOT, 'electron', 'updater.js'), 'utf8');
const embedded = (updaterSrc.match(/UPDATE_PUBLIC_KEY\s*=\s*'([^']+)'/) || [])[1];
if (!embedded) fail('Could not read UPDATE_PUBLIC_KEY from electron/updater.js.');
const pub = crypto.createPublicKey({ key: Buffer.from(embedded, 'base64'), format: 'der', type: 'spki' });
if (!crypto.verify(null, message, pub, Buffer.from(signature, 'base64'))) {
  fail('Signature does not verify against the app\'s UPDATE_PUBLIC_KEY. Wrong key; nothing uploaded.');
}

// 3b. What's new, from src/data/releaseNotes.json. Installed apps show it on the
//     "update available" card before anything downloads, so a release without
//     notes is refused. Notes are not part of the signed message.
const notesFile = path.join(ROOT, 'src', 'data', 'releaseNotes.json');
const release = (JSON.parse(fs.readFileSync(notesFile, 'utf8')).releases || []).find((r) => r.version === version);
if (!release || !Array.isArray(release.highlights) || !release.highlights.length) {
  fail(`No release notes for ${version} in src/data/releaseNotes.json. Add what's new before publishing.`);
}
const yamlStr = (v) => JSON.stringify(String(v)); // JSON strings are valid YAML scalars
const notesYml = `releaseName: ${yamlStr(release.title || `ZEHEN ${version}`)}\nreleaseNotes: |\n${release.highlights.map((h) => `  - ${String(h).replace(/\r?\n/g, ' ')}`).join('\n')}\n`;

const signedYml = path.join(OUT, 'latest.signed.yml');
const baseYml = ymlText.replace(/^releaseName:.*\r?\n?/m, '').replace(/^releaseNotes:[\s\S]*?(?=^\S|$(?![\s\S]))/m, '');
fs.writeFileSync(signedYml, `${baseYml.trimEnd()}\n${notesYml}zehenSignature: ${signature}\n`);

const mb = (f) => `${(fs.statSync(f).size / 1048576).toFixed(1)} MB`;
const uploads = [
  { key: `updates/${exeName}`, file: files.exe, type: 'application/x-msdownload', cache: 'public, max-age=31536000, immutable' },
  { key: `updates/${exeName}.blockmap`, file: files.blockmap, type: 'application/octet-stream', cache: 'public, max-age=31536000, immutable' },
  { key: 'updates/latest.yml', file: signedYml, type: 'text/yaml', cache: 'no-cache' },
];
if (WEBSITE) uploads.push({ key: 'Zehen-Setup.exe', file: files.exe, type: 'application/x-msdownload', cache: 'no-cache' });

console.log(`ZEHEN ${version}`);
console.log(`  installer  ${exeName} (${mb(files.exe)})`);
console.log(`  sha512     ${digest.slice(0, 24)}…`);
console.log('  signature  valid for the app\'s embedded key');
for (const u of uploads) console.log(`  → ${BUCKET}/${u.key}  (${mb(u.file)})`);

if (!fs.existsSync(WRANGLER)) fail('wrangler is not installed in cloud/. Run npm install in cloud/ first.');

if (!PUBLISH) {
  console.log('\nDry run: nothing uploaded. Re-run with --publish to release.');
  process.exit(0);
}

// 4 + 5. Upload in order; latest.yml only after the files it names.
let feedLive = false;
for (const u of uploads) {
  console.log(`\nUploading ${u.key}…`);
  // Run wrangler's JS entry with node directly: no shell, so a path with a
  // space ("Billing ERP") or a cache header with commas stays one argument.
  const r = spawnSync(process.execPath, [
    WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${u.key}`,
    '--file', u.file, '--remote', '--content-type', u.type, '--cache-control', u.cache,
  ], { cwd: path.join(ROOT, 'cloud'), stdio: 'inherit' });
  if (r.status !== 0) {
    fail(feedLive
      ? `Upload of ${u.key} failed. The update itself IS live (latest.yml is out); re-run to retry the rest.`
      : `Upload of ${u.key} failed. latest.yml was not updated, so no app will try this release yet. Re-run to retry.`);
  }
  if (u.key === 'updates/latest.yml') feedLive = true;
}
console.log(`\n✓ ZEHEN ${version} is live at https://download.zehenapp.com/updates/latest.yml`);
