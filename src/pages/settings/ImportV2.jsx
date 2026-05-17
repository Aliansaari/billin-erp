// ── Import flow (Phase 6) ───────────────────────────────────────────────
//
// One page for both accounting-XML and Excel imports, driven by the queue.
//   1. Pick source / template
//   2. Upload file → POST /api/imports
//   3. Poll GET /api/imports/:id every 2s
//   4. Mapping screen (accounting-XML only) when status='awaiting_confirmation' AND
//      mapping_json is populated
//   5. Preview screen when status='awaiting_confirmation' AND preview_json
//      is populated
//   6. Result modal when status='done'
//   7. Failure modal when status='failed'
//
// The UI is a guided 3-step flow (pick → template → upload) plus a polished
// live-job panel. None of the import logic / handlers / API calls changed —
// only the presentation. Numerics use Geist Mono to match the design system.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Button, Select, Upload, Space, Typography, Progress, Tag, Table, Modal, Alert, Divider, message, Steps } from 'antd';
import {
  ReloadOutlined, StopOutlined, DownloadOutlined,
  ThunderboltOutlined, InboxOutlined, InfoCircleOutlined,
  UserOutlined, BankOutlined, AppstoreOutlined, FileExcelOutlined,
  WalletOutlined, ApiOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { importsAPI, ledgerAPI, dataAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';
import './ImportV2.css';

const { Title, Text } = Typography;

const SOURCES = [
  { value: 'tally',             label: 'Accounting XML' },
  { value: 'excel_customers',   label: 'Excel · Customers' },
  { value: 'excel_suppliers',   label: 'Excel · Suppliers' },
  { value: 'excel_products',    label: 'Excel · Products' },
  { value: 'excel_sales',       label: 'Excel · Sales Bills' },
  { value: 'excel_purchases',   label: 'Excel · Purchase Bills' },
  { value: 'excel_payments',    label: 'Excel · Payments / Receipts' },
];

// Presentation-only metadata: which icon/colour to show for each source,
// the matching .xlsx template module (null = XML, no template), and a
// one-line "what this needs" hint. Template module keys match the server's
// /api/data/template/:module switch.
const SOURCE_META = {
  tally:           { icon: <ApiOutlined />,       color: '#64748B', tmpl: null,               kind: 'XML',  hint: 'XML voucher / master export from your accounting software.' },
  excel_customers: { icon: <UserOutlined />,      color: '#4F46E5', tmpl: 'customers',        kind: 'XLSX', hint: 'Customer master — names, contacts, GSTIN, credit terms.' },
  excel_suppliers: { icon: <BankOutlined />,      color: '#0EA5E9', tmpl: 'suppliers',        kind: 'XLSX', hint: 'Supplier master — same fields, imported as Supplier.' },
  excel_products:  { icon: <AppstoreOutlined />,  color: '#16A34A', tmpl: 'products',         kind: 'XLSX', hint: 'Products — HSN, GST %, unit, rates, opening stock.' },
  excel_sales:     { icon: <FileExcelOutlined />, color: '#EC4899', tmpl: 'sales_bills',      kind: 'XLSX', hint: 'Two sheets: Bills + Items linked by Bill Number.' },
  excel_purchases: { icon: <FileExcelOutlined />, color: '#F59E0B', tmpl: 'purchase_bills',   kind: 'XLSX', hint: 'Two sheets: Bills + Items linked by Bill Number.' },
  excel_payments:  { icon: <WalletOutlined />,    color: '#8B5CF6', tmpl: 'payment_receipts', kind: 'XLSX', hint: 'Single sheet. Type = Payment (out) or Receipt (in).' },
};

// Presentation-only status copy/tone for the live-job badge.
const STATUS_META = {
  queued:                { label: 'Queued',      tone: 'process' },
  parsing:               { label: 'Parsing',     tone: 'process' },
  validating:            { label: 'Validating',  tone: 'process' },
  awaiting_confirmation: { label: 'Needs review',tone: 'warning' },
  committing:            { label: 'Committing',  tone: 'process' },
  done:                  { label: 'Completed',   tone: 'success' },
  failed:                { label: 'Failed',      tone: 'danger'  },
  cancelled:             { label: 'Cancelled',   tone: 'muted'   },
};

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_STEP = {
  queued: 0, parsing: 1, validating: 2,
  awaiting_confirmation: 3, committing: 4,
  done: 5, failed: 5, cancelled: 5,
};

export default function ImportV2() {
  const navigate = useNavigate();
  const [source, setSource]     = useState('excel_customers');
  const [file, setFile]         = useState(null);
  const [job, setJob]           = useState(null);
  const [polling, setPolling]   = useState(false);
  const pollRef = useRef(null);
  const [resultOpen, setResultOpen] = useState(false);

  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } setPolling(false); };

  const startPolling = (jobId) => {
    stopPolling();
    setPolling(true);
    pollRef.current = setInterval(async () => {
      try {
        const res = await importsAPI.getById(jobId);
        setJob(res.data);
        if (['done', 'failed', 'cancelled'].includes(res.data.status)) {
          stopPolling();
          setResultOpen(true);
        }
      } catch (e) {
        // 404 = job missing; stop quietly.
        stopPolling();
      }
    }, 2000);
  };

  useEffect(() => () => stopPolling(), []);

  const handleStart = async () => {
    if (!file) return message.error('Please select a file first.');
    const fd = new FormData();
    fd.append('source', source);
    fd.append('profile', JSON.stringify({}));
    fd.append('file', file);
    try {
      const res = await importsAPI.create(fd);
      const jobId = res.data.job_id;
      message.success(`Import #${jobId} queued.`);
      const j = (await importsAPI.getById(jobId)).data;
      setJob(j);
      startPolling(jobId);
    } catch (e) {
      message.error(e.response?.data?.error || 'Upload failed.');
    }
  };

  const handleCancel = async () => {
    if (!job) return;
    await importsAPI.cancel(job.id);
    message.info('Cancelling…');
  };

  const handleConfirmPreview = async (uncheckedUpdates = []) => {
    if (!job) return;
    await importsAPI.confirm(job.id, { confirmed: true, unchecked_updates: uncheckedUpdates });
    message.info('Continuing…');
  };

  const reset = () => {
    stopPolling();
    setJob(null); setFile(null); setResultOpen(false);
  };

  // F5 = Refresh — re-fetch the current job's status, useful if polling
  // was stopped (e.g. screen was idle long enough that the timer paused).
  const handleRefresh = async () => {
    if (!job) return;
    try {
      const res = await importsAPI.getById(job.id);
      setJob(res.data);
    } catch (e) {
      message.error('Failed to refresh job status.');
    }
  };

  // Auth'd blob download. A direct <a href> would skip the Authorization
  // header and 401. We fetch the blob via the API client (which injects
  // the JWT), then trigger the save with a transient object URL.
  const handleDownloadRejected = async () => {
    if (!job) return;
    try {
      const res = await importsAPI.rejectedRowsBlob(job.id);
      const url = URL.createObjectURL(new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `rejected-rows-${job.id}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after the click is queued so the browser has time to start
      // the download. 1s is conservative.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      message.error(e.response?.data?.error || 'Download failed.');
    }
  };

  // Template download. Same auth'd-blob pattern as handleDownloadRejected —
  // the JWT must ride along, so we fetch via the API client and save with a
  // transient object URL. Uses the existing /api/data/template/:module
  // endpoint (unchanged); XML sources have no template and never reach this.
  const handleTemplate = async () => {
    const meta = SOURCE_META[source];
    if (!meta || !meta.tmpl) return;
    try {
      const res = await dataAPI.downloadTemplate(meta.tmpl);
      const url = URL.createObjectURL(new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${meta.tmpl}_template.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.success('Template downloaded.');
    } catch (e) {
      message.error(e.response?.data?.error || 'Template download failed.');
    }
  };

  const meta = SOURCE_META[source] || {};
  const srcLabel = (SOURCES.find((s) => s.value === source) || {}).label || source;
  const terminal = job && ['done', 'failed', 'cancelled'].includes(job.status);
  const statusMeta = (job && STATUS_META[job.status]) || { label: job?.status || '', tone: 'muted' };

  return (
    <div className="ms-shell settings-pane-fill impv2-shell">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Import (queued)</h1>
        <p className="ms-page-sub">
          Bring in customers, products, bills or an accounting XML export. It runs as a background
          job, so the app stays responsive while thousands of rows are validated and posted.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">

      {/* ── Setup: guided 3-step flow ───────────────────────────────── */}
      {!job && (
        <div className="impv2-flow">

          {/* Step 1 — choose what to import */}
          <section className="impv2-card">
            <div className="impv2-card-head">
              <span className="impv2-step-badge">1</span>
              <div>
                <h2 className="impv2-card-title">What are you importing?</h2>
                <p className="impv2-card-sub">Pick a data type — each one expects its own file layout.</p>
              </div>
            </div>
            <div className="impv2-source-grid">
              {SOURCES.map((s) => {
                const m = SOURCE_META[s.value] || {};
                const active = source === s.value;
                return (
                  <button
                    type="button"
                    key={s.value}
                    className={`impv2-source${active ? ' active' : ''}`}
                    onClick={() => setSource(s.value)}
                    style={active ? { borderColor: m.color, boxShadow: `0 0 0 1px ${m.color}` } : undefined}
                  >
                    <span className="impv2-source-ico" style={{ background: `${m.color}1A`, color: m.color }}>
                      {m.icon}
                    </span>
                    <span className="impv2-source-main">
                      <span className="impv2-source-label">{s.label}</span>
                      <span className="impv2-source-desc">{m.hint}</span>
                    </span>
                    <span className="impv2-source-chip">{m.kind}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Step 2 — get the template */}
          <section className="impv2-card">
            <div className="impv2-card-head">
              <span className="impv2-step-badge">2</span>
              <div>
                <h2 className="impv2-card-title">Get the template</h2>
                <p className="impv2-card-sub">
                  {meta.tmpl
                    ? 'Start from our .xlsx — every column, one sample row, and an Instructions sheet.'
                    : 'No template needed — this source reads a raw XML export.'}
                </p>
              </div>
            </div>
            {meta.tmpl ? (
              <div className="impv2-tmpl">
                <div className="impv2-tmpl-info">
                  <span className="impv2-tmpl-ico"><FileExcelOutlined /></span>
                  <div>
                    <div className="impv2-tmpl-name">{meta.tmpl}_template.xlsx</div>
                    <div className="impv2-tmpl-meta">Keep the header row · fill rows below it · save as .xlsx</div>
                  </div>
                </div>
                <Button icon={<DownloadOutlined />} onClick={handleTemplate}>
                  Download template
                </Button>
              </div>
            ) : (
              <div className="impv2-note">
                <InfoCircleOutlined />
                <span>
                  Export an XML file from your accounting software
                  (e.g. <Text strong>Tally → Gateway of Tally → Export</Text>), then upload it below.
                  Ledger names you haven't mapped yet will be matched on the next screen.
                </span>
              </div>
            )}
          </section>

          {/* Step 3 — upload & start */}
          <section className="impv2-card">
            <div className="impv2-card-head">
              <span className="impv2-step-badge">3</span>
              <div>
                <h2 className="impv2-card-title">Upload &amp; start</h2>
                <p className="impv2-card-sub">
                  Every row is validated before anything is written — invalid rows come back with reasons.
                </p>
              </div>
            </div>
            <Upload.Dragger
              className="impv2-drop"
              beforeUpload={(f) => { setFile(f); return false; }}
              fileList={file ? [file] : []}
              onRemove={() => setFile(null)}
              maxCount={1}
              accept={meta.tmpl ? '.xlsx,.xls,.csv' : '.xml'}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">
                Drop your {meta.kind || 'data'} file here, or click to browse
              </p>
              <p className="ant-upload-hint">
                {meta.tmpl
                  ? 'Excel workbook (.xlsx / .xls / .csv) for ' + srcLabel
                  : 'Accounting XML export (.xml)'}
              </p>
            </Upload.Dragger>
            <div className="impv2-actions">
              <Button
                type="primary"
                size="large"
                icon={<ThunderboltOutlined />}
                onClick={handleStart}
                disabled={!file}
              >
                Start import
              </Button>
              {file && <Button onClick={() => setFile(null)}>Clear</Button>}
            </div>
          </section>
        </div>
      )}

      {/* ── Active job ──────────────────────────────────────────────── */}
      {job && (
        <>
          <section className="impv2-card">
            <div className="impv2-job-top">
              <div className="impv2-job-id">
                <span
                  className="impv2-source-ico"
                  style={{ background: `${meta.color || '#64748B'}1A`, color: meta.color || '#64748B' }}
                >
                  {meta.icon || <FileExcelOutlined />}
                </span>
                <div>
                  <div className="impv2-job-title">Import #{job.id}</div>
                  <div className="impv2-job-src">{srcLabel}</div>
                </div>
              </div>
              <div className="impv2-job-right">
                <span className={`impv2-badge impv2-badge--${statusMeta.tone}`}>{statusMeta.label}</span>
                {!terminal && (
                  <Button danger icon={<StopOutlined />} onClick={handleCancel}>Cancel</Button>
                )}
                <Button icon={<ReloadOutlined />} onClick={reset}>New import</Button>
              </div>
            </div>

            <Steps current={STATUS_STEP[job.status] || 0} size="small"
              status={job.status === 'failed' ? 'error' : job.status === 'cancelled' ? 'error' : 'process'}
              items={[
                { title: 'Queued' }, { title: 'Parsing' }, { title: 'Validating' },
                { title: 'Confirm' }, { title: 'Committing' },
                { title: job.status === 'failed' ? 'Failed' : job.status === 'cancelled' ? 'Cancelled' : 'Done' },
              ]}
            />
            <Progress
              style={{ marginTop: 18 }}
              percent={job.progress_pct || 0}
              status={job.status === 'failed' || job.status === 'cancelled' ? 'exception' : (job.status === 'done' ? 'success' : 'active')}
            />
            <div className="impv2-phase">{job.phase_message || ''}</div>
          </section>

          {/* Preview screen */}
          {job.status === 'awaiting_confirmation' && job.preview_json && !job.mapping_json?.needs_review?.length && (
            <PreviewPanel job={job} onConfirm={handleConfirmPreview} onCancel={handleCancel} />
          )}

          {/* Mapping screen (accounting-XML) */}
          {job.status === 'awaiting_confirmation' && job.mapping_json && (job.mapping_json.needs_review || []).length > 0 && (
            <MappingPanel job={job} />
          )}
        </>
      )}

      {/* Result modal */}
      <Modal
        open={resultOpen && job}
        title={job && (job.status === 'done' ? 'Import complete' : job.status === 'cancelled' ? 'Import cancelled' : 'Import failed')}
        onCancel={() => setResultOpen(false)}
        footer={[
          (job && job.rejected_rows_path) ? (
            <Button key="reject" icon={<DownloadOutlined />} onClick={handleDownloadRejected}>
              Download rejected rows
            </Button>
          ) : null,
          <Button key="done" type="primary" onClick={() => { setResultOpen(false); reset(); }}>Done</Button>,
        ].filter(Boolean)}
      >
        {job && job.status === 'done' && job.result_summary_json && (
          <div>
            <p><Text strong>Posted:</Text> <span style={{ fontFamily: 'Geist Mono, monospace' }}>{job.result_summary_json.posted}</span></p>
            <p><Text strong>Skipped:</Text> <span style={{ fontFamily: 'Geist Mono, monospace' }}>{job.result_summary_json.skipped}</span></p>
            <p><Text strong>Rejected:</Text> <span style={{ fontFamily: 'Geist Mono, monospace' }}>{job.result_summary_json.rejected}</span></p>
            {job.result_summary_json.failed > 0 && <p><Text type="danger">Failed: {job.result_summary_json.failed}</Text></p>}
          </div>
        )}
        {job && job.status === 'failed' && (
          <Alert type="error" showIcon message="Import failed" description={job.error_message || 'Unknown error.'} />
        )}
        {job && job.status === 'cancelled' && (
          <Alert type="warning" showIcon message="Import cancelled" description="Already-committed rows are still in the database." />
        )}
      </Modal>
        </div>
      </div>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            disabled: !job,
            onAction: handleRefresh,
          },
        ]}
      />
    </div>
  );
}

// ── Preview panel ──────────────────────────────────────────────────────
function PreviewPanel({ job, onConfirm, onCancel }) {
  const p = job.preview_json || {};
  const [uncheckedUpdates, setUnchecked] = useState([]);
  const counts = p.counts || {};
  return (
    <Card style={{ marginTop: 16 }}>
      <Title level={5} style={{ margin: 0, marginBottom: 8 }}>Review before commit</Title>
      <Space size="middle" style={{ marginBottom: 12 }}>
        <Tag color="green" style={{ fontFamily: 'Geist Mono, monospace' }}>create {counts.create || 0}</Tag>
        <Tag color="blue"  style={{ fontFamily: 'Geist Mono, monospace' }}>update {counts.update || 0}</Tag>
        <Tag color="default" style={{ fontFamily: 'Geist Mono, monospace' }}>skip {counts.skip || 0}</Tag>
        <Tag color="red"   style={{ fontFamily: 'Geist Mono, monospace' }}>reject {counts.reject || 0}</Tag>
      </Space>

      {p.sample?.create?.length > 0 && (
        <Bucket title="Will create" rows={p.sample.create} />
      )}
      {p.sample?.update?.length > 0 && (
        <Bucket title="Will update" rows={p.sample.update} updates onToggle={(id) => {
          setUnchecked((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
        }} unchecked={uncheckedUpdates} />
      )}
      {p.sample?.reject?.length > 0 && (
        <Bucket title="Will reject" rows={p.sample.reject} reject />
      )}

      <Divider />
      <Space>
        <Button type="primary" onClick={() => onConfirm(uncheckedUpdates)}>
          Continue with {(counts.create || 0) + (counts.update || 0) - uncheckedUpdates.length} record(s)
        </Button>
        <Button onClick={onCancel}>Cancel import</Button>
      </Space>
    </Card>
  );
}

function Bucket({ title, rows = [], reject = false, updates = false }) {
  if (!rows.length) return null;
  const mono = { fontFamily: 'Geist Mono, monospace' };
  const cols = reject
    ? [
        { title: 'Row / Voucher', key: 'r', render: (_, r) => r.voucher_number || r.row || '—' },
        { title: 'Reason', dataIndex: 'reason', ellipsis: true },
      ]
    : updates
    ? [
        { title: 'Identifier', key: 'id', render: (_, r) => r.voucher_number || r.identifier || '—' },
        { title: 'Date',  key: 'date', render: (_, r) => r.date || '—' },
        { title: 'Old',   key: 'old',   align: 'right', render: (_, r) => r.old_total != null || r.existing_total != null ? <span style={mono}>{fmt(r.old_total != null ? r.old_total : r.existing_total)}</span> : '—' },
        { title: 'New',   key: 'new',   align: 'right', render: (_, r) => r.new_total != null || r.total != null ? <span style={mono}>{fmt(r.new_total != null ? r.new_total : r.total)}</span> : '—' },
      ]
    : [
        { title: 'Identifier', key: 'id', render: (_, r) => r.voucher_number || r.identifier || '—' },
        { title: 'Date',  key: 'date', render: (_, r) => r.date || '—' },
        { title: 'Total', key: 'tot',  align: 'right', render: (_, r) => r.total != null ? <span style={mono}>{fmt(r.total)}</span> : '—' },
      ];
  return (
    <div style={{ marginBottom: 12 }}>
      <Text strong>{title}</Text>
      <Table size="small" pagination={false} rowKey={(_r, i) => i} columns={cols} dataSource={rows} style={{ marginTop: 4 }} />
    </div>
  );
}

// ── Mapping panel (accounting-XML) ─────────────────────────────────────
function MappingPanel({ job }) {
  const review = (job.mapping_json && job.mapping_json.needs_review) || [];
  const [selections, setSelections] = useState({});
  const [chart, setChart] = useState([]);
  useEffect(() => {
    ledgerAPI.listAccounts().then((r) => setChart(r.data.data || []));
    // Pre-fill with the auto-suggested ledger.
    const init = {};
    for (const r of review) init[r.tally_ledger_name] = r.suggested_ledger_id;
    setSelections(init);
  }, [job && job.id]);
  const allMapped = review.every((r) => !!selections[r.tally_ledger_name]);
  const onConfirm = async () => {
    const mappings = review.map((r) => ({
      tally_ledger_name: r.tally_ledger_name,
      mapped_ledger_account_id: selections[r.tally_ledger_name],
    }));
    await importsAPI.confirm(job.id, { confirmed: true, mappings });
  };
  const cols = [
    { title: 'Source Ledger', dataIndex: 'tally_ledger_name', width: 280 },
    { title: 'Confidence', dataIndex: 'confidence', width: 130,
      render: (c) => <Tag color={c === 'high' ? 'green' : c === 'medium' ? 'gold' : c === 'low' ? 'orange' : 'red'}>{c}</Tag> },
    { title: 'Map to ledger', key: 'pick',
      render: (_, r) => (
        <Select
          showSearch optionFilterProp="children" style={{ width: '100%' }}
          value={selections[r.tally_ledger_name]}
          onChange={(v) => setSelections((s) => ({ ...s, [r.tally_ledger_name]: v }))}
          options={chart.map((lg) => ({ value: lg.ledger_id, label: lg.ledger_name }))}
        />
      ) },
  ];
  return (
    <Card style={{ marginTop: 16 }}>
      <Title level={5} style={{ margin: 0, marginBottom: 8 }}>Confirm ledger mapping</Title>
      <Text type="secondary">Pick a system ledger for each unmapped source name. We'll remember your choice for next time.</Text>
      <Table size="small" pagination={false} rowKey="tally_ledger_name" columns={cols} dataSource={review} style={{ marginTop: 12 }} />
      <Divider />
      <Button type="primary" disabled={!allMapped} onClick={onConfirm}>Save & continue</Button>
    </Card>
  );
}
