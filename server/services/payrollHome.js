/**
 * Payroll home — the owner's one screen: who is owed what, pay them, give
 * money. It composes the two tested engines and never computes pay itself:
 *   - monthly staff (salary on the 1st): services/payroll.js pay runs
 *   - own-cycle staff (salary on any other day): services/staffAccounts.js
 * The owner never has to know which engine a person uses. "Salary date"
 * decides it: the 1st → monthly run (PF/ESI/payslips), any other day →
 * own cycle.
 *
 * Invariants:
 *   - Amounts shown as "due" are exactly what the engines would pay.
 *   - "Pay" and "Give money" route to the engine's own write paths, so the
 *     books, locks and guards are the same as before.
 *   - Pay everyone = lock last month (if not locked) + pay every due line +
 *     settle every finished own-cycle; each person succeeds or fails on
 *     their own and the result lists both.
 */
const payroll = require('./payroll');
const accounts = require('./staffAccounts');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY = 86_400_000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const short = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
const monthName = (p) => `${MONTH[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;

function db() { return require('../config/database'); }
async function q(sql, replacements = {}) { return db().query(sql, { type: db().QueryTypes.SELECT, replacements }); }

const prevPeriod = (today) => { const [y, m] = today.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); };

/** The salary in force today, or the first one if it only starts later. */
function structureNow(history, today) {
  if (!history || !history.length) return null;
  return [...history].reverse().find((h) => h.effective_from <= today) || history[0];
}

async function overview() {
  const today = payroll.localToday();
  const prev = prevPeriod(today);
  const staff = await q(`SELECT staff_id, name, designation, photo_thumb, attendance_enabled,
                                to_char(joined_on,'YYYY-MM-DD') AS joined_on, to_char(left_on,'YYYY-MM-DD') AS left_on
                           FROM staff_members WHERE is_active ORDER BY name`);
  const { history } = await payroll.structures(null);
  const run = await payroll.getRun(prev);
  const advances = await payroll.advancesWithBalance();

  const people = []; const missing = [];
  for (const s of staff) {
    const st = structureNow(history.get(s.staff_id), today);
    if (!st) { missing.push({ staff_id: s.staff_id, name: s.name, designation: s.designation, photo: s.photo_thumb, joined_on: s.joined_on }); continue; }
    const settle = payroll.isSettle(st);
    const cycleDay = settle ? Math.min(28, Math.max(1, Number(st.details?.cycle_day) || 1)) : 1;
    const cyc = accounts.cycleAround(today, cycleDay);
    const p = {
      staff_id: s.staff_id, name: s.name, designation: s.designation, photo: s.photo_thumb, joined_on: s.joined_on,
      mode: settle ? 'settle' : 'run', pay_type: st.pay_type, amount: Number(st.amount), cycle_day: cycleDay,
      statutory: !!(st.details?.statutory && (st.details.statutory.pf || st.details.statutory.esi || st.details.statutory.pt)),
      cycle: cyc, next_payday: addDays(cyc.to, 1),
      so_far: null, taken: 0, due: null,
    };

    // Earned so far in the running cycle (before deductions).
    const from = s.joined_on && s.joined_on > cyc.from ? s.joined_on : cyc.from;
    if (from <= today) {
      try {
        const e = await accounts.earnedFor(s.staff_id, from, today);
        p.so_far = { from, to: today, earned: e.earned, paid_days: e.attendance.paid_days, days: e.attendance.days, absent: e.attendance.absent + e.attendance.unpaid_leave };
      } catch { /* salary starts later, or the range is empty */ }
    }

    if (!settle) {
      const outstanding = advances.filter((a) => a.staff_id === s.staff_id).reduce((t, a) => t + a.outstanding, 0);
      const line = run.lines.find((l) => l.staff_id === s.staff_id);
      // "Taken" = still to come off a FUTURE salary: what the open month's payslip already recovers is inside its due.
      const inDue = line && run.status !== 'finalized' ? line.slip.deductions.filter((d) => d.code === 'advance').reduce((t, d) => t + d.amount, 0) : 0;
      p.taken = r2(Math.max(0, outstanding - inDue));
      if (line) {
        const locked = run.status === 'finalized';
        const amount = locked ? (line.hold ? 0 : line.due) : line.slip.net;
        p.due = {
          kind: 'run', period: prev, label: monthName(prev), locked, hold: !!line.hold,
          payslip_id: line.payslip_id, net: line.slip.net, paid: line.paid, amount: r2(Math.max(0, amount)),
          gross: line.slip.gross, deductions: line.slip.total_deductions,
          paid_days: line.slip.attendance.paid_days, basis_days: line.slip.basis_days,
          warnings: line.slip.warnings || [],
        };
      }
    } else {
      const acc = await accounts.account(s.staff_id);
      const sug = await accounts.suggestRange(s.staff_id);
      const unsettled = acc.given.filter((g) => !g.voided_at && !g.settlement_id);
      const prevEnd = addDays(cyc.from, -1);
      if (sug.from <= sug.to && sug.to <= prevEnd) {
        try {
          const pv = await accounts.preview(s.staff_id, { from: sug.from, to: sug.to });
          p.due = {
            kind: 'settle', from: sug.from, to: sug.to, label: `${short(sug.from)} – ${short(sug.to)}`,
            earned: pv.earned, given: pv.given_total, brought_forward: pv.brought_forward, owed: r2(pv.owed),
            amount: r2(Math.max(0, Math.round(pv.owed))), paid_days: pv.attendance.paid_days, warnings: pv.warnings || [],
          };
          // Money given up to the due's end is already inside the due; only later money is "taken" ahead of the next salary.
          p.taken = r2(unsettled.filter((g) => g.given_on > sug.to).reduce((t, g) => t + g.amount, 0));
        } catch (e) { p.due = { kind: 'error', label: 'Needs a look', amount: 0, error: e.message }; }
      }
      if (!p.due || p.due.kind !== 'settle') p.taken = r2(unsettled.reduce((t, g) => t + g.amount, 0));
      if (!p.due && acc.balance > 0.5) {
        p.due = { kind: 'balance', label: 'Left from last settlement', amount: r2(acc.balance) };
      } else if (!p.due && acc.balance < -0.5) {
        // Paid more than earned at a settlement; money given since is shown separately as "taken".
        const adv = r2(-acc.balance - p.taken);
        if (adv > 0.5) p.advance = adv;
      }
    }
    people.push(p);
  }

  const due = people.filter((x) => x.due && x.due.amount > 0 && !x.due.hold);
  const runLines = people.filter((x) => x.due?.kind === 'run');
  return {
    today,
    month: {
      period: prev, label: monthName(prev), status: run.status, month_complete: run.month_complete,
      ready: run.status !== 'finalized' && runLines.length > 0,
      people: runLines.length, net: r2(runLines.reduce((t, x) => t + x.due.net, 0)),
      statutory: people.some((x) => x.statutory),
    },
    totals: {
      due: r2(due.reduce((t, x) => t + x.due.amount, 0)), due_count: due.length,
      taken: r2(people.reduce((t, x) => t + x.taken, 0)),
      so_far: r2(people.reduce((t, x) => t + (x.so_far?.earned || 0), 0)),
      monthly: r2(people.filter((x) => x.pay_type === 'monthly').reduce((t, x) => t + x.amount, 0)),
    },
    people, missing,
  };
}

async function modeOf(staffId) {
  const today = payroll.localToday();
  const { history } = await payroll.structures(null);
  const st = structureNow(history.get(staffId), today);
  if (!st) throw new Error('Set this person\'s salary first.');
  return payroll.isSettle(st) ? 'settle' : 'run';
}

/** Money handed over on any day. Monthly staff: an advance recovered from the next salary. Own-cycle: goes on their account. */
async function give(staffId, { amount, given_on, payment_mode = 'Cash', bank_ledger_id, note }, userId) {
  const mode = await modeOf(staffId);
  if (mode === 'settle') return accounts.giveMoney(staffId, { amount, given_on, payment_mode, bank_ledger_id, note }, userId);
  return payroll.giveAdvance({ staff_id: staffId, given_on, amount, installment: 0, payment_mode, bank_ledger_id, reason: note || null }, userId);
}

/**
 * Pay one person what is due. Monthly staff: last month's payslip (locking
 * the month first when asked to). Own-cycle: settle the finished cycle and
 * pay, or pay what was left over from an earlier settlement.
 */
async function payPerson(staffId, { amount, paid_on, payment_mode = 'Cash', bank_ledger_id, lock_month }, userId, { postingDate, journalDate } = {}) {
  const ov = await overview();
  const p = ov.people.find((x) => x.staff_id === Number(staffId));
  if (!p || !p.due || !(p.due.amount > 0 || Number(amount) > 0)) throw new Error('Nothing is due for this person right now.');
  const amt = amount != null && amount !== '' ? r2(amount) : p.due.amount;
  if (!(amt > 0)) throw new Error('Enter the amount to pay.');
  if (p.due.kind === 'run') {
    if (!p.due.locked) {
      if (!lock_month) throw new Error(`${p.due.label} is not locked yet. Paying locks it for everyone.`);
      await payroll.finalize(p.due.period, userId, { postingDate });
    }
    const run = await payroll.getRun(p.due.period);
    const line = run.lines.find((l) => l.staff_id === p.staff_id);
    return payroll.pay(p.due.period, { items: [{ payslip_id: line.payslip_id, amount: amt }], paid_on, payment_mode, bank_ledger_id }, userId);
  }
  if (p.due.kind === 'settle') {
    return accounts.settle(p.staff_id, { from: p.due.from, to: p.due.to, pay: { amount: amt, paid_on, payment_mode, bank_ledger_id } }, userId, { journalDate });
  }
  if (p.due.kind === 'balance') {
    if (amt > p.due.amount + 0.005) throw new Error(`Only ${p.due.amount} is left to pay.`);
    return accounts.giveMoney(p.staff_id, { amount: amt, given_on: paid_on, payment_mode, bank_ledger_id, note: 'Salary balance', kind: 'salary' }, userId);
  }
  throw new Error(p.due.error || 'This person needs a look before paying.');
}

/** Pay everyone who is due. Locks last month first if needed. Returns who was paid and who was not. */
async function payAll({ paid_on, payment_mode = 'Cash', bank_ledger_id }, userId, { postingDate, journalDates = {} } = {}) {
  const ov = await overview();
  const paid = []; const failed = [];
  const runPeople = ov.people.filter((x) => x.due?.kind === 'run' && !x.due.hold && x.due.amount > 0);
  if (runPeople.length) {
    try {
      if (ov.month.status !== 'finalized') await payroll.finalize(ov.month.period, userId, { postingDate });
      const run = await payroll.getRun(ov.month.period);
      const items = run.lines.filter((l) => !l.hold && l.due > 0).map((l) => ({ payslip_id: l.payslip_id }));
      if (items.length) {
        const r = await payroll.pay(ov.month.period, { items, paid_on, payment_mode, bank_ledger_id }, userId);
        for (const l of run.lines.filter((x) => !x.hold && x.due > 0)) paid.push({ staff_id: l.staff_id, name: l.slip.staff.name, amount: l.due });
        void r;
      }
    } catch (e) { for (const x of runPeople) failed.push({ staff_id: x.staff_id, name: x.name, error: e.message }); }
  }
  for (const x of ov.people.filter((y) => (y.due?.kind === 'settle' || y.due?.kind === 'balance') && y.due.amount > 0)) {
    try {
      if (x.due.kind === 'settle') {
        await accounts.settle(x.staff_id, { from: x.due.from, to: x.due.to, pay: { amount: x.due.amount, paid_on, payment_mode, bank_ledger_id } }, userId, { journalDate: journalDates[x.staff_id] });
      } else {
        await accounts.giveMoney(x.staff_id, { amount: x.due.amount, given_on: paid_on, payment_mode, bank_ledger_id, note: 'Salary balance', kind: 'salary' }, userId);
      }
      paid.push({ staff_id: x.staff_id, name: x.name, amount: x.due.amount });
    } catch (e) { failed.push({ staff_id: x.staff_id, name: x.name, error: e.message }); }
  }
  return { paid, failed, total: r2(paid.reduce((t, x) => t + x.amount, 0)) };
}

module.exports = { overview, give, payPerson, payAll, modeOf };
