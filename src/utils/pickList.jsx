/* Shared bits for the product pickers on the sale and purchase bills, so the
   two dropdowns look and behave the same. Styles live in global.css
   (.pick-*). */

// Product name with the typed text marked, so the eye lands on why a row
// matched. Case-insensitive; marks the first occurrence only.
export function PickName({ name, q }) {
  const text = name || '';
  const needle = (q || '').trim();
  const i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (i < 0) return <span className="nm">{text}</span>;
  return (
    <span className="nm">
      {text.slice(0, i)}<mark className="pick-mark">{text.slice(i, i + needle.length)}</mark>{text.slice(i + needle.length)}
    </span>
  );
}

// Category with a colour dot. The colour is fixed per category, so the same
// name in two categories reads as two different things at a glance.
export function PickCat({ id, name }) {
  if (!name) return <span className="cat none">—</span>;
  const hue = ((Number(id) || 0) * 67 + 20) % 360;
  return <span className="cat"><i className="pick-dot" style={{ '--dot-h': hue }} />{name}</span>;
}

// Stock as a small pill: quiet at zero, amber when low, green otherwise.
export function PickStock({ value }) {
  const n = parseFloat(value || 0);
  const cls = n <= 0 ? ' zero' : n <= 5 ? ' low' : '';
  return <span className="stk"><span className={`pick-stk${cls}`}>{Number.isInteger(n) ? n : n.toFixed(1)}</span></span>;
}

// "N variants" chip, or the size · art of a single product.
export function PickMeta({ variants, size, art }) {
  if (variants > 1) return <span className="meta"><span className="pick-chip">{variants} variants</span></span>;
  return <span className="meta">{[size, art].filter(Boolean).join(' · ') || '—'}</span>;
}
