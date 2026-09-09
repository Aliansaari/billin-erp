/**
 * Field-scoped product search: `a:` article, `b:` barcode, `n:` name, `h:` HSN.
 *
 * On a large catalogue a bare term matches across every field at once, so
 * looking up a known article number returns a pile of unrelated products whose
 * name or barcode happens to contain the same characters. A prefix narrows it
 * to the one field the user is holding in their hand.
 *
 * Terms COMBINE. "a: 668 plazo" means article-contains-668 AND
 * matches-plazo-somewhere — which is how a shopkeeper actually narrows down
 * ("the 668-series plazo"), and what the single-term version got wrong by
 * treating "668 plazo" as one article number that matches nothing.
 *
 * Unprefixed input keeps the old behaviour, matching every field, because
 * that is what someone typing a half-remembered name wants.
 *
 * A space works as well as a colon ("a 668"), since phone keyboards
 * capitalise and fight punctuation.
 */

export const SEARCH_FIELDS = {
  a: { key: 'article', label: 'Article', fields: ['article_number'] },
  b: { key: 'barcode', label: 'Barcode', fields: ['barcode', 'sku', 'product_code'] },
  n: { key: 'name',    label: 'Name',    fields: ['product_name', 'name'] },
  h: { key: 'hsn',     label: 'HSN',     fields: ['hsn_code'] },
};

const ALL_FIELDS = ['product_name', 'name', 'barcode', 'sku', 'product_code',
                    'article_number', 'hsn_code', 'category_name'];

/**
 * Split "a: 668 plazo" into:
 *   scope 'article', term '668'      → the scoped part, sent to the server
 *   extra ['plazo']                  → further words, matched across any field
 */
export function parseSearch(raw) {
  const text = String(raw || '').trim();
  if (!text) return { scope: null, term: '', extra: [], fields: ALL_FIELDS, label: null };

  const m = /^([abnh])\s*[:\s]\s*(.*)$/i.exec(text);
  if (m) {
    const spec = SEARCH_FIELDS[m[1].toLowerCase()];
    if (spec) {
      const words = m[2].trim().split(/\s+/).filter(Boolean);
      return {
        scope: spec.key,
        term: words[0] || '',
        extra: words.slice(1),
        fields: spec.fields,
        label: spec.label,
      };
    }
  }
  // No prefix: every word must match somewhere, so "baba 668" narrows rather
  // than returning everything containing either word.
  const words = text.split(/\s+/).filter(Boolean);
  return { scope: null, term: words[0] || text, extra: words.slice(1), fields: ALL_FIELDS, label: null };
}

const hits = (row, fields, needle) => {
  const n = needle.toLowerCase();
  return fields.some((f) => String(row?.[f] ?? '').toLowerCase().includes(n));
};

/** Does `row` satisfy the scoped term AND every extra word? */
export function matchesSearch(row, parsed) {
  if (parsed.term && !hits(row, parsed.fields, parsed.term)) return false;
  // Extra words are deliberately matched against ALL fields, not the scoped
  // one: "a: 668 plazo" reads as "article 668, the plazo", so the second word
  // is describing the product, not the article number.
  return (parsed.extra || []).every((w) => hits(row, ALL_FIELDS, w));
}

export function filterBySearch(rows, raw) {
  const parsed = parseSearch(raw);
  if (!parsed.term && !(parsed.extra || []).length) return rows;
  return rows.filter((r) => matchesSearch(r, parsed));
}
