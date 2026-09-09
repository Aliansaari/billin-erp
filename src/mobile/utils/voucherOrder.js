/**
 * Newest-transaction-first ordering for day-book style rows.
 *
 * The obvious `Number(b.entry_number) - Number(a.entry_number)` does NOT work
 * and was silently doing nothing: entry numbers look like "JV-20260331-0001",
 * so Number() gives NaN, the comparator returns NaN, and the spec says a
 * comparator returning NaN leaves the order untouched. Rows therefore came
 * back in whatever order the server produced (oldest first), which read as
 * random.
 *
 * Sort by date first, then by entry number as a string. The number carries a
 * zero-padded sequence, so a plain string comparison orders same-day rows
 * correctly without parsing anything.
 */
export function compareVouchersNewestFirst(a, b) {
  const da = String(a?.entry_date || a?.bill_date || a?.voucher_date || '');
  const db = String(b?.entry_date || b?.bill_date || b?.voucher_date || '');
  if (da !== db) return db.localeCompare(da);          // ISO dates sort as text

  const na = String(a?.entry_number || a?.voucher_no || a?.bill_number || '');
  const nb = String(b?.entry_number || b?.voucher_no || b?.bill_number || '');
  // numeric:true so "…-0009" sorts before "…-0010" rather than after it.
  return nb.localeCompare(na, undefined, { numeric: true, sensitivity: 'base' });
}

/** Copy of `rows`, newest first. */
export const sortVouchersNewestFirst = (rows) =>
  [...(rows || [])].sort(compareVouchersNewestFirst);
