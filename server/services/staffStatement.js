/**
 * Staff statement — one ledger per person, whichever way they are paid.
 *
 * Reads what the two engines already recorded and never computes pay:
 *   credit (earned)   locked monthly payslips (payroll.js runs) and
 *                     own-cycle settlements (staffAccounts.js)
 *   debit  (paid)     salary payments against payslips, advances, and
 *                     money given / salary paid on an own cycle
 *
 * Balance = earned − paid. Positive: the shop owes the person. Negative:
 * the person has taken more than they earned (an advance still to come
 * off salary).
 *
 * A monthly payslip is credited at what the person earned AFTER statutory
 * deductions (PF, ESI, PT, TDS…) but BEFORE advance recovery: the advance
 * was already debited the day it was given, so taking it off again would
 * count it twice. Cancelled entries are left out.
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (p) => `${MONTH[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const periodEnd = (p) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function db() { return require('../config/database'); }
async function q(sql, replacements = {}) { return db().query(sql, { type: db().QueryTypes.SELECT, replacements }); }

/** Every money entry for one person, oldest first, with what can be cancelled. */
async function entries(staffId) {
  const out = [];

  // Locked monthly payslips → earned.
  const slips = await q(`SELECT p.payslip_id, r.period, p.gross::float AS gross, p.net::float AS net, p.snapshot, p.hold
                           FROM payslips p JOIN payroll_runs r ON r.run_id = p.run_id
                          WHERE p.staff_id = :s AND r.status = 'finalized'`, { s: staffId });
  for (const p of slips) {
    const ded = Array.isArray(p.snapshot?.deductions) ? p.snapshot.deductions : [];
    const advance = r2(ded.filter((d) => d.code === 'advance').reduce((t, d) => t + (Number(d.amount) || 0), 0));
    const statutory = r2(ded.filter((d) => d.code !== 'advance').reduce((t, d) => t + (Number(d.amount) || 0), 0));
    const net = Number(p.snapshot?.net ?? p.net) || 0;
    const earned = r2(net + advance);
    if (!earned && !p.gross) continue;
    const detail = [statutory > 0 ? `Gross ₹${fmt(p.gross)} − deductions ₹${fmt(statutory)}` : null,
      advance > 0 ? `₹${fmt(advance)} advance taken back` : null, p.hold ? 'On hold' : null].filter(Boolean).join(' · ');
    out.push({ date: periodEnd(p.period), kind: 'salary', text: `Salary for ${monthName(p.period)}`, detail, earned, paid: 0, ref: `slip-${p.payslip_id}` });
  }

  // Salary payments against payslips → paid.
  const pays = await q(`SELECT pp.payment_id, to_char(pp.paid_on,'YYYY-MM-DD') AS paid_on, pp.amount::float AS amount, pp.payment_mode, pp.reference, r.period
                          FROM payroll_payments pp JOIN payslips p ON p.payslip_id = pp.payslip_id JOIN payroll_runs r ON r.run_id = p.run_id
                         WHERE p.staff_id = :s AND pp.voided_at IS NULL`, { s: staffId });
  for (const p of pays) {
    out.push({ date: p.paid_on, kind: 'paid', text: `Salary paid · ${monthName(p.period)}`, detail: [p.payment_mode, p.reference].filter(Boolean).join(' · '),
      earned: 0, paid: r2(p.amount), ref: `pay-${p.payment_id}` });
  }

  // Advances (monthly staff) → paid the day they were given.
  const adv = await q(`SELECT advance_id, to_char(given_on,'YYYY-MM-DD') AS given_on, amount::float AS amount, payment_mode, reason
                         FROM staff_advances WHERE staff_id = :s AND voided_at IS NULL`, { s: staffId });
  const recovered = await q(`SELECT (d->>'advance_id')::int AS advance_id, SUM((d->>'amount')::numeric)::float AS amt
                               FROM payslips p JOIN payroll_runs r ON r.run_id = p.run_id,
                                    jsonb_array_elements(COALESCE(p.snapshot->'deductions','[]'::jsonb)) d
                              WHERE r.status = 'finalized' AND p.staff_id = :s AND d->>'code' = 'advance' GROUP BY 1`, { s: staffId });
  const rec = new Map(recovered.map((r) => [r.advance_id, r.amt]));
  for (const a of adv) {
    out.push({ date: a.given_on, kind: 'advance', text: 'Advance', detail: [a.reason, a.payment_mode].filter(Boolean).join(' · '),
      earned: 0, paid: r2(a.amount), ref: `adv-${a.advance_id}`, cancel: !(rec.get(a.advance_id) > 0) ? { type: 'advance', id: a.advance_id } : null });
  }

  // Own-cycle settlements → earned.
  const sets = await q(`SELECT settlement_id, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date, earned::float AS earned, snapshot
                          FROM staff_settlements WHERE staff_id = :s AND voided_at IS NULL`, { s: staffId });
  for (const s of sets) {
    const days = s.snapshot?.attendance?.paid_days;
    out.push({ date: s.to_date, kind: 'salary', text: `Salary ${shortDate(s.from_date)} – ${shortDate(s.to_date)}`,
      detail: days != null ? `${days} paid days` : '', earned: r2(s.earned), paid: 0, ref: `set-${s.settlement_id}` });
  }

  // Own-cycle money given / salary paid → paid.
  const given = await q(`SELECT entry_id, to_char(given_on,'YYYY-MM-DD') AS given_on, amount::float AS amount, kind, payment_mode, note, settlement_id
                           FROM staff_money_given WHERE staff_id = :s AND voided_at IS NULL`, { s: staffId });
  for (const g of given) {
    out.push({ date: g.given_on, kind: g.kind === 'salary' ? 'paid' : 'advance', text: g.kind === 'salary' ? 'Salary paid' : 'Money given',
      // A salary payment's note is usually 'Salary 15 Aug – 14 Sep'; don't say Salary twice.
      detail: [g.kind === 'salary' && g.note ? g.note.replace(/^Salary\s+/i, '') : g.note, g.payment_mode].filter(Boolean).join(' · '), earned: 0, paid: r2(g.amount), ref: `giv-${g.entry_id}`,
      cancel: g.settlement_id ? null : { type: 'given', id: g.entry_id } });
  }

  // Same day: earnings first, then payments, so the running balance reads naturally.
  const order = { salary: 0, paid: 1, advance: 2 };
  out.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.ref.localeCompare(b.ref));
  return out;
}

const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
function shortDate(iso) { return `${Number(iso.slice(8, 10))} ${MONTH[Number(iso.slice(5, 7)) - 1].slice(0, 3)}`; }

/**
 * The statement for [from, to] (inclusive; either may be omitted).
 * Opening = balance of everything before `from`; rows carry a running balance.
 */
async function statement(staffId, { from, to } = {}) {
  const [s] = await q(`SELECT staff_id, name, designation, phone, to_char(joined_on,'YYYY-MM-DD') AS joined_on
                         FROM staff_members WHERE staff_id = :id`, { id: staffId });
  if (!s) throw new Error('Staff member not found.');
  if (from && !ISO.test(from)) throw new Error('Invalid from date.');
  if (to && !ISO.test(to)) throw new Error('Invalid to date.');

  const all = await entries(staffId);
  let opening = 0;
  const rows = [];
  for (const e of all) {
    if (from && e.date < from) { opening = r2(opening + e.earned - e.paid); continue; }
    if (to && e.date > to) continue;
    rows.push(e);
  }
  let bal = opening;
  for (const e of rows) { bal = r2(bal + e.earned - e.paid); e.balance = bal; }
  const earned = r2(rows.reduce((t, e) => t + e.earned, 0));
  const paid = r2(rows.reduce((t, e) => t + e.paid, 0));
  const allBal = r2(all.reduce((t, e) => t + e.earned - e.paid, 0));
  return {
    staff: s, from: from || null, to: to || null,
    opening, earned, paid, closing: r2(opening + earned - paid),
    balance_now: allBal,
    first_date: all[0]?.date || null,
    rows,
  };
}

module.exports = { statement, entries };
