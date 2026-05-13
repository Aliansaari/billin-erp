import React, { useEffect, useMemo, useState } from 'react';
import {
  Steps, Form, Input, Select, DatePicker, Row, Col, Button, message,
  Typography, Upload, Divider, Result,
} from 'antd';
import {
  CheckCircleOutlined, UploadOutlined, RightOutlined, LeftOutlined,
  RocketOutlined, SunOutlined, MoonOutlined, DesktopOutlined,
  BgColorsOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { settingsAPI } from '../api';
import useIndianStates from '../hooks/useIndianStates';
import useCompanyStore from '../store/companyStore';
import useThemeStore from '../store/themeStore';
import './OnboardingWizard.css';

const { TextArea } = Input;
const { Title, Paragraph, Text } = Typography;

/*
 * OnboardingWizard — first-run guided setup for new installs.
 *
 * Walks a fresh admin through the same five sections that Settings →
 * Company Profile exposes, but presented one-at-a-time with an explicit
 * progress bar (AntD Steps) so the operator knows what's left. Each
 * "Next" autosaves the visible step's fields via PUT /api/settings/system
 * — if the user closes the laptop halfway through, they pick up where
 * they left off, not where they started.
 *
 * Detection:
 *   The wizard auto-shows when the system_settings.company_name is still
 *   the seeded default 'My Company' AND the user hasn't dismissed it in
 *   this browser. Once the company name is set to anything real, the
 *   wizard stops appearing — no extra column / flag needed.
 *
 * Dismissal:
 *   "I'll do this later" sets localStorage.onboarding_dismissed_v1 = '1'.
 *   The Skip stays per-browser (a re-installed laptop will see it again),
 *   which is the right safety net for fresh installs.
 *
 * F-keys:
 *   Esc       — dismiss (with "I'll do this later" confirmation)
 *   Enter / F1 — Next (last step → Finish)
 *   Shift+Tab — Back
 *
 * Mounted from App.jsx alongside PrivateRoute, so it only renders for
 * authenticated users past the password-rotation gate.
 */

/* Per-company dismissal — keying by company_id means dismissing the
 * wizard for "Sabina Dresses" doesn't accidentally hide it the next time
 * the operator creates a brand-new company. Falls back to the un-suffixed
 * key when no company_id is known yet (login flow before company is picked). */
const STORAGE_KEY_PREFIX = 'onboarding_dismissed_v1';
const dismissedKey = (companyId) => companyId
  ? `${STORAGE_KEY_PREFIX}::${companyId}`
  : STORAGE_KEY_PREFIX;

/* The Address step pulls its state list via useIndianStates() and passes
 * the options into the renderer (see render({ stateOptions, ... }) below).
 * Backed by the server-side IndianState table; falls back to a built-in
 * list when the API isn't reachable. */

/* The five steps. Each step declares:
 *   title    — the Steps progress label
 *   intro    — a 1-sentence "why this matters" line above the fields
 *   fields   — list of column names this step writes. Used for validation
 *              and for partial saves (we only PUT the keys for the current
 *              step so unrelated empty fields don't get clobbered).
 *   render   — the JSX rendered when this step is active.
 *
 * Field markup is intentionally kept close to CompanyProfile's so the two
 * stay visually consistent; an admin who completes the wizard then goes to
 * Settings sees the same chrome and trusts it. */
const STEPS = [
  {
    key: 'identity',
    title: 'Identity',
    intro: 'Tell us about your business. The company name and contact details print on every invoice.',
    fields: [
      'company_name', 'company_phone', 'company_phone_2',
      'company_email', 'company_website',
      'financial_year_start', 'financial_year_end',
    ],
    render: () => (
      <>
        <Row gutter={16}>
          <Col xs={24} md={16}>
            <Form.Item
              name="company_name" label="Company Name"
              rules={[
                { required: true, message: 'Please enter your company name' },
                { validator: (_, v) => v && v.trim().toLowerCase() === 'my company'
                    ? Promise.reject(new Error('Please replace the default with your real company name'))
                    : Promise.resolve() },
              ]}
            >
              <Input placeholder="Sabina Dresses" autoFocus />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="company_website" label="Website (optional)">
              <Input placeholder="example.com" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="company_phone" label="Primary Phone">
              <Input placeholder="98765 43210" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="company_phone_2" label="Alternate Phone">
              <Input placeholder="98765 43211" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="company_email" label="Email">
              <Input placeholder="accounts@example.com" />
            </Form.Item>
          </Col>
        </Row>
        <Divider style={{ margin: '12px 0' }}>Financial Year</Divider>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item
              name="financial_year_start" label="FY Start"
              rules={[{ required: true, message: 'Pick the start date (usually 1 April)' }]}
            >
              <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="financial_year_end" label="FY End"
              rules={[{ required: true, message: 'Pick the end date (usually 31 March)' }]}
            >
              <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
            </Form.Item>
          </Col>
        </Row>
      </>
    ),
  },
  {
    key: 'address',
    title: 'Address',
    intro: 'Used for GST place-of-supply routing (inter-state IGST vs intra-state CGST+SGST) and on every printed invoice.',
    fields: [
      'company_address_line_1', 'company_address_line_2',
      'company_city', 'company_state', 'company_pincode', 'company_country',
    ],
    render: ({ stateOptions } = {}) => (
      <>
        <Form.Item name="company_address_line_1" label="Address Line 1">
          <Input placeholder="Shop number, building, street" autoFocus />
        </Form.Item>
        <Form.Item name="company_address_line_2" label="Address Line 2 (optional)">
          <Input placeholder="Locality, landmark" />
        </Form.Item>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="company_city" label="City">
              <Input placeholder="Mumbai" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="company_state" label="State">
              <Select
                showSearch placeholder="Select state"
                options={stateOptions || []}
                allowClear
              />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="company_pincode" label="Pincode">
              <Input placeholder="400001" maxLength={6} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="company_country" label="Country">
              <Input placeholder="India" />
            </Form.Item>
          </Col>
        </Row>
      </>
    ),
  },
  {
    key: 'tax',
    title: 'Tax IDs',
    intro: 'Optional — but GSTIN is required if you charge GST. Leave any field blank if it doesn\'t apply to your business.',
    fields: [
      'gstin', 'pan_number', 'tan_number',
      'cin_number', 'msme_udyam', 'drug_license', 'fssai_license',
    ],
    render: () => (
      <>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="gstin" label="GSTIN"
                       help="15 chars e.g. 27ABCDE1234F1Z5. Drives every GST calculation.">
              <Input placeholder="27ABCDE1234F1Z5" maxLength={15} style={{ textTransform: 'uppercase' }} autoFocus />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="pan_number" label="PAN"
                       help="10 chars e.g. ABCDE1234F.">
              <Input placeholder="ABCDE1234F" maxLength={10} style={{ textTransform: 'uppercase' }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="tan_number" label="TAN (TDS)">
              <Input placeholder="DELI12345E" maxLength={10} style={{ textTransform: 'uppercase' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="cin_number" label="CIN (Pvt Ltd / LLP)">
              <Input placeholder="L17110MH1973PLC019786" maxLength={21} style={{ textTransform: 'uppercase' }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="msme_udyam" label="MSME / Udyam">
              <Input placeholder="UDYAM-MH-01-1234567" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="drug_license" label="Drug License (pharma)">
              <Input placeholder="20B / 21B / 20F" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="fssai_license" label="FSSAI (food)">
              <Input placeholder="14-digit number" />
            </Form.Item>
          </Col>
        </Row>
      </>
    ),
  },
  {
    key: 'banking',
    title: 'Banking',
    intro: 'Bank details print in the footer of every invoice. The UPI ID auto-generates a QR code that customers can scan to pay you instantly.',
    fields: [
      'bank_account_holder', 'bank_name', 'bank_account_number',
      'bank_ifsc', 'bank_branch', 'bank_upi_id',
    ],
    render: () => (
      <>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="bank_account_holder" label="Account Holder Name">
              <Input placeholder="As per bank records" autoFocus />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="bank_name" label="Bank Name">
              <Input placeholder="HDFC Bank" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="bank_account_number" label="Account Number">
              <Input placeholder="50100123456789" />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="bank_ifsc" label="IFSC">
              <Input placeholder="HDFC0001234" maxLength={11} style={{ textTransform: 'uppercase' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Form.Item name="bank_branch" label="Branch">
              <Input placeholder="Andheri (E)" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="bank_upi_id" label="UPI ID"
                   help="Optional but recommended — auto-generates a UPI QR code on every invoice.">
          <Input placeholder="shop@hdfcbank" />
        </Form.Item>
      </>
    ),
  },
  {
    key: 'theme',
    title: 'Theme',
    intro: 'Pick how the app looks. You can change this any time from Settings → Theme.',
    // Theme step writes to themeStore (localStorage) instead of the server —
    // theme is a per-device preference, not company-wide. So fields=[] here
    // means saveCurrentStep just resolves with nothing to PUT, which is fine.
    fields: [],
    render: ({ themeStyle, appearance, onSetThemeStyle, onSetAppearance } = {}) => (
      <>
        <div className="ob-section-label">Theme style</div>
        <div className="ob-card-grid">
          {[
            {
              key: 'classic',
              title: 'Classic',
              desc: 'Tight density, monospace numerals, Tally-style chrome. The familiar ERP look.',
              swatch: ['#0EA5E9', '#0F172A', '#E2E8F0'],
            },
            {
              key: 'modern',
              title: 'Modern',
              desc: 'Softer corners, more breathing room, contemporary palette. Easier on the eyes.',
              swatch: ['#6366F1', '#1E1B4B', '#F1F5F9'],
            },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={themeStyle === opt.key}
              onClick={() => onSetThemeStyle(opt.key)}
              className={`ob-pick-card ${themeStyle === opt.key ? 'is-active' : ''}`}
            >
              <div className="ob-pick-swatch" aria-hidden="true">
                {opt.swatch.map((c, i) => (
                  <span key={i} style={{ background: c }} />
                ))}
              </div>
              <div className="ob-pick-title">{opt.title}</div>
              <div className="ob-pick-desc">{opt.desc}</div>
            </button>
          ))}
        </div>

        <div className="ob-section-label" style={{ marginTop: 18 }}>Appearance</div>
        <div className="ob-card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {[
            { key: 'light',  icon: <SunOutlined />,     title: 'Light',         desc: 'Bright surfaces, dark text.' },
            { key: 'dark',   icon: <MoonOutlined />,    title: 'Dark',          desc: 'Easier in low light.' },
            { key: 'system', icon: <DesktopOutlined />, title: 'Match system',  desc: 'Follow OS setting.' },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={appearance === opt.key}
              onClick={() => onSetAppearance(opt.key)}
              className={`ob-pick-card ob-pick-card-sm ${appearance === opt.key ? 'is-active' : ''}`}
            >
              <div className="ob-pick-ico" aria-hidden="true">{opt.icon}</div>
              <div className="ob-pick-title">{opt.title}</div>
              <div className="ob-pick-desc">{opt.desc}</div>
            </button>
          ))}
        </div>
      </>
    ),
  },
  {
    key: 'branding',
    title: 'Branding',
    intro: 'Logo + signature appear on every printed invoice. The invoice footer prints below the totals — typically a jurisdiction clause.',
    fields: ['invoice_footer'],
    render: ({ assetVersion, hasLogo, hasSignature, onLogoUpload, onLogoRemove, onSignatureUpload, onSignatureRemove }) => (
      <>
        <Row gutter={32}>
          <Col xs={24} md={12}>
            <div className="ob-asset-block">
              <div className="ob-asset-title">Company Logo</div>
              <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
                Top-left of every invoice. PNG / JPEG / SVG, max 5 MB.
              </Paragraph>
              {hasLogo && (
                <div className="ob-asset-preview">
                  <img src={`/api/settings/branding/logo?v=${assetVersion}`} alt="logo" />
                </div>
              )}
              <div className="ob-asset-actions">
                <Upload customRequest={onLogoUpload} showUploadList={false}
                        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml">
                  <Button icon={<UploadOutlined />}>{hasLogo ? 'Replace' : 'Upload logo'}</Button>
                </Upload>
                {hasLogo && <Button danger onClick={onLogoRemove}>Remove</Button>}
              </div>
            </div>
          </Col>
          <Col xs={24} md={12}>
            <div className="ob-asset-block">
              <div className="ob-asset-title">Authorised Signatory</div>
              <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
                Bottom-right "For Company Name" box. Same formats.
              </Paragraph>
              {hasSignature && (
                <div className="ob-asset-preview">
                  <img src={`/api/settings/branding/signature?v=${assetVersion}`} alt="signature" />
                </div>
              )}
              <div className="ob-asset-actions">
                <Upload customRequest={onSignatureUpload} showUploadList={false}
                        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml">
                  <Button icon={<UploadOutlined />}>{hasSignature ? 'Replace' : 'Upload signature'}</Button>
                </Upload>
                {hasSignature && <Button danger onClick={onSignatureRemove}>Remove</Button>}
              </div>
            </div>
          </Col>
        </Row>
        <Form.Item name="invoice_footer" label="Invoice Footer" style={{ marginTop: 16 }}>
          <TextArea rows={3} placeholder="All disputes subject to Mumbai jurisdiction. E. & O. E." />
        </Form.Item>
      </>
    ),
  },
];

export default function OnboardingWizard({ onComplete }) {
  const [form] = Form.useForm();
  const [stepIdx, setStepIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [assetVersion, setAssetVersion] = useState(0);
  const [hasLogo, setHasLogo] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  // Server-driven state list (built-in fallback when API unreachable).
  const { options: stateOptions } = useIndianStates();
  // Active company id — used so dismissal is per-company instead of browser-wide.
  const activeCompanyId = useCompanyStore((s) => s.currentId);
  // Theme — per-device preference, written directly to themeStore (no API call).
  const themeStyle      = useThemeStore((s) => s.themeStyle);
  const appearance      = useThemeStore((s) => s.appearance);
  const setThemeStyle   = useThemeStore((s) => s.setThemeStyle);
  const setAppearance   = useThemeStore((s) => s.setAppearance);

  /* Initial load — read whatever the operator may have filled before
   * (e.g. partial completion in an earlier session, or fields edited
   * directly via Settings → Company Profile before triggering the wizard). */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await settingsAPI.getSystem();
        const s = data?.data || data || {};
        if (cancelled) return;
        const initial = {
          company_name:    s.company_name === 'My Company' ? '' : (s.company_name || ''),
          company_phone:   s.company_phone || '',
          company_phone_2: s.company_phone_2 || '',
          company_email:   s.company_email || '',
          company_website: s.company_website || '',
          financial_year_start: s.financial_year_start ? dayjs(s.financial_year_start) : dayjs().month(3).date(1).startOf('day'),
          financial_year_end:   s.financial_year_end   ? dayjs(s.financial_year_end)   : dayjs().month(3).date(1).add(1, 'year').subtract(1, 'day'),
          company_address_line_1: s.company_address_line_1 || '',
          company_address_line_2: s.company_address_line_2 || '',
          company_city:    s.company_city || '',
          company_state:   s.company_state || '',
          company_pincode: s.company_pincode || '',
          company_country: s.company_country || 'India',
          gstin:           s.gstin || '',
          pan_number:      s.pan_number || '',
          tan_number:      s.tan_number || '',
          cin_number:      s.cin_number || '',
          msme_udyam:      s.msme_udyam || '',
          drug_license:    s.drug_license || '',
          fssai_license:   s.fssai_license || '',
          bank_account_holder: s.bank_account_holder || '',
          bank_name:           s.bank_name || '',
          bank_account_number: s.bank_account_number || '',
          bank_ifsc:           s.bank_ifsc || '',
          bank_branch:         s.bank_branch || '',
          bank_upi_id:         s.bank_upi_id || '',
          invoice_footer:      s.invoice_footer || '',
        };
        form.setFieldsValue(initial);
        // Probe branding assets — HEAD instead of GET so we don't pull the image.
        try { const r = await fetch('/api/settings/branding/logo',      { method: 'HEAD' }); setHasLogo(r.ok); } catch {}
        try { const r = await fetch('/api/settings/branding/signature', { method: 'HEAD' }); setHasSignature(r.ok); } catch {}
      } catch (e) {
        message.error('Could not load existing settings — start fresh');
      }
    })();
    return () => { cancelled = true; };
  }, [form]);

  const step = STEPS[stepIdx];
  const isFirst = stepIdx === 0;
  const isLast  = stepIdx === STEPS.length - 1;

  // Save just this step's fields. We send only the keys this step owns so
  // unrelated empty fields don't overwrite anything the operator typed in
  // a later step before navigating back here.
  const saveCurrentStep = async () => {
    const values = await form.validateFields(step.fields).catch((err) => {
      // err.errorFields exists when AntD threw on validation. Re-surface so
      // the next handler shows red field markers but doesn't trigger a save.
      throw err;
    });
    const payload = {};
    for (const k of step.fields) {
      let v = values[k];
      // Convert dayjs back to ISO date strings the server expects.
      if (v && typeof v === 'object' && typeof v.toISOString === 'function') {
        v = v.format('YYYY-MM-DD');
      }
      payload[k] = v == null ? '' : v;
    }
    setSaving(true);
    try {
      await settingsAPI.updateSystem(payload);
    } finally {
      setSaving(false);
    }
  };

  const handleNext = async () => {
    try {
      await saveCurrentStep();
    } catch (e) {
      if (e?.errorFields) return; // validation — AntD shows the field errors
      message.error(e?.response?.data?.error || 'Could not save this step');
      return;
    }
    if (isLast) {
      setDone(true);
    } else {
      setStepIdx((i) => i + 1);
    }
  };

  const handleBack = () => {
    if (!isFirst) setStepIdx((i) => i - 1);
  };

  const handleSkipAll = () => {
    localStorage.setItem(dismissedKey(activeCompanyId), '1');
    onComplete?.();
  };

  const handleFinish = () => {
    localStorage.setItem(dismissedKey(activeCompanyId), '1');
    onComplete?.();
  };

  /* Branding asset uploads — wired the same way Settings → Company Profile
   * does it (separate multipart endpoints, not part of the system PUT). */
  const onLogoUpload = async ({ file, onSuccess, onError }) => {
    try {
      await settingsAPI.uploadLogo(file);
      setHasLogo(true);
      setAssetVersion((v) => v + 1);
      message.success('Logo uploaded');
      onSuccess?.();
    } catch (e) {
      message.error(e?.response?.data?.error || 'Logo upload failed');
      onError?.(e);
    }
  };
  const onLogoRemove = async () => {
    try { await settingsAPI.removeLogo(); setHasLogo(false); setAssetVersion((v) => v + 1); message.success('Logo removed'); }
    catch { message.error('Could not remove logo'); }
  };
  const onSignatureUpload = async ({ file, onSuccess, onError }) => {
    try {
      await settingsAPI.uploadSignature(file);
      setHasSignature(true);
      setAssetVersion((v) => v + 1);
      message.success('Signature uploaded');
      onSuccess?.();
    } catch (e) {
      message.error(e?.response?.data?.error || 'Signature upload failed');
      onError?.(e);
    }
  };
  const onSignatureRemove = async () => {
    try { await settingsAPI.removeSignature(); setHasSignature(false); setAssetVersion((v) => v + 1); message.success('Signature removed'); }
    catch { message.error('Could not remove signature'); }
  };

  /* Global keyboard shortcuts — match the F-key vocabulary used in
   * EntityFormModal + SalesBillForm so the wizard feels like the rest
   * of the app.
   *
   *   F1     — Next / Finish on last step (the screen's primary action)
   *   F2     — Back (mirrors F2 = "previous" in some Tally screens)
   *   F5     — Reset current step to last-saved values (not implemented
   *            for the wizard since each Next already persists; reserved)
   *   F8     — Save & Finish (skips remaining steps; same effect as
   *            clicking Finish on the last screen)
   *   Esc    — "I'll do this later" (dismiss)
   *   Enter  — same as F1 (when not in a textarea)
   *   Alt+1..6 — jump directly to step N (1=Identity, 6=Branding)
   *
   * Bindings stay active on the completion screen for Esc/Enter so the
   * user can dismiss with the keyboard from "You're all set" too.
   */
  useEffect(() => {
    const handler = (e) => {
      // Allow Alt+N to work even on the completion screen — no harm.
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < STEPS.length && !done) {
          e.preventDefault();
          setStepIdx(idx);
        }
        return;
      }
      if (done) {
        if (e.key === 'Enter' || e.key === 'F1') {
          e.preventDefault();
          handleFinish();
        }
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        handleNext();
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        if (!isFirst && !saving) handleBack();
        return;
      }
      if (e.key === 'F8') {
        e.preventDefault();
        // Jump to last step and trigger Next, persisting whatever fields
        // the user has typed across earlier steps as they go.
        if (!saving) handleNext();
        return;
      }
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        handleSkipAll();
        return;
      }
      if (e.key === 'Enter' && !(e.target?.tagName === 'TEXTAREA')) {
        // Only the wizard's TextArea (invoice footer on Branding step) needs
        // Enter for newlines; the rest benefit from Enter = Next so admins
        // can fly through with the keyboard.
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'body' || tag === 'button') {
          e.preventDefault();
          handleNext();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // Move keyboard focus to the first input on each step transition so the
  // operator can start typing immediately without reaching for the mouse.
  // Refs aren't necessary — we grab the first non-disabled input inside
  // the form whenever stepIdx changes.
  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => {
      const root = document.querySelector('.ob-shell');
      if (!root) return;
      const first = root.querySelector('input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), button[role="radio"]');
      first?.focus?.();
    }, 80);
    return () => clearTimeout(t);
  }, [stepIdx, done]);

  // Build the props passed into each step's renderer. The Address step
  // reads stateOptions; Theme reads style/appearance; Branding reads everything
  // else. Each step's render() destructures only what it needs and ignores the rest.
  const renderProps = useMemo(() => ({
    stateOptions,
    themeStyle, appearance,
    onSetThemeStyle: setThemeStyle,
    onSetAppearance: setAppearance,
    assetVersion, hasLogo, hasSignature,
    onLogoUpload, onLogoRemove, onSignatureUpload, onSignatureRemove,
  }), [stateOptions, themeStyle, appearance, setThemeStyle, setAppearance, assetVersion, hasLogo, hasSignature]);

  return (
    <div className="ob-overlay" role="dialog" aria-modal="true" aria-label="First-run setup">
      <div className="ob-shell">
        {done ? (
          /* ── Completion screen ── */
          <Result
            status="success"
            icon={<CheckCircleOutlined style={{ color: 'var(--accent, #06b6d4)' }} />}
            title="You're all set"
            subTitle="Your company profile is ready. You can change any of these anytime from Settings → Company Profile."
            extra={[
              <Button key="go" type="primary" size="large" icon={<RocketOutlined />} onClick={handleFinish}>
                Start using the app
              </Button>,
            ]}
          />
        ) : (
          <>
            <header className="ob-head">
              <div className="ob-head-title">
                <Title level={3} style={{ margin: 0 }}>Welcome — let's set up your business</Title>
                <Text type="secondary">Takes about 2 minutes. You can edit anything later in Settings.</Text>
              </div>
              <Button type="link" onClick={handleSkipAll} className="ob-skip">
                I'll do this later
              </Button>
            </header>

            <Steps
              current={stepIdx}
              size="small"
              items={STEPS.map((s) => ({ title: s.title }))}
              style={{ marginBottom: 20 }}
            />

            <div className="ob-intro">{step.intro}</div>

            <Form form={form} layout="vertical" requiredMark="optional">
              {step.render(renderProps)}
            </Form>

            <footer className="ob-foot">
              <Button
                size="large"
                icon={<LeftOutlined />}
                onClick={handleBack}
                disabled={isFirst || saving}
              >
                Back <kbd className="ob-kbd">F2</kbd>
              </Button>
              <div className="ob-foot-step">
                Step {stepIdx + 1} of {STEPS.length}
              </div>
              <Button
                type="primary"
                size="large"
                loading={saving}
                onClick={handleNext}
                icon={isLast ? <CheckCircleOutlined /> : <RightOutlined />}
                iconPosition={isLast ? 'start' : 'end'}
              >
                {isLast ? 'Finish' : 'Next'} <kbd className="ob-kbd ob-kbd-on">F1</kbd>
              </Button>
            </footer>
            {/* Bottom keyboard hint strip — matches the F-key vocabulary
             *  used elsewhere (SalesBillForm, EntityFormModal). Keeps the
             *  wizard fully driveable without touching the mouse. */}
            <div className="ob-kbd-hints">
              <span><kbd>F1</kbd> Next</span>
              <span><kbd>F2</kbd> Back</span>
              <span><kbd>Esc</kbd> I'll do this later</span>
              <span><kbd>Alt</kbd>+<kbd>1</kbd>..<kbd>{STEPS.length}</kbd> Jump to step</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* Public helper — used by App.jsx to decide whether to mount the wizard.
 * Returns true when:
 *   - the user hasn't dismissed in this browser AND
 *   - the system_settings row is still on the seeded default name
 *
 * Force-show escape hatch — append `?onboarding=force` to any URL (e.g.
 * http://localhost:5173/?onboarding=force). Bypasses both the dismissal
 * flag and the company-name check so an operator or installer can review
 * the wizard without wiping their data. The flag is consumed on read and
 * disappears as soon as you navigate away. */
export async function shouldShowOnboarding(companyId) {
  if (typeof window === 'undefined') return false;
  // Force-show via query string — power-user trigger.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('onboarding') === 'force') return true;
  } catch {}
  // Per-company dismissal: if this company has been dismissed once, stay
  // dismissed even if other companies haven't. The un-suffixed legacy key
  // is also honoured so users who dismissed BEFORE the per-company keying
  // still don't see the wizard re-pop for their primary company.
  if (window.localStorage?.getItem(dismissedKey(companyId)) === '1') return false;
  if (window.localStorage?.getItem(STORAGE_KEY_PREFIX) === '1' && !companyId) return false;
  try {
    const { data } = await settingsAPI.getSystem();
    const s = data?.data || data || {};
    const name = String(s.company_name || '').trim().toLowerCase();
    // Treat the seeded default OR an empty company name as "fresh".
    return !name || name === 'my company';
  } catch {
    // If we can't reach the API, don't pop the wizard — would be a worse UX
    // to block the post-login screen than to silently skip onboarding once.
    return false;
  }
}
