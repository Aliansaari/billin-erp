// ── Cheque Service ────────────────────────────────────────────────────
//
// Pure functions that turn a Cheque row into the `lines` payload
// consumed by ledgerPostingService.postVoucher(), and a thin wrapper
// that runs the post inside a caller-provided Sequelize transaction.
//
// Why each lifecycle event has its own source_type:
//
//   The posting service refuses to post twice for the same
//   (source_type, source_id). A cheque emits up to four distinct
//   vouchers over its life — receipt, deposit, clearance-from-PDC,
//   bounce charges — so each event needs its own slot.  Reversing
//   the deposit voucher (when a cheque bounces after deposit) leaves
//   the receipt voucher untouched, and vice versa, which matches
//   the real-world bookkeeping: a deposit reversal puts the cheque
//   back in the drawer (Cheques in Hand), while a receipt reversal
//   goes one step further and clears the customer leg.
//
//   Source types in use:
//     cheque_inward_receipt  — INWARD created (Cheques in Hand Dr / Customer Cr)
//     cheque_inward_deposit  — INWARD deposited (Bank Dr / Cheques in Hand Cr)
//     cheque_outward_issue   — OUTWARD created (Supplier Dr / Bank-or-PDC Cr)
//     cheque_outward_clear   — OUTWARD cleared (PDC Dr / Bank Cr — only for PDCs)
//     cheque_bounce          — Bank charges on bounce (Bounce Charges Dr / Bank Cr)
//
// Clearance of a regular dated cheque (INWARD or OUTWARD non-PDC) is a
// FLAG transition only, not a voucher event. The accounting impact was
// already recorded at the deposit/issue step; clearance is bookkeeper
// confirmation, not a money movement.

const { LedgerAccount, Party } = require('../models');
const { postVoucher, reverseVoucher } = require('./ledgerPostingService');

function r2(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Math.abs(v) < 0.005 ? 0 : v;
}

// Cached system-ledger lookup. Mirrors voucherBuilders.getSystemLedger
// — a per-call cache (keyed on the empty object the caller passes in)
// so repeated lookups inside one cheque action don't fan out into
// extra round-trips.
async function getSystemLedger(name, cache, transaction) {
  if (cache[name]) return cache[name];
  const row = await LedgerAccount.findOne({ where: { ledger_name: name }, transaction });
  if (!row) {
    throw new Error(
      `chequeService: required ledger missing — '${name}' (re-run seeder to create cheque ledgers?)`,
    );
  }
  cache[name] = row;
  return row;
}

// Resolve the party's auto-created ledger account.
async function getPartyLedger(party, transaction) {
  if (!party) return null;
  if (party.ledger_account_id) {
    const direct = await LedgerAccount.findByPk(party.ledger_account_id, { transaction });
    if (direct) return direct;
  }
  return LedgerAccount.findOne({ where: { party_id: party.party_id }, transaction });
}

// Resolve the bank ledger by id and assert it really is a bank
// (sub_group). Throwing here gives a much clearer error than a later
// "voucher unbalanced" surfacing from the posting service.
async function getBankLedger(bankLedgerId, transaction) {
  if (!bankLedgerId) {
    throw new Error('chequeService: bank_ledger_id is required for this action');
  }
  const row = await LedgerAccount.findByPk(bankLedgerId, { transaction });
  if (!row) {
    throw new Error(`chequeService: bank ledger #${bankLedgerId} not found`);
  }
  if (!['Bank Accounts', 'Bank OD A/c'].includes(row.sub_group)) {
    throw new Error(
      `chequeService: ledger '${row.ledger_name}' is not a bank ` +
      `(sub_group=${row.sub_group}). Pick a Bank Account / Bank OD A/c.`,
    );
  }
  return row;
}

// ── Builders ─────────────────────────────────────────────────────────

// Receipt of an INWARD cheque: customer hands it to us.
//   Cheques in Hand   Dr  amount
//     Customer        Cr  amount    (clears the receivable)
async function buildInwardReceipt(cheque, party, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const cih = await getSystemLedger('Cheques in Hand', cache, t);
  const partyLedger = await getPartyLedger(party, t);
  if (!partyLedger) {
    throw new Error(`chequeService: party #${party.party_id} has no ledger account`);
  }
  const amount = r2(cheque.amount);
  return {
    voucherType: 'Receipt',
    sourceType:  'cheque_inward_receipt',
    sourceId:    cheque.cheque_id,
    voucherDate: cheque.instrument_date,
    referenceNumber: cheque.cheque_number,
    lines: [
      { ledgerAccountId: cih.ledger_id,         debit: amount, credit: 0 },
      { ledgerAccountId: partyLedger.ledger_id, debit: 0, credit: amount, partyId: party.party_id },
    ],
    narration:
      `Cheque #${cheque.cheque_number} received from ${party.party_name}` +
      (cheque.is_pdc ? ' (PDC)' : ''),
  };
}

// Deposit of an INWARD cheque at OUR bank:
//   Bank             Dr  amount
//     Cheques in Hand Cr amount
async function buildInwardDeposit(cheque, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const cih = await getSystemLedger('Cheques in Hand', cache, t);
  const bank = await getBankLedger(cheque.bank_ledger_id, t);
  const amount = r2(cheque.amount);
  return {
    voucherType: 'Receipt',
    sourceType:  'cheque_inward_deposit',
    sourceId:    cheque.cheque_id,
    voucherDate: cheque.deposit_date,
    referenceNumber: cheque.cheque_number,
    lines: [
      { ledgerAccountId: bank.ledger_id, debit: amount, credit: 0 },
      { ledgerAccountId: cih.ledger_id,  debit: 0, credit: amount },
    ],
    narration: `Cheque #${cheque.cheque_number} deposited to ${bank.ledger_name}`,
  };
}

// Issue of an OUTWARD cheque to a supplier.
//
//   Regular dated (cheque_date <= today): the bank effectively holds
//   the funds against this cheque, so we credit Bank directly.  The
//   cheque sits in "uncleared" until the supplier presents it; the
//   clearance transition is then just a bookkeeper flag.
//
//     Supplier  Dr amount
//       Bank    Cr amount
//
//   Post-dated (cheque_date > today): the bank doesn't see the
//   instrument until maturity, so we credit a holding liability
//   ledger ("Cheques Issued (PDC)") rather than the bank itself —
//   exactly how Tally records PDCs.  When the cheque clears we move
//   it from PDC liability to Bank credit (see buildOutwardClear).
//
//     Supplier               Dr amount
//       Cheques Issued (PDC) Cr amount
async function buildOutwardIssue(cheque, party, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const partyLedger = await getPartyLedger(party, t);
  if (!partyLedger) {
    throw new Error(`chequeService: supplier #${party.party_id} has no ledger account`);
  }
  const amount = r2(cheque.amount);
  let creditLeg;
  let creditLabel;
  if (cheque.is_pdc) {
    const pdc = await getSystemLedger('Cheques Issued (PDC)', cache, t);
    creditLeg = { ledgerAccountId: pdc.ledger_id, debit: 0, credit: amount };
    creditLabel = 'PDC liability';
  } else {
    const bank = await getBankLedger(cheque.bank_ledger_id, t);
    creditLeg = { ledgerAccountId: bank.ledger_id, debit: 0, credit: amount };
    creditLabel = bank.ledger_name;
  }
  return {
    voucherType: 'Payment',
    sourceType:  'cheque_outward_issue',
    sourceId:    cheque.cheque_id,
    voucherDate: cheque.instrument_date,
    referenceNumber: cheque.cheque_number,
    lines: [
      { ledgerAccountId: partyLedger.ledger_id, debit: amount, credit: 0, partyId: party.party_id },
      creditLeg,
    ],
    narration:
      `Cheque #${cheque.cheque_number} issued to ${party.party_name}` +
      (cheque.is_pdc ? ` (PDC, posted to ${creditLabel})` : ''),
  };
}

// Clearance of an OUTWARD PDC cheque — moves the holding liability
// onto the bank when the supplier finally presents the cheque.
//
//   Cheques Issued (PDC)  Dr  amount
//     Bank                Cr  amount
//
// Only emitted for PDCs. Regular outward cheques posted directly to
// Bank at issue time, so clearance is just a flag transition.
async function buildOutwardClear(cheque, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const pdc = await getSystemLedger('Cheques Issued (PDC)', cache, t);
  const bank = await getBankLedger(cheque.bank_ledger_id, t);
  const amount = r2(cheque.amount);
  return {
    voucherType: 'Payment',
    sourceType:  'cheque_outward_clear',
    sourceId:    cheque.cheque_id,
    voucherDate: cheque.clearance_date,
    referenceNumber: cheque.cheque_number,
    lines: [
      { ledgerAccountId: pdc.ledger_id,  debit: amount, credit: 0 },
      { ledgerAccountId: bank.ledger_id, debit: 0, credit: amount },
    ],
    narration: `Cheque #${cheque.cheque_number} matured — paid from ${bank.ledger_name}`,
  };
}

// Bounce-charge voucher. Posted as a SEPARATE voucher (not folded
// into the bounce reversal) so the P&L Bounce-Charges ledger reads
// as a clean expense register independent of the cheque it relates
// to.
//
//   Cheque Bounce Charges  Dr fee
//     Bank                 Cr fee
async function buildBounceCharges(cheque, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const fee = r2(cheque.bounce_charges);
  if (fee <= 0) return null;   // caller should skip the post
  const exp = await getSystemLedger('Cheque Bounce Charges', cache, t);
  const bank = await getBankLedger(cheque.bank_ledger_id, t);
  return {
    voucherType: 'Payment',
    sourceType:  'cheque_bounce',
    sourceId:    cheque.cheque_id,
    voucherDate: cheque.bounce_date || new Date().toISOString().slice(0, 10),
    referenceNumber: cheque.cheque_number,
    lines: [
      { ledgerAccountId: exp.ledger_id,  debit: fee, credit: 0 },
      { ledgerAccountId: bank.ledger_id, debit: 0, credit: fee },
    ],
    narration: `Bounce charges for cheque #${cheque.cheque_number}`,
  };
}

// ── Public surface ──
//
// Each of these takes a Cheque row + the same userId / transaction
// args you'd pass to postVoucher, builds the right voucher lines,
// and posts them in the supplied transaction. They return whatever
// postVoucher returned (LedgerEntry rows) so callers can audit-log
// or test on the entries.

async function postInwardReceipt({ cheque, party, userId, transaction }) {
  const v = await buildInwardReceipt(cheque, party, { transaction });
  return postVoucher({ ...v, userId, transaction });
}

async function postInwardDeposit({ cheque, userId, transaction }) {
  const v = await buildInwardDeposit(cheque, { transaction });
  return postVoucher({ ...v, userId, transaction });
}

async function postOutwardIssue({ cheque, party, userId, transaction }) {
  const v = await buildOutwardIssue(cheque, party, { transaction });
  return postVoucher({ ...v, userId, transaction });
}

async function postOutwardClear({ cheque, userId, transaction }) {
  const v = await buildOutwardClear(cheque, { transaction });
  return postVoucher({ ...v, userId, transaction });
}

async function postBounceCharges({ cheque, userId, transaction }) {
  const v = await buildBounceCharges(cheque, { transaction });
  if (!v) return null;
  return postVoucher({ ...v, userId, transaction });
}

// Helper to reverse one source-type set of vouchers for a cheque.
// Thin alias over reverseVoucher — in the controller we call this
// per source_type as we walk back the lifecycle, which keeps each
// reversal step labelled and auditable on its own.
async function reverseChequeVoucher({ sourceType, chequeId, reason, userId, transaction }) {
  return reverseVoucher({
    sourceType, sourceId: chequeId,
    reason, userId, transaction,
  });
}

module.exports = {
  postInwardReceipt,
  postInwardDeposit,
  postOutwardIssue,
  postOutwardClear,
  postBounceCharges,
  reverseChequeVoucher,
  // Exposed for tests / debugging.
  _buildInwardReceipt: buildInwardReceipt,
  _buildInwardDeposit: buildInwardDeposit,
  _buildOutwardIssue:  buildOutwardIssue,
  _buildOutwardClear:  buildOutwardClear,
  _buildBounceCharges: buildBounceCharges,
};
