import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Input, InputNumber, Modal, Segmented,
  Select, Space, Switch, Tooltip, message,
} from 'antd';
import {
  PlusOutlined, CopyOutlined, DeleteOutlined, SaveOutlined,
  PrinterOutlined, ReloadOutlined, StarFilled, StarOutlined,
  CheckCircleFilled,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { printAPI, settingsAPI } from '../../api';
import { renderBillHTML } from '../../services/printRenderer';
import { listPrinters, printRawHTML } from '../../services/printer';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';


const DOC_TYPES = [
  { v: 'sales',           l: 'Sales Invoice' },
  { v: 'purchase',        l: 'Purchase Bill' },
  { v: 'sales_return',    l: 'Credit Note (Sales Return)' },
  { v: 'purchase_return', l: 'Debit Note (Purchase Return)' },
  { v: 'receipt',         l: 'Payment Receipt' },
  { v: 'payment',         l: 'Payment Voucher' },
  { v: 'quotation',       l: 'Quotation' },
  { v: 'challan',         l: 'Delivery Challan' },
];

const FORMATS = [
  { v: 'a4',      l: 'A4 · 210 × 297 mm' },
  { v: 'a5',      l: 'A5 · 148 × 210 mm' },
  { v: 'thermal', l: 'Thermal · 80 mm roll' },
];

// Visual themes. Layout stays constant; only typography, borders, colors
// change. Each paired with a short description + a swatch of the accent
// color default so users can eye-pick before clicking.
const THEMES = [
  { v: 'cashmemo',  l: 'Cash Memo',  d: 'Classic Indian retail cash-memo — full-page hairline frame, big serif shop name, dedicated CASH-MEMO box top-right with bill no & date.', swatch: '#000000', isNew: true },
  { v: 'studio',    l: 'Studio',     d: 'Modern editorial — accent rule on title, airy whitespace, clean rows.',    swatch: '#21604C', isNew: true },
  { v: 'modern',    l: 'Modern',     d: 'Sans-serif, accent doc-type chip, pill-shaped grand-total bar.',           swatch: '#4F46E5' },
  { v: 'minimal',   l: 'Minimal',    d: 'Zero borders, soft greys, generous spacing — clean retail.',               swatch: '#6B7280' },
  { v: 'wholesale', l: 'Wholesale',  d: 'Dense tabular layout, monospace numeric columns, solid total bar — B2B.',  swatch: '#222222', isNew: true },
  { v: 'classic',   l: 'Classic',    d: 'Bordered cells, uppercase headers — traditional tax-invoice style.',       swatch: '#333333' },
  { v: 'elegant',   l: 'Elegant',    d: 'Times serif italic title, hairline rules — boutique professional.',        swatch: '#8B5CF6' },
  { v: 'boxed',     l: 'Boxed',      d: 'Full-page accent border, white-on-accent header — formal / legal.',        swatch: '#B1472F' },
];

// Thermal-specific styles shown when format='thermal'. These supersede the
// A4/A5 themes for receipt render — layout/font/weights are tuned for the
// paper width and the physical characteristics of thermal heads.
const THERMAL_STYLES = [
  { v: 'editorial', l: 'Editorial',  d: 'Magazine-style receipt — display-serif title, italic labels, bold body text, hairline separators. The boutique look.', isNew: true },
  { v: 'ruled',     l: 'Ruled',      d: 'Clean rows with a hairline below each item — clear separation without heavy boxed borders.', isNew: true },
  { v: 'simple',    l: 'Simple',     d: 'Tabular Sr · Item · Qty · Rate · Amt rows, dashed separators, no frills — the clean credit-memo look.' },
  { v: 'standard',  l: 'Standard',   d: 'Two-line items (name / qty × rate), dashed rules — classic POS feel.' },
  { v: 'compact',   l: 'Compact',    d: 'Tight spacing, smaller rows — fits long bills on short rolls.' },
  { v: 'bold',      l: 'Bold POS',   d: 'Uppercase headers, thick rules, heavy weights — maximum legibility.' },
  { v: 'spacious',  l: 'Spacious',   d: 'Generous padding and line-height — easy to read, premium feel.' },
  { v: 'modern',    l: 'Modern',     d: 'Sans-serif, inverted doc-type chip, black total banner.' },
];

// Font presets — a curated list that actually renders well on both screen
// and thermal paper. Users can still type a custom stack in the text input.
// Order matters — Source Sans 3 sits at the top because it's the
// software's own UI font. Picking it makes printed bills (thermal AND
// A4) match the on-screen typography. The classic monospace stacks
// remain available below for operators who prefer the traditional POS
// receipt look.
const FONT_PRESETS = [
  { v: "'Source Sans 3', 'Segoe UI', system-ui, sans-serif",  l: 'Source Sans 3 — matches the software (recommended)' },
  { v: "'Inter', 'Segoe UI', system-ui, sans-serif",          l: 'Inter (modern sans)' },
  { v: "'Helvetica Neue', Arial, sans-serif",                 l: 'Helvetica Neue' },
  { v: "'Arial Black', 'Arial Bold', sans-serif",             l: 'Arial Black (thickest)' },
  { v: "'Georgia', 'Times New Roman', serif",                 l: 'Georgia (serif)' },
  { v: "'Courier New', 'Consolas', monospace",                l: 'Courier (classic POS receipt)' },
  { v: "'Consolas', 'Menlo', 'Courier New', monospace",       l: 'Consolas (clean mono)' },
  { v: "'Roboto Mono', 'Courier New', monospace",             l: 'Roboto Mono' },
];

const BOLD_LEVELS = [
  { v: 'light',  l: 'Light' },
  { v: 'normal', l: 'Normal' },
  { v: 'bold',   l: 'Bold' },
  { v: 'heavy',  l: 'Heavy' },
];

// Sample bill used for preview only — never submitted. Shape matches what
// salesAPI.getById returns so renderBillHTML produces a realistic layout.
const sampleBill = (docType) => {
  if (docType === 'receipt' || docType === 'payment') {
    return {
      transaction_number: 'RCT-001',
      transaction_date: new Date().toISOString(),
      total_amount: 4500,
      party: { party_name: 'Sample Customer', mobile_1: '9876543210' },
    };
  }
  return {
    bill_number: 'SI-001',
    bill_date: new Date().toISOString(),
    sale_type: 'Retail',
    customer: {
      party_name: 'Sample Customer Pvt Ltd',
      address_line1: '12 Market Street',
      city: 'Mumbai', state: 'Maharashtra',
      gstin: '27AAAAA0000A1Z5',
      mobile_1: '9876543210',
    },
    supplier: {
      party_name: 'Sample Supplier Pvt Ltd',
      address_line1: '45 Trade Centre',
      city: 'Mumbai', state: 'Maharashtra',
      gstin: '27BBBBB0000B1Z5',
      mobile_1: '9876501234',
    },
    items: [
      { product_name: 'Cotton T-Shirt', hsn_code: '6109', quantity: 5, rate: 250, mrp: 399,
        discount_percentage: 10, cgst_amount: 28.12, sgst_amount: 28.12, igst_amount: 0, total_amount: 1181.25 },
      { product_name: 'Denim Jeans', hsn_code: '6203', quantity: 2, rate: 899, mrp: 1299,
        discount_percentage: 0, cgst_amount: 80.91, sgst_amount: 80.91, igst_amount: 0, total_amount: 1959.82 },
      { product_name: 'Formal Shirt', hsn_code: '6205', quantity: 3, rate: 499, mrp: 799,
        discount_percentage: 5, cgst_amount: 42.66, sgst_amount: 42.66, igst_amount: 0, total_amount: 1507.68 },
    ],
    sub_total: 4230,
    discount_amount: 181.25,
    cgst_amount: 151.69,
    sgst_amount: 151.69,
    igst_amount: 0,
    other_charges: 0,
    freight_charges: 0,
    round_off: 0.37,
    total_amount: 4648.75,
    // Sample values so every toggleable row has data to preview:
    // return_amount   — goods the customer returned within this sale
    // paid_amount     — partial payment (leaves a Balance Due)
    // previous_balance — prior outstanding the customer carries forward
    return_amount: 386,
    paid_amount: 2000,
    balance_amount: 2262.75,
    previous_balance: 1250,
  };
};

// On screen the printer's page margins don't exist, so the bill would run
// edge to edge. Pad the preview copy (screen only) by the margins so it
// looks like the printed page. Printing still uses the untouched HTML.
const onPaper = (html, p) => {
  const thermal = p.format === 'thermal';
  const m = (k, d) => (p[k] ?? d);
  const pad = `${m('margin_top_mm', thermal ? 3 : 10)}mm ${m('margin_right_mm', thermal ? 3 : 10)}mm ${m('margin_bottom_mm', thermal ? 3 : 10)}mm ${m('margin_left_mm', thermal ? 3 : 10)}mm`;
  const css = `<style>@media screen{html,body{background:#fff}body{box-sizing:border-box;margin:0!important;padding:${pad}!important}}</style>`;
  return html.includes('</head>') ? html.replace('</head>', `${css}</head>`) : css + html;
};

const blankProfile = (docType = 'sales') => ({
  name: 'New profile', doc_type: docType, format: 'a4', is_default: false,
  theme: 'classic', accent_color: '#111111',
  thermal_style: 'simple', bold_level: 'bold',
  paper_width_mm: 210, paper_height_mm: 297,
  margin_top_mm: 10, margin_right_mm: 10, margin_bottom_mm: 10, margin_left_mm: 10,
  font_family: "'Source Sans 3', system-ui, sans-serif", font_size_pt: 10, line_spacing: 1.35,
  show_logo: true, header_title: '', header_html: '', header_align: 'center',
  doc_label: '',
  show_hsn: true, show_batch: false, show_mrp: true, show_discount: true,
  show_tax_breakdown: true, show_gst: true, show_return_amount: true,
  show_previous_balance: false,
  show_barcode: false, show_qr_upi: false, upi_id: '',
  tax_summary_mode: 'consolidated',
  footer_html: '', show_signature: true, signature_label: 'Authorised Signatory',
  bank_details: '', terms_and_conditions: '',
  copies: 1, copy_labels: 'Original',
  currency_symbol: 'Rs ', locale_format: 'en-IN',
  printer_name: '', silent_print: true,
});

export default function PrintSettings() {
  const navigate = useNavigate();
  const [profiles,   setProfiles]   = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft,      setDraft]      = useState(blankProfile());
  const [dirty,      setDirty]      = useState(false);
  const [printers,   setPrinters]   = useState([]);
  const [printerErr, setPrinterErr] = useState('');
  const [company,    setCompany]    = useState({});
  const [tab,        setTab]        = useState('style');
  const [zoom,       setZoom]       = useState('fit');
  const [docH,       setDocH]       = useState(0);
  const [docW,       setDocW]       = useState(0);
  const [deskW,      setDeskW]      = useState(0);

  const iframeRef = useRef(null);
  const deskRef   = useRef(null);

  // The preview page is scaled to fit the desk; track the desk's width.
  useEffect(() => {
    const el = deskRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setDeskW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Height of the rendered bill, so the paper is exactly as long as it.
  const measureDoc = () => {
    try {
      const d = iframeRef.current?.contentDocument;
      const h = d ? Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight || 0) : 0;
      const w = d ? Math.max(d.documentElement.scrollWidth, d.body?.scrollWidth || 0) : 0;
      if (h) setDocH(h);
      setDocW(w);
    } catch { /* srcdoc is same-origin; nothing to do */ }
  };

  /* ── load everything on mount ────────────────────────────────── */

  const refreshPrinters = () => {
    listPrinters().then(res => {
      setPrinters(res.printers || []);
      setPrinterErr(res.error || '');
    });
  };

  useEffect(() => {
    loadProfiles();
    refreshPrinters();
    settingsAPI.getSystem().then(r => setCompany(r.data?.data || r.data || {})).catch(() => {});
  }, []);

  const loadProfiles = async () => {
    try {
      const r = await printAPI.list();
      const rows = r.data?.data || [];
      setProfiles(rows);
      if (rows.length && !selectedId) selectProfile(rows[0]);
      else if (selectedId) {
        const updated = rows.find(p => p.profile_id === selectedId);
        if (updated) selectProfile(updated, false);
      }
    } catch (e) {
      message.error('Could not load print profiles');
    }
  };

  const selectProfile = (row, resetDirty = true) => {
    setSelectedId(row.profile_id || null);
    setDraft({ ...row });
    if (resetDirty) setDirty(false);
  };

  const newProfile = (docType = 'sales') => {
    setSelectedId(null);
    setDraft(blankProfile(docType));
    setDirty(true);
  };

  /* ── live preview ────────────────────────────────────────────── */

  const previewHTML = useMemo(() => {
    try {
      return renderBillHTML({
        bill: sampleBill(draft.doc_type),
        profile: draft,
        company,
        docType: draft.doc_type,
      });
    } catch (e) {
      return `<pre style="padding:20px;color:red">Preview error: ${e.message}</pre>`;
    }
  }, [draft, company]);

  useEffect(() => {
    // Let the paper shrink to the new bill's length before it is measured.
    setDocH(0);
    setDocW(0);
    if (iframeRef.current) iframeRef.current.srcdoc = onPaper(previewHTML, draft);
  }, [previewHTML]);

  /* ── field edit helper ───────────────────────────────────────── */

  const set = (key, value) => {
    setDraft(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  // Format preset — drops sensible margins/sizes when user switches
  // between A4 / A5 / Thermal so they don't have to tweak 4 inputs.
  const applyFormat = (f) => {
    if (f === 'a4') {
      setDraft(prev => ({ ...prev, format: 'a4',
        paper_width_mm: 210, paper_height_mm: 297,
        margin_top_mm: 10, margin_right_mm: 10, margin_bottom_mm: 10, margin_left_mm: 10,
        font_size_pt: 10 }));
    } else if (f === 'a5') {
      setDraft(prev => ({ ...prev, format: 'a5',
        paper_width_mm: 148, paper_height_mm: 210,
        margin_top_mm: 8, margin_right_mm: 8, margin_bottom_mm: 8, margin_left_mm: 8,
        font_size_pt: 9 }));
    } else if (f === 'thermal') {
      setDraft(prev => ({ ...prev, format: 'thermal',
        paper_width_mm: 80, paper_height_mm: 0,
        margin_top_mm: 3, margin_right_mm: 3, margin_bottom_mm: 3, margin_left_mm: 3,
        // Match the software's UI typography by default. Tabular numerals
        // in the thermal CSS keep numeric columns aligned even on a
        // proportional sans-serif. Operators who want the classic Courier
        // POS look can still pick that from the Font preset list.
        font_family: "'Source Sans 3', 'Segoe UI', system-ui, sans-serif",
        font_size_pt: 10, line_spacing: 1.3,
        thermal_style: prev.thermal_style || 'simple',
        bold_level:    prev.bold_level    || 'bold',
        show_hsn: false, show_mrp: false, show_tax_breakdown: false,
        tax_summary_mode: 'consolidated' }));
    }
    setDirty(true);
  };

  /* ── persistence ─────────────────────────────────────────────── */

  const handleSave = async () => {
    if (!draft.name?.trim()) { message.error('Profile name is required'); return; }
    try {
      if (selectedId) await printAPI.update(selectedId, draft);
      else {
        const r = await printAPI.create(draft);
        setSelectedId(r.data?.data?.profile_id);
      }
      message.success('Profile saved');
      setDirty(false);
      loadProfiles();
    } catch (e) {
      message.error('Save failed: ' + (e?.response?.data?.error || e.message));
    }
  };

  const handleDelete = () => {
    if (!selectedId) { setDraft(blankProfile()); setDirty(false); return; }
    Modal.confirm({
      title: 'Delete this profile?',
      content: `"${draft.name}" will be permanently removed.`,
      okText: 'Delete', okButtonProps: { danger: true },
      className: 'erp-confirm-modal',
      onOk: async () => {
        try {
          await printAPI.remove(selectedId);
          message.success('Deleted');
          setSelectedId(null);
          setDraft(blankProfile());
          loadProfiles();
        } catch (e) {
          message.error('Delete failed: ' + (e?.response?.data?.error || e.message));
        }
      },
    });
  };

  const handleDuplicate = async () => {
    if (!selectedId) { message.warning('Save first, then duplicate'); return; }
    try {
      const r = await printAPI.duplicate(selectedId);
      const copy = r.data?.data;
      message.success('Duplicated');
      loadProfiles();
      if (copy) setTimeout(() => selectProfile(copy), 200);
    } catch (e) {
      message.error('Duplicate failed: ' + (e?.response?.data?.error || e.message));
    }
  };

  const handleSetDefault = async () => {
    if (!selectedId) { message.warning('Save first'); return; }
    try {
      await printAPI.update(selectedId, { ...draft, is_default: true });
      message.success('Set as default for ' + (DOC_TYPES.find(d => d.v === draft.doc_type)?.l || draft.doc_type));
      loadProfiles();
    } catch (e) {
      message.error('Update failed: ' + (e?.response?.data?.error || e.message));
    }
  };

  const handleTestPrint = () => {
    printRawHTML(previewHTML, { silent: draft.silent_print, deviceName: draft.printer_name });
  };


  /* ── render ──────────────────────────────────────────────────── */

  const isThermal = draft.format === 'thermal';
  const docLabel = (v) => DOC_TYPES.find(d => d.v === v)?.l || v;
  const fmtShort = (f) => (f === 'thermal' ? '80 mm' : String(f || '').toUpperCase());

  // Templates grouped by document type, in DOC_TYPES order, unknown types last.
  const groups = [
    ...DOC_TYPES.map(d => ({ key: d.v, label: d.l, items: profiles.filter(p => p.doc_type === d.v) })),
    { key: '_other', label: 'Other', items: profiles.filter(p => !DOC_TYPES.some(d => d.v === p.doc_type)) },
  ].filter(g => g.items.length);

  const styleKey = isThermal ? 'thermal_style' : 'theme';
  const styleList = isThermal ? THERMAL_STYLES : THEMES;
  // Accent follows the theme's own colour until the operator picks one.
  const autoAccent = !draft.accent_color || draft.accent_color === '#111111'
    || THEMES.some(th => th.swatch === draft.accent_color);
  const pickStyle = (t) => {
    set(styleKey, t.v);
    if (!isThermal && autoAccent) set('accent_color', t.swatch);
  };

  // Live thumbnails of every style, rendered from this template's own
  // settings. Re-rendered only when something other than the chosen
  // style or the name changes.
  const thumbKey = JSON.stringify({ ...draft, name: '', theme: '', thermal_style: '', printer_name: '', silent_print: '' });
  const thumbs = useMemo(() => styleList.map((t) => {
    const profile = { ...draft, [styleKey]: t.v };
    if (!isThermal && autoAccent) profile.accent_color = t.swatch;
    try {
      return { ...t, html: onPaper(renderBillHTML({ bill: sampleBill(draft.doc_type), profile, company, docType: draft.doc_type }), profile) };
    } catch { return { ...t, html: '' }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [thumbKey, isThermal, company]);

  const sheetPx = Math.round((draft.paper_width_mm || (isThermal ? 80 : 210)) * 96 / 25.4);
  const paperPx = Math.max(sheetPx, docW || 0);
  const pageMinPx = draft.paper_height_mm > 0 ? Math.round(draft.paper_height_mm * 96 / 25.4) : 0;
  const docPx = Math.max(docH || 0, pageMinPx, 200);
  const fitScale = deskW ? Math.min(isThermal ? 1.25 : 1, (deskW - 56) / paperPx) : 0.5;
  const scale = zoom === 'fit' ? Math.max(0.2, fitScale) : 1;

  const SUBTITLES = {
    sales: 'TAX INVOICE', purchase: 'PURCHASE BILL', sales_return: 'CREDIT NOTE',
    purchase_return: 'DEBIT NOTE', receipt: 'RECEIPT', payment: 'PAYMENT VOUCHER',
    quotation: 'QUOTATION', challan: 'DELIVERY CHALLAN',
  };
  const defaultSubtitle = SUBTITLES[draft.doc_type] || 'DOCUMENT';

  const SECTIONS = [
    { value: 'style',   label: 'Style' },
    { value: 'paper',   label: 'Paper' },
    { value: 'header',  label: 'Header' },
    { value: 'footer',  label: 'Footer' },
    { value: 'fields',  label: 'Columns' },
    { value: 'printer', label: 'Printer' },
  ];

  return (
    <div className="ms-shell ms-wide settings-pane-fill pt-page">
      <style>{PRINT_STYLES}</style>
      <header className="ms-page-header">
        <div className="ms-page-header-row">
          <div>
            <h1 className="ms-page-title">Print Templates</h1>
            <p className="ms-page-sub">How your bills, receipts and vouchers look on paper. Every change shows on the page at the right.</p>
          </div>
          <Space>
            <Tooltip title="Reload templates"><Button icon={<ReloadOutlined />} onClick={loadProfiles} /></Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => newProfile(draft.doc_type || 'sales')}>New Template</Button>
          </Space>
        </div>
      </header>

      <div className="pt-work">
        {/* ── Templates, grouped by document ───────────────── */}
        <aside className="pt-pane pt-list">
          {groups.length === 0 && (
            <div className="pt-empty">No templates yet. Press <b>New Template</b> to make one.</div>
          )}
          {groups.map(g => (
            <div key={g.key} className="pt-group">
              <div className="pt-group-label">{g.label}</div>
              {g.items.map(p => {
                const active = p.profile_id === selectedId;
                return (
                  <button type="button" key={p.profile_id} onClick={() => selectProfile(p)}
                          className={`pt-item${active ? ' is-active' : ''}`}>
                    <span className={`pt-glyph is-${p.format}`}><i />{fmtShort(p.format)}</span>
                    <span className="pt-item-text">
                      <span className="pt-item-name">{p.name}</span>
                      {p.is_default && <span className="pt-item-default"><StarFilled /> Default</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {!selectedId && (
            <div className="pt-group">
              <div className="pt-group-label">New</div>
              <div className="pt-item is-active">
                <span className={`pt-glyph is-${draft.format}`}><i />{fmtShort(draft.format)}</span>
                <span className="pt-item-text"><span className="pt-item-name">{draft.name || 'New template'}</span></span>
              </div>
            </div>
          )}
        </aside>

        {/* ── Editor ──────────────────────────────────────── */}
        <section className="pt-pane pt-editor">
          <div className="pt-ed-head">
            <div className="pt-ed-title">
              <input className="pt-name" value={draft.name} placeholder="Template name"
                     onChange={e => set('name', e.target.value)} aria-label="Template name" />
              <div className="pt-ed-sub">
                {docLabel(draft.doc_type)} · {FORMATS.find(f => f.v === draft.format)?.l || draft.format}
                {draft.is_default && <span className="pt-badge"><StarFilled /> Default</span>}
                {dirty && <span className="pt-dirty">Unsaved changes</span>}
              </div>
            </div>
            <Space size={6}>
              {!draft.is_default && selectedId && (
                <Tooltip title={`Print ${docLabel(draft.doc_type)} with this template automatically`}>
                  <Button icon={<StarOutlined />} onClick={handleSetDefault}>Make default</Button>
                </Tooltip>
              )}
              <Tooltip title="Duplicate"><Button icon={<CopyOutlined />} onClick={handleDuplicate} disabled={!selectedId} /></Tooltip>
              <Tooltip title="Delete"><Button icon={<DeleteOutlined />} onClick={handleDelete} /></Tooltip>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
            </Space>
          </div>

          <div className="pt-seg-wrap">
            <Segmented block value={tab} onChange={setTab} options={SECTIONS} className="pt-seg" />
          </div>

          <div className="pt-ed-body">
            {tab === 'style' && (<>
              <PGroup title={isThermal ? 'Receipt style' : 'Invoice style'}
                      desc={isThermal ? 'Tuned for 80 mm thermal rolls.' : 'Layout stays the same; type, rules and colour change.'}>
                <div className={`pt-gallery${isThermal ? ' is-roll' : ''}`}>
                  {thumbs.map(t => {
                    const active = draft[styleKey] === t.v;
                    return (
                      <button type="button" key={t.v} onClick={() => pickStyle(t)}
                              className={`pt-thumb${active ? ' is-active' : ''}`} title={t.d}>
                        <Thumb html={t.html} paperPx={sheetPx} roll={isThermal} />
                        <span className="pt-thumb-cap">
                          <span className="pt-thumb-name">{t.l}</span>
                          {t.isNew && <span className="pt-new">New</span>}
                          {active && <CheckCircleFilled className="pt-thumb-check" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="pt-style-desc">{styleList.find(t => t.v === draft[styleKey])?.d}</div>
              </PGroup>

              {isThermal && (
                <PGroup title="Print darkness">
                  <div className="pt-stack">
                    <Segmented block value={draft.bold_level || 'bold'} onChange={v => set('bold_level', v)}
                               options={BOLD_LEVELS.map(b => ({ value: b.v, label: b.l }))} />
                    <div className="pt-note">Thermal paper prints as dark as the letters are heavy. Too faint: try <b>Heavy</b>. Letters running together: try <b>Normal</b>.</div>
                  </div>
                </PGroup>
              )}

              <PGroup>
                <PRow label="Accent colour"
                      desc={isThermal
                        ? 'Body text always prints pure black. The accent only colours the Modern style\'s chip and total banner.'
                        : 'Colours headings on Modern, Elegant and Minimal, and the whole header on Boxed.'}>
                  <label className="pt-swatch" style={{ background: draft.accent_color || '#111111' }}>
                    <input type="color" value={draft.accent_color || '#111111'} onChange={e => set('accent_color', e.target.value)} />
                  </label>
                  <Input value={draft.accent_color || ''} onChange={e => set('accent_color', e.target.value)}
                         placeholder="#111111" style={{ width: 104 }} />
                  {!isThermal && (
                    <Button type="link" size="small" onClick={() => set('accent_color', THEMES.find(t => t.v === draft.theme)?.swatch || '#111111')}>Reset</Button>
                  )}
                </PRow>
              </PGroup>
            </>)}

            {tab === 'paper' && (<>
              <PGroup title="Document">
                <PRow label="Used for">
                  <Select value={draft.doc_type} onChange={v => set('doc_type', v)} style={{ width: 230 }}
                          options={DOC_TYPES.map(d => ({ value: d.v, label: d.l }))} />
                </PRow>
                <PStack label="Paper" desc="Picking one sets the size, margins and text to suit it.">
                  <Segmented block value={draft.format} onChange={applyFormat}
                             options={[{ value: 'a4', label: 'A4' }, { value: 'a5', label: 'A5' }, { value: 'thermal', label: '80 mm roll' }]} />
                </PStack>
              </PGroup>

              <PGroup title="Size and margins" desc="In millimetres.">
                <PRow label="Width × height" desc="Height 0 means a continuous roll.">
                  <InputNumber value={draft.paper_width_mm} onChange={v => set('paper_width_mm', v)} min={20} max={500} style={{ width: 88 }} />
                  <span className="pt-x">×</span>
                  <InputNumber value={draft.paper_height_mm} onChange={v => set('paper_height_mm', v)} min={0} max={800} style={{ width: 88 }} />
                </PRow>
                <PStack label="Margins">
                  <div className="pt-margins">
                    {[['margin_top_mm', 'Top'], ['margin_right_mm', 'Right'], ['margin_bottom_mm', 'Bottom'], ['margin_left_mm', 'Left']].map(([k, l]) => (
                      <label key={k}><InputNumber value={draft[k]} onChange={v => set(k, v)} min={0} max={50} style={{ width: 64 }} /><span>{l}</span></label>
                    ))}
                  </div>
                </PStack>
              </PGroup>

              <PGroup title="Text">
                <PRow label="Font">
                  <Select value={FONT_PRESETS.find(f => f.v === draft.font_family)?.v}
                          onChange={v => set('font_family', v)} style={{ width: 290 }}
                          placeholder="Custom font (see below)"
                          options={FONT_PRESETS.map(f => ({ value: f.v, label: f.l }))} />
                </PRow>
                <PRow label="Size and line height">
                  <InputNumber value={draft.font_size_pt} onChange={v => set('font_size_pt', v)} min={6} max={20} step={0.5} addonAfter="pt" style={{ width: 110 }} />
                  <InputNumber value={draft.line_spacing} onChange={v => set('line_spacing', v)} min={1} max={2} step={0.05} style={{ width: 80 }} />
                </PRow>
                <PStack label="Custom font stack" desc="Overrides the font above. For example 'Source Sans 3', system-ui, sans-serif">
                  <Input value={draft.font_family} onChange={e => set('font_family', e.target.value)} />
                </PStack>
              </PGroup>

              <PGroup title="Copies">
                <PRow label="Copies per print">
                  <InputNumber value={draft.copies} onChange={v => set('copies', v)} min={1} max={5} style={{ width: 80 }} />
                </PRow>
                <PStack label="Copy names" desc="Printed on each copy in turn, separated by commas.">
                  <Input value={draft.copy_labels} onChange={e => set('copy_labels', e.target.value)} placeholder="Original, Duplicate, Triplicate" />
                </PStack>
              </PGroup>
            </>)}

            {tab === 'header' && (<>
              <PGroup title="Header">
                <PRow label="Show company logo" desc="The logo from Company Profile.">
                  <Switch checked={draft.show_logo} onChange={v => set('show_logo', v)} />
                </PRow>
                <PRow label="Alignment">
                  <Segmented value={draft.header_align || 'center'} onChange={v => set('header_align', v)}
                             options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} />
                </PRow>
                <PStack label="Title" desc="Blank prints your company name.">
                  <Input value={draft.header_title} onChange={e => set('header_title', e.target.value)} placeholder={company.company_name || 'Company name'} />
                </PStack>
                <PStack label="Document heading" desc={`Blank prints "${defaultSubtitle}". Composition dealers often use BILL OF SUPPLY; some shops use ESTIMATE.`}>
                  <Input value={draft.doc_label} onChange={e => set('doc_label', e.target.value)} placeholder={defaultSubtitle} maxLength={60} />
                </PStack>
                <PStack label="Extra header line" desc="A slogan or second line of details. HTML allowed.">
                  <Input.TextArea rows={2} value={draft.header_html} onChange={e => set('header_html', e.target.value)} />
                </PStack>
              </PGroup>
            </>)}

            {tab === 'footer' && (<>
              <PGroup title="Footer">
                <PStack label="Closing message" desc="Shown at the bottom of every bill.">
                  <Input.TextArea rows={2} value={draft.footer_html} onChange={e => set('footer_html', e.target.value)} placeholder="Thank You !!!  Come Again. :)" />
                </PStack>
                <PStack label="Bank details">
                  <Input.TextArea rows={3} value={draft.bank_details} onChange={e => set('bank_details', e.target.value)} placeholder={'Bank: HDFC\nA/C: 12345\nIFSC: HDFC0001234'} />
                </PStack>
                <PStack label="Terms and conditions">
                  <Input.TextArea rows={3} value={draft.terms_and_conditions} onChange={e => set('terms_and_conditions', e.target.value)} />
                </PStack>
                <PRow label="Signature line">
                  <Switch checked={draft.show_signature} onChange={v => set('show_signature', v)} />
                </PRow>
                {draft.show_signature && (
                  <PRow label="Signature caption">
                    <Input value={draft.signature_label} onChange={e => set('signature_label', e.target.value)} style={{ width: 230 }} />
                  </PRow>
                )}
              </PGroup>
            </>)}

            {tab === 'fields' && (<>
              <PGroup title="Item columns" desc="A4 and A5 only. Thermal receipts keep their own compact columns.">
                <PRow label="HSN code"><Switch checked={draft.show_hsn} onChange={v => set('show_hsn', v)} /></PRow>
                <PRow label="MRP"><Switch checked={draft.show_mrp} onChange={v => set('show_mrp', v)} /></PRow>
                <PRow label="Batch"><Switch checked={draft.show_batch} onChange={v => set('show_batch', v)} /></PRow>
                <PRow label="Tax per item" desc="CGST, SGST and IGST columns on every line.">
                  <Switch checked={draft.show_tax_breakdown} onChange={v => set('show_tax_breakdown', v)} />
                </PRow>
                <PRow label="Barcode"><Switch checked={draft.show_barcode} onChange={v => set('show_barcode', v)} /></PRow>
                <PRow label="UPI QR code" desc="Customers scan it to pay.">
                  <Switch checked={draft.show_qr_upi} onChange={v => set('show_qr_upi', v)} />
                </PRow>
                {draft.show_qr_upi && (
                  <PRow label="UPI ID">
                    <Input value={draft.upi_id} onChange={e => set('upi_id', e.target.value)} placeholder="yourname@bank" style={{ width: 230 }} />
                  </PRow>
                )}
              </PGroup>

              <PGroup title="Totals" desc="All papers, thermal included.">
                <PRow label="Discount"><Switch checked={draft.show_discount !== false} onChange={v => set('show_discount', v)} /></PRow>
                <PRow label="GST"><Switch checked={draft.show_gst !== false} onChange={v => set('show_gst', v)} /></PRow>
                <PRow label="Return amount" desc="Goods returned within this sale. Hidden by itself when there is none.">
                  <Switch checked={draft.show_return_amount !== false} onChange={v => set('show_return_amount', v)} />
                </PRow>
                <PRow label="Previous balance" desc="What the customer already owed from earlier bills.">
                  <Switch checked={draft.show_previous_balance === true} onChange={v => set('show_previous_balance', v)} />
                </PRow>
              </PGroup>

              <PGroup title="Tax and numbers">
                <PRow label="Tax summary">
                  <Select value={draft.tax_summary_mode} onChange={v => set('tax_summary_mode', v)} style={{ width: 230 }}
                          options={[{ value: 'consolidated', label: 'Totals only' }, { value: 'lineWise', label: 'Line by line' }]} />
                </PRow>
                <PRow label="Currency symbol">
                  <Input value={draft.currency_symbol} onChange={e => set('currency_symbol', e.target.value)} style={{ width: 80 }} />
                </PRow>
                <PRow label="Number style">
                  <Select value={draft.locale_format} onChange={v => set('locale_format', v)} style={{ width: 230 }}
                          options={[
                            { value: 'en-IN', label: 'Indian · 1,00,000.00' },
                            { value: 'en-US', label: 'US · 100,000.00' },
                            { value: 'en-GB', label: 'UK · 100,000.00' },
                          ]} />
                </PRow>
              </PGroup>
            </>)}

            {tab === 'printer' && (<>
              <PGroup title="Printer">
                <PRow label="Print to">
                  <Select value={draft.printer_name || undefined} onChange={v => set('printer_name', v || '')}
                          style={{ width: 200 }} allowClear showSearch
                          placeholder={printers.length ? 'System default' : 'No printers found'}
                          options={printers.map(p => ({ value: p.name, label: `${p.displayName || p.name}${p.isDefault ? ' (default)' : ''}` }))} />
                  <Tooltip title="Look for printers again"><Button icon={<ReloadOutlined />} onClick={refreshPrinters} /></Tooltip>
                </PRow>
                <PStack label="Or type the printer's name" desc="Exactly as Windows shows it in Devices and Printers. Blank uses the system default.">
                  <Input value={draft.printer_name || ''} onChange={e => set('printer_name', e.target.value)} placeholder="e.g. POS-80C" />
                </PStack>
                <PRow label="Print without asking" desc="Sends the bill straight to the printer, no print dialog. Needs the desktop app.">
                  <Switch checked={draft.silent_print} onChange={v => set('silent_print', v)} />
                </PRow>
                {(printerErr || !printers.length) && (
                  <div className="pt-callout">
                    {printerErr
                      ? <>Could not list printers: {printerErr}</>
                      : <>No printers were found. Install the printer's Windows driver (for USB thermal printers, the vendor driver or "Generic / Text Only"), then press refresh.</>}
                  </div>
                )}
              </PGroup>
              <PGroup>
                <PRow label="Test print" desc="Prints the sample on the right with these settings.">
                  <Button icon={<PrinterOutlined />} onClick={handleTestPrint}>Print sample</Button>
                </PRow>
              </PGroup>
            </>)}
          </div>
        </section>

        {/* ── Preview: the page on a desk ─────────────────── */}
        <section className="pt-pane pt-preview">
          <div className="pt-pv-bar">
            <span className="pt-pv-title">Preview</span>
            <span className="pt-chip">{isThermal ? '80 mm roll' : String(draft.format).toUpperCase()}</span>
            <span style={{ flex: 1 }} />
            <Segmented size="small" value={zoom} onChange={setZoom}
                       options={[{ value: 'fit', label: 'Fit' }, { value: 'actual', label: '100%' }]} />
            <Tooltip title="Print this sample"><Button size="small" icon={<PrinterOutlined />} onClick={handleTestPrint} /></Tooltip>
          </div>
          <div className="pt-desk" ref={deskRef}>
            <div className={`pt-paper${isThermal ? ' is-roll' : ''}`}
                 style={{ width: paperPx * scale, height: docPx * scale }}>
              <iframe
                ref={iframeRef}
                title="print-preview"
                onLoad={measureDoc}
                style={{ width: paperPx, height: docPx, transform: `scale(${scale})` }}
              />
            </div>
          </div>
        </section>
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: () => navigate('/') },
          { id: 'save', key: 'F1', label: 'Save', tone: 'primary', disabled: !dirty, onAction: handleSave },
        ]}
      />
    </div>
  );
}

/* ── Small layout pieces (same rhythm as the other settings pages) ── */

function PGroup({ title, desc, children }) {
  return (
    <div className="pt-group-card">
      {(title || desc) && (
        <div className="pt-gc-head">
          {title && <div className="pt-gc-title">{title}</div>}
          {desc && <div className="pt-gc-desc">{desc}</div>}
        </div>
      )}
      <div className="pt-gc-body">{children}</div>
    </div>
  );
}

function PRow({ label, desc, children }) {
  return (
    <div className="pt-row">
      <div className="pt-row-text">
        <div className="pt-row-label">{label}</div>
        {desc && <div className="pt-row-desc">{desc}</div>}
      </div>
      <div className="pt-row-ctl">{children}</div>
    </div>
  );
}

function PStack({ label, desc, children }) {
  return (
    <div className="pt-row is-stack">
      <div className="pt-row-label">{label}</div>
      {desc && <div className="pt-row-desc">{desc}</div>}
      <div className="pt-stack-ctl">{children}</div>
    </div>
  );
}

// A style thumbnail: the real rendered page, shrunk, top part only.
function Thumb({ html, paperPx, roll }) {
  const [wide, setWide] = useState(0);
  const px = Math.max(paperPx, wide);
  const W = roll ? 120 : 150;
  const H = roll ? 150 : 190;
  const s = W / px;
  const onLoad = (e) => {
    try {
      const d = e.currentTarget.contentDocument;
      setWide(Math.max(d.documentElement.scrollWidth, d.body?.scrollWidth || 0));
    } catch { /* same-origin srcdoc */ }
  };
  return (
    <span className="pt-thumb-paper" style={{ width: W, height: H }}>
      <iframe title="style" srcDoc={html} tabIndex={-1} aria-hidden="true" onLoad={onLoad}
              style={{ width: px, height: H / s, transform: `scale(${s})` }} />
    </span>
  );
}

const PRINT_STYLES = `
.pt-page { --set-col: 1440px; }

/* Three panes fill the height under the header; each scrolls alone. */
.pt-work {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 212px minmax(390px, 1fr) minmax(300px, 1.08fr);
  gap: 16px;
  padding: 4px var(--set-pad) 18px;
}
.pt-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(20, 14, 8, 0.04);
  overflow: hidden;
}

/* ── Template list ── */
.pt-list { overflow-y: auto; padding: 8px 8px 14px; }
.pt-group { margin-top: 6px; }
.pt-group-label {
  padding: 8px 10px 5px;
  font-size: 11px; font-weight: 600;
  color: var(--fg-tertiary);
}
.pt-item {
  width: 100%;
  display: flex; align-items: center; gap: 10px;
  padding: 7px 8px;
  border: 0; border-radius: 9px;
  background: transparent;
  font: inherit; text-align: left;
  color: var(--fg-primary);
  cursor: pointer;
  transition: background .12s ease;
}
.pt-item:hover { background: var(--bg-hover); }
.pt-item.is-active { background: var(--accent-bg); }
.pt-item.is-active .pt-item-name { color: var(--accent); }
.pt-item-text { display: flex; flex-direction: column; min-width: 0; }
.pt-item-name {
  font-size: 13px; font-weight: 600; line-height: 1.3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pt-item-default { font-size: 11px; color: var(--fg-tertiary); display: inline-flex; align-items: center; gap: 4px; }
.pt-item-default .anticon { color: #e0a224; font-size: 10px; }
.pt-empty { padding: 28px 14px; text-align: center; font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.5; }

/* Paper glyph — proportions hint at the paper. */
.pt-glyph {
  flex: 0 0 34px;
  display: inline-flex; flex-direction: column; align-items: center; gap: 2px;
  font-size: 9px; font-weight: 700; letter-spacing: .02em;
  color: var(--fg-tertiary);
}
.pt-glyph i {
  display: block;
  background: #fff;
  border: 1px solid var(--border-strong);
  border-radius: 2px;
  box-shadow: 0 1px 2px rgba(0,0,0,.08);
  width: 20px; height: 26px;
}
.pt-glyph.is-a5 i { width: 16px; height: 21px; }
.pt-glyph.is-thermal i {
  width: 12px; height: 26px; border-bottom: 0; border-radius: 2px 2px 0 0;
  background: linear-gradient(#fff 0 0) top / 100% 22px no-repeat,
              conic-gradient(from 135deg at 50% 0, #fff 90deg, transparent 0) bottom / 4px 4px repeat-x;
}
.pt-item.is-active .pt-glyph { color: var(--accent); }
.pt-item.is-active .pt-glyph i { border-color: var(--accent); }

/* ── Editor ── */
.pt-ed-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 14px 16px 10px;
}
.pt-ed-title { min-width: 0; flex: 1; }
.pt-name {
  width: 100%;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent;
  padding: 2px 6px; margin-left: -6px;
  font: inherit; font-size: 18px; font-weight: 700; letter-spacing: -0.015em;
  color: var(--fg-primary);
  outline: none;
  transition: border-color .12s ease, background .12s ease;
}
.pt-name:hover { border-color: var(--border-subtle); }
.pt-name:focus { border-color: var(--accent); background: var(--bg-app); }
.pt-ed-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 2px; font-size: 12px; color: var(--fg-tertiary); }
.pt-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: 99px;
  background: color-mix(in srgb, #e0a224 16%, transparent); color: #a8730a;
  font-size: 11px; font-weight: 600;
}
[data-theme$="-dark"] .pt-badge { color: #f0c35a; }
.pt-dirty { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); font-weight: 600; }
.pt-dirty::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }

.pt-seg-wrap { padding: 0 16px 12px; border-bottom: 1px solid var(--border-subtle); }
.pt-seg.ant-segmented { padding: 3px; border-radius: 10px; background: var(--bg-muted); }
.pt-seg .ant-segmented-item { border-radius: 8px; }
.pt-seg .ant-segmented-item-label { font-size: 12.5px; font-weight: 600; min-height: 30px; line-height: 30px; padding: 0 2px; }

.pt-ed-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 24px; background: var(--bg-app); }

.pt-group-card {
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  margin-bottom: 14px;
}
.pt-gc-head { padding: 12px 16px 10px; border-bottom: 1px solid var(--border-subtle); }
.pt-gc-title { font-size: 13.5px; font-weight: 650; color: var(--fg-primary); }
.pt-gc-desc { margin-top: 2px; font-size: 12px; color: var(--fg-tertiary); line-height: 1.45; }
.pt-gc-body { padding: 0 16px; }
.pt-gc-body > .pt-gallery:first-child { margin-top: 14px; }

.pt-row {
  display: flex; align-items: center; justify-content: space-between; gap: 18px;
  min-height: 50px; padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.pt-row:last-child { border-bottom: 0; }
.pt-row-text { flex: 1 1 auto; min-width: 120px; }
.pt-row-label { font-size: 13px; font-weight: 500; color: var(--fg-primary); line-height: 1.35; }
.pt-row-desc { margin-top: 2px; font-size: 12px; color: var(--fg-tertiary); line-height: 1.45; }
.pt-row-ctl { display: flex; align-items: center; gap: 8px; flex-shrink: 1; min-width: 0; justify-content: flex-end; }
.pt-row.is-stack { display: block; }
.pt-stack-ctl { margin-top: 8px; }
.pt-stack { padding: 14px 0; }
.pt-note { margin-top: 8px; font-size: 12px; color: var(--fg-tertiary); line-height: 1.5; }
.pt-x { color: var(--fg-tertiary); }
.pt-margins { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.pt-margins .ant-input-number { width: 100% !important; }
.pt-margins label { display: flex; flex-direction: column; align-items: center; gap: 3px; font-size: 11px; color: var(--fg-tertiary); }
.pt-callout {
  margin: 0 0 14px; padding: 10px 12px; border-radius: 9px;
  background: var(--warning-bg); color: var(--fg-secondary);
  font-size: 12px; line-height: 1.5;
}

/* Accent swatch — round, opens the colour picker. */
.pt-swatch {
  position: relative;
  width: 30px; height: 30px; border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.12), 0 0 0 3px var(--bg-panel), 0 0 0 4px var(--border);
  cursor: pointer; flex-shrink: 0;
}
.pt-swatch input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }

/* ── Style gallery: real thumbnails ── */
.pt-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.pt-gallery.is-roll { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
.pt-thumb {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 10px 8px 8px;
  border: 1.5px solid var(--border-subtle); border-radius: 12px;
  background: var(--bg-muted);
  font: inherit; cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
}
.pt-thumb:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.pt-thumb.is-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
  background: var(--bg-panel);
}
.pt-thumb-paper {
  position: relative; display: block; overflow: hidden;
  background: #fff; border-radius: 3px;
  box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 6px 14px -8px rgba(0,0,0,.35);
}
.pt-thumb-paper::after {
  content: ''; position: absolute; inset: auto 0 0 0; height: 26px;
  background: linear-gradient(transparent, #fff);
}
.pt-thumb-paper iframe { border: 0; transform-origin: 0 0; pointer-events: none; display: block; }
.pt-thumb-cap { width: 100%; display: flex; align-items: center; gap: 6px; padding: 0 2px; }
.pt-thumb-name { flex: 1; text-align: left; font-size: 12.5px; font-weight: 600; color: var(--fg-primary); }
.pt-thumb-check { color: var(--accent); font-size: 15px; }
.pt-new {
  padding: 0 6px; border-radius: 99px;
  background: var(--accent-bg); color: var(--accent);
  font-size: 10px; font-weight: 700;
}
.pt-style-desc { padding: 12px 0 14px; font-size: 12px; color: var(--fg-tertiary); line-height: 1.5; }

/* ── Preview: paper on a desk ── */
.pt-pv-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.pt-pv-title { white-space: nowrap; font-size: 13.5px; font-weight: 650; color: var(--fg-primary); }
.pt-chip {
  white-space: nowrap;
  padding: 1px 8px; border-radius: 99px;
  border: 1px solid var(--border); color: var(--fg-secondary);
  font-size: 11px; font-weight: 600;
}
.pt-chip.is-soft { border-color: transparent; background: var(--accent-bg); color: var(--accent); }
.pt-desk {
  flex: 1; min-height: 0; overflow: auto;
  padding: 28px 28px 40px;
  display: flex; justify-content: center; align-items: flex-start;
  background:
    radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--fg-tertiary) 22%, transparent) 0.7px, transparent 0.8px) 0 0 / 16px 16px,
    var(--bg-muted);
}
.pt-paper {
  position: relative; flex-shrink: 0;
  background: #fff;
  border-radius: 2px;
  box-shadow: 0 1px 2px rgba(0,0,0,.10), 0 18px 40px -18px rgba(30, 20, 10, .45);
  overflow: hidden;
}
.pt-paper iframe { border: 0; display: block; background: #fff; transform-origin: 0 0; }
/* Torn edge at the bottom of a thermal roll. */
.pt-paper.is-roll { overflow: visible; border-radius: 0; }
.pt-paper.is-roll::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -7px; height: 8px;
  background: conic-gradient(from -45deg at 50% 100%, transparent 90deg, #fff 0) 0 0 / 10px 8px repeat-x;
}
`;
