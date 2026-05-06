// ── Product Items Detail (Sales / Purchase) — R11 ────────────────────
//
// Per-LINE-ITEM detail. One row per (bill, product). Two thin wrappers
// preset `side`: ProductSalesReport (sales) and ProductPurchaseReport
// (purchase). Pairs with /api/reports/product-sales-items and
// /api/reports/product-purchase-items.
//
// Layout (top → bottom):
//   1. Header  — title + period chip + period-preset segmented + date
//                range + Customize popover + Refresh + Export + Print
//   2. KPIs    — period totals (qty / value / cost / profit / etc.)
//   3. Filter bar — party multi, category multi, barcode, HSN, search
//   4. Table   — virtualized via useVirtualizedReport contract
//
// Customize popover toggles column visibility; selection persists per-
// side via localStorage. Click a row → drill into the bill.

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  Tag, Button, Input, DatePicker, Select, Tooltip, Popover, Checkbox,
  message, Space,
} from 'antd';
import {
  SettingOutlined, SearchOutlined, ReloadOutlined,
  FilterOutlined, BarcodeOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI, partyAPI, productAPI, categoryAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import './bills-outstanding.css';
import './product-items.css';

const fmtINR = (v) => {
  const n = Number(v) || 0;
  return '₹ ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtINR0 = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1000) return '₹ ' + Math.round(n).toLocaleString('en-IN');
  return fmtINR(n);
};
const fmtQty  = (v) => {
  const n = Number(v) || 0;
  // Drop trailing zeros for cleaner display ("5" instead of "5.00").
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtDate = (v) => v ? dayjs(v).format('DD/MM/YYYY') : '—';
const fmtPct  = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) + '%' : '—';
};

// Period presets — match Sales/Purchase Report's set so all reports
// in the family read consistently.
function presetRange(key) {
  const today = dayjs();
  const fyStartYear = today.month() >= 3 ? today.year() : today.year() - 1;
  if (key === 'this_fy')    return [dayjs(`${fyStartYear}-04-01`),   dayjs(`${fyStartYear+1}-03-31`)];
  if (key === 'last_fy')    return [dayjs(`${fyStartYear-1}-04-01`), dayjs(`${fyStartYear}-03-31`)];
  if (key === 'this_month') return [today.startOf('month'),          today.endOf('month')];
  if (key === 'this_q') {
    const qs = Math.floor(today.month() / 3) * 3;
    return [today.month(qs).startOf('month'), today.endOf('month')];
  }
  return null;
}
const PRESETS = [
  { v: 'this_fy',    l: 'This FY' },
  { v: 'last_fy',    l: 'Last FY' },
  { v: 'this_q',     l: 'This Q' },
  { v: 'this_month', l: 'This Month' },
  { v: 'custom',     l: 'Custom' },
];

// ─── Per-side configuration ──────────────────────────────────────────
const SIDE = {
  sales: {
    title:           'Product Sales Detail',
    partyLabel:      'Customer',
    partyTypeQuery:  'Customer',
    fetcher:         (p) => reportAPI.productSalesItems(p),
    drillRoute:      (id) => `/sale/edit/${id}`,
    csvBaseName:     'product_sales_detail',
  },
  purchase: {
    title:           'Product Purchase Detail',
    partyLabel:      'Supplier',
    partyTypeQuery:  'Supplier',
    fetcher:         (p) => reportAPI.productPurchaseItems(p),
    drillRoute:      (id) => `/purchase/edit/${id}`,
    csvBaseName:     'product_purchase_detail',
  },
};

// ─── Column registry — every column toggleable from Customize ────────
//
// `side` = 'both' (visible on both reports), 'sales' (sales only),
// 'purchase' (purchase only). The popover renders only the columns
// for the current side.
const ALL_COLS = [
  { key: 'bill_number',        label: 'Bill No',           side: 'both', width: 110, default: true  },
  { key: 'bill_date',          label: 'Date',              side: 'both', width: 100, default: true  },
  { key: 'party_name',         label: 'Party',             side: 'both', width: 180, default: true  },
  { key: 'party_mobile',       label: 'Mobile',            side: 'both', width: 120, default: false },
  { key: 'party_gstin',        label: 'GSTIN',             side: 'both', width: 150, default: false },
  { key: 'party_city',         label: 'City',              side: 'both', width: 110, default: false },
  { key: 'party_state',        label: 'State',             side: 'both', width: 110, default: false },
  { key: 'category_name',      label: 'Category',          side: 'both', width: 130, default: true  },
  { key: 'product_name',       label: 'Product',           side: 'both', width: 220, default: true  },
  { key: 'size',               label: 'Size',              side: 'both', width:  80, default: false },
  { key: 'article_number',     label: 'Article',           side: 'both', width: 110, default: false },
  { key: 'hsn_code',           label: 'HSN',               side: 'both', width:  90, default: false },
  { key: 'barcode',            label: 'Barcode',           side: 'both', width: 130, default: false },
  { key: 'quantity',           label: 'Qty',               side: 'both', width:  80, default: true,  align: 'right' },
  { key: 'unit_type',          label: 'Unit',              side: 'sales', width:  70, default: false },
  { key: 'rate',               label: 'Rate',              side: 'both', width: 100, default: true,  align: 'right' },
  { key: 'mrp',                label: 'MRP',               side: 'both', width: 100, default: false, align: 'right' },
  { key: 'discount_percentage',label: 'Disc %',            side: 'both', width:  80, default: true,  align: 'right' },
  { key: 'discount_amount',    label: 'Disc Amt',          side: 'both', width: 100, default: true,  align: 'right' },
  { key: 'gst_rate',           label: 'GST %',             side: 'both', width:  70, default: false, align: 'right' },
  { key: 'tax_amount',         label: 'Tax Amt',           side: 'both', width: 100, default: false, align: 'right' },
  { key: 'taxable_amount',     label: 'Taxable',           side: 'both', width: 110, default: false, align: 'right' },
  { key: 'total_amount',       label: 'Total',             side: 'both', width: 110, default: true,  align: 'right' },
  { key: 'cost_rate',          label: 'Cost Rate',         side: 'sales', width: 110, default: true,  align: 'right' },
  { key: 'profit',             label: 'Profit',            side: 'sales', width: 110, default: true,  align: 'right' },
  { key: 'profit_pct',         label: 'Profit %',          side: 'sales', width:  90, default: false, align: 'right' },
  { key: 'line_value',         label: 'Line Value',        side: 'purchase', width: 120, default: true,  align: 'right' },
];

const colsKey = (side) => `erp_product_items_cols_${side}`;

export default function ProductItemsReport({ side }) {
  const cfg = SIDE[side];
  if (!cfg) throw new Error(`ProductItemsReport: unknown side "${side}"`);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialFromUrl  = (k, fb = '') => searchParams.get(k) ?? fb;
  const initialArrFromUrl = (k) => (searchParams.get(k) || '').split(',').filter(Boolean);

  // ── Filter state ─────────────────────────────────────────────────
  const [fromDate, setFromDate]   = useState(() => initialFromUrl('from_date', dayjs().startOf('month').format('YYYY-MM-DD')));
  const [toDate, setToDate]       = useState(() => initialFromUrl('to_date',   dayjs().format('YYYY-MM-DD')));
  const [presetKey, setPresetKey] = useState(() => initialFromUrl('preset', 'this_month'));
  const [partyIds, setPartyIds]   = useState(() => initialArrFromUrl('party_ids').map(Number).filter(Number.isFinite));
  const [categoryIds, setCategoryIds] = useState(() => initialArrFromUrl('category_ids').map(Number).filter(Number.isFinite));
  const [productIds, setProductIds] = useState(() => initialArrFromUrl('product_ids').map(Number).filter(Number.isFinite));
  const [barcode, setBarcode] = useState(() => initialFromUrl('barcode'));
  const [hsnCode, setHsnCode] = useState(() => initialFromUrl('hsn_code'));
  const [searchInput, setSearchInput] = useState(() => initialFromUrl('search'));
  const [search, setSearch] = useState(() => initialFromUrl('search'));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Controlled `open` state for each multi-select. We close the
  // dropdown after a pick (so the user sees the selection) and after
  // the box is emptied via backspace / clear (an empty box with an
  // open dropdown looks broken). The closeOn helper below decides
  // when to close — see comment there.
  const [partyOpen, setPartyOpen]       = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [productOpen, setProductOpen]   = useState(false);

  // Decide when to auto-close a multi-select dropdown:
  //   • newVal.length > prevVal.length  → user ADDED an option;
  //     close so the selection is visible and the user can scan
  //     the next filter.
  //   • newVal.length === 0             → user EMPTIED the box
  //     (backspace through the last chip OR clicked the X);
  //     close because an empty box with an open dropdown is
  //     confusing.
  //   • newVal.length < prevVal.length AND > 0 → user removed a
  //     chip but kept others; KEEP the dropdown open so they can
  //     remove more without re-clicking the box.
  // Defined as a stable inline closure (not useCallback) — the
  // overhead of recreating it per render is negligible compared
  // to the simplicity of co-locating it with the Selects.
  const closeOn = (newVal, prevVal, setOpen) => {
    if (newVal.length > prevVal.length || newVal.length === 0) {
      setOpen(false);
    }
  };

  // Debounce free-text search.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ── Column visibility — persisted per side ────────────────────────
  const COLS_KEY = colsKey(side);
  const colsForSide = useMemo(() =>
    ALL_COLS.filter((c) => c.side === 'both' || c.side === side), [side]);
  const defaultCols = useMemo(() => {
    const out = {};
    for (const c of colsForSide) out[c.key] = !!c.default;
    return out;
  }, [colsForSide]);
  const [colsVisible, setColsVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...defaultCols, ...saved } : defaultCols;
    } catch { return defaultCols; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_KEY, JSON.stringify(colsVisible)); } catch {}
  }, [colsVisible, COLS_KEY]);

  // ── URL sync ─────────────────────────────────────────────────────
  // IMPORTANT: setSearchParams is INTENTIONALLY excluded from the deps.
  // React Router v6's useSearchParams returns a setSearchParams whose
  // identity changes every time `searchParams` does (it's wrapped in
  // useCallback([navigate, searchParams])). Including it in deps would
  // mean: each time we navigate here, location updates → searchParams
  // re-memos → setSearchParams gets a new identity → this effect re-runs
  // → calls setSearchParams again → re-render loop. Reading the latest
  // setSearchParams from a ref keeps the closure stable so the effect
  // only fires when the actual filter state changes.
  const setSearchParamsRef = useRef(setSearchParams);
  useEffect(() => { setSearchParamsRef.current = setSearchParams; }, [setSearchParams]);
  useEffect(() => {
    const next = {};
    if (fromDate)        next.from_date      = fromDate;
    if (toDate)          next.to_date        = toDate;
    if (presetKey)       next.preset         = presetKey;
    if (partyIds.length) next.party_ids      = partyIds.join(',');
    if (categoryIds.length) next.category_ids = categoryIds.join(',');
    if (productIds.length)  next.product_ids  = productIds.join(',');
    if (barcode)         next.barcode        = barcode;
    if (hsnCode)         next.hsn_code       = hsnCode;
    if (search)          next.search         = search;
    setSearchParamsRef.current(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, presetKey, partyIds, categoryIds, productIds, barcode, hsnCode, search]);

  // ── Server filters → virtualized hook ────────────────────────────
  const filters = useMemo(() => ({
    from_date:      fromDate,
    to_date:        toDate,
    party_ids:      partyIds.length    ? partyIds.join(',')    : undefined,
    category_ids:   categoryIds.length ? categoryIds.join(',') : undefined,
    product_ids:    productIds.length  ? productIds.join(',')  : undefined,
    barcode:        barcode || undefined,
    hsn_code:       hsnCode || undefined,
    search:         search || undefined,
  }), [fromDate, toDate, partyIds, categoryIds, productIds, barcode, hsnCode, search]);

  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: cfg.fetcher,
    filters,
    chunkSize: 200,
  });

  // ── Category options ──────────────────────────────────────────────
  // Pulled from the master table (same pattern as Party/Product below
  // and StockReport / bill-entry forms). Period-filtering the dropdown
  // would hide categories on legacy items whose snapshot category_id
  // is NULL — and a master-list fetch is consistent with the other
  // two filters on this page.
  const [categoryOptions, setCategoryOptions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    categoryAPI.getAllFlat()
      .then((r) => {
        if (cancelled) return;
        const list = r?.data || [];
        setCategoryOptions(list.map((c) => ({
          value: c.category_id,
          label: c.category_name,
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ── Party options ─────────────────────────────────────────────────
  const [partyOptions, setPartyOptions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    partyAPI.getAll({ party_type: cfg.partyTypeQuery, limit: 5000 })
      .then((r) => {
        if (cancelled) return;
        const list = r?.data?.data || r?.data || [];
        setPartyOptions(list.map((p) => ({
          value: p.party_id,
          label: p.party_name + (p.city ? ` · ${p.city}` : ''),
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cfg.partyTypeQuery]);

  // ── Product options — filtered by selected categories ────────────
  // Mirrors the sales/purchase bill-entry form: when the operator
  // narrows by category, the product dropdown shrinks to show only
  // products in that category. Re-fetches when categoryIds changes.
  // Single-category filter goes through productAPI.getAll's
  // category_id param; multi-category falls back to client-side
  // filtering on a wider fetch (no multi-cat support in the API yet).
  const [productOptions, setProductOptions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const params = { limit: 5000 };
    if (categoryIds.length === 1) params.category_id = categoryIds[0];
    productAPI.getAll(params)
      .then((r) => {
        if (cancelled) return;
        const list = r?.data?.data || r?.data || [];
        const filtered = categoryIds.length > 1
          ? list.filter((p) => categoryIds.includes(p.category_id))
          : list;
        setProductOptions(filtered.map((p) => ({
          value: p.product_id,
          label: p.product_name + (p.barcode ? ` · ${p.barcode}` : ''),
        })));
        // Drop product selections that no longer match the new
        // category set so the chip list stays honest. Returning the
        // SAME array reference when nothing was dropped is critical:
        // an unconditional `.filter()` always allocates a new array,
        // and React's setState updates state for any new reference
        // (Object.is comparison), even if the content is identical.
        // That triggers a re-render → the URL-sync effect re-fires
        // (productIds is in its deps) → setSearchParams → location
        // changes → cascade. Skipping the update when nothing actually
        // changed breaks the cascade for the common case (no products
        // selected when category is picked).
        setProductIds((ids) => {
          const next = ids.filter((id) => filtered.some((p) => p.product_id === id));
          return next.length === ids.length ? ids : next;
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryIds.join(',')]);

  // ── Period preset handler ─────────────────────────────────────────
  const applyPreset = useCallback((k) => {
    const r = presetRange(k);
    if (!r) return;
    setFromDate(r[0].format('YYYY-MM-DD'));
    setToDate(r[1].format('YYYY-MM-DD'));
    setPresetKey(k);
  }, []);

  // ── Drill-down ────────────────────────────────────────────────────
  // Cursor + multi-select for the rows; F-keys live in the bottom
  // ActionStrip and operate on the cursored row.
  const sel = useListSelection({ totalCount, rows });
  const single = sel.activeRow;
  const searchInputRef = useRef(null);
  const { openDate } = useDatePopup();

  const drillBill = useCallback((row) => {
    if (!row || row.__loading || !row.bill_id) return;
    navigate(cfg.drillRoute(row.bill_id));
  }, [navigate, cfg]);

  // ── Column registry → table-spec map ─────────────────────────────
  const COL_SPECS = useMemo(() => ({
    bill_number:     { dataIndex: 'bill_number', sorter: true,
                       render: (v, row) => (
                         <a className="bo-bill-link" onClick={(e) => { e.stopPropagation(); drillBill(row); }}>{v}</a>
                       ) },
    bill_date:       { dataIndex: 'bill_date', sorter: true, render: (v) => fmtDate(v) },
    party_name:      { dataIndex: 'party_name', sorter: true,
                       render: (v) => <span style={{ fontWeight: 500 }}>{v}</span> },
    party_mobile:    { dataIndex: 'party_mobile', render: (v) => v || '—' },
    party_gstin:     { dataIndex: 'party_gstin', render: (v) => v ? <span className="pi-mono">{v}</span> : '—' },
    party_city:      { dataIndex: 'party_city',  render: (v) => v || '—' },
    party_state:     { dataIndex: 'party_state', render: (v) => v || '—' },
    category_name:   { dataIndex: 'category_name', sorter: true, render: (v) => v || '—' },
    product_name:    { dataIndex: 'product_name', sorter: true,
                       render: (v) => <span style={{ fontWeight: 500 }}>{v}</span> },
    size:            { dataIndex: 'size', render: (v) => v || '—' },
    article_number:  { dataIndex: 'article_number', render: (v) => v || '—' },
    hsn_code:        { dataIndex: 'hsn_code', render: (v) => v || '—' },
    barcode:         { dataIndex: 'barcode', render: (v) => v ? <span className="pi-mono">{v}</span> : '—' },
    quantity:        { dataIndex: 'quantity', sorter: true, align: 'right',
                       render: (v) => <span className="pi-num">{fmtQty(v)}</span> },
    unit_type:       { dataIndex: 'unit_type', render: (v) => v || '—' },
    rate:            { dataIndex: 'rate', sorter: true, align: 'right',
                       render: (v) => <span className="pi-num">{fmtINR(v)}</span> },
    mrp:             { dataIndex: 'mrp', align: 'right',
                       render: (v) => <span className="pi-num pi-num-muted">{fmtINR(v)}</span> },
    discount_percentage: { dataIndex: 'discount_percentage', align: 'right',
                       render: (v) => <span className="pi-num pi-num-muted">{Number(v) ? Number(v).toFixed(1) + '%' : '—'}</span> },
    discount_amount: { dataIndex: 'discount_amount', align: 'right',
                       render: (v) => <span className="pi-num pi-num-muted">{Number(v) ? fmtINR(v) : '—'}</span> },
    gst_rate:        { dataIndex: 'gst_rate', align: 'right',
                       render: (v) => <span className="pi-num pi-num-muted">{Number(v) ? Number(v).toFixed(1) + '%' : '—'}</span> },
    tax_amount:      { dataIndex: 'tax_amount', align: 'right',
                       render: (v) => <span className="pi-num pi-num-muted">{Number(v) ? fmtINR(v) : '—'}</span> },
    taxable_amount:  { dataIndex: 'taxable_amount', sorter: true, align: 'right',
                       render: (v) => <span className="pi-num">{fmtINR(v)}</span> },
    total_amount:    { dataIndex: 'total_amount', sorter: true, align: 'right',
                       render: (v) => <span className="pi-num pi-num-strong">{fmtINR(v)}</span> },
    cost_rate:       { dataIndex: 'cost_rate', align: 'right',
                       render: (v) => <span className="pi-num pi-num-muted">{fmtINR(v)}</span> },
    profit:          { dataIndex: 'profit', align: 'right',
                       render: (v) => {
                         const n = Number(v) || 0;
                         const cls = n > 0 ? 'pi-profit-pos' : n < 0 ? 'pi-profit-neg' : 'pi-num-muted';
                         return <span className={`pi-num ${cls}`}>{fmtINR(v)}</span>;
                       } },
    profit_pct:      { dataIndex: 'profit_pct', align: 'right',
                       render: (v) => {
                         if (v == null) return <span className="pi-num pi-num-muted">—</span>;
                         const n = Number(v);
                         const cls = n > 0 ? 'pi-profit-pos' : n < 0 ? 'pi-profit-neg' : 'pi-num-muted';
                         return <span className={`pi-num ${cls}`}>{fmtPct(v)}</span>;
                       } },
    line_value:      { dataIndex: 'line_value', align: 'right',
                       render: (v) => <span className="pi-num pi-num-strong">{fmtINR(v)}</span> },
  }), [drillBill]);

  // Build the visible-columns array in the order they appear in
  // ALL_COLS (so the operator's customize choices respect a canonical
  // column order rather than the toggle-flip order).
  const tableColumns = useMemo(() => {
    return colsForSide
      .filter((c) => colsVisible[c.key])
      .map((c) => ({
        key: c.key,
        title: c.label,
        width: c.width,
        align: c.align,
        ...COL_SPECS[c.key],
      }));
  }, [colsForSide, colsVisible, COL_SPECS]);

  // ── Customize popover ────────────────────────────────────────────
  // Uses shared `.cols-menu` markup (styles/global.css). The All/Default
  // pill row stays as buttons since they're actions, not toggles.
  const customizePopover = (
    <div className="cols-menu">
      <div className="grp">
        <div className="gh">
          <span>Columns</span>
          <button
            className="gh-reset"
            type="button"
            onClick={() => setColsVisible(defaultCols)}
          >Reset</button>
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 6px' }}>
          <Button size="small"
            onClick={() => setColsVisible(Object.fromEntries(colsForSide.map((c) => [c.key, true])))}>
            All
          </Button>
          <Button size="small" onClick={() => setColsVisible(defaultCols)}>Default</Button>
        </div>
        {colsForSide.map((c) => (
          <label key={c.key} className="opt">
            <input
              type="checkbox"
              checked={!!colsVisible[c.key]}
              onChange={(e) => setColsVisible((cv) => ({ ...cv, [c.key]: e.target.checked }))}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  // ── KPI tiles ────────────────────────────────────────────────────
  const isSales = side === 'sales';

  // ── Footer summary cells ─────────────────────────────────────────
  const summaryCells = useCallback((col) => {
    if (col.key === 'bill_number') return <strong>Total ({summary.row_count || 0})</strong>;
    if (col.key === 'party_name')  return <span className="pi-num-muted">{summary.party_count || 0} {cfg.partyLabel.toLowerCase()}s</span>;
    if (col.key === 'product_name') return <span className="pi-num-muted">{summary.product_count || 0} products</span>;
    if (col.key === 'quantity')    return <span className="pi-num">{fmtQty(summary.total_qty)}</span>;
    if (col.key === 'taxable_amount') return <span className="pi-num">{fmtINR(summary.total_taxable)}</span>;
    if (col.key === 'tax_amount')  return <span className="pi-num pi-num-muted">{fmtINR(summary.total_tax)}</span>;
    if (col.key === 'total_amount') return <span className="pi-num pi-num-strong">{fmtINR(summary.total_value)}</span>;
    if (isSales && col.key === 'cost_rate')  return <span className="pi-num pi-num-muted">{fmtINR(summary.total_cost)}</span>;
    if (isSales && col.key === 'profit') {
      const n = Number(summary.total_profit) || 0;
      const cls = n > 0 ? 'pi-profit-pos' : n < 0 ? 'pi-profit-neg' : '';
      return <span className={`pi-num ${cls}`}>{fmtINR(summary.total_profit)}</span>;
    }
    if (!isSales && col.key === 'line_value') return <span className="pi-num pi-num-strong">{fmtINR(summary.total_value)}</span>;
    return null;
  }, [summary, cfg.partyLabel, isSales]);

  // ── Refresh — clears every filter EXCEPT the date range, then
  // re-fetches. The date range survives because operators almost
  // always want to keep their reporting period; the chips/inputs/
  // search box are the noisy state that's worth wiping with one
  // click. Dropdowns are also forced closed so the post-clear page
  // doesn't show a still-open picker hanging over the empty box.
  const handleRefresh = useCallback(() => {
    setPartyIds([]);
    setCategoryIds([]);
    setProductIds([]);
    setBarcode('');
    setHsnCode('');
    setSearchInput('');
    setSearch('');
    setPartyOpen(false);
    setCategoryOpen(false);
    setProductOpen(false);
    refresh();
  }, [refresh]);

  // ── Export (CSV) ─────────────────────────────────────────────────
  const handleExportCsv = useCallback(async () => {
    try {
      // Pull entire filtered set (cap at 10k for safety) via the same
      // endpoint with a wide limit — same pattern as Bills Outstanding.
      const r = await cfg.fetcher({ ...filters, page: 1, limit: 10000 });
      const all = r.data.data || [];
      const cols = colsForSide.filter((c) => colsVisible[c.key]);
      const header = cols.map((c) => c.label);
      const lines = all.map((row) => cols.map((c) => {
        const raw = row[c.key];
        if (raw == null) return '';
        if (c.key === 'bill_date') return fmtDate(raw);
        if (typeof raw === 'number') return raw.toFixed(2);
        return String(raw).replace(/"/g, '""');
      }));
      const csv = [header, ...lines].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${cfg.csvBaseName}_${fromDate}_${toDate}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      message.error('Export failed');
    }
  }, [cfg, filters, fromDate, toDate, colsForSide, colsVisible]);

  return (
    <div className="bo-page pi-page">
      {/* Header */}
      <div className="rpt-page-hd pi-hd">
        <div className="rpt-title">
          <h1>{cfg.title}</h1>
        </div>
        <div className="rpt-hd-ctrl">
          <div className="rpt-period">
            {PRESETS.map((p) => (
              <button key={p.v}
                className={presetKey === p.v ? 'on' : ''}
                onClick={() => p.v === 'custom' ? setPresetKey('custom') : applyPreset(p.v)}>
                {p.l}
              </button>
            ))}
          </div>
          <DatePicker.RangePicker
            className="rpt-date"
            value={[fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null]}
            onChange={(v) => {
              if (!v) return;
              setFromDate(v[0].format('YYYY-MM-DD'));
              setToDate(v[1].format('YYYY-MM-DD'));
              setPresetKey('custom');
            }}
            format="DD/MM/YYYY" allowClear={false}
          />
          <Popover content={customizePopover} title="Customize columns" trigger="click" placement="bottomRight">
            <Button className="rpt-btn" icon={<SettingOutlined />}>Customize</Button>
          </Popover>
          <Button className="rpt-btn" icon={<ReloadOutlined />} onClick={handleRefresh} loading={loading}>Refresh</Button>
          {/* Print + Excel moved to the bottom strip (F9 / F10). */}
        </div>
      </div>

      {/* Filter bar
          NOTE: maxTagCount is a FIXED number (not "responsive"). The
          "responsive" mode in Antd v5 uses a ResizeObserver to fit
          chips into the Select's width, but inside a flex container
          with min/maxWidth constraints (and React Strict Mode firing
          effects twice in dev) the measure → re-render → re-measure
          cycle can oscillate, producing a visible jiggle every time
          a chip is added or removed. A fixed count side-steps the
          measurement loop entirely — extra selections collapse into
          a "+N" overflow tag.

          Each multi-select is `open`-controlled via its own state so
          we can close the dropdown automatically:
            • after the user picks an option (so the selection is
              visible and the user can scan the next filter)
            • after the box becomes empty via backspace / clear (an
              empty box with an open dropdown is confusing UX) */}
      <div className="bo-filterbar">
        <Space size={8} wrap>
          <Select size="small" mode="multiple"
            placeholder={`Filter by ${cfg.partyLabel}`}
            value={partyIds}
            open={partyOpen}
            onDropdownVisibleChange={setPartyOpen}
            onChange={(v) => { setPartyIds(v); closeOn(v, partyIds, setPartyOpen); }}
            options={partyOptions} optionFilterProp="label"
            allowClear maxTagCount={2}
            style={{ minWidth: 220, maxWidth: 360 }}
          />
          <Select size="small" mode="multiple"
            placeholder="Category"
            value={categoryIds}
            open={categoryOpen}
            onDropdownVisibleChange={setCategoryOpen}
            onChange={(v) => { setCategoryIds(v); closeOn(v, categoryIds, setCategoryOpen); }}
            options={categoryOptions}
            optionFilterProp="label" showSearch
            allowClear maxTagCount={1}
            style={{ minWidth: 160, maxWidth: 240 }}
          />
          <Select size="small" mode="multiple"
            placeholder={categoryIds.length
              ? `Product (${productOptions.length} in category)`
              : 'Product'}
            value={productIds}
            open={productOpen}
            onDropdownVisibleChange={setProductOpen}
            onChange={(v) => { setProductIds(v); closeOn(v, productIds, setProductOpen); }}
            options={productOptions}
            optionFilterProp="label" showSearch
            allowClear maxTagCount={1}
            style={{ minWidth: 220, maxWidth: 320 }}
          />
          <Input size="small" allowClear
            placeholder="Barcode" prefix={<BarcodeOutlined />}
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            style={{ width: 150 }}
          />
          <Input size="small" allowClear
            placeholder="HSN"
            value={hsnCode}
            onChange={(e) => setHsnCode(e.target.value.replace(/[^0-9]/g, ''))}
            style={{ width: 110 }}
          />
          <Input size="small" allowClear
            ref={searchInputRef}
            placeholder="Search bill no / party…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ width: 240 }}
          />
        </Space>
      </div>

      {/* Table */}
      <div className="bo-tablewrap">
        {totalCount === 0 && !loading ? (
          <div className="bo-empty">
            {(partyIds.length || categoryIds.length || productIds.length || barcode || hsnCode || search)
              ? <>No matches — <a onClick={() => {
                  setPartyIds([]); setCategoryIds([]); setProductIds([]);
                  setBarcode(''); setHsnCode('');
                  setSearchInput(''); setSearch('');
                }}>clear filters</a></>
              : <>No items in this period.</>}
          </div>
        ) : (
          <VirtualReportTable
            columns={tableColumns}
            rows={rows}
            totalCount={totalCount}
            ensureChunk={ensureChunk}
            loading={loading}
            rowKey={(r) => r?.item_id}
            scroll={{ x: tableColumns.reduce((s, c) => s + (c.width || 100), 0) }}
            summaryCells={summaryCells}
            controlledCursorIdx={sel.cursorIdx}
            controlledSelectedSet={sel.selectedSet}
            onCursorMove={sel.setCursor}
            onShiftClickRow={sel.extendTo}
            onCtrlClickRow={sel.toggleRow}
            onRow={(row) => ({
              onDoubleClick: () => row && !row.__loading && drillBill(row),
              style: { cursor: row && !row.__loading ? 'pointer' : 'default' },
            })}
          />
        )}
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/reports') },
          { id: 'period', key: 'F2', label: 'Period',
            onAction: () => openDate({
              mode: 'range', title: 'Period',
              value: [fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null],
              onConfirm: ([from, to]) => {
                setPresetKey('custom');
                setFromDate(from.format('YYYY-MM-DD'));
                setToDate(to.format('YYYY-MM-DD'));
              },
            }) },
          { id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus?.() },
          { id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => handleRefresh() },
          { id: 'print', key: 'F9', label: 'Print',
            onAction: () => window.print() },
          { id: 'export', key: 'F10', label: 'Export',
            onAction: () => handleExportCsv() },
          { id: 'drill', key: 'F1', label: 'Open Bill', tone: 'primary',
            disabled: !single || single.__loading,
            onAction: () => single && !single.__loading && drillBill(single) },
        ]}
      />
    </div>
  );
}
