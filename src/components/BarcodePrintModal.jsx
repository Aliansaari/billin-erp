import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, Button, InputNumber, Input, Table, Checkbox, Typography,
  AutoComplete, Empty, Tooltip, message,
} from 'antd';
import {
  PrinterOutlined, SearchOutlined, DeleteOutlined,
  WarningOutlined, EyeOutlined,
} from '@ant-design/icons';
import JsBarcode from 'jsbarcode';
import { productAPI, settingsAPI } from '../api';
import './barcode-print-modal.css';

const { Text } = Typography;

const STORAGE_KEY        = 'barcode_label_layout';
const CO_NAME_KEY        = 'barcode_company_name';
// Session-only store for the per-item custom label typed in the modal.
// sessionStorage so it survives accidental closes but never leaks to the
// product master or persists past the browser session.
const CUSTOM_LABELS_KEY  = 'bpm_custom_labels';
// Printer chosen on Settings → Print. '' = system default. Silent defaults
// ON (same behaviour as sales bills) — set to '0' to use the OS dialog.
export const BARCODE_PRINTER_KEY = 'barcode_printer_name';
export const BARCODE_SILENT_KEY  = 'barcode_silent_print';

const FALLBACK_LAYOUT = {
  labelSize: '50x25',
  codeType: 'barcode',
  elements: [
    { id: 'company_name',   x: 2,  y: 1.5, fontSize: 7, bold: true,  visible: true },
    { id: 'product_name',   x: 2,  y: 5,   fontSize: 8, bold: true,  visible: true },
    { id: 'code',           x: 2,  y: 9,   fontSize: 8, bold: false, visible: true },
    { id: 'mrp',            x: 2,  y: 21,  fontSize: 7, bold: true,  visible: true },
  ],
};

// Normalise a stored design blob (localStorage cache or the DB copy) into
// the { labelSize, codeType, elements } shape the label builder wants.
// Returns null when the blob carries no usable element list.
function resolveLayout(parsed) {
  if (!parsed) return null;
  const labelSize = parsed.labelSize || '50x25';
  // Always prefer the per-size layout from layouts object — it's the most up-to-date
  const elements = parsed.layouts?.[labelSize] || parsed.elements;
  if (!Array.isArray(elements) || !elements.length) return null;
  return { ...parsed, labelSize, elements };
}

function getSavedLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const resolved = resolveLayout(JSON.parse(raw));
      if (resolved) return resolved;
    }
  } catch (_) {}
  return FALLBACK_LAYOUT;
}

// Pull the label design straight from Settings → Barcode's durable copy.
//
// The designer writes the layout to localStorage AND to the database, and
// treats the database as authoritative — localStorage is only a per-browser
// cache. So a machine that has never opened the designer (a fresh client
// install, a wiped browser store, a second counter PC) has no cache and
// would otherwise print the built-in fallback label instead of the firm's
// real design. Fetching it here keeps every print — bill labels and
// reprints alike — on the design the user actually configured, and
// refreshes the cache on the way through.
async function fetchDbLayout() {
  try {
    const { data } = await settingsAPI.getBarcode();
    const raw = data?.data?.label_layout;
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const resolved = resolveLayout(parsed);
    if (!resolved) return null;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch (_) {}
    return resolved;
  } catch (_) { return null; }
}

const mmPx = (mm, dpi = 200) => Math.round((mm / 25.4) * dpi);
const ptMm  = (pt)           => +((pt / 72) * 25.4).toFixed(3);

function xmlEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const fmtPrice = (v) => { const n = parseFloat(v); return Number.isInteger(n) ? String(n) : n.toFixed(2); };

const FIELD_VAL = {
  company_name:   (row, co, el) => {
    const val = co || ''; if (!val) return '';
    return (el?.prefix !== undefined ? el.prefix : '') + val;
  },
  product_name:   (row, co, el) => {
    const val = row.product_name || ''; if (!val) return '';
    return (el?.prefix !== undefined ? el.prefix : '') + val;
  },
  barcode_number: (row, co, el) => {
    const val = row.barcode || ''; if (!val) return '';
    return (el?.prefix !== undefined ? el.prefix : '') + val;
  },
  mrp:            (row, co, el) => {
    if (!(row.mrp > 0)) return '';
    return (el?.prefix !== undefined ? el.prefix : 'MRP ') + fmtPrice(row.mrp);
  },
  sale_rate:      (row, co, el) => {
    if (!(row.sale_rate > 0)) return '';
    return (el?.prefix !== undefined ? el.prefix : 'Rate: Rs.') + fmtPrice(row.sale_rate);
  },
  size:           (row, co, el) => {
    if (!row.size) return '';
    return (el?.prefix !== undefined ? el.prefix : 'Size: ') + row.size;
  },
  article_number: (row, co, el) => {
    if (!row.article_number) return '';
    return (el?.prefix !== undefined ? el.prefix : 'Art: ') + row.article_number;
  },
  qty_per_box: (row, co, el) => {
    const val = parseFloat(row.quantity_per_box);
    if (!val || val <= 0) return '';
    return (el?.prefix !== undefined ? el.prefix : 'Qty: ') + val;
  },
  rate_barcode: (row, co, el) => {
    const rate = parseFloat(row.sale_rate);
    const bc = row.barcode || '';
    if (!rate && !bc) return '';
    const rateStr = rate ? (Number.isInteger(rate) ? String(rate) : rate.toFixed(2)) : '0';
    return (el?.prefix !== undefined ? el.prefix : 'Rate: Rs.') + rateStr + '-' + bc;
  },
  // Print-only custom label — typed per item in the barcode modal.
  // Never stored on the product. Empty value → element is hidden on print.
  custom_label: (row, co, el) => {
    const val = row.custom_label || ''; if (!val) return '';
    return (el?.prefix !== undefined ? el.prefix : '') + val;
  },
};

// ── Generate a crisp, dark barcode PNG data URL ───────────────────────────────
// Why the old labels printed faint/faded and wouldn't scan: the barcode was
// rasterised to a SMALL canvas and then UPSCALED to the label width with image
// smoothing ON — that turns every crisp black/white bar edge into a grey
// gradient, so thin bars wash out. Fix:
//   1. Render the barcode once (crisp black on white).
//   2. Upscale it to a HIGH resolution with smoothing OFF (nearest-neighbour),
//      so every bar stays 100% solid black — no grey, no fade.
//   3. Let the label SVG SHRINK that high-res image to fit (down-scaling is
//      clean; it's only up-scaling thin bars that fades them).
// The result is a bold, solid barcode that any scanner reads, at a shorter
// height (scanners don't need tall bars).
export function makeBarcodeDataUrl(value) {
  try {
    const src = document.createElement('canvas');
    JsBarcode(src, String(value), {
      format:       'CODE128',
      width:        2,          // module ratio; final X-dimension = label width ÷ modules
      height:       56,         // short bars
      displayValue: true,
      fontSize:     16,
      fontOptions:  'bold',
      textMargin:   1,
      margin:       6,
      background:   '#ffffff',
      lineColor:    '#000000',
    });
    // Upscale to ≥ ~1400px wide with NO smoothing so bars stay razor-sharp.
    const scale = Math.max(1, Math.ceil(1400 / Math.max(1, src.width)));
    const out = document.createElement('canvas');
    out.width  = src.width  * scale;
    out.height = src.height * scale;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  } catch (_) { return ''; }
}

// ── Generate QR PNG data URL ──────────────────────────────────────────────────
async function makeQRDataUrl(value, sizePx) {
  try {
    const QRCode = await import('qrcode');
    return await QRCode.toDataURL(String(value), {
      width:  sizePx,
      margin: 1,
      color:  { dark: '#000000', light: '#ffffff' },
    });
  } catch (_) { return ''; }
}

// ── Build the code (barcode / QR) image box for one row ──────────────────────
// Shared by the printer and the live preview so what you see on screen is
// pixel-for-pixel what lands on the label.
async function buildCodeImage(row, layout) {
  const { labelSize = '50x25', codeType = 'barcode', elements = [] } = layout;
  const [wMm, hMm] = labelSize.split('x').map(Number);
  const codeEl = elements.find(e => e.id === 'code' && e.visible);
  if (!codeEl || !row?.barcode) return null;

  const availW   = +(wMm - codeEl.x - 1).toFixed(1);
  const availH   = +(hMm - codeEl.y - 1).toFixed(1);
  const userSize = codeEl.size || null;

  if (codeType === 'qrcode') {
    // Use user-defined size; fall back to available square space.
    const qrMm = Math.max(5, userSize || Math.min(availW, availH));
    return { dataUrl: await makeQRDataUrl(row.barcode, mmPx(qrMm, 300)), wMm: qrMm, hMm: qrMm };
  }
  // Width fills the available label width (widest bars = easiest to scan);
  // height is the user's size or a short default.
  return {
    dataUrl: makeBarcodeDataUrl(row.barcode),
    wMm: Math.max(10, availW),
    hMm: Math.max(5, userSize || Math.min(availH, hMm * 0.4)),
    // Stretch the 1D barcode to fill the label width → the widest, boldest
    // bars (best scannability). QR stays square (meet).
    par: 'none',
  };
}

// ── Build SVG label string — all coordinates in mm ───────────────────────────
function buildLabelSVG(row, companyName, layout, codeImg) {
  const { labelSize = '50x25', elements = [] } = layout;
  const [wMm, hMm] = labelSize.split('x').map(Number);

  const codeEl = elements.find(e => e.id === 'code' && e.visible);

  let body = '';

  // Code image (drawn first = bottom layer)
  if (codeEl && codeImg?.dataUrl) {
    body += `<image href="${codeImg.dataUrl}"
      x="${codeEl.x}" y="${codeEl.y}"
      width="${codeImg.wMm}" height="${codeImg.hMm}"
      preserveAspectRatio="${codeImg.par || 'xMinYMin meet'}"/>`;
  }

  // Text elements (drawn last = top layer, always visible)
  for (const el of elements) {
    if (!el.visible || el.id === 'code') continue;
    const fn  = FIELD_VAL[el.id];
    if (!fn) continue;
    const val = fn(row, companyName, el);
    if (!val) continue;

    const fsMm = +(ptMm(el.fontSize || 7) * 1.15).toFixed(3); // 15% boost for print clarity
    body += `<text
      x="${el.x}"
      y="${+(el.y + fsMm).toFixed(3)}"
      font-size="${fsMm}"
      font-family="Arial,Helvetica,sans-serif"
      font-weight="${el.bold ? 'bold' : '600'}"
      text-rendering="geometricPrecision"
      fill="#000000">${xmlEsc(val)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
    viewBox="0 0 ${wMm} ${hMm}" width="${wMm}mm" height="${hMm}mm"
    style="display:block;background:#fff;">${body}</svg>`;
}

// Wrap one-or-more label SVGs into a printable HTML document.
function wrapLabelsHTML(svgs, wMm, hMm) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size:${wMm}mm ${hMm}mm; margin:0; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#fff; }
  .pg { width:${wMm}mm; height:${hMm}mm; overflow:hidden;
        page-break-after:always; break-after:page; }
  .pg:last-child { page-break-after:avoid; break-after:avoid; }
  svg { display:block; }
</style></head>
<body>${svgs.map(svg => `<div class="pg">${svg}</div>`).join('')}</body></html>`;
}

// Send finished label HTML to the printer. When running in Electron with
// silent enabled, it direct-prints through the configured barcode printer
// — the exact same path the sales bills use (services/printer.js →
// electronAPI.printSilent). Otherwise it falls back to the browser dialog.
export async function printLabelHTML(html, wMm, hMm) {
  const deviceName = (localStorage.getItem(BARCODE_PRINTER_KEY) || '').trim();
  const silent     = localStorage.getItem(BARCODE_SILENT_KEY) !== '0'; // default ON

  if (silent && window.electronAPI?.printSilent) {
    const res = await window.electronAPI.printSilent({
      html,
      deviceName: deviceName || undefined,
      copies: 1, // copy count is already expanded into N physical pages
      paperWidthMm: wMm,
      paperHeightMm: hMm,
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    if (res?.error) { message.error('Print failed: ' + res.error); return; }
    if (res?.success === false) { message.warning('Print cancelled: ' + (res.failureReason || 'unknown')); return; }
    message.success('Sent to printer');
    return;
  }

  // Non-Electron / silent-off fallback — the OS print dialog.
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;border:none;visibility:hidden;';
  document.body.appendChild(iframe);
  iframe.contentDocument.open();
  iframe.contentDocument.write(html);
  iframe.contentDocument.close();
  setTimeout(() => {
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (_) {}
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }, 500);
}

// Map a product row (from /api/products) onto the shape this modal prints.
// Exported so list pages can hand over their selection without knowing the
// modal's internals.
export function productToItem(p) {
  return {
    key:               `p-${p.product_id}`,
    product_id:        p.product_id,
    barcode:           p.barcode || '',
    product_name:      p.product_name || '',
    article_number:    p.article_number || '',
    size:              [p.size_value, p.size_unit].filter(Boolean).join(' ').trim(),
    mrp:               p.mrp,
    sale_rate:         p.sale_rate,
    purchase_rate:     p.purchase_rate,
    margin_percentage: p.margin_percentage,
    quantity:          p.current_stock,
    quantity_per_box:  parseFloat(p.quantity_per_box) || 1,
  };
}

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function BarcodePrintModal({
  visible, onClose, billNumber, items, initialCompany = '',
  // 'bill'    — labels for the items just purchased. Default label count
  //             is the number of boxes (qty ÷ qty-per-box).
  // 'reprint' — reprint labels for products already in the catalogue (a
  //             worn, torn or lost label). Default count is 1, the list
  //             is editable (search-and-add, remove) and a live preview
  //             of the label is shown so no label stock is wasted.
  mode = 'bill',
}) {
  const isReprint = mode === 'reprint';

  const [rows, setRows]               = useState([]);
  const [companyName, setCompanyName] = useState(() => localStorage.getItem(CO_NAME_KEY) || initialCompany);
  const [printing, setPrinting]       = useState(false);
  const [layout, setLayout]           = useState(FALLBACK_LAYOUT);
  const [activeCell, setActiveCell]   = useState({ row: 0, col: 0 }); // col: 0=custom_label, 1=no_of_prints

  /* ── Reprint-only state ────────────────────────────────────────────
     Search-and-add box (find any product by name / barcode / article and
     drop it straight into the print list) + the live label preview. */
  const [addQuery, setAddQuery]   = useState('');
  const [addOpts, setAddOpts]     = useState([]);
  const [searching, setSearching] = useState(false);
  const [bulkCount, setBulkCount] = useState(1);
  const [preview, setPreview]     = useState({ svg: '', wMm: 0, hMm: 0 });
  const addRef = useRef(null);

  // Re-read the label design + company name every time the modal opens.
  // The cached design paints first (instant, no flicker), then the durable
  // copy from Settings → Barcode replaces it if this machine's cache is
  // missing or stale.
  useEffect(() => {
    if (!visible) return;
    setLayout(getSavedLayout());
    const saved = localStorage.getItem(CO_NAME_KEY);
    setCompanyName(saved !== null ? saved : initialCompany);

    let cancelled = false;
    fetchDbLayout().then(fresh => { if (fresh && !cancelled) setLayout(fresh); });
    return () => { cancelled = true; };
  }, [visible]);

  // One table row from a product / bill item. Bill mode defaults the label
  // count to the number of boxes; reprint mode defaults to a single label
  // (you're replacing one that went bad, not labelling a whole carton).
  const makeRow = (item, savedLabels = {}) => {
    const qpb = parseFloat(item.quantity_per_box) || 1;
    const qty = parseFloat(item.quantity) || 0;
    const key = item.key || item.barcode || `row-${Math.random().toString(36).slice(2)}`;
    return {
      ...item, key, quantity_per_box: qpb,
      no_of_prints: isReprint ? 1 : Math.ceil(qty / qpb),
      // A product with no barcode has nothing to print — it stays in the
      // list (so the operator can see why) but can't be selected.
      selected: !!item.barcode,
      // Draft labels are stored under the row key; older sessions stored
      // them under the raw barcode, so both are honoured on restore.
      custom_label: savedLabels[key] || savedLabels[item.barcode] || '',
    };
  };

  const handleCompanyChange = (e) => {
    setCompanyName(e.target.value);
    localStorage.setItem(CO_NAME_KEY, e.target.value);
  };

  useEffect(() => {
    if (!visible || !items?.length) return;
    // Restore any custom labels typed in a previous open of this session
    const savedLabels = (() => {
      try { return JSON.parse(sessionStorage.getItem(CUSTOM_LABELS_KEY) || '{}'); } catch { return {}; }
    })();
    setRows(items.map(item => makeRow(item, savedLabels)));
    setActiveCell({ row: 0, col: 0 });
  }, [visible, items]);

  // In reprint mode the list starts from the selection but is meant to be
  // built up in the modal, so an empty open is a normal state — focus the
  // search box so the operator can start typing straight away.
  useEffect(() => {
    if (!visible || !isReprint) return;
    const t = setTimeout(() => addRef.current?.focus(), 180);
    return () => clearTimeout(t);
  }, [visible, isReprint]);

  // Reprint mode opens fresh every time — a stale query from last time is
  // noise, not a shortcut.
  useEffect(() => { if (!visible) { setAddQuery(''); setAddOpts([]); } }, [visible]);

  // Keyed by the row's stable `key` (barcode for bill items, product id for
  // reprints) so products that have no barcode yet don't collide on ''.
  const updateRow = (rowKey, field, value) => {
    setRows(prev => prev.map(r => r.key === rowKey ? { ...r, [field]: value } : r));
    // Persist custom labels to sessionStorage so they survive accidental modal closes
    if (field === 'custom_label') {
      try {
        const saved = JSON.parse(sessionStorage.getItem(CUSTOM_LABELS_KEY) || '{}');
        if (value) saved[rowKey] = value; else delete saved[rowKey];
        sessionStorage.setItem(CUSTOM_LABELS_KEY, JSON.stringify(saved));
      } catch {}
    }
  };

  const removeRow = (rowKey) => {
    const nextLen = rows.filter(r => r.key !== rowKey).length;
    setRows(prev => prev.filter(r => r.key !== rowKey));
    setActiveCell(c => ({ ...c, row: Math.max(0, Math.min(c.row, nextLen - 1)) }));
  };

  // Apply one label count to every selected row — the common reprint case
  // ("give me two of each of these six").
  const applyToAll = (n) => {
    const v = Math.max(0, Math.min(9999, parseInt(n, 10) || 0));
    setRows(prev => prev.map(r => (r.selected && r.barcode) ? { ...r, no_of_prints: v } : r));
  };
  // Rows with no barcode are never printable, so they're excluded from
  // "select all" and from the "all selected?" test (otherwise the button
  // would sit permanently on "Select all" and never flip).
  const printableRows = rows.filter(r => r.barcode);
  const allSelected   = printableRows.length > 0 && printableRows.every(r => r.selected);
  const toggleAll     = () => setRows(prev => prev.map(r => ({ ...r, selected: r.barcode ? !allSelected : false })));
  const selectedCount = rows.filter(r => r.selected).length;
  const totalLabels   = rows.filter(r => r.selected).reduce((s, r) => s + (r.no_of_prints || 0), 0);
  const missingCount  = rows.length - printableRows.length;

  /* ── Search-and-add (reprint mode) ──────────────────────────────────
     Type any part of a product name, barcode or article number; pick a
     hit and it drops into the print list. Products already in the list
     are filtered out so you can't queue the same SKU twice by accident. */
  // Row keys live in a ref so editing a label or a count doesn't re-fire
  // the debounced search (the effect only ever reads the set).
  const rowKeysRef = useRef(new Set());
  useEffect(() => { rowKeysRef.current = new Set(rows.map(r => r.key)); }, [rows]);

  useEffect(() => {
    if (!visible || !isReprint) return;
    const q = addQuery.trim();
    if (q.length < 2) { setAddOpts([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await productAPI.search(q, { limit: 25 });
        if (cancelled) return;
        const list = data?.data || data || [];
        const have = rowKeysRef.current;
        setAddOpts(list
          .filter(p => !have.has(`p-${p.product_id}`))
          .map(p => ({
            value: `p-${p.product_id}`,
            product: p,
            label: (
              <div className="bpm-opt">
                <div className="bpm-opt__main">
                  <span className="bpm-opt__name">{p.product_name}</span>
                  {p.size_value ? <span className="bpm-opt__meta">{p.size_value}{p.size_unit ? ` ${p.size_unit}` : ''}</span> : null}
                  {p.article_number ? <span className="bpm-opt__meta">Art {p.article_number}</span> : null}
                </div>
                <span className={`bpm-opt__bc${p.barcode ? '' : ' bpm-opt__bc--none'}`}>
                  {p.barcode || 'no barcode'}
                </span>
              </div>
            ),
          })));
      } catch { if (!cancelled) setAddOpts([]); }
      finally { if (!cancelled) setSearching(false); }
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [addQuery, visible, isReprint]);

  const addProduct = (_val, opt) => {
    const p = opt?.product;
    if (!p) return;
    if (!p.barcode) { message.warning(`"${p.product_name}" has no barcode yet — add one from Products → Edit.`); return; }
    const savedLabels = (() => {
      try { return JSON.parse(sessionStorage.getItem(CUSTOM_LABELS_KEY) || '{}'); } catch { return {}; }
    })();
    if (rows.some(r => r.key === `p-${p.product_id}`)) { setAddQuery(''); setAddOpts([]); return; }
    setRows(prev => prev.some(r => r.key === `p-${p.product_id}`)
      ? prev
      : [...prev, makeRow(productToItem(p), savedLabels)]);
    // Land the cursor on the new row's label count — the one field the
    // operator almost always wants to touch next.
    setActiveCell({ row: rows.length, col: 1 });
    setAddQuery('');
    setAddOpts([]);
  };

  /* ── Live label preview ─────────────────────────────────────────────
     Renders the cursored row through the exact same SVG builder the
     printer uses, so the operator sees the real label — brand line,
     custom text, barcode, price — before a single sticker is spent. */
  useEffect(() => {
    if (!visible || !isReprint) return;
    const row = rows[activeCell.row] || rows.find(r => r.selected) || rows[0];
    if (!row) { setPreview({ svg: '', wMm: 0, hMm: 0 }); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const [wMm, hMm] = (layout.labelSize || '50x25').split('x').map(Number);
        const codeImg = await buildCodeImage(row, layout);
        if (cancelled) return;
        setPreview({ svg: buildLabelSVG(row, companyName, layout, codeImg), wMm, hMm });
      } catch { if (!cancelled) setPreview({ svg: '', wMm: 0, hMm: 0 }); }
    }, 140);
    return () => { cancelled = true; clearTimeout(t); };
  }, [visible, isReprint, rows, activeCell.row, layout, companyName]);

  const handlePrint = async () => {
    const selected = rows.filter(r => r.selected && r.barcode && r.no_of_prints > 0);
    if (!selected.length) { message.warning('Select at least one item to print'); return; }

    setPrinting(true);
    try {
      const [wMm, hMm] = (layout.labelSize || '50x25').split('x').map(Number);

      // Per-barcode code image cache: { dataUrl, wMm, hMm }
      const codeCache = {};
      for (const row of selected) {
        if (codeCache[row.barcode]) continue;
        codeCache[row.barcode] = await buildCodeImage(row, layout);
      }

      // Build SVG strings (one per label copy)
      const svgs = [];
      selected.forEach(row => {
        const svg = buildLabelSVG(row, companyName, layout, codeCache[row.barcode]);
        for (let i = 0; i < row.no_of_prints; i++) svgs.push(svg);
      });

      await printLabelHTML(wrapLabelsHTML(svgs, wMm, hMm), wMm, hMm);

    } catch (e) {
      message.error('Print failed: ' + e.message);
    } finally {
      setPrinting(false);
    }
  };

  const fmt = (v) => fmtPrice(v || 0);
  // Margin %: prefer the stored value; otherwise derive from cost vs sale.
  const marginPct = (r) => {
    const stored = parseFloat(r.margin_percentage || 0);
    if (stored) return stored;
    const pr = parseFloat(r.purchase_rate || 0);
    const sr = parseFloat(r.sale_rate || 0);
    return pr > 0 ? ((sr - pr) / pr) * 100 : 0;
  };

  const toggleRow = (idx) =>
    setRows(prev => prev.map((r, j) => (j === idx && r.barcode) ? { ...r, selected: !r.selected } : r));

  // ── Cell keyboard handler — shared by both editable columns ──────────
  // The inputs are always rendered (borderless); this just moves the
  // active cell.  The focusCell effect auto-focuses the new target.
  const cellKeyDown = (e, col) => {
    const k = e.key;
    if (k === 'Enter') {
      e.preventDefault();
      setActiveCell(prev => ({ ...prev, row: Math.min(prev.row + 1, rows.length - 1) }));
    } else if (k === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      document.activeElement?.blur();
    } else if (k === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        if (col > 0) setActiveCell(prev => ({ ...prev, col: col - 1 }));
        else setActiveCell(prev => ({ row: Math.max(prev.row - 1, 0), col: 1 }));
      } else {
        if (col < 1) setActiveCell(prev => ({ ...prev, col: col + 1 }));
        else setActiveCell(prev => ({ row: Math.min(prev.row + 1, rows.length - 1), col: 0 }));
      }
    } else if (k === 'ArrowDown') {
      e.preventDefault();
      setActiveCell(prev => ({ ...prev, row: Math.min(prev.row + 1, rows.length - 1) }));
    } else if (k === 'ArrowUp') {
      e.preventDefault();
      setActiveCell(prev => ({ ...prev, row: Math.max(prev.row - 1, 0) }));
    }
  };

  // Keyboard control. Mirrors the app's conventions: F1 = primary action
  // (Print), Ctrl/Cmd+Enter = its alias, F2 = the bulk toggle, ↑/↓ = row
  // cursor, Space = toggle the cursored row, Esc = close (handled by AntD).
  // Latest state/handlers kept in a ref so the listener never goes stale
  // without re-binding (same trick ActionStrip uses).
  const kbRef = useRef({});
  kbRef.current = { rows, activeCell, printing, totalLabels, handlePrint, toggleAll };

  // Auto-focus the active cell's input whenever activeCell changes
  const prevCell = useRef(activeCell);
  useEffect(() => {
    if (prevCell.current.row === activeCell.row && prevCell.current.col === activeCell.col) return;
    prevCell.current = activeCell;
    requestAnimationFrame(() => {
      const el = document.querySelector(`.bpm-modal [data-cell="${activeCell.row}-${activeCell.col}"] input`);
      if (el) { el.focus(); el.select(); }
    });
  });

  useEffect(() => {
    if (!visible) return;
    const onKey = (e) => {
      const S = kbRef.current;
      const k = e.key;
      // Print — F1 or Ctrl/Cmd+Enter
      if (k === 'F1' || ((e.ctrlKey || e.metaKey) && k === 'Enter')) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!S.printing && S.totalLabels > 0) S.handlePrint();
        return;
      }
      // Select all / Deselect all — F2
      if (k === 'F2') {
        e.preventDefault(); e.stopImmediatePropagation();
        S.toggleAll();
        return;
      }
      // Skip while typing in non-cell inputs (brand input at the top)
      const ae = document.activeElement;
      if (ae?.closest?.('.bpm-toolbar')) return;
      // Cell inputs handle their own keys via cellKeyDown — only handle
      // navigation keys that the cell handler doesn't cover (left/right
      // between columns, Space for toggle, Tab when nothing is focused).
      const inCell = ae?.closest?.('[data-cell]');
      if (!inCell) {
        // Nothing focused — full navigation
        if (k === 'ArrowDown') {
          e.preventDefault(); e.stopImmediatePropagation();
          setActiveCell(prev => ({ ...prev, row: Math.min(prev.row + 1, S.rows.length - 1) }));
        } else if (k === 'ArrowUp') {
          e.preventDefault(); e.stopImmediatePropagation();
          setActiveCell(prev => ({ ...prev, row: Math.max(prev.row - 1, 0) }));
        } else if (k === 'ArrowRight') {
          e.preventDefault(); e.stopImmediatePropagation();
          setActiveCell(prev => ({ ...prev, col: Math.min(prev.col + 1, 1) }));
        } else if (k === 'ArrowLeft') {
          e.preventDefault(); e.stopImmediatePropagation();
          setActiveCell(prev => ({ ...prev, col: Math.max(prev.col - 1, 0) }));
        } else if (k === 'Tab') {
          e.preventDefault(); e.stopImmediatePropagation();
          if (e.shiftKey) {
            setActiveCell(prev => {
              if (prev.col > 0) return { ...prev, col: prev.col - 1 };
              return { row: Math.max(prev.row - 1, 0), col: 1 };
            });
          } else {
            setActiveCell(prev => {
              if (prev.col < 1) return { ...prev, col: prev.col + 1 };
              return { row: Math.min(prev.row + 1, S.rows.length - 1), col: 0 };
            });
          }
        } else if (k === ' ' || k === 'Spacebar') {
          e.preventDefault(); e.stopImmediatePropagation();
          toggleRow(S.activeCell.row);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible]);

  const colBarcode = {
    title: 'Barcode', dataIndex: 'barcode', width: 116,
    render: (v) => v
      ? <span className="bpm-bc">{v}</span>
      : <Tooltip title="This product has no barcode yet. Add one from Products → Edit, then reprint.">
          <span className="bpm-bc bpm-bc--none"><WarningOutlined /> None</span>
        </Tooltip>,
  };
  const colProduct = { title: 'Product', dataIndex: 'product_name', ellipsis: true,
    render: v => v ? <Text strong>{v}</Text> : <Text type="secondary">—</Text> };
  const colArticle = { title: 'Article', dataIndex: 'article_number', width: 96, ellipsis: true,
    render: v => v ? <Text>{v}</Text> : <Text type="secondary">—</Text> };
  const colSize = { title: 'Size', dataIndex: 'size', width: 62, align: 'center',
    render: v => v ? <Text>{v}</Text> : <Text type="secondary">—</Text> };
  const colCustom = {
    title: 'Custom label', dataIndex: 'custom_label', width: 120,
    render: (v, record, idx) => (
      <div className={`bpm-cell${activeCell.row === idx && activeCell.col === 0 ? ' bpm-cell--focused' : ''}`}
        data-cell={`${idx}-0`}
        onClick={e => { e.stopPropagation(); setActiveCell({ row: idx, col: 0 }); }}>
        <Input size="small" value={v || ''} placeholder="—"
          variant="borderless"
          onChange={e => updateRow(record.key, 'custom_label', e.target.value)}
          onKeyDown={e => cellKeyDown(e, 0)}
          className="bpm-cell-input" />
      </div>
    ),
  };
  const colLabels = {
    title: 'Labels', dataIndex: 'no_of_prints', width: 90, align: 'center',
    render: (v, record, idx) => (
      <div className={`bpm-cell bpm-cell--num${activeCell.row === idx && activeCell.col === 1 ? ' bpm-cell--focused' : ''}`}
        data-cell={`${idx}-1`}
        onClick={e => { e.stopPropagation(); setActiveCell({ row: idx, col: 1 }); }}>
        <InputNumber min={0} max={9999} value={v} keyboard={false}
          variant="borderless" disabled={!record.barcode}
          onChange={val => updateRow(record.key, 'no_of_prints', val || 0)}
          onKeyDown={e => cellKeyDown(e, 1)}
          className="bpm-cell-input" size="small" />
      </div>
    ),
  };
  const colPrint = {
    title: 'Print', dataIndex: '__print', width: 56, align: 'center',
    render: (_, record) => (
      <Checkbox checked={record.selected} disabled={!record.barcode}
        onChange={e => updateRow(record.key, 'selected', e.target.checked)} />
    ),
  };
  const money = (title, key, opts = {}) => ({
    title, dataIndex: key, width: opts.width || 80, align: 'right',
    render: v => <Text type={opts.muted ? 'secondary' : undefined} className="bpm-num">{fmt(v)}</Text>,
  });

  // Reprint mode drops the purchase-side numbers (pieces / per box / cost /
  // margin) — none of them matter when you are replacing a worn sticker —
  // and spends the width on the live preview instead.
  const columns = isReprint
    ? [
        colBarcode, colProduct, colArticle, colSize, colCustom,
        { title: 'Stock', dataIndex: 'quantity', width: 70, align: 'right',
          render: v => <Text type="secondary" className="bpm-num">{fmtPrice(v || 0)}</Text> },
        money('MRP', 'mrp', { width: 76 }),
        money('Sale rate', 'sale_rate', { width: 84, muted: true }),
        colLabels, colPrint,
        { title: '', dataIndex: '__rm', width: 40, align: 'center',
          render: (_, record) => (
            <Tooltip title="Remove from this print run">
              <button type="button" className="bpm-rm"
                onClick={e => { e.stopPropagation(); removeRow(record.key); }}>
                <DeleteOutlined />
              </button>
            </Tooltip>
          ) },
      ]
    : [
        colBarcode, colProduct, colArticle, colCustom, colSize,
        { title: 'Pieces', dataIndex: 'quantity', width: 64, align: 'right',
          render: v => <Text strong className="bpm-num">{v}</Text> },
        { title: 'Per box', dataIndex: 'quantity_per_box', width: 64, align: 'right',
          render: v => <Text type="secondary" className="bpm-num">{v}</Text> },
        money('Pur rate', 'purchase_rate'),
        { title: 'Margin', dataIndex: 'margin_percentage', width: 74, align: 'right',
          render: (_, r) => {
            const m = marginPct(r);
            return <Text className="bpm-num" type={m < 0 ? 'danger' : undefined}>
              {m ? `${m.toFixed(1)}%` : '—'}
            </Text>;
          } },
        money('MRP', 'mrp', { width: 76 }),
        money('Sale rate', 'sale_rate', { width: 82, muted: true }),
        colLabels, colPrint,
      ];

  /* ── Toolbar pieces ────────────────────────────────── */
  const addBox = (
    <div className="bpm-field bpm-field--add">
      <label className="bpm-field__lbl" htmlFor="bpm-add">Add product to this run</label>
      <AutoComplete
        id="bpm-add"
        ref={addRef}
        value={addQuery}
        options={addOpts}
        onChange={setAddQuery}
        onSelect={addProduct}
        classNames={{ popup: { root: 'bpm-add-pop' } }}
        notFoundContent={
          addQuery.trim().length < 2 ? null
            : searching ? <span className="bpm-hint">Searching…</span>
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No match" />
        }
      >
        <Input prefix={<SearchOutlined />} allowClear
          placeholder="Search name, barcode or article number…" />
      </AutoComplete>
    </div>
  );

  const bulkBox = (
    <div className="bpm-field bpm-field--bulk">
      <label className="bpm-field__lbl">Labels per item</label>
      <div className="bpm-bulk">
        {[1, 2, 5, 10].map(n => (
          <button key={n} type="button" className="bpm-preset"
            onClick={() => { setBulkCount(n); applyToAll(n); }}>{n}</button>
        ))}
        <InputNumber min={0} max={9999} size="small" value={bulkCount} keyboard={false}
          onChange={v => setBulkCount(v || 0)}
          onPressEnter={() => applyToAll(bulkCount)}
          className="bpm-bulk__num" />
        <Button size="small" onClick={() => applyToAll(bulkCount)}>Apply to all</Button>
      </div>
    </div>
  );

  const previewPane = (
    <aside className="bpm-preview">
      <div className="bpm-preview__hd">
        <EyeOutlined /> Live preview
        <span className="bpm-preview__size">{layout.labelSize || '50x25'} mm</span>
      </div>
      <div className="bpm-preview__stage">
        {preview.svg
          ? <div className="bpm-preview__label"
              style={{ aspectRatio: `${preview.wMm} / ${preview.hMm}` }}
              dangerouslySetInnerHTML={{ __html: preview.svg }} />
          : <div className="bpm-preview__none">
              {rows.length ? 'Select a row to preview its label' : 'Add a product to see its label'}
            </div>}
      </div>
      <p className="bpm-preview__note">
        This is exactly what the printer receives. Change the label size, fields
        or layout in <b>Settings &rarr; Barcode</b>.
      </p>
    </aside>
  );

  const tableBlock = (
    <div className="bpm-table-wrap">
      <Table
        columns={columns}
        dataSource={rows}
        rowKey="key"
        pagination={false}
        size="small"
        tableLayout="fixed"
        onRow={(_, idx) => ({ onClick: () => setActiveCell(prev => ({ ...prev, row: idx })) })}
        rowClassName={(r, idx) =>
          `bpm-row${r.selected ? '' : ' bpm-row--off'}${idx === activeCell.row ? ' bpm-row--active' : ''}`}
      />
    </div>
  );

  return (
    <Modal
      className={`bpm-modal${isReprint ? ' bpm-modal--reprint' : ''}`}
      open={visible}
      onCancel={onClose}
      width={isReprint ? 1320 : 1240}
      title={
        <div className="bpm-head">
          <span className="bpm-head__icon"><PrinterOutlined /></span>
          <span className="bpm-head__title">
            {isReprint ? 'Reprint Barcode Labels' : 'Print Barcode Labels'}
            {billNumber ? <span className="bpm-head__bill">&nbsp;&middot;&nbsp;{billNumber}</span> : null}
          </span>
          {totalLabels > 0 ? (
            <span className="bpm-chip">{totalLabels} label{totalLabels === 1 ? '' : 's'}</span>
          ) : null}
          {isReprint ? (
            <span className="bpm-head__sub">
              Replace a worn, torn or missing sticker &mdash; nothing in the product record changes.
            </span>
          ) : null}
        </div>
      }
      footer={
        <div className="bpm-foot">
          <span className="bpm-foot__sum">
            <b>{totalLabels}</b> label{totalLabels === 1 ? '' : 's'} across <b>{selectedCount}</b> item{selectedCount === 1 ? '' : 's'}
            {missingCount > 0 ? (
              <span className="bpm-foot__warn">
                &nbsp;&middot;&nbsp;<WarningOutlined /> {missingCount} item{missingCount === 1 ? '' : 's'} without a barcode skipped
              </span>
            ) : null}
          </span>
          <div className="bpm-foot__btns">
            <Button onClick={onClose}>
              <span className="bpm-kbd">Esc</span>Cancel
            </Button>
            <Button type="primary" icon={<PrinterOutlined />} onClick={handlePrint}
              loading={printing} disabled={totalLabels === 0}>
              <span className="bpm-kbd">F1</span>{printing ? 'Preparing…' : 'Print'}
            </Button>
          </div>
        </div>
      }
    >
      {isReprint ? (
        <>
          <div className="bpm-toolbar">
            {addBox}
            {bulkBox}
            <div className="bpm-field bpm-field--brand">
              <label className="bpm-field__lbl" htmlFor="bpm-company">Brand / company on label</label>
              <Input id="bpm-company" placeholder="e.g. Sabina Traders"
                value={companyName} onChange={handleCompanyChange} allowClear />
            </div>
            <Button className="bpm-toolbar__all" onClick={toggleAll} disabled={!printableRows.length}>
              <span className="bpm-kbd">F2</span>{allSelected ? 'Deselect all' : 'Select all'}
            </Button>
          </div>

          <div className="bpm-body">
            <div className="bpm-body__main">
              {rows.length === 0 ? (
                <div className="bpm-empty">
                  <div className="bpm-empty__icon"><SearchOutlined /></div>
                  <div className="bpm-empty__title">Nothing queued yet</div>
                  <div className="bpm-empty__hint">
                    Search above by product name, barcode or article number to add the
                    items whose labels need reprinting. Or pick rows on the Products
                    screen first and press F7.
                  </div>
                </div>
              ) : tableBlock}
            </div>
            {previewPane}
          </div>
        </>
      ) : rows.length === 0 ? (
        <div className="bpm-empty">
          <div className="bpm-empty__title">No printable items in this bill.</div>
        </div>
      ) : (
        <>
          <div className="bpm-toolbar">
            <div className="bpm-field">
              <label className="bpm-field__lbl" htmlFor="bpm-company">Brand / company on label</label>
              <Input id="bpm-company" placeholder="e.g. Sabina Traders"
                value={companyName} onChange={handleCompanyChange} allowClear />
            </div>
            <div className="bpm-toolbar__spacer" />
            <Button onClick={toggleAll}>
              <span className="bpm-kbd">F2</span>{allSelected ? 'Deselect all' : 'Select all'}
            </Button>
          </div>
          {tableBlock}
        </>
      )}
    </Modal>
  );
}
