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
/**
 * Every company this install can serve, newest-first by id.
 *
 * The snapshot used to describe company 1 only, because that is what
 * systemToken() signed for. A phone signed into a second company therefore
 * had no saved figures of its own — and, before the company stamp landed,
 * was shown the primary company's instead.
 */
async function activeCompanies() {
  const Company = require('../models/Company');
  const rows = await Company.findAll({
    where: { is_active: true },
    order: [['company_id', 'ASC']],
  });
  return rows.map((c) => ({
    company_id: c.company_id,
    name: c.name,
    is_primary: !!c.is_primary,
  }));
}

/**
 * Mint a short-lived token for an admin user IN `companyId`, so the internal
 * calls go through the ordinary auth + permission stack rather than around it.
 *
 * The user must exist in that company: the auth middleware re-reads the token's
 * user against the company being served and rejects a mismatch. So the lookup
 * runs inside that company's context, not the ambient one.
 *
 * Sixty seconds, never written to disk, never leaves this process.
 */
async function systemToken(companyId) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');

  // Models are per-company factories behind an AsyncLocalStorage proxy, so
  // they must come from the models bag — requiring the file directly yields
  // the definition function, not a bound model.
  const { User, Role, companyContext } = require('../models');
  const { getCompanyConnection } = require('./companyConnections');

  const conn = await getCompanyConnection(companyId);
  const user = await companyContext.run(
    { sequelize: conn.sequelize, models: conn.models, companyId },
    async () => User.findOne({
      where: { is_active: true },
      include: [{ model: Role }],
      order: [['user_id', 'ASC']],
    }),
  );
  if (!user) throw new Error(`No active user in company ${companyId} to sign a snapshot token for`);

  return jwt.sign(
    {
      user_id: user.user_id,
      username: user.username,
      role: user.Role?.role_name || 'Admin',
      company_id: companyId,
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

/**
 * Trim one company's sections down to `budget` bytes.
 *
 * Truncating comes first and shedding is the last resort: half a list beats
 * no list, and the phone is told which sections are partial so a short list is
 * never presented as a complete one. Rows come off the END, so what survives
 * is what the endpoints order first — most recent vouchers, stock in its
 * normal listing order.
 */
function fitToBudget(entry, budget) {
  const size = () => JSON.stringify(entry).length;
  const MIN_ROWS = 100;

  for (const key of ['stock', 'parties', 'dayBook']) {
    while (size() > budget) {
      const rows = listOf(entry.sections[key]);
      if (!rows || rows.length <= MIN_ROWS) break;
      setListOf(entry.sections[key], rows.slice(0, Math.max(MIN_ROWS, Math.floor(rows.length / 2))));
      if (!entry.partial.includes(key)) entry.partial.push(key);
    }
    if (size() <= budget) break;
  }

  // Still over: a single section is enormous, or the small ones alone exceed
  // the budget. Drop whole sections, least essential first.
  for (const key of ['stock', 'parties', 'dayBook', 'insights']) {
    if (size() <= budget) break;
    if (entry.sections[key] === undefined) continue;
    delete entry.sections[key];
    entry.missing.push(key);
    entry.partial = entry.partial.filter((k) => k !== key);
    entry.trimmed = true;
  }
  return size();
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

  let companies;
  try {
    companies = await activeCompanies();
  } catch (e) {
    // A snapshot of the primary company is better than none, and this is the
    // shape every install had before multi-company snapshots existed.
    console.error('[snapshot] could not list companies:', e.message);
    companies = [{ company_id: 1, name: null, is_primary: true }];
  }
  if (!companies.length) return { skipped: 'no active companies' };

  /* One entry per company.
   *
   * A phone is signed into exactly one company at a time and must see that
   * company's figures — not the primary company's, which is what it used to
   * get. Each entry carries its own `missing`/`partial`, because a big
   * catalogue in one company should not mark another company's stock as
   * trimmed. */
  const entries = [];
  for (const c of companies) {
    let token;
    try {
      token = await systemToken(c.company_id);
    } catch (e) {
      console.error(`[snapshot] company ${c.company_id} (${c.name}): ${e.message}`);
      continue;
    }
    const { sections, failed } = await collect(port, token);
    if (!Object.keys(sections).length) {
      console.error(`[snapshot] company ${c.company_id} (${c.name}): every section failed`);
      continue;
    }
    entries.push({
      company_id: c.company_id,
      company_name: c.name || null,
      is_primary: !!c.is_primary,
      missing: failed,
      partial: [],
      sections,
    });
  }

  if (!entries.length) return { skipped: 'every company failed' };

  /* Share the size cap across companies rather than giving each the whole
   * thing. An equal split is deliberately naive but predictable: with two
   * companies neither can crowd the other out, and a shop with one company is
   * unaffected because it gets the entire budget as before. */
  const perCompany = Math.floor(SNAPSHOT_SOFT_LIMIT / entries.length);
  for (const entry of entries) fitToBudget(entry, perCompany);

  const primary = entries.find((e) => e.is_primary) || entries[0];

  const payload = {
    generated_at: Date.now(),
    host: os.hostname(),
    // format 2 = per-company. Older phones look for a top-level `sections`,
    // find none, and show "no saved figures" — the safe failure, and the
    // correct one, since what they would otherwise render is another
    // company's money.
    format: 2,
    // Kept at the top level so a phone can name the snapshot's default
    // company without walking the list.
    company_id: primary.company_id,
    company_name: primary.company_name,
    companies: entries,
  };

  const size = () => JSON.stringify(payload).length;

  // Belt and braces: the per-company budgets ignore the envelope, so shed
  // whole non-primary companies if the total still will not fit.
  while (size() > SNAPSHOT_SOFT_LIMIT && payload.companies.length > 1) {
    const dropped = payload.companies.pop();
    console.error(`[snapshot] dropped company ${dropped.company_id} (${dropped.company_name}) — payload over cap`);
  }
  if (size() > SNAPSHOT_SOFT_LIMIT) fitToBudget(payload.companies[0], SNAPSHOT_SOFT_LIMIT - 2048);

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
    companies: payload.companies.map((e) => ({
      company_id: e.company_id,
      missing: e.missing,
      partial: e.partial,
    })),
  };
  // One line per push. When a shop rings up saying the phone shows nothing
  // offline, this is the first thing worth reading: it says whether the
  // upload happened, how close to the cap it is, and what got left out of
  // which company.
  const detail = payload.companies.map((e) => {
    const bits = [];
    if (e.partial.length) bits.push(`partial: ${e.partial.join('/')}`);
    if (e.missing.length) bits.push(`missing: ${e.missing.join('/')}`);
    return `#${e.company_id}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }).join(' ');
  console.log(`[snapshot] pushed ${lastResult.kb} KB · companies ${detail}`);
  return lastResult;
}

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
