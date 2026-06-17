/*
 * Aging math — pure functions, kept standalone so they can be exhaustively
 * unit-tested without a DB or HTTP layer. The aggregation in
 * reportController.agingReport calls into these.
 *
 * Conventions:
 *   - All dates are handled as YYYY-MM-DD strings. Callers normalize first.
 *   - All amounts are plain numbers (float). Callers convert DECIMAL to Number.
 *   - Bucket ranges follow SystemSettings.aging_bucket_1/2/3_days which
 *     default to 30/60/90. We treat the first bucket as INCLUSIVE of the
 *     boundary day: if b1=30 then overdueDays=30 is still "1–30", and 31
 *     is where "31–60" starts. This matches the standard aging report.
 *
 * Bucket layout:
 *   overdueDays  bucket key   label (for b1=30, b2=60, b3=90)
 *   ──────────   ──────────   ─────────────────────────────────
 *        0       current      Not Due
 *     1 – b1     b1           1–30
 *  b1+1 – b2     b2           31–60
 *  b2+1 – b3     b3           61–90
 *   > b3         b4           90+
 */

'use strict';

const dayjs = require('dayjs');

/**
 * Days a bill is overdue as of a reference date.
 *
 * Due date priority (first truthy wins):
 *   1. Explicit `dueDate` on the bill row
 *   2. `billDate + creditDays` (from the party's credit_days)
 *   3. `billDate` itself (when creditDays is 0 or undefined)
 *
 * Returns 0 when the reference date is before or equal to the effective
 * due date — i.e. the bill is current, not overdue.
 *
 * @param {string} asOfDate  - YYYY-MM-DD
 * @param {string} billDate  - YYYY-MM-DD
 * @param {string|null} dueDate  - YYYY-MM-DD or nullish
 * @param {number} creditDays - integer, 0 when unknown
 * @returns {number} non-negative integer number of days overdue
 */
function computeOverdueDays(asOfDate, billDate, dueDate, creditDays) {
  const asOf = dayjs(asOfDate);
  const effective = dueDate
    ? dayjs(dueDate)
    : dayjs(billDate).add(Number(creditDays) || 0, 'day');
  const diff = asOf.diff(effective, 'day');
  return diff > 0 ? diff : 0;
}

/**
 * Classify `overdueDays` into a bucket key.
 *
 * @param {number} overdueDays
 * @param {{b1:number,b2:number,b3:number}} bounds
 * @returns {'current'|'b1'|'b2'|'b3'|'b4'}
 */
function bucketFor(overdueDays, bounds) {
  const n = Number(overdueDays) || 0;
  const b1 = Number(bounds.b1);
  const b2 = Number(bounds.b2);
  const b3 = Number(bounds.b3);
  if (n <= 0)   return 'current';
  if (n <= b1)  return 'b1';
  if (n <= b2)  return 'b2';
  if (n <= b3)  return 'b3';
  return 'b4';
}

/**
 * Human-readable labels for the five buckets given the configured bounds.
 * Pure presentation — used by both backend export and frontend rendering
 * so they always agree.
 */
function bucketLabels(bounds) {
  const { b1, b2, b3 } = bounds;
  // Bucket b4 covers > b3 (i.e. b3+1 and above) — label was previously
  // "${b3}+" which is off-by-one. With b3=90 the label said "90+" but
  // a 90-day-overdue bill is actually in b3, not b4. (audit L1)
  return {
    current: 'Not Due',
    b1: `1–${b1}`,
    b2: `${b1 + 1}–${b2}`,
    b3: `${b2 + 1}–${b3}`,
    b4: `${b3 + 1}+`,
  };
}

/**
 * Round to 2 decimals, half-away-from-zero. We re-use the banker-safe
 * trick: nudge by 1e-10 so repeated addition doesn't drop a paisa.
 */
function round2(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(v) * 100 + 1e-10) / 100;
}

/**
 * Build the aging aggregate from raw bill rows.
 *
 * Inputs:
 *   bills - [{ bill_id, bill_number, bill_date, due_date, total_amount,
 *              paid_amount, balance_amount,
 *              party: { party_id, party_name, mobile_1, city, state, credit_days } }]
 *   asOfDate - YYYY-MM-DD
 *   bounds   - { b1, b2, b3 }  (integer days)
 *
 * Output:
 *   {
 *     as_of_date, buckets, bucket_labels,
 *     rows:  [{ party_id, party_name, mobile_1, city, state, credit_days,
 *               total, current, b1, b2, b3, b4, oldest_days, bill_count,
 *               bills: [...] }],
 *     grand: { total, current, b1, b2, b3, b4 }
 *   }
 *
 * The function is PURE — no I/O, no DB calls. The caller loads bills and
 * normalizes field names; this just does math and grouping.
 */
function aggregateAging(bills, asOfDate, bounds) {
  if (!Array.isArray(bills)) throw new TypeError('bills must be an array');
  if (typeof asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new TypeError('asOfDate must be YYYY-MM-DD');
  }
  const b1 = Number(bounds.b1);
  const b2 = Number(bounds.b2);
  const b3 = Number(bounds.b3);
  if (!(b1 > 0 && b2 > b1 && b3 > b2)) {
    throw new RangeError('bucket bounds must satisfy 0 < b1 < b2 < b3');
  }

  const byParty = new Map();
  for (const bill of bills) {
    const party = bill.party;
    if (!party || party.party_id == null) continue;
    const bal = Number(bill.balance_amount) || 0;
    if (bal <= 0) continue;   // skip fully-paid rows

    // On-account / opening items aren't invoice-dated — they go to a
    // dedicated `on_account` column instead of a day-bucket. This is the
    // standard bill-wise presentation: un-referenced opening balances and
    // unallocated receipts show as "on account", while actual invoices age
    // by their own date. The per-party total (and grand total) still equals
    // the ledger balance — on_account is just another column of it.
    const isOnAccount = bill.is_onaccount === true;
    const overdueDays = isOnAccount ? 0 : computeOverdueDays(
      asOfDate,
      bill.bill_date,
      bill.due_date,
      party.credit_days
    );
    const key = isOnAccount ? 'on_account' : bucketFor(overdueDays, { b1, b2, b3 });

    let row = byParty.get(party.party_id);
    if (!row) {
      row = {
        party_id: party.party_id,
        party_name: party.party_name || '',
        mobile_1: party.mobile_1 || '',
        city: party.city || '',
        state: party.state || '',
        credit_days: Number(party.credit_days) || 0,
        credit_limit: Number(party.credit_limit) || 0,
        total: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0, on_account: 0,
        oldest_days: 0,
        bill_count: 0,
        bills: [],
      };
      byParty.set(party.party_id, row);
    }

    row.total      += bal;
    row[key]       += bal;
    row.bill_count += 1;
    if (overdueDays > row.oldest_days) row.oldest_days = overdueDays;
    row.bills.push({
      bill_id: bill.bill_id,
      bill_number: bill.bill_number,
      bill_date: bill.bill_date,
      due_date: bill.due_date || null,
      total_amount: round2(bill.total_amount),
      paid_amount: round2(bill.paid_amount),
      balance_amount: round2(bal),
      overdue_days: overdueDays,
      bucket: key,
    });
  }

  const rows = Array.from(byParty.values());
  // Round each row's accumulators once, at the end, to avoid drift from
  // summing already-rounded values.
  for (const r of rows) {
    r.total   = round2(r.total);
    r.current = round2(r.current);
    r.b1      = round2(r.b1);
    r.b2      = round2(r.b2);
    r.b3      = round2(r.b3);
    r.b4      = round2(r.b4);
    r.on_account = round2(r.on_account);
    // Order each party's bills by bill_date ascending, so the drill-down
    // reads top-down from oldest to newest.
    r.bills.sort((a, b) => a.bill_date.localeCompare(b.bill_date));
  }
  rows.sort((a, b) => b.total - a.total);

  const grand = rows.reduce(
    (g, r) => ({
      total:      g.total      + r.total,
      current:    g.current    + r.current,
      b1:         g.b1         + r.b1,
      b2:         g.b2         + r.b2,
      b3:         g.b3         + r.b3,
      b4:         g.b4         + r.b4,
      on_account: g.on_account + r.on_account,
    }),
    { total: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0, on_account: 0 }
  );
  for (const k of Object.keys(grand)) grand[k] = round2(grand[k]);

  return {
    as_of_date: asOfDate,
    buckets: { b1, b2, b3 },
    bucket_labels: { ...bucketLabels({ b1, b2, b3 }), on_account: 'On A/c' },
    rows,
    grand,
  };
}

/**
 * FIFO-distribute a party's true open balance across its dated charges so
 * the aging report's per-party total equals the Customer-Ledger balance
 * (instead of the gross sum of unpaid bills). Compute-only — no data is
 * mutated; this just decides, for display, WHICH charges are still open
 * and by how much.
 *
 * Why: on this dataset many receipts are recorded on-account (not tagged
 * to a bill), and opening balances aren't bills at all. So Σ(bill
 * balance_amount) ≠ the party's real balance. `current_balance` (and the
 * Sundry Debtors ledger) IS correct. We take that as the truth and lay it
 * back over the charge timeline oldest-first: credits pay off the oldest
 * charges, whatever remains (newest-first) is what's still open and gets
 * aged by its own date.
 *
 * @param {{date:string, amount:number, meta?:object}[]} charges
 *        Dated debit events (opening balance, then each bill total−return),
 *        in ANY order — sorted oldest-first internally.
 * @param {number} openBalance  The authoritative open balance to reproduce
 *        (party.current_balance, clamped ≥ 0).
 * @returns {{date:string, amount:number, meta?:object}[]}  charges with
 *        `amount` reduced to the still-open portion, dropping fully-paid
 *        ones, sorted oldest-first. Σ(amount) === round2(openBalance).
 *        If openBalance exceeds Σcharges (advance/data quirk), the excess
 *        is attached to the oldest charge so the total still reconciles.
 */
function distributeOpenBalanceFifo(charges, openBalance) {
  const target = Math.max(0, round2(openBalance));
  const sorted = [...charges].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const totalCharges = round2(sorted.reduce((s, c) => s + (Number(c.amount) || 0), 0));

  // Credits (payments) applied oldest-first. Never negative; capped so we
  // can't "pay" more than the charges on the books.
  let credits = round2(totalCharges - target);
  if (credits < 0) credits = 0;
  if (credits > totalCharges) credits = totalCharges;

  const out = [];
  for (const c of sorted) {
    const amt = round2(Number(c.amount) || 0);
    if (credits >= amt) { credits = round2(credits - amt); continue; } // fully paid
    const open = round2(amt - credits);
    credits = 0;
    if (open > 0.005) out.push({ ...c, amount: open });
  }

  // openBalance > Σcharges → unbilled advance/credit or a recalc quirk.
  // Park the remainder on the oldest charge (or a synthetic opening) so
  // the per-party total still equals current_balance to the paisa.
  const placed = round2(out.reduce((s, c) => s + c.amount, 0));
  const residual = round2(target - placed);
  if (residual > 0.005) {
    if (out.length) out[0] = { ...out[0], amount: round2(out[0].amount + residual) };
    else if (sorted.length) out.push({ ...sorted[0], amount: residual });
  }
  return out;
}

module.exports = {
  computeOverdueDays,
  bucketFor,
  bucketLabels,
  aggregateAging,
  distributeOpenBalanceFifo,
  round2,
};
