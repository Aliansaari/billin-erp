/**
 * Staff accounts — settle-up pay for shops that pay each person on their own
 * cycle (say the 15th to the 14th) and hand money over whenever it is needed.
 *
 * The model is one running account per person:
 *   balance = Σ earned (settlements) − Σ money given − Σ old advances still open
 * Above zero the shop owes them; below zero they owe the shop (an advance),
 * which simply comes off the next settlement. Nothing has to be classified
 * up front: money given is money given.
 *
 * Invariants:
 *   - What a date range earns is worked out by payroll.computePayslip, once
 *     per calendar-month piece of the range (days outside the range are
 *     treated like days before joining). Same rules as the monthly pay run,
 *     no second calculation to drift.
 *   - PF / ESI / Professional Tax / TDS are monthly by law and stay in the
 *     monthly pay run; settle-up does not deduct them.
 *   - Ranges never overlap an earlier settlement or a month already paid
 *     through a finalized pay run.
 *   - Books: money given → Payment (Dr Staff Advances / Cr Cash|Bank);
 *     settlement → Journal (Dr Salaries & Wages / Cr Staff Advances).
 *     Cancelling reverses; nothing is edited.
 */
const { postVoucher, reverseVoucher } = require('./ledgerPostingService');
const attendance = require('./staffAttendance');
const payroll = require('./payroll');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY = 86_400_000;
const isoOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
const monthEnd = (iso) => { const [y, m] = iso.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

function db() { return require('../config/database'); }
async function q(sql, replacements = {}, transaction) { return db().query(sql, { type: db().QueryTypes.SELECT, replacements, transaction }); }
async function x(sql, replacements, transaction) { return db().query(sql, { replacements, transaction }); }

async function staffRow(staffId) {
  const [s] = await q(`SELECT staff_id, name, designation, salesman_id, attendance_enabled, is_active,
                              to_char(joined_on,'YYYY-MM-DD') AS joined_on, to_char(left_on,'YYYY-MM-DD') AS left_on
                         FROM staff_members WHERE staff_id = :id`, { id: staffId });
  if (!s) throw new Error('Staff member not found.');
  return s;
}

/** Cycle start day for a person (1–28); 1 = calendar month. */
const cycleDayOf = (structure) => Math.min(28, Math.max(1, Number(structure?.details?.cycle_day) || 1));

/** The cycle [from, to] that contains `iso` for a cycle starting on `day`. */
function cycleAround(iso, day) {
  const [y, m, d] = iso.split('-').map(Number);
  const startMonth = d >= day ? m - 1 : m - 2;          // JS month index of the cycle start
  const start = new Date(Date.UTC(y, startMonth, day)).toISOString().slice(0, 10);
  const next = new Date(Date.UTC(y, startMonth + 1, day)).toISOString().slice(0, 10);
  return { from: start, to: addDays(next, -1) };
}

// ── account ─────────────────────────────────────────────────────────

async function account(staffId) {
  const settlements = await q(`SELECT settlement_id, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date,
                                      earned::float AS earned, snapshot, created_at, voided_at, void_reason
                                 FROM staff_settlements WHERE staff_id = :s ORDER BY from_date, settlement_id`, { s: staffId });
  const given = await q(`SELECT entry_id, to_char(given_on,'YYYY-MM-DD') AS given_on, amount::float AS amount, kind, payment_mode, note,
                                settlement_id, created_at, voided_at, void_reason
                           FROM staff_money_given WHERE staff_id = :s ORDER BY given_on, entry_id`, { s: staffId });
  // Advances recorded before switching to settle-up still count, net of what pay runs already recovered.
  const oldAdv = (await payroll.advancesWithBalance({ staffId })).filter((a) => a.outstanding > 0);
  const liveS = settlements.filter((s) => !s.voided_at);
  const liveG = given.filter((g) => !g.voided_at);
  const earned = r2(liveS.reduce((t, s) => t + s.earned, 0));
  const givenT = r2(liveG.reduce((t, g) => t + g.amount, 0));
  const oldT = r2(oldAdv.reduce((t, a) => t + a.outstanding, 0));
  const last = liveS[liveS.length - 1] || null;
  return {
    settlements, given, old_advances: oldAdv,
    earned_total: earned, given_total: givenT, old_advance_total: oldT,
    balance: r2(earned - givenT - oldT),
    unsettled_given: r2(liveG.filter((g) => !g.settlement_id).reduce((t, g) => t + g.amount, 0)),
    last_settled_to: last ? last.to_date : null,
  };
}

/** Everyone's account at a glance, for the Staff accounts tab. */
async function list() {
  const staff = await q(`SELECT staff_id, name, designation, is_active, to_char(joined_on,'YYYY-MM-DD') AS joined_on FROM staff_members ORDER BY name`);
  const { current } = await payroll.structures(null);
  const today = payroll.localToday();
  const out = [];
  for (const s of staff) {
    const st = current.get(s.staff_id);
    if (!st || (!s.is_active && !payroll.isSettle(st))) continue;
    const a = await account(s.staff_id);
    if (!payroll.isSettle(st) && !a.settlements.length && !a.given.length) {
      out.push({ ...s, mode: 'run', pay_type: st.pay_type, amount: st.amount });
      continue;
    }
    const day = cycleDayOf(st);
    const cyc = cycleAround(today, day);
    out.push({
      ...s, mode: payroll.isSettle(st) ? 'settle' : 'run', pay_type: st.pay_type, amount: st.amount, cycle_day: day,
      balance: a.balance, unsettled_given: a.unsettled_given, last_settled_to: a.last_settled_to,
      current_cycle: cyc, cycle_over_unsettled: !!(a.last_settled_to ? a.last_settled_to < addDays(cyc.from, -1) : true),
    });
  }
  return out;
}

/** A sensible range to settle next: the last completed cycle not yet settled, else this cycle up to today. */
async function suggestRange(staffId) {
  const s = await staffRow(staffId);
  const { current } = await payroll.structures(null);
  const st = current.get(staffId);
  const day = cycleDayOf(st);
  const today = payroll.localToday();
  const a = await account(staffId);
  const cyc = cycleAround(today, day);
  const prevEnd = addDays(cyc.from, -1);
  let from = a.last_settled_to ? addDays(a.last_settled_to, 1) : cycleAround(prevEnd, day).from;
  if (s.joined_on && from < s.joined_on) from = s.joined_on;
  let to = prevEnd >= from ? prevEnd : today;
  if (s.left_on && to > s.left_on) to = s.left_on;
  return { from, to, cycle_day: day };
}

// ── earnings for a range ────────────────────────────────────────────

async function earnedFor(staffId, from, to, adjustments = []) {
  if (!isoOk(from) || !isoOk(to)) throw new Error('Choose the dates to settle.');
  if (to < from) throw new Error('The end date is before the start date.');
  const today = payroll.localToday();
  if (to > today) throw new Error('You can settle up to today, not days that have not happened yet.');
  if (Date.parse(to) - Date.parse(from) > 400 * DAY) throw new Error('Settle at most about a year at a time.');
  const s = await staffRow(staffId);
  const { current } = await payroll.structures(to);
  if (!current.get(staffId)) throw new Error(`Set ${s.name}'s salary first (Payroll → Salaries).`);
  const S = { ...(await payroll.getSettings()), rounding: 'none' };
  const attSettings = await attendance.getSettingsRow();
  const attCfg = attSettings.config;
  const tracked = !!attSettings.enabled && s.attendance_enabled !== false;
  const reg = await attendance.buildRegister(from, to, { staffIds: [staffId], includeInactive: true });
  const days = reg.staff[0]?.days || {};

  const revisions = ((await payroll.structures(null)).history.get(staffId) || []).map((h) => h.effective_from).sort();
  const segments = []; const notes = new Set(); const warnings = new Set();
  let statutorySkipped = false;
  const weeklyOff = new Set((attCfg.weekly_off || []).map(Number));
  const holidays = new Set((S.holidays || []).map((h) => h.date));
  const isWork = (iso) => !weeklyOff.has(new Date(`${iso}T00:00:00Z`).getUTCDay()) && !holidays.has(iso);
  const employed = (iso) => (!s.joined_on || iso >= s.joined_on) && (!s.left_on || iso <= s.left_on);
  const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
  const ATT_KEYS = ['present', 'late', 'absent', 'paid_leave', 'unpaid_leave', 'holidays', 'weekly_off', 'half_days', 'unverified', 'late_penalty_days', 'lop_days', 'ot_hours', 'worked_hours', 'paid_hours'];

  // Walk the range one pay cycle at a time (cycle_day of the salary in force).
  for (let segFrom = from; segFrom <= to;) {
    const { current: curAt } = await payroll.structures(segFrom);
    const day = cycleDayOf(curAt.get(staffId) || current.get(staffId));
    const cyc = cycleAround(segFrom, day);
    let segTo = cyc.to < to ? cyc.to : to;
    const nextRev = revisions.find((d) => d > segFrom && d <= segTo);
    if (nextRev) segTo = addDays(nextRev, -1);
    const { current: cur } = await payroll.structures(segTo);
    const st = cur.get(staffId);
    if (!st) { segments.push({ from: segFrom, to: segTo, amount: 0, earnings: [], attendance: {}, note: 'No salary set for these days' }); segFrom = addDays(segTo, 1); continue; }
    const det = st.details || {};
    if ((det.statutory && (det.statutory.pf || det.statutory.esi || det.statutory.pt)) || det.tds_monthly) statutorySkipped = true;

    // Attendance, overtime and commission come from the engine, one calendar-month piece at a time.
    const agg = Object.fromEntries(ATT_KEYS.map((k) => [k, 0])); let pieceNet = 0; const extra = new Map();
    for (let pFrom = segFrom; pFrom <= segTo; pFrom = addDays(monthEnd(pFrom), 1)) {
      const pTo = monthEnd(pFrom) < segTo ? monthEnd(pFrom) : segTo;
      const sales = s.salesman_id ? ((await payroll.salesBySalesman(pFrom, pTo)).get(s.salesman_id) || 0) : 0;
      const window = { ...s, joined_on: s.joined_on && s.joined_on > pFrom ? s.joined_on : pFrom, left_on: s.left_on && s.left_on < pTo ? s.left_on : pTo };
      const slip = payroll.computePayslip({
        period: pFrom.slice(0, 7), todayIso: today, staff: window, days, tracked, attCfg,
        structure: { ...st, details: { ...det, statutory: {}, tds_monthly: 0 } }, settings: S, sales, advances: [], adjustments: [],
      });
      slip.notes.forEach((n) => { if (!/still to come|not covered by esi/i.test(n)) notes.add(n); });
      slip.warnings.forEach((w) => warnings.add(w));
      for (const k of ATT_KEYS) agg[k] += Number(slip.attendance[k]) || 0;
      if (st.pay_type !== 'monthly') agg.paid_days = (agg.paid_days || 0) + (Number(slip.attendance.paid_days) || 0);
      pieceNet += slip.net;
      for (const e of slip.earnings) {
        if (st.pay_type === 'monthly' && e.code === 'component') continue;
        const key = e.code === 'component' ? 'Salary' : e.label;
        extra.set(key, r2((extra.get(key) || 0) + e.amount));
      }
    }

    let amount; let basis = null; let paidDays;
    const earnings = [];
    if (st.pay_type === 'monthly') {
      // A full cycle pays the monthly salary less unpaid days; part of a cycle pays for its days.
      const L = span(cyc.from, cyc.to).length;
      const segDays = span(segFrom, segTo).filter(employed);
      const cycWork = span(cyc.from, cyc.to).filter(isWork).length;
      basis = S.day_basis === '30' ? 30 : S.day_basis === '26' ? 26 : S.day_basis === 'working' ? Math.max(1, cycWork) : L;
      const avail = S.day_basis === '26' || S.day_basis === 'working' ? segDays.filter(isWork).length : segDays.length;
      const full = segFrom === cyc.from && segTo === cyc.to && segDays.length === L;
      paidDays = r2(Math.max(0, (full ? basis : Math.min(basis, avail)) - agg.lop_days));
      const salary = r2(Number(st.amount) * paidDays / basis);
      earnings.push({ label: 'Salary', amount: salary, note: `${paidDays} of ${basis} days${full ? '' : ' (part of the cycle)'}` });
      for (const [label, v] of extra) earnings.push({ label, amount: v });
      amount = r2(earnings.reduce((t, e) => t + e.amount, 0));
    } else {
      paidDays = r2(agg.paid_days || 0);
      for (const [label, v] of extra) earnings.push({ label, amount: v, note: label === 'Salary' ? (st.pay_type === 'daily' ? `${paidDays} days x ${st.amount}` : `${r2(agg.paid_hours)} h x ${st.amount}`) : null });
      amount = r2(pieceNet);
    }
    segments.push({
      from: segFrom, to: segTo, cycle: cyc, pay_type: st.pay_type, rate: Number(st.amount), basis_days: basis, amount, earnings,
      attendance: { ...Object.fromEntries(ATT_KEYS.map((k) => [k, r2(agg[k])])), paid_days: paidDays },
      in_range_days: span(segFrom, segTo).length,
    });
    segFrom = addDays(segTo, 1);
  }
  const sum = (k) => r2(segments.reduce((t, g) => t + (Number(g.attendance?.[k]) || 0), 0));
  const att = {
    days: segments.reduce((t, g) => t + (g.in_range_days || 0), 0),
    paid_days: sum('paid_days'), present: sum('present'), late: sum('late'), absent: sum('absent'),
    paid_leave: sum('paid_leave'), unpaid_leave: sum('unpaid_leave'), holidays: sum('holidays'), weekly_off: sum('weekly_off'),
    half_days: sum('half_days'), lop_days: sum('lop_days'), ot_hours: sum('ot_hours'), worked_hours: sum('worked_hours'), paid_hours: sum('paid_hours'),
    not_employed: span(from, to).filter((d) => !employed(d)).length,
  };
  const base = r2(segments.reduce((t, g) => t + g.amount, 0));
  const adj = (Array.isArray(adjustments) ? adjustments : []).slice(0, 20).map((a) => ({
    type: a.type === 'deduction' ? 'deduction' : 'earning', label: String(a.label || '').slice(0, 60) || (a.type === 'deduction' ? 'Deduction' : 'Bonus'),
    amount: r2(Math.abs(Number(a.amount) || 0)), note: a.note ? String(a.note).slice(0, 200) : null,
  })).filter((a) => a.amount > 0);
  const adjNet = r2(adj.reduce((t, a) => t + (a.type === 'deduction' ? -a.amount : a.amount), 0));
  const earned = Math.max(0, Math.round(base + adjNet));
  if (statutorySkipped) warnings.add('PF, ESI, Professional Tax and TDS are monthly and are not deducted in settle-up. Use the monthly pay run for this person if they apply.');
  return {
    staff: { staff_id: s.staff_id, name: s.name, designation: s.designation || null },
    from, to, tracked, segments, attendance: att, salary: base, adjustments: adj, earned,
    notes: [...notes], warnings: [...warnings],
  };
}

async function overlapCheck(staffId, from, to, t) {
  const clash = await q(`SELECT to_char(from_date,'DD Mon YYYY') AS f, to_char(to_date,'DD Mon YYYY') AS tt FROM staff_settlements
                          WHERE staff_id = :s AND voided_at IS NULL AND from_date <= :to AND to_date >= :from LIMIT 1`, { s: staffId, from, to }, t);
  if (clash.length) throw new Error(`These dates overlap the settlement for ${clash[0].f} to ${clash[0].tt}.`);
  const run = await q(`SELECT r.period FROM payslips p JOIN payroll_runs r ON r.run_id = p.run_id
                        WHERE p.staff_id = :s AND r.status = 'finalized' AND p.snapshot IS NOT NULL
                          AND (r.period || '-01')::date <= :to AND ((r.period || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day') >= :from
                        ORDER BY r.period DESC LIMIT 1`, { s: staffId, from, to }, t);
  if (run.length) throw new Error(`${run[0].period} is already paid through the monthly pay run for this person. Start after that month.`);
}

/** What settling [from, to] would look like — nothing is saved. */
async function preview(staffId, { from, to, adjustments }) {
  const e = await earnedFor(staffId, from, to, adjustments);
  await overlapCheck(staffId, from, to);
  const a = await account(staffId);
  const settledGiven = a.given.filter((g) => !g.voided_at && g.settlement_id);
  const broughtForward = r2(a.earned_total - settledGiven.reduce((t, g) => t + g.amount, 0) - a.old_advance_total);
  const inPeriod = a.given.filter((g) => !g.voided_at && !g.settlement_id && g.given_on <= to);
  const later = a.given.filter((g) => !g.voided_at && !g.settlement_id && g.given_on > to);
  const givenNow = r2(inPeriod.reduce((t, g) => t + g.amount, 0));
  return {
    ...e,
    brought_forward: broughtForward,
    old_advances: a.old_advances,
    given: inPeriod, given_total: givenNow, given_later: later,
    owed: r2(broughtForward + e.earned - givenNow),
    last_settled_to: a.last_settled_to,
  };
}

// ── writes ──────────────────────────────────────────────────────────

/** The salary in force on `iso` (or the earliest one if `iso` is before all of them). */
async function structureOn(staffId, iso) {
  const { history } = await payroll.structures(null);
  const h = history.get(staffId) || [];
  return [...h].reverse().find((x) => x.effective_from <= iso) || h[0] || null;
}
async function requireSettle(staffId, iso, name) {
  const st = await structureOn(staffId, iso);
  if (!st) throw new Error(`Set ${name}'s salary first (Payroll → Salaries).`);
  if (!payroll.isSettle(st)) {
    throw new Error(`${name} is paid through the monthly pay run. Record money given to them in Advances, so the pay run recovers it.`);
  }
}

async function postIfOn(fn) { const s = await payroll.getSettings(); if (s.post_to_accounts) await fn(); }

async function giveMoney(staffId, { given_on, amount, payment_mode = 'Cash', bank_ledger_id, note, kind = 'advance' }, userId, t0) {
  const amt = r2(amount);
  if (!(amt > 0)) throw new Error('Enter the amount given.');
  if (!isoOk(given_on)) throw new Error('Choose the date.');
  if (given_on > payroll.localToday()) throw new Error('The date is in the future.');
  if (!['Cash', 'Bank'].includes(payment_mode)) throw new Error('Given by cash or bank.');
  const s = await staffRow(staffId);
  if (!t0) await requireSettle(staffId, given_on, s.name);
  const t = t0 || await db().transaction();
  try {
    const [row] = await q(`INSERT INTO staff_money_given (staff_id, given_on, amount, kind, payment_mode, bank_ledger_id, note, created_by)
                            VALUES (:s, :d, :a, :k, :m, :b, :n, :u) RETURNING entry_id`,
    { s: staffId, d: given_on, a: amt, k: kind === 'salary' ? 'salary' : 'advance', m: payment_mode, b: payment_mode === 'Bank' ? Number(bank_ledger_id) || null : null, n: note ? String(note).slice(0, 200) : null, u: userId || null }, t);
    await postIfOn(async () => {
      const credit = await payroll.cashOrBank(payment_mode, bank_ledger_id, t);
      await postVoucher({ voucherType: 'Payment', sourceType: 'staff_money', sourceId: row.entry_id, voucherDate: given_on,
        referenceNumber: `Staff ${s.name}`.slice(0, 60), lines: [{ ledgerAccountId: await payroll.ledgerId('advance', t), debit: amt }, { ledgerAccountId: credit, credit: amt }],
        narration: `${kind === 'salary' ? 'Salary paid' : 'Money given'} to ${s.name}${note ? `: ${note}` : ''}`, userId, transaction: t });
    });
    if (!t0) await t.commit();
    return row.entry_id;
  } catch (err) { if (!t0) await t.rollback().catch(() => {}); throw err; }
}

async function voidMoney(entryId, reason, userId) {
  if (!reason || String(reason).trim().length < 3) throw new Error('Give a reason.');
  const t = await db().transaction();
  try {
    const [row] = await q('SELECT * FROM staff_money_given WHERE entry_id = :id FOR UPDATE', { id: entryId }, t);
    if (!row || row.voided_at) throw new Error('Entry not found.');
    if (row.settlement_id) throw new Error('This amount is part of a settlement. Cancel that settlement first.');
    await reverseVoucher({ sourceType: 'staff_money', sourceId: row.entry_id, reason, userId, transaction: t });
    await x('UPDATE staff_money_given SET voided_at = NOW(), void_reason = :r WHERE entry_id = :id', { r: String(reason).slice(0, 200), id: entryId }, t);
    await t.commit();
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
}

/**
 * Settle [from, to]: record what was earned, count the money given up to `to`,
 * and optionally pay now. Paying more than owed is allowed; the extra is an
 * advance by construction (the balance goes below zero).
 */
async function settle(staffId, { from, to, adjustments, pay }, userId, { journalDate } = {}) {
  const s = await staffRow(staffId);
  await requireSettle(staffId, to, s.name);
  const p = await preview(staffId, { from, to, adjustments });
  const payAmt = pay && Number(pay.amount) > 0 ? r2(pay.amount) : 0;
  const t = await db().transaction();
  let id;
  try {
    // Serialise settlements per person.
    await q('SELECT staff_id FROM staff_members WHERE staff_id = :s FOR UPDATE', { s: staffId }, t);
    await overlapCheck(staffId, from, to, t);
    const snapshot = { ...p, given: p.given.map((g) => ({ entry_id: g.entry_id, given_on: g.given_on, amount: g.amount, note: g.note, kind: g.kind })), given_later: undefined, old_advances: undefined,
      paid_now: payAmt, balance_after: r2(p.owed - payAmt), journal_date: journalDate || to };
    const [row] = await q(`INSERT INTO staff_settlements (staff_id, from_date, to_date, earned, snapshot, created_by)
                            VALUES (:s, :f, :t, :e, CAST(:snap AS jsonb), :u) RETURNING settlement_id`,
    { s: staffId, f: from, t: to, e: p.earned, snap: JSON.stringify(snapshot), u: userId || null }, t);
    id = row.settlement_id;
    if (p.given.length) await x(`UPDATE staff_money_given SET settlement_id = :id WHERE entry_id IN (:ids) AND settlement_id IS NULL AND voided_at IS NULL`, { id, ids: p.given.map((g) => g.entry_id) }, t);
    if (p.earned > 0) {
      await postIfOn(async () => {
        await postVoucher({ voucherType: 'Journal', sourceType: 'staff_settlement', sourceId: id, voucherDate: journalDate || to,
          referenceNumber: `Salary ${s.name}`.slice(0, 60),
          lines: [{ ledgerAccountId: await payroll.ledgerId('salary', t), debit: p.earned }, { ledgerAccountId: await payroll.ledgerId('advance', t), credit: p.earned }],
          narration: `Salary ${from} to ${to}: ${s.name}`, userId, transaction: t });
      });
    }
    if (payAmt > 0) {
      const entryId = await giveMoney(staffId, { given_on: pay.paid_on || payroll.localToday(), amount: payAmt, payment_mode: pay.payment_mode || 'Cash',
        bank_ledger_id: pay.bank_ledger_id, note: pay.note || `Salary ${shortDate(from)} – ${shortDate(to)}`, kind: 'salary' }, userId, t);
      await x('UPDATE staff_money_given SET settlement_id = :id WHERE entry_id = :e', { id, e: entryId }, t);
    }
    await t.commit();
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
  return { settlement_id: id, earned: p.earned, owed: p.owed, paid: payAmt, balance: r2(p.owed - payAmt) };
}

async function cancelSettlement(settlementId, reason, userId) {
  if (!reason || String(reason).trim().length < 3) throw new Error('Give a reason.');
  const t = await db().transaction();
  try {
    const [row] = await q('SELECT * FROM staff_settlements WHERE settlement_id = :id FOR UPDATE', { id: settlementId }, t);
    if (!row || row.voided_at) throw new Error('Settlement not found.');
    const later = await q(`SELECT 1 FROM staff_settlements WHERE staff_id = :s AND voided_at IS NULL AND from_date > :f LIMIT 1`, { s: row.staff_id, f: row.from_date }, t);
    if (later.length) throw new Error('A later settlement exists. Cancel the latest one first.');
    await reverseVoucher({ sourceType: 'staff_settlement', sourceId: row.settlement_id, reason, userId, transaction: t });
    // Money handed over stays recorded as given (it really left the drawer); it just becomes unsettled again.
    await x('UPDATE staff_money_given SET settlement_id = NULL WHERE settlement_id = :id', { id: row.settlement_id }, t);
    await x('UPDATE staff_settlements SET voided_at = NOW(), void_reason = :r WHERE settlement_id = :id', { r: String(reason).slice(0, 200), id: row.settlement_id }, t);
    await t.commit();
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
}

module.exports = { cycleAround, account, list, suggestRange, earnedFor, preview, giveMoney, voidMoney, settle, cancelSettlement };
