// ── Godown-wise Stock Valuation ─────────────────────────────────────────
//
// Per-godown stock value snapshot — what's at MAIN, what's at PIMP,
// drill-into-godown for the per-product breakdown. Reads from
// product_godown_stock × products.purchase_rate.
//
// Default: per-godown summary (cheap, fits the dashboard tile shape).
// Click into a godown row → fetch ?detail=true and render the per-
// product breakdown for that godown.
//
// Server contract (operationalReportsController.godownValuation):
//   summary: [{ godown_id, code, name, is_default, products, total_qty, total_value }, ...]
//   detail:  [{ godown_id, product_id, product_name, ..., current_stock, purchase_rate, value }, ...]
//   totals:  { godowns, total_qty, total_value }

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Table, Typography, Space, Button, message, Statistic, Row, Col, Tag, Input } from 'antd';
import { PrinterOutlined, ReloadOutlined, BankOutlined, StarFilled, SearchOutlined } from '@ant-design/icons';
import { reportAPI } from '../../api';

const { Title } = Typography;
const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function GodownValuation() {
  const [data, setData]    = useState(null);
  const [loading, setLd]   = useState(true);
  const [activeGodown, setActiveGodown] = useState(null);  // godown_id selected for drill-in
  const [search, setSearch] = useState('');

  const load = () => {
    setLd(true);
    reportAPI.godownValuation({ detail: 'true' })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Godown Valuation'))
      .finally(() => setLd(false));
  };
  useEffect(load, []);

  const summary = data?.summary || [];
  const totals  = data?.totals  || {};
  const detailAll = data?.detail || [];

  // Drill-in dataset for the active godown.
  const detailRows = useMemo(() => {
    if (!activeGodown) return [];
    let rows = detailAll.filter((d) => d.godown_id === activeGodown);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        (r.product_name || '').toLowerCase().includes(q) ||
        (r.barcode || '').toLowerCase().includes(q) ||
        (r.category_name || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }, [detailAll, activeGodown, search]);

  const summaryCols = [
    {
      title: 'Code', dataIndex: 'code', width: 120,
      render: (v, r) => (
        <Space size={6}>
          <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>{v}</span>
          {r.is_default && <StarFilled style={{ color: 'var(--warning, #f59e0b)' }} />}
        </Space>
      ),
    },
    { title: 'Godown', dataIndex: 'name' },
    {
      title: 'Products',
      dataIndex: 'products',
      width: 120,
      align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</span>,
    },
    {
      title: 'Total Qty',
      dataIndex: 'total_qty',
      width: 130,
      align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmtN(v)}</span>,
    },
    {
      title: 'Stock Value',
      dataIndex: 'total_value',
      width: 160,
      align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>₹ {fmtN(v)}</span>,
    },
    {
      title: '% of Total',
      width: 110,
      align: 'right',
      render: (_, r) => {
        const pct = totals.total_value ? (parseFloat(r.total_value) / totals.total_value * 100) : 0;
        return <span style={{ fontFamily: 'Geist Mono, monospace', color: 'var(--fg-secondary)' }}>{pct.toFixed(1)}%</span>;
      },
    },
    {
      title: '',
      width: 110,
      align: 'right',
      render: (_, r) => (
        <Button size="small" type="link" onClick={() => setActiveGodown(r.godown_id)}>
          View items →
        </Button>
      ),
    },
  ];

  const detailCols = [
    {
      title: 'Product', dataIndex: 'product_name',
      render: (v, r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{v || '—'}</div>
          <div style={{ color: 'var(--fg-tertiary)', fontSize: 11, fontFamily: 'Geist Mono, monospace' }}>
            {r.barcode || '—'}
          </div>
        </div>
      ),
    },
    { title: 'Category', dataIndex: 'category_name', width: 160, render: (v) => v || '—' },
    { title: 'Unit', dataIndex: 'unit_of_measurement', width: 70, render: (v) => v || 'PCS' },
    {
      title: 'Stock',
      dataIndex: 'current_stock',
      width: 110,
      align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>{fmtN(v)}</span>,
    },
    {
      title: 'Rate',
      dataIndex: 'purchase_rate',
      width: 110,
      align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtN(v)}</span>,
    },
    {
      title: 'Value',
      dataIndex: 'value',
      width: 130,
      align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>₹ {fmtN(v)}</span>,
    },
  ];

  const activeGodownRow = summary.find((g) => g.godown_id === activeGodown);
  const detailTotal = detailRows.reduce((s, r) => s + (parseFloat(r.value) || 0), 0);

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>
            <BankOutlined style={{ marginRight: 8 }} /> Godown-wise Stock Valuation
          </Title>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
          </Space>
        </Space>

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={8}><Card size="small"><Statistic title="Active Godowns" value={totals.godowns || 0} /></Card></Col>
          <Col span={8}><Card size="small"><Statistic title="Total Qty in Stock"
            value={fmtN(totals.total_qty)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={8}><Card size="small"><Statistic title="Total Stock Value" prefix="₹"
            value={fmtN(totals.total_value)} valueStyle={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }} /></Card></Col>
        </Row>

        <Table
          rowKey="godown_id"
          loading={loading}
          dataSource={summary}
          columns={summaryCols}
          pagination={false}
          size="middle"
          rowClassName={(r) => r.godown_id === activeGodown ? 'ant-table-row-selected' : ''}
        />

        {activeGodown && (
          <Card
            size="small"
            style={{ marginTop: 16 }}
            title={
              <Space>
                <span>Items at <Tag color="blue" style={{ fontFamily: 'Geist Mono, monospace' }}>{activeGodownRow?.code}</Tag> {activeGodownRow?.name}</span>
                <Input prefix={<SearchOutlined />} placeholder="Filter by name / barcode / category"
                  value={search} onChange={(e) => setSearch(e.target.value)} allowClear style={{ width: 280 }} />
              </Space>
            }
            extra={<Button size="small" onClick={() => setActiveGodown(null)}>Close</Button>}
          >
            <Table
              rowKey="product_id"
              dataSource={detailRows}
              columns={detailCols}
              pagination={{ pageSize: 50, showSizeChanger: false }}
              size="small"
              summary={() => detailRows.length === 0 ? null : (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={5}><b>Total ({detailRows.length} items)</b></Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right"><b>₹ {fmtN(detailTotal)}</b></Table.Summary.Cell>
                </Table.Summary.Row>
              )}
            />
          </Card>
        )}
      </Card>
    </div>
  );
}
