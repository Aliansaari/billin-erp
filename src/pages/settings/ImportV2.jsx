// ── Import flow (Phase 6) ───────────────────────────────────────────────
//
// One page for both Tally and Excel imports, driven by the new queue.
//   1. Pick source / template
//   2. Upload file → POST /api/imports
//   3. Poll GET /api/imports/:id every 2s
//   4. Mapping screen (Tally only) when status='awaiting_confirmation' AND
//      mapping_json is populated
//   5. Preview screen when status='awaiting_confirmation' AND preview_json
//      is populated
//   6. Result modal when status='done'
//   7. Failure modal when status='failed'
//
// Match the existing design system — Geist Mono on numerics.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Button, Select, Upload, Space, Typography, Progress, Tag, Table, Modal, Alert, Divider, message, Steps } from 'antd';
import { UploadOutlined, ReloadOutlined, StopOutlined, DownloadOutlined } from '@ant-design/icons';
import { importsAPI, ledgerAPI } from '../../api';

const { Title, Text } = Typography;

const SOURCES = [
  { value: 'tally',             label: 'Tally Prime XML' },
  { value: 'excel_customers',   label: 'Excel · Customers' },
  { value: 'excel_suppliers',   label: 'Excel · Suppliers' },
  { value: 'excel_products',    label: 'Excel · Products' },
  { value: 'excel_sales',       label: 'Excel · Sales Bills' },
  { value: 'excel_purchases',   label: 'Excel · Purchase Bills' },
  { value: 'excel_payments',    label: 'Excel · Payments / Receipts' },
];

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_STEP = {
  queued: 0, parsing: 1, validating: 2,
  awaiting_confirmation: 3, committing: 4,
  done: 5, failed: 5, cancelled: 5,
};

export default function ImportV2() {
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

  return (
    <div>
      {/* Source picker + upload */}
      {!job && (
        <Card>
          <Title level={4} style={{ margin: 0, marginBottom: 16 }}>Import Data</Title>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Text strong>Source</Text>
              <Select value={source} onChange={setSource} style={{ width: '100%', marginTop: 8 }}
                options={SOURCES} />
            </div>
            <div>
              <Text strong>File</Text>
              <Upload
                beforeUpload={(f) => { setFile(f); return false; }}
                fileList={file ? [file] : []}
                onRemove={() => setFile(null)}
                maxCount={1}
              >
                <Button icon={<UploadOutlined />}>Select File</Button>
              </Upload>
              {source === 'tally'
                ? <Text type="secondary" style={{ fontSize: 12 }}>Tally Prime XML export (.xml)</Text>
                : <Text type="secondary" style={{ fontSize: 12 }}>Excel workbook (.xlsx)</Text>}
            </div>
            <Button type="primary" onClick={handleStart} disabled={!file}>Start Import</Button>
          </Space>
        </Card>
      )}

      {/* Active job */}
      {job && (
        <>
          <Card>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Title level={4} style={{ margin: 0 }}>
                Import #{job.id} · <Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 14 }}>{job.source}</Text>
              </Title>
              <Space>
                {!['done', 'failed', 'cancelled'].includes(job.status) && (
                  <Button danger icon={<StopOutlined />} onClick={handleCancel}>Cancel</Button>
                )}
                <Button icon={<ReloadOutlined />} onClick={reset}>New Import</Button>
              </Space>
            </Space>
            <Divider style={{ margin: '16px 0' }} />
            <Steps current={STATUS_STEP[job.status] || 0} size="small" style={{ marginBottom: 16 }}
              status={job.status === 'failed' ? 'error' : job.status === 'cancelled' ? 'error' : 'process'}
              items={[
                { title: 'Queued' }, { title: 'Parsing' }, { title: 'Validating' },
                { title: 'Confirm' }, { title: 'Committing' },
                { title: job.status === 'failed' ? 'Failed' : job.status === 'cancelled' ? 'Cancelled' : 'Done' },
              ]}
            />
            <Progress percent={job.progress_pct || 0} status={job.status === 'failed' || job.status === 'cancelled' ? 'exception' : (job.status === 'done' ? 'success' : 'active')} />
            <Text type="secondary">{job.phase_message || ''}</Text>
          </Card>

          {/* Preview screen */}
          {job.status === 'awaiting_confirmation' && job.preview_json && !job.mapping_json?.needs_review?.length && (
            <PreviewPanel job={job} onConfirm={handleConfirmPreview} onCancel={handleCancel} />
          )}

          {/* Mapping screen (Tally) */}
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

// ── Mapping panel (Tally) ──────────────────────────────────────────────
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
    { title: 'Tally Ledger', dataIndex: 'tally_ledger_name', width: 280 },
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
      <Title level={5} style={{ margin: 0, marginBottom: 8 }}>Confirm Tally ledger mapping</Title>
      <Text type="secondary">Pick a system ledger for each unmapped Tally name. We'll remember your choice for next time.</Text>
      <Table size="small" pagination={false} rowKey="tally_ledger_name" columns={cols} dataSource={review} style={{ marginTop: 12 }} />
      <Divider />
      <Button type="primary" disabled={!allMapped} onClick={onConfirm}>Save & continue</Button>
    </Card>
  );
}
