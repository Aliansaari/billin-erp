/**
 * License verification configuration for ZEHEN.
 * ─────────────────────────────────────────────────────
 *
 * The Ed25519 PUBLIC key below is the one that comes out of ZEHEN
 * License Studio (your in-house license generator). It holds the
 * matching PRIVATE key — only that machine can sign new licenses.
 *
 * To rotate / replace this key:
 *   1. In ZEHEN License Studio, go to Settings → Security → Public key
 *   2. Click "Copy public key"
 *   3. Paste the value into LICENSE_PUBLIC_KEY below (single line, base64)
 *   4. Restart the server
 *
 * After rotating: every existing customer's old license will fail
 * verification. They'll see the "License invalid" screen and need a
 * fresh .dat issued from ZEHEN License Studio.
 *
 * Allow override via env so a developer / staging build can use a
 * test keypair without editing source.
 */
const LICENSE_PUBLIC_KEY =
  process.env.LICENSE_PUBLIC_KEY ||
  // ────────────── PASTE YOUR LICENSE STUDIO PUBLIC KEY HERE ──────────────
  // 32-byte Ed25519 public key in base64, length 44 chars. The default
  // value below is a placeholder — replace before shipping any build to
  // a real customer.
  'C05347K65klJ3v6gFae8Pbha/jsi3ZsreSfdm/++ucY=';

/**
 * Where the license file is stored on the customer's machine.
 *
 * Resolution order:
 *   1. process.env.LICENSE_PATH       — explicit override (CI / testing)
 *   2. globalThis.__LICENSE_PATH      — set by Electron main.js
 *   3. <homedir>/.zehen/license.dat — default user-writable fallback
 *
 * The default lives under the user's home so the activation file
 * persists across server reinstalls and works regardless of whether
 * the install directory is writable (`Program Files` is admin-only).
 *
 * The path is resolved lazily so main.js can stamp it onto
 * `globalThis.__LICENSE_PATH` before any importer reads it.
 */
function resolveLicensePath() {
  if (process.env.LICENSE_PATH) return process.env.LICENSE_PATH;
  if (globalThis.__LICENSE_PATH) return globalThis.__LICENSE_PATH;
  const path = require('path');
  const os = require('os');
  return path.join(os.homedir(), '.zehen', 'license.dat');
}

module.exports = {
  LICENSE_PUBLIC_KEY,
  resolveLicensePath,
  // Paths configurable via env, with sensible defaults.
  GRACE_AFTER_EXPIRY_DAYS:  Number(process.env.LICENSE_GRACE_DAYS  || 0),   // FULL BLOCK
  RECHECK_INTERVAL_SECONDS: Number(process.env.LICENSE_RECHECK_SEC || 300), // 5 min
};
