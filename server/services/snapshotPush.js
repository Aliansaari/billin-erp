/**
 * Offline snapshot push
 * ─────────────────────
 *
 * When the shop's PC is switched off, its tunnel goes down and the phone can
 * reach nothing. This service periodically uploads the shop's HEADLINE
 * FIGURES to the control plane so the owner can still open the app and see
 * where the business stands — read-only, clearly timestamped.
 *
 * ══ Why it calls its own HTTP API instead of querying the database ══
 *
 * Every figure here is produced by the SAME controller that serves the live
 * screen. That is the entire point. Re-deriving "today's sales" or "party
 * outstanding" with fresh SQL would create a second implementation of the
 * money math, and the two would drift — the phone would eventually show a
 * different number than the desktop for the same day, which for an
 * accounting product is the worst possible failure. One implementation, two
 * delivery paths.
 *
 * What is deliberately NOT here: arbitrary date-range reports. Those need
 * transactional rows, which would make this a replica rather than a
 * snapshot. Reports require the PC to be on, and the app says so.
 *
 * Writes never block anything. A shop with no internet simply never uploads,
 * and nothing about billing changes.
 */

const fs   = require('fs');
const os   = require('os');
const jwt  = require('jsonwebtoken');

const remoteAccess = require('./remoteAccess');
const license = require('./license');
const { resolveLicensePath } = require('../config/license');

// Ten minutes: frequent enough that "as of" is never embarrassing, rare
// enough to stay far inside every free-tier limit even with many shops.
const PUSH_INTERVAL_MS = 10 * 60_000;

// Stay a little under the control plane's 512 KB hard cap so a payload that
// grew slightly between measuring and sending is not rejected at the edge.
const SNAPSHOT_SOFT_LIMIT = 460 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

// How far back the offline voucher list reaches. The day-book endpoint
// defaults to TODAY when given no dates, which made the offline Vouchers tab
// almost always empty — the one screen where "nothing here" is indistinguishable
// from "we could not load it".
const DAYBOOK_WINDOW_DAYS = 45;

// List endpoints clamp `limit` to 500 (see helpers.sanitizePagination), so a
// single call cannot describe a shop with more items than that — offline it
// would silently show the first 500 and look like the whole catalogue. Paged
// sections walk the pages instead, up to this many rows. Anything past it is
// beyond what the upload cap could carry anyway.
const MAX_PAGED_ROWS = 5000;

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/* Compact projections.
 *
 * The live endpoints return everything a desktop screen might want — a
 * product row is ~40 fields, most of them null. Uploading that meant a
 * mid-size shop blew the 460 KB cap, `stock` was shed whole, and the phone
 * showed "the item list was too large to save offline" with an empty list.
 * The shops with the most stock were the ones guaranteed to get none of it.
 *
 * Keeping only what the mobile screens actually render takes a product row
 * from ~800 bytes to ~120, so the full list fits with room to spare. Field
 * names are preserved exactly, so the offline path renders through the same
 * components as the live one — no second code path, nothing to drift. */
const KEEP_PRODUCT = [
  'product_id', 'product_name', 'article_number', 'barcode', 'ean', 'sku',
  'alt_code', 'product_code', 'hsn_code', 'size_value', 'unit',
  'unit_of_measurement', 'current_stock', 'stock_quantity', 'min_stock',
  'minimum_stock_level', 'sale_rate', 'sale_price', 'purchase_rate',
  'display_cost', 'display_stock_value', 'category_name',
];

const KEEP_VOUCHER = [
  'entry_date', 'entry_number', 'voucher_no', 'voucher_type', 'source_type',
  'reference_id', 'party_or_account', 'debit', 'credit', 'drill_route',
  'narration',
];

const KEEP_PARTY = [
  'party_id', 'party_name', 'display_name', 'party_type', 'mobile_1',
  'current_balance', 'opening_balance_type', 'is_active',
];

/** Keep `fields` of every row, dropping keys whose value is null/undefined
 *  entirely — an absent key costs nothing, a null costs its name. */
function project(rows, fields) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const out = {};
    for (const f of fields) {
      const v = row?.[f];
      if (v !== null && v !== undefined) out[f] = v;
    }
    return out;
  });
}

/** The row array inside a section, whatever envelope it arrived in. */
function listOf(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data))     return body.data;
  if (Array.isArray(body?.products)) return body.products;
  if (Array.isArray(body?.parties))  return body.parties;
  return null;
}

/** Replace that row array in place, leaving the envelope untouched. */
function setListOf(body, rows) {
  if (Array.isArray(body?.data))          body.data = rows;
  else if (Array.isArray(body?.products)) body.products = rows;
  else if (Array.isArray(body?.parties))  body.parties = rows;
}

/** Rewrite one section's payload in place, preserving its envelope so the
 *  phone sees the same shape the live call returns. */
function shrinkList(body, fields) {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) return project(body, fields);
  if (Array.isArray(body.data))     return { ...body, data: project(body.data, fields) };
  if (Array.isArray(body.products)) return { ...body, products: project(body.products, fields) };
  if (Array.isArray(body.parties))  return { ...body, parties: project(body.parties, fields) };
  return body;
}

// The sections a phone can open with the PC off. Each is one call to this
// server's own API — same code path as the live screen — optionally passed
// through a projection that strips the fields no mobile screen reads.
const SECTIONS = [
  { key: 'dashboard',   path: '/api/reports/dashboard' },
  { key: 'insights',    path: '/api/reports/dashboard/insights' },
  { key: 'outstanding', path: '/api/reports/party-outstanding' },
  {
    key: 'dayBook',
    path: () => `/api/reports/day-book?from_date=${isoDaysAgo(DAYBOOK_WINDOW_DAYS)}&to_date=${isoDaysAgo(0)}`,
    shrink: (b) => shrinkList(b, KEEP_VOUCHER),
  },
  // limit=500 is sanitizePagination's ceiling; `limit=all` would be the same
  // 500 rows but pins offset to 0, so every page would repeat page 1.
  { key: 'stock',   path: '/api/products?limit=500', paged: true, shrink: (b) => shrinkList(b, KEEP_PRODUCT) },
  { key: 'parties', path: '/api/parties?limit=500',  paged: true, shrink: (b) => shrinkList(b, KEEP_PARTY) },
];

let timer = null;
let lastResult = null;

/**
 * Mint a short-lived token for an admin user so the internal calls go through
 * the ordinary auth + permission stack rather than around it. Sixty seconds,
 * never written to disk, never leaves this process.
 */
async function systemToken() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');

  // Models are per-company factories behind an AsyncLocalStorage proxy, so
  // they must come from the models bag — requiring the file directly yields
  // the definition function, not a bound model.
  const { User, Role } = require('../models');
  const user = await User.findOne({
    where: { is_active: true },
    include: [{ model: Role }],
    order: [['user_id', 'ASC']],
  });
  if (!user) throw new Error('No active user to sign a snapshot token for');

  return jwt.sign(
    {
      user_id: user.user_id,
      username: user.username,
      role: user.Role?.role_name || 'Admin',
      company_id: 1,
      snapshot: true,          // marks provenance in any audit log
    },
    process.env.JWT_SECRET,
    { expiresIn: '60s' },
  );
}

async function collect(port, token) {
  const sections = {};
  const failed = [];

  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  for (const section of SECTIONS) {
    try {
      const path = typeof section.path === 'function' ? section.path() : section.path;
      let body = await get(path);

      if (section.paged) {
        // Walk the remaining pages onto the first one. `total` comes back with
        // every list response, so we know when to stop without a probe request.
        const rows = listOf(body) || [];
        const total = Number(body?.total) || rows.length;
        const per = rows.length;
        for (let page = 2; per > 0 && rows.length < Math.min(total, MAX_PAGED_ROWS); page += 1) {
          const next = listOf(await get(`${path}&page=${page}`)) || [];
          if (!next.length) break;
          rows.push(...next);
        }
        setListOf(body, rows.slice(0, MAX_PAGED_ROWS));
      }

      sections[section.key] = section.shrink ? section.shrink(body) : body;
    } catch {
      // One slow report must not cost us the whole snapshot — push what we
      // have and record which parts are missing, so the app can grey out
      // exactly those and keep showing the rest.
      failed.push(section.key);
    }
  }
  return { sections, failed };
}

async function pushOnce() {
  const status = remoteAccess.getStatus();
  if (!status.enabled || !status.site_id) return { skipped: 'remote access is off' };

  let licenseText;
  try {
    licenseText = fs.readFileSync(resolveLicensePath(), 'utf8').trim();
  } catch {
    return { skipped: 'no licence file' };
  }

  const port = process.env.SERVER_PORT || 3001;
  const token = await systemToken();
  const { sections, failed } = await collect(port, token);

  if (!Object.keys(sections).length) return { skipped: 'every section failed' };

  const payload = {
    generated_at: Date.now(),
    host: os.hostname(),
    // Which company these figures belong to. systemToken() signs company_id 1,
    // so a snapshot only ever describes the primary company — and a phone
    // signed into a second company must NOT render it. Stamping it here lets
    // the phone tell, instead of showing one company's outstanding under
    // another company's name.
    company_id: 1,
    missing: failed,
    // Sections that ARE present but hold only the first N rows. Distinct from
    // `missing`: the phone can render these, it just must not present them as
    // the complete list.
    partial: [],
    sections,
  };

  /* Keep the upload under the cap — by TRUNCATING first, and only shedding
   * as a last resort.
   *
   * The old code went straight to shedding, so a shop with a few thousand
   * products lost the item list entirely and the phone showed an empty Stock
   * tab: the shops with the most stock were the ones guaranteed to get none
   * of it. Half a list is far more useful than no list, and the phone says
   * which sections are partial so nobody reads a short list as a complete one.
   *
   * Rows come off the END, so what survives is what the endpoints order
   * first — most recent vouchers, and stock in its normal listing order. */
  const size = () => JSON.stringify(payload).length;
  const MIN_ROWS = 100;

  for (const key of ['stock', 'parties', 'dayBook']) {
    while (size() > SNAPSHOT_SOFT_LIMIT) {
      const rows = listOf(payload.sections[key]);
      if (!rows || rows.length <= MIN_ROWS) break;
      setListOf(payload.sections[key], rows.slice(0, Math.max(MIN_ROWS, Math.floor(rows.length / 2))));
      if (!payload.partial.includes(key)) payload.partial.push(key);
    }
    if (size() <= SNAPSHOT_SOFT_LIMIT) break;
  }

  // Still too big (a single section is enormous, or the small sections alone
  // exceed the cap). Drop whole sections, least essential first.
  const SHED_ORDER = ['stock', 'parties', 'dayBook', 'insights'];
  for (const key of SHED_ORDER) {
    if (size() <= SNAPSHOT_SOFT_LIMIT) break;
    if (payload.sections[key] === undefined) continue;
    delete payload.sections[key];
    payload.missing.push(key);
    payload.partial = payload.partial.filter((k) => k !== key);
    payload.trimmed = true;
  }

  const res = await fetch(`${remoteAccess.CONTROL_PLANE_URL}/v1/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      license: licenseText,
      machine_fp: license.machineFingerprint(),
      payload,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Snapshot upload failed (${res.status})`);

  lastResult = {
    at: Date.now(),
    bytes: body.bytes,
    kb: Math.round(size() / 1024),
    missing: payload.missing,
    partial: payload.partial,
  };
  // One line per push. When a shop rings up saying the phone shows nothing
  // offline, this is the first thing worth reading: it says whether the
  // upload happened, how close to the cap it is, and what got left out.
  console.log(
    `[snapshot] pushed ${lastResult.kb} KB`
    + (payload.partial.length ? ` · partial: ${payload.partial.join(', ')}` : '')
    + (payload.missing.length ? ` · missing: ${payload.missing.join(', ')}` : ''),
  );
  return lastResult;
}

/** Fire-and-forget wrapper — a failed push is logged and forgotten. */
function safePush() {
  pushOnce().catch((e) => {
    lastResult = { at: Date.now(), error: e.message };
    console.error('[snapshot] push failed:', e.message);
  });
}

function start() {
  if (timer) return;
  // First push is delayed: at boot the server is still warming caches and
  // running migrations, and a snapshot is never urgent.
  const first = setTimeout(safePush, 60_000);
  if (first.unref) first.unref();
  timer = setInterval(safePush, PUSH_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function getLast() { return lastResult; }

module.exports = { start, stop, pushOnce, getLast };
