// Ledger Integrity admin screen.
//
// Three sections:
//   • Totals tie-out: Σ debits, Σ credits, difference (must be 0).
//   • Per-source-type breakdown: total vs posted vs unposted.
//   • Drill-in: list of unposted source rows for manual investigation.

import React, { useEffect, useState } from 'react';
import { Card, Button, Space, Typography, Table, Tag, message, Alert, Row, Col, Statistic, Collapse, Modal } from 'antd';
import { ReloadOutlined, ThunderboltOutlined, EyeOutlined, SyncOutlined } from '@ant-design/icons';
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

export default function LedgerIntegrity() {
  const [data, setData]         = useState(null);
  const [unposted, setUnposted] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [reconciling, setReconciling] = useState(false);

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
  useEffect(() => { load(); }, []);

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
      </Card>
    </div>
  );
}
