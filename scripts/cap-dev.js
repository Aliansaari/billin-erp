#!/usr/bin/env node

/* Live-reload helper for Capacitor mobile dev.
 *
 * Auto-detects the Mac's LAN IP, builds a live-reload URL pointing at the
 * Vite mobile dev server (port 5174 by default), exports it as
 * CAPACITOR_LIVE_RELOAD_URL, and runs `npm run cap:ios`. The capacitor
 * config (capacitor.config.js) reads that env var and configures
 * server.url + cleartext, so the iOS app loads from the dev server
 * instead of bundled assets.
 *
 * Usage:
 *   Terminal 1: npm run mobile          # backend + Vite dev server
 *   Terminal 2: npm run cap:ios:dev     # this script — opens Xcode in dev mode
 *
 * After Xcode opens, hit Run. Then any change to a .jsx file shows up
 * on the simulator/phone in ~2 seconds.
 */

const { execSync } = require('child_process');
const os = require('os');

function detectLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      // IPv4, not loopback, not link-local APIPA (169.254.x.x — appears when
      // there's no DHCP, useless for talking to the phone).
      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        !iface.address.startsWith('169.254.')
      ) {
        return { name, address: iface.address };
      }
    }
  }
  return null;
}

const port = process.env.MOBILE_DEV_PORT || '5174';
const lan = detectLanIp();

if (!lan) {
  console.error(
    '✖ Could not detect a LAN IP. Connect to Wi-Fi (or Ethernet) and retry.'
  );
  process.exit(1);
}

const url = `http://${lan.address}:${port}/index.mobile.html`;

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Live-reload URL: ${url}`);
console.log(`  Interface:       ${lan.name}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('  Make sure `npm run mobile` is running in another terminal');
console.log('  and your phone is on the same Wi-Fi.');
console.log('');

execSync('npm run cap:ios', {
  stdio: 'inherit',
  env: { ...process.env, CAPACITOR_LIVE_RELOAD_URL: url },
});
