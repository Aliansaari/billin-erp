// ── Loan Schedule (cross-loan) ─────────────────────────────────────
//
// Mirror of BankReconciliation, but for loan EMIs. One screen showing
// every upcoming + overdue EMI across every active loan, with aging.
//
// Sections:
//   • KPI strip — overdue count, due-this-month, total due value
//   • Aging chips — Overdue / This Week / Next 30 / Next 90
//   • Table — Date, Loan, Party, EMI #, Principal/Interest/Total, Status
//
// Each row's "Pay" action opens the RecordEMIModal pre-filled for that
// loan, so the bookkeeper can clear an overdue queue in one pass.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Button, message, Tooltip } from 'antd';
import {
  ReloadOutlined, FieldTimeOutlined, DollarOutlined,
  CheckCircleFilled, BankOutlined, RiseOutlined, FallOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { loanAPI } from '../../api';
import RecordEMIModal from './RecordEMIModal';
import './loans.css';

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return '₹ ' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
};
const fmtDate = (s) => s ? dayjs(s).format('DD MMM YYYY') : '—';

// Bucket helpers — must match the chips below.
const bucketOf = (daysUntil, overdue) => {
  if (overdue) return 'overdue';
  if (daysUntil <= 7)  return 'week';
  if (daysUntil <= 30) return 'month';
  return 'later';
};
const BUCKET_LABEL = { overdue: 'Overdue', week: 'This week', month: 'Next 30', later: 'Later' };
const BUCKET_TONE  = { overdue: 'danger',  week: 'warn',     month: 'warm',  later: 'fresh' };

export default function LoanSchedule() {
  const navigate = useNavigate();
  const [data, setData]   = useState(null);
  const [loading, setLd]  = useState(true);
  const [bucket, setBucket] = useState('');
  const [emiOpen, setEmiOpen] = useState(false);
  const [emiLoan, setEmiLoan] = useState(null);

  const load = useCallback(() => {
    setLd(true);
    loanAPI.upcoming({ days: 90 })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load schedule'))
      .finally(() => setLd(false));
  }, []);
  useEffect(load, [load]);

  const upcoming = data?.upcoming || [];
  const totals   = data?.totals   || {};

  // Aging counts — for chip badges.
  const buckets = useMemo(() => {
    const b = { overdue: { count: 0, value: 0 }, week: { count: 0, value: 0 },
                month:   { count: 0, value: 0 }, later: { count: 0, value: 0 } };
    upcoming.forEach((row) => {
      const bk = bucketOf(row.days_until, row.overdue);
      b[bk].count += 1;
      b[bk].value += row.emi;
    });
    return b;
  }, [upcoming]);

  const visibleRows = useMemo(() => {
    if (!bucket) return upcoming;
    return upcoming.filter((r) => bucketOf(r.days_until, r.overdue) === bucket);
  }, [upcoming, bucket]);

  return (
    <div className="bank-page loan-page">

      {/* ─── Title strip ────────────────────────────────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Loan Schedule</h1>
          <div className="rpt-sub">
            Upcoming EMIs across all active loans · {data?.horizon_days || 90}-day horizon
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            Refresh
          </Button>
        </div>
      </header>

      {/* ─── KPI strip ──────────────────────────────────────────────── */}
      <section className="rpt-kpis">
        <div className={`rpt-kpi ${totals.overdue_count > 0 ? 'tone-danger' : 'tone-success'}`}>
          <div className="rpt-kpi-k">Overdue</div>
          <div className="rpt-kpi-v">{totals.overdue_count || 0}</div>
          <div className="bank-kpi-sub">EMIs past their due date</div>
        </div>
        <div className="rpt-kpi tone-warning">
          <div className="rpt-kpi-k">Overdue value</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.overdue_value)}</div>
          <div className="bank-kpi-sub">₹ stuck in late EMIs</div>
        </div>
        <div className="rpt-kpi tone-info">
          <div className="rpt-kpi-k">Upcoming (90d)</div>
          <div className="rpt-kpi-v">{totals.upcoming_count || 0}</div>
          <div className="bank-kpi-sub">All EMIs in horizon</div>
        </div>
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Total due</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.due_value)}</div>
          <div className="bank-kpi-sub">Cash committed in 90 days</div>
        </div>
      </section>

      {/* ─── Aging chips ─────────────────────────────────────────── */}
      <section className="bank-aging">
        <div className="bank-aging-lbl"><FieldTimeOutlined /> Aging</div>
        <button
          className={'bank-aging-chip' + (bucket === '' ? ' on' : '')}
          onClick={() => setBucket('')}
        >
          <span className="lbl">All</span>
          <span className="cnt">{upcoming.length}</span>
        </button>
        {Object.entries(buckets).map(([k, v]) => (
          <button
            key={k}
            className={`bank-aging-chip tone-${BUCKET_TONE[k]}` + (bucket === k ? ' on' : '')}
            onClick={() => setBucket(bucket === k ? '' : k)}
            disabled={v.count === 0}
          >
            <span className="lbl">{BUCKET_LABEL[k]}</span>
            <span className="cnt">{v.count}</span>
            {v.value > 0 && <span className="amt">{fmtRupees(v.value)}</span>}
          </button>
        ))}
      </section>

      {/* ─── Schedule table ──────────────────────────────────────── */}
      <div className="bank-tbl-wrap">
        <table className="bank-tbl loan-schedule-tbl">
          <thead>
            <tr>
              <th className="l">Due Date</th>
              <th className="l">Loan</th>
              <th className="c">EMI #</th>
              <th>Principal</th>
              <th>Interest</th>
              <th>Total</th>
              <th className="c">Status</th>
              <th className="c"></th>
            </tr>
          </thead>
          <tbody>
            {!data ? (
              <tr><td colSpan={8} className="bank-empty">{loading ? 'Loading…' : '—'}</td></tr>
            ) : visibleRows.length === 0 ? (
              <tr><td colSpan={8} className="bank-empty">
                {totals.upcoming_count === 0 ? (
                  <>
                    <CheckCircleFilled style={{ fontSize: 28, color: '#10B981', display: 'block', marginBottom: 10 }} />
                    <b>No EMIs due in the next 90 days.</b>
                    <div style={{ fontSize: 13, marginTop: 6, fontWeight: 400 }}>
                      Either you're all caught up or no loans are tracked yet.
                    </div>
                  </>
                ) : 'No EMIs in this bucket.'}
              </td></tr>
            ) : visibleRows.map((r, i) => {
              const isTaken = r.loan_type === 'taken';
              return (
                <tr
                  key={`${r.ledger_id}-${r.emi_no}`}
                  className={r.overdue ? 'loan-row-overdue' : ''}
                >
                  <td className="l">
                    <span className="bank-num">{fmtDate(r.due_date)}</span>
                    {r.days_until !== 0 && (
                      <span style={{ fontSize: 11, color: '#9CA3AF', marginLeft: 6 }}>
                        ({r.days_until < 0 ? `${-r.days_until}d ago` : `in ${r.days_until}d`})
                      </span>
                    )}
                  </td>
                  <td className="l">
                    <button
                      className="bank-recon-banklink"
                      onClick={() => navigate(`/loans/${r.ledger_id}/statement`)}
                    >
                      {isTaken ? <FallOutlined /> : <RiseOutlined />}
                      {' '}{r.loan_name}
                      {r.party_name && <span style={{ color: '#9CA3AF', fontWeight: 400 }}>&nbsp;·&nbsp;{r.party_name}</span>}
                    </button>
                  </td>
                  <td className="c">
                    <Tooltip title={`EMI ${r.emi_no} of ${r.total_count} · ${r.paid_count} already paid`}>
                      <span className="loan-emi-no">{r.emi_no}/{r.total_count}</span>
                    </Tooltip>
                  </td>
                  <td><span className="bank-num">{fmtN(r.principal)}</span></td>
                  <td><span className="bank-num neg">{fmtN(r.interest)}</span></td>
                  <td><span className="bank-num bold">{fmtN(r.emi)}</span></td>
                  <td className="c">
                    {r.overdue
                      ? <span className="loan-status-pill overdue">Overdue</span>
                      : r.days_until <= 7
                      ? <span className="loan-status-pill due">Due soon</span>
                      : <span className="loan-status-pill upcoming">Upcoming</span>}
                  </td>
                  <td className="c">
                    <Button
                      size="small" icon={<DollarOutlined />}
                      onClick={() => {
                        setEmiLoan({
                          ledger_id:  r.ledger_id,
                          name:       r.loan_name,
                          loan_type:  r.loan_type,
                          emi_total:  r.total_count,
                          emi_count:  r.paid_count,
                        });
                        setEmiOpen(true);
                      }}
                    >Pay</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="bank-foot">
        <span>Showing <b>{visibleRows.length}</b> of <b>{upcoming.length}</b> upcoming EMIs</span>
      </footer>

      <RecordEMIModal
        open={emiOpen}
        loan={emiLoan}
        onClose={() => setEmiOpen(false)}
        onSaved={load}
      />
    </div>
  );
}
