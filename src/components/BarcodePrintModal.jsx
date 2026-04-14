import React, { useEffect, useState } from 'react';
import { Modal, Button, InputNumber, Input, Table, Checkbox, Typography, message } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import JsBarcode from 'jsbarcode';

const { Text } = Typography;

const STORAGE_KEY    = 'barcode_label_layout';
const CO_NAME_KEY    = 'barcode_company_name';

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
    return (el?.prefix !== undefined ? el.prefix : 'MRP: Rs.') + parseFloat(row.mrp).toFixed(2);
  },
  sale_rate:      (row, co, el) => {
    if (!(row.sale_rate > 0)) return '';
    return (el?.prefix !== undefined ? el.prefix : 'Rate: Rs.') + parseFloat(row.sale_rate).toFixed(2);
  },
  size:           (row, co, el) => {
    if (!row.size) return '';
    return (el?.prefix !== undefined ? el.prefix : 'Size: ') + row.size;
  },
  article_number: (row, co, el) => {
    if (!row.article_number) return '';
    return (el?.prefix !== undefined ? el.prefix : 'Art: ') + row.article_number;
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

// ── Small SVG preview rendered live in modal ──────────────────────────────────
function LabelPreview({ row, companyName, layout }) {
  const { labelSize = '50x25', elements = [] } = layout;
  const [wMm, hMm] = labelSize.split('x').map(Number);

  const codeEl = elements.find(e => e.id === 'code' && e.visible);
  const availW = codeEl ? wMm - codeEl.x - 1 : 20;
  const availH = codeEl ? hMm - codeEl.y - 1 : 10;
  const codeMm = Math.min(availW, availH);

  // Scale so preview fits in ~200px wide
  const PREV_SCALE = 180 / wMm;

  const textEls = elements.filter(e => e.visible && e.id !== 'code').map(el => {
    const fn  = FIELD_VAL[el.id];
    const val = fn ? fn(row, companyName, el) : '';
    if (!val) return null;
    const fsMm = ptMm(el.fontSize || 7);
    return (
      <text key={el.id}
        x={el.x} y={+(el.y + fsMm).toFixed(2)}
        fontSize={fsMm}
        fontFamily="Arial,Helvetica,sans-serif"
        fontWeight={el.bold ? 'bold' : 'normal'}
        fill="#000">
        {val}
      </text>
    );
  }).filter(Boolean);

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 4, display: 'inline-block', background: '#fff' }}>
      <svg viewBox={`0 0 ${wMm} ${hMm}`}
        width={wMm * PREV_SCALE} height={hMm * PREV_SCALE}
        style={{ display: 'block' }}>
        <rect width={wMm} height={hMm} fill="white" />
        {codeEl && (
          <rect x={codeEl.x} y={codeEl.y} width={codeMm} height={codeMm}
            fill="#f3f4f6" stroke="#9ca3af" strokeWidth="0.3" />
        )}
        {codeEl && (
          <text x={codeEl.x + codeMm / 2} y={codeEl.y + codeMm / 2}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={codeMm * 0.12} fill="#6b7280" fontFamily="Arial">
            {layout.codeType === 'qrcode' ? 'QR' : 'BARCODE'}
          </text>
        )}
        {textEls}
      </svg>
    </div>
  );
}

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function BarcodePrintModal({ visible, onClose, billNumber, items, initialCompany = '' }) {
  const [rows, setRows]               = useState([]);
  const [companyName, setCompanyName] = useState(() => localStorage.getItem(CO_NAME_KEY) || initialCompany);
  const [printing, setPrinting]       = useState(false);
  const [layout, setLayout]           = useState(FALLBACK_LAYOUT);

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
      const qpb = parseInt(item.quantity_per_box) || 1;
      const qty = parseFloat(item.quantity) || 0;
      return { ...item, key: item.barcode, quantity_per_box: qpb,
               no_of_prints: Math.ceil(qty / qpb), selected: true };
    }));
  }, [visible, items]);

  const updateRow   = (barcode, field, value) =>
    setRows(prev => prev.map(r => r.barcode === barcode ? { ...r, [field]: value } : r));
  const allSelected = rows.length > 0 && rows.every(r => r.selected);
  const toggleAll   = () => setRows(prev => prev.map(r => ({ ...r, selected: !allSelected })));
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

      const html = `<!DOCTYPE html>
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

    } catch (e) {
      message.error('Print failed: ' + e.message);
    } finally {
      setPrinting(false);
    }
  };

  const columns = [
    { title: 'Barcode', dataIndex: 'barcode', width: 120,
      render: v => <Text strong style={{ fontSize:12 }}>{v}</Text> },
    { title: 'Product Name', dataIndex: 'product_name', render: v => <Text strong>{v}</Text> },
    { title: 'Size', dataIndex: 'size', width: 70, align: 'center', render: v => <Text>{v || '—'}</Text> },
    { title: 'QTY (Pc)', dataIndex: 'quantity', width: 80, align: 'center', render: v => <Text strong>{v}</Text> },
    { title: 'QTY (Box)', dataIndex: 'quantity_per_box', width: 80, align: 'center' },
    { title: 'MRP', dataIndex: 'mrp', width: 80, align: 'center',
      render: v => <Text>{parseFloat(v || 0).toFixed(2)}</Text> },
    { title: 'Rate', dataIndex: 'sale_rate', width: 80, align: 'center',
      render: v => <Text>{parseFloat(v || 0).toFixed(2)}</Text> },
    { title: 'No. of Prints', dataIndex: 'no_of_prints', width: 115, align: 'center',
      render: (v, record) => (
        <InputNumber min={0} max={9999} value={v}
          onChange={val => updateRow(record.barcode, 'no_of_prints', val || 0)}
          style={{ width:78 }} size="small" />
      ) },
    { title: 'Select', width: 60, align: 'center',
      render: (_, record) => (
        <Checkbox checked={record.selected}
          onChange={e => updateRow(record.barcode, 'selected', e.target.checked)} />
      ) },
  ];

  return (
    <Modal open={visible} onCancel={onClose} width={1050}
      title={
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <PrinterOutlined style={{ color:'#4F46E5', fontSize:18 }} />
          <span style={{ fontWeight:700, fontSize:16 }}>Barcode Printing — {billNumber}</span>
          <span style={{ background:'#eef2ff', color:'#4F46E5', padding:'2px 10px', borderRadius:20, fontSize:12, fontWeight:600 }}>
            {totalLabels} labels
          </span>
        </div>
      }
      footer={
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'4px 0' }}>
          <Button type="primary" icon={<PrinterOutlined />} onClick={handlePrint}
            loading={printing} size="large"
            style={{ background:'linear-gradient(135deg,#4F46E5,#7C3AED)', border:'none', fontWeight:600, paddingInline:32 }}>
            {printing ? 'Preparing...' : 'PRINT'}
          </Button>
          <Input placeholder="Company / Brand Name" value={companyName}
            onChange={handleCompanyChange}
            style={{ width:260, textAlign:'center', fontWeight:600, fontSize:14, borderRadius:8 }} size="large" />
          <Button size="large" onClick={toggleAll}
            style={{ fontWeight:600, borderColor:allSelected ? '#EF4444':'#4F46E5', color:allSelected ? '#EF4444':'#4F46E5', paddingInline:24 }}>
            {allSelected ? 'DESELECT ALL' : 'SELECT ALL'}
          </Button>
        </div>
      }
      bodyStyle={{ padding:0, maxHeight:'65vh', overflow:'auto' }}
      styles={{ footer:{ padding:'12px 24px', borderTop:'2px solid #f0f0f0' } }}
    >
      <Table columns={columns} dataSource={rows} rowKey="barcode" pagination={false}
        size="middle"
        rowClassName={() => 'barcode-row'}
        onRow={record => ({ style:{ opacity: record.selected ? 1 : 0.45 } })}
        components={{ header:{ cell: props =>
          <th {...props} style={{ ...props.style, background:'#fde047', color:'#1f2937', fontWeight:700, fontSize:13, textAlign:'center', borderBottom:'2px solid #ca8a04', padding:'10px 12px' }} />
        }}}
      />
      <style>{`
        .barcode-row td { background:#fafafa !important; transition:opacity .15s; }
      `}</style>
    </Modal>
  );
}
