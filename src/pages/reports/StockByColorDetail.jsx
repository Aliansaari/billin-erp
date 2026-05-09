// ── Stock by Color — per-product drill-in ─────────────────────────────
//
// Lands here from the master Stock by Color list. Renders the product's
// header info (name, size, article, category) + per-color table. Same
// rpt-* shell as the master page so the two pages feel like halves of
// one report.

import React, { useEffect, useState, useMemo } from 'react';
import { Table, Button, message } from 'antd';
import {
  ArrowLeftOutlined, ReloadOutlined, EditOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { productAPI, productColorAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';

const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtR = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

  const rate = parseFloat(product?.display_cost ?? product?.purchase_rate ?? 0);

  const enriched = useMemo(() => colors.map((c) => {
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
  }), [colors, rate]);

  const totals = useMemo(() => enriched.reduce((acc, r) => {
    acc.qty   += parseFloat(r.current_stock || 0);
    acc.value += r.stock_value;
    if (r.is_out) acc.out += 1;
    if (r.is_low) acc.low += 1;
    return acc;
  }, { qty: 0, value: 0, out: 0, low: 0 }), [enriched]);

  const cols = [
    { title: '#', key: 'sr', width: 56, align: 'center',
      render: (_, __, idx) => (
        <span style={{ fontSize: 11, color: 'var(--fg-tertiary)', fontWeight: 600 }}>{idx + 1}</span>
      ),
    },
    { title: 'Color', dataIndex: 'color_name', key: 'name', width: 200,
      render: (v) => (
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-primary)' }}>{v}</span>
      ),
    },
    { title: 'Stock', dataIndex: 'current_stock', key: 'stock', width: 130, align: 'right',
      render: (v, r) => {
        const color = r.is_out ? 'var(--danger)' : (r.is_low ? 'var(--warning)' : 'var(--success)');
        return (
          <span style={{
            fontVariantNumeric: 'tabular-nums', fontWeight: 700,
            color,
          }}>{fmtN(v)}</span>
        );
      },
    },
    { title: 'Alert at', dataIndex: 'low_stock_alert', key: 'alert', width: 110, align: 'right',
      render: (v) => parseFloat(v) > 0
        ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-tertiary)' }}>{fmtN(v)}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    { title: 'Opening', dataIndex: 'opening_stock', key: 'open', width: 110, align: 'right',
      render: (v) => parseFloat(v) > 0
        ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-secondary)' }}>{fmtN(v)}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>0</span>,
    },
    { title: 'Pur. Rate', key: 'rate', width: 130, align: 'right',
      render: () => (
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-secondary)' }}>
          <span style={{ color: 'var(--fg-tertiary)', marginRight: 1 }}>₹</span>{fmtN(rate)}
        </span>
      ),
    },
    { title: 'Stock Value', dataIndex: 'stock_value', key: 'val', width: 140, align: 'right',
      render: (v) => (
        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
          <span style={{ color: 'var(--fg-tertiary)', marginRight: 1, fontWeight: 500 }}>₹</span>{fmtN(v)}
        </span>
      ),
    },
    { title: 'Status', key: 'status', width: 110, align: 'center',
      render: (_, r) => {
        if (r.is_out) {
          return <span style={{ padding:'3px 10px', borderRadius:4, background:'rgba(220,38,38,.12)', color:'var(--danger)', fontSize:11, fontWeight:700 }}>Out</span>;
        }
        if (r.is_low) {
          return <span style={{ padding:'3px 10px', borderRadius:4, background:'rgba(217,119,6,.14)', color:'var(--warning)', fontSize:11, fontWeight:700 }}>Low</span>;
        }
        return <span style={{ padding:'3px 10px', borderRadius:4, background:'rgba(5,150,105,.12)', color:'var(--success)', fontSize:11, fontWeight:700 }}>OK</span>;
      },
    },
  ];

  const rowClassName = (r) => {
    if (!r) return '';
    if (r.is_out) return 'sbc-row-out';
    if (r.is_low) return 'sbc-row-low';
    return '';
  };

  return (
    <div className="sbc-page">

      {/* ── Title strip — same rpt-* shell ─────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button
              className="rpt-btn"
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/reports/stock-by-color')}
              size="small"
            >
              Back
            </Button>
            <span>{product?.product_name || (loading ? 'Loading…' : 'Product')}</span>
          </h1>
          {product && (
            <div className="rpt-sub">
              {product.barcode && <><b>{product.barcode}</b><span className="sep">·</span></>}
              {product.size_value && <>Size <b>{product.size_value}</b><span className="sep">·</span></>}
              {product.article_number && <>Art# <b>{product.article_number}</b><span className="sep">·</span></>}
              {product.Category?.category_name && <span>{product.Category.category_name}</span>}
              {product.color_mode !== 'multi' && (
                <>
                  <span className="sep">·</span>
                  <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Not multi-color</span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="rpt-hd-ctrl">
          <Button className="rpt-btn" icon={<ReloadOutlined />} onClick={refresh}>
            Refresh
          </Button>
          <Button
            className="rpt-btn"
            icon={<EditOutlined />}
            onClick={() => navigate(`/inventory/products?edit=${productId}`)}
          >
            Edit Product
          </Button>
        </div>
      </header>

      {/* ── KPI strip ──────────────────────────────────────── */}
      <div className="rpt-kpis">
        <div className="rpt-kpi tone-info">
          <div className="rpt-kpi-k">Colors</div>
          <div className="rpt-kpi-v">{enriched.length}</div>
          <div className="rpt-kpi-sub">active rows</div>
        </div>
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Total Qty</div>
          <div className="rpt-kpi-v">{fmtN(totals.qty)}</div>
          <div className="rpt-kpi-sub">across all colors</div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Stock Value</div>
          <div className="rpt-kpi-v">{fmtR(totals.value)}</div>
          <div className="rpt-kpi-sub">at {fmtR(rate)}/unit</div>
        </div>
        <div className={`rpt-kpi ${(totals.out + totals.low) > 0 ? 'tone-danger' : 'tone-neutral'}`}>
          <div className="rpt-kpi-k">Short</div>
          <div className="rpt-kpi-v">{totals.out + totals.low}</div>
          <div className="rpt-kpi-sub">{totals.out} out · {totals.low} low</div>
        </div>
      </div>

      {/* ── Table band ─────────────────────────────────────────
       *   Two stacked Antd Tables (mirror of how VirtualReportTable
       *   does it on the master page): the data Table fills the top
       *   of the wrap with flex:1, and a SEPARATE summary Table
       *   (showHeader=false, dataSource=[], summary returns the row)
       *   sits at the bottom with flex-shrink:0. Same `cols` array
       *   feeds both so column widths align cell-for-cell.
       *
       *   This is the ONLY way to keep the totals row pinned at the
       *   wrap's bottom regardless of how short the data list is —
       *   Antd's inline summary on a single Table sits right after
       *   the data rows, leaving empty space below for short lists. */}
      <div className="sbc-tbl-wrap" tabIndex={0}>
        <div className="sbc-tbl-data">
          <Table
            size="small"
            columns={cols}
            dataSource={enriched}
            rowKey="color_id"
            loading={loading}
            rowClassName={rowClassName}
            pagination={false}
            scroll={{ y: '100%' }}
            locale={{
              emptyText: loading
                ? 'Loading colors…'
                : product?.color_mode === 'multi'
                  ? 'No active colors yet — add some in Inventory → Edit product.'
                  : 'This product is not multi-color tracked.',
            }}
          />
        </div>
        {!loading && enriched.length > 0 && (
          <div className="sbc-tbl-summary">
            <Table
              size="small"
              showHeader={false}
              columns={cols}
              dataSource={[]}
              pagination={false}
              rowKey={() => 'summary'}
              summary={() => (
                <Table.Summary.Row className="sbc-summary-row">
                  <Table.Summary.Cell index={0} colSpan={2}>
                    <span className="sbc-summary-label">Total · {enriched.length} {enriched.length === 1 ? 'color' : 'colors'}</span>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">
                    <span className="sbc-summary-num sbc-summary-num--ok">{fmtN(totals.qty)}</span>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} />
                  <Table.Summary.Cell index={4} />
                  <Table.Summary.Cell index={5} />
                  <Table.Summary.Cell index={6} align="right">
                    <span className="sbc-summary-num">
                      <span className="sbc-summary-rs">₹</span>{fmtN(totals.value)}
                    </span>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={7} />
                </Table.Summary.Row>
              )}
            />
          </div>
        )}
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: () => navigate('/reports/stock-by-color') },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: refresh },
          { id: 'edit', key: 'F2', label: 'Edit Product',
            onAction: () => navigate(`/inventory/products?edit=${productId}`) },
        ]}
      />

      <style>{`
        .sbc-page {
          height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--bg-app);
          overflow: hidden;
          font-variant-numeric: tabular-nums;
        }
        .sbc-page .rpt-page-hd { flex-shrink: 0; }
        .sbc-page .rpt-kpis { flex-shrink: 0; padding-bottom: 14px; }

        .sbc-tbl-wrap {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          padding: 0 24px 24px;
          display: flex;
          flex-direction: column;
          outline: none;
        }
        /* Data table fills the available height; its scroll body
         * sees scroll.y='100%' against this real height. */
        .sbc-tbl-data {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .sbc-tbl-data .ant-table-wrapper,
        .sbc-tbl-data .ant-spin-nested-loading,
        .sbc-tbl-data .ant-spin-container,
        .sbc-tbl-data .ant-table {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .sbc-tbl-data .ant-table-container { flex: 1; min-height: 0; }

        /* Separate summary table at the bottom — flex-shrink:0 so it
         * always sits at the wrap's bottom edge regardless of how
         * many data rows there are. Hides Antd's empty-data
         * placeholder + sets a tight height. */
        .sbc-tbl-summary {
          flex-shrink: 0;
          margin-top: 0;
        }
        .sbc-tbl-summary .ant-table-placeholder { display: none !important; }
        .sbc-tbl-summary .ant-table-tbody { display: none !important; }

        /* Summary row visual — match the master page's VirtualReport-
         * Table summary band. Top hairline + muted background + bold
         * cells mark it as a totals row, not another data row. */
        .sbc-tbl-summary .ant-table-summary > tr.sbc-summary-row > td,
        .sbc-tbl-data .ant-table-summary > tr.sbc-summary-row > td {
          background: var(--bg-muted);
          border-top: 2px solid var(--border);
          padding: 12px 16px;
        }
        .sbc-summary-label {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--fg-secondary);
        }
        .sbc-summary-num {
          font-size: 14px;
          font-weight: 700;
          color: var(--fg-primary);
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.01em;
        }
        .sbc-summary-num--ok { color: var(--success); }
        .sbc-summary-rs {
          color: var(--fg-tertiary);
          font-weight: 500;
          margin-right: 1px;
        }

        .sbc-tbl-wrap .ant-table-tbody > tr.sbc-row-out > td {
          background: rgba(220, 38, 38, 0.04);
        }
        .sbc-tbl-wrap .ant-table-tbody > tr.sbc-row-low > td {
          background: rgba(217, 119, 6, 0.04);
        }
      `}</style>
    </div>
  );
}
