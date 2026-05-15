// ── Indian number formatting helpers (UI-C6) ──────────────────────────
//
// Indian convention groups by 2-2-3 from the right, not 3-3-3:
//   100000   → '1,00,000'        (one lakh)
//   1000000  → '10,00,000'       (ten lakh)
//   10000000 → '1,00,00,000'     (one crore)
//
// Pre-fix, AntD InputNumber `formatter` props across the app used the
// Western pattern `/\B(?=(\d{3})+(?!\d))/g` which renders ₹1,00,000 as
// ₹100,000 — a Tally user reads that as "one hundred thousand" instead
// of "one lakh" and types a value 10× off when re-entering. Static read
// labels (toLocaleString('en-IN')) were already correct; only the
// editable InputNumber formatter was Western.
//
// `formatINR` returns the grouped digit string only (no currency sign,
// no decimals — caller controls those for InputNumber's `formatter`
// signature). The parser side stays trivial (strip commas, parseFloat).

/**
 * Group digits per Indian convention. Decimal portion (if any) is kept
 * verbatim — only the integer part is regrouped.
 *
 *   indianGroup('1234567.89') → '12,34,567.89'
 *   indianGroup('100000')     → '1,00,000'
 *   indianGroup('999')        → '999'
 *   indianGroup('-1234567')   → '-12,34,567'
 *   indianGroup('')           → ''
 */
export function indianGroup(value) {
  if (value == null) return '';
  const s = String(value);
  if (s === '') return '';
  // Preserve leading minus and any decimal portion.
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [intPart, decPart] = body.split('.');
  // Last 3 digits are grouped first; the rest is grouped in pairs.
  const last3 = intPart.slice(-3);
  const rest  = intPart.slice(0, -3);
  const groupedRest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${groupedRest},${last3}` : last3;
  return (negative ? '-' : '') + grouped + (decPart !== undefined ? '.' + decPart : '');
}

/**
 * AntD InputNumber `formatter`. Prefixes with ₹ + space.
 * Caller passes this directly:
 *   <InputNumber formatter={inrFormatter} parser={inrParser} />
 */
export function inrFormatter(v) {
  if (v == null || v === '') return '';
  return `₹ ${indianGroup(v)}`;
}

/**
 * AntD InputNumber `parser` — strip ₹, spaces, commas; return the bare
 * numeric string. AntD will then parseFloat it.
 */
export function inrParser(v) {
  if (v == null) return '';
  return String(v).replace(/₹|,|\s/g, '');
}

/**
 * Bare-number formatter (no ₹ prefix) for cases where the field already
 * has a unit label outside it.
 */
export function numberFormatter(v) {
  if (v == null || v === '') return '';
  return indianGroup(v);
}

// ── UI-C7 — disabledDate guard for voucher pickers ───────────────────
//
// Pairs with the server-side CR-5 future-FY block. Lets operators back-
// date or forward-date freely WITHIN the current Indian financial year
// (April 1 → March 31), but greys out anything beyond it. Without this,
// a typo of 2027 instead of 2026 produced a future-FY save that the
// server now rejects — but the operator only learns AFTER pressing F1.
// `disabledDate` is the AntD DatePicker prop; takes a dayjs object.
export function disabledDateForVoucher(current) {
  if (!current) return false;
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  // Current FY ends March 31 of (this year + 1) if today is April-onwards,
  // otherwise March 31 of this year.
  const fyEndYear = month >= 4 ? year + 1 : year;
  // Compare on day granularity. `current` is a dayjs object from AntD.
  // Audit (UI live test) — pre-fix used `current.constructor(string)` to
  // build the FY-end dayjs. AntD's bundled dayjs (with its plugin chain)
  // crashed `r3.parse` on the plain `YYYY-MM-DD` string with "Cannot
  // read properties of undefined (reading '1')", taking the entire
  // Sales/Purchase form's render down with an ErrorBoundary fallback.
  // Switching to pure dayjs accessor chaining (year/month/date setters
  // return new instances) avoids the parser path entirely.
  const fyEnd = current.year(fyEndYear).month(2).date(31).endOf('day');
  return current.isAfter(fyEnd, 'day');
}
