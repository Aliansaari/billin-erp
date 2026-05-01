// Ledger Integrity admin screen.
//
// Sections:
//   • Totals tie-out: Σ debits, Σ credits, difference (must be 0).
//   • Per-source-type breakdown: total vs posted vs unposted.
//   • Drill-in: list of unposted source rows for manual investigation.
//   • Auto-Receipt Integrity: I1-I6 invariants (R8 phase 2). Surfaces
//     drift in the bill ↔ allocation ↔ ledger triangle so an admin can
//     spot it without curling the endpoint.

import React, { useEffect, useState, useMemo } from 'react';
import { Card, Button, Space, Typography, Table, Tag, message, Alert, Row, Col, Statistic, Collapse, Modal } from 'antd';
import { ReloadOutlined, ThunderboltOutlined, EyeOutlined, SyncOutlined, CheckCircleFilled, WarningFilled, CloseCircleFilled } from '@ant-design/icons';
import { ledgerAPI } from '../../api';

const { Title, Text } = Typography;
const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LABEL = {
  sales_bill: 'Sales Bills',
  purchase_bill: 'Purchase Bills',
  sales_return_bill: 'Sales Returns',
  purchase_return_bill: 'Purchase Returns',
  payment_receipt: 'Payments / Receipts',
  journal_voucher: 'Journal Vouchers',
  party_opening: 'Opening Balances',
};

// Auto-receipt invariant row formatter — one row per invariant card,
// matching the existing per-source-type Table row visual weight.
const I_LABEL_HINT = {
  'I1.sales':    'Per Sales bill — what we say is paid should match what is allocated.',
  'I1.purchase': 'Per Purchase bill — same equality on the supplier side.',
  'I2':          'Each auto-generated Receipt/Payment should map to exactly one bill at exactly the receipt amount.',
  'I3.sales':    'Auto-generated Receipt must mirror its source bill on party, date, and cancel-status.',
  'I3.purchase': 'Auto-generated Payment must mirror its source purchase bill on party, date, cancel-status.',
  'I4':          'Every auto-generated row must point at a real bill — no orphan source_bill_id values.',
  'I5':          '6-term reconciliation between Sundry Debtors ledger and the bill side.',
  'I6':          '6-term reconciliation between Sundry Creditors ledger and the bill side.',
};

// Sample table columns — different shape per invariant family.
function sampleColumns(invariantId) {
  if (invariantId.startsWith('I1')) return [
    { title: 'Bill #',        dataIndex: 'bill_number', width: 140 },
    { title: 'paid_amount',   dataIndex: 'paid_amount', align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'SUM(allocs)',   dataIndex: 'alloc_sum',   align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'Diff',          align: 'right', width: 130,
      render: (_, r) => <Tag color="red">{fmt((r.paid_amount || 0) - (r.alloc_sum || 0))}</Tag> },
  ];
  if (invariantId === 'I2') return [
    { title: 'Receipt #',     dataIndex: 'transaction_number', width: 160 },
    { title: 'Type',          dataIndex: 'transaction_type', width: 90 },
    { title: 'total_amount',  dataIndex: 'total_amount', align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'SUM(allocs)',   dataIndex: 'alloc_sum',    align: 'right', width: 130, render: (v) => fmt(v) },
    { title: '# allocs',      dataIndex: 'alloc_count',  align: 'right', width: 90 },
  ];
  if (invariantId.startsWith('I3')) return [
    { title: 'Receipt #', dataIndex: 'transaction_number', width: 160 },
    { title: 'Receipt party', dataIndex: 'r_party',  align: 'right', width: 110 },
    { title: 'Bill party',    dataIndex: 'b_party',  align: 'right', width: 110 },
    { title: 'Receipt date',  dataIndex: 'r_date',   width: 120 },
    { title: 'Bill date',     dataIndex: 'b_date',   width: 120 },
    { title: 'R cancelled',   dataIndex: 'r_cancelled', width: 100, render: (v) => String(v) },
    { title: 'B cancelled',   dataIndex: 'b_cancelled', width: 100, render: (v) => String(v) },
  ];
  if (invariantId === 'I4') return [
    { title: 'Receipt #',      dataIndex: 'transaction_number', width: 160 },
    { title: 'Type',           dataIndex: 'transaction_type', width: 90 },
    { title: 'source_bill_id', dataIndex: 'source_bill_id', align: 'right', width: 130 },
  ];
  // I5 / I6 don't return a row sample — the breakdown panel shows the
  // 6 terms explicitly instead of a violator list.
  return null;
}

export default function LedgerIntegrity() {
  const [data, setData]         = useState(null);
  const [unposted, setUnposted] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [reconciling, setReconciling] = useState(false);

  // ── Auto-receipt integrity (R8 invariants) ──
  const [autoData, setAutoData]         = useState(null);
  const [autoLoading, setAutoLoading]   = useState(false);
  const [autoLastChecked, setAutoLastChecked] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await ledgerAPI.integrity();
      setData(r.data);
    } catch (e) {
      message.error('Failed to load integrity report.');
    }
    setLoading(false);
  };
  // Section-level refresh — fires only the auto-receipt endpoint, so the
  // top-of-page financial check (which can be slow on large data) isn't
  // re-pulled when the admin only wants this section's truth.
  const loadAutoReceipt = async () => {
    setAutoLoading(true);
    try {
      const r = await ledgerAPI.autoReceiptIntegrity();
      setAutoData(r.data);
      setAutoLastChecked(new Date());
    } catch (e) {
      message.error('Failed to load auto-receipt integrity.');
    }
    setAutoLoading(false);
  };
  useEffect(() => { load(); loadAutoReceipt(); }, []);

  // Run the backfill on the server, then refresh the integrity report so
  // the per-source-type counts reflect the new state. The backend wraps
  // each voucher in its own transaction, so partial success is normal —
  // surface failures in a modal for triage rather than a toast (errors
  // can run into the dozens on legacy imports with bad party links).
  const runReconcile = async () => {
    setReconciling(true);
    try {
      const r = await ledgerAPI.reconcile();
      const summary = r.data?.summary || {};
      const errors  = r.data?.errors  || [];
      const totals = Object.values(summary).reduce(
        (acc, s) => ({
          found:  acc.found  + (s.found  || 0),
          posted: acc.posted + (s.posted || 0),
          failed: acc.failed + (s.failed || 0),
        }),
        { found: 0, posted: 0, failed: 0 },
      );

      if (totals.found === 0) {
        message.success('Books are already reconciled — nothing to post.');
      } else if (totals.failed === 0) {
        message.success(`Reconciled ${totals.posted} voucher${totals.posted === 1 ? '' : 's'}.`);
      } else {
        Modal.warning({
          title: 'Reconciliation finished with errors',
          width: 720,
          content: (
            <div>
              <p style={{ marginTop: 0 }}>
                Posted <b>{totals.posted}</b> of <b>{totals.found}</b> unposted vouchers.{' '}
                <b>{totals.failed}</b> failed (showing first {Math.min(errors.length, 100)}):
              </p>
              <pre style={{
                maxHeight: 320, overflow: 'auto', background: '#fafafa',
                padding: 12, fontSize: 12, fontFamily: 'Geist Mono, monospace',
                border: '1px solid #f0f0f0', borderRadius: 4,
              }}>
                {errors.map((e) => `${e.source_type}#${e.source_id}: ${e.reason}`).join('\n')}
              </pre>
            </div>
          ),
        });
      }
      await load();
    } catch (e) {
      message.error(e.response?.data?.error || 'Reconciliation failed.');
    }
    setReconciling(false);
  };

  const loadUnposted = async () => {
    try {
      const r = await ledgerAPI.unposted();
      setUnposted(r.data.data);
    } catch (e) {
      message.error('Failed to load unposted vouchers.');
    }
  };

  const totals    = data?.totals;
  const lifetime  = totals?.lifetime || totals; // back-compat for old shape
  const active    = totals?.active   || null;
  const breakdown = data?.breakdown || [];

  const cols = [
    { title: 'Source', dataIndex: 'source_type', key: 'source',
      render: (v) => <Text>{LABEL[v] || v}</Text>,
    },
    { title: 'Total Records', dataIndex: 'total', key: 'total', align: 'right', width: 140,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</span>,
    },
    { title: 'Posted to Ledger', dataIndex: 'posted', key: 'posted', align: 'right', width: 140,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</span>,
    },
    { title: 'Unposted', dataIndex: 'unposted', key: 'unposted', align: 'right', width: 140,
      render: (v) => v === 0
        ? <Tag color="green" style={{ fontFamily: 'Geist Mono, monospace' }}>0</Tag>
        : <Tag color="red"   style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</Tag>,
    },
  ];

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>Ledger Integrity</Title>
          <Space>
            <Button
              icon={<SyncOutlined />}
              type="primary"
              loading={reconciling}
              onClick={runReconcile}
              disabled={loading}
            >
              Run Reconciliation
            </Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={load} disabled={reconciling}>
              Refresh
            </Button>
          </Space>
        </Space>

        {lifetime && (
          <>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>Active (current state of the books)</Text>
            {active && (
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title="Active Entries" value={active.rows} />
                    <Text type="secondary" style={{ fontSize: 12 }}>Reversal pairs excluded</Text>
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title="Active Debits" value={fmt(active.debits)} prefix="₹" valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title="Active Credits" value={fmt(active.credits)} prefix="₹" valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small" style={{ borderColor: active.balanced ? '#52c41a' : '#ff4d4f' }}>
                    <Statistic
                      title="Difference (must be 0)"
                      value={fmt(active.difference)}
                      prefix="₹"
                      valueStyle={{
                        color: active.balanced ? '#52c41a' : '#ff4d4f',
                        fontFamily: 'Geist Mono, monospace',
                      }}
                    />
                  </Card>
                </Col>
              </Row>
            )}

            <Text strong style={{ display: 'block', marginBottom: 8 }}>Lifetime (full audit trail)</Text>
            <Row gutter={16} style={{ marginBottom: 24 }}>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="Total Entries" value={lifetime.rows} />
                  <Text type="secondary" style={{ fontSize: 12 }}>Includes reversal entries</Text>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="Lifetime Debits" value={fmt(lifetime.debits)} prefix="₹" valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
                  <Text type="secondary" style={{ fontSize: 12 }}>Includes reversed entries (audit trail)</Text>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="Lifetime Credits" value={fmt(lifetime.credits)} prefix="₹" valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
                  <Text type="secondary" style={{ fontSize: 12 }}>Includes reversed entries (audit trail)</Text>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ borderColor: lifetime.balanced ? '#52c41a' : '#ff4d4f' }}>
                  <Statistic
                    title="Difference (must be 0)"
                    value={fmt(lifetime.difference)}
                    prefix="₹"
                    valueStyle={{
                      color: lifetime.balanced ? '#52c41a' : '#ff4d4f',
                      fontFamily: 'Geist Mono, monospace',
                    }}
                  />
                </Card>
              </Col>
            </Row>
          </>
        )}

        {(active && !active.balanced) && (
          <Alert
            type="error"
            showIcon
            message="Active books are out of balance"
            description={`Active debits and credits differ by ₹${fmt(active.difference)}. Investigate immediately.`}
            style={{ marginBottom: 16 }}
          />
        )}
        {lifetime && !lifetime.balanced && (
          <Alert
            type="error"
            showIcon
            message="Lifetime ledger is out of balance"
            description={`Lifetime debits and credits differ by ₹${fmt(lifetime.difference)}. This is a real integrity issue — reversal pairs should always sum to zero.`}
            style={{ marginBottom: 16 }}
          />
        )}

        <Table
          rowKey="source_type"
          columns={cols}
          dataSource={breakdown}
          pagination={false}
          size="small"
          loading={loading}
        />

        <div style={{ marginTop: 16 }}>
          <Button icon={<EyeOutlined />} onClick={loadUnposted}>View Unposted Vouchers</Button>
        </div>

        {unposted && (
          <Collapse style={{ marginTop: 16 }}>
            {Object.entries(unposted).map(([k, rows]) => (
              <Collapse.Panel
                key={k}
                header={
                  <span>{LABEL[k] || k}{' '}<Tag color={rows.length === 0 ? 'green' : 'orange'}>{rows.length}</Tag></span>
                }
              >
                {rows.length === 0
                  ? <Text type="secondary">All posted.</Text>
                  : <Table
                      size="small"
                      pagination={false}
                      rowKey="id"
                      dataSource={rows}
                      columns={[
                        { title: 'Number', dataIndex: 'number' },
                        { title: 'Date',   dataIndex: 'date' },
                      ]}
                    />}
              </Collapse.Panel>
            ))}
          </Collapse>
        )}

        {/* ── Auto-Receipt Integrity (R8 I1-I6) ────────────────────── */}
        <AutoReceiptSection
          data={autoData}
          loading={autoLoading}
          lastChecked={autoLastChecked}
          onRefresh={loadAutoReceipt}
        />
      </Card>
    </div>
  );
}

// ── AutoReceiptSection ─────────────────────────────────────────────────
//
// Third section on the Ledger Integrity screen. Renders the 8 invariants
// returned by GET /api/ledger/auto-receipt-integrity. Visual treatment
// matches the existing two sections — same Statistic card density, same
// green/red status colouring, same Collapse for sample disclosures.
//
// Collapsed by default when all-clean (single-line summary with the last-
// checked timestamp). Auto-expands when a violation appears, so an admin
// who's looking at a green page never has to click to confirm — and one
// who's looking at a red page can't miss it.
function AutoReceiptSection({ data, loading, lastChecked, onRefresh }) {
  const summary = useMemo(() => {
    if (!data || !Array.isArray(data.invariants)) return null;
    const total = data.invariants.length;
    const failed = data.invariants.filter((i) => !i.ok).length;
    const driftAmount = data.invariants
      .filter((i) => !i.ok && typeof i.difference === 'number')
      .reduce((s, i) => s + Math.abs(i.difference), 0);
    return { total, failed, allPass: !!data.all_pass, driftAmount };
  }, [data]);

  const hh = lastChecked
    ? lastChecked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  // Pill colour: green clean, amber ≤5 failed/drift, red >5 or any I5/I6
  // drift > 1 paisa (genuine ledger desync, not a counting issue).
  const pillColor = (() => {
    if (!summary) return 'default';
    if (summary.allPass) return 'green';
    const hasLargeDrift = (data.invariants || []).some(
      (i) => !i.ok && typeof i.difference === 'number' && Math.abs(i.difference) > 0.01,
    );
    if (hasLargeDrift || summary.failed > 5) return 'red';
    return 'orange';
  })();

  const headerLine = summary?.allPass
    ? <span><CheckCircleFilled style={{ color: '#52c41a', marginRight: 6 }}/>All {summary.total} invariants green — last checked {hh}</span>
    : summary
      ? <span>
          {pillColor === 'red' ? <CloseCircleFilled style={{ color: '#ff4d4f', marginRight: 6 }}/> : <WarningFilled style={{ color: '#faad14', marginRight: 6 }}/>}
          {summary.failed} of {summary.total} invariant{summary.total === 1 ? '' : 's'} violated — review below
        </span>
      : <span>Loading…</span>;

  return (
    <div style={{ marginTop: 24 }}>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
        <Title level={5} style={{ margin: 0 }}>Auto-Receipt Integrity</Title>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
          Refresh this section
        </Button>
      </Space>

      <Collapse defaultActiveKey={summary && !summary.allPass ? ['ari'] : []}>
        <Collapse.Panel
          key="ari"
          header={headerLine}
          extra={summary && !summary.allPass ? <Tag color={pillColor}>{summary.failed} violated</Tag> : <Tag color="green">all green</Tag>}
        >
          {!data && <Text type="secondary">Loading invariants…</Text>}
          {data && (
            <div className="ari-list">
              {data.invariants.map((inv) => (
                <InvariantRow key={inv.id} inv={inv} />
              ))}
            </div>
          )}
        </Collapse.Panel>
      </Collapse>
    </div>
  );
}

// One row per invariant. Status pill on the left, a short hint of what
// the rule means, and (when failed) a "View N samples" disclosure that
// expands a small table of offending rows. I5/I6 don't return a row
// sample but DO expose the 6 named terms — for those we render the
// breakdown panel instead of an empty table.
function InvariantRow({ inv }) {
  const [open, setOpen] = useState(false);
  const cols = sampleColumns(inv.id);
  const isReconciliation = inv.id === 'I5' || inv.id === 'I6';
  const tag = inv.ok
    ? <Tag color="green" style={{ minWidth: 90, textAlign: 'center' }}>✓ Clean</Tag>
    : <Tag color={Math.abs(inv.difference || 0) > 0.01 || (inv.violation_count || 0) > 5 ? 'red' : 'orange'} style={{ minWidth: 90, textAlign: 'center' }}>
        ✗ {isReconciliation ? `Drift ₹${fmt(Math.abs(inv.difference || 0))}` : `${inv.violation_count} violator${inv.violation_count === 1 ? '' : 's'}`}
      </Tag>;

  return (
    <div className="ari-row" style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '8px 0', borderBottom: '1px solid #f0f0f0',
    }}>
      <div style={{ flex: '0 0 110px' }}>{tag}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500 }}>{inv.name}</div>
        <Text type="secondary" style={{ fontSize: 12 }}>{I_LABEL_HINT[inv.id] || ''}</Text>
        {!inv.ok && (
          <div style={{ marginTop: 6 }}>
            <a onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide' : 'View'} {isReconciliation ? 'breakdown' : `${Math.min(inv.sample?.length || 0, 10)} sample${(inv.sample?.length || 0) === 1 ? '' : 's'}`}
            </a>
            {open && isReconciliation && (
              <div style={{
                marginTop: 8, padding: 12, background: '#fafafa',
                fontFamily: 'Geist Mono, monospace', fontSize: 12, lineHeight: 1.7,
                border: '1px solid #f0f0f0', borderRadius: 4,
              }}>
                <div>bill_outstanding:     ₹{fmt(inv.bill_outstanding)}</div>
                <div>+ paid_in_bills:      ₹{fmt(inv.paid_in_bills)}</div>
                <div>− unallocated_receipts: ₹{fmt(inv.unallocated_receipts)}</div>
                <div>− returns_offset:     ₹{fmt(inv.returns_offset)}</div>
                <div>+ opening_dr:         ₹{fmt(inv.opening_dr)}</div>
                <div>− opening_cr:         ₹{fmt(inv.opening_cr)}</div>
                <div>= expected_ledger:    ₹{fmt(inv.expected_ledger)}</div>
                <div>vs ledger_outstanding: ₹{fmt(inv.ledger_outstanding)}</div>
                <div style={{ borderTop: '1px solid #d9d9d9', marginTop: 6, paddingTop: 6, color: '#ff4d4f' }}>
                  <b>diff: ₹{fmt(inv.difference)}</b>
                </div>
              </div>
            )}
            {open && !isReconciliation && cols && (
              <Table
                size="small"
                style={{ marginTop: 8 }}
                pagination={false}
                rowKey={(r, i) => r.bill_id ?? r.transaction_id ?? i}
                dataSource={(inv.sample || []).slice(0, 10)}
                columns={cols}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
