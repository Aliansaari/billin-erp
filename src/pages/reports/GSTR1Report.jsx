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
import { useSearchParams, useLocation, Link } from 'react-router-dom';
import { message, Spin, DatePicker, Tooltip } from 'antd';
import {
  ReloadOutlined, FileExcelOutlined, RightOutlined,
  FileTextOutlined, TeamOutlined, TagsOutlined, StopOutlined,
  GoldOutlined, FileSearchOutlined, RollbackOutlined, UndoOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
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
  const location = useLocation();
  const { fyStart, fyEnd } = useFinancialYear();
  // Captured per render so Back/save in SalesBillForm returns here with the
  // current date range preserved (the search string carries from/to).
  const fromState = { from: location.pathname + location.search };

  // Range = [from, to]. URL params ?from=YYYY-MM-DD&to=YYYY-MM-DD make the
  // view bookmarkable. Default: the company FY (URL params win when
  // present so deep-linked dashboards still work).
  const [range, setRange] = useState(() => {
    const f = params.get('from'), t = params.get('to');
    if (f && /^\d{4}-\d{2}-\d{2}$/.test(f) && t && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return [dayjs(f), dayjs(t)];
    }
    if (fyStart && fyEnd) return [dayjs(fyStart), dayjs(fyEnd)];
    return [dayjs().startOf('month'), dayjs().endOf('month')];
  });
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  // Section tab is persisted in the URL too (?section=nil) so navigating
  // away (e.g. opening a bill for editing) and coming back lands the user
  // on the same tab they left from instead of resetting to B2B.
  const VALID_SECTIONS = ['b2b', 'b2cl', 'b2cs', 'nil', 'cdnr', 'cdnur', 'hsn', 'docs'];
  const [section, setSection] = useState(() => {
    const s = params.get('section');
    return VALID_SECTIONS.includes(s) ? s : 'b2b';
  });

  useEffect(() => {
    const [from, to] = range;
    if (!from || !to) return;
    const f = from.format('YYYY-MM-DD'), t = to.format('YYYY-MM-DD');
    const next = { from: f, to: t, section };
    if (params.get('from') !== f || params.get('to') !== t || params.get('section') !== section) {
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, section]);

  const [expanded, setExpanded] = useState(new Set());
  // Click-to-filter for the Nil/Exempt summary → bottom invoice list.
  // null = show all 22; { supply_type, state_type } = show just that bucket.
  const [nilFilter, setNilFilter] = useState(null);

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
      setNilFilter(null);
    } catch (e) {
      message.error('Failed to load GSTR-1');
      setData(null);
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const p = queryParams();
      // Pass section so the workbook opens to the tab the user was viewing
      // (and the filename is suffixed with the section tag).
      const res = await reportAPI.exportGstr1({ ...p, section });
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gstr1_${p.from_date}_to_${p.to_date}_${section}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  /* Header KPI totals — period-wide turnover and tax collected, summed
   * across all sections (B2B + B2CL + B2CS + Nil). */
  const kpi = useMemo(() => {
    if (!data) return { taxable: 0, igst: 0, cgst: 0, sgst: 0, total: 0, invoices: 0 };
    const b2b  = data.b2b?.grand  || { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    const b2cl = data.b2cl?.grand || { taxable: 0, igst: 0, cess: 0 };
    const b2cs = data.b2cs?.grand || { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    const nilT = Number(data.nil?.grand?.taxable) || 0;
    const invoices = data.period_meta?.invoice_count || 0;
    const taxable = b2b.taxable + b2cl.taxable + b2cs.taxable + nilT;
    const igst = b2b.igst + b2cl.igst + b2cs.igst;
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

  const b2bRows   = data?.b2b?.rows   || [];
  const b2clRows  = data?.b2cl?.rows  || [];
  const b2csRows  = data?.b2cs?.rows  || [];
  const nilRows   = data?.nil?.rows   || [];
  const cdnrRows  = data?.cdnr?.rows  || [];
  const cdnurRows = data?.cdnur?.rows || [];
  const docsRows  = data?.docs?.rows  || [];
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

      {/* Data-quality warning banner — surfaces bills where the stored
          numbers don't add up (typically: bill-level discount wasn't
          applied to per-item taxable_amount). Operator clicks any row
          to open the bill, re-saves it, and the next refresh of this
          report will be clean. Without the fix, GSTR-1 totals are wrong
          and downstream returns (GSTR-3B) inherit the error. */}
      {data?.data_quality?.bill_warning_count > 0 && (
        <div className="g1-warn-banner">
          <div className="g1-warn-banner-head">
            <div>
              <div className="g1-warn-banner-title">
                <span className="g1-warn-icon">⚠</span>
                Data quality issues — {data.data_quality.bill_warning_count} {data.data_quality.bill_warning_count === 1 ? 'bill needs' : 'bills need'} attention
              </div>
              <div className="g1-warn-banner-sub">
                These bills have <code>items + tax &gt; total</code>, which over-states the taxable value reported in this return. Open each bill and re-save to recompute the per-item discount.
              </div>
            </div>
            <button className="g1-warn-toggle"
                    onClick={() => setExpanded(prev => {
                      const n = new Set(prev);
                      n.has('__warn__') ? n.delete('__warn__') : n.add('__warn__');
                      return n;
                    })}>
              {expanded.has('__warn__') ? 'Hide' : 'Show'} {data.data_quality.bill_warning_count > 10 ? 'all' : ''}
            </button>
          </div>
          {expanded.has('__warn__') && (
            <div className="g1-warn-list">
              <table className="g1-warn-tbl">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Date</th>
                    <th style={{textAlign:'right'}}>Items + Tax</th>
                    <th style={{textAlign:'right'}}>Bill Total</th>
                    <th style={{textAlign:'right'}}>Over by</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data_quality.bill_warnings.map(w => (
                    <tr key={w.bill_id || w.bill_number} title={w.message}>
                      <td>
                        {w.bill_id ? (
                          <Link to={`/sale/edit/${w.bill_id}`} state={fromState} className="g1-bill-link">
                            {w.bill_number}
                          </Link>
                        ) : w.bill_number}
                      </td>
                      <td>{fmtDate(w.bill_date)}</td>
                      <td style={{textAlign:'right'}}>{fmt(w.items_taxable_sum + w.header_tax_sum)}</td>
                      <td style={{textAlign:'right'}}>{fmt(w.bill_total)}</td>
                      <td style={{textAlign:'right', color:'#dc2626', fontWeight:600}}>+ {fmt(w.over_by)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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
            B2B <b>{b2bRows.length}</b> &middot; B2CL <b>{data?.b2cl?.invoice_count || 0}</b> &middot; B2CS <b>{b2csRows.length}</b> &middot; Nil <b>{nilInvs.length}</b> &middot; HSN <b>{hsnRows.length}</b>
            {(data?.cdnr?.note_count > 0 || data?.cdnur?.note_count > 0) && (
              <> &middot; CN <b>{(data?.cdnr?.note_count || 0) + (data?.cdnur?.note_count || 0)}</b></>
            )}
            {data?.period_meta?.cancelled_count > 0 && (
              <> &middot; Cancelled <b>{data.period_meta.cancelled_count}</b></>
            )}
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
            className={`g1-tab ${section === 'b2cl' ? 'active' : ''}`}
            onClick={() => setSection('b2cl')}
          ><GoldOutlined /> 5A — B2CL</button>
          <button
            className={`g1-tab ${section === 'b2cs' ? 'active' : ''}`}
            onClick={() => setSection('b2cs')}
          ><FileTextOutlined /> 7 — B2CS</button>
          <button
            className={`g1-tab ${section === 'nil' ? 'active' : ''}`}
            onClick={() => setSection('nil')}
          ><StopOutlined /> 8 — Nil / Exempt</button>
          <button
            className={`g1-tab ${section === 'cdnr' ? 'active' : ''}`}
            onClick={() => setSection('cdnr')}
          ><RollbackOutlined /> 9A — CDNR</button>
          <button
            className={`g1-tab ${section === 'cdnur' ? 'active' : ''}`}
            onClick={() => setSection('cdnur')}
          ><UndoOutlined /> 9B — CDNUR</button>
          <button
            className={`g1-tab ${section === 'hsn' ? 'active' : ''}`}
            onClick={() => setSection('hsn')}
          ><TagsOutlined /> 12 — HSN Summary</button>
          <button
            className={`g1-tab ${section === 'docs' ? 'active' : ''}`}
            onClick={() => setSection('docs')}
          ><FileSearchOutlined /> 13 — Docs Issued</button>
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
                              {inv.bill_id ? (
                                <Link to={`/sale/edit/${inv.bill_id}`} state={fromState} className="g1-bill-link" title="Open bill for editing">
                                  {inv.bill_number}
                                </Link>
                              ) : (
                                <span className="g1-bill-no">{inv.bill_number}</span>
                              )}
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
          ) : section === 'b2cl' ? (
            /* ── 5A — B2CL ── large unregistered inter-state (>₹2.5L) ──
             * One row per (invoice × rate). invoice_value repeats across
             * rate rows for the same bill — that's the portal-expected
             * shape. Grand totals reflect distinct sums (taxable + igst).
             */
            b2clRows.length === 0 ? (
              <div className="g1-empty">
                <div className="big">No B2CL invoices between {rangeLabel}</div>
                <div>None of the period's invoices were unregistered, inter-state, AND above ₹2,50,000.</div>
              </div>
            ) : (
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th style={{width:'36px'}}>#</th>
                    <th>Invoice No</th>
                    <th>Date</th>
                    <th>Receiver</th>
                    <th>POS</th>
                    <th>Rate</th>
                    <th>Invoice Value</th>
                    <th>Taxable</th>
                    <th>IGST</th>
                    <th>Cess</th>
                  </tr>
                </thead>
                <tbody>
                  {b2clRows.map((r, i) => (
                    <tr key={`${r.bill_number}-${r.rate}`}>
                      <td className="g1-rownum">{i + 1}</td>
                      <td>
                        {r.bill_id ? (
                          <Link to={`/sale/edit/${r.bill_id}`} state={fromState} className="g1-bill-link" title="Open bill for editing">
                            {r.bill_number}
                          </Link>
                        ) : (
                          <span className="g1-bill-no">{r.bill_number}</span>
                        )}
                      </td>
                      <td>{fmtDate(r.bill_date)}</td>
                      <td>
                        {r.customer_name}
                        {r.mobile && <span style={{ color:'var(--fg-tertiary)', marginLeft: 6 }}>· {r.mobile}</span>}
                      </td>
                      <td><span className="g1-gstin">{r.place_of_supply}</span></td>
                      <td>{r.rate}%</td>
                      <td>{fmt(r.invoice_value)}</td>
                      <td>{fmt(r.taxable)}</td>
                      <td>{fmt(r.igst)}</td>
                      <td className={r.cess === 0 ? 'g1-zero' : ''}>{r.cess === 0 ? '—' : fmt(r.cess)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="g1-tot-row">
                    <td colSpan={6} style={{textAlign:'right', fontWeight:600, color:'var(--fg-secondary)'}}>
                      {data?.b2cl?.invoice_count || 0} {(data?.b2cl?.invoice_count || 0) === 1 ? 'invoice' : 'invoices'} · {b2clRows.length} rate {b2clRows.length === 1 ? 'row' : 'rows'}
                    </td>
                    <td>—</td>
                    <td>{fmt(data?.b2cl?.grand?.taxable || 0)}</td>
                    <td>{fmt(data?.b2cl?.grand?.igst || 0)}</td>
                    <td>{fmt(data?.b2cl?.grand?.cess || 0)}</td>
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
                    <th>Invoices</th>
                    <th>Taxable</th>
                    <th>IGST</th>
                    <th>CGST</th>
                    <th>SGST</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {b2csRows.map((r, i) => {
                    const key = `${r.place_of_supply}-${r.rate}-${r.type}`;
                    const isOpen = expanded.has(key);
                    const invs = r.invoices || [];
                    return (
                      <React.Fragment key={key}>
                        <tr className={`g1-grp ${isOpen ? 'expanded' : ''}`}
                            onClick={() => toggleExpanded(key)}
                            title={isOpen ? 'Hide invoices' : `Show ${invs.length} invoice${invs.length === 1 ? '' : 's'}`}>
                          <td className="g1-rownum">{i + 1}</td>
                          <td>
                            <span className="g1-expand"><RightOutlined style={{ fontSize: 10 }} /></span>
                            <span className="g1-gstin">{r.place_of_supply}</span>
                          </td>
                          <td>{r.type}</td>
                          <td>{r.rate}%</td>
                          <td>{r.invoice_count ?? invs.length}</td>
                          <td>{fmt(r.taxable)}</td>
                          <td className={r.igst === 0 ? 'g1-zero' : ''}>{r.igst === 0 ? '—' : fmt(r.igst)}</td>
                          <td className={r.cgst === 0 ? 'g1-zero' : ''}>{r.cgst === 0 ? '—' : fmt(r.cgst)}</td>
                          <td className={r.sgst === 0 ? 'g1-zero' : ''}>{r.sgst === 0 ? '—' : fmt(r.sgst)}</td>
                          <td className="g1-total">{fmt(r.total)}</td>
                        </tr>
                        {isOpen && invs.map(inv => (
                          <tr key={`${key}-${inv.bill_number}`} className="g1-inv">
                            <td></td>
                            <td colSpan={2}>
                              {inv.bill_id ? (
                                <Link to={`/sale/edit/${inv.bill_id}`} state={fromState} className="g1-bill-link" title="Open bill for editing">
                                  {inv.bill_number}
                                </Link>
                              ) : (
                                <span className="g1-bill-no">{inv.bill_number}</span>
                              )}
                              &nbsp;·&nbsp; {fmtDate(inv.bill_date)}
                            </td>
                            <td colSpan={2}>
                              {inv.customer_name}
                              {inv.mobile && <span style={{ color:'var(--fg-tertiary)', marginLeft: 6 }}>· {inv.mobile}</span>}
                            </td>
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
                      {b2csRows.length} {b2csRows.length === 1 ? 'row' : 'rows'}
                    </td>
                    <td>{b2csRows.reduce((a, r) => a + (r.invoice_count || (r.invoices || []).length), 0)}</td>
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
                    {nilRows.map((r, i) => {
                      const isActive = nilFilter
                        && nilFilter.supply_type === r.supply_type
                        && nilFilter.state_type === r.state_type;
                      return (
                        <tr
                          key={`${r.supply_type}-${r.state_type}`}
                          className={`g1-grp ${isActive ? 'expanded' : ''}`}
                          onClick={() => setNilFilter(isActive ? null : { supply_type: r.supply_type, state_type: r.state_type })}
                          title={isActive ? 'Click to clear filter' : `Show ${r.invoice_count} ${r.supply_type.toLowerCase()} ${r.state_type.toLowerCase()} invoice${r.invoice_count === 1 ? '' : 's'}`}
                        >
                          <td className="g1-rownum">{i + 1}</td>
                          <td>
                            <span className="g1-expand"><RightOutlined style={{ fontSize: 10 }} /></span>
                            {r.supply_type}
                          </td>
                          <td>{r.state_type}</td>
                          <td>{r.invoice_count}</td>
                          <td className="g1-total">{fmt(r.taxable)}</td>
                        </tr>
                      );
                    })}
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

                {nilInvs.length > 0 && (() => {
                  const filtered = nilFilter
                    ? nilInvs.filter(inv =>
                        inv.supply_type === nilFilter.supply_type &&
                        inv.state_type === nilFilter.state_type)
                    : nilInvs;
                  return (
                  <>
                  <div className="g1-nil-filterbar">
                    <span className="g1-nil-filterbar-label">
                      {nilFilter
                        ? `Showing ${filtered.length} of ${nilInvs.length} invoices`
                        : `All ${nilInvs.length} invoices`}
                    </span>
                    {nilFilter && (
                      <button
                        type="button"
                        className="g1-nil-chip"
                        onClick={() => setNilFilter(null)}
                        title="Clear filter"
                      >
                        {nilFilter.supply_type} · {nilFilter.state_type}
                        <span className="g1-nil-chip-x">×</span>
                      </button>
                    )}
                  </div>
                  <table className="g1-tbl" style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th style={{width:'36px'}}>#</th>
                        <th>Invoice No</th>
                        <th>Date</th>
                        <th>Receiver</th>
                        <th>GSTIN</th>
                        <th>POS</th>
                        <th>Type</th>
                        <th>Reason</th>
                        <th>Taxable</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((inv, i) => {
                        const reason = inv.reason || '—';
                        const detail = inv.reason_detail || '';
                        const remarks = inv.remarks || '';
                        const tip = (
                          <div style={{ maxWidth: 280, lineHeight: 1.45 }}>
                            {detail && <div>{detail}</div>}
                            {remarks && (
                              <div style={{ marginTop: detail ? 8 : 0, paddingTop: detail ? 8 : 0, borderTop: detail ? '1px solid rgba(255,255,255,0.15)' : 'none' }}>
                                <b>Bill remarks:</b> {remarks}
                              </div>
                            )}
                            {!detail && !remarks && <div>No additional information</div>}
                          </div>
                        );
                        const isReview = reason !== 'Nil-rated';
                        return (
                          <tr key={inv.bill_number}>
                            <td className="g1-rownum">{i + 1}</td>
                            <td>
                              {inv.bill_id ? (
                                <Link to={`/sale/edit/${inv.bill_id}`} state={fromState} className="g1-bill-link" title="Open bill for editing">
                                  {inv.bill_number}
                                </Link>
                              ) : (
                                <span className="g1-bill-no">{inv.bill_number}</span>
                              )}
                            </td>
                            <td>{fmtDate(inv.bill_date)}</td>
                            <td>{inv.party_name}</td>
                            <td><span className="g1-gstin">{inv.gstin || '—'}</span></td>
                            <td>{inv.place_of_supply || '—'}</td>
                            <td>{inv.state_type}</td>
                            <td>
                              <Tooltip title={tip} placement="left">
                                <span className={`g1-reason ${isReview ? 'g1-reason-warn' : 'g1-reason-ok'}`}>
                                  {reason}
                                  {remarks && <span className="g1-reason-mark" title="Bill has remarks"> ●</span>}
                                </span>
                              </Tooltip>
                            </td>
                            <td className="g1-total">{fmt(inv.taxable)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </>
                  );
                })()}
              </>
            )
          ) : section === 'cdnr' ? (
            /* ── 9A — CDNR (Credit/Debit Notes — Registered) ──
             * Each row is one (note × rate) line. Shows GSTIN, original
             * invoice ref, and the tax breakdown the recipient will use
             * to reverse their input-tax-credit claim.
             */
            cdnrRows.length === 0 ? (
              <div className="g1-empty">
                <div className="big">No credit notes to registered customers between {rangeLabel}</div>
                <div>None of the period's sales returns went to a customer with a GSTIN.</div>
              </div>
            ) : (
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th style={{width:'36px'}}>#</th>
                    <th>GSTIN</th>
                    <th>Receiver</th>
                    <th>Note No</th>
                    <th>Date</th>
                    <th>Type</th>
                    <th>POS</th>
                    <th>Original Invoice</th>
                    <th>Rate</th>
                    <th>Note Value</th>
                    <th>Taxable</th>
                    <th>IGST</th>
                    <th>CGST</th>
                    <th>SGST</th>
                  </tr>
                </thead>
                <tbody>
                  {cdnrRows.map((r, i) => (
                    <tr key={`${r.note_number}-${r.rate}`}>
                      <td className="g1-rownum">{i + 1}</td>
                      <td><span className="g1-gstin">{r.gstin}</span></td>
                      <td>{r.customer_name}</td>
                      <td><span className="g1-bill-no">{r.note_number}</span></td>
                      <td>{fmtDate(r.note_date)}</td>
                      <td>
                        <span className="g1-reason g1-reason-warn" style={{ background: 'color-mix(in srgb, #dc2626 14%, transparent)', color: '#b91c1c', borderColor: 'color-mix(in srgb, #dc2626 32%, transparent)' }}>
                          {r.note_type === 'C' ? 'Credit' : 'Debit'}
                        </span>
                      </td>
                      <td><span className="g1-gstin">{r.place_of_supply}</span></td>
                      <td>
                        {r.original_invoice_number || '—'}
                        {r.original_invoice_date && <span style={{ color:'var(--fg-tertiary)', marginLeft: 6 }}>· {fmtDate(r.original_invoice_date)}</span>}
                      </td>
                      <td>{r.rate}%</td>
                      <td>{fmt(r.note_value)}</td>
                      <td>{fmt(r.taxable)}</td>
                      <td className={r.igst === 0 ? 'g1-zero' : ''}>{r.igst === 0 ? '—' : fmt(r.igst)}</td>
                      <td className={r.cgst === 0 ? 'g1-zero' : ''}>{r.cgst === 0 ? '—' : fmt(r.cgst)}</td>
                      <td className={r.sgst === 0 ? 'g1-zero' : ''}>{r.sgst === 0 ? '—' : fmt(r.sgst)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="g1-tot-row">
                    <td colSpan={9} style={{textAlign:'right', fontWeight:600, color:'var(--fg-secondary)'}}>
                      {data?.cdnr?.note_count || 0} {(data?.cdnr?.note_count || 0) === 1 ? 'note' : 'notes'} · {cdnrRows.length} rate {cdnrRows.length === 1 ? 'row' : 'rows'}
                    </td>
                    <td>—</td>
                    <td>{fmt(data?.cdnr?.grand?.taxable || 0)}</td>
                    <td>{fmt(data?.cdnr?.grand?.igst || 0)}</td>
                    <td>{fmt(data?.cdnr?.grand?.cgst || 0)}</td>
                    <td>{fmt(data?.cdnr?.grand?.sgst || 0)}</td>
                  </tr>
                </tfoot>
              </table>
            )
          ) : section === 'cdnur' ? (
            /* ── 9B — CDNUR (Credit/Debit Notes — Unregistered) ──
             * Inter-state notes are portal-eligible (UR Type=B2CL); intra-
             * state ones are flagged 'B2C' for review — they technically
             * net into Table 7 B2CS, not Table 9B.
             */
            cdnurRows.length === 0 ? (
              <div className="g1-empty">
                <div className="big">No credit notes to unregistered customers between {rangeLabel}</div>
                <div>None of the period's sales returns went to a customer without a GSTIN.</div>
              </div>
            ) : (
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th style={{width:'36px'}}>#</th>
                    <th>UR Type</th>
                    <th>Receiver</th>
                    <th>Note No</th>
                    <th>Date</th>
                    <th>Type</th>
                    <th>POS</th>
                    <th>Original Invoice</th>
                    <th>Rate</th>
                    <th>Note Value</th>
                    <th>Taxable</th>
                    <th>IGST</th>
                    <th>Cess</th>
                  </tr>
                </thead>
                <tbody>
                  {cdnurRows.map((r, i) => {
                    const isB2C = r.ur_type === 'B2C';
                    return (
                      <tr key={`${r.note_number}-${r.rate}`}>
                        <td className="g1-rownum">{i + 1}</td>
                        <td>
                          <Tooltip title={isB2C ? 'Intra-state unregistered — should be netted into Table 7 (B2CS) before portal upload, not filed in 9B.' : 'Inter-state unregistered — portal-eligible for Table 9B.'} placement="right">
                            <span className={`g1-reason ${isB2C ? 'g1-reason-warn' : 'g1-reason-ok'}`}>{r.ur_type}</span>
                          </Tooltip>
                        </td>
                        <td>
                          {r.customer_name}
                          {r.mobile && <span style={{ color:'var(--fg-tertiary)', marginLeft: 6 }}>· {r.mobile}</span>}
                        </td>
                        <td><span className="g1-bill-no">{r.note_number}</span></td>
                        <td>{fmtDate(r.note_date)}</td>
                        <td>
                          <span className="g1-reason g1-reason-warn" style={{ background: 'color-mix(in srgb, #dc2626 14%, transparent)', color: '#b91c1c', borderColor: 'color-mix(in srgb, #dc2626 32%, transparent)' }}>
                            {r.note_type === 'C' ? 'Credit' : 'Debit'}
                          </span>
                        </td>
                        <td><span className="g1-gstin">{r.place_of_supply}</span></td>
                        <td>
                          {r.original_invoice_number || '—'}
                          {r.original_invoice_date && <span style={{ color:'var(--fg-tertiary)', marginLeft: 6 }}>· {fmtDate(r.original_invoice_date)}</span>}
                        </td>
                        <td>{r.rate}%</td>
                        <td>{fmt(r.note_value)}</td>
                        <td>{fmt(r.taxable)}</td>
                        <td className={r.igst === 0 ? 'g1-zero' : ''}>{r.igst === 0 ? '—' : fmt(r.igst)}</td>
                        <td className={r.cess === 0 ? 'g1-zero' : ''}>{r.cess === 0 ? '—' : fmt(r.cess)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="g1-tot-row">
                    <td colSpan={9} style={{textAlign:'right', fontWeight:600, color:'var(--fg-secondary)'}}>
                      {data?.cdnur?.note_count || 0} {(data?.cdnur?.note_count || 0) === 1 ? 'note' : 'notes'} · {cdnurRows.length} rate {cdnurRows.length === 1 ? 'row' : 'rows'}
                    </td>
                    <td>—</td>
                    <td>{fmt(data?.cdnur?.grand?.taxable || 0)}</td>
                    <td>{fmt(data?.cdnur?.grand?.igst || 0)}</td>
                    <td>{fmt(data?.cdnur?.grand?.cess || 0)}</td>
                  </tr>
                </tfoot>
              </table>
            )
          ) : section === 'hsn' ? (
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
          ) : (
            /* ── 13 — Documents Issued ──
             * Per-series count of invoices raised + cancelled. Catches
             * sequence gaps (compare from-no/to-no against total) and
             * proves no parallel book exists.
             */
            docsRows.length === 0 ? (
              <div className="g1-empty"><div className="big">No documents issued between {rangeLabel}</div></div>
            ) : (
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th style={{width:'36px'}}>#</th>
                    <th>Nature of Document</th>
                    <th>Series</th>
                    <th>From No</th>
                    <th>To No</th>
                    <th>Total</th>
                    <th>Cancelled</th>
                    <th>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {docsRows.map((r, i) => {
                    // Surface sequence gaps as a soft warning: when the
                    // from→to range spans more than `total` documents,
                    // some numbers are missing entirely (auditor red flag).
                    const gap = r.from_no !== '—' && r.to_no !== '—'
                      && (Number(r.to_no) - Number(r.from_no) + 1) !== r.total;
                    return (
                      <tr key={`${r.nature}-${r.prefix}`}>
                        <td className="g1-rownum">{i + 1}</td>
                        <td>{r.nature}</td>
                        <td><span className="g1-gstin">{r.prefix}</span></td>
                        <td>{r.from_no}</td>
                        <td>{r.to_no}</td>
                        <td>
                          {r.total}
                          {gap && (
                            <Tooltip title={`Range spans ${Number(r.to_no) - Number(r.from_no) + 1} numbers but only ${r.total} documents exist — there are gaps in this series.`} placement="left">
                              <span className="g1-reason g1-reason-warn" style={{ marginLeft: 8 }}>gap</span>
                            </Tooltip>
                          )}
                        </td>
                        <td className={r.cancelled === 0 ? 'g1-zero' : ''}>{r.cancelled || '—'}</td>
                        <td className="g1-total">{r.net}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="g1-tot-row">
                    <td colSpan={5} style={{textAlign:'right', fontWeight:600, color:'var(--fg-secondary)'}}>
                      {docsRows.length} {docsRows.length === 1 ? 'series' : 'series'}
                    </td>
                    <td>{data?.docs?.grand?.total || 0}</td>
                    <td>{data?.docs?.grand?.cancelled || 0}</td>
                    <td className="g1-total">{data?.docs?.grand?.net || 0}</td>
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
