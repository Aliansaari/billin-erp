/**
 * WhatsApp pacing + number helpers.
 * ────────────────────────────────
 * Pure functions (no I/O) that encode the ban-resistance policy: how many
 * messages may go out today (warm-up ramp + hard cap), whether we're inside
 * the owner's quiet-hours window, and the randomized human-like gap between
 * two consecutive sends. Kept separate from the manager so the policy is easy
 * to read, test, and tune in one place.
 */

// Normalize a raw phone string to WhatsApp's digits-only form (country code +
// number, no '+', no spaces). India-centric defaults: a bare 10-digit number
// gets '91' prepended; a leading STD '0' is dropped. Returns '' for junk so
// the caller can skip/flag it.
function normalizeNumber(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/[^\d]/g, '');
  if (!d) return '';
  // Drop a single leading STD 0 on an 11-digit Indian number (0XXXXXXXXXX).
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  // Bare 10-digit local number → assume India.
  if (d.length === 10) d = '91' + d;
  // 12-digit starting with 91 is already E.164-ish; leave anything else as-is
  // (international numbers the operator typed with their own country code).
  return d;
}

// WhatsApp JID for a normalized number.
function toJid(number) {
  return `${number}@s.whatsapp.net`;
}

// Effective cap for *today*, applying the warm-up ramp. A freshly-linked
// number should not blast its full daily_cap on day one — Meta's spam ML
// punishes sudden volume. We ramp from warmup_start by warmup_step each day
// until daily_cap. `warmup_started_on` is the anchor date (set when the
// number is first linked / first send goes out).
function effectiveDailyCap(s, now = new Date()) {
  const cap = Math.max(1, Number(s.daily_cap) || 80);
  const start = Math.max(1, Number(s.warmup_start) || cap);
  const step = Math.max(0, Number(s.warmup_step) || 0);
  if (!s.warmup_started_on) return Math.min(cap, start);
  const anchor = new Date(s.warmup_started_on);
  const days = Math.max(0, Math.floor((startOfDay(now) - startOfDay(anchor)) / 86400000));
  return Math.min(cap, start + step * days);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

// A 'YYYY-MM-DD' key for the local day — used to reset the per-day sent counter.
function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Is `now` inside the configured quiet-hours window? Handles windows that
// wrap past midnight (e.g. 21:00 → 08:00). Equal start/end disables quiet hours.
function isQuietHours(s, now = new Date()) {
  const start = parseHm(s.quiet_start);
  const end = parseHm(s.quiet_end);
  if (start == null || end == null || start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? cur >= start && cur < end          // same-day window
    : cur >= start || cur < end;          // wraps past midnight
}

function parseHm(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Randomized human-like gap (ms) between two consecutive sends.
function randomDelayMs(s) {
  let lo = Math.max(1, Number(s.min_delay_s) || 4);
  let hi = Math.max(lo, Number(s.max_delay_s) || 15);
  return Math.round((lo + Math.random() * (hi - lo)) * 1000);
}

module.exports = {
  normalizeNumber,
  toJid,
  effectiveDailyCap,
  dayKey,
  isQuietHours,
  randomDelayMs,
};
