// ── Loan Statement (per-loan) ──────────────────────────────────────
//
// Two views in one page, switched by tab:
//
//   Statement — actual ledger entries posted against this loan (the
//               history). Same shape as Bank Statement.
//
//   Schedule  — full amortization table from loan terms, with paid /
//               unpaid markers + a "Next Due" pointer.
//
// Header: loan name + outstanding banner with the recon-style identity:
//   Principal  −  Principal Paid  =  Outstanding
//
// Action button on the title strip: "Record EMI" — opens the same
// modal as the per-card menu. Lets the operator stay on the loan
// page while logging the next EMI.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Button, message, Modal } from 'antd';
import {
  ReloadOutlined, ArrowLeftOutlined, DollarOutlined,
  CheckCircleFilled, FieldTimeOutlined, RollbackOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { loanAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
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

export default function LoanStatement() {
  const navigate = useNavigate();
  const { ledger_id } = useParams();

  const [stmt, setStmt]         = useState(null);
  const [sched, setSched]       = useState(null);
  const [loading, setLd]        = useState(true);
  const [tab, setTab]           = useState('statement');  // 'statement' | 'schedule'
  const [emiOpen, setEmiOpen]   = useState(false);
  // Period state — drives the F2 Period popup. Empty = full history.
  const [fromDate, setFromDate] = useState('');
  const [toDate,   setToDate]   = useState('');

  const load = useCallback(() => {
    if (!ledger_id) return;
    setLd(true);
    Promise.all([
      loanAPI.statement(ledger_id, {
        ...(fromDate ? { from_date: fromDate } : {}),
        ...(toDate   ? { to_date:   toDate   } : {}),
      }),
      loanAPI.schedule(ledger_id),
    ])
      .then(([s, sc]) => { setStmt(s.data); setSched(sc.data); })
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load loan'))
      .finally(() => setLd(false));
  }, [ledger_id, fromDate, toDate]);
  useEffect(load, [load]);

  const { openDate } = useDatePopup();

  // CSV export of the visible statement entries — same shape as
  // BankStatement's export so the formats are consistent.
  const handleExport = () => {
    if (!stmt?.entries?.length) { message.info('Nothing to export.'); return; }
    const headers = ['Date', 'Particulars', 'Voucher', 'Principal', 'Interest', 'EMI', 'Outstanding'];
    const rows = stmt.entries.map((e) => [
      e.date,
      e.narration || '',
      e.voucher_no ? `${e.voucher_type} ${e.voucher_no}` : '',
      e.disbursement_part > 0 ? -e.disbursement_part : (e.principal_part || ''),
      e.interest_part || '',
      e.emi_total || (e.disbursement_part > 0 ? -e.disbursement_part : ''),
      e.balance,
    ]);
    const escape = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loan-statement-${stmt?.account?.ledger_name || 'loan'}.csv`.replace(/\s+/g, '-').toLowerCase();
    a.click();
    URL.revokeObjectURL(url);
  };

  // Cancel the most recently recorded EMI. The backend posts a reversing
  // voucher on the EMI's original date, so the books stay balanced. To "edit"
  // a wrong EMI (amount or date), cancel it here then Record EMI again with the
  // corrected values — the standard double-entry way to amend a posted voucher.
  const paidCount = sched?.paid_count || 0;
  const handleCancelLastEmi = useCallback(() => {
    if (paidCount < 1) return;
    Modal.confirm({
      title: 'Cancel the last recorded EMI?',
      content: 'This reverses the most recent EMI (a reversing voucher is posted on its original date). You can then Record EMI again with the correct amount or date.',
      okText: 'Cancel EMI',
      okButtonProps: { danger: true },
      cancelText: 'Keep it',
      onOk: async () => {
        try {
          await loanAPI.reverseEmi(ledger_id);
          message.success('Last EMI cancelled');
          load();
        } catch (e) {
          message.error(e.response?.data?.error || 'Failed to cancel EMI');
        }
      },
    });
  }, [paidCount, ledger_id, load]);

  // Build a "loan-shaped" object for the RecordEMIModal so it doesn't
  // need to refetch separately. The modal reads loan.ledger_id +
  // loan.loan_type + loan.name.
  const loanForModal = useMemo(() => stmt?.loan ? {
    ledger_id:    parseInt(ledger_id, 10),
    name:         stmt.account.ledger_name,
    loan_type:    stmt.loan.loan_type,
    emi_total:    stmt.loan.tenure_months,
    emi_count:    sched?.paid_count || 0,
  } : null, [stmt, sched, ledger_id]);

  const isTaken = stmt?.loan?.loan_type === 'taken';
  const principal     = stmt?.loan?.principal || 0;
  const outstanding   = stmt?.totals?.closing_balance || 0;
  const principalPaid = Math.max(0, principal - outstanding);

  return (
    <div className="bank-page loan-page">

      {/* ─── Title strip ────────────────────────────────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <button className="bank-back" onClick={() => navigate('/loans')}>
            <ArrowLeftOutlined /> Loans
          </button>
          <h1>{stmt?.account?.ledger_name || 'Loan'}</h1>
          {stmt?.loan && (
            <div className="rpt-sub">
              {isTaken ? 'Loan Taken' : 'Loan Given'}
              {stmt.loan.party && <> <span className="sep">·</span> {stmt.loan.party.name}</>}
              <span className="sep">·</span>
              {fmtN(stmt.loan.interest_rate)}% p.a.
              <span className="sep">·</span>
              {stmt.loan.tenure_months} months
              <span className="sep">·</span>
              EMI ₹{fmtN(stmt.loan.emi_amount)}
            </div>
          )}
        </div>
        <div className="rpt-hd-ctrl">
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            Refresh
          </Button>
          <Button
            className="rpt-btn" danger icon={<RollbackOutlined />}
            onClick={handleCancelLastEmi}
            disabled={paidCount < 1}
          >
            Cancel Last EMI
          </Button>
          <Button
            className="rpt-btn" type="primary" icon={<DollarOutlined />}
            onClick={() => setEmiOpen(true)}
            // Only treat "fully paid" as a block when a schedule actually
            // exists — for a loan with no computed schedule total_count is 0,
            // and the old `paid_count >= total_count` (0 >= 0) silently
            // disabled the button.
            disabled={!loanForModal || (sched && sched.total_count > 0 && sched.paid_count >= sched.total_count)}
          >
            Record EMI
          </Button>
        </div>
      </header>

      {/* ─── KPI strip — same .rpt-kpi tone-* design used on the
              loan list, bank list, and every report hub page. Four
              cards: Outstanding (warning), Principal Repaid (success),
              Interest Paid (info / danger), EMIs Paid (accent). When
              the loan is fully closed, Outstanding flips to a green
              "Closed" tone so the eye lands on the win. */}
      {stmt && stmt.loan && (
        <section className="rpt-kpis">
          <div className={`rpt-kpi ${outstanding < 1 ? 'tone-success' : 'tone-warning'}`}>
            <div className="rpt-kpi-k">
              {outstanding < 1
                ? `Loan ${isTaken ? 'Repaid' : 'Recovered'}`
                : 'Outstanding'}
            </div>
            <div className="rpt-kpi-v">
              {outstanding < 1 ? '✓' : fmtRupees(outstanding)}
            </div>
            <div className="bank-kpi-sub">
              of ₹{fmtN(principal)} principal
            </div>
          </div>
          <div className="rpt-kpi tone-success">
            <div className="rpt-kpi-k">{isTaken ? 'Principal Repaid' : 'Principal Recovered'}</div>
            <div className="rpt-kpi-v">{fmtRupees(principalPaid)}</div>
            <div className="bank-kpi-sub">
              {principal > 0
                ? `${Math.min(100, Math.round((principalPaid / principal) * 100))}% of loan`
                : '—'}
            </div>
          </div>
          <div className={`rpt-kpi ${isTaken ? 'tone-danger' : 'tone-info'}`}>
            <div className="rpt-kpi-k">{isTaken ? 'Interest Paid' : 'Interest Earned'}</div>
            <div className="rpt-kpi-v">{fmtRupees(stmt.totals?.interest_paid || 0)}</div>
            <div className="bank-kpi-sub">
              {isTaken ? 'Cost of borrowing so far' : 'Earnings from lending so far'}
            </div>
          </div>
          <div className="rpt-kpi tone-accent">
            <div className="rpt-kpi-k">EMIs Paid</div>
            <div className="rpt-kpi-v">
              {sched?.paid_count || 0} <span style={{ fontSize: '0.6em', color: 'var(--fg-tertiary)', fontWeight: 600 }}>/ {sched?.total_count || 0}</span>
            </div>
            <div className="bank-kpi-sub">
              {sched?.schedule[sched.paid_count]
                ? `Next due ${dayjs(sched.schedule[sched.paid_count].due_date).format('DD MMM YYYY')}`
                : 'All EMIs paid'}
            </div>
          </div>
        </section>
      )}

      {/* ─── Tab strip ─────────────────────────────────────────── */}
      <nav className="bank-tabs">
        <button className={tab === 'statement' ? 'on' : ''} onClick={() => setTab('statement')}>
          Statement
          <span className="count">{stmt?.entries?.length || 0}</span>
        </button>
        <button className={tab === 'schedule' ? 'on' : ''} onClick={() => setTab('schedule')}>
          Schedule
          <span className="count">{sched?.total_count || 0}</span>
        </button>
        <span className="grow"></span>
        {sched && (
          <span className="bank-tabs-meta">
            Next due: {sched.schedule[sched.paid_count]
              ? <b>{fmtDate(sched.schedule[sched.paid_count].due_date)}</b>
              : <b>—</b>}
          </span>
        )}
      </nav>

      {/* ─── Tab content ───────────────────────────────────────────
          Statement tab uses a stacked layout: scrolling table on top,
          fixed totals bar at the bottom (pinned to the page, NOT to
          the table — so totals are always visible regardless of how
          many EMI rows exist). Schedule tab uses the regular wrap. */}
      {tab === 'statement' ? (
        <>
          <div className="bank-tbl-wrap stmt-scroll">
            <StatementTable stmt={stmt} loading={loading} isTaken={isTaken} />
          </div>
          {stmt && (stmt.entries?.length || 0) > 0 && (
            <StatementTotalsBar stmt={stmt} isTaken={isTaken} />
          )}
        </>
      ) : (
        <div className="bank-tbl-wrap">
          <ScheduleTable sched={sched} loading={loading} />
        </div>
      )}

      <RecordEMIModal
        open={emiOpen}
        loan={loanForModal}
        onClose={() => setEmiOpen(false)}
        onSaved={load}
      />

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/loans'),
          },
          {
            id: 'period', key: 'F2', label: 'Period',
            onAction: () => openDate({
              mode: 'range', title: 'Period',
              value: [fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null],
              onConfirm: ([f, t]) => {
                setFromDate(f.format('YYYY-MM-DD'));
                setToDate(t.format('YYYY-MM-DD'));
              },
            }),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: load,
          },
          {
            id: 'emi', key: 'F6', label: 'Record EMI',
            disabled: !loanForModal || (sched && sched.total_count > 0 && sched.paid_count >= sched.total_count),
            onAction: () => setEmiOpen(true),
          },
          {
            id: 'cancel-emi', key: 'F7', label: 'Cancel EMI',
            disabled: paidCount < 1,
            onAction: handleCancelLastEmi,
          },
          {
            id: 'print', key: 'F9', label: 'Print',
            onAction: () => window.print(),
          },
          {
            id: 'export', key: 'F10', label: 'Export',
            disabled: !stmt?.entries?.length,
            onAction: handleExport,
          },
        ]}
      />
    </div>
  );
}

// ── Statement table — actual ledger entries
//
// Columns are designed to read like a real loan account statement:
//
//   Date · Particulars · Voucher · Principal · Interest · EMI · Outstanding
//
// The server returns each row pre-split into principal_part / interest_part /
// emi_total via the controller's interest-leg join, so the UI just renders.
//
// Disbursement rows (the initial loan flow) have interest_part=0 and a
// dedicated tone — they aren't EMIs and shouldn't read like one.
function StatementTable({ stmt, loading, isTaken }) {
  const entries = stmt?.entries || [];
  return (
    <table className="bank-tbl stmt-tbl">
      {/* Shared <colgroup> with the totals bar below the scroll area
          so columns line up exactly. Without this (or table-layout:
          fixed alone), each table's auto-layout would size columns to
          its own content and the totals row would visibly drift left
          of the data columns. The same <colgroup> is repeated in
          StatementTotalsBar; if you change widths, change both. */}
      <colgroup>
        <col className="lstmt-col-date" />
        <col className="lstmt-col-particulars" />
        <col className="lstmt-col-voucher" />
        <col className="lstmt-col-num" />
        <col className="lstmt-col-num" />
        <col className="lstmt-col-num" />
        <col className="lstmt-col-num" />
      </colgroup>
      <thead>
        <tr>
          <th className="l">Date</th>
          <th className="l">Particulars</th>
          <th className="l">Voucher</th>
          <th>Principal</th>
          <th>Interest</th>
          <th>{isTaken ? 'EMI Paid' : 'Received'}</th>
          <th>Outstanding</th>
        </tr>
      </thead>
      <tbody>
        {!stmt ? (
          <tr><td colSpan={7} className="bank-empty">{loading ? 'Loading…' : '—'}</td></tr>
        ) : entries.length === 0 ? (
          <tr><td colSpan={7} className="bank-empty">No entries posted yet.</td></tr>
        ) : entries.map((e, i) => {
          const isEmi          = e.is_emi;
          const isDisbursement = !isEmi && e.disbursement_part > 0;
          // For EMI rows: principal_part is the principal repaid (the
          //   "good" direction — paying down the loan).
          // For disbursement rows: there is no principal "paid"; we
          //   show the disbursement as a negative inflow under the
          //   Principal column with a 'disb' tone, so the column always
          //   has data instead of leaving the row half-empty.
          const principalCell = isDisbursement
            ? <span className="bank-num disb">+{fmtN(e.disbursement_part)}</span>
            : e.principal_part > 0
              ? <span className="bank-num pos">{fmtN(e.principal_part)}</span>
              : <span className="bank-dash">—</span>;
          const interestCell = e.interest_part > 0
            ? <span className="bank-num neg">{fmtN(e.interest_part)}</span>
            : <span className="bank-dash">—</span>;
          const totalCell = isEmi
            ? <span className="bank-num bold">{fmtN(e.emi_total)}</span>
            : isDisbursement
              ? <span className="bank-num disb">+{fmtN(e.disbursement_part)}</span>
              : <span className="bank-dash">—</span>;
          // Cleaner narration: EMI rows already read "EMI paid — principal X,
          // interest Y" but the values are now in their own columns, so we
          // strip the redundant tail. Falls back to the original text for
          // disbursement / JV rows.
          const narration = isEmi
            ? (e.narration?.split(' — ')[0] || e.narration || 'EMI paid')
            : (e.narration || e.voucher_type || '—');
          return (
            <tr key={e.entry_id || i} className={isEmi ? 'loan-row-emi' : isDisbursement ? 'loan-row-disb' : ''}>
              <td className="l"><span className="bank-num">{fmtDate(e.date)}</span></td>
              <td className="l">
                <div className="bank-particulars">
                  <span className="primary">{narration}</span>
                  {e.party_name && <span className="meta">{e.party_name}</span>}
                </div>
              </td>
              <td className="l">
                {e.voucher_no ? (
                  <span className="bank-cheque">{e.voucher_type} {e.voucher_no}</span>
                ) : <span className="bank-dash">—</span>}
              </td>
              <td>{principalCell}</td>
              <td>{interestCell}</td>
              <td>{totalCell}</td>
              <td><span className="bank-num bold">{fmtN(Math.abs(e.balance))}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Statement Totals Bar ──────────────────────────────────────────
//
// Rendered as a sibling AFTER the scrolling table — not as a <tfoot>
// inside it — so the bar is always pinned at the bottom of the page,
// independent of how many EMI rows exist. (`position: sticky; bottom: 0`
// inside a short table doesn't fire because the row isn't being
// scrolled out of view; flexbox + a separate element is the only
// reliable way to get "always at the bottom".)
//
// Shares the `<colgroup>` widths with StatementTable above so the
// numeric cells land directly under their column headers. Both tables
// use `table-layout: fixed` (set in loans.css) which is what makes
// the colgroup widths actually authoritative.
function StatementTotalsBar({ stmt, isTaken }) {
  const t = stmt?.totals || {};
  return (
    <div className="stmt-totals-bar">
      <table className="bank-tbl stmt-tbl stmt-foot-tbl">
        <colgroup>
          <col className="lstmt-col-date" />
          <col className="lstmt-col-particulars" />
          <col className="lstmt-col-voucher" />
          <col className="lstmt-col-num" />
          <col className="lstmt-col-num" />
          <col className="lstmt-col-num" />
          <col className="lstmt-col-num" />
        </colgroup>
        <tbody>
          <tr className="stmt-foot">
            <td className="l" colSpan={3}><b>Totals</b></td>
            <td><span className="bank-num bold pos">{fmtN(t.principal_paid || 0)}</span></td>
            <td><span className="bank-num bold neg">{fmtN(t.interest_paid || 0)}</span></td>
            <td><span className="bank-num bold">{fmtN(t.total_paid || 0)}</span></td>
            <td><span className="bank-num bold">{fmtN(Math.abs(t.closing_balance || 0))}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Schedule table — amortization with paid markers
function ScheduleTable({ sched, loading }) {
  const rows = sched?.schedule || [];
  return (
    <table className="bank-tbl loan-schedule-tbl">
      <thead>
        <tr>
          <th className="c">#</th>
          <th className="l">Due Date</th>
          <th>Opening</th>
          <th>Principal</th>
          <th>Interest</th>
          <th>EMI</th>
          <th>Closing</th>
          <th className="c">Status</th>
        </tr>
      </thead>
      <tbody>
        {!sched ? (
          <tr><td colSpan={8} className="bank-empty">{loading ? 'Loading…' : '—'}</td></tr>
        ) : rows.length === 0 ? (
          <tr><td colSpan={8} className="bank-empty">No schedule — set a tenure + first EMI date.</td></tr>
        ) : rows.map((r) => (
          <tr
            key={r.emi_no}
            className={r.paid ? 'cleared' : r.overdue ? 'loan-row-overdue' : ''}
          >
            <td className="c"><span className="loan-emi-no">{r.emi_no}</span></td>
            <td className="l"><span className="bank-num">{fmtDate(r.due_date)}</span></td>
            <td><span className="bank-num">{fmtN(r.opening)}</span></td>
            <td><span className="bank-num pos">{fmtN(r.principal)}</span></td>
            <td><span className="bank-num neg">{fmtN(r.interest)}</span></td>
            <td><span className="bank-num bold">{fmtN(r.emi)}</span></td>
            <td><span className="bank-num">{fmtN(r.closing)}</span></td>
            <td className="c">
              {r.paid
                ? <span className="loan-status-pill paid"><CheckCircleFilled /> Paid</span>
                : r.overdue
                ? <span className="loan-status-pill overdue">Overdue</span>
                : <span className="loan-status-pill due">Due</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
