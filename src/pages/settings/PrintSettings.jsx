import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Card, Col, Divider, Input, InputNumber, Modal, Row, Select, Space,
  Switch, Tabs, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  PlusOutlined, CopyOutlined, DeleteOutlined, SaveOutlined,
  PrinterOutlined, ReloadOutlined, StarFilled, StarOutlined,
} from '@ant-design/icons';
import { printAPI, settingsAPI } from '../../api';
import { renderBillHTML } from '../../services/printRenderer';
import { listPrinters, printRawHTML } from '../../services/printer';

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
    paid_amount: 4648.75,
    balance_amount: 0,
  };
};

const blankProfile = (docType = 'sales') => ({
  name: 'New profile', doc_type: docType, format: 'a4', is_default: false,
  paper_width_mm: 210, paper_height_mm: 297,
  margin_top_mm: 10, margin_right_mm: 10, margin_bottom_mm: 10, margin_left_mm: 10,
  font_family: 'Inter, system-ui, sans-serif', font_size_pt: 10, line_spacing: 1.35,
  show_logo: true, header_title: '', header_html: '', header_align: 'center',
  show_hsn: true, show_batch: false, show_mrp: true, show_discount: true,
  show_tax_breakdown: true, show_barcode: false, show_qr_upi: false, upi_id: '',
  tax_summary_mode: 'consolidated',
  footer_html: '', show_signature: true, signature_label: 'Authorised Signatory',
  bank_details: '', terms_and_conditions: '',
  copies: 1, copy_labels: 'Original',
  currency_symbol: 'Rs ', locale_format: 'en-IN',
  printer_name: '', silent_print: true,
});

export default function PrintSettings() {
  const [profiles,   setProfiles]   = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft,      setDraft]      = useState(blankProfile());
  const [dirty,      setDirty]      = useState(false);
  const [printers,   setPrinters]   = useState([]);
  const [company,    setCompany]    = useState({});
  const [filterDoc,  setFilterDoc]  = useState('');

  const iframeRef = useRef(null);

  /* ── load everything on mount ────────────────────────────────── */

  useEffect(() => {
    loadProfiles();
    listPrinters().then(setPrinters);
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
        font_size_pt: 9, show_hsn: false, show_mrp: false, show_tax_breakdown: false,
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

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>Print Settings</Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadProfiles}>Reload</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => newProfile(filterDoc || 'sales')}>
            New Profile
          </Button>
        </Space>
      </div>

      <Row gutter={16}>
        {/* ── LEFT: profile list ───────────────────────────── */}
        <Col span={6}>
          <Card size="small" title="Profiles" styles={{ body: { padding: 8 } }}>
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
              <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>No profiles yet.</div>
            )}
            {filtered.map(p => {
              const active = p.profile_id === selectedId;
              return (
                <div
                  key={p.profile_id}
                  onClick={() => selectProfile(p)}
                  style={{
                    padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                    background: active ? 'var(--accent-bg, rgba(79,70,229,0.08))' : 'transparent',
                    border: active ? '1px solid var(--accent, #4F46E5)' : '1px solid transparent',
                    marginBottom: 4,
                  }}
                >
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {p.is_default ? <StarFilled style={{ color: '#F59E0B' }} /> : <StarOutlined style={{ opacity: 0.3 }} />}
                    {p.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    <Tag color="default" style={{ marginRight: 4 }}>{p.format.toUpperCase()}</Tag>
                    {DOC_TYPES.find(d => d.v === p.doc_type)?.l || p.doc_type}
                  </div>
                </div>
              );
            })}
          </Card>
        </Col>

        {/* ── CENTER: editor tabs ───────────────────────── */}
        <Col span={10}>
          <Card size="small"
            title={<Space>
              <Input
                placeholder="Profile name"
                value={draft.name}
                onChange={e => set('name', e.target.value)}
                style={{ width: 260 }}
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
              defaultActiveKey="basic"
              items={[
                {
                  key: 'basic', label: 'Basic',
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
                          <label>Font family</label>
                          <Input value={draft.font_family} onChange={e => set('font_family', e.target.value)} />
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
                  key: 'header', label: 'Header / Footer',
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
                      <label style={{ marginTop: 10, display: 'block' }}>Custom footer HTML</label>
                      <Input.TextArea rows={2} value={draft.footer_html} onChange={e => set('footer_html', e.target.value)} />
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
                  key: 'fields', label: 'Fields / Columns',
                  children: (
                    <div>
                      <Row gutter={[12, 10]}>
                        <Col span={8}><Switch checked={draft.show_hsn}           onChange={v => set('show_hsn', v)} /> Show HSN</Col>
                        <Col span={8}><Switch checked={draft.show_mrp}           onChange={v => set('show_mrp', v)} /> Show MRP</Col>
                        <Col span={8}><Switch checked={draft.show_batch}         onChange={v => set('show_batch', v)} /> Show Batch</Col>
                        <Col span={8}><Switch checked={draft.show_discount}      onChange={v => set('show_discount', v)} /> Show Discount%</Col>
                        <Col span={8}><Switch checked={draft.show_tax_breakdown} onChange={v => set('show_tax_breakdown', v)} /> Show Tax cols</Col>
                        <Col span={8}><Switch checked={draft.show_barcode}       onChange={v => set('show_barcode', v)} /> Show Barcode</Col>
                        <Col span={8}><Switch checked={draft.show_qr_upi}        onChange={v => set('show_qr_upi', v)} /> Show UPI QR</Col>
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
                  key: 'printer', label: 'Printer',
                  children: (
                    <div>
                      <label>Default printer</label>
                      <Select
                        value={draft.printer_name || undefined}
                        onChange={v => set('printer_name', v || '')}
                        style={{ width: '100%' }}
                        allowClear
                        placeholder={printers.length ? 'Pick a printer' : 'No printers detected (Electron only)'}
                        options={printers.map(p => ({
                          value: p.name,
                          label: `${p.displayName || p.name}${p.isDefault ? '  (system default)' : ''}`,
                        }))}
                      />
                      <div style={{ marginTop: 12 }}>
                        <Switch checked={draft.silent_print} onChange={v => set('silent_print', v)} />
                        <Text style={{ marginLeft: 8 }}>Silent direct print (no system dialog)</Text>
                      </div>
                      <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-muted, #f5f5f5)', borderRadius: 6, fontSize: 12, color: '#666' }}>
                        Silent printing requires running inside Electron. In the web-only build the app will fall back to the browser print dialog.
                        If your thermal printer driver doesn't accept HTML, install its "Generic / Text Only" Windows driver for best results, or switch to a dedicated ESC/POS library.
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
          <Card size="small" title="Live preview" extra={
            <Tag color={draft.format === 'thermal' ? 'green' : draft.format === 'a5' ? 'blue' : 'purple'}>{draft.format.toUpperCase()}</Tag>
          } styles={{ body: { padding: 0, height: 820, background: '#2a2a2a' } }}>
            <iframe
              ref={iframeRef}
              title="print-preview"
              style={{ width: '100%', height: '100%', border: 0, background: '#fff' }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
