/**
 * Displaying a voucher number.
 *
 * Shops configure their own bill-number prefix in Company Profile. Some use
 * one ("INV-0623"), some do not ("0623"), and the API returns whatever is
 * stored — the prefix is part of the number, not decoration added at render
 * time. Code that unconditionally prepends its own produced "INV-INV-0623"
 * for every shop in the first group, which is both wrong and looks broken.
 *
 * So: a number that already carries a prefix is shown exactly as stored, and
 * only a bare numeric one gets a prefix added so it reads as a document
 * reference rather than a stray figure.
 */

/** Does this number already carry the shop's own prefix? */
const HAS_PREFIX = /[A-Za-z]/;

/**
 * @param {string} num   the number as stored (bill_number / voucher_no)
 * @param {'sale'|'purchase'|'receipt'|'payment'|string} kind
 */
export function displayVoucherNo(num, kind = '') {
  const raw = String(num ?? '').trim();
  if (!raw) return '';
  if (HAS_PREFIX.test(raw)) return raw;
  return kind === 'sale' ? `INV-${raw}` : `#${raw}`;
}
