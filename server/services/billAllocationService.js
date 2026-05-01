// ── Bill Allocation Service (R9) ───────────────────────────────────────
//
// One-stop helper for writing `bill_payment_allocations` rows from any
// caller that creates a `payments_receipts` row. Used by:
//   · Excel import orchestrator   (allocation_method='import_excel')
//   · Tally import orchestrator   (allocation_method='import_tally')
//   · Backfill script             (allocation_method='backfill_fifo')
//
// Two allocation modes:
//
//   1. EXPLICIT — caller supplies an array of { bill_number, amount }
//      (Tally's BILLALLOCATIONS.LIST or Excel's bill_reference column).
//      Each entry resolves to a local bill via (party_id + bill_number);
//      unresolved references bubble up so the caller can reject in the
//      preview phase rather than at commit.
//
//   2. FIFO — caller supplies no allocations. We walk the party's
//      outstanding bills as of `as_of_date` (oldest first) and apply the
//      receipt's amount until exhausted. Any leftover stays as advance —
//      not flagged as unallocated since there's no further bill to
//      attach it to. This matches the historical truth at the time of
//      the receipt; we never allocate against bills that didn't exist
//      yet.
//
// Outputs in BOTH modes:
//   · INSERTs into bill_payment_allocations (one row per allocation).
//   · UPDATEs sales_bills.balance_amount / purchase_bills.balance_amount
//     in lock-step. The caller's transaction is required so the row +
//     allocations + bill updates land atomically.
//
// Idempotency:
//   · `applyAllocations` checks for existing rows on the same
//     transaction_id before writing. Subsequent calls with the same
//     receipt are no-ops.
//   · Re-imports therefore don't double-write, even if the orchestrator
//     re-creates the underlying row.
//
// Out-of-scope (deliberately):
//   · Cancelling receipts → handled by paymentController.cancel and
//     autoReceiptService.reverseAutoReceiptForBill.
//   · Editing the per-bill allocations after the fact → manual UI work
//     (out of R9 scope; the "Allocate now" link in the BR/BP banner
//     placeholders this).

const sequelize = require('../config/database');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Bill type for allocations — `Sales` for Receipt vouchers (customer
// receivables), `Purchase` for Payment vouchers (supplier payables).
function billTypeForVoucher(transactionType) {
  return transactionType === 'Receipt' ? 'Sales' : 'Purchase';
}

// Bill table + PK + party FK, indexed by side. Single source of truth
// so we don't sprinkle ternaries through every query.
const SIDE = {
  Sales:    { table: 'sales_bills',    pk: 'sales_bill_id',    partyFk: 'customer_id' },
  Purchase: { table: 'purchase_bills', pk: 'purchase_bill_id', partyFk: 'supplier_id' },
};

// ── resolveBillReferences ─────────────────────────────────────────────
//
// Input:
//   { partyId, billType, references, t }
//   references: array<{ bill_number, amount? }>
//
// Output:
//   { resolved: [{ bill_id, bill_number, amount }], unknown: [bill_number] }
//
// Each reference must match a non-cancelled bill belonging to the same
// party — bill numbers are namespaced per party in this codebase. The
// caller decides what to do with `unknown` (Tally validate phase rejects
// the whole voucher; Excel validate rejects just the row).
async function resolveBillReferences({ partyId, billType, references, t }) {
  const cfg = SIDE[billType];
  if (!cfg) throw new Error(`resolveBillReferences: unknown billType "${billType}"`);
  const out = { resolved: [], unknown: [] };
  if (!Array.isArray(references) || references.length === 0) return out;

  // Trim + de-dupe to avoid hitting the DB with duplicates from sloppy
  // BILLALLOCATIONS.LIST exports.
  const trimmed = references
    .map((r) => ({ ...r, bill_number: String(r.bill_number || '').trim() }))
    .filter((r) => r.bill_number);

  const numbers = [...new Set(trimmed.map((r) => r.bill_number))];
  if (numbers.length === 0) return out;

  const rows = await sequelize.query(
    `SELECT ${cfg.pk} AS bill_id, bill_number, total_amount, balance_amount
       FROM ${cfg.table}
      WHERE ${cfg.partyFk} = :pid
        AND bill_number IN (:nums)
        AND is_cancelled = false`,
    { replacements: { pid: partyId, nums: numbers }, type: sequelize.QueryTypes.SELECT, transaction: t },
  );
  const byNumber = new Map(rows.map((r) => [r.bill_number, r]));

  for (const ref of trimmed) {
    const hit = byNumber.get(ref.bill_number);
    if (!hit) { out.unknown.push(ref.bill_number); continue; }
    out.resolved.push({
      bill_id:     hit.bill_id,
      bill_number: hit.bill_number,
      amount:      ref.amount != null ? r2(ref.amount) : null, // null → caller will infer
    });
  }
  return out;
}

// ── fifoAllocate ──────────────────────────────────────────────────────
//
// Walk the party's outstanding bills (balance_amount > 0) as of
// `asOfDate` in oldest-first order, consuming `totalAmount`. Returns the
// allocation plan; caller persists via applyAllocations.
//
// Critical: bill_date <= as_of (NOT today's date). For backfilled
// receipts we want the FIFO snapshot as it was on the receipt date —
// allocating to a bill that didn't exist yet is wrong.
async function fifoAllocate({ partyId, billType, asOfDate, totalAmount, t }) {
  const cfg = SIDE[billType];
  if (!cfg) throw new Error(`fifoAllocate: unknown billType "${billType}"`);
  const remaining = r2(totalAmount);
  if (remaining <= 0) return [];

  const bills = await sequelize.query(
    `SELECT ${cfg.pk} AS bill_id, bill_number, balance_amount
       FROM ${cfg.table}
      WHERE ${cfg.partyFk} = :pid
        AND is_cancelled = false
        AND bill_date <= :as_of
        AND balance_amount > 0
      ORDER BY bill_date ASC, ${cfg.pk} ASC`,
    {
      replacements: { pid: partyId, as_of: asOfDate },
      type: sequelize.QueryTypes.SELECT,
      transaction: t,
    },
  );

  const plan = [];
  let left = remaining;
  for (const b of bills) {
    if (left <= 0.005) break;
    const cap = r2(b.balance_amount);
    if (cap <= 0) continue;
    const apply = r2(Math.min(left, cap));
    plan.push({ bill_id: b.bill_id, bill_number: b.bill_number, amount: apply });
    left = r2(left - apply);
  }
  return plan;
}

// ── applyAllocations ──────────────────────────────────────────────────
//
// Persists the plan: inserts bill_payment_allocations rows + decrements
// the corresponding bill's balance_amount + recomputes payment_status.
//
// Args:
//   { receiptId, billType, plan, method, t }
//   plan: array<{ bill_id, amount }>
//
// Idempotency: if any allocations already exist for this receiptId, we
// skip and return { skipped: true }. The orchestrators rely on this to
// stay safe across re-imports.
async function applyAllocations({ receiptId, billType, plan, method, t }) {
  const cfg = SIDE[billType];
  if (!cfg) throw new Error(`applyAllocations: unknown billType "${billType}"`);

  const [existing] = await sequelize.query(
    `SELECT COUNT(*)::int AS n FROM bill_payment_allocations WHERE transaction_id = :id`,
    { replacements: { id: receiptId }, type: sequelize.QueryTypes.SELECT, transaction: t },
  );
  if (existing.n > 0) return { skipped: true, inserted: 0 };

  if (!Array.isArray(plan) || plan.length === 0) return { skipped: false, inserted: 0 };

  let inserted = 0;
  for (const a of plan) {
    if (!a.bill_id || !(a.amount > 0)) continue;
    await sequelize.query(
      `INSERT INTO bill_payment_allocations
         (transaction_id, bill_type, bill_id, allocated_amount, allocation_method)
       VALUES (:tid, :bt, :bid, :amt, :m)`,
      {
        replacements: {
          tid: receiptId, bt: billType, bid: a.bill_id, amt: r2(a.amount), m: method,
        },
        transaction: t,
      },
    );
    // Decrement bill.balance_amount + recompute payment_status. Clamp at
    // 0 so an over-allocation never produces a negative balance.
    // payment_status is a Postgres ENUM, so the CASE result needs an
    // explicit cast (text-to-enum coercion is not implicit).
    const enumType = `enum_${cfg.table}_payment_status`;
    await sequelize.query(
      `UPDATE ${cfg.table}
          SET balance_amount = GREATEST(0, COALESCE(balance_amount, 0) - :amt),
              paid_amount    = LEAST(total_amount, COALESCE(paid_amount, 0) + :amt),
              payment_status = (CASE
                WHEN GREATEST(0, COALESCE(balance_amount, 0) - :amt) <= 0.005 THEN 'Paid'
                ELSE 'Partial'
              END)::${enumType}
        WHERE ${cfg.pk} = :bid`,
      { replacements: { amt: r2(a.amount), bid: a.bill_id }, transaction: t },
    );
    inserted++;
  }
  return { skipped: false, inserted };
}

// ── allocateForReceipt ────────────────────────────────────────────────
//
// One-shot helper that combines resolve + FIFO + apply, the common path
// for both orchestrators and the backfill script. Returns a structured
// result so the caller can report what happened.
//
// Args:
//   { receiptId, partyId, transactionType, asOfDate, totalAmount,
//     references, method, t, allowFifoFallback = true }
//
// Logic:
//   1. If references provided AND non-empty:
//        resolveBillReferences → if unknown.length > 0 throw.
//        Compute per-bill amount: caller's amount if given, else split
//        evenly (uncommon — explicit allocations should always carry
//        amounts).
//   2. Else if allowFifoFallback:
//        fifoAllocate.
//   3. applyAllocations.
async function allocateForReceipt({
  receiptId, partyId, transactionType, asOfDate, totalAmount,
  references = null, method, t, allowFifoFallback = true,
}) {
  const billType = billTypeForVoucher(transactionType);
  let plan;
  let mode = 'fifo';

  if (Array.isArray(references) && references.length > 0) {
    const { resolved, unknown } = await resolveBillReferences({
      partyId, billType, references, t,
    });
    if (unknown.length > 0) {
      const err = new Error(`Unknown bill references for party: ${unknown.join(', ')}`);
      err.code = 'UNKNOWN_BILL_REFERENCES';
      err.unknown = unknown;
      throw err;
    }
    // Caller-supplied amounts win; for entries without amount, evenly
    // distribute the remainder (rare path — Tally always emits amounts).
    const withAmt = resolved.filter((r) => r.amount != null);
    const withoutAmt = resolved.filter((r) => r.amount == null);
    let rest = r2(totalAmount - withAmt.reduce((s, r) => s + r.amount, 0));
    if (withoutAmt.length > 0 && rest > 0) {
      const each = r2(rest / withoutAmt.length);
      withoutAmt.forEach((r) => { r.amount = each; });
    }
    plan = resolved.map((r) => ({ bill_id: r.bill_id, bill_number: r.bill_number, amount: r.amount }));
    mode = 'explicit';
  } else if (allowFifoFallback) {
    plan = await fifoAllocate({ partyId, billType, asOfDate, totalAmount, t });
  } else {
    plan = [];
  }

  const result = await applyAllocations({ receiptId, billType, plan, method, t });
  const allocatedTotal = r2(plan.reduce((s, p) => s + p.amount, 0));
  const remainder = r2(totalAmount - allocatedTotal);
  return {
    mode,
    skipped: result.skipped,
    inserted: result.inserted,
    plan,
    allocated_total: allocatedTotal,
    remainder, // > 0 → on-account / advance (not flagged as unallocated)
  };
}

module.exports = {
  resolveBillReferences,
  fifoAllocate,
  applyAllocations,
  allocateForReceipt,
  billTypeForVoucher,
};
