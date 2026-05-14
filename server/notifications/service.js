/*
 * Notification service — orchestrates detectors → state diff → payload.
 *
 * Public surface (used by controller):
 *
 *   getNotifications(user)   -> full grouped payload + counts
 *   getCount(user)           -> { unread_count }   (cheap, for the bell poll)
 *   actOnKey(user, key, op)  -> mutate state (mark-seen, dismiss, snooze)
 *   getSettings(user)        -> per-user prefs row, seeded if absent
 *   updateSettings(user, p)  -> persist toggles + master_enabled
 *
 * Threading model: each call runs the detectors in parallel via
 * Promise.all. A single detector failure does NOT abort the whole
 * payload — its error is logged and the detector contributes zero
 * candidates. The bell stays useful even if one query goes sideways.
 *
 * Severity rules:
 *   - red    — money-at-risk / data integrity / compliance ≤ 2 days
 *   - amber  — time-sensitive but planning, not action
 *   - blue   — informational
 *   - green  — positive close (cheque cleared, bill paid in full)
 *
 * Section rules:
 *   - today  — calendar-driven (PDCs, EMIs, GST, etc.)
 *   - risk   — state-change alerts (bounced, breached, negative)
 *   - system — operational (backup, sync, import)
 */

const { Op } = require('sequelize');
const { NotificationState, NotificationSettings, User } = require('../models');
const detectors = require('./detectors');
const { NOTIFICATION_TYPES, isTypeEnabled, defaultToggles } = require('./types');

/* ── Date helpers ─────────────────────────────────────────────────────
 * Detectors use the operator's local "today" (server clock for now —
 * Indian SMBs run on the firm's local server, so server-time and
 * operator-time coincide). All comparisons use DATEONLY strings to
 * avoid timezone drift. */
function todayString(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function daysFromToday(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(todayString() + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}
function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
// Local-time YYYY-MM-DD given a Date — avoids the UTC-toISOString trip
// that flips dates back one day when local TZ is east of UTC (eg IST).
// Detectors that need a date string for SQL between-comparisons must
// use this; toISOString().slice(0,10) is a bug here.
function dateStr(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/* ── Detector orchestration ──────────────────────────────────────────
 * Runs every enabled detector concurrently. Each detector receives a
 * shared context object so they can stay tiny. Disabled detectors
 * are skipped before invocation so the worst case is bounded by the
 * user's toggle set, not the catalog size. */
async function runDetectors(user, settings) {
  const ctx = {
    user,
    today: todayString(),
    todayDate: new Date(),
    daysFromToday,
    addDays,
    dateStr,
  };
  const toggles = settings.type_toggles || {};
  const enabledTypes = NOTIFICATION_TYPES
    .filter((t) => isTypeEnabled(t.type, toggles))
    .map((t) => t.type);

  const results = await Promise.all(enabledTypes.map(async (type) => {
    const fn = detectors[type];
    if (typeof fn !== 'function') return [];
    try {
      const out = await fn(ctx);
      return Array.isArray(out) ? out : [];
    } catch (e) {
      // Detector failures are isolated. Log and contribute nothing.
      // We never crash the bell because one query throws.
      console.error(`[notifications] detector "${type}" failed:`, e.message);
      return [];
    }
  }));
  return results.flat();
}

/* ── State diff ──────────────────────────────────────────────────────
 * Given the live candidate set + the user's existing state rows:
 *
 *   1. Each candidate has a stable `key`. Look up existing state by key.
 *   2. New keys → insert as status='active'. Show in payload.
 *   3. Existing active/seen rows → update last_seen_at, keep visible.
 *      Snoozed rows past their snooze time → reset to active.
 *   4. Snoozed rows still in the future → hide from payload.
 *   5. Dismissed rows → hide from payload.
 *   6. State rows whose key did NOT appear in candidates → resolved.
 *      We leave them in the DB (status='seen' if active) but exclude
 *      from the bell. They reappear if the underlying signal fires
 *      again later.
 *
 * Returns the shaped payload + count of unread (active) items. */
async function diffAndShape(user, candidates) {
  const userId = user.user_id;
  const now = new Date();

  // Existing state rows scoped to this user. We pull everything the
  // user has — typically <50 rows even on busy accounts — and join
  // in memory. Cheaper than 14 separate lookups.
  const existingRows = await NotificationState.findAll({
    where: { user_id: userId },
  });
  const byKey = new Map(existingRows.map((r) => [r.notif_key, r]));
  const candidateKeys = new Set(candidates.map((c) => c.key));

  // Persist NEW candidates as fresh active rows; touch existing rows
  // so we can later prune resolved ones by age. Done in bulk where
  // possible to avoid N round-trips on busy accounts.
  const toCreate = [];
  for (const c of candidates) {
    const existing = byKey.get(c.key);
    if (!existing) {
      toCreate.push({
        user_id: userId,
        notif_key: c.key,
        type: c.type,
        status: 'active',
        first_seen_at: now,
        last_seen_at: now,
      });
    } else {
      // touch last_seen_at so resolution age is measurable; status
      // and snoozed_until stay as the user left them.
      existing.last_seen_at = now;
      await existing.save();
      // unsnooze: if the snooze has elapsed, drop the marker so the
      // row becomes active again.
      if (existing.snoozed_until && existing.snoozed_until <= now) {
        existing.snoozed_until = null;
        if (existing.status === 'dismissed') existing.status = 'active';
        await existing.save();
      }
    }
  }
  if (toCreate.length) {
    await NotificationState.bulkCreate(toCreate, { ignoreDuplicates: true });
  }

  // Re-fetch states for the live keys so the freshly-created rows
  // surface with their auto-assigned IDs and timestamps. Cheap — same
  // user, indexed by user_id.
  const liveStates = await NotificationState.findAll({
    where: { user_id: userId, notif_key: { [Op.in]: Array.from(candidateKeys) } },
  });
  const stateByKey = new Map(liveStates.map((r) => [r.notif_key, r]));

  // Filter to what the user should see right now:
  //   - skip dismissed
  //   - skip snoozed-until-future
  //   - keep active or seen
  const visible = [];
  for (const c of candidates) {
    const s = stateByKey.get(c.key);
    if (!s) continue;
    if (s.status === 'dismissed') continue;
    if (s.snoozed_until && s.snoozed_until > now) continue;
    visible.push({ candidate: c, state: s });
  }

  // Group by section + sort by severity then occurred_at desc within
  // each section.
  const SEV_ORDER = { red: 0, amber: 1, blue: 2, green: 3 };
  const grouped = { today: [], risk: [], system: [] };
  for (const { candidate, state } of visible) {
    const section = candidate.section || 'risk';
    grouped[section] = grouped[section] || [];
    grouped[section].push({
      key:          state.notif_key,
      type:         candidate.type,
      severity:     candidate.severity || 'amber',
      label:        candidate.label,
      sub:          candidate.sub || null,
      action_route: candidate.actionRoute || null,
      action_label: candidate.actionLabel || null,
      occurred_at:  candidate.occurredAt || state.first_seen_at,
      status:       state.status,
      snoozed_until: state.snoozed_until,
      meta:         candidate.meta || null,
    });
  }
  for (const k of Object.keys(grouped)) {
    grouped[k].sort((a, b) => {
      const sa = SEV_ORDER[a.severity] ?? 9;
      const sb = SEV_ORDER[b.severity] ?? 9;
      if (sa !== sb) return sa - sb;
      // Newer first within the same severity band.
      return new Date(b.occurred_at) - new Date(a.occurred_at);
    });
  }

  const unread_count = visible.filter(({ state }) => state.status === 'active').length;
  return { sections: grouped, unread_count };
}

/* ── Public API ──────────────────────────────────────────────────── */

async function getSettings(user) {
  // Seed defaults on first access so the row exists before any
  // PUT/PATCH lands. findOrCreate handles the race where two parallel
  // requests both miss the row.
  const [row] = await NotificationSettings.findOrCreate({
    where: { user_id: user.user_id },
    defaults: {
      user_id: user.user_id,
      master_enabled: true,
      type_toggles: defaultToggles(),
    },
  });
  // Backfill missing toggle keys for users whose row pre-dates a new
  // detector. Pure addition — never overrides explicit opt-out.
  let mutated = false;
  const merged = { ...defaultToggles(), ...(row.type_toggles || {}) };
  if (Object.keys(merged).length !== Object.keys(row.type_toggles || {}).length) {
    row.type_toggles = merged;
    mutated = true;
  }
  if (mutated) await row.save();
  return row;
}

async function updateSettings(user, payload) {
  const row = await getSettings(user);
  if (typeof payload.master_enabled === 'boolean') {
    row.master_enabled = payload.master_enabled;
  }
  if (payload.type_toggles && typeof payload.type_toggles === 'object') {
    // Merge so a partial update doesn't blow away other toggles.
    row.type_toggles = { ...(row.type_toggles || {}), ...payload.type_toggles };
  }
  await row.save();
  return row;
}

async function getNotifications(user) {
  const settings = await getSettings(user);
  // Master kill switch — short-circuit before any compute. The bell
  // UI uses the same setting to hide itself entirely, but the API
  // honours it independently so a stale tab still gets empty data.
  if (!settings.master_enabled) {
    return {
      master_enabled: false,
      sections: { today: [], risk: [], system: [] },
      unread_count: 0,
      types: NOTIFICATION_TYPES,
      type_toggles: settings.type_toggles || {},
    };
  }
  const candidates = await runDetectors(user, settings);
  const shaped = await diffAndShape(user, candidates);
  return {
    master_enabled: true,
    ...shaped,
    types: NOTIFICATION_TYPES,
    type_toggles: settings.type_toggles || {},
  };
}

async function getCount(user) {
  // Lightweight version used by the bell-icon poll. Skips the full
  // payload shaping but still has to run detectors — there's no way
  // to know the unread count without computing the candidate set
  // (state alone can't tell us which keys are still "live" facts).
  const settings = await getSettings(user);
  if (!settings.master_enabled) return { unread_count: 0, master_enabled: false };
  const candidates = await runDetectors(user, settings);
  const candidateKeys = new Set(candidates.map((c) => c.key));
  // Pull every state row (any status) — we need to know which
  // candidates are NEW (no state at all) vs returning seen/dismissed
  // rows. Filtering by status='active' here would miscount: a
  // dismissed candidate would appear "new" on every poll because we
  // never saw its state row.
  const states = await NotificationState.findAll({
    where: { user_id: user.user_id },
  });
  const byKey = new Map(states.map((s) => [s.notif_key, s]));
  const now = new Date();
  let count = 0;
  for (const c of candidates) {
    const s = byKey.get(c.key);
    if (!s) {
      // No state yet → brand-new candidate → counts as unread.
      count++;
      continue;
    }
    if (s.status === 'dismissed') continue;
    if (s.snoozed_until && s.snoozed_until > now) continue;
    if (s.status === 'active') count++;
    // 'seen' rows are visible but don't count toward the badge.
  }
  return { unread_count: count, master_enabled: true };
}

async function actOnKey(user, key, op, body = {}) {
  // The state row must already exist — we only mutate via this path
  // AFTER the bell has shown the row to the operator. If they
  // somehow act on a non-existent key (eg a stale tab + a fresh
  // device), respond 404 cleanly.
  const row = await NotificationState.findOne({
    where: { user_id: user.user_id, notif_key: key },
  });
  if (!row) return null;

  if (op === 'mark-seen') {
    if (row.status === 'active') row.status = 'seen';
  } else if (op === 'mark-all-seen') {
    // Bulk version — caller (controller) loops via the dedicated
    // endpoint, this branch is a safety net.
    if (row.status === 'active') row.status = 'seen';
  } else if (op === 'dismiss') {
    row.status = 'dismissed';
    row.snoozed_until = null;
  } else if (op === 'snooze') {
    // Snooze options expressed as either an explicit until-date or a
    // shorthand bucket. Bucket math here so the client doesn't have
    // to think about timezones.
    let until = null;
    if (body.until) {
      until = new Date(body.until);
    } else if (body.bucket === '1h') {
      until = new Date(Date.now() + 60 * 60 * 1000);
    } else if (body.bucket === 'tomorrow') {
      // Tomorrow 8am — the start of the operator's next working day.
      const t = new Date();
      t.setDate(t.getDate() + 1);
      t.setHours(8, 0, 0, 0);
      until = t;
    } else if (body.bucket === '1week') {
      until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }
    if (until && !Number.isNaN(until.getTime())) {
      row.snoozed_until = until;
    }
  }
  await row.save();
  return row;
}

async function markAllSeen(user) {
  await NotificationState.update(
    { status: 'seen' },
    { where: { user_id: user.user_id, status: 'active' } },
  );
}

module.exports = {
  getNotifications,
  getCount,
  actOnKey,
  markAllSeen,
  getSettings,
  updateSettings,
  // Re-export helpers for detectors that want them.
  todayString,
  daysFromToday,
  addDays,
  dateStr,
};
