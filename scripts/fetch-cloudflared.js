#!/usr/bin/env node
/**
 * Download the cloudflared connector into vendor/cloudflared/ so
 * electron-builder can ship it as an extraResource.
 *
 * Remote Access spawns this binary (server/services/remoteAccess.js). Without
 * it the feature reports "Connector not installed" and stays off — the rest
 * of ZEHEN is unaffected, which is why this is a build-time convenience and
 * not a hard dependency of the app.
 *
 * Pinned to an exact version deliberately: a silently-updated connector is a
 * silently-changed network component in a financial app, and "it worked last
 * week" is not a debugging story anyone wants.
 *
 *   node scripts/fetch-cloudflared.js            # host platform
 *   node scripts/fetch-cloudflared.js --win      # windows x64 (for dist)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const VERSION = '2026.8.3';
const BASE = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}`;

const TARGETS = {
  win:   { url: `${BASE}/cloudflared-windows-amd64.exe`, out: 'cloudflared.exe' },
  mac:   { url: `${BASE}/cloudflared-darwin-amd64.tgz`,  out: 'cloudflared.tgz' },
  linux: { url: `${BASE}/cloudflared-linux-amd64`,       out: 'cloudflared' },
};

function pickTarget() {
  const arg = process.argv.find((a) => a.startsWith('--'));
  if (arg) return arg.slice(2);
  return process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, (res) => {
      // GitHub releases redirect to a CDN; follow it.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const tmp = `${dest}.part`;
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        // Rename only after a complete write, so an interrupted download can
        // never leave a truncated binary that looks installed.
        fs.renameSync(tmp, dest);
        resolve(dest);
      }));
      file.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    }).on('error', reject);
  });
}

(async () => {
  const key = pickTarget();
  const target = TARGETS[key];
  if (!target) {
    console.error(`Unknown target "${key}". Use --win, --mac or --linux.`);
    process.exit(1);
  }

  const dir = path.join(__dirname, '..', 'vendor', 'cloudflared');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, target.out);

  if (fs.existsSync(dest)) {
    console.log(`cloudflared already present: ${dest}`);
    return;
  }

  console.log(`Downloading cloudflared ${VERSION} (${key})…`);
  await download(target.url, dest);

  // macOS ships a tarball, not a bare binary. Unpack it — the service looks
  // for an executable named `cloudflared`, and a .tgz sitting there would
  // silently never be found.
  if (dest.endsWith('.tgz')) {
    require('child_process').execFileSync('tar', ['-xzf', dest, '-C', dir]);
    fs.unlinkSync(dest);
  }

  const bin = path.join(dir, key === 'win' ? 'cloudflared.exe' : 'cloudflared');
  if (!fs.existsSync(bin)) throw new Error(`Expected ${bin} after download`);
  if (key !== 'win') { try { fs.chmodSync(bin, 0o755); } catch {} }
  console.log(`Saved ${bin} (${(fs.statSync(bin).size / 1e6).toFixed(1)} MB)`);
})().catch((e) => {
  console.error('cloudflared download failed:', e.message);
  console.error('Remote Access will be unavailable in this build.');
  process.exit(1);
});
