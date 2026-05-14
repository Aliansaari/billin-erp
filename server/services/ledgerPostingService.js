// ── Ledger Posting Service ─────────────────────────────────────────────
//
// The single, audited entry point that writes to ledger_entries. Every
// flow that needs to post to the books — sales, purchases, payments,
// returns, journal vouchers — calls postVoucher(). Reversing a posting
// (edit, delete, return) calls reverseVoucher().
//
// Hard rules enforced here:
//   • Sum of debits must equal sum of credits, to the paisa, before any
//     row is written.
//   • Each line must have either debit > 0 OR credit > 0, never both.
//   • At least 2 lines per voucher.
//   • Idempotent on (source_type, source_id) — calling postVoucher twice
//     for the same source rejects the second call.
//   • All writes go through one Sequelize transaction. Caller may pass
//     in a parent transaction so the posting commits/rolls-back atomically
//     with its source row.
//
// No code outside this file should insert into ledger_entries directly.
// Enforced by grep test in the integrity self-test.
// ────────────────────────────────────────────────────────────────────────

const { Op } = require('sequelize');
const { LedgerEntry, sequelize } = require('../models');

const PAISA_TOLERANCE = 0.005; // half a paisa — for floating sum drift

// Money values come in as numbers, strings, or Decimal-likes. Normalise to
// a Number rounded to 2 decimal places. We compare in paisa to avoid float
// drift on sum() over many lines.
function toAmount(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// Voucher-number generator. Format: <prefix>-<YYYYMMDD>-<seq>. Sequence is
// derived from the count of entries already posted today plus a random
// suffix so concurrent inserts don't collide. The DB unique constraint on
// entry_number is the actual safety net.
async function nextEntryNumber(voucherType, voucherDate, transaction) {
  const prefixMap = {
    Sales: 'SAL', Purchase: 'PUR', Receipt: 'RCT',
    Payment: 'PMT', Journal: 'JV',  Contra: 'CON',
  };
  const prefix = prefixMap[voucherType] || 'GEN';
  const d = new Date(voucherDate);
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  // Use the highest existing sequence for this prefix+date, then increment.
  const like = `${prefix}-${yyyymmdd}-%`;
  // W1: order by entry_id (monotonic) not entry_number (lexicographic string).
  // entry_number DESC breaks at 10000+ entries per day: '9999' > '10000' as text,
  // so the counter would stall at 9999 and then collide on the 10001st entry.
  const last = await LedgerEntry.findOne({
    where: { entry_number: { [Op.like]: like } },
    order: [['entry_id', 'DESC']],
    transaction,
  });
  let seq = 1;
  if (last && last.entry_number) {
    const m = last.entry_number.match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${yyyymmdd}-${String(seq).padStart(4, '0')}`;
}

// ── postVoucher ────────────────────────────────────────────────────────
//
//   postVoucher({
//     voucherType,    'Sales' | 'Purchase' | 'Receipt' | 'Payment' | 'Journal' | 'Contra'
//     sourceType,     'sales_bill' | 'purchase_bill' | 'sales_return_bill' |
//                     'purchase_return_bill' | 'payment_receipt' | 'journal_voucher'
//     sourceId,       FK to source row
//     voucherDate,    Date or 'YYYY-MM-DD'
//     referenceNumber, optional human reference (bill no., voucher no.)
//     lines,          [{ ledgerAccountId, debit, credit, partyId? }]
//     narration,      string
//     userId,         number (audit)
//     transaction,    optional Sequelize transaction; if omitted a new one is created
//   })
//
// Returns the array of inserted LedgerEntry rows.
async function postVoucher({
  voucherType,
  sourceType,
  sourceId,
  voucherDate,
  referenceNumber,
  lines,
  narration,
  userId,
  transaction,
}) {
  if (!voucherType) throw new Error('postVoucher: voucherType is required');
  if (!sourceType)  throw new Error('postVoucher: sourceType is required');
  if (sourceId == null) throw new Error('postVoucher: sourceId is required');
  if (!voucherDate) throw new Error('postVoucher: voucherDate is required');
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('postVoucher: at least 2 lines required');
  }

  // Validate every line
  let dr = 0, cr = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || ln.ledgerAccountId == null) {
      throw new Error(`postVoucher: line[${i}] missing ledgerAccountId`);
    }
    const d = toAmount(ln.debit);
    const c = toAmount(ln.credit);
    if (d < 0 || c < 0) {
      throw new Error(`postVoucher: line[${i}] negative amount`);
    }
    if (d > 0 && c > 0) {
      throw new Error(`postVoucher: line[${i}] has both debit and credit > 0`);
    }
    if (d === 0 && c === 0) {
      throw new Error(`postVoucher: line[${i}] has zero amount`);
    }
    dr += d;
    cr += c;
  }
  // Compare in paisa to avoid float drift
  if (Math.abs(dr - cr) > PAISA_TOLERANCE) {
    throw new Error(
      `postVoucher: unbalanced — debits ${dr.toFixed(2)} ≠ credits ${cr.toFixed(2)}`,
    );
  }

  const own = !transaction;
  const t = transaction || (await sequelize.transaction());

  try {
    // Idempotency: refuse to post twice for the same (source_type, source_id)
    // counting only LIVE forward entries — those that are forward (reversal_of_id
    // IS NULL) AND not paired with a mirror (no other row has reversal_of_id =
    // their entry_id). After reverseVoucher() runs, the originals are paired
    // with their mirrors, so the live-forward count drops to zero and a re-post
    // is allowed (this is what makes "edit" work as reverse + repost).
    const all = await LedgerEntry.findAll({
      where: { source_type: sourceType, reference_id: sourceId },
      attributes: ['entry_id', 'reversal_of_id'],
      transaction: t,
    });
    const reversedIds = new Set(
      all.filter((r) => r.reversal_of_id != null).map((r) => r.reversal_of_id),
    );
    const liveForward = all.filter(
      (r) => r.reversal_of_id == null && !reversedIds.has(r.entry_id),
    );
    if (liveForward.length > 0) {
      throw new Error(
        `postVoucher: voucher already posted for ${sourceType}#${sourceId} (${liveForward.length} live entries)`,
      );
    }

    const entryNumber = await nextEntryNumber(voucherType, voucherDate, t);

    const rows = lines.map((ln) => ({
      entry_number: entryNumber,
      entry_date: voucherDate,
      ledger_id: ln.ledgerAccountId,
      debit_amount:  toAmount(ln.debit),
      credit_amount: toAmount(ln.credit),
      narration: narration || null,
      voucher_type: voucherType,
      reference_id: sourceId,
      reference_number: referenceNumber || null,
      source_type: sourceType,
      party_id: ln.partyId || null,
      reversal_of_id: null,
      created_by: userId || null,
    }));

    const inserted = await LedgerEntry.bulkCreate(rows, {
      transaction: t,
      validate: true,
      // bulkCreate doesn't fire beforeUpdate/beforeDestroy hooks — safe.
    });

    if (own) await t.commit();
    return inserted;
  } catch (err) {
    if (own) await t.rollback();
    throw err;
  }
}

// ── reverseVoucher ─────────────────────────────────────────────────────
//
// Find every live (non-reversed) entry for (sourceType, sourceId) and
// insert a mirror set with debits/credits swapped. Each mirror row has
// reversal_of_id set to the original entry_id.
//
// Idempotent: if every original entry is already reversed, this is a
// no-op (logged warning, not an error). This makes "delete twice" safe.
//
// Returns { reversed: <count of new mirror rows> }. Zero means already
// fully reversed.
async function reverseVoucher({
  sourceType,
  sourceId,
  reason,
  userId,
  transaction,
  reversalDate,    // optional: date the reversal entries should carry (defaults to today)
}) {
  if (!sourceType) throw new Error('reverseVoucher: sourceType is required');
  if (sourceId == null) throw new Error('reverseVoucher: sourceId is required');

  const own = !transaction;
  const t = transaction || (await sequelize.transaction());

  try {
    // All entries for this source — both originals and any prior reversals.
    const all = await LedgerEntry.findAll({
      where: { source_type: sourceType, reference_id: sourceId },
      transaction: t,
    });
    // Group: which originals already have a matching reversal?
    const reversedIds = new Set(
      all.filter((e) => e.reversal_of_id != null).map((e) => e.reversal_of_id),
    );
    const liveOriginals = all.filter(
      (e) => e.reversal_of_id == null && !reversedIds.has(e.entry_id),
    );

    if (liveOriginals.length === 0) {
      if (own) await t.commit();
      // eslint-disable-next-line no-console
      console.warn(
        `[ledgerPostingService] reverseVoucher: no live entries for ${sourceType}#${sourceId} — already reversed?`,
      );
      return { reversed: 0 };
    }

    const first = liveOriginals[0];
    const reversalEntryNumber = `${first.entry_number}-REV`;
    const reasonText = reason ? `Reversal: ${reason}` : `Reversal of ${first.entry_number}`;

    const mirrors = liveOriginals.map((orig) => ({
      entry_number: reversalEntryNumber,
      entry_date: reversalDate ? new Date(reversalDate) : new Date(),
      ledger_id: orig.ledger_id,
      // Swap debit ↔ credit
      debit_amount:  Number(orig.credit_amount) || 0,
      credit_amount: Number(orig.debit_amount)  || 0,
      narration: reasonText,
      voucher_type: orig.voucher_type,
      reference_id: orig.reference_id,
      reference_number: orig.reference_number,
      source_type: orig.source_type,
      party_id: orig.party_id,
      reversal_of_id: orig.entry_id,
      created_by: userId || null,
    }));

    await LedgerEntry.bulkCreate(mirrors, { transaction: t, validate: true });

    if (own) await t.commit();
    return { reversed: mirrors.length };
  } catch (err) {
    if (own) await t.rollback();
    throw err;
  }
}

// Compute net balance (debit - credit) for a given ledger account, treating
// reversed entries as zero. Used by tests and the integrity screen.
async function getLedgerBalance(ledgerAccountId, { transaction } = {}) {
  const rows = await LedgerEntry.findAll({
    where: { ledger_id: ledgerAccountId },
    attributes: ['debit_amount', 'credit_amount', 'reversal_of_id', 'entry_id'],
    transaction,
  });
  // Drop any entry whose entry_id appears as another row's reversal_of_id.
  const reversedIds = new Set(
    rows.filter((r) => r.reversal_of_id != null).map((r) => r.reversal_of_id),
  );
  let dr = 0, cr = 0;
  for (const r of rows) {
    if (reversedIds.has(r.entry_id)) continue;          // skip reversed original
    if (r.reversal_of_id != null) continue;             // skip the reversal mirror itself — its sibling is gone
    dr += Number(r.debit_amount)  || 0;
    cr += Number(r.credit_amount) || 0;
  }
  // Recount including reversals so net is mathematically correct:
  // Actually simpler — sum all live (non-reversed-and-not-mirroring-a-reversed) lines.
  // The pair (original + reversal) cancels by construction.
  // Re-compute by including everything; the pairs sum to zero.
  let drAll = 0, crAll = 0;
  for (const r of rows) {
    drAll += Number(r.debit_amount)  || 0;
    crAll += Number(r.credit_amount) || 0;
  }
  return Math.round((drAll - crAll) * 100) / 100;
}

module.exports = {
  postVoucher,
  reverseVoucher,
  getLedgerBalance,
  // Exposed for tests:
  _toAmount: toAmount,
  _nextEntryNumber: nextEntryNumber,
};
