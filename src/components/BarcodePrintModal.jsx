import React, { useEffect, useRef, useState } from 'react';
import { Modal, Button, InputNumber, Input, Table, Checkbox, Typography, message } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import JsBarcode from 'jsbarcode';
import './barcode-print-modal.css';

const { Text } = Typography;

const STORAGE_KEY    = 'barcode_label_layout';
const CO_NAME_KEY    = 'barcode_company_name';
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

function getSavedLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed) {
        const labelSize = parsed.labelSize || '50x25';
        // Always prefer the per-size layout from layouts object — it's the most up-to-date
        const elements = parsed.layouts?.[labelSize] || parsed.elements || FALLBACK_LAYOUT.elements;
        return { ...parsed, labelSize, elements };
      }
    }
  } catch (_) {}
  return FALLBACK_LAYOUT;
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
};

// ── Generate barcode PNG data URL ─────────────────────────────────────────────
function makeBarcodeDataUrl(value, widthPx, heightPx) {
  try {
    const canvas = document.createElement('canvas');
    JsBarcode(canvas, String(value), {
      format:       'CODE128',
      width:        2,
      height:       Math.max(20, heightPx - 16),
      displayValue: true,
      fontSize:     12,
      margin:       5,
      background:   '#ffffff',
      lineColor:    '#000000',
    });
    // Scale the generated canvas to exact requested width
    const out = document.createElement('canvas');
    out.width  = widthPx;
    out.height = canvas.height + 16; // bars + text
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
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
      preserveAspectRatio="xMinYMin meet"/>`;
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

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function BarcodePrintModal({ visible, onClose, billNumber, items, initialCompany = '' }) {
  const [rows, setRows]               = useState([]);
  const [companyName, setCompanyName] = useState(() => localStorage.getItem(CO_NAME_KEY) || initialCompany);
  const [printing, setPrinting]       = useState(false);
  const [layout, setLayout]           = useState(FALLBACK_LAYOUT);
  const [activeIdx, setActiveIdx]     = useState(0);   // keyboard row cursor

  // Re-read layout + company name from localStorage every time modal opens
  useEffect(() => {
    if (visible) {
      setLayout(getSavedLayout());
      const saved = localStorage.getItem(CO_NAME_KEY);
      setCompanyName(saved !== null ? saved : initialCompany);
    }
  }, [visible]);

  const handleCompanyChange = (e) => {
    setCompanyName(e.target.value);
    localStorage.setItem(CO_NAME_KEY, e.target.value);
  };

  useEffect(() => {
    if (!visible || !items?.length) return;
    setRows(items.map(item => {
      const qpb = parseFloat(item.quantity_per_box) || 1;
      const qty = parseFloat(item.quantity) || 0;
      return { ...item, key: item.barcode, quantity_per_box: qpb,
               no_of_prints: Math.ceil(qty / qpb), selected: true };
    }));
    setActiveIdx(0);
  }, [visible, items]);

  const updateRow   = (barcode, field, value) =>
    setRows(prev => prev.map(r => r.barcode === barcode ? { ...r, [field]: value } : r));
  const allSelected = rows.length > 0 && rows.every(r => r.selected);
  const toggleAll   = () => setRows(prev => prev.map(r => ({ ...r, selected: !allSelected })));
  const selectedCount = rows.filter(r => r.selected).length;
  const totalLabels = rows.filter(r => r.selected).reduce((s, r) => s + (r.no_of_prints || 0), 0);

  const handlePrint = async () => {
    const selected = rows.filter(r => r.selected && r.no_of_prints > 0);
    if (!selected.length) { message.warning('Select at least one item to print'); return; }

    setPrinting(true);
    try {
      const { labelSize = '50x25', codeType = 'barcode', elements = [] } = layout;
      const [wMm, hMm] = labelSize.split('x').map(Number);

      // Find code element position to compute its render size
      const codeEl = elements.find(e => e.id === 'code' && e.visible);

      // Per-barcode code image cache: { dataUrl, wMm, hMm }
      const codeCache = {};

      if (codeEl) {
        const availW = +(wMm - codeEl.x - 1).toFixed(1);
        const availH = +(hMm - codeEl.y - 1).toFixed(1);
        const userSize = codeEl.size || null;

        for (const row of selected) {
          if (codeCache[row.barcode]) continue;

          if (codeType === 'qrcode') {
            // Use user-defined size; fall back to available square space
            const qrMm = Math.max(5, userSize || Math.min(availW, availH));
            const qrPx = mmPx(qrMm, 300);
            codeCache[row.barcode] = {
              dataUrl: await makeQRDataUrl(row.barcode, qrPx),
              wMm: qrMm, hMm: qrMm,
            };
          } else {
            // Use user-defined size as height; width fills available space
            const bcHMm = Math.max(5, userSize || Math.min(availH, hMm * 0.45));
            const bcWMm = Math.max(10, availW);
            codeCache[row.barcode] = {
              dataUrl: makeBarcodeDataUrl(row.barcode, mmPx(bcWMm, 300), mmPx(bcHMm, 300)),
              wMm: bcWMm, hMm: bcHMm,
            };
          }
        }
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
    setRows(prev => prev.map((r, j) => j === idx ? { ...r, selected: !r.selected } : r));

  // Keyboard control. Mirrors the app's conventions: F1 = primary action
  // (Print), Ctrl/Cmd+Enter = its alias, F2 = the bulk toggle, ↑/↓ = row
  // cursor, Space = toggle the cursored row, Esc = close (handled by AntD).
  // Latest state/handlers kept in a ref so the listener never goes stale
  // without re-binding (same trick ActionStrip uses).
  const kbRef = useRef({});
  kbRef.current = { rows, activeIdx, printing, totalLabels, handlePrint, toggleAll };

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
      // Row cursor + per-row toggle — skip while typing in a field so the
      // brand input and the Labels stepper keep their native keys.
      const ae = document.activeElement;
      const tag = (ae?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return;
      if (k === 'ArrowDown') {
        e.preventDefault(); e.stopImmediatePropagation();
        setActiveIdx(i => Math.min((i < 0 ? -1 : i) + 1, S.rows.length - 1));
      } else if (k === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        setActiveIdx(i => Math.max((i < 0 ? 0 : i) - 1, 0));
      } else if (k === ' ' || k === 'Spacebar') {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleRow(S.activeIdx < 0 ? 0 : S.activeIdx);
      }
    };
    // Capture phase: this listener is added after the underlying page's
    // ActionStrip (registered when the list mounted), so without capture
    // ActionStrip's F1 = "Open bill" would fire first behind the modal.
    // Capturing + stopImmediatePropagation makes the modal own its keys.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible]);

  const columns = [
    { title: 'Barcode', dataIndex: 'barcode', width: 116,
      render: v => <span className="bpm-bc">{v}</span> },
    { title: 'Product', dataIndex: 'product_name', ellipsis: true,
      render: v => v ? <Text strong>{v}</Text> : <Text type="secondary">—</Text> },
    { title: 'Article', dataIndex: 'article_number', width: 96, ellipsis: true,
      render: v => v ? <Text>{v}</Text> : <Text type="secondary">—</Text> },
    { title: 'Size', dataIndex: 'size', width: 56, align: 'center',
      render: v => v ? <Text>{v}</Text> : <Text type="secondary">—</Text> },
    { title: 'Pieces', dataIndex: 'quantity', width: 64, align: 'right',
      render: v => <Text strong className="bpm-num">{v}</Text> },
    { title: 'Per box', dataIndex: 'quantity_per_box', width: 64, align: 'right',
      render: v => <Text type="secondary" className="bpm-num">{v}</Text> },
    { title: 'Pur rate', dataIndex: 'purchase_rate', width: 80, align: 'right',
      render: v => <Text className="bpm-num">{fmt(v)}</Text> },
    { title: 'Margin', dataIndex: 'margin_percentage', width: 74, align: 'right',
      render: (_, r) => {
        const m = marginPct(r);
        return <Text className="bpm-num" type={m < 0 ? 'danger' : undefined}>
          {m ? `${m.toFixed(1)}%` : '—'}
        </Text>;
      } },
    { title: 'MRP', dataIndex: 'mrp', width: 76, align: 'right',
      render: v => <Text className="bpm-num">{fmt(v)}</Text> },
    { title: 'Sale rate', dataIndex: 'sale_rate', width: 82, align: 'right',
      render: v => <Text type="secondary" className="bpm-num">{fmt(v)}</Text> },
    { title: 'Labels', dataIndex: 'no_of_prints', width: 90, align: 'center',
      render: (v, record) => (
        <InputNumber min={0} max={9999} value={v}
          onChange={val => updateRow(record.barcode, 'no_of_prints', val || 0)}
          style={{ width: 70 }} size="small" />
      ) },
    { title: 'Print', dataIndex: '__print', width: 56, align: 'center',
      render: (_, record) => (
        <Checkbox checked={record.selected}
          onChange={e => updateRow(record.barcode, 'selected', e.target.checked)} />
      ) },
  ];

  return (
    <Modal
      className="bpm-modal"
      open={visible}
      onCancel={onClose}
      width={1120}
      title={
        <div className="bpm-head">
          <span className="bpm-head__icon"><PrinterOutlined /></span>
          <span className="bpm-head__title">
            Print Barcode Labels
            {billNumber ? <span className="bpm-head__bill">&nbsp;·&nbsp;{billNumber}</span> : null}
          </span>
          <span className="bpm-chip">{totalLabels} label{totalLabels === 1 ? '' : 's'}</span>
        </div>
      }
      footer={
        <div className="bpm-foot">
          <span className="bpm-foot__sum">
            <b>{totalLabels}</b> label{totalLabels === 1 ? '' : 's'} across <b>{selectedCount}</b> item{selectedCount === 1 ? '' : 's'}
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
      {rows.length === 0 ? (
        <div className="bpm-empty">No printable items in this bill.</div>
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

          <div className="bpm-table-wrap">
            <Table
              columns={columns}
              dataSource={rows}
              rowKey="barcode"
              pagination={false}
              size="small"
              tableLayout="fixed"
              onRow={(_, idx) => ({ onClick: () => setActiveIdx(idx) })}
              rowClassName={(r, idx) =>
                `bpm-row${r.selected ? '' : ' bpm-row--off'}${idx === activeIdx ? ' bpm-row--active' : ''}`}
            />
          </div>
        </>
      )}
    </Modal>
  );
}
