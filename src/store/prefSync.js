import { create } from 'zustand';
import { preferencesAPI } from '../api';

/* ── Preferences that belong to a login, not to a machine ──────────────
 *
 * THE PROBLEM
 *
 * Every UI preference in this app used to live in plain localStorage:
 * appearance (light/dark), the Command Center's KPI cards, the dashboard
 * tiles, which columns a bill grid shows. localStorage is per-BROWSER, so:
 *
 *   - the shared counter PC handed the next person on shift whatever the
 *     previous person had set up, under their own name;
 *   - the same person moving to the back-office PC, a LAN client or a
 *     reinstalled app started from factory defaults every time.
 *
 * WHAT THIS MODULE DOES
 *
 * Two changes, both invisible when they work:
 *
 *   1. Every preference is stored under a key scoped to the signed-in
 *      user (and their company), so two logins on one machine can never
 *      read each other's settings.
 *   2. That local copy is mirrored to `user_preferences` on the server,
 *      pulled at sign-in and pushed (debounced) on every change, so the
 *      settings follow the login to any machine.
 *
 * The local copy is not a cache we could drop — it is what makes the
 * first paint correct. Zustand's `persist` reads storage synchronously
 * while the store is being created, so the app renders in the right
 * theme immediately and the server pull only reconciles afterwards.
 *
 * WRITE MODEL
 *
 * Last write wins, per key, at sign-in. There is no merge: a preference
 * is one person's choice about one screen, and merging two of their own
 * devices would produce a layout neither of them picked. A key with an
 * unpushed local change (the shop's server was down when they changed
 * it) is protected — the pull leaves it alone and pushes it instead.
 *
 * LEGACY ADOPTION
 *
 * On the first sign-in after this ships, the user has nothing on the
 * server and nothing under a scoped key, but the machine still holds the
 * old unscoped values. Those are adopted for that user and the old keys
 * are then deleted, so the machine's settings become the settings of
 * whoever was using it — and the next login starts clean rather than
 * inheriting them.
 * ────────────────────────────────────────────────────────────────── */

/* The full registry of synced preferences.
 *
 *   legacy — the localStorage key this preference used before it was
 *            scoped to a login. Read as a fallback, adopted once, then
 *            removed. `null` for preferences introduced after sync.
 *
 * A key here must match the server's /^[A-Za-z0-9_.:-]{1,64}$/. */
export const PREF_KEYS = {
  /* Zustand `persist` stores — value is the persist envelope
   * ({ state, version }), stored verbatim so migrations keep working. */
  theme:                  { legacy: 'erp-theme' },
  home:                   { legacy: 'erp-home-settings' },
  dashboard:              { legacy: 'erp-dashboard-settings' },

  /* Plain values read and written through getPref/setPref. */
  dashboardSections:      { legacy: 'zehen_ed_dashboard_sections_v1' },
  sbf_visible_cols:       { legacy: 'sbf_visible_cols' },
  pbf_visible_cols:       { legacy: 'pbf_visible_cols' },
  pbf_pin_margin:         { legacy: null },
  srf_visible_cols:       { legacy: 'srf_visible_cols' },
  prf_visible_cols:       { legacy: 'prf_visible_cols' },
  psp_visible_cols:       { legacy: 'psp_visible_cols_v1' },
  plv_cols_Customer:      { legacy: 'plv_cols_Customer' },
  plv_cols_Supplier:      { legacy: 'plv_cols_Supplier' },
  // One key for both party lists on purpose: "don't put my money totals on
  // screen" is a single decision about who can see the operator's monitor,
  // and making them set it twice to get one outcome would be worse. New
  // preference, so there is no legacy key to adopt.
  plv_hide_totals:        { legacy: null },
};

/* Whole FAMILIES of preferences, matched by prefix.
 *
 * Every list and report in the app persists its own column set, KPI-card
 * row and view mode under its own key, and several build that key at
 * runtime (`erp_product_items_cols_${side}`, `pp_recent_${type}`), so an
 * exact-match registry cannot name them all. Anything starting with one
 * of these prefixes is a personal view preference and follows the login.
 *
 * This is the fix for a real bug: the Sales list's Customize popover —
 * which holds the KPI summary cards toggle — writes `salesList_cols_v8`,
 * a key no exact entry above could have covered, so turning the KPI
 * cards off changed them for EVERY user of that computer. The same was
 * true of ~20 other screens. Prefixes close the whole class rather than
 * the one instance that got reported.
 *
 * Keep these narrow and specific. A prefix that accidentally matched a
 * session key ('token', 'user') would push credentials to the server. */
export const PREF_PREFIXES = [
  // Bill / voucher lists — column sets AND page sections (KPI cards,
  // total row) live together in these.
  'salesList_cols_', 'purchaseList_cols_', 'paymentList_cols_',
  'salesReturnList_cols_', 'purchaseReturnList_cols_',
  // Reports — columns, KPI strips and view modes.
  'salesReport_cols_', 'salesReport_kpis_',
  'purchaseReport_cols_', 'purchaseReport_kpis_',
  'salesmanReport_cols_', 'salesmanReport_kpis_',
  'dayBook_cols_', 'dayBook_kpis_', 'dayBook_simpleKpis_', 'dayBook_view_',
  'agingReport_display_',
  'cashFlowGroup_cols_',
  'erp_bills_outstanding_cols_', 'erp_bo_alloc_banner_dismissed_',
  'erp_product_items_cols_',
  'erp_monthly_register_with_tax_',
  'erp_report_expand_default',
  'fss-prefs',
  'sbc-visible-cols',
  // Inventory.
  'inv-stock-report-cols', 'smart-stock-cat-cols', 'ed-products-cols',
  // Small per-operator conveniences.
  'gs_pins_', 'gs_telemetry_',
  'bank_ledger_select__last_used',
  'pp_recent_',
  'exp_recent_heads_',
];

/* Preferences that also have to exist BEFORE anyone signs in.
 *
 * The sign-in screen has no user yet, so it reads the unscoped key. If a
 * signed-in change only ever landed on the scoped key, the door would keep
 * opening in whatever the app's default happened to be while the room
 * behind it was in the operator's chosen theme — the two looked swapped.
 *
 * So the theme is mirrored to the unscoped key on every write: the
 * sign-in screen opens in the theme of whoever last used this computer.
 * A colour is not an identity, so this reveals nothing about them — and
 * it is the same value the next person would see one click later anyway.
 * Nothing else is mirrored; a KPI layout is no use before sign-in. */
const DEVICE_MIRRORED = new Set(['theme']);

/** True when this key is a personal preference we sync. */
export function isSyncedKey(key) {
  if (PREF_KEYS[key]) return true;
  return PREF_PREFIXES.some((p) => String(key).startsWith(p));
}

/* Deliberately NOT here: gst_mode, sale_due_days_mode and
 * purchase_due_days_mode. Those look like preferences but are set on
 * Settings → Defaults, which is company-wide — moving them onto a login
 * would mean the proprietor's choice never reached the counter. They
 * belong on system_settings, where two of the three already have
 * columns waiting for them. */

/* Fired after preferences change from anything other than the local
 * component that wrote them — a server pull, a user switch, a reset.
 * Consumers that read through getPref() (rather than through a zustand
 * store) listen for this to re-read. `detail.keys` lists what moved. */
export const PREFS_CHANGED_EVENT = 'zehen:prefs-changed';

/* ── localStorage plumbing ─────────────────────────────────────────── */

function lsGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private mode / quota */ } }
function lsDel(k) { try { window.localStorage.removeItem(k); } catch { /* private mode */ } }

/* Who the preferences belong to right now.
 *
 * Users live in the COMPANY database, so user_id 1 of one company is a
 * different person from user_id 1 of another — the company id has to be
 * part of the scope or two shops sharing a machine would share settings.
 *
 * Returns null before sign-in; callers then fall back to the unscoped
 * key so the login screen still has a theme. */
function currentScope() {
  const raw = lsGet('user');
  if (!raw || raw === 'undefined' || raw === 'null') return null;
  let userId = null;
  try { userId = JSON.parse(raw)?.user_id; } catch { return null; }
  if (!userId) return null;
  let companyId = 0;
  try { companyId = Number(JSON.parse(lsGet('zehen_company') || 'null')?.state?.currentId) || 0; }
  catch { /* no company picked yet — scope on the user alone */ }
  return `c${companyId}u${userId}`;
}

function scopedKey(prefKey) {
  const scope = currentScope();
  return scope ? `zpref:${scope}:${prefKey}` : null;
}

function unsavedKey() {
  const scope = currentScope();
  return scope ? `zpref:${scope}:__unsaved` : null;
}

/* ── Sync status (for the "Preferences" tab in My Profile) ─────────── */

export const usePrefSyncStore = create(() => ({
  // 'idle' before the first pull, then 'syncing' | 'saved' | 'unsaved' |
  // 'offline' | 'error'.
  status: 'idle',
  lastSyncedAt: null,
  unsavedCount: 0,
  // Set when the server rejected the write or could not be reached —
  // shown as the reason under the status line instead of a bare "error".
  lastError: null,
}));

const setStatus = (patch) => usePrefSyncStore.setState(patch);

/* ── Pending pushes ────────────────────────────────────────────────── */

const pending = new Set();
let pushTimer = null;

/* When true, writes are replays of what we just read (a server pull, a
 * reset for a different user) rather than the operator's own edits — so
 * they are not queued for push and cannot win over the server copy on
 * the next pull. */
let replaying = false;

function persistPending() {
  const k = unsavedKey();
  if (!k) return;
  if (pending.size) lsSet(k, JSON.stringify([...pending]));
  else lsDel(k);
  setStatus({ unsavedCount: pending.size });
}

/* Unsaved changes survive a reload: someone who re-themes the app while
 * the shop's server is down, then closes the app, still gets their
 * change pushed the next time it comes up. */
function restorePending() {
  pending.clear();
  const k = unsavedKey();
  try {
    const arr = JSON.parse(lsGet(k) || '[]');
    if (Array.isArray(arr)) arr.forEach((x) => { if (PREF_KEYS[x]) pending.add(x); });
  } catch { /* corrupt → nothing pending */ }
  setStatus({ unsavedCount: pending.size });
}

/* An offline session holds no token and cannot write anything; pushing
 * would only produce a rejected request per keystroke. */
function canSync() {
  return !!lsGet('token') && lsGet('zehen_offline_mode') !== '1' && !!currentScope();
}

/** The parsed value of a preference as the server should store it. */
function valueOf(prefKey) {
  const raw = readRaw(prefKey);
  if (raw == null) return null;
  try { return JSON.parse(raw); }
  // Pre-sync scalars were stored bare ("product", not "\"product\"").
  // Send them as the string they are.
  catch { return raw; }
}

async function flushPending() {
  if (!pending.size || !canSync()) return;
  const keys = [...pending];
  const values = {};
  for (const k of keys) values[k] = valueOf(k);
  setStatus({ status: 'syncing' });
  try {
    if (keys.length === 1) await preferencesAPI.put(keys[0], values[keys[0]]);
    else await preferencesAPI.putMany(values);
    // Only clear what we actually sent — a change made while the request
    // was in flight stays queued for the next flush.
    keys.forEach((k) => pending.delete(k));
    persistPending();
    setStatus({
      status: pending.size ? 'unsaved' : 'saved',
      lastSyncedAt: Date.now(),
      lastError: null,
    });
  } catch (err) {
    // Keep everything queued. Retried on the next change, on reconnect,
    // and at the next sign-in.
    setStatus({
      status: 'unsaved',
      lastError: err?.response?.data?.error || err?.message || 'Could not reach the server',
    });
  }
}

function schedulePush(prefKey) {
  if (replaying || !isSyncedKey(prefKey)) return;
  pending.add(prefKey);
  persistPending();
  setStatus({ status: 'unsaved' });
  if (pushTimer) clearTimeout(pushTimer);
  // Long enough that dragging a colour picker or ticking through a
  // column list is one request, short enough to feel immediate.
  pushTimer = setTimeout(() => { pushTimer = null; flushPending(); }, 800);
}

/* ── Raw read / write ──────────────────────────────────────────────── */

/** Raw string for a preference: this user's copy, else the pre-sync
 *  value left on this machine, else null. */
/* The unscoped key this preference used before sync.
 *
 * For a registry entry it is whatever `legacy` says (sometimes a
 * different name, sometimes null for a preference invented after sync).
 * For a prefix family the key never changed name — it simply used to be
 * unscoped — so the legacy key IS the key. */
function legacyNameFor(prefKey) {
  const entry = PREF_KEYS[prefKey];
  if (entry) return entry.legacy;
  return isSyncedKey(prefKey) ? prefKey : null;
}

export function readRaw(prefKey) {
  const sk = scopedKey(prefKey);
  if (sk) {
    const mine = lsGet(sk);
    if (mine != null) return mine;
  }
  const legacy = legacyNameFor(prefKey);
  return legacy ? lsGet(legacy) : null;
}

export function writeRaw(prefKey, raw) {
  const sk = scopedKey(prefKey);
  if (!sk) {
    // Signed out — the only writer is the login screen. Keep it on the
    // unscoped key so it is adopted by whoever signs in next.
    const legacy = legacyNameFor(prefKey);
    if (legacy) lsSet(legacy, raw);
    return;
  }
  lsSet(sk, raw);
  if (DEVICE_MIRRORED.has(prefKey)) {
    const legacy = legacyNameFor(prefKey);
    if (legacy) lsSet(legacy, raw);
  }
  schedulePush(prefKey);
}

/* ── Public API for non-store preferences ──────────────────────────── */

/**
 * Read a preference that isn't backed by a zustand store — column sets,
 * gst_mode, the dashboard's section toggles.
 *
 * Tolerates the pre-sync format: values written before this module
 * existed were sometimes bare strings rather than JSON.
 */
export function getPref(prefKey, fallback = null) {
  const raw = readRaw(prefKey);
  if (raw == null) return fallback;
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return raw;
  }
}

/** Write one, and queue it for the server. */
export function setPref(prefKey, value) {
  if (value === undefined || value === null) {
    clearPref(prefKey);
    return;
  }
  writeRaw(prefKey, JSON.stringify(value));
}

/** Back to the app default, here and on the server. */
export function clearPref(prefKey) {
  const sk = scopedKey(prefKey);
  if (sk) lsDel(sk);
  const legacy = legacyNameFor(prefKey);
  if (legacy) lsDel(legacy);
  pending.delete(prefKey);
  persistPending();
  if (canSync()) {
    preferencesAPI.remove(prefKey).catch(() => { /* reset is best-effort */ });
  }
}

/* ── Zustand persist adapter ───────────────────────────────────────── */

const registry = new Map();   // prefKey → { store, reset }

/**
 * Storage for a `persist`-ed store, scoped to the signed-in user and
 * mirrored to the server.
 *
 * Pass the result straight to persist's `storage` option. The `name`
 * argument persist supplies is ignored for reads and writes — the pref
 * key owns the scoped location — but the store's old unscoped key still
 * backs the one-time adoption via PREF_KEYS[prefKey].legacy.
 */
export function createPrefStorage(prefKey) {
  return {
    getItem: (_name) => {
      const raw = readRaw(prefKey);
      if (raw == null) return null;
      try { return JSON.parse(raw); }
      catch { return null; }
    },
    setItem: (_name, value) => { writeRaw(prefKey, JSON.stringify(value)); },
    removeItem: (_name) => { clearPref(prefKey); },
  };
}

/**
 * Let the sync layer re-hydrate this store when the signed-in user
 * changes, and reset it to defaults for a user who has no saved copy.
 *
 * `reset` must put the store back to its factory state — without it a
 * second person signing in on the same machine would keep looking at
 * the first person's layout until they happened to change something.
 */
export function registerPrefStore(prefKey, store, reset) {
  registry.set(prefKey, { store, reset });
}

/* ── Applying a set of preferences to the running app ──────────────── */

function notify(keys) {
  try {
    window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT, { detail: { keys } }));
  } catch { /* no window (tests) */ }
}

/** Re-read the given keys (or all of them) into their stores. */
function rehydrate(keys) {
  const touched = keys || Object.keys(PREF_KEYS);
  replaying = true;
  try {
    for (const prefKey of touched) {
      const reg = registry.get(prefKey);
      if (!reg) continue;               // not imported yet — it reads on import
      const raw = readRaw(prefKey);
      // `persist.rehydrate()` leaves the store untouched when storage is
      // empty, which would keep the previous user's layout on screen.
      // An empty slot means "this person has never set this" → defaults.
      if (raw == null) reg.reset?.();
      else reg.store.persist?.rehydrate?.();
    }
  } finally {
    replaying = false;
  }
  notify(touched);
}

let appliedScope = null;
let pullInFlight = null;

/**
 * Bring the running app in line with whoever is signed in now.
 *
 * Called at boot, on sign-in / sign-out, and on a company switch. Safe
 * to call repeatedly: the local pass only does work when the scope
 * actually changed, and concurrent pulls share one request.
 */
export async function applyUserPrefs({ force = false } = {}) {
  const scope = currentScope();
  const scopeChanged = scope !== appliedScope;
  appliedScope = scope;

  if (scopeChanged) {
    // Local first, so the switch is instant and nothing from the
    // previous session stays on screen while the server answers.
    restorePending();
    rehydrate(null);
    setStatus({ status: 'idle', lastSyncedAt: null, lastError: null });
  }

  if (!canSync()) {
    if (scope) setStatus({ status: 'offline' });
    return undefined;
  }
  if (!scopeChanged && !force && pullInFlight) return pullInFlight;

  pullInFlight = (async () => {
    setStatus({ status: 'syncing' });
    let values;
    try {
      const { data } = await preferencesAPI.list();
      values = data?.values || {};
    } catch (err) {
      setStatus({
        status: 'offline',
        lastError: err?.response?.data?.error || err?.message || 'Could not reach the server',
      });
      return;
    }

    const touched = [];
    const adopted = [];
    replaying = true;
    try {
      /* The keys to reconcile: every registry entry, plus every key the
       * server already holds, plus every prefix-family key still sitting
       * unscoped on this machine (those are what a pre-sync install left
       * behind, and they are the ones to adopt on this first sign-in). */
      const families = { ...PREF_KEYS };
      for (const k of Object.keys(values)) {
        if (!families[k] && isSyncedKey(k)) families[k] = { legacy: legacyNameFor(k) };
      }
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (!k || k.startsWith('zpref:') || families[k] || !isSyncedKey(k)) continue;
          families[k] = { legacy: k };
        }
      } catch { /* private mode — nothing to adopt */ }

      for (const [prefKey, meta] of Object.entries(families)) {
        const sk = scopedKey(prefKey);
        if (!sk) continue;
        const onServer = Object.prototype.hasOwnProperty.call(values, prefKey);

        if (onServer && !pending.has(prefKey)) {
          const raw = JSON.stringify(values[prefKey]);
          if (lsGet(sk) !== raw) { lsSet(sk, raw); touched.push(prefKey); }
          // The machine-wide copy is superseded for everyone now: this
          // user's choice lives on their login, and the next person to
          // sign in should get their own, not this one. The exceptions
          // are the keys the sign-in screen itself needs — those are
          // refreshed rather than dropped, so the door keeps matching
          // the room (see DEVICE_MIRRORED).
          if (meta.legacy) {
            if (DEVICE_MIRRORED.has(prefKey)) lsSet(meta.legacy, raw);
            else lsDel(meta.legacy);
          }
          continue;
        }

        if (!onServer) {
          const mine = lsGet(sk);
          const legacy = meta.legacy ? lsGet(meta.legacy) : null;
          if (mine == null && legacy != null) {
            lsSet(sk, legacy);            // first sign-in after the upgrade
            touched.push(prefKey);
            adopted.push(prefKey);
          } else if (mine != null) {
            adopted.push(prefKey);        // set while the server was away
          }
          if (meta.legacy) {
            const keep = DEVICE_MIRRORED.has(prefKey) ? lsGet(sk) : null;
            if (keep != null) lsSet(meta.legacy, keep);
            else lsDel(meta.legacy);
          }
        }
      }

      // A newer client on another machine may store keys this build
      // doesn't know about. Cache them so upgrading this machine doesn't
      // lose them, and so this build never pushes over them.
      for (const [k, v] of Object.entries(values)) {
        if (families[k]) continue;
        const sk = scope ? `zpref:${scope}:${k}` : null;
        if (sk) lsSet(sk, JSON.stringify(v));
      }
    } finally {
      replaying = false;
    }

    if (touched.length) rehydrate(touched);
    adopted.forEach((k) => pending.add(k));
    if (adopted.length) persistPending();

    setStatus({
      status: pending.size ? 'unsaved' : 'saved',
      lastSyncedAt: Date.now(),
      lastError: null,
    });
    await flushPending();
  })().finally(() => { pullInFlight = null; });

  return pullInFlight;
}

/**
 * Throw away every preference for the signed-in user — on this machine
 * and on the server — and put the app back to factory defaults.
 *
 * Used by "Reset my settings" in My Profile → Preferences.
 */
export async function resetMyPreferences() {
  pending.clear();
  persistPending();
  if (canSync()) {
    setStatus({ status: 'syncing' });
    try { await preferencesAPI.clear(); }
    catch (err) {
      setStatus({ status: 'error', lastError: err?.response?.data?.error || err?.message });
      throw err;
    }
  }
  replaying = true;
  try {
    for (const [prefKey, meta] of Object.entries(PREF_KEYS)) {
      const sk = scopedKey(prefKey);
      if (sk) lsDel(sk);
      if (meta.legacy) lsDel(meta.legacy);
    }
  } finally {
    replaying = false;
  }
  rehydrate(null);
  setStatus({ status: 'saved', lastSyncedAt: Date.now(), lastError: null });
}

/* ── Retries ───────────────────────────────────────────────────────── */

if (typeof window !== 'undefined') {
  // Coming back online, or coming back to the window after the shop's
  // server was restarted, is the natural moment to retry.
  window.addEventListener('online', () => { flushPending(); });
  window.addEventListener('focus', () => { if (pending.size) flushPending(); });
  // Best-effort last push when the app is closing. The queue is on disk
  // either way, so a failure here only delays the write to next launch.
  window.addEventListener('beforeunload', () => { if (pending.size) flushPending(); });
}
