const payroll = require('../services/payroll');

/*
 * Payroll API. Thin: every rule lives in services/payroll.js. Errors thrown
 * there are written for the owner, so they are passed through as 400s.
 */
const uid = (req) => req.user && req.user.user_id;
const run = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    const known = e && e.message && !/syntax|column|relation|undefined|null value/i.test(e.message);
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

exports.getSettings = run(async () => ({ settings: await payroll.getSettings(), pt_presets: payroll.PT_PRESETS, standard_components: payroll.STANDARD_COMPONENTS }));
exports.saveSettings = run(async (req) => { const s = await payroll.saveSettings(req.body || {}); kick(); return { settings: s }; });

exports.listStructures = run(async () => {
  const { history } = await payroll.structures(null);
  const out = {};
  for (const [k, v] of history) out[k] = v;
  return out;
});
exports.saveStructure = run(async (req) => { await payroll.saveStructure(Number(req.params.staffId), req.body || {}, uid(req)); return { ok: true }; });
exports.deleteStructure = run(async (req) => { await payroll.deleteStructure(Number(req.params.structureId)); return { ok: true }; });

exports.getRun = run(async (req) => payroll.getRun(req.params.period));
exports.saveLine = run(async (req) => { await payroll.saveDraftLine(req.params.period, Number(req.params.staffId), req.body || {}); return payroll.getRun(req.params.period); });
exports.finalize = run(async (req) => { const r = await payroll.finalize(req.params.period, uid(req)); kick(); return r; });
exports.reopen = run(async (req) => { const r = await payroll.reopen(req.params.period, uid(req)); kick(); return r; });
exports.pay = run(async (req) => { const r = await payroll.pay(req.params.period, req.body || {}, uid(req)); kick(); return r; });
exports.payments = run(async (req) => payroll.payments(req.params.period));
exports.voidPayment = run(async (req) => { await payroll.voidPayment(Number(req.params.id), req.body?.reason, uid(req)); kick(); return { ok: true }; });

exports.listAdvances = run(async () => payroll.advancesWithBalance());
exports.giveAdvance = run(async (req) => ({ advance_id: await payroll.giveAdvance(req.body || {}, uid(req)) }));
exports.updateAdvance = run(async (req) => { await payroll.updateAdvanceInstallment(Number(req.params.id), req.body?.installment); return { ok: true }; });
exports.voidAdvance = run(async (req) => { await payroll.voidAdvance(Number(req.params.id), req.body?.reason, uid(req)); return { ok: true }; });

// ── staff accounts (settle-up) ──────────────────────────────────────
const accounts = require('../services/staffAccounts');
exports.listAccounts = run(async () => accounts.list());
exports.getAccount = run(async (req) => {
  const id = Number(req.params.staffId);
  return { ...(await accounts.account(id)), suggested: await accounts.suggestRange(id) };
});
exports.giveMoney = run(async (req) => ({ entry_id: await accounts.giveMoney(Number(req.params.staffId), req.body || {}, uid(req)) }));
exports.voidMoney = run(async (req) => { await accounts.voidMoney(Number(req.params.id), req.body?.reason, uid(req)); return { ok: true }; });
exports.previewSettle = run(async (req) => accounts.preview(Number(req.params.staffId), req.body || {}));
exports.settle = run(async (req) => { const r = await accounts.settle(Number(req.params.staffId), req.body || {}, uid(req)); kick(); return r; });
exports.cancelSettlement = run(async (req) => { await accounts.cancelSettlement(Number(req.params.id), req.body?.reason, uid(req)); kick(); return { ok: true }; });
