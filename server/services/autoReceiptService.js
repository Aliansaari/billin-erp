// ── Auto Receipt/Payment Service (R8 Phase 2) ─────────────────────────
//
// Manages the `payments_receipts` row + `bill_payment_allocations` row
// that pair with the Receipt/Payment LEDGER voucher emitted by the
// voucher builders for paid credit sales/purchases.
//
// The voucher builders (services/voucherBuilders.js) ALREADY emit a
// separate Receipt voucher (source_type='sales_bill_receipt', voucherType
// 'Receipt') on bill creation when the customer is non-cash and
// paid_amount > 0. They do NOT, however, write the corresponding
// payments_receipts row — so the Receipts list (which reads from that
// table) has historically under-reported actual cash received.
//
// This service closes that gap. Three idempotent operations:
//
//   syncAutoReceiptForBill({ kind:'sales'|'purchase', bill, t })
//     Called AFTER the bill's vouchers have been posted (or re-posted
//     after edit). Decides whether an auto-receipt row should exist
//     for this bill and brings the table into that state:
//       · paid_amount > 0 + non-cash party  → INSERT (or UPDATE if
//                                              already exists)
//       · paid_amount = 0 OR cash party     → DELETE existing
//                                              auto-receipt row (the
//                                              underlying ledger
//                                              voucher already got
//                                              reversed by the caller)
//     Allocation row is created/updated atomically alongside.
//
//   reverseAutoReceiptForBill({ kind, billId, t })
//     Called when a bill is cancelled. Marks the auto-receipt row
//     is_cancelled=true (preserves the audit trail). Allocation rows
//     are dropped via CASCADE on the FK; we delete them explicitly
//     here too so the SUM(allocations) integrity check post-cancel
//     reads as zero.
//
//   getAutoReceiptForBill({ kind, billId, t })
//     Lookup helper used by the integrity-invariants endpoint and
//     the bill-detail page's Payments section.
//
// Idempotency contract: every operation can run any number of times
// without changing the final DB state. That's how the Phase 1
// backfill script (run with --apply) and the Phase 2 controller
// hooks coexist safely on a freshly-migrated DB.

const sequelize = require('../config/database');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Resolve which transaction_type / bill_type / cash-account-side
// constants apply for a given operation kind. Centralised so the
// caller only knows 'sales' / 'purchase' and the side semantics
// stay consistent across this service.
function _config(kind) {
  if (kind === 'sales') {
    return {
      txType:        'Receipt',
      billType:      'Sales',
      ledgerSubgroupCash: ['Cash-in-Hand', 'Bank Accounts', 'Bank Account', 'Bank OD/CC', 'Bank OD A/c'],
      embeddedSourceType: 'sales_bill_receipt',
    };
  }
  if (kind === 'purchase') {
    return {
      txType:        'Payment',
      billType:      'Purchase',
      ledgerSubgroupCash: ['Cash-in-Hand', 'Bank Accounts', 'Bank Account', 'Bank OD/CC', 'Bank OD A/c'],
      embeddedSourceType: 'purchase_bill_payment',
    };
  }
  throw new Error(`autoReceiptService: unknown kind "${kind}"`);
}

// Auto-receipts use a transaction_number derived from the bill_number
// + the current epoch so a cancel-then-resync cycle on the same bill
// doesn't trip the UNIQUE constraint on transaction_number. The `-AR`
// suffix marks the row's lineage; the lookup keyed on
// (source='auto_from_bill', source_bill_id) is what re-syncs use to
// locate the live row deterministically — NOT the transaction_number.
function _autoTxNumber(billNumber) {
  return `${billNumber}-AR-${Date.now()}`;
}

// Bring the auto-receipt row + allocation into the desired state
// for `bill`. Idempotent. Called from sales/purchase controllers
// AFTER the underlying ledger vouchers have been posted.
async function syncAutoReceiptForBill({ kind, bill, t }) {
  const cfg = _config(kind);

  // The bill model's primary key + party FK depend on side.
  const isSales = kind === 'sales';
  const billId    = isSales ? bill.sales_bill_id  : bill.purchase_bill_id;
  const billNo    = bill.bill_number;
  const billDate  = bill.bill_date;
  const partyId   = isSales ? bill.customer_id    : bill.supplier_id;
  const paid      = r2(bill.paid_amount);

  // Determine whether an auto-receipt SHOULD exist for this bill.
  // No party + no paid amount → nothing to write. System Cash party
  // → handled as a single-voucher cash sale (no receivable to clear).
  let isCashParty = false;
  if (partyId) {
    const [partyRow] = await sequelize.query(
      `SELECT is_system_cash FROM parties WHERE party_id = :pid`,
      { replacements: { pid: partyId }, type: sequelize.QueryTypes.SELECT, transaction: t },
    );
    isCashParty = !!(partyRow && partyRow.is_system_cash);
  }
  const shouldExist = paid > 0 && partyId && !isCashParty;

  // Locate the existing LIVE auto-receipt row, if any. Keyed on
  // (source='auto_from_bill', source_bill_id, transaction_type, NOT
  // cancelled) so re-syncs after an edit find the row deterministically
  // and a soft-cancelled row from a prior cascade doesn't get
  // accidentally re-activated. If a cancelled row exists for the same
  // bill, this lookup misses it and we INSERT a fresh row alongside —
  // the cancelled row stays in the audit trail.
  const existing = await sequelize.query(
    `SELECT transaction_id FROM payments_receipts
      WHERE source = 'auto_from_bill'
        AND source_bill_id = :bid
        AND transaction_type = :tt
        AND is_cancelled = false
      LIMIT 1`,
    { replacements: { bid: billId, tt: cfg.txType }, type: sequelize.QueryTypes.SELECT, transaction: t },
  );
  const existingId = existing[0]?.transaction_id;

  if (!shouldExist) {
    // Bill is cash-side OR fully unpaid OR has no party. If a stale
    // auto-receipt exists from a prior state (e.g. paid 500 → 0 on
    // edit), drop it. The ledger voucher itself was already reversed
    // by the caller. Allocation row CASCADE-deletes with the receipt.
    if (existingId) {
      await sequelize.query(
        `DELETE FROM payments_receipts WHERE transaction_id = :id`,
        { replacements: { id: existingId }, transaction: t },
      );
    }
    return { state: 'absent', transaction_id: null };
  }

  if (existingId) {
    // UPDATE in place — keeps history (created_date) intact while
    // re-syncing date / amount / party / payment_method in case the
    // bill was edited.
    await sequelize.query(
      `UPDATE payments_receipts
          SET transaction_date = :td,
              party_id         = :pid,
              total_amount     = :amt,
              reference_bill_id     = :bid,
              reference_bill_type   = :rbt,
              reference_bill_number = :bn,
              payment_method   = :pm,
              remarks          = :rem,
              modified_date    = NOW()
        WHERE transaction_id = :id`,
      {
        replacements: {
          id: existingId, td: billDate, pid: partyId, amt: paid,
          bid: billId, rbt: cfg.billType, bn: billNo,
          pm: bill.payment_method || null,
          rem: `Auto-generated from ${cfg.billType.toLowerCase()} bill ${billNo}`,
        },
        transaction: t,
      },
    );
    // Re-sync allocation. Single allocation row per auto-receipt
    // (1:1 with the source bill). Replace-in-place to keep the
    // FK clean.
    await sequelize.query(
      `DELETE FROM bill_payment_allocations WHERE transaction_id = :id`,
      { replacements: { id: existingId }, transaction: t },
    );
    await sequelize.query(
      `INSERT INTO bill_payment_allocations
         (transaction_id, bill_type, bill_id, allocated_amount, allocation_method)
       VALUES (:txid, :bt, :bid, :amt, 'auto_from_bill')`,
      {
        replacements: { txid: existingId, bt: cfg.billType, bid: billId, amt: paid },
        transaction: t,
      },
    );
    return { state: 'updated', transaction_id: existingId };
  }

  // INSERT a fresh auto-receipt row + its allocation.
  const [insRow] = await sequelize.query(
    `INSERT INTO payments_receipts
       (transaction_number, transaction_type, transaction_date,
        party_id, reference_bill_id, reference_bill_type, reference_bill_number,
        total_amount, source, source_bill_id, payment_method, remarks,
        is_cancelled, created_date, modified_date)
     VALUES (:tn, :tt, :td, :pid, :bid, :rbt, :bn,
             :amt, 'auto_from_bill', :sbid, :pm, :rem,
             false, NOW(), NOW())
     RETURNING transaction_id`,
    {
      replacements: {
        tn: _autoTxNumber(billNo),
        tt: cfg.txType, td: billDate, pid: partyId,
        bid: billId, rbt: cfg.billType, bn: billNo,
        amt: paid, sbid: billId,
        pm: bill.payment_method || null,
        rem: `Auto-generated from ${cfg.billType.toLowerCase()} bill ${billNo}`,
      },
      transaction: t,
    },
  );
  const transactionId = insRow[0].transaction_id;
  await sequelize.query(
    `INSERT INTO bill_payment_allocations
       (transaction_id, bill_type, bill_id, allocated_amount, allocation_method)
     VALUES (:txid, :bt, :bid, :amt, 'auto_from_bill')`,
    {
      replacements: { txid: transactionId, bt: cfg.billType, bid: billId, amt: paid },
      transaction: t,
    },
  );
  return { state: 'inserted', transaction_id: transactionId };
}

// Mark the auto-receipt for a bill as cancelled. Allocation rows
// are dropped explicitly so the post-cancel SUM(allocations) reads
// as zero (CASCADE on the FK would also drop them if we hard-deleted
// the receipt, but we keep the receipt row for audit trail).
async function reverseAutoReceiptForBill({ kind, billId, t, userId, reason }) {
  const cfg = _config(kind);
  const existing = await sequelize.query(
    `SELECT transaction_id FROM payments_receipts
      WHERE source = 'auto_from_bill'
        AND source_bill_id = :bid
        AND transaction_type = :tt
        AND is_cancelled = false
      LIMIT 1`,
    { replacements: { bid: billId, tt: cfg.txType }, type: sequelize.QueryTypes.SELECT, transaction: t },
  );
  if (!existing[0]) return { state: 'none' };
  const txId = existing[0].transaction_id;
  await sequelize.query(
    `UPDATE payments_receipts
        SET is_cancelled = true,
            cancelled_by = :u,
            cancelled_on = NOW(),
            cancellation_reason = :r,
            modified_date = NOW()
      WHERE transaction_id = :id`,
    { replacements: { id: txId, u: userId || null, r: reason || 'Source bill cancelled' }, transaction: t },
  );
  await sequelize.query(
    `DELETE FROM bill_payment_allocations WHERE transaction_id = :id`,
    { replacements: { id: txId }, transaction: t },
  );
  return { state: 'cancelled', transaction_id: txId };
}

// Lookup — returns the auto-receipt row (or null) for a given bill.
// Used by the bill-detail page's Payments section + the integrity
// invariants endpoint.
async function getAutoReceiptForBill({ kind, billId, t, includeCancelled = false }) {
  const cfg = _config(kind);
  // By default return only the LIVE auto-receipt — bills can have
  // historical cancelled rows from prior cascade cycles, and the
  // typical caller (UI Payments section, integrity check) wants the
  // current state. Pass includeCancelled=true to walk the audit trail.
  const cancelClause = includeCancelled ? '' : 'AND is_cancelled = false';
  const rows = await sequelize.query(
    `SELECT transaction_id, transaction_number, transaction_date,
            total_amount, is_cancelled, party_id, source, source_bill_id
       FROM payments_receipts
      WHERE source = 'auto_from_bill'
        AND source_bill_id = :bid
        AND transaction_type = :tt
        ${cancelClause}
      ORDER BY transaction_id DESC
      LIMIT 1`,
    { replacements: { bid: billId, tt: cfg.txType }, type: sequelize.QueryTypes.SELECT, transaction: t },
  );
  return rows[0] || null;
}

// ── Integrity invariants (I1-I6 from the R8 brief) ───────────────────
//
// Each invariant returns { name, ok, sample[] } so the admin Integrity
// screen can show a green ✓ row or expand to see violating rows.
//
//   I1  paid_amount(bill) == SUM(allocations) for every paid bill
//   I2  amount(receipt)  == SUM(allocations) AND exactly 1 alloc for
//                            every auto-receipt
//   I3  party / date / cancelled cascade matches source bill
//   I4  every auto row has a valid source_bill_id
//   I5  Sundry Debtors ledger == SUM(sales_bills.balance_amount)
//                            for non-cash, non-cancelled credit sales
//   I6  same shape, mirrored on Sundry Creditors / purchase_bills

const r2cmp = (a, b) => Math.abs(r2(a) - r2(b)) < 0.01;

async function checkIntegrity() {
  const out = { invariants: [] };

  // I1 — paid_amount on bill == SUM(allocations.allocated_amount) for every bill with paid > 0.
  for (const kind of ['sales', 'purchase']) {
    const isSales = kind === 'sales';
    const billTbl = isSales ? 'sales_bills'    : 'purchase_bills';
    const billPK  = isSales ? 'sales_bill_id'  : 'purchase_bill_id';
    const billType = isSales ? 'Sales' : 'Purchase';
    const partyFK  = isSales ? 'customer_id' : 'supplier_id';

    const violations = await sequelize.query(
      `SELECT b.${billPK} AS bill_id, b.bill_number, b.paid_amount,
              COALESCE(SUM(a.allocated_amount), 0) AS alloc_sum
         FROM ${billTbl} b
         LEFT JOIN parties p ON p.party_id = b.${partyFK}
         LEFT JOIN bill_payment_allocations a
                ON a.bill_type = :bt AND a.bill_id = b.${billPK}
                AND a.transaction_id IN (SELECT transaction_id FROM payments_receipts
                                          WHERE is_cancelled = false)
        WHERE b.is_cancelled = false
          AND b.paid_amount > 0
          AND b.${partyFK} IS NOT NULL
          AND (p.is_system_cash IS NULL OR p.is_system_cash = false)
        GROUP BY b.${billPK}, b.bill_number, b.paid_amount
        HAVING ABS(b.paid_amount - COALESCE(SUM(a.allocated_amount), 0)) > 0.01
        LIMIT 50`,
      { replacements: { bt: billType }, type: sequelize.QueryTypes.SELECT },
    );
    out.invariants.push({
      id: isSales ? 'I1.sales' : 'I1.purchase',
      name: `I1 ${isSales ? 'Sales' : 'Purchase'}: paid_amount == SUM(allocations)`,
      ok: violations.length === 0,
      violation_count: violations.length,
      sample: violations.slice(0, 10),
    });
  }

  // I2 — auto-receipt amount == SUM(allocations) AND exactly 1 allocation row.
  const i2 = await sequelize.query(
    `SELECT pr.transaction_id, pr.transaction_number, pr.transaction_type,
            pr.total_amount,
            COALESCE(SUM(a.allocated_amount), 0) AS alloc_sum,
            COUNT(a.allocation_id) AS alloc_count
       FROM payments_receipts pr
       LEFT JOIN bill_payment_allocations a ON a.transaction_id = pr.transaction_id
      WHERE pr.source = 'auto_from_bill'
        AND pr.is_cancelled = false
      GROUP BY pr.transaction_id, pr.transaction_number, pr.transaction_type, pr.total_amount
     HAVING ABS(pr.total_amount - COALESCE(SUM(a.allocated_amount), 0)) > 0.01
         OR COUNT(a.allocation_id) <> 1
      LIMIT 50`,
    { type: sequelize.QueryTypes.SELECT },
  );
  out.invariants.push({
    id: 'I2',
    name: 'I2: auto-receipt amount == SUM(allocations) AND exactly 1 alloc',
    ok: i2.length === 0,
    violation_count: i2.length,
    sample: i2.slice(0, 10),
  });

  // I3 — auto-receipt party/date/cancelled mirror source bill.
  for (const kind of ['sales', 'purchase']) {
    const isSales = kind === 'sales';
    const billTbl = isSales ? 'sales_bills'   : 'purchase_bills';
    const billPK  = isSales ? 'sales_bill_id' : 'purchase_bill_id';
    const partyFK = isSales ? 'customer_id'   : 'supplier_id';
    const txType  = isSales ? 'Receipt'       : 'Payment';

    const i3 = await sequelize.query(
      `SELECT pr.transaction_id, pr.transaction_number,
              pr.party_id            AS r_party,
              b.${partyFK}           AS b_party,
              pr.transaction_date    AS r_date,
              b.bill_date            AS b_date,
              pr.is_cancelled        AS r_cancelled,
              b.is_cancelled         AS b_cancelled
         FROM payments_receipts pr
         JOIN ${billTbl} b ON b.${billPK} = pr.source_bill_id
        WHERE pr.source = 'auto_from_bill'
          AND pr.transaction_type = :tt
          AND (
               pr.party_id <> b.${partyFK}
            OR pr.transaction_date <> b.bill_date
            OR pr.is_cancelled <> b.is_cancelled
          )
        LIMIT 50`,
      { replacements: { tt: txType }, type: sequelize.QueryTypes.SELECT },
    );
    out.invariants.push({
      id: isSales ? 'I3.sales' : 'I3.purchase',
      name: `I3 ${isSales ? 'Sales' : 'Purchase'}: receipt mirrors bill (party/date/cancelled)`,
      ok: i3.length === 0,
      violation_count: i3.length,
      sample: i3.slice(0, 10),
    });
  }

  // I4 — every auto row has source_bill_id set + the bill exists.
  const i4 = await sequelize.query(
    `SELECT pr.transaction_id, pr.transaction_number, pr.transaction_type, pr.source_bill_id
       FROM payments_receipts pr
      WHERE pr.source = 'auto_from_bill'
        AND (
             pr.source_bill_id IS NULL
          OR (pr.transaction_type = 'Receipt'
              AND NOT EXISTS (SELECT 1 FROM sales_bills WHERE sales_bill_id = pr.source_bill_id))
          OR (pr.transaction_type = 'Payment'
              AND NOT EXISTS (SELECT 1 FROM purchase_bills WHERE purchase_bill_id = pr.source_bill_id))
        )
      LIMIT 50`,
    { type: sequelize.QueryTypes.SELECT },
  );
  out.invariants.push({
    id: 'I4',
    name: 'I4: every auto-receipt has a valid source_bill_id',
    ok: i4.length === 0,
    violation_count: i4.length,
    sample: i4.slice(0, 10),
  });

  // I5 + I6 — Sundry Debtors / Creditors ledger reconciles via the
  // 6-term invariant the BR + Aging banners already use:
  //
  //   bill_outstanding + paid_in_bills − unallocated_receipts
  //     − returns_offset + opening_dr − opening_cr  ==  ledger_outstanding
  //
  // The original brief framed I5/I6 as a strict
  //   ledger == SUM(bill.balance_amount)
  // — that's only true on a clean install where bills are the SOLE
  // source of debtor/creditor activity. Any DB with opening-balance
  // JVs, returns, or on-account receipts has structural drift between
  // the two sides that isn't a defect to fix; it's data the 6-term
  // invariant accounts for. Mirroring the BR/Aging banner formula
  // here means a green I5/I6 implies a green banner and vice versa.
  // The balanced flag uses ±0.01 tolerance for paisa rounding.
  const asOf = new Date().toISOString().slice(0, 10);
  for (const kind of ['sales', 'purchase']) {
    const isCustomer = kind === 'sales';
    const billTbl  = isCustomer ? 'sales_bills'        : 'purchase_bills';
    const partyFK  = isCustomer ? 'customer_id'        : 'supplier_id';
    const subGroup = isCustomer ? 'Sundry Debtors'     : 'Sundry Creditors';

    // Bill side: outstanding + paid_in_bills, restricted to non-cash
    // parties whose ledger sits in the right sub_group.
    const billSql = isCustomer
      ? `SELECT COALESCE(SUM(b.balance_amount), 0)::float outstanding,
                COALESCE(SUM(b.paid_amount),    0)::float paid_in_bills
           FROM sales_bills b
           JOIN parties p ON p.party_id = b.customer_id
          WHERE b.is_cancelled = false
            AND b.customer_id IS NOT NULL
            AND b.bill_date <= :as_of
            AND (p.is_system_cash IS NULL OR p.is_system_cash = false)`
      : `SELECT COALESCE(SUM(b.balance_amount), 0)::float outstanding,
                COALESCE(SUM(b.paid_amount),    0)::float paid_in_bills
           FROM purchase_bills b
           JOIN parties p ON p.party_id = b.supplier_id
           JOIN ledger_accounts la ON la.ledger_id = p.ledger_account_id
          WHERE b.is_cancelled = false
            AND b.supplier_id IS NOT NULL
            AND la.sub_group = 'Sundry Creditors'
            AND b.bill_date <= :as_of
            AND (p.is_system_cash IS NULL OR p.is_system_cash = false)`;
    const [billRow] = await sequelize.query(billSql,
      { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT });

    // Returns offset, on-account receipts, opening JV pair, ledger net
    // — same queries as billsOutstandingController._reconcile and
    // reportController._agingReconciliation.
    const [returnsRow] = await sequelize.query(
      isCustomer
        ? `SELECT COALESCE(SUM(le.credit_amount), 0)::float v FROM ledger_entries le
             JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
            WHERE la.sub_group = 'Sundry Debtors' AND le.source_type = 'sales_return_bill'
              AND le.reversal_of_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
              AND le.entry_date <= :as_of`
        : `SELECT COALESCE(SUM(le.debit_amount), 0)::float v FROM ledger_entries le
             JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
            WHERE la.sub_group = 'Sundry Creditors' AND le.source_type = 'purchase_return_bill'
              AND le.reversal_of_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
              AND le.entry_date <= :as_of`,
      { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT });

    const [unallocRow] = await sequelize.query(
      isCustomer
        ? `SELECT COALESCE(SUM(le.credit_amount), 0)::float v FROM ledger_entries le
             JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
            WHERE la.sub_group = 'Sundry Debtors'
              AND le.source_type IN ('payment_receipt', 'sales_bill_receipt')
              AND le.reversal_of_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
              AND le.entry_date <= :as_of`
        : `SELECT COALESCE(SUM(le.debit_amount), 0)::float v FROM ledger_entries le
             JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
            WHERE la.sub_group = 'Sundry Creditors'
              AND le.source_type IN ('payment_receipt', 'purchase_bill_payment')
              AND le.reversal_of_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
              AND le.entry_date <= :as_of`,
      { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT });

    const [openingRow] = await sequelize.query(
      `SELECT COALESCE(SUM(le.debit_amount), 0)::float opening_dr,
              COALESCE(SUM(le.credit_amount), 0)::float opening_cr
         FROM ledger_entries le
         JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
        WHERE la.sub_group = :sg
          AND le.source_type = 'party_opening'
          AND le.reversal_of_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
          AND le.entry_date <= :as_of`,
      { replacements: { sg: subGroup, as_of: asOf }, type: sequelize.QueryTypes.SELECT });

    const [ledgerRow] = await sequelize.query(
      `SELECT COALESCE(SUM(le.debit_amount - le.credit_amount), 0)::float v
         FROM ledger_entries le
         JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
        WHERE la.sub_group = :sg
          AND le.reversal_of_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
          AND le.entry_date <= :as_of`,
      { replacements: { sg: subGroup, as_of: asOf }, type: sequelize.QueryTypes.SELECT });

    const billOut    = r2(billRow.outstanding);
    const paidInBill = r2(billRow.paid_in_bills);
    const unalloc    = r2(unallocRow.v);
    const returns    = r2(returnsRow.v);
    const openingDr  = r2(isCustomer ? openingRow.opening_dr : openingRow.opening_cr);
    const openingCr  = r2(isCustomer ? openingRow.opening_cr : openingRow.opening_dr);
    const ledgerNet  = r2(isCustomer ? ledgerRow.v : -ledgerRow.v);
    const expected   = r2(billOut + paidInBill - unalloc - returns + openingDr - openingCr);
    const diff       = r2(ledgerNet - expected);

    out.invariants.push({
      id: isCustomer ? 'I5' : 'I6',
      name: `${isCustomer ? 'I5' : 'I6'} ${subGroup} 6-term ledger reconciliation`,
      ok: Math.abs(diff) < 0.01,
      bill_outstanding: billOut,
      paid_in_bills:    paidInBill,
      unallocated_receipts: unalloc,
      returns_offset:   returns,
      opening_dr:       openingDr,
      opening_cr:       openingCr,
      expected_ledger:  expected,
      ledger_outstanding: ledgerNet,
      difference:       diff,
      sample: Math.abs(diff) < 0.01 ? [] : [{ note: `expected=${expected} ledger=${ledgerNet} diff=${diff}` }],
    });
  }

  // I7 — for every batch-tracked product, the sum of per-batch on-hand
  // across all godowns equals products.current_stock. Catches a
  // batch-stock ↔ godown-stock ↔ product-stock chain drift after any
  // batched sale / sales-return / purchase-return write path. Only
  // batch-tracked products are checked; non-batched products legitimately
  // have zero rows in product_batch_stock.
  //
  // Tolerance ±0.001 — three-decimal columns (pharma / food precision).
  // A drift ≥ that surfaces as a violation with the per-product breakdown
  // in `sample` so the integrity screen can pinpoint which batch chain
  // diverged.
  const i7 = await sequelize.query(
    `WITH batch_sum AS (
       SELECT pbs.product_id,
              SUM(pbs.current_stock)::float AS batch_total
         FROM product_batch_stock pbs
        GROUP BY pbs.product_id
     )
     SELECT p.product_id, p.product_name,
            COALESCE(p.current_stock, 0)::float        AS product_stock,
            COALESCE(bs.batch_total, 0)::float          AS batch_total,
            COALESCE(p.current_stock, 0)::float
              - COALESCE(bs.batch_total, 0)::float      AS drift
       FROM products p
       LEFT JOIN batch_sum bs ON bs.product_id = p.product_id
      WHERE p.is_batch_tracked = true
        AND p.is_active = true
        AND ABS(COALESCE(p.current_stock, 0) - COALESCE(bs.batch_total, 0)) > 0.001
      LIMIT 50`,
    { type: sequelize.QueryTypes.SELECT },
  );
  out.invariants.push({
    id: 'I7',
    name: 'I7: SUM(batch_stock) == products.current_stock for every batch-tracked product',
    ok: i7.length === 0,
    violation_count: i7.length,
    sample: i7.slice(0, 10),
  });

  // I8 — for every batch-tracked product, the sum of per-batch on-hand
  // (across all godowns) equals the net of batch-tagged ledger movements
  // for that product. Catches drift between the per-batch table and the
  // ledger truth specifically: if a sale / purchase / transfer wrote to
  // stock_ledger with batch_id but failed to call applyBatchStockDelta
  // (or the other way around), I8 surfaces the gap. I7 guarantees the
  // batch table stays in step with the godown total; I8 guarantees the
  // batch table stays in step with the ledger.
  //
  // Why batch-tagged ledger rows only: non-batch products have no
  // batch_id rows in product_batch_stock, so summing all ledger rows
  // would over-count for them. Restricting to batch_id IS NOT NULL
  // gives an apples-to-apples comparison.
  //
  // Tolerance ±0.001 — three-decimal precision on both sides.
  const i8 = await sequelize.query(
    `WITH batch_sum AS (
       SELECT pbs.product_id,
              SUM(pbs.current_stock)::float AS batch_total
         FROM product_batch_stock pbs
        GROUP BY pbs.product_id
     ),
     ledger_sum AS (
       SELECT sl.product_id,
              SUM(COALESCE(sl.quantity_in, 0) - COALESCE(sl.quantity_out, 0))::float AS ledger_net
         FROM stock_ledger sl
        WHERE sl.batch_id IS NOT NULL
        GROUP BY sl.product_id
     )
     SELECT p.product_id, p.product_name,
            COALESCE(bs.batch_total, 0)::float  AS batch_total,
            COALESCE(ls.ledger_net, 0)::float   AS ledger_net,
            COALESCE(bs.batch_total, 0)::float
              - COALESCE(ls.ledger_net, 0)::float AS drift
       FROM products p
       LEFT JOIN batch_sum  bs ON bs.product_id = p.product_id
       LEFT JOIN ledger_sum ls ON ls.product_id = p.product_id
      WHERE p.is_batch_tracked = true
        AND p.is_active = true
        AND ABS(COALESCE(bs.batch_total, 0) - COALESCE(ls.ledger_net, 0)) > 0.001
      LIMIT 50`,
    { type: sequelize.QueryTypes.SELECT },
  );
  out.invariants.push({
    id: 'I8',
    name: 'I8: SUM(batch_stock) == SUM(stock_ledger batch movements) per batch-tracked product',
    ok: i8.length === 0,
    violation_count: i8.length,
    sample: i8.slice(0, 10),
  });

  out.all_pass = out.invariants.every((i) => i.ok);
  return out;
}

module.exports = {
  syncAutoReceiptForBill,
  reverseAutoReceiptForBill,
  getAutoReceiptForBill,
  checkIntegrity,
};
