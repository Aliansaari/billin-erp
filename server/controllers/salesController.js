const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { SalesBill, SalesBillItem, SalesBillDraft, SalesReturnBill, SalesReturnBillItem, Party, Product, StockLedger, SystemSettings, Godown } = require('../models');
const { generateBillNumber, roundOff, calculateGST, roundTo, sanitizePagination, safeTrailingNumber, splitBillWiseGst, isLegalGstSlab, gstSlabError } = require('../utils/helpers');
const { writeStockLedgerReversal } = require('../utils/stockLedgerReversal');
const idempotencyCache = require('../utils/idempotencyCache');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');
const { applyFiscalLockGuard, logComplianceEvent, earlierDate } = require('../utils/compliance');
const { resolveInterState } = require('../utils/interStateResolver');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers, buildSalesReturnVouchers } = require('../services/voucherBuilders');
const { syncAutoReceiptForBill, reverseAutoReceiptForBill } = require('../services/autoReceiptService');
const { applyGodownStockDelta, syncProductStockFromGodowns, getGodownStock, resolveGodownForWrite, getDefaultGodownId } = require('../utils/godownStock');
const {
  validateBillColorRequirements,
  applyColorStockDelta,
  reverseBillColorStock,
} = require('../services/productColorStockService');
const { applyBatchStockDelta, getBatchStock } = require('../utils/batchStock');
const { ProductBatch, ProductColor } = require('../models');
const { denyIfGodownInaccessible, scopeWhereByGodown } = require('../middleware/godownScope');
const { checkPartyForBillSave } = require('../utils/partyGuards');
const { computeCostRateForSale } = require('../utils/displayCost');
const { consumeFIFO, isFifoMode, recordSaleConsumption, reverseConsumptionForBill } = require('../utils/costLayers');

// Per-line batch validation for sales / sales-return / sales edits.
// Centralised so the stock-out (sale) and stock-in (sales return) paths
// apply the same expiry / availability rules. Returns null when the line
// is fine, or an error string for the controller to surface as a 400.
//
// Inputs:
//   product            — Sequelize Product instance (must already be loaded)
//   item               — line being saved; reads .batch_id, .quantity
//   godownId           — bill's godown
//   t                  — transaction
//   blockExpired       — bool (system_settings.block_expired_sales)
//   isReturn           — return paths skip the per-batch stock guard,
//                        because returns ADD stock back to the batch
//                        rather than draw it down.
async function validateBatchLine({ product, item, godownId, t, blockExpired, isReturn }) {
  if (!product) return null;
  if (!product.is_batch_tracked) return null;
  if (!item.batch_id) return null;  // Form may have skipped picker; caller handles separately.

  const batch = await ProductBatch.findByPk(item.batch_id, { transaction: t });
  if (!batch) return `Batch not found (id=${item.batch_id}) for "${product.product_name}".`;
  if (parseInt(batch.product_id, 10) !== parseInt(product.product_id, 10)) {
    return `Batch ${batch.batch_number} does not belong to "${product.product_name}".`;
  }
  if (batch.is_active === false) {
    return `Batch ${batch.batch_number} for "${product.product_name}" is inactive.`;
  }

  // Expiry guard — only on sale path. Returns can flow back into an
  // expired batch; the operator may legitimately be returning stock that
  // was sold before it expired.
  if (!isReturn && blockExpired && batch.expiry_date) {
    const expiry = new Date(batch.expiry_date);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (expiry < today) {
      return `Batch ${batch.batch_number} for "${product.product_name}" expired on ${batch.expiry_date} and "Block sales of expired batches" is enabled in Settings.`;
    }
  }

  if (!isReturn) {
    const onHand = await getBatchStock({
      product_id: product.product_id, batch_id: item.batch_id, godown_id: godownId, t,
    });
    if (parseFloat(item.quantity) > onHand + 0.001) {
      return `Batch ${batch.batch_number} for "${product.product_name}" has only ${onHand} available at the selected godown. Reduce qty or pick another batch.`;
    }
  }

  return null;
}

/**
 * Determine intra-state vs inter-state for a sales bill.
 *
 * Returns true (inter-state) only when both the company's state code and
 * the customer's place-of-supply state code are known AND differ. In any
 * ambiguous case (no customer, walk-in, missing state, missing settings)
 * defaults to false (intra-state) so legacy intra-state behaviour is
 * preserved — the safer default for cash-counter sales.
 *
 * Mirrors the same logic GSTR-1's classifier (utils/gstr1.js
 * `isInterState`/`placeOfSupply`) uses on the read side, so what we
 * STORE here is what the report will then SEE.
 */
// Backwards-compatible thin wrapper. The actual logic lives in
// utils/interStateResolver so salesReturnController + purchaseReturnController
// can share it (audit H1).
async function _resolveInterState(billData, t) {
  return resolveInterState({ partyId: billData.customer_id, transaction: t });
}

exports.getAll = async (req, res) => {
  try {
    const { from_date, to_date, customer_id, payment_status, search } = req.query;
    // Clamp page/limit — untrusted query params. "abc" → NaN; "-5" → negative
    // offset; "99999999" is a DoS vector. sanitizePagination caps at 500 rows.
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_cancelled: false };
    scopeWhereByGodown(where, req.user);

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (payment_status) where.payment_status = payment_status;
    if (search) {
      // Search across bill number AND the joined customer's name / mobile
      // so "ansari" or "98765" in the search box matches the bills the user
      // expects. The $customer.field$ syntax tells Sequelize to reference
      // the included Party association rather than the SalesBill column.
      // Audit P3-D — escape LIKE wildcards in user-supplied search.
      const s = escapeLike(search);
      where[Op.or] = [
        { bill_number: { [Op.iLike]: `%${s}%` } },
        { '$customer.party_name$': { [Op.iLike]: `%${s}%` } },
        { '$customer.mobile_1$':  { [Op.iLike]: `%${s}%` } },
      ];
    }

    // Per-row aggregates so the list UI can show "3 items · 15 pcs" without
    // forcing the frontend to fetch each bill's items. Correlated subqueries
    // keep this to a single DB round-trip. COALESCE on the SUM — when a bill
    // has zero rows the subquery would otherwise return NULL.
    const { count, rows } = await SalesBill.findAndCountAll({
      where,
      attributes: {
        include: [
          [sequelize.literal(
            '(SELECT COUNT(*)::int FROM sales_bill_items WHERE sales_bill_items.sales_bill_id = "SalesBill"."sales_bill_id")'
          ), '_item_count'],
          [sequelize.literal(
            '(SELECT COALESCE(SUM(quantity), 0)::float FROM sales_bill_items WHERE sales_bill_items.sales_bill_id = "SalesBill"."sales_bill_id")'
          ), '_pcs_total'],
        ],
      },
      include: [
        { model: Party,  as: 'customer', attributes: ['party_name', 'mobile_1'] },
        { model: Godown, as: 'godown',   attributes: ['godown_id', 'code', 'name'] },
      ],
      order: [['bill_date', 'DESC'], ['sales_bill_id', 'DESC']],
      limit,
      offset,
      // subQuery:false is required because the WHERE clause can reference
      // the joined customer via $customer.*$ (when search is non-empty).
      // Keeping it unconditional also sidesteps a Sequelize bug where
      // findAndCountAll generates a malformed count(...) + ungrouped
      // column query when the attributes list contains correlated
      // sequelize.literal subqueries (the _item_count / _pcs_total ones
      // above). distinct:true is needed alongside so the count uses
      // DISTINCT sales_bill_id rather than counting joined rows.
      subQuery: false,
      distinct: true,
    });

    // Summary aggregates over the ENTIRE filtered set — used by the
    // KPI cards and the bottom totals strip. Without this, KPIs would
    // sum only the chunks the user has scrolled past, drifting from
    // what the page count claims. Only `is_cancelled = false` bills
    // contribute to financial totals (cancelled bills are kept for
    // audit trail but shouldn't inflate "total sales").
    const totals = await SalesBill.findAll({
      where,
      attributes: [
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total_amount')),    0), 'total_amount'],
        // CR-10 — paid_amount is the at-billing snapshot (per
        // billAllocationService MONEY-1); manual receipts increase
        // bill_payment_allocations.allocated_amount and reduce
        // balance_amount but never touch paid_amount. So total "received"
        // must be derived as total − balance − return. Same invariant the
        // Bills-Receivable report uses.
        [sequelize.literal('COALESCE(SUM(total_amount - balance_amount - COALESCE(return_amount, 0)), 0)'), 'total_paid'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('balance_amount')),  0), 'total_balance'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('discount_amount')), 0), 'total_discount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('cgst_amount')),     0), 'total_cgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('sgst_amount')),     0), 'total_sgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('igst_amount')),     0), 'total_igst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('return_amount')),   0), 'total_return'],
        [sequelize.fn('COUNT', sequelize.col('sales_bill_id')), 'count'],
        [sequelize.fn('COUNT', sequelize.literal('CASE WHEN balance_amount > 0.01 THEN 1 END')), 'open_count'],
      ],
      // Same join (with subQuery:false + distinct from the count call
      // above) so $customer.party_name$ in the search WHERE clause
      // resolves correctly.
      include: [{ model: Party, as: 'customer', attributes: [] }],
      raw: true,
      subQuery: false,
    });
    const t = totals[0] || {};
    const total_gst = +(parseFloat(t.total_cgst || 0) + parseFloat(t.total_sgst || 0) + parseFloat(t.total_igst || 0)).toFixed(2);
    const summary = {
      total_amount:   +parseFloat(t.total_amount   || 0).toFixed(2),
      total_paid:     +parseFloat(t.total_paid     || 0).toFixed(2),
      total_balance:  +parseFloat(t.total_balance  || 0).toFixed(2),
      total_discount: +parseFloat(t.total_discount || 0).toFixed(2),
      total_gst,
      total_return:   +parseFloat(t.total_return   || 0).toFixed(2),
      count:          parseInt(t.count || 0, 10),
      open_count:     parseInt(t.open_count || 0, 10),
    };

    res.json({ total: count, page, limit, data: rows, summary });
  } catch (error) {
    console.error('Get sales error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const bill = await SalesBill.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'customer' },
        {
          model: SalesBillItem, as: 'items',
          include: [
            // Pull product so edit-mode can re-detect is_batch_tracked
            // (the picker's gating condition) without round-tripping for
            // each line. Pull the batch row so the form can prefill
            // batch_number / manufacture_date / expiry_date when a saved
            // line already has a batch_id, mirroring the purchase form.
            { model: Product, as: 'product', attributes: ['product_id', 'is_batch_tracked', 'product_mode', 'color_mode'] },
            { model: ProductBatch, as: 'batch', attributes: ['batch_id', 'batch_number', 'manufacture_date', 'expiry_date'] },
            // Color row tied to this line — populated for multi-color
            // products. Edit-mode rehydrates the items table using
            // it.color.color_name and it.color_id so the dropdown
            // shows the saved pick.
            { model: ProductColor, as: 'color', attributes: ['color_id', 'color_name'] },
          ],
        },
      ],
    });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Create a paired SalesReturnBill inside the SAME transaction as a sales-bill
 * insert. Used by the "Return" button inside the SalesBillForm — when a
 * customer brings goods back AT the moment of buying new ones, the operator
 * adds them in the inline return modal and the backend creates a real
 * SalesReturnBill alongside the new sale (so it shows in the returns list,
 * restocks inventory, and reconciles the party balance correctly).
 *
 * Constraints (kept simple — the inline path doesn't expose the full SR form):
 *   - Always 'Items' mode (Amount-only inline returns aren't supported).
 *   - No reference_bill_id (standalone return paired with the new sale).
 *   - GST is per-item product rate — no bill-wise mode, no bill discount,
 *     no other/freight charges. The inline modal also doesn't expose those.
 *   - Customer is always the same as the new sales bill.
 *   - Refund is recorded as 0 (the customer's refund is netted against the
 *     new sale via SalesBill.return_amount, not paid out separately).
 *
 * Returns the created SalesReturnBill row (or null if items[] is empty).
 */
async function createInlineReturn({ customer_id, billDate, items, reason, isInterState, godown_id, req, t }) {
  if (!Array.isArray(items) || items.length === 0) return null;

  // Allocate next return number with a Postgres advisory lock so concurrent
  // creators serialise. The row-level FOR UPDATE on the latest row is NOT
  // enough — two transactions can both lock row N, both compute number N+1,
  // and the second INSERT then fails the unique index. The advisory lock
  // (key 904 = sales_returns) blocks any other sales-return creator until
  // this transaction commits, so the lookup below always sees the freshly
  // inserted row from a competitor. Auto-released on commit/rollback.
  // Audit P2-B — per-company two-arg form so multi-tenant installs don't
  // serialise across companies on a shared cluster.
  const companyKey = (req && req.companyId) || 0;
  await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
    replacements: { company: companyKey, key: 904 }, transaction: t,
  });
  const settings = await SystemSettings.findByPk(1, { transaction: t });
  const prefix = settings?.sales_return_prefix?.trim() || 'SR';
  const lastReturn = await SalesReturnBill.findOne({
    order: [['sales_return_id', 'DESC']],
    transaction: t,
  });
  // Audit BILLS-5 — use safeTrailingNumber so legacy/imported rows
  // with non-numeric tails (e.g. "SR/2024/A") don't poison the counter.
  const lastNum = safeTrailingNumber(lastReturn && lastReturn.return_number);
  const returnNumber = generateBillNumber(prefix, lastNum);

  // Per-line totals + GST. Since gst_mode is always 'product' for inline
  // returns, GST is computed per item from its own gst_rate.
  let subTotal = 0, totalQty = 0;
  let totalCgst = 0, totalSgst = 0, totalIgst = 0;
  let totalItemDiscount = 0;
  const processedItems = [];
  for (const item of items) {
    const qty  = parseFloat(item.quantity);
    const rate = parseFloat(item.rate);
    const itemDiscPct = parseFloat(item.discount_percentage || 0);
    if (!isFinite(qty) || qty <= 0) throw new Error(`Return quantity must be > 0 (got "${item.quantity}" for "${item.product_name || 'item'}").`);
    if (!isFinite(rate) || rate < 0) throw new Error(`Return rate must be ≥ 0 (got "${item.rate}" for "${item.product_name || 'item'}").`);
    if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
      throw new Error(`Discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").`);
    }
    const lineTotal = roundTo(qty * rate, 2);  // Audit MONEY-7: round-half-away-from-zero
    // GST applies to the POST-DISCOUNT taxable amount (transaction value),
    // matching the sales-bill formula and what the modal displays.
    const discountAmt   = roundTo(lineTotal * itemDiscPct / 100, 2);  // Audit MONEY-7
    const taxableAmount = roundTo(lineTotal - discountAmt, 2);  // Audit MONEY-7
    const gstRate = parseFloat(item.gst_rate || 0);
    // calculateGST already handles inter-state routing (IGST only) vs
    // intra-state (CGST+SGST half-half) so we just unpack the result.
    const gst = calculateGST(taxableAmount, gstRate, !!isInterState);
    const cgst_amount = gst.cgst;
    const sgst_amount = gst.sgst;
    const igst_amount = gst.igst;
    processedItems.push({
      product_id:          item.product_id || null,
      barcode:             item.barcode || null,
      category_id:         item.category_id || null,
      category_name:       item.category_name || '',
      product_name:        item.product_name || '',
      size:                item.size || '',
      article_number:      item.article_number || '',
      hsn_code:            item.hsn_code || '',
      unit_type:           item.unit_type || 'Pcs',
      quantity:            qty,
      rate,
      discount_percentage: itemDiscPct,
      discount_amount:     discountAmt,
      taxable_amount:      taxableAmount,
      cgst_amount, sgst_amount, igst_amount,
      total_amount:        +(taxableAmount + cgst_amount + sgst_amount + igst_amount).toFixed(2),
      mrp:                 parseFloat(item.mrp || 0),
      gst_rate:            gstRate,
    });
    subTotal += lineTotal;
    totalItemDiscount += discountAmt;
    totalQty += qty;
    totalCgst += cgst_amount;
    totalSgst += sgst_amount;
    totalIgst += igst_amount;
  }
  const { roundedAmount, roundOffValue } = roundOff(
    subTotal + totalCgst + totalSgst + totalIgst
  );

  const returnBill = await SalesReturnBill.create({
    return_number: returnNumber,
    customer_id,
    godown_id,
    return_date: billDate,
    reference_bill_id: null,    // standalone — inline return isn't tied to a single past bill
    return_mode: 'Items',
    reason: reason || 'Return at counter (paired with sale)',
    total_items: processedItems.length,
    total_quantity: totalQty,
    sub_total: subTotal,
    // discount_amount on the header = sum of per-line item discounts so
    // the returns list / edit-form show the correct discount total.
    discount_amount: +totalItemDiscount.toFixed(2),
    cgst_pct: 0, sgst_pct: 0, igst_pct: 0,
    cgst_amount: totalCgst,
    sgst_amount: totalSgst,
    igst_amount: totalIgst,
    cess_amount: 0,
    round_off: roundOffValue,
    other_charges: 0,
    freight_charges: 0,
    total_amount: roundedAmount,
    refund_amount: 0,
    balance_amount: roundedAmount,
    refund_status: 'Pending',
    created_by: req.user.user_id,
  }, { transaction: t });

  // Persist line items + restock products in the same txn.
  for (const it of processedItems) {
    await SalesReturnBillItem.create({
      sales_return_id: returnBill.sales_return_id,
      ...it,
    }, { transaction: t });

    if (it.product_id) {
      const product = await Product.findByPk(it.product_id, { transaction: t });
      if (product) {
        // Restock at the SAME godown the parent sale issued from. Inline
        // returns piggy-back on the sales bill, so godown_id flows through
        // the call site (paired sale uses billData.godown_id).
        const newStock = await applyGodownStockDelta({
          product_id: it.product_id, godown_id, delta: +parseFloat(it.quantity), t,
        });
        // SER-4 fix: also restore batch-level stock for batch-tracked products.
        // Audit STOCK-1 — applyBatchStockDelta requires product_id. Pre-fix
        // this call omitted it, so any inline sales-return on a batch-tracked
        // product crashed the whole bill transaction with
        //   "applyBatchStockDelta: product_id is required"
        if (it.batch_id) {
          await applyBatchStockDelta({
            product_id: it.product_id,
            batch_id: it.batch_id, godown_id, delta: +parseFloat(it.quantity), t,
          });
        }
        await StockLedger.create({
          product_id: it.product_id,
          godown_id,
          barcode: it.barcode,
          transaction_type: 'Sales Return',
          transaction_date: billDate,
          reference_id: returnBill.sales_return_id,
          reference_number: returnBill.return_number,
          quantity_in: it.quantity,
          quantity_out: 0,
          rate: it.rate,
          balance_quantity: newStock,
          remarks: 'Inline return at sale',
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }
  }

  // ── Double-entry posting (CRIT-2 fix) ────────────────────────────────
  // The return bill and all items are now persisted; re-fetch with the
  // customer association so buildSalesReturnVouchers can resolve the
  // party ledger without a separate query.
  {
    const refreshed = await SalesReturnBill.findByPk(returnBill.sales_return_id, {
      include: [{ model: Party, as: 'customer' }],
      transaction: t,
    });
    const vouchers = await buildSalesReturnVouchers(refreshed, { transaction: t });
    for (const v of vouchers) {
      await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
    }
  }

  return returnBill;
}

exports.create = async (req, res) => {
  // Audit P2-L — idempotency cache lookup. If the client retried after
  // a network blip, the previous attempt may have committed; return the
  // already-created bill instead of double-inserting. Cache is per-server
  // (in-memory, ~60s TTL) — fine for typical retry windows.
  const idemKey = req.body && req.body.idempotency_key;
  if (idemKey) {
    const cachedBillId = idempotencyCache.get('sales_create', idemKey);
    if (cachedBillId) {
      try {
        const existing = await SalesBill.findByPk(cachedBillId, {
          include: [
            { model: SalesBillItem, as: 'items' },
            { model: Party, as: 'customer', attributes: ['party_name', 'mobile_1', 'gstin'] },
          ],
        });
        if (existing) return res.status(201).json(existing);
      } catch { /* fall through to create — cache hit but DB read failed */ }
    }
  }

  // ── Back-dated entry policy (always-on, no override) ───────────────
  // Two flags: SystemSettings.allow_backdated_entries (company-wide)
  // + Role.can_enter_backdated (per role). Both default TRUE. Runs
  // BEFORE the fiscal-lock guard so a blocked-by-policy entry doesn't
  // churn through bill-number allocation or hit the override modal
  // (the policy has no override path — it's a hard reject).
  {
    const bd = require('../utils/backdatedGuard');
    const check = await bd.checkBackdated({
      voucherDate: req.body && req.body.bill_date,
      user: req.user,
    });
    if (!check.ok) {
      return res.status(403).json({ error: check.reason, code: check.code });
    }
  }

  // ── Fiscal-lock guard (compliance-mode lock with override) ─────────
  // Centralised: probe date, lock check, optional password gate,
  // body cleanup, structured 403 FY_LOCKED. No-op when compliance is
  // off. See server/utils/compliance.js → applyFiscalLockGuard.
  const lockGuard = await applyFiscalLockGuard(req, res, req.body?.bill_date);
  if (!lockGuard.ok) return;
  const lockResult = lockGuard.lockResult;

  const t = await sequelize.transaction();
  try {
    let { items, paid_amount = 0, return_amount = 0, special_discount = 0, other_charges = 0, freight_charges = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, gst_mode, bill_mode, amount, gst_rate: amountGstRate, hsn_code: amountHsnCode, description: amountDescription, draft_id, inline_return, idempotency_key, ...billData } = req.body;

    // ── AMOUNT-ONLY MODE ─────────────────────────────────────────────
    // For service / on-account / quick-charge bills the operator enters
    // just (amount, gst_rate, hsn_code, description) — no item list. We
    // synthesise exactly one line item here so the rest of the pipeline
    // (PASS 1, PASS 2, ledger, balance, GSTR-1 routing) runs unchanged.
    //
    // Critical invariants:
    //   - quantity = 1 (SalesBillItem.quantity is allowNull:false)
    //   - rate     = amount         → line_total  = amount
    //   - taxable_amount = amount   (no item or bill discount in this mode)
    //   - product_id = null         → stock loop skips this line (line ~313)
    //   - gst_mode forced to 'product' so per-rate routing works correctly
    //   - cgst/sgst/igst computed by the same calculateGST() helper using
    //     the resolved inter-state flag → GSTR-1 sees the right amounts
    //     and classifies the bill identically to an itemised equivalent.
    if (bill_mode === 'amount') {
      const amt = parseFloat(amount);
      const rate = parseFloat(amountGstRate || 0);
      if (!isFinite(amt) || amt <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'Amount must be greater than 0 for amount-only bills.' });
      }
      if (!isLegalGstSlab(rate)) {
        await t.rollback();
        return res.status(400).json({ error: gstSlabError(rate) });
      }
      const hsn  = (amountHsnCode || '9999').toString().trim() || '9999';
      const desc = (amountDescription || 'Service / Misc').toString().trim() || 'Service / Misc';
      items = [{
        product_id:          null,
        barcode:             null,
        category_id:         null,
        category_name:       '',
        product_name:        desc,
        size:                '',
        article_number:      '',
        hsn_code:            hsn,
        unit_type:           'OTH',
        quantity:            1,
        rate:                amt,
        discount_percentage: 0,
        discount_amount:     0,
        mrp:                 0,
        gst_rate:            rate,
        quantity_per_box:    1,
      }];
      gst_mode = 'product';   // force per-line GST math
      cgst_pct = 0;
      sgst_pct = 0;
      igst_pct = 0;
      // Persist the description on the bill header too so the print
      // template / reports can show it without reading the items list.
      billData.description = desc;
    }
    billData.bill_mode = bill_mode === 'amount' ? 'amount' : 'item';

    if (!items || !Array.isArray(items) || items.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: 'At least one item is required.' });
    }

    // ── Bill number race (Fix #17) ─────────────────────────────────────
    // The earlier row-level FOR UPDATE lock on the latest sales_bills row
    // was not enough: two concurrent inserts could both lock row N, both
    // compute N+1, and the second INSERT then fails the unique index — a
    // 75% failure rate under 20-client concurrency. Switching to a
    // Postgres advisory lock keyed per doc-type (903 = sales bills)
    // serialises ALL sales-bill creators for the brief number-allocation
    // window. Sales-return / purchase / payment creators use different
    // keys so they don't needlessly block each other. Auto-released on
    // commit/rollback.
    // Audit P2-B — two-arg form (companyId, docKey) so multi-tenant
    // installs on a shared cluster don't serialise across companies.
    {
      const companyKey = req.companyId || 0;
      await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
        replacements: { company: companyKey, key: 903 }, transaction: t,
      });
    }
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const prefix = settings?.sales_bill_prefix?.trim() || '';
    const lastBill = await SalesBill.findOne({
      order: [['sales_bill_id', 'DESC']],
      transaction: t,
    });
    const lastNum = safeTrailingNumber(lastBill && lastBill.bill_number);
    billData.bill_number = generateBillNumber(prefix, lastNum);
    billData.created_by = req.user.user_id;
    billData.sales_person = billData.sales_person || req.user.user_id;

    // ── Resolve issuing godown ──
    // Explicit body.godown_id wins (subject to allowed_godowns). When
    // missing (legacy clients, scripts, imports), fall back to the user's
    // first allowed godown or the system default. The bill row carries
    // the resolved id so every downstream operation (stock writes, GST
    // routing, print Place-of-Supply) reads the same value.
    const godownResolved = await resolveGodownForWrite({
      req_godown_id: billData.godown_id, user: req.user, t,
    });
    if (godownResolved.error) {
      await t.rollback();
      return res.status(403).json({ error: godownResolved.error });
    }
    billData.godown_id = godownResolved.godown_id;

    // Prefer the explicit mode flag from the client. Fall back to the legacy
    // "any non-zero %" heuristic only when the flag is missing, so older
    // cached frontends keep working. A firm selling GST-exempt goods in
    // bill-wise mode (all three % = 0) now correctly stays in bill-wise mode.
    const billWise = gst_mode === 'bill'
      ? true
      : gst_mode === 'product'
        ? false
        : (parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0);

    let subTotal = 0;
    let totalQty = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;

    // PASS 1: compute per-line base (line total − item discount). We can't
    // calculate GST yet because the bill-level trade discount must be
    // allocated across lines first — GST applies to the post-trade-discount
    // "transaction value" under GST law.
    const processedItems = [];
    for (const item of items) {
      // Clamp inputs: quantity ≥ 0, rate ≥ 0, 0 ≤ discount% ≤ 100. A negative
      // qty or rate would invert the ledger sign; a discount > 100% would
      // produce a negative taxable base that GST/round-off math silently
      // propagates, and a negative discount would inflate the bill. Reject
      // loudly — silently clamping would hide data-entry mistakes from the
      // operator (e.g. typing "25" for a ₹25 discount in the % column).
      const qty  = parseFloat(item.quantity);
      const rate = parseFloat(item.rate);
      const itemDiscPct = parseFloat(item.discount_percentage || 0);
      // W15: qty > 0 required — a zero-quantity line has no stock or financial
      // impact and would silently pollute the invoice with a dummy row.
      if (!isFinite(qty) || qty <= 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Quantity must be greater than zero (got "${item.quantity}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(rate) || rate < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Rate must be a non-negative number (got "${item.rate}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Item discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").` });
      }
      // CR-6 — per-line GST rate must be a legal Indian slab.
      if (item.gst_rate !== undefined && item.gst_rate !== null && !isLegalGstSlab(item.gst_rate)) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `${gstSlabError(item.gst_rate)} (line "${item.product_name || 'item'}")` });
      }
      const lineTotal = roundTo(qty * rate, 2);  // Audit MONEY-7: round-half-away-from-zero
      const discountAmt = roundTo(lineTotal * itemDiscPct / 100, 2);  // Audit MONEY-7
      const taxableAmt = +(lineTotal - discountAmt).toFixed(2);

      processedItems.push({
        ...item,
        _lineTotal: lineTotal,
        _postItemTaxable: taxableAmt,     // line total after item-level discount
        taxable_amount: taxableAmt,        // will be overwritten with post-bill-disc value below
        discount_amount: discountAmt,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        total_amount: 0,
      });

      subTotal += lineTotal;
      totalQty += qty;
    }

    // Resolve bill-level (trade) discount.
    // Use != null so an explicit 0 isn't ignored in favour of a percentage.
    const billDiscPct = parseFloat(billData.discount_percentage || 0);
    if (!isFinite(billDiscPct) || billDiscPct < 0 || billDiscPct > 100) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount % must be between 0 and 100 (got ${billDiscPct}%).` });
    }
    // `let` (not const) so the GST-C4 reverse-compute below can refresh
    // these after the master snapshot block runs. For exclusive bills
    // the refresh is a no-op (values stay identical).
    let billDiscountAmt = billData.discount_amount != null
      ? parseFloat(billData.discount_amount)
      : +(subTotal * billDiscPct / 100).toFixed(2);
    let itemDiscountTotal = processedItems.reduce((s, it) => s + (parseFloat(it.discount_amount) || 0), 0);
    // Guard: bill-level discount cannot be negative, and cannot exceed
    // the post-item-discount base (otherwise taxableTotal turns negative
    // and every downstream GST/round-off figure is wrong).
    const postItemBase = +(subTotal - itemDiscountTotal).toFixed(2);
    if (!isFinite(billDiscountAmt) || billDiscountAmt < 0) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount amount must be non-negative (got ${billDiscountAmt}).` });
    }
    if (billDiscountAmt > postItemBase + 0.01) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount (₹${billDiscountAmt.toFixed(2)}) cannot exceed post-item-discount total (₹${postItemBase.toFixed(2)}).` });
    }
    // Audit MONEY-5 — fold freight + other_charges into the taxable
    // base when the company-wide flag is on (default true,
    // GST-law-Sec-15(2)(c) compliant). Each per-line taxable_amount
    // picks up its pro-rata share; the final bill total formula is
    // unchanged (freight + other are still added once, just now
    // through GST-bearing base instead of as a non-taxable add-on).
    const freightCharges = +(parseFloat(freight_charges || 0) || 0);
    const otherChargesV  = +(parseFloat(other_charges || 0)   || 0);
    const includeChargesInTaxable = settings?.freight_other_in_taxable !== false;
    const extraTaxableAdd = includeChargesInTaxable ? roundTo(freightCharges + otherChargesV, 2) : 0;

    // `let` so GST-C4 reverse-compute can refresh after master snapshot.
    let taxableTotal = +(subTotal - itemDiscountTotal - billDiscountAmt + extraTaxableAdd).toFixed(2);

    // PASS 2: allocate the bill-level discount pro-rata to each line based
    // on its post-item-discount taxable amount, then compute GST on that
    // reduced base. Pro-rata allocation preserves item-level reporting
    // fidelity — every item row carries its own correct taxable & GST.
    // `let` so the GST-C4 reverse-compute below can refresh these after
    // the master snapshot block adjusts subTotal / discounts. For
    // exclusive bills (the default), the refresh is a no-op.
    let postItemTotal = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
    let billDiscRatio = postItemTotal > 0 ? billDiscountAmt / postItemTotal : 0;
    let extraTaxableRatio = postItemTotal > 0 ? extraTaxableAdd / postItemTotal : 0;

    // Resolve intra/inter once for the whole bill — every line uses it.
    // Without this, product-mode bills to out-of-state customers stored
    // CGST+SGST instead of IGST (the legacy default for calculateGST is
    // intra-state). This is a correctness fix that benefits BOTH the new
    // amount-only mode AND existing product-mode inter-state bills.
    // Bill-wise mode is unaffected — its rates come from the operator.
    const interState = billWise ? false : await _resolveInterState(billData, t);

    // Server-side gst_rate snapshot from the product master (audit C4).
    // The client supplies items[].gst_rate verbatim, so a tampered API
    // call could send gst_rate:0 for an 18% product → bill saves with
    // zero GST while stock still deducts and ledger still posts.
    // Snapshot from Product.gst_rate by product_id so the operator can't
    // override the master rate via the API. Amount-mode lines (product_id=null)
    // keep the request's rate — there's no master to read from.
    //
    // Audit STOCK-5 — also snapshot hsn_code from the product master.
    // Pre-fix, the client could send any HSN string; the GSTR-1 HSN
    // Summary then mis-classified the line. Server-side snapshot
    // closes the loop.
    const productIdsForSnapshot = [
      ...new Set(processedItems.map(it => it.product_id).filter(Boolean)),
    ];
    if (productIdsForSnapshot.length > 0) {
      const masterProducts = await Product.findAll({
        where: { product_id: { [Op.in]: productIdsForSnapshot } },
        attributes: ['product_id', 'gst_rate', 'hsn_code', 'unit_of_measurement', 'is_tax_inclusive', 'mrp'],
        transaction: t,
      });
      const masterById = new Map(masterProducts.map(p => [p.product_id, p]));
      for (const it of processedItems) {
        if (it.product_id && masterById.has(it.product_id)) {
          const mp = masterById.get(it.product_id);
          it.gst_rate = parseFloat(mp.gst_rate) || 0;
          // Only overwrite hsn_code when the master has one — keep
          // client-supplied value as fallback for products that don't
          // yet have an HSN configured.
          if (mp.hsn_code) it.hsn_code = mp.hsn_code;
          // Audit GST-H5 — same defence for the unit_type. Without
          // this snapshot, the client could submit 'Pcs' even though
          // the product master says 'PRS' (pairs) → GSTR-1 HSN
          // section reports the wrong UQC. Master wins; only when
          // the master leaves it blank do we keep the line value.
          if (mp.unit_of_measurement) it.unit_type = mp.unit_of_measurement;
          // Audit GST-C4 — snapshot the tax-inclusive flag so a
          // tampered client can't decide line-by-line whether the
          // rate it submitted is MRP or wholesale. Master is the
          // source of truth.
          it._inclusive = !!mp.is_tax_inclusive;
          // Audit NEW-MED-3 — snapshot MRP from the master so print
          // templates / aged reports can show the printed MRP for the
          // line. Without this, sales_bill_items.mrp persists as 0
          // even when the master has MRP set, breaking MRP labels and
          // any "discount from MRP" analytics. Master MRP is the
          // historical truth at sale time; a later master MRP edit
          // doesn't alter the historical line.
          if (mp.mrp !== undefined && mp.mrp !== null) {
            it.mrp = parseFloat(mp.mrp) || 0;
          }
        }
      }
      // GST-C4 — reverse-compute inclusive lines into taxable currency.
      // After this block, every downstream calc (bill-level discount
      // ratio in PASS 2, GST math, totals, ledger postings) runs
      // unchanged — it just sees what looks like an exclusive line.
      // The OPERATOR-FACING display rate stays as the MRP they typed
      // (we don't touch `item.rate`).
      //
      // For each inclusive line at gst_rate r%:
      //   div            = 1 + r/100
      //   _lineTotal     /= div   (taxable gross — was inclusive)
      //   discount_amount /= div  (taxable discount)
      //   _postItemTaxable /= div (post-disc taxable)
      // Per-line invariant after: qty × rate stays at MRP (display),
      //                           taxable + GST = MRP × qty (printed total).
      for (const it of processedItems) {
        if (it._inclusive && it.gst_rate > 0) {
          const div = 1 + it.gst_rate / 100;
          it._lineTotal       = roundTo((parseFloat(it._lineTotal) || 0) / div, 2);
          it.discount_amount  = roundTo((parseFloat(it.discount_amount) || 0) / div, 2);
          it._postItemTaxable = roundTo((parseFloat(it._postItemTaxable) || 0) / div, 2);
          it.taxable_amount   = it._postItemTaxable;
        }
      }
      // GST-C4 — refresh every derived value that was computed BEFORE
      // this block (subTotal, itemDiscountTotal, billDiscountAmt,
      // taxableTotal, postItemTotal, billDiscRatio, extraTaxableRatio)
      // so PASS 2 + the bill row + the voucher builder all see the
      // post-reverse-compute (taxable) values. No-op when there are
      // no inclusive lines on the bill.
      const hasInclusive = processedItems.some(it => it._inclusive);
      subTotal = roundTo(
        processedItems.reduce((s, it) => s + (parseFloat(it._lineTotal) || 0), 0),
        2,
      );
      if (hasInclusive) {
        itemDiscountTotal = processedItems.reduce(
          (s, it) => s + (parseFloat(it.discount_amount) || 0), 0,
        );
        // If billDiscountAmt was DERIVED from the (gross) subTotal via
        // billDiscPct, recompute against the new (taxable) subTotal so
        // a 10% bill discount stays 10% of taxable. If the operator
        // supplied an absolute billData.discount_amount, that's already
        // in the currency they intended — leave it alone.
        if (billData.discount_amount == null && billDiscPct > 0) {
          billDiscountAmt = +(subTotal * billDiscPct / 100).toFixed(2);
        }
        taxableTotal = +(subTotal - itemDiscountTotal - billDiscountAmt + extraTaxableAdd).toFixed(2);
        postItemTotal = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
        billDiscRatio = postItemTotal > 0 ? billDiscountAmt / postItemTotal : 0;
        extraTaxableRatio = postItemTotal > 0 ? extraTaxableAdd / postItemTotal : 0;
      }
    }

    for (const it of processedItems) {
      // Audit MONEY-5 — line taxable = post-item-discount * (1 - billDiscRatio + extraTaxableRatio).
      // The extra ratio folds freight + other_charges into each
      // line's GST-bearing base proportionally when the flag is on.
      const lineBase = +(it._postItemTaxable * (1 - billDiscRatio + extraTaxableRatio)).toFixed(2);
      it.taxable_amount = lineBase;
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(lineBase, it.gst_rate || 0, interState);
      it.cgst_amount = gst.cgst;
      it.sgst_amount = gst.sgst;
      it.igst_amount = gst.igst;
      it.total_amount = +(lineBase + gst.cgst + gst.sgst + gst.igst).toFixed(2);
      if (!billWise) {
        totalCgst += gst.cgst;
        totalSgst += gst.sgst;
        totalIgst += gst.igst;
      }
      // strip private bookkeeping fields before persisting
      delete it._lineTotal;
      delete it._postItemTaxable;
    }

    // Bill-wise: override GST totals using the provided percentages on the
    // single consolidated taxable base.
    // Use roundTo (round-half-away-from-zero) to match the Indian GST rounding convention
    // and keep the two rounding paths (item-wise via calculateGST, bill-wise
    // here) consistent — previously toFixed(2) used banker's rounding in V8
    // and drifted by 1 paisa on exact .xxx5 amounts.
    //
    // Audit P2-D — allocate the bill-wise totals pro-rata back to each line
    // so per-line cgst/sgst/igst columns reflect each item's contribution.
    // Pre-fix, every line in bill-wise mode stored ₹0 GST on the items table,
    // so the HSN-wise GST summary on the invoice print (a B2B requirement
    // under GST law) and per-line analytics reported zero tax. Last-line
    // residual absorbs rounding so Σ lines == header.
    if (billWise) {
      const cgstPct = parseFloat(cgst_pct) || 0;
      const sgstPct = parseFloat(sgst_pct) || 0;
      const igstPct = parseFloat(igst_pct) || 0;

      // ── Audit H1 — bill-wise GST validation ──────────────────────────
      // (a) mutual exclusion: a bill is intra-state (CGST+SGST) OR
      //     inter-state (IGST), never both. expenseController already
      //     enforces this; sales/purchase did not.
      // (b) state mismatch: if the resolved place-of-supply says inter-
      //     state but the operator typed CGST+SGST (or vice-versa),
      //     reject with a clear message. The resolved value is the
      //     authoritative one because it reads SystemSettings.gstin vs
      //     Party.state — both server-side.
      if ((cgstPct > 0 || sgstPct > 0) && igstPct > 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({
          error: 'Bill-wise GST: pick CGST+SGST (intra-state) OR IGST (inter-state), not both.',
          code: 'GST_MUTUAL_EXCLUSION',
        });
      }
      const resolvedInterState = await _resolveInterState(billData, t);
      const typedInterState   = igstPct > 0 && cgstPct === 0 && sgstPct === 0;
      const typedIntraState   = (cgstPct > 0 || sgstPct > 0) && igstPct === 0;
      if ((cgstPct + sgstPct + igstPct) > 0) {
        if (resolvedInterState && typedIntraState) {
          if (!t.finished) await t.rollback();
          return res.status(400).json({
            error: 'Bill-wise GST: customer is in a different state — use IGST, not CGST+SGST.',
            code: 'GST_INTER_STATE_REQUIRED',
          });
        }
        if (!resolvedInterState && typedInterState) {
          if (!t.finished) await t.rollback();
          return res.status(400).json({
            error: 'Bill-wise GST: customer is in the same state — use CGST+SGST, not IGST.',
            code: 'GST_INTRA_STATE_REQUIRED',
          });
        }
      }

      // ── Audit H2 — paisa-perfect CGST/SGST split ─────────────────────
      // Previously totalCgst and totalSgst were rounded INDEPENDENTLY
      //   totalCgst = roundTo(taxableTotal * cgst_pct/100, 2)
      //   totalSgst = roundTo(taxableTotal * sgst_pct/100, 2)
      // which can drift ±₹0.01 from the combined GST (Σ != calculated)
      // — over 50k bills/year that's ~₹500 of silent drift against the GST-standard total.
      // Mirror the helpers.calculateGST rule: round the combined tax,
      // give half to CGST, give the residual to SGST so they reconcile
      // exactly. Per-pct paths preserve the operator's intent when only
      // one half is non-zero (rare but legal).
      const combinedPct = cgstPct + sgstPct;
      if (combinedPct > 0) {
        const combinedTax = roundTo(taxableTotal * combinedPct / 100, 2);
        if (cgstPct > 0 && sgstPct > 0) {
          const cgstShare = roundTo(combinedTax * cgstPct / combinedPct, 2);
          totalCgst = cgstShare;
          totalSgst = +(combinedTax - cgstShare).toFixed(2);
        } else if (cgstPct > 0) {
          totalCgst = combinedTax;
          totalSgst = 0;
        } else {
          totalSgst = combinedTax;
          totalCgst = 0;
        }
      } else {
        totalCgst = 0;
        totalSgst = 0;
      }
      totalIgst = roundTo(taxableTotal * igstPct / 100, 2);
      // Pro-rata allocation across lines.
      if (processedItems.length > 0 && taxableTotal > 0) {
        let allocCgst = 0, allocSgst = 0, allocIgst = 0;
        for (let i = 0; i < processedItems.length; i++) {
          const it = processedItems[i];
          const ratio = it.taxable_amount / taxableTotal;
          if (i < processedItems.length - 1) {
            it.cgst_amount = roundTo(totalCgst * ratio, 2);
            it.sgst_amount = roundTo(totalSgst * ratio, 2);
            it.igst_amount = roundTo(totalIgst * ratio, 2);
          } else {
            // Last line absorbs the residual so Σ items = header exactly.
            it.cgst_amount = +(totalCgst - allocCgst).toFixed(2);
            it.sgst_amount = +(totalSgst - allocSgst).toFixed(2);
            it.igst_amount = +(totalIgst - allocIgst).toFixed(2);
          }
          it.total_amount = +(it.taxable_amount + it.cgst_amount + it.sgst_amount + it.igst_amount).toFixed(2);
          allocCgst += it.cgst_amount;
          allocSgst += it.sgst_amount;
          allocIgst += it.igst_amount;
        }
      }
    }

    // Audit NEW-HI-1 — 0%-rate invariant (sales).
    // Lines with gst_rate=0 must carry zero CGST/SGST/IGST/Cess regardless
    // of bill mode. Pre-fix, in bill-wise mode the pro-rata allocator gave
    // every line a share of the bill total tax (taxable_amount / taxableTotal)
    // — including 0%-rate lines, producing phantom GST on the items table.
    // The bill grand total stayed correct (it was derived from totalCgst /
    // totalSgst / totalIgst, which already excluded zero-rate contributions
    // in product mode). But the per-line columns drifted, and GSTR-1's
    // HSN summary aggregator reads from `sales_bill_items` — so 0%-rate
    // HSN rows ended up with non-zero tax, which fails GSTN portal
    // validation on filing. Re-aggregate the bill totals from sanitized
    // lines so a Cash auto-receipt's amount matches the corrected total.
    let zeroRateRefund = { cgst: 0, sgst: 0, igst: 0 };
    for (const it of processedItems) {
      if (parseFloat(it.gst_rate || 0) === 0) {
        zeroRateRefund.cgst += parseFloat(it.cgst_amount) || 0;
        zeroRateRefund.sgst += parseFloat(it.sgst_amount) || 0;
        zeroRateRefund.igst += parseFloat(it.igst_amount) || 0;
        it.cgst_amount = 0;
        it.sgst_amount = 0;
        it.igst_amount = 0;
        if (it.cess_amount !== undefined) it.cess_amount = 0;
        it.total_amount = +(parseFloat(it.taxable_amount) || 0).toFixed(2);
      }
    }
    if (zeroRateRefund.cgst > 0.005 || zeroRateRefund.sgst > 0.005 || zeroRateRefund.igst > 0.005) {
      totalCgst = +(totalCgst - zeroRateRefund.cgst).toFixed(2);
      totalSgst = +(totalSgst - zeroRateRefund.sgst).toFixed(2);
      totalIgst = +(totalIgst - zeroRateRefund.igst).toFixed(2);
    }
    // Product mode never uses bill-level pct fields — force them to 0 so
    // reports don't read a weighted-average residue (audit found bills
    // with gst_mode='product' carrying igst_pct=9.77 from an earlier
    // in-flight code path).
    if (!billWise) {
      cgst_pct = 0; sgst_pct = 0; igst_pct = 0;
    }

    // Audit MONEY-5 — only add freight/other_charges to the outer
    // total when they were NOT folded into taxableTotal. Otherwise
    // they'd be counted twice (once in the GST-bearing base, once on
    // the outer total).
    const extraOnTotal = includeChargesInTaxable ? 0 : (otherChargesV + freightCharges);
    const { roundedAmount, roundOffValue } = roundOff(
      taxableTotal + totalCgst + totalSgst + totalIgst + totalCess
      - parseFloat(special_discount || 0)
      + extraOnTotal
    );

    const totalAmount = roundedAmount;

    // Fix: validate return_amount doesn't exceed total
    const rawReturn = parseFloat(return_amount || 0);
    if (rawReturn > totalAmount + 0.01) {
      await t.rollback();
      return res.status(400).json({ error: `Return amount (₹${rawReturn.toFixed(2)}) cannot exceed bill total (₹${totalAmount.toFixed(2)})` });
    }
    // Audit M1: deprecate the walk-in `return_amount` field for credit
    // sales. It reduces bill.balance_amount + parties.current_balance
    // but never posts a corresponding ledger voucher, so Sundry Debtors
    // ledger and the aging banner drift from the bill table by exactly
    // the return amount. Operators should use the inline-return flow
    // (which posts a credit-note voucher cleanly). For a real-customer
    // credit sale we now reject the legacy field so silent drift can't
    // accumulate. Cash-counter sales (no customer_id, system-cash, or
    // an inline_return payload alongside) still pass through.
    // Audit BILLS-6 — block inline_return on amount-mode bills. The
    // inline_return.items[] carries product_id quantities; processing
    // them on an amount-mode bill would silently decrement physical
    // stock for a "service" bill. Crafted-API guard; the UI hides
    // the modal in amount-mode but the server must enforce too.
    if (bill_mode === 'amount' && inline_return) {
      await t.rollback();
      return res.status(400).json({
        error: 'Inline return is not allowed on amount-only bills. Save the bill, then create a Sales Return from the Returns module.',
        code: 'INLINE_RETURN_IN_AMOUNT_MODE',
      });
    }

    // Audit BILLS-7 — tighten the empty-array bypass. The previous
    // guard tested `!inline_return`; a payload of
    //   `{ inline_return: { items: [] } }`
    // is truthy, so the guard accepted the raw return_amount even
    // though no SalesReturnBill ends up being created (items.length===0
    // short-circuits the inline-return helper). That left bill.return
    // _amount > 0 with no corresponding voucher — exact failure mode
    // the deprecation was meant to prevent.
    const hasInlineReturnItems = !!(inline_return && Array.isArray(inline_return.items) && inline_return.items.length > 0);
    if (rawReturn > 0.005 && billData.customer_id && !hasInlineReturnItems) {
      const cust = await Party.findByPk(billData.customer_id, { transaction: t });
      if (cust && !cust.is_system_cash) {
        await t.rollback();
        return res.status(400).json({
          error:
            'Walk-in `return_amount` is deprecated for credit sales — it reduces the ' +
            'bill balance but skips the ledger, causing drift between Sundry Debtors ' +
            'and the aging banner. Use the inline-return flow on the bill form (which ' +
            'posts a credit-note voucher), or post the return as a separate Sales Return.',
          field: 'return_amount',
        });
      }
    }

    // Enforce full payment if customer has credit_not_allowed.
    //
    // The clamp must account for BOTH the legacy rawReturn AND the inline
    // return total. When inline_return is used, rawReturn is 0 (the
    // frontend sends return_amount: 0 because the SalesReturnBill is the
    // source of truth). Without subtracting the inline return value here,
    // the customer is forced to pay the gross total; the SalesReturnBill
    // then credits them, pushing their balance negative.
    let inlineReturnValue = 0;
    if (hasInlineReturnItems) {
      for (const it of inline_return.items) {
        const q = parseFloat(it.quantity) || 0;
        const r = parseFloat(it.rate) || 0;
        const d = (q * r) * ((parseFloat(it.discount_percentage) || 0) / 100);
        const taxable = q * r - d;
        const gst = taxable * ((parseFloat(it.gst_rate) || 0) / 100);
        inlineReturnValue += taxable + gst;
      }
      inlineReturnValue = Math.round(inlineReturnValue);
    }

    let finalPaidAmount = parseFloat(paid_amount);
    let customer = null;
    if (billData.customer_id) {
      customer = await Party.findByPk(billData.customer_id, { transaction: t });
      if (customer && !customer.credit_allowed) {
        finalPaidAmount = Math.max(0, totalAmount - rawReturn - inlineReturnValue);
      }
    }

    // Fix: reject if paid_amount exceeds bill total
    if (finalPaidAmount > totalAmount + 0.01) {
      await t.rollback();
      return res.status(400).json({ error: `Paid amount (₹${finalPaidAmount.toFixed(2)}) cannot exceed bill total (₹${totalAmount.toFixed(2)})` });
    }

    const effectivePaid = +(finalPaidAmount + rawReturn + inlineReturnValue).toFixed(2);
    const balanceAmount = +(totalAmount - effectivePaid).toFixed(2);

    // Blacklist + credit-limit hard block. Runs AFTER we know the bill's
    // final balance (totalAmount − effectivePaid) so the guard can reject
    // with an accurate "would take outstanding to ₹X" message. Guard
    // returns null when the save is allowed.
    const guard = checkPartyForBillSave({
      party: customer,
      newBillOutstanding: balanceAmount,
      enforceCreditLimit: true,
    });
    if (guard) {
      await t.rollback();
      return res.status(guard.status).json({ error: guard.error });
    }
    let paymentStatus = 'Unpaid';
    if (effectivePaid >= totalAmount) paymentStatus = 'Paid';
    else if (effectivePaid > 0) paymentStatus = 'Partial';

    const bill = await SalesBill.create({
      ...billData,
      total_items: items.length,
      total_quantity: totalQty,
      sub_total: subTotal,
      discount_amount: billDiscountAmt,
      cgst_pct: parseFloat(cgst_pct) || 0,
      sgst_pct: parseFloat(sgst_pct) || 0,
      igst_pct: parseFloat(igst_pct) || 0,
      // Audit BILLS-3 — persist the GST mode the operator picked.
      gst_mode: billWise ? 'bill' : 'product',
      cgst_amount: totalCgst,
      sgst_amount: totalSgst,
      igst_amount: totalIgst,
      cess_amount: totalCess,
      round_off: roundOffValue,
      total_amount: totalAmount,
      paid_amount: finalPaidAmount,
      return_amount: parseFloat(return_amount) || 0,
      balance_amount: balanceAmount,
      payment_status: paymentStatus,
      special_discount: parseFloat(special_discount) || 0,
      other_charges: parseFloat(other_charges) || 0,
      freight_charges: parseFloat(freight_charges) || 0,
    }, { transaction: t });

    // Check negative stock setting once for all items
    const sysSettings = await SystemSettings.findByPk(1, { transaction: t });
    const allowNegativeStock = sysSettings?.allow_negative_stock || false;
    const blockExpiredSales  = !!sysSettings?.block_expired_sales;
    const batchTrackingOn    = !!sysSettings?.batch_tracking_enabled;

    // ── Pre-flight color validation ──────────────────────────────
    // Walks every line whose product is multi-color tracked, ensures
    // a valid color_id is present, and that aggregated qty across
    // lines doesn't exceed the color's current stock. Throws 400-
    // shaped errors loudly rather than rolling back mid-create.
    try {
      await validateBillColorRequirements({
        items: processedItems,
        direction: 'sale',
        allowNegativeStock,
        transaction: t,
      });
    } catch (err) {
      await t.rollback();
      return res.status(err.status || 400).json({ error: err.message });
    }

    // ── Bulk pre-fetch products + godown stocks ────────────────────
    // One query each instead of N per-item fetches. The product map is
    // reused for COGS, batch checks, and stock deduction — eliminating
    // ~2N redundant Product.findByPk calls (one in the loop, one inside
    // isFifoMode→getEffectiveCogsMethod).
    const productIds = [...new Set(processedItems.filter(i => i.product_id).map(i => i.product_id))];
    const productMap = new Map();
    if (productIds.length) {
      const prods = await Product.findAll({ where: { product_id: productIds }, transaction: t });
      for (const p of prods) productMap.set(p.product_id, p);
    }

    // Resolve company-wide COGS method once (cached 30s in costLayers).
    const { getEffectiveCogsMethod } = require('../utils/costLayers');
    const companyCogsMethod = await getEffectiveCogsMethod({ t });

    // INV-H6 — deterministic lock-order + stock cache. Pre-acquire
    // FOR UPDATE locks in product_id ASC order and cache the returned
    // stock values so the per-line loop skips redundant reads.
    const godownStockCache = new Map();
    {
      const distinctKeys = Array.from(new Set(
        processedItems
          .filter(i => i.product_id)
          .map(i => `${i.product_id}|${billData.godown_id}`)
      )).sort();
      for (const k of distinctKeys) {
        const [pid, gid] = k.split('|').map(Number);
        const stock = await getGodownStock({ product_id: pid, godown_id: gid, t, lock: true });
        godownStockCache.set(k, stock);
      }
    }

    const stockLedgerRows = [];
    const affectedProductIds = new Set();

    for (const item of processedItems) {
      const product = item.product_id ? (productMap.get(item.product_id) || null) : null;

      const batchId = (batchTrackingOn && product && product.is_batch_tracked)
        ? (item.batch_id || null)
        : null;
      if (batchTrackingOn && product && product.is_batch_tracked && !batchId) {
        await t.rollback();
        return res.status(400).json({
          error: `"${item.product_name || product.product_name}" is batch-tracked. Pick a batch for this line.`,
        });
      }

      if (batchId) {
        const err = await validateBatchLine({
          product, item: { ...item, batch_id: batchId },
          godownId: billData.godown_id, t,
          blockExpired: blockExpiredSales, isReturn: false,
        });
        if (err) { await t.rollback(); return res.status(400).json({ error: err }); }
      }

      // Resolve FIFO inline using pre-fetched product instead of
      // re-fetching inside isFifoMode.
      let costRate;
      let fifoConsumedRows = null;
      const pm = product?.costing_method;
      const useFifo = item.product_id && ((pm === 'fifo') || (pm !== 'weighted_avg' && companyCogsMethod === 'fifo'));
      if (useFifo) {
        const fifoResult = await consumeFIFO({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          qty: +parseFloat(item.quantity),
          t,
        });
        costRate = fifoResult.consumedRate;
        fifoConsumedRows = fifoResult.consumedRows;
        if (!costRate && product) {
          costRate = +parseFloat(product.weighted_avg_cost || product.purchase_rate || 0);
        }
      } else {
        costRate = await computeCostRateForSale({
          product, batch_id: batchId || null, t,
        });
      }

      if (product && product.is_batch_tracked && !batchId) {
        console.warn(`[salesController.create] batch-tracked product ${product.product_id} saved without batch_id on bill ${bill.sales_bill_id}; cost_rate fell back to wac.`);
      }

      const newItem = await SalesBillItem.create({
        sales_bill_id: bill.sales_bill_id,
        ...item,
        batch_id: batchId,
        cost_rate: costRate,
      }, { transaction: t });

      if (fifoConsumedRows && fifoConsumedRows.length > 0) {
        await recordSaleConsumption({
          sales_bill_item_id: newItem.item_id,
          consumedRows: fifoConsumedRows,
          t,
        });
      }

      if (product) {
        // Use cached stock; track cumulative deltas for same-product lines.
        const cacheKey = `${item.product_id}|${billData.godown_id}`;
        const currentStock = godownStockCache.get(cacheKey) ?? 0;
        const qty = parseFloat(item.quantity);
        const newStock = +(currentStock - qty).toFixed(2);

        if (!allowNegativeStock && newStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for "${item.product_name || product.product_name}" at this godown. Available: ${currentStock}, Requested: ${item.quantity}. Enable "Allow Negative Stock" in Module Settings to proceed.`,
          });
        }

        // Update cache for subsequent lines of the same product.
        godownStockCache.set(cacheKey, newStock);

        await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: -qty, t, skipProductSync: true,
        });
        affectedProductIds.add(item.product_id);

        if (batchId) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: batchId,
            godown_id: billData.godown_id,
            delta: -qty, t,
          });
        }

        if (item.color_id) {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: -qty,
            transaction: t,
          });
        }

        stockLedgerRows.push({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: batchId,
          barcode: item.barcode,
          transaction_type: 'Sales',
          transaction_date: billData.bill_date,
          reference_id: bill.sales_bill_id,
          reference_number: bill.bill_number,
          quantity_in: 0,
          quantity_out: item.quantity,
          rate: item.rate,
          balance_quantity: newStock,
          created_by: req.user.user_id,
        });
      }
    }

    // Batch operations deferred from the per-item loop.
    if (stockLedgerRows.length) {
      await StockLedger.bulkCreate(stockLedgerRows, { transaction: t });
    }
    if (affectedProductIds.size) {
      await syncProductStockFromGodowns([...affectedProductIds], t);
    }

    // ── INLINE RETURN ────────────────────────────────────────────────
    // If the operator added items in the "Return" modal on the sales-bill
    // form, create a paired SalesReturnBill inside the same transaction.
    // The customer must exist on the sale (a walk-in cash sale with
    // customer_id=null can't have a paired return — there's no party
    // ledger to credit). Stock restock + balance recalc happen below.
    let inlineReturnBill = null;
    if (inline_return && Array.isArray(inline_return.items) && inline_return.items.length > 0) {
      if (!billData.customer_id) {
        await t.rollback();
        return res.status(400).json({ error: 'Inline returns require a customer (walk-in cash sales cannot have a paired return).' });
      }
      try {
        inlineReturnBill = await createInlineReturn({
          customer_id: billData.customer_id,
          billDate:    billData.bill_date,
          items:       inline_return.items,
          reason:      inline_return.reason,
          // Reuse the same intra/inter-state resolution the sale used so
          // the return's GST routing matches the sale.
          isInterState: interState,
          // The paired return restocks at the same godown the sale shipped
          // from — goods physically came back to the same warehouse.
          godown_id: billData.godown_id,
          req, t,
        });
        // Store the inline return total on the SalesBill so the Return
        // column in the sales list displays it. To avoid double-counting
        // in balanceHelper (which subtracts BOTH SalesBill.return_amount
        // AND SalesReturnBill.balance_amount), zero out the return bill's
        // balance — the credit is already reflected via the sale's
        // return_amount + effectivePaid.
        await bill.update({ return_amount: inlineReturnBill.total_amount }, { transaction: t });
        await inlineReturnBill.update({
          reference_bill_id: bill.sales_bill_id,
          balance_amount: 0, refund_amount: inlineReturnBill.total_amount, refund_status: 'Refunded',
        }, { transaction: t });
      } catch (rerr) {
        await t.rollback();
        return res.status(400).json({ error: 'Inline return: ' + rerr.message });
      }
    }

    // Recalculate customer balance from scratch — runs AFTER inline return
    // so the recompute sees both the new sale and the new return rows.
    // Cash party (is_system_cash) bills are always fully paid at creation,
    // so reconcile + balance recompute would scan 10k+ bills for no change.
    const isCashCustomer = !!(customer && customer.is_system_cash);
    if (billData.customer_id && !isCashCustomer) {
      await reconcileBillsForParty(billData.customer_id, t);
      await recalculatePartyBalance(billData.customer_id, t);
    }

    if (draft_id) {
      await SalesBillDraft.destroy({
        where: { draft_id },
        transaction: t,
      });
    }

    {
      const billForPosting = await SalesBill.findByPk(bill.sales_bill_id, {
        include: [{ model: Party, as: 'customer' }],
        transaction: t,
      });
      const vouchers = await buildSalesBillVouchers(billForPosting, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
      if (!isCashCustomer) {
        await syncAutoReceiptForBill({ kind: 'sales', bill: billForPosting, t });
      }
    }

    await t.commit();

    if (idempotency_key) {
      idempotencyCache.set('sales_create', idempotency_key, bill.sales_bill_id);
    }

    if (lockGuard.overrideUsed) {
      await logComplianceEvent({
        event_type:       lockResult.status === 'hard_override_granted' ? 'hard_override' : 'soft_override',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'sales_bill',
        target_id:        bill.sales_bill_id,
        target_label:     `Sale ${bill.bill_number || `#${bill.sales_bill_id}`} dated ${bill.bill_date}`,
        target_date:      bill.bill_date,
        reason:           lockGuard.reason,
        metadata:         { lock_date: lockResult.lockDate },
      });
    }

    const result = await SalesBill.findByPk(bill.sales_bill_id, {
      include: [
        { model: Party, as: 'customer' },
        { model: SalesBillItem, as: 'items' },
      ],
    });

    res.status(201).json(result);
  } catch (error) {
    // Guard against double-rollback: early validation branches already rolled
    // back the transaction and returned. If a subsequent `res.json(...)` call
    // threw (e.g. client disconnected mid-response), Sequelize would reject
    // a second rollback with "Transaction cannot be rolled back because it
    // has been finished with state: rollback". The `t.finished` check —
    // which Sequelize sets to 'commit' | 'rollback' after either completes —
    // prevents that secondary error from masking the real one.
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Create sale error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.update = async (req, res) => {
  // ── Back-dated entry policy (always-on, no override) ───────────────
  // Runs first because it's a hard reject — if policy blocks back-
  // dating for this user, the fiscal-lock override flow would just
  // confuse them.
  {
    const bd = require('../utils/backdatedGuard');
    const check = await bd.checkBackdated({
      voucherDate: req.body && req.body.bill_date,
      user: req.user,
    });
    if (!check.ok) {
      return res.status(403).json({ error: check.reason, code: check.code });
    }
  }

  // ── Fiscal-lock check on edit ───────────────────────────────────────
  // Probes BOTH old and new bill_date so moves OUT of a locked FY
  // are gated too (rewriting history either direction is auditable).
  // No-op when compliance mode is off.
  const existing = await SalesBill.findByPk(req.params.id, { attributes: ['sales_bill_id', 'bill_date', 'bill_number', 'is_cancelled'] });
  if (!existing) return res.status(404).json({ error: 'Bill not found' });
  if (existing.is_cancelled) return res.status(400).json({ error: 'Cannot edit a cancelled bill' });

  const oldDateStr = existing.bill_date && String(existing.bill_date).slice(0, 10);
  const newDateStr = req.body?.bill_date && String(req.body.bill_date).slice(0, 10);
  const lockGuard = await applyFiscalLockGuard(req, res, earlierDate(oldDateStr, newDateStr));
  if (!lockGuard.ok) return;
  const lockResult = lockGuard.lockResult;

  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    let { items: newItems, paid_amount = 0, return_amount = 0, special_discount = 0, other_charges = 0, freight_charges = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, gst_mode, bill_mode, amount, gst_rate: amountGstRate, hsn_code: amountHsnCode, description: amountDescription, ...billData } = req.body;

    // Same amount-only synthesis as create() — see comment block there.
    if (bill_mode === 'amount') {
      const amt = parseFloat(amount);
      const rate = parseFloat(amountGstRate || 0);
      if (!isFinite(amt) || amt <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'Amount must be greater than 0 for amount-only bills.' });
      }
      if (!isLegalGstSlab(rate)) {
        await t.rollback();
        return res.status(400).json({ error: gstSlabError(rate) });
      }
      const hsn  = (amountHsnCode || '9999').toString().trim() || '9999';
      const desc = (amountDescription || 'Service / Misc').toString().trim() || 'Service / Misc';
      newItems = [{
        product_id:          null,
        barcode:             null,
        category_id:         null,
        category_name:       '',
        product_name:        desc,
        size:                '',
        article_number:      '',
        hsn_code:             hsn,
        unit_type:           'OTH',
        quantity:            1,
        rate:                amt,
        discount_percentage: 0,
        discount_amount:     0,
        mrp:                 0,
        gst_rate:            rate,
        quantity_per_box:    1,
      }];
      gst_mode = 'product';
      cgst_pct = 0; sgst_pct = 0; igst_pct = 0;
      billData.description = desc;
    }
    billData.bill_mode = bill_mode === 'amount' ? 'amount' : 'item';

    const existingBill = await SalesBill.findByPk(id, {
      include: [{ model: SalesBillItem, as: 'items' }],
      transaction: t,
    });
    if (!existingBill) { await t.rollback(); return res.status(404).json({ error: 'Bill not found' }); }
    if (existingBill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Cannot edit a cancelled bill' }); }

    // SER-7: bill_number is server-generated and must never be overwritten by
    // a client PUT body. Strip it so the spread into existingBill.update() cannot
    // silently clobber the sequential number.
    delete billData.bill_number;

    // Resolve target godown for this edit. If the body specifies one,
    // validate it; if not, retain the existing bill's godown. Same
    // permission gate as create — the user must have access to the
    // chosen godown.
    if (billData.godown_id != null) {
      const denied = denyIfGodownInaccessible(billData.godown_id, req.user);
      if (denied) { await t.rollback(); return res.status(403).json({ error: denied }); }
    } else {
      billData.godown_id = existingBill.godown_id;
    }

    // Step 1: Reverse old stock effects at the EXISTING bill's godown.
    // Edits don't migrate inventory between godowns — that's what stock
    // transfers are for. Even if the operator changes godown_id on edit,
    // the reversal goes back to the original godown (where the stock was
    // taken from); the apply-new step below pushes the deduction at the
    // updated godown.
    const oldGodownId = existingBill.godown_id;
    for (const oldItem of existingBill.items) {
      if (oldItem.product_id && oldGodownId) {
        await applyGodownStockDelta({
          product_id: oldItem.product_id, godown_id: oldGodownId,
          delta: +parseFloat(oldItem.quantity), t,
        });
        // Restore per-batch on-hand for the OLD batch the line had been
        // attached to. Mirror of the godown-level reverse — both must
        // move together so a rollback restores both consistently. The
        // new batch (which may differ if the operator changed it) gets
        // its decrement in the apply-new pass below.
        if (oldItem.batch_id) {
          await applyBatchStockDelta({
            product_id: oldItem.product_id, batch_id: oldItem.batch_id,
            godown_id: oldGodownId,
            delta: +parseFloat(oldItem.quantity), t,
          });
        }
      }
    }
    // Reverse the per-color stock from the OLD lines. Re-apply happens
    // inside the new-items loop below using the updated color_id, so
    // an edit that changes color X→Y correctly restores X and depletes Y.
    await reverseBillColorStock({
      items: existingBill.items,
      direction: 'sale',
      transaction: t,
    });

    // Step 2 — Audit H5: write paired reversal entries for the existing
    // ledger rows instead of destroying them. The Stock Movement page
    // can then reconstruct the lifecycle (sold → unsold → resold) for
    // every edit. Net effect on SUM(quantity_in - quantity_out) is zero
    // because the reversal swaps qty_in <-> qty_out; the new entries
    // (written by Step 5+) re-record the post-edit state. Total rows
    // tripled per edit (original + reversal + new) — verbose but honest.
    //
    // skipIdempotencyCheck=true: edit can fire multiple times on the same
    // bill (every Save re-edits); we want each edit to write its own
    // reversal pair. The helper uses is_reversal_of_ledger_id to find
    // only the currently-active rows, so it never re-reverses.
    await writeStockLedgerReversal({
      referenceId: existingBill.sales_bill_id,
      transactionType: 'Sales',
      reason: `Bill ${existingBill.bill_number} edited`,
      userId: req.user?.user_id,
      t,
      skipIdempotencyCheck: true,
    });

    // Audit H6 v2 — exact FIFO layer reversal BEFORE we destroy items.
    // We need the consumption rows to be queryable via the existing
    // SalesBillItem rows; once items are destroyed the CASCADE on
    // sale_line_layer_consumptions would remove the consumption rows
    // and the layer qty would never be restored. Order matters.
    await reverseConsumptionForBill({ sales_bill_id: id, t });

    // Step 3: Delete old items
    await SalesBillItem.destroy({ where: { sales_bill_id: id }, transaction: t });

    // Step 3: Process new items
    let subTotal = 0, totalQty = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;
    const processedItems = [];

    // Same mode detection as create() — see there for rationale.
    const billWise = gst_mode === 'bill'
      ? true
      : gst_mode === 'product'
        ? false
        : (parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0);

    // PASS 1: compute per-line post-item-discount base. GST must be deferred
    // until we know the bill-level discount to allocate pro-rata.
    for (const item of newItems) {
      // Same clamp rules as create() — reject invalid inputs loudly rather than
      // silently masking them with `|| 0`, which could let a 150% discount
      // flip taxable to negative or a negative qty invert the ledger sign.
      const qty  = parseFloat(item.quantity);
      const rate = parseFloat(item.rate);
      const itemDiscPct = parseFloat(item.discount_percentage || 0);
      // W15: qty > 0 required — a zero-quantity line has no stock or financial
      // impact and would silently pollute the invoice with a dummy row.
      if (!isFinite(qty) || qty <= 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Quantity must be greater than zero (got "${item.quantity}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(rate) || rate < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Rate must be a non-negative number (got "${item.rate}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Item discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").` });
      }
      // CR-6 — per-line GST rate must be a legal Indian slab.
      if (item.gst_rate !== undefined && item.gst_rate !== null && !isLegalGstSlab(item.gst_rate)) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `${gstSlabError(item.gst_rate)} (line "${item.product_name || 'item'}")` });
      }
      const lineTotal = roundTo(qty * rate, 2);  // Audit MONEY-7: round-half-away-from-zero
      const discountAmt = roundTo(lineTotal * itemDiscPct / 100, 2);  // Audit MONEY-7
      const postItemTaxable = +(lineTotal - discountAmt).toFixed(2);

      processedItems.push({
        ...item,
        // Audit (functional-sim bug) — PR #44's GST-C4 inclusive block
        // at line ~1734 reads `it._lineTotal` to recompute subTotal.
        // The CREATE path stored `_lineTotal` on processedItems; the
        // UPDATE path didn't. The undefined read collapsed subTotal to
        // 0 on every edit, and `buildSalesBillVouchers` then skipped
        // the Sales-Account credit (subTotal-itemDisc was 0), making
        // the rebuilt voucher fail with
        //   "postVoucher: unbalanced — debits X ≠ credits gst-only".
        // EVERY sales-bill edit 500-crashed. Mirror the create-path push.
        _lineTotal: lineTotal,
        _postItemTaxable: postItemTaxable,
        taxable_amount: postItemTaxable,
        discount_amount: discountAmt,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        total_amount: 0,
      });

      subTotal += lineTotal;
      totalQty += qty;
    }

    const billDiscPct2 = parseFloat(billData.discount_percentage || 0);
    if (!isFinite(billDiscPct2) || billDiscPct2 < 0 || billDiscPct2 > 100) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount % must be between 0 and 100 (got ${billDiscPct2}%).` });
    }
    // `let` so GST-C4 reverse-compute below can refresh after master snapshot.
    let billDiscountAmt = billData.discount_amount != null
      ? parseFloat(billData.discount_amount)
      : +(subTotal * billDiscPct2 / 100).toFixed(2);
    let itemDiscountTotal2 = processedItems.reduce((s, it) => s + (parseFloat(it.discount_amount) || 0), 0);
    const postItemBase2 = +(subTotal - itemDiscountTotal2).toFixed(2);
    if (!isFinite(billDiscountAmt) || billDiscountAmt < 0) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount amount must be non-negative (got ${billDiscountAmt}).` });
    }
    if (billDiscountAmt > postItemBase2 + 0.01) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount (₹${billDiscountAmt.toFixed(2)}) cannot exceed post-item-discount total (₹${postItemBase2.toFixed(2)}).` });
    }
    // Audit MONEY-5 — mirror of the create path: fold freight + other_charges
    // into the taxable base when the company-wide flag is set so an EDIT
    // of an existing bill ends up with the same GST math the create path
    // produces.
    const updSettings = await SystemSettings.findByPk(1, { transaction: t });
    const freightChargesU = +(parseFloat(freight_charges || 0) || 0);
    const otherChargesU   = +(parseFloat(other_charges || 0)   || 0);
    const includeChargesInTaxableU = updSettings?.freight_other_in_taxable !== false;
    const extraTaxableAddU = includeChargesInTaxableU ? roundTo(freightChargesU + otherChargesU, 2) : 0;

    // `let` so GST-C4 reverse-compute can refresh these after master snapshot.
    let taxableTotal = +(subTotal - itemDiscountTotal2 - billDiscountAmt + extraTaxableAddU).toFixed(2);

    // PASS 2: allocate bill-level discount pro-rata so GST is on the post-
    // discount (GST-law-compliant) base for every line.
    let postItemTotal2 = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
    let billDiscRatio2 = postItemTotal2 > 0 ? billDiscountAmt / postItemTotal2 : 0;
    let extraTaxableRatioU = postItemTotal2 > 0 ? extraTaxableAddU / postItemTotal2 : 0;

    // Same inter-state resolution as create() — see comment there.
    const interState2 = billWise ? false : await _resolveInterState(billData, t);

    // Server-side gst_rate + hsn_code snapshot — same as create() (audit C4 + STOCK-5).
    const productIdsForSnapshot2 = [
      ...new Set(processedItems.map(it => it.product_id).filter(Boolean)),
    ];
    if (productIdsForSnapshot2.length > 0) {
      const masterProducts2 = await Product.findAll({
        where: { product_id: { [Op.in]: productIdsForSnapshot2 } },
        attributes: ['product_id', 'gst_rate', 'hsn_code', 'unit_of_measurement', 'is_tax_inclusive', 'mrp'],
        transaction: t,
      });
      const masterById2 = new Map(masterProducts2.map(p => [p.product_id, p]));
      for (const it of processedItems) {
        if (it.product_id && masterById2.has(it.product_id)) {
          const mp = masterById2.get(it.product_id);
          it.gst_rate = parseFloat(mp.gst_rate) || 0;
          if (mp.hsn_code) it.hsn_code = mp.hsn_code;
          // GST-H5 — also snapshot unit on update (see create-path comment).
          if (mp.unit_of_measurement) it.unit_type = mp.unit_of_measurement;
          // GST-C4 — snapshot tax-inclusive flag for update path.
          it._inclusive = !!mp.is_tax_inclusive;
          // Audit NEW-MED-3 — snapshot MRP from master (mirror create).
          if (mp.mrp !== undefined && mp.mrp !== null) {
            it.mrp = parseFloat(mp.mrp) || 0;
          }
        }
      }
      // GST-C4 — same reverse-compute as create-path. See the detailed
      // comment block there. We reverse the FULL line currency (lineTotal,
      // discount, taxable) for inclusive lines and re-sum subTotal.
      for (const it of processedItems) {
        if (it._inclusive && it.gst_rate > 0) {
          const div = 1 + it.gst_rate / 100;
          it._lineTotal       = roundTo((parseFloat(it._lineTotal) || 0) / div, 2);
          it.discount_amount  = roundTo((parseFloat(it.discount_amount) || 0) / div, 2);
          it._postItemTaxable = roundTo((parseFloat(it._postItemTaxable) || 0) / div, 2);
          it.taxable_amount   = it._postItemTaxable;
        }
      }
      // GST-C4 — refresh derived values (mirror of create-path block).
      const hasInclusive2 = processedItems.some(it => it._inclusive);
      subTotal = roundTo(
        processedItems.reduce((s, it) => s + (parseFloat(it._lineTotal) || 0), 0),
        2,
      );
      if (hasInclusive2) {
        itemDiscountTotal2 = processedItems.reduce(
          (s, it) => s + (parseFloat(it.discount_amount) || 0), 0,
        );
        if (billData.discount_amount == null && billDiscPct2 > 0) {
          billDiscountAmt = +(subTotal * billDiscPct2 / 100).toFixed(2);
        }
        taxableTotal = +(subTotal - itemDiscountTotal2 - billDiscountAmt + extraTaxableAddU).toFixed(2);
        postItemTotal2 = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
        billDiscRatio2 = postItemTotal2 > 0 ? billDiscountAmt / postItemTotal2 : 0;
        extraTaxableRatioU = postItemTotal2 > 0 ? extraTaxableAddU / postItemTotal2 : 0;
      }
    }

    for (const it of processedItems) {
      // Audit MONEY-5 — include the pro-rata freight+other ratio so the
      // GST base matches what the create path produces.
      const lineBase = +(it._postItemTaxable * (1 - billDiscRatio2 + extraTaxableRatioU)).toFixed(2);
      it.taxable_amount = lineBase;
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(lineBase, it.gst_rate || 0, interState2);
      it.cgst_amount = gst.cgst;
      it.sgst_amount = gst.sgst;
      it.igst_amount = gst.igst;
      it.total_amount = +(lineBase + gst.cgst + gst.sgst + gst.igst).toFixed(2);
      if (!billWise) {
        totalCgst += gst.cgst;
        totalSgst += gst.sgst;
        totalIgst += gst.igst;
      }
      delete it._postItemTaxable;
    }

    if (billWise) {
      // Audit H2 — splitBillWiseGst gives the rounding residual to SGST so
      // CGST+SGST sum to the combined tax exactly (no 1-paisa drift).
      const _spl = splitBillWiseGst(taxableTotal, cgst_pct, sgst_pct, igst_pct);
      totalCgst = _spl.cgst;
      totalSgst = _spl.sgst;
      totalIgst = _spl.igst;
      // Audit P2-D — allocate bill-wise totals pro-rata across lines.
      if (processedItems.length > 0 && taxableTotal > 0) {
        let allocCgst = 0, allocSgst = 0, allocIgst = 0;
        for (let i = 0; i < processedItems.length; i++) {
          const it = processedItems[i];
          const ratio = it.taxable_amount / taxableTotal;
          if (i < processedItems.length - 1) {
            it.cgst_amount = roundTo(totalCgst * ratio, 2);
            it.sgst_amount = roundTo(totalSgst * ratio, 2);
            it.igst_amount = roundTo(totalIgst * ratio, 2);
          } else {
            it.cgst_amount = +(totalCgst - allocCgst).toFixed(2);
            it.sgst_amount = +(totalSgst - allocSgst).toFixed(2);
            it.igst_amount = +(totalIgst - allocIgst).toFixed(2);
          }
          it.total_amount = +(it.taxable_amount + it.cgst_amount + it.sgst_amount + it.igst_amount).toFixed(2);
          allocCgst += it.cgst_amount;
          allocSgst += it.sgst_amount;
          allocIgst += it.igst_amount;
        }
      }
    }

    // Audit NEW-HI-1 — 0%-rate invariant (sales update). Mirror of the
    // create-path block; see that comment for rationale.
    let zeroRateRefundU = { cgst: 0, sgst: 0, igst: 0 };
    for (const it of processedItems) {
      if (parseFloat(it.gst_rate || 0) === 0) {
        zeroRateRefundU.cgst += parseFloat(it.cgst_amount) || 0;
        zeroRateRefundU.sgst += parseFloat(it.sgst_amount) || 0;
        zeroRateRefundU.igst += parseFloat(it.igst_amount) || 0;
        it.cgst_amount = 0;
        it.sgst_amount = 0;
        it.igst_amount = 0;
        if (it.cess_amount !== undefined) it.cess_amount = 0;
        it.total_amount = +(parseFloat(it.taxable_amount) || 0).toFixed(2);
      }
    }
    if (zeroRateRefundU.cgst > 0.005 || zeroRateRefundU.sgst > 0.005 || zeroRateRefundU.igst > 0.005) {
      totalCgst = +(totalCgst - zeroRateRefundU.cgst).toFixed(2);
      totalSgst = +(totalSgst - zeroRateRefundU.sgst).toFixed(2);
      totalIgst = +(totalIgst - zeroRateRefundU.igst).toFixed(2);
    }
    if (!billWise) {
      cgst_pct = 0; sgst_pct = 0; igst_pct = 0;
    }

    // Audit MONEY-5 — mirror of the create-path total formula.
    const extraOnTotalU = includeChargesInTaxableU ? 0 : (otherChargesU + freightChargesU);
    const { roundedAmount, roundOffValue } = roundOff(
      taxableTotal + totalCgst + totalSgst + totalIgst + totalCess
      - parseFloat(special_discount || 0)
      + extraOnTotalU
    );
    const totalAmount = roundedAmount;

    // Enforce full payment if customer has credit not allowed.
    // Subtract return_amount so the forced payment covers only the net
    // amount — otherwise effectivePaid (paid + return) exceeds totalAmount,
    // either triggering the BILLS-8 over-pay rejection or leaving a
    // negative balance after reconciliation.
    const returnAmt          = parseFloat(return_amount || 0);
    let finalPaidAmount2 = parseFloat(paid_amount);
    let customer2 = null;
    if (billData.customer_id) {
      customer2 = await Party.findByPk(billData.customer_id, { transaction: t });
      if (customer2 && !customer2.credit_allowed) {
        finalPaidAmount2 = Math.max(0, totalAmount - returnAmt);
      }
    }

    // Preserve payments already applied via the Receipt module.
    // balance_amount was set as: total - paid_at_billing - return_amount - linkedReceipts
    // So: linkedReceipts = total - balance - paid_at_billing - return_amount
    const oldPaidAtBilling2  = parseFloat(existingBill.paid_amount)    || 0;
    const oldBalance2        = parseFloat(existingBill.balance_amount)  || 0;
    const oldTotal2          = parseFloat(existingBill.total_amount)    || 0;
    const oldReturnAmount2   = parseFloat(existingBill.return_amount)   || 0;
    const linkedReceipts     = Math.max(0, +(oldTotal2 - oldBalance2 - oldPaidAtBilling2 - oldReturnAmount2).toFixed(2));
    const totalEffectivePaid2 = +(finalPaidAmount2 + returnAmt + linkedReceipts).toFixed(2);

    // Audit BILLS-8 — refuse an edit that would leave the bill
    // over-paid. If linkedReceipts (manual receipts already pointing
    // at this bill via bill_payment_allocations) plus at-billing
    // payment plus walk-in return exceeds the new total, the
    // allocation table would carry MORE money than the bill costs.
    // Math.max(0, …) would silently clamp balance to 0, breaking
    // the I1 invariant (paid_amount == Σ allocations).
    if (totalEffectivePaid2 > totalAmount + 0.01) {
      await t.rollback();
      return res.status(400).json({
        error:
          `This edit would over-pay the bill: linked receipts (₹${linkedReceipts.toFixed(2)}) + ` +
          `at-billing paid (₹${finalPaidAmount2.toFixed(2)}) + walk-in return (₹${returnAmt.toFixed(2)}) = ` +
          `₹${totalEffectivePaid2.toFixed(2)}, but the new total is ₹${totalAmount.toFixed(2)}. ` +
          `Cancel or reduce the linked receipts before editing the bill down.`,
        code: 'EDIT_OVERPAYS_BILL',
      });
    }

    const balanceAmount      = Math.max(0, +(totalAmount - totalEffectivePaid2).toFixed(2));

    let paymentStatus = 'Unpaid';
    if (totalEffectivePaid2 >= totalAmount) paymentStatus = 'Paid';
    else if (totalEffectivePaid2 > 0)       paymentStatus = 'Partial';

    // Blacklist + credit-limit block on edit. The customer's current_balance
    // already reflects the OLD bill's balance, so we pass it through as
    // oldBillOutstanding — otherwise an edit that just keeps the same total
    // would falsely trip the limit. Skipping the limit check when the bill's
    // customer changes isn't safe either, so for cross-customer edits the
    // guard conservatively enforces against the new customer as if this
    // were a fresh bill.
    const isSameCustomer = existingBill.customer_id === billData.customer_id;
    const guard2 = checkPartyForBillSave({
      party: customer2,
      newBillOutstanding: balanceAmount,
      oldBillOutstanding: isSameCustomer ? oldBalance2 : 0,
      enforceCreditLimit: true,
    });
    if (guard2) {
      await t.rollback();
      return res.status(guard2.status).json({ error: guard2.error });
    }

    await existingBill.update({
      ...billData,
      total_items: newItems.length,
      total_quantity: totalQty,
      sub_total: subTotal,
      discount_amount: billDiscountAmt,
      cgst_pct: parseFloat(cgst_pct) || 0,
      sgst_pct: parseFloat(sgst_pct) || 0,
      igst_pct: parseFloat(igst_pct) || 0,
      // Audit BILLS-3 — persist mode on update too.
      gst_mode: billWise ? 'bill' : 'product',
      cgst_amount: totalCgst,
      sgst_amount: totalSgst,
      igst_amount: totalIgst,
      cess_amount: totalCess,
      round_off: roundOffValue,
      total_amount: totalAmount,
      paid_amount: finalPaidAmount2,
      return_amount: parseFloat(return_amount) || 0,
      balance_amount: balanceAmount,
      payment_status: paymentStatus,
      special_discount: parseFloat(special_discount) || 0,
      other_charges: parseFloat(other_charges) || 0,
      freight_charges: parseFloat(freight_charges) || 0,
    }, { transaction: t });

    // Check negative stock setting for update
    const sysSettingsU = await SystemSettings.findByPk(1, { transaction: t });
    const allowNegStockU = sysSettingsU?.allow_negative_stock || false;
    const blockExpiredU  = !!sysSettingsU?.block_expired_sales;
    const batchTrackingOnU = !!sysSettingsU?.batch_tracking_enabled;

    // Pre-flight color validation for the update path. Same rules as
    // create — required color_id for multi-color products, color must
    // belong to product, stock check (which now reads the post-reverse
    // current_stock since we just credited it back).
    try {
      await validateBillColorRequirements({
        items: processedItems,
        direction: 'sale',
        allowNegativeStock: allowNegStockU,
        transaction: t,
      });
    } catch (err) {
      await t.rollback();
      return res.status(err.status || 400).json({ error: err.message });
    }

    for (const item of processedItems) {
      // Same pattern as create(): fetch the product once, snapshot its
      // per-mode cost via the shared helper, reuse for stock update.
      // Cost is re-snapshotted on edit so if the user corrects the line
      // (e.g. fixes a wrong product on a bill) the COGS follows the new
      // product's cost — matches the user's mental model of "this edit
      // supersedes the original". For single-mode products the
      // snapshot uses CURRENT wac, which means an edit after later
      // purchases shifts cost_rate to reflect the new average. That's
      // by-design — edits are point-in-time corrections.
      let product = null;
      if (item.product_id) {
        product = await Product.findByPk(item.product_id, { transaction: t });
      }
      const batchIdU = (batchTrackingOnU && product && product.is_batch_tracked)
        ? (item.batch_id || null) : null;
      if (batchTrackingOnU && product && product.is_batch_tracked && !batchIdU) {
        await t.rollback();
        return res.status(400).json({
          error: `"${item.product_name || product.product_name}" is batch-tracked. Pick a batch for this line.`,
        });
      }
      if (batchIdU) {
        const err = await validateBatchLine({
          product, item: { ...item, batch_id: batchIdU },
          godownId: billData.godown_id, t,
          blockExpired: blockExpiredU, isReturn: false,
        });
        if (err) { await t.rollback(); return res.status(400).json({ error: err }); }
      }
      // Audit H6 — same FIFO/wac branch as create() on the edit path.
      // Per-layer consumption recording fires below if FIFO mode is on.
      let costRate;
      let fifoConsumedRowsU = null;
      if (item.product_id && await isFifoMode(t, item.product_id)) {
        const fifoResult = await consumeFIFO({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          qty: +parseFloat(item.quantity),
          t,
        });
        costRate = fifoResult.consumedRate;
        fifoConsumedRowsU = fifoResult.consumedRows;
        if (!costRate && product) {
          costRate = +parseFloat(product.weighted_avg_cost || product.purchase_rate || 0);
        }
      } else {
        costRate = await computeCostRateForSale({
          product, batch_id: batchIdU || null, t,
        });
      }

      const newItemU = await SalesBillItem.create({
        sales_bill_id: id,
        ...item,
        batch_id: batchIdU,
        cost_rate: costRate,
      }, { transaction: t });

      // Audit H6 v2 — record consumption trail on edit-re-create too.
      if (fifoConsumedRowsU && fifoConsumedRowsU.length > 0) {
        await recordSaleConsumption({
          sales_bill_item_id: newItemU.item_id,
          consumedRows: fifoConsumedRowsU,
          t,
        });
      }

      if (product) {
        // Audit H7: lock the PGS row before the pre-check.
        const currentStock = await getGodownStock({
          product_id: item.product_id, godown_id: billData.godown_id, t,
          lock: true,
        });
        const newStock = +(currentStock - parseFloat(item.quantity)).toFixed(2);

        if (!allowNegStockU && newStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for "${item.product_name || product.product_name}" at this godown. Available: ${currentStock}, Requested: ${item.quantity}. Enable "Allow Negative Stock" in Module Settings to proceed.`,
          });
        }

        await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: -parseFloat(item.quantity), t,
        });
        if (batchIdU) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: batchIdU,
            godown_id: billData.godown_id,
            delta: -parseFloat(item.quantity), t,
          });
        }
        // Re-apply per-color decrement at the new color_id (the OLD
        // colors were already restored above; this is the new pick).
        if (item.color_id) {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: -parseFloat(item.quantity),
            transaction: t,
          });
        }
        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: batchIdU,
          barcode: item.barcode,
          transaction_type: 'Sales',
          transaction_date: billData.bill_date,
          reference_id: existingBill.sales_bill_id,
          reference_number: existingBill.bill_number,
          quantity_in: 0, quantity_out: item.quantity,
          rate: item.rate, balance_quantity: newStock,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    // Audit P2-A — reconcile before recalc on every touched party so
    // bill balances re-flow against the now-edited total. Reconcile is
    // idempotent post-Tier 1 fix, so this is cheap to call.
    const oldCustomerId = existingBill.customer_id;
    const newCustomerId = billData.customer_id;
    if (oldCustomerId) {
      await reconcileBillsForParty(oldCustomerId, t);
      await recalculatePartyBalance(oldCustomerId, t);
    }
    if (newCustomerId && newCustomerId !== oldCustomerId) {
      await reconcileBillsForParty(newCustomerId, t);
      await recalculatePartyBalance(newCustomerId, t);
    }

    // ── Double-entry: reverse old, post new ──
    // Both source types (sales_bill + the optional sales_bill_receipt for
    // paid_amount) need reversing so a re-post is idempotent.
    // SER-6: date reversals to the ORIGINAL bill date so they cancel within
    // the same accounting period as the original entries.
    await reverseVoucher({
      sourceType: 'sales_bill', sourceId: existingBill.sales_bill_id,
      reason: 'Sales bill edited', userId: req.user && req.user.user_id, transaction: t,
      reversalDate: existingBill.bill_date,
    });
    await reverseVoucher({
      sourceType: 'sales_bill_receipt', sourceId: existingBill.sales_bill_id,
      reason: 'Sales bill edited', userId: req.user && req.user.user_id, transaction: t,
      reversalDate: existingBill.bill_date,
    });
    {
      const refreshed = await SalesBill.findByPk(existingBill.sales_bill_id, {
        include: [{ model: Party, as: 'customer' }],
        transaction: t,
      });
      const vouchers = await buildSalesBillVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
      // Two-way ledger sync — handles edit cases A-D from the brief:
      // amount up/down, paid_amount up/down, paid_amount → 0, account
      // changed. The service inspects the refreshed bill and inserts /
      // updates / deletes the auto-receipt row + allocation to match.
      await syncAutoReceiptForBill({ kind: 'sales', bill: refreshed, t });
    }

    await t.commit();

    // Compliance audit log for edit-with-override. Best-effort, after
    // commit so a log failure can't undo the save. Mirrors the create()
    // pattern but uses the `post_close_edit` event type plus carries
    // BOTH dates in metadata so the auditor can see whether the edit
    // moved the bill INTO or OUT OF the locked period (or just
    // re-saved a backdated bill).
    if (lockGuard.overrideUsed) {
      await logComplianceEvent({
        event_type:       'post_close_edit',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'sales_bill',
        target_id:        existingBill.sales_bill_id,
        target_label:     `Sale ${existingBill.bill_number || `#${existingBill.sales_bill_id}`} edited (date ${oldDateStr || '—'} → ${newDateStr || oldDateStr || '—'})`,
        target_date:      newDateStr || oldDateStr || null,
        reason:           lockGuard.reason,
        metadata:         { lock_date: lockResult.lockDate, old_bill_date: oldDateStr, new_bill_date: newDateStr || oldDateStr },
      });
    }

    const result = await SalesBill.findByPk(existingBill.sales_bill_id, {
      include: [
        { model: Party, as: 'customer' },
        { model: SalesBillItem, as: 'items' },
      ],
    });

    res.json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Update sale error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.cancel = async (req, res) => {
  // ── Fiscal-lock check on cancel ─────────────────────────────────────
  // Cancelling a backdated bill is a write that touches the locked
  // period — the bill flips to is_cancelled=true, stock reverses, the
  // auto-receipt soft-cancels. The auditor needs the same audit row a
  // create or edit produces, gated by the same role/password matrix.
  // Lock probe = the bill's own bill_date (we're not changing the date,
  // just nulling the bill's effect on the period).
  const billPreview = await SalesBill.findByPk(req.params.id, { attributes: ['sales_bill_id', 'bill_date', 'bill_number', 'is_cancelled'] });
  if (!billPreview) return res.status(404).json({ error: 'Bill not found' });
  if (billPreview.is_cancelled) return res.status(400).json({ error: 'Bill already cancelled' });

  const cancelDateStr = billPreview.bill_date && String(billPreview.bill_date).slice(0, 10);
  const lockGuard = await applyFiscalLockGuard(req, res, cancelDateStr);
  if (!lockGuard.ok) return;
  const lockResult = lockGuard.lockResult;

  const t = await sequelize.transaction();
  try {
    const bill = await SalesBill.findByPk(req.params.id, {
      include: [{ model: SalesBillItem, as: 'items' }],
      transaction: t,
    });
    if (!bill) { await t.rollback(); return res.status(404).json({ error: 'Bill not found' }); }
    if (bill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Bill already cancelled' }); }

    // ── Block if any active Receipt from the Payment tab covers this bill ────
    // Check the new bill_allocations JSONB, the legacy reference_bill_id
    // field, AND the bill_payment_allocations rows (FIFO auto-applied
    // receipts whose JSONB intent is empty — Audit BILLS-4). Without
    // the third check, an "on account" receipt that the system silently
    // re-FIFOs to the next-oldest bill on this bill's cancellation
    // would not be flagged, and the operator's expectation of "you have
    // active receipts here" would be wrong.
    const billId = bill.sales_bill_id;
    // Auto-receipts (source='auto_from_bill') are system-generated mirrors
    // of the at-billing payment — they should be soft-cancelled WITH the
    // bill, not block it. Only manually-created receipts block cancellation.
    const [linkedReceiptRows] = await sequelize.query(
      `SELECT DISTINCT pr.transaction_number
         FROM payments_receipts pr
        WHERE pr.is_cancelled = false
          AND pr.transaction_type = 'Receipt'
          AND COALESCE(pr.source, '') <> 'auto_from_bill'
          AND (
            (pr.bill_allocations IS NOT NULL
             AND pr.bill_allocations @> :jsonCheck::jsonb)
            OR (pr.reference_bill_id = :billId AND pr.reference_bill_type = 'Sales')
            OR EXISTS (
              SELECT 1 FROM bill_payment_allocations bpa
               WHERE bpa.transaction_id = pr.transaction_id
                 AND bpa.bill_type = 'Sales'
                 AND bpa.bill_id   = :billId
            )
          )`,
      {
        replacements: {
          jsonCheck: JSON.stringify([{ bill_id: billId, bill_type: 'Sales' }]),
          billId,
        },
        transaction: t,
      }
    );
    if (linkedReceiptRows.length > 0) {
      await t.rollback();
      const nums = linkedReceiptRows.map(r => r.transaction_number).join(', ');
      return res.status(400).json({
        error: `Cannot cancel this bill — the following receipt(s) have been recorded against it: ${nums}. Please cancel those receipts first, then cancel the bill.`,
      });
    }
    // Soft-cancel auto-receipts tied to this bill so they don't linger.
    await sequelize.query(
      `UPDATE payments_receipts
          SET is_cancelled = true,
              cancelled_date = NOW(),
              cancellation_reason = 'Auto-cancelled: parent bill cancelled'
        WHERE source = 'auto_from_bill'
          AND source_bill_id = :billId
          AND is_cancelled = false`,
      { replacements: { billId }, transaction: t }
    );
    // Remove their allocation rows so reconciliation doesn't see them.
    await sequelize.query(
      `DELETE FROM bill_payment_allocations
        WHERE allocation_method = 'auto_from_bill'
          AND bill_id = :billId
          AND bill_type = 'Sales'`,
      { replacements: { billId }, transaction: t }
    );
    // ─────────────────────────────────────────────────────────────────────────

    // Reverse the deduction at the bill's own godown (the one the sale
    // shipped from). Cancellation never re-routes stock.
    //
    // Audit C6: legacy bills created before the per-godown migration
    // have `bill.godown_id = NULL`. The previous guard `bill.godown_id`
    // SKIPPED reversal entirely on those bills — the StockLedger row
    // got destroyed below but `current_stock` was left at its
    // post-sale value, breaking conservation. Now we fall back to the
    // system default godown so the reversal still happens. The bill is
    // pre-godown but the stock is post-godown; that's fine because the
    // mirror invariant `current_stock = SUM(PGS)` is maintained.
    let cancelGodownId = bill.godown_id;
    if (!cancelGodownId && bill.items.some(i => i.product_id)) {
      cancelGodownId = await getDefaultGodownId({ t });
    }
    for (const item of bill.items) {
      if (item.product_id && cancelGodownId) {
        await applyGodownStockDelta({
          product_id: item.product_id, godown_id: cancelGodownId,
          delta: +parseFloat(item.quantity), t,
        });
        // Restore the per-batch on-hand for batched lines. Both the
        // godown-level and batch-level deltas must move together so a
        // rollback restores both consistently.
        if (item.batch_id) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: item.batch_id,
            godown_id: cancelGodownId,
            delta: +parseFloat(item.quantity), t,
          });
        }
      }
    }
    // Restore the per-color stock for multi-color lines. Walks the
    // saved items[] and re-credits each color_id by its sale qty.
    await reverseBillColorStock({
      items: bill.items,
      direction: 'sale',
      transaction: t,
    });

    // Audit H5 — preserve audit trail: append paired reversing entries
    // instead of destroying. Stock totals net to zero (originals already
    // restored via applyGodownStockDelta above); the Stock Movement page
    // can show "sold then unsold" lifecycle for cancelled bills.
    await writeStockLedgerReversal({
      referenceId: bill.sales_bill_id,
      transactionType: 'Sales',
      reason: `Bill ${bill.bill_number} cancelled`,
      userId: req.user?.user_id,
      t,
    });

    // Audit H6 v2 — exact FIFO layer reversal. Walks
    // sale_line_layer_consumptions for this bill and adds the consumed
    // qty back to exactly the originating layer (not the most-recent
    // layer like v1 did). No-op when cogs_method='weighted_avg' since
    // no consumption rows were recorded in the first place.
    await reverseConsumptionForBill({ sales_bill_id: bill.sales_bill_id, t });

    // Zero out monetary fields + record who/when/why for the audit trail.
    const { reason: cancellationReason } = req.body || {};
    await bill.update({
      is_cancelled: true,
      cancelled_by: req.user.user_id,
      cancelled_date: new Date(),
      cancellation_reason: cancellationReason || null,
      balance_amount: 0,
      payment_status: 'Unpaid',
    }, { transaction: t });

    // Redistribute any active receipts across remaining bills (FIFO), then fix party balance
    if (bill.customer_id) {
      await reconcileBillsForParty(bill.customer_id, t);
      await recalculatePartyBalance(bill.customer_id, t);
    }

    // ── Double-entry: reverse the bill's vouchers ──
    // Audit LED-H2 — pass reversalDate so the mirror lands in the SAME
    // accounting period as the original. Defaulting to today lets a
    // cross-FY cancel post the mirror into the current FY while the
    // original sits in a (now-closed) prior FY → asymmetric P&L.
    await reverseVoucher({
      sourceType: 'sales_bill', sourceId: bill.sales_bill_id,
      reason: cancellationReason || 'Sales bill cancelled',
      userId: req.user && req.user.user_id, transaction: t,
      reversalDate: bill.bill_date,
    });
    await reverseVoucher({
      sourceType: 'sales_bill_receipt', sourceId: bill.sales_bill_id,
      reason: cancellationReason || 'Sales bill cancelled',
      userId: req.user && req.user.user_id, transaction: t,
      reversalDate: bill.bill_date,
    });
    // Two-way ledger cancel cascade — soft-cancel the auto-receipt
    // row + drop its allocation. Preserves the Receipts list audit
    // trail (the row still appears with a "Cancelled" badge) but
    // zeros out the bill-level allocation so I1-I6 still hold.
    await reverseAutoReceiptForBill({
      kind: 'sales',
      billId: bill.sales_bill_id,
      reason: cancellationReason || 'Sales bill cancelled',
      userId: req.user && req.user.user_id,
      t,
    });

    // ── Auto-cancel linked inline return ──────────────────────────────
    // If this sale had a paired inline return (reference_bill_id → this
    // bill), cancel it too: reverse stock, reverse vouchers, mark cancelled.
    const linkedReturns = await SalesReturnBill.findAll({
      where: { reference_bill_id: bill.sales_bill_id, is_cancelled: false },
      include: [{ model: SalesReturnBillItem, as: 'items' }],
      transaction: t,
    });
    for (const ret of linkedReturns) {
      const retGodown = ret.godown_id || bill.godown_id;
      for (const item of ret.items) {
        if (item.product_id && retGodown) {
          await applyGodownStockDelta({
            product_id: item.product_id, godown_id: retGodown,
            delta: -parseFloat(item.quantity), t,
          });
          if (item.batch_id) {
            await applyBatchStockDelta({
              product_id: item.product_id, batch_id: item.batch_id,
              godown_id: retGodown, delta: -parseFloat(item.quantity), t,
            });
          }
        }
      }
      await writeStockLedgerReversal({
        referenceId: ret.sales_return_id,
        transactionType: 'Sales Return',
        reason: `Inline return ${ret.return_number} auto-cancelled with bill ${bill.bill_number}`,
        userId: req.user?.user_id, t,
      });
      await ret.update({
        is_cancelled: true,
        cancelled_by: req.user.user_id,
        cancelled_date: new Date(),
        cancellation_reason: `Auto-cancelled: parent bill ${bill.bill_number} cancelled`,
        balance_amount: 0,
        refund_status: 'Pending',
      }, { transaction: t });
      await reverseVoucher({
        sourceType: 'sales_return_bill', sourceId: ret.sales_return_id,
        reason: `Inline return auto-cancelled with bill ${bill.bill_number}`,
        userId: req.user?.user_id, transaction: t,
        reversalDate: ret.return_date,
      });
    }

    await t.commit();

    // Compliance audit log for cancel-with-override. Same best-effort
    // pattern as create() / update() — fires only when the bill was in
    // a locked period and an override was granted.
    if (lockGuard.overrideUsed) {
      await logComplianceEvent({
        event_type:       lockResult.status === 'hard_override_granted' ? 'hard_override' : 'soft_override',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'sales_bill',
        target_id:        bill.sales_bill_id,
        target_label:     `Sale ${bill.bill_number || `#${bill.sales_bill_id}`} cancelled (was dated ${cancelDateStr})`,
        target_date:      cancelDateStr,
        reason:           lockGuard.reason,
        metadata:         { lock_date: lockResult.lockDate, action: 'cancel' },
      });
    }

    res.json({ message: 'Bill cancelled successfully' });
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Cancel sale error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
