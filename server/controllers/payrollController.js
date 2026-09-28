const payroll = require('../services/payroll');
const accounts = require('../services/staffAccounts');
const { checkBackdated } = require('../utils/backdatedGuard');
const { applyFiscalLockGuard } = require('../utils/compliance');

/*
 * Payroll API. Thin: every rule lives in services/payroll.js and
 * services/staffAccounts.js. Errors thrown there are written for the owner,
 * so they are passed through as 400s.
 *
 * Every write that reaches the books passes the same two gates as every
 * other voucher in ZEHEN before anything is saved:
 *   - the back-dated entries policy (Settings → Defaults, role permission)
 *   - the financial-year lock (compliance soft / hard lock dates)
 * Reversals (cancel, reopen) are probed on the ORIGINAL entry's date, like
 * cancelling a bill. Accruals (month-end salary, a settlement) are dated on
 * their own period end; where back-dating is not allowed they are dated today.
 */
const uid = (req) => req.user && req.user.user_id;
const handle = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent && out !== undefined) res.json(out);
  } catch (e) {
    if (res.headersSent) return;
    const known = e && e.message && !/syntax|column|relation|undefined|null value|violates/i.test(e.message);
    if (!known) console.error('payroll error:', e);
    res.status(known ? 400 : 500).json({ error: known ? e.message : 'Something went wrong in payroll. Please try again.' });
  }
};
// Payslips ride to staff phones with the attendance sync; push soon, don't wait.
function kick() {
  const { companyContext } = require('../models');
  const companyId = companyContext.getStore()?.companyId;
  if (!companyId) return;
  setTimeout(() => {
    require('../services/staffAttendance').syncNow(companyId).catch((e) => console.error('[payroll] background sync:', e.message));
  }, 300).unref?.();
}

// ── books gates ─────────────────────────────────────────────────────
const db = () => require('../config/database');
const one = async (sql, replacements) => (await db().query(sql, { type: db().QueryTypes.SELECT, replacements }))[0] || null;
const booksOn = async () => (await payroll.getSettings()).post_to_accounts;
const isoOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

/** New entries dated `dates`: back-date policy, then the fiscal lock on the earliest. Sends the 403 itself. */
async function gateNew(req, res, dates) {
  const ds = dates.filter(isoOk);
  for (const d of ds) {
    const r = await checkBackdated({ voucherDate: d, user: req.user });
    if (!r.ok) { res.status(403).json({ error: r.reason, code: r.code }); return false; }
  }
  const g = await applyFiscalLockGuard(req, res, ds.sort()[0] || null);
  return g.ok;
}
/** Only the fiscal lock (reversals, and accrual dates already cleared for back-dating). */
async function gateLock(req, res, date) {
  const g = await applyFiscalLockGuard(req, res, isoOk(date) ? date : null);
  return g.ok;
}
/** Date for an accrual entry: its own date when back-dating is allowed, else today. */
async function accrualDate(req, iso) {
  const r = await checkBackdated({ voucherDate: iso, user: req.user });
  return r.ok ? iso : payroll.localToday();
}
const periodEnd = (p) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

// ── settings & salaries ─────────────────────────────────────────────
exports.getSettings = handle(async () => ({ settings: await payroll.getSettings(), pt_presets: payroll.PT_PRESETS, standard_components: payroll.STANDARD_COMPONENTS }));
exports.saveSettings = handle(async (req) => { const s = await payroll.saveSettings(req.body || {}); kick(); return { settings: s }; });

exports.listStructures = handle(async () => {
  const { history } = await payroll.structures(null);
  const out = {};
  for (const [k, v] of history) out[k] = v;
  return out;
});
exports.saveStructure = handle(async (req) => { await payroll.saveStructure(Number(req.params.staffId), req.body || {}, uid(req)); return { ok: true }; });
exports.deleteStructure = handle(async (req) => { await payroll.deleteStructure(Number(req.params.structureId)); return { ok: true }; });

// ── pay runs ────────────────────────────────────────────────────────
exports.getRun = handle(async (req) => payroll.getRun(req.params.period));
exports.saveLine = handle(async (req) => { await payroll.saveDraftLine(req.params.period, Number(req.params.staffId), req.body || {}); return payroll.getRun(req.params.period); });

exports.finalize = handle(async (req, res) => {
  const period = req.params.period;
  if (!payroll.validPeriod(period)) throw new Error('Choose a month.');
  let postingDate = null;
  if (await booksOn()) {
    postingDate = await accrualDate(req, periodEnd(period));
    if (!(await gateLock(req, res, postingDate))) return undefined;
  }
  const r = await payroll.finalize(period, uid(req), { postingDate });
  kick();
  return r;
});
exports.reopen = handle(async (req, res) => {
  const run = await one(`SELECT posted, to_char(posted_on,'YYYY-MM-DD') AS posted_on, period FROM payroll_runs WHERE period = :p`, { p: req.params.period });
  if (run?.posted && !(await gateLock(req, res, run.posted_on || periodEnd(run.period)))) return undefined;
  const r = await payroll.reopen(req.params.period, uid(req));
  kick();
  return r;
});
exports.pay = handle(async (req, res) => {
  const run = await one('SELECT posted FROM payroll_runs WHERE period = :p', { p: req.params.period });
  if ((run?.posted || await booksOn()) && !(await gateNew(req, res, [req.body?.paid_on]))) return undefined;
  const r = await payroll.pay(req.params.period, req.body || {}, uid(req));
  kick();
  return r;
});
exports.payments = handle(async (req) => payroll.payments(req.params.period));
exports.voidPayment = handle(async (req, res) => {
  const p = await one(`SELECT to_char(paid_on,'YYYY-MM-DD') AS d FROM payroll_payments WHERE payment_id = :id`, { id: Number(req.params.id) });
  if (p && !(await gateLock(req, res, p.d))) return undefined;
  await payroll.voidPayment(Number(req.params.id), req.body?.reason, uid(req));
  kick();
  return { ok: true };
});

// ── advances (pay-run staff) ────────────────────────────────────────
exports.listAdvances = handle(async () => payroll.advancesWithBalance());
exports.giveAdvance = handle(async (req, res) => {
  if ((await booksOn()) && !(await gateNew(req, res, [req.body?.given_on]))) return undefined;
  return { advance_id: await payroll.giveAdvance(req.body || {}, uid(req)) };
});
exports.updateAdvance = handle(async (req) => { await payroll.updateAdvanceInstallment(Number(req.params.id), req.body?.installment); return { ok: true }; });
exports.voidAdvance = handle(async (req, res) => {
  const a = await one(`SELECT to_char(given_on,'YYYY-MM-DD') AS d FROM staff_advances WHERE advance_id = :id`, { id: Number(req.params.id) });
  if (a && !(await gateLock(req, res, a.d))) return undefined;
  await payroll.voidAdvance(Number(req.params.id), req.body?.reason, uid(req));
  return { ok: true };
});

// ── staff accounts (settle-up) ──────────────────────────────────────
exports.listAccounts = handle(async () => accounts.list());
exports.getAccount = handle(async (req) => {
  const id = Number(req.params.staffId);
  return { ...(await accounts.account(id)), suggested: await accounts.suggestRange(id) };
});
exports.giveMoney = handle(async (req, res) => {
  if ((await booksOn()) && !(await gateNew(req, res, [req.body?.given_on]))) return undefined;
  return { entry_id: await accounts.giveMoney(Number(req.params.staffId), req.body || {}, uid(req)) };
});
exports.voidMoney = handle(async (req, res) => {
  const g = await one(`SELECT to_char(given_on,'YYYY-MM-DD') AS d FROM staff_money_given WHERE entry_id = :id`, { id: Number(req.params.id) });
  if (g && !(await gateLock(req, res, g.d))) return undefined;
  await accounts.voidMoney(Number(req.params.id), req.body?.reason, uid(req));
  return { ok: true };
});
exports.previewSettle = handle(async (req) => accounts.preview(Number(req.params.staffId), req.body || {}));
exports.settle = handle(async (req, res) => {
  const body = req.body || {};
  let journalDate = null;
  if (await booksOn()) {
    if (!isoOk(body.to)) throw new Error('Choose the dates to settle.');
    journalDate = await accrualDate(req, body.to);
    if (!(await gateLock(req, res, journalDate))) return undefined;
    if (body.pay && Number(body.pay.amount) > 0 && !(await gateNew(req, res, [body.pay.paid_on || payroll.localToday()]))) return undefined;
  }
  const r = await accounts.settle(Number(req.params.staffId), body, uid(req), { journalDate });
  kick();
  return r;
});
exports.cancelSettlement = handle(async (req, res) => {
  const s = await one(`SELECT to_char(to_date,'YYYY-MM-DD') AS d, snapshot->>'journal_date' AS j FROM staff_settlements WHERE settlement_id = :id`, { id: Number(req.params.id) });
  if (s && !(await gateLock(req, res, s.j || s.d))) return undefined;
  await accounts.cancelSettlement(Number(req.params.id), req.body?.reason, uid(req));
  kick();
  return { ok: true };
});

// ── payroll home: one screen for the owner ──────────────────────────
const home = require('../services/payrollHome');
exports.home = handle(async () => home.overview());
exports.givePerson = handle(async (req, res) => {
  if ((await booksOn()) && !(await gateNew(req, res, [req.body?.given_on]))) return undefined;
  const r = await home.give(Number(req.params.staffId), req.body || {}, uid(req));
  kick();
  return { ok: true, id: r };
});
exports.payPerson = handle(async (req, res) => {
  const body = req.body || {};
  const ov = await home.overview();
  const p = ov.people.find((x) => x.staff_id === Number(req.params.staffId));
  if (!p || !p.due) throw new Error('Nothing is due for this person right now.');
  let postingDate = null; let journalDate = null;
  if (await booksOn()) {
    if (!(await gateNew(req, res, [body.paid_on]))) return undefined;
    if (p.due.kind === 'run' && !p.due.locked && body.lock_month) {
      postingDate = await accrualDate(req, periodEnd(p.due.period));
      if (!(await gateLock(req, res, postingDate))) return undefined;
    }
    if (p.due.kind === 'settle') {
      journalDate = await accrualDate(req, p.due.to);
      if (!(await gateLock(req, res, journalDate))) return undefined;
    }
  }
  await home.payPerson(p.staff_id, body, uid(req), { postingDate, journalDate });
  kick();
  return home.overview();
});
exports.payAll = handle(async (req, res) => {
  const body = req.body || {};
  const ov = await home.overview();
  let postingDate = null; const journalDates = {};
  if (await booksOn()) {
    if (!(await gateNew(req, res, [body.paid_on]))) return undefined;
    if (ov.month.status !== 'finalized' && ov.people.some((x) => x.due?.kind === 'run' && x.due.amount > 0)) {
      postingDate = await accrualDate(req, periodEnd(ov.month.period));
      if (!(await gateLock(req, res, postingDate))) return undefined;
    }
    for (const x of ov.people.filter((y) => y.due?.kind === 'settle' && y.due.amount > 0)) {
      journalDates[x.staff_id] = await accrualDate(req, x.due.to);
      if (!(await gateLock(req, res, journalDates[x.staff_id]))) return undefined;
    }
  }
  const r = await home.payAll(body, uid(req), { postingDate, journalDates });
  kick();
  return { ...r, home: await home.overview() };
});
