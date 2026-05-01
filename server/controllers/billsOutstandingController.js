// ── Bills Outstanding Controller ──────────────────────────────────────
//
// Two endpoints — bill-LEVEL outstanding lists (cf. the existing party-
// level Aging Report). Both share one implementation parameterised by
// partyType ('Customer' | 'Supplier'):
//
//   GET /api/reports/bills-receivable   →  unpaid sales bills
//   GET /api/reports/bills-payable      →  unpaid purchase bills
//
// Pagination: page/limit (matches the useVirtualizedReport hook
// contract — chunks of `limit` rows pulled lazily as the user scrolls).
//
// Filters (URL query params):
//   as_of           YYYY-MM-DD    snapshot date, default today
//   party_ids       int[]         multi-select party filter
//   buckets         enum[]        multi-select bucket chips
//                                 ('current'|'b1'|'b2'|'b3'|'b4')
//   min_amount      number        outstanding floor
//   max_amount      number        outstanding ceiling
//   cities          string[]      multi-select party city filter
//   states          string[]      multi-select party state filter
//   credit          'over'|'within'|'none'   credit-limit gate
//   salesperson_ids int[]         filter by users.user_id (sales side)
//   min_overdue     number        overdue-days floor
//   max_overdue     number        overdue-days ceiling
//   bill_from       YYYY-MM-DD    bill-date floor (NOT as_of)
//   bill_to         YYYY-MM-DD    bill-date ceiling
//   has_notes       'true'|'false'  remarks present?
//   show_zero       'true'|'false'  include settled bills (default false)
//   search          string        free-text on bill_no/party_name/remarks
//   group_by        'none'|'party'|'bucket'|'city'   (server-side grouping
//                                 affects sort order; render is frontend's
//                                 problem — controller still ships flat rows)
//   sort            string        column key
//   dir             'asc'|'desc'  default 'desc'
//   page            int           1-based
//   limit           int           default 200, max 500
//
// Response shape:
//   {
//     data: BillRow[],
//     total:        int,           full filtered count (NOT page count)
//     page, limit,                 echoed back
//     summary: {
//       total_outstanding, bill_count, party_count,
//       overdue_amount, avg_days_overdue, oldest_days,
//     },
//     reconciliation: {
//       sub_group, bill_outstanding, paid_in_bills,
//       unallocated_receipts, returns_offset,
//       opening_dr, opening_cr,
//       expected_ledger_outstanding, ledger_outstanding,
//       difference, balanced,
//     },
//     filter_meta: { distinct_cities, distinct_states },
//     bucket_labels: { current, b1, b2, b3, b4 },
//     allocation_complete: bool,        // unallocated_count === 0
//     unallocated_count: int            // number of manual receipts/payments
//                                       // not yet FIFO-allocated; banner
//                                       // hides at 0.
//   }
//
// Reconciliation: reuses the 6-term invariant from reportController
// (_agingReconciliation). Bills Receivable total reconciles to Sundry
// Debtors on TB; Bills Payable to Sundry Creditors. Exposed in the
// reconciliation block for the UI banner.

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { SystemSettings } = require('../models');
const ExcelJS = require('exceljs');
const dayjs = require('dayjs');
const { computeOverdueDays, bucketFor, bucketLabels } = require('../utils/aging');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Local YYYY-MM-DD in server tz. Same idiom reportController uses —
// avoids the UTC-vs-IST off-by-one bug at evening boundaries.
function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Pull aging-bucket bounds from system settings (mirrors Aging Report).
async function _agingBounds() {
  const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
  return {
    b1: parseInt(settings?.aging_bucket_1_days ?? 30, 10),
    b2: parseInt(settings?.aging_bucket_2_days ?? 60, 10),
    b3: parseInt(settings?.aging_bucket_3_days ?? 90, 10),
  };
}

// Coerce a query param to a typed array. Accepts:
//   - undefined / null / ''  → []
//   - 'a,b,c'               → ['a','b','c']
//   - ['a','b','c']         → as-is
// Used for every multi-select query param so the URL form `?party_ids=1,2,3`
// (one round-trip via SearchParams.toString) and Antd's array form both
// resolve to the same JS array.
function toArr(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.filter((x) => x !== '' && x != null);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// Whitelist of sortable columns. The user can pick any of these via
// `?sort=…`; anything else falls back to outstanding desc. Whitelisting
// is required because the value is interpolated into the SQL ORDER BY —
// query params are untrusted input. Column names match the bill_rows
// CTE output (no table-prefix; the outer SELECT runs over the CTE).
const SORTABLE_COLS = {
  bill_no:      'bill_number',
  bill_date:    'bill_date',
  due_date:     'effective_due_date',
  party_name:   'party_name',
  bill_amount:  'total_amount',
  paid_amount:  'paid_amount',
  outstanding:  'effective_outstanding',
  overdue:      'overdue_days',
};

// Bucket → SQL fragment for filtering. We compute overdue_days inline
// in a CTE (so we can sort/filter on it) and the bucket map below
// classifies on the result. Bounds are interpolated, not parameterised,
// because they're integers from a controlled config (SystemSettings).
function bucketWhereSql(bucketKeys, b1, b2, b3) {
  const parts = [];
  for (const k of bucketKeys) {
    if (k === 'current') parts.push(`overdue_days <= 0`);
    else if (k === 'b1') parts.push(`overdue_days BETWEEN 1 AND ${b1}`);
    else if (k === 'b2') parts.push(`overdue_days BETWEEN ${b1 + 1} AND ${b2}`);
    else if (k === 'b3') parts.push(`overdue_days BETWEEN ${b2 + 1} AND ${b3}`);
    else if (k === 'b4') parts.push(`overdue_days > ${b3}`);
  }
  return parts.length ? `(${parts.join(' OR ')})` : null;
}

// ── Main implementation (shared by both endpoints) ────────────────────
//
// partyType: 'Customer' (Bills Receivable) | 'Supplier' (Bills Payable)
async function _billsList(req, partyType) {
  const isCustomer = partyType === 'Customer';
  const billTable = isCustomer ? 'sales_bills' : 'purchase_bills';
  const billPK    = isCustomer ? 'sales_bill_id' : 'purchase_bill_id';
  const partyFK   = isCustomer ? 'customer_id' : 'supplier_id';
  const subGroup  = isCustomer ? 'Sundry Debtors' : 'Sundry Creditors';

  const q = req.query || {};
  const asOf       = (q.as_of && /^\d{4}-\d{2}-\d{2}$/.test(q.as_of))
    ? q.as_of : localDateString();
  const partyIds   = toArr(q.party_ids).map((s) => parseInt(s, 10)).filter(Number.isFinite);
  const buckets    = toArr(q.buckets);
  const cities     = toArr(q.cities);
  const states     = toArr(q.states);
  const minAmount  = q.min_amount != null && q.min_amount !== '' ? Number(q.min_amount) : null;
  const maxAmount  = q.max_amount != null && q.max_amount !== '' ? Number(q.max_amount) : null;
  const credit     = q.credit;     // 'over' | 'within' | 'none'
  const salespersons = toArr(q.salesperson_ids).map((s) => parseInt(s, 10)).filter(Number.isFinite);
  const minOverdue = q.min_overdue != null && q.min_overdue !== '' ? Number(q.min_overdue) : null;
  const maxOverdue = q.max_overdue != null && q.max_overdue !== '' ? Number(q.max_overdue) : null;
  const billFrom   = (q.bill_from && /^\d{4}-\d{2}-\d{2}$/.test(q.bill_from)) ? q.bill_from : null;
  const billTo     = (q.bill_to   && /^\d{4}-\d{2}-\d{2}$/.test(q.bill_to))   ? q.bill_to   : null;
  const hasNotes   = q.has_notes === 'true' ? true : (q.has_notes === 'false' ? false : null);
  const showZero   = q.show_zero === 'true';
  const search     = q.search ? String(q.search).trim() : '';
  const groupBy    = ['party', 'bucket', 'city'].includes(q.group_by) ? q.group_by : 'none';
  const sortKey    = SORTABLE_COLS[q.sort] ? q.sort : 'outstanding';
  const sortCol    = SORTABLE_COLS[sortKey];
  const dir        = q.dir === 'asc' ? 'ASC' : 'DESC';
  const page       = Math.max(1, parseInt(q.page, 10) || 1);
  const limit      = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 200));
  const offset     = (page - 1) * limit;

  const bounds = await _agingBounds();
  const labels = bucketLabels(bounds);

  // Build the WHERE clause. Every condition is parameterised — only the
  // sort column + bucket-bound integers are interpolated, both of which
  // come from controlled whitelists (SORTABLE_COLS, bounds from settings).
  const where = [
    `b.is_cancelled = false`,
    `b.${partyFK} IS NOT NULL`,
    `b.bill_date <= :as_of`,
  ];
  const params = { as_of: asOf, limit, offset };

  // Outstanding-side filters (showZero / min / max / credit limit) move
  // to the outer SELECT so they reference `effective_outstanding` —
  // which prefers SUM(bill_payment_allocations.allocated_amount) over
  // the raw `balance_amount` proxy. Inner WHERE keeps only bill-table-
  // and party-table-side conditions.
  if (partyIds.length) {
    where.push(`b.${partyFK} IN (:party_ids)`);
    params.party_ids = partyIds;
  }
  if (cities.length) {
    where.push(`p.city IN (:cities)`);
    params.cities = cities;
  }
  if (states.length) {
    where.push(`p.state IN (:states)`);
    params.states = states;
  }
  if (credit === 'none') {
    where.push(`(p.credit_limit IS NULL OR p.credit_limit = 0)`);
  }
  if (isCustomer && salespersons.length) {
    where.push(`b.sales_person IN (:salesperson_ids)`);
    params.salesperson_ids = salespersons;
  }
  if (billFrom) {
    where.push(`b.bill_date >= :bill_from`);
    params.bill_from = billFrom;
  }
  if (billTo) {
    where.push(`b.bill_date <= :bill_to`);
    params.bill_to = billTo;
  }
  if (hasNotes === true)  where.push(`b.remarks IS NOT NULL AND b.remarks <> ''`);
  if (hasNotes === false) where.push(`(b.remarks IS NULL OR b.remarks = '')`);
  if (search) {
    where.push(`(b.bill_number ILIKE :search OR p.party_name ILIKE :search OR b.remarks ILIKE :search)`);
    params.search = `%${search}%`;
  }
  // Skip the canonical "Cash" system party — those bills are settled
  // at point-of-sale by definition, never receivable/payable.
  where.push(`(p.is_system_cash IS NULL OR p.is_system_cash = false)`);

  const whereSql = where.join(' AND ');

  // Bucket filter is applied AFTER overdue_days is computed in the CTE
  // (we can't reference it in the bill-table WHERE). We compose the
  // outer SELECT with the bucket SQL injected as a HAVING-ish filter.
  const bucketSql = buckets.length ? bucketWhereSql(buckets, bounds.b1, bounds.b2, bounds.b3) : null;

  // Overdue range filter — same constraint as bucket, applied on the
  // computed column.
  const overdueRangeSql = (() => {
    const parts = [];
    if (minOverdue != null) parts.push(`overdue_days >= ${Math.floor(minOverdue)}`);
    if (maxOverdue != null) parts.push(`overdue_days <= ${Math.ceil(maxOverdue)}`);
    return parts.length ? parts.join(' AND ') : null;
  })();

  // Outstanding-amount filters — applied on the CTE column so they
  // honor allocation-aware values (after R8 backfill these match
  // balance_amount; once FIFO is wired they may diverge for bills with
  // partial manual allocations).
  const outstandingFilters = [];
  if (!showZero)              outstandingFilters.push(`effective_outstanding > 0`);
  if (minAmount != null) {
    outstandingFilters.push(`effective_outstanding >= :min_amount`);
    params.min_amount = minAmount;
  }
  if (maxAmount != null) {
    outstandingFilters.push(`effective_outstanding <= :max_amount`);
    params.max_amount = maxAmount;
  }
  if (credit === 'over') {
    outstandingFilters.push(`party_credit_limit > 0 AND effective_outstanding > party_credit_limit`);
  } else if (credit === 'within') {
    outstandingFilters.push(`party_credit_limit > 0 AND effective_outstanding <= party_credit_limit`);
  }

  const computedFilters = [bucketSql, overdueRangeSql, ...outstandingFilters].filter(Boolean).join(' AND ');
  const havingSql = computedFilters ? `WHERE ${computedFilters}` : '';

  // The CTE has every column the page might want; the outer SELECT
  // applies bucket/overdue filters and pagination. Total count uses the
  // same CTE with a different outer SELECT.
  //
  // effective_due_date math:
  //   COALESCE(due_date, bill_date + party.credit_days)
  // overdue_days:
  //   GREATEST(0, as_of - effective_due_date)
  // alloc_total:
  //   SUM of bill_payment_allocations rows pointing at this bill via
  //   live (non-cancelled) payments_receipts. NULL when no allocations
  //   exist (legacy / not-yet-FIFO bills).
  // effective_outstanding:
  //   total_amount − alloc_total when allocations exist; balance_amount
  //   otherwise. After R8 backfill, alloc_total == paid_amount on every
  //   in-scope paid bill, so the two paths agree numerically. The new
  //   column moves the source-of-truth from the bill's stored proxy to
  //   the actual allocation table — once FIFO Receipt→Bill is fully
  //   wired, the fallback is the only path that still uses the proxy.
  const allocBillType = isCustomer ? 'Sales' : 'Purchase';
  const cteSql = `
    WITH bill_rows AS (
      SELECT
        b.${billPK}              AS bill_id,
        b.bill_number,
        b.bill_date,
        b.due_date,
        b.total_amount,
        b.paid_amount,
        b.balance_amount,
        ${isCustomer ? 'b.payment_status' : "NULL::text"}      AS payment_status,
        ${isCustomer ? 'b.payment_method' : "NULL::text"}      AS payment_method,
        b.remarks,
        b.created_by,
        ${isCustomer ? 'b.sales_person' : 'NULL::int'}        AS sales_person,
        ${isCustomer ? 'b.salesman_name' : 'NULL::text'}       AS salesman_name,
        p.party_id,
        p.party_name,
        p.mobile_1                AS party_mobile,
        p.gstin                   AS party_gstin,
        p.city                    AS party_city,
        p.state                   AS party_state,
        p.credit_days             AS party_credit_days,
        p.credit_limit            AS party_credit_limit,
        u.full_name               AS created_by_name,
        ${isCustomer ? 'sp.full_name' : 'NULL::text'}          AS salesperson_name,
        COALESCE(b.due_date, (b.bill_date + (COALESCE(p.credit_days, 0) || ' days')::interval)::date) AS effective_due_date,
        GREATEST(0, (DATE :as_of - COALESCE(b.due_date, (b.bill_date + (COALESCE(p.credit_days, 0) || ' days')::interval)::date))) AS overdue_days,
        bpa_sum.alloc_total,
        CASE
          WHEN bpa_sum.alloc_total IS NOT NULL
            THEN GREATEST(0, b.total_amount - bpa_sum.alloc_total)
          ELSE b.balance_amount
        END                       AS effective_outstanding,
        (bpa_sum.alloc_total IS NOT NULL) AS has_allocation
      FROM ${billTable} b
      JOIN parties p   ON p.party_id = b.${partyFK}
      LEFT JOIN users u  ON u.user_id  = b.created_by
      ${isCustomer ? 'LEFT JOIN users sp ON sp.user_id = b.sales_person' : ''}
      LEFT JOIN LATERAL (
        SELECT SUM(bpa.allocated_amount)::float AS alloc_total
          FROM bill_payment_allocations bpa
          JOIN payments_receipts pr ON pr.transaction_id = bpa.transaction_id
         WHERE bpa.bill_type = '${allocBillType}'
           AND bpa.bill_id   = b.${billPK}
           AND pr.is_cancelled = false
      ) bpa_sum ON true
      WHERE ${whereSql}
    )
  `;

  const orderBy = (() => {
    // group_by changes ORDER BY so the rows arrive grouped — frontend
    // just walks them and inserts section headers when the group key
    // flips. Within a group we keep the user's chosen sort.
    const within = `${sortCol} ${dir}, bill_id ${dir}`;
    if (groupBy === 'party')  return `party_name ASC, ${within}`;
    if (groupBy === 'bucket') return `overdue_days DESC, ${within}`;
    if (groupBy === 'city')   return `COALESCE(party_city, '') ASC, ${within}`;
    return within;
  })();

  // Page query.
  const dataRows = await sequelize.query(
    `${cteSql}
     SELECT * FROM bill_rows
     ${havingSql}
     ORDER BY ${orderBy}
     LIMIT :limit OFFSET :offset`,
    { replacements: params, type: sequelize.QueryTypes.SELECT },
  );

  // Total count (same filter set, no pagination).
  const [{ total }] = await sequelize.query(
    `${cteSql}
     SELECT COUNT(*)::int AS total FROM bill_rows
     ${havingSql}`,
    { replacements: params, type: sequelize.QueryTypes.SELECT },
  );

  // Aggregates over the FULL filtered set (not the page). Used for KPI
  // tiles and the totals row in the virtual table. Uses
  // `effective_outstanding` so KPI totals match the per-row column the
  // user sees.
  const [agg] = await sequelize.query(
    `${cteSql}
     SELECT
       COALESCE(SUM(effective_outstanding), 0)::float                                      AS total_outstanding,
       COUNT(*)::int                                                                       AS bill_count,
       COUNT(DISTINCT party_id)::int                                                       AS party_count,
       COALESCE(SUM(CASE WHEN overdue_days > 0 THEN effective_outstanding ELSE 0 END), 0)::float AS overdue_amount,
       COALESCE(MAX(overdue_days), 0)::int                                                 AS oldest_days,
       CASE WHEN SUM(CASE WHEN overdue_days > 0 THEN effective_outstanding ELSE 0 END) > 0
            THEN SUM(overdue_days * CASE WHEN overdue_days > 0 THEN effective_outstanding ELSE 0 END)::float
                 / SUM(CASE WHEN overdue_days > 0 THEN effective_outstanding ELSE 0 END)
            ELSE 0
       END                                                                                 AS avg_days_overdue
     FROM bill_rows
     ${havingSql}`,
    { replacements: params, type: sequelize.QueryTypes.SELECT },
  );

  // Filter-meta — distinct values for the city/state filter chips. Pulled
  // OUT of the bill_rows CTE intentionally: we want the user to see every
  // location that has outstanding bills under the OTHER active filters,
  // not only those matching the current city/state filter. So drop the
  // current city/state filters before computing.
  const filterMetaSql = `
    SELECT DISTINCT p.city, p.state
      FROM ${billTable} b
      JOIN parties p ON p.party_id = b.${partyFK}
     WHERE b.is_cancelled = false
       AND b.${partyFK} IS NOT NULL
       AND b.balance_amount > 0
       AND b.bill_date <= :as_of
       AND (p.is_system_cash IS NULL OR p.is_system_cash = false)
  `;
  const distinctRows = await sequelize.query(filterMetaSql,
    { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT });

  // Reconciliation — 6-term invariant (mirrored from
  // reportController._agingReconciliation; kept in lockstep so the two
  // reports never disagree on the formula).
  const reconciliation = await _reconcile(isCustomer, asOf, subGroup);

  // Allocation-completeness — runtime check.
  //
  // After R8 (auto-receipt service + boot-time backfill), every paid
  // bill in scope has a `bill_payment_allocations` row tying it to its
  // auto-generated receipt. The remaining gap is *manual* receipts —
  // operator-entered Receipt/Payment vouchers that haven't been
  // FIFO-allocated to specific bills via `bill_payment_allocations`.
  //
  // We count manual rows whose total exceeds the sum of their
  // allocations (i.e. fully unallocated OR partial). When the count is
  // 0, the UI hides the banner entirely; when > 0, the banner shows
  // the actual count + an "Allocate now" CTA (UI placeholder until the
  // FIFO allocation screen is built).
  const txType = isCustomer ? 'Receipt' : 'Payment';
  const [{ unallocated_count }] = await sequelize.query(
    `SELECT COUNT(*)::int AS unallocated_count
       FROM payments_receipts pr
      WHERE pr.source = 'manual'
        AND pr.transaction_type = :tx
        AND pr.is_cancelled = false
        AND pr.transaction_date <= :as_of
        AND pr.total_amount > COALESCE(
          (SELECT SUM(bpa.allocated_amount)
             FROM bill_payment_allocations bpa
            WHERE bpa.transaction_id = pr.transaction_id),
          0
        )`,
    {
      replacements: { tx: txType, as_of: asOf },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  return {
    data: dataRows.map(_normaliseRow),
    total,
    page, limit,
    summary: {
      total_outstanding:  r2(agg.total_outstanding),
      bill_count:         agg.bill_count,
      party_count:        agg.party_count,
      overdue_amount:     r2(agg.overdue_amount),
      avg_days_overdue:   Math.round(Number(agg.avg_days_overdue) || 0),
      oldest_days:        agg.oldest_days,
    },
    reconciliation,
    filter_meta: {
      distinct_cities: [...new Set(distinctRows.map((r) => r.city).filter(Boolean))].sort(),
      distinct_states: [...new Set(distinctRows.map((r) => r.state).filter(Boolean))].sort(),
    },
    bucket_labels: labels,
    // Boolean retained for backwards-compat (test 8.1 / 9.4); derived
    // from the new count so callers still get the same flag.
    allocation_complete: unallocated_count === 0,
    unallocated_count,
    as_of: asOf,
    party_type: partyType,
  };
}

// Normalise a raw row to the shape the frontend renders. Numbers come
// back as strings from pg DECIMAL columns; convert to float here so the
// frontend's totals sum cleanly without per-cell coercion.
//
// `outstanding` reads from the CTE's `effective_outstanding` column —
// total_amount minus SUM(bill_payment_allocations.allocated_amount)
// when allocations exist; balance_amount otherwise. `has_allocation`
// is exposed so a future per-row chip can mark which bills are
// allocation-backed vs proxy-backed.
function _normaliseRow(r) {
  return {
    bill_id:           r.bill_id,
    bill_number:       r.bill_number,
    bill_date:         r.bill_date,
    due_date:          r.due_date,
    effective_due_date: r.effective_due_date,
    overdue_days:      Number(r.overdue_days) || 0,
    bucket_key:        null,   // filled in by frontend from overdue_days + bounds
    bill_amount:       r2(r.total_amount),
    paid_amount:       r2(r.paid_amount),
    outstanding:       r2(r.effective_outstanding),
    has_allocation:    !!r.has_allocation,
    payment_status:    r.payment_status,
    payment_method:    r.payment_method,
    remarks:           r.remarks || null,
    party_id:          r.party_id,
    party_name:        r.party_name,
    party_mobile:      r.party_mobile,
    party_gstin:       r.party_gstin,
    party_city:        r.party_city,
    party_state:       r.party_state,
    party_credit_days: Number(r.party_credit_days) || 0,
    party_credit_limit: r2(r.party_credit_limit),
    sales_person:      r.sales_person,
    salesman_name:     r.salesman_name || r.salesperson_name || null,
    created_by:        r.created_by,
    created_by_name:   r.created_by_name,
  };
}

// 6-term reconciliation invariant — same formula as
// reportController._agingReconciliation. Kept in this controller for
// self-containment; if the formula ever changes, both must update
// together. (The Aging report's tests already cover the math; this
// re-runs the same SQL with the same inputs and gets the same answer.)
async function _reconcile(isCustomer, asOf, subGroup) {
  // Bills' contribution. Joins to parties and excludes the system
  // Cash party — cash sales/purchases settle at point-of-sale and
  // post to the Cash ledger, NOT Sundry Debtors/Creditors. Without
  // this filter, a cash bill with balance_amount > 0 (rare; usually
  // a half-saved entry) inflates bill_outstanding by an amount that
  // never appears on the party-ledger side, surfacing as a drift on
  // the reconciliation banner.
  const [billRow] = await sequelize.query(
    isCustomer
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
            AND (p.is_system_cash IS NULL OR p.is_system_cash = false)`,
    { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );

  const [returnsRow] = await sequelize.query(
    isCustomer
      ? `SELECT COALESCE(SUM(le.credit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Debtors'
            AND le.source_type = 'sales_return_bill'
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`
      : `SELECT COALESCE(SUM(le.debit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Creditors'
            AND le.source_type = 'purchase_return_bill'
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`,
    { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );

  const [ledgerRow] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount - le.credit_amount), 0)::float net
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
      WHERE la.sub_group = :sg
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
        AND le.entry_date <= :as_of`,
    { replacements: { sg: subGroup, as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );

  const [unallocRow] = await sequelize.query(
    isCustomer
      ? `SELECT COALESCE(SUM(le.credit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Debtors'
            AND le.source_type IN ('payment_receipt', 'sales_bill_receipt')
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`
      : `SELECT COALESCE(SUM(le.debit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Creditors'
            AND le.source_type IN ('payment_receipt', 'purchase_bill_payment')
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`,
    { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );

  const [openingRow] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount),  0)::float opening_dr,
            COALESCE(SUM(le.credit_amount), 0)::float opening_cr
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
      WHERE la.sub_group = :sg
        AND le.source_type = 'party_opening'
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
        AND le.entry_date <= :as_of`,
    { replacements: { sg: subGroup, as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );

  const billOutstanding = r2(billRow.outstanding);
  const paidInBills     = r2(billRow.paid_in_bills);
  const returnsOffset   = r2(returnsRow.v);
  const ledgerOutstanding = r2(isCustomer ? ledgerRow.net : -ledgerRow.net);
  const unallocated     = r2(unallocRow.v);
  const openingDr = r2(isCustomer ? openingRow.opening_dr : openingRow.opening_cr);
  const openingCr = r2(isCustomer ? openingRow.opening_cr : openingRow.opening_dr);
  const expected = r2(billOutstanding + paidInBills - unallocated - returnsOffset + openingDr - openingCr);
  const difference = r2(ledgerOutstanding - expected);

  return {
    sub_group: subGroup,
    bill_outstanding:    billOutstanding,
    paid_in_bills:       paidInBills,
    unallocated_receipts: unallocated,
    returns_offset:      returnsOffset,
    opening_dr:          openingDr,
    opening_cr:          openingCr,
    expected_ledger_outstanding: expected,
    ledger_outstanding:  ledgerOutstanding,
    difference,
    balanced: Math.abs(difference) < 0.01,
  };
}

// ── HTTP handlers ─────────────────────────────────────────────────────

exports.billsReceivable = async (req, res) => {
  try {
    const result = await _billsList(req, 'Customer');
    res.json(result);
  } catch (err) {
    console.error('billsReceivable error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.billsPayable = async (req, res) => {
  try {
    const result = await _billsList(req, 'Supplier');
    res.json(result);
  } catch (err) {
    console.error('billsPayable error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// Excel export — re-runs the query with limit=10000 (safe upper bound;
// the largest seed has 1,676 outstanding bills today). Respects every
// filter the user has applied. Includes a totals row + bucket labels in
// the header so the offline Excel reads the same as the on-screen one.
exports.exportBills = async (req, res) => {
  try {
    const partyType = req.query.party_type === 'Supplier' ? 'Supplier' : 'Customer';
    // Force the page params off + use a wide limit; the user is exporting,
    // not paginating.
    req.query = { ...(req.query || {}), page: 1, limit: 10000 };
    const result = await _billsList(req, partyType);
    const isCustomer = partyType === 'Customer';

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(isCustomer ? 'Bills Receivable' : 'Bills Payable');

    ws.columns = [
      { header: 'Bill No',        key: 'bill_number',   width: 14 },
      { header: 'Bill Date',      key: 'bill_date',     width: 12 },
      { header: 'Party',          key: 'party_name',    width: 28 },
      { header: 'GSTIN',          key: 'party_gstin',   width: 16 },
      { header: 'City',           key: 'party_city',    width: 14 },
      { header: 'Mobile',         key: 'party_mobile',  width: 14 },
      { header: 'Credit Days',    key: 'party_credit_days', width: 11 },
      { header: 'Due Date',       key: 'effective_due_date', width: 12 },
      { header: 'Days Overdue',   key: 'overdue_days',  width: 12 },
      { header: 'Bucket',         key: 'bucket_label',  width: 10 },
      { header: 'Bill Amount',    key: 'bill_amount',   width: 14 },
      { header: 'Paid',           key: 'paid_amount',   width: 14 },
      { header: 'Outstanding',    key: 'outstanding',   width: 14 },
      { header: 'Salesperson',    key: 'salesman_name', width: 18 },
      { header: 'Notes',          key: 'remarks',       width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const labels = result.bucket_labels;
    for (const r of result.data) {
      const bucket = r.overdue_days <= 0 ? 'current'
                   : r.overdue_days <= 30 ? 'b1'
                   : r.overdue_days <= 60 ? 'b2'
                   : r.overdue_days <= 90 ? 'b3' : 'b4';
      ws.addRow({
        ...r,
        bucket_label: labels[bucket],
      });
    }

    // Totals row.
    const tot = ws.addRow({
      bill_number: 'TOTAL',
      bill_amount: result.data.reduce((s, r) => s + r.bill_amount, 0),
      paid_amount: result.data.reduce((s, r) => s + r.paid_amount, 0),
      outstanding: result.summary.total_outstanding,
    });
    tot.font = { bold: true };
    tot.border = { top: { style: 'medium' } };

    const fname = `${isCustomer ? 'bills_receivable' : 'bills_payable'}_${result.as_of}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('exportBills error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
};
