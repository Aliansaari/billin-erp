// ── Editorial dashboard — section catalog + visibility prefs ────────────
//
// Single source of truth shared by /dashboard (which renders the sections)
// and Settings → Dashboard (which toggles them). Before this existed the
// settings page configured the OLD tile dashboard (/dashboard/classic)
// while the routed /dashboard ignored it entirely — the operator toggled
// things and nothing changed.
//
// Prefs are a plain { [id]: boolean } map in localStorage; a missing key
// means visible (default-on), so new sections added later appear without
// migrating anyone's saved prefs. Writes dispatch `ed-dash-sections` so an
// already-mounted dashboard re-reads instantly (same-tab localStorage
// writes don't fire the native `storage` event).

export const ED_SECTIONS_KEY = 'zehen_ed_dashboard_sections_v1';

export const ED_SECTIONS = [
  { id: 'quickstats',   label: 'Header & quick stats',
    desc: 'Situation banner plus Bills today, Open bills, Avg ticket and GST payable.' },
  { id: 'kpis',         label: 'KPI strip',
    desc: 'Cash position, Receivables, Payables, Sales and Stock value with 14-day sparklines.' },
  { id: 'week',         label: 'This week & banks',
    desc: 'Money due in and out over the next 7 days, pending cheques, and per-account cash & bank balances.' },
  { id: 'money',        label: 'Cash movement & P&L',
    desc: 'Received vs paid-out chart beside the month-to-date profit statement.' },
  { id: 'trends',       label: 'Sales & purchase trend',
    desc: 'Side-by-side sales and purchase charts for the selected period.' },
  { id: 'insight',      label: 'Insight banner',
    desc: 'One-line health readout — flags liquidity, collections or stock issues first.' },
  { id: 'receivables',  label: 'Where money is stuck',
    desc: 'Receivables aging buckets and your top overdue customers.' },
  { id: 'intelligence', label: 'Sales intelligence',
    desc: 'Top customers by revenue, top products, and customer concentration.' },
  { id: 'growth',       label: 'Growth signals',
    desc: 'Silent regulars to win back, the salesman leaderboard, and top categories.' },
  { id: 'health',       label: 'Operational health',
    desc: 'Working capital, inventory health and the cash-conversion cycle.' },
  { id: 'actions',      label: 'Recommended actions',
    desc: 'Up to three cash-freeing actions ranked by estimated ₹ impact.' },
];

export function readSectionPrefs() {
  try {
    const raw = localStorage.getItem(ED_SECTIONS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return obj;
    }
  } catch { /* corrupt/blocked storage → all sections visible */ }
  return {};
}

export function writeSectionPrefs(prefs) {
  try { localStorage.setItem(ED_SECTIONS_KEY, JSON.stringify(prefs || {})); } catch {}
  try { window.dispatchEvent(new Event('ed-dash-sections')); } catch {}
}

export function isSectionVisible(prefs, id) {
  return !prefs || prefs[id] !== false;
}
