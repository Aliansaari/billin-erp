// ── Stock by Color ─────────────────────────────────────────────────
//
// One row per (multi-color product, color). The operator's purchase-
// decision view: which colors are short, where the value is sitting,
// which are out. Aggregate "80 in stock" hides the fact that 50 of
// those are Red and 0 are Blue — this report surfaces it.
//
// Filters:
//   • Search   — substring on product name OR color name
//   • Category — single category dropdown
//   • Status tabs — All / Out / Low / In stock
//
// Server endpoint: GET /api/reports/stock-by-color
//   ?category_id=...   single id
//   ?search=...        substring (server-side ILIKE)
//   ?low_only=true     only colors at/below their alert threshold
//
// Data model: server returns { data: [...], summary: {...} }.
// Status filtering on client (cheap; the data set fits comfortably).

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Table, Typography, Space, Button, Select, Input, Tag, message, Statistic, Row, Col } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { reportAPI, categoryAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';

const { Title } = Typography;

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtR = (v) => `₹ ${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TABS = [
  { v: 'all', l: 'All' },
  { v: 'out', l: 'Out' },
  { v: 'low', l: 'Low' },
  { v: 'in',  l: 'In stock' },
];

export default function StockByColor() {
  const navigate = useNavigate();
  const [rows, setRows]       = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [categoryId, setCategoryId] = useState(undefined);
  const [tab, setTab]         = useState('all');
  const [categories, setCategories] = useState([]);

  // Categories for the filter — fetched once.
  useEffect(() => {
    categoryAPI.getAll({ limit: 500 })
      .then((r) => setCategories(r.data?.data || r.data || []))
      .catch(() => setCategories([]));
  }, []);

  const refresh = () => {
    setLoading(true);
    reportAPI.stockByColor({
      ...(categoryId ? { category_id: categoryId } : {}),
      ...(search ? { search } : {}),
    })
      .then((r) => {
        setRows(r.data?.data || []);
        setSummary(r.data?.summary || {});
      })
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Stock by Color'))
      .finally(() => setLoading(false));
  };

  // Initial load + when filters change. Search is debounced via the
  // input's onPressEnter / blur — we don't fire on every keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, [categoryId]);

  // Client-side tab filter. Preserves server-side counts in the summary
  // strip so the user always sees the totals across the WHOLE dataset
  // even when looking at one tab.
  const visibleRows = useMemo(() => {
    if (tab === 'all') return rows;
    if (tab === 'out') return rows.filter((r) => r.is_out);
    if (tab === 'low') return rows.filter((r) => r.is_low && !r.is_out);
    if (tab === 'in')  return rows.filter((r) => !r.is_low && !r.is_out);
    return rows;
  }, [rows, tab]);

  const tabCount = (key) => {
    if (key === 'all') return rows.length;
    if (key === 'out') return rows.filter((r) => r.is_out).length;
    if (key === 'low') return rows.filter((r) => r.is_low && !r.is_out).length;
    if (key === 'in')  return rows.filter((r) => !r.is_low && !r.is_out).length;
    return 0;
  };

  const cols = [
    { title: 'Product', dataIndex: 'product_name', key: 'product', width: 220,
      render: (v, r) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>{v}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>
            {r.barcode}
            {r.size_value ? ` · ${r.size_value}` : ''}
            {r.article_number ? ` · ${r.article_number}` : ''}
          </div>
        </div>
      ),
    },
    { title: 'Category', dataIndex: 'category_name', key: 'cat', width: 140,
      render: (v) => v || <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    { title: 'Color', dataIndex: 'color_name', key: 'color', width: 130,
      render: (v) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    { title: 'Stock', dataIndex: 'current_stock', key: 'stock', width: 100, align: 'right',
      render: (v, r) => (
        <span style={{
          fontFamily: 'Geist Mono, monospace', fontWeight: 600,
          color: r.is_out ? 'var(--danger)' : (r.is_low ? '#f59e0b' : 'var(--fg-primary)'),
        }}>{fmtN(v)}</span>
      ),
    },
    { title: 'Alert at', dataIndex: 'low_stock_alert', key: 'alert', width: 90, align: 'right',
      render: (v) => v > 0 ? (
        <span style={{ color: 'var(--fg-tertiary)', fontFamily: 'Geist Mono, monospace' }}>{fmtN(v)}</span>
      ) : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    { title: 'Rate', dataIndex: 'purchase_rate', key: 'rate', width: 110, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', color: 'var(--fg-secondary)' }}>{fmtR(v)}</span>,
    },
    { title: 'Value', dataIndex: 'stock_value', key: 'value', width: 130, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>{fmtR(v)}</span>,
    },
    { title: 'Status', key: 'status', width: 90, align: 'center',
      render: (_, r) => r.is_out
        ? <Tag color="red">Out</Tag>
        : r.is_low ? <Tag color="orange">Low</Tag>
        : <Tag color="green">OK</Tag>,
    },
  ];

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>Stock by Color</Title>
          <Space wrap>
            <Input
              placeholder="Search product or color"
              prefix={<SearchOutlined />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onPressEnter={refresh}
              onBlur={refresh}
              allowClear
              style={{ width: 240 }}
            />
            <Select
              placeholder="All categories"
              value={categoryId}
              onChange={setCategoryId}
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 200 }}
              options={categories.map((c) => ({ value: c.category_id, label: c.category_name }))}
            />
            <Button icon={<ReloadOutlined />} onClick={refresh}>Refresh</Button>
          </Space>
        </Space>

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}><Card size="small"><Statistic title="Color rows" value={summary.total_count || 0} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Total qty" value={fmtN(summary.total_qty)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Stock value" value={fmtR(summary.total_value)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Out / Low" value={`${summary.out_count || 0} / ${summary.low_count || 0}`} valueStyle={{ color: 'var(--danger)' }} /></Card></Col>
        </Row>

        <Space style={{ marginBottom: 12 }} wrap>
          {TABS.map((t) => (
            <Button key={t.v} type={tab === t.v ? 'primary' : 'default'} size="small"
              onClick={() => setTab(t.v)}>
              {t.l} <span style={{ opacity: 0.7, marginLeft: 4 }}>({tabCount(t.v)})</span>
            </Button>
          ))}
        </Space>

        <Table size="small"
          pagination={{ pageSize: 100, showSizeChanger: false }}
          columns={cols}
          rowKey={(r) => `${r.product_id}:${r.color_id}`}
          dataSource={visibleRows}
          loading={loading}
          locale={{ emptyText: rows.length === 0 ? 'No multi-color products found. Enable Multi-color stock in Settings, then mark products as multi-color in the Products page.' : 'No rows match the current filter.' }}
        />
      </Card>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/reports') },
          { id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => refresh() },
          { id: 'export', key: 'F10', label: 'Export',
            onAction: () => exportXls(rows, summary) },
        ]}
      />
    </div>
  );
}

async function exportXls(rows, summary) {
  if (!rows.length) {
    message.warning('Nothing to export');
    return;
  }
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stock by Color');
  ws.columns = [
    { header: 'Product',  key: 'product',  width: 32 },
    { header: 'Barcode',  key: 'barcode',  width: 16 },
    { header: 'Size',     key: 'size',     width: 10 },
    { header: 'Article',  key: 'article',  width: 14 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Color',    key: 'color',    width: 14 },
    { header: 'Stock',    key: 'stock',    width: 10 },
    { header: 'Alert at', key: 'alert',    width: 10 },
    { header: 'Rate',     key: 'rate',     width: 12 },
    { header: 'Value',    key: 'value',    width: 14 },
    { header: 'Status',   key: 'status',   width: 10 },
  ];
  for (const r of rows) {
    ws.addRow({
      product: r.product_name,
      barcode: r.barcode,
      size: r.size_value,
      article: r.article_number,
      category: r.category_name,
      color: r.color_name,
      stock: r.current_stock,
      alert: r.low_stock_alert || '',
      rate: r.purchase_rate,
      value: r.stock_value,
      status: r.is_out ? 'Out' : (r.is_low ? 'Low' : 'OK'),
    });
  }
  ws.addRow({});
  ws.addRow({
    product: 'TOTAL',
    stock: summary.total_qty,
    value: summary.total_value,
  });
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `stock-by-color-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
