/**
 * Field-scoped search: `a:` article, `b:` barcode, `n:` name, `h:` HSN.
 *
 * On a large catalogue a bare term matches across every field at once, so
 * looking up a known article number returns a pile of unrelated products whose
 * name or barcode happens to contain the same characters. A prefix narrows it
 * to the one field the user is actually holding in their hand.
 *
 * Unprefixed input keeps the old behaviour — matching everything — because
 * that is what someone typing a half-remembered product name wants.
 *
 * Accepts `a:` and `a ` (a colon or a space), upper or lower case, so it
 * survives a phone keyboard that capitalises the first letter.
 */

export const SEARCH_FIELDS = {
  a: { key: 'article', label: 'Article', fields: ['article_number'] },
  b: { key: 'barcode', label: 'Barcode', fields: ['barcode', 'sku', 'product_code'] },
  n: { key: 'name',    label: 'Name',    fields: ['product_name', 'name'] },
  h: { key: 'hsn',     label: 'HSN',     fields: ['hsn_code'] },
};

/** All fields searched when no prefix is given. */
const ALL_FIELDS = ['product_name', 'name', 'barcode', 'sku', 'product_code',
                    'article_number', 'hsn_code'];

/**
 * Split "a:r55" into { scope, term, fields }.
 * `scope` is null when the input carries no recognised prefix.
 */
export function parseSearch(raw) {
  const text = String(raw || '').trim();
  if (!text) return { scope: null, term: '', fields: ALL_FIELDS, label: null };

  const m = /^([abnh])\s*[:\s]\s*(.*)$/i.exec(text);
  if (m) {
    const spec = SEARCH_FIELDS[m[1].toLowerCase()];
    if (spec) {
      return { scope: spec.key, term: m[2].trim(), fields: spec.fields, label: spec.label };
    }
  }
  return { scope: null, term: text, fields: ALL_FIELDS, label: null };
}

/** Does `row` match this parsed query? */
export function matchesSearch(row, parsed) {
  const term = (parsed.term || '').toLowerCase();
  if (!term) return true;
  return parsed.fields.some((f) =>
    String(row?.[f] ?? '').toLowerCase().includes(term));
}

/** Convenience: filter a list with a raw query string. */
export function filterBySearch(rows, raw) {
  const parsed = parseSearch(raw);
  if (!parsed.term) return rows;
  return rows.filter((r) => matchesSearch(r, parsed));
}
