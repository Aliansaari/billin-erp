/**
 * The on-device mirror — an encrypted SQLite database holding what the shop
 * looks like, so the app is instant rather than merely offline-capable.
 *
 * ── WHAT THIS IS ALLOWED TO HOLD ─────────────────────────────────────
 *
 * Figures the SERVER computed. Never figures this device derived.
 *
 * That is not a style preference, it is the whole correctness argument. A
 * party's balance is one maintained column (`parties.current_balance`), and
 * reportController.js carries a long note about what happened the last time
 * anything tried to derive it instead: a bill-derived formula silently broke
 * on imported data, overstated every supplier, and flipped the net sign. If
 * this device re-adds ledger rows to get its own answer, it will eventually
 * disagree with the desktop, and a balance quoted to a customer's face is
 * the worst possible place to discover that.
 *
 * So the rule is: the phone caches answers, it does not compute them. A sync
 * that fails can then leave a figure OLD — never WRONG. Wrong requires
 * arithmetic, and there is none here.
 *
 * ── ENCRYPTION ───────────────────────────────────────────────────────
 *
 * SQLCipher, with the passphrase in the iOS Keychain (the plugin puts it
 * there; it is never written to localStorage, which is readable from a
 * filesystem dump). This protects the file at rest — a phone that is off, an
 * extracted backup, a forensic image. It does NOT protect an unlocked phone
 * in someone's hand; that is what the Face ID lock is for, and it remains
 * the owner's choice.
 *
 * ── PARTITIONING ─────────────────────────────────────────────────────
 *
 * One database per company, named from the same session claim that decides
 * whose figures may be shown. Switching company cannot reveal the previous
 * company's rows, because they are not in the file that gets opened.
 */
import { Capacitor } from '@capacitor/core';
import { sessionCompanyId } from './offlineSnapshot';

let sqlitePromise = null;   // lazy: never loaded in the browser preview
let openDb = null;          // the single live connection
let openName = null;        // which company it belongs to

/** The plugin is native-only. The browser preview has no mirror, and every
 *  caller must cope with that rather than assume one exists. */
export const mirrorAvailable = () => Capacitor.isNativePlatform();

async function sqlite() {
  if (!sqlitePromise) {
    sqlitePromise = import('@capacitor-community/sqlite').then(
      ({ CapacitorSQLite, SQLiteConnection }) => new SQLiteConnection(CapacitorSQLite),
    );
  }
  return sqlitePromise;
}

/* A passphrase this device invents once and never shows anyone.
 *
 * Deliberately not derived from the login password: the books must stay
 * readable after a password change, and a derived key would silently lock
 * the owner out of their own mirror. */
function newPassphrase() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function ensureSecret(conn) {
  const stored = await conn.isSecretStored();
  if (stored?.result) return;
  await conn.setEncryptionSecret(newPassphrase());
}

const dbNameFor = (companyId) => `zehen_mirror_${companyId}`;

/* Schema.
 *
 * `meta` is the part that matters for trust: every sync records WHEN it ran
 * and what the server said the money totalled. A figure without a sync time
 * cannot be shown honestly, so the time is stored beside the data rather
 * than inferred later. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);
`;

/**
 * Open (creating if needed) the encrypted mirror for the signed-in company.
 * Returns null when there is no mirror to open — the browser preview, or a
 * session whose company cannot be determined. Never throws at the caller.
 */
export async function openMirror() {
  if (!mirrorAvailable()) return null;
  const companyId = sessionCompanyId();
  if (!companyId) return null;

  const name = dbNameFor(companyId);
  if (openDb && openName === name) return openDb;
  if (openDb) await closeMirror();

  try {
    const conn = await sqlite();
    await ensureSecret(conn);

    /* The plugin can be left holding a connection record for a database it
     * no longer has open — an app killed mid-write, for instance. Opening
     * again then fails with "connection already exists" on a database that
     * is not actually usable, so the records are reconciled first. */
    await conn.checkConnectionsConsistency().catch(() => {});
    const isConn = await conn.isConnection(name, false).catch(() => ({ result: false }));

    const db = isConn?.result
      ? await conn.retrieveConnection(name, false)
      : await conn.createConnection(name, true, 'secret', 1, false);

    await db.open();
    await db.execute(SCHEMA);

    openDb = db;
    openName = name;
    return db;
  } catch (e) {
    console.warn('[mirror] open failed:', e?.message || e);
    openDb = null;
    openName = null;
    return null;
  }
}

export async function closeMirror() {
  if (!openDb) return;
  const name = openName;
  openDb = null;
  openName = null;
  try {
    const conn = await sqlite();
    await conn.closeConnection(name, false);
  } catch { /* already gone */ }
}

/** Read a meta value, or null. */
export async function getMeta(key) {
  const db = await openMirror();
  if (!db) return null;
  try {
    const r = await db.query('SELECT value FROM meta WHERE key = ?;', [key]);
    return r?.values?.[0]?.value ?? null;
  } catch { return null; }
}

/** Write a meta value, stamped with now. */
export async function setMeta(key, value) {
  const db = await openMirror();
  if (!db) return false;
  try {
    await db.run(
      'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;',
      [key, String(value), Date.now()],
    );
    return true;
  } catch { return false; }
}

/**
 * Prove the encrypted store actually works on this device.
 *
 * Written because the alternative is guessing from the outside: "the mirror
 * is empty" looks identical whether the plugin failed to load, the Keychain
 * refused the secret, or the sync simply has not run. The result is shown in
 * the side panel footer so it can be read out rather than reverse-engineered
 * from a build and a round trip.
 *
 * It closes and reopens between writing and reading, because a value that
 * survives only while the connection is live proves nothing about a database
 * that has to outlast the app being killed.
 */
export async function selfTest() {
  if (!mirrorAvailable()) return { ok: false, detail: 'not native' };
  const companyId = sessionCompanyId();
  if (!companyId) return { ok: false, detail: 'no company in session' };

  const token = `t${Date.now()}`;
  try {
    if (!(await setMeta('__selftest', token))) {
      return { ok: false, detail: 'write failed' };
    }
    await closeMirror();
    const back = await getMeta('__selftest');
    if (back !== token) return { ok: false, detail: `read back ${back ?? 'null'}` };

    const conn = await sqlite();
    const enc = await conn.isSecretStored().catch(() => ({ result: false }));
    return {
      ok: true,
      detail: `company ${companyId}, ${enc?.result ? 'encrypted' : 'NOT ENCRYPTED'}`,
      encrypted: !!enc?.result,
    };
  } catch (e) {
    return { ok: false, detail: e?.message || String(e) };
  }
}
