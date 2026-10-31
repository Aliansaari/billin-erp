/* Shared bits for the product pickers on the sale and purchase bills, so the
   two dropdowns look and behave the same. Styles live in global.css
   (.pick-*). */

// Product name with the typed text underlined, so the eye lands on why a row
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

// Category as plain text. Empty when the product has none.
export function PickCat({ name }) {
  return <span className="cat">{name || ''}</span>;
}

// Stock as a plain number: ink normally, amber when low, "Out" in red at zero.
export function PickStock({ value }) {
  const n = parseFloat(value || 0);
  const cls = n <= 0 ? ' zero' : n <= 5 ? ' low' : '';
  const shown = n <= 0 ? 'Out' : n.toLocaleString('en-IN', { maximumFractionDigits: 1 });
  return <span className={`stk${cls}`}>{shown}</span>;
}

// "N sizes" for a family, or the size · art of a single product.
export function PickMeta({ variants, size, art }) {
  if (variants > 1) return <span className="meta">{variants} sizes</span>;
  return <span className="meta">{[size, art].filter(Boolean).join(' · ')}</span>;
}
