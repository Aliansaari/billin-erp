/*
 * GSTR-3B — monthly summary return.
 *
 * Single-page layout (no section tabs) — 3B is short enough that all 5
 * sections fit comfortably on one scroll. Top-of-page red banner surfaces
 * data-quality issues from the same detector GSTR-1 uses, so filing 3B
 * with dirty source bills is impossible without seeing the warning.
 *
 * Math lives in server/utils/gstr3b.js (15 unit-tests passing). This page
 * is purely presentational — no calculations done client-side.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { useSearchParams, useLocation, Link } from 'react-router-dom';
import { message, Spin, DatePicker } from 'antd';
import {
  ReloadOutlined, FileExcelOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import './gstr1-report.css';   // reuse styles

const { RangePicker } = DatePicker;

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
const fmtInt = (v) => Math.round(parseFloat(v || 0)).toLocaleString('en-IN');
const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '—');

export default function GSTR3BReport() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search };

  const [range, setRange] = useState(() => {
    const f = params.get('from'), t = params.get('to');
    if (f && /^\d{4}-\d{2}-\d{2}$/.test(f) && t && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return [dayjs(f), dayjs(t)];
    }
    return [dayjs().startOf('month'), dayjs().endOf('month')];
  });

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [warnExpanded, setWarnExpanded] = useState(false);

  useEffect(() => {
    const [from, to] = range;
    if (!from || !to) return;
    const f = from.format('YYYY-MM-DD'), t = to.format('YYYY-MM-DD');
    if (params.get('from') !== f || params.get('to') !== t) {
      setParams({ from: f, to: t }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

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
      const { data: res } = await reportAPI.getGstr3b(p);
      setData(res);
      setWarnExpanded(false);
    } catch {
      message.error('Failed to load GSTR-3B');
      setData(null);
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const p = queryParams();
      const res = await reportAPI.exportGstr3b(p);
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gstr3b_${p.from_date}_to_${p.to_date}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  // Headline KPIs — outward tax, ITC available, net cash payable.
  const kpi = useMemo(() => {
    if (!data) return { outward_tax: 0, itc: 0, cash_payable: 0 };
    const t = data.section_3_1?.taxable_outward || {};
    const itc = data.section_4_itc?.C_net_available || {};
    const pay = data.section_6_1_payment || {};
    return {
      outward_tax: (t.igst || 0) + (t.cgst || 0) + (t.sgst || 0) + (t.cess || 0),
      itc:         (itc.igst || 0) + (itc.cgst || 0) + (itc.sgst || 0) + (itc.cess || 0),
      cash_payable: ['igst','cgst','sgst','cess'].reduce((a, k) => a + (pay[k]?.paid_via_cash || 0), 0),
    };
  }, [data]);

  return (
    <div className="g1-page">
      {/* Header */}
      <div className="g1-hd">
        <div className="g1-title">
          <h1>GSTR-3B</h1>
        </div>
        <div className="g1-hd-actions">
          <RangePicker
            value={range}
            onChange={(v) => v && v[0] && v[1] && setRange(v)}
            format="DD MMM YYYY"
            allowClear={false}
            style={{ height: 34 }}
          />
          <button className="g1-btn" onClick={load}><ReloadOutlined /> Refresh</button>
          <button className="g1-btn primary" onClick={handleExport}><FileExcelOutlined /> Excel</button>
        </div>
      </div>

      {/* Data-quality banner — same detector as GSTR-1. Filing 3B with
          bad source bills propagates the over-statement to the portal. */}
      {data?.data_quality?.bill_warning_count > 0 && (
        <div className="g1-warn-banner">
          <div className="g1-warn-banner-head">
            <div>
              <div className="g1-warn-banner-title">
                <span className="g1-warn-icon">⚠</span>
                Data quality issues — {data.data_quality.bill_warning_count} {data.data_quality.bill_warning_count === 1 ? 'bill' : 'bills'} affect this return
              </div>
              <div className="g1-warn-banner-sub">
                These bills have <code>items + tax &gt; total</code>. The over-statement flows directly into Section 3.1(a) Outward Taxable. Open each bill, re-save it, and the next refresh will be clean.
              </div>
            </div>
            <button className="g1-warn-toggle" onClick={() => setWarnExpanded(v => !v)}>
              {warnExpanded ? 'Hide' : 'Show'} bills
            </button>
          </div>
          {warnExpanded && (
            <div className="g1-warn-list">
              <table className="g1-warn-tbl">
                <thead>
                  <tr>
                    <th>Bill</th><th>Date</th>
                    <th style={{textAlign:'right'}}>Items + Tax</th>
                    <th style={{textAlign:'right'}}>Bill Total</th>
                    <th style={{textAlign:'right'}}>Over by</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data_quality.bill_warnings.map(w => (
                    <tr key={w.bill_id || w.bill_number}>
                      <td>
                        {w.bill_id ? (
                          <Link to={`/sale/edit/${w.bill_id}`} state={fromState} className="g1-bill-link">{w.bill_number}</Link>
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

      {/* KPI strip */}
      <div className="g1-kpis">
        <div className="g1-kpi tot">
          <span className="k">Outward Tax (3.1)</span>
          <span className="v">₹ {fmtInt(kpi.outward_tax)}</span>
          <span className="sub">
            Sales <b>{data?.period_meta?.sales_invoice_count || 0}</b> · CN <b>{data?.period_meta?.credit_note_count || 0}</b>
          </span>
        </div>
        <div className="g1-kpi tax">
          <span className="k">ITC Available (4C)</span>
          <span className="v">₹ {fmtInt(kpi.itc)}</span>
          <span className="sub">
            Purchases <b>{data?.period_meta?.purchase_invoice_count || 0}</b>
          </span>
        </div>
        <div className="g1-kpi sum">
          <span className="k">Net Cash Payable (6.1)</span>
          <span className="v">₹ {fmtInt(kpi.cash_payable)}</span>
          <span className="sub">
            {kpi.cash_payable > 0
              ? <>After ITC offset</>
              : <>ITC fully covers liability — excess carries forward</>}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="g1-wrap">
        <div className="g1-scroll" style={{ padding: '8px 28px 32px' }}>
          {loading || !data ? (
            <div className="g1-empty"><Spin /></div>
          ) : (
            <>
              {/* ── 3.1 Outward + Inward (RCM) ── */}
              <h3 className="g3b-section-h">3.1 — Outward + Inward (RCM) supplies</h3>
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th>Nature of Supplies</th>
                    <th style={{textAlign:'right'}}>Total Taxable Value</th>
                    <th style={{textAlign:'right'}}>IGST</th>
                    <th style={{textAlign:'right'}}>CGST</th>
                    <th style={{textAlign:'right'}}>SGST</th>
                    <th style={{textAlign:'right'}}>Cess</th>
                  </tr>
                </thead>
                <tbody>
                  {['taxable_outward','zero_rated','nil_exempt','inward_rcm','non_gst_outward'].map(k => {
                    const r = data.section_3_1[k];
                    return (
                      <tr key={k}>
                        <td>{r.label}</td>
                        <td style={{textAlign:'right'}}>{fmt(r.taxable)}</td>
                        <td style={{textAlign:'right'}} className={r.igst === 0 ? 'g1-zero' : ''}>{r.igst === 0 ? '—' : fmt(r.igst)}</td>
                        <td style={{textAlign:'right'}} className={r.cgst === 0 ? 'g1-zero' : ''}>{r.cgst === 0 ? '—' : fmt(r.cgst)}</td>
                        <td style={{textAlign:'right'}} className={r.sgst === 0 ? 'g1-zero' : ''}>{r.sgst === 0 ? '—' : fmt(r.sgst)}</td>
                        <td style={{textAlign:'right'}} className={r.cess === 0 ? 'g1-zero' : ''}>{r.cess === 0 ? '—' : fmt(r.cess)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* ── 3.2 Inter-state to unregistered ── */}
              <h3 className="g3b-section-h">3.2 — Of the supplies in 3.1(a), inter-state supplies to unregistered persons</h3>
              {data.section_3_2.unregistered.length === 0 ? (
                <div className="g3b-empty-note">No inter-state supplies to unregistered persons in this period.</div>
              ) : (
                <table className="g1-tbl">
                  <thead>
                    <tr>
                      <th>Place of Supply</th>
                      <th style={{textAlign:'right'}}>Total Taxable Value</th>
                      <th style={{textAlign:'right'}}>IGST</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.section_3_2.unregistered.map(r => (
                      <tr key={r.place_of_supply}>
                        <td><span className="g1-gstin">{r.place_of_supply}</span></td>
                        <td style={{textAlign:'right'}}>{fmt(r.taxable)}</td>
                        <td style={{textAlign:'right'}}>{fmt(r.igst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* ── 4 ITC ── */}
              <h3 className="g3b-section-h">4 — Eligible Input Tax Credit</h3>
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th>Details</th>
                    <th style={{textAlign:'right'}}>IGST</th>
                    <th style={{textAlign:'right'}}>CGST</th>
                    <th style={{textAlign:'right'}}>SGST</th>
                    <th style={{textAlign:'right'}}>Cess</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td colSpan={5} style={{fontWeight:700, paddingTop:14, color:'var(--fg-secondary)'}}>(A) ITC Available</td></tr>
                  {['import_goods','import_services','inward_rcm','isd','all_other'].map(k => {
                    const r = data.section_4_itc.A[k];
                    return (
                      <tr key={k}>
                        <td style={{paddingLeft:24}}>{r.label}</td>
                        <td style={{textAlign:'right'}} className={r.igst === 0 ? 'g1-zero' : ''}>{r.igst === 0 ? '—' : fmt(r.igst)}</td>
                        <td style={{textAlign:'right'}} className={r.cgst === 0 ? 'g1-zero' : ''}>{r.cgst === 0 ? '—' : fmt(r.cgst)}</td>
                        <td style={{textAlign:'right'}} className={r.sgst === 0 ? 'g1-zero' : ''}>{r.sgst === 0 ? '—' : fmt(r.sgst)}</td>
                        <td style={{textAlign:'right'}} className={r.cess === 0 ? 'g1-zero' : ''}>{r.cess === 0 ? '—' : fmt(r.cess)}</td>
                      </tr>
                    );
                  })}
                  <tr style={{fontWeight:700, borderTop:'1px solid var(--border-subtle)'}}>
                    <td style={{paddingLeft:24}}>Total (A)</td>
                    <td style={{textAlign:'right'}}>{fmt(data.section_4_itc.A_total.igst)}</td>
                    <td style={{textAlign:'right'}}>{fmt(data.section_4_itc.A_total.cgst)}</td>
                    <td style={{textAlign:'right'}}>{fmt(data.section_4_itc.A_total.sgst)}</td>
                    <td style={{textAlign:'right'}}>{fmt(data.section_4_itc.A_total.cess)}</td>
                  </tr>
                  <tr><td colSpan={5} style={{fontWeight:700, paddingTop:14, color:'var(--fg-secondary)'}}>(B) ITC Reversed <span style={{fontWeight:400, color:'var(--fg-tertiary)', fontSize:12}}>— operator-entered at filing time</span></td></tr>
                  {['rules_38_42_43','others'].map(k => {
                    const r = data.section_4_itc.B[k];
                    return (
                      <tr key={k}>
                        <td style={{paddingLeft:24}}>{r.label}</td>
                        <td style={{textAlign:'right'}} className="g1-zero">—</td>
                        <td style={{textAlign:'right'}} className="g1-zero">—</td>
                        <td style={{textAlign:'right'}} className="g1-zero">—</td>
                        <td style={{textAlign:'right'}} className="g1-zero">—</td>
                      </tr>
                    );
                  })}
                  <tr className="g1-tot-row" style={{fontWeight:700, borderTop:'2px solid var(--accent-primary, #E26A4C)'}}>
                    <td style={{paddingLeft:24}}>(C) Net ITC Available (A − B)</td>
                    <td style={{textAlign:'right'}}>{fmt(data.section_4_itc.C_net_available.igst)}</td>
                    <td style={{textAlign:'right'}}>{fmt(data.section_4_itc.C_net_available.cgst)}</td>
                    <td style={{textAlign:'right'}}>{fmt(data.section_4_itc.C_net_available.sgst)}</td>
                    <td style={{textAlign:'right'}}>{fmt(data.section_4_itc.C_net_available.cess)}</td>
                  </tr>
                  <tr><td colSpan={5} style={{fontWeight:700, paddingTop:14, color:'var(--fg-secondary)'}}>(D) Other Details <span style={{fontWeight:400, color:'var(--fg-tertiary)', fontSize:12}}>— operator-entered at filing time</span></td></tr>
                  {['reclaimed','ineligible'].map(k => {
                    const r = data.section_4_itc.D[k];
                    return (
                      <tr key={k}>
                        <td style={{paddingLeft:24}}>{r.label}</td>
                        <td style={{textAlign:'right'}} className="g1-zero">—</td>
                        <td style={{textAlign:'right'}} className="g1-zero">—</td>
                        <td style={{textAlign:'right'}} className="g1-zero">—</td>
                        <td style={{textAlign:'right'}} className="g1-zero">—</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="g3b-itc-meta">
                Aggregated from <b>{data.section_4_itc.meta.purchase_invoice_count}</b> purchase invoices · taxable value ₹{fmt(data.section_4_itc.meta.purchase_taxable_total)}
              </div>

              {/* ── 5 Exempt inward ── */}
              <h3 className="g3b-section-h">5 — Values of exempt, nil-rated and non-GST inward supplies</h3>
              <div className="g3b-empty-note">
                Not currently tracked — would require an <code>is_exempt</code> / <code>is_composition</code> / <code>is_non_gst</code> flag on PurchaseBill. Reported as zero.
              </div>

              {/* ── 6.1 Payment of tax ── */}
              <h3 className="g3b-section-h">6.1 — Payment of tax</h3>
              <table className="g1-tbl">
                <thead>
                  <tr>
                    <th>Tax</th>
                    <th style={{textAlign:'right'}}>Tax Payable (3.1)</th>
                    <th style={{textAlign:'right'}}>Paid via ITC</th>
                    <th style={{textAlign:'right'}}>Paid via Cash</th>
                  </tr>
                </thead>
                <tbody>
                  {['igst','cgst','sgst','cess'].map(k => {
                    const r = data.section_6_1_payment[k];
                    return (
                      <tr key={k}>
                        <td><span className="g1-gstin">{k.toUpperCase()}</span></td>
                        <td style={{textAlign:'right'}} className={r.tax_payable === 0 ? 'g1-zero' : ''}>{r.tax_payable === 0 ? '—' : fmt(r.tax_payable)}</td>
                        <td style={{textAlign:'right'}} className={r.paid_via_itc === 0 ? 'g1-zero' : ''}>{r.paid_via_itc === 0 ? '—' : fmt(r.paid_via_itc)}</td>
                        <td style={{textAlign:'right', fontWeight: r.paid_via_cash > 0 ? 700 : 400}}
                            className={r.paid_via_cash === 0 ? 'g1-zero' : ''}>
                          {r.paid_via_cash === 0 ? '—' : fmt(r.paid_via_cash)}
                        </td>
                      </tr>
                    );
                  })}
                  {(() => {
                    const t = ['igst','cgst','sgst','cess'].reduce((a, k) => {
                      a.tax_payable   += data.section_6_1_payment[k].tax_payable;
                      a.paid_via_itc  += data.section_6_1_payment[k].paid_via_itc;
                      a.paid_via_cash += data.section_6_1_payment[k].paid_via_cash;
                      return a;
                    }, { tax_payable: 0, paid_via_itc: 0, paid_via_cash: 0 });
                    return (
                      <tr className="g1-tot-row" style={{fontWeight:700, borderTop:'2px solid var(--accent-primary, #E26A4C)'}}>
                        <td>TOTAL</td>
                        <td style={{textAlign:'right'}}>{fmt(t.tax_payable)}</td>
                        <td style={{textAlign:'right'}}>{fmt(t.paid_via_itc)}</td>
                        <td style={{textAlign:'right', color: t.paid_via_cash > 0 ? '#dc2626' : 'inherit'}}>{fmt(t.paid_via_cash)}</td>
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
              <div className="g3b-payment-note">
                {kpi.cash_payable === 0
                  ? <>✓ Available ITC fully offsets the period's tax liability. Excess credit of ₹{fmt(kpi.itc - kpi.outward_tax)} carries forward.</>
                  : <>Cash payment of ₹{fmt(kpi.cash_payable)} required after ITC offset. Pay via electronic cash ledger before filing.</>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
