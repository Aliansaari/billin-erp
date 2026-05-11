import React, { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './Reports.css';

/* ── Icons ─────────────────────────────────────────────────────── */
const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>
);
const ChevR = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l6-6-6-6"/>
  </svg>
);
const StarFilled = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L15 8.5L22 9L17 14L18 21L12 17.5L6 21L7 14L2 9L9 8.5z"/>
  </svg>
);
const StarOutline = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 2L15 8.5L22 9L17 14L18 21L12 17.5L6 21L7 14L2 9L9 8.5z"/>
  </svg>
);

/* ── Category icons ─────────────────────────────────────────────── */
const IconClock = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
  </svg>
);
const IconCal = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
  </svg>
);
const IconTrend = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/>
  </svg>
);
const IconCart = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
    <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>
  </svg>
);
const IconBuilding = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1"/>
  </svg>
);
const IconBox = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
    <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>
  </svg>
);

/* ── Pin card icons ──────────────────────────────────────────────── */
const PinIconPurchase = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
    <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>
  </svg>
);
const PinIconSales = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/>
  </svg>
);
const PinIconLedger = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15.5V5a2 2 0 0 0-2-2h-7M3 7v12a2 2 0 0 0 2 2h7"/>
    <path d="M9 7H5a2 2 0 0 1-2-2V3.5A1.5 1.5 0 0 1 4.5 2H7"/>
    <path d="M14 22a3 3 0 0 0 3-3v-4l-3 3-3-3v4a3 3 0 0 0 3 3z"/>
  </svg>
);
const PinIconSupplier = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/><path d="M22 11h-6M19 8v6"/>
  </svg>
);
const PinIconCustomer = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/><path d="M22 11l-4 4M22 15l-4-4"/>
  </svg>
);

/* ── Data ───────────────────────────────────────────────────────── */
const CATEGORIES = [
  {
    id: 'outstanding',
    label: 'Outstanding',
    labelItalic: false,
    icon: <IconClock />,
    color: 'outstanding',
    reports: [
      { id: 'bills-receivable',    name: 'Bills Receivable',    desc: 'Unpaid customer bills · bill-level',     isNew: true,  route: '/outstanding' },
      { id: 'bills-payable',       name: 'Bills Payable',       desc: 'Unpaid supplier bills · bill-level',     isNew: true,  route: '/outstanding' },
      { id: 'customer-outstanding',name: 'Customer Outstanding',desc: 'By customer · bucket aging',             isNew: false, route: '/outstanding' },
      { id: 'receivables-aging',   name: 'Receivables Aging',   desc: '0-30 / 30-60 / 60-90 / 90+',           isNew: true,  route: '/outstanding' },
      { id: 'supplier-outstanding',name: 'Supplier Outstanding',desc: 'By supplier · overdue balances',        isNew: false, route: null },
      { id: 'payables-aging',      name: 'Payables Aging',      desc: '0-30 / 30-60 / 60-90 / 90+',           isNew: false, route: null },
    ],
  },
  {
    id: 'periodic',
    label: 'Periodic',
    labelItalic: 'summary',
    icon: <IconCal />,
    color: 'periodic',
    reports: [
      { id: 'sales-register',    name: 'Sales Register',    desc: 'Monthly summary · sales account',    isNew: true,  route: '/vouchers' },
      { id: 'purchase-register', name: 'Purchase Register', desc: 'Monthly summary · purchase account', isNew: false, route: '/vouchers' },
      { id: 'receipt-register',  name: 'Receipt Register',  desc: 'Monthly summary · receipts',         isNew: false, route: '/vouchers' },
      { id: 'payment-register',  name: 'Payment Register',  desc: 'Monthly summary · payments',         isNew: false, route: '/vouchers' },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    labelItalic: false,
    icon: <IconTrend />,
    color: 'sales',
    reports: [
      { id: 'sales-report',        name: 'Sales Report',        desc: 'Date / customer · full detail',     isNew: false, route: '/vouchers' },
      { id: 'customer-statement',  name: 'Customer Statement',  desc: 'Per-customer · ledger view',        isNew: false, route: '/outstanding' },
      { id: 'sales-by-item',       name: 'Sales by Item',       desc: 'Product-wise sales quantity & value',isNew: true, route: null },
      { id: 'salesman-report',     name: 'Salesman Report',     desc: 'Performance by sales person',       isNew: false, route: null },
      { id: 'sales-return',        name: 'Sales Return',        desc: 'Credit notes · return summary',     isNew: false, route: null },
    ],
  },
  {
    id: 'purchase',
    label: 'Purchase',
    labelItalic: false,
    icon: <IconCart />,
    color: 'purchase',
    reports: [
      { id: 'purchase-report',    name: 'Purchase Report',    desc: 'By supplier / item · full detail', isNew: false, route: '/vouchers' },
      { id: 'supplier-statement', name: 'Supplier Statement', desc: 'Per-supplier · ledger view',       isNew: false, route: '/outstanding' },
      { id: 'purchase-by-item',   name: 'Purchase by Item',   desc: 'Product-wise purchase qty & value',isNew: true,  route: null },
      { id: 'purchase-return',    name: 'Purchase Return',    desc: 'Debit notes · return summary',     isNew: false, route: null },
    ],
  },
  {
    id: 'financial',
    label: 'Financial',
    labelItalic: false,
    icon: <IconBuilding />,
    color: 'financial',
    reports: [
      { id: 'profit-loss',       name: 'Profit & Loss',         desc: 'Revenue minus expenses',                isNew: false, route: null },
      { id: 'balance-sheet',     name: 'Balance Sheet',         desc: 'Assets · liabilities · equity',        isNew: false, route: null },
      { id: 'trial-balance',     name: 'Trial Balance',         desc: 'Group / sub-group ledger balances',     isNew: false, route: null },
      { id: 'day-book',          name: 'Day Book',              desc: 'Chronological voucher list',            isNew: false, route: '/day-book' },
      { id: 'ledger-statement',  name: 'Ledger Statement',      desc: 'Account-wise transaction history',      isNew: false, route: null },
      { id: 'cash-flow',         name: 'Cash Flow Statement',   desc: 'Operating · investing · financing',     isNew: true,  route: null },
      { id: 'account-summary',   name: 'Account Summary',       desc: 'Opening · transactions · closing',      isNew: false, route: null },
      { id: 'gst-summary',       name: 'GST Summary',           desc: 'Tax collected & paid · by rate',        isNew: false, route: null },
      { id: 'gstr1',             name: 'GSTR-1',                desc: 'Outward supplies · filing view',        isNew: false, route: null },
      { id: 'gstr3b',            name: 'GSTR-3B',               desc: 'Summary return · ITC vs liability',     isNew: false, route: null },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    labelItalic: false,
    icon: <IconBox />,
    color: 'inventory',
    reports: [
      { id: 'stock-report',    name: 'Stock Report',       desc: 'Per-product stock · inward / outward', isNew: false, route: '/stock' },
      { id: 'smart-stock',     name: 'Smart Stock',        desc: 'Category grouped · bulk edit',         isNew: false, route: '/stock' },
      { id: 'fast-slow',       name: 'Fast & Slow Movers', desc: 'Velocity · fast / slow / dead',        isNew: false, route: null },
      { id: 'stock-valuation', name: 'Stock Valuation',    desc: 'Current stock value at cost / MRP',    isNew: true,  route: null },
      { id: 'reorder-alert',   name: 'Reorder Alert',      desc: 'Items below minimum stock level',      isNew: false, route: null },
    ],
  },
];

const TOTAL_REPORTS = CATEGORIES.reduce((n, c) => n + c.reports.length, 0);

const PIN_CARDS = [
  { id: 'purchase-report',   name: 'Purchase Report',    meta: 'By supplier / item', iconClass: 'purchase', Icon: PinIconPurchase, route: '/vouchers' },
  { id: 'sales-report',      name: 'Sales Report',       meta: 'Date / customer',    iconClass: 'sales',    Icon: PinIconSales,    route: '/vouchers' },
  { id: 'ledger-statement',  name: 'Ledger Statement',   meta: 'Account-wise',       iconClass: 'ledger',   Icon: PinIconLedger,   route: null },
  { id: 'supplier-statement',name: 'Supplier Statement', meta: 'Per-supplier',       iconClass: 'supplier', Icon: PinIconSupplier, route: '/outstanding' },
  { id: 'customer-statement',name: 'Customer Statement', meta: 'Per-customer',       iconClass: 'customer', Icon: PinIconCustomer, route: '/outstanding' },
];

const LS_KEY = 'reports_pinned_v1';
function loadPinned() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set(PIN_CARDS.map((p) => p.id));
}
function savePinned(set) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...set])); } catch {}
}

/* ── Component ──────────────────────────────────────────────────── */
export default function Reports() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [pinned, setPinned] = useState(loadPinned);
  const searchRef = useRef(null);

  const togglePin = (id, e) => {
    e.stopPropagation();
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      savePinned(next);
      return next;
    });
  };

  const allReports = useMemo(() =>
    CATEGORIES.flatMap((c) => c.reports.map((r) => ({ ...r, catId: c.id }))),
    [],
  );

  const q = search.trim().toLowerCase();
  const isSearching = q.length > 0;

  const searchResults = useMemo(() => {
    if (!q) return [];
    return allReports.filter((r) =>
      r.name.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q),
    );
  }, [q, allReports]);

  const pinnedCards = PIN_CARDS.filter((p) => pinned.has(p.id));

  const handleRowTap = (report) => {
    if (report.route) navigate(report.route);
  };
  const handlePinCardTap = (card) => {
    if (card.route) navigate(card.route);
  };

  return (
    <div className="rp-root">
      {/* Page header */}
      <div className="rp-top">
        <h1 className="rp-title">Reports</h1>
        <div className="rp-sub">
          <span className="rp-sub-acc">{TOTAL_REPORTS}</span> total
          <span className="rp-sub-dot">·</span>
          <span className="rp-sub-pin">{pinnedCards.length} pinned</span>
        </div>
      </div>

      {/* Search */}
      <div className={`rp-search${searchFocused ? ' rp-search--focused' : ''}`}
           onClick={() => searchRef.current?.focus()}>
        <span className="rp-search-icon"><SearchIcon /></span>
        <input
          ref={searchRef}
          className="rp-search-input"
          placeholder={`Search ${TOTAL_REPORTS} reports…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
        />
        {search && (
          <button className="rp-search-clear" onClick={() => setSearch('')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        )}
      </div>

      {/* Search results overlay */}
      {isSearching ? (
        <div className="rp-scroll">
          {searchResults.length === 0 ? (
            <div className="rp-empty">No reports match &ldquo;{search}&rdquo;</div>
          ) : (
            <>
              <div className="rp-search-head">
                <span className="rp-search-count">{searchResults.length} result{searchResults.length !== 1 ? 's' : ''}</span>
              </div>
              {searchResults.map((r) => (
                <ReportRow key={r.id} report={r} pinned={pinned.has(r.id)} onPin={togglePin} onTap={handleRowTap} />
              ))}
            </>
          )}
        </div>
      ) : (
        <>
          {/* Pinned section */}
          {pinnedCards.length > 0 && (
            <>
              <div className="rp-pin-head">
                <span className="rp-pin-label">
                  <StarFilled />
                  Pinned
                </span>
                <span className="rp-pin-count">{pinnedCards.length} of {TOTAL_REPORTS}</span>
              </div>
              <div className="rp-pin-scroll">
                {pinnedCards.map((card) => (
                  <div key={card.id} className="rp-pin-card" onClick={() => handlePinCardTap(card)}>
                    <div className={`rp-pin-icon rp-pin-icon--${card.iconClass}`}>
                      <card.Icon />
                    </div>
                    <div className="rp-pin-name">{card.name}</div>
                    <div className="rp-pin-meta">{card.meta}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Categories list */}
          <div className="rp-scroll">
            {CATEGORIES.map((cat) => (
              <div key={cat.id}>
                <div className="rp-cat-head">
                  <div className="rp-cat-title-row">
                    <div className={`rp-cat-icon rp-cat-icon--${cat.color}`}>{cat.icon}</div>
                    <h2 className="rp-cat-title">
                      {cat.label}
                      {cat.labelItalic && <em> {cat.labelItalic}</em>}
                    </h2>
                  </div>
                  <span className="rp-cat-count">
                    <span className="rp-cat-num">{cat.reports.length}</span> reports
                  </span>
                </div>
                {cat.reports.map((r) => (
                  <ReportRow key={r.id} report={r} pinned={pinned.has(r.id)} onPin={togglePin} onTap={handleRowTap} />
                ))}
              </div>
            ))}
            <div className="rp-end">— end of all {TOTAL_REPORTS} reports —</div>
          </div>
        </>
      )}
    </div>
  );
}

function ReportRow({ report, pinned, onPin, onTap }) {
  return (
    <div className="rp-row" onClick={() => onTap(report)}>
      <button
        className={`rp-star${pinned ? ' rp-star--on' : ''}`}
        onClick={(e) => onPin(report.id, e)}
        aria-label={pinned ? 'Unpin' : 'Pin'}
      >
        {pinned ? <StarFilled /> : <StarOutline />}
      </button>
      <div className="rp-row-info">
        <div className="rp-row-name-row">
          <span className="rp-row-name">{report.name}</span>
          {report.isNew && <span className="rp-new">NEW</span>}
        </div>
        <div className="rp-row-desc">{report.desc}</div>
      </div>
      <div className="rp-chev"><ChevR /></div>
    </div>
  );
}
