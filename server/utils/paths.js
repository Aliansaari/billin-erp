/**
 * Resolved on-disk paths for everything the server needs to read/write.
 *
 * In dev (`npm run server`), these resolve to project-relative dirs.
 * In a packaged Electron build, server/ lives inside `app.asar` which
 * is read-only — so writes have to go somewhere user-writable. We pick
 * `<homedir>/.zehen/<subdir>` for that case.
 *
 * Single source of truth so every caller gets the same path. Dropping
 * a hard-coded `path.join(__dirname, '..', 'uploads')` in random
 * controllers caused the packaged app to ENOTDIR-crash on boot when
 * mkdirSync tried to write inside the read-only asar.
 */
const path = require('path');
const os   = require('os');
const fs   = require('fs');

// "Are we running from inside a packaged asar?" — same heuristic
// app.isPackaged uses on the main side, but we're in the server child
// so we infer from the file path. The two `\app.asar\` / `/app.asar/`
// substrings cover Win + POSIX path styles.
const IN_ASAR = __dirname.includes(`${path.sep}app.asar${path.sep}`)
             || __dirname.includes('/app.asar/');

const USER_DATA = path.join(os.homedir(), '.zehen');

// Project-root in dev, user-data in packaged.
const ROOT = IN_ASAR ? USER_DATA : path.resolve(__dirname, '..', '..');

const UPLOADS_DIR          = path.join(ROOT, 'uploads');
const UPLOADS_IMPORTS_DIR  = path.join(UPLOADS_DIR, 'imports');
const UPLOADS_REJECTED_DIR = path.join(UPLOADS_DIR, 'rejected');

// Eagerly create on import so any caller can write without first checking.
for (const d of [UPLOADS_DIR, UPLOADS_IMPORTS_DIR, UPLOADS_REJECTED_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

module.exports = {
  IN_ASAR,
  USER_DATA,
  UPLOADS_DIR,
  UPLOADS_IMPORTS_DIR,
  UPLOADS_REJECTED_DIR,
};
