const dayjs = require('dayjs');

// prefix = custom prefix from settings (e.g. "INV"), or empty string for plain 0001
function generateBillNumber(prefix, lastNumber) {
  const num = String((lastNumber || 0) + 1).padStart(4, '0');
  return prefix ? `${prefix}-${num}` : num;
}

function generateTransactionNumber(prefix, lastNumber) {
  const num = String((lastNumber || 0) + 1).padStart(6, '0');
  return `${prefix}-${num}`;
}

/**
 * Safely extract the trailing numeric segment of a bill/transaction number.
 * Audit P2-J — `parseInt('12-AMD')` returns 12, so legacy external imports
 * with non-numeric suffixes (e.g. INV-50/A) would poison the counter:
 *   last_bill = "INV-50/A"  → parseInt("A") = NaN  (already fine)
 *   last_bill = "INV-12-AMD"→ parseInt("AMD") = NaN  (fine)
 *   last_bill = "INV-50A"   → split('-').pop() = "50A" → parseInt = 50  ← problem
 *
 * This helper only accepts a tail that's PURELY digits — anything else
 * returns 0 so the next call falls back to allocating from 1 (the
 * advisory lock + caller's ORDER BY ensures no collision happens at
 * runtime; this only matters if a stray import row has a weird suffix).
 */
function safeTrailingNumber(numberStr) {
  if (!numberStr) return 0;
  const tail = String(numberStr).split('-').pop();
  if (!/^\d+$/.test(tail)) return 0;
  const parsed = parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Escape SQL LIKE wildcards in user-supplied search strings (audit P3-D).
 *
 * Sequelize parameterises the query so SQL INJECTION is not the concern —
 * but `%` and `_` are still LIKE wildcards. A user typing `%` as their
 * search term turns an indexed `ILIKE '%X%'` lookup into a full-table
 * scan (every row matches), which is a cheap DoS vector on the larger
 * tables (50k+ bills, hundreds of thousands of stock_ledger rows).
 *
 * Use:
 *   const safe = escapeLike(req.query.search);
 *   where[Op.iLike] = `%${safe}%`;
 *
 * Backslash is the default LIKE escape character in Postgres; we also
 * escape the backslash itself so a literal backslash in the search term
 * doesn't accidentally escape the next character.
 */
function escapeLike(s) {
  if (s == null) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Round `n` to `decimals` places using "round half away from zero" —
 * the convention required by Indian GST:
 *   1.5   →  2      -1.5   → -2
 *   2.5   →  3      -2.5   → -3
 *   1.005 →  1.01   -1.005 → -1.01
 *
 * Why a custom helper:
 *  - JavaScript's Math.round rounds half toward +∞ (ASYMMETRIC for negatives),
 *    so Math.round(-0.5) = 0, not -1. That breaks refund/return-note rounding.
 *  - toFixed() uses banker's rounding (round-half-to-even) in V8, so
 *    (1.005).toFixed(2) is sometimes "1.00" not "1.01" — a silent 1 paisa
 *    drift that accumulates across thousands of invoices and mismatches the GST-standard total.
 *
 * Implementation:
 *  - Split the sign, scale up to integer, Math.round, scale back.
 *  - Nudge by 1e-10 to absorb floating-point representation errors in
 *    inputs like 1.005 (actually stored as 1.00499999999…).
 */
function roundTo(n, decimals = 2) {
  // Audit P3-A — surface NaN/Infinity loudly via a stack-trace log so
  // upstream bugs are visible during dev/QA, but still return 0 in
  // production so a stray NaN doesn't 500 a customer's bill save. The
  // log is the actionable signal — every line of money math that ever
  // produces NaN now leaves a breadcrumb in the server console.
  if (n === 0) return 0;
  if (!Number.isFinite(n)) {
    console.error('[roundTo] non-finite input:', n, '\n', new Error().stack);
    return 0;
  }
  const factor = Math.pow(10, decimals);
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(n) * factor + 1e-10) / factor;
}

function roundOff(amount) {
  // Round the BILL TOTAL to the nearest rupee — CGST Rules say fractions ≥ 50p
  // round up, <50p round down. roundTo(x, 0) with round-half-away-from-zero
  // matches that rule exactly.
  const rounded = roundTo(amount, 0);
  return {
    roundedAmount: rounded,
    // roundOffValue = what we added/subtracted so the bill ends on a whole rupee.
    // Kept at 2 decimals for the ledger line; sign matches the direction.
    roundOffValue: roundTo(rounded - amount, 2),
  };
}

function calculateGST(taxableAmount, gstRate, isInterState = false) {
  const totalTax = roundTo(taxableAmount * gstRate / 100, 2);
  if (isInterState) {
    return { cgst: 0, sgst: 0, igst: totalTax };
  }
  // Split the tax into CGST + SGST. Rounding each half independently can drift
  // by 1 paisa (₹0.01) from totalTax — e.g. ₹1.00 / 2 = 0.50 + 0.50 = 1.00 ✓
  // but ₹1.01 / 2 = 0.505 + 0.505 where each half rounds to 0.51 → 1.02 ✗.
  // Fix: round the first half; give the remainder to the second so the two
  // halves always reconcile to totalTax exactly.
  const half = roundTo(totalTax / 2, 2);
  return { cgst: half, sgst: roundTo(totalTax - half, 2), igst: 0 };
}

/**
 * Audit H2 — paisa-perfect CGST/SGST/IGST split for bill-wise mode.
 *
 * The bill-wise controller paths used to do:
 *   totalCgst = roundTo(taxableTotal * cgst_pct / 100, 2)
 *   totalSgst = roundTo(taxableTotal * sgst_pct / 100, 2)
 *   totalIgst = roundTo(taxableTotal * igst_pct / 100, 2)
 * which can drift ±₹0.01 from the true combined tax (because each half is
 * rounded independently). At 50k bills/year × 1 paisa drift = ~₹500/yr of
 * silent variance against the GST-standard reconciliation.
 *
 * This helper computes the combined tax first, then divides into the two
 * halves so the second absorbs the rounding residual — same algorithm as
 * calculateGST but driven by explicit percentages (not a single combined
 * gst_rate).
 *
 * Behaviour:
 *   - Pure intra-state (cgst_pct>0, sgst_pct>0, igst_pct==0): combined =
 *     roundTo(base*(cgst+sgst)/100); first half rounded; second = combined
 *     − first. Both halves sum to combined exactly.
 *   - Pure inter-state (igst_pct>0, others==0): igst = roundTo(base*igst/100).
 *   - Only CGST or only SGST present: that ledger gets the full combined tax.
 *   - Mixed CGST+SGST+IGST: callers should reject via H1 before reaching
 *     this helper. We still split safely if the caller chooses not to.
 *
 * The caller already validates (a) mutual exclusion and (b) state-of-supply
 * agreement (audit H1). This helper only does the math.
 */
function splitBillWiseGst(taxableTotal, cgstPct, sgstPct, igstPct) {
  const base = parseFloat(taxableTotal) || 0;
  const cP = parseFloat(cgstPct) || 0;
  const sP = parseFloat(sgstPct) || 0;
  const iP = parseFloat(igstPct) || 0;
  const combinedPct = cP + sP;
  let cgst = 0, sgst = 0;
  if (combinedPct > 0) {
    const combinedTax = roundTo(base * combinedPct / 100, 2);
    if (cP > 0 && sP > 0) {
      const cgstShare = roundTo(combinedTax * cP / combinedPct, 2);
      cgst = cgstShare;
      sgst = roundTo(combinedTax - cgstShare, 2);
    } else if (cP > 0) {
      cgst = combinedTax;
    } else {
      sgst = combinedTax;
    }
  }
  const igst = roundTo(base * iP / 100, 2);
  return { cgst, sgst, igst };
}

// ─── Indian GST slabs (CR-6) ────────────────────────────────────────
//
// As of FY 2026-27 the Indian GST schedule allows: 0, 0.1, 0.25, 1, 1.5,
// 3, 5, 6, 7.5, 12, 18, 28. Any other rate gets rejected by the GSTN
// portal during GSTR-1 upload, but the rejection happens DOWNSTREAM —
// the bill is already saved in our books with an illegal rate. The
// portal error message points at "row X" of a JSON, not at a specific
// bill, so an operator has to manually correlate.
//
// `isLegalGstSlab` is the single source of truth: server-side validation
// in sales/purchase create + product master save funnel through here.
// Adding a new slab (rare, requires a Notification) means editing one
// constant.
const LEGAL_GST_SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];
function isLegalGstSlab(rate) {
  const n = parseFloat(rate);
  if (!Number.isFinite(n) || n < 0) return false;
  // Use a 0.001 tolerance so a string "5.00" or "5" both pass.
  return LEGAL_GST_SLABS.some(slab => Math.abs(slab - n) < 0.001);
}
function gstSlabError(rate) {
  return `GST rate ${rate}% is not a legal Indian slab. Valid slabs: ${LEGAL_GST_SLABS.join(', ')}.`;
}

// ─── Sequelize → HTTP error mapper (LIVE-7) ────────────────────────
//
// Pre-fix, controllers catch Sequelize errors and return generic 500
// "Server error". This hides the real cause from the operator AND from
// the frontend (which can't surface a useful message). For an enum
// violation (e.g. unit_of_measurement='NOS' when enum is {PCS,KG,...}),
// the database tells us EXACTLY which field is wrong; we should pass
// that through as a 400.
//
// Usage in a catch block:
//   } catch (err) {
//     return respondWithError(res, err, 'Default 500 message');
//   }
function respondWithError(res, err, defaultMsg = 'Server error') {
  if (err && err.name) {
    const name = err.name;
    if (name === 'SequelizeValidationError') {
      const e = (err.errors && err.errors[0]) || {};
      return res.status(400).json({
        error: e.message || err.message || 'Validation error',
        field: e.path || undefined,
      });
    }
    if (name === 'SequelizeUniqueConstraintError') {
      const e = (err.errors && err.errors[0]) || {};
      return res.status(400).json({
        error: `Duplicate value: ${e.path || 'unique field'} already exists`,
        field: e.path || undefined,
      });
    }
    if (name === 'SequelizeForeignKeyConstraintError') {
      return res.status(400).json({
        error: 'Referenced record does not exist or is in use elsewhere',
      });
    }
    if (name === 'SequelizeDatabaseError') {
      // Postgres surface — extract the first line of the error which is
      // usually the actionable hint (e.g. "invalid input value for enum
      // enum_products_unit_of_measurement: \"NOS\"").
      const original = err.original || {};
      const detail = original.detail || original.message || err.message;
      // Surface enum / type / length errors as 400; truly internal errors
      // (column-not-found, syntax errors) bubble up as 500.
      const firstLine = String(detail || '').split('\n')[0];
      if (/^(invalid input value|value too long|null value in column|new row for relation)/i.test(firstLine)) {
        return res.status(400).json({ error: firstLine });
      }
    }
  }
  console.error('Server error:', err);
  return res.status(500).json({ error: defaultMsg });
}

function paginateQuery(query, page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  return { ...query, limit, offset };
}

/**
 * Sanitise page/limit query params.
 *
 * Why:
 *  - Raw `req.query.page` and `req.query.limit` are untrusted strings.
 *    "abc" → NaN → offset becomes NaN → Sequelize generates invalid SQL.
 *    "-5"  → negative offset → Postgres throws.
 *    "999999" → a single request can dump the whole table (DoS vector).
 *  - Per-endpoint maxLimit lets reports (many rows) and pickers (few rows)
 *    enforce different ceilings without code duplication at each call site.
 *
 * Returns parsed integers + computed offset, always in a safe range.
 */
function sanitizePagination(rawPage, rawLimit, { defaultLimit = 50, maxLimit = 500 } = {}) {
  // Audit NEW-LO-2 — `?all=1` (or `?limit=all`) bypasses pagination by
  // requesting up to maxLimit rows in one page. Scripted callers
  // (exports, audit drivers, the verify_reports.py harness) previously
  // had to know each endpoint's maxLimit and pass `limit=1000`; now
  // they pass `all=1` and get every row in scope. UI callers that
  // omit the param still get the default 50-row page.
  const wantsAll = String(rawLimit || '').toLowerCase() === 'all';
  const page  = Math.max(1, parseInt(rawPage,  10) || 1);
  const limit = wantsAll
    ? maxLimit
    : Math.min(maxLimit, Math.max(1, parseInt(rawLimit, 10) || defaultLimit));
  const offset = wantsAll ? 0 : (page - 1) * limit;
  return { page, limit, offset };
}

module.exports = {
  generateBillNumber,
  generateTransactionNumber,
  safeTrailingNumber,
  escapeLike,
  roundOff,
  roundTo,
  calculateGST,
  splitBillWiseGst,
  isLegalGstSlab,
  gstSlabError,
  LEGAL_GST_SLABS,
  respondWithError,
  paginateQuery,
  sanitizePagination,
};
