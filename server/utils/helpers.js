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
 * Audit P2-J — `parseInt('12-AMD')` returns 12, so legacy Tally imports
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
 * the convention followed by Tally Prime and required by Indian GST:
 *   1.5   →  2      -1.5   → -2
 *   2.5   →  3      -2.5   → -3
 *   1.005 →  1.01   -1.005 → -1.01
 *
 * Why a custom helper:
 *  - JavaScript's Math.round rounds half toward +∞ (ASYMMETRIC for negatives),
 *    so Math.round(-0.5) = 0, not -1. That breaks refund/return-note rounding.
 *  - toFixed() uses banker's rounding (round-half-to-even) in V8, so
 *    (1.005).toFixed(2) is sometimes "1.00" not "1.01" — a silent 1 paisa
 *    drift that accumulates across thousands of invoices and mismatches Tally.
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
  const page  = Math.max(1, parseInt(rawPage,  10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(rawLimit, 10) || defaultLimit));
  const offset = (page - 1) * limit;
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
  paginateQuery,
  sanitizePagination,
};
