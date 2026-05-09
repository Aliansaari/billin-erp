/*
 * Settings → Import & Export
 *
 * One-page hub for bulk data movement in/out of the ERP via .xlsx.
 * Entity picker on the left (Customers · Suppliers · Products), actions
 * on the right — Download Template, Export to Excel, Import from Excel.
 *
 * Import flow:
 *   1. pick entity → upload .xlsx
 *   2. POST /api/data/import/:module → server validates every row and
 *      returns { imported, skipped, total, errors[], auto_barcoded }
 *   3. Results dialog shows counts + per-row error table with a
 *      downloadable "Failed rows" workbook (reason column included).
 *   4. Products only — if server reports auto_barcoded > 0, a second
 *      dialog offers to Regenerate / Review / Keep for those rows.
 *
 * Transactions (sales/purchase/receipts) are listed as coming-soon chips
 * — the controller doesn't handle their line-item linkage yet and we'd
 * rather gate than silently drop lines.
 */

import React, { useState } from 'react';
import {
  Card, Upload, Button, Modal, Table, Progress, Space, Tag, message, Alert,
  Typography, Descriptions, Tooltip,
} from 'antd';
import {
  DownloadOutlined, UploadOutlined, FileExcelOutlined, InboxOutlined,
  UserOutlined, BankOutlined, AppstoreOutlined, CheckCircleOutlined,
  WarningOutlined, BarcodeOutlined, FileZipOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { dataAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

const { Title, Text, Paragraph } = Typography;

const ENTITIES = [
  {
    key: 'customers',
    label: 'Customers',
    icon: <UserOutlined />,
    color: '#4F46E5',
    desc: 'Customer master — names, contacts, GSTIN, credit terms, opening balance.',
    ready: true,
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    icon: <BankOutlined />,
    color: '#0EA5E9',
    desc: 'Supplier master — same fields as customers, imports as party_type = Supplier.',
    ready: true,
  },
  {
    key: 'products',
    label: 'Stock Items',
    icon: <AppstoreOutlined />,
    color: '#16A34A',
    desc: 'Products — HSN, GST %, unit, rates, opening stock. Blank Barcode auto-generated; regenerate prompt after import.',
    ready: true,
  },
  {
    key: 'sales_bills',
    label: 'Sales Bills',
    icon: <FileExcelOutlined />,
    color: '#EC4899',
    desc: 'Two-sheet: Bills + Items (linked by Bill Number). Customers + Products must exist first.',
    ready: true,
  },
  {
    key: 'purchase_bills',
    label: 'Purchase Bills',
    icon: <FileExcelOutlined />,
    color: '#F59E0B',
    desc: 'Two-sheet: Bills + Items (linked by Bill Number). Suppliers + Products must exist first.',
    ready: true,
  },
  {
    key: 'payment_receipts',
    label: 'Payments & Receipts',
    icon: <FileExcelOutlined />,
    color: '#8B5CF6',
    desc: 'Single sheet. Type = Payment (money out) or Receipt (money in). Party must exist.',
    ready: true,
  },
];

function saveBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

export default function ImportExport() {
  const navigate = useNavigate();
  const [entity, setEntity]             = useState(ENTITIES[0]);
  const [uploading, setUploading]       = useState(false);
  const [progress, setProgress]         = useState(0);
  const [resultOpen, setResultOpen]     = useState(false);
  const [result, setResult]             = useState(null);

  const [barcodeOpen, setBarcodeOpen]   = useState(false);
  const [barcodeBusy, setBarcodeBusy]   = useState(false);

  const handleTemplate = async () => {
    try {
      const { data } = await dataAPI.downloadTemplate(entity.key);
      saveBlob(data, `${entity.key}_template.xlsx`);
      message.success('Template downloaded');
    } catch (err) {
      message.error(err.response?.data?.error || 'Failed to download template');
    }
  };

  const handleExport = async () => {
    try {
      const { data } = await dataAPI.exportExcel(entity.key);
      const stamp = dayjs().format('YYYY-MM-DD');
      saveBlob(data, `${entity.key}_export_${stamp}.xlsx`);
      message.success('Export downloaded');
    } catch (err) {
      message.error(err.response?.data?.error || 'Export failed');
    }
  };

  const handleUpload = async (file) => {
    setUploading(true);
    setProgress(0);
    try {
      const { data } = await dataAPI.importExcel(entity.key, file, setProgress);
      setResult(data);
      setResultOpen(true);
      // Products with auto-generated barcodes → offer regenerate prompt.
      if (entity.key === 'products' && (data.auto_barcoded || 0) > 0) {
        // Delay so the result modal renders first; barcode prompt chains behind it.
        setTimeout(() => setBarcodeOpen(true), 100);
      }
    } catch (err) {
      message.error(err.response?.data?.error || 'Import failed');
    }
    setUploading(false);
    return false; // Prevent antd Upload's default POST
  };

  const handleDownloadErrors = async () => {
    if (!result?.errors?.length) return;
    try {
      const { data } = await dataAPI.downloadFailedReport(result.errors);
      saveBlob(data, `${entity.key}_failed_rows.xlsx`);
    } catch (err) {
      message.error('Failed to build error report');
    }
  };

  const handleRegenerateBarcodes = async () => {
    if (!result?.auto_barcoded_ids?.length) return;
    setBarcodeBusy(true);
    try {
      const { data } = await dataAPI.regenerateBarcodes(result.auto_barcoded_ids);
      message.success(data.message || `${data.updated?.length || 0} barcodes regenerated`);
      setBarcodeOpen(false);
    } catch (err) {
      message.error(err.response?.data?.error || 'Barcode regeneration failed');
    }
    setBarcodeBusy(false);
  };

  /* ── Render ─────────────────────────────────────────────────────────── */

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Import &amp; Export</h1>
        <p className="ms-page-sub">
          Move master data in and out via Excel (.xlsx). Each entity has a
          downloadable template with an Instructions sheet.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
      {/* Entity picker */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 20 }}>
        {ENTITIES.map(e => {
          const active = entity.key === e.key;
          return (
            <Card
              key={e.key}
              hoverable={e.ready}
              onClick={() => e.ready && setEntity(e)}
              style={{
                cursor: e.ready ? 'pointer' : 'not-allowed',
                opacity: e.ready ? 1 : 0.55,
                border: active ? `2px solid ${e.color}` : undefined,
                transition: 'border-color .12s, box-shadow .12s',
              }}
              bodyStyle={{ padding: 14 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
                  background: `${e.color}15`, color: e.color, fontSize: 16,
                }}>{e.icon}</div>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{e.label}</span>
                {!e.ready && <Tag color="default" style={{ marginLeft: 'auto' }}>Soon</Tag>}
              </div>
              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.4 }}>{e.desc}</Text>
            </Card>
          );
        })}
      </div>

      {/* Action panel for active entity */}
      <Card title={<Space><FileExcelOutlined style={{ color: entity.color }} /> <span>{entity.label}</span></Space>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>

          <Card size="small" type="inner" title="1. Download template">
            <Paragraph style={{ fontSize: 13 }}>
              Starter .xlsx with every column, one sample row, and a separate
              <b> Instructions</b> sheet explaining required/optional fields.
            </Paragraph>
            <Button icon={<DownloadOutlined />} onClick={handleTemplate} block>
              Download {entity.label} Template
            </Button>
          </Card>

          <Card size="small" type="inner" title="2. Import from Excel">
            <Paragraph style={{ fontSize: 13 }}>
              Upload a filled template. The server validates every row; invalid
              rows are skipped and returned with reasons.
            </Paragraph>
            <Upload.Dragger
              name="file"
              accept=".xlsx,.xls,.csv"
              multiple={false}
              showUploadList={false}
              disabled={uploading}
              beforeUpload={handleUpload}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">
                {uploading ? 'Uploading…' : `Drop .xlsx to import ${entity.label.toLowerCase()}`}
              </p>
              <p className="ant-upload-hint" style={{ fontSize: 11 }}>
                Max 10 MB. Large files streamed server-side.
              </p>
            </Upload.Dragger>
            {uploading && <Progress percent={progress} size="small" style={{ marginTop: 8 }} />}
          </Card>

          <Card size="small" type="inner" title="3. Export to Excel">
            <Paragraph style={{ fontSize: 13 }}>
              Download the current database as an .xlsx — <b>round-trip safe</b>,
              the same file can be re-imported without edits.
            </Paragraph>
            <Button icon={<FileZipOutlined />} onClick={handleExport} block>
              Export Current {entity.label}
            </Button>
          </Card>

        </div>
      </Card>

      {/* Import result dialog */}
      <Modal
        open={resultOpen}
        onCancel={() => setResultOpen(false)}
        title={<Space><CheckCircleOutlined style={{ color: '#16a34a' }} /> Import complete</Space>}
        footer={[
          result?.errors?.length ? (
            <Button key="err" icon={<DownloadOutlined />} onClick={handleDownloadErrors} danger>
              Download {result.errors.length} failed rows
            </Button>
          ) : null,
          <Button key="ok" type="primary" onClick={() => setResultOpen(false)}>Done</Button>,
        ].filter(Boolean)}
        width={720}
      >
        {result && (
          <>
            <Descriptions column={3} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Imported">
                <Tag color="green">{result.imported}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Skipped">
                <Tag color="orange">{result.skipped}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Total rows">{result.total}</Descriptions.Item>
            </Descriptions>

            {result.auto_barcoded > 0 && (
              <Alert
                type="info"
                showIcon
                icon={<BarcodeOutlined />}
                message={`${result.auto_barcoded} items were auto-barcoded`}
                description="Your Barcode column was blank for these rows, so the system assigned barcodes using your current prefix/numbering. Use the prompt that follows to Keep, Review, or Regenerate."
                style={{ marginBottom: 16 }}
              />
            )}

            {result.errors?.length > 0 ? (
              <Table
                dataSource={result.errors}
                rowKey={(r, i) => `${r.row}-${i}`}
                size="small"
                pagination={{ pageSize: 8 }}
                columns={[
                  { title: 'Row #', dataIndex: 'row', width: 70 },
                  { title: 'Reason', dataIndex: 'reason', render: (t) => <Text type="danger">{t}</Text> },
                ]}
              />
            ) : (
              <Alert type="success" showIcon message="All rows imported cleanly." />
            )}
          </>
        )}
      </Modal>

      {/* Auto-barcode review prompt (products only) */}
      <Modal
        open={barcodeOpen}
        onCancel={() => setBarcodeOpen(false)}
        title={<Space><BarcodeOutlined /> Auto-barcoded items</Space>}
        confirmLoading={barcodeBusy}
        footer={[
          <Button key="keep" onClick={() => setBarcodeOpen(false)}>Keep as-is</Button>,
          <Tooltip key="review-tip" title="Coming in a future build — for now, regenerate or keep">
            <Button disabled>Review each</Button>
          </Tooltip>,
          <Button key="regen" type="primary" icon={<BarcodeOutlined />} loading={barcodeBusy} onClick={handleRegenerateBarcodes}>
            Regenerate barcodes
          </Button>,
        ]}
      >
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={`${result?.auto_barcoded || 0} items were imported without a barcode`}
          description={
            <>
              We assigned each one a barcode using your current settings
              (<Text code>Barcode Settings → prefix &amp; numbering</Text>). You can:
              <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 22 }}>
                <li><b>Regenerate</b> — allocate fresh numbers under the current scheme (recommended if barcode settings changed after the import).</li>
                <li><b>Keep as-is</b> — the auto-assigned numbers are already valid.</li>
              </ul>
            </>
          }
        />
      </Modal>
        </div>
      </div>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
        ]}
      />
    </div>
  );
}
