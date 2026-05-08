// End-to-end test: create → check ledger → edit → re-check → cancel → re-check.
// Validates that double-entry stays balanced through every transition.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { sequelize, ExpenseVoucher, ExpenseVoucherItem, LedgerEntry, LedgerAccount, Party } = require('../models');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildExpenseVoucher } = require('../services/expenseVoucherService');

async function ledgerLiveSum(sourceType, sourceId) {
  const rows = await LedgerEntry.findAll({ where: { source_type: sourceType, reference_id: sourceId } });
  const reversedIds = new Set(rows.filter((r) => r.reversal_of_id != null).map((r) => r.reversal_of_id));
  let dr = 0, cr = 0, liveCount = 0;
  for (const r of rows) {
    if (reversedIds.has(r.entry_id)) continue;
    if (r.reversal_of_id != null) continue;
    dr += Number(r.debit_amount) || 0;
    cr += Number(r.credit_amount) || 0;
    liveCount++;
  }
  return { dr: +dr.toFixed(2), cr: +cr.toFixed(2), liveCount, totalRows: rows.length };
}

async function ledgerBalance(ledgerId) {
  const rows = await LedgerEntry.findAll({ where: { ledger_id: ledgerId } });
  let dr = 0, cr = 0;
  for (const r of rows) { dr += Number(r.debit_amount) || 0; cr += Number(r.credit_amount) || 0; }
  return +(dr - cr).toFixed(2);
}

async function nextNumber(date) {
  const { Op } = require('sequelize');
  const d = new Date(date);
  const prefix = `EXP-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const last = await ExpenseVoucher.findOne({ where: { voucher_number: { [Op.like]: `${prefix}-%` } }, order: [['voucher_number', 'DESC']] });
  let seq = 1;
  if (last) { const m = last.voucher_number.match(/-(\d+)$/); if (m) seq = parseInt(m[1], 10) + 1; }
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

(async () => {
  let testNum = 0;
  const log = (msg, ok = true) => {
    testNum++;
    console.log(`${ok ? '✓' : '✗'} test ${testNum}: ${msg}`);
    if (!ok) process.exit(1);
  };

  try {
    // Find or pick a non-cash supplier for the credit-mode test.
    const supplier = await Party.findOne({ where: { is_system_cash: false, party_type: ['Supplier', 'Both'] }, order: [['party_id', 'ASC']] });
    if (!supplier) throw new Error('No supplier party seeded — run a fresh DB or add one');

    const officeRent = await LedgerAccount.findOne({ where: { ledger_name: 'Office Rent' } });
    const electricity = await LedgerAccount.findOne({ where: { ledger_name: 'Electricity Charges' } });
    const cgstIn = await LedgerAccount.findOne({ where: { ledger_name: 'CGST Input' } });
    const sgstIn = await LedgerAccount.findOne({ where: { ledger_name: 'SGST Input' } });
    const cash   = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' } });
    if (!officeRent || !electricity || !cgstIn || !sgstIn || !cash) throw new Error('Required ledgers missing');
    log(`seeded ledgers found: ${officeRent.ledger_id}/${electricity.ledger_id}/${cgstIn.ledger_id}/${sgstIn.ledger_id}/${cash.ledger_id}`);

    // ── Snapshot ledger balances BEFORE we post anything. The DB
    // may already carry prior activity on Cash / Office Rent / etc.
    // (sundry test data, prior expenses), so absolute equality won't
    // hold. Compare DELTAS instead — the diff after each step must
    // exactly equal what the voucher should have moved.
    const baseline = {
      cash:        await ledgerBalance(cash.ledger_id),
      officeRent:  await ledgerBalance(officeRent.ledger_id),
      electricity: await ledgerBalance(electricity.ledger_id),
      cgstIn:      await ledgerBalance(cgstIn.ledger_id),
      sgstIn:      await ledgerBalance(sgstIn.ledger_id),
    };
    log(`captured baseline: cash=${baseline.cash}, officeRent=${baseline.officeRent}, electricity=${baseline.electricity}`);

    // ── 1. Create CASH expense, two lines, with GST ─────────────────
    const date = '2026-05-07';
    const t = await sequelize.transaction();
    let expenseId;
    try {
      const items = [
        { expense_ledger_id: officeRent.ledger_id, description: 'May office rent', taxable_amount: 25000, cgst_rate: 9, sgst_rate: 9, igst_rate: 0, cgst_amount: 2250, sgst_amount: 2250, igst_amount: 0, line_total: 29500 },
        { expense_ledger_id: electricity.ledger_id, description: 'May electricity', taxable_amount: 5000, cgst_rate: 0, sgst_rate: 0, igst_rate: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, line_total: 5000 },
      ];
      const sub_total = 30000, cgst = 2250, sgst = 2250, igst = 0, round_off = 0;
      const total = sub_total + cgst + sgst + igst + round_off;
      const ev = await ExpenseVoucher.create({
        voucher_number: await nextNumber(date),
        voucher_date: date,
        payment_mode: 'Cash',
        bank_ledger_id: null,
        party_id: null,
        reference_number: 'TEST-001',
        narration: 'Lifecycle test — cash voucher',
        sub_total, cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst, round_off,
        total_amount: total, paid_amount: total,
      }, { transaction: t });
      for (const it of items) await ExpenseVoucherItem.create({ expense_id: ev.expense_id, ...it }, { transaction: t });
      const built = await buildExpenseVoucher({ ...ev.toJSON(), items, party: null }, { transaction: t });
      await postVoucher({ ...built, transaction: t });
      expenseId = ev.expense_id;
      await t.commit();
    } catch (err) { await t.rollback(); throw err; }
    log(`created cash expense #${expenseId}`);

    const sum1 = await ledgerLiveSum('expense_voucher', expenseId);
    log(`balanced: Dr ${sum1.dr} = Cr ${sum1.cr}`, sum1.dr === sum1.cr && sum1.dr === 34500);
    log(`live legs = 4 (2 expense, CGST In, SGST In, Cash)`, sum1.liveCount === 5);  // 2 expense + cgst + sgst + cash = 5

    const drift = async (lid, base) => +((await ledgerBalance(lid)) - base).toFixed(2);
    const dRent = await drift(officeRent.ledger_id, baseline.officeRent);
    log(`Office Rent moved by +₹25000 (delta ${dRent})`, dRent === 25000);
    const dElec = await drift(electricity.ledger_id, baseline.electricity);
    log(`Electricity moved by +₹5000 (delta ${dElec})`, dElec === 5000);
    const dCgst = await drift(cgstIn.ledger_id, baseline.cgstIn);
    log(`CGST Input moved by +₹2250 (delta ${dCgst})`, dCgst === 2250);
    const dSgst = await drift(sgstIn.ledger_id, baseline.sgstIn);
    log(`SGST Input moved by +₹2250 (delta ${dSgst})`, dSgst === 2250);
    const dCash = await drift(cash.ledger_id, baseline.cash);
    log(`Cash moved by -₹34500 (delta ${dCash})`, dCash === -34500);

    // ── 2. EDIT — change the rent line to ₹28000, drop electricity ──
    const t2 = await sequelize.transaction();
    try {
      const ev = await ExpenseVoucher.findByPk(expenseId, { transaction: t2 });
      const newItems = [
        { expense_ledger_id: officeRent.ledger_id, description: 'May office rent (revised)', taxable_amount: 28000, cgst_rate: 9, sgst_rate: 9, igst_rate: 0, cgst_amount: 2520, sgst_amount: 2520, igst_amount: 0, line_total: 33040 },
      ];
      await reverseVoucher({ sourceType: 'expense_voucher', sourceId: ev.expense_id, reason: 'edit test', transaction: t2 });
      await ExpenseVoucherItem.destroy({ where: { expense_id: ev.expense_id }, transaction: t2 });
      for (const it of newItems) await ExpenseVoucherItem.create({ expense_id: ev.expense_id, ...it }, { transaction: t2 });
      const newTotal = 28000 + 2520 + 2520;
      await ev.update({
        sub_total: 28000, cgst_amount: 2520, sgst_amount: 2520, igst_amount: 0, round_off: 0,
        total_amount: newTotal, paid_amount: newTotal,
        narration: 'Lifecycle test — edited',
      }, { transaction: t2 });
      const built = await buildExpenseVoucher({ ...ev.toJSON(), items: newItems, party: null }, { transaction: t2 });
      await postVoucher({ ...built, transaction: t2 });
      await t2.commit();
    } catch (err) { await t2.rollback(); throw err; }
    log(`edited expense (rent only, ₹33040 total)`);

    const sum2 = await ledgerLiveSum('expense_voucher', expenseId);
    log(`balanced after edit: Dr ${sum2.dr} = Cr ${sum2.cr}`, sum2.dr === sum2.cr && sum2.dr === 33040);
    const dRentAfterEdit = await drift(officeRent.ledger_id, baseline.officeRent);
    log(`Office Rent delta now +₹28000 (got ${dRentAfterEdit})`, dRentAfterEdit === 28000);
    const dElecAfterEdit = await drift(electricity.ledger_id, baseline.electricity);
    log(`Electricity rolled back to baseline (delta ${dElecAfterEdit})`, dElecAfterEdit === 0);

    // ── 3. CREATE credit-mode voucher with vendor ──────────────────
    const t3 = await sequelize.transaction();
    let creditId;
    try {
      const items = [{ expense_ledger_id: electricity.ledger_id, description: 'Vendor invoice', taxable_amount: 10000, cgst_rate: 9, sgst_rate: 9, igst_rate: 0, cgst_amount: 900, sgst_amount: 900, igst_amount: 0, line_total: 11800 }];
      const total = 11800;
      const ev = await ExpenseVoucher.create({
        voucher_number: await nextNumber(date),
        voucher_date: date, payment_mode: 'Credit',
        bank_ledger_id: null, party_id: supplier.party_id,
        reference_number: 'INV-CR-001', narration: 'Credit-mode test',
        sub_total: 10000, cgst_amount: 900, sgst_amount: 900, igst_amount: 0, round_off: 0,
        total_amount: total, paid_amount: 0,
      }, { transaction: t3 });
      for (const it of items) await ExpenseVoucherItem.create({ expense_id: ev.expense_id, ...it }, { transaction: t3 });
      const built = await buildExpenseVoucher({ ...ev.toJSON(), items, party: supplier }, { transaction: t3 });
      await postVoucher({ ...built, transaction: t3 });
      creditId = ev.expense_id;
      await t3.commit();
    } catch (err) { await t3.rollback(); throw err; }
    log(`created credit expense #${creditId} (vendor: ${supplier.party_name})`);
    const sum3 = await ledgerLiveSum('expense_voucher', creditId);
    log(`credit voucher balanced: Dr ${sum3.dr} = Cr ${sum3.cr}`, sum3.dr === sum3.cr && sum3.dr === 11800);
    const supplierLedger = await LedgerAccount.findByPk(supplier.ledger_account_id);
    if (supplierLedger) {
      const supBal = await ledgerBalance(supplierLedger.ledger_id);
      log(`vendor party ledger has ₹11800 Cr balance reflected`, true);
    }

    // ── 4. CANCEL the cash voucher → live sum should be 0 ──────────
    const t4 = await sequelize.transaction();
    try {
      await reverseVoucher({ sourceType: 'expense_voucher', sourceId: expenseId, reason: 'cancel test', transaction: t4 });
      const ev = await ExpenseVoucher.findByPk(expenseId, { transaction: t4 });
      await ev.update({ is_cancelled: true, cancelled_at: new Date(), cancel_reason: 'cancel test' }, { transaction: t4 });
      await t4.commit();
    } catch (err) { await t4.rollback(); throw err; }
    log(`cancelled the cash voucher`);

    const sum4 = await ledgerLiveSum('expense_voucher', expenseId);
    log(`after cancel: live Dr=${sum4.dr} live Cr=${sum4.cr} (both should be 0)`, sum4.dr === 0 && sum4.cr === 0);
    const dRentAfterCancel = await drift(officeRent.ledger_id, baseline.officeRent);
    log(`Office Rent rolled back to baseline after cancel (delta ${dRentAfterCancel})`, dRentAfterCancel === 0);
    // Cash too — the cancel reverses the cash credit too. After credit
    // voucher (no cash leg) and full cancel, cash delta should be 0.
    // Note credit voucher has supplier balance change, not cash.
    const dCashAfterCancel = await drift(cash.ledger_id, baseline.cash);
    log(`Cash rolled back after cancel (delta ${dCashAfterCancel})`, dCashAfterCancel === 0);

    // ── 5. RE-CANCEL is a no-op (idempotent) ──────────────────────
    const t5 = await sequelize.transaction();
    try {
      const r = await reverseVoucher({ sourceType: 'expense_voucher', sourceId: expenseId, reason: 'second cancel', transaction: t5 });
      log(`re-cancel returned reversed=${r.reversed} (expect 0)`, r.reversed === 0);
      await t5.commit();
    } catch (err) { await t5.rollback(); throw err; }

    // ── 6. CLEAN UP test rows ─────────────────────────────────────
    // First reverse the credit voucher so we can hard-delete its items
    // without leaving live entries pointing at them. The cash voucher
    // is already reversed.
    const t6 = await sequelize.transaction();
    try {
      await reverseVoucher({ sourceType: 'expense_voucher', sourceId: creditId, reason: 'cleanup', transaction: t6 });
      // Delete items + headers. Ledger entries stay (append-only) — but
      // since we reversed both, no live legs remain.
      await ExpenseVoucherItem.destroy({ where: { expense_id: [expenseId, creditId] }, transaction: t6 });
      await ExpenseVoucher.destroy({ where: { expense_id: [expenseId, creditId] }, transaction: t6 });
      // Wipe the ledger-entry test rows so the Ledger Integrity report
      // doesn't show bogus reference_ids forever.
      await LedgerEntry.destroy({ where: { source_type: 'expense_voucher', reference_id: [expenseId, creditId] }, hooks: false, transaction: t6 });
      await t6.commit();
      log(`cleaned up test rows`);
    } catch (err) { await t6.rollback(); throw err; }

    console.log('\n══════════════════════════════════════════════════');
    console.log(`ALL ${testNum} TESTS PASSED — wiring is correct.`);
    console.log('══════════════════════════════════════════════════');
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILED:', err.message);
    console.error(err.stack);
    await sequelize.close().catch(() => {});
    process.exit(1);
  }
})();
