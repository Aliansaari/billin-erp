// ── Tally Import Orchestrator ──────────────────────────────────────────
//
// Drives a Tally import_job through its lifecycle:
//   parse → ledger-mapping → validate → preview → commit → finalize
//
// Each non-terminal status pause writes a JSON payload to the job row
// (mapping_json, preview_json) and sets status to 'awaiting_confirmation'.
// The user confirms via POST /api/imports/:id/confirm; the worker re-picks
// the job and resumes. The orchestrator's `run()` is therefore re-entrant —
// it inspects job state and decides which phase to start.
//
// Posting goes through ledgerPostingService — never direct inserts to
// ledger_entries. Each voucher commits in its own transaction; a failure
// rolls back that voucher only and continues to the next.
//
// Scope — Phase 5 hard-handles Sales / Purchase / Receipt / Payment.
// Other Tally voucher types (Credit Note, Debit Note, Contra, Journal,
// Stock Journal) land in the 'rejected' bucket with a clear reason. They
// can be wired to the existing Posting Service paths in a follow-up
// without re-architecting the orchestrator.

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const ExcelJS = require('exceljs');
const sequelize = require('../config/database');
const {
  ImportJob, ImportBatch, Party, Product, SalesBill, PurchaseBill,
  SalesReturnBill, PurchaseReturnBill, JournalVoucher,
  PaymentReceipt, LedgerAccount, SystemSettings, Category, TallyLedgerMapping,
} = require('../models');
const { decodeXmlBuffer, parseLedgers, parseStockItems, parseVouchers } = require('../utils/tallyXmlParser');
const { suggestMappings, saveMappings } = require('./tallyLedgerMapper');
const { postVoucher, reverseVoucher } = require('./ledgerPostingService');
const {
  buildSalesBillVouchers, buildPurchaseBillVouchers, buildPaymentReceiptVouchers,
  buildSalesReturnVouchers, buildPurchaseReturnVouchers,
} = require('./voucherBuilders');

const REJECTED_DIR = path.join(__dirname, '..', '..', 'uploads', 'rejected');
fs.mkdirSync(REJECTED_DIR, { recursive: true });

const SUPPORTED_TYPES = new Set([
  'Sales', 'Purchase', 'Receipt', 'Payment',
  'Credit Note', 'Debit Note', 'Contra', 'Journal',
]);
const REJECT_REASONS = {
  'Stock Journal': 'Stock Journal vouchers not yet supported. Please post stock adjustments manually.',
};

// ── Phase router ───────────────────────────────────────────────────────
async function run(job) {
  await job.update({ started_at: job.started_at || new Date() });
  // Determine which phase to enter.
  const profile = job.profile_json || {};
  const choices = profile.user_choices || null;

  // If we have a saved preview already, we're past validation — go to commit.
  if (job.preview_json && choices) return commit(job);
  // If we have a mapping_json saved already AND user has confirmed, advance.
  if (job.mapping_json && choices && !job.preview_json) return validateAndPreview(job);
  // Fresh start.
  return parsePhase(job);
}

// ── 1. Parse ───────────────────────────────────────────────────────────
async function parsePhase(job) {
  await job.update({ status: 'parsing', progress_pct: 5, phase_message: 'Reading Tally export…' });
  if (!job.input_file_path || !fs.existsSync(job.input_file_path)) {
    return fail(job, 'Uploaded file is missing on disk.');
  }
  const buf = fs.readFileSync(job.input_file_path);
  const xml = decodeXmlBuffer(buf);
  if (!xml || xml.length < 50) return fail(job, 'Empty or unreadable XML file.');

  await job.update({ progress_pct: 10, phase_message: 'Parsing masters…' });
  const ledgers     = parseLedgers(xml);
  const stockItems  = parseStockItems(xml);
  await job.update({ progress_pct: 18, phase_message: 'Parsing vouchers…' });
  const vouchers    = parseVouchers(xml);

  // Cache the parsed data in memory of the orchestrator. Storing in the
  // job row would balloon the JSONB column; we re-parse on resume.
  // Save lightweight stats to the job for the UI.
  const supportedCount = vouchers.filter((v) => SUPPORTED_TYPES.has(v.voucher_type)).length;

  await job.update({
    progress_pct: 25,
    phase_message: `Parsed ${ledgers.length} ledgers, ${stockItems.length} stock items, ${vouchers.length} vouchers`,
  });

  // Move to ledger-mapping phase.
  return mappingPhase(job, { ledgers, stockItems, vouchers });
}

// ── 2. Ledger mapping ──────────────────────────────────────────────────
//
// Collect all distinct ledger names referenced across vouchers (excluding
// party/cash ledgers, which we resolve at commit time). Suggest mappings;
// if any are 'low' or 'unmapped', pause for user confirmation.
async function mappingPhase(job, parsed) {
  await job.update({ status: 'validating', progress_pct: 30, phase_message: 'Mapping ledgers…' });

  // Collect non-party/non-cash ledger names referenced by vouchers.
  const referenced = new Set();
  for (const v of parsed.vouchers) {
    for (const le of v.ledger_entries) {
      const c = le.classification;
      // Party + cash + bank ledgers don't need mapping (we resolve at commit).
      if (c === 'party_or_other' || c === 'cash_bank') continue;
      referenced.add(le.name);
    }
  }
  const names = [...referenced];
  const suggestions = await suggestMappings(names);

  // Persist auto-detected mappings (high confidence) so the user doesn't
  // see them on the mapping screen.
  const autoConfirmed = suggestions.filter((s) => s.confidence === 'high' || s.confidence === 'manual');
  if (autoConfirmed.length > 0) {
    await saveMappings(autoConfirmed.map((s) => ({
      tally_ledger_name: s.tally_ledger_name,
      mapped_ledger_account_id: s.suggested_ledger_id,
      confidence: s.confidence === 'manual' ? 'manual' : 'high',
    })));
  }

  // Anything not high-confidence needs user attention.
  const needsReview = suggestions.filter((s) => s.confidence !== 'high' && s.confidence !== 'manual');

  if (needsReview.length > 0) {
    // Pause for user.
    await job.update({
      status: 'awaiting_confirmation',
      progress_pct: 35,
      phase_message: `Review ${needsReview.length} ledger mapping${needsReview.length === 1 ? '' : 's'}`,
      mapping_json: { suggestions, needs_review: needsReview },
    });
    return; // worker will re-pick after POST /confirm
  }

  // No review needed — straight to validate/preview.
  await job.update({
    mapping_json: { suggestions, needs_review: [] },
  });
  return validateAndPreview(job, parsed);
}

// ── 3. Validate + build dry-run preview ────────────────────────────────
async function validateAndPreview(job, parsed) {
  // Re-parse if we don't have parsed in memory (resumed after confirm).
  if (!parsed) {
    const buf = fs.readFileSync(job.input_file_path);
    const xml = decodeXmlBuffer(buf);
    parsed = {
      ledgers: parseLedgers(xml),
      stockItems: parseStockItems(xml),
      vouchers: parseVouchers(xml),
    };
  }

  // If user supplied confirmed mappings (after the mapping pause), persist them now.
  const choices = (job.profile_json || {}).user_choices || {};
  if (choices.mappings && Array.isArray(choices.mappings)) {
    await saveMappings(choices.mappings.map((r) => ({
      tally_ledger_name: r.tally_ledger_name,
      mapped_ledger_account_id: r.mapped_ledger_account_id,
      confidence: 'manual',
    })));
  }

  await job.update({ status: 'validating', progress_pct: 45, phase_message: 'Validating vouchers…' });

  const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
  const gstEnabled = !!(settings && settings.gst_enabled);
  // FY start guard. Tally exports often include vouchers from prior years
  // that the user does NOT want re-imported into the current period.
  // Reject any voucher dated before fy_start so the audit trail can't be
  // back-dated by accident. Stored as 'YYYY-MM-DD' on system_settings.
  const fyStart = settings && settings.financial_year_start
    ? String(settings.financial_year_start).slice(0, 10)
    : null;

  // Pre-load existing bill/payment numbers so we can detect re-import diffs.
  const existingSales     = await SalesBill.findAll({ attributes: ['sales_bill_id', 'bill_number', 'total_amount'] });
  const existingPurchases = await PurchaseBill.findAll({ attributes: ['purchase_bill_id', 'bill_number', 'total_amount'] });
  const existingPayments  = await PaymentReceipt.findAll({ attributes: ['transaction_id', 'transaction_number', 'total_amount'] });
  const salesByNumber    = new Map(existingSales.map((b)    => [b.bill_number, b]));
  const purchasesByNumber= new Map(existingPurchases.map((b)=> [b.bill_number, b]));
  const paymentsByNumber = new Map(existingPayments.map((p) => [p.transaction_number, p]));

  const buckets = { create: [], update: [], skip: [], reject: [] };

  for (const v of parsed.vouchers) {
    // Out-of-scope voucher types
    if (REJECT_REASONS[v.voucher_type]) {
      buckets.reject.push({
        voucher: v, reason: REJECT_REASONS[v.voucher_type],
      });
      continue;
    }
    if (!SUPPORTED_TYPES.has(v.voucher_type)) {
      buckets.reject.push({ voucher: v, reason: `Unsupported voucher type: ${v.voucher_type}` });
      continue;
    }
    if (!v.voucher_number) {
      buckets.reject.push({ voucher: v, reason: 'Voucher number missing.' });
      continue;
    }
    if (!v.voucher_date) {
      buckets.reject.push({ voucher: v, reason: 'Voucher date missing or unparseable.' });
      continue;
    }
    if (fyStart && v.voucher_date < fyStart) {
      buckets.reject.push({
        voucher: v,
        reason: `Date ${formatDateForReason(v.voucher_date)} is before FY start (${formatDateForReason(fyStart)}).`,
      });
      continue;
    }

    // Compute totals from ledger entries
    const totals = computeVoucherTotals(v, gstEnabled);
    if (totals.error) {
      buckets.reject.push({ voucher: v, reason: totals.error });
      continue;
    }

    // Diff detection vs existing rows
    const existing =
      v.voucher_type === 'Sales'    ? salesByNumber.get(v.voucher_number) :
      v.voucher_type === 'Purchase' ? purchasesByNumber.get(v.voucher_number) :
      paymentsByNumber.get(v.voucher_number);
    if (existing) {
      const existingTotal = Number(existing.total_amount) || 0;
      if (Math.abs(existingTotal - totals.total_amount) < 0.01) {
        buckets.skip.push({ voucher: v, reason: 'Identical voucher already imported.' });
      } else {
        buckets.update.push({ voucher: v, totals, existing_total: existingTotal });
      }
    } else {
      buckets.create.push({ voucher: v, totals });
    }
  }

  // Build preview payload — slim, UI-friendly.
  const preview = {
    counts: {
      create: buckets.create.length,
      update: buckets.update.length,
      skip:   buckets.skip.length,
      reject: buckets.reject.length,
    },
    totals: {
      create: round2(buckets.create.reduce((s, x) => s + x.totals.total_amount, 0)),
      update: round2(buckets.update.reduce((s, x) => s + x.totals.total_amount, 0)),
    },
    sample: {
      create: buckets.create.slice(0, 10).map((x) => ({
        voucher_number: x.voucher.voucher_number, voucher_type: x.voucher.voucher_type,
        date: x.voucher.voucher_date, party: x.voucher.party_name, total: x.totals.total_amount,
      })),
      update: buckets.update.slice(0, 10).map((x) => ({
        voucher_number: x.voucher.voucher_number, voucher_type: x.voucher.voucher_type,
        date: x.voucher.voucher_date, party: x.voucher.party_name,
        old_total: x.existing_total, new_total: x.totals.total_amount,
      })),
      reject: buckets.reject.slice(0, 20).map((x) => ({
        voucher_number: x.voucher.voucher_number, voucher_type: x.voucher.voucher_type,
        reason: x.reason,
      })),
    },
    gst_enabled: gstEnabled,
  };

  // Stash the full bucket data on the job for commit phase. JSONB.
  await job.update({
    status: 'awaiting_confirmation',
    progress_pct: 55,
    phase_message: `Ready: ${buckets.create.length} new, ${buckets.update.length} updates, ${buckets.skip.length} unchanged, ${buckets.reject.length} rejected`,
    preview_json: { ...preview, _full_buckets: serializeBuckets(buckets, parsed) },
  });
}

// JSONB-safe serialization of the full bucket data so commit phase can resume.
function serializeBuckets(buckets, parsed) {
  return {
    ledgers: parsed.ledgers,
    stockItems: parsed.stockItems,
    create: buckets.create.map((x) => ({ voucher: stripBlock(x.voucher), totals: x.totals })),
    update: buckets.update.map((x) => ({
      voucher: stripBlock(x.voucher), totals: x.totals, existing_total: x.existing_total,
    })),
    skip:   buckets.skip.map((x) => ({ voucher: stripBlock(x.voucher), reason: x.reason })),
    reject: buckets.reject.map((x) => ({ voucher: stripBlock(x.voucher), reason: x.reason })),
  };
}
function stripBlock(v) { const { raw_block: _r, ...rest } = v; return rest; }

// ── 4. Commit ──────────────────────────────────────────────────────────
async function commit(job) {
  await job.update({ status: 'committing', progress_pct: 60, phase_message: 'Committing vouchers…' });

  const full = (job.preview_json || {})._full_buckets;
  if (!full) return fail(job, 'Internal error: preview data missing on resume.');

  const { ledgers, stockItems, create: toCreate, update: toUpdate, skip: toSkip, reject: toReject } = full;

  // Pre-import: ensure parties + products from masters exist.
  await job.update({ phase_message: 'Reconciling parties from Tally ledgers…' });
  const partiesByName = await ensureParties(job, ledgers);
  await job.update({ progress_pct: 65, phase_message: 'Reconciling products from Tally stock items…' });
  const productsByName = await ensureProducts(job, stockItems);

  let postedCount = 0, failedCount = 0;
  const total = toCreate.length + toUpdate.length;
  if (total === 0) {
    return finalize(job, { posted: 0, failed: 0, skipped: toSkip.length, rejected: toReject, ...full });
  }

  let i = 0;
  for (const item of toCreate) {
    // Mid-import cancel check.
    await job.reload();
    if (job.status === 'cancelled') {
      return finalize(job, { posted: postedCount, failed: failedCount, skipped: toSkip.length, rejected: toReject, ...full, cancelled: true });
    }
    const ok = await commitOne(job, item.voucher, item.totals, partiesByName, productsByName, 'create');
    if (ok.success) postedCount++; else { failedCount++; toReject.push({ voucher: item.voucher, reason: ok.error }); }
    i++;
    if (i % 10 === 0) {
      const pct = 65 + Math.round((i / total) * 30);
      await job.update({ progress_pct: pct, phase_message: `Committed ${i}/${total} vouchers` });
    }
  }
  for (const item of toUpdate) {
    await job.reload();
    if (job.status === 'cancelled') {
      return finalize(job, { posted: postedCount, failed: failedCount, skipped: toSkip.length, rejected: toReject, ...full, cancelled: true });
    }
    const ok = await commitOne(job, item.voucher, item.totals, partiesByName, productsByName, 'update');
    if (ok.success) postedCount++; else { failedCount++; toReject.push({ voucher: item.voucher, reason: ok.error }); }
    i++;
    if (i % 10 === 0) {
      const pct = 65 + Math.round((i / total) * 30);
      await job.update({ progress_pct: pct, phase_message: `Committed ${i}/${total} vouchers` });
    }
  }

  return finalize(job, { posted: postedCount, failed: failedCount, skipped: toSkip.length, rejected: toReject, ...full });
}

// ── helper: ensure a party exists for every relevant Tally ledger ──
async function ensureParties(job, ledgers) {
  const map = new Map();
  for (const lg of ledgers) {
    const isCustomer = /debtor/i.test(lg.parent || '');
    const isSupplier = /creditor/i.test(lg.parent || '');
    if (!isCustomer && !isSupplier) continue;
    const t = await sequelize.transaction();
    try {
      // Tally rarely supplies a mobile number per ledger. We generate a
      // placeholder that fits VARCHAR(15) and is recognisable for cleanup
      // ("TLY" + last 12 chars of timestamp+random).
      const stub = `TLY${Date.now().toString().slice(-9)}${Math.floor(Math.random()*100)}`.slice(0, 15);
      const [party] = await Party.findOrCreate({
        where: { party_name: lg.name },
        defaults: {
          party_type: isSupplier ? 'Supplier' : 'Customer',
          party_name: lg.name,
          mobile_1: lg.mobile || stub,
          gstin: lg.gstin || null,
          opening_balance: lg.opening_balance || 0,
          // Tally parser yields 'Receivable'/'Payable' already, but route
          // through the shared normalizer so any future Tally schema drift
          // (or a hand-edited XML) doesn't silently mis-direct an opening JV.
          opening_balance_type: Party.normalizeBalanceType(lg.opening_balance_type),
        },
        transaction: t,
      });
      map.set(lg.name, party);
      await ImportBatch.create({
        import_job_id: job.id, entity_type: 'party', entity_id: party.party_id,
        external_ref: lg.name, action: party._options.isNewRecord ? 'created' : 'skipped',
      }, { transaction: t });
      await t.commit();
    } catch (e) {
      try { await t.rollback(); } catch (_) {}
      // eslint-disable-next-line no-console
      console.warn('[tallyImport] ensureParty failed for', lg.name, ':', e.message);
    }
  }
  return map;
}

// Cash purchase fallback: PurchaseBill.supplier_id is NOT NULL but
// counter-style cash purchases legitimately have no supplier party.
// We materialise a single "Cash Purchases" Supplier and reuse it for
// every cash purchase from any import — keeping the constraint satisfied
// without polluting the parties list with one stub per cash bill.
async function ensureCashPurchasesParty(t) {
  const STUB_NAME = 'Cash Purchases';
  const existing = await Party.findOne({ where: { party_name: STUB_NAME }, transaction: t });
  if (existing) return existing.party_id;
  const party = await Party.create({
    party_type: 'Supplier',
    party_name: STUB_NAME,
    mobile_1: 'CASH-PURCHASES',
    opening_balance: 0,
    opening_balance_type: 'Payable',
  }, { transaction: t });
  return party.party_id;
}

async function ensureProducts(job, stockItems) {
  const map = new Map();
  for (const it of stockItems) {
    const t = await sequelize.transaction();
    try {
      let category = await Category.findOne({ where: { category_name: 'Imported from Tally' }, transaction: t });
      if (!category) {
        category = await Category.create({ category_name: 'Imported from Tally' }, { transaction: t });
      }
      // Barcode VARCHAR(20) with unique constraint — short, prefixed.
      const bc = `T${Date.now().toString().slice(-10)}${Math.floor(Math.random()*1000)}`.slice(0, 20);
      const [prod] = await Product.findOrCreate({
        where: { product_name: it.name },
        defaults: {
          product_name: it.name,
          barcode: bc,
          category_id: category.category_id,
          gst_rate: it.gst_rate || 0,
          opening_stock: it.opening_stock || 0,
          current_stock: it.opening_stock || 0,
        },
        transaction: t,
      });
      map.set(it.name, prod);
      await t.commit();
    } catch (e) {
      try { await t.rollback(); } catch (_) {}
      console.warn('[tallyImport] ensureProduct failed for', it.name, ':', e.message);
    }
  }
  return map;
}

// ── helper: commit one voucher (create or update) ──
//
// All in one Sequelize transaction. Source row insert + posting service call
// roll back together if anything throws.
async function commitOne(job, v, totals, partiesByName, productsByName, action) {
  const t = await sequelize.transaction();
  try {
    if (v.voucher_type === 'Sales' || v.voucher_type === 'Purchase') {
      const isSales = v.voucher_type === 'Sales';
      const Bill = isSales ? SalesBill : PurchaseBill;
      const idCol  = isSales ? 'sales_bill_id' : 'purchase_bill_id';
      const fkParty = isSales ? 'customer_id' : 'supplier_id';
      const sourceType = isSales ? 'sales_bill' : 'purchase_bill';
      const subType   = isSales ? 'sales_bill_receipt' : 'purchase_bill_payment';

      let partyId = v.party_name ? (partiesByName.get(v.party_name) || {}).party_id : null;
      // Cash purchase: PARTYLEDGERNAME is "Cash" / a Bank ledger rather
      // than a Sundry Creditor. PurchaseBill.supplier_id is NOT NULL, so
      // we auto-create (or reuse) a "Cash Purchases" stub Supplier party.
      // We also flag this voucher so the bill is booked as paid in full
      // — that triggers the secondary purchase_bill_payment voucher
      // (Stub Supplier Dr / Cash Cr) which (a) puts the credit on the
      // real Cash ledger and (b) nets the stub supplier ledger to zero
      // so it doesn't clutter party-balance reports.
      let isCashPurchase = false;
      if (!isSales && !partyId) {
        partyId = await ensureCashPurchasesParty(t);
        isCashPurchase = true;
      }

      let billRow;
      if (action === 'update') {
        billRow = await Bill.findOne({ where: { bill_number: v.voucher_number }, transaction: t });
        if (!billRow) throw new Error('Update target row vanished.');
        await reverseVoucher({ sourceType,         sourceId: billRow[idCol], reason: 'Tally re-import update', transaction: t });
        await reverseVoucher({ sourceType: subType, sourceId: billRow[idCol], reason: 'Tally re-import update', transaction: t });
        const updateData = {
          bill_date: v.voucher_date,
          [fkParty]: partyId,
          sub_total: totals.taxable, discount_amount: totals.discount,
          cgst_amount: totals.cgst, sgst_amount: totals.sgst, igst_amount: totals.igst,
          cgst_pct: totals.cgst_pct, sgst_pct: totals.sgst_pct, igst_pct: totals.igst_pct,
          round_off: totals.round_off,
          total_amount: totals.total_amount, balance_amount: totals.total_amount,
          paid_amount: 0, payment_status: 'Unpaid',
        };
        if (!isSales) updateData.payment_method = 'Cash';
        await billRow.update(updateData, { transaction: t });
      } else {
        // Create
        const data = {
          bill_number: v.voucher_number,
          bill_date: v.voucher_date,
          [fkParty]: partyId,
          sub_total: totals.taxable, discount_amount: totals.discount,
          cgst_amount: totals.cgst, sgst_amount: totals.sgst, igst_amount: totals.igst,
          cgst_pct: totals.cgst_pct, sgst_pct: totals.sgst_pct, igst_pct: totals.igst_pct,
          round_off: totals.round_off,
          total_amount: totals.total_amount,
          paid_amount: isCashPurchase ? totals.total_amount : 0,
          balance_amount: isCashPurchase ? 0 : totals.total_amount,
          payment_status: isCashPurchase ? 'Paid' : 'Unpaid',
          payment_method: 'Cash',
        };
        billRow = await Bill.create(data, { transaction: t });
      }

      const refreshed = await Bill.findByPk(billRow[idCol], {
        include: [{ model: Party, as: isSales ? 'customer' : 'supplier' }],
        transaction: t,
      });
      const builder = isSales ? buildSalesBillVouchers : buildPurchaseBillVouchers;
      const vouchers = await builder(refreshed, { transaction: t });
      for (const vch of vouchers) {
        await postVoucher({ ...vch, userId: job.created_by, transaction: t });
      }

      await ImportBatch.create({
        import_job_id: job.id, entity_type: sourceType, entity_id: billRow[idCol],
        external_ref: v.voucher_number, action: action === 'update' ? 'updated' : 'created',
      }, { transaction: t });

    } else if (v.voucher_type === 'Receipt' || v.voucher_type === 'Payment') {
      const partyId = v.party_name ? (partiesByName.get(v.party_name) || {}).party_id : null;
      if (!partyId) throw new Error(`${v.voucher_type} has no party (party_id required).`);
      let row;
      if (action === 'update') {
        row = await PaymentReceipt.findOne({ where: { transaction_number: v.voucher_number }, transaction: t });
        if (!row) throw new Error('Update target row vanished.');
        await reverseVoucher({ sourceType: 'payment_receipt', sourceId: row.transaction_id, reason: 'Tally re-import update', transaction: t });
        await row.update({
          transaction_date: v.voucher_date,
          party_id: partyId,
          total_amount: totals.total_amount,
        }, { transaction: t });
      } else {
        row = await PaymentReceipt.create({
          transaction_number: v.voucher_number,
          transaction_type: v.voucher_type,
          transaction_date: v.voucher_date,
          party_id: partyId,
          total_amount: totals.total_amount,
          payment_method: 'Cash',
        }, { transaction: t });
      }
      const refreshed = await PaymentReceipt.findByPk(row.transaction_id, {
        include: [{ model: Party, as: 'party' }],
        transaction: t,
      });
      const vouchers = await buildPaymentReceiptVouchers(refreshed, { transaction: t });
      for (const vch of vouchers) {
        await postVoucher({ ...vch, userId: job.created_by, transaction: t });
      }
      await ImportBatch.create({
        import_job_id: job.id, entity_type: 'payment_receipt', entity_id: row.transaction_id,
        external_ref: v.voucher_number, action: action === 'update' ? 'updated' : 'created',
      }, { transaction: t });
    } else if (v.voucher_type === 'Credit Note' || v.voucher_type === 'Debit Note') {
      const isCN = v.voucher_type === 'Credit Note';
      const ReturnBill = isCN ? SalesReturnBill : PurchaseReturnBill;
      const idCol = isCN ? 'sales_return_id' : 'purchase_return_id';
      const fkParty = isCN ? 'customer_id' : 'supplier_id';
      const sourceType = isCN ? 'sales_return_bill' : 'purchase_return_bill';
      const builder = isCN ? buildSalesReturnVouchers : buildPurchaseReturnVouchers;
      const partyId = v.party_name ? (partiesByName.get(v.party_name) || {}).party_id : null;
      if (!isCN && !partyId) throw new Error('Debit Note has no supplier (supplier_id NOT NULL).');

      let row;
      if (action === 'update') {
        row = await ReturnBill.findOne({ where: { return_number: v.voucher_number }, transaction: t });
        if (!row) throw new Error('Update target return bill vanished.');
        await reverseVoucher({ sourceType, sourceId: row[idCol], reason: 'Tally re-import update', transaction: t });
        await row.update({
          return_date: v.voucher_date,
          [fkParty]: partyId,
          sub_total: totals.taxable, discount_amount: totals.discount,
          cgst_amount: totals.cgst, sgst_amount: totals.sgst, igst_amount: totals.igst,
          cgst_pct: totals.cgst_pct, sgst_pct: totals.sgst_pct, igst_pct: totals.igst_pct,
          round_off: totals.round_off,
          total_amount: totals.total_amount, balance_amount: totals.total_amount,
          refund_amount: 0, refund_status: 'Pending',
        }, { transaction: t });
      } else {
        row = await ReturnBill.create({
          return_number: v.voucher_number,
          return_date: v.voucher_date,
          [fkParty]: partyId,
          return_mode: 'Items',
          sub_total: totals.taxable, discount_amount: totals.discount,
          cgst_amount: totals.cgst, sgst_amount: totals.sgst, igst_amount: totals.igst,
          cgst_pct: totals.cgst_pct, sgst_pct: totals.sgst_pct, igst_pct: totals.igst_pct,
          round_off: totals.round_off,
          total_amount: totals.total_amount,
          refund_amount: 0, balance_amount: totals.total_amount,
          refund_status: 'Pending', refund_method: 'Cash',
        }, { transaction: t });
      }
      const refreshed = await ReturnBill.findByPk(row[idCol], {
        include: [{ model: Party, as: isCN ? 'customer' : 'supplier' }],
        transaction: t,
      });
      const vouchers = await builder(refreshed, { transaction: t });
      for (const vch of vouchers) await postVoucher({ ...vch, userId: job.created_by, transaction: t });
      await ImportBatch.create({
        import_job_id: job.id, entity_type: sourceType, entity_id: row[idCol],
        external_ref: v.voucher_number, action: action === 'update' ? 'updated' : 'created',
      }, { transaction: t });

    } else if (v.voucher_type === 'Contra' || v.voucher_type === 'Journal') {
      // Map every leg's Tally ledger name to a system ledger_account_id.
      // For party legs we use partiesByName → ledger_account_id.
      // For everything else we route through resolveLegLedger() which
      // checks tally_ledger_mappings, then falls back to chart-by-name,
      // then to a high-confidence suggestion.
      const lines = [];
      for (const le of v.ledger_entries) {
        const id = await resolveLegLedger(le, partiesByName, t);
        if (!id) throw new Error(`Could not map ledger '${le.name}' to a system account.`);
        const amt = Math.abs(le.amount);
        if (amt < 0.005) continue;
        // Tally amount sign: positive = Dr leg, negative = Cr leg.
        if (le.amount > 0) lines.push({ ledgerAccountId: id, debit: amt, credit: 0 });
        else               lines.push({ ledgerAccountId: id, debit: 0, credit: amt });
      }
      if (lines.length < 2) throw new Error(`${v.voucher_type} needs at least 2 legs after mapping.`);

      // JournalVoucher header — reuse for both Contra and Journal.
      let jv;
      if (action === 'update') {
        jv = await JournalVoucher.findOne({ where: { voucher_number: v.voucher_number }, transaction: t });
        if (!jv) throw new Error('Update target JV vanished.');
        await reverseVoucher({ sourceType: 'journal_voucher', sourceId: jv.id, reason: 'Tally re-import update', transaction: t });
        await jv.update({
          voucher_date: v.voucher_date,
          narration: `Imported from Tally · ${v.voucher_type}`,
          total_amount: totals.total_amount,
        }, { transaction: t });
      } else {
        jv = await JournalVoucher.create({
          voucher_number: v.voucher_number,
          voucher_date: v.voucher_date,
          narration: `Imported from Tally · ${v.voucher_type}`,
          total_amount: totals.total_amount,
          is_reversed: false,
          created_by: job.created_by || null,
        }, { transaction: t });
      }

      await postVoucher({
        voucherType: v.voucher_type === 'Contra' ? 'Contra' : 'Journal',
        sourceType: 'journal_voucher',
        sourceId: jv.id,
        voucherDate: v.voucher_date,
        referenceNumber: v.voucher_number,
        narration: `Imported from Tally · ${v.voucher_type}`,
        lines,
        userId: job.created_by,
        transaction: t,
      });
      await ImportBatch.create({
        import_job_id: job.id, entity_type: 'journal_voucher', entity_id: jv.id,
        external_ref: v.voucher_number, action: action === 'update' ? 'updated' : 'created',
      }, { transaction: t });

    } else {
      throw new Error('Unhandled voucher type at commit: ' + v.voucher_type);
    }

    await t.commit();
    return { success: true };
  } catch (err) {
    try { await t.rollback(); } catch (_) {}
    return { success: false, error: err.message || String(err) };
  }
}

// ── 5. Finalize ────────────────────────────────────────────────────────
async function finalize(job, summary) {
  // Generate rejected-rows Excel if any rejects.
  let rejectedPath = null;
  if (summary.rejected && summary.rejected.length > 0) {
    rejectedPath = path.join(REJECTED_DIR, `rejected-${job.id}-${Date.now()}.xlsx`);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rejected');
    ws.columns = [
      { header: 'Voucher Type', key: 'type', width: 18 },
      { header: 'Voucher Number', key: 'number', width: 24 },
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Party', key: 'party', width: 30 },
      { header: 'Reason', key: 'reason', width: 60 },
    ];
    for (const r of summary.rejected) {
      ws.addRow({
        type: r.voucher && r.voucher.voucher_type,
        number: r.voucher && r.voucher.voucher_number,
        date: r.voucher && r.voucher.voucher_date,
        party: r.voucher && r.voucher.party_name,
        reason: r.reason,
      });
    }
    await wb.xlsx.writeFile(rejectedPath);
  }

  await job.update({
    status: summary.cancelled ? 'cancelled' : 'done',
    progress_pct: summary.cancelled ? job.progress_pct : 100,
    phase_message: summary.cancelled ? 'Cancelled by user' : 'Done',
    completed_at: new Date(),
    rejected_rows_path: rejectedPath,
    result_summary_json: {
      posted:   summary.posted   || 0,
      failed:   summary.failed   || 0,
      skipped:  summary.skipped  || 0,
      rejected: (summary.rejected || []).length,
    },
  });
}

async function fail(job, message) {
  await job.update({ status: 'failed', error_message: message, completed_at: new Date() });
}

// ── leg resolver for Contra / Tally Journal vouchers ──────────────────
//
// Maps a parsed `<LEDGERENTRIES>` leg to a system ledger_account_id by
// checking, in order:
//   1. partiesByName (for legs that reference a party ledger)
//   2. tally_ledger_mappings (persisted user-confirmed mappings)
//   3. exact match on ledger_accounts.ledger_name (case-insensitive)
//   4. mapper's high-confidence suggestion (rule match)
//
// Returns null if none of these resolve — the caller rejects the voucher.
async function resolveLegLedger(le, partiesByName, t) {
  // 1. Party leg.
  if (le.classification === 'party_or_other' && partiesByName.has(le.name)) {
    const party = partiesByName.get(le.name);
    if (party && party.ledger_account_id) return party.ledger_account_id;
  }
  // 2. Persisted mapping.
  const persisted = await TallyLedgerMapping.findOne({
    where: { tally_ledger_name: le.name }, transaction: t,
  });
  if (persisted && persisted.mapped_ledger_account_id) return persisted.mapped_ledger_account_id;
  // 3. Exact ledger-name match.
  const exact = await LedgerAccount.findOne({
    where: sequelize.where(
      sequelize.fn('LOWER', sequelize.col('ledger_name')),
      String(le.name).toLowerCase(),
    ),
    transaction: t,
  });
  if (exact) return exact.ledger_id;
  // 4. High-confidence suggestion. saveMappings persists the choice so we
  //    don't re-derive it on the next leg / next import.
  const sug = await suggestMappings([le.name], { transaction: t });
  if (sug[0] && sug[0].suggested_ledger_id && (sug[0].confidence === 'high' || sug[0].confidence === 'manual')) {
    await saveMappings([{
      tally_ledger_name: le.name,
      mapped_ledger_account_id: sug[0].suggested_ledger_id,
      confidence: 'high',
    }], { transaction: t });
    return sug[0].suggested_ledger_id;
  }
  return null;
}

// ── pure helpers ───────────────────────────────────────────────────────
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// "2026-04-15" → "15-Apr-2026". Used in reject reasons so the user sees
// the same date format the rest of the app uses, regardless of how the
// XML wrote it.
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatDateForReason(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return String(iso || '');
  const [y, m, d] = iso.slice(0, 10).split('-');
  const mIdx = parseInt(m, 10) - 1;
  return `${d}-${MONTHS_SHORT[mIdx] || m}-${y}`;
}

// Tally lines come in two sign conventions: "isDeemedPositive=YES" lines
// behave as debits (party Dr on a sale, cash Dr on a receipt). Tally's
// AMOUNT field carries a sign that mirrors this. We extract the absolute
// values and route them by classification.
function computeVoucherTotals(v, gstEnabled) {
  // Contra and Tally Journal: pure balance check. Sum of |Dr| === sum of |Cr|.
  // The "total" is half the absolute sum (the magnitude of the transfer).
  // We don't try to derive taxable/discount/tax — a Contra is a cash/bank
  // shuffle; a Journal can be any shape the user wrote in Tally.
  if (v.voucher_type === 'Contra' || v.voucher_type === 'Journal') {
    let dr = 0, cr = 0;
    for (const le of v.ledger_entries) {
      // Tally amount sign: positive = Dr, negative = Cr (modulo
      // isDeemedPositive flips). We use the raw signed amount so paired
      // Dr/Cr cancel out only when the voucher is balanced.
      if (le.amount > 0) dr += le.amount;
      else               cr += -le.amount;
    }
    dr = round2(dr); cr = round2(cr);
    if (Math.abs(dr - cr) > 1) {
      return { error: `${v.voucher_type} unbalanced: Dr ₹${dr.toFixed(2)} ≠ Cr ₹${cr.toFixed(2)}` };
    }
    const total = round2(Math.max(dr, cr));
    if (total <= 0) return { error: `${v.voucher_type} has zero amount.` };
    return {
      taxable: 0, discount: 0, cgst: 0, sgst: 0, igst: 0, round_off: 0,
      cgst_pct: 0, sgst_pct: 0, igst_pct: 0, total_amount: total,
    };
  }

  // Receipts and payments don't follow the taxable+tax shape — they're just
  // a money transfer between two ledgers. Total = absolute amount of the
  // party leg (or cash/bank leg if no party present).
  if (v.voucher_type === 'Receipt' || v.voucher_type === 'Payment') {
    let partyLeg = 0, cashLeg = 0;
    for (const le of v.ledger_entries) {
      const a = Math.abs(le.amount);
      if (le.classification === 'party_or_other') partyLeg = Math.max(partyLeg, a);
      else if (le.classification === 'cash_bank') cashLeg = Math.max(cashLeg, a);
    }
    const total = round2(partyLeg || cashLeg);
    if (total <= 0) {
      return { error: `${v.voucher_type} voucher has zero amount.` };
    }
    if (partyLeg > 0 && cashLeg > 0 && Math.abs(partyLeg - cashLeg) > 1) {
      return { error: `${v.voucher_type} unbalanced: party ₹${partyLeg.toFixed(2)} vs cash ₹${cashLeg.toFixed(2)}` };
    }
    return {
      taxable: 0, discount: 0, cgst: 0, sgst: 0, igst: 0, round_off: 0,
      cgst_pct: 0, sgst_pct: 0, igst_pct: 0, total_amount: total,
    };
  }

  // Sales / Purchase shape.
  //
  // Identify the party-equivalent leg by *name match against v.party_name*
  // — what Tally itself guarantees is the bill total. This works for both
  // credit sales (party = Sundry Debtor ledger) AND cash sales / cash
  // purchases (party = "Cash" or a Bank ledger). The previous bucket-sum
  // approach summed every party_or_other + cash_bank leg into one number,
  // so a "Local Sales 12%" line that didn't classify as 'sales' got
  // double-counted into the party leg.
  //
  // Breakdown of the OTHER legs still uses the by-classification buckets
  // for the bill row (taxable / cgst / sgst / igst / round-off / discount).
  // Unclassified non-party legs fall back to taxable so the breakdown
  // still ties to the party leg total.
  const partyLedgerName = v.party_name || '';
  const isPartyLeg = (le) => partyLedgerName && le.name === partyLedgerName;

  let partyLegAbs = 0;
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, roundOff = 0, discount = 0;
  for (const le of v.ledger_entries) {
    const a = Math.abs(le.amount);
    if (isPartyLeg(le)) {
      partyLegAbs += a;
      continue;
    }
    switch (le.classification) {
      case 'sales': case 'purchase':       taxable += a;  break;
      case 'cgst':                         if (gstEnabled) cgst += a; else taxable += a; break;
      case 'sgst':                         if (gstEnabled) sgst += a; else taxable += a; break;
      case 'igst':                         if (gstEnabled) igst += a; else taxable += a; break;
      case 'roundoff':                     roundOff += le.amount; break;
      case 'discount':                     discount += a; break;
      // Anything else (mis-classified party_or_other, unknown income/
      // expense ledgers) folds into taxable. Better to over-attribute than
      // to silently drop value — the balance check still catches genuine
      // mismatches.
      default:                             taxable += a; break;
    }
  }
  partyLegAbs = round2(partyLegAbs);
  taxable = round2(taxable);
  cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst);
  roundOff = round2(roundOff); discount = round2(discount);

  const total = round2(taxable - discount + cgst + sgst + igst + roundOff);

  // Balance check: the party leg's magnitude must match the sum of all
  // other legs (= computed total). We allow ₹1 slack for paisa drift on
  // very long item lists.
  if (partyLegAbs > 0 && Math.abs(partyLegAbs - total) > 1) {
    return { error: `Voucher unbalanced: party leg ₹${partyLegAbs.toFixed(2)} vs computed total ₹${total.toFixed(2)}` };
  }
  if (total <= 0) {
    return { error: `Voucher has zero or negative total (₹${total.toFixed(2)}).` };
  }

  const cgst_pct = taxable > 0 ? round2((cgst * 100) / taxable) : 0;
  const sgst_pct = taxable > 0 ? round2((sgst * 100) / taxable) : 0;
  const igst_pct = taxable > 0 ? round2((igst * 100) / taxable) : 0;

  return {
    taxable, discount, cgst, sgst, igst, round_off: roundOff,
    cgst_pct, sgst_pct, igst_pct, total_amount: total,
  };
}

module.exports = { run, _commit: commit, _validateAndPreview: validateAndPreview, _computeVoucherTotals: computeVoucherTotals };
