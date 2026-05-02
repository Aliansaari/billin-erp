const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Party, SalesBill, PurchaseBill, PaymentReceipt, SalesReturnBill, PurchaseReturnBill, SystemSettings } = require('../models');
const { recalculatePartyBalance } = require('../utils/balanceHelper');
const { sanitizePagination } = require('../utils/helpers');

// Aging bucket boundaries come from SystemSettings so admins can tune what
// counts as "Watchful / Chase / Critical" for their business. Falls back to
// the standard 30/60/90 split if the row hasn't been loaded yet.
const getAgingBuckets = async () => {
  const s = await SystemSettings.findByPk(1).catch(() => null);
  const b1 = parseInt(s?.aging_bucket_1_days ?? 30, 10);
  const b2 = parseInt(s?.aging_bucket_2_days ?? 60, 10);
  const b3 = parseInt(s?.aging_bucket_3_days ?? 90, 10);
  // Guard against misordered or zero values — clamp so b1<b2<b3 is always true.
  const a = Math.max(1, b1);
  const b = Math.max(a + 1, b2);
  const c = Math.max(b + 1, b3);
  return { b1: a, b2: b, b3: c };
};

// Whitelist of fields clients may send via POST/PUT. Deliberately excludes
// party_id (PK), current_balance (derived from bills + receipts), created_by,
// created_date, modified_date — columns owned by the server. Without this
// filter a malicious client could POST {"current_balance": 9999999} and
// silently rewrite their ledger. is_system_cash is also intentionally
// EXCLUDED — it's only ever set by the seeder, never by client requests.
const PARTY_UPDATABLE_FIELDS = [
  'party_type', 'party_name', 'display_name', 'mobile_1', 'mobile_2', 'email',
  'address_line_1', 'address_line_2', 'city', 'state', 'pincode', 'country',
  'gstin', 'pan_number', 'aadhar_number',
  'credit_allowed', 'credit_limit', 'credit_days',
  'opening_balance', 'opening_balance_type',
  'interest_rate', 'party_status', 'is_active',
];

// Names that collide with the seeded system "Cash" party. The dropdown
// pins that single row to the top; allowing user-created "Cash" / "Cash
// Sales" / "Cash Purchases" / "CASH " parties would let cash-leg
// transactions land on a Sundry Debtors stub instead of Cash-in-Hand,
// recreating the same accounting drift this whole change set fixes.
// Keep the regex permissive — leading whitespace, any trailing word.
const CASH_NAME_RE = /^\s*cash(\b|$)/i;
function isReservedCashName(name) {
  return CASH_NAME_RE.test(String(name || ''));
}

exports.getAll = async (req, res) => {
  try {
    const { party_type, search, status, balance_status, sort_by, sort_order } = req.query;
    // Clamp page/limit — untrusted query params. See helpers.sanitizePagination.
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = {};

    // "Both" parties must appear when filtering by either Customer OR Supplier.
    // Prior code wrongly showed Customer+Both when filter was "Both", and hid Both parties
    // when filtering for "Customer" or "Supplier" — breaking legitimate dual-role vendors.
    if (party_type === 'Customer')      where.party_type = { [Op.in]: ['Customer', 'Both'] };
    else if (party_type === 'Supplier') where.party_type = { [Op.in]: ['Supplier', 'Both'] };
    else if (party_type === 'Both')     where.party_type = 'Both';
    if (status) where.party_status = status;
    if (search) {
      where[Op.or] = [
        { party_name: { [Op.iLike]: `%${search}%` } },
        { mobile_1: { [Op.like]: `%${search}%` } },
        { mobile_2: { [Op.like]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (balance_status === 'Receivable') where.current_balance = { [Op.gt]: 0 };
    if (balance_status === 'Payable') where.current_balance = { [Op.lt]: 0 };
    if (balance_status === 'NoDues') where.current_balance = 0;

    const order = [];
    if (sort_by) {
      order.push([sort_by, sort_order || 'ASC']);
    } else {
      order.push(['party_name', 'ASC']);
    }

    const { count, rows } = await Party.findAndCountAll({
      where,
      order,
      limit,
      offset,
    });

    res.json({ total: count, page, limit, data: rows });
  } catch (error) {
    console.error('Get parties error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const party = await Party.findByPk(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });
    res.json(party);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    // Whitelist input — don't let clients seed current_balance, party_id, or
    // tamper with created_by. Server sets created_by from the auth token, and
    // current_balance is derived from opening + transactions.
    const safe = {};
    for (const k of PARTY_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    // Reject names that collide with the seeded system Cash party. The
    // dropdown pins it to the top and reports filter on is_system_cash;
    // a user-created "Cash" stub would silently steal those bills back
    // into Sundry Debtors/Creditors. Frontend (PartyForm) shows the same
    // message as inline validation; this is the server-side guard.
    if (isReservedCashName(safe.party_name)) {
      return res.status(400).json({
        error: 'The name "Cash" is reserved. Use the system Cash party instead.',
        field: 'party_name',
      });
    }
    const data = { ...safe, created_by: req.user.user_id };
    if (data.opening_balance) {
      data.current_balance = data.opening_balance_type === 'Payable'
        ? -Math.abs(data.opening_balance)
        : Math.abs(data.opening_balance);
    }
    const party = await Party.create(data);
    res.status(201).json(party);
  } catch (error) {
    console.error('Create party error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Party with this information already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const party = await Party.findByPk(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    // Strip everything the client isn't allowed to touch — prevents attackers
    // from sending {"current_balance": 99999999} and silently rewriting ledgers.
    const safe = {};
    for (const k of PARTY_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    // Block renaming any party (including the system Cash party itself
    // — we never want its name drift) into the reserved /^cash/i
    // namespace. Same rejection as create().
    if (safe.party_name !== undefined && isReservedCashName(safe.party_name)) {
      return res.status(400).json({
        error: 'The name "Cash" is reserved. Use the system Cash party instead.',
        field: 'party_name',
      });
    }

    const openingChanged =
      safe.opening_balance !== undefined ||
      safe.opening_balance_type !== undefined;

    await party.update(safe);

    // If opening balance was edited, recalculate current_balance from scratch
    if (openingChanged) {
      await recalculatePartyBalance(party.party_id);
      await party.reload();
    }

    res.json(party);
  } catch (error) {
    console.error('Update party error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Aging buckets across all open bills for customers or suppliers.
// Returns totals per bucket + party counts so the v5 list header can render
// its aging cards without the client having to fetch every open bill and
// aggregate itself.
//
// Aging anchor = (bill_date + party.credit_days). A positive age_days means
// the bill is past its due date; 0 or negative means still inside the party's
// Net-X credit window and is shown as "Not yet due". Bucket boundaries come
// from SystemSettings so admins can tune what counts as Watchful/Chase/Critical.
exports.getAging = async (req, res) => {
  try {
    const { party_type, status } = req.query;
    const isCust = party_type !== 'Supplier';
    const table  = isCust ? 'sales_bills'    : 'purchase_bills';
    const fk     = isCust ? 'customer_id'    : 'supplier_id';
    const { b1, b2, b3 } = await getAgingBuckets();

    // Optional status filter (Regular / Priority / VIP / Blacklist) — parity
    // with the customer + supplier list endpoints so the aging card on the
    // dashboard can be scoped to a specific tier.
    const ALLOWED_STATUSES = ['Regular', 'Priority', 'VIP', 'Blacklist'];
    const statusClause = status && ALLOWED_STATUSES.includes(status)
      ? `AND p.party_status = :status`
      : '';

    const rows = await sequelize.query(
      `
      WITH open_bills AS (
        SELECT
          b.${fk} AS party_id,
          b.balance_amount::float AS bal,
          (CURRENT_DATE - (b.bill_date + COALESCE(p.credit_days, 0)))::int AS age_days
        FROM ${table} b
        JOIN parties p ON p.party_id = b.${fk}
        WHERE b.is_cancelled = false
          AND b.balance_amount > 0
          AND p.is_active = true
          -- System Cash bills always have balance_amount=0 in steady
          -- state (the form pre-fills paid_amount=total for cash sales),
          -- but a half-finished cash bill could still leak in here. The
          -- explicit filter keeps Receivables/Payables Aging strictly
          -- about real credit accounts.
          AND COALESCE(p.is_system_cash, false) = false
          ${statusClause}
      )
      SELECT
        COUNT(DISTINCT party_id)                                              AS party_count,
        COALESCE(SUM(bal), 0)::float                                          AS total,
        COALESCE(SUM(bal) FILTER (WHERE age_days <= :b1), 0)::float                     AS b0_30,
        COALESCE(SUM(bal) FILTER (WHERE age_days BETWEEN :b1p1 AND :b2), 0)::float      AS b31_60,
        COALESCE(SUM(bal) FILTER (WHERE age_days BETWEEN :b2p1 AND :b3), 0)::float      AS b61_90,
        COALESCE(SUM(bal) FILTER (WHERE age_days > :b3), 0)::float                      AS b90plus,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days <= :b1)                         AS c0_30,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days BETWEEN :b1p1 AND :b2)          AS c31_60,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days BETWEEN :b2p1 AND :b3)          AS c61_90,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days > :b3)                          AS c90plus,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days > :b1)                          AS overdue_count
      FROM open_bills
      `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { b1, b2, b3, b1p1: b1 + 1, b2p1: b2 + 1, status: status || null },
      }
    );
    const out = rows[0] || {};
    out.buckets = { b1, b2, b3 };
    res.json(out);
  } catch (error) {
    console.error('Get aging error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Per-party gross profit earned, computed from snapshotted line-item costs.
// Query shape:
//   GET /api/parties/:id/profit?period=fy-current | fy-previous | lifetime
//
// Math (per non-cancelled sales bill to this customer):
//     line_revenue = sum(sales_bill_items.taxable_amount)          — post-trade-disc, excl GST
//     line_cogs    = sum(sales_bill_items.quantity × cost_rate)    — snapshot at sale time
//     bill_profit  = line_revenue − line_cogs
//                    − sales_bills.special_discount − sales_bills.return_amount
// Sum bill_profit across the selected period. Only makes sense for Customers
// (profit from a Supplier would require per-sale attribution back to the
// supplier we bought from, which we don't currently track).
//
// Suppliers get a simplified view: gross purchase spend in the period, so
// the expanded row still has a meaningful revenue-side number.
exports.getPartyProfit = async (req, res) => {
  try {
    const { id } = req.params;
    const { period = 'fy-current' } = req.query;

    const party = await Party.findByPk(id);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    // Resolve the date range.
    //   fy-current  → 1 Apr (current FY) to today
    //   fy-previous → 1 Apr to 31 Mar of the previous FY
    //   lifetime    → no filter
    const today = new Date();
    const curMonth = today.getMonth() + 1; // 1..12
    const curYear = today.getFullYear();
    const fyStartYear = curMonth >= 4 ? curYear : curYear - 1;
    const fyStart = `${fyStartYear}-04-01`;
    const fyEnd   = `${fyStartYear + 1}-03-31`;

    let range = null;
    let label = '';
    if (period === 'fy-current') {
      range = { start: fyStart, end: fyEnd };
      label = `FY ${String(fyStartYear).slice(-2)}-${String(fyStartYear + 1).slice(-2)}`;
    } else if (period === 'fy-previous') {
      range = { start: `${fyStartYear - 1}-04-01`, end: `${fyStartYear}-03-31` };
      label = `FY ${String(fyStartYear - 1).slice(-2)}-${String(fyStartYear).slice(-2)}`;
    } else if (period === 'lifetime') {
      range = null;
      label = 'Lifetime';
    } else {
      return res.status(400).json({ error: 'Invalid period' });
    }

    const isCustomer = party.party_type === 'Customer' || party.party_type === 'Both';

    if (isCustomer) {
      // Customer-side: compute true gross profit from line-level COGS.
      //
      // Split the math by grain: items are aggregated against the item table,
      // bill-level adjustments (special_discount, return_amount) against the
      // bill table. Earlier a single JOIN caused a 3-item bill's ₹100
      // return to be counted 3× in adjustments. Using two separate scalar
      // subqueries keeps both sums at their correct granularity.
      const dateFilterItems = range ? `AND sb.bill_date BETWEEN :start AND :end` : '';
      const dateFilterBills = range ? `AND bill_date BETWEEN :start AND :end`    : '';
      const [row] = await sequelize.query(
        `
        SELECT
          (
            SELECT COALESCE(SUM(sbi.taxable_amount), 0)::float
            FROM sales_bill_items sbi
            JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
            WHERE sb.customer_id = :id AND sb.is_cancelled = false ${dateFilterItems}
          ) AS revenue,
          (
            SELECT COALESCE(SUM(sbi.quantity * sbi.cost_rate), 0)::float
            FROM sales_bill_items sbi
            JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
            WHERE sb.customer_id = :id AND sb.is_cancelled = false ${dateFilterItems}
          ) AS cogs,
          (
            SELECT COALESCE(SUM(special_discount + return_amount), 0)::float
            FROM sales_bills
            WHERE customer_id = :id AND is_cancelled = false ${dateFilterBills}
          ) AS adjustments,
          (
            SELECT COUNT(*)::int
            FROM sales_bills
            WHERE customer_id = :id AND is_cancelled = false ${dateFilterBills}
          ) AS bill_count
        `,
        {
          replacements: { id, ...(range || {}) },
          type: sequelize.QueryTypes.SELECT,
        }
      );
      const profit = (row.revenue || 0) - (row.cogs || 0) - (row.adjustments || 0);
      const margin = row.revenue > 0 ? (profit / row.revenue) * 100 : 0;
      return res.json({
        period, label, kind: 'customer',
        revenue: +row.revenue.toFixed(2),
        cogs:    +row.cogs.toFixed(2),
        adjustments: +row.adjustments.toFixed(2),
        profit:  +profit.toFixed(2),
        margin_pct: +margin.toFixed(2),
        bill_count: row.bill_count,
      });
    }

    // Supplier-side: we don't have per-sale attribution to the supplier we
    // bought from, so "profit from a supplier" can't be computed accurately.
    // Return the gross purchase spend instead so the UI has something real
    // to show in the expanded row.
    const dateFilter = range ? `AND pb.bill_date BETWEEN :start AND :end` : '';
    const [row] = await sequelize.query(
      `
      SELECT COALESCE(SUM(pb.total_amount), 0)::float AS purchases,
             COUNT(DISTINCT pb.purchase_bill_id)::int AS bill_count
      FROM purchase_bills pb
      WHERE pb.supplier_id = :id
        AND pb.is_cancelled = false
        ${dateFilter}
      `,
      {
        replacements: { id, ...(range || {}) },
        type: sequelize.QueryTypes.SELECT,
      }
    );
    return res.json({
      period, label, kind: 'supplier',
      purchases: +row.purchases.toFixed(2),
      bill_count: row.bill_count,
    });
  } catch (error) {
    console.error('Get party profit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.toggleActive = async (req, res) => {
  try {
    const party = await Party.findByPk(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });
    await party.update({ is_active: !party.is_active });
    res.json(party);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.delete = async (req, res) => {
  try {
    const party = await Party.findByPk(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    const salesCount    = await SalesBill.count({ where: { customer_id: party.party_id } });
    const purchaseCount = await PurchaseBill.count({ where: { supplier_id: party.party_id } });
    const paymentCount  = await PaymentReceipt.count({ where: { party_id: party.party_id } });
    const total = salesCount + purchaseCount + paymentCount;

    if (total > 0) {
      return res.status(400).json({
        error: `Cannot delete: this party has ${total} transaction(s) linked to them.`,
        canDeactivate: true,
        transactionCount: total,
      });
    }

    await party.destroy();
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete party error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getLedger = async (req, res) => {
  try {
    const { id } = req.params;
    const { from_date, to_date } = req.query;
    const party = await Party.findByPk(id);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    // Recalculate balance to ensure it's accurate before returning
    await recalculatePartyBalance(id);
    await party.reload();

    // All-time signed opening: positive = Receivable (Dr), negative = Payable (Cr)
    const signedOpening =
      (party.opening_balance_type === 'Payable' ? -1 : 1) * (parseFloat(party.opening_balance) || 0);

    // Compute the PERIOD opening balance = signed all-time opening + all transactions
    // that happened BEFORE from_date. Without this, the "Opening Balance" row at
    // the top of the ledger would show the party's original opening (from when
    // they were first added) rather than the balance that was carried into the
    // period — which is what accountants and Tally/Vyapar users expect.
    let periodOpening = signedOpening;
    if (from_date) {
      const [preSales, prePurch, prePay] = await Promise.all([
        SalesBill.sum('total_amount', {
          where: { customer_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
        }),
        PurchaseBill.sum('total_amount', {
          where: { supplier_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
        }),
        PaymentReceipt.findAll({
          where: { party_id: id, is_cancelled: false, transaction_date: { [Op.lt]: from_date } },
          attributes: ['transaction_type', 'total_amount'],
          raw: true,
        }),
      ]);
      // at-billing paid/returns for pre-period bills
      const preSalesPaid = await SalesBill.sum('paid_amount', {
        where: { customer_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
      }) || 0;
      const preSalesReturn = await SalesBill.sum('return_amount', {
        where: { customer_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
      }) || 0;
      const prePurchPaid = await PurchaseBill.sum('paid_amount', {
        where: { supplier_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
      }) || 0;
      // Formal return bills (credit/debit notes) before the period — full
      // total_amount of each reduces the carried-forward balance, mirroring
      // balanceHelper.recalculatePartyBalance so ledger opening and cached
      // balance always reconcile.
      const preSalesReturnFormal = await SalesReturnBill.sum('total_amount', {
        where: { customer_id: id, is_cancelled: false, return_date: { [Op.lt]: from_date } },
      }) || 0;
      const prePurchReturnFormal = await PurchaseReturnBill.sum('total_amount', {
        where: { supplier_id: id, is_cancelled: false, return_date: { [Op.lt]: from_date } },
      }) || 0;

      const receiptTotal = prePay.filter(p => p.transaction_type === 'Receipt')
        .reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);
      const paymentTotal = prePay.filter(p => p.transaction_type === 'Payment')
        .reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);

      periodOpening += (parseFloat(preSales  || 0) - preSalesPaid - preSalesReturn
                       - parseFloat(preSalesReturnFormal) - receiptTotal);
      periodOpening -= (parseFloat(prePurch  || 0) - prePurchPaid
                       - parseFloat(prePurchReturnFormal) - paymentTotal);
    }
    periodOpening = +periodOpening.toFixed(2);

    // Now build the in-period entries
    const dateFilter = {};
    if (from_date) dateFilter[Op.gte] = from_date;
    if (to_date)   dateFilter[Op.lte] = to_date;
    const dateWhere = (from_date || to_date) ? dateFilter : undefined;

    const sales = await SalesBill.findAll({
      where: { customer_id: id, is_cancelled: false, ...(dateWhere && { bill_date: dateWhere }) },
      order: [['bill_date', 'ASC'], ['sales_bill_id', 'ASC']],
    });

    const purchases = await PurchaseBill.findAll({
      where: { supplier_id: id, is_cancelled: false, ...(dateWhere && { bill_date: dateWhere }) },
      order: [['bill_date', 'ASC'], ['purchase_bill_id', 'ASC']],
    });

    const payments = await PaymentReceipt.findAll({
      where: { party_id: id, is_cancelled: false, ...(dateWhere && { transaction_date: dateWhere }) },
      order: [['transaction_date', 'ASC'], ['transaction_id', 'ASC']],
    });

    // Formal return bills (credit / debit notes) in the period.
    const salesReturns = await SalesReturnBill.findAll({
      where: {
        customer_id: id, is_cancelled: false,
        ...(dateWhere && { return_date: dateWhere }),
      },
      order: [['return_date', 'ASC'], ['sales_return_id', 'ASC']],
    });
    const purchaseReturns = await PurchaseReturnBill.findAll({
      where: {
        supplier_id: id, is_cancelled: false,
        ...(dateWhere && { return_date: dateWhere }),
      },
      order: [['return_date', 'ASC'], ['purchase_return_id', 'ASC']],
    });

    // No linked-payment map needed: paid_amount on the bill is the at-billing payment
    // (stored directly on the bill, never as a PaymentReceipt). Linked receipts are
    // separate transactions already shown as "Receipt"/"Payment" entries — no double-counting.

    const entries = [];

    // Sales bills: full bill amount as debit; at-billing payment as credit if > 0
    sales.forEach(s => {
      entries.push({
        date: s.bill_date,
        particulars: 'Sales Bill',
        ref_number: s.bill_number,
        voucher_type: 'Sales',
        voucher_no: s.bill_number,
        debit: parseFloat(s.total_amount),
        credit: 0,
        type: 'sales',
        id: s.sales_bill_id,
      });
      const atBillingPaid = parseFloat(s.paid_amount) || 0;
      if (atBillingPaid > 0) {
        entries.push({
          date: s.bill_date,
          particulars: 'Payment at Billing',
          ref_number: s.bill_number,
          voucher_type: 'Receipt',
          voucher_no: s.bill_number,
          debit: 0,
          credit: atBillingPaid,
          type: 'sales_initial_payment',
          id: s.sales_bill_id,
        });
      }
      const returnAmt = parseFloat(s.return_amount) || 0;
      if (returnAmt > 0) {
        entries.push({
          date: s.bill_date,
          particulars: 'Return Amount',
          ref_number: s.bill_number,
          voucher_type: 'Sales Return',
          voucher_no: s.bill_number,
          debit: 0,
          credit: returnAmt,
          type: 'sales_return_amount',
          id: s.sales_bill_id,
        });
      }
    });

    // Purchase bills: full amount as credit; at-billing payment as debit if > 0
    purchases.forEach(p => {
      entries.push({
        date: p.bill_date,
        particulars: 'Purchase Bill',
        ref_number: p.bill_number,
        voucher_type: 'Purchase',
        voucher_no: p.bill_number,
        debit: 0,
        credit: parseFloat(p.total_amount),
        type: 'purchase',
        id: p.purchase_bill_id,
      });
      const atBillingPaid = parseFloat(p.paid_amount) || 0;
      if (atBillingPaid > 0) {
        entries.push({
          date: p.bill_date,
          particulars: 'Payment at Billing',
          ref_number: p.bill_number,
          voucher_type: 'Payment',
          voucher_no: p.bill_number,
          debit: atBillingPaid,
          credit: 0,
          type: 'purchase_initial_payment',
          id: p.purchase_bill_id,
        });
      }
    });

    // Payment/Receipt records (both bill-linked and standalone)
    payments.forEach(p => {
      const isReceipt = p.transaction_type === 'Receipt';
      entries.push({
        date: p.transaction_date,
        particulars: isReceipt ? 'Receipt' : 'Payment',
        ref_number: p.transaction_number,
        voucher_type: isReceipt ? 'Receipt' : 'Payment',
        voucher_no: p.transaction_number,
        debit: isReceipt ? 0 : parseFloat(p.total_amount),
        credit: isReceipt ? parseFloat(p.total_amount) : 0,
        type: 'payment',
        id: p.transaction_id,
        linked_bill: p.reference_bill_id || null,
      });
    });

    // Formal SALES RETURN (credit note) — full total_amount credits the
    // customer, reducing their receivable by the entire credit-note value.
    // This mirrors balanceHelper.recalculatePartyBalance which subtracts
    // both balance_amount + refund_amount (= total_amount) from receivable.
    // The refund_amount leg lives on the Cash ledger, not the customer's,
    // so we don't add a separate DR here — adding one would silently
    // over-credit the customer.
    salesReturns.forEach(sr => {
      entries.push({
        date: sr.return_date,
        particulars: sr.return_mode === 'Amount' ? 'Credit Note (amount-only)' : 'Sales Return',
        ref_number: sr.return_number,
        voucher_type: 'Sales Return',
        voucher_no: sr.return_number,
        debit: 0,
        credit: parseFloat(sr.total_amount),
        type: 'sales_return',
        id: sr.sales_return_id,
        reference_bill: sr.reference_bill_number || null,
      });
    });

    // Formal PURCHASE RETURN (debit note) — mirrors SalesReturn but on the
    // supplier side. Full total_amount debits the supplier, reducing what
    // we owe them by the full value of the debit note. Matches the purchase
    // half of balanceHelper's formula.
    purchaseReturns.forEach(pr => {
      entries.push({
        date: pr.return_date,
        particulars: pr.return_mode === 'Amount' ? 'Debit Note (amount-only)' : 'Purchase Return',
        ref_number: pr.return_number,
        voucher_type: 'Purchase Return',
        voucher_no: pr.return_number,
        debit: parseFloat(pr.total_amount),
        credit: 0,
        type: 'purchase_return',
        id: pr.purchase_return_id,
        reference_bill: pr.reference_bill_number || null,
      });
    });

    const toDateStr = (d) => {
      if (!d) return '0000-00-00';
      const s = typeof d === 'string' ? d : (d instanceof Date ? d.toISOString() : String(d));
      return s.slice(0, 10);
    };

    // Strict chronological sort — dates ascending, then bill before payment on same day.
    // Guarantees a stable order independent of which query returned rows first, so the
    // running balance computed on the frontend always matches the backend's closing.
    // Sort order within a single day so the running balance feels natural
    // to an accountant reading top-to-bottom:
    //   0. Bill (sales / purchase)            — the primary transaction
    //   1. Bill's at-billing return/adjustment — walk-in return on same bill
    //   2. Bill's at-billing payment            — cash leg of the bill
    //   3. Formal return bill (credit/debit note) — tends to be raised later
    //   4. Receipt / Payment vouchers            — explicit cash movements
    const typeOrder = {
      sales: 0, purchase: 0,
      sales_return_amount: 1,
      sales_initial_payment: 2, purchase_initial_payment: 2,
      sales_return: 3, purchase_return: 3,
      payment: 4,
    };
    entries.sort((a, b) => {
      const da = toDateStr(a.date);
      const db = toDateStr(b.date);
      if (da !== db) return da < db ? -1 : 1;
      const ta = typeOrder[a.type] ?? 9;
      const tb = typeOrder[b.type] ?? 9;
      if (ta !== tb) return ta - tb;
      // Final tie-breaker: id (stable within same type)
      return (a.id || 0) - (b.id || 0);
    });

    // Running balance starts from the period opening and reconciles to closing.
    let balance = periodOpening;
    entries.forEach(e => {
      balance = +(balance + e.debit - e.credit).toFixed(2);
      e.balance = balance;
    });

    // Return opening_balance as the signed period opening so the UI's
    // "Opening Balance" row + its client-side running-balance calc both work.
    res.json({
      party,
      opening_balance: periodOpening,
      entries,
      closing_balance: balance,
      total_debit: +entries.reduce((sum, e) => sum + e.debit, 0).toFixed(2),
      total_credit: +entries.reduce((sum, e) => sum + e.credit, 0).toFixed(2),
    });
  } catch (error) {
    console.error('Get ledger error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// The customers/suppliers list page (PartyListView) needs two extra bits of
// info per row that aren't on the Party table: the oldest unpaid bill's age
// (so the UI can render an aging cell) and the single most recent ledger
// entry (so the "Last transaction" column isn't blank). Fetching them in
// separate API calls per row would be an N+1 disaster — we do it in one
// aggregated SQL pass here instead.
//
// Returns the same shape as getAll() plus per-row `_aging_days` and
// `_last_transaction` fields. The underscore prefix signals to the client
// these are derived from other tables (not columns of the Party model).
const enrichPartiesForList = async (parties, kind /* 'Customer' | 'Supplier' */) => {
  if (parties.length === 0) return parties;
  const ids = parties.map(p => p.party_id);
  const billTable = kind === 'Customer' ? 'sales_bills' : 'purchase_bills';
  const billPartyCol = kind === 'Customer' ? 'customer_id' : 'supplier_id';
  const billPkCol = kind === 'Customer' ? 'sales_bill_id' : 'purchase_bill_id';
  const billRefCol = 'bill_number';
  const billDateCol = 'bill_date';
  const { b1, b2, b3 } = await getAgingBuckets();

  const [agingRows, lastBillRows, lastPaymentRows] = await Promise.all([
    sequelize.query(
      // Single pass per party: oldest-days-past-due AND the per-bucket sum of
      // open balances. The frontend uses the oldest-days count + bucket class
      // for the column text, and the bucket amounts to render a stacked bar
      // showing how this party's dues are distributed across aging windows.
      `
      WITH ob AS (
        SELECT b.${billPartyCol} AS party_id,
               (CURRENT_DATE - (b.${billDateCol} + COALESCE(p.credit_days, 0)))::int AS age_days,
               b.balance_amount::float AS bal
        FROM ${billTable} b
        JOIN parties p ON p.party_id = b.${billPartyCol}
        WHERE b.${billPartyCol} IN (:ids) AND b.is_cancelled = false AND b.balance_amount > 0
          -- System Cash never carries an aging bucket — see getAging above.
          AND COALESCE(p.is_system_cash, false) = false
      )
      SELECT party_id,
             MAX(age_days)                                                         AS oldest_days,
             COALESCE(SUM(bal) FILTER (WHERE age_days <= :b1), 0)::float            AS b0,
             COALESCE(SUM(bal) FILTER (WHERE age_days BETWEEN :b1p1 AND :b2), 0)::float AS b30,
             COALESCE(SUM(bal) FILTER (WHERE age_days BETWEEN :b2p1 AND :b3), 0)::float AS b60,
             COALESCE(SUM(bal) FILTER (WHERE age_days > :b3), 0)::float             AS b90
      FROM ob
      GROUP BY party_id
      `,
      {
        replacements: { ids, b1, b2, b3, b1p1: b1 + 1, b2p1: b2 + 1 },
        type: sequelize.QueryTypes.SELECT,
      }
    ),
    sequelize.query(
      `
      SELECT DISTINCT ON (${billPartyCol})
        ${billPartyCol} AS party_id,
        '${kind === 'Customer' ? 'Sales Bill' : 'Purchase Bill'}' AS type,
        ${billRefCol} AS ref,
        ${billDateCol}::text AS dt,
        total_amount::float AS amt
      FROM ${billTable}
      WHERE ${billPartyCol} IN (:ids) AND is_cancelled = false
      ORDER BY ${billPartyCol}, ${billDateCol} DESC, ${billPkCol} DESC
      `,
      { replacements: { ids }, type: sequelize.QueryTypes.SELECT }
    ).catch(() => []),
    sequelize.query(
      `
      SELECT DISTINCT ON (party_id)
        party_id,
        transaction_type AS type,
        transaction_number AS ref,
        transaction_date::text AS dt,
        total_amount::float AS amt
      FROM payments_receipts
      WHERE party_id IN (:ids) AND is_cancelled = false
      ORDER BY party_id, transaction_date DESC, transaction_id DESC
      `,
      { replacements: { ids }, type: sequelize.QueryTypes.SELECT }
    ),
  ]);

  const agingByParty = Object.fromEntries(agingRows.map(r => [r.party_id, r]));
  const billByParty  = Object.fromEntries(lastBillRows.map(r => [r.party_id, r]));
  const payByParty   = Object.fromEntries(lastPaymentRows.map(r => [r.party_id, r]));

  return parties.map(p => {
    const pj = p.toJSON ? p.toJSON() : p;
    const lastBill = billByParty[p.party_id];
    const lastPay  = payByParty[p.party_id];
    // Pick whichever transaction is more recent. When a customer's latest
    // activity is a receipt (e.g. they paid off a bill), we want "Last
    // transaction" to reflect that — not a stale sale from 3 months prior.
    let lastTxn = null;
    if (lastBill && lastPay) {
      lastTxn = new Date(lastBill.dt) >= new Date(lastPay.dt) ? lastBill : lastPay;
    } else {
      lastTxn = lastBill || lastPay || null;
    }
    const a = agingByParty[p.party_id];
    return {
      ...pj,
      _aging_days: a ? a.oldest_days : null,
      // Per-bucket open-balance sums. Frontend uses these to render the
      // stacked aging bar inside each row's Aging cell.
      _aging_buckets: a ? { b0: a.b0, b30: a.b30, b60: a.b60, b90: a.b90 } : null,
      _last_transaction: lastTxn,
    };
  });
};

exports.getCustomers = async (req, res) => {
  try {
    req.query.party_type = 'Customer';
    const { party_type, search, status, balance_status, sort_by, sort_order } = req.query;
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = {};
    where.party_type = { [Op.in]: ['Customer', 'Both'] };
    if (status) where.party_status = status;
    if (search) {
      where[Op.or] = [
        { party_name: { [Op.iLike]: `%${search}%` } },
        { mobile_1: { [Op.like]: `%${search}%` } },
        { mobile_2: { [Op.like]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (balance_status === 'Receivable') where.current_balance = { [Op.gt]: 0 };
    if (balance_status === 'Payable') where.current_balance = { [Op.lt]: 0 };
    if (balance_status === 'NoDues') where.current_balance = 0;

    // System Cash always sorts first so the operator can pick it as the
    // very first dropdown option for walk-in cash sales — even when the
    // user requested a different sort_by, we keep is_system_cash DESC as
    // the primary key. Secondary key is the user's choice (or
    // party_name asc by default).
    const order = sort_by
      ? [['is_system_cash', 'DESC'], [sort_by, sort_order || 'ASC']]
      : [['is_system_cash', 'DESC'], ['party_name', 'ASC']];
    const { count, rows } = await Party.findAndCountAll({ where, order, limit, offset });
    const enriched = await enrichPartiesForList(rows, 'Customer');
    res.json({ total: count, page, limit, data: enriched });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getSuppliers = async (req, res) => {
  try {
    req.query.party_type = 'Supplier';
    const { search, status, balance_status, sort_by, sort_order } = req.query;
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = {};
    where.party_type = { [Op.in]: ['Supplier', 'Both'] };
    if (status) where.party_status = status;
    if (search) {
      where[Op.or] = [
        { party_name: { [Op.iLike]: `%${search}%` } },
        { mobile_1: { [Op.like]: `%${search}%` } },
        { mobile_2: { [Op.like]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (balance_status === 'Receivable') where.current_balance = { [Op.gt]: 0 };
    if (balance_status === 'Payable') where.current_balance = { [Op.lt]: 0 };
    if (balance_status === 'NoDues') where.current_balance = 0;

    // System Cash sorts first — same rationale as getCustomers above.
    const order = sort_by
      ? [['is_system_cash', 'DESC'], [sort_by, sort_order || 'ASC']]
      : [['is_system_cash', 'DESC'], ['party_name', 'ASC']];
    const { count, rows } = await Party.findAndCountAll({ where, order, limit, offset });
    const enriched = await enrichPartiesForList(rows, 'Supplier');
    res.json({ total: count, page, limit, data: enriched });
  } catch (error) {
    console.error('Get suppliers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Bulk recalculate current_balance for ALL parties.
 *
 * This is the authoritative source-of-truth recalc. It mirrors
 * balanceHelper.recalculatePartyBalance exactly so single-party recalc and
 * bulk recalc never disagree.
 *
 *   balance = openingSigned
 *           + (salesTotal  - salesPaid  - salesReturn - receiptsTotal)   // receivable side
 *           - (purchTotal  - purchPaid  - paymentsTotal)                 // payable side
 *
 * Key rules:
 *  - Uses total_amount from bills, NOT balance_amount. balance_amount is a
 *    derived cache (maintained by reconcileBillsForParty) and can drift. If
 *    we summed balance_amount AND subtracted receipts, receipts would be
 *    counted twice once reconcile had run.
 *  - Counts ALL PaymentReceipts (bill-linked, split, and standalone). Every
 *    receipt reduces what the party owes, regardless of how it was allocated.
 *  - Excludes cancelled bills and cancelled receipts.
 */
exports.recalculateAll = async (req, res) => {
  try {
    // Formula MUST match balanceHelper.recalculatePartyBalance exactly, else
    // the cached party.current_balance will drift from the ledger's running
    // balance — the user-visible symptom is the party picker showing one
    // number while the ledger closing shows another.
    //
    //   balance = openingSigned
    //           + (totalSales
    //              - salesPaid                - at-billing cash
    //              - salesWalkInReturn        - at-billing refund (sales_bills.return_amount)
    //              - salesReturnBalance       - open credit from formal SRN
    //              - salesReturnRefund        - cash refund leg of formal SRN
    //              - totalReceipts)
    //           - (totalPurchases
    //              - purchasePaid             - at-billing cash
    //              - totalPayments
    //              - purchaseReturnBalance    - open DN credit
    //              - purchaseReturnRefund)    - cash refund leg of formal PRN
    //
    // Important: we subtract BOTH balance_amount AND refund_amount from each
    // return bill because together they equal the return's total_amount. The
    // cash refund leg lives on the Cash ledger, not the customer's ledger.
    // The bulk recalc writes 0 for the system Cash party — same
    // short-circuit as recalculatePartyBalance(). Cash bills are paid
    // in full at point-of-sale; the formula collapses to 0 anyway, but
    // an explicit branch keeps the SQL self-explanatory.
    await sequelize.query(`
      UPDATE parties p SET current_balance = CASE WHEN COALESCE(p.is_system_cash, false) = true THEN 0 ELSE ROUND((
        CASE WHEN p.opening_balance_type = 'Payable'
          THEN -ABS(COALESCE(p.opening_balance, 0))
          ELSE  ABS(COALESCE(p.opening_balance, 0))
        END
        + COALESCE((
            SELECT SUM(COALESCE(total_amount, 0)
                     - COALESCE(paid_amount, 0)
                     - COALESCE(return_amount, 0))
            FROM sales_bills
            WHERE customer_id = p.party_id AND is_cancelled = false
          ), 0)
        - COALESCE((
            SELECT SUM(COALESCE(balance_amount, 0)
                     + COALESCE(refund_amount, 0))
            FROM sales_return_bills
            WHERE customer_id = p.party_id AND is_cancelled = false
          ), 0)
        - COALESCE((
            SELECT SUM(COALESCE(total_amount, 0))
            FROM payments_receipts
            WHERE party_id = p.party_id
              AND transaction_type = 'Receipt'
              AND is_cancelled = false
          ), 0)
        - COALESCE((
            SELECT SUM(COALESCE(total_amount, 0)
                     - COALESCE(paid_amount, 0))
            FROM purchase_bills
            WHERE supplier_id = p.party_id AND is_cancelled = false
          ), 0)
        + COALESCE((
            SELECT SUM(COALESCE(balance_amount, 0)
                     + COALESCE(refund_amount, 0))
            FROM purchase_return_bills
            WHERE supplier_id = p.party_id AND is_cancelled = false
          ), 0)
        + COALESCE((
            SELECT SUM(COALESCE(total_amount, 0))
            FROM payments_receipts
            WHERE party_id = p.party_id
              AND transaction_type = 'Payment'
              AND is_cancelled = false
          ), 0)
      )::numeric, 2) END
    `);
    res.json({ message: 'All party balances recalculated successfully' });
  } catch (error) {
    console.error('Recalculate all balances error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.getAging = async (req, res) => {
  try {
    const { party_type, status } = req.query;
    const isCust = party_type !== 'Supplier';
    const table  = isCust ? 'sales_bills'    : 'purchase_bills';
    const fk     = isCust ? 'customer_id'    : 'supplier_id';
    const { b1, b2, b3 } = await getAgingBuckets();

    // Optional status filter (Regular / Priority / VIP / Blacklist) — parity
    // with the customer + supplier list endpoints so the aging card on the
    // dashboard can be scoped to a specific tier.
    const ALLOWED_STATUSES = ['Regular', 'Priority', 'VIP', 'Blacklist'];
    const statusClause = status && ALLOWED_STATUSES.includes(status)
      ? `AND p.party_status = :status`
      : '';

    const rows = await sequelize.query(
      `
      WITH open_bills AS (
        SELECT
          b.${fk} AS party_id,
          b.balance_amount::float AS bal,
          (CURRENT_DATE - (b.bill_date + COALESCE(p.credit_days, 0)))::int AS age_days
        FROM ${table} b
        JOIN parties p ON p.party_id = b.${fk}
        WHERE b.is_cancelled = false
          AND b.balance_amount > 0
          AND p.is_active = true
          -- System Cash bills always have balance_amount=0 in steady
          -- state (the form pre-fills paid_amount=total for cash sales),
          -- but a half-finished cash bill could still leak in here. The
          -- explicit filter keeps Receivables/Payables Aging strictly
          -- about real credit accounts.
          AND COALESCE(p.is_system_cash, false) = false
          ${statusClause}
      )
      SELECT
        COUNT(DISTINCT party_id)                                              AS party_count,
        COALESCE(SUM(bal), 0)::float                                          AS total,
        COALESCE(SUM(bal) FILTER (WHERE age_days <= :b1), 0)::float                     AS b0_30,
        COALESCE(SUM(bal) FILTER (WHERE age_days BETWEEN :b1p1 AND :b2), 0)::float      AS b31_60,
        COALESCE(SUM(bal) FILTER (WHERE age_days BETWEEN :b2p1 AND :b3), 0)::float      AS b61_90,
        COALESCE(SUM(bal) FILTER (WHERE age_days > :b3), 0)::float                      AS b90plus,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days <= :b1)                         AS c0_30,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days BETWEEN :b1p1 AND :b2)          AS c31_60,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days BETWEEN :b2p1 AND :b3)          AS c61_90,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days > :b3)                          AS c90plus,
        COUNT(DISTINCT party_id) FILTER (WHERE age_days > :b1)                          AS overdue_count
      FROM open_bills
      `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { b1, b2, b3, b1p1: b1 + 1, b2p1: b2 + 1, status: status || null },
      }
    );
    const out = rows[0] || {};
    out.buckets = { b1, b2, b3 };
    res.json(out);
  } catch (error) {
    console.error('Get aging error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Per-party gross profit earned, computed from snapshotted line-item costs.
// Query shape:
//   GET /api/parties/:id/profit?period=fy-current | fy-previous | lifetime
//
// Math (per non-cancelled sales bill to this customer):
//     line_revenue = sum(sales_bill_items.taxable_amount)          — post-trade-disc, excl GST
//     line_cogs    = sum(sales_bill_items.quantity × cost_rate)    — snapshot at sale time
//     bill_profit  = line_revenue − line_cogs
//                    − sales_bills.special_discount − sales_bills.return_amount
// Sum bill_profit across the selected period. Only makes sense for Customers
// (profit from a Supplier would require per-sale attribution back to the
// supplier we bought from, which we don't currently track).
//
// Suppliers get a simplified view: gross purchase spend in the period, so
// the expanded row still has a meaningful revenue-side number.
exports.getPartyProfit = async (req, res) => {
  try {
    const { id } = req.params;
    const { period = 'fy-current' } = req.query;

    const party = await Party.findByPk(id);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    // Resolve the date range.
    //   fy-current  → 1 Apr (current FY) to today
    //   fy-previous → 1 Apr to 31 Mar of the previous FY
    //   lifetime    → no filter
    const today = new Date();
    const curMonth = today.getMonth() + 1; // 1..12
    const curYear = today.getFullYear();
    const fyStartYear = curMonth >= 4 ? curYear : curYear - 1;
    const fyStart = `${fyStartYear}-04-01`;
    const fyEnd   = `${fyStartYear + 1}-03-31`;

    let range = null;
    let label = '';
    if (period === 'fy-current') {
      range = { start: fyStart, end: fyEnd };
      label = `FY ${String(fyStartYear).slice(-2)}-${String(fyStartYear + 1).slice(-2)}`;
    } else if (period === 'fy-previous') {
      range = { start: `${fyStartYear - 1}-04-01`, end: `${fyStartYear}-03-31` };
      label = `FY ${String(fyStartYear - 1).slice(-2)}-${String(fyStartYear).slice(-2)}`;
    } else if (period === 'lifetime') {
      range = null;
      label = 'Lifetime';
    } else {
      return res.status(400).json({ error: 'Invalid period' });
    }

    const isCustomer = party.party_type === 'Customer' || party.party_type === 'Both';

    if (isCustomer) {
      // Customer-side: compute true gross profit from line-level COGS.
      //
      // Split the math by grain: items are aggregated against the item table,
      // bill-level adjustments (special_discount, return_amount) against the
      // bill table. Earlier a single JOIN caused a 3-item bill's ₹100
      // return to be counted 3× in adjustments. Using two separate scalar
      // subqueries keeps both sums at their correct granularity.
      const dateFilterItems = range ? `AND sb.bill_date BETWEEN :start AND :end` : '';
      const dateFilterBills = range ? `AND bill_date BETWEEN :start AND :end`    : '';
      const [row] = await sequelize.query(
        `
        SELECT
          (
            SELECT COALESCE(SUM(sbi.taxable_amount), 0)::float
            FROM sales_bill_items sbi
            JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
            WHERE sb.customer_id = :id AND sb.is_cancelled = false ${dateFilterItems}
          ) AS revenue,
          (
            SELECT COALESCE(SUM(sbi.quantity * sbi.cost_rate), 0)::float
            FROM sales_bill_items sbi
            JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
            WHERE sb.customer_id = :id AND sb.is_cancelled = false ${dateFilterItems}
          ) AS cogs,
          (
            SELECT COALESCE(SUM(special_discount + return_amount), 0)::float
            FROM sales_bills
            WHERE customer_id = :id AND is_cancelled = false ${dateFilterBills}
          ) AS adjustments,
          (
            SELECT COUNT(*)::int
            FROM sales_bills
            WHERE customer_id = :id AND is_cancelled = false ${dateFilterBills}
          ) AS bill_count
        `,
        {
          replacements: { id, ...(range || {}) },
          type: sequelize.QueryTypes.SELECT,
        }
      );
      const profit = (row.revenue || 0) - (row.cogs || 0) - (row.adjustments || 0);
      const margin = row.revenue > 0 ? (profit / row.revenue) * 100 : 0;
      return res.json({
        period, label, kind: 'customer',
        revenue: +row.revenue.toFixed(2),
        cogs:    +row.cogs.toFixed(2),
        adjustments: +row.adjustments.toFixed(2),
        profit:  +profit.toFixed(2),
        margin_pct: +margin.toFixed(2),
        bill_count: row.bill_count,
      });
    }

    // Supplier-side: we don't have per-sale attribution to the supplier we
    // bought from, so "profit from a supplier" can't be computed accurately.
    // Return the gross purchase spend instead so the UI has something real
    // to show in the expanded row.
    const dateFilter = range ? `AND pb.bill_date BETWEEN :start AND :end` : '';
    const [row] = await sequelize.query(
      `
      SELECT COALESCE(SUM(pb.total_amount), 0)::float AS purchases,
             COUNT(DISTINCT pb.purchase_bill_id)::int AS bill_count
      FROM purchase_bills pb
      WHERE pb.supplier_id = :id
        AND pb.is_cancelled = false
        ${dateFilter}
      `,
      {
        replacements: { id, ...(range || {}) },
        type: sequelize.QueryTypes.SELECT,
      }
    );
    return res.json({
      period, label, kind: 'supplier',
      purchases: +row.purchases.toFixed(2),
      bill_count: row.bill_count,
    });
  } catch (error) {
    console.error('Get party profit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

