/*
 * GSTR-1 — statutory outward-supply return (monthly).
 *
 * Three section tabs for the first pass: B2B (4A), B2CS (7), HSN Summary (12).
 * Backend math lives in server/utils/gstr1.js (29 unit-tests passing) and the
 * classifier keeps invoices from being counted in more than one section.
 *
 * Layout mirrors the Aging Report: full-height page, sticky header + KPI
 * strip + section tabs, only the table body scrolls. Same theme vars so
 * classic-light / classic-dark / modern-* all adapt without overrides.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { message, Spin, DatePicker } from 'antd';
import {
  ReloadOutlined, FileExcelOutlined, RightOutlined,
  FileTextOutlined, TeamOutlined, TagsOutlined, StopOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import './gstr1-report.css';

const { RangePicker } = DatePicker;

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
const fmtInt = (v) => Math.round(parseFloat(v || 0)).toLocaleString('en-IN');
const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '—');


export default function GSTR1Report() {
  const [params, setParams] = useSearchParams();

  // Range = [from, to]. URL params ?from=YYYY-MM-DD&to=YYYY-MM-DD make the
  // view bookmarkable. Default: the current calendar month.
  const [range, setRange] = useState(() => {
    const f = params.get('from'), t = params.get('to');
    if (f && /^\d{4}-\d{2}-\d{2}$/.test(f) && t && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return [dayjs(f), dayjs(t)];
    }
    return [dayjs().startOf('month'), dayjs().endOf('month')];
  });
  useEffect(() => {
    const [from, to] = range;
    if (!from || !to) return;
    const f = from.format('YYYY-MM-DD'), t = to.format('YYYY-MM-DD');
    if (params.get('from') !== f || params.get('to') !== t) {
      setParams({ from: f, to: t }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [section, setSection] = useState('b2b');
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range[0]?.valueOf(), range[1]?.valueOf()]);

  const queryParams = () => {
    const [from, to] = range;
    if (!from || !to) return {};
    return { from_date: from.format('YYYY-MM-DD'), to_date: to.format('YYYY-MM-DD') };
  };

  const load = async () => {
    const p = queryParams();
    if (!p.from_date) return;
    setLoading(true);
    try {
      const { data: res } = await reportAPI.getGstr1(p);
      setData(res);
      setExpanded(new Set());
    } catch (e) {
      message.error('Failed to load GSTR-1');
      setData(null);
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const p = queryParams();
      const res = await reportAPI.exportGstr1(p);
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gstr1_${p.from_date}_to_${p.to_date}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  /* Header KPI totals — computed from the 3 section aggregates so the user
   * can see the period-wide tax collected at a glance. B2CL (not yet in
   * scope) will slot into this when it's added. */
  const kpi = useMemo(() => {
    if (!data) return { taxable: 0, igst: 0, cgst: 0, sgst: 0, total: 0, invoices: 0 };
    const b2b  = data.b2b?.grand  || { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    const b2cs = data.b2cs?.grand || { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    const nilT = Number(data.nil?.grand?.taxable) || 0;
    const invoices = data.period_meta?.invoice_count || 0;
    const taxable = b2b.taxable + b2cs.taxable + nilT;
    const igst = b2b.igst + b2cs.igst;
    const cgst = b2b.cgst + b2cs.cgst;
    const sgst = b2b.sgst + b2cs.sgst;
    return { taxable, igst, cgst, sgst, total: taxable + igst + cgst + sgst, invoices };
  }, [data]);

  const toggleExpanded = (key) => {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };

  const b2bRows  = data?.b2b?.rows  || [];
  const b2csRows = data?.b2cs?.rows || [];
  const nilRows  = data?.nil?.rows  || [];
  const nilInvs  = data?.nil?.invoices || [];
  const hsnRows  = data?.hsn?.rows  || [];

  // Human-readable range label used in empty states
  const rangeLabel = range[0] && range[1]
    ? `${range[0].format('DD MMM YYYY')} — ${range[1].format('DD MMM YYYY')}`
    : '';

  return (
    <div className="g1-page">
      {/* Header */}
      <div className="g1-hd">
        <div className="g1-title">
          <h1>GSTR-1</h1>
        </div>
        <div className="g1-hd-actions">
          <RangePicker
            value={range}
            onChange={(v) => v && v[0] && v[1] && setRange(v)}
            format="DD MMM YYYY"
            allowClear={false}
            style={{ height: 34 }}
          />
          <button className="g1-btn" onClick={load} title="Refresh">
            <ReloadOutlined /> Refresh
          </button>
          <button className="g1-btn primary" onClick={handleExport} title="Download Excel">
            <FileExcelOutlined /> Excel
          </button>
        </div>
      </div>

      {/* KPI strip — 3 cards, Aging-style */}
      <div className="g1-kpis">
        <div className="g1-kpi tot">
          <span className="k">Taxable Value</span>
          <span className="v">₹ {fmtInt(kpi.taxable)}</span>
          <span className="sub"><b>{kpi.invoices}</b> invoices this period</span>
        </div>
        <div className="g1-kpi tax">
          <span className="k">Total Tax</span>
          <span className="v">₹ {fmtInt(kpi.igst + kpi.cgst + kpi.sgst)}</span>
          <span className="sub">
            CGST <b>₹ {fmtInt(kpi.cgst)}</b> · SGST <b>₹ {fmtInt(kpi.sgst)}</b> · IGST <b>₹ {fmtInt(kpi.igst)}</b>
          </span>
        </div>
        <div className="g1-kpi sum">
          <span className="k">Total Turnover</span>
          <span className="v">₹ {fmtInt(kpi.total)}</span>
          <span className="sub">
            B2B <b>{b2bRows.length}</b> &middot; B2CS <b>{b2csRows.length}</b> &middot; Nil <b>{nilInvs.length}</b> &middot; HSN <b>{hsnRows.length}</b>
          </span>
        </div>
      </div>

      {/* Section tabs */}
      <div className="g1-viewbar">
        <div className="g1-tabs">
          <button
            className={`g1-tab ${section === 'b2b' ? 'active' : ''}`}
            onClick={() => setSection('b2b')}
          ><TeamOutlined /> 4A — B2B</button>
          <button
            className={`g1-tab ${section === 'b2cs' ? 'active' : ''}`}
            onClick={() => setSection('b2cs')}
          ><FileTextOutlined /> 7 — B2CS</button>
          <button
            className={`g1-tab ${section === 'nil' ? 'active' : ''}`}
            onClick={() => setSection('nil')}
          ><StopOutlined /> 8 — Nil / Exempt</button>
          <button
            className={`g1-tab ${section === 'hsn' ? 'active' : ''}`}
            onClick={() => setSection('hsn')}
          ><TagsOutlined /> 12 — HSN Summary</button>
        </div>
      </div>

      {/* Content */}
      <div className="g1-wrap">
        <div className="g1-scroll">
          {loading ? (
            <div className="g1-empty"><Spin /></div>
          ) : section === 'b2b' ? (
            /* ── 4A — B2B ── grouped by recipient GSTIN ── */
            b2bRows.length === 0 ? (
              <div className="g1-empty"><div className="big">No B2B invoices between {rangeLabel}</div></div>
            ) : (
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th style={{width:'36px'}}>#</th>
                    <th>GSTIN</th>
                    <th>Receiver Name</th>
                    <th>Invoices</th>
                    <th>Taxable</th>
                    <th>IGST</th>
                    <th>CGST</th>
                    <th>SGST</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {b2bRows.map((g, i) => {
                    const isOpen = expanded.has(g.gstin);
                    return (
                      <React.Fragment key={g.gstin}>
                        <tr className={`g1-grp ${isOpen ? 'expanded' : ''}`}
                            onClick={() => toggleExpanded(g.gstin)}>
                          <td className="g1-rownum">{i + 1}</td>
                          <td>
                            <span className="g1-expand"><RightOutlined style={{ fontSize: 10 }} /></span>
                            <span className="g1-gstin">{g.gstin}</span>
                          </td>
                          <td>{g.party_name}</td>
                          <td>{g.invoice_count}</td>
                          <td>{fmt(g.taxable)}</td>
                          <td className={g.igst === 0 ? 'g1-zero' : ''}>{g.igst === 0 ? '—' : fmt(g.igst)}</td>
                          <td className={g.cgst === 0 ? 'g1-zero' : ''}>{g.cgst === 0 ? '—' : fmt(g.cgst)}</td>
                          <td className={g.sgst === 0 ? 'g1-zero' : ''}>{g.sgst === 0 ? '—' : fmt(g.sgst)}</td>
                          <td className="g1-total">{fmt(g.total)}</td>
                        </tr>
                        {isOpen && g.invoices.map(inv => (
                          <tr key={`${g.gstin}-${inv.bill_number}`} className="g1-inv">
                            <td></td>
                            <td colSpan={2}>
                              <span className="g1-bill-no">{inv.bill_number}</span>
                              &nbsp;·&nbsp; {fmtDate(inv.bill_date)}
                              &nbsp;·&nbsp; POS {inv.place_of_supply}
                              &nbsp;·&nbsp; {inv.invoice_type}
                            </td>
                            <td>{inv.rate_rows.map(r => `${r.rate}%`).join(', ')}</td>
                            <td>{fmt(inv.taxable)}</td>
                            <td className={inv.igst === 0 ? 'g1-zero' : ''}>{inv.igst === 0 ? '' : fmt(inv.igst)}</td>
                            <td className={inv.cgst === 0 ? 'g1-zero' : ''}>{inv.cgst === 0 ? '' : fmt(inv.cgst)}</td>
                            <td className={inv.sgst === 0 ? 'g1-zero' : ''}>{inv.sgst === 0 ? '' : fmt(inv.sgst)}</td>
                            <td className="g1-total">{fmt(inv.total)}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="g1-tot-row">
                    <td colSpan={4} style={{textAlign:'right', fontWeight:600, color:'var(--fg-secondary)'}}>
                      {b2bRows.length} parties · {b2bRows.reduce((a,g) => a+g.invoice_count, 0)} invoices
                    </td>
                    <td>{fmt(data?.b2b?.grand?.taxable || 0)}</td>
                    <td>{fmt(data?.b2b?.grand?.igst || 0)}</td>
                    <td>{fmt(data?.b2b?.grand?.cgst || 0)}</td>
                    <td>{fmt(data?.b2b?.grand?.sgst || 0)}</td>
                    <td className="g1-total">{fmt(data?.b2b?.grand?.total || 0)}</td>
                  </tr>
                </tfoot>
              </table>
            )
          ) : section === 'b2cs' ? (
            /* ── 7 — B2CS ── aggregated rows ── */
            b2csRows.length === 0 ? (
              <div className="g1-empty"><div className="big">No B2CS rows between {rangeLabel}</div></div>
            ) : (
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th style={{width:'36px'}}>#</th>
                    <th>Place of Supply</th>
                    <th>Supply Type</th>
                    <th>Rate</th>
                    <th>Taxable</th>
                    <th>IGST</th>
                    <th>CGST</th>
                    <th>SGST</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {b2csRows.map((r, i) => (
                    <tr key={`${r.place_of_supply}-${r.rate}-${r.type}`}>
                      <td className="g1-rownum">{i + 1}</td>
                      <td><span className="g1-gstin">{r.place_of_supply}</span></td>
                      <td>{r.type}</td>
                      <td>{r.rate}%</td>
                      <td>{fmt(r.taxable)}</td>
                      <td className={r.igst === 0 ? 'g1-zero' : ''}>{r.igst === 0 ? '—' : fmt(r.igst)}</td>
                      <td className={r.cgst === 0 ? 'g1-zero' : ''}>{r.cgst === 0 ? '—' : fmt(r.cgst)}</td>
                      <td className={r.sgst === 0 ? 'g1-zero' : ''}>{r.sgst === 0 ? '—' : fmt(r.sgst)}</td>
                      <td className="g1-total">{fmt(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="g1-tot-row">
                    <td colSpan={4} style={{textAlign:'right', fontWeight:600, color:'var(--fg-secondary)'}}>
                      {b2csRows.length} {b2csRows.length === 1 ? 'row' : 'rows'}
                    </td>
                    <td>{fmt(data?.b2cs?.grand?.taxable || 0)}</td>
                    <td>{fmt(data?.b2cs?.grand?.igst || 0)}</td>
                    <td>{fmt(data?.b2cs?.grand?.cgst || 0)}</td>
                    <td>{fmt(data?.b2cs?.grand?.sgst || 0)}</td>
                    <td className="g1-total">{fmt(data?.b2cs?.grand?.total || 0)}</td>
                  </tr>
                </tfoot>
              </table>
            )
          ) : section === 'nil' ? (
            /* ── 8 — Nil / Exempt / Non-GST ──
             * Top block: the 4-way summary the portal wants.
             * Bottom block: per-invoice list so users can find the bills
             * that landed here (often useful for catching data-entry slips
             * where a bill-wise invoice was saved without tax %).
             */
            nilRows.length === 0 ? (
              <div className="g1-empty"><div className="big">No nil/exempt supplies between {rangeLabel}</div></div>
            ) : (
              <>
                <table className="g1-tbl">
                  <thead>
                    <tr>
                      <th style={{width:'36px'}}>#</th>
                      <th>Supply Type</th>
                      <th>Type</th>
                      <th>Invoices</th>
                      <th>Taxable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nilRows.map((r, i) => (
                      <tr key={`${r.supply_type}-${r.state_type}`}>
                        <td className="g1-rownum">{i + 1}</td>
                        <td>{r.supply_type}</td>
                        <td>{r.state_type}</td>
                        <td>{r.invoice_count}</td>
                        <td className="g1-total">{fmt(r.taxable)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="g1-tot-row">
                      <td colSpan={3} style={{textAlign:'right', fontWeight:600, color:'var(--fg-secondary)'}}>
                        {nilRows.length} {nilRows.length === 1 ? 'row' : 'rows'}
                      </td>
                      <td>{nilInvs.length}</td>
                      <td className="g1-total">{fmt(data?.nil?.grand?.taxable || 0)}</td>
                    </tr>
                  </tfoot>
                </table>

                {nilInvs.length > 0 && (
                  <table className="g1-tbl" style={{ marginTop: 24 }}>
                    <thead>
                      <tr>
                        <th style={{width:'36px'}}>#</th>
                        <th>Invoice No</th>
                        <th>Date</th>
                        <th>Receiver</th>
                        <th>GSTIN</th>
                        <th>POS</th>
                        <th>Type</th>
                        <th>Taxable</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nilInvs.map((inv, i) => (
                        <tr key={inv.bill_number}>
                          <td className="g1-rownum">{i + 1}</td>
                          <td><span className="g1-bill-no">{inv.bill_number}</span></td>
                          <td>{fmtDate(inv.bill_date)}</td>
                          <td>{inv.party_name}</td>
                          <td><span className="g1-gstin">{inv.gstin || '—'}</span></td>
                          <td>{inv.place_of_supply || '—'}</td>
                          <td>{inv.state_type}</td>
                          <td className="g1-total">{fmt(inv.taxable)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )
          ) : (
            /* ── 12 — HSN Summary ── */
            hsnRows.length === 0 ? (
              <div className="g1-empty"><div className="big">No HSN activity between {rangeLabel}</div></div>
            ) : (
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th style={{width:'36px'}}>#</th>
                    <th>HSN/SAC</th>
                    <th>UQC</th>
                    <th>Rate</th>
                    <th>Quantity</th>
                    <th>Taxable</th>
                    <th>IGST</th>
                    <th>CGST</th>
                    <th>SGST</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {hsnRows.map((r, i) => (
                    <tr key={`${r.hsn_code}-${r.rate}-${r.unit}`}>
                      <td className="g1-rownum">{i + 1}</td>
                      <td><span className="g1-gstin">{r.hsn_code}</span></td>
                      <td>{r.unit}</td>
                      <td>{r.rate}%</td>
                      <td>{fmt(r.quantity)}</td>
                      <td>{fmt(r.taxable)}</td>
                      <td className={r.igst === 0 ? 'g1-zero' : ''}>{r.igst === 0 ? '—' : fmt(r.igst)}</td>
                      <td className={r.cgst === 0 ? 'g1-zero' : ''}>{r.cgst === 0 ? '—' : fmt(r.cgst)}</td>
                      <td className={r.sgst === 0 ? 'g1-zero' : ''}>{r.sgst === 0 ? '—' : fmt(r.sgst)}</td>
                      <td className="g1-total">{fmt(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="g1-tot-row">
                    <td colSpan={4} style={{textAlign:'right', fontWeight:600, color:'var(--fg-secondary)'}}>
                      {hsnRows.length} HSN {hsnRows.length === 1 ? 'row' : 'rows'}
                    </td>
                    <td>{fmt(data?.hsn?.grand?.quantity || 0)}</td>
                    <td>{fmt(data?.hsn?.grand?.taxable || 0)}</td>
                    <td>{fmt(data?.hsn?.grand?.igst || 0)}</td>
                    <td>{fmt(data?.hsn?.grand?.cgst || 0)}</td>
                    <td>{fmt(data?.hsn?.grand?.sgst || 0)}</td>
                    <td className="g1-total">{fmt(data?.hsn?.grand?.total || 0)}</td>
                  </tr>
                </tfoot>
              </table>
            )
          )}
        </div>
      </div>
    </div>
  );
}
