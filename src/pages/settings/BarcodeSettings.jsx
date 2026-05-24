import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Card, Form, Input, InputNumber, Button, Typography, Row, Col,
  Divider, message, Select, Switch, Tag, Tooltip, Tabs,
} from 'antd';
import {
  SaveOutlined, BarcodeOutlined, DeleteOutlined, EyeOutlined,
  EyeInvisibleOutlined, BoldOutlined, PlusOutlined, ReloadOutlined,
  PrinterOutlined, SlidersOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import JsBarcode from 'jsbarcode';
import { settingsAPI } from '../../api';
import { listPrinters } from '../../services/printer';
import { printLabelHTML, BARCODE_PRINTER_KEY, BARCODE_SILENT_KEY } from '../../components/BarcodePrintModal';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

// ── Print helpers (shared with test print) ────────────────────────────────────
const ptMm = (pt) => +((pt / 72) * 25.4).toFixed(3);
const mmPx = (mm, dpi = 300) => Math.round((mm / 25.4) * dpi);
function xmlEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SAMPLE_ROW = {
  barcode: 'PRD000123',
  product_name: 'Sample Product Name',
  mrp: 250.00,
  sale_rate: 200.00,
  size: 'M-L-XL',
  article_number: 'ART-001',
  quantity_per_box: 6,
  custom_label: 'SN-001',
};

function getSampleVal(el, companyName) {
  const pfx = (el.prefix !== undefined) ? el.prefix : null;
  switch (el.id) {
    case 'company_name':   return (pfx ?? '') + (companyName || 'My Company');
    case 'product_name':   return (pfx ?? '') + SAMPLE_ROW.product_name;
    case 'barcode_number': return (pfx ?? '') + SAMPLE_ROW.barcode;
    case 'mrp':            return (pfx ?? 'MRP ') + (Number.isInteger(SAMPLE_ROW.mrp) ? SAMPLE_ROW.mrp : SAMPLE_ROW.mrp.toFixed(2));
    case 'sale_rate':      return (pfx ?? 'Rate: Rs.') + (Number.isInteger(SAMPLE_ROW.sale_rate) ? SAMPLE_ROW.sale_rate : SAMPLE_ROW.sale_rate.toFixed(2));
    case 'size':           return (pfx ?? 'Size: ') + SAMPLE_ROW.size;
    case 'article_number': return (pfx ?? 'Art: ') + SAMPLE_ROW.article_number;
    case 'qty_per_box':    return (pfx ?? 'Qty: ') + SAMPLE_ROW.quantity_per_box;
    case 'rate_barcode':   return (pfx ?? 'Rate: Rs.') + SAMPLE_ROW.sale_rate + '-' + SAMPLE_ROW.barcode;
    case 'custom_label':   return (pfx ?? '') + SAMPLE_ROW.custom_label;
    default: return '';
  }
}

const { Title, Text } = Typography;

// ── Constants ─────────────────────────────────────────────────────────────────
const SCALE = 8; // px per mm in designer canvas

const LABEL_SIZES = {
  '50x25': { w: 50, h: 25, label: '50mm × 25mm (Standard)' },
  '50x50': { w: 50, h: 50, label: '50mm × 50mm (Square)' },
};

const FIELD_META = {
  company_name:   { label: 'Company Name',   sample: 'MY COMPANY',    defaultPrefix: '' },
  product_name:   { label: 'Product Name',   sample: 'Sample Product', defaultPrefix: '' },
  barcode_number: { label: 'Barcode No.',    sample: 'PRD000123',     defaultPrefix: '' },
  code:           { label: 'Barcode / QR',   sample: 'BARCODE', isCode: true },
  mrp:            { label: 'MRP',            sample: '250',             defaultPrefix: 'MRP ' },
  sale_rate:      { label: 'Sale Rate',      sample: '200',             defaultPrefix: 'Rate: Rs.' },
  size:           { label: 'Size',           sample: 'M / L / XL',    defaultPrefix: 'Size: ' },
  article_number: { label: 'Article No.',    sample: 'A-001',          defaultPrefix: 'Art: ' },
  qty_per_box:    { label: 'Qty / Box',     sample: '6',              defaultPrefix: 'Qty: ' },
  rate_barcode:   { label: 'Rate · Barcode', sample: '200-PRD000123', defaultPrefix: 'Rate: Rs.' },
  custom_label:   { label: 'Custom Label',   sample: 'SN-001',        defaultPrefix: '' },
};

const DEFAULT_LAYOUTS = {
  '50x25': [
    { id: 'company_name',   x: 2,  y: 1.5, fontSize: 7, bold: true,  visible: true,  prefix: '' },
    { id: 'product_name',   x: 2,  y: 5,   fontSize: 8, bold: true,  visible: true,  prefix: '' },
    { id: 'barcode_number', x: 2,  y: 21,  fontSize: 6, bold: false, visible: false, prefix: '' },
    { id: 'code',           x: 3,  y: 10,  fontSize: 8, bold: false, visible: true,  size: 12 },
    { id: 'mrp',            x: 2,  y: 22,  fontSize: 7, bold: true,  visible: true,  prefix: 'MRP ' },
    { id: 'sale_rate',      x: 28, y: 22,  fontSize: 7, bold: false, visible: false, prefix: 'Rate: Rs.' },
    { id: 'size',           x: 2,  y: 8,   fontSize: 7, bold: false, visible: false, prefix: 'Size: ' },
    { id: 'article_number', x: 28, y: 1.5, fontSize: 7, bold: false, visible: false, prefix: 'Art: ' },
    { id: 'qty_per_box',    x: 28, y: 5,   fontSize: 7, bold: false, visible: false, prefix: 'Qty: ' },
    { id: 'rate_barcode',   x: 2,  y: 19,  fontSize: 6, bold: false, visible: false, prefix: 'Rate: Rs.' },
    { id: 'custom_label',   x: 28, y: 8,   fontSize: 7, bold: false, visible: false, prefix: '' },
  ],
  '50x50': [
    { id: 'company_name',   x: 2,  y: 2,  fontSize: 8, bold: true,  visible: true,  prefix: '' },
    { id: 'product_name',   x: 2,  y: 8,  fontSize: 9, bold: true,  visible: true,  prefix: '' },
    { id: 'barcode_number', x: 2,  y: 45, fontSize: 6, bold: false, visible: false, prefix: '' },
    { id: 'code',           x: 4,  y: 16, fontSize: 8, bold: false, visible: true,  size: 25 },
    { id: 'mrp',            x: 2,  y: 44, fontSize: 8, bold: true,  visible: true,  prefix: 'MRP ' },
    { id: 'sale_rate',      x: 28, y: 44, fontSize: 8, bold: false, visible: false, prefix: 'Rate: Rs.' },
    { id: 'size',           x: 2,  y: 12, fontSize: 7, bold: false, visible: false, prefix: 'Size: ' },
    { id: 'article_number', x: 28, y: 2,  fontSize: 7, bold: false, visible: false, prefix: 'Art: ' },
    { id: 'qty_per_box',    x: 28, y: 8,  fontSize: 7, bold: false, visible: false, prefix: 'Qty: ' },
    { id: 'rate_barcode',   x: 2,  y: 38, fontSize: 7, bold: false, visible: false, prefix: 'Rate: Rs.' },
    { id: 'custom_label',   x: 28, y: 12, fontSize: 7, bold: false, visible: false, prefix: '' },
  ],
};

const STORAGE_KEY = 'barcode_label_layout';

function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

function saveLayout(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// Ensures all fields from DEFAULT_LAYOUTS exist in saved elements (adds missing ones as hidden)
function mergeWithDefaults(savedEls, labelSize) {
  const defaults = DEFAULT_LAYOUTS[labelSize] || [];
  if (!savedEls || !savedEls.length) return defaults;
  const result = [...savedEls];
  for (const def of defaults) {
    if (!result.find(el => el.id === def.id)) {
      result.push({ ...def, visible: false });
    }
  }
  return result;
}

// ── Barcode SVG renderer (for designer preview) ───────────────────────────────
function BarcodePreview({ value = 'SAMPLE123', height = 28, fontSize = 8 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128', width: 1.2, height,
        displayValue: true, fontSize, margin: 2,
        background: '#ffffff', lineColor: '#000000',
      });
    } catch (_) {}
  }, [value, height, fontSize]);
  return <svg ref={ref} style={{ maxWidth: '100%', display: 'block' }} />;
}

// ── QR Code preview using canvas (pure JS) ─────────────────────────────────────
function QRPreview({ value = 'SAMPLE123', size = 60 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    import('qrcode').then(QRCode => {
      QRCode.toCanvas(ref.current, value, { width: size, margin: 1 }, () => {});
    });
  }, [value, size]);
  return <canvas ref={ref} width={size} height={size} style={{ display: 'block' }} />;
}

// ── Label Canvas ───────────────────────────────────────────────────────────────
function LabelCanvas({ labelSize, codeType, elements, selectedId, onSelect, onMove }) {
  const { w, h } = LABEL_SIZES[labelSize];
  const canvasW = w * SCALE;
  const canvasH = h * SCALE;

  const dragRef = useRef(null);
  const canvasRef = useRef(null);

  const onMouseDown = useCallback((e, elemId) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(elemId);
    const rect = canvasRef.current.getBoundingClientRect();
    dragRef.current = {
      elemId,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startX: elements.find(el => el.id === elemId)?.x || 0,
      startY: elements.find(el => el.id === elemId)?.y || 0,
      canvasRect: rect,
    };
  }, [elements, onSelect]);

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragRef.current) return;
      const { elemId, startMouseX, startMouseY, startX, startY, canvasRect } = dragRef.current;
      const dx = (e.clientX - startMouseX) / SCALE;
      const dy = (e.clientY - startMouseY) / SCALE;
      const newX = Math.max(0, Math.min(w - 4, parseFloat((startX + dx).toFixed(1))));
      const newY = Math.max(0, Math.min(h - 2, parseFloat((startY + dy).toFixed(1))));
      onMove(elemId, newX, newY);
    };
    const onMouseUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [w, h, onMove]);

  const codeElem = elements.find(el => el.id === 'code' && el.visible);

  return (
    <div
      ref={canvasRef}
      onClick={() => onSelect(null)}
      style={{
        position: 'relative',
        width: canvasW,
        height: canvasH,
        background: '#ffffff',
        /* Soft 1px border + layered shadow gives the "lifted printed
         * label sitting on a desk" effect — replaces the heavy 2px
         * dark-gray frame which read as utilitarian admin chrome. */
        border: '1px solid #D4D4D8',
        borderRadius: 4,
        overflow: 'hidden',
        cursor: 'default',
        boxShadow:
          '0 1px 2px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.12), 0 16px 48px rgba(0, 0, 0, 0.06)',
        flexShrink: 0,
      }}
    >
      {/* 1mm dot grid + 5mm major lines — gives a graph-paper feel
       * the operator can register positions against, instead of an
       * empty white slab. Both layers are subtle so the actual
       * label content stays the focus. */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {/* 1mm dots */}
        <g opacity="0.10">
          {Array.from({ length: Math.floor(w) + 1 }, (_, x) =>
            Array.from({ length: Math.floor(h) + 1 }, (_, y) => (
              <circle key={`d${x}-${y}`} cx={x * SCALE} cy={y * SCALE} r="0.5" fill="#374151" />
            ))
          )}
        </g>
        {/* 5mm grid */}
        <g opacity="0.12">
          {Array.from({ length: Math.floor(w / 5) + 1 }, (_, i) => (
            <line key={`vg${i}`} x1={i * 5 * SCALE} y1={0} x2={i * 5 * SCALE} y2={canvasH} stroke="#6b7280" strokeWidth="0.4" />
          ))}
          {Array.from({ length: Math.floor(h / 5) + 1 }, (_, i) => (
            <line key={`hg${i}`} x1={0} y1={i * 5 * SCALE} x2={canvasW} y2={i * 5 * SCALE} stroke="#6b7280" strokeWidth="0.4" />
          ))}
        </g>
      </svg>

      {elements.filter(el => el.visible).map(el => {
        const isSelected = selectedId === el.id;
        const meta = FIELD_META[el.id];
        const isCode = el.id === 'code';

        return (
          <div
            key={el.id}
            onMouseDown={(e) => onMouseDown(e, el.id)}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: el.x * SCALE,
              top: el.y * SCALE,
              cursor: 'grab',
              userSelect: 'none',
              outline: isSelected ? '1.5px solid var(--accent)' : '1px dashed transparent',
              outlineOffset: 2,
              background: isSelected ? 'var(--accent-bg)' : 'transparent',
              borderRadius: 2,
              padding: '1px 2px',
              zIndex: isSelected ? 10 : 1,
            }}
          >
            {isCode ? (
              codeType === 'barcode' ? (
                <BarcodePreview height={Math.max(16, (el.size || 12) * SCALE * 0.55)} fontSize={el.fontSize} />
              ) : (
                <QRPreview size={(el.size || 12) * SCALE} />
              )
            ) : (
              <span style={{
                fontSize: el.fontSize * (SCALE / 4),
                fontWeight: el.bold ? 700 : 400,
                color: '#111',
                whiteSpace: 'nowrap',
                lineHeight: 1.2,
                display: 'block',
              }}>
                {(el.prefix !== undefined ? el.prefix : (meta?.defaultPrefix || '')) + (meta?.sample || el.id)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Properties Panel ───────────────────────────────────────────────────────────
function PropertiesPanel({ element, labelSize, onUpdate }) {
  if (!element) {
    return (
      <div className="bcd-props-empty">
        <div className="bcd-props-empty-icon" aria-hidden="true">
          <SlidersOutlined />
        </div>
        <div className="bcd-props-empty-title">Nothing selected</div>
        <div className="bcd-props-empty-hint">
          Click a field on the left, or any element on the label, to edit its properties.
        </div>
      </div>
    );
  }

  const { w, h } = LABEL_SIZES[labelSize];
  const isCode = element.id === 'code';

  return (
    <div className="bcd-props">
      {/* Position group — X/Y as a coordinate pair */}
      <div className="bcd-props-group">
        <div className="bcd-props-group-title">Position</div>
        <div className="bcd-props-grid-2">
          <label className="bcd-props-field">
            <span className="bcd-props-field-label">X · mm</span>
            <InputNumber size="small" min={0} max={w} step={0.5} value={element.x}
              onChange={v => onUpdate('x', v)} style={{ width: '100%' }} />
          </label>
          <label className="bcd-props-field">
            <span className="bcd-props-field-label">Y · mm</span>
            <InputNumber size="small" min={0} max={h} step={0.5} value={element.y}
              onChange={v => onUpdate('y', v)} style={{ width: '100%' }} />
          </label>
        </div>
      </div>

      {/* Type-specific group */}
      {isCode ? (
        <div className="bcd-props-group">
          <div className="bcd-props-group-title">Code</div>
          <label className="bcd-props-field">
            <span className="bcd-props-field-label">Size · mm</span>
            <InputNumber size="small" min={5} max={45} step={1} value={element.size || 12}
              onChange={v => onUpdate('size', v)} style={{ width: '100%' }} />
          </label>
        </div>
      ) : (
        <>
          <div className="bcd-props-group">
            <div className="bcd-props-group-title">Typography</div>
            <div className="bcd-props-grid-2">
              <label className="bcd-props-field">
                <span className="bcd-props-field-label">Font · pt</span>
                <InputNumber size="small" min={5} max={20} value={element.fontSize}
                  onChange={v => onUpdate('fontSize', v)} style={{ width: '100%' }} />
              </label>
              <div className="bcd-props-toggle bcd-props-toggle-compact">
                <span className="bcd-props-field-label">Bold</span>
                <Switch size="small" checked={element.bold} onChange={v => onUpdate('bold', v)} />
              </div>
            </div>
          </div>

          <div className="bcd-props-group">
            <div className="bcd-props-group-title">Label text</div>
            <label className="bcd-props-field">
              <span className="bcd-props-field-label">Prefix (optional)</span>
              <Input
                size="small"
                value={element.prefix ?? ''}
                onChange={e => onUpdate('prefix', e.target.value)}
                placeholder={FIELD_META[element.id]?.defaultPrefix || 'e.g. Name:'}
                allowClear
              />
              <span className="bcd-props-hint">Shown before the value · leave blank for none</span>
            </label>
          </div>
        </>
      )}

      <div className="bcd-props-group">
        <div className="bcd-props-toggle">
          <span className="bcd-props-field-label">Show on label</span>
          <Switch size="small" checked={element.visible} onChange={v => onUpdate('visible', v)} />
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function BarcodeSettings() {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [preview, setPreview] = useState('');
  const [activeTab, setActiveTab] = useState('designer');

  // Designer state — all lazily initialized from localStorage so auto-save never races
  const [labelSize, setLabelSize] = useState(() => {
    const saved = loadLayout();
    return saved?.labelSize || '50x25';
  });
  const [codeType, setCodeType] = useState(() => {
    const saved = loadLayout();
    return saved?.codeType || 'barcode';
  });
  const [elements, setElements] = useState(() => {
    const saved = loadLayout();
    const size = saved?.labelSize || '50x25';
    const raw = saved?.layouts?.[size] || saved?.elements || DEFAULT_LAYOUTS[size];
    return mergeWithDefaults(raw, size);
  });
  const [selectedId, setSelectedId] = useState(null);

  // ── Barcode label printer (localStorage — same store as the layout) ──
  const [printers,   setPrinters]   = useState([]);
  const [printerErr, setPrinterErr] = useState('');
  const [bcPrinter,  setBcPrinter]  = useState(() => localStorage.getItem(BARCODE_PRINTER_KEY) || '');
  const [bcSilent,   setBcSilent]   = useState(() => localStorage.getItem(BARCODE_SILENT_KEY) !== '0');

  const refreshPrinters = useCallback(() => {
    listPrinters().then(res => {
      setPrinters(res.printers || []);
      setPrinterErr(res.error || '');
    });
  }, []);

  const saveBcPrinter = (v) => {
    const s = v || '';
    setBcPrinter(s);
    localStorage.setItem(BARCODE_PRINTER_KEY, s);
  };
  const saveBcSilent = (v) => {
    setBcSilent(v);
    localStorage.setItem(BARCODE_SILENT_KEY, v ? '1' : '0');
  };

  // Load barcode numbering settings + printer list
  useEffect(() => {
    loadSettings();
    refreshPrinters();
  }, [refreshPrinters]);

  const loadSettings = async () => {
    setLoadingSettings(true);
    try {
      const { data } = await settingsAPI.getBarcode();
      // Older rows may predate the separator column — default to '-'
      // so the form shows something sensible and existing barcodes
      // keep their previous shape.
      const settings = { separator: '-', ...(data.data || {}) };
      if (settings.separator === null || settings.separator === undefined) settings.separator = '-';
      form.setFieldsValue(settings);
      updatePreview(settings);
    } catch (_) {}
    setLoadingSettings(false);
  };

  const updatePreview = (values) => {
    // Mirrors server/utils/barcode.js exactly — empty prefix means
    // pure numbers (no separator); otherwise the user-picked separator
    // (- / _ / / / . / none) joins prefix and number and counts toward
    // total_digits.
    const prefix = values?.prefix || '';
    const sepRaw = values?.separator ?? '-';
    const separator = prefix ? sepRaw : '';
    const number = values?.current_number || values?.starting_number || 1;
    const totalDigits = values?.total_digits || 13;
    const usedChars = prefix.length + separator.length;
    const numDigits = Math.max(1, totalDigits - usedChars);
    setPreview(`${prefix}${separator}${String(number).padStart(numDigits, '0')}`);
  };

  const handleSettingsSave = async (values) => {
    setSavingSettings(true);
    try {
      const { current_number, ...payload } = values;
      await settingsAPI.updateBarcode(payload);
      message.success('Barcode settings saved');
      // Reload so the UI shows the server-corrected current_number
      // (reset when starting_number changes).
      loadSettings();
    } catch (_) { message.error('Failed to save'); }
    setSavingSettings(false);
  };

  const [testPrinting, setTestPrinting] = useState(false);

  // ── Test print ─────────────────────────────────────────────────────────────
  const handleTestPrint = useCallback(async () => {
    setTestPrinting(true);
    try {
      const { w: wMm, h: hMm } = LABEL_SIZES[labelSize];
      const co = localStorage.getItem('barcode_company_name') || 'My Company';
      const codeEl = elements.find(e => e.id === 'code' && e.visible);
      let codeImg = null;

      if (codeEl) {
        const availW = +(wMm - codeEl.x - 1).toFixed(1);
        const availH = +(hMm - codeEl.y - 1).toFixed(1);
        const sz = codeEl.size || null;

        if (codeType === 'qrcode') {
          const qrMm = Math.max(5, sz || Math.min(availW, availH));
          const QRCode = await import('qrcode');
          const dataUrl = await QRCode.toDataURL(SAMPLE_ROW.barcode, { width: mmPx(qrMm), margin: 1 });
          codeImg = { dataUrl, wMm: qrMm, hMm: qrMm };
        } else {
          const bcHMm = Math.max(5, sz || Math.min(availH, hMm * 0.45));
          const bcWMm = Math.max(10, availW);
          const cv = document.createElement('canvas');
          JsBarcode(cv, SAMPLE_ROW.barcode, {
            format: 'CODE128', width: 2, height: Math.max(20, mmPx(bcHMm) - 16),
            displayValue: true, fontSize: 12, margin: 5, background: '#fff', lineColor: '#000',
          });
          const out = document.createElement('canvas');
          out.width = mmPx(bcWMm); out.height = cv.height + 16;
          const ctx = out.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
          ctx.drawImage(cv, 0, 0, out.width, out.height);
          codeImg = { dataUrl: out.toDataURL('image/png'), wMm: bcWMm, hMm: bcHMm };
        }
      }

      let body = '';
      if (codeEl && codeImg) {
        body += `<image href="${codeImg.dataUrl}" x="${codeEl.x}" y="${codeEl.y}"
          width="${codeImg.wMm}" height="${codeImg.hMm}" preserveAspectRatio="xMinYMin meet"/>`;
      }
      for (const el of elements) {
        if (!el.visible || el.id === 'code') continue;
        const val = getSampleVal(el, co);
        if (!val) continue;
        const fsMm = +(ptMm(el.fontSize || 7) * 1.15).toFixed(3);
        body += `<text x="${el.x}" y="${+(el.y + fsMm).toFixed(3)}"
          font-size="${fsMm}" font-family="Arial,Helvetica,sans-serif"
          font-weight="${el.bold ? 'bold' : '600'}" text-rendering="geometricPrecision"
          fill="#000000">${xmlEsc(val)}</text>`;
      }

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
        viewBox="0 0 ${wMm} ${hMm}" width="${wMm}mm" height="${hMm}mm" style="display:block;background:#fff;">${body}</svg>`;

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  @page{size:${wMm}mm ${hMm}mm;margin:0}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#fff}
  .pg{width:${wMm}mm;height:${hMm}mm;overflow:hidden}
  svg{display:block}
</style></head>
<body><div class="pg">${svg}</div></body></html>`;

      // Silent direct-print to the configured barcode printer (same path
      // the real F7 barcode print uses); falls back to the OS dialog on
      // web / when silent is off.
      await printLabelHTML(html, wMm, hMm);
    } catch (e) { message.error('Test print failed: ' + e.message); }
    finally { setTestPrinting(false); }
  }, [elements, labelSize, codeType]);

  // ── Designer handlers ──────────────────────────────────────────────────────
  const handleSizeChange = (size) => {
    setLabelSize(size);
    setSelectedId(null);
    const saved = loadLayout();
    const raw = saved?.layouts?.[size] || DEFAULT_LAYOUTS[size];
    setElements(mergeWithDefaults(raw, size));
  };

  const handleMove = useCallback((elemId, x, y) => {
    setElements(prev => prev.map(el => el.id === elemId ? { ...el, x, y } : el));
  }, []);

  const handleUpdateProp = (prop, value) => {
    setElements(prev => prev.map(el => el.id === selectedId ? { ...el, [prop]: value } : el));
  };

  const handleSaveDesign = () => {
    const saved = loadLayout() || {};
    const layouts = saved.layouts || {};
    layouts[labelSize] = elements;
    saveLayout({ labelSize, codeType, elements, layouts });
    message.success('Label design saved!');
  };

  const handleResetDesign = () => {
    setElements(DEFAULT_LAYOUTS[labelSize]);
    setSelectedId(null);
    message.info('Reset to default layout');
  };

  const handleToggleVisible = (elemId) => {
    setElements(prev => prev.map(el => el.id === elemId ? { ...el, visible: !el.visible } : el));
  };

  // Auto-save on every change — safe because all state initializes from localStorage
  useEffect(() => {
    const saved = loadLayout() || {};
    const layouts = saved.layouts || {};
    layouts[labelSize] = elements;
    saveLayout({ labelSize, codeType, elements, layouts });
  }, [elements, labelSize, codeType]);

  const selectedElem = elements.find(el => el.id === selectedId) || null;
  const { w, h } = LABEL_SIZES[labelSize];

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Barcode</h1>
        <p className="ms-page-sub">
          Design barcode labels for shelf printing and configure label-numbering rules.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        {
          key: 'designer',
          label: <span><BarcodeOutlined /> Label Designer</span>,
          children: (
            <div>
              {/* Toolbar — single row that doesn't wrap. Labelled
               * controls hug the left, action cluster hugs the right.
               * No section padding around it (.bcd-toolbar overrides
               * ms-section's defaults) so the row reads as a strip,
               * not a card. */}
              <section className="bcd-toolbar">
                <div className="bcd-toolbar-field">
                  <label className="bcd-toolbar-label" htmlFor="bcd-size">Size</label>
                  <Select id="bcd-size" value={labelSize} onChange={handleSizeChange} style={{ width: 200 }}>
                    {Object.entries(LABEL_SIZES).map(([k, v]) => (
                      <Select.Option key={k} value={k}>{v.label}</Select.Option>
                    ))}
                  </Select>
                </div>

                <div className="bcd-toolbar-field">
                  <label className="bcd-toolbar-label" htmlFor="bcd-codetype">Code type</label>
                  <Select id="bcd-codetype" value={codeType} onChange={v => { setCodeType(v); }} style={{ width: 150 }}>
                    <Select.Option value="barcode">Barcode (1D)</Select.Option>
                    <Select.Option value="qrcode">QR Code (2D)</Select.Option>
                  </Select>
                </div>

                <div className="bcd-toolbar-divider" />

                <div className="bcd-toolbar-actions">
                  <Button icon={<ReloadOutlined />} onClick={handleResetDesign}>Reset</Button>
                  <Button icon={<PrinterOutlined />} onClick={handleTestPrint} loading={testPrinting}>Test print</Button>
                  <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveDesign}>Save design</Button>
                </div>
              </section>

              {/* Designer body — three columns sharing the same card
               * shell with subtle uppercase headers, matching the rest
               * of the settings UI. */}
              <div className="bcd-grid">
                {/* Fields panel */}
                <section className="ms-section bcd-panel">
                  <div className="ms-section-head" style={{ marginBottom: 0, paddingBottom: 12, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <h2 className="ms-section-title">Fields</h2>
                    <span style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>
                      {elements.filter(el => el.visible).length}/{elements.length} on
                    </span>
                  </div>
                  <div className="bcd-fields-list">
                    {Object.entries(FIELD_META).map(([id, meta]) => {
                      const elem = elements.find(el => el.id === id);
                      const isVisible = elem?.visible ?? false;
                      const isSelected = selectedId === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => { setSelectedId(id); }}
                          className={`bcd-field-row${isSelected ? ' active' : ''}${isVisible ? '' : ' hidden'}`}
                        >
                          <span className="bcd-field-label">{meta.label}</span>
                          <Tooltip title={isVisible ? 'Hide on label' : 'Show on label'}>
                            <span
                              onClick={e => { e.stopPropagation(); handleToggleVisible(id); }}
                              className={`bcd-field-eye${isVisible ? ' on' : ''}`}
                            >
                              {isVisible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                            </span>
                          </Tooltip>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Canvas */}
                <section className="ms-section bcd-canvas-card">
                  <div className="ms-section-head" style={{ marginBottom: 0, paddingBottom: 12, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <h2 className="ms-section-title">Preview</h2>
                    <span style={{ fontSize: 11, color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                      {w} × {h} mm · drag to reposition
                    </span>
                  </div>
                  <div className="bcd-canvas-stage">
                    <LabelCanvas
                      labelSize={labelSize}
                      codeType={codeType}
                      elements={elements}
                      selectedId={selectedId}
                      onSelect={setSelectedId}
                      onMove={handleMove}
                    />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 11, color: 'var(--fg-tertiary)', textAlign: 'center' }}>
                    Grid lines every 5 mm
                  </div>
                </section>

                {/* Properties panel */}
                <section className="ms-section bcd-panel">
                  <div className="ms-section-head" style={{ marginBottom: 0, paddingBottom: 12 }}>
                    <h2 className="ms-section-title">Properties</h2>
                    <p className="ms-section-desc">
                      {selectedElem ? FIELD_META[selectedElem.id]?.label : 'Pick a field on the left or canvas.'}
                    </p>
                  </div>
                  <PropertiesPanel
                    element={selectedElem}
                    labelSize={labelSize}
                    onUpdate={handleUpdateProp}
                  />
                </section>
              </div>

              {/* Legend — clean inline strip instead of indigo Tag pills.
               * Visible fields enumerate as small chips so the operator
               * sees what's currently being printed. */}
              <div className="bcd-legend">
                <span className="bcd-legend-label">Showing on label:</span>
                {Object.entries(FIELD_META).filter(([id]) => elements.find(el => el.id === id)?.visible).length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>nothing yet — toggle a field on</span>
                )}
                {Object.entries(FIELD_META).filter(([id]) => elements.find(el => el.id === id)?.visible).map(([id, meta]) => (
                  <span key={id} className="bcd-legend-chip">{meta.label}</span>
                ))}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>
                  Design applies to all barcode prints
                </span>
              </div>
            </div>
          ),
        },
        {
          key: 'numbering',
          label: 'Barcode Numbering',
          children: (
            <Row gutter={16}>
              <Col xs={24} lg={14}>
                <Card loading={loadingSettings}>
                  <Form form={form} layout="vertical" onFinish={handleSettingsSave}
                    onValuesChange={(_, all) => updatePreview(all)}>
                    <Row gutter={16}>
                      <Col xs={24} md={12}>
                        <Form.Item
                          name="prefix"
                          label="Prefix (optional)"
                          extra="Leave blank for pure-numeric barcodes."
                        >
                          <Input placeholder="e.g. PRD — leave blank for numbers only" allowClear />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item
                          name="separator"
                          label="Separator"
                          extra="Joins prefix and number. Ignored when prefix is blank."
                        >
                          <Select
                            options={[
                              { value: '-', label: 'Hyphen  —  PROD-04039' },
                              { value: '_', label: 'Underscore  —  PROD_04039' },
                              { value: '/', label: 'Slash  —  PROD/04039' },
                              { value: '.', label: 'Dot  —  PROD.04039' },
                              { value: '',  label: 'None  —  PROD04039' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col xs={24} md={12}>
                        <Form.Item name="total_digits" label="Total Digits" rules={[{ required: true }]}>
                          <InputNumber min={4} max={12} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item name="starting_number" label="Starting Number" rules={[{ required: true }]}>
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col xs={24} md={12}>
                        <Form.Item name="current_number" label="Current Number">
                          <InputNumber disabled style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                    {/* Format Pattern field removed — it was a stub the
                     * UI saved but neither the preview nor the backend
                     * generator ever read. The four fields above
                     * (Prefix / Total Digits / Starting / Current)
                     * deterministically define the output, and the
                     * Barcode Preview to the right reflects it live. */}
                    <Form.Item>
                      <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={savingSettings}>
                        Save Settings
                      </Button>
                    </Form.Item>
                  </Form>
                </Card>
              </Col>
              <Col xs={24} lg={10}>
                <Card>
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    <BarcodeOutlined style={{ fontSize: 48, color: 'var(--accent)', marginBottom: 16 }} />
                    <Title level={4}>Barcode Preview</Title>
                    <Divider />
                    <div style={{ background: '#fff', border: '2px dashed #d9d9d9', borderRadius: 8, padding: '24px 16px', marginBottom: 16 }}>
                      <Text style={{ fontSize: 28, fontWeight: 600, letterSpacing: 2 }}>
                        {preview || '---'}
                      </Text>
                    </div>
                    <Text type="secondary">Next generated barcode will look like this.</Text>
                  </div>
                </Card>
              </Col>
            </Row>
          ),
        },
        {
          key: 'printer',
          label: <span><PrinterOutlined /> Printer</span>,
          children: (
            <Row gutter={16}>
              <Col xs={24} lg={16}>
                <Card title="Barcode Label Printer">
                  <Text type="secondary" style={{ display: 'block', marginBottom: 14 }}>
                    Used by the <b>F7 → Print Barcode</b> popup (Purchase list / bill form)
                    and the Test print button. Prints silently to the chosen printer —
                    the same way sales bills do.
                  </Text>
                  <Row gutter={16} align="bottom">
                    <Col xs={24} md={14}>
                      <label>Barcode printer</label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Select
                          value={bcPrinter || undefined}
                          onChange={saveBcPrinter}
                          style={{ flex: 1 }}
                          allowClear
                          showSearch
                          placeholder={printers.length ? 'Pick a printer' : 'No printers detected — type below'}
                          options={printers.map(p => ({
                            value: p.name,
                            label: `${p.displayName || p.name}${p.isDefault ? '  (system default)' : ''}`,
                          }))}
                        />
                        <Tooltip title="Refresh printer list">
                          <Button icon={<ReloadOutlined />} onClick={refreshPrinters} />
                        </Tooltip>
                      </div>
                    </Col>
                    <Col xs={24} md={10}>
                      <label>Or type printer name</label>
                      <Input
                        value={bcPrinter}
                        onChange={e => saveBcPrinter(e.target.value)}
                        placeholder="e.g. TVS LP46  ·  blank = system default"
                      />
                    </Col>
                  </Row>
                  <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Switch checked={bcSilent} onChange={saveBcSilent} />
                    <Text>Silent direct print (no system dialog)</Text>
                  </div>
                  {printerErr && (
                    <div style={{ marginTop: 10, padding: 8, background: 'rgba(239,68,68,0.08)', color: '#b91c1c', borderRadius: 6, fontSize: 12 }}>
                      Printer list error: {printerErr}
                    </div>
                  )}
                  <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-muted, #f5f5f5)', borderRadius: 6, fontSize: 12, color: 'var(--fg-secondary)' }}>
                    Label size &amp; field layout are set in the <b>Label Designer</b> tab.
                    Silent printing requires the desktop (Electron) build; the web-only
                    preview falls back to the browser print dialog. Settings save instantly.
                  </div>
                  <div style={{ marginTop: 16 }}>
                    <Button icon={<PrinterOutlined />} onClick={handleTestPrint} loading={testPrinting}>
                      Test print a sample label
                    </Button>
                  </div>
                </Card>
              </Col>
            </Row>
          ),
        },
      ]} />
        </div>
      </div>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
          {
            id: 'save', key: 'F1', label: 'Save', tone: 'primary',
            disabled: savingSettings || loadingSettings,
            onAction: () => {
              // Tab-aware save: designer tab persists the layout to
              // localStorage; numbering tab posts the form to the API.
              if (activeTab === 'designer') handleSaveDesign();
              else form.submit();
            },
          },
        ]}
      />
    </div>
  );
}
