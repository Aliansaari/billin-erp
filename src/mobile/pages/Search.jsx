import React, { useEffect, useMemo, useRef, useState } from 'react';
import { searchParties, readProducts } from '../utils/mirrorReads';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import api, { partyAPI, productAPI } from '../../api';
import { parseSearch, matchesSearch } from '../utils/searchPrefix';
import { formatINR } from '../utils/format';

/* ──────────────────────────────────────────────────────────────────────────
 * Mobile global search — feature-parity slim version of the desktop palette.
 *
 * Tabs (touch-friendly) replace the desktop's typed scope prefixes; typing
 * "c:" on a phone keyboard is too much friction. Otherwise the structure
 * mirrors the desktop:
 *
 *   - Scope tabs: All / Parties / Products / Actions
 *   - Live API hits to parties + products (skipped when an unrelated tab
 *     is active to save battery + bandwidth on mobile networks)
 *   - Static actions catalog adapted for mobile routes
 *   - Voucher-number jump (#5) — same heuristic as desktop, hits the
 *     /sales + /purchases + /payments endpoints when query looks numeric
 *   - Pinning (#17) — shares the gs_pins_v1 localStorage key with the
 *     desktop, so pins curated on a phone show up on the desktop palette
 *     (and vice versa). Single source of truth.
 *   - Recent (gs_recent_v1 key — same shared store)
 *   - Telemetry (gs_telemetry_v1) — abandons and clicks recorded the same
 *     way so analytics work cross-device.
 *
 * Mobile-specific bits: no AbortController (mobile Safari support is fine
 * but we keep the simpler `cancelled` flag pattern that was already here).
 * No skeleton card animation — replaced with a single shimmer line to keep
 * the GPU happy on cheap Android devices.
 * ────────────────────────────────────────────────────────────────────────── */

const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
);
const Pkg = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
);
const PersonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
);
const BookIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 19.5A2.5 2.5 0 0 1 4.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
);
const PinIcon = ({ filled }) => filled ? (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3v2l2 4v3h-5v9h-2v-9H6V9l2-4V3z"/></svg>
) : (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v4M8 5v6l-2 3h12l-2-3V5z"/></svg>
);

/* Mobile actions catalog — only the routes that actually exist in the
 * mobile App.jsx and that an operator would search for. Smaller than the
 * desktop catalog by design: mobile users do bills + lookups, not multi-
 * step setting changes. Keywords lean toward how an Indian SMB operator
 * actually talks ("bill" rather than "invoice", "party" rather than
 * "contact"). */
const MOBILE_ACTIONS = [
  // Create
  { id: 'm-sale-new',      label: 'New sale',         sub: 'Create customer bill',     group: 'Create',  route: '/sale/new',     keywords: 'sale bill invoice new tax gst' },
  { id: 'm-purchase-new',  label: 'New purchase',     sub: 'Create supplier bill',     group: 'Create',  route: '/purchase/new', keywords: 'purchase bill supplier new inward' },
  { id: 'm-receipt-new',   label: 'Record receipt',   sub: 'Money in from customer',   group: 'Create',  route: '/receipt/new',  keywords: 'receipt money in payment in' },
  { id: 'm-payment-new',   label: 'Record payment',   sub: 'Money out to supplier',    group: 'Create',  route: '/payment/new',  keywords: 'payment money out' },
  { id: 'm-customer-new',  label: 'Add customer',     sub: 'New party',                group: 'Create',  route: '/customer/new', keywords: 'customer party new add' },
  { id: 'm-supplier-new',  label: 'Add supplier',     sub: 'New party',                group: 'Create',  route: '/supplier/new', keywords: 'supplier vendor party new add' },

  // Browse
  { id: 'm-vouchers',      label: 'All vouchers',     sub: 'Bills · receipts · payments', group: 'Browse', route: '/vouchers',     keywords: 'voucher bill list register' },
  { id: 'm-day-book',      label: 'Day book',         sub: 'Today’s entries',     group: 'Browse',  route: '/day-book',     keywords: 'day book daybook journal entry' },
  { id: 'm-outstanding',   label: 'Outstanding',      sub: 'Receivables · payables',   group: 'Browse',  route: '/outstanding',  keywords: 'outstanding receivable payable due' },
  { id: 'm-stock',         label: 'Stock',            sub: 'On-hand inventory',        group: 'Browse',  route: '/stock',        keywords: 'stock inventory on hand' },
  { id: 'm-items',         label: 'Items',            sub: 'Product list',             group: 'Browse',  route: '/items',        keywords: 'items products sku' },

  // Reports
  { id: 'm-reports',       label: 'Reports',          sub: 'All reports',              group: 'Reports', route: '/reports',          keywords: 'reports hub all' },
  { id: 'm-r-sales',       label: 'Sales report',     sub: 'Bill-level sales',         group: 'Reports', route: '/reports/sales',    keywords: 'sales report' },
  { id: 'm-r-purchases',   label: 'Purchase report',  sub: 'Bill-level purchases',     group: 'Reports', route: '/reports/purchases',keywords: 'purchase report' },
  { id: 'm-r-tb',          label: 'Trial balance',    sub: 'Closing balances',         group: 'Reports', route: '/reports/trial-balance',  keywords: 'trial balance tb' },
  { id: 'm-r-bs',          label: 'Balance sheet',    sub: 'Assets & liabilities',     group: 'Reports', route: '/reports/balance-sheet',  keywords: 'balance sheet bs' },
  { id: 'm-r-pl',          label: 'Profit & loss',    sub: 'P&L statement',            group: 'Reports', route: '/reports/profit-loss',    keywords: 'profit loss pl income statement' },
  { id: 'm-r-cf',          label: 'Cash flow',        sub: 'Inflows & outflows',       group: 'Reports', route: '/reports/cash-flow',      keywords: 'cash flow' },
  { id: 'm-r-gstr1',       label: 'GSTR-1',           sub: 'Outward supplies',         group: 'Reports', route: '/reports/gstr1',          keywords: 'gst gstr1 outward' },
  { id: 'm-r-gstr3b',      label: 'GSTR-3B',          sub: 'Monthly summary',          group: 'Reports', route: '/reports/gstr3b',         keywords: 'gst gstr3b summary' },
  { id: 'm-r-bills-r',     label: 'Bills receivable', sub: 'Open invoices in',         group: 'Reports', route: '/reports/bills-receivable', keywords: 'bills receivable open invoices' },
  { id: 'm-r-bills-p',     label: 'Bills payable',    sub: 'Open invoices out',        group: 'Reports', route: '/reports/bills-payable',    keywords: 'bills payable open invoices' },
  { id: 'm-r-sales-item',  label: 'Sales by item',    sub: 'Item-level sales',         group: 'Reports', route: '/reports/sales-by-item',    keywords: 'sales item product' },
  { id: 'm-r-purc-item',   label: 'Purchases by item',sub: 'Item-level purchases',     group: 'Reports', route: '/reports/purchase-by-item', keywords: 'purchase item product' },
  { id: 'm-r-fast-slow',   label: 'Fast / slow movers', sub: 'Movement velocity',      group: 'Reports', route: '/reports/fast-slow',        keywords: 'fast slow movers velocity stock' },
  { id: 'm-r-reorder',     label: 'Reorder alert',    sub: 'Low-stock list',           group: 'Reports', route: '/reports/reorder-alert',    keywords: 'reorder low stock alert' },
  { id: 'm-r-monthly',     label: 'Monthly summary',  sub: 'P&L by month',             group: 'Reports', route: '/reports/monthly',          keywords: 'monthly summary' },
];

/* Fuzzy + abbreviation match (mirror of desktop scoreAction, simplified
 * because mobile doesn't need typo tolerance — the on-screen keyboard
 * auto-corrects most of those before they reach us). */
function labelInitials(label) {
  return String(label || '').replace(/[^a-zA-Z0-9 &-]/g, ' ').split(/[\s\-&]+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase();
}
function isSubsequence(q, hay) {
  if (!q) return false;
  const H = hay.toLowerCase();
  let i = 0;
  for (let j = 0; j < H.length && i < q.length; j++) {
    if (H[j] === q[i]) i++;
  }
  return i === q.length;
}
function scoreAction(a, q) {
  if (!q) return null;
  const Q = q.toLowerCase().trim();
  if (!Q) return null;
  const L = a.label.toLowerCase();
  const K = (a.keywords || '').toLowerCase();
  if (L === Q) return 1000;
  if (L.startsWith(Q)) return 800;
  const init = labelInitials(a.label);
  if (init && Q.length >= 2 && Q.length <= 6 && init === Q) return 700;
  const words = (L + ' ' + K).split(/[\s\-/]+/);
  if (words.some((w) => w.startsWith(Q))) return 500;
  if (init && Q.length >= 2 && init.startsWith(Q)) return 420;
  if (Q.length >= 3 && isSubsequence(Q, L)) return 400;
  if (L.includes(Q)) return 300;
  if (K.includes(Q)) return 200;
  return null;
}

/* Voucher heuristic — mirror of desktop. */
function looksLikeVoucher(q) {
  if (!q) return false;
  const s = String(q).trim();
  if (s.length === 0 || s.length > 40) return false;
  if (s.startsWith('#')) return s.length >= 2;
  if (/\s/.test(s)) return false;
  if (/\d{3,}/.test(s)) return true;
  if (/^[A-Za-z]{1,5}[-/_]?\d{1,}$/.test(s)) return true;
  return false;
}
function stripVoucherPrefix(q) {
  const s = String(q || '').trim();
  return s.startsWith('#') ? s.slice(1) : s;
}

/* Pin / recent / telemetry — shared localStorage keys with the desktop
 * palette so curation transfers across devices. */
const PINS_KEY = 'gs_pins_v1';
const PINS_MAX = 12;
const RECENT_KEY = 'gs_recent_v1';
const TELEMETRY_KEY = 'gs_telemetry_v1';
const TELEMETRY_MAX = 200;
function readPins()  { try { return JSON.parse(localStorage.getItem(PINS_KEY))   || []; } catch { return []; } }
function readRecent(){ try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
function isPinned(id, pins) { return Array.isArray(pins) ? pins.some((p) => p.id === id) : false; }
function togglePin(item, currentPins) {
  if (!item || !item.id) return currentPins;
  const list = (currentPins || []).filter((p) => p.id !== item.id);
  if (list.length === (currentPins || []).length) {
    list.unshift({ id: item.id, label: item.label, sub: item.sub, route: item.route, group: item.group, kind: item.kind });
  }
  const trimmed = list.slice(0, PINS_MAX);
  try { localStorage.setItem(PINS_KEY, JSON.stringify(trimmed)); } catch {}
  return trimmed;
}
function pushRecent(item) {
  try {
    const list = readRecent().filter((r) => r.id !== item.id);
    list.unshift({ id: item.id, label: item.label, sub: item.sub, route: item.route, group: item.group, kind: item.kind });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {}
}
function telemetryPush(event) {
  try {
    const raw = localStorage.getItem(TELEMETRY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.push({ ts: Date.now(), ...event });
    while (list.length > TELEMETRY_MAX) list.shift();
    localStorage.setItem(TELEMETRY_KEY, JSON.stringify(list));
  } catch {}
}

const SCOPES = [
  { id: 'all',      label: 'All' },
  { id: 'parties',  label: 'Parties' },
  { id: 'products', label: 'Products' },
  { id: 'actions',  label: 'Actions' },
];

export default function Search() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('all');
  const [parties, setParties]   = useState([]);
  const [products, setProducts] = useState([]);
  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading]   = useState(false);
  /* Set when results came from the device rather than the shop, so the
   * screen can say so — and say which parts it could not answer at all. */
  const [offlineNote, setOfflineNote] = useState(null);
  const [pins, setPins]         = useState(() => readPins());
  const [recent]                = useState(() => readRecent());

  // Telemetry session tracking — abandon if the operator backs out
  // without tapping a row, click if they do.
  const clickedRef  = useRef(false);
  const openedAtRef = useRef(Date.now());
  const lastQRef    = useRef('');
  useEffect(() => { if (q.trim().length >= 2) lastQRef.current = q.trim(); }, [q]);
  useEffect(() => {
    return () => {
      if (clickedRef.current || !lastQRef.current) return;
      telemetryPush({ kind: 'abandon', query: lastQRef.current, dwell: Date.now() - openedAtRef.current, surface: 'mobile' });
    };
  }, []);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Fetch effect. Mirrors the desktop's elision logic — scope filters
  // which endpoints we hit so a phone on a flaky 3G doesn't burn data
  // on a /products call when the operator is in Parties mode.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setParties([]); setProducts([]); setVouchers([]); setLoading(false); setOfflineNote(null);
      return;
    }
    const wantParties  = scope === 'all' || scope === 'parties';
    const wantProducts = scope === 'all' || scope === 'products';
    const wantVouchers = (scope === 'all') && looksLikeVoucher(term);
    if (!wantParties && !wantProducts && !wantVouchers) {
      setParties([]); setProducts([]); setVouchers([]); setLoading(false); setOfflineNote(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      const voucherTerm = stripVoucherPrefix(term);
      // `a:` article, `b:` barcode, `n:` name, `h:` HSN. The server searches
      // every field, so send the bare term and narrow the product results to
      // the requested field here. A wider fetch keeps the match count useful
      // once the prefix is applied.
      const parsedProduct = parseSearch(term);
      const productTerm = parsedProduct.term || term;
      Promise.allSettled([
        wantParties  ? partyAPI.getAll({ search: term, limit: 12 })                   : Promise.resolve(null),
        wantProducts ? productAPI.search(productTerm, parsedProduct.scope
          // Scope on the SERVER so the match cannot be lost past the row cap.
          // Fetch wider when further words will narrow the set here, or the
          // one row the user wanted can fall outside a 12-row page.
          ? { limit: parsedProduct.extra.length ? 80 : 12, search_field: parsedProduct.scope }
          : { limit: parsedProduct.extra.length ? 80 : 12 }) : Promise.resolve(null),
        wantVouchers ? api.get('/sales',     { params: { search: voucherTerm, limit: 5 } }) : Promise.resolve(null),
        wantVouchers ? api.get('/purchases', { params: { search: voucherTerm, limit: 5 } }) : Promise.resolve(null),
        wantVouchers ? api.get('/payments',  { params: { search: voucherTerm, limit: 5 } }) : Promise.resolve(null),
      ]).then(async ([p, pr, s, pu, pay]) => {
        if (cancelled) return;
        const pick = (r) => {
          if (!r || r.status !== 'fulfilled' || !r.value) return [];
          const d = r.value.data?.data ?? r.value.data ?? [];
          return Array.isArray(d) ? d : [];
        };

        /* Offline every one of these rejects, and allSettled swallows it —
         * so the screen showed nothing, with no error and no explanation.
         * An empty result reads as a statement about the shop ("no such
         * party", "no such item") rather than about the connection, which
         * is the worst available way to be wrong.
         *
         * Parties and products are mirrored and can still be answered.
         * Vouchers are not, so they are reported as unavailable rather than
         * quietly returned empty. */
        const localParties = (wantParties && p?.status === 'rejected')
          ? await searchParties(term, 12).catch(() => null)
          : null;
        const localProducts = (wantProducts && pr?.status === 'rejected')
          ? await readProducts({
              limit: parsedProduct.extra.length ? 80 : 12,
              search: productTerm,
              ...(parsedProduct.scope ? { search_field: parsedProduct.scope } : {}),
            }).catch(() => null)
          : null;
        if (cancelled) return;

        const vouchersDown = wantVouchers && s?.status === 'rejected';
        setOfflineNote(
          (localParties || localProducts || vouchersDown)
            ? (vouchersDown ? 'Shop computer offline — bills are not searchable' : 'Shop computer offline')
            : null,
        );

        setParties(wantParties
          ? (localParties ? localParties.rows.slice(0, 12) : pick(p).slice(0, 12))
          : []);
        // The server matched the scoped term; apply the remaining words here
        // so "a: 668 plazo" ends up as article-668 AND plazo.
        const prodRows = wantProducts
          ? (localProducts ? (localProducts.data?.data || []) : pick(pr))
          : [];
        setProducts(
          (parsedProduct.extra.length
            ? prodRows.filter((row) => matchesSearch(row, parsedProduct))
            : prodRows
          ).slice(0, 12),
        );
        setVouchers(wantVouchers ? [
          ...pick(s)  .map((v) => ({ ...v, _vt: 'sale' })),
          ...pick(pu) .map((v) => ({ ...v, _vt: 'purchase' })),
          ...pick(pay).map((v) => ({ ...v, _vt: 'payment' })),
        ] : []);
      }).catch(() => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: 'Search failed' });
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, scope]);

  // Actions — purely static, filter+score on each keystroke; mobile
  // catalog is small enough that this is well under a millisecond.
  const actionResults = useMemo(() => {
    if (scope === 'parties' || scope === 'products') return [];
    const term = q.trim();
    if (!term) return [];
    return MOBILE_ACTIONS
      .map((a) => ({ a, s: scoreAction(a, term) }))
      .filter((x) => x.s != null)
      .sort((x, y) => y.s - x.s)
      .slice(0, 10)
      .map((x) => ({ ...x.a, kind: 'action' }));
  }, [q, scope]);

  // Empty-state suggestions — favourites first, then recents, then a
  // tailored "Quick start" set when neither exists. Keeps the palette
  // useful from the moment it opens, before any typing.
  const emptyState = q.trim().length === 0;
  const showPinned = emptyState && pins.length > 0;
  const showRecent = emptyState && recent.length > 0;
  const quickStart = useMemo(() => {
    if (!emptyState) return [];
    const ids = ['m-sale-new', 'm-purchase-new', 'm-receipt-new', 'm-day-book', 'm-outstanding', 'm-vouchers'];
    return ids.map((id) => MOBILE_ACTIONS.find((a) => a.id === id)).filter(Boolean).map((a) => ({ ...a, kind: 'action' }));
  }, [emptyState]);

  const choose = (item) => {
    if (!item) return;
    clickedRef.current = true;
    pushRecent(item);
    telemetryPush({
      kind: 'click',
      query: q.trim(),
      pickedId: item.id,
      pickedKind: item.kind,
      pickedGroup: item.group,
      surface: 'mobile',
      dwell: Date.now() - openedAtRef.current,
    });
    if (item.route) navigate(item.route);
  };
  const onTogglePin = (item) => setPins((cur) => togglePin(item, cur));

  const hasResults =
    parties.length + products.length + vouchers.length + actionResults.length > 0;
  const singleChar = q.trim().length === 1;
  const noMatch = !emptyState && !singleChar && !loading && !hasResults;

  // ── Row renderer (shared shape across all groups) ─────────────────
  const renderRow = (item, onTap, opts = {}) => {
    const pinned = isPinned(item.id, pins);
    const amount = opts.amount;
    const icon   = opts.icon;
    return (
      <button key={item.id} className="search-row" onClick={() => onTap(item)}>
        <span className="search-row-icon">{icon}</span>
        <span className="search-row-main">
          <div className="search-row-title">{item.label || item._title}</div>
          {(item.sub || item._sub || opts.article) && (
            <div className="search-row-sub">
              {opts.article && <span className="search-row-article">{opts.article}</span>}
              <span className="search-row-subtext">{item.sub || item._sub}</span>
            </div>
          )}
        </span>
        {(amount != null || opts.meta) && (
          <span className="search-row-figures">
            {amount != null && <span className="search-row-amount">{amount}</span>}
            {opts.meta && <span className="search-row-meta">{opts.meta}</span>}
          </span>
        )}
        <button
          type="button"
          className={`search-pin ${pinned ? 'is-pinned' : ''}`}
          onClick={(e) => { e.stopPropagation(); onTogglePin(item); }}
          aria-label={pinned ? 'Unpin' : 'Pin to top'}
        >
          <PinIcon filled={pinned} />
        </button>
      </button>
    );
  };

  return (
    <div className="search-screen drill-in">
      <style>{`
        .search-screen {
          flex: 1; display: flex; flex-direction: column;
          background: var(--c-bg-app);
          overflow: hidden;
        }
        .search-top {
          background: var(--c-bg-surface);
          padding: calc(env(safe-area-inset-top, 0px) + 12px) var(--pad) 8px;
          border-bottom: 1px solid var(--c-border);
        }
        .search-title {
          font-variation-settings: "opsz" 30;
          font-weight: 400;
          font-size: 22px;
          letter-spacing: -0.025em;
          color: var(--c-text);
          margin: 0 0 12px;
        }
        .search-title em { font-style: italic; font-weight: 300; }
        .search-input-wrap {
          display: flex; align-items: center; gap: 10px;
          background: var(--c-bg-app);
          border: 1px solid var(--c-border);
          border-radius: 14px;
          padding: 12px 14px;
        }
        .search-input-wrap:focus-within {
          border-color: var(--c-primary);
          background: var(--c-bg-surface);
        }
        .search-input-wrap input {
          flex: 1; background: none; border: none; outline: none;
          font-weight: 500;
          font-size: 15px;
          color: var(--c-text); letter-spacing: -0.005em;
          caret-color: var(--c-primary);
          min-width: 0;
        }
        .search-input-wrap input::placeholder { color: var(--c-text-mute); font-weight: 400; }
        /* Product rows carry the same identifiers the Stock tab shows: the
           article number as a chip (it is what a shopkeeper calls the item by),
           then barcode / HSN / category, with rate and stock on the right. */
        .search-row-sub { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .search-row-subtext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .search-row-article {
          flex: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10.5px; font-weight: 600;
          color: var(--c-primary);
          background: var(--c-primary-soft);
          border: 1px solid var(--c-primary-line);
          border-radius: 6px; padding: 1px 6px;
          max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .search-row-figures {
          flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
        }
        .search-row-meta { font-size: 11px; color: var(--c-text-mute); white-space: nowrap; }
        .search-spin {
          width: 14px; height: 14px;
          border: 1.5px solid var(--c-border);
          border-top-color: var(--c-primary);
          border-radius: 50%;
          animation: searchSpin .7s linear infinite;
          flex: 0 0 auto;
        }
        @keyframes searchSpin { to { transform: rotate(360deg); } }

        .search-scopes {
          display: flex; gap: 6px; margin-top: 10px; overflow-x: auto;
          scrollbar-width: none;
        }
        .search-scopes::-webkit-scrollbar { display: none; }
        .search-scope {
          flex: 0 0 auto; padding: 6px 12px;
          border-radius: 999px;
          font-size: 12px; font-weight: 500;
          background: var(--c-bg-app);
          border: 1px solid var(--c-border);
          color: var(--c-text-mute);
          font-family: inherit;
        }
        .search-scope.is-active {
          background: var(--c-primary-soft);
          border-color: var(--c-primary);
          color: var(--c-primary);
        }

        .search-list-wrap {
          flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
          padding: 12px var(--pad) calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px) + 16px);
        }
        .search-section { margin-bottom: 18px; }
        .search-section-head {
          display: flex; align-items: baseline; justify-content: space-between;
          padding: 0 4px 8px;
          font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
          color: var(--c-text-mute);
        }
        .search-card {
          background: var(--c-bg-surface);
          border: 1px solid var(--c-border);
          border-radius: 16px; overflow: hidden;
        }
        .search-row {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--c-border-soft);
          cursor: pointer;
          background: none; border-left: none; border-right: none; border-top: none;
          width: 100%; text-align: left; font-family: inherit;
          position: relative;
        }
        .search-row:last-child { border-bottom: none; }
        .search-row:active { background: var(--c-primary-soft); }
        .search-row-icon {
          width: 32px; height: 32px; border-radius: 9px;
          background: var(--c-primary-soft); color: var(--c-primary);
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .search-row-main { flex: 1; min-width: 0; }
        .search-row-title {
          font-size: 13.5px; font-weight: 500; color: var(--c-text);
          letter-spacing: -0.01em;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .search-row-sub {
          font-size: 10px; color: var(--c-text-mute);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          margin-top: 2px;
        }
        .search-row-amount {
          font-size: 13px; color: var(--c-text);
          font-variant-numeric: tabular-nums;
          margin-left: 8px;
        }
        .search-pin {
          flex: 0 0 auto;
          width: 28px; height: 28px;
          margin-left: 2px;
          padding: 0;
          background: transparent;
          border: none;
          border-radius: 6px;
          color: var(--c-text-mute);
          display: inline-flex; align-items: center; justify-content: center;
          font-family: inherit;
        }
        .search-pin.is-pinned { color: var(--c-primary); }

        .search-skel-row {
          display: flex; gap: 12px; padding: 12px 14px;
          border-bottom: 1px solid var(--c-border-soft);
        }
        .search-skel-row:last-child { border-bottom: none; }
        .search-skel-block, .search-skel-line {
          background: linear-gradient(90deg, var(--c-bg-app) 0%, var(--c-border-soft) 50%, var(--c-bg-app) 100%);
          background-size: 200% 100%;
          animation: searchShimmer 1.1s linear infinite;
          border-radius: 4px;
        }
        .search-skel-block { width: 32px; height: 32px; border-radius: 9px; flex: 0 0 auto; }
        .search-skel-text  { flex: 1; min-width: 0; }
        .search-skel-line  { height: 11px; margin-top: 4px; }
        .search-skel-line-lg { width: 60%; height: 12px; margin-top: 0; }
        .search-skel-line-sm { width: 80%; height: 9px; }
        @keyframes searchShimmer {
          from { background-position: 200% 0; }
          to   { background-position: -200% 0; }
        }

        .search-empty {
          padding: 56px 24px; text-align: center; color: var(--c-text-mute);
          font-style: italic; font-size: 14px;
        }
      `}</style>
      <div className="search-top">
        <h1 className="search-title">Quick <em>find</em></h1>
        <label className="search-input-wrap">
          <SearchIcon />
          <input
            ref={inputRef}
            placeholder={
              scope === 'parties'  ? 'Search parties…' :
              scope === 'products' ? 'Search products…  a: article  b: barcode' :
              scope === 'actions'  ? 'Search pages & reports…' :
              'Search parties, products, vouchers, pages…'
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck="false"
          />
          {loading && <span className="search-spin" aria-hidden="true" />}
        </label>
        <div className="search-scopes" role="tablist">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={scope === s.id}
              className={`search-scope ${scope === s.id ? 'is-active' : ''}`}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="search-list-wrap">
        {/* Single-char hint — same UX rule as desktop: don't show
            "No matches" when we haven't actually searched yet. */}
        {singleChar && !loading && (
          <div className="search-empty">Keep typing — at least 2 characters.</div>
        )}

        {/* Empty state: pins + recent + quick start. */}
        {emptyState && showPinned && (
          <div className="search-section">
            <div className="search-section-head"><span>Pinned</span><span>{pins.length}</span></div>
            <div className="search-card">
              {pins.map((p) => renderRow({ ...p }, choose, {
                icon: p.kind === 'product' ? <Pkg /> : p.kind === 'party' ? <PersonIcon /> : <BookIcon />,
              }))}
            </div>
          </div>
        )}

        {emptyState && showRecent && (
          <div className="search-section">
            <div className="search-section-head"><span>Recent</span><span>{recent.length}</span></div>
            <div className="search-card">
              {recent.map((r) => renderRow({ ...r }, choose, {
                icon: r.kind === 'product' ? <Pkg /> : r.kind === 'party' ? <PersonIcon /> : <BookIcon />,
              }))}
            </div>
          </div>
        )}

        {emptyState && !showPinned && !showRecent && quickStart.length > 0 && (
          <div className="search-section">
            <div className="search-section-head"><span>Quick start</span></div>
            <div className="search-card">
              {quickStart.map((a) => renderRow(a, choose, { icon: <BookIcon /> }))}
            </div>
          </div>
        )}

        {/* Why these results are what they are.
            Without it, a shop with the PC off looks like a shop with no such
            party — the same empty list, and no way to tell which. */}
        {offlineNote && !loading && (
          <div className="search-section">
            <div className="search-section-head"><span>{offlineNote}</span></div>
          </div>
        )}

        {/* Skeleton — only on cold load (no prior results). */}
        {loading && !hasResults && !singleChar && (
          <div className="search-section">
            <div className="search-section-head"><span>Searching…</span></div>
            <div className="search-card">
              {[0, 1, 2].map((i) => (
                <div key={i} className="search-skel-row">
                  <div className="search-skel-block" />
                  <div className="search-skel-text">
                    <div className="search-skel-line search-skel-line-lg" />
                    <div className="search-skel-line search-skel-line-sm" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Vouchers (#5) — sits above parties/products because a voucher-
            shaped query is the most specific intent. */}
        {vouchers.length > 0 && (
          <div className="search-section">
            <div className="search-section-head"><span>Vouchers</span><span>{vouchers.length}</span></div>
            <div className="search-card">
              {vouchers.map((v) => {
                const vt = v._vt;
                const number = v.bill_number || v.transaction_number || v.voucher_number;
                // Kind-specific PK — sales rows carry sales_bill_id, purchases
                // purchase_bill_id, payments transaction_id. Falling back to
                // bare bill_id/id avoids a React key collision when one of the
                // expected fields is absent.
                const vid =
                  vt === 'sale'     ? (v.sales_bill_id    ?? v.bill_id ?? v.id) :
                  vt === 'purchase' ? (v.purchase_bill_id ?? v.bill_id ?? v.id) :
                  vt === 'payment'  ? (v.transaction_id   ?? v.id) :
                  v.id;
                if (vid == null) return null;
                const id = `voucher-${vt}-${vid}`;
                const amount = Number(v.total_amount ?? v.amount ?? v.bill_amount ?? 0);
                const date   = v.bill_date || v.transaction_date || v.date;
                const party  = v.party?.party_name || v.customer?.party_name || v.supplier?.party_name || null;
                const isReceipt = vt === 'payment' && String(v.transaction_type || '').toLowerCase() === 'receipt';
                const verb = vt === 'sale' ? 'Sale' : vt === 'purchase' ? 'Purchase' : isReceipt ? 'Receipt' : 'Payment';
                const route = vt === 'sale'      ? `/vouchers/sales/${vid}`
                            : vt === 'purchase'  ? `/vouchers/purchase/${vid}`
                            :                      `/vouchers/${isReceipt ? 'receipt' : 'payment'}/${vid}`;
                const dateLabel = date ? new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : null;
                const sub = [party, dateLabel].filter(Boolean).join(' · ');
                return renderRow({
                  id, kind: 'voucher', label: `${verb} #${number}`, sub, route, group: 'Vouchers',
                }, choose, {
                  icon: <BookIcon />,
                  amount: amount ? `₹${formatINR(amount)}` : null,
                });
              })}
            </div>
          </div>
        )}

        {/* Parties */}
        {parties.length > 0 && (
          <div className="search-section">
            <div className="search-section-head">
              <span>Parties</span>
              <span>{parties.length}</span>
            </div>
            <div className="search-card">
              {parties.map((p) => {
                const isCust = (p.party_type || 'Customer').toLowerCase().startsWith('cust');
                const pid = p.party_id || p.id;
                const phone = p.mobile_1 || p.mobile_2 || p.phone || null;
                const route = isCust
                  ? `/reports/customer-statement?party_id=${pid}&party_name=${encodeURIComponent(p.party_name || '')}`
                  : `/reports/supplier-statement?party_id=${pid}&party_name=${encodeURIComponent(p.party_name || '')}`;
                const sub = [p.party_type, phone, p.gstin, p.city].filter(Boolean).join(' · ') || '—';
                const amount = p.current_balance != null && p.current_balance !== 0
                  ? `₹${formatINR(Math.abs(p.current_balance))}`
                  : null;
                return renderRow({
                  id: `party-${pid}`, kind: 'party', label: p.party_name, sub, route, group: isCust ? 'Customers' : 'Suppliers',
                }, choose, { icon: <PersonIcon />, amount });
              })}
            </div>
          </div>
        )}

        {/* Products */}
        {products.length > 0 && (
          <div className="search-section">
            <div className="search-section-head">
              <span>Products</span>
              <span>{products.length}</span>
            </div>
            <div className="search-card">
              {products.map((p) => {
                const pid = p.product_id || p.id;
                // Show what the Stock tab shows. This row used to carry only a
                // barcode, and read `sale_price` — a field the API does not
                // return (it is `sale_rate`), so the price was always blank.
                const qty = Number(p.current_stock ?? p.stock_quantity ?? 0);
                const unit = p.unit_of_measurement || p.unit || '';
                const rate = Number(p.sale_rate ?? p.sale_price ?? 0);
                const sub = [
                  p.barcode || p.sku,
                  p.hsn_code ? `HSN ${p.hsn_code}` : null,
                  p.category_name,
                ].filter(Boolean).join(' · ') || '—';
                const amount = rate > 0 ? `₹${formatINR(rate)}` : null;
                return renderRow({
                  id: `prod-${pid}`, kind: 'product', label: p.product_name, sub,
                  route: `/stock/${pid}`, group: 'Products',
                }, choose, {
                  icon: <Pkg />, amount,
                  article: p.article_number || '',
                  meta: Number.isFinite(qty) ? `${qty} ${unit}`.trim() : '',
                });
              })}
            </div>
          </div>
        )}

        {/* Action / page hits */}
        {actionResults.length > 0 && (
          <div className="search-section">
            <div className="search-section-head"><span>Pages & reports</span><span>{actionResults.length}</span></div>
            <div className="search-card">
              {actionResults.map((a) => renderRow(a, choose, { icon: <BookIcon /> }))}
            </div>
          </div>
        )}

        {noMatch && (
          <div className="search-empty">No matches for "{q.trim()}".</div>
        )}
      </div>
    </div>
  );
}
