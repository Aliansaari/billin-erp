// ── Stock by Color — per-product drill-in ─────────────────────────────
//
// Lands here from the master Stock by Color list. Renders the product's
// header info (name, size, article, category) plus a table of every
// active color row with stock, alert level, value, and an inline
// status pill. Same sr-* styling as the master so the two pages feel
// like halves of one report.

import React, { useEffect, useState } from 'react';
import { Table, message } from 'antd';
import {
  ArrowLeftOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { productAPI, productColorAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../inventory/stock-report.css';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) =>    parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function StockByColorDetail() {
  const navigate = useNavigate();
  const { productId } = useParams();
  const [product, setProduct] = useState(null);
  const [colors, setColors]   = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    if (!productId) return;
    setLoading(true);
    Promise.all([
      productAPI.getById(productId).catch(() => ({ data: null })),
      productColorAPI.list(productId, { include_inactive: false }),
    ])
      .then(([prodR, colorR]) => {
        setProduct(prodR.data);
        setColors(colorR.data?.data || colorR.data || []);
      })
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load colors'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [productId]);

  // Per-row stock value uses the product's purchase rate (matches the
  // master list — one rate per product, not per color).
  const rate = parseFloat(product?.display_cost ?? product?.purchase_rate ?? 0);
  const enriched = colors.map((c) => {
    const stock = parseFloat(c.current_stock || 0);
    const alert = parseFloat(c.low_stock_alert || 0);
    const isOut = stock <= 0;
    const isLow = !isOut && alert > 0 && stock <= alert;
    return {
      ...c,
      stock_value: stock * rate,
      is_out: isOut,
      is_low: isLow,
    };
  });

  const totals = enriched.reduce((acc, r) => {
    acc.qty   += parseFloat(r.current_stock || 0);
    acc.value += r.stock_value;
    if (r.is_out) acc.out += 1;
    if (r.is_low) acc.low += 1;
    return acc;
  }, { qty: 0, value: 0, out: 0, low: 0 });

  const cols = [
    { title: 'Color', dataIndex: 'color_name', key: 'name', width: 180,
      render: (v) => <span className="sr-prod-name">{v}</span>,
    },
    { title: 'Stock', dataIndex: 'current_stock', key: 'stock', width: 130, align: 'right',
      render: (v, r) => {
        const cls = r.is_out ? 'out' : (r.is_low ? 'low' : 'ok');
        return <span className={`sr-stk ${cls}`}>{fmtN(v)}</span>;
      },
    },
    { title: 'Alert at', dataIndex: 'low_stock_alert', key: 'alert', width: 110, align: 'right',
      render: (v) => parseFloat(v) > 0
        ? <span className="sr-qty muted">{fmtN(v)}</span>
        : <span className="sr-amt muted">—</span>,
    },
    { title: 'Opening', dataIndex: 'opening_stock', key: 'open', width: 110, align: 'right',
      render: (v) => parseFloat(v) > 0
        ? <span className="sr-qty">{fmtN(v)}</span>
        : <span className="sr-qty muted">0</span>,
    },
    { title: 'Pur. Rate', key: 'rate', width: 110, align: 'right',
      render: () => <span className="sr-amt"><span className="rs">₹</span>{fmtN(rate)}</span>,
    },
    { title: 'Stock Value', dataIndex: 'stock_value', key: 'val', width: 140, align: 'right',
      render: (v) => <span className="sr-amt"><span className="rs">₹</span>{fmtN(v)}</span>,
    },
    { title: 'Status', key: 'status', width: 100, align: 'center',
      render: (_, r) => r.is_out
        ? <span className="sbc-tag sbc-tag-out">Out</span>
        : r.is_low
          ? <span className="sbc-tag sbc-tag-low">Low</span>
          : <span className="sbc-tag sbc-tag-ok">OK</span>,
    },
  ];

  const rowClassName = (r) => {
    if (!r) return '';
    if (r.is_out) return 'sr-row-out';
    return '';
  };

  return (
    <div className="sr-page">
      {/* ── HEADER ─────────────────────────────────────────────── */}
      <div className="sr-hd">
        <div className="sr-title">
          <button
            className="sr-btn"
            onClick={() => navigate('/reports/stock-by-color')}
            style={{ marginRight: 12 }}
          >
            <ArrowLeftOutlined /> Back
          </button>
          <h1 style={{ display: 'inline-block' }}>
            {product?.product_name || (loading ? 'Loading…' : 'Product')}
          </h1>
        </div>
        <div className="sr-ctrls">
          <button className="sr-btn" onClick={refresh} title="Refresh">
            <ReloadOutlined /> Refresh
          </button>
        </div>
      </div>

      {/* Product meta strip — barcode / size / article / category in
          a row of small pills so the operator can ID the product at a
          glance even while looking at colors. */}
      {product && (
        <div className="sr-filters" style={{ marginBottom: 12 }}>
          {product.barcode && <span className="sr-bc">{product.barcode}</span>}
          {product.size_value && <span className="sr-size-pill">{product.size_value}</span>}
          {product.article_number && <span className="sr-art">Art#: {product.article_number}</span>}
          {product.Category?.category_name && (
            <span className="sr-cat">{product.Category.category_name}</span>
          )}
          {product.color_mode !== 'multi' && (
            <span className="sbc-tag sbc-tag-out" style={{ marginLeft: 'auto' }}>
              Not multi-color
            </span>
          )}
        </div>
      )}

      {/* ── KPI STRIP ─────────────────────────────────────────── */}
      <div className="sr-kpis">
        <div className="sr-kpi tot">
          <div className="sr-kpi-k">Colors</div>
          <div className="sr-kpi-v">{enriched.length}</div>
          <div className="sr-kpi-sub">active rows</div>
        </div>
        <div className="sr-kpi value-tone">
          <div className="sr-kpi-k">Total Qty</div>
          <div className="sr-kpi-v">{fmtN(totals.qty)}</div>
          <div className="sr-kpi-sub">across all colors</div>
        </div>
        <div className="sr-kpi sale-tone">
          <div className="sr-kpi-k">Stock Value</div>
          <div className="sr-kpi-v">{fmt(totals.value)}</div>
          <div className="sr-kpi-sub">
            at ₹{fmtN(rate)}/unit
          </div>
        </div>
        <div className="sr-kpi out-tone">
          <div className="sr-kpi-k">Short</div>
          <div className="sr-kpi-v">{totals.out + totals.low}</div>
          <div className="sr-kpi-sub">
            {totals.out} out · {totals.low} low
          </div>
        </div>
      </div>

      {/* ── TABLE ─────────────────────────────────────────────── */}
      <div className="sr-tbl-wrap">
        <Table
          size="small"
          columns={cols}
          dataSource={enriched}
          rowKey="color_id"
          loading={loading}
          rowClassName={rowClassName}
          pagination={false}
          locale={{
            emptyText: loading
              ? 'Loading colors…'
              : product?.color_mode === 'multi'
                ? 'No active colors yet — add some in Inventory → Edit product.'
                : 'This product is not multi-color tracked.',
          }}
          summary={(rows) => {
            if (rows.length === 0) return null;
            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}><b>TOTAL</b></Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  <span className="sr-stk ok"><b>{fmtN(totals.qty)}</b></span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} />
                <Table.Summary.Cell index={3} />
                <Table.Summary.Cell index={4} />
                <Table.Summary.Cell index={5} align="right">
                  <span className="sr-amt"><span className="rs">₹</span><b>{fmtN(totals.value)}</b></span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={6} />
              </Table.Summary.Row>
            );
          }}
        />
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/reports/stock-by-color') },
          { id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: refresh },
          { id: 'edit', key: 'F2', label: 'Edit Product',
            onAction: () => navigate(`/inventory/products?edit=${productId}`) },
        ]}
      />

      <style>{`
        .sbc-tag {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .sbc-tag-out { background: rgba(220, 38, 38, 0.12); color: var(--danger); }
        .sbc-tag-low { background: rgba(217, 119, 6, 0.14); color: var(--warning); }
        .sbc-tag-ok  { background: rgba(5, 150, 105, 0.12); color: var(--success); }
      `}</style>
    </div>
  );
}
