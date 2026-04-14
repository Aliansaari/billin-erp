import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Card, Form, Input, InputNumber, Button, Typography, Row, Col,
  Divider, message, Select, Switch, Tag, Tooltip, Tabs,
} from 'antd';
import {
  SaveOutlined, BarcodeOutlined, DeleteOutlined, EyeOutlined,
  EyeInvisibleOutlined, BoldOutlined, PlusOutlined, ReloadOutlined,
  PrinterOutlined,
} from '@ant-design/icons';
import JsBarcode from 'jsbarcode';
import { settingsAPI } from '../../api';

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
};

function getSampleVal(el, companyName) {
  const pfx = (el.prefix !== undefined) ? el.prefix : null;
  switch (el.id) {
    case 'company_name':   return (pfx ?? '') + (companyName || 'My Company');
    case 'product_name':   return (pfx ?? '') + SAMPLE_ROW.product_name;
    case 'barcode_number': return (pfx ?? '') + SAMPLE_ROW.barcode;
    case 'mrp':            return (pfx ?? 'MRP: Rs.') + SAMPLE_ROW.mrp.toFixed(2);
    case 'sale_rate':      return (pfx ?? 'Rate: Rs.') + SAMPLE_ROW.sale_rate.toFixed(2);
    case 'size':           return (pfx ?? 'Size: ') + SAMPLE_ROW.size;
    case 'article_number': return (pfx ?? 'Art: ') + SAMPLE_ROW.article_number;
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
  mrp:            { label: 'MRP',            sample: '250.00',         defaultPrefix: 'MRP: Rs.' },
  sale_rate:      { label: 'Sale Rate',      sample: '200.00',         defaultPrefix: 'Rate: Rs.' },
  size:           { label: 'Size',           sample: 'M / L / XL',    defaultPrefix: 'Size: ' },
  article_number: { label: 'Article No.',    sample: 'A-001',          defaultPrefix: 'Art: ' },
};

const DEFAULT_LAYOUTS = {
  '50x25': [
    { id: 'company_name',   x: 2,  y: 1.5, fontSize: 7, bold: true,  visible: true,  prefix: '' },
    { id: 'product_name',   x: 2,  y: 5,   fontSize: 8, bold: true,  visible: true,  prefix: '' },
    { id: 'barcode_number', x: 2,  y: 21,  fontSize: 6, bold: false, visible: false, prefix: '' },
    { id: 'code',           x: 3,  y: 10,  fontSize: 8, bold: false, visible: true,  size: 12 },
    { id: 'mrp',            x: 2,  y: 22,  fontSize: 7, bold: true,  visible: true,  prefix: 'MRP: Rs.' },
    { id: 'sale_rate',      x: 28, y: 22,  fontSize: 7, bold: false, visible: false, prefix: 'Rate: Rs.' },
    { id: 'size',           x: 2,  y: 8,   fontSize: 7, bold: false, visible: false, prefix: 'Size: ' },
    { id: 'article_number', x: 28, y: 1.5, fontSize: 7, bold: false, visible: false, prefix: 'Art: ' },
  ],
  '50x50': [
    { id: 'company_name',   x: 2,  y: 2,  fontSize: 8, bold: true,  visible: true,  prefix: '' },
    { id: 'product_name',   x: 2,  y: 8,  fontSize: 9, bold: true,  visible: true,  prefix: '' },
    { id: 'barcode_number', x: 2,  y: 45, fontSize: 6, bold: false, visible: false, prefix: '' },
    { id: 'code',           x: 4,  y: 16, fontSize: 8, bold: false, visible: true,  size: 25 },
    { id: 'mrp',            x: 2,  y: 44, fontSize: 8, bold: true,  visible: true,  prefix: 'MRP: Rs.' },
    { id: 'sale_rate',      x: 28, y: 44, fontSize: 8, bold: false, visible: false, prefix: 'Rate: Rs.' },
    { id: 'size',           x: 2,  y: 12, fontSize: 7, bold: false, visible: false, prefix: 'Size: ' },
    { id: 'article_number', x: 28, y: 2,  fontSize: 7, bold: false, visible: false, prefix: 'Art: ' },
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
        background: 'white',
        border: '2px solid #374151',
        borderRadius: 2,
        overflow: 'hidden',
        cursor: 'default',
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        flexShrink: 0,
      }}
    >
      {/* mm grid dots */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.12 }}>
        {Array.from({ length: Math.floor(w / 5) + 1 }, (_, i) => (
          <line key={`vg${i}`} x1={i * 5 * SCALE} y1={0} x2={i * 5 * SCALE} y2={canvasH} stroke="#6b7280" strokeWidth="0.5" strokeDasharray="2,2" />
        ))}
        {Array.from({ length: Math.floor(h / 5) + 1 }, (_, i) => (
          <line key={`hg${i}`} x1={0} y1={i * 5 * SCALE} x2={canvasW} y2={i * 5 * SCALE} stroke="#6b7280" strokeWidth="0.5" strokeDasharray="2,2" />
        ))}
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
              outline: isSelected ? '1.5px dashed #4F46E5' : '1px dashed transparent',
              outlineOffset: 2,
              background: isSelected ? 'rgba(79,70,229,0.05)' : 'transparent',
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
  if (!element) return (
    <div style={{ padding: '24px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
      Click an element on the canvas to edit its properties
    </div>
  );

  const { w, h } = LABEL_SIZES[labelSize];
  const meta = FIELD_META[element.id];

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: '#1e293b', marginBottom: 12, borderBottom: '1px solid #e5e7eb', paddingBottom: 8 }}>
        {meta?.label}
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>POSITION X (mm)</label>
        <InputNumber size="small" min={0} max={w} step={0.5} value={element.x}
          onChange={v => onUpdate('x', v)} style={{ width: '100%' }} />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>POSITION Y (mm)</label>
        <InputNumber size="small" min={0} max={h} step={0.5} value={element.y}
          onChange={v => onUpdate('y', v)} style={{ width: '100%' }} />
      </div>

      {element.id === 'code' ? (
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>SIZE (mm)</label>
          <InputNumber size="small" min={5} max={45} step={1} value={element.size || 12}
            onChange={v => onUpdate('size', v)} style={{ width: '100%' }} />
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>FONT SIZE (pt)</label>
            <InputNumber size="small" min={5} max={20} value={element.fontSize}
              onChange={v => onUpdate('fontSize', v)} style={{ width: '100%' }} />
          </div>

          <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={{ fontSize: 11, color: '#6b7280' }}>BOLD</label>
            <Switch size="small" checked={element.bold} onChange={v => onUpdate('bold', v)} />
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>PREFIX / LABEL</label>
            <Input size="small"
              value={element.prefix ?? ''}
              onChange={e => onUpdate('prefix', e.target.value)}
              placeholder={FIELD_META[element.id]?.defaultPrefix || 'e.g. Name:'}
              style={{ width: '100%' }} />
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
              Shown before value · leave blank for none
            </div>
          </div>
        </>
      )}

      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label style={{ fontSize: 11, color: '#6b7280' }}>VISIBLE</label>
        <Switch size="small" checked={element.visible} onChange={v => onUpdate('visible', v)} />
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function BarcodeSettings() {
  const [form] = Form.useForm();
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [preview, setPreview] = useState('');

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

  // Load barcode numbering settings only
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setLoadingSettings(true);
    try {
      const { data } = await settingsAPI.getBarcode();
      form.setFieldsValue(data.data);
      updatePreview(data.data);
    } catch (_) {}
    setLoadingSettings(false);
  };

  const updatePreview = (values) => {
    const prefix = values?.prefix || '';
    const number = values?.current_number || values?.starting_number || 1;
    const digits = values?.total_digits || 6;
    setPreview(`${prefix}${String(number).padStart(digits, '0')}`);
  };

  const handleSettingsSave = async (values) => {
    setSavingSettings(true);
    try {
      const { current_number, ...payload } = values;
      await settingsAPI.updateBarcode(payload);
      message.success('Barcode settings saved');
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
    <div>
      <Title level={3} style={{ marginBottom: 20 }}>Barcode Settings</Title>

      <Tabs defaultActiveKey="designer" items={[
        {
          key: 'designer',
          label: <span><BarcodeOutlined /> Label Designer</span>,
          children: (
            <div>
              {/* Toolbar */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: 'white', padding: '12px 16px', borderRadius: 10,
                border: '1px solid #e5e7eb', marginBottom: 16,
                flexWrap: 'wrap',
              }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginRight: 6 }}>SIZE:</label>
                  <Select value={labelSize} onChange={handleSizeChange} style={{ width: 200 }} size="small">
                    {Object.entries(LABEL_SIZES).map(([k, v]) => (
                      <Select.Option key={k} value={k}>{v.label}</Select.Option>
                    ))}
                  </Select>
                </div>

                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginRight: 6 }}>CODE TYPE:</label>
                  <Select value={codeType} onChange={v => { setCodeType(v); }} style={{ width: 140 }} size="small">
                    <Select.Option value="barcode">Barcode (1D)</Select.Option>
                    <Select.Option value="qrcode">QR Code (2D)</Select.Option>
                  </Select>
                </div>

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  <Button size="small" icon={<ReloadOutlined />} onClick={handleResetDesign}>
                    Reset
                  </Button>
                  <Button size="small" icon={<PrinterOutlined />} onClick={handleTestPrint}
                    loading={testPrinting} style={{ borderColor: '#059669', color: '#059669' }}>
                    Test Print
                  </Button>
                  <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSaveDesign}
                    style={{ background: '#4F46E5', borderColor: '#4F46E5' }}>
                    Save Design
                  </Button>
                </div>
              </div>

              {/* Designer body */}
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>

                {/* Fields panel */}
                <div style={{
                  width: 160, flexShrink: 0, background: 'white', borderRadius: 10,
                  border: '1px solid #e5e7eb', overflow: 'hidden',
                }}>
                  <div style={{ background: '#4F46E5', color: 'white', fontSize: 11, fontWeight: 700, padding: '8px 12px', letterSpacing: 0.5 }}>
                    FIELDS
                  </div>
                  {Object.entries(FIELD_META).map(([id, meta]) => {
                    const elem = elements.find(el => el.id === id);
                    const isVisible = elem?.visible ?? false;
                    return (
                      <div key={id}
                        onClick={() => { setSelectedId(id); }}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '7px 10px', borderBottom: '1px solid #f3f4f6',
                          background: selectedId === id ? '#eef2ff' : 'white',
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ fontSize: 12, color: isVisible ? '#111827' : '#9ca3af', fontWeight: selectedId === id ? 600 : 400 }}>
                          {meta.label}
                        </span>
                        <Tooltip title={isVisible ? 'Hide' : 'Show'}>
                          <span onClick={e => { e.stopPropagation(); handleToggleVisible(id); }}
                            style={{ cursor: 'pointer', color: isVisible ? '#4F46E5' : '#d1d5db', fontSize: 14 }}>
                            {isVisible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                          </span>
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>

                {/* Canvas area */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', background: '#f9fafb', padding: '4px 12px', borderRadius: 20, border: '1px solid #e5e7eb' }}>
                    {w}mm × {h}mm · Drag elements to reposition · Click to select
                  </div>
                  <LabelCanvas
                    labelSize={labelSize}
                    codeType={codeType}
                    elements={elements}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onMove={handleMove}
                  />
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>
                    Grid lines every 5mm
                  </div>
                </div>

                {/* Properties panel */}
                <div style={{
                  width: 180, flexShrink: 0, background: 'white', borderRadius: 10,
                  border: '1px solid #e5e7eb', overflow: 'hidden',
                }}>
                  <div style={{ background: '#f3f4f6', fontSize: 11, fontWeight: 700, padding: '8px 12px', color: '#374151', letterSpacing: 0.5 }}>
                    PROPERTIES
                  </div>
                  <PropertiesPanel
                    element={selectedElem}
                    labelSize={labelSize}
                    onUpdate={handleUpdateProp}
                  />
                </div>

              </div>

              {/* Legend */}
              <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {Object.entries(FIELD_META).filter(([id]) => elements.find(el => el.id === id)?.visible).map(([id, meta]) => (
                  <Tag key={id} color="geekblue" style={{ fontSize: 11 }}>{meta.label}</Tag>
                ))}
                <Tag color="default" style={{ fontSize: 11 }}>
                  Design applies to all barcode prints
                </Tag>
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
                        <Form.Item name="prefix" label="Prefix" rules={[{ required: true }]}>
                          <Input placeholder="e.g. PRD" />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item name="total_digits" label="Total Digits" rules={[{ required: true }]}>
                          <InputNumber min={4} max={12} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col xs={24} md={12}>
                        <Form.Item name="starting_number" label="Starting Number" rules={[{ required: true }]}>
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item name="current_number" label="Current Number">
                          <InputNumber disabled style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="format_pattern" label="Format Pattern">
                      <Input placeholder="e.g. {prefix}-{number}" />
                    </Form.Item>
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
                    <BarcodeOutlined style={{ fontSize: 48, color: '#4F46E5', marginBottom: 16 }} />
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
      ]} />
    </div>
  );
}
