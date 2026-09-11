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
import { sessionScope } from './offlineSnapshot';

let sqlitePromise = null;   // lazy: never loaded in the browser preview
let lastOpenError = null;   // kept so the self-test can report the real cause
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

const dbNameFor = (scope) => `zehen_mirror_${scope}`;

/* The name this used to use.
 *
 * It was `zehen_mirror_<company_id>`, which collides across shops: company
 * ids are per install, so the first company on every ZEHEN is #1 and two
 * different businesses shared one database on a phone signed into both.
 * Deleted rather than orphaned — it holds real figures for a shop, and a
 * file nothing reads is a file nobody checks. */
const LEGACY_PREFIX = 'zehen_mirror_';
let legacyCleaned = false;

async function dropLegacy(conn, companyId) {
  if (legacyCleaned || !companyId) return;
  legacyCleaned = true;
  const name = `${LEGACY_PREFIX}${companyId}`;
  try {
    const exists = await conn.isDatabase(name);
    if (exists?.result) {
      await conn.closeConnection(name, false).catch(() => {});
      await conn.createConnection(name, true, 'secret', 1, false).catch(() => {});
      const db = await conn.retrieveConnection(name, false).catch(() => null);
      if (db) { await db.open().catch(() => {}); await db.delete().catch(() => {}); }
      await conn.closeConnection(name, false).catch(() => {});
    }
  } catch { /* best effort — a leftover file must never block opening the real one */ }
}

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
CREATE TABLE IF NOT EXISTS parties (
  party_id      INTEGER PRIMARY KEY,
  party_name    TEXT,
  party_type    TEXT,
  mobile_1      TEXT,
  credit_limit  REAL,
  credit_days   INTEGER,
  -- Money is an INTEGER count of paise, never REAL.
  --
  -- SQLite's REAL is a double, so storing rupees in one would reintroduce
  -- exactly the drift the checksum exists to detect: the device and the shop
  -- could hold "the same" balance and disagree in the second decimal place.
  -- Integers are exact, and rupees are produced at the display edge.
  balance_paise INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS parties_name ON parties(party_name);
CREATE TABLE IF NOT EXISTS products (
  product_id          INTEGER PRIMARY KEY,
  product_name        TEXT,
  article_number      TEXT,
  barcode             TEXT,
  hsn_code            TEXT,
  size_value          TEXT,
  unit_of_measurement TEXT,
  category_name       TEXT,
  -- Quantities in thousandths, money in paise. Same reason as above: SQLite
  -- REAL is a double, and a stock figure that drifts is a stock figure that
  -- disagrees with the shop.
  stock_milli         INTEGER NOT NULL DEFAULT 0,
  min_stock_milli     INTEGER NOT NULL DEFAULT 0,
  sale_rate_paise     INTEGER NOT NULL DEFAULT 0,
  purchase_rate_paise INTEGER NOT NULL DEFAULT 0
);
-- The point of holding 30,000 items locally is that searching them is
-- instant. Without these it is a full scan per keystroke.
CREATE INDEX IF NOT EXISTS products_name    ON products(product_name);
CREATE INDEX IF NOT EXISTS products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS products_article ON products(article_number);
/* Stored answers for the screens whose data is not a bounded set — a
 * statement, a day book, a dashboard. See utils/mirrorCache.js.
 *
 * One generic table rather than one per screen: they all want the same thing
 * (keep the server's answer, hand it back later, evict the oldest), and three
 * near-identical tables would be three places for that logic to drift.
 *
 * The key carries every argument of the question it answers, so a statement
 * for one period can never be served for another. */
CREATE TABLE IF NOT EXISTS response_cache (
  cache_key TEXT PRIMARY KEY,
  payload   TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS response_cache_synced ON response_cache(synced_at);
-- Superseded by response_cache; dropped so it cannot linger holding stale
-- figures that nothing reads and nobody would think to check.
DROP TABLE IF EXISTS statements;
`;

/**
 * Open (creating if needed) the encrypted mirror for the signed-in company.
 * Returns null when there is no mirror to open — the browser preview, or a
 * session whose company cannot be determined. Never throws at the caller.
 */
export async function openMirror() {
  if (!mirrorAvailable()) return null;
  /* Null scope means the session cannot be identified — no company, or no
   * server. Nothing is opened: storing figures we cannot attribute is how
   * one shop's balances end up under another shop's name. */
  const scope = sessionScope();
  if (!scope) return null;

  const name = dbNameFor(scope);
  if (openDb && openName === name) return openDb;
  if (openDb) await closeMirror();

  try {
    const conn = await sqlite();
    await ensureSecret(conn);
    await dropLegacy(conn, Number(scope.split('__').pop()));

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
    lastOpenError = e?.message || String(e);
    console.warn('[mirror] open failed:', lastOpenError);
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
  /* Staged on purpose.
   *
   * The first version reported a bare "fail", which carried exactly as much
   * information as showing nothing at all — and cost a build, an install and
   * a round trip to learn that. Each stage below names itself and passes the
   * underlying error through, so whatever goes wrong is legible from the
   * screen the first time. */
  if (!mirrorAvailable()) return { ok: false, detail: 'not native' };

  const scope = sessionScope();
  if (!scope) return { ok: false, detail: 'no company/server in session' };

  let conn;
  try {
    conn = await sqlite();
  } catch (e) {
    return { ok: false, detail: `plugin load: ${e?.message || e}` };
  }

  /* Encryption is a config-time decision on iOS. Asking the plugin directly
   * separates "capacitor.config is wrong" from "the Keychain refused us",
   * which look identical from the outside and have completely different
   * fixes. */
  let configured = false;
  try {
    configured = !!(await conn.isInConfigEncryption())?.result;
  } catch (e) {
    return { ok: false, detail: `config check: ${e?.message || e}` };
  }
  if (!configured) return { ok: false, detail: 'encryption off in capacitor.config' };

  try {
    await ensureSecret(conn);
  } catch (e) {
    return { ok: false, detail: `keychain: ${e?.message || e}` };
  }

  const db = await openMirror();
  if (!db) return { ok: false, detail: `open: ${lastOpenError || 'unknown'}` };

  const token = `t${Date.now()}`;
  try {
    await db.run(
      'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;',
      ['__selftest', token, Date.now()],
    );
  } catch (e) {
    return { ok: false, detail: `write: ${e?.message || e}` };
  }

  /* Close and reopen before reading. A value that survives only while the
   * connection is live proves nothing about a database that has to outlast
   * the app being killed. */
  try {
    await closeMirror();
  } catch (e) {
    return { ok: false, detail: `close: ${e?.message || e}` };
  }

  let back;
  try {
    const again = await openMirror();
    if (!again) return { ok: false, detail: `reopen: ${lastOpenError || 'unknown'}` };
    const r = await again.query('SELECT value FROM meta WHERE key = ?;', ['__selftest']);
    back = r?.values?.[0]?.value ?? null;
  } catch (e) {
    return { ok: false, detail: `read: ${e?.message || e}` };
  }
  if (back !== token) return { ok: false, detail: `read back ${back ?? 'null'}` };

  return { ok: true, encrypted: true, detail: scope };
}

/* On a session change, let go of the open database.
 *
 * openMirror caches the live connection and the name it belongs to, so
 * without this the next read after signing into a different shop would be
 * served from the previous shop's file — the connection having been opened
 * before the scope changed. Closing forces the name to be resolved again. */
try {
  window.addEventListener('zehen:session-changed', () => { closeMirror(); });
} catch { /* no window */ }
