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
  SalesBillItem, PurchaseBillItem,
  SalesReturnBill, PurchaseReturnBill,
  SalesReturnBillItem, PurchaseReturnBillItem,
  JournalVoucher, StockLedger,
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

  // Party-existence index for the validate phase. A party is "known" if
  // it appears in the XML's <LEDGER> masters (we'll create it during
  // commit) OR already exists in the DB (created by a prior import or
  // manually). Receipt/Payment/Debit Note vouchers that reference an
  // unknown party are rejected at validate-time so the user sees the
  // problem in the preview rather than at commit.
  const stagedNames = new Set(parsed.ledgers.map((l) => l.name));
  const referenced  = new Set();
  for (const v of parsed.vouchers) if (v.party_name) referenced.add(v.party_name);
  const referencedArr = [...referenced];
  const existingByName = new Set();
  if (referencedArr.length > 0) {
    const rows = await Party.findAll({
      where: { party_name: referencedArr },
      attributes: ['party_name'],
    });
    for (const r of rows) existingByName.add(r.party_name);
  }
  const partyKnown = (name) => !!name && (stagedNames.has(name) || existingByName.has(name));
  // Cash-class ledger names — these legitimately replace the party leg
  // on cash sales/purchases and don't need to exist as a party row.
  const isCashLikeName = (n) => /\b(cash|bank)\b/i.test(String(n || ''));

  // Stock-item existence index. Same shape as the party guard:
  //   in-batch <STOCKITEM> masters ∪ products table by exact name.
  // A voucher whose <ALLINVENTORYENTRIES.LIST> references an unknown
  // stock item is rejected at validate-time so the user can fix the
  // master in the XML or pre-create the product before re-uploading.
  const stagedStockNames = new Set(parsed.stockItems.map((s) => s.name));
  const refStock = new Set();
  for (const v of parsed.vouchers) {
    for (const it of (v.inventory || [])) if (it.name) refStock.add(it.name);
  }
  const refStockArr = [...refStock];
  const existingStockNames = new Set();
  if (refStockArr.length > 0) {
    const prods = await Product.findAll({
      where: { product_name: refStockArr },
      attributes: ['product_name'],
    });
    for (const p of prods) existingStockNames.add(p.product_name);
  }
  const stockItemKnown = (name) =>
    !!name && (stagedStockNames.has(name) || existingStockNames.has(name));

  // Bill-reference index for the validate phase. For each Receipt/Payment
  // voucher, BILLALLOCATIONS.LIST entries (other than 'On Account') name
  // the local Sales/Purchase bills to allocate against. A bill is "known"
  // if it already exists in the DB (party + bill_number) OR appears in
  // this XML as an in-batch Sales/Purchase voucher.
  //
  // Same shape as the party + stock-item guards above — reject in preview
  // so the user fixes the XML / pre-imports the bill rather than getting
  // a commit-phase failure.
  const dbBillKey = new Set();
  for (const b of existingSales)     dbBillKey.add(`Sales:${b.bill_number}`);
  for (const b of existingPurchases) dbBillKey.add(`Purchase:${b.bill_number}`);
  const inBatchBillKey = new Set();
  for (const v of parsed.vouchers) {
    if (v.voucher_type === 'Sales')    inBatchBillKey.add(`Sales:${v.voucher_number}`);
    if (v.voucher_type === 'Purchase') inBatchBillKey.add(`Purchase:${v.voucher_number}`);
  }
  const billKnown = (billType, billNumber) => {
    const k = `${billType}:${billNumber}`;
    return dbBillKey.has(k) || inBatchBillKey.has(k);
  };

  // Helper — collect the BILLALLOCATIONS entries for a Receipt/Payment
  // voucher, skipping On-Account (no bill linkage). Tally puts the
  // allocations on the party-side ledger entry, but we walk all entries
  // defensively in case the export shape varies.
  const extractBillAllocs = (v) => {
    const out = [];
    for (const le of (v.ledger_entries || [])) {
      for (const ba of (le.bill_allocations || [])) {
        const t = String(ba.type || '').toLowerCase();
        if (t.includes('on account')) continue;
        if (!ba.name) continue;
        out.push({ name: String(ba.name).trim(), amount: Number(ba.amount) || 0 });
      }
    }
    return out;
  };

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

    // Party-existence check for voucher types that REQUIRE a party row.
    //   Receipt / Payment    → PaymentReceipt.party_id NOT NULL
    //   Debit Note           → PurchaseReturnBill.supplier_id NOT NULL
    //   Purchase             → PurchaseBill.supplier_id NOT NULL, but
    //                          cash-named parties route to the
    //                          "Cash Purchases" stub at commit
    // Sales / Credit Note / Contra / Tally Journal don't need a strict
    // pre-check (customer_id nullable, JV legs resolved separately).
    const needsParty = ['Receipt', 'Payment', 'Debit Note'].includes(v.voucher_type)
      || (v.voucher_type === 'Purchase' && !isCashLikeName(v.party_name));
    if (needsParty) {
      if (!v.party_name) {
        buckets.reject.push({ voucher: v, reason: `${v.voucher_type} has no party name on the voucher.` });
        continue;
      }
      if (!partyKnown(v.party_name)) {
        buckets.reject.push({
          voucher: v,
          reason: `Party '${v.party_name}' not found in this import or in existing data. Create the party first or include it as a <LEDGER> in the XML.`,
        });
        continue;
      }
    }

    // Stock-item existence guard for voucher types that carry inventory.
    // Sales / Purchase / Credit Note / Debit Note all have <ALLINVENTORY-
    // ENTRIES.LIST>. If any line references a stock item not in the
    // staged masters or the products table, reject in preview rather
    // than failing at commit when the item insert tries to look it up.
    const carriesInventory = ['Sales', 'Purchase', 'Credit Note', 'Debit Note'].includes(v.voucher_type);
    if (carriesInventory && Array.isArray(v.inventory) && v.inventory.length > 0) {
      const unknown = v.inventory.find((it) => it.name && !stockItemKnown(it.name));
      if (unknown) {
        buckets.reject.push({
          voucher: v,
          reason: `Stock item '${unknown.name}' not found. Include it as a <STOCKITEM> in the XML or create the product first.`,
        });
        continue;
      }
    }

    // BILLALLOCATIONS guard for Receipt / Payment.
    if (v.voucher_type === 'Receipt' || v.voucher_type === 'Payment') {
      const allocs = extractBillAllocs(v);
      if (allocs.length > 0) {
        const billType = v.voucher_type === 'Receipt' ? 'Sales' : 'Purchase';
        const unknownNames = allocs
          .filter((a) => !billKnown(billType, a.name))
          .map((a) => a.name);
        if (unknownNames.length > 0) {
          buckets.reject.push({
            voucher: v,
            reason: `Bill reference(s) not found in DB or this XML batch: ${[...new Set(unknownNames)].join(', ')}. Import the matching ${billType} voucher first or remove the BILLALLOCATIONS.LIST entry.`,
          });
          continue;
        }
        // Stash so commit doesn't re-walk the ledger entries.
        v._bill_allocs = allocs;
      }
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
// Names that look like cash-class transaction stubs ("Cash", "Cash Sales",
// "Cash Purchases", "Bank") — Tally users sometimes set these as the
// PARTYLEDGERNAME on a counter-style voucher rather than booking it
// against an actual customer/supplier. We must NOT create a Sundry
// Debtor/Creditor row for these — the voucher's party leg should route
// to the real Cash ledger at commit time. Otherwise we end up with a
// party stub whose Dr balance pollutes Sundry Debtors AND gets
// classified as "cash" by Cash Flow's name-match resolver.
function isCashClassPartyName(n) {
  return /^\s*cash(\s+(sales|purchases?))?\s*$/i.test(String(n || ''));
}

async function ensureParties(job, ledgers) {
  const map = new Map();
  for (const lg of ledgers) {
    const isCustomer = /debtor/i.test(lg.parent || '');
    const isSupplier = /creditor/i.test(lg.parent || '');
    if (!isCustomer && !isSupplier) continue;
    // Skip cash-class names — they're not real parties. The voucher
    // commit path routes the leg to the Cash ledger directly.
    if (isCashClassPartyName(lg.name)) continue;
    const t = await sequelize.transaction();
    try {
      // Tally rarely supplies a mobile number per ledger. We used to fill
      // an unknown mobile with a "TLY..." pseudo-random stub so the
      // VARCHAR NOT NULL constraint stayed satisfied — but the UI shows
      // mobile_1 as the secondary identifier on the Sales List and the
      // Party Ledger header, and "TLY..." leaked through to those
      // surfaces (looking exactly like a fake Tally GUID). Empty string
      // is accepted by the NOT NULL constraint and the UI now treats it
      // as "no phone" alongside null. Real customer identifiers (GSTIN,
      // mobile, email) carry through correctly when Tally supplies them.
      const [party] = await Party.findOrCreate({
        where: { party_name: lg.name },
        defaults: {
          party_type: isSupplier ? 'Supplier' : 'Customer',
          party_name: lg.name,
          mobile_1: lg.mobile || '',
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

// Returns the party_id of the seeded system Cash party. Every cash sale
// AND cash purchase imported from Tally now lands on this single canonical
// row (the seeder's idempotent findOrCreate guarantees it exists; the
// partial unique index guarantees there's at most one).
//
// Replaces the old per-stub pattern: sales used to set customer_id=NULL,
// purchases used to materialise a "Cash Purchases" Supplier stub. Both of
// those leaked into Sundry Debtors/Creditors aging via party-ledger rows
// and showed up in customer/supplier dropdowns. Routing to the system
// Cash party means cash legs post to Cash-in-Hand directly (the
// voucher builder branches on party.is_system_cash), no party-ledger
// row is created, and reports cleanly filter on is_system_cash.
async function getSystemCashPartyId(t) {
  const row = await Party.findOne({ where: { is_system_cash: true }, transaction: t });
  if (!row) {
    throw new Error('Tally import: system Cash party missing — seeder not run?');
  }
  return row.party_id;
}

// ── Item-insert helper ────────────────────────────────────────────────
//
// Translates a parsed Tally <ALLINVENTORYENTRIES.LIST> into rows on the
// right *_bill_items table for the voucher kind. Sales/Sales-Return
// items use a single `rate` column; Purchase/Purchase-Return items split
// into `purchase_rate` (NOT NULL) + `sale_rate` (matches the Phase 6c
// shape used by the Excel orchestrator).
//
// Per-item GST: Tally rarely supplies it on the inventory line, so we
// derive it from the bill's effective tax rate (cgst+sgst+igst pct).
// Per-item taxable_amount = qty × rate, total_amount = same (taxes are
// summed at the bill level by the Posting Service, not duplicated on
// the line).
//
// Also writes a stock_ledger row per line so inventory reports and the
// Stock Movement view see Tally-imported transactions like manually-
// entered ones.
//
// All writes share the caller's transaction; a failure here rolls the
// whole voucher back.
async function insertVoucherItems({
  inventory, kind, idCol, billId, billNumber, billDate,
  voucherTaxablePct, productsByName, userId, transaction,
}) {
  if (!Array.isArray(inventory) || inventory.length === 0) return;

  const ItemModel =
    kind === 'sales'           ? SalesBillItem :
    kind === 'purchase'        ? PurchaseBillItem :
    kind === 'sales_return'    ? SalesReturnBillItem :
    kind === 'purchase_return' ? PurchaseReturnBillItem : null;
  if (!ItemModel) throw new Error(`insertVoucherItems: unknown kind '${kind}'`);

  const stockTxnType =
    kind === 'sales'           ? 'Sales' :
    kind === 'purchase'        ? 'Purchase' :
    kind === 'sales_return'    ? 'Sales Return' :
    kind === 'purchase_return' ? 'Purchase Return' : null;

  for (const it of inventory) {
    const qty  = Number(it.quantity) || 0;
    const rate = Number(it.rate)     || 0;
    if (qty <= 0 || !it.name) continue;

    const product = await resolveProductByName(it.name, productsByName, transaction);
    const taxable = round2(qty * rate);
    // Per-item GST falls back to product master, then to bill-level pct.
    const gstRate = (product && Number(product.gst_rate)) || voucherTaxablePct || 0;

    const itemData = {
      [idCol]: billId,
      product_id: product ? product.product_id : null,
      barcode: product ? product.barcode : null,
      product_name: it.name,
      hsn_code: product ? product.hsn_code : null,
      quantity: qty,
      mrp: 0,
      taxable_amount: taxable,
      gst_rate: gstRate,
      total_amount: taxable,
    };
    if (kind === 'purchase') {
      // PurchaseBillItem.purchase_rate is NOT NULL. sale_rate falls back
      // to product master, else mirrors purchase_rate so the column has
      // a sensible value.
      itemData.purchase_rate = rate;
      // Decimal columns come back as strings — "0.00" is truthy, so the
      // naïve `product.sale_rate || rate` fall-back never kicks in.
      // Coerce first, then fall back when the numeric value is zero.
      itemData.sale_rate = product ? (Number(product.sale_rate) || rate) : rate;
    } else {
      itemData.rate = rate;
      if (kind === 'sales') {
        // Snapshot COGS at sale time — same convention live sales flow uses.
        itemData.cost_rate = product ? Number(product.purchase_rate || 0) : 0;
      }
    }
    await ItemModel.create(itemData, { transaction });

    // Stock ledger movement — qty in for Purchase / Sales Return, qty out
    // for Sales / Purchase Return. The reference_id ties the row back to
    // the bill so Stock Movement and bill-cancellation cleanup work.
    if (product && stockTxnType) {
      const isInbound = stockTxnType === 'Purchase' || stockTxnType === 'Sales Return';
      // Refresh the running balance from the product row. Live flows do a
      // similar incremental update; we keep it simple here since the
      // post-import re-sync sweep in server/index.js reconciles anyway.
      const currentStock = Number(product.current_stock) || 0;
      const newStock = isInbound ? currentStock + qty : currentStock - qty;
      await StockLedger.create({
        product_id: product.product_id,
        barcode: product.barcode,
        transaction_type: stockTxnType,
        transaction_date: billDate,
        reference_id: billId,
        reference_number: billNumber,
        quantity_in:  isInbound ? qty : 0,
        quantity_out: isInbound ? 0   : qty,
        rate, balance_quantity: newStock,
        created_by: userId || null,
      }, { transaction });
      await Product.update(
        { current_stock: newStock },
        { where: { product_id: product.product_id }, transaction },
      );
      // Update the cached product so subsequent lines on the same bill
      // see the freshly-updated stock.
      product.current_stock = newStock;
    }
  }
}

// Shared product resolver. In-batch staged map (from <STOCKITEM>
// masters) first, products table second. Same shape as resolvePartyByName.
async function resolveProductByName(name, productsByName, transaction) {
  if (!name) return null;
  const cached = productsByName.get(name);
  if (cached) return cached;
  const row = await Product.findOne({ where: { product_name: name }, transaction });
  if (row) productsByName.set(name, row);
  return row;
}

// Shared party resolver. Used by both the validate phase (existence
// check) and every commit branch. Looking up only in `partiesByName`
// (the in-batch staged map populated from the XML's <LEDGER> masters)
// missed parties that already existed in the DB from a prior import —
// e.g., "Sharma Cloth House" created via Excel customers earlier and
// referenced by Receipt/Payment vouchers in a later Tally re-import.
//
// Order:
//   1. In-batch staged map (fastest; covers parties just created).
//   2. parties table by exact party_name match.
//   3. null — caller decides whether to reject or substitute.
//
// The DB hit is cached on partiesByName so subsequent vouchers in the
// same import don't re-query for the same name.
async function resolvePartyByName(name, partiesByName, transaction) {
  if (!name) return null;
  const cached = partiesByName.get(name);
  if (cached) return cached;
  const row = await Party.findOne({ where: { party_name: name }, transaction });
  if (row) partiesByName.set(name, row);
  return row;
}

// Same convention as the Phase-1 party opening JV: fy_start − 1 day so
// the row sorts strictly before any regular transaction. Falls back to
// today − 1 if no FY is configured.
async function tallyOpeningDate(transaction) {
  const settings = await SystemSettings.findOne({ where: { setting_id: 1 }, transaction });
  if (settings && settings.financial_year_start) {
    const fy = new Date(settings.financial_year_start);
    fy.setDate(fy.getDate() - 1);
    return fy.toISOString().slice(0, 10);
  }
  const t = new Date();
  t.setDate(t.getDate() - 1);
  return t.toISOString().slice(0, 10);
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
      const openingQty = Number(it.opening_stock) || 0;
      const [prod, created] = await Product.findOrCreate({
        where: { product_name: it.name },
        defaults: {
          product_name: it.name,
          barcode: bc,
          category_id: category.category_id,
          gst_rate: it.gst_rate || 0,
          opening_stock: openingQty,
          current_stock: openingQty,
        },
        transaction: t,
      });
      map.set(it.name, prod);
      // Stock-ledger Opening row. Only emit on first creation AND when
      // the product genuinely has opening stock; re-importing the same
      // STOCKITEM master must not double up the opening. The "first
      // creation" gate is `created` (Sequelize's findOrCreate flag),
      // belt-and-suspenders with an existence check on the ledger row
      // so any earlier crashed run that left the product but not the
      // opening row gets self-healed on next import.
      if (openingQty > 0) {
        const has = await StockLedger.count({
          where: { product_id: prod.product_id, transaction_type: 'Opening Stock' },
          transaction: t,
        });
        if (has === 0) {
          await StockLedger.create({
            product_id: prod.product_id,
            barcode: prod.barcode,
            transaction_type: 'Opening Stock',
            transaction_date: await tallyOpeningDate(t),
            reference_number: 'OPENING',
            quantity_in: openingQty,
            quantity_out: 0,
            rate: 0,
            balance_quantity: openingQty,
            remarks: 'Opening Stock (Tally import)',
            created_by: job.created_by || null,
          }, { transaction: t });
        }
      }
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

      const partyRow = await resolvePartyByName(v.party_name, partiesByName, t);
      let partyId = partyRow ? partyRow.party_id : null;
      // Cash sale or cash purchase: PARTYLEDGERNAME matches the
      // cash-class regex (^Cash, ^Cash Sales, ^Cash Purchases, ^Bank).
      // Route both to the seeded system Cash party — its
      // is_system_cash flag makes the voucher builder post the cash
      // leg to Cash-in-Hand directly (no party tag, no party-ledger
      // row, no clutter in receivables/payables aging). Replaces the
      // old NULL-customer / per-import "Cash Purchases" stub pattern.
      let isCashVoucher = false;
      if (!partyId && isCashClassPartyName(v.party_name)) {
        partyId = await getSystemCashPartyId(t);
        isCashVoucher = true;
      }
      // Pre-existing local aliases used downstream (book the bill as
      // paid-in-full). Single flag for both directions; legacy names
      // kept for the data + receipt-vs-payment branching below.
      const isCashPurchase = isCashVoucher && !isSales;
      const isCashSale     = isCashVoucher && isSales;

      let billRow;
      if (action === 'update') {
        billRow = await Bill.findOne({ where: { bill_number: v.voucher_number }, transaction: t });
        if (!billRow) throw new Error('Update target row vanished.');
        await reverseVoucher({ sourceType,         sourceId: billRow[idCol], reason: 'Tally re-import update', transaction: t });
        await reverseVoucher({ sourceType: subType, sourceId: billRow[idCol], reason: 'Tally re-import update', transaction: t });
        // Re-import update: wipe old item rows + old stock_ledger rows
        // before re-inserting from the new XML. Without this, an edit
        // would silently double the line items.
        const ItemModelUpd = isSales ? SalesBillItem : PurchaseBillItem;
        await ItemModelUpd.destroy({ where: { [idCol]: billRow[idCol] }, transaction: t });
        await StockLedger.destroy({
          where: {
            reference_id: billRow[idCol],
            transaction_type: isSales ? 'Sales' : 'Purchase',
          },
          transaction: t,
        });
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
          paid_amount: (isCashPurchase || isCashSale) ? totals.total_amount : 0,
          balance_amount: (isCashPurchase || isCashSale) ? 0 : totals.total_amount,
          payment_status: (isCashPurchase || isCashSale) ? 'Paid' : 'Unpaid',
          payment_method: 'Cash',
        };
        billRow = await Bill.create(data, { transaction: t });
      }

      // Insert item rows from <ALLINVENTORYENTRIES.LIST>. Same shape as
      // the Excel orchestrator (Phase 6c convention for Purchase items:
      // purchase_rate is NOT NULL, sale_rate falls back to product
      // master). Also writes stock_ledger movements so inventory reports
      // see Tally-imported transactions like manual ones.
      await insertVoucherItems({
        inventory: v.inventory,
        kind: isSales ? 'sales' : 'purchase',
        idCol, billId: billRow[idCol],
        billNumber: v.voucher_number,
        billDate: v.voucher_date,
        voucherTaxablePct: totals.cgst_pct + totals.sgst_pct + totals.igst_pct,
        productsByName, userId: job.created_by, transaction: t,
      });

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
      // Look up via shared resolver — both in-batch and DB. Validate phase
      // already enforces existence so this should always succeed; the
      // throw is a defence-in-depth guard.
      const partyRow = await resolvePartyByName(v.party_name, partiesByName, t);
      const partyId = partyRow ? partyRow.party_id : null;
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

      // Bill-payment allocations (R9 Phase 1). Tally's BILLALLOCATIONS.LIST
      // (parsed in validate, stashed on v._bill_allocs) wins; otherwise
      // FIFO against the party's outstanding bills as of voucher_date.
      // The shared service is idempotent on transaction_id, so re-imports
      // don't double-write.
      const { allocateForReceipt } = require('./billAllocationService');
      const refs = Array.isArray(v._bill_allocs) && v._bill_allocs.length > 0
        ? v._bill_allocs.map((a) => ({ bill_number: a.name, amount: a.amount }))
        : null;
      await allocateForReceipt({
        receiptId:       row.transaction_id,
        partyId:         partyId,
        transactionType: v.voucher_type,
        asOfDate:        v.voucher_date,
        totalAmount:     totals.total_amount,
        references:      refs,
        method:          'import_tally',
        t,
      });

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
      const partyRow = await resolvePartyByName(v.party_name, partiesByName, t);
      const partyId = partyRow ? partyRow.party_id : null;
      if (!isCN && !partyId) throw new Error('Debit Note has no supplier (supplier_id NOT NULL).');

      let row;
      const ItemModelRet = isCN ? SalesReturnBillItem : PurchaseReturnBillItem;
      const stockTxnTypeRet = isCN ? 'Sales Return' : 'Purchase Return';
      if (action === 'update') {
        row = await ReturnBill.findOne({ where: { return_number: v.voucher_number }, transaction: t });
        if (!row) throw new Error('Update target return bill vanished.');
        await reverseVoucher({ sourceType, sourceId: row[idCol], reason: 'Tally re-import update', transaction: t });
        // Wipe old item rows + stock movements before re-inserting from
        // the new XML. Same pattern as the sales/purchase update branch.
        await ItemModelRet.destroy({ where: { [idCol]: row[idCol] }, transaction: t });
        await StockLedger.destroy({
          where: { reference_id: row[idCol], transaction_type: stockTxnTypeRet },
          transaction: t,
        });
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
      // Insert return item rows + stock movements before posting.
      await insertVoucherItems({
        inventory: v.inventory,
        kind: isCN ? 'sales_return' : 'purchase_return',
        idCol, billId: row[idCol],
        billNumber: v.voucher_number,
        billDate: v.voucher_date,
        voucherTaxablePct: totals.cgst_pct + totals.sgst_pct + totals.igst_pct,
        productsByName, userId: job.created_by, transaction: t,
      });
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
  // 1. Party leg — resolve via the shared helper so a party that lives
  // in the DB but isn't in this XML's <LEDGER> masters still wins.
  if (le.classification === 'party_or_other') {
    const party = await resolvePartyByName(le.name, partiesByName, t);
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

// ── __test__validateAllocations ──────────────────────────────────────
// Test hook for server/scripts/test-phase-r9.js. Mirrors the validate-
// phase BILLALLOCATIONS guard on a single voucher with no in-batch
// dependencies — bills are looked up only in the DB. Returns
// { ok: bool, unknown: string[] }.
async function __test__validateAllocations({ voucher }) {
  if (voucher.voucher_type !== 'Receipt' && voucher.voucher_type !== 'Payment') {
    return { ok: true, unknown: [] };
  }
  const billType = voucher.voucher_type === 'Receipt' ? 'Sales' : 'Purchase';
  const allocs = [];
  for (const le of (voucher.ledger_entries || [])) {
    for (const ba of (le.bill_allocations || [])) {
      const t = String(ba.type || '').toLowerCase();
      if (t.includes('on account')) continue;
      if (!ba.name) continue;
      allocs.push(String(ba.name).trim());
    }
  }
  if (allocs.length === 0) return { ok: true, unknown: [] };
  const Model = billType === 'Sales' ? SalesBill : PurchaseBill;
  const rows = await Model.findAll({ where: { bill_number: allocs }, attributes: ['bill_number'] });
  const known = new Set(rows.map((r) => r.bill_number));
  const unknown = allocs.filter((n) => !known.has(n));
  return { ok: unknown.length === 0, unknown };
}

module.exports = {
  run, _commit: commit, _validateAndPreview: validateAndPreview, _computeVoucherTotals: computeVoucherTotals, isCashClassPartyName,
  // Test hook — server/scripts/test-phase-r9.js
  __test__validateAllocations,
};
