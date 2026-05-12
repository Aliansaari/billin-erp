import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Card, Col, Divider, Input, InputNumber, Modal, Radio, Row, Segmented,
  Select, Space, Switch, Tabs, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  PlusOutlined, CopyOutlined, DeleteOutlined, SaveOutlined,
  PrinterOutlined, ReloadOutlined, StarFilled, StarOutlined,
  BgColorsOutlined, LayoutOutlined, FileTextOutlined,
  TableOutlined, NumberOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { printAPI, settingsAPI } from '../../api';
import { renderBillHTML } from '../../services/printRenderer';
import { listPrinters, printRawHTML } from '../../services/printer';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

const { Title, Text } = Typography;

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
  const [filterDoc,  setFilterDoc]  = useState('');

  const iframeRef = useRef(null);

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
    if (iframeRef.current) iframeRef.current.srcdoc = previewHTML;
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

  const filtered = filterDoc
    ? profiles.filter(p => p.doc_type === filterDoc)
    : profiles;

  const isThermal = draft.format === 'thermal';

  return (
    <div className="ms-shell settings-pane-fill print-settings-page">
      <style>{PRINT_STYLES}</style>
      <header className="ms-page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="ms-page-title">Print</h1>
          <p className="ms-page-sub">
            Design invoice, receipt and voucher templates. Changes preview live on the right.
          </p>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadProfiles}>Reload</Button>
          <Button type="primary" icon={<PlusOutlined />}
            onClick={() => newProfile(filterDoc || 'sales')}
            className="print-new-profile-btn">
            New Profile
          </Button>
        </Space>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
      <Row gutter={16}>
        {/* ── LEFT: profile list ───────────────────────────── */}
        <Col span={6}>
          <Card
            size="small"
            title="Profiles"
            styles={{
              body: { padding: 8 },
              header: { borderRadius: '10px 10px 0 0', fontWeight: 600 },
            }}
            style={{ borderRadius: 10, overflow: 'hidden' }}
          >
            <div style={{ marginBottom: 8 }}>
              <Select
                placeholder="All document types"
                allowClear
                style={{ width: '100%' }}
                value={filterDoc || undefined}
                onChange={v => setFilterDoc(v || '')}
                options={DOC_TYPES.map(d => ({ value: d.v, label: d.l }))}
              />
            </div>
            {filtered.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--fg-tertiary)' }}>No profiles yet.</div>
            )}
            {filtered.map(p => {
              const active = p.profile_id === selectedId;
              return (
                <div
                  key={p.profile_id}
                  onClick={() => selectProfile(p)}
                  className={`print-profile-item ${active ? 'is-active' : ''} ${p.is_default ? 'is-default' : ''}`}
                >
                  <div className="print-profile-item-row">
                    {p.is_default
                      ? <StarFilled className="print-profile-star is-on" />
                      : <StarOutlined className="print-profile-star" />}
                    <span className="print-profile-name">{p.name}</span>
                  </div>
                  <div className="print-profile-meta">
                    <span className="print-profile-format">{p.format.toUpperCase()}</span>
                    <span className="print-profile-doctype">{DOC_TYPES.find(d => d.v === p.doc_type)?.l || p.doc_type}</span>
                  </div>
                </div>
              );
            })}
          </Card>
        </Col>

        {/* ── CENTER: editor tabs ───────────────────────── */}
        <Col span={10}>
          <Card size="small"
            style={{ borderRadius: 10, overflow: 'hidden' }}
            styles={{ header: { borderRadius: '10px 10px 0 0' } }}
            title={<Space>
              <Input
                placeholder="Profile name"
                value={draft.name}
                onChange={e => set('name', e.target.value)}
                style={{ width: 240, fontWeight: 600 }}
              />
              {draft.is_default && <Tag color="gold">Default for {DOC_TYPES.find(d => d.v === draft.doc_type)?.l}</Tag>}
            </Space>}
            extra={<Space>
              {!draft.is_default && selectedId && (
                <Tooltip title="Set as the auto-print profile for this document type">
                  <Button size="small" icon={<StarOutlined />} onClick={handleSetDefault}>Make Default</Button>
                </Tooltip>
              )}
              <Button size="small" icon={<CopyOutlined />} onClick={handleDuplicate} disabled={!selectedId}>Duplicate</Button>
              <Button size="small" icon={<DeleteOutlined />} danger onClick={handleDelete}>Delete</Button>
              <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
            </Space>}>

            <Tabs
              defaultActiveKey="theme"
              items={[
                {
                  key: 'basic',
                  label: <span><LayoutOutlined style={{ marginRight: 6 }} />Layout</span>,
                  children: (
                    <div>
                      <Row gutter={12}>
                        <Col span={12}>
                          <label>Document type</label>
                          <Select value={draft.doc_type} onChange={v => set('doc_type', v)} style={{ width: '100%' }}
                            options={DOC_TYPES.map(d => ({ value: d.v, label: d.l }))} />
                        </Col>
                        <Col span={12}>
                          <label>Format</label>
                          <Select value={draft.format} onChange={applyFormat} style={{ width: '100%' }}
                            options={FORMATS.map(f => ({ value: f.v, label: f.l }))} />
                        </Col>
                      </Row>

                      <Divider orientation="left" plain style={{ margin: '16px 0 8px' }}>Paper &amp; margins</Divider>
                      <Row gutter={12}>
                        <Col span={12}>
                          <label>Width (mm)</label>
                          <InputNumber value={draft.paper_width_mm} onChange={v => set('paper_width_mm', v)} min={20} max={500} style={{ width: '100%' }} />
                        </Col>
                        <Col span={12}>
                          <label>Height (mm, 0 = roll)</label>
                          <InputNumber value={draft.paper_height_mm} onChange={v => set('paper_height_mm', v)} min={0} max={800} style={{ width: '100%' }} />
                        </Col>
                      </Row>
                      <Row gutter={12} style={{ marginTop: 8 }}>
                        <Col span={6}><label>Top</label><InputNumber value={draft.margin_top_mm} onChange={v => set('margin_top_mm', v)} min={0} max={50} style={{ width: '100%' }} /></Col>
                        <Col span={6}><label>Right</label><InputNumber value={draft.margin_right_mm} onChange={v => set('margin_right_mm', v)} min={0} max={50} style={{ width: '100%' }} /></Col>
                        <Col span={6}><label>Bottom</label><InputNumber value={draft.margin_bottom_mm} onChange={v => set('margin_bottom_mm', v)} min={0} max={50} style={{ width: '100%' }} /></Col>
                        <Col span={6}><label>Left</label><InputNumber value={draft.margin_left_mm} onChange={v => set('margin_left_mm', v)} min={0} max={50} style={{ width: '100%' }} /></Col>
                      </Row>

                      <Divider orientation="left" plain style={{ margin: '16px 0 8px' }}>Typography</Divider>
                      <Row gutter={12}>
                        <Col span={12}>
                          <label>Font preset</label>
                          <Select
                            value={FONT_PRESETS.find(f => f.v === draft.font_family)?.v}
                            onChange={v => set('font_family', v)}
                            style={{ width: '100%' }}
                            placeholder="Pick a preset — or type a custom stack below"
                            options={FONT_PRESETS.map(f => ({ value: f.v, label: f.l }))}
                          />
                        </Col>
                        <Col span={6}>
                          <label>Size (pt)</label>
                          <InputNumber value={draft.font_size_pt} onChange={v => set('font_size_pt', v)} min={6} max={20} step={0.5} style={{ width: '100%' }} />
                        </Col>
                        <Col span={6}>
                          <label>Line height</label>
                          <InputNumber value={draft.line_spacing} onChange={v => set('line_spacing', v)} min={1} max={2} step={0.05} style={{ width: '100%' }} />
                        </Col>
                      </Row>
                      <Row gutter={12} style={{ marginTop: 8 }}>
                        <Col span={isThermal ? 12 : 24}>
                          <label>Custom font stack (overrides preset)</label>
                          <Input
                            value={draft.font_family}
                            onChange={e => set('font_family', e.target.value)}
                            placeholder="e.g. 'Source Sans 3', system-ui, sans-serif"
                          />
                        </Col>
                        {isThermal && (
                          <Col span={12}>
                            <label>
                              Bold level{' '}
                              <Tooltip title="Thermal paper prints light unless text is genuinely heavy. Bump up if your receipts are hard to read.">
                                <Text type="secondary" style={{ cursor: 'help' }}>(?)</Text>
                              </Tooltip>
                            </label>
                            <Segmented
                              block
                              value={draft.bold_level || 'bold'}
                              onChange={v => set('bold_level', v)}
                              options={BOLD_LEVELS.map(b => ({ value: b.v, label: b.l }))}
                            />
                          </Col>
                        )}
                      </Row>

                      <Divider orientation="left" plain style={{ margin: '16px 0 8px' }}>Copies</Divider>
                      <Row gutter={12}>
                        <Col span={8}>
                          <label>Count</label>
                          <InputNumber value={draft.copies} onChange={v => set('copies', v)} min={1} max={5} style={{ width: '100%' }} />
                        </Col>
                        <Col span={16}>
                          <label>Labels (comma-separated)</label>
                          <Input value={draft.copy_labels} onChange={e => set('copy_labels', e.target.value)}
                            placeholder="Original, Duplicate, Triplicate" />
                        </Col>
                      </Row>
                    </div>
                  ),
                },
                {
                  key: 'header',
                  label: <span><FileTextOutlined style={{ marginRight: 6 }} />Header &amp; Footer</span>,
                  children: (
                    <div>
                      <Row gutter={12}>
                        <Col span={16}>
                          <label>Header title (blank = company name)</label>
                          <Input value={draft.header_title} onChange={e => set('header_title', e.target.value)} />
                        </Col>
                        <Col span={8}>
                          <label>Align</label>
                          <Select value={draft.header_align} onChange={v => set('header_align', v)} style={{ width: '100%' }}
                            options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
                        </Col>
                      </Row>
                      <Row gutter={12} style={{ marginTop: 8 }}>
                        <Col span={24}>
                          <label>
                            Document subtitle{' '}
                            <Tooltip title={
                              `Override the printed subtitle. Blank uses the default for this document type — `
                              + `${DOC_TYPES.find(d => d.v === draft.doc_type)?.l || draft.doc_type} `
                              + `defaults to "${(({
                                sales: 'TAX INVOICE',
                                purchase: 'PURCHASE BILL',
                                sales_return: 'CREDIT NOTE',
                                purchase_return: 'DEBIT NOTE',
                                receipt: 'RECEIPT',
                                payment: 'PAYMENT VOUCHER',
                                quotation: 'QUOTATION',
                                challan: 'DELIVERY CHALLAN',
                              })[draft.doc_type]) || 'DOCUMENT'}". Composition-scheme dealers can change to "BILL OF SUPPLY", retailers to "ESTIMATE", etc.`
                            }>
                              <Text type="secondary" style={{ cursor: 'help' }}>(?)</Text>
                            </Tooltip>
                          </label>
                          <Input
                            value={draft.doc_label}
                            onChange={e => set('doc_label', e.target.value)}
                            placeholder={(({
                              sales: 'TAX INVOICE',
                              purchase: 'PURCHASE BILL',
                              sales_return: 'CREDIT NOTE',
                              purchase_return: 'DEBIT NOTE',
                              receipt: 'RECEIPT',
                              payment: 'PAYMENT VOUCHER',
                              quotation: 'QUOTATION',
                              challan: 'DELIVERY CHALLAN',
                            })[draft.doc_type]) || 'DOCUMENT'}
                            maxLength={60}
                          />
                        </Col>
                      </Row>
                      <div style={{ marginTop: 8 }}>
                        <label>Show company logo</label><br/>
                        <Switch checked={draft.show_logo} onChange={v => set('show_logo', v)} />
                        <Text type="secondary" style={{ marginLeft: 8 }}>Uses logo from Settings → Company Profile</Text>
                      </div>
                      <div style={{ marginTop: 10 }}>
                        <label>Extra header HTML</label>
                        <Input.TextArea rows={2} value={draft.header_html} onChange={e => set('header_html', e.target.value)}
                          placeholder="Optional second-line info / slogan / badge — HTML allowed" />
                      </div>

                      <Divider orientation="left" plain style={{ margin: '16px 0 8px' }}>Footer</Divider>
                      <label>Bank details</label>
                      <Input.TextArea rows={2} value={draft.bank_details} onChange={e => set('bank_details', e.target.value)}
                        placeholder="Bank: HDFC\nA/C: 12345\nIFSC: HDFC0001234" />
                      <label style={{ marginTop: 10, display: 'block' }}>Terms &amp; Conditions</label>
                      <Input.TextArea rows={3} value={draft.terms_and_conditions} onChange={e => set('terms_and_conditions', e.target.value)} />
                      <label style={{ marginTop: 10, display: 'block' }}>
                        Footer message
                        <Text type="secondary" style={{ fontSize: 11, fontWeight: 'normal', marginLeft: 6 }}>
                          (shown at the bottom of every receipt — blank = default <code>Thank You !!! Come Again. :)</code>)
                        </Text>
                      </label>
                      <Input.TextArea
                        rows={2}
                        value={draft.footer_html}
                        onChange={e => set('footer_html', e.target.value)}
                        placeholder="Thank You !!!  Come Again. :)"
                      />
                      <Row gutter={12} style={{ marginTop: 10 }}>
                        <Col span={8}>
                          <label>Signature line</label><br/>
                          <Switch checked={draft.show_signature} onChange={v => set('show_signature', v)} />
                        </Col>
                        <Col span={16}>
                          <label>Signature label</label>
                          <Input value={draft.signature_label} onChange={e => set('signature_label', e.target.value)} />
                        </Col>
                      </Row>
                    </div>
                  ),
                },
                {
                  key: 'fields',
                  label: <span><TableOutlined style={{ marginRight: 6 }} />Fields &amp; Totals</span>,
                  children: (
                    <div>
                      <Divider orientation="left" plain style={{ margin: '0 0 10px' }}>Item table columns (A4 / A5)</Divider>
                      <Row gutter={[12, 10]}>
                        <Col span={8}><Switch checked={draft.show_hsn}           onChange={v => set('show_hsn', v)} /> Show HSN</Col>
                        <Col span={8}><Switch checked={draft.show_mrp}           onChange={v => set('show_mrp', v)} /> Show MRP</Col>
                        <Col span={8}><Switch checked={draft.show_batch}         onChange={v => set('show_batch', v)} /> Show Batch</Col>
                        <Col span={8}><Switch checked={draft.show_tax_breakdown} onChange={v => set('show_tax_breakdown', v)} /> Per-item tax cols</Col>
                        <Col span={8}><Switch checked={draft.show_barcode}       onChange={v => set('show_barcode', v)} /> Show Barcode</Col>
                        <Col span={8}><Switch checked={draft.show_qr_upi}        onChange={v => set('show_qr_upi', v)} /> Show UPI QR</Col>
                      </Row>

                      <Divider orientation="left" plain style={{ margin: '20px 0 10px' }}>
                        Totals section (all formats, incl. thermal)
                      </Divider>
                      <Row gutter={[12, 10]}>
                        <Col span={8}>
                          <Switch checked={draft.show_discount !== false} onChange={v => set('show_discount', v)} /> Show Discount
                        </Col>
                        <Col span={8}>
                          <Switch checked={draft.show_gst !== false} onChange={v => set('show_gst', v)} /> Show GST
                        </Col>
                        <Col span={8}>
                          <Tooltip title="Goods the customer returned within this sale — a credit against the bill. Auto-hidden when return amount is zero.">
                            <Switch checked={draft.show_return_amount !== false} onChange={v => set('show_return_amount', v)} /> Show Return Amount
                          </Tooltip>
                        </Col>
                        <Col span={8}>
                          <Tooltip title="Customer's prior outstanding dues carried over from earlier bills. Off by default.">
                            <Switch checked={draft.show_previous_balance === true} onChange={v => set('show_previous_balance', v)} /> Show Previous Balance
                          </Tooltip>
                        </Col>
                      </Row>

                      {draft.show_qr_upi && (
                        <div style={{ marginTop: 12 }}>
                          <label>UPI ID</label>
                          <Input value={draft.upi_id} onChange={e => set('upi_id', e.target.value)} placeholder="yourname@bank" />
                        </div>
                      )}

                      <Divider orientation="left" plain style={{ margin: '16px 0 8px' }}>Tax summary</Divider>
                      <Select value={draft.tax_summary_mode} onChange={v => set('tax_summary_mode', v)} style={{ width: 260 }}
                        options={[
                          { value: 'consolidated', label: 'Consolidated (totals only)' },
                          { value: 'lineWise',     label: 'Line-wise (per-item GST cols)' },
                        ]} />

                      <Divider orientation="left" plain style={{ margin: '16px 0 8px' }}>Number format</Divider>
                      <Row gutter={12}>
                        <Col span={8}>
                          <label>Currency symbol</label>
                          <Input value={draft.currency_symbol} onChange={e => set('currency_symbol', e.target.value)} />
                        </Col>
                        <Col span={8}>
                          <label>Locale</label>
                          <Select value={draft.locale_format} onChange={v => set('locale_format', v)} style={{ width: '100%' }}
                            options={[
                              { value: 'en-IN', label: 'Indian (1,00,000.00)' },
                              { value: 'en-US', label: 'US (100,000.00)' },
                              { value: 'en-GB', label: 'UK (100,000.00)' },
                            ]} />
                        </Col>
                      </Row>
                    </div>
                  ),
                },
                {
                  key: 'theme',
                  label: <span><BgColorsOutlined style={{ marginRight: 6 }} />{isThermal ? 'Style' : 'Theme'}</span>,
                  children: (
                    <div>
                      <label style={{ display: 'block', marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
                        {isThermal ? 'Thermal receipt style' : 'Visual theme'}
                      </label>
                      <div className="print-theme-grid">
                        {(isThermal ? THERMAL_STYLES : THEMES).map(t => {
                          const key = isThermal ? 'thermal_style' : 'theme';
                          const active = draft[key] === t.v;
                          return (
                            <div
                              key={t.v}
                              onClick={() => {
                                set(key, t.v);
                                if (!isThermal && (!draft.accent_color || draft.accent_color === '#111111' || THEMES.some(th => th.swatch === draft.accent_color))) {
                                  set('accent_color', t.swatch);
                                }
                              }}
                              className={`print-theme-card ${active ? 'is-active' : ''}`}
                            >
                              <div className="print-theme-card-head">
                                {t.swatch && (
                                  <span className="print-theme-swatch" style={{ background: t.swatch }} />
                                )}
                                <b className="print-theme-name">{t.l}</b>
                                {t.isNew && <span className="print-theme-new">NEW</span>}
                                {active && <span className="print-theme-active-check">✓</span>}
                              </div>
                              <div className="print-theme-desc">{t.d}</div>
                            </div>
                          );
                        })}
                      </div>

                      {isThermal && (
                        <>
                          <Divider orientation="left" plain style={{ margin: '20px 0 10px' }}>Darkness / weight</Divider>
                          <Segmented
                            block
                            value={draft.bold_level || 'bold'}
                            onChange={v => set('bold_level', v)}
                            options={BOLD_LEVELS.map(b => ({ value: b.v, label: b.l }))}
                          />
                          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-tertiary, #999)' }}>
                            Thermal paper reproduces black in proportion to the font weight. If prints are too faint, try <b>Heavy</b>. If letters smudge together, drop to <b>Normal</b>.
                          </div>
                        </>
                      )}

                      <Divider orientation="left" plain style={{ margin: '20px 0 10px' }}>Accent color</Divider>
                      <Row gutter={12} align="middle">
                        <Col>
                          <input
                            type="color"
                            value={draft.accent_color || '#111111'}
                            onChange={e => set('accent_color', e.target.value)}
                            style={{ width: 54, height: 36, border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}
                          />
                        </Col>
                        <Col flex="auto">
                          <Input
                            value={draft.accent_color || ''}
                            onChange={e => set('accent_color', e.target.value)}
                            placeholder="#111111"
                          />
                        </Col>
                        <Col>
                          <Button size="small" onClick={() => {
                            const def = THEMES.find(t => t.v === draft.theme)?.swatch || '#111111';
                            set('accent_color', def);
                          }}>Theme default</Button>
                        </Col>
                      </Row>
                      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-tertiary, #999)' }}>
                        {isThermal
                          ? 'On thermal prints, body text is always pure black for readability. Accent color affects only the "Modern" style chip and total banner.'
                          : 'The accent color drives headline text on Modern/Elegant/Minimal themes and the full header block on Boxed.'}
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'printer',
                  label: <span><PrinterOutlined style={{ marginRight: 6 }} />Printer</span>,
                  children: (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 8 }}>
                        <div style={{ flex: 1 }}>
                          <label>Default printer</label>
                          <Select
                            value={draft.printer_name || undefined}
                            onChange={v => set('printer_name', v || '')}
                            style={{ width: '100%' }}
                            allowClear
                            showSearch
                            placeholder={printers.length ? 'Pick a printer' : 'No printers detected — type a name below'}
                            options={printers.map(p => ({
                              value: p.name,
                              label: `${p.displayName || p.name}${p.isDefault ? '  (system default)' : ''}`,
                            }))}
                          />
                        </div>
                        <Button icon={<ReloadOutlined />} onClick={refreshPrinters}>Refresh</Button>
                      </div>
                      {/* Manual fallback: if Electron isn't exposing printers (running in
                          a web browser) or enumeration failed, let the user type the
                          exact Windows/mac driver name — the silent-print IPC will
                          still match on it. */}
                      <label style={{ marginTop: 8, display: 'block' }}>Or type printer name manually</label>
                      <Input
                        value={draft.printer_name || ''}
                        onChange={e => set('printer_name', e.target.value)}
                        placeholder="e.g. POS-80C  or  HP LaserJet Pro M404  or  leave blank for system default"
                      />
                      {printerErr && (
                        <div style={{ marginTop: 8, padding: 8, background: 'rgba(239,68,68,0.08)', color: '#b91c1c', borderRadius: 6, fontSize: 12 }}>
                          Printer list error: {printerErr}
                        </div>
                      )}
                      {!printerErr && !printers.length && (
                        <div style={{ marginTop: 8, padding: 8, background: 'rgba(245,158,11,0.08)', color: '#92400e', borderRadius: 6, fontSize: 12 }}>
                          No printers returned by the OS. Run the desktop build (<code>npm run electron:dev</code>) so we can enumerate them,
                          or install your printer's Windows driver and click Refresh. In the web-only preview the name field is still used —
                          type it exactly as it appears in Windows &rarr; Devices and Printers.
                        </div>
                      )}
                      <div style={{ marginTop: 14 }}>
                        <Switch checked={draft.silent_print} onChange={v => set('silent_print', v)} />
                        <Text style={{ marginLeft: 8 }}>Silent direct print (no system dialog)</Text>
                      </div>
                      <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-muted, #f5f5f5)', borderRadius: 6, fontSize: 12, color: '#666' }}>
                        Silent printing requires the Electron build. On the web-only preview the button falls back to the browser print dialog.
                        For USB thermal printers: install the vendor's Windows driver (or the "Generic / Text Only" driver as a fallback) —
                        Electron then sends the HTML through that driver silently.
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <Button icon={<PrinterOutlined />} onClick={handleTestPrint}>Test print sample</Button>
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        {/* ── RIGHT: live preview ─────────────────────── */}
        <Col span={8}>
          <Card
            size="small"
            title={<span style={{ fontWeight: 600 }}>Live preview</span>}
            extra={
              <Space>
                <Tag color={draft.format === 'thermal' ? 'green' : draft.format === 'a5' ? 'blue' : 'purple'}>
                  {draft.format.toUpperCase()}
                </Tag>
                {isThermal && draft.thermal_style && (
                  <Tag color="geekblue">
                    {THERMAL_STYLES.find(t => t.v === draft.thermal_style)?.l || draft.thermal_style}
                  </Tag>
                )}
              </Space>
            }
            style={{ borderRadius: 10, overflow: 'hidden' }}
            styles={{
              header: { borderRadius: '10px 10px 0 0' },
              body: {
                padding: isThermal ? 12 : 0,
                height: 820,
                background: '#2a2a2a',
                display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
              },
            }}
          >
            <iframe
              ref={iframeRef}
              title="print-preview"
              style={{
                width: isThermal ? 'min(340px, 100%)' : '100%',
                height: '100%', border: 0, background: '#fff',
                boxShadow: isThermal ? '0 8px 24px rgba(0,0,0,0.4)' : 'none',
                borderRadius: isThermal ? 2 : 0,
              }}
            />
          </Card>
        </Col>
      </Row>
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
            disabled: !dirty,
            onAction: handleSave,
          },
        ]}
      />
    </div>
  );
}

const PRINT_STYLES = `
.print-settings-page {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
/* Override the narrow 880px max-width from ModuleSettings.css —
   Print is a 3-column workspace (profiles + editor + live preview)
   and needs the full pane width to breathe. */
.print-settings-page .ms-page-body-inner {
  max-width: none !important;
  padding: 24px clamp(16px, 2vw, 28px) 32px !important;
}
.print-new-profile-btn.ant-btn-primary {
  background: linear-gradient(135deg, #0F172A 0%, #1e293b 100%) !important;
  border-color: #0F172A !important;
  border-radius: 8px !important;
  font-weight: 600 !important;
  box-shadow: 0 4px 12px -4px rgba(15, 23, 42, 0.4) !important;
}
.print-new-profile-btn.ant-btn-primary:hover {
  background: linear-gradient(135deg, #1e293b 0%, #334155 100%) !important;
}

/* ── Profile sidebar list ─────────────────────────────── */
.print-profile-item {
  padding: 10px 12px;
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 4px;
  border: 1px solid transparent;
  transition: all 0.15s ease;
  position: relative;
}
.print-profile-item:hover {
  background: var(--bg-muted, #f8fafc);
}
.print-profile-item.is-active {
  background: rgba(15, 23, 42, 0.04);
  border-color: rgba(15, 23, 42, 0.15);
  box-shadow: inset 3px 0 0 #0F172A;
  padding-left: 14px;
}
.print-profile-item-row {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 4px;
}
.print-profile-star {
  font-size: 13px;
  color: #cbd5e1;
  flex-shrink: 0;
}
.print-profile-star.is-on {
  color: #f59e0b;
}
.print-profile-name {
  font-weight: 600; font-size: 13.5px;
  color: var(--fg-primary, #0F172A);
  letter-spacing: -0.1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.print-profile-meta {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px;
  color: var(--fg-tertiary, #94a3b8);
  margin-left: 21px;
}
.print-profile-format {
  display: inline-block;
  padding: 1px 7px;
  background: var(--bg-muted, #f1f5f9);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.06));
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--fg-secondary, #64748b);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}
.print-profile-doctype {
  font-size: 11.5px;
  color: var(--fg-secondary, #64748b);
}

/* ── Theme cards grid ──────────────────────────────── */
.print-theme-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.print-theme-card {
  position: relative;
  padding: 14px 16px;
  border-radius: 12px;
  cursor: pointer;
  border: 1.5px solid var(--border-subtle, rgba(15, 23, 42, 0.08));
  background: var(--bg-panel, #fff);
  transition: all 0.18s ease;
  overflow: hidden;
}
.print-theme-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0;
  height: 3px;
  background: transparent;
  transition: background 0.18s ease;
}
.print-theme-card:hover {
  border-color: rgba(15, 23, 42, 0.18);
  background: var(--bg-muted, #fafbfc);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px -4px rgba(15, 23, 42, 0.08);
}
.print-theme-card.is-active {
  border-color: #0F172A;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.025) 0%, var(--bg-panel, #fff) 100%);
  box-shadow: 0 4px 14px -6px rgba(15, 23, 42, 0.18);
}
.print-theme-card.is-active::before {
  background: linear-gradient(90deg, #0F172A, #475569);
}
.print-theme-card-head {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 6px;
}
.print-theme-swatch {
  width: 18px; height: 18px;
  border-radius: 5px;
  flex-shrink: 0;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2), 0 1px 2px rgba(15, 23, 42, 0.15);
}
.print-theme-name {
  font-size: 14px; font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--fg-primary, #0F172A);
  flex: 1;
}
.print-theme-new {
  display: inline-block;
  padding: 1px 7px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  border-radius: 4px;
  text-transform: uppercase;
  box-shadow: 0 2px 4px -1px rgba(99, 102, 241, 0.4);
}
.print-theme-active-check {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: #0F172A;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.print-theme-desc {
  font-size: 12px;
  color: var(--fg-secondary, #64748b);
  line-height: 1.5;
}
`;
