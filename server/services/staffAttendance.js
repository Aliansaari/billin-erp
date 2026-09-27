/**
 * Staff attendance — desktop side
 * ───────────────────────────────
 *
 * Staff punch IN/OUT from their own phones at staff.zehenapp.com; the punch
 * lands on the control plane (cloud/src/attendance.js) even while this PC is
 * switched off. This service is the other half:
 *
 *   up    — the staff list, their PIN hashes and the owner's rules
 *   down  — every punch, with its verification result and selfie
 *   back  — each staff member's month, computed HERE, for their phone
 *
 * ══ The rules that govern this file ══
 *
 * 1. Never on the billing path. Sync is a background timer; with no
 *    internet it records the error and tries again later. Nothing a cashier
 *    does waits on it.
 * 2. One implementation of attendance. Late / absent / auto punch-out are
 *    decided only in buildRegister(). The owner's register and the staff
 *    member's phone both show its output, so they cannot disagree.
 * 3. Punches are append-only. A wrong one is voided with a reason, never
 *    edited or deleted, and the staff member can see that it was.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

const remoteAccess = require('./remoteAccess');
const license = require('./license');
const { resolveLicensePath } = require('../config/license');

const SYNC_INTERVAL_MS = 2 * 60_000;
const FIRST_SYNC_DELAY_MS = 25_000;
const PROVISION_RETRY_MS = 60 * 60_000;
const MAX_ROUNDS_PER_SYNC = 6;
const PIN_ITERATIONS = 100_000;   // matches the control plane's PBKDF2 ceiling
const STAFF_PAGE_URL = 'https://staff.zehenapp.com/staff/';

const DEFAULT_CONFIG = {
  wifi_mode: 'require',        // off | flag | require
  passkey: 'required',         // optional | required
  selfie: 'in',                // off | in | both
  geo: { enabled: false, lat: null, lng: null, radius_m: 150 },
  open_time: '10:00',
  close_time: '21:00',
  grace_min: 15,
  weekly_off: [],              // 0 = Sunday … 6 = Saturday
  tz_offset_min: 330,          // IST
};

// ── company plumbing ────────────────────────────────────────────────

/** Run `fn` against company `companyId`'s database. */
async function inCompany(companyId, fn) {
  const { companyContext } = require('../models');
  const { getCompanyConnection } = require('./companyConnections');
  const conn = await getCompanyConnection(companyId);
  return companyContext.run({ sequelize: conn.sequelize, models: conn.models, companyId }, fn);
}

function db() {
  // Proxied: routes to whichever company the current context is serving.
  return require('../config/database');
}

async function q(sql, opts = {}) {
  return db().query(sql, { type: db().QueryTypes.SELECT, ...opts });
}

// ── settings ────────────────────────────────────────────────────────

function mergeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return { ...DEFAULT_CONFIG, ...c, geo: { ...DEFAULT_CONFIG.geo, ...(c.geo || {}) } };
}

async function getSettingsRow() {
  const rows = await q('SELECT * FROM staff_attendance_settings WHERE id = 1');
  if (rows[0]) return { ...rows[0], config: mergeConfig(rows[0].config) };
  return { id: 1, enabled: false, config: mergeConfig({}), shop_code: null, network: null, last_sync_at: null, last_sync_error: null };
}

async function saveSettings({ enabled, config }) {
  await db().query(
    `INSERT INTO staff_attendance_settings (id, enabled, config, modified_date)
     VALUES (1, :enabled, CAST(:config AS jsonb), NOW())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, modified_date = NOW()`,
    { replacements: { enabled: !!enabled, config: JSON.stringify(mergeConfig(config)) } },
  );
  return getSettingsRow();
}

// ── PINs ────────────────────────────────────────────────────────────

/** Same self-describing format the control plane verifies with WebCrypto. */
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const bits = crypto.pbkdf2Sync(String(pin), salt, PIN_ITERATIONS, 32, 'sha256');
  return `pbkdf2$${PIN_ITERATIONS}$${salt.toString('base64')}$${bits.toString('base64')}`;
}

// ── the register ────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function localDayNumber(ms, offMin) { return Math.floor((ms + offMin * 60_000) / DAY_MS); }
function dayNumberToIso(n) { return new Date(n * DAY_MS).toISOString().slice(0, 10); }
function isoToDayNumber(iso) { return Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS); }
function minutesOfDay(ms, offMin) { return Math.floor(((ms + offMin * 60_000) % DAY_MS) / 60_000); }
function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function fmtClock(ms, offMin) {
  const mins = minutesOfDay(ms, offMin);
  const h = Math.floor(mins / 60); const m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * How much a punch can be trusted under the owner's Wi-Fi rule.
 *   ok     — counts
 *   flag   — counts, but the owner is shown why it is doubtful
 *   reject — does not count
 *
 * 'pending' on TODAY counts provisionally: the shop PC may simply not have
 * reported the network yet. On a past day it never got confirmed.
 */
function punchTrust(p, wifiMode, isToday) {
  if (p.source === 'manual') return 'ok';
  if (wifiMode === 'off' || p.net_status === 'match' || p.net_status === 'off') return 'ok';
  if (wifiMode === 'flag') return 'flag';
  if (p.net_status === 'pending' && isToday) return 'ok';
  return 'reject';
}

/**
 * Build the attendance register for [fromIso, toIso] (inclusive, shop-local
 * dates). Returns { config, days: [iso…], staff: [{ …staff, days: {iso: day} }] }.
 *
 * Auto punch-out: a past day that ends on an IN is closed at the LAST
 * VERIFIED PRESENCE — the later of that IN and the staff member's last sales
 * bill that day — never at closing time. Forgetting to punch out cannot earn
 * hours nobody can show were worked, and cannot lose hours a bill proves.
 */
async function buildRegister(fromIso, toIso, { staffIds = null, includeInactive = false } = {}) {
  const settings = await getSettingsRow();
  const cfg = settings.config;
  const off = Number(cfg.tz_offset_min) || 0;
  const fromDay = isoToDayNumber(fromIso);
  const toDay = isoToDayNumber(toIso);
  const todayDay = localDayNumber(Date.now(), off);
  const fromMs = fromDay * DAY_MS - off * 60_000;
  const toMs = (toDay + 1) * DAY_MS - off * 60_000;

  const staffRows = await q(
    `SELECT staff_id, name, phone, salesman_id, attendance_enabled, is_active, joined_on, created_date,
            pin_hash IS NOT NULL AS has_pin, cloud_status, designation, photo_thumb
       FROM staff_members
      WHERE (:all OR is_active) ${staffIds ? 'AND staff_id IN (:ids)' : ''}
      ORDER BY name`,
    { replacements: { all: !!includeInactive, ids: staffIds || [0] } },
  );
  const ids = staffRows.map((s) => s.staff_id);

  const punches = ids.length ? await q(
    `SELECT punch_id, staff_id, kind, punched_at, source, net_status, geo_status, distance_m,
            passkey, device_shared, prompt, selfie IS NOT NULL AS has_selfie, reason,
            voided_at, void_reason
       FROM staff_punches
      WHERE staff_id IN (:ids) AND punched_at >= :from AND punched_at < :to
      ORDER BY punched_at`,
    { replacements: { ids, from: new Date(fromMs), to: new Date(toMs) } },
  ) : [];

  // Leave days (live ones only), keyed staff:date.
  const leaveRows = ids.length ? await q(
    `SELECT leave_id, staff_id, to_char(leave_date, 'YYYY-MM-DD') AS d, leave_type, reason
       FROM staff_leaves WHERE staff_id IN (:ids) AND voided_at IS NULL AND leave_date BETWEEN :f AND :t`,
    { replacements: { ids, f: fromIso, t: toIso } },
  ).catch(() => []) : [];
  const leaveAt = new Map(leaveRows.map((l) => [`${l.staff_id}:${l.d}`, l]));

  // Last bill per (salesman, day) — the presence signal for auto punch-out.
  const salesmanIds = staffRows.map((s) => s.salesman_id).filter(Boolean);
  const lastBill = new Map();
  if (salesmanIds.length) {
    const rows = await q(
      `SELECT salesman_id, MAX(created_date) AS last_at,
              FLOOR((EXTRACT(EPOCH FROM created_date) * 1000 + :offms) / ${DAY_MS})::bigint AS dayn
         FROM sales_bills
        WHERE salesman_id IN (:sids) AND created_date >= :from AND created_date < :to
        GROUP BY salesman_id, dayn`,
      { replacements: { sids: salesmanIds, offms: off * 60_000, from: new Date(fromMs), to: new Date(toMs) } },
    ).catch(() => []);   // an unusual sales_bills shape must never break attendance
    for (const r of rows) lastBill.set(`${r.salesman_id}:${r.dayn}`, new Date(r.last_at).getTime());
  }

  const lateAfter = (hhmmToMinutes(cfg.open_time) ?? 600) + (Number(cfg.grace_min) || 0);
  const weeklyOff = new Set((cfg.weekly_off || []).map(Number));
  const byStaff = new Map(ids.map((id) => [id, []]));
  for (const p of punches) byStaff.get(p.staff_id)?.push(p);

  const dayList = [];
  for (let d = fromDay; d <= toDay; d++) dayList.push(dayNumberToIso(d));

  const staff = staffRows.map((s) => {
    const joinedDay = s.joined_on
      ? isoToDayNumber(String(s.joined_on).slice(0, 10))
      : localDayNumber(new Date(s.created_date).getTime(), off);
    const mine = byStaff.get(s.staff_id) || [];
    const days = {};

    for (let d = fromDay; d <= toDay; d++) {
      const iso = dayNumberToIso(d);
      const isToday = d === todayDay;
      const dayPunches = mine.filter((p) => localDayNumber(new Date(p.punched_at).getTime(), off) === d);
      const live = dayPunches.filter((p) => !p.voided_at);
      const judged = live.map((p) => ({ ...p, trust: punchTrust(p, cfg.wifi_mode, isToday), at: new Date(p.punched_at).getTime() }));
      const counted = judged.filter((p) => p.trust !== 'reject');
      const weekday = new Date(d * DAY_MS).getUTCDay();

      const day = { date: iso, punches: dayPunches.map(publicPunch), flags: [] };
      const leave = leaveAt.get(`${s.staff_id}:${iso}`);
      if (leave) day.leave = { leave_id: leave.leave_id, type: leave.leave_type, reason: leave.reason };

      if (d > todayDay || d < joinedDay) {
        day.status = 'none';
      } else {
        const firstIn = counted.find((p) => p.kind === 'in');
        if (!firstIn) {
          if (leave) day.status = 'leave';
          else if (judged.some((p) => p.trust === 'reject')) day.status = 'unverified';
          else if (weeklyOff.has(weekday)) day.status = 'off';
          else day.status = isToday ? 'not_in' : 'absent';
        } else {
          day.in_at = firstIn.at;
          day.status = minutesOfDay(firstIn.at, off) > lateAfter ? 'late' : 'present';

          // Worked time = sum of IN→OUT pairs over the counted punches.
          let worked = 0; let openAt = null; let lastOut = null;
          for (const p of counted) {
            if (p.kind === 'in' && openAt === null) openAt = p.at;
            else if (p.kind === 'out' && openAt !== null) { worked += p.at - openAt; lastOut = p.at; openAt = null; }
          }
          if (openAt !== null) {
            if (isToday) {
              day.working = true;
            } else {
              const bill = s.salesman_id ? lastBill.get(`${s.salesman_id}:${d}`) : null;
              const autoOut = bill && bill > openAt ? bill : openAt;
              worked += autoOut - openAt;
              lastOut = autoOut;
              day.auto_out = true;
              day.auto_basis = bill && bill > openAt ? 'last_bill' : 'punch_in';
            }
          }
          if (lastOut) day.out_at = lastOut;
          day.worked_min = Math.round(worked / 60_000);
        }
        if (counted.some((p) => p.trust === 'flag')) day.flags.push('network');
        if (live.some((p) => p.geo_status === 'outside')) day.flags.push('location');
        if (live.some((p) => p.device_shared)) day.flags.push('shared_phone');
        if (dayPunches.some((p) => p.voided_at)) day.flags.push('voided');
        if (live.some((p) => p.source === 'manual')) day.flags.push('manual');
      }
      days[iso] = day;
    }

    const summary = { present: 0, late: 0, absent: 0, off: 0, unverified: 0, leave: 0, leave_paid: 0, leave_unpaid: 0, worked_min: 0 };
    for (const iso of dayList) {
      const day = days[iso];
      if (day.status === 'present' || day.status === 'late') summary.present++;
      if (day.status === 'late') summary.late++;
      if (day.status === 'absent') summary.absent++;
      if (day.status === 'off') summary.off++;
      if (day.status === 'unverified') summary.unverified++;
      if (day.status === 'leave') { summary.leave++; summary[day.leave.type === 'unpaid' ? 'leave_unpaid' : 'leave_paid']++; }
      summary.worked_min += day.worked_min || 0;
    }

    return {
      staff_id: s.staff_id,
      name: s.name,
      phone: s.phone,
      designation: s.designation || null,
      photo: s.photo_thumb || null,
      salesman_id: s.salesman_id,
      is_active: s.is_active,
      attendance_enabled: s.attendance_enabled,
      has_pin: s.has_pin,
      cloud_status: s.cloud_status,
      days,
      summary,
    };
  });

  return { config: cfg, days: dayList, today: dayNumberToIso(todayDay), staff };
}

function publicPunch(p) {
  return {
    punch_id: p.punch_id,
    kind: p.kind,
    at: new Date(p.punched_at).getTime(),
    source: p.source,
    net_status: p.net_status,
    geo_status: p.geo_status,
    distance_m: p.distance_m === null ? null : Number(p.distance_m),
    passkey: !!p.passkey,
    device_shared: !!p.device_shared,
    prompt: p.prompt,
    has_selfie: !!p.has_selfie,
    reason: p.reason,
    voided_at: p.voided_at ? new Date(p.voided_at).getTime() : null,
    void_reason: p.void_reason,
  };
}

// ── what each staff member's phone shows ────────────────────────────

const STATUS_LABEL = {
  present: ['Present', 'ok'], late: ['Late', 'warn'], absent: ['Absent', 'bad'],
  off: ['Weekly off', ''], unverified: ['Not verified', 'bad'], not_in: ['Not in yet', ''],
  leave: ['Leave', 'leave'],
};

function staffViews(register) {
  const off = Number(register.config.tz_offset_min) || 0;
  const views = {};
  for (const s of register.staff) {
    const days = [];
    for (const iso of register.days) {
      const d = s.days[iso];
      if (!d || d.status === 'none') continue;
      const [label, tone] = d.working ? ['Working', 'ok'] : (STATUS_LABEL[d.status] || [d.status, '']);
      const notes = [];
      if (d.auto_out) notes.push('auto check-out');
      if (d.status === 'leave') notes.push(`${d.leave.type === 'unpaid' ? 'Unpaid' : 'Paid'} leave${d.leave.reason ? `: ${d.leave.reason}` : ''}`);
      for (const p of d.punches) {
        if (p.voided_at) notes.push(`${p.kind.toUpperCase()} removed by owner: ${p.void_reason || 'no reason'}`);
        else if (p.source === 'manual') notes.push(`${p.kind.toUpperCase()} added by owner: ${p.reason || 'no reason'}`);
      }
      const wd = new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
      days.push({
        date: iso,
        label: wd,
        status: label,
        tone,
        in: d.in_at ? fmtClock(d.in_at, off) : null,
        out: d.out_at ? fmtClock(d.out_at, off) + (d.auto_out ? ' (auto)' : '') : null,
        note: notes.join(' · ') || null,
      });
    }
    const monthLabel = new Date(`${register.days[0]}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    views[s.staff_id] = {
      month: register.days[0].slice(0, 7),
      month_label: monthLabel,
      summary: { present: s.summary.present, late: s.summary.late, absent: s.summary.absent, leave: s.summary.leave, worked_min: s.summary.worked_min },
      days,
    };
  }
  return views;
}

// ── sync with the control plane ─────────────────────────────────────

const state = new Map();   // companyId → { running, lastViewsHash, lastResult }
let timer = null;
let lastProvisionAttempt = 0;

function licenseText() {
  try { return fs.readFileSync(resolveLicensePath(), 'utf8').trim(); } catch { return null; }
}

/**
 * This install's site on the control plane. Attendance needs one even when
 * Remote Access is off; provisioning is idempotent, and on its own it only
 * reserves the site (the tunnel does not run unless Remote Access is on).
 */
async function ensureSite({ force = false } = {}) {
  const status = remoteAccess.getStatus();
  if (status.site_id) return status.site_id;
  if (!force && Date.now() - lastProvisionAttempt < PROVISION_RETRY_MS) {
    throw new Error('This computer is not registered with ZEHEN online yet. It will retry automatically.');
  }
  lastProvisionAttempt = Date.now();
  const cfg = await remoteAccess.provision();
  if (!cfg?.site_id) throw new Error('Could not register this computer with ZEHEN online.');
  return cfg.site_id;
}

/**
 * POST the beacon once over IPv4 and once over IPv6, so the control plane
 * knows the shop's address in both families (see handleAttBeacon). A family
 * the network does not have simply fails, which is fine.
 */
function beacon(family, body) {
  return new Promise((resolve) => {
    const url = new URL('/v1/att/beacon', remoteAccess.CONTROL_PLANE_URL);
    const payload = JSON.stringify(body);
    // http only for a local control plane (ZEHEN_CONTROL_PLANE_URL override).
    const transport = url.protocol === 'http:' ? http : https;
    const req = transport.request({
      hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: 'POST', family,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 10_000,
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(payload);
  });
}

async function postSync(body) {
  const res = await fetch(`${remoteAccess.CONTROL_PLANE_URL}/v1/att/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Attendance sync failed (${res.status})`);
  return data;
}

async function storePunches(punches) {
  const ack = [];
  for (const p of punches) {
    await db().query(
      `INSERT INTO staff_punches (punch_id, staff_id, kind, punched_at, source, net_status, geo_status,
                                  distance_m, lat, lng, accuracy_m, passkey, device_shared, prompt, selfie)
       VALUES ($1, $2, $3, $4, 'phone', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (punch_id) DO UPDATE
         SET net_status = EXCLUDED.net_status,
             selfie = COALESCE(staff_punches.selfie, EXCLUDED.selfie)`,
      {
        bind: [
          p.punch_id, p.ext_id, p.kind === 'out' ? 'out' : 'in', new Date(p.at),
          p.net_status, p.geo_status, p.distance_m, p.lat, p.lng, p.accuracy_m,
          !!p.passkey, !!p.device_shared, p.prompt ? String(p.prompt).slice(0, 60) : null,
          p.selfie ? Buffer.from(p.selfie, 'base64') : null,
        ],
      },
    );
    // Hold the ack back while a photo is still waiting to be sent to us:
    // acking deletes it on the other side.
    if (!(p.selfie_waiting && !p.selfie)) ack.push({ punch_id: p.punch_id, net_status: p.net_status });
  }
  return ack;
}

/** Month-to-date register for every staff member, as their phones show it. */
async function currentViews(cfg) {
  const off = Number(cfg.tz_offset_min) || 0;
  const today = dayNumberToIso(localDayNumber(Date.now(), off));
  const register = await buildRegister(`${today.slice(0, 8)}01`, today);
  const views = staffViews(register);
  // Finalized payslips, only when the owner lets staff see them.
  const pay = await require('./payroll').staffPayViews().catch(() => ({}));
  for (const [id, slips] of Object.entries(pay)) if (views[id]) views[id].pay = slips;
  return views;
}

/**
 * What staff phones show as the shop: the name and logo from Settings →
 * Company Profile (not the internal company label). The logo travels only
 * when it is a small image; a large one is skipped, never shrunk here.
 */
const LOGO_MAX_BYTES = 90 * 1024;
const LOGO_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
async function shopBranding(fallbackName) {
  const [row] = await q('SELECT company_name, logo_path FROM system_settings ORDER BY 1 LIMIT 1').catch(() => []);
  const name = (row && String(row.company_name || '').trim()) || fallbackName || null;
  let logo = null;
  try {
    if (row && row.logo_path) {
      const dir = process.env.BILLING_ERP_UPLOADS_DIR || require('path').join(require('os').homedir(), '.zehen', 'uploads');
      const file = require('path').join(dir, 'branding', require('path').basename(String(row.logo_path)));
      const type = LOGO_TYPES[require('path').extname(file).toLowerCase()];
      if (type && fs.existsSync(file) && fs.statSync(file).size <= LOGO_MAX_BYTES) {
        logo = `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
      }
    }
  } catch { /* no logo is fine */ }
  return { name, logo };
}

/** One full sync for the company whose context we are in. */
async function syncCurrentCompany(companyId, companyLabel, { force = false } = {}) {
  const settings = await getSettingsRow();
  const brand = await shopBranding(companyLabel);
  const companyName = brand.name;
  const cloudSettings = { ...settings.config, brand_logo: brand.logo };
  // Nothing to do for a company that has never turned attendance on. One that
  // turned it OFF still syncs, so the control plane learns to refuse logins.
  if (!settings.enabled && !settings.shop_code) return { skipped: true };

  const lic = licenseText();
  if (!lic) throw new Error('No licence file on this computer.');
  await ensureSite({ force });

  const auth = { license: lic, machine_fp: license.machineFingerprint() };
  await Promise.all([beacon(4, auth), beacon(6, auth)]);

  const staff = await q(
    `SELECT staff_id, name, phone, pin_hash, attendance_enabled, device_reset_seq
       FROM staff_members WHERE is_active`,
  );
  const st = state.get(companyId) || {};
  const views = settings.enabled ? await currentViews(settings.config) : {};
  const viewsHash = crypto.createHash('sha1').update(JSON.stringify(views)).digest('hex');

  let ack = [];
  let result = null;
  let received = 0;
  for (let round = 0; round < MAX_ROUNDS_PER_SYNC; round++) {
    result = await postSync({
      ...auth,
      company_id: companyId,
      company_name: companyName,
      enabled: !!settings.enabled,
      settings: cloudSettings,
      staff: staff.map((s) => ({
        ext_id: s.staff_id,
        name: s.name,
        phone: s.phone,
        pin_hash: s.pin_hash,
        enabled: !!s.attendance_enabled && !!s.pin_hash,
        reset_seq: s.device_reset_seq || 0,
      })),
      // Views only when they changed; they are the largest part of a sync.
      views: round === 0 && (force || viewsHash !== st.lastViewsHash) ? views : undefined,
      ack,
    });
    received += (result.punches || []).length;
    ack = await storePunches(result.punches || []);
    if (!ack.length && !result.has_more) break;
  }
  st.lastViewsHash = viewsHash;
  state.set(companyId, st);

  // Phone-link / fingerprint status for the owner's staff table.
  for (const s of result?.staff_status || []) {
    await db().query('UPDATE staff_members SET cloud_status = CAST(:st AS jsonb) WHERE staff_id = :id', {
      replacements: { id: s.ext_id, st: JSON.stringify(s) },
    });
  }
  await db().query(
    `UPDATE staff_attendance_settings
        SET shop_code = :code, network = CAST(:net AS jsonb), last_sync_at = NOW(), last_sync_error = NULL
      WHERE id = 1`,
    { replacements: { code: result?.shop_code || settings.shop_code, net: JSON.stringify(result?.network || null) } },
  );

  // A new punch changes someone's month: push the views again right away
  // rather than two minutes from now.
  if (received && settings.enabled) {
    const fresh = await currentViews(settings.config);
    const freshHash = crypto.createHash('sha1').update(JSON.stringify(fresh)).digest('hex');
    if (freshHash !== st.lastViewsHash) {
      await postSync({
        ...auth, company_id: companyId, company_name: companyName, enabled: true,
        settings: cloudSettings,
        staff: staff.map((s) => ({
          ext_id: s.staff_id, name: s.name, phone: s.phone, pin_hash: s.pin_hash,
          enabled: !!s.attendance_enabled && !!s.pin_hash, reset_seq: s.device_reset_seq || 0,
        })),
        views: fresh,
        ack: [],
      });
      st.lastViewsHash = freshHash;
    }
  }

  return { ok: true, shop_code: result?.shop_code, received, network: result?.network };
}

async function recordError(message) {
  await db().query(
    'UPDATE staff_attendance_settings SET last_sync_error = :e WHERE id = 1',
    { replacements: { e: String(message).slice(0, 500) } },
  ).catch(() => {});
}

async function companies() {
  const Company = require('../models/Company');
  const rows = await Company.findAll({ where: { is_active: true }, order: [['company_id', 'ASC']] });
  return rows.map((c) => ({ company_id: c.company_id, name: c.name }));
}

/**
 * Sync one company now (the "Sync now" button, and right after changes).
 *
 * Syncs for one company never overlap: a call that arrives while one is
 * running waits for it and then runs its own. Returning "busy" instead made
 * the owner's "Sync now" silently skip a punch that had just arrived,
 * because an edit a moment earlier had already started a background sync.
 */
async function syncNow(companyId, { force = true } = {}) {
  const list = await companies();
  const company = list.find((c) => c.company_id === Number(companyId)) || { company_id: Number(companyId), name: null };
  const st = state.get(company.company_id) || {};
  state.set(company.company_id, st);

  const run = async () => inCompany(company.company_id, async () => {
    try {
      return await syncCurrentCompany(company.company_id, company.name, { force });
    } catch (e) {
      await recordError(e.message);
      throw e;
    }
  });
  // One queued run serves every caller that arrives before it starts, so a
  // burst of edits costs one extra sync, not one each.
  if (st.queued) return st.queued;
  const next = (st.inflight || Promise.resolve()).catch(() => {}).then(() => {
    st.queued = null;
    return run();
  });
  st.queued = next;
  st.inflight = next;
  try {
    return await next;
  } finally {
    if (st.inflight === next) st.inflight = null;
  }
}

async function syncAll() {
  let list = [];
  try { list = await companies(); } catch { return; }
  for (const c of list) {
    try {
      await syncNow(c.company_id, { force: false });
    } catch (e) {
      // Offline, control plane down, not provisioned… all recorded on the
      // settings row for the owner to read; nothing else to do here.
      console.error(`[attendance] sync company ${c.company_id}: ${e.message}`);
    }
  }
}

function start() {
  if (timer) return;
  const first = setTimeout(syncAll, FIRST_SYNC_DELAY_MS);
  if (first.unref) first.unref();
  timer = setInterval(syncAll, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  DEFAULT_CONFIG,
  STAFF_PAGE_URL,
  mergeConfig,
  getSettingsRow,
  saveSettings,
  hashPin,
  buildRegister,
  staffViews,
  syncNow,
  ensureSite,
  start,
  stop,
  _internal: { punchTrust, localDayNumber, minutesOfDay, hhmmToMinutes, fmtClock, syncCurrentCompany },
};
