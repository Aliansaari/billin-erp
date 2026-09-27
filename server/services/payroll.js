/**
 * Payroll — salary from attendance, for a two-person shop or a company.
 *
 * One engine, three levels of detail the owner opts into:
 *   - Simple:    a monthly / daily / hourly figure per person. Absences and
 *                unpaid leave come off; advances are recovered.
 *   - Rules:     overtime, late marks, half days, holidays, day basis.
 *   - Statutory: salary breakup (Basic, HRA …), PF, ESI, Professional Tax,
 *                TDS, and employer cost.
 *
 * Invariants:
 *   - computePayslip() is pure and is the ONLY place pay is worked out. The
 *     pay-run screen, the payslip, the books and the staff phone all read
 *     its output, so they can never disagree.
 *   - Attendance comes from staffAttendance.buildRegister(), never re-derived.
 *   - A finalized month is frozen: its payslips keep the snapshot they were
 *     finalized with. Later edits to attendance or salaries never change it;
 *     "Reopen" (only while nothing is paid) is the one way back.
 *   - Money reaches the books only through ledgerPostingService: a journal on
 *     finalize (expense ↔ payables), payment vouchers on payout and advances.
 *     Reversals, never edits.
 *   - Salary structures are dated revisions; a raise never rewrites a past month.
 */
const { postVoucher, reverseVoucher } = require('./ledgerPostingService');
const attendance = require('./staffAttendance');

const DAY_MS = 86_400_000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
/** ₹ with Indian digit grouping, for the notes owners and staff read. */
const rs = (n) => `₹${r2(n).toLocaleString('en-IN')}`;

// ── settings ────────────────────────────────────────────────────────

// Professional Tax presets. Rates change and some states differ by gender or
// half-year, so these are editable starting points, not advice.
const PT_PRESETS = {
  MH: { label: 'Maharashtra', slabs: [{ upto: 7500, amount: 0 }, { upto: 10000, amount: 175 }, { upto: null, amount: 200, feb: 300 }] },
  KA: { label: 'Karnataka', slabs: [{ upto: 24999, amount: 0 }, { upto: null, amount: 200, feb: 300 }] },
  WB: { label: 'West Bengal', slabs: [{ upto: 10000, amount: 0 }, { upto: 15000, amount: 110 }, { upto: 25000, amount: 130 }, { upto: 40000, amount: 150 }, { upto: null, amount: 200 }] },
  GJ: { label: 'Gujarat', slabs: [{ upto: 11999, amount: 0 }, { upto: null, amount: 200 }] },
  TS: { label: 'Telangana', slabs: [{ upto: 15000, amount: 0 }, { upto: 20000, amount: 150 }, { upto: null, amount: 200 }] },
  AP: { label: 'Andhra Pradesh', slabs: [{ upto: 15000, amount: 0 }, { upto: 20000, amount: 150 }, { upto: null, amount: 200 }] },
  MP: { label: 'Madhya Pradesh', slabs: [{ upto: 18750, amount: 0 }, { upto: 25000, amount: 125 }, { upto: 33333, amount: 167 }, { upto: null, amount: 208, feb: 212 }] },
  custom: { label: 'Custom slabs', slabs: [{ upto: null, amount: 0 }] },
};

const DEFAULT_SETTINGS = {
  day_basis: 'calendar',          // calendar | 30 | 26 | working  (divisor for monthly pay)
  paid_weekly_off: true,          // daily-paid staff: is the weekly off paid?
  holidays: [],                   // [{ date: 'YYYY-MM-DD', name }]
  unverified_as: 'absent',        // a check-in the shop could not verify: absent | present
  half_day: { enabled: false, below_hours: 4 },
  late_penalty: { enabled: false, every: 3, deduct_days: 0.5 },
  overtime: { enabled: false, multiplier: 1.5, min_minutes: 30 },
  pf: { enabled: false, employee_rate: 12, employer_rate: 12, wage_ceiling: 15000, cap: true },
  esi: { enabled: false, employee_rate: 0.75, employer_rate: 3.25, gross_limit: 21000 },
  pt: { enabled: false, state: 'MH', slabs: PT_PRESETS.MH.slabs },
  rounding: 'rupee',              // rupee | none
  post_to_accounts: true,
  staff_see_payslips: false,
};

function mergeSettings(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_SETTINGS, ...c };
  for (const k of ['half_day', 'late_penalty', 'overtime', 'pf', 'esi', 'pt']) out[k] = { ...DEFAULT_SETTINGS[k], ...(c[k] || {}) };
  if (!Array.isArray(out.holidays)) out.holidays = [];
  if (!Array.isArray(out.pt.slabs) || !out.pt.slabs.length) out.pt.slabs = PT_PRESETS.MH.slabs;
  return out;
}

// ── structure helpers ───────────────────────────────────────────────

/** Default breakup used when the owner turns on "Salary breakup". */
const STANDARD_COMPONENTS = [
  { name: 'Basic', calc: 'percent', value: 50, pf: true },
  { name: 'HRA', calc: 'percent', value: 20, pf: false },
  { name: 'Special allowance', calc: 'balance', value: 0, pf: false },
];

/** Split `total` across components. percent = of total, fixed = ₹, balance = what is left. */
function splitComponents(total, comps) {
  if (!Array.isArray(comps) || !comps.length) return [{ name: 'Salary', amount: r2(total), pf: true }];
  let used = 0; const out = [];
  for (const c of comps) {
    if (c.calc === 'balance') { out.push({ name: c.name, amount: null, pf: !!c.pf }); continue; }
    const a = c.calc === 'fixed' ? Number(c.value) || 0 : total * (Number(c.value) || 0) / 100;
    used += a; out.push({ name: c.name, amount: r2(a), pf: !!c.pf });
  }
  const bal = out.find((c) => c.amount === null);
  if (bal) bal.amount = r2(Math.max(0, total - used));
  return out;
}

function ptFor(gross, slabs, month) {
  const sorted = [...slabs].sort((a, b) => (a.upto ?? Infinity) - (b.upto ?? Infinity));
  const slab = sorted.find((s) => s.upto == null || gross <= Number(s.upto));
  if (!slab) return 0;
  return month === 2 && slab.feb != null ? Number(slab.feb) : Number(slab.amount) || 0;
}

const hhmm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// ── the engine ──────────────────────────────────────────────────────

/**
 * Work out one person's pay for one month.
 *
 * @param {object} a
 *   period       'YYYY-MM'
 *   todayIso     local today (days after it are assumed worked, and flagged)
 *   staff        { staff_id, name, designation, joined_on, left_on, attendance_enabled, salesman_id }
 *   days         buildRegister day map for this person (may be {} when attendance is off)
 *   tracked      true when attendance is on for this person
 *   attCfg       attendance config (open_time, close_time, weekly_off)
 *   structure    { pay_type, amount, details }
 *   settings     merged payroll settings
 *   sales        taxable sales billed by this person's salesman in the month
 *   advances     [{ advance_id, given_on, installment, outstanding }]
 *   adjustments  [{ type: 'earning'|'deduction', label, amount, note }]
 *   recoveries   { [advance_id]: amount }
 */
function computePayslip(a) {
  const { period, todayIso, staff, days = {}, tracked, attCfg = {}, structure, settings: S } = a;
  const det = structure.details || {};
  const stat = det.statutory || {};
  const [yy, mm] = period.split('-').map(Number);
  const D = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const isoOf = (d) => `${period}-${String(d).padStart(2, '0')}`;
  const weeklyOff = new Set((attCfg.weekly_off || []).map(Number));
  const holidays = new Map((S.holidays || []).filter((h) => h?.date?.startsWith(period)).map((h) => [h.date, h.name || 'Holiday']));
  const shiftMin = Math.max(60, ((hhmm(attCfg.close_time) ?? 1260) - (hhmm(attCfg.open_time) ?? 600)));
  const joined = staff.joined_on ? String(staff.joined_on).slice(0, 10) : null;
  const left = staff.left_on ? String(staff.left_on).slice(0, 10) : null;

  const att = { days_in_month: D, present: 0, late: 0, half_days: 0, paid_leave: 0, unpaid_leave: 0, absent: 0, unverified: 0,
    weekly_off: 0, holidays: 0, not_employed: 0, not_employed_workdays: 0, assumed: 0, future: 0, worked_min: 0, ot_min: 0 };
  const notes = []; const warnings = [];

  for (let d = 1; d <= D; d++) {
    const iso = isoOf(d);
    const wd = new Date(Date.UTC(yy, mm - 1, d)).getUTCDay();
    const isOff = weeklyOff.has(wd);
    const hol = holidays.has(iso);
    if ((joined && iso < joined) || (left && iso > left)) { att.not_employed++; if (!isOff && !hol) att.not_employed_workdays++; continue; }
    const day = days[iso] || {};
    const leave = day.leave;
    const worked = day.status === 'present' || day.status === 'late';
    if (worked) {
      att.present++; if (day.status === 'late') att.late++;
      att.worked_min += day.worked_min || 0;
      if (S.half_day.enabled && iso < todayIso && (day.worked_min || 0) < Number(S.half_day.below_hours) * 60) att.half_days++;
      if (S.overtime.enabled && (day.worked_min || 0) - shiftMin >= Number(S.overtime.min_minutes || 0)) att.ot_min += (day.worked_min || 0) - shiftMin;
      continue;
    }
    if (leave && day.status === 'leave') { if (leave.type === 'unpaid') att.unpaid_leave++; else att.paid_leave++; continue; }
    if (iso > todayIso || (iso === todayIso && day.status !== 'absent')) { att.future++; continue; }
    if (!tracked || day.status === 'none' || day.status === undefined) {
      if (isOff) att.weekly_off++; else if (hol) att.holidays++; else att.assumed++;
      continue;
    }
    if (day.status === 'off' || isOff) { att.weekly_off++; continue; }
    if (hol) { att.holidays++; continue; }
    if (day.status === 'unverified') { att.unverified++; continue; }
    att.absent++;
  }

  const unverifiedLop = S.unverified_as === 'present' ? 0 : att.unverified;
  const latePenalty = S.late_penalty.enabled && Number(S.late_penalty.every) > 0
    ? Math.floor(att.late / Number(S.late_penalty.every)) * Number(S.late_penalty.deduct_days || 0) : 0;
  att.late_penalty_days = latePenalty;
  att.lop_days = r2(att.absent + att.unpaid_leave + unverifiedLop + att.half_days * 0.5 + latePenalty);
  if (att.future) notes.push(`${att.future} day${att.future === 1 ? '' : 's'} still to come counted as worked.`);
  if (att.assumed && tracked) notes.push(`${att.assumed} day${att.assumed === 1 ? '' : 's'} before attendance started counted as worked.`);

  const payType = structure.pay_type || 'monthly';
  const amount = Number(structure.amount) || 0;
  const earnings = []; const deductions = []; const employer = [];
  let earned = 0; let basisDays = null; let hourlyRate = 0;

  if (payType === 'monthly') {
    const offDays = [...Array(D)].reduce((n, _, i) => n + (weeklyOff.has(new Date(Date.UTC(yy, mm - 1, i + 1)).getUTCDay()) ? 1 : 0), 0);
    basisDays = S.day_basis === '30' ? 30 : S.day_basis === '26' ? 26 : S.day_basis === 'working' ? Math.max(1, D - offDays - holidays.size) : D;
    const notEmployed = S.day_basis === '26' || S.day_basis === 'working' ? att.not_employed_workdays : att.not_employed;
    att.paid_days = r2(Math.max(0, basisDays - att.lop_days - notEmployed));
    const factor = Math.min(1, att.paid_days / basisDays);
    earned = amount * factor;
    hourlyRate = amount / basisDays / (shiftMin / 60);
    for (const c of splitComponents(amount, det.components)) {
      const v = r2(c.amount * factor);
      earnings.push({ code: 'component', label: c.name, amount: v, full: c.amount, pf: c.pf });
    }
  } else if (payType === 'daily') {
    const offPaid = S.paid_weekly_off ? att.weekly_off : 0;
    att.paid_days = r2(Math.max(0, att.present - att.half_days * 0.5 + att.paid_leave + att.holidays + att.assumed + att.future + offPaid - latePenalty));
    earned = amount * att.paid_days;
    hourlyRate = amount / (shiftMin / 60);
    for (const c of splitComponents(earned, det.components)) earnings.push({ code: 'component', label: c.name, amount: r2(c.amount), pf: c.pf, note: `${att.paid_days} days × ${rs(amount)}` });
  } else {
    const paidHours = att.worked_min / 60 + (att.paid_leave + att.holidays + att.assumed + att.future) * (shiftMin / 60);
    att.paid_hours = r2(paidHours);
    earned = amount * paidHours;
    hourlyRate = amount;
    for (const c of splitComponents(earned, det.components)) earnings.push({ code: 'component', label: c.name, amount: r2(c.amount), pf: c.pf, note: `${r2(paidHours)} h × ${rs(amount)}` });
  }
  att.worked_hours = r2(att.worked_min / 60);

  if (S.overtime.enabled && det.overtime !== false && payType !== 'hourly' && att.ot_min > 0) {
    att.ot_hours = r2(att.ot_min / 60);
    const ot = r2(att.ot_hours * hourlyRate * Number(S.overtime.multiplier || 1));
    if (ot > 0) earnings.push({ code: 'overtime', label: 'Overtime', amount: ot, note: `${att.ot_hours} h × ${rs(r2(hourlyRate))} × ${S.overtime.multiplier}` });
  }

  const commPct = det.commission?.enabled ? Number(det.commission.percent) || 0 : 0;
  if (commPct > 0) {
    const c = r2((Number(a.sales) || 0) * commPct / 100);
    earnings.push({ code: 'commission', label: 'Sales commission', amount: c, note: `${commPct}% of ${rs(r2(a.sales || 0))} sales` });
    if (!staff.salesman_id) warnings.push('Commission is on, but this person is not linked to a salesman, so their sales are ₹0.');
  }

  for (const adj of a.adjustments || []) {
    const v = r2(Math.abs(Number(adj.amount) || 0));
    if (!v) continue;
    (adj.type === 'deduction' ? deductions : earnings).push({ code: 'adjustment', label: adj.label || (adj.type === 'deduction' ? 'Deduction' : 'Bonus'), amount: v, note: adj.note || null, adj_id: adj.id });
  }

  const gross = r2(earnings.reduce((t, e) => t + e.amount, 0));

  // Statutory
  const month = mm;
  if (S.pf.enabled && stat.pf) {
    let pfWage = earnings.filter((e) => e.code === 'component' && e.pf).reduce((t, e) => t + e.amount, 0);
    if (S.pf.cap && pfWage > Number(S.pf.wage_ceiling)) pfWage = Number(S.pf.wage_ceiling);
    const emp = Math.round(pfWage * Number(S.pf.employee_rate) / 100);
    const er = Math.round(pfWage * Number(S.pf.employer_rate) / 100);
    if (emp) deductions.push({ code: 'pf', label: 'Provident Fund', amount: emp, note: `${S.pf.employee_rate}% of ${rs(r2(pfWage))}` });
    if (er) employer.push({ code: 'pf', label: 'PF (employer)', amount: er });
  }
  if (S.esi.enabled && stat.esi) {
    const fullMonthly = payType === 'monthly' ? amount : payType === 'daily' ? amount * 26 : amount * 26 * (shiftMin / 60);
    if (fullMonthly <= Number(S.esi.gross_limit)) {
      const emp = Math.ceil(gross * Number(S.esi.employee_rate) / 100);
      const er = Math.ceil(gross * Number(S.esi.employer_rate) / 100);
      if (emp) deductions.push({ code: 'esi', label: 'ESI', amount: emp, note: `${S.esi.employee_rate}% of ${rs(gross)}` });
      if (er) employer.push({ code: 'esi', label: 'ESI (employer)', amount: er });
    } else notes.push(`Not covered by ESI: salary is above ${rs(S.esi.gross_limit)}.`);
  }
  if (S.pt.enabled && stat.pt) {
    const pt = ptFor(gross, S.pt.slabs, month);
    if (pt) deductions.push({ code: 'pt', label: 'Professional Tax', amount: pt });
  }
  const tds = r2(det.tds_monthly || 0);
  if (tds) deductions.push({ code: 'tds', label: 'Income tax (TDS)', amount: tds });

  // Advances come off last, and never push pay below zero.
  let room = r2(gross - deductions.reduce((t, x) => t + x.amount, 0));
  for (const adv of a.advances || []) {
    const outstanding = r2(adv.outstanding);
    if (outstanding <= 0) continue;
    const override = a.recoveries && a.recoveries[adv.advance_id] != null ? Number(a.recoveries[adv.advance_id]) : null;
    let want = override != null ? override : (Number(adv.installment) > 0 ? Math.min(Number(adv.installment), outstanding) : outstanding);
    want = r2(Math.max(0, Math.min(want, outstanding, Math.max(0, room))));
    if (want > 0) {
      deductions.push({ code: 'advance', label: 'Advance recovery', amount: want, advance_id: adv.advance_id,
        note: `${rs(r2(outstanding - want))} left of ${rs(r2(adv.amount))} given ${String(adv.given_on).slice(0, 10)}` });
      room = r2(room - want);
    } else if (override == null && room <= 0) warnings.push('Advance recovery skipped this month: nothing left to recover from.');
  }

  const totalDed = r2(deductions.reduce((t, x) => t + x.amount, 0));
  let net = r2(gross - totalDed);
  if (net < 0) { warnings.push('Deductions are more than the pay. Net pay set to ₹0.'); net = 0; }
  let roundOff = 0;
  if (S.rounding === 'rupee') { const rn = Math.round(net); roundOff = r2(rn - net); net = rn; }
  const employerTotal = r2(employer.reduce((t, x) => t + x.amount, 0));

  return {
    period,
    staff: { staff_id: staff.staff_id, name: staff.name, designation: staff.designation || null, joined_on: joined, left_on: left },
    pay_type: payType, rate: amount, basis_days: basisDays, hourly_rate: r2(hourlyRate), tracked: !!tracked,
    attendance: att, earnings, deductions, employer,
    gross, total_deductions: totalDed, round_off: roundOff, net, employer_cost: r2(gross + employerTotal),
    bank: det.bank || null, ids: { pan: det.pan || null, uan: det.uan || null, esic: det.esic || null },
    notes, warnings,
  };
}

// ── database plumbing ───────────────────────────────────────────────

function db() { return require('../config/database'); }
async function q(sql, opts = {}) { return db().query(sql, { type: db().QueryTypes.SELECT, ...opts }); }
async function x(sql, replacements, transaction) { return db().query(sql, { replacements, transaction }); }

async function getSettings() {
  const rows = await q('SELECT config FROM payroll_settings WHERE id = 1').catch(() => []);
  return mergeSettings(rows[0]?.config);
}
async function saveSettings(config) {
  const merged = mergeSettings(config);
  await x(`INSERT INTO payroll_settings (id, config, modified_date) VALUES (1, CAST(:c AS jsonb), NOW())
           ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, modified_date = NOW()`, { c: JSON.stringify(merged) });
  return merged;
}

const periodBounds = (period) => {
  const [y, m] = period.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from: `${period}-01`, to: end };
};
const validPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));

/** Latest structure per staff effective on or before `onIso`, plus full history. */
async function structures(onIso) {
  const rows = await q(`SELECT structure_id, staff_id, to_char(effective_from,'YYYY-MM-DD') AS effective_from, pay_type, amount::float AS amount, details
                          FROM staff_salary_structures ORDER BY staff_id, effective_from`);
  const current = new Map(); const history = new Map();
  for (const r of rows) {
    if (!history.has(r.staff_id)) history.set(r.staff_id, []);
    history.get(r.staff_id).push(r);
    if (!onIso || r.effective_from <= onIso) current.set(r.staff_id, r);
  }
  return { current, history };
}

async function saveStructure(staffId, { effective_from, pay_type, amount, details }, userId) {
  if (!['monthly', 'daily', 'hourly'].includes(pay_type)) throw new Error('Pay type must be monthly, daily or hourly.');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) throw new Error('Enter a valid salary amount.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effective_from || ''))) throw new Error('Choose the date this salary starts from.');
  // A finalized month keeps what it was finalized with; say so rather than surprise.
  await x(`INSERT INTO staff_salary_structures (staff_id, effective_from, pay_type, amount, details, created_by)
           VALUES (:s, :f, :p, :a, CAST(:d AS jsonb), :u)
           ON CONFLICT (staff_id, effective_from) DO UPDATE SET pay_type = EXCLUDED.pay_type, amount = EXCLUDED.amount,
             details = EXCLUDED.details, created_by = EXCLUDED.created_by, created_at = NOW()`,
  { s: staffId, f: effective_from, p: pay_type, a: amt, d: JSON.stringify(details || {}), u: userId || null });
}

async function deleteStructure(structureId) {
  await x('DELETE FROM staff_salary_structures WHERE structure_id = :id', { id: structureId });
}

/** Recovered-so-far per advance, from finalized payslips only. */
async function advancesWithBalance({ staffId = null, excludeRunId = null } = {}) {
  const adv = await q(`SELECT advance_id, staff_id, to_char(given_on,'YYYY-MM-DD') AS given_on, amount::float AS amount,
                              installment::float AS installment, payment_mode, reason, voided_at, void_reason
                         FROM staff_advances WHERE voided_at IS NULL ${staffId ? 'AND staff_id = :s' : ''} ORDER BY given_on, advance_id`,
  { replacements: { s: staffId } });
  const rec = await q(`SELECT (d->>'advance_id')::int AS advance_id, SUM((d->>'amount')::numeric)::float AS recovered
                         FROM payslips p JOIN payroll_runs r ON r.run_id = p.run_id,
                              jsonb_array_elements(COALESCE(p.snapshot->'deductions','[]'::jsonb)) d
                        WHERE r.status = 'finalized' AND d->>'code' = 'advance' ${excludeRunId ? 'AND r.run_id <> :ex' : ''}
                        GROUP BY 1`, { replacements: { ex: excludeRunId } });
  const got = new Map(rec.map((r) => [r.advance_id, r.recovered]));
  return adv.map((a) => ({ ...a, recovered: r2(got.get(a.advance_id) || 0), outstanding: r2(a.amount - (got.get(a.advance_id) || 0)) }));
}

async function salesBySalesman(from, to) {
  const rows = await q(`SELECT salesman_id, COALESCE(SUM(sub_total),0)::float AS sales FROM sales_bills
                         WHERE is_cancelled = false AND salesman_id IS NOT NULL AND bill_date BETWEEN :f AND :t GROUP BY salesman_id`,
  { replacements: { f: from, t: to } }).catch(() => []);
  return new Map(rows.map((r) => [r.salesman_id, r.sales]));
}

function localToday(offMin = 330) { return new Date(Date.now() + offMin * 60_000).toISOString().slice(0, 10); }

// ── pay runs ────────────────────────────────────────────────────────

async function findRun(period) {
  return (await q('SELECT * FROM payroll_runs WHERE period = :p', { replacements: { p: period } }))[0] || null;
}

async function ensureRun(period) {
  await x(`INSERT INTO payroll_runs (period) VALUES (:p) ON CONFLICT (period) DO NOTHING`, { p: period });
  return findRun(period);
}

/**
 * Everything the pay-run screen needs for a month. Draft months are worked
 * out live; finalized months are read from their frozen snapshots.
 */
async function getRun(period) {
  if (!validPeriod(period)) throw new Error('Choose a month.');
  const settings = await getSettings();
  const attSettings = await attendance.getSettingsRow();
  const attCfg = attSettings.config;
  const today = localToday(Number(attCfg.tz_offset_min) || 330);
  const { from, to } = periodBounds(period);
  const run = await findRun(period);
  const slips = run ? await q(`SELECT * FROM payslips WHERE run_id = :r`, { replacements: { r: run.run_id } }) : [];
  const slipByStaff = new Map(slips.map((s) => [s.staff_id, s]));
  const paidRows = slips.length ? await q(`SELECT payslip_id, COALESCE(SUM(amount),0)::float AS paid, MAX(paid_on) AS last_paid
      FROM payroll_payments WHERE voided_at IS NULL AND payslip_id IN (:ids) GROUP BY payslip_id`, { replacements: { ids: slips.map((s) => s.payslip_id) } }) : [];
  const paidBy = new Map(paidRows.map((p) => [p.payslip_id, p]));

  const staffRows = await q(`SELECT staff_id, name, phone, designation, salesman_id, attendance_enabled, is_active,
                                    to_char(joined_on,'YYYY-MM-DD') AS joined_on, to_char(left_on,'YYYY-MM-DD') AS left_on
                               FROM staff_members ORDER BY name`);
  const { current } = await structures(to);
  const finalized = run?.status === 'finalized';

  let lines = [];
  if (finalized) {
    lines = slips.map((s) => ({ payslip_id: s.payslip_id, staff_id: s.staff_id, hold: s.hold, slip: s.snapshot }));
  } else {
    // Who is paid this month: had a salary by month end, and was employed at some point in it.
    const eligible = staffRows.filter((s) => current.has(s.staff_id)
      && (!s.joined_on || s.joined_on <= to) && (!s.left_on || s.left_on >= from)
      && (s.is_active || (s.left_on && s.left_on >= from)));
    const reg = eligible.length ? await attendance.buildRegister(from, to, { staffIds: eligible.map((s) => s.staff_id), includeInactive: true }) : { staff: [] };
    const regBy = new Map(reg.staff.map((s) => [s.staff_id, s]));
    const sales = await salesBySalesman(from, to);
    const advances = await advancesWithBalance({ excludeRunId: run?.run_id });
    for (const s of eligible) {
      const slipRow = slipByStaff.get(s.staff_id);
      const tracked = !!attSettings.enabled && s.attendance_enabled !== false;
      const slip = computePayslip({
        period, todayIso: today, staff: s, days: regBy.get(s.staff_id)?.days || {}, tracked, attCfg,
        structure: current.get(s.staff_id), settings,
        sales: s.salesman_id ? sales.get(s.salesman_id) || 0 : 0,
        advances: advances.filter((a) => a.staff_id === s.staff_id && a.given_on <= to),
        adjustments: slipRow?.adjustments || [], recoveries: slipRow?.recoveries || {},
      });
      const mine = advances.filter((v) => v.staff_id === s.staff_id && v.given_on <= to && v.outstanding > 0);
      lines.push({ payslip_id: slipRow?.payslip_id || null, staff_id: s.staff_id, hold: !!slipRow?.hold, slip,
        adjustments: slipRow?.adjustments || [], recoveries: slipRow?.recoveries || {}, advances: mine });
    }
  }

  lines = lines.map((l) => {
    const p = l.payslip_id ? paidBy.get(l.payslip_id) : null;
    const paid = r2(p?.paid || 0);
    return { ...l, paid, due: r2(Math.max(0, (l.slip?.net || 0) - paid)), last_paid: p?.last_paid || null };
  });
  const tot = (k) => r2(lines.reduce((t, l) => t + (Number(l.slip?.[k]) || 0), 0));
  const missing = staffRows.filter((s) => s.is_active && !current.has(s.staff_id)).map((s) => ({ staff_id: s.staff_id, name: s.name }));
  return {
    period, from, to, today,
    status: run?.status || 'draft', run_id: run?.run_id || null, finalized_at: run?.finalized_at || null, posted: !!run?.posted,
    month_complete: to < today,
    totals: {
      staff: lines.length, gross: tot('gross'), deductions: tot('total_deductions'), net: tot('net'), employer_cost: tot('employer_cost'),
      paid: r2(lines.reduce((t, l) => t + l.paid, 0)), due: r2(lines.reduce((t, l) => t + (l.hold ? 0 : l.due), 0)),
    },
    lines, missing, settings,
  };
}

/** Save the owner's extra lines / advance overrides / hold on a draft payslip. */
async function saveDraftLine(period, staffId, { adjustments, recoveries, hold }) {
  const run = await ensureRun(period);
  if (run.status === 'finalized') throw new Error('This month is finalized. Reopen it to make changes.');
  const adj = (Array.isArray(adjustments) ? adjustments : []).slice(0, 30).map((a, i) => ({
    id: a.id || `a${Date.now()}${i}`, type: a.type === 'deduction' ? 'deduction' : 'earning',
    label: String(a.label || '').slice(0, 60) || (a.type === 'deduction' ? 'Deduction' : 'Bonus'),
    amount: r2(Math.abs(Number(a.amount) || 0)), note: a.note ? String(a.note).slice(0, 200) : null,
  })).filter((a) => a.amount > 0);
  const rec = {};
  for (const [k, v] of Object.entries(recoveries || {})) if (v !== null && v !== '' && Number.isFinite(Number(v))) rec[k] = r2(Math.max(0, Number(v)));
  await x(`INSERT INTO payslips (run_id, staff_id, adjustments, recoveries, hold) VALUES (:r, :s, CAST(:a AS jsonb), CAST(:c AS jsonb), :h)
           ON CONFLICT (run_id, staff_id) DO UPDATE SET adjustments = EXCLUDED.adjustments, recoveries = EXCLUDED.recoveries, hold = EXCLUDED.hold`,
  { r: run.run_id, s: staffId, a: JSON.stringify(adj), c: JSON.stringify(rec), h: !!hold });
}

// ── books ───────────────────────────────────────────────────────────

const LEDGERS = {
  salary:     ['Salaries & Wages', 'Expenses', 'Indirect Expenses'],
  employer:   ['Employer Contribution (PF & ESI)', 'Expenses', 'Indirect Expenses'],
  payable:    ['Salary Payable', 'Liabilities', 'Current Liabilities'],
  pf:         ['PF Payable', 'Liabilities', 'Duties & Taxes'],
  esi:        ['ESI Payable', 'Liabilities', 'Duties & Taxes'],
  pt:         ['Professional Tax Payable', 'Liabilities', 'Duties & Taxes'],
  tds:        ['TDS Payable (Salary)', 'Liabilities', 'Duties & Taxes'],
  advance:    ['Staff Advances', 'Assets', 'Current Assets'],
};
async function ledgerId(key, t) {
  const { LedgerAccount } = require('../models');
  const [name, group, sub] = LEDGERS[key];
  const [row] = await LedgerAccount.findOrCreate({ where: { ledger_name: name }, defaults: { ledger_name: name, ledger_group: group, sub_group: sub }, transaction: t });
  return row.ledger_id;
}
async function cashOrBank(mode, bankLedgerId, t) {
  const { LedgerAccount } = require('../models');
  if (mode === 'Bank') {
    const b = await LedgerAccount.findByPk(Number(bankLedgerId), { transaction: t });
    if (!b) throw new Error('Choose the bank account the money went from.');
    return b.ledger_id;
  }
  const c = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' }, transaction: t });
  if (!c) throw new Error('Cash ledger is missing.');
  return c.ledger_id;
}

async function finalize(period, userId) {
  const data = await getRun(period);
  if (data.status === 'finalized') throw new Error('This month is already finalized.');
  if (!data.lines.length) throw new Error('Nobody to pay this month. Set salaries first.');
  const settings = data.settings;
  const sequelize = db();
  const t = await sequelize.transaction();
  try {
    const run = (await q('SELECT * FROM payroll_runs WHERE period = :p FOR UPDATE', { replacements: { p: period }, transaction: t }))[0]
      || (await ensureRun(period));
    for (const l of data.lines) {
      const s = l.slip;
      await x(`INSERT INTO payslips (run_id, staff_id, snapshot, gross, deductions, net, employer_cost, hold)
               VALUES (:r, :st, CAST(:snap AS jsonb), :g, :d, :n, :e, :h)
               ON CONFLICT (run_id, staff_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, gross = EXCLUDED.gross,
                 deductions = EXCLUDED.deductions, net = EXCLUDED.net, employer_cost = EXCLUDED.employer_cost`,
      { r: run.run_id, st: l.staff_id, snap: JSON.stringify(s), g: s.gross, d: s.total_deductions, n: s.net, e: s.employer_cost, h: !!l.hold }, t);
    }
    // Staff dropped from the month since a draft line was saved.
    await x(`DELETE FROM payslips WHERE run_id = :r AND snapshot IS NULL`, { r: run.run_id }, t);

    let posted = false;
    if (settings.post_to_accounts) {
      const sum = (fn) => r2(data.lines.reduce((acc, l) => acc + fn(l.slip), 0));
      const byCode = (arr, code) => arr.filter((d) => d.code === code).reduce((acc, d) => acc + d.amount, 0);
      const otherDed = sum((s) => byCode(s.deductions, 'adjustment'));
      const salaryExp = r2(sum((s) => s.gross) - otherDed + sum((s) => s.round_off));
      const lines = [];
      const add = async (key, debit, credit) => { const v = r2(debit || credit); if (v > 0.004) lines.push({ ledgerAccountId: await ledgerId(key, t), debit: debit ? v : 0, credit: credit ? v : 0 }); };
      await add('salary', salaryExp, 0);
      await add('employer', sum((s) => s.employer.reduce((acc, e) => acc + e.amount, 0)), 0);
      await add('payable', 0, sum((s) => s.net));
      await add('pf', 0, sum((s) => byCode(s.deductions, 'pf') + byCode(s.employer, 'pf')));
      await add('esi', 0, sum((s) => byCode(s.deductions, 'esi') + byCode(s.employer, 'esi')));
      await add('pt', 0, sum((s) => byCode(s.deductions, 'pt')));
      await add('tds', 0, sum((s) => byCode(s.deductions, 'tds')));
      await add('advance', 0, sum((s) => byCode(s.deductions, 'advance')));
      if (lines.length >= 2) {
        await postVoucher({ voucherType: 'Journal', sourceType: 'payroll_run', sourceId: run.run_id, voucherDate: data.to,
          referenceNumber: `Payroll ${period}`, lines, narration: `Salaries for ${period} (${data.lines.length} staff)`, userId, transaction: t });
        posted = true;
      }
    }
    await x(`UPDATE payroll_runs SET status = 'finalized', finalized_at = NOW(), finalized_by = :u, posted = :p WHERE run_id = :r`,
      { u: userId || null, p: posted, r: run.run_id }, t);
    await t.commit();
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
  return getRun(period);
}

async function reopen(period, userId) {
  const run = await findRun(period);
  if (!run || run.status !== 'finalized') throw new Error('This month is not finalized.');
  const paid = await q(`SELECT COUNT(*)::int AS n FROM payroll_payments pp JOIN payslips p ON p.payslip_id = pp.payslip_id
                         WHERE p.run_id = :r AND pp.voided_at IS NULL`, { replacements: { r: run.run_id } });
  if (paid[0].n) throw new Error('Salary has already been paid for this month. Cancel those payments first.');
  const later = await q(`SELECT period FROM payroll_runs WHERE status = 'finalized' AND period > :p ORDER BY period LIMIT 1`, { replacements: { p: period } });
  if (later.length) throw new Error(`${later[0].period} is finalized after this month. Reopen that first, so advance balances stay right.`);
  const t = await db().transaction();
  try {
    if (run.posted) await reverseVoucher({ sourceType: 'payroll_run', sourceId: run.run_id, reason: `Payroll ${period} reopened`, userId, transaction: t });
    await x(`UPDATE payroll_runs SET status = 'draft', finalized_at = NULL, finalized_by = NULL, posted = false WHERE run_id = :r`, { r: run.run_id }, t);
    await x(`UPDATE payslips SET snapshot = NULL WHERE run_id = :r`, { r: run.run_id }, t);
    await t.commit();
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
  return getRun(period);
}

/** Pay one or more finalized payslips. `items` = [{ payslip_id, amount? }] (amount defaults to what is due). */
async function pay(period, { items, paid_on, payment_mode = 'Cash', bank_ledger_id, reference }, userId) {
  const data = await getRun(period);
  if (data.status !== 'finalized') throw new Error('Finalize the month before paying salaries.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paid_on || ''))) throw new Error('Choose the payment date.');
  if (!['Cash', 'Bank'].includes(payment_mode)) throw new Error('Pay by cash or bank.');
  const byId = new Map(data.lines.map((l) => [l.payslip_id, l]));
  const t = await db().transaction();
  let count = 0; let total = 0;
  try {
    const credit = data.settings.post_to_accounts ? await cashOrBank(payment_mode, bank_ledger_id, t) : null;
    for (const it of items || []) {
      const line = byId.get(Number(it.payslip_id));
      if (!line) throw new Error('A payslip in this payment is not part of the month.');
      const amt = r2(it.amount != null && it.amount !== '' ? it.amount : line.due);
      if (amt <= 0) continue;
      if (amt > line.due + 0.005) throw new Error(`${line.slip.staff.name}: ${rs(amt)} is more than the ${rs(line.due)} due.`);
      const [row] = await db().query(`INSERT INTO payroll_payments (payslip_id, paid_on, amount, payment_mode, bank_ledger_id, reference, created_by)
          VALUES (:p, :d, :a, :m, :b, :ref, :u) RETURNING payment_id`,
      { replacements: { p: line.payslip_id, d: paid_on, a: amt, m: payment_mode, b: payment_mode === 'Bank' ? Number(bank_ledger_id) : null, ref: reference ? String(reference).slice(0, 60) : null, u: userId || null }, transaction: t, type: db().QueryTypes.SELECT });
      if (credit) {
        const debitLedger = data.posted ? await ledgerId('payable', t) : await ledgerId('salary', t);
        await postVoucher({ voucherType: 'Payment', sourceType: 'payroll_payment', sourceId: row.payment_id, voucherDate: paid_on,
          referenceNumber: reference || `Salary ${period}`, lines: [{ ledgerAccountId: debitLedger, debit: amt }, { ledgerAccountId: credit, credit: amt }],
          narration: `Salary ${period}: ${line.slip.staff.name}`, userId, transaction: t });
      }
      count++; total = r2(total + amt);
    }
    await t.commit();
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
  return { count, total };
}

async function payments(period) {
  return q(`SELECT pp.payment_id, pp.payslip_id, to_char(pp.paid_on,'YYYY-MM-DD') AS paid_on, pp.amount::float AS amount, pp.payment_mode,
                   pp.reference, pp.voided_at, pp.void_reason, p.staff_id, sm.name
              FROM payroll_payments pp JOIN payslips p ON p.payslip_id = pp.payslip_id JOIN payroll_runs r ON r.run_id = p.run_id
              JOIN staff_members sm ON sm.staff_id = p.staff_id
             WHERE r.period = :p ORDER BY pp.paid_on DESC, pp.payment_id DESC`, { replacements: { p: period } });
}

async function voidPayment(paymentId, reason, userId) {
  if (!reason || String(reason).trim().length < 3) throw new Error('Give a reason.');
  const t = await db().transaction();
  try {
    const [row] = await q('SELECT * FROM payroll_payments WHERE payment_id = :id FOR UPDATE', { replacements: { id: paymentId }, transaction: t });
    if (!row || row.voided_at) throw new Error('Payment not found.');
    await reverseVoucher({ sourceType: 'payroll_payment', sourceId: row.payment_id, reason, userId, transaction: t }).catch((e) => {
      if (!/no live|not found/i.test(e.message)) throw e;
    });
    await x('UPDATE payroll_payments SET voided_at = NOW(), void_reason = :r WHERE payment_id = :id', { r: String(reason).slice(0, 200), id: paymentId }, t);
    await t.commit();
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
}

// ── advances ────────────────────────────────────────────────────────

async function giveAdvance({ staff_id, given_on, amount, installment, payment_mode = 'Cash', bank_ledger_id, reason }, userId) {
  const amt = r2(amount);
  if (!(amt > 0)) throw new Error('Enter the advance amount.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(given_on || ''))) throw new Error('Choose the date.');
  const settings = await getSettings();
  const t = await db().transaction();
  try {
    const [row] = await db().query(`INSERT INTO staff_advances (staff_id, given_on, amount, installment, payment_mode, bank_ledger_id, reason, created_by)
        VALUES (:s, :d, :a, :i, :m, :b, :r, :u) RETURNING advance_id`,
    { replacements: { s: Number(staff_id), d: given_on, a: amt, i: r2(Math.max(0, Number(installment) || 0)), m: payment_mode, b: payment_mode === 'Bank' ? Number(bank_ledger_id) : null, r: reason ? String(reason).slice(0, 200) : null, u: userId || null }, transaction: t, type: db().QueryTypes.SELECT });
    if (settings.post_to_accounts) {
      const credit = await cashOrBank(payment_mode, bank_ledger_id, t);
      await postVoucher({ voucherType: 'Payment', sourceType: 'staff_advance', sourceId: row.advance_id, voucherDate: given_on,
        referenceNumber: `Advance #${row.advance_id}`, lines: [{ ledgerAccountId: await ledgerId('advance', t), debit: amt }, { ledgerAccountId: credit, credit: amt }],
        narration: `Salary advance${reason ? `: ${reason}` : ''}`, userId, transaction: t });
    }
    await t.commit();
    return row.advance_id;
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
}

async function voidAdvance(advanceId, reason, userId) {
  if (!reason || String(reason).trim().length < 3) throw new Error('Give a reason.');
  const [a] = await advancesWithBalance().then((all) => all.filter((v) => v.advance_id === Number(advanceId)));
  if (!a) throw new Error('Advance not found.');
  if (a.recovered > 0) throw new Error('Part of this advance was already recovered from salary. It cannot be cancelled.');
  const t = await db().transaction();
  try {
    await reverseVoucher({ sourceType: 'staff_advance', sourceId: a.advance_id, reason, userId, transaction: t }).catch((e) => {
      if (!/no live|not found/i.test(e.message)) throw e;
    });
    await x('UPDATE staff_advances SET voided_at = NOW(), void_reason = :r WHERE advance_id = :id', { r: String(reason).slice(0, 200), id: a.advance_id }, t);
    await t.commit();
  } catch (err) { await t.rollback().catch(() => {}); throw err; }
}

async function updateAdvanceInstallment(advanceId, installment) {
  await x('UPDATE staff_advances SET installment = :i WHERE advance_id = :id AND voided_at IS NULL', { i: r2(Math.max(0, Number(installment) || 0)), id: Number(advanceId) });
}

/** Finalized payslips for the staff phone (only when the owner allows it). */
async function staffPayViews(limit = 6) {
  const settings = await getSettings();
  if (!settings.staff_see_payslips) return {};
  const rows = await q(`SELECT p.staff_id, r.period, p.snapshot, p.net::float AS net,
                               COALESCE((SELECT SUM(amount) FROM payroll_payments pp WHERE pp.payslip_id = p.payslip_id AND pp.voided_at IS NULL),0)::float AS paid
                          FROM payslips p JOIN payroll_runs r ON r.run_id = p.run_id
                         WHERE r.status = 'finalized' AND p.snapshot IS NOT NULL ORDER BY r.period DESC`).catch(() => []);
  const out = {};
  for (const row of rows) {
    const list = out[row.staff_id] || (out[row.staff_id] = []);
    if (list.length >= limit) continue;
    const s = row.snapshot;
    list.push({
      period: row.period, net: row.net, paid: row.paid, gross: s.gross, deductions: s.total_deductions,
      paid_days: s.attendance?.paid_days ?? null, basis_days: s.basis_days,
      earnings: s.earnings.map((e) => [e.label, e.amount]), deductions_list: s.deductions.map((d) => [d.label, d.amount]),
    });
  }
  return out;
}

module.exports = {
  PT_PRESETS, DEFAULT_SETTINGS, STANDARD_COMPONENTS,
  mergeSettings, splitComponents, ptFor, computePayslip,
  getSettings, saveSettings, structures, saveStructure, deleteStructure,
  getRun, saveDraftLine, finalize, reopen, pay, payments, voidPayment,
  advancesWithBalance, giveAdvance, voidAdvance, updateAdvanceInstallment, staffPayViews,
  validPeriod,
};
