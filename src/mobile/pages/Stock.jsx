import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { Capacitor } from '@capacitor/core';
import { productAPI } from '../../api';
import OfflineBanner from '../components/OfflineBanner';
import { fetchSnapshot, sectionOf, sectionWasTrimmed, sectionIsPartial, snapshotAge, isUnreachable, friendlyError, snapshotMatchesSession } from '../utils/offlineSnapshot';
import { parseSearch, matchesSearch } from '../utils/searchPrefix';
import { getCached, setCached } from '../utils/screenCache';
import { formatINR } from '../utils/format';
import { shareViaNative } from '../utils/sharePdf';
import './Stock.css';
import './ReportList.css';
import Overlay from '../components/Overlay';

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

/* One request's worth of rows. 500 is the server's own ceiling
 * (helpers.sanitizePagination), so asking for more just gets 500. */
const PAGE_SIZE = 500;

/* Catalogues at or under this stay entirely in memory: local filtering, local
 * search, exact chip counts, and it all keeps working offline. Above it the
 * server drives, because holding 30,000 enriched rows in a WebView and
 * re-filtering them on every keystroke is not a slower version of the same
 * screen — it is a screen that stops responding. */
const BULK_LIMIT = 1500;

/* Rows a phone can turn into a PDF without falling over. */
const PDF_ROW_CAP = 2000;

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
  const [totalCount, setTotalCount] = useState(0);   // server's count for this query
  const [summary, setSummary]       = useState(null); // whole-catalogue chip counts
  const [nextPage, setNextPage]     = useState(2);
  const [listBusy, setListBusy]     = useState(false);
  const searchRef = useRef(null);
  const pdfUrlRef = useRef(null);

  /* ── Loading, at two very different scales ──────────────────────────
   *
   * A shop with 120 products and a shop with 30,000 want opposite things.
   *
   * Small catalogue: hold it all. Filtering and search are then instant, work
   * with no network, and the chip counts are exact. There is no reason to make
   * a 120-item shop wait on a round trip to type a letter.
   *
   * Large catalogue: holding it all is not "slower", it is broken. 30,000
   * products meant sixty paged requests fired at once through a tunnel, sixty
   * enriched queries on the shop PC, ~24 MB of objects in a WebView, and a
   * re-filter of that whole array on every keystroke. So above the threshold
   * the server does work it is already able to do: it accepts `search`,
   * `search_field` and `stock_status`, and returns whole-catalogue counts in
   * `summary` — so the chips stay right without the rows behind them ever
   * being loaded.
   *
   * Which mode is decided by the first response's `total`. Neither shop has
   * to be configured for it, and neither pays for the other's problem. */
  const bulkRef  = useRef(true);   // whole catalogue in memory?
  const reqIdRef = useRef(0);      // drops responses from superseded queries
  const moreRef  = useRef(false);  // a page-append is already in flight

  const rowsOf = (res) => (Array.isArray(res.data) ? res.data : (res.data?.data || []));

  const queryParams = (page, { filter: f = 'all', search: q = '' } = {}) => {
    const params = { limit: PAGE_SIZE, page };
    if (f !== 'all') params.stock_status = f;
    const term = String(q).trim();
    if (term) {
      /* `a:` article, `b:` barcode, `n:` name, `h:` HSN — the same prefixes the
       * local matcher understands, handed to the server instead.
       *
       * Only the SCOPED term goes over the wire. "a: 668 plazo" means
       * article-668 AND matches-plazo-somewhere, and the endpoint takes one
       * search string against one field — so the server narrows to article 668
       * (33 rows out of 30,000) and the extra words are ANDed locally over
       * that handful. Splitting it this way keeps the meaning intact without
       * needing a second search parameter on the server. */
      const parsed = parseSearch(term);
      if (parsed.scope) params.search_field = parsed.scope;
      params.search = parsed.term || term;
    }
    return params;
  };

  /* Mount: load the catalogue unfiltered and decide the mode. */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Show the previous visit's catalogue instantly; refresh behind it.
    const cachedStock = getCached('stock');
    if (cachedStock) { setProducts(cachedStock); setLoading(false); }

    const run = async () => {
      const myReq = ++reqIdRef.current;
      const first = await productAPI.getAll(queryParams(1));
      if (cancelled || myReq !== reqIdRef.current) return;

      const rows  = rowsOf(first);
      const total = Number(first.data?.total ?? rows.length);
      setProducts(rows);
      setTotalCount(total);
      setSummary(first.data?.summary || null);
      setNextPage(2);
      setLoading(false);
      setOffline(null);

      bulkRef.current = total <= BULK_LIMIT;
      if (!bulkRef.current || total <= rows.length) return;

      // Small enough to hold: fill in the rest behind the first paint, so the
      // screen is usable at once and complete a moment later.
      const pages = Math.ceil(total / PAGE_SIZE);
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
          productAPI.getAll(queryParams(i + 2)).then(rowsOf).catch(() => [])),
      );
      if (cancelled || myReq !== reqIdRef.current) return;
      const all = [...rows, ...rest.flat()];
      setProducts(all);
      setNextPage(pages + 1);
      setCached('stock', all);       // only a COMPLETE catalogue is worth caching
    };

    run()
      .catch(async (e) => {
        if (cancelled) return;
        if (isUnreachable(e)) {
          const snap = await fetchSnapshot().catch(() => null);
          const section = sectionOf(snap, 'stock');
          if (!cancelled && section) {
            const raw = Array.isArray(section)
              ? section
              : (section?.data || section?.products || []);
            bulkRef.current = true;      // the snapshot is all we will ever have
            setProducts(raw);
            setTotalCount(raw.length);
            setSummary(null);
            // A partial list must never read as a complete one — someone
            // checking whether an article is in stock would conclude it is
            // not, when it is simply past the cut.
            setOffline({
              age: snapshotAge(snap),
              partial: sectionIsPartial(snap, 'stock') ? raw.length : 0,
            });
            return;
          }
          if (!cancelled && snap && !snapshotMatchesSession(snap)) {
            // Saved figures exist, but for a different company. Showing them
            // under this company's name would be worse than showing nothing.
            setOffline({ age: snapshotAge(snap), otherCompany: true });
            setProducts([]);
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
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load stock') });
        setProducts([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Mount only. Filter and search are handled below, and re-running this
    // would throw away a loaded catalogue on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Filter / search, in server mode only.
   *
   * Debounced, because at 30,000 rows every keystroke is a real query on the
   * shop's PC. In bulk mode this does nothing at all — the list is already
   * here, and filtering it locally is instantaneous. */
  useEffect(() => {
    if (bulkRef.current) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      const myReq = ++reqIdRef.current;
      setListBusy(true);
      try {
        const res = await productAPI.getAll(queryParams(1, { filter, search }));
        if (cancelled || myReq !== reqIdRef.current) return;
        setProducts(rowsOf(res));
        setTotalCount(Number(res.data?.total ?? 0));
        if (res.data?.summary) setSummary(res.data.summary);
        setNextPage(2);
      } catch (e) {
        if (!cancelled) Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not search stock') });
      } finally {
        if (!cancelled) setListBusy(false);
      }
    }, 280);
    return () => { cancelled = true; clearTimeout(t); };
  }, [filter, search]);

  /* Append the next page when the list nears its end (server mode). */
  const loadMore = async () => {
    if (bulkRef.current || moreRef.current) return;
    if (products.length >= totalCount) return;
    moreRef.current = true;
    const myReq = reqIdRef.current;
    try {
      const res = await productAPI.getAll(queryParams(nextPage, { filter, search }));
      if (myReq !== reqIdRef.current) return;   // the query changed under us
      const rows = rowsOf(res);
      if (rows.length) {
        setProducts((prev) => [...prev, ...rows]);
        setNextPage((n) => n + 1);
      }
    } catch { /* a failed page is a shorter list, not a broken screen */ }
    finally { moreRef.current = false; }
  };

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
    /* A PDF of 30,000 rows is not a document anyone opens — it is a phone
     * that stops responding for a minute and then runs out of memory. Export
     * what is on screen and say so; the desktop is where a full stock report
     * belongs. */
    if (filtered.length > PDF_ROW_CAP) {
      Toast.show({ content: `Exporting the first ${PDF_ROW_CAP.toLocaleString('en-IN')} — narrow the search for a smaller list.` });
    }
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
        body: filtered.slice(0, PDF_ROW_CAP).map((p) => {
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

  /* In bulk mode `products` is the whole catalogue and the filter runs here.
   * In server mode the rows already ARE the answer to this query — filtering
   * them again would only hide rows the server deliberately sent. */
  const filtered = useMemo(() => {
    if (!bulkRef.current) {
      // The server already applied the scope, the scoped term and the stock
      // status. What it could not apply is the extra words of a combined
      // search, so those are ANDed here over the rows it sent back.
      const parsed = parseSearch(search);
      if (!parsed.extra?.length) return products;
      return products.filter((p) => matchesSearch(p, { ...parsed, term: '' }));
    }
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
      // Server mode: the rows we have ARE the window, so nearing the end means
      // asking for more rather than revealing more.
      if (!bulkRef.current) loadMore();
    }
  };

  /* Chip counts. In bulk mode, counted here from the real rows. In server mode
   * they come from the response's `summary`, which the server computes across
   * the WHOLE catalogue — so "Out of stock 412" is true even though only 500
   * rows have ever been loaded. Counting the loaded rows instead would show a
   * number that grows as you scroll, which is worse than no number. */
  const counts = useMemo(() => {
    if (!bulkRef.current && summary) {
      return {
        all: Number(summary.total_count ?? totalCount ?? 0),
        in:  Number(summary.in_count  ?? 0),
        low: Number(summary.low_count ?? 0),
        out: Number(summary.out_count ?? 0),
      };
    }
    const c = { all: products.length, in: 0, low: 0, out: 0 };
    for (const p of products) c[stockStatus(p)]++;
    return c;
  }, [products, summary, totalCount]);

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
            note={offline.otherCompany ? 'no saved figures for this company' : null}
            age={offline.trimmed
              ? `${offline.age} — the item list was too large to save offline`
              : offline.partial
                ? `${offline.age} — first ${offline.partial} items only`
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
            {search.trim()
              ? `No matches for "${search.trim()}"`
              : offline
                ? 'No items in the saved copy'
                : 'No products found'}
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
          {/* In server mode `filtered` is only what has been scrolled into
              existence, so the honest number is the server's count for this
              query — and saying "500 products" for a 30,000-item shop would
              be a lie that changes as you scroll. */}
          <span className="st-footer-count">
            {bulkRef.current
              ? `${filtered.length} product${filtered.length === 1 ? '' : 's'}`
              : `${filtered.length} of ${totalCount.toLocaleString('en-IN')} loaded`}
          </span>
          <span className="st-footer-total">₹{formatINR(totalValue)}</span>
        </div>
      )}

      {pdfUrl && (
        <Overlay>
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
        </Overlay>
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
