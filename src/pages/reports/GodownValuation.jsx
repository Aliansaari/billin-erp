// ── Godown-wise Stock Valuation ─────────────────────────────────────────
//
// Per-godown stock value snapshot — what's at MAIN, what's at PIMP,
// total qty / total value at each location. Reads from
// product_godown_stock × products.purchase_rate.
//
// Drill destination: clicking a godown row (or the "View items"
// button on it) navigates to the Stock Report scoped to that godown
// via /stock-report?godown_id=X. Stock Report reads godown_id from
// the URL on mount and pre-applies the filter, so the user lands on
// a per-product list of everything at that location with all the
// usual stock-report filters (category, period, etc.) ready to go.
//
// UI contract: shares the .rpt-* chrome with every other report
// (Cash Flow, Fund Flow, Bills Outstanding, Fast & Slow Stock) so
// the header / KPI strip / button styling stays consistent.
//
// Server contract (operationalReportsController.godownValuation):
//   summary: [{ godown_id, code, name, is_default, products,
//               total_qty, total_value }, ...]
//   totals:  { godowns, total_qty, total_value }

import React, { useEffect, useState } from 'react';
import { Table, Button, message } from 'antd';
import { PrinterOutlined, ReloadOutlined, StarFilled } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { reportAPI } from '../../api';
import './godown-valuation.css';

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

export default function GodownValuation() {
  const navigate = useNavigate();
  const [data, setData]  = useState(null);
  const [loading, setLd] = useState(true);

  const load = () => {
    setLd(true);
    // No `detail: true` param — we don't render the per-product
    // breakdown inline anymore; clicking a godown row navigates to
    // the full Stock Report instead.
    reportAPI.godownValuation()
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Godown Valuation'))
      .finally(() => setLd(false));
  };
  useEffect(load, []);

  const summary = data?.summary || [];
  const totals  = data?.totals  || {};

  // Drill-in destination: full Stock Report scoped to the selected
  // godown. We also pre-apply stock_status=ok so the user only sees
  // products that ACTUALLY have stock at this location — without
  // it the report shows every product with a 0 row from the LEFT JOIN
  // to product_godown_stock, which is misleading. The "All" /
  // "In Stock" / "Low" chips on Stock Report still work as expected;
  // user can click "All" to widen back. URL is bookmarkable.
  const drillToStockReport = (godownId) => {
    navigate(`/stock-report?godown_id=${godownId}&stock_status=ok`);
  };

  const summaryCols = [
    {
      title: 'Code', dataIndex: 'code', width: 120,
      render: (v, r) => (
        <span className="gv-code">
          <span className="gv-code-text">{v}</span>
          {r.is_default && <StarFilled style={{ color: 'var(--warning)' }} />}
        </span>
      ),
    },
    { title: 'Godown', dataIndex: 'name', render: (v) => <span className="gv-name">{v}</span> },
    {
      title: 'Products', dataIndex: 'products', width: 120, align: 'right',
      render: (v) => <span className="gv-num">{v}</span>,
    },
    {
      title: 'Total Qty', dataIndex: 'total_qty', width: 130, align: 'right',
      render: (v) => <span className="gv-num">{fmtN(v)}</span>,
    },
    {
      title: 'Stock Value', dataIndex: 'total_value', width: 170, align: 'right',
      render: (v) => <span className="gv-num gv-num-bold">₹ {fmtN(v)}</span>,
    },
    {
      title: '% of Total', width: 110, align: 'right',
      render: (_, r) => {
        const pct = totals.total_value ? (parseFloat(r.total_value) / totals.total_value * 100) : 0;
        return <span className="gv-num gv-num-muted">{pct.toFixed(1)}%</span>;
      },
    },
    {
      title: '', width: 130, align: 'right',
      render: (_, r) => (
        <button
          className="gv-drill-btn"
          onClick={(e) => { e.stopPropagation(); drillToStockReport(r.godown_id); }}
        >
          View items →
        </button>
      ),
    },
  ];

  return (
    <div className="gv-page">

      {/* ─── Title strip ────────────────────────────────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Godown-wise Stock Valuation</h1>
        </div>
        <div className="rpt-hd-ctrl">
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            Refresh
          </Button>
          <Button className="rpt-btn" type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </header>

      {/* ─── KPI strip ───────────────────────────────────────────────── */}
      <section className="rpt-kpis">
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Active Godowns</div>
          <div className="rpt-kpi-v">{totals.godowns || 0}</div>
          <div className="gv-kpi-sub">Locations holding stock</div>
        </div>
        <div className="rpt-kpi tone-info">
          <div className="rpt-kpi-k">Total Qty in Stock</div>
          <div className="rpt-kpi-v">{fmtN(totals.total_qty)}</div>
          <div className="gv-kpi-sub">Across all godowns</div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Total Stock Value</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.total_value)}</div>
          <div className="gv-kpi-sub">Σ qty × purchase rate</div>
        </div>
      </section>

      {/* ─── Body ─────────────────────────────────────────────────── */}
      <div className="gv-body">
        <div className="gv-section">
          <div className="gv-section-hd">
            <span className="gv-section-ttl">Per-godown summary</span>
            <span className="gv-section-meta">Click a row to view items at that location</span>
          </div>
          <Table
            rowKey="godown_id"
            loading={loading}
            dataSource={summary}
            columns={summaryCols}
            pagination={false}
            size="middle"
            onRow={(r) => ({
              onClick: () => drillToStockReport(r.godown_id),
              style: { cursor: 'pointer' },
            })}
          />
        </div>
      </div>
    </div>
  );
}
