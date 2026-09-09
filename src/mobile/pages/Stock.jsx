import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { Capacitor } from '@capacitor/core';
import { productAPI } from '../../api';
import OfflineBanner from '../components/OfflineBanner';
import { fetchSnapshot, sectionOf, sectionWasTrimmed, snapshotAge, isUnreachable } from '../utils/offlineSnapshot';
import { parseSearch, matchesSearch } from '../utils/searchPrefix';
import { getCached, setCached } from '../utils/screenCache';
import { formatINR } from '../utils/format';
import { shareViaNative } from '../utils/sharePdf';
import './Stock.css';
import './ReportList.css';

const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
);
const ScanIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
    <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
    <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
    <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
    <path d="M7 12h10"/>
  </svg>
);
const AlertIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
);
const ChevR = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
);
const PdfIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/>
  </svg>
);
const ShareIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
    <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/>
  </svg>
);
const CloseIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12"/>
  </svg>
);

// Match a scanned code against any of the product's known identifiers.
// Barcodes can be stored in `barcode`, `sku`, or even slightly different
// numeric forms (with/without leading zeros), so we normalise both sides.
function matchProductByCode(products, raw) {
  const code = String(raw || '').trim();
  if (!code) return null;
  const stripZeros = (s) => s.replace(/^0+/, '');
  const norm = code.toLowerCase();
  const normNoZeros = stripZeros(norm);

  for (const p of products) {
    const candidates = [
      p.barcode, p.sku, p.product_code, p.alt_code, p.ean,
    ].filter(Boolean).map((v) => String(v).trim().toLowerCase());
    for (const c of candidates) {
      if (c === norm) return p;
      if (stripZeros(c) === normNoZeros && normNoZeros !== '') return p;
    }
  }
  return null;
}

const FILTERS = [
  { key: 'all',  label: 'All' },
  { key: 'in',   label: 'In stock' },
  { key: 'low',  label: 'Low stock' },
  { key: 'out',  label: 'Out of stock' },
];

export default function Stock() {
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [offline, setOffline]   = useState(null);
  const [filter, setFilter]     = useState('all');
  const [searchOn, setSearchOn] = useState(false);
  const [search, setSearch]     = useState('');
  const [notFoundCode, setNotFoundCode] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfUrl,  setPdfUrl]  = useState(null);
  // Render window: the full product set can be thousands of rows, but only
  // this many are mounted at once. Grows as the user scrolls. Filtering /
  // totals / PDF still run over the entire dataset — only the DOM is capped.
  const [visibleCount, setVisibleCount] = useState(80);
  const searchRef = useRef(null);
  const pdfUrlRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Page through every product — PROGRESSIVELY.
    //
    // Two separate problems here. The server clamps every request to
    // maxLimit=500 (sanitizePagination), so a single `limit: 10000` silently
    // truncated the catalogue. But fetching all pages before rendering was
    // worse for a big shop: ten sequential round trips over a tunnel is
    // several seconds staring at a blank list.
    //
    // So: render page one the moment it lands, then fill the rest in behind
    // it. The screen is usable immediately and the list grows under the user.
    // Show the previous visit's catalogue instantly; refresh behind it.
    const cachedStock = getCached('stock');
    if (cachedStock) { setProducts(cachedStock); setLoading(false); }

    const loadStock = async () => {
      const PAGE = 500;
      const first = await productAPI.getAll({ limit: PAGE, page: 1 });
      const firstRows = Array.isArray(first.data) ? first.data : (first.data?.data || []);
      if (cancelled) return;

      setProducts(firstRows);
      setOffline(null);
      setLoading(false);              // usable now, not after every page

      const total = Number(first.data?.total ?? firstRows.length);
      const pages = Math.ceil(total / PAGE);
      if (pages <= 1) { setCached('stock', firstRows); return; }

      // Remaining pages in parallel, then ONE state update so React renders
      // once rather than once per page.
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
          productAPI.getAll({ limit: PAGE, page: i + 2 })
            .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data || [])))
            .catch(() => [])),
      );
      if (cancelled) return;
      const more = rest.flat();
      const all = [...firstRows, ...more];
      if (more.length) setProducts(all);
      setCached('stock', all);
    };

    loadStock()
      .catch(async (e) => {
        if (cancelled) return;
        if (isUnreachable(e)) {
          const snap = await fetchSnapshot().catch(() => null);
          const section = sectionOf(snap, 'stock');
          if (!cancelled && section) {
            const raw = Array.isArray(section) ? section : (section?.data || []);
            setProducts(raw);
            setOffline({ age: snapshotAge(snap) });
            return;
          }
          // The item list is the first thing dropped when a snapshot would
          // exceed its size cap, so say that plainly instead of showing an
          // empty shelf as if the shop had no stock.
          if (!cancelled && sectionWasTrimmed(snap, 'stock')) {
            setOffline({ age: snapshotAge(snap), trimmed: true });
            setProducts([]);
            return;
          }
        }
        const msg = e?.response?.data?.error || e?.message || 'Failed to load stock';
        Toast.show({ icon: 'fail', content: msg });
        setProducts([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn && search) setSearch('');
  }, [searchOn]);

  const handleScan = async () => {
    if (!Capacitor.isNativePlatform()) {
      Toast.show({ icon: 'fail', content: 'Scanner only works on the device build' });
      return;
    }
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      const supported = await BarcodeScanner.isSupported();
      if (!supported.supported) {
        Toast.show({ icon: 'fail', content: 'Scanner not supported on this device' });
        return;
      }
      const perm = await BarcodeScanner.requestPermissions();
      if (perm.camera !== 'granted' && perm.camera !== 'limited') {
        Toast.show({ icon: 'fail', content: 'Camera permission denied' });
        return;
      }
      const result = await BarcodeScanner.scan();
      const code = result?.barcodes?.[0]?.rawValue || result?.barcodes?.[0]?.displayValue;
      if (!code) {
        Toast.show({ content: 'No barcode detected' });
        return;
      }
      const product = matchProductByCode(products, code);
      if (product) {
        const id = product.product_id || product.id;
        navigate(`/stock/${id}`);
      } else {
        setNotFoundCode(code);
      }
    } catch (e) {
      const msg = e?.message || 'Scan failed';
      if (!/cancel/i.test(msg)) {
        Toast.show({ icon: 'fail', content: msg });
      }
    }
  };

  async function generatePdf() {
    if (filtered.length === 0) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const filterLabel = FILTERS.find((f) => f.key === filter)?.label || 'All';
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('Stock Report', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${filterLabel} · ${filtered.length} products · Value ₹${formatINR(totalValue)}`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Product', 'SKU / Barcode', 'Pur Rate', 'Sale Rate', 'Qty', 'Value']],
        body: filtered.map((p) => {
          const name = p.product_name || p.name || '';
          const sku  = p.barcode || p.sku || p.product_code || '';
          const qty  = Number(p.current_stock ?? p.stock_quantity ?? 0);
          const unit = p.unit_of_measurement || p.unit || '';
          const pur  = Number(p.purchase_rate ?? p.display_cost ?? 0);
          const sale = Number(p.sale_rate ?? p.sale_price ?? 0);
          const val  = Number(p.display_stock_value ?? 0);
          return [name, sku, pur ? `₹${formatINR(pur)}` : '', sale ? `₹${formatINR(sale)}` : '', `${qty} ${unit}`.trim(), val ? `₹${formatINR(val)}` : ''];
        }),
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `stock-report.pdf` };
    } catch (e) { console.error('PDF', e); return null; }
  }

  async function handleViewPdf() {
    if (filtered.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(result.blob);
      pdfUrlRef.current = url;
      setPdfUrl(url);
    } finally { setPdfBusy(false); }
  }

  async function handleSharePdf() {
    if (filtered.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, 'Stock Report');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  const stockStatus = (p) => {
    const qty = Number(p.current_stock ?? p.stock_quantity ?? 0);
    const min = Number(p.minimum_stock_level ?? p.min_stock ?? 0);
    if (qty <= 0) return 'out';
    if (min > 0 && qty <= min) return 'low';
    return 'in';
  };

  const filtered = useMemo(() => {
    let rows = products;
    if (filter !== 'all') {
      rows = rows.filter((p) => stockStatus(p) === filter);
    }
    if (search.trim()) {
      // `a:` article, `b:` barcode, `n:` name, `h:` HSN. Bare text still
      // matches every field.
      const parsed = parseSearch(search);
      rows = rows.filter((p) => matchesSearch(p, parsed));
    }
    return rows;
  }, [products, filter, search]);

  // New filter or search term → reset the render window to the top slice.
  useEffect(() => { setVisibleCount(80); }, [filter, search]);

  // Grow the window as the list nears its end (infinite-scroll style).
  const onListScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
      setVisibleCount((n) => (n < filtered.length ? n + 80 : n));
    }
  };

  const counts = useMemo(() => {
    const c = { all: products.length, in: 0, low: 0, out: 0 };
    for (const p of products) c[stockStatus(p)]++;
    return c;
  }, [products]);

  const totalValue = useMemo(() => {
    return filtered.reduce((sum, p) => {
      return sum + Number(p.display_stock_value ?? 0);
    }, 0);
  }, [filtered]);

  return (
    <div className="st-screen">
      <div className="st-top">
        <h1 className="st-title">Stock</h1>
        <div className="st-top-actions">
          <button
            className="st-icon-btn"
            onClick={handleScan}
            aria-label="Scan barcode or QR"
          >
            <ScanIcon />
          </button>
          <button
            className={`st-icon-btn${searchOn ? ' active' : ''}`}
            onClick={() => setSearchOn((v) => !v)}
            aria-label="Search"
          >
            <SearchIcon />
          </button>
          <button
            className="st-icon-btn"
            onClick={handleViewPdf}
            disabled={pdfBusy || filtered.length === 0}
            aria-label="PDF preview"
            style={{ color: filtered.length && !pdfBusy ? 'var(--c-primary)' : undefined }}
          >
            <PdfIcon />
          </button>
          <button
            className="st-icon-btn"
            onClick={handleSharePdf}
            disabled={pdfBusy || filtered.length === 0}
            aria-label="Share PDF"
          >
            <ShareIcon />
          </button>
        </div>
      </div>
      {offline && (
        <div className="offline-slot">
          <OfflineBanner
            age={offline.trimmed
              ? `${offline.age} — the item list was too large to save offline`
              : offline.age}
            onRetry={() => window.location.reload()}
          />
        </div>
      )}

      {searchOn && (
        <div className="st-search">
          <input
            ref={searchRef}
            placeholder="Search, or a: article  b: barcode"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck="false"
          />
        </div>
      )}

      <div className="st-chips">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`st-chip${filter === f.key ? ' active' : ''}${f.key === 'low' && counts.low > 0 ? ' warn' : ''}${f.key === 'out' && counts.out > 0 ? ' danger' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label} <span className="st-chip-count">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      <div className="st-list-wrap" onScroll={onListScroll}>
        {loading && <div className="st-empty">Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="st-empty">
            {search.trim() ? `No matches for "${search.trim()}"` : 'No products found'}
          </div>
        )}
        {!loading && filtered.slice(0, visibleCount).map((p) => {
          const name = p.product_name || p.name || 'Unnamed';
          const qty = Number(p.current_stock ?? p.stock_quantity ?? 0);
          const unit = p.unit_of_measurement || p.unit || 'pcs';
          const purRate = Number(p.purchase_rate ?? p.display_cost ?? 0);
          const saleRate = Number(p.sale_rate ?? p.sale_price ?? 0);
          const stockVal = Number(p.display_stock_value ?? 0);
          const status = stockStatus(p);
          const id = p.product_id || p.id;

          return (
            <div
              key={id}
              className="st-row"
              role="button"
              onClick={() => navigate(`/stock/${id}`)}
            >
              <div className={`st-bar ${status}`} aria-hidden />
              <div className="st-content">
                <div className="st-name">{name}</div>
                {(() => {
                  const article = p.article_number || '';
                  const barcode = p.barcode || '';
                  const hsn = p.hsn_code || '';
                  const size = p.size_value || '';
                  // Article number leads, as a chip.
                  //
                  // It was not shown at all, yet it is the code a shopkeeper
                  // actually calls a garment by — the barcode is for scanners
                  // and the HSN is for the tax return. Given as a chip rather
                  // than another dot-separated fragment so the eye lands on it
                  // without reading the whole line, and so it survives when the
                  // rest of the meta is truncated on a narrow screen.
                  const meta = [barcode, hsn && `HSN ${hsn}`, size && `Size ${size}`].filter(Boolean);
                  if (!article && !meta.length) return null;
                  return (
                    <div className="st-meta">
                      {article && <span className="st-article" title={`Article ${article}`}>{article}</span>}
                      {meta.length > 0 && <span className="st-meta-text">{meta.join(' · ')}</span>}
                    </div>
                  );
                })()}
                <div className="st-rates">
                  {purRate > 0 && <span className="st-rate">Pur ₹{formatINR(purRate)}</span>}
                  {purRate > 0 && saleRate > 0 && <span className="st-rate-sep">·</span>}
                  {saleRate > 0 && <span className="st-rate">Sale ₹{formatINR(saleRate)}</span>}
                </div>
              </div>
              <div className="st-side">
                <div className={`st-qty ${status}`}>
                  {status === 'low' && <span className="st-alert"><AlertIcon /></span>}
                  <span className="st-qty-val">{qty}</span>
                  <span className="st-qty-unit">{unit}</span>
                </div>
                {stockVal > 0 && <div className="st-val">₹{formatINR(stockVal)}</div>}
              </div>
              <div className="st-chev"><ChevR /></div>
            </div>
          );
        })}
      </div>

      {!loading && filtered.length > 0 && (
        <div className="st-footer">
          <span className="st-footer-count">{filtered.length} product{filtered.length === 1 ? '' : 's'}</span>
          <span className="st-footer-total">₹{formatINR(totalValue)}</span>
        </div>
      )}

      {pdfUrl && (
        <div className="rl-pdf-overlay" style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--c-bg-app)', display: 'flex', flexDirection: 'column' }}>
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Stock Report</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, 'stock-report.pdf', 'Stock Report');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe className="rl-pdf-frame" src={pdfUrl} title="Stock Report PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}

      {notFoundCode !== null && (
        <NotFoundSheet
          code={notFoundCode}
          onClose={() => setNotFoundCode(null)}
          onScanAgain={() => { setNotFoundCode(null); setTimeout(handleScan, 200); }}
          onSearchInstead={() => { setNotFoundCode(null); setSearchOn(true); setTimeout(() => setSearch(notFoundCode), 50); }}
        />
      )}
    </div>
  );
}

function NotFoundSheet({ code, onClose, onScanAgain, onSearchInstead }) {
  return (
    <div className="st-nf-backdrop" onClick={onClose}>
      <div className="st-nf-sheet" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="st-nf-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <path d="M14 14h3M14 17h3M14 21h7M17 14v7"/>
          </svg>
        </div>
        <div className="st-nf-title">No matching product</div>
        <div className="st-nf-sub">We scanned the code but couldn&rsquo;t find it in stock.</div>
        <div className="st-nf-code">
          <span className="st-nf-code-label">Scanned</span>
          <span className="st-nf-code-value">{code}</span>
        </div>
        <div className="st-nf-actions">
          <button className="st-nf-btn st-nf-btn--ghost" onClick={onSearchInstead}>Search instead</button>
          <button className="st-nf-btn st-nf-btn--primary" onClick={onScanAgain}>Scan again</button>
        </div>
        <button className="st-nf-close" onClick={onClose} aria-label="Close">Close</button>
      </div>
    </div>
  );
}
