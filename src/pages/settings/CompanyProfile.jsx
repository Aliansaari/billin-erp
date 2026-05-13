import React, { useEffect, useState } from 'react';
import {
  Card, Form, Input, Button, DatePicker, Row, Col, Typography, message,
  Divider, Tabs, Select, Upload,
} from 'antd';
import { SaveOutlined, UploadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { settingsAPI } from '../../api';
import { refreshFinancialYear } from '../../hooks/useFinancialYear';
import useIndianStates from '../../hooks/useIndianStates';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

const { Title } = Typography;
const { TextArea } = Input;

export default function CompanyProfile() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Server-driven Indian states list (with built-in fallback if API fails).
  const { options: stateOptions } = useIndianStates();
  // Cache-bust counter for the logo/signature <img> previews — bumped
  // after upload so the new file shows immediately without a hard reload.
  const [assetVersion, setAssetVersion] = useState(0);
  const [hasLogo, setHasLogo] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const navigate = useNavigate();

  useEffect(() => { loadSettings(); }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const { data } = await settingsAPI.getSystem();
      const s = (data && data.data) ? data.data : data;
      if (!s) throw new Error('No settings returned');
      form.setFieldsValue({
        // Identity
        company_name:    s.company_name || '',
        company_phone:   s.company_phone || '',
        company_phone_2: s.company_phone_2 || '',
        company_email:   s.company_email || '',
        company_website: s.company_website || '',
        // Address
        company_address_line_1: s.company_address_line_1 || '',
        company_address_line_2: s.company_address_line_2 || '',
        company_city:           s.company_city || '',
        company_state:          s.company_state || '',
        company_pincode:        s.company_pincode || '',
        company_country:        s.company_country || 'India',
        // Legacy field — still editable on the Identity tab as "Address
        // (legacy, for old invoice templates)". Hidden when the
        // structured fields are populated.
        company_address:        s.company_address || '',
        // FY
        financial_year_start: s.financial_year_start ? dayjs(s.financial_year_start) : null,
        financial_year_end:   s.financial_year_end   ? dayjs(s.financial_year_end)   : null,
        // Tax
        gstin:        s.gstin || '',
        pan_number:   s.pan_number || '',
        tan_number:   s.tan_number || '',
        cin_number:   s.cin_number || '',
        msme_udyam:   s.msme_udyam || '',
        drug_license:  s.drug_license || '',
        fssai_license: s.fssai_license || '',
        // Banking
        bank_name:           s.bank_name || '',
        bank_account_holder: s.bank_account_holder || '',
        bank_account_number: s.bank_account_number || '',
        bank_ifsc:           s.bank_ifsc || '',
        bank_branch:         s.bank_branch || '',
        bank_upi_id:         s.bank_upi_id || '',
        // Branding
        invoice_footer: s.invoice_footer || '',
      });
      setHasLogo(!!s.logo_path);
      setHasSignature(!!s.signature_path);
    } catch (error) {
      console.error('CompanyProfile load error:', error);
      message.error('Failed to load company settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (values) => {
    setSaving(true);
    try {
      await settingsAPI.updateSystem({
        ...values,
        financial_year_start: values.financial_year_start?.format('YYYY-MM-DD'),
        financial_year_end:   values.financial_year_end?.format('YYYY-MM-DD'),
      });
      await refreshFinancialYear();
      message.success('Company profile updated successfully');
    } catch (error) {
      message.error(error.response?.data?.error || 'Failed to update company profile');
    } finally {
      setSaving(false);
    }
  };

  // Wrap antd's <Upload> in a non-form-submit handler. customRequest
  // sends the file directly via settingsAPI.uploadLogo() so the file
  // never goes through antd's default XHR (which doesn't carry our
  // auth header).
  const onLogoUpload = async ({ file, onSuccess, onError }) => {
    try {
      await settingsAPI.uploadLogo(file);
      setHasLogo(true);
      setAssetVersion(v => v + 1);
      message.success('Logo uploaded');
      onSuccess?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Logo upload failed');
      onError?.(e);
    }
  };
  const onSignatureUpload = async ({ file, onSuccess, onError }) => {
    try {
      await settingsAPI.uploadSignature(file);
      setHasSignature(true);
      setAssetVersion(v => v + 1);
      message.success('Signature uploaded');
      onSuccess?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Signature upload failed');
      onError?.(e);
    }
  };
  const onLogoRemove = async () => {
    try {
      await settingsAPI.removeLogo();
      setHasLogo(false);
      message.success('Logo removed');
    } catch { message.error('Failed to remove logo'); }
  };
  const onSignatureRemove = async () => {
    try {
      await settingsAPI.removeSignature();
      setHasSignature(false);
      message.success('Signature removed');
    } catch { message.error('Failed to remove signature'); }
  };

  const tabs = [
    {
      key: 'identity',
      label: 'Identity & Contact',
      children: (
        <div>
          <Row gutter={16}>
            <Col xs={24} md={16}>
              <Form.Item name="company_name" label="Company Name" rules={[{ required: true, message: 'Please enter company name' }]}>
                <Input placeholder="Enter company name" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="company_website" label="Website">
                <Input placeholder="https://example.com" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="company_phone" label="Primary Phone" help="10 digits, no +91 prefix needed">
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
          <Divider>Financial Year</Divider>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="financial_year_start" label="Financial Year Start" rules={[{ required: true, message: 'Please select start date' }]}>
                <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="financial_year_end" label="Financial Year End" rules={[{ required: true, message: 'Please select end date' }]}>
                <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
              </Form.Item>
            </Col>
          </Row>
          {/* Legacy single-line address kept so old invoice templates still
              render. New fields on the Address tab supersede it; leave blank
              once those are filled. */}
          <Divider>Legacy address (optional)</Divider>
          <Form.Item name="company_address" label="Address (legacy single-line)"
                     help="Older invoice templates print this. Leave blank if you fill the structured fields on the Address tab.">
            <TextArea rows={2} placeholder="(optional)" />
          </Form.Item>
        </div>
      ),
    },
    {
      key: 'address',
      label: 'Address',
      children: (
        <div>
          <Form.Item name="company_address_line_1" label="Address Line 1">
            <Input placeholder="Shop number, building, street" />
          </Form.Item>
          <Form.Item name="company_address_line_2" label="Address Line 2">
            <Input placeholder="Locality, landmark (optional)" />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="company_city" label="City">
                <Input placeholder="Mumbai" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="company_state" label="State"
                help="Required for GST place-of-supply routing. Drives inter-state IGST vs intra-state CGST+SGST."
              >
                <Select
                  showSearch placeholder="Select state"
                  options={stateOptions}
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item name="company_pincode" label="Pincode">
                <Input placeholder="400001" maxLength={6} />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item name="company_country" label="Country">
                <Input placeholder="India" />
              </Form.Item>
            </Col>
          </Row>
        </div>
      ),
    },
    {
      key: 'tax',
      label: 'Tax Registrations',
      children: (
        <div>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="gstin" label="GSTIN"
                         help="15 chars e.g. 27ABCDE1234F1Z5. Drives every GST calculation.">
                <Input placeholder="27ABCDE1234F1Z5" maxLength={15} style={{ textTransform: 'uppercase' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="pan_number" label="PAN"
                         help="10 chars e.g. ABCDE1234F. Printed on invoices.">
                <Input placeholder="ABCDE1234F" maxLength={10} style={{ textTransform: 'uppercase' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="tan_number" label="TAN (TDS)"
                         help="Required if you deduct TDS on payments.">
                <Input placeholder="DELI12345E" maxLength={10} style={{ textTransform: 'uppercase' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="cin_number" label="CIN"
                         help="Mandatory for Pvt Ltd / LLP / OPC under Companies Act §12.">
                <Input placeholder="L17110MH1973PLC019786" maxLength={21} style={{ textTransform: 'uppercase' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="msme_udyam" label="MSME / Udyam Reg."
                         help="Lets you print 'Payment due within 45 days under MSMED Act'.">
                <Input placeholder="UDYAM-MH-01-1234567" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="drug_license" label="Drug License (pharma)">
                <Input placeholder="20B / 21B / 20F number" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="fssai_license" label="FSSAI License (food)">
                <Input placeholder="14-digit FSSAI number" />
              </Form.Item>
            </Col>
          </Row>
        </div>
      ),
    },
    {
      key: 'banking',
      label: 'Banking',
      children: (
        <div>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
            These details print on every invoice in the "Pay via NEFT / UPI" section.
            UPI ID also generates a QR code on the invoice for instant payment.
          </Typography.Paragraph>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="bank_account_holder" label="Account Holder Name">
                <Input placeholder="As per bank records" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="bank_name" label="Bank Name">
                <Input placeholder="e.g. HDFC Bank" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="bank_account_number" label="Account Number"
                         help="6-20 digits, no spaces.">
                <Input placeholder="50100123456789" />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item name="bank_ifsc" label="IFSC"
                         help="11 chars, 4 letters + 0 + 6 alphanumeric.">
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
        </div>
      ),
    },
    {
      key: 'branding',
      label: 'Branding',
      children: (
        <div>
          <Row gutter={32}>
            <Col xs={24} md={12}>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>Company Logo</div>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                Printed on the top-left of every invoice. PNG / JPEG / SVG. Max 5 MB.
              </Typography.Paragraph>
              {hasLogo && (
                <div style={{ marginBottom: 12, padding: 12, background: 'var(--bg-input, #f6f7f9)', borderRadius: 6, display: 'inline-block' }}>
                  <img
                    src={`/api/settings/branding/logo?v=${assetVersion}`}
                    alt="Company logo"
                    style={{ maxWidth: 200, maxHeight: 100, display: 'block' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <Upload
                  customRequest={onLogoUpload}
                  showUploadList={false}
                  accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                >
                  <Button icon={<UploadOutlined />}>
                    {hasLogo ? 'Replace logo' : 'Upload logo'}
                  </Button>
                </Upload>
                {hasLogo && (
                  <Button danger icon={<DeleteOutlined />} onClick={onLogoRemove}>
                    Remove
                  </Button>
                )}
              </div>
            </Col>
            <Col xs={24} md={12}>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>Authorized Signatory</div>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                Image of the authorised signatory's signature. Printed in the
                bottom-right "For Company Name" box.
              </Typography.Paragraph>
              {hasSignature && (
                <div style={{ marginBottom: 12, padding: 12, background: 'var(--bg-input, #f6f7f9)', borderRadius: 6, display: 'inline-block' }}>
                  <img
                    src={`/api/settings/branding/signature?v=${assetVersion}`}
                    alt="Signature"
                    style={{ maxWidth: 200, maxHeight: 100, display: 'block' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <Upload
                  customRequest={onSignatureUpload}
                  showUploadList={false}
                  accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                >
                  <Button icon={<UploadOutlined />}>
                    {hasSignature ? 'Replace signature' : 'Upload signature'}
                  </Button>
                </Upload>
                {hasSignature && (
                  <Button danger icon={<DeleteOutlined />} onClick={onSignatureRemove}>
                    Remove
                  </Button>
                )}
              </div>
            </Col>
          </Row>
          <Divider />
          <Form.Item name="invoice_footer" label="Invoice Footer"
                     help="Free text printed at the bottom of every invoice. Typical: jurisdiction clause, return policy, thank-you message.">
            <TextArea rows={4} placeholder="All disputes subject to Mumbai jurisdiction. E. & O. E." />
          </Form.Item>
        </div>
      ),
    },
  ];

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Company Profile</h1>
        <p className="ms-page-sub">
          Business identity printed on invoices and used for GST calculations.
          Save with <kbd>F1</kbd>.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Card loading={loading} bordered={false} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
            <Form form={form} layout="vertical" onFinish={handleSave}>
              <Tabs items={tabs} defaultActiveKey="identity" />
              <div style={{ marginTop: 16 }}>
                <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
                  Save Changes
                </Button>
              </div>
            </Form>
          </Card>
        </div>
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: () => navigate('/') },
          { id: 'save', key: 'F1', label: 'Save', tone: 'primary',
            disabled: saving || loading,
            onAction: () => form.submit() },
        ]}
      />
    </div>
  );
}
